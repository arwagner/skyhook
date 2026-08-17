/**
 * `PullRequestStateSource` over the GitHub API.
 *
 * The sweep's eligibility question — is this pull request actually closed? — asked of the
 * host's live state rather than of anything a missed close event should have recorded
 * (constitution: correctness may never depend on an event firing). The pull request
 * number arrives derived from a registry KEY, never from a record body (feat-003 plan
 * D2), and the repository is pinned at construction, so a lookup cannot be pointed
 * anywhere else.
 */

import type { PullRequestStateOutcome, PullRequestStateSource } from '../../core/ports.ts';

export interface GitHubPullRequestsOptions {
  /** `owner/name` — every lookup is confined to this repository. */
  readonly repository: string;
  /** The job's own token. Needs `pull-requests: read`, which the scaffolded workflow grants. */
  readonly token: string;
  /** Injected for tests. Defaults to the global `fetch`. */
  readonly fetch?: typeof globalThis.fetch;
  readonly apiBase?: string;
}

const DEFAULT_API_BASE = 'https://api.github.com';

export class GitHubPullRequests implements PullRequestStateSource {
  readonly #options: GitHubPullRequestsOptions;

  constructor(options: GitHubPullRequestsOptions) {
    this.#options = options;
  }

  async state(repository: string, pullRequestNumber: number): Promise<PullRequestStateOutcome> {
    if (repository !== this.#options.repository) {
      return {
        ok: false,
        problem: `this source is pinned to ${this.#options.repository} and was asked about ${repository}`,
      };
    }

    const base = this.#options.apiBase ?? DEFAULT_API_BASE;
    const doFetch = this.#options.fetch ?? globalThis.fetch;
    let response: Response;
    try {
      response = await doFetch(`${base}/repos/${repository}/pulls/${pullRequestNumber}`, {
        headers: {
          authorization: `Bearer ${this.#options.token}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
        },
      });
    } catch (error) {
      return { ok: false, problem: `asking about pull request #${pullRequestNumber} failed: ${(error as Error).message}` };
    }

    // Loud, never a shrug: an environment whose pull request cannot be looked up is an
    // environment the sweep cannot judge, and it surfaces as that environment's failure.
    if (response.status === 404) {
      return {
        ok: false,
        problem:
          `pull request #${pullRequestNumber} was not found in ${repository}. ` +
          'The registry names an environment for it, so this needs a human look.',
      };
    }
    if (response.status === 403 || response.status === 401) {
      return {
        ok: false,
        problem:
          `asking about pull request #${pullRequestNumber} was refused (${response.status}). ` +
          "The sweep needs `pull-requests: read` in the workflow's permissions block.",
      };
    }
    if (!response.ok) {
      return {
        ok: false,
        problem: `asking about pull request #${pullRequestNumber} failed: ${response.status} ${response.statusText}`,
      };
    }

    let body: { state?: unknown };
    try {
      body = (await response.json()) as { state?: unknown };
    } catch {
      return { ok: false, problem: `pull request #${pullRequestNumber}: the host's answer was unreadable` };
    }
    // GitHub reports `open` or `closed`, and nothing else; anything else is a failure to
    // answer, not a state to act on.
    if (body.state === 'open' || body.state === 'closed') return { ok: true, state: body.state };
    return {
      ok: false,
      problem: `pull request #${pullRequestNumber}: the host reported state "${String(body.state)}"`,
    };
  }
}
