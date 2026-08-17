/**
 * One environment's teardown, in the order that keeps every promise at once.
 *
 *   protection → release → re-confirm → destroy → verify empty → delete state
 *   → re-confirm → remove record
 *
 * Two orderings are the requirement, not implementation detail. The record outlives the
 * infrastructure (release first, remove last), so a teardown that dies anywhere leaves a
 * claim-refusing record rather than an untracked environment — the sweep finds it and
 * finishes the job. And the record is re-confirmed before the destroy and before the
 * removal, because a teardown races two different opponents (plan D7): another teardown is
 * a peer — whoever advances, the environment ends gone — but a deploy reactivating a
 * reopened pull request's record must STOP this teardown, or it destroys a live, wanted
 * environment and erases the record out from under it (AC-14).
 *
 * The re-confirmation signal is the record's state, not a version: a `released` record is
 * a started teardown whoever started it, while `active` means a deploy took the name back.
 *
 * Nothing in this file names a cloud, a CI host, or an infrastructure-as-code tool
 * (constitution, provider-agnostic core); it runs against ports and is tested with fakes.
 */

import type { EnvironmentDestroyer } from './ports.ts';
import type { Registry } from './registry.ts';
import { stateDirFor } from './registry.ts';
import type { Store } from './store.ts';

export interface TeardownPorts {
  readonly registry: Registry;
  readonly destroyer: EnvironmentDestroyer;
  /** Where the environment's stored infrastructure state is deleted from. */
  readonly store: Store;
  /**
   * How removing the record disposes of the protection marker. The sweep removes both
   * (`with-record`); the close fast path holds credentials the cloud refuses everything
   * under the protection prefix, so it removes the record alone (`record-only`) — safe
   * because a marked environment never gets this far (plan D6).
   */
  readonly markerRemoval: 'with-record' | 'record-only';
}

export interface TeardownRequest {
  readonly repository: string;
  /**
   * From the trigger or the registry key, NEVER from a record's body — a body is
   * writable by the run that owns it (plan D2, the identity invariant).
   */
  readonly identity: string;
}

export type TeardownResult =
  /** The environment is gone and its name is free. */
  | { readonly kind: 'destroyed'; readonly notes: readonly string[] }
  /** No record exists: nothing to tear down, nothing was written. */
  | { readonly kind: 'nothing' }
  /** A protection marker is present. Policy honored, not a failure. */
  | { readonly kind: 'left-standing-protected' }
  /**
   * Protection could not be determined, so nothing was destroyed. The close fast path
   * lands here until its credentials may read protection marks (plan D3): failing closed
   * is the only safe reading of an unreadable marker. The sweep still cleans up.
   */
  | { readonly kind: 'protection-unknown'; readonly problem: string }
  /**
   * A deploy took the record back mid-teardown (the pull request reopened). The
   * environment is left to the deploy; if the destroy had already run, the deploy
   * rebuilds from empty state (the spec's destroy-then-recreate sharp edge).
   */
  | { readonly kind: 'reactivated'; readonly notes: readonly string[] }
  | {
      readonly kind: 'failed';
      /** True when the consuming repository's own destroy failed — a different exit status. */
      readonly consumer: boolean;
      readonly problem: string;
    };

export async function teardownEnvironment(
  ports: TeardownPorts,
  request: TeardownRequest,
): Promise<TeardownResult> {
  const { repository, identity } = request;
  const { registry } = ports;

  // Nothing there is nothing to do — checked before protection so a close event for a
  // pull request that never deployed succeeds without touching the protection prefix.
  const initial = await registry.read(repository, identity);
  if (!initial.ok) {
    return { kind: 'failed', consumer: false, problem: `the registry could not be read: ${initial.reason}` };
  }
  if (initial.record === null) return { kind: 'nothing' };

  // Protection, before anything changes — and only for an `active` record. The mark is
  // honored before release, never after: a `released` record is a started teardown, and
  // completing one is never blocked by a mark, however a stray mark came to sit on it
  // (feat-006/AC-7; gap-001 was a protect racing a release into exactly that state and
  // wedging the sweep). An error here is not "unprotected": the fast path's credentials
  // are refused the read entirely, and treating a refusal as absence would destroy
  // exactly what the marker exists to keep (plan D3's fail-closed fallback).
  if (initial.record.state === 'active') {
    let isProtected: boolean;
    try {
      const protection = await registry.isProtected(repository, identity);
      if (!protection.ok) {
        return { kind: 'failed', consumer: false, problem: `protection could not be read: ${protection.reason}` };
      }
      isProtected = protection.isProtected;
    } catch (error) {
      return {
        kind: 'protection-unknown',
        problem:
          `protection for ${identity} could not be determined ` +
          `(${error instanceof Error ? error.message : String(error)}); destroying nothing. ` +
          'The scheduled sweep, whose credentials read protection marks, will tear this down.',
      };
    }
    if (isProtected) return { kind: 'left-standing-protected' };
  }

  // Release: from here, claims on the name are refused as awaiting teardown. A CAS loss
  // is not a failure — re-read to see who moved it and what that means.
  if (initial.record.state === 'active') {
    const released = await registry.release(repository, identity, initial.version);
    if (!released.ok) {
      if (released.reason === 'not-found') return { kind: 'nothing' };
      if (released.reason === 'stale' || released.reason === 'contended') {
        const again = await registry.read(repository, identity);
        if (!again.ok) {
          return { kind: 'failed', consumer: false, problem: `the registry could not be read: ${again.reason}` };
        }
        if (again.record === null) return { kind: 'nothing' };
        // Moved and still active: a deploy wrote it (a refresh, a reactivation). The
        // environment is in use; this teardown's trigger is out of date.
        if (again.record.state === 'active') return { kind: 'reactivated', notes: [] };
        // A peer released it; carry on advancing.
      } else {
        return { kind: 'failed', consumer: false, problem: `could not release ${identity}: ${released.reason}` };
      }
    }
  }

  // Re-confirm before the destroy (plan D6 step 3).
  const beforeDestroy = await reconfirm(registry, repository, identity);
  if (beforeDestroy === 'gone') return { kind: 'nothing' };
  if (beforeDestroy === 'reactivated') return { kind: 'reactivated', notes: [] };
  if (beforeDestroy !== 'proceed') return beforeDestroy;

  // The recorded inputs ride along, read from the record at entry: they change only when
  // a deploy lands, and a deploy landing after that read is a reactivation this teardown
  // stops for anyway (chg-001, AC-15).
  const destroyed = await ports.destroyer.destroy({
    repository,
    identity,
    deployInputs: initial.record.deployInputs,
  });
  if (!destroyed.ok) {
    return {
      kind: 'failed',
      consumer: destroyed.reason === 'consumer-destroy-failed',
      problem: destroyed.problem,
    };
  }

  // Verify empty before deleting anything (plan D6 step 4). A destroy that exited
  // cleanly over a state still naming resources is a phantom success; deleting the
  // state and record after it would mint an orphan with no registry trace.
  const residual = await ports.destroyer.residualResources({ repository, identity });
  if (!residual.ok) {
    return { kind: 'failed', consumer: false, problem: `could not verify the destroy emptied ${identity}: ${residual.problem}` };
  }
  if (!residual.empty) {
    return {
      kind: 'failed',
      consumer: false,
      problem:
        `the destroy of ${identity} reported success but its state still names resources — ` +
        'a possible orphan. Nothing was deleted; the record stays and refuses the name. ' +
        'The next sweep pass retries.',
    };
  }

  const stateRemoved = await removeStoredState(ports.store, repository, identity);
  if (stateRemoved !== null) {
    return { kind: 'failed', consumer: false, problem: stateRemoved };
  }

  // Re-confirm before the removal (plan D6 step 5). If the destroy ran and a deploy has
  // since taken the record back, the record is the deploy's now — the state deleted
  // above was the empty post-destroy state, and the deploy applies from nothing.
  const beforeRemoval = await reconfirm(registry, repository, identity);
  if (beforeRemoval === 'gone') {
    return { kind: 'destroyed', notes: ['a concurrent teardown removed the record first'] };
  }
  if (beforeRemoval === 'reactivated') {
    return {
      kind: 'reactivated',
      notes: [
        'the infrastructure was destroyed before the reactivation was observed; ' +
          'the reactivating deploy rebuilds from empty state',
      ],
    };
  }
  if (beforeRemoval !== 'proceed') return beforeRemoval;

  // Narrow window, consciously accepted at prototype depth (backlog: a conditional
  // delete on the store would close it): a reactivation landing between the re-confirm
  // above and this delete removes the deploy's record; the deploy then fails loudly at
  // its own final record update and says to re-run.
  const removed =
    ports.markerRemoval === 'with-record'
      ? await ports.registry.remove(repository, identity)
      : await ports.registry.removeRecord(repository, identity);
  if (!removed.ok) {
    return { kind: 'failed', consumer: false, problem: `the record of ${identity} could not be removed: ${removed.reason}` };
  }
  return { kind: 'destroyed', notes: [] };
}

type Reconfirm = 'proceed' | 'gone' | 'reactivated' | Extract<TeardownResult, { kind: 'failed' }>;

async function reconfirm(registry: Registry, repository: string, identity: string): Promise<Reconfirm> {
  const read = await registry.read(repository, identity);
  if (!read.ok) {
    return { kind: 'failed', consumer: false, problem: `the registry could not be read: ${read.reason}` };
  }
  if (read.record === null) return 'gone';
  return read.record.state === 'active' ? 'reactivated' : 'proceed';
}

/** Deletes every stored-state object of one environment. Null on success, a problem otherwise. */
async function removeStoredState(store: Store, repository: string, identity: string): Promise<string | null> {
  const prefix = stateDirFor(repository, identity);
  const listed = await store.list(prefix);
  if (!listed.ok) return `the stored state of ${identity} could not be listed: ${listed.reason}`;
  for (const key of listed.keys) {
    const deleted = await store.delete(key);
    if (!deleted.ok) return `the stored state of ${identity} could not be deleted: ${deleted.reason}`;
  }
  return null;
}
