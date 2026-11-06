import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSites } from '../src/build.js';
import { checkOutput } from '../src/check/index.js';
import { ANALYTICS_PROVIDERS, loadConfig, normalizeConfig } from '../src/config.js';
import { createTemplates } from '../src/render/templates.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const exampleConfig = join(root, 'example', 'coffer.yaml');
const NOW = new Date('2026-06-01T12:00:00Z');

const TOKEN = '0123456789abcdef0123456789abcdef';
const BEACON_SRC = 'https://static.cloudflareinsights.com/beacon.min.js';
const BEACON = `<script defer src="${BEACON_SRC}" data-cf-beacon='{"token": "${TOKEN}"}'></script>`;
const TOKEN_MESSAGE =
  'coffer.yaml: sites[0].analytics.token: must be the 8 to 64 letters and digits of the Cloudflare Web Analytics token, nothing else';

/**
 * @param {unknown} analytics
 * @returns {unknown}
 */
function rawConfig(analytics) {
  return {
    sites: [
      {
        id: 'main',
        baseUrl: 'https://example.org',
        title: 'Main',
        ...(analytics === undefined ? {} : { analytics }),
      },
    ],
  };
}

/**
 * @param {unknown} analytics
 * @returns {import('../src/config.js').AnalyticsConfig}
 */
function analyticsOf(analytics) {
  return normalizeConfig(rawConfig(analytics), { file: '/work/coffer.yaml' }).sites[0].analytics;
}

/**
 * @param {unknown} analytics
 * @returns {string[]}
 */
function errorsOf(analytics) {
  try {
    normalizeConfig(rawConfig(analytics), { file: '/work/coffer.yaml' });
  } catch (error) {
    return /** @type {{ errors: string[] }} */ (error).errors;
  }
  return [];
}

/**
 * Every `.html` file below a directory, with a path relative to it.
 *
 * @param {string} dir
 * @param {string} [base]
 * @returns {string[]}
 */
function htmlFiles(dir, base = dir) {
  /** @type {string[]} */
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...htmlFiles(path, base));
    else if (entry.name.endsWith('.html')) found.push(relative(base, path).split('\\').join('/'));
  }
  return found;
}

/**
 * Builds the example site with the given analytics setting and passes the
 * output directory to `body`.
 *
 * @param {import('../src/config.js').AnalyticsConfig} analytics
 * @param {{ drafts?: boolean }} options
 * @param {(site: string) => void | Promise<void>} body
 */
async function withExample(analytics, options, body) {
  const out = mkdtempSync(join(tmpdir(), 'coffer-analytics-'));
  try {
    const config = loadConfig({ configPath: exampleConfig });
    config.sites[0].analytics = analytics;
    const [result] = await buildSites(config, { out, now: NOW, ...options });
    await body(result.outDir);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/**
 * @param {string} site
 * @param {string} file
 * @returns {string}
 */
function read(site, file) {
  return readFileSync(join(site, ...file.split('/')), 'utf8');
}

test('a site without an analytics key has provider none', () => {
  assert.deepEqual(analyticsOf(undefined), { provider: 'none' });
  assert.deepEqual(analyticsOf({}), { provider: 'none' });
  assert.deepEqual(analyticsOf({ provider: 'none' }), { provider: 'none' });
  assert.deepEqual([...ANALYTICS_PROVIDERS], ['none', 'cloudflare', 'custom']);
});

test('the cloudflare provider takes a token, the custom provider a snippet', () => {
  assert.deepEqual(analyticsOf({ provider: 'cloudflare', token: TOKEN }), { provider: 'cloudflare', token: TOKEN });
  assert.deepEqual(analyticsOf({ provider: 'custom', html: '  <script defer src="/a.js"></script> ' }), {
    provider: 'custom',
    html: '<script defer src="/a.js"></script>',
  });
});

test('analytics settings that do not fit together are errors with their key paths', () => {
  assert.deepEqual(errorsOf({ provider: 'cloudflare' }), [
    'coffer.yaml: sites[0].analytics.token: is required with "provider: cloudflare"',
  ]);
  assert.deepEqual(errorsOf({ provider: 'custom' }), [
    'coffer.yaml: sites[0].analytics.html: is required with "provider: custom"',
  ]);
  assert.deepEqual(errorsOf({ provider: 'plausible' }), [
    'coffer.yaml: sites[0].analytics.provider: must be one of: none, cloudflare, custom',
  ]);
  assert.deepEqual(errorsOf({ provider: 'none', token: TOKEN }), [
    'coffer.yaml: sites[0].analytics.token: only has an effect with "provider: cloudflare"',
  ]);
  assert.deepEqual(errorsOf({ token: TOKEN }), [
    'coffer.yaml: sites[0].analytics.token: only has an effect with "provider: cloudflare"',
  ]);
  assert.deepEqual(errorsOf({ provider: 'cloudflare', token: TOKEN, html: '<b></b>' }), [
    'coffer.yaml: sites[0].analytics.html: only has an effect with "provider: custom"',
  ]);
  assert.deepEqual(errorsOf({ provider: 'custom', html: '<b></b>', token: TOKEN }), [
    'coffer.yaml: sites[0].analytics.token: only has an effect with "provider: cloudflare"',
  ]);
  assert.deepEqual(errorsOf({ provider: 'cloudflare', token: TOKEN, id: 'x' }), [
    'coffer.yaml: sites[0].analytics.id: unknown key (expected one of: provider, token, html)',
  ]);
  assert.deepEqual(errorsOf('cloudflare'), ['coffer.yaml: sites[0].analytics: must be a mapping']);
});

test('a token that is not plain letters and digits is rejected', () => {
  for (const token of [`${TOKEN}"`, `${TOKEN}'><script>x</script>`, 'abc def0123456', 'abc', 'x'.repeat(65), '{"token": "x"}']) {
    assert.deepEqual(errorsOf({ provider: 'cloudflare', token }), [TOKEN_MESSAGE], token);
  }
  assert.deepEqual(errorsOf({ provider: 'cloudflare', token: 12345678 }), [
    'coffer.yaml: sites[0].analytics.token: must be a non-empty string',
  ]);
  assert.deepEqual(errorsOf({ provider: 'custom', html: '   ' }), [
    'coffer.yaml: sites[0].analytics.html: must be a non-empty string',
  ]);
});

test('the template renders the cloudflare beacon, the custom snippet as written, or nothing', () => {
  const site = { title: 'Example', contentLicense: '' };
  const page = { title: 'Hello', content: '<p>Body</p>' };
  const render = (/** @type {any} */ analytics) => createTemplates({ lang: 'en', analytics }).render('page.njk', { site, page });

  const cloudflare = render({ provider: 'cloudflare', token: TOKEN });
  assert.equal(cloudflare.split(BEACON).length, 2, 'the beacon is there once');
  assert.ok(cloudflare.indexOf(BEACON) > cloudflare.indexOf('</footer>'), 'at the end of the body');
  assert.ok(cloudflare.indexOf(BEACON) < cloudflare.indexOf('</body>'));

  const custom = render({ provider: 'custom', html: '<script async src="https://stats.example/s.js" data-site="a&b"></script>' });
  assert.ok(custom.includes('<script async src="https://stats.example/s.js" data-site="a&b"></script>'), 'unescaped');
  assert.doesNotMatch(custom, /cloudflareinsights/);

  for (const nothing of [undefined, null, { provider: 'none' }]) {
    const html = render(nothing);
    assert.doesNotMatch(html, /cloudflareinsights|data-cf-beacon/);
    assert.equal([...html.matchAll(/<script/g)].length, 1, 'only the theme script');
  }
});

test('the token is escaped when rendered, even if the configuration check were bypassed', () => {
  const html = createTemplates({
    lang: 'en',
    analytics: { provider: 'cloudflare', token: `x"'><script>alert(1)</script>` },
  }).render('page.njk', { site: { title: 'Example' }, page: { title: 'Hello', content: '' } });
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;alert/);
});

test('a theme can replace the analytics partial or the analytics block', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coffer-analytics-theme-'));
  const context = { site: { title: 'Example' }, page: { title: 'Hello', content: '' } };
  /** @type {import('../src/config.js').AnalyticsConfig} */
  const analytics = { provider: 'cloudflare', token: TOKEN };
  try {
    mkdirSync(join(dir, 'templates', 'partials'), { recursive: true });
    writeFileSync(join(dir, 'templates', 'partials', 'analytics.njk'), '{% if analytics %}<i id="mine">{{ analytics.token }}</i>{% endif %}\n');
    const html = createTemplates({ lang: 'en', theme: dir, analytics }).render('page.njk', context);
    assert.ok(html.includes(`<i id="mine">${TOKEN}</i>`));
    assert.doesNotMatch(html, /cloudflareinsights/);

    writeFileSync(join(dir, 'templates', 'page.njk'), '{% extends "coffer:page.njk" %}\n{% block analytics %}<!-- no stats here -->{% endblock %}\n');
    const blank = createTemplates({ lang: 'en', theme: dir, analytics }).render('page.njk', context);
    assert.ok(blank.includes('<!-- no stats here -->'));
    assert.doesNotMatch(blank, /mine|cloudflareinsights/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the standalone reference page of coffer does not carry the snippet', () => {
  const html = createTemplates({ lang: 'en', analytics: { provider: 'cloudflare', token: TOKEN } }).render('reference.njk', {
    heading: 'Reference',
    project: { name: 'Tool', url: '/made/tool/' },
    bar: '',
    sections: [],
    itemCount: 0,
    undocumentedCount: 0,
  });
  assert.match(html, /<html/);
  assert.doesNotMatch(html, /cloudflareinsights|data-cf-beacon/);
});

test('built pages of every layout carry the beacon, and the reference page does not', async () => {
  await withExample({ provider: 'cloudflare', token: TOKEN }, {}, (site) => {
    const files = htmlFiles(site).filter((file) => !file.startsWith('pagefind/'));
    const themed = files.filter((file) => /class="site-header"/.test(read(site, file)));
    assert.ok(themed.length >= 20, `${themed.length} themed pages`);
    for (const file of themed) {
      const html = read(site, file);
      assert.equal(html.split(BEACON).length, 2, `${file} has the beacon once`);
      assert.ok(html.indexOf(BEACON) < html.indexOf('</body>'), file);
    }
    for (const file of [
      'index.html',
      '404.html',
      'journal/index.html',
      'journal/first-dovetail/index.html',
      'journal/tags/index.html',
      'journal/search/index.html',
      'made/index.html',
      'made/kerfcalc/index.html',
      'made/kerfcalc/docs/index.html',
    ]) {
      assert.ok(themed.includes(file), `${file} is a themed page`);
    }
    const reference = 'made/kerfcalc/docs/reference/index.html';
    assert.ok(existsSync(join(site, ...reference.split('/'))), 'the reference page exists');
    assert.doesNotMatch(read(site, reference), /cloudflareinsights|data-cf-beacon/);
    // Pages that are not themed pages (redirect stubs) carry nothing.
    for (const file of files.filter((name) => !themed.includes(name))) {
      assert.doesNotMatch(read(site, file), /data-cf-beacon/, file);
    }
  });
});

test('a preview build (drafts) never carries the snippet', async () => {
  await withExample({ provider: 'cloudflare', token: TOKEN }, { drafts: true }, (site) => {
    const files = htmlFiles(site);
    assert.ok(files.length > 20);
    for (const file of files) {
      assert.doesNotMatch(read(site, file), /cloudflareinsights|data-cf-beacon/, file);
    }
  });
  await withExample({ provider: 'custom', html: '<script src="https://stats.example/s.js"></script>' }, { drafts: true }, (site) => {
    for (const file of htmlFiles(site)) {
      assert.doesNotMatch(read(site, file), /stats\.example/, file);
    }
  });
});

test('with no analytics configured no built page loads a third-party script', async () => {
  await withExample({ provider: 'none' }, {}, (site) => {
    const files = htmlFiles(site).filter((file) => !file.startsWith('pagefind/'));
    assert.ok(files.length > 20);
    for (const file of files) {
      const html = read(site, file);
      assert.doesNotMatch(html, /cloudflareinsights|data-cf-beacon/, file);
      for (const match of html.matchAll(/<script\b[^>]*\ssrc=["']([^"']+)["']/gi)) {
        assert.doesNotMatch(match[1], /^(?:[a-z][a-z0-9+.-]*:)?\/\//i, `${file} loads ${match[1]}`);
      }
    }
  });
});

test('a custom snippet is written into the built pages as it is', async () => {
  const snippet = '<script defer src="https://stats.example/s.js" data-domain="tove-marlowe.example"></script>';
  await withExample({ provider: 'custom', html: snippet }, {}, (site) => {
    const html = read(site, 'journal/first-dovetail/index.html');
    assert.equal(html.split(snippet).length, 2);
    assert.doesNotMatch(html, /cloudflareinsights/);
    assert.doesNotMatch(read(site, 'made/kerfcalc/docs/reference/index.html'), /stats\.example/);
  });
});

test('coffer check passes on a build with the beacon: external script addresses are not fetched', async () => {
  const out = mkdtempSync(join(tmpdir(), 'coffer-analytics-check-'));
  try {
    const config = loadConfig({ configPath: exampleConfig });
    config.sites[0].analytics = { provider: 'cloudflare', token: TOKEN };
    await buildSites(config, { out, now: NOW });
    assert.ok(read(join(out, 'workshop'), 'index.html').includes(BEACON));
    const result = await checkOutput(config, { out });
    assert.deepEqual(result.failures, []);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
