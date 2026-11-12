import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildSites, MANIFEST_FILE_NAME } from '../src/build.js';
import {
  BUILD_INFO_FILE_NAME,
  checkBuildInfo,
  compareBuildInfo,
  fetchBuildInfo,
  nextScheduledAt,
} from '../src/build-info.js';
import { checkOutput } from '../src/check/index.js';
import { parseRebuildNeededArgs, run } from '../src/cli.js';
import { loadConfig, RESERVED_OUTPUT_NAMES } from '../src/config.js';
import { commitFromLsRemote, readRemoteCommits } from '../src/docs/sources.js';
import { readVersion } from '../src/version.js';
import { TINY_PNG } from './helpers/images.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixture = join(root, 'example', 'sample-tool');

const GIT_AVAILABLE = spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;
const NO_GIT = GIT_AVAILABLE ? false : 'git is not installed';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

/**
 * @template T
 * @param {(dir: string) => Promise<T> | T} body
 * @returns {Promise<T>}
 */
async function inTemp(body) {
  const dir = mkdtempSync(join(tmpdir(), 'coffer-info-'));
  try {
    return await body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * @param {string} cwd
 * @param {string[]} args
 * @returns {string}
 */
function git(cwd, args) {
  return execFileSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
}

/**
 * A git repository made from the fixture, with a branch and tags.
 *
 * @param {string} parent
 * @returns {string} Its path.
 */
function makeRepository(parent) {
  const repo = join(parent, 'origin');
  cpSync(fixture, repo, { recursive: true });
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'first']);
  git(repo, ['tag', 'light']);
  git(repo, ['tag', '-a', 'v1', '-m', 'version one']);
  return repo;
}

/** Adds a commit to the repository. @param {string} repo */
function commitAgain(repo) {
  writeFileSync(join(repo, 'NEWS.md'), `news ${Math.random()}\n`);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'more']);
}

// --- Pure pieces -----------------------------------------------------------------

test('nextScheduledAt is the earliest non-draft post dated after now, or null', () => {
  const now = new Date('2026-06-01T12:00:00Z');
  const post = (/** @type {string} */ date, draft = false) => ({ draft, date: new Date(date) });
  assert.equal(nextScheduledAt([], now), null);
  assert.equal(nextScheduledAt([post('2026-05-01T00:00:00Z')], now), null);
  // A post dated exactly now is published, so it is not waiting.
  assert.equal(nextScheduledAt([post('2026-06-01T12:00:00Z')], now), null);
  // A draft never counts, however near its date is.
  assert.equal(nextScheduledAt([post('2026-06-02T00:00:00Z', true)], now), null);
  assert.equal(
    nextScheduledAt([post('2026-07-01T00:00:00Z'), post('2026-06-02T00:00:00Z', true), post('2026-06-10T08:30:00Z'), post('2026-05-01T00:00:00Z')], now),
    '2026-06-10T08:30:00.000Z',
  );
  assert.equal(nextScheduledAt([post('2026-06-01T12:00:00.001Z')], now), '2026-06-01T12:00:00.001Z');
});

test('commitFromLsRemote prefers a branch, then the commit an annotated tag points at, then a lightweight tag', () => {
  const output = [
    `${SHA_A}\trefs/heads/main`,
    `${SHA_B}\trefs/heads/x/refs/heads/main`,
    `${'c'.repeat(40)}\trefs/tags/v1`,
    `${'d'.repeat(40)}\trefs/tags/v1^{}`,
    `${'e'.repeat(40)}\trefs/tags/light`,
    `${'f'.repeat(40)}\trefs/heads/both`,
    `${'1'.repeat(40)}\trefs/tags/both`,
    '',
  ].join('\n');
  assert.equal(commitFromLsRemote(output, 'main'), SHA_A);
  assert.equal(commitFromLsRemote(output, 'v1'), 'd'.repeat(40));
  assert.equal(commitFromLsRemote(output, 'light'), 'e'.repeat(40));
  assert.equal(commitFromLsRemote(output, 'both'), 'f'.repeat(40));
  assert.equal(commitFromLsRemote(output, 'missing'), null);
  assert.equal(commitFromLsRemote('garbage\nrefs/heads/main\n', 'main'), null);
});

/** @param {Record<string, unknown>} [changes] */
function validInfo(changes = {}) {
  return {
    builtAt: '2026-06-01T12:00:00.000Z',
    engineVersion: '0.1.0',
    sources: { lathe: { url: 'https://example.org/a/lathe.git', ref: 'main', sha: SHA_A } },
    nextScheduledAt: null,
    ...changes,
  };
}

test('checkBuildInfo accepts the documented shape and refuses anything else', () => {
  const ok = checkBuildInfo(validInfo({ nextScheduledAt: '2026-06-10T08:30:00.000Z', extra: 'ignored' }));
  assert.ok('value' in ok);
  assert.deepEqual([...ok.value.sources], [['lathe', { url: 'https://example.org/a/lathe.git', ref: 'main', sha: SHA_A }]]);
  assert.ok('value' in checkBuildInfo(validInfo({ sources: {}, builtAt: '2026-06-01T16:00:00+04:00' })));

  const bad = [
    null,
    [],
    'text',
    7,
    validInfo({ builtAt: undefined }),
    validInfo({ builtAt: 'yesterday' }),
    validInfo({ builtAt: '2026-13-45T00:00:00Z' }),
    validInfo({ builtAt: 1780000000000 }),
    validInfo({ engineVersion: 1 }),
    validInfo({ engineVersion: '' }),
    validInfo({ sources: undefined }),
    validInfo({ sources: [] }),
    validInfo({ sources: { lathe: 'x' } }),
    validInfo({ sources: { lathe: { url: 'u', ref: 'main', sha: 'abc' } } }),
    validInfo({ sources: { lathe: { url: 'u', ref: 'main', sha: SHA_A.toUpperCase() } } }),
    validInfo({ sources: { lathe: { url: 'u', ref: '', sha: SHA_A } } }),
    validInfo({ sources: { lathe: { url: 7, ref: 'main', sha: SHA_A } } }),
    validInfo({ sources: { 'Not A Slug': { url: 'u', ref: 'main', sha: SHA_A } } }),
    validInfo({ nextScheduledAt: undefined }),
    validInfo({ nextScheduledAt: 'soon' }),
    validInfo({ nextScheduledAt: 5 }),
  ];
  for (const value of bad) assert.ok('problem' in checkBuildInfo(value), JSON.stringify(value));
  // "__proto__" as a key must be a refused slug, never a prototype assignment.
  const proto = JSON.parse('{"builtAt":"2026-06-01T12:00:00Z","engineVersion":"1","nextScheduledAt":null,"sources":{"__proto__":{"url":"u","ref":"r","sha":"' + SHA_A + '"}}}');
  assert.ok('problem' in checkBuildInfo(proto));
});

test('compareBuildInfo compares per slug: added, removed, a changed repository, ref or commit, and a due post', () => {
  const now = new Date('2026-06-01T12:00:00Z');
  const source = { url: 'https://example.org/a/lathe.git', ref: 'main', sha: SHA_A };
  const read = (/** @type {Record<string, unknown>} */ changes) => {
    const checked = checkBuildInfo(validInfo(changes));
    assert.ok('value' in checked);
    return checked.value;
  };
  const codes = (/** @type {ReturnType<typeof read>} */ deployed, /** @type {[string, typeof source][]} */ current) =>
    compareBuildInfo(deployed, new Map(current), now).map((reason) => `${reason.code}:${reason.source ?? ''}`);

  assert.deepEqual(codes(read({}), [['lathe', source]]), []);
  assert.deepEqual(codes(read({}), [['lathe', { ...source, sha: SHA_B }]]), ['source-sha-changed:lathe']);
  assert.deepEqual(codes(read({}), [['lathe', { ...source, ref: 'v2' }]]), ['source-ref-changed:lathe']);
  assert.deepEqual(codes(read({}), [['lathe', { ...source, url: 'https://example.org/b/lathe.git' }]]), ['source-url-changed:lathe']);
  assert.deepEqual(codes(read({}), []), ['source-removed:lathe']);
  assert.deepEqual(codes(read({ sources: {} }), [['lathe', source]]), ['source-added:lathe']);
  // Each slug is judged on its own.
  const two = read({ sources: { a: source, b: source } });
  assert.deepEqual(codes(two, [['a', source], ['b', { ...source, sha: SHA_B }]]), ['source-sha-changed:b']);
  assert.deepEqual(codes(two, [['a', source], ['c', source]]), ['source-removed:b', 'source-added:c']);
  // The time of the next post: due at, and after, that moment; not before it.
  assert.deepEqual(codes(read({ nextScheduledAt: '2026-06-01T12:00:00.001Z' }), [['lathe', source]]), []);
  assert.deepEqual(codes(read({ nextScheduledAt: '2026-06-01T12:00:00.000Z' }), [['lathe', source]]), ['scheduled-time-passed:']);
  assert.deepEqual(codes(read({ nextScheduledAt: '2026-05-01T00:00:00Z' }), [['lathe', { ...source, sha: SHA_B }]]), ['source-sha-changed:lathe', 'scheduled-time-passed:']);
});

test('build-info.json is a name the build writes itself', () => {
  assert.equal(BUILD_INFO_FILE_NAME, 'build-info.json');
  assert.ok(RESERVED_OUTPUT_NAMES.includes(BUILD_INFO_FILE_NAME));
});

// --- A build ----------------------------------------------------------------------

const SITE_CONFIG = [
  'sites:',
  '  - id: demo',
  '    baseUrl: https://demo.example',
  '    lang: en',
  '    title: Demo',
  '    description: A demo site.',
  '    timezone: Europe/Samara',
  '    blogs:',
  '      - { id: journal, dir: content/journal, prefix: journal, title: Journal }',
  '    projects: { dir: content/projects }',
  '',
].join('\n');

/**
 * @param {string} date
 * @param {boolean} [draft]
 * @returns {string}
 */
function postText(date, draft = false) {
  return `---\ntitle: Post ${date}\ndate: ${date}\n${draft ? 'draft: true\n' : ''}summary: A post.\n---\n\nText.\n`;
}

/**
 * The files of a site with one tool project whose docs come from a git repository, and a blog with posts.
 *
 * @param {string | null} docsYaml Indented lines of the project's `docs` block; null for none.
 * @param {Record<string, string>} [posts] Post file name to text.
 * @returns {Record<string, string | Buffer>}
 */
function siteFiles(docsYaml, posts = {}) {
  /** @type {Record<string, string | Buffer>} */
  const files = {
    'coffer.yaml': SITE_CONFIG,
    'content/home.md': '---\ntitle: Demo\n---\n\nAbout.\n',
    'content/projects/lathe/project.yaml': `name: Lathe\npitch: Turns wood.\nkind: tool\nstatus: released\ncard: card.png\nrepo: https://github.example/me/lathe\n${docsYaml ?? ''}`,
    'content/projects/lathe/index.md': 'Text.\n',
    'content/projects/lathe/card.png': TINY_PNG,
  };
  for (const [name, text] of Object.entries(posts)) files[`content/journal/${name}`] = text;
  return files;
}

/**
 * @template T
 * @param {Record<string, string | Buffer>} files
 * @param {(dir: string) => Promise<T>} body
 * @returns {Promise<T>}
 */
function inSite(files, body) {
  return inTemp(async (dir) => {
    for (const [name, content] of Object.entries(files)) {
      const target = join(dir, ...name.split('/'));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    return body(dir);
  });
}

const NO_GUIDES = '  guides: []\n';

test('a build writes build-info.json with the documentation commits and the next scheduled post', { skip: NO_GIT }, async () => {
  await inTemp(async (parent) => {
    const repo = makeRepository(parent);
    const url = pathToFileURL(repo).href;
    const head = git(repo, ['rev-parse', 'HEAD']);
    const posts = {
      // 2026-06-05 is a date without a time: midnight in Europe/Samara (UTC+4), which is 20:00 UTC on the 4th.
      'dated.md': postText('2026-06-05'),
      'later.md': postText('2026-07-01T10:00:00+04:00'),
      'soon-draft.md': postText('2026-06-02', true),
      'past.md': postText('2026-05-01'),
    };
    await inSite(siteFiles(`docs:\n  source: { git: "${url}", ref: v1 }\n${NO_GUIDES}`, posts), async (dir) => {
      const build = (/** @type {Date} */ now) =>
        buildSites(loadConfig({ configPath: join(dir, 'coffer.yaml') }), {
          out: join(dir, 'out'),
          now,
          clock: () => new Date('2026-06-01T08:09:10.123Z'),
        });
      const [result] = await build(new Date('2026-06-01T12:00:00Z'));
      const text = readFileSync(join(dir, 'out', 'demo', BUILD_INFO_FILE_NAME), 'utf8');
      assert.deepEqual(JSON.parse(text), {
        builtAt: '2026-06-01T08:09:10.123Z',
        engineVersion: readVersion(),
        // The annotated tag is recorded as the commit it points at, which is what the clone is at.
        sources: { lathe: { url, ref: 'v1', sha: head } },
        nextScheduledAt: '2026-06-04T20:00:00.000Z',
      });
      assert.deepEqual(result.manifest.buildInfo, JSON.parse(text));
      assert.deepEqual(Object.keys(JSON.parse(text)), ['builtAt', 'engineVersion', 'sources', 'nextScheduledAt']);
      // It is a file of the site and not a page: the sitemap, the manifest's pages and the checks leave it alone.
      assert.ok(!result.manifest.sitemap.some((entry) => entry.includes('build-info')));
      assert.ok(!readFileSync(join(dir, 'out', 'demo', 'sitemap.xml'), 'utf8').includes('build-info'));
      assert.ok(!result.manifest.pages.some((page) => page.file === BUILD_INFO_FILE_NAME));
      assert.ok(existsSync(join(dir, 'out', 'demo', MANIFEST_FILE_NAME)));
      const checked = await checkOutput(loadConfig({ configPath: join(dir, 'coffer.yaml') }), { out: join(dir, 'out') });
      assert.deepEqual(checked.failures, []);

      // The "now" of the build decides which posts are waiting: at the date of the first one it is published, and the next is named.
      await build(new Date('2026-06-04T20:00:00Z'));
      assert.equal(JSON.parse(readFileSync(join(dir, 'out', 'demo', BUILD_INFO_FILE_NAME), 'utf8')).nextScheduledAt, '2026-07-01T06:00:00.000Z');
      await build(new Date('2026-08-01T00:00:00Z'));
      assert.equal(JSON.parse(readFileSync(join(dir, 'out', 'demo', BUILD_INFO_FILE_NAME), 'utf8')).nextScheduledAt, null);

      // A preview build says the same thing: drafts do not count, and neither do posts that are already due.
      const [preview] = await buildSites(loadConfig({ configPath: join(dir, 'coffer.yaml') }), {
        out: join(dir, 'preview'),
        drafts: true,
        now: new Date('2026-06-01T12:00:00Z'),
      });
      assert.equal(preview.manifest.buildInfo.nextScheduledAt, '2026-06-04T20:00:00.000Z');
    });
  });
});

test('a build with no docs source and no waiting post writes empty sources and a null time', async () => {
  await inSite(siteFiles(null, { 'past.md': postText('2026-05-01') }), async (dir) => {
    await buildSites(loadConfig({ configPath: join(dir, 'coffer.yaml') }), { out: join(dir, 'out'), now: new Date('2026-06-01T12:00:00Z') });
    const info = JSON.parse(readFileSync(join(dir, 'out', 'demo', BUILD_INFO_FILE_NAME), 'utf8'));
    assert.deepEqual(info.sources, {});
    assert.equal(info.nextScheduledAt, null);
    assert.match(info.builtAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  });
});

test('coffer check reports a build-info.json that is missing, unusable or different from the manifest', async () => {
  await inSite(siteFiles(null, { 'past.md': postText('2026-05-01') }), async (dir) => {
    const config = loadConfig({ configPath: join(dir, 'coffer.yaml') });
    await buildSites(config, { out: join(dir, 'out'), now: new Date('2026-06-01T12:00:00Z') });
    const file = join(dir, 'out', 'demo', BUILD_INFO_FILE_NAME);
    const original = readFileSync(file, 'utf8');
    /** @param {string | null} text */
    const failures = async (text) => {
      if (text === null) rmSync(file);
      else writeFileSync(file, text);
      return (await checkOutput(config, { out: join(dir, 'out') })).failures.filter((failure) => failure.file === BUILD_INFO_FILE_NAME).map((failure) => failure.message);
    };
    assert.deepEqual(await failures(original), []);
    assert.deepEqual(await failures(null), ['build-info.json is missing']);
    assert.match((await failures('{"builtAt": 5}'))[0], /^build-info\.json is not usable: /);
    assert.match((await failures('nope'))[0], /^build-info\.json cannot be read: /);
    assert.deepEqual(await failures(original.replace(/"engineVersion": "[^"]*"/, '"engineVersion": "9.9.9"')), ['build-info.json differs from the build manifest']);
  });
});

// --- Fetching the deployed file ------------------------------------------------------

/**
 * @typedef {(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => void} Handler
 */

/**
 * A local web server for the duration of a test. Every connection is closed at the end.
 *
 * @param {Record<string, Handler | { status?: number, headers?: Record<string, string>, body?: string | Buffer }>} routes By path.
 * @param {(origin: string, server: import('node:http').Server) => Promise<void>} body
 */
async function withServer(routes, body) {
  const server = createServer((request, response) => {
    const route = routes[(request.url ?? '').split('?')[0]];
    if (route === undefined) {
      response.writeHead(404);
      response.end('not found');
    } else if (typeof route === 'function') {
      route(request, response);
    } else {
      response.writeHead(route.status ?? 200, { 'content-type': 'application/json', ...route.headers });
      response.end(route.body ?? '');
    }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', () => done(undefined)));
  const address = /** @type {import('node:net').AddressInfo} */ (server.address());
  try {
    await body(`http://127.0.0.1:${address.port}`, server);
  } finally {
    server.closeAllConnections();
    await new Promise((done) => server.close(() => done(undefined)));
  }
}

test('fetchBuildInfo reads the file, follows a few redirects and turns every failure into a reason', async () => {
  const good = JSON.stringify(validInfo());
  await withServer(
    {
      '/ok.json': { body: good },
      '/bom.json': { body: `\uFEFF${good}` },
      '/hop1': { status: 302, headers: { location: '/hop2' } },
      '/hop2': { status: 301, headers: { location: '/ok.json' } },
      '/loop': { status: 302, headers: { location: '/loop' } },
      '/to-file': { status: 302, headers: { location: 'file:///etc/passwd' } },
      '/to-credentials': { status: 302, headers: { location: 'http://user:SECRETPW@127.0.0.1/x' } },
      '/no-location': { status: 302 },
      '/html.json': { body: '<html>', headers: { 'content-type': 'text/html' } },
      '/array.json': { body: '[]' },
      '/shape.json': { body: JSON.stringify(validInfo({ builtAt: 'x' })) },
      '/binary.json': { body: Buffer.from([0xff, 0xfe, 0x00]) },
      '/big.json': { body: `${good}${' '.repeat(5000)}` },
      '/error.json': { status: 500, body: 'oops' },
      '/slow.json': () => {
        // Never answers.
      },
    },
    async (origin) => {
      const ok = await fetchBuildInfo(`${origin}/ok.json`);
      assert.ok(ok.ok);
      assert.equal(ok.info.engineVersion, '0.1.0');
      assert.ok((await fetchBuildInfo(`${origin}/bom.json`)).ok);
      assert.ok((await fetchBuildInfo(`${origin}/hop1`)).ok);
      assert.ok((await fetchBuildInfo(`${origin}/ok.json?x=1#frag`)).ok);

      /** @param {string} path @param {import('../src/build-info.js').HttpOptions} [options] */
      const reason = async (path, options) => {
        const result = await fetchBuildInfo(`${origin}${path}`, options);
        assert.ok(!result.ok, path);
        return result.reason;
      };
      assert.match(await reason('/hop1', { maxRedirects: 1 }), /more than 1 redirects/);
      assert.match(await reason('/loop'), /more than 3 redirects/);
      assert.match(await reason('/to-file'), /redirects to an address that must be an http/);
      const credentials = await reason('/to-credentials');
      assert.match(credentials, /must not contain a user name or password/);
      assert.ok(!credentials.includes('SECRETPW'));
      assert.match(await reason('/no-location'), /server answered 302/);
      assert.match(await reason('/missing.json'), /server answered 404/);
      assert.match(await reason('/error.json'), /server answered 500/);
      assert.match(await reason('/html.json'), /not valid JSON/);
      assert.match(await reason('/binary.json'), /not valid JSON/);
      assert.match(await reason('/array.json'), /not a build-info file: it is not a JSON object/);
      assert.match(await reason('/shape.json'), /not a build-info file: "builtAt"/);
      assert.match(await reason('/big.json', { maxBytes: 1000 }), /larger than 1000 bytes/);
      assert.match(await reason('/slow.json', { timeoutMs: 150 }), /no answer within 0\.1 s/);
    },
  );
  // Nobody listens any more.
  const refused = await fetchBuildInfo('http://127.0.0.1:1/build-info.json', { timeoutMs: 2000 });
  assert.ok(!refused.ok);
});

test('a body without a declared length is cut off at the limit', async () => {
  await withServer(
    {
      '/stream.json': (_request, response) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.write(' '.repeat(4000));
        setTimeout(() => response.end(' '.repeat(4000)), 20);
      },
    },
    async (origin) => {
      const result = await fetchBuildInfo(`${origin}/stream.json`, { maxBytes: 5000 });
      assert.ok(!result.ok);
      assert.match(result.reason, /larger than 5000 bytes/);
    },
  );
});

test('fetchBuildInfo only fetches http and https addresses without credentials', async () => {
  let calls = 0;
  const spy = /** @type {typeof fetch} */ (async () => {
    calls += 1;
    return new Response('{}');
  });
  for (const address of ['file:///etc/passwd', 'ftp://example.org/a', 'data:text/plain,{}', 'javascript:alert(1)', 'not a url', 'https://user:SECRETPW@example.org/build-info.json', 'https://token@example.org/build-info.json']) {
    const result = await fetchBuildInfo(address, { fetch: spy });
    assert.ok(!result.ok, address);
    assert.ok(!result.reason.includes('SECRETPW'), address);
  }
  assert.equal(calls, 0);
});

// --- readRemoteCommits -----------------------------------------------------------------

test('readRemoteCommits asks git ls-remote through the safety layer', async () => {
  /** @type {{ args: string[], env: Record<string, string>, cwd: string }[]} */
  const calls = [];
  const exec = async (/** @type {string[]} */ args, /** @type {import('../src/docs/sources.js').GitCall} */ call) => {
    calls.push({ args, env: call.env, cwd: call.cwd });
    return { code: 0, stdout: `${SHA_A}\trefs/heads/main\n`, stderr: '', timedOut: false };
  };
  const commits = await readRemoteCommits([{ slug: 'lathe', source: { git: 'https://tok:SECRETPW@example.org/a/lathe.git', ref: 'main' } }], {
    exec,
    env: { PATH: '/bin', GIT_DIR: '/elsewhere', GIT_EXTERNAL_DIFF: 'x' },
  });
  assert.deepEqual([...commits], [['lathe', SHA_A]]);
  assert.equal(calls.length, 1);
  const { args, env } = calls[0];
  const at = args.indexOf('ls-remote');
  assert.ok(at > 0);
  // The address follows "--", the patterns follow the address, and nothing the config could have chosen is a git option.
  assert.deepEqual(args.slice(at), ['ls-remote', '--', 'https://tok:SECRETPW@example.org/a/lathe.git', 'refs/heads/main', 'refs/tags/main', 'refs/tags/main^{}']);
  assert.ok(args.some((arg) => arg.startsWith('core.hooksPath=')));
  assert.ok(args.includes('credential.helper='));
  assert.equal(env.GIT_ALLOW_PROTOCOL, 'https');
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(env.GIT_ASKPASS, '');
  assert.equal(env.GIT_DIR, undefined);
  assert.equal(env.GIT_EXTERNAL_DIFF, undefined);
  // git does not run in a folder of any repository it is asked about, and the work folder is removed afterwards.
  assert.ok(!existsSync(calls[0].cwd));
});

test('readRemoteCommits reports every failure without credentials', async () => {
  const exec = async (/** @type {string[]} */ args) => {
    if (args.includes('https://tok:SECRETPW@example.org/a/down.git')) {
      return { code: 128, stdout: '', stderr: "fatal: unable to access 'https://tok:SECRETPW@example.org/a/down.git/': Could not resolve host\n", timedOut: false };
    }
    if (args.some((arg) => arg.includes('slow.git'))) return { code: null, stdout: '', stderr: '', timedOut: true };
    if (args.some((arg) => arg.includes('nogit.git'))) return { code: null, stdout: '', stderr: '', timedOut: false, spawnError: 'spawn git ENOENT' };
    return { code: 0, stdout: '', stderr: '', timedOut: false };
  };
  await assert.rejects(
    readRemoteCommits(
      [
        { slug: 'down', source: { git: 'https://tok:SECRETPW@example.org/a/down.git', ref: 'main' } },
        { slug: 'slow', source: { git: 'https://example.org/a/slow.git', ref: 'main' } },
        { slug: 'nogit', source: { git: 'https://example.org/a/nogit.git', ref: 'main' } },
        { slug: 'empty', source: { git: 'https://example.org/a/empty.git', ref: 'main' } },
        { slug: 'badurl', source: { git: 'ext::sh -c touch /tmp/x', ref: 'main' } },
        { slug: 'badref', source: { git: 'https://example.org/a/ok.git', ref: '--upload-pack=x' } },
      ],
      { exec, timeoutMs: 1500 },
    ),
    (error) => {
      assert.ok(error instanceof Error && 'errors' in error);
      const errors = /** @type {string[]} */ (error.errors);
      assert.equal(errors.length, 6);
      assert.ok(!error.message.includes('SECRETPW'));
      assert.match(errors[0], /^project "down": cannot read the commit of https:\/\/example\.org\/a\/down\.git \(ref main\): ls-remote: git failed \(exit code 128\)/);
      assert.match(errors[1], /did not finish within 1\.5 s/);
      assert.match(errors[2], /git was not found/);
      assert.match(errors[3], /the branch or tag does not exist in the repository/);
      assert.match(errors[4], /source\.git /);
      assert.match(errors[5], /source\.ref /);
      return true;
    },
  );
});

// --- coffer rebuild-needed --------------------------------------------------------------------

/**
 * @param {string[]} argv
 * @param {import('../src/cli.js').Services} [services]
 */
async function runCli(argv, services = {}) {
  let out = '';
  let err = '';
  const code = await run(argv, { out: (text) => (out += text), err: (text) => (err += text) }, services);
  return { code, out, err };
}

test('coffer rebuild-needed parses its options', () => {
  assert.deepEqual(parseRebuildNeededArgs(['--url', 'https://x.example/build-info.json']), { json: false, url: 'https://x.example/build-info.json' });
  assert.deepEqual(parseRebuildNeededArgs(['--url=https://x.example/b.json', '--config', 'c.yaml', '--site=main', '--json']), {
    json: true,
    url: 'https://x.example/b.json',
    configPath: 'c.yaml',
    site: 'main',
  });
  assert.deepEqual(parseRebuildNeededArgs([]), { error: '--url is required: the address of the deployed build-info.json' });
  assert.deepEqual(parseRebuildNeededArgs(['--url']), { error: '--url needs a value' });
  assert.deepEqual(parseRebuildNeededArgs(['--force']), { error: 'unexpected argument "--force"' });
  assert.deepEqual(parseRebuildNeededArgs(['https://user:SECRETPW@example.org/x']), { error: 'unexpected argument "https://example.org/x"' });
});

test('coffer rebuild-needed is in the help text', async () => {
  assert.match((await runCli(['help'])).out, /rebuild-needed {2}Say whether a deployed site is out of date/);
});

test('coffer rebuild-needed refuses addresses and options it cannot use with exit code 2', async () => {
  await inSite(siteFiles(null), async (dir) => {
    const config = join(dir, 'coffer.yaml');
    for (const url of ['file:///etc/passwd', 'ftp://example.org/a', 'nonsense', 'https://user:SECRETPW@example.org/build-info.json']) {
      const result = await runCli(['rebuild-needed', '--config', config, '--url', url]);
      assert.equal(result.code, 2, url);
      assert.match(result.err, /^coffer: --url /);
      assert.ok(!result.err.includes('SECRETPW'));
      assert.equal(result.out, '');
    }
    assert.equal((await runCli(['rebuild-needed', '--config', config])).code, 2);
    assert.equal((await runCli(['rebuild-needed', '--bogus'])).code, 2);
    const unknown = await runCli(['rebuild-needed', '--config', config, '--url', 'http://127.0.0.1:1/x', '--site', 'nope']);
    assert.equal(unknown.code, 2);
    assert.match(unknown.err, /no site "nope" \(known: demo\)/);
  });
});

/**
 * @param {Record<string, unknown>} sources By slug.
 * @param {string | null} [next]
 */
function deployed(sources, next = null) {
  return JSON.stringify({ builtAt: '2026-06-01T08:00:00.000Z', engineVersion: '0.1.0', sources, nextScheduledAt: next });
}

test('coffer rebuild-needed answers no, or yes with the reasons, from a local server and a file:// repository', { skip: NO_GIT }, async () => {
  await inTemp(async (parent) => {
    const repo = makeRepository(parent);
    const url = pathToFileURL(repo).href;
    const first = git(repo, ['rev-parse', 'HEAD']);
    const now = new Date('2026-06-01T12:00:00Z');
    await inSite(siteFiles(`docs:\n  source: { git: "${url}", ref: main }\n${NO_GUIDES}`), async (dir) => {
      const config = join(dir, 'coffer.yaml');
      let body = deployed({ lathe: { url, ref: 'main', sha: first } });
      await withServer(
        {
          '/build-info.json': (_request, response) => {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(body);
          },
          '/old': { status: 301, headers: { location: '/build-info.json' } },
        },
        async (origin) => {
          const ask = (/** @type {string[]} */ extra = [], /** @type {import('../src/cli.js').Services} */ services = {}) =>
            runCli(['rebuild-needed', '--config', config, '--url', `${origin}/build-info.json`, ...extra], { now, ...services });

          // Nothing changed: no.
          let result = await ask();
          assert.deepEqual([result.code, result.out, result.err], [0, 'no\n', '']);
          result = await ask(['--site', 'demo']);
          assert.equal(result.out, 'no\n');
          const redirected = await runCli(['rebuild-needed', '--config', config, '--url', `${origin}/old`], { now });
          assert.equal(redirected.out, 'no\n');

          // The machine-readable form.
          result = await ask(['--json']);
          assert.equal(result.code, 0);
          assert.deepEqual(JSON.parse(result.out), { needed: false, site: 'demo', url: `${origin}/build-info.json`, checkedAt: now.toISOString(), reasons: [] });

          // A commit was pushed to the branch: yes, naming both commits.
          commitAgain(repo);
          const second = git(repo, ['rev-parse', 'HEAD']);
          result = await ask();
          assert.equal(result.code, 0);
          assert.equal(result.out, `yes\n- source-sha-changed: lathe: main moved from ${first} to ${second}\n`);
          result = await ask(['--json']);
          assert.deepEqual(JSON.parse(result.out).reasons, [
            { code: 'source-sha-changed', source: 'lathe', message: `lathe: main moved from ${first} to ${second}` },
          ]);
          assert.equal(JSON.parse(result.out).needed, true);

          // The deployed build has caught up; a post is scheduled for later: no. The moment comes: yes.
          body = deployed({ lathe: { url, ref: 'main', sha: second } }, '2026-06-01T12:00:01.000Z');
          assert.equal((await ask()).out, 'no\n');
          result = await ask([], { now: new Date('2026-06-01T12:00:01Z') });
          assert.equal(result.code, 0);
          assert.match(result.out, /^yes\n- scheduled-time-passed: a post scheduled for 2026-06-01T12:00:01\.000Z is due/);
          assert.match((await ask([], { now: new Date('2027-01-01T00:00:00Z') })).out, /^yes\n/);

          // A source that was added, removed or moved to another ref or repository is a difference too.
          body = deployed({});
          assert.match((await ask()).out, /^yes\n- source-added: lathe: the docs source /);
          body = deployed({ lathe: { url, ref: 'main', sha: second }, extra: { url, ref: 'main', sha: second } });
          assert.match((await ask()).out, /^yes\n- source-removed: extra: /);
          body = deployed({ lathe: { url, ref: 'develop', sha: second } });
          assert.match((await ask()).out, /^yes\n- source-ref-changed: lathe: the ref changed from develop to main/);
          body = deployed({ lathe: { url: 'https://example.org/a/lathe.git', ref: 'main', sha: second } });
          assert.match((await ask()).out, /^yes\n- source-url-changed: lathe: /);

          // The deployed file is wrong in some way: yes, and why.
          for (const [text, pattern] of /** @type {[string, RegExp][]} */ ([
            ['not json', /not valid JSON/],
            ['[]', /not a build-info file/],
            [JSON.stringify({ builtAt: 'x' }), /not a build-info file/],
            ['x'.repeat(300 * 1024), /larger than 262144 bytes/],
          ])) {
            body = text;
            result = await ask();
            assert.equal(result.code, 0);
            assert.match(result.out, /^yes\n- deployed-unavailable: /);
            assert.match(result.out, pattern);
          }
          result = await runCli(['rebuild-needed', '--config', config, '--url', `${origin}/missing.json`], { now });
          assert.equal(result.code, 0);
          assert.match(result.out, /^yes\n- deployed-unavailable: the deployed .*\/missing\.json cannot be used: the server answered 404\n$/);
          assert.equal(result.err, '');
        },
      );
      // Nothing answers at the address: yes.
      const down = await runCli(['rebuild-needed', '--config', config, '--url', 'http://127.0.0.1:1/build-info.json'], { now, http: { timeoutMs: 2000 } });
      assert.equal(down.code, 0);
      assert.match(down.out, /^yes\n- deployed-unavailable: /);
    });
  });
});

test('an annotated tag is compared by the commit it points at, as the build records it', { skip: NO_GIT }, async () => {
  await inTemp(async (parent) => {
    const repo = makeRepository(parent);
    const url = pathToFileURL(repo).href;
    const head = git(repo, ['rev-parse', 'HEAD']);
    const tagObject = git(repo, ['rev-parse', 'v1']);
    assert.notEqual(tagObject, head);
    await inSite(siteFiles(`docs:\n  source: { git: "${url}", ref: v1 }\n${NO_GUIDES}`), async (dir) => {
      await withServer({ '/b.json': { body: deployed({ lathe: { url, ref: 'v1', sha: head } }) } }, async (origin) => {
        const result = await runCli(['rebuild-needed', '--config', join(dir, 'coffer.yaml'), '--url', `${origin}/b.json`]);
        assert.deepEqual([result.code, result.out], [0, 'no\n']);
      });
    });
  });
});

test('coffer rebuild-needed exits 1, not with an answer, when a configured source cannot be asked, and shows no credentials', async () => {
  const secret = 'SECRETPW';
  const files = siteFiles(`docs:\n  source: { git: "https://tok:${secret}@example.invalid/a/lathe.git", ref: main }\n${NO_GUIDES}`);
  await inSite(files, async (dir) => {
    /** @type {string[][]} */
    const calls = [];
    const exec = async (/** @type {string[]} */ args) => {
      calls.push(args);
      return { code: 128, stdout: '', stderr: `fatal: unable to access 'https://tok:${secret}@example.invalid/a/lathe.git/': nope\n`, timedOut: false };
    };
    await withServer(
      { '/b.json': { body: deployed({ lathe: { url: 'https://example.invalid/a/lathe.git', ref: 'main', sha: SHA_A } }) } },
      async (origin) => {
        const result = await runCli(['rebuild-needed', '--config', join(dir, 'coffer.yaml'), '--url', `${origin}/b.json`], { docs: { exec } });
        assert.equal(result.code, 1);
        assert.equal(result.out, '');
        assert.match(result.err, /^project "lathe": cannot read the commit of https:\/\/example\.invalid\/a\/lathe\.git \(ref main\): ls-remote: git failed \(exit code 128\)/);
        assert.ok(!result.err.includes(secret));
        assert.equal(calls.length, 1);
        // The credential reaches git (it is the user's configuration) and nothing else.
        assert.ok(calls[0].some((arg) => arg.includes(secret)));
      },
    );
    // When the deployed file is unusable the answer is yes without asking any repository.
    calls.length = 0;
    const answer = await runCli(['rebuild-needed', '--config', join(dir, 'coffer.yaml'), '--url', 'http://127.0.0.1:1/b.json'], { docs: { exec }, http: { timeoutMs: 2000 } });
    assert.equal(answer.code, 0);
    assert.match(answer.out, /^yes\n- deployed-unavailable/);
    assert.equal(calls.length, 0);
  });
});

test('with several sites coffer rebuild-needed needs --site and compares only that site', async () => {
  const files = siteFiles(null);
  files['coffer.yaml'] =
    SITE_CONFIG +
    ['  - id: second', '    baseUrl: https://second.example', '    lang: ru', '    title: Second', '    description: Another site.', '    contentDir: content2', '    projects: { dir: content2/projects }', ''].join('\n');
  files['content2/home.md'] = '---\ntitle: Second\n---\n\nAbout.\n';
  files['content2/projects/lathe/project.yaml'] = String(files['content/projects/lathe/project.yaml']) + 'docs:\n  source: { git: "https://example.invalid/a/two.git", ref: main }\n  guides: []\n';
  files['content2/projects/lathe/index.md'] = 'Text.\n';
  files['content2/projects/lathe/card.png'] = TINY_PNG;
  await inSite(files, async (dir) => {
    const config = join(dir, 'coffer.yaml');
    const exec = async () => ({ code: 0, stdout: `${SHA_A}\trefs/heads/main\n`, stderr: '', timedOut: false });
    await withServer(
      {
        '/first.json': { body: deployed({}) },
        '/second.json': { body: deployed({ lathe: { url: 'https://example.invalid/a/two.git', ref: 'main', sha: SHA_A } }) },
      },
      async (origin) => {
        const ask = (/** @type {string} */ path, /** @type {string[]} */ extra) =>
          runCli(['rebuild-needed', '--config', config, '--url', `${origin}${path}`, ...extra], { docs: { exec } });
        const missing = await ask('/first.json', []);
        assert.equal(missing.code, 2);
        assert.match(missing.err, /the configuration has 2 sites; choose one with --site <id> \(known: demo, second\)/);
        assert.equal((await ask('/first.json', ['--site', 'demo'])).out, 'no\n');
        assert.equal((await ask('/second.json', ['--site', 'second'])).out, 'no\n');
        // The second site's file against the first site would be a removed source.
        assert.match((await ask('/second.json', ['--site', 'demo'])).out, /source-removed/);
        assert.match((await ask('/first.json', ['--site', 'second'])).out, /source-added/);
      },
    );
  });
});

test('the engine can be run as a program: rebuild-needed with a usage error exits 2', () => {
  const bin = fileURLToPath(new URL('../bin/coffer.js', import.meta.url));
  const result = spawnSync(process.execPath, [bin, 'rebuild-needed'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--url is required/);
});

// --- The landing file ---------------------------------------------------------------------------

test('checkBuildInfo reads the landing file of a source and refuses a broken one; compareBuildInfo notices a different file', () => {
  const source = { url: 'https://example.org/a/lathe.git', ref: 'main', sha: SHA_A };
  const landing = { file: 'site/landing.md', sha: SHA_A };
  const checked = checkBuildInfo(validInfo({ sources: { lathe: { ...source, landing } } }));
  assert.ok('value' in checked);
  assert.deepEqual([...checked.value.sources], [['lathe', { ...source, landing }]]);
  for (const bad of [null, 'site/landing.md', [], {}, { file: '', sha: SHA_A }, { file: 7, sha: SHA_A }, { file: 'a.md' }, { file: 'a.md', sha: 'abc' }]) {
    assert.ok('problem' in checkBuildInfo(validInfo({ sources: { lathe: { ...source, landing: bad } } })), JSON.stringify(bad));
  }
  const now = new Date('2026-06-01T12:00:00Z');
  const codes = (/** @type {Record<string, unknown>} */ was, /** @type {Record<string, unknown>} */ is) => {
    const deployed = checkBuildInfo(validInfo({ sources: { lathe: was } }));
    assert.ok('value' in deployed);
    return compareBuildInfo(deployed.value, new Map([['lathe', /** @type {never} */ (is)]]), now).map((reason) => reason.code);
  };
  assert.deepEqual(codes({ ...source, landing }, { ...source, landing }), []);
  assert.deepEqual(codes({ ...source, landing }, { ...source, landing: { ...landing, file: 'site/home.md' } }), ['source-landing-changed']);
  assert.deepEqual(codes(source, { ...source, landing }), ['source-landing-changed']);
  assert.deepEqual(codes({ ...source, landing }, source), ['source-landing-changed']);
  // A moved branch is reported once, as a moved branch.
  assert.deepEqual(codes({ ...source, landing }, { ...source, sha: SHA_B, landing: { ...landing, sha: SHA_B } }), ['source-sha-changed']);
});

/**
 * A git repository with a landing file and nothing else a build would use.
 *
 * @param {string} parent
 * @returns {string} Its path.
 */
function makeLandingRepository(parent) {
  const repo = join(parent, 'lathe-repo');
  mkdirSync(join(repo, 'site'), { recursive: true });
  writeFileSync(join(repo, 'site', 'landing.md'), 'The lathe turns wood.\n');
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'first']);
  return repo;
}

/**
 * The files of a site whose only project has a landing file in its git `docs.source`, no guides and no `index.md`.
 *
 * @param {string} url Address of the project repository.
 * @returns {Record<string, string | Buffer>}
 */
function landingSiteFiles(url) {
  const files = siteFiles(`landing: { file: site/landing.md }\ndocs:\n  source: { git: "${url}", ref: main }\n${NO_GUIDES}`, { 'past.md': postText('2026-05-01') });
  delete files['content/projects/lathe/index.md'];
  return files;
}

test('the manifest and build-info.json name the landing file and the commit it was read at', { skip: NO_GIT }, async () => {
  await inTemp(async (parent) => {
    const repo = makeLandingRepository(parent);
    const url = pathToFileURL(repo).href;
    const head = git(repo, ['rev-parse', 'HEAD']);
    await inSite(landingSiteFiles(url), async (dir) => {
      const [result] = await buildSites(loadConfig({ configPath: join(dir, 'coffer.yaml') }), { out: join(dir, 'out'), now: new Date('2026-06-01T12:00:00Z') });
      const entry = /** @type {import('../src/build.js').ManifestProject} */ (result.manifest.projects[0]);
      assert.deepEqual(entry.docs?.landing, { file: 'site/landing.md', sha: head });
      assert.deepEqual(entry.docs?.source, { type: 'git', git: url, ref: 'main', sha: head });
      const info = JSON.parse(readFileSync(join(dir, 'out', 'demo', BUILD_INFO_FILE_NAME), 'utf8'));
      assert.deepEqual(info.sources, { lathe: { url, ref: 'main', sha: head, landing: { file: 'site/landing.md', sha: head } } });
      assert.deepEqual(result.manifest.buildInfo, info);
      assert.deepEqual((await checkOutput(loadConfig({ configPath: join(dir, 'coffer.yaml') }), { out: join(dir, 'out') })).failures, []);
    });
  });
  // A project without a landing file has none in either place.
  await inTemp(async (parent) => {
    const repo = makeRepository(parent);
    const url = pathToFileURL(repo).href;
    await inSite(siteFiles(`docs:\n  source: { git: "${url}", ref: main }\n${NO_GUIDES}`, { 'past.md': postText('2026-05-01') }), async (dir) => {
      const [result] = await buildSites(loadConfig({ configPath: join(dir, 'coffer.yaml') }), { out: join(dir, 'out') });
      assert.equal(/** @type {import('../src/build.js').ManifestProject} */ (result.manifest.projects[0]).docs?.landing, null);
      assert.ok(!('landing' in JSON.parse(readFileSync(join(dir, 'out', 'demo', BUILD_INFO_FILE_NAME), 'utf8')).sources.lathe));
    });
  });
});

test('a push to the repository of a project with a landing file and no guides makes rebuild-needed say yes, with no change in the site', { skip: NO_GIT }, async () => {
  await inTemp(async (parent) => {
    const repo = makeLandingRepository(parent);
    const url = pathToFileURL(repo).href;
    const first = git(repo, ['rev-parse', 'HEAD']);
    await inSite(landingSiteFiles(url), async (dir) => {
      const config = loadConfig({ configPath: join(dir, 'coffer.yaml') });
      await buildSites(config, { out: join(dir, 'out'), now: new Date('2026-06-01T12:00:00Z') });
      // The deployed site is the file the build wrote.
      const body = readFileSync(join(dir, 'out', 'demo', BUILD_INFO_FILE_NAME), 'utf8');
      await withServer({ '/build-info.json': { body } }, async (origin) => {
        const ask = () => runCli(['rebuild-needed', '--config', join(dir, 'coffer.yaml'), '--url', `${origin}/build-info.json`], { now: new Date('2026-06-01T13:00:00Z') });
        const before = await ask();
        assert.deepEqual([before.code, before.out], [0, 'no\n']);

        // Only the project repository changes: its landing file is edited and pushed.
        writeFileSync(join(repo, 'site', 'landing.md'), 'The lathe turns wood and metal.\n');
        git(repo, ['commit', '-q', '-am', 'edit the landing page']);
        const second = git(repo, ['rev-parse', 'HEAD']);
        const answer = await ask();
        assert.equal(answer.code, 0);
        assert.equal(answer.out, `yes\n- source-sha-changed: lathe: main moved from ${first} to ${second}\n`);
      });
    });
  });
});

test('rebuild-needed says yes when the landing file of a project is a different one than the deployed build used', { skip: NO_GIT }, async () => {
  await inTemp(async (parent) => {
    const repo = makeLandingRepository(parent);
    const url = pathToFileURL(repo).href;
    const head = git(repo, ['rev-parse', 'HEAD']);
    await inSite(landingSiteFiles(url), async (dir) => {
      const deployedBody = deployed({ lathe: { url, ref: 'main', sha: head, landing: { file: 'site/old.md', sha: head } } });
      await withServer({ '/b.json': { body: deployedBody } }, async (origin) => {
        const result = await runCli(['rebuild-needed', '--config', join(dir, 'coffer.yaml'), '--url', `${origin}/b.json`]);
        assert.deepEqual([result.code, result.out], [0, 'yes\n- source-landing-changed: lathe: the landing file changed from site/old.md to site/landing.md\n']);
      });
    });
  });
});
