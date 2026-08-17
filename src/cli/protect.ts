/**
 * `skyhook protect` / `skyhook unprotect` — the deliberate human act that latches an
 * environment against destruction, or releases the latch. Wiring and exit codes only:
 * the decision lives in `src/core/protection.ts`, tested against fakes.
 *
 * Env-driven like `sweep` (feat-006 plan D6): the environment comes from
 * SKYHOOK_ENVIRONMENT, and the run must be dispatched against the default branch — the
 * only trigger whose credentials the cloud lets write a mark. At prototype depth the
 * session is not narrowed below the role, matching the sweep's own wide session; the
 * guardrail gap is recorded in the plan.
 */

import { loadConfig } from '../core/config.ts';
import { identityFor } from '../core/identity.ts';
import { setProtection, type ProtectionResult } from '../core/protection.ts';
import { GitHubConfigSource } from '../adapters/github/config-source.ts';
import { AwsAccessBroker } from '../adapters/aws/broker.ts';
import { requireDefaultBranchRef } from './ref-check.ts';
import type { ManualAccessOpener } from './teardown.ts';
import type { CommandRunner } from './process.ts';

export interface ProtectOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly runner: CommandRunner;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  /** Injected for tests. Defaults to `AwsAccessBroker.openManual`. */
  readonly openManualAccess?: ManualAccessOpener;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
}

export async function protect(mark: boolean, options: ProtectOptions): Promise<number> {
  const verb = mark ? 'protect' : 'unprotect';

  const token = options.env['GITHUB_TOKEN'];
  if (token === undefined || token === '') {
    options.err(
      `skyhook ${verb}: GITHUB_TOKEN is not set. Skyhook reads settings from the ` +
        "repository's default branch through the GitHub API, which needs a token with " +
        'contents: read.',
    );
    return 1;
  }
  const repository = options.env['GITHUB_REPOSITORY'] ?? '';
  if (repository === '') {
    options.err(`skyhook ${verb}: GITHUB_REPOSITORY is not set`);
    return 1;
  }

  const requested = options.env['SKYHOOK_ENVIRONMENT'];
  if (requested === undefined || requested === '') {
    options.err(
      `skyhook ${verb}: SKYHOOK_ENVIRONMENT is not set. Dispatch the workflow with the ` +
        'environment input naming which environment to act on.',
    );
    return 1;
  }

  const refCheck = requireDefaultBranchRef(options.env);
  if (!refCheck.ok) {
    options.err(`skyhook ${verb}: ${refCheck.problem}`);
    return 1;
  }

  // Legality of the NAME only. The `pr-` namespace fence guards creating long-running
  // environments, not marking: an ephemeral environment may legitimately carry a mark
  // (teardown honors it), so a `pr-*` name passes through here untouched.
  const derived = identityFor({ kind: 'default-branch', repository, requestedIdentity: requested });
  const identity = derived.ok
    ? derived.identity
    : derived.reason === 'reserved-namespace'
      ? requested
      : null;
  if (identity === null) {
    options.err(`skyhook ${verb}: "${requested}" is not a valid environment name`);
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
    options.err(`skyhook ${verb}: configuration: ${loaded.problems.join('; ')}`);
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
    options.err(`skyhook ${verb}: ${opened.problem}`);
    return 1;
  }

  const result = await setProtection(opened.access.registry, { repository, identity, protect: mark });
  return report(verb, identity, result, options);
}

/** The mapping from a typed outcome to an exit status. Exported for tests. */
export function exitCodeForProtection(result: ProtectionResult): number {
  return result.kind === 'applied' ? 0 : 1;
}

function report(
  verb: string,
  identity: string,
  result: ProtectionResult,
  options: ProtectOptions,
): number {
  switch (result.kind) {
    case 'applied':
      options.out(
        result.isProtected
          ? `${identity} is protected. Even the manual teardown now refuses it; clear the ` +
              'mark with the unprotect command first when its time is over. Updates are ' +
              'not destruction — default-branch deploys still update it in place.'
          : `${identity} is no longer protected. A manual teardown naming it will now proceed.`,
      );
      break;
    case 'no-record':
      options.err(`skyhook ${verb}: no environment is recorded for ${identity}, so there is nothing to ${verb}.`);
      break;
    case 'released':
      options.err(
        `skyhook ${verb}: ${identity} is awaiting teardown — its record is released, and ` +
          'releasing was itself the authorization to destroy. The mark can change only on ' +
          'an active environment; the next sweep pass completes the teardown.',
      );
      break;
    case 'failed':
      options.err(`skyhook ${verb}: ${result.problem}`);
      break;
  }
  return exitCodeForProtection(result);
}
