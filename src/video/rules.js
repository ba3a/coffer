/**
 * URL rules of videos: regular expressions that recognise the addresses of a
 * provider, and the matching of an address against them.
 */

import { parseTimecode } from './timecode.js';

/**
 * What serves a remote video.
 *
 * @typedef {'youtube' | 'vimeo' | 'peertube' | 'rutube' | 'vkvideo' | 'generic'} Provider
 */

/**
 * A host described by the site's configuration.
 *
 * @typedef {object} GenericProvider
 * @property {string} name Display name, such as "Example Tube".
 * @property {string} embed Template of the embed URL.
 * @property {string} watch Template of the watch URL.
 * @property {string | null} startParam Query parameter that carries the start, in seconds.
 * @property {string | null} endParam Query parameter that carries the end, in seconds.
 * @property {string | null} autoplayParam Query parameter set to 1 to autoplay.
 * @property {string | null} thumbnail Template of the thumbnail image URL.
 * @property {string | null} oembed Template of an oEmbed JSON URL; may use `{url}`.
 */

/**
 * A regular expression plus a provider.
 *
 * @typedef {object} VideoRule
 * @property {string} pattern Regular expression source.
 * @property {'' | 'i'} flags
 * @property {Provider} provider
 * @property {GenericProvider | null} generic Non-null exactly when `provider` is `generic`.
 */

/**
 * @typedef {object} VideoCapabilities
 * @property {boolean} start
 * @property {boolean} end
 * @property {boolean} seek
 */

/**
 * The result of applying the rules to an address.
 *
 * @typedef {object} VideoMatch
 * @property {Provider} provider
 * @property {string} providerName `PROVIDER_NAMES[provider]`, or `generic.name`.
 * @property {VideoRule} rule The rule that matched.
 * @property {string} id The named group "id".
 * @property {Record<string, string>} groups Every named group that took part in the match, "id" included.
 * @property {number | null} start Start found in the URL; 0 becomes null.
 * @property {number | null} end End found in the URL; 0 becomes null.
 * @property {VideoCapabilities} capabilities
 */

/**
 * The `video` settings of a site, as the loaded configuration holds them.
 *
 * @typedef {object} SiteVideoConfig
 * @property {'click' | 'iframe'} load How remote videos load unless a video says otherwise.
 * @property {boolean} fetchPreviews Whether the build may fetch titles and thumbnails from the hosts.
 * @property {boolean} builtinRules Whether `DEFAULT_VIDEO_RULES` apply after the site's own rules.
 * @property {string[]} peertubeHosts Host names of PeerTube instances whose videos are recognised.
 * @property {VideoRule[]} rules The site's own rules, normalised.
 */

/** Display names of the built-in providers. */
export const PROVIDER_NAMES = Object.freeze({
  youtube: 'YouTube',
  vimeo: 'Vimeo',
  peertube: 'PeerTube',
  rutube: 'Rutube',
  vkvideo: 'VK Video',
});

/**
 * @param {Exclude<Provider, 'generic' | 'peertube'>} provider
 * @param {string} pattern
 * @returns {Readonly<VideoRule>}
 */
function builtinRule(provider, pattern) {
  return Object.freeze({ pattern, flags: /** @type {''} */ (''), provider, generic: null });
}

/** The rules of the built-in providers, tried after the site's own. */
export const DEFAULT_VIDEO_RULES = Object.freeze([
  builtinRule(
    'youtube',
    String.raw`https?://(?:www\.|m\.)?youtube\.com/watch\?(?:[^#]*&)?v=(?<id>[A-Za-z0-9_-]{11})(?:[&#].*)?`,
  ),
  builtinRule('youtube', String.raw`https?://youtu\.be/(?<id>[A-Za-z0-9_-]{11})(?:[?#].*)?`),
  builtinRule(
    'youtube',
    String.raw`https?://(?:www\.|m\.)?youtube(?:-nocookie)?\.com/(?:embed|shorts|live)/(?<id>[A-Za-z0-9_-]{11})(?:[?#].*)?`,
  ),
  builtinRule('vimeo', String.raw`https?://(?:www\.)?vimeo\.com/(?<id>\d+)(?:/(?<hash>[0-9a-f]{6,}))?/?(?:[?#].*)?`),
  builtinRule(
    'vimeo',
    String.raw`https?://player\.vimeo\.com/video/(?<id>\d+)/?(?:\?(?:[^#]*&)?h=(?<hash>[0-9a-f]+)(?:&[^#]*)?)?(?:[?#].*)?`,
  ),
  builtinRule(
    'rutube',
    String.raw`https?://(?:www\.)?rutube\.ru/(?:video|play/embed|shorts)/(?<id>[0-9a-f]{32})/?(?:[?#].*)?`,
  ),
  builtinRule(
    'vkvideo',
    String.raw`https?://(?:www\.)?(?:vkvideo\.ru|vk\.com|vk\.ru)/video(?<oid>-?\d+)_(?<id>\d+)/?(?:[?#].*)?`,
  ),
  builtinRule(
    'vkvideo',
    String.raw`https?://(?:www\.)?(?:vkvideo\.ru|vk\.com|vk\.ru)/video_ext\.php\?oid=(?<oid>-?\d+)&id=(?<id>\d+)(?:&hash=(?<hash>[0-9a-f]+))?(?:&[^#]*)?(?:#.*)?`,
  ),
]);

/**
 * The rule that recognises the videos of one PeerTube instance.
 *
 * @param {string} host A host name such as `video.example.org`.
 * @returns {VideoRule}
 */
function peertubeRule(host) {
  const escaped = host.replaceAll('.', '\\.');
  return {
    pattern: String.raw`https?://(?<host>${escaped})/(?:w|videos/watch|videos/embed)/(?<id>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[1-9A-HJ-NP-Za-km-z]{21,22})/?(?:[?#].*)?`,
    flags: '',
    provider: 'peertube',
    generic: null,
  };
}

/**
 * The rules of a site in the order they are tried: the site's own, then one
 * per PeerTube host, then the built-in ones unless `builtinRules` is false.
 *
 * @param {SiteVideoConfig} video
 * @returns {VideoRule[]}
 */
export function resolveVideoRules(video) {
  return [
    ...video.rules,
    ...video.peertubeHosts.map(peertubeRule),
    ...(video.builtinRules === false ? [] : DEFAULT_VIDEO_RULES),
  ];
}

/**
 * Where a time is read from: a query parameter, or a `key=value` pair of the
 * fragment.
 *
 * @typedef {{ in: 'query' | 'fragment', name: string }} TimeParam
 */

/**
 * The time parameters of the built-in providers, in the order they are tried.
 *
 * @type {Record<Exclude<Provider, 'generic'>, { start: TimeParam[], end: TimeParam[] }>}
 */
const TIME_PARAMS = {
  youtube: {
    start: [
      { in: 'query', name: 't' },
      { in: 'query', name: 'start' },
      { in: 'fragment', name: 't' },
    ],
    end: [{ in: 'query', name: 'end' }],
  },
  vimeo: { start: [{ in: 'fragment', name: 't' }], end: [] },
  peertube: {
    start: [
      { in: 'query', name: 'start' },
      { in: 'query', name: 't' },
    ],
    end: [{ in: 'query', name: 'stop' }],
  },
  rutube: { start: [{ in: 'query', name: 't' }], end: [] },
  vkvideo: { start: [], end: [] },
};

/** @type {Record<Exclude<Provider, 'generic'>, VideoCapabilities>} */
const CAPABILITIES = {
  youtube: { start: true, end: true, seek: true },
  vimeo: { start: true, end: false, seek: true },
  peertube: { start: true, end: true, seek: true },
  rutube: { start: true, end: false, seek: true },
  vkvideo: { start: false, end: false, seek: false },
};

/**
 * The time parameters of a rule's provider.
 *
 * @param {VideoRule} rule
 * @returns {{ start: TimeParam[], end: TimeParam[] }}
 */
function timeParams(rule) {
  if (rule.provider !== 'generic') return TIME_PARAMS[rule.provider];
  const generic = /** @type {GenericProvider} */ (rule.generic);
  return {
    start: generic.startParam === null ? [] : [{ in: 'query', name: generic.startParam }],
    end: generic.endParam === null ? [] : [{ in: 'query', name: generic.endParam }],
  };
}

/**
 * What the provider of a rule can do: start at a time, stop at a time, and
 * seek from a link in the text.
 *
 * @param {VideoRule} rule
 * @returns {VideoCapabilities}
 */
export function videoCapabilities(rule) {
  if (rule.provider !== 'generic') return { ...CAPABILITIES[rule.provider] };
  const generic = /** @type {GenericProvider} */ (rule.generic);
  const start = generic.startParam !== null;
  return { start, end: generic.endParam !== null, seek: start };
}

/**
 * Reads a time from the first of `params` present in the address.
 *
 * @param {URL | null} address
 * @param {TimeParam[]} params
 * @returns {number | null} Whole seconds; null when no parameter is present, the first present does not parse, or it is 0.
 */
function readTime(address, params) {
  if (address === null) return null;
  /** @type {URLSearchParams | undefined} */
  let fragment;
  for (const param of params) {
    let source;
    if (param.in === 'query') {
      source = address.searchParams;
    } else {
      fragment ??= new URLSearchParams(address.hash.slice(1));
      source = fragment;
    }
    const value = source.get(param.name);
    if (value === null) continue;
    return parseTimecode(value) || null;
  }
  return null;
}

/** @type {Map<string, RegExp>} */
const compiled = new Map();

/**
 * The regular expression of a rule, matching the whole address.
 *
 * @param {VideoRule} rule
 * @returns {RegExp}
 */
function ruleRegExp(rule) {
  const flags = 'u' + rule.flags;
  const key = `${flags}/${rule.pattern}`;
  let regexp = compiled.get(key);
  if (regexp === undefined) {
    regexp = new RegExp('^(?:' + rule.pattern + ')$', flags);
    compiled.set(key, regexp);
  }
  return regexp;
}

/**
 * Applies `rules` in order to `url`. The first rule that matches the whole
 * address with a non-empty `id` group wins.
 *
 * @param {string} url
 * @param {readonly VideoRule[]} rules
 * @returns {VideoMatch | null}
 */
export function matchVideoUrl(url, rules) {
  for (const rule of rules) {
    const found = ruleRegExp(rule).exec(url);
    const id = found?.groups?.id;
    if (!found || id === undefined || id === '') continue;
    /** @type {Record<string, string>} */
    const groups = {};
    for (const [name, value] of Object.entries(/** @type {Record<string, string | undefined>} */ (found.groups))) {
      if (value !== undefined) groups[name] = value;
    }
    let address = null;
    try {
      address = new URL(url);
    } catch {
      // Not an absolute address: no times.
    }
    const params = timeParams(rule);
    return {
      provider: rule.provider,
      providerName:
        rule.provider === 'generic' ? /** @type {GenericProvider} */ (rule.generic).name : PROVIDER_NAMES[rule.provider],
      rule,
      id,
      groups,
      start: readTime(address, params.start),
      end: readTime(address, params.end),
      capabilities: videoCapabilities(rule),
    };
  }
  return null;
}
