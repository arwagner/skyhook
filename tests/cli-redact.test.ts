import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { redact } from '../src/cli/redact.ts';
import { runCli } from '../src/cli/main.ts';
import { FakeStore } from './fake-store.ts';
import { Registry } from '../src/core/registry.ts';
import type { ManualAccessOpener } from '../src/cli/teardown.ts';
import type { CommandResult, CommandRunner } from '../src/cli/process.ts';

const silentRunner: CommandRunner = {
  run: async (): Promise<CommandResult> => ({ code: 0, stdout: '', stderr: '' }),
};

function collect(): { lines: string[]; sink: (line: string) => void } {
  const lines: string[] = [];
  return { lines, sink: (line) => lines.push(line) };
}

function env(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    GITHUB_TOKEN: 'ghs_token',
    GITHUB_REPOSITORY: 'acme/widgets',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_EVENT_PATH: join(import.meta.dirname, 'fixtures-push.json'),
    GITHUB_REF: 'refs/heads/main',
    SKYHOOK_ENVIRONMENT: 'staging',
    SKYHOOK_INPUT_NAME: 'oops_conn',
    ...overrides,
  };
}

const CONFIG_YAML = `storage:
  bucket: skyhook-acme
  region: us-east-1
  account: "123456789012"

deploy:
  directory: infrastructure
`;

const configFetch: typeof globalThis.fetch = async (url) => {
  const target = String(url);
  if (target.includes('/contents/')) return new Response(CONFIG_YAML, { status: 200 });
  if (target.includes('/repos/')) {
    return new Response(JSON.stringify({ default_branch: 'main' }), { status: 200 });
  }
  throw new Error(`unexpected network call: ${target}`);
};

test('redact without an environment or input name says exactly what to set', async () => {
  const err = collect();
  let code = await redact({
    env: env({ SKYHOOK_ENVIRONMENT: undefined }),
    runner: silentRunner,
    out: collect().sink,
    err: err.sink,
  });
  assert.equal(code, 1);
  assert.match(err.lines.join(' '), /SKYHOOK_ENVIRONMENT/);

  const err2 = collect();
  code = await redact({
    env: env({ SKYHOOK_INPUT_NAME: undefined }),
    runner: silentRunner,
    out: collect().sink,
    err: err2.sink,
  });
  assert.equal(code, 1);
  assert.match(err2.lines.join(' '), /SKYHOOK_INPUT_NAME/);
});

test('feat-001/AC-37 a dispatch against another ref is refused before any network call', async () => {
  // The manual-dispatch surface protect already rides: a guardrail in the file a
  // maintainer reviews, and the ref check is its first tooth.
  const err = collect();
  const code = await redact({
    env: env({ GITHUB_REF: 'refs/heads/feature-x' }),
    runner: silentRunner,
    out: collect().sink,
    err: err.sink,
    fetch: async () => {
      throw new Error('a refused dispatch reached the network');
    },
  });
  assert.equal(code, 1);
  assert.match(err.lines.join(' '), /refs\/heads\/main/);
});

test('cli: redact is a command on the manual-dispatch surface', async () => {
  const out = collect();
  await runCli(['--help'], { out: out.sink, err: collect().sink });
  assert.equal(out.lines.join('\n').includes('skyhook redact'), true);

  const err = collect();
  const code = await runCli(['redact', '--surprise'], { out: collect().sink, err: err.sink });
  assert.equal(code, 2);
});

test('feat-001/AC-37 redacting through the CLI removes the one value and reports it', async () => {
  const store = new FakeStore();
  const registry = new Registry(store, { now: () => '2026-08-17T00:00:00.000Z' });
  const claimed = await registry.claim({ repository: 'acme/widgets', identity: 'staging' });
  assert.ok(claimed.ok);
  if (!claimed.ok) return;
  await registry.update('acme/widgets', 'staging', claimed.version, {
    deployedCommit: 'abc123',
    deployInputs: { image_tag: 'abc123', oops_conn: 'postgres://user:pw@host/db' },
  });

  const open: ManualAccessOpener = async () => ({
    ok: true,
    access: {
      registry,
      store,
      destroyerFor: async () => ({ ok: false, problem: 'redaction never needs a destroyer' }),
    },
  });

  const out = collect();
  const code = await redact({
    env: env(),
    runner: silentRunner,
    out: out.sink,
    err: collect().sink,
    fetch: configFetch,
    openManualAccess: open,
  });
  assert.equal(code, 0);
  assert.match(out.lines.join(' '), /oops_conn/);

  const read = await registry.read('acme/widgets', 'staging');
  assert.ok(read.ok && read.record !== null);
  if (!read.ok || read.record === null) return;
  assert.deepEqual(read.record.deployInputs, { image_tag: 'abc123' });
  assert.equal(read.record.state, 'active', 'content changed, never state');
});

test('feat-001/AC-37 redacting on an environment with no record fails, naming it', async () => {
  const store = new FakeStore();
  const registry = new Registry(store, { now: () => '2026-08-17T00:00:00.000Z' });
  const open: ManualAccessOpener = async () => ({
    ok: true,
    access: {
      registry,
      store,
      destroyerFor: async () => ({ ok: false, problem: 'redaction never needs a destroyer' }),
    },
  });
  const err = collect();
  const code = await redact({
    env: env(),
    runner: silentRunner,
    out: collect().sink,
    err: err.sink,
    fetch: configFetch,
    openManualAccess: open,
  });
  assert.equal(code, 1);
  assert.match(err.lines.join(' '), /staging/);
});
