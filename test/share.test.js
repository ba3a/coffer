import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Script, createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';

import { BuildError, buildSites } from '../src/build.js';
import { ConfigError, loadConfig, normalizeConfig } from '../src/config.js';
import { loadStrings } from '../src/render/i18n.js';
import { SHARE_FILE_NAME, hashtagsFor, renderShareText, shareUrlFor } from '../src/share.js';
import { openSearch } from './helpers/pagefind.js';

const assetsDir = fileURLToPath(new URL('../theme/assets/', import.meta.url));

const NOW = new Date('2026-06-01T12:00:00Z');

/**
 * Writes a tree of files, runs `body` with its root, and removes the tree.
 *
 * @template T
 * @param {Record<string, string>} files Relative path (forward slashes) to content.
 * @param {(root: string) => Promise<T>} body
 * @returns {Promise<T>}
 */
async function inTree(files, body) {
  const root = mkdtempSync(join(tmpdir(), 'coffer-share-'));
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
 * @param {string} root
 * @returns {Promise<import('../src/build.js').SiteResult>}
 */
async function build(root) {
  const [result] = await buildSites(loadConfig({ configPath: join(root, 'coffer.yaml') }), {
    out: join(root, 'out'),
    now: NOW,
  });
  return result;
}

/**
 * @param {string} blog The entry of the `blogs:` list, as a flow mapping.
 * @param {string} [lang]
 * @returns {string}
 */
function config(blog, lang = 'en') {
  return `sites:\n  - id: demo\n    baseUrl: https://demo.example\n    lang: ${lang}\n    title: Demo\n    blogs:\n      - ${blog}\n`;
}

const ON = '{ id: notes, dir: notes, prefix: log, title: Notes, shareSummary: true }';
const OFF = '{ id: notes, dir: notes, prefix: log, title: Notes }';

const DOVETAIL = `---
title: A "tricky" <b>dovetail</b> & more
date: 2026-04-20
summary: Cutting the joint by hand, with a saw & a chisel.
tags: [hand-tools, joinery/dovetails, "2026"]
---

Zanzibarian words only the body has.
`;

test('hashtags are made of the words of the tag names', () => {
  assert.deepEqual(hashtagsFor(['Hand tools', 'hand-tools', 'dovetails', '2026', 'C++', 'iOS dev', 'Горы', 'сборка мебели', '!!!']), [
    '#HandTools',
    '#Dovetails',
    '#C',
    '#iOSDev',
    '#Горы',
    '#СборкаМебели',
  ]);
  assert.deepEqual(hashtagsFor([]), []);
});

test('the share text is title, summary, address and hashtags, each a paragraph', () => {
  const text = renderShareText({
    baseUrl: 'https://demo.example/',
    url: '/log/hello/',
    title: 'Hello\nworld',
    summary: '  A  summary\twith   odd white space. ',
    hashtags: ['#One', '#Two'],
  });
  assert.equal(text, 'Hello world\n\nA summary with odd white space.\n\nhttps://demo.example/log/hello/\n\n#One #Two\n');
  assert.equal(
    renderShareText({ baseUrl: 'https://demo.example', url: '/log/hello/', title: 'T', summary: '' }),
    'T\n\nhttps://demo.example/log/hello/\n',
    'an empty summary and no hashtags leave no empty paragraph',
  );
  assert.equal(shareUrlFor('/log/hello/'), `/log/hello/${SHARE_FILE_NAME}`);
});

test('the blog options are validated and off by default', () => {
  const blogOf = (/** @type {Record<string, unknown>} */ blog) =>
    normalizeConfig(
      { sites: [{ id: 'a', baseUrl: 'https://a.example', title: 'A', blogs: [{ id: 'b', ...blog }] }] },
      { file: resolve('/work/coffer.yaml') },
    ).sites[0].blogs[0];
  assert.equal(blogOf({}).shareSummary, undefined);
  assert.equal(blogOf({ shareSummary: false }).shareSummary, undefined);
  assert.equal(blogOf({ shareSummary: true }).shareSummary, true);
  assert.equal(blogOf({ shareSummary: true }).shareHashtags, undefined);
  assert.equal(blogOf({ shareSummary: true, shareHashtags: true }).shareHashtags, true);
  assert.throws(
    () => blogOf({ shareSummary: 'yes' }),
    (error) => error instanceof ConfigError && error.errors.some((message) => /blogs\[0\]\.shareSummary: must be true or false/.test(message)),
  );
  assert.throws(
    () => blogOf({ shareHashtags: true }),
    (error) =>
      error instanceof ConfigError &&
      error.errors.some((message) => /shareHashtags: only has an effect together with "shareSummary: true"/.test(message)),
  );
});

test('a blog with shareSummary: true gives every post a share.txt and a collapsed block', async () => {
  const plainPost = '---\ntitle: Plain\ndate: 2026-04-21\n---\n\nNo summary here, just a few words to take an excerpt from.\n';
  await inTree({ 'coffer.yaml': config(ON), 'notes/dovetail.md': DOVETAIL, 'notes/plain/index.md': plainPost }, async (root) => {
    const result = await build(root);

    const text = readFileSync(join(result.outDir, 'log', 'dovetail', 'share.txt'), 'utf8');
    assert.equal(
      text,
      'A "tricky" <b>dovetail</b> & more\n\nCutting the joint by hand, with a saw & a chisel.\n\nhttps://demo.example/log/dovetail/\n',
      'the title, the summary and the canonical address, as plain text',
    );
    assert.ok(!text.includes('\r'));
    assert.ok(!text.includes('#'), 'no hashtags unless asked for');
    const plain = readFileSync(join(result.outDir, 'log', 'plain', 'share.txt'), 'utf8');
    assert.equal(plain, 'Plain\n\nNo summary here, just a few words to take an excerpt from.\n\nhttps://demo.example/log/plain/\n');

    const html = readFileSync(join(result.outDir, 'log', 'dovetail', 'index.html'), 'utf8');
    // Collapsed by default, ignored by the search index, the last thing in the article.
    const details = /<details class="share" data-pagefind-ignore>[\s\S]*?<\/details>/.exec(html)?.[0] ?? '';
    assert.ok(details !== '', 'the share block is in the page');
    assert.ok(!/<details[^>]*\sopen[\s>]/.test(details), 'it is collapsed');
    assert.ok(details.includes('<summary>Share summary</summary>'));
    assert.ok(html.indexOf(details) > html.indexOf('class="post-body"'), 'after the body of the post');
    assert.equal(html.slice(html.indexOf(details) + details.length, html.indexOf('</article>')).trim(), '', 'nothing of the post follows it');

    // The same text, escaped, in a <pre>.
    const pre = /<pre class="share-text"[^>]*>([\s\S]*?)<\/pre>/.exec(details)?.[1] ?? '';
    assert.equal(
      pre,
      'A &quot;tricky&quot; &lt;b&gt;dovetail&lt;/b&gt; &amp; more\n\nCutting the joint by hand, with a saw &amp; a chisel.\n\nhttps://demo.example/log/dovetail/\n',
    );
    assert.ok(!details.includes('<b>'), 'markup in the title never reaches the page');

    // The copy button is hidden until the script shows it; there is no inline script in the block.
    assert.match(details, /<button type="button" class="share-copy" hidden /);
    assert.ok(!/<script/i.test(details));
    assert.ok(!/\sonclick=/i.test(details));
    assert.ok(html.includes('<script src="/assets/share.js" defer></script>'));
    assert.ok(existsSync(join(result.outDir, 'assets', 'share.js')));
    assert.ok(details.includes('<a class="share-download" href="/log/dovetail/share.txt" download>Download as text file</a>'));

    // The manifest lists the file as an output of the post.
    const entry = result.manifest.posts.find((post) => post.slug === 'dovetail');
    assert.deepEqual(entry?.share, { url: '/log/dovetail/share.txt', file: 'log/dovetail/share.txt' });
    const written = JSON.parse(readFileSync(join(result.outDir, '.coffer-manifest.json'), 'utf8'));
    assert.equal(written.posts.find((/** @type {{ slug: string }} */ post) => post.slug === 'plain').share.file, 'log/plain/share.txt');
  });
});

test('the share text stays out of the sitemap, the feeds and the search index', async () => {
  await inTree({ 'coffer.yaml': config(ON), 'notes/dovetail.md': DOVETAIL }, async (root) => {
    const result = await build(root);
    const sitemap = readFileSync(join(result.outDir, 'sitemap.xml'), 'utf8');
    assert.ok(!sitemap.includes('share.txt'));
    assert.ok(!result.manifest.sitemap.some((url) => url.includes('share.txt')));
    assert.ok(sitemap.includes('https://demo.example/log/dovetail/'), 'the post itself is still listed');
    assert.ok(!result.manifest.pages.some((page) => page.url.includes('share.txt') || page.file.endsWith('share.txt')));
    assert.ok(result.manifest.feeds.length > 0);
    for (const feed of result.manifest.feeds) {
      const xml = readFileSync(join(result.outDir, ...feed.url.slice(1).split('/')), 'utf8');
      assert.ok(!xml.includes('share.txt'));
      assert.ok(!xml.includes('Share summary'));
    }

    // The block is outside the marked body and marked to be ignored; its words are not in the index.
    const html = readFileSync(join(result.outDir, 'log', 'dovetail', 'index.html'), 'utf8');
    assert.ok(html.indexOf('data-pagefind-body') < html.indexOf('class="share"'));
    const search = await openSearch(result.outDir);
    assert.deepEqual((await search.search('Zanzibarian', { blog: 'notes' })).map((hit) => hit.url), ['/log/dovetail/']);
    assert.deepEqual(await search.search('Download', { blog: 'notes' }), [], 'the words of the block are not searchable');
    assert.deepEqual(await search.search('ready to copy', { blog: 'notes' }), []);
  });
});

test('shareHashtags adds hashtags made from the tags', async () => {
  await inTree(
    { 'coffer.yaml': config('{ id: notes, dir: notes, prefix: log, title: Notes, shareSummary: true, shareHashtags: true }'), 'notes/dovetail.md': DOVETAIL, 'notes/tags.yaml': 'hand-tools:\n  name: Hand tools\n' },
    async (root) => {
      const result = await build(root);
      const text = readFileSync(join(result.outDir, 'log', 'dovetail', 'share.txt'), 'utf8');
      assert.ok(text.endsWith('https://demo.example/log/dovetail/\n\n#HandTools #Dovetails\n'), text);
    },
  );
});

test('with shareSummary off nothing is rendered or written', async () => {
  for (const blog of [OFF, '{ id: notes, dir: notes, prefix: log, title: Notes, shareSummary: false }']) {
    await inTree({ 'coffer.yaml': config(blog), 'notes/dovetail.md': DOVETAIL }, async (root) => {
      const result = await build(root);
      assert.ok(!existsSync(join(result.outDir, 'log', 'dovetail', 'share.txt')));
      const html = readFileSync(join(result.outDir, 'log', 'dovetail', 'index.html'), 'utf8');
      assert.ok(!html.includes('class="share'));
      assert.ok(!html.includes('<details'));
      assert.ok(!html.includes('share.js'));
      assert.deepEqual(result.manifest.posts.map((post) => post.share), [null]);
    });
  }
});

test('the option is per blog', async () => {
  await inTree(
    {
      'coffer.yaml': `sites:\n  - id: demo\n    baseUrl: https://demo.example\n    title: Demo\n    blogs:\n      - { id: a, dir: a, prefix: a, shareSummary: true }\n      - { id: b, dir: b, prefix: b }\n`,
      'a/one.md': '---\ntitle: One\ndate: 2026-04-20\n---\n\nText.\n',
      'b/two.md': '---\ntitle: Two\ndate: 2026-04-20\n---\n\nText.\n',
    },
    async (root) => {
      const result = await build(root);
      assert.ok(existsSync(join(result.outDir, 'a', 'one', 'share.txt')));
      assert.ok(!existsSync(join(result.outDir, 'b', 'two', 'share.txt')));
    },
  );
});

test('a Russian site gets the block in Russian', async () => {
  const post = '---\ntitle: Шкатулка\ndate: 2026-04-20\nsummary: Про шкатулку.\n---\n\nТекст.\n';
  await inTree({ 'coffer.yaml': config(ON, 'ru'), 'notes/post.md': post }, async (root) => {
    const result = await build(root);
    const html = readFileSync(join(result.outDir, 'log', 'post', 'index.html'), 'utf8');
    assert.ok(html.includes('<summary>Текст для публикации</summary>'));
    assert.ok(html.includes('>Копировать</button>'));
    assert.equal(readFileSync(join(result.outDir, 'log', 'post', 'share.txt'), 'utf8'), 'Шкатулка\n\nПро шкатулку.\n\nhttps://demo.example/log/post/\n');
  });
});

test('a file named share.txt in the folder of a post fails the build, naming it', async () => {
  const files = {
    'notes/dovetail/index.md': DOVETAIL,
    'notes/dovetail/share.txt': 'my own text\n',
  };
  await inTree({ 'coffer.yaml': config(ON), ...files }, async (root) => {
    await assert.rejects(
      build(root),
      (error) =>
        error instanceof BuildError &&
        /notes[\\/]dovetail[\\/]index\.md: the file "share\.txt" in the folder of the post would collide with the share summary/.test(error.message) &&
        /\/log\/dovetail\/share\.txt/.test(error.message),
    );
  });
  // Without the option nothing is written there, so the file is no problem.
  await inTree({ 'coffer.yaml': config(OFF), ...files }, async (root) => {
    const result = await build(root);
    assert.ok(!existsSync(join(result.outDir, 'log', 'dovetail', 'share.txt')));
  });
});

test('both i18n files have the same strings for the share block', () => {
  const en = loadStrings('en').strings;
  const ru = loadStrings('ru').strings;
  for (const key of ['title', 'hint', 'copy', 'copied', 'failed', 'download']) {
    assert.ok(en.has(`share.${key}`), `en has share.${key}`);
    assert.ok(ru.has(`share.${key}`), `ru has share.${key}`);
    assert.notDeepEqual(en.get(`share.${key}`), ru.get(`share.${key}`));
  }
});

/**
 * Runs the share script of the theme on a page of one share block made of fakes.
 *
 * @param {{ clipboard?: 'works' | 'fails' | 'missing', execCommand?: boolean }} setup
 */
function runScript(setup) {
  const listeners = /** @type {(() => void)[]} */ ([]);
  /** @type {Record<string, string>} */
  const attributes = { 'data-copied': 'Copied', 'data-failed': 'Failed' };
  const button = {
    hidden: true,
    getAttribute: (/** @type {string} */ name) => attributes[name] ?? null,
    addEventListener(/** @type {string} */ type, /** @type {() => void} */ listener) {
      if (type === 'click') listeners.push(listener);
    },
  };
  const text = { textContent: 'the text\n' };
  const status = { textContent: '' };
  const copied = /** @type {string[]} */ ([]);
  /** @type {Record<string, unknown>} */
  const parts = { '.share-copy': button, '.share-text': text, '.share-status': status };
  const block = { querySelector: (/** @type {string} */ selector) => parts[selector] ?? null };
  let selected = false;
  const context = createContext({
    document: {
      querySelectorAll: () => [block],
      createRange: () => ({ selectNodeContents() {} }),
      execCommand: () => setup.execCommand ?? false,
    },
    window: {
      getSelection: () => ({
        removeAllRanges() {},
        addRange() {
          selected = true;
        },
      }),
    },
    navigator:
      setup.clipboard === 'missing'
        ? {}
        : {
            clipboard: {
              writeText: (/** @type {string} */ value) => {
                if (setup.clipboard === 'fails') return Promise.reject(new Error('denied'));
                copied.push(value);
                return Promise.resolve();
              },
            },
          },
  });
  runInContext(readFileSync(join(assetsDir, 'share.js'), 'utf8'), context, { filename: 'share.js' });
  return {
    button,
    status,
    copied,
    selected: () => selected,
    async click() {
      listeners.forEach((listener) => listener());
      await new Promise((done) => setImmediate(done));
    },
  };
}

test('the copy script shows the button, copies the text and says so', async () => {
  const page = runScript({ clipboard: 'works' });
  assert.equal(page.button.hidden, false, 'the script is what shows the button');
  await page.click();
  assert.deepEqual(page.copied, ['the text\n']);
  assert.equal(page.status.textContent, 'Copied');
});

test('the copy script falls back to selecting the text, and reports a failure', async () => {
  const fallback = runScript({ clipboard: 'fails', execCommand: true });
  await fallback.click();
  assert.equal(fallback.selected(), true);
  assert.equal(fallback.status.textContent, 'Copied');

  const missing = runScript({ clipboard: 'missing', execCommand: false });
  await missing.click();
  assert.equal(missing.status.textContent, 'Failed');
});

test('the share script is valid JavaScript', () => {
  assert.doesNotThrow(() => new Script(readFileSync(join(assetsDir, 'share.js'), 'utf8'), { filename: 'share.js' }));
});
