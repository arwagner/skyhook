/**
 * `skyhook destruct` — remove the infrastructure skyhook created, and nothing else.
 *
 * Two principles run through this, and both come from the constitution rather than from
 * convenience.
 *
 * **No orphans.** The registry is the only record of which environments exist and must be
 * destroyed. Deleting the bucket while that record is non-empty would destroy the evidence of
 * what still needs cleaning up — manufacturing exactly the leaked, unbillable-to-anyone
 * environments the constitution forbids. So this refuses while any environment record remains.
 * That refusal is the seam the sweep and teardown work plugs into later; until it exists, the
 * honest answer is to stop and say so.
 *
 * **Skyhook touches only what it owns.** What gets destroyed is what is in skyhook's Terraform
 * state, which by construction is what skyhook created. A trust anchor that was *adopted* is a
 * data source rather than a resource, so it is not in state and destroy cannot reach it — that
 * property was built for the bootstrap and pays off again here, unchanged.
 *
 * **Nothing irreversible happens until the whole removal is known to work.** The bucket has to be
 * emptied before it can be deleted, and emptying it cannot be undone — so a destroy that refuses
 * after that point leaves an installation half torn down, its only remaining record an untracked
 * local file. A real removal failed exactly that way, on a required variable this command was not
 * passing. The order below therefore plans first and empties second, so that every reason
 * Terraform might refuse is found while the installation is still whole and the operator can
 * simply run the command again.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseConfig, CONFIG_PATH } from '../core/config.ts';
import { identityFromRegistryKey, REGISTRY_PREFIX, PROTECTION_PREFIX } from '../core/registry.ts';
import { bucketExists, emptyBucket, listKeys } from '../adapters/aws/bucket.ts';
import { Terraform } from '../adapters/terraform/runner.ts';
import { BOOTSTRAP_STATE_KEY, parseRepository } from './bootstrap.ts';
import type { CommandRunner, Confirm } from './process.ts';

const BOOTSTRAP_DIR = '.skyhook/bootstrap';
const LOCAL_STATE = 'terraform.tfstate';


const TRUST_ANCHOR_ADDRESS = 'aws_iam_openid_connect_provider.github[0]';

/** The claim both trust policies pin, and the suffix the pull-request role's subject carries. */
const OIDC_SUBJECT_CLAIM = 'token.actions.githubusercontent.com:sub';
const PULL_REQUEST_SUFFIX = ':pull_request';

export interface DestructOptions {
  readonly repositoryRoot: string;
  readonly runner: CommandRunner;
  /** Asked to type something exact, not to press y — this is not reversible. */
  readonly confirmExact: (question: string, expected: string) => Promise<boolean>;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  readonly repository?: string | undefined;
  readonly assumeYes?: boolean | undefined;
  /**
   * Stop managing the trust anchor instead of destroying it, for when skyhook created it but
   * other workloads have since come to rely on it.
   */
  readonly keepTrustAnchor?: boolean | undefined;
}

export type DestructOutcome =
  | { readonly ok: true; readonly destroyed: boolean }
  | { readonly ok: false; readonly problem: string };

export async function destruct(options: DestructOptions): Promise<DestructOutcome> {
  const { out, err, runner } = options;

  const configPath = join(options.repositoryRoot, CONFIG_PATH);
  if (!existsSync(configPath)) {
    return { ok: false, problem: `no ${CONFIG_PATH} here — nothing of skyhook's to remove` };
  }
  const config = parseConfig(readFileSync(configPath, 'utf8'));
  if (!config.ok) return { ok: false, problem: `${CONFIG_PATH}: ${config.problems.join('; ')}` };
  const { bucket, region } = config.config.storage;

  const repository = options.repository ?? (await repositoryFromGit(options));
  if (repository === null) {
    return {
      ok: false,
      problem: 'could not work out the repository from the git remote — pass --repository owner/name',
    };
  }

  const present = await bucketExists(runner, bucket, region);
  if (!present.ok) {
    err(`Could not tell whether ${bucket} exists: ${present.problem}`);
    err('Check your AWS credentials — try AWS_PROFILE=<profile>, or aws sso login.');
    return { ok: false, problem: present.problem };
  }
  if (!present.exists) {
    out(`${bucket} does not exist. There is nothing here to remove.`);
    return { ok: true, destroyed: false };
  }

  // --- the refusal that keeps the "no orphans" promise ----------------------
  const registry = await listKeys(runner, bucket, region, REGISTRY_PREFIX);
  if (!registry.ok) return { ok: false, problem: registry.problem };

  const environments = describeEnvironments(registry.keys, repository);
  if (environments.length > 0) {
    err('');
    err(`Refusing: ${environments.length} environment${environments.length === 1 ? '' : 's'} still recorded in the registry.`);
    for (const name of environments.slice(0, 10)) err(`  ${name}`);
    if (environments.length > 10) err(`  …and ${environments.length - 10} more`);
    err('');
    err('The registry is the only record of what skyhook has provisioned. Destroying it while');
    err('environments remain would leave infrastructure standing that nothing can find or bill');
    err('to anyone — which is the one thing this project promises never to do.');
    err('');
    err('Tear those environments down first, then run this again.');
    return { ok: false, problem: 'environments still recorded in the registry' };
  }

  const marks = await listKeys(runner, bucket, region, PROTECTION_PREFIX);
  if (!marks.ok) return { ok: false, problem: marks.problem };
  if (marks.keys.length > 0) {
    // No record to match them, so nothing is protected any more — but say so rather than
    // sweeping them away silently, because a protection mark is a human's stated intention.
    out(`Note: ${marks.keys.length} protection mark(s) remain with no environment record.`);
    out('They protect nothing now and will be removed with the bucket.');
    out('');
  }

  // --- what is about to go -------------------------------------------------
  const directory = join(options.repositoryRoot, BOOTSTRAP_DIR);
  const terraform = new Terraform({ runner, directory });

  out('This removes the infrastructure skyhook created in your account:');
  out(`  - the bucket ${bucket} and everything in it, including the registry`);
  out('  - the two roles skyhook installed, and their policies');
  out(
    options.keepTrustAnchor === true
      ? '  - the trust anchor is KEPT (--keep-trust-anchor)'
      : '  - the trust anchor, but only if skyhook created it — an adopted one is not skyhook\'s to remove',
  );
  out('');
  out('It does not touch anything skyhook did not create. This cannot be undone.');
  out('');

  if (options.assumeYes !== true) {
    const agreed = await options.confirmExact(`Type the bucket name to confirm:`, bucket);
    if (!agreed) {
      out('Nothing removed. Your account is unchanged.');
      return { ok: true, destroyed: false };
    }
  }

  // --- bring the state home before deleting the bucket it lives in ---------
  // The state describing the bucket is stored *in* the bucket. Destroy needs the state, and the
  // bucket cannot be deleted while anything is in it, so the state has to come out first.
  try {
    return await removeEverything({ ...options, repository }, terraform, directory, bucket, region);
  } finally {
    // Guaranteed, including on failure: a leftover override would pin a later bootstrap to local
    // state, and `skyhook init` would not clean it up because it does not manage this file.
    terraform.clearLocalBackend();
  }
}

async function removeEverything(
  options: DestructOptions & { repository: string },
  terraform: Terraform,
  directory: string,
  bucket: string,
  region: string,
): Promise<DestructOutcome> {
  const { out, err, runner, repository } = options;

  const migrated = await terraform.initMigrateToLocal();
  if (migrated.code !== 0) {
    return { ok: false, problem: 'could not bring the state out of the bucket' };
  }
  if (!existsSync(join(directory, LOCAL_STATE))) {
    // Nothing was deleted yet, so stopping here costs nothing and guessing would cost everything.
    return { ok: false, problem: 'the state did not arrive locally; refusing to delete anything' };
  }

  if (options.keepTrustAnchor === true) {
    // Not an error if it is absent: an adopted anchor was never in state to begin with.
    await terraform.stateRm(TRUST_ANCHOR_ADDRESS);
  }

  // Whether the trust anchor is skyhook's to destroy is not a guess and not a flag — it is a
  // fact recorded in state. An adopted anchor was never a resource, so it is not listed, and
  // `create_oidc_provider: false` keeps it a data source that destroy reads and leaves alone.
  const listed = await terraform.stateList();
  const skyhookCreatedAnchor = /aws_iam_openid_connect_provider\.github/.test(listed.stdout);

  const vars = {
    repository,
    bucket_name: bucket,
    aws_region: region,
    create_oidc_provider: skyhookCreatedAnchor,
    // Recovered from state rather than re-derived. The configuration requires it, so without it
    // the destroy below fails on a missing variable — and it would fail *after* the bucket was
    // emptied, which is the half-torn-down state the plan step now prevents.
    subject_prefix: subjectPrefixFromState(
      readFileSync(join(directory, LOCAL_STATE), 'utf8'),
      repository,
    ),
  };

  // --- prove the destroy can run before anything becomes irreversible ------
  // Emptying the bucket cannot be undone and must precede deleting it, so every reason a destroy
  // might refuse — a missing variable, an unreadable provider, a lock it cannot take — has to be
  // found before that point. A plan finds them while the installation is still whole.
  const planned = await terraform.planDestroy(vars);
  if (planned.code !== 0) {
    err('');
    err('Terraform could not plan the removal, so nothing was deleted and your account is');
    err(`unchanged. The state is local, at ${join(BOOTSTRAP_DIR, LOCAL_STATE)} — it is the only`);
    err('record of what exists, so do not delete it. Fix what the plan reported and run this');
    err('again.');
    return { ok: false, problem: 'terraform plan -destroy failed' };
  }

  const emptied = await emptyBucket(runner, bucket, region);
  if (!emptied.ok) return { ok: false, problem: `could not empty ${bucket}: ${emptied.problem}` };
  out(`Removed ${emptied.removed} stored object version(s), including the registry.`);

  const destroyed = await terraform.destroy(vars);
  if (destroyed.code !== 0) {
    err('');
    err(`terraform destroy failed. The state is local, at ${join(BOOTSTRAP_DIR, LOCAL_STATE)}.`);
    err('Do not delete it — it is the only remaining record of what still exists.');
    return { ok: false, problem: 'terraform destroy failed' };
  }

  out('');
  out('Done. Skyhook created nothing else in this account.');
  out(`The definition is still in ${BOOTSTRAP_DIR}; run "skyhook bootstrap" to build it again.`);
  return { ok: true, destroyed: true };
}

/**
 * The subject prefix the installation was built with, recovered from its own state.
 *
 * The configuration requires this variable, so a destroy cannot even be planned without one.
 * Three ways to supply it were possible and two are wrong. Asking GitHub, as `bootstrap` does,
 * would make tearing down an installation depend on a token, on the network, and on the
 * repository still existing — none of which a removal should need. Giving the variable a default
 * would be worse: `bootstrap` deliberately refuses to guess this value, because a wrong prefix
 * produces roles that nothing can assume and an AccessDenied that names nothing, and a default
 * would turn that refusal into a silent guess for every future apply.
 *
 * So it is read back out of state, which is the same principle the trust-anchor question already
 * follows here: a fact skyhook recorded when it built the thing, not a fact it re-derives when
 * removing it. The pull-request role's trust policy pins `<prefix>:pull_request` — see
 * `pull_request_subject` in the bootstrap's oidc.tf — so the prefix is exactly that value with
 * the suffix removed.
 *
 * The fallback matters less than it looks. A destroy removes what is in state, and this value
 * reaches nothing but two policy *documents*, which a destroy evaluates and never applies. If
 * state is unreadable or holds no such role there is nothing left for the value to describe, so
 * the conventional form is enough to let Terraform finish rather than refusing over a variable
 * that cannot change the outcome.
 */
export function subjectPrefixFromState(state: string, repository: string): string {
  const conventional = `repo:${repository}`;

  let parsed: { resources?: readonly StateResource[] };
  try {
    parsed = JSON.parse(state) as typeof parsed;
  } catch {
    return conventional;
  }

  for (const resource of parsed.resources ?? []) {
    if (resource.mode !== 'managed') continue;
    if (resource.type !== 'aws_iam_role' || resource.name !== 'pull_request') continue;

    for (const instance of resource.instances ?? []) {
      const policy = instance.attributes?.['assume_role_policy'];
      if (typeof policy !== 'string') continue;

      let document: { Statement?: readonly TrustStatement[] };
      try {
        document = JSON.parse(policy) as typeof document;
      } catch {
        continue;
      }

      for (const statement of document.Statement ?? []) {
        const claim = statement?.Condition?.StringEquals?.[OIDC_SUBJECT_CLAIM];
        // IAM accepts a condition value as either a string or a list of them, and reports back
        // whichever form it was given.
        const subject = Array.isArray(claim) ? claim[0] : claim;
        if (typeof subject === 'string' && subject.endsWith(PULL_REQUEST_SUFFIX)) {
          return subject.slice(0, -PULL_REQUEST_SUFFIX.length);
        }
      }
    }
  }
  return conventional;
}

interface StateResource {
  readonly mode?: string;
  readonly type?: string;
  readonly name?: string;
  readonly instances?: readonly { readonly attributes?: Record<string, unknown> }[];
}

interface TrustStatement {
  readonly Condition?: {
    readonly StringEquals?: Record<string, string | readonly string[] | undefined>;
  };
}

async function repositoryFromGit(options: DestructOptions): Promise<string | null> {
  const result = await options.runner.run('git', ['remote', 'get-url', 'origin'], {
    cwd: options.repositoryRoot,
  });
  if (result.code !== 0) return null;
  return parseRepository(result.stdout.trim());
}

/** Environment records, named the way a human would say them. */
function describeEnvironments(keys: readonly string[], repository: string | undefined): string[] {
  return keys
    .filter((key) => key !== BOOTSTRAP_STATE_KEY && key.endsWith('.json'))
    .map((key) => {
      const identity = repository === undefined ? null : identityFromRegistryKey(repository, key);
      return identity ?? key.slice(REGISTRY_PREFIX.length, -'.json'.length);
    })
    .sort();
}
