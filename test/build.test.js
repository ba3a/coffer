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
        ['/', '/404.html', '/log/', '/log/middle/', '/log/new/', '/log/old/', '/log/tags/'],
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

/** A site in Russian with a home page, for the tests of the home and 404 pages. */
const homeFiles = {
  'coffer.yaml': [
    'sites:',
    '  - id: demo',
    '    baseUrl: https://demo.example',
    '    lang: ru',
    '    title: Демо',
    '    contentLicense: Все права защищены',
    '    links:',
    '      - { label: Почта, url: "mailto:me@demo.example" }',
    '    blogs:',
    '      - { id: notes, dir: notes, prefix: log, title: Записки }',
    '      - { id: other, dir: other, prefix: more, title: Другое }',
    '',
  ].join('\n'),
  'content/home.md': '---\ntitle: Привет\nlatestPosts: 2\n---\n\nЯ делаю вещи.\n',
  'notes/a.md': post('Первая', '2025-01-01'),
  'notes/b.md': post('Вторая', '2025-02-01'),
  'notes/c.md': post('Третья', '2025-03-01'),
  'other/x.md': post('Чужая', '2025-04-01'),
};

test('the home page lists as many latest posts as latestPosts says, from the first blog only', async () => {
  await inTree(homeFiles, async (root) => {
    const [result] = await buildSites(loadConfig({ configPath: join(root, 'coffer.yaml') }), {
      out: join(root, 'out'),
      now: NOW,
    });
    const html = readFileSync(join(result.outDir, 'index.html'), 'utf8');
    assert.match(html, /<html lang="ru">/);
    assert.match(html, /<h1>Привет<\/h1>/);
    assert.match(html, /Я делаю вещи\./);
    assert.match(html, /<a href="mailto:me@demo\.example">Почта<\/a>/);
    assert.match(html, /<h2>Свежие записи<\/h2>/);
    const titles = [...html.matchAll(/<h3><a href="[^"]+">([^<]+)<\/a><\/h3>/g)].map((m) => m[1]);
    assert.deepEqual(titles, ['Третья', 'Вторая']);
    assert.match(html, /<a href="\/log\/">Все записи: Записки<\/a>/);
    assert.deepEqual(result.warnings, []);
  });
});

test('without latestPosts the home page lists five posts, and zero hides the list', async () => {
  const many = Object.fromEntries(
    Array.from({ length: 7 }, (_, i) => [`notes/p${i}.md`, post(`Post ${i}`, `2025-0${i + 1}-01`)]),
  );
  await inTree(
    { ...homeFiles, ...many, 'content/home.md': '---\ntitle: Hi\n---\n\nAbout.\n' },
    async (root) => {
      const config = loadConfig({ configPath: join(root, 'coffer.yaml') });
      const [result] = await buildSites(config, { out: join(root, 'out'), now: NOW });
      const html = readFileSync(join(result.outDir, 'index.html'), 'utf8');
      assert.equal([...html.matchAll(/<h3>/g)].length, 5);

      writeFileSync(join(root, 'content', 'home.md'), '---\ntitle: Hi\nlatestPosts: 0\n---\n\nAbout.\n');
      const [none] = await buildSites(config, { out: join(root, 'out'), now: NOW });
      assert.doesNotMatch(readFileSync(join(none.outDir, 'index.html'), 'utf8'), /latest-posts/);
    },
  );
});

test('a site without home.md still gets a home page with its title, links and posts', async () => {
  const { 'content/home.md': _home, ...files } = homeFiles;
  await inTree(files, async (root) => {
    const [result] = await buildSites(loadConfig({ configPath: join(root, 'coffer.yaml') }), {
      out: join(root, 'out'),
      now: NOW,
    });
    const html = readFileSync(join(result.outDir, 'index.html'), 'utf8');
    assert.match(html, /<h1>Демо<\/h1>/);
    assert.doesNotMatch(html, /class="about"/);
    assert.match(html, /Почта/);
    assert.match(html, /Третья/);
  });
});

test('404.html is written in the language of the site, with its layout and license', async () => {
  await inTree(homeFiles, async (root) => {
    const [result] = await buildSites(loadConfig({ configPath: join(root, 'coffer.yaml') }), {
      out: join(root, 'out'),
      now: NOW,
    });
    const html = readFileSync(join(result.outDir, '404.html'), 'utf8');
    assert.match(html, /<html lang="ru">/);
    assert.match(html, /<h1>Страница не найдена<\/h1>/);
    assert.match(html, /<a href="\/">На главную<\/a>/);
    assert.match(html, /<title>Страница не найдена \| Демо<\/title>/);
    assert.match(html, /Материалы: Все права защищены/);
  });
});

test('a theme can override one block of home.njk and replace 404.njk', async () => {
  await inTree(
    {
      ...homeFiles,
      'coffer.yaml': `${homeFiles['coffer.yaml']}    theme: theme\n`,
      'theme/templates/home.njk':
        '{% extends "coffer:home.njk" %}\n{% block showcase %}<section class="showcase">Витрина</section>{% endblock %}\n',
      'theme/templates/404.njk':
        '{% extends "base.njk" %}\n{% block main %}<p class="lost">Потерялись</p>{% endblock %}\n',
    },
    async (root) => {
      const [result] = await buildSites(loadConfig({ configPath: join(root, 'coffer.yaml') }), {
        out: join(root, 'out'),
        now: NOW,
      });
      const home = readFileSync(join(result.outDir, 'index.html'), 'utf8');
      assert.match(home, /<section class="showcase">Витрина<\/section>/);
      assert.match(home, /Третья/);
      assert.match(readFileSync(join(result.outDir, '404.html'), 'utf8'), /<p class="lost">Потерялись<\/p>/);
    },
  );
});

test('a blog at the site root keeps "/" and home.md is reported as unused', async () => {
  await inTree(
    { ...homeFiles, 'coffer.yaml': homeFiles['coffer.yaml'].replace('prefix: log', "prefix: ''") },
    async (root) => {
      const [result] = await buildSites(loadConfig({ configPath: join(root, 'coffer.yaml') }), {
        out: join(root, 'out'),
        now: NOW,
      });
      const html = readFileSync(join(result.outDir, 'index.html'), 'utf8');
      assert.match(html, /<h1>Записки<\/h1>/);
      assert.equal(result.manifest.pages.filter((entry) => entry.url === '/').length, 1);
      assert.equal(result.manifest.pages.find((entry) => entry.url === '/')?.type, 'blog-index');
      assert.equal(result.warnings.length, 1);
      assert.match(result.warnings[0], /home\.md/);
      assert.ok(existsSync(join(result.outDir, '404.html')));
    },
  );
});

test('coffer build reports an invalid home.md with its file and field and exits 1', async () => {
  await inTree(
    { ...homeFiles, 'content/home.md': '---\nlatestPosts: many\n---\n\nAbout.\n' },
    async (root) => {
      const result = await runInProcess(['build', '--config', join(root, 'coffer.yaml'), '--out', join(root, 'out')]);
      assert.equal(result.code, 1);
      assert.match(result.err, /home\.md: title: is required/);
      assert.match(result.err, /home\.md: latestPosts: must be a whole number/);
    },
  );
});

/** Posts of a small tag tree: `one` is tagged a/b, `two` a/c, `three` both a/b/x and a/c. */
const tagFiles = {
  'coffer.yaml': configYaml(),
  'notes/one.md': post('One', '2026-01-01', 'tags: [a/b]\n'),
  'notes/two.md': post('Two', '2026-02-01', 'tags: [a/c]\n'),
  'notes/three.md': post('Three', '2026-03-01', 'tags: [a/b/x, a/c]\n'),
  'notes/lonely.md': post('Lonely', '2026-04-01', 'tags: [solo]\n'),
};

/**
 * @param {string} outDir
 * @param {string} url
 * @returns {string}
 */
function pageAt(outDir, url) {
  return readFileSync(join(outDir, ...url.split('/').filter(Boolean), 'index.html'), 'utf8');
}

/**
 * The titles of the posts listed on a page, in order.
 *
 * @param {string} html
 * @returns {string[]}
 */
function listed(html) {
  return [...html.matchAll(/<h2><a href="[^"]+">([^<]+)<\/a><\/h2>/g)].map((m) => m[1]);
}

/**
 * @param {string} root
 * @param {Partial<import('../src/build.js').BuildOptions>} [options]
 */
async function buildTagged(root, options = {}) {
  const [result] = await buildSites(loadConfig({ configPath: join(root, 'coffer.yaml') }), {
    out: join(root, 'out'),
    now: NOW,
    ...options,
  });
  return result;
}

test('a tag page lists posts with the tag or any tag below it, newest first', async () => {
  await inTree(tagFiles, async (root) => {
    const result = await buildTagged(root);
    assert.deepEqual(listed(pageAt(result.outDir, '/log/tags/a/')), ['Three', 'Two', 'One']);
    assert.deepEqual(listed(pageAt(result.outDir, '/log/tags/a/b/')), ['Three', 'One']);
    assert.deepEqual(listed(pageAt(result.outDir, '/log/tags/a/b/x/')), ['Three']);
    // A post tagged a/b does not appear on a/c.
    const c = pageAt(result.outDir, '/log/tags/a/c/');
    assert.deepEqual(listed(c), ['Three', 'Two']);
    assert.doesNotMatch(c, />One</);
    assert.deepEqual(listed(pageAt(result.outDir, '/log/tags/solo/')), ['Lonely']);

    const types = Object.fromEntries(result.manifest.pages.map((entry) => [entry.url, entry.type]));
    assert.equal(types['/log/tags/'], 'tag-index');
    assert.equal(types['/log/tags/a/b/x/'], 'tag');
  });
});

test('a post tagged workshop/boxes appears on the workshop tag page', async () => {
  await inTree(
    { 'coffer.yaml': configYaml(), 'notes/box.md': post('A box', '2026-01-01', 'tags: [workshop/boxes]\n') },
    async (root) => {
      const result = await buildTagged(root);
      assert.deepEqual(listed(pageAt(result.outDir, '/log/tags/workshop/')), ['A box']);
      assert.deepEqual(listed(pageAt(result.outDir, '/log/tags/workshop/boxes/')), ['A box']);
    },
  );
});

test('a tag page links its child tags and breadcrumbs to its ancestors', async () => {
  await inTree(tagFiles, async (root) => {
    const result = await buildTagged(root);
    const b = pageAt(result.outDir, '/log/tags/a/b/');
    assert.match(b, /<h1>b<\/h1>/);
    assert.match(
      b,
      /<nav class="breadcrumbs"[^>]*>[\s\S]*<a href="\/log\/tags\/">Tags<\/a>[\s\S]*<a href="\/log\/tags\/a\/">a<\/a>[\s\S]*<li aria-current="page">b<\/li>/,
    );
    assert.match(b, /<a href="\/log\/tags\/a\/b\/x\/">x<\/a> <span class="tag-count">\(1\)<\/span>/);

    const top = pageAt(result.outDir, '/log/tags/a/');
    assert.match(top, /<a href="\/log\/tags\/a\/b\/">b<\/a> <span class="tag-count">\(2\)<\/span>/);
    assert.match(top, /<a href="\/log\/tags\/a\/c\/">c<\/a> <span class="tag-count">\(2\)<\/span>/);
    // A top-level tag has the tree as its only ancestor.
    assert.doesNotMatch(top, /<li><a href="\/log\/tags\/a\/">/);

    // The manifest says what each tag page lists.
    const manifestTag = result.manifest.tags.find((entry) => entry.path === 'a');
    assert.deepEqual(manifestTag, {
      blog: 'notes',
      path: 'a',
      url: '/log/tags/a/',
      file: 'log/tags/a/index.html',
      name: 'a',
      count: 3,
      posts: ['/log/three/', '/log/two/', '/log/one/'],
    });
  });
});

test('the tag tree page lists every node with the number of distinct posts in its subtree', async () => {
  await inTree(tagFiles, async (root) => {
    const result = await buildTagged(root);
    const html = pageAt(result.outDir, '/log/tags/');
    assert.match(html, /<h1>Tags<\/h1>/);
    /** @type {Record<string, string>} */
    const counts = {};
    const entry = /<a href="(\/log\/tags\/[^"]+)">[^<]+<\/a> <span class="tag-count">\((\d+)\)<\/span>/g;
    for (const m of html.matchAll(entry)) counts[m[1]] = m[2];
    assert.deepEqual(counts, {
      '/log/tags/a/': '3',
      '/log/tags/a/b/': '2',
      '/log/tags/a/b/x/': '1',
      '/log/tags/a/c/': '2',
      '/log/tags/solo/': '1',
    });
    // The tree is nested: x is inside the list of b.
    assert.match(
      html,
      /<a href="\/log\/tags\/a\/b\/">b<\/a>[\s\S]*<ul>[\s\S]*<a href="\/log\/tags\/a\/b\/x\/">x<\/a>/,
    );
  });
});

test('a blog without tags still has a tag tree page, saying so', async () => {
  await inTree({ 'coffer.yaml': configYaml(), 'notes/plain.md': post('Plain', '2026-01-01') }, async (root) => {
    const result = await buildTagged(root);
    assert.match(pageAt(result.outDir, '/log/tags/'), /<p class="empty">No tags yet\.<\/p>/);
    assert.deepEqual(result.manifest.tags, []);
  });
});

test('the blog index and the post page link the tags', async () => {
  await inTree(tagFiles, async (root) => {
    const result = await buildTagged(root);
    assert.match(pageAt(result.outDir, '/log/'), /<a href="\/log\/tags\/">Tags<\/a>/);
    const html = pageAt(result.outDir, '/log/three/');
    assert.match(
      html,
      /<ul class="post-tags"[^>]*>\s*<li><a href="\/log\/tags\/a\/b\/x\/">x<\/a><\/li>\s*<li><a href="\/log\/tags\/a\/c\/">c<\/a><\/li>\s*<\/ul>/,
    );
    assert.doesNotMatch(pageAt(result.outDir, '/log/tags/solo/'), /post-tags/);
  });
});

test('tags.yaml names and descriptions are shown, and a tag without one shows its slug', async () => {
  await inTree(
    {
      ...tagFiles,
      'notes/tags.yaml': 'a:\n  name: Alpha\n  description: The first letter.\na/b:\n  name: Бета\n',
    },
    async (root) => {
      const result = await buildTagged(root);
      const a = pageAt(result.outDir, '/log/tags/a/');
      assert.match(a, /<h1>Alpha<\/h1>/);
      assert.match(a, /<p class="tag-description">The first letter\.<\/p>/);
      assert.match(a, /<meta name="description" content="The first letter\.">/);
      assert.match(a, /<title>Alpha \| Demo<\/title>/);
      assert.match(a, /<a href="\/log\/tags\/a\/b\/">Бета<\/a>/);
      assert.match(a, /<a href="\/log\/tags\/a\/c\/">c<\/a>/);

      const c = pageAt(result.outDir, '/log/tags/a/c/');
      assert.match(c, /<h1>c<\/h1>/);
      assert.match(c, /<a href="\/log\/tags\/a\/">Alpha<\/a>/);
      assert.doesNotMatch(c, /tag-description/);

      const tree = pageAt(result.outDir, '/log/tags/');
      assert.match(tree, /<a href="\/log\/tags\/a\/">Alpha<\/a>/);
      assert.match(tree, /The first letter\./);
      assert.match(tree, /<a href="\/log\/tags\/a\/b\/x\/">x<\/a>/);
      assert.match(pageAt(result.outDir, '/log/three/'), /<a href="\/log\/tags\/a\/b\/x\/">x<\/a>/);
      assert.match(pageAt(result.outDir, '/log/one/'), /<a href="\/log\/tags\/a\/b\/">Бета<\/a>/);
      assert.deepEqual(result.warnings, []);
    },
  );
});

test('unknown tags.yaml keys and entries for unused tags are warnings, not errors', async () => {
  await inTree(
    {
      ...tagFiles,
      'notes/tags.yaml': 'a:\n  name: Alpha\n  colour: red\nghost:\n  name: Ghost\n',
    },
    async (root) => {
      const result = await buildTagged(root);
      assert.equal(result.warnings.length, 2);
      assert.match(result.warnings[0], /^notes[\\/]tags\.yaml: a\.colour: unknown key/);
      assert.match(result.warnings[1], /^notes[\\/]tags\.yaml: ghost: no published post uses this tag/);
      assert.equal(result.manifest.tags.some((entry) => entry.path === 'ghost'), false);
      assert.equal(existsSync(join(result.outDir, 'log', 'tags', 'ghost')), false);
    },
  );
});

test('only published posts make the tag tree', async () => {
  const files = {
    ...tagFiles,
    'notes/draft.md': post('Draft', '2026-05-01', 'draft: true\ntags: [a/b, secret]\n'),
    'notes/future.md': post('Future', '2099-01-01', 'tags: [a, later]\n'),
  };
  await inTree(files, async (root) => {
    const result = await buildTagged(root);
    assert.equal(existsSync(join(result.outDir, 'log', 'tags', 'secret')), false);
    assert.equal(existsSync(join(result.outDir, 'log', 'tags', 'later')), false);
    assert.deepEqual(listed(pageAt(result.outDir, '/log/tags/a/b/')), ['Three', 'One']);
    assert.match(
      pageAt(result.outDir, '/log/tags/'),
      /<a href="\/log\/tags\/a\/">a<\/a> <span class="tag-count">\(3\)<\/span>/,
    );

    const preview = await buildTagged(root, { drafts: true });
    assert.ok(existsSync(join(preview.outDir, 'log', 'tags', 'secret', 'index.html')));
    assert.deepEqual(listed(pageAt(preview.outDir, '/log/tags/a/b/')), ['Draft', 'Three', 'One']);
  });
});

test('a blog without a prefix keeps its tag pages under the tags segment of the site', async () => {
  await inTree(
    { ...tagFiles, 'coffer.yaml': configYaml().replace('prefix: log', "prefix: ''") },
    async (root) => {
      const result = await buildTagged(root);
      assert.deepEqual(listed(pageAt(result.outDir, '/tags/a/b/')), ['Three', 'One']);
      assert.ok(existsSync(join(result.outDir, 'tags', 'index.html')));
    },
  );
});

test('the tags segment follows the urls.tags setting', async () => {
  await inTree(
    {
      ...tagFiles,
      'coffer.yaml': configYaml().replace('    blogs:', '    urls:\n      tags: themes\n    blogs:'),
    },
    async (root) => {
      const result = await buildTagged(root);
      assert.deepEqual(listed(pageAt(result.outDir, '/log/themes/a/b/')), ['Three', 'One']);
      assert.match(pageAt(result.outDir, '/log/three/'), /href="\/log\/themes\/a\/c\/"/);
    },
  );
});

test('a post whose slug is the tags segment is a build error', async () => {
  await inTree(
    { 'coffer.yaml': configYaml(), 'notes/tags.md': post('Tags', '2026-01-01') },
    async (root) => {
      await assert.rejects(
        buildTagged(root),
        (error) => error instanceof BuildError && /slug: "tags" is the address of the tag pages/.test(error.message),
      );
    },
  );
});

test('an alias that is the tags segment collides with the tag tree page', async () => {
  await inTree(
    { 'coffer.yaml': configYaml(), 'notes/one.md': post('One', '2026-01-01', 'aliases: [tags]\n') },
    async (root) => {
      await assert.rejects(buildTagged(root), (error) => error instanceof BuildError && /\/log\/tags\//.test(error.message));
    },
  );
});

test('coffer build reports an invalid tags.yaml with its file and exits 1', async () => {
  await inTree({ ...tagFiles, 'notes/tags.yaml': 'a:\n  name: 5\n' }, async (root) => {
    const result = await runInProcess(['build', '--config', join(root, 'coffer.yaml'), '--out', join(root, 'out')]);
    assert.equal(result.code, 1);
    assert.match(result.err, /tags\.yaml: a\.name: must be a non-empty string/);
  });
});
