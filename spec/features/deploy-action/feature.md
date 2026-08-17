---
schema_version: 2
id: "feat-002"               # IMMUTABLE
slug: "deploy-action"
title: "Deploy action: claim an environment and apply a consuming repo's Terraform from CI"
status: done                 # active | done | dropped — chg-008 built and verified 2026-08-17; chg-007 folded same day; gate pass
owner: "andrew"
depth: "prototype"           # prototype | mvp | ga
sprint: null
external: null
depends_on: [feat-001]       # the registry and backing store this feature claims environments from
requires_design: null        # inherits workspace default (false)
readiness:
  research: ready            # none | draft | ready
  design:   n/a              # design stage is off for this workspace
  spec:     ready
  plan:     ready
  tasks:    ready            # phase 13 (chg-008) built and verified 2026-08-17; chg-008 delta folded 2026-08-17
gate:
  analyze: pass              # 2026-08-17 re-gate: B1-B4 closed (delimiter hardened at the shared writer, fixes url too), tightening folded; see analyze.md
  product_global_hash: "sha256:a8932ef5ee1c"
  constitution_hash: "sha256:a045ce0c2437"
converge:
  last_run: "2026-08-16"
  open: 0
  contradicts: 0
  runs: 2
human_signoff:
  - id: hs-1
    description: "Decide how the pull-request role's ListBucket grant reconciles with Terraform's workspace enumeration: widen the list-prefix condition to state/<repo>/ and registry/<repo>/ (recommended — enumeration only, no object access), accept a state layout that no longer matches stateDirFor(), or drop workspaces and forfeit AC-12. Moves a boundary the constitution's explicit-deny clause draws. Task 0.1."
    owner: andrew
    resolved: true
    observed: >-
      DECIDED 2026-08-14, option (a): widen the pull-request role's ListBucket prefix condition to
      include state/<repo>/ and registry/<repo>/. Object grants are untouched — GetObject,
      PutObject and DeleteObject stay confined to the pr-* namespace at the role and to one single
      environment once the session policy narrows it. What a pull-request run gains is the ability
      to enumerate environment NAMES, and nothing else.
      The two alternatives were rejected on cost rather than on security. Bending the workspace
      prefix to state/<repo>/pr- needs no policy change and satisfies AC-17 most literally, but
      files state at state/<repo>/pr-/<identity>/ — no longer the location stateDirFor() computes,
      so teardown and the sweep would later look in the wrong place — and it hard-codes "pr-" into
      where all state lives, which is nonsense for a future long-running environment. Dropping
      workspaces removes the listing entirely but forfeits AC-12, since terraform.workspace is the
      only way an arbitrary definition learns its environment without a declared input.
      The judgement call was whether the constitution's "explicit deny on everything but the
      caller's own ephemeral namespace" is about acting on a thing or about seeing that it exists.
      Read as acting: seeing a name is not reaching an environment. Recorded here rather than left
      to be found in a diff.
      A possible refund remains open: if TF_WORKSPACE selects a workspace without Terraform
      enumerating first, the state half of this widening becomes unnecessary. Checked opportunistically
      during hs-2's live session; not depended on.
  - id: hs-2
    description: "Prove against the live account that AWS honours token.actions.githubusercontent.com:job_workflow_ref as a trust condition, and that a caller edited on a pull request's own branch is refused by STS. The AWS documentation says it works and GitHub's says it does not; every later phase assumes an answer. Task 0.3."
    owner: andrew
    resolved: true
    observed: >-
      RETIRED 2026-08-15 by chg-001, not run. The question was only ever worth asking because a
      shipped trust policy was going to depend on the answer. The constitution amendment that
      triggered chg-001 reclassifies the boundary that trust policy was closing — one preview
      environment reaching another — as a deliberate choice rather than a gap, so nothing skyhook
      ships depends on how AWS treats the claim.
      Recorded rather than deleted, because the reason the question was asked is worth keeping: the
      answer was genuinely unknown, AWS's documentation and GitHub's contradicted each other, and
      the probe built to settle it (two roles, one control, a reusable workflow called by two refs)
      was the right instrument. It is simply aimed at a fact nothing now rests on.
      What writing it did establish, and what survives in chg-001's proposal: the trigger-based
      privilege split never rested on this claim. An OIDC subject names what triggered a run, not
      which workflow file ran, so a pull request that edits skyhook's own workflows is still offered
      only the narrower credentials. job_workflow_ref bought the preview-to-preview cut alone, which
      is why dropping it costs less than the plan implied.
  - id: hs-3
    description: "End-to-end verification against the real account and the deadweight repository: reachable URL, skyhook's own share under 60 seconds, second push updating in place, two concurrent pull requests, the cloud refusing everything outside the ephemeral namespace, the narrowed session refusing a sibling preview's keys, the state landing at state/<repo>/pr-<n>/, and a broken definition exiting 3 with the recorded commit unchanged. An injected runner proves what skyhook asks Terraform and STS to do, never whether they accept it. Task 7.1, revised by chg-001 (the AC-8 check is gone with the criterion)."
    owner: andrew
    resolved: true
    observed: >-
      SIGNED OFF 2026-08-16 by andrew. Four passes against the real account and the `deadweight`
      repository, recorded in full under task 7.1. Every criterion this task enumerates carries
      live evidence there — a reachable URL, the budget, a second push updating in place, two
      concurrent pull requests, the cloud's refusals, the narrowing skyhook asks for, the state
      landing where the roles grant, a broken definition exiting 3, and the planted override
      refused before Terraform ran — except two, which are DEFERRED WITH THEIR REASONS rather than
      proved.
      `AC-10`, a fork pull request getting no environment, needs a second GitHub account to fork
      from, and this feature is being tested by one person working alone. There is no second
      account, so the live half of this criterion is not blocked on effort or on skyhook — it is
      blocked on a thing that does not exist here. What IS covered: the suite exercises the fork
      refusal, and the check sits before any credential is requested, so the failure mode it exists
      to prevent (a fork run dying halfway through on an authentication error) cannot occur. What
      is unwitnessed is GitHub itself issuing a fork run and skyhook declining it.
      `AC-5`, an environment closed and reopened, will be tested once teardown is ready. The spec
      already records that it cannot be shown before then: nothing in this feature marks an
      environment released, so there is no state to reopen from. This is a criterion becoming
      reachable, not a postponement of something available today.
      Both deferrals are blocked on something outside this feature — an account, and an unbuilt
      capability — and neither waits on work skyhook could do now. Recorded here rather than left
      for a later reader to infer from a sign-off that says nothing about what it did not cover.
open_decisions:
  - id: od-1
    description: >-
      How should the roles' trust policies match a repository when the organization issues
      ID-qualified OIDC subjects? Found by the first live run and verified against a real token:
      this organization presents
      `sub = repo:skylight-hq@26345547/deadweight@1335111920:pull_request`, while the bootstrap
      builds `repo:<owner>/<name>:pull_request`, so every role assumption is refused and nothing
      below the credential exchange can be exercised. Three ways out, and they are not equivalent.
      (a) Condition on `repository_owner_id`, `repository_id` and `event_name` instead of on `sub`
      — immutable, exact, no wildcard, and what GitHub itself recommends alongside immutable
      subjects; it also survives a rename or transfer, which `sub` does not, and this feature has
      already been bitten once by a transfer. (b) Take the subject prefix as a bootstrap variable,
      which keeps `sub` matching but makes every operator discover and copy a value they have
      never heard of. (c) Match `sub` with `StringLike` and a wildcard, which the constitution's
      own comment calls "the classic way this trust model is lost" — rejected unless the other two
      prove impossible.
      This moves a security boundary the constitution states as an outcome, so it is a human call,
      and it belongs to the backing store (`feat-001`), whose bootstrap owns these roles.
    owner: andrew
    resolved: true
    observed: >-
      RESOLVED 2026-08-15, recorded as `chg-009` against feat-001. The option list was overtaken by
      an apply before it could be chosen from: the recommended (a) is IMPOSSIBLE. AWS rejects a
      trust policy for this provider that conditions on neither `sub` nor `job_workflow_ref` with
      `MalformedPolicyDocument`, so the immutable `repository_id`/`repository_owner_id` claims —
      which really would have been the better key, and which GitHub itself recommends — cannot carry
      the condition alone. Nothing but an apply says so.
      What shipped is (b) with the cost that made it unattractive removed. The subject prefix is a
      bootstrap variable, and `skyhook bootstrap` reads GitHub's OIDC customization endpoint and
      passes in whatever it reports, so no operator has to discover or retype a string they have
      never heard of. It prints which form it used — GitHub's or the conventional fallback — before
      anything is applied, because reading that endpoint needs repository admin and a silent
      fallback would be wrong in exactly the organizations that need the answer. Option (c), the
      wildcard, was never in play.
      The code was already live when this was written: it is what made the first environment
      possible. What `chg-009` adds is the record, plan decision D3c, two acceptance criteria, and
      the unit tests the adapter never had.
  - id: od-2
    description: >-
      How should skyhook create an environment's Terraform workspace the FIRST time, given it must
      never touch the default workspace's state? Found by the second environment, run 31896101810:
      TF_WORKSPACE selects a workspace but does not create one, so a brand-new environment fails
      at init with `Currently selected workspace "pr-2" does not exist`. pr-1 only worked because
      its state already existed from an earlier run. The record was written first, so pr-2 sits in
      the registry with no state and no infrastructure -- the no-orphans ordering behaving exactly
      as designed, which is the one comfort here.
      The bind: creating a workspace needs a successful init, and init without TF_WORKSPACE reads
      the DEFAULT workspace's state, which the S3 backend files at the bare key -- the root of the
      bucket, outside every prefix either role grants. Three ways out.
      (a) Grant both roles GetObject on that one root key. Init then gets a clean 404 instead of a
      403 and proceeds, and `workspace select -or-create` works as it always meant to. Smallest
      change, but it widens a shipped IAM policy, so it is a recorded change against feat-001.
      Skyhook never writes that key, and read on one never-written object is easy to reason about.
      (b) Skyhook writes the initial empty state object itself, at a path its narrowed credentials
      already permit, so the workspace exists before init runs. No IAM change at all, but skyhook
      would be hand-authoring a Terraform state file, whose format is not a contract.
      (c) Drop workspaces and give each environment its own backend key. Forfeits AC-12, since
      terraform.workspace is how an arbitrary definition learns its environment without declaring
      an input.
      Recommend (a): the smallest honest change, and reviewable as a delta against the backing
      store, whose roles these are.
    owner: andrew
    resolved: true
    observed: >-
      RESOLVED 2026-08-15 as option (a), recorded as chg-008 against feat-001, and it took two more
      goes than the option described. Granting the read was necessary and nowhere near sufficient.
      The first attempt widened only the ROLE policy. Still 403: the backend runs on skyhook's
      narrowed SESSION credentials, whose inline policy denies everything outside the environment
      too. Both layers had to agree, and only one had been read carefully.
      The second attempt widened both and STILL returned 403. The reason is worth keeping: S3
      answers a HeadObject on a MISSING object with 403 rather than 404 unless the caller could
      also have LISTED it. The object had never existed, so the read just granted was never
      reached. Adding the key to both listing conditions is what finally worked -- it lists
      nothing, and exists only to turn "forbidden" into "not there".
      One thing was spent to pay for it. The session policy's NoMarks deny, belt and braces by its
      own comment, was removed: the document has a hard 2048-character ceiling and the worst
      plausible repository came to 2153 characters with both. A protection mark is still refused
      twice -- by NoOthers in the same document, and by the role's own
      DenyAllAccessToProtectionMarks, which no session policy can widen.
  - id: od-3
    description: >-
      Should `product-global.md`'s performance requirement name the second exclusion too? It
      currently reads "skyhook's own overhead — claiming, recording, reporting — adds no more than
      60 seconds to a deploy. Time spent applying the consuming repo's infrastructure is excluded,
      as skyhook does not control it." Its stated REASON covers fetching the repository's providers
      exactly; its enumeration names only the apply. `chg-005` corrects the feature's own AC-14 to
      name both, which leaves the two texts disagreeing until this is settled — the same shape of
      problem `chg-004` met with the constitution, and the reason AC-19 went untrue twice.
      Recommended: amend the product-global performance requirement to say what it already implies,
      through its own pull request off `main`. A cross-cutting requirement is never edited inside a
      feature change, which is why this is a decision rather than part of `chg-005`.
      Not urgent and not blocking: until it moves, the feature criterion is the narrower and more
      accurate of the two, which is the safe direction for them to disagree in. It is recorded so
      the disagreement is deliberate and dated rather than discovered later by a reader who cannot
      tell which text is stale.
    owner: andrew
    resolved: true
    observed: >-
      RESOLVED 2026-08-16 as recommended: `product-global.md`'s performance requirement now names
      both exclusions, so the two texts agree. Amended in its own commit off `main`, never inside a
      feature change, which is the rule for a cross-cutting input and the reason this was a decision
      rather than part of `chg-005`.
      The wording follows `AC-14` rather than paraphrasing it, including the part that is easy to
      drop: the exclusion is drawn at the STEP, not at the fetch. One command fetches the
      repository's providers AND configures skyhook's own backend, and no measurement separates
      them, so a requirement excluding only the fetch would promise a number nobody can produce.
      That is the same error the pre-build check caught inside `chg-005` itself (finding B1), and
      writing the shared text without it would have reintroduced it one level up.
      The stated cost was paid knowingly: editing a shared input restages every feature's pre-build
      check, so both features' gates were re-run rather than left stale. The alternative — record
      the disagreement as deliberate and pay nothing — was rejected because a reader opens one text
      and cannot know the other exists.
overrides:
  - id: ov-1
    gate: open-items
    by: andrew
    resolved: true
    discharged: >-
      PAID 2026-08-16, on the terms this override set for itself. It bought passage past two open
      live checks and said it must be cleared by resolving them rather than by deletion: `hs-2` was
      retired by `chg-001` when the trust policy it would have proven was withdrawn, and `hs-3` was
      signed off after four passes against the real account. Both are `resolved: true`, so the debt
      is discharged rather than forgiven.
      Kept in the manifest, not removed. The record that this feature was built ahead of its own
      verification is worth more than a clean list — it is why phases 5 and 6 were held back, and
      why nothing shipped depended on an unproven answer.
    reason: >-
      Build phases 1-4 while hs-2 and hs-3 are still open. Both are live verifications against a
      real AWS account, and neither can be resolved from a desk: hs-2 proves AWS honours the
      job_workflow_ref trust condition, hs-3 is the end-to-end run. Everything they gate — the
      trust policy, the scaffolded workflows, the test consumer — is held at phase 5 and phase 6
      precisely so nothing depends on an unproven answer. What is built under this override is the
      record shape, the deploy logic, the adapters and the action surface, none of which changes
      whichever way the live checks land.
      This is recorded debt, not a waiver: promote refuses on an unresolved override, so it must be
      cleared by resolving hs-2 and hs-3 rather than by deleting it. It buys passage only at
      prototype depth, and it does not let the tasks phase close — that still needs every [H] item
      resolved.
extends: []
---

# Feature notes — Deploy action: claim an environment and apply a consuming repo's Terraform from CI

> The frontmatter above is the canonical manifest. `id` is immutable. `spec/dashboard.md` and
> `spec/product.md` are generated from these manifests — never hand-edit them.

## Why this feature is next

The backing store (feat-001) installs the registry and the Terraform state home, but nothing yet
writes to them from a real pipeline. This feature is the first one a consuming repo actually runs:
it claims an environment, applies that repo's infrastructure into it, and records the result.

## Known constraints going in

- GitHub Actions is the only supported CI host, authenticating by OIDC; fork pull requests are
  unsupported (product-global, CI integration).
- Privilege is split by trust policy: a job running from a pull request's own branch may assume
  only roles scoped to the ephemeral environment itself, and creating or destroying infrastructure
  requires a role whose trust policy names the default branch (constitution, security).
- Claims are atomic — two simultaneous requests never receive the same environment (product-global,
  concurrency). The backing store already proved this against a real bucket.
- Skyhook's overhead — claiming, recording, reporting — adds no more than 60 seconds to a deploy;
  time applying the consuming repo's own infrastructure is excluded (product-global, performance).
- The entry point is deliberately open (constitution, tech defaults): whether this ships as a
  GitHub Action, a CLI that CI invokes, or both, is this feature's call to make and state.

## Carried in from the backlog

- **Row 2, `trusted-workflow-credentials`.** Pull-request-to-pull-request isolation is currently a
  known gap: the backing store's roles are scoped to the `pr-*` prefix, not to one pull request,
  because a static IAM policy cannot see the pull request number. The fix — pinning the
  pull-request role's trust to a reusable workflow on the default branch, which then hands out
  credentials already narrowed to `pr-<number>` — was deferred to this feature precisely because it
  decides the calling workflow's shape. Decide it here, deliberately, either way.
