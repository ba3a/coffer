import { test } from 'node:test';
import assert from 'node:assert/strict';
import { typeset } from '../src/typography/typeset.js';
import { neutral } from '../src/typography/rules/neutral.js';
import { UNITS } from '../src/typography/rules/common.js';

const N = ' ';
const rules = neutral;
/** @type {import('../src/typography/rules/neutral.js').TypographyRules} */
const hooks = {
  ...neutral,
  nbsp: {
    wordsAfter: ['in', 'Mr.', 'z. B.'],
    wordsBefore: ['же', 'ли'],
    patterns: [/\b\d{1,2} (?:Jan|Feb)\b/],
  },
};

test('number and unit get a no-break space', () => {
  assert.equal(typeset('12 km', { rules }), `12${N}km`);
  assert.equal(typeset('5 % of 3,5 kg and 20 MHz', { rules }), `5${N}% of 3,5${N}kg and 20${N}MHz`);
  for (const unit of UNITS) assert.equal(typeset(`7 ${unit}`, { rules }), `7${N}${unit}`, unit);
});

test('a unit is a whole word and needs a number', () => {
  assert.equal(typeset('12 kilometers, 12 mx, a km, 12 m2', { rules }), '12 kilometers, 12 mx, a km, 12 m2');
  assert.equal(typeset('v1.2 km', { rules }), 'v1.2 km');
});

test('digit groups', () => {
  assert.equal(typeset('1 000 000', { rules }), `1${N}000${N}000`);
  assert.equal(typeset('1 000 000 km', { rules }), `1${N}000${N}000${N}km`);
  assert.equal(typeset('in 2020 100 people, 12 34', { rules }), 'in 2020 100 people, 12 34');
});

test('section, number and hash signs bind to the number', () => {
  assert.equal(typeset('§ 5', { rules }), `§${N}5`);
  assert.equal(typeset('№ 7', { rules }), `№${N}7`);
  assert.equal(typeset('# 3 and § x', { rules }), `#${N}3 and § x`);
});

test('locale hooks: words after, words before, patterns', () => {
  assert.equal(typeset('in a house, Mr. Smith, z. B. so', { rules: hooks }), `in${N}a house, Mr.${N}Smith, z.${N}B.${N}so`);
  assert.equal(typeset('where is it, was ist es', { rules: hooks }), 'where is it, was ist es');
  assert.equal(typeset('как же и ли', { rules: hooks }), `как${N}же и${N}ли`);
  assert.equal(typeset('on 5 Jan and 5 January', { rules: hooks }), `on 5${N}Jan and 5 January`);
  assert.equal(typeset('Min Mr.', { rules: hooks }), 'Min Mr.');
});

test('no no-break space inside a URL or an email address', () => {
  assert.equal(typeset('https://a.com/a b 12 km', { rules }), `https://a.com/a b 12${N}km`);
  assert.equal(typeset('mail 5@x.org 12 km', { rules }), `mail 5@x.org 12${N}km`);
  for (const url of ['https://a.com/1 000', 'www.x.org/§ 5']) {
    assert.ok(!typeset(url, { rules }).includes(N), url);
  }
});

test('spaces the author wrote are kept', () => {
  const s = `12${N}km a b 1 000 c ${N}d`;
  assert.equal(typeset(s, { rules }), s);
});

test('plain mode returns normal spaces', () => {
  assert.equal(typeset('12 km, 1 000 000, § 5, № 7', { rules, plain: true }), '12 km, 1 000 000, § 5, № 7');
  const written = `a${N}b c d`;
  assert.equal(typeset(written, { rules, plain: true }), 'a b c d');
  assert.equal(typeset('in a Mr. B', { rules: hooks, plain: true }), 'in a Mr. B');
});

test('no-break spaces are idempotent', () => {
  for (const s of ['12 km 1 000 000 § 5 № 7 # 3', 'in a Mr. Smith как же 5 Jan', 'see https://a.com/12 km 5 %']) {
    for (const r of [rules, hooks]) {
      for (const plain of [false, true]) {
        const once = typeset(s, { rules: r, plain });
        assert.equal(typeset(once, { rules: r, plain }), once, s);
      }
    }
  }
});
