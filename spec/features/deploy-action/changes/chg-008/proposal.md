# Proposal — deploy-action / chg-008 — hand back every output, not just the address

**Trigger:** the dtak-prototype adoption analysis, 2026-08-17 — the last skyhook-side blocker it
found. dtak's deploy is not finished when the apply is: the workflow must sync a web bundle to the
environment's bucket and invalidate its CDN distribution, and those identifiers are Terraform
outputs of the environment just applied. Skyhook reads the definition's outputs already (that is
where `url` comes from) and then discards all but one, so a workflow with post-apply steps is
forced to re-derive facts skyhook was holding a moment earlier.

**Summary:** the run hands back every root output the definition declares, as one JSON document in
a new `outputs` action output; the calling workflow picks what it needs with `fromJSON`. This is
the URL philosophy generalized, not changed: skyhook reads outputs and hands them to the calling
workflow, decides nothing about them, writes nothing to the pull request, and owns no format
beyond the JSON Terraform itself produced. `url` keeps its own output and remains the only output
recorded in the registry — nothing here touches the record, so the backing store, teardown, and
the dashboard are unaffected and this change is one feature's alone.

One rule with teeth: an output the definition marks **sensitive** is omitted from the document and
named as omitted, because `GITHUB_OUTPUT` hands a value to every later step and a workflow log
`echo` away from disclosure — the definition said this value deserves care, and skyhook does not
overrule it. A workflow that genuinely needs a sensitive value can read it from Terraform itself,
inside its own steps, on its own responsibility.

## Blast radius
- Requirements affected: new behavior paragraph (beside "Skyhook does not write to the pull
  request"), new **AC-24** (every non-sensitive root output handed back as one compact JSON
  document; sensitive ones omitted by name; `{}` for no outputs, `""` on skip and failure),
  new **AC-25** (the shared `GITHUB_OUTPUT` writer is injection-proof and never logs the raw
  parse — a hardening the pre-build check surfaced, covering `url` too), new **AC-26** (an
  oversized document truncates to a marker rather than failing a successful deploy). AC-13 and
  AC-15 are the pattern being generalized, not text being edited.
- Design decisions affected: **D10** ("the URL is an output skyhook reads, never a variable
  skyhook injects") gains a sibling paragraph; no decision is rewritten.
- Tasks affected: none regenerated; new Phase 13.
- Already-built code affected: `src/adapters/terraform/environment.ts` (`#readUrl` widens to
  reading the whole document once), `src/core/ports.ts` (DeployOutcome carries the outputs),
  `src/core/deploy.ts` (pass-through), `src/cli/deploy.ts` (write the JSON to `GITHUB_OUTPUT`),
  `action.yml` (declare the output), `tests/deploy-adapters.test.ts`, `tests/deploy.test.ts`,
  `tests/deploy-command.test.ts`. The registry record is untouched, so no feat-001 change and no
  interaction with the privacy enumeration: these values live only in the run, the same place the
  workflow could already put them by running `terraform output` itself.

## Status
- [x] delta reviewed (analyze) — 2026-08-17, blocking-hard on the security pass (a live
      delimiter-injection weakness in the shared output writer), remediated and re-gated pass
      the same day
- [x] implemented & verified — 2026-08-17, Phase 13 test-first; AC-24/25/26 each traced
- [x] folded into spec.md — 2026-08-17
