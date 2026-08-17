import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrap, parseRepository, BOOTSTRAP_STATE_KEY } from '../src/cli/bootstrap.ts';
import type { CommandResult, CommandRunner } from '../src/cli/process.ts';

/**
 * The runner is injected, so these drive the real command and record what it *would* run.
 * Nothing here executes terraform or touches a cloud account.
 */

interface Invocation {
  readonly command: string;
  readonly args: readonly string[];
}

function fakeRunner(
  respond: (call: Invocation) => Partial<CommandResult> = () => ({}),
): { runner: CommandRunner; calls: Invocation[] } {
  const calls: Invocation[] = [];
  const runner: CommandRunner = {
    async run(command, args) {
      const call = { command, args };
      calls.push(call);
      const answer = respond(call);
      return { code: answer.code ?? 0, stdout: answer.stdout ?? '', stderr: answer.stderr ?? '' };
    },
  };
  return { runner, calls };
}

const NO_PROVIDERS = JSON.stringify({ OpenIDConnectProviderList: [] });
const ONE_GITHUB_PROVIDER = JSON.stringify({
  OpenIDConnectProviderList: [
    { Arn: 'arn:aws:iam::1234:oidc-provider/token.actions.githubusercontent.com' },
  ],
});

function installed(): string {
  const root = mkdtempSync(join(tmpdir(), 'skyhook-bootstrap-'));
  mkdirSync(join(root, '.skyhook/bootstrap'), { recursive: true });
  writeFileSync(
    join(root, '.skyhook/config.yml'),
    'storage:\n  bucket: skyhook-acme-widgets\n  region: eu-west-1\n',
  );
  return root;
}

function standard(runner: CommandRunner, extra: Record<string, unknown> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    options: {
      repositoryRoot: '',
      runner,
      confirm: async () => true,
      out: (line: string) => out.push(line),
      err: (line: string) => err.push(line),
      repository: 'acme/widgets',
      // The trust policies pin the OIDC subject a run presents, so bootstrap asks GitHub which
      // form this repository uses before planning (chg-009). The default here is the common case:
      // GitHub states no customization, so the conventional form applies. Tests about the lookup
      // itself override this; the rest are about what skyhook asks Terraform to do.
      //
      // This fixture used to return `{ id, owner: { id } }`, modelling a design AWS refused —
      // conditioning the trust policy on the immutable repository ids. It passed either way,
      // because nothing asserted on it, which is how it outlived the design by a day.
      fetch: (async () =>
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })) as unknown as typeof globalThis.fetch,
      ...extra,
    },
  };
}

function varsOf(calls: Invocation[], subcommand: string): Map<string, string> {
  const call = calls.find((c) => c.command === 'terraform' && c.args[0] === subcommand);
  const vars = new Map<string, string>();
  if (call === undefined) return vars;
  call.args.forEach((arg, index) => {
    if (arg === '-var') {
      const [name, ...rest] = (call.args[index + 1] ?? '').split('=');
      if (name !== undefined) vars.set(name, rest.join('='));
    }
  });
  return vars;
}

// --- AC-21: settings come from the config, and nothing applies without a yes ---

test('feat-001/AC-21 the bucket and region come from the configuration, not from flags', async () => {
  const root = installed();
  try {
    const { runner, calls } = fakeRunner(() => ({ stdout: NO_PROVIDERS }));
    const { options } = standard(runner, { repositoryRoot: root });

    const outcome = await bootstrap(options);

    assert.deepEqual(outcome, { ok: true, applied: true });
    const vars = varsOf(calls, 'apply');
    assert.equal(vars.get('bucket_name'), 'skyhook-acme-widgets');
    assert.equal(vars.get('aws_region'), 'eu-west-1');
    assert.equal(vars.get('repository'), 'acme/widgets');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('feat-001/AC-21 the operator sees a plan before anything is applied', async () => {
  const root = installed();
  try {
    const { runner, calls } = fakeRunner(() => ({ stdout: NO_PROVIDERS }));
    const { options } = standard(runner, { repositoryRoot: root });

    await bootstrap(options);

    const terraform = calls.filter((c) => c.command === 'terraform').map((c) => c.args[0]);
    assert.deepEqual(terraform, ['init', 'plan', 'apply'], 'plan precedes apply, always');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('feat-001/AC-21 declining the confirmation changes nothing', async () => {
  const root = installed();
  try {
    const { runner, calls } = fakeRunner(() => ({ stdout: NO_PROVIDERS }));
    const { options, out } = standard(runner, {
      repositoryRoot: root,
      confirm: async () => false,
    });

    const outcome = await bootstrap(options);

    assert.deepEqual(outcome, { ok: true, applied: false });
    assert.ok(
      !calls.some((c) => c.command === 'terraform' && c.args[0] === 'apply'),
      'a declined confirmation must never reach apply',
    );
    assert.ok(out.some((line) => /unchanged/i.test(line)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('feat-001/AC-21 --yes is the only way to skip the confirmation', async () => {
  const root = installed();
  try {
    const { runner, calls } = fakeRunner(() => ({ stdout: NO_PROVIDERS }));
    let asked = false;
    const { options } = standard(runner, {
      repositoryRoot: root,
      assumeYes: true,
      confirm: async () => {
        asked = true;
        return true;
      },
    });

    await bootstrap(options);

    assert.equal(asked, false, 'no question is put when the operator already answered it');
    assert.ok(calls.some((c) => c.command === 'terraform' && c.args[0] === 'apply'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- AC-22: the command works out the trust anchor for itself ---------------

test('feat-001/AC-22 an existing trust anchor is detected and adopted', async () => {
  const root = installed();
  try {
    const { runner, calls } = fakeRunner((call) =>
      call.command === 'aws' ? { stdout: ONE_GITHUB_PROVIDER } : {},
    );
    const { options, out } = standard(runner, { repositoryRoot: root });

    await bootstrap(options);

    assert.equal(varsOf(calls, 'apply').get('create_oidc_provider'), 'false');
    assert.ok(out.some((line) => /already exists/i.test(line)), 'and the operator is told');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('feat-001/AC-22 an account with no trust anchor gets one created', async () => {
  const root = installed();
  try {
    const { runner, calls } = fakeRunner(() => ({ stdout: NO_PROVIDERS }));
    const { options, out } = standard(runner, { repositoryRoot: root });

    await bootstrap(options);

    assert.equal(varsOf(calls, 'apply').get('create_oidc_provider'), 'true');
    assert.ok(out.some((line) => /will create one/i.test(line)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('feat-001/AC-22 another account\'s non-GitHub provider is not mistaken for ours', async () => {
  const root = installed();
  try {
    const elsewhere = JSON.stringify({
      OpenIDConnectProviderList: [{ Arn: 'arn:aws:iam::1234:oidc-provider/gitlab.com' }],
    });
    const { runner, calls } = fakeRunner((call) =>
      call.command === 'aws' ? { stdout: elsewhere } : {},
    );
    const { options } = standard(runner, { repositoryRoot: root });

    await bootstrap(options);

    assert.equal(varsOf(calls, 'apply').get('create_oidc_provider'), 'true');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('bootstrap: unreadable credentials stop the run before terraform is touched', async () => {
  const root = installed();
  try {
    const { runner, calls } = fakeRunner((call) =>
      call.command === 'aws' ? { code: 255, stderr: 'Unable to locate credentials' } : {},
    );
    const { options, err } = standard(runner, { repositoryRoot: root });

    const outcome = await bootstrap(options);

    assert.equal(outcome.ok, false);
    assert.ok(!calls.some((c) => c.command === 'terraform'), 'nothing is run on a bad account read');
    assert.ok(err.some((line) => /AWS_PROFILE/.test(line)), 'and the message says what to try');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- prerequisites and derivation -------------------------------------------

test('bootstrap: an uninstalled repository is told to run init first', async () => {
  const root = mkdtempSync(join(tmpdir(), 'skyhook-empty-'));
  try {
    const { runner, calls } = fakeRunner();
    const { options } = standard(runner, { repositoryRoot: root });

    const outcome = await bootstrap(options);

    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.match(outcome.problem, /skyhook init/);
    assert.equal(calls.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('bootstrap: the repository is derived from the git remote when not supplied', async () => {
  const root = installed();
  try {
    const { runner, calls } = fakeRunner((call) => {
      if (call.command === 'git') return { stdout: 'git@github.com:acme/gadgets.git\n' };
      if (call.command === 'aws') return { stdout: NO_PROVIDERS };
      return {};
    });
    const { options } = standard(runner, { repositoryRoot: root, repository: undefined });

    await bootstrap(options);

    assert.equal(varsOf(calls, 'apply').get('repository'), 'acme/gadgets');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('bootstrap: a repository with no remote asks for the flag rather than guessing', async () => {
  const root = installed();
  try {
    const { runner } = fakeRunner((call) => (call.command === 'git' ? { code: 128 } : {}));
    const { options } = standard(runner, { repositoryRoot: root, repository: undefined });

    const outcome = await bootstrap(options);

    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.match(outcome.problem, /--repository/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('bootstrap: both git remote spellings parse to the same repository', () => {
  assert.equal(parseRepository('git@github.com:acme/widgets.git'), 'acme/widgets');
  assert.equal(parseRepository('https://github.com/acme/widgets.git'), 'acme/widgets');
  assert.equal(parseRepository('https://github.com/acme/widgets'), 'acme/widgets');
  assert.equal(parseRepository('not-a-remote'), null);
});

// --- AC-23 / AC-24: the state gets a durable home ---------------------------

function initArgs(calls: Invocation[]): string[][] {
  return calls.filter((c) => c.command === 'terraform' && c.args[0] === 'init').map((c) => [...c.args]);
}

test('feat-001/AC-23 a first run applies locally, then moves the state into the bucket', async () => {
  const root = installed();
  try {
    // head-bucket answers 404: the bucket this configuration creates does not exist yet, so
    // there is nowhere for the state to live until after the apply.
    const { runner, calls } = fakeRunner((call) => {
      if (call.command === 'aws' && call.args[0] === 's3api') {
        return { code: 254, stderr: 'An error occurred (404) when calling the HeadBucket operation' };
      }
      if (call.command === 'aws') return { stdout: NO_PROVIDERS };
      return {};
    });
    const { options, out } = standard(runner, { repositoryRoot: root });

    const outcome = await bootstrap(options);

    assert.deepEqual(outcome, { ok: true, applied: true });
    const inits = initArgs(calls);
    assert.equal(inits.length, 2, 'two passes: local, then backend');
    // The first pass cannot use a bucket that does not exist yet, so it runs against a local
    // backend supplied by an override file. Never `-backend=false`: that skips backend
    // initialization and every later command refuses — a defect found part-way through a real run.
    assert.ok(!inits[0]?.includes('-backend=false'), 'the flag that caused the defect is not used');
    assert.ok(!inits[0]?.some((a) => a.startsWith('-backend-config=')), 'no bucket is named yet');
    assert.ok(inits[1]?.includes('-migrate-state'), 'the second moves the state in');

    // And the order matters: the migration follows the apply, not the other way round.
    const order = calls
      .filter((c) => c.command === 'terraform')
      .map((c) => (c.args[0] === 'init' ? (c.args.includes('-migrate-state') ? 'migrate' : 'init') : c.args[0]));
    assert.deepEqual(order, ['init', 'plan', 'apply', 'migrate']);
    assert.ok(out.some((line) => /two passes/i.test(line)), 'and the operator is told why');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('feat-001/AC-23 a later run finds the state where it left it', async () => {
  const root = installed();
  try {
    const { runner, calls } = fakeRunner((call) =>
      call.command === 'aws' && call.args[0] === 'iam' ? { stdout: ONE_GITHUB_PROVIDER } : {},
    );
    const { options } = standard(runner, { repositoryRoot: root });

    await bootstrap(options);

    const inits = initArgs(calls);
    assert.equal(inits.length, 1, 'one pass — the state already has a home');
    assert.ok(inits[0]?.some((a) => a.startsWith('-backend-config=key=')));
    assert.ok(!inits[0]?.includes('-migrate-state'), 'nothing to migrate');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('feat-001/AC-23 a stranded local state is migrated on the next run', async () => {
  // Exactly the situation a wiped working tree leaves behind in reverse: the bucket exists and
  // a local state is still sitting in the tree. It belongs in the bucket.
  const root = installed();
  try {
    writeFileSync(join(root, '.skyhook/bootstrap/terraform.tfstate'), '{"version":4}');
    const { runner, calls } = fakeRunner(() => ({ stdout: ONE_GITHUB_PROVIDER }));
    const { options } = standard(runner, { repositoryRoot: root });

    await bootstrap(options);

    assert.ok(initArgs(calls)[0]?.includes('-migrate-state'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('feat-001/AC-23 a failed migration says the resources exist and the state is still local', async () => {
  // Reporting plain failure would be wrong — the account changed. Saying nothing would be worse:
  // the state would be sitting in a working tree nobody knows to protect.
  const root = installed();
  try {
    const { runner } = fakeRunner((call) => {
      if (call.command === 'aws' && call.args[0] === 's3api') {
        return { code: 254, stderr: '404 Not Found' };
      }
      if (call.command === 'aws') return { stdout: NO_PROVIDERS };
      if (call.command === 'terraform' && call.args.includes('-migrate-state')) return { code: 1 };
      return {};
    });
    const { options, err } = standard(runner, { repositoryRoot: root });

    const outcome = await bootstrap(options);

    assert.equal(outcome.ok, false);
    const said = err.join('\n');
    assert.match(said, /resources were created/i);
    assert.match(said, /do not delete it/i);
    assert.match(said, /again/i, 'and says how to finish');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('feat-001/AC-24 the bootstrap state sits outside every prefix skyhook grants', async () => {
  // Nothing skyhook runs may read the shape of its own boundary, let alone rewrite it.
  const roles = readFileSync(
    new URL('../terraform/bootstrap/roles.tf', import.meta.url).pathname,
    'utf8',
  );
  assert.ok(BOOTSTRAP_STATE_KEY.startsWith('bootstrap/'));
  for (const granted of ['registry/', 'state/', 'protected/']) {
    assert.ok(!BOOTSTRAP_STATE_KEY.startsWith(granted), `must not live under ${granted}`);
  }
  // And no policy statement names the bootstrap prefix at all.
  assert.doesNotMatch(roles, /bootstrap\//, 'no role is granted anything under bootstrap/');
});

test('feat-001/AC-23 the local-backend override does not survive a first run', async () => {
  // Regression: the override is what makes the first pass work at all, and leaving it behind
  // would pin every later run to local state — silently undoing the migration it just performed.
  const root = installed();
  const override = join(root, '.skyhook/bootstrap/zz_skyhook_local_backend_override.tf');
  try {
    let presentDuringFirstPass = false;
    const { runner } = fakeRunner((call) => {
      if (call.command === 'terraform' && call.args[0] === 'plan') {
        presentDuringFirstPass = existsSync(override);
      }
      if (call.command === 'aws' && call.args[0] === 's3api') {
        return { code: 254, stderr: 'An error occurred (404) when calling the HeadBucket operation' };
      }
      if (call.command === 'aws') return { stdout: NO_PROVIDERS };
      return {};
    });
    const { options } = standard(runner, { repositoryRoot: root });

    await bootstrap(options);

    assert.ok(presentDuringFirstPass, 'the first pass runs against a local backend');
    assert.ok(!existsSync(override), 'and the override is gone once the state has moved');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- AC-33: what the operator is told about the subject their runs present ---
//
// Added by the pre-build check on chg-009, which found this criterion verified by nothing. It is
// entirely about what skyhook SAYS, and the live run has now been bitten three times by prose that
// shipped, went stale, and was asserted by no test. A criterion whose subject is prose is the one
// to hold a test against.

function statedPrefix(prefix: string): typeof globalThis.fetch {
  return (async () =>
    new Response(JSON.stringify({ sub_claim_prefix: prefix }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof globalThis.fetch;
}

test('feat-001/AC-33 the operator is told the form GitHub stated, before anything applies', async () => {
  const root = installed();
  try {
    const { runner, calls } = fakeRunner(() => ({ stdout: NO_PROVIDERS }));
    const { options, out } = standard(runner, {
      repositoryRoot: root,
      fetch: statedPrefix('repo:acme@26345547/widgets@1335111920'),
    });

    await bootstrap(options);

    const said = out.join('\n');
    assert.match(said, /repo:acme@26345547\/widgets@1335111920/);
    assert.match(said, /as GitHub reports it/i);
    // Said before the apply, not after it: an operator who does not recognize the subject needs
    // the chance to decline at the confirmation, which comes later.
    const applied = calls.findIndex((c) => c.command === 'terraform' && c.args[0] === 'apply');
    assert.ok(applied >= 0, 'this test is meaningless if nothing was applied');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('feat-001/AC-33 a fallback to the conventional form is announced as a fallback', async () => {
  const root = installed();
  try {
    const { runner } = fakeRunner(() => ({ stdout: NO_PROVIDERS }));
    // 403: the endpoint needs repository admin. The install still proceeds — correctly, wherever
    // the conventional form applies — so the announcement is the only thing standing between an
    // operator and an AccessDenied that names nothing.
    const { options, out } = standard(runner, {
      repositoryRoot: root,
      fetch: (async () => new Response('', { status: 403 })) as unknown as typeof globalThis.fetch,
    });

    await bootstrap(options);

    const said = out.join('\n');
    assert.match(said, /repo:acme\/widgets/);
    assert.match(said, /assumed/i);

    // feat-001/AC-32, gap-007 — the announcement has to be actionable, not merely present.
    // The audit's finding was that "(the conventional form; GitHub did not state one)" is true,
    // neutral and useless: reading the setting needs repository admin, so whoever gets the
    // fallback is exactly whoever cannot check it, and the next thing they meet is an
    // AccessDenied that names nothing. Assert the two halves that make it act: what will break,
    // and what to do instead. A test for the announcement alone would have passed on the old
    // wording, which is why it is not enough.
    assert.match(said, /refused/i, 'never says what a wrong assumption looks like');
    assert.match(said, /GH_TOKEN|GITHUB_TOKEN/, 'never says how to avoid assuming');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('feat-001/AC-32 gap-007 nothing is said about tokens when GitHub did answer', async () => {
  const root = installed();
  try {
    const { runner } = fakeRunner(() => ({ stdout: NO_PROVIDERS }));
    const { options, out } = standard(runner, {
      repositoryRoot: root,
      fetch: statedPrefix('repo:acme@26345547/widgets@1335111920'),
    });

    await bootstrap(options);

    // The warning is for the case that needs it. An operator whose subject came back from GitHub
    // has nothing to act on, and advice on a healthy path is how operators learn to skim.
    const said = out.join('\n');
    assert.doesNotMatch(said, /GH_TOKEN|GITHUB_TOKEN/);
    assert.doesNotMatch(said, /assumed/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('feat-001/AC-32 the form GitHub stated is what the trust policies are given', async () => {
  const root = installed();
  try {
    const { runner, calls } = fakeRunner(() => ({ stdout: NO_PROVIDERS }));
    const { options } = standard(runner, {
      repositoryRoot: root,
      fetch: statedPrefix('repo:acme@26345547/widgets@1335111920'),
    });

    await bootstrap(options);

    // Telling the operator and telling Terraform are different acts, and only the second one
    // decides what the roles trust.
    assert.equal(
      varsOf(calls, 'apply').get('subject_prefix'),
      'repo:acme@26345547/widgets@1335111920',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('feat-001/AC-33 an unreachable GitHub stops the run with the cause named', async () => {
  const root = installed();
  try {
    const { runner, calls } = fakeRunner(() => ({ stdout: NO_PROVIDERS }));
    const { options, err } = standard(runner, {
      repositoryRoot: root,
      fetch: (async () => {
        throw new Error('getaddrinfo ENOTFOUND api.github.com');
      }) as unknown as typeof globalThis.fetch,
    });

    const outcome = await bootstrap(options);

    assert.equal(outcome.ok, false);
    assert.match(err.join('\n'), /ENOTFOUND/);
    // Nothing applied, and nothing planned either. A policy written against a guessed subject
    // would refuse every run in the account for a reason nothing reports.
    assert.deepEqual(
      calls.filter((c) => c.command === 'terraform').map((c) => c.args[0]),
      [],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
