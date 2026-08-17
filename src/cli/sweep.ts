/**
 * `skyhook sweep` — the recurring pass that makes cleanup true. Wiring and exit codes,
 * no logic of its own: every decision lives in `src/core/sweep.ts`, tested against fakes.
 *
 * Deliberately not gated on the event name: the schedule is the ordinary trigger, but a
 * maintainer running it by hand on the day the scheduler misbehaves is exactly the use
 * the constitution's sweep clause exists for. What actually gates it is the credential —
 * only a default-branch-context run can assume the role this needs.
 */

import { loadConfig } from '../core/config.ts';
import { pullRequestNumberFor } from '../core/identity.ts';
import { sweepEnvironments, type SweepEntry, type SweepResult } from '../core/sweep.ts';
import { GitHubConfigSource } from '../adapters/github/config-source.ts';
import { GitHubPullRequests } from '../adapters/github/pull-requests.ts';
import { AwsAccessBroker } from '../adapters/aws/broker.ts';
import { terraformInputSource } from '../adapters/terraform/inputs.ts';
import type { CommandRunner } from './process.ts';

/** Every failure was the consuming repo's own destroy. Distinct from skyhook failing (plan D8). */
export const EXIT_CONSUMER_DESTROY_FAILED = 3;

export interface SweepOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly runner: CommandRunner;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
}

export async function sweep(options: SweepOptions): Promise<number> {
  const token = options.env['GITHUB_TOKEN'];
  if (token === undefined || token === '') {
    options.err(
      'skyhook sweep: GITHUB_TOKEN is not set. The sweep reads settings and asks about ' +
        'pull requests through the GitHub API, which needs a token with contents: read ' +
        'and pull-requests: read.',
    );
    return 1;
  }
  const repository = options.env['GITHUB_REPOSITORY'] ?? '';
  if (repository === '') {
    options.err('skyhook sweep: GITHUB_REPOSITORY is not set');
    return 1;
  }

  const loaded = await loadConfig(
    new GitHubConfigSource({
      repository,
      token,
      ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
    }),
  );
  if (!loaded.ok) {
    options.err(`skyhook sweep: configuration: ${loaded.problems.join('; ')}`);
    return 1;
  }

  const broker = new AwsAccessBroker({
    env: options.env,
    runner: options.runner,
    repositoryRoot: '.',
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
  const opened = await broker.openSweep(loaded.config, repository);
  if (!opened.ok) {
    options.err(`skyhook sweep: ${opened.problem}`);
    return 1;
  }
  const { registry, store, destroyerFor, builderFor } = opened.access;

  // The pool phase (feat-007): present exactly when pooling is on. The warm build
  // deploys the default branch's current commit — the scheduled run's own checkout —
  // with the declared input values the workflow's environment carries (od-1).
  const pool = loaded.config.pool;
  const deploySettings = loaded.config.deploy;
  const headCommit = options.env['GITHUB_SHA'] ?? '';
  if (pool !== null && (deploySettings === null || headCommit === '')) {
    options.err(
      'skyhook sweep: pool.target is set, but ' +
        (deploySettings === null
          ? 'the deploy block is missing — a warm build needs deploy.directory.'
          : 'GITHUB_SHA is not set — a warm build records the default-branch commit it deploys.'),
    );
    return 1;
  }

  const result = await sweepEnvironments(
    {
      registry,
      store,
      ...(pool !== null && deploySettings !== null
        ? {
            pool: {
              target: pool.target,
              cap: loaded.config.environmentCap,
              headCommit,
              directory: deploySettings.directory,
              declaredInputs: deploySettings.inputs,
              inputSource: terraformInputSource(options.env),
              deployerFor: (identity) => builderFor(identity),
            },
          }
        : {}),
      pullRequests: new GitHubPullRequests({
        repository,
        token,
        ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
      }),
      destroyerFor: async (identity) => {
        // The identity arrived from a registry KEY (plan D2); the record's body supplies
        // only the commit to destroy with, whose blast radius is this one environment.
        const read = await registry.read(repository, identity);
        const commit = read.ok && read.record !== null ? read.record.deployedCommit : null;
        return destroyerFor(identity, {
          commit,
          pullRequestNumber: pullRequestNumberFor(identity) ?? 0,
        });
      },
    },
    repository,
  );
  return report(result, options);
}

/** The mapping from a sweep's outcomes to an exit status (plan D8). Exported for tests. */
export function exitCodeForSweep(entries: readonly SweepEntry[]): number {
  const failures = entries.filter((entry) => entry.kind === 'failed' || entry.kind === 'protection-unknown');
  if (failures.length === 0) return 0;
  const skyhookSide = failures.some((entry) => entry.kind === 'protection-unknown' || entry.consumer !== true);
  return skyhookSide ? 1 : EXIT_CONSUMER_DESTROY_FAILED;
}

function report(result: SweepResult, options: SweepOptions): number {
  if (result.kind === 'failed') {
    options.err(`skyhook sweep: ${result.problem}`);
    return 1;
  }

  if (result.entries.length === 0) {
    options.out('Nothing eligible: the registry records no environments.');
    return 0;
  }

  for (const entry of result.entries) options.out(line(entry));
  const failed = result.entries.filter((e) => e.kind === 'failed' || e.kind === 'protection-unknown');
  if (failed.length > 0) {
    options.err(
      `skyhook sweep: ${failed.length} environment(s) could not be handled — see above. ` +
        'Their records stay and refuse their names; the next pass retries.',
    );
  } else if (result.entries.every((e) => e.kind === 'left-standing-open' || e.kind === 'not-ephemeral' || e.kind === 'already-gone')) {
    options.out('Nothing was eligible for teardown.');
  }
  return exitCodeForSweep(result.entries);
}

function line(entry: SweepEntry): string {
  switch (entry.kind) {
    case 'destroyed':
      return `${entry.identity}: destroyed${notes(entry)}`;
    case 'already-gone':
      return `${entry.identity}: already gone`;
    case 'left-standing-protected':
      return `${entry.identity}: left standing — protected`;
    case 'protection-unknown':
      return `${entry.identity}: left standing — protection could not be determined (${entry.problem ?? ''})`;
    case 'reactivated':
      return `${entry.identity}: left standing — reactivated by a deploy${notes(entry)}`;
    case 'left-standing-open':
      return `${entry.identity}: left standing — its pull request is open`;
    case 'not-ephemeral':
      return `${entry.identity}: not ephemeral, not the sweep's to touch`;
    case 'warm-ready':
      return `${entry.identity}: warm and claimable, standing ready`;
    case 'pool-built':
      return `${entry.identity}: built warm, now claimable`;
    case 'pool-at-cap':
      return 'pool: under target, but the environment cap leaves no headroom — nothing was built';
    case 'failed':
      return `${entry.identity}: FAILED — ${entry.problem ?? 'unknown'}`;
  }
}

function notes(entry: SweepEntry): string {
  return entry.notes !== undefined && entry.notes.length > 0 ? ` (${entry.notes.join('; ')})` : '';
}
