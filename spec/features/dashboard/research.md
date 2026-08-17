# Problem Brief — dashboard

## Problem statement
Skyhook's registry knows everything about the environments it manages, but today only automation
can read it. That blindness hurts in three concrete moments. When the environment cap is hit, a
deploy is refused and the human unblocking it cannot see which slot can be freed. A developer who
wants to try a feature branch cannot remember the URL its environment is served on. And nobody can
see how close the team is to the cap until they hit it. The data to answer all three already
exists — there is just no page that shows it.

## Target users
- **A developer on a team using skyhook** (Andrew first) — wants the URL for a branch's
  environment, and wants cap headroom visible before it becomes a refusal.
- **The person unblocking a deploy at the cap** — needs to see, at a glance, which environments
  are reclaimable and which are protected or in use.

## Jobs to be done
- Open one page and see every environment skyhook manages: identity, pull request number (when it
  has one), state, protection, last deploy, URL.
- See cap usage (used vs. configured cap) at a glance.
- Select one environment and see its full record — what commit is deployed there, and when.

## Success signals (what the prototype must prove)
One glance at the page answers all three pains, with no AWS console and no CLI:
- How close are we to the cap?
- Which slot can be freed? (released, unprotected environments are visibly distinct)
- What is the URL for the environment serving branch X?

If the registry's data cannot answer those on a page, that is a finding about the registry, and
the prototype has still earned its keep by surfacing it.

## Constraints
Inherited from `constitution.md` and `product-global.md` — referenced, not restated:
- The dashboard is not publicly readable and requires authentication.
- The environment list renders in under 2 seconds.
- WCAG 2.2 AA applies to the dashboard (GA bar; the prototype uses plain semantic structure but
  does not certify AA — debt to pay at promote).
- The registry is the single source of truth; the page shows what the registry records, nothing
  discovered by other means.

## Out of scope / sharp edges
- **Read-only.** No destroy, protect, or deploy action from the page in this prototype. Freeing a
  slot still happens through the existing mechanisms.
- **How "not publicly readable" is satisfied for a prototype is an open decision** (od-1 in the
  manifest): a locally served page using the developer's own credentials, or a hosted page behind
  real auth. Human call before implement.
- **Freshness:** the page reads the registry when loaded. No live updates; refresh is the answer
  at this depth.
