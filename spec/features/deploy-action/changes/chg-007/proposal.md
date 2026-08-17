# Proposal — deploy-action / chg-007 — declared inputs: record the artifacts a deploy carried

**Trigger:** the dtak-prototype adoption analysis, 2026-08-17. dtak's infrastructure takes a
container image tag; the general shape is any number of runtime artifacts a workflow computes per
deploy. They already reach the apply — Terraform reads `TF_VAR_<name>` from the environment
skyhook hands it — but skyhook neither knows nor keeps them, so the registry's answer to "what is
deployed" is incomplete, and a destroy re-running the definition later has no way to supply a
required variable. Deploy works by accident; destroy breaks by design.

**Summary:** the deploy learns to read and record its declared inputs. The backing store's
`chg-011` gives configuration a `deploy.inputs` list and the record room for the values; this
change is the deploy-side behavior. Before the claim, skyhook reads `TF_VAR_<name>` for each
declared name and refuses — naming the variable — if one is missing, empty, or over the store's
length cap, so a mis-wired workflow fails before anything exists rather than applying a silent
default (deploying `:latest` because a tag variable fell back is exactly the failure the explicit
list exists to prevent). After a successful apply, the values are recorded alongside the commit,
under the commit's own discipline. The transport does not change: values travel as Terraform's
own environment variables, set by the calling workflow, and skyhook still passes no `-var` —
"without a contract term" survives intact. An undeclared variable still reaches a deploy, because
the environment is the workflow's own; what declaring buys is being recorded, and therefore
existing at destroy time.

## Blast radius
- **Build ordering (added after the pre-build check):** this change writes recorded input values
  into the registry (AC-23), a category `product-global.md`'s privacy enumeration must name first
  — feat-001's od-3, its own main-branch commit. Nothing in Phase 12 is built before it lands,
  and this delta cannot fold before it either.
- Requirements affected: new behavior paragraph (dynamic artifacts, beside the identity-contract
  paragraph); new **AC-22** (declared inputs are read before the claim, and a missing one is
  refused by name with nothing recorded and nothing applied); new **AC-23** (recorded values
  follow the apply exactly as the commit does). One new scenario each for the declared deploy and
  the missing input. AC-16 (settings read from the default branch) already covers the declaration
  and needs no amendment.
- Design decisions affected: none rewritten. The plan gains a short decision recording that the
  transport is the environment, not `-var`, and why the refusal sits before the claim.
- Tasks affected: none regenerated; new phase 12 carries the build, alongside feat-001 `chg-011`
  (the contract) and feat-003 `chg-001` (the replay) — one build, three recorded changes, the
  same shape feat-001's phase 11 took.
- Already-built code affected: `src/core/deploy.ts` (read, refuse, record), `src/cli/deploy.ts`
  (wiring), `tests/deploy.test.ts`, `tests/deploy-command.test.ts`. `action.yml` is unchanged —
  the workflow sets ordinary `env:` and the composite step inherits it.

## Status
- [x] delta reviewed (analyze) — 2026-08-17, two rounds: blocking-hard on the security findings,
      remediations folded into the delta the same day, re-gate pass
- [x] implemented & verified — 2026-08-17, in the joint declared-inputs build, test-first;
      every task checked off with its trace token
- [x] folded into spec.md — 2026-08-17
