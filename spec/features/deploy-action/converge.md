# Drift ledger — deploy-action (feat-002)

> GENERATED and APPEND-ONLY. Written solely by the `converge` skill. Never hand-edit, never
> renumber a run or a gap id, never rewrite a prior block. A correction to a past entry is a new
> event in the next run, with a note.
>
> This ledger records the code measured against `spec.md`, `plan.md`, `tasks.md`, and the shared
> non-negotiables. `analyze` checks the artifacts against each other; this checks them against
> what was actually built.

## run 1 — 2026-08-16

baseline: spec.md sha256:61af97e7e1f1 · plan.md sha256:36357bd2b33d · tasks.md sha256:f318703dff8e

First run. No prior ledger, so every finding opens a gap; nothing to reconcile or close. Task 7.1
predicted this run would be worth making — *"comparing a criterion against a live artifact rather
than against the code's intent. `converge` has never run on this feature."*

Twenty criteria carry a citing test (`AC-8` is retired by `chg-001` and not reused), the suite is
224 passing, and eleven criteria are additionally proven against the live account. The three
findings below are all in places a green suite cannot see: a boundary drawn inside a fake, a check
that was described in three parts and built in two, and prose that outlived the design it
describes.

- opened gap-001 [contradicts] spec:"AC-14 skyhook's own share, under 60 seconds" · plan:"D7a"

  `src/adapters/terraform/environment.ts:92-121` — `terraform init` runs inside the window that
  becomes `preparationMs`, which `src/core/deploy.ts:105` counts as **skyhook's** share. Plan D7a
  adjudicates the opposite, in as many words: *"`terraform init`'s provider download falls on the
  **repository's** side of the line … the providers being fetched are the repository's choice,
  their size is the repository's choice, and skyhook controls neither. Counting them against
  skyhook's 60 seconds would make the budget a measure of somebody else's dependency tree."* The
  port's own contract agrees with the plan and not with the code: `src/core/ports.ts:110` defines
  `applyMs` as *"the consuming repo's apply, **and fetching what it needs to run**."*

  So the figure AC-14 reports is not the figure AC-14 defines. Today it is comfortable either way —
  the live run measured 12.2s against a budget of 60 — which is precisely why this is worth
  recording now rather than when a consumer with a heavy provider set pushes it over.

  **Nothing in the suite can catch this, and that is structural.** The AC-14 test
  (`tests/deploy.test.ts:380`) drives a `FakeDeployer` that is *handed* its own
  `{preparationMs, applyMs}` split, so it asserts that the use case subtracts the right number and
  never that the deployer computes the right one. No test in `tests/deploy-adapters.test.ts`
  asserts on timing at all. This is the defect class the plan's own *"what the tests cannot
  prove"* note names: an injected runner proves what skyhook asks for, never where the real
  boundary falls.

  route: change(defect) — but the lane is a genuine question and belongs to a human. Init does two
  things at once: fetching the repository's providers, which the plan puts on the repository, and
  configuring skyhook's own backend, which is skyhook's. Splitting the measurement means splitting
  the command or timing a third bucket; ruling that all of init is skyhook's means amending D7a
  and saying why. Either is defensible; the code silently choosing one is not.

- opened gap-002 [partial] spec:"AC-17 state lands inside the granted location" · plan:"D6a"

  `src/adapters/terraform/environment.ts` — two of plan D6a's three defenses are built and tested.
  `detectStateHijack()` (`:235`) refuses an `*_override.tf` or a foreign `backend` block before
  init; `verifyBackend()` (`:294`) reads Terraform's own record of what it initialized before
  apply. Both are fed planted fixtures, exactly as task 3.7 required.

  **The third does not exist.** D6a: *"After a successful apply, read the expected state key from
  the bucket through skyhook's own store. If nothing is there, fail loudly and name a possible
  orphan."* Task 3.7 repeats it and is checked `[x]`. After `terraform.apply()` succeeds the code
  goes straight to `#readUrl()` and returns `ok` (`:128-141`); `TerraformEnvironment` takes no
  `Store` in its options, so the read is not merely skipped, it was never wired. Nothing anywhere
  in `src/` or `tests/` mentions an orphan check after an apply.

  The two that shipped are the two the plan says can lapse. The denylist is *"only ever correct
  about the tricks it knows"*; the backend record is an internal Terraform working file with no
  compatibility promise, so *"if its shape ever changes the check does not fail, it stops
  checking, which is the worse failure for a defense."* The missing one is the backstop that
  *"depends on nothing but S3 and cannot silently lapse"* — the weakest form of the *no orphans*
  non-negotiable and, by the plan's own argument, the one that must never be unavailable.

  Not classified against the constitution directly: nothing here provisions a resource it cannot
  locate. What is absent is the reporting that would catch the day something else does.

  route: tasks — appended as task 10.1.

- opened gap-003 [contradicts] spec:"AC-19 the narrowing is what skyhook asks for, not what the
  cloud enforces" · constitution:"Preview environments are not isolated from each other, by
  decision"

  Two files state, as the reason the design is safe, a guarantee that `chg-001` withdrew.

  `src/adapters/aws/session-policy.ts:5-7` — *"This is half of what makes 'one pull request cannot
  touch another's environment' a property of the cloud rather than of skyhook's code. The other
  half is the role's trust policy, which lets only a workflow stored on the default branch obtain
  these credentials at all — a pull request cannot edit that workflow, so it cannot arrange to skip
  this."*

  `src/adapters/aws/broker.ts:9-11` — *"The code doing this is not editable from a pull request: it
  arrives from skyhook's own repository at a pinned ref, referenced by a workflow stored on the
  default branch. That is what makes the narrowing structural rather than a promise."*

  Both describe the `job_workflow_ref` trust condition and the trusted reusable workflow, neither
  of which shipped. What did ship is the opposite reading, stated in three places: plan D2 (*"One
  workflow file, **which a pull request may edit**"*), plan D3 (*"Skyhook's code is the boundary
  here, and that is now the stated position … the narrowing holds only for runs that actually go
  through skyhook"*), and AC-19's own closing sentence (*"This is a property of what skyhook asks
  for, not a boundary the cloud enforces against a caller who declines to ask"*).

  **The behavior is right and is not in question.** `sessionPolicyFor()` computes exactly the four
  grants AC-19 now describes, and CloudTrail's record of run 31953505432 was found byte-for-byte
  identical to it. What disagrees with the spec is what these files tell the next reader the
  boundary *is* — and the reader most likely to be misled is someone deciding whether a change to
  this code weakens a cloud-enforced guarantee, when there is none to weaken.

  This feature has been bitten by exactly this twice already, both times found only by reading a
  real failure: the role-assumption message and the deploy-role advice each described the same
  withdrawn design (task 7.1, third pass), and `broker.ts:163-166` now carries the lesson in a
  comment — *"Advice is as shippable as code, and it goes stale the same way."* The comment is
  eleven lines below prose that is stale in the same way.

  route: change(defect) — no spec delta; the spec is correct and the code's account of it is not.
  `chg-003`/task 9.2 is the precedent: a stale comment on a security boundary was corrected in its
  own change rather than folded into unrelated work.

**Swept for unrequested behavior; none found.** The three candidates all trace to something
canonical: the `pull_request_target` refusal (`src/adapters/github/event.ts:39`) is required by the
constitution's *Forks get no environment*; the `identity` and `skyhook-seconds` action outputs are
plan 4.2 and serve AC-14's "the run reports"; the `terraform-version` input is the fix for defect
(d) recorded in task 7.1.

**Observed, deliberately not a gap.** `src/adapters/aws/sts.ts:49-57` documents its session
duration as *"deliberately short … 900 seconds is the minimum AWS accepts"* while the constant is
1800. The plan asks only that the assumption not take the one-hour default (D3), which it does not.
And `session-policy.ts:112-118` says the 2048-character ceiling is checked because *"the builder
checks its own output"*; the builder does not, a test does (`tests/deploy-adapters.test.ts:244`),
which is what task 3.3 actually asked for. Both are prose running slightly ahead of the code
without misdescribing a guarantee.

verdict: open 3 (missing 0, partial 1, contradicts 2, unrequested 0)

## run 2 — 2026-08-16

baseline: spec.md sha256:6845250d7bd5 · plan.md sha256:bd84cc012b76 · tasks.md sha256:3deb886f6de5

All three of run 1's gaps are remediated and closed. The audit read the code and the tests directly
rather than reading `tasks.md`'s claims about them, which matters here: every one of these gaps was
originally a case of an artifact asserting something the code did not do, so an audit that trusted
an artifact would be repeating the error it exists to catch. The suite stands at 231 passing and
the typecheck is clean; neither fact is evidence for anything below, since a green suite is exactly
what all three gaps survived behind.

- closed gap-001 [was contradicts] spec:"AC-14 skyhook's own share, under 60 seconds" · plan:"D7a"

  The criterion moved and the code followed. `AC-14` now names both exclusions (`chg-005`, folded by
  task 11.3), and `DeployTiming` is three durations rather than two: `src/core/ports.ts:107-133`,
  where `initMs` is named after the command and its doc-comment states the residue it also contains
  — skyhook's own backend configuration — rather than claiming a boundary the measurement does not
  hold. That claim was the defect.

  `src/core/deploy.ts:113-114` subtracts `initMs + applyMs` from wall time, and
  `src/adapters/terraform/environment.ts:96-97` computes `preparationMs` as the pre-apply window
  minus `initMs`, so the subtraction property AC-14's closing sentence requires holds at both
  levels: an uninstrumented step lands on skyhook's side rather than vanishing. Every early return
  carries a correctly bucketed timing, including the `catch` (`:179-188`), which charges an
  unclassifiable throw to skyhook — the safe direction for a budget whose failure mode is
  under-reporting.

  Closed on evidence that did not exist at run 1: `tests/deploy-adapters.test.ts:779-844`, three
  tests citing `feat-002/AC-14` and `gap-001` that drive the **real** deployer through a runner
  charging a distinguishable cost per terraform command. Run 1 recorded that no such test could
  exist against the old code and that the defect class was structural. It is the assertion, not the
  fix, that closes this gap for good: `tests/deploy.test.ts:380-427` still proves only that the use
  case subtracts the right fields, because it is handed its split.

- closed gap-002 [was partial] spec:"AC-17 state lands inside the granted location" · plan:"D6a"

  D6a's third defense exists. `src/adapters/terraform/environment.ts:261-282` lists the
  environment's state prefix after a successful apply and refuses the run when the expected key is
  absent, naming a possible orphan; it runs before the address is read. `src/adapters/aws/broker.ts:126-139`
  supplies the store, on the same narrowed session the backend already uses, so no policy moved.

  The `Store` is a **required** constructor option (`environment.ts:61`), not an optional one. That
  is the part that closes the gap rather than merely filling it: run 1's finding was that the
  capability "was never wired", and an optional dependency is the mechanism by which a check stops
  running with nothing to notice it. A construction site that omits it now fails to compile.

  Classified per D8, and checked through the whole path: `skyhook-failed` → `deploy.ts:128`
  `kind: 'failed'` → `src/cli/deploy.ts:93-95` exit **1**, never exit 3. The apply succeeded; what
  failed is skyhook's promise that the result can be found again, and nothing on that path blames
  the repository.

  Tests at `tests/deploy-adapters.test.ts:672-735` cite `feat-002/AC-17` and `gap-002`. The fixture
  is the one task 10.1 demanded — the key reported ABSENT after a successful apply — and the double
  throws on every store method except `list`, so a deployer that grew a second use of the store
  fails rather than passing quietly. A store that cannot answer is reported in its own words rather
  than read as success, which is the failure mode this defense exists to not have.

- closed gap-003 [was contradicts] spec:"AC-19 what skyhook asks for, not what the cloud enforces"

  `src/adapters/aws/session-policy.ts:1-26` and `src/adapters/aws/broker.ts:9-16` no longer offer
  the withdrawn `job_workflow_ref` trust condition or the trusted reusable workflow as the reason
  the design is safe. Both now describe the narrowing as a guardrail against accident rather than a
  boundary the cloud enforces, cite the constitution clause that records this as a decision with its
  cost, and point the reader at `roles.tf` for the floor the cloud does enforce — so AC-19 and AC-7
  stay distinguishable, which is why `chg-001` separated them.

  Held by a test rather than by discipline (`tests/deploy-adapters.test.ts:200-252`), asserting the
  new framing is present AND the withdrawn claims are absent, in both files, read flattened. This
  was the fourth time this feature shipped prose describing a design that never shipped; it is the
  first time the correction cannot silently regress.

**Swept for unrequested behavior; none found.** No new surface arrived with the remediation. Every
action input and output still traces to a plan decision or a recorded fidelity fix, unchanged from
run 1.

**Observed, deliberately not a gap.** `action.yml:56-60` describes the `skyhook-seconds` output as
excluding "your terraform apply" and does not mention the second exclusion `AC-14` now names. The
figure it reports is correct, and no criterion states what this description must say, so it is not
drift by the definition this ledger uses. It is recorded anyway because of its shape: a
user-facing text enumerating one exclusion where the implementation has two is `gap-001` in
miniature, on the surface a maintainer actually reads, and this feature's own lesson —
*"Advice is as shippable as code, and it goes stale the same way"* (`broker.ts`) — was learned from
three separate live failures. Routing it is a judgement call for the owner, not this run's to make.

Run 1's two other observed items persist unchanged and still misdescribe no guarantee:
`src/adapters/aws/sts.ts:55` names 900 seconds where the constant is 1800, and
`session-policy.ts:131` credits the builder with a check a test performs. `od-3` also stands, as
`tasks.md` already records: `product-global.md` names one timing exclusion where `AC-14` names two,
and until that moves through its own pull request the feature criterion is the narrower of the two.

verdict: open 0 (missing 0, partial 0, contradicts 0, unrequested 0)
