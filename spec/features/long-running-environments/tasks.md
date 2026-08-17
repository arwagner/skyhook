# Tasks — Long-running environments (feat-006, prototype)

Glyphs: `[x]` done · `[ ]` not started · `[~]` in progress · `[-]` n/a · `[H]` human-gated.
`[P]` marks a task that can run concurrently with its peers in the same phase.

## Phase 1 — core decisions (fakes only, no cloud)

- [x] 1.1 [P] The namespace fence (plan D3). `identityFor` refuses a default-branch requested
      identity beginning `pr-` with reason `reserved-namespace`; message text lives with the
      CLI. Tests in `tests/identity.test.ts` cite `feat-006/AC-3`.
      Files: `src/core/identity.ts`, `tests/identity.test.ts`.
- [x] 1.2 [P] The default-branch trigger context (plan D2). Extend the trigger union in
      `src/core/ports.ts` (pull-request context as today · default-branch context: repository,
      head commit, requested identity). `GitHubTriggerSource` reads `push` events: `GITHUB_SHA`,
      `SKYHOOK_ENVIRONMENT`, and refuses a push whose ref is not the repository's default
      branch, naming the ref it needs. Tests in `tests/deploy-adapters.test.ts` (or a new
      `tests/event.test.ts`) cite `feat-006/AC-6` for the wrong-ref message.
      Files: `src/core/ports.ts`, `src/adapters/github/event.ts`, tests.
- [x] 1.3 [P] Protection as a core decision (plan D6). New `src/core/protection.ts`:
      set/clear requires an `active` record; missing → typed refusal; `released` → typed
      refusal. Tests in new `tests/protection.test.ts` cite `feat-006/AC-9` and the
      released-record half of `feat-006/AC-7`.
      Files: `src/core/protection.ts`, `tests/protection.test.ts`.
- [x] 1.4 The deploy core takes both trigger kinds (plan D2, D3; needs 1.1 + 1.2).
      `deployEnvironment` branches on trigger kind: fork check only for pull requests; identity
      from `identityFor` with the matching trigger; order (record before apply), refresh,
      cap, and recording unchanged and shared. Tests in `tests/deploy.test.ts` cite
      `feat-006/AC-1`, `feat-006/AC-2`, `feat-006/AC-10`, and the mark-untouched half of
      `feat-006/AC-9`.
      Files: `src/core/deploy.ts`, `tests/deploy.test.ts`.
- [x] 1.5 The sweep completes released records of any kind (plan D7). Reorder `sweepOne`:
      read record first; `released` → complete teardown regardless of kind; `active`
      non-ephemeral → `not-ephemeral` untouched; `active` ephemeral → ask the host, as today.
      Tests in `tests/sweep.test.ts` cite `feat-006/AC-4` and `feat-006/AC-7`.
      Files: `src/core/sweep.ts`, `tests/sweep.test.ts`.

## Phase 2 — adapters and CLI wiring (needs phase 1)

- [x] 2.1 The broker selects the role the trigger earns (plan D4, D5). `open` picks
      `-pull-request` or `-default-branch` by trigger kind, session-narrowed to the claimed
      identity on both. Add manual-teardown access: default-branch role, wide registry/store,
      per-environment narrowed destroyer via the existing acquisition path. Tests against the
      recorded-request fakes in `tests/deploy-adapters.test.ts` / `tests/session-policy.test.ts`.
      Files: `src/adapters/aws/broker.ts`, tests.
- [x] 2.2 `skyhook deploy` carries the chosen name (needs 2.1). Read `SKYHOOK_ENVIRONMENT`,
      hand the right trigger to the core, outputs unchanged. Tests in
      `tests/deploy-command.test.ts` cite `feat-006/AC-1`, `feat-006/AC-3` (exit codes,
      nothing-written).
      Files: `src/cli/deploy.ts`, `tests/deploy-command.test.ts`.
- [x] 2.3 Manual teardown (needs 2.1). `skyhook teardown --environment <name>` (name also via
      `SKYHOOK_ENVIRONMENT`): default-branch access, `markerRemoval: 'with-record'`, and the
      one changed exit-code row — `left-standing-protected` exits non-zero naming the mark and
      the unprotect step. Close fast path untouched. Tests in `tests/cli-teardown.test.ts` cite
      `feat-006/AC-6`, `feat-006/AC-8`.
      Files: `src/cli/teardown.ts`, `src/cli/main.ts`, `tests/cli-teardown.test.ts`.
- [x] 2.4 `skyhook protect` / `skyhook unprotect` (needs 1.3, 2.1). Env-driven like `sweep`;
      runs the core protection decision over default-branch access; usage text in `main.ts`.
      Tests in a new `tests/cli-protect.test.ts` cite `feat-006/AC-8`, `feat-006/AC-9`.
      Files: `src/cli/protect.ts` (new), `src/cli/main.ts`, tests.
- [x] 2.5 [P] The action routes the new triggers (plan D1). `action.yml`: `push` → deploy;
      `workflow_dispatch` → the `command` input; new `environment` input exported as
      `SKYHOOK_ENVIRONMENT`. No test harness reaches this file; reviewed by eye and proven in
      task 5.1.
      Files: `action.yml`.
- [x] 2.6 [P] The scaffolded workflow and its messages (plan D1). `.skyhook/workflow.yml`
      template: `workflow_dispatch` with `command` + `environment` inputs wired through; a
      commented-out default-branch `push:` block with a commented `environment` name for the
      operator to switch on; comments say what each does and that protection guards destruction
      only. `init`'s printed guidance mentions the manual teardown. Install tests in
      `tests/install.test.ts` / `tests/cli.test.ts` keep the restore-on-rerun behavior.
      Files: `src/cli/init.ts`, tests.

## Phase 6 — the break/converge remediations (2026-08-17)

- [x] 6.1 chg-001: the manual path engages only on a manual dispatch. A pull-request-triggered
      run ignores a carried `SKYHOOK_ENVIRONMENT` and takes its own fast path; an explicit
      `--environment` flag still engages the manual path (a human typed it). Regression test in
      `tests/cli-teardown.test.ts` cites `feat-006/AC-11` and `chg-001`: a close event carrying a
      name tears down the pull request's own environment, not the named one, exit 0.
      Files: `src/cli/teardown.ts`, tests.
- [x] 6.2 gap-001 defect (AC-7): a protection mark is honored only on an `active` record — a
      `released` record is a started teardown and completes regardless of marks (the spec's
      "honored before release, never after", made literal in `teardownEnvironment`). And
      `setProtection` re-checks the record after writing a mark, unwinding one that landed on a
      just-released record. Regression tests in `tests/sweep.test.ts` / `tests/protection.test.ts`
      cite `feat-006/AC-7` and `gap-001`, exercising the interleaved race.
      Files: `src/core/teardown.ts`, `src/core/protection.ts`, tests.
- [x] 6.3 gap-002: the CLI-seam tests the plan's verification table promised — fake-driven
      `teardown --environment` reaching `destroyed` (cite `feat-006/AC-6`), and protected →
      refused → cleared → succeeds at the CLI seam (cite `feat-006/AC-8`), both citing `gap-002`.
      Files: `tests/cli-teardown.test.ts`, `tests/cli-protect.test.ts`.

- [x] 6.4 chg-002: legitimize protection of ephemeral environments (closes the ledger's
      gap-003 on the owner's 2026-08-17 ruling). No code change — the behavior pre-existed;
      a citing regression test in `tests/cli-protect.test.ts` cites `feat-006/AC-12`,
      `gap-003`, and `chg-002`. The two probe rulings (capitals accepted, idempotency
      accepted) are recorded in the spec's sharp edges and the probe file is retired.
      Files: `spec.md`, `tests/cli-protect.test.ts`.

## Phase 3 — proof

- [x] 3.1 Whole-suite gate: `npm run check` and `npm test` pass with every trace token above
      present (needs all of phase 1–2).
- [x] 5.1 The live must-prove on the test consuming repo (needs 2.5, 2.6, 3.1): deploy
      `staging` from the default branch (AC-1), push an update (AC-2), watch a sweep pass leave
      it standing (AC-4), protect it, watch the manual dispatch refuse non-zero (AC-8),
      unprotect, tear it down and see the name freed (AC-6), and run the AC-5 credential probe
      with pull-request-role credentials against the live `staging`. Record the observations in
      this file.

      **Done — observed live on skylight-hq/deadweight, 2026-08-16 (all run ids in that repo's
      Actions history):**
      - AC-1 — run 31980548529 (push, commit 3d05829): `Created and switched to workspace
        "staging"`, `Deployed staging at commit 3d05829…: http://deadweight-staging-123456789012.
        s3-website-us-east-1.amazonaws.com`, skyhook's share 6.0s. Record bound to no pull request.
      - AC-2 — run for commit 8448f0c: `Switched to workspace "staging"` (existing, not created),
        same URL, recorded commit moved to 8448f0c. One record throughout.
      - AC-4 — scheduled sweep run 31980903889, exit success: `pr-8: destroyed` (an eligible
        ephemeral torn down in the same pass), `staging: not ephemeral, not the sweep's to touch`,
        `pr-4: left standing — its pull request is open`.
      - AC-5 — probe run on PR #8, holding `assumed-role/skyhook-pull-request`: the cloud refused
        all nine operations — read/overwrite/delete of staging's registry record, read/write of its
        stored state, set/clear of its protection mark, and write/delete of its own infrastructure
        bucket. Probe job passed; probe file deleted after (commit fdabba5).
      - AC-8/AC-9 — dispatch protect (run 31980953025, success: "staging is protected…");
        dispatch teardown (run 31980977833, **failure** as required: names the mark and the
        unprotect-first step, nothing destroyed); dispatch unprotect (run 31981010144, success).
      - AC-6 — dispatch teardown (run 31981024272, success): `Destroyed staging. Its record is
        removed and the name is free.` Then the next default-branch push (fdabba5, run
        31981085081) behaved as a FIRST deploy: `Created and switched to workspace "staging"!`,
        no inherited state, record, or URL. `staging` now stands on deadweight as a real
        long-running environment.
