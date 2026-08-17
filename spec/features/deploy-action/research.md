# Discovery — deploy-action

> Diamond 1, divergent. Wide and deliberately unresolved; `define` narrows this to one problem
> statement. Constraints inherited from `constitution.md` and `product-global.md` are referenced,
> not restated.

## The shape of the thing

The backing store (feat-001) installed the parts skyhook remembers with: a bucket, an environment
registry, a home for per-environment Terraform state, and two roles split by trust policy. Nothing
yet writes to any of it from a real pipeline. This is the feature where a pull request on a real
repository causes a real environment to exist, and where the registry stops being a data structure
with no writers.

## User groups

- **The pull request author.** Wants never to learn skyhook exists. They push; a working
  environment appears; a link shows up on the pull request. Every mechanism below — claiming,
  workspaces, role assumption, state keys — is machinery they should never see unless it breaks,
  and when it breaks they need to know *that* it broke, not why.
- **The repo maintainer.** Wires skyhook into a workflow once. Owns the decision about what power
  skyhook gets to deploy with, and wants that decision to be reviewable code in their own
  repository rather than an ARN pasted into a settings file. Wants it to stay boring afterwards.
- **Skyhook's own automation, not yet built.** The scheduled sweep and the dashboard are downstream
  readers of whatever this feature writes. If this feature ever applies infrastructure without a
  registry record existing first, the sweep cannot find what it must destroy, and the no-orphans
  non-negotiable is broken by construction rather than by accident.
- **A hostile pull request author.** Not a user, but a party whose capabilities this feature
  changes materially. See *Risks*.

## Jobs to be done

- Give me a running copy of this branch's infrastructure, and tell me where it is.
- Update the environment I already have when I push again, rather than accumulating a new one.
- Let my repository declare what permissions a deployment needs, in the same code review as
  everything else.
- Keep the record of what exists true at every moment, including when a deploy fails halfway.
- Refuse to exceed the environment cap, rather than quietly exceeding it.

## Pain today, and the workarounds

- Teams hand-roll per-pull-request environments: a bespoke workflow, a naming convention held
  together by string interpolation, and a teardown step that runs only when the happy path
  completes. The environments that leak are the ones whose teardown never ran.
- The polished alternatives — vendor preview environments — only deploy the vendor's own stack.
  They have nothing to say about a repository whose infrastructure is arbitrary Terraform.
- The common in-house fix is one long-lived deploy credential in CI, which is precisely what the
  constitution forbids.

## What we settled while diverging

Recorded here as the current leaning, not as decided requirements. `define` and `specify` own the
commitments.

- **Scope** is one pull request getting one environment, refreshed on each push, with its URL
  handed back. Teardown-on-close and long-running environments are their own features. The
  workflow `init` scaffolds already listens for `closed` and for default-branch pushes, so this
  feature deliberately leaves parts of it unwired.
- **The consuming repo defines the role that deploys it.** Skyhook cannot guess what permissions
  another repository's Terraform needs, and should not try. The role is declared in the repo's own
  Terraform and applied by the maintainer's deliberate human step — it cannot live inside the
  per-environment apply, because the apply is the thing that needs it. Skyhook reads its ARN
  rather than being told it.
- **Environment identity rides on a Terraform workspace.** A workspace needs a name; skyhook has
  one; the repo reads `terraform.workspace` for naming and tagging its own resources. This is the
  narrow case workspaces genuinely fit — one definition, one account, one credential, N copies —
  rather than the environment-separation misuse their documentation warns about. It also removes a
  contract term, since skyhook no longer has to define and document an input variable.
- **The URL comes back as an action output; the calling workflow decides what to do with it.**
  Skyhook stays out of the pull-request-commenting business: no `pull-requests: write` in the
  permissions it asks for, no comment format to own, no update-in-place semantics. The promise
  narrows from "the pull request shows a link" to "the URL is available to the workflow", and the
  last mile becomes the consuming repo's, which the scaffolded workflow can demonstrate.
- **The test consumer is `../deadweight`** — already skyhook-initialized, currently holding only
  `.skyhook/`. It gets a deliberately trivial webapp (an S3 bucket serving a page) and its own
  workflow that calls skyhook and comments the returned link. Making deadweight a real consumer,
  rather than a harness, is what keeps the test honest.

## Constraints any solution lives inside

Inherited, referenced not restated:

- Keyless throughout; GitHub Actions by OIDC; fork pull requests get nothing and are told so
  clearly rather than failing midway.
- Privilege split by trust policy, not convention.
- Claims are atomic; two simultaneous requests never receive the same environment.
- Skyhook's own overhead — claiming, recording, reporting — stays under 60 seconds. Time spent
  applying the consuming repo's infrastructure is excluded and uncontrolled.
- Every environment skyhook provisions is in the registry, and none exists that skyhook cannot
  locate and destroy.
- Provider-specific behavior stays behind the adapter boundary. Terraform-the-tool and AWS-the-cloud
  are each one adapter, and this feature is the first real exercise of the Terraform runner seam
  that already exists in `src/cli/process.ts`.

Specific to this feature:

- **The record must precede the resource.** Any ordering where infrastructure is applied before a
  registry record exists produces an orphan the moment the apply dies between the two.
- **The environment cap is enforced here.** The backing store exposes the count and the configured
  limit; refusing to create past it is the create path's job, and this is the create path.
- **Configuration is read from the default branch, never the working tree.** Already true of
  `.skyhook/config.yml`; anything this feature adds to configuration inherits the same rule, or a
  pull request raises its own cap.

## Unknowns and risks

Ordered by how much each would reshape the feature if it turned out badly.

1. **The pull-request-to-pull-request gap stops being a data gap and becomes an infrastructure
   gap.** Today what keeps one pull request out of another's environment is skyhook's own
   TypeScript, which a pull request author can edit on their own branch; the blast radius is a
   registry record. Once a pull-request-triggered job can assume a role that creates real
   infrastructure, the same hole admits a hostile branch destroying another environment's
   resources. The fix is already written down — backlog row 2, `trusted-workflow-credentials`:
   pin the pull-request role's trust to a reusable workflow on the default branch via
   `job_workflow_ref`, and have that trusted workflow hand out credentials pre-narrowed to
   `pr-<number>` with an inline session policy. It was optional for the backing store. Whether it
   is optional here is the single biggest open question in this feature.
2. **The constitution may forbid this feature, on one reading.** *Security & compliance* says a job
   from an untrusted ref "may assume only roles scoped to the ephemeral environment itself", then
   says "Creating or destroying infrastructure requires a role whose trust policy names the default
   branch and nothing else." Read literally, no pull-request-triggered run may create anything and
   ephemeral preview environments are impossible. Read in context, "infrastructure" means skyhook's
   own bucket and roles. The wording does not distinguish them. The constitution changes only on
   its own pull request, so this needs a reading before planning, and possibly an amendment.
3. **Who guarantees the deploy role's trust policy?** If the consuming repo declares the role, the
   repo also declares what may assume it — and may declare it wrong, trusting any subject in the
   repository, or any repository at all. Skyhook reads the ARN and uses it; it does not audit it.
   Whether skyhook should refuse a role whose trust it considers too wide, warn, or stay silent is
   unresolved, and it decides whether the security posture is a property of skyhook or a property
   of each consuming repo's diligence.
4. **Workspace state layout versus the layout already shipped.** The S3 backend writes workspace
   state to `<workspace_key_prefix>/<workspace>/<key>`, while the backing store fixed per-environment
   state at `state/<repo>/<identity>/` and the pull-request role's IAM policy grants exactly
   `state/<repo>/pr-*/*` with an explicit deny on everything else. Setting the prefix to match
   should align them; if it cannot, the IAM policy of a shipped feature has to move, which is a
   change delta on the backing store rather than a detail of this one. Confirm before planning
   commits to workspaces.
5. **Partial failure is the normal case, not the exception.** Claim, apply, record, report — four
   steps, each able to die halfway, and the interesting behavior is what the registry says
   afterwards. An apply that fails partway leaves real resources behind that the environment's
   state file knows about; the record must reflect an environment that exists and is broken, never
   an environment that does not exist. What state the record lands in, and whether the next push
   retries or refuses, is unresolved.
6. **Concurrency within one pull request.** Two pushes in quick succession race for the same
   environment. The S3 backend's native lockfile serializes the Terraform state, but what skyhook
   does with the loser — wait, fail loudly, or cancel the earlier run — is a behavior choice, and
   "fails loudly" and "fails confusingly" are close neighbours here.
7. **Ownership of the scaffolded workflow.** `init` writes `.skyhook/workflow.yml`, and that file
   is the backing store's output. This feature almost certainly changes it: uncommenting the action
   call, and demonstrating the comment step now that skyhook only returns a URL. That is a change
   to a shipped feature's artifact rather than new work in this one.
8. **Does the S3 bucket in deadweight actually serve a page?** A static website endpoint needs
   public read, and the account's block-public-access posture may refuse it. If it does, the
   trivial webapp stops being trivial, and the reachability half of the success signal weakens to
   "the resource exists".

## Signals it worked

- Open a pull request on deadweight; within a couple of minutes the pull request carries a link,
  and the link serves a page.
- Push again to the same pull request; the same environment updates. No second environment appears.
- Open two pull requests at once; two distinct environments exist and the registry tells the truth
  about both.
- Kill an apply halfway; the registry still knows the environment exists, and nothing is stranded
  where a later sweep could not find it.
- With the cap set to its limit, the next pull request is refused clearly rather than silently
  exceeding it.
- A fork pull request is skipped with a plain message, not a confusing mid-run credential failure.

---

## Problem brief

> Converged from the discovery above. Where the two disagree, this brief wins: it is the committed
> reading of the problem, and the discovery is the raw material it was cut from.

### Problem statement

Pull request authors, and the maintainers who serve them, struggle to get a running and reachable
copy of a branch's infrastructure, because skyhook can record environments but cannot create one,
and because no identity in the system is both permitted to build a repository's infrastructure and
confined to a single pull request. The result is the two workarounds the product exists to replace:
a hand-rolled per-pull-request deployment whose teardown is best-effort and whose leaks are found on
the bill, or a long-lived cloud credential sitting in CI with standing power over everything.

A solution should turn a pull request into a tracked, reachable environment and refresh it on every
push — without long-lived credentials, without skyhook guessing what permissions another
repository's infrastructure needs, and without a pull request being able to reach an environment
that is not its own.

### Target users

- **The pull request author.** Pushes code and needs a link. Should never need to know that an
  environment was claimed, a workspace selected, or a role assumed. When it fails they need to know
  it failed and that the failure is skyhook's, not their code's.
- **The repo maintainer.** Wires skyhook in once and decides what power a deployment gets. Wants
  that decision to be reviewable code in their own repository, and wants no ongoing maintenance.
- **Skyhook's own automation, downstream.** The scheduled sweep and the dashboard are the eventual
  readers of everything this feature writes. What this feature records is the only thing that will
  later make teardown a guarantee rather than a hope.

### Jobs to be done

- Give me a running copy of this branch's infrastructure, and hand back where it is.
- Refresh the environment this pull request already has, rather than accumulating another.
- Let my repository declare, as code, what permissions its own deployment requires.
- Keep the record of what exists true at every moment — including when a deploy dies halfway.
- Refuse to exceed the environment cap rather than quietly exceeding it.

### The chosen shape, and why this problem over the alternatives

Two candidate problems sat in the discovery, and this brief commits to solving them together
because solving either one alone costs more than solving both now.

The first is the obvious one: *nothing deploys*. The second is that the safe way to let a pull
request deploy — credentials issued by a workflow the pull request cannot edit — was parked as
backlog row 2 during the backing store, on the grounds that it decides the calling workflow's
shape. This feature decides that shape regardless. Deferring it would mean rewriting a shipped
trust policy, the scaffolded workflow, and every consuming repo's wiring, in exchange for a
prototype shipped slightly sooner.

Folding it in also settles a live contradiction rather than working around it. The constitution
requires that creating infrastructure use a role whose trust policy names the default branch, and
read literally that forbids a pull-request-triggered environment build altogether. When the
workflow that assumes the role lives on the default branch — pinned by `job_workflow_ref`, and so
not editable from a pull request's branch — the requirement is met as written. A pull request event
triggers trusted code rather than becoming trusted itself. No amendment to the constitution is
needed, and the "touches only what it owns" guarantee returns to being structural instead of
resting on TypeScript a pull request author can edit.

### Success signals

- Open a pull request on the test consuming repository; the pull request carries a link, and an
  unauthenticated request to that link from the public internet returns a 200 with the deployed
  page.
- Skyhook's own share of the run — claiming, selecting the workspace, recording, reporting — stays
  under 60 seconds. The consuming repository's `terraform apply` is excluded and uncontrolled, so
  the total is not a criterion.
- Push again to the same pull request; the same environment updates and no second one appears.
- Close a pull request and reopen it; the environment it had comes back, rather than a second one
  appearing beside it.
- Two pull requests open at once produce two distinct environments, and the registry tells the
  truth about both.
- An apply killed halfway still leaves an environment the registry knows about and a later sweep
  could find.
- At the cap, the run fails with a non-zero exit and a message naming the cap and the current
  count, and the registry gains no record.
- A fork pull request exits successfully without deploying, having said that forks get no
  environment and why — not a credential error from the cloud.
- The maintainer who has not yet applied the deploy role definition gets told exactly that, on the
  first run, rather than a permission failure from the middle of an apply.
- Credentials reaching the apply are narrowed to one pull request's environment, and a workflow
  edited on a pull request's own branch cannot obtain wider ones.

### Constraints

Inherited from `constitution.md` and `product-global.md` — referenced, not restated: keyless
throughout; GitHub Actions by OIDC; forks unsupported by construction; privilege split by trust
policy; atomic claims; skyhook's own overhead under 60 seconds excluding the consuming repo's
apply; every provisioned environment present in the registry and destroyable; provider-specific
behavior behind the adapter boundary.

Genuine constraints on this feature, which no decision here can lift:

- **The record precedes the resource.** Any ordering that applies infrastructure before a registry
  record exists manufactures an orphan the moment the apply dies between the two.
- **The environment cap is enforced here.** The backing store exposes the count and the limit;
  refusing to create past it belongs to the create path, and this is the create path.
- **Configuration is read from the default branch, never the working tree.** Anything this feature
  adds to configuration inherits that rule, or a pull request raises its own cap.
- **This feature must extend a configuration contract it does not own.** Skyhook has to learn two
  things it has no way to know: where the consuming repository's infrastructure definition lives,
  and how to reach the deploy role. `.skyhook/config.yml` today accepts exactly `storage` and
  `environment_cap` and treats any other key as an error rather than ignoring it — deliberately, so
  a silently-defaulted setting cannot happen. So this feature adds settings to a file the backing
  store owns, parses, and reads from the default branch. That is a recorded change to a shipped
  feature, and the earliest place it can surface is here.

Decisions taken while defining the problem, which constrain the solution but remain revisitable if
planning finds them unworkable:

- **Skyhook never defines the consuming repository's infrastructure, nor the permissions it needs.**
  The repository declares the deploy role in its own Terraform, applied by the same deliberate human
  step that installs skyhook. Skyhook reads its identifier and uses it.
- **The workflow that issues credentials lives on the default branch**, pinned by `job_workflow_ref`,
  and a pull request's own branch cannot alter it.
- **Environment identity is derived from the pull request, never supplied.** Already true in the
  shipped code, and this feature is the first caller that depends on it.

### Explicitly out of scope

- Teardown when a pull request closes, and the scheduled sweep that makes cleanup true. Their own
  features; this one leaves parts of the scaffolded workflow deliberately unwired.
- Long-running environments, and protection marks.
- The dashboard.
- Skyhook posting to the pull request. The URL is handed back to the calling workflow, which
  decides what to do with it. Skyhook asks for no permission to write to a pull request and owns no
  comment format. Demonstrating the last mile belongs to the scaffolded workflow — see the open
  question about who owns that file.
- Defining the consuming repository's infrastructure, or auditing whether its Terraform is sound.
- Adapters for anything but Terraform on AWS.

### Open questions

- **Who guarantees the deploy role's trust policy is not too wide?** The repository declares the
  role, and may declare it wrong. Whether skyhook refuses, warns, or stays silent decides whether
  the security posture is a property of skyhook or of each consuming repository's diligence.
- **Does the workspace state layout line up with the layout already shipped?** The S3 backend writes
  workspace state under a prefix of its own; the backing store fixed per-environment state at
  `state/<repo>/<identity>/` and denied everything outside it in IAM. If a setting cannot reconcile
  them, the fix lands in a shipped feature rather than this one.
- **What does the registry say about an environment whose apply failed halfway**, and does the next
  push retry or refuse?
- **Two pushes racing on one pull request:** wait, fail, or supersede.
- **Who owns the scaffolded workflow now?** `init` writes it and the backing store owns it, but this
  feature changes it — the reusable workflow, the action call, the comment step. That may be a
  recorded change to the shipped feature rather than new work here. The same question covers the two
  settings this feature must add to `.skyhook/config.yml`, and both probably travel together as one
  change to the backing store.
- **How does a first-time maintainer get from installed to deploying?** The deploy role definition
  has to be written and applied before any pull request can succeed. Whether skyhook scaffolds a
  starting point for it, documents it, or merely fails clearly when it is missing decides how steep
  the first run is.
