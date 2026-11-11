import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildSites } from '../src/build.js';
import { loadConfig } from '../src/config.js';
import { solidImage } from './helpers/images.js';

const NOW = new Date('2026-06-01T12:00:00Z');

/**
 * Writes a tree of files, runs `body` with its root, and removes the tree.
 *
 * @template T
 * @param {Record<string, string | Buffer>} files
 * @param {(root: string) => Promise<T>} body
 * @returns {Promise<T>}
 */
async function inTree(files, body) {
  const root = mkdtempSync(join(tmpdir(), 'coffer-full-'));
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
 * @param {string} blogExtra Extra keys of the blog entry (with a leading comma), such as `, index: full`.
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
 * @param {string} root
 * @returns {Promise<{ manifest: import('../src/build.js').Manifest, read: (file: string) => string }>}
 */
async function build(root) {
  const [result] = await buildSites(loadConfig({ configPath: join(root, 'coffer.yaml') }), { out: join(root, 'out'), now: NOW });
  return {
    manifest: result.manifest,
    read: (file) => readFileSync(join(result.outDir, ...file.split('/')), 'utf8'),
  };
}

/**
 * The inside of each list item of a list page.
 *
 * @param {string} html
 * @returns {string[]}
 */
function listItems(html) {
  return html.split('<li class="post-item">').slice(1);
}

const FENCE = '```';

const alpha = [
  '---',
  'title: Alpha',
  'date: 2025-03-03',
  'summary: Alpha summary text.',
  'tags: [trips/alps]',
  '---',
  '',
  'Alpha opening words.',
  '',
  '## Alpha section',
  '',
  'Alpha section words, see [the section](#alpha-section).',
  '',
  `${FENCE}js`,
  'const alphaCode = 1;',
  FENCE,
  '',
  '| Name | Value |',
  '| --- | --- |',
  '| alphaCell | 1 |',
  '',
].join('\n');

const beta = [
  '---',
  'title: Beta',
  'date: 2025-02-02',
  'summary: Beta summary text.',
  '---',
  '',
  'Beta opening words.',
  '',
  '## Beta section',
  '',
  'Beta footnote.[^1]',
  '',
  '[^1]: Beta note.',
  '',
].join('\n');

const gamma = [
  '---',
  'title: Gamma',
  'date: 2025-01-01',
  'summary: Gamma summary text.',
  'index: summary',
  '---',
  '',
  'Gamma body words.',
  '',
].join('\n');

const posts = { 'notes/alpha.md': alpha, 'notes/beta.md': beta, 'notes/gamma.md': gamma };

test('index: full lists title, meta, tags and the whole body of each full post on the blog index', async () => {
  await inTree({ 'coffer.yaml': configYaml(', index: full'), ...posts }, async (root) => {
    const { read, manifest } = await build(root);
    const page = read('log/index.html');
    const items = listItems(page);
    assert.equal(items.length, 3);
    const [first = '', second = '', third = ''] = items;

    assert.match(first, /<h2><a href="\/log\/alpha\/">Alpha<\/a><\/h2>/);
    assert.match(first, /<time datetime="2025-03-03">/);
    assert.match(first, /class="reading-time"/);
    assert.match(first, /<ul class="post-tags"[\s\S]*<a href="\/log\/tags\/trips\/alps\/">/);
    assert.match(first, /<div class="post-body">[\s\S]*Alpha opening words\./);
    assert.match(first, /alphaCode/);
    assert.match(first, /alphaCell/);
    assert.match(first, /<h3 id="alpha-alpha-section">/, 'the body h2 is an h3 with the slug in its id');
    assert.doesNotMatch(first, /<h2 id=/);
    assert.match(first, /href="#alpha-alpha-section"/, 'the link to the heading follows its id');

    assert.match(second, /Beta opening words\./);
    assert.match(second, /<h3 id="beta-beta-section">/);
    assert.match(second, /id="beta-[^"]*fn[^"]*"/, 'the footnote ids carry the slug');
    assert.doesNotMatch(second, /Alpha opening words/);

    assert.match(third, /<p class="post-summary">Gamma summary text\.<\/p>/, 'a post with index: summary keeps its summary');
    assert.doesNotMatch(third, /post-body|Gamma body words/);

    const ids = [...page.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
    assert.equal(new Set(ids).size, ids.length, 'no id twice on the page');
    assert.deepEqual(manifest.posts.map((entry) => entry.index).sort(), ['full', 'full', 'summary']);
  });
});

test('index: full pages leave out the table of contents, series box, project blocks and share summary', async () => {
  const part = (/** @type {string} */ title, /** @type {string} */ date, /** @type {string} */ body) =>
    `---\ntitle: ${title}\ndate: ${date}\ntags: [trips]\nseries: tour\n---\n\n${body}\n`;
  await inTree(
    {
      'coffer.yaml': configYaml(', index: full, shareSummary: true'),
      'notes/part-one.md': part('Part one', '2025-03-03', 'Part one words.\n\n## First heading\n\nx\n\n## Second heading\n\ny\n\n## Third heading\n\nz\n\n## Fourth heading\n\nw'),
      'notes/part-two.md': part('Part two', '2025-03-04', 'Part two words.'),
    },
    async (root) => {
      const { read } = await build(root);
      const post = read('log/part-one/index.html');
      assert.match(post, /class="toc"/, 'the post page has its table of contents');
      assert.match(post, /class="series-nav/);
      assert.match(post, /class="share"/);
      for (const file of ['log/index.html', 'log/tags/trips/index.html', 'log/series/tour/index.html']) {
        const html = read(file);
        assert.match(html, /Part one words\./, file);
        assert.match(html, /Part two words\./, file);
        assert.match(html, /<h3 id="part-one-first-heading">/, file);
        assert.doesNotMatch(html, /class="toc"|class="series-nav|class="share"|project-block/, file);
      }
    },
  );
});

test('index: summary output is the same with and without the setting', async () => {
  let plain = '';
  let explicit = '';
  await inTree({ 'coffer.yaml': configYaml(), ...posts }, async (root) => {
    plain = (await build(root)).read('log/index.html');
  });
  await inTree({ 'coffer.yaml': configYaml(', index: summary'), ...posts }, async (root) => {
    explicit = (await build(root)).read('log/index.html');
  });
  assert.equal(plain, explicit);
  assert.doesNotMatch(plain, /post-body|Alpha opening words|post-tags/);
  assert.match(plain, /<p class="post-summary">Alpha summary text\.<\/p>/);
  assert.match(plain, /<p class="post-summary">Beta summary text\.<\/p>/);
});

test('a post with index: full on a summary blog is shown in full', async () => {
  await inTree(
    { 'coffer.yaml': configYaml(), 'notes/alpha.md': alpha.replace('summary: Alpha', 'index: full\nsummary: Alpha'), 'notes/beta.md': beta },
    async (root) => {
      const [first = '', second = ''] = listItems((await build(root)).read('log/index.html'));
      assert.match(first, /Alpha opening words\./);
      assert.match(second, /<p class="post-summary">Beta summary text\.<\/p>/);
      assert.doesNotMatch(second, /Beta opening words/);
    },
  );
});

test('the summary of a full post still feeds the description and the card of its page', async () => {
  await inTree({ 'coffer.yaml': configYaml(', index: full'), ...posts }, async (root) => {
    const { read } = await build(root);
    const page = read('log/alpha/index.html');
    assert.match(page, /<meta name="description" content="Alpha summary text\.">/);
    assert.match(page, /<meta property="og:description" content="Alpha summary text\.">/);
    assert.match(page, /<meta name="twitter:description" content="Alpha summary text\.">/);
    // The post page itself is neither shifted nor prefixed.
    assert.match(page, /<h2 id="alpha-section">/);
    assert.doesNotMatch(read('log/index.html'), /<meta name="description" content="Alpha summary text/);
  });
});

test('the image of a full post is processed once and has the same files on the index as on its page', async () => {
  const picture = await solidImage(1200, 800, 'jpeg');
  await inTree(
    {
      'coffer.yaml': configYaml(', index: full'),
      'notes/photo/index.md': '---\ntitle: Photo\ndate: 2025-05-05\n---\n\n![A blue field](field.jpg)\n\nPhoto words.\n',
      'notes/photo/field.jpg': picture,
    },
    async (root) => {
      const { read, manifest } = await build(root);
      const sources = (/** @type {string} */ html) => [...html.matchAll(/srcset="([^"]+)"/g)].map((match) => match[1]);
      const onPage = sources(read('log/photo/index.html'));
      assert.ok(onPage.length > 0, 'the post page has a responsive picture');
      assert.deepEqual(sources(read('log/index.html')), onPage);
      assert.equal(manifest.images.length, 1, 'the image is listed once');
    },
  );
});

/**
 * @param {string} title
 * @param {string} date
 * @param {string} extra Extra front matter lines.
 * @param {string} body
 * @returns {string}
 */
function tagged(title, date, extra, body) {
  return `---\ntitle: ${title}\ndate: ${date}\ntags: [trips]\nseries: tour\n${extra}---\n\n${body}\n`;
}

const mixedPosts = {
  'notes/one.md': tagged('One', '2025-03-01', '', 'One body words.\n\n## Shared heading\n\nOne note.[^1]\n\n[^1]: One footnote.'),
  'notes/two.md': tagged('Two', '2025-03-02', '', 'Two body words.\n\n## Shared heading\n\nTwo note.[^1]\n\n[^1]: Two footnote.'),
  'notes/three.md': tagged('Three', '2025-03-03', 'summary: Three summary text.\nindex: summary\n', 'Three body words.'),
  'notes/four.md': tagged('Four', '2025-03-04', 'index: summary\n', 'Four body words.'),
};

test('tag and series pages of a full blog show the whole body and unique ids, with per-post summary overrides', async () => {
  await inTree({ 'coffer.yaml': configYaml(', index: full'), ...mixedPosts }, async (root) => {
    const { read } = await build(root);
    for (const file of ['log/tags/trips/index.html', 'log/series/tour/index.html']) {
      const page = read(file);
      const items = listItems(page);
      assert.equal(items.length, 4, file);
      const item = (/** @type {string} */ title) =>
        items.find((html) => html.includes(`>${title}</a></h2>`)) ?? assert.fail(`${file}: no item for ${title}`);

      for (const [title, words] of [['One', 'One body words.'], ['Two', 'Two body words.']]) {
        const html = item(/** @type {string} */ (title));
        assert.match(html, /<div class="post-body">/, `${file} ${title}`);
        assert.match(html, new RegExp(/** @type {string} */ (words).replace('.', '\.')), `${file} ${title}`);
      }

      const three = item('Three');
      assert.match(three, /<time datetime="2025-03-03">/, file);
      assert.match(three, /class="reading-time"/, file);
      assert.match(three, /<p class="post-summary">Three summary text\.<\/p>/, file);
      assert.doesNotMatch(three, /post-body|Three body words/, file);

      const four = item('Four');
      assert.match(four, /<time datetime="2025-03-04">/, file);
      assert.doesNotMatch(four, /post-summary|post-body|Four body words/, file);

      const ids = [...page.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
      assert.ok(ids.includes('one-shared-heading') && ids.includes('two-shared-heading'), file);
      assert.equal(new Set(ids).size, ids.length, `${file}: no id twice`);
    }
  });
});

test('a post with index: full is shown in full on tag and series pages of a summary blog', async () => {
  await inTree(
    {
      'coffer.yaml': configYaml(),
      'notes/one.md': tagged('One', '2025-03-01', 'index: full\n', 'One body words.'),
      'notes/two.md': tagged('Two', '2025-03-02', 'summary: Two summary text.\n', 'Two body words.'),
    },
    async (root) => {
      const { read } = await build(root);
      for (const file of ['log/tags/trips/index.html', 'log/series/tour/index.html']) {
        const page = read(file);
        assert.match(page, /One body words\./, file);
        assert.match(page, /<p class="post-summary">Two summary text\.<\/p>/, file);
        assert.doesNotMatch(page, /Two body words/, file);
      }
    },
  );
});
