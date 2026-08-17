import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TerraformEnvironment } from '../src/adapters/terraform/environment.ts';
import type { CommandResult, CommandRunner, RunOptions } from '../src/cli/process.ts';
import { FakeStore } from './fake-store.ts';
import type { Store } from '../src/core/store.ts';

const REPO = 'acme/widgets';
const ID = 'pr-482';
const STATE_KEY = `state/${REPO}/${ID}/terraform.tfstate`;

class RecordingRunner implements CommandRunner {
  readonly calls: Array<{ args: readonly string[]; options: RunOptions | undefined }> = [];
  readonly #results: Map<string, CommandResult> = new Map();

  respondTo(firstArg: string, result: CommandResult): void {
    this.#results.set(firstArg, result);
  }

  async run(_command: string, args: readonly string[], options?: RunOptions): Promise<CommandResult> {
    this.calls.push({ args, options });
    return this.#results.get(args[0] ?? '') ?? { code: 0, stdout: '', stderr: '' };
  }
}

/** A definition directory whose backend record says init landed where skyhook pointed it. */
function definitionDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), 'skyhook-destroy-'));
  writeFileSync(join(dir, 'main.tf'), 'resource "null_resource" "x" {}');
  mkdirSync(join(dir, '.terraform'));
  writeFileSync(
    join(dir, '.terraform', 'terraform.tfstate'),
    JSON.stringify({
      backend: { type: 's3', config: { bucket: 'skyhook-acme', workspace_key_prefix: `state/${REPO}` } },
    }),
  );
  return dir;
}

function destroyerUnder(dir: string, runner: CommandRunner, store: Store = new FakeStore()): TerraformEnvironment {
  return new TerraformEnvironment({
    runner,
    repositoryRoot: '/nowhere-a-destroy-should-look',
    bucket: 'skyhook-acme',
    region: 'us-east-1',
    backendCredentials: { accessKeyId: 'BACKEND', secretAccessKey: 'bs', sessionToken: 'bt' },
    deployCredentials: { accessKeyId: 'DEPLOY', secretAccessKey: 'ds', sessionToken: 'dt' },
    store,
    definitionDirectory: dir,
  });
}

test('feat-003/AC-1 a destroy selects the workspace by identity and passes no variable', async () => {
  const dir = definitionDirectory();
  const runner = new RecordingRunner();

  const outcome = await destroyerUnder(dir, runner).destroy({ repository: REPO, identity: ID });

  assert.equal(outcome.ok, true);
  const workspace = runner.calls.find((c) => c.args[0] === 'workspace');
  assert.deepEqual(workspace?.args, ['workspace', 'select', '-or-create=true', ID]);
  const destroy = runner.calls.find((c) => c.args[0] === 'destroy');
  assert.ok(destroy !== undefined, 'terraform destroy never ran');
  assert.ok(destroy.args.includes('-auto-approve'));
  for (const call of runner.calls) {
    assert.equal(call.args.includes('-var'), false, `-var passed in: ${call.args.join(' ')}`);
  }
  // The providers run as the deploy role; the backend rides its own flags.
  assert.equal(destroy.options?.env?.['AWS_ACCESS_KEY_ID'], 'DEPLOY');
  const init = runner.calls.find((c) => c.args[0] === 'init');
  assert.ok(init?.args.includes(`-backend-config=workspace_key_prefix=state/${REPO}`));
  assert.equal(existsSync(join(dir, 'zz_skyhook_backend.tf')), false, 'the backend file survived');
});

test('feat-003/AC-1 a definition carrying an override file is refused before anything runs', async () => {
  // The checked-out definition is the same attacker-authored code a deploy faces, so the
  // same hijack refusals gate the destroy (plan D5).
  const dir = definitionDirectory();
  writeFileSync(join(dir, 'zzz_override.tf'), 'terraform { backend "local" {} }');
  const runner = new RecordingRunner();

  const outcome = await destroyerUnder(dir, runner).destroy({ repository: REPO, identity: ID });

  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.reason, 'skyhook-failed');
    assert.match(outcome.problem, /override/);
  }
  assert.equal(runner.calls.length, 0, 'terraform ran against a hijacked definition');
});

test('feat-003/AC-1 an initialized backend that is not skyhook’s stops the destroy', async () => {
  const dir = definitionDirectory();
  writeFileSync(
    join(dir, '.terraform', 'terraform.tfstate'),
    JSON.stringify({ backend: { type: 'local', config: {} } }),
  );
  const runner = new RecordingRunner();

  const outcome = await destroyerUnder(dir, runner).destroy({ repository: REPO, identity: ID });

  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.match(outcome.problem, /backend/);
  assert.equal(runner.calls.some((c) => c.args[0] === 'destroy'), false, 'the destroy still ran');
});

test('feat-003/AC-9 a failing destroy is the repository’s own failure, and says the sweep retries', async () => {
  const dir = definitionDirectory();
  const runner = new RecordingRunner();
  runner.respondTo('destroy', { code: 1, stdout: '', stderr: 'Error: instance refuses' });

  const outcome = await destroyerUnder(dir, runner).destroy({ repository: REPO, identity: ID });

  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.reason, 'consumer-destroy-failed');
    assert.match(outcome.problem, /sweep/);
  }
});

test('residual state: missing or resource-free state is empty; anything else is not', async () => {
  // feat-003 plan D6 step 4: the gate that keeps a phantom-success destroy from minting an
  // untraceable orphan. Missing state counts as empty — no state is exactly what a
  // completed environment leaves.
  const dir = definitionDirectory();
  const runner = new RecordingRunner();
  const store = new FakeStore();
  const destroyer = destroyerUnder(dir, runner, store);
  const request = { repository: REPO, identity: ID };

  assert.deepEqual(await destroyer.residualResources(request), { ok: true, empty: true });

  store.seed(STATE_KEY, JSON.stringify({ resources: [] }));
  assert.deepEqual(await destroyer.residualResources(request), { ok: true, empty: true });

  store.seed(STATE_KEY, JSON.stringify({ resources: [{ type: 'aws_instance' }] }));
  assert.deepEqual(await destroyer.residualResources(request), { ok: true, empty: false });

  store.seed(STATE_KEY, 'not json at all');
  const unreadable = await destroyer.residualResources(request);
  assert.equal(unreadable.ok, false);
});

test('a destroyer built without a definition directory refuses rather than guessing one', async () => {
  const runner = new RecordingRunner();
  const destroyer = new TerraformEnvironment({
    runner,
    repositoryRoot: '/somewhere',
    bucket: 'skyhook-acme',
    region: 'us-east-1',
    backendCredentials: { accessKeyId: 'B', secretAccessKey: 'b', sessionToken: 'b' },
    deployCredentials: { accessKeyId: 'D', secretAccessKey: 'd', sessionToken: 'd' },
    store: new FakeStore(),
  });

  const outcome = await destroyer.destroy({ repository: REPO, identity: ID });

  assert.equal(outcome.ok, false);
  assert.equal(runner.calls.length, 0);
});
