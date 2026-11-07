import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { run } from '../src/cli.js';
import { describeBuildError, EVENTS_PATH, injectReloadScript, overlayPage, startDev } from '../src/dev.js';
import { startServer } from '../src/serve.js';

const NOW = new Date('2026-06-01T12:00:00Z');

const CONFIG = `sites:
  - id: pro
    baseUrl: https://pro.example
    lang: en
    timezone: UTC
    title: Pro
    contentDir: content
    blogs:
      - { id: devlog, dir: content/devlog, prefix: devlog }
  - id: personal
    baseUrl: https://my.example
    lang: ru
    timezone: Europe/Samara
    title: Личный
    contentDir: content-personal
    blogs:
      - { id: notes, dir: content-personal/notes, prefix: "" }
`;

/** @type {string} */
let dir;
/** @type {import('../src/dev.js').RunningDev | undefined} */
let dev;
/** @type {string[]} */
let stdout;
/** @type {string[]} */
let stderr;

/**
 * @param {string} path Path below the project.
 * @param {string} text
 */
function write(path, text) {
  const file = join(dir, path);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, text);
}

/**
 * @param {string} title
 * @param {string} extra Extra front matter lines.
 * @param {string} [body]
 */
function post(title, extra, body = 'Some text about the thing.\n') {
  return `---\ntitle: ${title}\n${extra}---\n\n${body}`;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'coffer-dev-'));
  stdout = [];
  stderr = [];
  write('coffer.yaml', CONFIG);
  write('content/devlog/live/index.md', post('A live post', 'date: 2026-01-10\n'));
  write('content/devlog/wip/index.md', post('Work in progress', 'date: 2026-02-01\ndraft: true\n'));
  write('content/devlog/soon/index.md', post('Coming soon', 'date: 2027-03-04\n'));
  write('content-personal/notes/zapis/index.md', post('Запись', 'date: 2026-01-10\n'));
  write('content-personal/notes/chernovik/index.md', post('Черновик записи', 'date: 2026-02-01\ndraft: true\n'));
});

afterEach(async () => {
  await dev?.close();
  dev = undefined;
  rmSync(dir, { recursive: true, force: true });
});

/**
 * @param {Partial<import('../src/dev.js').DevOptions>} [options]
 */
async function start(options = {}) {
  dev = await startDev({
    configPath: join(dir, 'coffer.yaml'),
    port: 0,
    now: NOW,
    debounceMs: 20,
    io: { out: (text) => stdout.push(text), err: (text) => stderr.push(text) },
    ...options,
  });
  return dev;
}

/**
 * @param {import('../src/dev.js').DevSite} site
 * @param {string} path
 */
function get(site, path) {
  return fetch(`${site.url}${path}`, { redirect: 'manual' });
}

/**
 * Opens the event stream of a site and collects its events.
 *
 * @param {import('../src/dev.js').DevSite} site
 */
async function listen(site) {
  const controller = new AbortController();
  const response = await fetch(`${site.url}${EVENTS_PATH}`, { signal: controller.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/);
  const reader = /** @type {ReadableStream<Uint8Array>} */ (response.body).getReader();
  const decoder = new TextDecoder();
  let received = '';
  const done = (async () => {
    try {
      for (;;) {
        const { value, done: ended } = await reader.read();
        if (ended) return;
        received += decoder.decode(value, { stream: true });
      }
    } catch {
      // The stream is cut when the test closes it.
    }
  })();
  return {
    /** @returns {number} */
    count: () => (received.match(/^event: reload$/gm) ?? []).length,
    /**
     * @param {number} count Number of reload events to wait for.
     * @param {number} [timeoutMs]
     */
    async waitFor(count, timeoutMs = 60000) {
      const until = Date.now() + timeoutMs;
      while ((received.match(/^event: reload$/gm) ?? []).length < count) {
        if (Date.now() > until) throw new Error(`no reload event within ${timeoutMs} ms (got: ${JSON.stringify(received)})`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    },
    async close() {
      controller.abort();
      await done;
    },
  };
}

test('every site is served on its own port with drafts and scheduled posts marked', async () => {
  const running = await start();
  assert.deepEqual(running.sites.map((site) => site.id), ['pro', 'personal']);
  assert.notEqual(running.sites[0].port, running.sites[1].port);
  assert.equal(running.phase(), 'ready');
  assert.match(stdout.join(''), /pro: http:\/\/localhost:\d+\/ \(drafts and scheduled posts included\)/);
  assert.match(stdout.join(''), /personal: http:\/\/localhost:\d+\//);

  const [pro, personal] = running.sites;
  const draft = await get(pro, '/devlog/wip/');
  assert.equal(draft.status, 200);
  const draftHtml = await draft.text();
  assert.match(draftHtml, /<h1>Work in progress<\/h1>/);
  assert.match(draftHtml, /<p class="preview-note preview-banner preview-banner-draft" role="note">Draft<\/p>/);

  const scheduled = await (await get(pro, '/devlog/soon/')).text();
  assert.match(scheduled, /preview-banner-scheduled" role="note">Scheduled for Mar 4, 2027<\/p>/);

  const published = await (await get(pro, '/devlog/live/')).text();
  assert.doesNotMatch(published, /preview-banner/);

  const index = await (await get(pro, '/devlog/')).text();
  assert.match(index, /Work in progress/);
  assert.match(index, /preview-banner-draft/);

  const russian = await (await get(personal, '/chernovik/')).text();
  assert.match(russian, /<html lang="ru">/);
  assert.match(russian, /preview-banner-draft" role="note">Черновик<\/p>/);
});

test('the dev server follows the serve rules and adds the reload script to HTML only', async () => {
  const running = await start();
  const [pro] = running.sites;

  const slash = await get(pro, '/devlog');
  assert.equal(slash.status, 308);
  assert.equal(slash.headers.get('location'), '/devlog/');
  assert.equal(slash.headers.get('cache-control'), 'no-store');

  const page = await get(pro, '/devlog/live/');
  assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8');
  const html = await page.text();
  assert.match(html, /<script src="\/__coffer\/reload\.js"><\/script>\s*<\/body>/);

  const script = await get(pro, '/__coffer/reload.js');
  assert.equal(script.status, 200);
  assert.match(await script.text(), /new EventSource\('\/__coffer\/events'\)/);

  const missing = await get(pro, '/nothing-here/');
  assert.equal(missing.status, 404);
  assert.match(await missing.text(), /Page not found/);

  const css = await (await get(pro, '/assets/coffer.css')).text();
  assert.doesNotMatch(css, /__coffer/);
});

test('a normal build never contains the reload script', async () => {
  const running = await start();
  for (const site of running.sites) {
    const page = readFileSync(join(site.dir, site === running.sites[0] ? 'devlog/live/index.html' : 'zapis/index.html'), 'utf8');
    assert.doesNotMatch(page, /__coffer/);
  }
  assert.ok(existsSync(join(dir, '.cache', 'dev', 'pro', 'index.html')), 'the preview is built into .cache/dev');
});

test('a change to a post rebuilds the sites and emits a reload event', async () => {
  const running = await start();
  const [pro, personal] = running.sites;
  const proEvents = await listen(pro);
  const personalEvents = await listen(personal);
  try {
    write('content/devlog/wip/index.md', post('Work in progress, renamed', 'date: 2026-02-01\ndraft: true\n'));
    await proEvents.waitFor(1);
    await personalEvents.waitFor(1);
    await running.idle();
    const html = await (await get(pro, '/devlog/wip/')).text();
    assert.match(html, /<h1>Work in progress, renamed<\/h1>/);
    assert.match(stdout.join(''), /Built in \d+\.\d s \(changed: content\/devlog\/wip\/index\.md\)/);

    // A new file counts, too.
    write('content/devlog/fresh/index.md', post('Fresh from the editor', 'date: 2026-05-01\ndraft: true\n'));
    await proEvents.waitFor(2);
    await running.idle();
    assert.equal((await get(pro, '/devlog/fresh/')).status, 200);
  } finally {
    await proEvents.close();
    await personalEvents.close();
  }
});

test('a change to the configuration is picked up', async () => {
  const running = await start();
  const [pro] = running.sites;
  const events = await listen(pro);
  try {
    write('coffer.yaml', CONFIG.replace('title: Pro', 'title: Professional'));
    await events.waitFor(1);
    await running.idle();
    assert.match(await (await get(pro, '/devlog/live/')).text(), /Professional/);
  } finally {
    await events.close();
  }
});

test('a build error is reported in the terminal and the browser, and the server keeps serving', async () => {
  const running = await start();
  const [pro, personal] = running.sites;
  const events = await listen(pro);
  try {
    write('content/devlog/wip/index.md', '---\ntitle: Broken\ndate: not a date\n---\n\nText\n');
    await events.waitFor(1);
    await running.idle();

    assert.equal(running.phase(), 'error');
    assert.match(running.lastError() ?? '', /wip[\\/]index\.md: date: must be a date/);
    assert.match(stderr.join(''), /Build failed \(changed: content\/devlog\/wip\/index\.md\):\n.*date: must be a date/);

    const overlay = await get(pro, '/devlog/live/');
    assert.equal(overlay.status, 500);
    const html = await overlay.text();
    assert.match(html, /<h1>The build failed<\/h1>/);
    assert.match(html, /date: must be a date/);
    assert.match(html, /<script src="\/__coffer\/reload\.js"><\/script>/);
    assert.equal((await get(personal, '/')).status, 500, 'every site shows the error: they are built together');

    // The event stream is still open and the next fix builds again. The failed build was instant; chokidar ignores a second change of a file within 50 ms.
    await new Promise((resolve) => setTimeout(resolve, 200));
    write('content/devlog/wip/index.md', post('Fixed again', 'date: 2026-02-01\ndraft: true\n'));
    await events.waitFor(2);
    await running.idle();
    assert.equal(running.phase(), 'ready');
    assert.equal(running.lastError(), null);
    const fixed = await get(pro, '/devlog/wip/');
    assert.equal(fixed.status, 200);
    assert.match(await fixed.text(), /<h1>Fixed again<\/h1>/);
  } finally {
    await events.close();
  }
});

test('a broken configuration is an error page too, not a crash', async () => {
  const running = await start();
  const [pro] = running.sites;
  const events = await listen(pro);
  try {
    write('coffer.yaml', 'sites: nope\n');
    await events.waitFor(1);
    await running.idle();
    assert.equal(running.phase(), 'error');
    assert.equal((await get(pro, '/')).status, 500);
    // The failed build was instant; chokidar ignores a second change of a file within 50 ms.
    await new Promise((resolve) => setTimeout(resolve, 200));
    write('coffer.yaml', CONFIG);
    await events.waitFor(2);
    await running.idle();
    assert.equal((await get(pro, '/devlog/live/')).status, 200);
  } finally {
    await events.close();
  }
});

test('a build that fails at the start still serves the error', async () => {
  write('content/devlog/live/index.md', '---\ndate: 2026-01-10\n---\n\nNo title\n');
  const running = await start();
  assert.equal(running.phase(), 'error');
  const response = await get(running.sites[0], '/');
  assert.equal(response.status, 500);
  assert.match(await response.text(), /title: is required/);
  assert.match(stderr.join(''), /Build failed/);
});

test('rebuild() builds again without a watcher', async () => {
  const running = await start({ watch: false });
  const [pro] = running.sites;
  write('content/devlog/live/index.md', post('A live post, edited', 'date: 2026-01-10\n'));
  assert.match(await (await get(pro, '/devlog/live/')).text(), /<h1>A live post<\/h1>/);
  await running.rebuild();
  assert.match(await (await get(pro, '/devlog/live/')).text(), /<h1>A live post, edited<\/h1>/);
});

test('sites take the ports after the first one', async () => {
  // Two neighbouring free ports: ask for one and hope its successor is free as well.
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const probe = await startServer({ dir, port: 0 });
    const first = probe.port;
    await probe.close();
    try {
      const running = await start({ port: first, watch: false });
      assert.deepEqual(running.sites.map((site) => site.port), [first, first + 1]);
      return;
    } catch (error) {
      assert.match(String(error), /EADDRINUSE/);
      dev = undefined;
    }
  }
  assert.fail('no two neighbouring free ports were found');
});

test('a port in use stops the start and frees the ports already taken', async () => {
  const blocker = await startServer({ dir, port: 0 });
  const first = blocker.port - 1;
  try {
    // The first site listens on `first`, the second collides with the blocker.
    await assert.rejects(start({ port: first, watch: false }), /EADDRINUSE/);
    dev = undefined;
    const again = await startServer({ dir, port: first });
    await again.close();
  } finally {
    await blocker.close();
  }
});

test('coffer dev prints the addresses and stops on a signal', async () => {
  const controller = new AbortController();
  const io = { out: (/** @type {string} */ text) => stdout.push(text), err: (/** @type {string} */ text) => stderr.push(text) };
  const finished = run(['dev', '--config', join(dir, 'coffer.yaml'), '--port', '0'], io, {
    dev: { signal: controller.signal, out: join(dir, 'preview'), watch: false },
  });
  const until = Date.now() + 60000;
  while (!stdout.join('').includes('Press Ctrl+C')) {
    assert.ok(Date.now() < until, `no start in time: ${stdout.join('')}${stderr.join('')}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.match(stdout.join(''), /pro: http:\/\/localhost:\d+\//);
  assert.ok(existsSync(join(dir, 'preview', 'pro', 'index.html')));
  controller.abort();
  assert.equal(await finished, 0);
});

test('coffer dev rejects bad options and a missing configuration', async () => {
  const io = { out: (/** @type {string} */ text) => stdout.push(text), err: (/** @type {string} */ text) => stderr.push(text) };
  assert.equal(await run(['dev', '--port', 'x'], io), 1);
  assert.match(stderr.join(''), /--port must be a number/);
  assert.equal(await run(['dev', '--bogus'], io), 1);
  assert.match(stderr.join(''), /unexpected argument "--bogus"/);
  stderr.length = 0;
  assert.equal(await run(['dev', '--config', join(dir, 'missing.yaml')], io), 1);
  assert.match(stderr.join(''), /missing\.yaml: file not found/);
});

test('the helpers escape errors and describe them', () => {
  assert.match(overlayPage('error', '<b>&"x"'), /&lt;b&gt;&amp;&quot;x&quot;/);
  assert.match(overlayPage('building', ''), /Building the sites/);
  assert.equal(injectReloadScript('<body>x</body>'), '<body>x<script src="/__coffer/reload.js"></script>\n</body>');
  assert.equal(injectReloadScript('no body'), 'no body<script src="/__coffer/reload.js"></script>\n');
  assert.equal(describeBuildError(Object.assign(new Error('x'), { errors: ['a', 'b'] })), 'a\nb');
  assert.match(describeBuildError(new TypeError('boom')), /TypeError: boom\n\s+at /);
});
