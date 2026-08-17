import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitHubPullRequests } from '../src/adapters/github/pull-requests.ts';

const REPO = 'acme/widgets';

function sourceAnswering(status: number, body: unknown): { source: GitHubPullRequests; seen: string[] } {
  const seen: string[] = [];
  const source = new GitHubPullRequests({
    repository: REPO,
    token: 'job-token',
    fetch: async (url) => {
      seen.push(String(url));
      return new Response(JSON.stringify(body), { status });
    },
  });
  return { source, seen };
}

test('feat-003/AC-6 the sweep’s question is answered from the host’s live pull-request state', async () => {
  const { source, seen } = sourceAnswering(200, { state: 'closed' });

  const outcome = await source.state(REPO, 482);

  assert.deepEqual(outcome, { ok: true, state: 'closed' });
  assert.deepEqual(seen, ['https://api.github.com/repos/acme/widgets/pulls/482']);
});

test('feat-003/AC-9 a refused lookup names the missing permission', async () => {
  const { source } = sourceAnswering(403, {});
  const outcome = await source.state(REPO, 482);
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.match(outcome.problem, /pull-requests: read/);
});

test('feat-003/AC-9 a pull request the host cannot find is loud, not a shrug', async () => {
  const { source } = sourceAnswering(404, {});
  const outcome = await source.state(REPO, 482);
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.match(outcome.problem, /human/);
});

test('the source is pinned to its repository and refuses any other', async () => {
  const { source, seen } = sourceAnswering(200, { state: 'open' });
  const outcome = await source.state('someone/else', 1);
  assert.equal(outcome.ok, false);
  assert.deepEqual(seen, [], 'a cross-repository lookup went to the network');
});
