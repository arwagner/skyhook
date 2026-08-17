# Delta — chg-002: the settings an operator supplies must survive `init`

> The change expressed against the current spec as explicit operations.

## ADDED

**Behavior — the settings file is seeded, not restored.** Skyhook writes the settings file when a
repository has none, and thereafter leaves it alone. It is the one file in an installation whose
content belongs to the operator rather than to skyhook: two of its settings — the account the
installation lives in, and where the repository keeps its infrastructure — cannot be known when it
is first written, because the bootstrap has not applied yet. Every other file skyhook installs is
skyhook's own content and is restored to it, so an installation still converges on a re-run. A
settings file skyhook writes states, in place, every setting the operator must supply and where to
get each one, so filling it in means completing a labelled blank rather than reconstructing a key
name from prose. That guarantee is about the file skyhook writes and not about one that already
exists: an installation predating a later setting learns of it when a run refuses by name, which is
the same way it learns of any setting it is missing.
A settings file skyhook cannot read is refused by name at the moment it is read, and the remedy is
to delete it and install again — skyhook does not quietly reconstruct one, because a settings file
rebuilt from defaults names a bucket that does not exist and a cap nobody chose.

- **Scenario: installing again after filling the settings in**
  - Given an installed repository whose operator has supplied the account and the infrastructure
    location in the settings file
  - When the maintainer installs again — to pick up a newer skyhook's calling workflow
  - Then the calling workflow and every other file skyhook owns is brought up to date, the settings
    file is left exactly as the operator wrote it, and the run says it was left alone rather than
    listing it as changed

- [ ] AC-20: A setting an operator writes into the settings file survives every later install.
      Demonstrated by supplying the account and the infrastructure location in an installed
      repository, installing again, and observing the file byte-identical afterwards, reported as
      left alone rather than as restored, while a file skyhook owns that was edited in the same
      breath is restored in that same run.
- [ ] AC-21: The settings file skyhook writes for a new installation names every setting the
      operator must supply, each with where its value comes from, and is a valid settings file as
      written — the settings that cannot yet be known are present and inert rather than absent, so
      supplying one means replacing a labelled blank.

## MODIFIED

None. Where the settings are read from (AC-16, the repository's default branch) is untouched — this
change is about surviving an install, not about which branch supplies the values.

## REMOVED

None from the spec. One plan decision is withdrawn rather than built: D4's optional `--account`
flag on `init`. Its own paragraph explains why it cannot work — the account id is not knowable when
`init` first runs, because the bootstrap has not applied — and once the settings file is seeded
rather than restored, the commented placeholder it was an alternative to is sufficient on its own.
