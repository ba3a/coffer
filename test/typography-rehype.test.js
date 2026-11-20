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

const headingSource = [
  '## He said "hi" -- really',
  '',
  '## the end of the road: a look at it\'s past',
  '',
  '### Don\'t panic...',
  '',
  'text',
].join('\n');

test('heading ids equal the ids with typography off', async () => {
  const off = await renderMarkdown(headingSource, { tocMinHeadings: 1 });
  const on = await render(headingSource, { tocMinHeadings: 1 });
  assert.deepEqual(
    on.toc.map((entry) => entry.id),
    off.toc.map((entry) => entry.id),
  );
  assert.deepEqual(on.ids, off.ids);
  assert.match(on.html, /<h2 id="he-said-hi----really">/);
});

test('toc entries hold the typeset heading text', async () => {
  const { toc, html } = await render(headingSource, { tocMinHeadings: 1 });
  assert.deepEqual(
    toc.map((entry) => entry.text),
    ['He Said “Hi” – Really', 'The End of the Road: A Look at It’s Past', 'Don’t Panic…'],
  );
  assert.match(html, /<h3 id="dont-panic">Don’t Panic…<\/h3>/);
});

test('headings: keep leaves case alone but typesets marks', async () => {
  const { toc, typographyHeadingChanges } = await render(headingSource, {
    tocMinHeadings: 1,
    typography: { ...typography, headings: 'keep' },
  });
  assert.deepEqual(
    toc.map((entry) => entry.text),
    ['He said “hi” – really', 'the end of the road: a look at it’s past', 'Don’t panic…'],
  );
  assert.deepEqual(typographyHeadingChanges, []);
});

test('changed headings are listed with file and line', async () => {
  const { typographyHeadingChanges } = await render(headingSource, { file: 'a.md', startLine: 11 });
  assert.equal(typographyHeadingChanges.length, 3);
  assert.deepEqual(typographyHeadingChanges[1], {
    file: 'a.md',
    line: 13,
    before: 'the end of the road: a look at it’s past',
    after: 'The End of the Road: A Look at It’s Past',
  });
});

test('keep words and code in a heading are not changed by case', async () => {
  const { html, typographyHeadingChanges } = await render('## using npm with `foo bar`', {
    typography: { ...typography, keep: ['npm'] },
  });
  assert.match(html, /<h2 id="[^"]+">Using npm with <code>foo bar<\/code><\/h2>/);
  assert.equal(typographyHeadingChanges.length, 1);
});

test('h1 to h6 are typeset and cased; keep leaves case', async () => {
  const source = ['# the "one" thing', '## two', '### three', '#### the "four" way', '##### five -- a', '###### six of it'].join('\n\n');
  const on = await render(source, { file: 'h.md' });
  assert.match(on.html, /<h1 id="[^"]+">The “One” Thing<\/h1>/);
  assert.match(on.html, /<h4 id="[^"]+">The “Four” Way<\/h4>/);
  assert.match(on.html, /<h5 id="[^"]+">Five – A<\/h5>/);
  assert.match(on.html, /<h6 id="[^"]+">Six of It<\/h6>/);
  assert.equal(on.typographyHeadingChanges.length, 6);
  const kept = await render(source, { typography: { ...typography, headings: 'keep' } });
  assert.match(kept.html, /<h1 id="[^"]+">the “one” thing<\/h1>/);
  assert.match(kept.html, /<h4 id="[^"]+">the “four” way<\/h4>/);
  assert.match(kept.html, /<h6 id="[^"]+">six of it<\/h6>/);
  assert.deepEqual(kept.typographyHeadingChanges, []);
});

test('a heading inside data-typography off is not changed or reported', async () => {
  const { html, typographyHeadingChanges } = await render('<div data-typography="off">\n<h2>the "x" -- y</h2>\n</div>');
  assert.match(html, /<h2[^>]*>the "x" -- y<\/h2>/);
  assert.deepEqual(typographyHeadingChanges, []);
});

const NB = ' ';
const full = { ...typography, widows: true, hanging: true };

test('an opening quote at the start of a paragraph gets a hang span', async () => {
  const { html } = await render('«Hi there friend', { typography: { ...full, locale: 'ru' } });
  assert.match(html, /<p><span class="hang" data-m="quote">«<\/span>Hi there/);
});

test('brackets and sentence dashes hang; other starts do not', async () => {
  const bracket = await render('(see below) now ok', { typography: full });
  assert.match(bracket.html, /<p><span class="hang" data-m="bracket">\(<\/span>see/);
  const dash = await render('— Hi there friend', { typography: { ...full, locale: 'ru' } });
  assert.match(dash.html, /<p><span class="hang" data-m="dash">—<\/span>/);
  const none = await render('Hi there friend', { typography: full });
  assert.equal(none.html.includes('hang'), false);
  const quote = await render('> "Hi there friend"', { typography: full });
  assert.match(quote.html, /<blockquote>\s*<p><span class="hang" data-m="quote">“<\/span>Hi/);
  const item = await render('- "Hi there friend"\n\n# "Head" line here', { typography: full });
  assert.equal((item.html.match(/class="hang"/g) ?? []).length, 2);
});

test('the hang span is found through an inline element', async () => {
  const { html } = await render('*"a b* c" d', { typography: full });
  assert.match(html, /<em><span class="hang" data-m="quote">“<\/span>a/);
});

test('widows join the last two words across inline elements', async () => {
  const { html } = await render('one two *three* four', { typography: full });
  assert.match(html, new RegExp(`<p>one two <em>three</em>${NB}four</p>`));
  const heading = await render('## one two three', { typography: full });
  assert.match(heading.html, new RegExp(`Two${NB}Three</h2>`));
  const item = await render('- one two three', { typography: full });
  assert.match(item.html, new RegExp(`two${NB}three</li>`));
});

test('widow join respects the word and length limits', async () => {
  const two = await render('one two', { typography: full });
  assert.equal(two.html.includes(NB), false);
  const long = await render('one two abcdefghijklm', { typography: full });
  assert.equal(long.html.includes(NB), false);
  const ok = await render('one two abcdefghijkl', { typography: full });
  assert.equal(ok.html.includes(NB), true);
});

test('hanging: false and widows: false switch each off', async () => {
  const { html } = await render('“one two three four', { typography: { ...full, hanging: false, widows: false } });
  assert.equal(html.includes('hang'), false);
  assert.equal(html.includes(NB), false);
  const off = await render('one two three four', { typography: { ...full, widows: false } });
  assert.equal(off.html.includes(NB), false);
  const noHang = await render('"one two three four', { typography: { ...full, hanging: false } });
  assert.equal(noHang.html.includes('hang'), false);
  assert.equal(noHang.html.includes(NB), true);
});

test('plain mode emits no span and no no-break space', async () => {
  const { html } = await render('«Hi there, 12 km far — it is ok', {
    typography: { ...full, locale: 'fr', plain: true },
  });
  assert.equal(html.includes('hang'), false);
  assert.equal(/[  ]/.test(html), false);
});

test('a heading with widows is both cased and joined', async () => {
  const { html } = await render('## the quick brown fox', { typography: { ...full, hanging: false } });
  assert.match(html, /<h2[^>]*>The Quick Brown Fox<\/h2>/);
});
