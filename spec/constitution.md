# Constitution — Skyhook

> The non-negotiable principles every spec, plan, and task in this project must respect.

## Mission
Skyhook makes a repository's infrastructure-as-code deployable as managed, disposable
environments. A repo supplies the definition (Terraform describing AWS infrastructure to start,
with other tools and providers pluggable); skyhook supplies the automation that stands copies up,
tracks which code is deployed to which environment, optionally caps how many exist, and reliably
tears them down. An environment may be tied to the life of a pull request or may run long — both
are first-class, and neither is the special case.

## Non-negotiables
- **No orphans.** Every environment skyhook creates is tracked and destroyable. Teardown is a
  guarantee, not best-effort: no code path may provision a resource it cannot later locate and
  destroy. A leaked environment is a leaked bill.
- **Provider-agnostic core.** Terraform-specific and AWS-specific logic lives behind the plugin
  boundary. Skyhook's own modules never import a provider SDK or special-case a provider by name.
  This document holds itself to the same rule: every guarantee below is stated as an outcome a
  reader can check — what a run may reach, what the cloud refuses — never as the provider mechanism
  that happens to deliver it. A rule written in one cloud's vocabulary is a rule a second adapter
  has no way to satisfy, and it hides which of the two is actually non-negotiable: the guarantee,
  or the machinery that currently keeps it.
- **Skyhook touches only what it owns.** Skyhook may create, modify, or destroy only environments
  it provisioned. A run triggered by a pull request may reach no long-running environment, no
  environment belonging to another repository, and no environment's protection mark: the cloud
  refuses those, so the rule holds whatever skyhook's own code does or fails to do. To reach means
  to act on — such a run may learn the *names* of the environments its own repository holds, and
  may see whether an ephemeral one of them is protected, and may do nothing whatever to them. *A
  pull-request run is refused everything outside the ephemeral namespace* under *Security &
  compliance* states those exceptions and what each costs.
  Between two ephemeral environments the boundary is skyhook's doing rather than the cloud's —
  *Preview environments are not isolated from each other* below says why that is a deliberate choice
  and what it costs.
- **Destruction of a protected environment is never automatic.** An environment may be marked
  protected. The scheduled sweep may create and update a protected environment but never destroys
  one; teardown there requires an explicit human action. Absence of evidence that an environment
  should exist is not evidence that it should be destroyed.
- **A scheduled sweep is what makes cleanup true.** A recurring job compares the environments that
  actually exist against the record of what should exist and corrects the difference. Event hooks
  — a pull request closing, a teardown command — are a fast path only; correctness may never
  depend on one firing. Any event that is missed, interrupted, or tampered with must be repaired
  by the next scheduled pass without anyone noticing it failed.

## Tech & architecture defaults
Deviations are allowed but must be called out explicitly in the plan that introduces them.
- **Languages / frameworks:** TypeScript for skyhook's own logic; Terraform for infrastructure
  skyhook itself defines.
- **Architecture style:** a provider-agnostic core with adapters at the edges — the IaC tool
  (Terraform first) and the cloud provider (AWS first) each sit behind a plugin boundary.
- **Entry point:** deliberately open. Whether skyhook is a standalone CLI that CI invokes, a
  GitHub Action only, or both, is decided per feature as the pieces are built; the core is
  structured so the choice stays reversible, and each plan states which surface it targets.
- **Data & integration defaults:** skyhook stores its own data — the environment registry and the
  Terraform state backend — in AWS resources that skyhook defines in Terraform. Start with S3
  alone and add a second store only when a requirement forces it. This store sits behind the same
  plugin boundary, so a non-AWS target can supply its own.

## Security & compliance
- **Keyless.** Skyhook authenticates to the cloud through workload identity federation — the CI
  host's OIDC token, exchanged for short-lived scoped credentials. It never requires, stores, or
  accepts long-lived cloud access keys.
- **Privilege is split by what triggered the run, and the cloud enforces the split.** A run
  triggered by a pull request obtains credentials confined to ephemeral environments. Credentials
  that reach anything wider — skyhook's own installation, a long-running environment — are issued
  only to a run triggered from the default branch. The split rests on the identity the CI host
  asserts about the *trigger*, which no file in the repository can alter: a pull request that
  edits skyhook's workflows, or anything else, still runs as a pull request and is still offered
  only the narrower credentials. That is what makes the split worth its complexity, and why it
  does not rest on skyhook's code being careful.
- **A pull-request run is refused everything outside the ephemeral namespace, with three named
  exceptions.** The credentials a pull request can reach are denied every long-running environment,
  every environment belonging to another repository, every write to any environment's protection
  mark, and anything skyhook did not provision — denied by the cloud, on every request, whether or
  not skyhook thinks to ask. This is the enforcement behind *Skyhook touches only what it owns*. An
  adapter may satisfy it however its provider expresses a refusal; what an adapter may not do is
  satisfy it by having skyhook decline to make the call.
  Every refusal above is about what a run may **do** to an environment. To see that an environment
  exists is not to reach it, and the three exceptions below are the places that distinction is load
  bearing. All are written down because an unnamed exception is indistinguishable from a leak.
  **First, a run may learn the names of the environments its own repository holds.** The names and
  nothing else, and only for the repository the run belongs to. A run needs them to find its own
  environment and to count how many exist against the cap, and neither question can be answered one
  environment at a time by a run confined to a single one. No operation on a named environment
  follows from having seen its name: every refusal in the paragraph above stands untouched, and a
  long-running environment a run can name is a long-running environment that same run cannot read,
  change, or destroy.
  **Second, a run may read the single piece of state an infrastructure tool insists on consulting**
  before it can be told which environment it is working on. One object, never a prefix; readable and
  never writable; and skyhook neither writes it nor uses what it would hold. It is granted for one
  reason only — so that an object which has never existed answers *not there* rather than *refused*,
  a distinction some storage declines to make to a caller who could not also have listed it, and
  which the tool has no way to work around.
  **Third, a run may see whether an ephemeral environment of its own repository is protected.**
  Reading the mark, never writing one — setting and clearing protection stay refused by the cloud
  exactly as before. It is granted because teardown must honor a mark before destroying, and a
  refusal to read one is indistinguishable from its absence: a run that cannot see the mark can
  only fail closed and destroy nothing, which would make the close event's teardown permanently
  decorative. Stated honestly, because the honest shape is the whole point of naming exceptions:
  what the cloud enforces is repo-wide — a pull-request run's credentials may read the protection
  status of every ephemeral environment its repository holds — and narrowing that to the one
  environment the run claimed is skyhook's own session narrowing, the same guardrail-not-boundary
  that already confines its registry and state reach.
  Every layer that narrows a run's reach must permit exactly these three things and nothing
  further. The reason is the same for all: a run holds the intersection of every layer that
  narrows it, so a grant one layer makes that another denies is no grant at all, and an exception
  stated once is an exception that does not work.
  What the first costs, said plainly: a run started by a pull request can learn that a long-running
  environment exists and what it is called. Names carry information — a customer, a codename, the
  fact that production lives here. A repository that cannot afford to disclose that should not
  encode it in an environment name.
  What the second costs, said plainly: nothing today, because nothing writes that object. It would
  begin to cost something the moment any skyhook feature applied real infrastructure into the unnamed
  default an infrastructure tool falls back to. That is the change to refuse — not this line of
  policy.
  What the third costs, said plainly: a pull request can learn which of its repository's preview
  environments a human marked protected — a hint about which one is load-bearing. It learns
  nothing about long-running environments' marks, which stay refused outright, and it still
  cannot touch what the mark protects: destruction of a protected environment is refused to the
  run by the mark itself being honored, and the mark's write stays the cloud's to refuse.
- **Preview environments are not isolated from each other, by decision.** Skyhook keeps one pull
  request's run out of another's environment, and narrows each run's credentials to the single
  environment it claimed — but that is a guardrail against accident, not a boundary the cloud
  enforces, and a determined pull-request author can reach a sibling preview. This is a choice, not
  a gap. Only a repository collaborator can open a pull request that deploys at all — fork pull
  requests are issued no credentials, which is a property of how the CI host mints tokens rather
  than a setting — so the boundary would be defending against someone who already holds write
  access and has blunter instruments to hand. Making it structural costs a trusted-workflow
  indirection plus a dependency on one cloud's handling of one CI host's non-standard token
  claims, which is the coupling *Provider-agnostic core* exists to keep out.
  What the choice costs, said plainly so that nobody has to discover it: infrastructure state holds
  resource attributes in the clear, including any credential the infrastructure generates for
  itself. A repository whose preview environments mint real secrets should know that a sibling
  preview can read them. Nothing outside the ephemeral namespace is affected — those boundaries are
  the cloud's to enforce and this clause does not touch them.
- **Forks get no environment.** GitHub grants fork pull requests no id-token, so no role can be
  assumed; skyhook detects the fork and skips with a clear message rather than failing confusingly
  midway. `pull_request_target` is never used to work around this: it runs the base branch's
  workflow *with* credentials against untrusted code, which is strictly worse than having no
  preview at all.
- **Compliance framework:** none adopted yet — deliberately deferred, not decided. Revisit before
  skyhook is used for any environment handling regulated data.

## Quality bar
- **Testing:** the core decision logic — which environment to reclaim, whether the cap has been
  reached, what the scheduled sweep must correct — is tested against fake adapters and requires no
  cloud account to run. Provider adapters are verified against a real environment rather than
  mocked into meaninglessness. A feature whose logic can only be exercised by deploying to AWS is
  evidence the plugin boundary is in the wrong place.
- **Failures are loud.** A scheduled sweep that cannot do its job fails visibly. Nothing may
  swallow an error to keep a run green: for this product, a silent failure and a success look
  exactly alike until the bill arrives.
- **Accessibility:** the dashboard meets WCAG 2.2 AA. It is largely tabular data, which is cheap
  to build accessibly with semantic HTML from the start and painful to retrofit later.
- **Review:** the pre-implementation consistency check passes before code is written.

## Out of scope (project-wide)
- **Skyhook does not define your application's infrastructure.** The repo owns its Terraform;
  skyhook owns the lifecycle around it. Skyhook is not a PaaS and does not template your stack.
- **Not cost management.** Capping environment count and cleaning up reliably has cost
  consequences, but skyhook does not report, forecast, allocate, or optimize spend.
- **Not a secrets manager.** Skyhook obtains its own cloud access through federation and relies on
  whatever the repo already uses to supply application secrets.
- **Fork pull requests are unsupported.** See *Security & compliance* — this follows from how
  GitHub issues OIDC tokens, and is a property of the design rather than a gap to close.

Deploying a production environment is deliberately **not** out of scope: an environment skyhook
provisioned is one skyhook can manage, whatever it is named.
