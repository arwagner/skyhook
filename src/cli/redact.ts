/**
 * `skyhook redact` — the deliberate human act that removes one recorded deploy-input
 * value from an environment's record, so a secret recorded by mistake is not stuck in
 * the registry until the environment dies (chg-011, AC-37). Wiring and exit codes only:
 * the write itself is `Registry.redactInput`, tested against fakes.
 *
 * Env-driven like `protect` (the same manual-dispatch surface): the environment comes
 * from SKYHOOK_ENVIRONMENT, the input's name from SKYHOOK_INPUT_NAME, and the run must
 * be dispatched against the default branch. That routing is a guardrail in files a
 * maintainer reviews, not a cloud boundary — a pull-request run that bypassed it would
 * gain nothing it lacks, since an ordinary deploy already replaces its own record's
 * whole map (AC-36).
 */

import { loadConfig } from '../core/config.ts';
import { identityFor } from '../core/identity.ts';
import { GitHubConfigSource } from '../adapters/github/config-source.ts';
import { AwsAccessBroker } from '../adapters/aws/broker.ts';
import { requireDefaultBranchRef } from './ref-check.ts';
import type { ManualAccessOpener } from './teardown.ts';
import type { CommandRunner } from './process.ts';

export interface RedactOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly runner: CommandRunner;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  /** Injected for tests. Defaults to `AwsAccessBroker.openManual`. */
  readonly openManualAccess?: ManualAccessOpener;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
}

export async function redact(options: RedactOptions): Promise<number> {
  const token = options.env['GITHUB_TOKEN'];
  if (token === undefined || token === '') {
    options.err(
      'skyhook redact: GITHUB_TOKEN is not set. Skyhook reads settings from the ' +
        "repository's default branch through the GitHub API, which needs a token with " +
        'contents: read.',
    );
    return 1;
  }
  const repository = options.env['GITHUB_REPOSITORY'] ?? '';
  if (repository === '') {
    options.err('skyhook redact: GITHUB_REPOSITORY is not set');
    return 1;
  }

  const requested = options.env['SKYHOOK_ENVIRONMENT'];
  if (requested === undefined || requested === '') {
    options.err(
      'skyhook redact: SKYHOOK_ENVIRONMENT is not set. Dispatch the workflow with the ' +
        'environment input naming which environment holds the value.',
    );
    return 1;
  }
  const name = options.env['SKYHOOK_INPUT_NAME'];
  if (name === undefined || name === '') {
    options.err(
      'skyhook redact: SKYHOOK_INPUT_NAME is not set. Name the one declared input whose ' +
        'recorded value should be removed.',
    );
    return 1;
  }

  const refCheck = requireDefaultBranchRef(options.env);
  if (!refCheck.ok) {
    options.err(`skyhook redact: ${refCheck.problem}`);
    return 1;
  }

  // Legality of the NAME only, exactly as protect reads it: an ephemeral environment's
  // record may legitimately hold a value worth redacting, so `pr-*` passes through.
  const derived = identityFor({ kind: 'default-branch', repository, requestedIdentity: requested });
  const identity = derived.ok
    ? derived.identity
    : derived.reason === 'reserved-namespace'
      ? requested
      : null;
  if (identity === null) {
    options.err(`skyhook redact: "${requested}" is not a valid environment name`);
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
    options.err(`skyhook redact: configuration: ${loaded.problems.join('; ')}`);
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
    options.err(`skyhook redact: ${opened.problem}`);
    return 1;
  }

  const outcome = await opened.access.registry.redactInput(repository, identity, name);
  if (!outcome.ok) {
    if (outcome.reason === 'not-found') {
      options.err(`skyhook redact: no environment is recorded for ${identity}, so there is no value to remove.`);
    } else {
      options.err(`skyhook redact: the registry could not be updated (${outcome.reason}). Nothing was changed; try again.`);
    }
    return 1;
  }
  options.out(
    `${identity}: the recorded value of "${name}" is removed — withheld, not rewritten. ` +
      'A destroy now runs without it; if the definition requires it, that destroy fails ' +
      'loudly until a redeploy re-records the value or a human supplies the destroy.',
  );
  return 0;
}
