import { test } from 'node:test';
import assert from 'node:assert/strict';

// Task 0.2 — proves the toolchain end to end: TypeScript runs under `node --test`
// with no build step, and `tsc --noEmit` type-checks the same file.
test('toolchain: node runs TypeScript tests without a build step', () => {
  const greet = (name: string): string => `hello ${name}`;
  assert.equal(greet('skyhook'), 'hello skyhook');
});
