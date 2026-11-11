import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildSites } from '../src/build.js';
import { loadConfig } from '../src/config.js';
import { solidImage } from './helpers/images.js';

const NOW = new Date('2026-06-01T12:00:00Z');
const FENCE = '```';

/** The list pages of the blog: its index, a tag page and a series page. */
const LIST_PAGES = ['log/index.html', 'log/tags/trips/index.html', 'log/series/tour/index.html'];

/**
 * Writes a tree of files, runs `body` with its root, and removes the tree.
 *
 * @template T
 * @param {Record<string, string | Buffer>} files
 * @param {(root: string) => Promise<T>} body
 * @returns {Promise<T>}
 */
async function inTree(files, body) {
  const root = mkdtempSync(join(tmpdir(), 'coffer-lists-'));
  try {
    for (const [name, content] of Object.entries(files)) {
      const target = join(root, ...name.split('/'));
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, content);
    }
    return await body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * @param {string} blogExtra Extra keys of the blog entry (with a leading comma).
 * @returns {string}
 */
function configYaml(blogExtra = '') {
  return [
    'sites:',
    '  - id: demo',
    '    baseUrl: https://demo.example',
    '    lang: en',
    '    title: Demo',
    '    contentDir: .',
    '    contentLicense: Some rights reserved',
    '    blogs:',
    `      - { id: notes, dir: notes, prefix: log, title: Notes${blogExtra} }`,
    '',
  ].join('\n');
}

/**
 * Builds the tree and returns the HTML of the list pages and of the post pages.
 *
 * @param {string} root
 * @returns {Promise<Record<string, string>>}
 */
async function buildPages(root) {
  const [result] = await buildSites(loadConfig({ configPath: join(root, 'coffer.yaml') }), { out: join(root, 'out'), now: NOW });
  const pages = [...LIST_PAGES, 'log/photos/index.html', 'log/code/index.html', 'log/tour-one/index.html'];
  return Object.fromEntries(pages.map((file) => [file, readFileSync(join(result.outDir, ...file.split('/')), 'utf8')]));
}

/** @returns {Promise<Record<string, string | Buffer>>} */
async function blogFiles() {
  return {
    'notes/photos/index.md': [
      '---',
      'title: Photos',
      'date: 2025-03-03',
      'tags: [trips]',
      '---',
      '',
      'Photos opening words.',
      '',
      '![A blue field](field.jpg)',
      '',
      '## Photos heading',
      '',
      'Photos closing words.',
      '',
    ].join('\n'),
    'notes/photos/field.jpg': await solidImage(1200, 800, 'jpeg'),
    'notes/code.md': [
      '---',
      'title: Code',
      'date: 2025-02-02',
      'tags: [trips]',
      '---',
      '',
      'Code opening words.',
      '',
      '## First code heading',
      '',
      `${FENCE}js`,
      'const codeSample = 1;',
      FENCE,
      '',
      '## Second code heading',
      '',
      'Second code words.',
      '',
      '## Third code heading',
      '',
      'Third code words.',
      '',
      '## Fourth code heading',
      '',
      'Fourth code words, see [the first one](#first-code-heading).',
      '',
    ].join('\n'),
    'notes/tour-one.md': [
      '---',
      'title: Tour one',
      'date: 2025-01-01',
      'tags: [trips]',
      'series: tour',
      '---',
      '',
      'Tour opening words.',
      '',
      '## Tour heading',
      '',
      'Tour note.[^1]',
      '',
      '[^1]: Tour footnote words.',
      '',
    ].join('\n'),
  };
}

/** The slug of each post and a phrase from the end of its body. */
const BODY_TEXT = [
  ['photos', 'Photos closing words.'],
  ['code', 'Fourth code words'],
  ['tour-one', 'Tour footnote words.'],
];

test('index: full - blog index, tag page and series page carry every listed body, shifted headings and unique ids', async () => {
  await inTree({ 'coffer.yaml': configYaml(', index: full'), ...(await blogFiles()) }, async (root) => {
    const pages = await buildPages(root);

    // The post page itself is not shifted, and has its table of contents.
    assert.match(pages['log/code/index.html'] ?? '', /class="toc"/);
    assert.match(pages['log/code/index.html'] ?? '', /<h2 id="first-code-heading">/);

    /** @type {Record<string, string[]>} */
    const listed = {
      'log/index.html': ['photos', 'code', 'tour-one'],
      'log/tags/trips/index.html': ['photos', 'code', 'tour-one'],
      'log/series/tour/index.html': ['tour-one'],
    };
    for (const [file, slugs] of Object.entries(listed)) {
      const html = pages[file] ?? assert.fail(`${file} was not built`);
      for (const [slug = '', text = ''] of BODY_TEXT) {
        assert.equal(html.includes(text), slugs.includes(slug), `${file}: body of ${slug}`);
      }

      const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
      assert.ok(ids.length > 0, `${file} has ids`);
      assert.equal(new Set(ids).size, ids.length, `${file}: no id twice (${ids.join(', ')})`);

      // One h1 (the page), post titles h2, body headings h3.
      assert.equal((html.match(/<h1[\s>]/g) ?? []).length, 1, `${file}: one h1`);
      assert.doesNotMatch(html, /<h2 id=/, `${file}: no body heading stays at h2`);
      assert.doesNotMatch(html, /class="toc"/, `${file}: no table of contents`);
    }

    const index = pages['log/index.html'] ?? '';
    assert.match(index, /<h3 id="photos-photos-heading">/);
    assert.match(index, /<h3 id="code-first-code-heading">/);
    assert.match(index, /<h3 id="tour-one-tour-heading">/);
    assert.match(index, /href="#code-first-code-heading"/, 'an in-post link follows the prefixed id');
    assert.match(index, /codeSample/);
    assert.match(index, /srcset="[^"]+"/, 'the picture is on the page');
  });
});

test('index: summary gives the same pages as a blog without the setting', async () => {
  const files = { 'coffer.yaml': configYaml(), ...(await blogFiles()) };
  /** @type {Record<string, string>} */
  let plain = {};
  /** @type {Record<string, string>} */
  let explicit = {};
  await inTree(files, async (root) => {
    plain = await buildPages(root);
  });
  await inTree({ ...files, 'coffer.yaml': configYaml(', index: summary') }, async (root) => {
    explicit = await buildPages(root);
  });
  assert.deepEqual(explicit, plain);
  for (const file of LIST_PAGES) {
    assert.doesNotMatch(plain[file] ?? '', /post-body|Photos closing words|codeSample/, `${file} lists summaries only`);
  }
});
