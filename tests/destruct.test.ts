import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { destruct, subjectPrefixFromState } from '../src/cli/destruct.ts';
import type { CommandResult, CommandRunner } from '../src/cli/process.ts';

interface Invocation {
  readonly command: string;
  readonly args: readonly string[];
}

function fakeRunner(respond: (call: Invocation) => Partial<CommandResult> = () => ({})): {
  runner: CommandRunner;
  calls: Invocation[];
} {
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

function installed(): string {
  const root = mkdtempSync(join(tmpdir(), 'skyhook-destruct-'));
  mkdirSync(join(root, '.skyhook/bootstrap'), { recursive: true });
  writeFileSync(
    join(root, '.skyhook/config.yml'),
    'storage:\n  bucket: skyhook-acme-widgets\n  region: eu-west-1\n',
  );
  return root;
}

function listing(keys: string[]): string {
  return JSON.stringify({ Contents: keys.map((Key) => ({ Key })) });
}

/**
 * Nothing in the bucket, a state holding only skyhook's own resources.
 *
 * Bound to a root because it has to do what real Terraform does: a successful
 * `init -migrate-state` leaves a local state file behind, and the command checks for it before
 * deleting anything.
 */
function emptyAccountIn(root: string) {
  return (call: Invocation): Partial<CommandResult> => {
    if (call.command === 'terraform' && call.args.includes('-migrate-state')) {
      writeFileSync(join(root, '.skyhook/bootstrap/terraform.tfstate'), '{"version":4}');
      return {};
    }
    if (call.command === 'aws' && call.args[1] === 'list-objects-v2') return { stdout: listing([]) };
    if (call.command === 'aws' && call.args[1] === 'list-object-versions') return { stdout: '{}' };
    if (call.command === 'terraform' && call.args[0] === 'state' && call.args[1] === 'list') {
      return { stdout: 'aws_s3_bucket.skyhook\naws_iam_role.pull_request\n' };
    }
    return {};
  };
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
      confirmExact: async () => true,
      out: (line: string) => out.push(line),
      err: (line: string) => err.push(line),
      repository: 'acme/widgets',
      ...extra,
    },
  };
}

const ranTerraform = (calls: Invocation[], sub: string): boolean =>
  calls.some((c) => c.command === 'terraform' && c.args[0] === sub);

// --- the refusal that keeps the "no orphans" promise ------------------------

test('feat-001/AC-25 destruct refuses while any environment is still recorded', async () => {
  // The registry is the only record of what skyhook has provisioned. Destroying it while
  // environments remain would leave infrastructure nothing can find or bill to anyone.
  const root = installed();
  try {
    const { runner, calls } = fakeRunner((call) => {
      if (call.command === 'aws' && call.args[1] === 'list-objects-v2') {
        return {
          stdout: listing([
            'registry/acme/widgets/staging.json',
            'registry/acme/widgets/pr-482.json',
          ]),
        };
      }
      return emptyAccountIn(root)(call);
    });
    const { options, err } = standard(runner, { repositoryRoot: root });

    const outcome = await destruct(options);

    assert.equal(outcome.ok, false);
    assert.ok(!ranTerraform(calls, 'destroy'), 'nothing is destroyed');
    assert.ok(!calls.some((c) => c.args.includes('delete-objects')), 'and nothing is emptied');

    const said = err.join('\n');
    assert.match(said, /staging/);
    assert.match(said, /pr-482/, 'each environment is named, not just counted');
    assert.match(said, /nothing can find or bill/i, 'and the reason is given, not just the refusal');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('feat-001/AC-25 the refusal survives an operator who says yes', async () => {
  // The confirmation is not the gate here. Even --yes must not get past this.
  const root = installed();
  try {
    const { runner, calls } = fakeRunner((call) =>
      call.command === 'aws' && call.args[1] === 'list-objects-v2'
        ? { stdout: listing(['registry/acme/widgets/staging.json']) }
        : emptyAccountIn(root)(call),
    );
    const { options } = standard(runner, { repositoryRoot: root, assumeYes: true });

    const outcome = await destruct(options);

    assert.equal(outcome.ok, false);
    assert.ok(!ranTerraform(calls, 'destroy'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('feat-001/AC-25 the bootstrap state is not mistaken for an environment', async () => {
  // It lives under a different prefix, but a naive scan would still see an object and refuse
  // forever — a refusal nothing could ever clear.
  const root = installed();
  try {
    const { runner, calls } = fakeRunner((call) =>
      call.command === 'aws' && call.args[1] === 'list-objects-v2'
        ? { stdout: listing(['bootstrap/terraform.tfstate']) }
        : emptyAccountIn(root)(call),
    );
    const { options } = standard(runner, { repositoryRoot: root });

    const outcome = await destruct(options);

    assert.equal(outcome.ok, true);
    assert.ok(ranTerraform(calls, 'destroy'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- skyhook destroys only what skyhook created -----------------------------

test('feat-001/AC-26 an adopted trust anchor is never destroyed', async () => {
  // It was a data source, never a resource, so it is not in state — and destroy cannot reach
  // what it does not manage. The flag follows the state rather than a guess.
  const root = installed();
  try {
    const { runner, calls } = fakeRunner((call) => {
      if (call.command === 'terraform' && call.args[0] === 'state' && call.args[1] === 'list') {
        return { stdout: 'aws_s3_bucket.skyhook\naws_iam_role.default_branch\n' };
      }
      return emptyAccountIn(root)(call);
    });
    const { options } = standard(runner, { repositoryRoot: root });

    await destruct(options);

    const destroy = calls.find((c) => c.command === 'terraform' && c.args[0] === 'destroy');
    assert.ok(destroy?.args.includes('create_oidc_provider=false'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('feat-001/AC-26 a trust anchor skyhook created is destroyed with it', async () => {
  const root = installed();
  try {
    const { runner, calls } = fakeRunner((call) => {
      if (call.command === 'terraform' && call.args[0] === 'state' && call.args[1] === 'list') {
        return { stdout: 'aws_iam_openid_connect_provider.github[0]\naws_s3_bucket.skyhook\n' };
      }
      return emptyAccountIn(root)(call);
    });
    const { options } = standard(runner, { repositoryRoot: root });

    await destruct(options);

    const destroy = calls.find((c) => c.command === 'terraform' && c.args[0] === 'destroy');
    assert.ok(destroy?.args.includes('create_oidc_provider=true'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('feat-001/AC-26 --keep-trust-anchor stops managing it rather than destroying it', async () => {
  const root = installed();
  try {
    let removedFromState = false;
    const { runner, calls } = fakeRunner((call) => {
      if (call.command === 'terraform' && call.args[0] === 'state' && call.args[1] === 'rm') {
        removedFromState = true;
        return {};
      }
      if (call.command === 'terraform' && call.args[0] === 'state' && call.args[1] === 'list') {
        return {
          stdout: removedFromState
            ? 'aws_s3_bucket.skyhook\n'
            : 'aws_iam_openid_connect_provider.github[0]\naws_s3_bucket.skyhook\n',
        };
      }
      return emptyAccountIn(root)(call);
    });
    const { options } = standard(runner, { repositoryRoot: root, keepTrustAnchor: true });

    await destruct(options);

    assert.ok(removedFromState, 'it leaves skyhook\'s management');
    const destroy = calls.find((c) => c.command === 'terraform' && c.args[0] === 'destroy');
    assert.ok(destroy?.args.includes('create_oidc_provider=false'), 'and is not destroyed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- ordering, confirmation, and the state that lives in the bucket ---------

test('feat-001/AC-27 the state is brought out of the bucket before the bucket is emptied', async () => {
  // The state describing the bucket is stored in it. Destroy needs the state; the bucket cannot
  // be deleted while anything is in it. Get the state out first or lose the ability to finish.
  const root = installed();
  try {
    const { runner, calls } = fakeRunner(emptyAccountIn(root));
    const { options } = standard(runner, { repositoryRoot: root });

    await destruct(options);

    const order = calls
      .map((c, index) => ({ c, index }))
      .filter(({ c }) =>
        (c.command === 'terraform' && (c.args.includes('-migrate-state') || c.args[0] === 'destroy')) ||
        (c.command === 'aws' && c.args[1] === 'list-object-versions'),
      )
      .map(({ c }) =>
        c.command === 'aws' ? 'empty' : c.args.includes('-migrate-state') ? 'migrate' : 'destroy',
      );

    assert.equal(order[0], 'migrate', 'the state comes out first');
    assert.ok(order.indexOf('empty') < order.indexOf('destroy'), 'emptied before destroyed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('feat-001/AC-27 a state that cannot be moved stops the run before anything is deleted', async () => {
  const root = installed();
  try {
    // The migration fails, so no local state file is written — and nothing may be deleted while
    // the only record of what exists is still sitting in the thing about to be deleted.
    const { runner, calls } = fakeRunner((call) =>
      call.command === 'terraform' && call.args.includes('-migrate-state')
        ? { code: 1 }
        : emptyAccountIn(root)(call),
    );
    const { options } = standard(runner, { repositoryRoot: root });

    const outcome = await destruct(options);

    assert.equal(outcome.ok, false);
    assert.ok(!calls.some((c) => c.args.includes('delete-objects')));
    assert.ok(!ranTerraform(calls, 'destroy'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('destruct: a mistyped confirmation leaves everything alone', async () => {
  const root = installed();
  try {
    const { runner, calls } = fakeRunner(emptyAccountIn(root));
    const { options, out } = standard(runner, {
      repositoryRoot: root,
      confirmExact: async () => false,
    });

    const outcome = await destruct(options);

    assert.deepEqual(outcome, { ok: true, destroyed: false });
    assert.ok(!calls.some((c) => c.args.includes('delete-objects')));
    assert.ok(!ranTerraform(calls, 'destroy'));
    assert.ok(out.some((line) => /unchanged/i.test(line)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('destruct: the operator is asked to type the bucket name, not to press a key', async () => {
  const root = installed();
  try {
    const asked: string[] = [];
    const { runner } = fakeRunner(emptyAccountIn(root));
    const { options } = standard(runner, {
      repositoryRoot: root,
      confirmExact: async (_q: string, expected: string) => {
        asked.push(expected);
        return true;
      },
    });

    await destruct(options);

    assert.deepEqual(asked, ['skyhook-acme-widgets']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('destruct: an account with no bucket says so instead of failing', async () => {
  const root = installed();
  try {
    const { runner, calls } = fakeRunner((call) =>
      call.command === 'aws' && call.args[1] === 'head-bucket'
        ? { code: 254, stderr: '404 Not Found' }
        : emptyAccountIn(root)(call),
    );
    const { options, out } = standard(runner, { repositoryRoot: root });

    const outcome = await destruct(options);

    assert.deepEqual(outcome, { ok: true, destroyed: false });
    assert.ok(out.some((line) => /nothing here to remove/i.test(line)));
    assert.ok(!ranTerraform(calls, 'destroy'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('destruct: an uninstalled repository has nothing of skyhook\'s to remove', async () => {
  const root = mkdtempSync(join(tmpdir(), 'skyhook-bare-'));
  try {
    const { runner, calls } = fakeRunner();
    const { options } = standard(runner, { repositoryRoot: root });

    const outcome = await destruct(options);

    assert.equal(outcome.ok, false);
    assert.equal(calls.length, 0, 'nothing is even looked up');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('feat-001/AC-27 the local-backend override is written, then always removed', async () => {
  // Regression for a defect found part-way through a real removal: `init -backend=false` skips
  // backend *initialization*, so `destroy` then refused with "Backend initialization required".
  // Overriding the backend is what actually moves the state. The override must not survive the
  // run — left behind it would pin a later bootstrap to local state, and `skyhook init` would not
  // clean it up because it is not a file skyhook manages.
  const root = installed();
  const override = join(root, '.skyhook/bootstrap/zz_skyhook_local_backend_override.tf');
  try {
    let sawOverrideDuringInit = false;
    const { runner, calls } = fakeRunner((call) => {
      if (call.command === 'terraform' && call.args.includes('-migrate-state')) {
        sawOverrideDuringInit = existsSync(override);
      }
      return emptyAccountIn(root)(call);
    });
    const { options } = standard(runner, { repositoryRoot: root });

    await destruct(options);

    assert.ok(sawOverrideDuringInit, 'the override is in place while the state is migrated');
    assert.ok(!existsSync(override), 'and gone afterwards');
    assert.ok(
      !calls.some((c) => c.args.includes('-backend=false')),
      'the flag that caused the defect is not used here',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- the variable the configuration requires, and the plan that proves it ---

/** A state shaped the way Terraform records the pull-request role, trust policy and all. */
function stateWithSubject(subject: string): string {
  return JSON.stringify({
    version: 4,
    resources: [
      {
        mode: 'managed',
        type: 'aws_iam_role',
        name: 'pull_request',
        instances: [
          {
            attributes: {
              assume_role_policy: JSON.stringify({
                Version: '2012-10-17',
                Statement: [
                  {
                    Effect: 'Allow',
                    Action: 'sts:AssumeRoleWithWebIdentity',
                    Condition: {
                      StringEquals: {
                        'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
                        'token.actions.githubusercontent.com:sub': subject,
                      },
                    },
                  },
                ],
              }),
            },
          },
        ],
      },
    ],
  });
}

test('destruct: the subject prefix is recovered from state, not guessed', async () => {
  // Regression for a defect found part-way through a real removal. The bootstrap's configuration
  // requires `subject_prefix` and gives it no default — deliberately, since a wrong prefix builds
  // roles nothing can assume. Destruct never passed it, so `terraform destroy` refused with "No
  // value for required variable" AFTER the bucket had been emptied.
  //
  // It cannot be re-derived by asking GitHub: a teardown must not need a token, a network, or a
  // repository that still exists. The installation recorded it in its own trust policy, so that
  // is where it is read from.
  const root = installed();
  const qualified = 'repo:acme@26345547/widgets@1335111920';
  try {
    const { runner, calls } = fakeRunner((call) => {
      if (call.command === 'terraform' && call.args.includes('-migrate-state')) {
        writeFileSync(
          join(root, '.skyhook/bootstrap/terraform.tfstate'),
          stateWithSubject(`${qualified}:pull_request`),
        );
        return {};
      }
      return emptyAccountIn(root)(call);
    });
    const { options } = standard(runner, { repositoryRoot: root });

    const outcome = await destruct(options);

    assert.equal(outcome.ok, true);
    const destroy = calls.find((c) => c.command === 'terraform' && c.args[0] === 'destroy');
    assert.ok(
      destroy?.args.includes(`subject_prefix=${qualified}`),
      'the ID-qualified prefix the roles were built with reaches the destroy',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('destruct: the destroy is planned before the bucket is emptied', async () => {
  // Emptying cannot be undone and has to precede deleting the bucket, so every reason a destroy
  // might refuse must be found before that point rather than after it.
  const root = installed();
  try {
    const { runner, calls } = fakeRunner(emptyAccountIn(root));
    const { options } = standard(runner, { repositoryRoot: root });

    await destruct(options);

    const order = calls
      .filter(
        ({ command, args }) =>
          (command === 'terraform' && (args[0] === 'plan' || args[0] === 'destroy')) ||
          (command === 'aws' && args[1] === 'list-object-versions'),
      )
      .map(({ command, args }) => (command === 'aws' ? 'empty' : args[0]));

    // Asserted as an explicit sequence rather than with indexOf comparisons: a missing plan
    // reads as index -1, which satisfies "before" against everything and would let the very
    // regression this test exists for pass unnoticed.
    assert.deepEqual(order, ['plan', 'empty', 'destroy']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('destruct: a destroy that cannot be planned leaves the bucket untouched', async () => {
  // The exact shape of the defect: the removal fails, and because it failed before the bucket was
  // emptied, the installation is still whole and the operator can simply run it again.
  const root = installed();
  try {
    const { runner, calls } = fakeRunner((call) =>
      call.command === 'terraform' && call.args[0] === 'plan'
        ? { code: 1, stderr: 'No value for required variable' }
        : emptyAccountIn(root)(call),
    );
    const { options, err } = standard(runner, { repositoryRoot: root });

    const outcome = await destruct(options);

    assert.equal(outcome.ok, false);
    assert.ok(!calls.some((c) => c.args.includes('delete-objects')), 'nothing is emptied');
    assert.ok(!ranTerraform(calls, 'destroy'), 'and nothing is destroyed');
    assert.match(err.join('\n'), /nothing was deleted/i, 'and the operator is told so plainly');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('subjectPrefixFromState: the recorded subject wins over the conventional form', () => {
  assert.equal(
    subjectPrefixFromState(stateWithSubject('repo:acme@1/widgets@2:pull_request'), 'acme/widgets'),
    'repo:acme@1/widgets@2',
  );
});

test('subjectPrefixFromState: a state with no such role falls back to the conventional form', () => {
  // A destroy removes what is in state, and this value reaches nothing but two policy documents
  // that a destroy evaluates and never applies. With no role left to describe, the conventional
  // form is enough to let Terraform finish rather than refusing over a variable that cannot
  // change the outcome.
  assert.equal(subjectPrefixFromState('{"version":4}', 'acme/widgets'), 'repo:acme/widgets');
  assert.equal(subjectPrefixFromState('not json at all', 'acme/widgets'), 'repo:acme/widgets');
});

test('feat-001/AC-27 the override is removed even when the removal fails', async () => {
  const root = installed();
  const override = join(root, '.skyhook/bootstrap/zz_skyhook_local_backend_override.tf');
  try {
    const { runner } = fakeRunner((call) =>
      call.command === 'terraform' && call.args[0] === 'destroy'
        ? { code: 1 }
        : emptyAccountIn(root)(call),
    );
    const { options } = standard(runner, { repositoryRoot: root });

    const outcome = await destruct(options);

    assert.equal(outcome.ok, false);
    assert.ok(!existsSync(override), 'a failed run leaves no trap for the next one');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
