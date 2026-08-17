import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CommandResult, CommandRunner } from '../src/cli/process.ts';
import { startDashboard } from '../src/cli/dashboard.ts';

const REPO = 'acme/widgets';

async function consumingRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'skyhook-dash-test-'));
  await mkdir(join(root, '.skyhook'), { recursive: true });
  await writeFile(
    join(root, '.skyhook', 'config.yml'),
    'storage:\n  bucket: acme-skyhook\n  region: eu-central-1\n',
  );
  return root;
}

function recordJson(identity: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    repository: REPO,
    identity,
    state: 'active',
    deployedCommit: 'abc123',
    url: `https://${identity}.example.test`,
    createdAt: '2026-08-14T00:00:00.000Z',
    updatedAt: '2026-08-15T00:00:00.000Z',
  });
}

function fakeAws(options: { copyFails?: string } = {}): {
  runner: CommandRunner;
  copies: () => number;
} {
  let copies = 0;
  const runner: CommandRunner = {
    async run(command, args): Promise<CommandResult> {
      assert.equal(command, 'aws');
      if (args[0] === 's3' && args[1] === 'cp') {
        copies += 1;
        if (options.copyFails !== undefined) {
          return { code: 1, stdout: '', stderr: options.copyFails };
        }
        const destination = args[3] ?? '';
        const path = join(destination, 'pr-482.json');
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, recordJson('pr-482'));
        return { code: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 's3api' && args[1] === 'list-objects-v2') {
        return { code: 0, stdout: JSON.stringify({ Contents: [] }), stderr: '' };
      }
      throw new Error(`unexpected aws invocation: ${args.join(' ')}`);
    },
  };
  return { runner, copies: () => copies };
}

test('feat-005/AC-7 one command from the consuming repo serves the page on loopback only', async () => {
  const root = await consumingRepo();
  const aws = fakeAws();
  const lines: string[] = [];

  const started = await startDashboard({
    repositoryRoot: root,
    repository: REPO,
    runner: aws.runner,
    out: (line) => lines.push(line),
    err: () => {},
  });
  assert.ok(started.ok, 'the command starts from a root holding .skyhook/config.yml');

  try {
    assert.match(started.url, /^http:\/\/127\.0\.0\.1:\d+\/$/, 'bound to loopback, nothing hosted');
    assert.ok(
      lines.some((line) => line.includes(started.url)),
      'the URL is printed for the developer',
    );

    const response = await fetch(started.url);
    assert.equal(response.status, 200);
    const page = await response.text();
    assert.ok(page.includes('pr-482'), 'the page shows the registry record');
    assert.ok(page.includes('1 of 5'), 'default cap counted the way a deploy counts it');

    const before = aws.copies();
    await fetch(started.url);
    assert.equal(aws.copies(), before + 1, 'every load takes a fresh snapshot — refresh updates');
  } finally {
    await started.close();
  }
});

test('a failed registry read renders a generic page; CLI detail goes to the terminal only', async () => {
  const root = await consumingRepo();
  const aws = fakeAws({ copyFails: 'An error occurred (ExpiredToken) when calling …' });
  const problems: string[] = [];

  const started = await startDashboard({
    repositoryRoot: root,
    repository: REPO,
    runner: aws.runner,
    out: () => {},
    err: (line) => problems.push(line),
  });
  assert.ok(started.ok);

  try {
    const response = await fetch(started.url);
    assert.equal(response.status, 500);
    const page = await response.text();
    assert.match(page, /could not read the registry/i, 'the page says what failed, generically');
    assert.ok(!page.includes('ExpiredToken'), 'aws stderr never reaches an HTTP response');
    assert.ok(
      problems.some((line) => line.includes('ExpiredToken')),
      'the real reason is on the terminal, where the developer is',
    );
  } finally {
    await started.close();
  }
});

test('feat-005/AC-7 usage errors exit before anything is read or served', async () => {
  const { runCli, EXIT_USAGE } = await import('../src/cli/main.ts');
  const errors: string[] = [];
  const code = await runCli(['dashboard', '--bogus'], {
    out: () => {},
    err: (line) => errors.push(line),
  });
  assert.equal(code, EXIT_USAGE);
  assert.ok(errors.some((line) => line.includes('skyhook dashboard')));

  const badPort = await runCli(['dashboard', '--port', 'nope'], {
    out: () => {},
    err: () => {},
  });
  assert.equal(badPort, EXIT_USAGE);
});

test('a root without a skyhook installation is refused with a plain answer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skyhook-dash-empty-'));
  const started = await startDashboard({
    repositoryRoot: root,
    repository: REPO,
    runner: fakeAws().runner,
    out: () => {},
    err: () => {},
  });
  assert.ok(!started.ok);
  assert.match(started.problem, /\.skyhook\/config\.yml/);
});
