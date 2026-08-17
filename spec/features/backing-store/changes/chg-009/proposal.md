# Proposal — chg-009: the bootstrap asks GitHub which subject a run will present, rather than assuming it

**Trigger:** The first live run of the deploy action, 2026-08-15, on `skylight-hq/deadweight`.
Every role assumption was refused. Raised as `feat-002`'s `od-1`, and it belongs here because the
bootstrap owns these roles.

**Summary:** The trust policies no longer hard-code the form of the OIDC subject a run presents.
`skyhook bootstrap` asks GitHub which form applies to the repository, passes it to the bootstrap as
`subject_prefix`, and says out loud which form it used. Nothing else about the trust model moves:
the two roles still differ in exactly one thing, which subject they accept, and a pull request still
cannot change the subject its own workflow presents.

## Why the option this decision recommended turned out to be impossible

`od-1` offered three ways out and recommended (a): condition the trust policies on the immutable
`repository_id` and `repository_owner_id` claims instead of on `sub`. It is the better design on its
merits — ids survive a rename and a transfer, which `sub` does not, and this feature had already
been bitten once by a transfer.

AWS refuses it. A trust policy for the GitHub provider that conditions on neither `sub` nor
`job_workflow_ref` is rejected outright with `MalformedPolicyDocument`. That is not a preference to
be argued with and not something any amount of reading settles in advance: only an apply says so.

So the subject must be matched, which means its form matters, which means somebody has to know it.
This organization issues **ID-qualified subjects** — a run presents
`repo:skylight-hq@26345547/deadweight@1335111920:pull_request`, not `repo:skylight-hq/deadweight:pull_request`.
That form is GitHub's own defence against a resurrection attack: delete a repository, recreate the
name, inherit its trust. A policy written against the plain name refuses every assumption in such an
organization, and the only symptom is an `AccessDenied` that names nothing.

## Why skyhook asks rather than letting the operator type it

`od-1`'s option (b) was to take the prefix as a bootstrap variable, and it was marked down for making
every operator discover and copy a value they have never heard of. That cost is removable, and
removing it is what this change actually adds over the option as written: GitHub states the prefix
outright, at `/repos/{owner}/{repo}/actions/oidc/customization/sub`, so skyhook asks.

Somebody sent to find that string will paste it wrong, and a wrong prefix fails exactly the way a
right one is meant to work — silently, at the moment of assumption, naming nothing.

Option (c), matching `sub` with a wildcard, was never in play. The constitution's own comment calls
it the classic way this trust model is lost.

## What it costs, stated plainly

- **The bootstrap now reaches a second network service.** It read only the cloud account before; it
  now also reads GitHub, using `GH_TOKEN` or `GITHUB_TOKEN` if either is set.
- **The endpoint needs repository admin.** On a 403 or a 404 skyhook falls back to the conventional
  form, which is right in the common case and wrong in exactly the organizations that most need the
  answer. So it is reported rather than assumed: the bootstrap prints either
  `(as GitHub reports it)` or `(the conventional form; GitHub did not state one)` before anything is
  applied.
- **An installation applied before this change** keeps a trust policy naming whichever form was
  hard-coded. Where that is the wrong form nothing works at all, so the failure is loud; where it is
  right, re-applying changes nothing.

## Alternatives rejected

- **Condition on the immutable repository and owner ids** (`od-1` option a). Impossible — see above.
  Worth keeping in writing, because it is the design a reviewer will propose again.
- **Take the prefix as an operator-supplied variable and stop there** (`od-1` option b as written).
  This is what ships, minus the asking. Rejected on the failure mode: an operator who never learns
  the value exists cannot be told they got it wrong.
- **Match `sub` with `StringLike` and a wildcard** (`od-1` option c). Rejected by the constitution.

## Blast radius

- **Requirements affected:** three added criteria. Nothing existing becomes untrue — the spec never
  said how the subject was matched, which is why the assumption survived to a live run. The third
  (`AC-34`) was added by the pre-build check and states the property that makes reading a mutable
  setting into a security boundary acceptable: the answer is pinned at apply time and every wrong
  answer fails closed.
- **Plan:** D2's trust-policy story gains the subject-form decision. Two passages describing the
  withdrawn reusable-workflow design (`job_workflow_ref` as the fix-in-waiting) are corrected in the
  same pass — `feat-002`'s `chg-001` withdrew that design and the plan still presents it as pending.
- **Files, all already built and proven live:** `terraform/bootstrap/oidc.tf`,
  `terraform/bootstrap/variables.tf`, `src/adapters/github/repository-ids.ts` (new),
  `src/cli/bootstrap.ts`, `tests/bootstrap-terraform.test.ts`.
- **The one thing not built:** `subjectPrefix()` has no unit tests. It has five outcomes — GitHub
  states a prefix, GitHub is silent, the endpoint is forbidden, the answer is unreadable, the host is
  unreachable — and the fallback branch is the one that matters most and is exercised least. The
  pre-build check found the same hole one level up: nothing verified what the *command* tells the
  operator either, which is the whole of `AC-33`.
- **One defect, fixed under the defect lane and not part of this delta:** making `subject_prefix`
  required left `init`'s printed instructions unfollowable, since they named a manual
  `terraform apply` with three variables. Step 1 now points at `skyhook bootstrap`. Recorded as
  task 12.4.

## Status
- [x] delta reviewed (analyze) — 2026-08-15, blocking (soft); both findings fixed, `AC-34` and two
      verification tasks added, then re-run
- [x] implemented & verified — 2026-08-15. The behavior shipped before the record did; what this
      phase added is eleven tests over the lookup, what the command says about it, and the
      pinned-and-fail-closed property. Suite green at 218.
- [x] folded into the feature's spec.md — 2026-08-15; `AC-32`, `AC-33`, `AC-34` appended, the
      trust-anchor sharp edge modified, and a behavior paragraph added. Folded under *OIDC subject*
      rather than *identity*, which this spec already uses for an environment's name.
