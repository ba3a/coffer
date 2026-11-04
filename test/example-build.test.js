import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
        '/journal/tags/trips/',
        '/journal/tags/trips/mountains/',
        '/journal/tags/workshop/',
        '/journal/tags/workshop/boxes/',
        '/journal/tags/workshop/boxes/dovetails/',
        '/journal/walnut-box/',
      ],
    );
    assert.deepEqual(
      manifest.feeds.map((feed) => feed.url),
      [
        '/journal/feed.xml',
        '/journal/series/boxes-by-hand/feed.xml',
        '/journal/tags/trips/feed.xml',
        '/journal/tags/trips/mountains/feed.xml',
        '/journal/tags/workshop/boxes/dovetails/feed.xml',
        '/journal/tags/workshop/boxes/feed.xml',
        '/journal/tags/workshop/feed.xml',
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
    assert.match(result.stdout, /workshop: 5 post\(s\), 15 page\(s\)/);
    assert.equal(existsSync(join(out, 'workshop', 'journal', 'spring-open-house')), false);

    const preview = spawnSync(
      process.execPath,
      [bin, 'build', '--config', exampleConfig, '--out', out, '--drafts', '--now', '2026-06-01'],
      { encoding: 'utf8', cwd: tmpdir() },
    );
    assert.equal(preview.status, 0, preview.stderr);
    assert.match(preview.stdout, /workshop: 7 post\(s\), 19 page\(s\)/);
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
