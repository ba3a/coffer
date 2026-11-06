import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { buildSites } from '../src/build.js';
import { checkOutput } from '../src/check/index.js';
import { loadConfig } from '../src/config.js';
import { embedOf, registerProjectKind, unregisterProjectKind } from '../src/content/project-kinds.js';
import { projectStyle } from '../src/content/project-style.js';
import { TINY_PNG } from './helpers/images.js';

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

/** The text of a minimal game: only the required fields. */
const MINIMAL = 'name: Tumble\npitch: Falling joints.\nkind: game\nstatus: in-development\ncard: card.png\n';

/** A made-up video and font: they are copied, never read, so their bytes can be anything. */
const VIDEO = Buffer.from('not really an mp4, but copied as it is');
const FONT = Buffer.from('not really a font, but copied as it is');

/**
 * The files of one game.
 *
 * @param {string} yaml The text of project.yaml.
 * @param {Record<string, string | Buffer>} [extra] More files of the project folder, by name.
 * @param {string} [page] The text of index.md.
 * @param {string} [slug]
 * @returns {Record<string, string | Buffer>}
 */
function game(yaml, extra = {}, page = 'The page text.\n', slug = 'tumble') {
  return {
    [`content/projects/${slug}/project.yaml`]: yaml,
    [`content/projects/${slug}/index.md`]: page,
    [`content/projects/${slug}/card.png`]: TINY_PNG,
    ...Object.fromEntries(Object.entries(extra).map(([name, content]) => [`content/projects/${slug}/${name}`, content])),
  };
}

/**
 * Writes a site into a temporary directory, runs `body` with its root and removes it.
 *
 * @param {Record<string, string | Buffer>} files
 * @param {(root: string) => Promise<void>} body
 */
async function inSite(files, body) {
  const root = mkdtempSync(join(tmpdir(), 'coffer-game-'));
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
 */
function build(root) {
  return buildSites(loadConfig({ configPath: join(root, 'coffer.yaml') }), { out: join(root, 'out'), now: NOW });
}

/**
 * @param {string} root
 * @returns {Promise<string[]>} The errors of a build that must fail.
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
 * The failures of `coffer check` on the build of a site.
 *
 * @param {string} root
 * @returns {Promise<string[]>}
 */
async function checkFailures(root) {
  const result = await checkOutput(loadConfig({ configPath: join(root, 'coffer.yaml') }), { out: join(root, 'out') });
  return result.failures.map((failure) => `${failure.file}: ${failure.message}`);
}

/**
 * The part of a page between its site header and its site footer.
 *
 * @param {string} html
 * @returns {string}
 */
function mainOf(html) {
  return /<main id="main">[\s\S]*<\/main>/.exec(html)?.[0] ?? '';
}

/**
 * @param {string} root
 * @returns {string} The path of the project.yaml of the game "tumble".
 */
function yamlPath(root) {
  return join(root, 'content', 'projects', 'tumble', 'project.yaml');
}

const ITCH = 'https://tumbler.itch.example/tumble';
const STEAM = 'https://store.steampowered.example/app/1/Tumble/';

// ---------------------------------------------------------------------------
// Store buttons and the call to follow the devlog.

test('an itch link makes the itch button appear, and nothing else is offered in its place', async () => {
  await inSite(game(`${MINIMAL}stores:\n  itch: ${ITCH}\n  steam:\n`), async (root) => {
    await build(root);
    const html = pageHtml(root, '/made/tumble/');
    assert.match(html, new RegExp(`<a class="game-button game-store game-store-itch" href="${ITCH}" rel="noopener">Get it on itch\\.io</a>`));
    assert.doesNotMatch(html, /game-store-steam|Wishlist on Steam/);
    assert.doesNotMatch(html, /game-follow|Follow the devlog/);
    assert.match(html, /<div class="game-actions game-stores" role="group" aria-label="Get the game">/);
  });
});

test('a steam link makes the wishlist button appear', async () => {
  await inSite(game(`${MINIMAL}stores:\n  steam: ${STEAM}\n`), async (root) => {
    await build(root);
    const html = pageHtml(root, '/made/tumble/');
    assert.match(html, new RegExp(`<a class="game-button game-store game-store-steam" href="${STEAM}" rel="noopener">Wishlist on Steam</a>`));
    assert.doesNotMatch(html, /game-store-itch|itch\.io|game-follow/);
  });
});

test('with both links both buttons appear, itch first, and the devlog call to action does not', async () => {
  await inSite(game(`${MINIMAL}stores:\n  itch: ${ITCH}\n  steam: ${STEAM}\n`), async (root) => {
    await build(root);
    const html = pageHtml(root, '/made/tumble/');
    const stores = /<div class="game-actions game-stores"[\s\S]*?<\/div>/.exec(html)?.[0] ?? '';
    assert.equal((stores.match(/<a /g) ?? []).length, 2);
    assert.ok(stores.indexOf('game-store-itch') < stores.indexOf('game-store-steam'));
    assert.doesNotMatch(html, /game-follow|Follow the devlog/);
  });
});

test('with no store link the follow-the-devlog call to action appears, and nothing empty or broken with it', async () => {
  for (const stores of ['', 'stores:\n  itch:\n  steam:\n', 'stores:\n  itch: ""\n']) {
    await inSite(game(`${MINIMAL}${stores}`), async (root) => {
      const [result] = await build(root);
      const html = pageHtml(root, '/made/tumble/');
      assert.match(html, /<div class="game-actions game-follow">\s*<p>The game has no store page yet\./);
      // No project tag has posts, so the link is the feed of the first blog; it exists in the output.
      assert.match(html, /<a class="game-button game-follow-link" href="\/journal\/feed\.xml">Follow the devlog<\/a>/);
      assert.ok(result.manifest.feeds.some((feed) => feed.url === '/journal/feed.xml'));
      assert.doesNotMatch(html, /game-store|Get it on itch|Wishlist/);
      assert.doesNotMatch(html, /<(p|div|section|dl|dd|dt|ul|li|a|h2)[^>]*>\s*<\/\1>/);
      assert.doesNotMatch(html, /href=""|href="#"|undefined|null|\[object/);
      assert.deepEqual(await checkFailures(root), []);
    });
  }
});

test('the call to follow links the feed of the project tag when posts carry it', async () => {
  await inSite(
    {
      ...game(`${MINIMAL}tag: projects/tumble\n`),
      'content/journal/dev/index.md': '---\ntitle: Devlog\ndate: 2026-02-01\ntags: [projects/tumble]\n---\n\nProgress.\n',
    },
    async (root) => {
      await build(root);
      assert.match(pageHtml(root, '/made/tumble/'), /<a class="game-button game-follow-link" href="\/journal\/tags\/projects\/tumble\/feed\.xml">/);
      assert.deepEqual(await checkFailures(root), []);
    },
  );
});

test('store links must be http(s) addresses', async () => {
  await inSite(game(`${MINIMAL}stores:\n  itch: javascript:alert(1)\n`), async (root) => {
    assert.deepEqual(await buildErrors(root), [
      `${join(root, 'content', 'projects', 'tumble', 'project.yaml')}: stores: itch: must be an absolute http(s) URL, or empty while it is not set`,
    ]);
  });
});

test('store names other than itch and steam are not shown', async () => {
  await inSite(game(`${MINIMAL}stores:\n  gog: https://gog.example/tumble\n`), async (root) => {
    await build(root);
    const html = pageHtml(root, '/made/tumble/');
    assert.doesNotMatch(html, /gog\.example/);
    assert.match(html, /game-follow/);
  });
});

// ---------------------------------------------------------------------------
// No repository link.

test('a game page has no repository link, and a game cannot declare one', async () => {
  await inSite(game(`${MINIMAL}repo: https://github.example/me/tumble\n`), async (root) => {
    assert.deepEqual(await buildErrors(root), [
      `${join(root, 'content', 'projects', 'tumble', 'project.yaml')}: repo: unknown key for a game (expected one of: name, pitch, kind, status, card, cardAlt, featured, order, tag, license, stores, platforms, price, pressKit, accent, displayFont, displayFontFile, logo, keyArt, keyArtAlt, trailer, trailerPoster, features)`,
    ]);
  });
  await inSite(game(`${MINIMAL}stores:\n  itch: ${ITCH}\nlicense: MIT\n`), async (root) => {
    await build(root);
    const html = pageHtml(root, '/made/tumble/');
    assert.doesNotMatch(html, /project-fact-repo|Source code|github|rel="noopener">[^<]*repo/i);
  });
});

test('the game template shows no repository link even for a kind that has a repo field', async () => {
  registerProjectKind({
    name: 'game-with-repo',
    template: 'project-game.njk',
    fields: { repo: { type: 'url' }, stores: { type: 'url-map' }, platforms: { type: 'string-list' }, features: { type: 'string-list' } },
  });
  try {
    await inSite(game('name: Tumble\npitch: Falling joints.\nkind: game-with-repo\nstatus: idea\ncard: card.png\nrepo: https://github.example/me/tumble\n'), async (root) => {
      await build(root);
      const html = pageHtml(root, '/made/tumble/');
      assert.doesNotMatch(html, /github\.example|Source code|project-fact-repo/);
      assert.match(html, /<h1>Tumble<\/h1>/);
    });
  } finally {
    unregisterProjectKind('game-with-repo');
  }
});

// ---------------------------------------------------------------------------
// Accent colour and display font.

test('the accent colour and the display font restyle the page body only; header and footer are the site\'s', async () => {
  await inSite(game(`${MINIMAL}accent: "#DD6B4D"\ndisplayFont: Fraunces, Georgia, serif\n`), async (root) => {
    await build(root);
    const html = pageHtml(root, '/made/tumble/');
    assert.match(
      html,
      /<div class="game-page" style="--project-accent:#dd6b4d;--project-on-accent:#000;--project-font:&quot;Fraunces&quot;, &quot;Georgia&quot;, serif, var\(--coffer-font-heading\)">/,
    );
    // The wrapper is inside <main>: the header and the footer come before and after it.
    const main = mainOf(html);
    assert.ok(main.startsWith('<main id="main">\n<div class="game-page"'));
    const outside = html.replace(main, '');
    assert.match(outside, /<header class="site-header">/);
    assert.match(outside, /<footer class="site-footer">/);
    assert.doesNotMatch(outside, /--project-|game-page|dd6b4d|Fraunces/);
    // A font that is not shipped is a plain stack: nothing is declared or fetched.
    assert.doesNotMatch(html, /<style|@font-face/);
    // The stylesheet applies the variables to the wrapper's content only.
    const css = readFileSync(join(root, 'out', 'demo', 'assets', 'coffer.css'), 'utf8');
    assert.match(css, /\.game-page h1,[\s\S]*?font-family: var\(--project-font, var\(--coffer-font-heading\)\)/);
    assert.doesNotMatch(css, /\.site-(header|footer)[^{]*\{[^}]*--project-/);
    // Other pages are untouched.
    for (const url of ['/', '/made/', '/journal/']) assert.doesNotMatch(pageHtml(root, url), /--project-|game-page/);
  });
});

test('without an accent or a font the page has no style attribute and no style element', async () => {
  await inSite(game(MINIMAL), async (root) => {
    await build(root);
    const html = pageHtml(root, '/made/tumble/');
    assert.match(html, /<div class="game-page">/);
    assert.doesNotMatch(html, /style=|<style|--project-/);
  });
});

test('a font file in the project folder is published and declared with @font-face under a fixed name', async () => {
  await inSite(
    game(`${MINIMAL}displayFont: Fraunces, Georgia\ndisplayFontFile: fonts/Fraunces-Bold.woff2\n`, { 'fonts/Fraunces-Bold.woff2': FONT }),
    async (root) => {
      const [result] = await build(root);
      const html = pageHtml(root, '/made/tumble/');
      assert.match(
        html,
        /<style>\s*@font-face \{ font-family: "Fraunces"; src: url\("\/made\/tumble\/display-font-file\.woff2"\) format\("woff2"\); font-display: swap; \}\s*<\/style>/,
      );
      assert.ok(html.indexOf('<style>') < html.indexOf('</head>'), 'the declaration is in the head');
      assert.match(html, /--project-font:&quot;Fraunces&quot;, &quot;Georgia&quot;, var\(--coffer-font-heading\)/);
      assert.deepEqual(readFileSync(join(root, 'out', 'demo', 'made', 'tumble', 'display-font-file.woff2')), FONT);
      const entry = result.manifest.projects.find((project) => project.slug === 'tumble');
      assert.deepEqual(entry?.files, [
        {
          field: 'displayFontFile',
          source: 'content/projects/tumble/fonts/Fraunces-Bold.woff2',
          url: '/made/tumble/display-font-file.woff2',
          file: 'made/tumble/display-font-file.woff2',
        },
      ]);
    },
  );
  // Without a family name the font is declared under a fixed one.
  await inSite(game(`${MINIMAL}displayFontFile: wood.otf\n`, { 'wood.otf': FONT }), async (root) => {
    await build(root);
    const html = pageHtml(root, '/made/tumble/');
    assert.match(html, /@font-face \{ font-family: "Project display"; src: url\("\/made\/tumble\/display-font-file\.otf"\) format\("opentype"\)/);
    assert.match(html, /--project-font:&quot;Project display&quot;, var\(--coffer-font-heading\)/);
  });
});

test('the font file address follows the base path of the site', async () => {
  await inSite(
    {
      ...game(`${MINIMAL}displayFontFile: wood.woff2\n`, { 'wood.woff2': FONT }),
      'coffer.yaml': CONFIG.replace('    baseUrl: https://demo.example', '    baseUrl: https://demo.example/site'),
    },
    async (root) => {
      await build(root);
      assert.match(pageHtml(root, '/made/tumble/'), /url\("\/site\/made\/tumble\/display-font-file\.woff2"\)/);
    },
  );
});

test('values that could break out of the CSS or the markup are rejected, and nothing reaches the page', async () => {
  const file = yamlPath;
  /** @type {[string, string | null][]} */
  const bad = [
    ['accent: "red; } body { display: none"', 'accent: must be a colour written as #rgb or #rrggbb'],
    ['accent: "#fff\\" onmouseover=\\"x"', 'accent: must be a colour written as #rgb or #rrggbb'],
    ['accent: "#12345"', 'accent: must be a colour written as #rgb or #rrggbb'],
    ['displayFont: "Fraunces; } * { display: none"', null],
    ['displayFont: "Fraunces\\"><script>alert(1)</script>"', null],
    ["displayFont: \"Fraunces', url(https://evil.example/x)\"", null],
    ['displayFont: "a, </style><script>"', null],
  ];
  for (const [line, message] of bad) {
    await inSite(game(`${MINIMAL}${line}\n`), async (root) => {
      const errors = await buildErrors(root);
      assert.equal(errors.length, 1, line);
      assert.ok(errors[0].startsWith(`${file(root)}: ${line.split(':')[0]}: `), errors[0]);
      if (message !== null) assert.equal(errors[0], `${file(root)}: ${message}`);
    });
  }
  // The module that builds the CSS checks again, so a caller that skips the field check cannot inject either.
  assert.throws(() => projectStyle({ accent: 'red; }' }), /not a colour/);
  assert.throws(() => projectStyle({ displayFont: 'A"; } * { x: y' }), /not a font family name/);
  assert.throws(() => projectStyle({ displayFont: 'A', font: { url: '/a");}/x', format: 'woff2' } }), /not a font file address/);
  assert.throws(() => projectStyle({ displayFont: 'A', font: { url: '/a/x.woff2', format: 'woff2");}' } }), /not a font file address/);
  assert.equal(projectStyle({}), null);
});

test('a font file must be a font in the project folder', async () => {
  const file = yamlPath;
  await inSite(game(`${MINIMAL}displayFontFile: missing.woff2\n`), async (root) => {
    assert.deepEqual(await buildErrors(root), [`${file(root)}: displayFontFile: the file "missing.woff2" does not exist in the project folder`]);
  });
  await inSite(game(`${MINIMAL}displayFontFile: card.png\n`), async (root) => {
    assert.deepEqual(await buildErrors(root), [
      `${file(root)}: displayFontFile: "card.png" must be a font file: one of .woff2, .woff, .ttf, .otf`,
    ]);
  });
  await inSite(game(`${MINIMAL}displayFontFile: ../tumble2/x.woff2\n`), async (root) => {
    assert.deepEqual(await buildErrors(root), [`${file(root)}: displayFontFile: must be a font file inside the project folder`]);
  });
});

// ---------------------------------------------------------------------------
// Trailer.

test('a local trailer is a video with controls, muted and looping, never autoplaying, with a poster', async () => {
  await inSite(
    game(`${MINIMAL}trailer: media/trailer-final.mp4\ntrailerPoster: media/poster.png\n`, {
      'media/trailer-final.mp4': VIDEO,
      'media/poster.png': TINY_PNG,
    }),
    async (root) => {
      const [result] = await build(root);
      const html = pageHtml(root, '/made/tumble/');
      const video = /<video[\s\S]*?<\/video>/.exec(html)?.[0] ?? '';
      assert.match(video, /^<video controls muted loop playsinline preload="metadata" poster="\/img\/[0-9a-f]+\/poster-\d+\.webp" aria-label="Trailer of Tumble">/);
      assert.match(video, /<source src="\/made\/tumble\/trailer\.mp4" type="video\/mp4">/);
      assert.match(video, /<a href="\/made\/tumble\/trailer\.mp4">Download the trailer<\/a>/);
      assert.doesNotMatch(html, /autoplay/i);
      assert.match(html, /<section class="game-trailer" aria-labelledby="game-trailer-title">\s*<h2 id="game-trailer-title">Trailer<\/h2>/);
      assert.deepEqual(readFileSync(join(root, 'out', 'demo', 'made', 'tumble', 'trailer.mp4')), VIDEO);
      const entry = result.manifest.projects.find((project) => project.slug === 'tumble');
      assert.deepEqual(entry?.files.map((file) => [file.field, file.source, file.url]), [
        ['trailer', 'content/projects/tumble/media/trailer-final.mp4', '/made/tumble/trailer.mp4'],
      ]);
      // The poster went through the image pipeline and is in the manifest and in the check.
      assert.ok(result.manifest.images.some((image) => image.source === 'content/projects/tumble/media/poster.png' && image.use === 'card'));
      // `coffer check` resolves the video, its poster and the rest.
      assert.deepEqual(await checkFailures(root), []);
    },
  );
});

test('a webm trailer works the same, without a poster', async () => {
  await inSite(game(`${MINIMAL}trailer: clip.WEBM\n`, { 'clip.WEBM': VIDEO }), async (root) => {
    await build(root);
    const html = pageHtml(root, '/made/tumble/');
    assert.match(html, /<video controls muted loop playsinline preload="metadata" aria-label="Trailer of Tumble">/);
    assert.match(html, /<source src="\/made\/tumble\/trailer\.webm" type="video\/webm">/);
    assert.doesNotMatch(html, /poster=/);
    assert.deepEqual(await checkFailures(root), []);
  });
});

test('an embedded trailer is an iframe of an allowed provider only, built from the video id', async () => {
  await inSite(game(`${MINIMAL}trailer: https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=x\n`), async (root) => {
    await build(root);
    const html = pageHtml(root, '/made/tumble/');
    assert.match(html, /<iframe class="game-embed" src="https:\/\/www\.youtube-nocookie\.com\/embed\/dQw4w9WgXcQ" title="Trailer of Tumble" loading="lazy" allowfullscreen/);
    assert.match(html, /sandbox="allow-scripts allow-same-origin allow-presentation"/);
    assert.doesNotMatch(html, /<video|autoplay/i);
  });
  await inSite(game(`${MINIMAL}trailer: https://vimeo.com/123456789\n`), async (root) => {
    await build(root);
    assert.match(pageHtml(root, '/made/tumble/'), /<iframe class="game-embed" src="https:\/\/player\.vimeo\.com\/video\/123456789\?dnt=1"/);
  });
  assert.deepEqual(embedOf('https://youtu.be/dQw4w9WgXcQ'), { provider: 'youtube', url: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ' });
  assert.deepEqual(embedOf('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ'), { provider: 'youtube', url: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ' });
  assert.deepEqual(embedOf('https://player.vimeo.com/video/42'), { provider: 'vimeo', url: 'https://player.vimeo.com/video/42?dnt=1' });
  for (const refused of [
    'http://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://evil.example/embed/dQw4w9WgXcQ',
    'https://www.youtube.com.evil.example/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com/watch?v=short',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ%22onload%3D',
    'https://www.youtube.com/playlist?list=PL1234567890',
    'https://vimeo.com/channels/staffpicks',
    'https://vimeo.com/abc',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    '//www.youtube.com/watch?v=dQw4w9WgXcQ',
  ]) {
    assert.equal(embedOf(refused), undefined, refused);
  }
});

test('a trailer that is not an allowed address or an existing video file fails the build with the path of project.yaml', async () => {
  const file = yamlPath;
  await inSite(game(`${MINIMAL}trailer: https://evil.example/video.mp4\n`), async (root) => {
    const errors = await buildErrors(root);
    assert.equal(errors.length, 1);
    assert.match(errors[0], new RegExp(`^${file(root).replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}: trailer: an address must be https and from youtube\\.com`));
  });
  await inSite(game(`${MINIMAL}trailer: missing.mp4\n`), async (root) => {
    assert.deepEqual(await buildErrors(root), [`${file(root)}: trailer: the file "missing.mp4" does not exist in the project folder`]);
  });
  await inSite(game(`${MINIMAL}trailer: clip.mov\n`, { 'clip.mov': VIDEO }), async (root) => {
    assert.deepEqual(await buildErrors(root), [`${file(root)}: trailer: "clip.mov" must be a video file: one of .mp4, .webm`]);
  });
  await inSite(game(`${MINIMAL}trailer: ../elsewhere.mp4\n`), async (root) => {
    assert.deepEqual(await buildErrors(root), [`${file(root)}: trailer: must be a video file inside the project folder`]);
  });
  await inSite(game(`${MINIMAL}trailerPoster: nope.png\n`), async (root) => {
    assert.deepEqual(await buildErrors(root), [`${file(root)}: trailerPoster: the file "nope.png" does not exist in the project folder`]);
  });
});

// ---------------------------------------------------------------------------
// Logo, key art, gallery, features, details.

test('logo and key art are pictures from the image pipeline; the key art has its own alt text', async () => {
  await inSite(
    game(`${MINIMAL}logo: logo.png\nkeyArt: art.png\nkeyArtAlt: Blocks in a staircase.\n`, { 'logo.png': TINY_PNG, 'art.png': TINY_PNG }),
    async (root) => {
      const [result] = await build(root);
      const html = pageHtml(root, '/made/tumble/');
      const header = /<header class="project-header game-hero">[\s\S]*?<\/header>/.exec(html)?.[0] ?? '';
      assert.match(header, /<p class="game-logo">\s*<picture>[\s\S]*?alt=""/);
      assert.match(header, /<div class="game-key-art">\s*<picture>[\s\S]*?alt="Blocks in a staircase\."/);
      assert.ok(header.indexOf('game-logo') < header.indexOf('<h1>') && header.indexOf('<h1>') < header.indexOf('game-key-art'));
      const used = result.manifest.images.filter((image) => image.post === '/made/tumble/').map((image) => image.source);
      assert.ok(used.includes('content/projects/tumble/logo.png') && used.includes('content/projects/tumble/art.png'));
      assert.deepEqual(await checkFailures(root), []);
    },
  );
});

test('the first picture of the page is the eager one: the hero picture, then every picture of the text is lazy', async () => {
  const page = '![A shot.](one.png)\n\n![Another.](two.png)\n';
  await inSite(game(`${MINIMAL}logo: logo.png\nkeyArt: art.png\n`, { 'logo.png': TINY_PNG, 'art.png': TINY_PNG, 'one.png': TINY_PNG, 'two.png': TINY_PNG }, page), async (root) => {
    await build(root);
    const loading = [...pageHtml(root, '/made/tumble/').matchAll(/<img [^>]*>/g)].map((tag) => /loading="(\w+)"/.exec(tag[0])?.[1] ?? null);
    assert.deepEqual(loading, ['eager', 'lazy', 'lazy', 'lazy']);
  });
  await inSite(game(MINIMAL, { 'one.png': TINY_PNG, 'two.png': TINY_PNG }, page), async (root) => {
    await build(root);
    const loading = [...pageHtml(root, '/made/tumble/').matchAll(/<img [^>]*>/g)].map((tag) => /loading="(\w+)"/.exec(tag[0])?.[1] ?? null);
    assert.deepEqual(loading, [null, 'lazy']);
  });
});

test('screenshots are a carousel in index.md and open in the viewer', async () => {
  const page = 'Hook.\n\n:::carousel[Screenshots]\n![One.](one.png "First")\n\n![Two.](two.png)\n:::\n';
  await inSite(game(MINIMAL, { 'one.png': TINY_PNG, 'two.png': TINY_PNG }, page), async (root) => {
    await build(root);
    const html = pageHtml(root, '/made/tumble/');
    assert.match(html, /<section class="carousel" aria-label="Screenshots"/);
    assert.match(html, /class="viewer-link"/);
    assert.match(html, /<script src="\/assets\/viewer\.js" defer>/);
    assert.match(html, /<script src="\/assets\/carousel\.js" defer>/);
  });
});

test('features, platforms, price and license are listed, and the status is always shown', async () => {
  await inSite(
    game(`${MINIMAL}platforms: [Linux, Web]\nprice: Free\nlicense: All rights reserved\nfeatures:\n  - Glue\n  - "<b>Joints</b>"\n`),
    async (root) => {
      await build(root);
      const html = pageHtml(root, '/made/tumble/');
      assert.match(html, /<h2 id="game-features-title">Features<\/h2>\s*<ul>\s*<li>Glue<\/li>\s*<li>&lt;b&gt;Joints&lt;\/b&gt;<\/li>\s*<\/ul>/);
      const details = /<section class="project-facts game-details"[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
      assert.match(details, /<dt>Status<\/dt>\s*<dd>In development<\/dd>/);
      assert.match(details, /<dt>Platforms<\/dt>\s*<dd>Linux, Web<\/dd>/);
      assert.match(details, /<dt>Price<\/dt>\s*<dd>Free<\/dd>/);
      assert.match(details, /<dt>License<\/dt>\s*<dd>All rights reserved<\/dd>/);
      assert.match(html, /<p class="all-projects"><a href="\/made\/">All projects<\/a><\/p>/);
    },
  );
});

test('a minimal game renders no empty section, element, link or picture', async () => {
  await inSite(game(MINIMAL, {}, ''), async (root) => {
    await build(root);
    const html = pageHtml(root, '/made/tumble/');
    assert.doesNotMatch(html, /game-logo|game-key-art|game-trailer|game-features|project-body|<video|<iframe|<style|style=/);
    assert.doesNotMatch(html, /<(p|div|section|dl|dd|dt|ul|li|figure|picture)[^>]*>\s*<\/\1>/);
    assert.doesNotMatch(html, /undefined|null|\[object|NaN/);
    const details = /<section class="project-facts game-details"[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
    assert.equal((details.match(/<dt>/g) ?? []).length, 1);
    assert.match(details, /<dt>Status<\/dt>/);
    assert.match(html, /<h1>Tumble<\/h1>\s*<p class="project-pitch">Falling joints\.<\/p>/);
    assert.deepEqual(await checkFailures(root), []);
  });
});

test('the games of a site can have different link sets side by side', async () => {
  await inSite(
    {
      ...game(`${MINIMAL}stores:\n  itch: ${ITCH}\n`, {}, 'A.\n', 'with-itch'),
      ...game(`${MINIMAL.replace('Tumble', 'Both')}stores:\n  itch: ${ITCH}\n  steam: ${STEAM}\n`, {}, 'B.\n', 'with-both'),
      ...game(MINIMAL.replace('Tumble', 'Neither'), {}, 'C.\n', 'with-neither'),
    },
    async (root) => {
      await build(root);
      assert.match(pageHtml(root, '/made/with-itch/'), /game-store-itch/);
      assert.doesNotMatch(pageHtml(root, '/made/with-itch/'), /game-store-steam|game-follow/);
      assert.equal((pageHtml(root, '/made/with-both/').match(/game-store /g) ?? []).length, 2);
      assert.match(pageHtml(root, '/made/with-neither/'), /game-follow/);
      assert.doesNotMatch(pageHtml(root, '/made/with-neither/'), /game-store /);
    },
  );
});
