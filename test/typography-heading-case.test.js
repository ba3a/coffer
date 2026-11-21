import { test } from 'node:test';
import assert from 'node:assert/strict';
import { headingCase } from '../src/typography/heading-case.js';
import { resolveRules } from '../src/typography/rules/index.js';

/** @param {string} text @param {string} locale @param {string[]} [keep] */
const run = (text, locale, keep = []) => headingCase(text, { rules: resolveRules(locale), keep });

test('en: Title Case with small words', () => {
  assert.deepEqual(run('a guide to the lathe', 'en'), { text: 'A Guide to the Lathe', changed: true });
  assert.equal(run('what to do with it', 'en').text, 'What to Do with It');
  assert.equal(run('notes: the next step', 'en').text, 'Notes: The Next Step');
  assert.equal(run('up-to-date tools', 'en').text, 'Up-to-Date Tools');
  assert.equal(run('what it is for', 'en').text, 'What It Is For');
});

test('en: keep words stay as written', () => {
  assert.equal(run('Setting up coffer', 'en', ['coffer']).text, 'Setting Up coffer');
  assert.equal(run('Setting up coffer', 'en').text, 'Setting up Coffer');
});

test('ru: sentence case only for a title-case heading', () => {
  const r = run('Как Сделать Стол Своими Руками', 'ru');
  assert.deepEqual(r, { text: 'Как сделать стол своими руками', changed: true });
  assert.deepEqual(run('Как сделать стол', 'ru'), { text: 'Как сделать стол', changed: false });
  assert.equal(run('Как Сделать', 'ru').text, 'Как Сделать');
  assert.equal(run('Часть Один: Новый Стол Дома', 'fr').text, 'Часть один: Новый стол дома');
});

test('de: raises the first letter only', () => {
  assert.equal(run('ein Tisch Bauen', 'de').text, 'Ein Tisch Bauen');
  assert.equal(run('iPhone Tisch', 'de').text, 'iPhone Tisch');
});

test('neutral: no change', () => {
  assert.deepEqual(run('a guide to the lathe', 'xx'), { text: 'a guide to the lathe', changed: false });
});

test('protected words are untouched', () => {
  assert.equal(run('using iPhone v2 with NASA a.b', 'en').text, 'Using iPhone v2 with NASA a.b');
  assert.equal(run('see snake_case and a/b and me@x', 'en').text, 'See snake_case and a/b and me@x');
  assert.equal(run('Как Сделать Телефон Своими NASA Руками', 'ru').text, 'Как сделать телефон своими NASA руками');
});

test('idempotent', () => {
  for (const [text, locale] of [
    ['a guide to the lathe', 'en'],
    ['Как Сделать Стол Своими Руками', 'ru'],
    ['ein tisch', 'de'],
  ]) {
    const once = run(text, locale).text;
    assert.deepEqual(run(once, locale), { text: once, changed: false });
  }
});
