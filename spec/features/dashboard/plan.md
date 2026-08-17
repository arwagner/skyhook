# Plan — dashboard (feat-005)

The HOW behind `spec.md`: a local, read-only page served by `skyhook dashboard`, run from inside
the consuming repo. Prototype depth — the smallest shape that proves the must-prove (one glance
answers cap headroom, freeable slot, and a branch's URL).

## Design decisions

- **D1 — A `skyhook dashboard` subcommand, in the destruct family of surfaces.** It is a local,
  human-run command (od-1's resolution), so it follows the conventions `destruct` already set:
  config read from the working tree's `.skyhook/config.yml` (safe for a human command — unlike a
  PR run, there is no attacker-controlled checkout), repository derived from the git remote with a
  `--repository` override, credentials taken from the developer's environment via the `aws` CLI
  (`AWS_PROFILE`, SSO — whatever their CLI already uses). No new credential machinery.

- **D2 — Read the registry as a one-shot local snapshot, then reuse `Registry` unchanged.** Two
  `aws` CLI invocations per page load, regardless of how many environments exist:
  `aws s3 cp --recursive` of `registry/<repo>/` into a temp directory (all records in one call),
  and a key listing of `protected/<repo>/` (protection is key-existence only — the marker's
  content is never needed). A small read-only `SnapshotStore` (implements the core `Store`
  interface; the three write methods throw, as nothing on this path may call them) serves those
  local files, and `Registry.list()` runs over it unchanged. This is what guarantees AC-1's
  "lists nothing the registry does not record": the one existing `deserialize` is the only record
  parser — with one declared exception, the PR number, which is *derived* by matching the identity
  against the `pr-<number>` naming convention (absent when it does not match; see AC-1's wording).
  Two CLI calls also keeps the under-2-seconds global NFR plausible; one call per record would
  not. The snapshot directory is created with `fs.mkdtemp` under a 0700-mode parent, and the
  prior generation is removed on each render and on exit/SIGINT (analyze S2) — records must not
  accumulate in a world-readable temp location.

- **D3 — Rendering is a pure core function; the server is a thin loopback shell.** New
  `src/core/dashboard.ts` exports `buildDashboardModel(records, protectedIdentities, cap)` →
  model (rows sorted by identity, per-row `reclaimable` = released AND not protected, cap counts)
  and `renderDashboardPage(model)` → a complete HTML string. Both are provider-agnostic and pure,
  so every acceptance criterion except AC-7 verifies against them directly. The server is
  `node:http` bound to `127.0.0.1` **only** (that binding IS the "not publicly readable" answer at
  this depth), one route, no JavaScript, plain semantic HTML; every GET takes a fresh snapshot and
  re-renders, so browser refresh is the update mechanism the spec promises. The command prints the
  URL and runs until interrupted. `--port` optional; default is an ephemeral port.

- **D4 — Cap counting = number of registry records, exactly the deploy's count.** The deploy's cap
  check uses key-count semantics (`Registry.countEnvironments`: a `released` environment still
  stands and still costs). The dashboard shows `M of N` from the same list it renders (same
  key-derived set), with cap config from `parseConfig` (`environment_cap`, default enabled/5).
  `enabled: false` renders as "no cap configured", per AC-2.

- **D5 — Detail without JavaScript: same-page anchors.** Each row's identity links to a
  per-environment section further down the same page showing the full record (repository,
  identity, deployed commit, PR number derived from the `pr-<number>` identity convention when it
  matches, state, protection, createdAt/updatedAt, URL, and — since `chg-001` — the recorded
  deploy inputs when the record carries any: one line per input, sorted by name, plain wrapped
  text, never truncated, never a link). One route, one render, satisfies AC-4.
  Null `url`/`deployedCommit` render as a literal "pending" marker (AC-6), never an empty href;
  absent recorded inputs render nothing — no later step fills them in (`chg-001`).
  **Record content is hostile until proven otherwise** (analyze S1): record bodies are writable
  by PR-triggered runs, so `renderDashboardPage` HTML-escapes every interpolated field, and only
  a URL whose scheme is `http:`/`https:` becomes an `<a href>` — anything else renders as inert
  escaped text. This is a completion condition of task 1.1, with hostile-content test cases.
  Recorded deploy inputs are the field this rule exists for — attacker-suppliable by design — so
  `chg-001` restates it for them explicitly: name and value both escaped, and a value is NEVER
  linkified, `http:` scheme or not; the hostile-content test matrix extends to this field
  (task 4.1's completion condition).

- **D6 — Toolchain: nothing new.** TypeScript type-stripping under Node ≥22.18, `tsc --noEmit`,
  `node --test "tests/**/*.test.ts"`, existing `FakeStore` and fake-runner test patterns. No
  dependency is added — `node:http` is in the platform.

## Task breakdown

Phase 1 — the pure page (test-first):
- [ ] 1.1 [P] Core model + renderer. Write `tests/dashboard.test.ts` first, driving
  `buildDashboardModel` / `renderDashboardPage` in new `src/core/dashboard.ts`: full listing
  fields, cap line (enabled, disabled), reclaimable/protected distinction, detail sections,
  "pending" placeholders, empty state. Covers feat-005/AC-1 … feat-005/AC-6.
- [ ] 1.2 [P] Snapshot read path. Write `tests/snapshot-store.test.ts` first, driving a
  `SnapshotStore` (read-only `Store` over a local directory; writes throw) plus a
  `fetchRegistrySnapshot(runner, bucket, region, repository, dir)` helper in
  `src/adapters/aws/snapshot.ts` that issues the two `aws` CLI calls (records `cp --recursive`,
  protection `listKeys`) with a fake runner. Supports feat-005/AC-1, feat-005/AC-3.

Phase 2 — the command:
- [ ] 2.1 Orchestrator `src/cli/dashboard.ts`: load config, resolve repository (git remote /
  `--repository`), take a snapshot, `Registry.list()` + protected identities, build model, serve
  on `127.0.0.1` via `node:http`, print the URL; fresh snapshot per GET. Tests in
  `tests/cli-dashboard.test.ts` with injected runner: page served over a real loopback socket
  from a root holding `.skyhook/config.yml`; assert the bound address is loopback. Covers
  feat-005/AC-7.
- [ ] 2.2 Wire `dashboard` into `src/cli/main.ts` + USAGE text (`--repository`, `--root`,
  `--port`); unknown-flag and usage-exit cases in `tests/cli.test.ts`.

Phase 3 — proof:
- [ ] 3.1 [H] Must-prove observation (hs-1): run `skyhook dashboard` from the real consuming repo
  against the real installation and confirm the three glances — cap headroom, which slot can be
  freed, the URL for a branch's PR — answer without the AWS console or CLI.

## Verification approach

| AC | Seam | How |
|---|---|---|
| feat-005/AC-1 | `buildDashboardModel`/`renderDashboardPage` (exported core functions) | Records in → every field out; a field absent from the record never appears. Test names carry the token. |
| feat-005/AC-2 | same | Cap enabled → "M of N" with M = record count; disabled → explicit no-cap wording, no meter. |
| feat-005/AC-3 | same | released+unprotected row marked reclaimable; protected row visibly marked; assertions on the rendered classes/text. |
| feat-005/AC-4 | rendered page | Row anchor resolves to a detail section containing the full record; URL rendered as a real `href`. |
| feat-005/AC-5 | same | Zero records → explicit empty-state text plus the cap line; no error markup. |
| feat-005/AC-6 | same | `url: null` / `deployedCommit: null` → literal "pending", and no `<a>` for a null URL. |
| feat-005/AC-7 | the `dashboard()` command over a real loopback socket | Command started from a root with `.skyhook/config.yml`, fake runner supplying the snapshot; HTTP GET against the printed URL returns the page; server address asserted to be `127.0.0.1`. |
| must-prove | human observation (hs-1) | Task 3.1 — machine-unverifiable by nature; recorded in `human_signoff`. |

Tests live under the workspace's declared glob (`tests/**/*.test.ts`); run with
`npm test` (`node --test "tests/**/*.test.ts"`) and `npm run check` for types.

## NFR posture (prototype)

- **Not publicly readable:** loopback-only bind; nothing hosted. Real authentication is promote
  debt (od-1 resolution).
- **Under 2 seconds:** two `aws` CLI calls per load, independent of environment count.
- **WCAG 2.2 AA:** semantic HTML (single `<table>`, headers, `lang`, no JS) — the friendly shape,
  not a certification; certification is promote debt (recorded in spec sharp edges).
- **Encrypted at rest:** read as applying to durable/cloud storage. The short-lived local
  snapshot relies on the developer's own disk encryption as the baseline (analyze S5); made
  explicit here rather than left implied.
- **Failure output:** a failed snapshot fetch renders a generic "could not read the registry"
  page; `aws` CLI stderr is logged to the terminal, never echoed into an HTTP response
  (analyze S7). Command construction stays argv-array via the existing `CommandRunner` — never a
  shell string (analyze S6).
