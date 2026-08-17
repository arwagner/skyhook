import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeStore } from './fake-store.ts';
import { FakeDestroyer, FakePullRequests } from './fake-destroyer.ts';
import {
  Registry,
  protectionKeyFor,
  registryKeyFor,
  stateDirFor,
} from '../src/core/registry.ts';
import { sweepEnvironments, type SweepEntry, type SweepPorts } from '../src/core/sweep.ts';
import type { EnvironmentState } from '../src/core/types.ts';

const REPO = 'acme/widgets';

function fixedClock(): () => string {
  let tick = 0;
  return () => `2026-08-16T01:00:${String(tick++).padStart(2, '0')}.000Z`;
}

function recordJson(identity: string, state: EnvironmentState, bodyIdentity?: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    repository: REPO,
    identity: bodyIdentity ?? identity,
    state,
    deployedCommit: 'a1b2c3d4',
    url: null,
    createdAt: '2026-08-15T00:00:00.000Z',
    updatedAt: '2026-08-15T00:00:00.000Z',
  });
}

function seed(store: FakeStore, identity: string, state: EnvironmentState = 'active', bodyIdentity?: string): void {
  store.seed(registryKeyFor(REPO, identity), recordJson(identity, state, bodyIdentity));
  store.seed(`${stateDirFor(REPO, identity)}terraform.tfstate`, '{"resources":[]}');
}

interface Harness {
  readonly ports: SweepPorts;
  readonly store: FakeStore;
  readonly registry: Registry;
  readonly destroyer: FakeDestroyer;
  readonly pullRequests: FakePullRequests;
}

function harness(
  pullRequestStates: Readonly<Record<number, 'open' | 'closed'>>,
  options: { store?: FakeStore; destroyer?: FakeDestroyer; failAcquisitionFor?: string } = {},
): Harness {
  const store = options.store ?? new FakeStore();
  const registry = new Registry(store, { now: fixedClock() });
  const destroyer = options.destroyer ?? new FakeDestroyer();
  const pullRequests = new FakePullRequests(pullRequestStates);
  const ports: SweepPorts = {
    registry,
    store,
    pullRequests,
    destroyerFor: async (identity) =>
      identity === options.failAcquisitionFor
        ? { ok: false, problem: `no credentials for ${identity}` }
        : { ok: true, destroyer },
  };
  return { ports, store, registry, destroyer, pullRequests };
}

function entryFor(result: readonly SweepEntry[], identity: string): SweepEntry {
  const entry = result.find((e) => e.identity === identity);
  assert.ok(entry !== undefined, `no sweep entry for ${identity}`);
  return entry;
}

// --- the missed close event is repaired (AC-6) ---------------------------------

test('feat-003/AC-6 an active environment whose pull request is closed is destroyed by the pass', async () => {
  const { ports, store } = harness({ 482: 'closed' });
  seed(store, 'pr-482');

  const result = await sweepEnvironments(ports, REPO);

  assert.equal(result.kind, 'swept');
  if (result.kind !== 'swept') return;
  assert.equal(entryFor(result.entries, 'pr-482').kind, 'destroyed');
  assert.equal(store.rawValue(registryKeyFor(REPO, 'pr-482')), undefined);
  assert.deepEqual(store.allKeys().filter((k) => k.startsWith(stateDirFor(REPO, 'pr-482'))), []);
});

// --- an open pull request is not eligible (AC-7) --------------------------------

test('feat-003/AC-7 an open pull request’s environment is left standing, untouched', async () => {
  const { ports, store, destroyer } = harness({ 482: 'open' });
  seed(store, 'pr-482');
  const before = store.allKeys();

  const result = await sweepEnvironments(ports, REPO);

  assert.equal(result.kind, 'swept');
  if (result.kind !== 'swept') return;
  assert.equal(entryFor(result.entries, 'pr-482').kind, 'left-standing-open');
  assert.equal(destroyer.called, false);
  assert.deepEqual(store.allKeys(), before);
});

// --- nothing eligible (AC-8) -----------------------------------------------------

test('feat-003/AC-8 a pass with no records succeeds and changes nothing', async () => {
  const { ports, store } = harness({});

  const result = await sweepEnvironments(ports, REPO);

  assert.equal(result.kind, 'swept');
  if (result.kind !== 'swept') return;
  assert.deepEqual(result.entries, []);
  assert.deepEqual(store.allKeys(), []);
});

test('feat-003/AC-8 a pass where everything is open or foreign changes nothing', async () => {
  const { ports, store, destroyer, pullRequests } = harness({ 1: 'open' });
  seed(store, 'pr-1');
  seed(store, 'staging');
  const before = store.allKeys();

  const result = await sweepEnvironments(ports, REPO);

  assert.equal(result.kind, 'swept');
  if (result.kind !== 'swept') return;
  assert.equal(entryFor(result.entries, 'pr-1').kind, 'left-standing-open');
  assert.equal(entryFor(result.entries, 'staging').kind, 'not-ephemeral');
  assert.equal(destroyer.called, false);
  assert.deepEqual(pullRequests.asked, [1], 'a non-ephemeral record was asked about');
  assert.deepEqual(store.allKeys(), before);
});

// --- a released record is a started teardown (AC-5) -------------------------------

test('feat-003/AC-5 the sweep completes a released record without asking the host', async () => {
  const { ports, store, pullRequests } = harness({});
  seed(store, 'pr-9', 'released');

  const result = await sweepEnvironments(ports, REPO);

  assert.equal(result.kind, 'swept');
  if (result.kind !== 'swept') return;
  assert.equal(entryFor(result.entries, 'pr-9').kind, 'destroyed');
  assert.deepEqual(pullRequests.asked, [], 'a released record was asked about');
  assert.equal(store.rawValue(registryKeyFor(REPO, 'pr-9')), undefined);
});

// --- protection survives the sweep (AC-4) -----------------------------------------

test('feat-003/AC-4 a protected environment survives the pass and is reported, not failed', async () => {
  const { ports, store, destroyer } = harness({ 5: 'closed' });
  seed(store, 'pr-5');
  store.seed(protectionKeyFor(REPO, 'pr-5'), '2026-08-15T00:00:00.000Z');
  const recordBefore = store.rawValue(registryKeyFor(REPO, 'pr-5'));

  const result = await sweepEnvironments(ports, REPO);

  assert.equal(result.kind, 'swept');
  if (result.kind !== 'swept') return;
  assert.equal(entryFor(result.entries, 'pr-5').kind, 'left-standing-protected');
  assert.equal(destroyer.called, false);
  assert.equal(store.rawValue(registryKeyFor(REPO, 'pr-5')), recordBefore);
});

// --- one failure never stops the others (AC-9) ------------------------------------

test('feat-003/AC-9 a failed destroy is reported loudly, the rest complete, the next pass retries', async () => {
  const store = new FakeStore();
  seed(store, 'pr-1');
  seed(store, 'pr-2');
  seed(store, 'pr-3');
  const destroyer = new FakeDestroyer();
  const failing = new FakeDestroyer({
    outcome: { ok: false, reason: 'consumer-destroy-failed', problem: 'the definition refused to die' },
  });
  const registry = new Registry(store, { now: fixedClock() });
  const ports: SweepPorts = {
    registry,
    store,
    pullRequests: new FakePullRequests({ 1: 'closed', 2: 'closed', 3: 'closed' }),
    destroyerFor: async (identity) => ({ ok: true, destroyer: identity === 'pr-2' ? failing : destroyer }),
  };

  const first = await sweepEnvironments(ports, REPO);
  assert.equal(first.kind, 'swept');
  if (first.kind !== 'swept') return;
  assert.equal(entryFor(first.entries, 'pr-1').kind, 'destroyed');
  assert.equal(entryFor(first.entries, 'pr-3').kind, 'destroyed');
  const failed = entryFor(first.entries, 'pr-2');
  assert.equal(failed.kind, 'failed');
  assert.equal(failed.consumer, true);
  assert.match(failed.problem ?? '', /refused to die/);
  assert.match(store.rawValue(registryKeyFor(REPO, 'pr-2')) ?? '', /released/, 'the failed record did not stay released');

  failing.outcome = { ok: true };
  const second = await sweepEnvironments(ports, REPO);
  assert.equal(second.kind, 'swept');
  if (second.kind !== 'swept') return;
  assert.equal(entryFor(second.entries, 'pr-2').kind, 'destroyed');
  assert.equal(store.rawValue(registryKeyFor(REPO, 'pr-2')), undefined);
});

test('feat-003/AC-9 an environment whose credentials cannot be obtained fails alone', async () => {
  const { ports, store } = harness({ 1: 'closed', 2: 'closed' }, { failAcquisitionFor: 'pr-1' });
  seed(store, 'pr-1');
  seed(store, 'pr-2');

  const result = await sweepEnvironments(ports, REPO);

  assert.equal(result.kind, 'swept');
  if (result.kind !== 'swept') return;
  const failed = entryFor(result.entries, 'pr-1');
  assert.equal(failed.kind, 'failed');
  assert.match(failed.problem ?? '', /credentials/);
  assert.equal(entryFor(result.entries, 'pr-2').kind, 'destroyed');
});

// --- the identity invariant (plan D2, security B1; cited under AC-14) --------------

test('feat-003/AC-14 a record whose body claims another identity is swept as its key', async () => {
  // The pull-request role can write arbitrary content into its own record. A body
  // claiming pr-42 must not point the sweep — the widest role in the system — at pr-42:
  // the key is the identity, everywhere.
  const { ports, store, destroyer } = harness({ 97: 'closed' });
  seed(store, 'pr-97', 'active', 'pr-42');
  // pr-42's own pull request is open: it must survive the pass untouched.
  seed(store, 'pr-42', 'active', undefined);
  const portsWithBoth: SweepPorts = {
    ...ports,
    pullRequests: new FakePullRequests({ 97: 'closed', 42: 'open' }),
  };

  const result = await sweepEnvironments(portsWithBoth, REPO);

  assert.equal(result.kind, 'swept');
  if (result.kind !== 'swept') return;
  assert.equal(entryFor(result.entries, 'pr-97').kind, 'destroyed');
  assert.equal(entryFor(result.entries, 'pr-42').kind, 'left-standing-open');
  assert.deepEqual(
    destroyer.requests.map((r) => r.identity),
    ['pr-97'],
    'the destroyer was pointed at a body-claimed identity',
  );
  assert.equal(store.rawValue(registryKeyFor(REPO, 'pr-97')), undefined);
  assert.notEqual(store.rawValue(registryKeyFor(REPO, 'pr-42')), undefined, 'the framed neighbour was destroyed');
  assert.notEqual(
    store.rawValue(`${stateDirFor(REPO, 'pr-42')}terraform.tfstate`),
    undefined,
    'the framed neighbour’s state was deleted',
  );
});

// --- the sweep itself failing is one loud report -----------------------------------

test('a sweep that cannot list the registry fails as a whole, loudly', async () => {
  const store = new FakeStore({ containerExists: false });
  const { ports } = harness({}, { store });

  const result = await sweepEnvironments(ports, REPO);

  assert.equal(result.kind, 'failed');
  if (result.kind === 'failed') assert.match(result.problem, /registry/);
});

// --- long-running environments (feat-006) ---------------------------------------

test('feat-006/AC-4 a pass that destroys eligible ephemerals leaves an active long-running environment untouched', async () => {
  const { ports, store } = harness({ 482: 'closed' });
  seed(store, 'pr-482');
  seed(store, 'staging');
  const stagingKeysBefore = store.allKeys().filter((k) => k.includes('/staging'));

  const result = await sweepEnvironments(ports, REPO);

  assert.equal(result.kind, 'swept');
  if (result.kind !== 'swept') return;
  // The eligible ephemeral went; the long-running environment is neither destroyed nor
  // reported as a failure or as eligible.
  assert.equal(entryFor(result.entries, 'pr-482').kind, 'destroyed');
  assert.equal(entryFor(result.entries, 'staging').kind, 'not-ephemeral');
  assert.deepEqual(store.allKeys().filter((k) => k.includes('/staging')), stagingKeysBefore);
});

test('feat-006/AC-7 a released long-running record is a started teardown, and the pass completes it', async () => {
  // A manual teardown that died after releasing left this record. The decision to destroy
  // was the human's; the sweep only finishes what was explicitly started — it asks no one,
  // exactly as it completes a released ephemeral record.
  const { ports, store } = harness({});
  seed(store, 'staging', 'released');

  const result = await sweepEnvironments(ports, REPO);

  assert.equal(result.kind, 'swept');
  if (result.kind !== 'swept') return;
  assert.equal(entryFor(result.entries, 'staging').kind, 'destroyed');
  assert.equal(store.rawValue(registryKeyFor(REPO, 'staging')), undefined);
  assert.deepEqual(store.allKeys().filter((k) => k.startsWith(stateDirFor(REPO, 'staging'))), []);
});

test('feat-006/AC-7 gap-001: a stray mark on a released record never blocks the sweep completing it', async () => {
  // Belt to the protection fix's braces: even if a mark DOES sit on a released record —
  // the wedge the gap-001 race minted — the mark is honored before release, never after,
  // so the sweep completes the started teardown and the marker goes with the record.
  const { ports, store } = harness({});
  seed(store, 'staging', 'released');
  store.seed(protectionKeyFor(REPO, 'staging'), '2026-08-17T00:00:00.000Z');

  const result = await sweepEnvironments(ports, REPO);

  assert.equal(result.kind, 'swept');
  if (result.kind !== 'swept') return;
  assert.equal(entryFor(result.entries, 'staging').kind, 'destroyed');
  assert.equal(store.rawValue(registryKeyFor(REPO, 'staging')), undefined);
  assert.equal(store.rawValue(protectionKeyFor(REPO, 'staging')), undefined);
});
