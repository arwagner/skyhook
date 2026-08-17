# Delta — warm-slot-pool / chg-001 — against spec.md as of the 2026-08-17 gate

## MODIFIED

- **AC-11** — the cloud-refused delete list drops the slot's stored state.
  - Was: "Refused by the cloud: any delete of a slot's record, its stored state, or its
    protection mark — the pull-request role holds no delete on the slot namespace, so a
    destroy is impossible however skyhook's code misbehaves."
  - Now: "Refused by the cloud: any delete of a slot's registry record or its protection
    mark — the pull-request role holds no delete on either, so freeing a slot's name is
    impossible however skyhook's code misbehaves, and a recorded slot is always a slot the
    sweep can find and destroy. Slot *state* deletes are granted, because the
    infrastructure tool's locking and state maintenance require them on every apply
    (`pr-*` state carries the identical grant today); a collaborator's run deleting a
    sibling's state is priced by the standing non-isolation decision and adds no new
    exposure class."

## REMOVED

- Nothing else changes; the guardrail half of AC-11 and its demonstration stand.
