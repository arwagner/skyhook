# Problem brief — Long-running environments (express lane, prototype)

## Problem statement

Skyhook's mission makes two kinds of environment first-class: ones tied to a pull request's life,
and ones that run long. Everything built so far serves only the first kind. A team that wants a
staging or demo environment — one that stays up after the pull request merges — has nothing:
today every environment skyhook can create dies with a pull request, and the teardown spec says
plainly that long-running environments do not exist yet. The protection mark exists in the
product's vocabulary and is honored by teardown, but nothing creates an environment the mark was
designed for, and nothing sets the mark.

Who hurts: the maintainer of a consuming repository (first user: Andrew, from a consuming repo's
CI on the default branch) who wants one named, persistent copy of the repo's infrastructure.

## Jobs to be done (the happy path)

1. A push to the consuming repo's default branch runs a deploy step with a chosen name
   (for example `staging`).
2. Skyhook claims that name, records the environment, and applies the repo's Terraform —
   record before resource, exactly as the pull-request deploy already works.
3. The environment stays up. It is not bound to any pull request, so nothing automatic ever
   tears it down; the scheduled sweep leaves it standing.
4. A later push to the default branch updates the same environment in place.
5. When the environment should die, a human explicitly asks — a manually triggered run naming
   the environment — and skyhook destroys it through the same teardown sequence pull-request
   environments use, freeing the name.

## Success signals (must-prove)

The prototype is worth keeping if it demonstrates one thing end to end: **a default-branch run
can create and update a named environment that the sweep never destroys, and only an explicit
human action can tear it down.** Concretely: deploy `staging`, push an update, watch a sweep pass
leave it alone, then tear it down by hand and see the name freed.

## Constraints and out-of-scope (sharp edges known going in)

- **The protection mark needs a minimal, honest shape.** Who sets it and when was flagged as the
  risky part. The prototype keeps it small: a deliberate human action sets or clears the mark, and
  a marked environment refuses even the manual teardown until the mark is cleared. Anything richer
  (roles, approvals, UI) is not this feature.
- **Pull-request runs must not reach a long-running environment.** The cloud already refuses this
  (the deploy action's credential split); this feature must prove the refusal against a real
  long-running environment, not weaken it.
- **The two kinds must not collide on names.** An operator-chosen name inside the ephemeral
  namespace would let the kinds blur; it is refused.
- **No desired-state management.** The constitution imagines the sweep one day creating and
  updating long-running environments; the prototype does not go there. The sweep's only new job is
  finishing a manual teardown that died halfway.
- **No healing, no monitoring.** Nothing redeploys a long-running environment that drifted or
  whose apply failed; the remedy is the next default-branch push.
