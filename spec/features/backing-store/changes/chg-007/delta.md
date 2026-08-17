# Delta — backing-store / chg-007 — the deploy contract

> The change expressed against the current spec as explicit operations.

> **Partly withdrawn 2026-08-15 by feat-002's `chg-001`, before fold.** An amendment to
> `constitution.md` reclassified the boundary between two preview environments: it was carried as
> debt with a known fix, and is now a deliberate choice not to defend, with its cost stated. Three
> operations below existed only to build that fix and are struck through in place rather than
> deleted — this delta had not been folded into `spec.md`, so nothing here ever became a promise,
> and the record of what was intended is worth more than a tidy file. Everything not marked
> WITHDRAWN stands and is still to be built.
>
> The proposal beside this file is left exactly as written. It argued for the trust condition
> honestly and on the evidence available; it is history, not instruction.

## ADDED

- **AC-28:** Every environment record can carry the address at which that environment is reachable,
  and carries none before one is known. A later reader learns where an environment is without
  redeploying it.

- ~~**AC-29:** The credentials a pull-request-triggered run can obtain are issued only to a job
  running a workflow file stored on the repository's default branch. A job running a workflow the
  pull request altered on its own branch is refused by the cloud, not by skyhook's code. This is
  what lets the workflow that does get credentials narrow them to one environment before anything
  the pull request controls runs.~~
  **WITHDRAWN by feat-002/`chg-001`.** This is the preview-to-preview boundary stated as a
  requirement on the backing store, and the constitution no longer asks for it. No AC-29 is added;
  the next number stays free for whatever claims it next.
  Note what does *not* need replacing: a pull request that edits skyhook's workflows still cannot
  obtain wider credentials, because the subject claim names what triggered a run rather than which
  file ran. That is AC-14's territory and it was never this criterion's doing.

- **AC-30:** Init writes everything a repository needs to deploy and applies none of it: **the
  workflow a pull request triggers** and a starting point for the role the repository itself must
  declare. It states the order in which these must reach the default branch, because a pull request
  opened before they arrive does nothing at all, with nothing to explain why.
  *Revised by feat-002/`chg-001`:* was two workflow files — a caller plus the one that issues
  credentials — which collapse to one now that no trust condition pins the second. The ordering
  requirement survives, since one file still has to be on the default branch first.

- **AC-31:** Configuration carries what a deploy needs: which cloud account holds the installation,
  and where the repository's own infrastructure definition lives. An unrecognized setting remains an
  error rather than a silent default. These settings are absent-tolerant for every command that does
  not deploy, so an installation made before this change keeps working unchanged. (Where they are
  read from is AC-9's promise, which already covers all configuration and needs no amendment.)

- ~~**Scenario: a pull request tries to issue itself wider credentials**~~
  ~~- Given a pull request that has edited the workflow calling skyhook, on its own branch, to point
    at a copy it controls~~
  ~~- When that workflow runs and asks the cloud for credentials~~
  ~~- Then the cloud refuses, because what it trusts is the workflow file stored on the default
    branch and not the branch that triggered the run~~
  **WITHDRAWN by feat-002/`chg-001`**, with AC-29 above. The scenario as written is also subtly
  wrong about why it would have passed: such a pull request is refused *wider* credentials by the
  subject claim regardless, and what the withdrawn trust condition actually stopped was a narrower
  thing — reaching a **sibling preview environment**. Replacing it with a scenario asserting that
  outcome would state the opposite of what the constitution now says holds.

## MODIFIED

- **AC-1 — what init produces**
  - Was: Running init in a repository with no prior installation creates `.skyhook/` containing a
    configuration file, the workflow that calls skyhook, and a statement of which of its files
    belong in version control, and writes the bootstrap infrastructure definition without applying
    it.
  - Now: Running init in a repository with no prior installation creates `.skyhook/` containing a
    configuration file, both workflow files that call skyhook, a starting point for the role the
    repository must declare, and a statement of which of its files belong in version control, and
    writes the bootstrap infrastructure definition without applying it.

- **AC-10 — what the store exposes to a caller enforcing the cap**
  - Was: The store exposes the count of environments currently in the `active` state, and the
    configured cap, to callers that enforce it.
  - Now: The store exposes the configured cap, the count of environments currently in the `active`
    state, and the count of environments a repository holds at all. The second of those is obtained
    without reading any environment's record, so a caller whose credentials reach only its own
    environment can still enforce the cap. A record exists for exactly as long as its environment
    does, so that count is the number of environments skyhook is accountable for — which is the
    number a cap is about. It is deliberately not the number *standing*: a record is written before
    the infrastructure it describes exists, so the count can exceed what was built. Over-counting is
    the safe direction for a cap, and the window is the same one that makes teardown a guarantee.

- **AC-14 — where a pull-request run's identity comes from, and what confines it**
  The sweeping replacement this operation originally proposed is **WITHDRAWN by feat-002/`chg-001`**:
  the criterion's description of what the credentials do was right the first time, and stands. The
  spec described the system accurately; it was the plan around it that had decided this was
  temporary.
  What does need correcting is the last sentence's *framing*, which the pre-build check caught —
  **FOLDED EARLY, ahead of the rest of this delta**, because it is what held the gate:
  - Was: (…) That residual gap is stated in *Known sharp edges* and is not closed at prototype
    depth.
  - Now: (…) That the credentials do not separate one pull request from another is a recorded
    decision rather than a gap awaiting a fix; *Known sharp edges* states what it costs.
  - Why: "residual gap" and "not closed at prototype depth" together promise a closure at some
    higher depth. There is no depth at which it closes — the constitution states it as a choice —
    so left as written it would send a later promotion chasing an answered question.

- **AC-17 — what the credentials refuse**
  - Was: The credentials a pull-request-triggered run holds are refused by the cloud for every
    environment outside the ephemeral namespace — every long-running environment, every environment
    in another repository, and the protection mark of any environment whatsoever. (…)
  - Now: The role a pull-request-triggered run assumes is refused by the cloud for every operation
    on an environment outside the ephemeral namespace — every long-running environment, every
    environment in another repository, and the protection mark of any environment whatsoever. It
    does permit **enumerating the names** of the environments a repository holds, which is what lets
    a run select its own copy and count the cap; a name is not an environment, and no operation on
    one is permitted. Narrowing the credentials a run actually holds to the single environment it
    claimed is done by skyhook when it asks for them, and is that feature's criterion
    (feat-002/AC-19) — a guardrail against a run reaching a sibling by accident, not a boundary
    against one that means to. (…)
  - *Revised by feat-002/`chg-001`:* the clause requiring credentials to be obtainable only from a
    default-branch workflow is gone with AC-29, and the claim that "both halves are required for one
    pull request to be held out of another's" is gone with it — that is now the constitution's
    stated decision rather than a promise this feature half-owns. The listing permission and every
    refusal outside the namespace are unaffected.

- **AC-18 — where an operator meets the limit**
  - Was: The bootstrap definition, and the output of the init command, both state plainly that a
    pull-request run's credentials do not separate it from *other pull requests'* environments. The
    limit is written where an operator reads it, not only in the specification.
  - Now: The bootstrap definition, and the output of the init command, both state plainly where the
    boundary around a pull-request run is drawn: everything outside the ephemeral namespace is
    refused by the cloud, and within it one preview environment is not held apart from another. What
    an operator must not get wrong — that a sibling preview can read this one's infrastructure
    state, including any credential that infrastructure generated for itself — is written where they
    read it, not only in the specification.
  - *Revised by feat-002/`chg-001`:* was a statement that the boundary had closed and how. It now
    states that the boundary is open by decision, and names the consequence an operator would
    otherwise have to infer. The point of this criterion was never that the news was good.

- **Scenario: a pull request asks for another environment's name**
  - Was: (…) If skyhook's own check were bypassed, the credentials the run holds would still refuse
    every long-running environment, every other repository, and every protection mark — but would
    not, on their own, refuse another pull request's environment
  - Now: **unchanged — this operation is WITHDRAWN** by feat-002/`chg-001`. The scenario's original
    wording is exactly right, and the replacement would have asserted the opposite of what now
    holds.

- **Known sharp edges — "Pull requests are not separated from each other by the cloud"**
  **FOLDED EARLY, ahead of the rest of this delta** — with AC-14's framing above, this is what held
  the pre-build check, and neither depends on anything still unbuilt.
  - Was: the whole entry, describing the gap as open and naming the deploy-action feature as where
    it would be decided.
  - Now: **Pull requests are not separated from each other by the cloud, and that is a decision.**
    A permission policy still cannot name a pull request number — the reasoning in `plan.md` D2a is
    unchanged and still worth reading. Closing the boundary anyway would have meant issuing
    credentials from a workflow pinned to the default branch, which the deploy-action feature
    considered and declined: only a repository collaborator can open a pull request that deploys at
    all, so the boundary would defend against someone already holding write access, and pinning it
    costs a dependency on one cloud's handling of one CI host's non-standard token claim. The
    residual, stated rather than deferred: a preview environment can reach a sibling's
    infrastructure state, which holds any credential that infrastructure generated for itself. A
    pull-request run can also *enumerate* the names of environments it cannot otherwise touch.
    The entry stops naming a feature where this will be decided, because it has been.
  - *Revised by feat-002/`chg-001`:* the original operation announced the gap closed. This one
    keeps it open on purpose and says what it costs.

## REMOVED

- **Known sharp edges — "Init scaffolds a workflow that calls a feature not yet built."** The
  feature exists; the scaffolded workflows call it.
