# Delta — teardown / chg-001 — a destroy replays the recorded inputs

> The change expressed against the current spec as explicit operations.
>
> Revised 2026-08-17 after the pre-build check: the error-content promise is softened to what
> skyhook actually authors, the fast-path failure citation gains AC-5's mechanics beside AC-9's,
> and the forever-failing pre-recording case becomes a stated sharp edge. **Build ordering:**
> nothing here is built before `product-global.md`'s privacy enumeration lands (feat-001 od-3,
> its own main-branch commit).

## ADDED

- **Scenario: destroying an environment whose deploy carried declared inputs**
  - Given an environment whose record carries recorded deploy inputs (an image tag its definition
    requires as a variable), recorded by the deploy that built it
  - When any teardown path destroys it — the close fast path, the sweep, or a manual teardown
  - Then the definition runs with `TF_VAR_<name>` set to each recorded value, the destroy
    succeeds without any variable prompt or missing-variable error, and the record and its
    recorded values are removed together, as the record always is

- **AC-15:** Every destroy that runs the definition at the recorded commit sets `TF_VAR_<name>`
  for each input value the record carries, before the definition runs — on the close fast path,
  the sweep, and the manual teardown alike, because they share one teardown. The recorded values
  are used even when the repository's declared list has since changed: the record is the truth
  for what was deployed, exactly as it already is for the commit. A record carrying no recorded
  inputs destroys with none set, which is the unchanged behavior of every record written before
  recording existed. When such a record's definition nonetheless requires a variable, the destroy
  fails loudly and is retried: on the sweep, down AC-9's keep-going-then-fail path; on the close
  fast path, by leaving the `released` record that AC-5 defines as a started teardown, which the
  next sweep pass picks up. Either way the run's output surfaces Terraform's own failure text,
  which names the variable — skyhook does not author that message and promises no shape for it.

- **Known sharp edges — a pre-recording record that needs a variable fails until a human moves.**
  An environment deployed before recording existed (or whose value was redacted, feat-001/AC-37)
  has nothing to replay. If its definition requires the variable, every destroy attempt fails
  and is retried, visibly, forever — the same class as the "recorded commit may be gone" edge
  beside this one, and the same remedy: a human redeploys so the values are recorded, supplies
  the destroy by hand, or accepts the noise until the environment is dealt with. Nothing here
  retries smarter, deliberately: inventing a value for a destroy is how the wrong thing gets
  destroyed quietly.

## MODIFIED

None. The teardown sequence, eligibility, protection, and every existing criterion stand as
written; this delta changes only the environment the destroy's Terraform child runs in.

## REMOVED

None.
