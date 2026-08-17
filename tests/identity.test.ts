import { test } from 'node:test';
import assert from 'node:assert/strict';
import { derivedIdentityFor, identityFor } from '../src/core/identity.ts';

test('feat-001/AC-14 a pull-request run gets only the identity derived from its trigger', () => {
  // AC-14: a run triggered by a pull request cannot claim or modify any environment
  // other than the one derived from its trigger.
  const outcome = identityFor({
    kind: 'pull-request',
    repository: 'acme/widgets',
    pullRequestNumber: 482,
  });
  assert.deepEqual(outcome, { ok: true, identity: 'pr-482' });
  assert.equal(derivedIdentityFor(482), 'pr-482');
});

test('feat-001/AC-14 a pull-request run supplying an identity is refused', () => {
  const outcome = identityFor({
    kind: 'pull-request',
    repository: 'acme/widgets',
    pullRequestNumber: 482,
    requestedIdentity: 'staging',
  });
  assert.deepEqual(outcome, { ok: false, reason: 'identity-not-permitted' });
});

test('feat-001/AC-14 a supplied identity is refused even when it matches the derived one', () => {
  // One rule with nothing to compare cannot be got subtly wrong. Accepting a matching
  // value would put a string comparison on the security path for no benefit.
  const outcome = identityFor({
    kind: 'pull-request',
    repository: 'acme/widgets',
    pullRequestNumber: 482,
    requestedIdentity: 'pr-482',
  });
  assert.deepEqual(outcome, { ok: false, reason: 'identity-not-permitted' });
});

test('feat-001/AC-14 a nonsensical pull request number yields no identity', () => {
  for (const bad of [0, -1, 1.5, Number.NaN]) {
    const outcome = identityFor({
      kind: 'pull-request',
      repository: 'acme/widgets',
      pullRequestNumber: bad,
    });
    assert.deepEqual(outcome, { ok: false, reason: 'invalid-pull-request-number' });
  }
});

test('identity: a default-branch run may name an arbitrary environment', () => {
  const outcome = identityFor({
    kind: 'default-branch',
    repository: 'acme/widgets',
    requestedIdentity: 'staging',
  });
  assert.deepEqual(outcome, { ok: true, identity: 'staging' });
});

test('identity: a default-branch run may not name an identity that escapes its key prefix', () => {
  for (const bad of ['../staging', 'a/b', '', 'has space', 'x'.repeat(64)]) {
    const outcome = identityFor({
      kind: 'default-branch',
      repository: 'acme/widgets',
      requestedIdentity: bad,
    });
    assert.deepEqual(outcome, { ok: false, reason: 'invalid-identity' }, `expected "${bad}" refused`);
  }
});

test('feat-006/AC-3 a chosen name inside the ephemeral namespace is refused', () => {
  // The fence is drawn at the `pr-` prefix, wider than the names a pull request's deploy
  // actually derives — `pr-x` matches no pull request, and is refused anyway, because the
  // credential fence is drawn at the prefix and not at the derivable names.
  for (const reserved of ['pr-7', 'pr-482', 'pr-x', 'pr-']) {
    const outcome = identityFor({
      kind: 'default-branch',
      repository: 'acme/widgets',
      requestedIdentity: reserved,
    });
    assert.deepEqual(outcome, { ok: false, reason: 'reserved-namespace' }, `expected "${reserved}" refused`);
  }
});

test('feat-006/AC-3 a name merely resembling the prefix is not refused', () => {
  for (const fine of ['pr', 'pra', 'prod', 'staging-pr', 'PR-7']) {
    const outcome = identityFor({
      kind: 'default-branch',
      repository: 'acme/widgets',
      requestedIdentity: fine,
    });
    assert.deepEqual(outcome, { ok: true, identity: fine }, `expected "${fine}" allowed`);
  }
});

test('feat-001/AC-20 an over-long identity is refused where it is supplied', () => {
  // 63 is the DNS label limit, and the identity reaches hostnames long before anything
  // checks. Refusing it here names the identity; refusing it later names a hostname.
  const longest = 'a'.repeat(63);
  assert.deepEqual(
    identityFor({ kind: 'default-branch', repository: 'acme/widgets', requestedIdentity: longest }),
    { ok: true, identity: longest },
  );
  assert.deepEqual(
    identityFor({
      kind: 'default-branch',
      repository: 'acme/widgets',
      requestedIdentity: 'a'.repeat(64),
    }),
    { ok: false, reason: 'invalid-identity' },
  );
});
