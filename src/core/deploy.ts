/**
 * One deploy, in the order that keeps the no-orphans promise.
 *
 *   trigger → fork? stop → config → credentials → cap → record → apply → commit + address
 *
 * **The order is the requirement, not an implementation detail.** A record written after
 * the infrastructure would produce an orphan the moment the run died between the two, and
 * the sweep that makes teardown a guarantee can only destroy what it can find. Every other
 * decision here is negotiable; this one is the feature.
 *
 * Nothing in this file names a cloud, a CI host, or an infrastructure-as-code tool. It
 * runs entirely against the ports in `ports.ts`, which is what lets the ordering above be
 * tested with no cloud account (constitution, quality bar).
 */

import { identityFor } from './identity.ts';
import { loadConfig, type ConfigSource } from './config.ts';
import { deployInputValueProblem } from './registry.ts';
import type { AccessBroker, DeployOutputs, EnvironmentDeployer, TriggerSource } from './ports.ts';
import type { Registry } from './registry.ts';
import type { SkyhookConfig } from './types.ts';

/**
 * Where a declared deploy input's value comes from at run time (chg-007, AC-22).
 *
 * A port, because the transport is the tool's: values ride the calling workflow's
 * environment under the tool's own variable convention, and nothing in `src/core/` may
 * name that convention (constitution, provider-agnostic core). `address` renders the
 * name in the tool's vocabulary — the exact thing the workflow must set — so a refusal
 * can say it without core knowing it.
 */
export interface DeclaredInputSource {
  read(name: string): string | undefined;
  address(name: string): string;
}

export interface DeployPorts {
  readonly trigger: TriggerSource;
  readonly configSource: ConfigSource;
  readonly broker: AccessBroker;
  /** Milliseconds from some fixed point. Injected so timing is testable. */
  readonly now: () => number;
  /**
   * Absent means no values are readable — every declared input is then refused as
   * missing, loudly. Fail-closed: a wiring that forgets this cannot silently deploy
   * a definition's defaults in the values' place.
   */
  readonly inputSource?: DeclaredInputSource;
}

export type DeployResult =
  | {
      readonly kind: 'deployed';
      readonly identity: string;
      readonly commit: string;
      readonly url: string | null;
      /** Every output the definition declares, for the calling workflow (AC-24). */
      readonly outputs: DeployOutputs | null;
      /**
       * Skyhook's own share, excluding both of the consuming repo's steps — applying its
       * infrastructure, and preparing that definition beforehand (AC-14).
       */
      readonly skyhookMs: number;
      /** Anything worth saying that is not a failure — a missing address, say. */
      readonly notes: readonly string[];
    }
  /** A fork. Not a failure: the run succeeds, having deployed nothing, and says why (AC-10). */
  | { readonly kind: 'skipped'; readonly message: string }
  /** Skyhook could not do its job. Exit non-zero, and do not blame the repository (AC-18). */
  | { readonly kind: 'failed'; readonly message: string }
  /** The repository's own apply failed. A different exit status, and a different sentence. */
  | {
      readonly kind: 'consumer-failed';
      readonly identity: string;
      readonly message: string;
      readonly skyhookMs: number;
    };

export async function deployEnvironment(ports: DeployPorts): Promise<DeployResult> {
  const startedAt = ports.now();

  const trigger = await ports.trigger.read();
  if (!trigger.ok) return { kind: 'failed', message: trigger.problem };
  const context = trigger.context;
  const { repository, headCommit } = context;

  // Before anything asks for a credential. GitHub issues a fork pull request no identity
  // token, so every later step would fail — and would fail as an authentication error
  // halfway through, which tells the author nothing about why (constitution, forks).
  // Only a pull request can come from a fork; a push ran on this repository by definition.
  if (context.kind === 'pull-request' && context.fromFork) {
    return {
      kind: 'skipped',
      message:
        `Pull request #${context.pullRequestNumber} comes from a fork, so it gets no environment. ` +
        'A fork pull request is issued no identity token, so no role can be assumed — ' +
        'skyhook stops here rather than failing partway through with a credential error.',
    };
  }

  const derived = identityFor(
    context.kind === 'pull-request'
      ? { kind: 'pull-request', repository, pullRequestNumber: context.pullRequestNumber }
      : { kind: 'default-branch', repository, requestedIdentity: context.requestedIdentity },
  );
  if (!derived.ok) {
    if (derived.reason === 'reserved-namespace') {
      // Refused before anything is recorded or applied (feat-006/AC-3): every name
      // beginning `pr-` belongs to the ephemeral namespace, where the credential fence
      // for pull-request runs is drawn.
      return {
        kind: 'failed',
        message:
          `"${context.kind === 'default-branch' ? context.requestedIdentity : ''}" collides with ` +
          'the ephemeral namespace: every name beginning "pr-" belongs to pull-request ' +
          'environments, and a long-running environment named inside it would sit on the ' +
          'wrong side of the credential fence. Nothing was recorded and nothing was ' +
          'applied. Choose a name that does not begin "pr-".',
      };
    }
    return { kind: 'failed', message: `cannot derive an environment identity: ${derived.reason}` };
  }
  const identity = derived.identity;

  const loaded = await loadConfig(ports.configSource);
  if (!loaded.ok) {
    return { kind: 'failed', message: `configuration: ${loaded.problems.join('; ')}` };
  }
  const settingsProblem = missingDeploySettings(loaded.config);
  if (settingsProblem !== null) return { kind: 'failed', message: settingsProblem };
  const deploySettings = loaded.config.deploy;
  /* c8 ignore next */
  if (deploySettings === null) return { kind: 'failed', message: 'configuration: deploy is required' };

  // Declared inputs are read here — after the settings that declare them, before any
  // credential is requested and before the claim (AC-22). A missing one means the
  // workflow is mis-wired, and the two other places that could surface are both worse:
  // the tool prompting is dead in automation, and a definition-side default deploying in
  // the value's place is the silent catastrophe the explicit list exists to prevent.
  const inputs = readDeclaredInputs(deploySettings.inputs, ports.inputSource);
  if (!inputs.ok) return { kind: 'failed', message: inputs.problem };

  const access = await ports.broker.open({
    config: loaded.config,
    repository,
    identity,
    triggerKind: context.kind,
  });
  if (!access.ok) return { kind: 'failed', message: access.problem };
  const { registry, deployer } = access.grant;

  const claimed = await claimOrRefresh(registry, loaded.config, repository, identity, context.kind);
  if (!claimed.ok) return { kind: 'failed', message: claimed.problem };

  const applied = await deployer.deploy({
    repository,
    identity,
    directory: deploySettings.directory,
  });

  // Skyhook's own share is everything except the consuming repo's two steps: applying its
  // infrastructure, and the preparation step beforehand that fetches what the definition
  // needs to run (AC-14, plan D7a). Subtracting only the apply made this figure a partial
  // measure of somebody else's dependency tree, which is what `gap-001` found.
  //
  // Measured by subtracting those two from wall time, rather than by adding up skyhook's own
  // steps, so a step nobody remembered to instrument still lands on skyhook's side of the
  // line where it belongs. AC-14 requires that outcome; this is the mechanism that gives it.
  const elapsed = (): number =>
    ports.now() - startedAt - applied.timing.initMs - applied.timing.applyMs;

  if (!applied.ok) {
    if (applied.reason === 'consumer-apply-failed') {
      // The record stays, and the commit recorded against it is untouched (AC-3): an
      // environment whose record names an older commit — or none — is exactly an
      // environment whose last deploy did not land.
      return {
        kind: 'consumer-failed',
        identity,
        message: applied.problem,
        skyhookMs: elapsed(),
      };
    }
    return { kind: 'failed', message: applied.problem };
  }

  // Only now. The commit moves after a successful apply and never before it.
  const recorded = await registry.read(repository, identity);
  if (!recorded.ok || recorded.record === null) {
    return {
      kind: 'failed',
      message:
        `deployed ${identity}, but its record could not be updated afterwards ` +
        `(${recorded.ok ? 'the record is gone' : recorded.reason}). The infrastructure exists ` +
        'and the registry does not describe it — re-run before anything else.',
    };
  }
  // The values move exactly when the commit does, as a wholesale replace (AC-23): the
  // record always names the commit and the artifacts of the last deploy that landed.
  const updated = await registry.update(repository, identity, recorded.version, {
    deployedCommit: headCommit,
    url: applied.url,
    deployInputs: Object.keys(inputs.values).length > 0 ? inputs.values : null,
  });
  if (!updated.ok) {
    return {
      kind: 'failed',
      message:
        `deployed ${identity}, but recording the result was refused (${updated.reason}). ` +
        'The infrastructure exists and the registry still names the previous commit.',
    };
  }

  const notes: string[] = [];
  if (applied.url === null) {
    notes.push(
      'The infrastructure definition declares no output named "url", so this environment ' +
        'has no address recorded and none is handed back.',
    );
  }

  return {
    kind: 'deployed',
    identity,
    commit: headCommit,
    url: applied.url,
    outputs: applied.outputs,
    skyhookMs: elapsed(),
    notes,
  };
}

/**
 * What a deploy needs from configuration that no other command does. Reported together,
 * because a maintainer setting this up for the first time would otherwise fix one, re-run,
 * and be told about the next.
 */
function missingDeploySettings(config: SkyhookConfig): string | null {
  const missing: string[] = [];
  if (config.storage.account === null) {
    missing.push('storage.account (the account holding the bucket and roles)');
  }
  if (config.deploy === null) {
    missing.push('deploy.directory (where this repository keeps its own infrastructure)');
  }
  if (missing.length === 0) return null;
  return (
    `configuration is missing what a deploy needs: ${missing.join(', ')}. ` +
    'Add it on the default branch — settings are read from there, never from a pull ' +
    "request's own branch."
  );
}

type DeclaredInputsResult =
  | { readonly ok: true; readonly values: Readonly<Record<string, string>> }
  | { readonly ok: false; readonly problem: string };

/**
 * Every declared input, read and held to the record's value rule, or one message naming
 * every offender at once — a maintainer wiring this up for the first time would
 * otherwise fix one, re-run, and be told about the next (the `missingDeploySettings`
 * rationale). A repository that declares none deploys exactly as before (AC-22).
 */
function readDeclaredInputs(
  names: readonly string[],
  source: DeployPorts['inputSource'],
): DeclaredInputsResult {
  const problems: string[] = [];
  const values: Record<string, string> = {};
  for (const name of names) {
    const address = source?.address(name) ?? name;
    const value = source?.read(name);
    if (value === undefined) {
      problems.push(`${address} is not set`);
      continue;
    }
    const problem = deployInputValueProblem(value);
    if (problem !== null) {
      problems.push(`${address} ${problem}`);
      continue;
    }
    values[name] = value;
  }
  if (problems.length > 0) {
    return {
      ok: false,
      problem:
        `declared deploy inputs are unusable: ${problems.join('; ')}. ` +
        'Set each before invoking skyhook — no record was written and nothing was applied, ' +
        "so no definition default deployed in a value's place.",
    };
  }
  return { ok: true, values };
}

type ClaimResult = { readonly ok: true } | { readonly ok: false; readonly problem: string };

/**
 * Reach this pull request's own environment: claim it if it is new, take it back if it was
 * released, proceed if it is already ours.
 *
 * **Not `claim()` alone.** feat-001's D2b makes claiming create-if-absent with no state
 * machine, so an existing record refuses regardless of state — which is right for handing
 * out a free name and wrong for a pull request returning to the environment it already
 * owns. The identity is derived from the trigger, so "is this mine?" is answerable without
 * asking anyone: if a record exists under this identity, it belongs to this pull request.
 */
async function claimOrRefresh(
  registry: Registry,
  config: SkyhookConfig,
  repository: string,
  identity: string,
  triggerKind: 'pull-request' | 'default-branch',
): Promise<ClaimResult> {
  const existing = await registry.read(repository, identity);
  if (!existing.ok) {
    return { ok: false, problem: `the registry could not be read: ${existing.reason}` };
  }

  if (existing.record !== null) {
    // Ours already. The cap does not apply — this run is refreshing an environment, not
    // adding one, and locking it out of its own would be absurd.
    if (existing.record.state === 'released') {
      // A pull request returning to its released environment is the reopen case: take it
      // back. A default-branch deploy meeting `released` is different — a started manual
      // teardown of a long-running environment, which the next sweep pass completes, and
      // reviving it would race that completion. The name is refused until the teardown
      // finishes (feat-006/AC-7).
      if (triggerKind === 'default-branch') {
        return {
          ok: false,
          problem:
            `${identity} is awaiting teardown: a started teardown released its record, and ` +
            'the next sweep pass completes the destruction. Deploy again once it has.',
        };
      }
      const revived = await registry.update(repository, identity, existing.version, {
        state: 'active',
      });
      if (!revived.ok) {
        return { ok: false, problem: `could not reclaim ${identity}: ${revived.reason}` };
      }
    }
    return { ok: true };
  }

  const capProblem = await capRefusal(registry, config, repository);
  if (capProblem !== null) return { ok: false, problem: capProblem };

  const claim = await registry.claim({ repository, identity });
  if (!claim.ok) {
    return {
      ok: false,
      problem:
        `could not claim ${identity}: ${claim.reason}` +
        (claim.reason === 'contended' ? ' — nothing was established; try again' : ''),
    };
  }
  return { ok: true };
}

/**
 * Refuse before anything is recorded or applied (AC-9).
 *
 * Counts records rather than active states, because the credentials this run holds are
 * narrowed to its own environment and cannot read anyone else's record. See
 * `Registry.countEnvironments`.
 */
async function capRefusal(
  registry: Registry,
  config: SkyhookConfig,
  repository: string,
): Promise<string | null> {
  if (!config.environmentCap.enabled) return null;

  const counted = await registry.countEnvironments(repository);
  if (!counted.ok) {
    return `the environment cap could not be checked: ${counted.reason}`;
  }
  if (counted.count < config.environmentCap.limit) return null;

  return (
    `the environment cap is reached: ${counted.count} environments recorded, cap ${config.environmentCap.limit}. ` +
    'Nothing was recorded and nothing was applied. Tear an environment down, or raise ' +
    'environment_cap.limit on the default branch.'
  );
}
