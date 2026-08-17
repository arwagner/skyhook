# Delta — chg-005: the budget names both things it does not count

> The change expressed against the current `spec.md` as explicit operations.

## ADDED

Nothing. The criterion this touches already exists and keeps its id.

## MODIFIED

- **AC-14 — skyhook's own share of the deploy**

  - Was:

    > AC-14: The run reports how long skyhook's own share of the deploy took — deriving the
    > identity, claiming, selecting the environment's copy, recording, and reporting, excluding the
    > consuming repository's apply — and that figure is under 60 seconds.

  - Now:

    > AC-14: The run reports how long skyhook's own share of the deploy took — deriving the
    > identity, claiming, selecting the environment's copy, recording, and reporting — and that
    > figure is under 60 seconds. Two things are excluded, and both are the consuming repository's:
    > applying its infrastructure, and the step in which the infrastructure tool prepares that
    > definition beforehand, fetching the providers and modules it declares. Skyhook controls
    > neither the size of a repository's dependencies nor how long they take to arrive, and a
    > budget counting them would measure somebody else's dependency tree rather than skyhook's
    > overhead. One piece of skyhook's own work falls inside that preparation step and is not
    > counted with the rest: settling where this environment's state will live. It is named here
    > rather than left to be discovered, so the figure is not read as covering every second skyhook
    > spends — it is bounded by a few requests to the store, where what the exclusion buys is
    > unbounded. Of the seconds that do fall to skyhook, none may go missing: time skyhook spends
    > that nobody thought to measure is counted against skyhook rather than omitted.

  - Why: the criterion named one exclusion and the design has always had two. Plan `D7a` ruled
    provider fetching onto the repository's side and said the spec had not adjudicated it; the code
    then did the opposite of the plan and charged it to skyhook (`gap-001`). Naming both exclusions
    in the criterion is what lets the code be fixed without making the criterion false.

  - **Reworded after the pre-build check (finding B1).** The first draft excluded *"fetching what
    that definition needs"* while `D7a` excludes the whole step that does the fetching — a step
    which also settles where skyhook's own state lives. That is `gap-001`'s exact failure repeated
    inside its own fix: a criterion enumerating less than the implementation does. The exclusion is
    now drawn at the step, which is the boundary the code can actually hold, and the residue is
    stated in the criterion rather than only in the plan. The alternative — splitting the tool's
    preparation in two so the exclusion could stay at the narrower wording — is priced in `D7a` and
    was not taken.

  - **The last sentence is not decoration**, and it is deliberately an outcome rather than a
    mechanism (finding S3). It preserves the property a shorter rewrite would lose: work nobody
    remembered to instrument must land on skyhook's side of the line rather than vanish from the
    figure. How that is achieved — subtraction from wall time rather than summing measured steps —
    is `D7a`'s to specify, and `src/core/deploy.ts:102-105` already explains it in place.

## REMOVED

Nothing.

## Not in this delta, and deliberately

`product-global.md` carries the same budget with the same single exclusion, and its stated reason —
*"as skyhook does not control it"* — already covers provider fetching. A cross-cutting requirement
is changed by its own pull request off `main`, never inside a feature change, so it is raised as
`od-3` rather than edited here. Until it moves, the feature criterion is the narrower and more
accurate of the two, which is the safe direction for the two to disagree in.
