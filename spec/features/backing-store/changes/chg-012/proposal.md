# Proposal — backing-store / chg-012 — the registry admits warm slots and the pool claim

**Trigger:** the warm-slot-pool feature (feat-007), approved 2026-08-17 (its od-4 build-order
gate). The user reopened the pooling decision the same day: dtak-prototype will not switch to
skyhook without warm booting, and feat-007's spec defines a pool of pre-built environments a
pull request claims. Two of this feature's clauses say the opposite of what feat-007 needs, by
design of their time: claiming is "mutual exclusion on that name, not allocation from a pool",
and a record is in exactly one of two states, `active` or `released` — neither of which can
describe an environment that is built but belongs to no pull request yet.

**Summary:** this change makes the registry's contract pool-capable without weakening it. The
state enum gains `warm`: skyhook's environment, built or being built ahead of need, claimable
once its record carries a deployed commit. The claiming clause is rewritten so both claim forms
are named and both stay atomic: a **fresh claim** remains create-if-absent mutual exclusion on
the name, exactly as today; a **pool claim** is a single compare-and-swap on an existing
record, `warm` to `active`, recording the **claimant** pull request. Identity derivation
(AC-14) keeps its meaning with one clarification: what a pull-request run derives is who it
*is* — the claimant — and with pooling enabled the environment it acts on may be a warm slot
whose own identity was fixed at build. All pool *behavior* — replenishment, wreckage, fallback,
teardown of slots — lives in feat-007's spec; this change owns only the registry contract those
behaviors stand on.

## Blast radius

- **Build ordering:** this delta folds only with feat-007's build, and nothing in feat-007 is
  built before this delta, the sibling deploy-action delta (feat-002 `chg-009`),
  product-global's glossary amendment, and the constitution's fourth named exception (both
  main-branch commits, landed 2026-08-17) — feat-007 od-4, following the od-3 precedent from
  `chg-011`.
- Requirements affected: **the claiming paragraph** (Behavior & scenarios, "An environment
  identity names one environment…") — rewritten as Was/Now in the delta; **the state
  paragraph** ("exactly one state") — gains `warm`; **AC-16** — the refusal contract must say
  that a pool claim is not the refused case; **AC-14** — one clarifying sentence on what is
  derived versus what is acted on. New **AC-38** (the pool-claim operation and its contention
  guarantee) and **AC-39** (what a `warm` record carries, including the claimant after a
  claim).
- Design decisions affected: the store contract already exposes compare-and-swap with opaque
  versions, so no new store primitive is required; the registry gains one operation composed
  from it. **D2b is now wrong as written** — "claiming is therefore always create-if-absent,
  with no state machine on top" holds for fresh claims only, and the pool claim is the
  deliberate, named exception; amend D2b's prose when feat-007's plan lands the build. D2c's
  refused-versus-contended reasoning extends to the pool claim unchanged (AC-38 says so).
- Tasks affected: none regenerated now; build tasks arrive with feat-007's plan and are built
  in that one build, as the declared-inputs siblings were.
- Already-built code affected (at build time, listed for honesty): the record type and its
  state union, the registry (claim refusals, the new pool-claim operation, claimant field),
  the fake store's contention tests, and the cap counter's documentation (warm records count,
  which the key-counting implementation already does by construction).
- Beyond this feature: feat-002 `chg-009` (credential language and the deploy path), the
  product-global glossary amendment, and feat-007 itself, which owns every pool behavior.

## Status
- [x] delta reviewed (analyze) — 2026-08-17, blocking then re-gated pass the same day
- [x] implemented & verified — 2026-08-17, in feat-007's build, test-first, plus live on deadweight
- [x] folded into spec.md — 2026-08-17 (AC-38/AC-39 appended; plan D2b amended)
