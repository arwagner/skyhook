/**
 * The clarity check the manual commands share: a run qualifies for credentials that reach
 * a long-running environment only when dispatched against the default branch, and the run
 * says which ref it needs rather than failing confusingly (feat-006 spec).
 *
 * A check, not the enforcement — the default-branch role's trust is what actually refuses
 * any other ref, whatever this code says. So when the default branch cannot be determined
 * (no event payload, a hand run outside CI), the answer is to proceed and let the cloud
 * answer: refusing here on missing information would block a run the cloud may accept.
 */

import { readFileSync } from 'node:fs';

export type RefCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly problem: string };

export function requireDefaultBranchRef(
  env: Readonly<Record<string, string | undefined>>,
  readFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): RefCheck {
  const eventPath = env['GITHUB_EVENT_PATH'];
  const ref = env['GITHUB_REF'];
  if (eventPath === undefined || eventPath === '' || ref === undefined || ref === '') return { ok: true };

  let defaultBranch: unknown;
  try {
    const payload = JSON.parse(readFile(eventPath)) as { repository?: { default_branch?: unknown } };
    defaultBranch = payload.repository?.default_branch;
  } catch {
    return { ok: true };
  }
  if (typeof defaultBranch !== 'string' || defaultBranch === '') return { ok: true };

  const needed = `refs/heads/${defaultBranch}`;
  if (ref === needed) return { ok: true };
  return {
    ok: false,
    problem:
      `this run was dispatched against "${ref}" and needs "${needed}". Credentials that ` +
      'reach a long-running environment are issued only to a run from the default branch, ' +
      'so any other ref would be refused by the cloud anyway — dispatch the workflow ' +
      `against "${defaultBranch}" instead.`,
  };
}
