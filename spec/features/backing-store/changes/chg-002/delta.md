# Delta — backing-store / chg-002 — the trust anchor may already exist

> The change expressed against the current spec as explicit operations.
>
> Note on ordering: this delta was written after the change was already built and applied, because
> the gap was found by applying the bootstrap rather than by reading it. The build is what proved
> the requirement, so the delta records it rather than proposing it.

## ADDED

- **AC-19:** Skyhook never modifies an OIDC trust anchor it did not create. Where one already
  exists in the target account, the bootstrap reads it and points skyhook's own roles at it,
  leaving its configuration — including its thumbprints and client IDs — untouched, so workloads
  already trusting it are unaffected.

## MODIFIED

- **AC-3 — what applying the bootstrap produces**
  - Was: Applying the bootstrap definition to a cloud account creates the OIDC trust anchor, the
    roles skyhook assumes, and one storage bucket. Applying it a second time reports no changes.
    (manual)
  - Now: Applying the bootstrap definition to a cloud account results in an OIDC trust anchor, the
    roles skyhook assumes, and one storage bucket. The trust anchor is created where none exists
    and adopted where one does, because a cloud account admits only one trust anchor per identity
    provider. Applying it a second time reports no changes. (manual)

- **Known sharp edges — "The trust anchor costs one human step, permanently"**
  - Was: Keyless access to a cloud account cannot bootstrap itself; the OIDC provider and roles
    require credentials that do not yet exist. This is a property of the trust model, not a gap to
    close later.
  - Now: unchanged in substance, plus — an account may already hold a trust anchor for the same
    identity provider, belonging to something other than skyhook. The installer must say which case
    they are in; skyhook cannot tell, because reading a trust anchor that does not exist is itself
    an error. Getting it wrong is loud and harmless: the apply is refused, and the message names
    the cause.

## REMOVED

- Nothing.
