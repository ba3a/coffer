// Guards the documentation of videos: the page exists, is linked where the
// other pages are, its examples are valid, and the pages it touches mention it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';

import { normalizeConfig } from '../src/config.js';
import { renderMarkdown } from '../src/markdown/render.js';
import { PROVIDER_NAMES, resolveVideoRules } from '../src/video/rules.js';

const root = fileURLToPath(new URL('..', import.meta.url));

/**
 * @param {string} name Path relative to the engine's root, with forward slashes.
 * @returns {string}
 */
const read = (name) => readFileSync(join(root, ...name.split('/')), 'utf8').replace(/\r\n/g, '\n');

/**
 * The fenced code blocks of a Markdown text with the given language.
 *
 * @param {string} text
 * @param {string} language
 * @returns {string[]}
 */
function blocks(text, language) {
  return [...text.matchAll(/^(`{3,})(\S*)\n([\s\S]*?)^\1$/gm)]
    .filter((match) => match[2] === language)
    .map((match) => /** @type {string} */ (match[3]));
}

/**
 * The text of a section of a Markdown page, from its heading to the next
 * heading of the same or a higher level.
 *
 * @param {string} text
 * @param {string} heading The whole heading line, such as `## Result`.
 * @returns {string}
 */
function section(text, heading) {
  const start = text.split('\n').indexOf(heading);
  assert.ok(start !== -1, `no heading "${heading}"`);
  const level = /** @type {string} */ (/^#+/.exec(heading)?.[0]).length;
  const lines = text.split('\n').slice(start + 1);
  const end = lines.findIndex((line) => {
    const hashes = /^(#+)\s/.exec(line);
    return hashes !== null && /** @type {string} */ (hashes[1]).length <= level;
  });
  return (end === -1 ? lines : lines.slice(0, end)).join('\n');
}

/** The site configuration of the example in docs/videos.md, loaded as the build loads it. */
function documentedVideoConfig() {
  const sample = blocks(read('docs/videos.md'), 'yaml').find((block) => /^video:/m.test(block));
  assert.ok(sample, 'docs/videos.md has a YAML example of the video settings');
  const site = { id: 'main', baseUrl: 'https://example.org', title: 'Main', ...parse(sample) };
  return normalizeConfig({ sites: [site] }, { file: resolve(root, 'coffer.yaml') }).sites[0].video;
}

test('docs/videos.md is linked from the documentation index, the README and the Markdown page', () => {
  assert.match(read('docs/README.md'), /\]\(videos\.md\)/);
  assert.match(read('README.md'), /\]\(docs\/videos\.md\)/);
  assert.match(read('docs/markdown.md'), /\]\(videos\.md\)/);
});

test('the configuration example of docs/videos.md is a valid video setting', () => {
  const video = documentedVideoConfig();
  assert.ok(video.rules.length > 0, 'the example shows a rule of the site');
  assert.ok(video.peertubeHosts.length > 0, 'the example shows a PeerTube host');
});

test('every Markdown example of docs/videos.md renders, with the settings of its configuration example', async () => {
  const video = documentedVideoConfig();
  const options = {
    rules: resolveVideoRules(video),
    load: video.load,
    locateFile: (/** @type {string} */ src) => `/journal/walnut-box/${src.toLowerCase()}`,
  };
  const samples = blocks(read('docs/videos.md'), 'markdown');
  assert.ok(samples.length >= 5);
  for (const sample of samples) {
    const result = await renderMarkdown(sample, { file: 'docs/videos.md', video: options });
    assert.ok(result.videos.length > 0 || /\]\(/.test(sample), `an example without a video:\n${sample}`);
  }
});

test('docs/videos.md names every provider and every message of the feature', () => {
  const text = read('docs/videos.md');
  for (const name of Object.values(PROVIDER_NAMES)) assert.ok(text.includes(name), `${name} is not named`);
  for (const message of [
    'a video needs src="..."',
    'a video has no attribute "{name}" (the attributes are src, start, end, poster, load and id)',
    'src="{src}" is not allowed: a video is an http(s) address or a file beside the post',
    '"{src}" is not a video address that any rule knows',
    'a local video must be an .mp4 or .webm file: "{src}"',
    'local video "{src}" does not exist',
    'load must be "click" or "iframe"',
    'load does not apply to a local video',
    'id must start with a lower-case letter and hold only lower-case letters, digits and "-"',
    'two videos have the id "{id}"',
    '{attr}="{value}" is not a timecode (write 83, 1:23, 1:02:03 or 1m23s)',
    'end must be later than start',
    'the body of a video must be one list of chapters',
    'a chapter must start with a timecode, a space and a title',
    'chapters must be in increasing order of time',
    '{time} is not within the part of the video that plays',
    'a seek link needs a timecode in square brackets, or at="..."',
    'a seek link has no attribute "{name}" (the attributes are at and video)',
    'a seek link needs a text in square brackets',
    'a seek link needs a video before it, or video="..."',
    'there is no video with the id "{id}"',
    'poster "{poster}" does not exist',
    '{provider} videos cannot start at a given time; start="{value}" is ignored',
    '{provider} videos cannot stop at a given time; end="{value}" is ignored',
    '{provider} videos cannot seek to a time; the chapters are shown without links',
    '{provider} videos cannot seek to a time; the seek link is shown as text',
    'video "{src}": preview not fetched: {reason}',
  ]) {
    assert.ok(text.includes(message), `docs/videos.md does not show: ${message}`);
  }
});

test('docs/markdown.md lists the video directives, result fields and option', () => {
  const text = read('docs/markdown.md');
  const directives = section(text, '### Directives');
  for (const name of ['`::video`', '`:::video`', '`:t`']) assert.ok(directives.includes(name), `Directives does not name ${name}`);
  assert.match(section(text, '### Video and other embeds'), /\]\(videos\.md\)/);
  const result = section(text, '## Result');
  assert.match(result, /^\| `videos` /m);
  assert.match(result, /^\| `videoWarnings` /m);
  assert.match(section(text, '## Options'), /^\| `video` /m);
});

test('docs/configuration.md has the video key and section', () => {
  const text = read('docs/configuration.md');
  assert.match(section(text, '## Site keys'), /^\| `video` /m);
  const video = section(text, '## `video`');
  for (const key of ['load', 'fetchPreviews', 'builtinRules', 'peertubeHosts', 'rules']) {
    assert.ok(video.includes(`\`${key}\``), `the video section does not describe ${key}`);
  }
  assert.match(video, /\]\(videos\.md/);
});

test('docs/feeds.md and docs/build.md mention videos', () => {
  assert.match(read('docs/feeds.md'), /\]\(videos\.md/);
  assert.match(section(read('docs/build.md'), '## The build manifest'), /`videos`/);
});

test('the changelog lists videos under Added and the lone video address under Changed in Unreleased', () => {
  const text = read('CHANGELOG.md');
  const unreleased = section(text, '## Unreleased');
  assert.match(section(unreleased, '### Added'), /video/i);
  assert.match(section(unreleased, '### Changed'), /video address/i);
});

test('the features section of the landing page lists videos', () => {
  const text = read('site/landing.md');
  const features = text.slice(
    text.indexOf('<div class="section-marker" id="features"></div>'),
    text.indexOf('<div class="section-marker" id="compare"></div>'),
  );
  assert.match(features, /^- \*\*\S+ Videos?\b[^*]*\*\*/m);
});
