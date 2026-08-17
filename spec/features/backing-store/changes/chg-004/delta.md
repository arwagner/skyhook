# Delta — backing-store / chg-004 — one command to apply the bootstrap

> The change expressed against the current spec as explicit operations.

## ADDED

- **AC-21:** A single command applies the bootstrap definition. It reads the storage settings from
  the repository's own configuration rather than asking the operator to retype them, determines
  whether the account already holds a trust anchor for the identity provider, shows the operator
  what will change, and applies only after they confirm. Without that confirmation it changes
  nothing.

- **AC-22:** The command determines for itself whether a trust anchor already exists, rather than
  asking the operator to know. Where one does, it adopts it; where none does, it creates one. An
  operator who has never seen an account's identity-provider configuration can still install
  skyhook correctly.

- **Scenario: applying the bootstrap**
  - Given a repository where skyhook is installed but nothing exists in the cloud account
  - When the maintainer runs the bootstrap command
  - Then skyhook reads the settings from the configuration, works out whether the account already
    holds a trust anchor, shows what it will create, and waits — nothing is created until the
    maintainer agrees, and declining leaves the account untouched

## MODIFIED

- **Known sharp edges — "The trust anchor costs one human step, permanently"**
  - Was: (…) An account may also already hold a trust anchor for the same identity provider,
    belonging to something other than skyhook. The installer must say which case they are in;
    skyhook cannot tell, because reading a trust anchor that does not exist is itself an error.
    Getting it wrong is loud and harmless — the apply is refused and the message names the cause.
  - Now: (…) An account may also already hold a trust anchor for the same identity provider,
    belonging to something other than skyhook. The *definition* cannot tell which case it is in —
    reading a trust anchor that does not exist is an error rather than an empty answer — so the
    command that applies it looks first and says. An operator applying the definition directly,
    rather than through that command, still has to know and say which case they are in.

## REMOVED

- Nothing. AC-1 is untouched: `init` still writes the definition **without applying it**, and that
  separation is deliberate. Applying is a second command precisely so the first one needs no cloud
  credentials, cannot half-create an account, and gives the maintainer a chance to read the roles
  before they exist.
