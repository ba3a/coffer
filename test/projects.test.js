import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import exifr from 'exifr';

import { buildSites } from '../src/build.js';
import { run } from '../src/cli.js';
import { loadConfig } from '../src/config.js';
import { registerProjectKind, unregisterProjectKind } from '../src/content/project-kinds.js';
import { ReportError } from '../src/report.js';
import { TINY_JPEG, TINY_PNG, geotaggedPhoto } from './helpers/images.js';

const NOW = new Date('2026-06-01T12:00:00Z');

const CONFIG = [
  'sites:',
  '  - id: demo',
  '    baseUrl: https://demo.example',
  '    lang: en',
  '    title: Demo',
  '    description: A demo site.',
  '    blogs:',
  '      - { id: journal, dir: content/journal, prefix: journal, title: Journal }',
  '    projects: { dir: content/projects }',
  '',
].join('\n');

const HOME = '---\ntitle: Demo\n---\n\nAbout the demo.\n';
const POST = '---\ntitle: A post\ndate: 2026-01-10\n---\n\nText.\n';

/**
 * @param {Record<string, unknown>} [extra] Replaces or adds keys; a value of `null` removes the key.
 * @returns {string} A valid `project.yaml` of a tool.
 */
function toolYaml(extra = {}) {
  /** @type {Record<string, unknown>} */
  const fields = {
    name: 'Lathe',
    pitch: 'Turns wood.',
    kind: 'tool',
    status: 'released',
    card: 'card.png',
    repo: 'https://github.example/me/lathe',
    ...extra,
  };
  return Object.entries(fields)
    .filter(([, value]) => value !== null)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join('\n');
}

/**
 * The files of one project.
 *
 * @param {string} slug
 * @param {string} yaml
 * @param {string} [page]
 * @returns {Record<string, string | Buffer>}
 */
function project(slug, yaml, page = 'The page text.\n') {
  return {
    [`content/projects/${slug}/project.yaml`]: yaml,
    [`content/projects/${slug}/index.md`]: page,
    [`content/projects/${slug}/card.png`]: TINY_PNG,
  };
}

/**
 * Writes a site into a temporary directory, runs `body` with its root and removes it.
 *
 * @param {Record<string, string | Buffer>} files
 * @param {(root: string) => Promise<void>} body
 */
async function inSite(files, body) {
  const root = mkdtempSync(join(tmpdir(), 'coffer-projects-'));
  try {
    const all = {
      'coffer.yaml': CONFIG,
      'content/home.md': HOME,
      'content/journal/first/index.md': POST,
      ...files,
    };
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
 * @param {{ drafts?: boolean }} [options]
 */
function build(root, options = {}) {
  return buildSites(loadConfig({ configPath: join(root, 'coffer.yaml') }), {
    out: join(root, 'out'),
    now: NOW,
    ...options,
  });
}

/**
 * Runs a build that must fail and returns its errors.
 *
 * @param {string} root
 * @returns {Promise<string[]>}
 */
async function buildErrors(root) {
  try {
    await build(root);
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
 * The cards of the showcase of a page, in page order, as [name, href] pairs.
 *
 * @param {string} html
 * @returns {string[][]}
 */
function cards(html) {
  return [...html.matchAll(/<h[23] class="project-card-title"><a href="([^"]+)">([^<]+)<\/a>/g)].map((m) => [m[2], m[1]]);
}

const TWO = {
  ...project('lathe', toolYaml({ featured: true, order: 2 })),
  ...project(
    'tumble',
    'name: Tumble\npitch: Falling joints.\nkind: game\nstatus: in-development\ncard: card.png\nfeatured: true\norder: 1\nstores:\n  itch:\n',
  ),
  ...project('quiet', toolYaml({ name: 'Quiet', pitch: 'Not featured.', featured: false, order: 0 })),
};

test('adding a project folder adds a page and a card to the projects page, with no code', async () => {
  await inSite(project('lathe', toolYaml()), async (root) => {
    const [result] = await build(root);
    assert.ok(result.manifest.pages.some((entry) => entry.url === '/made/' && entry.type === 'project-index'));
    assert.ok(result.manifest.pages.some((entry) => entry.url === '/made/lathe/' && entry.type === 'project'));
    assert.deepEqual(cards(pageHtml(root, '/made/')), [['Lathe', '/made/lathe/']]);
    const html = pageHtml(root, '/made/lathe/');
    assert.match(html, /<h1>Lathe<\/h1>/);
    assert.match(html, /<p class="project-pitch">Turns wood\.<\/p>/);
    assert.match(html, /<div class="project-body">\s*<p>The page text\.<\/p>/);
  });
  // A second folder is all it takes to add a second project.
  await inSite({ ...project('lathe', toolYaml()), ...project('plane', toolYaml({ name: 'Plane' })) }, async (root) => {
    await build(root);
    assert.deepEqual(cards(pageHtml(root, '/made/')), [
      ['Lathe', '/made/lathe/'],
      ['Plane', '/made/plane/'],
    ]);
  });
});

test('the projects page shows name, pitch, picture and kind of every project, featured or not', async () => {
  await inSite(TWO, async (root) => {
    await build(root);
    const html = pageHtml(root, '/made/');
    assert.deepEqual(cards(html).map(([name]) => name), ['Quiet', 'Tumble', 'Lathe']);
    assert.match(html, /<span class="project-kind">Game<\/span>/);
    assert.match(html, /<span class="project-kind">Tool<\/span>/);
    assert.match(html, /<span class="project-status">In development<\/span>/);
    assert.match(html, /<p class="project-pitch">Falling joints\.<\/p>/);
    assert.equal(html.split('<picture>').length - 1, 3, 'a picture on every card');
    assert.match(html, /<h1>Projects<\/h1>/);
    assert.match(html, /<nav aria-label="Main navigation">[\s\S]*<a href="\/made\/">Projects<\/a>/);
  });
});

test('the home showcase lists the featured projects in the declared order, with picture, pitch and kind', async () => {
  await inSite(TWO, async (root) => {
    await build(root);
    const html = pageHtml(root, '/');
    assert.deepEqual(cards(html), [
      ['Tumble', '/made/tumble/'],
      ['Lathe', '/made/lathe/'],
    ]);
    assert.doesNotMatch(html, /Quiet|Not featured/);
    const showcase = /<section class="showcase">[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
    assert.match(showcase, /<h2>Projects<\/h2>/);
    assert.match(showcase, /<p class="project-pitch">Falling joints\.<\/p>/);
    assert.match(showcase, /<span class="project-kind">Game<\/span>/);
    assert.match(showcase, /<span class="project-kind">Tool<\/span>/);
    assert.equal(showcase.split('<picture>').length - 1, 2);
    assert.match(showcase, /<a href="\/made\/">All projects<\/a>/);
  });
});

test('changing order in project.yaml changes the showcase without touching code', async () => {
  const swapped = {
    ...TWO,
    'content/projects/lathe/project.yaml': toolYaml({ featured: true, order: 0 }),
  };
  await inSite(swapped, async (root) => {
    await build(root);
    assert.deepEqual(cards(pageHtml(root, '/')).map(([name]) => name), ['Lathe', 'Tumble']);
  });
});

test('projects without an order come after those with one, by name; no featured project means no showcase', async () => {
  await inSite(
    {
      ...project('b', toolYaml({ name: 'Bravo', featured: true })),
      ...project('a', toolYaml({ name: 'Alpha', featured: true })),
      ...project('c', toolYaml({ name: 'Charlie', featured: true, order: 5 })),
    },
    async (root) => {
      await build(root);
      assert.deepEqual(cards(pageHtml(root, '/')).map(([name]) => name), ['Charlie', 'Alpha', 'Bravo']);
    },
  );
  await inSite(project('lathe', toolYaml({ featured: false })), async (root) => {
    await build(root);
    assert.doesNotMatch(pageHtml(root, '/'), /showcase/);
  });
});

test('card pictures go through the image pipeline and are listed in the manifest', async () => {
  await inSite(project('lathe', toolYaml({ featured: true })), async (root) => {
    const [result] = await build(root);
    const html = pageHtml(root, '/');
    assert.match(html, /<source type="image\/webp" srcset="\/img\/[0-9a-f]+\/card-\d+\.webp \d+w/);
    assert.match(html, /<img src="\/img\/[0-9a-f]+\/card-\d+\.webp" alt="" width="\d+" height="\d+" loading="lazy" decoding="async">/);
    const images = result.manifest.images.filter((image) => image.use === 'card');
    assert.equal(images.length, 1);
    assert.equal(images[0].source, 'content/projects/lathe/card.png');
    assert.equal(images[0].post, '/made/lathe/');
    assert.equal(images[0].policy.location.value, 'strip');
    // The original never reaches the output.
    assert.equal(readFileSync(join(root, 'out', 'demo', images[0].outputs[0].file)).length > 0, true);
    // The project page uses the card picture as its link preview.
    assert.match(pageHtml(root, '/made/lathe/'), /<meta property="og:image" content="https:\/\/demo\.example\/img\/[0-9a-f]+\/card-\d+\.webp">/);
  });
});

test('the card alt text comes from cardAlt', async () => {
  await inSite(project('lathe', toolYaml({ cardAlt: 'A lathe in a shed' })), async (root) => {
    await build(root);
    assert.match(pageHtml(root, '/made/'), /alt="A lathe in a shed"/);
  });
});

test('the manifest lists the projects in showcase order and the sitemap lists their pages', async () => {
  await inSite(TWO, async (root) => {
    const [result] = await build(root);
    assert.deepEqual(
      result.manifest.projects.map((entry) => [entry.slug, entry.kind, entry.status, entry.featured, entry.order, entry.tag]),
      [
        ['quiet', 'tool', 'released', false, 0, null],
        ['tumble', 'game', 'in-development', true, 1, null],
        ['lathe', 'tool', 'released', true, 2, null],
      ],
    );
    assert.deepEqual(
      result.manifest.sitemap.filter((url) => url.startsWith('/made/')),
      ['/made/', '/made/lathe/', '/made/quiet/', '/made/tumble/'],
    );
  });
});

test('project: links in posts and in project pages point at the project page', async () => {
  await inSite(
    {
      ...project('lathe', toolYaml(), 'See [the game](project:tumble#top) and [the post](../../journal/first/).\n'),
      ...project('tumble', 'name: Tumble\npitch: Falling joints.\nkind: game\nstatus: idea\ncard: card.png\n'),
      'content/journal/first/index.md': `${POST}\nRead [about it](project:lathe) or [more](project:lathe?x=1#top).\n`,
    },
    async (root) => {
      await build(root);
      const post = pageHtml(root, '/journal/first/');
      assert.match(post, /<a href="\/made\/lathe\/">about it<\/a>/);
      assert.match(post, /<a href="\/made\/lathe\/\?x=1#top">more<\/a>/);
      const page = pageHtml(root, '/made/lathe/');
      assert.match(page, /<a href="\/made\/tumble\/#top">the game<\/a>/);
      assert.match(page, /<a href="\/journal\/first\/">the post<\/a>/);
      assert.doesNotMatch(post + page, /project:/);
    },
  );
});

test('project pages are found by the link check: an unknown project or a broken link in a page fails the build', async () => {
  await inSite(
    project('lathe', toolYaml(), 'A [bad](project:nope) link, a [gone](../missing/) one and ![x](missing.png).\n'),
    async (root) => {
      assert.deepEqual(await buildErrors(root), [
        "content/projects/lathe/index.md:1:3 unknown project 'nope' in 'project:nope' (registered: lathe)",
        "content/projects/lathe/index.md:1:31 broken link '../missing/'",
        "content/projects/lathe/index.md:1:59 missing image 'missing.png'",
      ]);
    },
  );
});

test('images and carousels in a project page work like in a post', async () => {
  const page = [
    'A shot of the shop.',
    '',
    '![The shop](shop.jpg "Morning light")',
    '',
    ':::carousel',
    '![One](shop.jpg)',
    '![Two](shop.jpg)',
    ':::',
    '',
  ].join('\n');
  await inSite(
    { ...project('lathe', toolYaml(), page), 'content/projects/lathe/shop.jpg': TINY_JPEG },
    async (root) => {
      const [result] = await build(root);
      const html = pageHtml(root, '/made/lathe/');
      assert.match(html, /<figcaption>Morning light<\/figcaption>/);
      assert.match(html, /class="carousel"/);
      assert.match(html, /<script src="\/assets\/carousel\.js" defer>/);
      assert.match(html, /<script src="\/assets\/viewer\.js" defer>/);
      assert.ok(result.manifest.images.some((image) => image.use === 'body' && image.post === '/made/lathe/'));
    },
  );
});

test('a ::map in a project page is left out with a warning, not an empty element', async () => {
  await inSite(project('lathe', toolYaml(), 'Text.\n\n::map\n\nMore.\n'), async (root) => {
    const [result] = await build(root);
    assert.doesNotMatch(pageHtml(root, '/made/lathe/'), /data-coffer-map|class="map/);
    assert.ok(
      result.warnings.some((message) => message.includes('content/projects/lathe/index.md:3') && /::map/.test(message)),
      result.warnings.join('\n'),
    );
  });
});

test('an unknown kind fails the build with the path of project.yaml', async () => {
  await inSite(project('lathe', toolYaml({ kind: 'podcast' })), async (root) => {
    const errors = await buildErrors(root);
    assert.equal(errors.length, 1);
    assert.equal(
      errors[0],
      `${join(root, 'content', 'projects', 'lathe', 'project.yaml')}: kind: unknown kind "podcast" (known kinds: game, tool)`,
    );
  });
});

test('a missing required field fails the build with the path of project.yaml', async () => {
  await inSite(
    { ...project('lathe', toolYaml({ pitch: null, repo: null })), ...project('ok', toolYaml({ name: 'Fine' })) },
    async (root) => {
      const file = join(root, 'content', 'projects', 'lathe', 'project.yaml');
      assert.deepEqual(await buildErrors(root), [
        `${file}: pitch: is required`,
        `${file}: repo: is required for a tool (an http(s) URL)`,
      ]);
      const report = JSON.parse(readFileSync(join(root, '.coffer', 'report.json'), 'utf8'));
      assert.equal(report.errors.length, 2);
    },
  );
});

test('a project without index.md or without project.yaml fails the build with the missing path', async () => {
  await inSite(
    {
      'content/projects/nopage/project.yaml': toolYaml(),
      'content/projects/nopage/card.png': TINY_PNG,
      'content/projects/noyaml/index.md': 'Text.\n',
    },
    async (root) => {
      assert.deepEqual(await buildErrors(root), [
        `${join(root, 'content', 'projects', 'nopage', 'index.md')}: missing; every project folder needs an index.md with the text of the page`,
        `${join(root, 'content', 'projects', 'noyaml', 'project.yaml')}: missing; every project folder needs a project.yaml`,
      ]);
    },
  );
});

test('a card picture that cannot be decoded is reported with project.yaml', async () => {
  await inSite(
    { ...project('lathe', toolYaml()), 'content/projects/lathe/card.png': Buffer.from('not an image') },
    async (root) => {
      const errors = await buildErrors(root);
      assert.equal(errors.length, 1);
      assert.match(errors[0], /^content\/projects\/lathe\/project\.yaml card: image 'card\.png': /);
    },
  );
});

test('a site without projects has no projects page and no navigation entry for it', async () => {
  await inSite({ 'coffer.yaml': CONFIG.replace('    projects: { dir: content/projects }\n', '') }, async (root) => {
    const [result] = await build(root);
    assert.deepEqual(result.manifest.projects, []);
    assert.ok(!result.manifest.pages.some((entry) => entry.url === '/made/'));
    assert.doesNotMatch(pageHtml(root, '/'), /showcase|href="\/made\/"/);
  });
});

test('a site with an empty projects folder says there are no projects yet', async () => {
  await inSite({ 'content/projects/.keep': '' }, async (root) => {
    await build(root);
    assert.match(pageHtml(root, '/made/'), /<p class="empty">No projects yet\.<\/p>/);
    assert.doesNotMatch(pageHtml(root, '/'), /class="showcase"/);
  });
});

test('the projects prefix comes from urls.projects', async () => {
  await inSite(
    { ...project('lathe', toolYaml({ featured: true })), 'coffer.yaml': CONFIG.replace('    projects:', '    urls: { projects: built }\n    projects:') },
    async (root) => {
      const [result] = await build(root);
      assert.ok(result.manifest.pages.some((entry) => entry.url === '/built/lathe/'));
      assert.match(pageHtml(root, '/'), /<a href="\/built\/lathe\/">Lathe<\/a>/);
    },
  );
});

test('a kind registered with a template renders its projects with that template and validates its fields', async () => {
  registerProjectKind({
    name: 'podcast',
    template: 'project-podcast.njk',
    fields: { feed: { type: 'url', required: true }, hosts: { type: 'string-list' } },
  });
  try {
    const theme = {
      'theme/templates/project-podcast.njk':
        '{% extends "project.njk" %}{% block project_footer %}<p class="podcast">{{ project.fields.feed }} / {{ project.fields.hosts | join(" & ") }}</p>{% endblock %}',
    };
    const podcast = (/** @type {string} */ extra) =>
      project('radio', `name: Radio\npitch: Talk.\nkind: podcast\nstatus: released\ncard: card.png\n${extra}`);
    await inSite(
      {
        ...podcast('feed: https://radio.example/feed.xml\nhosts: [Tove, Ann]\n'),
        ...theme,
        'coffer.yaml': CONFIG.replace('    projects:', '    theme: theme\n    projects:'),
      },
      async (root) => {
        const [result] = await build(root);
        assert.match(pageHtml(root, '/made/radio/'), /<p class="podcast">https:\/\/radio\.example\/feed\.xml \/ Tove &amp; Ann<\/p>/);
        // A kind without its own strings is shown under its own name.
        assert.match(pageHtml(root, '/made/'), /<span class="project-kind">podcast<\/span>/);
        assert.equal(result.manifest.projects[0].kind, 'podcast');
      },
    );
    await inSite({ ...podcast('feed: ftp://radio.example\nhosts: Tove\n'), ...theme }, async (root) => {
      const file = join(root, 'content', 'projects', 'radio', 'project.yaml');
      assert.deepEqual(await buildErrors(root), [
        `${file}: feed: must be an absolute http(s) URL`,
        `${file}: hosts: must be a list`,
      ]);
    });
  } finally {
    unregisterProjectKind('podcast');
  }
});

test('a theme can override one block of the project page', async () => {
  await inSite(
    {
      ...project('lathe', toolYaml()),
      'theme/templates/project.njk':
        '{% extends "coffer:project.njk" %}{% block project_header %}<h1 class="mine">{{ project.name }}!</h1>{% endblock %}',
      'coffer.yaml': CONFIG.replace('    projects:', '    theme: theme\n    projects:'),
    },
    async (root) => {
      await build(root);
      const html = pageHtml(root, '/made/lathe/');
      assert.match(html, /<h1 class="mine">Lathe!<\/h1>/);
      assert.match(html, /<div class="project-body">/);
    },
  );
});

test('the game fields are read: stores with a link are kept, the others are dropped', async () => {
  const { loadProjects } = await import('../src/content/projects.js');
  await inSite(
    project(
      'tumble',
      'name: Tumble\npitch: P.\nkind: game\nstatus: idea\ncard: card.png\nplatforms: [Linux]\nprice: Free\naccent: "#DD6B4D"\ndisplayFont: Handjet\nstores:\n  itch: https://x.itch.example/tumble\n  steam:\n',
    ),
    async (root) => {
      const [loaded] = loadProjects(join(root, 'content', 'projects'));
      assert.deepEqual(loaded.fields, {
        stores: { itch: 'https://x.itch.example/tumble' },
        platforms: ['Linux'],
        price: 'Free',
        pressKit: null,
        accent: '#dd6b4d',
        displayFont: 'Handjet',
      });
    },
  );
});

test('ReportError is what a build with problems in the pages throws', async () => {
  await inSite(project('lathe', toolYaml(), '[x](project:nope)\n'), async (root) => {
    await assert.rejects(build(root), ReportError);
  });
});

// ---------------------------------------------------------------------------
// The command line, address collisions and the metadata policy of card pictures.

/**
 * Runs `coffer build` on a site written by `inSite`.
 *
 * @param {string} root
 * @returns {Promise<{ code: number, out: string, err: string }>}
 */
async function runBuildCommand(root) {
  let out = '';
  let err = '';
  const code = await run(['build', '--config', join(root, 'coffer.yaml'), '--out', join(root, 'out'), '--now', '2026-06-01'], {
    out: (text) => {
      out += text;
    },
    err: (text) => {
      err += text;
    },
  });
  return { code, out, err };
}

test('coffer build prints the problems of a project with its path and exits 1, with no stack trace', async () => {
  await inSite(
    { ...project('lathe', toolYaml({ kind: 'podcast' })), ...project('lamp', toolYaml({ repo: null })) },
    async (root) => {
      const result = await runBuildCommand(root);
      assert.equal(result.code, 1);
      assert.equal(
        result.err,
        `${join(root, 'content', 'projects', 'lamp', 'project.yaml')}: repo: is required for a tool (an http(s) URL)\n` +
          `${join(root, 'content', 'projects', 'lathe', 'project.yaml')}: kind: unknown kind "podcast" (known kinds: game, tool)\n`,
      );
      assert.doesNotMatch(result.err, /\n\s+at /);
    },
  );
});

test('a project folder named like the blog under the projects prefix fails the build, naming project.yaml', async () => {
  await inSite(
    {
      ...project('journal', toolYaml({ name: 'Journal tool' })),
      'coffer.yaml': CONFIG.replace('prefix: journal', 'prefix: made/journal'),
    },
    async (root) => {
      const errors = await buildErrors(root);
      assert.equal(errors.length, 1, errors.join('\n'));
      assert.match(errors[0], /^content\/projects\/journal\/project\.yaml /);
      assert.match(errors[0], /\/made\/journal\/.*journal\/index\.html.*blog-index \/made\/journal\//);
    },
  );
});

test('a project folder under a blog prefix that does not collide still builds', async () => {
  await inSite(
    { ...project('journal', toolYaml()), 'coffer.yaml': CONFIG.replace('prefix: journal', 'prefix: made/log') },
    async (root) => {
      const [result] = await build(root);
      assert.ok(result.manifest.pages.some((entry) => entry.url === '/made/journal/'));
      assert.ok(result.manifest.pages.some((entry) => entry.url === '/made/log/'));
    },
  );
});

test('urls.projects cannot be a folder the build writes itself', async () => {
  for (const name of ['assets', 'img', 'cards']) {
    await inSite(
      { ...project('lathe', toolYaml()), 'coffer.yaml': CONFIG.replace('    projects:', `    urls: { projects: ${name} }\n    projects:`) },
      async (root) => {
        assert.throws(
          () => loadConfig({ configPath: join(root, 'coffer.yaml') }),
          (error) => error instanceof Error && error.message.includes(`urls.projects: "${name}" is a name the build writes itself`),
          name,
        );
      },
    );
  }
});

/**
 * Files of a project whose card carries a position and camera fields.
 *
 * @param {string} slug
 * @returns {Promise<Record<string, string | Buffer>>}
 */
async function geotaggedProject(slug) {
  return {
    [`content/projects/${slug}/project.yaml`]: toolYaml({ card: 'card.jpg', featured: true }),
    [`content/projects/${slug}/index.md`]: 'The page text.\n',
    [`content/projects/${slug}/card.jpg`]: await geotaggedPhoto(),
  };
}

/**
 * The positions found in the published files of the card pictures of a build.
 *
 * @param {string} root
 * @param {Awaited<ReturnType<typeof build>>[number]} result
 * @returns {Promise<{ files: number, positions: ({ latitude: number, longitude: number } | undefined)[], cameras: unknown[], viewerPositions: ({ latitude: number, longitude: number } | undefined)[] }>}
 */
async function publishedCardMetadata(root, result) {
  const cards = result.manifest.images.filter((image) => image.use === 'card');
  const outputs = cards.flatMap((image) => image.outputs);
  const files = outputs.map((output) => join(root, 'out', 'demo', output.file));
  const positions = [];
  const viewerPositions = [];
  const cameras = [];
  for (const [index, file] of files.entries()) {
    const position = (await exifr.gps(readFileSync(file)).catch(() => undefined)) ?? undefined;
    positions.push(position);
    if (outputs[index].role === 'viewer') viewerPositions.push(position);
    cameras.push((await exifr.parse(readFileSync(file), { pick: ['Make', 'Model', 'SerialNumber', 'BodySerialNumber'] }).catch(() => undefined)) ?? undefined);
  }
  return { files: files.length, positions, cameras, viewerPositions };
}

test('a project card with a position publishes none under the default strip policy', async () => {
  await inSite(await geotaggedProject('lathe'), async (root) => {
    const [result] = await build(root);
    const card = result.manifest.images.find((image) => image.use === 'card');
    assert.ok(card);
    assert.equal(card.policy.location.value, 'strip');
    assert.equal(card.gps, null, 'the manifest has no position either');
    const published = await publishedCardMetadata(root, result);
    assert.ok(published.files >= 2, 'every size of the card was checked');
    assert.ok(published.positions.every((position) => position === undefined), JSON.stringify(published.positions));
    assert.ok(published.cameras.every((camera) => !camera || Object.keys(camera).length === 0), JSON.stringify(published.cameras));
    assert.deepEqual(result.exactLocations, [], 'the build report does not list the project as publishing exact locations');
    assert.doesNotMatch(readFileSync(join(root, 'out', 'demo', '.coffer-manifest.json'), 'utf8'), /"latitude"/);
  });
});

test('a project card keeps its position only when the site policy says keep, and then the build report lists the project', async () => {
  await inSite(
    { ...(await geotaggedProject('lathe')), 'coffer.yaml': `${CONFIG}    location: { default: keep }\n` },
    async (root) => {
      const [result] = await build(root);
      const card = result.manifest.images.find((image) => image.use === 'card');
      assert.equal(card?.policy.location.value, 'keep');
      const published = await publishedCardMetadata(root, result);
      assert.equal(published.viewerPositions.length, 1);
      assert.ok(published.viewerPositions.every((position) => position !== undefined), 'the full-size picture of the card carries the position');
      assert.equal(published.positions.filter((position) => position !== undefined).length, 1, 'no other file does');
      assert.deepEqual(
        result.exactLocations.map((entry) => entry.file),
        ['content/projects/lathe/index.md'],
      );
    },
  );
});
