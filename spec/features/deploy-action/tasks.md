# Tasks — deploy-action (feat-002)

Glyphs: `[ ]` not started · `[~]` in progress · `[x]` done · `[-]` n/a · `[H]` human-gated.
`[P]` marks a task that may run concurrently with its siblings in the same phase.

Tests come before the implementation they cover (feat-001's convention; the constitution requires
core logic testable against fakes with no cloud account).

## Phase 0 — the calls that are not the agent's to make

These come first on purpose. One decided a security boundary; the other proves the fact the whole
credential design rests on, before a shipped trust policy depends on it.

- [x] 0.1 **Decide the pull-request role's `ListBucket` widening** (`hs-1`). Terraform enumerates
      workspaces by listing at `state/<repo>/`, and the shipped policy allows listing only at
      `state/<repo>/pr-*`.
      **DECIDED 2026-08-14 — option (a):** widen the list-prefix condition to `state/<repo>/` and
      `registry/<repo>/`. Object grants untouched, so a pull-request run may enumerate environment
      *names* and do nothing else with them; it is also what lets the cap count every environment
      rather than only the `pr-*` ones. Bending the workspace prefix to `state/<repo>/pr-` was
      rejected because it files state where `stateDirFor()` does not point and hard-codes `pr-`
      into the layout every future environment shares; dropping workspaces was rejected because it
      forfeits AC-12. Full reasoning in `feature.md`'s `hs-1`.
      One refund stays open and is not depended on: if `TF_WORKSPACE` selects a workspace without
      Terraform enumerating first, the *state* half of this widening becomes unnecessary. Check it
      opportunistically during 0.3's live session.

- [x] 0.2 **Record `chg-007` against feat-001** with `/spec-flow:change`, covering the eight rows of
      plan D9 as one change: the record's `url` field, `countEnvironments()` beside `countActive()`,
      the two configuration additions, `init --account` (**since withdrawn by `chg-002`** — kept in
      this list because it records what chg-007 authorized, not what shipped), the bootstrap's
      `account_id` output, the
      pull-request role's `job_workflow_ref` trust condition (**since withdrawn by `chg-001`; the
      backing store needs its own change record to match**), whatever 0.1 decided about listing,
      and the workflow files `init` scaffolds. Nothing in
      Phase 1 or Phase 5 starts before this is recorded — those phases edit feat-001's files, and
      editing a shipped feature without a delta is the thing the change process exists to prevent.

- [-] 0.3 **Prove `job_workflow_ref` against the live account** (`hs-2`). **Retired by `chg-001`,
      not run.** The probe existed so that Phase 5 could write the claim into a shipped trust
      policy; the constitution no longer asks for the boundary that trust policy was closing, so
      nothing shipped depends on the answer. The scaffolding in `.scratchpad/job-workflow-ref-probe/`
      is dead and can be deleted.
      What was worth learning from writing it is recorded in `chg-001`'s proposal instead: the
      trigger-based privilege split never rested on `job_workflow_ref`. An OIDC subject names what
      *triggered* a run, not which workflow file ran, so a pull request that edits skyhook's own
      workflows is still offered only the narrower credentials. The exotic claim bought the
      preview-to-preview cut alone.
      One thing the probe would also have stood up is still needed: `deadweight` has no commits and
      no remote. Task 6.1 now carries that.

## Phase 1 — the contract additions (authorized by `chg-007`)

- [x] 1.1 `[P]` `src/core/types.ts` — `EnvironmentRecord` gains `url: string | null`; `Registry`
      gains `countEnvironments()`, which counts registry keys from the listing and **reads no object**
      (plan D7 — the narrowed session cannot read another record, so a cap check that reads them all
      cannot run at all). `countActive()` stays as it is: the sweep genuinely wants that question.
      It lists at `registry/<repo>/`, which 0.1 decided to permit — under the old grant it could
      only see `pr-*` and would have undercounted the moment a long-running environment existed.
      Files: `src/core/types.ts`, `src/core/registry.ts`, `tests/registry.test.ts`,
      `tests/registry-keys.test.ts`. A record written before this change deserializes with
      `url: null` rather than being rejected — the field is additive, and rejecting old records
      would strand every environment the prototype has already recorded. The count test asserts
      against a fake store that **fails** every `read()`, which is the only way to prove the
      reads are gone rather than merely unnecessary.
- [x] 1.2 `src/core/config.ts` — `storage.account` (written by `init --account`, or left as a
      commented placeholder and named by `skyhook deploy` when absent — plan D4), and an optional `deploy` block with
      `directory` (required within the block) and `role_prefix` (optional, default `skyhook`).
      Both additions parse as **optional at the top level**, so an installation written by today's
      `init` still runs `bootstrap` and `destruct`; only `skyhook deploy` requires them.
      Files: `src/core/config.ts`, `src/core/types.ts`, `tests/config.test.ts`. Tests cite
      `feat-002/AC-16`, and assert an unknown key inside `deploy` is still an error — feat-001's
      rule that a silently-defaulted setting cannot happen applies to the new block too.
      Not `[P]`: it edits `src/core/types.ts` alongside 1.1.
      **Incomplete, and left checked off deliberately — see phase 8.** The parser this task built is
      correct and stays. What it never built is the other half of plan D4: the `--account` flag and
      the commented placeholder in the generated settings file. `init.ts` is not in the file list
      above, and nothing caught that, because the tests here exercise `parseConfig()` against
      hand-written documents and never against the document `init` actually writes. `chg-002` builds
      the placeholder, withdraws the flag, and closes the gap by asserting the two against each
      other (task 8.2).
- [x] 1.3 `[P]` `src/core/ports.ts` — `EnvironmentDeployer` (deploy one environment, return a URL
      or a typed failure that distinguishes the consumer's apply from skyhook's own) and
      `TriggerSource` (what the CI host says happened). Neither may name AWS, S3, or Terraform.
      Files: `src/core/ports.ts`. These are the two seams that keep `src/core/deploy.ts` runnable
      without a cloud account, which the constitution's quality bar requires.

## Phase 2 — the use case

Sequential: each task extends the same function and its test file.

- [x] 2.1 `src/core/deploy.ts` — `deployEnvironment()`: the fixed ordering of D7, with fakes for
      every port. Tests cite `feat-002/AC-2` (a deployer that fails still leaves the record) and
      `feat-002/AC-10` (a fork trigger claims nothing, deploys nothing, and returns a skip outcome
      rather than a failure).
      Files: `src/core/deploy.ts`, `tests/deploy.test.ts`, `tests/fake-deployer.ts`. The fake
      deployer records *when* it was called relative to the store write, because "the record
      precedes the resource" is an ordering claim and only an ordering assertion tests it.
- [x] 2.2 The cap and claim-or-refresh, counting with `countEnvironments()` (1.1). Tests cite
      `feat-002/AC-9` (at the cap: non-zero, both numbers named, no key written, deployer never
      called, no record object read, and the message reading "environments recorded" rather than
      "active" — the count is of records now, and a pull request that already holds one is *not*
      blocked), `feat-002/AC-4` (second push: one record, same identity, new
      commit), and `feat-002/AC-5` (a `released` record returns to `active`; no second key —
      unprovable end to end until teardown exists, per the spec's sharp edges).
      Files: `src/core/deploy.ts`, `tests/deploy.test.ts`. Read-then-claim-or-update, never
      `claim()` alone: feat-001's D2b refuses an existing record by design, which is right for
      handing out a free name and wrong for a pull request returning to its own environment.
- [x] 2.3 The commit, the URL, and the timing. Tests cite `feat-002/AC-3` (a failed apply leaves
      the recorded commit — or null — alone), `feat-002/AC-13` (the URL lands on the record and
      survives a re-read), `feat-002/AC-6` (two identities produce disjoint keys and neither run
      reads the other's), and `feat-002/AC-14` (the reported figure excludes the deployer's own
      elapsed time but **includes** its backend-init and workspace-selection split, using an
      injected clock — AC-14 names "selecting the environment's copy" as skyhook's own, so the
      deployer reports two durations rather than one, per plan D7a).
      Files: `src/core/deploy.ts`, `src/core/ports.ts`, `tests/deploy.test.ts`.

## Phase 3 — the adapters

- [x] 3.1 `[P]` `src/adapters/github/event.ts` — `parseTrigger()` over `GITHUB_*` and the event
      payload at `GITHUB_EVENT_PATH`: repository, pull request number, **head SHA** (not
      `GITHUB_SHA`, which on a `pull_request` event names an ephemeral merge commit), and whether
      the head repository is a fork. Tests cite `feat-002/AC-10`.
      Files: `src/adapters/github/event.ts`, `tests/github-event.test.ts`.
- [x] 3.2 `[P]` `src/adapters/github/oidc-token.ts` — request an id-token for an audience from the
      Actions token service (`ACTIONS_ID_TOKEN_REQUEST_URL` / `_TOKEN`). Injected `fetch`.
      Files: `src/adapters/github/oidc-token.ts`, `tests/oidc-token.test.ts`. A missing request URL
      means the workflow did not grant `id-token: write`, and the message says exactly that rather
      than reporting a network failure.
- [x] 3.3 `[P]` `src/adapters/aws/session-policy.ts` — `sessionPolicyFor(repository, identity)`.
      Tests cite `feat-002/AC-7`: the policy names this identity's registry key and state prefix
      and no other, permits listing (needed for the cap and for workspace selection) without
      permitting any read or write outside the environment, and denies everything else explicitly.
      Files: `src/adapters/aws/session-policy.ts`, `tests/session-policy.test.ts`. Also assert the
      rendered policy stays inside the 2048-character inline-policy limit for a plausible worst
      case, since exceeding it fails at assume time rather than at build time.
- [x] 3.4 `[P]` `src/adapters/aws/sts.ts` — `assumeRoleWithWebIdentity()`. No SigV4: this call is
      authenticated by the token itself. Returns credentials and, from `AssumedRoleUser.Arn`, the
      **account id** — which is what lets skyhook derive role ARNs without a second signed call.
      Requests an explicit short `DurationSeconds` rather than taking the one-hour default: the
      consuming repository's Terraform runs alongside these credentials and can read them, so how
      long a stolen one stays useful is the only part of that skyhook controls (plan D3).
      Injected `fetch`. Files: `src/adapters/aws/sts.ts`, `tests/sts.test.ts`.
- [x] 3.5 `[P]` `src/adapters/terraform/runner.ts` — `workspaceSelectOrCreate()`, `outputJson()`,
      backend-config arguments, and per-child environment variables so one process can run the
      providers as one role and the backend as another (D6).
      Files: `src/adapters/terraform/runner.ts`, `src/cli/process.ts` (`RunOptions` gains `env`),
      `tests/adapters.test.ts`.
- [x] 3.6 `src/adapters/terraform/environment.ts` — `EnvironmentDeployer` over the runner. Writes
      `zz_skyhook_backend.tf`, initializes with `workspace_key_prefix = state/<repo>` and
      `key = terraform.tfstate`, selects the workspace by identity, applies, reads the `url`
      output, removes what it wrote — including on failure — and reports its two durations
      separately (D7a). Depends on 3.5. The prefix above is the one 0.1 settled on.
      Tests cite `feat-002/AC-12` (the workspace is selected by identity and **no `-var` is passed
      at all**) and `feat-002/AC-17` (the resulting state key equals `terraformStateKeyFor()`).
      Files: `src/adapters/terraform/environment.ts`, `tests/terraform-environment.test.ts`.
- [x] 3.7 **The state location cannot be moved by the pull request** (plan D6a). Before init, refuse
      any `*_override.tf` / `*_override.tf.json` in the definition directory, and any
      `terraform { backend … }` block outside skyhook's own file, naming the offending file. After
      init and before apply, read `.terraform/terraform.tfstate` and assert the initialized backend
      is `s3` at the expected bucket and key. After a successful apply, read that key back through
      skyhook's own store and fail loudly naming a possible orphan if nothing is there — the second
      check reads an undocumented Terraform working file and would stop checking rather than fail if
      its shape changed, and a defense that can silently lapse needs one behind it that cannot.
      Depends on 3.6.
      Tests cite `feat-002/AC-17`, and all three are fed a **planted** override rather than a
      clean directory — a denylist never shown a real trick proves nothing.
      Files: `src/adapters/terraform/environment.ts`, `tests/terraform-environment.test.ts`.
      This is the finding the pre-build check called blocking: the directory holds the pull
      request's own files, Terraform lets an override file relocate the backend, and skyhook's own
      runner already demonstrates the technique. Without this, a one-line file turns a successful
      deploy into real infrastructure whose state dies with the runner — an orphan by construction,
      with an honest registry record pointing at nothing.

## Phase 4 — the surface

- [x] 4.1 `src/cli/deploy.ts` and the `deploy` command in `src/cli/main.ts` — wiring and exit codes
      only, no logic. Derives both role ARNs from `storage.account` and `deploy.role_prefix` (D4).
      Tests cite `feat-002/AC-11` (deploy role absent: non-zero before any apply, naming the full
      ARN it looked for, the example file, **and** the requirement that the workflow be merged to
      the default branch — skyhook cannot tell those two apart from a trust refusal, and guessing
      sends the maintainer to the wrong file, per plan D12) and `feat-002/AC-18` (exit 3
      with the repository named for an apply failure, exit 1 otherwise, with distinct wording).
      Files: `src/cli/deploy.ts`, `src/cli/main.ts`, `tests/deploy-command.test.ts`.
- [x] 4.2 `action.yml` at the repository root — a composite action: `setup-node` pinned, then
      `node ${{ github.action_path }}/bin/skyhook.ts deploy`, with `url`, `identity` and
      `skyhook-seconds` as declared outputs. Depends on 4.1.
      Tests cite `feat-002/AC-15`: the manifest declares a `url` output, the command writes it to
      `$GITHUB_OUTPUT`, and no scaffolded workflow requests `pull-requests: write`.
      Files: `action.yml`, `tests/deploy-command.test.ts`.
      **Defect found and fixed during phase 5 (fidelity, no spec delta).** The action required
      `GITHUB_TOKEN` and supplied none, so every real run would have exited 1 on its first line —
      `skyhook deploy` reads settings from the default branch through the API, which is the whole
      of AC-16. The command's own tests inject the variable themselves, which is exactly how the
      gap survived them: an injected environment proves what skyhook does with a token, never that
      anything hands it one. `action.yml` now takes a `github-token` input defaulting to
      `${{ github.token }}` and passes it to the step, so the scaffolded workflow needs no `env:`
      block — every copy of that file being a place to get it wrong is the reason it defaults.
      Regression test cites `feat-002/AC-16`.

## Phase 5 — what `init` scaffolds (authorized by `chg-007`, revised by `chg-001`)

`chg-001` collapsed the two scaffolded workflow files to one and removed the `job_workflow_ref`
trust condition. What survives from the original shape is the ordering (D12) and the rule that a
scaffolded workflow passes no secrets.

- [x] 5.1 `[P]` `src/cli/init.ts` — write **one** workflow file, `.github/workflows/skyhook.yml`
      (`on: pull_request`): checkout + setup-node + `uses: skylight-hq/skyhook@<ref>`. Drop the
      "not built yet" note. Tests cite `feat-002/AC-15`.
      Files: `src/cli/init.ts`, `tests/install.test.ts`. The file passes **no** secrets — assert it
      does not use `secrets: inherit`, since that would hand every repository secret to a job
      running the pull request's own Terraform. `init`'s closing message states the ordering (D12):
      the workflow must reach the default branch before any pull request can deploy.
      A comment in the generated file says what a reader will otherwise assume wrongly: a pull
      request may edit this file, and doing so grants it nothing extra, because the credentials it
      can reach are fixed by what triggered the run rather than by what the file says. It also says
      what editing the file *can* do — reach a sibling preview environment — and points at the
      constitution clause that calls that a decision.
      **Done.** Scaffolded to `.skyhook/workflow.yml` for the operator to copy, following the
      shipped pattern rather than writing into `.github/workflows/` directly — skyhook restores
      every file it manages, and silently reverting someone's CI configuration is the surprise
      that pattern exists to avoid. The destination path is the constant this phase agrees on.
      `configure-aws-credentials` is gone with it: skyhook brokers both credentials itself (D3),
      so no role ARN appears in the file at all and there is nothing there to get wrong.
      Files: `src/cli/init.ts`, `tests/install.test.ts`, `tests/cli.test.ts`.
      **Found while building:** `--default-branch` had become dead. It only ever reached the
      workflow's `push` trigger, which this task removed — while the bootstrap's trust policy
      takes it as a variable the closing message never passed. An operator who set it got a
      workflow that agreed with them and a trust policy that still said `main`. The message now
      emits `-var default_branch=…`, and `tests/cli.test.ts` asserts it there instead.
- [x] 5.2 `terraform/deploy-role.example.tf`, copied by `init` to
      `.skyhook/deploy-role.example.tf` — a role whose trust names the pull-request `sub` under
      `StringEquals`, never `StringLike`, with permissions left deliberately blank and a comment on
      why the session it issues is short. Skyhook never applies it. *(Amended by `chg-006`: the
      trust now also names the default-branch subject, for feat-003's scheduled sweep, with the
      widened blast radius stated in the file.)*
      Files: `terraform/deploy-role.example.tf`, `src/cli/init.ts`, `tests/install.test.ts`.
      Not `[P]`: it edits `src/cli/init.ts` alongside 5.1.
      The comment must also say what this trust does **not** buy, because the example lost its
      workflow pin with `chg-001` and a maintainer copying it will assume otherwise: naming the
      pull-request subject alone makes the role assumable by any pull-request job in the repository,
      including one that never runs skyhook and so never writes a registry record first. Not a new
      capability — a pull request could always run arbitrary Terraform under this role by editing its
      own definition, which skyhook does not audit — but the bypass no longer has to pass through
      skyhook. Whether skyhook should object to an over-wide deploy role is this feature's one
      remaining open question, and the comment should not pretend it is settled.
      **Done.** `terraform validate` passes on the example standing alone, which is how a
      maintainer will first meet it. Permissions left blank as specified.
      Files: `terraform/deploy-role.example.tf`, `src/cli/init.ts`, `tests/install.test.ts`.
- [x] 5.3 `[P]` `terraform/bootstrap/roles.tf` — no trust-policy change. Per 0.1, the `ListBucket`
      prefix condition gains `state/<repo>/` and `registry/<repo>/` — listing only; every
      `GetObject`, `PutObject` and `DeleteObject` grant stays exactly as shipped, and the test
      asserts that they do. `outputs.tf` gains `account_id`.
      Tests cite `feat-002/AC-17`.
      Files: `terraform/bootstrap/roles.tf`, `terraform/bootstrap/outputs.tf`,
      `tests/bootstrap-terraform.test.ts`.
      The KNOWN LIMIT block and the `known_limit_pull_request_isolation` output are rewritten, but
      not to announce a closed boundary — to say that the boundary is open by decision, what it
      costs (a sibling preview can read this one's state, including any credential the
      infrastructure generated for itself), and what is unaffected. It stops being a limit awaiting
      a fix and becomes a property an operator should know. Deleting the text outright would leave
      operators with no statement of where the boundary is at all.
      **Done.** `terraform validate` passes. The block is retitled *WHERE THE BOUNDARY IS* and the
      test now asserts the new framing and the absence of the old "To close this:" promise —
      previously it matched on the phrase "KNOWN LIMIT", which a stale role `description` was
      still supplying, so it would have passed over a deleted block.
      Files: `terraform/bootstrap/roles.tf`, `terraform/bootstrap/outputs.tf`,
      `tests/bootstrap-terraform.test.ts`.

## Phase 6 — the test consumer

`../deadweight` becomes a real consuming repository rather than a harness. That is what keeps the
test honest.

- [x] 6.1 `[P]` Stand `deadweight` up as a real repository first — it has no commits and no remote,
      and the retired probe in 0.3 was going to do this. Then a deliberately trivial webapp: a
      bucket serving one page, named and tagged from `terraform.workspace`, with a `url` output. No
      input variable supplied by skyhook. Whether the account's public-access posture permits a
      publicly readable site is not skyhook's to set; if it refuses, AC-1's reachability half
      weakens to "the resource exists" and 7.1 records that.
      **Done.** `deadweight` now has a first commit on `main` carrying the webapp, the deploy role,
      a `README.md` that reads as a real repository's rather than a fixture's, and a root
      `.gitignore` — `git add -n` shows both lock files tracked and no state or `.terraform/`
      anywhere. Pushed to `github.com/arwagner/deadweight`, **private**, on human say-so, since
      creating a remote is the one step in this phase that publishes something.
      **Verified the ordering condition (D12) rather than assuming it**: `gh workflow list` reports
      `.github/workflows/skyhook.yml` as `active` on the default branch, so GitHub has registered
      the `pull_request` trigger. That is the precondition 7.1 fails silently without — a pull
      request opened before it lands runs nothing at all and explains nothing.
      Files: `../deadweight/infra/{versions,main,outputs}.tf`, `../deadweight/{README.md,.gitignore}`.
      **Verified**: `terraform validate` and `terraform fmt -check` pass on `infra/` standing alone,
      and skyhook's own `detectStateHijack('infra')` returns null — the definition declares no
      backend and carries no override, so it is one skyhook will agree to deploy. The webapp takes
      no `-var` from skyhook: `terraform.workspace` supplies the bucket name, the tags and the page
      body, so two environments differ in a browser tab and not only in the state.
      **Note for 7.1**: the account-level public-access posture is still unproven. If it refuses,
      the URL answers 403 and AC-1's reachability half weakens as this task says.
- [x] 6.2 `[P]` `deadweight`'s deploy role, copied from the scaffolded example and given the
      permissions its webapp actually needs. Written here; applied by a human in 7.1.
      **Done.** `terraform validate` and `terraform fmt -check` pass on `iam/` standing alone.
      Files: `../deadweight/iam/deploy-role.tf`.
      It lives in `iam/` rather than `infra/` for two reasons worth keeping: skyhook applies
      `infra/` *with* this role, so a role declared there could not create itself; and `infra/` is
      applied once per environment as a workspace, which would give every preview its own copy of a
      role the repository has one of. The permissions are scoped to `arn:aws:s3:::deadweight-*` —
      skyhook's own bucket is `skyhook-*`, so the deploy role cannot read the registry or any
      environment's state even though it runs in the same process. The read set is granted whole
      because refreshing one `aws_s3_bucket` calls a dozen `GetBucket*` APIs, and an AccessDenied on
      any of them surfaces as a confusing plan rather than as a permission error.
- [x] 6.3 `[P]` `deadweight`'s workflow file, from `skyhook init`, plus the repository's
      `.skyhook/config.yml` gaining `storage.account` and the `deploy` block.
      **Done.** `skyhook init` regenerated `.skyhook/workflow.yml` and the bootstrap definition
      (restoring 5.3's widened listing), wrote `.skyhook/deploy-role.example.tf` for the first time,
      and the workflow was copied to `.github/workflows/skyhook.yml` — where it has to be, and on
      the default branch, or a pull request triggers nothing at all and says nothing about why.
      `storage.account` is the bootstrap's real `account_id`, quoted; `deploy.directory` is `infra`
      and `deploy.role_prefix` is named rather than defaulted so it visibly agrees with `iam/`.
      Files: `../deadweight/.skyhook/config.yml`, `../deadweight/.github/workflows/skyhook.yml`.
      **Verified** by skyhook's own parser rather than by eye: `parseConfig()` on the real file
      returns the account and the deploy block as read, which is the reading a deploy will get.
      **Found while building — not fixed here, and it will bite 7.1 if it is not settled.**
      `.skyhook/config.yml` is a file skyhook MANAGES, and `init` restores a managed file whole
      rather than merging it (feat-001/AC-13, deliberate). But `init`'s own closing message, step 2,
      tells the operator to hand-edit that same file. So re-running `init` — the ordinary way to
      pick up a new skyhook version's workflow — reverts `storage.account` and the whole `deploy`
      block, and the next deploy fails claiming the installation does not deploy. Reproduced against
      a copy of the real installation: `init` reported `restored .skyhook/config.yml` and
      `parseConfig()` afterwards read `account: null, deploy: null`. Neither spec noticed the
      collision, so this is not a fidelity defect in either — it is feat-002 putting
      operator-supplied values into a file feat-001 owns and restores.

## Phase 7 — live verification

- [x] 7.1 **End to end against the real account** (`hs-3`). Open a pull request on `deadweight` and
      confirm, in this order: the URL comes back and an unauthenticated request to it returns 200
      (`AC-1`); skyhook's own share of the run is under 60 seconds (`AC-14`); a second push updates
      the same environment and records the new commit (`AC-4`); two pull requests at once produce
      two environments and two true records (`AC-6`); the credentials the run holds are refused for
      a long-running environment, another repository's environment, and a protection mark (`AC-7`) —
      and deliberately *not* for a sibling preview, which `chg-001` reclassified as a decision; the
      narrowing skyhook asks for names this run's own registry key and state prefix and no other
      (`AC-19`); the state lands at
      `state/<repo>/pr-<n>/terraform.tfstate` (`AC-17`); a pull request that plants a
      `*_override.tf` redirecting the backend is refused before anything is applied (`AC-17`, plan
      D6a); and a deliberately broken definition exits 3 leaving the recorded commit unchanged
      (`AC-3`, `AC-18`).
      Nothing above this line can establish any of it: an injected runner proves what skyhook
      *asks* Terraform and STS to do, never whether they accept it. That is the exact defect class
      feat-001's task 10.4 was bitten by, twice, in code its tests called green.
      **Three preconditions, found on the first attempt to run this and none of them written down
      before.** In order:
      (a) **Skyhook's own action must reach a ref the consumer can resolve.** The scaffolded
      workflow says `uses: skylight-hq/skyhook@main`, and `action.yml` together with the whole
      `deploy` command lives only on this unpushed feature branch — `main` is 14 commits behind and
      has no action at all. This is D12's ordering trap turned around: D12 says the *consumer's*
      workflow must reach its default branch before a pull request triggers anything, and the same
      rule applies to *skyhook*, which nothing said.
      (b) **A private action cannot be consumed across that boundary.** `skylight-hq/skyhook` is a
      private repository in an organization; `arwagner/deadweight` is a personal repository outside
      it. GitHub shares a private action only within the owning organization, so `uses:` cannot
      resolve it as things stand. Making skyhook public, moving the test consumer into the
      organization, or checking skyhook out and calling it by path are the three ways out, and they
      are not equivalent — only the first two exercise the path a real consumer takes.
      (c) **The deploy role must be applied**, which needs credentials for the account. That one was
      known; it is task 6.2's "applied by a human in 7.1".
      **First live attempt, 2026-08-15. Three defects found, two fixed, one is a design decision.**
      What now works, proven rather than assumed: the bootstrap applies and is idempotent on a
      second run, the trust anchor is adopted rather than recreated, the deploy role is created and
      its identifier is exactly the one skyhook derives, the action resolves and runs, and skyhook's
      own `deploy` command executes and reports a precise, actionable failure.
      **Fixed (defect lane, no spec delta):** an em dash in a role `description` — IAM's pattern
      stops at Latin-1, so `CreateRole` failed *after* the bucket and the other role existed.
      **Fixed (defect lane, no spec delta):** the scaffolded workflow never parsed, for any
      consumer, because `run: echo "Environment: ${{ ... }}"` is not valid YAML — a plain scalar
      may not hold `": "`. GitHub reports this almost invisibly: no annotation, no error on the
      pull request, the trigger silently never fires, the failed run is attributed to the *push*
      rather than the trigger, and the workflow is listed under its own path instead of its name.
      Found by bisecting twelve probe workflows against the live repository.
      **THE FIRST ENVIRONMENT EXISTS.** 2026-08-15, `pr-1` on `skylight-hq/deadweight`, run
      31895264674. Six resources applied, and the page answers.
      Verified against reality, not against the log's word for it:
      - `AC-1` — `curl` to the returned URL, unauthenticated, from here: **HTTP 200**, body reading
        *Environment: pr-1*.
      - `AC-12` — that `pr-1` in the page came from `terraform.workspace`. Skyhook passed no
        variable, and the definition declares none for it.
      - `AC-17` — the state landed at
        `state/skylight-hq/deadweight/pr-1/terraform.tfstate`, byte-for-byte the layout
        `stateDirFor()` computes, with no policy widened to make it fit.
      - `AC-2`, `AC-3`, `AC-13` — the record at `registry/skylight-hq/deadweight/pr-1.json` carries
        `state: active`, the deployed commit, the URL, and both timestamps.
      - `AC-15` — the calling workflow consumed `steps.skyhook.outputs.url` in a later step, which
        is the whole contract: skyhook hands the address back and writes nothing to the pull request.
      **Two further defects, both fixed, both invisible from here:**
      (d) the action never installed Terraform. GitHub's images no longer ship it, and skyhook had
      already claimed and recorded `pr-1` before finding it had nothing to apply with.
      (e) `terraform init` was refused with a 403 on `terraform.tfstate` at the *root* of the
      bucket. The S3 backend files a named workspace under `workspace_key_prefix` but the DEFAULT
      workspace at the bare key, which is outside every prefix either role grants. Skyhook never
      wanted the default workspace; it now chooses the environment's through `TF_WORKSPACE` before
      `init` runs, rather than selecting it after. **This also collects the refund `hs-1` left
      open**: Terraform no longer enumerates workspaces, so the `state/<repo>/` half of the
      `ListBucket` widening may now be unnecessary. Worth a separate look before it is removed.
      **`od-1` resolved by the same run**, and not the way the options predicted — see the decision.
      **Second pass, same day. Four more criteria proven, one more defect found.**
      - `AC-4` — a second push to `pr-1` reported `identity = pr-1`, applied *0 added, 1 changed*,
        and left **exactly one** record whose `createdAt` never moved while its commit and
        `updatedAt` did. The page changed with it.
      - `AC-14` — `skyhook-seconds = 12.2`, against a budget of 60, excluding the consumer's apply.
      - `AC-15`, more fully — the calling workflow read `identity` and `skyhook-seconds` as well as
        `url`, so every output the action declares is genuinely available to it.
      - `AC-18` and `AC-3`'s failure half — a definition broken on purpose (an invalid bucket name)
        exited **3**, said *the repository's own "terraform apply" failed in infra ... not of
        skyhook*, and left the recorded commit at the previous one. The broken commit was never
        recorded.
      - `AC-2`, again and more convincingly — `pr-2` failed before applying anything and its record
        exists regardless, with no state and no infrastructure. An environment on the books that a
        later sweep can find is exactly what the ordering is for.
      **OPEN — `od-2`, and not the agent's to decide.** `TF_WORKSPACE` selects a workspace but does
      not create one, so the *first* deploy of a *new* environment fails at init with
      `Currently selected workspace "pr-2" does not exist`. `pr-1` only ever worked because its
      state already existed from a run made before that fix. Creating a workspace needs a
      successful init, and an init without `TF_WORKSPACE` reads the default workspace's state at
      the bucket root — which is the 403 that fix was for. The way out touches either a shipped IAM
      policy or skyhook hand-authoring Terraform state, so it is a human call.
      **AC-6 PROVEN, 2026-08-15**, once `chg-008` landed. Two pull requests, two records
      (`pr-1.json`, `pr-2.json`), two independent states under their own prefixes, and two pages
      that answer 200 and say different things: *Environment: pr-1* and *Environment: pr-2*.
      Neither run touched the other's state. `skyhook-seconds = 11.3` for the second.
      **Third pass. Three more criteria proven, two stale messages fixed.**
      - `AC-9` and `AC-16`, in one run and on purpose. With the cap set to 2 on the default
        branch and two environments standing, a third pull request **raised the cap to 99 in its
        own branch’s settings** and was refused anyway: *the environment cap is reached: 2
        environments recorded, cap 2. Nothing was recorded and nothing was applied.* Exit 1, and
        no `pr-3` key appeared in the registry or the state. A pull request cannot raise its own
        cap, which is the whole reason settings are read from the default branch.
      - `AC-11` — with the deploy role destroyed, the run failed **before applying anything**
        (`pr-1`’s state timestamp never moved), named the exact role identifier it looked for, and
        pointed at `.skyhook/deploy-role.example.tf`.
      **Two defects in what skyhook SAYS, both found only by reading a real failure.** The
      role-assumption message and the deploy-role advice each described the reusable-workflow
      trust design that `chg-001` withdrew — telling a maintainer to merge a second workflow file
      that does not exist, and to run from the default branch, which a pull-request run must never
      do. Both now name what actually refuses a run, including the ID-qualified subject case.
      Advice is as shippable as code and goes stale the same way; nothing in the suite noticed,
      because no test asserts on prose that no longer matches the design.
      A healthy deploy was re-run afterwards and still succeeds, so none of the failure-path
      poking left the installation broken.
      **Still unverified, and each needs something this account cannot cheaply supply:** `AC-5`
      (closed and reopened — the spec already says this cannot be proved before teardown exists,
      since nothing here marks an environment released), `AC-7` and `AC-19` (what the cloud refuses
      in practice: a long-running environment, another repository's environment, and a protection
      mark, each attempted with the credentials a run actually holds — none of those neighbours
      exist in this account yet, so proving the refusal means creating them first), and `AC-10` (a
      fork pull request, which needs a second GitHub account to fork from).
      **`AC-7` was closed on 2026-08-16 and is no longer in that list** — see below. `AC-5`,
      `AC-10` and `AC-19` remain.
      **The neighbours now exist, 2026-08-16.** Five fixture objects, written to
      `skyhook-deadweight-state-12345` with an operator's own credentials, so that `AC-7` can be
      attempted at all:
      a long-running environment — `registry/skylight-hq/deadweight/staging.json` and
      `state/skylight-hq/deadweight/staging/terraform.tfstate`;
      another repository's environment — `registry/skylight-hq/neighbour/pr-1.json` and
      `state/skylight-hq/neighbour/pr-1/terraform.tfstate`;
      and a protection mark — `protected/skylight-hq/deadweight/staging`.
      They have to be REAL objects, and that is the whole reason for this step rather than an
      oversight of scale: S3 answers a refused read on a MISSING key with 403 rather than 404, so
      a 403 against a key holding nothing proves nothing. That is the same fact `chg-008` was
      bitten by, read from the other side. Each state fixture carries a fake secret attribute,
      because a credential sitting in the clear is exactly what the boundary is protecting.
      Placement was checked with `iam simulate-principal-policy` against
      `skyhook-pull-request`: all seven attempts (read either neighbour's record or state, and
      read, write or delete the mark) come back `explicitDeny`, while the control — read `pr-4`'s
      own record, write `pr-4`'s own state — comes back `allowed`. **That is not the proof and
      must not be recorded as one.** It is IAM evaluating a policy on request, with no OIDC token
      and no run behind it; `AC-7` asks what the cloud does to the credentials a pull-request run
      actually holds, which is the exact distinction this task's opening paragraph is about. What
      the simulation establishes is narrower and still worth having: the fixtures are in the right
      place, so a real run's 403 will mean the boundary held rather than the key was misspelt.
      **Two consequences to plan around.** The `staging` record counts toward the environment cap
      like any other — `countEnvironments()` counts keys and does not read them — so this
      repository now reads 2 of 5 rather than 1, which matters to any later re-run of the `AC-9`
      cap check. And the fixtures must be deleted once `AC-7` is signed off: nothing sweeps them,
      `staging` has no infrastructure behind it, and `skylight-hq/neighbour` is a fixture
      repository name rather than a repository. The `note` field in each record says so in place.
      **The probe is written and waiting to run**, as a second job (`boundary-probe`) in
      `skylight-hq/deadweight`'s own `.github/workflows/skyhook.yml`, on the `pr-4` branch. It
      lives in the consuming repository rather than in skyhook because it is scaffolding for one
      sign-off, not behaviour skyhook should ship and then maintain — and it is marked for deletion
      once `AC-7` is signed off. It assumes `skyhook-pull-request` by OIDC with **no session
      policy**, since `AC-7` is about what the role itself refuses and a run holds the intersection
      of role and narrowing: proving the outer layer proves the floor. It depends on no other job,
      so a failed deploy cannot hide a failed boundary.
      Thirteen attempts: nine that must be refused (read either neighbour's record or state,
      enumerate the other repository, and read, write, delete or enumerate the marks) and four
      controls that must succeed (list this repository's own registry, then write, read and delete
      a key inside the `pr-*` namespace). The controls are what stop nine refusals meaning nothing
      more than a dead session, and the registry-listing control is the `hs-1` decision made
      visible in one line: enumeration widened, object access did not follow.
      Rehearsed before it costs a pull-request round trip. The YAML parses — checked, because an
      unparseable workflow is this setup's most expensive failure mode and has already cost one
      session; the script's syntax is clean; every command was run against the live bucket with
      operator credentials, which both proves the commands are well-formed and re-confirms all
      five fixtures are readable. Then `iam simulate-principal-policy` was run over the exact
      thirteen: all nine refused, all four allowed.
      **One asymmetry worth knowing, found by that simulation.** The seven object refusals are
      `explicitDeny`; the two *enumeration* refusals are `implicitDeny`. Listing acts on the bucket
      ARN, which `DenyEverythingOutsideTheEphemeralNamespace` excludes through its `not_resources`,
      so what refuses a pull-request run enumerating another repository is the absence of a
      matching prefix condition rather than a deny. Both are a 403 at the API and `AC-7` is
      satisfied either way. The difference is what could happen later: widening the listing allow —
      which `hs-1` already did once — could quietly re-enable enumeration, where the object grants
      are refused twice over and cannot be widened by accident.
      None of that was the proof — it was all IAM evaluating a policy on request, with no OIDC
      token and no run behind it. The criterion asks what the cloud does to the credentials a
      pull-request run actually holds, which needs the job to run.
      **`AC-7` PROVEN, 2026-08-16**, pull request #4 on `skylight-hq/deadweight`, run 31953505432.
      Thirteen of thirteen. The session was
      `arn:aws:sts::123456789012:assumed-role/skyhook-pull-request/skyhook-ac7-probe` — the real
      role, obtained by the real OIDC exchange, from a real pull-request trigger. Every one of the
      nine forbidden operations came back refused, and all four controls succeeded, so the
      refusals mean the boundary rather than a dead session.
      **Corroborated by effect, not only by error message**, which is the part that makes this
      hard to fool. An operator-side listing minutes after the run shows all five fixtures still
      present and byte-for-byte intact; `protected/skylight-hq/deadweight/` holds the fixture mark
      and nothing else. Had the write attempt succeeded there would be a `probe-write-attempt` key,
      and had the delete succeeded the mark would be gone. Two of the nine refusals are therefore
      confirmed by what did NOT happen to the bucket, independently of what the CLI said. The
      control key was cleaned up by the probe itself and left nothing behind.
      **The first attempt failed, and on the probe rather than on the boundary** — run 31953326096,
      twelve passed and one failed. `--body /dev/null` is rejected by the CLI before the request is
      signed, because it validates a blob argument by asking whether the path is a regular file and
      a character device is not one, so that attempt never reached S3. The harness scored it
      *failed for an unexpected reason* rather than as a refusal, which is the behaviour that makes
      the other twelve worth anything: a probe that counts a malformed call as a pass manufactures
      evidence. Worth noting the local rehearsal could not have caught it, because the read-only
      smoke test had every mutating attempt stripped out of it.
      **What this does NOT establish**, in case a later reader is tempted to bank it: `AC-19`,
      which is about the narrowing skyhook *asks for* and is untouched by the probe, which
      deliberately carries no session policy because `AC-7` is about the role's own floor. See the
      separate `AC-19` finding below. `AC-5` and `AC-10` are also still open, on teardown and on a
      second GitHub account respectively.
      **`AC-19` has an evidence path after all, and it needs no product change.** CloudTrail
      records the inline session policy verbatim in the `AssumeRoleWithWebIdentity` request's
      `requestParameters.policy`, which is precisely "the request skyhook makes" the criterion asks
      to inspect. Checked against run 31953505432: the assume for session `skyhook-pr-4` on
      `skyhook-pull-request` carries the narrowing, and it is **byte-for-byte identical** to what
      `sessionPolicyFor()` computes for that repository, identity and bucket — 1048 characters
      against the 2048 ceiling. So the loop from code to cloud closes with a diff rather than with
      a claim. Two neighbouring events corroborate the design while they are in view: the same run's
      assume of `skyhook-deploy` carries NO policy, which is right — the consuming repository's own
      role is not skyhook's to narrow — and `skyhook-ac7-probe` carries none either, which is the
      deliberate choice recorded above.
      **But `AC-19` cannot be signed off as currently written, and this is the finding.** The
      recorded narrowing names four things, not three. Three match the criterion exactly: the run's
      registry key (`registry/skylight-hq/deadweight/pr-4.json`, the single key, not a prefix), the
      run's state prefix (`state/skylight-hq/deadweight/pr-4/*`), and the one permitted read of
      `terraform.tfstate` — with a `NoOthers` deny whose `NotResource` is exactly those three. The
      fourth is a `ListBucket` allow spanning `registry/<repo>/*`, `state/<repo>/*` and
      `terraform.tfstate` — enumeration across the whole repository, wider than the one environment.
      That is deliberate and load-bearing: `session-policy.ts` says so in as many words, and the cap
      cannot be counted any other way once a session is narrowed. The gap is in the criterion, which
      says "and nothing further" and enumerates three. `hs-1` decided this widening at the ROLE
      layer and the spec absorbed it there; the SESSION layer half never reached `AC-19`, including
      when `chg-003` modified that criterion in place. Signing it off against the current text would
      be recording something untrue. Fold the enumeration into `AC-19` with a change first — the
      same lane `chg-003` used — then it is provable in one CloudTrail read.
      Worth noting what found this: comparing a criterion against a live artifact rather than
      against the code's intent. `converge` has never run on this feature.
      **`AC-19` PROVEN, 2026-08-16**, once `chg-004` folded. The criterion now describes the four
      grants the narrowing actually asks for, and CloudTrail's record of run 31953505432 satisfies it
      as written — the same evidence, against a criterion that is now true. No further deploy was
      needed. The ruling that unblocked it is recorded in `chg-004`: to see that an environment
      exists is not to reach it, and the constitution was amended to name enumeration as the first of
      its two exceptions rather than leave a reader to reconstruct `hs-1`'s reasoning.
      That amendment restages every feature's pre-build check, which is the cost of touching a shared
      input and is why it went through its own change off `main`.
      **Fourth pass, 2026-08-16, against the merged `main`.** The remaining cheap check ran, and
      the two code changes of that day were exercised live for the first time.
      - **The state-hijack refusal PROVEN** (`AC-17`, plan D6a's FIRST defense), run 31962400157.
        A commit on `pr-4` planted `infra/zzz_override.tf` carrying `terraform { backend "local" {} }`
        — the attack D6a is written against, and the one skyhook's own bootstrap runner proves is
        available to anyone who reads this codebase. Skyhook refused, naming the file:
        *"zzz_override.tf: skyhook will not deploy a definition that carries a Terraform override
        file …"*, exit **1** — skyhook's own failure, not exit 3, because nothing of the
        repository's was at fault. **There is no `terraform init` anywhere in that run's log**, so
        the refusal landed before Terraform ran at all, which is what "before anything is applied"
        means.
        Corroborated by effect rather than by the message, following the `AC-7` discipline: minutes
        after, `registry/skylight-hq/deadweight/pr-4.json` still named commit `9733e840` — the
        PREVIOUS one, not the override commit — with `updatedAt` still at the earlier run's
        timestamp, and the environment still answered **HTTP 200**. Nothing was claimed, recorded,
        applied, or damaged. A healthy deploy immediately afterwards (run 31962467555) succeeded and
        moved the commit on, so the failure-path poking left the installation intact, as the third
        pass also took care to establish.
      - **`AC-14` after the timing fix** — the same run reported `skyhook-seconds = 3.2`, and a
        second healthy run 4.8, where the second pass recorded 12.2 before `terraform init` was
        moved onto the repository's side of the line (`gap-001`, `chg-005`, phase 11). The direction
        and rough size are what the fix predicts. **It is not a controlled comparison** — the runs
        did different work — so it corroborates and does not prove; what proves it is
        `tests/deploy-adapters.test.ts`, which asserts the boundary directly.
      - **The post-apply state check ran live for the first time** (`gap-002`, task 10.1) on its
        SUCCESS path, in every run above: each reported success, which under the new code is only
        reachable once the expected state key has been read back out of the real bucket. Its
        failure path — the orphan report — has not been exercised live and cannot be cheaply, since
        staging it means making a real apply land its state somewhere skyhook cannot see.
      **Still open on `hs-3`, and neither is cheap:** `AC-5` (an environment closed and reopened)
      waits on teardown, which does not exist yet — the spec already says so; and `AC-10` (a fork
      pull request) needs a second GitHub account to fork from. Every other criterion this task
      enumerates now has live evidence recorded above.
      **SIGNED OFF 2026-08-16 by andrew** (`hs-3`), with `AC-5` and `AC-10` deferred rather than
      proved — the reasons are recorded on the sign-off in `feature.md` and are blocked on teardown
      and on a second GitHub account respectively, neither of which exists here.
      **The fixtures and the probe are both GONE, 2026-08-16**, the sign-off having landed. Each
      fixture was confirmed by its own `note` field before deletion rather than by its key alone —
      both records say in place that they are fixtures with no infrastructure behind them — and the
      five went individually by key, never by prefix: the bootstrap's own state and `pr-4`'s live
      record and state sit in the same bucket, and a prefix delete is how that goes wrong. A
      listing afterwards shows exactly those three survivors and nothing else. The environment cap
      reads 1 again rather than 2, since `staging` counted toward it like any other record.
      The `boundary-probe` job is out of the consuming repository's workflow, leaving the trailing
      commentary that is about the workflow generally rather than about the probe. **Verified by
      running it, not by reading it**: a workflow that stops parsing does not report an error, it
      silently never fires, which has already cost one session here. The next push fired, listed
      one job, and deployed — so the file still parses and the trigger still works.
- [x] 7.2 Amend the constitution's "The boundary between two pull requests is not structural yet"
      clause to say what now holds. **Done ahead of the feature, as `chg-001`'s trigger rather than
      its consequence:** the clause now reads *Preview environments are not isolated from each
      other, by decision*, and the security guarantees around it are stated as outcomes rather than
      as IAM machinery. Carried by its own pull request off `main`, since `constitution.md` never
      changes inside a feature branch.
- [x] 7.3 Close backlog row 2 (`trusted-workflow-credentials`) as **declined** rather than done —
      the fix it proposed is the one `chg-001` decided not to build, and the reasoning belongs on
      the row so nobody re-proposes it from scratch. Add a row for what this feature leaves behind:
      a pull-request run can enumerate environment *names* under `registry/<repo>/` and
      `state/<repo>/` (plan D3), and can reach a sibling preview environment's state by editing the
      scaffolded workflow (constitution, *Preview environments are not isolated from each other*).
      **Done.** Row 2 is `rejected` — the vocabulary this backlog actually uses for "a human ruled
      it out", which is what makes the row match on concept when someone proposes it again. Its
      reasoning is on the row rather than in a change folder nobody will find: the trigger-based
      split never rested on `job_workflow_ref`, whether AWS honours that claim was never settled and
      no longer matters, and the boundary would only have defended against someone who already holds
      write access. Its stale "carried by AC-7 and AC-8" is corrected — `chg-001` removed AC-8.
      New row 5, `preview-boundary-residue`, carries both leftovers, including the open refund on
      the `state/<repo>/` half of the listing widening if `TF_WORKSPACE` turns out to select a
      workspace without enumerating first.

## Phase 10 — what the first code-vs-spec audit found (`converge` run 1)

Opened by `gap-002` in `converge.md`. The two other findings of that run are contradictions and
route through `/spec-flow:change` rather than through here.

- [x] 10.1 **The third state-location check, which was never built** (`gap-002`, AC-17, plan D6a).
      Task 3.7 claims three defenses and shipped two. `detectStateHijack()` refuses an override
      before init and `verifyBackend()` reads Terraform's own backend record before apply; nothing
      reads the expected state key back out of the bucket after a successful apply, and nothing
      names a possible orphan when it is absent. `TerraformEnvironment` holds no `Store`, so the
      capability is not merely unused — it was never wired.
      Why it is not redundant with the two that exist, in the plan's own words: the first is a
      denylist and is only ever right about the tricks it knows; the second reads
      `.terraform/terraform.tfstate`, an internal working file with no compatibility promise, so a
      shape change makes it **stop checking** rather than fail — the worse failure for a defense.
      The third depends on nothing but the object store and cannot silently lapse. It runs too late
      to prevent an apply, which is exactly why the other two exist; what it guarantees is that an
      environment whose state went missing is *reported* as possibly orphaned rather than reported
      as a success. That is the weakest form of the no-orphans non-negotiable and the one the plan
      says must never be unavailable.
      Files: `src/adapters/terraform/environment.ts`, `src/adapters/aws/broker.ts` (the deployer
      needs the store the broker already builds), `tests/deploy-adapters.test.ts`. Tests cite
      `feat-002/AC-17` and `gap-002`, and the fixture must be a store that reports the key ABSENT
      after a successful apply — asserting only the happy path would pass just as well against
      today's code, which never looks.
      Worth deciding while building it: skyhook's narrowed session may read its own state prefix,
      so the read is already permitted and needs no policy change. The failure it raises is
      skyhook's own (exit 1 per D8), not the repository's — the apply succeeded; what failed is
      skyhook's ability to promise the result can be found again.
      **Done.** `TerraformEnvironment` takes a `Store` — **required, not optional**, because an
      optional dependency is exactly how a check stops running without anyone noticing, which is
      what `gap-002` is; a construction site that forgets it no longer compiles. After a successful
      apply and before the address is read, `#confirmStateLanded()` lists the environment's state
      prefix and refuses the run when the expected key is not among the results. `broker.ts` passes
      the store it already builds for the registry, on the same narrowed session.
      **Listed rather than read**, which the task left open: the question is one bit, a managed
      environment's state can be large, and everything after the apply is counted against skyhook's
      own 60 seconds (AC-14). The narrowed session already permits both, so no policy change.
      A store that *cannot answer* is reported too, in its own words — "could not confirm" and
      "confirmed missing" are different sentences and neither may read as success.
      Files: `src/adapters/terraform/environment.ts`, `src/adapters/aws/broker.ts`,
      `tests/deploy-adapters.test.ts`. Three tests cite `feat-002/AC-17` and `gap-002`; the two
      that carry the weight were run against a deployer with the check disabled and failed, then
      passed with it. The fixture reports the key ABSENT after a successful apply, as required —
      a present-key fixture passes just as well against code that never looks. The double throws
      on `read`, `createIfAbsent`, `compareAndSwap` and `delete`, so the deployer having grown any
      other use for the store would fail rather than pass quietly.

- [x] 10.2 **The code's account of the preview boundary, corrected** (`gap-003`, AC-19). Defect
      lane, no spec delta: the spec was right and the code's description of it had drifted.
      `src/adapters/aws/session-policy.ts` and `src/adapters/aws/broker.ts` each gave, as the
      reason the design is safe, the `job_workflow_ref` trust condition and the trusted reusable
      workflow that `chg-001` withdrew — "a pull request cannot edit that workflow, so it cannot
      arrange to skip this", and "what makes the narrowing structural rather than a promise".
      Neither shipped, and AC-19's closing sentence says the reverse.
      Both headers now say what the narrowing is actually worth: a guardrail that makes every
      honest run incapable of reaching a sibling preview even where a bug would otherwise let it,
      and nothing at all against a run that declines to ask. Each points at the constitution clause
      that calls this a decision and states its cost, and `session-policy.ts` sends the reader to
      `roles.tf` for the floor the cloud does enforce, so AC-19 and AC-7 stay distinguishable.
      **Done.** Regression test in `tests/deploy-adapters.test.ts` cites `feat-002/AC-19` and
      `gap-003`; run red against the pre-fix source and green after, suite at 225.
      It asserts presence AND absence, following `roles.tf`'s boundary block (feat-001/AC-18):
      presence alone would pass over prose that says both things in different paragraphs, which is
      the state this test exists to end. It reads the source flattened, so reflowing a paragraph
      does not fail it for a reason nobody would believe.
      This is the third time this feature has shipped prose describing the withdrawn design — the
      other two were the role-assumption message and the deploy-role advice, both found only by
      reading a real failure in a live run. It is the first time a test holds it.

## Phase 11 — the budget measures skyhook's own work (authorized by `chg-005`)

From `gap-001`. `terraform init` — the repository's providers and modules arriving — is timed as
skyhook's share, against plan D7a and against the port's own contract. The criterion moves to name
both exclusions and the code moves to honour them. Do 11.2 first if doing them apart: it is the
assertion that would have caught this, and writing it against today's code makes it fail for the
right reason before anything is fixed.

- [x] 11.1 `src/core/ports.ts` and `src/adapters/terraform/environment.ts` — `DeployTiming` becomes
      three durations: `preparationMs` (skyhook's own work inside the deployer), `initMs`
      (`terraform init`), `applyMs` (`terraform apply`). `src/core/deploy.ts` subtracts
      `initMs + applyMs` rather than `applyMs` alone.
      **Name the middle field after the command, not after one of its two jobs.** That command
      fetches the repository's providers AND configures skyhook's backend, and nothing here
      separates them; a field called `fetchMs` would assert a boundary the measurement does not
      hold, which is precisely what `applyMs`'s old contract did and precisely what `gap-001` is.
      Say what it also contains on the field itself, where an implementer reads it, rather than
      only in the plan.
      Files: `src/core/ports.ts`, `src/adapters/terraform/environment.ts`, `src/core/deploy.ts`,
      `tests/fake-deployer.ts`, `tests/deploy.test.ts`.
      Keep the figure computed by **subtraction** from wall time (`deploy.ts:105` says why in a
      comment, and the corrected AC-14 now requires it): a step nobody remembered to instrument
      must land on skyhook's side rather than vanish. Adding up three measured pieces would be the
      obvious refactor here and is the wrong one.
      Every early return in `deploy()` carries a timing too, and each has to say which bucket its
      elapsed time belongs to — a failure during init is the repository's fetch, a failure in the
      hijack check is skyhook's. `NO_TIME` gains its third field with them.
      Not `[P]`: 11.2 asserts what this task changes.
      **Done.** The middle field is `initMs`, named after the command. `preparationMs` is now
      computed as *the whole pre-apply window minus `initMs`* rather than as its own stopwatch —
      the subtraction property held locally as well as at the use case, so an uninstrumented step
      added to the deployer later lands on skyhook's side instead of falling out of the figure.
      Every early return carries its own bucket. A **throw** charges to skyhook rather than to the
      repository, including one that lands mid-init: an unclassifiable second belongs on skyhook's
      side, because under-reporting is the unsafe direction for this budget.
      Files as listed, plus `tests/fake-deployer.ts`. The use-case test at `deploy.test.ts:380` now
      exercises an init too and still answers 340, so it proves the caller subtracts both fields.
- [x] 11.2 `tests/deploy-adapters.test.ts` — the timing assertion that has never existed. Drive the
      REAL `TerraformEnvironment` with an injected clock and a runner that advances it by a
      different, recognisable amount for each terraform command, then assert `init`'s time lands in
      `initMs`, `apply`'s in `applyMs`, and the hijack check, backend verification and workspace
      selection in `preparationMs`. Tests cite `feat-002/AC-14` and `gap-001`.
      This is the point of the phase. The existing AC-14 test (`tests/deploy.test.ts:380`) is
      handed its split by a `FakeDeployer` and asserts the use case subtracts correctly — the split
      is its input, so it cannot fail when the deployer computes the wrong one. Run 11.2 against
      the pre-11.1 code and watch it fail before fixing anything; a test written after the fix
      proves only that it agrees with itself.
      **Done, and run in that order.** Three tests cite `feat-002/AC-14` and `gap-001`, all three
      red against the pre-11.1 deployer and green after. A `ClockRunner` charges a distinct,
      recognisable number of milliseconds per terraform command, so a duration in the wrong bucket
      names the command that leaked rather than just failing an equality. The third asserts the
      subtraction property directly: an unmeasured step still arrives in `preparationMs`.
- [x] 11.3 Fold `chg-005` into `spec.md` — `AC-14` modified in place. Nothing is added or removed,
      so no id moves.
      **Done.** `spec.md` carries the reworded criterion verbatim from `delta.md`. The shared
      requirement in `product-global.md` named one exclusion where this criterion names two, which
      was raised as `od-3` rather than edited here — a cross-cutting input is never changed inside a
      feature change. **`od-3` was resolved the same day**: `product-global.md` now names both
      exclusions and draws the boundary at the same place, so the two texts agree and neither is
      the narrower one any more. Amending it restaged both features' pre-build checks, which were
      re-run and both pass.

- [x] 11.4 **The surface outside this repository says it too.** Raised as an observation by the
      second code-vs-spec audit (`converge.md` run 2) and deliberately not routed as a gap: the
      figure `action.yml` reports was already correct and no criterion states what its description
      must say. Corrected anyway, on the owner's call, because of its shape — `skyhook-seconds` was
      described as excluding "your `terraform apply`" alone, which is a text enumerating less than
      the implementation does, on the one surface where being wrong misleads somebody who cannot
      read this repository to find out. That is `gap-001` in miniature.
      Held by a test (`tests/deploy-command.test.ts`, citing `feat-002/AC-14`), run red against the
      old description and green against the new one. Prose, not care, is what has failed here four
      times: the role-assumption message, the deploy-role advice, and the two file headers
      `gap-003` found — every one caught by reading a live failure rather than by review.
      Also in this pass: `skyhookFailed()` in `src/adapters/terraform/environment.ts` no longer
      defaults its timing to zero. Task 11.1 gave every failure path an explicit bucket, which left
      the default unreachable; removing it means a path added later cannot report that it spent no
      time, which is the direction AC-14 names as the unsafe one.
      **These landed after run 2 of the audit**, so the drift record does not cover them. Nothing
      here changes behavior — a description, a dead default, and a test — but the ledger's baseline
      is older than the code by exactly this task, and the next audit will say so.

## Phase 8 — the settings file survives an install (authorized by `chg-002`)

Found while building 6.3. `.skyhook/config.yml` is restored by `init`, and `init`'s own closing
message tells the operator to hand-edit it — so a re-run reverts `storage.account` and the whole
`deploy` block, and the next deploy says the installation does not deploy. **Do this before 7.1**:
the live run is exactly where someone re-runs `init` to pick up a fix and then loses an hour to a
message that names the wrong cause.

- [x] 8.1 `src/core/install.ts` — a desired file says whether it is **seeded** or **restored**.
      Seeded means written when absent and left alone when present; restored is today's behavior and
      stays the default, so every file but one is unaffected. `planInstall()` gains a `kept` change
      kind for a seeded file that is already there, because "unchanged" would be a lie — skyhook did
      not check the content and must not imply it did.
      Files: `src/core/install.ts`, `tests/install.test.ts`.
      Keep `planInstall()` pure and keep the decision in the desired-file list rather than in
      `applyInstall()`: the reason the dry run and the apply cannot disagree is that one function
      decides both.
      `changed()` must treat `kept` as **not** an edit. It currently filters on
      `kind !== 'unchanged'`, so a kept settings file would otherwise be listed as something `init`
      changed — the exact opposite of what 8.3 promises, and the report is the only place an
      operator learns which rule applied to which file.
- [x] 8.2 `src/cli/init.ts` — mark `CONFIG_PATH` seeded; every other entry in `desiredFiles()` stays
      restored. `configDocument()` gains commented, labelled slots for `storage.account` and the
      `deploy` block, each naming where its value comes from — the bootstrap's `account_id` output,
      and the operator's own repository layout. The document must still **parse** with the slots
      commented out, so a freshly seeded installation runs `bootstrap` and `destruct` exactly as it
      does today; assert that by feeding the generated document to `parseConfig()` rather than by
      reading it. Tests cite `feat-002/AC-21`.
      Files: `src/cli/init.ts`, `tests/install.test.ts`.
- [x] 8.3 `src/cli/init.ts` — the report and the closing message tell the truth about the new rule.
      A seeded file that was left alone is reported as left alone, not silently omitted: an operator
      who expects `init` to fix their settings needs to learn here that it will not. Step 2 of the
      closing message stops reading as an instruction skyhook will later undo, and the message names
      the remedy for a settings file that is broken rather than merely incomplete — delete it and
      install again. Tests cite `feat-002/AC-20`.
      Files: `src/cli/init.ts`, `tests/cli.test.ts`.
      The regression test asserts **both halves in one run**: a hand-edited settings file survives
      while a hand-edited file skyhook owns is restored. Asserting only the first would pass just as
      well if `init` had stopped writing anything at all, which is the more likely way to break this.
      Two existing assertions move, and neither is a behavior change. The re-run no-op test
      (`tests/install.test.ts:104`) asserts `changes.every(c => c.kind === 'unchanged')`; it becomes
      "no change is `created` or `restored`", so it keeps asserting the thing it exists to assert —
      a re-run writes nothing — rather than the encoding of the report. Its *already up to date*
      assertion on the next line then holds on its own, given 8.1's `changed()` fix.
- [x] 8.4 Re-check `../deadweight`. Its settings file is hand-edited right now and a re-run of `init`
      would revert it, which is the failure this phase removes. Run `init` there afterwards and
      confirm the account and the `deploy` block are still what 6.3 wrote, by `parseConfig()` rather
      than by eye. This is the one place the change is proved against a real installation rather
      than a temp tree, and 7.1 depends on it.
      Files: `../deadweight/.skyhook/config.yml` (expected: unchanged).
- [x] 8.5 Fold `chg-002` into `spec.md` — the seeded-settings behavior paragraph, its scenario, and
      `AC-20`/`AC-21` at the next free ids. `AC-8` is retired by `chg-001` and is not reused.

## Phase 9 — the narrowing says what it permits (authorized by `chg-003`)

No source changes. The session policy already permits exactly what the corrected criterion describes
and has since the first live deploy; what is being fixed is the criterion, and the citation gap that
let it drift unnoticed.

- [x] 9.1 `tests/deploy-adapters.test.ts` — cite `feat-002/AC-19` on the tests that assert what
      skyhook **asks for**, keeping `feat-002/AC-7` on those that assert what the **cloud refuses**.
      `chg-001` split those two criteria apart deliberately and the tests never followed, which is
      why `AC-19` was the only criterion in this feature with nothing holding it.
      The resource-list assertion is the load-bearing one: it names the exact set the narrowing
      permits, so the next addition to that set fails here rather than in a live run. Assert the
      exception explicitly rather than leaving it implied by a deep-equal — a reader of the test
      should be able to see that the hole exists and that it is exactly one object.
- [x] 9.2 `tests/deploy-adapters.test.ts` — correct the comment opening the `AC-7` narrowing test.
      It still says the credentials are refused every environment *"including other pull requests'"*,
      which is the guarantee `chg-001` withdrew and the constitution now records as a deliberate
      non-guarantee. The assertions below it are right; only the comment is stale.
- [x] 9.3 Fold `chg-003` into `spec.md` — `AC-19` modified in place. Nothing is added or removed, so
      no id moves.
