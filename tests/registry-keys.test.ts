import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  identityFromRegistryKey,
  protectionKeyFor,
  registryKeyFor,
  registryPrefixFor,
  stateDirFor,
} from '../src/core/registry.ts';
import { terraformStateKeyFor } from '../src/adapters/terraform/state-key.ts';

test('feat-001/AC-7 every environment gets its own state key', () => {
  // AC-7: each managed environment's state is stored under a key unique to that
  // environment, and two environments never share a state key. Uniqueness is core's
  // to establish; the filename inside is the IaC tool's business.
  const keys = [
    terraformStateKeyFor('acme/widgets', 'staging'),
    terraformStateKeyFor('acme/widgets', 'pr-482'),
    terraformStateKeyFor('acme/widgets', 'pr-483'),
    terraformStateKeyFor('acme/gadgets', 'staging'),
  ];
  assert.equal(new Set(keys).size, keys.length, 'state keys must not collide');
  assert.equal(
    terraformStateKeyFor('acme/widgets', 'pr-482'),
    'state/acme/widgets/pr-482/terraform.tfstate',
  );
});

test('feat-001/AC-7 the same environment always derives the same state key', () => {
  assert.equal(
    terraformStateKeyFor('acme/widgets', 'staging'),
    terraformStateKeyFor('acme/widgets', 'staging'),
  );
});

test('feat-001/AC-7 gap-001 the provider-agnostic core never names the IaC tool', () => {
  // Regression for converge gap-001. `stateKeyFor()` used to return a key ending in
  // "terraform.tfstate" from inside src/core/, which special-cases the IaC tool by name
  // in the one directory the constitution says must not. Core now stops at the directory.
  const directory = stateDirFor('acme/widgets', 'pr-482');
  assert.equal(directory, 'state/acme/widgets/pr-482/');
  assert.doesNotMatch(directory, /terraform|tfstate/i, 'core must not name the tool');

  // And the adapter is what supplies the filename.
  assert.equal(terraformStateKeyFor('acme/widgets', 'pr-482'), `${directory}terraform.tfstate`);
});

test('feat-001/AC-12 two repositories may hold the same identity without collision', () => {
  // AC-12: every record identifies its repository, and two environments in different
  // repositories may hold the same identity.
  const one = registryKeyFor('acme/widgets', 'staging');
  const other = registryKeyFor('acme/gadgets', 'staging');
  assert.notEqual(one, other);
  assert.equal(one, 'registry/acme/widgets/staging.json');
  assert.equal(other, 'registry/acme/gadgets/staging.json');
});

test('feat-001/AC-12 one repository\'s registry prefix excludes another\'s keys', () => {
  const prefix = registryPrefixFor('acme/widgets');
  assert.ok(registryKeyFor('acme/widgets', 'staging').startsWith(prefix));
  assert.ok(!registryKeyFor('acme/gadgets', 'staging').startsWith(prefix));
});

test('feat-001/AC-15 protection has its own key, disjoint from the record', () => {
  const record = registryKeyFor('acme/widgets', 'staging');
  const protection = protectionKeyFor('acme/widgets', 'staging');
  assert.equal(protection, 'protected/acme/widgets/staging');
  assert.notEqual(protection, record);
  assert.ok(!protection.startsWith('registry/'), 'a policy scoped to registry/ must not reach it');
});

test('registry keys: an identity that would escape its prefix is refused', () => {
  // The pull-request role's permissions are a key prefix, so an identity able to
  // escape the prefix walks straight through that boundary.
  for (const bad of ['../staging', 'a/b', '..', '', '/etc/passwd', 'pr 1']) {
    assert.throws(() => registryKeyFor('acme/widgets', bad), TypeError, `expected "${bad}" refused`);
    assert.throws(() => stateDirFor('acme/widgets', bad), TypeError);
    assert.throws(() => protectionKeyFor('acme/widgets', bad), TypeError);
  }
});

test('registry keys: a malformed repository is refused', () => {
  for (const bad of ['widgets', 'acme/widgets/extra', '/widgets', 'acme/', '../../acme/widgets']) {
    assert.throws(() => registryKeyFor(bad, 'staging'), TypeError, `expected "${bad}" refused`);
  }
});

test('registry keys: an identity round-trips out of its registry key', () => {
  assert.equal(
    identityFromRegistryKey('acme/widgets', registryKeyFor('acme/widgets', 'pr-482')),
    'pr-482',
  );
  assert.equal(
    identityFromRegistryKey('acme/widgets', registryKeyFor('acme/gadgets', 'pr-482')),
    null,
  );
  assert.equal(identityFromRegistryKey('acme/widgets', 'registry/acme/widgets/notes.txt'), null);
});
