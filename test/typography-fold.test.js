import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldForSearch } from '../src/typography/fold.js';
import * as entry from '../src/index.js';

test('curly and straight apostrophes fold alike', () => {
  assert.equal(foldForSearch('don’t'), foldForSearch("don't"));
  assert.equal(foldForSearch('don’t'), "don't");
});

test('all quote marks fold to " and \'', () => {
  assert.equal(foldForSearch('“a” «b» „c“'), '"a" "b" "c"');
  assert.equal(foldForSearch('‘a’ ‚b‘'), "'a' 'b'");
});

test('dashes fold to a hyphen', () => {
  assert.equal(foldForSearch('a–b—c−d'), 'a-b-c-d');
});

test('ellipsis, no-break spaces and the Armenian full stop fold', () => {
  assert.equal(foldForSearch('a…'), 'a...');
  assert.equal(foldForSearch('a b c'), 'a b c');
  assert.equal(foldForSearch('ա։'), 'ա.');
});

test('the package entry exports typeset and foldForSearch', () => {
  assert.equal(typeof entry.typeset, 'function');
  assert.equal(entry.foldForSearch, foldForSearch);
});
