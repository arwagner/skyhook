# Proposal — chg-010: teardown may read the protection marks it must honor

**Trigger:** feat-003 (teardown), plan D3, decided 2026-08-16 as option (a) on that feature's
`hs-1`. The cloud denied a pull-request run ALL access to protection marks, and the teardown spec
requires the close fast path to honor a mark before destroying. A refusal to read is
indistinguishable from absence, so the fast path could only fail closed and destroy nothing —
permanently. It belongs here because this feature owns the roles and the registry.

**Summary:** The constitution gains a third named exception — a pull-request run may SEE whether
an ephemeral environment of its own repository is protected, stated honestly as a repo-wide
cloud grant that skyhook's session narrowing confines to the one claimed environment. The
pull-request role's blanket `s3:*` deny on the protection prefix narrows to
everything-but-`GetObject`; a read grant and a list-prefix entry cover the repository's own
`pr-*` marks (the list entry for the same 403-versus-404 mechanics as chg-008); the
deny-outside-the-namespace statement exempts those marks so the grant survives the
intersection. Writes — setting or clearing protection — are exactly as refused as before, which
is what feat-001/AC-15 protects. The registry also gains two methods teardown needs:
`removeRecord()` (the record alone — the fast path cannot touch the protection prefix even to
delete nothing) and `listIdentities()` (identities recovered from keys alone, the sweep's
identity invariant).

**What was rejected:** leaving the deny whole and building no fast path (forfeits criteria the
teardown spec commits to), and a `workflow_run` indirection (the trusted-workflow coupling
chg-001 already declined). Recorded on feat-003's `hs-1`.
