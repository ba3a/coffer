import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BuildError, buildSites } from '../src/build.js';
import { loadConfig } from '../src/config.js';
import { MarkdownError } from '../src/markdown/render.js';

const NOW = new Date('2026-06-01T12:00:00Z');

/** Bytes that are not valid UTF-8, so a copy that decodes them would change them. */
const CLIP = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0xff, 0xfe, 0x80, 0x0a, 0x0d]);

/**
 * Writes a tree of files, runs `body` with its root, and removes the tree.
 *
 * @template T
 * @param {Record<string, string | Uint8Array>} files Relative path (forward slashes) to content.
 * @param {(root: string) => Promise<T>} body
 * @returns {Promise<T>}
 */
async function inTree(files, body) {
  const root = mkdtempSync(join(tmpdir(), 'coffer-video-build-'));
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

const CONFIG = [
  'sites:',
  '  - id: demo',
  '    baseUrl: https://demo.example',
  '    lang: en',
  '    title: Demo',
  '    contentLicense: Some rights reserved',
  '    contentDir: notes',
  '    blogs:',
  '      - { id: notes, dir: notes, prefix: log, title: Notes }',
  '',
].join('\n');

/**
 * A post whose body starts on line 6, plus one line for each line of `extra`.
 *
 * @param {string} body
 * @param {string} [extra] More front matter lines.
 * @returns {string}
 */
function post(body, extra = '') {
  return `---\ntitle: Glue-up\ndate: 2026-05-01\n${extra}---\n\n${body}\n`;
}

/** @param {string} root */
function build(root) {
  return buildSites(loadConfig({ configPath: join(root, 'coffer.yaml') }), { out: join(root, 'out'), now: NOW });
}

test('a local video is published under its normalised name in the folder of the post, unchanged', async () => {
  await inTree(
    {
      'coffer.yaml': CONFIG,
      'notes/glue/index.md': post('::video{src="Glue Up.MP4"}\n\nThe clamps go on.', 'index: full\n'),
      'notes/glue/Glue Up.MP4': CLIP,
    },
    async (root) => {
      const [result] = await build(root);
      const published = join(result.outDir, 'log', 'glue', 'glue-up.mp4');
      assert.ok(existsSync(published));
      assert.deepEqual(readFileSync(published), CLIP);
      assert.ok(!existsSync(join(result.outDir, 'log', 'glue', 'Glue Up.MP4')));
      assert.deepEqual(result.warnings, []);
    },
  );
});

test('a local video of a single-file post is resolved beside the Markdown file and published in the folder of the post', async () => {
  await inTree(
    {
      'coffer.yaml': CONFIG,
      'notes/clip.md': post('::video{src="clips/__My  Clip (2).WebM"}'),
      'notes/clips/__My  Clip (2).WebM': CLIP,
    },
    async (root) => {
      const [result] = await build(root);
      assert.deepEqual(readFileSync(join(result.outDir, 'log', 'clip', 'my-clip-2.webm')), CLIP);
    },
  );
});

test('a local video whose stem has no a-z or 0-9 is published as video', async () => {
  await inTree(
    {
      'coffer.yaml': CONFIG,
      'notes/glue/index.md': post('::video{src="Склейка.mp4"}'),
      'notes/glue/Склейка.mp4': CLIP,
    },
    async (root) => {
      const [result] = await build(root);
      assert.deepEqual(readFileSync(join(result.outDir, 'log', 'glue', 'video.mp4')), CLIP);
    },
  );
});

test('the same local video used twice is published once', async () => {
  await inTree(
    {
      'coffer.yaml': CONFIG,
      'notes/glue/index.md': post('::video{src="Glue Up.MP4"}\n\n::video{src="Glue%20Up.MP4" id="again"}', 'index: full\n'),
      'notes/glue/Glue Up.MP4': CLIP,
    },
    async (root) => {
      const [result] = await build(root);
      const files = readdirSync(join(result.outDir, 'log', 'glue')).filter((name) => name.endsWith('.mp4'));
      assert.deepEqual(files, ['glue-up.mp4']);
    },
  );
});

test('two local videos of a post with the same published name fail the build, naming both', async () => {
  await inTree(
    {
      'coffer.yaml': CONFIG,
      'notes/glue/index.md': post('::video{src="Glue Up.mp4"}\n\n::video{src="glue-up.mp4"}'),
      'notes/glue/Glue Up.mp4': CLIP,
      'notes/glue/glue-up.mp4': CLIP,
    },
    async (root) => {
      await assert.rejects(build(root), (error) => {
        assert.ok(error instanceof BuildError);
        assert.match(error.message, /notes\/glue\/Glue Up\.mp4/);
        assert.match(error.message, /notes\/glue\/glue-up\.mp4/);
        assert.match(error.message, /\/log\/glue\/glue-up\.mp4/);
        return true;
      });
    },
  );
});

test('a missing local video fails the build with V6 at the directive in the post file', async () => {
  await inTree(
    {
      'coffer.yaml': CONFIG,
      'notes/missing.md': post('Before.\n\n::video{src="gone.mp4"}'),
    },
    async (root) => {
      await assert.rejects(build(root), (error) => {
        assert.ok(error instanceof MarkdownError);
        assert.match(error.message, /missing\.md:8:1: local video "gone\.mp4" does not exist$/);
        return true;
      });
    },
  );
});

test('a local video outside the content directory does not exist for the post', async () => {
  await inTree(
    {
      'coffer.yaml': CONFIG,
      'notes/outside.md': post('::video{src="../clip.mp4"}'),
      'clip.mp4': CLIP,
    },
    async (root) => {
      await assert.rejects(
        build(root),
        (error) => error instanceof MarkdownError && /outside\.md:6:1: local video "\.\.\/clip\.mp4" does not exist$/.test(error.message),
      );
    },
  );
});

test('W1 to W4 of a post are build warnings with the file, line and column, reported once', async () => {
  const body = [
    '::video{src="https://vkvideo.ru/video-12345_456239017" start="5" end="1:00"}',
    '',
    ':::video{src="https://vkvideo.ru/video-12345_456239017"}',
    '- 0:00 Intro',
    '- 1:00 Cut',
    ':::',
    '',
    'See :t[0:30].',
  ].join('\n');
  await inTree(
    {
      'coffer.yaml': CONFIG,
      'notes/vk.md': post(body, 'index: full\n'),
    },
    async (root) => {
      const [result] = await build(root);
      assert.deepEqual(result.warnings, [
        'notes/vk.md:7:1: VK Video videos cannot start at a given time; start="5" is ignored',
        'notes/vk.md:7:1: VK Video videos cannot stop at a given time; end="1:00" is ignored',
        'notes/vk.md:9:1: VK Video videos cannot seek to a time; the chapters are shown without links',
        'notes/vk.md:14:5: VK Video videos cannot seek to a time; the seek link is shown as text',
      ]);
    },
  );
});

test('feeds, the meta description and the share summary of a post with a video hold no placeholder', async () => {
  const config = CONFIG.replace(
    '{ id: notes, dir: notes, prefix: log, title: Notes }',
    '{ id: notes, dir: notes, prefix: log, title: Notes, shareSummary: true }',
  );
  await inTree(
    {
      'coffer.yaml': config,
      'notes/remote.md': post('https://youtu.be/aBcD3fGh1_-\n\nThe dovetails come next.', 'tags: [wood]\n'),
    },
    async (root) => {
      const [result] = await build(root);
      for (const feed of [['log', 'feed.xml'], ['log', 'tags', 'wood', 'feed.xml']]) {
        const xml = readFileSync(join(result.outDir, ...feed), 'utf8');
        assert.match(xml, /The dovetails come next\./);
        assert.doesNotMatch(xml, /data-coffer-video/);
      }
      const page = readFileSync(join(result.outDir, 'log', 'remote', 'index.html'), 'utf8');
      assert.match(page, /<meta name="description" content="The dovetails come next\.">/);
      const share = readFileSync(join(result.outDir, 'log', 'remote', 'share.txt'), 'utf8');
      assert.match(share, /The dovetails come next\./);
      assert.doesNotMatch(share, /data-coffer-video/);
    },
  );
});
