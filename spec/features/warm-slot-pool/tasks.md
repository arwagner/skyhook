# Tasks — Warm slot pool (feat-007)

Glyphs: `[x]` done · `[ ]` not started · `[~]` in progress · `[-]` n/a · `[H]` human-gated.
`[P]` = may run concurrently with its phase siblings. Tests precede the code they cover.

## Phase 1 — contract: types, config, identity

- [ ] 1.1 Tests for the widened record and pool config: `warm` in the state union, optional
      `claimant`, the claimable predicate, `pool.target` parsing (absent/0 = off; negative or
      non-integer refused loudly). Cite feat-001/AC-39, feat-007/AC-4.
      `tests/registry.test.ts`, `tests/config.test.ts`.
- [ ] 1.2 Tests for identity reservations: `slotNumberFor` on `slot-<n>`/non-slots;
      `pullRequestNumberFor` null for slots; operator names starting `slot-` refused like
      `pr-`. Cite feat-001/AC-14. `tests/identity.test.ts`.
- [ ] 1.3 Implement 1.1–1.2: `src/core/types.ts` (state union, `claimant`, `pool` config
      shape), `src/core/config.ts` (`pool.target`), `src/core/identity.ts` (`slotNumberFor`,
      slot-prefix refusal), claimable predicate in `src/core/registry.ts`.

## Phase 2 — registry: the pool claim

- [ ] 2.1 Tests for `poolClaim`: claims a claimable warm record (→ `active` + claimant);
      refuses a commitless one at the registry layer; version mismatch → `lost`; inconclusive
      collision → `contended`; concurrent claims — exactly one winner (fake-store contention).
      Fresh claim vs a warm record → distinguishable `pool-reserved` refusal. Cite
      feat-001/AC-38, feat-001/AC-16, feat-007/AC-5. `tests/registry.test.ts`,
      `tests/fake-store.test.ts`.
- [ ] 2.2 Tests for `findSlotByClaimant`: finds the one slot claimed by a PR among slot
      records; none → null; read failure → loud error, never a guess. Cite feat-007/AC-13.
      `tests/registry.test.ts`.
- [ ] 2.3 Implement 2.1–2.2 in `src/core/registry.ts` (+ `tests/fake-store.ts` support where
      the contention hooks need it).

## Phase 3 — credentials: the pool-scout session

- [ ] 3.1 Tests for the scout policy shape: reads on the repository's `slot-*` registry keys
      plus the conditional claim write, nothing else — no state prefixes, no protection, no
      `pr-*` bodies; and the ordinary narrowed session unchanged for the resolved identity.
      Cite feat-002/AC-19. `tests/session-policy.test.ts`.
- [ ] 3.2 Implement: scout request shape in `src/core/ports.ts`; policy in
      `src/adapters/aws/session-policy.ts`; wiring in `src/adapters/aws/broker.ts`. With
      pooling off, nothing new is ever requested (assert in 3.1).

## Phase 4 — deploy path: claim, refresh, fallback

- [ ] 4.1 Tests for the pooled deploy sequence (fake adapters asserting order): declared-input
      refusals first; scout read; existing claimant slot → refresh it, never a second
      environment; else lowest claimable slot, `contended` → bounded same-slot retry, `lost` →
      next slot; none → cap check → fresh claim (cold), output naming warm/cold; narrow to the
      resolved identity before any apply; claim-wins-apply-fails leaves `active` + claimant +
      build commit and exits non-zero; URL re-read and recorded on success; timing accounting
      covers the new steps. Cite feat-002/AC-27, feat-007/AC-5, AC-6, AC-7, AC-12, AC-13,
      AC-14, and AC-1 (pooling off: existing suites pass unchanged).
      `tests/deploy.test.ts`, `tests/deploy-command.test.ts`.
- [ ] 4.2 Implement in `src/core/deploy.ts` (resolve-environment step replacing the bare
      claim-or-refresh), `src/cli/deploy.ts` (path-taken output).

## Phase 5 — sweep: destroy, then build one

- [ ] 5.1 Tests for the pool phase: wreckage (commitless warm, not this pass's build) →
      teardown via the existing sequence (release write bumps version first; a protection
      mark → reported, not destroyed); active slot with claimant positively closed → teardown;
      lookup failure → left alone, reported; replenish exactly one slot per pass — record
      created `warm` before any provision, missing declared input refused before any record
      (non-zero), commit + URL recorded on success with state still `warm`; at target or at
      cap → no build, reason reported. Cite feat-007/AC-2, AC-3, AC-8, AC-9, AC-10, feat-003
      reuse. `tests/sweep.test.ts`, `tests/cli-sweep.test.ts`, `tests/protection.test.ts`.
- [ ] 5.2 Implement in `src/core/sweep.ts` (pool phase, ordered destroy-then-build,
      this-pass-created set), reusing `src/core/teardown.ts` for every slot destroy.

## Phase 6 — close fast path

- [ ] 6.1 Tests: close event on a pooled repo finds the slot by claimant and runs the
      record-only teardown against it; lookup failure → loud stop, sweep completes within one
      interval (asserted as: the sweep test from 5.1 covers the same slot). Cite
      feat-007/AC-8. `tests/teardown.test.ts`, `tests/cli-teardown.test.ts`.
- [ ] 6.2 Implement in `src/core/teardown.ts` / `src/cli/teardown.ts`.

## Phase 7 — edges: role layer, scaffold, dashboard [P between 7.x groups]

- [ ] 7.1 [P] Role widening in the bootstrap Terraform under `terraform/`: pull-request role
      gains read + put (never delete) on `registry/<repo>/slot-*` and state-prefix grants for
      `slot-*` workspaces mirroring the existing `pr-*` grants; inert with no slots. Assert in
      `tests/bootstrap-terraform.test.ts` both what is granted and what is absent — no delete
      action names any slot registry key, slot state prefix, or slot protection mark. Cite
      feat-007/AC-11 (the cloud-refused half is exactly the deletes).
- [ ] 7.2 [P] Scaffold: `src/cli/init.ts` config document gains the commented `pool.target`
      slot; the scheduled workflow gains the commented `TF_VAR_*` wiring block for warm builds
      (od-1). Documents parse with slots untouched. `tests/install.test.ts`, `tests/cli.test.ts`.
- [ ] 7.3 [P] Dashboard: draft feat-005 `chg-002` (proposal + delta) — warm state rendered
      distinctly, claimant shown for claimed slots, freeable-glance stays truthful — then
      implement in `src/core/dashboard.ts` / `src/cli/dashboard.ts`.
      `tests/dashboard.test.ts`, `tests/cli-dashboard.test.ts`.

## Phase 8 — live verification and fold

- [ ] 8.1 [H] Live end-to-end on the deadweight repo, `pool.target: 1`: the sweep builds a
      warm slot (record first); a PR claims it and the URL arrives warm (note skyhook's
      measured share vs the 60 s budget — feat-007/AC-12); a second push refreshes the same
      slot (AC-13); PR creds are refused every slot-namespace delete when attempted directly
      (record, state, protection mark — the cloud-refused half of AC-11; build-prevention is
      skyhook's guardrail, checked in code review, not demonstrated live), and the narrowed
      request names scout-then-slot (AC-11, feat-002/AC-27); close destroys and the
      reconciler rebuilds; run the conditional-write probe against slot records
      (`tests/manual/verify-conditional-writes.ts`). Record observations here.
- [ ] 8.2 Fold, after 8.1 verifies: apply chg-012 into `spec/features/backing-store/spec.md`
      (including the D2b plan amendment its proposal defers), chg-009 into
      `spec/features/deploy-action/spec.md`, chg-002 into the dashboard's spec; update the
      three change folders' Status blocks; set both siblings' tasks/readiness back to ready;
      re-run the per-feature gates.
