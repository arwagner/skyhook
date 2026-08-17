# Delta — dashboard / chg-002 — against spec.md as of 2026-08-17

## ADDED

- **AC-8:** A record in state `warm` renders as its own visible condition — distinguishable
  at a glance from in-use, reclaimable, and protected: "warm — claimable" when it carries a
  deployed commit, "warm — building" when it does not. A claimed slot (state `active` with a
  claimant) shows its claimant's pull request number in the listing's PR column and in the
  detail view, sourced from the record's claimant field; every other row keeps deriving the
  number from the identity alone. The freeable glance is unchanged: a warm slot is never
  shown reclaimable. Verified by rendering fixtures through the pure model/renderer.

## MODIFIED

- **AC-1** (the PR number is derived, never stored) — one clarifying addition: for pooled
  slots the claimant is an explicitly recorded field (feat-001/AC-39) and is the one
  sanctioned second source; an identity that is neither `pr-<n>` nor a claimed slot still
  renders with no number rather than a guessed one.

## REMOVED

- Nothing.
