/**
 * `skyhook teardown` — two starters for one sequence, wiring and exit codes only: every
 * decision lives in `src/core/teardown.ts`, tested against fakes.
 *
 * Without an environment name, this is the close fast path: the event is the trigger and
 * the fact, and a closed pull request's run destroys that pull request's environment and
 * nothing else. The sweep remains the guarantee — this path is the speed-up
 * (constitution: events are a fast path only).
 *
 * With one (`--environment` or SKYHOOK_ENVIRONMENT), this is the manual teardown of a
 * long-running environment (feat-006 plan D5): a human's explicit order, dispatched
 * against the default branch, running the same teardown sequence under the same
 * per-environment narrowing the sweep uses. One exit-code row differs: `protected` is a
 * non-zero refusal here, because on this path a refusal is the answer to a direct order
 * rather than policy quietly honored.
 */

import { loadConfig } from '../core/config.ts';
import { identityFor, pullRequestNumberFor } from '../core/identity.ts';
import { teardownEnvironment, type TeardownResult } from '../core/teardown.ts';
import { GitHubConfigSource } from '../adapters/github/config-source.ts';
import { GitHubTriggerSource } from '../adapters/github/event.ts';
import { AwsAccessBroker, type SweepAccessOutcome, type TeardownAccessOutcome } from '../adapters/aws/broker.ts';
import { requireDefaultBranchRef } from './ref-check.ts';
import type { ScoutOutcome } from '../core/ports.ts';
import type { SkyhookConfig } from '../core/types.ts';
import type { CommandRunner } from './process.ts';

/** The seam 6.3's fake-driven tests inject; production wires `AwsAccessBroker.openManual`. */
export type ManualAccessOpener = (
  config: SkyhookConfig,
  repository: string,
) => Promise<SweepAccessOutcome>;

/** Test seams for the close path's pooled lookup (feat-007); production wires the broker. */
export type ScoutAccessOpener = (
  config: SkyhookConfig,
  repository: string,
) => Promise<ScoutOutcome>;
export type CloseAccessOpener = (
  config: SkyhookConfig,
  repository: string,
  identity: string,
) => Promise<TeardownAccessOutcome>;

/** The consuming repo's own destroy failed. Distinct from skyhook failing (plan D8). */
export const EXIT_CONSUMER_DESTROY_FAILED = 3;

export interface TeardownOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly runner: CommandRunner;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  /** The long-running environment to tear down — the manual path. Also read from SKYHOOK_ENVIRONMENT. */
  readonly environment?: string | undefined;
  /** Injected for tests. Defaults to `AwsAccessBroker.openManual`. */
  readonly openManualAccess?: ManualAccessOpener;
  /** Injected for tests. Defaults to `AwsAccessBroker.openScout` / `openTeardown`. */
  readonly openScoutAccess?: ScoutAccessOpener;
  readonly openCloseAccess?: CloseAccessOpener;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
}

export async function teardown(options: TeardownOptions): Promise<number> {
  const token = options.env['GITHUB_TOKEN'];
  if (token === undefined || token === '') {
    options.err(
      'skyhook teardown: GITHUB_TOKEN is not set. Skyhook reads settings from the ' +
        "repository's default branch through the GitHub API, which needs a token with " +
        'contents: read.',
    );
    return 1;
  }
  const repository = options.env['GITHUB_REPOSITORY'] ?? '';

  // The manual path engages only on a manual dispatch, or on a flag a human typed
  // explicitly. Never on a carried variable alone: once the push deploy is switched on,
  // the scaffolded workflow exports SKYHOOK_ENVIRONMENT on EVERY event, and a close event
  // that honored it would skip its own teardown and refuse on the wrong ref instead
  // (feat-006/AC-11, chg-001 — observed live before the guard existed).
  const dispatched = options.env['GITHUB_EVENT_NAME'] === 'workflow_dispatch';
  const carried = dispatched ? options.env['SKYHOOK_ENVIRONMENT'] : undefined;
  const requested = options.environment ?? carried;
  if (requested !== undefined && requested !== '') {
    return manualTeardown(requested, repository, token, options);
  }

  const trigger = await new GitHubTriggerSource({ env: options.env }).read();
  if (!trigger.ok) {
    options.err(`skyhook teardown: ${trigger.problem}`);
    return 1;
  }
  if (trigger.context.kind !== 'pull-request') {
    options.err(
      'skyhook teardown: the close fast path runs on a pull request\'s close event. ' +
        'To tear down a long-running environment, dispatch the teardown command with an ' +
        'environment name instead.',
    );
    return 1;
  }
  const { pullRequestNumber, fromFork } = trigger.context;

  // A fork never got an environment — it was never issued credentials — so its close has
  // nothing to do, and this run has no credentials to ask with either (AC-3).
  if (fromFork) {
    options.out(
      `Pull request #${pullRequestNumber} comes from a fork, so it never had an environment ` +
        'and there is nothing to tear down.',
    );
    return 0;
  }

  const derived = identityFor({ kind: 'pull-request', repository, pullRequestNumber });
  if (!derived.ok) {
    options.err(`skyhook teardown: cannot derive an environment identity: ${derived.reason}`);
    return 1;
  }
  let identity = derived.identity;

  const loaded = await loadConfig(
    new GitHubConfigSource({
      repository,
      token,
      ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
    }),
  );
  if (!loaded.ok) {
    options.err(`skyhook teardown: configuration: ${loaded.problems.join('; ')}`);
    return 1;
  }

  const broker = new AwsAccessBroker({
    env: options.env,
    runner: options.runner,
    repositoryRoot: '.',
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });

  // On a pooled repository this pull request's environment may be a slot, and the
  // claimant — not the identity — says which (feat-007/AC-8). The lookup rides the same
  // scout session a deploy claims through; a failed lookup stops loudly, and the
  // scheduled sweep completes the teardown within one interval — correctness never
  // depends on this fast path (constitution).
  if (loaded.config.pool !== null) {
    const openScout: ScoutAccessOpener =
      options.openScoutAccess ?? ((config, repo) => broker.openScout({ config, repository: repo }));
    const scout = await openScout(loaded.config, repository);
    if (!scout.ok) {
      options.err(
        `skyhook teardown: the pool-scout session could not be opened (${scout.problem}). ` +
          'Destroying nothing; the scheduled sweep completes this teardown.',
      );
      return 1;
    }
    const found = await scout.registry.findSlotByClaimant(repository, pullRequestNumber);
    if (!found.ok) {
      options.err(
        `skyhook teardown: the pool could not be read (${found.reason}). ` +
          'Destroying nothing; the scheduled sweep completes this teardown.',
      );
      return 1;
    }
    if (found.slot !== null) identity = found.slot.identity;
  }

  const openClose: CloseAccessOpener =
    options.openCloseAccess ??
    ((config, repo, id) =>
      broker.openTeardown({ config, repository: repo, identity: id, triggerKind: 'pull-request' }));
  const opened = await openClose(loaded.config, repository, identity);
  if (!opened.ok) {
    options.err(`skyhook teardown: ${opened.problem}`);
    return 1;
  }
  const { registry, store, makeDestroyer } = opened.access;

  // Read first: a close with no environment must not fetch a definition or assume the
  // deploy role just to discover there is nothing to destroy (AC-2).
  const existing = await registry.read(repository, identity);
  if (!existing.ok) {
    options.err(`skyhook teardown: the registry could not be read: ${existing.reason}`);
    return 1;
  }
  if (existing.record === null) {
    options.out(`Nothing to tear down: no environment is recorded for ${identity}.`);
    return 0;
  }

  const acquired = await makeDestroyer({
    commit: existing.record.deployedCommit,
    pullRequestNumber,
  });
  if (!acquired.ok) {
    options.err(`skyhook teardown: ${acquired.problem}`);
    return 1;
  }

  const removalDeferred = pullRequestNumberFor(identity) === null;
  const result = await teardownEnvironment(
    {
      registry,
      store,
      destroyer: acquired.destroyer,
      markerRemoval: 'record-only',
      // A pull-request run may not free a slot's name (feat-007/AC-11); the sweep does,
      // within one interval (chg-002, found live on deadweight pull request #9).
      ...(removalDeferred ? { recordRemoval: 'defer' as const } : {}),
    },
    { repository, identity },
  );
  return report(identity, result, options, removalDeferred);
}

/** The manual teardown of one long-running environment (feat-006 plan D5). */
async function manualTeardown(
  requested: string,
  repository: string,
  token: string,
  options: TeardownOptions,
): Promise<number> {
  // Before anything asks for a credential: say which ref the dispatch needs (AC-6).
  const refCheck = requireDefaultBranchRef(options.env);
  if (!refCheck.ok) {
    options.err(`skyhook teardown: ${refCheck.problem}`);
    return 1;
  }

  const derived = identityFor({ kind: 'default-branch', repository, requestedIdentity: requested });
  if (!derived.ok) {
    options.err(
      derived.reason === 'reserved-namespace'
        ? `skyhook teardown: "${requested}" is in the ephemeral namespace — every name ` +
            'beginning "pr-" belongs to pull-request environments, which are torn down by ' +
            'their close event and the sweep, never by name.'
        : `skyhook teardown: "${requested}" is not a valid environment name (${derived.reason})`,
    );
    return 1;
  }
  const identity = derived.identity;

  const loaded = await loadConfig(
    new GitHubConfigSource({
      repository,
      token,
      ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
    }),
  );
  if (!loaded.ok) {
    options.err(`skyhook teardown: configuration: ${loaded.problems.join('; ')}`);
    return 1;
  }

  const open: ManualAccessOpener =
    options.openManualAccess ??
    ((config, repo) =>
      new AwsAccessBroker({
        env: options.env,
        runner: options.runner,
        repositoryRoot: '.',
        ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
        ...(options.now !== undefined ? { now: options.now } : {}),
      }).openManual(config, repo));
  const opened = await open(loaded.config, repository);
  if (!opened.ok) {
    options.err(`skyhook teardown: ${opened.problem}`);
    return 1;
  }
  const { registry, store, destroyerFor } = opened.access;

  // Read first, exactly as the close path does: a name with no record must not fetch a
  // definition or assume the deploy role just to learn there is nothing to destroy.
  const existing = await registry.read(repository, identity);
  if (!existing.ok) {
    options.err(`skyhook teardown: the registry could not be read: ${existing.reason}`);
    return 1;
  }
  if (existing.record === null) {
    options.out(`Nothing to tear down: no environment is recorded for ${identity}.`);
    return 0;
  }

  const acquired = await destroyerFor(identity, {
    commit: existing.record.deployedCommit,
    // Null for a long-running name: the fetch falls back to the default branch's HEAD.
    pullRequestNumber: pullRequestNumberFor(identity),
  });
  if (!acquired.ok) {
    options.err(`skyhook teardown: ${acquired.problem}`);
    return 1;
  }

  const result = await teardownEnvironment(
    { registry, store, destroyer: acquired.destroyer, markerRemoval: 'with-record' },
    { repository, identity },
  );
  return reportManual(identity, result, options);
}

/** The mapping from a typed outcome to what the run says and how it exits. Exported for tests. */
export function exitCodeForTeardown(result: TeardownResult): number {
  switch (result.kind) {
    case 'destroyed':
    case 'nothing':
    case 'left-standing-protected':
    case 'reactivated':
      return 0;
    case 'protection-unknown':
      return 1;
    case 'failed':
      return result.consumer ? EXIT_CONSUMER_DESTROY_FAILED : 1;
  }
}

/**
 * The manual path's exit map differs from the close path's in exactly one row (feat-006
 * plan D5): `left-standing-protected` is non-zero. The close event honoring a mark is
 * policy working; a human's direct order being refused is an answer the run must not
 * dress up as success (AC-8). Exported for tests.
 */
export function exitCodeForManualTeardown(result: TeardownResult): number {
  if (result.kind === 'left-standing-protected') return 1;
  return exitCodeForTeardown(result);
}

function reportManual(identity: string, result: TeardownResult, options: TeardownOptions): number {
  if (result.kind === 'left-standing-protected') {
    options.err(
      `skyhook teardown: ${identity} carries a protection mark, so nothing was destroyed ` +
        'and nothing was removed. Destroying a protected environment takes two distinct ' +
        `human acts: first clear the mark (dispatch the unprotect command for ${identity}), ` +
        'then tear it down.',
    );
    return exitCodeForManualTeardown(result);
  }
  report(identity, result, options);
  return exitCodeForManualTeardown(result);
}

function report(
  identity: string,
  result: TeardownResult,
  options: TeardownOptions,
  removalDeferred = false,
): number {
  switch (result.kind) {
    case 'destroyed':
      for (const note of result.notes) options.out(note);
      options.out(
        removalDeferred
          ? `Destroyed ${identity}'s infrastructure. Its released record awaits the scheduled sweep, which frees the name.`
          : `Destroyed ${identity}. Its record is removed and the name is free.`,
      );
      break;
    case 'nothing':
      options.out(`Nothing to tear down: no environment is recorded for ${identity}.`);
      break;
    case 'left-standing-protected':
      options.out(
        `${identity} is protected, so it was left standing — destruction of a protected ` +
          'environment is never automatic. Its record and infrastructure are untouched.',
      );
      break;
    case 'reactivated':
      for (const note of result.notes) options.out(note);
      options.out(
        `${identity} was reactivated by a deploy while this teardown ran — the pull request ` +
          'reopened. The environment is left to the deploy.',
      );
      break;
    case 'protection-unknown':
      options.err(`skyhook teardown: ${result.problem}`);
      break;
    case 'failed':
      options.err(`skyhook teardown: ${result.problem}`);
      break;
  }
  return exitCodeForTeardown(result);
}
