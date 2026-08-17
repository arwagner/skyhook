import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeStore } from './fake-store.ts';
import { Registry } from '../src/core/registry.ts';
import { setProtection } from '../src/core/protection.ts';

function fixedClock(): () => string {
  let tick = 0;
  return () => `2026-08-16T00:00:${String(tick++).padStart(2, '0')}.000Z`;
}

function makeRegistry(store: FakeStore): Registry {
  return new Registry(store, { now: fixedClock() });
}

const REPO = 'acme/widgets';

test('feat-006/AC-9 a human action sets the mark and another clears it, readable after each', async () => {
  const registry = makeRegistry(new FakeStore());
  await registry.claim({ repository: REPO, identity: 'staging' });

  const set = await setProtection(registry, { repository: REPO, identity: 'staging', protect: true });
  assert.deepEqual(set, { kind: 'applied', isProtected: true });
  assert.deepEqual(await registry.isProtected(REPO, 'staging'), { ok: true, isProtected: true });

  const cleared = await setProtection(registry, { repository: REPO, identity: 'staging', protect: false });
  assert.deepEqual(cleared, { kind: 'applied', isProtected: false });
  assert.deepEqual(await registry.isProtected(REPO, 'staging'), { ok: true, isProtected: false });
});

test('feat-006/AC-9 protecting an environment with no record is refused, and nothing is written', async () => {
  const store = new FakeStore();
  const registry = makeRegistry(store);

  const outcome = await setProtection(registry, { repository: REPO, identity: 'staging', protect: true });
  assert.deepEqual(outcome, { kind: 'no-record' });
  assert.deepEqual(await registry.isProtected(REPO, 'staging'), { ok: true, isProtected: false });
});

test('feat-006/AC-7 setting a mark on a released record is refused — releasing authorized the destroy', async () => {
  const registry = makeRegistry(new FakeStore());
  const claimed = await registry.claim({ repository: REPO, identity: 'staging' });
  assert.ok(claimed.ok);
  await registry.release(REPO, 'staging', claimed.version);

  const outcome = await setProtection(registry, { repository: REPO, identity: 'staging', protect: true });
  assert.deepEqual(outcome, { kind: 'released' });
  // The refusal wrote nothing: the sweep's completion of a started teardown is never
  // blocked by a mark, because no mark can appear after release.
  assert.deepEqual(await registry.isProtected(REPO, 'staging'), { ok: true, isProtected: false });
});

test('protection: clearing a mark on a released record is refused the same way', async () => {
  const registry = makeRegistry(new FakeStore());
  const claimed = await registry.claim({ repository: REPO, identity: 'staging' });
  assert.ok(claimed.ok);
  await registry.setProtected(REPO, 'staging', true);
  await registry.release(REPO, 'staging', claimed.version);

  const outcome = await setProtection(registry, { repository: REPO, identity: 'staging', protect: false });
  assert.deepEqual(outcome, { kind: 'released' });
});

test('protection: an unreadable registry is a loud failure, not an answer', async () => {
  const registry = makeRegistry(new FakeStore({ containerExists: false }));
  const outcome = await setProtection(registry, { repository: REPO, identity: 'staging', protect: true });
  assert.equal(outcome.kind, 'failed');
});

test('feat-006/AC-7 gap-001: a protect racing a release is refused and leaves no mark behind', async () => {
  // The race converge's gap-001 recorded and the break run executed: protect reads the
  // record as active; a teardown releases it before the mark's write commits. The mark
  // must not survive on a started teardown, and the caller must not be told "protected".
  let releaseNow: (() => Promise<void>) | null = null;
  const store = new FakeStore({
    beforeCommit: async (key) => {
      if (key.startsWith('protected/') && releaseNow !== null) {
        const run = releaseNow;
        releaseNow = null;
        await run();
      }
    },
  });
  const registry = makeRegistry(store);
  const claimed = await registry.claim({ repository: REPO, identity: 'staging' });
  assert.ok(claimed.ok);

  releaseNow = async () => {
    const read = await registry.read(REPO, 'staging');
    assert.ok(read.ok && read.record !== null);
    await registry.release(REPO, 'staging', read.version);
  };
  const outcome = await setProtection(registry, { repository: REPO, identity: 'staging', protect: true });

  assert.deepEqual(outcome, { kind: 'released' });
  assert.deepEqual(await registry.isProtected(REPO, 'staging'), { ok: true, isProtected: false });
});

test('feat-006/AC-7 gap-001: a protect racing a removal is refused the same way', async () => {
  let removeNow: (() => Promise<void>) | null = null;
  const store = new FakeStore({
    beforeCommit: async (key) => {
      if (key.startsWith('protected/') && removeNow !== null) {
        const run = removeNow;
        removeNow = null;
        await run();
      }
    },
  });
  const registry = makeRegistry(store);
  await registry.claim({ repository: REPO, identity: 'staging' });

  removeNow = async () => {
    await registry.remove(REPO, 'staging');
  };
  const outcome = await setProtection(registry, { repository: REPO, identity: 'staging', protect: true });

  assert.deepEqual(outcome, { kind: 'no-record' });
  assert.deepEqual(await registry.isProtected(REPO, 'staging'), { ok: true, isProtected: false });
});
