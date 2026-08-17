import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeStore } from './fake-store.ts';
import {
  Registry,
  isClaimable,
  protectionKeyFor,
  registryKeyFor,
} from '../src/core/registry.ts';

function fixedClock(): () => string {
  let tick = 0;
  return () => `2026-08-14T00:00:${String(tick++).padStart(2, '0')}.000Z`;
}

function makeRegistry(store: FakeStore): Registry {
  return new Registry(store, { now: fixedClock() });
}

const REPO = 'acme/widgets';

// --- claim ------------------------------------------------------------------

test('feat-001/AC-5 two concurrent claims of one identity: exactly one wins', async () => {
  // AC-5: two concurrent attempts to claim the same identity result in exactly one
  // success; the loser returns a result distinguishable from any other failure.
  // Both claims are held open inside the store before either commits, so neither can
  // have observed the other — this is contention, not two sequential calls.
  let release = (): void => {};
  const parked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let arrived = 0;
  const store = new FakeStore({
    beforeCommit: async () => {
      arrived += 1;
      if (arrived <= 2) await parked;
    },
  });
  const registry = makeRegistry(store);

  const both = Promise.all([
    registry.claim({ repository: REPO, identity: 'pr-482' }),
    registry.claim({ repository: REPO, identity: 'pr-482' }),
  ]);
  await Promise.resolve();
  assert.equal(arrived, 2, 'both claims are in flight before either commits');
  release();

  const [first, second] = await both;
  const winners = [first, second].filter((o) => o.ok);
  const losers = [first, second].filter((o) => !o.ok);
  assert.equal(winners.length, 1, 'exactly one claim succeeds');
  assert.equal(losers.length, 1);
  assert.equal(losers[0]?.ok, false);
  if (losers[0]?.ok === false) {
    // A distinct, non-crashing result — not an exception, and not a generic error.
    assert.equal(losers[0].reason, 'held');
  }
  assert.deepEqual(store.allKeys(), [registryKeyFor(REPO, 'pr-482')], 'one record, not two');
});

test('feat-001/AC-5 the losing claim is a typed result, never a thrown exception', async () => {
  const registry = makeRegistry(new FakeStore());
  await registry.claim({ repository: REPO, identity: 'staging' });
  const loser = await registry.claim({ repository: REPO, identity: 'staging' });
  assert.equal(loser.ok, false);
});

test('feat-001/AC-16 a claim against an existing record is refused, and the two states are distinguishable', async () => {
  // AC-16: claiming an identity whose record exists is refused whether that record is
  // active or released, and the two refusals differ from each other.
  const store = new FakeStore();
  const registry = makeRegistry(store);

  await registry.claim({ repository: REPO, identity: 'held-one' });
  const heldAgain = await registry.claim({ repository: REPO, identity: 'held-one' });
  assert.deepEqual(heldAgain, { ok: false, reason: 'held' });

  const claimed = await registry.claim({ repository: REPO, identity: 'released-one' });
  assert.equal(claimed.ok, true);
  if (!claimed.ok) return;
  const released = await registry.release(REPO, 'released-one', claimed.version);
  assert.equal(released.ok, true);

  const releasedAgain = await registry.claim({ repository: REPO, identity: 'released-one' });
  assert.deepEqual(releasedAgain, { ok: false, reason: 'awaiting-teardown' });

  assert.notEqual(
    heldAgain.ok === false ? heldAgain.reason : '',
    releasedAgain.ok === false ? releasedAgain.reason : '',
  );
});

test('feat-001/AC-16 a name becomes claimable only once its record is deleted', async () => {
  const store = new FakeStore();
  const registry = makeRegistry(store);

  const claimed = await registry.claim({ repository: REPO, identity: 'pr-9' });
  assert.equal(claimed.ok, true);
  if (!claimed.ok) return;
  await registry.release(REPO, 'pr-9', claimed.version);

  assert.equal((await registry.claim({ repository: REPO, identity: 'pr-9' })).ok, false);

  await registry.remove(REPO, 'pr-9');
  assert.equal((await registry.claim({ repository: REPO, identity: 'pr-9' })).ok, true);
});

test('feat-001/AC-12 the same identity in two repositories both succeed', async () => {
  const registry = makeRegistry(new FakeStore());
  const one = await registry.claim({ repository: 'acme/widgets', identity: 'staging' });
  const other = await registry.claim({ repository: 'acme/gadgets', identity: 'staging' });
  assert.equal(one.ok, true);
  assert.equal(other.ok, true);
  if (!one.ok || !other.ok) return;
  assert.equal(one.record.repository, 'acme/widgets');
  assert.equal(other.record.repository, 'acme/gadgets');
});

test('feat-001/AC-12 every stored record names the repository it belongs to', async () => {
  const store = new FakeStore();
  const registry = makeRegistry(store);
  await registry.claim({ repository: REPO, identity: 'staging' });
  const raw = store.rawValue(registryKeyFor(REPO, 'staging'));
  assert.ok(raw !== undefined);
  assert.equal(JSON.parse(raw).repository, REPO);
});

test('registry: a claim reports the missing bucket rather than inventing one', async () => {
  const store = new FakeStore({ containerExists: false });
  const registry = makeRegistry(store);
  const outcome = await registry.claim({ repository: REPO, identity: 'staging' });
  assert.deepEqual(outcome, { ok: false, reason: 'container-missing' });
  assert.deepEqual(store.allKeys(), []);
});

// --- stale writes -----------------------------------------------------------

test('feat-001/AC-6 a write made against a stale read is refused and leaves no trace', async () => {
  // AC-6: a registry write made against a stale read is refused rather than applied,
  // and no refused write leaves any trace in the stored record.
  const store = new FakeStore();
  const registry = makeRegistry(store);

  const claimed = await registry.claim({ repository: REPO, identity: 'staging' });
  assert.equal(claimed.ok, true);
  if (!claimed.ok) return;
  const staleVersion = claimed.version;

  const first = await registry.update(REPO, 'staging', staleVersion, { deployedCommit: 'aaa111' });
  assert.equal(first.ok, true);

  const before = store.rawValue(registryKeyFor(REPO, 'staging'));
  const second = await registry.update(REPO, 'staging', staleVersion, { deployedCommit: 'bbb222' });
  assert.deepEqual(second, { ok: false, reason: 'stale' });
  assert.equal(store.rawValue(registryKeyFor(REPO, 'staging')), before, 'nothing changed');
});

test('feat-001/AC-6 concurrent registry writes: one succeeds, the other is told it lost', async () => {
  const store = new FakeStore();
  const registry = makeRegistry(store);
  const claimed = await registry.claim({ repository: REPO, identity: 'staging' });
  assert.equal(claimed.ok, true);
  if (!claimed.ok) return;

  // Both runs read the same version, then both write.
  const [a, b] = await Promise.all([
    registry.update(REPO, 'staging', claimed.version, { deployedCommit: 'aaa111' }),
    registry.update(REPO, 'staging', claimed.version, { deployedCommit: 'bbb222' }),
  ]);
  assert.equal([a, b].filter((o) => o.ok).length, 1, 'exactly one write lands');
  assert.equal([a, b].filter((o) => !o.ok).length, 1, 'the other is told, not discarded');
});

// --- listing and the cap ----------------------------------------------------

test('feat-001/AC-10 countActive counts only active environments, scoped to one repository', async () => {
  // AC-10: the store exposes the count of environments currently active to callers
  // that enforce the cap.
  const registry = makeRegistry(new FakeStore());
  const one = await registry.claim({ repository: REPO, identity: 'a' });
  await registry.claim({ repository: REPO, identity: 'b' });
  await registry.claim({ repository: 'acme/gadgets', identity: 'c' });
  assert.equal(one.ok, true);
  if (!one.ok) return;
  await registry.release(REPO, 'a', one.version);

  assert.deepEqual(await registry.countActive(REPO), { ok: true, count: 1 });
  assert.deepEqual(await registry.countActive('acme/gadgets'), { ok: true, count: 1 });
});

test('registry: listing is scoped to one repository and refuses a corrupt record loudly', async () => {
  const store = new FakeStore();
  const registry = makeRegistry(store);
  await registry.claim({ repository: REPO, identity: 'a' });

  const listed = await registry.list(REPO);
  assert.equal(listed.ok, true);
  if (!listed.ok) return;
  assert.equal(listed.records.length, 1);

  // Undercounting silently would over-provision against the cap, so a record that
  // cannot be read is an error rather than a skipped row.
  store.seed(registryKeyFor(REPO, 'broken'), 'not json');
  const broken = await registry.list(REPO);
  assert.equal(broken.ok, false);
});

// --- protection -------------------------------------------------------------

test('feat-001/AC-15 protection is read from its own key, not from the record', async () => {
  // AC-15: protection is stored outside the environment record.
  const store = new FakeStore();
  const registry = makeRegistry(store);
  await registry.claim({ repository: REPO, identity: 'staging' });

  assert.deepEqual(await registry.isProtected(REPO, 'staging'), { ok: true, isProtected: false });

  await registry.setProtected(REPO, 'staging', true);
  assert.deepEqual(await registry.isProtected(REPO, 'staging'), { ok: true, isProtected: true });
  assert.ok(
    store.allKeys().includes(protectionKeyFor(REPO, 'staging')),
    'the mark lives at its own key, which is what lets a bucket policy refuse the write',
  );

  await registry.setProtected(REPO, 'staging', false);
  assert.deepEqual(await registry.isProtected(REPO, 'staging'), { ok: true, isProtected: false });
});

test('feat-001/AC-15 a stray "protected" field on the record is ignored, not honored', async () => {
  // If the record could carry protection, a pull-request run — which is allowed to
  // write its own record — could mark its environment protected. It cannot, because
  // nothing reads the field.
  const store = new FakeStore();
  const registry = makeRegistry(store);
  await registry.claim({ repository: REPO, identity: 'pr-482' });

  const key = registryKeyFor(REPO, 'pr-482');
  const raw = store.rawValue(key);
  assert.ok(raw !== undefined);
  store.seed(key, JSON.stringify({ ...JSON.parse(raw), protected: true }));

  assert.deepEqual(await registry.isProtected(REPO, 'pr-482'), { ok: true, isProtected: false });
});

test('feat-001/AC-15 a halted teardown never leaves a record without its protection marker', async () => {
  // Regression for analyze.md SEC-2. The constitution forbids destroying a protected
  // environment automatically, so a teardown that stops halfway must not leave a
  // record standing with its protection gone — the sweep would then be free to
  // destroy it. An orphan marker is the acceptable residue; the spec already calls
  // that garbage to be collected.
  const store = new FakeStore();
  const registry = makeRegistry(store);
  await registry.claim({ repository: REPO, identity: 'staging' });
  await registry.setProtected(REPO, 'staging', true);

  const deleted: string[] = [];
  const halting = Object.create(store) as FakeStore;
  halting.delete = async (key: string) => {
    deleted.push(key);
    if (deleted.length > 1) return { ok: false, reason: 'container-missing' };
    return store.delete(key);
  };

  const outcome = await new Registry(halting, { now: fixedClock() }).remove(REPO, 'staging');
  assert.equal(outcome.ok, false, 'the halted teardown reports failure rather than success');
  assert.equal(deleted[0], registryKeyFor(REPO, 'staging'), 'the record goes first');
  assert.equal(store.rawValue(registryKeyFor(REPO, 'staging')), undefined);
  assert.deepEqual(
    store.allKeys(),
    [protectionKeyFor(REPO, 'staging')],
    'what survives is an orphan marker, not an unprotected record',
  );
});

test('feat-001/AC-15 a protection marker is deleted together with its record', async () => {
  // A marker left behind would silently attach to the next environment claiming that
  // name, which would then never be cleaned up automatically.
  const store = new FakeStore();
  const registry = makeRegistry(store);
  await registry.claim({ repository: REPO, identity: 'staging' });
  await registry.setProtected(REPO, 'staging', true);

  await registry.remove(REPO, 'staging');
  assert.deepEqual(store.allKeys(), [], 'record and marker go together');
  assert.deepEqual(await registry.isProtected(REPO, 'staging'), { ok: true, isProtected: false });
});

// --- the deploy contract (chg-007) ------------------------------------------

test('feat-001/AC-28 a record carries an environment address, and none before one is known', async () => {
  // AC-28: every record can carry the address at which its environment is reachable,
  // and carries none before one is known. A claim happens before the infrastructure
  // exists, so a freshly claimed record must have no address at all.
  const store = new FakeStore();
  const registry = makeRegistry(store);

  const claimed = await registry.claim({ repository: REPO, identity: 'pr-482' });
  assert.equal(claimed.ok, true);
  assert.equal(claimed.ok && claimed.record.url, null);

  const updated = await registry.update(REPO, 'pr-482', claimed.ok ? claimed.version : '', {
    url: 'https://pr-482.example.test',
  });
  assert.equal(updated.ok, true);

  // Survives a re-read, rather than only existing in the returned value.
  const reread = await registry.read(REPO, 'pr-482');
  assert.equal(reread.ok && reread.record?.url, 'https://pr-482.example.test');
});

test('feat-001/AC-28 a record stored before the address existed reads back with none', async () => {
  // The field is additive. Rejecting a record written by an earlier version would strand
  // every environment the prototype has already recorded — the registry is the only thing
  // that knows they need tearing down.
  const store = new FakeStore();
  store.seed(
    registryKeyFor(REPO, 'staging'),
    JSON.stringify({
      schemaVersion: 1,
      repository: REPO,
      identity: 'staging',
      state: 'active',
      deployedCommit: 'abc123',
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    }),
  );

  const read = await makeRegistry(store).read(REPO, 'staging');
  assert.equal(read.ok, true);
  assert.equal(read.ok && read.record?.url, null);
  assert.equal(read.ok && read.record?.deployedCommit, 'abc123');
});

test('feat-001/AC-10 countEnvironments counts a repository without reading any record', async () => {
  // AC-10: the count a cap enforcer uses is obtained WITHOUT reading any environment's
  // record. A deploy's credentials are narrowed to its own environment, so a count that
  // reads every record cannot run at all — it would be refused by the cloud, and the cap
  // would fail in a way that looks like a broken registry.
  //
  // The store refuses every read, so this passes only if no read is attempted.
  const store = new FakeStore({ refuseReads: true });
  const registry = makeRegistry(store);

  store.seed(registryKeyFor(REPO, 'pr-1'), '{}');
  store.seed(registryKeyFor(REPO, 'pr-2'), '{}');
  store.seed(registryKeyFor(REPO, 'staging'), '{}');
  store.seed(registryKeyFor('acme/gadgets', 'pr-1'), '{}');
  store.seed(protectionKeyFor(REPO, 'staging'), 'marker');

  assert.deepEqual(await registry.countEnvironments(REPO), { ok: true, count: 3 });
  assert.deepEqual(await registry.countEnvironments('acme/gadgets'), { ok: true, count: 1 });
});

test('feat-001/AC-10 countEnvironments counts released environments too', async () => {
  // A record lives exactly as long as its environment does, so a released environment is
  // still standing in the account and still counts against the cap. This is the whole
  // reason the cap does not reuse countActive.
  const store = new FakeStore();
  const registry = makeRegistry(store);

  const first = await registry.claim({ repository: REPO, identity: 'pr-1' });
  await registry.claim({ repository: REPO, identity: 'pr-2' });
  assert.equal(first.ok, true);
  if (first.ok) await registry.release(REPO, 'pr-1', first.version);

  assert.deepEqual(await registry.countActive(REPO), { ok: true, count: 1 });
  assert.deepEqual(await registry.countEnvironments(REPO), { ok: true, count: 2 });
});

test('removeRecord deletes the record alone and never reaches the protection prefix', async () => {
  // The close fast path's credentials are refused every operation under protected/*,
  // even deleting a marker that is not there — so its removal must not attempt one.
  const store = new FakeStore();
  const registry = makeRegistry(store);
  await registry.claim({ repository: REPO, identity: 'pr-9' });
  store.seed(protectionKeyFor(REPO, 'pr-8'), 'a neighbour, untouched');

  const removed = await registry.removeRecord(REPO, 'pr-9');

  assert.deepEqual(removed, { ok: true });
  assert.equal(store.rawValue(registryKeyFor(REPO, 'pr-9')), undefined);
  assert.notEqual(store.rawValue(protectionKeyFor(REPO, 'pr-8')), undefined);
});

// --- declared deploy inputs on the record (chg-011) --------------------------

test('feat-001/AC-36 recorded input values round-trip, and updates replace the whole map', async () => {
  const store = new FakeStore();
  const registry = makeRegistry(store);
  const claimed = await registry.claim({ repository: REPO, identity: 'pr-9' });
  assert.equal(claimed.ok, true);
  if (!claimed.ok) return;
  assert.equal(claimed.record.deployInputs, null, 'a claim precedes any landed deploy');

  const first = await registry.update(REPO, 'pr-9', claimed.version, {
    deployedCommit: 'abc123',
    deployInputs: { image_tag: 'abc123', speech_image: 'ecr/speech:1' },
  });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.deepEqual(first.record.deployInputs, {
    image_tag: 'abc123',
    speech_image: 'ecr/speech:1',
  });

  // Wholesale replace: a name no longer declared does not linger from an earlier deploy.
  const second = await registry.update(REPO, 'pr-9', first.version, {
    deployedCommit: 'def456',
    deployInputs: { image_tag: 'def456' },
  });
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.deepEqual(second.record.deployInputs, { image_tag: 'def456' });

  const read = await registry.read(REPO, 'pr-9');
  assert.equal(read.ok, true);
  if (!read.ok || read.record === null) return;
  assert.deepEqual(read.record.deployInputs, { image_tag: 'def456' });
});

test('feat-001/AC-36 a record written before the field existed reads back with none recorded', async () => {
  const store = new FakeStore();
  // The literal stored shape of a pre-chg-011 record, seeded byte-for-byte rather than
  // written through today's serializer, so this proves the reader and not the writer.
  store.seed(
    registryKeyFor(REPO, 'pr-old'),
    JSON.stringify({
      schemaVersion: 1,
      repository: REPO,
      identity: 'pr-old',
      state: 'active',
      deployedCommit: 'aaa111',
      url: 'https://old.example',
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    }),
  );
  const registry = makeRegistry(store);
  const read = await registry.read(REPO, 'pr-old');
  assert.equal(read.ok, true);
  if (!read.ok || read.record === null) return;
  assert.equal(read.record.deployInputs, null);
  assert.equal(read.record.url, 'https://old.example', 'the rest of the record is untouched');
});

// --- redaction (chg-011, AC-37) ----------------------------------------------

test('feat-001/AC-37 redacting one value removes it and touches nothing else', async () => {
  const store = new FakeStore();
  const registry = makeRegistry(store);
  const claimed = await registry.claim({ repository: REPO, identity: 'pr-9' });
  assert.equal(claimed.ok, true);
  if (!claimed.ok) return;
  const updated = await registry.update(REPO, 'pr-9', claimed.version, {
    deployedCommit: 'abc123',
    url: 'https://pr-9.example',
    deployInputs: { image_tag: 'abc123', oops_conn: 'postgres://user:pw@host/db' },
  });
  assert.equal(updated.ok, true);
  if (!updated.ok) return;

  const redacted = await registry.redactInput(REPO, 'pr-9', 'oops_conn');
  assert.equal(redacted.ok, true);

  const read = await registry.read(REPO, 'pr-9');
  assert.equal(read.ok, true);
  if (!read.ok || read.record === null) return;
  assert.deepEqual(read.record.deployInputs, { image_tag: 'abc123' });
  assert.equal(read.record.state, 'active', 'redaction changes content, never state');
  assert.equal(read.record.deployedCommit, 'abc123');
  assert.equal(read.record.url, 'https://pr-9.example');
  assert.ok(
    !(store.rawValue(registryKeyFor(REPO, 'pr-9')) ?? '').includes('postgres://'),
    'the redacted value is gone from the stored bytes, not merely hidden from readers',
  );
});

test('feat-001/AC-37 redacting a name that is not recorded succeeds as a no-op', async () => {
  const store = new FakeStore();
  const registry = makeRegistry(store);
  const claimed = await registry.claim({ repository: REPO, identity: 'pr-9' });
  assert.equal(claimed.ok, true);
  const outcome = await registry.redactInput(REPO, 'pr-9', 'never_recorded');
  assert.equal(outcome.ok, true, 'already-absent is the state asked for');
});

test('feat-001/AC-37 redaction retries a lost race instead of failing or clobbering', async () => {
  // A concurrent writer bumps the record between redaction's read and its swap. The
  // redact must retry on the fresh version — never overwrite the concurrent write, and
  // never give up on the first collision.
  const store = new FakeStore();
  const registry = makeRegistry(store);
  const claimed = await registry.claim({ repository: REPO, identity: 'pr-9' });
  assert.equal(claimed.ok, true);
  if (!claimed.ok) return;
  const updated = await registry.update(REPO, 'pr-9', claimed.version, {
    deployInputs: { image_tag: 'abc123', oops: 'sensitive' },
  });
  assert.equal(updated.ok, true);
  if (!updated.ok) return;

  let interfered = false;
  const key = registryKeyFor(REPO, 'pr-9');
  // Delegates everything to the real fake, but the first swap loses: an interloper
  // rewrites the record just before it, so the redact's expected version is stale.
  const racingStore: typeof store = Object.assign(Object.create(null), {
    createIfAbsent: store.createIfAbsent.bind(store),
    read: store.read.bind(store),
    list: store.list.bind(store),
    delete: store.delete.bind(store),
    rawValue: store.rawValue.bind(store),
    allKeys: store.allKeys.bind(store),
    seed: store.seed.bind(store),
    compareAndSwap: async (...args: Parameters<FakeStore['compareAndSwap']>) => {
      if (!interfered) {
        interfered = true;
        store.seed(key, store.rawValue(key) ?? '');
      }
      return store.compareAndSwap(...args);
    },
  });
  const racingRegistry = new Registry(racingStore, { now: fixedClock() });

  const outcome = await racingRegistry.redactInput(REPO, 'pr-9', 'oops');
  assert.equal(outcome.ok, true, 'the lost race is retried, not surfaced');
  const read = await registry.read(REPO, 'pr-9');
  assert.equal(read.ok, true);
  if (!read.ok || read.record === null) return;
  assert.deepEqual(read.record.deployInputs, { image_tag: 'abc123' });
});

// --- warm slots and the pool claim (feat-007, chg-012) -----------------------

/** A claimable warm slot: fresh-claimed `warm`, then given its build's commit and URL. */
async function seedClaimableSlot(
  registry: Registry,
  identity: string,
): Promise<{ version: string }> {
  const claimed = await registry.claim({ repository: REPO, identity, state: 'warm' });
  assert.ok(claimed.ok, `seeding ${identity}: claim refused`);
  if (!claimed.ok) throw new Error('unreachable');
  const updated = await registry.update(REPO, identity, claimed.version, {
    deployedCommit: 'main-commit',
    url: `https://${identity}.example.test`,
  });
  assert.ok(updated.ok, `seeding ${identity}: update refused`);
  if (!updated.ok) throw new Error('unreachable');
  return { version: updated.version };
}

test('feat-001/AC-39 a warm record is claimable exactly when it carries a deployed commit', async () => {
  const registry = makeRegistry(new FakeStore());
  const claimed = await registry.claim({ repository: REPO, identity: 'slot-1', state: 'warm' });
  assert.ok(claimed.ok);
  if (!claimed.ok) return;
  // Build in progress: warm, no commit — not claimable.
  assert.equal(claimed.record.state, 'warm');
  assert.equal(isClaimable(claimed.record), false);
  const updated = await registry.update(REPO, 'slot-1', claimed.version, {
    deployedCommit: 'main-commit',
    url: 'https://slot-1.example.test',
  });
  assert.ok(updated.ok);
  if (!updated.ok) return;
  assert.equal(updated.record.state, 'warm', 'recording the build leaves the slot warm');
  assert.equal(isClaimable(updated.record), true);
  // An active record is never claimable, commit or not.
  assert.equal(
    isClaimable({ ...updated.record, state: 'active' }),
    false,
  );
});

test('feat-001/AC-39 warm state and claimant survive a store round-trip; old records read back unchanged', async () => {
  const store = new FakeStore();
  const registry = makeRegistry(store);
  await seedClaimableSlot(registry, 'slot-1');
  const readBack = await registry.read(REPO, 'slot-1');
  assert.ok(readBack.ok);
  if (!readBack.ok || readBack.record === null) return assert.fail('record missing');
  assert.equal(readBack.record.state, 'warm');
  assert.equal(readBack.record.claimant, null);

  // A record written before the claimant field existed reads back with null, never refused.
  const legacy = JSON.stringify({
    schemaVersion: 1,
    repository: REPO,
    identity: 'pr-9',
    state: 'active',
    deployedCommit: 'abc',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  });
  store.seed(registryKeyFor(REPO, 'pr-9'), legacy);
  const legacyRead = await registry.read(REPO, 'pr-9');
  assert.ok(legacyRead.ok);
  if (legacyRead.ok && legacyRead.record !== null) {
    assert.equal(legacyRead.record.claimant, null);
  }
});

test('feat-001/AC-16 a fresh claim against a warm record is refused as reserved for the pool', async () => {
  // The third distinguishable refusal (chg-012): not `held`, not `awaiting-teardown`.
  const registry = makeRegistry(new FakeStore());
  await seedClaimableSlot(registry, 'slot-1');
  const refused = await registry.claim({ repository: REPO, identity: 'slot-1' });
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.reason, 'pool-reserved');
});

test('feat-001/AC-38 the pool claim is one conditional write: warm to active, claimant recorded', async () => {
  const registry = makeRegistry(new FakeStore());
  const { version } = await seedClaimableSlot(registry, 'slot-1');
  const claimed = await registry.poolClaim(REPO, 'slot-1', 482, version);
  assert.ok(claimed.ok);
  if (!claimed.ok) return;
  assert.equal(claimed.record.state, 'active');
  assert.equal(claimed.record.claimant, 482);
  // The build's commit and URL are untouched by the claim itself.
  assert.equal(claimed.record.deployedCommit, 'main-commit');
  assert.equal(claimed.record.url, 'https://slot-1.example.test');
});

test('feat-001/AC-38 the registry, not the caller, refuses a commitless warm record', async () => {
  const registry = makeRegistry(new FakeStore());
  const claimed = await registry.claim({ repository: REPO, identity: 'slot-1', state: 'warm' });
  assert.ok(claimed.ok);
  if (!claimed.ok) return;
  const refused = await registry.poolClaim(REPO, 'slot-1', 482, claimed.version);
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.reason, 'not-claimable');
  const readBack = await registry.read(REPO, 'slot-1');
  assert.ok(readBack.ok && readBack.ok && readBack.record?.state === 'warm', 'nothing was written');
});

test('feat-001/AC-38 a stale version is a genuine loss, distinguishable from contention', async () => {
  const registry = makeRegistry(new FakeStore());
  const { version } = await seedClaimableSlot(registry, 'slot-1');
  const winner = await registry.poolClaim(REPO, 'slot-1', 482, version);
  assert.ok(winner.ok);
  const loser = await registry.poolClaim(REPO, 'slot-1', 500, version);
  assert.equal(loser.ok, false);
  if (!loser.ok) assert.equal(loser.reason, 'lost');
});

test('feat-007/AC-5 two concurrent pool claims of one slot: exactly one wins', async () => {
  let release = (): void => {};
  const parked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let arrived = 0;
  let racing = false; // the seeding writes must not park; only the two racing claims do
  const store = new FakeStore({
    beforeCommit: async () => {
      if (!racing) return;
      arrived += 1;
      if (arrived <= 2) await parked;
    },
  });
  const registry = makeRegistry(store);
  const { version } = await seedClaimableSlot(registry, 'slot-1');
  racing = true;

  const both = Promise.all([
    registry.poolClaim(REPO, 'slot-1', 482, version),
    registry.poolClaim(REPO, 'slot-1', 500, version),
  ]);
  // The pool claim reads before it writes, so give both calls the turns they need to
  // reach their commit — bounded, so a regression fails instead of hanging.
  for (let turn = 0; arrived < 2 && turn < 100; turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(arrived, 2, 'both claims are in flight before either commits');
  release();

  const [first, second] = await both;
  const winners = [first, second].filter((o) => o.ok);
  const losers = [first, second].filter((o) => !o.ok);
  assert.equal(winners.length, 1, 'exactly one pool claim succeeds');
  assert.equal(losers.length, 1);
  if (losers[0]?.ok === false) assert.equal(losers[0].reason, 'lost');
  // Exactly one claimant is recorded, and it is the winner's.
  const readBack = await registry.read(REPO, 'slot-1');
  assert.ok(readBack.ok && readBack.record !== null);
  if (readBack.ok && readBack.record !== null) {
    const winning = winners[0];
    assert.ok(winning?.ok);
    if (winning?.ok) assert.equal(readBack.record.claimant, winning.record.claimant);
  }
});

test('feat-001/AC-38 a pool claim against an active or released record is not claimable', async () => {
  const registry = makeRegistry(new FakeStore());
  const active = await registry.claim({ repository: REPO, identity: 'pr-1' });
  assert.ok(active.ok);
  if (!active.ok) return;
  const refused = await registry.poolClaim(REPO, 'pr-1', 482, active.version);
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.reason, 'not-claimable');
});

test('feat-007/AC-13 findSlotByClaimant finds the one slot a pull request holds', async () => {
  const registry = makeRegistry(new FakeStore());
  const { version } = await seedClaimableSlot(registry, 'slot-1');
  await seedClaimableSlot(registry, 'slot-2');
  await registry.claim({ repository: REPO, identity: 'pr-482' }); // a non-slot record is ignored
  const claimed = await registry.poolClaim(REPO, 'slot-1', 482, version);
  assert.ok(claimed.ok);

  const found = await registry.findSlotByClaimant(REPO, 482);
  assert.ok(found.ok);
  if (found.ok) {
    assert.equal(found.slot?.identity, 'slot-1');
    assert.equal(found.slot?.record.claimant, 482);
  }
  const none = await registry.findSlotByClaimant(REPO, 999);
  assert.ok(none.ok);
  if (none.ok) assert.equal(none.slot, null);
});

test('feat-007/AC-5 listSlots orders slots by number, not lexically', async () => {
  const registry = makeRegistry(new FakeStore());
  for (const n of [10, 2, 1]) await seedClaimableSlot(registry, `slot-${n}`);
  const listed = await registry.listSlots(REPO);
  assert.ok(listed.ok);
  if (listed.ok) {
    assert.deepEqual(
      listed.slots.map((s) => s.identity),
      ['slot-1', 'slot-2', 'slot-10'],
    );
  }
});
