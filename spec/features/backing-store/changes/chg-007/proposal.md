# Proposal — backing-store / chg-007 — the deploy contract

**Trigger:** feat-002 (deploy-action) reached a planned, gated state and cannot be built without
eight changes to this feature. Its plan gathers them as D9 and blocks its own first phase behind
this record. Nothing here originates in the backing store's own use — every item exists because
something must actually deploy.

**Summary:** the backing store built a registry with no writers, a configuration file with no deploy
settings, and a pair of roles whose split was structural everywhere except between two pull
requests. The deploy action is the first real writer, and standing it up requires this feature to
carry four new facts (an environment's address, a count that survives narrowed credentials, an
account id, and where a repository's own infrastructure lives) and to close the one boundary it
shipped open.

They travel as **one** change rather than eight because they cannot be applied independently: the
role's trust policy names a workflow file, that workflow file is written by `init`, and what it runs
reads the configuration. Splitting them would produce three changes, none of which works alone.

The interesting one is the trust policy. `chg-001` recorded that IAM could not express a
per-pull-request boundary, because a generic OIDC provider's claims are condition keys only while a
role is being assumed and GitHub emits no session tags. That is still true — and it is now beside
the point. AWS added GitHub-specific OIDC condition keys in January 2026, so the *trust* policy can
name the reusable workflow file a job is running (`job_workflow_ref`) and refuse everything else.
The pull-request role becomes assumable only from a workflow stored on the default branch, which a
pull request cannot edit; that workflow then hands out credentials already narrowed to one
environment. The claim `chg-001` had to defer is now buildable exactly as it was written down.

The honest cost is in the other direction and is recorded rather than glossed: Terraform enumerates
workspaces by listing the state prefix, so the pull-request role's `ListBucket` condition widens to
the repository's own prefixes. A pull-request run gains the ability to see that other environments
*exist*. Every read, write and delete grant is untouched. The decision, and the reading of the
constitution it rests on, is `hs-1` in feat-002's manifest.

## Blast radius
- Requirements affected: new **AC-28** (the record carries an environment's address), **AC-29** (the
  pull-request role's trust names the workflow, not merely the event), **AC-30** (init scaffolds
  everything a deploy needs, and the order it must arrive in), **AC-31** (configuration carries what
  a deploy needs). Modified: **AC-1** (init's file set), **AC-10** (counting without reading each
  record), **AC-14** and **AC-17** and **AC-18** (all three state the pull-request-to-pull-request
  gap as open, and it closes here). One scenario modified, one sharp edge modified, one sharp edge
  removed.
- Design decisions affected: **D2** (the record gains a field), **D2a** (its KNOWN LIMIT is
  resolved, not deleted — the reasoning for why a *permission* policy still cannot name a pull
  request stands, and is why the fix needs a session policy as well as a trust condition), **D5a**
  (configuration grows). New **D9** covering the counting change.
- Tasks affected: none regenerated; new phase 11, whose items are carried out inside feat-002's
  build rather than restated here.
- Already-built code affected: `src/core/types.ts`, `src/core/registry.ts`, `src/core/config.ts`,
  `src/cli/init.ts`, `src/cli/main.ts`, `terraform/bootstrap/roles.tf`,
  `terraform/bootstrap/outputs.tf`. Both configuration additions parse as **optional**, so an
  installation written by today's `init` keeps running `bootstrap` and `destruct` unchanged — only
  a deploy requires them.
- Beyond this feature: the constitution's clause "The boundary between two pull requests is not
  structural yet, and this is deliberate" becomes stale once this is verified live. It changes
  through its own pull request, never inside a feature branch — feat-002's task 7.2.

## Status
- [x] delta reviewed (analyze) — 2026-08-14, pass; four wording findings applied to the delta
- [x] implemented & verified — built inside feat-002's run, where the code that consumes this
      contract lives; recorded as this feature's phase 11.
- [x] folded into spec.md — 2026-08-15. **The ordering condition was satisfied and then sat unnoticed
      for a day**: the note below said to fold only once feat-002's task 7.2 had merged the
      constitution amendment, that task completed, and nothing was watching for it. `AC-28`, `AC-30`
      and `AC-31` appended; `AC-1`, `AC-10`, `AC-17` and `AC-18` modified; the *init scaffolds a
      workflow that calls a feature not yet built* sharp edge removed. `AC-14`'s framing and the
      preview-boundary sharp edge were folded early, on 2026-08-14, and are unchanged here. Every
      operation struck through by feat-002's `chg-001` was skipped, including `AC-29`, whose id
      `chg-008` has taken. `AC-1`'s replacement text was folded as feat-002's `chg-001` revised it —
      one workflow file, not two.
      *Original ordering note, kept because it is why the fold waited:* the constitution states as
      current fact that the boundary between two pull requests is not structural; the moment this
      delta lands in `spec.md`, the two disagree in writing. There is no contradiction before then,
      because the constitution describes this change as the precondition for its own clause expiring.
