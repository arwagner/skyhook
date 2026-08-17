# Delta — deploy-action / chg-007 — declared inputs: record the artifacts a deploy carried

> The change expressed against the current spec as explicit operations.
>
> Revised 2026-08-17 after the pre-build check: the opening no longer claims inputs travel "the
> same way" as the identity (a repository must declare a matching `variable` block, which is
> exactly the contract term the identity avoids); "empty" is pinned; the read's position in the
> pipeline is stated. **Build ordering:** nothing here is built before `product-global.md`'s
> privacy enumeration lands (feat-001 od-3, its own main-branch commit).

## ADDED

- **Behavior paragraph** (beside "The environment identity reaches the repository's
  infrastructure without a contract term"):

  **Dynamic artifacts reach the definition without skyhook injecting anything either, and skyhook
  records what reached it.** A deploy often carries values no branch can know in advance — a
  container image tag built minutes earlier, an artifact URI. They travel as Terraform's own
  `TF_VAR_<name>` environment variables, set by the calling workflow; skyhook injects no variable
  and passes no `-var`. Unlike the identity, which needs no declaration at all, these are inputs
  the repository's definition must declare a matching `variable` block for — that contract is
  between the repository and its own Terraform, and skyhook is not a party to it. What skyhook
  adds is memory: the repository declares the names in its settings (`deploy.inputs`, read from
  the default branch like every setting), and skyhook reads each declared value at deploy time
  and records it against the environment once the apply succeeds — because an artifact reference
  is part of *what is deployed*, and the registry is the single source of truth for that. A
  destroy replays the recorded values, which is teardown's side of the contract. An undeclared
  variable still reaches a deploy — the environment is the workflow's own — but is not recorded,
  so at destroy time it does not exist; a variable the definition needs at destroy must be
  declared.

- **Scenario: a deploy carries declared inputs**
  - Given a repository whose settings declare `deploy.inputs: [image_tag]`, and a workflow that
    builds an image and sets `TF_VAR_image_tag` before invoking skyhook
  - When a pull request deploys twice, each push building a new image
  - Then each successful deploy records the value that push supplied, alongside the commit, and
    the record always names the image the standing environment was actually built from

- **Scenario: a declared input is missing**
  - Given a repository whose settings declare an input, and a run whose environment does not set
    the corresponding `TF_VAR_<name>`
  - When the deploy runs
  - Then it is refused before the claim, naming the missing variable — no record is written,
    nothing is applied, and no default silently deploys in the value's place

- **AC-22:** A deploy on a repository whose settings declare inputs reads `TF_VAR_<name>` for
  each declared name after the settings are read and before the cap is counted — so before the
  claim, and a mis-wired workflow gets the more actionable refusal whatever the environment count
  is. A declared input that is missing, empty, or in violation of the store's value rule (512
  characters, no control characters — feat-001/AC-36 owns the rule; this feature restates none of
  it) is refused there, naming the variable: no record is written and nothing is applied. Empty
  means the empty string exactly; a whitespace-only value is a value, recorded as supplied. The
  refusal is distinguishable, in output and exit status, from a failure of the repository's own
  apply. Declared inputs change nothing about how values reach Terraform — skyhook passes no
  `-var`, and a repository that declares none deploys exactly as before.

- **AC-23:** The recorded input values change only when the recorded commit does: after a
  successful apply, both are updated together to that deploy's values; a failed apply leaves both
  unchanged. An environment's record therefore names the commit and the artifacts of the last
  deploy that landed, or none if none has.

## MODIFIED

None. The identity-contract paragraph, AC-12, and AC-16 stand as written; the new paragraph sits
beside them rather than amending them.

## REMOVED

None.
