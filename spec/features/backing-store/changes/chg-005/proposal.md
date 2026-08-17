# Proposal — backing-store / chg-005 — the bootstrap's state gets a home

**Trigger:** the `deadweight` test repository's working tree was deleted on 2026-08-14. The bucket
and both roles still existed in AWS; Terraform no longer knew they did, and planned to create ten
resources that were already there.

**Summary:** the bootstrap writes state describing a bucket it is itself creating, so on a first run
there is nowhere durable to put it and Terraform defaults to a local file. That file has two bad
futures: committed, it can leak values and conflicts on every apply; uncommitted, losing the working
tree strands resources nothing can manage any more. This change gives it the only sensible home —
the bucket skyhook creates — by applying once with local state and then migrating.

What made the diagnosis interesting is which resource survived. The trust anchor did, because
skyhook *detects* it rather than remembering it. The bucket and roles did not, because they live in
state. Detection beat memory, and this change extends the same move: the command asks the account
whether the bucket exists rather than being told.

The `.gitignore` is deliberately part of *this* change and not an earlier one. Adding it alone would
have been the obvious fix and the wrong one: it stops the state being committed, but guarantees the
loss instead of merely permitting it. State needs a home before it needs to be ignored.

## Blast radius
- Requirements affected: **AC-1** modified (init now also states which files belong in version
  control); new **AC-23** (state durability) and **AC-24** (skyhook's own roles cannot reach the
  state describing their own permissions); one new scenario; the trust-anchor sharp edge notes that
  a direct apply gets no migration.
- Design decisions affected: new **D3b**. D3 and D4 are reused rather than changed — the backend
  uses the `use_lockfile` D4 already commits to, in the bucket D3 already owns.
- Tasks affected: none regenerated; new phase 9.
- Already-built code affected: `init` gains one managed file; `bootstrap` gains a branch. Nothing
  in `src/core/` is touched — the provider-agnostic core stays out of this entirely.

## Status
- [x] delta reviewed (analyze) — re-gated after the fold
- [x] implemented & verified — 6 new tests against an injected runner, plus a real migration:
      `deadweight`'s stranded local state moved into `s3://…/bootstrap/terraform.tfstate`
      (42 KB, AES256), the local copy emptied, and `git add -n` confirms the lock file tracked and
      no state file at all
- [x] folded into spec.md — 2026-08-14
