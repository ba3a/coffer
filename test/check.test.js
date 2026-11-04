import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSites } from '../src/build.js';
import { checkOutput } from '../src/check/index.js';
import { checkLinkTarget, createOutputResolver } from '../src/check/output-links.js';
import { pagePreviewProblems, readPageHead } from '../src/check/output-meta.js';
import { W3C_REQUEST_INTERVAL_MS, parseW3cResponse, validateFeedsOnline } from '../src/check/w3c.js';
import { run } from '../src/cli.js';
import { loadConfig } from '../src/config.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const exampleConfig = join(root, 'example', 'coffer.yaml');
const bin = join(root, 'bin', 'coffer.js');
const NOW = new Date('2026-06-01T12:00:00Z');

const POST = 'journal/first-dovetail/index.html';

/** The example build, made once; every test works on a copy. */
let pristine = '';

before(async () => {
  pristine = mkdtempSync(join(tmpdir(), 'coffer-check-base-'));
  await buildSites(loadConfig({ configPath: exampleConfig }), { out: pristine, now: NOW });
});

after(() => {
  rmSync(pristine, { recursive: true, force: true });
});

/**
 * Copies the example build, lets `edit` change the copy's site directory, and
 * passes the output root to `body`.
 *
 * @param {(site: string) => void} edit
 * @param {(out: string) => Promise<void>} body
 */
async function withBuild(edit, body) {
  const out = mkdtempSync(join(tmpdir(), 'coffer-check-'));
  try {
    cpSync(pristine, out, { recursive: true });
    edit(join(out, 'workshop'));
    await body(out);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/**
 * @param {string} site
 * @param {string} file
 * @param {(text: string) => string} change
 */
function rewrite(site, file, change) {
  const path = join(site, ...file.split('/'));
  const before = readFileSync(path, 'utf8');
  const after = change(before);
  assert.notEqual(after, before, `${file} did not change`);
  writeFileSync(path, after);
}

/**
 * @param {string[]} args
 * @param {import('../src/cli.js').Services} [services]
 */
async function runCheck(args, services) {
  let out = '';
  let err = '';
  const code = await run(
    ['check', '--config', exampleConfig, ...args],
    { out: (text) => (out += text), err: (text) => (err += text) },
    services,
  );
  return { code, out, err };
}

test('coffer check passes on the example build', async () => {
  await withBuild(() => {}, async (out) => {
    const result = await runCheck(['--out', out]);
    assert.equal(result.err, '');
    assert.equal(result.code, 0);
    assert.match(result.out, /^workshop: \d+ page\(s\), 7 feed\(s\), 7 image\(s\) checked, no failures$/m);
  });
});

test('the executable exits 0 on the example build and non-zero on a broken one', async () => {
  await withBuild(() => {}, async (out) => {
    const ok = spawnSync(process.execPath, [bin, 'check', '--config', exampleConfig, '--out', out], { encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
  });
  await withBuild((site) => rewrite(site, POST, (html) => html.replace('</body>', '<a href="/nowhere/">x</a></body>')), async (out) => {
    const bad = spawnSync(process.execPath, [bin, 'check', '--config', exampleConfig, '--out', out], { encoding: 'utf8' });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /workshop\/journal\/first-dovetail\/index\.html: broken link "\/nowhere\/"/);
  });
});

test('a deliberately broken link fails the check and names the file', async () => {
  await withBuild(
    (site) => rewrite(site, POST, (html) => html.replace('</body>', '<p><a href="/journal/no-such-post/">gone</a></p></body>')),
    async (out) => {
      const result = await runCheck(['--out', out]);
      assert.equal(result.code, 1);
      assert.match(result.err, /workshop\/journal\/first-dovetail\/index\.html: broken link "\/journal\/no-such-post\/"/);
      assert.match(result.err, /coffer check: 1 failure\(s\)/);
    },
  );
});

test('a broken src, a broken srcset candidate and a broken stylesheet link are found', async () => {
  await withBuild(
    (site) =>
      rewrite(site, 'index.html', (html) =>
        html.replace(
          '</body>',
          '<img src="/img/missing.png" alt=""><img srcset="/img/a.webp 480w, /img/b.webp 800w" src="/assets/social-default.png" alt=""></body>',
        ),
      ),
    async (out) => {
      const result = await checkOutput(loadConfig({ configPath: exampleConfig }), { out });
      const messages = result.failures.filter((failure) => failure.file === 'index.html').map((failure) => failure.message);
      assert.equal(messages.length, 3, messages.join('\n'));
      assert.ok(messages.some((message) => message.includes('"/img/missing.png"') && message.includes('<img src>')));
      assert.ok(messages.some((message) => message.includes('"/img/a.webp"') && message.includes('<img srcset>')));
      assert.ok(messages.some((message) => message.includes('"/img/b.webp"')));
    },
  );
});

test('relative links resolve against the page, and a missing anchor fails', async () => {
  await withBuild(
    (site) =>
      rewrite(site, POST, (html) =>
        html.replace('</body>', '<a href="../../journal/">up</a><a href="#nope">anchor</a><a href="/journal/#nowhere">other</a><a href="#top">top</a></body>'),
      ),
    async (out) => {
      const result = await checkOutput(loadConfig({ configPath: exampleConfig }), { out });
      const messages = result.failures.map((failure) => failure.message);
      assert.equal(messages.length, 2, messages.join('\n'));
      assert.ok(messages.some((message) => message.startsWith('missing anchor "#nope" in /journal/first-dovetail/')));
      assert.ok(messages.some((message) => message.startsWith('missing anchor "#nowhere" in /journal/')));
    },
  );
});

test('Pages URL semantics: no trailing slash, index.html and _redirects rules all resolve', async () => {
  await withBuild(
    (site) => {
      writeFileSync(join(site, '_redirects'), `${readFileSync(join(site, '_redirects'), 'utf8')}/moved /journal/ 301\n/dead /nowhere/ 301\n`);
      rewrite(site, 'index.html', (html) =>
        html.replace('</body>', '<a href="/journal">a</a><a href="/journal/index.html">b</a><a href="/moved">c</a><a href="/journal/dovetail-diary">d</a><a href="/404.html">e</a><a href="https://elsewhere.example/x">f</a><a href="mailto:a@b.example">g</a></body>'),
      );
    },
    async (out) => {
      const result = await checkOutput(loadConfig({ configPath: exampleConfig }), { out });
      assert.deepEqual(result.failures, []);
    },
  );
  await withBuild(
    (site) => {
      writeFileSync(join(site, '_redirects'), '/dead /nowhere/ 301\n');
      rewrite(site, 'index.html', (html) => html.replace('</body>', '<a href="/dead">a</a></body>'));
    },
    async (out) => {
      const result = await checkOutput(loadConfig({ configPath: exampleConfig }), { out });
      assert.equal(result.failures.length, 1);
      assert.match(result.failures[0].message, /broken link "\/dead"/);
    },
  );
});

test('absolute links to the site itself are resolved in the output, other hosts are left alone', async () => {
  await withBuild(() => {}, async (out) => {
    const resolver = createOutputResolver(join(out, 'workshop'));
    const context = { baseUrl: 'https://tove-marlowe.example', pageUrl: '/journal/', resolver };
    assert.equal(checkLinkTarget('https://tove-marlowe.example/journal/first-dovetail/', context), null);
    assert.match(checkLinkTarget('https://tove-marlowe.example/journal/missing/', context) ?? '', /^broken link/);
    assert.equal(checkLinkTarget('https://other.example/journal/missing/', context), null);
    assert.equal(checkLinkTarget('//other.example/x', context), null);
    assert.equal(checkLinkTarget('first-dovetail/', context), null);
  });
});

test('a page without og:image fails the check and names the file', async () => {
  await withBuild(
    (site) => rewrite(site, POST, (html) => html.replace(/<meta property="og:image"[^>]*>\s*/, '')),
    async (out) => {
      const result = await runCheck(['--out', out]);
      assert.equal(result.code, 1);
      assert.match(result.err, /workshop\/journal\/first-dovetail\/index\.html: missing og:image/);
    },
  );
});

test('every required preview tag is checked, an empty value counts as missing', async () => {
  const cases = /** @type {[string, RegExp, string][]} */ ([
    ['title', /<title>[^<]*<\/title>/, 'missing title'],
    ['description', /<meta name="description"[^>]*>/, 'missing description'],
    ['canonical', /<link rel="canonical"[^>]*>/, 'missing canonical link'],
    ['og:title', /<meta property="og:title"[^>]*>/, 'missing og:title'],
    ['twitter:card', /<meta name="twitter:card"[^>]*>/, 'missing twitter:card'],
  ]);
  for (const [name, pattern, message] of cases) {
    await withBuild(
      (site) => rewrite(site, 'journal/index.html', (html) => html.replace(pattern, name === 'title' ? '<title></title>' : '')),
      async (out) => {
        const result = await checkOutput(loadConfig({ configPath: exampleConfig }), { out });
        assert.deepEqual(
          result.failures.map((failure) => `${failure.file}: ${failure.message}`),
          [`journal/index.html: ${message}`],
          name,
        );
      },
    );
  }
  await withBuild(
    (site) => rewrite(site, 'journal/index.html', (html) => html.replace(/(<meta property="og:image" content=")[^"]*"/, '$1"')),
    async (out) => {
      const result = await checkOutput(loadConfig({ configPath: exampleConfig }), { out });
      assert.deepEqual(result.failures.map((failure) => failure.message), ['missing og:image']);
    },
  );
});

test('a canonical link that is not the page address fails, an og:image that is not served fails', async () => {
  await withBuild(
    (site) => {
      rewrite(site, 'journal/index.html', (html) => html.replace(/(<link rel="canonical" href=")[^"]*"/, '$1https://tove-marlowe.example/journal/first-dovetail/"'));
      rewrite(site, POST, (html) => html.replace(/(<meta property="og:image" content=")[^"]*"/, '$1https://tove-marlowe.example/cards/none.png"'));
    },
    async (out) => {
      const result = await checkOutput(loadConfig({ configPath: exampleConfig }), { out });
      const lines = result.failures.map((failure) => `${failure.file}: ${failure.message}`).sort();
      assert.equal(lines.length, 2, lines.join('\n'));
      assert.match(lines[0], /^journal\/first-dovetail\/index\.html: og:image: broken link/);
      assert.match(lines[1], /^journal\/index\.html: canonical link is ".*\/first-dovetail\/", expected "https:\/\/tove-marlowe\.example\/journal\/"/);
    },
  );
});

test('redirect stubs are exempt from the preview metadata rules', async () => {
  await withBuild(
    (site) =>
      writeFileSync(
        join(site, 'journal', 'dovetail-diary', 'index.html'),
        '<!doctype html><meta http-equiv="refresh" content="0; url=/journal/first-dovetail/">',
      ),
    async (out) => {
      const result = await checkOutput(loadConfig({ configPath: exampleConfig }), { out });
      assert.deepEqual(result.failures, []);
    },
  );
});

test('an invalid feed fails the check and names the feed file', async () => {
  await withBuild(
    (site) => rewrite(site, 'journal/feed.xml', (xml) => xml.replace(/<updated>[^<]*<\/updated>/, '')),
    async (out) => {
      const result = await runCheck(['--out', out]);
      assert.equal(result.code, 1);
      assert.match(result.err, /workshop\/journal\/feed\.xml: invalid feed: line \d+: feed has no <updated>/);
    },
  );
});

test('a feed that is not well-formed, and a missing feed file, fail the check', async () => {
  await withBuild(
    (site) => {
      writeFileSync(join(site, 'journal', 'feed.xml'), '<feed');
      rmSync(join(site, 'journal', 'tags', 'trips', 'feed.xml'));
    },
    async (out) => {
      const result = await checkOutput(loadConfig({ configPath: exampleConfig }), { out });
      const lines = result.failures.map((failure) => `${failure.file}: ${failure.message}`);
      assert.ok(lines.some((line) => /^journal\/feed\.xml: invalid feed: not well-formed XML/.test(line)), lines.join('\n'));
      assert.ok(lines.some((line) => /^journal\/tags\/trips\/feed\.xml: the manifest lists the feed .* the file is missing/.test(line)), lines.join('\n'));
    },
  );
});

test('a broken link inside the content of a feed entry fails the check', async () => {
  await withBuild(
    (site) =>
      rewrite(site, 'journal/feed.xml', (xml) =>
        xml.replace('&lt;p&gt;', '&lt;p&gt;&lt;a href="https://tove-marlowe.example/journal/ghost/"&gt;ghost&lt;/a&gt;'),
      ),
    async (out) => {
      const result = await checkOutput(loadConfig({ configPath: exampleConfig }), { out });
      assert.equal(result.failures.length, 1, JSON.stringify(result.failures));
      assert.equal(result.failures[0].file, 'journal/feed.xml');
      assert.match(result.failures[0].message, /broken link "https:\/\/tove-marlowe\.example\/journal\/ghost\/".*<content>/);
    },
  );
});

test('a sitemap that differs from the manifest fails the check', async () => {
  await withBuild(
    (site) =>
      rewrite(site, 'sitemap.xml', (xml) =>
        xml
          .replace(/  <url>\s*<loc>https:\/\/tove-marlowe\.example\/journal\/<\/loc>\s*<\/url>\n/, '')
          .replace('</urlset>', '  <url><loc>https://tove-marlowe.example/extra/</loc></url>\n</urlset>'),
      ),
    async (out) => {
      const result = await checkOutput(loadConfig({ configPath: exampleConfig }), { out });
      const messages = result.failures.map((failure) => failure.message);
      assert.ok(result.failures.every((failure) => failure.file === 'sitemap.xml'));
      assert.ok(messages.some((message) => message.includes('does not list https://tove-marlowe.example/journal/')), messages.join('\n'));
      assert.ok(messages.some((message) => message.includes('lists https://tove-marlowe.example/extra/, which the manifest does not')));
      assert.ok(messages.some((message) => message.includes('nothing is served at /extra/')));
    },
  );
});

test('a missing build directory fails with a pointer to coffer build', async () => {
  const result = await runCheck(['--out', join(tmpdir(), 'coffer-check-does-not-exist')]);
  assert.equal(result.code, 1);
  assert.match(result.err, /workshop\/\.coffer-manifest\.json: no build found .*run "coffer build" first/);
});

test('check rejects unknown options and a missing value', async () => {
  const unknown = await run(['check', '--nope'], { out() {}, err() {} });
  assert.equal(unknown, 1);
  let err = '';
  const missing = await run(['check', '--out'], { out() {}, err: (text) => (err += text) });
  assert.equal(missing, 1);
  assert.match(err, /--out needs a value/);
});

test('readPageHead and pagePreviewProblems read titles, entities and attribute orders', () => {
  const head = readPageHead(
    '<!doctype html><html><head><title>A &amp; B</title><meta content="Hi" name="description">' +
      "<link href='https://x.example/a/' rel='canonical'><meta property=og:title content=T>" +
      '<meta property="og:image" content="https://x.example/i.png"><meta name="twitter:card" content="summary_large_image">' +
      '</head><body><meta name="description" content="not in the head"></body></html>',
  );
  assert.equal(head.title, 'A & B');
  assert.deepEqual(head.meta.get('description'), ['Hi']);
  assert.deepEqual(pagePreviewProblems(head, 'https://x.example/a/'), []);
  assert.deepEqual(pagePreviewProblems(head, 'https://x.example/b/'), [
    'canonical link is "https://x.example/a/", expected "https://x.example/b/"',
  ]);
  assert.deepEqual(pagePreviewProblems(readPageHead('<html><head></head></html>')), [
    'missing title',
    'missing description',
    'missing og:title',
    'missing og:image',
    'missing twitter:card',
    'missing canonical link',
  ]);
});

const SOAP = (/** @type {boolean} */ valid, /** @type {string} */ errors = '', /** @type {string} */ warnings = '') =>
  '<?xml version="1.0" encoding="utf-8"?><env:Envelope xmlns:env="http://www.w3.org/2003/05/soap-envelope"><env:Body>' +
  '<m:feedvalidationresponse xmlns:m="http://www.w3.org/2005/10/feed-validator">' +
  `<m:validity>${valid}</m:validity><m:errors><m:errorcount>0</m:errorcount><m:errorlist>${errors}</m:errorlist></m:errors>` +
  `<m:warnings><m:warningcount>0</m:warningcount><m:warninglist>${warnings}</m:warninglist></m:warnings>` +
  '</m:feedvalidationresponse></env:Body></env:Envelope>';

const SOAP_ERROR = (/** @type {string} */ text) =>
  `<error><level>error</level><type>MissingElement</type><line>3</line><column>0</column><text>${text}</text><msgcount>1</msgcount></error>`;

/**
 * A fake `fetch` that records its requests.
 *
 * @param {(body: URLSearchParams, index: number) => Response | Promise<Response>} answer
 */
function fakeFetch(answer) {
  /** @type {{ url: string, method: string, body: URLSearchParams }[]} */
  const calls = [];
  /** @type {typeof fetch} */
  const fn = async (url, init) => {
    const body = new URLSearchParams(String(init?.body));
    calls.push({ url: String(url), method: String(init?.method), body });
    return answer(body, calls.length - 1);
  };
  return { fn, calls };
}

test('parseW3cResponse reads validity, errors and warnings', () => {
  assert.deepEqual(parseW3cResponse(SOAP(true)), { valid: true, errors: [], warnings: [] });
  assert.deepEqual(
    parseW3cResponse(SOAP(false, SOAP_ERROR('Missing &lt;updated&gt;'), '<warning><text>Style</text><line>9</line></warning>')),
    { valid: false, errors: ['line 3: Missing <updated>'], warnings: ['line 9: Style'] },
  );
  assert.deepEqual(parseW3cResponse(SOAP(false))?.errors, ['the W3C validator rejected the feed']);
  assert.equal(parseW3cResponse('<html>Service unavailable</html>'), null);
});

test('--w3c posts every feed as rawdata with output=soap12, one request per second', async () => {
  await withBuild(() => {}, async (out) => {
    const { fn, calls } = fakeFetch(() => new Response(SOAP(true)));
    /** @type {number[]} */
    const pauses = [];
    const result = await runCheck(['--out', out, '--w3c'], {
      w3c: { fetch: fn, sleep: async (ms) => void pauses.push(ms) },
    });
    assert.equal(result.code, 0, result.err);
    assert.equal(calls.length, 7);
    assert.equal(pauses.length, 6);
    assert.ok(pauses.every((ms) => ms === W3C_REQUEST_INTERVAL_MS && ms === 1000));
    for (const call of calls) {
      assert.equal(call.url, 'https://validator.w3.org/feed/check.cgi');
      assert.equal(call.method, 'POST');
      assert.equal(call.body.get('output'), 'soap12');
      assert.match(call.body.get('rawdata') ?? '', /^<\?xml[\s\S]*<feed xmlns="http:\/\/www\.w3\.org\/2005\/Atom"/);
    }
  });
});

test('--w3c fails when the validator finds an error, naming the feed file', async () => {
  await withBuild(() => {}, async (out) => {
    const { fn } = fakeFetch((_body, index) =>
      new Response(index === 1 ? SOAP(false, SOAP_ERROR('Duplicate entry id')) : SOAP(true)),
    );
    const result = await runCheck(['--out', out, '--w3c'], { w3c: { fetch: fn, sleep: async () => {} } });
    assert.equal(result.code, 1);
    assert.match(result.err, /workshop\/journal\/[^\n]*feed\.xml: W3C validator: line 3: Duplicate entry id/);
    assert.match(result.err, /coffer check: 1 failure\(s\)/);
  });
});

test('--w3c only warns when the service cannot be reached', async () => {
  await withBuild(() => {}, async (out) => {
    const offline = fakeFetch(() => {
      throw new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND validator.w3.org') });
    });
    const result = await runCheck(['--out', out, '--w3c'], { w3c: { fetch: offline.fn, sleep: async () => {} } });
    assert.equal(result.code, 0, result.err);
    assert.equal(offline.calls.length, 1, 'stops after the first failed request');
    assert.match(result.err, /^warning: .*workshop\/.*feed\.xml: the W3C feed validator could not be reached \(fetch failed: getaddrinfo ENOTFOUND/m);
  });
  await withBuild(() => {}, async (out) => {
    for (const reply of [() => new Response('busy', { status: 503 }), () => new Response('<html>maintenance</html>')]) {
      const { fn } = fakeFetch(reply);
      const result = await runCheck(['--out', out, '--w3c'], { w3c: { fetch: fn, sleep: async () => {} } });
      assert.equal(result.code, 0, result.err);
      assert.match(result.err, /could not be reached/);
    }
  });
});

test('local failures still fail --w3c when the service is offline', async () => {
  await withBuild(
    (site) => rewrite(site, 'journal/feed.xml', (xml) => xml.replace(/<updated>[^<]*<\/updated>/, '')),
    async (out) => {
      const { fn } = fakeFetch(() => {
        throw new TypeError('fetch failed');
      });
      const result = await runCheck(['--out', out, '--w3c'], { w3c: { fetch: fn, sleep: async () => {} } });
      assert.equal(result.code, 1);
      assert.match(result.err, /invalid feed/);
      assert.match(result.err, /warning: .*could not be reached/);
    },
  );
});

test('--w3c reports an unreadable build manifest as a failure instead of throwing', async () => {
  await withBuild(
    (site) => writeFileSync(join(site, '.coffer-manifest.json'), '{bad'),
    async (out) => {
      const { fn, calls } = fakeFetch(() => new Response('<soap/>'));
      for (const args of [['--out', out], ['--out', out, '--w3c']]) {
        const result = await runCheck(args, { w3c: { fetch: fn, sleep: async () => {} } });
        assert.equal(result.code, 1);
        assert.match(result.err, /workshop\/\.coffer-manifest\.json: cannot read the build manifest/);
      }
      assert.ok(calls.every((call) => !String(call.url).includes('workshop')), 'nothing of the broken site is sent');
    },
  );
});

test('a manifest without pages, feeds or redirects is a failure, not a TypeError', async () => {
  for (const key of ['pages', 'feeds', 'redirects', 'sitemap']) {
    await withBuild(
      (site) => {
        const file = join(site, '.coffer-manifest.json');
        const manifest = JSON.parse(readFileSync(file, 'utf8'));
        delete manifest[key];
        writeFileSync(file, JSON.stringify(manifest));
      },
      async (out) => {
        const result = await runCheck(['--out', out, '--w3c'], { w3c: { fetch: fakeFetch(() => new Response('<soap/>')).fn, sleep: async () => {} } });
        assert.equal(result.code, 1);
        assert.match(result.err, new RegExp(`workshop/\.coffer-manifest\.json: the build manifest is not usable: "${key}" is missing`));
      },
    );
  }
});

test('validateFeedsOnline sends nothing when there are no feeds', async () => {
  const { fn, calls } = fakeFetch(() => new Response(SOAP(true)));
  const result = await validateFeedsOnline([], { fetch: fn });
  assert.deepEqual(result, { errors: [], warnings: [], checked: 0 });
  assert.equal(calls.length, 0);
});

test('the resolver follows redirect rules and rejects loops', async () => {
  await withBuild(
    (site) => writeFileSync(join(site, '_redirects'), '/a /b 301\n/b /a 301\n/c https://elsewhere.example/ 301\n'),
    async (out) => {
      const resolver = createOutputResolver(join(out, 'workshop'));
      assert.equal(resolver.resolve('/a'), null);
      assert.deepEqual(resolver.resolve('/c'), { external: 'https://elsewhere.example/' });
      assert.ok('file' in (resolver.resolve('/journal') ?? {}));
    },
  );
});
