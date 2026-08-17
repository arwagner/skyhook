import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_INLINE_POLICY_LENGTH, sessionPolicyFor } from '../src/adapters/aws/session-policy.ts';

const REQUEST = { bucket: 'skyhook-acme', repository: 'acme/widgets', identity: 'pr-482' };
// GitHub's own maxima: a 39-character owner, a 100-character repository name, a bucket at
// S3's 63-character limit, and a pull request number far past any real one.
const WORST = {
  bucket: 'a'.repeat(63),
  repository: `${'o'.repeat(39)}/${'n'.repeat(100)}`,
  identity: `pr-${'9'.repeat(9)}`,
};

interface Statement {
  readonly Sid: string;
  readonly Effect: string;
  readonly Action: readonly string[];
  readonly Resource?: string | readonly string[];
  readonly NotResource?: readonly string[];
  readonly Condition?: { readonly StringLike?: { readonly 's3:prefix'?: readonly string[] } };
}

function statements(policy: string): readonly Statement[] {
  return (JSON.parse(policy) as { Statement: Statement[] }).Statement;
}

test('feat-003/AC-14 the teardown narrowing names exactly one environment’s keys', async () => {
  const policy = sessionPolicyFor({ ...REQUEST, readProtection: true });
  const everyArn = statements(policy).flatMap((s) => [
    ...(Array.isArray(s.Resource) ? s.Resource : typeof s.Resource === 'string' ? [s.Resource] : []),
    ...(s.NotResource ?? []),
  ]);
  const objectArns = everyArn.filter(
    (arn) => arn.includes('/registry/') || arn.includes('/state/') || arn.includes('/protected/'),
  );
  assert.ok(objectArns.length > 0);
  for (const arn of objectArns) {
    assert.match(arn, /pr-482/, `an object grant names no identity: ${arn}`);
  }
});

test('the protection marker is readable, listable for 404s, and never writable', async () => {
  // feat-003 plan D3a: teardown must be able to see its own environment's marker — and a
  // MISSING marker must answer "not there" rather than "refused", which needs the list
  // prefix. Writes and deletes are never asked for, at any layer.
  const policy = sessionPolicyFor({ ...REQUEST, readProtection: true });
  const marker = 'protected/acme/widgets/pr-482';

  const readOnly = statements(policy).find((s) => s.Sid === 'ReadOnly');
  assert.ok(readOnly !== undefined);
  assert.deepEqual(readOnly.Action, ['s3:GetObject']);
  assert.ok((readOnly.Resource as readonly string[]).some((arn) => arn.endsWith(marker)));

  const list = statements(policy).find((s) => s.Sid === 'List');
  assert.ok(list?.Condition?.StringLike?.['s3:prefix']?.includes(marker));

  for (const statement of statements(policy)) {
    if (statement.Effect !== 'Allow') continue;
    if (!statement.Action.includes('s3:PutObject') && !statement.Action.includes('s3:DeleteObject')) continue;
    const resources = Array.isArray(statement.Resource) ? statement.Resource : [statement.Resource];
    for (const arn of resources) {
      assert.ok(!String(arn).includes('/protected/'), `a write grant reaches the protection prefix: ${String(arn)}`);
    }
  }
});

test('the deploy variant is untouched: no marker anywhere, the deny still present', async () => {
  // feat-002's AC-19 says "the two named exceptions and nothing further", and until task
  // 5.2 moves that sentence, the deploy path's policy must stay exactly what it shipped.
  const policy = sessionPolicyFor(REQUEST);
  assert.ok(!policy.includes('protected/'), 'the deploy variant mentions the protection prefix');
  const deny = statements(policy).find((s) => s.Sid === 'NoOthers');
  assert.equal(deny?.Effect, 'Deny');
});

test('both variants’ worst plausible repositories fit the inline-policy ceiling', async () => {
  // Exceeding 2048 characters fails at assume time, in CI, where no test sees it.
  for (const readProtection of [false, true]) {
    const policy = sessionPolicyFor({ ...WORST, readProtection });
    assert.ok(
      policy.length <= MAX_INLINE_POLICY_LENGTH,
      `the ${readProtection ? 'teardown' : 'deploy'} policy is ${policy.length} characters; the ceiling is ${MAX_INLINE_POLICY_LENGTH}`,
    );
  }
});
