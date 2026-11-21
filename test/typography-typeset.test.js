import { test } from 'node:test';
import assert from 'node:assert/strict';
import { typeset, typesetSegments } from '../src/typography/typeset.js';
import { neutral } from '../src/typography/rules/neutral.js';

const rules = neutral;
/** @type {import('../src/typography/rules/neutral.js').TypographyRules} */
const guillemets = {
  ...neutral,
  quotes: { outer: ['«', '»'], inner: ['„', '“'] },
};

test('quotes pair and nest with the neutral rules', () => {
  assert.equal(typeset(`a 'b' c`, { rules }), 'a “b” c');
  assert.equal(typeset(`"a 'b' c"`, { rules }), '“a ‘b’ c”');
  assert.equal(typeset(`"a 'b "c" d' e"`, { rules }), '“a ‘b “c” d’ e”');
});

test('a test rule set gives other marks', () => {
  assert.equal(typeset(`"a 'b' c"`, { rules: guillemets }), '«a „b“ c»');
});

test('quotes open after block start, space, bracket and dash', () => {
  assert.equal(typeset(`("a") —"b"`, { rules }), '(“a”) —“b”');
});

test('apostrophes sit between letters and before digits', () => {
  assert.equal(typeset(`don't`, { rules }), 'don’t');
  assert.equal(typeset(`the '90s`, { rules }), 'the ’90s');
});

test('an unpaired quote stays as typed and is reported', () => {
  const r = typesetSegments(['say "hi', ' and \'go\''], { rules });
  assert.deepEqual(r.segments, ['say "hi', ' and “go”']);
  assert.deepEqual(r.unpaired, [{ offset: 4, segment: 0, index: 4, char: '"' }]);
  assert.equal(typeset(`a" b`, { rules }), 'a" b');
  assert.deepEqual(typesetSegments(['a" b'], { rules }).unpaired[0].offset, 1);
});

test('quotes pair across segments', () => {
  const r = typesetSegments(['"a ', 'b', ' c"'], { rules });
  assert.deepEqual(r.segments, ['“a ', 'b', ' c”']);
  assert.deepEqual(r.unpaired, []);
});

test('quotes the author typeset are kept', () => {
  assert.equal(typeset('«a» „b“ “c”', { rules }), '«a» „b“ “c”');
});

test('typesetting twice gives the same result as once', () => {
  for (const s of [`"a 'b' c" don't '90s`, `say "hi 'x`, `a" b' "c`, `"'a' b"`]) {
    const once = typeset(s, { rules });
    assert.equal(typeset(once, { rules }), once, s);
  }
});

const ru = { ...neutral, dash: { sentence: ' — ', range: '–' } };
const en = { ...neutral, dash: { sentence: '—', range: '–', spacedEnOption: ' – ' } };

test('ranges become en dashes; hyphens in words stay', () => {
  assert.equal(typeset('1-5', { rules }), '1–5');
  assert.equal(typeset('pages 10-20, well-known, COVID-19, x86-64', { rules }), 'pages 10–20, well-known, COVID-19, x86-64');
  assert.equal(typeset('12.05.2020-15.05.2020', { rules }), '12.05.2020–15.05.2020');
  assert.equal(typeset('2024-05-17', { rules }), '2024-05-17');
});

test('--- and -- and the sentence dash', () => {
  assert.equal(typeset('a---b', { rules }), 'a—b');
  assert.equal(typeset('a--b', { rules }), 'a–b');
  assert.equal(typeset('a - b', { rules }), 'a—b');
  assert.equal(typeset('a - b', { rules: ru }), 'a — b');
  assert.equal(typeset('a - b', { rules: en, dashStyle: 'spaced-en' }), 'a – b');
  assert.equal(typeset('a - b', { rules: en }), 'a—b');
  assert.equal(typeset('a - b', { rules, dashStyle: 'spaced-en' }), 'a—b');
});

test('a dialogue dash changes only the character', () => {
  assert.equal(typeset('- Hi', { rules: ru }), '— Hi');
  assert.equal(typeset('x\n- Hi', { rules: ru }), 'x\n— Hi');
});

test('minus, ellipsis and multiplication sign', () => {
  assert.equal(typeset('-5 and (-3) and a-5', { rules }), '−5 and (−3) and a-5');
  assert.equal(typeset('wait...', { rules }), 'wait…');
  assert.equal(typeset('4x6, 4 x 6, 4x6x8, 0x1F, 4 xylophones', { rules }), '4×6, 4 × 6, 4×6×8, 0x1F, 4 xylophones');
});

test('URLs and emails are not changed', () => {
  const s = 'see https://a.com/1-5--x...y?q=4x6 and me-1--2@a-b.com now';
  assert.equal(typeset(s, { rules }), s);
  assert.equal(typeset('a--b https://a.com/1-5 c...', { rules }), 'a–b https://a.com/1-5 c…');
});

test('symbols are idempotent', () => {
  for (const s of ['1-5 a---b a--b a - b -5 wait... 4x6 - 4 x 6x8', '- Hi\n- there', 'https://x.y/1-5 a - b']) {
    for (const r of [rules, ru, en]) {
      const once = typeset(s, { rules: r });
      assert.equal(typeset(once, { rules: r }), once, s);
    }
  }
});
