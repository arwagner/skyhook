import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeStore } from './fake-store.ts';

/**
 * The fake store is the foundation every core test stands on, so its own semantics
 * are tested rather than assumed. A lenient double here would silently weaken every
 * test that depends on it.
 */

test('fake store: createIfAbsent refuses a key that is already occupied', async () => {
  const store = new FakeStore();
  const first = await store.createIfAbsent('k', 'one');
  assert.equal(first.ok, true);

  const second = await store.createIfAbsent('k', 'two');
  assert.deepEqual(second, { ok: false, reason: 'already-exists' });
  assert.equal(store.rawValue('k'), 'one', 'the refused write must leave no trace');
});

test('fake store: compareAndSwap refuses a stale version token', async () => {
  const store = new FakeStore();
  const created = await store.createIfAbsent('k', 'one');
  assert.equal(created.ok, true);
  const staleVersion = created.ok ? created.version : '';

  const fresh = await store.compareAndSwap('k', 'two', staleVersion);
  assert.equal(fresh.ok, true, 'a current token is accepted');

  const stale = await store.compareAndSwap('k', 'three', staleVersion);
  assert.deepEqual(stale, { ok: false, reason: 'version-mismatch' });
  assert.equal(store.rawValue('k'), 'two');
});

test('fake store: compareAndSwap on an absent key is a mismatch, not a create', async () => {
  const store = new FakeStore();
  const outcome = await store.compareAndSwap('missing', 'x', 'v1');
  assert.deepEqual(outcome, { ok: false, reason: 'version-mismatch' });
  assert.deepEqual(store.allKeys(), []);
});

test('fake store: two writes held open together produce exactly one winner', async () => {
  // Both calls are parked inside createIfAbsent before either commits, so neither
  // can have observed the other's write. This is what proves the operation is
  // atomic rather than accidentally serialized by the event loop.
  let release = (): void => {};
  const parked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let arrived = 0;
  const store = new FakeStore({
    beforeCommit: async () => {
      arrived += 1;
      await parked;
    },
  });

  const both = Promise.all([store.createIfAbsent('k', 'a'), store.createIfAbsent('k', 'b')]);
  await Promise.resolve();
  assert.equal(arrived, 2, 'both writes are in flight before either commits');
  release();

  const outcomes = await both;
  assert.equal(outcomes.filter((o) => o.ok).length, 1);
  assert.equal(outcomes.filter((o) => !o.ok).length, 1);
});

test('fake store: every operation reports container-missing when the bucket is absent', async () => {
  const store = new FakeStore({ containerExists: false });
  const missing = { ok: false, reason: 'container-missing' };

  assert.deepEqual(await store.createIfAbsent('k', 'v'), missing);
  assert.deepEqual(await store.read('k'), missing);
  assert.deepEqual(await store.compareAndSwap('k', 'v', 'v1'), missing);
  assert.deepEqual(await store.list(''), missing);
  assert.deepEqual(await store.delete('k'), missing);
  assert.deepEqual(store.allKeys(), [], 'nothing is created when the container is absent');
});

test('fake store: delete of an absent key succeeds and list is prefix-scoped', async () => {
  const store = new FakeStore();
  store.seed('a/one', '1');
  store.seed('a/two', '2');
  store.seed('b/three', '3');

  assert.deepEqual(await store.delete('a/nope'), { ok: true });

  const listed = await store.list('a/');
  assert.deepEqual(listed, { ok: true, keys: ['a/one', 'a/two'] });
});
