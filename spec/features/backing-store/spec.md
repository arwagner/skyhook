## Why
Everything else in skyhook reads or writes this. Until there is a durable record of which
environments exist and what is deployed to each, the scheduled sweep has nothing to reconcile
against, the environment cap has nothing to count, and the dashboard has nothing to show. See
`research.md` for the full brief.

## User stories
- As a repo maintainer, I want to run one command that sets up everything skyhook needs, so that I
  can start deploying environments without running a setup project first.
- As a repo maintainer, I want to re-run that command safely, so that a repeated or half-finished
  installation converges instead of breaking.
- As a repo maintainer, I want skyhook's settings to live in my repository, so that they are
  reviewed like any other code.
- As skyhook's automation, I want to claim an environment identity atomically, so that two
  concurrent runs never act on the same environment.
- As skyhook's automation, I want a durable record of every environment and the code deployed to
  it, so that the sweep can tell what should exist from what does.
- As a repo maintainer, I want to remove everything skyhook put in my cloud account with one
  command, so that trying skyhook out does not leave me picking resources out of a console
  afterwards.

## Behavior & scenarios

An **environment identity** names one environment (`staging`, `pr-482`, `slot-2`).
Claiming takes one of two forms, and both are atomic. A **fresh claim** creates the record
and is mutual exclusion on the name: it succeeds only if no record exists. A **pool claim**
— available only where a repository has enabled pooling (feat-007) — takes over an
environment that already exists: one conditional transition of a warm slot's record from
`warm` to `active`, recording the **claimant** pull request; it succeeds only if the record
was still `warm` at that version. Identities are unique **within a repository**, not
globally — two repositories may each have a `staging`.

**Where the identity comes from depends on who is asking.** A run triggered by a pull request does
not choose its identity: it is derived from the trigger, so such a run can only ever name its own
environment. Only a run from the default branch, or a deliberate human action, may name an
arbitrary identity. The credentials the run holds carry most of this restriction: the cloud refuses
such a run any long-running environment, any other repository's environment, and any protection
mark, whatever skyhook's own code does. Two things outside the ephemeral namespace it does permit,
and both are named rather than implied: enumerating the *names* of the repository's environments,
which is how a run finds its own and counts the cap, and reading the one state key the
infrastructure tool insists on consulting before it can be told which environment it is working on
(AC-29). It does not separate one pull request from another — there, skyhook's own code is what
stands in the way. See *Known sharp edges*.

**How the cloud recognizes which trigger a run came from is discovered, not assumed.** The split
above rests on the OIDC subject a run presents, and the shape of that subject is the organization's
choice rather than skyhook's: some organizations qualify it with immutable numeric ids, and a policy
written against the plain repository name refuses every run in one of those. So the bootstrap asks
the CI host which form applies before writing a policy that names it, and says which form it used —
the failure mode of a wrong answer is a refusal that explains nothing. What it learns is fixed into
the installation when it is applied, and every way of getting it wrong fails closed: a wrong form
matches no subject at all, costing an installation that does not work rather than one that trusts too
much.

This prototype assumes **one installation per repository**. The registry nonetheless records which
repository each environment belongs to, so that a later move to installations shared across
repositories does not require migrating live data.

An environment record is in exactly one **state**: `warm` (skyhook's own, built or being
built ahead of any pull request, claimable once the record carries a deployed commit),
`active` (in use, must not be destroyed), or `released` (eligible for teardown). Only
pooling (feat-007) creates `warm` records; an installation with pooling off never holds one.

**Protection is stored apart from the record**, not as a field within it. A protected environment
may be `released` and still must not be destroyed automatically. Protection lives separately
because of who may set it: no pull-request-triggered run ever marks an environment protected, so
the mark does not belong in the one file such a run is allowed to write. Keeping it separate is
what lets the credentials refuse the write, rather than leaving skyhook's own code as the only
thing standing in the way.

**A record exists for exactly as long as its environment does.** Teardown deletes the record and
its protection marker together, and that deletion is what frees the name. A protection marker with
no matching record is itself garbage to be collected — left behind, it would silently attach to the
next environment claiming that name, which would then never be cleaned up automatically. So an identity whose record still exists — in any state —
cannot be *freshly* claimed: a `released` environment has not been torn down yet, and handing
its name to a new run while the old infrastructure still stands invites two runs acting on one
environment. The pool claim is the sole exception, and it is not a counterexample: it creates
nothing and hands over nothing torn-down — it transitions an existing `warm` record, whose
environment stands ready precisely so a run can take it over, to `active` without deletion.

- **Scenario: first installation**
  - Given a repository with no skyhook installation
  - When the maintainer runs the init command
  - Then a `.skyhook/` directory is created holding the configuration file and the workflow needed
    to call skyhook, and the bootstrap infrastructure definition is written for the maintainer to
    review and apply — no cloud resource is created without their explicit apply

- **Scenario: installation re-run**
  - Given a repository where skyhook is already installed and correct
  - When the maintainer runs the init command again
  - Then the installation is left unchanged, no duplicate resource is created, and the command
    reports success rather than an error

- **Scenario: applying the bootstrap**
  - Given a repository where skyhook is installed but nothing exists in the cloud account
  - When the maintainer runs the bootstrap command
  - Then skyhook reads the settings from the configuration, works out whether the account already
    holds a trust anchor, shows what it will create, and waits — nothing is created until the
    maintainer agrees, and declining leaves the account untouched

- **Scenario: the installation outlives the working tree**
  - Given a repository whose bootstrap has been applied, and whose local working files are then
    deleted
  - When the maintainer re-installs and runs the bootstrap command again
  - Then skyhook finds the existing state, reports that nothing needs to change, and manages the
    resources it created before — rather than trying to create a second copy of them

- **Scenario: removing an installation while an environment still exists**
  - Given a repository whose registry still records at least one environment
  - When the maintainer runs the removal command, even confirming it
  - Then skyhook refuses, names the environments it found, explains that removing the registry
    would leave infrastructure nobody can find, and changes nothing at all

- **Scenario: registry missing at run time**
  - Given the storage bucket exists but holds no registry yet
  - When skyhook runs
  - Then it initializes an empty registry inside the bucket and proceeds, without a human step

- **Scenario: the storage bucket itself is missing**
  - Given the bucket the bootstrap definition declares does not exist
  - When skyhook runs
  - Then it stops with a message naming the missing bucket and telling the operator to apply the
    bootstrap definition — it does not create the bucket, because the bootstrap definition owns it

- **Scenario: a pull request asks for another environment's name**
  - Given a run triggered by a pull request
  - When the workflow that invokes skyhook passes an identity other than the one derived from the
    trigger
  - Then the request is refused. If skyhook's own check were bypassed, the credentials the run holds
    would still refuse every long-running environment, every other repository, and every protection
    mark — but would not, on their own, refuse another pull request's environment

- **Scenario: claiming a name that is released but still standing**
  - Given an environment whose record is `released` and whose infrastructure the sweep has not yet
    destroyed
  - When a run claims that identity
  - Then the claim is refused with a result that says the name is awaiting teardown, distinct from
    the result for a name that is actively held

- **Scenario: two runs claim the same environment identity**
  - Given an environment identity that no run currently holds
  - When two runs attempt to claim it at the same time
  - Then at most one claim succeeds, and any other is refused with a distinct, non-crashing result
    that says the identity is already held — or, if the storage layer could not resolve the attempt
    at all, one that says so and invites a retry

- **Scenario: concurrent registry writes**
  - Given two runs updating the registry at the same time
  - When both writes are attempted
  - Then one succeeds and the other is told it lost — neither is silently discarded

- **Scenario: configuration is read**
  - Given a repository whose `.skyhook/` configuration sets an environment cap
  - When skyhook needs that setting during a run triggered by a pull request
  - Then it reads the configuration from the repository's default branch

## Acceptance criteria
- [ ] AC-1: Running init in a repository with no prior installation creates `.skyhook/` containing
      a configuration file, the workflow that calls skyhook, a starting point for the role the
      repository must itself declare, and a statement of which of its files belong in version
      control, and writes the bootstrap infrastructure definition without applying it.
- [ ] AC-2: Running init a second time against a complete installation exits successfully and
      leaves every file it manages byte-identical.
- [ ] AC-3: Applying the bootstrap definition to a cloud account results in an OIDC trust anchor,
      the roles skyhook assumes, and one storage bucket. The trust anchor is created where none
      exists and adopted where one does, because a cloud account admits only one trust anchor per
      identity provider. Applying it a second time reports no changes. (manual)
- [ ] AC-4: When the storage bucket exists but contains no registry, a skyhook run initializes an
      empty registry within it and proceeds, with no human intervention. When the bucket itself is
      absent, the run stops with a message naming the bucket and directing the operator to the
      bootstrap definition, and creates nothing.
- [ ] AC-5: No two attempts to claim the same environment identity both succeed, however many run
      at once. A losing attempt returns a result distinguishable from a failure of any other kind.
      An attempt the storage layer cannot resolve — because it kept colliding with other writers —
      is reported as unresolved rather than as a refusal, so a caller retries instead of concluding
      the identity is taken. Under contention it is therefore possible for a round of concurrent
      attempts to produce no winner; what is never possible is two.
- [ ] AC-6: A registry write made against a stale read is refused rather than applied. No write
      that was refused leaves any trace in the stored record.
- [ ] AC-7: Each managed environment's Terraform state is stored under a key unique to that
      environment, and two environments never share a state key.
- [ ] AC-8: Registry data is encrypted at rest. The storage the registry lives in denies public
      access, refuses unencrypted transport, and grants access only by policy — per-object access
      control lists are disabled, so there is one mechanism to read and one place to read it.
- [ ] AC-9: Configuration used by a run triggered from a pull request is read from the repository's
      default branch, not from the pull request's own branch.
- [ ] AC-10: The store exposes the configured cap, the count of environments currently in the
      `active` state, and the count of environments a repository holds at all. The last of those is
      obtained without reading any environment's record, so a caller whose credentials reach only
      its own environment can still enforce the cap. A record exists for exactly as long as its
      environment does, so that count is the number of environments skyhook is accountable for —
      which is the number a cap is about. It is deliberately not the number *standing*: a record is
      written before the infrastructure it describes exists, so the count can exceed what was built.
      Over-counting is the safe direction for a cap, and the window is the same one that makes
      teardown a guarantee.
- [ ] AC-11: No long-lived cloud credential is written to `.skyhook/`, to the registry, or to any
      file the init command produces.
- [ ] AC-12: Every registry record identifies the repository it belongs to, and two environments
      in different repositories may hold the same identity without collision.
- [ ] AC-13: Running init against a partial or altered installation — a missing file, a missing
      cloud resource, a hand-edited managed file — restores it to the correct state and reports
      what it changed, rather than failing or creating a duplicate alongside it.
- [ ] AC-14: A run triggered by a pull request derives its environment identity from the trigger
      and refuses any identity supplied to it. Skyhook's own code enforces this. The credentials
      such a run holds additionally confine it to the ephemeral namespace, so a bypass of skyhook's
      validation still cannot reach a long-running environment, another repository, or any
      protection mark. Within that namespace the credentials do not distinguish one pull request
      from another: a run that bypasses skyhook's validation could reach a different pull request's
      environment. That is a recorded decision rather than a gap awaiting a fix, and *Known sharp
      edges* states what it costs. With pooling enabled, what the trigger derives is the run's
      claimant identity; the environment the run acts on may be a warm slot whose own identity
      was fixed when the slot was built, and the record's claimant — never the slot's name —
      says which pull request that is (chg-012).
- [ ] AC-15: Protection is stored outside the environment record, and a run triggered by a pull
      request cannot mark an environment protected. The attempt is refused by the credentials the
      run holds, not only by skyhook's code, and nothing stored changes.
- [ ] AC-16: A fresh claim of an identity whose record exists is refused, whether that record is
      `warm`, `active`, or `released`, and the three refusals are distinguishable: held (an
      active tenant), awaiting teardown (a released one), and reserved for the pool (a warm
      slot — reachable only by a default-branch or manual claim of a colliding name, since
      pull-request runs never freshly claim slot names; the case exists so the collision is
      named rather than mistaken for either other refusal). A name becomes freshly claimable
      only once its record is deleted. The pool claim is not that refused case: it never
      creates a record, and it succeeds precisely and only on a claimable `warm` record
      (chg-012).
- [ ] AC-17: The role a pull-request-triggered run assumes is refused by the cloud for every
      operation on an environment outside the ephemeral namespace — every long-running environment,
      every environment in another repository, and every write to the protection mark of any
      environment whatsoever. This holds when skyhook's own validation is bypassed. It does permit
      **enumerating the names** of the environments a repository holds, which is what lets a run
      select its own copy and count the cap; a name is not an environment, and no operation on one
      is permitted. It also permits reading the single state key described in AC-29, and — the
      constitution's third named exception, added by feat-003 — **reading the protection marks of
      this repository's own ephemeral environments**, because teardown must honor a mark it can
      see and a refusal to read is indistinguishable from absence; a long-running environment's
      mark stays unreadable, and setting or clearing any mark stays refused. Nothing else outside
      the namespace. Narrowing the credentials a run actually holds to the single
      environment it claimed is done by skyhook when it asks for them, and is that feature's
      criterion — a guardrail against a run reaching a sibling by accident, not a boundary against
      one that means to. The credentials a default-branch run holds are likewise refused for
      anything outside the repository they belong to, so neither role can reach an installation
      that is not its own.
- [ ] AC-18: The bootstrap definition, and the output of the init command, both state plainly where
      the boundary around a pull-request run is drawn: everything outside the ephemeral namespace is
      refused by the cloud, and within it one preview environment is not held apart from another.
      What an operator must not get wrong — that a sibling preview can read this one's
      infrastructure state, including any credential that infrastructure generated for itself — is
      written where they read it, not only in the specification.
- [ ] AC-19: Skyhook never modifies an OIDC trust anchor it did not create. Where one already
      exists in the target account, the bootstrap reads it and points skyhook's own roles at it,
      leaving its configuration — including its thumbprints and client IDs — untouched, so
      workloads already trusting it are unaffected.
- [ ] AC-20: An environment identity is at most 63 characters. A longer one is refused when it is
      supplied, not when it is first used, so the refusal names the identity rather than surfacing
      later as a failure somewhere downstream.
- [ ] AC-21: A single command applies the bootstrap definition. It reads the storage settings from
      the repository's own configuration rather than asking the operator to retype them,
      determines whether the account already holds a trust anchor for the identity provider, shows
      the operator what will change, and applies only after they confirm. Without that
      confirmation it changes nothing.
- [ ] AC-22: The command determines for itself whether a trust anchor already exists, rather than
      asking the operator to know. Where one does, it adopts it; where none does, it creates one.
      An operator who has never seen an account's identity-provider configuration can still
      install skyhook correctly.
- [ ] AC-23: After the bootstrap has been applied once, the state describing what it created lives
      in skyhook's own storage rather than in the maintainer's working tree. Deleting or
      re-cloning the repository does not strand the resources it created: a later run finds the
      state where it left it. The maintainer is never asked to commit that state to version
      control.
- [ ] AC-24: No role skyhook installs can read or write the state describing skyhook's own
      permissions. That state is reachable only by the credentials a maintainer uses to apply the
      bootstrap, so a compromise of anything skyhook runs cannot read the shape of its own
      boundary or rewrite it.
- [ ] AC-25: Removal refuses while any environment is still recorded in the registry, and names the
      environments it found. The registry is the only record of what skyhook has provisioned, so
      destroying it first would leave infrastructure standing that nothing can locate or attribute.
      No confirmation, flag, or force option overrides this.
- [ ] AC-26: Removal destroys what skyhook created and nothing else. A trust anchor skyhook adopted
      rather than created is never destroyed; one skyhook created is, unless the operator asks for
      it to be left behind because other workloads have since come to rely on it. Which case
      applies is read from what skyhook actually manages, not asked of the operator.
- [ ] AC-27: Removal cannot strand what it has not yet removed. The state describing skyhook's
      infrastructure is stored inside the storage being removed, so it is taken out first; if
      removal fails part-way, the state remains locally and the operator is told where it is and
      that it is now the only record of what still exists.
- [ ] AC-28: Every environment record can carry the address at which that environment is reachable,
      and carries none before one is known. A later reader learns where an environment is without
      redeploying it.
- [ ] AC-29: A pull-request run may read the single state key the infrastructure tool consults
      before it can be told which environment it is working on, and nothing else outside the
      ephemeral namespace. That key holds nothing skyhook wrote: skyhook never uses the default
      workspace and never writes it. The permission is a read and never a write, it is one object
      rather than a prefix, and it is also listable — a read of an object that has never existed is
      refused as *forbidden* rather than reported as *missing* unless the caller could also have
      listed it, and the infrastructure tool cannot tell those two answers apart. Every layer that
      narrows a run's reach permits exactly this same key, since a grant the run's own credentials
      then deny would be no grant at all.
- [ ] AC-30: Init writes everything a repository needs to deploy and applies none of it: the
      workflow a pull request triggers, and a starting point for the role the repository itself
      must declare. It states the order in which these must reach the default branch, because a
      pull request opened before they arrive does nothing at all, with nothing to explain why.
- [ ] AC-31: Configuration carries what a deploy needs: which cloud account holds the installation,
      and where the repository's own infrastructure definition lives. An unrecognized setting
      remains an error rather than a silent default. These settings are absent-tolerant for every
      command that does not deploy, so an installation made before they existed keeps working
      unchanged.
- [ ] AC-32: The bootstrap determines for itself which form of OIDC subject a run in this repository
      will present, rather than assuming one or asking the operator to know. The trust policies it
      writes name the form the CI host reports. Where the host will not disclose it — the setting is
      readable only by a repository administrator — skyhook uses the conventional form, which is
      correct wherever that form applies and is announced rather than assumed (AC-33) wherever it
      might not be. So an operator who has never heard of the setting installs skyhook correctly
      without knowing it exists, and an operator who cannot read it is told what was assumed on
      their behalf.
- [ ] AC-33: The operator is told which form of subject was used, and whether the CI host stated it
      or skyhook fell back to the conventional one, before anything is applied. The two ways the
      question can go unanswered are treated differently and both are visible: a refusal to disclose
      the setting is a fallback, announced; an unreachable or unintelligible answer stops the
      bootstrap with that named as the cause, rather than writing a policy that would refuse every
      run for a reason nothing reports.
- [ ] AC-34: Whatever the bootstrap learns about the subject's form is fixed into the installation at
      the moment it is applied. A later change to the repository's OIDC settings can stop runs from
      being able to assume a role; it can never widen what the roles trust. Every way the question
      can be answered wrongly — a refusal, a stale answer, a mistyped one — yields credentials that
      reach less than intended, never more.
- [ ] AC-35: Configuration can declare, under `deploy.inputs`, the names of the Terraform input
      variables a deploy carries — an explicit list, optional, at most 16 names, and read only by
      commands that deploy or destroy, so an installation that declares none keeps working
      unchanged. A name is refused when the configuration is read, by name, when it: does not
      match the identifier shape `[a-zA-Z_][a-zA-Z0-9_-]*` (the shape is generic on purpose — the
      core stays provider-agnostic, and a name Terraform additionally reserves, like `count` or
      `source`, is refused by Terraform itself at first use, loudly); appears twice; or contains
      any of `secret`, `password`, `token`, `key`, or `credential` case-insensitively — unless
      that exact name is also listed under `deploy.allow_sensitive_input_names`, a per-name,
      reviewable exception that lives in the same default-branch-read settings. The settings file
      states, beside the setting, what declaring a name means: the variable's value at each deploy
      is recorded in the registry in the clear and shown wherever the record is shown — so a
      secret must never travel through a declared input. The warning is written where the operator
      declares the name, not only in the specification. The denylist is defense-in-depth beside
      that warning, not the boundary: it catches the obvious names and is trivially evaded by ones
      it does not list (`passwd`, `conn_str`, a bearer value inside an innocently named field).
      (Where the configuration is read from is AC-9's promise. Added by `chg-011`.)
- [ ] AC-36: Every environment record can carry the recorded values of its declared deploy inputs
      — name to value — and carries none before a deploy that declared any has succeeded. The
      values are updated exactly when the recorded commit is: after a successful apply, and never
      on a failed one, so the recorded values and the recorded commit always describe the same
      landed deploy. The update replaces the whole map with that deploy's values — a name no
      longer declared does not linger from an earlier deploy. A value is at most 512 characters
      and contains no control characters (newlines included) and no Unicode direction-control
      characters (HTML-escaping does not neutralize a visually reordered rendering, so the spoof
      is refused at the door instead); a value that violates any of these is refused where it is
      supplied, not where it is stored, so the refusal names the variable rather than surfacing
      later as a storage failure. Records written before this change, and records for
      repositories that declare no inputs, simply lack the field, and every reader treats that as
      "none recorded". (Added by `chg-011`.)
- [ ] AC-37: A deliberate human action can redact one recorded input value — the value is removed
      from the environment's record, the rest of the record untouched — so a secret recorded by
      mistake is not stuck in the registry until the environment dies. Redaction writes the way
      every registry mutation writes: read, compare-and-swap, retry on a lost race — never an
      unconditional overwrite. And it changes the record's *content*, never its *state*:
      reactivation is a state transition to `active`, so no teardown step that re-confirms its
      claim may read a redaction-only write as a reactivation — the re-confirm keys on state, not
      on version identity alone. Redaction rides the same manual-dispatch surface as protect and
      unprotect, and the dispatch table routes no pull-request event to it — a guardrail in the
      file a maintainer reviews, stated honestly rather than dressed as a cloud boundary: the
      cloud does not refuse a pull-request run this write, and does not need to, because an
      ordinary deploy already replaces its own record's whole map (AC-36), so bypassing the
      guardrail gains a run nothing it lacks. It trades destroy convenience for containment,
      knowingly: a destroy after a redaction runs without that value, and if the definition
      requires it, the destroy fails down the teardown feature's loud, retried path naming the
      variable — the operator redeploys to re-record, supplies the destroy by hand, or accepts
      the noise until teardown. Redaction removes; it never rewrites a value, because a redacted
      record must read as "value withheld", not as a different deploy. (Added by `chg-011`.)

- [ ] AC-38: The registry exposes the pool claim as one conditional operation: given a
      claimable warm slot's record at an observed version, it transitions `warm` → `active`
      and records the claimant, or fails observably if the record moved. Claimability is
      enforced at the registry layer, not by caller discipline: the operation refuses a
      `warm` record with no deployed commit, so a build in progress can never be claimed.
      Failure keeps the refused-versus-contended split fresh claims already have: a version
      mismatch is a genuine loss (the caller moves to the next slot), while an inconclusive
      collision is `contended` (the caller retries the same slot before moving on) — the same
      reasoning as AC-5, because it is the same kind of conditional write. Under concurrent
      attempts on the same slot exactly one succeeds — proven against the fake store's
      contention and expressed through the store contract's compare-and-swap, never a
      provider mechanism (chg-012).
- [ ] AC-39: A `warm` record is distinguishable by inspection as build-in-progress (no
      deployed commit) or claimable (deployed commit and URL present); after a pool claim the
      record additionally carries its claimant, and every consumer that today derives a pull
      request from the identity can obtain it from the claimant for pooled environments
      (chg-012).

## Known sharp edges (prototype)
- **Pull requests are not separated from each other by the cloud.** The role a pull-request run
  assumes reaches the whole ephemeral namespace, because the pull request number reaches no
  condition the cloud can evaluate: a generic OIDC provider's token claims are readable while the
  role is being assumed and not afterwards, and GitHub emits no session tags. Skyhook's own code is
  what keeps one pull request out of another's environment, and a pull request that edits skyhook's
  code on its own branch defeats it. Closing this would need the calling workflow to live on the
  default branch and hand out already-narrowed credentials — which the deploy-action feature
  considered and declined, because only a repository collaborator can open a pull request that
  deploys at all, and pinning the workflow costs a dependency on one cloud's handling of one CI
  host's non-standard token claim. So this is a decision, not an oversight and not a gap: the
  constitution records it under *Preview environments are not isolated from each other*, along with
  what it costs — infrastructure state holds any credential the infrastructure generated for itself,
  and a sibling preview can read it.
- **The atomicity primitive is the bet.** Whether S3's conditional writes are sufficient for
  claims under real contention is what this prototype exists to prove. If they are not, the
  S3-only decision does not survive and a second store returns.
- **The registry's shape is close to a one-way door.** Every later feature reads it; changing it
  after environments exist means migrating live data.
- **A name stays taken until teardown finishes.** Because a record lives exactly as long as its
  environment, a pull request closed and reopened quickly may find its own name unavailable until
  the sweep has torn the old one down. That latency is the price of never handing one environment
  to two runs, and it is bounded by the sweep interval.
- **The trust anchor costs one human step, permanently.** Keyless access to a cloud account cannot
  bootstrap itself; the OIDC provider and roles require credentials that do not yet exist. This is
  a property of the trust model, not a gap to close later. An account may also already hold a trust
  anchor for the same identity provider, belonging to something other than skyhook. The
  *definition* cannot tell which case it is in — reading a trust anchor that does not exist is an
  error rather than an empty answer — so the command that applies it looks first and says. It now
  costs a second *reach* as well as a second credential: the command reads the CI host too, to learn
  which form of OIDC subject this repository's runs present, and where that read is refused — the
  setting needs repository admin — it falls back to the conventional form and says so, which is
  correct wherever that form applies and loudly wrong where it does not. An operator applying the
  definition directly, rather than through that command, still has to know and say which trust-anchor
  case they are in, and must now supply the subject's form themselves — unlike every other input it
  has no default, which is why the installation instructions send them to the command that works it
  out. They get no state migration either, so their state stays local and is theirs to look after.
- **Configuration is read from the default branch by default.** Allowing a pull request to override
  its own settings is a deliberate future option, not an oversight, so the plan should keep the
  read location a single seam rather than scattering it through callers.

## Open questions
None outstanding. The registry's key layout and record shape — flagged here as close to a one-way
door — was settled in `plan.md` (D2): one object per environment, keyed by repository then identity.
