import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { CommandResult, CommandRunner } from '../src/cli/process.ts';
import { Registry } from '../src/core/registry.ts';
import { SnapshotStore, fetchRegistrySnapshot } from '../src/adapters/aws/snapshot.ts';

const REPO = 'acme/widgets';
const BUCKET = 'acme-skyhook';
const REGION = 'eu-central-1';

function recordJson(identity: string, state: 'active' | 'released'): string {
  return JSON.stringify({
    schemaVersion: 1,
    repository: REPO,
    identity,
    state,
    deployedCommit: 'abc123',
    url: `https://${identity}.example.test`,
    createdAt: '2026-08-14T00:00:00.000Z',
    updatedAt: '2026-08-15T00:00:00.000Z',
  });
}

interface Call {
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * Plays the two `aws` invocations the snapshot makes: the recursive copy (by writing
 * the given files into the copy's destination directory) and the protection listing.
 */
function fakeAws(options: {
  readonly records?: Readonly<Record<string, string>>;
  readonly protectedKeys?: readonly string[];
  readonly copyFails?: string;
}): { runner: CommandRunner; calls: Call[]; copiedTo: () => string | null } {
  const calls: Call[] = [];
  let destination: string | null = null;

  const runner: CommandRunner = {
    async run(command, args): Promise<CommandResult> {
      calls.push({ command, args });
      assert.equal(command, 'aws', 'every invocation is argv-array aws, never a shell string');

      if (args[0] === 's3' && args[1] === 'cp') {
        if (options.copyFails !== undefined) {
          return { code: 1, stdout: '', stderr: options.copyFails };
        }
        destination = args[3] ?? null;
        assert.ok(destination !== null);
        for (const [relative, value] of Object.entries(options.records ?? {})) {
          const path = join(destination, relative);
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, value);
        }
        return { code: 0, stdout: '', stderr: '' };
      }

      if (args[0] === 's3api' && args[1] === 'list-objects-v2') {
        const contents = (options.protectedKeys ?? []).map((key) => ({ Key: key }));
        return { code: 0, stdout: JSON.stringify({ Contents: contents }), stderr: '' };
      }

      throw new Error(`unexpected aws invocation: ${args.join(' ')}`);
    },
  };

  return { runner, calls, copiedTo: () => destination };
}

// --- fetching ---------------------------------------------------------------

test('feat-005/AC-1 a snapshot serves the registry records through Registry.list, unchanged', async () => {
  const aws = fakeAws({
    records: {
      'staging.json': recordJson('staging', 'active'),
      'pr-482.json': recordJson('pr-482', 'released'),
    },
  });

  const snapshot = await fetchRegistrySnapshot(aws.runner, BUCKET, REGION, REPO);
  assert.ok(snapshot.ok);

  const registry = new Registry(snapshot.store);
  const listed = await registry.list(REPO);
  assert.ok(listed.ok);
  assert.deepEqual(
    listed.records.map((r) => r.identity).sort(),
    ['pr-482', 'staging'],
    'the one existing record parser reads the snapshot',
  );
  assert.equal(listed.records.find((r) => r.identity === 'pr-482')?.state, 'released');
});

test('feat-005/AC-3 protected identities come from the protection key listing', async () => {
  const aws = fakeAws({
    records: { 'pr-1.json': recordJson('pr-1', 'released') },
    protectedKeys: [`protected/${REPO}/pr-1`, `protected/${REPO}/staging`],
  });

  const snapshot = await fetchRegistrySnapshot(aws.runner, BUCKET, REGION, REPO);
  assert.ok(snapshot.ok);
  assert.deepEqual([...snapshot.protectedIdentities].sort(), ['pr-1', 'staging']);
});

test('the snapshot temp directory is private in origin and removed before returning', async () => {
  const aws = fakeAws({ records: { 'pr-1.json': recordJson('pr-1', 'active') } });

  const snapshot = await fetchRegistrySnapshot(aws.runner, BUCKET, REGION, REPO);
  assert.ok(snapshot.ok);
  const dir = aws.copiedTo();
  assert.ok(dir !== null, 'the copy had a destination');
  assert.ok(!existsSync(dir), 'no record content is left on disk (analyze S2)');
});

test('a failed copy reports the problem instead of an empty dashboard', async () => {
  const aws = fakeAws({ copyFails: 'An error occurred (ExpiredToken) …' });
  const snapshot = await fetchRegistrySnapshot(aws.runner, BUCKET, REGION, REPO);
  assert.ok(!snapshot.ok);
  assert.match(snapshot.problem, /ExpiredToken/);
});

// --- the read-only store ----------------------------------------------------

test('the snapshot store refuses every write: nothing on this path may mutate the registry', async () => {
  const store = new SnapshotStore(new Map([['registry/acme/widgets/pr-1.json', '{}']]));
  await assert.rejects(() => store.createIfAbsent('k', 'v'), /read-only/);
  await assert.rejects(() => store.compareAndSwap('k', 'v', 'v1'), /read-only/);
  await assert.rejects(() => store.delete('k'), /read-only/);

  const listed = await store.list('registry/');
  assert.ok(listed.ok);
  assert.deepEqual(listed.keys, ['registry/acme/widgets/pr-1.json']);
});
