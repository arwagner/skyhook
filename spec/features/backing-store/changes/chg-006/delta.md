# Delta — backing-store / chg-006 — removing what skyhook created

> The change expressed against the current spec as explicit operations.

## ADDED

- **AC-25:** Removal refuses while any environment is still recorded in the registry, and names
  the environments it found. The registry is the only record of what skyhook has provisioned, so
  destroying it first would leave infrastructure standing that nothing can locate or attribute.
  No confirmation, flag, or force option overrides this: it is the "no orphans" promise, and a
  promise with an override is a preference.

- **AC-26:** Removal destroys what skyhook created and nothing else. A trust anchor skyhook
  adopted rather than created is never destroyed; one skyhook created is, unless the operator asks
  for it to be left behind because other workloads have since come to rely on it. Which case
  applies is read from what skyhook actually manages, not asked of the operator or inferred from a
  flag.

- **AC-27:** Removal cannot strand what it has not yet removed. The state describing skyhook's
  infrastructure is stored inside the storage being removed, so it is taken out first; if removal
  fails part-way, the state remains locally and the operator is told where it is and that it is now
  the only record of what still exists.

- **Scenario: removing an installation while an environment still exists**
  - Given a repository whose registry still records at least one environment
  - When the maintainer runs the removal command, even confirming it
  - Then skyhook refuses, names the environments it found, explains that removing the registry
    would leave infrastructure nobody can find, and changes nothing at all

## MODIFIED

- **User stories — a story added**
  - Was: (the stories cover installing, re-running, configuring, claiming, and recording)
  - Now: adds — As a repo maintainer, I want to remove everything skyhook put in my cloud account
    with one command, so that trying skyhook out does not leave me picking resources out of a
    console afterwards.

## REMOVED

- Nothing.
