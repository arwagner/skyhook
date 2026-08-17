# Delta — chg-010

## AMENDED

**AC-17** — was: refused for every operation on "the protection mark of any environment
whatsoever", permitting the names, the single state key, "and nothing else outside the
namespace". Now: refused for every WRITE to any protection mark; additionally permits reading
the protection marks of this repository's own ephemeral environments (the constitution's third
named exception, added by feat-003); a long-running environment's mark stays unreadable, and
setting or clearing any mark stays refused. The criterion's own text carries the change.

## ADDED (code, no new criteria)

- `Registry.removeRecord()` — teardown's fast-path removal: the record alone, the marker
  untouched. Safe because a marked environment never reaches removal (teardown refuses it at
  the protection check), so the record removed this way has no marker. Unit-covered in
  `tests/registry.test.ts`.
- `Registry.listIdentities()` — identities recovered from registry KEYS alone, never from
  record bodies. The sweep iterates these; a body is writable by the run that owns it, so a
  body-derived identity could steer a destroy at another environment (feat-003 plan D2).

## Where it landed

`spec/constitution.md` (the third exception, its cost, and the touches-only-what-it-owns
clause), `terraform/bootstrap/roles.tf` (`DenyAllButReadingProtectionMarks`,
`ReadEphemeralProtectionMarks`, the list-prefix entry, the deny-outside exemption),
`src/core/registry.ts`, `tests/bootstrap-terraform.test.ts`, this spec's AC-17. Landed
2026-08-16 with feat-003's task 5.2; the shared-file edit restages every feature's pre-build
check, re-run the same day.
