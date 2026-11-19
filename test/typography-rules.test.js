import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRules } from '../src/typography/rules/index.js';
import { neutral } from '../src/typography/rules/neutral.js';
import { TYPOGRAPHY_RULES_VERSION } from '../src/typography/version.js';

test('an unknown language gets the neutral set', () => {
  assert.equal(resolveRules('xx'), neutral);
});

test('a regional tag without rules gets the neutral set', () => {
  assert.equal(resolveRules('en-GB'), neutral);
  assert.equal(resolveRules('fr-CH'), neutral);
});

test('an empty or missing locale gets the neutral set', () => {
  assert.equal(resolveRules(''), neutral);
  assert.equal(resolveRules(undefined), neutral);
});

test('the lookup ignores case', () => {
  assert.equal(resolveRules('EN-gb'), neutral);
});

test('the neutral set has curly quotes and no heading case', () => {
  assert.deepEqual(neutral.quotes.outer, ['“', '”']);
  assert.deepEqual(neutral.quotes.inner, ['‘', '’']);
  assert.equal(neutral.apostrophe, '’');
  assert.equal(neutral.dash.sentence, '—');
  assert.equal(neutral.dash.range, '–');
  assert.equal(neutral.ellipsis, '…');
  assert.deepEqual(neutral.nbsp, {});
  assert.equal(neutral.headingCase, 'none');
});

test('the rules version is an integer', () => {
  assert.equal(TYPOGRAPHY_RULES_VERSION, 1);
});
