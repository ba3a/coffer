import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkDirective from 'remark-directive';
import remarkRehype from 'remark-rehype';
import rehypeStringify from 'rehype-stringify';
import { remarkEscapes, remarkVerbatim, rehypeRestoreEscapes, restoreEscapes, VERBATIM_DIRECTIVE } from '../src/typography/escapes.js';
import { renderMarkdown, rejectDirectives } from '../src/markdown/render.js';

/**
 * @param {string} source
 * @param {{ restore?: boolean }} [options]
 */
async function run(source, { restore = true } = {}) {
  const processor = unified().use(remarkParse).use(remarkDirective).use(remarkVerbatim).use(remarkEscapes).use(remarkRehype);
  if (restore) processor.use(rehypeRestoreEscapes);
  return String(await processor.use(rehypeStringify).process(source));
}

test('an escaped quote survives as typed', async () => {
  assert.equal(await run('say \\"hi\\" and \\\'x\\\''), '<p>say "hi" and \'x\'</p>');
});

test('an escaped double hyphen survives as two hyphens', async () => {
  assert.equal(await run('a \\-- b'), '<p>a -- b</p>');
});

test('escaped dots survive as three dots', async () => {
  assert.equal(await run('wait\\...'), '<p>wait...</p>');
});

test('the escape is replaced by a placeholder before the restore step', async () => {
  const html = await run('\\"a\\" \\-- \\...', { restore: false });
  assert.match(html, /[-]/u);
  assert.equal(restoreEscapes(html), '<p>"a" -- ...</p>');
});

test('unescaped characters and other escapes are left alone', async () => {
  assert.equal(await run('a "b" -- c \\* d'), '<p>a "b" -- c * d</p>');
});

test('an escape survives next to an entity', async () => {
  assert.equal(await run('a \\" &amp; b \\"'), '<p>a " &#x26; b "</p>');
  const html = await run('a \\" &copy; b \\--', { restore: false });
  assert.equal(restoreEscapes(html), '<p>a " © b --</p>');
  assert.doesNotMatch(html, /"|--/u);
});

test('an escape survives in a text of several lines in a quote', async () => {
  const html = await run('> a \\"\n> b \\"\n> c \\...', { restore: false });
  assert.equal(restoreEscapes(html), '<blockquote>\n<p>a "\nb "\nc ...</p>\n</blockquote>');
  assert.doesNotMatch(html, /"|\.\.\./u);
});

test('an escape survives in a text of several lines in a list item', async () => {
  const html = await run('- x \\"\n  y \\"', { restore: false });
  assert.equal(restoreEscapes(html), '<ul>\n<li>x "\ny "</li>\n</ul>');
  assert.doesNotMatch(html, /"/u);
});

test('rejectDirectives lets an allowed directive pass', () => {
  const tree = unified().use(remarkParse).use(remarkDirective).parse(':verbatim[x]');
  const reject = rejectDirectives({ lineOffset: 0 });
  assert.throws(() => reject(tree), /unknown directive "verbatim"/);
  assert.doesNotThrow(() => rejectDirectives({ lineOffset: 0, allowed: new Set([VERBATIM_DIRECTIVE]) })(tree));
});

test(':verbatim[x] renders a span with data-typography="off"', async () => {
  assert.equal(await run('a :verbatim[x] b'), '<p>a <span data-typography="off">x</span> b</p>');
});

test(':::verbatim renders a div with data-typography="off"', async () => {
  assert.equal(await run(':::verbatim\n"a" -- b\n:::'), '<div data-typography="off"><p>"a" -- b</p></div>');
});

test('placeholders never reach attribute values', async () => {
  assert.equal(await run('[a](/x "t")'), '<p><a href="/x" title="t">a</a></p>');
});

test('renderMarkdown is unchanged without the typography option', async () => {
  const { html } = await renderMarkdown('say \\"hi\\" -- ok\\...');
  assert.equal(html, '<p>say "hi" -- ok...</p>');
  await assert.rejects(renderMarkdown('a :verbatim[x] b'), /unknown directive "verbatim"/);
});
