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
  assert.equal(resolveRules('it-CH'), neutral);
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

test('ru falls back from regional tags and has the spec data', () => {
  assert.equal(resolveRules('ru-RU'), resolveRules('ru'));
  const ru = resolveRules('ru');
  assert.deepEqual(ru.quotes.outer, ['«', '»']);
  assert.deepEqual(ru.quotes.inner, ['„', '“']);
  assert.equal(ru.apostrophe, '’');
  assert.equal(ru.headingCase, 'sentence');
});

test('ru quotes pair as «…» with „…“ inside', () => {
  const rules = resolveRules('ru');
  assert.equal(typeset('Он сказал: "Она ответила: \'да\'".', { rules }), 'Он сказал: «Она ответила: „да“».');
});

test('ru keeps initials and surname together', () => {
  const rules = resolveRules('ru');
  assert.equal(typeset('А. С. Пушкин', { rules }), 'А. С. Пушкин');
});

test('ru binds short words and particles', () => {
  const rules = resolveRules('ru');
  assert.equal(typeset('в доме', { rules }), 'в доме');
  assert.equal(typeset('Он и она не пошли на реку', { rules }), 'Он и она не пошли на реку');
  assert.equal(typeset('сказал же', { rules }), 'сказал же');
  assert.equal(typeset('придёшь ли', { rules }), 'придёшь ли');
  assert.equal(typeset('в 1990 г. вышла', { rules }), 'в 1990 г. вышла');
  assert.equal(typeset('и т. д. и т. е. далее', { rules }), 'и т. д. и т. е. далее');
  assert.equal(typeset('5 тыс. руб. сейчас', { rules }), '5 тыс. руб. сейчас');
});

test('ru sentence dash has a no-break space before and a space after', () => {
  const rules = resolveRules('ru');
  assert.equal(typeset('слово - слово', { rules }), 'слово — слово');
  assert.equal(typeset('слово — слово', { rules }), 'слово — слово');
  assert.equal(typeset('1-5', { rules }), '1–5');
});

test('ru adds no space around the ellipsis', () => {
  assert.equal(typeset('Ну... да', { rules: resolveRules('ru') }), 'Ну… да');
});

test('de falls back from regional tags and has the spec data', () => {
  assert.equal(resolveRules('de-AT'), resolveRules('de'));
  const de = resolveRules('de');
  assert.deepEqual(de.quotes.outer, ['„', '“']);
  assert.deepEqual(de.quotes.inner, ['‚', '‘']);
  assert.equal(de.apostrophe, '’');
  assert.equal(de.dash.sentence, ' – ');
  assert.equal(de.headingCase, 'german');
});

test('de quotes pair as „…“ with ‚…‘ inside', () => {
  const rules = resolveRules('de');
  assert.equal(typeset('"Hallo"', { rules }), '„Hallo“');
  assert.equal(typeset('Er sagte: "Sie sagte \'innen\'".', { rules }), 'Er sagte: „Sie sagte ‚innen‘“.');
});

test('de sentence dash is a spaced en dash', () => {
  const rules = resolveRules('de');
  assert.equal(typeset('a - b', { rules }), 'a – b');
  assert.equal(typeset('1-5', { rules }), '1–5');
});

test('de binds abbreviations and number with unit', () => {
  const rules = resolveRules('de');
  assert.equal(typeset('z. B. das', { rules }), 'z. B. das');
  assert.equal(typeset('d. h. so, u. a. dies', { rules }), 'd. h. so, u. a. dies');
  assert.equal(typeset('Nr. 5, Dr. Weber, Prof. Weber', { rules }), 'Nr. 5, Dr. Weber, Prof. Weber');
  assert.equal(typeset('12 km', { rules }), '12 km');
});
