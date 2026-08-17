variable "repository" {
  description = "The consuming repository, as owner/name. Becomes a path segment in every key, so two repositories never collide."
  type        = string

  validation {
    # The same shape src/core/registry.ts enforces. An identity or repository able to escape its
    # prefix would walk straight through the policy boundary below, so both ends check.
    condition     = can(regex("^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*$", var.repository))
    error_message = "repository must be owner/name, using letters, digits, '.', '_' or '-'."
  }
}

variable "bucket_name" {
  description = "The one bucket holding skyhook's registry and the Terraform state of managed environments. S3 bucket names are globally unique across all of AWS, so you pick this rather than skyhook deriving it."
  type        = string
}

variable "aws_region" {
  description = "Region for the bucket and the roles."
  type        = string
}

variable "default_branch" {
  description = "The branch whose workflows may assume the privileged role. A pull request cannot change what this names, which is the whole point."
  type        = string
  default     = "main"
}

variable "create_oidc_provider" {
  description = <<-EOT
    Whether to create the GitHub OIDC provider, or adopt one that already exists.

    An IAM OIDC provider is unique per URL per account, so if anything else in this account
    already federates GitHub Actions to AWS, one exists and skyhook must not create a second.
    Set this to false there. Skyhook then reads the existing provider and only points its own
    roles at it -- it never manages it, because that provider belongs to whoever created it and
    changing its thumbprints or client IDs would break them.

    Leave it true for an account where skyhook is the first thing to federate GitHub Actions.
    If you get EntityAlreadyExists on apply, that is this: set it to false and apply again.
  EOT
  type        = bool
  default     = true
}

variable "name_prefix" {
  description = "Prefix for the IAM role names, so one account can host several installations."
  type        = string
  default     = "skyhook"
}

variable "subject_prefix" {
  description = "The prefix of the OIDC subject a run in this repository presents. Usually repo:<owner>/<name>, but an organization issuing ID-qualified subjects presents repo:<owner>@<owner_id>/<name>@<repo_id>, and a trust policy hard-coding the plain form refuses every assumption there. `skyhook bootstrap` asks GitHub which form applies and passes it in."
  type        = string

  validation {
    condition     = startswith(var.subject_prefix, "repo:")
    error_message = "subject_prefix must start with repo:."
  }
}
