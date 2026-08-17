# Delta — backing-store / chg-005 — the bootstrap's state gets a home

> The change expressed against the current spec as explicit operations.

## ADDED

- **AC-23:** After the bootstrap has been applied once, the state describing what it created lives
  in skyhook's own storage rather than in the maintainer's working tree. Deleting or re-cloning the
  repository does not strand the resources it created: a later run finds the state where it left
  it. The maintainer is never asked to commit that state to version control.

- **AC-24:** No role skyhook installs can read or write the state describing skyhook's own
  permissions. That state is reachable only by the credentials a maintainer uses to apply the
  bootstrap, so a compromise of anything skyhook runs cannot read the shape of its own boundary or
  rewrite it.

- **Scenario: the installation outlives the working tree**
  - Given a repository whose bootstrap has been applied, and whose local working files are then
    deleted
  - When the maintainer re-installs and runs the bootstrap command again
  - Then skyhook finds the existing state, reports that nothing needs to change, and manages the
    resources it created before — rather than trying to create a second copy of them

## MODIFIED

- **AC-1 — what init produces**
  - Was: Running init in a repository with no prior installation creates `.skyhook/` containing a
    configuration file and the workflow that calls skyhook, and writes the bootstrap infrastructure
    definition without applying it.
  - Now: Running init in a repository with no prior installation creates `.skyhook/` containing a
    configuration file, the workflow that calls skyhook, and a statement of which of its files
    belong in version control, and writes the bootstrap infrastructure definition without applying
    it.

- **Known sharp edges — "The trust anchor costs one human step, permanently"**
  - Was: (…) An operator applying the definition directly, rather than through that command, still
    has to know and say which case they are in.
  - Now: (…) An operator applying the definition directly, rather than through that command, still
    has to know and say which case they are in — and gets no state migration either, so their
    state stays local and is theirs to look after.

## REMOVED

- Nothing.
