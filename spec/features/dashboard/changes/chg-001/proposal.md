# Proposal — dashboard / chg-001 — the detail view shows the recorded inputs

**Trigger:** feat-001 `chg-011`, part of the declared-deploy-inputs change (dtak-prototype
adoption analysis, 2026-08-17). The environment record gains the recorded values of its declared
deploy inputs — an image tag, an artifact URI. The dashboard's detail view promises the **full**
registry record and enumerates its fields; a new field makes that enumeration stale the moment it
exists, and the operator question the field answers — "which image is this environment actually
running?" — is exactly the kind the dashboard exists for.

**Summary:** one addition. The detail view's enumeration gains the recorded deploy inputs, shown
when the record carries any and absent otherwise — not a pending placeholder, because unlike the
URL and the commit, no later step fills them in; a record without them simply never declared any.
The list view is unchanged: inputs are detail, not scanning material, and the list's promise
("lists nothing the registry does not record") already permits showing less than everything.

## Blast radius
- **Build ordering (added after the pre-build check):** nothing in Phase 4 is built before
  `product-global.md`'s privacy enumeration names declared deploy input values — feat-001's
  od-3, its own main-branch commit.
- Requirements affected: the *one environment's detail* scenario and **AC-4** (both enumerate the
  full record — each gains the recorded inputs, with escaping and non-linkification stated), the
  pending-placeholder scenario (scoped to URL/commit so the two rules cannot be read as
  conflicting), and one new Known sharp edges entry (the widened audience). AC-1 (the list view)
  and AC-6 are deliberately untouched.
- Design decisions affected: none new — D5's field enumeration and hostile-content rule gain the
  new field (a factual extension, not a new decision).
- Tasks affected: none regenerated; one item, built with the rest of the declared-inputs branch.
- Already-built code affected: `src/core/dashboard.ts` (render the field in the detail view),
  `tests/dashboard.test.ts`.

## Status
- [x] delta reviewed (analyze) — 2026-08-17, two rounds: blocking-hard on the security findings,
      remediations folded into the delta the same day, re-gate pass
- [x] implemented & verified — 2026-08-17, in the joint declared-inputs build, test-first;
      every task checked off with its trace token
- [x] folded into spec.md — 2026-08-17
