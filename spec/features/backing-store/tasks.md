# Tasks — backing-store (feat-001)

Glyphs: `[ ]` not started · `[~]` in progress · `[x]` done · `[-]` n/a · `[H]` human-gated.
`[P]` marks a task that may run concurrently with its siblings in the same phase.

Tests come before the implementation they cover.

## Phase 0 — toolchain

- [x] 0.1 `package.json` (type: module, no runtime deps), `tsconfig.json` with
      `erasableSyntaxOnly: true` and `noEmit`, and scripts: `check` (`tsc --noEmit`) and
      `test` (`node --test "tests/**/*.test.ts"`).
      Files: `package.json`, `tsconfig.json`, `.gitignore`. `typescript` and `@types/node` are
      dev-only; there are no runtime dependencies.
- [x] 0.2 Confirm the toolchain end to end: one trivial passing test under `tests/`, and
      `tsc --noEmit` clean. Nothing else starts until both commands work.
      Files: `tests/toolchain.test.ts`. Both commands verified green on Node v26.5.0 — `.ts` runs
      under `node --test` with no build step, as D1 assumed.

## Phase 1 — core contracts

- [x] 1.1 `src/core/types.ts` — `EnvironmentRecord` (repository, identity, state, deployed commit,
      timestamps), `EnvironmentState` = `active | released`, `SkyhookConfig`.
      Files: `src/core/types.ts`. **The record carries no `protected` field** — an earlier draft of
      this task listed one, which contradicts the spec and plan D2a: protection lives at its own key
      precisely so a bucket policy can refuse the write. Corrected here; task 3.3 already assumed it.
- [x] 1.2 `src/core/store.ts` — the `Store` interface: `createIfAbsent`, `read`, `compareAndSwap`,
      `list`, `delete`. Nothing AWS-specific may appear in this file or anything it imports.
      Files: `src/core/store.ts`. Outcomes are returned as typed values, never thrown, so a lost
      race is a value the caller must handle. Every operation can also report `container-missing`,
      which is what lets `ensureRegistry()` (5.3) tell "no registry yet" from "no bucket at all"
      without a sixth method and without creating anything.

## Phase 2 — independent pieces (all `[P]`, each depends only on Phase 1)

- [x] 2.1 `[P]` `tests/fake-store.ts` — in-memory `Store` implementing real conditional-write
      semantics: `createIfAbsent` fails when the key exists, `compareAndSwap` fails on a stale
      version token. This double is what every core test depends on, so its semantics must be
      strict rather than convenient.
      Files: `tests/fake-store.ts`, `tests/fake-store.test.ts`. The double's own semantics are
      tested, not assumed. A `beforeCommit` hook lets a test hold two writes open simultaneously,
      so the concurrency tests prove atomicity rather than relying on the event loop serializing
      them by accident.
- [x] 2.2 `[P]` `src/core/config.ts` — config schema, defaults (environment cap 5, enabled), and
      the `ConfigSource` interface. Tests: defaults applied, cap disable honored.
      Files: `src/core/config.ts`, `src/core/yaml.ts`, `tests/config.test.ts`. An unrecognized
      setting is refused rather than ignored — silently defaulting a misspelled cap is precisely
      the failure that looks like success until the bill arrives. The hand-rolled YAML subset
      parser is recorded as debt in `spec/backlog.md` (row 1).
- [x] 2.3 `[P]` `stateKeyFor()` + `registryKeyFor()` in `src/core/registry.ts` — key derivation
      only. Tests cite `feat-001/AC-7` and `feat-001/AC-12`.
      Files: `src/core/registry.ts`, `tests/registry-keys.test.ts`. Also `protectionKeyFor()`,
      needed by 3.3. Components are validated and invalid input throws: the pull-request role's
      permissions are expressed as a key prefix, so an identity able to escape its prefix would
      walk straight through that boundary.
- [x] 2.4 `[P]` `terraform/bootstrap/` — OIDC provider, the roles skyhook assumes split by trust
      policy per the constitution, and the storage bucket with encryption, versioning, and a public
      access block. Provider versions pinned. Not applied by any task here.
      *(Rescoped by `changes/chg-001`.)* The pull-request role's policy confines writes to the
      **ephemeral namespace** — `registry/<repo>/pr-*.json` and the matching state prefix — and
      denies every write under the `protected/` prefix. *(Amended by `chg-010`, landed with
      feat-003's task 5.2: reads of the repository's own ephemeral marks are now granted — the
      constitution's third named exception.)* That policy, not the TypeScript, is what
      satisfies `feat-001/AC-17` and `feat-001/AC-15`. It deliberately does **not** separate one pull
      request from another; that limit is stated in the Terraform's own comments and outputs (2.6).
      `feat-001/AC-14` is now satisfied by `identityFor()` alone (2.5, done).
      Files: `terraform/bootstrap/{versions,variables,oidc,storage,roles,outputs}.tf`. Verified with
      `terraform validate` (clean) and `terraform fmt`; asserted by `tests/bootstrap-terraform.test.ts`,
      which reads the source as data and applies nothing. Both roles pin their OIDC subject with
      `StringEquals` — a `StringLike` subject would accept a pull request's subject too and make the
      split decorative, so the test asserts no wildcard subject exists. Both roles also carry an
      explicit deny outside their namespace, because the constitution asks for explicit deny rather
      than merely an absent allow. The bucket additionally refuses plaintext transport and has ACLs
      off, so every grant in the installation is an IAM policy and there is one place to read.
      *Local Terraform is 1.9.8, below the file's own `>= 1.10.0` floor, so validation ran with the
      floor temporarily relaxed and the floor was then restored.* The floor is deliberate: the
      bootstrap declares no backend and would run on older Terraform, but managed environments'
      state needs `use_lockfile` (1.10+), and failing an operator at install time beats failing
      after an environment exists that cannot lock.
- [x] 2.5 `[P]` `identityFor(trigger)` in `src/core/identity.ts` — derive the environment identity
      from the trigger for a pull-request run; reject a supplied identity outright. Tests cite
      `feat-001/AC-14`.
      Files: `src/core/identity.ts`, `tests/identity.test.ts`. A supplied identity is refused even
      when it matches the derived one, so no string comparison sits on the security path.
      Note this is skyhook behaving correctly when untampered — the enforcement is 2.4's policy.
      *(`changes/chg-001`: this is now the whole of `feat-001/AC-14`. The credential half moved to
      the narrower `feat-001/AC-17`.)*

- [x] 2.6 `[P]` The pull-request-to-pull-request limit is stated in `terraform/bootstrap/` itself: a
      comment block beside the pull-request role's policy, and a Terraform output naming it, so an
      operator reading or applying the bootstrap meets the limit. Test cites `feat-001/AC-18`. Added
      by `changes/chg-001` — a gap nobody is told about is a gap nobody closes. *(The init-output
      half of this moved to 4.5: it needs the init command, which is phase 4, so it could not be a
      `[P]` phase-2 task.)*
      Files: `terraform/bootstrap/roles.tf` (the `KNOWN LIMIT` block beside the policy it describes,
      for whoever reads the source) and `terraform/bootstrap/outputs.tf` (an output `terraform apply`
      prints, for whoever only runs it). Both state the limit, its cause, and what would close it.

## Phase 3 — registry logic

- [x] 3.1 Tests for claim and release against the fake store, citing `feat-001/AC-5`,
      `feat-001/AC-6` and `feat-001/AC-16`: concurrent claims of one identity (exactly one wins,
      loser is a distinct typed result, not an exception), stale-write refusal, same identity across
      two repositories, and a claim against an existing record in each state refused with
      distinguishable results.
      Files: `tests/registry.test.ts`. Written and observed failing before 3.2 existed. The
      concurrency tests hold both claims open inside the store before either commits, so they
      exercise real contention rather than two sequential calls that happen to be awaited together.
- [x] 3.2 `registry.claim()` / `release()` / `list()` / `countActive()` in `src/core/registry.ts`
      to satisfy 3.1. Claim is create-if-absent with no state machine on top (plan D2b);
      `countActive()` plus the configured cap satisfies `feat-001/AC-10`.
      Files: `src/core/registry.ts`. Also `read()`, `update()` (the compare-and-swap seam AC-6 is
      verified through) and `remove()` (teardown — the deletion that frees a name, AC-16). A record
      that cannot be parsed fails the whole listing rather than being skipped: undercounting would
      over-provision against the cap, and that failure looks exactly like success until the bill
      arrives. Stored records carry a `schemaVersion`, which costs nothing now and keeps the spec's
      "one-way door" ajar.
- [x] 3.3 `isProtected()` / `setProtected()` in `src/core/registry.ts` — protection stored at its
      own key, never as a field on the environment record. Tests cite `feat-001/AC-15`: protection
      reads from the separate key, and a record carrying a stray `protected` field is ignored rather
      than honored.
      Files: `src/core/registry.ts`, `tests/registry.test.ts`. The stray-field case holds by
      construction — deserialization reads only the fields the record is defined to have — and is
      tested by writing a record with a `protected: true` field and asserting it has no effect.
      `remove()` deletes the marker with the record, so no marker outlives its environment.
      **Defect fixed (analyze.md SEC-2, no spec delta — the spec was already right):** `remove()`
      deleted the protection marker before the record. A teardown halting between the two left a
      record with no protection, which the sweep would then be free to destroy — the constitution
      forbids that outright. Now the record goes first, so the residue of a halted teardown is an
      orphan marker, which the spec already calls garbage to be collected. Regression test cites
      `feat-001/AC-15`.

## Phase 4 — installation

- [x] 4.1 Tests for the install plan citing `feat-001/AC-2`, `feat-001/AC-13`, `feat-001/AC-11`:
      re-run leaves managed files byte-identical; a deleted or hand-edited managed file is restored
      and reported; no produced file contains credential-shaped content.
      Files: `tests/install.test.ts`. The config test round-trips through the real parser rather
      than a regex, so a config init writes but skyhook cannot read would fail here rather than at
      run time. The credential scan is a heuristic and the plan says so — it catches the accident
      it aims at, not a determined leak.
- [x] 4.2 `src/core/install.ts` — desired file set, diff, and idempotent apply, to satisfy 4.1.
      Files: `src/core/install.ts`. The diff is pure — `planInstall()` takes a read function — so
      the decision logic is testable without a filesystem and the same diff drives a dry run and an
      apply. A changed file is reported as `restored` rather than `created`, so an operator can see
      that something had drifted rather than merely been absent.
- [x] 4.3 `src/cli/init.ts` — the `init` command writing `.skyhook/` (config, the calling workflow)
      and the bootstrap Terraform, without applying anything. Satisfies `feat-001/AC-1`.
      Files: `src/cli/init.ts`. Writes only under `.skyhook/`. The workflow is deliberately left at
      `.skyhook/workflow.yml` for the operator to copy into `.github/workflows/` rather than written
      there directly: skyhook restores every file it manages to its desired content, and silently
      reverting someone's CI configuration is not a surprise worth causing. The bootstrap is copied
      from skyhook's own `terraform/bootstrap/`, so there is one copy of that Terraform, not two.
- [x] 4.4 Test asserting the bootstrap Terraform declares encryption and a public access block,
      citing `feat-001/AC-8`. Reads `terraform/bootstrap/` as data; applies nothing.
      *(`changes/chg-001`:)* the same test file also asserts `feat-001/AC-17` — the pull-request
      role's policy resources stay inside the ephemeral namespace and name neither a long-running
      environment nor another repository. *(`chg-010` superseded the protected-prefix half of that
      assertion: the test now checks the write deny spares exactly `GetObject` and that the read
      grant stays confined to the repository's own ephemeral marks.)*
      Files: `tests/bootstrap-terraform.test.ts`. Also asserts `feat-001/AC-11` against the Terraform
      (no access key resource, no credential-shaped literal) and the no-wildcard-subject property the
      whole trust split rests on.
- [x] 4.5 The init command's output states the pull-request-to-pull-request limit in plain words.
      Test cites `feat-001/AC-18`. Depends on 4.3, so it is not `[P]` — split out of 2.6.
      Files: `src/cli/init.ts` (the closing `KNOWN LIMIT` block in its output), `tests/install.test.ts`.

- [x] 4.6 `src/cli/main.ts` + `bin/skyhook.ts` — the `skyhook init` command, so `feat-001/AC-1`'s
      "**running** init" and the spec's "run one command" story are satisfiable by a maintainer
      rather than only by a test. Settles the entry-point question for `init` alone (plan D1a);
      the deploy action's surface stays open.
      Files: `src/cli/main.ts`, `bin/skyhook.ts`, `tests/cli.test.ts`, `package.json` (`bin`).
      `runCli()` returns an exit code instead of calling `process.exit`, so it is tested as a plain
      function rather than by spawning processes; `bin/skyhook.ts` holds no logic. A malformed
      `--repository` is refused by the command with a message about the flag, rather than surfacing
      later as a key-derivation error about a storage key the operator has never seen. An
      unrecognized flag is an error, not something ignored. Real exit codes verified: 0 for help
      and success, 2 for a bare invocation, an unknown command, or a missing option.
      **This task exists because installing skyhook into a real directory was impossible without
      writing a script** — the gap was invisible while only tests called `init()`.

## Phase 5 — adapters

- [x] 5.1 `src/adapters/aws/s3-store.ts` — `Store` over S3 conditional writes: `createIfAbsent`
      via `If-None-Match: *`, `compareAndSwap` via `If-Match: <etag>`.
      Files: `src/adapters/aws/s3-store.ts`, `src/adapters/aws/sigv4.ts`, `tests/adapters.test.ts`.
      No AWS SDK, per D1's no-runtime-dependencies choice, so request signing is written by hand —
      recorded as debt in `spec/backlog.md` (row 3). It fails closed: a signing bug yields a
      rejected request, never a wider grant. Both 409 and 412 count as a lost conditional write
      (S3 returns 409 when two conditional writes collide). Listing follows continuation tokens,
      because a silently truncated page would undercount active environments and let the cap be
      exceeded. **409 is retried, not read as a lost claim** — 412 says the key is occupied, but
      409 `ConditionalRequestConflict` says S3 declined to adjudicate a simultaneous write and
      establishes nothing; reading it as "already held" would refuse a claim for a free name
      exactly when the system is busiest. Exhausted retries report `contended` (unknown, try
      again), never `already-exists`. **The tests here assert the requests sent, not S3's response to them** — a fake that
      agreed with our own assumptions would prove only that we are consistent with ourselves. The
      real proof is 6.2.
- [x] 5.2 `src/adapters/github/config-source.ts` — `ConfigSource` reading `.skyhook/config.yml`
      through the contents API pinned to the default branch. Test cites `feat-001/AC-9` and asserts
      the request targets the default branch, never the pull request's head.
      Files: `src/adapters/github/config-source.ts`, `tests/adapters.test.ts`. The default branch is
      asked of GitHub rather than taken as a parameter: if it were an input, a pull-request run's
      workflow — which the pull request author controls — could name its own branch and be believed.
- [x] 5.3 `ensureRegistry()` in `src/core/install.ts` — initialize an empty registry when the bucket
      exists but holds none; stop and name the bucket when the bucket itself is absent, creating
      nothing (plan D3: the bootstrap Terraform owns the bucket). Test cites `feat-001/AC-4` against
      the fake store, covering both arms. Relies on create-if-absent for the first-run race rather
      than a lock.
      Files: `src/core/install.ts`, `tests/install.test.ts`. The two-runs-at-once case is tested with
      both calls held open before either commits, and resolves exactly like two claims.

## Phase 6 — verification against reality

- [x] 6.1 Confirm the S3 backend's native lockfile (`use_lockfile`) against current Terraform docs
      and wire it into the bootstrap. This is the plan's one untested external assumption.
      **Confirmed 2026-08-14** against the current HashiCorp docs: `use_lockfile` arrived in
      Terraform 1.10, DynamoDB-based locking is deprecated and slated for removal, and the lockfile
      needs `s3:GetObject`/`PutObject`/`DeleteObject` on `<state key>.tflock`. Both roles' existing
      `state/<repo>/…` grants already cover that path, so wiring it in meant making the coverage
      deliberate — a comment at each grant and a test asserting no lock table is declared — rather
      than adding a permission. Noted in D4: Terraform's lockfile is itself built on S3 conditional
      writes, the same primitive D2 bets on. Corroboration, not proof; 6.2 still stands.
- [x] 6.2 **The must-prove.** Run the claim primitive against a real S3 bucket under genuine
      concurrency and confirm `If-None-Match` and `If-Match` behave as D2 assumes. Needs a real AWS
      account, so it cannot be done unattended. If this fails, D2 collapses and the S3-only
      decision does not survive — raise it rather than working around it.
      **PASSED 2026-08-14.** 75 rounds / 950 concurrent claims against a real bucket, at 5-way and
      20-way concurrency, driving the production `S3Store` and `Registry`. Exactly one winner every
      round; never none, never two, no lost update. Harness:
      `tests/manual/verify-conditional-writes.ts`. Full observation in `hs-1` in `feature.md`,
      including that no 409 was ever seen, so the retry path stays unexercised against real S3.
- [x] 6.3 Apply the bootstrap Terraform to a real account, then apply it again and confirm no
      changes. Satisfies `feat-001/AC-3`, which is marked `(manual)` because it cannot be machine
      verified. Record the observation.
      **Done 2026-08-14** against account 123456789012. Second apply: "No changes." Live checks
      confirmed encryption, the public access block, and both roles — see `hs-2` in `feature.md`.
      Applied with `create_oidc_provider=false`, the flag added when the account turned out to
      already hold a GitHub OIDC provider owned by another project.

## Phase 7 — remediation from the first drift audit

Opened by `converge.md` run 1. Everything here is repair of what the audit found, not new scope.

- [x] 7.1 **Defect, no spec delta** (`gap-001`): the provider-agnostic core named the IaC tool.
      `stateKeyFor()` returned a key ending in `terraform.tfstate` from inside `src/core/`, which
      the constitution's provider-agnostic-core non-negotiable and plan D6 both forbid. Core now
      exposes `stateDirFor()` and stops at the directory; `src/adapters/terraform/state-key.ts`
      appends the filename. Files: `src/core/registry.ts`, `src/adapters/terraform/state-key.ts`,
      `tests/registry-keys.test.ts`. Regression test cites `feat-001/AC-7` and `gap-001`, and
      asserts core's half never matches /terraform|tfstate/.
      The spec was already right, so this took the defect lane and produced no delta.

- [x] 7.2 **Spec change** (`changes/chg-003`, closing `gap-002`, `gap-003`, `gap-004`, `gap-005`):
      four gaps where the build was correct and the spec was not. AC-5 narrowed from "exactly one
      success" to "never two, and an unresolved attempt says so" — the honest statement since the
      409 fix. AC-8 absorbed the transport and access-control hardening the bucket already had.
      AC-17 absorbed the privileged role's own confinement. New AC-20 states the 63-character
      identity bound, and the constant now explains itself (it is the DNS label limit).
      Files: `spec.md`, `src/core/identity.ts`, `tests/identity.test.ts`,
      `tests/bootstrap-terraform.test.ts`. No production behaviour changed — this authorizes what
      was already built and tested.

## Phase 8 — one command to apply the bootstrap

Added by `changes/chg-004`, after applying the definition by hand exposed how much an operator has
to know that skyhook already knows.

- [x] 8.1 `src/cli/process.ts` — the seam between skyhook and the programs it drives. Shelling out
      to `terraform` is the only honest way to run a binary the operator installed, but a
      shell-out that cannot be substituted makes everything above it untestable, so the runner is
      injected and the confirmation prompt with it.
- [x] 8.2 `src/adapters/aws/oidc-provider.ts` — `hasGitHubOidcProvider()`. Answers the one question
      Terraform cannot answer about itself. Reads only. Test cites `feat-001/AC-22`.
- [x] 8.3 `src/adapters/terraform/runner.ts` — `init` / `plan` / `apply`, so nothing above assembles
      a `-var` flag by hand. `-auto-approve` appears only in `apply`, and only because the caller
      has already shown the plan and taken a yes; Terraform's own prompt would re-ask about a plan
      it recomputes, which is a different plan from the one the operator agreed to.
- [x] 8.4 `src/cli/bootstrap.ts` + the `bootstrap` command in `src/cli/main.ts`. Reads the storage
      settings from `.skyhook/config.yml`, derives the repository from the git remote, detects the
      trust-anchor case, plans, and applies only on a yes. Satisfies `feat-001/AC-21` and
      `feat-001/AC-22`.
      Files: `src/cli/bootstrap.ts`, `src/cli/main.ts`, `bin/skyhook.ts`, `tests/cli.test.ts`
      (moved to async), `tests/bootstrap-command.test.ts`. **Verified against the real account**
      as well as by test: a first run applied, and a second detected the existing trust anchor,
      reported no changes, and left it untouched.
      A bad AWS credential read stops the run before terraform is invoked at all, and says to try
      `AWS_PROFILE` — the failure that cost two attempts by hand.

## Phase 9 — the bootstrap's state gets a home

Added by `changes/chg-005`, after wiping a test repository's working tree stranded live resources.

- [x] 9.1 `terraform/bootstrap/versions.tf` declares an empty `backend "s3" {}`; bucket, key and
      region arrive as `-backend-config` at init time, from the same config everything else reads.
- [x] 9.2 `src/adapters/aws/bucket.ts` — `bucketExists()`. Tells a first run from a later one by
      asking the account rather than remembering. 403 counts as "exists": it is someone else's
      bucket, and the apply will say so better than this could.
- [x] 9.3 `src/adapters/terraform/runner.ts` — `initLocal()` and `initBackend({migrate})`.
- [x] 9.4 `src/cli/bootstrap.ts` — two passes on a first run, one afterwards, and a stranded local
      state migrated whenever one is found beside an existing bucket. A migration that fails after
      a successful apply reports neither success nor plain failure: it says the resources exist,
      the state is still local, not to delete it, and to re-run. Satisfies `feat-001/AC-23` and
      `feat-001/AC-24`.
- [x] 9.5 `src/cli/init.ts` writes `.skyhook/.gitignore` — `.terraform/` and `*.tfstate*` ignored,
      `.terraform.lock.hcl` explicitly kept. Part of this change rather than an earlier one:
      ignoring the state before it had a home would have made losing it silent by design.
      **Verified against the real account**: the `deadweight` installation's stranded local state
      migrated into `s3://…/bootstrap/terraform.tfstate` (42 KB, AES256), the local copy emptied,
      and `git add -n` shows the lock file tracked and no state file at all.

## Phase 10 — removing what skyhook created

Added by `changes/chg-006`.

- [x] 10.1 `src/adapters/aws/bucket.ts` — `listKeys()` and `emptyBucket()`. Emptying handles object
      versions *and* delete markers: the bucket is versioned, so deleting current versions leaves
      markers behind and the bucket is still not empty. Doing this in skyhook rather than setting
      `force_destroy` on the bucket keeps every ordinary apply from being able to wipe the registry.
- [x] 10.2 `src/adapters/terraform/runner.ts` — `statePull()`, `stateList()`, `stateRm()`,
      `destroy()`.
- [x] 10.3 `src/cli/destruct.ts` + the `destruct` command. Refuses while the registry records any
      environment (`feat-001/AC-25`), destroys only what skyhook manages (`feat-001/AC-26`), and
      brings the state out of the bucket before emptying it (`feat-001/AC-27`). Confirmation is by
      typing the bucket name rather than pressing a key — a y/N prompt is answered by reflex.
      Files: `src/cli/destruct.ts`, `src/cli/main.ts`, `src/cli/process.ts`, `tests/destruct.test.ts`.
      **Refusal verified against the real account**: an environment record planted in the registry
      produced the refusal by name, and left the bucket and both roles intact.
      The full destroy path is covered by tests but has not been run end to end against a live
      account — doing so would have removed the `deadweight` installation, which was not asked for.

- [x] 10.4 **Defect, no spec delta** (the spec was already right; the mechanism was not): both
      `bootstrap`'s first-run pass and `destruct` used `terraform init -backend=false` to work
      against local state. That flag skips backend *initialization*, so the next command refuses
      with "Backend initialization required" — it does not make the state local. Both now write a
      `*_override.tf` declaring `backend "local" {}`, which is what actually moves the state, and
      clear it once the state should no longer be local.
      Found part-way through the first real removal, and it turned out to be **two** defects: the
      same flaw had been in `bootstrap`'s first-run path since the backend block was declared in
      `chg-005`, undetected because every real run after that took the other branch. Neither was
      caught by tests, and could not have been: the injected runner proves what skyhook *asks*
      Terraform to do, never whether Terraform accepts it.
      Files: `src/adapters/terraform/runner.ts` (the override now lives with the tool that reads
      it), `src/cli/destruct.ts`, `tests/destruct.test.ts`, `tests/bootstrap-command.test.ts`.
      Regression tests assert the override is present while the state must be local, absent
      afterwards including on failure, and that `-backend=false` is not used anywhere.
      **Verified end to end against the real account**: a clean first-run bootstrap created ten
      resources and migrated its state into the bucket, then destruct removed all ten. The
      `fieldrep` trust anchor survived with its tags, and no override was left in the working tree.

## Phase 11 — the deploy contract

Added by `changes/chg-007`, when feat-002 turned out to need eight things from this feature.

These are this feature's files, so they are recorded here — but they are **built inside feat-002's
run**, where the code that consumes them is written and tested. Each line names the feat-002 task
that carries it out, rather than restating it, so there is one description and not two that can
drift.

- [x] 11.1 `src/core/types.ts`, `src/core/registry.ts` — `EnvironmentRecord` gains
      `url: string | null`; `Registry` gains `countEnvironments()` beside `countActive()`, counting
      keys from the listing and reading no object. Carried out by feat-002 task 1.1.
      Satisfies `feat-001/AC-28` and the modified `feat-001/AC-10`.
- [x] 11.2 `src/core/config.ts` — `storage.account` and an optional `deploy` block
      (`directory`, `role_prefix`). Both optional at the top level, so `bootstrap` and `destruct`
      keep working against an installation written before this change. Carried out by feat-002
      task 1.2. Satisfies `feat-001/AC-31`.
- [x] 11.3 `src/cli/init.ts`, `src/cli/main.ts` — `init` writes the workflow file and the
      deploy-role starting point, states the order in which they must reach the default branch, and
      drops the "not built yet" note. Carried out by feat-002 tasks 5.1 and 5.2. Satisfies the
      revised `feat-001/AC-30` and the modified `feat-001/AC-1`.
      *Revised by feat-002's `chg-001`:* one workflow file rather than two.
      *Corrected here, 2026-08-15, against what shipped:* this line asked for an optional
      `--account` flag on `init` and **no such flag exists**, deliberately. `chg-002`'s seeded
      settings replaced it: `init` runs before the bootstrap applies, so the account is not yet
      knowable at that point, and the config document carries a commented `storage.account` slot
      the operator fills in afterwards — step 2 of the closing message, which now also promises the
      file will not be overwritten. A flag would have collected an answer nobody has yet. The rest
      of the line shipped as written: four ordered steps, `.github/workflows/skyhook.yml`,
      `.skyhook/deploy-role.example.tf`, and the boundary stated where an operator reads it.
- [x] 11.4 `terraform/bootstrap/roles.tf`, `terraform/bootstrap/outputs.tf` — **no trust-policy
      change.** The pull-request role's `ListBucket` prefix condition gains `state/<repo>/` and
      `registry/<repo>/` with every object grant untouched; the KNOWN LIMIT block and its matching
      output are rewritten to say that the preview-to-preview boundary is open by decision and what
      that costs an operator; `outputs.tf` gains `account_id`. Carried out by feat-002 task 5.3.
      Satisfies the modified `feat-001/AC-17` and `AC-18`.
      *Revised by feat-002's `chg-001`:* the `job_workflow_ref` trust condition is withdrawn, and
      with it `AC-29`, which is never added. `AC-14` needs no modification — it already described
      the system correctly.
      *Verified against what shipped, 2026-08-15:* both listing conditions carry the widened
      prefixes, every object grant is untouched, the KNOWN LIMIT block states the preview-to-preview
      boundary as a decision and what it costs, and `outputs.tf` exports `account_id`. `chg-008`
      later added one more value to the same listing condition — the bare `terraform.tfstate` key —
      which is that change's, not this one's.
- [-] 11.5 The trust condition is proved against a live account before it is relied on.
      **Retired by feat-002's `chg-001`, not run**, along with the trust condition it was to prove.
      Recorded against `hs-3` below rather than deleted. Nothing this feature ships depends on how
      AWS treats the claim.

## Phase 12 — the subject a run presents (authorized by `chg-009`)

The code in this phase is **already built and proven live** — it is what made the first environment
possible on 2026-08-15. What was missing is the record and the tests, which is why the phase exists
rather than being folded silently.

- [x] 12.1 `terraform/bootstrap/variables.tf`, `terraform/bootstrap/oidc.tf` — `subject_prefix` is a
      required variable, validated to start with `repo:`, and both subjects are built from it rather
      than from `var.repository`. The note in `oidc.tf` records why the subject must be matched at
      all: AWS rejects a trust policy for this provider that conditions on neither `sub` nor
      `job_workflow_ref`, so the immutable ids that would otherwise be the better key are not
      available. Satisfies `feat-001/AC-32`.
- [x] 12.2 `src/adapters/github/repository-ids.ts` — `subjectPrefix()` reads
      `/repos/{owner}/{repo}/actions/oidc/customization/sub` and reports whether GitHub stated a
      prefix or skyhook fell back to the conventional form. A 403 or 404 is a fallback, not a
      failure: the endpoint needs repository admin. Anything else is a failure that names itself.
- [x] 12.3 `src/cli/bootstrap.ts` — the lookup runs before anything is planned, prints
      `Subject: <prefix> (as GitHub reports it)` or `(the conventional form; GitHub did not state
      one)`, and passes the answer to Terraform. A failure to read stops the run and points at the
      note in `oidc.tf` rather than applying a policy that would refuse every assumption.
      Satisfies `feat-001/AC-33`.
- [x] 12.4 **Defect, found by the pre-build check on `chg-009`; no spec delta.** `init`'s closing
      message printed a copyable `terraform apply` naming three variables, and `chg-009` made
      `subject_prefix` a fourth with no default. Following skyhook's own instructions stopped on a
      prompt for a string the operator has no way to know — the exact failure `chg-009` exists to
      prevent, one layer up. Step 1 now reads the roles and then runs `skyhook bootstrap`, which
      performs the lookup and still shows the plan and waits, so the maintainer's chance to read the
      policies before they exist is unchanged.
      Files: `src/cli/init.ts`, `tests/cli.test.ts`, `tests/install.test.ts`.
      The regression test cites `feat-001/AC-1` and asserts the general rule rather than the
      instance: anything skyhook tells an operator to run must supply every bootstrap variable that
      has no default, read from `variables.tf` at test time. A fifth required variable fails here
      rather than in someone's terminal.
      Two existing tests asserted on `terraform apply` as a proxy — one for "the default branch
      reaches the trust policy", one for "init applies nothing". Both now assert the same properties
      against the command that actually carries them; neither property changed.
- [x] 12.5 `tests/` — unit-test `subjectPrefix()`, which currently has none. Cite
      `feat-001/AC-32` and `feat-001/AC-33`. Five outcomes, and the fallback is the one that
      matters most and is exercised least: GitHub states a prefix; GitHub answers with no
      `sub_claim_prefix`; the endpoint answers 403 or 404 (fall back, `stated: false`); the endpoint
      fails some other way (report the status); the host is unreachable (report the cause). Inject
      `fetch` — the adapter already takes it — so no test touches the network.
      Assert on the **`stated` flag** as well as the prefix. A test that only checked the returned
      string would pass identically if the fallback stopped announcing itself, and announcing it is
      the whole reason the fallback is acceptable.
- [x] 12.6 `tests/bootstrap-command.test.ts` — cover the **command**, not only the adapter. Cite
      `feat-001/AC-33`. Added by the pre-build check, which found that every part of `AC-33` — a
      criterion entirely about what skyhook tells an operator — was verified by nothing: 12.5 tests
      the adapter in isolation, and the command's existing tests predate the lookup.
      Four assertions, each on a path an operator can actually reach: the line naming the form GitHub
      stated; the line naming the conventional form when GitHub did not state one; the discovered
      prefix arriving as Terraform's `subject_prefix` variable; and an unreachable host stopping the
      run with the cause named and nothing applied. The command already takes an injected `fetch`
      and runner, so none of it needs a network or an account.
      This is the third time prose has shipped, gone stale, and been caught only by a live run. A
      criterion whose subject *is* prose is the one to hold a test against.
- [x] 12.7 `tests/bootstrap-terraform.test.ts` — cite `feat-001/AC-34`: the trust policies pin a
      literal subject with `StringEquals` and no wildcard, so what the installation trusts is fixed
      at apply time and cannot be widened by a later change to the repository's settings. The
      existing no-wildcard-subject assertion is most of this; extend it to say why rather than
      leaving the property implicit.
- [x] 12.8 Fold `chg-009` into `spec.md` — `AC-32`, `AC-33` and `AC-34` at the next free ids, and
      the *Known sharp edges* entry on the trust anchor gains the second reach. `AC-28`, `AC-30` and
      `AC-31` belong to `chg-007` and `AC-29` to `chg-008`; none is reused.
      That sharp edge also tells an operator applying the definition directly that they must know
      which trust-anchor case they are in. They must now supply their identity form too, and unlike
      the trust-anchor variable it has no default — so say so there, since 12.4 sends everyone else
      to the command that works it out for them.

## Phase 13 — two changes that were built but never folded

Found on 2026-08-15, closing phase 12: `chg-007` and `chg-008` are fully built and verified — the
first live environment depends on both — but neither was ever folded into `spec.md`, and neither had
a fold task, which is why the omission was invisible rather than merely outstanding. Four acceptance
criteria the code satisfies (`AC-28`, `AC-29`, `AC-30`, `AC-31`) exist only in change folders, so the
spec understates the system by four criteria. `chg-009` is folded; these are not.

Until both are folded this feature cannot honestly be called done: the check that would otherwise
catch it — the code-vs-spec audit — is advisory at prototype depth and would not stop it.

- [x] 13.1 Fold `chg-007` (the deploy contract) into `spec.md`. Its own status note says to fold
      only once feat-002's constitution amendment has merged, and it has (feat-002 task 7.2), so the
      ordering condition is satisfied. `AC-28`, `AC-30`, `AC-31` at those ids, plus the modifications
      the delta names to `AC-1`, `AC-9`, `AC-10`, `AC-14`, `AC-17`, `AC-18`, `AC-19`. `AC-29` is
      **not** added: feat-002's `chg-001` withdrew it with the trust condition it described.
- [x] 13.2 Fold `chg-008` (the one state key the infrastructure tool insists on reading) into
      `spec.md` as `AC-29` — the id `chg-007` vacated — and modify the *what a pull-request run is
      refused* passage to name its single exception. Then re-run the pre-build check: folding moves
      `spec.md`, which is what that check reads.
      The delta as written describes only the read. What actually shipped needed three parts, and
      the spec should say what the boundary is now rather than what the first attempt assumed: the
      role grant, the session policy's matching grant, and the key in both listing conditions —
      because a read of a never-created object is refused as forbidden rather than missing unless
      the caller could also have listed it.

## Phase 14 — remediation from the code-vs-spec audit (run 7)

- [x] 14.1 `src/cli/main.ts`, `src/cli/bootstrap.ts` — close `gap-007`. The bootstrap asks GitHub
      which form of OIDC subject this repository's runs present, and falls back to the conventional
      form when that read is refused. Both halves work. What is missing is the operator's way out:
      no usage text mentions that a token is read at all, so an operator in an organization that
      qualifies its subjects — the only place the fallback is wrong — has no way to know a token
      with repository admin would have avoided it.
      Two parts, both small. `main.ts`'s bootstrap options say that `GH_TOKEN` or `GITHUB_TOKEN` is
      used if present, that reading the setting needs repository admin, and what happens without it.
      The fallback line skyhook prints stops reading as a neutral fact — it currently says
      `(the conventional form; GitHub did not state one)`, which an operator has no reason to read
      as a warning — and instead names the one symptom that would follow if the assumption is
      wrong: every role assumption refused, with nothing but an access-denied to go on.
      Cite `feat-001/AC-32` and `gap-007` in the test comment, so the next audit closes the gap on
      that citation. Assert the fallback line's actionable half, not just its existence: the
      current wording would satisfy a test for "the fallback is announced" while telling an
      operator nothing they can act on, which is the whole finding.

## Phase 15 — the protection-read exception (authorized by `chg-010`)

- [x] 15.1 Fold `chg-010` — feat-003's teardown must read the protection marks it honors. The
      constitution gained its third named exception; this feature's AC-17 was amended (write-only
      refusal on marks, plus the confined read); `terraform/bootstrap/roles.tf` narrowed
      `DenyAllAccessToProtectionMarks` to `DenyAllButReadingProtectionMarks` (not_actions spares
      `GetObject` alone), gained `ReadEphemeralProtectionMarks`, the `protected/<repo>/pr-*`
      list-prefix entry, and the deny-outside exemption; the registry gained `removeRecord()` and
      `listIdentities()`. Implemented under feat-003's task 5.2, 2026-08-16; asserted in
      `tests/bootstrap-terraform.test.ts` and `tests/registry.test.ts`.

## Phase 16 — declared deploy inputs: the contract (authorized by `chg-011`)

> Built in the joint declared-inputs branch alongside feat-002 Phase 12, feat-003 Phase 7 and
> feat-005 Phase 4 — one build, four recorded changes, the shape Phase 11 set. **Ordering:** 16.4
> lands before any of the rest is built (the pre-build check's B1).

- [x] 16.4 [H] `product-global.md`'s privacy enumeration gains "declared deploy input values", in
      its own main-branch commit, never inside this change — od-3 on the manifest. LANDED
      2026-08-17 as main commit 783fcc8, authorized by andrew; every gate was re-stamped against
      the amended hash the same day, so nothing went stale. The build is unblocked.
      Files: `spec/product-global.md`.
- [ ] 16.1 `deploy.inputs` parses: an optional list of at most 16 names under `deploy`, refused
      by name when a name misses the `[a-zA-Z_][a-zA-Z0-9_-]*` shape (the generic class only —
      no Terraform knowledge enters core; a Terraform-reserved name is Terraform's own loud
      refusal at first use), appears twice, or contains `secret`/`password`/`token`/`key`/
      `credential` case-insensitively without a matching `deploy.allow_sensitive_input_names`
      entry; unknown-keys discipline unchanged; every command that does not deploy or destroy
      never reads it. Trace `feat-001/AC-35` in `tests/config.test.ts`.
      Files: `src/core/types.ts`, `src/core/config.ts`, `tests/config.test.ts`.
- [ ] 16.2 The record carries recorded input values (name → value), absent-tolerant in both
      directions: old records read cleanly, and a record without the field means "none recorded".
      Updates replace the whole map. The 512-character/no-control-characters value rule is
      enforced where a value is supplied (feat-002's refusal, task 12.1), and the registry
      round-trips the field. Trace `feat-001/AC-36` in `tests/registry.test.ts` and
      `tests/fake-store.ts`.
      Files: `src/core/types.ts`, `src/core/registry.ts`, `tests/registry.test.ts`,
      `tests/fake-store.ts`.
- [ ] 16.3 The seeded settings file states, beside `deploy.inputs`, that declared values are
      recorded in the registry in the clear and shown wherever the record is shown — the warning
      written where the operator declares the name. Trace `feat-001/AC-35` in
      `tests/install.test.ts`.
      Files: `src/core/install.ts`, `tests/install.test.ts`.
- [ ] 16.5 `skyhook redact <environment> <name>` removes one recorded value from the record,
      touching nothing else — the manual-dispatch surface protect and unprotect already ride,
      routed to no pull-request event (a guardrail, stated as such). Redaction removes, never
      rewrites; it writes read–CAS–retry like every mutator, and changes content, never state —
      a teardown's re-confirm must not read its version bump as a reactivation. Trace
      `feat-001/AC-37` in
      `tests/registry.test.ts` and the CLI test beside the protect verb's.
      Files: `src/core/registry.ts`, `src/cli/main.ts`, `tests/registry.test.ts`,
      `tests/cli-protect.test.ts` (or a sibling `cli-redact` test file).
