# Delta — chg-006

## AMENDED

**AC-19** — was: "the constitution's two named exceptions are permitted at this layer as well,
and nothing further", demonstrated by inspecting one request shape. Now: the named exceptions,
with the third — the claimed environment's protection-mark read, narrowed here to one
environment where the role's grant is repo-wide — present on the **teardown variant** of the
request and absent on the **deploy variant**, which still asks for the original two alone. The
criterion's own text carries the change.

## ADDED (code, no new criteria — the behavior is feat-003's and specified there)

- `sessionPolicyFor(..., readProtection)` in `src/adapters/aws/session-policy.ts`: the
  teardown variant described in the proposal, with the worst-case ceiling check covering both
  variants in `tests/session-policy.test.ts`.
- The event dispatch in `action.yml` (verified by parsing in `tests/cli-teardown.test.ts`).
- The scaffolded workflow's `closed` type, `schedule` block, and `pull-requests: read` in
  `src/cli/init.ts` (feat-003/AC-12, on this feature's AC-20 temp-tree harness in
  `tests/install.test.ts`).
- The second trust subject and its blast-radius comment in
  `terraform/deploy-role.example.tf`.
- `AwsAccessBroker.openTeardown()` / `openSweep()` in `src/adapters/aws/broker.ts`: the two
  credential paths feat-003's plan D4 describes.

## Where it landed

Landed 2026-08-16 with feat-003's task 5.2. The constitution edit that travels with it (see
backing-store chg-010) restages every feature's pre-build check, re-run the same day.
