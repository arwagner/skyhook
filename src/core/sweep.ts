/**
 * The sweep: compare what the registry records against what should exist, and correct
 * the difference — the recurring job that makes cleanup true. Close events are a fast
 * path only; this is the code path correctness actually rests on (constitution).
 *
 * Eligibility is derived from the pull request's ACTUAL state, asked of the host per
 * environment — never from a record flag a missed close event would have left unset. A
 * `released` record is the one exception: it IS a started teardown, completed without
 * asking anyone (AC-5) — whatever kind of environment it names. A long-running
 * environment's manual teardown that died halfway left a `released` record, and the
 * decision to destroy was the human's; the sweep only finishes what was explicitly
 * started (feat-006/AC-7). What the sweep never does is START one: an `active`
 * non-ephemeral record is left standing untouched.
 *
 * Identities come from registry keys alone, and everything downstream — the pull
 * request asked about, the destroyer's target, the state prefix deleted — derives from
 * that key-recovered identity (plan D2, the identity invariant; AC-14's planted-record
 * test). The record's body contributes exactly one thing: its own `state` field, whose
 * blast radius is the one environment the key already scopes.
 *
 * One environment's failure never stops the others (AC-9); the caller turns the
 * collected outcomes into one loud report and a non-zero exit.
 */

import { pullRequestNumberFor, slotIdentityFor, slotNumberFor } from './identity.ts';
import type { EnvironmentDeployer, EnvironmentDestroyer, PullRequestStateSource } from './ports.ts';
import { isClaimable, type Registry } from './registry.ts';
import type { Store } from './store.ts';
import type { EnvironmentCap } from './types.ts';
import { readDeclaredInputs, type DeclaredInputSource } from './deploy.ts';
import { teardownEnvironment } from './teardown.ts';

export type DestroyerAcquisition =
  | { readonly ok: true; readonly destroyer: EnvironmentDestroyer }
  | { readonly ok: false; readonly problem: string };

export type DeployerAcquisition =
  | { readonly ok: true; readonly deployer: EnvironmentDeployer }
  | { readonly ok: false; readonly problem: string };

/**
 * What the pool phase needs (feat-007 plan D6). Present exactly when pooling is on;
 * absent, the sweep is byte-for-byte its pre-pool self (AC-1).
 */
export interface PoolPorts {
  /** How many claimable warm slots the repository wants standing. */
  readonly target: number;
  /** Warm slots count against the same cap as everything else (od-3). */
  readonly cap: EnvironmentCap;
  /** The default branch's current commit — what a warm build deploys and records. */
  readonly headCommit: string;
  /** Where the repo keeps its infrastructure definition. */
  readonly directory: string;
  /** The declared deploy inputs a warm build must carry, and where their values come from (od-1). */
  readonly declaredInputs: readonly string[];
  readonly inputSource?: DeclaredInputSource;
  /** A builder narrowed to the one slot being built — the deploy-side twin of `destroyerFor`. */
  readonly deployerFor: (identity: string) => Promise<DeployerAcquisition>;
}

export interface SweepPorts {
  /** Wide-credentialed: the sweep runs from the default branch and reads every record. */
  readonly registry: Registry;
  readonly store: Store;
  readonly pullRequests: PullRequestStateSource;
  /**
   * The per-environment narrowing seam (plan D4): each environment's destroyer arrives
   * under credentials narrowed to that one environment, so the ordinary path cannot
   * touch a sibling even when the logic above it is wrong.
   */
  readonly destroyerFor: (identity: string) => Promise<DestroyerAcquisition>;
  readonly pool?: PoolPorts;
}

export interface SweepEntry {
  readonly identity: string;
  readonly kind:
    | 'destroyed'
    /** Gone before the sweep reached it — a fast path or peer completed it. */
    | 'already-gone'
    | 'left-standing-protected'
    | 'protection-unknown'
    | 'reactivated'
    /** The pull request is open: not eligible, untouched. */
    | 'left-standing-open'
    /** Not an ephemeral environment. The sweep does not touch what it does not own. */
    | 'not-ephemeral'
    /** A claimable warm slot, standing ready. Untouched (feat-007). */
    | 'warm-ready'
    /** The pool phase built this slot to a claimable state (feat-007/AC-9). */
    | 'pool-built'
    /** The pool is under target but the cap leaves no headroom; nothing was built (od-3). */
    | 'pool-at-cap'
    | 'failed';
  /** Set only for `failed`. */
  readonly consumer?: boolean;
  readonly problem?: string;
  readonly notes?: readonly string[];
}

export type SweepResult =
  /** The sweep ran; each environment's outcome is its own. */
  | { readonly kind: 'swept'; readonly entries: readonly SweepEntry[] }
  /** The sweep itself could not do its job — nothing per-environment to report. */
  | { readonly kind: 'failed'; readonly problem: string };

export async function sweepEnvironments(ports: SweepPorts, repository: string): Promise<SweepResult> {
  const listed = await ports.registry.listIdentities(repository);
  if (!listed.ok) {
    return { kind: 'failed', problem: `the registry could not be listed: ${listed.reason}` };
  }

  const entries: SweepEntry[] = [];
  for (const identity of listed.identities) {
    entries.push(await sweepOne(ports, repository, identity));
  }
  // Destroy first, then build: the pool phase runs after every eligible teardown so a
  // freed cap slot is usable this pass, and exactly one build per pass keeps
  // "commitless warm = wreckage" sound (feat-007 plan D6, the spec's sharp edge).
  if (ports.pool !== undefined) {
    entries.push(...(await replenishPool(ports, ports.pool, repository)));
  }
  return { kind: 'swept', entries };
}

/**
 * Build at most one slot toward the target (feat-007/AC-9). Every refusal is an entry —
 * silence is the failure mode a sweep cannot afford.
 */
async function replenishPool(
  ports: SweepPorts,
  pool: PoolPorts,
  repository: string,
): Promise<SweepEntry[]> {
  const listed = await ports.registry.listSlots(repository);
  if (!listed.ok) {
    return [{ identity: 'pool', kind: 'failed', consumer: false, problem: `the pool could not be read: ${listed.reason}` }];
  }
  const claimable = listed.slots.filter((slot) => isClaimable(slot.record)).length;
  if (claimable >= pool.target) return [];

  // Warm slots count against the cap exactly as any record does; at the cap the pool
  // does not replenish, and says so (od-3, AC-9).
  if (pool.cap.enabled) {
    const counted = await ports.registry.countEnvironments(repository);
    if (!counted.ok) {
      return [{ identity: 'pool', kind: 'failed', consumer: false, problem: `the cap could not be checked: ${counted.reason}` }];
    }
    if (counted.count >= pool.cap.limit) {
      return [{ identity: 'pool', kind: 'pool-at-cap' }];
    }
  }

  // The declared inputs are refused before any record exists (AC-3): a missing value
  // means the scheduled workflow is mis-wired, and a definition default deploying in a
  // value's place is the silent catastrophe the declaration exists to prevent.
  const inputs = readDeclaredInputs(pool.declaredInputs, pool.inputSource);
  if (!inputs.ok) {
    return [{ identity: 'pool', kind: 'failed', consumer: false, problem: inputs.problem }];
  }

  // The lowest slot number with no record. Identities come from registry keys alone.
  const identities = await ports.registry.listIdentities(repository);
  if (!identities.ok) {
    return [{ identity: 'pool', kind: 'failed', consumer: false, problem: `the registry could not be listed: ${identities.reason}` }];
  }
  const used = new Set(
    identities.identities
      .map((identity) => slotNumberFor(identity))
      .filter((n): n is number => n !== null),
  );
  let index = 1;
  while (used.has(index)) index += 1;
  const identity = slotIdentityFor(index);

  // Record before resource — the pool builder holds the no-orphans promise exactly the
  // way a deploy does (AC-2).
  const claimed = await ports.registry.claim({ repository, identity, state: 'warm' });
  if (!claimed.ok) {
    return [{ identity, kind: 'failed', consumer: false, problem: `the slot could not be claimed: ${claimed.reason}` }];
  }

  const acquired = await pool.deployerFor(identity);
  if (!acquired.ok) {
    // The commitless warm record stays: honest about what may now exist, and exactly
    // what the next pass clears as wreckage.
    return [{ identity, kind: 'failed', consumer: false, problem: acquired.problem }];
  }
  const applied = await acquired.deployer.deploy({
    repository,
    identity,
    directory: pool.directory,
  });
  if (!applied.ok) {
    return [
      {
        identity,
        kind: 'failed',
        consumer: applied.reason === 'consumer-apply-failed',
        problem: `the warm build of ${identity} failed: ${applied.problem}. Its record stays; the next pass clears it as wreckage and retries.`,
      },
    ];
  }

  // Only now: the commit moves after a successful apply, the inputs with it (so a later
  // destroy can replay them), and the state stays warm — a finished build is claimable.
  const read = await ports.registry.read(repository, identity);
  if (!read.ok || read.record === null) {
    return [
      {
        identity,
        kind: 'failed',
        consumer: false,
        problem: `built ${identity}, but its record could not be read back (${read.ok ? 'gone' : read.reason}) — re-run before anything else`,
      },
    ];
  }
  const updated = await ports.registry.update(repository, identity, read.version, {
    deployedCommit: pool.headCommit,
    url: applied.url,
    deployInputs: Object.keys(inputs.values).length > 0 ? inputs.values : null,
  });
  if (!updated.ok) {
    return [
      {
        identity,
        kind: 'failed',
        consumer: false,
        problem: `built ${identity}, but recording the build was refused (${updated.reason})`,
      },
    ];
  }
  return [{ identity, kind: 'pool-built' }];
}

async function sweepOne(ports: SweepPorts, repository: string, identity: string): Promise<SweepEntry> {
  // The record is read BEFORE the kind check, so a `released` long-running record — a
  // started manual teardown — is completed rather than skipped (feat-006/AC-7, plan D7).
  const read = await ports.registry.read(repository, identity);
  if (!read.ok) {
    return { identity, kind: 'failed', consumer: false, problem: `the record could not be read: ${read.reason}` };
  }
  if (read.record === null) return { identity, kind: 'already-gone' };

  // A `warm` record is the pool's (feat-007): claimable — built, waiting — is left
  // standing; commitless is an interrupted build, and only one build runs per pass, so a
  // commitless slot seen here is wreckage this pass did not make. It falls through to the
  // teardown below, whose release write and protection check hold for it (AC-10).
  if (read.record.state === 'warm' && isClaimable(read.record)) {
    return { identity, kind: 'warm-ready' };
  }

  // An `active` record is eligible only if it is ephemeral AND its pull request is
  // actually closed; the sweep never starts destroying anything else (feat-006/AC-4). A
  // `released` one is a started teardown of whatever kind, and skips both questions (AC-5).
  if (read.record.state === 'active') {
    // For a pooled slot the claimant, not the identity, names the pull request. The
    // claimant is body-derived — safely: it feeds only the question "which pull request
    // do I ask about", and the destroy still targets the key-derived identity, so its
    // blast radius stays the one environment the key already scopes.
    const slotNumber = slotNumberFor(identity);
    const pullRequestNumber = slotNumber !== null ? read.record.claimant : pullRequestNumberFor(identity);
    if (pullRequestNumber === null) {
      if (slotNumber !== null) {
        // Destruction only ever follows a positive "closed" answer, and an unclaimed
        // active slot can give none. Loud, and left for a human (feat-007/AC-10).
        return {
          identity,
          kind: 'failed',
          consumer: false,
          problem: 'an active slot with no recorded claimant — left standing; a human must resolve it',
        };
      }
      return { identity, kind: 'not-ephemeral' };
    }
    const asked = await ports.pullRequests.state(repository, pullRequestNumber);
    if (!asked.ok) {
      return { identity, kind: 'failed', consumer: false, problem: asked.problem };
    }
    if (asked.state === 'open') return { identity, kind: 'left-standing-open' };
  }

  const acquired = await ports.destroyerFor(identity);
  if (!acquired.ok) {
    return { identity, kind: 'failed', consumer: false, problem: acquired.problem };
  }

  const result = await teardownEnvironment(
    { registry: ports.registry, destroyer: acquired.destroyer, store: ports.store, markerRemoval: 'with-record' },
    { repository, identity },
  );
  switch (result.kind) {
    case 'destroyed':
      return { identity, kind: 'destroyed', notes: result.notes };
    case 'nothing':
      return { identity, kind: 'already-gone' };
    case 'left-standing-protected':
      return { identity, kind: 'left-standing-protected' };
    case 'protection-unknown':
      return { identity, kind: 'protection-unknown', problem: result.problem };
    case 'reactivated':
      return { identity, kind: 'reactivated', notes: result.notes };
    case 'failed':
      return { identity, kind: 'failed', consumer: result.consumer, problem: result.problem };
  }
}
