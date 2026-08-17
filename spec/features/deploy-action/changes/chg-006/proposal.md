# Proposal — chg-006: the deploy surface learns the rest of the lifecycle

**Trigger:** feat-003 (teardown), plan D1/D3a/D4/D10, its scope decided 2026-08-16. It belongs
here because this feature owns the action manifest, the scaffolded workflow, the session-policy
narrowing, and the deploy-role example.

**Summary, in four pieces:**

1. **The session policy gains a teardown variant** (`readProtection` on `sessionPolicyFor`):
   the session also asks to read the ONE claimed environment's protection mark — plus its
   list-prefix entry, chg-008's 403-versus-404 mechanics — and, to stay inside the
   2048-character ceiling, drops the belt-and-braces `NoOthers` deny on that variant alone. A
   session policy is an intersection, so the drop widens nothing; the deploy variant stays
   byte-identical to what this feature shipped.
2. **The action dispatches by event**: a schedule runs `sweep`, a pull request's `closed`
   action runs `teardown`, everything else runs `deploy` — as a visible expression in
   `action.yml`, so the reviewed file says what runs when.
3. **The scaffolded workflow gains the teardown wiring**: `closed` in the pull_request types,
   the `schedule` block (15 minutes), and `pull-requests: read` for the sweep's eligibility
   lookups. `init`'s restore behavior delivers the update to installed repositories.
4. **The deploy-role example's trust gains the default-branch subject**, because the scheduled
   sweep must assume the role to destroy what a pull-request run created — with the widened
   blast radius stated plainly in the file (any holder of the default-branch subject can now
   pivot into this role).

**AC-19's "two named exceptions... and nothing further"** becomes the named exceptions with the
third present on the teardown variant and absent on the deploy variant; the criterion's text
carries the split.
