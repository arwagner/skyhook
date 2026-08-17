# Problem Brief — backing-store

## Problem statement
Skyhook cannot manage environments before it can remember them. A scheduled sweep can only correct
the difference between what exists and what should exist once something durably records what should
exist; an environment cap cannot be enforced without a count; a dashboard has nothing to show. Teams
adopting skyhook need that foundation to appear without running a setup project — but the trust
anchor that makes keyless cloud access possible cannot create itself, so some seam between "one
human step" and "everything after is automatic" has to be chosen deliberately rather than discovered.

## Target users
- **Repo maintainer installing skyhook** — wants one explicit setup step, then nothing to maintain.
  Reviews configuration as code alongside everything else in the repository.
- **Skyhook's own automation** — the primary reader and writer. Claim logic, the sweep, and the
  dashboard all reach the world through this store.

## Jobs to be done
- Install skyhook into a repository once, and get the cloud resources it needs to operate.
- Record and read which environments exist, what code is deployed to each, and what state each is in.
- Claim an environment identity atomically, so concurrent runs never collide on the same one.
- Hold the Terraform state for every managed environment.
- Read per-repo configuration (environment cap, infrastructure location) from the repository itself.

## Success signals
- Two runs racing for the same environment identity: exactly one wins, and the loser is told it lost.
- Installation run twice converges on the same result — no duplicate resources, no error.
- A repository with no prior skyhook goes from nothing to a working installation with one command
  and one deliberate `terraform apply`.

## Constraints
Inherited from `constitution.md` and `product-global.md` — referenced, not restated:
- S3 only, in resources skyhook defines in Terraform. A second store is added only under duress.
- Keyless: no long-lived cloud credentials anywhere, in any store or configuration.
- Everything provider-specific sits behind the adapter boundary.
- The registry is the single source of truth for what is deployed where.
- Encrypted at rest; not publicly readable.

Specific to this feature:
- **Installation is idempotent.** Unlike a tool whose init only writes local files, skyhook's
  creates cloud resources — so re-running it, or running it against a half-built account, must
  converge rather than fail or duplicate.
- **`.skyhook/` holds configuration, never state.** Recording environments in the repository would
  create a second source of truth that drifts from the registry.

## Explicitly out of scope
- The deploy action that orchestrates an environment build (its own feature).
- The sweep that reconciles environments (its own feature; this provides the record it reads).
- The dashboard (its own feature).
- Enforcing the environment cap — this feature exposes the count and the configured limit; the
  create path enforces it.
- Adapters for anything other than Terraform on AWS.

## Open questions
- Whether S3's conditional writes hold up as the atomicity primitive at real contention, or whether
  a second store returns. This is the assumption whose failure forces a redesign.
- The registry's on-disk shape is close to a one-way door — everything downstream reads it, and
  changing it later means migrating live data.
