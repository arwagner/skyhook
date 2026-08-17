# Delta — backing-store / chg-012 — against spec.md as of 2026-08-17

## MODIFIED

- **The claiming paragraph** (Behavior & scenarios, first paragraph).
  - Was: "An **environment identity** names one environment (`staging`, `pr-482`); claiming is
    mutual exclusion on that name, not allocation from a pool. Identities are unique **within a
    repository**, not globally — two repositories may each have a `staging`."
  - Now: "An **environment identity** names one environment (`staging`, `pr-482`, `slot-2`).
    Claiming takes one of two forms, and both are atomic. A **fresh claim** creates the record
    and is mutual exclusion on the name: it succeeds only if no record exists. A **pool claim**
    — available only where a repository has enabled pooling (feat-007) — takes over an
    environment that already exists: one conditional transition of a warm slot's record from
    `warm` to `active`, recording the **claimant** pull request; it succeeds only if the record
    was still `warm` at that version. Identities are unique **within a repository**, not
    globally — two repositories may each have a `staging`."

- **The state paragraph.**
  - Was: "An environment record is in exactly one **state**: `active` (in use, must not be
    destroyed) or `released` (eligible for teardown)."
  - Now: "An environment record is in exactly one **state**: `warm` (skyhook's own, built or
    being built ahead of any pull request, claimable once the record carries a deployed
    commit), `active` (in use, must not be destroyed), or `released` (eligible for teardown).
    Only pooling (feat-007) creates `warm` records; an installation with pooling off never
    holds one."

- **AC-14** — one clarifying addition, no existing sentence changes.
  - Was: "A run triggered by a pull request derives its environment identity from the trigger
    and refuses any identity supplied to it. […]"
  - Now: same text, with this sentence appended: "With pooling enabled, what the trigger
    derives is the run's claimant identity; the environment the run acts on may be a warm slot
    whose own identity was fixed when the slot was built, and the record's claimant — never
    the slot's name — says which pull request that is."

- **AC-16** — the refusal contract names the pool claim as the non-refused path.
  - Was: "Claiming an identity whose record exists is refused, whether that record is `active`
    or `released`, and the two refusals are distinguishable from each other. A name becomes
    claimable only once its record is deleted."
  - Now: "A fresh claim of an identity whose record exists is refused, whether that record is
    `warm`, `active`, or `released`, and the refusals are distinguishable. A name becomes
    freshly claimable only once its record is deleted. The pool claim is not that refused
    case: it never creates a record, and it succeeds precisely and only on a record still in
    `warm`."

## ADDED

- **AC-38:** The registry exposes the pool claim as one conditional operation: given a warm
  slot's record at an observed version, it transitions `warm` → `active` and records the
  claimant, or fails observably if the record moved. Under concurrent attempts on the same
  slot exactly one succeeds — proven against the fake store's contention and expressed through
  the store contract's compare-and-swap, never a provider mechanism.
- **AC-39:** A `warm` record is distinguishable by inspection as build-in-progress (no
  deployed commit) or claimable (deployed commit and URL present); after a pool claim the
  record additionally carries its claimant, and every consumer that today derives a pull
  request from the identity can obtain it from the claimant for pooled environments.

## REMOVED

- Nothing. Every existing guarantee — record-before-resource, cap counting by key, protection
  outside the record, the delete freeing the name — stands unchanged over the widened enum.
