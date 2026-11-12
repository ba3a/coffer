import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { buildSites } from '../src/build.js';
import { loadConfig } from '../src/config.js';
import { registerProjectKind, unregisterProjectKind } from '../src/content/project-kinds.js';
import { readLanding } from '../src/docs/landing.js';
import { resolveRepoPicture } from '../src/docs/repo-assets.js';
import { ReportError } from '../src/report.js';
import { TINY_PNG } from './helpers/images.js';

// The landing file of a project: a Markdown file of the docs source that is the
// body of the project page (project.yaml: landing: { file }).

const SITE_CONFIG = [
  'sites:',
  '  - id: demo',
  '    baseUrl: https://demo.example',
  '    lang: en',
  '    title: Demo',
  '    description: A demo site.',
  '    theme: theme',
  '    projects: { dir: content/projects }',
  '',
].join('\n');

/** Shows `project.landing` the way a theme would read it. */
const THEME = [
  '{% extends "coffer:project.njk" %}',
  '{% block project_header %}',
  '<p id="landing">{{ project.landing.layout }}|{{ project.landing.accent }}|{{ project.landing.file }}|{{ project.landing | length }}</p>',
  '{% endblock %}',
].join('');

const PROJECT_YAML =
  'name: Lathe\npitch: Turns wood.\nkind: tool\nstatus: released\ncard: card.png\nrepo: https://github.example/me/lathe\n' +
  'landing: { file: site/landing.md }\n' +
  'docs:\n  source: { path: ../../../tool }\n  github: me/lathe\n  guides:\n    - { dir: docs }\n';

const LANDING = [
  'Welcome to the lathe.',
  '',
  '<div class="section-marker" id="hero"></div>',
  '',
  '## Features',
  '',
  'Read the [guide](../docs/start.md#first-steps) and the [licence](../LICENSE).',
  '',
  '![A lathe](images/lathe.png)',
  '',
].join('\n');

/**
 * A made-up site with one tool project, `lathe`, whose docs source is the
 * `tool` folder next to the configuration and holds the landing file.
 *
 * @param {Record<string, string | Buffer | null>} [tool] Files of the docs source that replace or add to the default ones; null removes one.
 * @param {Record<string, string>} [site] Files of the site that replace or add to the default ones.
 * @returns {Record<string, string | Buffer>}
 */
function siteWith(tool = {}, site = {}) {
  /** @type {Record<string, string | Buffer | null>} */
  const files = {
    'coffer.yaml': SITE_CONFIG,
    'content/home.md': '---\ntitle: Demo\n---\n\nAbout.\n',
    'content/projects/lathe/project.yaml': PROJECT_YAML,
    'content/projects/lathe/card.png': TINY_PNG,
    'theme/templates/project.njk': THEME,
    'tool/site/landing.md': LANDING,
    'tool/site/images/lathe.png': TINY_PNG,
    'tool/docs/start.md': '# Start\n\n## First steps\n\nBegin.\n',
    'tool/LICENSE': 'MIT\n',
    ...site,
  };
  for (const [name, content] of Object.entries(tool)) files[`tool/${name}`] = content;
  return /** @type {Record<string, string | Buffer>} */ (Object.fromEntries(Object.entries(files).filter(([, content]) => content !== null)));
}

/**
 * @template T
 * @param {Record<string, string | Buffer>} files
 * @param {(dir: string) => Promise<T> | T} body
 * @returns {Promise<T>}
 */
async function inSite(files, body) {
  const dir = mkdtempSync(join(tmpdir(), 'coffer-landing-'));
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
 * Builds a site that must fail and returns the findings, one text each.
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

test('the text of the landing file is the body of the project page', async () => {
  await inSite(siteWith(), async (dir) => {
    await build(dir);
    const html = projectPage(dir);
    assert.match(html, /<div class="project-body">\s*<p>Welcome to the lathe\.<\/p>/);
    assert.match(html, /<h2[^>]*>Features<\/h2>/);
  });
});

test('the first level-1 heading stays in the text, with its generated id', async () => {
  const text = ['# Turn wood. Keep the shavings.', '', 'Welcome.', '', '## Features', '', 'More.', ''].join('\n');
  await inSite(siteWith({ 'site/landing.md': text }), async (dir) => {
    await build(dir);
    const html = projectPage(dir);
    assert.match(html, /<div class="project-body">\s*<h1 id="[^"]+"[^>]*>Turn wood\. Keep the shavings\.<\/h1>/);
    assert.match(html, /<h2[^>]*>Features<\/h2>/);
  });
});

test('a relative image is resolved from the folder of the landing file and published', async () => {
  await inSite(siteWith(), async (dir) => {
    await build(dir);
    const html = projectPage(dir);
    const src = /<img src="(\/[^"]+)" alt="A lathe"/.exec(html)?.[1];
    assert.ok(src, html);
    assert.ok(existsSync(join(dir, 'out', 'demo', ...src.split('/').filter(Boolean))), `${src} is published`);
  });
});

test('a link to a guide becomes its site address and a link to another file its GitHub address', async () => {
  await inSite(siteWith(), async (dir) => {
    await build(dir);
    const html = projectPage(dir);
    assert.match(html, /<a href="\/made\/lathe\/docs\/start\/#first-steps">guide<\/a>/);
    assert.match(html, /<a href="https:\/\/github\.com\/me\/lathe\/blob\/main\/LICENSE">licence<\/a>/);
  });
});

test('raw HTML is kept as written', async () => {
  await inSite(siteWith(), async (dir) => {
    await build(dir);
    assert.match(projectPage(dir), /<div class="section-marker" id="hero"><\/div>/);
  });
});

test('ref: links and the ::readme directive work as in a guide', async () => {
  const tool = {
    'README.md': '# Lathe\n\n## Quick start\n\nRun `lathe turn`; see [the guide](docs/start.md).\n',
    'site/landing.md': 'Intro.\n\n::readme{section="Quick start"}\n',
  };
  await inSite(siteWith(tool), async (dir) => {
    await build(dir);
    const html = projectPage(dir);
    assert.match(html, /<div class="readme-section"><p>Run <code>lathe turn<\/code>; see <a href="\/made\/lathe\/docs\/start\/">the guide<\/a>\.<\/p>/);
  });
  // A ref: link needs symbols; without a reference it is reported like in a guide, naming the landing file.
  await inSite(siteWith({ 'site/landing.md': 'See [Thing](ref:Thing).\n' }), async (dir) => {
    const [first, ...rest] = await errorsOf(dir);
    assert.deepEqual(rest, []);
    assert.match(first, /^tool:site\/landing\.md:1:5 /);
    assert.match(first, /broken link 'ref:Thing'/);
  });
});

test('the front matter is project.landing in the templates, with the path of the file added', async () => {
  const landing = '---\nlayout: landing\naccent: "#a33"\n---\n\nBody text.\n';
  await inSite(siteWith({ 'site/landing.md': landing }), async (dir) => {
    await build(dir);
    const html = projectPage(dir);
    assert.match(html, /<p id="landing">landing\|#a33\|site\/landing\.md\|3<\/p>/);
    // The front matter is not part of the text.
    assert.match(html, /<div class="project-body">\s*<p>Body text\.<\/p>/);
    assert.doesNotMatch(html, /layout: landing/);
  });
});

test('without front matter project.landing holds only the file', async () => {
  await inSite(siteWith(), async (dir) => {
    await build(dir);
    assert.match(projectPage(dir), /<p id="landing">\|\|site\/landing\.md\|1<\/p>/);
  });
});

test('a front matter key "file" is refused because project.landing.file is the path of the file', async () => {
  await inSite(siteWith({ 'site/landing.md': '---\nfile: x\n---\n\nText.\n' }), async (dir) => {
    const [first] = await errorsOf(dir);
    assert.match(first, /^tool:site\/landing\.md:1:1 front matter: file: is reserved/);
  });
});

test('a broken front matter fails the build with the line in the file', async () => {
  await inSite(siteWith({ 'site/landing.md': '---\nlayout: [landing\n---\n\nText.\n' }), async (dir) => {
    const [first] = await errorsOf(dir);
    assert.match(first, /^tool:site\/landing\.md:\d+:\d+ front matter: /);
  });
  await inSite(siteWith({ 'site/landing.md': '---\nlayout: x\n\nText.\n' }), async (dir) => {
    const [first] = await errorsOf(dir);
    assert.match(first, /^tool:site\/landing\.md:1:1 front matter: .*no other "---" line/);
  });
});

test('a broken link fails the build naming repo, path, line and column in the file, front matter counted', async () => {
  const landing = '---\nlayout: landing\n---\n\nFirst.\n\nSee [nothing](docs/nothing.md) here.\n';
  await inSite(siteWith({ 'site/landing.md': landing }), async (dir) => {
    const [first, ...rest] = await errorsOf(dir);
    assert.deepEqual(rest, []);
    // Line 7 of the file; the link starts at column 5.
    assert.match(first, /^tool:site\/landing\.md:7:5 /);
    assert.match(first, /broken link 'docs\/nothing\.md'/);
  });
});

test('a missing image fails the build naming repo, path, line and column in the file', async () => {
  const landing = '---\nlayout: landing\n---\n\nFirst.\n\n![Gone](images/gone.png)\n';
  await inSite(siteWith({ 'site/landing.md': landing }), async (dir) => {
    const [first, ...rest] = await errorsOf(dir);
    assert.deepEqual(rest, []);
    assert.match(first, /^tool:site\/landing\.md:7:1 /);
    assert.match(first, /missing image 'images\/gone\.png'/);
  });
});

test('a docs source without the landing file fails the build, with no fallback to empty content', async () => {
  await inSite(siteWith({ 'site/landing.md': null }), async (dir) => {
    const [first, ...rest] = await errorsOf(dir);
    assert.deepEqual(rest, []);
    assert.match(first, /^tool:site\/landing\.md /);
    assert.match(first, /the landing file does not exist in the docs source/);
  });
});

test('a landing file with another capitalisation fails the build', async () => {
  await inSite(siteWith({ 'site/landing.md': null, 'site/Landing.md': LANDING }), async (dir) => {
    const [first] = await errorsOf(dir);
    assert.match(first, /^tool:site\/landing\.md /);
  });
});

test('a docs source that cannot be fetched fails the build', async () => {
  await inSite(siteWith(), async (dir) => {
    const config = loadConfig({ configPath: join(dir, 'coffer.yaml') });
    rmSync(join(dir, 'tool'), { recursive: true, force: true });
    await assert.rejects(buildSites(config, { out: join(dir, 'out'), now: new Date('2026-06-01T12:00:00Z') }), /tool/);
    assert.equal(existsSync(join(dir, 'out', 'demo', 'made', 'lathe', 'index.html')), false);
  });
});

test('readLanding reads the file, the front matter and the line the text starts on', async () => {
  await inSite(siteWith({ 'site/landing.md': '﻿---\r\nlayout: x\r\n---\r\n\r\nText.\r\n' }), (dir) => {
    /** @type {unknown[]} */
    const issues = [];
    const read = readLanding(/** @type {import('../src/docs/sources.js').FetchedDocs} */ (/** @type {unknown} */ ({
      slug: 'lathe',
      root: join(dir, 'tool'),
      github: 'me/lathe',
      source: { type: 'path' },
    })), 'site/landing.md', (issue) => issues.push(issue));
    assert.deepEqual(issues, []);
    assert.deepEqual(read?.data, { layout: 'x' });
    assert.equal(read?.body, '\nText.\n');
    assert.equal(read?.bodyLine, 4);
    assert.equal(read?.page.label, 'tool:site/landing.md');
  });
});

// The brand folder and the pictures of the docs source (project.yaml: brand: { dir }, repo:path).

/** An SVG without script, as a brand file would be; its bytes must reach the output untouched (note the odd spacing). */
const BRAND_SVG = Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"  width="10" height="10" viewBox="0 0 10 10">\r\n  <circle cx="5" cy="5" r="4"/>\n</svg>\n');
const BRAND_ICO = Buffer.from([0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 1, 0, 32, 0, 255, 254, 0, 13, 10, 26]);

/** A project.yaml with a brand folder. */
function brandYaml() {
  return PROJECT_YAML.replace('landing: { file: site/landing.md }\n', 'landing: { file: site/landing.md }\nbrand: { dir: site/brand }\n');
}

test('the files of brand.dir are published unchanged below /assets/{slug}/, SVG included', async () => {
  const files = siteWith(
    {
      'site/brand/logo.svg': BRAND_SVG,
      'site/brand/logo-dark.svg': Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      'site/brand/favicon.ico': BRAND_ICO,
      'site/brand/favicon.svg': BRAND_SVG,
      'site/brand/apple-touch-icon.png': TINY_PNG,
      'site/brand/more/deep/mark.png': TINY_PNG,
    },
    { 'content/projects/lathe/project.yaml': brandYaml() },
  );
  await inSite(files, async (dir) => {
    await build(dir);
    const out = join(dir, 'out', 'demo', 'assets', 'lathe');
    assert.deepEqual(readFileSync(join(out, 'logo.svg')), BRAND_SVG);
    assert.deepEqual(readFileSync(join(out, 'favicon.svg')), BRAND_SVG);
    assert.deepEqual(readFileSync(join(out, 'favicon.ico')), BRAND_ICO);
    assert.deepEqual(readFileSync(join(out, 'apple-touch-icon.png')), TINY_PNG);
    assert.deepEqual(readFileSync(join(out, 'more', 'deep', 'mark.png')), TINY_PNG);
    assert.equal(readFileSync(join(out, 'logo-dark.svg'), 'utf8'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  });
});

test('a brand file at the address of a theme asset fails the build, naming both', async () => {
  const files = siteWith(
    { 'site/brand/logo.svg': BRAND_SVG },
    { 'content/projects/lathe/project.yaml': brandYaml(), 'theme/assets/lathe/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>' },
  );
  await inSite(files, async (dir) => {
    const [first] = await errorsOf(dir);
    assert.match(first ?? '', /content\/projects\/lathe\/project\.yaml/);
    assert.match(first ?? '', /brand\.dir: "\/assets\/lathe\/logo\.svg" is published twice/);
    assert.match(first ?? '', /brand file tool:site\/brand\/logo\.svg of the project "lathe"/);
    assert.match(first ?? '', /the theme asset "assets\/lathe\/logo\.svg"/);
  });
});

test('a brand file that differs from a theme asset only in capitalisation is a collision too', async () => {
  const files = siteWith(
    { 'site/brand/Logo.svg': BRAND_SVG },
    { 'content/projects/lathe/project.yaml': brandYaml(), 'theme/assets/lathe/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>' },
  );
  await inSite(files, async (dir) => {
    const [first] = await errorsOf(dir);
    assert.match(first ?? '', /published twice/);
  });
});

test('a brand folder that is not in the source fails the build naming the key and the path', async () => {
  await inSite(siteWith({}, { 'content/projects/lathe/project.yaml': brandYaml() }), async (dir) => {
    const [first] = await errorsOf(dir);
    assert.match(first ?? '', /brand\.dir: the folder "site\/brand" does not exist in the docs source tool/);
  });
});

test('repo:site/card.png is the card picture of the project and its og:image', async () => {
  const yaml = PROJECT_YAML.replace('card: card.png', 'card: repo:site/card.png');
  const files = siteWith({ 'site/card.png': TINY_PNG }, { 'content/projects/lathe/project.yaml': yaml });
  delete files['content/projects/lathe/card.png'];
  await inSite(files, async (dir) => {
    await build(dir);
    const html = projectPage(dir);
    const og = /<meta property="og:image" content="https:\/\/demo\.example(\/img\/[0-9a-f]+\/card-\d+\.webp)">/.exec(html);
    assert.ok(og, 'og:image is the published card');
    assert.ok(existsSync(join(dir, 'out', 'demo', ...(og?.[1] ?? '').split('/').filter(Boolean))));
    const manifest = JSON.parse(readFileSync(join(dir, 'out', 'demo', '.coffer-manifest.json'), 'utf8'));
    assert.equal(manifest.projects[0].card, 'repo:site/card.png');
  });
});

test('a repo: card that is not in the source fails the build naming the key and the path', async () => {
  const yaml = PROJECT_YAML.replace('card: card.png', 'card: repo:site/missing.png');
  await inSite(siteWith({}, { 'content/projects/lathe/project.yaml': yaml }), async (dir) => {
    const [first] = await errorsOf(dir);
    assert.match(first ?? '', /content\/projects\/lathe\/project\.yaml/);
    assert.match(first ?? '', /card: image 'repo:site\/missing\.png': the file does not exist in the docs source tool/);
  });
});

test('a repo: card that is not a picture fails the build with the key and the path', async () => {
  const yaml = PROJECT_YAML.replace('card: card.png', 'card: repo:site/card.png');
  await inSite(siteWith({ 'site/card.png': 'not a picture' }, { 'content/projects/lathe/project.yaml': yaml }), async (dir) => {
    const [first] = await errorsOf(dir);
    assert.match(first ?? '', /card: image 'repo:site\/card\.png': /);
  });
});

test('another picture key of a kind with a docs source accepts repo:, publishes the picture and names the key when the file is missing', async () => {
  registerProjectKind({
    name: 'site-tool',
    template: 'project.njk',
    fields: { docs: { type: 'docs' }, art: { type: 'image' } },
  });
  try {
    const theme = [
      '{% extends "coffer:project.njk" %}',
      '{% block project_header %}<p id="art">{{ project.media.art | dump }}</p>{% endblock %}',
    ].join('');
    const yaml = (/** @type {string} */ art) =>
      PROJECT_YAML.replace('kind: tool', 'kind: site-tool').replace('repo: https://github.example/me/lathe\n', '') + `art: ${art}\n`;
    await inSite(
      siteWith({ 'site/pic.png': TINY_PNG }, { 'content/projects/lathe/project.yaml': yaml('"repo:site/pic.png"'), 'theme/templates/project.njk': theme }),
      async (dir) => {
        await build(dir);
        const shown = /<p id="art">([^<]*)<\/p>/.exec(projectPage(dir))?.[1] ?? '';
        assert.match(shown, /&quot;type&quot;:&quot;image&quot;/);
        assert.match(shown, /\/img\/[0-9a-f]+\//);
      },
    );
    await inSite(
      siteWith({}, { 'content/projects/lathe/project.yaml': yaml('"repo:site/missing.png"'), 'theme/templates/project.njk': theme }),
      async (dir) => {
        const [first, ...rest] = await errorsOf(dir);
        assert.deepEqual(rest, []);
        assert.match(first ?? '', /content\/projects\/lathe\/project\.yaml/);
        assert.match(first ?? '', /art: image 'repo:site\/missing\.png': the file does not exist in the docs source tool/);
      },
    );
  } finally {
    unregisterProjectKind('site-tool');
  }
});

test('resolveRepoPicture finds a file of the source and refuses a missing file, a folder, a wrong capitalisation and a path that leaves the source', async () => {
  await inSite(siteWith({ 'site/Card.png': TINY_PNG }), (dir) => {
    const fetched = /** @type {import('../src/docs/sources.js').FetchedDocs} */ (/** @type {unknown} */ ({
      slug: 'lathe',
      root: join(dir, 'tool'),
      github: 'me/lathe',
      source: { type: 'path' },
    }));
    const found = resolveRepoPicture(fetched, 'site/Card.png');
    assert.ok(found.ok);
    assert.deepEqual(readFileSync(found.file), TINY_PNG);
    const message = (/** @type {string} */ rel) => {
      const result = resolveRepoPicture(fetched, rel);
      assert.equal(result.ok, false);
      return result.ok ? '' : result.message;
    };
    assert.match(message('site/nope.png'), /does not exist in the docs source tool/);
    assert.match(message('site'), /is not a file/);
    assert.match(message('site/card.png'), /capitalisation|does not exist/);
    assert.match(message('../outside.png'), /cannot be used/);
  });
});
