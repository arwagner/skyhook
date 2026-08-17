# Two roles. They differ in exactly one thing that matters: which OIDC subject their trust policy
# accepts. That difference is structural — the subject names what TRIGGERED a run, not which
# workflow file ran, and nothing in the repository can alter it, so a pull request that edits
# skyhook's own workflow files gains nothing at all. It still cannot assume the privileged role.
#
# The subject's PREFIX is not assumed. An organization may issue ID-qualified subjects, and a
# policy hard-coding `repo:<owner>/<name>` then refuses every assumption. See the note in oidc.tf.

# feat-002 plan D4 — skyhook derives the ARNs of the roles it assumes from the account id and a
# name prefix, so no role ARN is ever typed into a consuming repository's settings or workflow.
# The account id is an output rather than a variable: the apply already knows it.
data "aws_caller_identity" "current" {}

locals {
  bucket_arn = aws_s3_bucket.skyhook.arn

  # Everything belonging to this repository.
  registry_prefix   = "registry/${var.repository}"
  state_prefix      = "state/${var.repository}"
  protection_prefix = "protected/${var.repository}"

  # The one key outside every prefix that Terraform insists on reading (chg-008). The S3 backend
  # files a NAMED workspace under workspace_key_prefix but the DEFAULT workspace at the bare key,
  # and Terraform consults it during init, before any workspace can be selected. Skyhook never
  # uses the default workspace and never writes this object; it is granted for READ only, to both
  # roles, so that init gets a 404 rather than a 403 and can get as far as selecting a workspace.
  default_workspace_state = "${local.bucket_arn}/terraform.tfstate"

  # The ephemeral namespace: the environments a pull-request run may reach. `pr-*` is what
  # src/core/identity.ts derives and nothing else.
  #
  # The state entry covers `terraform.tfstate` and the `terraform.tfstate.tflock` the S3
  # backend's native locking writes beside it — no separate grant and no lock table.
  pull_request_objects = [
    "${local.bucket_arn}/${local.registry_prefix}/pr-*.json",
    "${local.bucket_arn}/${local.state_prefix}/pr-*/*",
  ]

  # The warm slot pool (feat-007). Slot identities live inside the ephemeral namespace,
  # and the constitution's FOURTH named exception is what licenses a pull-request run to
  # touch them: read slot records, and one conditional write — the pool claim.
  #
  # The records deliberately get NO DeleteObject anywhere in this policy: freeing a slot's
  # name is a default-branch act, so a recorded slot is always one the sweep can find and
  # destroy, whatever a pull request's own code does (feat-007/AC-11). Slot STATE mirrors
  # pr-* state exactly, delete included — the S3 backend's lockfile is written and deleted
  # beside the state on every apply, and a claimed slot's re-apply is an apply (chg-001).
  slot_record_objects = ["${local.bucket_arn}/${local.registry_prefix}/slot-*.json"]
  slot_state_objects  = ["${local.bucket_arn}/${local.state_prefix}/slot-*/*"]
}

# ---------------------------------------------------------------------------
# The privileged role — assumable only from the default branch.
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "default_branch_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [local.oidc_provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.oidc_issuer}:aud"
      values   = ["sts.amazonaws.com"]
    }

    # StringEquals, not StringLike, on every one of these. A wildcard here is the classic way
    # this trust model is lost: anything that also accepted a pull request's claims would make
    # the split decorative.
    condition {
      test     = "StringEquals"
      variable = "${local.oidc_issuer}:sub"
      values   = [local.default_branch_subject]
    }
  }
}

resource "aws_iam_role" "default_branch" {
  name               = "${var.name_prefix}-default-branch"
  description        = "Skyhook, running from ${var.repository}@${var.default_branch}. May reach every environment this repository owns, including protection marks."
  assume_role_policy = data.aws_iam_policy_document.default_branch_trust.json
}

data "aws_iam_policy_document" "default_branch_permissions" {
  statement {
    sid     = "ReadWriteThisRepositorysData"
    effect  = "Allow"
    actions = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]

    # GetObject/PutObject/DeleteObject on the state prefix is also exactly what the S3 backend's
    # native lockfile needs: it writes `<state key>.tflock` beside the state, which this prefix
    # already covers. That is what replaces the DynamoDB lock table the earlier prototype used —
    # deprecated upstream now — and it is what keeps skyhook's S3-only constraint honest. The
    # lockfile is itself built on S3 conditional writes, the same primitive a claim uses.
    resources = [
      "${local.bucket_arn}/${local.registry_prefix}/*",
      "${local.bucket_arn}/${local.state_prefix}/*",
      # Only this role may write a protection mark. feat-001/AC-15 rests on this line and on the
      # explicit deny in the pull-request policy below.
      "${local.bucket_arn}/${local.protection_prefix}/*",
    ]
  }

  statement {
    sid       = "ListThisRepositorysData"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [local.bucket_arn]

    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values = [
        "${local.registry_prefix}/*",
        "${local.state_prefix}/*",
        "${local.protection_prefix}/*",
        # chg-008: without this, a HeadObject on the missing default-workspace state answers 403
        # rather than 404, and Terraform cannot tell "forbidden" from "not there".
        "terraform.tfstate",
      ]
    }
  }


  # chg-008 — read only, on exactly this one object. Terraform consults it during init, before a
  # workspace can be selected; skyhook never uses the default workspace and never writes here.
  statement {
    sid       = "ReadTheDefaultWorkspaceStateTerraformInsistsOn"
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = [local.default_workspace_state]
  }

  # Explicit deny on every other repository's data, so a bug in the allow statements above cannot
  # widen this role beyond the installation it belongs to.
  statement {
    sid     = "DenyEverythingOutsideThisRepository"
    effect  = "Deny"
    actions = ["s3:*"]
    not_resources = [
      local.bucket_arn,
      local.default_workspace_state,
      "${local.bucket_arn}/${local.registry_prefix}/*",
      "${local.bucket_arn}/${local.state_prefix}/*",
      "${local.bucket_arn}/${local.protection_prefix}/*",
    ]
  }
}

resource "aws_iam_role_policy" "default_branch" {
  name   = "${var.name_prefix}-default-branch"
  role   = aws_iam_role.default_branch.id
  policy = data.aws_iam_policy_document.default_branch_permissions.json
}

# ---------------------------------------------------------------------------
# The pull-request role — assumable from any pull request on this repository.
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "pull_request_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [local.oidc_provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.oidc_issuer}:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.oidc_issuer}:sub"
      values   = [local.pull_request_subject]
    }
  }
}

resource "aws_iam_role" "pull_request" {
  name = "${var.name_prefix}-pull-request"
  # Plain ASCII, and it has to stay that way. IAM's description pattern stops at Latin-1, so it
  # rejects the typographic punctuation the rest of this file is written in. An em dash here
  # failed the apply outright, after the bucket and the other role had already been created,
  # which is the worst moment to find out. tests/bootstrap-terraform.test.ts guards the class.
  description        = "Skyhook, running from a pull request on ${var.repository}. Confined to the pr-* namespace, and NOT to one pull request within it. Read roles.tf before relying on this."
  assume_role_policy = data.aws_iam_policy_document.pull_request_trust.json
}

# ===========================================================================
# WHERE THE BOUNDARY IS — read this before you rely on this role.
#
# This role reaches EVERY pull request's environment in this repository, not only its own. That
# is a decision, not an oversight, and it is worth knowing which.
#
# The obvious policy would name registry/<repo>/pr-<number>.json, and it cannot be written. IAM
# evaluates a permission policy against attributes of the principal making the request, and the
# pull request number is not one of them. A generic OIDC provider's token claims are condition
# keys while the role is being ASSUMED — that is, in the trust policy above — and they are not
# carried into the permission policy the resulting session evaluates against each request.
# Session tags would carry an attribute across that line, but GitHub Actions emits none. A role
# per pull request would work and does not scale.
#
# So the narrowest static boundary available is the prefix, and that is what is written below.
#
# What this role still cannot do, structurally, whatever skyhook's own code says:
#   - reach a long-running environment (staging, production, anything not named pr-*)
#   - reach another repository's data
#   - write ANY protection mark, or read a long-running environment's. Reading an EPHEMERAL
#     mark is granted, repo-wide, because teardown must honor a mark before destroying and a
#     refusal to read is indistinguishable from absence — the constitution's third named
#     exception, which also states what the repo-wide shape costs
#
# What holds one pull request out of another's environment is skyhook's own TypeScript, which
# derives the identity from the trigger, refuses a supplied one, and asks for credentials
# narrowed to the single environment it claimed. A pull request author can edit the workflow that
# runs it, and a run that never asks for the narrowing never gets it.
#
# WHAT THAT COSTS YOU, stated plainly because it is the part nobody discovers in time:
# Terraform state holds resource attributes in the clear, including any credential your
# infrastructure generates for itself — a database password, a generated key. One preview
# environment can read another's. If your preview environments mint real secrets, they are
# readable by any pull request on this repository.
#
# It could be closed by moving the calling workflow to the default branch and pinning this role's
# trust to it. Skyhook declined that: only a repository collaborator can open a pull request that
# deploys at all — a fork gets no credentials, which is how GitHub mints tokens rather than a
# setting — so the boundary would defend against someone who already holds write access, at the
# cost of depending on one cloud's handling of one CI host's non-standard token claim. See the
# constitution, "Preview environments are not isolated from each other".
# ===========================================================================

data "aws_iam_policy_document" "pull_request_permissions" {
  statement {
    sid       = "ReadWriteOwnEphemeralNamespace"
    effect    = "Allow"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = concat(local.pull_request_objects, local.slot_state_objects)
  }

  # feat-007 — the fourth named exception's grant: slot records may be read (finding a
  # claimable slot, finding one's own by claimant) and conditionally written (the pool
  # claim). Never deleted: no statement in this document grants DeleteObject on a slot
  # record, and the explicit deny below does not exempt them from anything wider.
  statement {
    sid       = "ReadAndClaimSlotRecords"
    effect    = "Allow"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = local.slot_record_objects
  }

  # Belt and braces for the half of AC-11 the cloud owns: even if a later edit widens an
  # allow above, a slot record delete stays refused here.
  statement {
    sid       = "NeverDeleteASlotRecord"
    effect    = "Deny"
    actions   = ["s3:DeleteObject"]
    resources = local.slot_record_objects
  }

  # feat-002/AC-17, and the decision recorded as feat-002 task 0.1. Listing — and ONLY listing —
  # widens from the pr-* namespace to the repository's own registry and state prefixes. Two
  # things need it: Terraform enumerates workspaces by listing at state/<repo>/, and the
  # environment cap counts by listing at registry/<repo>/ (a narrowed session cannot read each
  # record to count them, so a cap check that read them all could not run at all).
  #
  # What this grants is the ability to see that `pr-97` EXISTS. Every GetObject, PutObject and
  # DeleteObject grant above is untouched and still stops at this run's own namespace: a name is
  # not an environment, and no operation on one is permitted by this statement.
  statement {
    sid       = "ListOwnEphemeralNamespace"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [local.bucket_arn]

    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values = [
        "${local.registry_prefix}/pr-*",
        "${local.state_prefix}/pr-*",
        "${local.registry_prefix}/slot-*",
        "${local.state_prefix}/slot-*",
        # feat-007: same HeadObject-on-missing mechanics for a slot's protection mark as
        # for pr-* below — the close fast path honors a slot's mark before destroying.
        "${local.protection_prefix}/slot-*",
        "${local.registry_prefix}/",
        "${local.state_prefix}/",
        # feat-003, the constitution's third exception. Not to list anything: a HeadObject on a
        # MISSING protection mark answers 403 rather than 404 unless the caller could also have
        # listed it — and a missing mark is the common case, which must read as "not there",
        # never as the refusal teardown fails closed on. Same mechanics as terraform.tfstate
        # below (chg-008).
        "${local.protection_prefix}/pr-*",
        # chg-008. Not to list anything: S3 answers a HeadObject on a MISSING object with 403
        # rather than 404 unless the caller could also have listed it, and Terraform cannot tell
        # "forbidden" from "not there". Without this the read granted above is never reached,
        # because the object it permits has never existed.
        "terraform.tfstate",
      ]
    }
  }

  # feat-001/AC-15 — no pull-request run may mark an environment protected, or clear a mark. Not
  # "skyhook won't ask": the cloud refuses it. This is a prefix distinction, which is exactly the
  # kind IAM enforces well, and it is why protection is a separate object rather than a field on
  # a record this very role is allowed to write.
  #
  # feat-003 narrowed this deny from `s3:*` to everything-but-read: teardown must SEE a mark to
  # honor it, and a refusal to read is indistinguishable from absence, so the close fast path
  # could only fail closed forever. What AC-15 protects — that no pull-request run ever sets or
  # clears protection — is exactly as refused as before. The constitution's third named exception
  # records the read, its repo-wide shape, and its cost.
  statement {
    sid         = "DenyAllButReadingProtectionMarks"
    effect      = "Deny"
    not_actions = ["s3:GetObject"]
    resources   = ["${local.bucket_arn}/protected/*"]
  }

  # The read half of the third exception: ephemeral marks only, this repository only. A
  # long-running environment's mark stays unreadable — the deny above spares only GetObject, and
  # this allow names only the pr-* namespace, so everything else still intersects to a refusal.
  statement {
    sid     = "ReadEphemeralProtectionMarks"
    effect  = "Allow"
    actions = ["s3:GetObject"]
    resources = [
      "${local.bucket_arn}/${local.protection_prefix}/pr-*",
      # feat-007: slots are ephemeral too, and their teardown honors a mark the same way.
      # Reads only — the everything-but-read deny above covers slot marks unchanged.
      "${local.bucket_arn}/${local.protection_prefix}/slot-*",
    ]
  }


  # chg-008 — read only, on exactly this one object. Terraform consults it during init, before a
  # workspace can be selected; skyhook never uses the default workspace and never writes here.
  statement {
    sid       = "ReadTheDefaultWorkspaceStateTerraformInsistsOn"
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = [local.default_workspace_state]
  }

  # feat-001/AC-17 — explicit deny on everything outside the ephemeral namespace: every
  # long-running environment, every other repository, and anything skyhook did not provision.
  # The ephemeral protection marks are exempted for the same reason they are allowed above —
  # a grant one statement makes that another denies is no grant at all — and the everything-
  # but-read deny on the protection prefix still stands, so the exemption buys reads alone.
  statement {
    sid     = "DenyEverythingOutsideTheEphemeralNamespace"
    effect  = "Deny"
    actions = ["s3:*"]
    not_resources = concat(
      [local.bucket_arn, local.default_workspace_state],
      local.pull_request_objects,
      # feat-007: the slot namespace is inside the ephemeral fence. Exempting it from
      # this deny grants nothing by itself — the allows above still decide, and slot
      # record deletes have their own explicit deny.
      local.slot_record_objects,
      local.slot_state_objects,
      [
        "${local.bucket_arn}/${local.protection_prefix}/pr-*",
        "${local.bucket_arn}/${local.protection_prefix}/slot-*",
      ],
    )
  }
}

resource "aws_iam_role_policy" "pull_request" {
  name   = "${var.name_prefix}-pull-request"
  role   = aws_iam_role.pull_request.id
  policy = data.aws_iam_policy_document.pull_request_permissions.json
}
