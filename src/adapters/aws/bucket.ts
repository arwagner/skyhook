/**
 * Does skyhook's bucket exist yet?
 *
 * The bootstrap needs to know before it can decide how to initialize: the bucket is a resource
 * this configuration creates, so on a first run there is nowhere for the state to live and it must
 * run locally, then migrate. Asked rather than remembered — the same reason the trust anchor is
 * detected rather than declared, and the reason the trust anchor survived a wiped working tree
 * when the bucket did not.
 *
 * Reads. Creates nothing.
 */

import type { CommandRunner } from '../../cli/process.ts';

export type BucketLookup =
  | { readonly ok: true; readonly exists: boolean }
  | { readonly ok: false; readonly problem: string };

export async function bucketExists(
  runner: CommandRunner,
  bucket: string,
  region: string,
): Promise<BucketLookup> {
  const result = await runner.run('aws', [
    's3api',
    'head-bucket',
    '--bucket',
    bucket,
    '--region',
    region,
  ]);

  if (result.code === 0) return { ok: true, exists: true };

  const said = `${result.stderr}\n${result.stdout}`;
  // A 404 is an answer: no such bucket. A 403 is also an answer — it exists and belongs to
  // someone else, which the apply will fail on for a better reason than this function could give.
  if (/\b404\b|NoSuchBucket|Not Found/i.test(said)) return { ok: true, exists: false };
  if (/\b403\b|Forbidden/i.test(said)) return { ok: true, exists: true };

  return { ok: false, problem: firstMeaningfulLine(said) };
}

function firstMeaningfulLine(text: string): string {
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '');
  return line ?? 'the AWS CLI failed without saying why';
}

/** Every key under a prefix, following pagination. Reads only. */
export async function listKeys(
  runner: CommandRunner,
  bucket: string,
  region: string,
  prefix: string,
): Promise<{ ok: true; keys: string[] } | { ok: false; problem: string }> {
  const keys: string[] = [];
  let token: string | undefined;

  do {
    const args = [
      's3api', 'list-objects-v2',
      '--bucket', bucket, '--region', region,
      '--prefix', prefix, '--output', 'json',
    ];
    if (token !== undefined) args.push('--starting-token', token);

    const result = await runner.run('aws', args);
    if (result.code !== 0) return { ok: false, problem: firstMeaningfulLine(result.stderr) };

    try {
      const parsed = JSON.parse(result.stdout || '{}') as {
        Contents?: { Key?: unknown }[];
        NextToken?: unknown;
      };
      for (const entry of parsed.Contents ?? []) {
        if (typeof entry.Key === 'string') keys.push(entry.Key);
      }
      token = typeof parsed.NextToken === 'string' ? parsed.NextToken : undefined;
    } catch {
      return { ok: false, problem: `could not read the contents of ${bucket}` };
    }
  } while (token !== undefined);

  return { ok: true, keys };
}

/**
 * Removes every object AND every version from the bucket.
 *
 * Versioning is on, so deleting the current version of an object leaves a delete marker and the
 * bucket is still not empty — and a bucket that is not empty cannot be deleted. Both have to go.
 */
export async function emptyBucket(
  runner: CommandRunner,
  bucket: string,
  region: string,
): Promise<{ ok: true; removed: number } | { ok: false; problem: string }> {
  let removed = 0;

  for (;;) {
    const listed = await runner.run('aws', [
      's3api', 'list-object-versions',
      '--bucket', bucket, '--region', region,
      '--max-items', '1000', '--output', 'json',
    ]);
    if (listed.code !== 0) return { ok: false, problem: firstMeaningfulLine(listed.stderr) };

    let batch: { Key: string; VersionId: string }[];
    try {
      const parsed = JSON.parse(listed.stdout || '{}') as Record<string, unknown>;
      batch = ['Versions', 'DeleteMarkers'].flatMap((field) =>
        ((parsed[field] as { Key?: unknown; VersionId?: unknown }[] | undefined) ?? [])
          .filter((o): o is { Key: string; VersionId: string } =>
            typeof o.Key === 'string' && typeof o.VersionId === 'string')
          .map((o) => ({ Key: o.Key, VersionId: o.VersionId })),
      );
    } catch {
      return { ok: false, problem: `could not read the contents of ${bucket}` };
    }

    if (batch.length === 0) return { ok: true, removed };

    const deleted = await runner.run('aws', [
      's3api', 'delete-objects',
      '--bucket', bucket, '--region', region,
      '--delete', JSON.stringify({ Objects: batch, Quiet: true }),
    ]);
    if (deleted.code !== 0) return { ok: false, problem: firstMeaningfulLine(deleted.stderr) };
    removed += batch.length;
  }
}
