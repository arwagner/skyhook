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
  plan:     ready            # none | draft | ready — plan + tasks written 2026-08-17; one
                             #   build with chg-012/chg-009 and a drafted feat-005 chg-002
  tasks:    none             # none | draft | ready
gate:
  analyze: pass              # 2026-08-17: first pass fix-then-implement (B1 hard: honest
                             #   cloud/guardrail split in AC-11/D8; B2: retry bound), all
                             #   closures independently re-verified + two residues patched
                             #   same day; see analyze.md
  product_global_hash: "sha256:ccb9ae0efc1f"
  constitution_hash: "sha256:6e2b3ffe7ec9"
human_signoff:
  - id: hs-1
    description: "Task 8.1 — live end-to-end on the deadweight repo with pool.target 1: warm build, warm claim (measure skyhook's share vs the 60 s budget), push refresh, cloud refusals of slot build/destroy from PR credentials, close-destroy-rebuild, conditional-write probe on slot records. Blocks completion, not start."
    owner: "andrew"
    resolved: false
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
    description: "Build-order gate: the reopened clauses must land before implementation. RESOLVED 2026-08-17 — the approved amendments are on main: the chg-012 and chg-009 change-folder artifacts (proposal + delta; their fold into the two canonical spec.md files is deliberately deferred to task 8.2, after the build verifies — the declared-deploy-inputs precedent), the product-global glossary amendment (commit 790a429), and the constitution's fourth named exception (commit 554ccf2). Both sibling gates re-checked to pass the same day."
    owner: "andrew"
    resolved: true
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
