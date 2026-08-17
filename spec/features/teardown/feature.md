---
schema_version: 2
id: "feat-003"               # IMMUTABLE
slug: "teardown"
title: "Teardown: destroy a preview environment and free its name when its pull request closes"
status: done                 # complete 2026-08-16: gate pass and current, every sign-off resolved, override cleared, live session passed
owner: "andrew"
depth: "prototype"           # prototype | mvp | ga — from .spec-flow.md default_depth
sprint: null
external: null
depends_on: [feat-001, feat-002]  # the backing store whose record deletion frees a name, and the
                             #   deploy action whose environments this destroys
requires_design: null        # inherits workspace default (false)
readiness:
  research: ready            # none | draft | ready — brief converged and reviewed 2026-08-16; scope includes fast path AND sweep (human call)
  design:   n/a              # design stage is off for this workspace
  spec:     ready            # written and reviewed 2026-08-16; zero markers; 13 ACs at prototype depth
  plan:     ready            # written 2026-08-16; D3 decided (hs-1) and its amendment landed via 5.2
  tasks:    ready            # every task done and verified 2026-08-16; hs-1/2/3 all resolved, live session passed
gate:
  analyze: pass              # 2026-08-16 run 3 — re-gated after the amendment landed; 5.2 checked off, plan D3/Deviations aligned to the landed state
  product_global_hash: "sha256:05854c7a7dc3"
  constitution_hash: "sha256:a045ce0c2437"
human_signoff:
  - id: hs-1
    description: "Decide plan D3: how the close fast path learns protection, given the cloud denies a pull-request run all access to protection marks. Recommended (a): read-only grant on protected/<repo>/pr-* plus a third named exception in the constitution, one main-branch PR (restages every feature's pre-build check). Alternatives: (b) sweep-only destruction, dropping the fast path (AC-1/2/3 re-routed through change); (c) workflow_run indirection (declined once, chg-001). Task 0.1."
    owner: andrew
    resolved: true
    observed: >-
      DECIDED 2026-08-16, option (a): the pull-request role gains read-only access to its own
      repository's ephemeral protection marks (GetObject on protected/<repo>/pr-*, narrowed
      further to the one claimed environment by the session policy), and the constitution gains
      the matching third named exception. Writes and deletes stay cloud-refused. The amendment
      and the roles.tf change travel as one main-branch PR (task 5.2), which restages every
      feature's pre-build check — the accepted cost. Alternatives (b) sweep-only destruction and
      (c) workflow_run indirection were declined: (b) forfeits the fast path the spec commits to,
      (c) is the trusted-workflow coupling chg-001 already ruled out. Until 5.2 lands, the fast
      path fails closed (destroys nothing, says why) and the sweep remains the guarantee.
  - id: hs-2
    description: "Live probes before anything depends on the answers: a closed-type pull_request run is issued an OIDC id-token; a schedule-triggered run assumes the default-branch role; the deploy role with the widened example trust is assumable from that scheduled run. Task 0.2."
    owner: andrew
    resolved: true
    observed: >-
      COMPLETE 2026-08-16, probe workflow run on skylight-hq/deadweight at andrew's direction
      (runs 31970839642 dispatch, 31970855476 closed, 31972312512 schedule); observations
      recorded verbatim from the run logs. The schedule leg closed the last question: the cron
      run was issued an id-token with sub ref:refs/heads/main and event_name "schedule", and
      assumed skyhook-default-branch — (ii) is proven on the literal trigger. Scheduler
      lateness datum: the */30 cron's 21:00:00Z boundary fired at 21:02:38Z, ~2.6 minutes late
      on a fresh workflow — mild, consistent with treating the 15-minute cadence as a floor.
      Earlier legs: (i) PROVED: a closed-type pull_request run IS issued an
      id-token; sub is the ID-qualified pull_request subject; the pull-request role assumption
      succeeds and the default-branch role is refused AccessDenied — the trust split holds on
      close events. (ii) also proved earlier for the same subject via workflow_dispatch. (iii) OBSERVED the migration
      path: skyhook-deploy refused AccessDenied under the old single-subject trust, exactly the
      loud failure an un-migrated installation will meet; then PROVED once the two-subject trust
      was applied — every scheduled sweep destroy in the 6.1 session assumed the deploy role from
      a schedule-triggered run. (iv) the token carries an event_name claim ("workflow_dispatch" on the dispatch
      leg), so scheduled and other default-branch runs ARE distinguishable in the token; whether
      STS honors event_name as a trust condition remains untested — a narrowing candidate, not a
      dependency.
  - id: hs-3
    description: "Live end-to-end verification on the deadweight repo: close destroys (AC-1), sweep repairs a suppressed close (AC-6), a planted protection marker survives both paths (AC-4), reopen deploys fresh (AC-11), the cap slot frees (AC-13); record scheduler lateness against the 15-minute cadence. Task 6.1."
    owner: andrew
    resolved: true
    observed: >-
      PASSED 2026-08-16, driven live on skylight-hq/deadweight at andrew's direction, against the
      real account, through the production action (skylight-hq/skyhook@main). Every criterion on
      the list, plus two unplanned proofs. AC-6 twice: the sweep's FIRST production pass destroyed
      pr-5 (6 real resources, record and state removed, site 404) while leaving the open pr-4
      standing (AC-7); later, GitHub itself dropped a close event — pr-6's second close at
      22:07:29Z fired no workflow run at all — and the 22:21 sweep repaired it unprompted, which
      is the constitution's events-are-a-fast-path clause proven by an accident nobody staged.
      AC-4 both paths: with a hand-planted marker, the close run reported pr-6 left standing
      (proving the amended protection READ works end to end through the narrowed session) and the
      next sweep reported the same; both runs green; env untouched. AC-1: the close of pr-6
      destroyed it inside a minute — resources gone, record removed, name free. AC-11: the reopen
      then claimed fresh (createdAt 22:04:57 vs the original 21:51:49) and deployed to a working
      site; a reopen BEFORE teardown had also refreshed the same environment, proving
      feat-002/AC-5 live as a bonus. AC-13 at a temporary cap of 2: pr-7 refused with "2
      environments recorded, cap 2", then admitted into the slot the sweep freed. Cadence: the
      quarter-hour cron ran 2-6 minutes late per boundary (21:49 for :45, 22:02 for :00, 22:21
      for :15) — the 15-minute figure is a floor plus scheduler lateness, as the sharp edge
      predicted. Cleanup verified: registry holds only pr-4, no markers, no stray state, cap
      restored to 5, probe branches deleted.
open_decisions: []
overrides:
  - id: ov-1
    gate: open-items
    by: andrew
    reason: >-
      Start implement while hs-2 (the live probes, task 0.2) and hs-3 (the end-to-end live
      verification, task 6.1) are unresolved. Phases 1-3 are pure-fake core logic that does not
      depend on the probe answers; hs-2 must be resolved before the wiring phases' assumptions
      are relied on, and hs-3 gates completion regardless. Debt cleared by running the probes.
    at: "2026-08-16"
    resolved: true
    # Cleared 2026-08-16: hs-2 (the start-relevant item) is resolved — the probes ran and every
    # answer is recorded. hs-3 was always the completion gate and still holds completion.
extends: []
---

# Feature notes — Teardown

- Scaffolded 2026-08-16 from the pipeline's standing pointers: the deploy action's research and
  spec both name "teardown when a pull request closes, and the scheduled sweep that makes cleanup
  true" as the next work, and the deploy action shipped with several acceptance criteria
  (its AC-5 and AC-10, and part of AC-19's story) explicitly deferred until teardown exists.
- Scope question for research: the constitution says close events are a FAST PATH only and the
  scheduled sweep is what makes cleanup correct. Decide early whether this feature carries both the
  close-triggered teardown and the sweep, or the sweep splits into its own feature. product-global
  already states the sweep-interval guarantee ("destroyed within one sweep interval of becoming
  eligible"), so whichever way it splits, that guarantee needs an owner.
- The backing store already built the teardown seam: `remove()` deletes the record that frees a
  name, and a half-torn-down environment surfaces as `awaiting-teardown` on claim.
