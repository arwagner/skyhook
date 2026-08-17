# Drift ledger — long-running-environments (feat-006)

> GENERATED and APPEND-ONLY. Written solely by the `converge` skill. Never hand-edit, never
> renumber a run or a gap id, never rewrite a prior block. A correction to a past entry is a new
> event in the next run, with a note.
>
> This ledger records the code measured against `spec.md`, `plan.md`, `tasks.md`, and the shared
> non-negotiables. `analyze` checks the artifacts against each other; this checks them against
> what was actually built.

## run 1 — 2026-08-16

baseline: spec.md sha256:fc1f74828959 · plan.md sha256:b0785bf6a974 · tasks.md sha256:bcb701d6c289

First run. No prior ledger, so every finding opens a gap; nothing to reconcile or close. All ten
criteria are implemented with citing tests (`feat-006/AC-N` traces present for every criterion),
the suite stands at 342 passing, and the whole must-prove ran live on deadweight the same day
(task 5.1 records the run ids). The findings below are in the places a green suite and a clean
live session cannot see: a two-command race no single run exercises, a test the plan promised
that the passing suite does not contain, and a widening of the surface no artifact asked for.

- opened gap-001 [contradicts] spec:"AC-7 … the sweep's completion is never blocked by a mark"

  `src/core/protection.ts:40-51` — `setProtection` reads the record, sees `active`, then writes
  the protection mark as a separate object with nothing tying the write to the record version it
  read. A teardown can release the record in that window: teardown reads protection (absent),
  releases; protect's earlier read saw `active`, its write lands after. The result is a
  `released` record carrying a mark — exactly the state AC-7's guarantee rests on being
  unreachable, and `tests/protection.test.ts:53-62` shows it is well-formed at the primitive
  level. Once reached it wedges: the next sweep pass runs `teardownEnvironment`, which checks
  protection before completing (`src/core/teardown.ts:95-111`) and returns
  `left-standing-protected` — a started teardown the sweep now refuses to finish — while
  `unprotect` refuses to clear the mark because the record is `released`
  (`src/core/protection.ts:47`). Getting out requires hand-editing the bucket. Both `protect`
  and `teardown --environment` are workflow_dispatch runs, so two humans racing is realistic.

  The single-actor path is sound — teardown always honors a mark before releasing — so this is
  specifically the concurrent-write race, kin to the reactivation window `teardown.ts:191-194`
  already records as consciously accepted debt. This one differs in landing in a wedged state
  rather than a loud retry, which is why it is a gap and not an observed note.

  route: change(defect) — gate the mark write on the record still being `active` (a versioned
  write, or a post-write re-check that unwinds the mark when the record moved), plus a regression
  test citing this gap. The spec is right; the code's window is the defect.

- opened gap-002 [partial] plan:"Verification approach — AC-6, AC-8 rows" · spec:"AC-6, AC-8"

  The plan's verification table promises CLI-seam tests driven through fakes: `teardown
  --environment staging` reaching the `destroyed` outcome (AC-6), and the protected → refused →
  cleared → succeeds sequence at the CLI seam (AC-8). What `tests/cli-teardown.test.ts` and
  `tests/cli-protect.test.ts` actually hold: the exit-code maps, the ref and namespace refusals,
  and argument wiring — every test stops before the success-reporting branches of
  `manualTeardown` (`src/cli/teardown.ts:171-247`) and `protect` (`src/cli/protect.ts:73-107`),
  which no fake-driven test reaches. The behavior itself is composed from unit-tested cores and
  was observed live (task 5.1, runs 31981024272 and 31980953025), so this is a test-coverage gap,
  not a behavior gap — but the artifact promising the test is checked `[x]` and the test is not
  there.

  route: tasks — a remediation task appending the two fake-driven CLI tests. The feature is
  `done`, and reopening a done feature is a human call (contract §11.o): the task is NOT appended
  and readiness NOT lowered until the owner says so; recorded here so the debt is visible either
  way.

- opened gap-003 [unrequested] code:"protect/unprotect accept ephemeral (pr-*) names"

  `src/cli/protect.ts:63-71` deliberately lets a `pr-*` name through the legality check, on the
  reasoning that the namespace fence guards creating environments, not marking them, and that
  teardown (feat-003) already honors marks on ephemeral environments. Coherent — but no story,
  scenario, or criterion in this feature's spec asks for it (AC-8/AC-9 speak only of long-running
  environments), and plan D6 does not mention it. It widens the feature's stated surface: a human
  can now latch a pull-request preview against the close event and the sweep from the CLI, which
  nothing written down says is wanted.

  route: human decision — legitimize it (a change with an `## ADDED` delta naming the behavior)
  or remove it (restrict the two commands to non-ephemeral names). Until decided, the behavior
  stands and this gap records that it was chosen by code, not by an artifact.

**Swept for unrequested behavior; one found** (gap-003 above). Other candidates all trace:
`--environment` on teardown doubling `SKYHOOK_ENVIRONMENT` is task 2.3's own wording; the action's
`command`/`environment` inputs are plan D1; the dispatch row sitting above the close row in
`action.yml` is order the routing needs and is pinned by a test (`tests/cli-teardown.test.ts:176`).

**Observed, deliberately not a gap.**
- `openManual`'s wide session (`src/adapters/aws/broker.ts:169-183`) matches plan D6's recorded
  guardrail gap word for word; the comment claims no more than the plan does.
- `reportManual` (`src/cli/teardown.ts:256-268`) computes and discards `report()`'s return value
  before returning its own exit code — harmless, since the two only disagree on
  `left-standing-protected`, which is handled before the call, but it reads as dead code.
- The scaffolded workflow ships its `push:` block commented out, exactly as D1 reasons; the live
  consuming repo's uncommenting of it is operator action, not drift.
- No naming drift against `product-global.md`'s glossary.

verdict: open 3 (missing 0, partial 1, contradicts 1, unrequested 1)

## run 2 — 2026-08-17

baseline: spec.md sha256:8840cfd6a5bc · plan.md sha256:608b86149c75 · tasks.md sha256:4718a30adcc9

Two of run 1's gaps are remediated and closed on cited evidence; the third awaits its ruling. The
break run between the two converge runs matters to this block: it executed run 1's race rather
than re-reading it, and it found one live defect converge could not (the close fast path skipped
when a carried name was present — folded as AC-11 via chg-001, outside this ledger's gaps but
part of the same remediation phase). The suite stands at 349 passing with the typecheck clean.

- closed gap-001 [was contradicts] spec:"AC-7 … the sweep's completion is never blocked by a mark"

  Fixed at both ends, and the fix is the spec's own sentence made literal. `src/core/teardown.ts`
  now honors a protection mark only while the record is `active` — "the mark is honored before
  release, never after" — so a released record completes whatever stray mark sits on it, and the
  record-plus-marker removal deletes the mark with the record. `src/core/protection.ts` re-checks
  the record after writing a mark and unwinds one that landed on a just-released (or just-removed)
  record, answering `released`/`no-record` truthfully instead of "protected".

  Closed on evidence that did not exist at run 1: the break run's probe P2 executed the race and
  demonstrated the wedge (sweep `left-standing-protected`, unprotect refusing); it graduated into
  three regression tests citing `feat-006/AC-7` and `gap-001` — the interleaved protect-vs-release
  race and the protect-vs-removal race in `tests/protection.test.ts`, and the stray-mark-on-
  released sweep completion in `tests/sweep.test.ts`. All red against the run-1 code by
  construction (P2 failed exactly there), green now.

- closed gap-002 [was partial] plan:"Verification approach — AC-6, AC-8 rows"

  The promised CLI-seam tests exist. `tests/cli-teardown.test.ts` drives `teardown` through an
  injected access opener and fakes to the `destroyed` outcome with the name freed
  (`feat-006/AC-6`, citing `gap-002`) and through the protected → non-zero refusal naming the
  unprotect step → cleared → succeeds sequence (`feat-006/AC-8`); `tests/cli-protect.test.ts`
  reaches protect/unprotect `applied` with the mark visible between, plus the released refusal
  at the same seam (`feat-006/AC-9`). The seam is an explicit injected dependency
  (`ManualAccessOpener` on the two commands' options), not a mock of internals — production
  wires `AwsAccessBroker.openManual`, tests hand in a fake registry and destroyer.

- confirmed gap-003 [unrequested] code:"protect/unprotect accept ephemeral (pr-*) names"

  Unchanged and still awaiting the owner's ruling: legitimize with an `## ADDED` delta, or
  restrict the commands to non-ephemeral names. The break run's related-but-distinct P4
  observation (an uppercase `PR-7` is a legal long-running name) also still awaits its ruling;
  it is a probe note, not a ledger gap.

Note for the record: run 1 predicted a lingering mark on a released record was reachable only by
the gap-001 race; the break run confirmed it by execution before the fix, and the fix makes the
state harmless even if minted by some future path — the sweep completes through it.

verdict: open 1 (missing 0, partial 0, contradicts 0, unrequested 1)

## run 3 — 2026-08-17

baseline: spec.md sha256:aa36edcd4ded · plan.md sha256:608b86149c75 · tasks.md sha256:cf578573292a

The last open gap closes on the owner's ruling, and the ledger goes clean. The break run's two
parked probe questions were ruled the same day (capitals accepted, idempotency accepted), recorded
as sharp-edge lines in `spec.md`, and the probe file retired — those were probe notes, not ledger
gaps, and are named here only so the day's rulings live in one place.

- closed gap-003 [was unrequested] code:"protect/unprotect accept ephemeral (pr-*) names"

  Legitimized, not removed: the owner ruled 2026-08-17 that a human may latch a pull-request
  preview against the close event and the sweep. The behavior is now chosen by an artifact —
  `chg-002`'s delta folded into `spec.md` as AC-12, which scopes itself against AC-3 explicitly
  (marking is not creating) — and pinned by a citing test
  (`tests/cli-protect.test.ts`, `feat-006/AC-12` · `gap-003` · `chg-002`) driving protect and
  unprotect on `pr-482` through the CLI seam. The incremental gate re-ran on the fold and passed;
  its one cosmetic suggestion (the case-sensitivity parenthetical on AC-3) was applied.

verdict: open 0 (missing 0, partial 0, contradicts 0, unrequested 0)
