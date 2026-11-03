import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSites } from '../src/build.js';
import { loadConfig } from '../src/config.js';

const exampleDir = fileURLToPath(new URL('../example/', import.meta.url));

/** After the example's posts and before its future-dated one. */
const NOW = new Date('2026-06-01T12:00:00Z');

/**
 * Copies the example site (without a previous build) into a temporary
 * directory, runs `body` with the copy's root and removes it.
 *
 * @param {(root: string) => Promise<void>} body
 */
async function withExampleCopy(body) {
  const root = mkdtempSync(join(tmpdir(), 'coffer-series-'));
  try {
    cpSync(exampleDir, root, { recursive: true, filter: (source) => !/[\\/]dist([\\/]|$)/.test(source) });
    await body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * @param {string} root
 * @returns {Promise<import('../src/build.js').SiteResult>}
 */
async function build(root) {
  const [result] = await buildSites(loadConfig({ configPath: join(root, 'coffer.yaml') }), {
    out: join(root, 'dist'),
    now: NOW,
  });
  return result;
}

/**
 * @param {import('../src/build.js').SiteResult} result
 * @param {string} url
 * @returns {string}
 */
function page(result, url) {
  return readFileSync(join(result.outDir, ...url.split('/').filter(Boolean), 'index.html'), 'utf8');
}

/**
 * The text of the series blocks of a post page: the top one, then the one at the end.
 *
 * @param {string} html
 * @returns {string[]}
 */
function blocks(html) {
  return [...html.matchAll(/<nav class="series-nav [^>]*>([\s\S]*?)<\/nav>/g)].map((match) =>
    match[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
  );
}

test('the example site has a two-part series, with navigation and a series page', async () => {
  await withExampleCopy(async (root) => {
    const result = await build(root);
    const one = blocks(page(result, '/journal/first-dovetail/'));
    const two = blocks(page(result, '/journal/walnut-box/'));
    assert.equal(one.length, 2);
    assert.equal(two.length, 2);
    assert.match(one[0], /^Boxes by hand Part 1 of 2 Next part A walnut keepsake box$/);
    assert.match(one[1], /^Boxes by hand Part 1 of 2 Next part A walnut keepsake box$/);
    assert.match(two[0], /^Boxes by hand Part 2 of 2 Previous part My first hand-cut dovetail$/);
    assert.match(two[1], /^Boxes by hand Part 2 of 2 Previous part My first hand-cut dovetail$/);

    const series = page(result, '/journal/series/boxes-by-hand/');
    assert.match(series, /<h1>Boxes by hand<\/h1>/);
    assert.ok(
      series.indexOf('/journal/first-dovetail/') < series.indexOf('/journal/walnut-box/'),
      'parts are listed in order',
    );
    assert.deepEqual(blocks(page(result, '/journal/mountain-weekend/')), []);
  });
});

test('adding a third part updates the navigation of the earlier parts without editing them', async () => {
  await withExampleCopy(async (root) => {
    const first = join(root, 'content', 'journal', 'first-dovetail', 'index.md');
    const second = join(root, 'content', 'journal', 'walnut-box.md');
    const before = [readFileSync(first, 'utf8'), readFileSync(second, 'utf8')];

    const initial = await build(root);
    assert.match(blocks(page(initial, '/journal/first-dovetail/'))[0], /Part 1 of 2/);
    assert.match(blocks(page(initial, '/journal/walnut-box/'))[0], /Part 2 of 2/);
    assert.doesNotMatch(blocks(page(initial, '/journal/walnut-box/'))[0], /Next part/);

    writeFileSync(
      join(root, 'content', 'journal', 'oak-shelf.md'),
      '---\ntitle: An oak shelf to hold the boxes\ndate: 2025-05-20\nseries: boxes-by-hand\n---\n\nThe boxes needed a home.\n',
    );
    const rebuilt = await build(root);

    // The earlier posts are byte for byte what they were.
    assert.deepEqual([readFileSync(first, 'utf8'), readFileSync(second, 'utf8')], before);

    for (const block of blocks(page(rebuilt, '/journal/first-dovetail/'))) {
      assert.match(block, /Part 1 of 3/);
      assert.match(block, /Next part A walnut keepsake box/);
    }
    for (const block of blocks(page(rebuilt, '/journal/walnut-box/'))) {
      assert.match(block, /Part 2 of 3/);
      assert.match(block, /Previous part My first hand-cut dovetail/);
      assert.match(block, /Next part An oak shelf to hold the boxes/);
    }
    assert.match(page(rebuilt, '/journal/walnut-box/'), /<a rel="next" href="\/journal\/oak-shelf\/">/);
    for (const block of blocks(page(rebuilt, '/journal/oak-shelf/'))) {
      assert.match(block, /Part 3 of 3/);
      assert.match(block, /Previous part A walnut keepsake box/);
      assert.doesNotMatch(block, /Next part/);
    }

    const list = page(rebuilt, '/journal/series/boxes-by-hand/');
    assert.match(list, /3 parts/);
    assert.ok(list.indexOf('/journal/walnut-box/') < list.indexOf('/journal/oak-shelf/'));
    assert.deepEqual(
      rebuilt.manifest.series.map((entry) => [entry.slug, entry.count]),
      [['boxes-by-hand', 3]],
    );
  });
});

test('a series can be created after the fact by adding the field to older posts', async () => {
  await withExampleCopy(async (root) => {
    const journal = join(root, 'content', 'journal');
    const plain = await build(root);
    assert.deepEqual(blocks(page(plain, '/journal/mountain-weekend/')), []);
    assert.equal(readdirSync(join(plain.outDir, 'journal')).includes('series'), true, 'the example series exists');

    // The two older posts join a new series; the dovetail post keeps its own.
    const trip = join(journal, 'mountain-weekend.md');
    writeFileSync(trip, readFileSync(trip, 'utf8').replace('tags: [trips/mountains]', 'tags: [trips/mountains]\nseries: hills'));
    writeFileSync(
      join(journal, 'second-weekend.md'),
      '---\ntitle: Another weekend in the hills\ndate: 2025-03-01\nseries: hills\n---\n\nBack to the same hills.\n',
    );
    const rebuilt = await build(root);

    // Part order follows the dates: the 20 February post is first, the 1 March one second.
    const early = blocks(page(rebuilt, '/journal/mountain-weekend/'));
    assert.equal(early.length, 2);
    assert.match(early[0], /^hills Part 1 of 2 Next part Another weekend in the hills$/);
    const late = blocks(page(rebuilt, '/journal/second-weekend/'));
    assert.match(late[0], /^hills Part 2 of 2 Previous part A long weekend in the hills$/);
    assert.match(page(rebuilt, '/journal/series/hills/'), /<h1>hills<\/h1>/);

    // Explicit positions reverse the order without touching the dates.
    writeFileSync(trip, readFileSync(trip, 'utf8').replace('series: hills', 'series: hills\nseriesPosition: 2'));
    const other = join(journal, 'second-weekend.md');
    writeFileSync(other, readFileSync(other, 'utf8').replace('series: hills', 'series: hills\nseriesPosition: 1'));
    const reordered = await build(root);
    assert.match(blocks(page(reordered, '/journal/mountain-weekend/'))[0], /^hills Part 2 of 2 Previous part/);
    assert.match(blocks(page(reordered, '/journal/second-weekend/'))[0], /^hills Part 1 of 2 Next part A long weekend/);
  });
});
