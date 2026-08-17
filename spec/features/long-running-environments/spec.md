## Why

The mission makes environments that outlive any pull request first-class, and nothing yet builds
one. This is the feature where a named environment — `staging`, a demo, a production copy — comes
to exist, stays up on its own authority, and dies only when a human says so. It is also where the
protection mark stops being read-only vocabulary: teardown already honors it, but nothing creates
an environment worth marking, and nothing sets the mark. Full problem brief: `research.md`.

Vocabulary, from product-global: a **long-running environment** is an environment that persists
independently of any pull request. Its identity is an operator-chosen name rather than one derived
from a trigger. Everything the deploy action established — record before resource, the commit
recorded only after a successful apply, the URL read from the definition's `url` output and
recorded, settings read from the default branch — applies unchanged; this spec states only what is
different for the long-running kind.

## User stories

- As a repo maintainer, I want a push to my default branch to deploy a named environment that
  stays up after any pull request closes, so that my team has a standing copy (staging, demo) of
  the current mainline.
- As a repo maintainer, I want later pushes to update that environment in place, so that the
  standing copy tracks the default branch without accumulating environments.
- As a repo maintainer, I want nothing automatic — not the pull-request teardown, not the
  scheduled sweep — to ever destroy it, so that "long-running" is a guarantee rather than a hope.
- As a repo maintainer, I want to destroy it with one explicit, deliberate action when its time
  is over, so that the guarantee has an exit that does not require hand-editing cloud resources.
- As the operator of a load-bearing environment, I want to mark it protected so that even the
  deliberate destroy action refuses until I first clear the mark, so a one-step mistake cannot
  take it down.

## Behavior & scenarios

**Identity is chosen, and the two kinds cannot collide.** A long-running environment's name is
supplied by the operator in the run that deploys it; how it is supplied (a workflow input) is the
plan's to fix, and the deploy and the manual teardown take the same name. The ephemeral namespace
is every name beginning `pr-`. That is wider than the names a pull request's deploy actually
derives (`pr-` followed by its pull request number), and the width is the point: the credential
fence that keeps pull-request runs inside their own namespace is drawn at the `pr-` prefix, so a
long-running environment named inside it would sit on the wrong side of the fence. A chosen name
beginning `pr-` is therefore refused before anything is recorded or applied. Eligibility for
automatic teardown is defined only for ephemeral environments (the teardown feature's rule), so
keeping the namespaces apart is what keeps a long-running environment off every automatic destroy
path.

**Only a default-branch run can deploy one.** The credential split the deploy action built is
what enforces this: credentials that reach outside the ephemeral namespace are issued only to a
run triggered from the default branch, and the cloud refuses everyone else. A pull request that
edits workflows to name `staging` still runs as a pull request and is still refused.

**Deliberate destruction is a named, human-triggered act.** Skyhook provides a manually triggered
teardown run that takes an environment name. It is a third starter for the teardown machinery the
teardown feature built — the close event and the sweep were the first two — and it changes nothing
about the sequence: record released, infrastructure destroyed, stored state removed, record
removed, name freed, with skyhook's own credentials narrowed to the one environment named, exactly
as the existing starters narrow theirs. The run qualifies for credentials that reach a
long-running environment only when the human dispatches it against the default branch — the same
trigger-based split that refuses a pull request refuses a dispatch against any other ref, and the
run says which ref it needs rather than failing confusingly. A manual teardown that dies halfway
leaves a `released` record, and a released record is a started teardown whatever kind of
environment it names: the next sweep pass completes it. That is not automatic destruction — the
decision to destroy was the human's; the sweep only finishes what was explicitly started.

**Protection is a latch on deliberate destruction.** A deliberate human action sets or clears the
protection mark on a long-running environment. While the mark is set, even the manual teardown
refuses, loudly, naming the mark — so destroying a protected environment takes two distinct human
acts: clear the mark, then tear down. The mark can be set or cleared only while the record is
`active`; setting one on a `released` record is refused, because releasing was itself the human's
authorization to destroy, and the mark is honored before release, never after — so the sweep's
completion of a started teardown is never blocked by a mark. Updates are not destruction: a
default-branch push still updates a protected environment in place. Pull-request runs cannot write
any protection mark; the cloud refuses them, exactly as the deploy action already established.

- **Scenario: a named environment comes to exist**
  - Given an installed repository whose deploy role has been applied
  - When a default-branch run deploys with the chosen name `staging`
  - Then an environment named `staging` is recorded before anything is applied, its
    infrastructure is applied, its URL is handed back and recorded, and the record is bound to no
    pull request

- **Scenario: the default branch moves and the environment follows**
  - Given `staging` exists
  - When a later default-branch run deploys the same name
  - Then the same environment is updated in place, exactly one record for `staging` exists, and
    the recorded commit becomes the new one only after the apply succeeds

- **Scenario: a name from the wrong namespace**
  - Given a default-branch run
  - When it deploys with a chosen name beginning `pr-`
  - Then the run refuses before recording or applying anything, names the collision, and exits
    non-zero

- **Scenario: the sweep leaves it standing**
  - Given `staging` exists with an `active` record
  - When sweep passes run — including passes that tear down eligible ephemeral environments
  - Then `staging`'s infrastructure and record are untouched, and the sweep does not report it as
    a failure or as eligible

- **Scenario: a pull request reaches for it**
  - Given `staging` exists, and a pull request whose branch edits skyhook's code or workflows to
    name it
  - When the pull-request run executes
  - Then the cloud refuses the credentials for every operation on `staging` — its
    infrastructure, its record, its state, its protection mark

- **Scenario: a human tears it down**
  - Given `staging` exists and carries no protection mark
  - When a human triggers the manual teardown run naming `staging`
  - Then its infrastructure is destroyed, its stored state and record are removed, the run
    reports it destroyed, and a later deploy of the name behaves as a first deploy

- **Scenario: a manual teardown dies halfway**
  - Given a manual teardown of `staging` that moved the record to `released` and was interrupted
  - When the next sweep pass runs
  - Then the sweep completes the destruction and removal, and until it does, claims on the name
    are refused as awaiting teardown

- **Scenario: protection refuses the deliberate destroy**
  - Given `staging` carries a protection mark
  - When a human triggers the manual teardown run naming `staging`
  - Then nothing is destroyed and nothing is removed; the run refuses, names the protection mark,
    and says what a human must do first

- **Scenario: protect, then unprotect, then destroy**
  - Given `staging` exists unprotected
  - When a human action sets its protection mark, a later human action clears it, and a manual
    teardown then names it
  - Then the mark is visible on the record while set, absent after clearing, and the final
    teardown succeeds

- **Scenario: the cap counts it**
  - Given a repository whose environment cap is enabled
  - When environments of both kinds exist
  - Then long-running environments count against the same cap, and a deploy of either kind that
    would exceed it is refused exactly as the deploy action specifies

## Acceptance criteria

- [ ] AC-1: A default-branch run deploying a chosen name results in an environment whose record
      exists before any of the repository's infrastructure is applied, whose infrastructure has
      been applied, and whose URL is handed back by the run and recorded. The record is bound to
      no pull request.
- [ ] AC-2: A second default-branch deploy of the same name updates the environment in place:
      exactly one record for the name, and the recorded commit changes only after a successful
      apply — a failed apply leaves the previously recorded commit unchanged.
- [ ] AC-3: A deploy with a chosen name beginning `pr-` (case-sensitive — `PR-7` is not this
      namespace, see the sharp edges) exits non-zero before recording or applying anything, and
      names the collision with the ephemeral namespace.
- [ ] AC-4: A sweep pass that tears down eligible ephemeral environments in the same repository
      leaves a long-running environment's infrastructure and record untouched, and exits without
      reporting it as a failure.
- [ ] AC-5: The credentials a pull-request-triggered run holds are refused by the cloud for a
      real long-running environment — its infrastructure, its registry record, its stored state,
      and a write to its protection mark. Demonstrated by attempting each with those credentials
      against the deployed environment and observing the cloud refuse.
- [ ] AC-6: A manually triggered teardown naming an unprotected long-running environment,
      dispatched against the default branch, destroys its infrastructure, removes its stored
      state and record, and frees the name: a subsequent deploy of the name behaves as a first
      deploy, inheriting no state, no URL, and no record. The same run dispatched against any
      other ref is refused by the credential split and says which ref it needs.
- [ ] AC-7: A manual teardown interrupted after the record is `released` leaves the name refusing
      claims as awaiting teardown, and the next sweep pass completes the destruction and removal
      — the sweep finishes started teardowns of the long-running kind exactly as it does for the
      ephemeral kind, while never starting one itself. Setting a protection mark on a `released`
      record is refused, and the sweep's completion is never blocked by a mark.
- [ ] AC-8: With the protection mark set, the manual teardown exits non-zero, destroys nothing,
      removes nothing, and names the mark and the required first step. After a human action
      clears the mark, the same teardown succeeds.
- [ ] AC-9: A deliberate human action sets the protection mark and another clears it; the mark's
      state is readable on the environment's record after each. A default-branch push updates a
      protected environment in place without touching the mark.
- [ ] AC-10: With the cap enabled, long-running environments count toward it: at the cap, a
      deploy of a new environment of either kind is refused exactly as the deploy action's cap
      refusal specifies, and a completed manual teardown frees a slot.
- [ ] AC-11: A run triggered by a pull request ignores any environment name it carries: its
      deploy derives the identity from the trigger, and its close-event teardown destroys that
      pull request's own environment and nothing else — a carried `SKYHOOK_ENVIRONMENT` changes
      neither. The manual teardown engages only on a manual dispatch, or on an `--environment`
      flag a human typed explicitly. Demonstrated by a close-event run carrying a name: the pull
      request's own environment is torn down, the carried name's environment is untouched, and
      the run succeeds. *(Added by chg-001, 2026-08-17 — found live: the scaffolded workflow
      exports the name on every event once the push deploy is on.)*
- [ ] AC-12: The protect and unprotect commands accept an ephemeral (`pr-*`) name as well: a
      deliberate default-branch human action sets or clears the mark on a pull-request preview,
      the mark is honored by the close event and the sweep exactly as the teardown feature
      specifies, and pull-request runs still cannot write any mark — the cloud refuses them.
      Marking is not creating: the ephemeral-namespace refusal (AC-3) governs deploys and is
      untouched. *(Added by chg-002, 2026-08-17 — legitimizes the drift ledger's gap-003 on the
      owner's ruling.)*

## Known sharp edges (prototype)

- **Nothing heals a long-running environment.** No monitoring, no automatic redeploy, no drift
  correction. A failed default-branch apply leaves the environment on its previous commit until
  the next push; the run says so loudly, and that is the whole story at prototype depth.
- **Protection guards destruction only.** A protected environment is still updated in place by
  any default-branch push — including a bad one. The mark is a latch on the destroy path, not a
  freeze.
- **Who may trigger the manual teardown is the CI host's question.** Anyone the repository allows
  to trigger a manual workflow run can tear an unprotected environment down. Skyhook adds the
  protection latch but no access control of its own at prototype depth.
- **The sweep still looks the other way.** Beyond finishing started (`released`) teardowns, the
  sweep neither creates, updates, repairs, nor destroys long-running environments. The
  constitution's picture of a sweep that creates and updates protected environments is future
  work, not this feature.
- **Manual teardown inherits teardown's sharp edges.** A destroy that fails — the definition
  unreachable, the cloud refusing — is the teardown feature's loud, retried failure, and getting
  out of it is a human's job.
- **The default branch is the only source.** A long-running environment always runs the default
  branch's definition. Deploying a chosen branch or tag to a long-running environment is out of
  scope.
- **The namespace fence is exact-case.** Only the lowercase `pr-` prefix is refused; `PR-7` is a
  legal long-running name that merely resembles a preview's. Ruled accepted 2026-08-17 (break
  probe P4): the credential fence is case-sensitive and unaffected, and the confusion is the
  operator's to avoid.
- **Marking is idempotent.** Setting a mark that is already set, or clearing one already absent,
  succeeds and changes nothing. Ruled accepted 2026-08-17 (break probe P3).

## Open questions

- Should the mvp let a long-running environment pin something other than the default branch
  (a tag, a release), or is tracking mainline the whole point?
- Does protection eventually need access control of its own (who may clear a mark), or is the CI
  host's control over who can trigger runs enough beyond prototype depth?
