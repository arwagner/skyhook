/**
 * Installation is a diff, not a script.
 *
 * Init computes the desired content of every file it manages, compares it against what is
 * actually there, and writes only the differences — reporting each one. That is what makes a
 * re-run a no-op (AC-2) and a half-finished or hand-edited installation converge rather than
 * break (AC-13).
 *
 * It never merges. A **restored** file is returned to its desired content, whole. Merging would
 * mean guessing which half of a conflict the operator meant, and guessing wrong quietly is worse
 * than overwriting loudly — the operator can see an overwrite in their diff.
 *
 * A **seeded** file is written when it is absent and left alone when it is present
 * (feat-002/AC-20, `chg-002`). Exactly one file is seeded: the settings file. It is the one file
 * in an installation whose content belongs to the operator rather than to skyhook — two of its
 * settings cannot be known when it is first written, because the bootstrap has not applied yet, so
 * skyhook writes labelled blanks and the operator fills them in. Restoring that file would revert
 * their answers, and a settings file rebuilt from defaults names a bucket that does not exist.
 *
 * Seeding is not a softer form of merging: there is no guess in it. Skyhook either owns a file's
 * content or it does not, and it says which in the report rather than leaving the operator to
 * infer it.
 *
 * Files skyhook does not manage are never read, written, or deleted.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import type { Store } from './store.ts';

/**
 * `restore` — skyhook owns this file's content and returns it to that content.
 * `seed`    — skyhook writes it once and thereafter leaves it to the operator.
 *
 * Restoring is the default, so a file has to opt out of being owned. A new file added without a
 * thought about this is one skyhook keeps correct, which is the safer of the two mistakes.
 */
export type FileRule = 'restore' | 'seed';

export interface DesiredFile {
  /** Relative to the repository root, always with `/` separators. */
  readonly path: string;
  readonly content: string;
  /** Defaults to `restore`. */
  readonly rule?: FileRule;
}

export type ChangeKind =
  /** Nothing was at this path. */
  | 'created'
  /** Something was at this path and it was not what skyhook wants. */
  | 'restored'
  /**
   * A seeded file was already there, so skyhook left it alone. Deliberately not `unchanged`:
   * skyhook never compared the content and must not imply that it did. An operator reading the
   * report needs to know their edits survived because this file is theirs, not because they
   * happened to match.
   */
  | 'kept'
  | 'unchanged';

export interface FileChange {
  readonly path: string;
  readonly kind: ChangeKind;
}

export interface InstallReport {
  readonly changes: readonly FileChange[];
}

/**
 * Everything skyhook actually wrote — what an operator wants reported (AC-13).
 *
 * `kept` is not a write. Listing it here would tell an operator that `init` changed their settings
 * file, which is the precise opposite of what seeding guarantees.
 */
export function changed(report: InstallReport): readonly FileChange[] {
  return report.changes.filter((change) => change.kind === 'created' || change.kind === 'restored');
}

/**
 * What would change, given a way to read what is there. Pure, so the decision logic is testable
 * without a filesystem and the same diff drives both a dry run and an apply.
 */
export function planInstall(
  desired: readonly DesiredFile[],
  readExisting: (path: string) => string | null,
): InstallReport {
  const changes = desired.map((file): FileChange => {
    const existing = readExisting(file.path);
    if (existing === null) return { path: file.path, kind: 'created' };
    // Before any content comparison: a seeded file that exists is not skyhook's to judge.
    if (file.rule === 'seed') return { path: file.path, kind: 'kept' };
    if (existing === file.content) return { path: file.path, kind: 'unchanged' };
    return { path: file.path, kind: 'restored' };
  });
  return { changes };
}

/** Applies the plan under `root`, writing only the files that differ. */
export function applyInstall(root: string, desired: readonly DesiredFile[]): InstallReport {
  const report = planInstall(desired, (path) => readIfPresent(join(root, toNativePath(path))));

  for (const change of report.changes) {
    if (change.kind === 'unchanged' || change.kind === 'kept') continue;
    const file = desired.find((candidate) => candidate.path === change.path);
    if (file === undefined) continue;
    const target = join(root, toNativePath(file.path));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content, 'utf8');
  }

  return report;
}

function readIfPresent(target: string): string | null {
  try {
    return readFileSync(target, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function toNativePath(path: string): string {
  return sep === '/' ? path : path.split('/').join(sep);
}

// --- the registry half of installation --------------------------------------

/**
 * Marks a bucket as holding an initialized registry. The leading dot keeps it out of every
 * `registry/<repo>/` prefix — a repository name must begin with a letter or digit.
 */
export const REGISTRY_MARKER_KEY = 'registry/.initialized';

export type EnsureRegistryOutcome =
  | { readonly ok: true; readonly created: boolean }
  | {
      readonly ok: false;
      readonly reason: 'container-missing';
      /** Named so the operator is told which bucket to go and create. */
      readonly bucket: string;
    };

/**
 * Two things can be missing, and they need opposite responses.
 *
 * The **registry** self-heals: an empty bucket gets an initialized registry and the run carries
 * on, with no human step (AC-4). The **bucket** does not: the bootstrap Terraform declares it, and
 * creating it behind Terraform's back would leave Terraform with a resource absent from its state,
 * whose repair is worse than the outage. So skyhook stops and names it, and creates nothing.
 *
 * The self-healing half needs no lock. It is the same create-if-absent primitive a claim uses, so
 * two runs initializing at once resolve exactly like two claims: one wins, the loser is told, and
 * both proceed. The part that would have needed a lock is the part skyhook never creates.
 */
export async function ensureRegistry(store: Store, bucket: string): Promise<EnsureRegistryOutcome> {
  const created = await store.createIfAbsent(REGISTRY_MARKER_KEY, initializedMarker());
  if (created.ok) return { ok: true, created: true };
  if (created.reason === 'container-missing') {
    return { ok: false, reason: 'container-missing', bucket };
  }
  return { ok: true, created: false };
}

function initializedMarker(): string {
  return JSON.stringify({ schemaVersion: 1 });
}
