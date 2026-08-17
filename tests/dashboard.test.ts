import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { EnvironmentRecord } from '../src/core/types.ts';
import {
  buildDashboardModel,
  renderDashboardPage,
  pullRequestFromIdentity,
} from '../src/core/dashboard.ts';

const REPO = 'acme/widgets';
const CAP = { enabled: true, limit: 5 } as const;

function record(overrides: Partial<EnvironmentRecord> & { identity: string }): EnvironmentRecord {
  return {
    repository: REPO,
    state: 'active',
    deployedCommit: 'abc123def456',
    url: 'https://pr-482.example.test',
    createdAt: '2026-08-14T00:00:00.000Z',
    updatedAt: '2026-08-15T12:30:00.000Z',
    ...overrides,
  };
}

// --- the list ---------------------------------------------------------------

test('feat-005/AC-1 lists every record with identity, PR number, state, protection, updatedAt, URL', () => {
  const records = [
    record({ identity: 'staging', url: 'https://staging.example.test' }),
    record({ identity: 'pr-482', state: 'released' }),
  ];
  const model = buildDashboardModel(REPO, records, ['staging'], CAP);

  assert.equal(model.rows.length, 2);
  // Sorted by identity, so the listing is stable across loads.
  assert.deepEqual(
    model.rows.map((r) => r.record.identity),
    ['pr-482', 'staging'],
  );

  const page = renderDashboardPage(model);
  for (const r of records) {
    assert.ok(page.includes(r.identity), `page names ${r.identity}`);
    assert.ok(page.includes(r.updatedAt), `page shows last-deployed time for ${r.identity}`);
  }
  assert.ok(page.includes('https://staging.example.test'));
  assert.ok(page.includes('482'), 'PR number derived from pr-482');
});

test('feat-005/AC-1 the PR number comes only from the pr-<number> naming convention', () => {
  assert.equal(pullRequestFromIdentity('pr-482'), 482);
  assert.equal(pullRequestFromIdentity('staging'), null);
  assert.equal(pullRequestFromIdentity('pr-'), null);
  assert.equal(pullRequestFromIdentity('pr-0482x'), null);
  assert.equal(pullRequestFromIdentity('PR-9'), null, 'the convention is lower-case');
});

// --- cap headroom -----------------------------------------------------------

test('feat-005/AC-2 cap enabled: shows used-of-limit, counted as record count', () => {
  const records = [record({ identity: 'pr-1' }), record({ identity: 'pr-2', state: 'released' })];
  const model = buildDashboardModel(REPO, records, [], CAP);
  assert.equal(model.used, 2, 'a released environment still counts — it is still standing');
  const page = renderDashboardPage(model);
  assert.ok(page.includes('2 of 5'), 'cap line shows M of N');
});

test('feat-005/AC-2 cap disabled: says so instead of showing a meter', () => {
  const model = buildDashboardModel(REPO, [record({ identity: 'pr-1' })], [], {
    enabled: false,
    limit: 5,
  });
  const page = renderDashboardPage(model);
  assert.ok(/no cap/i.test(page), 'names the absence of a cap');
  assert.ok(!page.includes('of 5'), 'no meter when the cap is off');
});

// --- freeable slots ---------------------------------------------------------

test('feat-005/AC-3 released+unprotected is reclaimable; protected is marked; active is neither', () => {
  const records = [
    record({ identity: 'pr-1', state: 'released' }),
    record({ identity: 'pr-2', state: 'released' }),
    record({ identity: 'pr-3', state: 'active' }),
  ];
  const model = buildDashboardModel(REPO, records, ['pr-2'], CAP);

  const byId = new Map(model.rows.map((r) => [r.record.identity, r]));
  assert.equal(byId.get('pr-1')?.reclaimable, true);
  assert.equal(byId.get('pr-1')?.isProtected, false);
  assert.equal(byId.get('pr-2')?.reclaimable, false, 'protected is never reclaimable');
  assert.equal(byId.get('pr-2')?.isProtected, true);
  assert.equal(byId.get('pr-3')?.reclaimable, false, 'active is in use, not freeable');

  const page = renderDashboardPage(model);
  assert.ok(/reclaimable/.test(page), 'the reclaimable row is visibly distinct');
  assert.ok(/protected/.test(page), 'the protected row is visibly marked');
});

// --- detail -----------------------------------------------------------------

test('feat-005/AC-4 each row anchors to a detail section holding the full record', () => {
  const model = buildDashboardModel(REPO, [record({ identity: 'pr-482' })], [], CAP);
  const page = renderDashboardPage(model);

  const href = page.match(/href="#(env-[^"]+)"/);
  assert.ok(href, 'the row links to a detail anchor');
  assert.ok(page.includes(`id="${href?.[1]}"`), 'the anchor resolves to a section on the page');

  for (const field of [
    REPO,
    'pr-482',
    'abc123def456',
    '482',
    'active',
    '2026-08-14T00:00:00.000Z',
    '2026-08-15T12:30:00.000Z',
    'https://pr-482.example.test',
  ]) {
    assert.ok(page.includes(field), `detail shows ${field}`);
  }
  assert.ok(
    page.includes('href="https://pr-482.example.test"'),
    'the URL is a working link',
  );
});

// --- empty state ------------------------------------------------------------

test('feat-005/AC-5 empty registry: explicit empty state with the cap line still shown', () => {
  const model = buildDashboardModel(REPO, [], [], CAP);
  const page = renderDashboardPage(model);
  assert.ok(/no environments/i.test(page), 'says there is nothing, explicitly');
  assert.ok(page.includes('0 of 5'), 'the cap line survives the empty state');
  assert.ok(!/error/i.test(page), 'an empty registry is not an error');
});

// --- pending fields ---------------------------------------------------------

test('feat-005/AC-6 unknown URL and commit render as pending, never a broken link', () => {
  const model = buildDashboardModel(
    REPO,
    [record({ identity: 'pr-9', url: null, deployedCommit: null })],
    [],
    CAP,
  );
  const page = renderDashboardPage(model);
  assert.ok(/pending/.test(page), 'null fields show an explicit placeholder');
  assert.ok(!page.includes('href=""'), 'no empty href');
  assert.ok(!/<a href="#env-[^"]*">[^<]*<\/a>\s*<a/.test(page), 'sanity: markup stays well-formed');
  const links = page.match(/<a href="(?!#)[^"]*"/g) ?? [];
  assert.equal(links.length, 0, 'no outbound link exists for a null URL');
});

// --- hostile record content (analyze S1) ------------------------------------

test('feat-005/AC-1 hostile record content renders inert: fields are escaped', () => {
  const model = buildDashboardModel(
    REPO,
    [
      record({
        identity: 'pr-666',
        deployedCommit: '<script>alert(1)</script>',
        url: 'https://ok.example.test/"><img src=x onerror=alert(1)>',
      }),
    ],
    [],
    CAP,
  );
  const page = renderDashboardPage(model);
  assert.ok(!page.includes('<script>alert(1)</script>'), 'script tags never reach the page raw');
  assert.ok(page.includes('&lt;script&gt;'), 'the content is escaped, not dropped');
  assert.ok(!page.includes('onerror=alert(1)>'), 'attribute breakout is escaped');
});

test('feat-005/AC-1 only http(s) URLs become links; other schemes render as inert text', () => {
  const model = buildDashboardModel(
    REPO,
    [record({ identity: 'pr-7', url: 'javascript:alert(1)' })],
    [],
    CAP,
  );
  const page = renderDashboardPage(model);
  assert.ok(!/href="javascript:/.test(page), 'a javascript: URL is never a href');
  assert.ok(page.includes('javascript:alert(1)'), 'the value is still visible, as text');
});
