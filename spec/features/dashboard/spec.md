## Why
The registry (feat-001) records everything skyhook manages, but no human can see it. This
prototype puts that record on one page, to prove one thing: that a single glance can answer "how
close are we to the cap", "which slot can be freed", and "what is the URL for my branch" — with no
cloud console and no CLI. See `research.md` for the full brief.

## User stories
- As a developer, I want to see every environment with its pull request number (when it has one)
  and its URL, so that I can open the environment for my branch's PR without hunting for the link.
- As a developer blocked at the environment cap, I want to see which environments are reclaimable
  and which are protected or in use, so that I know which slot can be freed.
- As a developer, I want to see how many environments exist against the configured cap, so that I
  see the ceiling coming before a deploy is refused.
- As a developer, I want to select one environment and see its full record, so that I can tell
  exactly what code is deployed there and when it last changed.

## Behavior & scenarios

The page is **read-only** and shows **only what the registry records** — environment records, their
protection markers, and the per-repo configuration that sets the cap. It performs no action on any
environment and discovers nothing by talking to the cloud beyond that store.

**How it is reached (od-1, resolved):** a developer runs one skyhook command from inside the
consuming repo. The command reads that repo's registry with the developer's own credentials and
serves the page locally. Nothing is hosted; the page shows the environments of the installation the
repo belongs to.

- **Scenario: the list (happy path)**
  - Given the registry records one or more environments
  - When I open the dashboard
  - Then I see every recorded environment with its identity, pull request number (derived from
    the identity when it follows the `pr-<number>` naming convention; absent otherwise — the
    registry stores no PR field), state (`active` or `released`), protection mark, last-deployed
    time (the record's `updatedAt`), deployed commit, and URL

- **Scenario: cap headroom**
  - Given the repository configures an environment cap of N and the registry records M environments
    that count against it
  - When I open the dashboard
  - Then I see "M of N" (or equivalent) counted the same way a deploy counts the cap
  - And given no cap is configured, the dashboard says so rather than showing a meter

- **Scenario: finding a freeable slot**
  - Given the cap is reached
  - When I look at the list
  - Then environments that teardown may reclaim (`released` and not protected) are visibly
    distinct from active ones, and protected environments are visibly marked as such

- **Scenario: finding a pull request's URL**
  - Given an environment exists for pull request 482
  - When I locate its row
  - Then its URL is present as a working link

- **Scenario: a record before its first deploy finishes**
  - Given a recorded environment whose URL or deployed commit is not yet known (the record is
    written before the infrastructure exists)
  - When I view its row or detail
  - Then the unknown fields show an explicit "pending" placeholder — not a broken link, not an
    error

- **Scenario: one environment's detail**
  - Given a recorded environment
  - When I select it
  - Then I see its full registry record: repository, identity, deployed commit, pull request
    number (derived from the identity, when applicable), state, protection, timestamps
    (`createdAt` and `updatedAt`), and URL

- **Scenario: empty registry**
  - Given the registry records no environments
  - When I open the dashboard
  - Then I see an explicit "no environments" state (with the cap line still shown), not an error
    and not a blank page

## Acceptance criteria
- [ ] AC-1: The dashboard lists every environment the registry records for the installation —
  identity, pull request number (derived from the identity when it follows the `pr-<number>`
  naming convention, absent otherwise), state, protection, last-deployed time (`updatedAt`), and
  URL — and, the derived PR number aside, lists nothing the registry does not record.
- [ ] AC-2: When a cap is configured, the dashboard shows environments-used against the cap,
  counted the same way a deploy counts it; when no cap is configured, it states that instead of
  showing a meter.
- [ ] AC-3: A reclaimable environment (`released` and not protected) is visually distinguishable
  from every other environment, and a protected environment is visibly marked.
- [ ] AC-4: Selecting an environment shows its full registry record (repository, identity,
  deployed commit, pull request number derived from the identity when applicable, state,
  protection, `createdAt` and `updatedAt`), and its URL is a working link.
- [ ] AC-5: With an empty registry, the dashboard shows an explicit empty state with the cap line
  still shown, rather than an error or a blank page.
- [ ] AC-6: A record whose URL or deployed commit is not yet known shows an explicit "pending"
  placeholder for those fields — never a broken link, an error, or a missing row.
- [ ] AC-7: One skyhook command, run from inside a consuming repo with the developer's own
  credentials, serves the page locally and shows that repo's installation — no hosted or shared
  endpoint is created.

## Open questions
None. od-1 (access shape) was resolved 2026-08-16: a locally served page — see Known sharp edges.

## Known sharp edges
- **Access (od-1, resolved).** Product-global forbids a publicly readable dashboard. This
  prototype satisfies that by hosting nothing: a skyhook command run from inside the consuming
  repo serves the page locally to the developer, reading the registry with the developer's own
  credentials. Real authentication is recorded debt to pay at promote. Two limits of that answer,
  stated plainly: loopback binding excludes network readers, not other accounts on the same host
  (or an SSH tunnel to it) — do not run this on a shared machine; and a hostile browser tab could
  in principle read the page via DNS rebinding. Both are confidentiality-only (the page has no
  actions) and are closed by the same promote-time authentication debt.
- **Credentials.** The command inherits whatever credential hygiene the developer's own AWS CLI
  already has (the same posture as `skyhook destruct`); skyhook introduces no new credentials.
- **Read-only.** No destroy, protect, or deploy action exists on the page. Acting on what the
  page shows still goes through the existing mechanisms.
- **Freshness.** The page reflects the registry as of load time; there are no live updates.
  Refresh is the answer at prototype depth.
- **Global NFRs are the ceiling, not this spec's job.** The under-2-second render, authentication,
  and WCAG 2.2 AA requirements in `product-global.md` bind the dashboard at GA. The prototype must
  not choose a shape that obviously cannot meet them (for example, one cloud read per row), but it
  certifies none of them; the gap is recorded debt to pay at promote.
