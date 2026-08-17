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

// --- declared inputs at the CLI seam (chg-007) -----------------------------------

const INPUTS_CONFIG = `storage:
  bucket: skyhook-acme
  region: us-east-1
  account: "123456789012"

deploy:
  directory: infrastructure
  inputs:
    - image_tag
`;

const inputsConfigFetch: typeof globalThis.fetch = async (url) => {
  const target = String(url);
  if (target.includes('/contents/')) return new Response(INPUTS_CONFIG, { status: 200 });
  if (target.includes('/repos/')) {
    return new Response(JSON.stringify({ default_branch: 'main' }), { status: 200 });
  }
  throw new Error(`a declared-input refusal must not reach further than settings: ${target}`);
};

test('feat-002/AC-22 a missing declared input exits 1 — skyhook-side, not the consumer exit 3', async () => {
  // The refusal happens before any credential is requested: the fetch above throws on
  // anything but the settings read, and the runner counts what would have been STS calls.
  let commandsRun = 0;
  const countingRunner: CommandRunner = {
    run: async (): Promise<CommandResult> => {
      commandsRun += 1;
      return { code: 0, stdout: '', stderr: '' };
    },
  };
  const err = collect();
  const code = await deploy({
    env: env({
      GITHUB_EVENT_PATH: join(import.meta.dirname, 'fixtures-pull-request.json'),
      // TF_VAR_image_tag deliberately absent.
    }),
    repositoryRoot: '/tmp',
    runner: countingRunner,
    out: collect().sink,
    err: err.sink,
    fetch: inputsConfigFetch,
  });

  assert.equal(code, 1, 'a mis-wired workflow is a skyhook-side refusal');
  assert.notEqual(code, EXIT_CONSUMER_APPLY_FAILED);
  assert.match(err.lines.join(' '), /TF_VAR_image_tag/, 'names what the workflow must set');
  assert.equal(commandsRun, 0, 'no command ran — nothing was applied');
});

test('feat-002/AC-22 the value rides the run environment: set, the refusal does not fire', async () => {
  // With TF_VAR_image_tag present the run proceeds past the input check and fails later,
  // at credentials — proving the CLI wires the environment through as the value source.
  const err = collect();
  const code = await deploy({
    env: env({
      GITHUB_EVENT_PATH: join(import.meta.dirname, 'fixtures-pull-request.json'),
      TF_VAR_image_tag: 'abc123',
    }),
    repositoryRoot: '/tmp',
    runner: silentRunner,
    out: collect().sink,
    err: err.sink,
    fetch: inputsConfigFetch,
  });

  assert.equal(code, 1);
  assert.doesNotMatch(err.lines.join(' '), /TF_VAR_image_tag/, 'the input refusal did not fire');
});

// --- outputs, injection-safety, and size at the CLI seam (chg-008) ------------

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { deployOutputsFor, appendOutput } from '../src/cli/deploy.ts';

function deployedResult(outputs: {
  document: Record<string, unknown>;
  omittedSensitive: string[];
} | null) {
  return {
    kind: 'deployed' as const,
    identity: 'pr-482',
    commit: 'a1b2c3',
    url: 'https://pr-482.example',
    outputs,
    skyhookMs: 100,
    notes: [] as string[],
  };
}

test('feat-002/AC-24 outputs is one compact JSON line on success, {} for no outputs, "" on skip/fail', async () => {
  const written = new Map<string, string>();
  const w = (n: string, v: string) => written.set(n, v);

  deployOutputsFor(deployedResult({ document: { web_bucket: 'b', cdn: { id: 'E1' } }, omittedSensitive: [] }), w, () => {});
  const doc = written.get('outputs') ?? '';
  assert.equal(doc.includes('\n'), false, 'compact, single line');
  assert.deepEqual(JSON.parse(doc), { web_bucket: 'b', cdn: { id: 'E1' } });

  written.clear();
  deployOutputsFor(deployedResult({ document: {}, omittedSensitive: [] }), w, () => {});
  assert.equal(written.get('outputs'), '{}');

  written.clear();
  deployOutputsFor({ kind: 'skipped', message: 'fork' }, w, () => {});
  assert.equal(written.get('outputs'), '');
});

test('feat-002/AC-24 the omitted sensitive names are logged, their values never', async () => {
  const logs: string[] = [];
  deployOutputsFor(
    deployedResult({ document: { url: 'https://x' }, omittedSensitive: ['db_password'] }),
    () => {},
    (l) => logs.push(l),
  );
  assert.match(logs.join(' '), /db_password/);
});

test('feat-002/AC-25 a crafted value cannot inject a second output', () => {
  // A value engineered to reproduce the OLD length-derived marker and forge a second output.
  const name = 'url';
  const evil = `x\nskyhook-${name}-1\nurl_inject<<M\nowned\nM`;
  const dir = mkdtempSync(join(tmpdir(), 'skyhook-out-'));
  const file = join(dir, 'gh-output');
  writeFileSync(file, '');
  appendOutput({ GITHUB_OUTPUT: file }, name, evil);
  const body = readFileSync(file, 'utf8');
  // The heredoc is `url<<MARKER\n<value>\nMARKER\n`. The forged `url_inject<<M` line is inert
  // because it sits between the two random markers — only a line equal to MARKER closes it,
  // and the value cannot contain the random MARKER it never saw. Parse it the way the runner
  // does and assert exactly one output, its value the whole evil string.
  const nl = body.indexOf('\n');
  const header = body.slice(0, nl); // url<<MARKER
  const marker = header.slice(`${name}<<`.length);
  const rest = body.slice(nl + 1);
  const close = `\n${marker}\n`;
  const end = rest.indexOf(close);
  assert.ok(end >= 0, 'the value is closed by the random marker');
  assert.equal(rest.slice(0, end), evil, 'the whole crafted value is one inert value');
  assert.equal(rest.slice(end + close.length), '', 'nothing follows: no second output injected');
  rmSync(dir, { recursive: true, force: true });
});

test('feat-002/AC-26 an oversized document truncates to the reserved marker, deploy stays deployed', async () => {
  const written = new Map<string, string>();
  const logs: string[] = [];
  const huge = 'x'.repeat(1_100_000);
  deployOutputsFor(
    deployedResult({ document: { blob: huge }, omittedSensitive: [] }),
    (n, v) => written.set(n, v),
    (l) => logs.push(l),
  );
  const doc = JSON.parse(written.get('outputs') ?? '{}');
  assert.ok('__skyhook_truncated' in doc, 'the reserved key names the omission');
  assert.equal(doc.blob, undefined, 'the oversized content is gone');
  assert.ok(!(doc.__skyhook_truncated as string).includes('xxxxx'), 'the reason embeds no content');
  assert.match(logs.join(' '), /::warning::/);
});

test('feat-002/AC-24 action.yml declares the outputs output and no new permission', () => {
  const action = readFileSync(ACTION, 'utf8');
  assert.match(action, /^ {2}outputs:/m, 'the outputs output is declared');
  assert.match(action, /steps\.deploy\.outputs\.outputs/, 'wired to the deploy step');
  // The scaffolded action asks for nothing to write to a pull request, unchanged (AC-15).
  assert.equal(/pull-requests:\s*write/.test(action), false, 'no pull-request write permission');
  assert.equal(/permissions:/.test(action), false, 'the composite action declares no permissions block');
});
