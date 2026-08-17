---
schema_version: 2
id: "feat-005"               # IMMUTABLE
slug: "dashboard"
title: "Dashboard: see the environments skyhook manages"
status: done                 # active | done | dropped — chg-001 built, verified and folded 2026-08-17; gate pass
owner: "andrew"
depth: "prototype"           # express lane — prototype depth, set explicitly
sprint: null
external: null
depends_on: [feat-001]
                             # feat-001 backing-store: the registry the dashboard reads.
requires_design: null        # inherits workspace default (false)
readiness:
  research: ready            # none | draft | ready
  design:   n/a              # design stage is off for this workspace
  spec:     ready            # validate --as-ready clean; spec-review blocking findings fixed 2026-08-16
  plan:     ready            # plan + tasks written 2026-08-16
  tasks:    ready            # phase 4 (chg-001) built and verified 2026-08-17; chg-001 delta folded 2026-08-17
gate:
  analyze: pass              # 2026-08-17 re-gate after remediation: B2 display leg closed (escaping/non-linkification/sharp edge in the delta and D5); build waits on feat-001 16.4; see analyze.md
  product_global_hash: "sha256:a8932ef5ee1c"
  constitution_hash: "sha256:a045ce0c2437"
human_signoff:
  - id: hs-1
    description: >-
      The must-prove observation (task 3.1): run `skyhook dashboard` from the real consuming repo
      against the real installation and confirm at a glance — cap headroom, which slot can be
      freed, and the URL for a branch's PR — without the AWS console or CLI. Machine-unverifiable
      by nature; blocks completion, not the build.
    owner: andrew
    resolved: true
    observed: >-
      PASSED 2026-08-16, run from the real consuming repo (deadweight) against the real
      installation. Cap line read "1 of 5 environments used". The one environment (pr-4) showed
      as in use — correctly neither reclaimable nor protected. Its PR URL was present as a
      working link. All three glances answered with no AWS console and no CLI.
open_decisions:
  - id: od-1
    description: >-
      How the prototype satisfies "the dashboard is not publicly readable": a locally served page
      using the developer's own credentials (nothing hosted), or a hosted page behind real
      authentication. Changes the architecture, so it must be decided before plan/implement.
    owner: andrew
    resolved: true
    resolution: >-
      2026-08-16: locally served page. A skyhook command run from inside the consuming repo serves
      the page to the developer, reading the registry with the developer's own credentials.
      Nothing is hosted, so nothing is public. Real authentication is recorded debt to pay at
      promote.
overrides:
  - id: ov-1
    gate: open-items
    by: andrew
    at: "2026-08-16"
    reason: >-
      hs-1 (the must-prove observation) can only be performed after the build exists, so it
      cannot gate the build's start. It remains unresolved and still blocks completion.
    resolved: true             # 2026-08-16: hs-1 observed and resolved — the real gate is satisfied
extends: []
---

# Feature notes — Dashboard

> The frontmatter above is the CANONICAL manifest. Keep it current; `id` is IMMUTABLE.
> `flow <slug>` reads `readiness` + `gate` to choose the next action. `dashboard.md` and `product.md`
> are GENERATED from these manifests + each feature's `spec.md` — never hand-edit those.

## Notes

- Scaffolded 2026-08-16 via the express (prototype) lane.
- Product-global already binds this surface: the dashboard renders its environment list in under
  2 seconds, is not publicly readable and requires authentication, and conforms to WCAG 2.2 AA.
