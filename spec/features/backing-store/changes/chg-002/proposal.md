# Proposal — backing-store / chg-002 — the trust anchor may already exist

**Trigger:** applying the bootstrap to a real account for the first time (task 6.3 / `hs-2`). The
account already held a GitHub OIDC provider, created by an unrelated project.

**Summary:** an IAM OIDC provider is unique per URL per AWS account. AC-3 says applying the
bootstrap "creates the OIDC trust anchor", and in any account that already federates GitHub Actions
to AWS — which is most accounts using both — it cannot: the apply fails with `EntityAlreadyExists`.
The bootstrap now takes `create_oidc_provider`, and when false it *reads* the existing provider and
points skyhook's own roles at it without managing it.

Not managing it is the load-bearing half. The provider found in the test account belonged to another
project and carried that project's thumbprints and tags. Importing it into skyhook's state would
have let a later apply rewrite those and break the workloads already trusting it. So the requirement
is not merely "tolerate an existing provider" but "never modify one skyhook did not create", and
that deserves its own criterion rather than living as a code comment.

**Why this was invisible until now:** every test reads the Terraform as source text, and the source
was correct. Only applying it to an account that had prior history could expose it. This is the
second thing in this feature that only reality could find — the first was that `init` had no
command-line entry point.

## Blast radius
- Requirements affected: **AC-3** (modified — creates *or adopts*); one new criterion, **AC-19**
  (skyhook never modifies a trust anchor it did not create). The *Known sharp edges* note about the
  trust anchor costing one human step gains the shared-account case.
- Design decisions affected: **D3** (extended — the bucket has one owner, but the trust anchor may
  already have another). No other decision moves.
- Tasks affected: **2.4** (the bootstrap gains the variable, the data source, and the resolved ARN
  local), **4.4** (a test asserting create-or-adopt and that no role references the resource
  directly).
- Already-built code affected: `terraform/bootstrap/{oidc,variables,roles}.tf` and
  `tests/bootstrap-terraform.test.ts`. No TypeScript — the adapter boundary held.

## Status
- [x] delta reviewed (analyze) — folded ahead of the next gate run; see note in delta.md
- [x] implemented & verified — applied to account 123456789012 with `create_oidc_provider=false`;
      the adopted provider's thumbprints, client IDs and tags confirmed unchanged afterwards
- [x] folded into spec.md — 2026-08-14; AC-3 modified, AC-19 appended
