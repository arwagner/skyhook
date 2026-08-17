# Delta — deploy-action / chg-009 — against spec.md as of 2026-08-17

## MODIFIED

- **The confinement paragraph** (Behavior & scenarios, "A pull request's credentials are
  confined to ephemeral environments, and the cloud draws no line inside that.").
  - Was: "[…] Within the ephemeral namespace, skyhook asks for credentials narrowed to the
    single environment it claimed — which keeps an honest run out of a sibling's environment
    and does nothing to stop a run that declines to ask. […]"
  - Now: the paragraph opens with the namespace's definition and admits the pre-claim read:
    "The **ephemeral namespace** comprises this repository's pull-request identities
    (`pr-<n>`) and, where pooling (feat-007) is enabled, its warm-slot identities
    (`slot-<n>`). What a pull-request-triggered run can obtain is fixed by what triggered it
    rather than by any file in the repository, so a branch that edits skyhook's workflow gains
    no wider reach. Within the ephemeral namespace, a run with pooling enabled may first read
    the repository's slot records and attempt the pool claim; skyhook then asks for
    credentials narrowed to the single environment the claim resolved — the claimed slot, or
    the derived identity on the from-scratch path — which keeps an honest run out of a
    sibling's environment and does nothing to stop a run that declines to ask. That one
    preview environment is not held apart from another is a decision, recorded in the
    constitution along with what it costs: infrastructure state holds any credential that
    infrastructure generated for itself, and a sibling preview can read it — and with pooling
    enabled, a sibling can likewise read the slot records, which hold deployment metadata
    only."

- **AC-19** — the issuance wording admits the two-phase shape; the guarantee keeps its teeth.
  - Was (the load-bearing opening): "The credentials skyhook obtains for its own registry and
    state work are narrowed, at the moment they are issued, so that every read, write and
    delete they permit falls inside the single environment the run claimed. […]"
  - Now: "The credentials skyhook obtains for its own registry and state work are narrowed so
    that every read, write and delete they permit falls inside the single environment the run
    claimed, and that narrowing is in force before the repository's own infrastructure code
    runs. With pooling off, the narrowing is applied at the moment the credentials are issued,
    exactly as before. With pooling on, issuance additionally permits reading this
    repository's slot records and the conditional pool-claim write on them — nothing else
    widens — and the acting narrowing to the one resolved environment is applied the moment
    the claim resolves, before any apply." The rest of the criterion — the three named
    exceptions, the intersection argument, the inspected-request demonstration — stands, with
    the demonstration gaining the pooled variant: pre-claim, the request names slot records
    and the claim write; post-claim, it names the one resolved environment.

## ADDED

- **AC-27:** On a pooled repository, the deploy path's order is observable as: declared-input
  refusals first, then the slot-record read and pool claim (or fall-through to the fresh
  claim), then the narrowing to the single resolved environment, and only then the
  repository's apply — demonstrated with fake adapters by asserting the sequence, and on the
  live installation by inspecting the narrowed request on both the warm and the cold path.
  With pooling off, the sequence is byte-for-byte today's.

## REMOVED

- Nothing. The fork gate, the trigger split, record-before-resource, refuse-before-claim, and
  update-after-apply are unchanged.
