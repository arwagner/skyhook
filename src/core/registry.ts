/**
 * The registry: skyhook's durable record of which environments exist, what code is
 * deployed to each, and what state each is in.
 *
 * The registry is not one document. Each environment is one object under its own key,
 * which is what makes an atomic claim fall out of the store rather than being built on
 * top of it, and what means two runs claiming *different* environments never contend
 * at all (plan D2).
 */

import type { EnvironmentRecord, EnvironmentState } from './types.ts';
import type { Store, VersionToken } from './store.ts';

const REPOSITORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const REGISTRY_PREFIX = 'registry/';
export const STATE_PREFIX = 'state/';
export const PROTECTION_PREFIX = 'protected/';

/**
 * Key derivation is security-relevant, not merely tidy: the pull-request role's
 * permissions are expressed as a key prefix, so an identity able to escape its prefix
 * would walk straight through that boundary. Invalid input throws rather than
 * returning a best-effort key — there is no safe fallback to degrade to.
 */
function requireValidComponents(repository: string, identity: string): void {
  if (!REPOSITORY_PATTERN.test(repository)) {
    throw new TypeError(`invalid repository "${repository}": expected "owner/name"`);
  }
  if (!IDENTITY_PATTERN.test(identity)) {
    throw new TypeError(
      `invalid environment identity "${identity}": expected letters, digits, ".", "_" or "-"`,
    );
  }
}

/** Where one environment's record lives. Repository is a path segment, so two repos may hold the same identity (AC-12). */
export function registryKeyFor(repository: string, identity: string): string {
  requireValidComponents(repository, identity);
  return `${REGISTRY_PREFIX}${repository}/${identity}.json`;
}

/**
 * Where one environment's infrastructure state lives — the directory, not the file.
 *
 * Core deliberately stops at the directory. What the state file inside it is *called* is a
 * property of the infrastructure-as-code tool, and naming it here would special-case that tool by
 * name in the one place that must not (constitution, "provider-agnostic core"; plan D6). The
 * Terraform adapter appends its own filename; a second tool appends a different one, without
 * reaching into core to do it.
 *
 * Uniqueness — no two environments sharing state (AC-7) — is established here, because it follows
 * from the identity and not from the tool.
 */
export function stateDirFor(repository: string, identity: string): string {
  requireValidComponents(repository, identity);
  return `${STATE_PREFIX}${repository}/${identity}/`;
}

/**
 * Protection lives at its own key, never as a field on the environment record — a
 * bucket policy restricts which *keys* a role may write and cannot inspect what is
 * inside one, so this separation is what converts "skyhook's code refuses it" into
 * "the cloud refuses it" (plan D2a, AC-15).
 */
export function protectionKeyFor(repository: string, identity: string): string {
  requireValidComponents(repository, identity);
  return `${PROTECTION_PREFIX}${repository}/${identity}`;
}

/** Every registry key belonging to one repository. */
export function registryPrefixFor(repository: string): string {
  if (!REPOSITORY_PATTERN.test(repository)) {
    throw new TypeError(`invalid repository "${repository}": expected "owner/name"`);
  }
  return `${REGISTRY_PREFIX}${repository}/`;
}

/** Recovers the identity from a registry key, or null if the key is not one. */
export function identityFromRegistryKey(repository: string, key: string): string | null {
  const prefix = registryPrefixFor(repository);
  if (!key.startsWith(prefix) || !key.endsWith('.json')) return null;
  const identity = key.slice(prefix.length, -'.json'.length);
  return IDENTITY_PATTERN.test(identity) ? identity : null;
}

// --- record serialization ---------------------------------------------------

/**
 * The stored shape is versioned from the first write. Every later feature reads this
 * record, so changing it once environments exist means migrating live data — the spec
 * calls it close to a one-way door. A version field is the cheapest thing that keeps
 * the door ajar.
 */
export const RECORD_SCHEMA_VERSION = 1;

function serialize(record: EnvironmentRecord): string {
  return JSON.stringify({ schemaVersion: RECORD_SCHEMA_VERSION, ...record }, null, 2);
}

/**
 * Reads only the fields the record is defined to have. Anything else in the stored
 * object — notably a `protected` field a tampering run might have written — is not
 * read, and so cannot be honored (AC-15).
 */
function deserialize(json: string): EnvironmentRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const candidate = parsed as Record<string, unknown>;
  const { repository, identity, state, deployedCommit, createdAt, updatedAt } = candidate;
  if (typeof repository !== 'string' || repository === '') return null;
  if (typeof identity !== 'string' || identity === '') return null;
  if (state !== 'active' && state !== 'released') return null;
  if (deployedCommit !== null && typeof deployedCommit !== 'string') return null;
  if (typeof createdAt !== 'string' || typeof updatedAt !== 'string') return null;
  // Absent means null, not invalid: records written before the field existed must still
  // read (AC-28). Anything present but not a string is discarded rather than refused —
  // an unusable address is the same as no address, and refusing the whole record would
  // hide an environment that still needs tearing down.
  const rawUrl = candidate['url'];
  const url = typeof rawUrl === 'string' && rawUrl !== '' ? rawUrl : null;
  return { repository, identity, state, deployedCommit, url, createdAt, updatedAt };
}

// --- outcomes ---------------------------------------------------------------

export interface ClaimRequest {
  readonly repository: string;
  readonly identity: string;
  readonly deployedCommit?: string | null;
}

export type ClaimOutcome =
  | { readonly ok: true; readonly record: EnvironmentRecord; readonly version: VersionToken }
  | {
      readonly ok: false;
      readonly reason:
        /** A record exists and is `active`: the environment is in use. */
        | 'held'
        /** A record exists and is `released`: the infrastructure is still standing. */
        | 'awaiting-teardown'
        | 'container-missing'
        | 'corrupt-record'
        /** The record kept appearing and vanishing under us. Retry the run. */
        | 'contended';
    };

export type ReadRecordOutcome =
  | { readonly ok: true; readonly record: EnvironmentRecord; readonly version: VersionToken }
  | { readonly ok: true; readonly record: null; readonly version: null }
  | { readonly ok: false; readonly reason: 'container-missing' | 'corrupt-record' };

export type UpdateOutcome =
  | { readonly ok: true; readonly record: EnvironmentRecord; readonly version: VersionToken }
  | {
      readonly ok: false;
      readonly reason:
        /** The record changed since it was read. Nothing was written (AC-6). */
        | 'stale'
        /** The store kept colliding and established nothing. Unknown, not refused — try again. */
        | 'contended'
        | 'container-missing'
        | 'corrupt-record'
        | 'not-found';
    };

export type ListOutcome =
  | { readonly ok: true; readonly records: readonly EnvironmentRecord[] }
  | { readonly ok: false; readonly reason: 'container-missing' | 'corrupt-record' };

export type CountOutcome =
  | { readonly ok: true; readonly count: number }
  | { readonly ok: false; readonly reason: 'container-missing' | 'corrupt-record' };

export type ProtectionOutcome =
  | { readonly ok: true; readonly isProtected: boolean }
  | { readonly ok: false; readonly reason: 'container-missing' };

export type RemoveOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'container-missing' };

export interface RegistryOptions {
  /** Injected so tests are deterministic. Returns an ISO-8601 UTC timestamp. */
  readonly now?: () => string;
}

export interface RecordChanges {
  readonly state?: EnvironmentState;
  readonly deployedCommit?: string | null;
  readonly url?: string | null;
}

/** How many times a claim retries when the record vanishes between create and read. */
const CLAIM_ATTEMPTS = 3;

export class Registry {
  readonly #store: Store;
  readonly #now: () => string;

  constructor(store: Store, options: RegistryOptions = {}) {
    this.#store = store;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  /**
   * Mutual exclusion on an environment name. This is create-if-absent with no state
   * machine on top: an existing record refuses the claim regardless of its state
   * (plan D2b). Reusing a `released` record would hand a name to a new run while the
   * old infrastructure is still standing, possibly mid-teardown.
   */
  async claim(request: ClaimRequest): Promise<ClaimOutcome> {
    const { repository, identity } = request;
    const key = registryKeyFor(repository, identity);

    for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt += 1) {
      const timestamp = this.#now();
      const record: EnvironmentRecord = {
        repository,
        identity,
        state: 'active',
        deployedCommit: request.deployedCommit ?? null,
        // A claim precedes the infrastructure, so there is no address yet by construction.
        url: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      const created = await this.#store.createIfAbsent(key, serialize(record));
      if (created.ok) return { ok: true, record, version: created.version };
      if (created.reason === 'container-missing') return { ok: false, reason: 'container-missing' };
      // The store already retried and still established nothing. Reporting `held` here would
      // refuse a name that may well be free — the caller should try again, not give up on it.
      if (created.reason === 'contended') return { ok: false, reason: 'contended' };

      // Something is already there. Read it to say *which* refusal this is (AC-16).
      const existing = await this.read(repository, identity);
      if (!existing.ok) return { ok: false, reason: existing.reason };
      if (existing.record === null) continue; // torn down between the two calls; try again
      return {
        ok: false,
        reason: existing.record.state === 'active' ? 'held' : 'awaiting-teardown',
      };
    }
    return { ok: false, reason: 'contended' };
  }

  async read(repository: string, identity: string): Promise<ReadRecordOutcome> {
    const outcome = await this.#store.read(registryKeyFor(repository, identity));
    if (!outcome.ok) return { ok: false, reason: 'container-missing' };
    if (outcome.object === null) return { ok: true, record: null, version: null };
    const record = deserialize(outcome.object.value);
    if (record === null) return { ok: false, reason: 'corrupt-record' };
    return { ok: true, record, version: outcome.object.version };
  }

  /**
   * Applies `changes` only if the record is still at `expectedVersion`. A write made
   * against a stale read is refused and leaves the stored record untouched (AC-6).
   */
  async update(
    repository: string,
    identity: string,
    expectedVersion: VersionToken,
    changes: RecordChanges,
  ): Promise<UpdateOutcome> {
    const current = await this.read(repository, identity);
    if (!current.ok) return { ok: false, reason: current.reason };
    if (current.record === null) return { ok: false, reason: 'not-found' };
    if (current.version !== expectedVersion) return { ok: false, reason: 'stale' };

    const next: EnvironmentRecord = {
      ...current.record,
      ...(changes.state !== undefined ? { state: changes.state } : {}),
      ...(changes.deployedCommit !== undefined ? { deployedCommit: changes.deployedCommit } : {}),
      ...(changes.url !== undefined ? { url: changes.url } : {}),
      updatedAt: this.#now(),
    };
    const swapped = await this.#store.compareAndSwap(
      registryKeyFor(repository, identity),
      serialize(next),
      expectedVersion,
    );
    if (!swapped.ok) {
      // Mapped explicitly rather than collapsed: `contended` means the write may not have been
      // attempted at all, which is a retry, whereas `stale` means it was refused for a reason.
      if (swapped.reason === 'container-missing') return { ok: false, reason: 'container-missing' };
      if (swapped.reason === 'contended') return { ok: false, reason: 'contended' };
      return { ok: false, reason: 'stale' };
    }
    return { ok: true, record: next, version: swapped.version };
  }

  /** Marks the environment eligible for teardown. It is not yet torn down, and its name is not yet free. */
  async release(
    repository: string,
    identity: string,
    expectedVersion: VersionToken,
  ): Promise<UpdateOutcome> {
    return this.update(repository, identity, expectedVersion, { state: 'released' });
  }

  async list(repository: string): Promise<ListOutcome> {
    const listed = await this.#store.list(registryPrefixFor(repository));
    if (!listed.ok) return { ok: false, reason: 'container-missing' };

    const records: EnvironmentRecord[] = [];
    for (const key of listed.keys) {
      if (identityFromRegistryKey(repository, key) === null) continue;
      const read = await this.#store.read(key);
      if (!read.ok) return { ok: false, reason: 'container-missing' };
      if (read.object === null) continue; // deleted between the list and the read
      const record = deserialize(read.object.value);
      // Skipping an unreadable record would undercount the cap and over-provision.
      // A silent failure and a success look exactly alike until the bill arrives.
      if (record === null) return { ok: false, reason: 'corrupt-record' };
      records.push(record);
    }
    return { ok: true, records };
  }

  /**
   * How many environments are in use. The sweep's question — it needs the state, so it
   * reads every record, and it runs with credentials that may (AC-10).
   */
  async countActive(repository: string): Promise<CountOutcome> {
    const listed = await this.list(repository);
    if (!listed.ok) return { ok: false, reason: listed.reason };
    return { ok: true, count: listed.records.filter((r) => r.state === 'active').length };
  }

  /**
   * How many environments this repository holds at all — the cap's question (AC-10).
   *
   * **This must not read any record**, and that is a correctness requirement rather than
   * an optimization. A deploy's credentials are narrowed to its own environment, so
   * `countActive` — which reads every record to see its state — is refused by the cloud on
   * the second object it touches, and the cap check fails looking like a broken registry.
   * Counting keys is the only count such a caller can obtain.
   *
   * Counting keys is also the truer measure for a cap. A record lives exactly as long as
   * its environment (plan D2b), so a `released` environment is still standing in the
   * account and still costing money. What this deliberately is *not* is the number of
   * environments successfully built: a record is written before its infrastructure exists,
   * so the count can exceed what stood up. Over-counting is the safe direction for a cap.
   */
  async countEnvironments(repository: string): Promise<CountOutcome> {
    const listed = await this.#store.list(registryPrefixFor(repository));
    if (!listed.ok) return { ok: false, reason: 'container-missing' };
    const count = listed.keys.filter(
      (key) => identityFromRegistryKey(repository, key) !== null,
    ).length;
    return { ok: true, count };
  }

  /**
   * Every identity this repository holds, recovered from the registry KEYS alone.
   *
   * The sweep iterates these rather than `list()`'s records because a record's body is
   * writable by the run that owns it: an identity read from inside one could be made to
   * claim a different environment and steer a destroy at it. A key cannot — the store's
   * permissions are expressed over keys (feat-003 plan D2, the identity invariant).
   */
  async listIdentities(
    repository: string,
  ): Promise<
    | { readonly ok: true; readonly identities: readonly string[] }
    | { readonly ok: false; readonly reason: 'container-missing' }
  > {
    const listed = await this.#store.list(registryPrefixFor(repository));
    if (!listed.ok) return { ok: false, reason: 'container-missing' };
    const identities = listed.keys
      .map((key) => identityFromRegistryKey(repository, key))
      .filter((identity): identity is string => identity !== null);
    return { ok: true, identities };
  }

  /**
   * Protection is read from its own key and nowhere else, so a `protected` field
   * appearing inside an environment record has no effect (AC-15).
   */
  async isProtected(repository: string, identity: string): Promise<ProtectionOutcome> {
    const outcome = await this.#store.read(protectionKeyFor(repository, identity));
    if (!outcome.ok) return { ok: false, reason: 'container-missing' };
    return { ok: true, isProtected: outcome.object !== null };
  }

  async setProtected(
    repository: string,
    identity: string,
    isProtected: boolean,
  ): Promise<ProtectionOutcome> {
    const key = protectionKeyFor(repository, identity);
    if (!isProtected) {
      const deleted = await this.#store.delete(key);
      if (!deleted.ok) return { ok: false, reason: 'container-missing' };
      return { ok: true, isProtected: false };
    }
    const created = await this.#store.createIfAbsent(key, this.#now());
    if (!created.ok && created.reason === 'container-missing') {
      return { ok: false, reason: 'container-missing' };
    }
    // `already-exists` means it was already protected, which is the state asked for.
    return { ok: true, isProtected: true };
  }

  /**
   * Teardown. The record and its protection marker go together, and that deletion is
   * what frees the name (AC-16). A marker left behind would silently attach to the
   * next environment claiming the name, which would then never be cleaned up.
   */
  /**
   * Teardown's close fast path: the record alone, marker untouched.
   *
   * Exists because the credentials that path holds are refused everything under the
   * protection prefix — even deleting a marker that does not exist — so `remove()`'s
   * marker deletion would fail every fast-path teardown outright. No orphan marker
   * results from using this: a marked environment never reaches removal (teardown
   * refuses it at the protection check), so the record removed here has no marker.
   */
  async removeRecord(repository: string, identity: string): Promise<RemoveOutcome> {
    const record = await this.#store.delete(registryKeyFor(repository, identity));
    if (!record.ok) return { ok: false, reason: 'container-missing' };
    return { ok: true };
  }

  async remove(repository: string, identity: string): Promise<RemoveOutcome> {
    // Order matters, and only one order is safe. If this stops halfway, deleting the
    // record first leaves an orphan marker — which the spec already classifies as
    // garbage to be collected. Deleting the marker first would leave a record with no
    // protection, and the sweep may then destroy it automatically, which the
    // constitution forbids outright. Take the residue that is merely untidy.
    const record = await this.#store.delete(registryKeyFor(repository, identity));
    if (!record.ok) return { ok: false, reason: 'container-missing' };
    const marker = await this.#store.delete(protectionKeyFor(repository, identity));
    if (!marker.ok) return { ok: false, reason: 'container-missing' };
    return { ok: true };
  }
}
