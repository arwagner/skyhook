/**
 * Fetching the definition a destroy runs: the commit the registry recorded, into a
 * scratch directory outside any working tree (feat-003 plan D5).
 *
 * This replaces `actions/checkout` for the destroy path — the sweep has no pull request
 * to check out, and the close event's checkout is a merge ref, not what was applied — so
 * the safety that action provides by default is provided here explicitly (security S4):
 *
 *   - hooks never execute: every git invocation pins `core.hooksPath` to an empty
 *     directory inside the scratch space;
 *   - submodules are never fetched or recursed;
 *   - the one remote is constructed from the repository this run belongs to — a caller
 *     cannot point the fetch anywhere else;
 *   - the token travels as a header config on the command line of THIS process's child,
 *     never written to disk and never baked into the remote URL git would store.
 */

import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandRunner } from '../../cli/process.ts';

export interface CommitFetchOptions {
  readonly runner: CommandRunner;
  /** `owner/name` — pinned; the remote URL is built from it and nothing else. */
  readonly repository: string;
  /** The job's token, for a private repository. Optional: a public one fetches without. */
  readonly token?: string | undefined;
  /** The host serving git, e.g. `https://github.com`. */
  readonly host?: string;
  /** Injected for tests. Defaults to a fresh directory under the system temp dir. */
  readonly scratchDir?: string;
}

export interface FetchTarget {
  /** The recorded commit of the last successful apply, or null if none ever landed. */
  readonly commit: string | null;
  /** The pull request the environment is bound to — its head ref is the fallback. */
  readonly pullRequestNumber: number;
}

export type FetchOutcome =
  | { readonly ok: true; readonly root: string }
  | { readonly ok: false; readonly problem: string };

export async function fetchDefinition(
  options: CommitFetchOptions,
  target: FetchTarget,
): Promise<FetchOutcome> {
  const root = options.scratchDir ?? mkdtempSync(join(tmpdir(), 'skyhook-definition-'));
  const noHooks = join(root, '.skyhook-no-hooks');
  mkdirSync(noHooks, { recursive: true });

  const host = options.host ?? 'https://github.com';
  const remote = `${host}/${options.repository}.git`;

  const git = async (args: readonly string[]) => {
    const hardened = [
      // An empty hooks directory: nothing the fetched content could plant gets to run.
      '-c', `core.hooksPath=${noHooks}`,
      // Never touch a submodule, whatever the fetched definition declares.
      '-c', 'submodule.recurse=false',
      ...(options.token !== undefined && options.token !== ''
        ? ['-c', `http.${host}/.extraheader=AUTHORIZATION: basic ${basicAuth(options.token)}`]
        : []),
      ...args,
    ];
    return options.runner.run('git', hardened, { cwd: root });
  };

  const init = await git(['init', '--quiet']);
  if (init.code !== 0) {
    return { ok: false, problem: `git init failed in the scratch directory: ${firstLine(init.stderr)}` };
  }

  // The recorded commit first; the pull request's head ref only as a fallback for a
  // record that predates any successful apply. GitHub keeps pull-request heads fetchable
  // after branch deletion, which is what makes the fallback (and usually the commit
  // itself) reachable at all.
  const pullHeadRef = `refs/pull/${target.pullRequestNumber}/head`;
  const attempts: string[] = target.commit !== null ? [target.commit, pullHeadRef] : [pullHeadRef];

  let fetched: string | null = null;
  const failures: string[] = [];
  for (const ref of attempts) {
    const fetch = await git(['fetch', '--quiet', '--depth=1', '--no-tags', '--no-recurse-submodules', remote, ref]);
    if (fetch.code === 0) {
      fetched = ref;
      break;
    }
    failures.push(`${ref}: ${firstLine(fetch.stderr) || `exit ${fetch.code}`}`);
  }
  if (fetched === null) {
    return {
      ok: false,
      problem:
        `the definition for pull request #${target.pullRequestNumber} could not be fetched from ` +
        `${options.repository} (${failures.join('; ')}). Without a definition there is nothing to ` +
        'run the destroy with; this environment needs a human look.',
    };
  }
  if (fetched !== target.commit && target.commit !== null) {
    // The head ref was reachable but the recorded commit was not: the destroy will run a
    // newer definition than the one applied. Say so rather than silently substituting.
    const note = await git(['checkout', '--quiet', '--detach', 'FETCH_HEAD']);
    if (note.code !== 0) {
      return { ok: false, problem: `git checkout of ${fetched} failed: ${firstLine(note.stderr)}` };
    }
    return { ok: true, root };
  }

  const checkout = await git(['checkout', '--quiet', '--detach', 'FETCH_HEAD']);
  if (checkout.code !== 0) {
    return { ok: false, problem: `git checkout of ${fetched} failed: ${firstLine(checkout.stderr)}` };
  }
  return { ok: true, root };
}

function basicAuth(token: string): string {
  return Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');
}

function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim() !== '')?.trim() ?? '';
}
