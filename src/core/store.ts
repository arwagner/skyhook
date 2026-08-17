/**
 * The storage seam. Deliberately narrow — the conditional-write primitives and
 * nothing else — because every method here is one a future non-AWS adapter must
 * implement (plan D6).
 *
 * The store holds opaque strings. Serializing a record is the registry's job, not
 * the store's, which is what keeps this interface implementable over anything that
 * offers compare-and-set on a key.
 *
 * Nothing in this file, or anything it imports, may name a provider.
 */

/**
 * Opaque handle to one version of a stored object, produced by the store and only
 * ever handed back to it. Deliberately not called an etag: that is one adapter's
 * spelling of the idea, not the idea.
 */
export type VersionToken = string;

export interface StoredObject {
  readonly value: string;
  readonly version: VersionToken;
}

/**
 * The container (bucket) is missing entirely. Distinct from "the key is missing":
 * skyhook never creates the container, because the bootstrap Terraform owns it and
 * creating it behind Terraform's back leaves Terraform with a resource absent from
 * its state (plan D3). Every operation can report it, and the only correct response
 * is to stop and name the container.
 */
export type ContainerMissing = { readonly ok: false; readonly reason: 'container-missing' };

/**
 * Outcomes are returned, never thrown, so a lost race is a value the caller must
 * handle rather than an exception it may forget to catch (AC-5).
 */
/**
 * The store kept colliding with other writers on this key and gave up before establishing
 * anything. Deliberately NOT the same as "the precondition failed": nothing is known about
 * whether the key is occupied, so reporting it as occupied would refuse a name that may well be
 * free. The caller should try again rather than conclude anything.
 */
export type Contended = { readonly ok: false; readonly reason: 'contended' };

export type CreateOutcome =
  | { readonly ok: true; readonly version: VersionToken }
  /** An object already occupies the key. Nothing was written. */
  | { readonly ok: false; readonly reason: 'already-exists' }
  | Contended
  | ContainerMissing;

export type SwapOutcome =
  | { readonly ok: true; readonly version: VersionToken }
  /** The object changed since it was read. Nothing was written (AC-6). */
  | { readonly ok: false; readonly reason: 'version-mismatch' }
  | Contended
  | ContainerMissing;

export type ReadOutcome =
  /** `object` is null when the container exists but holds nothing at this key. */
  | { readonly ok: true; readonly object: StoredObject | null }
  | ContainerMissing;

export type ListOutcome =
  | { readonly ok: true; readonly keys: readonly string[] }
  | ContainerMissing;

export type DeleteOutcome =
  /** Deleting a key that does not exist succeeds: the postcondition already holds. */
  | { readonly ok: true }
  | ContainerMissing;

export interface Store {
  /**
   * Write `value` at `key` only if nothing is there. This is the atomicity primitive
   * the whole feature rests on: claiming an environment is mutual exclusion on a name,
   * and this is what makes it one operation rather than a read followed by a write.
   */
  createIfAbsent(key: string, value: string): Promise<CreateOutcome>;

  read(key: string): Promise<ReadOutcome>;

  /**
   * Replace the object at `key` only if it is still at `expected`. A write made
   * against a stale read is refused and leaves no trace (AC-6).
   */
  compareAndSwap(key: string, value: string, expected: VersionToken): Promise<SwapOutcome>;

  /** Every key under `prefix`. */
  list(prefix: string): Promise<ListOutcome>;

  delete(key: string): Promise<DeleteOutcome>;
}
