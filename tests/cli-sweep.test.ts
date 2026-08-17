import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXIT_CONSUMER_DESTROY_FAILED, exitCodeForSweep, sweep } from '../src/cli/sweep.ts';
import { runCli } from '../src/cli/main.ts';
import type { CommandResult, CommandRunner } from '../src/cli/process.ts';
import type { SweepEntry } from '../src/core/sweep.ts';

const silentRunner: CommandRunner = {
  run: async (): Promise<CommandResult> => ({ code: 0, stdout: '', stderr: '' }),
};

function collect(): { lines: string[]; sink: (line: string) => void } {
  const lines: string[] = [];
  return { lines, sink: (line) => lines.push(line) };
}

function entry(kind: SweepEntry['kind'], consumer?: boolean): SweepEntry {
  return { identity: 'pr-1', kind, ...(consumer !== undefined ? { consumer } : {}), problem: 'x' };
}

test('feat-003/AC-8 a sweep with nothing to do exits success', async () => {
  assert.equal(exitCodeForSweep([]), 0);
  assert.equal(exitCodeForSweep([entry('left-standing-open'), entry('not-ephemeral')]), 0);
  assert.equal(exitCodeForSweep([entry('destroyed'), entry('left-standing-protected')]), 0);
});

test('feat-003/AC-9 the exit splits by whose failure it was (plan D8)', async () => {
  assert.equal(exitCodeForSweep([entry('destroyed'), entry('failed', true)]), EXIT_CONSUMER_DESTROY_FAILED);
  assert.equal(exitCodeForSweep([entry('failed', false)]), 1);
  assert.equal(exitCodeForSweep([entry('failed', true), entry('failed', false)]), 1);
  assert.equal(exitCodeForSweep([entry('protection-unknown')]), 1);
});

test('sweep without a token names both permissions it needs', async () => {
  const err = collect();
  const code = await sweep({
    env: { GITHUB_REPOSITORY: 'acme/widgets' },
    runner: silentRunner,
    out: collect().sink,
    err: err.sink,
  });
  assert.equal(code, 1);
  assert.match(err.lines.join(' '), /contents: read/);
  assert.match(err.lines.join(' '), /pull-requests: read/);
});

test('the CLI knows the verb and refuses arguments to it', async () => {
  const err = collect();
  const code = await runCli(['sweep', 'now'], { out: collect().sink, err: err.sink });
  assert.equal(code, 2);
  assert.match(err.lines.join(' '), /no arguments/);
});
