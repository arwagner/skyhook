/**
 * How a declared deploy input's value reaches skyhook: Terraform's own convention,
 * `TF_VAR_<name>` in the run's environment, set by the calling workflow (chg-007).
 *
 * This file is the only place that convention is named. Core reads values through the
 * `DeclaredInputSource` port and renders refusals with `address()`, so a maintainer is
 * told the exact variable their workflow must set without `src/core/` knowing the
 * tool's prefix (constitution, provider-agnostic core).
 *
 * Skyhook still passes no `-var`: the same environment the workflow set flows on to the
 * terraform child untouched (D6), and what this source adds is *memory* — the declared
 * values are recorded with the commit and replayed at destroy.
 */

import type { DeclaredInputSource } from '../../core/deploy.ts';

export const TF_VAR_PREFIX = 'TF_VAR_';

export function terraformInputSource(
  env: Readonly<Record<string, string | undefined>>,
): DeclaredInputSource {
  return {
    read: (name) => env[`${TF_VAR_PREFIX}${name}`],
    address: (name) => `${TF_VAR_PREFIX}${name}`,
  };
}
