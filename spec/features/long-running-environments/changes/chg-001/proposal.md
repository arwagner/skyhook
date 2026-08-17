# Proposal — chg-001: a close event ignores a carried environment name

**Trigger:** the feature's break run, 2026-08-17, confirmed live on deadweight run 31980769653.
The scaffolded workflow's suggested wiring (`environment: ${{ inputs.environment || 'staging' }}`)
sets `SKYHOOK_ENVIRONMENT` on every event once the push deploy is switched on. A pull request's
close event then carries a name, `skyhook teardown` takes the manual path, the manual path refuses
on the wrong ref, the run exits red, and the close fast path never tears the preview down. The
sweep repaired it — the constitution's "events are a fast path only" held — but every close run on
an affected repository fails until this is fixed. Probe P1 (`tests/probes/feat-006.probes.ts`)
reproduces it with fakes.

**Summary:** the spec is silent about an environment name arriving on a trigger that did not
choose one. Decide it: the manual teardown engages only on a manual dispatch (or an explicit
`--environment` flag typed by a human); a run triggered by a pull request ignores any carried
name and always takes its own fast path. The fix is a guard at the CLI seam; the action and the
scaffolded workflow stay as they are, because with the guard in place their unconditional
`SKYHOOK_ENVIRONMENT` export is harmless.

## Blast radius
- Requirements affected: none modified; one ADDED criterion (becomes AC-11 on fold).
- Design decisions affected: plan D5 gains the engagement rule (manual path = dispatch or explicit flag).
- Tasks affected: one new task (6.1) — the guard plus its regression test.
- Already-built code affected: `src/cli/teardown.ts` (path selection only); no core change.

## Status
- [x] delta reviewed (analyze — re-gated with the fold, 2026-08-17)
- [x] implemented & verified
- [x] folded into spec.md
