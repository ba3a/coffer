import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSites } from '../src/build.js';
import { loadConfig } from '../src/config.js';
import { findSection } from '../src/docs/readme.js';
import { ReportError } from '../src/report.js';
import { TINY_PNG } from './helpers/images.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const exampleConfig = join(root, 'example', 'coffer.yaml');

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

const DOCS = 'docs:\n  source: { path: ../../../tool }\n  github: me/lathe\n  guides:\n    - { dir: docs }\n';

const README = [
  '# Lathe',
  '',
  'Intro.',
  '',
  '## Quick start',
  '',
  'Run it:',
  '',
  '```sh',
  '# not a heading',
  'lathe turn',
  '```',
  '',
  'Read the [guide](docs/start.md#first-steps), the [licence](LICENSE) and the [site](https://lathe.example/).',
  '',
  '![A lathe](docs/lathe.png)',
  '',
  '### Options',
  '',
  'Many.',
  '',
  '## Licence',
  '',
  'MIT.',
  '',
].join('\n');

/**
 * A made-up site with one tool project, `lathe`, whose documentation is the
 * `tool` folder next to the configuration.
 *
 * @param {string} page The text of the project's page (`index.md`).
 * @param {Record<string, string | Buffer>} [tool] Files of the documentation source that replace or add to the default ones (a README with a "Quick start" section, a licence, one guide and a picture).
 * @param {string} [docsYaml] The docs block; none for a project without a docs source.
 * @returns {Record<string, string | Buffer>}
 */
function siteWith(page, tool = {}, docsYaml = DOCS) {
  /** @type {Record<string, string | Buffer>} */
  const files = {
    'coffer.yaml': SITE_CONFIG,
    'content/home.md': '---\ntitle: Demo\n---\n\nAbout.\n',
    'content/projects/lathe/project.yaml': `name: Lathe\npitch: Turns wood.\nkind: tool\nstatus: released\ncard: card.png\nrepo: https://github.example/me/lathe\n${docsYaml}`,
    'content/projects/lathe/index.md': page,
    'content/projects/lathe/card.png': TINY_PNG,
    'tool/README.md': README,
    'tool/LICENSE': 'MIT\n',
    'tool/docs/start.md': '# Start\n\n## First steps\n\nBegin.\n',
    'tool/docs/lathe.png': TINY_PNG,
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
  const dir = mkdtempSync(join(tmpdir(), 'coffer-readme-'));
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
  return buildSites(loadConfig({ configPath: join(dir, 'coffer.yaml') }), {
    out: join(dir, 'out'),
    now: new Date('2026-06-01T12:00:00Z'),
  });
}

/**
 * Builds a site that must fail and returns the findings, one text each. A
 * mistake in the Markdown of a page stops the build with an error of its own
 * rather than a report; its message is returned as the only finding.
 *
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function errorsOf(dir) {
  try {
    await build(dir);
  } catch (error) {
    if (error instanceof ReportError) return error.errors;
    assert.ok(error instanceof Error, String(error));
    return [error.message];
  }
  return assert.fail('the build should have failed');
}

/** @param {string} dir */
function projectPage(dir) {
  return readFileSync(join(dir, 'out', 'demo', 'made', 'lathe', 'index.html'), 'utf8');
}

// --- cutting a section out of a text ---------------------------------------------

test('findSection: the section runs to the next heading of the same or a higher level, sub sections included', () => {
  const found = findSection(README, 'Quick start');
  assert.ok('section' in found);
  assert.equal(found.section.depth, 2);
  assert.equal(found.section.line, 7);
  assert.match(found.section.text, /^Run it:\n/);
  assert.match(found.section.text, /# not a heading/);
  assert.match(found.section.text, /### Options\n\nMany\.$/);
  assert.doesNotMatch(found.section.text, /Licence/);
});

test('findSection: white space and capitals do not matter, and a "heading" in a code block is no heading', () => {
  assert.ok('section' in findSection(README, '  QUICK   start '));
  assert.deepEqual(findSection(README, 'not a heading'), { headings: ['Lathe', 'Quick start', 'Options', 'Licence'] });
});

test('findSection: a heading that is the last thing of the text has an empty section', () => {
  const found = findSection('# T\n\n## Empty\n', 'Empty');
  assert.ok('section' in found);
  assert.equal(found.section.text, '');
});

// --- the example site ---------------------------------------------------------------

test('the example site: the page of the sample tool shows the Quick start section of its README with the links rewritten', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coffer-readme-example-'));
  try {
    const config = loadConfig({ configPath: exampleConfig });
    await buildSites(config, { out: dir, now: new Date('2026-06-01T12:00:00Z'), cacheDir: join(dir, '.cache') });
    const html = readFileSync(join(dir, 'workshop', 'made', 'kerfcalc', 'index.html'), 'utf8');
    assert.match(html, /<h2[^>]*>Quick start<\/h2>\s*<div class="readme-section">/);
    assert.match(html, /kerfcalc<\/span>/);
    // A link to a guide leads to the guide's page; a link to a file that is not published leads to GitHub.
    assert.match(html, /<a href="\/made\/kerfcalc\/docs\/usage\/#options">usage guide<\/a>/);
    assert.match(html, /<a href="https:\/\/github\.com\/tove-marlowe\/kerfcalc\/blob\/main\/CHANGELOG\.md">changelog<\/a>/);
    // The heading of the section is the page's own, and the rest of the README is not shown.
    assert.doesNotMatch(html, /Sample tool/);
    assert.doesNotMatch(html, /data-coffer-readme/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- a built site ---------------------------------------------------------------------

test('a project page shows the named section of the README, without its heading, with guide links and pictures resolved from the README', async () => {
  await inSite(siteWith('Lathe.\n\n## Start\n\n::readme{section="Quick start"}\n\n## After\n\nEnd.\n'), async (dir) => {
    await build(dir);
    const html = projectPage(dir);
    assert.match(html, /<h2[^>]*>Start<\/h2>\s*<div class="readme-section"><p>Run it:<\/p>/);
    assert.match(html, /# not a heading/);
    assert.match(html, /<h3[^>]*>Options<\/h3>\s*<p>Many\.<\/p>\s*<\/div>/);
    assert.doesNotMatch(html, /Intro\./);
    assert.doesNotMatch(html, /MIT\./);
    assert.match(html, /<a href="\/made\/lathe\/docs\/start\/#first-steps">guide<\/a>/);
    assert.match(html, /<a href="https:\/\/github\.com\/me\/lathe\/blob\/main\/LICENSE">licence<\/a>/);
    assert.match(html, /<a href="https:\/\/lathe\.example\/">site<\/a>/);
    // The picture next to the README's guides is published through the image pipeline.
    assert.match(html, /<img src="\/[^"]+" alt="A lathe"/);
    // The text after the directive follows the section.
    assert.match(html, /<h2[^>]*>After<\/h2>/);
    assert.ok(html.indexOf('Many.') < html.indexOf('After'));
  });
});

test('the file attribute takes the section from another Markdown file of the repository', async () => {
  const tool = { 'docs/install.md': '# Install\n\n## Linux\n\nUse `apt install lathe`; see [start](start.md).\n\n## Windows\n\nOther.\n' };
  await inSite(siteWith('::readme{file="docs/install.md" section="Linux"}\n', tool), async (dir) => {
    await build(dir);
    const html = projectPage(dir);
    assert.match(html, /<code>apt install lathe<\/code>; see <a href="\/made\/lathe\/docs\/start\/">start<\/a>/);
    assert.doesNotMatch(html, /Other\./);
  });
});

test('an unknown heading fails the build with the page file, the line and the headings the README has', async () => {
  await inSite(siteWith('Text.\n\n::readme{section="Installation"}\n'), async (dir) => {
    const [first, ...rest] = await errorsOf(dir);
    assert.deepEqual(rest, []);
    assert.match(first, /content\/projects\/lathe\/index\.md:3/);
    assert.match(first, /::readme/);
    assert.match(first, /tool:README\.md has no heading "Installation"/);
    assert.match(first, /"Quick start"/);
  });
});

test('an unknown file fails the build with the page file', async () => {
  await inSite(siteWith('::readme{file="docs/missing.md" section="Quick start"}\n'), async (dir) => {
    const [first] = await errorsOf(dir);
    assert.match(first, /content\/projects\/lathe\/index\.md:1/);
    assert.match(first, /file "docs\/missing\.md" does not exist/);
  });
});

test('a file that leads out of the repository, is not Markdown or has the wrong capitalisation fails the build', async () => {
  /** @type {[string, RegExp][]} */
  const cases = [
    ['../secret.md', /cannot be used.*\.\./],
    ['LICENSE', /is not a Markdown file/],
    ['readme.md', /(?:exactly this capitalisation|does not exist)/],
  ];
  for (const [file, pattern] of cases) {
    await inSite(siteWith(`::readme{file="${file}" section="Quick start"}\n`, { 'secret.md': '# S\n' }), async (dir) => {
      const [first] = await errorsOf(dir);
      assert.match(first, /content\/projects\/lathe\/index\.md:1/);
      assert.match(first, pattern, file);
    });
  }
});

test('a repository without a README fails the build when no file is named', async () => {
  const files = siteWith('::readme{section="Quick start"}\n');
  delete files['tool/README.md'];
  await inSite(files, async (dir) => {
    const [first] = await errorsOf(dir);
    assert.match(first, /content\/projects\/lathe\/index\.md:1/);
    assert.match(first, /has no README\.md/);
  });
});

test('a section without content fails the build', async () => {
  await inSite(siteWith('::readme{section="Empty"}\n', { 'README.md': '# T\n\n## Empty\n' }), async (dir) => {
    const [first] = await errorsOf(dir);
    assert.match(first, /content\/projects\/lathe\/index\.md:1/);
    assert.match(first, /the section "Empty" of tool:README\.md has no content/);
  });
});

test('a broken link inside the section fails the build naming the README', async () => {
  const readme = '# T\n\n## Quick start\n\nSee [the guide](docs/nothing.md).\n';
  await inSite(siteWith('::readme{section="Quick start"}\n', { 'README.md': readme }), async (dir) => {
    const [first] = await errorsOf(dir);
    assert.match(first, /tool:README\.md:5/);
    assert.match(first, /broken link 'docs\/nothing\.md'/);
  });
});

test('the directive needs a section and takes no other attribute', async () => {
  /** @type {[string, RegExp][]} */
  const cases = [
    ['::readme\n', /needs the heading of the section/],
    ['::readme{section=""}\n', /section needs a value/],
    ['::readme{section="Quick start" level="2"}\n', /no attribute "level"/],
    ['::readme[Quick start]\n', /takes no text in square brackets/],
  ];
  for (const [text, pattern] of cases) {
    await inSite(siteWith(text), async (dir) => {
      const [first] = await errorsOf(dir);
      assert.match(first, /index\.md:1/, text);
      assert.match(first, pattern, text);
    });
  }
});

test('the directive is only available on the page of a project with a docs source', async () => {
  await inSite(siteWith('Text.\n\n::readme{section="Quick start"}\n', {}, ''), async (dir) => {
    const [first] = await errorsOf(dir);
    assert.match(first, /index\.md:3/);
    assert.match(first, /only available on the page of a project that has a docs source/);
  });
});
