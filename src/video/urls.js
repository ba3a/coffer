/**
 * The addresses built from a video match: the player to embed, the page to
 * watch on, the metadata (oEmbed) document and the thumbnail. Also the checks
 * of generic provider templates that the configuration loader uses.
 */

/** @typedef {import('./rules.js').VideoMatch} VideoMatch */
/** @typedef {import('./rules.js').GenericProvider} GenericProvider */

/**
 * The template keys of a generic provider.
 *
 * @typedef {'embed' | 'watch' | 'thumbnail' | 'oembed'} TemplateKey
 */

const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

const enc = encodeURIComponent;

/**
 * Appends query parameters, leaving out those whose value is null, with `?`
 * when `url` has no query yet, else with `&`.
 *
 * @param {string} url
 * @param {[string, string | number | null][]} params
 * @returns {string}
 */
function appendQuery(url, params) {
  const pairs = params.filter(([, value]) => value !== null).map(([name, value]) => `${name}=${value}`);
  if (pairs.length === 0) return url;
  return url + (url.includes('?') ? '&' : '?') + pairs.join('&');
}

/**
 * The encoded value of a named group, or an empty string when it did not take
 * part in the match.
 *
 * @param {VideoMatch} match
 * @param {string} name
 * @returns {string}
 */
function group(match, name) {
  return enc(match.groups[name] ?? '');
}

/**
 * Expands a template of a generic provider. A placeholder is replaced by the
 * encoded named group, or, for `{url}` in an oEmbed template, by the encoded
 * watch URL without a time.
 *
 * @param {string} template
 * @param {VideoMatch} match
 * @param {boolean} [oembed]
 * @returns {string}
 */
function expand(template, match, oembed = false) {
  return template.replace(PLACEHOLDER, (_, name) =>
    oembed && name === 'url' ? enc(watchUrl(match, null)) : group(match, name),
  );
}

/**
 * The generic provider of a match.
 *
 * @param {VideoMatch} match
 * @returns {GenericProvider}
 */
function genericOf(match) {
  return /** @type {GenericProvider} */ (match.rule.generic);
}

/**
 * A time the provider can use: null when it lacks the capability or the time
 * is null or 0.
 *
 * @param {boolean} capable
 * @param {number | null} time
 * @returns {number | null}
 */
function usable(capable, time) {
  return capable && time ? time : null;
}

/**
 * The address of the player to embed.
 *
 * @param {VideoMatch} match
 * @param {{ start: number | null, end: number | null, autoplay: boolean }} options
 * @returns {string}
 */
export function embedUrl(match, { start, end, autoplay }) {
  const s = usable(match.capabilities.start, start);
  const e = usable(match.capabilities.end, end);
  const play = autoplay ? 1 : null;
  const id = group(match, 'id');
  switch (match.provider) {
    case 'youtube':
      return appendQuery(`https://www.youtube-nocookie.com/embed/${id}`, [
        ['start', s],
        ['end', e],
        ['autoplay', play],
      ]);
    case 'vimeo': {
      const hash = match.groups.hash === undefined ? null : group(match, 'hash');
      const url = appendQuery(`https://player.vimeo.com/video/${id}`, [
        ['h', hash],
        ['dnt', 1],
        ['autoplay', play],
      ]);
      return s === null ? url : `${url}#t=${s}s`;
    }
    case 'peertube':
      return appendQuery(`https://${group(match, 'host')}/videos/embed/${id}`, [
        ['start', s],
        ['stop', e],
        ['autoplay', play],
      ]);
    case 'rutube':
      return appendQuery(`https://rutube.ru/play/embed/${id}/`, [
        ['t', s],
        ['autoplay', play],
      ]);
    case 'vkvideo':
      return appendQuery(`https://vkvideo.ru/video_ext.php?oid=${group(match, 'oid')}&id=${id}`, [
        ['hash', match.groups.hash === undefined ? null : group(match, 'hash')],
        ['autoplay', play],
      ]);
    case 'generic': {
      const generic = genericOf(match);
      /** @type {[string, string | number | null][]} */
      const params = [];
      if (generic.startParam !== null) params.push([generic.startParam, s]);
      if (generic.endParam !== null) params.push([generic.endParam, e]);
      if (generic.autoplayParam !== null) params.push([generic.autoplayParam, play]);
      return appendQuery(expand(generic.embed, match), params);
    }
  }
}

/**
 * The address of the page that shows the video on its host.
 *
 * @param {VideoMatch} match
 * @param {number | null} start
 * @returns {string}
 */
export function watchUrl(match, start) {
  const s = usable(match.capabilities.start, start);
  const id = group(match, 'id');
  switch (match.provider) {
    case 'youtube':
      return appendQuery(`https://www.youtube.com/watch?v=${id}`, [['t', s === null ? null : `${s}s`]]);
    case 'vimeo': {
      const hash = match.groups.hash === undefined ? '' : `/${group(match, 'hash')}`;
      return `https://vimeo.com/${id}${hash}` + (s === null ? '' : `#t=${s}s`);
    }
    case 'peertube':
      return appendQuery(`https://${group(match, 'host')}/w/${id}`, [['start', s]]);
    case 'rutube':
      return appendQuery(`https://rutube.ru/video/${id}/`, [['t', s]]);
    case 'vkvideo':
      return `https://vkvideo.ru/video${group(match, 'oid')}_${id}`;
    case 'generic': {
      const generic = genericOf(match);
      const url = expand(generic.watch, match);
      return generic.startParam === null ? url : appendQuery(url, [[generic.startParam, s]]);
    }
  }
}

/**
 * The address of the JSON document that gives the title and thumbnail of the
 * video, or null when the provider has none.
 *
 * @param {VideoMatch} match
 * @returns {string | null}
 */
export function metadataUrl(match) {
  const watch = () => enc(watchUrl(match, null));
  switch (match.provider) {
    case 'youtube':
      return `https://www.youtube.com/oembed?format=json&url=${watch()}`;
    case 'vimeo':
      return `https://vimeo.com/api/oembed.json?url=${watch()}`;
    case 'peertube':
      return `https://${group(match, 'host')}/services/oembed?format=json&url=${watch()}`;
    case 'rutube':
      return `https://rutube.ru/api/video/${group(match, 'id')}/?format=json`;
    case 'vkvideo':
      return null;
    case 'generic': {
      const { oembed } = genericOf(match);
      return oembed === null ? null : expand(oembed, match, true);
    }
  }
}

/**
 * The address of the thumbnail image: only a generic provider with a
 * `thumbnail` template has one.
 *
 * @param {VideoMatch} match
 * @returns {string | null}
 */
export function thumbnailUrl(match) {
  if (match.provider !== 'generic') return null;
  const { thumbnail } = genericOf(match);
  return thumbnail === null ? null : expand(thumbnail, match);
}

/**
 * The names of the named groups of a regular expression source, in order of
 * first appearance. Finds `(?<name>` outside character classes and not after
 * an escaping backslash; lookbehinds `(?<=` and `(?<!` are not groups.
 *
 * @param {string} source
 * @returns {string[]}
 */
export function patternGroupNames(source) {
  /** @type {string[]} */
  const names = [];
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === '\\') {
      i++;
    } else if (inClass) {
      if (char === ']') inClass = false;
    } else if (char === '[') {
      inClass = true;
    } else if (char === '(' && source.startsWith('?<', i + 1)) {
      const name = /^[A-Za-z_$][A-Za-z0-9_$]*(?=>)/.exec(source.slice(i + 3))?.[0];
      if (name !== undefined && !names.includes(name)) names.push(name);
    }
  }
  return names;
}

/**
 * The problem of a generic provider template, or null when it is valid.
 * Placeholders must name a group of the pattern; `{url}` is also allowed in
 * the oEmbed template.
 *
 * @param {string} template
 * @param {Iterable<string>} groupNames The named groups of the rule's pattern.
 * @param {TemplateKey} key
 * @returns {string | null}
 */
export function templateProblem(template, groupNames, key) {
  const sample = template.replace(PLACEHOLDER, 'x').replace(/[{}]/g, 'x');
  if (!template.startsWith('https://') || template.includes('#') || !URL.canParse(sample)) {
    return 'must be an https address without a fragment';
  }
  const names = new Set(groupNames);
  for (const [, name] of template.matchAll(PLACEHOLDER)) {
    if (!names.has(name) && !(key === 'oembed' && name === 'url')) {
      return `{${name}} is not a named group of the pattern`;
    }
  }
  if (/[{}]/.test(template.replace(PLACEHOLDER, ''))) {
    return 'must not contain "{" or "}" outside a placeholder';
  }
  return null;
}
