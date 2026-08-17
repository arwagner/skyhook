/**
 * The `skyhook` command.
 *
 * The constitution leaves the entry point deliberately open — CLI, GitHub Action, or both,
 * decided per feature. This feature settles only its own half (plan D1a): `init` is a command a
 * maintainer runs, because the spec's first story is "run one command that sets up everything",
 * and a function nobody can invoke does not satisfy it.
 *
 * The deploy action is a separate surface for a separate feature, and nothing here forecloses it:
 * this file is a thin shell over `init()`, holding argument parsing and exit codes and no logic
 * of its own.
 */

import { parseArgs } from 'node:util';
import { init } from './init.ts';
import { bootstrap } from './bootstrap.ts';
import { destruct } from './destruct.ts';
import { deploy } from './deploy.ts';
import { teardown } from './teardown.ts';
import { protect } from './protect.ts';
import { sweep } from './sweep.ts';
import { dashboard } from './dashboard.ts';
import {
  systemRunner,
  terminalConfirm,
  terminalConfirmExact,
  type CommandRunner,
  type Confirm,
  type ConfirmExact,
} from './process.ts';

export interface CliIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

const DEFAULT_IO: CliIo = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

export const EXIT_OK = 0;
export const EXIT_USAGE = 2;
/** The command was well-formed but could not do its job. */
export const EXIT_FAILED = 1;

const REPOSITORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

const USAGE = `skyhook — managed, disposable environments for a repository's infrastructure

Usage:
  skyhook init      --repository <owner/name> --bucket <name> --region <region> [options]
  skyhook bootstrap [options]
  skyhook deploy    [options]
  skyhook teardown  [--environment <name>]
  skyhook protect
  skyhook unprotect
  skyhook sweep
  skyhook dashboard [options]
  skyhook destruct  [options]

Options for init:
  --repository <owner/name>  The consuming repository. Required.
  --bucket <name>            The bucket the bootstrap will create. S3 bucket names are globally
                             unique across all of AWS, so you choose it. Required.
  --region <region>          Where the bucket and roles live. Required.
  --default-branch <name>    The branch whose workflows may assume the privileged role.
                             Defaults to "main".
  --root <path>              Where to write. Defaults to the current directory.

  init writes files and nothing else. It creates no cloud resource and needs no credentials.

Options for bootstrap:
  --repository <owner/name>  Overrides the repository read from the git remote.
  --default-branch <name>    The branch whose workflows may assume the privileged role.
  --root <path>              Where the installation is. Defaults to the current directory.
  --yes                      Skip the confirmation. For non-interactive use only.

  bootstrap applies what init wrote. It takes the bucket and region from .skyhook/config.yml,
  works out for itself whether the account already holds a trust anchor, shows you the plan,
  and applies nothing until you agree. Credentials come from the environment, as AWS_PROFILE
  or whatever your AWS CLI already uses.

  It also asks GitHub which form of OIDC subject this repository's runs present, using GH_TOKEN
  or GITHUB_TOKEN if either is set. Reading that setting needs repository admin. Without it,
  skyhook assumes the conventional repo:<owner>/<name> form and says so — which is right for
  most organizations and wrong for one that qualifies its subjects with numeric ids. If yours
  does, and skyhook had to assume, every role assumption will be refused with nothing but an
  access-denied to explain it. Set a token and run this again.

Options for deploy:
  --root <path>              The consuming repository's checkout. Defaults to the current directory.

  deploy runs inside GitHub Actions and reads everything else from the event and from
  .skyhook/config.yml on the DEFAULT BRANCH. It claims this pull request's environment,
  applies your infrastructure into an isolated copy of it, records the result, and writes
  the environment's URL to the step's outputs. It never comments on a pull request.
  Exit 3 means your own apply failed; exit 1 means skyhook could not do its job.

teardown, protect, unprotect and sweep:

  teardown without an environment name runs inside GitHub Actions on a pull request's close
  event. It destroys that pull request's environment, removes its record, and frees the
  name. The close event is a fast path only — a missed one is repaired by the next sweep
  pass.

  teardown --environment <name> (or SKYHOOK_ENVIRONMENT) is the manual teardown of a
  long-running environment: an explicit human order, dispatched against the DEFAULT branch
  — no other ref qualifies for the credentials. A protected environment refuses it with a
  non-zero exit until a human clears the mark first.

  protect and unprotect set and clear an environment's protection mark. Env-driven like
  sweep: the environment comes from SKYHOOK_ENVIRONMENT, dispatched against the DEFAULT
  branch. While the mark is set, nothing destroys the environment — not the sweep, not the
  close event, not the manual teardown. The mark guards destruction only: default-branch
  deploys still update the environment in place. It can be set or cleared only while the
  environment is active.

  sweep runs on a schedule from the default branch (or by hand, the day the scheduler does
  not). It compares the registry against the pull requests' actual state and destroys every
  eligible environment: closed pull request, not protected. A protected environment is never
  destroyed automatically. Exit 3 means only your own destroys failed; exit 1 means skyhook
  could not do its job.

Options for dashboard:
  --repository <owner/name>  Overrides the repository read from the git remote.
  --root <path>              Where the installation is. Defaults to the current directory.
  --port <number>            The local port to serve on. Defaults to one the OS picks.

  dashboard serves a read-only page on 127.0.0.1 showing every environment the registry
  records: identity, state, protection, last deploy, and URL, plus how close the repository
  is to its environment cap. It reads with your own AWS credentials, publishes nothing, and
  changes nothing. Refresh the page to re-read the registry; Ctrl-C to stop.

Options for destruct:
  --repository <owner/name>  Overrides the repository read from the git remote.
  --root <path>              Where the installation is. Defaults to the current directory.
  --keep-trust-anchor        Stop managing the trust anchor instead of destroying it, for when
                             skyhook created it but other workloads now rely on it.
  --yes                      Skip the confirmation. For non-interactive use only.

  destruct removes what skyhook created in your account and nothing else. It refuses while any
  environment is still recorded in the registry: that record is the only thing that knows what
  needs tearing down, and destroying it would leave infrastructure nobody can find.

Other:
  -h, --help                 Show this.
  --version                  Show the version.`;

export interface CliDeps {
  readonly runner: CommandRunner;
  readonly confirm: Confirm;
  readonly confirmExact: ConfirmExact;
}

const DEFAULT_DEPS: CliDeps = {
  runner: systemRunner,
  confirm: terminalConfirm,
  confirmExact: terminalConfirmExact,
};

/**
 * `init` is synchronous and `bootstrap` is not, so the entry point is async and `init`'s
 * synchronous path is simply awaited trivially. Better one shape than two.
 */
export async function runCli(
  argv: readonly string[],
  io: CliIo = DEFAULT_IO,
  deps: CliDeps = DEFAULT_DEPS,
): Promise<number> {
  const [command, ...rest] = argv;

  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    io.out(USAGE);
    return command === undefined ? EXIT_USAGE : EXIT_OK;
  }
  if (command === '--version') {
    io.out(version());
    return EXIT_OK;
  }
  if (command === 'init') return runInit(rest, io);
  if (command === 'bootstrap') return runBootstrap(rest, io, deps);
  if (command === 'destruct') return runDestruct(rest, io, deps);
  if (command === 'deploy') return runDeploy(rest, io, deps);
  if (command === 'teardown') return runTeardown(rest, io, deps);
  if (command === 'protect') return runProtect(true, rest, io, deps);
  if (command === 'unprotect') return runProtect(false, rest, io, deps);
  if (command === 'sweep') return runSweep(rest, io, deps);
  if (command === 'dashboard') return runDashboard(rest, io, deps);

  io.err(`skyhook: unknown command "${command}"`);
  io.err('');
  io.err(USAGE);
  return EXIT_USAGE;
}

async function runBootstrap(
  argv: readonly string[],
  io: CliIo,
  deps: CliDeps,
): Promise<number> {
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        repository: { type: 'string' },
        'default-branch': { type: 'string' },
        root: { type: 'string' },
        yes: { type: 'boolean' },
      },
      allowPositionals: false,
    }) as { values: Record<string, string | boolean | undefined> });
  } catch (error) {
    io.err(`skyhook bootstrap: ${(error as Error).message}`);
    return EXIT_USAGE;
  }

  const outcome = await bootstrap({
    repositoryRoot: (values['root'] as string | undefined) ?? process.cwd(),
    runner: deps.runner,
    confirm: deps.confirm,
    out: io.out,
    err: io.err,
    repository: values['repository'] as string | undefined,
    defaultBranch: values['default-branch'] as string | undefined,
    assumeYes: values['yes'] === true,
  });

  if (!outcome.ok) {
    io.err(`skyhook bootstrap: ${outcome.problem}`);
    return EXIT_FAILED;
  }
  return EXIT_OK;
}

function runInit(argv: readonly string[], io: CliIo): number {
  let values: Record<string, string | undefined>;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        repository: { type: 'string' },
        bucket: { type: 'string' },
        region: { type: 'string' },
        'default-branch': { type: 'string' },
        root: { type: 'string' },
      },
      allowPositionals: false,
    }) as { values: Record<string, string | undefined> });
  } catch (error) {
    io.err(`skyhook init: ${(error as Error).message}`);
    return EXIT_USAGE;
  }

  const missing = (['repository', 'bucket', 'region'] as const).filter(
    (name) => values[name] === undefined || values[name] === '',
  );
  if (missing.length > 0) {
    io.err(`skyhook init: missing required ${missing.length === 1 ? 'option' : 'options'}: ${missing.map((m) => `--${m}`).join(', ')}`);
    io.err('');
    io.err(USAGE);
    return EXIT_USAGE;
  }

  const repository = values['repository'] ?? '';
  if (!REPOSITORY_PATTERN.test(repository)) {
    // Caught here rather than deep inside key derivation, because the message an operator needs
    // is about the flag they typed, not about a storage key they have never heard of.
    io.err(`skyhook init: --repository must be "owner/name", got "${repository}"`);
    return EXIT_USAGE;
  }

  const result = init({
    repositoryRoot: values['root'] ?? process.cwd(),
    repository,
    bucket: values['bucket'] ?? '',
    region: values['region'] ?? '',
    defaultBranch: values['default-branch'],
  });

  for (const message of result.messages) io.out(message);
  return EXIT_OK;
}

async function runDeploy(argv: readonly string[], io: CliIo, deps: CliDeps): Promise<number> {
  let values: Record<string, string | undefined>;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: { root: { type: 'string' } },
      allowPositionals: false,
    }) as { values: Record<string, string | undefined> });
  } catch (error) {
    io.err(`skyhook deploy: ${(error as Error).message}`);
    return EXIT_USAGE;
  }

  return deploy({
    env: process.env,
    repositoryRoot: values['root'] ?? process.cwd(),
    runner: deps.runner,
    out: io.out,
    err: io.err,
  });
}

async function runTeardown(argv: readonly string[], io: CliIo, deps: CliDeps): Promise<number> {
  let values: Record<string, string | undefined>;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: { environment: { type: 'string' } },
      allowPositionals: false,
    }) as { values: Record<string, string | undefined> });
  } catch (error) {
    io.err(`skyhook teardown: ${(error as Error).message} — the closed pull request or --environment <name> is the input`);
    return EXIT_USAGE;
  }
  return teardown({
    env: process.env,
    runner: deps.runner,
    out: io.out,
    err: io.err,
    environment: values['environment'],
  });
}

async function runProtect(mark: boolean, argv: readonly string[], io: CliIo, deps: CliDeps): Promise<number> {
  if (argv.length > 0) {
    io.err(`skyhook ${mark ? 'protect' : 'unprotect'}: takes no arguments — the environment comes from SKYHOOK_ENVIRONMENT`);
    return EXIT_USAGE;
  }
  return protect(mark, { env: process.env, runner: deps.runner, out: io.out, err: io.err });
}

async function runSweep(argv: readonly string[], io: CliIo, deps: CliDeps): Promise<number> {
  if (argv.length > 0) {
    io.err('skyhook sweep: takes no arguments — the registry is the input');
    return EXIT_USAGE;
  }
  return sweep({ env: process.env, runner: deps.runner, out: io.out, err: io.err });
}

async function runDashboard(argv: readonly string[], io: CliIo, deps: CliDeps): Promise<number> {
  let values: Record<string, string | undefined>;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        repository: { type: 'string' },
        root: { type: 'string' },
        port: { type: 'string' },
      },
      allowPositionals: false,
    }) as { values: Record<string, string | undefined> });
  } catch (error) {
    io.err(`skyhook dashboard: ${(error as Error).message}`);
    return EXIT_USAGE;
  }

  let port: number | undefined;
  if (values['port'] !== undefined) {
    port = Number(values['port']);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      io.err(`skyhook dashboard: --port must be a port number, got "${values['port']}"`);
      return EXIT_USAGE;
    }
  }

  return dashboard({
    repositoryRoot: values['root'] ?? process.cwd(),
    runner: deps.runner,
    out: io.out,
    err: io.err,
    repository: values['repository'],
    port,
  });
}

async function runDestruct(argv: readonly string[], io: CliIo, deps: CliDeps): Promise<number> {
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        repository: { type: 'string' },
        root: { type: 'string' },
        'keep-trust-anchor': { type: 'boolean' },
        yes: { type: 'boolean' },
      },
      allowPositionals: false,
    }) as { values: Record<string, string | boolean | undefined> });
  } catch (error) {
    io.err(`skyhook destruct: ${(error as Error).message}`);
    return EXIT_USAGE;
  }

  const outcome = await destruct({
    repositoryRoot: (values['root'] as string | undefined) ?? process.cwd(),
    runner: deps.runner,
    confirmExact: deps.confirmExact,
    out: io.out,
    err: io.err,
    repository: values['repository'] as string | undefined,
    keepTrustAnchor: values['keep-trust-anchor'] === true,
    assumeYes: values['yes'] === true,
  });

  if (!outcome.ok) {
    io.err(`skyhook destruct: ${outcome.problem}`);
    return EXIT_FAILED;
  }
  return EXIT_OK;
}

function version(): string {
  return 'skyhook 0.0.0 (prototype)';
}
