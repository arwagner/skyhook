# Delta — dashboard / chg-001 — the detail view shows the recorded inputs

> The change expressed against the current spec as explicit operations.
>
> Revised 2026-08-17 after the pre-build check: the hostile-content rules are stated for the new
> field rather than inherited silently, the rendering shape is pinned, the earlier pending-
> placeholder scenario is scoped so the two rules cannot be read as conflicting, and the widened
> exposure becomes a stated sharp edge. **Build ordering:** nothing here is built before
> `product-global.md`'s privacy enumeration lands (feat-001 od-3, its own main-branch commit).

## ADDED

- **Known sharp edges — recorded inputs widen who can read a workflow's values.** Before
  recording existed, a `TF_VAR` value lived in one CI run and its logs, visible to whoever GitHub
  lets read them. A recorded value is visible to a different audience: anyone who can run
  `skyhook dashboard` with credentials that read the registry. The values are deployment metadata
  by contract (feat-001/AC-35 warns where they are declared; sensitive names are refused at
  config read; feat-001/AC-37 is the redaction path when the warning fails) — but the dashboard
  is where the widened audience is felt, so it is stated here, where its operator reads. The
  values are also unverified strings a deploy supplied: evidence of what was handed to Terraform,
  not an attestation of what is running.

## MODIFIED

- **Scenario: one environment's detail**
  - Was: Then I see its full registry record: repository, identity, deployed commit, pull request
    number (derived from the identity, when applicable), state, protection, timestamps
    (`createdAt` and `updatedAt`), and URL
  - Now: Then I see its full registry record: repository, identity, deployed commit, pull request
    number (derived from the identity, when applicable), state, protection, timestamps
    (`createdAt` and `updatedAt`), URL, and — when the record carries any — the recorded deploy
    inputs, one line per input, sorted by name, the name and its value as plain wrapped text

- **AC-4 — the detail view's enumeration**
  - Was: Selecting an environment shows its full registry record (repository, identity, deployed
    commit, pull request number derived from the identity when applicable, state, protection,
    `createdAt` and `updatedAt`), and its URL is a working link.
  - Now: Selecting an environment shows its full registry record (repository, identity, deployed
    commit, pull request number derived from the identity when applicable, state, protection,
    `createdAt` and `updatedAt`, and the recorded deploy inputs when the record carries any), and
    its URL is a working link. Recorded inputs render one line per input, sorted by name, and
    both name and value are HTML-escaped like every interpolated field (plan D5's rule, restated
    here because this is the field most likely to carry hostile content) — a value is never a
    link, however much it looks like a URL, and never truncated: plain wrapped text, full length.
    A record without recorded inputs shows nothing for them — not a pending placeholder, because
    no later step fills them in: a record without them never declared any.

- **Scenario: a record before its first deploy finishes** (the pending-placeholder scenario)
  - Was: Then the unknown fields show an explicit "pending" placeholder — not a broken link, not
    an error
  - Now: Then the not-yet-known URL and deployed commit show an explicit "pending" placeholder —
    not a broken link, not an error. The placeholder is for fields a later step fills in;
    recorded deploy inputs are not one (AC-4), so their absence shows nothing

## REMOVED

None.
