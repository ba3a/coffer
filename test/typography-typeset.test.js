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
