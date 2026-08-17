/**
 * The seams a deploy runs through.
 *
 * Nothing here may name a cloud, a CI host, or an infrastructure-as-code tool
 * (constitution, "provider-agnostic core"; feat-001 plan D6). These three ports are what
 * let `src/core/deploy.ts` — where the ordering that keeps the no-orphans promise lives —
 * run against fakes with no cloud account, which the constitution's quality bar requires.
 */

import type { Registry } from './registry.ts';
import type { SkyhookConfig } from './types.ts';

// --- what the CI host says happened -----------------------------------------

/**
 * One pull request, as the CI host reports it.
 *
 * A deploy triggered this way never takes an environment identity as input — it derives
 * one from this, which is what makes such a run able to name only its own environment
 * (feat-001 `identityFor`).
 */
export interface PullRequestContext {
  readonly kind: 'pull-request';
  /** `owner/name`. */
  readonly repository: string;
  readonly pullRequestNumber: number;
  /**
   * The commit a reviewer means: the pull request's own head.
   *
   * Deliberately not whatever commit the CI host says is "current" — for a pull request
   * that is usually an ephemeral merge commit which names nothing anyone would recognise,
   * and which would be recorded as the deployed commit and shown on a dashboard.
   */
  readonly headCommit: string;
  /**
   * True when the pull request comes from a fork. Forks get no environment, and skyhook
   * has to know before it asks for credentials rather than after being refused them.
   */
  readonly fromFork: boolean;
}

/**
 * A run from the default branch, deploying a long-running environment. The identity is
 * the operator's choice, carried by the run — legality (including the `pr-` namespace
 * fence) is `identityFor`'s question, not the trigger reader's (feat-006 plan D2).
 */
export interface DefaultBranchContext {
  readonly kind: 'default-branch';
  /** `owner/name`. */
  readonly repository: string;
  /** The pushed head: what the default branch now points at, and what gets recorded. */
  readonly headCommit: string;
  /** The operator-chosen environment name this run deploys. */
  readonly requestedIdentity: string;
}

export type TriggerContext = PullRequestContext | DefaultBranchContext;

export type TriggerOutcome =
  | { readonly ok: true; readonly context: TriggerContext }
  /** Not a deploy trigger at all, or the host said something skyhook cannot read. */
  | { readonly ok: false; readonly problem: string };

export interface TriggerSource {
  read(): Promise<TriggerOutcome>;
}

// --- credentials, and everything that needs them ----------------------------

export interface AccessRequest {
  readonly config: SkyhookConfig;
  readonly repository: string;
  /** The environment this run may touch, and the only one its credentials will permit. */
  readonly identity: string;
  /**
   * What triggered the run, so the broker can ask for the credentials that trigger earns
   * (feat-006 plan D4). Selection, not enforcement: the cloud refuses a mismatched ask.
   */
  readonly triggerKind: TriggerContext['kind'];
}

/**
 * The registry and the deployer arrive together because they are the two things a deploy
 * cannot obtain without credentials, and they are obtained in one act. Splitting them
 * would mean two brokers narrowing two credentials from one identity — two places to get
 * the narrowing wrong, for no gain.
 */
export interface AccessGrant {
  readonly registry: Registry;
  readonly deployer: EnvironmentDeployer;
}

export type AccessOutcome =
  | { readonly ok: true; readonly grant: AccessGrant }
  | {
      readonly ok: false;
      readonly reason:
        /** Skyhook's own credentials. Its bootstrap owns this role, so this is skyhook's problem. */
        | 'skyhook-role-unavailable'
        /**
         * The role the consuming repo declares for its own infrastructure. Absent, or its
         * trust does not accept this run. The maintainer's problem, and the message has to
         * say what to do about it (AC-11).
         */
        | 'deploy-role-unavailable';
      readonly problem: string;
    };

export interface AccessBroker {
  open(request: AccessRequest): Promise<AccessOutcome>;
}

// --- deploying one environment ----------------------------------------------

export interface DeployRequest {
  readonly repository: string;
  readonly identity: string;
  /** Where the consuming repo's own infrastructure definition lives. */
  readonly directory: string;
}

/**
 * How long each side took.
 *
 * The split exists because AC-14 draws a line through a deploy — and it draws it in two
 * places, not one. Selecting the environment's copy is skyhook's own work and counts
 * against its 60 seconds; the repository's apply is not and does not; and neither is the
 * step that prepares that definition beforehand. Two fields let the caller subtract only
 * half of what it should, which is what it did until `gap-001` was found.
 */
export interface DeployTiming {
  /**
   * Skyhook's own work inside the deployer: refusing a definition that would move the
   * state, declaring the backend, checking what terraform actually initialized, and
   * selecting this environment's copy.
   *
   * Computed by subtracting `initMs` from the whole pre-apply window rather than by adding
   * up those steps, so a step added here later and never given a stopwatch lands on
   * skyhook's side of the line rather than in nobody's column (AC-14, last sentence).
   */
  readonly preparationMs: number;
  /**
   * `terraform init`, whole. Not skyhook's.
   *
   * Named after the command rather than after one of its two jobs, because it fetches the
   * repository's providers and modules AND configures skyhook's own backend, and nothing
   * here separates them. A field called `fetchMs` would claim a boundary this measurement
   * does not hold — which is exactly what the old `applyMs` contract claimed, and exactly
   * what `gap-001` was. Charging the whole command to the repository leaves skyhook's
   * backend configuration uncounted; that residue is a few object-store round-trips, and
   * it is the accepted price of not counting a dependency tree skyhook does not control
   * (plan D7a, which prices the alternative: running init twice).
   */
  readonly initMs: number;
  /** `terraform apply`: the consuming repo's own infrastructure. Not skyhook's. */
  readonly applyMs: number;
}

export type DeployOutcome =
  | {
      readonly ok: true;
      /** Where the environment is, or null when the definition names no address. */
      readonly url: string | null;
      readonly timing: DeployTiming;
    }
  | {
      readonly ok: false;
      readonly reason:
        /** The repository's own definition failed to apply. Not a fault of skyhook's (AC-18). */
        | 'consumer-apply-failed'
        /** Skyhook could not do its job — including refusing to let the state be relocated. */
        | 'skyhook-failed';
      readonly problem: string;
      readonly timing: DeployTiming;
    };

export interface EnvironmentDeployer {
  deploy(request: DeployRequest): Promise<DeployOutcome>;
}

// --- destroying one environment ----------------------------------------------

export interface DestroyRequest {
  readonly repository: string;
  /**
   * Derived from the trigger (fast path) or from the registry object's KEY (sweep) —
   * never from a field inside a stored record. A record's body is writable by the run
   * that owns it, so a body-derived identity would let one pull request steer a destroy
   * at another's environment (plan D2, the identity invariant).
   */
  readonly identity: string;
  /**
   * The record's recorded deploy-input values, replayed into the destroy (chg-001,
   * AC-15) — the recorded values, not the current declared list, by the same reasoning
   * that runs the destroy at the recorded commit. Absent or null destroys with none
   * set, which is every record written before recording existed.
   *
   * Body-derived, unlike the identity, and safely so: the values feed only this same
   * environment's own destroy, and the run that owns the record already controlled them
   * at deploy time. The identity invariant above is untouched.
   */
  readonly deployInputs?: Readonly<Record<string, string>> | null;
}

export type DestroyOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason:
        /** The repository's own definition failed to destroy. Not a fault of skyhook's. */
        | 'consumer-destroy-failed'
        /** Skyhook could not do its job — obtaining the definition, refusing a hijacked backend. */
        | 'skyhook-failed';
      readonly problem: string;
    };

export type ResidualOutcome =
  | { readonly ok: true; readonly empty: boolean }
  | { readonly ok: false; readonly problem: string };

export interface EnvironmentDestroyer {
  destroy(request: DestroyRequest): Promise<DestroyOutcome>;
  /**
   * Whether the environment's stored infrastructure state still names any resource.
   *
   * Read after a successful destroy and before anything is deleted: a destroy that
   * exited cleanly while the state still names resources is a phantom success, and
   * deleting the state and record after it would mint an orphan with no registry trace
   * (plan D6 step 4 — the destroy-side counterpart of the deploy plan's D6a third check).
   */
  residualResources(request: DestroyRequest): Promise<ResidualOutcome>;
}

// --- what the source host says about a pull request ---------------------------

export type PullRequestState = 'open' | 'closed';

export type PullRequestStateOutcome =
  | { readonly ok: true; readonly state: PullRequestState }
  | { readonly ok: false; readonly problem: string };

/**
 * The sweep's eligibility question, asked of the host's actual pull-request state rather
 * than of anything a missed close event should have written. The constitution's sweep
 * clause is why: correctness may never depend on an event having fired.
 */
export interface PullRequestStateSource {
  state(repository: string, pullRequestNumber: number): Promise<PullRequestStateOutcome>;
}
