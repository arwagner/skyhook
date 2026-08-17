# Tasks — teardown (feat-003)

Glyphs: `[x]` done · `[ ]` not started · `[~]` in progress · `[-]` n/a · `[H]` human-gated.
`[P]` marks a task that can run concurrently with its phase siblings. Tests come before the
code they cover, per the house pattern.

## Phase 0 — Decisions and live facts the rest depends on

- [x] 0.1 Decide D3: how the close fast path learns protection. DECIDED 2026-08-16: option (a),
        recorded on `hs-1`. Was: recommended (a): grant the
        pull-request role read-only on `protected/<repo>/pr-*` plus the constitution's third
        named exception, in one main-branch PR (which restages every feature's pre-build
        check). Alternatives: (b) no fast path — sweep does all destruction (AC-1/2/3 then
        route through `/spec-flow:change`); (c) `workflow_run` indirection (declined once as
        `chg-001`). Manifest item `hs-1`. Blocks phases 4–6; phases 1–3 proceed under (a)'s
        shape with the fast path failing closed.
- [x] 0.2 DONE 2026-08-16 (hs-2 resolved; run at the human's direction, results on the
        manifest). Was: live probe, before anything depends on the answers: (i) a `closed`-type
        `pull_request` run is issued an id-token; (ii) a schedule-triggered run's subject
        assumes the default-branch role; (iii) the deploy role with the widened example trust
        (D4) is assumable from that same scheduled run; (iv) whether the scheduled run's OIDC
        claims can distinguish it from other default-branch runs, so the deploy-role trust can
        narrow to schedule-only if the cloud honors it (D4, security S2). One throwaway
        workflow on the deadweight repo. Manifest item `hs-2` records the observations.

## Phase 1 — Core: one environment's teardown

- [x] 1.1 Add the `EnvironmentDestroyer` port (mirror of `EnvironmentDeployer`) and the
        `PullRequestStateSource` port to `src/core/ports.ts`. Extend the registry with a
        record-only removal beside `remove()` in `src/core/registry.ts` (D6; recorded change
        against feat-001, D10), with its own unit coverage in `tests/registry.test.ts`.
- [x] 1.2 Tests first in `tests/teardown.test.ts` against fakes: the D6 order (feat-003/AC-1),
        nothing-to-do on an absent record (feat-003/AC-2), protection stops everything before
        release (feat-003/AC-4), resume from every interruption point (feat-003/AC-5), the
        teardown-vs-teardown interleaving matrix (feat-003/AC-10), the teardown-vs-deploy
        interleaving matrix — a reactivating deploy at every step boundary aborts the teardown
        with nothing destroyed and the record left `active` (feat-003/AC-14),
        teardown-then-deploy claims fresh (feat-003/AC-11), cap slot frees (feat-003/AC-13),
        and the post-destroy empty-state gate: a destroyer reporting success over a state that
        still names resources fails the teardown loudly with state and record intact (D6 step
        4, security S1).
- [x] 1.3 Write `src/core/teardown.ts` — `teardownEnvironment()`: protection check, CAS
        release tolerant of a teardown peer, generation re-check before destroy and before
        record removal (abort as reactivated when a deploy took the record back — D6 steps 3
        and 5), post-destroy empty-state verification, state-prefix delete, record removal;
        re-entrant per D7; typed outcomes (destroyed / nothing / left-standing-protected /
        reactivated / failed) with no cloud or IaC names in the module.

## Phase 2 — Core: the sweep

- [x] 2.1 Tests first in `tests/sweep.test.ts` against fakes: repairs the missed close
        (feat-003/AC-6), leaves open pull requests alone (feat-003/AC-7), nothing-eligible
        no-op (feat-003/AC-8), keep-going-then-fail-loudly with retry on the next pass
        (feat-003/AC-9), completes `released` records without asking GitHub (feat-003/AC-5),
        skips non-`pr-*` records and protected environments (feat-003/AC-4), and the identity
        invariant: a record at key `pr-97` whose body claims `pr-42` is swept as `pr-97` —
        workspace, session-policy ARNs, GitHub lookup and destroy target all key-derived
        (D2, security B1; cited under feat-003/AC-14).
- [x] 2.2 Write `src/core/sweep.ts` — `sweepEnvironments()`: list registry, filter ephemeral,
        `released` → complete, `active` → ask `PullRequestStateSource`, eligible → per-D6
        teardown via `teardownEnvironment()`, collect per-environment outcomes into one
        report (D8).

## Phase 3 — Adapters

- [x] 3.1 [P] `src/adapters/github/pull-requests.ts`: `PullRequestStateSource` over the GitHub
        API with the job token (open/closed for `pr-<n>`), loud on 404 and on missing
        `pull-requests: read`.
- [x] 3.2 [P] `src/adapters/git/commit-fetch.ts`: fetch the recorded commit (falling back to
        `refs/pull/<n>/head`) into a scratch directory outside the repository tree (D5), loud
        when unfetchable; hooks disabled, submodules never auto-fetched, remote pinned to the
        current repository (security S4).
- [x] 3.3 `src/adapters/terraform/environment.ts` + `runner.ts`: `destroy()` — same workspace
        selection, backend declaration, and two-credential split as deploy; the D6a hijack
        checks (override refusal before init, backend verification after init) run on the
        destroy path too; destroy over empty state is a success (D7). Tests with the injected
        runner in `tests/terraform-destroy.test.ts`.
- [x] 3.4 `src/adapters/aws/broker.ts` + `session-policy.ts`: assume the default-branch role on
        the sweep path, per-environment inline session policy while iterating (D4); the policy
        gains the protection-marker read once 0.1 resolves (a). Unit-test the policy names
        exactly one environment's keys in `tests/session-policy.test.ts`.

## Phase 4 — CLI and action surface  _(0.1 decided; the fast path ships fail-closed until 5.2 lands)_

- [x] 4.1 `src/cli/teardown.ts` — the `teardown` verb: trigger parse (close event, fork skip
        per feat-003/AC-3), broker, `teardownEnvironment()`, D8 exit codes. Tests in
        `tests/cli-teardown.test.ts` (feat-003/AC-2, feat-003/AC-3).
- [x] 4.2 `src/cli/sweep.ts` — the `sweep` verb: default-branch broker, `sweepEnvironments()`,
        the one-line-per-environment report, D8 exit codes. Tests in `tests/cli-sweep.test.ts`
        (feat-003/AC-8, feat-003/AC-9 exit paths).
- [x] 4.3 Register both verbs in `src/cli/main.ts`; `action.yml` gains the event-dispatch
        expression (D1). Test the dispatch mapping by parsing `action.yml`
        (feat-003/AC-12 half).

## Phase 5 — Install surface and shipped-feature changes  _(0.1 decided; 5.2 is the amendment landing)_

- [x] 5.1 `src/cli/init.ts`: scaffolded workflow gains `closed`, the `schedule` block, and
        `pull-requests: read`; re-install updates and reports (feat-003/AC-12, on the
        feat-002/AC-20 temp-tree harness). `terraform/deploy-role.example.tf` trust gains the
        default-branch subject, with the widened blast radius stated plainly in its comment
        (D4, security S2).
- [x] 5.2 Land 0.1(a)'s pair — the constitution's third exception (worded to state the
        repo-wide IAM shape narrowed by session policy, per security S3) and the `roles.tf`
        read-only grant — as the main-branch PR the human approved, updating in the same PR
        the two shipped-spec sentences the amendment falsifies (backing store AC-17's "nothing
        else", deploy action AC-19's "nothing further"; D10). Then re-run the pre-build checks
        the shared-file edit restages. File the D10 change entries against feat-001 and
        feat-002.
        DONE 2026-08-16, all in one motion on the human's "land it": constitution (third
        exception + touches-only-what-it-owns), `roles.tf` (`DenyAllButReadingProtectionMarks`,
        `ReadEphemeralProtectionMarks`, list prefix, deny-outside exemption; `terraform
        validate` clean), both sibling ACs, change entries `feat-001/chg-010` and
        `feat-002/chg-006`, their plan/tasks annotations, and the test updates in
        `tests/bootstrap-terraform.test.ts` and `tests/deploy-adapters.test.ts` (suite green).
        All three features re-gated against the amended constitution the same day.

## Phase 6 — Live verification  _(blocked on phases 1–5)_

- [x] 6.1 DONE 2026-08-16 — every criterion proven live, plus a genuinely dropped close
        event the sweep repaired unprompted; full record on `hs-3`. Was: the live session
        against the deadweight repo and the real account, driving the
        production adapters: close a pull request and watch AC-1 end to end; suppress the
        close workflow and watch the sweep repair it (AC-6); a hand-planted protection marker
        survives both paths (AC-4); reopened-after-teardown deploys fresh (AC-11); the cap
        slot frees (AC-13). Record observations — including scheduler lateness against the
        15-minute cadence — on manifest item `hs-3`.
