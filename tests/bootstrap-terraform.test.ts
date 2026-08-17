import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Reads `terraform/bootstrap/` as data. Applies nothing, needs no cloud account.
 *
 * These assertions are deliberately about the *policy documents*, because the policy — not the
 * TypeScript — is what the security criteria rest on. A pull request can edit the TypeScript on
 * its own branch; it cannot edit the trust policy that issued its credentials.
 */

const BOOTSTRAP = new URL('../terraform/bootstrap/', import.meta.url).pathname;

function source(file: string): string {
  return readFileSync(join(BOOTSTRAP, file), 'utf8');
}

const ALL = readdirSync(BOOTSTRAP)
  .filter((f) => f.endsWith('.tf'))
  .map((f) => source(f))
  .join('\n');

test('feat-001/AC-8 the bucket encrypts at rest and blocks public access', () => {
  const storage = source('storage.tf');

  assert.match(storage, /aws_s3_bucket_server_side_encryption_configuration/);
  assert.match(storage, /sse_algorithm\s*=\s*"AES256"/);

  // Access is granted by policy alone: ACLs off, so there is one mechanism to read.
  assert.match(storage, /object_ownership\s*=\s*"BucketOwnerEnforced"/);
  // And no plaintext request is quietly served.
  assert.match(storage, /sid\s*=\s*"DenyInsecureTransport"/);
  assert.match(storage, /variable\s*=\s*"aws:SecureTransport"/);

  assert.match(storage, /aws_s3_bucket_public_access_block/);
  // All four, so no later console click reopens it.
  for (const setting of [
    'block_public_acls',
    'block_public_policy',
    'ignore_public_acls',
    'restrict_public_buckets',
  ]) {
    assert.match(
      storage,
      new RegExp(`${setting}\\s*=\\s*true`),
      `${setting} must be explicitly true`,
    );
  }
});

test('feat-001/AC-17 the pull-request role is confined to the ephemeral namespace', () => {
  const roles = source('roles.tf');

  // What it may reach: only pr-* objects, in this repository.
  assert.match(roles, /pull_request_objects\s*=\s*\[/);
  assert.match(roles, /registry_prefix\}\/pr-\*\.json/);
  assert.match(roles, /state_prefix\}\/pr-\*\/\*/);

  // An explicit deny on everything outside that set — the constitution asks for explicit deny,
  // not merely for an absent allow.
  assert.match(roles, /sid\s*=\s*"DenyEverythingOutsideTheEphemeralNamespace"/);
  // feat-001/AC-29, amended by feat-003 — the deny carves out exactly three things beyond the
  // ephemeral namespace: the bucket itself, the one state key the backend consults before a
  // workspace can be selected (chg-008), and the repository's own ephemeral protection marks
  // (the constitution's third exception — reads only, since the everything-but-read deny on the
  // protection prefix still stands).
  // Nothing else may join that list without a delta — this assertion is where that is enforced.
  assert.match(
    roles,
    /not_resources\s*=\s*concat\(\s*\[local\.bucket_arn, local\.default_workspace_state\],\s*local\.pull_request_objects,\s*\["\$\{local\.bucket_arn\}\/\$\{local\.protection_prefix\}\/pr-\*"\],\s*\)/,
  );
  // And that key is READ-only. A write to it must still be refused, or a pull request could
  // plant a default-workspace state for the next run to pick up.
  assert.match(roles, /sid\s*=\s*"ReadTheDefaultWorkspaceStateTerraformInsistsOn"/);
  const readOnly = roles.slice(roles.indexOf('ReadTheDefaultWorkspaceStateTerraformInsistsOn'));
  assert.match(readOnly.slice(0, 300), /actions\s*=\s*\["s3:GetObject"\]/, 'read only, never write');
});

test('feat-001/AC-15 the pull-request role is denied every protection-mark write', () => {
  // Amended by feat-003 (the constitution's third exception): the deny narrowed from s3:* to
  // everything-but-read, so teardown can SEE a mark. What AC-15 protects — no pull-request run
  // ever sets or clears protection — is exactly as refused as before: the deny's not_actions
  // spares GetObject alone.
  const roles = source('roles.tf');

  assert.match(roles, /sid\s*=\s*"DenyAllButReadingProtectionMarks"/);
  const deny = roles.slice(roles.indexOf('DenyAllButReadingProtectionMarks'));
  assert.match(deny.slice(0, 300), /not_actions\s*=\s*\["s3:GetObject"\]/);
  assert.match(deny.slice(0, 300), /resources\s*=\s*\["\$\{local\.bucket_arn\}\/protected\/\*"\]/);

  // The read half stays confined to the repository's own ephemeral marks.
  assert.match(roles, /sid\s*=\s*"ReadEphemeralProtectionMarks"/);
  const read = roles.slice(roles.indexOf('ReadEphemeralProtectionMarks'));
  assert.match(read.slice(0, 300), /actions\s*=\s*\["s3:GetObject"\]/);
  assert.match(read.slice(0, 300), /protection_prefix\}\/pr-\*/);

  // The privileged role is the only one that may write one.
  assert.match(roles, /protection_prefix\}\/\*/);
});

test('feat-001/AC-17 the two roles are separated by trust policy, with no wildcard subject', () => {
  const roles = source('roles.tf');
  const oidc = source('oidc.tf');

  // The subject's PREFIX is a variable, never the hard-coded `repo:${var.repository}`. An
  // organization issuing ID-qualified subjects presents
  // `repo:owner@26345547/name@1335111920:pull_request`, and a policy hard-coding the plain form
  // refuses every assumption there with nothing but AccessDenied. Found live, against a real
  // token, after the plain form had been shipped.
  assert.match(oidc, /default_branch_subject\s*=\s*"\$\{var\.subject_prefix\}:ref:refs\/heads\//);
  assert.match(oidc, /pull_request_subject\s*=\s*"\$\{var\.subject_prefix\}:pull_request"/);
  assert.doesNotMatch(
    oidc,
    /_subject\s*=\s*"repo:\$\{var\.repository\}/,
    'the subject prefix must not be hard-coded: its form is the organization\'s choice',
  );

  // Matching the immutable repository and owner ids instead would be the better design, and AWS
  // rejects it: a trust policy for this provider that conditions on neither `sub` nor
  // `job_workflow_ref` is refused with MalformedPolicyDocument. So both roles pin a subject.
  const subjectConditions = [...roles.matchAll(/variable = "\$\{local\.oidc_issuer\}:sub"/g)];
  assert.equal(subjectConditions.length, 2, 'both roles pin a subject');

  // A wildcard in a TRUST policy is the classic way this model is lost. Scoped to the two trust
  // documents on purpose: the permissions policies use StringLike legitimately, on `s3:prefix`.
  const trustDocuments = [...roles.matchAll(/data "aws_iam_policy_document" "\w+_trust" \{/g)].map(
    (match) => roles.slice(match.index, roles.indexOf('\n}\n', match.index)),
  );
  assert.equal(trustDocuments.length, 2, 'both trust documents found');
  for (const document of trustDocuments) {
    // Comments stripped first: this file explains at length why it does not use StringLike, and
    // an assertion that reads the explanation as the offence is an assertion nobody can satisfy.
    const code = document.replace(/^\s*#.*$/gm, '');
    assert.doesNotMatch(code, /StringLike/, 'no trust condition may use a wildcard');
  }

  // And the audience is pinned, so a token minted for another audience is refused.
  assert.match(roles, /variable = "\$\{local\.oidc_issuer\}:aud"/);
});

test('feat-001/AC-11 the bootstrap declares no long-lived credential', () => {
  // The whole point of the OIDC provider is that no access key exists to leak.
  assert.match(ALL, /aws_iam_openid_connect_provider/);
  assert.doesNotMatch(ALL, /aws_iam_access_key/);
  assert.doesNotMatch(ALL, /AKIA[0-9A-Z]{16}/);
  assert.doesNotMatch(ALL, /secret_key\s*=/);
});

test('feat-001/AC-18 the bootstrap states where the boundary is, and what it costs, where they are read', () => {
  // It must appear both beside the policy (for whoever reads the source) and in an output (for
  // whoever only runs apply). chg-001 changed what has to be said: this stopped being a gap
  // awaiting a fix and became a decision, and a decision an operator is not told the price of is
  // worse than a gap they were warned about.
  const roles = source('roles.tf');
  assert.match(roles, /WHERE THE BOUNDARY IS/);
  assert.match(roles, /reaches EVERY pull request's environment/i);
  assert.match(roles, /decision, not an oversight/i);
  assert.match(roles, /state holds resource attributes in the clear/i, 'never says what it costs');
  assert.doesNotMatch(roles, /To close this:/, 'still promises a fix that was declined');

  const outputs = source('outputs.tf');
  assert.match(outputs, /output "known_limit_pull_request_isolation"/);
  assert.match(outputs, /not only its own/i);
  assert.match(outputs, /WHAT THAT COSTS YOU/);
  assert.match(outputs, /decision rather than a gap/i);
});

test('feat-002/AC-17 listing widens to the repository, and no object grant moves with it', () => {
  // Task 0.1's decision. Terraform enumerates workspaces by listing at state/<repo>/ and the cap
  // counts by listing at registry/<repo>/, so the pull-request role must see those prefixes. The
  // whole point is that seeing a name is not reaching an environment — so the object grants have
  // to be asserted unchanged in the same breath, or this widening is exactly the silent one the
  // criterion forbids.
  const roles = source('roles.tf');

  assert.match(roles, /"\$\{local\.registry_prefix\}\/",/, 'cannot enumerate the registry');
  assert.match(roles, /"\$\{local\.state_prefix\}\/",/, 'cannot enumerate workspaces');

  // Unchanged: every object action still stops at this run's own pr-* namespace.
  const objects = roles.slice(roles.indexOf('pull_request_permissions'));
  assert.match(objects, /actions\s*=\s*\["s3:GetObject", "s3:PutObject", "s3:DeleteObject"\]\s*\n\s*resources = local\.pull_request_objects/);
  assert.match(roles, /pr-\*\.json/);
  assert.match(roles, /pr-\*\/\*/);
});

test('feat-002/AC-11 the bootstrap hands back the account id skyhook derives its roles from', () => {
  // Plan D4: no role ARN is ever typed into a settings file, so the account id has to come out of
  // the apply that already knows it.
  const outputs = source('outputs.tf');
  assert.match(outputs, /output "account_id"/);
  assert.match(outputs, /aws_caller_identity/);
  assert.match(source('roles.tf'), /data "aws_caller_identity" "current"/);
});

test('feat-001/AC-19 the OIDC provider is created or adopted, and never managed when adopted', () => {
  // An IAM OIDC provider is unique per URL per account, so any account already federating GitHub
  // Actions to AWS has one — and it belongs to whoever created it. Taking ownership would let a
  // later apply rewrite its thumbprints or client IDs and break the workloads already trusting it.
  const oidc = source('oidc.tf');

  assert.match(oidc, /resource "aws_iam_openid_connect_provider" "github"/);
  assert.match(oidc, /data "aws_iam_openid_connect_provider" "github"/);

  // Exactly one of the two is live, decided by the variable.
  assert.match(oidc, /count\s*=\s*var\.create_oidc_provider \? 1 : 0/);
  assert.match(oidc, /count\s*=\s*var\.create_oidc_provider \? 0 : 1/);

  // Both roles must reference the resolved ARN, never the resource directly — a direct reference
  // would break outright in the adopt case.
  const roles = source('roles.tf');
  assert.doesNotMatch(roles, /aws_iam_openid_connect_provider\.github\.arn/);
  assert.equal(
    [...roles.matchAll(/identifiers = \[local\.oidc_provider_arn\]/g)].length,
    2,
    'both trust policies resolve the provider the same way',
  );
});

test('bootstrap: state locking needs no second store, and no lock table is declared', () => {
  // D4: the S3 backend's native lockfile (Terraform 1.10+) writes `<state key>.tflock` beside
  // the state and needs Get/Put/DeleteObject on it. Both roles' state grants already cover that
  // path, so the DynamoDB table the earlier prototype used — deprecated upstream — is gone, and
  // the S3-only constraint holds.
  const roles = source('roles.tf');
  assert.match(roles, /tflock/, 'the lockfile is accounted for where the grant is made');
  assert.match(roles, /"s3:GetObject", "s3:PutObject", "s3:DeleteObject"/);

  // Declarations, not prose — the comment above the grant explains what DynamoDB used to do here.
  assert.doesNotMatch(ALL, /resource\s+"aws_dynamodb/, 'no second store is provisioned');
  assert.doesNotMatch(ALL, /dynamodb:/i, 'and no role is granted DynamoDB actions');
});

test('bootstrap: provider and Terraform versions are pinned', () => {
  const versions = source('versions.tf');
  assert.match(versions, /required_version\s*=\s*">= 1\.10\.0"/);
  assert.match(versions, /source\s*=\s*"hashicorp\/aws"/);
  assert.match(versions, /version\s*=\s*"~> 6\.0"/);
});

test('feat-001/AC-17 the privileged role is confined to its own repository too', () => {
  // Neither role can reach an installation that is not its own. The constitution requires
  // this of pull-request roles; applying it to the privileged role as well means a bug in
  // one allow statement cannot widen it past the installation it belongs to.
  const roles = source('roles.tf');
  assert.match(roles, /sid\s*=\s*"DenyEverythingOutsideThisRepository"/);
  assert.match(roles, /not_resources = \[\n\s*local\.bucket_arn,/);
});

test('feat-001/AC-3 every IAM description stays inside the character set IAM accepts', () => {
  // Found by the first live apply, not by anything in this file. IAM's description pattern is
  // [\u0009\u000A\u000D\u0020-\u007E\u00A1-\u00FF] - it stops at Latin-1, so it rejects the
  // typographic punctuation these files are otherwise written in. An em dash in one role's
  // description failed CreateRole outright, and it failed AFTER the bucket and the other role
  // had been created: a half-applied bootstrap, which is the expensive kind of wrong.
  //
  // Asserts the whole class rather than the one character, because the next one will be a curly
  // quote or an ellipsis, and every comment around these strings is written in exactly that style.
  const permitted = /^[\u0009\u000A\u000D\u0020-\u007E\u00A1-\u00FF]*$/;

  // Every .tf in the bootstrap, by name, so a failure says which file to open. `ALL` is the
  // joined source rather than a file list.
  for (const file of readdirSync(BOOTSTRAP).filter((f) => f.endsWith('.tf'))) {
    for (const [, value] of source(file).matchAll(
      /^\s*description\s*=\s*"((?:[^"\\]|\\.)*)"/gm,
    )) {
      const offenders = [...(value ?? '')].filter((c) => !permitted.test(c));
      assert.equal(
        offenders.length,
        0,
        `${file}: description holds ${offenders
          .map((c) => `U+${c.codePointAt(0)?.toString(16).toUpperCase()} ${JSON.stringify(c)}`)
          .join(', ')} — IAM will refuse it`,
      );
    }
  }
});

test('feat-001/AC-34 what the roles trust is fixed at apply time and can only narrow', () => {
  const roles = source('roles.tf');
  const oidc = source('oidc.tf');

  // chg-009 reads the subject's form from a REPOSITORY SETTING, which is mutable and outside the
  // repository's files. What makes that acceptable is this property, so it is asserted rather
  // than left for a reviewer to reconstruct: the value is baked into a static policy document at
  // apply time, and every way of getting it wrong yields a policy that matches LESS, never more.
  const trustDocuments = [...roles.matchAll(/data "aws_iam_policy_document" "\w+_trust" \{/g)].map(
    (match) => roles.slice(match.index, roles.indexOf('\n}\n', match.index)),
  );
  assert.equal(trustDocuments.length, 2, 'both trust documents found');

  for (const document of trustDocuments) {
    const code = document.replace(/^\s*#.*$/gm, '');

    // Pinned: the subject is compared for equality against one literal value. Equality against a
    // wrong value matches nothing, which is why a stale or fallen-back prefix costs an install
    // that does not work rather than one that trusts too much.
    assert.match(code, /test\s*=\s*"StringEquals"/, 'the subject is matched by equality');
    assert.doesNotMatch(code, /StringLike/);

    // Fixed at apply time: nothing in a trust document may be read at request time. A data source
    // or a wildcard here would make what the roles trust depend on something that can change
    // after the operator reviewed and applied it.
    assert.doesNotMatch(code, /\bdata\.\w+/, 'a trust condition may not resolve anything live');
  }

  // One subject value per role, built by appending a trigger-derived suffix to whatever was
  // discovered. Skyhook composes the suffix itself, so no answer from the lookup can make a
  // pull-request run present the default branch's subject.
  assert.match(oidc, /default_branch_subject\s*=\s*"\$\{var\.subject_prefix\}:ref:refs\/heads\//);
  assert.match(oidc, /pull_request_subject\s*=\s*"\$\{var\.subject_prefix\}:pull_request"/);
  // Scoped to the one variable's own block. Matching from its name to the first `default =` in
  // the file would read the NEXT variable's default as this one's, so it would start failing the
  // day someone declares a variable below it.
  const variables = source('variables.tf');
  const declaration = variables.split(/^variable "/m).find((block) => block.startsWith('subject_prefix"'));
  assert.ok(declaration !== undefined, 'subject_prefix must be declared');
  assert.doesNotMatch(
    declaration,
    /^\s*default\s*=/m,
    'a default would silently restore the assumption chg-009 removed',
  );
});
