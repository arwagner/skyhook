import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchDefinition } from '../src/adapters/git/commit-fetch.ts';
import type { CommandResult, CommandRunner, RunOptions } from '../src/cli/process.ts';

const REPO = 'acme/widgets';

class RecordingGit implements CommandRunner {
  readonly calls: Array<{ args: readonly string[]; options: RunOptions | undefined }> = [];
  /** Refs whose fetch fails; everything else succeeds. */
  readonly refusedRefs: Set<string>;

  constructor(refusedRefs: readonly string[] = []) {
    this.refusedRefs = new Set(refusedRefs);
  }

  async run(_command: string, args: readonly string[], options?: RunOptions): Promise<CommandResult> {
    this.calls.push({ args, options });
    const bare = args.filter((a) => a !== '-c' && !a.includes('='));
    if (bare.includes('fetch')) {
      const ref = args[args.length - 1] ?? '';
      if (this.refusedRefs.has(ref)) {
        return { code: 128, stdout: '', stderr: `fatal: couldn't find remote ref ${ref}` };
      }
    }
    return { code: 0, stdout: '', stderr: '' };
  }
}

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'skyhook-fetch-test-'));
}

test('feat-003/AC-1 the fetch is hardened: no hooks, no submodules, the remote pinned to the repository', async () => {
  const runner = new RecordingGit();
  const dir = scratch();

  const outcome = await fetchDefinition(
    { runner, repository: REPO, token: 'job-token', scratchDir: dir },
    { commit: 'a1b2c3d4', pullRequestNumber: 482 },
  );

  assert.equal(outcome.ok, true);
  if (outcome.ok) assert.equal(outcome.root, dir);
  assert.ok(runner.calls.length > 0);
  for (const call of runner.calls) {
    const rendered = call.args.join(' ');
    assert.match(rendered, /core\.hooksPath=/, `hooks not disabled: git ${rendered}`);
    assert.match(rendered, /submodule\.recurse=false/, `submodules not disabled: git ${rendered}`);
  }
  const fetch = runner.calls.find((c) => c.args.includes('fetch'));
  assert.ok(fetch !== undefined);
  assert.ok(fetch.args.includes(`https://github.com/${REPO}.git`), 'the remote is not the pinned repository');
  assert.ok(fetch.args.includes('--no-recurse-submodules'));
  assert.ok(fetch.args.includes('a1b2c3d4'), 'the recorded commit was not what was fetched');
  // The token rides a header config, never the remote URL.
  assert.equal(fetch.args.some((a) => a.includes('job-token')), false, 'the raw token leaked into an argument');
});

test('feat-003/AC-9 an unfetchable commit falls back to the pull request head, then fails loudly', async () => {
  const fallback = await fetchDefinition(
    { runner: new RecordingGit(['a1b2c3d4']), repository: REPO, scratchDir: scratch() },
    { commit: 'a1b2c3d4', pullRequestNumber: 482 },
  );
  assert.equal(fallback.ok, true, 'the pull-request head fallback did not engage');

  const hopeless = new RecordingGit(['a1b2c3d4', 'refs/pull/482/head']);
  const outcome = await fetchDefinition(
    { runner: hopeless, repository: REPO, scratchDir: scratch() },
    { commit: 'a1b2c3d4', pullRequestNumber: 482 },
  );
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.match(outcome.problem, /human/);
});

test('a record with no commit fetches the pull request head', async () => {
  const runner = new RecordingGit();
  const outcome = await fetchDefinition(
    { runner, repository: REPO, scratchDir: scratch() },
    { commit: null, pullRequestNumber: 9 },
  );
  assert.equal(outcome.ok, true);
  const fetch = runner.calls.find((c) => c.args.includes('fetch'));
  assert.ok(fetch?.args.includes('refs/pull/9/head'));
});
