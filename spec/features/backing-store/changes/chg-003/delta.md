# Delta — backing-store / chg-003 — say what the code actually does

> The change expressed against the current spec as explicit operations.

## ADDED

- **AC-20:** An environment identity is at most 63 characters. A longer one is refused when it is
  supplied, not when it is first used, so the refusal names the identity rather than surfacing
  later as a failure somewhere downstream.

## MODIFIED

- **AC-5 — what two concurrent claims produce** *(closes `gap-002`)*
  - Was: Two concurrent attempts to claim the same environment identity result in exactly one
    success. The losing attempt returns a result distinguishable from a failure of any other kind.
  - Now: No two attempts to claim the same environment identity both succeed, however many run at
    once. A losing attempt returns a result distinguishable from a failure of any other kind. An
    attempt the storage layer cannot resolve — because it kept colliding with other writers — is
    reported as unresolved rather than as a refusal, so a caller retries instead of concluding the
    identity is taken. Under contention it is therefore possible for a round of concurrent attempts
    to produce no winner; what is never possible is two.

- **Scenario: two runs claim the same environment identity** *(closes `gap-002`)*
  - Was: Given an environment identity that no run currently holds / When two runs attempt to claim
    it at the same time / Then exactly one claim succeeds and the other is refused with a distinct,
    non-crashing result that says the identity is already held
  - Now: Given an environment identity that no run currently holds / When two runs attempt to claim
    it at the same time / Then at most one claim succeeds, and any other is refused with a distinct,
    non-crashing result that says the identity is already held — or, if the storage layer could not
    resolve the attempt at all, one that says so and invites a retry

- **AC-8 — what protects the stored data** *(closes `gap-003`)*
  - Was: Registry data is encrypted at rest, and the storage bucket denies public access.
  - Now: Registry data is encrypted at rest. The storage the registry lives in denies public
    access, refuses unencrypted transport, and grants access only by policy — per-object access
    control lists are disabled, so there is one mechanism to read and one place to read it.

- **AC-17 — what the credentials confine** *(closes `gap-005`)*
  - Was: The credentials a pull-request-triggered run holds are refused by the cloud for every
    environment outside the ephemeral namespace — every long-running environment, every environment
    in another repository, and the protection mark of any environment whatsoever. This holds when
    skyhook's own validation is bypassed.
  - Now: The credentials a pull-request-triggered run holds are refused by the cloud for every
    environment outside the ephemeral namespace — every long-running environment, every environment
    in another repository, and the protection mark of any environment whatsoever. This holds when
    skyhook's own validation is bypassed. The credentials a default-branch run holds are likewise
    refused for anything outside the repository they belong to, so neither role can reach an
    installation that is not its own.

## REMOVED

- Nothing.
