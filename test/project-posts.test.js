import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { buildSites } from '../src/build.js';
import { checkOutput } from '../src/check/index.js';
import { loadConfig } from '../src/config.js';
import { parsePostSource } from '../src/content/posts.js';
import { projectsOfPost, tagInProjectTag, unknownProjectMessage } from '../src/content/project-posts.js';
import { validateFeed } from '../src/check/feed-validator.js';
import { TINY_PNG } from './helpers/images.js';

const NOW = new Date('2026-06-01T12:00:00Z');

/**
 * @param {{ projects?: string, blogs?: string[] }} [options]
 * @returns {string} A coffer.yaml.
 */
function configText({ projects = '{ dir: content/projects }', blogs = ['journal'] } = {}) {
  return [
    'sites:',
    '  - id: demo',
    '    baseUrl: https://demo.example',
    '    lang: en',
    '    title: Demo',
    '    description: A demo site.',
    '    blogs:',
    ...blogs.map((id) => `      - { id: ${id}, dir: content/${id}, prefix: ${id}, title: ${id} }`),
    ...(projects === '' ? [] : [`    projects: ${projects}`]),
    '',
  ].join('\n');
}

const HOME = '---\ntitle: Demo\n---\n\nAbout the demo.\n';

/**
 * The files of one project.
 *
 * @param {string} slug
 * @param {string} yaml The text of project.yaml.
 * @returns {Record<string, string | Buffer>}
 */
function project(slug, yaml) {
  return {
    [`content/projects/${slug}/project.yaml`]: yaml,
    [`content/projects/${slug}/index.md`]: 'The page text.\n',
    [`content/projects/${slug}/card.png`]: TINY_PNG,
  };
}

const TOOL = 'name: Lathe\npitch: Turns wood.\nkind: tool\nstatus: released\ncard: card.png\nrepo: https://github.example/me/lathe\ntag: projects/lathe\norder: 1\n';
const GAME = 'name: Tumble\npitch: Falling joints.\nkind: game\nstatus: in-development\ncard: card.png\ntag: projects/tumble\norder: 2\n';

/**
 * The files of one post.
 *
 * @param {string} slug
 * @param {string} date
 * @param {string[]} tags
 * @param {string} [extra] More front matter lines, each ending in a newline.
 * @param {string} [blog]
 * @returns {Record<string, string>}
 */
function post(slug, date, tags, extra = '', blog = 'journal') {
  return {
    [`content/${blog}/${slug}/index.md`]: `---\ntitle: Post ${slug}\ndate: ${date}\ntags: [${tags.join(', ')}]\n${extra}---\n\nText of ${slug}.\n`,
  };
}

/**
 * Writes a site into a temporary directory, runs `body` with its root and removes it.
 *
 * @param {Record<string, string | Buffer>} files
 * @param {(root: string) => Promise<void>} body
 * @param {string} [config]
 */
async function inSite(files, body, config = configText()) {
  const root = mkdtempSync(join(tmpdir(), 'coffer-project-posts-'));
  try {
    const all = { 'coffer.yaml': config, 'content/home.md': HOME, ...files };
    for (const [name, content] of Object.entries(all)) {
      const target = join(root, ...name.split('/'));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    await body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * @param {string} root
 * @param {Partial<import('../src/build.js').BuildOptions>} [options]
 */
function build(root, options = {}) {
  return buildSites(loadConfig({ configPath: join(root, 'coffer.yaml') }), {
    out: join(root, 'out'),
    now: NOW,
    ...options,
  });
}

/**
 * @param {string} root
 * @param {{ drafts?: boolean }} [options]
 * @returns {Promise<string[]>} The errors of a build that must fail.
 */
async function buildErrors(root, options = {}) {
  try {
    await build(root, options);
  } catch (error) {
    assert.ok(error instanceof Error && 'errors' in error, `expected a build error, got ${error}`);
    return /** @type {string[]} */ (error.errors);
  }
  return assert.fail('the build should have failed');
}

/**
 * @param {string} root
 * @param {string} url
 * @returns {string}
 */
function pageHtml(root, url) {
  return readFileSync(join(root, 'out', 'demo', ...url.split('/').filter(Boolean), 'index.html'), 'utf8');
}

/**
 * @param {string} root
 * @param {string} file
 * @returns {string}
 */
function outputText(root, file) {
  return readFileSync(join(root, 'out', 'demo', ...file.split('/')), 'utf8');
}

/** @param {string} html */
function blockCount(html) {
  return (html.match(/<section class="project-block"/g) ?? []).length;
}

/**
 * The addresses of the entries of a feed, in feed order.
 *
 * @param {string} xml
 * @returns {string[]}
 */
function feedEntries(xml) {
  return [...xml.matchAll(/<entry>\s*<id>([^<]+)<\/id>/g)].map((match) => match[1]);
}

/**
 * The feeds a page advertises in its head.
 *
 * @param {string} html
 * @returns {string[]}
 */
function advertised(html) {
  return [...html.slice(0, html.indexOf('</head>')).matchAll(/<link rel="alternate" type="application\/atom\+xml" title="[^"]*" href="([^"]+)">/g)].map((match) => match[1]);
}

const SITE = {
  ...project('lathe', TOOL),
  ...project('tumble', GAME),
};

// ---------------------------------------------------------------------------
// Which posts are about which project.

test('a post is about a project when a tag equals the project tag or lies below it', () => {
  assert.equal(tagInProjectTag('projects/lathe', 'projects/lathe'), true);
  assert.equal(tagInProjectTag('projects/lathe/news', 'projects/lathe'), true);
  assert.equal(tagInProjectTag('projects/lathe-two', 'projects/lathe'), false);
  assert.equal(tagInProjectTag('projects', 'projects/lathe'), false);

  const projects = [
    { slug: 'lathe', tag: 'projects/lathe' },
    { slug: 'tumble', tag: 'projects/tumble' },
    { slug: 'quiet', tag: null },
  ];
  assert.deepEqual(projectsOfPost({ tags: ['projects/tumble/levels', 'projects/lathe'], projects: [] }, projects), { slugs: ['lathe', 'tumble'], unknown: [] });
  assert.deepEqual(projectsOfPost({ tags: [], projects: ['quiet', 'ghost', 'lathe'] }, projects), { slugs: ['lathe', 'quiet'], unknown: ['ghost'] });
  assert.deepEqual(projectsOfPost({ tags: ['projects/lathe'], projects: ['lathe'] }, projects), { slugs: ['lathe'], unknown: [] });
  assert.equal(unknownProjectMessage('ghost', ['tumble', 'lathe']), "projects: unknown project 'ghost' (registered: lathe, tumble)");
  assert.equal(unknownProjectMessage('ghost', []), "projects: unknown project 'ghost' (the site has no projects)");
});

test('the front matter key projects is a list of project slugs without duplicates', () => {
  const read = (/** @type {string} */ yaml) => parsePostSource({ file: 'x.md', slug: 'x', text: `---\ntitle: T\ndate: 2026-01-01\n${yaml}\n---\n\nBody\n` });
  assert.deepEqual(read('').projects, []);
  assert.deepEqual(read('projects: [lathe, tumble, lathe]').projects, ['lathe', 'tumble']);
  assert.deepEqual(read('projects:\n  - " lathe "').projects, ['lathe']);
  assert.throws(() => read('projects: lathe'), /^PostError: x\.md: projects: must be a list$/);
  assert.throws(() => read('projects: [Lathe]'), /x\.md: projects\[0\]: "Lathe" must be the slug of a project/);
  assert.throws(() => read('projects: [a/b]'), /x\.md: projects\[0\]: "a\/b" must be the slug of a project/);
  assert.throws(() => read('projects: [3]'), /x\.md: projects\[0\]: must be a string/);
});

// ---------------------------------------------------------------------------
// The block at the end of a post and the badge near its title.

test('a post with a project tag ends with the project block and has a badge near the title', async () => {
  await inSite(
    {
      ...SITE,
      ...post('news', '2026-02-01', ['projects/lathe']),
      ...post('earlier', '2026-01-01', ['projects/lathe/notes']),
      ...post('plain', '2026-01-15', ['misc']),
    },
    async (root) => {
      await build(root);
      const html = pageHtml(root, '/journal/news/');
      assert.equal(blockCount(html), 1);
      const block = /<section class="project-block"[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
      // The block is the last thing in the article.
      assert.match(html, /<\/section>\s*<\/article>/);
      assert.ok(html.lastIndexOf('<section class="project-block"') > html.indexOf('<div class="post-body">'));
      assert.match(block, /<h2 id="project-block-lathe" class="project-block-title"><a href="\/made\/lathe\/">Lathe<\/a><\/h2>/);
      assert.match(block, /<p class="project-pitch">Turns wood\.<\/p>/);
      assert.match(block, /<a class="project-block-page" href="\/made\/lathe\/">Lathe: project page<\/a>/);
      // Another post about the project (the subtree counts), but not the post itself and not a post about nothing.
      assert.match(block, /<li><a href="\/journal\/earlier\/">Post earlier<\/a> <time datetime="2026-01-01">/);
      assert.doesNotMatch(block, /journal\/news|journal\/plain/);
      // The badge is before the title and links the project.
      const badge = html.indexOf('<a class="project-badge" href="/made/lathe/">Lathe</a>');
      assert.ok(badge !== -1 && badge < html.indexOf('<h1>'), 'the badge comes before the title');

      // A post that is about no project has neither.
      const plain = pageHtml(root, '/journal/plain/');
      assert.doesNotMatch(plain, /project-block|project-badge/);

      assert.deepEqual(await checkFailures(root), []);
    },
  );
});

/**
 * @param {string} root
 * @returns {Promise<string[]>}
 */
async function checkFailures(root) {
  const result = await checkOutput(loadConfig({ configPath: join(root, 'coffer.yaml') }), { out: join(root, 'out') });
  return result.failures.map((failure) => `${failure.file}: ${failure.message}`);
}

test('a post with two project tags gets two blocks and two badges, in the order of the projects page', async () => {
  await inSite(
    { ...SITE, ...post('both', '2026-02-01', ['projects/tumble', 'projects/lathe']) },
    async (root) => {
      await build(root);
      const html = pageHtml(root, '/journal/both/');
      assert.equal(blockCount(html), 2);
      assert.deepEqual(
        [...html.matchAll(/<section class="project-block" aria-labelledby="project-block-([^"]+)"/g)].map((match) => match[1]),
        ['lathe', 'tumble'],
      );
      assert.deepEqual([...html.matchAll(/<a class="project-badge" href="([^"]+)">/g)].map((match) => match[1]), ['/made/lathe/', '/made/tumble/']);
      // Both project feeds are advertised, after the blog feed and the feeds of the post's tags (in the order the post lists them).
      assert.deepEqual(advertised(html), [
        '/journal/feed.xml',
        '/journal/tags/projects/tumble/feed.xml',
        '/journal/tags/projects/lathe/feed.xml',
        '/made/lathe/feed.xml',
        '/made/tumble/feed.xml',
      ]);
    },
  );
});

test('projects: in the front matter is an alternative to the tag, and both together give one block', async () => {
  await inSite(
    {
      ...SITE,
      ...post('explicit', '2026-02-01', ['misc'], 'projects: [tumble]\n'),
      ...post('doubled', '2026-02-02', ['projects/lathe'], 'projects: [lathe]\n'),
    },
    async (root) => {
      await build(root);
      const explicit = pageHtml(root, '/journal/explicit/');
      assert.equal(blockCount(explicit), 1);
      assert.match(explicit, /<a class="project-badge" href="\/made\/tumble\/">Tumble<\/a>/);
      assert.equal(blockCount(pageHtml(root, '/journal/doubled/')), 1);
      // The explicit post is on the project's page and in its feed although it carries no tag.
      assert.deepEqual(feedEntries(outputText(root, 'made/tumble/feed.xml')), ['https://demo.example/journal/explicit/']);
      assert.match(pageHtml(root, '/made/tumble/'), /<a href="\/journal\/explicit\/">Post explicit<\/a>/);
    },
  );
});

test('the block links the documentation only when the project has docs, and the store pages only when they are set', async () => {
  await inSite(
    {
      ...SITE,
      ...project('shop', 'name: Shop\npitch: Sells it.\nkind: game\nstatus: released\ncard: card.png\ntag: projects/shop\norder: 3\nstores:\n  itch: https://shop.itch.example/shop\n  steam:\n'),
      ...project('docced', 'name: Docced\npitch: Has docs.\nkind: tool\nstatus: released\ncard: card.png\nrepo: https://github.example/me/docced\ntag: projects/docced\norder: 4\ndocs:\n  source: { path: . }\n  guides:\n    - { dir: ., include: [index.md] }\n'),
      ...post('p', '2026-02-01', ['projects/lathe', 'projects/shop', 'projects/docced']),
    },
    async (root) => {
      // The docs pages are built from the project's own folder, so the block links them.
      await build(root);
      const html = pageHtml(root, '/journal/p/');
      const blocks = [...html.matchAll(/<section class="project-block" aria-labelledby="project-block-([^"]+)">[\s\S]*?<\/section>/g)];
      /** @type {Record<string, string>} */
      const bySlug = Object.fromEntries(blocks.map((match) => [match[1], match[0]]));
      assert.deepEqual(Object.keys(bySlug), ['lathe', 'shop', 'docced']);
      // A tool without docs: only the project page. No empty list of posts either.
      assert.doesNotMatch(bySlug.lathe, /project-block-docs|project-block-store|project-block-posts/);
      // A game with an itch link: that button, and not the empty Steam one.
      assert.match(bySlug.shop, /<a class="project-block-store project-block-store-itch" href="https:\/\/shop\.itch\.example\/shop" rel="noopener">Get it on itch\.io<\/a>/);
      assert.doesNotMatch(bySlug.shop, /steam|project-block-docs/i);
      // A tool with docs: the same address as on the project's page.
      assert.match(bySlug.docced, /<a class="project-block-docs" href="\/made\/docced\/docs\/">Read the documentation<\/a>/);
      assert.doesNotMatch(html, /<(p|div|section|ul|li|a|h2|h3)[^>]*>\s*<\/\1>/);
    },
  );
});

test('the block lists at most three other recent published posts, and never a draft or a future post', async () => {
  await inSite(
    {
      ...SITE,
      ...post('one', '2026-01-01', ['projects/lathe']),
      ...post('two', '2026-01-02', ['projects/lathe']),
      ...post('three', '2026-01-03', ['projects/lathe']),
      ...post('four', '2026-01-04', ['projects/lathe']),
      ...post('five', '2026-01-05', ['projects/lathe']),
      ...post('secret', '2026-01-06', ['projects/lathe'], 'draft: true\n'),
      ...post('later', '2027-01-01', ['projects/lathe']),
    },
    async (root) => {
      await build(root, { drafts: true });
      const html = pageHtml(root, '/journal/five/');
      const listed = [...(/<div class="project-block-posts">[\s\S]*?<\/div>/.exec(html)?.[0] ?? '').matchAll(/<li><a href="([^"]+)">/g)].map((match) => match[1]);
      assert.deepEqual(listed, ['/journal/four/', '/journal/three/', '/journal/two/']);

      // The draft is built in preview mode and has its own block, but leaks into no list and no feed.
      const draft = pageHtml(root, '/journal/secret/');
      assert.equal(blockCount(draft), 1);
      assert.match(draft, /<a href="\/journal\/five\/">Post five<\/a>/);
      for (const url of ['/journal/five/', '/made/lathe/']) {
        assert.doesNotMatch(pageHtml(root, url), /journal\/secret|journal\/later/);
      }
      const feed = outputText(root, 'made/lathe/feed.xml');
      assert.doesNotMatch(feed, /secret|later/);
      assert.deepEqual(feedEntries(feed), [1, 2, 3, 4, 5].reverse().map((n) => `https://demo.example/journal/${['', 'one', 'two', 'three', 'four', 'five'][n]}/`));
    },
  );
});

test('names are escaped in the badge and the block', async () => {
  await inSite(
    {
      ...project('odd', 'name: "<Odd> & \\"Co\\""\npitch: "Is <b>bold</b>."\nkind: tool\nstatus: released\ncard: card.png\nrepo: https://github.example/me/odd\ntag: projects/odd\n'),
      ...post('p', '2026-02-01', ['projects/odd']),
    },
    async (root) => {
      await build(root);
      const html = pageHtml(root, '/journal/p/');
      assert.match(html, /<a class="project-badge" href="\/made\/odd\/">&lt;Odd&gt; &amp; &quot;Co&quot;<\/a>/);
      assert.match(html, /<p class="project-pitch">Is &lt;b&gt;bold&lt;\/b&gt;\.<\/p>/);
      assert.match(html, /&lt;Odd&gt; &amp; &quot;Co&quot;: project page/);
      assert.doesNotMatch(html, /<Odd>|<b>bold/);
    },
  );
});

test('a theme can replace the project block by overriding the partial', async () => {
  await inSite(
    {
      ...SITE,
      ...post('p', '2026-02-01', ['projects/lathe']),
      'theme/templates/partials/project-block.njk': '<aside class="mine">{{ project.name }}</aside>\n',
    },
    async (root) => {
      writeFileSync(join(root, 'coffer.yaml'), configText().replace('    blogs:', '    theme: theme\n    blogs:'));
      await build(root);
      assert.match(pageHtml(root, '/journal/p/'), /<aside class="mine">Lathe<\/aside>\s*<\/article>/);
    },
  );
});

// ---------------------------------------------------------------------------
// The project page and the project feed.

test('a project page lists its latest posts and links a valid project feed advertised in the head', async () => {
  await inSite(
    {
      ...SITE,
      ...post('a', '2026-01-01', ['projects/lathe']),
      ...post('b', '2026-01-02', ['projects/lathe/deep']),
      ...post('c', '2026-01-03', ['projects/tumble']),
    },
    async (root) => {
      const [result] = await build(root);
      for (const [url, expected, other] of [
        ['/made/lathe/', ['/journal/b/', '/journal/a/'], '/journal/c/'],
        ['/made/tumble/', ['/journal/c/'], '/journal/a/'],
      ]) {
        const html = pageHtml(root, String(url));
        const section = /<section class="project-latest"[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
        assert.deepEqual([...section.matchAll(/<a href="([^"]+)">/g)].map((match) => match[1]), expected);
        assert.ok(!section.includes(String(other)));
        const feed = `${url}feed.xml`;
        assert.deepEqual(advertised(html), [feed, '/journal/feed.xml']);
        assert.match(html, new RegExp(`<p class="feed-link"><a rel="alternate" type="application/atom\\+xml" href="${feed}">Feed of `));
        assert.deepEqual(validateFeed(outputText(root, feed.slice(1)), { selfUrl: `https://demo.example${feed}` }).errors, []);
      }

      // The feed holds the posts of the project's tag subtree, newest first, with their whole text and absolute addresses.
      const lathe = outputText(root, 'made/lathe/feed.xml');
      assert.deepEqual(feedEntries(lathe), ['https://demo.example/journal/b/', 'https://demo.example/journal/a/']);
      assert.match(lathe, /<title>Lathe \| Demo<\/title>/);
      assert.match(lathe, /<subtitle>Turns wood\.<\/subtitle>/);
      assert.match(lathe, /<link rel="alternate" type="text\/html" href="https:\/\/demo\.example\/made\/lathe\/"\/>/);
      assert.match(lathe, /Text of b\./);

      // The manifest lists the feed, so that `coffer check` validates it, and each project's posts.
      const feeds = result.manifest.feeds.filter((feed) => feed.type === 'project');
      assert.deepEqual(
        feeds.map((feed) => [feed.url, feed.project, feed.blog, feed.page, feed.entries]),
        [
          ['/made/lathe/feed.xml', 'lathe', null, '/made/lathe/', 2],
          ['/made/tumble/feed.xml', 'tumble', null, '/made/tumble/', 1],
        ],
      );
      assert.deepEqual(
        result.manifest.projects.map((entry) => [entry.slug, entry.feed, entry.posts]),
        [
          ['lathe', '/made/lathe/feed.xml', ['/journal/b/', '/journal/a/']],
          ['tumble', '/made/tumble/feed.xml', ['/journal/c/']],
        ],
      );
      assert.deepEqual(await checkFailures(root), []);
    },
  );
});

test('the generic project page and the game page list the posts too', async () => {
  await inSite(
    {
      ...SITE,
      ...post('c', '2026-01-03', ['projects/tumble']),
      ...project('plain', 'name: Plain\npitch: A podcast.\nkind: podcast\nstatus: idea\ncard: card.png\ntag: projects/plain\n'),
      ...post('d', '2026-01-04', ['projects/plain']),
    },
    async (root) => {
      const { registerProjectKind, unregisterProjectKind } = await import('../src/content/project-kinds.js');
      registerProjectKind({ name: 'podcast', template: 'project.njk', fields: {} });
      try {
        await build(root);
      } finally {
        unregisterProjectKind('podcast');
      }
      for (const [url, post] of [
        ['/made/tumble/', '/journal/c/'],
        ['/made/plain/', '/journal/d/'],
      ]) {
        const html = pageHtml(root, url);
        assert.match(html, new RegExp(`<section class="project-latest"[\\s\\S]*<a href="${post}">`));
        assert.match(html, /<p class="feed-link">/);
      }
    },
  );
});

test('projects.latestPosts sets how many posts a project page lists, and 0 hides the section', async () => {
  const files = {
    ...SITE,
    ...post('a', '2026-01-01', ['projects/lathe']),
    ...post('b', '2026-01-02', ['projects/lathe']),
    ...post('c', '2026-01-03', ['projects/lathe']),
  };
  /** @type {[string, number][]} */
  const cases = [
    ['{ dir: content/projects, latestPosts: 2 }', 2],
    ['{ dir: content/projects }', 3],
    ['{ dir: content/projects, latestPosts: 0 }', 0],
  ];
  for (const [projects, expected] of cases) {
    await inSite(
      files,
      async (root) => {
        const [result] = await build(root);
        const html = pageHtml(root, '/made/lathe/');
        assert.equal((html.match(/<li class="project-latest-item">/g) ?? []).length, expected);
        if (expected === 0) assert.doesNotMatch(html, /project-latest|Latest posts/);
        // The feed and the manifest are not cut by the count of the page.
        assert.equal(feedEntries(outputText(root, 'made/lathe/feed.xml')).length, 3);
        assert.equal(result.manifest.projects.find((entry) => entry.slug === 'lathe')?.posts.length, 3);
      },
      configText({ projects }),
    );
  }
});

test('the feed holds the latest feeds.limit posts', async () => {
  await inSite(
    {
      ...SITE,
      ...post('a', '2026-01-01', ['projects/lathe']),
      ...post('b', '2026-01-02', ['projects/lathe']),
      ...post('c', '2026-01-03', ['projects/lathe']),
    },
    async (root) => {
      writeFileSync(join(root, 'coffer.yaml'), configText().replace('    blogs:', '    feeds: { limit: 2 }\n    blogs:'));
      await build(root);
      assert.deepEqual(feedEntries(outputText(root, 'made/lathe/feed.xml')), ['https://demo.example/journal/c/', 'https://demo.example/journal/b/']);
    },
  );
});

test('a project that no post is about has an empty feed and no list of posts', async () => {
  await inSite(
    { ...project('quiet', 'name: Quiet\npitch: Nothing yet.\nkind: tool\nstatus: idea\ncard: card.png\nrepo: https://github.example/me/quiet\n'), ...post('x', '2026-01-01', ['misc']) },
    async (root) => {
      await build(root);
      const html = pageHtml(root, '/made/quiet/');
      assert.doesNotMatch(html, /project-latest/);
      assert.match(html, /href="\/made\/quiet\/feed\.xml">Feed of Quiet<\/a>/);
      const feed = outputText(root, 'made/quiet/feed.xml');
      assert.deepEqual(feedEntries(feed), []);
      assert.deepEqual(validateFeed(feed, { selfUrl: 'https://demo.example/made/quiet/feed.xml' }).errors, []);
      assert.deepEqual(await checkFailures(root), []);
    },
  );
});

test('the game call to follow links the project feed, also when the game has no tag', async () => {
  await inSite(
    { ...project('plain', 'name: Plain\npitch: No tag.\nkind: game\nstatus: idea\ncard: card.png\n'), ...post('x', '2026-01-01', ['misc']) },
    async (root) => {
      await build(root);
      assert.match(pageHtml(root, '/made/plain/'), /<a class="game-button game-follow-link" href="\/made\/plain\/feed\.xml">Follow the devlog<\/a>/);
    },
  );
});

test('a site without a blog has no project feed and no call to follow', async () => {
  await inSite(
    { ...project('plain', 'name: Plain\npitch: No blog.\nkind: game\nstatus: idea\ncard: card.png\n') },
    async (root) => {
      const [result] = await build(root);
      const html = pageHtml(root, '/made/plain/');
      assert.doesNotMatch(html, /feed-link|game-follow|rel="alternate"/);
      assert.deepEqual(result.manifest.feeds, []);
      assert.equal(result.manifest.projects[0].feed, null);
    },
    configText({ blogs: [] }).replace('    blogs:\n', '    blogs: []\n'),
  );
});

test('with several blogs a project lists and feeds the posts of all of them, each linked to its own blog', async () => {
  await inSite(
    {
      ...SITE,
      ...post('main', '2026-01-02', ['projects/lathe'], '', 'journal'),
      ...post('side', '2026-01-03', ['projects/lathe'], '', 'notes'),
      ...post('side-only', '2026-01-04', ['misc'], 'projects: [lathe]\n', 'notes'),
    },
    async (root) => {
      await build(root);
      assert.deepEqual(feedEntries(outputText(root, 'made/lathe/feed.xml')), [
        'https://demo.example/notes/side-only/',
        'https://demo.example/notes/side/',
        'https://demo.example/journal/main/',
      ]);
      const html = pageHtml(root, '/made/lathe/');
      assert.deepEqual(
        [...(/<section class="project-latest"[\s\S]*?<\/section>/.exec(html)?.[0] ?? '').matchAll(/<a href="([^"]+)">/g)].map((match) => match[1]),
        ['/notes/side-only/', '/notes/side/', '/journal/main/'],
      );
      // A post of one blog lists the posts of the other in its block.
      assert.match(pageHtml(root, '/journal/main/'), /<li><a href="\/notes\/side-only\/">/);
      // Both blog feeds stay advertised on the project page.
      assert.deepEqual(advertised(html), ['/made/lathe/feed.xml', '/journal/feed.xml', '/notes/feed.xml']);
    },
    configText({ blogs: ['journal', 'notes'] }),
  );
});

test('two projects with the same tag both claim its posts', async () => {
  await inSite(
    { ...SITE, ...project('twin', TOOL.replace('name: Lathe', 'name: Twin').replace('order: 1', 'order: 5')), ...post('p', '2026-02-01', ['projects/lathe']) },
    async (root) => {
      await build(root);
      assert.equal(blockCount(pageHtml(root, '/journal/p/')), 2);
      assert.deepEqual(feedEntries(outputText(root, 'made/twin/feed.xml')), ['https://demo.example/journal/p/']);
    },
  );
});

// ---------------------------------------------------------------------------
// Mistakes.

test('an unknown project in projects: fails the build and names the file', async () => {
  await inSite(
    { ...SITE, ...post('p', '2026-02-01', ['misc'], 'projects: [lathe, ghost]\n') },
    async (root) => {
      const errors = await buildErrors(root);
      assert.deepEqual(errors, ["content/journal/p/index.md projects: unknown project 'ghost' (registered: lathe, tumble)"]);
    },
  );
});

test('an unknown project in a project: link fails the build the same way', async () => {
  await inSite(
    { ...SITE, 'content/journal/p/index.md': '---\ntitle: P\ndate: 2026-02-01\n---\n\nSee [it](project:ghost).\n' },
    async (root) => {
      const errors = await buildErrors(root);
      assert.equal(errors.length, 1);
      assert.match(errors[0], /^content\/journal\/p\/index\.md:\d+:\d+ unknown project 'ghost' in 'project:ghost' \(registered: lathe, tumble\)$/);
    },
  );
});

test('projects: on a site without projects fails the build, and a malformed slug fails with the field', async () => {
  await inSite(
    { ...post('p', '2026-02-01', ['misc'], 'projects: [lathe]\n') },
    async (root) => {
      assert.deepEqual(await buildErrors(root), ["content/journal/p/index.md projects: unknown project 'lathe' (the site has no projects)"]);
    },
    configText({ projects: '' }),
  );
  await inSite({ ...SITE, ...post('p', '2026-02-01', ['misc'], 'projects: [Not A Slug]\n') }, async (root) => {
    const errors = await buildErrors(root);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /content[\\/]journal[\\/]p[\\/]index\.md: projects\[0\]: "Not A Slug" must be the slug of a project/);
  });
});

test('a draft with an unknown project is not checked until a preview build renders it', async () => {
  await inSite({ ...SITE, ...post('p', '2026-02-01', ['misc'], 'draft: true\nprojects: [ghost]\n') }, async (root) => {
    await build(root);
    assert.equal((await buildErrors(root, { drafts: true })).length, 1);
  });
});
