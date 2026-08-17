# Drift ledger — backing-store (feat-001)

> GENERATED and APPEND-ONLY. Written solely by the `converge` skill. Never hand-edit, never
> renumber a run or a gap id, never rewrite a prior block. A correction to a past entry is a new
> event in the next run, with a note.
>
> This ledger records the code measured against `spec.md`, `plan.md`, `tasks.md`, and the shared
> non-negotiables. `analyze` checks the artifacts against each other; this checks them against
> what was actually built.

## run 1 — 2026-08-14

baseline: spec.md sha256:72f14e79cd40 · plan.md sha256:66466e9bb3fa · tasks.md sha256:146957748aad

First run. No prior ledger, so every finding opens a gap; nothing to reconcile or close.

- opened gap-001 [contradicts] constitution:"Provider-agnostic core" · plan:"D6"

  `src/core/registry.ts:47` — `stateKeyFor()` returns a key ending in the literal
  `terraform.tfstate`, inside `src/core/`. The constitution requires that "Terraform-specific and
  AWS-specific logic lives behind the plugin boundary" and that "skyhook's own modules never
  import a provider SDK or special-case a provider by name". The plan's own D6 is blunter:
  "`src/core/` no import may reference S3, AWS, or Terraform". A hardcoded state-file name is
  special-casing the IaC tool by name, in the one directory that must not.

  Nothing imports a provider SDK and no adapter is imported by core, so the boundary holds
  structurally — this is the boundary leaking vocabulary rather than dependencies. A second IaC
  adapter would need a different filename and would have to reach into core to get it.

  Related evidence, same theme, not separately tracked: core is inconsistent about the storage
  container's name. `store.ts` abstracts it as `container` (`ContainerMissing`,
  `'container-missing'`), while `types.ts:49` and `install.ts:107,122` call it `bucket` — S3's
  word for it, and absent from the product glossary.

- opened gap-002 [partial] spec:"AC-5"

  AC-5: "Two concurrent attempts to claim the same environment identity result in exactly one
  success." Evidence: `src/adapters/aws/s3-store.ts` (retry budget) → `src/core/registry.ts`
  (`claim`, the `contended` outcome).

  The safety half is fully implemented and now verified against real S3 (`hs-1`: 950 concurrent
  claims, never two winners). The liveness half is not guaranteed: when the store exhausts its
  retry budget against repeated conflicts, `claim()` returns `contended` and a round can end with
  **zero** winners, where AC-5 says exactly one.

  This is a knowing trade, not an oversight — it is the correct reading of a 409, and reporting a
  free name as "already held" would be worse. It is recorded in plan D2c and was raised by the
  pre-build check as an artifact-level finding. The gap is that `spec.md` still promises more than
  the code delivers.

  Note the direction: the spec over-promises, so nothing depending on the stated guarantee is
  unsafe. The fix is to narrow AC-5 to the safety property and name the indeterminate outcome.

- opened gap-003 [unrequested] code:"bucket hardening beyond AC-8"

  `terraform/bootstrap/storage.tf` — `aws_s3_bucket_policy.skyhook` denies all access when
  `aws:SecureTransport` is false, and `aws_s3_bucket_ownership_controls.skyhook` sets
  `BucketOwnerEnforced`. AC-8 asks only that registry data be encrypted at rest and that the
  bucket deny public access. Neither of these is requested anywhere in spec, plan, or tasks.

  Both are defensible — HTTPS-only closes a plaintext downgrade, and disabling ACLs means every
  grant in the installation is an IAM policy, so there is one place to read. Recorded because
  unrequested is unrequested, and a later reader should find them accounted for.

- opened gap-004 [unrequested] code:"environment identity length cap"

  `src/core/identity.ts:48,70` — `MAX_IDENTITY_LENGTH = 63` rejects any identity longer than 63
  characters. No artifact states a length bound; the spec constrains an identity only by
  uniqueness within a repository and by the characters that keep it inside its key prefix.
  A maintainer naming a long-running environment would meet a refusal the spec never mentions.

  The bound is probably right — it matches the DNS label limit a hostname derived from an
  environment would eventually hit — but it is undocumented, and the number is unexplained in the
  code as well.

- opened gap-005 [unrequested] code:"explicit deny on the privileged role"

  `terraform/bootstrap/roles.tf` — `DenyEverythingOutsideThisRepository` puts an explicit deny on
  the **default-branch** role. The constitution requires an explicit deny only on roles reachable
  from a pull request's branch; extending it to the privileged role is defence in depth nobody
  asked for. Benign, and arguably what a reviewer would want, but unstated.

verdict: open 5 (missing 0, partial 1, contradicts 1, unrequested 3)

## run 2 — 2026-08-14

baseline: spec.md sha256:e5bc37cb1e2d · plan.md sha256:80460f5b691a · tasks.md sha256:ba44a7b361be

Remediation run. Every gap run 1 opened has been routed and closed — one through the defect lane,
four through a spec change. No new findings.

- closed gap-001 [contradicts]

  Fixed as a defect, no delta: the spec was already right. `stateKeyFor()` is gone from
  `src/core/registry.ts`; core now exposes `stateDirFor()`, which yields
  `state/<repo>/<identity>/` and stops. `src/adapters/terraform/state-key.ts:27`
  (`terraformStateKeyFor`) appends the filename, creating the IaC adapter seam the constitution's
  plugin boundary asks for. Re-audit finds no reference to Terraform or `tfstate` anywhere in
  `src/core/`. Regression test: `tests/registry-keys.test.ts` — "feat-001/AC-7 gap-001 the
  provider-agnostic core never names the IaC tool" — asserts core's half never matches
  `/terraform|tfstate/`, so this cannot silently return. Plan D6's layout now lists the adapter.

  The related vocabulary observation recorded under gap-001 (core calling the container `bucket` in
  some places and `container` in others) was reviewed and deliberately not changed. `bucket` is
  generic storage vocabulary rather than a provider name — Google and MinIO use it too — and the
  config-facing field genuinely names the bucket the operator creates. Carried as a nice-to-have in
  `analyze.md` (N5) rather than a gap, to be settled in the glossary before a second cloud adapter
  exists. Recorded here so a later reader finds it decided rather than missed.

- closed gap-002 [partial]

  Closed by `changes/chg-003`, which narrowed AC-5 rather than changing the code. The criterion now
  states the safety property unconditionally — no two attempts both succeed, however many run — and
  names the unresolved outcome explicitly, so a caller retries instead of concluding the identity is
  taken. The matching scenario moved with it. The code was correct throughout; the sentence was not.

- closed gap-003 [unrequested]

  Legitimized by `chg-003`. AC-8 now requires what the bucket already did: encryption at rest, no
  public access, no unencrypted transport, and access granted only by policy with per-object access
  control lists disabled. `tests/bootstrap-terraform.test.ts` asserts the transport deny and
  `BucketOwnerEnforced` under the `feat-001/AC-8` citation.

- closed gap-004 [unrequested]

  Legitimized by `chg-003` as AC-20. The 63-character bound is now a stated requirement, the
  constant explains itself in `src/core/identity.ts` (it is the DNS label limit, and an identity
  reaches hostnames long before anything checks), and `tests/identity.test.ts` asserts 63 accepted
  and 64 refused under the `feat-001/AC-20` citation.

- closed gap-005 [unrequested]

  Legitimized by `chg-003`. AC-17 now covers both roles: neither can reach an installation that is
  not its own. `tests/bootstrap-terraform.test.ts` asserts the privileged role's explicit deny under
  the `feat-001/AC-17` citation.

verdict: open 0 (missing 0, partial 0, contradicts 0, unrequested 0)

## run 3 — 2026-08-14

baseline: spec.md sha256:ed3153e87503 · plan.md sha256:132354801ecb · tasks.md sha256:cd1035096207

Audit of the bootstrap command added by `changes/chg-004`. Nothing reopened; nothing new opened.

Re-checked the two things run 1 and run 2 established, because this run added a new adapter and a
new command and either could have undone them:

- The provider-agnostic core is still clean. No reference to Terraform, `tfstate`, or AWS remains
  anywhere under `src/core/`, and core still imports no adapter. The new Terraform and AWS code
  lives in `src/adapters/`, and the command that orchestrates them lives in `src/cli/` — which
  depends on core and the adapters, never the reverse.
- AC-1 is unchanged and still true: `init` writes and applies nothing. The new command is separate
  precisely so that stays true. A change that widened `init` instead would have shown up here as a
  contradicts against AC-1.

Both new criteria are implemented and tested: AC-21 (`src/cli/bootstrap.ts` — settings from the
configuration, plan before apply, nothing without confirmation) and AC-22
(`src/adapters/aws/oidc-provider.ts` — the trust-anchor case determined rather than asked). Both
were additionally exercised against a real account: one run applied, a second detected the existing
trust anchor and reported no changes.

No unrequested behaviour found in the new code. The one judgement call — shelling out to the AWS
CLI rather than signing a request — is argued in plan D1a and recorded as a nice-to-have in
`analyze.md` (N6) rather than a gap, since it is a stated decision rather than an unstated one.

verdict: open 0 (missing 0, partial 0, contradicts 0, unrequested 0)

## run 4 — 2026-08-14

baseline: spec.md sha256:28dc7801f6e1 · plan.md sha256:946a3ea907c8 · tasks.md sha256:da119ca081ff

Audit of the two-phase bootstrap added by `changes/chg-005`. Nothing reopened; nothing new opened.

This run had a specific thing to look for. `chg-005` came from a real failure — a deleted working
tree stranding live resources — and the fix touches the command that creates a repository's cloud
footprint. A change like that is where unrequested behaviour and boundary erosion usually appear.

- The provider-agnostic core is untouched: no reference to Terraform, `tfstate`, or AWS anywhere
  under `src/core/`, and core still imports no adapter. The bucket lookup went to
  `src/adapters/aws/`, the backend handling to `src/adapters/terraform/`, and the sequencing to
  `src/cli/` — the same three-way split the previous runs established.
- AC-1 still holds after being modified: `init` writes one more file and still applies nothing.
- AC-23 and AC-24 are implemented and tested. AC-24 is the interesting one: it was already true
  before this change, because the bootstrap state key falls outside every prefix either role is
  granted, but nothing said so and nothing tested it. It is now a stated requirement with a test
  asserting no policy statement names the `bootstrap/` prefix — so a later policy change that
  reached into it would fail rather than quietly succeed.
- Both were additionally verified against a real account: the `deadweight` installation's stranded
  local state migrated into the bucket, and `git add -n` confirms the lock file is tracked while no
  state file is.

No unrequested behaviour found. The `.gitignore`'s contents are the one place a reviewer might
expect scope creep — it keeps `.terraform.lock.hcl` explicitly rather than ignoring everything
Terraform-shaped — and that inclusion is argued in D3b and asserted by a test, so it is a decision
rather than a leftover.

verdict: open 0 (missing 0, partial 0, contradicts 0, unrequested 0)

## run 5 — 2026-08-14

baseline: spec.md sha256:63c2b4ae28a3 · plan.md sha256:e29565718469 · tasks.md sha256:832796942ce5

Audit of the removal command added by `changes/chg-006`. Nothing reopened; nothing new opened.

A destroy command is where an audit should look hardest, so this run checked three things
specifically rather than sweeping generally:

- **Can the "no orphans" refusal be got past?** No. `--yes` is checked after the registry scan and
  cannot reach it, there is no `--force`, and a test asserts the refusal survives an operator who
  confirms. Verified against the real account too: a planted environment record produced the
  refusal by name and left the bucket and both roles intact.
- **Can it destroy something skyhook did not create?** No. What is destroyed is what is in state,
  and the `create_oidc_provider` value passed to destroy is read from `terraform state list` rather
  than from a flag or an assumption — so an adopted anchor, which was never a resource, cannot be
  reached. This is `chg-002`'s adopt-versus-create decision paying off unchanged in a feature
  written three changes later.
- **Did the provider-agnostic core absorb any of this?** No. `src/core/` still names no provider
  and imports no adapter. The bucket operations went to `src/adapters/aws/`, the state operations to
  `src/adapters/terraform/`, and the sequencing to `src/cli/` — and `destruct` reuses core's
  `identityFromRegistryKey` to interpret what the adapter fetched, which is the split working as
  intended rather than by accident.

One judgement call recorded rather than left implicit: emptying the bucket is skyhook's own work
instead of `force_destroy = true` on the bucket resource. `force_destroy` would have given every
ordinary apply the power to wipe the registry, for the sake of one command that runs once. Argued
in D8.

Not a gap, but noted for the next run and carried in `analyze.md` as N7: the full destroy path has
never run against a live account. Only the refusal has.

verdict: open 0 (missing 0, partial 0, contradicts 0, unrequested 0)

## run 6 — 2026-08-14

baseline: spec.md sha256:63c2b4ae28a3 · plan.md sha256:e29565718469 · tasks.md sha256:e03716b87309

Triggered by running the removal command against a live account for the first time. It failed
part-way through, which makes this the most useful run in the ledger so far.

- opened gap-006 [contradicts] spec:"AC-27"

  `terraform init -backend=false` does not make Terraform work against local state. It skips
  backend *initialization*, so the next command refuses with "Backend initialization required".
  AC-27 requires that removal take the state out of the storage before removing it; the code
  asked for that and did not achieve it. The spec was right, so this took the defect lane with no
  delta.

  Both commands now write a `*_override.tf` declaring `backend "local" {}` — the mechanism that
  actually relocates state — and clear it once the state should no longer be local. The override
  handling moved into `src/adapters/terraform/runner.ts`, beside the tool whose loading rules make
  it work.

  **It was two defects, not one.** The same flaw had been in `bootstrap`'s first-run pass since
  `chg-005` declared the backend, and had never fired because every real run after that had an
  existing bucket and took the other branch. A first-time install would have failed. Found only
  because a removal forced a fresh install afterwards.

  Regression tests assert the override is present while the state must be local, absent afterwards
  including on failure, and that `-backend=false` appears nowhere. Verified end to end against the
  real account: a clean first-run bootstrap created ten resources and migrated its state into the
  bucket; destruct then removed all ten, left the `fieldrep` trust anchor and its tags intact, and
  left no override in the working tree.

- closed gap-006 [contradicts]

  Opened and closed in the same run, recorded in both halves rather than omitted, because the
  failure is the useful part of this entry. Closure evidence is the fix and the regression tests
  described above, plus the end-to-end run against the real account.

**A note on what tests can and cannot do here**, recorded because it will matter for the deploy
feature too. Every test passed while both defects were live, and no reasonable test would have
caught them: an injected command runner proves what skyhook *asks* an external tool to do, never
whether the tool accepts it. Wherever skyhook drives a binary it did not ship, a real run is the
only thing exercising that layer. This is the same reasoning that made `hs-1` a human-gated check
against real S3, and it applies to `terraform` and `aws` equally. Carried as N7 in `analyze.md`.

verdict: open 0 (missing 0, partial 0, contradicts 0, unrequested 0)

## run 7 — 2026-08-15

baseline: spec.md sha256:91d67ad653c3 · plan.md sha256:f92df0111722 · tasks.md sha256:bfaa4377130b

First run since 2026-08-14, and the artifacts moved a long way in between: `chg-007` (the deploy
contract), `chg-008` (the one state key the infrastructure tool insists on reading) and `chg-009`
(the subject a run presents) were all folded into `spec.md`, taking it from 27 acceptance criteria
to 34, and the constitution was amended to name the exception `chg-008` had created. Run 6's open
set was empty, so everything here is measured fresh against a spec that now describes considerably
more of the system.

**The headline is what did NOT open.** Three folds landed in one day, and behaviour that had been
running live without any criterion describing it — the subject lookup, the state-key read, the
deploy contract's record and configuration additions — is now specified rather than merely working.
An audit run before those folds would have opened four or five `unrequested` gaps. It opens none.

- opened gap-007 [partial] spec:"AC-32"

  AC-32: "The bootstrap determines for itself which form of OIDC subject a run in this repository
  will present ... Where the host will not disclose it — the setting is readable only by a
  repository administrator — skyhook uses the conventional form, which is correct wherever that
  form applies and is announced rather than assumed (AC-33) wherever it might not be. So an
  operator who has never heard of the setting installs skyhook correctly without knowing it
  exists, and an operator who cannot read it is told what was assumed on their behalf."

  Both mechanisms are implemented. `src/adapters/github/repository-ids.ts:72` treats a 403 or 404
  as a fallback rather than a failure, and `src/cli/bootstrap.ts:113` prints
  `Subject: <prefix> (the conventional form; GitHub did not state one)` before anything is applied.
  Six unit tests cover the five outcomes, and four more cover what the command says.

  What is partial is the operator's way out. `src/cli/bootstrap.ts:98` reads `GH_TOKEN` or
  `GITHUB_TOKEN` if either is set, and **nothing tells anyone that** — `src/cli/main.ts:64-73`
  documents the bootstrap's options and credentials and mentions only AWS. So the one operator the
  fallback actually hurts, in an organization that qualifies its subjects, is told what skyhook
  assumed but not that a token with repository admin would have avoided the assumption, nor that
  the assumption is about to refuse every role assumption they attempt.

  The announcement satisfies AC-33 literally: the operator is told which form was used and that
  the host did not state it. It does not satisfy AC-32's promise that such an operator "is told
  what was assumed on their behalf" in any sense they can act on — a neutral parenthetical reads
  as a fact, not a warning, and the symptom it precedes is an access-denied that names nothing.

  Routed to `tasks.md` phase 14 as a remediation task, not to `change`: the criterion is right and
  the code is incomplete against it. `readiness.tasks` returns to `draft`.

**Observed, deliberately not opened as a gap:** `src/core/config.ts:94` emits the operator-facing
message *"storage: required — name the bucket the bootstrap Terraform declares"*, naming the IaC
tool from inside `src/core/`. `src/core/types.ts:3` states the local rule as "nothing in
`src/core/` may name S3, AWS, or Terraform", which this breaks; plan D6 states the same rule as
"no import may reference S3, AWS, or Terraform", which it does not. No logic is coupled and no
import crosses the boundary, so the constitution's *provider-agnostic core* is intact — this is the
same class as the `bucket` vocabulary question run 2 reviewed and decided. Recorded so a later
reader finds it decided rather than missed. The thing worth settling, when a second IaC adapter is
nearer than it is now: `types.ts`'s header overstates the rule the codebase actually follows, and
either the comment should match D6 or the message should stop naming the tool.

**Re-checked and still clean:** the bootstrap's own state remains unreachable by either role
(AC-24 — no grant in `roles.tf` names the `bootstrap/` prefix); `--yes` still cannot get past the
no-orphans refusal (AC-25, decided in run 5); and core imports no adapter (AC boundary, gap-001's
regression test still green).

verdict: open 1 (missing 0, partial 1, contradicts 0, unrequested 0)

## run 8 — 2026-08-16

baseline: spec.md sha256:91d67ad653c3 · plan.md sha256:f92df0111722 · tasks.md sha256:507b27bbda73

Targeted re-audit of run 7's single open gap. `spec.md` and `plan.md` are unmoved since run 7 —
this remediation was a defect against a criterion that was already right, so nothing was specified
differently. Only `tasks.md` changed, by the task closing.

- closed gap-007 [partial]

  AC-32's promise that an operator "who cannot read it is told what was assumed on their behalf"
  now holds in a sense that operator can act on. Two changes, both to what skyhook says:

  `src/cli/main.ts:70-80` — the bootstrap's usage text states that GitHub is asked which form of
  OIDC subject this repository's runs present, that `GH_TOKEN` or `GITHUB_TOKEN` is used if set,
  that reading the setting needs repository admin, and what a wrong assumption looks like when it
  lands. Previously the section named AWS credentials and nothing else, so the token was read by a
  command that never mentioned it.

  `src/cli/bootstrap.ts:109-125` — the fallback line changed from
  `(the conventional form; GitHub did not state one)` to `(ASSUMED — GitHub did not say)`,
  followed by three lines naming the consequence and the remedy. The old wording was true,
  neutral, and useless: it stated a fact where the reader needed a warning, and the person who
  receives it is by definition the person who could not check it.

  Regression tests: `tests/bootstrap-command.test.ts` — the fallback test now cites
  `feat-001/AC-32` and `gap-007` and asserts the two halves that make the announcement act (what
  breaks, and what to do instead) rather than merely that an announcement exists, which the old
  wording would also have satisfied. A second test asserts the warning stays OFF the healthy path,
  where GitHub answers and there is nothing to act on — advice on a path that is working is how
  operators learn to skim past advice.

  Verified by rendering the real help output, not only by the suite: the section reads as written.

**Nothing else moved.** The observation recorded in run 7 — `src/core/config.ts:94` naming the IaC
tool in an operator-facing message, and `src/core/types.ts:3` stating a stricter rule than plan D6
does — is unchanged and remains deliberately not a gap.

verdict: open 0 (missing 0, partial 0, contradicts 0, unrequested 0)
