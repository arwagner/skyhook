# Proposal — backing-store / chg-011 — the record remembers what was deployed into it

**Trigger:** the dtak-prototype adoption analysis, 2026-08-17. The first consuming repository whose
infrastructure takes runtime artifacts — a container image tag, a sidecar image URI — exposed a gap
that is general, not dtak's: a deploy's dynamic inputs reach Terraform through the calling
workflow's environment (`TF_VAR_<name>`), which works exactly once. Teardown and the sweep re-run
the definition later, in a different workflow run, where those variables no longer exist — so a
definition with a required artifact variable deploys cleanly and then cannot be destroyed. The
failure is silent until the first teardown, which is the worst place for it to first speak.

**Summary:** the registry already answers "what code is deployed" with a commit. An artifact
reference is the same kind of fact — part of what is deployed, not how — and it belongs in the
same place under the same discipline. This change gives the store two things: a configuration
setting (`deploy.inputs`) in which a repository declares, on its default branch, the names of the
Terraform variables its deploys carry; and room on the environment record for those variables'
recorded values, updated only when the commit is — after a successful apply. Reading the values at
deploy time and replaying them at destroy time are the deploy action's and teardown's changes
(feat-002 `chg-007`, feat-003 `chg-001`); this feature owns the settings file and the record, so
the declaration and the field land here. The split mirrors `chg-007` (the deploy contract), where
the record's URL field and the deploy settings landed on this feature for the same reason.

The declaration is an explicit list, deliberately. Recording every `TF_VAR_*` the environment
happens to hold would sooner or later capture a secret someone passed through it, and the registry
stores deployment metadata only. An explicit list read from the default branch also means a pull
request cannot widen what gets recorded from its own branch — the same property every other
setting already has (AC-9).

## Blast radius
- **Build ordering (added after the pre-build check):** nothing in this change is built before
  `product-global.md`'s privacy enumeration names declared deploy input values — od-3 on the
  manifest, its own main-branch commit. The same ordering binds the sibling changes (feat-002
  `chg-007`, feat-003 `chg-001`, feat-005 `chg-001`).
- Requirements affected: new **AC-35** (configuration declares the deploy's input names — capped
  at 16, identifier-shaped, sensitive names refused without a per-name exception), new **AC-36**
  (the record carries their recorded values, under the commit's own update discipline, as a
  wholesale replace), new **AC-37** (a human can redact one recorded value without touching the
  environment).
  No existing criterion changes: AC-28 (the URL field) and AC-31 (the deploy settings) are the
  pattern being followed, not text being edited.
- Design decisions affected: **D2** (the record gains a second follows-the-apply field), **D5a**
  (configuration grows one setting). Neither is rewritten; each gains the addition.
- Tasks affected: none regenerated; new phase 16, whose items are built alongside feat-002's
  `chg-007` — the consuming code and the contract change travel in one build, as phase 11 did.
- Already-built code affected: `src/core/types.ts` (DeployConfig, the record), `src/core/config.ts`
  (parse and validate `deploy.inputs` — the identifier check is the generic character class, so no
  Terraform knowledge enters the provider-agnostic core), `src/core/registry.ts` (read/write the
  field, redact one value), `src/cli/main.ts` (the `redact` verb on the manual-dispatch surface),
  `tests/config.test.ts`, `tests/registry.test.ts`, `tests/fake-store.ts`. The setting and the
  field are both absent-tolerant, so an installation that declares no inputs — and every record
  written before this change — keeps working unchanged.
- Beyond this feature: `product-global.md`'s privacy requirement enumerates what the registry
  stores, and recorded input values add a category to that enumeration. A cross-cutting input is
  amended only through its own main-branch commit, never inside a feature change — the od-3
  precedent — so it is carried as an open decision (od-3 on this feature's manifest), to land
  before this delta folds.

## Status
- [x] delta reviewed (analyze) — 2026-08-17, two rounds: blocking-hard on the security findings,
      remediations folded into the delta the same day, re-gate pass
- [x] implemented & verified — 2026-08-17, in the joint declared-inputs build, test-first;
      every task checked off with its trace token
- [x] folded into spec.md — 2026-08-17
