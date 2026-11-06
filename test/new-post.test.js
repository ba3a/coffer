import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseNewArgs, run } from '../src/cli.js';
import { loadConfig } from '../src/config.js';
import { discoverPosts } from '../src/content/posts.js';
import { createPost, formatLocalDate, NewPostError, slugify } from '../src/new-post.js';

// 10:30 UTC is 14:30 in Samara (UTC+4) and 12:30 in Berlin in summer.
const NOW = new Date('2026-06-01T10:30:00Z');

/**
 * A directory with a configuration of two sites, one English and one Russian.
 *
 * @param {(dir: string) => Promise<void> | void} body
 */
async function withProject(body) {
  const dir = mkdtempSync(join(tmpdir(), 'coffer-new-'));
  try {
    mkdirSync(join(dir, 'content', 'devlog'), { recursive: true });
    mkdirSync(join(dir, 'content', 'my'), { recursive: true });
    writeFileSync(
      join(dir, 'coffer.yaml'),
      `sites:
  - id: pro
    baseUrl: https://pro.example
    lang: en
    timezone: Europe/Berlin
    title: Pro
    contentDir: content
    blogs:
      - { id: devlog, dir: content/devlog, prefix: devlog }
  - id: personal
    baseUrl: https://my.example
    lang: ru
    timezone: Europe/Samara
    title: Личный
    contentDir: content
    blogs:
      - { id: notes, dir: content/my, prefix: "" }
`,
    );
    await body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * @param {string[]} argv
 * @param {Date} [now]
 */
async function runNew(argv, now = NOW) {
  let out = '';
  let err = '';
  const code = await run(['new', ...argv], { out: (text) => (out += text), err: (text) => (err += text) }, { now });
  return { code, out, err };
}

test('slugify keeps English words and drops punctuation and accents', () => {
  assert.equal(slugify('My First Dovetail'), 'my-first-dovetail');
  assert.equal(slugify('  What? A "joint"!  '), 'what-a-joint');
  assert.equal(slugify('Café déjà vu'), 'cafe-deja-vu');
  assert.equal(slugify('v1.2 and 3D'), 'v1-2-and-3d');
});

test('slugify transliterates Cyrillic to Latin', () => {
  assert.equal(slugify('Шкатулка из ореха'), 'shkatulka-iz-orekha');
  assert.equal(slugify('Ёлка, щётка и чайка'), 'elka-shchetka-i-chayka');
  assert.equal(slugify('Подъём: ъ и ь не видны'), 'podem-i-ne-vidny');
  assert.equal(slugify('Жизнь в Харькове — їжак'), 'zhizn-v-kharkove-yizhak');
});

test('slugify leaves nothing for a title without Latin or Cyrillic letters', () => {
  assert.equal(slugify('日本語'), '');
  assert.equal(slugify('?!'), '');
});

test('the date is written on the clocks of the site time zone', () => {
  assert.equal(formatLocalDate(NOW, 'Europe/Samara'), '2026-06-01 14:30');
  assert.equal(formatLocalDate(NOW, 'Europe/Berlin'), '2026-06-01 12:30');
  assert.equal(formatLocalDate(new Date('2026-12-31T23:30:00Z'), 'Asia/Tokyo'), '2027-01-01 08:30');
});

test('new creates a draft post folder for an English title', async () => {
  await withProject(async (dir) => {
    const result = await runNew(['devlog', 'My First Dovetail', '--config', join(dir, 'coffer.yaml')]);
    assert.equal(result.code, 0, result.err);
    const file = join(dir, 'content', 'devlog', 'my-first-dovetail', 'index.md');
    assert.equal(
      readFileSync(file, 'utf8'),
      `---
title: My First Dovetail
date: 2026-06-01 12:30
tags: []
draft: true
---

`,
    );
    assert.match(result.out, /Created .*my-first-dovetail[\\/]index\.md/);
    const [post] = discoverPosts(join(dir, 'content', 'devlog'), { timezone: 'Europe/Berlin' });
    assert.equal(post.slug, 'my-first-dovetail');
    assert.equal(post.draft, true);
    assert.equal(post.date.toISOString(), '2026-06-01T10:30:00.000Z');
  });
});

test('new creates a draft post folder for a Russian title with a transliterated slug', async () => {
  await withProject(async (dir) => {
    const result = await runNew(['notes', 'Шкатулка из ореха: первая попытка', '--config', join(dir, 'coffer.yaml')]);
    assert.equal(result.code, 0, result.err);
    const file = join(dir, 'content', 'my', 'shkatulka-iz-orekha-pervaya-popytka', 'index.md');
    assert.equal(
      readFileSync(file, 'utf8'),
      `---
title: "Шкатулка из ореха: первая попытка"
date: 2026-06-01 14:30
tags: []
draft: true
---

`,
    );
    const [post] = discoverPosts(join(dir, 'content', 'my'), { timezone: 'Europe/Samara' });
    assert.equal(post.title, 'Шкатулка из ореха: первая попытка');
    assert.equal(post.draft, true);
  });
});

test('new writes the given date and tags, and a slug that was asked for', async () => {
  await withProject(async (dir) => {
    const config = join(dir, 'coffer.yaml');
    const done = await runNew(
      ['pro/devlog', 'Release notes', '--config', config, '--date', '2026-07-01T09:00', '--tags', 'Tools/Coffer, release', '--slug=notes-1'],
    );
    assert.equal(done.code, 0, done.err);
    assert.equal(
      readFileSync(join(dir, 'content', 'devlog', 'notes-1', 'index.md'), 'utf8'),
      `---
title: Release notes
date: 2026-07-01T09:00
tags: [tools/coffer, release]
draft: true
---

`,
    );
  });
});

test('new refuses a post that exists, in either form, and leaves it alone', async () => {
  await withProject(async (dir) => {
    const config = join(dir, 'coffer.yaml');
    mkdirSync(join(dir, 'content', 'devlog', 'taken'));
    writeFileSync(join(dir, 'content', 'devlog', 'taken', 'index.md'), 'mine\n');
    writeFileSync(join(dir, 'content', 'devlog', 'single.md'), 'single\n');

    const folder = await runNew(['devlog', 'Taken', '--config', config]);
    assert.equal(folder.code, 1);
    assert.match(folder.err, /taken: already exists/);
    assert.equal(readFileSync(join(dir, 'content', 'devlog', 'taken', 'index.md'), 'utf8'), 'mine\n');

    const file = await runNew(['devlog', 'Single', '--config', config]);
    assert.equal(file.code, 1);
    assert.match(file.err, /single\.md: already exists/);
    assert.equal(existsSync(join(dir, 'content', 'devlog', 'single')), false);
  });
});

test('new reports a bad blog, date, tag and an unusable title', async () => {
  await withProject(async (dir) => {
    const config = join(dir, 'coffer.yaml');
    const unknown = await runNew(['nope', 'Title', '--config', config]);
    assert.equal(unknown.code, 1);
    assert.match(unknown.err, /no blog "nope" \(known: pro\/devlog, personal\/notes\)/);

    const date = await runNew(['devlog', 'Title', '--config', config, '--date', 'tomorrow', '--tags', 'a b/']);
    assert.equal(date.code, 1);
    assert.match(date.err, /--date: must be a date/);
    assert.match(date.err, /--tags: "a b\/" must be a slash separated path/);

    const slug = await runNew(['devlog', '日本語', '--config', config]);
    assert.equal(slug.code, 1);
    assert.match(slug.err, /cannot make a slug from "日本語"; give one with --slug/);
    assert.equal(existsSync(join(dir, 'content', 'devlog', '日本語')), false);
  });
});

test('a blog id shared by two sites needs the site in front', async () => {
  await withProject(async (dir) => {
    const config = join(dir, 'coffer.yaml');
    writeFileSync(
      config,
      readFileSync(config, 'utf8').replace('{ id: notes, dir: content/my, prefix: "" }', '{ id: devlog, dir: content/my, prefix: "" }'),
    );
    const ambiguous = await runNew(['devlog', 'Title', '--config', config]);
    assert.equal(ambiguous.code, 1);
    assert.match(ambiguous.err, /names several blogs; write site\/blog/);
    const chosen = await runNew(['personal/devlog', 'Title', '--config', config]);
    assert.equal(chosen.code, 0, chosen.err);
    assert.ok(existsSync(join(dir, 'content', 'my', 'title', 'index.md')));
  });
});

test('newPostTemplate supplies the text below the front matter', async () => {
  await withProject(async (dir) => {
    const config = join(dir, 'coffer.yaml');
    writeFileSync(join(dir, 'post-template.md'), 'Intro for {{ title }}.\r\n\r\n## What happened\r\n\r\nSlug: {{slug}}, {{date}}\r\n');
    writeFileSync(
      config,
      readFileSync(config, 'utf8').replace(
        '{ id: devlog, dir: content/devlog, prefix: devlog }',
        '{ id: devlog, dir: content/devlog, prefix: devlog, newPostTemplate: post-template.md }',
      ),
    );
    assert.equal(loadConfig({ configPath: config }).sites[0].blogs[0].newPostTemplate, join(dir, 'post-template.md'));
    const result = await runNew(['devlog', 'Dust collection', '--config', config]);
    assert.equal(result.code, 0, result.err);
    assert.equal(
      readFileSync(join(dir, 'content', 'devlog', 'dust-collection', 'index.md'), 'utf8'),
      `---
title: Dust collection
date: 2026-06-01 12:30
tags: []
draft: true
---

Intro for Dust collection.

## What happened

Slug: dust-collection, 2026-06-01 12:30
`,
    );
  });
});

test('a missing newPostTemplate file is reported and nothing is written', async () => {
  await withProject(async (dir) => {
    const config = join(dir, 'coffer.yaml');
    writeFileSync(
      config,
      readFileSync(config, 'utf8').replace(
        '{ id: devlog, dir: content/devlog, prefix: devlog }',
        '{ id: devlog, dir: content/devlog, prefix: devlog, newPostTemplate: gone.md }',
      ),
    );
    const result = await runNew(['devlog', 'Title', '--config', config]);
    assert.equal(result.code, 1);
    assert.match(result.err, /gone\.md: newPostTemplate: file not found/);
    assert.equal(existsSync(join(dir, 'content', 'devlog', 'title')), false);
  });
});

test('createPost throws a NewPostError that lists every problem', () => {
  assert.throws(
    () => createPost({ blog: { id: 'b', dir: join(tmpdir(), 'coffer-never'), prefix: 'b', title: 'B' }, timezone: 'UTC', title: ' ', date: 'x', tags: ['!'] }),
    (error) => error instanceof NewPostError && error.errors.length === 4,
  );
});

test('parseNewArgs reads the blog, the title and the options', () => {
  assert.deepEqual(parseNewArgs(['devlog', 'A title', '--tags=a,b', '--date', '2026-01-02']), {
    blog: 'devlog',
    title: 'A title',
    tags: ['a', 'b'],
    date: '2026-01-02',
  });
  assert.deepEqual(parseNewArgs(['devlog']), { error: 'new needs a title: coffer new <blog> "Title"' });
  assert.deepEqual(parseNewArgs([]), { error: 'new needs a blog and a title: coffer new <blog> "Title"' });
  assert.deepEqual(parseNewArgs(['b', 'two', 'words']), {
    error: 'unexpected argument "words" (put a title with spaces in quotes)',
  });
  assert.deepEqual(parseNewArgs(['b', 't', '--date']), { error: '--date needs a value' });
  assert.deepEqual(parseNewArgs(['b', 't', '--nope', 'x']), { error: 'unexpected argument "--nope"' });
});
