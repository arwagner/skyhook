# Delta — backing-store / chg-011 — the record remembers what was deployed into it

> The change expressed against the current spec as explicit operations.
>
> Revised 2026-08-17 after the pre-build check: the identifier rule is pinned, the declared list
> gains a count cap and a sensitive-name refusal, the record update is defined as a wholesale
> replace, values refuse control characters, and a redaction path (AC-37) is added — the security
> review's remedies, applied before anything is built. **Build ordering:** nothing in this delta
> is built before `product-global.md`'s privacy enumeration names declared deploy input values
> (od-3 on the manifest, its own main-branch commit).

## ADDED

- **AC-35:** Configuration can declare, under `deploy.inputs`, the names of the Terraform input
  variables a deploy carries — an explicit list, optional, at most 16 names, and read only by
  commands that deploy or destroy, so an installation that declares none keeps working unchanged.
  A name is refused when the configuration is read, by name, when it: does not match the
  identifier shape `[a-zA-Z_][a-zA-Z0-9_-]*` (the shape is generic on purpose — the core stays
  provider-agnostic, and a name Terraform additionally reserves, like `count` or `source`, is
  refused by Terraform itself at first use, loudly); appears twice; or contains any of `secret`,
  `password`, `token`, `key`, or `credential` case-insensitively — unless that exact name is also
  listed under `deploy.allow_sensitive_input_names`, a per-name, reviewable exception that lives
  in the same default-branch-read settings. The settings file states, beside the setting, what
  declaring a name means: the variable's value at each deploy is recorded in the registry in the
  clear and shown wherever the record is shown — so a secret must never travel through a declared
  input. The warning is written where the operator declares the name, not only in the
  specification. The denylist is defense-in-depth beside that warning, not the boundary: it
  catches the obvious names and is trivially evaded by ones it does not list (`passwd`,
  `conn_str`, a bearer value inside an innocently named field), and the sharp edges say so where
  an operator reads. (Where the configuration is read from is AC-9's promise and needs no
  amendment.)

- **AC-36:** Every environment record can carry the recorded values of its declared deploy inputs
  — name to value — and carries none before a deploy that declared any has succeeded. The values
  are updated exactly when the recorded commit is: after a successful apply, and never on a
  failed one, so the recorded values and the recorded commit always describe the same landed
  deploy. The update replaces the whole map with that deploy's values — a name no longer declared
  does not linger from an earlier deploy. A value is at most 512 characters and contains no
  control characters (newlines included) and no Unicode direction-control characters
  (U+202A–U+202E, U+2066–U+2069 — HTML-escaping does not neutralize a visually reordered
  rendering, so the spoof is refused at the door instead); a value that violates any of these is
  refused where it is
  supplied, not where it is stored, so the refusal names the variable rather than surfacing later
  as a storage failure. Records written before this change, and records for repositories that
  declare no inputs, simply lack the field, and every reader treats that as "none recorded".

- **AC-37:** A deliberate human action can redact one recorded input value — the value is removed
  from the environment's record, the rest of the record untouched — so a secret recorded by
  mistake is not stuck in the registry until the environment dies. Redaction writes the way every
  registry mutation writes: read, compare-and-swap, retry on a lost race — never an unconditional
  overwrite. And it changes the record's *content*, never its *state*: reactivation is a state
  transition to `active`, so no teardown step that re-confirms its claim may read a
  redaction-only write as a reactivation — the re-confirm keys on state, not on version identity
  alone. Redaction rides the same manual-dispatch surface as protect and unprotect, and the
  dispatch table routes no pull-request event to it — a guardrail in the file a maintainer
  reviews, stated honestly rather than dressed as a cloud boundary: the cloud does not refuse a
  pull-request run this write, and does not need to, because an ordinary deploy already replaces
  its own record's whole map (AC-36), so bypassing the guardrail gains a run nothing it lacks.
  It trades destroy convenience for containment, knowingly: a destroy
  after a redaction runs without that value, and if the definition requires it, the destroy fails
  down the teardown feature's loud, retried path naming the variable — the operator redeploys to
  re-record, supplies the destroy by hand, or accepts the noise until teardown. Redaction removes;
  it never rewrites a value, because a redacted record must read as "value withheld", not as a
  different deploy.

## MODIFIED

None. The record's existing fields, the claim discipline, and every other setting are untouched;
this delta only adds alongside AC-28 (the URL field) and AC-31 (the deploy settings), which it
mirrors.

## REMOVED

None.
