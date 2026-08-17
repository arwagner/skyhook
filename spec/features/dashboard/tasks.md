# Tasks — dashboard (feat-005)

Glyphs: `[x]` done · `[ ]` not started · `[~]` in progress · `[-]` n/a · `[H]` human-gated.
`[P]` = may run in parallel with its phase siblings.

## Phase 1 — the pure page (test-first)

- [x] 1.1 [P] Core model + renderer (`src/core/dashboard.ts`, `tests/dashboard.test.ts`).
  Tests first. `buildDashboardModel(records, protectedIdentities, cap)` → rows sorted by
  identity with `reclaimable` = released AND not protected, cap counts;
  `renderDashboardPage(model)` → complete semantic-HTML string (list table, cap line, per-row
  anchors to full-record detail sections, "pending" for null url/commit, explicit empty state
  with the cap line still shown, no `<a>` for a null URL). PR number derived only from the
  `pr-<number>` identity convention, absent otherwise. Completion condition (analyze S1): every
  interpolated field HTML-escaped; only `http:`/`https:` URLs become links; hostile-content
  cases (`<`, `"`, a `javascript:` URL) must render inert. Trace tokens feat-005/AC-1 …
  feat-005/AC-6 in test names.

- [x] 1.2 [P] Snapshot read path (`src/adapters/aws/snapshot.ts`,
  `tests/snapshot-store.test.ts`). Tests first, fake runner. `SnapshotStore`: read-only `Store`
  over a local directory (read/list served from disk; createIfAbsent/compareAndSwap/delete
  throw). `fetchRegistrySnapshot(runner, bucket, region, repository, dir)`: one
  `aws s3 cp --recursive` for `registry/<repo>/`, one key listing for `protected/<repo>/`;
  returns the records (as a read-only store) + protected identities. Snapshot dir via
  `fs.mkdtemp` (0700); argv-array `aws` invocations asserted in the fake-runner tests (analyze
  S2, S6). As built, the temp directory is read into memory and REMOVED before the fetch even
  returns — stronger than the planned per-render cleanup, and tested. Trace feat-005/AC-1,
  feat-005/AC-3.

## Phase 2 — the command

- [x] 2.1 Orchestrator (`src/cli/dashboard.ts`, `tests/cli-dashboard.test.ts`). Depends on 1.1
  and 1.2. Load `.skyhook/config.yml` from `--root` (default cwd); repository from git remote or
  `--repository`; snapshot → `Registry.list()` + protected identities → model → serve via
  `node:http` bound to `127.0.0.1` only (ephemeral port unless `--port`), fresh snapshot per
  GET, print the URL. Prior snapshot generation removed per render and on exit/SIGINT; a failed
  fetch renders a generic "could not read the registry" page with CLI stderr logged to the
  terminal only (analyze S2, S7). Test over a real loopback socket with an injected runner;
  assert the bound address is loopback. Trace feat-005/AC-7.

- [x] 2.2 Wire into `src/cli/main.ts` + USAGE (`--repository`, `--root`, `--port`). Depends on
  2.1. Usage/unknown-flag exits covered in `tests/cli.test.ts`.

## Phase 3 — proof

- [x] 3.1 [H] Must-prove observation (hs-1). Run `skyhook dashboard` from the real consuming
  repo against the real installation. Confirm at a glance, without the AWS console or CLI: cap
  headroom, which slot can be freed, and the URL for a branch's PR. Record what was observed in
  the manifest's `human_signoff` entry.
  **Observed (andrew, 2026-08-16):** run from the deadweight repo — "1 of 5 environments used";
  the single environment pr-4 correctly in use (neither reclaimable nor protected); its PR URL
  present as a working link. Full observation recorded on hs-1 in `feature.md`.

## Phase 4 — the detail view shows the recorded inputs (authorized by `chg-001`)

> Built in the joint declared-inputs branch with feat-001 Phase 16, feat-002 Phase 12 and
> feat-003 Phase 7. **Ordering:** feat-001 task 16.4 (the product-global amendment, od-3) lands
> before any of this is built.

- [ ] 4.1 The detail view renders the record's deploy inputs when it carries any — one line per
      input, sorted by name, name and value both HTML-escaped per D5's hostile-content rule,
      never linkified whatever the value looks like, plain wrapped text with no truncation — and
      renders nothing for them (no pending placeholder) when it does not; the list view is
      unchanged. Completion condition: D5's hostile-content test matrix extended to this field
      (script tags, URL-shaped values, 512-char values). Trace `feat-005/AC-4` in
      `tests/dashboard.test.ts`.
