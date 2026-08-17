import type {
  CreateOutcome,
  DeleteOutcome,
  ListOutcome,
  ReadOutcome,
  Store,
  SwapOutcome,
  VersionToken,
} from '../src/core/store.ts';

/**
 * An in-memory `Store` with **strict** conditional-write semantics.
 *
 * Every core test depends on this double, so it is deliberately unhelpful: it refuses
 * exactly what real conditional writes refuse and nothing is smoothed over. A lenient
 * double here would let the registry's logic pass tests it should fail, and the whole
 * point of the fake is to prove the logic is correct *given* that the real store honors
 * these primitives. Whether S3 does is a separate, human-gated verification (task 6.2).
 */

export interface FakeStoreOptions {
  /**
   * When false, every operation reports `container-missing` — the bucket itself is
   * absent, which is a different situation from an empty bucket (AC-4).
   */
  readonly containerExists?: boolean;
  /**
   * Awaited inside every mutating operation *after* its precondition is read but
   * *before* it commits. A test uses this to hold two writes open at once and prove
   * the operation is genuinely atomic rather than accidentally serialized by the
   * event loop.
   */
  readonly beforeCommit?: (key: string) => Promise<void>;
  /**
   * When true, every `read` throws. Used to prove an operation reaches its answer without
   * reading any object — a claim a spy on a call count could only *observe*, where this
   * makes it impossible to be wrong about. The credentials a deploy holds are narrowed to
   * one environment, so "counts without reading" is a correctness property, not a
   * performance one.
   */
  readonly refuseReads?: boolean;
}

interface Entry {
  value: string;
  version: VersionToken;
}

const CONTAINER_MISSING = { ok: false, reason: 'container-missing' } as const;

export class FakeStore implements Store {
  readonly #entries = new Map<string, Entry>();
  readonly #containerExists: boolean;
  readonly #beforeCommit: ((key: string) => Promise<void>) | undefined;
  readonly #refuseReads: boolean;
  #nextVersion = 1;

  constructor(options: FakeStoreOptions = {}) {
    this.#containerExists = options.containerExists ?? true;
    this.#beforeCommit = options.beforeCommit;
    this.#refuseReads = options.refuseReads ?? false;
  }

  async createIfAbsent(key: string, value: string): Promise<CreateOutcome> {
    if (!this.#containerExists) return CONTAINER_MISSING;
    await this.#pause(key);
    // The precondition is checked at commit time, in one synchronous step with the
    // write. That is what makes this a single atomic operation rather than a read
    // followed by a write — and it is why two calls held open together resolve to
    // one winner and one loser instead of both succeeding.
    if (this.#entries.has(key)) return { ok: false, reason: 'already-exists' };
    return { ok: true, version: this.#commit(key, value) };
  }

  async read(key: string): Promise<ReadOutcome> {
    if (this.#refuseReads) throw new Error(`fake store: read of "${key}" was not permitted`);
    if (!this.#containerExists) return CONTAINER_MISSING;
    const entry = this.#entries.get(key);
    if (entry === undefined) return { ok: true, object: null };
    return { ok: true, object: { value: entry.value, version: entry.version } };
  }

  async compareAndSwap(key: string, value: string, expected: VersionToken): Promise<SwapOutcome> {
    if (!this.#containerExists) return CONTAINER_MISSING;
    await this.#pause(key);
    const entry = this.#entries.get(key);
    if (entry === undefined || entry.version !== expected) {
      // Nothing is written. A refused write must leave no trace at all (AC-6).
      return { ok: false, reason: 'version-mismatch' };
    }
    return { ok: true, version: this.#commit(key, value) };
  }

  async list(prefix: string): Promise<ListOutcome> {
    if (!this.#containerExists) return CONTAINER_MISSING;
    const keys = [...this.#entries.keys()].filter((key) => key.startsWith(prefix)).sort();
    return { ok: true, keys };
  }

  async delete(key: string): Promise<DeleteOutcome> {
    if (!this.#containerExists) return CONTAINER_MISSING;
    await this.#pause(key);
    this.#entries.delete(key);
    return { ok: true };
  }

  // --- test-only inspection -------------------------------------------------

  /** Raw stored bytes at a key, bypassing every outcome type. For assertions only. */
  rawValue(key: string): string | undefined {
    return this.#entries.get(key)?.value;
  }

  /** Every key currently held, sorted. For assertions only. */
  allKeys(): readonly string[] {
    return [...this.#entries.keys()].sort();
  }

  /** Preload an object without going through the conditional-write path. */
  seed(key: string, value: string): VersionToken {
    return this.#commit(key, value);
  }

  #commit(key: string, value: string): VersionToken {
    const version = `v${this.#nextVersion++}`;
    this.#entries.set(key, { value, version });
    return version;
  }

  async #pause(key: string): Promise<void> {
    if (this.#beforeCommit !== undefined) await this.#beforeCommit(key);
  }
}
