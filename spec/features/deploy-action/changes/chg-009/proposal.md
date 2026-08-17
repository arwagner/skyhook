# Proposal — deploy-action / chg-009 — the deploy path learns to claim a warm slot

**Trigger:** the warm-slot-pool feature (feat-007), approved 2026-08-17 (its od-4 build-order
gate), alongside backing-store `chg-012`. feat-007 has a pull-request run take over a pre-built
environment — a warm slot — instead of provisioning from scratch, falling back to the
from-scratch path when none is claimable. This feature owns the deploy path and the credential
language that confines it, and both currently assume the environment a run touches is the one
its trigger derives.

**Summary:** two amendments, both consciously widening what a decided clause says. First, the
**ephemeral namespace** is defined to comprise pull-request identities (`pr-<n>`) and warm-slot
identities (`slot-<n>`); everything outside it stays refused by the cloud exactly as before.
Second, the **narrowing choreography** gains one step where pooling is enabled: before
narrowing, a run may read the repository's slot records and attempt the pool claim; the acting
narrowing then pins the single environment the claim resolved — the claimed slot on the warm
path, the derived identity on the cold path — and it still happens before the repository's own
infrastructure code runs, which is the guarantee that mattered all along (AC-19's "narrowed
before the repository's Terraform runs"). Reading warm siblings' records pre-claim is new reach
inside the namespace, and it is priced honestly: consistent with the constitution's standing
"preview environments are not isolated from each other" decision, and slot records hold
deployment metadata only. The deploy sequence itself (record-before-resource, refuse-missing
inputs before the claim, update-after-apply) is unchanged in order; the pool claim slots in
where the fresh claim sits today.

## Blast radius

- **Build ordering:** folds only with feat-007's build; nothing in feat-007 is built before
  this delta, backing-store `chg-012`, and the product-global glossary amendment land —
  feat-007 od-4.
- Requirements affected: **the confinement paragraph** ("A pull request's credentials are
  confined to ephemeral environments…") — gains the namespace definition and the pre-claim
  read; **AC-19** — the issuance-time wording is amended so the acting narrowing is pinned
  after claim resolution and before the infrastructure tool runs, with the pool-record read
  and conditional-claim writes named as issuance-time grants where pooling is on. New
  **AC-27** (the choreography: read slots → claim or fall through → narrow to the resolved
  environment → only then the apply).
- Design decisions affected: none rewritten; the broker's open/narrow seam already computes
  credentials per environment and gains the two-phase shape behind the same port.
- Tasks affected: none regenerated now; build tasks arrive with feat-007's plan, one build.
- Already-built code affected (at build time): the deploy orchestration's claim step, the
  session-policy narrowing, the scaffolded workflow's documentation of the pool phase, and
  the fork/trigger gates (unchanged in behavior, re-verified).
- Beyond this feature: backing-store `chg-012` (the record contract), product-global's
  glossary amendment, feat-007 (all pool behavior), and an additive `extends` on the teardown
  feature for the sweep's pool phase, annotated on feat-007's manifest.

## Status
- [ ] delta reviewed (analyze)
- [ ] implemented & verified (lands with feat-007's build)
- [ ] folded into spec.md
