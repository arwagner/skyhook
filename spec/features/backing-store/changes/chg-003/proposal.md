# Proposal — backing-store / chg-003 — say what the code actually does

**Trigger:** the first drift audit (`converge.md` run 1). Routed from `gap-002`, `gap-003`,
`gap-004` and `gap-005`.

**Summary:** four of the five gaps the audit opened are the spec being out of step with a build
that is itself correct. One is an over-promise; three are behaviours the build added without any
artifact asking for them. None is a defect — the code does the right thing in every case — so the
remedy is to make the spec describe it rather than to change the code.

`gap-001`, the fifth, was a genuine defect and is fixed separately in the defect lane: the
provider-agnostic core no longer names Terraform in a storage key. It needs no delta because the
spec was already right.

The over-promise is the one that matters. AC-5 says two concurrent claims "result in exactly one
success". Since the adapter learned to tell a refused conditional write (412) from a collision the
store declined to arbitrate (409), an exhausted retry budget can end a round with **zero** winners.
The safety property — never two winners — holds unconditionally and is now proven against real S3
under 950 concurrent claims. Liveness is best-effort. A specification that claims a stronger
guarantee than the system provides is the more dangerous kind of wrong even when, as here, it errs
toward caution: someone will one day build on the sentence rather than the system.

The three unrequested behaviours are all defensible and all stay. Legitimizing them costs three
sentences and means the next audit finds them accounted for rather than novel.

## Blast radius
- Requirements affected: **AC-5** (modified — narrowed to the safety property, with the
  indeterminate outcome named); the *two runs claim the same identity* scenario (modified to
  match); **AC-8** (modified — absorbs the transport and access-control hardening); **AC-17**
  (modified — the privileged role's own confinement); one new criterion **AC-20** (the identity
  length bound).
- Design decisions affected: none. D2c already records the liveness trade; this is the spec
  catching up to it.
- Tasks affected: none regenerated. The behaviour exists and is tested; what changes is the
  requirement that authorizes it.
- Already-built code affected: none, apart from a comment explaining where 63 comes from.

## Status
- [x] delta reviewed (analyze) — re-gated after the fold
- [x] implemented & verified — the behaviour was already built; this authorizes it
- [x] folded into spec.md — 2026-08-14
