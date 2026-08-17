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

import { pullRequestNumberFor } from './identity.ts';
import type { EnvironmentDestroyer, PullRequestStateSource } from './ports.ts';
import type { Registry } from './registry.ts';
import type { Store } from './store.ts';
import { teardownEnvironment } from './teardown.ts';

export type DestroyerAcquisition =
  | { readonly ok: true; readonly destroyer: EnvironmentDestroyer }
  | { readonly ok: false; readonly problem: string };

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
  return { kind: 'swept', entries };
}

async function sweepOne(ports: SweepPorts, repository: string, identity: string): Promise<SweepEntry> {
  // The record is read BEFORE the kind check, so a `released` long-running record — a
  // started manual teardown — is completed rather than skipped (feat-006/AC-7, plan D7).
  const read = await ports.registry.read(repository, identity);
  if (!read.ok) {
    return { identity, kind: 'failed', consumer: false, problem: `the record could not be read: ${read.reason}` };
  }
  if (read.record === null) return { identity, kind: 'already-gone' };

  // An `active` record is eligible only if it is ephemeral AND its pull request is
  // actually closed; the sweep never starts destroying anything else (feat-006/AC-4). A
  // `released` one is a started teardown of whatever kind, and skips both questions (AC-5).
  if (read.record.state === 'active') {
    const pullRequestNumber = pullRequestNumberFor(identity);
    if (pullRequestNumber === null) return { identity, kind: 'not-ephemeral' };
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
