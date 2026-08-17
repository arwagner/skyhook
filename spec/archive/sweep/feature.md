---
schema_version: 2
id: "feat-004"               # IMMUTABLE. Format: feat-NNN (zero-padded, >=3 digits), assigned
                             #   sequentially at scaffold, NEVER changed. Used for product.md anchors
                             #   + provenance so a rename never dangles a citation.
slug: "sweep"                # kebab-case folder name. Unique across features/ AND archive/. Renamable.
title: "Sweep: the recurring job that compares actual environments against the registry and corrects the difference"
status: dropped              # active | done | dropped
owner: "andrew"              # single owner (features are single-author; two authors => split)
depth: "prototype"           # prototype | mvp | ga — gate softness. Seeded from .spec-flow.md
                             #   default_depth (default prototype). MISSING => effective mvp (v1 compat).
sprint: null                 # native board mode only; else null
external: null               # tracker board mode only; null otherwise. One-shot seed, decorative after.
depends_on: [feat-001, feat-003]
                             # feat-001 backing-store: the registry the sweep reads.
                             # feat-003 teardown: the destroy machinery the sweep drives.
requires_design: null        # OPTIONAL per-feature override of .spec-flow.md requires_design: true |
                             #   false | null. null/absent => inherit the workspace default (false).
readiness:                   # per-artifact progress vector
  research: none             # none | draft | ready
  design:   n/a              # design not required in this workspace (requires_design: false)
  spec:     none             # none | draft | ready
  plan:     none             # none | draft | ready
  tasks:    none             # none | draft | ready
gate:
  analyze: not-run           # not-run | pass | blocking | blocking-hard
  product_global_hash: ""    # sha256:12 of product-global.md at last per-feature analyze
  constitution_hash: ""      # sha256:12 of constitution.md at last per-feature analyze
human_signoff: []
open_decisions: []
overrides: []                # prototype-depth gate overrides; appended ONLY by flow at a STOP,
                             #   on explicit human instruction.
extends: []                  # OPTIONAL cross-feature additive-extension annotations (§11.t).
---

# Feature notes — Sweep

> The frontmatter above is the CANONICAL manifest. Keep it current; `id` is IMMUTABLE.
> `flow <slug>` reads `readiness` + `gate` to choose the next action. `dashboard.md` and `product.md`
> are GENERATED from these manifests + each feature's `spec.md` — never hand-edit those.

## Notes

- **Dropped 2026-08-16, before any artifact was written.** The scheduled sweep this feature was
  scaffolded for already exists: teardown (feat-003) specified and built it — the recurring pass,
  eligibility, protection, retries, and races. The only remaining piece is the sweep's second
  direction (infrastructure with no registry record), which stays parked in `spec/backlog.md`
  as `sweep-second-direction`. The human chose to drop rather than re-scope.
- Seeded from `product-global.md`: the sweep is the recurring job that compares actual
  environments against the registry and corrects the difference.
- Global NFRs that bear directly on this feature: the sweep runs no less often than every
  15 minutes; an environment eligible for teardown is destroyed within one sweep interval of
  becoming eligible; a sweep that cannot complete reports failure visibly rather than exiting
  successfully.
- Product invariants it backs: no environment exists that skyhook cannot locate and destroy;
  a protected environment is never destroyed without an explicit human action.
