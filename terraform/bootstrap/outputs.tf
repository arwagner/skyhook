output "bucket_name" {
  description = "Put this in .skyhook/config.yml as storage.bucket. Skyhook never creates this bucket; if it is missing at run time, skyhook stops and names it rather than creating a resource Terraform believes it owns."
  value       = aws_s3_bucket.skyhook.bucket
}

output "region" {
  description = "Put this in .skyhook/config.yml as storage.region."
  value       = var.aws_region
}

output "default_branch_role_arn" {
  description = "Assume this from workflows on the default branch. It may create and destroy infrastructure, and it is the only role that may write a protection mark."
  value       = aws_iam_role.default_branch.arn
}

output "pull_request_role_arn" {
  description = "Assume this from pull-request workflows. Confined to the pr-* namespace."
  value       = aws_iam_role.pull_request.arn
}

output "account_id" {
  description = "Put this in .skyhook/config.yml as storage.account. Skyhook derives the role names it assumes from it, so no role ARN is ever typed into your settings or your workflow."
  value       = data.aws_caller_identity.current.account_id
}

# feat-001/AC-18 — the boundary is stated where an operator reads it, not only in the
# specification. `terraform apply` prints this. A limit nobody is told about is a limit nobody
# plans around.
output "known_limit_pull_request_isolation" {
  description = "Where the boundary around a pull-request run is drawn, and what that costs you."
  value       = <<-EOT
    The pull-request role reaches EVERY pr-* environment in this repository, not only its own.
    This is a decision rather than a gap awaiting a fix.

    It cannot reach a long-running environment, another repository, or any protection mark —
    those boundaries are enforced by the cloud. Between two preview environments there is no
    such boundary: skyhook asks for credentials narrowed to the one environment it claimed,
    which keeps an honest run out of a sibling's, and a run that never asks never gets it.

    WHAT THAT COSTS YOU: Terraform state holds resource attributes in the clear, including any
    credential your infrastructure generates for itself. One preview environment can read
    another's state. If your previews mint real secrets, treat them as readable by any pull
    request on this repository.

    Why it is not closed: an IAM permission policy cannot name the pull request number, so
    closing it would mean pinning this role's trust to a workflow on the default branch. Only a
    repository collaborator can open a pull request that deploys at all, so that would defend
    against someone who already holds write access. See roles.tf, and the constitution's
    "Preview environments are not isolated from each other".
  EOT
}
