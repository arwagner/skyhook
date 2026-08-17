# Proposal — warm-slot-pool / chg-002 — the close path cannot free a slot's name, and must say so

**Trigger:** live verification, task 8.1, 2026-08-17, pull request #9 on deadweight. The close
fast path found the slot by claimant, released it, destroyed its infrastructure, deleted its
state — and then crashed at the final step: removing the record is an `s3:DeleteObject` on a
slot registry key, which is exactly the delete AC-11 has the cloud refuse to a pull-request
run (proved by the same run's probe, minutes earlier). Two clauses of this feature collided,
and the cloud picked the winner.

**Summary:** the collision resolves the way the constitution already leans — the sweep is the
guarantee, the close event is a fast path. On a pooled slot, the close path now does
everything it can (release, destroy, verify empty, delete state) and then stops on purpose:
the record stays `released`, the run reports the deferral and succeeds, and the scheduled
sweep — whose default-branch credentials may delete slot records — removes it within one
interval, exactly the bound AC-8 already promises. AC-8's text is untouched; the
claimant-closes scenario gains the honest sentence. Code-wise the teardown sequence gains a
`defer` record-removal mode the close path selects for slot identities; the store adapter's
throw-on-403 remains a separate rough edge (an unhandled exception rather than a typed
failure), recorded in the backlog rather than patched blind mid-verification.

## Blast radius
- Requirements affected: the "claimant's pull request closes" scenario (Was/Now in the
  delta). AC-8 unchanged — "its record deleted within one sweep interval" holds, by the
  sweep. The close-path sharp edge gains the deferral as its normal ending, not a fallback.
- Code affected: `src/core/teardown.ts` (a `recordRemoval: 'remove' | 'defer'` port, default
  `remove`), `src/cli/teardown.ts` (the close path defers for slot identities),
  `tests/teardown.test.ts`, `tests/cli-teardown.test.ts`.
- Beyond this feature: backlog row for the store adapter's untyped 403 (a refused delete
  should be a typed, loud outcome, not a crash).

## Status
- [x] built and re-verified live — 2026-08-17, pull request #10's clean close
- [x] folded into spec.md — same day, mid-build
