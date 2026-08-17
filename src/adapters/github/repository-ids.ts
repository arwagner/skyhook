/**
 * The OIDC subject prefix a run in this repository will present.
 *
 * AWS leaves no choice about matching the subject: a trust policy for the GitHub provider is
 * REFUSED unless it conditions on `sub` or `job_workflow_ref`. Matching the immutable repository
 * and owner ids instead — which is otherwise the better design, since ids survive a rename and a
 * transfer — is rejected with `MalformedPolicyDocument`. That is the sort of thing only an apply
 * tells you.
 *
 * So the subject must be matched, and its form is not skyhook's to assume. An organization may
 * issue ID-qualified subjects, in which case a run presents
 * `repo:owner@26345547/name@1335111920:pull_request` rather than `repo:owner/name:pull_request`.
 * That form is GitHub's own defence against a resurrection attack: delete a repository, recreate
 * the name, inherit its trust. A policy written against the plain name refuses every assumption in
 * such an organization, and says only `AccessDenied`.
 *
 * GitHub states the prefix outright, so skyhook asks rather than guesses. Resolved here rather
 * than typed by the operator: somebody sent to find this string will paste it wrong, and the only
 * symptom is a refusal that names nothing.
 */

const DEFAULT_API_BASE = 'https://api.github.com';

export interface SubjectPrefixOptions {
  /** `owner/name`. */
  readonly repository: string;
  /**
   * A token that can read the repository's Actions settings. The customization endpoint needs
   * repository admin; the operator running the bootstrap normally has it.
   */
  readonly token?: string | undefined;
  readonly fetch?: typeof globalThis.fetch | undefined;
  readonly apiBase?: string | undefined;
}

export type SubjectPrefixOutcome =
  | {
      readonly ok: true;
      /** e.g. `repo:acme/widgets`, or `repo:acme@123/widgets@456`. */
      readonly prefix: string;
      /** True when GitHub stated it; false when skyhook fell back to the conventional form. */
      readonly stated: boolean;
    }
  | { readonly ok: false; readonly problem: string };

export async function subjectPrefix(options: SubjectPrefixOptions): Promise<SubjectPrefixOutcome> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const base = options.apiBase ?? DEFAULT_API_BASE;
  const conventional = `repo:${options.repository}`;

  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'skyhook',
  };
  if (options.token !== undefined && options.token !== '') {
    headers['authorization'] = `Bearer ${options.token}`;
  }

  let response: Response;
  try {
    response = await doFetch(`${base}/repos/${options.repository}/actions/oidc/customization/sub`, {
      headers,
    });
  } catch (error) {
    return { ok: false, problem: `could not reach GitHub: ${(error as Error).message}` };
  }

  // Reading this needs repository admin. Falling back to the conventional form is right for the
  // common case and wrong in exactly the organizations that most need it, so report which
  // happened and let the caller decide how loudly to say so.
  if (response.status === 403 || response.status === 404) {
    return { ok: true, prefix: conventional, stated: false };
  }
  if (!response.ok) {
    return {
      ok: false,
      problem: `reading the OIDC subject settings for ${options.repository} failed: ${response.status} ${response.statusText}`,
    };
  }

  let body: { sub_claim_prefix?: unknown };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    return { ok: false, problem: `GitHub's answer for ${options.repository} was not readable` };
  }

  const stated = body.sub_claim_prefix;
  if (typeof stated === 'string' && stated !== '') {
    return { ok: true, prefix: stated, stated: true };
  }
  return { ok: true, prefix: conventional, stated: false };
}
