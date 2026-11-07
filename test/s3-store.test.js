import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { run } from '../src/cli.js';
import { MissingCredentialsError, parseEnvFile, readEnvLocal } from '../src/media/credentials.js';
import { createS3Store, parseRetryAfter, placeholdersOf, resolveEndpoint, scrub } from '../src/media/s3-store.js';
import { MediaStoreError } from '../src/media/store.js';
import { createStore } from '../src/media/stores.js';
import { startMockS3, TEST_ACCESS_KEY_ID, TEST_SECRET_ACCESS_KEY } from './helpers/mock-s3.js';

/** @param {string | Buffer} data */
const sha = (data) => createHash('sha256').update(data).digest('hex');

/** @param {string} dir */
function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

const ENV = Object.freeze({ COFFER_MEDIA_ACCESS_KEY_ID: TEST_ACCESS_KEY_ID, COFFER_MEDIA_SECRET_ACCESS_KEY: TEST_SECRET_ACCESS_KEY });

/**
 * @param {Awaited<ReturnType<typeof startMockS3>>} mock
 * @param {Partial<{ prefix: string, endpoint: string }>} [overrides]
 * @returns {Extract<import('../src/media/config.js').MediaStoreConfig, { type: 's3' }>}
 */
function configFor(mock, overrides = {}) {
  return {
    type: 's3',
    endpoint: overrides.endpoint ?? mock.url,
    bucket: mock.bucket,
    region: 'auto',
    prefix: overrides.prefix ?? '',
    accessKeyIdEnv: 'COFFER_MEDIA_ACCESS_KEY_ID',
    secretAccessKeyEnv: 'COFFER_MEDIA_SECRET_ACCESS_KEY',
  };
}

/**
 * A store against the mock whose waits are recorded, not slept, and whose clock
 * moves by exactly those waits.
 *
 * @param {Awaited<ReturnType<typeof startMockS3>>} mock
 * @param {Partial<import('../src/media/s3-store.js').S3StoreOptions> & { prefix?: string }} [options]
 */
async function storeFor(mock, options = {}) {
  /** @type {number[]} */
  const sleeps = [];
  let clock = 1_700_000_000_000;
  const store = await createS3Store(configFor(mock, { prefix: options.prefix }), {
    env: ENV,
    allowInsecureLoopback: true,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
    random: () => 1,
    limits: { baseDelayMs: 100, maxDelayMs: 10_000, idleTimeoutMs: 2000 },
    ...options,
  });
  return { store, sleeps };
}

/**
 * @template T
 * @param {(mock: Awaited<ReturnType<typeof startMockS3>>, dir: string) => Promise<T>} body
 * @returns {Promise<T>}
 */
async function withMock(body) {
  const mock = await startMockS3();
  const dir = mkdtempSync(join(tmpdir(), 'coffer-s3-'));
  try {
    return await body(mock, dir);
  } finally {
    await mock.close();
    cleanup(dir);
  }
}

/**
 * @param {string} dir
 * @param {string} name
 * @param {Buffer | string} content
 * @returns {string}
 */
function writeFile(dir, name, content) {
  const file = join(dir, name);
  writeFileSync(file, content);
  return file;
}

// ---------------------------------------------------------------------------
// The happy path

test('the s3 store uploads, checks and downloads an object, signing every request', async () => {
  await withMock(async (mock, dir) => {
    const { store } = await storeFor(mock);
    const content = randomBytes(2_500_000); // more than two read chunks
    const key = sha(content);
    const source = writeFile(dir, 'photo.jpg', content);

    assert.equal(await store.has(key), false);
    await store.put(key, source);
    assert.equal(await store.has(key), true);
    assert.deepEqual(mock.objects.get(mock.pathOf(key)), content);

    const target = join(dir, 'copy.jpg');
    await store.get(key, target);
    assert.equal(sha(readFileSync(target)), key);

    assert.deepEqual(mock.requests.map((request) => request.method), ['HEAD', 'PUT', 'HEAD', 'GET']);
    for (const request of mock.requests) {
      assert.equal(request.signatureValid, true, request.problem);
      assert.equal(request.auth?.accessKeyId, TEST_ACCESS_KEY_ID);
      assert.equal(request.auth?.region, 'auto');
      assert.match(String(request.headers['x-amz-date']), /^\d{8}T\d{6}Z$/);
      assert.match(String(request.headers.authorization), /^AWS4-HMAC-SHA256 Credential=[^,]+, SignedHeaders=[^,]+, Signature=[0-9a-f]{64}$/);
    }
    // The upload is signed with the hash of its content, which the server checked against the body, and is sent with its length.
    const upload = mock.requests[1];
    assert.equal(upload.headers['x-amz-content-sha256'], key);
    assert.equal(upload.headers['content-length'], String(content.length));
    assert.equal(upload.bodyLength, content.length);
    assert.equal(mock.requests[0].headers['x-amz-content-sha256'], sha(''));
  });
});

test('objects are addressed path-style below the prefix, and the description names no secret', async () => {
  await withMock(async (mock, dir) => {
    const { store } = await storeFor(mock, { prefix: '/site/one/' });
    const key = sha('x');
    await store.put(key, writeFile(dir, 'x.bin', 'x'));
    assert.deepEqual([...mock.objects.keys()], [mock.pathOf(key, 'site/one')]);
    assert.match(store.description, /^bucket my-media at http:\/\/127\.0\.0\.1:\d+ \(prefix site\/one\/\)$/);
    assert.ok(!store.description.includes(TEST_SECRET_ACCESS_KEY) && !store.description.includes(TEST_ACCESS_KEY_ID));
  });
});

test('putting an object the store already has is not an error', async () => {
  await withMock(async (mock, dir) => {
    const { store } = await storeFor(mock);
    const key = sha('same');
    const source = writeFile(dir, 'a.bin', 'same');
    await store.put(key, source);
    await store.put(key, source);
    assert.equal(mock.objects.size, 1);
  });
});

test('an upload that is not the content of its key fails and nothing is kept', async () => {
  await withMock(async (mock, dir) => {
    const { store } = await storeFor(mock);
    const source = writeFile(dir, 'a.bin', 'what is really in the file');
    await assert.rejects(store.put(sha('something else'), source), (error) => {
      assert.ok(error instanceof MediaStoreError);
      assert.equal(error.code, 'mismatch');
      assert.match(error.message, /changed after it was hashed/);
      return true;
    });
    assert.equal(mock.objects.size, 0);
  });
});

test('a key that is not a SHA-256 is refused before anything is sent', async () => {
  await withMock(async (mock, dir) => {
    const { store } = await storeFor(mock);
    for (const key of ['../x', 'ABC', sha('x').toUpperCase(), '']) {
      await assert.rejects(store.has(key), (error) => error instanceof MediaStoreError && error.code === 'invalid-key');
      await assert.rejects(store.get(key, join(dir, 'never')), (error) => error instanceof MediaStoreError && error.code === 'invalid-key');
    }
    assert.equal(mock.requests.length, 0);
  });
});

test('a missing object is reported as missing and leaves no file', async () => {
  await withMock(async (mock, dir) => {
    const { store } = await storeFor(mock);
    const target = join(dir, 'out.bin');
    await assert.rejects(store.get(sha('nothing'), target), (error) => error instanceof MediaStoreError && error.code === 'missing');
    assert.equal(existsSync(target), false);
    assert.equal(mock.requests.length, 1);
  });
});

test('an object whose content is not its key is corrupt: removed, and not tried again', async () => {
  await withMock(async (mock, dir) => {
    const { store, sleeps } = await storeFor(mock);
    const key = sha('what it should be');
    mock.objects.set(mock.pathOf(key), Buffer.from('what it should be')); // same length ...
    mock.objects.set(mock.pathOf(key), Buffer.from('what it is instead!'));
    const target = join(dir, 'out.bin');
    await assert.rejects(store.get(key, target), (error) => {
      assert.ok(error instanceof MediaStoreError);
      assert.equal(error.code, 'corrupt');
      return true;
    });
    assert.equal(existsSync(target), false);
    assert.equal(mock.requests.length, 1);
    assert.deepEqual(sleeps, []);
  });
});

// ---------------------------------------------------------------------------
// Retries

test('a server error is retried with growing waits, and then the operation succeeds', async () => {
  await withMock(async (mock, dir) => {
    const { store, sleeps } = await storeFor(mock);
    const key = sha('abc');
    mock.fail('PUT', { status: 500 }, { status: 503 });
    await store.put(key, writeFile(dir, 'a.bin', 'abc'));
    assert.deepEqual(mock.requests.map((request) => request.method), ['PUT', 'PUT', 'PUT']);
    assert.deepEqual(sleeps, [100, 200]); // random() is 1: the whole of the backoff
    assert.deepEqual(mock.objects.get(mock.pathOf(key)), Buffer.from('abc'));
    // Every try is signed afresh.
    assert.ok(mock.requests.slice(0, 2).every((request) => request.auth !== null));
  });
});

test('a connection that is reset and an answer that never comes are retried', async () => {
  await withMock(async (mock) => {
    const { store, sleeps } = await storeFor(mock, { limits: { baseDelayMs: 10, idleTimeoutMs: 150 } });
    const key = sha('abc');
    mock.objects.set(mock.pathOf(key), Buffer.from('abc'));
    mock.fail('HEAD', { reset: true }, { hang: true });
    assert.equal(await store.has(key), true);
    assert.equal(mock.requests.length, 3);
    assert.equal(sleeps.length, 2);
  });
});

test('429 is retried after the time Retry-After names, up to a limit', async () => {
  await withMock(async (mock) => {
    const { store, sleeps } = await storeFor(mock, { limits: { baseDelayMs: 100, maxRetryAfterMs: 5000 } });
    mock.fail('HEAD', { status: 429, headers: { 'retry-after': '3' } }, { status: 429, headers: { 'retry-after': '3600' } }, { status: 408 });
    assert.equal(await store.has(sha('x')), false);
    assert.deepEqual(sleeps, [3000, 5000, 400]);
  });
});

test('a download that stops half way is tried again from the start and leaves no partial file', async () => {
  await withMock(async (mock, dir) => {
    const { store, sleeps } = await storeFor(mock);
    const content = randomBytes(300_000);
    const key = sha(content);
    mock.objects.set(mock.pathOf(key), content);
    mock.fail('GET', { truncate: true });
    const target = join(dir, 'out.bin');
    await store.get(key, target);
    assert.equal(sha(readFileSync(target)), key);
    assert.equal(sleeps.length, 1);

    // And when it never completes, it ends in an error and nothing is left.
    mock.fail('GET', { truncate: true }, { truncate: true }, { truncate: true }, { truncate: true }, { truncate: true });
    const other = join(dir, 'other.bin');
    await assert.rejects(store.get(key, other), (error) => {
      assert.ok(error instanceof MediaStoreError);
      assert.match(error.message, /gave up after 5 attempts/);
      return true;
    });
    assert.equal(existsSync(other), false);
    assert.deepEqual(readdirSync(dir).sort(), ['out.bin']);
  });
});

test('403, 400 and 404 are final: one request, and a message that says what to check', async () => {
  await withMock(async (mock, dir) => {
    const { store, sleeps } = await storeFor(mock);
    const key = sha('abc');
    const source = writeFile(dir, 'a.bin', 'abc');
    mock.fail('PUT', { status: 403, body: '<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>' });
    await assert.rejects(store.put(key, source), (error) => {
      assert.ok(error instanceof MediaStoreError);
      assert.match(error.message, /HTTP 403 \(AccessDenied: Access Denied\); access denied: check that the credentials are right/);
      return true;
    });
    mock.fail('PUT', { status: 400, body: '<Error><Code>InvalidArgument</Code><Message>bad</Message></Error>' });
    await assert.rejects(store.put(key, source), /HTTP 400 \(InvalidArgument: bad\); the request was refused/);
    mock.fail('HEAD', { status: 404 });
    assert.equal(await store.has(key), false);
    assert.equal(mock.requests.length, 3);
    assert.deepEqual(sleeps, []);
  });
});

test('the number of attempts and the total time are bounded', async () => {
  await withMock(async (mock) => {
    const { store, sleeps } = await storeFor(mock);
    mock.fail('HEAD', ...Array.from({ length: 10 }, () => ({ status: 500 })));
    await assert.rejects(store.has(sha('x')), /HTTP 500 \(gave up after 5 attempts\)/);
    assert.equal(mock.requests.length, 5);
    assert.deepEqual(sleeps, [100, 200, 400, 800]);
  });
  await withMock(async (mock) => {
    const { store, sleeps } = await storeFor(mock, { limits: { baseDelayMs: 100, totalTimeoutMs: 150 } });
    mock.fail('HEAD', ...Array.from({ length: 10 }, () => ({ status: 500 })));
    await assert.rejects(store.has(sha('x')), /gave up after 2 attempts/);
    assert.deepEqual(sleeps, [100]);
  });
});

test('a cancelled store stops waiting and sending', async () => {
  await withMock(async (mock) => {
    const controller = new AbortController();
    const { store } = await storeFor(mock, {
      signal: controller.signal,
      sleep: async () => {
        controller.abort();
        throw new MediaStoreError('failed', 'the operation was cancelled');
      },
    });
    mock.fail('HEAD', { status: 500 });
    await assert.rejects(store.has(sha('x')), /cancelled/);
    await assert.rejects(store.has(sha('y')), /cancelled/);
    assert.equal(mock.requests.length, 1);
  });
});

test('a redirect is an error: it is never followed and never retried', async () => {
  await withMock(async (mock) => {
    const { store, sleeps } = await storeFor(mock);
    mock.fail('HEAD', { status: 307, headers: { location: 'https://elsewhere.example/other?X-Amz-Signature=abcdef' } });
    await assert.rejects(store.has(sha('x')), (error) => {
      assert.ok(error instanceof MediaStoreError);
      assert.match(error.message, /HTTP 307, a redirect to elsewhere\.example; redirects are not followed/);
      assert.ok(!error.message.includes('abcdef'));
      return true;
    });
    assert.equal(mock.requests.length, 1);
    assert.deepEqual(sleeps, []);
  });
});

test('an error body is cut short and anything that looks like a credential is removed', async () => {
  await withMock(async (mock, dir) => {
    const { store } = await storeFor(mock);
    const target = join(dir, 'out.bin');
    const noisy = `<html>${TEST_SECRET_ACCESS_KEY} ${TEST_ACCESS_KEY_ID} AKIAABCDEFGHIJKLMNOP ${'long '.repeat(5000)}</html>`;
    mock.fail('GET', { status: 403, body: noisy });
    await assert.rejects(store.get(sha('x'), target), (error) => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes(TEST_SECRET_ACCESS_KEY), 'secret');
      assert.ok(!error.message.includes(TEST_ACCESS_KEY_ID), 'key id');
      assert.ok(!error.message.includes('AKIAABCDEFGHIJKLMNOP'));
      assert.ok(error.message.length < 800, `message of ${error.message.length} characters`);
      assert.match(error.message, /\[removed\]/);
      return true;
    });
  });
});

// ---------------------------------------------------------------------------
// Settings

test('scrub removes secrets, keys, long tokens and control characters, and cuts the text', () => {
  assert.equal(scrub('a\u0000b\nc', []), 'a b c');
  assert.equal(scrub('the secret hunter2hunter2 is here', ['hunter2hunter2']), 'the secret [removed] is here');
  assert.equal(scrub(`Authorization: AWS4-HMAC-SHA256 Credential=X/20260101/auto/s3/aws4_request`, []), 'Authorization: [removed]');
  assert.equal(scrub('token abcdefghijklmnopqrstuvwxyz0123456789ABCD end', []), 'token [removed] end');
  assert.equal(scrub('x'.repeat(10) + ' ' + 'y '.repeat(500), []).length, 303);
});

test('parseRetryAfter reads seconds and dates and caps the result', () => {
  assert.equal(parseRetryAfter('2', 0, 10_000), 2000);
  assert.equal(parseRetryAfter('999999', 0, 10_000), 10_000);
  assert.equal(parseRetryAfter(new Date(5000).toUTCString(), 1000, 10_000), 4000);
  assert.equal(parseRetryAfter(new Date(0).toUTCString(), 1000, 10_000), 0);
  assert.equal(parseRetryAfter('soon', 0, 10_000), undefined);
  assert.equal(parseRetryAfter(undefined, 0, 10_000), undefined);
});

test('the endpoint is resolved from placeholders and checked', () => {
  assert.deepEqual(placeholdersOf('https://${A}.x.com/${B}/${A}'), ['A', 'B']);
  const values = new Map([['ACCOUNT', 'abc123']]);
  assert.equal(resolveEndpoint('https://${ACCOUNT}.r2.cloudflarestorage.com/', values, false), 'https://abc123.r2.cloudflarestorage.com');
  assert.equal(resolveEndpoint('https://s3.example.com/base/', values, false), 'https://s3.example.com/base');
  // A value that would change the address is refused, without being shown.
  for (const bad of ['evil.com/x', 'a b', 'a@b', '']) {
    assert.throws(() => resolveEndpoint('https://${ACCOUNT}.example.com', new Map([['ACCOUNT', bad]]), false), (error) => {
      assert.ok(error instanceof MediaStoreError);
      assert.ok(!error.message.includes(bad) || bad === '');
      return true;
    });
  }
  // https only; http only for the loopback, and only when the caller of the API says so.
  assert.throws(() => resolveEndpoint('http://127.0.0.1:9000', values, false), /must be an https address/);
  assert.throws(() => resolveEndpoint('http://example.com', values, true), /must be an https address/);
  assert.throws(() => resolveEndpoint('http://127.0.0.1.example.com', values, true), /must be an https address/);
  assert.equal(resolveEndpoint('http://127.0.0.1:9000', values, true), 'http://127.0.0.1:9000');
  assert.equal(resolveEndpoint('http://localhost:9000/', values, true), 'http://localhost:9000');
  assert.throws(() => resolveEndpoint('https://user:pw@example.com', values, false), /credentials, a query or a fragment/);
  assert.throws(() => resolveEndpoint('https://example.com/?x=1', values, false), /credentials, a query or a fragment/);
});

test('a placeholder value made only of dots is refused, because it would remove or repeat a path segment', () => {
  for (const bad of ['.', '..', '...']) {
    assert.throws(
      () => resolveEndpoint('https://x.example.com/${B}/y', new Map([['B', bad]]), false),
      (error) => {
        assert.ok(error instanceof MediaStoreError);
        assert.match(error.message, /not only dots/);
        return true;
      },
      bad,
    );
  }
  assert.equal(resolveEndpoint('https://x.example.com/${B}/y', new Map([['B', 'a.b']]), false), 'https://x.example.com/a.b/y');
  assert.equal(resolveEndpoint('https://x.example.com/${B}/y', new Map([['B', '.a']]), false), 'https://x.example.com/.a/y');
});

test('a configuration cannot switch http on: the config check refuses it', async () => {
  const { normalizeConfig } = await import('../src/config.js');
  const config = { sites: [{ id: 's', baseUrl: 'https://example.org', title: 'T', contentDir: 'content' }], media: { store: { type: 's3', endpoint: 'http://127.0.0.1:9000', bucket: 'my-media' } } };
  assert.throws(() => normalizeConfig(config, { file: '/w/coffer.yaml' }), /must be an https address/);
});

test('.env.local is parsed as data: comments, quotes, export, no expansion', () => {
  const values = parseEnvFile(
    [
      '﻿# a comment',
      '',
      'A=plain',
      '  B = spaced value  ',
      'C="double quoted # not a comment"',
      "D='single quoted $HOME ${A}'",
      'export E=exported',
      'F=value # a comment',
      'G=$(echo nope)',
      'H=',
      'not a setting',
      '1BAD=x',
      'I=a#b',
    ].join('\r\n'),
  );
  assert.deepEqual(Object.fromEntries(values), {
    A: 'plain',
    B: 'spaced value',
    C: 'double quoted # not a comment',
    D: 'single quoted $HOME ${A}',
    E: 'exported',
    F: 'value',
    G: '$(echo nope)',
    H: '',
    I: 'a#b',
  });
});

test('.env.local: a comment after a closing quote is dropped with the quotes; # inside quotes or right after a character stays', () => {
  const values = parseEnvFile(
    [
      'A="abc" # my key',
      "B='abc' # my key",
      'C="abc"# glued comment',
      'D="a # b" # c',
      'E="a#b"',
      'F=ab#cd',
      'G=abc # comment',
      "H='it''s'",
      'I="abc"   ',
      'J="abc',
      'K="a" "b"',
      'L=#notacomment',
      'M="" # empty',
    ].join('\n'),
  );
  assert.deepEqual(Object.fromEntries(values), {
    A: 'abc',
    B: 'abc',
    C: 'abc',
    D: 'a # b',
    E: 'a#b',
    F: 'ab#cd',
    G: 'abc',
    H: "it''s",
    I: 'abc',
    J: '"abc',
    K: 'a" "b',
    L: '#notacomment',
    M: '',
  });
});

test('credentials come from the environment first, then from .env.local next to the configuration', async () => {
  await withMock(async (mock, dir) => {
    writeFile(dir, '.env.local', `COFFER_MEDIA_ACCESS_KEY_ID=from-file-id\nCOFFER_MEDIA_SECRET_ACCESS_KEY=${TEST_SECRET_ACCESS_KEY}\n`);
    // The environment wins over the file for the id, the file supplies the secret.
    const store = await createS3Store(configFor(mock), {
      env: { COFFER_MEDIA_ACCESS_KEY_ID: TEST_ACCESS_KEY_ID },
      configDir: dir,
      allowInsecureLoopback: true,
    });
    assert.equal(await store.has(sha('x')), false);
    assert.equal(mock.requests[0].signatureValid, true, mock.requests[0].problem);
    // Only the file: the id in it is not the one the server knows, so the server refuses and the store does not retry.
    const wrong = await createS3Store(configFor(mock), { env: {}, configDir: dir, allowInsecureLoopback: true });
    await assert.rejects(wrong.has(sha('x')), /HTTP 403/);
    assert.equal(mock.requests.length, 2);
  });
});

test('missing credentials give one message: what to set, where, a template with placeholders, and a gitignore reminder', async () => {
  await withMock(async (mock, dir) => {
    await assert.rejects(createS3Store(configFor(mock), { env: {}, configDir: dir, allowInsecureLoopback: true }), (error) => {
      assert.ok(error instanceof MissingCredentialsError);
      assert.equal(error.code, 'unavailable');
      assert.deepEqual(error.missing, ['COFFER_MEDIA_ACCESS_KEY_ID', 'COFFER_MEDIA_SECRET_ACCESS_KEY']);
      assert.ok(error.message.includes(join(dir, '.env.local')));
      assert.match(error.message, /COFFER_MEDIA_ACCESS_KEY_ID=your-access-key-id\n/);
      assert.match(error.message, /COFFER_MEDIA_SECRET_ACCESS_KEY=your-secret-access-key\n/);
      assert.match(error.message, /must be ignored by git/);
      assert.equal(error.message.split('\n\n').length, 3, 'one paragraph of text, one of template, one of notes');
      return true;
    });
    // A variable of the endpoint that is unset is in the same message, named, with no value.
    await assert.rejects(
      createS3Store(configFor(mock, { endpoint: 'https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com' }), { env: ENV, configDir: dir }),
      (error) => {
        assert.ok(error instanceof MissingCredentialsError);
        assert.deepEqual(error.missing, ['CLOUDFLARE_ACCOUNT_ID']);
        assert.match(error.message, /the variable CLOUDFLARE_ACCOUNT_ID is not set/);
        assert.match(error.message, /CLOUDFLARE_ACCOUNT_ID=your-value/);
        return true;
      },
    );
    // Empty values count as unset.
    await assert.rejects(createS3Store(configFor(mock), { env: { ...ENV, COFFER_MEDIA_SECRET_ACCESS_KEY: '' }, configDir: dir, allowInsecureLoopback: true }), MissingCredentialsError);
  });
});

test('a credential with spaces or control characters is refused without being shown', async () => {
  await withMock(async (mock) => {
    const secret = 'has a space and more';
    await assert.rejects(createS3Store(configFor(mock), { env: { ...ENV, COFFER_MEDIA_SECRET_ACCESS_KEY: secret }, allowInsecureLoopback: true }), (error) => {
      assert.ok(error instanceof MediaStoreError);
      assert.match(error.message, /COFFER_MEDIA_SECRET_ACCESS_KEY does not hold a usable credential/);
      assert.ok(!error.message.includes(secret));
      return true;
    });
  });
});

test('.env.local that is a link out of the folder is not read; a link inside it is', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'coffer-envlocal-'));
  try {
    const dir = join(root, 'repo');
    mkdirSync(dir);
    writeFileSync(join(root, 'outside.txt'), 'COFFER_MEDIA_ACCESS_KEY_ID=stolen\n');
    writeFileSync(join(dir, 'inside.txt'), 'COFFER_MEDIA_ACCESS_KEY_ID=fine\n');
    try {
      symlinkSync(join(root, 'outside.txt'), join(dir, '.env.local'));
    } catch {
      t.skip('this system does not allow symbolic links');
      return;
    }
    await assert.rejects(readEnvLocal(dir), /is a link to a place outside/);
    rmSync(join(dir, '.env.local'));
    symlinkSync(join(dir, 'inside.txt'), join(dir, '.env.local'));
    assert.equal((await readEnvLocal(dir)).get('COFFER_MEDIA_ACCESS_KEY_ID'), 'fine');
    rmSync(join(dir, '.env.local'));
    assert.equal((await readEnvLocal(dir)).size, 0, 'no file is fine');
  } finally {
    cleanup(root);
  }
});

// ---------------------------------------------------------------------------
// Through the commands

const S3_CONFIG = `sites:
  - { id: s, baseUrl: "https://example.org", title: T, contentDir: content }
media:
  store: { type: s3, endpoint: "https://abc.example.com", bucket: my-media }
`;

/**
 * @param {string} dir
 * @param {string[]} args
 * @param {Record<string, string | undefined>} env
 */
async function media(dir, args, env) {
  let out = '';
  let err = '';
  const code = await run(['media', ...args, '--config', join(dir, 'coffer.yaml')], { out: (text) => (out += text), err: (text) => (err += text) }, { env });
  return { code, out, err };
}

test('without credentials push, pull and status --remote print one message and exit 1; lock and status still work', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coffer-s3cli-'));
  try {
    writeFileSync(join(dir, 'coffer.yaml'), S3_CONFIG);
    mkdirSync(join(dir, 'content', 'p'), { recursive: true });
    const photo = join(dir, 'content', 'p', 'a.jpg');
    writeFileSync(photo, 'photo');
    const past = new Date(Date.now() - 60_000);
    utimesSync(photo, past, past);
    assert.equal((await media(dir, ['lock'], {})).code, 0);
    assert.equal((await media(dir, ['status'], {})).code, 0);
    for (const args of [['push'], ['pull'], ['status', '--remote']]) {
      const result = await media(dir, args, {});
      assert.equal(result.code, 1, args.join(' '));
      assert.equal(result.out, '');
      assert.equal(result.err.match(/COFFER_MEDIA_ACCESS_KEY_ID is not set|COFFER_MEDIA_ACCESS_KEY_ID, COFFER_MEDIA_SECRET_ACCESS_KEY are not set/g)?.length, 1, `printed once: ${args.join(' ')}`);
      assert.match(result.err, /^coffer: the media store "my-media" cannot be used/);
      assert.ok(result.err.includes(join(dir, '.env.local')));
      assert.ok(!result.err.includes('coffer: coffer:'));
    }
  } finally {
    cleanup(dir);
  }
});

test('push needs no store, so no credentials, when there is no lock file or the lock lists nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coffer-s3cli-'));
  try {
    writeFileSync(join(dir, 'coffer.yaml'), S3_CONFIG);
    mkdirSync(join(dir, 'content', 'p'), { recursive: true });
    const none = await media(dir, ['push'], {});
    assert.equal(none.code, 0, none.err);
    assert.equal(none.err, '');
    assert.match(none.out, /no lock file/i);

    writeFileSync(join(dir, 'media.lock.json'), '{"version":1,"files":[\n]}\n');
    const empty = await media(dir, ['push'], {});
    assert.equal(empty.code, 0, empty.err);
    assert.equal(empty.err, '');
    assert.match(empty.out, /0 object\(s\) uploaded/);

    // With a photo in the lock, the credentials are needed again.
    const photo = join(dir, 'content', 'p', 'a.jpg');
    writeFileSync(photo, 'photo');
    const past = new Date(Date.now() - 60_000);
    utimesSync(photo, past, past);
    assert.equal((await media(dir, ['lock'], {})).code, 0);
    const needed = await media(dir, ['push'], {});
    assert.equal(needed.code, 1);
    assert.match(needed.err, /^coffer: the media store "my-media" cannot be used/);
  } finally {
    cleanup(dir);
  }
});

test('the registry makes an s3 store from a checked configuration', async () => {
  await withMock(async (mock) => {
    const { normalizeConfig } = await import('../src/config.js');
    const config = normalizeConfig(
      { sites: [{ id: 's', baseUrl: 'https://example.org', title: 'T', contentDir: 'content' }], media: { store: { type: 's3', endpoint: 'https://abc.example.com', bucket: 'my-media' } } },
      { file: '/w/coffer.yaml' },
    );
    const storeConfig = /** @type {NonNullable<typeof config.media>} */ (config.media).store;
    const store = await createStore(storeConfig, { env: ENV });
    assert.equal(store.description, 'bucket my-media at https://abc.example.com');
    await assert.rejects(createStore(storeConfig, { env: {} }), MissingCredentialsError);
    assert.equal(mock.requests.length, 0);
  });
});
