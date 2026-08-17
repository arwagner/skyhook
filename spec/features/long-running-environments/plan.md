# Plan — Long-running environments (feat-006, prototype)

The HOW behind `spec.md`. Written against the code as it stands after feat-001..003 and feat-005.

## What already exists, and is load-bearing here

Read before challenging any decision below — most of this feature is wiring, because earlier
features built the walls:

- **The cloud side is done.** `terraform/bootstrap/roles.tf` already confines the pull-request
  role to the `pr-*` namespace with explicit denies, already refuses it every protection-mark
  write, and already grants the default-branch role every environment this repository owns,
  protection marks included. **No role or bucket policy changes.** AC-5 is proved against what is
  already applied.
- **The registry already speaks protection.** `Registry.isProtected` / `Registry.setProtected`
  exist (`src/core/registry.ts`); marks live at their own `protected/` key so the bucket policy
  can refuse writes. Nothing calls `setProtected` yet — this feature adds the caller.
- **Teardown is already kind-agnostic.** `teardownEnvironment` (`src/core/teardown.ts`) takes a
  repository + identity and never asks what kind it is. The manual path reuses it unchanged.
- **Identity already has the two shapes.** `identityFor` (`src/core/identity.ts`) accepts a
  `default-branch` trigger with a requested identity; `pullRequestNumberFor` already answers null
  for `staging`. What is missing is the `pr-` prefix refusal and any caller of the
  default-branch shape.
- **The sweep already skips non-ephemeral records** (`not-ephemeral` in `src/core/sweep.ts`) —
  but it skips them before reading the record, so a `released` long-running record is never
  completed. That ordering is the one behavior change the sweep needs (spec AC-7).

## Design decisions

- **D1 — One workflow, one action, new triggers.** The scaffolded workflow
  (`src/cli/init.ts`, `.skyhook/workflow.yml`) gains: (a) a `workflow_dispatch` trigger with two
  inputs, `command` (choice: `teardown` | `protect` | `unprotect`) and `environment` (the name);
  (b) a **commented-out** `push:` block for the default branch plus a commented `environment`
  line, which the operator uncomments and names to turn on a long-running deploy. Commented,
  because an installed repository must not start deploying `staging` because it upgraded skyhook.
  `action.yml` routes: `push` → `deploy`; `workflow_dispatch` → the `command` input; existing
  routes unchanged. It gains an `environment` input handed to the CLI as `SKYHOOK_ENVIRONMENT`.
- **D2 — The trigger, not a flag, decides the deploy kind.** `GitHubTriggerSource`
  (`src/adapters/github/event.ts`) learns to read `push` events into a new
  `default-branch` trigger context: repository, `GITHUB_SHA` as the head commit, and the
  requested identity from `SKYHOOK_ENVIRONMENT`. A push to any ref other than the repository's
  default branch is refused with a message naming the ref it needs — a clarity check for the
  honest caller; the enforcement stays the role trust (the default-branch role's subject
  condition), exactly as the spec states. The core `TriggerContext` becomes a union
  (`src/core/ports.ts`); nothing in core names GitHub.
- **D3 — `identityFor` owns the namespace fence.** A `default-branch` trigger whose requested
  identity starts with `pr-` is refused with a new reason (`reserved-namespace`), before
  anything is recorded or applied (AC-3). One function already owns identity legality; the fence
  goes there and nowhere else.
- **D4 — Deploy assumes the role its trigger earns.** `AwsAccessBroker.open`
  (`src/adapters/aws/broker.ts`) currently hardcodes the `-pull-request` role. It selects by
  trigger kind: pull request → `-pull-request`, default branch → `-default-branch`. The session
  narrowing to the one claimed environment applies identically on both paths —
  `sessionPolicyFor` is already generic over the identity. The consuming repo's `-deploy` role
  needs no change: the sweep's destroys already require its trust to accept the default-branch
  subject, and the example file already shows the two-subject form.
- **D5 — Manual teardown composes what the sweep already has.** `skyhook teardown` grows an
  optional `--environment <name>` (from the `environment` input). With it, the run: opens
  default-branch access exactly as `openSweep` does (wide registry/store; per-environment
  narrowed destroyer via the existing `#acquireDestroyer` with the `-default-branch` role),
  reads the record for its commit, and calls `teardownEnvironment` with
  `markerRemoval: 'with-record'`. Without the flag, the close fast path is untouched. Exit-code
  mapping differs from the close path in exactly one row: `left-standing-protected` exits
  **non-zero** and names the mark and the unprotect step (AC-8) — on the manual path a refusal
  is the answer to a direct order, not policy quietly honored. Engagement rule (chg-001): the
  manual path engages only on a `workflow_dispatch` run or an explicit `--environment` flag — a
  pull-request run ignores a carried `SKYHOOK_ENVIRONMENT`, because the scaffolded workflow
  exports it on every event once the push deploy is on, and a close event honoring it would
  skip its own teardown (AC-11).
- **D6 — Protection is a core decision with a thin CLI.** New core function
  (`src/core/protection.ts`): set/clear requires an existing record in state `active`; a missing
  record or a `released` one is a typed refusal (AC-9, and the spec's released-records-refuse
  rule). New CLI commands `skyhook protect` / `skyhook unprotect` (env-driven like `sweep`,
  identity from `SKYHOOK_ENVIRONMENT`) run it over the default-branch role's un-narrowed
  session — the only role the cloud lets write a mark. At prototype depth the protect session is
  not narrowed further; noted as a guardrail gap, matching the sweep's own wide session.
- **D7 — The sweep completes released records of any kind, and touches nothing else new.**
  `sweepOne` reorders: read the record first; `released` → complete the teardown whatever the
  identity's shape; `active` + non-ephemeral → `not-ephemeral` (left standing, exactly as
  today); `active` + ephemeral → the existing ask-the-host path. The destroyer's fetch target
  uses the recorded commit; the pull-request number is absent for a long-running identity
  (`pullRequestNumberFor` returns null → 0, the existing convention). The recorded commit lives
  on the default branch, so the existing commit fetch reaches it.
- **D8 — No new toolchain, no new dependencies.** TypeScript run directly by Node (the repo's
  existing choice), `node --test "tests/**/*.test.ts"`, fakes in `tests/`. Zero runtime deps
  stays true.

Constitution check: no deviations. The sweep still never *starts* destroying anything
non-ephemeral (D7 completes only human-started teardowns); protection writes stay
default-branch-only at the cloud; the core stays provider-agnostic (D2's union lives in ports).

## Verification approach

Tests cite `feat-006/AC-N` in the test name or a comment. Seams: `identityFor` and the core
functions with fake adapters (the decision logic), `runCli` with injected deps (wiring and exit
codes), and one live pass on the test consuming repo (the adapters, per the constitution's
quality bar).

| AC | How | Seam |
| --- | --- | --- |
| AC-1 | Core deploy test: default-branch trigger, fake store — record precedes apply, bound to no PR; live pass confirms end to end | `deployEnvironment` + live |
| AC-2 | Core deploy test: second deploy same name updates in place; failed apply leaves commit | `deployEnvironment` |
| AC-3 | Identity + CLI tests: `pr-7`, `pr-x` refused with `reserved-namespace`, nothing written, exit non-zero | `identityFor`, `runCli` |
| AC-4 | Core sweep test: active `staging` record untouched while eligible `pr-*` is destroyed; exit 0 | `sweepEnvironments` |
| AC-5 | Live probe: with pull-request-role credentials, attempt get/put/delete on `staging`'s record, state, and mark write — expect the cloud's refusal (roles are already applied; this observes them against a real long-running environment) | live |
| AC-6 | CLI test: `teardown --environment staging` destroys via fakes, frees name; wrong-ref dispatch message test; live pass confirms | `runCli` + live |
| AC-7 | Core sweep test: planted `released` long-running record is completed; protection-set-on-released refusal in protection tests | `sweepEnvironments`, `setProtection` |
| AC-8 | Core+CLI test: protected → refusal, exit non-zero, names unprotect; after clear, teardown proceeds | `runCli` |
| AC-9 | Protection tests: set/clear only on `active`; mark visible via `isProtected`; deploy update leaves mark | `setProtection`, `deployEnvironment` |
| AC-10 | Core deploy test: cap counts mixed kinds; refusal at cap for a chosen name | `deployEnvironment` |

The live pass (task 5.1) is the must-prove from `research.md` run for real: deploy `staging`,
push an update, sweep leaves it, protect, watch the manual teardown refuse, unprotect, tear
down, see the name freed.
