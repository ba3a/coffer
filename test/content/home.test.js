import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_LATEST_POSTS,
  HOME_FILE_NAME,
  HomeError,
  loadHome,
  parseHomeSource,
} from '../../src/content/home.js';

const FILE = '/site/content/home.md';

test('a home page has a title, the about text and defaults for the rest', () => {
  const home = parseHomeSource(FILE, '---\ntitle: Hello\n---\n\nAbout me.\n');
  assert.equal(home.title, 'Hello');
  assert.equal(home.latestPosts, DEFAULT_LATEST_POSTS);
  assert.deepEqual(home.secondaryLinks, []);
  assert.equal(home.body.trim(), 'About me.');
  assert.equal(home.bodyLine, 4);
  assert.equal(home.file, FILE);
});

test('latestPosts and secondaryLinks are read from the front matter', () => {
  const home = parseHomeSource(
    FILE,
    [
      '---',
      'title: Hello',
      'latestPosts: 3',
      'secondaryLinks:',
      '  - { label: Personal blog, url: "https://my.example" }',
      '  - { label: Mail, url: "mailto:me@example.com" }',
      '  - { label: Local, url: "/about/" }',
      '---',
      '',
    ].join('\n'),
  );
  assert.equal(home.latestPosts, 3);
  assert.deepEqual(home.secondaryLinks, [
    { label: 'Personal blog', url: 'https://my.example' },
    { label: 'Mail', url: 'mailto:me@example.com' },
    { label: 'Local', url: '/about/' },
  ]);
  assert.equal(parseHomeSource(FILE, '---\ntitle: T\nlatestPosts: 0\n---\n').latestPosts, 0);
});

test('every problem is reported with the file and the field', () => {
  assert.throws(
    () =>
      parseHomeSource(
        FILE,
        [
          '---',
          'latestPosts: 2.5',
          'colour: red',
          'secondaryLinks:',
          '  - { label: A, url: "ftp://x.example" }',
          '  - { url: "https://x.example" }',
          '  - just text',
          '---',
          '',
        ].join('\n'),
      ),
    (error) => {
      assert.ok(error instanceof HomeError);
      const text = error.errors.join('\n');
      assert.match(text, /home\.md: title: is required/);
      assert.match(text, /home\.md: latestPosts: must be a whole number from 0 to 50/);
      assert.match(text, /home\.md: colour: unknown key/);
      assert.match(text, /secondaryLinks\[0\]\.url: must be an http\(s\) or mailto: URL/);
      assert.match(text, /secondaryLinks\[1\]\.label: is required/);
      assert.match(text, /secondaryLinks\[2\]: must be a mapping/);
      return true;
    },
  );
  assert.throws(() => parseHomeSource(FILE, '# no front matter\n'), /front matter: missing/);
  assert.throws(() => parseHomeSource(FILE, '---\ntitle: T\nlatestPosts: 99\n---\n'), /latestPosts/);
  assert.throws(
    () => parseHomeSource(FILE, '---\ntitle: T\nsecondaryLinks: x\n---\n'),
    /secondaryLinks: must be a list/,
  );
});

test('loadHome reads home.md from the content directory, or returns null without one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coffer-home-'));
  try {
    assert.equal(loadHome(dir), null);
    assert.equal(HOME_FILE_NAME, 'home.md');
    writeFileSync(join(dir, HOME_FILE_NAME), '---\ntitle: Here\n---\n\nText.\n');
    assert.equal(loadHome(dir)?.title, 'Here');
    rmSync(join(dir, HOME_FILE_NAME));
    mkdirSync(join(dir, HOME_FILE_NAME));
    assert.throws(() => loadHome(dir), /must be a file/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
