## Why
The backing store can remember environments; nothing yet makes one. This is the feature where a
pull request causes a real environment to exist, and where the registry stops being a data
structure with no writers. It is also where the gap the backing store left open between two pull
requests stops being a gap. Deciding the shape of the calling workflow — which this feature has to
do anyway — is what settled it, and what it settled is that the boundary is one skyhook does not
draw. The constitution records the choice and its cost. See `research.md` for the brief.

## User stories
- As a pull request author, I want a running copy of my branch's infrastructure and a link to it,
  so that I can see my change working before it merges.
- As a pull request author, I want pushing again to update the environment I already have, so that
  reviewing a moving branch does not accumulate environments.
- As a repo maintainer, I want to declare in my own repository what permissions a deployment gets,
  so that skyhook never guesses my blast radius.
- As a repo maintainer, I want a pull request's credentials confined to ephemeral environments, so
  that no branch of mine can reach a long-running environment, another repository's environment, or
  any environment's protection mark.
- As a repo maintainer, I want the environment's address handed back to my workflow, so that I
  decide how it reaches the pull request.
- As skyhook's automation, I want every environment recorded before its infrastructure exists, so
  that nothing is ever created that a later sweep cannot find.

## Behavior & scenarios

A **deploy** is one run of skyhook on behalf of one pull request. It derives the environment
identity from the trigger, claims or refreshes that environment's record, deploys the repository's
infrastructure as an isolated copy belonging to that identity, records the outcome, and hands back
the environment's URL. Those steps happen in that order, and the order is the requirement: an
apply that ran before a record existed would produce infrastructure no later sweep could find.

The **deploy role** is the role skyhook assumes to build the consuming repository's own
infrastructure. It is declared by the consuming repository, in the repository's own
infrastructure-as-code, and applied by the same deliberate human step that installs skyhook.
Skyhook obtains its identity from that declaration rather than from a value typed into settings,
and never creates it: skyhook cannot know what permissions another repository's infrastructure
needs, and does not try. This is distinct from the two roles skyhook installs for itself, which
reach skyhook's own data and nothing else.

**A pull request's credentials are confined to ephemeral environments, and the cloud draws no line
inside that.** What a pull-request-triggered run can obtain is fixed by what triggered it rather
than by any file in the repository, so a branch that edits skyhook's workflow gains no wider reach.
Within the ephemeral namespace, skyhook asks for credentials narrowed to the single environment it
claimed — which keeps an honest run out of a sibling's environment and does nothing to stop a run
that declines to ask. That one preview environment is not held apart from another is a decision,
recorded in the constitution along with what it costs: infrastructure state holds any credential
that infrastructure generated for itself, and a sibling preview can read it.

**The environment identity reaches the repository's infrastructure without a contract term.** Each
environment is deployed as an isolated copy of the same definition, named by its identity, and the
repository reads that name to label and namespace its own resources. Skyhook does not require the
repository to declare an input variable, and does not inject one.

**Dynamic artifacts reach the definition without skyhook injecting anything either, and skyhook
records what reached it** (`chg-007`). A deploy often carries values no branch can know in advance
— a container image tag built minutes earlier, an artifact URI. They travel as Terraform's own
`TF_VAR_<name>` environment variables, set by the calling workflow; skyhook injects no variable
and passes no `-var`. Unlike the identity, which needs no declaration at all, these are inputs the
repository's definition must declare a matching `variable` block for — that contract is between
the repository and its own Terraform, and skyhook is not a party to it. What skyhook adds is
memory: the repository declares the names in its settings (`deploy.inputs`, read from the default
branch like every setting), and skyhook reads each declared value at deploy time and records it
against the environment once the apply succeeds — because an artifact reference is part of *what
is deployed*, and the registry is the single source of truth for that. A destroy replays the
recorded values, which is teardown's side of the contract. An undeclared variable still reaches a
deploy — the environment is the workflow's own — but is not recorded, so at destroy time it does
not exist; a variable the definition needs at destroy must be declared.

**The record precedes the resource, and the recorded commit follows it.** A record is written
before any of the repository's infrastructure is applied. The commit recorded as deployed is
updated only once the apply has succeeded, so an environment whose record names an older commit —
or none — is precisely an environment whose last deploy did not land.

**Skyhook must be told where the repository's infrastructure lives.** It cannot infer that, any more
than it can infer the deploy role, so the consuming repository declares it in the settings skyhook
already reads from the default branch. Those settings are the same ones a pull request must not be
able to change from its own branch, and they are read the same way.

**The settings file is seeded, not restored.** Skyhook writes it when a repository has none, and
thereafter leaves it alone. It is the one file in an installation whose content belongs to the
operator rather than to skyhook: two of its settings — the account the installation lives in, and
where the repository keeps its infrastructure — cannot be known when it is first written, because
the installation's own infrastructure has not been applied yet. Every other file skyhook installs is
skyhook's own content and is restored to it, so an installation still converges on a re-run. A
settings file skyhook writes states, in place, every setting the operator must supply and where to
get each one, so filling it in means completing a labelled blank rather than reconstructing a
setting's name from prose. That guarantee is about the file skyhook writes and not about one that
already exists: an installation predating a later setting learns of it when a run refuses by name,
which is the same way it learns of any setting it is missing. A settings file skyhook cannot read is
refused by name at the moment it is read, and the remedy is to delete it and install again — skyhook
does not quietly reconstruct one, because a settings file rebuilt from defaults names a bucket that
does not exist and a cap nobody chose.

**The repository names its environment's address; skyhook reads it.** The infrastructure definition
declares an output called `url`, and skyhook reads that output rather than injecting anything or
inferring an address from resources it does not understand. This is the one thing a consuming
repository declares for skyhook's benefit, and it is read rather than supplied — a definition that
declares no such output still deploys, and the run says the address is unknown.

**Skyhook does not write to the pull request.** The environment's URL is handed back as an output
of the run, and the calling workflow decides what to do with it. Skyhook asks for no permission to
comment and owns no comment format.

- **Scenario: a pull request gets an environment**
  - Given a repository where skyhook is installed and its deploy role has been applied
  - When a pull request is opened
  - Then an environment is recorded, the repository's infrastructure is deployed as a copy
    belonging to that environment, and the run hands back a URL that serves the deployed site to an
    unauthenticated request from the public internet

- **Scenario: pushing again**
  - Given a pull request that already has an environment
  - When another commit is pushed to it
  - Then the same environment is updated in place, no second environment appears, and the commit
    recorded against it becomes the newly pushed one

- **Scenario: an apply that fails**
  - Given a pull request whose infrastructure definition cannot be applied
  - When the deploy runs
  - Then the run fails, saying that the repository's own apply failed rather than reporting a fault
    of skyhook's, the environment's record still exists, and the commit recorded against it is
    unchanged

- **Scenario: two pull requests at once**
  - Given two pull requests open on the same repository
  - When both deploy
  - Then two environments exist with distinct identities and independent infrastructure, and
    neither run reads or writes the other's state

- **Scenario: a pull request reaching outside its namespace**
  - Given a pull request whose branch has edited skyhook's own code, or the workflow that calls it,
    to name a long-running environment, an environment belonging to another repository, or any
    environment's protection mark
  - When the deploy runs
  - Then the cloud refuses the attempt, rather than skyhook's own code being what stood in the way

- **Scenario: a pull request reaching for a sibling preview**
  - Given a pull request whose branch has edited the workflow that calls skyhook, so that the run
    never asks for narrowed credentials, and then names another pull request's environment
  - When the deploy runs
  - Then nothing refuses it. This is the decision the constitution records under *Preview
    environments are not isolated from each other*; AC-19 states what does hold, which is that a run
    going through skyhook is narrowed to its own environment before the repository's own code runs

- **Scenario: closed and reopened**
  - Given a pull request that had an environment and was closed, and whose environment has not been
    torn down
  - When the pull request is reopened and deploys
  - Then it deploys to the environment it had before, and no second environment appears

- **Scenario: at the cap**
  - Given a repository whose active environments have reached the configured environment cap
  - When a further pull request deploys
  - Then the run fails, naming the cap and the current count, and neither records an environment nor
    applies anything

- **Scenario: a fork**
  - Given a pull request opened from a fork
  - When the workflow runs
  - Then skyhook does not deploy, says that fork pull requests get no environment and why, and the
    run does not fail

- **Scenario: installing again after filling the settings in**
  - Given an installed repository whose operator has supplied the account and the infrastructure
    location in the settings file
  - When the maintainer installs again — to pick up a newer skyhook's calling workflow
  - Then the calling workflow and every other file skyhook owns is brought up to date, the settings
    file is left exactly as the operator wrote it, and the run says it was left alone rather than
    listing it as changed

- **Scenario: the deploy role has not been applied yet**
  - Given a repository where skyhook is installed but its deploy role has not been declared or has
    not been applied
  - When a pull request deploys
  - Then the run fails before applying anything, naming what is missing and what the maintainer must
    do

- **Scenario: a deploy carries declared inputs**
  - Given a repository whose settings declare `deploy.inputs: [image_tag]`, and a workflow that
    builds an image and sets `TF_VAR_image_tag` before invoking skyhook
  - When a pull request deploys twice, each push building a new image
  - Then each successful deploy records the value that push supplied, alongside the commit, and
    the record always names the image the standing environment was actually built from

- **Scenario: a declared input is missing**
  - Given a repository whose settings declare an input, and a run whose environment does not set
    the corresponding `TF_VAR_<name>`
  - When the deploy runs
  - Then it is refused before the claim, naming the missing variable — no record is written,
    nothing is applied, and no default silently deploys in the value's place

## Acceptance criteria
- [ ] AC-1: A pull request opened on an installed repository results in an environment whose
      infrastructure has been applied and a URL handed back by the run. An unauthenticated HTTP
      request to that URL from the public internet returns a 200 carrying the deployed content.
- [ ] AC-2: A registry record for the environment exists before any of the consuming repository's
      infrastructure is applied. Demonstrated by a deploy whose apply fails outright: the record
      naming that environment is present afterwards.
- [ ] AC-3: The commit recorded against an environment changes only after a successful apply. A
      failed apply leaves the previously recorded commit — or none, on a first deploy — unchanged.
- [ ] AC-4: A second push to the same pull request leaves exactly one record for that pull request,
      with the same identity as before and the newly pushed commit recorded against it.
- [ ] AC-5: A pull request closed and reopened, whose environment has not been torn down, deploys to
      that same environment. No second record appears.
- [ ] AC-6: Two pull requests deploying concurrently produce two records with distinct identities and
      two independent infrastructure copies, and neither run's state is read or written by the other.
- [ ] AC-7: The credentials a pull-request-triggered run holds are refused by the cloud for every
      environment outside this repository's ephemeral namespace — every long-running environment,
      every environment belonging to another repository, and every environment's protection mark.
      Demonstrated by attempting an operation against each with those credentials and observing the
      cloud refuse it. Sibling preview environments are deliberately excluded from this criterion;
      AC-19 states what holds there instead.
- [ ] AC-9: With the count of active environments at the configured cap, a deploy for a new pull
      request exits non-zero, names both the cap and the current count, creates no record, and
      applies nothing.
- [ ] AC-10: A pull request from a fork completes without deploying and without failing, and states
      that fork pull requests get no environment.
- [ ] AC-11: When the consuming repository's deploy role is absent, the run exits non-zero before
      applying anything and names both what is missing and what the maintainer must do about it.
- [ ] AC-12: The environment identity is readable by the consuming repository's infrastructure
      definition without that definition declaring an input variable skyhook supplies. Whether the
      repository uses it to keep two environments' resources apart is the repository's own
      responsibility, which skyhook makes possible and does not enforce.
- [ ] AC-13: The environment's URL is recorded against its registry record, so that a later reader
      can learn where an environment is without redeploying it.
- [ ] AC-14: The run reports how long skyhook's own share of the deploy took — deriving the
      identity, claiming, selecting the environment's copy, recording, and reporting — and that
      figure is under 60 seconds. Two things are excluded, and both are the consuming repository's:
      applying its infrastructure, and the step in which the infrastructure tool prepares that
      definition beforehand, fetching the providers and modules it declares. Skyhook controls
      neither the size of a repository's dependencies nor how long they take to arrive, and a
      budget counting them would measure somebody else's dependency tree rather than skyhook's
      overhead. One piece of skyhook's own work falls inside that preparation step and is not
      counted with the rest: configuring the backend the state is written through. Selecting this
      environment's own copy of the state is a separate act that happens after that step, and it
      IS counted. The two are named apart because they are easy to confuse and fall on opposite
      sides of the line. The uncounted one is named here rather than left to be discovered, so the
      figure is not read as covering every second skyhook spends — it is bounded by a few requests
      to the store, where what the exclusion buys is unbounded. Of the seconds that do fall to skyhook, none may go missing: time skyhook spends
      that nobody thought to measure is counted against skyhook rather than omitted.
- [ ] AC-15: The run exposes the environment's URL as an output available to the calling workflow,
      and skyhook requests no permission to write to the pull request.
- [ ] AC-16: Every setting this feature adds is read from the consuming repository's default branch.
      A pull request that edits those settings on its own branch does not change how its own deploy
      behaves.
- [ ] AC-17: Each environment's Terraform state lands inside the location the installed roles
      already grant, with no change to those roles' policies. Should the two prove irreconcilable,
      the policy change is a recorded change against the backing store rather than a silent
      widening here.
- [ ] AC-18: A run that fails because the consuming repository's apply failed is distinguishable, in
      its output and its exit status, from a run that failed because skyhook itself could not do its
      job.
- [ ] AC-19: The credentials skyhook obtains for its own registry and state work are narrowed, at the
      moment they are issued, so that every read, write and delete they permit falls inside the
      single environment the run claimed. The constitution's named exceptions are permitted at
      this layer as well, and nothing further: the run may learn the names of the environments this
      repository holds, which is what lets it find its own copy and count the cap; it may read
      the single piece of state the infrastructure tool consults before it can be told which
      environment it is working on; and — the third exception, added by feat-003 for its teardown
      sessions — it may read its own claimed environment's protection mark, which this layer
      narrows to the one environment where the role's grant is repo-wide. Each must appear here as
      well as at the role, because a run holds
      the intersection of the two layers and a grant one makes that the other denies is no grant at
      all. Demonstrated by inspecting the request skyhook makes: the narrowing names this run's
      registry key, this run's state prefix, a listing confined to this repository's own registry and
      state and to that same one key, and a read of that key — with the protection-mark read and
      its listing entry present on the teardown variant of the request and absent on the deploy
      variant, which asks for the original two exceptions alone. A name is not an environment and no
      operation on one is permitted — but the enumeration is granted by a condition on what may be
      listed where every acting grant names a resource, so the narrowing's own refusal covers the
      acting operations alone, and widening that condition is a change no refusal would catch. This
      is a property of what skyhook asks for, not a boundary the cloud enforces against a caller who
      declines to ask — a run that reaches a sibling preview environment by mistake is prevented; one
      that sets out to is not.
- [ ] AC-20: A setting an operator writes into the settings file survives every later install.
      Demonstrated by supplying the account and the infrastructure location in an installed
      repository, installing again, and observing the file byte-identical afterwards, reported as
      left alone rather than as restored, while a file skyhook owns that was edited in the same
      breath is restored in that same run.
- [ ] AC-21: The settings file skyhook writes for a new installation names every setting the
      operator must supply, each with where its value comes from, and is a valid settings file as
      written — the settings that cannot yet be known are present and inert rather than absent, so
      supplying one means replacing a labelled blank.
- [ ] AC-22: A deploy on a repository whose settings declare inputs reads `TF_VAR_<name>` for
      each declared name after the settings are read and before the cap is counted — so before
      the claim, and a mis-wired workflow gets the more actionable refusal whatever the
      environment count is. A declared input that is missing, empty, or in violation of the
      store's value rule (512 characters, no control characters — feat-001/AC-36 owns the rule;
      this feature restates none of it) is refused there, naming the variable: no record is
      written and nothing is applied. Empty means the empty string exactly; a whitespace-only
      value is a value, recorded as supplied. The refusal is distinguishable, in output and exit
      status, from a failure of the repository's own apply. Declared inputs change nothing about
      how values reach Terraform — skyhook passes no `-var`, and a repository that declares none
      deploys exactly as before. (Added by `chg-007`.)
- [ ] AC-23: The recorded input values change only when the recorded commit does: after a
      successful apply, both are updated together to that deploy's values; a failed apply leaves
      both unchanged. An environment's record therefore names the commit and the artifacts of the
      last deploy that landed, or none if none has. (Added by `chg-007`.)

## Known sharp edges (prototype)
- **Nothing tears these environments down.** Teardown on close and the scheduled sweep are separate
  features. Every environment this feature creates persists until one of them exists, so the cap
  will be reached in ordinary use and the refusal at the cap is not a rare path — it is the one a
  prototype meets first.
- **A preview environment can reach a sibling's state.** The credentials a pull-request run can
  obtain reach every `pr-*` environment in the repository, and infrastructure state holds resource
  attributes in the clear — including any credential the infrastructure generated for itself. A
  repository whose previews mint real secrets should know that a sibling preview can read them.
  Everything outside the ephemeral namespace is refused by the cloud and is unaffected.
- **Skyhook does not audit the deploy role.** The consuming repository declares what may assume it.
  A repository that writes a trust policy too broadly weakens its own isolation, and skyhook will
  not notice or object.
- **Two pushes racing on one pull request are not specified.** The state lockfile serializes them,
  but whether the losing run waits, fails, or supersedes the other is left open. Failing loudly and
  failing confusingly are close neighbours here.
- **A half-applied environment is not reconciled.** An apply that dies partway leaves real resources
  behind that only a later successful apply or a teardown resolves. Nothing here retries.
- **Recording the environment's URL extends a record the backing store owns.** So do the settings
  this feature needs. Both are changes to a shipped feature, not new ground here.
- **Reopening cannot be proved end to end here.** Nothing in this feature marks an environment
  released — teardown on close is a separate feature — so the reopen path can be exercised against a
  stand-in and not against a real environment. It is built now because building it later would mean
  changing the deploy path once teardown exists, but it is unproven until then.
- **Whether the test repository's site is publicly reachable depends on the account's
  public-access posture**, which is not skyhook's to set. If it refuses, the reachability half of
  AC-1 weakens to "the resource exists".

## Open questions
- Should skyhook refuse, warn about, or ignore a deploy role whose trust policy is wider than the
  isolation this feature promises? The question sharpened when the scaffolded example's own trust
  narrowed to the pull-request subject alone: that role is assumable by any pull-request job in the
  repository, including one that never runs skyhook.
