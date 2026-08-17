# Research — Warm slot pool (feat-007)

> Diamond 1, divergent pass. Written solo from an already-crisp brief (2026-08-17): the user wants
> dtak parity on warm booting before switching dtak-prototype over to skyhook. Evidence comes from
> two same-day code studies: dtak-prototype's pool mechanism (`deploy/aws/EPHEMERAL.md`,
> `deploy/aws/scripts/pool.sh`, `.github/workflows/slot-pool.yml`, `deploy/aws/slot/*`,
> `deploy/aws/shared/*`) and skyhook's current lifecycle (`src/core/*`, the six feature specs).
> Hypotheses below are marked; genuine unknowns are gathered at the end.

## Who is affected

- **The reviewer.** Clicks a PR's preview link. Today (skyhook model) the link is ready only after
  a full from-scratch provision of the repo's Terraform. For dtak that is 15–20 minutes, dominated
  by CloudFront (8–15 min). With dtak's pool it is ~2 minutes. The reviewer is the whole reason
  dtak built the pool.
- **The PR author.** Pushes and waits for the sticky comment with the URL and logins. Same wait.
- **The repo operator (Andrew).** Owns the trade-offs: pool cost while idle, pool size, what
  happens when the pool is empty. In dtak the pool is ~$23/mo per idle slot plus ~$18/mo shared.
- **Skyhook itself as a product.** dtak is the first real adopter. Feature parity is the adoption
  gate: without warm booting, switching dtak to skyhook is a regression the reviewer feels on
  every PR.

## Jobs to be done

1. *When I open or push to a PR, get me a working preview URL fast enough that I still remember
   why I wanted it.* The job is latency, not novelty — everything else about the preview already
   works in skyhook.
2. *Keep some environments standing ready without anyone thinking about them* — built, seeded,
   current with the default branch, and safe to hand to the next PR.
3. *When a PR is done with its slot, make the slot's next tenant start clean.* dtak does this by
   destroy-and-rebuild, never by wiping in place.
4. *Tell me honestly when no slot is ready* rather than silently queueing.

## Pain today, and the current workaround

- Skyhook provisions every environment from scratch at claim time — one caller of
  `registry.claim`, provision follows record (`src/core/deploy.ts`). There is no notion of an
  environment that exists before its PR. For a repo like dtak the from-scratch path costs the
  reviewer 15–20 minutes per fresh PR.
- The workaround is dtak's hand-rolled pool: 534 lines of bash (`pool.sh`), a DynamoDB claim
  table, a 10-minute reconciler workflow, and three IAM roles — exactly the kind of bespoke
  lifecycle machinery skyhook exists to replace. As long as skyhook lacks the capability, dtak
  keeps the bash.

## What "warm" concretely is (from the dtak study)

- A warm slot is a **fully applied environment sitting unclaimed**: database, storage, CDN, DNS,
  a running service booted on the default branch's current image, seeded with demo accounts.
- **The claim is one conditional write.** dtak: DynamoDB `UpdateItem` with
  `condition state = free`, looping slot indices; loser of a race moves to the next index;
  exhausted loop = "pool full", fail fast with a PR comment, no queue.
- **The claim-time delta is only the tenant's own inputs.** dtak swaps one container image and
  syncs one bucket; nothing at claim time touches Terraform, CDN config, DNS, or the database.
  In skyhook vocabulary: re-apply on the already-provisioned workspace with the PR's declared
  inputs (`deploy.inputs` / `TF_VAR_*`), which leaves stable resources untouched.
- **Slots are never reused dirty.** A slot whose PR closed is destroyed and a fresh one is built.
  Fresh-start-per-tenant survives pooling; the pool is a latency device, not a reuse device.
- **A level-triggered reconciler owns the pool.** Every 10 minutes, from the default branch only:
  destroy released slots, destroy slots whose PR closed, destroy wreckage (interrupted builds,
  orphan workspaces), then build at most one new slot if free < MIN_FREE and total < MAX_SLOTS.
  Every error path leaves the slot alone; destruction only ever follows an explicit positive
  signal. This is the same philosophy as skyhook's sweep, almost clause for clause.
- **Warmth tracks the default branch forward-only.** New slots boot the current default-branch
  build; already-warm slots keep what they booted. A default branch that cannot build turns the
  reconciler red — that alarm is deliberate.
- **States**: building → free → claimed → released → (row deleted after verified destroy).
  Publish-the-row-last on create; the untrusted side may only mark, never destroy.

## Constraints any solution must live inside

- **The constitution's trust split.** Building and destroying slots is wide-credential work and
  may run only from the default branch — which is exactly the sweep's standing (scheduled,
  default-branch, "what makes cleanup true"). A PR run must be able to *claim* with its narrow
  credentials, nothing more. dtak's three-role split (claim may only update one table row;
  lifecycle only from main) confirms the same shape independently.
- **No orphans.** The pool builder is a second provisioner, so record-before-resource must hold
  for it exactly as it holds for deploys. dtak learned this the hard way (a slot left with 17
  live resources and no registry row).
- **Provider-agnostic core.** dtak's claim is DynamoDB; skyhook's store contract already exposes
  compare-and-swap with opaque versions (`src/core/store.ts`). A pool claim must be expressed
  against that contract, not against a provider.
- **The reopened clause.** The backing store's spec currently says claiming is "mutual exclusion
  on that name, not allocation from a pool" (`spec/features/backing-store/spec.md:24-25`). The
  user reopened this on 2026-08-17. This feature's spec defines what the clause becomes; the
  amendment lands as a backing-store change folder before anything is built.
- **Places the current model assumes environment == one PR** (from the skyhook study), each of
  which the spec must either respect or deliberately amend:
  1. Identity is derived from the trigger (`pr-<n>`), never allocated (feat-001/AC-14).
  2. The credential fence pins a PR run to the ephemeral namespace at the role and to one
     identity via skyhook's own session narrowing (feat-002/AC-19); a slot must be inside what
     the role allows, and narrowing must happen to the *claimed slot's* identity.
  3. Sweep eligibility reads the PR number out of the identity; a warm unclaimed slot has no PR
     and must read as "warm, not garbage", not as "destroy" and not as "never touch".
  4. The cap counts every registry key, so warm slots consume cap by construction unless the
     cap's meaning is amended.
  5. A record exists exactly as long as its environment — this one the pool *keeps*: a warm
     slot's record is created before its infrastructure and deleted after its verified destroy.
  6. Terraform workspace == identity, and a freed name starts from nothing (feat-003/AC-11) —
     kept by destroy-and-rebuild, exactly as dtak does.
  7. Only a deploy writes records today; the pool builder becomes the second writer, under
     default-branch credentials.
- **Preview non-isolation is already decided.** Any PR may reach any ephemeral environment's
  namespace at the role level (isolation between previews is skyhook's guardrail, not the
  cloud's). A pool where any PR may claim any free slot is compatible with that standing
  decision.

## What is dtak-specific and stays out of skyhook

The nine seeded accounts, the image build and `:latest` discipline, S3 web sync rules, ALB
priorities, the wildcard certificate, `X-Origin-Verify`. In skyhook's model all of that is the
consuming repo's business: the repo's Terraform plus its declared inputs decide what a slot
contains and what a claim swaps. Skyhook owns only the lifecycle: build-ahead, record, claim,
narrow, re-apply, release, destroy, replenish.

## Unknowns and risks (each can reshape the feature)

- **U1 — Where do warm-boot input values come from?** A warm build must apply the repo's
  Terraform with *some* values for the declared inputs (dtak's answer: the `:latest` image the
  reconciler itself builds from main). Skyhook cannot build the consumer's artifacts. Candidates:
  the scheduled workflow supplies `TF_VAR_*` for the warm build the same way the deploy workflow
  does (operator wires it); or a `pool.inputs` block of static defaults in config. This decides
  the consumer contract and is the biggest open question.
- **U2 — Slot identity naming.** Slots need identities inside the ephemeral namespace the PR
  role can reach, distinct from `pr-<n>`, recognizable to the sweep, and stable from build to
  claim (dtak fixes the hostname at build time so the claim never pays a CDN reconfiguration —
  the identity must not change at claim either).
- **U3 — Pool empty: fail fast (dtak parity) or fall back to a from-scratch deploy?** Skyhook
  already owns the cold path, so falling back is cheap to offer and strictly kinder than dtak's
  "no preview until you push again" — but it changes the latency story from "always fast" to
  "usually fast".
- **U4 — Does a warm slot count against the environment cap?** dtak has a separate pool cap.
  Skyhook's cap counts keys; folding warm slots in is simplest and honest about cost, but a
  full-size pool can then starve PR deploys.
- **U5 — Claim-then-apply latency honesty.** Even a warm claim runs the consumer's Terraform
  (fast no-op apply plus the delta) and the consumer's own build. Skyhook's own budget is 60 s;
  the 2-minute story depends on the consumer's delta being small. Parity is "as fast as dtak's
  pool for the same workload", not an absolute number.
- **U6 — Staleness of warm slots.** Forward-only tracking means a slot built last week serves
  today's PR with last week's base infrastructure until the delta apply corrects it. The apply
  corrects Terraform-visible drift by construction; anything not in Terraform (dtak: the seeded
  database) stays as built. Is that acceptable at prototype depth? (dtak accepts it.)
- **U7 — Reconciler cadence vs build time.** dtak builds at most one slot per 10-minute tick
  because a build takes 15–20 minutes and ticks must not overlap. Skyhook's sweep runs every 15
  minutes; the same one-build-per-tick rule likely transfers, but the sweep's runtime budget and
  the consumer's apply time interact here.

## Signals of success

- A dtak PR on skyhook gets its preview URL in roughly the time dtak's own pool delivers today
  (~2 min), not the ~15–20 min cold time.
- The pool converges unattended: kill a build mid-flight, close a PR, leak a workspace — the next
  scheduled pass repairs it and nothing needs a human.
- `pool.sh`, `slot-pool.yml`, and the DynamoDB table are deleted from dtak when it switches.
- Zero orphans: every slot ever built is either in the registry or verifiably destroyed.
- An empty pool produces a clear, immediate signal (whatever U3 decides), never a silent queue.

## Problem brief

> Converged 2026-08-17. The problem was chosen by the user (dtak parity before switchover); this
> pass sharpens it and commits to the framing.

### Problem statement

Reviewers and PR authors on repos like dtak — heavy infrastructure where a CDN distribution alone
takes 8–15 minutes; dtak is the only repo this evidence comes from, and applicability beyond it
is assumed, not validated — struggle to get a usable preview URL while the review is still fresh,
because
skyhook provisions every environment from scratch at claim time, which results in a 15–20 minute
wait per fresh PR — and results in dtak keeping 500+ lines of bespoke pool bash that skyhook
exists to replace, blocking its adoption of skyhook. A solution should hand a PR an
already-provisioned environment in roughly the time dtak's own pool delivers today (~2 minutes
for dtak's workload), without breaking skyhook's standing guarantees: no orphans, fresh start per
tenant, wide-credential work only from the default branch, atomic claims, and a
provider-agnostic core.

### Target users

Reviewers and PR authors on a consuming repo (they feel the latency); the repo operator (owns
pool size, idle cost, and empty-pool behavior); dtak-prototype as the first adopter whose
switchover this gates.

### Jobs to be done

Get a working preview URL fast after opening or pushing to a PR; keep a few environments standing
ready, current with the default branch, without human attention; give each PR a clean start;
signal clearly when nothing is ready.

### Success signals / how we'll know

A dtak PR on skyhook gets its URL in pool-parity time, not cold time. The pool self-repairs from
interrupted builds, closed PRs, and leaks within one scheduled pass. dtak deletes `pool.sh`,
`slot-pool.yml`, and its claim table. Zero orphaned slots. An empty pool answers within the same
claim attempt — no polling, no queue — with an explicit outcome; whether that outcome is a refusal
or a fallback to a from-scratch deploy is U3's call and this signal is pending it.

### Constraints

The constitution's trust split (slot build/destroy only from the default branch; a PR run may
only claim, under narrow credentials). Record-before-resource for the pool builder, which becomes
the registry's second writer. The claim must be expressed against the store's provider-agnostic
compare-and-swap contract. Two backing-store clauses are consciously reopened, not one: the
claiming clause — "mutual exclusion on that name, not allocation from a pool"
(`spec/features/backing-store/spec.md:24-25`) — and the record's two-value state enum, `active` |
`released` (`spec/features/backing-store/spec.md:54-55`), which has no value for a
built-but-unclaimed slot; a "free" slot is neither in use nor eligible for teardown, so new
state(s) are required rather than overloading `active`. This spec defines both replacements,
amended via a backing-store change folder before build. The product invariant "an identity is
never reused for different code without an intervening destroy" must be squared with a claim
updating a warm slot in place: the precedent is the long-running feature, whose environments are
updated in place by successive default-branch pushes (`spec/features/long-running-environments/
spec.md`, deploy-and-update stories); the argument reads the invariant's "reused for different
code" as *a successor tenant under the same name*, not an in-place update of one environment with
one (eventual) tenant — the spec must state that reading explicitly. Skyhook builds no consumer
artifacts: warm-boot input values must come from the consuming repo (U1).

### Explicitly out of scope

Anything the consuming repo deploys onto a slot (images, seeds, sync rules — dtak's business).
Reuse of a slot by a second PR without destroy-and-rebuild. Queueing for a full pool. Cost
reporting. Cross-repo pools.

### Open questions

Carried as U1–U7 above; U1 (where warm-boot input values come from), U3 (empty pool: fail fast
vs cold fallback), and U4 (do warm slots count against the environment cap) shape the spec most
and need the human's call. U2, U5–U7 can be settled by the spec itself at prototype depth.
