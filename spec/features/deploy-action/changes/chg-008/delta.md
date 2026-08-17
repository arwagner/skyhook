# Delta — deploy-action / chg-008 — hand back every output, not just the address

> The change expressed against the current spec as explicit operations.
>
> Revised 2026-08-17 after the pre-build check (both passes). The security pass found that the
> mechanism this change extends — `appendOutput`, which writes a `GITHUB_OUTPUT` heredoc whose
> delimiter is derived from the value's own length — is already injectable by a crafted output
> value, and that the "you could read these yourself today" framing was false (the deploy role
> lives and dies inside skyhook, D6). Both are corrected below: AC-25 hardens the write for every
> output including `url`, and the behavior paragraph now states the new exposure honestly rather
> than as a generalization. The empty-value bytes, the size ceiling, and a no-raw-logging rule
> are pinned too.

## ADDED

- **Behavior paragraph** (beside "Skyhook does not write to the pull request"):

  **Every output the definition declares is handed back, and skyhook decides nothing about
  them.** A deploy is often not finished when the apply is — a workflow may still need to ship
  assets into a bucket the environment owns, or invalidate a distribution it created — and the
  identifiers those steps need are outputs of the definition just applied. The run exposes every
  root output as one compact JSON document, name to value, values verbatim as Terraform produced
  them (objects and lists included); the calling workflow picks what it needs. This is the URL's
  philosophy generalized: skyhook reads and hands back, owns no format beyond Terraform's own,
  and still writes nothing to the pull request.

  **This is a new exposure channel, stated plainly rather than dressed as a generalization.**
  Until now the only output that left skyhook's process was the single `url` string; every other
  value the definition produced stayed in skyhook's memory and was discarded. The deploy role is
  assumed and used entirely inside skyhook and never handed to the calling workflow (plan D6), so
  a later step could not read these values for itself — this change is what makes them reach the
  workflow, and with it the job log, which on a public repository is world-readable. An output
  the definition marks **sensitive** is therefore omitted from the document and named as omitted
  in the run's log. That omission is the definition author's own judgment honored, not a boundary
  skyhook enforces: the author of the definition and the author of the workflow are one trust
  domain (only a collaborator opens a deploying pull request), so a value left unmarked is
  exposed verbatim, and skyhook does not second-guess the marking. Two consequences the
  definition author owns, written where they will read them: a value carrying a secret must be
  marked `sensitive` or it reaches the log; and because the flag is per-output, a compound object
  mixing a secret field with public ones must be split, since marking the whole thing sensitive
  omits the public fields and leaving it unmarked leaks the secret. A workflow that truly needs a
  sensitive value reads it from Terraform in its own steps, standing up its own credential to do
  so, on its own responsibility. The registry is untouched: `url` remains the only output
  recorded, and the handed-back document lives exactly as long as the run.

- **Scenario: the workflow finishes the deploy with the environment's own identifiers**
  - Given a definition whose outputs include `url`, `web_bucket`, and a `cdn` object, and a
    workflow with a post-apply step that syncs assets to the bucket
  - When a pull request deploys successfully
  - Then the run's `outputs` value parses as JSON and holds all three under their own names, the
    post-apply step reads `web_bucket` from it without re-deriving anything, and `url` is also
    still handed back on its own output and recorded, exactly as before

- **AC-24:** After a successful apply, the run exposes one `outputs` value to the calling
  workflow: a **compact, single-line** JSON document of every root output the definition
  declares, names to values, values verbatim (a string stays a string, an object stays an
  object), except outputs the definition marks sensitive — those are omitted from the document,
  and the run's log names each omitted output so its absence reads as a decision rather than a
  bug. A definition with no outputs yields the two-byte document `{}`. A skipped run (a fork) and
  a failed run yield the empty string, exactly as `url` already does — so a workflow parses
  `outputs` only on a successful deploy, and `fromJSON("")` is never reached on the paths where
  the value is empty. The document is handed back and nowhere else: nothing from it is recorded
  in the registry, and skyhook declares no new permission and changes none of `action.yml`'s
  existing ones. `url`'s own output and its recording (AC-13, AC-15) are unchanged — this adds a
  second reader of the same outputs skyhook already reads, and no new Terraform invocation, so
  the 60-second budget (AC-14) is unaffected.

- [ ] **AC-25:** No output value skyhook writes to `GITHUB_OUTPUT` can inject a further output,
  whatever the definition's author put in it. The delimiter that frames a value is generated
  fresh for each write from a cryptographic random source (`node:crypto`, at least 128 bits) —
  never derived from the value, its length, or its name — so a crafted value cannot reproduce its
  own closing marker and break out; on the astronomically unlikely event that a value still
  contains a line equal to the chosen delimiter, the write fails loudly rather than emitting an
  unsafe frame. This governs every value skyhook writes, `url` included: the weakness predates
  this change, and hardening it once at the shared write is the fix. The unfiltered
  `terraform output -json` result — which carries sensitive values in the clear before the
  omission runs — is never logged, never written to any output, and never placed in an error
  message, on every path including a parse failure and a non-zero exit.

- [ ] **AC-26:** A document that would exceed what the output channel can carry does not corrupt
  the channel and does not misreport the deploy. GitHub caps one `GITHUB_OUTPUT` value at roughly
  1 MB; a document approaching that ceiling is replaced by a small, valid JSON object carrying a
  single reserved key that no Terraform output can collide with (`__skyhook_truncated`), whose
  value names the reason and the byte size omitted but embeds no output content — sensitive or
  not — and the run emits a workflow warning annotation, not merely a log line, so a truncation
  is visible in the pull request's checks and a workflow reading a now-absent output degrades
  loudly rather than silently. The apply already succeeded and real infrastructure stands, so the
  run's result is still `deployed`: an output too large to hand back is not a failed deploy, and
  reporting it as one would be a louder lie than the truncation it replaces. The size check runs
  against the compact document *after* sensitive outputs are omitted, so nothing it measures or
  reports can reopen the disclosure AC-25 closes.

## MODIFIED

None. AC-13 and AC-15 stand as written; the new paragraph and criteria sit beside them. AC-25's
hardening of the shared writer changes the delimiter `url` is written with, not the value or the
`url` contract.

## REMOVED

None.
