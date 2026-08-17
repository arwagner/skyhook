import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deploy, EXIT_CONSUMER_APPLY_FAILED } from '../src/cli/deploy.ts';
import { runCli } from '../src/cli/main.ts';
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

// --- exit statuses tell the two failures apart ---------------------------------

test('feat-002/AC-18 skyhook failing and the repository failing exit differently', async () => {
  // AC-18: a run that fails because the consuming repository's apply failed is
  // distinguishable, in its output AND its exit status, from a run that failed because
  // skyhook itself could not do its job. The status is a machine-readable difference; a
  // workflow can branch on it without parsing prose.
  assert.equal(EXIT_CONSUMER_APPLY_FAILED, 3);
  assert.notEqual(EXIT_CONSUMER_APPLY_FAILED, 1);

  // A skyhook-side failure — no token to read settings with — exits 1, not 3.
  const err = collect();
  const code = await deploy({
    env: env({ GITHUB_TOKEN: undefined }),
    repositoryRoot: '/tmp',
    runner: silentRunner,
    out: collect().sink,
    err: err.sink,
  });

  assert.equal(code, 1);
  assert.equal(err.lines.join(' ').includes('GITHUB_TOKEN'), true);
});

test('feat-002/AC-10 a fork run exits successfully and hands back an empty address', async () => {
  // AC-10: a pull request from a fork completes WITHOUT deploying and WITHOUT failing.
  const out = collect();
  const written = new Map<string, string>();
  const code = await deploy({
    env: env({ GITHUB_EVENT_PATH: join(import.meta.dirname, 'fixtures-fork.json') }),
    repositoryRoot: '/tmp',
    runner: silentRunner,
    out: out.sink,
    err: collect().sink,
    writeOutput: (name, value) => written.set(name, value),
  });

  assert.equal(code, 0);
  assert.equal(out.lines.join(' ').includes('fork'), true);
  assert.equal(written.get('url'), '');
  assert.equal(written.get('identity'), '');
});

// --- the command is reachable ----------------------------------------------------

test('cli: deploy is a command, and the usage says which exit status means what', async () => {
  const out = collect();
  const code = await runCli(['--help'], { out: out.sink, err: collect().sink });

  assert.equal(code, 0);
  const usage = out.lines.join('\n');
  assert.equal(usage.includes('skyhook deploy'), true);
  assert.equal(usage.includes('Exit 3'), true);
});

// --- what the calling workflow can read ------------------------------------------

test('feat-002/AC-15 the action declares the address as an output, wired to the step', async () => {
  // AC-15: the run exposes the environment's URL as an output available to the calling
  // workflow. Declaring the output is only half of it — it has to be wired to the step
  // that produces it, or a caller reads an empty string forever.
  //
  // Asserted against the file's text rather than through skyhook's own YAML reader: that
  // reader is a deliberate strict subset for `.skyhook/config.yml` and does not pretend
  // to handle block scalars or Actions expressions.
  const action = readFileSync(ACTION, 'utf8');

  for (const name of ['url', 'identity', 'skyhook-seconds']) {
    assert.match(action, new RegExp(`^  ${name}:$`, 'm'), `no output declared for ${name}`);
    assert.ok(
      action.includes(`value: \${{ steps.deploy.outputs.${name} }}`),
      `${name} is declared but not wired to the step that produces it`,
    );
  }
  // And the step it is wired to is the one that exists.
  assert.match(action, /^    - id: deploy$/m);
});

test('feat-002/AC-14 the action tells a maintainer both things the figure excludes', async () => {
  // AC-14 excludes two things and both are the repository's: the apply, and the init that
  // fetches what the definition needs. The description a maintainer actually reads named
  // only the first, which is `gap-001` in miniature — a text enumerating less than the
  // implementation does — on the one surface where being wrong misleads somebody outside
  // this repository.
  //
  // Held by a test rather than by care. This feature has shipped stale prose four times
  // (the role-assumption message, the deploy-role advice, and the two file headers
  // `gap-003` found), every one of them discovered by reading a real failure rather than
  // by review. Read flattened, so reflowing the block scalar does not fail this for a
  // reason nobody would believe.
  const flattened = readFileSync(ACTION, 'utf8').replace(/\s+/g, ' ');
  const described = flattened.slice(flattened.indexOf('skyhook-seconds:'));

  assert.match(described, /terraform apply/, 'the apply exclusion is unstated');
  assert.match(described, /terraform init/, 'the preparation exclusion is unstated');
  assert.match(described, /60/, 'the budget the figure is held to is unstated');
});

test('feat-002/AC-15 skyhook asks for no permission to write to a pull request', async () => {
  // AC-15: skyhook requests no permission to write to the pull request. It has no comment
  // format to own and no update-in-place semantics to get wrong — the address is handed
  // back and what happens to it is the calling workflow's decision.
  const action = readFileSync(ACTION, 'utf8');
  assert.equal(action.includes('pull-requests:'), false);

  // And nothing skyhook runs reaches for the API that writes to a pull request. Checked
  // by the endpoints it could call, not by the word "comment" — which appears in prose
  // explaining precisely that skyhook does not do this.
  for (const file of ['../src/cli/deploy.ts', '../src/adapters/github/config-source.ts']) {
    const source = readFileSync(new URL(file, import.meta.url).pathname, 'utf8');
    assert.equal(source.includes('/issues/'), false, `${file} reaches the issues API`);
    assert.equal(source.includes('/comments'), false, `${file} reaches the comments API`);
    assert.equal(source.includes('/reviews'), false, `${file} reaches the reviews API`);
  }
});

test('feat-002/AC-16 the action supplies the token the command refuses to run without', async () => {
  // Regression. `skyhook deploy` exits 1 unless GITHUB_TOKEN is set — it reads settings from the
  // default branch through the API, which is the whole of AC-16 — and the action shipped without
  // supplying it, so every real run would have failed on the first line for a reason no unit
  // test could see. The command's own tests pass the variable in themselves, which is exactly
  // how the gap survived them: an injected environment proves what skyhook does with a token,
  // never that anything hands it one.
  const action = readFileSync(ACTION, 'utf8');

  assert.match(action, /^  github-token:$/m, 'no github-token input declared');
  assert.match(
    action,
    /default: \$\{\{ github\.token \}\}/,
    'the input must default to the job token, so the scaffolded workflow needs no env: block',
  );

  // Declared is not enough — it has to reach the process that reads it.
  const step = action.slice(action.indexOf('- id: deploy'));
  assert.match(step, /env:\s*\n\s*GITHUB_TOKEN: \$\{\{ inputs\.github-token \}\}/, 'declared but never passed to the step');
});

test('feat-002/AC-15 the action runs the sources it ships, with a pinned Node', async () => {
  // No bundler and no committed dist/, so the artifact that runs is the source that was
  // reviewed. The Node major is pinned rather than inherited from the runner image, so an
  // image change cannot quietly alter what skyhook does.
  const action = readFileSync(ACTION, 'utf8');
  assert.equal(action.includes('using: composite'), true);
  assert.equal(action.includes('bin/skyhook.ts'), true);
  assert.equal(action.includes('actions/setup-node'), true);
  assert.equal(action.includes('node-version: ${{ inputs.node-version }}'), true);
});

test('feat-002/AC-1 the action installs the Terraform it shells out to', () => {
  // Found by the first live run. GitHub's images no longer ship Terraform, and skyhook got as
  // far as claiming and recording pr-1 before discovering it had nothing to apply with — an
  // environment on the books that never existed, which is the failure mode the whole ordering
  // in D7 exists to make survivable rather than impossible.
  //
  // Terraform is skyhook's dependency, not the consuming repository's to remember.
  const action = readFileSync(ACTION, 'utf8');
  assert.equal(action.includes('hashicorp/setup-terraform'), true, 'Terraform is installed');
  assert.equal(
    action.includes('terraform_version: ${{ inputs.terraform-version }}'),
    true,
    'and the consuming repository can pin which one',
  );
  // The wrapper rewrites stdout, and skyhook parses `terraform output -json` to learn the
  // environment's address. With it on, every deploy reports the address as unknown.
  assert.equal(action.includes('terraform_wrapper: false'), true, 'the stdout wrapper is off');
});

// --- the push-triggered long-running deploy (feat-006) ----------------------------

function pushEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return env({
    GITHUB_EVENT_NAME: 'push',
    GITHUB_EVENT_PATH: join(import.meta.dirname, 'fixtures-push.json'),
    GITHUB_REF: 'refs/heads/main',
    GITHUB_SHA: 'pushsha5678',
    SKYHOOK_ENVIRONMENT: 'staging',
    ...overrides,
  });
}

test('feat-006/AC-3 a chosen name in the ephemeral namespace exits non-zero before any network call', async () => {
  // The refusal happens before configuration is read and before any credential is asked
  // for — a network call of any kind fails this test, which is what "before recording or
  // applying anything" means at this seam.
  const err = collect();
  const code = await deploy({
    env: pushEnv({ SKYHOOK_ENVIRONMENT: 'pr-9' }),
    repositoryRoot: '/tmp',
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

test('feat-006/AC-1 the push deploy carries the chosen name, and says so when it is missing', async () => {
  // The wiring half of AC-1 at this seam: the chosen name is how a long-running
  // environment comes to exist, and a push run without one is told exactly what to set.
  // The full deploy is proven in the core tests and the live pass.
  const err = collect();
  const code = await deploy({
    env: pushEnv({ SKYHOOK_ENVIRONMENT: undefined }),
    repositoryRoot: '/tmp',
    runner: silentRunner,
    out: collect().sink,
    err: err.sink,
  });

  assert.equal(code, 1);
  assert.match(err.lines.join(' '), /SKYHOOK_ENVIRONMENT/);
});

test('feat-006/AC-6 a push to a non-default ref is refused, naming the ref the run needs', async () => {
  const err = collect();
  const code = await deploy({
    env: pushEnv({ GITHUB_REF: 'refs/heads/feature-x' }),
    repositoryRoot: '/tmp',
    runner: silentRunner,
    out: collect().sink,
    err: err.sink,
  });

  assert.equal(code, 1);
  assert.match(err.lines.join(' '), /refs\/heads\/main/);
});
