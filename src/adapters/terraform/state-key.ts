/**
 * The Terraform adapter's one job so far: knowing what Terraform calls its state file.
 *
 * This exists because `terraform.tfstate` is a fact about Terraform, not about skyhook's registry.
 * It used to sit in `src/core/registry.ts`, which made the provider-agnostic core name the
 * infrastructure-as-code tool — the thing the constitution's "provider-agnostic core"
 * non-negotiable and the plan's D6 both forbid. Core now yields the directory and stops; the
 * filename is decided here.
 *
 * The point is not tidiness. A second IaC tool needs a different filename, and with the name in
 * core it would have had to reach into core to change it — which is exactly the coupling the
 * plugin boundary exists to prevent.
 */

import { stateDirFor } from '../../core/registry.ts';

/** What Terraform names the state file it writes, and the lock it writes beside it. */
export const TERRAFORM_STATE_FILE = 'terraform.tfstate';

/**
 * The key holding one environment's Terraform state.
 *
 * The S3 backend's native lockfile lands at this key plus `.tflock`, which the roles' existing
 * grants over the state directory already cover — see plan D4.
 */
export function terraformStateKeyFor(repository: string, identity: string): string {
  return `${stateDirFor(repository, identity)}${TERRAFORM_STATE_FILE}`;
}
