# Proposal — chg-005: the budget names both things it does not count

**Trigger:** `gap-001`, opened by the first code-vs-spec audit on 2026-08-16 (`converge.md` run 1).
`terraform init` — which downloads the consuming repository's providers and modules — is timed into
`preparationMs` and reported as **skyhook's** share of the run. Plan `D7a` rules the opposite in as
many words, and the port's own contract (`src/core/ports.ts:110`) defines `applyMs` as *"the
consuming repo's apply, **and fetching what it needs to run**"*. The code disagrees with both.

**Summary:** `AC-14` is modified to name **two** exclusions rather than one — applying the
repository's infrastructure, and the step in which the infrastructure tool prepares that definition
beforehand — and the deployer is changed to report the two separately so the figure it hands back
means what the criterion says. The criterion also names the one piece of skyhook's own work that
sits inside that preparation step and is therefore not counted. The behavior of a deploy does not
change; what changes is which seconds skyhook claims as its own.

## Why the spec has to move, and not only the code

The lane test is: if the code were perfect, would the spec still be wrong? Here, yes — and this is
the subtle part, because the *first* fix is to the code.

`AC-14` excludes exactly one thing: *"excluding the consuming repository's apply"*. Fetching
providers is not the apply. So a reader checking the criterion literally against corrected code
would find skyhook excluding something the criterion never authorized — the criterion would be
false about the fix that makes it true in spirit. Plan `D7a` already saw this and said so out loud:
*"The spec does not adjudicate it, so this plan does."* A plan may adjudicate what a spec leaves
open, but not when the ruling changes what a shipped number **means**. That belongs to the
criterion.

So the change is both: the code stops charging skyhook for somebody else's dependency tree, and the
criterion stops enumerating one exclusion when there are two.

## Why this went unnoticed while the suite stayed green

Worth being exact, because the obvious lesson is the wrong one again. `AC-14` is not uncited: there
is a test at `tests/deploy.test.ts:380` naming the criterion and asserting the arithmetic carefully.

It cannot catch this. The test drives a `FakeDeployer` that is **handed** its own
`{preparationMs, applyMs}` split and then checks that the use case subtracts the right one. The
split is the input, not the output. Nothing in `tests/deploy-adapters.test.ts` asserts on timing at
all, so where the real deployer draws the line is exercised by no test in the suite.

This is the class of defect the plan's own *"what the tests cannot prove"* note names — an injected
runner proves what skyhook asks for, never what the boundary actually is — and it is the third time
this feature has been bitten by it. The remedy in the tasks below is therefore an assertion against
the **real** `TerraformEnvironment` with an injected clock, not another fake with a pre-made answer.

## What it costs, stated plainly

Under the corrected reading, skyhook's reported share gets **smaller**, and that direction deserves
naming: a budget exists to catch skyhook being slow, so under-reporting is the unsafe direction.

The recommended split (task 11.1) charges *all* of `terraform init` to the repository, which means
skyhook's own backend configuration — a couple of object-store round-trips inside that same command
— stops being counted. That residue is bounded and boring. What it buys is that an unbounded
quantity nobody controls stops being counted, which is the trade `D7a` already argued: *"Counting
them against skyhook's 60 seconds would make the budget a measure of somebody else's dependency
tree."*

The exact alternative was considered and is not recommended **now**: run `terraform init
-backend=false` for the providers and a second `init` for the backend, timing them apart. It is
honest to the millisecond and costs a second invocation in the one step of this feature that has
already produced two live defects — the 403 at the bucket root, and a workspace that would not
create itself. At prototype depth a bounded, explicable inaccuracy beats new surface there. It stays
available the day the figure has to be defended precisely, and task 11.1 records it in place so
nobody re-derives it.

## The wrinkle that reaches past this feature

`product-global.md` states the same budget one layer up, and enumerates the same single exclusion:
*"Time spent applying the consuming repo's infrastructure is excluded, as skyhook does not control
it."* Its stated **reason** — that skyhook does not control it — covers provider fetching exactly.
Its **enumeration** does not.

That is the shape of problem `chg-004` met with the constitution: a boundary written down in two
places, corrected in one. Cross-cutting requirements are not a feature change's to edit, so this
proposal does not touch it. It is recorded as `od-3` for a human, with a recommendation: amend
`product-global.md`'s performance requirement, through its own pull request off `main`, to name what
it already implies. Leaving the two texts disagreeing is how `AC-19` went untrue twice.

## Blast radius

- **Requirements affected:** one modified criterion (`AC-14`). Nothing added, nothing removed. No
  other criterion mentions timing.
- **Design decisions affected:** `D7a` is rewritten — it currently quotes `AC-14` as excluding
  *"only the consuming repository's apply"* and then adds a second exclusion, which is the tension
  this change resolves. `D11` is unaffected; no file moves.
- **Tasks affected:** new Phase 11 (11.1, 11.2). Phase 2's task 2.3 and Phase 3's task 3.6 both
  claimed this measurement and are left checked off — what they built was right except for where
  one boundary fell, and the correction is its own work rather than a reopening.
- **Already-built code affected:** `src/core/ports.ts` (`DeployTiming` gains a third field),
  `src/adapters/terraform/environment.ts` (where the boundaries fall),
  `src/core/deploy.ts` (subtracts two durations rather than one),
  `tests/deploy.test.ts` and `tests/fake-deployer.ts` (the fake's shape),
  `tests/deploy-adapters.test.ts` (the assertion that has never existed).
- **Not affected:** the reported figure's format, the action's `skyhook-seconds` output, and every
  criterion proven live on 2026-08-15/16. The live figure was 12.2s against a budget of 60, so no
  proven result changes sign under the correction.

## What the pre-build check sent back

The first pass over this delta stopped it, and the finding is worth keeping rather than quietly
fixing, because of what it was.

The drafted criterion excluded *"fetching what that definition needs"*. `D7a` excludes the whole
step that does the fetching — a step which also settles where skyhook's own state lives. So the
criterion would have enumerated one job while the code excluded a command that does two, and it
would have been false about the built code on the day it folded. That is `gap-001` exactly,
reproduced inside the change written to fix it, and it is the third time in this feature a criterion
has enumerated less than the implementation does (`AC-19` twice, via `chg-003` and `chg-004`).

The exclusion is now drawn at the **step**, which is the boundary the code can actually hold, and
the residue — skyhook's own backend configuration, sitting inside that step and therefore uncounted
— is named in the criterion rather than only in the plan. Two smaller findings were taken with it:
the third timing field is named `initMs`, after the command, rather than after one of the two jobs
it holds; and the criterion's closing sentence now states an outcome ("time skyhook spends that
nobody thought to measure is counted against skyhook rather than omitted") instead of prescribing
the subtraction that delivers it, which is `D7a`'s business.

The two-init split that would let the criterion keep the narrower wording remains priced in `D7a`
and untaken. If it is ever built, the criterion narrows with it — as a change, in that order, never
as an implementation detail that quietly makes the spec generous.

## Status
- [x] delta reviewed (analyze) — 2026-08-16. Fourth pass returned one Blocking finding (soft), B1
      above; fifth pass after the rewording is a pass with no blocking findings. `S1` — the same
      budget stated in the cross-cutting requirements with one exclusion — stands and is not this
      gate's to close; it is `od-3`, recommended for its own pull request off `main`.
- [ ] implemented & verified
- [ ] folded into the feature's spec.md (product.md regenerates; never edit it by hand)
