# Proposal — teardown / chg-001 — a destroy replays the recorded inputs

**Trigger:** the dtak-prototype adoption analysis, 2026-08-17, with feat-001 `chg-011` and
feat-002 `chg-007`. A deploy's dynamic inputs (`TF_VAR_<name>` — an image tag, an artifact URI)
exist only in the run that deployed. Every destroy here re-runs the definition at the recorded
commit in a *different* run — close-triggered, scheduled, or manually dispatched — where those
variables are gone. Terraform demands a value for every variable without a default even for a
destroy, so a definition with a required artifact variable tears down never: the destroy fails,
the sweep retries it loudly forever, and a human has to work out why a variable nobody remembers
was needed.

**Summary:** the deploy now records its declared inputs' values on the environment record
(feat-002 `chg-007`), under the same discipline as the commit. This change closes the loop: every
destroy that runs the definition sets `TF_VAR_<name>` for each recorded value before the
definition runs. The record is the truth for what was deployed, so the recorded values are used
even when the default branch's declared list has since changed — an environment deployed under
yesterday's declaration still destroys with yesterday's values, which is the same reasoning that
already runs the destroy at the recorded commit rather than at today's. A record with no recorded
inputs destroys exactly as before, which covers every record written before this change. The
teardown sequence — released, destroy, state removed, record removed — is untouched; this changes
only the environment the destroy's Terraform child sees. All three starters inherit it, because
they share the machinery: the close fast path, the sweep, and the manual teardown the
long-running-environments feature added (its spec defers to this machinery by construction, so it
needs no delta of its own).

## Blast radius
- **Build ordering (added after the pre-build check):** nothing in Phase 7 is built before
  `product-global.md`'s privacy enumeration names declared deploy input values — feat-001's
  od-3, its own main-branch commit.
- Requirements affected: new **AC-15** (the destroy replays the recorded inputs; a record without
  them destroys as before). One new scenario. AC-9's loud-retried-failure path is unchanged and
  still catches the case this cannot help: an environment deployed *before* recording existed,
  whose definition requires a variable — that remains a human's job, now with a message that says
  which variable.
- Design decisions affected: none rewritten; the plan's obtain-the-definition decision (D5 in
  feat-002's vocabulary) gains a sentence: the scratch checkout's destroy environment includes
  the recorded inputs.
- Tasks affected: none regenerated; new phase 7 carries the build, in the same branch as the
  feat-001 and feat-002 changes.
- Already-built code affected: `src/core/teardown.ts`, `src/core/sweep.ts` (whatever passes the
  destroy request through), `src/adapters/terraform/environment.ts` (`destroy()` gains the
  values in its child environment), `tests/teardown.test.ts`, `tests/sweep.test.ts`,
  `tests/terraform-destroy.test.ts`.

## Status
- [x] delta reviewed (analyze) — 2026-08-17, two rounds: blocking-hard on the security findings,
      remediations folded into the delta the same day, re-gate pass
- [x] implemented & verified — 2026-08-17, in the joint declared-inputs build, test-first;
      every task checked off with its trace token
- [x] folded into spec.md — 2026-08-17
