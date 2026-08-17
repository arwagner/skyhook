# Delta — chg-001: a close event ignores a carried environment name

> The change expressed against the current spec as explicit operations.

## ADDED
- AC-11: A run triggered by a pull request ignores any environment name it carries: its deploy
  derives the identity from the trigger, and its close-event teardown destroys that pull
  request's own environment and nothing else — a carried `SKYHOOK_ENVIRONMENT` changes neither.
  The manual teardown engages only on a manual dispatch, or on an `--environment` flag a human
  typed explicitly. Demonstrated by a close-event run carrying a name: the pull request's own
  environment is torn down, the carried name's environment is untouched, and the run succeeds.

## MODIFIED
(none)

## REMOVED
(none)
