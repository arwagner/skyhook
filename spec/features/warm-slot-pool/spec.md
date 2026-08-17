## Why
Provisioning a heavy environment from scratch costs its reviewer 15–20 minutes per fresh pull
request (dtak-prototype's measured cold time; the CDN distribution alone is 8–15 of it). dtak
keeps 500+ lines of bespoke pool machinery to cut that to ~2 minutes, and will not switch to
skyhook without parity. This feature gives skyhook the same capability as a first-class part of
the lifecycle it already owns: keep a small number of environments built ahead of need, hand one
to a pull request the moment it asks, and destroy-and-rebuild behind it. See `research.md` for
the full study and the problem brief.

Three standing clauses are consciously reopened by this feature, with the user's explicit
decision (2026-08-17). Two live in the backing store's spec: claiming as "mutual exclusion on
that name, not allocation from a pool", and the two-value record state enum, which has no value
for a built-but-unclaimed environment; their replacements are defined here and land as a
backing-store change folder before this feature is built. The third is the product glossary's
"Ephemeral environment — an environment whose lifetime is bound to a pull request": a warm slot
is bound to no pull request yet, so the glossary entry must widen to cover it (proposed wording:
"an environment whose lifetime is bound to a pull request, or a warm slot staged to be claimed
by one — both live in the ephemeral namespace"), and the glossary gains **warm slot** and
**pool** entries. That amendment goes through product-global's own main-branch commit before
this feature is built, exactly as the declared-deploy-inputs privacy amendment did.

## Definitions (feature-local)

- **Warm slot** — an environment provisioned by skyhook ahead of any pull request, held for the
  next one that asks. Its identity has the form `slot-<n>` and belongs to the ephemeral
  namespace, which this feature widens to mean: pull-request identities and warm-slot
  identities. The identity is fixed when the slot is built and never changes, including at claim.
- **Pool** — the set of a consuming repo's warm slots. Its one setting is the **pool target**:
  how many claimable warm slots the repo wants standing. Absent or zero means pooling is off and
  every behavior in this spec is inert.
- **`warm`** — a new record state alongside `active` and `released`: the environment is
  skyhook's, built or being built, and belongs to no pull request. A warm record that carries a
  deployed commit is **claimable**; a warm record without one is a build in progress — or
  wreckage, if a later scheduled pass finds it still commitless.
- **Claimant** — the pull request recorded on a slot's record when it is claimed. For a pooled
  environment the claimant, not the identity, says which pull request owns it.

**Why a claim does not break the identity invariant.** The product invariant says an identity is
never reused for different code without an intervening destroy. A warm-to-active claim updates
the slot's code in place — default-branch build to the pull request's commit — but it is the
slot's first and only tenancy, not a reuse: no completed tenancy preceded it, exactly as a
long-running environment's successive in-place updates are one tenancy, not reuses. Reuse in the
invariant's sense is a *successor tenant under the same name*, and that case keeps its destroy:
a closed claimant's slot is destroyed and rebuilt before the identity is ever claimable again.

## User stories
- As a reviewer, I want a PR's preview URL to arrive in roughly the time the repo's own delta
  takes to apply, not the full from-scratch provision, so that I can review while I still have
  context.
- As a repo operator, I want skyhook to keep a configured number of environments built ahead,
  current with the default branch, without my attention, so that the pool maintains itself.
- As a repo operator, I want each pull request's slot destroyed and rebuilt fresh after use, so
  that no PR ever inherits another tenant's leftovers.
- As a PR author on a repo whose pool is empty, I want my deploy to fall back to the
  from-scratch path in the same run, so that I always get a preview — warm when possible, cold
  otherwise.

## Behavior & scenarios

**Trust split, inherited.** Building, replenishing, and destroying slots is wide-credential work
and happens only in runs from the default branch — concretely, the scheduled sweep, which gains
a pool phase. A pull-request run gains exactly one new reach: before narrowing, it may read the
repo's warm-slot records and attempt the conditional claim on claimable ones; once a claim
succeeds it narrows to that one slot's identity and acts inside its boundaries, under the same
session narrowing that today confines it to its own derived identity. The same slot-record read
is how a run whose pull request already holds a slot finds it again (by claimant). Reading warm
siblings' records is a cost consistent with the standing decision that preview environments are
not isolated from each other. The cloud continues to refuse a pull-request run everything
outside the ephemeral namespace; that warm slots sit inside it is this feature's namespace
amendment, consistent with the standing decision that preview environments are not isolated
from each other.

**Warm-boot inputs (od-1, decided).** A warm build applies the consuming repo's infrastructure
at the default branch's current commit, with the values of the repo's declared deploy inputs
taken from the scheduled run's environment — the same contract the deploy workflow already
carries. Skyhook builds no consumer artifacts; the operator's scheduled workflow computes or
fetches the values before invoking skyhook.

**An assumption pooling places on the consuming repo, named plainly:** the repo's URL output
must be derived from the environment's identity, never from the commit or the input values —
otherwise the address handed out at build time changes at claim time. Skyhook re-reads the
outputs on every apply as it does today and records what it reads; a repo that breaks the
assumption gets a working preview at a new URL and wasted warmth, not a broken one.

- **Scenario: the sweep replenishes the pool**
  - Given a pool target of 2, one claimable warm slot standing, and cap headroom
  - When the scheduled sweep runs its pool phase
  - Then it creates a registry record in state `warm` under the next free `slot-<n>` identity
    before provisioning anything, applies the repo's infrastructure at the default branch's
    commit with the declared input values from its environment, and on success records that
    commit and the environment's URL — the slot is now claimable
  - And it builds at most one slot per pass, so a second missing slot waits for the next pass

- **Scenario: a warm build is refused a missing input**
  - Given the repo declares a deploy input and the scheduled run's environment does not carry it
  - When the pool phase would build a slot
  - Then it refuses before creating any record or resource, names the missing input, and the
    pass reports the refusal visibly

- **Scenario: a pull request claims a warm slot**
  - Given a claimable warm slot and a pull request run that would otherwise deploy from scratch
  - When the run reaches the point where it would claim its derived identity
  - Then it instead claims the lowest-numbered claimable slot with a single conditional write —
    state `warm` to `active`, recording the pull request as claimant — narrows its credentials
    to that slot's identity, re-applies the repo's infrastructure on the slot with the pull
    request's commit and its declared input values, and records that commit and the re-read
    URL; the identity is unchanged from the build, and no new environment is created

- **Scenario: a push to a pull request that already holds a slot**
  - Given an `active` slot whose claimant is this pull request
  - When the pull request is pushed again
  - Then the run finds its slot by claimant among the slot records and re-applies on it — it
    never claims a second slot and never creates an environment under its derived identity

- **Scenario: the claim wins but the re-apply fails**
  - Given a run whose conditional claim succeeded and whose re-apply then fails
  - Then the record stays `active` with the claimant set and the build-time commit unchanged,
    the run fails naming the consumer's apply as the cause (mirroring an ordinary failed
    deploy), and there is no cold fallback in the same run — the next push retries on the
    already-claimed slot

- **Scenario: two pull requests race for a slot**
  - Given claimable warm slots and two concurrent pull-request runs
  - When both attempt the conditional claim on the same slot
  - Then exactly one succeeds; the other observes the loss (never a silent overwrite), attempts
    the next claimable slot, and proceeds as if the pool were empty only when none remain

- **Scenario: the pool is empty — cold fallback (od-2, decided)**
  - Given no claimable warm slot
  - When a pull-request run deploys
  - Then the same run falls back to today's from-scratch path under its own derived `pr-<n>`
    identity, subject to the cap as today, and the run's output states which path — warm or
    cold — the preview took

- **Scenario: the claimant's pull request closes**
  - Given an `active` slot whose claimant pull request has closed
  - When the close event's teardown runs, or failing that the next scheduled sweep
  - Then the slot is released and destroyed exactly as an ephemeral environment is today, its
    record deleted only after verified destruction — and it is never handed to another pull
    request without that destroy and a fresh build

- **Scenario: the sweep clears wreckage conservatively**
  - Given a `warm` record with no deployed commit that this pass did not itself create
  - When the scheduled sweep runs
  - Then it treats the slot as an interrupted build and destroys it
  - And given a slot whose claimant's state cannot be determined (a failed lookup), the sweep
    leaves that slot alone and reports it, destroying only on a positive "closed" answer

- **Scenario: the cap holds (od-3, decided)**
  - Given warm and active environments together at the configured cap
  - When the pool phase would replenish
  - Then it does not build, and says so in the pass's report; warm slots count against the cap
    exactly as any registry entry does today

## Acceptance criteria

- [ ] AC-1: With no pool target configured (or zero), no pool phase runs, no `slot-<n>` record
  is ever created, and the deploy path is byte-for-byte today's behavior — verified by the
  existing deploy tests passing unchanged against a pool-less configuration.
- [ ] AC-2: A slot's registry record in state `warm` exists before any of its resources are
  provisioned, and after a verified destroy the record is deleted — checked against fake
  adapters by asserting record-write precedes the first provision call, and on the live repo by
  the registry never lacking a record for a standing slot.
- [ ] AC-3: A warm build with a declared input value missing from the run's environment refuses
  before writing any record, and its refusal names every missing input; the pass exits
  non-zero.
- [ ] AC-4: A claimable warm slot is observable in the registry as state `warm` with a deployed
  commit (the default branch's at build time) and a URL.
- [ ] AC-5: The claim is one conditional write from `warm` to `active` that records the
  claimant; under two concurrent claims of the same slot exactly one write succeeds, and the
  loser attempts the next claimable slot before treating the pool as empty — proven with the
  fake store's contention, and by the store contract's compare-and-swap against the real one.
- [ ] AC-6: After a claim, the slot's record shows the pull request's commit, its declared
  input values, and the URL re-read from that apply, and the identity equals the one recorded
  at build time.
- [ ] AC-7: With an empty pool, the same pull-request run completes a from-scratch deploy under
  its derived identity, and the run output names the path taken (warm or cold) in both cases.
- [ ] AC-8: A closed claimant's slot is destroyed and its record deleted within one sweep
  interval of the close, with teardown's existing re-confirm and verified-destroy semantics
  intact; no identity is ever claimed twice without an intervening verified destroy.
- [ ] AC-9: The pool phase builds at most one slot per pass, stops at the pool target, and at
  the cap builds nothing and reports the cap as the reason.
- [ ] AC-10: A commitless `warm` record not created by the running pass is destroyed by that
  pass; a slot whose claimant lookup fails is left standing and reported.
- [ ] AC-11: Pull-request credentials can claim and then act only within the one slot claimed:
  an attempted slot build, an attempted destroy, and an attempted write to another slot's
  record are each refused — the first two by the cloud, the last by skyhook's narrowing —
  demonstrated on the live installation.
- [ ] AC-12: Skyhook's own overhead on the warm-claim path (claim, narrowing, recording;
  excluding the repo's apply and the tool's preparation step) stays within the product's
  60-second budget, measured by the same accounting deploys use today.
- [ ] AC-13: A push to a pull request that already holds an `active` slot re-applies on that
  slot; at no point do two environments exist for one pull request — checked with fake
  adapters by pushing twice and counting records.
- [ ] AC-14: When a claim succeeds and the re-apply fails, the record remains `active` with the
  claimant set and the build-time commit, and the run exits non-zero naming the consumer's
  apply as the cause; a subsequent run for the same pull request retries on that slot.

## Known sharp edges (prototype)

- **The close event's fast path leans on the slot-record read grant.** A close-triggered run
  finds which slot its pull request claimed the same way a push does — reading slot records and
  matching the claimant. If that lookup fails for any reason, the run reports and stops, and
  the scheduled sweep completes the teardown within one interval, as the constitution already
  demands; correctness never depends on the fast path.
- **Warm slots age forward-only.** A slot built last week serves today's PR with last week's
  base infrastructure until the claim's re-apply corrects what the infrastructure definition
  names; anything the definition does not name (seeded data, one-shot boot effects) stays as
  built. Accepted at prototype depth; dtak accepts the same.
- **In-progress vs wreckage rests on one-build-per-pass.** A commitless `warm` record is
  distinguishable from a live build only because a pass builds at most one slot and passes do
  not overlap (the sweep's existing single-flight discipline). If overlapping passes are ever
  allowed, this needs a real lease.
- **Three reopened clauses must land first.** The backing-store amendments (pool claiming; the
  `warm` state) go through that feature's change folder; the product glossary amendment
  (ephemeral environment, warm slot, pool) goes through product-global's own main-branch
  commit; and the ephemeral-namespace widening touches the deploy action's credential language
  — all before this feature's build, following the declared-deploy-inputs precedent. Tracked as
  an open decision on the manifest so implementation cannot start ahead of it.
- **Cap starvation is possible by configuration.** A pool target at or near the cap can leave
  no headroom for cold fallbacks; the sweep's report is the only alarm. Accepted at prototype.

## Open questions

- Whether the privacy enumeration in product-global needs "claimant pull request" named as a
  datum, or whether the existing "pull request number" entry already covers it — settle in the
  same main-branch commit as the glossary amendment.
- The exact reserved identity prefix (`slot-` proposed here) is confirmed at plan time against
  the credential fence's real pattern language; the spec's requirement is only that the
  namespace is reserved, cloud-reachable by pull-request runs, and disjoint from `pr-<n>` and
  operator-chosen names.
