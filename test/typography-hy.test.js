import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRules } from '../src/typography/rules/index.js';
import { typeset } from '../src/typography/typeset.js';

const rules = resolveRules('hy');
const N = '\u00A0';

test('hy-AM resolves to hy, which is experimental', () => {
  assert.equal(resolveRules('hy-AM'), rules);
  assert.equal(rules.experimental, true);
  assert.equal(rules.headingCase, 'sentence');
});

test('a full stop after an Armenian letter ends in U+0589', () => {
  assert.equal(typeset('Բարեւ ձեզ.', { rules }), 'Բարեւ ձեզ։');
  assert.equal(typeset('Բարեւ ձեզ. Ինչպես եք', { rules }), 'Բարեւ ձեզ։ Ինչպես եք');
  assert.equal(typeset('Ասաց՝ գնանք:', { rules }), 'Ասաց՝ գնանք։');
});

test('other marks and non-Armenian text stay as typed', () => {
  assert.equal(typeset('Բարեւ, ձեզ? Այո!', { rules }), 'Բարեւ, ձեզ? Այո!');
  assert.equal(typeset('Hello.', { rules }), 'Hello.');
  assert.equal(typeset('ժամը 12:30', { rules }), 'ժամը 12:30');
  assert.equal(typeset('Բարեւ ֊ ձեզ', { rules }), 'Բարեւ ֊ ձեզ');
});

test('quotes give « » and “ ”', () => {
  assert.equal(typeset('"ab \'cd\' ef"', { rules }), '«ab “cd” ef»');
  assert.equal(typeset('Նա ասաց "այո."', { rules }), 'Նա ասաց «այո։»');
});

test('spaced em dash, no-break space before it and before a unit', () => {
  assert.equal(typeset('ab - cd', { rules }), `ab${N}— cd`);
  assert.equal(typeset('12 km', { rules }), `12${N}km`);
});

test('an initial and a colon before a quote stay as typed', () => {
  assert.equal(typeset('Ա. Պետրոսյան', { rules }), 'Ա. Պետրոսյան');
  assert.equal(typeset('Ասաց: «գնանք»', { rules }), 'Ասաց: «գնանք»');
  assert.equal(typeset('Ասաց: գնանք.', { rules }), 'Ասաց։ գնանք։');
});
