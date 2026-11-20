import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildSites } from '../src/build.js';
import { loadConfig } from '../src/config.js';

const NOW = new Date('2026-06-01T12:00:00Z');
const offline = async () => new Response('', { status: 404 });

/**
 * @template T
 * @param {Record<string, string>} files
 * @param {(root: string) => Promise<T>} body
 * @returns {Promise<T>}
 */
async function inTree(files, body) {
  const root = mkdtempSync(join(tmpdir(), 'coffer-typography-build-'));
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

const config = (extra = '') =>
  [
    'sites:',
    '  - id: demo',
    '    baseUrl: https://demo.example',
    '    lang: en',
    '    title: Demo',
    '    contentLicense: Some rights reserved',
    '    contentDir: notes',
    extra,
    '    blogs:',
    '      - { id: notes, dir: notes, prefix: log, title: Notes }',
    '',
  ].join('\n');

/**
 * @param {string} root
 * @returns {Promise<{ out: string, warnings: string[] }>}
 */
async function build(root) {
  const [result] = await buildSites(loadConfig({ configPath: join(root, 'coffer.yaml') }), {
    out: join(root, 'out'),
    now: NOW,
    videoFetch: { fetch: offline },
  });
  return { out: result.outDir, warnings: result.warnings };
}

/**
 * @param {string} body
 * @param {string} [extra]
 * @param {string} [title]
 */
const post = (body, extra = '', title = 'Glue-up') => `---\ntitle: ${title}\ndate: 2026-05-01\n${extra}---\n\n${body}\n`;
/**
 * @param {string} out
 * @param {...string} parts
 */
const read =(out, ...parts) => readFileSync(join(out, ...parts), 'utf8');

test('a post is typeset by default: curly quotes and en rules', async () => {
  await inTree({ 'coffer.yaml': config(), 'notes/a.md': post('She said "hi" -- then left. Pages 1-5.') }, async (root) => {
    const { out } = await build(root);
    const html = read(out, 'log', 'a', 'index.html');
    assert.match(html, /She said “hi” – then left\. Pages 1–5\./);
  });
});

test('typography: false in front matter leaves the post as typed', async () => {
  await inTree({ 'coffer.yaml': config(), 'notes/a.md': post('She said "hi" -- then left.', 'typography: false\n') }, async (root) => {
    const { out, warnings } = await build(root);
    const html = read(out, 'log', 'a', 'index.html');
    assert.match(html, /She said &#x22;hi&#x22; -- then left\.|She said "hi" -- then left\./);
    assert.ok(!html.includes('“'));
    assert.deepEqual(warnings, []);
  });
});

test('a post with lang: ru uses ru rules and sets lang on its article when the site is en', async () => {
  await inTree(
    {
      'coffer.yaml': config(),
      'notes/ru.md': post('Он сказал "привет" и ушёл.', 'lang: ru\n'),
      'notes/en.md': post('He said "hi".'),
    },
    async (root) => {
      const { out } = await build(root);
      const ru = read(out, 'log', 'ru', 'index.html');
      assert.match(ru, /«привет»/);
      assert.match(ru, /<article class="post" lang="ru">/);
      const en = read(out, 'log', 'en', 'index.html');
      assert.match(en, /“hi”/);
      assert.match(en, /<article class="post">/);
    },
  );
});

test('the site typography setting turns typography off for every post', async () => {
  await inTree({ 'coffer.yaml': config('    typography: { enabled: false }'), 'notes/a.md': post('He said "hi".') }, async (root) => {
    const { out } = await build(root);
    assert.ok(!read(out, 'log', 'a', 'index.html').includes('“'));
  });
});

test('the title of a post is typeset in the page body but not in <title>', async () => {
  await inTree({ 'coffer.yaml': config(), 'notes/a.md': post('Text.', '', "'The \"box\" of Tools'") }, async (root) => {
    const { out } = await build(root);
    const html = read(out, 'log', 'a', 'index.html');
    assert.match(html, /<h1>[^<]*“[^<]*<\/h1>/);
    assert.match(html, /<title>The &quot;box&quot; of Tools/);
  });
});

test('an unpaired quote is a warning with file and line', async () => {
  await inTree({ 'coffer.yaml': config(), 'notes/a.md': post('One line.\n\nHe said "oops and left.') }, async (root) => {
    const { warnings } = await build(root);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /^notes\/a\.md:8: .*unpaired quote "/);
  });
});

test('blog-level lang and typography override the site', async () => {
  /** @param {string} entry */
  const blogs = (entry) => config().replace(/    blogs:\n.*\n/, `    blogs:\n      - { id: notes, dir: notes, prefix: log, title: Notes, ${entry} }\n`);
  await inTree({ 'coffer.yaml': blogs('lang: ru'), 'notes/a.md': post('Он сказал "привет".') }, async (root) => {
    const { out } = await build(root);
    const html = read(out, 'log', 'a', 'index.html');
    assert.match(html, /«привет»/);
    assert.match(html, /<article class="post" lang="ru">/);
  });
  await inTree({ 'coffer.yaml': blogs('typography: { enabled: false }'), 'notes/a.md': post('He said "hi".') }, async (root) => {
    const { out } = await build(root);
    assert.ok(!read(out, 'log', 'a', 'index.html').includes('“'));
  });
});

test('an unpaired quote in the home file is a warning with file and line', async () => {
  await inTree(
    { 'coffer.yaml': config().replace('contentDir: notes', 'contentDir: content'), 'notes/a.md': post('Text.'), 'content/home.md': '---\ntitle: Demo\n---\n\nAbout.\n\nHe said "oops.\n' },
    async (root) => {
      const { warnings } = await build(root);
      assert.ok(warnings.some((w) => /home\.md:\d+: .*unpaired quote/.test(w)), warnings.join('\n'));
    },
  );
});

test('the blog title on the blog index is typeset in the body', async () => {
  await inTree({ 'coffer.yaml': config().replace('title: Notes', 'title: \'The "Notes"\''), 'notes/a.md': post('Text.') }, async (root) => {
    const { out } = await build(root);
    assert.match(read(out, 'log', 'index.html'), /<h1>The “Notes”<\/h1>/);
  });
});
