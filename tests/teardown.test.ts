import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeStore } from './fake-store.ts';
import { FakeDestroyer } from './fake-destroyer.ts';
import { FakeDeployer, fakeBroker, fakeConfigSource, fakeTrigger, tickingClock } from './fake-deployer.ts';
import { deployEnvironment } from '../src/core/deploy.ts';
import {
  Registry,
  protectionKeyFor,
  registryKeyFor,
  stateDirFor,
} from '../src/core/registry.ts';
import { teardownEnvironment, type TeardownPorts } from '../src/core/teardown.ts';
import type { ReadOutcome, Store } from '../src/core/store.ts';
import type { EnvironmentState } from '../src/core/types.ts';

const REPO = 'acme/widgets';
const ID = 'pr-482';

function fixedClock(): () => string {
  let tick = 0;
  return () => `2026-08-16T00:00:${String(tick++).padStart(2, '0')}.000Z`;
}

function recordJson(state: EnvironmentState, identity = ID): string {
  return JSON.stringify({
    schemaVersion: 1,
    repository: REPO,
    identity,
    state,
    deployedCommit: 'a1b2c3d4',
    url: null,
    createdAt: '2026-08-15T00:00:00.000Z',
    updatedAt: '2026-08-15T00:00:00.000Z',
  });
}

interface Harness {
  readonly ports: TeardownPorts;
  readonly store: FakeStore;
  readonly registry: Registry;
  readonly destroyer: FakeDestroyer;
}

function harness(options: {
  store?: Store;
  fakeStore?: FakeStore;
  destroyer?: FakeDestroyer;
  markerRemoval?: 'with-record' | 'record-only';
} = {}): Harness {
  const fakeStore = options.fakeStore ?? new FakeStore();
  const store = options.store ?? fakeStore;
  const registry = new Registry(store, { now: fixedClock() });
  const destroyer = options.destroyer ?? new FakeDestroyer();
  return {
    ports: { registry, destroyer, store, markerRemoval: options.markerRemoval ?? 'with-record' },
    store: fakeStore,
    registry,
    destroyer,
  };
}

function seedEnvironment(store: FakeStore, state: EnvironmentState = 'active'): void {
  store.seed(registryKeyFor(REPO, ID), recordJson(state));
  store.seed(`${stateDirFor(REPO, ID)}terraform.tfstate`, '{"resources":[]}');
}

// --- the order that keeps every promise (AC-1) --------------------------------

test('feat-003/AC-1 release precedes destroy, destroy precedes deletion, the record goes last', async () => {
  const store = new FakeStore();
  seedEnvironment(store);

  let recordStateAtDestroy: string | undefined;
  let stateKeysAtDestroy: readonly string[] = [];
  const destroyer = new FakeDestroyer({
    onDestroy: () => {
      // Sampled INSIDE the destroy: the record must already be released (claims are
      // being refused as awaiting teardown) and the stored state must still exist.
      recordStateAtDestroy = store.rawValue(registryKeyFor(REPO, ID));
      stateKeysAtDestroy = store.allKeys().filter((k) => k.startsWith(stateDirFor(REPO, ID)));
    },
  });
  const { ports } = harness({ fakeStore: store, destroyer });

  const result = await teardownEnvironment(ports, { repository: REPO, identity: ID });

  assert.equal(result.kind, 'destroyed');
  assert.ok(recordStateAtDestroy !== undefined, 'the record was gone before the destroy ran');
  assert.match(recordStateAtDestroy, /"state": "released"|"state":"released"/);
  assert.equal(stateKeysAtDestroy.length, 1, 'the stored state was deleted before the destroy');
  assert.equal(store.rawValue(registryKeyFor(REPO, ID)), undefined, 'the record survived teardown');
  assert.deepEqual(
    store.allKeys().filter((k) => k.startsWith(stateDirFor(REPO, ID))),
    [],
    'stored state survived teardown',
  );
});

test('feat-003/AC-1 a completed teardown frees the name for a first-use claim', async () => {
  const { ports, registry, store } = harness();
  seedEnvironment(store);
  store.seed(protectionKeyFor(REPO, 'pr-9'), 'someone else, untouched');

  assert.equal((await teardownEnvironment(ports, { repository: REPO, identity: ID })).kind, 'destroyed');

  const claim = await registry.claim({ repository: REPO, identity: ID });
  assert.ok(claim.ok, 'the freed name refused a claim');
  assert.equal(claim.record.state, 'active');
  assert.equal(claim.record.deployedCommit, null, 'the fresh record inherited a commit');
});

// --- nothing to do (AC-2) -----------------------------------------------------

test('feat-003/AC-2 a close with no environment succeeds, reports nothing to do, and writes nothing', async () => {
  const { ports, store, destroyer } = harness();
  const before = store.allKeys();

  const result = await teardownEnvironment(ports, { repository: REPO, identity: ID });

  assert.equal(result.kind, 'nothing');
  assert.equal(destroyer.called, false);
  assert.deepEqual(store.allKeys(), before);
});

// --- protection (AC-4) --------------------------------------------------------

test('feat-003/AC-4 a protection marker stops everything before the record moves', async () => {
  const { ports, store, destroyer } = harness();
  seedEnvironment(store);
  store.seed(protectionKeyFor(REPO, ID), '2026-08-15T00:00:00.000Z');
  const recordBefore = store.rawValue(registryKeyFor(REPO, ID));

  const result = await teardownEnvironment(ports, { repository: REPO, identity: ID });

  assert.equal(result.kind, 'left-standing-protected');
  assert.equal(destroyer.called, false);
  assert.equal(store.rawValue(registryKeyFor(REPO, ID)), recordBefore, 'the record moved');
  assert.notEqual(store.rawValue(protectionKeyFor(REPO, ID)), undefined, 'the marker moved');
});

test('feat-003/AC-4 unreadable protection fails closed: nothing is destroyed', async () => {
  // The close fast path's credentials are refused the protection prefix outright (plan
  // D3). A refusal must read as "unknown", never as "unprotected".
  const fakeStore = new FakeStore();
  seedEnvironment(fakeStore);
  const refusing: Store = {
    createIfAbsent: (key, value) => fakeStore.createIfAbsent(key, value),
    compareAndSwap: (key, value, expected) => fakeStore.compareAndSwap(key, value, expected),
    list: (prefix) => fakeStore.list(prefix),
    delete: (key) => fakeStore.delete(key),
    read: (key): Promise<ReadOutcome> => {
      if (key.startsWith('protected/')) throw new Error('access denied by the cloud');
      return fakeStore.read(key);
    },
  };
  const { ports, destroyer } = harness({ store: refusing, fakeStore });

  const result = await teardownEnvironment(ports, { repository: REPO, identity: ID });

  assert.equal(result.kind, 'protection-unknown');
  if (result.kind === 'protection-unknown') assert.match(result.problem, /sweep/);
  assert.equal(destroyer.called, false);
  assert.notEqual(fakeStore.rawValue(registryKeyFor(REPO, ID)), undefined);
});

// --- the sweep finishes what was started (AC-5) --------------------------------

test('feat-003/AC-5 a released record is completed without touching the pull request', async () => {
  const { ports, store } = harness();
  seedEnvironment(store, 'released');

  const result = await teardownEnvironment(ports, { repository: REPO, identity: ID });

  assert.equal(result.kind, 'destroyed');
  assert.equal(store.rawValue(registryKeyFor(REPO, ID)), undefined);
});

test('feat-003/AC-5 a teardown interrupted at the destroy is finished by the next pass', async () => {
  const { ports, store, destroyer } = harness();
  seedEnvironment(store);

  destroyer.outcome = { ok: false, reason: 'skyhook-failed', problem: 'killed mid-destroy' };
  const first = await teardownEnvironment(ports, { repository: REPO, identity: ID });
  assert.equal(first.kind, 'failed');
  assert.match(store.rawValue(registryKeyFor(REPO, ID)) ?? '', /released/, 'the record did not stay released');

  destroyer.outcome = { ok: true };
  const second = await teardownEnvironment(ports, { repository: REPO, identity: ID });
  assert.equal(second.kind, 'destroyed');
  assert.equal(store.rawValue(registryKeyFor(REPO, ID)), undefined);
});

test('feat-003/AC-5 a teardown interrupted after the destroy is finished by the next pass', async () => {
  // Infrastructure gone, state deleted, record still there — the residue of dying
  // between steps 4 and 5. The next pass advances from wherever it finds things.
  const { ports, store } = harness();
  store.seed(registryKeyFor(REPO, ID), recordJson('released'));

  const result = await teardownEnvironment(ports, { repository: REPO, identity: ID });

  assert.equal(result.kind, 'destroyed');
  assert.equal(store.rawValue(registryKeyFor(REPO, ID)), undefined);
});

// --- phantom destroy (plan D6 step 4, security S1) ------------------------------

test('feat-003/AC-9 a destroy reporting success over non-empty state deletes nothing', async () => {
  const { ports, store, destroyer } = harness();
  seedEnvironment(store);
  destroyer.residual = { ok: true, empty: false };

  const result = await teardownEnvironment(ports, { repository: REPO, identity: ID });

  assert.equal(result.kind, 'failed');
  if (result.kind === 'failed') {
    assert.equal(result.consumer, false);
    assert.match(result.problem, /orphan/);
  }
  assert.match(store.rawValue(registryKeyFor(REPO, ID)) ?? '', /released/, 'the record was lost');
  assert.equal(
    store.allKeys().filter((k) => k.startsWith(stateDirFor(REPO, ID))).length,
    1,
    'the stored state was deleted after a phantom destroy',
  );
});

// --- two teardowns racing (AC-10) ----------------------------------------------

test('feat-003/AC-10 a full peer teardown landing mid-destroy is not a failure', async () => {
  // The sharpest deterministic interleave: while A is inside its destroy, B runs a
  // complete teardown. A resumes to find the record gone — that is one completed
  // teardown, not an error.
  const store = new FakeStore();
  seedEnvironment(store);
  const peer = harness({ fakeStore: store });
  const destroyer = new FakeDestroyer({
    onDestroy: async () => {
      const result = await teardownEnvironment(peer.ports, { repository: REPO, identity: ID });
      assert.equal(result.kind, 'destroyed');
    },
  });
  const { ports } = harness({ fakeStore: store, destroyer });

  const result = await teardownEnvironment(ports, { repository: REPO, identity: ID });

  assert.equal(result.kind, 'destroyed');
  if (result.kind === 'destroyed') assert.match(result.notes.join(' '), /concurrent/);
  assert.equal(store.rawValue(registryKeyFor(REPO, ID)), undefined);
});

test('feat-003/AC-10 two concurrent teardowns end as one, with no spurious failure', async () => {
  const store = new FakeStore();
  seedEnvironment(store);
  const a = harness({ fakeStore: store });
  const b = harness({ fakeStore: store });

  const [first, second] = await Promise.all([
    teardownEnvironment(a.ports, { repository: REPO, identity: ID }),
    teardownEnvironment(b.ports, { repository: REPO, identity: ID }),
  ]);

  for (const result of [first, second]) {
    assert.ok(
      result.kind === 'destroyed' || result.kind === 'nothing',
      `a raced teardown reported ${result.kind}`,
    );
  }
  assert.equal(store.rawValue(registryKeyFor(REPO, ID)), undefined);
  assert.deepEqual(store.allKeys().filter((k) => k.startsWith(stateDirFor(REPO, ID))), []);
});

// --- a reactivating deploy stops the teardown (AC-14) ----------------------------

/** A store that runs a script the Nth time a given key is read — the reactivation seam. */
class ScriptedStore implements Store {
  #reads = 0;
  readonly #inner: FakeStore;
  readonly #script: { key: string; onReadNumber: number; run: () => void };

  constructor(inner: FakeStore, script: { key: string; onReadNumber: number; run: () => void }) {
    this.#inner = inner;
    this.#script = script;
  }

  createIfAbsent(key: string, value: string) { return this.#inner.createIfAbsent(key, value); }
  compareAndSwap(key: string, value: string, expected: string) { return this.#inner.compareAndSwap(key, value, expected); }
  list(prefix: string) { return this.#inner.list(prefix); }
  delete(key: string) { return this.#inner.delete(key); }
  async read(key: string): Promise<ReadOutcome> {
    if (key === this.#script.key) {
      this.#reads += 1;
      if (this.#reads === this.#script.onReadNumber) this.#script.run();
    }
    return this.#inner.read(key);
  }
}

function reactivate(store: FakeStore): void {
  store.seed(registryKeyFor(REPO, ID), recordJson('active'));
}

test('feat-003/AC-14 a reactivation before the release is seen, and the teardown stops', async () => {
  // The deploy wins the CAS: teardown read the record, the deploy moved it, the
  // teardown's release comes back stale and the re-read finds it active.
  const fakeStore = new FakeStore({
    beforeCommit: async (key) => {
      // The first commit the teardown attempts is its release CAS; land the deploy's
      // write just before it, so the CAS loses.
      if (key === registryKeyFor(REPO, ID) && !landed) {
        landed = true;
        reactivate(fakeStore);
      }
    },
  });
  let landed = false;
  seedEnvironment(fakeStore);
  const { ports, destroyer } = harness({ fakeStore });

  const result = await teardownEnvironment(ports, { repository: REPO, identity: ID });

  assert.equal(result.kind, 'reactivated');
  assert.equal(destroyer.called, false, 'the destroy ran against a reactivated environment');
  assert.match(fakeStore.rawValue(registryKeyFor(REPO, ID)) ?? '', /active/);
});

test('feat-003/AC-14 a reactivation after the release, before the destroy, stops the teardown', async () => {
  const fakeStore = new FakeStore();
  seedEnvironment(fakeStore);
  // Read 1 is the initial read; read 2 is the re-confirm before the destroy — the
  // deploy's reactivation lands just as it happens.
  const scripted = new ScriptedStore(fakeStore, {
    key: registryKeyFor(REPO, ID),
    onReadNumber: 2,
    run: () => reactivate(fakeStore),
  });
  const { ports, destroyer } = harness({ store: scripted, fakeStore });

  const result = await teardownEnvironment(ports, { repository: REPO, identity: ID });

  assert.equal(result.kind, 'reactivated');
  assert.equal(destroyer.called, false, 'the destroy ran against a reactivated environment');
  assert.match(fakeStore.rawValue(registryKeyFor(REPO, ID)) ?? '', /active/);
});

test('feat-003/AC-14 a reactivation during the destroy keeps the record; the deploy rebuilds from nothing', async () => {
  // The spec's accepted sharp edge: the destroy cannot be stopped mid-flight, so the
  // outcome degrades to destroy-then-recreate — but the record is never removed.
  const fakeStore = new FakeStore();
  seedEnvironment(fakeStore);
  const destroyer = new FakeDestroyer({ onDestroy: () => reactivate(fakeStore) });
  const { ports } = harness({ fakeStore, destroyer });

  const result = await teardownEnvironment(ports, { repository: REPO, identity: ID });

  assert.equal(result.kind, 'reactivated');
  if (result.kind === 'reactivated') assert.match(result.notes.join(' '), /empty state/);
  assert.match(fakeStore.rawValue(registryKeyFor(REPO, ID)) ?? '', /active/, 'the record was removed');
});

// --- teardown then deploy: the freed name starts from nothing (AC-11, AC-13) -----

const CONFIG = `storage:
  bucket: skyhook-acme
  region: us-east-1
  account: "123456789012"

deploy:
  directory: infrastructure
`;

const CAPPED_CONFIG = `${CONFIG}
environment_cap:
  limit: 1
`;

function deployPorts(store: FakeStore, pullRequestNumber: number, config = CONFIG) {
  const registry = new Registry(store, { now: fixedClock() });
  return {
    trigger: fakeTrigger({
      ok: true,
      context: { kind: 'pull-request', repository: REPO, pullRequestNumber, headCommit: 'feedbeef', fromFork: false },
    }),
    configSource: fakeConfigSource(config),
    broker: fakeBroker(registry, new FakeDeployer()),
    now: tickingClock(0),
  };
}

test('feat-003/AC-11 after teardown, a deploy of the same identity is a first deploy', async () => {
  const { ports, store } = harness();
  seedEnvironment(store);
  assert.equal((await teardownEnvironment(ports, { repository: REPO, identity: ID })).kind, 'destroyed');

  const deployed = await deployEnvironment(deployPorts(store, 482));

  assert.equal(deployed.kind, 'deployed');
  const record = store.rawValue(registryKeyFor(REPO, ID));
  assert.ok(record !== undefined);
  assert.match(record, /feedbeef/, 'the fresh record does not carry the new commit');
  assert.doesNotMatch(record, /a1b2c3d4/, 'the fresh record inherited its predecessor');
  assert.deepEqual(
    store.allKeys().filter((k) => k.startsWith(stateDirFor(REPO, ID))),
    [],
    'stored state survived into the successor',
  );
});

test('feat-003/AC-13 a completed teardown frees a cap slot', async () => {
  const { ports, store } = harness();
  seedEnvironment(store);

  const refused = await deployEnvironment(deployPorts(store, 483, CAPPED_CONFIG));
  assert.equal(refused.kind, 'failed');
  if (refused.kind === 'failed') assert.match(refused.message, /cap/);

  assert.equal((await teardownEnvironment(ports, { repository: REPO, identity: ID })).kind, 'destroyed');

  const allowed = await deployEnvironment(deployPorts(store, 483, CAPPED_CONFIG));
  assert.equal(allowed.kind, 'deployed');
});

// --- the fast path's removal leaves protection keys alone -----------------------

test('record-only removal never touches the protection prefix', async () => {
  // The fast path's credentials are refused every operation under protected/*, even a
  // delete of nothing. Prove the whole teardown, in record-only mode, performs none.
  const fakeStore = new FakeStore();
  seedEnvironment(fakeStore);
  const guarded: Store = {
    createIfAbsent: (key, value) => fakeStore.createIfAbsent(key, value),
    compareAndSwap: (key, value, expected) => fakeStore.compareAndSwap(key, value, expected),
    list: (prefix) => fakeStore.list(prefix),
    read: (key) => fakeStore.read(key),
    delete: (key) => {
      assert.ok(!key.startsWith('protected/'), `deleted under the protection prefix: ${key}`);
      return fakeStore.delete(key);
    },
  };
  const registry = new Registry(guarded, { now: fixedClock() });
  const ports: TeardownPorts = {
    registry,
    destroyer: new FakeDestroyer(),
    store: guarded,
    markerRemoval: 'record-only',
  };

  const result = await teardownEnvironment(ports, { repository: REPO, identity: ID });

  assert.equal(result.kind, 'destroyed');
  assert.equal(fakeStore.rawValue(registryKeyFor(REPO, ID)), undefined);
});

// --- the destroy replays the recorded inputs (chg-001) ------------------------

function recordWithInputs(state: EnvironmentState): string {
  return JSON.stringify({
    schemaVersion: 1,
    repository: REPO,
    identity: ID,
    state,
    deployedCommit: 'a1b2c3d4',
    url: null,
    deployInputs: { image_tag: 'a1b2c3d4', speech_image: 'ecr/speech:1' },
    createdAt: '2026-08-15T00:00:00.000Z',
    updatedAt: '2026-08-15T00:00:00.000Z',
  });
}

test('feat-003/AC-15 the destroy receives the recorded inputs; a record without them destroys with none', async () => {
  const withInputs = harness();
  withInputs.store.seed(registryKeyFor(REPO, ID), recordWithInputs('released'));
  withInputs.store.seed(`${stateDirFor(REPO, ID)}terraform.tfstate`, '{"resources":[]}');
  const done = await teardownEnvironment(withInputs.ports, { repository: REPO, identity: ID });
  assert.equal(done.kind, 'destroyed');
  assert.deepEqual(withInputs.destroyer.requests[0]?.deployInputs, {
    image_tag: 'a1b2c3d4',
    speech_image: 'ecr/speech:1',
  });

  // The unchanged path: every record written before recording existed.
  const without = harness();
  seedEnvironment(without.store, 'released');
  const doneWithout = await teardownEnvironment(without.ports, { repository: REPO, identity: ID });
  assert.equal(doneWithout.kind, 'destroyed');
  assert.equal(without.destroyer.requests[0]?.deployInputs ?? null, null);
});

test('feat-003/AC-15 feat-001/AC-37 a redaction mid-teardown is not a reactivation and is not lost', async () => {
  // The redact lands while the destroy is executing — after the release, before the
  // re-confirm. It bumps the record's version without touching its state, so the
  // teardown must complete (state is the reactivation key, not version identity), and
  // the redaction itself must succeed rather than be surfaced as a lost race.
  const store = new FakeStore();
  const registry = new Registry(store, { now: fixedClock() });
  store.seed(registryKeyFor(REPO, ID), recordWithInputs('released'));
  store.seed(`${stateDirFor(REPO, ID)}terraform.tfstate`, '{"resources":[]}');

  let redactOutcome = false;
  const destroyer = new FakeDestroyer({
    onDestroy: async () => {
      redactOutcome = (await registry.redactInput(REPO, ID, 'speech_image')).ok;
    },
  });
  const ports: TeardownPorts = { registry, destroyer, store, markerRemoval: 'with-record' };

  const done = await teardownEnvironment(ports, { repository: REPO, identity: ID });

  assert.equal(redactOutcome, true, 'the redaction was not lost');
  assert.equal(done.kind, 'destroyed', 'a content-only write never reads as a reactivation');
  assert.equal(store.rawValue(registryKeyFor(REPO, ID)), undefined, 'the record is removed');
});
