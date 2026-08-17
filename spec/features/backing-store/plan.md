# Plan — backing-store (feat-001)

The spec owns WHAT and WHY; this owns HOW. Regenerating this plan later (at MVP depth) must not
require touching the validated spec.

## Design decisions

### D1 — Toolchain: no build step
TypeScript run directly by Node, type-checked separately, tested with the built-in runner.

- Run and test `.ts` sources with no compile step (verified on Node 26: `node file.ts` and
  `node --test file.test.ts` both work unaided).
- `tsc --noEmit` is the type checker only; it never emits.
- `tsconfig.json` sets `erasableSyntaxOnly: true`, which forbids the TypeScript features Node
  cannot strip (enums, namespaces, parameter properties). Without it the code type-checks and then
  fails at runtime — the flag turns a runtime surprise into a compile error.
- Test runner is `node --test`; no framework dependency.

*Why:* the constitution mandates TypeScript, and the cheapest toolchain that satisfies it is none
at all. A bundle will eventually be needed to ship a JavaScript GitHub Action, but that belongs to
the deploy-action feature, not here. Deciding it now would be deciding for a feature we have not
specified.

### D1a — `init` is a command; the deploy surface stays undecided
The constitution leaves the entry point deliberately open and asks each plan to state which surface
it targets. This feature targets **a command-line `skyhook init`**, exposed as a `bin` entry.

*Why this much and no more:* the spec's first story is "run one command that sets up everything
skyhook needs", and AC-1 says "**running** init". A function nobody can invoke does not satisfy
either — the gap only became visible when someone tried to install skyhook into a real directory
and had to write a script to do it. So this settles the surface for `init` alone.

`changes/chg-004` extends this to a second command, `skyhook bootstrap`, on the same reasoning and
with the same restraint. It applies what `init` wrote; `init` still applies nothing. Keeping them
apart is what lets `init` need no cloud credentials, be safe to re-run as a repair, and give the
maintainer a chance to read the IAM roles before they exist.

The bootstrap command is also where the trust-anchor question gets answered, because it is the only
place that can answer it: a Terraform data source for a provider that does not exist is an error
rather than an empty result, so the definition cannot probe and branch (AC-22). Shelling out to the
AWS CLI is deliberate there — it runs on an operator's machine with whatever profile or SSO session
they already have working, and reproducing that credential-resolution chain to save a dependency
would be a poor trade. Skyhook's own *runtime* path signs its own requests and takes no such
dependency.

It settles nothing about the deploy action, which is a separate feature and may well be a GitHub
Action rather than a CLI. Nothing here forecloses that: `bin/skyhook.ts` holds no logic, and
`src/cli/main.ts` parses arguments and returns an exit code rather than calling `process.exit`, so
the same `init()` remains callable from any other surface — and the CLI itself stays testable as a
plain function rather than by spawning processes.

### D2 — One registry object per environment
The registry is not a single document. Each environment is one S3 object:

```
registry/<repo>/<environment>.json          written by any run that owns the environment
protected/<repo>/<environment>              written only by the default-branch role (D2a)
state/<repo>/<environment>/terraform.tfstate
```

*Why this is the load-bearing decision:* it makes the atomic claim fall out of S3 rather than
being built on top of it. Claiming an environment is `PutObject` with `If-None-Match: *`, which
succeeds only if no object exists at that key — exactly mutual exclusion on the name (AC-5).
Updating a record is `PutObject` with `If-Match: <etag>` from the read, which fails if anything
changed since (AC-6). Two runs claiming *different* environments never contend at all, because
they touch different keys.

The single-document alternative would put every write in contention with every other and require
a retry loop around read-modify-write. The cost of this choice is that counting active
environments is a `ListObjectsV2` rather than reading one field — acceptable, and S3 list has
been strongly consistent since 2020.

Repository is a path segment, satisfying repository-scoped identity (AC-12) without a schema
change if installations later become shared.

Two small properties of the stored record follow from this and are deliberate rather than incidental.
The record carries a `schemaVersion`, because the spec calls its shape close to a one-way door and a
version field is the cheapest thing that keeps the door ajar. And a claim retries a bounded number of
times when the record it is about to classify disappears between the failed create and the read —
a record deleted by a teardown racing the claim should produce a claim, not a spurious refusal.

### D2a — Identity is derived from the trigger; IAM enforces a prefix, not a key
*(rewritten by `changes/chg-001` — the original specified a policy AWS cannot express.)*

A pull-request-triggered run never accepts an environment identity as input; it derives one
(`pr-<number>`) from the trigger. Skyhook validates this. The pull-request role's policy restricts
`s3:PutObject`/`DeleteObject` to the **ephemeral namespace** — `registry/<repo>/pr-*.json` and the
matching state prefix — and grants nothing outside it.

**Why the boundary is a prefix and not the exact key.** The obvious policy is to name
`registry/<repo>/pr-<number>.json`, and it cannot be written. IAM evaluates a permission policy
against attributes of the *principal* making the request, and the pull request number is not one of
them. For a generic OIDC provider, the token's claims are condition keys during
`AssumeRoleWithWebIdentity` — that is, in the role's **trust** policy — and they do not survive into
the session's permission evaluation. Session tags would carry an attribute across that line, but
GitHub Actions emits none. A separate role per pull request would work and does not scale. So the
narrowest static boundary available is the prefix.

**What this still buys, and it is most of it.** A pull-request run cannot reach a long-running
environment, cannot reach another repository, and cannot WRITE anywhere under the `protected/`
prefix — those are all prefix distinctions, which is exactly what a bucket policy expresses well.
*(Amended by `chg-010`: it can now READ its own repository's ephemeral marks, the constitution's
third named exception, so feat-003's teardown can honor a mark it must be able to see.)* The trust-policy
split between the pull-request role and the default-branch role is untouched and remains fully
structural: a workflow on a PR branch presents an OIDC subject the powerful role does not trust, so
editing skyhook's workflow files on the PR branch gains nothing.

**What it does not buy.** One pull request is not separated from another by the cloud. Skyhook's own
code is the only thing keeping `pr-482`'s run out of `pr-483`'s environment, and a pull request
controls that code on its own branch. This is a real gap, recorded as a sharp edge in the spec and
surfaced in the bootstrap definition's own output so an operator meets it (AC-18).

**How it could have been closed, and why it is not going to be** *(rewritten by `chg-009`; this
paragraph described a pending fix that `feat-002`'s `chg-001` withdrew)*: pin the role's trust policy
to `job_workflow_ref` naming a reusable workflow on the **default branch**, and have that trusted
workflow pass an inline session policy narrowing to `pr-<number>`. A session policy can only narrow,
and the PR branch cannot change the workflow that issues it, so the guarantee would become structural
again. **Declined, not deferred.** Only a repository collaborator can open a pull request that
deploys at all — a fork gets no credentials — so the boundary would defend against someone who
already holds write access, at the cost of depending on one cloud's handling of one CI host's
non-standard token claim. The constitution now states the gap as a decision rather than a pending
fix, and the backlog row that carried this design is closed as rejected.

**Protection is a separate object, not a field**, and this part is unaffected. `protected/<repo>/<identity>`
is written only by the default-branch role; the pull-request role is denied every write to that
prefix, and — since `chg-010`, the constitution's third named exception — granted a read confined
to its own repository's ephemeral marks, because feat-003's teardown must see a mark to honor it.
A field inside the environment record could not have been protected this way — a bucket
policy restricts which *keys* a role writes, and cannot inspect what is inside one. This is a prefix
distinction, so it is precisely what IAM does enforce (AC-15).

Moving the mark to its own key is what converts "skyhook's code refuses it" into "the cloud refuses
it". The cost is one extra read when the sweep evaluates an environment, which is the cheapest
possible price for a guarantee that survives a pull request editing skyhook's own code.

*Why:* the constitution requires that reaching another environment be **structurally impossible, not
merely disallowed**. A TypeScript guard is not structural — the pull request controls the TypeScript.
The IAM policy is, because the PR branch cannot change the trust policy that issued it. That
reasoning holds for every boundary a prefix can express, and this decision now says plainly where it
stops holding: between one pull request and another. The constitution names that case explicitly
("including other pull requests' environments"), so this deviates from a non-negotiable and needs a
constitution amendment on its own pull request before the feature rises above prototype depth — see
`od-2`.

### D2b — A record lives exactly as long as its environment
Teardown deletes the record; deletion is what frees the name. Claiming is therefore always
create-if-absent, with no state machine on top: an existing record refuses the claim regardless of
its state, reporting `held` or `awaiting-teardown` so the caller can tell the difference.

*Why:* the alternative — reusing a `released` record by flipping it back to `active` — hands a name
to a new run while the old infrastructure is still standing and possibly mid-teardown. The cost is
that a quickly reopened pull request may wait one sweep interval for its name, which is the
cheaper failure.

### D2c — A refusal and an unresolved collision are different answers
S3 answers a failed conditional write with 412, and a *collision it declined to adjudicate* with
409. They look alike and mean opposite things: 412 says the key is occupied, so the claim genuinely
lost; 409 says another writer touched the key at the same instant and establishes nothing at all.

The adapter retries a 409 with jittered backoff and, if the budget runs out, reports **`contended`**
— "unknown, try again" — never `already-exists`. Retrying is safe because the same condition is
re-sent: a repeat either lands once or is refused for the real reason, and can never apply a write
twice.

*Why it matters enough to be a decision rather than a detail:* reading a 409 as "already held"
would refuse a claim for a name nobody holds, and would do it precisely when the system is busiest.
That is a liveness failure that looks exactly like correct behaviour from the outside.

**The honest cost:** `contended` is a third outcome, and AC-5 currently says two concurrent claims
"result in exactly one success". Under sustained collision both attempts could exhaust their budget
and neither succeed. The **safety** property — never two winners — holds unconditionally; the
liveness property is best-effort. AC-5's wording should be tightened to say so before MVP depth.
At prototype it is recorded here and in the analysis rather than papered over.

### D3 — The bucket has one owner; only the registry self-heals
The bootstrap Terraform owns the storage bucket. The runtime never creates it — if it is absent,
skyhook stops and names it, because creating a bucket Terraform declares would leave Terraform with
a resource missing from its state, and the repair for that is worse than the outage.

What the runtime *does* self-heal is the registry inside the bucket, using the same
`If-None-Match` primitive as a claim. That also dissolves the first-run race the spec worried
about: two runs initializing the registry at once resolve like two claims — one wins, the loser is
told and proceeds. No lock is needed for the part that self-heals, and the part that would have
needed one is not created at runtime at all.

### D3a — The bucket has one owner; the trust anchor may already have another
*(added by `changes/chg-002`, after the first real apply.)*

An IAM OIDC provider is unique per URL per account, so skyhook cannot assume it creates one. The
bootstrap takes `create_oidc_provider`: true creates it, false reads the existing one through a data
source. Both roles reference a resolved `local.oidc_provider_arn` rather than the resource, so the
trust policies are identical either way.

*Why adopt rather than import:* `terraform import` would put the existing provider under skyhook's
management, and a later apply would then reconcile it to skyhook's declaration — rewriting the
thumbprints and client IDs of a provider that belongs to someone else. The first account this was
applied to proved the point: its provider carried another project's tags and thumbprints. Reading is
the only safe relationship with a resource skyhook does not own (AC-19).

*Why a variable rather than detection:* a data source for a provider that does not exist is an
error, not an empty result, so skyhook cannot probe for it and branch. The installer states which
case they are in. Getting it wrong fails loudly at apply time and names the cause, which is the
cheapest possible way to be wrong.

### D3b — The bootstrap's own state lives in the bucket the bootstrap creates
*(added by `changes/chg-005`, after deleting a test repo's working tree stranded real resources.)*

The bootstrap writes state describing a bucket it is itself creating, so on a first run there is
nowhere durable to put it. Terraform defaults to a local file, and that file then has two bad
futures: committed, it can leak values and conflicts on every apply; uncommitted, losing the working
tree strands resources Terraform can no longer manage. The second is not hypothetical — it happened
to the `deadweight` test repository on 2026-08-14, and only the trust anchor survived, because that
one is *detected* rather than remembered.

So `skyhook bootstrap` resolves the circle in two passes on a first run: initialize with
`-backend=false`, apply to local state, then re-initialize against the S3 backend with
`-migrate-state`. Afterwards the state is remote and every later run is a single ordinary pass. The
command tells the bucket's existence apart by asking the account, the same detect-don't-declare move
it already makes for the trust anchor — which is precisely the property that let the trust anchor
survive when the bucket did not.

Two things fall out that are worth naming. The backend uses `use_lockfile` and `encrypt`, so this
reuses D4 and D3 rather than introducing anything. And the state key is `bootstrap/terraform.tfstate`
— outside `state/`, and outside every prefix either role is granted — so nothing skyhook runs can
read the shape of its own boundary, let alone rewrite it (AC-24).

`init` writes a `.gitignore` covering `.terraform/` and `*.tfstate*` while explicitly keeping
`.terraform.lock.hcl`, which pins provider versions and belongs in review. That file is deliberately
part of *this* change rather than an earlier one: ignoring the state before it had a home would have
converted an accidental loss into a designed-in one.

### D3c — The subject a run presents is discovered, not assumed
*(added by `changes/chg-009`, after the first live deploy found every role assumption refused.)*

The trust policies pin the OIDC subject a run presents, and its **prefix is a variable**
(`subject_prefix`) rather than `repo:${var.repository}`. `skyhook bootstrap` reads GitHub's
`/repos/{owner}/{repo}/actions/oidc/customization/sub` and passes in whatever it reports, printing
which form it used before anything is applied (AC-32, AC-33).

*Why the subject at all, when immutable ids would be better:* they would, and AWS refuses them. A
trust policy for this provider that conditions on neither `sub` nor `job_workflow_ref` is rejected
with `MalformedPolicyDocument`. Ids survive a rename and a transfer where `sub` does not, and this
feature has already been bitten once by a transfer — so this is a constraint accepted, not a
preference. Only an apply reveals it.

*Why a variable rather than the conventional string:* an organization may issue **ID-qualified
subjects** — `repo:owner@26345547/name@1335111920:pull_request` — which is GitHub's defence against
a resurrection attack. `skylight-hq` is such an organization. A policy hard-coding the plain name
refuses every assumption there and explains itself with nothing but `AccessDenied`.

*Why reading a mutable setting into a security boundary is acceptable:* because it is pinned and it
fails closed. The discovered prefix is written into a static policy at apply time, so a later change
to the repository's OIDC settings stops role assumption rather than widening it, and every wrong
answer the lookup could produce — a fallback in an ID-qualified organization, a stale value, a
customized subject template — matches no identity at all. There is no value the endpoint could
return that grants more than the correct one does. The setting is writable only by a repository
admin, who already holds write access to the default branch, which is the same reasoning the
constitution uses under *Preview environments are not isolated from each other*. Recorded as AC-34,
because it is the property a reviewer would otherwise have to derive.

*Why skyhook asks rather than the operator answering:* this is the same detect-don't-declare move as
D3a's trust anchor, and for the same reason — an operator sent to find an unfamiliar string will
paste it wrong, and a wrong subject fails exactly the way a right one is meant to work. It differs
from D3a in what happens when the question cannot be answered: reading that endpoint needs repository
admin, so on a refusal skyhook falls back to the conventional form and *says which it used*. Silent
fallback would be correct in the common case and wrong in precisely the organizations that need the
answer.

### D4 — Terraform state locking without a second store
The S3 backend's native lockfile (`use_lockfile = true`, Terraform 1.10+) replaces the DynamoDB
lock table the earlier prototype used. This is what keeps the S3-only constraint honest.

**Verified against the current docs (task 6.1, 2026-08-14).** `use_lockfile` arrived in Terraform
1.10; DynamoDB-based locking is deprecated upstream and slated for removal. The lockfile is written
as `<state key>.tflock` beside the state and needs `s3:GetObject`, `s3:PutObject` and
`s3:DeleteObject` on that object — which both roles' existing `state/<repo>/…` grants already cover,
so no new permission and no second resource. The one assumption this plan carried untested is now
confirmed.

One detail worth recording, because it bears on D2: Terraform's own lockfile is implemented on **S3
conditional writes** — the same primitive skyhook's claim uses. That is corroboration rather than
proof; HashiCorp shipping a locking mechanism on this primitive is good evidence it behaves as D2
assumes, but it does not replace task 6.2's check against a real account under real contention.

### D5 — Config is fetched, not read from disk
Configuration is read through the GitHub contents API pinned to the repository's default branch,
not from the checked-out working tree — a pull-request run checks out the pull request's own code,
so reading from disk would read the attacker-controlled copy (AC-9). A single `ConfigSource`
interface is the seam, so allowing pull requests to override their own settings later is one
implementation, not a refactor.

### D5a — The bucket's name travels in the config, not in the environment
AC-4 requires a run to stop and *name* the missing bucket, so the runtime must know the bucket's
name. It comes from `.skyhook/config.yml` (`storage.bucket`, `storage.region`), read through the same
default-branch-pinned `ConfigSource` as the environment cap.

*Why not an environment variable or a workflow input:* those are set by the workflow, and a
pull-request run's workflow file is on the pull request's branch. Pointing skyhook at a bucket of the
attacker's choosing would be a one-line edit. Reading the name from the default branch closes that
without adding a mechanism — it reuses the seam D5 already needed.

*Why not derive it from the repository name:* bucket names are globally unique across all of AWS, so
a derived name is a name someone else may already hold. The operator picks it once, in the bootstrap,
and tells skyhook.

### D6 — Adapter boundary
```
src/core/        no import may reference S3, AWS, or Terraform
  types.ts       EnvironmentRecord, EnvironmentState, SkyhookConfig
  store.ts       Store interface: create-if-absent, read, compare-and-swap, list, delete
  registry.ts    claim / release / list / countActive — pure logic over Store
  config.ts      config schema, defaults, ConfigSource interface
  install.ts     desired file set, diff against actual, idempotent apply plan
src/adapters/aws/s3-store.ts        Store via conditional writes
src/adapters/github/config-source.ts ConfigSource via the contents API
src/adapters/terraform/state-key.ts  what Terraform calls its state file
src/adapters/terraform/runner.ts     driving the terraform binary
src/adapters/aws/oidc-provider.ts    does this account already federate GitHub?
src/cli/bootstrap.ts                 the bootstrap command
src/cli/destruct.ts                  removing what skyhook created
src/cli/process.ts                   the seam between skyhook and the programs it drives
src/cli/init.ts                     the init command
terraform/bootstrap/                OIDC provider, roles, bucket
tests/                              *.test.ts
```
The Terraform adapter is the newest of the three and the smallest. It exists because
`terraform.tfstate` is a fact about Terraform rather than about skyhook's registry, and holding it
in core made core name the IaC tool — which D6's own first line forbids. Core yields the state
*directory*; the adapter appends the filename. The drift audit found this (`converge.md` gap-001);
it was a defect, not a spec change, because the spec never said otherwise.

`Store` is deliberately narrow — the conditional-write primitives and nothing else — because every
method on it is a method a future non-AWS adapter must implement.

### D7 — Idempotent installation by content comparison
Init computes the desired content of every file it manages, compares against what exists, and
writes only differences, reporting each one (AC-2, AC-13). It never merges: a managed file is
restored to its desired content. Files it does not manage are never touched.

### D8 — Removal is the bootstrap run backwards, and it refuses more than it does
`skyhook destruct` removes what skyhook created. Three things shape it, and two are refusals.

**It refuses while the registry is non-empty (AC-25).** No flag overrides that, `--yes` included.
The registry is the only record of what has been provisioned, so removing it first destroys the
evidence of what still needs tearing down. A "no orphans" promise with a force flag is a
preference. This is also the seam the sweep plugs into: when environments can be torn down, that
runs here first.

**It destroys only what it manages (AC-26).** This needed no new mechanism — `chg-002` already made
an adopted trust anchor a data source rather than a resource, so it is not in state and destroy
cannot reach it. Whether skyhook created the anchor is read from `terraform state list` rather than
asked or assumed: a flag would be a second answer to a question the state already answers.

**It undoes D3b in order (AC-27).** The state lives in the bucket, destroy needs the state, and the
bucket cannot be deleted until it is empty — so: pull the state local, re-initialize without the
backend, empty the bucket, destroy. A failure after that point leaves the state on disk with a
message saying so, because at that moment it is the only record of what still exists.

Emptying is skyhook's own work rather than Terraform's: the bucket is versioned, so deleting current
versions leaves delete markers and the bucket is still not empty. `force_destroy` on the bucket
resource would have made every apply able to wipe the registry, which is too much power to leave
lying around for the sake of one command that runs once.

### D9 — The deploy contract: what this feature owes its first real writer
*(added by `changes/chg-007`, when feat-002 turned out to need eight things from a feature already
marked done.)*

Four facts this feature must now carry, one boundary it can now close, and one honest widening.

**The record gains an address, and the store gains a second count.** `EnvironmentRecord` gets
`url: string | null` — additive, so a record written before this change deserializes with `null`
rather than being rejected, because rejecting old records would strand every environment the
prototype has already recorded. `Registry` gets `countEnvironments()` **beside** `countActive()`
rather than in place of it: the sweep genuinely wants to know how many are active, and the cap
genuinely wants to know how many exist. The new one counts keys from the listing and reads no
object, which is the whole point — a deploy's credentials are narrowed to one environment, so a cap
check that reads every record cannot run at all. A record lives exactly as long as its environment
(D2b), so counting records counts environments standing in the account.

**Configuration grows by two, both optional.** `storage.account` names the account holding the
installation; a `deploy` block names where the repository's own infrastructure lives. Optional at
the top level, so an installation written by today's `init` still runs `bootstrap` and `destruct` —
only a deploy requires them, and only a deploy complains. D5a's reasoning is unchanged and now does
more work: these are settings a pull request would very much like to edit, and they are read from
the default branch for exactly the reason the bucket name is.

**D2a's KNOWN LIMIT stands, and its reasoning is not deleted.** *(Rewritten by `chg-009`. This
paragraph announced the limit as resolved by a two-piece fix — `job_workflow_ref` on the trust policy
plus a session policy issued by a trusted workflow. `feat-002`'s `chg-001` withdrew that fix before
any of it shipped, and the paragraph outlived it.)* The part of D2a that says a *permission* policy
cannot name a pull request number is still true, and every GitHub claim remains unavailable inside
the resulting session — D2a's original finding, since restated by the vendor's own documentation.
What changed is only the disposition: the two-piece fix was declined rather than built, so the limit
it would have closed is now a stated decision. The preview-to-preview boundary is open, deliberately,
and the constitution says so in its own words.

**The widening, stated plainly.** Terraform enumerates workspaces by listing the state prefix, so
the pull-request role's `ListBucket` prefix condition gains `state/<repo>/` and `registry/<repo>/`.
Every `GetObject`, `PutObject` and `DeleteObject` grant is untouched. A pull-request run gains the
ability to see that other environments exist and nothing else. The alternatives — bending the
workspace layout so no policy moves, or dropping workspaces — were weighed and rejected in feat-002's
`hs-1`, which also records the reading of the constitution this rests on: *reach* means act on, not
see.

## Verification approach

Tests live in `tests/**/*.test.ts` (added to `spec/.spec-flow.md`). Each test names its criterion's
trace token in the test name, e.g. `test('feat-001/AC-5 concurrent claims: exactly one wins', ...)`.

| Criterion | Seam | How |
| --- | --- | --- |
| AC-1 | `init()` exported from `src/cli/init.ts`, and `runCli()` in `src/cli/main.ts` | run against a temp dir, assert the created tree; drive the command itself for the "one command" half of the story |
| AC-2 | `init()` | run twice, assert every managed file byte-identical |
| AC-13 | `init()` | corrupt/delete a managed file, re-run, assert restored + reported |
| AC-3 | `terraform apply` **(manual)** | requires a real cloud account; recorded observation |
| AC-19 | Terraform source + live account | assert the create-or-adopt pair exists and that no role references the provider resource directly; confirm the adopted provider is unchanged after apply |
| AC-4 | `ensureRegistry()` in `src/core/install.ts` | fake store: registry absent → initialized and proceeds; bucket absent → stops naming it, creates nothing |
| AC-5 | `registry.claim()` | fake store, two interleaved claims, assert one wins and the loser is a distinct typed result |
| AC-6 | `registry.update()` | fake store, stale-etag write, assert refused and record unchanged |
| AC-7 | `stateDirFor()` in `src/core/registry.ts` + `terraformStateKeyFor()` in `src/adapters/terraform/state-key.ts` | assert uniqueness and no collision across repos, and that core's half never names the tool |
| AC-8 | Terraform source | parse `terraform/bootstrap/`, assert encryption, public-access-block, ACLs disabled, and the plaintext-transport deny |
| AC-9 | `ConfigSource` | assert the GitHub source requests the default-branch ref, never the head ref |
| AC-10 | `registry.countActive()` and `config.cap` | fake store with known records |
| AC-11 | `init()` output | scan every produced file for credential-shaped content. **A heuristic, not a proof** — it catches the accident it is aimed at, not a determined leak |
| AC-12 | `registry.claim()` | same identity in two repositories, assert both succeed |
| AC-14 | `identityFor(trigger)` | assert a PR trigger yields only its derived identity and refuses any supplied one. The credential half of this criterion is now AC-17 |
| AC-15 | `registry.isProtected()` / `setProtected()` + the Terraform policy | assert protection reads from its own key, and that the PR role's policy grants no write to the `protected/` prefix |
| AC-17 | Terraform source | parse `terraform/bootstrap/`, assert the PR role's policy resources are confined to the ephemeral namespace and name neither a long-running environment, another repository, nor `protected/` |
| AC-18 | `init()` output + Terraform source | assert both state the pull-request-to-pull-request limit in words an operator reads |
| AC-20 | `identityFor(trigger)` | assert 63 characters is accepted and 64 refused, at the point the identity is supplied |
| AC-21 | `bootstrap()` in `src/cli/bootstrap.ts` | injected command runner: assert the vars come from the config, that plan precedes apply, and that a declined confirmation never reaches apply |
| AC-22 | `bootstrap()` + `hasGitHubOidcProvider()` | injected runner returning each account shape: assert `create_oidc_provider` follows what the account actually holds, and that another provider is not mistaken for GitHub's |
| AC-23 | `bootstrap()` + `bucketExists()` | injected runner: assert two passes on a first run with the migration after the apply, one pass later, a stranded local state migrated, and a failed migration reported without claiming success |
| AC-25 | `destruct()` in `src/cli/destruct.ts` | injected runner with records in the registry: assert nothing is emptied or destroyed, that each environment is named, and that `--yes` does not get past it |
| AC-26 | `destruct()` + `terraform state list` | injected runner for each anchor case: assert the flag follows what is actually managed, and that `--keep-trust-anchor` removes it from management rather than destroying it |
| AC-27 | `destruct()` | assert the state is pulled before the bucket is emptied, and that an unreadable state stops the run before anything is deleted |
| AC-24 | `BOOTSTRAP_STATE_KEY` + Terraform source | assert the key sits outside every granted prefix and that no policy statement names it |
| AC-16 | `registry.claim()` | fake store with an existing record in each state; assert both refuse and the two results differ |

**The must-prove is not in that table**, and that is the point. Every row above runs against a fake
store that *implements* conditional-write semantics — which proves the logic is correct *given*
that S3 behaves as assumed. Whether real S3 honours `If-None-Match`/`If-Match` under real
contention is a separate, human-gated verification against a real account (task 6.2). If it fails,
D2 collapses and a second store returns.

## Task breakdown

See `tasks.md`.

## Deviations

**None.** D2a's prefix boundary is what the constitution now requires, rather than a deviation from
it: the pre-build check flagged the mismatch as a hard block, and it was resolved by amending the
constitution (2026-08-14, `od-2`) instead of waiving the gate. The constitution now draws the line
where a static policy can actually draw it — every long-running environment, every other repository,
every protection mark — and states in its own words that the boundary between two pull requests is
not one it draws. That wording moved once more on 2026-08-15: it had said "not structural yet", with
a note on what would close it, and now says the boundary is a deliberate choice not to defend, with
its cost stated. D2a's reasoning is unaffected and still agrees — a permission policy cannot name a
pull request number either way. What changed is that nothing is waiting on that fact any longer.

`od-1` records the human decision (option a) that got here. The declined alternative is backlog row 2.

D1 leaves the entry-point question open exactly as the constitution's tech defaults state it should.
