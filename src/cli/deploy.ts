/**
 * `skyhook deploy` — wiring and exit codes, and no logic of its own.
 *
 * Every decision lives in `src/core/deploy.ts`, where it can be tested against fakes with
 * no cloud account. What is here is the choice of adapters, the mapping from a typed
 * outcome to an exit status, and writing the run's outputs where the calling workflow can
 * read them.
 */

import { appendFileSync } from 'node:fs';
import { deployEnvironment, type DeployResult } from '../core/deploy.ts';
import { GitHubConfigSource } from '../adapters/github/config-source.ts';
import { GitHubTriggerSource } from '../adapters/github/event.ts';
import { AwsAccessBroker } from '../adapters/aws/broker.ts';
import { terraformInputSource } from '../adapters/terraform/inputs.ts';
import type { CommandRunner } from './process.ts';

/** The consuming repo's own apply failed. Distinct from skyhook failing (AC-18). */
export const EXIT_CONSUMER_APPLY_FAILED = 3;

export interface DeployOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly repositoryRoot: string;
  readonly runner: CommandRunner;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  /** Injected for tests. Defaults to appending to the file `GITHUB_OUTPUT` names. */
  readonly writeOutput?: (name: string, value: string) => void;
}

export async function deploy(options: DeployOptions): Promise<number> {
  const token = options.env['GITHUB_TOKEN'];
  if (token === undefined || token === '') {
    options.err(
      'skyhook deploy: GITHUB_TOKEN is not set. Skyhook reads settings from the ' +
        "repository's default branch through the GitHub API, which needs a token with " +
        'contents: read.',
    );
    return 1;
  }
  const repository = options.env['GITHUB_REPOSITORY'] ?? '';

  const result = await deployEnvironment({
    trigger: new GitHubTriggerSource({ env: options.env }),
    configSource: new GitHubConfigSource({
      repository,
      token,
      ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
    }),
    broker: new AwsAccessBroker({
      env: options.env,
      runner: options.runner,
      repositoryRoot: options.repositoryRoot,
      ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
    }),
    now: options.now ?? (() => Date.now()),
    inputSource: terraformInputSource(options.env),
  });

  return report(result, options);
}

function report(result: DeployResult, options: DeployOptions): number {
  const write = options.writeOutput ?? ((name, value) => appendOutput(options.env, name, value));

  switch (result.kind) {
    case 'skipped':
      // Not a failure. A fork pull request gets no environment by design, and the run says
      // so and succeeds rather than failing confusingly midway (AC-10).
      options.out(result.message);
      write('url', '');
      write('identity', '');
      return 0;

    case 'deployed':
      for (const note of result.notes) options.out(note);
      options.out(
        `Deployed ${result.identity} at commit ${result.commit}` +
          (result.url === null ? '.' : `: ${result.url}`),
      );
      options.out(`Skyhook's own share of this run: ${(result.skyhookMs / 1000).toFixed(1)}s.`);
      write('url', result.url ?? '');
      write('identity', result.identity);
      write('skyhook-seconds', (result.skyhookMs / 1000).toFixed(1));
      return 0;

    case 'consumer-failed':
      options.err(`skyhook deploy: ${result.message}`);
      write('identity', result.identity);
      return EXIT_CONSUMER_APPLY_FAILED;

    case 'failed':
      options.err(`skyhook deploy: ${result.message}`);
      return 1;
  }
}

/**
 * How a step hands a value to the rest of the workflow. Skyhook writes the address here
 * and nowhere else: it asks for no permission to comment on a pull request and owns no
 * comment format, so what happens to the address is the calling workflow's decision.
 */
function appendOutput(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  value: string,
): void {
  const target = env['GITHUB_OUTPUT'];
  if (target === undefined || target === '') return;
  // The delimited form, because a URL is not guaranteed to be one line and a bare
  // `name=value` would let a crafted value inject further outputs.
  const marker = `skyhook-${name}-${value.length}`;
  appendFileSync(target, `${name}<<${marker}\n${value}\n${marker}\n`, 'utf8');
}
