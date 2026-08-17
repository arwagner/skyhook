# Delta — chg-004

## ADDED

None.

## MODIFIED

- **AC-19 — what the narrowing names**
  - Was: The credentials skyhook obtains for its own registry and state work are narrowed, at the
    moment they are issued, to the single environment the run claimed, plus the one read the
    constitution's named exception permits and nothing further. Demonstrated by inspecting the
    request skyhook makes: the narrowing names this run's registry key, this run's state prefix, and
    a read of the single piece of state the infrastructure tool consults before it can be told which
    environment it is working on. That last one must appear here as well as at the role, because a
    run holds the intersection of the two and a grant one layer makes that the other denies is no
    grant at all. This is a property of what skyhook asks for, not a boundary the cloud enforces
    against a caller who declines to ask — a run that reaches a sibling preview environment by
    mistake is prevented; one that sets out to is not.
  - Now: The credentials skyhook obtains for its own registry and state work are narrowed, at the
    moment they are issued, so that every read, write and delete they permit falls inside the single
    environment the run claimed. The constitution's two named exceptions are permitted at this layer
    as well, and nothing further: the run may learn the names of the environments this repository
    holds, which is what lets it find its own copy and count the cap, and it may read the single
    piece of state the infrastructure tool consults before it can be told which environment it is
    working on. Both must appear here as well as at the role, because a run holds the intersection of
    the two layers and a grant one makes that the other denies is no grant at all. Demonstrated by
    inspecting the request skyhook makes: the narrowing names this run's registry key, this run's
    state prefix, a listing confined to this repository's own registry and state and to that same one
    key, and a read of that key. A name is not an environment and no operation on one is permitted —
    but the enumeration is granted by a condition on what may be listed where every acting grant
    names a resource, so the narrowing's own refusal covers the acting operations alone, and widening
    that condition is a change no refusal would catch. This is a property of what skyhook asks for,
    not a boundary the cloud enforces against a caller who declines to ask — a run that reaches a
    sibling preview environment by mistake is prevented; one that sets out to is not.
  - Note added at fold: the wording above changed between drafting and folding. The draft described
    enumeration as a second thing this feature permits; the constitution now names it as the first of
    its own two exceptions (amended 2026-08-16, ruling recorded below), so the criterion points at the
    constitution rather than restating it. Same substance, one source.
  - Why: the criterion describes three grants and the narrowing has always asked for four. The
    fourth is enumeration across this repository's own registry and state, without which the
    environment cap cannot be counted at all once a session is narrowed — a narrowed run may not read
    each record to count them. `hs-1` decided this widening on 2026-08-14 and `feat-001/AC-17`
    absorbed it at the role layer; the session layer, which is this feature's, was never told. The
    phrase this criterion inherited from `chg-003`, *"and nothing further"*, is the constitution's and
    is scoped there to the one-state-key exception; applied to the whole narrowing it says something
    the code has never done and should not do.

## REMOVED

None.
