import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig, loadConfig, DEFAULT_ENVIRONMENT_CAP } from '../src/core/config.ts';
import type { ConfigSource } from '../src/core/config.ts';

const STORAGE = ['storage:', '  bucket: skyhook-acme-widgets', '  region: eu-west-1'].join('\n');

test('config: defaults are applied when the cap is not configured', () => {
  const outcome = parseConfig(STORAGE);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.deepEqual(outcome.config.environmentCap, { enabled: true, limit: 5 });
  assert.deepEqual(DEFAULT_ENVIRONMENT_CAP, { enabled: true, limit: 5 });
  assert.deepEqual(outcome.config.storage, {
    bucket: 'skyhook-acme-widgets',
    region: 'eu-west-1',
    // Added by chg-007 and deliberately nullable: an installation written before the
    // deploy contract existed must still parse (feat-001/AC-31).
    account: null,
  });
});

test('config: the cap can be disabled entirely', () => {
  const outcome = parseConfig(`${STORAGE}\nenvironment_cap:\n  enabled: false\n`);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.config.environmentCap.enabled, false);
});

test('config: an explicit limit overrides the default', () => {
  const outcome = parseConfig(`${STORAGE}\nenvironment_cap:\n  enabled: true\n  limit: 12\n`);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.deepEqual(outcome.config.environmentCap, { enabled: true, limit: 12 });
});

test('config: comments and blank lines are ignored', () => {
  const document = ['# skyhook settings', '', STORAGE, '', 'environment_cap:', '  limit: 3  # keep it small'].join(
    '\n',
  );
  const outcome = parseConfig(document);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.deepEqual(outcome.config.environmentCap, { enabled: true, limit: 3 });
});

test('config: a misspelled setting is refused rather than silently ignored', () => {
  // Falling back to the default here would be the difference between a cap of 20 and
  // a cap of 5, and nobody would notice until the bill arrived.
  const outcome = parseConfig(`${STORAGE}\nenvironment_cap:\n  limt: 20\n`);
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.ok(outcome.problems.some((p) => p.includes('limt')));
});

test('config: a non-numeric or zero cap limit is refused', () => {
  for (const bad of ['many', '0', '-1', '2.5']) {
    const outcome = parseConfig(`${STORAGE}\nenvironment_cap:\n  limit: ${bad}\n`);
    assert.equal(outcome.ok, false, `expected "${bad}" to be refused`);
  }
});

test('config: storage is required and must name a bucket', () => {
  const missing = parseConfig('environment_cap:\n  limit: 3\n');
  assert.equal(missing.ok, false);

  const empty = parseConfig('storage:\n  bucket: ""\n  region: eu-west-1\n');
  assert.equal(empty.ok, false);
});

test('config: an absent config file is reported, not defaulted', () => {
  const outcome = parseConfig(null);
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.ok(outcome.problems[0]?.includes('.skyhook/config.yml'));
});

test('config: malformed indentation is refused with the offending line', () => {
  const outcome = parseConfig('storage:\n   bucket: b\n');
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.ok(outcome.problems.some((p) => p.startsWith('line 2:')));
});

test('config: a source that fails to fetch surfaces the problem', async () => {
  const source: ConfigSource = {
    fetch: async () => ({ ok: false, problem: 'default branch unreachable' }),
  };
  const outcome = await loadConfig(source);
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.deepEqual(outcome.problems, ['default branch unreachable']);
});

test('config: a source that returns a document parses through loadConfig', async () => {
  const source: ConfigSource = { fetch: async () => ({ ok: true, document: STORAGE }) };
  const outcome = await loadConfig(source);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.config.storage.bucket, 'skyhook-acme-widgets');
});

// --- the deploy contract (chg-007) ------------------------------------------

const DEPLOY_STORAGE = `storage:
  bucket: skyhook-acme
  region: us-east-1
`;

test('feat-001/AC-31 the deploy settings are absent-tolerant, so an older installation still parses', () => {
  // Both additions are optional at the top level. An installation written before this
  // change must keep running bootstrap and destruct unchanged — only a deploy needs them,
  // and only a deploy complains. Making them required would break two shipped commands to
  // serve a third.
  const parsed = parseConfig(DEPLOY_STORAGE);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.ok && parsed.config.deploy, null);
  assert.equal(parsed.ok && parsed.config.storage.account, null);
});

test('feat-001/AC-31 configuration carries the account and where the repository\'s own infrastructure lives', () => {
  const parsed = parseConfig(`storage:
  bucket: skyhook-acme
  region: us-east-1
  account: "123456789012"

deploy:
  directory: infrastructure
`);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.ok && parsed.config.storage.account, '123456789012');
  assert.equal(parsed.ok && parsed.config.deploy?.directory, 'infrastructure');
  // The role prefix follows the bootstrap's name_prefix, and defaults with it, so the
  // common installation names no role at all.
  assert.equal(parsed.ok && parsed.config.deploy?.rolePrefix, 'skyhook');
});

test('feat-001/AC-31 a deploy block that names no directory is refused, not defaulted', () => {
  // Guessing where a repository keeps its infrastructure would mean applying the wrong
  // directory, silently, with credentials that can create real resources.
  const parsed = parseConfig(`${DEPLOY_STORAGE}
deploy:
  role_prefix: acme
`);
  assert.equal(parsed.ok, false);
  assert.ok(!parsed.ok && parsed.problems.some((p) => p.includes('deploy.directory')));
});

test('feat-001/AC-31 an unrecognized setting inside the deploy block is still an error', () => {
  const parsed = parseConfig(`${DEPLOY_STORAGE}
deploy:
  directory: infra
  role_arn: arn:aws:iam::1:role/x
`);
  assert.equal(parsed.ok, false);
  assert.ok(!parsed.ok && parsed.problems.some((p) => p.includes('deploy.role_arn')));
});

test('feat-002/AC-16 every setting a deploy reads arrives through the same fetched source', async () => {
  // AC-16: the settings this feature adds are read from the default branch, like every
  // other setting. They are not read from disk and have no separate loader — they come
  // through the one ConfigSource seam, which the GitHub adapter pins to the default
  // branch (feat-001/AC-9). A second path here would be a second place to get it wrong.
  const source: ConfigSource = {
    fetch: async () => ({
      ok: true,
      document: `storage:
  bucket: skyhook-acme
  region: us-east-1
  account: "123456789012"

deploy:
  directory: infra
  role_prefix: acme
`,
    }),
  };
  const loaded = await loadConfig(source);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.ok && loaded.config.storage.account, '123456789012');
  assert.equal(loaded.ok && loaded.config.deploy?.directory, 'infra');
  assert.equal(loaded.ok && loaded.config.deploy?.rolePrefix, 'acme');
});

// --- declared deploy inputs (chg-011) ---------------------------------------

const DEPLOY = ['deploy:', '  directory: infra'].join('\n');

test('feat-001/AC-35 deploy.inputs parses as a list of names', () => {
  const outcome = parseConfig(
    `${STORAGE}\n${DEPLOY}\n  inputs:\n    - image_tag\n    - speech_image\n`,
  );
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.deepEqual(outcome.config.deploy?.inputs, ['image_tag', 'speech_image']);
});

test('feat-001/AC-35 an absent inputs list means none, and older deploy blocks still parse', () => {
  const outcome = parseConfig(`${STORAGE}\n${DEPLOY}\n`);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.deepEqual(outcome.config.deploy?.inputs, []);
});

test('feat-001/AC-35 a name outside the identifier shape is refused by name', () => {
  const outcome = parseConfig(`${STORAGE}\n${DEPLOY}\n  inputs:\n    - 9lives\n`);
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.ok(
    outcome.problems.some((p) => p.includes('9lives')),
    `the refusal names the offender: ${outcome.problems.join('; ')}`,
  );
});

test('feat-001/AC-35 a duplicated name is refused by name', () => {
  const outcome = parseConfig(
    `${STORAGE}\n${DEPLOY}\n  inputs:\n    - image_tag\n    - image_tag\n`,
  );
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.ok(outcome.problems.some((p) => p.includes('image_tag')));
});

test('feat-001/AC-35 more than 16 names are refused', () => {
  const names = Array.from({ length: 17 }, (_, i) => `    - input_${i}`).join('\n');
  const outcome = parseConfig(`${STORAGE}\n${DEPLOY}\n  inputs:\n${names}\n`);
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.ok(outcome.problems.some((p) => p.includes('16')));
});

test('feat-001/AC-35 a sensitive name is refused without a per-name exception', () => {
  const outcome = parseConfig(`${STORAGE}\n${DEPLOY}\n  inputs:\n    - api_token\n`);
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.ok(outcome.problems.some((p) => p.includes('api_token')));
});

test('feat-001/AC-35 the per-name exception admits exactly the named input', () => {
  const outcome = parseConfig(
    `${STORAGE}\n${DEPLOY}\n  inputs:\n    - api_token\n` +
      `  allow_sensitive_input_names:\n    - api_token\n`,
  );
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.deepEqual(outcome.config.deploy?.inputs, ['api_token']);
});

test('feat-001/AC-35 an exception naming nothing declared is refused as a likely typo', () => {
  const outcome = parseConfig(
    `${STORAGE}\n${DEPLOY}\n  inputs:\n    - image_tag\n` +
      `  allow_sensitive_input_names:\n    - api_token\n`,
  );
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.ok(outcome.problems.some((p) => p.includes('api_token')));
});

// --- pool (feat-007) ---------------------------------------------------------

test('feat-007/AC-1 no pool setting means pooling is off', () => {
  const outcome = parseConfig(STORAGE);
  assert.ok(outcome.ok);
  if (outcome.ok) assert.equal(outcome.config.pool, null);
});

test('feat-007/AC-1 a pool target of zero is pooling off, not a pool of nothing', () => {
  const outcome = parseConfig(`${STORAGE}\npool:\n  target: 0\n`);
  assert.ok(outcome.ok);
  if (outcome.ok) assert.equal(outcome.config.pool, null);
});

test('feat-007 pool.target is read as a whole positive number', () => {
  const outcome = parseConfig(`${STORAGE}\npool:\n  target: 2\n`);
  assert.ok(outcome.ok);
  if (outcome.ok) assert.deepEqual(outcome.config.pool, { target: 2 });
});

test('feat-007 a malformed pool target is refused loudly, never defaulted', () => {
  for (const bad of ['target: -1', 'target: 1.5', 'target: two']) {
    const outcome = parseConfig(`${STORAGE}\npool:\n  ${bad}\n`);
    assert.equal(outcome.ok, false, bad);
    if (!outcome.ok) {
      assert.ok(
        outcome.problems.some((p) => p.includes('pool.target')),
        `${bad}: ${outcome.problems.join('; ')}`,
      );
    }
  }
  const missing = parseConfig(`${STORAGE}\npool:\n  targets: 2\n`);
  assert.equal(missing.ok, false);
});
