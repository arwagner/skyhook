# Proposal — chg-004: the narrowing names what it lets a run see, not only what it lets a run touch

**Trigger:** The live verification of `AC-19` on 2026-08-16, task 7.1. CloudTrail records the inline
session policy verbatim in the `AssumeRoleWithWebIdentity` request, which is exactly the artifact
`AC-19` says to inspect. The policy recorded for run 31953505432 is byte-for-byte what
`sessionPolicyFor()` computes — and it names four grants where the criterion names three.

**Summary:** `AC-19` is modified to name enumeration as the second permitted thing outside the
claimed environment, alongside the one state-key read already named. No code changes and no test
changes: the narrowing has asked for exactly this since the first pull request deployed, and the
suite already asserts it. What moves is the criterion, which has been describing a narrower policy
than the one skyhook sends.

## Why the spec has to move, and not the code

If the code were perfect, the criterion would still be wrong, which is the whole test for this lane.

A session policy narrowed to one environment cannot count the environment cap. The cap is counted by
*listing* the registry prefix precisely because a narrowed run may not *read* each record —
`countEnvironments()` says so in its own comment, and calls it a correctness requirement rather than
an optimization. Remove the enumeration and the cap check fails looking like a broken registry. The
infrastructure tool needs the same allowance for its own reasons. So the fourth grant is
load-bearing, and the criterion is the thing that is wrong.

The boundary this protects is unchanged by saying so: enumeration returns names. Every read, write
and delete the narrowing permits still falls inside the one environment the run claimed, and run
31953505432 proved the cloud holds that line against the credentials a pull request actually gets.

## Why it survived, which is the part worth not repeating

This is the second time `AC-19` has gone untrue by inheriting a decision made one layer down, and it
failed the same way both times.

`chg-003` corrected it for `feat-001`'s `chg-008` — the one state key — five weeks after that grant
shipped. This change corrects it for `hs-1`, the enumeration widening decided on 2026-08-14 and
recorded thoroughly: in the manifest, in `feat-001/AC-17`, in the role's Terraform, in the backlog.
Every layer that owned a copy of the boundary was updated except the one belonging to this feature.

The tests did not catch it, and it is worth being exact about why, because the obvious lesson is the
wrong one. `AC-19` is not uncited — `chg-003` fixed that. There is a test named *the narrowing
permits enumeration but no operation on another environment* citing `feat-002/AC-19`, and a second
that filters the `List` statement out before asserting what is reachable. The suite has therefore
been asserting the enumeration, under this criterion's own id, while the criterion's prose denied it.
A citation proves a criterion is exercised. It does not prove the code and the prose agree, and
nothing in the pipeline compares those two directly.

What did compare them was reading the live artifact against the criterion's words. That is what
`converge` does, and it has never run on this feature.

## What it costs, stated plainly

Nothing in behavior, and one honest concession in the reading: a run's credentials can see the names
of every environment this repository holds, including long-running ones, and could not before a
reader reached `feat-001/AC-17`. Skyhook already treats that as acceptable and says why — a name is
not an environment. `AC-19` now says it too, in the words `feat-001` already used, rather than
inventing a fourth phrasing of the same boundary.

One sharp edge comes with it, and the corrected text names it: the enumeration is granted by a prefix
condition while every acting grant is a resource, so the document's own deny covers the acting
operations alone. A future widening of that condition would not be caught by any deny — the same
asymmetry the pull-request role has, observed at that layer during the same verification.

## Blast radius

- **Requirements affected:** one modified criterion (`AC-19`). Nothing added, nothing removed. `AC-7`
  is unaffected and correct as written — it is about what the cloud refuses, was proven on 2026-08-16,
  and already excludes sibling previews.
- **Design decisions affected:** `D3` carries the same omission — it describes the narrowing as *"the
  registry key ... and the state prefix ..., and nothing else"*. It needs the same correction when
  this is folded. No decision is reversed.
- **Tasks affected:** none. There is no build work: the behavior, the tests and their citations
  already match the corrected criterion.
- **Already-built code affected:** none. `src/adapters/aws/session-policy.ts` is correct and its own
  comments already describe listing as deliberately wider than acting.
- **Not affected:** the inline policy's 2048-character ceiling. This change adds no characters — the
  recorded document is 1048.

## Status
- [x] delta reviewed (analyze) — 2026-08-16, pass; see analyze.md. No blocking findings. The review
      raised one Should-fix that reaches past this feature: the constitution names *one* exception
      outside the ephemeral namespace and `feat-001` names two, and this delta puts a second feature
      on `feat-001`'s side of that. Soft on the reading `hs-1` recorded — the clause governs acting,
      not seeing — and hard on the other. A human ruling is wanted before the fold.
- [x] implemented & verified — 2026-08-16. No source changed and no test changed: the narrowing has
      asked for exactly this since the first deploy, and two tests already asserted it under this
      criterion's own id. 224 tests pass.
- [x] folded into the feature's spec.md — 2026-08-16; `AC-19` modified in place, no id moved. Plan
      decision `D3` corrected in the same edit, which is what the review asked for.

## The ruling this change waited on

The review's Should-fix (S1) turned on a reading of the constitution, and the human ruled on
2026-08-16: **to see that an environment exists is not to reach it.** That is the reading `hs-1`
adopted on 2026-08-14, now confirmed and, more importantly, written down where it governs.

The constitution was amended in consequence, as its own change off `main`: the clause now names **two**
exceptions rather than one, says outright that every refusal in it concerns what a run may *do*, and
states what the enumeration costs — a pull-request run can learn that a long-running environment
exists and what it is called, so a name that cannot be disclosed should not be an environment name.

That amendment is why this criterion's folded wording differs from the drafted one. The draft had
`AC-19` restating the enumeration allowance for itself; the folded text points at the constitution's
two exceptions instead, because there is now one place that defines them. Three documents said this
in three ways when the change was drafted, which is how it went untrue twice.
