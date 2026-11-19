import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRules } from '../src/typography/rules/index.js';
import { en } from '../src/typography/rules/en.js';
import { neutral } from '../src/typography/rules/neutral.js';
import { typeset } from '../src/typography/typeset.js';
import { TYPOGRAPHY_RULES_VERSION } from '../src/typography/version.js';

test('an unknown language gets the neutral set', () => {
  assert.equal(resolveRules('xx'), neutral);
});

test('a regional tag without rules gets the neutral set', () => {
  assert.equal(resolveRules('fr-CH'), neutral);
});

test('an empty or missing locale gets the neutral set', () => {
  assert.equal(resolveRules(''), neutral);
  assert.equal(resolveRules(undefined), neutral);
});

test('the lookup ignores case', () => {
  assert.equal(resolveRules('EN-gb'), en);
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

test('en-US and en-GB fall back to the en set', () => {
  assert.equal(resolveRules('en-US'), en);
  assert.equal(resolveRules('en'), en);
  assert.equal(resolveRules('en-GB'), en);
});

test('the en set has the spec data', () => {
  assert.deepEqual(en.quotes.outer, ['“', '”']);
  assert.equal(en.dash.sentence, '—');
  assert.equal(en.dash.spacedEnOption, ' – ');
  assert.equal(en.dash.range, '–');
  assert.equal(en.headingCase, 'title');
  assert.equal(en.smallWords?.length, 23);
  assert.ok(en.smallWords?.includes('via'));
});

test('en dashes and non-breaking spaces', () => {
  const rules = resolveRules('en-US');
  assert.equal(typeset('a - b', { rules }), 'a—b');
  assert.equal(typeset('a - b', { rules, dashStyle: 'spaced-en' }), 'a – b');
  assert.equal(typeset('1-5', { rules }), '1–5');
  assert.equal(typeset('Dr. Smith', { rules }), 'Dr. Smith');
  assert.equal(typeset('Mr. A, Mrs. B, St. C, a vs. b', { rules }), 'Mr. A, Mrs. B, St. C, a vs. b');
  assert.equal(typeset('May 5 and March 12 and Jan. 3', { rules }), 'May 5 and March 12 and Jan. 3');
  assert.equal(typeset('May the 5th, May 2020x', { rules }), 'May the 5th, May 2020x');
  assert.equal(typeset('In May 2020', { rules }), 'In May 2020');
});
