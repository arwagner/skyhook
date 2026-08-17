/**
 * `skyhook bootstrap` — apply the definition `init` wrote.
 *
 * This is a second command rather than part of `init`, and the separation is deliberate. `init`
 * needs no cloud credentials, cannot half-create an account, and is safe to re-run as a repair;
 * fusing an apply into it would cost all three. It also gives the maintainer the one chance they
 * get to read the IAM roles before those roles exist — and since the whole security model of this
 * product is those policies, that reading is not ceremony.
 *
 * What this command removes is not the decision, only the typing: the settings come from the
 * configuration rather than from remembered flags, and the one thing Terraform cannot work out
 * for itself — whether the account already holds a trust anchor — is worked out here (AC-22).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseConfig, CONFIG_PATH } from '../core/config.ts';
import { hasGitHubOidcProvider } from '../adapters/aws/oidc-provider.ts';
import { bucketExists } from '../adapters/aws/bucket.ts';
import { subjectPrefix } from '../adapters/github/repository-ids.ts';
import { Terraform } from '../adapters/terraform/runner.ts';
import type { CommandRunner, Confirm } from './process.ts';

const BOOTSTRAP_DIR = '.skyhook/bootstrap';
const LOCAL_STATE = 'terraform.tfstate';

/**
 * Where the bootstrap's own state lives once it has a home.
 *
 * Outside the `state/` prefix managed environments use, and outside every prefix either skyhook
 * role is granted — so nothing skyhook runs can read the shape of its own boundary or rewrite it
 * (AC-24).
 */
export const BOOTSTRAP_STATE_KEY = 'bootstrap/terraform.tfstate';
const REPOSITORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface BootstrapOptions {
  readonly repositoryRoot: string;
  readonly runner: CommandRunner;
  readonly confirm: Confirm;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  /** Injected for tests. Defaults to the global fetch, used only to resolve the repository ids. */
  readonly fetch?: typeof globalThis.fetch;
  /** A token that can read the repository, for resolving its numeric identifiers. */
  readonly githubToken?: string | undefined;
  /** Overrides the repository derived from the git remote. */
  readonly repository?: string | undefined;
  readonly defaultBranch?: string | undefined;
  /** Skips the confirmation. For non-interactive use, and never the default. */
  readonly assumeYes?: boolean | undefined;
}

export type BootstrapOutcome =
  | { readonly ok: true; readonly applied: boolean }
  | { readonly ok: false; readonly problem: string };

export async function bootstrap(options: BootstrapOptions): Promise<BootstrapOutcome> {
  const { out, err } = options;

  // --- settings come from the config, not from the operator's memory --------
  const configPath = join(options.repositoryRoot, CONFIG_PATH);
  let document: string;
  try {
    document = readFileSync(configPath, 'utf8');
  } catch {
    return { ok: false, problem: `no ${CONFIG_PATH} here — run "skyhook init" first` };
  }
  const config = parseConfig(document);
  if (!config.ok) {
    return { ok: false, problem: `${CONFIG_PATH}: ${config.problems.join('; ')}` };
  }
  const { bucket, region } = config.config.storage;

  const repository = options.repository ?? (await repositoryFromGit(options));
  if (repository === null) {
    return {
      ok: false,
      problem: 'could not work out the repository from the git remote — pass --repository owner/name',
    };
  }
  if (!REPOSITORY_PATTERN.test(repository)) {
    return { ok: false, problem: `repository must be "owner/name", got "${repository}"` };
  }

  // --- the question Terraform cannot answer about itself (AC-22) -----------
  const lookup = await hasGitHubOidcProvider(options.runner, region);
  if (!lookup.ok) {
    err(`Could not read the account's identity providers: ${lookup.problem}`);
    err('Check your AWS credentials — try AWS_PROFILE=<profile>, or aws sso login.');
    return { ok: false, problem: lookup.problem };
  }

  // AWS refuses a trust policy for this provider that does not condition on the subject, and the
  // subject's form is the organization's choice rather than skyhook's. Asked before anything is
  // planned, because a wrong prefix produces an AccessDenied that names nothing.
  const subject = await subjectPrefix({
    repository,
    token: options.githubToken ?? process.env['GH_TOKEN'] ?? process.env['GITHUB_TOKEN'],
    fetch: options.fetch,
  });
  if (!subject.ok) {
    err(`Could not read the OIDC subject settings for ${repository}: ${subject.problem}`);
    err('The trust policies pin that subject, so skyhook will not guess it. See the note in');
    err('.skyhook/bootstrap/oidc.tf for why.');
    return { ok: false, problem: subject.problem };
  }

  out(`Repository:  ${repository}`);
  out(
    subject.stated
      ? `Subject:     ${subject.prefix} (as GitHub reports it)`
      : `Subject:     ${subject.prefix} (ASSUMED — GitHub did not say)`,
  );
  // gap-007. The fallback used to read "(the conventional form; GitHub did not state one)",
  // which is true, neutral, and useless: it states a fact where the operator needs a warning.
  // Reading that setting needs repository admin, so the person who gets the fallback is exactly
  // the person who cannot check it — and what follows a wrong assumption is an AccessDenied
  // naming nothing. So the assumption says what it will look like when it is wrong.
  if (!subject.stated) {
    out('             The trust policies will pin that subject. If this organization qualifies');
    out('             its subjects with numeric ids, this is wrong and every role assumption');
    out('             will be refused. Set GH_TOKEN or GITHUB_TOKEN (repository admin) to have');
    out('             skyhook ask instead of assume.');
  }
  out(`Bucket:      ${bucket} (${region})`);
  out(
    lookup.exists
      ? 'Trust anchor: one already exists in this account — skyhook will adopt it and leave it alone.'
      : 'Trust anchor: none in this account — skyhook will create one.',
  );
  out('');

  const vars = {
    repository,
    subject_prefix: subject.prefix,
    bucket_name: bucket,
    aws_region: region,
    create_oidc_provider: !lookup.exists,
    ...(options.defaultBranch === undefined ? {} : { default_branch: options.defaultBranch }),
  };

  // Where does the state live? The bucket is a resource this configuration creates, so on a first
  // run there is nowhere to put it and Terraform must run locally, then migrate (AC-23).
  const directory = join(options.repositoryRoot, BOOTSTRAP_DIR);
  const bucketLookup = await bucketExists(options.runner, bucket, region);
  if (!bucketLookup.ok) {
    err(`Could not tell whether ${bucket} exists: ${bucketLookup.problem}`);
    return { ok: false, problem: bucketLookup.problem };
  }
  const localState = existsSync(join(directory, LOCAL_STATE));
  const backend = { bucket, key: BOOTSTRAP_STATE_KEY, region };

  if (!bucketLookup.exists) {
    out('');
    out('This runs in two passes: create the bucket, then move this state into it, so a');
    out('deleted or re-cloned working tree never strands what the bootstrap created.');
  }
  out('');

  const terraform = new Terraform({ runner: options.runner, directory });

  const initialized = bucketLookup.exists
    ? await terraform.initBackend(backend, { migrate: localState })
    : await terraform.initLocal();
  if (initialized.code !== 0) return { ok: false, problem: 'terraform init failed' };

  out('');
  out('This is what would change:');
  out('');
  const planned = await terraform.plan(vars);
  if (planned.code !== 0) return { ok: false, problem: 'terraform plan failed' };

  // --- nothing happens without a yes (AC-21) -------------------------------
  if (options.assumeYes !== true) {
    const agreed = await options.confirm('Apply this? It creates real resources in your account.');
    if (!agreed) {
      out('Nothing applied. Your account is unchanged.');
      return { ok: true, applied: false };
    }
  }

  const applied = await terraform.apply(vars);
  if (applied.code !== 0) return { ok: false, problem: 'terraform apply failed' };

  // Second pass: the bucket exists now, so the state can move into it (AC-23).
  if (!bucketLookup.exists) {
    out('');
    out('Moving this state into the bucket it just created...');
    const migrated = await terraform.initBackend(backend, { migrate: true });
    if (migrated.code !== 0) {
      // The resources exist. Saying "failed" would be wrong, and saying nothing would be worse:
      // the state is sitting in a working tree that nobody knows to protect.
      err('');
      err('The resources were created, but the state could not be moved into the bucket.');
      err(`It is still local, at ${join(BOOTSTRAP_DIR, LOCAL_STATE)} — do not delete it.`);
      err('Run this command again to finish the move.');
      return { ok: false, problem: 'state migration failed after a successful apply' };
    }
    out(`State now lives at s3://${bucket}/${BOOTSTRAP_STATE_KEY} — encrypted, versioned, and`);
    out('readable by neither role skyhook installed.');
  }

  out('');
  out('Done. Next:');
  out(`  - copy .skyhook/workflow.yml to .github/workflows/skyhook.yml`);
  out('  - set the repository variables the workflow reads from the bootstrap outputs');
  out('  - run this command again; it should report no changes');
  return { ok: true, applied: true };
}

/**
 * The repository, from the git remote. Asked rather than typed, because the operator has already
 * told git what this repository is and a second answer is a second thing to get wrong.
 */
async function repositoryFromGit(options: BootstrapOptions): Promise<string | null> {
  const result = await options.runner.run('git', ['remote', 'get-url', 'origin'], {
    cwd: options.repositoryRoot,
  });
  if (result.code !== 0) return null;
  return parseRepository(result.stdout.trim());
}

/** Handles both remote spellings: `git@host:owner/name.git` and `https://host/owner/name.git`. */
export function parseRepository(remoteUrl: string): string | null {
  const match = /[:/]([A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*?)(?:\.git)?$/.exec(
    remoteUrl,
  );
  return match?.[1] ?? null;
}
