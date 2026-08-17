# Proposal — warm-slot-pool / chg-001 — slot state deletes cannot be cloud-refused

**Trigger:** implementation of task 7.1, 2026-08-17. The infrastructure tool's own state
locking writes a lockfile beside the state and must delete it to unlock, and every apply on
a claimed slot maintains its state objects — so the pull-request role must grant delete on
the slot *state* prefix, exactly as it grants it on `pr-*` state today. AC-11 as gated
promised the cloud refuses "any delete of a slot's record, its stored state, or its
protection mark"; the middle item is not implementable without breaking every warm claim's
re-apply.

**Summary:** narrow AC-11's cloud-refused list to the two deletes the role genuinely never
grants — the slot's registry record and its protection mark — and price the state-delete
exposure honestly: a collaborator's run can delete a sibling slot's state, orphaning its
resources from Terraform's point of view, which is exactly the standing exposure `pr-*`
state carries under the preview non-isolation decision; pooling adds no new class of it.
Record-delete refusal is what actually guards the no-orphans invariant (a slot with a
record is a slot the sweep can find), and it stands.

## Blast radius
- Requirements affected: **AC-11** (the delete list loses "stored state"; the cost gains a
  sentence), task 7.1 and task 8.1's live checklist (test record + mark deletes, not state).
- Code affected: none — this corrects the spec to what the role must be; the role lands per
  the corrected text.
- Beyond this feature: none. The constitution's fourth exception describes the claim write
  and does not enumerate state deletes; the chg-009 proposal's role-layer bullet already
  says slot state mirrors `pr-*` state.

## Status
- [x] folded into spec.md — 2026-08-17, same day, mid-build (base build not yet complete)
