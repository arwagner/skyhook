import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { exitCodeForProtection, protect } from '../src/cli/protect.ts';
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
    ...overrides,
  };
}

test('feat-006/AC-9 the exit map: only an applied mark change succeeds', () => {
  // The outcomes themselves are proven against fakes in tests/protection.test.ts; the
  // CLI's contribution is wiring plus this mapping.
  assert.equal(exitCodeForProtection({ kind: 'applied', isProtected: true }), 0);
  assert.equal(exitCodeForProtection({ kind: 'applied', isProtected: false }), 0);
  assert.equal(exitCodeForProtection({ kind: 'no-record' }), 1);
  assert.equal(exitCodeForProtection({ kind: 'released' }), 1);
  assert.equal(exitCodeForProtection({ kind: 'failed', problem: 'x' }), 1);
});

test('protect without a token stops before doing anything', async () => {
  const err = collect();
  const code = await protect(true, {
    env: env({ GITHUB_TOKEN: undefined }),
    runner: silentRunner,
    out: collect().sink,
    err: err.sink,
  });
  assert.equal(code, 1);
  assert.match(err.lines.join(' '), /GITHUB_TOKEN/);
});

test('protect without an environment says exactly what to set', async () => {
  const err = collect();
  const code = await protect(true, {
    env: env({ SKYHOOK_ENVIRONMENT: undefined }),
    runner: silentRunner,
    out: collect().sink,
    err: err.sink,
  });
  assert.equal(code, 1);
  assert.match(err.lines.join(' '), /SKYHOOK_ENVIRONMENT/);
});

test('feat-006/AC-8 a dispatch against another ref is refused, naming the needed ref, before any network call', async () => {
  // The unprotect step AC-8 names has to actually work when a human follows it — and the
  // first way it would not is being dispatched against the wrong ref.
  const err = collect();
  const code = await protect(false, {
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

test('cli: protect and unprotect are commands, and take no arguments', async () => {
  const out = collect();
  await runCli(['--help'], { out: out.sink, err: collect().sink });
  const usage = out.lines.join('\n');
  assert.equal(usage.includes('skyhook protect'), true);
  assert.equal(usage.includes('skyhook unprotect'), true);

  const err = collect();
  const code = await runCli(['protect', '--surprise'], { out: collect().sink, err: err.sink });
  assert.equal(code, 2);
  assert.match(err.lines.join(' '), /SKYHOOK_ENVIRONMENT/);
});

// --- the gap-002 seam test: the success path through fakes ------------------------

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

test('feat-006/AC-9 gap-002: protect and unprotect reach applied through fakes, mark visible between', async () => {
  const store = new FakeStore();
  const registry = new Registry(store, { now: () => '2026-08-17T00:00:00.000Z' });
  const claimed = await registry.claim({ repository: 'acme/widgets', identity: 'staging' });
  assert.ok(claimed.ok);
  const open: ManualAccessOpener = async () => ({
    ok: true,
    access: {
      registry,
      store,
      destroyerFor: async () => ({ ok: false, problem: 'protection never needs a destroyer' }),
    },
  });
  const common = { runner: silentRunner, fetch: configFetch, openManualAccess: open };

  const out = collect();
  assert.equal(await protect(true, { env: env(), out: out.sink, err: collect().sink, ...common }), 0);
  assert.match(out.lines.join(' '), /is protected/);
  assert.deepEqual(await registry.isProtected('acme/widgets', 'staging'), { ok: true, isProtected: true });

  const out2 = collect();
  assert.equal(await protect(false, { env: env(), out: out2.sink, err: collect().sink, ...common }), 0);
  assert.match(out2.lines.join(' '), /no longer protected/);
  assert.deepEqual(await registry.isProtected('acme/widgets', 'staging'), { ok: true, isProtected: false });

  // And the released refusal reaches the CLI seam too (feat-006/AC-7).
  await registry.release('acme/widgets', 'staging', claimed.version);
  const err = collect();
  assert.equal(await protect(true, { env: env(), out: collect().sink, err: err.sink, ...common }), 1);
  assert.match(err.lines.join(' '), /awaiting teardown/);
});

test('feat-006/AC-12 chg-002 gap-003: a human marks and unmarks a pull-request preview', async () => {
  // Legitimized by chg-002 on the owner's ruling: marking is not creating, so the
  // ephemeral-namespace refusal (AC-3, deploys) does not apply here. The cloud still
  // refuses pull-request runs every mark write; this command rides default-branch access.
  const store = new FakeStore();
  const registry = new Registry(store, { now: () => '2026-08-17T00:00:00.000Z' });
  await registry.claim({ repository: 'acme/widgets', identity: 'pr-482' });
  const open: ManualAccessOpener = async () => ({
    ok: true,
    access: {
      registry,
      store,
      destroyerFor: async () => ({ ok: false, problem: 'protection never needs a destroyer' }),
    },
  });
  const common = { runner: silentRunner, fetch: configFetch, openManualAccess: open };
  const previewEnv = env({ SKYHOOK_ENVIRONMENT: 'pr-482' });

  assert.equal(await protect(true, { env: previewEnv, out: collect().sink, err: collect().sink, ...common }), 0);
  assert.deepEqual(await registry.isProtected('acme/widgets', 'pr-482'), { ok: true, isProtected: true });
  assert.equal(await protect(false, { env: previewEnv, out: collect().sink, err: collect().sink, ...common }), 0);
  assert.deepEqual(await registry.isProtected('acme/widgets', 'pr-482'), { ok: true, isProtected: false });
});
