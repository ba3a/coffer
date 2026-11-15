import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { ConfigError, loadConfig, normalizeConfig } from '../src/config.js';
import { matchVideoUrl, resolveVideoRules } from '../src/video/rules.js';

const SITE = { id: 'main', baseUrl: 'https://example.org', title: 'Main' };

/**
 * A configuration of one site with the given `video` value.
 *
 * @param {unknown} video
 */
function withVideo(video) {
  return { sites: [{ ...SITE, video }] };
}

/**
 * @param {unknown} raw
 */
function normalize(raw) {
  return normalizeConfig(raw, { file: resolve('/work/coffer.yaml') });
}

/**
 * @param {unknown} video
 */
function videoOf(video) {
  return normalize(withVideo(video)).sites[0].video;
}

/**
 * @param {unknown} video
 * @returns {string[]}
 */
function errorsOf(video) {
  try {
    normalize(withVideo(video));
  } catch (error) {
    assert.ok(error instanceof ConfigError, String(error));
    return error.errors;
  }
  assert.fail('expected a ConfigError');
}

/**
 * Asserts that `video` gives exactly the listed problems.
 *
 * @param {unknown} video
 * @param {string[]} expected Problems without the `coffer.yaml: ` prefix.
 */
function rejects(video, expected) {
  assert.deepEqual(errorsOf(video), expected.map((problem) => `coffer.yaml: ${problem}`));
}

const EXAMPLE_RULE = {
  pattern: 'https://tube\\.example/v/(?<id>[a-z0-9]{8})(?:[?#].*)?',
  provider: 'generic',
  name: 'Example Tube',
  embed: 'https://player.tube.example/e/{id}',
  watch: 'https://tube.example/v/{id}',
  startParam: 't',
  autoplayParam: 'autoplay',
  thumbnail: 'https://img.tube.example/{id}/cover.jpg',
};

const EXAMPLE_YAML = `
sites:
  - id: main
    baseUrl: https://example.org
    title: Main
    video:
      load: click
      fetchPreviews: true
      builtinRules: true
      peertubeHosts: [video.example.org]
      rules:
        - pattern: 'https://tube\\.example/v/(?<id>[a-z0-9]{8})(?:[?#].*)?'
          provider: generic
          name: Example Tube
          embed: 'https://player.tube.example/e/{id}'
          watch: 'https://tube.example/v/{id}'
          startParam: t
          autoplayParam: autoplay
          thumbnail: 'https://img.tube.example/{id}/cover.jpg'
`;

const GENERIC_NULLS = {
  startParam: null,
  endParam: null,
  autoplayParam: null,
  thumbnail: null,
  oembed: null,
};

test('a site without video gets the defaults', () => {
  const config = normalize({ sites: [SITE] });
  assert.deepEqual(config.sites[0].video, {
    load: 'click',
    fetchPreviews: true,
    builtinRules: true,
    peertubeHosts: [],
    rules: [],
  });
});

test('an empty video mapping gets the defaults', () => {
  assert.deepEqual(videoOf({}), {
    load: 'click',
    fetchPreviews: true,
    builtinRules: true,
    peertubeHosts: [],
    rules: [],
  });
});

test('the example of section 7 loads and its rule matches vector 15.5', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coffer-config-video-'));
  try {
    writeFileSync(join(dir, 'coffer.yaml'), EXAMPLE_YAML);
    const { video } = loadConfig({ cwd: dir }).sites[0];
    assert.deepEqual(video, {
      load: 'click',
      fetchPreviews: true,
      builtinRules: true,
      peertubeHosts: ['video.example.org'],
      rules: [
        {
          pattern: EXAMPLE_RULE.pattern,
          flags: '',
          provider: 'generic',
          generic: {
            name: 'Example Tube',
            embed: 'https://player.tube.example/e/{id}',
            watch: 'https://tube.example/v/{id}',
            startParam: 't',
            endParam: null,
            autoplayParam: 'autoplay',
            thumbnail: 'https://img.tube.example/{id}/cover.jpg',
            oembed: null,
          },
        },
      ],
    });
    const match = matchVideoUrl('https://tube.example/v/abcd1234?t=15', resolveVideoRules(video));
    assert.ok(match);
    assert.equal(match.provider, 'generic');
    assert.equal(match.providerName, 'Example Tube');
    assert.equal(match.id, 'abcd1234');
    assert.equal(match.start, 15);
    assert.deepEqual(match.capabilities, { start: true, end: false, seek: true });
    // The site's PeerTube host is recognised too.
    assert.equal(
      matchVideoUrl('https://video.example.org/w/kkGMgK9ZtnKfYAgnEtQxbv', resolveVideoRules(video))?.provider,
      'peertube',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the top-level values are read', () => {
  assert.deepEqual(
    videoOf({ load: 'iframe', fetchPreviews: false, builtinRules: false, peertubeHosts: ['a.example', 'b.c.example'] }),
    {
      load: 'iframe',
      fetchPreviews: false,
      builtinRules: false,
      peertubeHosts: ['a.example', 'b.c.example'],
      rules: [],
    },
  );
});

test('a rule of a built-in provider is normalised with flags and a null generic', () => {
  const pattern = 'https://clips\\.example/(?<host>[a-z.]+)/(?<id>\\d+)';
  assert.deepEqual(videoOf({ rules: [{ pattern, provider: 'peertube' }, { pattern, flags: 'i', provider: 'youtube' }] }).rules, [
    { pattern, flags: '', provider: 'peertube', generic: null },
    { pattern, flags: 'i', provider: 'youtube', generic: null },
  ]);
});

test('a generic rule with only the required keys has null optional values', () => {
  const rule = { pattern: 'https://x\\.example/(?<id>\\d+)', provider: 'generic', name: 'X', embed: 'https://x.example/e/{id}', watch: 'https://x.example/{id}' };
  assert.deepEqual(videoOf({ rules: [rule] }).rules[0].generic, {
    name: 'X',
    embed: 'https://x.example/e/{id}',
    watch: 'https://x.example/{id}',
    ...GENERIC_NULLS,
  });
});

test('a generic rule may use oembed with {url} and an end parameter', () => {
  const rule = {
    pattern: 'https://x\\.example/(?<id>\\d+)',
    provider: 'generic',
    name: 'X',
    embed: 'https://x.example/e/{id}',
    watch: 'https://x.example/{id}',
    endParam: 'to',
    oembed: 'https://x.example/oembed?url={url}&id={id}',
  };
  const { generic } = videoOf({ rules: [rule] }).rules[0];
  assert.equal(generic?.endParam, 'to');
  assert.equal(generic?.oembed, 'https://x.example/oembed?url={url}&id={id}');
  assert.equal(generic?.thumbnail, null);
});

test('the flag i is accepted and applied when matching', () => {
  const rule = { pattern: 'https://x\\.example/(?<id>[a-z]+)', flags: 'i', provider: 'generic', name: 'X', embed: 'https://x.example/e/{id}', watch: 'https://x.example/{id}' };
  const video = videoOf({ rules: [rule], builtinRules: false });
  assert.equal(matchVideoUrl('https://X.EXAMPLE/AbC', resolveVideoRules(video))?.id, 'AbC');
});

// Every row of the problem table of section 7.

test('load must be click or iframe', () => {
  rejects({ load: 'lazy' }, ['sites[0].video.load: must be one of: click, iframe']);
  rejects({ load: 1 }, ['sites[0].video.load: must be one of: click, iframe']);
});

test('fetchPreviews and builtinRules must be booleans', () => {
  rejects({ fetchPreviews: 'yes', builtinRules: 0 }, [
    'sites[0].video.fetchPreviews: must be true or false',
    'sites[0].video.builtinRules: must be true or false',
  ]);
});

test('peertubeHosts must be a list of host names', () => {
  rejects({ peertubeHosts: 'video.example.org' }, ['sites[0].video.peertubeHosts: must be a list']);
  rejects({ peertubeHosts: ['video.example.org', 'Video.Example.org', 'localhost', 'https://v.example', 'v.example/', '-a.example', 'a-.example', 7] }, [
    'sites[0].video.peertubeHosts[1]: must be a host name such as video.example.org',
    'sites[0].video.peertubeHosts[2]: must be a host name such as video.example.org',
    'sites[0].video.peertubeHosts[3]: must be a host name such as video.example.org',
    'sites[0].video.peertubeHosts[4]: must be a host name such as video.example.org',
    'sites[0].video.peertubeHosts[5]: must be a host name such as video.example.org',
    'sites[0].video.peertubeHosts[6]: must be a host name such as video.example.org',
    'sites[0].video.peertubeHosts[7]: must be a host name such as video.example.org',
  ]);
});

test('rules must be a list of mappings', () => {
  rejects({ rules: { pattern: 'x' } }, ['sites[0].video.rules: must be a list']);
  rejects({ rules: ['https://x'] }, ['sites[0].video.rules[0]: must be a mapping']);
});

test('pattern and provider are required', () => {
  rejects({ rules: [{}] }, [
    'sites[0].video.rules[0].pattern: is required',
    'sites[0].video.rules[0].provider: is required',
  ]);
});

test('a pattern that does not compile with u and the flags is reported', () => {
  rejects({ rules: [{ pattern: 'https://x/(?<id>\\d+', provider: 'youtube' }] }, [
    'sites[0].video.rules[0].pattern: is not a valid regular expression',
  ]);
  // Unbalanced parentheses that the anchoring wrapper of matchVideoUrl would close.
  rejects({ rules: [{ pattern: 'https://x/(?<id>a)|(b', provider: 'youtube' }] }, [
    'sites[0].video.rules[0].pattern: is not a valid regular expression',
  ]);
  // Valid without the u flag, invalid with it.
  rejects({ rules: [{ pattern: 'https://x/(?<id>\\d+)\\-\\q', provider: 'youtube' }] }, [
    'sites[0].video.rules[0].pattern: is not a valid regular expression',
  ]);
});

test('a pattern must have the named group id', () => {
  rejects({ rules: [{ pattern: 'https://x/(\\d+)', provider: 'youtube' }] }, [
    'sites[0].video.rules[0].pattern: must have a named group "id"',
  ]);
  // A lookbehind is not a named group.
  rejects({ rules: [{ pattern: 'https://x/(?<=id)\\d+', provider: 'youtube' }] }, [
    'sites[0].video.rules[0].pattern: must have a named group "id"',
  ]);
});

test('a peertube pattern must have the named group host', () => {
  rejects({ rules: [{ pattern: 'https://x/(?<id>\\d+)', provider: 'peertube' }] }, [
    'sites[0].video.rules[0].pattern: must have a named group "host" for provider peertube',
  ]);
});

test('a vkvideo pattern must have the named group oid', () => {
  rejects({ rules: [{ pattern: 'https://x/(?<id>\\d+)', provider: 'vkvideo' }] }, [
    'sites[0].video.rules[0].pattern: must have a named group "oid" for provider vkvideo',
  ]);
});

test('flags must be "" or "i"', () => {
  rejects({ rules: [{ pattern: 'https://x/(?<id>\\d+)', flags: 'g', provider: 'youtube' }] }, [
    'sites[0].video.rules[0].flags: must be "" or "i"',
  ]);
  rejects({ rules: [{ pattern: 'https://x/(?<id>\\d+)', flags: true, provider: 'youtube' }] }, [
    'sites[0].video.rules[0].flags: must be "" or "i"',
  ]);
});

test('an unknown provider is reported', () => {
  rejects({ rules: [{ pattern: 'https://x/(?<id>\\d+)', provider: 'dailymotion' }] }, [
    'sites[0].video.rules[0].provider: must be one of: youtube, vimeo, peertube, rutube, vkvideo, generic',
  ]);
});

test('name, embed and watch are required for a generic rule', () => {
  rejects({ rules: [{ pattern: 'https://x/(?<id>\\d+)', provider: 'generic' }] }, [
    'sites[0].video.rules[0].name: is required',
    'sites[0].video.rules[0].embed: is required',
    'sites[0].video.rules[0].watch: is required',
  ]);
});

test('generic-only keys are rejected on other providers', () => {
  const rule = {
    pattern: 'https://x/(?<id>\\d+)',
    provider: 'vimeo',
    name: 'X',
    embed: 'https://x/e/{id}',
    watch: 'https://x/{id}',
    startParam: 't',
    endParam: 'e',
    autoplayParam: 'a',
    thumbnail: 'https://x/{id}.jpg',
    oembed: 'https://x/o?url={url}',
  };
  rejects({ rules: [rule] }, ['name', 'embed', 'watch', 'startParam', 'endParam', 'autoplayParam', 'thumbnail', 'oembed'].map(
    (key) => `sites[0].video.rules[0].${key}: is only allowed for provider generic`,
  ));
});

/**
 * A generic rule with `overrides` merged over valid values.
 *
 * @param {Record<string, unknown>} overrides
 */
function generic(overrides) {
  return {
    pattern: 'https://x\\.example/(?<id>\\d+)(?:/(?<part>\\d+))?',
    provider: 'generic',
    name: 'X',
    embed: 'https://x.example/e/{id}',
    watch: 'https://x.example/{id}',
    ...overrides,
  };
}

test('each template must be an https address without a fragment', () => {
  rejects({ rules: [generic({ embed: 'http://x.example/e/{id}', watch: 'https://x.example/{id}#top', thumbnail: 'x.example/{id}.jpg' })] }, [
    'sites[0].video.rules[0].embed: must be an https address without a fragment',
    'sites[0].video.rules[0].watch: must be an https address without a fragment',
    'sites[0].video.rules[0].thumbnail: must be an https address without a fragment',
  ]);
  rejects({ rules: [generic({ oembed: 'https://x.example/o?url={url}#x' })] }, [
    'sites[0].video.rules[0].oembed: must be an https address without a fragment',
  ]);
});

test('a template placeholder must name a group of the pattern; {url} only in oembed', () => {
  rejects({ rules: [generic({ embed: 'https://x.example/e/{vid}', watch: 'https://x.example/{url}', thumbnail: 'https://x.example/{part}/{size}.jpg' })] }, [
    'sites[0].video.rules[0].embed: {vid} is not a named group of the pattern',
    'sites[0].video.rules[0].watch: {url} is not a named group of the pattern',
    'sites[0].video.rules[0].thumbnail: {size} is not a named group of the pattern',
  ]);
  rejects({ rules: [generic({ oembed: 'https://x.example/o?url={url}&n={nope}' })] }, [
    'sites[0].video.rules[0].oembed: {nope} is not a named group of the pattern',
  ]);
});

test('a template must not contain braces outside a placeholder', () => {
  rejects({ rules: [generic({ embed: 'https://x.example/e/{id}}', oembed: 'https://x.example/o?u={url}&x={1}' })] }, [
    'sites[0].video.rules[0].embed: must not contain "{" or "}" outside a placeholder',
    'sites[0].video.rules[0].oembed: must not contain "{" or "}" outside a placeholder',
  ]);
});

test('query parameter names are checked', () => {
  rejects({ rules: [generic({ startParam: 't s', endParam: 'e&x', autoplayParam: 'a=1' })] }, [
    'sites[0].video.rules[0].startParam: must be a query parameter name',
    'sites[0].video.rules[0].endParam: must be a query parameter name',
    'sites[0].video.rules[0].autoplayParam: must be a query parameter name',
  ]);
  assert.equal(videoOf({ rules: [generic({ startParam: 'a_B-1.x' })] }).rules[0].generic?.startParam, 'a_B-1.x');
});

test('thumbnail cannot be used together with oembed', () => {
  rejects({ rules: [generic({ thumbnail: 'https://x.example/{id}.jpg', oembed: 'https://x.example/o?url={url}' })] }, [
    'sites[0].video.rules[0].thumbnail: cannot be used together with oembed',
  ]);
});

test('unknown keys under video and under a rule are errors', () => {
  const problems = errorsOf({ autoplay: true, rules: [generic({ title: 'X' })] });
  assert.equal(problems.length, 2);
  assert.match(problems[0], /^coffer\.yaml: sites\[0\]\.video\.autoplay: unknown key \(expected one of: load, fetchPreviews, builtinRules, peertubeHosts, rules\)$/);
  assert.match(problems[1], /^coffer\.yaml: sites\[0\]\.video\.rules\[0\]\.title: unknown key \(expected one of: pattern, flags, provider, name, embed, watch, startParam, endParam, autoplayParam, thumbnail, oembed\)$/);
});

test('video must be a mapping', () => {
  rejects('click', ['sites[0].video: must be a mapping']);
});

test('the key path names the rule by its index', () => {
  rejects({ rules: [generic({}), { pattern: 'https://x/(\\d+)', provider: 'youtube' }] }, [
    'sites[0].video.rules[1].pattern: must have a named group "id"',
  ]);
});
