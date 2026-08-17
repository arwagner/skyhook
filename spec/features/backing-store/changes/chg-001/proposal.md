# Proposal — backing-store / chg-001 — pull-request role scoped by prefix, not by key

**Trigger:** implementation hit a wall. Building the bootstrap Terraform (task 2.4) surfaced that
plan D2a specifies an IAM permission policy AWS cannot express. Raised as `od-1`; the human chose
option (a) on 2026-08-14.

**Summary:** AC-14 promises that the *credentials* a pull-request run holds are refused by the cloud
for any other environment's record — including another pull request's. Plan D2a delivers that by
restricting the pull-request role to `registry/<repo>/pr-<number>.json`. No static IAM policy can do
this: the pull request number appears in no attribute AWS evaluates at request time. A generic OIDC
provider's token claims are available only in a role's **trust** policy, when the role is assumed;
they are not carried into the permission policy the resulting session evaluates against each request.
GitHub Actions emits no AWS session tags, so there is no principal tag to condition on either. The
achievable static boundary is a prefix: the pull-request role reaches `pr-*` and nothing else. This
change narrows AC-14 to that boundary and records the residual gap honestly, rather than leaving a
promise in the spec that no implementation can keep.

The alternative considered and declined (od-1 option b) was to pin the role's trust policy to a
reusable workflow on the default branch and have that trusted workflow pass an inline session policy
narrowing to `pr-<number>`. That restores the full guarantee, but decides the calling-workflow shape
for the deploy-action feature, which is not yet specified. Recorded in the backlog so the door stays
open.

## Blast radius
Everything this change touches, so the ripple is explicit.
- Requirements affected: **AC-14** (modified — the guarantee narrows from per-pull-request to
  the `pr-*` prefix); **AC-15** (unaffected — the `protected/` prefix is denied to the pull-request
  role wholesale, which a prefix policy expresses exactly); the *Scenario: a pull request asks for
  another environment's name* (modified — the second clause overstates what the credentials do); the
  *Known sharp edges* list (one edge added).
- Design decisions affected: **D2a** (rewritten — the mechanism and, importantly, the honest reason
  it stops where it does). D2, D2b, D3, D5, D6, D7 unaffected.
- Tasks affected (regenerate these): **2.4** (the policy it writes), **4.4** (what the Terraform test
  asserts). New task **2.6** for the pull-request-to-pull-request gap being visible in the output.
  4.2/4.3 depend on 2.4's output but their mechanism is unchanged.
- Already-built code affected: **none.** The adapter boundary (D6) kept every provider decision out
  of `src/core/`. `identityFor()` still derives `pr-<number>` and still refuses a supplied identity;
  what changed is only how much the cloud independently enforces behind it.

## Conflict with the constitution — needs its own PR
The constitution's *Explicit deny on everything but the caller's own environment* names the excluded
set as "including other pull requests' environments". Option (a) does not deliver that. The
constitution is main-branch-only and cannot be amended inside a feature branch, so this is flagged
here rather than edited: it needs a separate pull request before this feature can honestly reach a
depth above prototype. Tracked as `od-2`.

## Status
- [x] delta reviewed (analyze) — 2026-08-14, gate `pass`
- [x] implemented & verified — tasks 2.4, 2.6, 4.4, 4.5
- [x] folded into spec.md — 2026-08-14; AC-17 and AC-18 appended, AC-14 narrowed
