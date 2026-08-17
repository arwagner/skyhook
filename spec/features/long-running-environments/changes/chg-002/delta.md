# Delta — chg-002: protecting an ephemeral environment is a feature, not an accident

> The change expressed against the current spec as explicit operations.

## ADDED
- AC-12: The protect and unprotect commands accept an ephemeral (`pr-*`) name as well: a
  deliberate default-branch human action sets or clears the mark on a pull-request preview, the
  mark is honored by the close event and the sweep exactly as the teardown feature specifies, and
  pull-request runs still cannot write any mark — the cloud refuses them. Marking is not
  creating: the ephemeral-namespace refusal (AC-3) governs deploys and is untouched.

## MODIFIED
(none)

## REMOVED
(none)
