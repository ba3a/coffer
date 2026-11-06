import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import exifr from 'exifr';
import sharp from 'sharp';

import { MANIFEST_FILE_NAME, buildSites } from '../src/build.js';
import { loadConfig } from '../src/config.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const exampleConfig = join(root, 'example', 'coffer.yaml');
const bin = join(root, 'bin', 'coffer.js');

/** A moment after the first post and well before the future-dated one. */
const NOW = new Date('2026-06-01T12:00:00Z');

/**
 * Builds the example site into a temporary directory and passes the site's
 * output directory and its manifest to `body`.
 *
 * @param {{ drafts?: boolean }} options
 * @param {(site: string, manifest: import('../src/build.js').Manifest) => void | Promise<void>} body
 */
async function withExample(options, body) {
  const out = mkdtempSync(join(tmpdir(), 'coffer-example-'));
  try {
    const config = loadConfig({ configPath: exampleConfig });
    const [result] = await buildSites(config, { out, now: NOW, ...options });
    await body(result.outDir, result.manifest);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/**
 * @param {string} site
 * @param {string} url
 * @returns {string}
 */
function page(site, url) {
  return readFileSync(join(site, ...url.split('/').filter(Boolean), 'index.html'), 'utf8');
}

test('the example site builds the blog index, the published post and the assets', async () => {
  await withExample({}, (site) => {
    assert.ok(existsSync(join(site, 'journal', 'index.html')));
    assert.ok(existsSync(join(site, 'journal', 'first-dovetail', 'index.html')));
    assert.ok(existsSync(join(site, 'assets', 'coffer.css')));
    assert.match(page(site, '/journal/'), /<a href="\/journal\/first-dovetail\/">My first hand-cut dovetail<\/a>/);
  });
});

test('the draft and the future-dated post are absent from a normal build', async () => {
  await withExample({}, (site, manifest) => {
    assert.equal(existsSync(join(site, 'journal', 'planer-notes')), false);
    assert.equal(existsSync(join(site, 'journal', 'spring-open-house')), false);
    assert.deepEqual(
      manifest.posts.map((post) => post.slug),
      ['first-dovetail', 'mountain-weekend', 'photo-notes', 'ridge-walk', 'walnut-box'],
    );
    const index = page(site, '/journal/');
    assert.doesNotMatch(index, /planer-notes|Spring open house/);
  });
});

test('preview mode builds the draft and the future-dated post and says so', async () => {
  await withExample({ drafts: true }, (site, manifest) => {
    assert.ok(existsSync(join(site, 'journal', 'planer-notes', 'index.html')));
    assert.ok(existsSync(join(site, 'journal', 'spring-open-house', 'index.html')));
    assert.equal(manifest.drafts, true);
    const bySlug = Object.fromEntries(manifest.posts.map((post) => [post.slug, post]));
    assert.equal(bySlug['planer-notes'].draft, true);
    assert.equal(bySlug['planer-notes'].published, false);
    assert.equal(bySlug['spring-open-house'].published, false);
    assert.equal(bySlug['first-dovetail'].published, true);
    assert.match(page(site, '/journal/planer-notes/'), /class="preview-note"/);
    assert.doesNotMatch(page(site, '/journal/first-dovetail/'), /preview-note/);
  });
});

test('post URLs are /journal/{slug}/ whatever the date and the tags', async () => {
  await withExample({ drafts: true }, (_site, manifest) => {
    for (const post of manifest.posts) {
      assert.equal(post.url, `/journal/${post.slug}/`);
      assert.equal(post.file, `journal/${post.slug}/index.html`);
    }
  });
});

test('the post page shows title, date, reading time, the table of contents and the body', async () => {
  await withExample({}, (site) => {
    const html = page(site, '/journal/first-dovetail/');
    assert.match(html, /<h1>My first hand-cut dovetail<\/h1>/);
    assert.match(html, /<time datetime="2025-03-14">Published Mar 14, 2025<\/time>/);
    assert.match(html, /\d+ minutes?/);
    const toc = html.indexOf('<details class="toc">');
    const body = html.indexOf('<div class="post-body">');
    assert.ok(toc !== -1 && body !== -1 && toc < body, 'the TOC comes before the body');
    assert.match(html, /<a href="#marking-out">Marking out<\/a>/);
    assert.match(html, /<h2 id="marking-out">/);
    assert.match(html, /<link rel="stylesheet" href="\/assets\/coffer\.css">/);
  });
});

test('the manifest is written and lists the pages and the posts', async () => {
  await withExample({}, (site, manifest) => {
    assert.equal(MANIFEST_FILE_NAME, '.coffer-manifest.json');
    const onDisk = JSON.parse(readFileSync(join(site, MANIFEST_FILE_NAME), 'utf8'));
    assert.deepEqual(onDisk, manifest);
    assert.deepEqual(
      manifest.pages.map((entry) => entry.url),
      [
        '/',
        '/404.html',
        '/journal/',
        '/journal/first-dovetail/',
        '/journal/mountain-weekend/',
        '/journal/photo-notes/',
        '/journal/ridge-walk/',
        '/journal/series/boxes-by-hand/',
        '/journal/tags/',
        '/journal/tags/projects/',
        '/journal/tags/projects/kerfcalc/',
        '/journal/tags/projects/tenon-tumble/',
        '/journal/tags/trips/',
        '/journal/tags/trips/mountains/',
        '/journal/tags/workshop/',
        '/journal/tags/workshop/boxes/',
        '/journal/tags/workshop/boxes/dovetails/',
        '/journal/walnut-box/',
        '/made/',
        '/made/kerfcalc/',
        '/made/tenon-tumble/',
      ],
    );
    assert.deepEqual(
      manifest.feeds.map((feed) => feed.url),
      [
        '/journal/feed.xml',
        '/journal/series/boxes-by-hand/feed.xml',
        '/journal/tags/projects/feed.xml',
        '/journal/tags/projects/kerfcalc/feed.xml',
        '/journal/tags/projects/tenon-tumble/feed.xml',
        '/journal/tags/trips/feed.xml',
        '/journal/tags/trips/mountains/feed.xml',
        '/journal/tags/workshop/boxes/dovetails/feed.xml',
        '/journal/tags/workshop/boxes/feed.xml',
        '/journal/tags/workshop/feed.xml',
        '/made/kerfcalc/feed.xml',
        '/made/tenon-tumble/feed.xml',
      ],
    );
    assert.deepEqual(
      manifest.images.map((image) => [image.source, image.post, image.use]),
      [
        ['content/journal/first-dovetail/dovetail-joint.jpg', '/journal/first-dovetail/', 'body'],
        ['content/journal/first-dovetail/marking-gauge.jpg', '/journal/first-dovetail/', 'body'],
        ['content/journal/photos/ridge.jpg', '/journal/mountain-weekend/', 'body'],
        ['content/journal/first-dovetail/dovetail-joint.jpg', '/journal/photo-notes/', 'body'],
        ['content/journal/first-dovetail/marking-gauge.jpg', '/journal/photo-notes/', 'body'],
        ['content/journal/photos/ridge.jpg', '/journal/photo-notes/', 'body'],
        ['content/journal/photos/ridge.jpg', '/journal/ridge-walk/', 'body'],
        ['content/projects/kerfcalc/card.jpg', '/made/kerfcalc/', 'card'],
        ['content/projects/tenon-tumble/card.jpg', '/made/tenon-tumble/', 'card'],
        ['content/projects/tenon-tumble/press-kit/logo.png', '/made/tenon-tumble/', 'press-kit'],
        ['content/projects/tenon-tumble/press-kit/on-the-bench.jpg', '/made/tenon-tumble/', 'press-kit'],
        ['content/projects/tenon-tumble/screenshot-1.jpg', '/made/tenon-tumble/', 'body'],
        ['content/projects/tenon-tumble/screenshot-1.jpg', '/made/tenon-tumble/', 'press-kit'],
        ['content/projects/tenon-tumble/screenshot-2.jpg', '/made/tenon-tumble/', 'body'],
        ['content/projects/tenon-tumble/screenshot-2.jpg', '/made/tenon-tumble/', 'press-kit'],
      ],
    );
    assert.equal(manifest.site.id, 'workshop');
    assert.equal(manifest.now, NOW.toISOString());
    assert.equal(manifest.posts[0].source, 'content/journal/first-dovetail/index.md');
    for (const entry of manifest.pages) {
      assert.ok(existsSync(join(site, ...entry.file.split('/'))), `${entry.file} exists`);
    }
  });
});

test('the build is written under {out}/{siteId} only', async () => {
  const out = mkdtempSync(join(tmpdir(), 'coffer-example-'));
  try {
    await buildSites(loadConfig({ configPath: exampleConfig }), { out, now: NOW });
    assert.deepEqual(readdirSync(out), ['workshop']);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('coffer build with --out, --now and --drafts builds the example from the command line', () => {
  const out = mkdtempSync(join(tmpdir(), 'coffer-example-'));
  try {
    const result = spawnSync(
      process.execPath,
      [bin, 'build', '--config', exampleConfig, '--out', out, '--now', '2026-06-01'],
      { encoding: 'utf8', cwd: tmpdir() },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /workshop: 5 post\(s\), 21 page\(s\)/);
    assert.equal(existsSync(join(out, 'workshop', 'journal', 'spring-open-house')), false);

    const preview = spawnSync(
      process.execPath,
      [bin, 'build', '--config', exampleConfig, '--out', out, '--drafts', '--now', '2026-06-01'],
      { encoding: 'utf8', cwd: tmpdir() },
    );
    assert.equal(preview.status, 0, preview.stderr);
    assert.match(preview.stdout, /workshop: 7 post\(s\), 25 page\(s\)/);
    assert.ok(existsSync(join(out, 'workshop', 'journal', 'spring-open-house', 'index.html')));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('the example script builds the example site with one command', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(
    manifest.scripts.example,
    'node bin/coffer.js build --config example/coffer.yaml --out example/dist',
  );
  const out = mkdtempSync(join(tmpdir(), 'coffer-example-'));
  try {
    const result = spawnSync(
      process.execPath,
      [bin, 'build', '--config', 'example/coffer.yaml', '--out', out],
      { encoding: 'utf8', cwd: root },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.ok(existsSync(join(out, 'workshop', 'journal', 'first-dovetail', 'index.html')));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('the example home shows the about text, the links and the latest posts from content and config', async () => {
  await withExample({}, (site, manifest) => {
    const html = readFileSync(join(site, 'index.html'), 'utf8');
    assert.match(html, /<h1>Tove Marlowe<\/h1>/);
    // The about text is the body of content/home.md, rendered from Markdown.
    assert.match(html, /<div class="about">\s*<p>I am Tove, a woodworker/);
    // The links come from the site's `links` in coffer.yaml.
    assert.match(html, /<a href="https:\/\/www\.linkedin\.example\/in\/tove-marlowe">LinkedIn<\/a>/);
    assert.match(html, /<a href="https:\/\/github\.example\/tove-marlowe">GitHub<\/a>/);
    assert.match(html, /<a href="mailto:tove@tove-marlowe\.example">Email<\/a>/);
    // The latest posts of the first blog, linked to their pages.
    assert.match(html, /<h2>Latest posts<\/h2>/);
    assert.match(html, /<a href="\/journal\/first-dovetail\/">My first hand-cut dovetail<\/a>/);
    assert.match(html, /<a href="\/journal\/">All posts: Workshop journal<\/a>/);
    // Posts that are not published are not listed.
    assert.doesNotMatch(html, /planer-notes|Spring open house/);
    // The secondary link comes from the front matter and is marked as secondary.
    assert.match(
      html,
      /<nav class="secondary-links"[^>]*>\s*<ul>\s*<li><a href="https:\/\/sketchbook\.example\/tove">/,
    );
    const home = manifest.pages.find((entry) => entry.url === '/');
    assert.deepEqual(home, { url: '/', file: 'index.html', type: 'home', title: 'Tove Marlowe' });
  });
});

test('preview mode lists unpublished posts on the home page and marks them', async () => {
  await withExample({ drafts: true }, (site) => {
    const html = readFileSync(join(site, 'index.html'), 'utf8');
    assert.match(html, /<a href="\/journal\/planer-notes\/">/);
    assert.match(html, /class="preview-note"/);
  });
});

test('404.html is written with the layout of the site, a noindex hint and a link home', async () => {
  await withExample({}, (site, manifest) => {
    const html = readFileSync(join(site, '404.html'), 'utf8');
    assert.match(html, /<html lang="en">/);
    assert.match(html, /<link rel="stylesheet" href="\/assets\/coffer\.css">/);
    assert.match(html, /<a class="site-title" href="\/">Tove Marlowe<\/a>/);
    assert.match(html, /<h1>Page not found<\/h1>/);
    assert.match(html, /<a href="\/">Back to the home page<\/a>/);
    assert.match(html, /<meta name="robots" content="noindex">/);
    assert.deepEqual(
      manifest.pages.find((entry) => entry.type === 'not-found'),
      { url: '/404.html', file: '404.html', type: 'not-found', title: 'Page not found' },
    );
  });
});

test('the footer of every page shows the content license from the configuration', async () => {
  await withExample({}, (site, manifest) => {
    for (const entry of manifest.pages) {
      const html = readFileSync(join(site, ...entry.file.split('/')), 'utf8');
      assert.match(
        html,
        /<footer class="site-footer">[\s\S]*<p class="license">Content: CC BY 4\.0<\/p>/,
        entry.file,
      );
    }
  });
});

test('the example home shows its featured projects in the declared order, with picture, pitch and kind', async () => {
  await withExample({}, (site, manifest) => {
    const html = readFileSync(join(site, 'index.html'), 'utf8');
    const showcase = /<section class="showcase">[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
    // The game declares order 1 and the tool order 2, so the game comes first although "Kerfcalc" sorts before "Tenon".
    const names = [...showcase.matchAll(/<h3 class="project-card-title"><a href="([^"]+)">([^<]+)<\/a>/g)].map((m) => [m[2], m[1]]);
    assert.deepEqual(names, [
      ['Tenon Tumble', '/made/tenon-tumble/'],
      ['Kerfcalc', '/made/kerfcalc/'],
    ]);
    assert.match(showcase, /<span class="project-kind">Game<\/span>/);
    assert.match(showcase, /<span class="project-kind">Tool<\/span>/);
    assert.match(showcase, /<p class="project-pitch">A small command-line calculator for saw kerf/);
    assert.equal(showcase.split('<picture>').length - 1, 2);
    assert.deepEqual(
      manifest.projects.map((project) => [project.slug, project.kind, project.featured, project.order, project.tag]),
      [
        ['tenon-tumble', 'game', true, 1, 'projects/tenon-tumble'],
        ['kerfcalc', 'tool', true, 2, 'projects/kerfcalc'],
      ],
    );
  });
});

test('the example projects page lists both projects and the project pages resolve their links', async () => {
  await withExample({}, (site) => {
    assert.deepEqual(
      [...page(site, '/made/').matchAll(/<h2 class="project-card-title"><a href="([^"]+)">/g)].map((m) => m[1]),
      ['/made/tenon-tumble/', '/made/kerfcalc/'],
    );
    const tool = page(site, '/made/kerfcalc/');
    assert.match(tool, /<h1>Kerfcalc<\/h1>/);
    assert.match(tool, /<a href="\/made\/tenon-tumble\/">Tenon Tumble<\/a>/);
    assert.match(tool, /<a href="\/journal\/walnut-box\/">walnut keepsake box<\/a>/);
    assert.match(tool, /<dt>License<\/dt>\s*<dd>MIT<\/dd>/);
    assert.match(tool, /<p class="project-pitch">A small command-line calculator for saw kerf/);
    assert.match(tool, /<a href="https:\/\/github\.example\/tove-marlowe\/kerfcalc" rel="noopener">github\.example\/tove-marlowe\/kerfcalc<\/a>/);
    assert.match(tool, /<div class="project-body">\s*<p>Kerfcalc answers the questions/);
    // The example tool configures docs (read in place from the sample-tool fixture), but its pages are not built yet, so there is no docs link and no empty section.
    assert.doesNotMatch(tool, /project-fact-docs|\/made\/kerfcalc\/docs\//);
    // The example game has no store link, so it asks readers to follow the devlog (its project feed); it has no repository link.
    const game = page(site, '/made/tenon-tumble/');
    assert.match(game, /<h1>Tenon Tumble<\/h1>/);
    assert.match(game, /<div class="game-page" style="--project-accent:#dd6b4d;--project-on-accent:#000;--project-font:&quot;Fraunces&quot;, var\(--coffer-font-heading\)">/);
    assert.match(game, /<a class="game-button game-follow-link" href="\/made\/tenon-tumble\/feed\.xml">Follow the devlog<\/a>/);
    assert.doesNotMatch(game, /game-store|project-fact-repo|Source code/);
    assert.match(game, /<section class="carousel" aria-label="Screenshots"/);
    assert.match(game, /<dt>Platforms<\/dt>\s*<dd>Linux, Windows, Web<\/dd>/);
  });
});

test('example posts about the tool and the game end with project blocks, and the project pages list them', async () => {
  await withExample({}, (site, manifest) => {
    const blocks = (/** @type {string} */ url) =>
      [...page(site, url).matchAll(/<section class="project-block" aria-labelledby="project-block-([^"]+)"/g)].map((match) => match[1]);
    assert.deepEqual(blocks('/journal/walnut-box/'), ['kerfcalc']);
    assert.deepEqual(blocks('/journal/first-dovetail/'), ['tenon-tumble']);
    // One post carries both project tags, so it has both blocks (the game first, as on the projects page).
    assert.deepEqual(blocks('/journal/photo-notes/'), ['tenon-tumble', 'kerfcalc']);
    assert.deepEqual(blocks('/journal/ridge-walk/'), []);
    assert.match(page(site, '/journal/walnut-box/'), /<a class="project-badge" href="\/made\/kerfcalc\/">Kerfcalc<\/a>/);

    const latest = (/** @type {string} */ url) =>
      [...(/<section class="project-latest"[\s\S]*?<\/section>/.exec(page(site, url))?.[0] ?? '').matchAll(/<a href="([^"]+)">/g)].map((match) => match[1]);
    assert.deepEqual(latest('/made/kerfcalc/'), ['/journal/walnut-box/', '/journal/photo-notes/']);
    assert.deepEqual(latest('/made/tenon-tumble/'), ['/journal/first-dovetail/', '/journal/photo-notes/']);
    for (const url of ['/made/kerfcalc/', '/made/tenon-tumble/']) {
      assert.match(page(site, url), new RegExp(`<p class="feed-link"><a rel="alternate" type="application/atom\\+xml" href="${url}feed\\.xml">`));
    }
    assert.deepEqual(
      manifest.projects.map((project) => [project.slug, project.feed, project.posts]),
      [
        ['tenon-tumble', '/made/tenon-tumble/feed.xml', ['/journal/first-dovetail/', '/journal/photo-notes/']],
        ['kerfcalc', '/made/kerfcalc/feed.xml', ['/journal/walnut-box/', '/journal/photo-notes/']],
      ],
    );
  });
});

test('the example game has a press kit whose downloads are full resolution and carry no location', async () => {
  await withExample({}, async (site, manifest) => {
    const game = page(site, '/made/tenon-tumble/');
    const section = /<section class="press-kit"[\s\S]*?<\/section>/.exec(game)?.[0] ?? '';
    assert.match(section, /id="press-kit"/);
    assert.match(section, /<dt>Developer<\/dt>\s*<dd>Tove Marlowe<\/dd>/);
    assert.match(section, /<dt>Release status<\/dt>\s*<dd>In development, no release date yet<\/dd>/);
    assert.match(section, /<dt>Platforms<\/dt>\s*<dd>Linux, Windows, Web<\/dd>/);
    assert.match(section, /<dt>Price<\/dt>\s*<dd>Free<\/dd>/);
    assert.match(section, /<h3>Short description<\/h3>\s*<p>A relaxed puzzle game/);
    assert.match(section, /<h3>Description<\/h3>[\s\S]*<li>Short rounds that fit the minutes between jobs\.<\/li>/);
    assert.equal((section.match(/<a class="press-download" /g) ?? []).length, 5);

    assert.deepEqual(
      manifest.projects.find((project) => project.slug === 'tenon-tumble')?.downloads.map((entry) => [entry.fileName, entry.type, entry.width, entry.height]),
      [
        ['tenon-tumble-logo-01.png', 'image/png', 512, 512],
        ['tenon-tumble-logo-02.svg', 'image/svg+xml', 512, 512],
        ['tenon-tumble-screenshot-01.jpg', 'image/jpeg', 1280, 720],
        ['tenon-tumble-screenshot-02.jpg', 'image/jpeg', 1280, 720],
        ['tenon-tumble-screenshot-03.jpg', 'image/jpeg', 1200, 800],
      ],
    );

    // The photograph has a made-up position and camera; the published download has neither.
    const original = readFileSync(join(root, 'example', 'content', 'projects', 'tenon-tumble', 'press-kit', 'on-the-bench.jpg'));
    const before = await exifr.parse(original, { gps: true, mergeOutput: true });
    assert.ok(before.latitude > 52 && before.Make === 'Examplecam', 'the original is geotagged');
    const published = readFileSync(join(site, 'made', 'tenon-tumble', 'press-kit', 'tenon-tumble-screenshot-03.jpg'));
    const after = await exifr.parse(published, { gps: true, mergeOutput: true });
    assert.equal(after?.latitude, undefined);
    assert.equal(after?.Make, undefined);
    assert.deepEqual(
      [(await sharp(published).metadata()).width, (await sharp(published).metadata()).height],
      [1200, 800],
    );
    const logo = await sharp(join(site, 'made', 'tenon-tumble', 'press-kit', 'tenon-tumble-logo-01.png')).metadata();
    assert.deepEqual([logo.format, logo.hasAlpha, logo.width], ['png', true, 512]);
  });
});
