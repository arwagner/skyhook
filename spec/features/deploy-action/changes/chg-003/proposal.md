# Proposal — chg-003: the narrowing names one key beyond this run's own, and says so

**Trigger:** The pre-build check on 2026-08-15, re-run after the constitution amendment. `AC-19`
says the narrowing names this run's registry key and state prefix *"and no other"*. It has named one
other since `feat-001`'s `chg-008` landed, deliberately, and this feature's spec was never updated.

**Summary:** `AC-19` is modified to name the exception the constitution now states, and to say why
the exception has to appear at this layer as well as at the role. No code changes: the session policy
already does exactly what the corrected criterion describes, and has since the first pull request
deployed.

## Why this feature's spec has to move, and not the code

The backing store's `chg-008` granted a read on the single state key the infrastructure tool
consults before it can be told which environment it is working on. That change is recorded there, and
the constitution was amended today to state the exception rather than forbid it outright.

What was recorded nowhere is that the grant had to be made **twice**. The tool runs on the credentials
*this* feature narrows, and their inline policy denies everything outside the claimed environment
too — so a grant at the role that the session then denies is no grant at all. The role-only attempt
was tried first and the run was still refused. `AC-19` is the criterion that describes this layer, so
it is the criterion that is wrong.

Both other statements of the same boundary already agree with each other:

- **Constitution**, *Security & compliance*: *"Every layer that narrows a run's reach must permit
  exactly this and nothing further."*
- **`feat-001/AC-29`**: *"Every layer that narrows a run's reach permits exactly this same key."*

This delta makes the third statement agree with them, in their words rather than a fourth phrasing.

## Why it survived long enough to need a change

`AC-19` is the only criterion in this feature with no test citing it. The narrowing is tested
thoroughly — permitted resources, the explicit deny, the enumeration allowance, the protection-mark
refusal, the inline-policy size ceiling — but every one of those tests cites `AC-7`, which is the
criterion about *what the cloud refuses*. `chg-001` split those two apart on purpose; the tests never
followed.

A test citing `AC-19` and asserting the narrowing's exact resource list would have failed on the day
`chg-008` added the second resource, which is the day the criterion stopped being true. Re-citing them
is part of this change rather than a follow-up, because the citation is what stops this recurring.

## What it costs, stated plainly

Nothing in behavior. It costs an honest reading of one criterion: the narrowing is a boundary with a
named hole in it, and a reader of `AC-19` alone previously could not have known that. The hole is one
object, readable and never writable, that skyhook never creates.

## Blast radius

- **Requirements affected:** one modified criterion (`AC-19`). Nothing added, nothing removed.
- **Files:** no source changes. `tests/deploy-adapters.test.ts` gains `AC-19` citations on the tests
  that assert what skyhook *asks for*, keeping `AC-7` on those that assert what the cloud refuses,
  and one stale comment describing the withdrawn preview-to-preview guarantee is corrected.
- **Not affected:** `AC-7` is correct as written and explicitly excludes sibling previews. The
  session policy's size ceiling is untouched — this change adds no characters to the document.

## Status
- [x] delta reviewed (analyze) — 2026-08-15, pass; see analyze.md
- [x] implemented & verified — 2026-08-15. No source changed: the session policy already did this.
      What changed is the citation, so the resource set is now asserted against AC-19 and a third
      entry fails in the suite rather than in a live run.
- [x] folded into the feature's spec.md — 2026-08-15; AC-19 modified in place, no id moved.
