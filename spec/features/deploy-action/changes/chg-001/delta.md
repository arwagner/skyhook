# Delta — deploy-action / chg-001

Operations against this feature's current `spec.md`. Applied at fold, once the change is built.

## ADDED

- **AC-19:** The credentials skyhook obtains for its own registry and state work are narrowed, at
  the moment they are issued, to the single environment the run claimed. Demonstrated by inspecting
  the request skyhook makes: the narrowing names this run's registry key and state prefix and no
  other. This is a property of what skyhook asks for, not a boundary the cloud enforces against a
  caller who declines to ask — a run that reaches a sibling preview environment by mistake is
  prevented; one that sets out to is not, per the constitution's *Preview environments are not
  isolated from each other*.

> **Extended 2026-08-15, after the pre-build check.** The first draft of this delta operated on the
> acceptance criteria and stopped there, leaving four passages of prose above them still describing
> the withdrawn design as fact — one of them asserting the opposite of what now holds. The check
> caught it and held the feature. The prose operations below close that, together with three
> smaller findings from the same run.

## MODIFIED

- **Why — what this feature closes**
  - **Was:** It is also where the pull-request-to-pull-request isolation gap the backing store left
    open is closed, because closing it decides the shape of the workflow this feature has to define
    anyway.
  - **Now:** It is also where the gap the backing store left open between two pull requests stops
    being a gap. Deciding the shape of the calling workflow — which this feature has to do anyway —
    is what settled it, and what it settled is that the boundary is one skyhook does not draw. The
    constitution records the choice and its cost.
  - **Why:** the sentence claimed the opposite outcome of the one reached.

- **User story — what a maintainer wants from the credentials**
  - **Was:** As a repo maintainer, I want the credentials that build an environment issued by a
    workflow a pull request cannot edit, so that a hostile branch cannot reach an environment that
    is not its own.
  - **Now:** As a repo maintainer, I want a pull request's credentials confined to ephemeral
    environments, so that no branch of mine can reach a long-running environment, another
    repository's environment, or any environment's protection mark.
  - **Why:** rewritten rather than deleted. The want is real and survives; what does not survive is
    "an environment that is not its own" stretching to cover a sibling preview.

- **Behavior — where a deploy's credentials come from**
  - **Was:** *Credentials for a deploy are issued by a workflow stored on the consuming repository's
    default branch.* A pull-request-triggered run calls that workflow; it cannot substitute one of
    its own, because what the cloud will trust is pinned to the workflow's identity rather than to
    the branch that triggered it. The credentials such a run receives permit that pull request's
    environment and refuse every other — including other pull requests'. This is what returns the
    "touches only what it owns" guarantee to being structural: previously, what kept one pull
    request out of another's environment was skyhook's own code, which a pull request author can
    edit on their own branch.
  - **Now:** *A pull request's credentials are confined to ephemeral environments, and the cloud
    draws no line inside that.* What a pull-request-triggered run can obtain is fixed by what
    triggered it rather than by any file in the repository, so a branch that edits skyhook's
    workflow gains no wider reach. Within the ephemeral namespace, skyhook asks for credentials
    narrowed to the single environment it claimed — which keeps an honest run out of a sibling's
    environment and does nothing to stop a run that declines to ask. That one preview environment
    is not held apart from another is a decision, recorded in the constitution along with what it
    costs: infrastructure state holds any credential that infrastructure generated for itself, and
    a sibling preview can read it.
  - **Why:** the paragraph described machinery that will not be built and claimed a guarantee the
    constitution now states is not made.

- **Scenario: a pull request reaching for another's environment** — split in two, because the two
  halves now have opposite answers.
  - **Was:** Given a pull request whose branch has edited skyhook's own code, or the workflow that
    calls it, to name a different pull request's environment / When the deploy runs / Then the cloud
    refuses the attempt, rather than skyhook's own code being what stood in the way.
  - **Now — Scenario: a pull request reaching outside its namespace**
    - Given a pull request whose branch has edited skyhook's own code, or the workflow that calls
      it, to name a long-running environment, an environment belonging to another repository, or any
      environment's protection mark
    - When the deploy runs
    - Then the cloud refuses the attempt, rather than skyhook's own code being what stood in the way
  - **Now — Scenario: a pull request reaching for a sibling preview**
    - Given a pull request whose branch has edited the workflow that calls skyhook, so that the run
      never asks for narrowed credentials, and then names another pull request's environment
    - When the deploy runs
    - Then nothing refuses it. This is the decision the constitution records under *Preview
      environments are not isolated from each other*; AC-19 states what does hold, which is that a
      run going through skyhook is narrowed to its own environment before the repository's own code
      runs
  - **Why:** the original asserted a refusal that will not happen. The second scenario is written
    out rather than dropped so the accepted risk is visible in the same place a reader looks for
    what the system does.

- **Known sharp edges (prototype)** — one entry added:
  - **A preview environment can reach a sibling's state.** The credentials a pull-request run can
    obtain reach every `pr-*` environment in the repository, and infrastructure state holds resource
    attributes in the clear — including any credential the infrastructure generated for itself. A
    repository whose previews mint real secrets should know that a sibling preview can read them.
    Everything outside the ephemeral namespace is refused by the cloud and is not affected.
  - **Why:** this list is where a prototype's limits are recorded, and this is now the sharpest one.

- **AC-7**
  - **Was:** The credentials a pull-request-triggered run holds are refused by the cloud for every
    environment except that pull request's own, including other pull requests' environments.
    Demonstrated by attempting an operation against another pull request's environment with those
    credentials and observing the cloud refuse it.
  - **Now:** The credentials a pull-request-triggered run holds are refused by the cloud for every
    environment outside this repository's ephemeral namespace — every long-running environment,
    every environment belonging to another repository, and every environment's protection mark.
    Demonstrated by attempting an operation against each with those credentials and observing the
    cloud refuse it. Sibling preview environments are deliberately excluded from this criterion;
    AC-19 states what holds there instead.
  - **Why:** the removed half was the preview-to-preview boundary the constitution no longer asks
    for. What remains is enforced by the subject claim alone and is unaffected by this change.

## REMOVED

- **AC-8** — *The credentials that reach the apply are obtainable only via a workflow stored on the
  consuming repository's default branch. A workflow altered on a pull request's own branch cannot
  obtain them, and the attempt is refused by the cloud rather than by skyhook's code.*
  Removed because it is the preview-to-preview boundary stated as a requirement, and satisfying it
  costs a trusted-workflow indirection plus a dependency on one cloud's handling of one CI host's
  non-standard token claim. Note that the weaker guarantee a reader might expect this criterion to
  carry — that a pull request editing skyhook's workflows gains no additional privilege — is
  unaffected and needs no criterion of its own: it follows from the subject claim, which names the
  trigger rather than the file, and it is the constitution's *Privilege is split by what triggered
  the run*.

- **Open questions** — two of three removed, having been answered:
  - *"Do the configuration additions, the record's new URL field, and the changed scaffolded workflow
    travel together as one recorded change against the backing store, or separately?"* — answered by
    `chg-007`: together, as one change.
  - *"How does a first-time maintainer get from installed to deploying?"* — answered by plan D12:
    skyhook scaffolds a commented starting point for the deploy role, fails clearly when it is
    absent, and states the order in which things must reach the default branch.
  - The remaining question — whether skyhook should refuse, warn about, or ignore a deploy role
    whose trust is wider than this feature promises — stays open, and is now the more pointed for
    it, since the example role's own trust narrowed (see the task operation below).

## Plan operations

Not part of `spec.md`, recorded here so the fold does not lose them.

- **D2** — collapse to a single scaffolded workflow file on `pull_request`. Remove the caller /
  trusted-workflow split and the "why this shape rather than one file" argument, which reasoned
  entirely from `job_workflow_ref`.
- **D3** — keep both assumptions and keep the inline session policy that narrows skyhook's own to
  one environment, restated as a guardrail rather than a boundary. Remove the `job_workflow_ref`
  trust condition, the January 2026 condition-key research that justified it, and the
  `StringEquals`-over-`StringLike` argument as applied to it. That argument stands unchanged for
  the subject condition, which the backing store already ships.
- **D12** — keep the ordering (the workflow must reach the default branch before a pull request can
  deploy) and reduce it from two files to one.

## Task operations

- **Task 5.2** — the scaffolded deploy-role example lost its `job_workflow_ref` pin along with
  everything else, so the role it demonstrates is assumable by any pull-request job in the
  repository, including one that never runs skyhook and therefore never writes a registry record
  first. The capability is not new — a pull request could always run arbitrary Terraform under that
  role by editing its own definition, and skyhook does not audit it — but the bypass no longer has
  to pass through skyhook at all. The generated file's comment must say what its trust does and does
  not buy, so a maintainer copying it does not assume the trust policy is doing work it is not.

## Sign-off operations

- **hs-2** — retired, not run. The live probe proved AWS honours `job_workflow_ref`; nothing
  shipped now depends on the answer. Resolve it with that reasoning recorded rather than deleting
  it, so the reason the question was asked survives.
- **hs-3** — unaffected. The end-to-end verification against a real account still gates completion,
  minus its AC-8 check.
