# Proposal — chg-002: the settings an operator supplies must survive `init`

**Trigger:** Found while building the test consumer (task 6.3). `.skyhook/config.yml` is a file
skyhook *manages*, and `init` restores a managed file whole rather than merging it — deliberate,
and specified by the backing store's AC-13. But `init`'s own closing message, step 2, tells the
operator to hand-edit that same file with the account id. This feature then added a second
operator-supplied setting to it, the `deploy` block. So re-running `init` — the ordinary way to
pick up a newer skyhook's workflow — reverts both, and the next deploy fails claiming the
installation does not deploy.

Reproduced against a copy of the real `deadweight` installation rather than reasoned about:
`init` reported `restored  .skyhook/config.yml`, and `parseConfig()` afterwards read
`account: null, deploy: null`.

**Summary:** `.skyhook/config.yml` stops being a file skyhook restores and becomes one skyhook
**seeds**: created when absent, left alone when present. Every other file `init` writes —
`workflow.yml`, `deploy-role.example.tf`, the bootstrap definition, `.gitignore` — keeps being
restored, because their content is skyhook's rather than the operator's. The seeded file carries a
commented, labelled slot for every setting the operator must supply, so they fill a named blank
instead of inventing a key from prose.

## Why this lane, and not the defect lane

The plan's D4 already decided part of this: *"It takes an optional `--account`; without one it
writes a commented placeholder."* Neither half was built — task 1.2 built the config **parser**
and never touched `init`, and the task was checked off anyway. That much is a fidelity defect
against the plan.

But building D4 exactly as written would not fix this, which is why it is a change and not a
defect. The `deploy` block has no flag and no placeholder in D4 at all, so it would still be wiped
on every re-run. And a placeholder the operator fills in is *itself* a hand-edit that the next
`init` reverts to a placeholder. D4's paragraph even names the mechanism — *"`init` restores the
files it manages, so two writers would fight"* — and then rejects `bootstrap` as the second writer
without noticing that the operator is one too. The reasoning was right and stopped one step short.

So: if the code were perfect, the spec would still be wrong. Change lane. The unbuilt D4 work is
folded into this change's tasks rather than fixed separately, because this change supersedes it.

## Why seeding rather than the alternatives

- **Teach `init` to preserve certain keys.** Rejected: that is merging, which the backing store
  refused for a stated reason — *"Merging would mean guessing which half of a conflict the operator
  meant, and guessing wrong quietly is worse than overwriting loudly."* Seeding involves no guess.
- **Pass every setting as a flag (`--account`, `--deploy-directory`, …).** Rejected: the account id
  is not knowable at first-`init` time, because the bootstrap has not applied yet — the operator
  cannot pass it even if they want to. And it makes forgetting a flag on a re-run silently revert a
  setting, which is the same failure with a longer fuse. It also grows `init`'s argument list with
  every future setting.
- **Move the operator's settings to a second file skyhook does not manage.** Rejected: two settings
  files for one installation, both needing the default-branch read (AC-16), to solve a problem one
  file solves.

Skyhook already holds this exact distinction and states it: `ensureRegistry()` uses
create-if-absent for the registry marker, with a comment explaining when create-if-absent is right
and when restore is. This change puts the settings file on the side of that line it belonged on.

**What it costs.** Two things, and the second only surfaced under the pre-build check.

A corrupt `config.yml` no longer self-heals under `init`. That is a smaller loss than it sounds —
restoring it to a template naming a placeholder bucket is data loss, not healing — and skyhook
already refuses an unreadable or unknown-key config loudly at read time, which is the real safety
net. The remedy is one obvious step, and `init`'s message should name it: delete the file and re-run.

An installation that predates a **future** setting never learns about it from `init`. Under the
restore rule the new commented slot would have appeared in the file on the next re-run; under
seeding it will not, so an operator who upgrades skyhook meets the new setting when a run fails and
names it, rather than when they install. That is acceptable — the config read refuses a missing
required setting by name, which is what *Failures are loud* asks for — but it is the reason `AC-21`
is scoped to a settings file skyhook **writes** rather than to every settings file that exists. A
future setting that is genuinely required, rather than optional as both of this feature's are,
should ship with a release note; that is a process obligation this change creates and does not
discharge.

## Blast radius

- **Requirements affected:** none modified. Two added (settings survive `init`; the seeded file
  labels every blank the operator must fill). AC-16 — settings read from the default branch — is
  adjacent and unchanged: this is about surviving `init`, not about where they are read from.
- **The backing store's spec is NOT affected.** Checked rather than assumed: its AC-2 and AC-13
  speak of *"every file it manages"* and *"a hand-edited managed file"* generically, and its AC-1
  requires only that `init` create a configuration file. Nowhere does it commit `config.yml` to
  being one of the restored ones — that is a choice in `desiredFiles()`, not a promise in a spec.
  So this stays one change scoped to one feature.
- **Design decisions affected:** plan D4's *"Where the account id comes from"* paragraph. `--account`
  is dropped rather than built; the commented placeholder survives and is joined by one for the
  `deploy` block.
- **Tasks affected:** 1.2 (its unbuilt half, folded in here rather than reopened — the parser it did
  build is correct), 5.1 (init's file set and closing message), plus new tasks in a phase of its own.
- **Already-built code affected:** `src/core/install.ts` (a file needs to say whether it is seeded or
  restored), `src/cli/init.ts` (`desiredFiles`, `configDocument`, `describe`), `tests/install.test.ts`,
  `tests/cli.test.ts`.
- **The live run depends on this.** `../deadweight/.skyhook/config.yml` is hand-edited right now, and
  the next `init` there would revert it. That is exactly the hour lost mid-verification that this
  change exists to prevent.

## Status
- [x] delta reviewed (analyze)
- [x] implemented & verified
- [x] folded into the feature's spec.md (product.md regenerates; never edit it by hand)
