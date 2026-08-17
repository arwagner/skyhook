# Tasks — Warm slot pool (feat-007)

Glyphs: `[x]` done · `[ ]` not started · `[~]` in progress · `[-]` n/a · `[H]` human-gated.
`[P]` = may run concurrently with its phase siblings. Tests precede the code they cover.

## Phase 1 — contract: types, config, identity

- [x] 1.1 Tests for the widened record and pool config: `warm` in the state union, optional
      `claimant`, the claimable predicate, `pool.target` parsing (absent/0 = off; negative or
      non-integer refused loudly). Cite feat-001/AC-39, feat-007/AC-4.
      `tests/registry.test.ts`, `tests/config.test.ts`.
- [x] 1.2 Tests for identity reservations: `slotNumberFor` on `slot-<n>`/non-slots;
      `pullRequestNumberFor` null for slots; operator names starting `slot-` refused like
      `pr-`. Cite feat-001/AC-14. `tests/identity.test.ts`.
- [x] 1.3 Implement 1.1–1.2: `src/core/types.ts` (state union, `claimant`, `pool` config
      shape), `src/core/config.ts` (`pool.target`), `src/core/identity.ts` (`slotNumberFor`,
      slot-prefix refusal), claimable predicate in `src/core/registry.ts`.

## Phase 2 — registry: the pool claim

- [x] 2.1 Tests for `poolClaim`: claims a claimable warm record (→ `active` + claimant);
      refuses a commitless one at the registry layer; version mismatch → `lost`; inconclusive
      collision → `contended`; concurrent claims — exactly one winner (fake-store contention).
      Fresh claim vs a warm record → distinguishable `pool-reserved` refusal. Cite
      feat-001/AC-38, feat-001/AC-16, feat-007/AC-5. `tests/registry.test.ts`,
      `tests/fake-store.test.ts`.
- [x] 2.2 Tests for `findSlotByClaimant`: finds the one slot claimed by a PR among slot
      records; none → null; read failure → loud error, never a guess. Cite feat-007/AC-13.
      `tests/registry.test.ts`.
- [x] 2.3 Implement 2.1–2.2 in `src/core/registry.ts` (+ `tests/fake-store.ts` support where
      the contention hooks need it).

## Phase 3 — credentials: the pool-scout session

- [x] 3.1 Tests for the scout policy shape: reads on the repository's `slot-*` registry keys
      plus the conditional claim write, nothing else — no state prefixes, no protection, no
      `pr-*` bodies; and the ordinary narrowed session unchanged for the resolved identity.
      Cite feat-002/AC-19. `tests/session-policy.test.ts`.
- [x] 3.2 Implement: scout request shape in `src/core/ports.ts`; policy in
      `src/adapters/aws/session-policy.ts`; wiring in `src/adapters/aws/broker.ts`. With
      pooling off, nothing new is ever requested (assert in 3.1).

## Phase 4 — deploy path: claim, refresh, fallback

- [x] 4.1 Tests for the pooled deploy sequence (fake adapters asserting order): declared-input
      refusals first; scout read; existing claimant slot → refresh it, never a second
      environment; else lowest claimable slot, `contended` → bounded same-slot retry, `lost` →
      next slot; none → cap check → fresh claim (cold), output naming warm/cold; narrow to the
      resolved identity before any apply; claim-wins-apply-fails leaves `active` + claimant +
      build commit and exits non-zero; URL re-read and recorded on success; timing accounting
      covers the new steps. Cite feat-002/AC-27, feat-007/AC-5, AC-6, AC-7, AC-12, AC-13,
      AC-14, and AC-1 (pooling off: existing suites pass unchanged).
      `tests/deploy.test.ts`, `tests/deploy-command.test.ts`.
- [x] 4.2 Implement in `src/core/deploy.ts` (resolve-environment step replacing the bare
      claim-or-refresh), `src/cli/deploy.ts` (path-taken output).

## Phase 5 — sweep: destroy, then build one

- [x] 5.1 Tests for the pool phase: wreckage (commitless warm, not this pass's build) →
      teardown via the existing sequence (release write bumps version first; a protection
      mark → reported, not destroyed); active slot with claimant positively closed → teardown;
      lookup failure → left alone, reported; replenish exactly one slot per pass — record
      created `warm` before any provision, missing declared input refused before any record
      (non-zero), commit + URL recorded on success with state still `warm`; at target or at
      cap → no build, reason reported. Cite feat-007/AC-2, AC-3, AC-8, AC-9, AC-10, feat-003
      reuse. `tests/sweep.test.ts`, `tests/cli-sweep.test.ts`, `tests/protection.test.ts`.
- [x] 5.2 Implement in `src/core/sweep.ts` (pool phase, ordered destroy-then-build,
      this-pass-created set), reusing `src/core/teardown.ts` for every slot destroy.

## Phase 6 — close fast path

- [x] 6.1 Tests: close event on a pooled repo finds the slot by claimant and runs the
      record-only teardown against it; lookup failure → loud stop, sweep completes within one
      interval (asserted as: the sweep test from 5.1 covers the same slot). Cite
      feat-007/AC-8. `tests/teardown.test.ts`, `tests/cli-teardown.test.ts`.
- [x] 6.2 Implement in `src/core/teardown.ts` / `src/cli/teardown.ts`.

## Phase 7 — edges: role layer, scaffold, dashboard [P between 7.x groups]

- [x] 7.1 [P] Role widening in the bootstrap Terraform under `terraform/`: pull-request role
      gains read + put (never delete) on `registry/<repo>/slot-*` records, full state-prefix
      grants for `slot-*` workspaces mirroring `pr-*` exactly (delete included — the state
      lockfile requires it, chg-001), and mark-reading for slots; inert with no slots. Assert
      in `tests/bootstrap-terraform.test.ts` both what is granted and what is absent — no
      delete action names a slot registry record or a protection mark. Cite feat-007/AC-11.
- [x] 7.2 [P] Scaffold: `src/cli/init.ts` config document gains the commented `pool.target`
      slot; the scheduled workflow gains the commented `TF_VAR_*` wiring block for warm builds
      (od-1). Documents parse with slots untouched. `tests/install.test.ts`, `tests/cli.test.ts`.
- [x] 7.3 [P] Dashboard: draft feat-005 `chg-002` (proposal + delta) — warm state rendered
      distinctly, claimant shown for claimed slots, freeable-glance stays truthful — then
      implement in `src/core/dashboard.ts` / `src/cli/dashboard.ts`.
      `tests/dashboard.test.ts`, `tests/cli-dashboard.test.ts`.

## Phase 8 — live verification and fold

- [x] 8.1 [H→done] Live end-to-end on the deadweight repo, `pool.target: 1`: the sweep builds a
      warm slot (record first); a PR claims it and the URL arrives warm (note skyhook's
      measured share vs the 60 s budget — feat-007/AC-12); a second push refreshes the same
      slot (AC-13); PR creds are refused a slot record delete and a mark delete when attempted
      directly (the cloud-refused half of AC-11 as amended by chg-001; build-prevention is
      skyhook's guardrail, checked in code review, not demonstrated live), and the narrowed
      request names scout-then-slot (AC-11, feat-002/AC-27); close destroys and the
      reconciler rebuilds; run the conditional-write probe against slot records
      (`tests/manual/verify-conditional-writes.ts`). Record observations here.
- [x] 8.2 Fold, after 8.1 verifies: apply chg-012 into `spec/features/backing-store/spec.md`
      (including the D2b plan amendment its proposal defers), chg-009 into
      `spec/features/deploy-action/spec.md`, chg-002 into the dashboard's spec; update the
      three change folders' Status blocks; set both siblings' tasks/readiness back to ready;
      re-run the per-feature gates.

## Task 8.1 — observations (live, deadweight, 2026-08-17, driven by the agent at andrew's request)

- Revival: the rig had been retired 2026-08-16 (workflow removed, repo tombstoned); restored
  with `pool.target: 1`, a dispatchable sweep verb, and the refreshed bootstrap roles applied
  (one-change plan: the pull-request role's slot grants; trust untouched).
- Warm build (AC-2, AC-9): dispatched sweep run 32069892357 — "slot-1: built warm, now
  claimable"; record present before resources; commit + URL recorded, state warm.
- Warm claim (AC-5, AC-6, AC-12): PR #9 run 32070498040 — "Preview path: warm", deployed the
  PR's commit onto slot-1, URL unchanged from build, skyhook's share 6.0 s (budget 60 s).
- Push refresh (AC-13): PR #9 run 32070625358 — same slot re-applied, 5.6 s; registry census
  showed exactly slot-1 + staging, never a pr-9 record.
- Cloud refusals (AC-11 as amended by chg-001): the in-run probe, under the pull-request
  role's own credentials — record delete and mark delete both AccessDenied "with an explicit
  deny in an identity-based policy".
- Conditional-write probe: PASSED (12 rounds, 5-way contention, one winner per round).
- Close (AC-8): PR #9's close crashed into AC-11's own deny at record removal → fixed as
  chg-002 (deferral); PR #10's close run 32071484271 succeeded — infrastructure destroyed,
  record left released with the deferral stated; the next sweep completed the removal.
- Sweep convergence (AC-9, AC-10): final sweep 32071625894 — "slot-1: destroyed",
  "slot-2: warm and claimable, standing ready", no build at target. Two further live finds,
  both fixed and regression-tested: the refs/pull/0/head fetch fallback (now default-branch
  HEAD for non-PR identities) and the missing sweep single-flight discipline (now two
  concurrency lanes in the scaffolded workflow — observed as two concurrent sweeps each
  building a slot, which is also why the pool briefly held two claimable slots; it converged
  once claims and closes drained it back to target).
- Narrowing (AC-27): asserted against fakes and by policy-shape tests; the live STS request
  bodies were not captured — recorded as code-reviewed, not observed.
- Standing state after the check: slot-2 warm and claimable, staging active; sweeps on the
  15-minute cron with the single-flight lanes.
