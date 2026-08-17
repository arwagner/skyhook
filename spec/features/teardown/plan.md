# Plan — teardown (feat-003)

The spec owns WHAT and WHY; this owns HOW. Inherited and not restated: the constitution's
non-negotiables, `product-global.md`'s cross-cutting constraints, feat-001's plan decisions D1–D8
(the store, the registry, the bootstrap roles) and feat-002's D1–D12 (the composite action, the
broker, workspaces, the two-credential terraform run, the state-hijack defenses). Where this plan
changes something a shipped feature owns, the change is named in D10's table and lands as a
recorded change, never silently.

`spec/engineering.md` does not exist in this workspace, so no shared engineering standard applies.

## Design decisions

### D1 — Two new verbs behind the same action, dispatched by what triggered the run
The surface is the existing composite action plus two CLI verbs: `skyhook teardown` (one
environment, the close fast path) and `skyhook sweep` (all eligible environments). The scaffolded
workflow gains `types: [closed]` on its `pull_request` trigger and an `on: schedule` block
(feat-003/AC-12), and `action.yml` selects the verb from the event —
`schedule` → `sweep`, `pull_request` + `action == 'closed'` → `teardown`, otherwise `deploy` —
as a visible expression in the action manifest, so the reviewed file says what runs when.

*Why one workflow and not a second file:* the spec's install story updates "the scaffolded
workflow"; a second file is a second copy of the permissions block to get wrong, and `init`'s
restore behavior already keeps the one file converged. *Why the verbs stay independently
runnable:* the core logic must be drivable without GitHub Actions (constitution's quality bar),
and a maintainer needs a hand-runnable `sweep` on the day the scheduler misbehaves.

The workflow's permissions gain `pull-requests: read`: the sweep derives eligibility from the
pull request's actual state through the GitHub API (D2), and the scaffolded block's explicit
permissions zero everything it does not name.

### D2 — Eligibility is asked of GitHub, per record, at sweep time
The sweep lists the repository's registry records, filters to ephemeral identities (`pr-*`), and
for each `active` record asks the GitHub API whether that pull request is closed. `released`
records skip the question entirely — a `released` record IS a started teardown and is completed
unconditionally (spec: the sweep finishes the job "without consulting the pull request").

*Why per-record lookups and not a listing of closed pull requests:* the record set is the thing
the sweep exists to reconcile; starting from it means an environment whose pull request was
deleted, or whose number no longer resolves, surfaces as a loud per-environment failure instead
of quietly falling out of a listing. The cap bounds the lookups at five per repository by
default, so N-plus-one is not a real cost here. A new `PullRequestStateSource` port carries the
question; the GitHub adapter answers it with the job's own token.

The fast path never asks: its close event IS the answer, carried in the payload the existing
trigger parser already reads.

**The identity invariant (security B1), stated as a rule the code enforces and a test proves:**
an environment's identity — and everything derived from it: the workspace name, the state
prefix, the session-policy resource ARNs, the pull request number asked of GitHub, the destroy
target — derives **exclusively from the registry object's key**, never from any field inside
the record's JSON body. The pull-request role can write arbitrary content into its own record;
the sweep runs the widest role in the system; a body-derived identity would let one pull
request steer the sweep at another's environment. A dedicated test plants a record at key
`pr-97` whose body claims to be `pr-42` and asserts every action lands on `pr-97`.

### D3 — How the close fast path learns protection (decided 2026-08-16: option (a), `hs-1`)
Before the amendment this decision produced, the constitution had the cloud refuse a
pull-request run **all** access to protection marks — `roles.tf` carried a blanket deny on
`protected/*` — and the spec requires both automatic paths to honor a protection marker. As
shipped then, those two rules collided: the close-triggered run could not read the very marker
it must honor, and the refusal was indistinguishable from the marker being absent.

**Recommended resolution (a): grant the pull-request role read — and only read — of its own
repository's ephemeral protection marks** (`GetObject` on `protected/<repo>/pr-*`, listing at
the same prefix), with skyhook's session policy narrowing the grant to the one claimed
environment's marker as it already narrows everything else. Writes and deletes stay denied by
the cloud. This needs a constitution amendment — the security clause permits "exactly these two
things and nothing further", and this is a third thing: *a run may see whether its own
environment is protected*, which is information ("this environment is load-bearing"), not reach.
The amendment and the `roles.tf` change travel in one main-branch pull request, which restages
every feature's pre-build check (the known cost of touching a shared document).

Alternatives, recorded so the choice is real: **(b)** build no fast path — the sweep, which
holds the default-branch role and reads marks freely, does all destruction within its interval.
Honest, simpler, constitution-clean, but it forfeits the fast path the spec commits to (AC-1)
and makes every close wait up to a sweep interval. **(c)** chain the close event into a
default-branch-context run (`workflow_run`), which acquires the readable role at the price of
the trusted-workflow indirection this project already declined once (`chg-001`). The choice is
a human's; `hs-1` records it, and task 0.1 blocks the fast-path work until it is made.

Until the marker is readable, the fast path fails closed: unable to determine protection, it
destroys nothing and reports why — which is alternative (b)'s behavior arrived at by accident,
and the sweep still cleans up. That is the fallback, not the design — and it means AC-4's
fast-path wording ("left standing because protected") is only literally satisfiable once the
amendment lands; before it, the fast path's message is the fail-closed one.

**The amendment's wording must state the grant's true IAM shape** (security S3): the
cloud-enforced boundary is *repo-wide* — read of every `protected/<repo>/pr-*` mark — narrowed
to the one claimed environment only by skyhook's own session policy, exactly the shape the
registry and state grants already have. The clause says so plainly, the way the
preview-isolation clause states its residual, rather than implying the cloud enforces
"own mark only".

### D4 — Credentials: each path narrows itself, and destruction uses the deploy role
- **Fast path** (close-triggered): exactly feat-002's broker path — skyhook's pull-request role
  under an inline session policy narrowed to this one environment (now also covering its
  protection marker read, per D3a), plus the consuming repository's deploy role for the
  `terraform destroy` itself, since the resources were created under it.
- **Sweep** (schedule-triggered): the run's OIDC subject is the default branch's, so skyhook
  assumes its **default-branch role** — the role that may already reach every environment the
  repository owns. It still narrows itself with a fresh inline session policy **per
  environment** as it iterates, for the same reason feat-002 narrows the deploy: the ordinary
  path should be incapable of touching a sibling even when skyhook's own code is wrong. On this
  path the restraint is skyhook's code plus its self-imposed policy, not the cloud — the spec's
  sharp edge says so, and it is why the which-to-destroy logic is the best-tested code in this
  feature.
- **The deploy role's trust must admit the sweep.** The scaffolded
  `deploy-role.example.tf` names only the pull-request subject today; the sweep presents the
  default-branch subject and would be refused by STS. The example gains the default-branch
  subject as a second `StringEquals` value. Installations that predate this feature carry the
  old trust: the sweep's failed assumption is reported naming the role and the exact subject to
  add — a loud, self-explaining migration, verified live in task 6.1.
  **What the widening costs, named in the file** (security S2): the default-branch subject is
  the already-widest skyhook identity, and this trust lets its holder pivot into the deploy
  role's arbitrary infrastructure permissions. The example's comment states that blast radius
  plainly, not just the mechanics; task 0.2's live session also checks whether GitHub's OIDC
  claims can distinguish a scheduled run from other default-branch runs, and the trust narrows
  to that if the cloud honors it.

### D5 — A destroy runs the definition at the recorded commit
`terraform destroy` needs a definition, not just state. The registry records the commit of the
last successful apply — the definition the standing resources came from — so teardown fetches
**that commit** into a scratch directory outside the repository tree, and runs the destroy
there: same workspace selection, same backend declaration, same two-credential split (backend on
skyhook's narrowed session, providers on the deploy role) as feat-002's D6.

*Why the recorded commit and not the workflow's checkout:* the sweep has no pull request to
check out at all, and the close event's checkout is the merge ref of whatever the branch last
held — not necessarily what was applied. One source for both paths, and it is the one the
registry was designed to hold. GitHub keeps pull-request head commits fetchable after branch
deletion (`refs/pull/<n>/head`); a commit that is nonetheless unfetchable is a loud
per-environment failure (AC-9's class), retried each pass, escalated to a human by being
impossible to miss.

*The checked-out definition is attacker-authored*, same as on deploy — so **the D6a hijack
defenses run on the destroy path too**: refuse override files and foreign backend blocks before
init, verify the initialized backend after init. A destroy whose state was redirected would
report success while destroying nothing — which is why D6 step 4 adds the destroy-side
counterpart of D6a's third check: verify the state is empty before anything is deleted.

*The fetch itself is a new git surface* (security S4): skyhook's own fetch replaces
`actions/checkout`'s safe defaults, so the commit-fetch adapter disables hook execution and
submodule auto-fetch outright, and restricts the fetch to the current repository's own remote.
Stated here so task 3.2 builds it that way rather than discovering it.

A record with **no commit** (a claim whose first apply never landed) has nothing to destroy by
definition — no apply succeeded — but may have half-applied residue. The destroy still runs,
from the pull request's head ref as the only definition there is; an empty state makes it a
no-op, and residue from a died-partway apply is destroyed by it. [Falls out of D7's
idempotence: destroy-on-empty-state succeeds.]

One accepted lag, recorded as an mvp cliff (security S5): the recorded commit is the last
*successful* apply, so a later apply that introduced new resource types and then died before
committing leaves resources the older definition does not describe. Whatever landed in state is
still destroyed — Terraform destroys from state, and D6 step 4 refuses to proceed while state
names anything — so the residue class is resources that never reached state, which the deploy
plan's D6a already bounds. Prototype accepts this; mvp revisits the anchor.

*(Amended by `chg-001`: the scratch checkout's destroy runs with `TF_VAR_<name>` set for each
deploy-input value the record carries — the recorded values, not the current declared list, by
the same reasoning that runs the destroy at the recorded commit rather than at today's. The
values are injected through the child process's environment object, never assembled into a shell
string — the same discipline D4/feat-002-D6 already applies to credentials, stated here because
these are the first attacker-influenced strings skyhook itself places into that environment. A
record carrying none destroys with none set, unchanged — which also covers the no-commit record
above: per feat-001/AC-36 a record with no landed apply has no recorded inputs either, so it
falls into the "none recorded" branch by construction.)*

### D6 — The teardown sequence, and who removes what
One environment's teardown, both paths, in order:

1. **Protection check** — marker present: stop, report left standing, untouched (AC-4).
2. **Release** — move the record `active → released` by compare-and-swap. From here claims are
   refused as awaiting teardown; a CAS loss because the other path already released is
   tolerated and the teardown proceeds (D7).
3. **Re-confirm, then destroy** — re-read the record and confirm it is still the released
   generation this teardown released (or, for a sweep completing someone else's start, still
   `released` at the version it read). A deploy reactivating a reopened pull request's record
   moves the version, and the teardown **aborts with a reactivated-left-standing outcome** —
   destroying nothing (AC-14, security B2). Only then `terraform destroy` at the recorded
   commit (D5).
4. **Verify empty, then delete state** — after a destroy exits 0, read the workspace's state
   through skyhook's own store and confirm it holds no resources before deleting the
   environment's objects under `state/<repo>/<identity>/` (AC-11). A state that still names
   resources after a "successful" destroy is a loud AC-9-class failure, never a proceed: state
   and record deletion after a phantom destroy would mint an orphan with zero registry trace
   (security S1 — the destroy-side counterpart of the deploy plan's D6a third check).
5. **Re-confirm, then remove the record** — the same generation check as step 3, for the same
   reason, then the deletion that frees the name (AC-1, AC-13).

**The marker's disposal splits by path, because the cloud splits it.** The sweep uses the
registry's existing `remove()` — record, then marker, the shipped order. The fast path cannot
delete under `protected/*` even when nothing is there (the deny is unconditional), so it removes
the record alone through a record-only removal added to the registry (D10's table). No orphaned
marker results: a marked environment never reaches step 2 on either path, so the fast path only
ever removes records that have no marker.

### D7 — Every step tolerates having already happened, and that is the whole race story
The spec requires a fast path and a sweep racing on one environment to end as a single completed
teardown (AC-10). No lock coordinates them; instead each step is idempotent or CAS-guarded:

- Release: CAS on the record version; `stale`/already-released → proceed, not fail.
- Destroy: serialized by the state lockfile the backend already uses; the loser then destroys an
  empty state, which is a successful no-op.
- State and record deletion: deletes of the already-deleted succeed.
- A record found already gone at any step: that teardown completed elsewhere; report it done.

The core use case is written as "advance this environment toward gone", not "perform my copy of
the procedure" — re-entrant from any interruption point, which is also exactly what makes the
sweep able to finish a half-done fast path (AC-5) with no special resume logic.

**Except against a deploy, where losing the race must mean stopping, not advancing.** A
teardown races two distinct opponents. Another teardown is a peer: whoever advances, the
environment ends gone, so idempotence is the whole answer (AC-10). A deploy reactivating a
reopened pull request's record is an adversary in the scheduling sense: if the teardown
advances anyway it destroys a live, wanted environment and erases its record. The generation
re-checks in D6 steps 3 and 5 are what tells the two apart — a record that moved because a
teardown peer advanced it reads as still-gone or still-released; one a deploy took back reads
as `active` at a newer version, and the teardown stops (AC-14). The fake-store interleaving
matrix covers both opponents at every step boundary.

### D8 — Sweep failure semantics: keep going, then fail loudly
The sweep processes every eligible environment independently, collecting per-environment
outcomes; one failed destroy never stops the others (AC-9). At the end it prints one report —
destroyed / left standing (protected) / left standing (reactivated) / failed, with the error
per failure — and exits by
feat-002's D8 scheme, extended one notch: `0` when nothing failed (including "nothing
eligible"), `3` when the only failures were the consuming repository's own destroys, `1` when
skyhook itself could not do its job (cannot list the registry, cannot assume a role). A failed
environment's record stays `released`, so the next pass retries it by construction — retry
forever, loudly, is the prototype's stated escalation policy. `skyhook teardown` uses the same
codes for its one environment.

### D9 — What each path does NOT do
- The fast path does not consult the GitHub API (its event is the fact) and does not iterate
  other environments — one close, one environment.
- The sweep does not read `active` records' state through the pull-request lens of feat-002's
  cap counting — it holds the default-branch role and reads records outright (`countActive`'s
  cousin problem does not exist on this path).
- Neither path touches a non-`pr-*` record (long-running environments are out of scope), and
  neither collects marker-without-record garbage — under D6 this feature never creates one, and
  inventing a collector here would be behavior the spec does not state.
- Neither path posts to the pull request; the run log and exit status are the whole report, per
  the deploy action's precedent.

### D10 — Changes to shipped features, as recorded changes
| Change | Where | Why it belongs there |
| --- | --- | --- |
| Pull-request role gains read-only on `protected/<repo>/pr-*`; constitution gains the third named exception | `terraform/bootstrap/roles.tf`, `spec/constitution.md` | feat-001 owns the roles; the constitution owns the exception list. One main-branch PR, gated on `hs-1` (D3) |
| Registry gains a record-only removal beside `remove()` | `src/core/registry.ts` | feat-001 owns the registry contract; the fast path cannot touch `protected/*` (D6) |
| Session policy optionally includes the environment's protection-marker read | `src/adapters/aws/session-policy.ts` | feat-002 owns the narrowing; it must cover what D3a grants or the intersection grants nothing |
| `action.yml` dispatches by event | `action.yml` | feat-002 owns the action surface (D1) |
| Scaffolded workflow: `closed` type, `schedule` trigger, `pull-requests: read` | `src/cli/init.ts` | feat-002 owns every file `init` scaffolds (AC-12) |
| Deploy-role example trust adds the default-branch subject | `terraform/deploy-role.example.tf` | feat-002 scaffolds it; the sweep must assume it (D4) |
| Backing store AC-17's "and nothing else outside the namespace" gains the third exception | `spec/features/backing-store/spec.md` | the amendment falsifies the sentence as written; spec and constitution move in the same PR (task 5.2) |
| Deploy action AC-19's "two named exceptions... and nothing further" becomes three | `spec/features/deploy-action/spec.md` | same PR, same reason |

Each lands as a change entry against the owning feature when built, per the workflow this
project already used for `chg-007`.

## Verification approach

Tests live in `tests/**/*.test.ts` (already declared). Every test cites its trace token, e.g.
`test('feat-003/AC-6 the sweep destroys what the missed close event left', …)`. Core seams:
`teardownEnvironment()` in `src/core/teardown.ts` and `sweepEnvironments()` in
`src/core/sweep.ts`, driven with fake stores, fake destroyers, a fake pull-request source, and
feat-001's fake-store CAS semantics. Live truths get one `[H]` session (task 6.1), the same
shape as feat-001's 6.2 and feat-002's 7.1.

| Criterion | Seam | How |
| --- | --- | --- |
| AC-1 | `teardownEnvironment()`; live **(manual, 6.1)** | fakes: assert the D6 order — release before destroy, destroy before state delete, record delete last — and that a subsequent claim on the fake store succeeds fresh. Live: close a real pull request, watch the environment die, claim the name |
| AC-2 | `teardownEnvironment()` + `runTeardown()` | absent record → a nothing-to-do outcome, zero store writes, exit 0, message says so |
| AC-3 | `parseTrigger()` + `runTeardown()` | fork close payload → skip outcome, exit 0, no store or STS calls |
| AC-4 | `teardownEnvironment()` / `sweepEnvironments()` | fake marker present: destroyer never called, record untouched, outcome reported as left standing protected; the sweep run containing it still exits 0 |
| AC-5 | `teardownEnvironment()` via `sweepEnvironments()` | fake `released` record: completed with the fake pull-request source asserting it was never asked; interruption points (after release, after destroy, after state delete) each resumed to completion |
| AC-6 | `sweepEnvironments()` | `active` record + fake source says closed → full D6 sequence, end state identical to AC-1's fakes |
| AC-7 | `sweepEnvironments()` | `active` record + fake source says open → zero writes for that environment |
| AC-8 | `sweepEnvironments()` + `runSweep()` | empty and all-open registries → exit 0, "nothing eligible", no writes |
| AC-9 | `sweepEnvironments()` + `runSweep()` | three eligible, middle destroyer fails → two completed, failed record still `released`, exit 3, message names environment and error; a second pass with a healed destroyer completes it |
| AC-10 | `teardownEnvironment()` + `sweepEnvironments()` over one fake store | interleave the two flows step-by-step at every boundary: end state is one completed teardown, no step of either flow surfaces a raced error as failure. Live: the state lockfile serializes the real destroys (noted, not separately proven) |
| AC-14 | `teardownEnvironment()` + `deployEnvironment()` over one fake store | the second interleaving matrix: a deploy reactivates the released record at every teardown step boundary; assert the teardown aborts with the reactivated outcome, the record stays `active`, and no destroy/state-delete/record-delete lands after the reactivation. Also the B1 test: a record at key `pr-97` whose body claims `pr-42` is acted on as `pr-97` |
| AC-11 | compose `teardownEnvironment()` then `deployEnvironment()`; live **(manual, 6.1)** | after teardown on fakes, a deploy claims fresh: new record, null URL, no state objects under the identity's prefix |
| AC-12 | `init()` on a temp tree + `action.yml` | scaffolded workflow YAML contains `closed`, `schedule`, `pull-requests: read`; re-running `init` over a pre-feature tree updates the workflow and reports it (the feat-002/AC-20 temp-tree harness, reused); parse `action.yml` and assert the dispatch expression maps the three events to the three verbs |
| AC-13 | compose cap check + teardown on fakes | registry at the cap refuses a new claim; teardown one; the same claim succeeds |

**What the fakes cannot prove**, named per the house rule: that a closed pull-request event is
issued an OIDC token at all, and that STS honors the deploy role's widened trust from a
scheduled run — task 0.2's pre-build probes (`hs-2`); that `terraform destroy` at the recorded
commit really empties the account, and that the protection-marker read lands inside the
narrowed session once D3a's grant exists — task 6.1's end-to-end session (`hs-3`). Nothing
marks this feature done without both.

## Task breakdown

See `tasks.md`.

## Deviations

None from the constitution. D3's resolution **amended** it — a third named exception to the
pull-request refusal list — with the human's approval recorded on `hs-1` (decided 2026-08-16,
option (a)) and the amendment landed the same day via task 5.2, together with the `roles.tf`
grant and the two sibling-spec updates (D10). The alternatives considered — (b) sweep-only
destruction, (c) `workflow_run` indirection — are recorded on `hs-1` as history, not as live
branches. Until 5.2's IAM change is applied to a live account (the bootstrap re-applied), an
installed fast path still fails closed at runtime, which is the designed interim, not a
deviation.
