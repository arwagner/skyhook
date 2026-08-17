import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  derivedIdentityFor,
  identityFor,
  pullRequestNumberFor,
  slotIdentityFor,
  slotNumberFor,
} from '../src/core/identity.ts';

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

// --- warm slots (feat-007) ---------------------------------------------------

test('feat-001/AC-14 slot identities are derived and recognized, never chosen', () => {
  // The pool builder assigns slot identities by index; slotNumberFor is the reverse,
  // and it must reject anything that is not exactly `slot-<positive integer>`.
  assert.equal(slotIdentityFor(3), 'slot-3');
  assert.equal(slotNumberFor('slot-3'), 3);
  assert.equal(slotNumberFor('slot-42'), 42);
  assert.equal(slotNumberFor('slot-0'), null);
  assert.equal(slotNumberFor('slot-01'), null);
  assert.equal(slotNumberFor('slot-'), null);
  assert.equal(slotNumberFor('slot-x'), null);
  assert.equal(slotNumberFor('pr-3'), null);
  assert.equal(slotNumberFor('staging'), null);
});

test('feat-001/AC-14 pull-request derivation is untouched by slots', () => {
  // A slot identity is never what the trigger derives: the claimant stays `pr-<n>`,
  // and the sweep's pull-request recovery must not read a slot as ephemeral-by-name.
  assert.equal(pullRequestNumberFor('slot-3'), null);
});

test('feat-001/AC-14 operator-chosen names beginning "slot-" are refused like "pr-"', () => {
  // The reserved prefix is what makes the disjoint-namespaces assumption a tested
  // assertion rather than documentation (feat-007 plan D1).
  for (const requestedIdentity of ['slot-1', 'slot-extra']) {
    assert.deepEqual(
      identityFor({ kind: 'default-branch', repository: 'acme/widgets', requestedIdentity }),
      { ok: false, reason: 'reserved-namespace' },
    );
  }
});
