# The trust anchor. GitHub Actions presents a short-lived OIDC token; AWS exchanges it for
# short-lived credentials. No long-lived cloud access key exists anywhere in this installation,
# which is what feat-001/AC-11 is about.

## The provider is created OR adopted, never both.
##
## An IAM OIDC provider is unique per URL per account. Any account already federating GitHub
## Actions to AWS — which is most accounts that use both — already has one, and it belongs to
## whoever created it. Skyhook adopts it there and manages only its own roles: taking ownership
## would let a later apply rewrite that provider's thumbprints or client IDs and break the
## workloads already trusting it.

resource "aws_iam_openid_connect_provider" "github" {
  count = var.create_oidc_provider ? 1 : 0

  url = "https://token.actions.githubusercontent.com"

  client_id_list = ["sts.amazonaws.com"]

  # No thumbprint is pinned. AWS validates this issuer against its own trusted certificate
  # authorities, so a pinned fingerprint here would be a value that rots on GitHub's next
  # certificate rotation while adding nothing — a stale pin fails closed at the worst moment.
  thumbprint_list = []
}

data "aws_iam_openid_connect_provider" "github" {
  count = var.create_oidc_provider ? 0 : 1

  url = "https://token.actions.githubusercontent.com"
}

locals {
  oidc_provider_arn = (
    var.create_oidc_provider
    ? one(aws_iam_openid_connect_provider.github[*].arn)
    : one(data.aws_iam_openid_connect_provider.github[*].arn)
  )

  oidc_issuer = "token.actions.githubusercontent.com"

  # THE SUBJECT A WORKFLOW PRESENTS. This is the load-bearing string in this whole file: the two
  # roles below differ only in which subject they trust, and a pull request cannot change the
  # subject its own workflow presents. Matched with StringEquals, never StringLike.
  #
  # Why the subject and not the immutable repository and owner ids, which would be the better
  # design — ids survive a rename and a transfer, and the subject does not. Because AWS refuses:
  # a trust policy for this provider that conditions on neither `sub` nor `job_workflow_ref` is
  # rejected outright with MalformedPolicyDocument. There is no choice to make here.
  #
  # Why the prefix is a VARIABLE rather than "repo:${var.repository}". An organization may issue
  # ID-qualified subjects, where a run presents
  # `repo:owner@26345547/name@1335111920:pull_request` instead. That is GitHub's defence against a
  # resurrection attack: delete a repository, recreate the name, inherit its trust. In such an
  # organization a policy hard-coding the plain name refuses every assumption and explains itself
  # with nothing but AccessDenied. `skyhook bootstrap` asks GitHub which form applies and passes
  # it here, so neither skyhook nor the operator has to guess.
  default_branch_subject = "${var.subject_prefix}:ref:refs/heads/${var.default_branch}"
  pull_request_subject   = "${var.subject_prefix}:pull_request"
}
