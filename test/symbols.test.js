import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSites } from '../src/build.js';
import { loadConfig } from '../src/config.js';
import { checkReferenceConfig } from '../src/docs/reference-config.js';
import { SymbolIndex, SymbolIndexError, indexOfHtmlReference, indexOfView, linkSymbolsInHtml, parseDokkaPages } from '../src/docs/symbols.js';
import { ReportError } from '../src/report.js';
import { TINY_PNG } from './helpers/images.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const exampleConfig = join(root, 'example', 'coffer.yaml');
const dokkaFixture = join(root, 'test', 'fixtures', 'dokka');
const REFERENCE_URL = '/made/tool/docs/reference/';

// --- the dokka adapter ------------------------------------------------------------------------

test('the dokka adapter reads name, description and location of a pages.json fixture', () => {
  const entries = parseDokkaPages(readFileSync(join(dokkaFixture, 'pages.json'), 'utf8'), REFERENCE_URL);
  const byUrl = (/** @type {string} */ location) => entries.find((entry) => entry.url === `${REFERENCE_URL}${location}`);
  assert.equal(entries.length, 9);
  assert.equal(byUrl('root/com.example/-tool/index.html')?.name, 'com.example.Tool');
  assert.deepEqual([...(byUrl('root/com.example/-tool/index.html')?.keys ?? [])].sort(), ['Tool', 'com.example.Tool']);
  // A declaration is reduced to its identifier, qualified by the owner that the description names.
  assert.equal(byUrl('root/com.example/-tool/spacing.html')?.name, 'com.example.Tool.spacing');
  assert.ok(byUrl('root/com.example/-tool/spacing.html')?.keys?.includes('spacing'));
  // The anchor of a member is kept.
  assert.equal(byUrl('root/com.example/-tool/index.html#version')?.name, 'com.example.Tool.version');
});

test('the dokka index finds symbols by simple and by qualified name, and never guesses between two', () => {
  const index = new SymbolIndex(parseDokkaPages(readFileSync(join(dokkaFixture, 'pages.json'), 'utf8'), REFERENCE_URL));
  const tool = { url: `${REFERENCE_URL}root/com.example/-tool/index.html` };
  assert.deepEqual(index.lookup('Tool'), tool);
  assert.deepEqual(index.lookup('com.example.Tool'), tool);
  assert.deepEqual(index.lookup('spacing'), { url: `${REFERENCE_URL}root/com.example/-tool/spacing.html` });
  assert.deepEqual(index.lookup('com.example.Tool.spacing'), { url: `${REFERENCE_URL}root/com.example/-tool/spacing.html` });
  assert.deepEqual(index.lookup('run'), { url: `${REFERENCE_URL}root/com.example/-tool/run.html` });
  // Two classes with one simple name: the simple name is ambiguous, the qualified names are not.
  assert.deepEqual(index.lookup('Config'), { ambiguous: ['com.example.Config', 'com.other.Config'] });
  assert.deepEqual(index.lookup('com.other.Config'), { url: `${REFERENCE_URL}root/com.other/-config/index.html` });
  // Overloads share a qualified name and have two pages.
  assert.ok('ambiguous' in /** @type {object} */ (index.lookup('parse')));
  assert.ok('ambiguous' in /** @type {object} */ (index.lookup('com.example.Tool.parse')));
  // Names are matched exactly.
  assert.equal(index.lookup('tool'), null);
  assert.equal(index.lookup('Tool.run'), null);
  assert.equal(index.lookup(''), null);
});

test('the dokka adapter refuses a file that is not a list of records, and a location that leaves the reference', () => {
  const problem = (/** @type {string} */ text) => {
    try {
      parseDokkaPages(text, REFERENCE_URL);
    } catch (error) {
      assert.ok(error instanceof SymbolIndexError);
      return error.message;
    }
    return assert.fail('should have thrown');
  };
  assert.match(problem('{'), /not valid JSON/);
  assert.match(problem('{}'), /must be a list of records/);
  assert.match(problem('[1]'), /\[0\]: must be a mapping/);
  assert.match(problem('[{"location":"a.html"}]'), /\[0\]\.name: must be text/);
  assert.match(problem('[{"name":"A"}]'), /\[0\]\.location: must be text/);
  for (const location of ['../x.html', 'a/../../x.html', '/abs.html', 'https://evil.example/x', 'javascript:alert(1)', 'a b.html', '\\\\host\\share']) {
    assert.match(problem(JSON.stringify([{ name: 'A', location }])), /\[0\]\.location: .*relative address/, location);
  }
  // A record without an identifier is left out.
  assert.deepEqual(parseDokkaPages('[{"name":"  ","location":"a.html"}]', REFERENCE_URL), []);
});

test('an html reference reads the index file of the adapter from the generated folder', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coffer-symbols-'));
  try {
    mkdirSync(join(dir, 'scripts'));
    cpSync(join(dokkaFixture, 'pages.json'), join(dir, 'scripts', 'pages.json'));
    const index = indexOfHtmlReference({ adapter: 'dokka', file: null }, dir, REFERENCE_URL);
    assert.equal(index.size, 9);
    assert.deepEqual(index.lookup('Tool'), { url: `${REFERENCE_URL}root/com.example/-tool/index.html` });
    // The file can be named.
    cpSync(join(dokkaFixture, 'pages.json'), join(dir, 'symbols.json'));
    assert.equal(indexOfHtmlReference({ adapter: 'dokka', file: 'symbols.json' }, dir, REFERENCE_URL).size, 9);

    assert.throws(() => indexOfHtmlReference({ adapter: 'dokka', file: 'missing.json' }, dir, REFERENCE_URL), /"missing\.json" is not in the generated reference/);
    assert.throws(() => indexOfHtmlReference({ adapter: 'dokka', file: '../x.json' }, dir, REFERENCE_URL), /inside the generated folder/);
    assert.throws(() => indexOfHtmlReference({ adapter: 'javadoc', file: null }, dir, REFERENCE_URL), /unknown index adapter "javadoc"/);
    writeFileSync(join(dir, 'broken.json'), '{"a":1}');
    assert.throws(() => indexOfHtmlReference({ adapter: 'dokka', file: 'broken.json' }, dir, REFERENCE_URL), /broken\.json: must be a list of records/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the index of a json reference comes from the item names and their anchors', () => {
  const index = indexOfView(
    {
      sections: [
        { items: [{ id: 'kerf', name: 'Kerf' }, { id: 'kerf-waste', name: 'Kerf.waste' }] },
        { items: [{ id: 'other-waste', name: 'Other.waste' }, { id: 'x', name: ' ' }] },
      ],
    },
    REFERENCE_URL,
  );
  assert.equal(index.size, 3);
  assert.deepEqual(index.lookup('Kerf'), { url: `${REFERENCE_URL}#kerf` });
  assert.deepEqual(index.lookup('Kerf.waste'), { url: `${REFERENCE_URL}#kerf-waste` });
  assert.deepEqual(index.lookup('waste'), { ambiguous: ['Kerf.waste', 'Other.waste'] });
});

// --- the configuration ----------------------------------------------------------------------

test('the index and autoLink keys of a reference are checked', () => {
  const base = { command: 'x', format: 'html', output: 'o', title: 'T' };
  const named = checkReferenceConfig({ ...base, index: 'dokka' });
  assert.ok('value' in named);
  assert.deepEqual(named.value.index, { adapter: 'dokka', file: null });
  assert.equal(named.value.autoLink, true);
  const full = checkReferenceConfig({ ...base, index: { adapter: 'dokka', file: 'x/pages.json' }, autoLink: false });
  assert.ok('value' in full);
  assert.deepEqual(full.value.index, { adapter: 'dokka', file: 'x/pages.json' });
  assert.equal(full.value.autoLink, false);

  for (const [change, pattern] of /** @type {[Record<string, unknown>, RegExp][]} */ ([
    [{ index: 'javadoc' }, /reference\.index: must be the name of an adapter \(dokka\)/],
    [{ index: { adapter: 'dokka', file: '../x' } }, /reference\.index\.file: must be a path inside/],
    [{ index: { adapter: 'dokka', colour: 1 } }, /reference\.index\.colour: unknown key/],
    [{ index: 'dokka', format: 'json' }, /reference\.index: is only for the format html/],
    [{ autoLink: 'yes' }, /reference\.autoLink: must be true or false/],
  ])) {
    const checked = checkReferenceConfig({ ...base, ...change });
    assert.ok('problems' in checked, JSON.stringify(change));
    assert.match(checked.problems.join('\n'), pattern);
  }
});

// --- links in the HTML --------------------------------------------------------------------------

test('inline code that is exactly a symbol is linked; code blocks, links and names with no single place are not', () => {
  const index = new SymbolIndex([
    { name: 'Tool', url: '/r/#tool' },
    { name: 'Tool.run', url: '/r/#run' },
    { name: 'a.Config', url: '/r/#a' },
    { name: 'b.Config', url: '/r/#b' },
    { name: 'Gen<T>', url: '/r/?a=1&b="2"' },
  ]);
  const html = [
    '<p>Use <code>Tool</code> and <code>run</code> or <code>Tool.run</code>, not <code>tool</code> or <code>Tool.walk</code>.</p>',
    '<p>The <code>Config</code> is ambiguous; <code>a.Config</code> is not.</p>',
    '<p>Already a <a href="/x/"><code>Tool</code></a> link, and <a href="/y/">text <em>and</em> <code>Tool.run</code></a>.</p>',
    '<pre><code class="language-kotlin">Tool\n</code></pre>',
    '<p><code>Tool</code><code>Tool </code> <code><b>Tool</b></code> <code>Gen&lt;T></code></p>',
    '<script>var a = "<code>Tool</code>";</script>',
  ].join('\n');
  const result = linkSymbolsInHtml(html, index);
  assert.equal(result.linked, 6);
  assert.equal(
    result.html,
    [
      '<p>Use <a href="/r/#tool"><code>Tool</code></a> and <a href="/r/#run"><code>run</code></a> or <a href="/r/#run"><code>Tool.run</code></a>, not <code>tool</code> or <code>Tool.walk</code>.</p>',
      '<p>The <code>Config</code> is ambiguous; <a href="/r/#a"><code>a.Config</code></a> is not.</p>',
      '<p>Already a <a href="/x/"><code>Tool</code></a> link, and <a href="/y/">text <em>and</em> <code>Tool.run</code></a>.</p>',
      '<pre><code class="language-kotlin">Tool\n</code></pre>',
      '<p><a href="/r/#tool"><code>Tool</code></a><code>Tool </code> <code><b>Tool</b></code> <a href="/r/?a=1&amp;b=&quot;2&quot;"><code>Gen&lt;T></code></a></p>',
      '<script>var a = "<code>Tool</code>";</script>',
    ].join('\n'),
  );
  // Nothing to link: the text is returned as it is.
  assert.deepEqual(linkSymbolsInHtml(html, new SymbolIndex([])), { html, linked: 0 });
});

// --- guides in a build ----------------------------------------------------------------------------

test('the sample tool: a guide links to its reference by an explicit ref: link and by inline code', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coffer-symbols-example-'));
  try {
    await buildSites(loadConfig({ configPath: exampleConfig }), { out: dir, now: new Date('2026-06-01T12:00:00Z'), cacheDir: join(dir, '.cache'), reportDir: join(dir, '.coffer') });
    const usage = readFileSync(join(dir, 'workshop', 'made', 'kerfcalc', 'docs', 'usage', 'index.html'), 'utf8');
    const reference = '/made/kerfcalc/docs/reference/';
    // Explicit: [the waste function](ref:Kerf.waste).
    assert.match(usage, new RegExp(`<a href="${reference}#kerf-waste">the waste function</a>`));
    // Automatic: `Kerf.spacing` and `Kerf`.
    assert.match(usage, new RegExp(`<a href="${reference}#kerf-spacing"><code>Kerf\\.spacing</code></a>`));
    assert.match(usage, new RegExp(`<a href="${reference}#kerf"><code>Kerf</code></a> object`));
    // Not a symbol, and nothing in a code block is linked; no `ref:` is left.
    assert.match(usage, /<code>kerfcalc waste<\/code>/);
    assert.doesNotMatch(usage, /<a [^>]*><code>kerfcalc waste/);
    assert.match(usage, /<pre[^>]*>[\s\S]*Kerf[\s\S]*<\/pre>/);
    assert.doesNotMatch(usage, /<pre[^>]*>(?:(?!<\/pre>)[\s\S])*<a /);
    assert.doesNotMatch(usage, /ref:/);
    // The anchors exist on the reference page.
    const page = readFileSync(join(dir, 'workshop', 'made', 'kerfcalc', 'docs', 'reference', 'index.html'), 'utf8');
    for (const id of ['kerf', 'kerf-waste', 'kerf-spacing']) assert.match(page, new RegExp(`id="${id}"`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const SITE_CONFIG = [
  'sites:',
  '  - id: demo',
  '    baseUrl: https://demo.example',
  '    lang: en',
  '    title: Demo',
  '    description: A demo site.',
  '    projects: { dir: content/projects }',
  '',
].join('\n');

/** A generator of a json reference with two symbols that share a simple name. */
const GENERATOR = `
const { mkdirSync, writeFileSync } = require('node:fs');
const { dirname } = require('node:path');
mkdirSync(dirname(process.argv[2]), { recursive: true });
writeFileSync(process.argv[2], JSON.stringify({ title: 'Lathe API', sections: [
  { title: 'Classes', items: [
    { name: 'Lathe', kind: 'class', description: 'The machine.', anchor: 'lathe' },
    { name: 'Lathe.turn', kind: 'function', description: 'Turns.' },
    { name: 'Chuck.turn', kind: 'function', description: 'Also turns.' },
  ] },
] }));
`;

/** A generator of an html reference that has the Dokka index file. */
const HTML_GENERATOR = `
const { cpSync, mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const out = process.argv[2];
mkdirSync(join(out, 'scripts'), { recursive: true });
writeFileSync(join(out, 'index.html'), '<html><body><h1>API</h1></body></html>');
cpSync(process.argv[3], join(out, 'scripts', 'pages.json'));
`;

/**
 * A made-up site with one tool project, `lathe`, whose repository is the `tool` folder next to the configuration.
 *
 * @param {Record<string, string | Buffer>} tool The files of the tool repository.
 * @param {Record<string, unknown> | null} reference The `reference` of the docs block; null for none.
 * @returns {Record<string, string | Buffer>}
 */
function siteWith(tool, reference) {
  const docs = { source: { path: '../../../tool' }, github: 'me/lathe', guides: [{ dir: 'docs' }], ...(reference ? { reference } : {}) };
  /** @type {Record<string, string | Buffer>} */
  const files = {
    'coffer.yaml': SITE_CONFIG,
    'content/home.md': '---\ntitle: Demo\n---\n\nAbout.\n',
    'content/projects/lathe/project.yaml': `name: Lathe\npitch: Turns wood.\nkind: tool\nstatus: released\ncard: card.png\nrepo: https://github.example/me/lathe\ndocs: ${JSON.stringify(docs)}\n`,
    'content/projects/lathe/index.md': 'Text.\n',
    'content/projects/lathe/card.png': TINY_PNG,
  };
  for (const [name, content] of Object.entries(tool)) files[`tool/${name}`] = content;
  return files;
}

/**
 * @template T
 * @param {Record<string, string | Buffer>} files
 * @param {(dir: string) => Promise<T>} body
 * @returns {Promise<T>}
 */
async function inSite(files, body) {
  const dir = mkdtempSync(join(tmpdir(), 'coffer-symbols-site-'));
  try {
    for (const [name, content] of Object.entries(files)) {
      const target = join(dir, ...name.split('/'));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    return await body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** @param {string} dir */
function build(dir) {
  return buildSites(loadConfig({ configPath: join(dir, 'coffer.yaml') }), { out: join(dir, 'out'), now: new Date('2026-06-01T12:00:00Z') });
}

/**
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function errorsOf(dir) {
  try {
    await build(dir);
  } catch (error) {
    assert.ok(error instanceof ReportError, String(error));
    return error.errors;
  }
  return assert.fail('the build should have failed');
}

/**
 * @param {string} dir
 * @param {string} page
 * @returns {string}
 */
function guide(dir, page) {
  return readFileSync(join(dir, 'out', 'demo', 'made', 'lathe', 'docs', page, 'index.html'), 'utf8');
}

const JSON_REFERENCE = { command: ['node', 'gen.js', '{out}/reference.json'], format: 'json', output: '{out}/reference.json', title: 'Lathe API' };

test('an unknown ref: link fails the build and names the guide file and the line', async () => {
  const text = '# Start\n\nSome text.\n\nSee [the chuck](ref:Chuck) and [more](ref:Lathe.gone).\n';
  await inSite(siteWith({ 'gen.js': GENERATOR, 'docs/start.md': text }, JSON_REFERENCE), async (dir) => {
    const errors = await errorsOf(dir);
    assert.equal(errors.length, 2, errors.join('\n'));
    assert.match(errors[0], /tool:docs\/start\.md:5:/);
    assert.match(errors[0], /broken link 'ref:Chuck' \(the reference has no symbol "Chuck"\)/);
    assert.match(errors[1], /tool:docs\/start\.md:5:/);
    assert.match(errors[1], /ref:Lathe\.gone/);
  });
});

test('a ref: link to an ambiguous name fails, a qualified name works, and the simple name is not auto-linked', async () => {
  await inSite(siteWith({ 'gen.js': GENERATOR, 'docs/start.md': '# Start\n\nBy [simple name](ref:turn).\n' }, JSON_REFERENCE), async (dir) => {
    const errors = await errorsOf(dir);
    assert.equal(errors.length, 1, errors.join('\n'));
    assert.match(errors[0], /tool:docs\/start\.md:3:/);
    assert.match(errors[0], /ambiguous link 'ref:turn' \("turn" names "Chuck\.turn", "Lathe\.turn"; write the qualified name\)/);
  });
  const text = '# Start\n\nThe `turn` function is on two classes, `Lathe.turn` is one, and [it](ref:Chuck.turn) the other. The `Lathe` class.\n';
  await inSite(siteWith({ 'gen.js': GENERATOR, 'docs/start.md': text }, JSON_REFERENCE), async (dir) => {
    await build(dir);
    const html = guide(dir, 'start');
    const reference = '/made/lathe/docs/reference/';
    assert.match(html, /<code>turn<\/code> function/);
    assert.match(html, new RegExp(`<a href="${reference}#lathe-turn"><code>Lathe\\.turn</code></a>`));
    assert.match(html, new RegExp(`<a href="${reference}#chuck-turn">it</a>`));
    assert.match(html, new RegExp(`<a href="${reference}#lathe"><code>Lathe</code></a> class`));
  });
});

test('autoLink: false leaves inline code alone, and explicit ref: links still work', async () => {
  const text = '# Start\n\nThe `Lathe` class, and [the same](ref:Lathe).\n';
  await inSite(siteWith({ 'gen.js': GENERATOR, 'docs/start.md': text }, { ...JSON_REFERENCE, autoLink: false }), async (dir) => {
    await build(dir);
    const html = guide(dir, 'start');
    assert.match(html, /The <code>Lathe<\/code> class, and <a href="\/made\/lathe\/docs\/reference\/#lathe">the same<\/a>\./);
  });
});

test('a ref: link in a project without a reference fails the build', async () => {
  await inSite(siteWith({ 'docs/start.md': '# Start\n\n[x](ref:Lathe)\n' }, null), async (dir) => {
    const errors = await errorsOf(dir);
    assert.equal(errors.length, 1, errors.join('\n'));
    assert.match(errors[0], /tool:docs\/start\.md:3:.*the project has no symbols to link to/);
  });
});

test('an html reference links guides through the dokka adapter', async () => {
  const pages = readFileSync(join(dokkaFixture, 'pages.json'));
  const text = '# Start\n\nThe `Tool` class, `com.example.Tool.run`, [spacing](ref:spacing) and `Config`.\n';
  const reference = { command: ['node', 'gen.js', '{out}', '{repo}/pages.json'], format: 'html', output: '{out}', title: 'Lathe API', index: 'dokka' };
  await inSite(siteWith({ 'gen.js': HTML_GENERATOR, 'pages.json': pages, 'docs/start.md': text }, reference), async (dir) => {
    await build(dir);
    const html = guide(dir, 'start');
    const base = '/made/lathe/docs/reference/root/com.example/-tool';
    assert.match(html, new RegExp(`<a href="${base}/index\\.html"><code>Tool</code></a> class`));
    assert.match(html, new RegExp(`<a href="${base}/run\\.html"><code>com\\.example\\.Tool\\.run</code></a>`));
    assert.match(html, new RegExp(`<a href="${base}/spacing\\.html">spacing</a>`));
    // Two classes are called Config.
    assert.match(html, /and <code>Config<\/code>\./);
  });
  // Without the index the html reference has no symbols, and a ref: link says so.
  await inSite(siteWith({ 'gen.js': HTML_GENERATOR, 'pages.json': pages, 'docs/start.md': text }, { ...reference, index: undefined }), async (dir) => {
    const errors = await errorsOf(dir);
    assert.match(errors.join('\n'), /tool:docs\/start\.md:3:.*"index"/);
  });
  // A generated folder without the index file fails the build, naming the project file.
  await inSite(siteWith({ 'gen.js': HTML_GENERATOR, 'pages.json': pages, 'docs/start.md': text }, { ...reference, index: { adapter: 'dokka', file: 'scripts/nope.json' } }), async (dir) => {
    const errors = await errorsOf(dir);
    assert.match(errors.join('\n'), /content\/projects\/lathe\/project\.yaml docs\.reference\.index: the index file "scripts\/nope\.json" is not in the generated reference/);
  });
});
