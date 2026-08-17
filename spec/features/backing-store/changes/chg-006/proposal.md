# Proposal — backing-store / chg-006 — removing what skyhook created

**Trigger:** requested directly, before moving on to deployment. Also foreshadowed by the session
that produced `chg-005`: removing skyhook's resources by hand took a scripted loop over 300 object
versions, two role-policy deletions, and knowing that a versioned bucket cannot be deleted until
its delete markers are gone too.

**Summary:** `skyhook destruct` removes the infrastructure skyhook created in an account. Its
design is almost entirely dictated by two constitution clauses rather than by convenience, and both
are worth stating because they are what make it refuse things an operator might expect it to do.

**No orphans.** The registry is the only record of which environments exist and must be destroyed.
Removing it while that record is non-empty would destroy the evidence of what still needs cleaning
up — producing exactly the leaked, unattributable infrastructure the constitution forbids. So
removal refuses while any environment is recorded, and **no flag overrides it**, including `--yes`.
That refusal is also the seam the sweep and teardown work plugs into later: when environments can
be torn down, this is where that runs first.

**Skyhook touches only what it owns.** What gets destroyed is what skyhook manages, which by
construction is what skyhook created. This needed no new mechanism: the adopt-versus-create work
from `chg-002` already means an adopted trust anchor is a data source rather than a resource, so it
is not managed and cannot be destroyed. The one addition is `--keep-trust-anchor`, for an anchor
skyhook did create but that other workloads have since come to rely on.

The awkward part is `chg-005`'s success in reverse. The state describing the bucket now lives *in*
the bucket, and destroying needs the state while the bucket cannot be deleted until it is empty. So
removal brings the state home first, then empties, then destroys — the two-phase bootstrap run
backwards.

## Blast radius
- Requirements affected: three new criteria (**AC-25**, **AC-26**, **AC-27**), one new scenario,
  one new user story. Nothing existing is contradicted.
- Design decisions affected: new **D8**. D3b is reused in reverse.
- Tasks affected: none regenerated; new phase 10.
- Already-built code affected: none changed. `bucket.ts` and the Terraform runner gained methods;
  nothing existing behaves differently. `src/core/` is untouched.

## Status
- [x] delta reviewed (analyze) — re-gated after the fold
- [x] implemented & verified — 12 tests against an injected runner, plus a real check: an
      environment record planted in account 123456789012's registry produced the refusal, named the
      environment, and left the bucket and both roles intact
- [x] folded into spec.md — 2026-08-14
