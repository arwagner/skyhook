/**
 * `skyhook deploy` — wiring and exit codes, and no logic of its own.
 *
 * Every decision lives in `src/core/deploy.ts`, where it can be tested against fakes with
 * no cloud account. What is here is the choice of adapters, the mapping from a typed
 * outcome to an exit status, and writing the run's outputs where the calling workflow can
 * read them.
 */

import { appendFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
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
      deployOutputsFor(result, write, options.out);
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
 * GitHub caps one `GITHUB_OUTPUT` value at roughly 1 MB. A document nearing that is not
 * written; it is replaced by the marker below (AC-26). Kept comfortably under the ceiling.
 */
const OUTPUTS_MAX_BYTES = 1_000_000;

/** The reserved key an oversized document collapses to. No Terraform output name can be this. */
const TRUNCATION_KEY = '__skyhook_truncated';

/**
 * Hand every output the definition declares to the calling workflow as one compact JSON
 * line under `outputs` (AC-24). Empty string on a skip or a failure — a workflow parses
 * `outputs` only on success, so `fromJSON("")` is never reached on those paths — and `{}`
 * for a definition that declares nothing.
 *
 * The omitted sensitive names are logged so their absence reads as a decision; their
 * values never were here to log (the adapter dropped them, AC-25). An oversized document
 * is replaced by a reserved-key marker and a warning annotation rather than failing a
 * deploy that already succeeded (AC-26).
 */
export function deployOutputsFor(
  result: DeployResult,
  write: (name: string, value: string) => void,
  out: (line: string) => void,
): void {
  if (result.kind !== 'deployed') {
    write('outputs', '');
    return;
  }
  const outputs = result.outputs;
  if (outputs === null) {
    write('outputs', '{}');
    return;
  }
  if (outputs.omittedSensitive.length > 0) {
    out(`Outputs omitted as sensitive: ${outputs.omittedSensitive.join(', ')}.`);
  }
  const document = JSON.stringify(outputs.document);
  if (Buffer.byteLength(document, 'utf8') > OUTPUTS_MAX_BYTES) {
    // The reason names the size and nothing of the content — even non-sensitive content —
    // so a future edit here cannot reopen the disclosure the adapter closed.
    write(
      'outputs',
      JSON.stringify({
        [TRUNCATION_KEY]: `outputs omitted: the document is ${Buffer.byteLength(document, 'utf8')} bytes, over the ${OUTPUTS_MAX_BYTES}-byte limit`,
      }),
    );
    out(`::warning::skyhook: the outputs document exceeded ${OUTPUTS_MAX_BYTES} bytes and was omitted; read what you need from Terraform directly.`);
    return;
  }
  write('outputs', document);
}

/**
 * How a step hands a value to the rest of the workflow. Skyhook writes here and nowhere
 * else: it asks for no permission to comment on a pull request and owns no comment format,
 * so what happens to a value is the calling workflow's decision.
 *
 * The delimiter is a fresh random token per write (AC-25), never derived from the value or
 * its name: a value is attacker-authored (it is a Terraform output), and a marker it could
 * predict — the old `skyhook-<name>-<length>` — is one it could reproduce to close the
 * heredoc early and inject a further output. 128 bits of randomness makes a collision
 * astronomically unlikely; on the vanishing chance the value still contains the marker
 * line, this throws rather than emit an unsafe frame. This governs `url` too — the
 * weakness predated the outputs document.
 */
export function appendOutput(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  value: string,
): void {
  const target = env['GITHUB_OUTPUT'];
  if (target === undefined || target === '') return;
  const marker = `skyhook_${randomBytes(16).toString('hex')}`;
  const collides = value.split('\n').some((line) => line === marker);
  if (collides) {
    throw new Error(
      `skyhook: the value for output "${name}" collided with a random delimiter; nothing was ` +
        'written. This is astronomically unlikely — re-run the job.',
    );
  }
  appendFileSync(target, `${name}<<${marker}\n${value}\n${marker}\n`, 'utf8');
}
