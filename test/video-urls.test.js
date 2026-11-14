import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as engine from '../src/index.js';
import { matchVideoUrl, resolveVideoRules } from '../src/video/rules.js';
import {
  embedUrl,
  metadataUrl,
  patternGroupNames,
  templateProblem,
  thumbnailUrl,
  watchUrl,
} from '../src/video/urls.js';

/** @typedef {import('../src/video/rules.js').VideoRule} VideoRule */
/** @typedef {import('../src/video/rules.js').VideoMatch} VideoMatch */
/** @typedef {import('../src/video/rules.js').GenericProvider} GenericProvider */

test('the engine entry point exports the URL builders', () => {
  assert.equal(engine.embedUrl, embedUrl);
  assert.equal(engine.watchUrl, watchUrl);
  assert.equal(engine.metadataUrl, metadataUrl);
  assert.equal(engine.thumbnailUrl, thumbnailUrl);
});

const RULES = resolveVideoRules({
  load: 'click',
  fetchPreviews: true,
  builtinRules: true,
  peertubeHosts: ['video.example.org'],
  rules: [],
});

/**
 * @param {string} url
 * @param {readonly VideoRule[]} [rules]
 * @returns {VideoMatch}
 */
function match(url, rules = RULES) {
  const found = matchVideoUrl(url, rules);
  assert.ok(found, `${url} matches`);
  return found;
}

const Y = match('https://youtu.be/aBcD3fGh1_-');
const V = match('https://vimeo.com/76979871');
const VH = match('https://vimeo.com/76979871/0a1b2c3d4e');
const P = match('https://video.example.org/w/9c9de5e8-0a1b-4d6c-9f2a-3b4c5d6e7f80');
const R = match('https://rutube.ru/video/0123456789abcdef0123456789abcdef/');
const K = match('https://vk.com/video_ext.php?oid=-12345&id=456239017&hash=a1b2c3d4e5f60718');

/** Vector 15.4 of the video spec. @type {[string, () => string | null, string | null][]} */
const BUILDERS = [
  [
    'embedUrl(Y, {start: null, end: null, autoplay: false})',
    () => embedUrl(Y, { start: null, end: null, autoplay: false }),
    'https://www.youtube-nocookie.com/embed/aBcD3fGh1_-',
  ],
  [
    'embedUrl(Y, {start: 83, end: null, autoplay: false})',
    () => embedUrl(Y, { start: 83, end: null, autoplay: false }),
    'https://www.youtube-nocookie.com/embed/aBcD3fGh1_-?start=83',
  ],
  [
    'embedUrl(Y, {start: 30, end: 95, autoplay: true})',
    () => embedUrl(Y, { start: 30, end: 95, autoplay: true }),
    'https://www.youtube-nocookie.com/embed/aBcD3fGh1_-?start=30&end=95&autoplay=1',
  ],
  [
    'embedUrl(Y, {start: null, end: null, autoplay: true})',
    () => embedUrl(Y, { start: null, end: null, autoplay: true }),
    'https://www.youtube-nocookie.com/embed/aBcD3fGh1_-?autoplay=1',
  ],
  [
    'embedUrl(V, {start: null, end: null, autoplay: false})',
    () => embedUrl(V, { start: null, end: null, autoplay: false }),
    'https://player.vimeo.com/video/76979871?dnt=1',
  ],
  [
    'embedUrl(VH, {start: 65, end: null, autoplay: true})',
    () => embedUrl(VH, { start: 65, end: null, autoplay: true }),
    'https://player.vimeo.com/video/76979871?h=0a1b2c3d4e&dnt=1&autoplay=1#t=65s',
  ],
  [
    'embedUrl(P, {start: 60, end: 120, autoplay: false})',
    () => embedUrl(P, { start: 60, end: 120, autoplay: false }),
    'https://video.example.org/videos/embed/9c9de5e8-0a1b-4d6c-9f2a-3b4c5d6e7f80?start=60&stop=120',
  ],
  [
    'embedUrl(R, {start: 42, end: null, autoplay: true})',
    () => embedUrl(R, { start: 42, end: null, autoplay: true }),
    'https://rutube.ru/play/embed/0123456789abcdef0123456789abcdef/?t=42&autoplay=1',
  ],
  [
    'embedUrl(K, {start: null, end: null, autoplay: true})',
    () => embedUrl(K, { start: null, end: null, autoplay: true }),
    'https://vkvideo.ru/video_ext.php?oid=-12345&id=456239017&hash=a1b2c3d4e5f60718&autoplay=1',
  ],
  ['watchUrl(Y, 83)', () => watchUrl(Y, 83), 'https://www.youtube.com/watch?v=aBcD3fGh1_-&t=83s'],
  ['watchUrl(Y, 0)', () => watchUrl(Y, 0), 'https://www.youtube.com/watch?v=aBcD3fGh1_-'],
  ['watchUrl(VH, 65)', () => watchUrl(VH, 65), 'https://vimeo.com/76979871/0a1b2c3d4e#t=65s'],
  [
    'watchUrl(P, 60)',
    () => watchUrl(P, 60),
    'https://video.example.org/w/9c9de5e8-0a1b-4d6c-9f2a-3b4c5d6e7f80?start=60',
  ],
  ['watchUrl(R, 42)', () => watchUrl(R, 42), 'https://rutube.ru/video/0123456789abcdef0123456789abcdef/?t=42'],
  ['watchUrl(K, null)', () => watchUrl(K, null), 'https://vkvideo.ru/video-12345_456239017'],
  [
    'metadataUrl(Y)',
    () => metadataUrl(Y),
    'https://www.youtube.com/oembed?format=json&url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DaBcD3fGh1_-',
  ],
  [
    'metadataUrl(VH)',
    () => metadataUrl(VH),
    'https://vimeo.com/api/oembed.json?url=https%3A%2F%2Fvimeo.com%2F76979871%2F0a1b2c3d4e',
  ],
  [
    'metadataUrl(P)',
    () => metadataUrl(P),
    'https://video.example.org/services/oembed?format=json&url=https%3A%2F%2Fvideo.example.org%2Fw%2F9c9de5e8-0a1b-4d6c-9f2a-3b4c5d6e7f80',
  ],
  [
    'metadataUrl(R)',
    () => metadataUrl(R),
    'https://rutube.ru/api/video/0123456789abcdef0123456789abcdef/?format=json',
  ],
  ['metadataUrl(K)', () => metadataUrl(K), null],
  ['thumbnailUrl(Y)', () => thumbnailUrl(Y), null],
];

for (const [call, run, expected] of BUILDERS) {
  test(`vector 15.4: ${call}`, () => {
    assert.equal(run(), expected);
  });
}

/** The generic provider of the example in section 7 of the video spec. @type {GenericProvider} */
const EXAMPLE_TUBE = {
  name: 'Example Tube',
  embed: 'https://player.tube.example/e/{id}',
  watch: 'https://tube.example/v/{id}',
  startParam: 't',
  endParam: null,
  autoplayParam: 'autoplay',
  thumbnail: 'https://img.tube.example/{id}/cover.jpg',
  oembed: null,
};

/** @type {VideoRule} */
const EXAMPLE_RULE = {
  pattern: 'https://tube\\.example/v/(?<id>[a-z0-9]{8})(?:[?#].*)?',
  flags: '',
  provider: 'generic',
  generic: EXAMPLE_TUBE,
};

const G = match('https://tube.example/v/abcd1234?t=15', [EXAMPLE_RULE]);

test('vector 15.5: the builders of the generic match G', () => {
  assert.equal(embedUrl(G, { start: 15, end: null, autoplay: true }), 'https://player.tube.example/e/abcd1234?t=15&autoplay=1');
  assert.equal(watchUrl(G, 15), 'https://tube.example/v/abcd1234?t=15');
  assert.equal(thumbnailUrl(G), 'https://img.tube.example/abcd1234/cover.jpg');
  assert.equal(metadataUrl(G), null);
});

test('a start of 0 counts as no start', () => {
  assert.equal(embedUrl(Y, { start: 0, end: null, autoplay: false }), 'https://www.youtube-nocookie.com/embed/aBcD3fGh1_-');
  assert.equal(embedUrl(VH, { start: 0, end: null, autoplay: false }), 'https://player.vimeo.com/video/76979871?h=0a1b2c3d4e&dnt=1');
  assert.equal(watchUrl(R, 0), 'https://rutube.ru/video/0123456789abcdef0123456789abcdef/');
  assert.equal(watchUrl(G, 0), 'https://tube.example/v/abcd1234');
});

test('a time for a capability the provider lacks is ignored', () => {
  assert.equal(embedUrl(V, { start: null, end: 95, autoplay: false }), 'https://player.vimeo.com/video/76979871?dnt=1');
  assert.equal(
    embedUrl(R, { start: 42, end: 95, autoplay: false }),
    'https://rutube.ru/play/embed/0123456789abcdef0123456789abcdef/?t=42',
  );
  assert.equal(
    embedUrl(K, { start: 30, end: 95, autoplay: false }),
    'https://vkvideo.ru/video_ext.php?oid=-12345&id=456239017&hash=a1b2c3d4e5f60718',
  );
  assert.equal(watchUrl(K, 30), 'https://vkvideo.ru/video-12345_456239017');
  assert.equal(embedUrl(G, { start: 15, end: 95, autoplay: false }), 'https://player.tube.example/e/abcd1234?t=15');

  /** @type {VideoRule} */
  const bare = {
    ...EXAMPLE_RULE,
    generic: { ...EXAMPLE_TUBE, startParam: null, autoplayParam: null },
  };
  const plain = match('https://tube.example/v/abcd1234', [bare]);
  assert.equal(embedUrl(plain, { start: 15, end: 95, autoplay: true }), 'https://player.tube.example/e/abcd1234');
  assert.equal(watchUrl(plain, 15), 'https://tube.example/v/abcd1234');
});

test('built-in templates leave out optional groups that did not take part', () => {
  const vk = match('https://vkvideo.ru/video-12345_456239017');
  assert.equal(embedUrl(vk, { start: null, end: null, autoplay: false }), 'https://vkvideo.ru/video_ext.php?oid=-12345&id=456239017');
  assert.equal(
    embedUrl(V, { start: 65, end: null, autoplay: false }),
    'https://player.vimeo.com/video/76979871?dnt=1#t=65s',
  );
  assert.equal(watchUrl(V, 65), 'https://vimeo.com/76979871#t=65s');
  assert.equal(metadataUrl(V), 'https://vimeo.com/api/oembed.json?url=https%3A%2F%2Fvimeo.com%2F76979871');
  assert.equal(
    embedUrl(P, { start: null, end: 120, autoplay: true }),
    'https://video.example.org/videos/embed/9c9de5e8-0a1b-4d6c-9f2a-3b4c5d6e7f80?stop=120&autoplay=1',
  );
  assert.equal(
    embedUrl(R, { start: null, end: null, autoplay: true }),
    'https://rutube.ru/play/embed/0123456789abcdef0123456789abcdef/?autoplay=1',
  );
});

test('built-in templates write group values with encodeURIComponent', () => {
  /** @type {VideoRule} */
  const loose = { pattern: 'https://yt\\.example/(?<id>.+)', flags: '', provider: 'youtube', generic: null };
  const odd = match('https://yt.example/a b&c', [loose]);
  assert.equal(embedUrl(odd, { start: null, end: null, autoplay: false }), 'https://www.youtube-nocookie.com/embed/a%20b%26c');
  assert.equal(watchUrl(odd, null), 'https://www.youtube.com/watch?v=a%20b%26c');
});

test('generic templates expand groups, the end parameter and {url} in oembed', () => {
  /** @type {VideoRule} */
  const rule = {
    pattern: 'https://clips\\.example/(?<channel>[a-z]+)/(?<id>[^/?#]+)(?:/(?<part>\\d+))?(?:[?#].*)?',
    flags: '',
    provider: 'generic',
    generic: {
      name: 'Clips',
      embed: 'https://clips.example/embed?c={channel}&v={id}&p={part}',
      watch: 'https://clips.example/{channel}/{id}',
      startParam: 'from',
      endParam: 'to',
      autoplayParam: 'play',
      thumbnail: null,
      oembed: 'https://clips.example/oembed?url={url}&id={id}',
    },
  };
  const clip = match('https://clips.example/news/a&b?from=10&to=20', [rule]);
  assert.deepEqual(clip.groups, { channel: 'news', id: 'a&b' });
  assert.equal(
    embedUrl(clip, { start: 10, end: 20, autoplay: true }),
    'https://clips.example/embed?c=news&v=a%26b&p=&from=10&to=20&play=1',
  );
  assert.equal(watchUrl(clip, 10), 'https://clips.example/news/a%26b?from=10');
  assert.equal(
    metadataUrl(clip),
    'https://clips.example/oembed?url=https%3A%2F%2Fclips.example%2Fnews%2Fa%2526b&id=a%26b',
  );
  assert.equal(thumbnailUrl(clip), null);
});

test('patternGroupNames lists the named groups of a pattern source', () => {
  assert.deepEqual(patternGroupNames(EXAMPLE_RULE.pattern), ['id']);
  assert.deepEqual(patternGroupNames(RULES[0].pattern), ['host', 'id']);
  assert.deepEqual(
    patternGroupNames('(?<oid>-?\\d+)_(?<id>\\d+)(?:&hash=(?<hash>[0-9a-f]+))?'),
    ['oid', 'id', 'hash'],
  );
  assert.deepEqual(patternGroupNames('(?<=a)(?<!b)(?<id>x)'), ['id']);
  assert.deepEqual(patternGroupNames('\\(?<no>x)(?<id>y)'), ['id']);
  assert.deepEqual(patternGroupNames('\\\\(?<id>y)'), ['id']);
  assert.deepEqual(patternGroupNames('[(?<no>](?<id>y)'), ['id']);
  assert.deepEqual(patternGroupNames('[\\](?<no>](?<id>y)'), ['id']);
  assert.deepEqual(patternGroupNames('(?<id>a)|(?<id>b)'), ['id']);
  assert.deepEqual(patternGroupNames('plain'), []);
});

test('templateProblem accepts valid templates', () => {
  const groups = ['id', 'host'];
  assert.equal(templateProblem('https://player.tube.example/e/{id}', groups, 'embed'), null);
  assert.equal(templateProblem('https://{host}/w/{id}?x=1', groups, 'watch'), null);
  assert.equal(templateProblem('https://img.example/{id}/cover.jpg', groups, 'thumbnail'), null);
  assert.equal(templateProblem('https://tube.example/oembed?url={url}', groups, 'oembed'), null);
});

test('templateProblem requires an https address without a fragment', () => {
  const problem = 'must be an https address without a fragment';
  assert.equal(templateProblem('http://tube.example/e/{id}', ['id'], 'embed'), problem);
  assert.equal(templateProblem('https://tube.example/e/{id}#t', ['id'], 'embed'), problem);
  assert.equal(templateProblem('tube.example/e/{id}', ['id'], 'watch'), problem);
  assert.equal(templateProblem('https://', ['id'], 'thumbnail'), problem);
});

test('templateProblem names a placeholder that is not a named group', () => {
  assert.equal(
    templateProblem('https://tube.example/e/{video}', ['id'], 'embed'),
    '{video} is not a named group of the pattern',
  );
  for (const key of /** @type {const} */ (['embed', 'watch', 'thumbnail'])) {
    assert.equal(
      templateProblem('https://tube.example/e?u={url}', ['id'], key),
      '{url} is not a named group of the pattern',
    );
  }
});

test('templateProblem rejects braces outside a placeholder', () => {
  const problem = 'must not contain "{" or "}" outside a placeholder';
  assert.equal(templateProblem('https://tube.example/e/{id', ['id'], 'embed'), problem);
  assert.equal(templateProblem('https://tube.example/e/id}', ['id'], 'watch'), problem);
  assert.equal(templateProblem('https://tube.example/e/{1d}', ['id'], 'oembed'), problem);
  assert.equal(templateProblem('https://tube.example/e/{}', ['id'], 'thumbnail'), problem);
  assert.equal(templateProblem('https://{tube.example/e/{id}', ['id'], 'embed'), problem);
});
