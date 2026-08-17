# Plan — Warm slot pool (feat-007)

One build spanning this feature plus the two pending sibling deltas (backing-store `chg-012`:
warm state + pool claim; deploy-action `chg-009`: slot namespace + two-phase narrowing) and a
small dashboard change (feat-005 `chg-002`, drafted as part of this build) — the
declared-deploy-inputs precedent. Depth prototype. Zero runtime dependencies; the existing
toolchain (tsc, `node --test`) stands, so no toolchain task is needed.

## Design decisions

- **D1 — Slot identities are `slot-<n>`, and the prefix is reserved everywhere names are
  policed.** `n` is a positive integer assigned as the lowest index with no record.
  `src/core/identity.ts` gains `slotNumberFor(identity)` (null for non-slots) beside
  `pullRequestNumberFor`, and operator-chosen names refuse the `slot-` prefix exactly as they
  refuse `pr-` today — that check is what makes the spec's "disjoint namespaces" open question
  a tested assertion rather than documentation (feat-002 analyze N1). `pullRequestNumberFor`
  returns null for slots, so every existing "is this ephemeral?" derivation stays correct; the
  sweep asks the claimant instead (D6).
- **D2 — The record grows additively; the schema version does not bump.** `src/core/types.ts`:
  state union gains `'warm'`; the record gains optional `claimant` (a pull request number,
  present only on a claimed slot). Both absent-tolerant, like `url` and `deployInputs` before
  them — every existing record parses unchanged. Claimable is a derived predicate (state
  `warm` AND `deployedCommit` present), computed in one place in `src/core/registry.ts`, never
  re-derived by callers (feat-001/AC-39).
- **D3 — The pool claim is one registry operation composed on the store's compare-and-swap;
  slot destroys reuse teardown.** `src/core/registry.ts` gains `poolClaim(identity, claimant,
  version)`: re-checks claimability from the record it read (refusing a commitless record at
  the registry layer), then CAS to `active` + claimant. Outcomes mirror fresh claims:
  `claimed`, `not-claimable`, `lost` (version mismatch — caller moves to the next slot),
  `contended` (inconclusive — caller retries the same slot at most twice more, then treats it
  as lost; the bound is the spec's race scenario, and it keeps the claim step inside AC-12's
  budget), reusing the store's
  existing outcome discrimination (feat-001/AC-38). Fresh claims against a `warm` record gain
  the third distinguishable refusal, `pool-reserved` (feat-001/AC-16 as amended). Slot
  destruction is never a new code path: wreckage and closed-claimant slots go through the
  existing teardown sequence, whose release step IS the version-bumping
  intent write and whose protection step IS the mark check the spec requires (feat-007/AC-10)
  — no second destroyer to keep honest.
- **D4 — Two sessions, not one widened session.** The two-phase narrowing (feat-002 `chg-009`)
  is implemented as two separate credential opens against the existing broker port, keeping
  every issued session's policy inspectable and single-purpose (feat-002/AC-19 as amended):
  first a **pool-scout session** — registry reads on the repository's `slot-*` keys plus the
  conditional claim write, nothing else — used to find/claim a slot; then the ordinary
  narrowed session for the one resolved identity (claimed slot, or derived `pr-<n>` on
  fallback), exactly as today. `src/core/ports.ts` gains the scout request shape;
  `src/adapters/aws/session-policy.ts` gains the scout policy; `src/adapters/aws/broker.ts`
  wires it. With pooling off, the scout session is never requested and issuance is
  byte-for-byte today's (feat-007/AC-1, feat-002/AC-27).
- **D5 — Pool configuration is one setting.** `pool.target` (non-negative integer, default
  absent = pooling off) in `.skyhook/config.yml`, parsed in `src/core/config.ts` under the
  same default-branch discipline as every setting; the scaffolded config document gains a
  commented, labelled slot. The environment cap is untouched: `countEnvironments` already
  counts keys, so warm slots count by construction (od-3); the replenisher reads the same
  counter before building.
- **D6 — The sweep gains a pool phase, ordered destroy-then-build, at most one build per
  pass.** `src/core/sweep.ts`, after the existing per-identity pass: (a) wreckage — a `warm`
  commitless record not created by this pass (in-memory set) → teardown; (b) an `active` slot
  whose claimant PR is positively closed (the existing pull-request lookup; any failure leaves
  the slot alone, reported) → teardown; (c) replenish — if claimable-warm count < `pool.target`
  and total records < cap, build exactly one slot: fresh-claim the lowest free `slot-<n>` with
  initial state `warm`, deploy the default branch's commit with declared inputs read from the
  run's environment (the existing `DeclaredInputSource`, same refuse-before-record rule,
  feat-007/AC-3), then record commit + URL, state still `warm`. The one-build-per-pass rule is
  what keeps "commitless = wreckage" sound (spec sharp edge).
- **D7 — The close fast path and push refresh find the slot by claimant.** Both derive
  `pr-<n>`, find no record under it on a pooled repo, then scan slot records for
  `claimant === n` via the scout session. Close then runs today's record-only teardown against
  the found slot; push re-applies on it (feat-007/AC-8, AC-13). Any lookup failure stops the
  run loudly; the sweep is the guarantee.
- **D8 — The role layer widens for slots, with the enforcement split stated honestly
  (feat-007/AC-11 as amended).** The pull-request role gains: read and conditional write
  (put, never delete) on `registry/<repo>/slot-*` keys, and state-prefix grants for
  `slot-*` workspaces mirroring exactly how `pr-*` state is granted today — role-wide across
  the namespace, narrowed to one identity per session by skyhook (the guardrail, per the
  constitution's non-isolation decision; nothing here is identity-templated at the role,
  because `pr-*` is not either). What the cloud alone refuses: every delete — slot records,
  slot state, slot protection marks — because the role holds no delete on the slot namespace;
  destroys are thereby impossible from a pull-request run regardless of skyhook's code.
  Minting a slot record cannot be cloud-distinguished from the claim write on the same key,
  so build-prevention is skyhook's, stated as such. Per `chg-009`'s proposal blast-radius
  item ("Role layer (cloud), named per the hs-1 precedent"). Inert when no slot records
  exist. Lands in the bootstrap definition under `terraform/`; init's drift-restore covers it.
- **D9 — Consumer contract lands in the scaffold.** `src/cli/init.ts`'s workflow and config
  documents gain the pool's commented wiring: the `pool.target` slot, and a comment block in
  the scheduled workflow showing where `TF_VAR_*` values for warm builds come from (od-1).
  Documents must still parse with the slots left untouched (the chg-002 restore rule).
- **D10 — Dashboard shows the pool honestly.** feat-005 gains `chg-002` (proposal + delta,
  drafted in this build): warm records render as their own visible state, a claimed slot shows
  its claimant's pull request, and the "which slot can be freed" glance stays truthful.
  `src/core/dashboard.ts` + `src/cli/dashboard.ts`.

## Verification approach

Every test cites its trace token in the test name or a comment. Seams: the exported core
functions under fake adapters (`deploy()`, `sweep()`, `teardown()`, registry/store contracts)
for all logic; the CLI entrypoints for surface behavior; the live installation (deadweight
repo) for the cloud-enforced criteria, per the constitution's adapters-verified-live rule.

| Criterion | Seam · test file |
|---|---|
| feat-007/AC-1 (pooling off = today, byte-for-byte) | `deploy()` + `sweep()` fakes · `tests/deploy.test.ts`, `tests/sweep.test.ts` (existing suites unchanged is the assertion) |
| feat-007/AC-2 (record before resource; delete after verified destroy) | fake deployer call-order · `tests/sweep.test.ts` |
| feat-007/AC-3 (warm build refuses missing input, exits non-zero) | `sweep()` + CLI · `tests/sweep.test.ts`, `tests/cli-sweep.test.ts` |
| feat-007/AC-4 (claimable observable: warm + commit + URL) | registry · `tests/registry.test.ts` |
| feat-007/AC-5 + feat-001/AC-38 (CAS claim, contention, loser → next slot) | fake-store contention · `tests/registry.test.ts`, `tests/fake-store.test.ts`; live CAS via the existing conditional-write probe `tests/manual/verify-conditional-writes.ts` |
| feat-007/AC-6 (claim re-applies PR commit/inputs; identity stable; URL re-read) | `deploy()` fakes · `tests/deploy.test.ts` |
| feat-007/AC-7 (empty pool → cold fallback, path named in output) | `deploy()` + CLI · `tests/deploy.test.ts`, `tests/deploy-command.test.ts` |
| feat-007/AC-8 (closed claimant destroyed within a sweep interval; never re-handed) | `sweep()` + `teardown()` · `tests/sweep.test.ts`, `tests/teardown.test.ts` |
| feat-007/AC-9 (one build per pass; stops at target; cap refusal reported) | `sweep()` · `tests/sweep.test.ts` |
| feat-007/AC-10 (wreckage: release-first, protection honored; failed lookup leaves alone) | `sweep()` · `tests/sweep.test.ts`, `tests/protection.test.ts` |
| feat-007/AC-11 (PR creds: claim only; build/destroy refused by cloud) | live · task 8.1 (manual, deadweight) |
| feat-007/AC-12 (skyhook overhead within 60 s on the warm path) | timing accounting under fakes + live observation · `tests/deploy.test.ts`, task 8.1 |
| feat-007/AC-13 (push refresh finds slot by claimant; never two envs per PR) | `deploy()` · `tests/deploy.test.ts` |
| feat-007/AC-14 (claim wins, re-apply fails: active + claimant + old commit, non-zero) | `deploy()` · `tests/deploy.test.ts` |
| feat-001/AC-16 (three distinguishable refusals incl. pool-reserved) | registry · `tests/registry.test.ts` |
| feat-001/AC-39 (claimable predicate; claimant readable) | registry · `tests/registry.test.ts` |
| feat-002/AC-27 (order: inputs → scout/claim → cap+fresh on fallback → narrow → apply) | `deploy()` fakes asserting sequence · `tests/deploy.test.ts`; live request inspection in task 8.1 |
| identity reservations (feat-001/AC-14 as amended) | identity unit · `tests/identity.test.ts` |
| scout session policy shape | policy snapshot · `tests/session-policy.test.ts` |
| scaffold slots parse untouched | init · `tests/install.test.ts`, `tests/bootstrap-terraform.test.ts` |

Tests-first per the constitution's quality bar: each phase's test tasks precede its
implementation tasks. All test commands name explicit files (`node --test tests/x.test.ts`).

## Sharp edges carried into the build

The claimant is self-reported (accepted, priced — backlog row 10 blocks MVP). Warm slots age
forward-only. One-build-per-pass is load-bearing for wreckage detection. Pool-scout reads are
repo-visible metadata. The 60-second budget covers skyhook's share only.
