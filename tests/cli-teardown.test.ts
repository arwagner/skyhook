import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  EXIT_CONSUMER_DESTROY_FAILED,
  exitCodeForManualTeardown,
  exitCodeForTeardown,
  teardown,
  type ManualAccessOpener,
} from '../src/cli/teardown.ts';
import { runCli } from '../src/cli/main.ts';
import { FakeStore } from './fake-store.ts';
import { FakeDestroyer } from './fake-destroyer.ts';
import { Registry, protectionKeyFor, registryKeyFor, stateDirFor } from '../src/core/registry.ts';
import type { CommandResult, CommandRunner } from '../src/cli/process.ts';

const ACTION = new URL('../action.yml', import.meta.url).pathname;

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
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_EVENT_PATH: join(import.meta.dirname, 'fixtures-nonexistent.json'),
    ...overrides,
  };
}

test('feat-003/AC-3 a fork pull request’s close skips cleanly, with no cloud access asked for', async () => {
  const out = collect();
  const code = await teardown({
    env: env({ GITHUB_EVENT_PATH: join(import.meta.dirname, 'fixtures-fork.json') }),
    runner: silentRunner,
    out: out.sink,
    err: collect().sink,
    // Any network call at all fails the test: a fork run holds no credentials to use.
    fetch: async () => {
      throw new Error('a fork close reached the network');
    },
  });

  assert.equal(code, 0);
  assert.match(out.lines.join(' '), /fork/);
  assert.match(out.lines.join(' '), /nothing to tear down/i);
});

test('feat-003/AC-2 the exit map: every left-standing outcome succeeds; failures split by whose they are', async () => {
  // The CLI's whole contribution is wiring plus this mapping (plan D8); the outcomes
  // themselves are proven against fakes in the core tests.
  assert.equal(exitCodeForTeardown({ kind: 'nothing' }), 0);
  assert.equal(exitCodeForTeardown({ kind: 'destroyed', notes: [] }), 0);
  assert.equal(exitCodeForTeardown({ kind: 'left-standing-protected' }), 0);
  assert.equal(exitCodeForTeardown({ kind: 'reactivated', notes: [] }), 0);
  assert.equal(exitCodeForTeardown({ kind: 'protection-unknown', problem: 'denied' }), 1);
  assert.equal(exitCodeForTeardown({ kind: 'failed', consumer: false, problem: 'x' }), 1);
  assert.equal(
    exitCodeForTeardown({ kind: 'failed', consumer: true, problem: 'x' }),
    EXIT_CONSUMER_DESTROY_FAILED,
  );
});

test('teardown without a token stops before doing anything', async () => {
  const err = collect();
  const code = await teardown({
    env: env({ GITHUB_TOKEN: undefined }),
    runner: silentRunner,
    out: collect().sink,
    err: err.sink,
  });
  assert.equal(code, 1);
  assert.match(err.lines.join(' '), /GITHUB_TOKEN/);
});

test('the CLI knows the verb and refuses arguments it does not have', async () => {
  const err = collect();
  const code = await runCli(['teardown', '--surprise'], { out: collect().sink, err: err.sink });
  assert.equal(code, 2);
  assert.match(err.lines.join(' '), /--environment/);
});

test('feat-003/AC-12 the action dispatches close events to teardown and schedules to sweep', async () => {
  const action = readFileSync(ACTION, 'utf8');
  assert.match(action, /github\.event_name == 'schedule' && 'sweep'/);
  assert.match(action, /github\.event\.action == 'closed' && 'teardown'/);
  assert.match(action, /\|\| 'deploy'/);
  assert.match(action, /"\$SKYHOOK_COMMAND"/);
});

// --- the manual teardown of a long-running environment (feat-006) -----------------

test('feat-006/AC-8 the manual exit map: a protected refusal is non-zero, everything else as the close path', async () => {
  // On the manual path a refusal is the answer to a direct order, not policy quietly
  // honored — the one changed row (plan D5).
  assert.equal(exitCodeForManualTeardown({ kind: 'left-standing-protected' }), 1);
  assert.equal(exitCodeForManualTeardown({ kind: 'destroyed', notes: [] }), 0);
  assert.equal(exitCodeForManualTeardown({ kind: 'nothing' }), 0);
  assert.equal(exitCodeForManualTeardown({ kind: 'protection-unknown', problem: 'denied' }), 1);
  assert.equal(exitCodeForManualTeardown({ kind: 'failed', consumer: false, problem: 'x' }), 1);
  assert.equal(
    exitCodeForManualTeardown({ kind: 'failed', consumer: true, problem: 'x' }),
    EXIT_CONSUMER_DESTROY_FAILED,
  );
});

test('feat-006/AC-6 a manual teardown dispatched against another ref is refused, naming the needed ref', async () => {
  const err = collect();
  const code = await teardown({
    env: env({
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_EVENT_PATH: join(import.meta.dirname, 'fixtures-push.json'),
      GITHUB_REF: 'refs/heads/feature-x',
      SKYHOOK_ENVIRONMENT: 'staging',
    }),
    runner: silentRunner,
    out: collect().sink,
    err: err.sink,
    fetch: async () => {
      throw new Error('a refused dispatch reached the network');
    },
  });

  assert.equal(code, 1);
  assert.match(err.lines.join(' '), /refs\/heads\/main/);
  assert.match(err.lines.join(' '), /refs\/heads\/feature-x/);
});

test('feat-006/AC-6 a manual teardown naming the ephemeral namespace is refused before any network call', async () => {
  const err = collect();
  const code = await teardown({
    env: env({
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_EVENT_PATH: join(import.meta.dirname, 'fixtures-push.json'),
      GITHUB_REF: 'refs/heads/main',
      SKYHOOK_ENVIRONMENT: 'pr-9',
    }),
    runner: silentRunner,
    out: collect().sink,
    err: err.sink,
    fetch: async () => {
      throw new Error('a refused name reached the network');
    },
  });

  assert.equal(code, 1);
  assert.match(err.lines.join(' '), /ephemeral namespace/);
});

test('cli: teardown accepts --environment and hands it to the manual path', async () => {
  // Proven by where it fails: with an environment named, the run takes the manual path
  // and stops at configuration (no token here means no settings), never the close path's
  // "closed pull request" reading.
  const err = collect();
  const code = await teardown({
    env: env({
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_EVENT_PATH: join(import.meta.dirname, 'fixtures-push.json'),
      GITHUB_REF: 'refs/heads/main',
    }),
    environment: 'staging',
    runner: silentRunner,
    out: collect().sink,
    err: err.sink,
    fetch: async () => new Response('not found', { status: 404 }),
  });

  assert.equal(code, 1);
  assert.match(err.lines.join(' '), /configuration/);
});

test('feat-006/AC-6 the action routes pushes to deploy and dispatches to the command input', async () => {
  const action = readFileSync(ACTION, 'utf8');
  assert.match(action, /github\.event_name == 'push' && 'deploy'/);
  assert.match(action, /github\.event_name == 'workflow_dispatch' && inputs\.command/);
  // The chosen name reaches the CLI, whatever the verb.
  assert.match(action, /SKYHOOK_ENVIRONMENT: \$\{\{ inputs\.environment \}\}/);
  // The dispatch row sits above the close row: a dispatched teardown must never be
  // re-read as a close event's, and order is how a chained || expression decides.
  assert.ok(
    action.indexOf("workflow_dispatch' && inputs.command") < action.indexOf("github.event.action == 'closed'"),
    'the dispatch row must precede the close row',
  );
});

// --- chg-001 and the gap-002 seam tests (feat-006) --------------------------------

const CONFIG_YAML = `storage:
  bucket: skyhook-acme
  region: us-east-1
  account: "123456789012"

deploy:
  directory: infrastructure
`;

/** Answers the two GitHub API calls settings-loading makes; everything else is refused. */
const configFetch: typeof globalThis.fetch = async (url) => {
  const target = String(url);
  if (target.includes('/contents/')) return new Response(CONFIG_YAML, { status: 200 });
  if (target.includes('/repos/')) {
    return new Response(JSON.stringify({ default_branch: 'main' }), { status: 200 });
  }
  throw new Error(`unexpected network call: ${target}`);
};

function seededAccess(options: { protectedMark?: boolean } = {}): {
  store: FakeStore;
  registry: Registry;
  destroyer: FakeDestroyer;
  open: ManualAccessOpener;
} {
  const store = new FakeStore();
  const registry = new Registry(store, {
    now: () => '2026-08-17T00:00:00.000Z',
  });
  store.seed(
    registryKeyFor('acme/widgets', 'staging'),
    JSON.stringify({
      schemaVersion: 1,
      repository: 'acme/widgets',
      identity: 'staging',
      state: 'active',
      deployedCommit: 'a1b2c3d4',
      url: null,
      createdAt: '2026-08-16T00:00:00.000Z',
      updatedAt: '2026-08-16T00:00:00.000Z',
    }),
  );
  store.seed(`${stateDirFor('acme/widgets', 'staging')}terraform.tfstate`, '{"resources":[]}');
  if (options.protectedMark === true) {
    store.seed(protectionKeyFor('acme/widgets', 'staging'), '2026-08-17T00:00:00.000Z');
  }
  const destroyer = new FakeDestroyer();
  const open: ManualAccessOpener = async () => ({
    ok: true,
    access: { registry, store, destroyerFor: async () => ({ ok: true, destroyer }) },
  });
  return { store, registry, destroyer, open };
}

function dispatchEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return env({
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_EVENT_PATH: join(import.meta.dirname, 'fixtures-push.json'),
    GITHUB_REF: 'refs/heads/main',
    SKYHOOK_ENVIRONMENT: 'staging',
    ...overrides,
  });
}

test('feat-006/AC-11 chg-001: a close event carrying an environment name still takes the close fast path', async () => {
  // Observed live before the guard existed (deadweight run 31980769653): the scaffolded
  // workflow exports SKYHOOK_ENVIRONMENT on every event once the push deploy is on, and
  // the close event took the manual path and refused on the wrong ref, leaking the
  // preview until the sweep. The carried name must be ignored; only a dispatch (or an
  // explicit --environment flag) engages the manual path. The fork-close fixture proves
  // the path taken: the close path answers "nothing to tear down" and exits 0 with no
  // network call, where the manual path would have refused on the ref.
  const out = collect();
  const err = collect();
  const code = await teardown({
    env: env({
      GITHUB_EVENT_PATH: join(import.meta.dirname, 'fixtures-fork.json'),
      GITHUB_REF: 'refs/pull/8/merge',
      SKYHOOK_ENVIRONMENT: 'staging',
    }),
    runner: silentRunner,
    out: out.sink,
    err: err.sink,
    fetch: async () => {
      throw new Error('the close path asked the network for a carried name');
    },
  });

  assert.equal(code, 0);
  assert.match(out.lines.join(' '), /nothing to tear down/i);
  assert.equal(err.lines.join(' ').includes('refs/heads/main'), false);
});

test('feat-006/AC-6 gap-002: the manual teardown reaches destroyed through fakes and frees the name', async () => {
  const { store, open } = seededAccess();
  const out = collect();
  const code = await teardown({
    env: dispatchEnv(),
    runner: silentRunner,
    out: out.sink,
    err: collect().sink,
    fetch: configFetch,
    openManualAccess: open,
  });

  assert.equal(code, 0);
  assert.match(out.lines.join(' '), /Destroyed staging/);
  assert.match(out.lines.join(' '), /name is free/);
  assert.equal(store.rawValue(registryKeyFor('acme/widgets', 'staging')), undefined);
});

test('feat-006/AC-8 gap-002: protected refuses non-zero at the CLI seam; cleared, the same teardown succeeds', async () => {
  const { store, registry, open } = seededAccess({ protectedMark: true });

  const err = collect();
  const refused = await teardown({
    env: dispatchEnv(),
    runner: silentRunner,
    out: collect().sink,
    err: err.sink,
    fetch: configFetch,
    openManualAccess: open,
  });
  assert.equal(refused, 1);
  assert.match(err.lines.join(' '), /protection mark/);
  assert.match(err.lines.join(' '), /unprotect/);
  assert.notEqual(store.rawValue(registryKeyFor('acme/widgets', 'staging')), undefined);

  await registry.setProtected('acme/widgets', 'staging', false);
  const out = collect();
  const succeeded = await teardown({
    env: dispatchEnv(),
    runner: silentRunner,
    out: out.sink,
    err: collect().sink,
    fetch: configFetch,
    openManualAccess: open,
  });
  assert.equal(succeeded, 0);
  assert.match(out.lines.join(' '), /Destroyed staging/);
});

test('feat-003/AC-15 feat-001/AC-37 the MANUAL starter replays recorded inputs — verified, not assumed shared', async () => {
  // feat-006's own precedent for shared-machinery changes: the third starter gets its
  // own regression rather than inheriting the claim from the close and sweep tests.
  const { store, registry, destroyer, open } = seededAccess();
  const key = registryKeyFor('acme/widgets', 'staging');
  const seeded = JSON.parse(store.rawValue(key) ?? '{}') as Record<string, unknown>;
  store.seed(key, JSON.stringify({ ...seeded, deployInputs: { image_tag: 'a1b2c3d4' } }));
  void registry;

  const code = await teardown({
    env: dispatchEnv(),
    runner: silentRunner,
    out: collect().sink,
    err: collect().sink,
    fetch: configFetch,
    openManualAccess: open,
  });

  assert.equal(code, 0);
  assert.deepEqual(destroyer.requests[0]?.deployInputs, { image_tag: 'a1b2c3d4' });
});
