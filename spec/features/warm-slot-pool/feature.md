---
schema_version: 2
id: "feat-007"               # IMMUTABLE. Format: feat-NNN (zero-padded, >=3 digits), assigned
                             #   sequentially at scaffold, NEVER changed. Used for product.md anchors
                             #   + provenance so a rename never dangles a citation.
slug: "warm-slot-pool"
                             # kebab-case folder name. Unique across features/ AND archive/. Renamable.
title: "Warm slot pool: pre-provisioned preview environments a pull request claims for a fast URL"
status: active               # active | done | dropped
owner: "andrew"              # single owner (features are single-author; two authors => split)
depth: "prototype"           # prototype | mvp | ga — gate softness. From .spec-flow.md default_depth.
sprint: null                 # native board mode only; else null
external: null               # tracker board mode only; null otherwise.
depends_on: [feat-001, feat-002, feat-003]
                             # feat-001 backing-store: the registry/claim contract this reshapes —
                             #   its "not allocation from a pool" clause is reopened by this feature.
                             # feat-002 deploy-action: the deploy path gains claim-a-warm-slot.
                             # feat-003 teardown: the sweep hosts the pool reconciler / replenisher.
requires_design: null        # null/absent => inherit the workspace default (false).
readiness:                   # per-artifact progress vector
  research: ready            # none | draft | ready — divergent pass + problem brief 2026-08-17
                             #   from the dtak parity study
  design:   n/a              # design not required in this workspace (requires_design: false)
  spec:     ready            # none | draft | ready — written and reviewed 2026-08-17; zero
                             #   clarification markers; reviewer's fixes folded in
  plan:     none             # none | draft | ready
  tasks:    none             # none | draft | ready
gate:
  analyze: not-run           # not-run | pass | blocking | blocking-hard
  product_global_hash: ""
  constitution_hash: ""
human_signoff: []
open_decisions:
  - id: od-1
    description: "U1 — where warm-boot input values come from. DECIDED 2026-08-17 (andrew): the scheduled default-branch workflow supplies TF_VAR_* for the warm build, mirroring the deploy workflow's contract; no static pool.inputs block. Static config was declined because artifact values (image tags) go stale per commit."
    owner: "andrew"
    resolved: true
  - id: od-2
    description: "U3 — pool empty at claim time. DECIDED 2026-08-17 (andrew): fall back to a from-scratch deploy within the same run — the PR always gets a preview, warm when possible, cold otherwise. dtak-parity fail-fast declined as strictly worse for the reviewer."
    owner: "andrew"
    resolved: true
  - id: od-3
    description: "U4 — cap accounting. DECIDED 2026-08-17 (andrew): warm unclaimed slots count against the environment cap; the pool stops replenishing at the cap (dtak's own at-cap behavior). No separate pool ceiling knob."
    owner: "andrew"
    resolved: true
  - id: od-4
    description: "Build-order gate: the three consciously reopened clauses must land before implementation — the backing-store change folder (pool claiming + the warm state), the product-global glossary amendment (ephemeral environment widened; warm slot and pool entries; privacy wording check), and the deploy-action credential-language widening for the slot namespace. Resolve only when all three are merged."
    owner: "andrew"
    resolved: false
overrides: []                # prototype-depth gate overrides; appended ONLY by flow at a STOP,
                             #   on explicit human instruction.
extends:                     # cross-feature additive-extension annotations (§11.t) — advisory.
  - id: ext-1
    feature: feat-003
    what: "The sweep gains a pool phase: replenish to target (one build per pass), destroy commitless warm wreckage, destroy closed claimants' slots; teardown's own sequence applies to slots unchanged."
  - id: ext-2
    feature: feat-005
    what: "The dashboard shows warm records distinctly and, for active pooled slots, the claimant; lands as a dashboard change folder at build time."
---

# Feature notes — Warm slot pool

> The frontmatter above is the CANONICAL manifest. Keep it current; `id` is IMMUTABLE.
> `flow <slug>` reads `readiness` + `gate` to choose the next action. `dashboard.md` and `product.md`
> are GENERATED from these manifests + each feature's `spec.md` — never hand-edit those.

## Notes

- From backlog row 9 (`warm-slot-pool`), reopened 2026-08-17: the user wants dtak parity on warm
  booting before switching dtak over to skyhook.
- Parity target: dtak-prototype's warm slot pool — `deploy/aws/EPHEMERAL.md`,
  `deploy/aws/scripts/pool.sh`, `.github/workflows/slot-pool.yml` in that repo. A scheduled job
  keeps N fully provisioned environments idle; a pull request claims one with a single conditional
  write and applies only its own delta, cutting URL latency from ~15–20 minutes to ~2.
- Known contradiction to resolve deliberately, not silently: the backing store's spec says claiming
  is "mutual exclusion on that name, not allocation from a pool"
  (`spec/features/backing-store/spec.md:24-25`). That clause must be amended through a
  backing-store change folder before this feature's build; this feature's spec defines what the
  clause becomes.
- dtak facts that shape the design: slots are destroyed after their pull request closes and rebuilt
  fresh (fresh-start-per-tenant survives); the reconciler runs only from the default branch on a
  schedule (maps onto skyhook's sweep trust model); the claim-time delta is only the tenant's own
  inputs (maps onto declared deploy inputs).
