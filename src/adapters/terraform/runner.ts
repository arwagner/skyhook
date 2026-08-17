/**
 * Driving the `terraform` binary. Everything Terraform-specific about *invoking* it lives here,
 * so the command that orchestrates a bootstrap never assembles a `-var` flag itself.
 */

import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandRunner, CommandResult } from '../../cli/process.ts';

/**
 * Terraform loads any `*_override.tf` as an override file, which is the only way to change where
 * state lives when the configuration declares a backend unconditionally — and skyhook's does,
 * because the bucket the state belongs in is a resource that configuration creates.
 *
 * `-backend=false` is NOT an alternative. It skips backend *initialization*, and every later
 * command then refuses with "Backend initialization required". That cost a failed removal
 * part-way through, and a first-run bootstrap that had quietly been broken since the backend was
 * declared — neither caught by tests, because a stubbed runner cannot refuse the way Terraform
 * does.
 */
const LOCAL_BACKEND_OVERRIDE = 'zz_skyhook_local_backend_override.tf';
const LOCAL_BACKEND_OVERRIDE_BODY = `# Written by skyhook while the state has to live locally, and removed when it no longer does.
# If you are reading this, a skyhook command did not finish: terraform.tfstate beside this file is
# the only record of what exists. Do not delete it.
terraform {
  backend "local" {}
}
`;

export interface TerraformVars {
  readonly [name: string]: string | boolean;
}

export interface BackendConfig {
  readonly bucket: string;
  /** Deliberately outside the `state/` prefix managed environments use. */
  readonly key: string;
  readonly region: string;
}

export interface TerraformOptions {
  readonly runner: CommandRunner;
  /** The directory holding the configuration. */
  readonly directory: string;
  /**
   * The child's whole environment. Used to run the consuming repo's providers as its own
   * deploy role while the backend authenticates separately (plan D6).
   */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
}

export class Terraform {
  readonly #runner: CommandRunner;
  readonly #directory: string;
  readonly #env: Readonly<Record<string, string | undefined>> | undefined;

  constructor(options: TerraformOptions) {
    this.#runner = options.runner;
    this.#directory = options.directory;
    this.#env = options.env;
  }

  /**
   * Initialize against a local state file. The first apply has to run this way: the bucket the
   * state belongs in does not exist yet.
   */
  initLocal(): Promise<CommandResult> {
    this.#useLocalBackend();
    return this.#run(['init', '-input=false'], { inherit: true });
  }

  /** Move the state out of the configured backend and into a local file. */
  initMigrateToLocal(): Promise<CommandResult> {
    this.#useLocalBackend();
    return this.#run(['init', '-input=false', '-migrate-state', '-force-copy'], { inherit: true });
  }

  /**
   * Stop overriding the backend. Always call this once the state should no longer be local —
   * left in place, the override would silently pin a later run to a local state file, and
   * `skyhook init` would not remove it because it is not a file skyhook manages.
   */
  clearLocalBackend(): void {
    rmSync(join(this.#directory, LOCAL_BACKEND_OVERRIDE), { force: true });
  }

  #useLocalBackend(): void {
    writeFileSync(join(this.#directory, LOCAL_BACKEND_OVERRIDE), LOCAL_BACKEND_OVERRIDE_BODY, 'utf8');
  }

  /**
   * Initialize against the S3 backend, optionally moving an existing local state into it.
   *
   * `-force-copy` answers the "copy state to the new backend?" prompt. It is safe here because
   * the caller has already established that a local state exists and that this is the migration
   * step — and because the copy direction is local → remote, which cannot lose the remote.
   */
  initBackend(backend: BackendConfig, options: { migrate?: boolean } = {}): Promise<CommandResult> {
    // The override has to go before the declared backend can take effect.
    this.clearLocalBackend();
    const args = [
      'init',
      '-input=false',
      ...(options.migrate === true ? ['-migrate-state', '-force-copy'] : ['-reconfigure']),
      `-backend-config=bucket=${backend.bucket}`,
      `-backend-config=key=${backend.key}`,
      `-backend-config=region=${backend.region}`,
      // The lockfile that replaces a DynamoDB table (plan D4).
      '-backend-config=use_lockfile=true',
      '-backend-config=encrypt=true',
    ];
    return this.#run(args, { inherit: true });
  }

  /**
   * Shows the operator what would change. Deliberately not `-detailed-exitcode`: the caller wants
   * a human to read this and decide, not a machine to branch on whether a diff exists.
   */
  plan(vars: TerraformVars): Promise<CommandResult> {
    return this.#run(['plan', '-input=false', ...varFlags(vars)], { inherit: true });
  }

  /**
   * `-auto-approve` is safe here, and only here, because the caller has already shown the plan and
   * taken a yes. Terraform's own prompt would ask a second time about a plan it re-computes, which
   * is a different plan from the one the operator agreed to.
   */
  apply(vars: TerraformVars): Promise<CommandResult> {
    return this.#run(['apply', '-input=false', '-auto-approve', ...varFlags(vars)], {
      inherit: true,
    });
  }

  /** Every resource address currently under management. */
  stateList(): Promise<CommandResult> {
    return this.#runner.run('terraform', ['state', 'list'], { cwd: this.#directory });
  }

  /** Reads the current state out of whatever backend is configured. */
  statePull(): Promise<CommandResult> {
    return this.#runner.run('terraform', ['state', 'pull'], { cwd: this.#directory });
  }

  /**
   * Stops managing a resource without destroying it. Used to spare a trust anchor that other
   * workloads may have started relying on since skyhook created it.
   */
  stateRm(address: string): Promise<CommandResult> {
    return this.#run(['state', 'rm', address], { inherit: true });
  }

  /**
   * What a destroy would remove, computed without removing it.
   *
   * This exists so a removal can be proved runnable while everything it needs is still intact.
   * Emptying the bucket is irreversible and has to happen before the bucket itself can go, so a
   * destroy that dies on a bad variable or an unreadable provider *after* that point leaves an
   * installation half torn down. Planning first moves every such failure to a moment when
   * nothing has been deleted yet.
   */
  planDestroy(vars: TerraformVars): Promise<CommandResult> {
    return this.#run(['plan', '-destroy', '-input=false', ...varFlags(vars)], { inherit: true });
  }

  destroy(vars: TerraformVars): Promise<CommandResult> {
    return this.#run(['destroy', '-input=false', '-auto-approve', ...varFlags(vars)], {
      inherit: true,
    });
  }

  // --- one managed environment ----------------------------------------------

  /**
   * Initialize against an already-declared backend, supplying its settings as flags.
   *
   * Separate from `initBackend` because that one knows about the bootstrap's own state and
   * its migration dance. An environment has neither: it is always remote, never migrated,
   * and its settings include credentials that must not be confused with the ambient ones.
   */
  initEnvironment(config: Readonly<Record<string, string>>): Promise<CommandResult> {
    const args = [
      'init',
      '-input=false',
      '-reconfigure',
      ...Object.entries(config).map(([name, value]) => `-backend-config=${name}=${value}`),
    ];
    return this.#run(args, { inherit: true });
  }

  /**
   * Select this environment's copy, creating it on a first deploy.
   *
   * `-or-create` rather than `select` then `new`: the two-command form has a race between
   * them, and its failure mode is a run that dies because another run created the
   * workspace first — which is exactly the ordinary case of two pull requests opening at
   * once.
   */
  workspaceSelectOrCreate(name: string): Promise<CommandResult> {
    return this.#run(['workspace', 'select', '-or-create=true', name], { inherit: true });
  }

  /** The definition's outputs, for reading the environment's address. */
  outputJson(): Promise<CommandResult> {
    return this.#runner.run('terraform', ['output', '-json'], {
      cwd: this.#directory,
      ...(this.#env !== undefined ? { env: this.#env } : {}),
    });
  }

  #run(args: readonly string[], options: { inherit: boolean }): Promise<CommandResult> {
    return this.#runner.run('terraform', args, {
      cwd: this.#directory,
      inherit: options.inherit,
      ...(this.#env !== undefined ? { env: this.#env } : {}),
    });
  }
}

/** `-var name=value`, one flag per variable, never shell-interpolated. */
export function varFlags(vars: TerraformVars): string[] {
  return Object.entries(vars).flatMap(([name, value]) => ['-var', `${name}=${String(value)}`]);
}
