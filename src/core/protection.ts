/**
 * Setting and clearing the protection mark — the deliberate human act that latches an
 * environment against destruction.
 *
 * The mark can change only while the record is `active`. A missing record has nothing to
 * protect. A `released` record is refused because releasing was itself the human's
 * authorization to destroy: the mark is honored before release, never after, so setting one
 * on a released record would promise a protection the sweep is right to ignore (feat-006
 * spec, "Protection is a latch on deliberate destruction").
 *
 * Nothing here names a cloud or a CI host. The cloud-side enforcement — only a
 * default-branch run may write a mark — is the role policy's, not this function's; this is
 * what makes skyhook behave correctly and answer clearly when it has not been tampered with.
 */

import type { Registry } from './registry.ts';

export interface ProtectionRequest {
  readonly repository: string;
  readonly identity: string;
  /** True to set the mark, false to clear it. */
  readonly protect: boolean;
}

export type ProtectionResult =
  /** The mark now has the state asked for, and is readable on the record's environment. */
  | { readonly kind: 'applied'; readonly isProtected: boolean }
  /** No record exists: there is no environment to protect. Nothing was written. */
  | { readonly kind: 'no-record' }
  /** The record is `released` — a started teardown. The mark is refused (feat-006/AC-7). */
  | { readonly kind: 'released' }
  | { readonly kind: 'failed'; readonly problem: string };

export async function setProtection(
  registry: Registry,
  request: ProtectionRequest,
): Promise<ProtectionResult> {
  const { repository, identity, protect } = request;

  const read = await registry.read(repository, identity);
  if (!read.ok) {
    return { kind: 'failed', problem: `the registry could not be read: ${read.reason}` };
  }
  if (read.record === null) return { kind: 'no-record' };
  if (read.record.state === 'released') return { kind: 'released' };

  const written = await registry.setProtected(repository, identity, protect);
  if (!written.ok) {
    return { kind: 'failed', problem: `the protection mark could not be written: ${written.reason}` };
  }

  // Re-check after a SET: nothing ties the write above to the record version read before
  // it, so a teardown releasing (or removing) the record in that window would leave a
  // mark on a started teardown (gap-001). Teardown no longer honors such a mark
  // (feat-006/AC-7), so the stray mark is harmless — but the caller must not be told
  // "protected" about an environment already on its way out. Unwind best-effort and
  // answer truthfully; an unwind that fails leaves only the harmless stray, which the
  // sweep's record-plus-marker removal deletes when it completes the teardown.
  if (protect) {
    const again = await registry.read(repository, identity);
    if (!again.ok) {
      return { kind: 'failed', problem: `the mark was written but the record could not be re-read: ${again.reason}` };
    }
    if (again.record === null || again.record.state === 'released') {
      await registry.setProtected(repository, identity, false);
      return again.record === null ? { kind: 'no-record' } : { kind: 'released' };
    }
  }
  return { kind: 'applied', isProtected: written.isProtected };
}
