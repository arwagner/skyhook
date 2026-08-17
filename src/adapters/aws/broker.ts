/**
 * Getting the two credentials a deploy needs, and building what needs them.
 *
 * Skyhook obtains both itself rather than asking the workflow to configure them, so the
 * file every consuming repo copies stays trivial and the narrowing is computed from the
 * same derived identity the run claims with. Those two cannot disagree if one piece of
 * code does both; split across a workflow file and a program, they can.
 *
 * **What the narrowing is worth, stated exactly.** The workflow that calls skyhook is a file a
 * pull request may edit (plan D2). Editing it gains no wider credentials — what a run may assume
 * is fixed by what TRIGGERED it, and no file in the repository can alter that — but it can
 * decline to run skyhook at all, and so decline the narrowing computed below. So this is a
 * guardrail against accident rather than a boundary the cloud enforces: it makes every honest run
 * incapable of touching a sibling preview environment even where a bug in skyhook's own code
 * would otherwise let it, and it stops there. The constitution records that as a decision, with
 * its cost, under "Preview environments are not isolated from each other, by decision".
 */

import { join } from 'node:path';
import type { AccessBroker, AccessOutcome, AccessRequest, EnvironmentDestroyer } from '../../core/ports.ts';
import { Registry } from '../../core/registry.ts';
import type { Store } from '../../core/store.ts';
import type { SkyhookConfig } from '../../core/types.ts';
import { S3Store } from './s3-store.ts';
import { assumeRoleWithWebIdentity, type AssumedCredentials } from './sts.ts';
import { sessionPolicyFor } from './session-policy.ts';
import { requestIdToken } from '../github/oidc-token.ts';
import { fetchDefinition, type FetchTarget } from '../git/commit-fetch.ts';
import { TerraformEnvironment } from '../terraform/environment.ts';
import type { CommandRunner } from '../../cli/process.ts';

/** What the cloud wants to hear as the token's intended recipient. */
const STS_AUDIENCE = 'sts.amazonaws.com';

export interface AwsBrokerOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly runner: CommandRunner;
  /** The consuming repo's checkout root. */
  readonly repositoryRoot: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
}

export class AwsAccessBroker implements AccessBroker {
  readonly #options: AwsBrokerOptions;

  constructor(options: AwsBrokerOptions) {
    this.#options = options;
  }

  async open(request: AccessRequest): Promise<AccessOutcome> {
    const { config, repository, identity } = request;
    const account = config.storage.account;
    const deploySettings = config.deploy;
    /* c8 ignore next 3 */
    if (account === null || deploySettings === null) {
      return { ok: false, reason: 'skyhook-role-unavailable', problem: 'configuration is incomplete' };
    }

    const token = await requestIdToken(STS_AUDIENCE, {
      env: this.#options.env,
      ...(this.#options.fetch !== undefined ? { fetch: this.#options.fetch } : {}),
    });
    if (!token.ok) return { ok: false, reason: 'skyhook-role-unavailable', problem: token.problem };

    const region = config.storage.region;
    const sessionName = `skyhook-${identity}`.slice(0, 64);

    // Skyhook's own role — the one the TRIGGER earns (feat-006 plan D4) — narrowed to
    // this one environment before anything the repository controls has run. Selection,
    // not enforcement: a run asking for the wrong role is refused by its trust policy.
    const roleSuffix = request.triggerKind === 'default-branch' ? '-default-branch' : '-pull-request';
    const skyhookRole = roleArn(account, `${deploySettings.rolePrefix}${roleSuffix}`);
    const own = await assumeRoleWithWebIdentity(
      {
        region,
        roleArn: skyhookRole,
        roleSessionName: sessionName,
        webIdentityToken: token.token,
        policy: sessionPolicyFor({ bucket: config.storage.bucket, repository, identity }),
      },
      this.#stsOptions(),
    );
    if (!own.ok) {
      return {
        ok: false,
        reason: 'skyhook-role-unavailable',
        problem:
          `skyhook could not assume its own role ${skyhookRole} (${own.code}). ` +
          'Check that the bootstrap has been applied to this account, that storage.account ' +
          'names that account, and that deploy.role_prefix matches the name_prefix the ' +
          'bootstrap was applied with. If your organization issues ID-qualified OIDC subjects, ' +
          're-run `skyhook bootstrap`: it resolves the subject form and pins it, and a policy ' +
          'written against the plain repository name refuses every assumption.',
      };
    }

    // The consuming repo's own role. A second token, because the deploy role's trust is
    // the repository's business and names its own conditions.
    const deployToken = await requestIdToken(STS_AUDIENCE, {
      env: this.#options.env,
      ...(this.#options.fetch !== undefined ? { fetch: this.#options.fetch } : {}),
    });
    /* c8 ignore next */
    if (!deployToken.ok) return { ok: false, reason: 'skyhook-role-unavailable', problem: deployToken.problem };

    const deployRole = roleArn(account, `${deploySettings.rolePrefix}-deploy`);
    const deploy = await assumeRoleWithWebIdentity(
      {
        region,
        roleArn: deployRole,
        roleSessionName: sessionName,
        webIdentityToken: deployToken.token,
      },
      this.#stsOptions(),
    );
    if (!deploy.ok) {
      return {
        ok: false,
        reason: 'deploy-role-unavailable',
        problem: deployRoleAdvice(deployRole, deploy.code),
      };
    }

    const store = new S3Store({
      bucket: config.storage.bucket,
      region,
      credentials: credentialsFor(own.credentials),
      ...(this.#options.fetch !== undefined ? { fetch: this.#options.fetch } : {}),
    });

    const deployer = new TerraformEnvironment({
      runner: this.#options.runner,
      repositoryRoot: this.#options.repositoryRoot,
      bucket: config.storage.bucket,
      region,
      backendCredentials: credentialsFor(own.credentials),
      deployCredentials: credentialsFor(deploy.credentials),
      // The same store the registry uses, on the same narrowed session — so the deployer
      // can read back the state key it just wrote and refuse to call a run successful when
      // that state is not there (plan D6a's third check).
      store,
      baseEnv: this.#options.env,
      ...(this.#options.now !== undefined ? { now: this.#options.now } : {}),
    });

    return { ok: true, grant: { registry: new Registry(store), deployer } };
  }

  /**
   * Access for the close fast path's teardown (feat-003 plan D4): skyhook's pull-request
   * role under the teardown session variant — narrowed to this one environment, asking to
   * read its protection marker — plus, per destroy, the deploy role and the definition at
   * the recorded commit fetched into a scratch checkout (plan D5).
   */
  async openTeardown(request: AccessRequest): Promise<TeardownAccessOutcome> {
    const roleName = (prefix: string): string => `${prefix}-pull-request`;
    return this.#openForTeardown(request, roleName, { readProtection: true });
  }

  /**
   * Access for the sweep (feat-003 plan D4): the default-branch role. The registry and
   * store ride the role un-narrowed — the sweep reads every record by design — while each
   * environment's DESTROYER arrives under a fresh session narrowed to that one
   * environment, so the code path that runs a repository's own Terraform cannot touch a
   * sibling even when the logic above it is wrong.
   */
  async openSweep(config: SkyhookConfig, repository: string): Promise<SweepAccessOutcome> {
    return this.#openDefaultBranch(config, repository, {
      sessionName: 'skyhook-sweep',
      advice:
        'A sweep runs on a schedule from the default branch; check the bootstrap has been ' +
        'applied and that the workflow requests id-token: write.',
    });
  }

  /**
   * Access for the manual teardown and the protection commands (feat-006 plan D5, D6):
   * the same default-branch shape as the sweep — wide registry and store, and (for the
   * teardown) a per-environment narrowed destroyer. Wide because only the default-branch
   * role may write a protection mark, and — matching the sweep's own guardrail gap,
   * noted at prototype depth — the session is not narrowed further.
   */
  async openManual(config: SkyhookConfig, repository: string): Promise<SweepAccessOutcome> {
    return this.#openDefaultBranch(config, repository, {
      sessionName: 'skyhook-manual',
      advice:
        'The manual teardown and the protection commands qualify for this role only when ' +
        'dispatched against the default branch; check the run was, that the bootstrap has ' +
        'been applied, and that the workflow requests id-token: write.',
    });
  }

  async #openDefaultBranch(
    config: SkyhookConfig,
    repository: string,
    variant: { sessionName: string; advice: string },
  ): Promise<SweepAccessOutcome> {
    const account = config.storage.account;
    const deploySettings = config.deploy;
    if (account === null || deploySettings === null) {
      return { ok: false, problem: 'configuration is incomplete: this command needs storage.account and the deploy block' };
    }
    const region = config.storage.region;
    const role = roleArn(account, `${deploySettings.rolePrefix}-default-branch`);

    const token = await requestIdToken(STS_AUDIENCE, this.#tokenOptions());
    if (!token.ok) return { ok: false, problem: token.problem };
    const wide = await assumeRoleWithWebIdentity(
      { region, roleArn: role, roleSessionName: variant.sessionName, webIdentityToken: token.token },
      this.#stsOptions(),
    );
    if (!wide.ok) {
      return { ok: false, problem: `this run could not assume ${role} (${wide.code}). ${variant.advice}` };
    }

    const store = new S3Store({
      bucket: config.storage.bucket,
      region,
      credentials: credentialsFor(wide.credentials),
      ...(this.#options.fetch !== undefined ? { fetch: this.#options.fetch } : {}),
    });

    return {
      ok: true,
      access: {
        registry: new Registry(store),
        store,
        destroyerFor: (identity, target) =>
          this.#acquireDestroyer(config, repository, identity, target, (prefix) => `${prefix}-default-branch`),
      },
    };
  }

  async #openForTeardown(
    request: AccessRequest,
    skyhookRoleName: (prefix: string) => string,
    variant: { readProtection: boolean },
  ): Promise<TeardownAccessOutcome> {
    const { config, repository, identity } = request;
    const account = config.storage.account;
    const deploySettings = config.deploy;
    if (account === null || deploySettings === null) {
      return { ok: false, problem: 'configuration is incomplete: teardown needs storage.account and the deploy block' };
    }
    const region = config.storage.region;
    const role = roleArn(account, skyhookRoleName(deploySettings.rolePrefix));

    const token = await requestIdToken(STS_AUDIENCE, this.#tokenOptions());
    if (!token.ok) return { ok: false, problem: token.problem };
    const own = await assumeRoleWithWebIdentity(
      {
        region,
        roleArn: role,
        roleSessionName: `skyhook-${identity}`.slice(0, 64),
        webIdentityToken: token.token,
        policy: sessionPolicyFor({
          bucket: config.storage.bucket,
          repository,
          identity,
          readProtection: variant.readProtection,
        }),
      },
      this.#stsOptions(),
    );
    if (!own.ok) {
      return { ok: false, problem: `skyhook could not assume its own role ${role} (${own.code})` };
    }

    const store = new S3Store({
      bucket: config.storage.bucket,
      region,
      credentials: credentialsFor(own.credentials),
      ...(this.#options.fetch !== undefined ? { fetch: this.#options.fetch } : {}),
    });

    return {
      ok: true,
      access: {
        registry: new Registry(store),
        store,
        makeDestroyer: (target) =>
          this.#acquireDestroyer(config, repository, identity, target, skyhookRoleName),
      },
    };
  }

  /**
   * One environment's destroyer: a fresh narrowed session for the backend, the deploy
   * role for the destroy itself, and the definition at the recorded commit.
   */
  async #acquireDestroyer(
    config: SkyhookConfig,
    repository: string,
    identity: string,
    target: FetchTarget,
    skyhookRoleName: (prefix: string) => string,
  ): Promise<DestroyerAcquisitionOutcome> {
    const account = config.storage.account;
    const deploySettings = config.deploy;
    /* c8 ignore next 3 */
    if (account === null || deploySettings === null) {
      return { ok: false, problem: 'configuration is incomplete' };
    }
    const region = config.storage.region;

    const fetched = await fetchDefinition(
      {
        runner: this.#options.runner,
        repository,
        token: this.#options.env['GITHUB_TOKEN'],
      },
      target,
    );
    if (!fetched.ok) return { ok: false, problem: fetched.problem };

    const backendToken = await requestIdToken(STS_AUDIENCE, this.#tokenOptions());
    if (!backendToken.ok) return { ok: false, problem: backendToken.problem };
    const backend = await assumeRoleWithWebIdentity(
      {
        region,
        roleArn: roleArn(account, skyhookRoleName(deploySettings.rolePrefix)),
        roleSessionName: `skyhook-${identity}`.slice(0, 64),
        webIdentityToken: backendToken.token,
        policy: sessionPolicyFor({
          bucket: config.storage.bucket,
          repository,
          identity,
          readProtection: true,
        }),
      },
      this.#stsOptions(),
    );
    if (!backend.ok) {
      return { ok: false, problem: `skyhook could not narrow itself to ${identity} (${backend.code})` };
    }

    const deployToken = await requestIdToken(STS_AUDIENCE, this.#tokenOptions());
    if (!deployToken.ok) return { ok: false, problem: deployToken.problem };
    const deployRole = roleArn(account, `${deploySettings.rolePrefix}-deploy`);
    const deploy = await assumeRoleWithWebIdentity(
      {
        region,
        roleArn: deployRole,
        roleSessionName: `skyhook-${identity}`.slice(0, 64),
        webIdentityToken: deployToken.token,
      },
      this.#stsOptions(),
    );
    if (!deploy.ok) {
      return {
        ok: false,
        problem:
          `the deploy role ${deployRole} could not be assumed for the destroy (${deploy.code}). ` +
          'If this run is the scheduled sweep, the role\'s trust policy must also accept the ' +
          'default-branch subject — .skyhook/deploy-role.example.tf shows the two-subject form.',
      };
    }

    const store = new S3Store({
      bucket: config.storage.bucket,
      region,
      credentials: credentialsFor(backend.credentials),
      ...(this.#options.fetch !== undefined ? { fetch: this.#options.fetch } : {}),
    });

    return {
      ok: true,
      destroyer: new TerraformEnvironment({
        runner: this.#options.runner,
        repositoryRoot: fetched.root,
        definitionDirectory: join(fetched.root, deploySettings.directory),
        bucket: config.storage.bucket,
        region,
        backendCredentials: credentialsFor(backend.credentials),
        deployCredentials: credentialsFor(deploy.credentials),
        store,
        baseEnv: this.#options.env,
        ...(this.#options.now !== undefined ? { now: this.#options.now } : {}),
      }),
    };
  }

  #tokenOptions(): { env: Readonly<Record<string, string | undefined>>; fetch?: typeof globalThis.fetch } {
    return {
      env: this.#options.env,
      ...(this.#options.fetch !== undefined ? { fetch: this.#options.fetch } : {}),
    };
  }

  #stsOptions(): { fetch?: typeof globalThis.fetch } {
    return this.#options.fetch !== undefined ? { fetch: this.#options.fetch } : {};
  }
}

export type DestroyerAcquisitionOutcome =
  | { readonly ok: true; readonly destroyer: EnvironmentDestroyer }
  | { readonly ok: false; readonly problem: string };

export interface TeardownAccess {
  readonly registry: Registry;
  readonly store: Store;
  readonly makeDestroyer: (target: FetchTarget) => Promise<DestroyerAcquisitionOutcome>;
}

export type TeardownAccessOutcome =
  | { readonly ok: true; readonly access: TeardownAccess }
  | { readonly ok: false; readonly problem: string };

export interface SweepAccess {
  readonly registry: Registry;
  readonly store: Store;
  readonly destroyerFor: (identity: string, target: FetchTarget) => Promise<DestroyerAcquisitionOutcome>;
}

export type SweepAccessOutcome =
  | { readonly ok: true; readonly access: SweepAccess }
  | { readonly ok: false; readonly problem: string };

function roleArn(account: string, name: string): string {
  return `arn:aws:iam::${account}:role/${name}`;
}

function credentialsFor(assumed: AssumedCredentials): {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
} {
  return {
    accessKeyId: assumed.accessKeyId,
    secretAccessKey: assumed.secretAccessKey,
    sessionToken: assumed.sessionToken,
  };
}

/**
 * The message a maintainer meets on their first run (AC-11).
 *
 * It names **both** possibilities, because a trust refusal looks identical whether the role is
 * missing or its trust policy simply does not accept the identity this run presents — and sending
 * someone to the wrong file is worse than admitting the ambiguity.
 *
 * Both halves were once written against a design that never shipped (a reusable trusted workflow,
 * withdrawn by `chg-001`). A live run proved that costly: the message sent a maintainer to merge
 * a second workflow file that does not exist. Advice is as shippable as code, and it goes stale
 * the same way.
 */
function deployRoleAdvice(roleArn: string, code: string): string {
  return (
    `the deploy role ${roleArn} could not be assumed (${code}).\n\n` +
    'Skyhook never creates this role: it cannot know what permissions your infrastructure ' +
    'needs, and does not guess. Two things have to be true, and this failure cannot tell ' +
    'them apart:\n' +
    '  1. The role exists in your account. A starting point is in ' +
    '.skyhook/deploy-role.example.tf — copy it into your own Terraform, give it the ' +
    'permissions your infrastructure actually needs, and apply it yourself.\n' +
    '  2. Its trust policy accepts the identity this run actually presents. If your ' +
    'organization issues ID-qualified OIDC subjects, the plain repo:<owner>/<name> form ' +
    'refuses everything — `skyhook bootstrap` prints the subject that applies to you, and the ' +
    'example file takes it as a variable.'
  );
}
