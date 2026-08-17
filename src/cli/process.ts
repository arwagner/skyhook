/**
 * The seam between skyhook and the programs it drives.
 *
 * Shelling out is the only honest way to run `terraform` — it is a binary the operator installed,
 * not a library — but a shell-out that cannot be substituted makes everything above it untestable.
 * So the CLI takes a runner rather than reaching for `child_process` directly, and the tests hand
 * it one that records instead of executing.
 */

import { spawn } from 'node:child_process';

export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunOptions {
  readonly cwd?: string | undefined;
  /** When true the child writes to the terminal as it goes, for long, chatty commands. */
  readonly inherit?: boolean | undefined;
  /**
   * The child's whole environment, replacing this process's.
   *
   * Needed because one `terraform` run has to hold two identities at once: the consuming
   * repo's providers run as its deploy role, while the state backend runs as skyhook's own
   * narrowed session (feat-002 plan D6). Passing the credentials per child is what keeps
   * those apart without either leaking into the other.
   */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
}

export interface CommandRunner {
  run(command: string, args: readonly string[], options?: RunOptions): Promise<CommandResult>;
}

export const systemRunner: CommandRunner = {
  run(command, args, options = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(command, [...args], {
        cwd: options.cwd,
        stdio: options.inherit === true ? 'inherit' : 'pipe',
        ...(options.env !== undefined ? { env: options.env as NodeJS.ProcessEnv } : {}),
      });

      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));

      child.on('error', (error: NodeJS.ErrnoException) => {
        // A missing binary is the common case and deserves better than ENOENT.
        if (error.code === 'ENOENT') {
          reject(new Error(`${command} is not installed, or not on PATH`));
          return;
        }
        reject(error);
      });
      child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });
  },
};

/** Asks a yes/no question. Injected so tests never block on a terminal. */
export type Confirm = (question: string) => Promise<boolean>;

export const terminalConfirm: Confirm = async (question) => {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
};

/**
 * Asks the operator to type something exact rather than press a key.
 *
 * Reserved for what cannot be undone. A y/N prompt is answered by reflex; typing a bucket name
 * requires reading the sentence it appears in.
 */
export type ConfirmExact = (question: string, expected: string) => Promise<boolean>;

export const terminalConfirmExact: ConfirmExact = async (question, expected) => {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} (${expected}) `);
    return answer.trim() === expected;
  } finally {
    rl.close();
  }
};
