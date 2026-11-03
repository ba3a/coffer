import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const read = (/** @type {string} */ name) =>
  readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

test('package.json declares the Apache-2.0 license', () => {
  assert.equal(JSON.parse(read('package.json')).license, 'Apache-2.0');
});

test('LICENSE is the unmodified Apache License 2.0 text', () => {
  const text = read('LICENSE').replace(/\r\n/g, '\n');
  assert.match(text, /^\s*Apache License\n\s*Version 2\.0, January 2004\n/);
  assert.ok(text.includes('END OF TERMS AND CONDITIONS'));
  // SHA-256 of the canonical text published by the Apache Software Foundation.
  const digest = createHash('sha256').update(text).digest('hex');
  assert.equal(
    digest,
    'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30',
  );
});

test('NOTICE names the product, a copyright year and an author', () => {
  const lines = read('NOTICE').replace(/\r\n/g, '\n').split('\n');
  assert.equal(lines[0], 'coffer');
  assert.match(lines[1] ?? '', /^Copyright (\d{4}) \S.+$/);
});

test('NOTICE ships with the package', () => {
  assert.ok(JSON.parse(read('package.json')).files.includes('NOTICE'));
});
