# Proposal — backing-store / chg-004 — one command to apply the bootstrap

**Trigger:** applying the bootstrap by hand, twice, in one afternoon. Both attempts failed first on
things the operator should not have had to know: the two commands pasted into one, the `-var`
spacing, no default AWS profile, and — the real one — an existing trust anchor the definition
cannot detect for itself.

**Summary:** the definition `init` writes needs four `-var` flags, an AWS profile in the
environment, and one flag whose correct value depends on a fact about the account the operator has
to go and look up. Every one of those is knowledge skyhook already has or can get. `skyhook
bootstrap` reads the storage settings from `.skyhook/config.yml`, derives the repository from the
git remote, asks the account whether a trust anchor already exists, shows the plan, and applies
only on a yes.

The trust-anchor detection is the part that earns the command rather than a README. Terraform
genuinely cannot do it: a data source for a provider that does not exist is an error, not an empty
result, so the definition cannot probe and branch. Something outside it has to look first. Without
that, `create_oidc_provider` is a flag whose correct value an operator can only discover by having
an apply fail.

**Why this is not part of `init`.** AC-1 requires that `init` writes the definition *without*
applying it, and that separation is load-bearing rather than incidental. `init` needs no cloud
credentials, cannot half-create an account, and is safe to re-run as a repair — all three would be
lost by fusing an apply into it. It is also the maintainer's one chance to read the IAM roles
before those roles exist, and since the entire security model of this product is those policies,
that reading is not ceremony.

## Blast radius
- Requirements affected: two new criteria, **AC-21** (one command, settings from configuration,
  nothing without confirmation) and **AC-22** (the command determines the trust-anchor case
  itself); one new scenario; the *trust anchor* sharp edge modified, since the "installer must know
  which case they are in" caveat now applies only to someone applying the definition directly.
  **AC-1 is untouched.**
- Design decisions affected: **D1a** extended — it settled the surface for `init`; this settles it
  for `bootstrap` on the same reasoning, and still says nothing about the deploy action.
- Tasks affected: none regenerated; new phase 8.
- Already-built code affected: none changed. `runCli` became async to host an async command, and
  the existing tests moved with it; no behaviour changed.

## Status
- [x] delta reviewed (analyze) — re-gated after the fold
- [x] implemented & verified — 12 tests against an injected runner, plus two real runs against
      account 123456789012: a first that applied, and a second that detected the existing trust
      anchor and reported no changes
- [x] folded into spec.md — 2026-08-14
