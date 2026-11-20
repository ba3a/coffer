import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../src/markdown/render.js';

const typography = { enabled: true, locale: 'en', dashStyle: /** @type {'locale'} */ ('locale') };

/**
 * @param {string} source
 * @param {object} [extra]
 */
const render = (source, extra = {}) => renderMarkdown(source, { typography, ...extra });

test('paragraphs and list items are typeset', async () => {
  const { html } = await render(`He said "hi" -- fine...\n\n- it's "ok"\n- b`);
  assert.match(html, /<p>He said “hi” – fine…<\/p>/);
  assert.match(html, /<li>it’s “ok”<\/li>/);
});

test('without the option the output is not typeset', async () => {
  const source = 'He said "hi" -- fine...\n\n- it\'s\n\n`a "b"`\n';
  const plain = await renderMarkdown(source);
  assert.equal(plain.html.includes('“'), false);
  assert.match(plain.html, /"hi" -- fine\.\.\./);
  assert.deepEqual(plain.typographyWarnings, []);
  const off = await renderMarkdown(source, { typography: { ...typography, enabled: false } });
  assert.equal(off.html, plain.html);
});

test('a quote pairs across an inline element', async () => {
  const { html, typographyWarnings } = await render('say "a *b* c" now');
  assert.match(html, /<p>say “a <em>b<\/em> c” now<\/p>/);
  assert.deepEqual(typographyWarnings, []);
});

test('code, pre, raw HTML, alt text, captions and bare URLs stay as typed', async () => {
  const source = [
    'a `"x" -- y...` b',
    '',
    '```\n"x" -- y...\n```',
    '',
    '<div>"raw" -- here</div>',
    '',
    '![say "hi"](a.png "a \'cap\' -- 1")',
    '',
    'see https://example.com/a--b?q=1 and me@example.com for "this"',
    '',
    '[l](http://x.test/a--b "t \'q\'") <span title="a -- b">"s"</span>',
  ].join('\n');
  const { html } = await render(source);
  assert.match(html, /<code>"x" -- y\.\.\.<\/code>/);
  const pre = html.match(/<pre[\s\S]*?<\/pre>/);
  assert.ok(pre, 'a pre element exists');
  const preText = pre[0].replace(/<[^>]+>/g, '');
  assert.equal(preText.trim(), '&#x22;x&#x22; -- y...'.replace(/&#x22;/g, '"'));
  assert.equal(/[“”–…]/.test(pre[0]), false);
  assert.match(html, /<span title="a -- b">“s”<\/span>|<span title="a -- b">"s"<\/span>/);
  assert.match(html, /<div>"raw" -- here<\/div>/);
  assert.match(html, /alt="say &#x22;hi&#x22;"/);
  assert.match(html, /title="a &#x27;cap&#x27; -- 1"/);
  assert.match(html, />https:\/\/example\.com\/a--b\?q=1</);
  assert.match(html, />me@example\.com</);
  assert.match(html, /for “this”/);
  assert.match(html, /href="http:\/\/x\.test\/a--b"/);
  assert.match(html, /title="t &#x27;q&#x27;"/);
  assert.match(html, /title="a -- b"/);
});

test('data-typography off leaves its content as typed', async () => {
  const { html } = await render('a "b" :verbatim[c "d" -- e] f "g"');
  assert.match(html, /<span data-typography="off">c "d" -- e<\/span>/);
  assert.match(html, /a “b” /);
  assert.match(html, / f “g”/);
});

test('escapes keep characters as typed and are restored', async () => {
  const { html } = await render(String.raw`say \"hi\" \-- ok\...`);
  assert.match(html, /<p>say "hi" -- ok\.\.\.<\/p>/);
  assert.equal(/[-]/.test(html), false);
});

test('an unpaired quote stays and is reported with file and line', async () => {
  const { html, typographyWarnings } = await render('ok\n\nbad "quote here\n\nmore', { file: 'p.md', startLine: 5 });
  assert.match(html, /bad "quote here/);
  assert.equal(typographyWarnings.length, 1);
  assert.equal(typographyWarnings[0].file, 'p.md');
  assert.equal(typographyWarnings[0].line, 7);
});

test('the line of a warning counts lines inside the text', async () => {
  const { typographyWarnings } = await render('one\ntwo "x\nthree', { file: 'p.md' });
  assert.equal(typographyWarnings[0].line, 2);
});

test('typesetting is idempotent', async () => {
  const source = 'He said "a *b* c" -- it\'s 12 km... and 1-5.\n\n- "x" y';
  const first = await render(source);
  const text = (/** @type {string} */ h) => h.replace(/<[^>]+>/g, '');
  const second = await render(text(first.html).replace(/^- /gm, ''));
  const again = await render(text(second.html));
  assert.equal(text(again.html), text(second.html));
  const lines = text(first.html).trim().split('\n').filter(Boolean);
  const re = await render(lines.join('\n\n'));
  assert.equal(text(re.html).trim().split('\n').filter(Boolean).join('|'), lines.join('|'));
});

test('blockquote paragraphs are typeset', async () => {
  const { html } = await render('> she said "yes" -- now');
  assert.match(html, /<blockquote>\s*<p>she said “yes” – now<\/p>\s*<\/blockquote>/);
});

test('typeset text is a fixed point', async () => {
  const first = await render('He said "hi" -- it\'s 12 km...');
  const text = first.html.replace(/<[^>]+>/g, '').trim();
  const second = await render(text);
  assert.equal(second.html.replace(/<[^>]+>/g, '').trim(), text);
});

test('table cells are typeset', async () => {
  const { html } = await render('| a |\n| - |\n| "x" |');
  assert.match(html, /<td>“x”<\/td>/);
});
