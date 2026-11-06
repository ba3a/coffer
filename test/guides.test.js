import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSites } from '../src/build.js';
import { checkOutput } from '../src/check/index.js';
import { loadConfig } from '../src/config.js';
import { MAX_GUIDE_FILE_BYTES, MAX_GUIDE_PAGES, githubRefOf, githubUrl, planGuides, slugOf, titleFromName } from '../src/docs/guides.js';
import { ReportError } from '../src/report.js';
import { TINY_PNG } from './helpers/images.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const exampleConfig = join(root, 'example', 'coffer.yaml');
const fixture = join(root, 'example', 'sample-tool');

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

/** The docs block most tests use: a folder source named `tool`, the GitHub repository `me/lathe`, one guide in `docs`. */
const DOCS = 'docs:\n  source: { path: ../../../tool }\n  github: me/lathe\n  guides:\n    - { dir: docs, order: [start.md] }\n';

/**
 * A made-up site with one tool project, `lathe`, whose documentation is the
 * `tool` folder next to the configuration.
 *
 * @param {Record<string, string | Buffer>} tool The files of the documentation source, relative to its root.
 * @param {string} [docsYaml]
 * @returns {Record<string, string | Buffer>}
 */
function siteWith(tool, docsYaml = DOCS) {
  /** @type {Record<string, string | Buffer>} */
  const files = {
    'coffer.yaml': SITE_CONFIG,
    'content/home.md': '---\ntitle: Demo\n---\n\nAbout.\n',
    'content/projects/lathe/project.yaml': `name: Lathe\npitch: Turns wood.\nkind: tool\nstatus: released\ncard: card.png\nrepo: https://github.example/me/lathe\n${docsYaml}`,
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
  const dir = mkdtempSync(join(tmpdir(), 'coffer-guides-'));
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
 * Builds a site that must fail and returns the findings, one text each.
 *
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
 * @returns {{ warnings: { message: string }[] }}
 */
function reportOf(dir) {
  return JSON.parse(readFileSync(join(dir, '.coffer', 'report.json'), 'utf8'));
}

/**
 * @param {string} dir
 * @param {string} page The part of the address below `/made/lathe/docs/`.
 * @returns {string}
 */
function docsHtml(dir, page = '') {
  return readFileSync(join(dir, 'out', 'demo', 'made', 'lathe', 'docs', ...page.split('/').filter(Boolean), 'index.html'), 'utf8');
}

/**
 * @param {string} html
 * @returns {string} The sidebar's list items, as `title@url` joined by `|`.
 */
function sidebarOf(html) {
  const nav = /<nav class="docs-sidebar"[\s\S]*?<\/nav>/.exec(html)?.[0] ?? '';
  return [...nav.matchAll(/<a href="([^"]+)"[^>]*>([^<]*)<\/a>/g)].map((match) => `${match[2]}@${match[1]}`).join('|');
}

const START = '# Start here\n\nThe first page. See [Usage](usage.md#options).\n';
const USAGE = '# Usage\n\n## Options\n\nAn option.\n';

// --- the sample tool of the example site ----------------------------------------

test('the sample tool: guides render in the site theme with a sidebar in the configured order', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coffer-guides-example-'));
  try {
    const config = loadConfig({ configPath: exampleConfig });
    const [result] = await buildSites(config, { out: dir, now: new Date('2026-06-01T12:00:00Z'), cacheDir: join(dir, '.cache') });
    const read = (/** @type {string} */ page) => readFileSync(join(dir, 'workshop', 'made', 'kerfcalc', 'docs', ...page.split('/').filter(Boolean), 'index.html'), 'utf8');
    const start = read('getting-started');
    // The configured order first (getting-started, usage), then the rest alphabetically (internals); the generated index leads.
    assert.equal(
      sidebarOf(start),
      'Documentation@/made/kerfcalc/docs/|Getting started@/made/kerfcalc/docs/getting-started/|Usage@/made/kerfcalc/docs/usage/|Internals@/made/kerfcalc/docs/internals/',
    );
    assert.match(start, /<li><a href="\/made\/kerfcalc\/docs\/getting-started\/" aria-current="page">Getting started<\/a><\/li>/);
    assert.match(start, /<nav class="docs-sidebar" aria-label="Kerfcalc: documentation pages">/);
    // Breadcrumbs lead back to the project page.
    assert.match(start, /<nav class="docs-breadcrumbs" aria-label="Breadcrumbs">\s*<ol>\s*<li><a href="\/made\/">Projects<\/a><\/li>\s*<li><a href="\/made\/kerfcalc\/">Kerfcalc<\/a><\/li>\s*<li><a href="\/made\/kerfcalc\/docs\/">Documentation<\/a><\/li>/);
    // The site theme: the base template's header, footer and stylesheet.
    assert.match(start, /<link rel="stylesheet" href="\/assets\/coffer\.css">/);
    assert.match(start, /<header class="site-header">/);
    // Title from the first heading, not repeated in the body.
    assert.match(start, /<title>Getting started: Kerfcalc \| Tove Marlowe<\/title>/);
    assert.equal(start.split('<h1').length - 1, 1);
    // Previous and next.
    assert.match(start, /<li class="docs-previous"><a rel="prev" href="\/made\/kerfcalc\/docs\/">/);
    assert.match(start, /<li class="docs-next"><a rel="next" href="\/made\/kerfcalc\/docs\/usage\/">/);
    assert.match(read('internals'), /<li class="docs-previous"><a rel="prev" href="\/made\/kerfcalc\/docs\/usage\/">/);
    assert.doesNotMatch(read('internals'), /docs-next/);

    // Links between guides are site links, with their anchors.
    assert.match(start, /<a href="\/made\/kerfcalc\/docs\/usage\/">Usage<\/a>/);
    assert.match(start, /<a href="\/made\/kerfcalc\/docs\/usage\/#options">the options<\/a>/);
    assert.match(read('usage'), /<a href="\/made\/kerfcalc\/docs\/getting-started\/">Getting started<\/a>/);
    // Links to files outside the published set point at GitHub: `../CHANGELOG.md` and a source file are files, a folder is a tree.
    assert.match(start, /<a href="https:\/\/github\.com\/tove-marlowe\/kerfcalc\/blob\/main\/CHANGELOG\.md">changelog<\/a>/);
    assert.match(start, /<a href="https:\/\/github\.com\/tove-marlowe\/kerfcalc\/blob\/main\/src\/main\/kotlin\/Sample\.kt">Sample\.kt<\/a>/);
    assert.match(start, /<a href="https:\/\/github\.com\/tove-marlowe\/kerfcalc\/tree\/main\/src">src folder<\/a>/);
    // A link to the source of the page itself.
    assert.match(start, /<p class="docs-source"><a href="https:\/\/github\.com\/tove-marlowe\/kerfcalc\/blob\/main\/docs\/getting-started\.md" rel="noopener">View this page on GitHub<\/a><\/p>/);

    // The image went through the image pipeline: responsive variants, size attributes, the viewer, a manifest entry.
    assert.match(start, /<picture><source type="image\/webp" srcset="\/img\/[0-9a-f]+\/board-160\.webp 160w"/);
    assert.match(start, /<img src="\/img\/[0-9a-f]+\/board-160\.webp" alt="A board with a thin cut" width="160" height="64">/);
    assert.match(start, /data-viewer="0"/);
    assert.match(start, /id="coffer-viewer"/);
    const image = result.manifest.images.find((entry) => entry.post === '/made/kerfcalc/docs/getting-started/');
    assert.ok(image, 'the manifest lists the image of the guide');
    assert.match(image.source, /sample-tool\/docs\/board\.png$/);
    assert.ok(existsSync(join(dir, 'workshop', image.outputs[0].file)));

    // The docs index is generated (the folder has no README or index) and lists the pages.
    assert.match(read(''), /<ul class="docs-index-list">\s*<li><a href="\/made\/kerfcalc\/docs\/getting-started\/">Getting started<\/a><\/li>/);

    // The project page and the manifest.
    assert.match(readFileSync(join(dir, 'workshop', 'made', 'kerfcalc', 'index.html'), 'utf8'), /<a href="\/made\/kerfcalc\/docs\/">Read the documentation<\/a>/);
    const entry = /** @type {import('../src/build.js').ManifestProject} */ (result.manifest.projects.find((project) => project.slug === 'kerfcalc'));
    assert.deepEqual(
      entry.docs?.pages.map((page) => [page.url, page.source, page.title]),
      [
        ['/made/kerfcalc/docs/', null, 'Documentation'],
        ['/made/kerfcalc/docs/getting-started/', 'docs/getting-started.md', 'Getting started'],
        ['/made/kerfcalc/docs/usage/', 'docs/usage.md', 'Usage'],
        ['/made/kerfcalc/docs/internals/', 'docs/internals.md', 'Internals'],
      ],
    );
    for (const page of entry.docs?.pages ?? []) {
      assert.ok(result.manifest.pages.some((candidate) => candidate.url === page.url && candidate.type === 'docs'), page.url);
      assert.ok(result.manifest.sitemap.includes(page.url), `${page.url} is in the sitemap`);
      assert.match(readFileSync(join(dir, 'workshop', 'sitemap.xml'), 'utf8'), new RegExp(`<loc>https://tove-marlowe\\.example${page.url}</loc>`));
    }

    // coffer check passes, with the docs link present.
    const checked = await checkOutput(config, { out: dir });
    assert.deepEqual(checked.failures, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a page with four headings or more gets the contents list of posts', async () => {
  await inSite(siteWith({ 'docs/start.md': '# Long\n\n## One\n\n## Two\n\n## Three\n\n## Four\n' }), async (dir) => {
    await build(dir);
    const html = docsHtml(dir, 'start');
    assert.match(html, /<details class="toc">\s*<summary>Contents<\/summary>[\s\S]*<a href="#one">One<\/a>[\s\S]*<a href="#four">Four<\/a>/);
    assert.doesNotMatch(docsHtml(dir, ''), /class="toc"/);
  });
});

// --- links ------------------------------------------------------------------------

test('a link to a published guide works, anchors included; README and index of the guide folder are the docs index', async () => {
  await inSite(
    siteWith({
      'docs/README.md': '# Welcome\n\nGo to [start](start.md) or [usage](./usage.md#options) or [here](#welcome).\n',
      'docs/start.md': '# Start\n\nBack to [the index](README.md) and [also](./) and [the folder](../docs/).\n',
      'docs/usage.md': USAGE,
    }),
    async (dir) => {
      await build(dir);
      const index = docsHtml(dir);
      assert.match(index, /<h1 id="welcome">Welcome<\/h1>/);
      assert.match(index, /<a href="\/made\/lathe\/docs\/start\/">start<\/a>/);
      assert.match(index, /<a href="\/made\/lathe\/docs\/usage\/#options">usage<\/a>/);
      assert.match(index, /<a href="#welcome">here<\/a>/);
      const start = docsHtml(dir, 'start');
      assert.equal((start.match(/<a href="\/made\/lathe\/docs\/">/g) ?? []).length >= 3, true);
      // The index is not listed twice and the order is: index, start (ordered), usage.
      assert.equal(sidebarOf(start), 'Welcome@/made/lathe/docs/|Start@/made/lathe/docs/start/|Usage@/made/lathe/docs/usage/');
      assert.equal(existsSync(join(dir, 'out', 'demo', 'made', 'lathe', 'docs', 'readme')), false);
    },
  );
});

test('index.md wins over README.md as the docs index, and the README is then a page of its own', async () => {
  await inSite(siteWith({ 'docs/index.md': '# From index\n', 'docs/README.md': '# From readme\n' }), async (dir) => {
    await build(dir);
    assert.match(docsHtml(dir), /From index/);
    assert.match(docsHtml(dir, 'readme'), /From readme/);
  });
});

test('a link to a file that is not published points at GitHub, and a directory at the tree', async () => {
  await inSite(
    siteWith({
      'docs/start.md': '# Start\n\n[license](../LICENSE) [changelog](../CHANGELOG.md#v1) [readme](../README.md) [code](/src/Main.kt) [dir](../src/) [spaced](../src/my%20file.txt) [root](..)\n',
      'LICENSE': 'MIT',
      'CHANGELOG.md': '# Changes\n',
      'README.md': '# Tool\n',
      'src/Main.kt': 'fun main() {}',
      'src/my file.txt': 'x',
    }),
    async (dir) => {
      await build(dir);
      const html = docsHtml(dir, 'start');
      const base = 'https://github.com/me/lathe';
      assert.match(html, new RegExp(`<a href="${base}/blob/main/LICENSE">license</a>`));
      assert.match(html, new RegExp(`<a href="${base}/blob/main/CHANGELOG.md#v1">changelog</a>`));
      assert.match(html, new RegExp(`<a href="${base}/blob/main/README.md">readme</a>`));
      assert.match(html, new RegExp(`<a href="${base}/blob/main/src/Main.kt">code</a>`));
      assert.match(html, new RegExp(`<a href="${base}/tree/main/src">dir</a>`));
      assert.match(html, new RegExp(`<a href="${base}/blob/main/src/my%20file.txt">spaced</a>`));
      assert.match(html, new RegExp(`<a href="${base}/tree/main">root</a>`));
    },
  );
});

test('a link to an unpublished file needs the github setting', async () => {
  await inSite(
    siteWith({ 'docs/start.md': '# Start\n\n[code](../Main.kt)\n', 'Main.kt': 'x' }, 'docs:\n  source: { path: ../../../tool }\n  guides:\n    - { dir: docs }\n'),
    async (dir) => {
      const errors = await errorsOf(dir);
      assert.equal(errors.length, 1);
      assert.match(errors[0], /^tool:docs\/start\.md:3:1 link '\.\.\/Main\.kt' leads to Main\.kt, a file of the repository that is not published, and a link to it needs the "github" setting/);
    },
  );
});

test('a link to a missing file fails the build with repo:path:line', async () => {
  await inSite(siteWith({ 'docs/start.md': '# Start\n\nText.\n\nSee [the guide](nowhere.md) and [ok](usage.md).\n', 'docs/usage.md': USAGE }), async (dir) => {
    const errors = await errorsOf(dir);
    assert.deepEqual(errors, ["tool:docs/start.md:5:5 broken link 'nowhere.md' (docs/nowhere.md does not exist in the repository)"]);
    // The report file carries the same finding.
    assert.match(readFileSync(join(dir, '.coffer', 'report.json'), 'utf8'), /broken link 'nowhere\.md'/);
  });
});

test('the name of the repository in a finding is the folder of a folder source, and the repository name of a git one', async () => {
  const guide = { 'docs/start.md': '# S\n\n[x](gone.md)\n' };
  await inSite(siteWith(guide), async (dir) => {
    assert.match((await errorsOf(dir))[0], /^tool:docs\/start\.md:3:1 /);
  });
  const plan = planGuides({
    slug: 'lathe',
    root: join(fixture),
    source: { type: 'git', git: 'https://example.org/me/widget.git', ref: 'main', sha: 'a'.repeat(40) },
    github: 'me/widget',
    guides: [{ dir: 'docs', order: [], include: ['**/*.md'], exclude: [] }],
  });
  assert.equal(plan.repo, 'widget');
  assert.match(plan.pages[0].label, /^widget:docs\//);
});

test('a link to a heading that does not exist fails, in the page itself and in another guide', async () => {
  await inSite(
    siteWith({
      'docs/start.md': '# Start\n\n## Real\n\n[a](#real) [b](#nope) [c](usage.md#options) [d](usage.md#missing) [e](#top)\n',
      'docs/usage.md': USAGE,
    }),
    async (dir) => {
      const errors = await errorsOf(dir);
      assert.deepEqual(errors, [
        "tool:docs/start.md:5:12 broken link '#nope' (this page has no heading or id 'nope')",
        "tool:docs/start.md:5:45 broken link 'usage.md#missing' (docs/usage.md has no heading or id 'missing')",
      ]);
    },
  );
});

test('links with a scheme other than http, https and mailto are refused, in Markdown and in raw HTML', async () => {
  await inSite(
    siteWith({
      'docs/start.md': [
        '# Start',
        '',
        '[a](javascript:alert(1)) [b](data:text/html;base64,AAAA) [c](VBScript:x) [d](file:///etc/passwd)',
        '',
        '[e](https://example.org/x) [f](mailto:me@example.org) [g](//cdn.example.org/x)',
        '',
        '<a href="javascript:alert(2)">raw</a> <img src="data:image/png;base64,AAAA" alt="x">',
        '',
      ].join('\n'),
    }),
    async (dir) => {
      const errors = await errorsOf(dir);
      assert.equal(errors.length, 6, errors.join('\n'));
      for (const scheme of ['javascript', 'data', 'vbscript', 'file']) {
        assert.ok(errors.some((error) => error.startsWith('tool:docs/start.md:3:') && error.includes(`not ${scheme}:`)), scheme);
      }
      // Raw HTML is not parsed for links, but its addresses are refused too, with the line where they are written.
      assert.ok(errors.some((error) => error.startsWith('tool:docs/start.md:7 refused address \'javascript:alert(2)\'')), errors.join('\n'));
      assert.ok(errors.some((error) => error.startsWith('tool:docs/start.md:7 refused address \'data:image/png')), errors.join('\n'));
      // The page that was written anyway carries no such address.
      const html = docsHtml(dir, 'start');
      assert.doesNotMatch(html, /javascript:|data:text|vbscript|file:\/\/|data:image/i);
      assert.match(html, /<a href="https:\/\/example\.org\/x">e<\/a>/);
      assert.match(html, /<a href="mailto:me@example\.org">f<\/a>/);
    },
  );
});

test('a scheme hidden by white space inside it is still a refused scheme', async () => {
  await inSite(siteWith({ 'docs/start.md': '# Start\n\n[a](java&#9;script:alert(1))\n\n<a href="jav&#10;ascript:alert(1)">b</a>\n' }), async (dir) => {
    const errors = await errorsOf(dir);
    assert.ok(errors.length >= 2, errors.join('\n'));
    assert.doesNotMatch(docsHtml(dir, 'start'), /ascript:/i);
  });
});

test('a link that leaves the repository fails the build', async () => {
  await inSite(
    siteWith({ 'docs/start.md': '# Start\n\n[a](../../outside.md) [b](../../../etc/passwd) [c](/../x)\n' }),
    async (dir) => {
      const errors = await errorsOf(dir);
      assert.equal(errors.length, 3);
      for (const error of errors) assert.match(error, /^tool:docs\/start\.md:3:\d+ broken link '[^']+' \(it leads out of the repository\)$/);
    },
  );
});

test('a symbolic link in the repository that points outside leaks nothing into the site', async () => {
  await inSite(siteWith({ 'docs/start.md': '# Start\n\n[secret](../up/secret.txt)\n\n![](../up/secret.png)\n' }), async (dir) => {
    writeFileSync(join(dir, 'secret.txt'), 'top secret');
    writeFileSync(join(dir, 'secret.png'), TINY_PNG);
    // A directory junction (a directory link that needs no privilege on Windows; a plain link elsewhere).
    symlinkSync(dir, join(dir, 'tool', 'up'), 'junction');
    const errors = await errorsOf(dir);
    assert.ok(errors.some((error) => /^tool:docs\/start\.md:3:\d+ broken link '\.\.\/up\/secret\.txt' \(up\/secret\.txt leads out of the repository\)$/.test(error)), errors.join('\n'));
    assert.ok(errors.some((error) => /^tool:docs\/start\.md:5:\d+ image '\.\.\/up\/secret\.png' cannot be used: .*leads out of the repository/.test(error)), errors.join('\n'));
    assert.equal(existsSync(join(dir, 'out', 'demo', 'made', 'lathe', 'docs', 'start', 'secret.txt')), false);
  });
});

test('a guide file that is a symbolic link to a file outside the repository is not read', async () => {
  await inSite(siteWith({ 'docs/start.md': '# Start\n' }), async (dir) => {
    writeFileSync(join(dir, 'outside.md'), '# Outside\n\nSecret text.\n');
    try {
      symlinkSync(join(dir, 'outside.md'), join(dir, 'tool', 'docs', 'link.md'), 'file');
    } catch {
      return; // A file link needs a privilege on some systems.
    }
    const errors = await errorsOf(dir);
    assert.deepEqual(errors, ['tool:docs/link.md the file leads out of the repository (a symbolic link points outside it) and is not read']);
    assert.equal(existsSync(join(dir, 'out', 'demo', 'made', 'lathe', 'docs', 'link')), false);
  });
});

test('a link that differs from the file only in capitalisation is broken, as it is on GitHub', async () => {
  await inSite(siteWith({ 'docs/start.md': '# Start\n\n[a](../license) [b](Usage.md)\n', 'LICENSE': 'MIT', 'docs/usage.md': USAGE }), async (dir) => {
    const errors = await errorsOf(dir);
    assert.equal(errors.length, 2, errors.join('\n'));
    assert.match(errors[0], /broken link '\.\.\/license'/);
    assert.match(errors[1], /broken link 'Usage\.md'/);
  });
});

test('Windows line endings and a byte order mark are handled, and the line numbers stay right', async () => {
  const text = '﻿# Start\r\n\r\nLine three.\r\n\r\n[gone](nope.md)\r\n';
  await inSite(siteWith({ 'docs/start.md': Buffer.from(text, 'utf8') }), async (dir) => {
    const errors = await errorsOf(dir);
    assert.match(errors[0], /^tool:docs\/start\.md:5:1 broken link 'nope\.md'/);
    assert.doesNotMatch(docsHtml(dir, 'start'), /﻿|\r/);
    assert.match(docsHtml(dir, 'start'), /<title>Start: Lathe/);
  });
});

test('a file that is not valid UTF-8 fails the build with its name', async () => {
  await inSite(siteWith({ 'docs/start.md': '# Start\n', 'docs/bad.md': Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a]) }), async (dir) => {
    assert.deepEqual(await errorsOf(dir), ['tool:docs/bad.md the file is not valid UTF-8']);
  });
});

// --- images -------------------------------------------------------------------------

test('images of a guide are published through the image pipeline; a missing or unsupported one fails the build', async () => {
  await inSite(
    siteWith({
      'docs/start.md': '# Start\n\n![A board](pics/board.png) ![Remote](https://example.org/x.png "Caption") ![Root](/docs/pics/board.png) ![](pics/board.png)\n',
      'docs/pics/board.png': TINY_PNG,
    }),
    async (dir) => {
      const [result] = await build(dir);
      const html = docsHtml(dir, 'start');
      assert.equal((html.match(/<picture>/g) ?? []).length, 3);
      assert.match(html, /<img src="https:\/\/example\.org\/x\.png"/);
      assert.equal(result.manifest.images.filter((image) => image.post === '/made/lathe/docs/start/').length, 1);
      assert.ok(result.warnings.some((message) => message.startsWith('tool:docs/start.md:3:') && message.includes('has no alt text')), result.warnings.join('\n'));
    },
  );
  await inSite(
    siteWith({
      'docs/start.md': '# Start\n\n![a](missing.png)\n\n![b](chart.svg)\n\n![c](notes.txt)\n\n![d](data:image/png;base64,AAAA)\n\n![e](../../x.png)\n',
      'docs/chart.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
      'docs/notes.txt': 'x',
    }),
    async (dir) => {
      const errors = await errorsOf(dir);
      assert.equal(errors.length, 5, errors.join('\n'));
      assert.match(errors[0], /^tool:docs\/start\.md:3:1 missing image 'missing\.png' \(docs\/missing\.png does not exist in the repository\)$/);
      assert.match(errors[1], /^tool:docs\/start\.md:5:1 image 'chart\.svg' is an SVG, which a guide cannot publish/);
      assert.match(errors[2], /^tool:docs\/start\.md:7:1 unsupported image format 'notes\.txt'/);
      assert.match(errors[3], /^tool:docs\/start\.md:9:1 refused image 'data:image\/png;base64,AAAA'/);
      assert.match(errors[4], /^tool:docs\/start\.md:11:1 missing image '\.\.\/\.\.\/x\.png' \(it leads out of the repository\)$/);
    },
  );
});

// --- directives, raw HTML ---------------------------------------------------------------

test('unknown directives and maps in a guide are located, never a crash', async () => {
  await inSite(siteWith({ 'docs/start.md': '# Start\n\n:::note\nHello\n:::\n' }), async (dir) => {
    const errors = await errorsOf(dir);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /^tool:docs\/start\.md:3:1 unknown directive "note"/);
  });
  await inSite(siteWith({ 'docs/start.md': '# Start\n\n::map\n\nText.\n' }), async (dir) => {
    const [result] = await build(dir);
    assert.ok(result.warnings.some((message) => message.startsWith('tool:docs/start.md:3: the ::map directive is only for posts')), result.warnings.join('\n'));
    assert.doesNotMatch(docsHtml(dir, 'start'), /data-coffer-map/);
  });
});

test('raw HTML in a guide is passed through like in a post, and everything is escaped in the template', async () => {
  await inSite(
    siteWith({ 'docs/start.md': '# <b>Bold</b> & "quoted"\n\n<div class="note">raw</div>\n', 'docs/x.md': '# <script>alert(1)</script>\n' }),
    async (dir) => {
      await build(dir);
      const html = docsHtml(dir, 'start');
      assert.match(html, /<div class="note">raw<\/div>/);
      assert.match(html, /<title>Bold &amp; &quot;quoted&quot;: Lathe \| Demo<\/title>/);
      assert.match(html, /<h1 id="bold--quoted">Bold &amp; &quot;quoted&quot;<\/h1>/);
      // The title of a page is text, in the sidebar and in the heading alike.
      assert.doesNotMatch(docsHtml(dir, 'x'), /<script>alert\(1\)/);
    },
  );
});

// --- selection, ordering, addresses -----------------------------------------------------------

test('titles come from the first heading; without one they come from the file name', async () => {
  await inSite(siteWith({ 'docs/start.md': 'Text only.\n', 'docs/how_to-install.md': 'Text.\n', 'docs/other.md': '## Not a title\n\n# The title\n' }), async (dir) => {
    await build(dir);
    assert.equal(
      sidebarOf(docsHtml(dir, 'start')),
      'Documentation@/made/lathe/docs/|Start@/made/lathe/docs/start/|How To Install@/made/lathe/docs/how-to-install/|The title@/made/lathe/docs/other/',
    );
  });
});

test('sub folders become path segments, a README of a folder stands for the folder, and the address is lower case', async () => {
  await inSite(
    siteWith({ 'docs/start.md': '# S\n', 'docs/Api/README.md': '# Api\n', 'docs/Api/Errors.md': '# Errors\n', 'docs/Deep/er/Page One.md': '# P\n' }),
    async (dir) => {
      const [result] = await build(dir);
      const urls = /** @type {import('../src/build.js').ManifestProject} */ (result.manifest.projects[0]).docs?.pages.map((page) => page.url);
      assert.deepEqual(urls, [
        '/made/lathe/docs/',
        '/made/lathe/docs/start/',
        '/made/lathe/docs/api/errors/',
        '/made/lathe/docs/api/',
        '/made/lathe/docs/deep/er/page-one/',
      ]);
    },
  );
});

test('the include and exclude patterns select the files', async () => {
  await inSite(
    siteWith(
      { 'docs/start.md': '# S\n', 'docs/drafts/wip.md': '# W\n', 'docs/.hidden.md': '# H\n', 'docs/a/b.md': '# B\n', 'docs/notes.txt': 'x', 'docs/Z.markdown': '# Z\n' },
      'docs:\n  source: { path: ../../../tool }\n  guides:\n    - { dir: docs, include: ["**/*.md", "**/*.markdown"], exclude: ["drafts/**", "a/*"] }\n',
    ),
    async (dir) => {
      const [result] = await build(dir);
      const sources = /** @type {import('../src/build.js').ManifestProject} */ (result.manifest.projects[0]).docs?.pages.map((page) => page.source);
      assert.deepEqual(sources, [null, 'docs/Z.markdown', 'docs/start.md']);
    },
  );
});

test('a guide that selects nothing fails the build instead of publishing empty documentation', async () => {
  await inSite(siteWith({ 'docs/notes.txt': 'x' }), async (dir) => {
    const errors = await errorsOf(dir);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /^tool:docs the guide "docs" selects no Markdown file \(include: \*\*\/\*\.md\)/);
  });
});

test('two files with the same address, or a reserved one, are located errors', async () => {
  await inSite(siteWith({ 'docs/a_b.md': '# One\n', 'docs/a-b.md': '# Two\n', 'docs/Reference.md': '# R\n', 'docs/search/page.md': '# S\n' }), async (dir) => {
    const errors = await errorsOf(dir);
    assert.ok(errors.includes('tool:docs/a_b.md has the same address as docs/a-b.md (a-b); rename one of the files'), errors.join('\n'));
    assert.ok(errors.some((error) => error.startsWith('tool:docs/Reference.md the address "reference" belongs to the documentation itself')), errors.join('\n'));
    assert.ok(errors.some((error) => error.startsWith('tool:docs/search/page.md the address "search/page" belongs to the documentation itself')), errors.join('\n'));
  });
});

test('a name from which no address can be made is an error', async () => {
  await inSite(siteWith({ 'docs/start.md': '# S\n', 'docs/привет.md': '# P\n' }), async (dir) => {
    const errors = await errorsOf(dir);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /^tool:docs\/привет\.md no address can be made from the path "привет\.md"/);
  });
});

test('order puts the named files first; a name that is not a published file is a warning', async () => {
  await inSite(
    siteWith(
      { 'docs/a.md': '# A\n', 'docs/b.md': '# B\n', 'docs/c.md': '# C\n' },
      'docs:\n  source: { path: ../../../tool }\n  guides:\n    - { dir: docs, order: [c.md, gone.md, a.md] }\n',
    ),
    async (dir) => {
      const [result] = await build(dir);
      assert.equal(sidebarOf(docsHtml(dir, 'a')), 'Documentation@/made/lathe/docs/|C@/made/lathe/docs/c/|A@/made/lathe/docs/a/|B@/made/lathe/docs/b/');
      assert.ok(result.warnings.some((message) => message === 'tool:docs: "order" lists "gone.md", which is not one of the published files of the guide'), result.warnings.join('\n'));
      assert.ok(reportOf(dir).warnings.length > 0);
    },
  );
});

test('several guides are listed one after the other; a file selected by two guides belongs to the first', async () => {
  await inSite(
    siteWith(
      { 'docs/one.md': '# One\n', 'more/two.md': '# Two\n', 'more/README.md': '# More\n', 'extra.md': '# Extra\n' },
      'docs:\n  source: { path: ../../../tool }\n  guides:\n    - { dir: docs }\n    - { dir: more }\n    - { dir: ".", include: ["docs/*.md", "extra.md"] }\n',
    ),
    async (dir) => {
      await build(dir);
      // The README of a later guide is an ordinary page; docs/one.md is not published twice.
      assert.equal(
        sidebarOf(docsHtml(dir, 'one')),
        'Documentation@/made/lathe/docs/|One@/made/lathe/docs/one/|More@/made/lathe/docs/readme/|Two@/made/lathe/docs/two/|Extra@/made/lathe/docs/extra/',
      );
      assert.equal(existsSync(join(dir, 'out', 'demo', 'made', 'lathe', 'docs', 'docs')), false);
    },
  );
});

test('the number and the size of the pages are bounded', async () => {
  /** @type {Record<string, string>} */
  const many = {};
  for (let index = 0; index <= MAX_GUIDE_PAGES; index += 1) many[`docs/p${index}.md`] = `# P${index}\n`;
  await inSite(siteWith(many), async (dir) => {
    const errors = await errorsOf(dir);
    assert.equal(errors.length, 1);
    assert.match(errors[0], new RegExp(`^tool: the guides select ${MAX_GUIDE_PAGES + 1} files; a project can publish at most ${MAX_GUIDE_PAGES} pages`));
  });
  await inSite(siteWith({ 'docs/start.md': '# S\n', 'docs/big.md': `# Big\n\n${'x'.repeat(MAX_GUIDE_FILE_BYTES)}\n` }), async (dir) => {
    const errors = await errorsOf(dir);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /^tool:docs\/big\.md the file is \d+ bytes; a guide can have at most 1048576 bytes$/);
  });
});

test('a guide folder that is a file, or that is gone, fails the build naming the project', async () => {
  await inSite(siteWith({ 'docs': 'not a folder' }), async (dir) => {
    await assert.rejects(build(dir), /project "lathe": .*the guide folder "docs" is not a folder/);
  });
  await inSite(siteWith({ 'other/x.md': '# X\n' }), async (dir) => {
    await assert.rejects(build(dir), /project "lathe": .*the guide folder "docs" does not exist in the source/);
  });
});

test('a docs block without guides publishes no page and no link, and a project without docs is unchanged', async () => {
  await inSite(siteWith({ 'docs/start.md': START }, 'docs:\n  source: { path: ../../../tool }\n  reference: { command: x }\n'), async (dir) => {
    const [result] = await build(dir);
    assert.deepEqual(/** @type {import('../src/build.js').ManifestProject} */ (result.manifest.projects[0]).docs?.pages, []);
    assert.doesNotMatch(readFileSync(join(dir, 'out', 'demo', 'made', 'lathe', 'index.html'), 'utf8'), /project-fact-docs/);
  });
});

test('urls.docs and urls.projects decide the address of the pages', async () => {
  await inSite(
    {
      ...siteWith({ 'docs/start.md': START, 'docs/usage.md': USAGE }),
      'coffer.yaml': SITE_CONFIG.replace('    projects:', '    urls: { projects: built, docs: manual }\n    projects:'),
    },
    async (dir) => {
      await build(dir);
      const html = readFileSync(join(dir, 'out', 'demo', 'built', 'lathe', 'manual', 'start', 'index.html'), 'utf8');
      assert.match(html, /<a href="\/built\/lathe\/manual\/usage\/#options">Usage<\/a>/);
      assert.match(html, /<li><a href="\/built\/">Projects<\/a><\/li>/);
    },
  );
});

// --- units ---------------------------------------------------------------------------------

test('the address on GitHub is made of encoded segments, with the anchor kept', () => {
  assert.equal(githubUrl({ github: 'o/r', ref: 'main', kind: 'blob', path: 'docs/My File #1.md' }), 'https://github.com/o/r/blob/main/docs/My%20File%20%231.md');
  assert.equal(githubUrl({ github: 'o/r', ref: 'feature/x y', kind: 'tree', path: '' }), 'https://github.com/o/r/tree/feature/x%20y');
  assert.equal(githubUrl({ github: 'o/r', ref: 'v1.0', kind: 'blob', path: 'a.md', fragment: '#L10-L20' }), 'https://github.com/o/r/blob/v1.0/a.md#L10-L20');
  assert.equal(githubUrl({ github: 'o/r', ref: 'main', kind: 'blob', path: 'a.md', fragment: '#"><b>' }), 'https://github.com/o/r/blob/main/a.md#%22%3E%3Cb%3E');
});

test('the ref of links: the configured one for git, the commit for a folder that is a repository of its own, else main', () => {
  const sha = 'c'.repeat(40);
  /** @param {import('../src/docs/sources.js').FetchedDocs['source']} source @param {string} dir */
  const fetched = (source, dir) => /** @type {import('../src/docs/sources.js').FetchedDocs} */ ({ slug: 'x', root: dir, source, github: 'o/r', guides: [] });
  assert.equal(githubRefOf(fetched({ type: 'git', git: 'https://example.org/o/r.git', ref: 'release/1', sha }, fixture)), 'release/1');
  assert.equal(githubRefOf(fetched({ type: 'path', path: 'x', sha, dirty: false }, fixture)), 'main');
  const dir = mkdtempSync(join(tmpdir(), 'coffer-ref-'));
  try {
    mkdirSync(join(dir, '.git'));
    assert.equal(githubRefOf(fetched({ type: 'path', path: 'x', sha, dirty: false }, dir)), sha);
    assert.equal(githubRefOf(fetched({ type: 'path', path: 'x', sha: null, dirty: null }, dir)), 'main');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('slugs and titles from file names', () => {
  assert.equal(slugOf('Getting_Started v2'), 'getting-started-v2');
  assert.equal(slugOf('--x--'), 'x');
  assert.equal(slugOf('привет'), '');
  assert.equal(titleFromName('getting-started.md'), 'Getting Started');
  assert.equal(titleFromName('FAQ.markdown'), 'FAQ');
});
