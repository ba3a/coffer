import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSites } from '../src/build.js';
import { parseServeArgs, run } from '../src/cli.js';
import { loadConfig } from '../src/config.js';
import { contentTypeFor, matchRedirect, parseRedirects, startServer } from '../src/serve.js';

const exampleConfig = fileURLToPath(new URL('../example/coffer.yaml', import.meta.url));
const NOW = new Date('2026-06-01T12:00:00Z');

/** @type {string} */
let out;
/** @type {import('../src/serve.js').RunningServer} */
let running;

before(async () => {
  out = mkdtempSync(join(tmpdir(), 'coffer-serve-'));
  const [result] = await buildSites(loadConfig({ configPath: exampleConfig }), { out, now: NOW });
  running = await startServer({ dir: result.outDir, port: 0 });
});

after(async () => {
  await running.close();
  rmSync(out, { recursive: true, force: true });
});

/**
 * @param {string} path
 * @param {RequestInit} [init]
 */
function get(path, init) {
  return fetch(`${running.url}${path}`, { redirect: 'manual', ...init });
}

test('the canonical URL of a post answers 200 with HTML', async () => {
  const response = await get('/journal/first-dovetail/');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.match(await response.text(), /<h1>My first hand-cut dovetail<\/h1>/);
});

test('the same URL without the trailing slash redirects with 308 to the canonical one', async () => {
  const response = await get('/journal/first-dovetail');
  assert.equal(response.status, 308);
  assert.equal(response.headers.get('location'), '/journal/first-dovetail/');
  const index = await get('/journal');
  assert.equal(index.status, 308);
  assert.equal(index.headers.get('location'), '/journal/');
});

test('the query string survives the slash redirect', async () => {
  const response = await get('/journal?page=2');
  assert.equal(response.status, 308);
  assert.equal(response.headers.get('location'), '/journal/?page=2');
});

test('/a/index.html redirects with 308 to /a/', async () => {
  const response = await get('/journal/first-dovetail/index.html');
  assert.equal(response.status, 308);
  assert.equal(response.headers.get('location'), '/journal/first-dovetail/');
  const home = await get('/index.html');
  assert.equal(home.status, 308);
  assert.equal(home.headers.get('location'), '/');
});

test('the home page answers 200 at /', async () => {
  const response = await get('/');
  assert.equal(response.status, 200);
  assert.match(await response.text(), /<h1>Tove Marlowe<\/h1>/);
});

test('an old slug answers 301 to the new URL, with and without the slash', async () => {
  for (const path of ['/journal/dovetail-diary/', '/journal/dovetail-diary']) {
    const response = await get(path);
    assert.equal(response.status, 301, path);
    assert.equal(response.headers.get('location'), '/journal/first-dovetail/', path);
  }
});

test('an unknown URL answers 404 with the 404 page of the site', async () => {
  for (const path of ['/nothing-here/', '/journal/nothing', '/journal/first-dovetail/missing.png']) {
    const response = await get(path);
    assert.equal(response.status, 404, path);
    assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.match(await response.text(), /<h1>Page not found<\/h1>/, path);
  }
});

test('paths that climb out of the directory are not served', async () => {
  const response = await get('/%2e%2e/%2e%2e/package.json');
  assert.equal(response.status, 404);
  const raw = await get('/..%2f..%2fpackage.json');
  assert.equal(raw.status, 404);
});

test('static files get their content type', async () => {
  const response = await get('/assets/coffer.css');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/css; charset=utf-8');
  assert.match(await response.text(), /--/);
  const manifest = await get('/.coffer-manifest.json');
  assert.equal(manifest.headers.get('content-type'), 'application/json; charset=utf-8');
  await manifest.arrayBuffer();
});

test('HEAD answers like GET without a body and other methods answer 405', async () => {
  const head = await get('/journal/first-dovetail/', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  const post = await get('/', { method: 'POST' });
  assert.equal(post.status, 405);
  await post.arrayBuffer();
});

test('without a 404.html the server answers a plain 404, and a directory without index is a 404', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coffer-serve-bare-'));
  const bare = await startServer({ dir, port: 0 });
  try {
    mkdirSync(join(dir, 'empty'));
    writeFileSync(join(dir, 'a.txt'), 'hello');
    const response = await fetch(`${bare.url}/missing`, { redirect: 'manual' });
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8');
    await response.arrayBuffer();
    const empty = await fetch(`${bare.url}/empty/`, { redirect: 'manual' });
    assert.equal(empty.status, 404);
    await empty.arrayBuffer();
    const file = await fetch(`${bare.url}/a.txt`, { redirect: 'manual' });
    assert.equal(file.status, 200);
    assert.equal(await file.text(), 'hello');
  } finally {
    await bare.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parseRedirects reads rules, ignores comments and non-redirect lines, and defaults to 301', () => {
  const rules = parseRedirects(
    [
      '# comment',
      '',
      '/a /b 302',
      '/c /d',
      '/e /f 200',
      'nonsense',
      '/blog/* /news/:splat 308',
      '/g https://other.example/ 307',
    ].join('\r\n'),
  );
  assert.deepEqual(rules, [
    { from: '/a', to: '/b', status: 302 },
    { from: '/c', to: '/d', status: 301 },
    { from: '/blog/*', to: '/news/:splat', status: 308 },
    { from: '/g', to: 'https://other.example/', status: 307 },
  ]);
  assert.deepEqual(matchRedirect(rules, '/blog/x/y'), { location: '/news/x/y', status: 308 });
  assert.deepEqual(matchRedirect(rules, '/c'), { location: '/d', status: 301 });
  assert.equal(matchRedirect(rules, '/nope'), null);
});

test('contentTypeFor knows the types a site uses and falls back to octet-stream', () => {
  assert.equal(contentTypeFor('x.html'), 'text/html; charset=utf-8');
  assert.equal(contentTypeFor('feed.xml'), 'application/xml; charset=utf-8');
  assert.equal(contentTypeFor('a.WEBP'), 'image/webp');
  assert.equal(contentTypeFor('track.gpx'), 'application/gpx+xml; charset=utf-8');
  assert.equal(contentTypeFor('x.unknown'), 'application/octet-stream');
});

test('parseServeArgs reads the directory, the port and the host', () => {
  assert.deepEqual(parseServeArgs([]), { dir: '.', port: 8080 });
  assert.deepEqual(parseServeArgs(['dist/site', '--port', '3000', '--host=0.0.0.0']), {
    dir: 'dist/site',
    port: 3000,
    host: '0.0.0.0',
  });
  assert.deepEqual(parseServeArgs(['--port=0']), { dir: '.', port: 0 });
  assert.deepEqual(parseServeArgs(['--port', 'abc']), {
    error: '--port must be a number from 0 to 65535',
  });
  assert.deepEqual(parseServeArgs(['--port']), { error: '--port needs a value' });
  assert.deepEqual(parseServeArgs(['a', 'b']), { error: 'unexpected argument "b"' });
  assert.deepEqual(parseServeArgs(['--bogus']), { error: 'unexpected argument "--bogus"' });
});

test('coffer serve rejects a missing directory and a bad option', async () => {
  let err = '';
  const io = {
    out: () => {},
    err: (/** @type {string} */ text) => {
      err += text;
    },
  };
  assert.equal(await run(['serve', join(tmpdir(), 'coffer-no-such-dir')], io), 1);
  assert.match(err, /is not a directory/);
  err = '';
  assert.equal(await run(['serve', '--port', 'x'], io), 1);
  assert.match(err, /--port must be a number/);
});
