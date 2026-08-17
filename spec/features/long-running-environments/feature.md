---
schema_version: 2
id: "feat-006"               # IMMUTABLE. Format: feat-NNN (zero-padded, >=3 digits), assigned
                             #   sequentially at scaffold, NEVER changed. Used for product.md anchors
                             #   + provenance so a rename never dangles a citation.
slug: "long-running-environments"
                             # kebab-case folder name. Unique across features/ AND archive/. Renamable.
title: "Long-running environments: deploy and manage environments that outlive any pull request"
status: done                 # active | done | dropped — done 2026-08-16 (live session on
                             #   deadweight); reopened 2026-08-17 for chg-001 + the converge
                             #   remediations, re-gated and done again the same day
owner: "andrew"              # single owner (features are single-author; two authors => split)
depth: "prototype"           # prototype | mvp | ga — gate softness. Express lane: prototype explicitly.
sprint: null                 # native board mode only; else null
external: null               # tracker board mode only; null otherwise. One-shot seed, decorative after.
depends_on: [feat-001, feat-002, feat-003]
                             # feat-001 backing-store: the registry that records the environment.
                             # feat-002 deploy-action: the claim/apply machinery this extends.
                             # feat-003 teardown: the destroy machinery a manual teardown drives.
requires_design: null        # OPTIONAL per-feature override of .spec-flow.md requires_design: true |
                             #   false | null. null/absent => inherit the workspace default (false).
readiness:                   # per-artifact progress vector
  research: ready            # none | draft | ready
  design:   n/a              # design not required in this workspace (requires_design: false)
  spec:     ready            # none | draft | ready
  plan:     ready            # none | draft | ready
  tasks:    ready            # none | draft | ready — phase 6 (chg-001 + remediations) built and
                             #   verified 2026-08-17; earlier phases + live must-prove stand
gate:
  analyze: pass              # not-run | pass | blocking | blocking-hard — re-gated 2026-08-17
                             #   after the chg-001 fold (AC-11): pass, advisory wording notes only
  product_global_hash: "sha256:05854c7a7dc3"
  constitution_hash: "sha256:a045ce0c2437"
converge:
  last_run: "2026-08-17"
  open: 0
  contradicts: 0
  runs: 3
human_signoff: []
open_decisions: []
overrides: []                # prototype-depth gate overrides; appended ONLY by flow at a STOP,
                             #   on explicit human instruction.
extends:                     # cross-feature additive-extension annotations (§11.t) — advisory.
  - id: ext-1
    feature: feat-002
    what: "The deploy path gains a default-branch, operator-named variant; record-before-resource and the URL contract apply unchanged."
  - id: ext-2
    feature: feat-003
    what: "A third (manual) starter for the same teardown sequence, and the sweep completes released records of any kind. Teardown's sharp-edge note is annotated accordingly."
---

# Feature notes — Long-running environments

> The frontmatter above is the CANONICAL manifest. Keep it current; `id` is IMMUTABLE.
> `flow <slug>` reads `readiness` + `gate` to choose the next action. `dashboard.md` and `product.md`
> are GENERATED from these manifests + each feature's `spec.md` — never hand-edit those.

## Notes

- Scaffolded 2026-08-16 via the express lane (prototype depth).
- The constitution's mission says an environment "may be tied to the life of a pull request or may
  run long — both are first-class, and neither is the special case." Everything built so far serves
  the pull-request kind; the teardown spec states plainly that long-running environments do not
  exist yet.
- The protection mark exists in the product vocabulary and is read by teardown, but nothing yet
  creates a long-running environment or sets the mark.
- Constitution clauses that bear directly: credentials that reach a long-running environment are
  issued only to a run triggered from the default branch; destruction of a protected environment is
  never automatic; the sweep may create and update a protected environment but never destroys one.
