import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MarkdownError,
  renderMarkdown,
  DEFAULT_TOC_MIN_HEADINGS,
  DEFAULT_WORDS_PER_MINUTE,
} from '../src/markdown/render.js';
import * as engine from '../src/index.js';

/**
 * @param {number} count
 * @param {string} [word]
 * @returns {string}
 */
function words(count, word = 'word') {
  return Array.from({ length: count }, () => word).join(' ');
}

test('the engine entry point exports the Markdown renderer', () => {
  assert.equal(engine.renderMarkdown, renderMarkdown);
  assert.equal(engine.MarkdownError, MarkdownError);
});

test('defaults are four headings and two hundred words per minute', () => {
  assert.equal(DEFAULT_TOC_MIN_HEADINGS, 4);
  assert.equal(DEFAULT_WORDS_PER_MINUTE, 200);
});

test('renders paragraphs, emphasis and links', async () => {
  const result = await renderMarkdown('Hello *there*, see [the docs](https://example.org/docs).');
  assert.match(
    result.html,
    /<p>Hello <em>there<\/em>, see <a href="https:\/\/example\.org\/docs">the docs<\/a>\.<\/p>/,
  );
});

test('renders GFM tables', async () => {
  const { html } = await renderMarkdown('| a | b |\n| - | - |\n| 1 | 2 |\n');
  assert.match(html, /<table>/);
  assert.match(html, /<th>a<\/th>/);
  assert.match(html, /<td>2<\/td>/);
});

test('renders block quotes', async () => {
  const { html } = await renderMarkdown('> A quoted line.\n>\n> Second paragraph.\n');
  assert.match(html, /<blockquote>/);
  assert.match(html, /<p>A quoted line\.<\/p>/);
  assert.match(html, /<p>Second paragraph\.<\/p>/);
});

test('gives headings stable ids, including for Cyrillic text and repeats', async () => {
  const source = '## Getting started\n\n### Привет, мир\n\n## Getting started\n';
  const first = await renderMarkdown(source);
  const second = await renderMarkdown(source);
  assert.equal(first.html, second.html);
  assert.match(first.html, /<h2 id="getting-started">Getting started<\/h2>/);
  assert.match(first.html, /<h3 id="привет-мир">Привет, мир<\/h3>/);
  assert.match(first.html, /<h2 id="getting-started-1">Getting started<\/h2>/);
});

test('highlights fenced code with both a light and a dark colour', async () => {
  const { html } = await renderMarkdown('```js\nconst answer = 42;\n```\n');
  assert.match(html, /<pre class="shiki/);
  assert.match(html, /--shiki-light:#[0-9a-fA-F]{3,8}/);
  assert.match(html, /--shiki-dark:#[0-9a-fA-F]{3,8}/);
  assert.match(html, /answer/);
});

test('code without a language and with an unknown language still renders', async () => {
  const plain = await renderMarkdown('```\n<b>not html</b>\n```\n');
  assert.match(plain.html, /&#x3C;b>|&lt;b>/);
  const unknown = await renderMarkdown('```not-a-language\nsome text\n```\n');
  assert.match(unknown.html, /some text/);
  assert.match(unknown.html, /<pre class="shiki/);
});

test('inline code is left alone', async () => {
  const { html } = await renderMarkdown('Use `npm test` here.');
  assert.match(html, /<code>npm test<\/code>/);
});

test('a post with four headings gets a table of contents', async () => {
  const source = '## One\n\ntext\n\n### Two\n\n## Three\n\n### Four\n\n#### Not listed\n';
  const { toc } = await renderMarkdown(source);
  assert.deepEqual(toc, [
    { id: 'one', text: 'One', depth: 2 },
    { id: 'two', text: 'Two', depth: 3 },
    { id: 'three', text: 'Three', depth: 2 },
    { id: 'four', text: 'Four', depth: 3 },
  ]);
});

test('a short post gets no table of contents', async () => {
  const { toc, html } = await renderMarkdown('## One\n\n## Two\n\n### Three\n');
  assert.deepEqual(toc, []);
  assert.match(html, /<h2 id="one">/);
});

test('the heading threshold is configurable', async () => {
  const source = '## One\n\n## Two\n';
  assert.equal((await renderMarkdown(source, { tocMinHeadings: 2 })).toc.length, 2);
  assert.equal((await renderMarkdown(source, { tocMinHeadings: 3 })).toc.length, 0);
});

test('headings inside code blocks and h1/h4 do not count', async () => {
  const source = '# Title\n\n```md\n## Fake\n```\n\n#### Deep\n\n## Real\n';
  const { toc } = await renderMarkdown(source, { tocMinHeadings: 1 });
  assert.deepEqual(toc, [{ id: 'real', text: 'Real', depth: 2 }]);
});

test('toc text is plain text without markup', async () => {
  const { toc } = await renderMarkdown('## A *bold* `move`\n', { tocMinHeadings: 1 });
  assert.equal(toc[0]?.text, 'A bold move');
});

test('reading time for English text', async () => {
  assert.equal((await renderMarkdown(words(100))).readingMinutes, 1);
  assert.equal((await renderMarkdown(words(200))).readingMinutes, 1);
  assert.equal((await renderMarkdown(words(201))).readingMinutes, 2);
  assert.equal((await renderMarkdown(words(1000))).readingMinutes, 5);
});

test('reading time for Russian text', async () => {
  const result = await renderMarkdown(words(450, 'слово'));
  assert.equal(result.words, 450);
  assert.equal(result.readingMinutes, 3);
});

test('word counting skips punctuation and counts numbers', async () => {
  const { words: count } = await renderMarkdown('Вторник — день, когда мы пошли в кафе (well known!) 42 ...');
  assert.equal(count, 10);
});

test('reading time follows the configured speed and is at least one minute', async () => {
  assert.equal((await renderMarkdown(words(300), { wordsPerMinute: 100 })).readingMinutes, 3);
  assert.equal((await renderMarkdown('')).readingMinutes, 1);
});

test('words of adjacent blocks do not run together', async () => {
  const { words: count } = await renderMarkdown('# One\n\ntwo\n\n- three\n- four\n');
  assert.equal(count, 4);
});

test('code blocks do not add to the reading time', async () => {
  const source = `${words(10)}\n\n\`\`\`\n${words(5000)}\n\`\`\`\n`;
  const result = await renderMarkdown(source);
  assert.equal(result.words, 10);
  assert.equal(result.readingMinutes, 1);
});

test('invalid options are rejected', async () => {
  await assert.rejects(renderMarkdown('x', { wordsPerMinute: 0 }), /wordsPerMinute/);
  await assert.rejects(renderMarkdown('x', { tocMinHeadings: 1.5 }), /tocMinHeadings/);
});

test('finds the first image', async () => {
  const source = 'Intro\n\n![A hill](hill.jpg)\n\n![Second](two.png)\n';
  const { firstImage } = await renderMarkdown(source);
  assert.deepEqual(firstImage, { src: 'hill.jpg', alt: 'A hill' });
});

test('firstImage is null when there are no images', async () => {
  assert.equal((await renderMarkdown('No pictures.')).firstImage, null);
});

test('collects links and images with their lines', async () => {
  const source = 'See [one](https://a.example/).\n\n![pic](p.png)\n\n[ref][r]\n\n[r]: ../other/\n';
  const { links } = await renderMarkdown(source, { startLine: 10 });
  assert.deepEqual(links, [
    { url: 'https://a.example/', kind: 'link', line: 10 },
    { url: 'p.png', kind: 'image', line: 12 },
    { url: '../other/', kind: 'link', line: 14 },
  ]);
});

test('raw HTML passes through, so a video can be embedded with an iframe', async () => {
  const source = [
    '<div class="embed">',
    '<iframe src="https://www.youtube-nocookie.com/embed/abc" title="Clip" allowfullscreen></iframe>',
    '</div>',
    '',
    'After.',
  ].join('\n');
  const { html } = await renderMarkdown(source);
  assert.match(
    html,
    /<div class="embed">\n<iframe src="https:\/\/www\.youtube-nocookie\.com\/embed\/abc" title="Clip" allowfullscreen><\/iframe>\n<\/div>/,
  );
  assert.match(html, /<p>After\.<\/p>/);
});

test('an unknown directive is an error with file and line', async () => {
  const source = 'Fine.\n\n::carousel\n';
  await assert.rejects(
    renderMarkdown(source, { file: 'blog/hike/index.md', startLine: 5 }),
    (error) => {
      assert.ok(error instanceof MarkdownError);
      assert.equal(error.file, 'blog/hike/index.md');
      assert.equal(error.line, 7);
      assert.match(error.message, /blog\/hike\/index\.md:7/);
      assert.match(error.message, /carousel/);
      return true;
    },
  );
});

test('text and container directives are errors too', async () => {
  await assert.rejects(renderMarkdown('A :tag here.'), MarkdownError);
  await assert.rejects(renderMarkdown(':::map\ncontent\n:::\n'), MarkdownError);
});

test('colons in ordinary prose and URLs are not directives', async () => {
  const { html } = await renderMarkdown('At 10:30 see https://example.org/a:b and note: this.');
  assert.match(html, /10:30/);
  assert.match(html, /note: this/);
  assert.match(html, /a:b/);
  assert.match((await renderMarkdown('Note:this is fine.')).html, /Note:this is fine/);
  const russian = await renderMarkdown('Встреча в 18:45, не позже.');
  assert.match(russian.html, /18:45/);
});

test('a backslash gives a plain colon before a letter', async () => {
  const { html } = await renderMarkdown(String.raw`Say \:smile\: please.`);
  assert.match(html, /Say :smile: please\./);
});
