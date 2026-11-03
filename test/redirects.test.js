import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BuildError, buildSites } from '../src/build.js';
import { run } from '../src/cli.js';
import { loadConfig } from '../src/config.js';
import {
  checkRedirects,
  collectRedirects,
  renderRedirectPage,
  renderRedirectsFile,
} from '../src/redirects.js';

const NOW = new Date('2026-06-01T12:00:00Z');
const exampleConfig = fileURLToPath(new URL('../example/coffer.yaml', import.meta.url));

/**
 * @param {string} prefix Blog prefix.
 * @returns {string}
 */
function configYaml(prefix) {
  return [
    'sites:',
    '  - id: demo',
    '    baseUrl: https://demo.example/',
    '    lang: en',
    '    title: Demo',
    '    contentLicense: Some rights reserved',
    '    blogs:',
    `      - { id: notes, dir: notes, prefix: "${prefix}", title: Notes }`,
    '',
  ].join('\n');
}

/**
 * Builds a small site from files and passes the result to `body`.
 *
 * @param {Record<string, string>} files Relative path (forward slashes) to content.
 * @param {(result: Awaited<ReturnType<typeof buildSites>>[number]) => void | Promise<void>} body
 * @param {{ prefix?: string }} [options]
 */
async function withSite(files, body, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'coffer-redirects-'));
  try {
    const all = { 'coffer.yaml': configYaml(options.prefix ?? 'log'), ...files };
    for (const [name, content] of Object.entries(all)) {
      const target = join(root, ...name.split('/'));
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, content);
    }
    const [result] = await buildSites(loadConfig({ configPath: join(root, 'coffer.yaml') }), {
      out: join(root, 'dist'),
      now: NOW,
    });
    await body(result);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * @param {string} extra Extra front matter lines.
 * @param {string} [title]
 * @returns {string}
 */
function post(extra, title = 'A post') {
  return `---\ntitle: ${title}\ndate: 2026-04-01\n${extra}\n---\n\nBody of ${title}.\n`;
}

test('an alias writes rules for the slash and no-slash forms and a meta-refresh page', async () => {
  await withSite({ 'notes/new.md': post('aliases: [old, older]') }, ({ outDir, manifest }) => {
    assert.equal(
      readFileSync(join(outDir, '_redirects'), 'utf8'),
      [
        '/log/old/ /log/new/ 301',
        '/log/old /log/new/ 301',
        '/log/older/ /log/new/ 301',
        '/log/older /log/new/ 301',
        '',
      ].join('\n'),
    );
    const html = readFileSync(join(outDir, 'log', 'old', 'index.html'), 'utf8');
    assert.match(html, /<meta http-equiv="refresh" content="0; url=\/log\/new\/">/);
    assert.match(html, /<link rel="canonical" href="https:\/\/demo\.example\/log\/new\/">/);
    assert.match(html, /<html lang="en">/);
    assert.ok(existsSync(join(outDir, 'log', 'older', 'index.html')));
    assert.deepEqual(manifest.redirects, [
      { from: '/log/old/', to: '/log/new/', status: 301 },
      { from: '/log/older/', to: '/log/new/', status: 301 },
    ]);
  });
});

test('a blog at the site root puts its aliases at the root too', async () => {
  await withSite(
    { 'notes/new.md': post('aliases: [old]') },
    ({ outDir }) => {
      assert.equal(
        readFileSync(join(outDir, '_redirects'), 'utf8'),
        '/old/ /new/ 301\n/old /new/ 301\n',
      );
      assert.ok(existsSync(join(outDir, 'old', 'index.html')));
    },
    { prefix: '' },
  );
});

test('a site without aliases writes no _redirects file', async () => {
  await withSite({ 'notes/new.md': post('') }, ({ outDir, manifest }) => {
    assert.equal(existsSync(join(outDir, '_redirects')), false);
    assert.deepEqual(manifest.redirects, []);
  });
});

test('aliases of drafts and future-dated posts are not published', async () => {
  await withSite(
    {
      'notes/a.md': post('aliases: [gone-a]\ndraft: true', 'A'),
      'notes/b.md': '---\ntitle: B\ndate: 2030-01-01\naliases: [gone-b]\n---\n\nB\n',
    },
    ({ outDir }) => {
      assert.equal(existsSync(join(outDir, '_redirects')), false);
      assert.equal(existsSync(join(outDir, 'log', 'gone-a')), false);
      assert.equal(existsSync(join(outDir, 'log', 'gone-b')), false);
    },
  );
});

test('an alias equal to the slug of a live post is a build error that names the file', async () => {
  await assert.rejects(
    withSite(
      {
        'notes/one.md': post('aliases: [two]', 'One'),
        'notes/two.md': post('', 'Two'),
      },
      () => {},
    ),
    (error) => {
      assert.ok(error instanceof BuildError);
      assert.match(
        error.message,
        /notes\/one\.md: alias for \/log\/two\/ collides with the live post/,
      );
      return true;
    },
  );
});

test('an alias equal to the slug of a draft is allowed because the draft is not live', async () => {
  await withSite(
    {
      'notes/one.md': post('aliases: [two]', 'One'),
      'notes/two.md': post('draft: true', 'Two'),
    },
    ({ outDir }) => {
      assert.match(
        readFileSync(join(outDir, '_redirects'), 'utf8'),
        /^\/log\/two\/ \/log\/one\/ 301$/m,
      );
    },
  );
});

test('two posts claiming the same alias is a build error', async () => {
  await assert.rejects(
    withSite(
      {
        'notes/one.md': post('aliases: [shared]', 'One'),
        'notes/two.md': post('aliases: [shared]', 'Two'),
      },
      () => {},
    ),
    /already claimed by notes\/(one|two)\.md/,
  );
});

test('checkRedirects flags an old address that is a page of the site', () => {
  assert.deepEqual(
    checkRedirects(
      [{ from: '/log/', to: '/log/a/', status: 301, source: 'x.md' }],
      new Set(['/log/']),
    ),
    ['x.md: alias for /log/ collides with a page of the site at the same address'],
  );
  assert.deepEqual(
    checkRedirects([{ from: '/log/old/', to: '/log/a/', status: 301, source: 'x.md' }], new Set()),
    [],
  );
});

test('the redirect helpers produce sorted rules and escaped pages', () => {
  const redirects = collectRedirects([
    { url: '/b/new/', aliasUrls: ['/b/z/', '/b/a/'], source: 'b.md' },
  ]);
  assert.deepEqual(
    redirects.map((entry) => entry.from),
    ['/b/a/', '/b/z/'],
  );
  assert.equal(renderRedirectsFile([]), '');
  const page = renderRedirectPage({
    lang: 'ru',
    target: '/a/?x="1"&y=<2>',
    canonical: 'https://x.example/a/',
  });
  assert.match(page, /<html lang="ru">/);
  assert.match(page, /content="0; url=\/a\/\?x=&quot;1&quot;&amp;y=&lt;2&gt;"/);
});

test('the example site declares an old slug for its published post', async () => {
  const out = mkdtempSync(join(tmpdir(), 'coffer-redirects-'));
  try {
    const [result] = await buildSites(loadConfig({ configPath: exampleConfig }), { out, now: NOW });
    assert.deepEqual(result.manifest.redirects, [
      { from: '/journal/dovetail-diary/', to: '/journal/first-dovetail/', status: 301 },
    ]);
    assert.equal(
      readFileSync(join(result.outDir, '_redirects'), 'utf8'),
      '/journal/dovetail-diary/ /journal/first-dovetail/ 301\n' +
        '/journal/dovetail-diary /journal/first-dovetail/ 301\n',
    );
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('coffer build reports an alias collision on standard error and exits 1', async () => {
  const root = mkdtempSync(join(tmpdir(), 'coffer-redirects-'));
  try {
    mkdirSync(join(root, 'notes'));
    writeFileSync(join(root, 'coffer.yaml'), configYaml('n'));
    writeFileSync(join(root, 'notes', 'one.md'), post('aliases: [two]', 'One'));
    writeFileSync(join(root, 'notes', 'two.md'), post('', 'Two'));
    let err = '';
    const code = await run(
      ['build', '--config', join(root, 'coffer.yaml'), '--out', join(root, 'dist'), '--now', '2026-06-01'],
      {
        out: () => {},
        err: (text) => {
          err += text;
        },
      },
    );
    assert.equal(code, 1);
    assert.match(err, /one\.md: alias for \/n\/two\/ collides/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
