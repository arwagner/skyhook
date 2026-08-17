# Plan — deploy-action (feat-002)

The spec owns WHAT and WHY; this owns HOW. Regenerating this plan later (at MVP depth) must not
require touching the validated spec.

Inherited and not restated: the constitution's non-negotiables and security posture,
`product-global.md`'s cross-cutting constraints, and feat-001's plan decisions D1–D8, which this
feature builds directly on top of. Where this plan changes something feat-001 shipped, it says so
and names the change (D9).

## Design decisions

### D1 — The surface is a composite GitHub Action wrapping a `skyhook deploy` command
The constitution leaves the entry point open and asks each plan to state its own. This feature
targets **both halves of one thing**: a `deploy` subcommand on the existing CLI, and an `action.yml`
at the repository root so a consuming repo can write `uses: skylight-hq/skyhook@<ref>`.

The action is **composite**, not JavaScript: it runs `actions/setup-node` pinned to a known-good
major, then `node ${{ github.action_path }}/bin/skyhook.ts deploy`. Node strips TypeScript types
natively from 22.18 (`package.json` already declares that floor), so the action ships the sources it
already has.

*Why no bundler:* feat-001's D1 chose a toolchain of none at all and predicted a bundle would be
needed "to ship a JavaScript GitHub Action". It is not — a composite action runs a command, and the
command is the CLI that already exists. Adding esbuild would introduce the project's first build
step, a `dist/` that must be committed and kept in sync, and a class of bug where the shipped
artifact and the reviewed source disagree. The cost is one `setup-node` step per run (a few seconds,
inside AC-14's budget) and a pinned Node major that has to be raised deliberately. That is the
cheaper side.

*Why the action and not only the CLI:* the calling workflow has to reference skyhook by a ref the
pull request cannot change (D2). `uses: <owner>/<repo>@<ref>` is exactly that reference, and it is
also what makes skyhook's own TypeScript stop being attacker-editable — see D3.

### D2 — One workflow file, which a pull request may edit
*Revised by `chg-001`. This decision previously scaffolded two files — an editable caller and a
trusted reusable workflow pinned by trust policy — to make the preview-to-preview boundary
structural. The constitution no longer asks for that boundary, so the indirection has no remaining
job.*

The consuming repo ends up with one file under `.github/workflows/`:

```
skyhook.yml          on: pull_request
```

It does checkout, setup-node, and one `uses: skylight-hq/skyhook@<ref>`, with
`permissions: { contents: read, id-token: write }`.

*A pull request may edit it, and that is accounted for.* Editing it grants no additional privilege:
the OIDC token a job presents carries `sub = repo:<owner>/<name>:pull_request` whichever workflow
file the job came from and whatever that file says, so the credentials reachable from a pull request
are fixed by the *trigger*, not by the file. The powerful default-branch role stays out of reach.
What editing the file *can* do is reach a sibling preview environment — skyhook's own narrowing
(D3) is what normally prevents that, and a file that declines to run skyhook declines the narrowing
with it. The constitution's *Preview environments are not isolated from each other* records that as
a decision, with its cost, and the generated file carries a comment saying so where a maintainer
will read it.

### D3 — Skyhook brokers both credentials itself, narrowing its own with an inline session policy
Inside one `skyhook deploy` run, skyhook performs two `AssumeRoleWithWebIdentity` calls of its own
and never asks the workflow to configure credentials:

1. **Skyhook's own role** (`<prefix>-pull-request`, from feat-001's bootstrap), assumed with an
   **inline session policy** narrowed so that every read, write and delete falls inside this pull
   request's environment — the registry key `registry/<repo>/pr-<n>.json` and the state prefix
   `state/<repo>/pr-<n>/*`. It also carries two of the constitution's named exceptions, and nothing
   else: listing confined to `registry/<repo>/` and `state/<repo>/` so the run can find its own
   environment and count the cap, and a read of `terraform.tfstate` at the bucket root. Both have to
   be here as well as at the role, because the run holds the intersection of the two. *(The
   constitution now names a third exception — the ephemeral protection-mark read `chg-006` added
   for feat-003's teardown sessions. The DEPLOY variant deliberately does not ask for it; AC-19
   carries the split.)*
2. **The deploy role**, assumed with a second token, for the consuming repository's own apply.

**Revised by `chg-001`.** This decision previously had two halves: a `job_workflow_ref` condition in
the pull-request role's trust policy, so that only a workflow stored on the default branch could
assume it, plus the inline session policy below. The first half is removed with the requirement it
served (AC-8), and with it the live probe that was to verify AWS honours the condition key at all.
The session policy stays, and what it is claimed to achieve changes: it prevents a skyhook run from
reaching a sibling preview environment **by accident**, not a caller who sets out to. A pull request
that declines to run skyhook declines the narrowing with it, and the constitution's *Preview
environments are not isolated from each other* says that is a decision rather than a gap.

*Why skyhook mints the credentials rather than `aws-actions/configure-aws-credentials`:*

- The workflow scaffolded into every consuming repo stays trivial — checkout, setup-node, one
  `uses:` — which matters because every consuming repo copies it and every copy is a place to get
  the narrowing wrong.
- Skyhook computes the session policy from the *same* derived identity it claims and selects the
  workspace with, so the narrowing and the claim cannot disagree. Split across two files they can.
- No dependence on a third-party action's input surface for a security boundary.

*Skyhook's code is the boundary here, and that is now the stated position.* A pull request can reach
the un-narrowed pull-request role by editing the workflow, so the narrowing holds only for runs that
actually go through skyhook. It is still worth doing: it costs one inline policy computed from the
identity skyhook already derived, and it makes the ordinary path — every honest pull request —
incapable of touching a sibling environment even when a bug in skyhook's own code would otherwise
let it. What runs after the narrowing is the consuming repository's Terraform, which is under the
pull request's control, and that is why the narrowing happens first rather than not at all.

*The residual, stated plainly:* the narrowed session can still **list** object names under
`registry/<repo>/` and `state/<repo>/`, because counting the cap and selecting a workspace both need
it. It cannot read, write, or delete any object outside its own environment. A pull request can
therefore learn *that* `pr-97` exists; it can do nothing to it. AC-7 is about operations against
another environment, and this is not one.

*The deploy role is not narrowed*, because skyhook cannot know what the repository's infrastructure
needs — the spec puts auditing it out of scope. Skyhook does pass `RoleSessionName =
skyhook-<identity>`, so the repository may condition on it and CloudTrail names the environment.

**The subject condition uses `StringEquals`, never `StringLike`.** `roles.tf` already carries the
reasoning — "a wildcard here is the classic way this trust model is lost" — and it is the condition
that now carries the whole trigger-based split on its own, so the argument applies with more force
than when it was one of two. The example deploy role scaffolded for consuming repositories follows
the same rule.

**Both sessions are short-lived.** The consuming repository's Terraform runs in the same process as
these credentials and can read both the process environment and the backend's credentials file — an
inherent consequence of letting a repository deploy itself, not a defect. What is a choice is how
long a stolen credential stays useful, so both assumptions request an explicit `DurationSeconds`
sized to a slow apply rather than taking the one-hour default. The example deploy role says so, in
the file, where a maintainer sizing their own role will read it.

### D4 — The deploy role is named by convention; its ARN is never typed into settings
The spec says skyhook "obtains its identity from that declaration rather than from a value typed
into settings". So skyhook derives it:

```
arn:aws:iam::<storage.account>:role/<deploy.role_prefix>-deploy      # default prefix: skyhook
```

The account id comes from configuration (it is a fact about the installation, like the bucket); the
role *name* follows the same `name_prefix` convention feat-001's bootstrap already uses for
`<prefix>-pull-request` and `<prefix>-default-branch`. Skyhook's own role ARN is derived the same
way, so no ARN appears in configuration at all.

*Why this reading:* the problem brief says configuration must learn "how to reach the deploy role",
and the spec says the ARN must not be typed into settings. `spec.md` is canonical where the two
disagree. Convention satisfies both: the maintainer's *decision* — what permissions the role carries
and what may assume it — stays reviewable code in their own Terraform, and skyhook learns only where
to look. A missing or unapplied role produces AC-11's message naming the exact role name expected.

*The cost:* a maintainer who names the role something else has to set `deploy.role_prefix`. That is
the same escape hatch `name_prefix` already provides for hosting two installations in one account,
so it is one concept rather than a new one. Because the two defaults live in two files and can
drift, a failed deploy-role assumption prints the full ARN it looked for, not just the role name.

**Where the account id comes from.** `init` writes the configuration before the bootstrap has
applied, so it cannot discover the account. It writes a commented placeholder, and `skyhook deploy`
names the missing setting rather than deriving a wrong ARN. The bootstrap gains an `account_id`
output so the value is one copy away, exactly as `bucket_name` and `region` already are. Having
`bootstrap` silently rewrite a file `init` owns was the alternative and is rejected: `init` restores
the files it manages, so two writers would fight.

**Revised by `chg-002`.** The optional `--account` flag this decision proposed is withdrawn rather
than built: the account id is not knowable when `init` first runs, so the operator cannot pass it
even when they want to, and a flag that must be repeated on every re-run turns forgetting it into a
silent revert. What is kept is the commented placeholder, now joined by one for the `deploy` block.

The paragraph above named the right mechanism and stopped one step short. *"`init` restores the
files it manages, so two writers would fight"* is exactly the problem — it rejected `bootstrap` as
the second writer without noticing that **the operator is one too**, invited by this very decision
to hand-edit a file `init` restores. So `.skyhook/config.yml` stops being restored and becomes
**seeded**: written when absent, left alone when present. Every other file `init` writes is
skyhook's own content and keeps being restored, so an installation still converges on a re-run.
The line this puts the settings file on is one skyhook already draws — `ensureRegistry()` uses
create-if-absent for the registry marker, and says in a comment when each rule is the right one.

### D5 — Environment identity rides a Terraform workspace, and the state layout already fits
Each environment is a Terraform **workspace** named by its identity. The consuming repository reads
`terraform.workspace` to name and tag its own resources; skyhook declares no input variable and
injects none (AC-12).

The S3 backend writes a workspace's state to `<workspace_key_prefix>/<workspace>/<key>`. Setting

```
workspace_key_prefix = state/<repo>          key = terraform.tfstate
```

yields `state/<repo>/pr-<n>/terraform.tfstate` — byte-for-byte the layout `stateDirFor()` and
`terraformStateKeyFor()` already produce, and exactly what feat-001's roles already grant objects on
(`state/<repo>/pr-*/*`, which also covers the `.tflock` beside it). Research question 4 asked
whether workspaces would force a shipped IAM policy to move. For **object** access, they do not.

They do for **listing**: Terraform enumerates workspaces with `ListObjectsV2` at prefix
`state/<repo>/`, and the shipped policy allows listing only at `state/<repo>/pr-*`. That is a real
mismatch and AC-17 anticipated it — "the policy change is a recorded change against the backing
store rather than a silent widening here". **Decided 2026-08-14 (`hs-1`, task 0.1): widen the
`ListBucket` prefix condition** to `state/<repo>/` and `registry/<repo>/`, and change nothing else.
Every object grant stays as shipped, so a pull-request run may enumerate environment names and can
still act on nothing but its own. The two alternatives — bending the workspace prefix so no policy
moves, or dropping workspaces — were rejected for filing state where `stateDirFor()` does not point
and for forfeiting AC-12 respectively; `feature.md`'s `hs-1` carries the full reasoning, including
why "reach" was read as acting on rather than seeing.

One refund stays open and nothing depends on it: if `TF_WORKSPACE` selects a workspace without
Terraform enumerating first, the state half of this widening becomes unnecessary. Task 0.3's live
session checks it in passing.

*Why workspaces at all:* they are the only mechanism that gets an environment name into arbitrary
Terraform without a contract term. Every alternative — an input variable, a generated `.auto.tfvars`,
a file the repository must read — requires the repository to declare something, which is exactly
what AC-12 forbids. This is the narrow case workspaces genuinely fit: one definition, one account,
one credential, N copies.

### D6 — One terraform run, two credential sets: backend explicit, providers by process environment
The consuming repository's Terraform runs as the **deploy role**; the S3 backend underneath it runs
as **skyhook's narrowed session**. Both in one process:

- **Providers**: the deploy role's credentials are passed as `AWS_ACCESS_KEY_ID` /
  `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` in the terraform child process's environment.
- **Backend**: skyhook's narrowed credentials are written to an ephemeral shared-credentials file
  outside the repository, and the backend is pointed at it with `-backend-config=profile=…` and
  `-backend-config=shared_credentials_files=…`, which overrides the ambient environment.

*Why the deploy role does not simply own the state too:* it would mean skyhook's bucket appearing in
a policy the consuming repository writes — skyhook's own storage boundary becoming someone else's
responsibility to get right, and a repository that writes it broadly reaching every environment's
state. Keeping the state on skyhook's narrowed session is what makes AC-7 true *of the apply*, not
merely of the steps around it.

*Why the credentials on disk are acceptable:* the consuming repository's Terraform is
attacker-controlled code running in the same job, so it can read that file. What it reads is a
session narrowed to its own environment — the same power it already has. The blast radius is
unchanged, which is the test that matters.

Skyhook writes `zz_skyhook_backend.tf` into the definition's directory declaring `terraform {
backend "s3" {} }`, and removes it afterwards.

### D6a — The pull request must not be able to move the state, and by default it can
The directory skyhook runs in holds the **pull request's own files**, and Terraform lets any
`*_override.tf` override the `terraform` block's backend settings. Skyhook's own
`src/adapters/terraform/runner.ts` uses exactly that mechanism to force a local backend, so this is
not a theoretical concern — it is a technique already proven in this codebase, available to anyone
who reads it.

Left alone, a pull request adds `zzz_override.tf` containing `terraform { backend "local" {} }`.
Skyhook initializes without complaint, the apply runs as the deploy role and creates real
infrastructure, and the state file dies with the runner. The registry record is honest and useless:
an environment exists that nothing can locate or destroy. That is the *no orphans* non-negotiable
broken by construction, and the record-precedes-resource ordering does not help, because the record
is not the thing that went missing. A variant pointing the backend at a bucket the author controls
exfiltrates whatever the state holds.

So skyhook defends the state location twice, and the second check is the one that has to hold:

1. **Before init**, refuse if the definition directory contains any `*_override.tf` /
   `*_override.tf.json`, or any `terraform { backend … }` block outside skyhook's own file. Name the
   offending file. This is a skyhook-side refusal (exit 1 per D8), not an apply failure.
2. **After init and before apply**, read `.terraform/terraform.tfstate` — Terraform's record of the
   backend it actually initialized — and assert it is `s3` at the expected bucket and key. Refuse
   otherwise.
3. **After a successful apply**, read the expected state key from the bucket through skyhook's own
   store. If nothing is there, fail loudly and name a possible orphan.

*Why three, when the first would do today:* the first is a denylist, and a denylist is only ever
correct about the tricks it knows. The second asks Terraform what it actually did, which stays true
against a mechanism nobody has thought of yet — but it reads `.terraform/terraform.tfstate`, an
internal working file with no compatibility promise, so if its shape ever changes the check does not
fail, it stops checking, which is the worse failure for a defense. The third depends on nothing but
S3 and cannot silently lapse. It runs too late to prevent the apply, which is exactly why the other
two exist; what it guarantees is that an environment whose state went missing is *reported* as
possibly orphaned rather than reported as a success. That is the weakest form of the no-orphans rule
and the one that must never be unavailable.

The first also earns its place on message quality alone: "your definition may not redirect skyhook's
state, see `zzz_override.tf`" is a far better thing for a maintainer to read than a refusal after
the fact.

*Why this is not auditing the repository's Terraform*, which the spec puts out of scope: skyhook is
not judging whether the definition is sound or what it may create. It is refusing to let the
definition relocate **skyhook's own** state, which is the one thing standing between an environment
and being an orphan.

Copying the definition somewhere skyhook controls was the third option and is rejected: it breaks
relative paths in the repository's own Terraform, and it trades a bounded check for an unbounded
class of surprises.

### D7 — Record before resource, commit after apply, and reopening is not a claim
The order in `src/core/deploy.ts` is fixed and is the requirement:

```
trigger → fork? stop → config → cap → record → deploy role → apply → commit + URL → outputs
```

**The cap is checked before the record and does not count the caller's own.** A pull request that
already holds an environment is refreshing, not creating, so the cap cannot lock it out of its own
environment (AC-9 is about a *new* pull request).

**The cap counts records, not active states — because the credentials cannot read a state.**
`Registry.countActive()` lists the registry prefix and then reads *every* object, since `active` is
a field inside each record. Under the session D3 narrows, every one of those reads except the
caller's own is denied, and the cap check fails outright — looking like a broken registry rather
than a permissions decision. The alternative, granting the session read access to every record,
would let a run read another pull request's record and contradicts AC-7 as written.

So the count comes from the listing alone: one registry key, one environment. This is not a
concession — it is arguably the truer measure. feat-001's D2b makes a record live exactly as long as
its environment does, so a `released` record is still an environment standing in the account, still
costing money, and still counting against how many a repository may hold. The change lands in
`chg-007` as a new `countEnvironments()` beside the existing `countActive()`, rather than as a
redefinition of a method other features will read: the sweep genuinely wants "how many are active",
and the cap genuinely wants "how many exist".

AC-9's refusal must then say **"environments recorded"**, never "active". One word, and it is the
difference between a true refusal and one that reads as false to anyone who has just released an
environment and can see it standing there.

**Reopening reads and updates; it does not claim.** feat-001's D2b makes `claim()` create-if-absent
with no state machine, so an existing record — `active` or `released` — refuses. That is right for
handing out a free name and wrong for a pull request returning to the environment it already owns.
So the deploy path reads first: absent → `claim()`; present and `active` → proceed; present and
`released` → `update({state:'active'})` and proceed (AC-5). No change to feat-001's registry
semantics — this is a second caller with a different question, and the identity being derived from
the trigger is what makes "is this mine?" answerable without asking.

**The recorded commit is the pull request's head SHA**, from the event payload — not `GITHUB_SHA`,
which on a `pull_request` event is the ephemeral merge commit and names nothing a reviewer would
recognise. It is written only after a successful apply, so a record naming an older commit, or none,
is exactly a record whose last deploy did not land (AC-3).

**No new environment state is introduced.** `EnvironmentState` stays `active | released`. Research
question 5 asked what the registry says about a half-applied environment; the spec answers it with
the unchanged commit, and a `failed` state would add a value every downstream reader — sweep,
dashboard, teardown — must then interpret, for information the commit already carries.

**Two pushes racing on one pull request stay unspecified, but not unexamined.** The spec leaves the
behavior open. What will actually happen is worth writing down so nobody meets it for the first time
under pressure: the S3 backend's lockfile serializes the two applies, so the second waits rather
than corrupting anything, and the loser's registry update may come back `stale` because the winner
moved the record first. Failing loudly on `stale` is the honest response — the commit that ends up
recorded should be the one whose apply actually landed last. Choosing between waiting, failing, and
superseding is MVP work, and this plan does not pretend to have chosen.

### D7a — What "skyhook's own share" includes
*Rewritten by `chg-005`. This decision previously quoted AC-14 as excluding "only the consuming
repository's apply" and then added a second exclusion of its own — a tension the code resolved in
the wrong direction and no test could see (`gap-001`). AC-14 now names both exclusions itself, so
this decision implements a criterion instead of adjudicating past one.*

AC-14 counts "deriving the identity, claiming, **selecting the environment's copy**, recording, and
reporting" as skyhook's share. Workspace selection therefore sits *inside* the measured window while
living *inside* the deployer, so `EnvironmentDeployer` returns its own split rather than one opaque
duration the use case subtracts wholesale.

**The split is three durations, not two**, because the criterion excludes two things and they are
not the same thing:

```
preparationMs   skyhook's own work inside the deployer — the hijack checks, writing the backend
                declaration, verifying what terraform initialized, selecting the workspace
initMs          `terraform init`, whole: the repository's providers and modules arriving, AND
                skyhook's own backend configuration, which the same command does and which no
                measurement here separates. Named after the command rather than after one of its
                two jobs, so the field claims only what it can support — the previous contract on
                `applyMs` asserted a boundary it did not hold, and that is `gap-001`.
applyMs         `terraform apply`: the repository's own infrastructure
```

The use case subtracts `initMs + applyMs` from wall time. Everything else lands on skyhook's side
by construction, which is the property that matters more than the field names: the figure is
computed by **subtraction**, so a step nobody remembered to instrument is still counted against
skyhook rather than silently vanishing. AC-14 states that as an outcome and leaves the mechanism
here, which is the right division — but the mechanism is the only one that delivers it, so it is
not a free choice at implementation time.

`terraform init`'s provider download falls on the **repository's** side of the line: the providers
being fetched are the repository's choice, their size is the repository's choice, and skyhook
controls neither. Counting them against skyhook's 60 seconds would make the budget a measure of
somebody else's dependency tree.

**What this concedes, said plainly.** One `terraform init` invocation does two jobs — fetching the
repository's providers, and configuring skyhook's own backend — and timing them apart means running
init twice (`-backend=false` for the providers, then again for the backend). This plan does not:
charging the whole of init to the repository leaves skyhook's backend configuration uncounted, which
is a bounded residue of a few object-store round-trips, and it adds no new surface to the one step
of this feature that has already produced two live defects. The direction is worth stating because
it is the unsafe one — skyhook under-reports itself slightly — and it is accepted because the
quantity it stops counting is unbounded and somebody else's. The two-init split stays available the
day the figure has to be defended to the millisecond.

**The criterion says this too, and that is the whole point of `chg-005`.** AC-14 draws its second
exclusion at the *step* and names the residue inside it, rather than at "fetching" alone. The
pre-build check caught the first draft doing otherwise (finding B1): a criterion excluding one job
while this decision excludes the command that does two is `gap-001` reproduced inside its own fix,
and it is the third time in this feature a criterion has enumerated less than the implementation
does. If the two-init split is ever built, the criterion narrows with it — in that order, and as a
change, never as an implementation detail that quietly makes the spec generous.

### D8 — Three exit statuses, because two kinds of failure are not the same failure
```
0  deployed, or skipped for a fork
1  skyhook could not do its job
2  usage
3  the consuming repository's own apply failed
```

AC-18 asks that the two be distinguishable "in its output and its exit status", so this is a new
code rather than a message. Exit 3 is reported as the repository's failure and says so; nothing on
that path claims skyhook is broken, and nothing on the exit-1 path blames the repository.

### D9 — What this feature changes in feat-001, as one recorded change
The spec's open question asks whether these travel together. They do, as **`chg-007`**, because they
are one story and cannot be applied independently: the trust policy requires the workflow, the
workflow requires the configuration, and the configuration is what the run reads.

| Change | Where | Why it belongs to feat-001 |
| --- | --- | --- |
| `EnvironmentRecord` gains `url: string \| null` | `src/core/types.ts`, `registry.ts` | the record's shape is feat-001's, and AC-13 writes to it |
| `Registry` gains `countEnvironments()` beside `countActive()` | `src/core/registry.ts` | the cap must count without reading each record (D7) |
| ~~`init` takes an optional `--account`~~ | ~~`src/cli/init.ts`, `src/cli/main.ts`~~ | **withdrawn by `chg-002`** — the account id is not knowable when `init` first runs, so the operator cannot pass it even when they want to, and a flag that must be repeated on every re-run turns forgetting it into a silent revert. The commented placeholder it was an alternative to does the job once the settings file is seeded rather than restored |
| Config gains `storage.account`, and a `deploy` block (`directory`, optional `role_prefix`) | `src/core/config.ts` | feat-001 owns the parser and its "unknown key is an error" rule |
| Bootstrap gains an `account_id` output | `terraform/bootstrap/outputs.tf` | so the maintainer can copy it, like bucket and region |
| ~~Pull-request role's trust adds `job_workflow_ref`~~ | ~~`terraform/bootstrap/roles.tf`~~ | **withdrawn by `chg-001`** — the boundary it closed is now a decision, not a gap. The KNOWN LIMIT block is rewritten to say so rather than deleted |
| Pull-request role's `ListBucket` prefix widens (pending `[H]` 0.1) | `terraform/bootstrap/roles.tf` | AC-17's named escape hatch — unaffected, since counting and workspace selection still need listing |
| `init` writes one workflow file and a deploy-role example, and drops the "not built yet" note | `src/cli/init.ts` | `init` owns every file it scaffolds |

Both new configuration blocks parse as **optional**. An installation written by today's `init` keeps
working for `bootstrap` and `destruct`; only `skyhook deploy` requires them, and it names what is
missing. Making them required in the parser would break two shipped commands to serve a third.

### D10 — The URL is an output skyhook reads, never a variable skyhook injects
After a successful apply, skyhook runs `terraform output -json` and reads an output named **`url`**.
It is recorded against the registry record (AC-13) and written to `$GITHUB_OUTPUT` as the action's
`url` (AC-15).

If the definition declares no `url` output, the deploy still **succeeds**: the record's URL is null
and the run says the definition declares none. Skyhook does not validate the repository's Terraform
— the spec puts that out of scope — and inventing a hard failure for a missing output would be
exactly that. AC-1's reachability is satisfied by the test consumer declaring one.

*Why an output and not a convention-free discovery:* there is no way to find "the URL" in arbitrary
Terraform without being told. An output name is the smallest possible contract, it is read rather
than injected, and AC-12 constrains only *inputs*.

The pre-build check caught this arriving first in the plan rather than in the spec — an obligation on
every consuming repository that the spec never authorized. The spec's behavior section now states it,
so this decision implements a requirement instead of inventing one.

### D11 — Where the new code lives
```
action.yml                                  composite action; the consuming repo's `uses:` target
src/core/deploy.ts                          the use case: ordering, cap, claim-or-refresh, timing.
                                              Names no cloud and no IaC tool.
src/core/ports.ts                           EnvironmentDeployer + TriggerSource, the two new ports
src/adapters/github/event.ts                GITHUB_* + the event payload → Trigger, head SHA, fork
src/adapters/github/oidc-token.ts           an id-token from the Actions token service
src/adapters/aws/sts.ts                     AssumeRoleWithWebIdentity (unsigned; no SigV4 needed)
src/adapters/aws/session-policy.ts          the narrowing policy, from repository + identity
src/adapters/terraform/environment.ts       EnvironmentDeployer over the terraform binary
src/adapters/terraform/runner.ts            + workspace select, output, backend-config, child env
src/cli/deploy.ts                           the `deploy` command: wiring and exit codes only
terraform/deploy-role.example.tf            the starting point init scaffolds. Skyhook never applies it.
```

`src/core/deploy.ts` takes ports and returns a typed outcome; it contains every decision the
constitution requires to be testable against fakes with no cloud account. Everything that knows what
STS, S3, or Terraform are sits below the line, unchanged in principle from feat-001's D6.

### D12 — How a first-time maintainer gets from installed to deploying
*Revised by `chg-006`: the example's trust now names TWO subjects — the pull-request subject this
decision describes, plus the default-branch subject feat-003's scheduled sweep presents when it
destroys what a pull-request run created. The file states what the second one costs.*

The spec's third open question. Skyhook **scaffolds a commented starting point** —
`.skyhook/deploy-role.example.tf`, a role whose trust names the pull-request subject and whose
permissions are left as a deliberate `# your infrastructure needs` blank — and **fails clearly**
when the role is absent, naming it and pointing at the example.

*Why both rather than either:* documentation alone means every maintainer hand-writes a trust
policy, and one written too wide fails silently — skyhook does not audit it. A wildcard subject in
particular would let any repository's runs assume the role. An example is the cheapest way to make
the dangerous half right by default. Scaffolding it costs nothing, because skyhook never applies it:
it is a file to copy, like `.skyhook/workflow.yml` already is.

**The order matters, and one step is easy to miss.** `chg-001` reduced this from two scaffolded
workflow files to one, which shortens the sequence without removing the trap: a workflow only runs
against a pull request once it is *on the default branch*, because that is where GitHub reads
`on: pull_request` from. So the sequence is: run `init`, apply the bootstrap, declare and apply the
deploy role, **merge the workflow to the default branch**, then open a pull request. A maintainer
who opens the pull request first sees nothing happen at all, which explains even less than a trust
refusal would. AC-11's "what the maintainer must do" therefore covers the merge as well as the role
— the missing-role message names both, because at that point skyhook cannot tell which of the two
is missing and guessing wrong sends the maintainer to the wrong file.

## Verification approach

Tests live in `tests/**/*.test.ts` (already declared in `spec/.spec-flow.md`; no change needed).
Each test names its criterion's trace token, e.g.
`test('feat-002/AC-3 a failed apply leaves the recorded commit alone', …)`.

| Criterion | Seam | How |
| --- | --- | --- |
| AC-1 | live account + `deadweight` **(manual, `[H]` 7.1)** | open a real pull request; `curl` the returned URL unauthenticated and assert 200 with the deployed content |
| AC-2 | `deployEnvironment()` in `src/core/deploy.ts` | fake store + a deployer that fails; assert the record is present afterwards and that the deployer was called after the write, never before |
| AC-3 | `deployEnvironment()` | failing deployer over a record with a known commit; assert `deployedCommit` unchanged, and null on a first deploy |
| AC-4 | `deployEnvironment()` | two runs, same identity; assert one record, same `createdAt`, new commit |
| AC-5 | `deployEnvironment()` | fake store holding a `released` record; assert it returns to `active` and no second key is written |
| AC-6 | `deployEnvironment()` + `terraformStateKeyFor()`; live pair **(manual, `[H]` 7.1)** | fakes: two identities, assert disjoint keys and no cross-read. Live: two pull requests at once, two environments, both records true |
| AC-7 | `terraform/bootstrap/roles.tf`; live **(manual, `[H]` 7.1)** | parse the source and assert the pull-request role's grants stop at the ephemeral namespace. Live: with those credentials, attempt an operation against a long-running environment, another repository's environment, and a protection mark, and observe the cloud refuse each |
| AC-19 | `sessionPolicyFor()` in `src/adapters/aws/session-policy.ts`; live **(manual, `[H]` 7.1)** | unit: the narrowing skyhook requests names only this identity's registry key and state prefix. Live: with the narrowed credentials a run actually holds, attempt a write against another pull request's key and observe the cloud refuse. Note what this does *not* claim — a caller that never asks for the narrowing never gets it (`chg-001`) |
| AC-9 | `deployEnvironment()` + `countEnvironments()` | fake store at the cap; assert exit non-zero, both numbers in the message, no key written, deployer never called, and that a pull request already holding a record is not blocked. Assert the count reads **no** record object, so it survives the narrowed session (D7) |
| AC-10 | `parseTrigger()` in `src/adapters/github/event.ts` + `deployEnvironment()` | fork payload → skip outcome; assert exit 0, no claim, no deploy, and the message says why |
| AC-11 | `deployEnvironment()` | deploy-role assumption fails; assert exit non-zero before any apply, and that the message names the expected role and the example file |
| AC-12 | `TerraformEnvironment` in `src/adapters/terraform/environment.ts` | injected runner: assert the workspace is selected by identity and that **no `-var` is passed at all**; plus the test consumer's definition reads `terraform.workspace` |
| AC-13 | `deployEnvironment()` | fake store; assert the URL from the deployer lands on the record, and survives a re-read |
| AC-14 | `deployEnvironment()` **and** `TerraformEnvironment` (`chg-005`) | injected clock. Use case: assert the figure includes the deployer's preparation split and excludes **both** its init and apply splits (D7a), and is reported at all. Adapter: assert against the REAL deployer, with a runner that burns a distinguishable amount of clock per terraform command, that `init` lands in `initMs` and the workspace selection in `preparationMs` — the use-case test is handed its split and so can never see where the boundary actually falls, which is exactly how `gap-001` survived a green suite. Live run confirms the real figure is under 60s (`[H]` 7.1) |
| AC-15 | `action.yml` + `runDeploy()` in `src/cli/deploy.ts` | parse the action manifest for the declared `url` output; assert the command writes it to `$GITHUB_OUTPUT`, and that no scaffolded workflow requests `pull-requests: write` |
| AC-16 | `parseConfig()` + `GitHubConfigSource` | assert every new setting is read through the default-branch-pinned source, and that the deploy path reads no configuration from disk |
| AC-17 | `terraformStateKeyFor()` + `TerraformEnvironment` + `roles.tf` + live **(manual, `[H]` 7.1)** | assert the workspace layout equals the shipped key layout, and that object grants are unchanged. Assert an override file in the definition directory is refused before init, and that an initialized backend which is not S3 at the expected key is refused before apply (D6a) — both with a planted fixture, since a denylist that is never fed a real trick proves nothing. Any list-prefix widening is `chg-007`, reviewed, not silent |
| AC-18 | `runDeploy()` | injected failures of each kind; assert exit 3 with the repository named for an apply failure and exit 1 otherwise, with distinct wording |
| AC-20 | `planInstall()` in `src/core/install.ts` + `init()` | on a temp tree: seed a config, hand-edit it AND a file skyhook owns, run `init` again, assert the config is byte-identical and reported left alone while the owned file is restored in the same run. The two halves are asserted together on purpose — "nothing changed" would also pass if `init` had stopped writing anything at all (`chg-002`) |
| AC-21 | `configDocument()` in `src/cli/init.ts` | feed the seeded document straight to `parseConfig()` and assert it parses, so the commented placeholders are inert rather than broken; assert each operator-supplied setting is named in it with where its value comes from |

**What the tests cannot prove**, in the same spirit as feat-001's note. Every row above that uses an
injected runner proves what skyhook *asks* Terraform and STS to do, never whether they accept it —
which is precisely the defect class feat-001's task 10.4 was bitten by. Two facts are therefore
verified live and nowhere else: that a session policy narrowed to one environment refuses another,
and that Terraform's workspace layout lands where the policy grants. `[H]` 7.1 checks both end to
end. A third — that AWS honours `job_workflow_ref` as a trust condition — was to be checked by task
0.3 before any code depended on it; `chg-001` removed the dependency, so the question is retired
unanswered rather than settled.

## Task breakdown

See `tasks.md`.

## Deviations

**None from the constitution.** *This section previously recorded a strained reading; `chg-001`
removed the strain rather than the deviation.*

The constitution used to require that "creating or destroying infrastructure requires a role whose
trust policy names the default branch and nothing else." Read literally, that forbids any
pull-request-triggered environment build — which is this entire feature. The plan satisfied the
letter by having a pull request event *trigger* trusted code without becoming trusted itself, which
is a large amount of machinery to buy agreement with a sentence.

The amended clause — *Privilege is split by what triggered the run, and the cloud enforces the
split* — says what was meant: a pull-request run gets credentials confined to ephemeral
environments, and credentials that reach anything wider are issued only to a default-branch run.
This feature does exactly that, with no reading required. Skyhook's own installation and every
long-running environment stay out of a pull request's reach, enforced by the subject claim.

The constitution's recorded exception is retired too, in the opposite direction from the one this
plan assumed. It is not closed by building the boundary; it is reclassified as a decision not to.
That amendment is already merged as this change's trigger, and `tasks.md` 7.2 records it as done.

`spec/engineering.md` does not exist in this workspace, so no shared engineering standard applies.
