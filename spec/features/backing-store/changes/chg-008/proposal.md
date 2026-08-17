# Proposal — chg-008: the roles may read the one state key Terraform insists on touching

**Trigger:** The first deploy of a *new* environment, found live on 2026-08-15 (`feat-002`, run
31896101810). Terraform refuses to start: `Currently selected workspace "pr-2" does not exist`.

**Summary:** Both roles gain `s3:GetObject` on exactly one object — `terraform.tfstate` at the root
of the bucket, the key the S3 backend uses for the **default** workspace. Nothing else changes. No
prefix widens, no write is granted, and no other object becomes readable.

## Why this is forced

Skyhook files each environment's state at `state/<repo>/<identity>/terraform.tfstate`, using a
Terraform workspace per environment. The S3 backend files a *named* workspace under
`workspace_key_prefix`, but the **default** workspace at the bare `key` — which for this layout is
`terraform.tfstate` at the root of the bucket, outside every prefix either role is granted.

Skyhook never uses the default workspace. It does not want to. But Terraform reads that key during
`init`, before any workspace can be selected, and the refusal comes back as a 403 that stops the
run.

The obvious dodge was to name the workspace up front with `TF_WORKSPACE`, and it half-works:
Terraform then leaves the default workspace alone. It also does not *create* the workspace, so a
brand-new environment dies with the error above. The first environment only ever succeeded because
its state predated that change — a fact that hid the defect for exactly one deploy.

That leaves a circle: creating a workspace needs a successful `init`, and an `init` that has not
been told a workspace reads the default one. Something has to give, and this is the smallest thing.

## What it costs, stated plainly

It is a real widening of a pull-request run's reach, and the spec says such a run is refused
everything outside the ephemeral namespace. So this is a delta and not a defect fix.

What it buys an attacker: a `GetObject` on one key that skyhook never writes. Not a prefix, not a
wildcard, not a list. A pull request that reads it learns whatever a Terraform default-workspace
state at the root of a skyhook bucket contains, which is nothing, because nothing puts one there.
If some future feature ever *did* apply in the default workspace, this grant would matter — and
that is the thing to remember rather than this line of policy.

## Alternatives rejected

- **Skyhook writes the initial state object itself**, so the workspace exists before `init`. Needs
  no policy change at all, and was close. Rejected because it makes skyhook hand-author a Terraform
  state file, whose format carries no compatibility promise: the day it changes, skyhook breaks in
  a way that looks like a corrupt environment rather than a version skew.
- **Drop workspaces, one backend key per environment.** Forfeits `feat-002/AC-12` — the identity
  reaches the definition through `terraform.workspace` precisely so a repository need not declare
  an input variable to receive it.
- **Move the layout so the default workspace's key falls inside a granted prefix.** Not possible:
  the named path is `<workspace_key_prefix>/<workspace>/<key>` and the default is `<key>` alone, so
  no pair of values puts the default inside the prefix without moving every named environment out
  of the layout `stateDirFor()` computes.

## Blast radius
- **Requirements affected:** one added criterion. `AC-14`'s and the constitution's "refused
  everything outside the ephemeral namespace" gain a single, named exception rather than becoming
  untrue.
- **Files:** `terraform/bootstrap/roles.tf`, `tests/bootstrap-terraform.test.ts`, and
  `src/adapters/terraform/environment.ts` (which returns to selecting the workspace after `init`,
  since `TF_WORKSPACE` and `workspace select` cannot both be used).
- **Already-applied installations** need the bootstrap re-applying. The symptom otherwise is the
  error above, on the first new environment only.

## Status
- [ ] delta reviewed (analyze) — never reviewed on its own: it was written and applied inside a live
      run, under a failure that was blocking the first new environment. The re-run of the pre-build
      check after this fold is the first time it is read against the rest of the artifacts.
- [x] implemented & verified — 2026-08-15, live. Verified twice over: `pr-2` deployed where it had
      previously failed at init, and two independent environments then stood at once.
- [x] folded into the feature's spec.md — 2026-08-15, as `AC-29`, the id `chg-007` vacated when
      feat-002's `chg-001` withdrew its own AC-29.
      **The delta understated what shipped, and the folded criterion says what actually holds.** It
      described one grant: read the key. Three were needed. The role policy alone left the run
      refused, because the backend runs on skyhook's narrowed session credentials, whose inline
      policy denies everything outside the environment too — so both layers had to permit it. Even
      then it was refused, because a read of an object that has never existed comes back *forbidden*
      rather than *missing* unless the caller could also have listed it, and the infrastructure tool
      cannot tell those apart. The key had to enter both listing conditions as well, where it lists
      nothing and exists only to turn one answer into the other.
