# Proposal — dashboard / chg-002 — the pool is visible, honestly

**Trigger:** the warm-slot-pool feature (feat-007), whose manifest annotates this extension
(ext-2) and whose spec deliberately carries no dashboard criterion so the requirement has
exactly one home — here. Built with feat-007's build, 2026-08-17.

**Summary:** records in the new `warm` state render as their own visible condition — "warm —
claimable" for a built slot standing ready, "warm — building" for one mid-build — and a
claimed slot's row and detail show the claimant pull request, which for pooled environments
is the fact the identity no longer carries. The three glances stay truthful: warm slots count
in the cap line exactly as the registry counts them (od-3); the freeable glance is unchanged —
a warm slot standing ready is not "reclaimable", it is the pool doing its job; and a claimed
slot's URL answers "where is this branch" the same as any preview's. The claimant is a number
rendered from a hostile record body, so it is derived-or-escaped like every field (the
existing S1 rule).

## Blast radius
- Requirements affected: new **AC-8** (warm rendering + claimant shown), appended to this
  feature's spec at fold time. AC-1's "PR is derived, never stored" gains the claimant as a
  second, explicitly-recorded source for pooled slots only.
- Code affected: `src/core/dashboard.ts` (model row: claimant-aware pull request; status and
  class for warm; claimant detail field), `tests/dashboard.test.ts`.
- Beyond this feature: none.

## Status
- [x] delta reviewed — rode feat-007's gate (pass 2026-08-17)
- [x] implemented & verified — 2026-08-17, in feat-007's build, test-first
- [x] folded into spec.md — 2026-08-17 (AC-8 appended)
