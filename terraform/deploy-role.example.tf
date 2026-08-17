# The deploy role — a STARTING POINT for you to edit, not something skyhook applies.
#
# Skyhook never creates this role and never audits it. It cannot know what your infrastructure
# needs permission to do, and guessing would either break your deploys or hand them your account.
# You declare it, you apply it, you own its blast radius.
#
# Copy this into your own Terraform, fill in the permissions, and apply it with the same
# deliberate step that applied skyhook's bootstrap. Skyhook finds it by name — see D4: the ARN is
# derived from your account id and a prefix, so it never gets typed into a settings file where it
# could drift from the role that actually exists.

variable "skyhook_repository" {
  description = "owner/name of the repository skyhook deploys, e.g. acme/storefront."
  type        = string
}

variable "skyhook_oidc_provider_arn" {
  description = "The GitHub OIDC provider in this account. The bootstrap prints it; it is shared, not skyhook's to own."
  type        = string
}

variable "skyhook_subject_prefix" {
  description = "The prefix of the OIDC subject a run in your repository presents. Usually repo:<owner>/<name>. If your organization issues ID-qualified subjects it is repo:<owner>@<owner_id>/<name>@<repo_id>, and the plain form refuses every assumption -- the symptom is AccessDenied and nothing else. The bootstrap prints the one that applies to you."
  type        = string
}

variable "skyhook_role_prefix" {
  description = "Matches deploy.role_prefix in .skyhook/config.yml. Skyhook looks for <prefix>-deploy."
  type        = string
  default     = "skyhook"
}

variable "skyhook_default_branch" {
  description = "The repository's default branch. The scheduled sweep runs from it and must assume this role to destroy what a pull request's own run created."
  type        = string
  default     = "main"
}

data "aws_iam_policy_document" "skyhook_deploy_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [var.skyhook_oidc_provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    # StringEquals, not StringLike. A wildcard here is the classic way this trust model is lost:
    # `repo:acme/*` trusts every repository in the org, and `repo:acme/storefront:*` trusts every
    # branch and every tag, including ones a contributor can create.
    #
    # TWO subjects, and it is worth knowing what the second one costs. The pull-request subject
    # is what deploys and what the close fast path destroys with. The default-branch subject is
    # what the scheduled SWEEP presents — without it, nothing can destroy an environment whose
    # close event was missed, and cleanup stops being a guarantee. The price, stated plainly:
    # skyhook's own default-branch role is the widest identity in this setup (it reaches every
    # environment's record, state, and protection mark), and any run that holds the default-branch
    # subject can now also assume THIS role and do whatever its permissions allow. That is one
    # more reason to grant this role exactly what one preview environment needs and nothing more.
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values = [
        "${var.skyhook_subject_prefix}:pull_request",
        "${var.skyhook_subject_prefix}:ref:refs/heads/${var.skyhook_default_branch}",
      ]
    }
  }
}

# ===========================================================================
# WHAT THIS TRUST DOES AND DOES NOT BUY YOU
#
# It buys: only a pull-request run on THIS repository can assume this role. Not another
# repository, not a tag, not a fork — GitHub issues a fork's pull request no token at all.
#
# It does NOT buy: any distinction between one pull request and another, or between a job that
# runs skyhook and a job that does not. Every pull request on this repository can assume this
# role, including one whose workflow was edited on its own branch to do something else with it
# entirely — apply resources skyhook never recorded, or reach a sibling preview environment.
#
# That is not a new exposure introduced by the trust policy: a pull request could always run
# arbitrary Terraform under this role by editing the definition skyhook applies, and skyhook does
# not audit that either. What it means is that this role's PERMISSIONS are the real boundary, so
# grant it what one preview environment needs and nothing more. Anything you would not hand to
# any collaborator who can open a pull request does not belong here.
#
# Narrowing it further — to a specific workflow file, say — is possible and skyhook does not do
# it. See the constitution, "Preview environments are not isolated from each other".
# ===========================================================================

resource "aws_iam_role" "skyhook_deploy" {
  name               = "${var.skyhook_role_prefix}-deploy"
  description        = "Builds preview environments for ${var.skyhook_repository}. Assumable by any pull-request run on that repository."
  assume_role_policy = data.aws_iam_policy_document.skyhook_deploy_trust.json

  # Sized to a slow apply, not to the one-hour default. The consuming repository's Terraform runs
  # in the same process as these credentials and can read them out of the environment — an
  # inherent consequence of letting a repository deploy itself, not a defect. What is a choice is
  # how long a credential stays useful after it leaks.
  max_session_duration = 3600
}

# YOUR INFRASTRUCTURE NEEDS GO HERE.
#
# Deliberately empty. An example with plausible-looking permissions is the worst of both worlds:
# too narrow to work, wide enough to copy without reading. Grant what one preview environment
# actually creates.
#
# resource "aws_iam_role_policy" "skyhook_deploy" {
#   name   = "${var.skyhook_role_prefix}-deploy"
#   role   = aws_iam_role.skyhook_deploy.id
#   policy = data.aws_iam_policy_document.your_permissions.json
# }
