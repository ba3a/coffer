import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRules } from '../src/typography/rules/index.js';
import { typeset } from '../src/typography/typeset.js';

const rules = resolveRules('fr');
const T = '\u202F';
const N = '\u00A0';

test('fr-CH resolves to fr', () => {
  assert.equal(resolveRules('fr-CH'), rules);
  assert.deepEqual(rules.quotes.outer, ['«', '»']);
  assert.deepEqual(rules.quotes.inner, ['“', '”']);
  assert.equal(rules.headingCase, 'sentence');
});

test('U+202F goes before ; ! ?', () => {
  assert.equal(typeset('Bonjour !', { rules }), `Bonjour${T}!`);
  assert.equal(typeset('Bonjour!', { rules }), `Bonjour${T}!`);
  assert.equal(typeset('Quoi ? Oui ; non !', { rules }), `Quoi${T}? Oui${T}; non${T}!`);
});

test('U+00A0 goes before a colon', () => {
  assert.equal(typeset('Il dit : oui', { rules }), `Il dit${N}: oui`);
  assert.equal(typeset('Il dit: oui', { rules }), `Il dit${N}: oui`);
  assert.equal(typeset('à 12:30', { rules }), `à${N}12:30`);
});

test('quotes carry U+202F inside', () => {
  assert.equal(typeset('Il dit "oui".', { rules }), `Il dit «${T}oui${T}».`);
  assert.equal(typeset('"ab \'cd\' ef"', { rules }), `«${T}ab “cd” ef${T}»`);
});

test('spaced em dash, ellipsis, units, one-letter words', () => {
  assert.equal(typeset('ab - cd', { rules }), 'ab — cd');
  assert.equal(typeset('Bon...', { rules }), 'Bon…');
  assert.equal(typeset('5 % et 12 km', { rules }), `5${N}% et 12${N}km`);
  assert.equal(typeset('Il va à Paris', { rules }), `Il va à${N}Paris`);
});

test('URLs are not touched', () => {
  assert.equal(typeset('http://a.b/c?d=1;e', { rules }), 'http://a.b/c?d=1;e');
});
