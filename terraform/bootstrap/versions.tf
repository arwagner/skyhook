# Skyhook bootstrap — the trust anchor, the roles, and the one bucket.
#
# This is applied by a human, once, with credentials that already exist. Keyless access to a
# cloud account cannot bootstrap itself: the OIDC provider and the roles are what make keyless
# access possible, so they cannot themselves be created keylessly. That is a property of the
# trust model, not a gap to close later.
#
# Skyhook never applies this. The init command writes it for you to read and apply yourself.

terraform {
  # This file itself declares no backend and would run on older Terraform. The floor is here to
  # fail an operator fast, at install time, rather than later: managed environments' state uses
  # the S3 backend's native lockfile (`use_lockfile`), which arrived in 1.10, and that lockfile is
  # what lets skyhook keep its S3-only constraint honest without a second store. Better to be
  # refused while creating a bucket than after standing up an environment that cannot lock.
  required_version = ">= 1.10.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  # Deliberately empty. The bucket this state lives in is a resource this very configuration
  # creates, so on a first apply there is nowhere to put the state yet. `skyhook bootstrap`
  # resolves the circle: it applies with local state, then re-initializes with this backend and
  # migrates. Bucket, key and region are supplied as -backend-config at that point, from the same
  # .skyhook/config.yml everything else reads.
  #
  # The key is deliberately outside the `state/` prefix that managed environments use, and no role
  # this configuration creates is granted access to it — so nothing skyhook runs can read the
  # shape of its own boundary, let alone rewrite it.
  backend "s3" {}
}

provider "aws" {
  region = var.aws_region
}
