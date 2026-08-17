/**
 * `ConfigSource` over the GitHub contents API, pinned to the repository's default branch.
 *
 * The pin is the entire point. A pull-request run checks out the pull request's own code, so
 * reading `.skyhook/config.yml` from the working tree would read the attacker's copy — and the
 * environment cap is a setting an attacker would very much like to edit. This adapter never
 * reads from disk and never reads the pull request's head; it asks GitHub for the file as it
 * exists on the default branch (AC-9).
 *
 * The default branch is resolved from the repository itself rather than taken as input, so a
 * caller cannot pass `refs/heads/attacker-branch` and be believed.
 */

import type { ConfigFetchOutcome, ConfigSource } from '../../core/config.ts';
import { CONFIG_PATH } from '../../core/config.ts';

export interface GitHubConfigSourceOptions {
  /** `owner/name`. */
  readonly repository: string;
  /** A short-lived token with read access to the repository's contents. */
  readonly token: string;
  /** Injected for tests. Defaults to the global `fetch`. */
  readonly fetch?: typeof globalThis.fetch;
  readonly apiBase?: string;
}

const DEFAULT_API_BASE = 'https://api.github.com';

export class GitHubConfigSource implements ConfigSource {
  readonly #repository: string;
  readonly #token: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #apiBase: string;

  constructor(options: GitHubConfigSourceOptions) {
    this.#repository = options.repository;
    this.#token = options.token;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#apiBase = options.apiBase ?? DEFAULT_API_BASE;
  }

  async fetch(): Promise<ConfigFetchOutcome> {
    const branch = await this.#defaultBranch();
    if (branch === null) {
      return { ok: false, problem: `could not read the default branch of ${this.#repository}` };
    }

    const response = await this.#request(
      `/repos/${this.#repository}/contents/${CONFIG_PATH}?ref=${encodeURIComponent(branch)}`,
      'application/vnd.github.raw+json',
    );
    if (response.status === 404) return { ok: true, document: null };
    if (!response.ok) {
      return {
        ok: false,
        problem: `reading ${CONFIG_PATH} from ${this.#repository}@${branch} failed: ${response.status} ${response.statusText}`,
      };
    }
    return { ok: true, document: await response.text() };
  }

  /**
   * Asked of GitHub, not of the caller. Taking the branch as a parameter would move the decision
   * to whoever invokes skyhook — which, on a pull-request run, is a workflow file the pull
   * request author controls.
   */
  async #defaultBranch(): Promise<string | null> {
    const response = await this.#request(`/repos/${this.#repository}`, 'application/vnd.github+json');
    if (!response.ok) return null;
    const body = (await response.json()) as { default_branch?: unknown };
    return typeof body.default_branch === 'string' ? body.default_branch : null;
  }

  #request(path: string, accept: string): Promise<Response> {
    return this.#fetch(`${this.#apiBase}${path}`, {
      headers: {
        accept,
        authorization: `Bearer ${this.#token}`,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'skyhook',
      },
    });
  }
}
