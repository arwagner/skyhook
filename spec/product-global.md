# Product-global — Skyhook

> CANONICAL cross-cutting requirements owned by no single feature. Change ONLY via a dedicated PR,
> never as part of a feature branch. Project principles, tech defaults, and security posture live
> in `constitution.md`, not here.

## Glossary
- **Consuming repo** — a repository that supplies infrastructure-as-code and uses skyhook to
  deploy copies of it.
- **Environment** — one deployed copy of a consuming repo's infrastructure, provisioned and owned
  by skyhook.
- **Ephemeral environment** — an environment whose lifetime is bound to a pull request.
- **Long-running environment** — an environment that persists independently of any pull request.
- **Protected environment** — an environment marked such that skyhook will not destroy it without
  an explicit human action.
- **Registry** — skyhook's durable record of which environments exist, what code is deployed to
  each, and what state each is in.
- **Sweep** — the recurring job that compares actual environments against the registry and
  corrects the difference.
- **Adapter** — the pluggable implementation of one infrastructure-as-code tool and one cloud
  provider, behind which all provider-specific behavior lives.

## Global non-functional requirements
- **Performance:** skyhook's own overhead — claiming, recording, reporting — adds no more than 60
  seconds to a deploy. Two things are excluded, and both belong to the consuming repo: applying its
  infrastructure, and the step in which the infrastructure tool prepares that definition beforehand,
  fetching the providers and modules it declares. Skyhook controls neither, and a budget counting
  them would measure somebody else's dependency tree rather than skyhook's overhead. The exclusion
  is drawn at the step rather than at the fetch, because that is the boundary an implementation can
  actually hold — one command does both jobs, so any skyhook work inside it goes uncounted too, and
  a feature that excludes only the fetch would be promising a measurement nobody can take. Of the
  seconds that do fall to skyhook, none may go missing: time skyhook spends that nobody thought to
  measure is counted against skyhook rather than omitted. The dashboard renders its environment list
  in under 2 seconds.
- **Security:** no long-lived cloud credentials exist anywhere in the system, in any store or
  configuration. All skyhook-managed data is encrypted at rest. The dashboard is not publicly
  readable and requires authentication.
- **Accessibility:** the dashboard conforms to WCAG 2.2 AA.
- **Reliability / availability:** the sweep runs no less often than every 15 minutes. An
  environment eligible for teardown is destroyed within one sweep interval of becoming eligible. A
  sweep that cannot complete reports failure visibly rather than exiting successfully.
- **Privacy / data handling:** skyhook stores only deployment metadata — repository, commit, pull
  request number, environment identity, state, timestamps, environment URLs, and the values of a
  repository's declared deploy inputs (artifact references such as an image tag, recorded in the
  clear; never secrets — the settings that declare them say so where they are declared). It does
  not store, read, or transit application data belonging to a deployed environment.

## Product invariants
- Every environment skyhook has provisioned is represented in the registry.
- No environment exists that skyhook cannot locate and destroy.
- The registry is the single source of truth for what code is deployed to which environment.
- A protected environment is never destroyed without an explicit human action.
- When the environment cap is enabled, creation that would exceed it fails rather than proceeding.
- An environment's identity is stable for its whole life: it is never reused for different code
  without an intervening destroy.

## Cross-cutting constraints
- **Environment cap:** configurable per consuming repo. Enabled by default with a limit of 5, and
  may be disabled entirely.
- **Storage:** skyhook's registry and the Terraform state backend live in S3 resources skyhook
  defines. One installation stores its data in one bucket.
- **CI integration:** GitHub Actions is the only supported CI host at present, authenticating by
  OIDC. Fork pull requests are unsupported.
- **Concurrency:** environment claims are atomic. Two simultaneous requests never receive the same
  environment, and neither silently overwrites the other's registry write.
