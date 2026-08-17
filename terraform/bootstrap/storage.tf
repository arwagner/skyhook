# The one bucket. It holds three things, each under its own prefix:
#
#   registry/<repo>/<identity>.json          one object per environment
#   protected/<repo>/<identity>              the protection mark, kept apart from the record
#   state/<repo>/<identity>/terraform.tfstate the managed environment's Terraform state
#
# Protection lives at its own key rather than as a field inside the record because a bucket policy
# restricts which KEYS a role may write and cannot inspect what is inside one. That separation is
# what turns "skyhook's code refuses it" into "the cloud refuses it".

resource "aws_s3_bucket" "skyhook" {
  bucket = var.bucket_name
}

# feat-001/AC-8 — registry data is encrypted at rest.
resource "aws_s3_bucket_server_side_encryption_configuration" "skyhook" {
  bucket = aws_s3_bucket.skyhook.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

# feat-001/AC-8 — the bucket denies public access. All four, so no later console click reopens it.
resource "aws_s3_bucket_public_access_block" "skyhook" {
  bucket = aws_s3_bucket.skyhook.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Versioning is the undo for a registry a bad run corrupts, and the Terraform S3 backend expects it.
resource "aws_s3_bucket_versioning" "skyhook" {
  bucket = aws_s3_bucket.skyhook.id

  versioning_configuration {
    status = "Enabled"
  }
}

# ACLs off entirely. Every grant in this installation is an IAM policy, and having exactly one
# mechanism means there is exactly one place to read to know who can reach what.
resource "aws_s3_bucket_ownership_controls" "skyhook" {
  bucket = aws_s3_bucket.skyhook.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# HTTPS only. A plaintext request is refused rather than quietly downgraded.
resource "aws_s3_bucket_policy" "skyhook" {
  bucket = aws_s3_bucket.skyhook.id
  policy = data.aws_iam_policy_document.bucket.json

  depends_on = [aws_s3_bucket_public_access_block.skyhook]
}

data "aws_iam_policy_document" "bucket" {
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]

    resources = [
      aws_s3_bucket.skyhook.arn,
      "${aws_s3_bucket.skyhook.arn}/*",
    ]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}
