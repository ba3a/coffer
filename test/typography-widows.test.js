import { test } from 'node:test';
import assert from 'node:assert/strict';
import { widows } from '../src/typography/widows.js';

const N = ' ';

test('joins the last two words', () => {
  assert.equal(widows('one two three four'), `one two three${N}four`);
  assert.equal(widows('one two three four\n'), `one two three${N}four\n`);
});

test('two-word and short blocks are unchanged', () => {
  assert.equal(widows('one two'), 'one two');
  assert.equal(widows('one'), 'one');
  assert.equal(widows(''), '');
});

test('a last word over 12 characters is unchanged', () => {
  assert.equal(widows('one two abcdefghijklm'), 'one two abcdefghijklm');
  assert.equal(widows('one two abcdefghijkl'), `one two${N}abcdefghijkl`);
});

test('is idempotent', () => {
  const once = widows('one two three four');
  assert.equal(widows(once), once);
  assert.equal(widows(`one two${N}three`), `one two${N}three`);
});

test('plain mode keeps normal spaces', () => {
  assert.equal(widows('one two three four', { plain: true }), 'one two three four');
});
