# Delta — chg-008

## ADDED

**One key outside the ephemeral namespace is readable, and it is named.** Both roles may read the
single object the infrastructure tool insists on consulting before it can be told which environment
it is working on. It is one object, not a prefix; it may be read and never written; and skyhook puts
nothing in it. Every other boundary is unchanged: a pull-request run still reaches no long-running
environment, no other repository's data, and no protection mark.

- [ ] AC-29: A pull-request run may read the single state key the infrastructure tool consults
      before a workspace is selected, and nothing else outside the ephemeral namespace. Demonstrated
      by attempting, with those credentials, a read of that key (permitted), a write of that key
      (refused), and a read of a neighbouring key at the same level (refused).

## MODIFIED

- **What a pull-request run is refused**
  - Was: everything outside this repository's ephemeral namespace.
  - Now: everything outside this repository's ephemeral namespace, except a read of the one state
    key the infrastructure tool consults before it can be told which environment it is working on.
    That key holds nothing skyhook wrote.

## REMOVED

None.
