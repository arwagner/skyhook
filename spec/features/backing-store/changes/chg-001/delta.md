# Delta — backing-store / chg-001 — pull-request role scoped by prefix, not by key

> The change expressed against the current spec as explicit operations.

## ADDED

New requirements, written as full spec requirements. Any acceptance criterion here takes the next
stable `AC-N` id when folded into `spec.md` — append, never renumber an existing id.

- **AC-17:** The credentials a pull-request-triggered run holds are refused by the cloud for every
  environment outside the ephemeral namespace — every long-running environment, every environment in
  another repository, and the protection marker of any environment whatsoever. This holds when
  skyhook's own validation is bypassed.

- **AC-18:** The bootstrap definition, and the output of the init command, both state plainly that a
  pull-request run's credentials do not separate it from *other pull requests'* environments. The
  limit is written where an operator reads it, not only in the specification.

## MODIFIED

For each, show before and after.

- **AC-14 — what a pull-request run may reach**
  - Was: A run triggered by a pull request cannot claim or modify any environment other than the one
    derived from its trigger. This holds when skyhook's own validation is bypassed: the credentials
    such a run holds are refused by the cloud for any other environment's record.
  - Now: A run triggered by a pull request derives its environment identity from the trigger and
    refuses any identity supplied to it. Skyhook's own code enforces this. The credentials such a run
    holds additionally confine it to the ephemeral namespace, so a bypass of skyhook's validation
    still cannot reach a long-running environment, another repository, or any protection marker.
    Within that namespace the credentials do not distinguish one pull request from another: a run
    that bypasses skyhook's validation could reach a different pull request's environment. That
    residual gap is stated in *Known sharp edges* and is not closed at prototype depth.

- **Behavior & scenarios — "Where the identity comes from depends on who is asking"**
  - Was: This restriction is enforced by the credentials the run holds — scoped so that reaching
    another environment's record is refused by the cloud — not only by skyhook's own code.
  - Now: The credentials the run holds carry most of this restriction: the cloud refuses such a run
    any long-running environment, any other repository's environment, and any protection mark,
    whatever skyhook's own code does. It does not separate one pull request from another — there,
    skyhook's own code is what stands in the way. See *Known sharp edges*.

- **Scenario: a pull request asks for another environment's name**
  - Was: Given a run triggered by a pull request / When the workflow that invokes skyhook passes an
    identity other than the one derived from the trigger / Then the request is refused, and the
    credentials the run holds would refuse it even if skyhook's own check were bypassed
  - Now: Given a run triggered by a pull request / When the workflow that invokes skyhook passes an
    identity other than the one derived from the trigger / Then the request is refused. If skyhook's
    own check were bypassed, the credentials the run holds would still refuse every long-running
    environment, every other repository, and every protection marker — but would not, on their own,
    refuse another pull request's environment.

- **Known sharp edges (prototype) — new edge added**
  - Was: (the list does not mention the enforcement boundary between pull requests)
  - Now: adds — **Pull requests are not separated from each other by the cloud.** The role a
    pull-request run assumes reaches the whole ephemeral namespace, because the pull request number
    reaches no condition AWS can evaluate: a generic OIDC provider's token claims are readable when
    the role is assumed and not afterwards, and GitHub emits no session tags. Skyhook's own code is
    what keeps one pull request out of another's environment, and a pull request that edits skyhook's
    code on its own branch defeats it. Closing this needs the calling workflow to live on the default
    branch and hand out already-narrowed credentials — a decision that belongs to the deploy-action
    feature.

## REMOVED

- Nothing. AC-14's promise is narrowed rather than dropped: the part that was achievable survives,
  and the part that was not is replaced by AC-17's weaker but true statement plus an explicit sharp
  edge.
