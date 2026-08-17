# Proposal — deploy-action / chg-001 — preview isolation is a decision, not a boundary

**Trigger:** an amendment to `constitution.md`, open as its own pull request, reclassifies the
boundary between two preview environments. It was carried as debt — "not structural yet", with a
known fix this feature was going to build. It is now a deliberate choice: skyhook does not defend
one preview environment from another, and says so along with what that costs. This feature's
requirements were written against the old reading and must follow.

**Summary:** two of this feature's acceptance criteria exist only to make the preview-to-preview
boundary structural, and the machinery behind them — a trusted reusable workflow, a trust condition
on `job_workflow_ref`, and a live verification that AWS honours it — exists only to satisfy those
criteria. The amendment removes the requirement, so the machinery goes with it. What survives is
the part that was never about hostility: skyhook still asks for credentials narrowed to the single
environment it claimed, which keeps a run out of a sibling preview by accident. That guarantee is
restated as what it is rather than deleted.

The reasoning has two halves, and the second is why this arrives now rather than later.

The first is who could exploit the gap. Only a repository collaborator can open a pull request that
deploys at all — fork pull requests are issued no credentials, which is a property of how GitHub
mints tokens rather than a setting anyone chose. So the boundary defends against someone who already
holds write access to the repository and has blunter instruments available. The blast radius is one
preview environment reaching another preview environment in the same repository; every boundary that
matters — long-running environments, other repositories, protection marks — is cloud-enforced by the
subject claim alone and is untouched by this change.

The second is the coupling. Closing the boundary required naming `token.actions.githubusercontent.com:job_workflow_ref`
in a trust policy: one cloud's handling of one CI host's non-standard token claim, promoted into the
architecture and, per plan D3, contradicted by GitHub's own documentation. The constitution's
provider-agnostic rule exists to keep exactly that out of the core, and its quality bar already said
that a feature whose logic can only be exercised against a live AWS account is evidence the plugin
boundary sits wrong. This feature's build has been stopped for precisely that reason, behind a live
probe. Removing the requirement removes the coupling and the probe together.

**Worth recording, because it changes the cost of the decision:** the trigger-based privilege split
survives this intact. An OIDC subject is determined by what *triggered* a run, not by which workflow
file runs, so a pull request that edits skyhook's own workflows still presents
`sub = repo:<owner>/<name>:pull_request` and is still offered only the narrower credentials. Plan D2
reads as though `job_workflow_ref` carried that guarantee; it never did. The exotic claim bought one
thing only — the preview-to-preview cut — which is why dropping it costs less than the plan implies.

## Blast radius within this feature

**Spec.** One criterion removed (AC-8, credentials obtainable only via a default-branch workflow),
one narrowed (AC-7, which claimed refusal for other pull requests' environments), one added to state
the surviving guardrail honestly.

**Plan.** D2 collapses from two scaffolded workflow files to one; its "why this shape rather than
one file" reasoning goes with it. D3 keeps the inline session policy and loses the trust-condition
half, including the `StringEquals`-not-`StringLike` argument as it applies to `job_workflow_ref`
(the argument still stands for the subject condition, which feat-001 already carries). D12's
ordering requirement — both files reaching the default branch before any pull request can deploy —
simplifies but does not disappear, since one file still has to be there.

**Tasks.** Phase 0's live probe is retired rather than run. Phase 5 loses one workflow file, the
trust-condition work, and the rewrite of the operator-facing limit block that assumed the boundary
had closed. Phase 6's scaffolding follows Phase 5. Phase 7 drops the AC-8 check from the end-to-end
run, and its constitution-amendment task is already done — as this change's own trigger.

**Built code.** None. Phases 1 through 4 are built and green, and nothing in them names the trust
policy: the session-policy narrowing in `src/adapters/aws/session-policy.ts` survives unchanged,
and `src/adapters/aws/broker.ts` performs the same two assumptions it did before. The removed
machinery lives entirely in what Phase 5 had not yet written.

**Adjacent feature.** The backing store carries the same retired verification as its own sign-off,
and `chg-007` against it already records the `job_workflow_ref` trust condition as work to do. That
needs its own change record; it is not folded in here, because a change is scoped to one feature.
