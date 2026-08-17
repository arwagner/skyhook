# Delta — warm-slot-pool / chg-002 — against spec.md as of the 2026-08-17 gate

## MODIFIED

- **Scenario: the claimant's pull request closes** — the close path's ending is stated
  honestly.
  - Was: "Then the slot is released and destroyed exactly as an ephemeral environment is
    today, its record deleted only after verified destruction — and it is never handed to
    another pull request without that destroy and a fresh build"
  - Now: "Then the slot is released and destroyed by the close event as far as a
    pull-request run can go — infrastructure destroyed, emptiness verified, state deleted —
    and the record's removal is deliberately left: deleting a slot record is precisely the
    act AC-11 has the cloud refuse this run, so the record stays `released`, the run reports
    the deferral and succeeds, and the scheduled sweep removes it within one interval (the
    bound AC-8 already promises). A slot is never handed to another pull request without
    that removal and a fresh build."

## REMOVED

- Nothing. AC-8 stands as written; the sweep is the actor for its record-deletion clause on
  the close path.
