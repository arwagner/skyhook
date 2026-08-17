/**
 * An identity token from the Actions token service.
 *
 * This is the whole of skyhook's keyless story on the CI side: the job asks GitHub for a
 * short-lived token describing itself, and the cloud decides what that description is
 * allowed to become. Nothing long-lived exists anywhere in the exchange.
 */

export interface IdTokenOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Injected for tests. Defaults to the global `fetch`. */
  readonly fetch?: typeof globalThis.fetch;
}

export type IdTokenOutcome =
  | { readonly ok: true; readonly token: string }
  | { readonly ok: false; readonly problem: string };

export async function requestIdToken(
  audience: string,
  options: IdTokenOptions,
): Promise<IdTokenOutcome> {
  const url = options.env['ACTIONS_ID_TOKEN_REQUEST_URL'];
  const requestToken = options.env['ACTIONS_ID_TOKEN_REQUEST_TOKEN'];

  // Absent means the workflow did not ask for the permission — a one-line fix in a file
  // the maintainer owns. Reporting it as a network or auth failure would send them
  // looking at the cloud, which is not where the problem is.
  if (url === undefined || url === '' || requestToken === undefined || requestToken === '') {
    return {
      ok: false,
      problem:
        'this job cannot request an identity token, so the workflow is missing ' +
        '`permissions: id-token: write`. Add it to the job that calls skyhook.',
    };
  }

  const doFetch = options.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await doFetch(`${url}&audience=${encodeURIComponent(audience)}`, {
      headers: { authorization: `Bearer ${requestToken}`, accept: 'application/json' },
    });
  } catch (error) {
    return { ok: false, problem: `requesting an identity token failed: ${(error as Error).message}` };
  }

  if (!response.ok) {
    return {
      ok: false,
      problem: `requesting an identity token failed: ${response.status} ${response.statusText}`,
    };
  }

  const body = (await response.json()) as { value?: unknown };
  if (typeof body.value !== 'string' || body.value === '') {
    return { ok: false, problem: 'the identity token service returned no token' };
  }
  return { ok: true, token: body.value };
}
