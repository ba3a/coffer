import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BuildError, DEPLOY_EXCLUDES, MANIFEST_FILE_NAME, buildSites, postUrl } from '../src/build.js';
import { parseBuildArgs, run } from '../src/cli.js';
import { loadConfig } from '../src/config.js';
import * as engine from '../src/index.js';

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
  const root = mkdtempSync(join(tmpdir(), 'coffer-build-'));
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
 * @param {string} extra Extra lines for the blog entry, indented by six spaces.
 * @returns {string}
 */
function configYaml(extra = '') {
  return [
    'sites:',
    '  - id: demo',
    '    baseUrl: https://demo.example',
    '    lang: en',
    '    title: Demo',
    '    contentLicense: Some rights reserved',
    '    blogs:',
    '      - { id: notes, dir: notes, prefix: log, title: Notes }',
    extra,
    '',
  ].join('\n');
}

/**
 * @param {string} title
 * @param {string} date
 * @param {string} [extra] More front matter lines.
 * @returns {string}
 */
function post(title, date, extra = '') {
  return `---\ntitle: ${title}\ndate: ${date}\n${extra}---\n\nSome words in the body of ${title}.\n`;
}

const sixWeeks = '2026-04-20';

test('the blog index lists published posts newest first with date, summary and reading time', async () => {
  await inTree(
    {
      'coffer.yaml': configYaml(),
      'notes/old.md': post('Old post', '2025-01-05', 'summary: The old one.\n'),
      'notes/new.md': post('New post', sixWeeks, 'summary: The new one.\n'),
      'notes/middle.md': post('Middle post', '2025-09-30'),
    },
    async (root) => {
      const [result] = await buildSites(loadConfig({ configPath: join(root, 'coffer.yaml') }), {
        out: join(root, 'out'),
        now: NOW,
      });
      const html = readFileSync(join(result.outDir, 'log', 'index.html'), 'utf8');
      const titles = [...html.matchAll(/<h2><a href="[^"]+">([^<]+)<\/a><\/h2>/g)].map((m) => m[1]);
      assert.deepEqual(titles, ['New post', 'Middle post', 'Old post']);
      assert.match(html, /<time datetime="2026-04-20">Apr 20, 2026<\/time>/);
      assert.match(html, /<p class="post-summary">The new one\.<\/p>/);
      assert.match(html, /1 minute/);
      assert.match(html, /<link rel="stylesheet" href="\/assets\/coffer\.css">/);
      assert.deepEqual(
        result.manifest.pages.map((entry) => entry.url),
        ['/log/', '/log/middle/', '/log/new/', '/log/old/'],
      );
    },
  );
});

test('a post URL depends on the blog prefix and the slug only', async () => {
  await inTree(
    {
      'coffer.yaml': configYaml(),
      'notes/same-slug.md': post('Tagged', '2020-02-02', 'tags: [a/b, c]\n'),
    },
    async (root) => {
      const config = loadConfig({ configPath: join(root, 'coffer.yaml') });
      const first = await buildSites(config, { out: join(root, 'out'), now: NOW });
      assert.equal(first[0].manifest.posts[0].url, '/log/same-slug/');
      assert.ok(existsSync(join(root, 'out', 'demo', 'log', 'same-slug', 'index.html')));

      writeFileSync(
        join(root, 'notes', 'same-slug.md'),
        post('Tagged', '2025-12-24', 'tags: [x/y/z]\n'),
      );
      const second = await buildSites(config, { out: join(root, 'out'), now: NOW });
      assert.equal(second[0].manifest.posts[0].url, '/log/same-slug/');
      assert.equal(postUrl(config.sites[0].blogs[0], 'same-slug'), '/log/same-slug/');
    },
  );
});

test('a blog without a prefix writes its posts and index at the site root', async () => {
  await inTree(
    {
      'coffer.yaml': configYaml().replace('prefix: log', "prefix: ''"),
      'notes/hello.md': post('Hello', '2025-05-05'),
    },
    async (root) => {
      const [result] = await buildSites(loadConfig({ configPath: join(root, 'coffer.yaml') }), {
        out: join(root, 'out'),
        now: NOW,
      });
      assert.ok(existsSync(join(result.outDir, 'hello', 'index.html')));
      assert.ok(existsSync(join(result.outDir, 'index.html')));
      assert.equal(result.manifest.posts[0].url, '/hello/');
    },
  );
});

test('a rebuild removes what an earlier build left behind', async () => {
  await inTree(
    {
      'coffer.yaml': configYaml(),
      'notes/draft-one.md': post('Draft one', '2025-05-05', 'draft: true\n'),
      'notes/kept.md': post('Kept', '2025-05-06'),
    },
    async (root) => {
      const config = loadConfig({ configPath: join(root, 'coffer.yaml') });
      const out = join(root, 'out');
      const preview = await buildSites(config, { out, now: NOW, drafts: true });
      assert.ok(existsSync(join(preview[0].outDir, 'log', 'draft-one', 'index.html')));
      const normal = await buildSites(config, { out, now: NOW });
      assert.equal(existsSync(join(normal[0].outDir, 'log', 'draft-one')), false);
      assert.ok(existsSync(join(normal[0].outDir, 'log', 'kept', 'index.html')));
    },
  );
});

test('a site with no published posts still gets an index page with a message', async () => {
  await inTree(
    {
      'coffer.yaml': configYaml(),
      'notes/only-draft.md': post('Only draft', '2025-05-05', 'draft: true\n'),
    },
    async (root) => {
      const [result] = await buildSites(loadConfig({ configPath: join(root, 'coffer.yaml') }), {
        out: join(root, 'out'),
        now: NOW,
      });
      const html = readFileSync(join(result.outDir, 'log', 'index.html'), 'utf8');
      assert.match(html, /No posts yet\./);
      assert.deepEqual(result.manifest.posts, []);
    },
  );
});

test('a post without enough headings has no table of contents', async () => {
  await inTree(
    { 'coffer.yaml': configYaml(), 'notes/short.md': post('Short', '2025-05-05') },
    async (root) => {
      const [result] = await buildSites(loadConfig({ configPath: join(root, 'coffer.yaml') }), {
        out: join(root, 'out'),
        now: NOW,
      });
      const html = readFileSync(join(result.outDir, 'log', 'short', 'index.html'), 'utf8');
      assert.doesNotMatch(html, /class="toc"/);
      assert.doesNotMatch(html, /has-toc/);
    },
  );
});

test('a theme replaces assets and templates, and may override one block of post.njk', async () => {
  await inTree(
    {
      'coffer.yaml': configYaml('    theme: theme'),
      'theme/assets/coffer.css': 'body { color: black; }\n',
      'theme/assets/extra.js': '// extra\n',
      'theme/templates/post.njk':
        '{% extends "coffer:post.njk" %}\n{% block meta %}<p class="custom-meta">{{ post.slug }}</p>{% endblock %}\n',
      'notes/hello.md': post('Hello', '2025-05-05'),
    },
    async (root) => {
      const [result] = await buildSites(loadConfig({ configPath: join(root, 'coffer.yaml') }), {
        out: join(root, 'out'),
        now: NOW,
      });
      assert.equal(readFileSync(join(result.outDir, 'assets', 'coffer.css'), 'utf8'), 'body { color: black; }\n');
      assert.ok(existsSync(join(result.outDir, 'assets', 'extra.js')));
      const html = readFileSync(join(result.outDir, 'log', 'hello', 'index.html'), 'utf8');
      assert.match(html, /<p class="custom-meta">hello<\/p>/);
      assert.match(html, /<h1>Hello<\/h1>/);
    },
  );
});

test('the language of the site selects the UI strings and the date format', async () => {
  await inTree(
    {
      'coffer.yaml': configYaml().replace('lang: en', 'lang: ru'),
      'notes/privet.md': post('Привет', '2025-05-05'),
    },
    async (root) => {
      const [result] = await buildSites(loadConfig({ configPath: join(root, 'coffer.yaml') }), {
        out: join(root, 'out'),
        now: NOW,
      });
      const html = readFileSync(join(result.outDir, 'log', 'privet', 'index.html'), 'utf8');
      assert.match(html, /<html lang="ru">/);
      assert.match(html, /Опубликовано 5 мая 2025 г\./);
      assert.match(html, /1 минута/);
      assert.deepEqual(result.warnings, []);
    },
  );
});

test('the manifest file name is the only file excluded from deployment', () => {
  assert.equal(MANIFEST_FILE_NAME, '.coffer-manifest.json');
  assert.deepEqual([...DEPLOY_EXCLUDES], [MANIFEST_FILE_NAME]);
  assert.equal(engine.MANIFEST_FILE_NAME, MANIFEST_FILE_NAME);
  assert.equal(typeof engine.buildSites, 'function');
});

test('building an unknown site id or with an invalid --now is a BuildError', async () => {
  await inTree({ 'coffer.yaml': configYaml(), 'notes/a.md': post('A', '2025-05-05') }, async (root) => {
    const config = loadConfig({ configPath: join(root, 'coffer.yaml') });
    await assert.rejects(
      buildSites(config, { out: join(root, 'out'), siteIds: ['nope'] }),
      (error) => error instanceof BuildError && /unknown site "nope"/.test(error.message),
    );
    await assert.rejects(
      buildSites(config, { out: join(root, 'out'), nowFlag: 'yesterday' }),
      (error) => error instanceof BuildError && /--now/.test(error.message),
    );
  });
});

test('COFFER_NOW decides which posts are published when no --now is given', async () => {
  await inTree(
    { 'coffer.yaml': configYaml(), 'notes/later.md': post('Later', '2030-01-01') },
    async (root) => {
      const config = loadConfig({ configPath: join(root, 'coffer.yaml') });
      const before = await buildSites(config, { out: join(root, 'out'), env: { COFFER_NOW: '2029-12-31' } });
      assert.deepEqual(before[0].manifest.posts, []);
      const after = await buildSites(config, { out: join(root, 'out'), env: { COFFER_NOW: '2030-01-02' } });
      assert.equal(after[0].manifest.posts.length, 1);
    },
  );
});

test('parseBuildArgs reads --config, --out, --now and --drafts in both forms', () => {
  assert.deepEqual(parseBuildArgs([]), { drafts: false });
  assert.deepEqual(
    parseBuildArgs(['--config', 'a.yaml', '--out=public', '--drafts', '--now', '2026-01-01']),
    { drafts: true, configPath: 'a.yaml', out: 'public', now: '2026-01-01' },
  );
  assert.deepEqual(parseBuildArgs(['--out']), { error: '--out needs a value' });
  assert.deepEqual(parseBuildArgs(['--bogus']), { error: 'unexpected argument "--bogus"' });
});

/**
 * @param {string[]} argv
 */
async function runInProcess(argv) {
  let out = '';
  let err = '';
  const code = await run(argv, {
    out: (text) => {
      out += text;
    },
    err: (text) => {
      err += text;
    },
  });
  return { code, out, err };
}

test('coffer build reports a problem post with its file and exits 1', async () => {
  await inTree(
    { 'coffer.yaml': configYaml(), 'notes/broken.md': '---\ntitle: Broken\n---\n\nNo date.\n' },
    async (root) => {
      const result = await runInProcess(['build', '--config', join(root, 'coffer.yaml'), '--out', join(root, 'out')]);
      assert.equal(result.code, 1);
      assert.match(result.err, /broken\.md/);
      assert.match(result.err, /date/);
    },
  );
});

test('coffer build with a bad option exits 1 and names it', async () => {
  const result = await runInProcess(['build', '--nope']);
  assert.equal(result.code, 1);
  assert.match(result.err, /unexpected argument "--nope"/);
});

test('coffer build with a missing config file exits 1', async () => {
  const result = await runInProcess(['build', '--config', join(tmpdir(), 'coffer-no-such-file.yaml')]);
  assert.equal(result.code, 1);
  assert.match(result.err, /file not found/);
});
