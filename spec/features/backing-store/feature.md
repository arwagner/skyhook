---
schema_version: 2
id: "feat-001"               # IMMUTABLE
slug: "backing-store"
title: "Backing store for the environment registry and Terraform state"
status: active               # active | done | dropped — reopened 2026-08-17 by chg-011 (declared deploy inputs); was done 2026-08-16
owner: "andrew"
depth: "prototype"           # prototype | mvp | ga
sprint: null
external: null
depends_on: []
requires_design: null        # inherits workspace default (false)
readiness:
  research: ready            # none | draft | ready
  design:   n/a              # design stage is off for this workspace
  spec:     ready
  plan:     ready
  tasks:    ready            # phase 16 (chg-011) built and verified 2026-08-17; chg-011 delta awaits fold
gate:
  analyze: pass              # 2026-08-17 re-gate after remediation: B1/B2 closed (B2 residual is a stated MVP cliff); build order 16.4 first; see analyze.md
  product_global_hash: "sha256:a8932ef5ee1c"
  constitution_hash: "sha256:a045ce0c2437"
human_signoff:
  - id: hs-1
    description: "Verify against a real S3 bucket that conditional writes (If-None-Match / If-Match) give atomic claims under genuine concurrency. If they do not, the S3-only decision does not survive. Task 6.2."
    owner: andrew
    resolved: true
    observed: >-
      PASSED 2026-08-14 against a real bucket in AWS account 123456789012 (us-east-1), driving the
      production S3Store and Registry rather than a separate script. Two runs: 50 rounds at 5-way
      concurrency, then 25 rounds at 20-way. Across 75 rounds and 950 concurrent claims, every
      round produced exactly one winner, with no round producing none and no round producing two,
      and no lost update on the compare-and-swap phase. D2 holds: S3 conditional writes give
      atomic claims under real contention, so the S3-only decision survives.
      One thing did NOT happen and is worth recording: every refusal was a 412 (held / stale).
      No 409 ConditionalRequestConflict was observed at either concurrency level, so the 409
      retry path added the same day is correct and defensive but remains unexercised against
      real S3. Re-check it if contention ever rises materially above 20 concurrent writers.
  - id: hs-2
    description: "Apply the bootstrap Terraform to a real cloud account twice and confirm the second apply reports no changes. Satisfies AC-3, which is machine-unverifiable. Task 6.3."
    owner: andrew
    resolved: true
    observed: >-
      2026-08-14, AWS account 123456789012 (us-east-1), from the deadweight test repository.
      First apply created both roles and the bucket. A second run reported "No changes. Your
      infrastructure matches the configuration." Verified against the live account rather than
      the Terraform source: bucket encryption AES256, all four public-access-block settings true,
      both skyhook roles present. The account already held a GitHub OIDC provider belonging to
      another project, so the apply ran with create_oidc_provider=false; that provider's
      thumbprints, client IDs and tags were confirmed unchanged afterwards.
  - id: hs-3
    description: "chg-007, task 11.5. Prove against a live account that AWS honours token.actions.githubusercontent.com:job_workflow_ref as a trust condition, and that a job running a workflow altered on a pull request's own branch is refused by STS. AWS documents the condition key; GitHub's documentation says custom claims are unsupported. This feature ships the trust policy, so its own gate must not pass on an unverified one. The same check is feat-002's hs-2 — one verification, recorded against both features that depend on it."
    owner: andrew
    resolved: true
    observed: >-
      RETIRED 2026-08-15 by feat-002's chg-001, not run — the same disposition as feat-002's hs-2,
      which was the same single verification. This feature no longer ships the trust policy the
      check existed to protect: a constitution amendment reclassified the boundary that policy was
      closing, between one preview environment and another, as a deliberate choice rather than a gap
      awaiting a fix. chg-007's delta withdraws AC-29 and the trust-condition half of task 11.4 in
      place, and the sign-off goes with them.
      The premise stated above still holds and is why this is recorded rather than deleted: a gate
      must not pass on an unverified trust policy. The resolution is that there is no longer an
      unverified trust policy to pass on.
open_decisions:
  - id: od-1
    description: >-
      Plan D2a assumes the pull-request role's IAM policy can be scoped to
      registry/<repo>/pr-<number>.json. A static policy cannot do that: a generic OIDC provider's
      token claims are available in a role's trust policy only, never in the permission policy the
      resulting session carries, and GitHub Actions emits no AWS session tags — so the pull request
      number reaches no condition AWS can evaluate at request time. The default-branch/pull-request
      role split is unaffected; pull-request-to-pull-request isolation is what is not achievable as
      written, and the constitution names it explicitly ("including other pull requests'
      environments"). Two ways out: (a) scope the pull-request role to the pr-* prefix and record
      the narrower guarantee, or (b) pin the role's trust policy to a reusable workflow on the
      default branch (job_workflow_ref) and have that trusted workflow pass an inline session policy
      narrowing to pr-<number>, which restores the full guarantee at the cost of committing the
      calling-workflow shape now. Blocks task 2.4, and 4.2-4.4 depend on what 2.4 produces.
      RESOLVED 2026-08-14: andrew chose (a). Captured as changes/chg-001 — plan D2a rewritten, AC-14
      narrowed, AC-17 and AC-18 added. The declined option (b) is parked in backlog.md row 2.
    owner: andrew
    resolved: true
  - id: od-2
    description: >-
      chg-001 deviates from a constitution non-negotiable, not merely from a tech default. "Explicit
      deny on everything but the caller's own environment" requires roles reachable from a PR branch
      to deny "other pull requests' environments", and the prefix-scoped policy does not. Every other
      boundary it names still holds. The constitution is main-branch-only, so it cannot be amended
      inside this feature branch: it needs its own pull request, either narrowing the non-negotiable
      to what a static policy can enforce or committing the product to od-1 option (b). Prototype
      depth can proceed meanwhile; promote will refuse until this is settled.
      RESOLVED 2026-08-14: andrew chose to amend the constitution. Both clauses that asserted the
      guarantee moved together — the "touches only what it owns" non-negotiable and "Explicit deny"
      — so the constitution now draws the boundary where a static policy can draw it and states the
      pull-request-to-pull-request gap, its cause, and its fix in its own words. Widening a PR-branch
      role beyond its own ephemeral namespace remains a violation. Plan Deviations is now empty.
    owner: andrew
    resolved: true
  - id: od-3
    description: >-
      chg-011 records declared deploy-input values in the registry, and product-global.md's privacy
      requirement enumerates what the registry stores ("only deployment metadata — repository,
      commit, pull request number, environment identity, state, timestamps, and environment
      URLs"). The enumeration must gain "declared deploy input values" or the two texts disagree
      the moment the delta folds. A cross-cutting input is amended only through its own main-branch
      commit, never inside a feature change (the od-3 precedent on feat-002), and editing it
      restages every feature's pre-build check. UPGRADED by the 2026-08-17 gate (security B1) from
      fold-blocking to BUILD-blocking for every declared-inputs phase. Task 16.4 carried it.
      RESOLVED 2026-08-17: landed as its own commit on main (783fcc8), authorized by andrew in
      the declared-inputs session. Every re-gate that day was stamped against the amended hash
      (sha256:a8932ef5ee1c), so no gate went stale.
    owner: andrew
    resolved: true
converge:
  last_run: "2026-08-16"
  open: 0
  contradicts: 0
  runs: 8
overrides:
  - id: ov-1
    gate: open-items
    by: andrew
    reason: "hs-1 and hs-2 are final-phase verifications needing a real AWS account (tasks 6.2, 6.3), not prerequisites. Starting the build does not depend on them; completing it does. Waived so phases 0-5, which need no cloud account, can proceed."
    at: "2026-08-14"
    resolved: true
    paid: >-
      2026-08-14. The debt was the two sign-offs this override let the build start without. Both are
      now satisfied against a real account rather than waived: hs-1 passed the concurrency probe and
      hs-2 the double apply.
extends: []
---

# Feature notes — Backing store for the environment registry and Terraform state

> The frontmatter above is the canonical manifest. `id` is immutable. `spec/dashboard.md` and
> `spec/product.md` are generated from these manifests — never hand-edit them.

## Known constraints going in

- Storage is S3 only, in resources skyhook defines in Terraform (constitution, tech defaults).
  A second store gets added only if a requirement forces it.
- This store holds the Terraform state backend for managed environments as well as the registry.
- Claims must be atomic: two simultaneous requests never receive the same environment, and neither
  silently overwrites the other's registry write (product-global, cross-cutting constraints).
- It sits behind the adapter boundary, so a non-AWS target can supply its own implementation.
