# Research — Teardown (feat-003)

> Diamond 1, divergent pass. Compiled 2026-08-16 from the standing artifacts (constitution,
> product-global, the deploy action's research and spec, the backing store's spec) and from the
> shipped code. Wide on purpose; `define` narrows it. Where this file and a later brief disagree,
> the brief wins.

## Where this feature comes from

Both shipped features point here. The deploy action (feat-002) creates environments and its spec
says plainly, under *Known sharp edges*: **"Nothing tears these environments down."** Every
environment it creates persists until teardown exists, so the cap refusal is the first thing a
prototype user meets in ordinary use. The backing store (feat-001) already built the seams teardown
needs: a record is `active` or `released` (eligible for teardown), `remove()` is the deletion that
frees a name, and a claim on a released-but-standing name is refused as `awaiting-teardown`.

Three of the deploy action's acceptance criteria are explicitly deferred until teardown exists
(its AC-5, close-and-reopen; AC-10 in part; and the teardown half of the no-orphans story). The
deploy action's discovery names "skyhook's own automation, downstream" — the sweep and the
dashboard — as the eventual readers of everything it records, "the only thing that will later make
teardown a guarantee rather than a hope."

## Who is affected

- **The repo maintainer / bill payer.** The person who finds leaked environments on the invoice.
  Today every environment skyhook creates lives forever; the maintainer's only recourse is manual
  cloud-console archaeology, which is precisely the workaround the product exists to replace.
  Wants cleanup to be true without watching it.
- **The pull request author.** Mostly indifferent to teardown — until the cap. With no teardown,
  five open-then-closed pull requests exhaust the default cap of 5 and the sixth author is refused
  an environment for no reason they can see. Teardown is what makes the cap a live-environments
  cap rather than an ever-filled quota. Also affected on reopen: a closed-then-reopened pull
  request should deploy fresh rather than colliding with its own corpse (deploy action AC-5).
- **The operator of a protected or long-running environment.** Affected by what teardown must NOT
  do: the constitution forbids automatic destruction of protected environments, and a
  pull-request-triggered run must be refused everything outside the ephemeral namespace.
- **Skyhook's own downstream automation.** The dashboard (future) wants the registry to reflect
  reality; teardown is what makes "what exists" and "what is recorded" converge from the other
  side.

## Jobs to be done

- When my pull request closes, make its environment go away — the money stops, the name frees.
- When the close event never fired (outage, tampering, a workflow edit, a kill mid-run), make the
  environment go away anyway, without anyone noticing the event was missed.
- Never destroy what a human marked protected; never let an ephemeral run touch what it does not
  own.
- When teardown dies halfway, leave the world honest: the name stays unclaimable
  (`awaiting-teardown`) until the infrastructure is actually gone, and a later pass finishes the
  job.
- Tell me loudly when cleanup cannot do its job. A silent failure and a success look exactly alike
  until the bill arrives.

## Pain today, and the current workarounds

- Hand-rolled preview setups bolt a destroy step onto the happy path; the environments that leak
  are the ones whose teardown never ran. That is the market-level pain from the deploy action's
  research, and skyhook currently reproduces it in a purer form: there is no destroy step at all.
- The deadweight test repository already demonstrated the cost class once (2026-08-14): resources
  whose management state was lost had to be hunted by hand. Detection-based recovery saved what
  could be detected; everything living only in unlocatable state was stranded.
- The cap refusal doubles as the current "workaround": creation stops when 5 corpses accumulate.
  That is the system protecting the bill by refusing service.

## Constraints any solution lives inside

From the constitution (non-negotiable):

- **No orphans.** Teardown is a guarantee, not best-effort. This feature is where that clause
  stops being a promissory note.
- **A scheduled sweep is what makes cleanup true.** Event hooks — a pull request closing, a
  teardown command — are a fast path ONLY; correctness may never depend on one firing. A missed,
  interrupted, or tampered-with event must be repaired by the next scheduled pass without anyone
  noticing.
- **Destruction of a protected environment is never automatic.** The sweep may create and update a
  protected environment but never destroys one.
- **Privilege split by trigger.** A pull-request-triggered run (the close fast path) holds
  credentials confined to the ephemeral namespace, narrowed to one environment. A scheduled run
  triggers from the default branch, so the wider credentials are available to it — which is also
  why the sweep's protected-environment restraint must be right: it is the code path where the
  cloud is not the backstop.
- **Provider-agnostic core.** Which environments to destroy is core decision logic, testable
  against fake adapters with no cloud account; the destroying itself is adapter work, verified
  live.
- **Failures are loud.** A sweep that cannot complete reports failure visibly rather than exiting
  successfully.

From product-global (owned guarantees this feature will inherit or implement):

- The sweep runs no less often than every 15 minutes, and an environment eligible for teardown is
  destroyed **within one sweep interval** of becoming eligible.
- No environment exists that skyhook cannot locate and destroy; every provisioned environment is
  in the registry.
- Skyhook's own overhead budget (60 seconds) excludes applying the consuming repo's
  infrastructure; destroying it is presumably the same class of exclusion, but the performance
  clause is written about deploys — whether the budget applies to teardown at all needs a reading.

From the shipped code (seams and facts, verified today):

- `Registry.release()` exists and flips a record to `released`; nothing calls it yet in anger.
- `Registry.remove()` exists — deletion frees the name; the record is deleted before its
  protection marker, so the residue of a halted teardown is a claim-refusing record, never a
  marker silently attaching to the next tenant.
- A claim on a released-but-standing name is refused `awaiting-teardown`, distinct from `held` —
  the exact seam a teardown racing a reopen needs.
- The scaffolded workflow listens for `opened, synchronize, reopened` ONLY. The deploy action's
  research asserted the scaffold "already listens for closed"; the shipped file does not. The
  close trigger is net-new surface, and `init`'s restore-to-desired-content behavior means
  shipping it updates every installed repository's workflow on their next install.
- The deploy pipeline derives environment identity from the pull request and narrows credentials
  to that one environment before the repo's Terraform runs; teardown on close can ride the same
  identity derivation and the same narrowing.

## Unknowns and risks (the shape-changers)

- **U1 — What does `terraform destroy` need to run?** Destroying requires the definition (or at
  least a working backend/provider configuration), not just state. On a closed pull request the
  head ref still exists for checkout, but on a merged-then-deleted branch the checkout target is
  less obvious, and the sweep has no pull request to check out at all. Where the sweep obtains a
  definition to destroy with — the head commit recorded in the registry, the default branch's
  definition, or state alone — may be THE architectural decision of this feature. The registry
  records repository, commit, and state location, which was designed to be enough to locate; is it
  enough to destroy?
- **U2 — What identity destroys?** The close fast path is pull-request-triggered, so it holds
  pr-confined credentials — fine for destroying its own environment. The sweep triggers from the
  default branch and holds wider power; the constitution's protected-environment clause is the
  restraint there. Whether the sweep narrows itself per-environment the way deploys do, and
  whether destroy needs the consuming repo's deploy role (it does — the resources were created
  with it), shapes both trust policies.
- **U3 — Does a `closed` pull-request event get an OIDC token?** The fast path assumes a
  closed-triggered run can still authenticate keylessly. Believed yes (it is an ordinary
  `pull_request` event), but it is an assumption a live check should confirm, same class as the
  claims the backing store proved against real S3.
- **U4 — Half-destroyed infrastructure.** `terraform destroy` can fail partway. The record must
  outlive the infrastructure (that ordering is already built), but how retries work — next sweep
  pass retries the destroy? how many times? what surfaces after N failures? — is open. "Failures
  are loud" applies; a destroy that fails forever must not be a silent loop.
- **U5 — Scope of this feature vs the sweep.** The deploy action's out-of-scope note reads
  "teardown when a pull request closes, and the scheduled sweep... their own features" — plural.
  But the constitution says the fast path without the sweep is not correctness, and the two share
  nearly all machinery (locate, destroy, remove record). Whether this feature carries both
  triggers or the sweep splits out is the first `define` decision. product-global's
  sweep-interval guarantee needs an owner either way.
- **U6 — The sweep's other half.** The constitution defines the sweep as comparing actual
  environments against the registry and correcting the difference — both directions. Destroying
  released-but-standing environments is one direction; an environment standing with NO record (the
  thing "no orphans" fears most) is the other, and much harder: it requires discovering unrecorded
  infrastructure. Is direction two in scope here, later, or is prevention (the deploy path's
  record-before-provision ordering) the prototype's answer?
- **U7 — Where does the sweep run?** A scheduled GitHub Actions workflow in the consuming repo is
  the obvious host (same CI, same OIDC), but schedule reliability on quiet repos is notoriously
  lax, and product-global promises a 15-minute cadence. Whether that promise survives contact
  with GitHub's scheduler at prototype depth is worth an explicit check or an explicit deferral.

## Signals of success

- A closed pull request's environment is gone within minutes, its name claimable again; close,
  reopen, push deploys fresh (the deploy action's AC-5 finally provable).
- Kill the close workflow mid-destroy, or suppress the close event entirely: the environment is
  still destroyed within one sweep interval, and nobody had to notice the event failed.
- A protected environment survives every automatic path, demonstrably.
- The cap stops being the first thing a user meets: environments cycle instead of accumulating.
- A sweep that cannot complete fails the run visibly — a red scheduled run, not a green lie.
- Zero registry records whose infrastructure is gone, and zero infrastructure whose record is
  gone, after any interleaving of deploy, close, and sweep.

## Problem brief

> Converged 2026-08-16. Scope decision made by the human: this ONE feature carries both the
> close-triggered fast path and the scheduled sweep. Where this brief and the discovery above
> disagree, the brief wins.

### Problem statement

Repo maintainers who pay for preview environments struggle to trust that an environment dies when
its pull request does, because skyhook can create and record environments but nothing destroys
them, which results in every environment living forever: money leaks until someone notices the
bill, and the environment cap fills with corpses until authors are refused previews. A solution
should make destruction a guarantee — a closed pull request's environment is destroyed and its
name freed, even when the close event never fires — without ever destroying a protected
environment automatically, and without an ephemeral run reaching anything it does not own.

### Target users

- **The repo maintainer / bill payer** — wants cleanup to be true without watching it, and a loud
  signal when it is not.
- **The pull request author** — wants the cap to count live environments, not corpses, and wants
  close-then-reopen to deploy fresh instead of colliding with a half-dead name.
- **The operator of a protected environment** — wants certainty that no automatic path destroys
  what a human marked protected.

### Jobs to be done

- When a pull request closes, destroy its environment promptly and free its name.
- When the close event is missed, interrupted, or tampered with, destroy the environment anyway
  within one sweep interval, with nobody needing to notice the event failed.
- When a destroy dies halfway, keep the world honest — the name stays refused as
  awaiting-teardown until the infrastructure is actually gone — and finish the job on a later
  pass.
- Never destroy a protected environment automatically; never let a pull-request-triggered run act
  outside the one environment it owns — "act" in the constitution's sense, where seeing a name is
  not reaching an environment (see *Security & compliance*, the two named exceptions).
- Report visibly when cleanup cannot do its job.

### What "eligible for teardown" means (committed vocabulary)

An ephemeral environment is **eligible for teardown** when the pull request it is bound to is
closed — whether or not any close event was observed. Protection is deliberately NOT part of the
definition: it is a separate check, honored before acting on anything eligible, so an eligible
environment carrying a protection marker is left standing. Proposed for the product glossary
(product-global is main-branch-only, so this is a proposal, not an edit).

Two consequences of that definition, committed here as constraints rather than left to be
discovered (they are design commitments, not vocabulary — recorded because the constitution
forces both):

- **The sweep derives eligibility from the pull request's actual state**, not from the record
  having been flipped by a fast path that may never have run. The record's `released` state is a
  consequence of teardown starting, not a precondition for the sweep to act. Anything else would
  make correctness depend on an event firing, which the constitution forbids.
- **Eligibility and the registry's stored state lag each other, and the cap follows the
  registry.** Between a pull request closing and teardown processing it, the record still reads
  `active`, so an eligible-but-unprocessed environment still counts against the cap and still
  refuses claims as held — for up to one sweep interval. This lag is a known, accepted limit of
  the design: the cap reflects what is standing (and billing), not what is doomed, and a standing
  environment counting against the cap is the honest reading.

### Success signals (how we'll know the pain shrank)

- Close a pull request: its environment is destroyed and the registry record removed; reopening
  deploys fresh (the deploy action's close-and-reopen criterion, its AC-5, finally provable).
- Suppress or kill the close-path run mid-destroy: the environment is still destroyed within one
  sweep interval, per the shared reliability guarantee.
- A protected environment survives every automatic path, demonstrably, including the sweep.
- After any interleaving of deploy, close, and sweep: a completed teardown leaves no registry
  record behind for the environment it destroyed, and no skyhook-provisioned infrastructure
  stands without a registry record.
- The cap counts what is standing: a closed pull request's slot frees when its environment is
  destroyed, with at most one sweep interval of lag (the accepted limit stated under the
  vocabulary section above).
- A sweep that cannot complete fails its run visibly.

### Constraints

- The constitution's non-negotiables: no orphans; sweep-makes-cleanup-true (events are a fast
  path only); protected environments are never destroyed automatically; privilege split by
  trigger, with the ephemeral namespace refused everything else by the cloud; provider-agnostic
  core (which-to-destroy logic testable on fake adapters; destroying is adapter work verified
  live); failures are loud.
- product-global's reliability guarantee: the sweep runs at least every 15 minutes, and an
  eligible environment is destroyed within one sweep interval of becoming eligible.
- The backing store's contract: `remove()` is what frees a name; the record dies before its
  protection marker; a released-but-standing name refuses claims as awaiting-teardown.
- The close fast path runs with pull-request-confined credentials narrowed to its own
  environment; the sweep runs from the default branch and must supply its own restraint where the
  cloud is not the backstop.

### Explicitly out of scope

- Discovering and destroying infrastructure that has NO registry record (the sweep's second
  direction). Prevention is the prototype's answer — the deploy path records before it
  provisions. Parked in the backlog.
- Long-running environments' lifecycle, and any surface for setting or clearing protection marks.
  Teardown only honors marks that exist.
- The dashboard, and any reporting beyond loud run-level failure.
- Cost reporting of what teardown saved (constitution: not cost management).

### Open questions

- Where does a destroy get its definition? Terraform needs more than state to destroy. The close
  path can check out the pull request's head; the sweep has no pull request to check out. The
  registry records the deployed commit — is checking that commit out sufficient and safe?
- What happens after repeated destroy failures? Retry every sweep pass forever is a silent loop;
  "failures are loud" needs an escalation shape.
- Does a `closed` pull-request event still get an OIDC token in GitHub Actions? Assumed yes;
  needs a live check before anything depends on it.
- Can GitHub's scheduler actually honor a 15-minute cadence on a quiet repo, and what does the
  guarantee mean at prototype depth if not?
- Does product-global's 60-second overhead budget apply to teardown at all? It is written about
  deploys, and the destroy itself is clearly the consuming repo's time — but skyhook's own
  teardown overhead (releasing, removing, reporting) has no stated budget. Needs a reading, not
  an assumption.
- What identity destroys, concretely (research U2): does the sweep narrow its credentials
  per-environment the way deploys do, and does destroying require assuming the consuming repo's
  deploy role (the resources were created with it)? The constraints above commit only to "the
  sweep supplies its own restraint"; the mechanism is unresolved.
