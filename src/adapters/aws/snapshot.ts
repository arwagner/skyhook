/**
 * A one-shot, read-only view of the registry, taken with the developer's own
 * credentials through the `aws` CLI — the dashboard's read path (feat-005 plan D2).
 *
 * Two invocations per snapshot, regardless of how many environments exist: one
 * recursive copy of the repository's registry records, one listing of its protection
 * keys (protection is key-existence only, so the marker bodies are never fetched).
 * The copy lands in a private temp directory (`mkdtemp` — created 0700) that is read
 * into memory and removed before this function returns, so no record content lingers
 * on disk (analyze S2).
 */

import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import type { CommandRunner } from '../../cli/process.ts';
import type {
  CreateOutcome,
  DeleteOutcome,
  ListOutcome,
  ReadOutcome,
  Store,
  SwapOutcome,
  VersionToken,
} from '../../core/store.ts';
import { PROTECTION_PREFIX, registryPrefixFor } from '../../core/registry.ts';
import { listKeys } from './bucket.ts';

/**
 * Serves reads from an in-memory copy and refuses every write. The dashboard renders
 * what the registry records and does nothing to any environment (spec: read-only), so
 * a write reaching this store is a defect worth crashing on, not an outcome to model.
 */
export class SnapshotStore implements Store {
  readonly #entries: ReadonlyMap<string, string>;

  constructor(entries: ReadonlyMap<string, string>) {
    this.#entries = entries;
  }

  async read(key: string): Promise<ReadOutcome> {
    const value = this.#entries.get(key);
    if (value === undefined) return { ok: true, object: null };
    return { ok: true, object: { value, version: 'snapshot' satisfies VersionToken } };
  }

  async list(prefix: string): Promise<ListOutcome> {
    const keys = [...this.#entries.keys()].filter((key) => key.startsWith(prefix)).sort();
    return { ok: true, keys };
  }

  async createIfAbsent(_key: string, _value: string): Promise<CreateOutcome> {
    throw new Error('snapshot store is read-only');
  }

  async compareAndSwap(
    _key: string,
    _value: string,
    _expected: VersionToken,
  ): Promise<SwapOutcome> {
    throw new Error('snapshot store is read-only');
  }

  async delete(_key: string): Promise<DeleteOutcome> {
    throw new Error('snapshot store is read-only');
  }
}

export type SnapshotOutcome =
  | {
      readonly ok: true;
      readonly store: SnapshotStore;
      readonly protectedIdentities: readonly string[];
    }
  | { readonly ok: false; readonly problem: string };

export async function fetchRegistrySnapshot(
  runner: CommandRunner,
  bucket: string,
  region: string,
  repository: string,
): Promise<SnapshotOutcome> {
  const registryPrefix = registryPrefixFor(repository);
  const directory = await mkdtemp(join(tmpdir(), 'skyhook-dashboard-'));

  try {
    const copied = await runner.run('aws', [
      's3', 'cp',
      `s3://${bucket}/${registryPrefix}`, directory,
      '--recursive', '--region', region,
    ]);
    if (copied.code !== 0) {
      return { ok: false, problem: firstMeaningfulLine(copied.stderr) };
    }

    const entries = new Map<string, string>();
    for (const file of await readdir(directory, { recursive: true, withFileTypes: true })) {
      if (!file.isFile()) continue;
      const path = join(file.parentPath, file.name);
      const key = registryPrefix + relative(directory, path).split(sep).join('/');
      entries.set(key, await readFile(path, 'utf8'));
    }

    const protectionPrefix = `${PROTECTION_PREFIX}${repository}/`;
    const marks = await listKeys(runner, bucket, region, protectionPrefix);
    if (!marks.ok) return { ok: false, problem: marks.problem };
    const protectedIdentities = marks.keys
      .filter((key) => key.startsWith(protectionPrefix))
      .map((key) => key.slice(protectionPrefix.length))
      .filter((identity) => identity !== '');

    return { ok: true, store: new SnapshotStore(entries), protectedIdentities };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function firstMeaningfulLine(text: string): string {
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '');
  return line ?? 'the AWS CLI failed without saying why';
}
