/**
 * Where an environment identity comes from depends on who is asking.
 *
 * A run triggered by a pull request does not choose its identity: it is derived from
 * the trigger, so such a run can only ever name its own environment. Only a run from
 * the default branch, or a deliberate human action, may name an arbitrary identity.
 *
 * This check is **not** the enforcement. A pull request controls the code on its own
 * branch, so a TypeScript guard is something the attacker can edit. The enforcement is
 * the credentials the run holds (plan D2a); this function is what makes skyhook behave
 * correctly when it has not been tampered with, and what gives an honest caller a clear
 * refusal rather than a permission error from the cloud.
 */

export interface PullRequestTrigger {
  readonly kind: 'pull-request';
  readonly repository: string;
  readonly pullRequestNumber: number;
  /**
   * Whatever the invoking workflow tried to pass. A pull-request run may not name an
   * identity at all, so any value here is refused — including one that happens to
   * match the derived identity. One rule with nothing to compare is a rule that
   * cannot be got subtly wrong.
   */
  readonly requestedIdentity?: string | undefined;
}

export interface DefaultBranchTrigger {
  readonly kind: 'default-branch';
  readonly repository: string;
  readonly requestedIdentity: string;
}

export type Trigger = PullRequestTrigger | DefaultBranchTrigger;

export type IdentityOutcome =
  | { readonly ok: true; readonly identity: string }
  | {
      readonly ok: false;
      readonly reason:
        /** A pull-request run supplied an identity. It does not get to. */
        | 'identity-not-permitted'
        | 'invalid-identity'
        | 'invalid-pull-request-number'
        /** A chosen name inside the ephemeral namespace (`pr-`). See EPHEMERAL_NAMESPACE_PREFIX. */
        | 'reserved-namespace';
    };

const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Every name beginning `pr-` belongs to the ephemeral namespace — wider than the names a
 * pull request's deploy actually derives, and the width is the point: the credential fence
 * that keeps pull-request runs inside their own namespace is drawn at this prefix, so a
 * long-running environment named inside it would sit on the wrong side of the fence
 * (feat-006 spec, "Identity is chosen"). Refused here, before anything is recorded or
 * applied (feat-006/AC-3).
 */
export const EPHEMERAL_NAMESPACE_PREFIX = 'pr-';
/**
 * 63 is the DNS label limit. An environment's identity ends up in hostnames — a preview URL, a
 * generated record — long before anything checks, so the bound belongs at the point the identity
 * is chosen rather than at the point it first fails to fit (AC-20).
 */
const MAX_IDENTITY_LENGTH = 63;

export function identityFor(trigger: Trigger): IdentityOutcome {
  if (trigger.kind === 'pull-request') {
    if (trigger.requestedIdentity !== undefined) {
      return { ok: false, reason: 'identity-not-permitted' };
    }
    const { pullRequestNumber } = trigger;
    if (!Number.isInteger(pullRequestNumber) || pullRequestNumber < 1) {
      return { ok: false, reason: 'invalid-pull-request-number' };
    }
    return { ok: true, identity: `pr-${pullRequestNumber}` };
  }
  return validIdentity(trigger.requestedIdentity);
}

/** The identity a pull-request run is allowed to have, and the only one. */
export function derivedIdentityFor(pullRequestNumber: number): string {
  return `pr-${pullRequestNumber}`;
}

function validIdentity(identity: string): IdentityOutcome {
  if (!IDENTITY_PATTERN.test(identity) || identity.length > MAX_IDENTITY_LENGTH) {
    return { ok: false, reason: 'invalid-identity' };
  }
  if (identity.startsWith(EPHEMERAL_NAMESPACE_PREFIX)) {
    return { ok: false, reason: 'reserved-namespace' };
  }
  return { ok: true, identity };
}

/**
 * The reverse of `derivedIdentityFor`: the pull request an ephemeral identity is bound
 * to, or null when the identity is not an ephemeral environment's at all.
 *
 * The sweep feeds this identities recovered from registry KEYS — never from record
 * bodies (feat-003 plan D2, the identity invariant) — to ask the host whether the pull
 * request is closed. A `staging` or other long-running name returns null and is left
 * untouched by the sweep.
 */
export function pullRequestNumberFor(identity: string): number | null {
  const match = /^pr-([1-9][0-9]*)$/.exec(identity);
  if (match === null) return null;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
