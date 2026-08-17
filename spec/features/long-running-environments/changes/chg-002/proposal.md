# Proposal — chg-002: protecting an ephemeral environment is a feature, not an accident

**Trigger:** the drift ledger's gap-003 (converge run 1, 2026-08-16): `skyhook protect` /
`skyhook unprotect` deliberately accept a `pr-*` name, and no artifact asked for it. Ruled by the
owner on 2026-08-17: allow it — a human may latch a pull-request preview against the close event
and the sweep, for example to hold one alive through a demo.

**Summary:** legitimize what the code already does. The namespace fence guards *creating*
long-running environments, not *marking* existing ones; teardown (feat-003) already honors a mark
on an ephemeral environment, and the cloud already refuses every pull-request run a mark write —
only a default-branch human action can set or clear one. The delta adds one criterion (AC-12 on
fold) so the behavior is chosen by an artifact rather than by code.

## Blast radius
- Requirements affected: none modified; one ADDED criterion (becomes AC-12 on fold). No tension
  with the namespace refusal (AC-3): that criterion governs deploys, not marks.
- Design decisions affected: plan D6 already describes the command surface; no change.
- Tasks affected: one new task (6.4) — a citing regression test; no code change.
- Already-built code affected: none (`src/cli/protect.ts` already behaves this way).

## Status
- [x] delta reviewed (analyze — re-gated with the fold, 2026-08-17)
- [x] implemented & verified (behavior pre-existing; citing test added)
- [x] folded into spec.md
