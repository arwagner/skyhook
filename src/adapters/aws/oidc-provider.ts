/**
 * Answering the one question Terraform cannot answer about itself.
 *
 * An IAM OIDC provider is unique per URL per account, so the bootstrap must either create one or
 * adopt the existing one — and a Terraform data source for a provider that does not exist is an
 * *error*, not an empty result. The definition therefore cannot probe and branch; something
 * outside it has to look first. That is this.
 *
 * It reads. It never creates, modifies, or deletes anything.
 */

import type { CommandRunner } from '../../cli/process.ts';

export const GITHUB_OIDC_ISSUER = 'token.actions.githubusercontent.com';

export type OidcLookup =
  | { readonly ok: true; readonly exists: boolean }
  | { readonly ok: false; readonly problem: string };

/**
 * Whether this account already federates GitHub Actions.
 *
 * Uses the AWS CLI rather than a signed request of our own: this runs on an operator's machine
 * with whatever profile, SSO session, or assumed role they already have working, and reproducing
 * that credential-resolution chain to save one dependency would be a poor trade. Skyhook's *own*
 * runtime path signs its own requests and takes no such dependency.
 */
export async function hasGitHubOidcProvider(
  runner: CommandRunner,
  region: string,
): Promise<OidcLookup> {
  const result = await runner.run('aws', [
    'iam',
    'list-open-id-connect-providers',
    '--region',
    region,
    '--output',
    'json',
  ]);

  if (result.code !== 0) {
    return { ok: false, problem: firstMeaningfulLine(result.stderr) };
  }

  try {
    const parsed = JSON.parse(result.stdout) as {
      OpenIDConnectProviderList?: { Arn?: unknown }[];
    };
    const arns = (parsed.OpenIDConnectProviderList ?? [])
      .map((entry) => entry.Arn)
      .filter((arn): arn is string => typeof arn === 'string');
    return { ok: true, exists: arns.some((arn) => arn.endsWith(`/${GITHUB_OIDC_ISSUER}`)) };
  } catch {
    return { ok: false, problem: 'could not read the account\'s identity providers' };
  }
}

function firstMeaningfulLine(stderr: string): string {
  const line = stderr
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '');
  return line ?? 'the AWS CLI failed without saying why';
}
