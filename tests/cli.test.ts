import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli, EXIT_OK, EXIT_USAGE, type CliIo } from '../src/cli/main.ts';

function capture(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (line) => out.push(line), err: (line) => err.push(line) }, out, err };
}

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'skyhook-cli-'));
}

const ARGS = (root: string): string[] => [
  'init',
  '--repository',
  'acme/widgets',
  '--bucket',
  'skyhook-acme-widgets',
  '--region',
  'eu-west-1',
  '--root',
  root,
];

test('feat-001/AC-1 one command installs skyhook into a repository', async () => {
  const root = scratch();
  try {
    const { io, out } = capture();
    const code = await runCli(ARGS(root), io);

    assert.equal(code, EXIT_OK);
    assert.match(readFileSync(join(root, '.skyhook/config.yml'), 'utf8'), /skyhook-acme-widgets/);
    assert.ok(out.some((line) => line.includes('.skyhook/config.yml')));
    assert.ok(out.some((line) => /nothing has been created/i.test(line)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('feat-001/AC-2 running the command twice reports no change', async () => {
  const root = scratch();
  try {
    await runCli(ARGS(root), capture().io);
    const { io, out } = capture();

    assert.equal(await runCli(ARGS(root), io), EXIT_OK);
    assert.ok(out.some((line) => /already up to date/i.test(line)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cli: the default branch can be set, and reaches the trust policy', async () => {
  const root = scratch();
  try {
    const { io, out } = capture();
    await runCli([...ARGS(root), '--default-branch', 'trunk'], io);
    // It reaches the trust policy through the bootstrap variable that names the privileged
    // branch — which is the only place it has ever mattered. Until chg-001 this option showed up
    // in the scaffolded workflow's push trigger and nowhere else, so an operator who set it got
    // a workflow that agreed with them and a trust policy that still said `main`.
    // chg-009 moved how it is carried, not whether: the operator is now told to hand it to
    // `skyhook bootstrap` rather than to `terraform apply`, because the apply needs a variable
    // only that command can supply.
    assert.match(out.join('\n'), /skyhook bootstrap --default-branch trunk/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('feat-001/AC-1 the installation instructions can actually be followed', async () => {
  const root = scratch();
  try {
    const { io, out } = capture();
    await runCli(ARGS(root), io);
    const message = out.join('\n');

    // The defect this pins (found by the pre-build check after chg-009): step 1 used to print a
    // copyable `terraform apply` naming three variables. chg-009 made `subject_prefix` a fourth,
    // required, with no default — deliberately, since a default would silently restore the
    // assumption it removed — and nobody updated the instruction. An operator following it stops
    // on a prompt for a string they have no way to know, which is the exact failure chg-009
    // exists to prevent, one layer up.
    assert.doesNotMatch(message, /terraform apply/);
    assert.match(message, /skyhook bootstrap/);

    // The narrower assertion is what would rot. Anything skyhook tells an operator to run must
    // name every input that has no default, so a fifth required variable fails here rather than
    // in their terminal.
    const required = readFileSync(join(root, '.skyhook/bootstrap/variables.tf'), 'utf8')
      .split(/^variable "/m)
      .slice(1)
      .filter((block) => !/^\s*default\s*=/m.test(block))
      .map((block) => block.slice(0, block.indexOf('"')));
    assert.ok(required.length > 0, 'expected the bootstrap to have required variables');
    for (const name of required) {
      const offered = new RegExp(`(-var ${name}=|--${name.replace(/_/g, '-')} )`);
      assert.ok(
        !/terraform apply/.test(message) || offered.test(message),
        `the printed instructions ask for a manual apply but never supply ${name}`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cli: a missing required option names every one that is missing', async () => {
  const { io, err } = capture();
  const code = await runCli(['init', '--repository', 'acme/widgets'], io);

  assert.equal(code, EXIT_USAGE);
  const said = err.join('\n');
  assert.match(said, /--bucket/);
  assert.match(said, /--region/);
  assert.doesNotMatch(said, /--repository[,\s]*$/m, 'the option that was supplied is not listed');
});

test('cli: a malformed repository is refused with a message about the flag', async () => {
  const { io, err } = capture();
  // Not left to fail later inside key derivation: the operator needs to hear about the flag
  // they typed, not about a storage key they have never seen.
  const code = await runCli(['init', '--repository', 'widgets', '--bucket', 'b', '--region', 'r'], io);

  assert.equal(code, EXIT_USAGE);
  assert.match(err.join('\n'), /--repository must be "owner\/name"/);
});

test('cli: an unknown command exits with usage rather than doing something', async () => {
  const { io, err } = capture();
  assert.equal(await runCli(['destroy-everything'], io), EXIT_USAGE);
  assert.match(err.join('\n'), /unknown command "destroy-everything"/);
});

test('cli: help is help, and no arguments is a usage error', async () => {
  const help = capture();
  assert.equal(await runCli(['--help'], help.io), EXIT_OK);
  assert.match(help.out.join('\n'), /Usage:/);

  const bare = capture();
  assert.equal(await runCli([], bare.io), EXIT_USAGE, 'bare invocation is not success');
  assert.match(bare.out.join('\n'), /Usage:/);
});

test('cli: an unrecognized flag is refused rather than ignored', async () => {
  const { io, err } = capture();
  const code = await runCli(['init', '--repostiory', 'acme/widgets'], io);
  assert.equal(code, EXIT_USAGE);
  assert.match(err.join('\n'), /skyhook init:/);
});
