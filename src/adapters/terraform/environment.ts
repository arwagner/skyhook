/**
 * Deploying one environment as a Terraform workspace.
 *
 * The environment's identity **is** the workspace name, which is how it reaches the
 * consuming repo's definition without skyhook declaring an input variable or the
 * repository declaring one to receive it (AC-12). The definition reads
 * `terraform.workspace` and names its own resources from it. Skyhook passes no `-var` at
 * all, and there is nothing in this file that could.
 *
 * The state lands at `state/<repo>/<identity>/terraform.tfstate` — the layout
 * `stateDirFor()` already defines and the installed roles already grant — because the S3
 * backend files a workspace's state under `<workspace_key_prefix>/<workspace>/<key>`.
 */

import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  DeployOutcome,
  DeployOutputs,
  DeployRequest,
  DeployTiming,
  DestroyOutcome,
  DestroyRequest,
  EnvironmentDeployer,
  EnvironmentDestroyer,
  ResidualOutcome,
} from '../../core/ports.ts';
import { STATE_PREFIX } from '../../core/registry.ts';
import type { Store } from '../../core/store.ts';
import { TERRAFORM_STATE_FILE } from './state-key.ts';
import { Terraform } from './runner.ts';
import type { CommandRunner } from '../../cli/process.ts';

/** What both operations need to name an environment: deploys and destroys alike. */
type EnvironmentRef = Pick<DeployRequest, 'repository' | 'identity'>;

/** Skyhook's own backend declaration, written into the definition and removed afterwards. */
const BACKEND_FILE = 'zz_skyhook_backend.tf';
const BACKEND_BODY = `# Written by skyhook for the duration of one deploy, and removed afterwards.
# The bucket, key and credentials arrive as -backend-config; this only declares that the
# state is remote. If you are reading this, a skyhook run did not finish.
terraform {
  backend "s3" {}
}
`;

/** Terraform's own record of the backend it actually initialized. */
const BACKEND_RECORD = join('.terraform', 'terraform.tfstate');

export interface TerraformEnvironmentOptions {
  readonly runner: CommandRunner;
  /** The consuming repo's checkout root. `directory` on a request is relative to it. */
  readonly repositoryRoot: string;
  readonly bucket: string;
  readonly region: string;
  /** Skyhook's own narrowed session, used by the backend and nothing else. */
  readonly backendCredentials: AwsCredentials;
  /**
   * Skyhook's own view of the object store, on the same narrowed session as the backend.
   *
   * **Required rather than optional, deliberately.** It feeds the one defense of the state
   * location that cannot silently lapse (D6a's third check), and an optional dependency is
   * precisely how a check stops running without anyone noticing. That is not hypothetical
   * here: the check was specified from the start, went unbuilt for the whole feature, and
   * no test could tell, because a deployer holding no store cannot even be asked whether it
   * looked (`gap-002`). Making it required means a construction site that forgets it does
   * not compile.
   */
  readonly store: Store;
  /** The consuming repo's deploy role, used by its providers and nothing else. */
  readonly deployCredentials: AwsCredentials;
  /** The environment the terraform child inherits, minus credentials. */
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
  readonly now?: () => number;
  /**
   * Where a DESTROY finds the definition: an absolute directory, because a destroy runs
   * the definition at the commit the registry recorded — fetched into a scratch checkout
   * (feat-003 plan D5) — not the workflow's own checkout that `repositoryRoot` names.
   * Required for `destroy()`; `deploy()` never reads it.
   */
  readonly definitionDirectory?: string;
}

export interface AwsCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken: string;
}

export class TerraformEnvironment implements EnvironmentDeployer, EnvironmentDestroyer {
  readonly #options: TerraformEnvironmentOptions;
  readonly #now: () => number;

  constructor(options: TerraformEnvironmentOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => Date.now());
  }

  async deploy(request: DeployRequest): Promise<DeployOutcome> {
    const directory = join(this.#options.repositoryRoot, request.directory);
    const startedPreparing = this.#now();

    // Skyhook's own share of the pre-apply window is everything in it that is not
    // `terraform init`, and it is measured by SUBTRACTION rather than by summing the steps
    // below (AC-14, plan D7a). Adding them up is the obvious refactor here and the wrong
    // one: a step added later without a stopwatch would then fall out of the figure
    // altogether instead of being counted against skyhook, where uninstrumented work
    // belongs. `initMs` is assigned once, the moment init returns.
    let initMs = 0;
    const preparationSoFar = (): number => this.#now() - startedPreparing - initMs;

    // ---- before anything runs: the definition may not move skyhook's state ----
    const hijack = detectStateHijack(directory);
    if (hijack !== null) {
      return skyhookFailed(hijack, { preparationMs: preparationSoFar(), initMs, applyMs: 0 });
    }

    const terraform = new Terraform({
      runner: this.#options.runner,
      directory,
      env: this.#childEnv(),
    });

    try {
      writeFileSync(join(directory, BACKEND_FILE), BACKEND_BODY, 'utf8');

      // Timed apart from everything around it, and charged to the repository even when it
      // fails: what this command mostly does is fetch providers and modules the repository
      // chose, at a size the repository chose. A provider that takes four minutes to fail
      // to download is not skyhook being slow.
      const startedInit = this.#now();
      const init = await terraform.initEnvironment(this.#backendConfig(request));
      initMs = this.#now() - startedInit;
      if (init.code !== 0) {
        return skyhookFailed(
          `terraform init failed for ${request.identity}: ${firstLine(init.stderr) || 'see the log above'}`,
          { preparationMs: preparationSoFar(), initMs, applyMs: 0 },
        );
      }

      // ---- after init, before apply: is the state where skyhook put it? ----
      const wrongBackend = verifyBackend(directory, this.#options.bucket, expectedKey(request));
      if (wrongBackend !== null) {
        return skyhookFailed(wrongBackend, {
          preparationMs: preparationSoFar(),
          initMs,
          applyMs: 0,
        });
      }

      // Selected after init, and created if this is the environment's first deploy. `TF_WORKSPACE`
      // was tried instead and does not create a workspace, so the first deploy of a new
      // environment died here (chg-008 against feat-001). Init can reach this point at all because
      // both roles may now read the one key the backend consults before a workspace exists.
      const workspace = await terraform.workspaceSelectOrCreate(request.identity);
      if (workspace.code !== 0) {
        return skyhookFailed(
          `could not select the workspace for ${request.identity}: ${firstLine(workspace.stderr) || 'see the log above'}`,
          { preparationMs: preparationSoFar(), initMs, applyMs: 0 },
        );
      }

      const preparationMs = preparationSoFar();

      // ---- the consuming repo's own apply. No -var, ever. ----
      const startedApplying = this.#now();
      const applied = await terraform.apply({});
      const applyMs = this.#now() - startedApplying;

      if (applied.code !== 0) {
        // Theirs, not skyhook's, and the exit status says so (AC-18).
        return {
          ok: false,
          reason: 'consumer-apply-failed',
          problem:
            `the repository's own "terraform apply" failed in ${request.directory} (exit ${applied.code}). ` +
            'This is a failure of the infrastructure definition, not of skyhook.',
          timing: { preparationMs, initMs, applyMs },
        };
      }

      // ---- after the apply: did skyhook's state actually land where skyhook put it? ----
      // Before the address is read, because an environment nothing can tear down is worth
      // saying regardless of whether it also has a URL.
      const orphan = await this.#confirmStateLanded(request);
      if (orphan !== null) {
        return skyhookFailed(orphan, { preparationMs, initMs, applyMs });
      }

      const read = await this.#readOutputs(terraform);
      return {
        ok: true,
        url: read.url,
        outputs: read.outputs,
        timing: { preparationMs, initMs, applyMs },
      };
    } catch (error) {
      // A throw is a surprise rather than a command exiting non-zero, so whatever it cost
      // goes to skyhook: if it lands mid-init, `initMs` is still 0 and that time counts
      // against skyhook rather than the repository. The unsafe direction for this figure is
      // under-reporting, so an unclassifiable second belongs on skyhook's side.
      return skyhookFailed(`deploying ${request.identity} failed: ${(error as Error).message}`, {
        preparationMs: preparationSoFar(),
        initMs,
        applyMs: 0,
      });
    } finally {
      // Including on failure: left behind, it would silently pin a later run — the exact
      // shape of defect the local-backend override caused in feat-001's task 10.4.
      rmSync(join(directory, BACKEND_FILE), { force: true });
    }
  }

  /**
   * Destroy the environment's infrastructure, running the definition at the recorded
   * commit (feat-003 plan D5). The same discipline as a deploy, because the checked-out
   * definition is the same attacker-authored code: the hijack refusals run before init,
   * the initialized backend is verified before anything destructive, and the workspace is
   * selected by identity. A destroy over empty state is a successful no-op — that is what
   * makes teardown re-entrant (plan D7).
   */
  async destroy(request: DestroyRequest): Promise<DestroyOutcome> {
    const directory = this.#options.definitionDirectory;
    if (directory === undefined) {
      return {
        ok: false,
        reason: 'skyhook-failed',
        problem: 'this deployer was constructed without a definition directory, so it cannot destroy',
      };
    }

    const hijack = detectStateHijack(directory);
    if (hijack !== null) return { ok: false, reason: 'skyhook-failed', problem: hijack };

    // The recorded inputs land in the child process's environment object, never in a
    // shell string and never as -var — the same discipline the credentials already ride
    // (D6; feat-003 D5's chg-001 amendment). Terraform reads TF_VAR_* itself.
    const terraform = new Terraform({
      runner: this.#options.runner,
      directory,
      env: { ...this.#childEnv(), ...tfVarsFor(request.deployInputs) },
    });

    try {
      writeFileSync(join(directory, BACKEND_FILE), BACKEND_BODY, 'utf8');

      const init = await terraform.initEnvironment(this.#backendConfig(request));
      if (init.code !== 0) {
        return {
          ok: false,
          reason: 'skyhook-failed',
          problem: `terraform init failed for ${request.identity}: ${firstLine(init.stderr) || 'see the log above'}`,
        };
      }

      const wrongBackend = verifyBackend(directory, this.#options.bucket, expectedKey(request));
      if (wrongBackend !== null) return { ok: false, reason: 'skyhook-failed', problem: wrongBackend };

      const workspace = await terraform.workspaceSelectOrCreate(request.identity);
      if (workspace.code !== 0) {
        return {
          ok: false,
          reason: 'skyhook-failed',
          problem: `could not select the workspace for ${request.identity}: ${firstLine(workspace.stderr) || 'see the log above'}`,
        };
      }

      const destroyed = await terraform.destroy({});
      if (destroyed.code !== 0) {
        // Theirs, not skyhook's, and the exit status says so — the destroy runs the
        // repository's own definition, same as the apply (feat-003 plan D8).
        return {
          ok: false,
          reason: 'consumer-destroy-failed',
          problem:
            `the repository's own "terraform destroy" failed for ${request.identity} ` +
            `(exit ${destroyed.code}). The environment is still standing; the next sweep pass retries.`,
        };
      }
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        reason: 'skyhook-failed',
        problem: `destroying ${request.identity} failed: ${(error as Error).message}`,
      };
    } finally {
      rmSync(join(directory, BACKEND_FILE), { force: true });
    }
  }

  /**
   * Whether the environment's stored state still names resources — read through skyhook's
   * own store, after a destroy reported success and before anything is deleted (feat-003
   * plan D6 step 4). A missing state object counts as empty: no state is exactly what a
   * completed (or never-started) environment leaves.
   */
  async residualResources(request: DestroyRequest): Promise<ResidualOutcome> {
    const key = expectedKey(request);
    let read: Awaited<ReturnType<Store['read']>>;
    try {
      read = await this.#options.store.read(key);
    } catch (error) {
      return { ok: false, problem: `the state at ${key} could not be read: ${(error as Error).message}` };
    }
    if (!read.ok) return { ok: false, problem: `the bucket holding ${key} is gone` };
    if (read.object === null) return { ok: true, empty: true };

    try {
      const parsed = JSON.parse(read.object.value) as { resources?: unknown };
      if (!Array.isArray(parsed.resources)) {
        return { ok: false, problem: `the state at ${key} has no readable resources list` };
      }
      return { ok: true, empty: parsed.resources.length === 0 };
    } catch {
      return { ok: false, problem: `the state at ${key} is not readable as state` };
    }
  }

  /**
   * The backend's own credentials, kept apart from the providers'.
   *
   * They are written where the backend reads them rather than into the process
   * environment, because the process environment belongs to the deploy role. A definition
   * the pull request controls can read this file — and gains nothing, because what it
   * reads is narrowed to its own environment. Blast radius unchanged is the test that
   * matters, not secrecy.
   */
  #backendConfig(request: EnvironmentRef): Record<string, string> {
    const credentials = this.#options.backendCredentials;
    return {
      bucket: this.#options.bucket,
      region: this.#options.region,
      key: TERRAFORM_STATE_FILE,
      workspace_key_prefix: `${STATE_PREFIX}${request.repository}`,
      use_lockfile: 'true',
      encrypt: 'true',
      access_key: credentials.accessKeyId,
      secret_key: credentials.secretAccessKey,
      token: credentials.sessionToken,
    };
  }

  #childEnv(): Record<string, string | undefined> {
    const base = { ...(this.#options.baseEnv ?? {}) };
    const deploy = this.#options.deployCredentials;
    return {
      ...base,
      AWS_ACCESS_KEY_ID: deploy.accessKeyId,
      AWS_SECRET_ACCESS_KEY: deploy.secretAccessKey,
      AWS_SESSION_TOKEN: deploy.sessionToken,
      AWS_REGION: this.#options.region,
      // Skyhook never answers a prompt on the repository's behalf.
      TF_INPUT: '0',
      TF_IN_AUTOMATION: '1',
    };
  }

  /**
   * The last of the three state-location defenses (plan D6a), and the only one that cannot
   * silently lapse.
   *
   * The first is a denylist, and a denylist is only ever right about the tricks it knows.
   * The second reads `.terraform/terraform.tfstate` — an internal Terraform working file
   * with no compatibility promise — so if its shape ever changes that check does not fail,
   * it stops checking, which is the worse failure for a defense. This one asks the object
   * store about the object itself, and depends on nothing that can quietly change shape.
   *
   * It runs too late to prevent an apply, which is exactly why the other two exist. What it
   * guarantees is that an environment whose state went missing is **reported as a possible
   * orphan** rather than reported as a success. That is the weakest form of the *no orphans*
   * non-negotiable, and by D6a's own argument the one that must never be unavailable.
   *
   * Listed rather than fetched: the answer needed is whether the key is there, and a
   * managed environment's state can be large. Downloading it would spend skyhook's own
   * 60-second budget (AC-14 counts everything after the apply against skyhook) to learn one
   * bit. The narrowed session already permits both — `ListBucket` under `state/<repo>/*`
   * and `GetObject` on this environment's own prefix — so this needs no policy change.
   *
   * Every outcome that is not "the key is there" is reported, including a store that
   * refuses to answer. "Skyhook could not confirm" and "skyhook confirmed it is missing"
   * are different sentences and the message says which one this is, but neither may pass
   * for success: the whole value of this check is that it is never silently unavailable.
   */
  async #confirmStateLanded(request: DeployRequest): Promise<string | null> {
    const key = expectedKey(request);

    let listed: Awaited<ReturnType<Store['list']>>;
    try {
      listed = await this.#options.store.list(stateDirectory(request));
    } catch (error) {
      return unconfirmedState(request.identity, key, (error as Error).message);
    }
    if (!listed.ok) {
      return unconfirmedState(request.identity, key, `the bucket ${this.#options.bucket} is gone`);
    }
    if (listed.keys.includes(key)) return null;

    return (
      `${request.identity} applied, but no state was found at ${key}. POSSIBLE ORPHAN: the ` +
      'infrastructure was created and skyhook cannot find the state that describes it, so ' +
      'nothing — not teardown, not the sweep — can destroy it. Whatever ran wrote its state ' +
      'somewhere else, or nowhere. Inspect the account for resources belonging to ' +
      `${request.identity} before re-running, because a re-run will create a second set.`
    );
  }

  /**
   * Every output the definition declares, read in one `terraform output -json` — the URL is
   * simply the `url` entry of the same document. No new invocation, so the budget is unchanged.
   *
   * A definition that declares no output still deploys — skyhook does not validate the
   * repository's Terraform, and inventing a hard failure for a missing output would be exactly
   * that. An unreadable document yields a null address and null outputs; the caller reports it.
   */
  async #readOutputs(
    terraform: Terraform,
  ): Promise<{ url: string | null; outputs: DeployOutputs | null }> {
    const result = await terraform.outputJson();
    if (result.code !== 0) return { url: null, outputs: null };
    let parsed: Record<string, { value?: unknown; sensitive?: unknown }>;
    try {
      parsed = JSON.parse(result.stdout) as typeof parsed;
    } catch {
      return { url: null, outputs: null };
    }

    // Sensitive outputs are dropped here and never returned: `terraform output -json` carries
    // their values in the clear with a `sensitive: true` marker, so the raw parse must not
    // travel past this function (AC-25). Only the filtered document and the omitted names leave.
    const document: Record<string, unknown> = {};
    const omittedSensitive: string[] = [];
    for (const [name, entry] of Object.entries(parsed)) {
      if (entry?.sensitive === true) {
        omittedSensitive.push(name);
        continue;
      }
      document[name] = entry?.value;
    }
    omittedSensitive.sort();

    const url =
      typeof document['url'] === 'string' && document['url'] !== '' ? document['url'] : null;
    return { url, outputs: { document, omittedSensitive } };
  }
}

/**
 * The recorded inputs as Terraform's own environment convention. Names were validated at
 * config-parse time to the identifier class, so none can collide with a credential or
 * AWS-meaningful variable — `TF_VAR_` prefixes every one.
 */
function tfVarsFor(
  inputs: Readonly<Record<string, string>> | null | undefined,
): Record<string, string> {
  if (inputs === null || inputs === undefined) return {};
  return Object.fromEntries(Object.entries(inputs).map(([name, value]) => [`TF_VAR_${name}`, value]));
}

/** Where this environment's state must end up, as a key within the bucket. */
function expectedKey(request: EnvironmentRef): string {
  return `${stateDirectory(request)}${TERRAFORM_STATE_FILE}`;
}

/** The prefix holding one environment's state, trailing separator included. */
function stateDirectory(request: EnvironmentRef): string {
  return `${STATE_PREFIX}${request.repository}/${request.identity}/`;
}

/**
 * The apply succeeded and skyhook cannot say where the state went.
 *
 * Deliberately not softened into a warning. Skyhook's promise is that an environment it
 * created can later be found and destroyed; when it cannot confirm that, the run has not
 * done its job, and it is skyhook's own failure rather than the repository's (exit 1, D8) —
 * the repository's Terraform did exactly what it was asked.
 */
function unconfirmedState(identity: string, key: string, because: string): string {
  return (
    `${identity} applied, but skyhook could not confirm its state reached ${key} (${because}). ` +
    'The infrastructure may exist with no state skyhook can find, which would make it an ' +
    'orphan nothing can tear down. Check the bucket before re-running.'
  );
}

/**
 * The timing is required rather than defaulted to zero, deliberately.
 *
 * Every failure path here spends real time and every one of them knows which bucket it
 * spent it in. A default would let a path added later report that it took none — which is
 * the direction AC-14 calls unsafe, since a budget exists to catch skyhook being slow.
 * There is nothing to omit, so omitting is not offered.
 */
function skyhookFailed(problem: string, timing: DeployTiming): DeployOutcome {
  return { ok: false, reason: 'skyhook-failed', problem, timing };
}

/**
 * Refuse a definition that could relocate skyhook's state.
 *
 * The directory holds the pull request's own files, and Terraform lets any `*_override.tf`
 * override the `terraform` block's backend settings — skyhook's own bootstrap runner uses
 * exactly that technique, so it is proven and public. A pull request that adds
 * `terraform { backend "local" {} }` would get a successful apply whose state dies with the
 * runner: real infrastructure, no state, and a registry record pointing at nothing anybody
 * can destroy. That is the *no orphans* non-negotiable broken by construction.
 *
 * This is not auditing the repository's infrastructure, which the spec puts out of scope.
 * It is refusing to let the definition relocate **skyhook's own** state.
 */
export function detectStateHijack(directory: string): string | null {
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch (error) {
    return `cannot read the infrastructure directory: ${(error as Error).message}`;
  }

  const overrides = entries.filter(
    (name) => name.endsWith('_override.tf') || name.endsWith('_override.tf.json'),
  );
  if (overrides.length > 0) {
    return (
      `${overrides.join(', ')}: skyhook will not deploy a definition that carries a Terraform ` +
      'override file. An override can move the state backend, which would leave real ' +
      'infrastructure with no state skyhook could ever find or destroy. Remove it, or put ' +
      'what it does in the definition itself.'
    );
  }

  for (const name of entries) {
    if (name === BACKEND_FILE) continue;
    if (!name.endsWith('.tf') && !name.endsWith('.tf.json')) continue;
    let body: string;
    try {
      body = readFileSync(join(directory, name), 'utf8');
    } catch {
      continue;
    }
    if (declaresBackend(body)) {
      return (
        `${name}: this definition declares its own Terraform backend. Skyhook owns where a ` +
        "managed environment's state lives — it has to, because that state is the only thing " +
        'that can later find and destroy the environment. Remove the backend block.'
      );
    }
  }
  return null;
}

/** A `backend "..."` block inside a `terraform` block. Comments are stripped first. */
function declaresBackend(body: string): boolean {
  const withoutComments = body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|\s)(#|\/\/).*$/, ''))
    .join('\n');
  return /\bbackend\s*"[^"]+"\s*\{/.test(withoutComments) || /"backend"\s*:/.test(withoutComments);
}

/**
 * Ask Terraform what it actually initialized, rather than what it was told.
 *
 * The check above is a denylist, and a denylist is only ever right about the tricks it
 * knows. This one reads Terraform's own record of the backend in use, so it stays true
 * against a mechanism nobody has thought of. Its own weakness — that
 * `.terraform/terraform.tfstate` is an internal file with no compatibility promise — is
 * why a third check reads the state back out of the bucket after the apply.
 */
export function verifyBackend(
  directory: string,
  expectedBucket: string,
  expectedStateKey: string,
): string | null {
  let raw: string;
  try {
    raw = readFileSync(join(directory, BACKEND_RECORD), 'utf8');
  } catch {
    return (
      'terraform initialized without recording a backend, so skyhook cannot confirm where ' +
      "this environment's state will be written. Refusing rather than applying blind."
    );
  }

  let parsed: { backend?: { type?: unknown; config?: Record<string, unknown> } };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    return 'terraform\'s backend record could not be read, so where the state will land is unknown';
  }

  const type = parsed.backend?.type;
  if (type !== 's3') {
    return (
      `terraform initialized a "${String(type ?? 'none')}" backend rather than the S3 backend ` +
      'skyhook configured. The state would not be where skyhook could find it, so nothing ' +
      'was applied.'
    );
  }

  const bucket = parsed.backend?.config?.['bucket'];
  if (bucket !== expectedBucket) {
    return (
      `terraform initialized a backend pointing at "${String(bucket)}" rather than ` +
      `"${expectedBucket}". Nothing was applied.`
    );
  }
  // The key recorded is the un-workspaced one; the workspace prefix is what expands it.
  const prefix = parsed.backend?.config?.['workspace_key_prefix'];
  if (typeof prefix !== 'string' || !expectedStateKey.startsWith(`${prefix}/`)) {
    return (
      `terraform initialized a backend whose state prefix ("${String(prefix)}") does not lead ` +
      `to ${expectedStateKey}. Nothing was applied.`
    );
  }
  return null;
}

function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim() !== '')?.trim() ?? '';
}
