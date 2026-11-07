import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSites } from '../src/build.js';
import { checkOutput } from '../src/check/index.js';
import { loadConfig } from '../src/config.js';
import { checkDocsConfig } from '../src/docs/sources.js';
import { checkReferenceConfig } from '../src/docs/reference-config.js';
import {
  backBarHtml,
  commandFor,
  configHash,
  injectBackBar,
  parseReferenceJson,
  shellQuote,
  siteInputsHash,
  substitutePlaceholders,
  viewOfReference,
  withoutSecrets,
} from '../src/docs/reference.js';
import { ReportError } from '../src/report.js';
import { TINY_PNG } from './helpers/images.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const exampleConfig = join(root, 'example', 'coffer.yaml');

const GIT_AVAILABLE = spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;
const NO_GIT = GIT_AVAILABLE ? false : 'git is not installed';

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

/** A generator that writes a JSON reference to its first argument and counts its runs in the file named by its second. */
const JSON_GENERATOR = `
const { appendFileSync, mkdirSync, writeFileSync } = require('node:fs');
const { dirname, join } = require('node:path');
const [out, site] = process.argv.slice(2);
if (site) appendFileSync(join(site, 'runs.log'), 'x');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({
  title: 'Lathe API',
  sections: [
    { title: 'Commands', items: [
      { name: 'turn', kind: 'command', signature: 'lathe turn <file>', description: 'Turns a file.\\n\\nSecond paragraph.', anchor: 'cmd-turn' },
      { name: 'polish', kind: 'command', signature: 'lathe polish', description: 'SECRET description of an undocumented item', undocumented: true },
    ] },
    { title: 'Options', items: [
      { name: '--speed', signature: '--speed <rpm>', description: 'The speed <b>in</b> rpm.' },
    ] },
  ],
}));
`;

/** A generator that writes a folder of HTML files and prints two "undocumented" lines. */
const HTML_GENERATOR = `
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const out = process.argv[2];
mkdirSync(join(out, 'api', 'deep'), { recursive: true });
writeFileSync(join(out, 'index.html'), '<!doctype html>\\n<html><head><title>API</title></head><body class="x>y" data-a=\\'>\\'>\\n<h1>API</h1>\\n</body></html>\\n');
writeFileSync(join(out, 'api', 'deep', 'Page.HTM'), '<html><body><p>deep</p></body></html>');
writeFileSync(join(out, 'fragment.html'), '<p>no body at all</p>');
writeFileSync(join(out, 'style.css'), 'body { color: red; }\\n');
writeFileSync(join(out, 'data.bin'), Buffer.from([0, 255, 254, 1, 2, 60, 98, 111, 100, 121, 62]));
console.log('undocumented: Lathe.turn');
console.log('noise');
console.log('undocumented: Lathe.polish');
console.log('undocumented: Lathe.turn');
`;

/**
 * @param {Record<string, unknown>} reference The `reference` mapping.
 * @returns {string} The docs block of a project.
 */
function docsYaml(reference) {
  return `docs: ${JSON.stringify({ source: { path: '../../../tool' }, github: 'me/lathe', reference })}\n`;
}

/** @param {Record<string, unknown>} [more] */
function jsonReference(more = {}) {
  return {
    command: ['node', 'gen.js', '{out}/reference.json', '{site}'],
    format: 'json',
    output: '{out}/reference.json',
    title: 'Lathe reference',
    ...more,
  };
}

/**
 * A made-up site with one tool project, `lathe`, whose source is the `tool` folder next to the configuration.
 *
 * @param {Record<string, string | Buffer>} tool
 * @param {string} docs The docs block.
 * @returns {Record<string, string | Buffer>}
 */
function siteWith(tool, docs) {
  /** @type {Record<string, string | Buffer>} */
  const files = {
    'coffer.yaml': SITE_CONFIG,
    'content/home.md': '---\ntitle: Demo\n---\n\nAbout.\n',
    'content/projects/lathe/project.yaml': `name: Lathe\npitch: Turns wood.\nkind: tool\nstatus: released\ncard: card.png\nrepo: https://github.example/me/lathe\n${docs}`,
    'content/projects/lathe/index.md': 'Text.\n',
    'content/projects/lathe/card.png': TINY_PNG,
  };
  for (const [name, content] of Object.entries(tool)) files[`tool/${name}`] = content;
  return files;
}

/**
 * @template T
 * @param {Record<string, string | Buffer>} files
 * @param {(dir: string) => Promise<T> | T} body
 * @returns {Promise<T>}
 */
async function inSite(files, body) {
  const dir = mkdtempSync(join(tmpdir(), 'coffer-reference-'));
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

/**
 * @param {string} dir
 * @param {Parameters<typeof buildSites>[1]} [options]
 */
function build(dir, options = {}) {
  return buildSites(loadConfig({ configPath: join(dir, 'coffer.yaml') }), {
    out: join(dir, 'out'),
    now: new Date('2026-06-01T12:00:00Z'),
    ...options,
  });
}

/**
 * @param {string} dir
 * @returns {Promise<string[]>} The findings of a build that must fail.
 */
async function errorsOf(dir, options = {}) {
  try {
    await build(dir, options);
  } catch (error) {
    assert.ok(error instanceof ReportError, String(error));
    return error.errors;
  }
  return assert.fail('the build should have failed');
}

/**
 * @param {string} dir
 * @returns {{ warnings: { message: string }[] }}
 */
function reportOf(dir) {
  return JSON.parse(readFileSync(join(dir, '.coffer', 'report.json'), 'utf8'));
}

/**
 * @param {string} dir
 * @param {string} [path] Below `/made/lathe/docs/reference/`.
 * @returns {string}
 */
function referenceFile(dir, path = 'index.html') {
  return join(dir, 'out', 'demo', 'made', 'lathe', 'docs', 'reference', ...path.split('/'));
}

// --- the configuration ---------------------------------------------------------------------

test('a reference needs a command, a format, an output and a title; every problem is reported at once', () => {
  const ok = checkReferenceConfig({ command: ['node', 'x.js', '{out}/r.json'], format: 'json', output: '{out}/r.json', title: 'Reference' });
  assert.deepEqual(ok, { value: { command: ['node', 'x.js', '{out}/r.json'], format: 'json', output: '{out}/r.json', title: 'Reference', undocumented: null, index: null, autoLink: true } });
  const text = checkReferenceConfig({ command: './gradlew dokkaHtml', format: 'html', output: 'build/dokka', title: 'API', undocumented: { pattern: 'warning: (?<name>\\S+) is undocumented' } });
  assert.ok('value' in text);
  assert.equal(text.value.command, './gradlew dokkaHtml');
  assert.deepEqual(text.value.undocumented, { pattern: 'warning: (?<name>\\S+) is undocumented' });

  const bad = checkReferenceConfig({ format: 'pdf', title: '', colour: 1, undocumented: { pattern: '(unnamed)' } });
  assert.ok('problems' in bad);
  assert.deepEqual(
    bad.problems.map((problem) => problem.split(':')[0]),
    ['reference.colour', 'reference.command', 'reference.format', 'reference.output', 'reference.title', 'reference.undocumented.pattern'],
  );
  assert.ok('problems' in checkReferenceConfig({ command: [], format: 'json', output: 'x', title: 'T' }));
  assert.ok('problems' in checkReferenceConfig({ command: 'a\nb', format: 'json', output: 'x', title: 'T' }));
  assert.ok('problems' in checkReferenceConfig({ command: 'x', format: 'json', output: 'x', title: 'T', undocumented: { pattern: '(?<name>[' } }));
  assert.ok('problems' in checkReferenceConfig({ command: 'x', format: 'json', output: 'x', title: 'T', undocumented: { regex: 'a' } }));
  assert.ok('problems' in checkReferenceConfig('nope'));
});

test('the docs block carries the checked reference, and a bad one is a problem of the block', () => {
  const ok = checkDocsConfig({ source: { path: '.' }, reference: { command: 'x', format: 'json', output: 'o.json', title: 'T' } }, { dir: root });
  assert.ok('value' in ok);
  assert.deepEqual(ok.value.reference, { command: 'x', format: 'json', output: 'o.json', title: 'T', undocumented: null, index: null, autoLink: true });
  const bad = checkDocsConfig({ source: { path: '.' }, reference: { command: 'x' } }, { dir: root });
  assert.ok('problem' in bad);
  assert.match(bad.problem, /reference\.format: is required/);
  assert.match(bad.problem, /reference\.output: is required/);
  assert.match(bad.problem, /reference\.title: is required/);
});

test('placeholders are replaced, and quoted only in a command line', () => {
  const values = { repo: '/a b', out: '/o', site: '/s' };
  assert.equal(substitutePlaceholders('{out}/x.json {unknown} ${HOME}', values), '/o/x.json {unknown} ${HOME}');
  assert.equal(substitutePlaceholders('cd {repo} && run {out}', values, (value) => shellQuote(value, 'linux')), "cd '/a b' && run /o");
  assert.equal(shellQuote("it's", 'linux'), "'it'\\''s'");
  assert.equal(shellQuote('C:\\a b\\c', 'win32'), '"C:\\a b\\c"');
  assert.equal(shellQuote('C:\\ab', 'win32'), 'C:\\ab');
});

// --- the JSON format -----------------------------------------------------------------------

test('a json reference is checked, with the place of every problem', () => {
  const good = parseReferenceJson(JSON.stringify({ sections: [{ title: 'S', items: [{ name: 'a' }, { name: 'b', undocumented: true, anchor: 'bee' }] }] }));
  assert.ok('model' in good);
  assert.equal(good.model.title, null);
  assert.deepEqual(good.model.sections[0].items[1], { name: 'b', kind: '', signature: '', description: '', anchor: 'bee', undocumented: true });

  const bad = parseReferenceJson(
    JSON.stringify({
      sections: [
        { title: 'S', items: [{ name: 'a', anchor: 'x' }, { name: '', kind: 5 }, { name: 'c', anchor: 'x' }, { name: 'd', anchor: 'has space' }, 'text'] },
        { items: [] },
      ],
    }),
  );
  assert.ok('problems' in bad);
  assert.deepEqual(bad.problems, [
    'sections[0].items[1].name: must not be empty',
    'sections[0].items[1].kind: must be text',
    'sections[0].items[2].anchor: "x" is already the anchor of sections[0].items[0]',
    'sections[0].items[3].anchor: must be letters, digits, "-", "_", "." and ":", starting with a letter or digit, at most 200 characters',
    'sections[0].items[4]: must be an object with name',
    'sections[1].title: is required',
  ]);

  assert.match(/** @type {{ problems: string[] }} */ (parseReferenceJson('{')).problems[0], /is not valid JSON/);
  assert.match(/** @type {{ problems: string[] }} */ (parseReferenceJson('[]')).problems[0], /top level must be an object/);
  assert.match(/** @type {{ problems: string[] }} */ (parseReferenceJson('{"sections": 3}')).problems[0], /sections: is required and must be a list/);
});

test('ids are the anchors of the file, else made from the names and made unique; undocumented items lose their description', () => {
  const parsed = parseReferenceJson(
    JSON.stringify({
      sections: [
        { title: 'API', items: [{ name: 'Kerf.waste', description: 'First.\n\nSecond.' }, { name: 'kerf waste' }, { name: 'x', anchor: 'section-api' }, { name: 'Ж' }, { name: 'Я' }] },
        { title: 'API', items: [{ name: 'hidden', description: 'secret', undocumented: true }, { name: 'named', description: 'secret too' }] },
      ],
    }),
  );
  assert.ok('model' in parsed);
  const view = viewOfReference(parsed.model, ['named']);
  assert.deepEqual(
    view.sections.map((section) => [section.id, section.items.map((item) => item.id)]),
    [
      ['section-api-2', ['kerf-waste', 'kerf-waste-2', 'section-api', 'item', 'item-2']],
      ['section-api-3', ['hidden', 'named']],
    ],
  );
  assert.deepEqual(view.sections[0].items[0].paragraphs, ['First.', 'Second.']);
  assert.deepEqual(view.sections[1].items.map((item) => [item.undocumented, item.paragraphs]), [[true, []], [true, []]]);
  assert.deepEqual(view.undocumented.map((entry) => entry.name), ['hidden', 'named']);
  assert.equal(view.itemCount, 7);
});

// --- the bar -------------------------------------------------------------------------------

test('the bar is ASCII and escaped, and goes right after the start of the body without touching other bytes', () => {
  const bar = backBarHtml('/made/a"b/', 'back to <Ж> & Co');
  assert.match(bar, /^<div class="coffer-reference-bar" style="[^"]+"><a href="\/made\/a&quot;b\/" style="[^"]+">&#8592; back to &lt;&#1046;&gt; &amp; Co<\/a><\/div>$/);
  assert.equal(/^[\x20-\x7e]*$/.test(bar), true);
  // The style is an attribute value in double quotes, so it holds none of its own.
  assert.deepEqual([...bar.matchAll(/style="([^"]*)"/g)].map((match) => match[1].includes('"')), [false, false]);
  assert.equal((bar.match(/"/g) ?? []).length, 8);

  const withBody = Buffer.concat([Buffer.from('<!doctype html><html><body class="a>b" id=\'>\'><p>'), Buffer.from([0xe9, 0xff]), Buffer.from('</p></body></html>')]);
  const injected = injectBackBar(withBody, '[BAR]');
  assert.equal(injected.toString('latin1'), withBody.toString('latin1').replace('id=\'>\'>', "id='>'>[BAR]"));
  assert.equal(injected.includes(Buffer.from([0xe9, 0xff])), true);
  assert.equal(injectBackBar(Buffer.from('<p>x</p>'), '[BAR]').toString(), '[BAR]<p>x</p>');
  assert.equal(injectBackBar(Buffer.from('<!DOCTYPE html>\n<p>x</p>'), '[BAR]').toString(), '<!DOCTYPE html>[BAR]\n<p>x</p>');
  assert.equal(injectBackBar(Buffer.from('<BODY>x'), '[BAR]').toString(), '<BODY>[BAR]x');
});

// --- the build -----------------------------------------------------------------------------

test('a json reference becomes one plain page with every item; undocumented items show their signature only and are in the report', async () => {
  await inSite(siteWith({ 'gen.js': JSON_GENERATOR }, docsYaml(jsonReference())), async (dir) => {
    const [result] = await build(dir);
    const html = readFileSync(referenceFile(dir), 'utf8');

    // A plain page, not the site's theme.
    assert.match(html, /^<!doctype html>/);
    assert.doesNotMatch(html, /coffer\.css|site-header/);
    assert.match(html, /<title>Lathe API: Lathe<\/title>/);
    assert.match(html, /<h1>Lathe API<\/h1>/);
    // The section index.
    assert.match(html, /<nav class="ref-index" aria-label="Sections">\s*<ul>\s*<li><a href="#section-commands">Commands<\/a> <span class="ref-count">\(2\)<\/span><\/li>\s*<li><a href="#section-options">Options<\/a>/);
    // Every item, with its anchor, kind, signature and description paragraphs.
    assert.match(html, /<article class="ref-item" id="cmd-turn">\s*<h3><a class="ref-name" href="#cmd-turn">turn<\/a><span class="ref-kind">command<\/span><\/h3>\s*<pre class="ref-signature"><code>lathe turn &lt;file&gt;<\/code><\/pre>\s*<p>Turns a file\.<\/p>\s*<p>Second paragraph\.<\/p>/);
    assert.match(html, /<article class="ref-item" id="speed">/);
    // The text is escaped.
    assert.match(html, /<p>The speed &lt;b&gt;in&lt;\/b&gt; rpm\.<\/p>/);
    // An undocumented item: its signature, a note, and no description.
    assert.match(html, /<article class="ref-item ref-undocumented" id="polish">[\s\S]*?<code>lathe polish<\/code>[\s\S]*?<p class="ref-note">Not documented<\/p>\s*<\/article>/);
    assert.doesNotMatch(html, /SECRET/);
    // The bar leads back to the project page.
    assert.match(html, /<body>\s*<div class="coffer-reference-bar"[^>]*><a href="\/made\/lathe\/"[^>]*>&#8592; back to Lathe on Demo<\/a><\/div>/);

    // The build report lists the undocumented item and does not fail.
    assert.deepEqual(
      reportOf(dir).warnings.map((warning) => warning.message),
      ['content/projects/lathe/project.yaml: docs.reference: "polish" (Commands) has no documentation'],
    );

    // The manifest, the docs index (generated, since there are no guides) and the project page.
    const project = /** @type {import('../src/build.js').ManifestProject} */ (result.manifest.projects[0]);
    assert.deepEqual(project.docs?.reference, {
      url: '/made/lathe/docs/reference/',
      file: 'made/lathe/docs/reference/index.html',
      format: 'json',
      title: 'Lathe reference',
      files: 1,
      items: 3,
      undocumented: ['polish'],
      cached: false,
    });
    assert.deepEqual(project.docs?.pages.map((page) => page.url), ['/made/lathe/docs/']);
    const index = readFileSync(join(dir, 'out', 'demo', 'made', 'lathe', 'docs', 'index.html'), 'utf8');
    assert.match(index, /<a href="\/made\/lathe\/docs\/reference\/">Lathe reference<\/a>/);
    assert.match(readFileSync(join(dir, 'out', 'demo', 'made', 'lathe', 'index.html'), 'utf8'), /<a href="\/made\/lathe\/docs\/">Read the documentation<\/a>/);

    // coffer check passes: the reference has no preview metadata, and nothing else is wrong.
    const checked = await checkOutput(loadConfig({ configPath: join(dir, 'coffer.yaml') }), { out: join(dir, 'out') });
    assert.deepEqual(checked.failures, []);
  });
});

test('the guides link to the reference from the sidebar', async () => {
  const files = siteWith(
    { 'gen.js': JSON_GENERATOR, 'docs/start.md': '# Start\n\nText.\n' },
    `docs: ${JSON.stringify({ source: { path: '../../../tool' }, github: 'me/lathe', guides: [{ dir: 'docs' }], reference: jsonReference() })}\n`,
  );
  await inSite(files, async (dir) => {
    await build(dir);
    const page = readFileSync(join(dir, 'out', 'demo', 'made', 'lathe', 'docs', 'start', 'index.html'), 'utf8');
    const nav = /<nav class="docs-sidebar"[\s\S]*?<\/nav>/.exec(page)?.[0] ?? '';
    assert.deepEqual(
      [...nav.matchAll(/<a href="([^"]+)"[^>]*>([^<]*)<\/a>/g)].map((match) => `${match[2]}@${match[1]}`),
      ['Documentation@/made/lathe/docs/', 'Start@/made/lathe/docs/start/', 'Lathe reference@/made/lathe/docs/reference/'],
    );
  });
});

test('a pattern finds undocumented elements in the output of the command, also in a json reference', async () => {
  const generator = `${JSON_GENERATOR}\nconsole.log('undocumented: turn'); console.log('undocumented: Elsewhere');\n`;
  const reference = jsonReference({ undocumented: { pattern: '^undocumented: (?<name>\\S+)$' } });
  await inSite(siteWith({ 'gen.js': generator }, docsYaml(reference)), async (dir) => {
    const [result] = await build(dir);
    const html = readFileSync(referenceFile(dir), 'utf8');
    // "turn" is in the file and is shown as undocumented now; "Elsewhere" is only in the report.
    assert.match(html, /<article class="ref-item ref-undocumented" id="cmd-turn">/);
    assert.doesNotMatch(html, /Turns a file/);
    assert.deepEqual(
      reportOf(dir).warnings.map((warning) => warning.message).sort(),
      [
        'content/projects/lathe/project.yaml: docs.reference: "Elsewhere" has no documentation',
        'content/projects/lathe/project.yaml: docs.reference: "polish" (Commands) has no documentation',
        'content/projects/lathe/project.yaml: docs.reference: "turn" (Commands) has no documentation',
      ],
    );
    const project = /** @type {import('../src/build.js').ManifestProject} */ (result.manifest.projects[0]);
    assert.deepEqual(project.docs?.reference?.undocumented, ['turn', 'polish', 'Elsewhere']);
  });
});

test('an html reference is copied as it is, and every HTML page gets the link back to the site', async () => {
  const reference = {
    command: 'node gen.js {out}',
    format: 'html',
    output: '{out}',
    title: 'Lathe API',
    undocumented: { pattern: '^undocumented: (?<name>\\S+)$' },
  };
  await inSite(siteWith({ 'gen.js': HTML_GENERATOR }, docsYaml(reference)), async (dir) => {
    const [result] = await build(dir);
    const bar = /<div class="coffer-reference-bar"[^>]*><a href="\/made\/lathe\/"[^>]*>&#8592; back to Lathe on Demo<\/a><\/div>/;

    const index = readFileSync(referenceFile(dir), 'utf8');
    assert.match(index, /<body class="x>y" data-a='>'>\s*<div class="coffer-reference-bar"/);
    assert.match(index, bar);
    assert.match(index, /<h1>API<\/h1>/);
    // Other pages, also with an upper-case extension and without a body.
    assert.match(readFileSync(referenceFile(dir, 'api/deep/Page.HTM'), 'utf8'), /^<html><body><div class="coffer-reference-bar"/);
    assert.match(readFileSync(referenceFile(dir, 'fragment.html'), 'utf8'), /^<div class="coffer-reference-bar".*<\/div><p>no body at all<\/p>$/);
    for (const page of ['index.html', 'api/deep/Page.HTM', 'fragment.html']) {
      assert.match(readFileSync(referenceFile(dir, page), 'utf8'), bar, page);
    }
    // Everything else is copied byte for byte.
    assert.equal(readFileSync(referenceFile(dir, 'style.css'), 'utf8'), 'body { color: red; }\n');
    assert.deepEqual([...readFileSync(referenceFile(dir, 'data.bin'))], [0, 255, 254, 1, 2, 60, 98, 111, 100, 121, 62]);

    const project = /** @type {import('../src/build.js').ManifestProject} */ (result.manifest.projects[0]);
    assert.deepEqual(project.docs?.reference, {
      url: '/made/lathe/docs/reference/',
      file: 'made/lathe/docs/reference/index.html',
      format: 'html',
      title: 'Lathe API',
      files: 5,
      items: null,
      undocumented: ['Lathe.turn', 'Lathe.polish'],
      cached: false,
    });
    assert.deepEqual(
      reportOf(dir).warnings.map((warning) => warning.message),
      [
        'content/projects/lathe/project.yaml: docs.reference: "Lathe.turn" has no documentation',
        'content/projects/lathe/project.yaml: docs.reference: "Lathe.polish" has no documentation',
      ],
    );
    // The pages of the generated folder are checked for links like any page, but not for preview metadata.
    const checked = await checkOutput(loadConfig({ configPath: join(dir, 'coffer.yaml') }), { out: join(dir, 'out') });
    assert.deepEqual(checked.failures, []);
  });
});

test('a link in a generated folder is not published, and is a warning', async () => {
  const generator = `${HTML_GENERATOR}\nrequire('node:fs').symlinkSync(__filename, require('node:path').join(out, 'link.js'));\n`;
  const reference = { command: ['node', 'gen.js', '{out}'], format: 'html', output: '{out}', title: 'API' };
  await inSite(siteWith({ 'gen.js': generator }, docsYaml(reference)), async (dir) => {
    try {
      await build(dir);
    } catch (error) {
      // Making a link can be refused (Windows without the privilege); the generator then fails and the test has nothing to show.
      if (String(error).includes('EPERM')) return;
      throw error;
    }
    assert.equal(existsSync(referenceFile(dir, 'link.js')), false);
    assert.ok(reportOf(dir).warnings.some((warning) => warning.message.endsWith('the link "link.js" in the generated folder is not published')));
  });
});

test('a failing generator fails the build with its exit code and the end of its output', async () => {
  const generator = "console.log('line one'); console.error('the generator broke: bad input'); process.exit(3);";
  await inSite(siteWith({ 'gen.js': generator }, docsYaml(jsonReference())), async (dir) => {
    const errors = await errorsOf(dir);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /^content\/projects\/lathe\/project\.yaml docs\.reference: the command `node gen\.js .*` failed \(exit code 3\): line one \| the generator broke: bad input$/);
    assert.equal(existsSync(join(dir, '.coffer', 'report.json')), true);
    assert.deepEqual(readdirSync(join(dir, '.cache', 'reference', 'lathe')), [], 'nothing is cached and nothing is left behind');
  });
});

test('a command line given as text goes through the shell, and a missing program fails the build', async () => {
  await inSite(siteWith({ 'gen.js': JSON_GENERATOR }, docsYaml(jsonReference({ command: 'node gen.js {out}/reference.json {site}' }))), async (dir) => {
    await build(dir);
    assert.ok(existsSync(referenceFile(dir)));
  });
  await inSite(siteWith({ 'gen.js': JSON_GENERATOR }, docsYaml(jsonReference({ command: ['no-such-program-anywhere', 'x'] }))), async (dir) => {
    const errors = await errorsOf(dir);
    assert.match(errors[0], /docs\.reference: the command `no-such-program-anywhere x` could not be started: the program "no-such-program-anywhere" was not found in the PATH/);
  });
  await inSite(siteWith({ 'gen.js': JSON_GENERATOR }, docsYaml(jsonReference({ command: 'no-such-program-anywhere x' }))), async (dir) => {
    const errors = await errorsOf(dir);
    assert.match(errors[0], /docs\.reference: the command `no-such-program-anywhere x` failed \(exit code [1-9][0-9]*\)/);
  });
});

test('a command that does not finish in time is stopped and fails the build', async () => {
  await inSite(siteWith({ 'gen.js': 'setTimeout(() => {}, 60000);' }, docsYaml(jsonReference())), async (dir) => {
    const errors = await errorsOf(dir, { reference: { timeoutMs: 700 } });
    assert.match(errors[0], /docs\.reference: the command `node gen\.js .*` did not finish within 0\.7 s and was stopped$/);
  });
});

test('the output has to exist, be of the right kind, be valid and stay inside the repository', async () => {
  const cases = /** @type {[Record<string, string>, Record<string, unknown>, RegExp][]} */ ([
    [{ 'gen.js': '' }, jsonReference(), /the command succeeded, but its output "\{out\}\/reference\.json" does not exist/],
    [{ 'gen.js': 'require("node:fs").mkdirSync(process.argv[2] + "/reference.json", { recursive: true });' }, jsonReference(), /must be a file for the format json/],
    [{ 'gen.js': 'require("node:fs").writeFileSync(process.argv[2], "{");' }, jsonReference({ command: ['node', 'gen.js', '{out}/reference.json'] }), /is not a valid reference: is not valid JSON/],
    [
      { 'gen.js': 'require("node:fs").writeFileSync(process.argv[2], JSON.stringify({ sections: [{ title: "S", items: [{ kind: "x" }] }] }));' },
      jsonReference({ command: ['node', 'gen.js', '{out}/reference.json'] }),
      /is not a valid reference: sections\[0\]\.items\[0\]\.name: is required/,
    ],
    [{ 'gen.js': 'require("node:fs").writeFileSync(process.argv[2], "{}");' }, jsonReference({ command: ['node', 'gen.js', '{site}/escape.json'], output: '{site}/escape.json' }), /outside the repository and the folder \{out\}, and is not used/],
    [{ 'gen.js': 'require("node:fs").writeFileSync(process.argv[2] + "/a.html", "x");' }, { command: ['node', 'gen.js', '{out}'], format: 'html', output: '{out}', title: 'T' }, /has no index\.html/],
    [{ 'gen.js': 'require("node:fs").writeFileSync(process.argv[2], "x");' }, { command: ['node', 'gen.js', '{out}/f'], format: 'html', output: '{out}/f', title: 'T' }, /must be a folder for the format html/],
  ]);
  for (const [tool, reference, expected] of cases) {
    await inSite(siteWith(tool, docsYaml(reference)), async (dir) => {
      const errors = await errorsOf(dir);
      assert.equal(errors.length, 1, errors.join('\n'));
      assert.match(errors[0], expected);
      assert.match(errors[0], /^content\/projects\/lathe\/project\.yaml docs\.reference: /);
    });
  }
});

test('a symbolic link in the repository cannot make the build publish a file from outside', async () => {
  await inSite(siteWith({ 'gen.js': '' }, docsYaml(jsonReference({ command: ['node', 'gen.js'], output: 'leak.json' }))), async (dir) => {
    writeFileSync(join(dir, 'secret.json'), '{"sections": []}');
    try {
      symlinkSync(join(dir, 'secret.json'), join(dir, 'tool', 'leak.json'));
    } catch {
      return; // links cannot be made here
    }
    const errors = await errorsOf(dir);
    assert.match(errors[0], /is outside the repository and the folder \{out\}/);
  });
});

test('the result is cached by the commit and the configuration; a changed commit or configuration runs the command again', { skip: NO_GIT }, async () => {
  const files = siteWith({ 'gen.js': JSON_GENERATOR }, docsYaml(jsonReference()));
  await inSite(files, async (dir) => {
    const tool = join(dir, 'tool');
    /** @param {string[]} args */
    const git = (args) =>
      execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: tool, stdio: 'ignore' });
    git(['init', '-q', '-b', 'main']);
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'first']);
    const runs = () => (existsSync(join(dir, 'runs.log')) ? readFileSync(join(dir, 'runs.log'), 'utf8').length : 0);
    const entryOf = (/** @type {import('../src/build.js').SiteResult[]} */ results) =>
      /** @type {import('../src/build.js').ManifestProject} */ (results[0].manifest.projects[0]).docs?.reference;

    const first = await build(dir);
    assert.equal(runs(), 1);
    assert.equal(entryOf(first)?.cached, false);
    const page = readFileSync(referenceFile(dir), 'utf8');

    // The same commit and configuration: the cache answers, the page is the same, and the undocumented item is still reported.
    const second = await build(dir);
    assert.equal(runs(), 1, 'the command did not run again');
    assert.equal(entryOf(second)?.cached, true);
    assert.equal(readFileSync(referenceFile(dir), 'utf8'), page);
    assert.equal(reportOf(dir).warnings.length, 1);

    // A new commit.
    writeFileSync(join(tool, 'note.txt'), 'changed');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'second']);
    await build(dir);
    assert.equal(runs(), 2);
    await build(dir);
    assert.equal(runs(), 2);

    // A changed configuration.
    const projectFile = join(dir, 'content', 'projects', 'lathe', 'project.yaml');
    writeFileSync(projectFile, readFileSync(projectFile, 'utf8').replace('"{out}/reference.json","{site}"', '"{out}/reference.json","{site}","extra"'));
    await build(dir);
    assert.equal(runs(), 3);
    await build(dir);
    assert.equal(runs(), 3);

    // Uncommitted changes in the folder: the commit does not say what the folder holds, so nothing is reused.
    writeFileSync(join(tool, 'note.txt'), 'edited, not committed');
    await build(dir);
    await build(dir);
    assert.equal(runs(), 5);
    // The old results are still removed one day: only the newest few stay.
    assert.ok(readdirSync(join(dir, '.cache', 'reference', 'lathe')).length <= 5);
  });
});

test('a folder that is not in a git repository is never taken from the cache', async () => {
  await inSite(siteWith({ 'gen.js': JSON_GENERATOR }, docsYaml(jsonReference())), async (dir) => {
    await build(dir);
    await build(dir);
    assert.equal(readFileSync(join(dir, 'runs.log'), 'utf8').length, 2);
  });
});

// --- a command per system, the environment, and the cache key ----------------------------------

test('a command can differ for Windows: a mapping with a default and a windows entry', () => {
  const ok = checkReferenceConfig({
    command: { default: ['./gradlew', 'dokka'], windows: '.\\gradlew.bat dokka' },
    format: 'html',
    output: 'build/dokka/html',
    title: 'API',
  });
  assert.ok('value' in ok);
  assert.deepEqual(ok.value.command, { default: ['./gradlew', 'dokka'], windows: '.\\gradlew.bat dokka' });
  const onlyDefault = checkReferenceConfig({ command: { default: 'make docs' }, format: 'html', output: 'o', title: 'T' });
  assert.ok('value' in onlyDefault);

  for (const [command, message] of /** @type {[unknown, RegExp][]} */ ([
    [{ windows: 'x' }, /reference\.command\.default: is required/],
    [{}, /reference\.command\.default: is required/],
    [{ default: 'x', linux: 'y' }, /reference\.command\.linux: unknown key/],
    [{ default: [], windows: 'x' }, /reference\.command\.default: a list needs/],
    [{ default: 'x', windows: 'a\nb' }, /reference\.command\.windows: must not contain control characters/],
  ])) {
    const bad = checkReferenceConfig({ command, format: 'html', output: 'o', title: 'T' });
    assert.ok('problems' in bad, JSON.stringify(command));
    assert.match(bad.problems.join('\n'), message);
  }

  assert.equal(commandFor('x', 'win32'), 'x');
  assert.deepEqual(commandFor(['a', 'b'], 'linux'), ['a', 'b']);
  assert.equal(commandFor({ default: 'unix', windows: 'win' }, 'win32'), 'win');
  assert.equal(commandFor({ default: 'unix', windows: 'win' }, 'linux'), 'unix');
  assert.equal(commandFor({ default: 'unix', windows: 'win' }, 'darwin'), 'unix');
  assert.equal(commandFor({ default: 'unix' }, 'win32'), 'unix');
});

test('a generator does not get environment variables whose names look like secrets', () => {
  const kept = withoutSecrets({
    PATH: '/bin',
    JAVA_HOME: '/jdk',
    GITHUB_TOKEN: 'a',
    R2_ACCESS_KEY_ID: 'b',
    r2_secret_access_key: 'c',
    CLOUDFLARE_ACCOUNT_ID: 'd',
    AWS_REGION: 'e',
    NPM_PASSWORD: 'f',
    DB_PASSWD: 'g',
    SSH_AUTH_SOCK: 'h',
    MY_CREDENTIALS: 'i',
    SESSION_COOKIE: 'j',
    PRIVATE_STUFF: 'k',
    Api_Key: 'l',
    EMPTY: undefined,
  });
  assert.deepEqual(Object.keys(kept).sort(), ['EMPTY', 'JAVA_HOME', 'PATH']);
});

/** A generator that lists the names of its environment as the items of a JSON reference. */
const ENVIRONMENT_GENERATOR = `
const { mkdirSync, writeFileSync } = require('node:fs');
const { dirname } = require('node:path');
const out = process.argv[2];
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ sections: [{ title: 'Environment', items: Object.keys(process.env).sort().map((name) => ({ name, description: 'x' })) }] }));
`;

test('the command runs without secret-like environment variables and with the others', async () => {
  const files = siteWith({ 'gen.js': ENVIRONMENT_GENERATOR }, docsYaml(jsonReference({ command: ['node', 'gen.js', '{out}/reference.json'] })));
  await inSite(files, async (dir) => {
    const env = { ...process.env, COFFER_TEST_VISIBLE: '1', COFFER_TEST_TOKEN: 'secret-value', COFFER_TEST_API_KEY: 'secret-value', R2_ACCESS_KEY_ID: 'secret-value' };
    await build(dir, { reference: { env } });
    const html = readFileSync(referenceFile(dir), 'utf8');
    assert.match(html, />COFFER_TEST_VISIBLE</);
    assert.doesNotMatch(html, /COFFER_TEST_TOKEN|COFFER_TEST_API_KEY|R2_ACCESS_KEY_ID|secret-value/);
  });
});

test('the cache key covers the contents of the files that the command names through {site}', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coffer-inputs-'));
  try {
    mkdirSync(join(dir, 'generators'), { recursive: true });
    mkdirSync(join(dir, 'build-support', 'dokka'), { recursive: true });
    writeFileSync(join(dir, 'generators', 'one.mjs'), 'export const a = 1;\n');
    writeFileSync(join(dir, 'generators', 'other.mjs'), 'export const b = 1;\n');
    writeFileSync(join(dir, 'build-support', 'dokka', 'init.kts'), 'val x = 1\n');
    const base = { format: /** @type {'json'} */ ('json'), output: 'o', title: 'T', undocumented: null, index: null, autoLink: true };
    const listCommand = { ...base, command: ['node', '{site}/generators/one.mjs', '{repo}'] };
    const flagCommand = { ...base, command: ['./gradlew', '--init-script={site}/build-support/dokka/init.kts', 'task'] };
    const textCommand = { ...base, command: 'node "{site}/generators/one.mjs" {out}' };
    const folderCommand = { ...base, command: ['node', '{site}/generators', '{out}'] };
    const noSite = { ...base, command: ['node', 'gen.js'] };
    const perSystem = { ...base, command: { default: ['./gradlew', '--init-script', '{site}/build-support/dokka/init.kts'], windows: ['gradlew.bat', '--init-script', '{site}/generators/one.mjs'] } };

    const references = [listCommand, flagCommand, textCommand, folderCommand, noSite, perSystem];
    const before = references.map((reference) => configHash(reference, dir));
    assert.equal(configHash(listCommand, dir), before[0], 'the hash is stable');

    // A file that the command does not name does not matter to it; a folder is hashed with all its files.
    writeFileSync(join(dir, 'generators', 'other.mjs'), 'export const b = 2;\n');
    assert.equal(configHash(listCommand, dir), before[0]);
    assert.notEqual(configHash(folderCommand, dir), before[3], 'a folder is hashed with all its files');
    before[3] = configHash(folderCommand, dir);

    writeFileSync(join(dir, 'generators', 'one.mjs'), 'export const a = 2;\n');
    assert.notEqual(configHash(listCommand, dir), before[0], 'an edited generator gives a new key');
    assert.notEqual(configHash(textCommand, dir), before[2], 'also in a command line given as text');
    assert.notEqual(configHash(folderCommand, dir), before[3]);
    assert.notEqual(configHash(perSystem, dir), before[5], 'also in the entry for Windows');
    assert.equal(configHash(flagCommand, dir), before[1]);
    assert.equal(configHash(noSite, dir), before[4]);

    writeFileSync(join(dir, 'build-support', 'dokka', 'init.kts'), 'val x = 2\n');
    assert.notEqual(configHash(flagCommand, dir), before[1], 'an edited init script, named inside an option, gives a new key');
    assert.equal(configHash(noSite, dir), before[4]);

    // A missing file is part of the key too, and the key does not depend on where the site is.
    assert.notEqual(siteInputsHash(['x', '{site}/gone.mjs'], dir), siteInputsHash(['x'], dir));
    const copy = mkdtempSync(join(tmpdir(), 'coffer-inputs-copy-'));
    try {
      mkdirSync(join(copy, 'generators'), { recursive: true });
      writeFileSync(join(copy, 'generators', 'one.mjs'), 'export const a = 2;\n');
      assert.equal(siteInputsHash(['node', '{site}/generators/one.mjs'], copy), siteInputsHash(['node', '{site}/generators/one.mjs'], dir));
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('editing a generator of the content repository runs the command again, although the commit and the configuration are the same', { skip: NO_GIT }, async () => {
  const files = {
    ...siteWith({ 'note.txt': 'x' }, docsYaml(jsonReference({ command: ['node', '{site}/site-gen.js', '{out}/reference.json', '{site}'] }))),
    'site-gen.js': JSON_GENERATOR,
  };
  await inSite(files, async (dir) => {
    const tool = join(dir, 'tool');
    /** @param {string[]} args */
    const git = (args) =>
      execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: tool, stdio: 'ignore' });
    git(['init', '-q', '-b', 'main']);
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'first']);
    const runs = () => (existsSync(join(dir, 'runs.log')) ? readFileSync(join(dir, 'runs.log'), 'utf8').length : 0);
    await build(dir);
    await build(dir);
    assert.equal(runs(), 1, 'the second build is answered by the cache');
    writeFileSync(join(dir, 'site-gen.js'), `${JSON_GENERATOR}\n// edited\n`);
    await build(dir);
    assert.equal(runs(), 2, 'the edited generator ran');
    await build(dir);
    assert.equal(runs(), 2);
  });
});

test('the sample tool: its generator writes a JSON reference with one undocumented item, which the example site shows and reports', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coffer-reference-example-'));
  try {
    const config = loadConfig({ configPath: exampleConfig });
    const [result] = await buildSites(config, { out: dir, now: new Date('2026-06-01T12:00:00Z'), cacheDir: join(dir, '.cache'), reportDir: join(dir, '.coffer') });
    const html = readFileSync(join(dir, 'workshop', 'made', 'kerfcalc', 'docs', 'reference', 'index.html'), 'utf8');
    for (const name of ['Kerf', 'Kerf.waste', 'Kerf.spacing']) assert.match(html, new RegExp(`class="ref-name" href="#[a-z-]+">${name.replace('.', '\\.')}</a>`));
    assert.match(html, /<article class="ref-item ref-undocumented" id="kerf-spacing">[\s\S]*?fun spacing\(width: Double, pins: Int\): Double[\s\S]*?Not documented/);
    assert.match(html, /Returns the length of wood lost to the blade/);
    const entry = /** @type {import('../src/build.js').ManifestProject} */ (result.manifest.projects.find((project) => project.slug === 'kerfcalc'));
    assert.deepEqual(entry.docs?.reference?.undocumented, ['Kerf.spacing']);
    assert.deepEqual(
      JSON.parse(readFileSync(join(dir, '.coffer', 'report.json'), 'utf8')).warnings.map((/** @type {{ message: string }} */ warning) => warning.message),
      ['content/projects/kerfcalc/project.yaml: docs.reference: "Kerf.spacing" (Functions) has no documentation'],
    );
    const checked = await checkOutput(config, { out: dir });
    assert.deepEqual(checked.failures, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
