import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildSites } from '../src/build.js';
import { loadConfig } from '../src/config.js';

const NOW = new Date('2026-06-01T12:00:00Z');
const offline = async () => new Response('', { status: 404 });

/**
 * @template T
 * @param {Record<string, string>} files
 * @param {(root: string) => Promise<T>} body
 * @returns {Promise<T>}
 */
async function inTree(files, body) {
  const root = mkdtempSync(join(tmpdir(), 'coffer-typography-build-'));
  try {
    for (const [name, content] of Object.entries(files)) {
      const target = join(root, ...name.split('/'));
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, content);
    }
    return await body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const config = (extra = '') =>
  [
    'sites:',
    '  - id: demo',
    '    baseUrl: https://demo.example',
    '    lang: en',
    '    title: Demo',
    '    contentLicense: Some rights reserved',
    '    contentDir: notes',
    extra,
    '    blogs:',
    '      - { id: notes, dir: notes, prefix: log, title: Notes }',
    '',
  ].join('\n');

/**
 * @param {string} root
 * @returns {Promise<{ out: string, warnings: string[] }>}
 */
async function build(root) {
  const [result] = await buildSites(loadConfig({ configPath: join(root, 'coffer.yaml') }), {
    out: join(root, 'out'),
    now: NOW,
    videoFetch: { fetch: offline },
  });
  return { out: result.outDir, warnings: result.warnings };
}

/**
 * @param {string} body
 * @param {string} [extra]
 * @param {string} [title]
 */
const post = (body, extra = '', title = 'Glue-up') => `---\ntitle: ${title}\ndate: 2026-05-01\n${extra}---\n\n${body}\n`;
/**
 * @param {string} out
 * @param {...string} parts
 */
const read =(out, ...parts) => readFileSync(join(out, ...parts), 'utf8');

test('a post is typeset by default: curly quotes and en rules', async () => {
  await inTree({ 'coffer.yaml': config(), 'notes/a.md': post('She said "hi" -- then left. Pages 1-5.') }, async (root) => {
    const { out } = await build(root);
    const html = read(out, 'log', 'a', 'index.html');
    assert.match(html, /She said “hi” – then left\. Pages 1–5\./);
  });
});

test('typography: false in front matter leaves the post as typed', async () => {
  await inTree({ 'coffer.yaml': config(), 'notes/a.md': post('She said "hi" -- then left.', 'typography: false\n') }, async (root) => {
    const { out, warnings } = await build(root);
    const html = read(out, 'log', 'a', 'index.html');
    assert.match(html, /She said &#x22;hi&#x22; -- then left\.|She said "hi" -- then left\./);
    assert.ok(!html.includes('“'));
    assert.deepEqual(warnings, []);
  });
});

test('a post with lang: ru uses ru rules and sets lang on its article when the site is en', async () => {
  await inTree(
    {
      'coffer.yaml': config(),
      'notes/ru.md': post('Он сказал "привет" и ушёл.', 'lang: ru\n'),
      'notes/en.md': post('He said "hi".'),
    },
    async (root) => {
      const { out } = await build(root);
      const ru = read(out, 'log', 'ru', 'index.html');
      assert.match(ru, /«привет»/);
      assert.match(ru, /<article class="post" lang="ru">/);
      const en = read(out, 'log', 'en', 'index.html');
      assert.match(en, /“hi”/);
      assert.match(en, /<article class="post">/);
    },
  );
});

test('the site typography setting turns typography off for every post', async () => {
  await inTree({ 'coffer.yaml': config('    typography: { enabled: false }'), 'notes/a.md': post('He said "hi".') }, async (root) => {
    const { out } = await build(root);
    assert.ok(!read(out, 'log', 'a', 'index.html').includes('“'));
  });
});

test('the title of a post is typeset in the page body and in <title>', async () => {
  await inTree({ 'coffer.yaml': config(), 'notes/a.md': post('Text.', '', "'The \"box\" of Tools'") }, async (root) => {
    const { out } = await build(root);
    const html = read(out, 'log', 'a', 'index.html');
    assert.match(html, /<h1>[^<]*“[^<]*<\/h1>/);
    assert.match(html, /<title>The “box” of Tools/);
  });
});

test('an unpaired quote is a warning with file and line', async () => {
  await inTree({ 'coffer.yaml': config(), 'notes/a.md': post('One line.\n\nHe said "oops and left.') }, async (root) => {
    const { warnings } = await build(root);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /^notes\/a\.md:8: .*unpaired quote "/);
  });
});

test('blog-level lang and typography override the site', async () => {
  /** @param {string} entry */
  const blogs = (entry) => config().replace(/    blogs:\n.*\n/, `    blogs:\n      - { id: notes, dir: notes, prefix: log, title: Notes, ${entry} }\n`);
  await inTree({ 'coffer.yaml': blogs('lang: ru'), 'notes/a.md': post('Он сказал "привет".') }, async (root) => {
    const { out } = await build(root);
    const html = read(out, 'log', 'a', 'index.html');
    assert.match(html, /«привет»/);
    assert.match(html, /<article class="post" lang="ru">/);
  });
  await inTree({ 'coffer.yaml': blogs('typography: { enabled: false }'), 'notes/a.md': post('He said "hi".') }, async (root) => {
    const { out } = await build(root);
    assert.ok(!read(out, 'log', 'a', 'index.html').includes('“'));
  });
});

test('an unpaired quote in the home file is a warning with file and line', async () => {
  await inTree(
    { 'coffer.yaml': config().replace('contentDir: notes', 'contentDir: content'), 'notes/a.md': post('Text.'), 'content/home.md': '---\ntitle: Demo\n---\n\nAbout.\n\nHe said "oops.\n' },
    async (root) => {
      const { warnings } = await build(root);
      assert.ok(warnings.some((w) => /home\.md:\d+: .*unpaired quote/.test(w)), warnings.join('\n'));
    },
  );
});

test('the blog title on the blog index is typeset in the body', async () => {
  await inTree({ 'coffer.yaml': config().replace('title: Notes', 'title: \'The "Notes"\''), 'notes/a.md': post('Text.') }, async (root) => {
    const { out } = await build(root);
    assert.match(read(out, 'log', 'index.html'), /<h1>The “Notes”<\/h1>/);
  });
});

test('title, meta text and share text are typeset in plain mode', async () => {
  const files = {
    'coffer.yaml': config().replace('title: Notes }', 'title: Notes, shareSummary: true }'),
    'notes/tags.yaml': 'alpha:\n  name: Tom "x"\n',
    'notes/a.md': post('"Вернулся" он в лес -- поздно.', 'lang: ru\nsummary: Он ушёл в лес и "вернулся" -- поздно.\ntags: [alpha]\n', 'Он сказал "привет" в доме'),
  };
  await inTree(files, async (root) => {
    const { out } = await build(root);
    const html = read(out, 'log', 'a', 'index.html');
    const share = read(out, 'log', 'a', 'share.txt');
    const head = html.slice(0, html.indexOf('</head>'));
    const body = html.slice(html.indexOf('</head>'));
    assert.match(head, /<title>Он сказал «привет» в доме \| Demo<\/title>/);
    assert.match(head, /<meta property="og:title" content="Он сказал «привет» в доме \| Demo">/);
    assert.match(head, /<meta name="twitter:title" content="Он сказал «привет» в доме \| Demo">/);
    assert.match(head, /<meta property="og:description" content="Он ушёл в лес и «вернулся» – поздно\.">/);
    assert.match(head, /<meta name="twitter:description" content="Он ушёл в лес и «вернулся» – поздно\.">/);
    assert.match(share, /^Он сказал «привет» в доме\n/);
    assert.match(share, /Он ушёл в лес и «вернулся» – поздно\./);
    assert.ok(!/[  ]/.test(head), 'no no-break space in head');
    assert.ok(!/[  ]/.test(share), 'no no-break space in share text');
    assert.ok(!/class="hang"/.test(head) && !share.includes('hang'));
    assert.ok(body.includes('в лес'), 'body of the same page keeps its no-break spaces');
    assert.ok(body.includes('class="hang"'), 'body of the same page keeps its hang span');
    assert.ok(html.includes('>Tom &quot;x&quot;</a>'), 'a tag name stays as written');
    assert.ok(!html.includes('Tom “x”'), 'a tag name is not typeset');
  });
});

test('a French title gets normal spaces in meta text and narrow spaces in the body', async () => {
  const files = { 'coffer.yaml': config(), 'notes/a.md': post('Quoi ? Oui !', 'lang: fr\nsummary: Quoi ? Oui !\n', 'Dis "quoi" ?') };
  await inTree(files, async (root) => {
    const { out } = await build(root);
    const html = read(out, 'log', 'a', 'index.html');
    const head = html.slice(0, html.indexOf('</head>'));
    assert.match(head, /<title>Dis « quoi » \? \| Demo<\/title>/);
    assert.match(head, /<meta property="og:description" content="Quoi \? Oui !">/);
    assert.ok(!/[  ]/.test(head));
    assert.ok(/[  ]/.test(html.slice(html.indexOf('</head>'))));
  });
});

test('typography off leaves title and meta text as typed', async () => {
  await inTree({ 'coffer.yaml': config('    typography: { enabled: false }'), 'notes/a.md': post('Text.', 'summary: He said "hi".\n', 'A "b" c') }, async (root) => {
    const { out } = await build(root);
    const html = read(out, 'log', 'a', 'index.html');
    const h = html.slice(0, html.indexOf('</head>'));
    assert.ok(!h.includes('“'));
    assert.match(h, /<title>A &quot;b&quot; c/);
    assert.match(h, /<meta property="og:description" content="He said &quot;hi&quot;\.">/);
  });
});

const FEED_POST = '"Quoted" start -- of a post.\n\nSecond paragraph.';

test('feed entries have no hang span; titles and summaries are typeset with normal spaces', async () => {
  const files = { 'coffer.yaml': config(), 'notes/a.md': post(FEED_POST, 'summary: He said "hi" -- 12 km.\n', 'Dis "quoi" -- oui') };
  await inTree(files, async (root) => {
    const { out } = await build(root);
    assert.match(read(out, 'log', 'a', 'index.html'), /class="hang"/);
    const feed = read(out, 'log', 'feed.xml');
    assert.ok(!feed.includes('class=&quot;hang&quot;') && !feed.includes('class="hang"'));
    assert.match(feed, /<title>Dis “quoi” – oui<\/title>/);
    assert.match(feed, /<summary>He said “hi” – 12 km\.<\/summary>/);
    assert.ok(!/[  ]/.test(feed.slice(feed.indexOf('<entry>'), feed.indexOf('<content'))));
  });
});

test('feeds: false leaves feed titles and summaries as written, still without hang spans', async () => {
  const files = { 'coffer.yaml': config('    typography: { feeds: false }'), 'notes/a.md': post(FEED_POST, 'summary: He said "hi".\n', 'Dis "quoi"') };
  await inTree(files, async (root) => {
    const { out } = await build(root);
    const feed = read(out, 'log', 'feed.xml');
    assert.match(feed, /<title>Dis "quoi"<\/title>/);
    assert.match(feed, /<summary>He said "hi".<\/summary>/);
    assert.ok(!feed.includes('class=&quot;hang&quot;'));
  });
});

test('the report lists a heading whose case changed, with file, line, before and after', async () => {
  await inTree({ 'coffer.yaml': config(), 'notes/a.md': post('Intro.\n\n## the end of the road: a look back\n') }, async (root) => {
    await build(root);
    const { headingChanges } = JSON.parse(read(root, '.coffer', 'report.json'));
    assert.deepEqual(headingChanges, [
      { site: 'demo', file: 'notes/a.md', line: 8, before: 'the end of the road: a look back', after: 'The End of the Road: A Look Back' },
    ]);
  });
});

test('the report has no heading change when no heading changed', async () => {
  await inTree({ 'coffer.yaml': config(), 'notes/a.md': post('Intro.\n\n## Already Fine\n') }, async (root) => {
    await build(root);
    assert.deepEqual(JSON.parse(read(root, '.coffer', 'report.json')).headingChanges, []);
  });
});

test('hangLines marks line-start candidates and loads the script only when the site turns it on', async () => {
  const body = 'We tried the clamp (the old one) and "it worked" at last.';
  await inTree({ 'coffer.yaml': config('    typography: { hangLines: true }'), 'notes/a.md': post(body) }, async (root) => {
    const { out } = await build(root);
    const html = read(out, 'log', 'a', 'index.html');
    assert.match(html, /<span class="hang-l" data-m="bracket">\(<\/span>the old one\)/);
    assert.match(html, /<script src="\/assets\/hang-lines\.js" defer><\/script>/);
    assert.ok(existsSync(join(out, 'assets', 'hang-lines.js')), 'the script is published');
    assert.ok(existsSync(join(out, 'assets', 'coffer.css')));
  });
  await inTree({ 'coffer.yaml': config(), 'notes/a.md': post(body) }, async (root) => {
    const { out } = await build(root);
    const html = read(out, 'log', 'a', 'index.html');
    assert.ok(!html.includes('hang-l'), 'off by default');
    assert.ok(!html.includes('hang-lines.js'));
  });
  await inTree(
    { 'coffer.yaml': config('    typography: { hangLines: true }'), 'notes/a.md': post(body, 'typography: { hangLines: false }\n') },
    async (root) => {
      const { out } = await build(root);
      assert.ok(!read(out, 'log', 'a', 'index.html').includes('hang-l"'), 'a post can turn it off');
    },
  );
});
