/**
 * Exchanging a GitHub identity token for cloud credentials.
 *
 * `AssumeRoleWithWebIdentity` is the one AWS call skyhook makes that needs no signature —
 * the token authenticates it. So this file takes no dependency on `sigv4.ts` and does not
 * need credentials to obtain credentials, which would otherwise be circular.
 *
 * The response is read with regexes rather than an XML parser, consistent with (and adding
 * to) the debt `src/adapters/aws/sigv4.ts` already carries in the backlog.
 */

export interface AssumeRoleRequest {
  readonly region: string;
  readonly roleArn: string;
  /** Shows up in CloudTrail and in `aws:userid`, so it names the environment. */
  readonly roleSessionName: string;
  readonly webIdentityToken: string;
  /** An inline policy that can only narrow what the role already permits. */
  readonly policy?: string | undefined;
  readonly durationSeconds?: number | undefined;
}

export interface AssumedCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken: string;
  readonly expiration: string;
  /**
   * Taken from the assumed-role ARN in the response.
   *
   * This is why skyhook needs no `GetCallerIdentity`, and therefore no signed call, to
   * learn the account it is in — which is what lets every other role identifier be derived
   * rather than typed into settings (feat-002 plan D4).
   */
  readonly accountId: string;
}

export type AssumeRoleOutcome =
  | { readonly ok: true; readonly credentials: AssumedCredentials }
  | { readonly ok: false; readonly code: string; readonly problem: string };

export interface StsOptions {
  /** Injected for tests. Defaults to the global `fetch`. */
  readonly fetch?: typeof globalThis.fetch;
  /** Overrides the endpoint host. For a local stand-in. */
  readonly host?: string;
}

/**
 * The shortest session that survives a slow apply.
 *
 * The consuming repo's Terraform runs alongside these credentials and can read them —
 * inherent to letting a repository deploy itself, and not a defect. What *is* a choice is
 * how long a stolen one stays useful, so this is deliberately short rather than the
 * one-hour default (feat-002 plan D3). 900 seconds is the minimum AWS accepts.
 */
export const DEFAULT_SESSION_SECONDS = 3_600 / 2;

export async function assumeRoleWithWebIdentity(
  request: AssumeRoleRequest,
  options: StsOptions = {},
): Promise<AssumeRoleOutcome> {
  const host = options.host ?? `sts.${request.region}.amazonaws.com`;
  const body = new URLSearchParams({
    Action: 'AssumeRoleWithWebIdentity',
    Version: '2011-06-15',
    RoleArn: request.roleArn,
    RoleSessionName: request.roleSessionName,
    WebIdentityToken: request.webIdentityToken,
    DurationSeconds: String(request.durationSeconds ?? DEFAULT_SESSION_SECONDS),
  });
  if (request.policy !== undefined) body.set('Policy', request.policy);

  const doFetch = options.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await doFetch(`https://${host}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/xml' },
      body: body.toString(),
    });
  } catch (error) {
    return { ok: false, code: 'NetworkError', problem: (error as Error).message };
  }

  const text = await response.text();
  if (!response.ok) {
    const code = firstMatch(text, /<Code>([^<]+)<\/Code>/) ?? String(response.status);
    const message = firstMatch(text, /<Message>([^<]+)<\/Message>/) ?? response.statusText;
    return { ok: false, code, problem: `${code}: ${message}` };
  }

  const accessKeyId = firstMatch(text, /<AccessKeyId>([^<]+)<\/AccessKeyId>/);
  const secretAccessKey = firstMatch(text, /<SecretAccessKey>([^<]+)<\/SecretAccessKey>/);
  const sessionToken = firstMatch(text, /<SessionToken>([^<]+)<\/SessionToken>/);
  const expiration = firstMatch(text, /<Expiration>([^<]+)<\/Expiration>/);
  const assumedArn = firstMatch(text, /<Arn>([^<]+)<\/Arn>/);
  const accountId = assumedArn === null ? null : accountFromArn(assumedArn);

  if (
    accessKeyId === null ||
    secretAccessKey === null ||
    sessionToken === null ||
    expiration === null ||
    accountId === null
  ) {
    // Never a partial credential. Half a set would fail later, somewhere else, in a way
    // that looks like a permissions problem.
    return { ok: false, code: 'MalformedResponse', problem: 'the response carried no usable credentials' };
  }

  return {
    ok: true,
    credentials: { accessKeyId, secretAccessKey, sessionToken, expiration, accountId },
  };
}

/** `arn:aws:sts::<account>:assumed-role/<role>/<session>` — the account is the fifth field. */
function accountFromArn(arn: string): string | null {
  const parts = arn.split(':');
  const account = parts[4];
  return account !== undefined && account !== '' ? account : null;
}

function firstMatch(text: string, pattern: RegExp): string | null {
  const match = pattern.exec(text);
  return match?.[1] ?? null;
}
