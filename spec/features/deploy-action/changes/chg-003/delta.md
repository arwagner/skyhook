# Delta — chg-003

## ADDED

None.

## MODIFIED

- **AC-19 — what the narrowing names**
  - Was: The credentials skyhook obtains for its own registry and state work are narrowed, at the
    moment they are issued, to the single environment the run claimed. Demonstrated by inspecting the
    request skyhook makes: the narrowing names this run's registry key and state prefix and no other.
    This is a property of what skyhook asks for, not a boundary the cloud enforces against a caller
    who declines to ask — a run that reaches a sibling preview environment by mistake is prevented;
    one that sets out to is not.
  - Now: The credentials skyhook obtains for its own registry and state work are narrowed, at the
    moment they are issued, to the single environment the run claimed, plus the one read the
    constitution's named exception permits and nothing further. Demonstrated by inspecting the
    request skyhook makes: the narrowing names this run's registry key, this run's state prefix, and
    a read of the single piece of state the infrastructure tool consults before it can be told which
    environment it is working on. That last one must appear here as well as at the role, because a
    run holds the intersection of the two and a grant one layer makes that the other denies is no
    grant at all. This is a property of what skyhook asks for, not a boundary the cloud enforces
    against a caller who declines to ask — a run that reaches a sibling preview environment by
    mistake is prevented; one that sets out to is not.
  - Why: the criterion was written before the exception existed and says the narrowing names "no
    other". It has named one other since `feat-001`'s `chg-008`, which is what made the first deploy
    of a new environment possible at all. Both the constitution and `feat-001/AC-29` now require
    exactly this of every layer that narrows a run's reach; this criterion was the one place still
    saying otherwise.

## REMOVED

None.
