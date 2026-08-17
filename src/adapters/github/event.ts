/**
 * What GitHub Actions says happened, read as a `TriggerSource`.
 *
 * Everything here is a fact about GitHub's event payload and environment variables, which
 * is why it lives behind the port rather than in `src/core/`.
 */

import { readFileSync } from 'node:fs';
import type {
  DefaultBranchContext,
  PullRequestContext,
  TriggerOutcome,
  TriggerSource,
} from '../../core/ports.ts';

export interface GitHubTriggerOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Injected for tests. Defaults to reading the event payload off disk. */
  readonly readFile?: (path: string) => string;
}

interface EventPayload {
  readonly pull_request?: {
    readonly number?: unknown;
    readonly head?: { readonly sha?: unknown; readonly repo?: { readonly full_name?: unknown } | null };
  };
  readonly repository?: { readonly default_branch?: unknown };
}

export class GitHubTriggerSource implements TriggerSource {
  readonly #env: Readonly<Record<string, string | undefined>>;
  readonly #readFile: (path: string) => string;

  constructor(options: GitHubTriggerOptions) {
    this.#env = options.env;
    this.#readFile = options.readFile ?? ((path) => readFileSync(path, 'utf8'));
  }

  async read(): Promise<TriggerOutcome> {
    const eventName = this.#env['GITHUB_EVENT_NAME'];

    // Refused outright, and named, because it is the obvious way to "fix" fork support and
    // it is strictly worse than having none: it runs the base branch's workflow WITH
    // credentials against code the pull request author controls (constitution, forks).
    if (eventName === 'pull_request_target') {
      return {
        ok: false,
        problem:
          'skyhook does not run on pull_request_target. It runs the default branch\'s workflow ' +
          'with credentials against untrusted code, which is worse than giving fork pull ' +
          'requests no environment at all. Use pull_request.',
      };
    }
    if (eventName !== 'pull_request' && eventName !== 'push') {
      return {
        ok: false,
        problem: `skyhook deploy runs on pull_request and push events; this run is "${eventName ?? '(none)'}"`,
      };
    }

    const repository = this.#env['GITHUB_REPOSITORY'];
    if (repository === undefined || repository === '') {
      return { ok: false, problem: 'GITHUB_REPOSITORY is not set' };
    }

    const eventPath = this.#env['GITHUB_EVENT_PATH'];
    if (eventPath === undefined || eventPath === '') {
      return { ok: false, problem: 'GITHUB_EVENT_PATH is not set, so the event cannot be read' };
    }

    let payload: EventPayload;
    try {
      payload = JSON.parse(this.#readFile(eventPath)) as EventPayload;
    } catch (error) {
      return { ok: false, problem: `could not read the event payload: ${(error as Error).message}` };
    }

    if (eventName === 'push') return this.#readPush(repository, payload);

    const pullRequest = payload.pull_request;
    if (pullRequest === undefined) {
      return { ok: false, problem: 'the event payload carries no pull request' };
    }

    const number = pullRequest.number;
    if (typeof number !== 'number' || !Number.isInteger(number) || number < 1) {
      return { ok: false, problem: `the event payload carries no usable pull request number` };
    }

    // The pull request's own head, not GITHUB_SHA. On a pull_request event that variable
    // names an ephemeral merge commit which exists in no branch and which nobody would
    // recognise — and it is the commit that would be recorded and shown on a dashboard.
    const headSha = pullRequest.head?.sha;
    if (typeof headSha !== 'string' || headSha === '') {
      return { ok: false, problem: 'the event payload carries no head commit for the pull request' };
    }

    const context: PullRequestContext = {
      kind: 'pull-request',
      repository,
      pullRequestNumber: number,
      headCommit: headSha,
      fromFork: isFork(pullRequest.head?.repo?.full_name, repository),
    };
    return { ok: true, context };
  }

  /**
   * A push deploys a long-running environment (feat-006 plan D2). Only a push to the
   * repository's default branch qualifies; the refusal below is a clarity check for the
   * honest caller — the enforcement is the default-branch role's trust, which the cloud
   * holds whatever this code says.
   */
  #readPush(repository: string, payload: EventPayload): TriggerOutcome {
    const defaultBranch = payload.repository?.default_branch;
    if (typeof defaultBranch !== 'string' || defaultBranch === '') {
      return { ok: false, problem: 'the event payload does not name the default branch' };
    }

    const ref = this.#env['GITHUB_REF'];
    const needed = `refs/heads/${defaultBranch}`;
    if (ref !== needed) {
      return {
        ok: false,
        problem:
          `a long-running deploy runs only from the default branch: this push is to ` +
          `"${ref ?? '(none)'}" and the run needs "${needed}". Credentials that reach a ` +
          'long-running environment are issued only to a default-branch run, so any other ' +
          'ref would be refused by the cloud anyway — skyhook says so up front instead.',
      };
    }

    const headCommit = this.#env['GITHUB_SHA'];
    if (headCommit === undefined || headCommit === '') {
      return { ok: false, problem: 'GITHUB_SHA is not set, so the pushed commit is unknown' };
    }

    const requestedIdentity = this.#env['SKYHOOK_ENVIRONMENT'];
    if (requestedIdentity === undefined || requestedIdentity === '') {
      return {
        ok: false,
        problem:
          'SKYHOOK_ENVIRONMENT is not set. A push-triggered deploy is a long-running ' +
          "environment's, and its name is the operator's choice — set the `environment` " +
          'input on the skyhook step (the scaffolded workflow shows the commented-out block).',
      };
    }

    const context: DefaultBranchContext = {
      kind: 'default-branch',
      repository,
      headCommit,
      requestedIdentity,
    };
    return { ok: true, context };
  }
}

/**
 * A head repository that is not this one means a fork.
 *
 * A missing or null head repository counts as a fork too: it means the source was deleted,
 * and treating "cannot tell" as "same repository" would hand credentials to the one case
 * that must not get them. The safe default is the restrictive one.
 */
function isFork(headRepository: unknown, repository: string): boolean {
  if (typeof headRepository !== 'string' || headRepository === '') return true;
  return headRepository.toLowerCase() !== repository.toLowerCase();
}
