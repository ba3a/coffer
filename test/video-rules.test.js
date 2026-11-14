import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as engine from '../src/index.js';
import {
  DEFAULT_VIDEO_RULES,
  PROVIDER_NAMES,
  matchVideoUrl,
  resolveVideoRules,
} from '../src/video/rules.js';

/** @typedef {import('../src/video/rules.js').VideoRule} VideoRule */

test('the engine entry point exports the video rules', () => {
  assert.equal(engine.PROVIDER_NAMES, PROVIDER_NAMES);
  assert.equal(engine.DEFAULT_VIDEO_RULES, DEFAULT_VIDEO_RULES);
  assert.equal(engine.resolveVideoRules, resolveVideoRules);
  assert.equal(engine.matchVideoUrl, matchVideoUrl);
});

test('PROVIDER_NAMES names the built-in providers and is frozen', () => {
  assert.deepEqual(
    { ...PROVIDER_NAMES },
    { youtube: 'YouTube', vimeo: 'Vimeo', peertube: 'PeerTube', rutube: 'Rutube', vkvideo: 'VK Video' },
  );
  assert.ok(Object.isFrozen(PROVIDER_NAMES));
});

test('DEFAULT_VIDEO_RULES holds 8 frozen rules in the order of the spec', () => {
  assert.ok(Object.isFrozen(DEFAULT_VIDEO_RULES));
  assert.deepEqual(
    DEFAULT_VIDEO_RULES.map((rule) => rule.provider),
    ['youtube', 'youtube', 'youtube', 'vimeo', 'vimeo', 'rutube', 'vkvideo', 'vkvideo'],
  );
  for (const rule of DEFAULT_VIDEO_RULES) {
    assert.ok(Object.isFrozen(rule));
    assert.equal(rule.flags, '');
    assert.equal(rule.generic, null);
    assert.ok(!rule.pattern.includes('\\|'), 'patterns contain plain |, not the Markdown escape');
  }
  assert.equal(
    DEFAULT_VIDEO_RULES[0].pattern,
    'https?://(?:www\\.|m\\.)?youtube\\.com/watch\\?(?:[^#]*&)?v=(?<id>[A-Za-z0-9_-]{11})(?:[&#].*)?',
  );
  assert.equal(
    DEFAULT_VIDEO_RULES[7].pattern,
    'https?://(?:www\\.)?(?:vkvideo\\.ru|vk\\.com|vk\\.ru)/video_ext\\.php\\?oid=(?<oid>-?\\d+)&id=(?<id>\\d+)(?:&hash=(?<hash>[0-9a-f]+))?(?:&[^#]*)?(?:#.*)?',
  );
});

/** @type {import('../src/video/rules.js').GenericProvider} */
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

/** The rule of the example in section 7 of the video spec. @type {VideoRule} */
const SITE_RULE = {
  pattern: 'https://tube\\.example/v/(?<id>[a-z0-9]{8})(?:[?#].*)?',
  flags: '',
  provider: 'generic',
  generic: EXAMPLE_TUBE,
};

test('resolveVideoRules puts site rules, then PeerTube hosts, then the defaults', () => {
  const rules = resolveVideoRules({
    load: 'click',
    fetchPreviews: true,
    builtinRules: true,
    peertubeHosts: ['video.example.org', 'tube.example.net'],
    rules: [SITE_RULE],
  });
  assert.equal(rules.length, 1 + 2 + 8);
  assert.equal(rules[0], SITE_RULE);
  assert.deepEqual(rules[1], {
    pattern:
      'https?://(?<host>video\\.example\\.org)/(?:w|videos/watch|videos/embed)/(?<id>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[1-9A-HJ-NP-Za-km-z]{21,22})/?(?:[?#].*)?',
    flags: '',
    provider: 'peertube',
    generic: null,
  });
  assert.equal(rules[2].provider, 'peertube');
  assert.ok(rules[2].pattern.startsWith('https?://(?<host>tube\\.example\\.net)/'));
  assert.deepEqual(rules.slice(3), [...DEFAULT_VIDEO_RULES]);
});

test('resolveVideoRules leaves out the defaults when builtinRules is false', () => {
  const rules = resolveVideoRules({
    load: 'iframe',
    fetchPreviews: false,
    builtinRules: false,
    peertubeHosts: ['video.example.org'],
    rules: [SITE_RULE],
  });
  assert.deepEqual(rules.map((rule) => rule.provider), ['generic', 'peertube']);
  assert.equal(matchVideoUrl('https://youtu.be/aBcD3fGh1_-', rules), null);
});

const RULES = resolveVideoRules({
  load: 'click',
  fetchPreviews: true,
  builtinRules: true,
  peertubeHosts: ['video.example.org'],
  rules: [],
});

/**
 * Vector 15.3 of the video spec: URL, then provider, id, other groups, start
 * and end, or null for no match.
 *
 * @type {[string, [string, string, Record<string, string>, number | null, number | null] | null][]}
 */
const MATCHES = [
  ['https://www.youtube.com/watch?v=aBcD3fGh1_-', ['youtube', 'aBcD3fGh1_-', {}, null, null]],
  ['https://youtube.com/watch?feature=share&v=aBcD3fGh1_-&t=1m30s', ['youtube', 'aBcD3fGh1_-', {}, 90, null]],
  ['https://youtu.be/aBcD3fGh1_-?t=83', ['youtube', 'aBcD3fGh1_-', {}, 83, null]],
  ['http://youtu.be/aBcD3fGh1_-', ['youtube', 'aBcD3fGh1_-', {}, null, null]],
  ['https://youtu.be/aBcD3fGh1_-?t=0', ['youtube', 'aBcD3fGh1_-', {}, null, null]],
  ['https://www.youtube.com/watch?v=aBcD3fGh1_-#t=2m', ['youtube', 'aBcD3fGh1_-', {}, 120, null]],
  ['https://www.youtube.com/watch?v=aBcD3fGh1_-&t=abc&start=5', ['youtube', 'aBcD3fGh1_-', {}, null, null]],
  ['https://www.youtube.com/shorts/aBcD3fGh1_-', ['youtube', 'aBcD3fGh1_-', {}, null, null]],
  ['https://www.youtube.com/embed/aBcD3fGh1_-?start=30&end=95', ['youtube', 'aBcD3fGh1_-', {}, 30, 95]],
  ['https://www.youtube.com/watch?v=aBcD3fG', null],
  ['https://vimeo.com/76979871', ['vimeo', '76979871', {}, null, null]],
  ['https://vimeo.com/76979871/0a1b2c3d4e#t=1m5s', ['vimeo', '76979871', { hash: '0a1b2c3d4e' }, 65, null]],
  ['https://player.vimeo.com/video/76979871?h=0a1b2c3d4e', ['vimeo', '76979871', { hash: '0a1b2c3d4e' }, null, null]],
  [
    'https://rutube.ru/video/0123456789abcdef0123456789abcdef/?t=42',
    ['rutube', '0123456789abcdef0123456789abcdef', {}, 42, null],
  ],
  ['https://vkvideo.ru/video-12345_456239017', ['vkvideo', '456239017', { oid: '-12345' }, null, null]],
  [
    'https://vk.com/video_ext.php?oid=-12345&id=456239017&hash=a1b2c3d4e5f60718',
    ['vkvideo', '456239017', { oid: '-12345', hash: 'a1b2c3d4e5f60718' }, null, null],
  ],
  [
    'https://video.example.org/w/9c9de5e8-0a1b-4d6c-9f2a-3b4c5d6e7f80?start=1m',
    ['peertube', '9c9de5e8-0a1b-4d6c-9f2a-3b4c5d6e7f80', { host: 'video.example.org' }, 60, null],
  ],
  [
    'https://video.example.org/w/kkGMgK9ZtnKfYAgnEtQxbv',
    ['peertube', 'kkGMgK9ZtnKfYAgnEtQxbv', { host: 'video.example.org' }, null, null],
  ],
  ['https://other.example.net/w/kkGMgK9ZtnKfYAgnEtQxbv', null],
  ['https://example.org/clip.mp4', null],
];

for (const [url, expected] of MATCHES) {
  test(`matchVideoUrl(${JSON.stringify(url)}) follows vector 15.3`, () => {
    const match = matchVideoUrl(url, RULES);
    if (expected === null) {
      assert.equal(match, null);
      return;
    }
    assert.ok(match);
    const [provider, id, groups, start, end] = expected;
    assert.equal(match.provider, provider);
    assert.equal(match.providerName, PROVIDER_NAMES[/** @type {keyof typeof PROVIDER_NAMES} */ (provider)]);
    assert.equal(match.id, id);
    assert.deepEqual(match.groups, { ...groups, id });
    assert.equal(match.start, start);
    assert.equal(match.end, end);
    assert.ok(RULES.includes(match.rule));
  });
}

test('matchVideoUrl gives each built-in provider its capabilities', () => {
  /** @param {string} url */
  const capabilities = (url) => matchVideoUrl(url, RULES)?.capabilities;
  const all = { start: true, end: true, seek: true };
  const startSeek = { start: true, end: false, seek: true };
  assert.deepEqual(capabilities('https://youtu.be/aBcD3fGh1_-'), all);
  assert.deepEqual(capabilities('https://video.example.org/w/kkGMgK9ZtnKfYAgnEtQxbv'), all);
  assert.deepEqual(capabilities('https://vimeo.com/76979871'), startSeek);
  assert.deepEqual(capabilities('https://rutube.ru/video/0123456789abcdef0123456789abcdef/'), startSeek);
  assert.deepEqual(capabilities('https://vkvideo.ru/video-12345_456239017'), { start: false, end: false, seek: false });
});

test('matchVideoUrl reads only the time parameters of the provider', () => {
  /** @param {string} url */
  const times = (url) => {
    const match = matchVideoUrl(url, RULES);
    return match && [match.start, match.end];
  };
  // YouTube: query t, then query start, then fragment t; end from query end.
  assert.deepEqual(times('https://www.youtube.com/watch?v=aBcD3fGh1_-&start=5#t=9'), [5, null]);
  assert.deepEqual(times('https://www.youtube.com/watch?v=aBcD3fGh1_-&t=7&start=5'), [7, null]);
  assert.deepEqual(times('https://www.youtube.com/watch?v=aBcD3fGh1_-&end=abc'), [null, null]);
  assert.deepEqual(times('https://www.youtube.com/watch?v=aBcD3fGh1_-&end=0'), [null, null]);
  // Vimeo: only the fragment t.
  assert.deepEqual(times('https://vimeo.com/76979871?t=30'), [null, null]);
  assert.deepEqual(times('https://player.vimeo.com/video/76979871#t=30s'), [30, null]);
  // PeerTube: query start, then query t; end from query stop.
  assert.deepEqual(times('https://video.example.org/w/kkGMgK9ZtnKfYAgnEtQxbv?t=10&stop=1:00'), [10, 60]);
  assert.deepEqual(times('https://video.example.org/w/kkGMgK9ZtnKfYAgnEtQxbv?start=bad&t=10'), [null, null]);
  // Rutube: only the query t.
  assert.deepEqual(times('https://rutube.ru/video/0123456789abcdef0123456789abcdef/#t=42'), [null, null]);
  // VK Video: none.
  assert.deepEqual(times('https://vkvideo.ru/video-12345_456239017?t=42'), [null, null]);
});

test('matchVideoUrl matches the whole address with the u flag plus the flags of the rule', () => {
  /** @type {VideoRule} */
  const caseless = { pattern: 'https://youtu\\.be/(?<id>[a-z0-9_-]{11})', flags: 'i', provider: 'youtube', generic: null };
  assert.equal(matchVideoUrl('https://YOUTU.BE/aBcD3fGh1_-', [caseless])?.id, 'aBcD3fGh1_-');
  assert.equal(matchVideoUrl('https://YOUTU.BE/aBcD3fGh1_-', DEFAULT_VIDEO_RULES), null);
  assert.equal(matchVideoUrl(' https://youtu.be/aBcD3fGh1_-', DEFAULT_VIDEO_RULES), null);
  assert.equal(matchVideoUrl('https://youtu.be/aBcD3fGh1_-/x', DEFAULT_VIDEO_RULES), null);
  assert.equal(matchVideoUrl('https://youtu.be/aBcD3fGh1_-', []), null);
});

test('matchVideoUrl skips a rule whose id group did not take part or is empty', () => {
  /** @type {VideoRule[]} */
  const rules = [
    { pattern: 'https://a\\.example/(?:x|y(?<id>\\d+))', flags: '', provider: 'youtube', generic: null },
    { pattern: 'https://a\\.example/(?<id>\\d*)', flags: '', provider: 'vimeo', generic: null },
    { pattern: 'https://a\\.example/(?<id>[a-z]*)', flags: '', provider: 'rutube', generic: null },
  ];
  assert.equal(matchVideoUrl('https://a.example/x', rules)?.provider, 'rutube');
  assert.equal(matchVideoUrl('https://a.example/', rules), null);
  assert.equal(matchVideoUrl('https://a.example/y12', rules)?.provider, 'youtube');
});

test('matchVideoUrl gives null times when the address cannot be parsed', () => {
  /** @type {VideoRule} */
  const loose = { pattern: '(?<id>[a-z]+)\\?t=5', flags: '', provider: 'rutube', generic: null };
  const match = matchVideoUrl('abc?t=5', [loose]);
  assert.equal(match?.id, 'abc');
  assert.equal(match?.start, null);
  assert.equal(match?.end, null);
});

test('a generic rule matches with its name, its parameters and its capabilities (vector 15.5)', () => {
  const rules = resolveVideoRules({
    load: 'click',
    fetchPreviews: true,
    builtinRules: true,
    peertubeHosts: ['video.example.org'],
    rules: [SITE_RULE],
  });
  const match = matchVideoUrl('https://tube.example/v/abcd1234?t=15', rules);
  assert.ok(match);
  assert.equal(match.provider, 'generic');
  assert.equal(match.providerName, 'Example Tube');
  assert.equal(match.id, 'abcd1234');
  assert.deepEqual(match.groups, { id: 'abcd1234' });
  assert.equal(match.start, 15);
  assert.equal(match.end, null);
  assert.deepEqual(match.capabilities, { start: true, end: false, seek: true });
  assert.equal(match.rule, SITE_RULE);

  /** @type {VideoRule} */
  const ends = { ...SITE_RULE, generic: { ...EXAMPLE_TUBE, name: 'Ends', startParam: null, endParam: 'stop' } };
  const other = matchVideoUrl('https://tube.example/v/abcd1234?t=15&stop=20', [ends]);
  assert.equal(other?.start, null);
  assert.equal(other?.end, 20);
  assert.deepEqual(other?.capabilities, { start: false, end: true, seek: false });
});
