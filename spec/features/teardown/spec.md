## Why

Skyhook can create and record environments but nothing destroys them. Every preview environment
lives forever: money leaks until the bill is read, and the environment cap fills with corpses
until authors are refused previews — the deploy action's own spec names this as its first sharp
edge. The constitution's "no orphans" clause promises that teardown is a guarantee, not
best-effort; this feature is where the promise becomes behavior. Full problem brief:
`research.md`, *Problem brief*.

One scope decision was made by a human and is binding here: this single feature carries **both**
halves of the guarantee — the fast path that destroys an environment when its pull request
closes, and the scheduled sweep that destroys whatever the fast path missed. The close event is a
speed-up only; the sweep is what makes cleanup true.

Vocabulary, committed in the brief: an ephemeral environment is **eligible for teardown** when
the pull request it is bound to is closed — whether or not any close event was observed.
Eligibility is derived from the pull request's actual state, never from a record flag a missed
event would have left unset. Protection is not part of eligibility: it is a separate check,
honored before acting on anything eligible — an eligible environment that carries a protection
marker is left standing.

Timing: this feature inherits product-global's reliability guarantee (an eligible, unprotected
environment is destroyed within one sweep interval) and states no timing requirement of its own
at prototype depth. Whether product-global's 60-second overhead budget — written about deploys —
has any reading that touches teardown is carried in the open questions below.

## User stories

- As a repo maintainer, I want a closed pull request's environment destroyed and its record
  removed automatically, so that the spend stops and cleanup needs no watching.
- As a repo maintainer, I want an environment whose close event was missed, interrupted, or
  tampered with destroyed by the next scheduled sweep, so that correctness never depends on a CI
  event firing.
- As a pull request author, I want the environment cap to count standing environments, so that
  closing a pull request frees a slot instead of burning it forever.
- As the operator of a protected environment, I want every automatic path — close-triggered and
  scheduled alike — to refuse to destroy it, so that marking an environment protected means what
  it says.

## Behavior & scenarios

Teardown of one environment always means, in order: the registry record is moved to `released`
(from this moment claims on the name are refused as awaiting teardown), the environment's
infrastructure is destroyed, the environment's stored infrastructure state is removed, and the
record is removed — which is what frees the name. A protection marker is honored before any of
it, so an environment that reaches the destroy step carries none; if one is nonetheless present
at removal time, it is removed with the record, record first — the backing store's contract makes
an interrupted removal leave a claim-refusing record, never a marker waiting to attach itself to
the name's next tenant. The fast path and the sweep both perform this same teardown; they differ
only in what starts them.

- **Scenario: a pull request closes and its environment is torn down (the fast path)**
  - Given an ephemeral environment whose record is `active`, bound to a pull request
  - When that pull request is closed — merged or not — and the close-triggered run executes
  - Then the environment's infrastructure is destroyed, its record and stored state are removed,
    the run reports the environment destroyed, and a subsequent claim of that identity succeeds
    as if the name had never been used

- **Scenario: a pull request closes with no environment to its name**
  - Given a pull request with no environment record (its deploys never ran, or teardown already
    completed)
  - When the close-triggered run executes
  - Then the run succeeds, reporting that there was nothing to tear down, and changes nothing

- **Scenario: a fork pull request closes**
  - Given a pull request from a fork (which was never issued credentials and so never got an
    environment)
  - When the close-triggered run executes
  - Then the run detects the fork and skips with a clear message, without failing and without
    attempting cloud access

- **Scenario: the environment is protected**
  - Given an ephemeral environment that is eligible for teardown and carries a protection marker
  - When the close-triggered run or the sweep encounters it
  - Then the environment is not destroyed, its record is untouched, and the encounter is
    reported visibly as left standing because it is protected — as policy honored, not as a
    failure

- **Scenario: teardown dies halfway and the sweep finishes the job**
  - Given a teardown that moved the record to `released` and was then interrupted — before, during,
    or after destroying infrastructure
  - When the next sweep pass runs
  - Then the sweep completes that teardown without consulting the pull request (a `released`
    record IS a started teardown), and until it does, claims on the name are refused as
    awaiting teardown

- **Scenario: the close event never fired and the sweep repairs it**
  - Given an ephemeral environment whose record is `active` and whose pull request is closed,
    because the close event was missed, suppressed, or its run was killed before releasing the
    record
  - When the next sweep pass runs
  - Then the sweep determines the environment is eligible for teardown from the pull request's
    actual state and tears it down in that pass, reaching the same end state as the fast path

- **Scenario: the pull request was reopened before teardown started**
  - Given an ephemeral environment whose record is `active` and whose pull request was closed and
    then reopened, with no teardown having started
  - When the sweep passes
  - Then the environment is left standing — eligibility is judged at the moment of the pass, and
    an open pull request's environment is not eligible. (The deploy action's AC-5 states this
    same case from the deploy side: reopened and not torn down deploys to the same environment.)

- **Scenario: nothing is eligible**
  - Given no `released` record and no `active` record whose pull request is closed
  - When the sweep passes
  - Then the sweep succeeds, reports that nothing was eligible, and changes nothing

- **Scenario: one destroy fails; the sweep stays loud and keeps going**
  - Given several environments eligible for teardown, one of which cannot be destroyed (the
    cloud refuses, the definition cannot be obtained, the destroy errors partway)
  - When the sweep passes
  - Then every other eligible environment is still processed to completion, the failed
    environment's record remains (refusing claims as awaiting teardown), the sweep run itself
    fails visibly naming the environment and the error, and the next pass retries it — a failed
    destroy is retried on every subsequent pass, each failure visible, with no silent give-up
    state

- **Scenario: the fast path and the sweep race on one environment**
  - Given one environment eligible for teardown
  - When the close-triggered run and a sweep pass act on it concurrently
  - Then the end state is exactly that of a single completed teardown — the infrastructure
    destroyed once, the record removed once — and neither run corrupts the registry or reports a
    spurious failure for having lost the race

- **Scenario: a reopened pull request wins the race against its own teardown**
  - Given a teardown that has moved the record to `released` and has not yet destroyed the
    infrastructure
  - When the pull request is reopened and a deploy reactivates the record before the teardown
    proceeds
  - Then the teardown stops: it destroys nothing, deletes no state, removes no record, and
    reports the environment as reactivated and left standing — the reopened pull request's
    environment stands untouched, and its record remains `active`

- **Scenario: a freed name starts from nothing**
  - Given an identity whose environment was torn down to completion
  - When a new run claims that identity and deploys (for instance, the pull request was reopened
    and pushed)
  - Then the deploy behaves as a first deploy for that identity: it inherits no infrastructure
    state, no URL, and no record from its predecessor

- **Scenario: teardown frees a cap slot**
  - Given a consuming repo at its environment cap, where one environment's pull request has
    closed and its teardown has completed
  - When a new pull request deploys
  - Then the deploy is not refused at the cap: the claim succeeds, in the capacity the completed
    teardown freed

- **Scenario: an installed repository gets teardown without new setup**
  - Given a consuming repo whose workflow skyhook scaffolded before this feature existed
  - When the maintainer runs skyhook's install step again
  - Then the scaffolded workflow is updated to also run on pull request close and on a schedule,
    and the install reports the update — teardown wiring arrives the same way the file arrived

## Acceptance criteria

- [ ] AC-1: Closing a pull request with an `active` environment destroys that environment's
      infrastructure and removes its record and stored state; afterwards, the cloud holds no
      resource of that environment and a claim of the identity succeeds as first use.
- [ ] AC-2: A close-triggered run for a pull request with no environment record exits success,
      stating there was nothing to tear down, and writes nothing.
- [ ] AC-3: A close-triggered run for a fork pull request skips with a clear message, exits
      success, and attempts no cloud access.
- [ ] AC-4: A protected environment survives both automatic paths: a sweep pass and a
      close-triggered run each leave its infrastructure and record untouched and each report it
      visibly as left standing because protected, without failing the run.
- [ ] AC-5: A teardown interrupted after the record is `released` leaves the name refusing claims
      as awaiting teardown, and the next sweep pass completes the destruction and removal without
      consulting the pull request.
- [ ] AC-6: An `active` environment whose pull request is closed but whose close event never ran
      is destroyed by the next sweep pass, reaching the same end state as AC-1.
- [ ] AC-7: A sweep pass leaves standing an `active` environment whose pull request is open at
      the time of the pass — including one that was closed and reopened before any teardown
      started.
- [ ] AC-8: A sweep pass with nothing eligible exits success, reports that nothing was eligible,
      and changes no record and no infrastructure.
- [ ] AC-9: When one environment's destroy fails during a sweep pass, every other eligible
      environment is still torn down to completion in that same pass, the run exits failure
      naming the failed environment and its error, and the following pass retries the failure.
- [ ] AC-10: With the fast path and a sweep pass acting on the same eligible environment
      concurrently, the end state equals a single completed teardown and neither run reports a
      spurious failure for losing the race.
- [ ] AC-11: After a completed teardown, a new deploy of the same identity behaves as a first
      deploy: no inherited infrastructure state, no inherited URL, a fresh record.
- [ ] AC-12: Running skyhook's install step in an already-installed repository updates the
      scaffolded workflow to run on pull request close and on a schedule, reporting the change;
      an installation made after this feature carries that wiring from the start.
- [ ] AC-13: In a consuming repo at its environment cap, after one environment's pull request
      closes and its teardown completes, a new pull request's deploy succeeds where the same
      deploy was refused at the cap before the teardown.
- [ ] AC-14: A teardown whose record is reactivated by a deploy after release — at any point
      before the teardown's own destroy or removal steps — stops without destroying
      infrastructure, deleting state, or removing the record, and reports the environment as
      reactivated and left standing; interleaving a teardown with a reopening deploy at every
      step boundary never ends with the deploy's environment destroyed or its record gone.

## Known sharp edges (prototype)

- **Retry-forever is the whole escalation story.** A destroy that fails every pass is retried
  loudly on every pass, forever. There is no give-up state, no counter, no notification beyond
  the failing runs themselves. An mvp needs an escalation shape; the prototype accepts the noise.
- **The 15-minute cadence is a promise the scheduler may not keep.** GitHub's scheduled workflows
  are known to run late on quiet repositories. product-global owns the cadence guarantee; at
  prototype depth the sweep runs as often as the scheduler honors, and the "within one sweep
  interval" guarantee is measured from when a pass actually runs.
- **The sweep destroys with the restraint in skyhook's code, not the cloud's.** A scheduled run
  triggers from the default branch, where wider credentials are available. The
  protected-environment refusal and the ephemeral-only eligibility rule are skyhook's own logic
  on that path. The constitution accepts this for the sweep; it is still the place a bug costs
  the most, and the which-to-destroy logic is testable against fake adapters precisely so this
  path is the best-tested code in the feature.
- **Destroying needs the definition, and the recorded commit may be gone.** A destroy is expected
  to obtain the deployed definition (the registry records the commit). A commit made unreachable
  — force-push, branch deletion plus garbage collection — makes that obtaining fail; the behavior
  is then AC-9's loud, retried failure, and getting out of it is a human's job. How the
  definition is obtained is the plan's first decision.
- **A reactivation landing mid-destroy degrades to destroy-then-recreate.** The
  reactivation guarantee (AC-14) holds at the teardown's step boundaries: a deploy that takes
  the record back before the destroy starts, or before the record is removed, stops the
  teardown. A reactivation landing while the destroy command itself is executing cannot stop
  it mid-flight; the state lock serializes the two, the deploy then applies from empty state,
  and the outcome is a brief destroy-then-recreate — an availability blip, never a lost record
  or an orphan. Accepted at prototype depth.
- **Long-running environments do not exist yet.** Eligibility is defined only for ephemeral
  environments; the sweep leaves any other record untouched. The sweep's second direction —
  infrastructure standing with no record at all — is deliberately out of scope, parked in the
  backlog (`sweep-second-direction`). *Amended 2026-08-16 by the long-running environments
  feature (feat-006): long-running environments now exist. Eligibility stays ephemeral-only and
  the sweep still leaves any other `active` record untouched, but a `released` record is a
  started teardown whatever kind of environment it names, and the sweep completes it — the
  destroy decision was a human's; the sweep only finishes it.*

## Open questions

- What escalation should mvp add beyond retry-forever-loudly — a give-up state after N failures, a
  notification surface, or both?
- Does a close-triggered run still receive an OIDC token from GitHub Actions? Assumed yes; must be
  proven against the live host before anything depends on it (expected to become a human-verified
  item at plan time).
- Is the practical lateness of GitHub's scheduler acceptable against product-global's 15-minute
  cadence at prototype depth, or does the guarantee's wording need a product-global amendment?
- Does product-global's 60-second overhead budget have any reading that touches teardown?
  product-global states it for deploys and is silent about teardown; this spec states no timing
  requirement of its own rather than asserting the exclusion, and the reading deserves either a
  product-global clarification or an explicit "no budget at prototype" decision.
