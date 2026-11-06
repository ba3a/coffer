import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { run } from '../src/cli.js';
import { normalizeConfig } from '../src/config.js';
import { createFsStore } from '../src/media/fs-store.js';
import { hashFile } from '../src/media/fsutil.js';
import { LockError, parseLock, renderLock } from '../src/media/lock.js';
import { checkMediaPath, compareBytes } from '../src/media/paths.js';
import { HashCache } from '../src/media/state.js';
import { isValidKey, MediaStoreError } from '../src/media/store.js';
import { createStore } from '../src/media/stores.js';
import { lockMedia, mediaContext } from '../src/media/sync.js';

/** @param {string | Buffer} data */
const sha = (data) => createHash('sha256').update(data).digest('hex');

/**
 * Removes a folder; Windows sometimes holds a file for a moment after it was closed.
 *
 * @param {string} dir
 */
function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

const CONFIG = `sites:
  - { id: s, baseUrl: "https://example.org", title: T, contentDir: content }
media:
  store: { type: fs, dir: ../store }
`;

/**
 * Two working copies of one content repository that share one folder store.
 *
 * @param {string} [config] The text of coffer.yaml in both copies.
 */
function workspace(config = CONFIG) {
  const root = mkdtempSync(join(tmpdir(), 'coffer-media-'));
  const a = join(root, 'a');
  const b = join(root, 'b');
  for (const dir of [a, b]) {
    mkdirSync(join(dir, 'content', 'journal', 'trip'), { recursive: true });
    writeFileSync(join(dir, 'coffer.yaml'), config);
  }
  return { root, a, b, store: join(root, 'store') };
}

/**
 * Runs `coffer media ...` against a working copy.
 *
 * @param {string} dir
 * @param {string[]} args
 * @param {Record<string, string | undefined>} [env]
 */
async function media(dir, args, env) {
  let out = '';
  let err = '';
  const code = await run(
    ['media', ...args, '--config', join(dir, 'coffer.yaml')],
    { out: (text) => (out += text), err: (text) => (err += text) },
    { env },
  );
  return { code, out, err };
}

/**
 * @param {string} dir
 * @param {string} rel
 * @param {string | Buffer} content
 */
function put(dir, rel, content) {
  const file = join(dir, ...rel.split('/'));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  // Old enough that the hash cache trusts it (see RACY_WINDOW_MS).
  const past = new Date(Date.now() - 60_000);
  utimesSync(file, past, past);
}

/**
 * Every file below `content`, with its content, for comparing two copies.
 *
 * @param {string} dir
 * @returns {Record<string, string>}
 */
function snapshot(dir) {
  /** @type {Record<string, string>} */
  const files = {};
  /** @param {string} current @param {string} prefix */
  const walk = (current, prefix) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(join(current, entry.name), rel);
      else files[rel] = sha(readFileSync(join(current, entry.name)));
    }
  };
  walk(join(dir, 'content'), '');
  return files;
}

/**
 * Copies the lock file, which git would carry between the copies.
 *
 * @param {string} from
 * @param {string} to
 */
function sendLock(from, to) {
  copyFileSync(join(from, 'media.lock.json'), join(to, 'media.lock.json'));
}

/** @param {string} dir */
function leftovers(dir) {
  /** @type {string[]} */
  const found = [];
  /** @param {string} current */
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(current, entry.name));
      else if (entry.name.endsWith('.part')) found.push(join(current, entry.name));
    }
  };
  walk(dir);
  return found;
}

const PHOTO_1 = 'content/journal/trip/IMG_0001.JPG';
const PHOTO_2 = 'content/journal/trip/IMG_0002.heic';
const VIDEO = 'content/journal/trip/clip.mp4';

// ---------------------------------------------------------------------------
// Paths

test('checkMediaPath accepts plain relative paths and refuses every unsafe one', () => {
  for (const good of ['a.jpg', 'content/journal/trip/IMG_0001.JPG', 'content/Фото/снимок 1.jpg', 'a/b c/d.mp4']) {
    assert.deepEqual(checkMediaPath(good), { value: good });
  }
  const bad = [
    '', '/abs.jpg', '../x.jpg', 'a/../x.jpg', './x.jpg', 'a/./x.jpg', 'a//x.jpg', 'a/', 'C:/x.jpg', 'c:x.jpg', 'a\\b.jpg',
    '.git/hooks/pre-commit', 'content/.hidden/x.jpg', '.coffer/media-state.json', 'a/NUL.jpg', 'CON', 'a/com1.txt', 'LPT9.png',
    'a/b.', 'a/b ', 'a/x:stream', 'a/<x>.jpg', 'a/q?.jpg', 'a/s*.jpg', 'a/pipe|.jpg', 'a/nul\u0000.jpg', 'a/x\ny.jpg',
    'a/\u202eexe.jpg', `${'x'.repeat(50)}/`.repeat(25) + 'y', `${'n'.repeat(256)}.jpg`, '\ud800.jpg',
  ];
  for (const path of bad) {
    assert.ok('problem' in checkMediaPath(path), `should refuse ${JSON.stringify(path)}`);
  }
  assert.ok('problem' in checkMediaPath(42));
});

test('compareBytes orders by UTF-8 bytes, not by locale', () => {
  const names = ['b', 'B', 'a', 'Z', 'é', 'e', 'я', '10', '9'];
  assert.deepEqual([...names].sort(compareBytes), ['10', '9', 'B', 'Z', 'a', 'b', 'e', 'é', 'я']);
});

// ---------------------------------------------------------------------------
// The lock format

test('renderLock writes one sorted entry per line, deterministically', () => {
  const entries = [
    { path: 'content/b.jpg', sha256: sha('b'), size: 1 },
    { path: 'content/Z.jpg', sha256: sha('Z'), size: 2 },
    { path: 'content/a.jpg', sha256: sha('a'), size: 3 },
  ];
  const text = renderLock(entries);
  assert.equal(text, renderLock([...entries].reverse()));
  const lines = text.split('\n');
  assert.equal(lines[0], '{"version":1,"files":[');
  assert.equal(lines[1], `{"path":"content/Z.jpg","sha256":"${sha('Z')}","size":2},`);
  assert.equal(lines[2], `{"path":"content/a.jpg","sha256":"${sha('a')}","size":3},`);
  assert.equal(lines[3], `{"path":"content/b.jpg","sha256":"${sha('b')}","size":1}`);
  assert.equal(lines[4], ']}');
  assert.equal(lines[5], '');
  assert.ok(!text.includes('\r'));
  assert.doesNotThrow(() => JSON.parse(text));
  assert.deepEqual(parseLock(text), [entries[1], entries[2], entries[0]]);
  assert.equal(renderLock([]), '{"version":1,"files":[\n]}\n');
  assert.deepEqual(parseLock(renderLock([])), []);
});

test('parseLock is strict and names the line', () => {
  const good = { path: 'content/a.jpg', sha256: sha('a'), size: 1 };
  const next = { path: 'content/b.jpg', sha256: sha('b'), size: 2 };
  const text = renderLock([good, next]);
  assert.deepEqual(parseLock(text.replace(/\n/g, '\r\n')), [good, next], 'CR LF from a checkout is accepted');

  /**
   * @param {string} lockText
   * @param {RegExp} pattern
   */
  const refuses = (lockText, pattern) => {
    assert.throws(() => parseLock(lockText), (error) => {
      assert.ok(error instanceof LockError);
      assert.match(error.message, pattern);
      return true;
    });
  };
  const line = (/** @type {object} */ entry) => JSON.stringify(entry);
  refuses('', /must end with a newline/);
  refuses(text.slice(0, -1), /must end with a newline/);
  refuses(`\ufeff${text}`, /byte order mark/);
  refuses(text.replace('{"version":1,"files":[', '[{'), /media\.lock\.json:1/);
  refuses(text.replace(']}\n', ''), /expected \]\}/);
  refuses(text.replace('size":1},', 'size":1}'), /:2: every entry but the last must end with a comma/);
  refuses(text.replace('size":2}', 'size":2},'), /:3: the last entry must not end with a comma/);
  refuses(text.replace('{"path":"content/a.jpg"', '<<<<<<< HEAD\n{"path":"content/a.jpg"'), /merge conflict marker/);
  refuses(`{"version":1,"files":[\n${line(next)},\n${line(good)}\n]}\n`, /out of order/);
  refuses(`{"version":1,"files":[\n${line(good)},\n${line(good)}\n]}\n`, /listed twice/);
  refuses(renderLock([good, { ...good, path: 'content/A.jpg' }]), /same file on a case-insensitive/);
  refuses(renderLock([good, { ...good, path: 'content/a.jpg/b.jpg' }]), /both a file and a folder/);
  refuses(renderLock([{ ...good, sha256: sha('a').toUpperCase() }]), /sha256 must be 64 lowercase/);
  refuses(renderLock([{ ...good, sha256: 'abc' }]), /sha256 must be 64 lowercase/);
  refuses(renderLock([{ ...good, size: -1 }]), /size must be a whole number/);
  refuses(renderLock([{ ...good, size: 1.5 }]), /size must be a whole number/);
  refuses(renderLock(/** @type {never} */ ([{ ...good, size: '1' }])), /size must be a whole number/);
  refuses(`{"version":1,"files":[\n{"path":"content/a.jpg","sha256":"${sha('a')}","size":1,"extra":true}\n]}\n`, /exactly "path", "sha256" and "size"/);
  refuses(`{"version":1,"files":[\n{"sha256":"${sha('a')}","path":"content/a.jpg","size":1}\n]}\n`, /not written the way/);
  refuses(`{"version":1,"files":[\n{"path": "content/a.jpg","sha256":"${sha('a')}","size":1}\n]}\n`, /not written the way/);
  refuses('{"version":1,"files":[\nnot json\n]}\n', /not valid JSON/);
  for (const path of ['../evil.jpg', '/etc/x.jpg', 'C:/x.jpg', '.git/config', 'a\\b.jpg', 'NUL.jpg']) {
    refuses(renderLock([{ ...good, path }]), /the path /);
  }
  assert.throws(() => parseLock('{"version":1,"files":[\n1\n]}\n'), LockError);
});

// ---------------------------------------------------------------------------
// The folder store

test('the folder store keeps, checks and returns objects by their hash', async () => {
  const root = mkdtempSync(join(tmpdir(), 'coffer-fs-store-'));
  try {
    const store = createFsStore({ dir: join(root, 'objects') });
    const source = join(root, 'photo.jpg');
    const content = Buffer.from('a photo');
    writeFileSync(source, content);
    const key = sha(content);

    assert.equal(await store.has(key), false);
    await store.put(key, source);
    assert.equal(await store.has(key), true);
    await store.put(key, source); // keeping it twice is fine
    assert.deepEqual(readdirSync(join(root, 'objects', 'originals')), [key]);

    const target = join(root, 'copy.jpg');
    await store.get(key, target);
    assert.deepEqual(readFileSync(target), content);

    // The wrong hash is refused and nothing is kept.
    const other = sha('something else');
    await assert.rejects(store.put(other, source), (error) => error instanceof MediaStoreError && error.code === 'mismatch');
    assert.equal(await store.has(other), false);
    assert.deepEqual(readdirSync(join(root, 'objects', 'originals')), [key]);

    // A missing object.
    await assert.rejects(store.get(other, join(root, 'nope.jpg')), (error) => error instanceof MediaStoreError && error.code === 'missing');
    assert.equal(existsSync(join(root, 'nope.jpg')), false);

    // A damaged object is not handed out, and no partial file is left.
    writeFileSync(join(root, 'objects', 'originals', key), 'damaged');
    const damaged = join(root, 'damaged.jpg');
    await assert.rejects(store.get(key, damaged), (error) => error instanceof MediaStoreError && error.code === 'corrupt');
    assert.equal(existsSync(damaged), false);
  } finally {
    cleanup(root);
  }
});

test('the folder store accepts only 64 lowercase hexadecimal keys', async () => {
  const root = mkdtempSync(join(tmpdir(), 'coffer-fs-store-'));
  try {
    const store = createFsStore({ dir: root });
    const file = join(root, 'f.jpg');
    writeFileSync(file, 'x');
    for (const key of ['', 'abc', '../../etc/passwd', `${'a'.repeat(63)}/`, 'A'.repeat(64), `${'a'.repeat(64)}0`, 'g'.repeat(64), 'a/'.repeat(32), 'originals/' + 'a'.repeat(64)]) {
      assert.equal(isValidKey(key), false);
      await assert.rejects(store.has(key), (error) => error instanceof MediaStoreError && error.code === 'invalid-key');
      await assert.rejects(store.put(key, file), MediaStoreError);
      await assert.rejects(store.get(key, join(root, 'out.jpg')), MediaStoreError);
    }
    assert.equal(isValidKey(sha('x')), true);
    assert.deepEqual(readdirSync(root).sort(), ['f.jpg']);
  } finally {
    cleanup(root);
  }
});

test('hashFile streams a file that is larger than one chunk', async () => {
  const root = mkdtempSync(join(tmpdir(), 'coffer-hash-'));
  try {
    const content = Buffer.alloc(3 * 1024 * 1024 + 17, 'abc');
    const file = join(root, 'big.mp4');
    writeFileSync(file, content);
    assert.deepEqual(await hashFile(file), { sha256: sha(content), size: content.length });
  } finally {
    cleanup(root);
  }
});

// ---------------------------------------------------------------------------
// Configuration

/**
 * @param {unknown} media
 * @param {string} [contentDir]
 */
function configWith(media, contentDir = 'content') {
  return { sites: [{ id: 's', baseUrl: 'https://example.org', title: 'T', contentDir }], media };
}

/**
 * @param {unknown} raw
 * @returns {string[]}
 */
function problemsOf(raw) {
  try {
    normalizeConfig(raw, { file: '/work/coffer.yaml', label: 'coffer.yaml' });
    return [];
  } catch (error) {
    return /** @type {{ errors: string[] }} */ (error).errors;
  }
}

test('a configuration without a media block has no media settings', () => {
  const config = normalizeConfig({ sites: configWith(undefined).sites }, { file: '/work/coffer.yaml' });
  assert.equal('media' in config, false);
});

test('the media block gets its defaults', () => {
  const config = normalizeConfig(configWith({ store: { type: 'fs', dir: '../originals' } }), { file: '/work/site/coffer.yaml' });
  const media = /** @type {import('../src/media/config.js').MediaConfig} */ (config.media);
  assert.equal(media.lock, 'media.lock.json');
  assert.equal(media.includeIsDefault, true);
  assert.deepEqual(media.store, { type: 'fs', dir: resolve('/work', 'originals') });
  assert.ok(media.include.includes('content/**/*.[jJ][pP][gG]'));
  assert.ok(media.include.includes('content/**/*.[hH][eE][iI][cC]'));
  assert.ok(media.include.includes('content/**/*.[mM][pP]4'));
  assert.ok(!media.include.some((pattern) => /[sS][vV][gG]/.test(pattern)), 'SVG is not an original by default');
  assert.equal(media.include.length, 14);
});

test('the default patterns follow the content folders of all sites and cover nested ones once', () => {
  const raw = {
    sites: [
      { id: 'one', baseUrl: 'https://one.example', title: '1', contentDir: 'content/one' },
      { id: 'two', baseUrl: 'https://two.example', title: '2', contentDir: 'content/two' },
      { id: 'three', baseUrl: 'https://three.example', title: '3', contentDir: 'content/two/inner' },
    ],
    media: { store: { type: 'fs', dir: 'x' } },
  };
  const media = /** @type {import('../src/media/config.js').MediaConfig} */ (normalizeConfig(raw, { file: '/w/coffer.yaml' }).media);
  const folders = new Set(media.include.map((pattern) => pattern.split('/**')[0]));
  assert.deepEqual([...folders].sort(), ['content/one', 'content/two']);
});

test('explicit include patterns and lock are checked', () => {
  const ok = normalizeConfig(configWith({ store: { type: 'fs', dir: 'x' }, include: ['photos/**/*.jpg'], lock: 'meta/media.lock.json' }), { file: '/w/coffer.yaml' });
  assert.deepEqual(ok.media?.include, ['photos/**/*.jpg']);
  assert.equal(ok.media?.includeIsDefault, false);
  assert.equal(ok.media?.lockFile, resolve('/w', 'meta', 'media.lock.json'));

  const store = { type: 'fs', dir: 'x' };
  assert.match(problemsOf(configWith({ store, include: [] })).join('\n'), /media\.include: must not be empty/);
  assert.match(problemsOf(configWith({ store, include: ['/abs/*.jpg'] })).join('\n'), /media\.include\[0\]/);
  assert.match(problemsOf(configWith({ store, include: ['../*.jpg'] })).join('\n'), /media\.include\[0\]/);
  assert.match(problemsOf(configWith({ store, include: ['{a,b}.jpg'] })).join('\n'), /media\.include\[0\].*alternatives/);
  assert.match(problemsOf(configWith({ store, include: ['a/*.jpg', 'a/*.jpg'] })).join('\n'), /listed twice/);
  assert.match(problemsOf(configWith({ store, include: 'a/*.jpg' })).join('\n'), /must be a list/);
  assert.match(problemsOf(configWith({ store, lock: '../media.lock.json' })).join('\n'), /media\.lock/);
  assert.match(problemsOf(configWith({ store, lock: '/etc/media.lock.json' })).join('\n'), /media\.lock/);
  assert.match(problemsOf(configWith({ store, lock: '.git/media.lock.json' })).join('\n'), /media\.lock/);
  assert.match(problemsOf(configWith({ store, colour: 'red' })).join('\n'), /media\.colour: unknown key/);
  assert.match(problemsOf(configWith('yes')).join('\n'), /media: must be a mapping/);
  assert.match(problemsOf(configWith({ include: ['a/*.jpg'] })).join('\n'), /media\.store: is required/);
  assert.match(problemsOf(configWith({ store: { type: 'ftp' } })).join('\n'), /media\.store\.type: must be one of: fs, s3/);
  assert.match(problemsOf(configWith({ store: { type: 'fs' } })).join('\n'), /media\.store\.dir: is required/);
  assert.match(problemsOf(configWith({ store: { type: 'fs', dir: 'x', bucket: 'b' } })).join('\n'), /media\.store\.bucket: unknown key/);
  // The default needs content folders inside the configuration folder.
  assert.match(problemsOf(configWith({ store }, '../elsewhere')).join('\n'), /outside the folder of the configuration file/);
  assert.deepEqual(problemsOf(configWith({ store, include: ['x/*.jpg'] }, '../elsewhere')), []);
});

test('an s3 store is checked: credentials come from named environment variables, never from the file', () => {
  const s3 = { type: 's3', endpoint: 'https://abc.r2.cloudflarestorage.com', bucket: 'my-media', region: 'auto', prefix: 'site/one' };
  const config = normalizeConfig(configWith({ store: s3 }), { file: '/w/coffer.yaml' });
  assert.deepEqual(config.media?.store, {
    type: 's3',
    endpoint: 'https://abc.r2.cloudflarestorage.com',
    bucket: 'my-media',
    region: 'auto',
    prefix: 'site/one',
    accessKeyIdEnv: 'COFFER_MEDIA_ACCESS_KEY_ID',
    secretAccessKeyEnv: 'COFFER_MEDIA_SECRET_ACCESS_KEY',
  });
  const custom = normalizeConfig(configWith({ store: { type: 's3', endpoint: 'https://${ACCOUNT_ID}.r2.cloudflarestorage.com', bucket: 'my-media', accessKeyIdEnv: 'MY_KEY_ID', secretAccessKeyEnv: 'MY_SECRET' } }), { file: '/w/coffer.yaml' });
  assert.equal(custom.media?.store.type === 's3' && custom.media.store.region, 'auto');
  assert.equal(custom.media?.store.type === 's3' && custom.media.store.accessKeyIdEnv, 'MY_KEY_ID');

  const bad = (/** @type {object} */ overrides) => problemsOf(configWith({ store: { ...s3, ...overrides } })).join('\n');
  assert.match(problemsOf(configWith({ store: { type: 's3' } })).join('\n'), /endpoint: is required[\s\S]*bucket: is required/);
  assert.match(bad({ endpoint: 'http://insecure.example' }), /endpoint: must be an https address/);
  assert.match(bad({ endpoint: 'https://user:pass@host.example' }), /endpoint: must not contain credentials/);
  assert.match(bad({ endpoint: 'not an address' }), /endpoint/);
  assert.match(bad({ bucket: 'Bad_Bucket' }), /bucket: must be a bucket name/);
  assert.match(bad({ region: 'EU Central' }), /region/);
  assert.match(bad({ prefix: '../escape' }), /prefix/);
  assert.match(bad({ accessKeyId: 'AKIAIOSFODNN7EXAMPLE' }), /accessKeyId: credentials are never read from the configuration file/);
  assert.match(bad({ secretAccessKey: 'hunter2' }), /secretAccessKey: credentials are never read/);
  assert.match(bad({ token: 'abc' }), /token: credentials are never read/);
  assert.match(bad({ accessKeyIdEnv: 'AKIAIOSFODNN7EXAMPLE' }), /accessKeyIdEnv: must be the NAME of an environment variable/);
  assert.match(bad({ secretAccessKeyEnv: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCY' }), /secretAccessKeyEnv: must be the NAME/);
  assert.match(bad({ secretAccessKeyEnv: 'lower_case' }), /secretAccessKeyEnv: must be the NAME/);
  assert.match(bad({ accessKeyIdEnv: 'SAME', secretAccessKeyEnv: 'SAME' }), /another variable/);
  assert.match(bad({ dir: 'x' }), /dir: unknown key for a "s3" store/);
});

test('an s3 store is accepted by the configuration but cannot be created in this build', async () => {
  const config = normalizeConfig(configWith({ store: { type: 's3', endpoint: 'https://abc.example.com', bucket: 'my-media' } }), { file: '/w/coffer.yaml' });
  await assert.rejects(createStore(/** @type {NonNullable<typeof config.media>} */ (config.media).store), (error) => {
    assert.ok(error instanceof MediaStoreError);
    assert.equal(error.code, 'unavailable');
    assert.match(error.message, /"s3" media store is not implemented in this build/);
    return true;
  });
});

// ---------------------------------------------------------------------------
// The commands

test('without a media block the commands say so and change nothing', async () => {
  const w = workspace('sites:\n  - { id: s, baseUrl: "https://example.org", title: T, contentDir: content }\n');
  try {
    put(w.a, PHOTO_1, 'photo');
    for (const sub of ['status', 'lock', 'push', 'pull', 'gitignore']) {
      const result = await media(w.a, [sub]);
      assert.equal(result.code, 1, sub);
      assert.match(result.err, /there is no "media" block/);
    }
    assert.equal(existsSync(join(w.a, 'media.lock.json')), false);
    assert.equal(existsSync(join(w.a, '.coffer')), false);
  } finally {
    cleanup(w.root);
  }
});

test('usage errors exit 2, apart from the 1 of a conflict or a failure', async () => {
  const w = workspace();
  try {
    const none = await media(w.a, []);
    assert.match(none.err, /media needs a subcommand/);
    assert.equal(none.code, 2);
    const unknown = await media(w.a, ['sync']);
    assert.match(unknown.err, /unknown media subcommand "sync"/);
    assert.equal(unknown.code, 2);
    const lock = await media(w.a, ['lock', '--force']);
    assert.match(lock.err, /unexpected argument "--force"/);
    assert.equal(lock.code, 2);
    const pull = await media(w.a, ['pull', '--bogus']);
    assert.match(pull.err, /unexpected argument "--bogus"/);
    assert.equal(pull.code, 2);
    const noPath = await run(['media', 'pull', '--config'], { out: () => {}, err: () => {} }, {});
    assert.equal(noPath, 2);
  } finally {
    cleanup(w.root);
  }
});

test('lock writes a sorted lock file, and again without changes', async () => {
  const w = workspace();
  try {
    put(w.a, PHOTO_1, 'photo one');
    put(w.a, PHOTO_2, 'photo two');
    put(w.a, VIDEO, 'video');
    put(w.a, 'content/journal/trip/index.md', '# text, not an original');
    put(w.a, 'content/journal/trip/diagram.svg', '<svg/>');
    put(w.a, 'content/journal/trip/.hidden.jpg', 'hidden');
    put(w.a, 'elsewhere/photo.jpg', 'outside the content folder');

    const first = await media(w.a, ['lock']);
    assert.equal(first.code, 0, first.err);
    const text = readFileSync(join(w.a, 'media.lock.json'), 'utf8');
    assert.equal(
      text,
      renderLock([
        { path: PHOTO_1, sha256: sha('photo one'), size: 9 },
        { path: PHOTO_2, sha256: sha('photo two'), size: 9 },
        { path: VIDEO, sha256: sha('video'), size: 5 },
      ]),
    );
    assert.match(first.out, /3 original\(s\), 3 added, 0 changed, 0 removed/);

    const second = await media(w.a, ['lock']);
    assert.equal(second.code, 0);
    assert.match(second.out, /3 original\(s\), unchanged/);
    assert.equal(readFileSync(join(w.a, 'media.lock.json'), 'utf8'), text);
  } finally {
    cleanup(w.root);
  }
});

test('lock reads a file again only when its size or time changed', async () => {
  const w = workspace();
  try {
    put(w.a, PHOTO_1, 'photo one');
    put(w.a, PHOTO_2, 'photo two');
    const context = mediaContext(/** @type {never} */ ({
      file: join(w.a, 'coffer.yaml'),
      dir: w.a,
      media: normalizeConfig({ sites: configWith(undefined).sites, media: { store: { type: 'fs', dir: '../store' } } }, { file: join(w.a, 'coffer.yaml') }).media,
    }));
    const first = await lockMedia(context);
    assert.deepEqual([first.hashed, first.cached], [2, 0]);
    const second = await lockMedia(context);
    assert.deepEqual([second.hashed, second.cached], [0, 2]);

    // Same size, newer time: read again, and the change is seen.
    writeFileSync(join(w.a, ...PHOTO_1.split('/')), 'PHOTO ONE');
    const third = await lockMedia(context);
    assert.equal(third.hashed, 1);
    assert.deepEqual(third.changed, [PHOTO_1]);
    assert.equal(parseLock(readFileSync(join(w.a, 'media.lock.json'), 'utf8')).find((entry) => entry.path === PHOTO_1)?.sha256, sha('PHOTO ONE'));
  } finally {
    cleanup(w.root);
  }
});

test('a damaged cache or state file counts as empty', async () => {
  const w = workspace();
  try {
    put(w.a, PHOTO_1, 'photo one');
    assert.equal((await media(w.a, ['lock'])).code, 0);
    assert.equal((await media(w.a, ['push'])).code, 0);
    for (const name of ['media-cache.json', 'media-state.json']) {
      writeFileSync(join(w.a, '.coffer', name), '{"version":1,"files":{"a');
    }
    const status = await media(w.a, ['status']);
    assert.equal(status.code, 0, status.err);
    const pull = await media(w.a, ['pull']);
    assert.equal(pull.code, 0, pull.err);
    assert.equal(readFileSync(join(w.a, ...PHOTO_1.split('/')), 'utf8'), 'photo one');
    for (const bad of ['[]', '"x"', 'null', '{"version":2,"files":{}}', '{"version":1,"files":{"../x.jpg":{"sha256":"a","size":1}}}']) {
      writeFileSync(join(w.a, '.coffer', 'media-state.json'), bad);
      writeFileSync(join(w.a, '.coffer', 'media-cache.json'), bad);
      assert.equal((await media(w.a, ['pull'])).code, 0);
    }
    const cache = await HashCache.load(w.a);
    assert.ok(cache instanceof HashCache);
    assert.deepEqual(leftovers(w.a), []);
  } finally {
    cleanup(w.root);
  }
});

test('lock refuses originals it cannot record, and writes nothing', async () => {
  const w = workspace();
  try {
    put(w.a, PHOTO_1, 'photo one');
    put(w.a, 'content/journal/trip/NUL.jpg', 'a device name on Windows');
    const result = await media(w.a, ['lock']);
    // On Windows the file cannot even be created; elsewhere the lock must refuse it.
    if (readdirSync(join(w.a, 'content', 'journal', 'trip')).includes('NUL.jpg')) {
      assert.equal(result.code, 1);
      assert.match(result.err, /NUL\.jpg: the path has the name "NUL\.jpg", which Windows reserves/);
      assert.equal(existsSync(join(w.a, 'media.lock.json')), false);
    }
  } finally {
    cleanup(w.root);
  }
});

test('lock refuses two originals that differ only by case', async (t) => {
  const w = workspace();
  try {
    put(w.a, 'content/journal/trip/Photo.jpg', 'one');
    put(w.a, 'content/journal/trip/photo.jpg', 'two');
    if (readdirSync(join(w.a, 'content', 'journal', 'trip')).length < 2) {
      t.skip('this file system is case-insensitive');
      return;
    }
    const result = await media(w.a, ['lock']);
    assert.equal(result.code, 1);
    assert.match(result.err, /the same file as .* on a case-insensitive file system/);
    assert.equal(existsSync(join(w.a, 'media.lock.json')), false);
  } finally {
    cleanup(w.root);
  }
});

test('status tells new, changed, deleted and missing originals apart', async () => {
  const w = workspace();
  try {
    put(w.a, PHOTO_1, 'one');
    put(w.a, PHOTO_2, 'two');
    put(w.a, VIDEO, 'three');
    assert.equal((await media(w.a, ['lock'])).code, 0);
    assert.equal((await media(w.a, ['push'])).code, 0);
    let status = await media(w.a, ['status']);
    assert.equal(status.code, 0);
    assert.match(status.out, /3 original\(s\), all in step with the lock/);

    put(w.a, PHOTO_1, 'one, replaced');
    rmSync(join(w.a, ...PHOTO_2.split('/')));
    put(w.a, 'content/journal/trip/new.png', 'new');
    status = await media(w.a, ['status']);
    assert.match(status.out, /new \(1\)[^\n]*\n {2}content\/journal\/trip\/new\.png/);
    assert.match(status.out, /changed \(1\)[^\n]*\n {2}content\/journal\/trip\/IMG_0001\.JPG/);
    assert.match(status.out, /deleted \(1\)[^\n]*\n {2}content\/journal\/trip\/IMG_0002\.heic/);
    assert.ok(!/missing/.test(status.out));

    // The second copy has nothing yet: everything is missing.
    sendLock(w.a, w.b);
    status = await media(w.b, ['status']);
    assert.match(status.out, /missing \(3\)/);

    // With --remote the store is asked, too: the new content is not there yet.
    assert.equal((await media(w.a, ['lock'])).code, 0);
    status = await media(w.a, ['status', '--remote']);
    assert.match(status.out, /not in the store \(2\)/);
  } finally {
    cleanup(w.root);
  }
});

test('add, replace and delete a photo on one copy and pull on the other: the same files', async () => {
  const w = workspace();
  try {
    // --- add
    put(w.a, PHOTO_1, Buffer.alloc(300_000, 1));
    put(w.a, PHOTO_2, 'second photo');
    put(w.a, VIDEO, Buffer.alloc(2_500_000, 7));
    put(w.a, 'content/journal/trip/index.md', 'text is in git, not here');
    assert.equal((await media(w.a, ['lock'])).code, 0);
    const pushed = await media(w.a, ['push']);
    assert.equal(pushed.code, 0, pushed.err);
    assert.match(pushed.out, /3 object\(s\) uploaded, 0 already in the store/);

    sendLock(w.a, w.b);
    const pulled = await media(w.b, ['pull']);
    assert.equal(pulled.code, 0, pulled.err);
    assert.match(pulled.out, /3 downloaded, 0 replaced, 0 deleted/);
    const originalsOf = (/** @type {string} */ dir) => Object.fromEntries(Object.entries(snapshot(dir)).filter(([path]) => !path.endsWith('.md')));
    assert.deepEqual(originalsOf(w.b), originalsOf(w.a));
    assert.deepEqual(leftovers(w.b), []);

    // pulling again changes nothing
    const again = await media(w.b, ['pull']);
    assert.equal(again.code, 0);
    assert.match(again.out, /0 downloaded, 0 replaced, 0 deleted, 3 already in step/);

    // --- replace
    put(w.a, PHOTO_1, Buffer.alloc(310_000, 2));
    assert.equal((await media(w.a, ['lock'])).code, 0);
    assert.equal((await media(w.a, ['push'])).code, 0);
    sendLock(w.a, w.b);
    const replaced = await media(w.b, ['pull']);
    assert.equal(replaced.code, 0, replaced.err);
    assert.match(replaced.out, /replaced content\/journal\/trip\/IMG_0001\.JPG/);
    assert.deepEqual(originalsOf(w.b), originalsOf(w.a));

    // --- delete
    rmSync(join(w.a, ...PHOTO_2.split('/')));
    assert.equal((await media(w.a, ['lock'])).code, 0);
    assert.equal((await media(w.a, ['push'])).code, 0);
    sendLock(w.a, w.b);
    const deleted = await media(w.b, ['pull']);
    assert.equal(deleted.code, 0, deleted.err);
    assert.match(deleted.out, /deleted content\/journal\/trip\/IMG_0002\.heic/);
    assert.equal(existsSync(join(w.b, ...PHOTO_2.split('/'))), false);
    assert.deepEqual(originalsOf(w.b), originalsOf(w.a));
    assert.deepEqual(Object.keys(originalsOf(w.b)).sort(), [PHOTO_1.slice('content/'.length), VIDEO.slice('content/'.length)].sort());
    assert.ok(existsSync(join(w.b, 'content', 'journal', 'trip', 'index.md')) === false, 'text files are not touched or created');
    assert.deepEqual(leftovers(w.b), []);
  } finally {
    cleanup(w.root);
  }
});

test('a file that was never synced is never deleted', async () => {
  const w = workspace();
  try {
    put(w.a, PHOTO_1, 'shared');
    assert.equal((await media(w.a, ['lock'])).code, 0);
    assert.equal((await media(w.a, ['push'])).code, 0);
    sendLock(w.a, w.b);
    assert.equal((await media(w.b, ['pull'])).code, 0);

    // The second copy has photos of its own: one locked but never pushed, one not locked at all.
    put(w.b, PHOTO_2, 'mine, locked but not pushed');
    put(w.b, VIDEO, 'mine, not even locked');
    assert.equal((await media(w.b, ['lock'])).code, 0);
    put(w.b, 'content/journal/trip/later.png', 'not in the lock');
    // Someone else's lock does not list them: they stay.
    sendLock(w.a, w.b);
    const result = await media(w.b, ['pull']);
    assert.equal(result.code, 0, result.err);
    assert.equal(readFileSync(join(w.b, ...PHOTO_2.split('/')), 'utf8'), 'mine, locked but not pushed');
    assert.equal(readFileSync(join(w.b, ...VIDEO.split('/')), 'utf8'), 'mine, not even locked');
    assert.equal(readFileSync(join(w.b, 'content', 'journal', 'trip', 'later.png'), 'utf8'), 'not in the lock');
    assert.match(result.out, /0 deleted/);

    // Without any state at all (a fresh clone with the files already in place), nothing is deleted either.
    rmSync(join(w.b, '.coffer'), { recursive: true, force: true });
    writeFileSync(join(w.b, 'media.lock.json'), renderLock([]));
    const empty = await media(w.b, ['pull']);
    assert.equal(empty.code, 0);
    assert.equal(readdirSync(join(w.b, 'content', 'journal', 'trip')).length, 4);
  } finally {
    cleanup(w.root);
  }
});

test('a synced file that was changed here is kept when the lock drops it', async () => {
  const w = workspace();
  try {
    put(w.a, PHOTO_1, 'original');
    put(w.a, PHOTO_2, 'other');
    assert.equal((await media(w.a, ['lock'])).code, 0);
    assert.equal((await media(w.a, ['push'])).code, 0);
    sendLock(w.a, w.b);
    assert.equal((await media(w.b, ['pull'])).code, 0);

    rmSync(join(w.a, ...PHOTO_1.split('/')));
    assert.equal((await media(w.a, ['lock'])).code, 0);
    sendLock(w.a, w.b);
    put(w.b, PHOTO_1, 'edited here after the sync');
    const result = await media(w.b, ['pull']);
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /kept content\/journal\/trip\/IMG_0001\.JPG \(changed since it was synced\)/);
    assert.equal(readFileSync(join(w.b, ...PHOTO_1.split('/')), 'utf8'), 'edited here after the sync');
    // It is unsynced now: dropping it again later still does not delete it.
    const again = await media(w.b, ['pull']);
    assert.equal(again.code, 0);
    assert.equal(existsSync(join(w.b, ...PHOTO_1.split('/'))), true);
  } finally {
    cleanup(w.root);
  }
});

test('a local file that differs from the lock is a conflict, never overwritten without --force', async () => {
  const w = workspace();
  try {
    put(w.a, PHOTO_1, 'from the first copy');
    assert.equal((await media(w.a, ['lock'])).code, 0);
    assert.equal((await media(w.a, ['push'])).code, 0);
    sendLock(w.a, w.b);
    put(w.b, PHOTO_1, 'a different photo with the same name');

    const result = await media(w.b, ['pull']);
    assert.equal(result.code, 1);
    assert.match(result.err, /conflict content\/journal\/trip\/IMG_0001\.JPG/);
    assert.match(result.err, /--force/);
    assert.equal(readFileSync(join(w.b, ...PHOTO_1.split('/')), 'utf8'), 'a different photo with the same name');
    assert.deepEqual(leftovers(w.b), []);

    const dry = await media(w.b, ['pull', '--dry-run']);
    assert.equal(dry.code, 1);
    assert.equal(readFileSync(join(w.b, ...PHOTO_1.split('/')), 'utf8'), 'a different photo with the same name');

    const forced = await media(w.b, ['pull', '--force']);
    assert.equal(forced.code, 0, forced.err);
    assert.equal(readFileSync(join(w.b, ...PHOTO_1.split('/')), 'utf8'), 'from the first copy');
  } finally {
    cleanup(w.root);
  }
});

test('a file edited here after a sync is a conflict when the lock also moved on', async () => {
  const w = workspace();
  try {
    put(w.a, PHOTO_1, 'v1');
    assert.equal((await media(w.a, ['lock'])).code, 0);
    assert.equal((await media(w.a, ['push'])).code, 0);
    sendLock(w.a, w.b);
    assert.equal((await media(w.b, ['pull'])).code, 0);

    put(w.a, PHOTO_1, 'v2 from the first copy');
    assert.equal((await media(w.a, ['lock'])).code, 0);
    assert.equal((await media(w.a, ['push'])).code, 0);
    sendLock(w.a, w.b);
    put(w.b, PHOTO_1, 'v1 edited on the second copy');
    const result = await media(w.b, ['pull']);
    assert.equal(result.code, 1);
    assert.equal(readFileSync(join(w.b, ...PHOTO_1.split('/')), 'utf8'), 'v1 edited on the second copy');
  } finally {
    cleanup(w.root);
  }
});

test('a file deleted here after a sync stays deleted until --restore', async () => {
  const w = workspace();
  try {
    put(w.a, PHOTO_1, 'keep me');
    assert.equal((await media(w.a, ['lock'])).code, 0);
    assert.equal((await media(w.a, ['push'])).code, 0);
    sendLock(w.a, w.b);
    assert.equal((await media(w.b, ['pull'])).code, 0);
    rmSync(join(w.b, ...PHOTO_1.split('/')));
    const left = await media(w.b, ['pull']);
    assert.equal(left.code, 0);
    assert.match(left.out, /left deleted content\/journal\/trip\/IMG_0001\.JPG/);
    assert.equal(existsSync(join(w.b, ...PHOTO_1.split('/'))), false);
    const restored = await media(w.b, ['pull', '--restore']);
    assert.equal(restored.code, 0);
    assert.equal(readFileSync(join(w.b, ...PHOTO_1.split('/')), 'utf8'), 'keep me');
  } finally {
    cleanup(w.root);
  }
});

test('pull --dry-run reports and changes nothing', async () => {
  const w = workspace();
  try {
    put(w.a, PHOTO_1, 'one');
    assert.equal((await media(w.a, ['lock'])).code, 0);
    assert.equal((await media(w.a, ['push'])).code, 0);
    sendLock(w.a, w.b);
    const result = await media(w.b, ['pull', '--dry-run']);
    assert.equal(result.code, 0);
    assert.match(result.out, /would be downloaded content\/journal\/trip\/IMG_0001\.JPG/);
    assert.equal(existsSync(join(w.b, ...PHOTO_1.split('/'))), false);
    assert.equal(existsSync(join(w.b, '.coffer', 'media-state.json')), false);
  } finally {
    cleanup(w.root);
  }
});

test('pull does nothing when there is no lock file, even for files it synced before', async () => {
  const w = workspace();
  try {
    put(w.a, PHOTO_1, 'one');
    assert.equal((await media(w.a, ['lock'])).code, 0);
    assert.equal((await media(w.a, ['push'])).code, 0);
    rmSync(join(w.a, 'media.lock.json'));
    const result = await media(w.a, ['pull']);
    assert.equal(result.code, 0);
    assert.match(result.out, /no lock file/);
    assert.equal(existsSync(join(w.a, ...PHOTO_1.split('/'))), true);
  } finally {
    cleanup(w.root);
  }
});

test('push says what it cannot upload and exits non-zero', async () => {
  const w = workspace();
  try {
    put(w.a, PHOTO_1, 'one');
    assert.equal((await media(w.a, ['lock'])).code, 0);
    put(w.a, PHOTO_1, 'changed after locking');
    const result = await media(w.a, ['push']);
    assert.equal(result.code, 1);
    assert.match(result.err, /IMG_0001\.JPG: the store lacks its content and the file here is different from the lock/);
    assert.equal(existsSync(join(w.store, 'originals', sha('changed after locking'))), false);
    assert.equal(existsSync(join(w.store, 'originals', sha('one'))), false);

    const none = await media(w.b, ['push']);
    assert.equal(none.code, 0);
    assert.match(none.out, /no lock file/);
  } finally {
    cleanup(w.root);
  }
});

test('pull reports an object the store lacks, and one that is damaged, without leaving partial files', async () => {
  const w = workspace();
  try {
    put(w.a, PHOTO_1, 'one');
    put(w.a, PHOTO_2, 'two');
    assert.equal((await media(w.a, ['lock'])).code, 0);
    assert.equal((await media(w.a, ['push'])).code, 0);
    sendLock(w.a, w.b);
    rmSync(join(w.store, 'originals', sha('one')));
    writeFileSync(join(w.store, 'originals', sha('two')), 'damaged');
    const result = await media(w.b, ['pull']);
    assert.equal(result.code, 1);
    assert.match(result.err, /IMG_0001\.JPG: the store has no object for it/);
    assert.match(result.err, /IMG_0002\.heic: the stored object .* is corrupt/);
    assert.equal(existsSync(join(w.b, ...PHOTO_1.split('/'))), false);
    assert.equal(existsSync(join(w.b, ...PHOTO_2.split('/'))), false);
    assert.deepEqual(leftovers(w.b), []);
  } finally {
    cleanup(w.root);
  }
});

test('pull checks the downloaded content against the lock even when the store does not', async () => {
  const w = workspace();
  try {
    put(w.a, PHOTO_1, 'one');
    assert.equal((await media(w.a, ['lock'])).code, 0);
    assert.equal((await media(w.a, ['push'])).code, 0);
    sendLock(w.a, w.b);
    // A store that hands out the wrong bytes without noticing.
    const wrong = {
      description: 'a careless store',
      has: async () => true,
      put: async () => {},
      get: async (/** @type {string} */ _key, /** @type {string} */ file) => writeFileSync(file, 'wrong bytes'),
    };
    const { pullMedia } = await import('../src/media/sync.js');
    const context = mediaContext(/** @type {never} */ ({
      file: join(w.b, 'coffer.yaml'),
      dir: w.b,
      media: normalizeConfig({ sites: configWith(undefined).sites, media: { store: { type: 'fs', dir: '../store' } } }, { file: join(w.b, 'coffer.yaml') }).media,
    }));
    const result = await pullMedia(context, wrong);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /does not match the lock/);
    assert.equal(existsSync(join(w.b, ...PHOTO_1.split('/'))), false);
    assert.deepEqual(leftovers(w.b), []);
  } finally {
    cleanup(w.root);
  }
});

// ---------------------------------------------------------------------------
// A lock file that comes from somewhere else

/**
 * @param {string} dir
 * @param {{ path: string, sha256?: string, size?: number }[]} entries Written as given, in the order given.
 */
function hostileLock(dir, entries) {
  const lines = entries.map((entry, index) => `${JSON.stringify({ path: entry.path, sha256: entry.sha256 ?? sha('x'), size: entry.size ?? 1 })}${index < entries.length - 1 ? ',' : ''}`);
  writeFileSync(join(dir, 'media.lock.json'), `{"version":1,"files":[\n${lines.join('\n')}\n]}\n`);
}

test('a hostile lock file cannot make pull write or delete outside the working copy', async () => {
  const w = workspace();
  try {
    put(w.a, PHOTO_1, 'x');
    assert.equal((await media(w.a, ['lock'])).code, 0);
    assert.equal((await media(w.a, ['push'])).code, 0);
    // Make the store hold an object for the key the lock names, so only the path stands in the way.
    const key = sha('x');
    const victims = [
      '../outside.jpg',
      'content/../../outside.jpg',
      '/etc/passwd.jpg',
      'C:/Windows/outside.jpg',
      'C:outside.jpg',
      'content\\..\\outside.jpg',
      '.git/hooks/post-checkout',
      'content/.git/config.jpg',
      '.coffer/media-state.json',
      'coffer.yaml',
      'package.json',
      'content/NUL.jpg',
      'content/x.jpg:stream',
      'content//x.jpg',
      'content/x.jpg/',
    ];
    for (const path of victims) {
      hostileLock(w.b, [{ path, sha256: key, size: 1 }]);
      const result = await media(w.b, ['pull']);
      assert.equal(result.code, 1, `should refuse ${path}`);
      assert.deepEqual(readdirSync(w.b).sort(), ['.coffer', 'content', 'coffer.yaml', 'media.lock.json'].filter((name) => existsSync(join(w.b, name))).sort(), `nothing new next to the working copy for ${path}`);
    }
    assert.equal(existsSync(join(w.root, 'outside.jpg')), false);
    assert.equal(existsSync(join(w.b, 'package.json')), false);
    assert.equal(readFileSync(join(w.b, 'coffer.yaml'), 'utf8'), CONFIG);
    assert.deepEqual(readdirSync(join(w.b, 'content', 'journal', 'trip')), []);
  } finally {
    cleanup(w.root);
  }
});

test('an entry that does not match media.include is refused before anything is written', async () => {
  const w = workspace();
  try {
    put(w.a, PHOTO_1, 'x');
    assert.equal((await media(w.a, ['lock'])).code, 0);
    assert.equal((await media(w.a, ['push'])).code, 0);
    hostileLock(w.b, [
      { path: PHOTO_1, sha256: sha('x'), size: 1 },
      { path: 'tools/run.jpg', sha256: sha('x'), size: 1 },
    ]);
    const result = await media(w.b, ['pull']);
    assert.equal(result.code, 1);
    assert.match(result.err, /"tools\/run\.jpg" does not match any pattern of media\.include/);
    assert.equal(existsSync(join(w.b, ...PHOTO_1.split('/'))), false, 'nothing is pulled at all');
    const status = await media(w.b, ['status']);
    assert.equal(status.code, 1);
  } finally {
    cleanup(w.root);
  }
});

test('pull does not go through a link, not even one that points inside', async (t) => {
  const w = workspace();
  try {
    put(w.a, PHOTO_1, 'x');
    assert.equal((await media(w.a, ['lock'])).code, 0);
    assert.equal((await media(w.a, ['push'])).code, 0);
    const outside = join(w.root, 'outside');
    mkdirSync(outside);
    const linked = join(w.b, 'content', 'journal', 'trip');
    rmSync(linked, { recursive: true, force: true });
    try {
      symlinkSync(outside, linked, 'junction');
    } catch {
      t.skip('this system does not allow creating links');
      return;
    }
    sendLock(w.a, w.b);
    const result = await media(w.b, ['pull']);
    assert.equal(result.code, 1);
    assert.match(result.err, /symbolic link or junction/);
    assert.deepEqual(readdirSync(outside), []);

    // A link to a single file is not an original either.
    rmSync(linked, { recursive: false, force: true });
    mkdirSync(linked, { recursive: true });
    const target = join(w.root, 'secret.jpg');
    writeFileSync(target, 'secret');
    try {
      symlinkSync(target, join(linked, 'IMG_0001.JPG'), 'file');
    } catch {
      return;
    }
    const second = await media(w.b, ['pull']);
    assert.equal(second.code, 1);
    assert.equal(readFileSync(target, 'utf8'), 'secret');
    const lock = await media(w.b, ['lock']);
    assert.equal(lock.code, 0);
    assert.match(lock.out, /symbolic link or junction and is left out/);
  } finally {
    cleanup(w.root);
  }
});

// ---------------------------------------------------------------------------
// Other commands and the store type

test('gitignore prints the patterns of the originals and the working folder', async () => {
  const w = workspace();
  try {
    const result = await media(w.a, ['gitignore']);
    assert.equal(result.code, 0);
    const lines = result.out.split('\n').filter((line) => line !== '' && !line.startsWith('#'));
    assert.ok(lines.includes('content/**/*.[jJ][pP][eE][gG]'));
    assert.ok(lines.includes('content/**/*.[mM][oO][vV]'));
    assert.equal(lines.at(-1), '.coffer/');
    assert.ok(!lines.includes('media.lock.json'));
    assert.equal(existsSync(join(w.a, '.coffer')), false);
  } finally {
    cleanup(w.root);
  }
});

test('push, pull and status --remote fail clearly with an s3 store, and lock still works', async () => {
  const w = workspace(`sites:
  - { id: s, baseUrl: "https://example.org", title: T, contentDir: content }
media:
  store: { type: s3, endpoint: "https://abc.example.com", bucket: my-media }
`);
  try {
    put(w.a, PHOTO_1, 'one');
    assert.equal((await media(w.a, ['lock'])).code, 0);
    assert.equal((await media(w.a, ['status'])).code, 0);
    assert.equal((await media(w.a, ['gitignore'])).code, 0);
    for (const args of [['push'], ['pull'], ['status', '--remote']]) {
      const result = await media(w.a, args, { COFFER_MEDIA_ACCESS_KEY_ID: 'x', COFFER_MEDIA_SECRET_ACCESS_KEY: 'y' });
      assert.equal(result.code, 1, args.join(' '));
      assert.match(result.err, /"s3" media store is not implemented in this build/);
    }
  } finally {
    cleanup(w.root);
  }
});

test('the lock, state and cache files are written without leaving temporary files', async () => {
  const w = workspace();
  try {
    put(w.a, PHOTO_1, 'one');
    assert.equal((await media(w.a, ['lock'])).code, 0);
    assert.equal((await media(w.a, ['push'])).code, 0);
    assert.deepEqual(readdirSync(w.a).sort(), ['.coffer', 'coffer.yaml', 'content', 'media.lock.json']);
    assert.deepEqual(readdirSync(join(w.a, '.coffer')).sort(), ['media-cache.json', 'media-state.json']);
    assert.deepEqual(readdirSync(join(w.store, 'originals')), [sha('one')]);
    const state = JSON.parse(readFileSync(join(w.a, '.coffer', 'media-state.json'), 'utf8'));
    assert.deepEqual(state, { version: 1, files: { [PHOTO_1]: { sha256: sha('one'), size: 3 } } });
  } finally {
    cleanup(w.root);
  }
});

test('locking alone does not make a file deletable: only a push or a pull does', async () => {
  const w = workspace();
  try {
    put(w.a, PHOTO_1, 'locked but never uploaded');
    assert.equal((await media(w.a, ['lock'])).code, 0);
    // A checkout of another branch brings a lock without it.
    const withIt = readFileSync(join(w.a, 'media.lock.json'), 'utf8');
    writeFileSync(join(w.a, 'media.lock.json'), renderLock([]));
    const result = await media(w.a, ['pull']);
    assert.equal(result.code, 0, result.err);
    assert.equal(existsSync(join(w.a, ...PHOTO_1.split('/'))), true);
    writeFileSync(join(w.a, 'media.lock.json'), withIt);
  } finally {
    cleanup(w.root);
  }
});

// ---------------------------------------------------------------------------
// Losing nothing: lock keeps what was never fetched here

/**
 * Like `put`, with a given modification time (so that two writes can look alike to the hash cache).
 *
 * @param {string} dir
 * @param {string} rel
 * @param {string | Buffer} content
 * @param {Date} when
 */
function putAt(dir, rel, content, when) {
  const file = join(dir, ...rel.split('/'));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  utimesSync(file, when, when);
}

/**
 * A working copy `c`, next to `a` and `b`, as a fresh clone has it: the configuration, no originals.
 *
 * @param {{ root: string }} w
 * @param {string} [config]
 */
function freshClone(w, config = CONFIG) {
  const c = join(w.root, 'c');
  mkdirSync(join(c, 'content', 'journal', 'trip'), { recursive: true });
  writeFileSync(join(c, 'coffer.yaml'), config);
  return c;
}

test('lock on a copy that has not pulled yet keeps every entry of the lock', async () => {
  const w = workspace();
  try {
    put(w.a, PHOTO_1, 'one');
    put(w.a, PHOTO_2, 'two');
    assert.equal((await media(w.a, ['lock'])).code, 0);
    assert.equal((await media(w.a, ['push'])).code, 0);
    const before = readFileSync(join(w.a, 'media.lock.json'), 'utf8');

    const c = freshClone(w);
    sendLock(w.a, c);
    const result = await media(c, ['lock']);
    assert.equal(result.code, 0, result.err);
    assert.equal(readFileSync(join(c, 'media.lock.json'), 'utf8'), before);
    assert.match(result.out, /kept content\/journal\/trip\/IMG_0001\.JPG/);
    assert.match(result.out, /2 original\(s\), unchanged/);
    assert.match(result.out, /2 kept: not fetched on this working copy yet; run "coffer media pull"/);
    assert.ok(!/removed/.test(result.out));

    // ... and after the pull the copy is complete.
    assert.equal((await media(c, ['pull'])).code, 0);
    assert.deepEqual(snapshot(c), snapshot(w.a));
  } finally {
    cleanup(w.root);
  }
});

test('a lock written by a copy that had not pulled yet does not make the other copies delete their photos', async () => {
  const w = workspace();
  try {
    put(w.a, PHOTO_1, 'one');
    put(w.a, PHOTO_2, 'two');
    assert.equal((await media(w.a, ['lock'])).code, 0);
    assert.equal((await media(w.a, ['push'])).code, 0);
    sendLock(w.a, w.b);
    assert.equal((await media(w.b, ['pull'])).code, 0);

    // A fresh clone runs "lock" before "pull", and its lock reaches the synced copy.
    const c = freshClone(w);
    sendLock(w.a, c);
    assert.equal((await media(c, ['lock'])).code, 0);
    sendLock(c, w.b);
    const result = await media(w.b, ['pull']);
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /0 deleted/);
    assert.deepEqual(snapshot(w.b), snapshot(w.a));
    assert.equal(readFileSync(join(w.b, ...PHOTO_1.split('/')), 'utf8'), 'one');
  } finally {
    cleanup(w.root);
  }
});

test('lock adds a photo of its own and keeps the ones it has not fetched', async () => {
  const w = workspace();
  try {
    put(w.a, PHOTO_1, 'one');
    put(w.a, PHOTO_2, 'two');
    assert.equal((await media(w.a, ['lock'])).code, 0);
    assert.equal((await media(w.a, ['push'])).code, 0);

    const c = freshClone(w);
    sendLock(w.a, c);
    put(c, VIDEO, 'my own clip');
    const result = await media(c, ['lock']);
    assert.equal(result.code, 0, result.err);
    const entries = parseLock(readFileSync(join(c, 'media.lock.json'), 'utf8'));
    assert.deepEqual(entries.map((entry) => entry.path), [PHOTO_1, PHOTO_2, VIDEO].sort(compareBytes));
    assert.match(result.out, /added content\/journal\/trip\/clip\.mp4/);
    assert.match(result.out, /3 original\(s\), 1 added, 0 changed, 0 removed/);
    // A photo it has locally wins over the entry of the lock: the new content is recorded.
    put(c, PHOTO_1, 'one, edited');
    await media(c, ['lock']);
    const edited = parseLock(readFileSync(join(c, 'media.lock.json'), 'utf8')).find((entry) => entry.path === PHOTO_1);
    assert.equal(edited?.sha256, sha('one, edited'));
  } finally {
    cleanup(w.root);
  }
});

test('lock drops the entry of a file that was synced here and then deleted here', async () => {
  const w = workspace();
  try {
    put(w.a, PHOTO_1, 'one');
    put(w.a, PHOTO_2, 'two');
    assert.equal((await media(w.a, ['lock'])).code, 0);
    assert.equal((await media(w.a, ['push'])).code, 0);
    sendLock(w.a, w.b);
    assert.equal((await media(w.b, ['pull'])).code, 0);

    // On the second copy a deliberate delete (it was pulled, so it is known to be synced).
    rmSync(join(w.b, ...PHOTO_2.split('/')));
    const result = await media(w.b, ['lock']);
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /removed content\/journal\/trip\/IMG_0002\.heic/);
    assert.deepEqual(parseLock(readFileSync(join(w.b, 'media.lock.json'), 'utf8')).map((entry) => entry.path), [PHOTO_1]);
  } finally {
    cleanup(w.root);
  }
});

test('lock lets go of a kept entry that media.include no longer covers, and says so', async () => {
  const w = workspace();
  try {
    put(w.a, PHOTO_1, 'one');
    put(w.a, PHOTO_2, 'two');
    assert.equal((await media(w.a, ['lock'])).code, 0);
    const c = freshClone(w, `${CONFIG}  include: ["content/**/*.[jJ][pP][gG]"]\n`);
    sendLock(w.a, c);
    const result = await media(c, ['lock']);
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /warning: [^\n]*IMG_0002\.heic[^\n]*media\.include/);
    assert.deepEqual(parseLock(readFileSync(join(c, 'media.lock.json'), 'utf8')).map((entry) => entry.path), [PHOTO_1]);
  } finally {
    cleanup(w.root);
  }
});

test('lock refuses a new file that differs from an entry it keeps only by case', async () => {
  const w = workspace();
  try {
    put(w.a, PHOTO_1, 'one');
    assert.equal((await media(w.a, ['lock'])).code, 0);
    const c = freshClone(w);
    sendLock(w.a, c);
    put(c, 'content/journal/trip/img_0001.jpg', 'other');
    const before = readFileSync(join(c, 'media.lock.json'), 'utf8');
    const result = await media(c, ['lock']);
    assert.equal(result.code, 1);
    assert.match(result.err, /IMG_0001\.JPG/);
    assert.equal(readFileSync(join(c, 'media.lock.json'), 'utf8'), before);
  } finally {
    cleanup(w.root);
  }
});

// ---------------------------------------------------------------------------
// Losing nothing: pull does not trust the hash cache before it deletes or replaces

test('pull does not delete a synced file that was edited in place with the same size and time', async () => {
  const w = workspace();
  try {
    const past = new Date(Date.now() - 120_000);
    put(w.a, PHOTO_1, 'aaaa');
    put(w.a, PHOTO_2, 'other');
    assert.equal((await media(w.a, ['lock'])).code, 0);
    assert.equal((await media(w.a, ['push'])).code, 0);
    sendLock(w.a, w.b);
    assert.equal((await media(w.b, ['pull'])).code, 0);
    // Let the cache of the second copy know the file with an old time, so that it trusts the entry.
    utimesSync(join(w.b, ...PHOTO_1.split('/')), past, past);
    assert.equal((await media(w.b, ['status'])).code, 0);
    const cached = JSON.parse(readFileSync(join(w.b, '.coffer', 'media-cache.json'), 'utf8')).files[PHOTO_1];
    assert.equal(cached.sha256, sha('aaaa'));

    // An edit that keeps the size and the time (exiftool -P, rsync -t, cp -p ...).
    putAt(w.b, PHOTO_1, 'bbbb', past);

    rmSync(join(w.a, ...PHOTO_1.split('/')));
    assert.equal((await media(w.a, ['lock'])).code, 0);
    sendLock(w.a, w.b);
    const result = await media(w.b, ['pull']);
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /kept content\/journal\/trip\/IMG_0001\.JPG \(changed since it was synced\)/);
    assert.match(result.out, /0 deleted/);
    assert.equal(readFileSync(join(w.b, ...PHOTO_1.split('/')), 'utf8'), 'bbbb');
  } finally {
    cleanup(w.root);
  }
});

test('pull does not replace a synced file that was edited in place with the same size and time', async () => {
  const w = workspace();
  try {
    const past = new Date(Date.now() - 120_000);
    put(w.a, PHOTO_1, 'aaaa');
    assert.equal((await media(w.a, ['lock'])).code, 0);
    assert.equal((await media(w.a, ['push'])).code, 0);
    sendLock(w.a, w.b);
    assert.equal((await media(w.b, ['pull'])).code, 0);
    utimesSync(join(w.b, ...PHOTO_1.split('/')), past, past);
    assert.equal((await media(w.b, ['status'])).code, 0);
    putAt(w.b, PHOTO_1, 'bbbb', past);

    put(w.a, PHOTO_1, 'cccc, replaced');
    assert.equal((await media(w.a, ['lock'])).code, 0);
    assert.equal((await media(w.a, ['push'])).code, 0);
    sendLock(w.a, w.b);
    const result = await media(w.b, ['pull']);
    assert.equal(result.code, 1);
    assert.match(result.out + result.err, /conflict content\/journal\/trip\/IMG_0001\.JPG/);
    assert.equal(readFileSync(join(w.b, ...PHOTO_1.split('/')), 'utf8'), 'bbbb');
    assert.deepEqual(leftovers(w.b), []);

    // With --force the edit is replaced on purpose.
    assert.equal((await media(w.b, ['pull', '--force'])).code, 0);
    assert.equal(readFileSync(join(w.b, ...PHOTO_1.split('/')), 'utf8'), 'cccc, replaced');
  } finally {
    cleanup(w.root);
  }
});

// ---------------------------------------------------------------------------
// Losing nothing: an empty lock does not delete everything by accident

test('an empty lock deletes synced files only with --force', async () => {
  const w = workspace();
  try {
    put(w.a, PHOTO_1, 'one');
    put(w.a, PHOTO_2, 'two');
    assert.equal((await media(w.a, ['lock'])).code, 0);
    assert.equal((await media(w.a, ['push'])).code, 0);
    sendLock(w.a, w.b);
    assert.equal((await media(w.b, ['pull'])).code, 0);

    writeFileSync(join(w.b, 'media.lock.json'), renderLock([]));
    const refused = await media(w.b, ['pull']);
    assert.equal(refused.code, 1);
    assert.match(refused.err, /lists no originals/);
    assert.match(refused.err, /2 synced file\(s\)/);
    assert.match(refused.err, /--force/);
    assert.equal(snapshot(w.b)['journal/trip/IMG_0001.JPG'], sha('one'));
    assert.equal(snapshot(w.b)['journal/trip/IMG_0002.heic'], sha('two'));

    // Still refused as a dry run, and nothing changes.
    const dry = await media(w.b, ['pull', '--dry-run']);
    assert.equal(dry.code, 1);
    assert.equal(Object.keys(snapshot(w.b)).length, 2);

    // Deliberately: --force.
    const forced = await media(w.b, ['pull', '--force']);
    assert.equal(forced.code, 0, forced.err);
    assert.match(forced.out, /2 deleted/);
    assert.deepEqual(snapshot(w.b), {});
  } finally {
    cleanup(w.root);
  }
});

test('an empty lock that leaves nothing to delete is no problem', async () => {
  const w = workspace();
  try {
    writeFileSync(join(w.a, 'media.lock.json'), renderLock([]));
    const result = await media(w.a, ['pull']);
    assert.equal(result.code, 0, result.err);
  } finally {
    cleanup(w.root);
  }
});

// ---------------------------------------------------------------------------
// Configuration: a store or a pattern that would collide with the working copy

test('an fs store must stay out of the content folders, the configuration folder and the lock', () => {
  const dirs = (/** @type {string} */ dir, /** @type {string} */ contentDir = 'content') => problemsOf(configWith({ store: { type: 'fs', dir } }, contentDir)).join('\n');
  assert.deepEqual(problemsOf(configWith({ store: { type: 'fs', dir: '../originals' } })), []);
  assert.deepEqual(problemsOf(configWith({ store: { type: 'fs', dir: 'originals' } })), []);
  assert.match(dirs('content'), /media\.store\.dir: .*content folder/);
  assert.match(dirs('content/originals'), /media\.store\.dir: .*content folder/);
  assert.match(dirs('.'), /media\.store\.dir: .*configuration/);
  assert.match(dirs('..'), /media\.store\.dir: .*configuration/);
  assert.match(dirs('/'), /media\.store\.dir: .*configuration/);
  assert.match(dirs('.coffer/store'), /media\.store\.dir: .*\.coffer/);
  // A content folder elsewhere, below the store.
  assert.match(dirs('../elsewhere', '../elsewhere/content'), /media\.store\.dir: .*content folder/);
});

test('include patterns must not match the lock file or the configuration file', () => {
  const store = { type: 'fs', dir: '../originals' };
  assert.match(problemsOf(configWith({ store, include: ['**/*.json'] })).join('\n'), /media\.include: "\*\*\/\*\.json" matches the lock file media\.lock\.json/);
  assert.match(problemsOf(configWith({ store, include: ['*.yaml'] })).join('\n'), /media\.include: "\*\.yaml" matches the configuration file coffer\.yaml/);
  assert.match(problemsOf(configWith({ store, include: ['**'] })).join('\n'), /media\.include: .*matches the lock file/);
  assert.match(problemsOf(configWith({ store, lock: 'content/albums.lock.json', include: ['content/**/*.json'] })).join('\n'), /matches the lock file content\/albums\.lock\.json/);
  assert.deepEqual(problemsOf(configWith({ store, include: ['content/**/*.jpg'] })), []);
});
