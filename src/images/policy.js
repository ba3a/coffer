/**
 * Which location and camera metadata a published image keeps.
 *
 * Two settings are resolved independently of each other:
 *
 * - `location`: `strip` (removed), `coarse` (rounded to about a kilometre) or
 *   `keep` (exact). In permissiveness `strip < coarse < keep`.
 * - `camera`: `strip` or `keep`.
 *
 * Each setting can be given at four levels, from the least to the most
 * specific: the site (`location.default` and `location.camera` in
 * `coffer.yaml`), the tags of the post (`location` and `camera` in `tags.yaml`),
 * the post (front matter) and the image (the post's `images:` map). The most
 * specific level that sets a value wins, even when it is more permissive than a
 * less specific one: naming a policy for a post or an image is an explicit
 * choice. Two rules apply inside the tag level only:
 *
 * - a tag's setting covers its whole subtree, and the nearest ancestor (the tag
 *   itself included) that has a setting applies to a given tag;
 * - when the tags of a post give different values, the strictest one wins.
 *
 * Every decision names the level, and where it applies the entry, it came from,
 * so a report can say why an image is published the way it is.
 *
 * This module only decides; it reads no files and touches no images.
 */

/** Location policies from the strictest to the most permissive. */
export const LOCATION_POLICIES = Object.freeze(['strip', 'coarse', 'keep']);

/** Camera metadata policies from the strictest to the most permissive. */
export const CAMERA_POLICIES = Object.freeze(['strip', 'keep']);

/**
 * The two settings.
 *
 * @typedef {'location' | 'camera'} PolicySetting
 */

/**
 * The levels a decision can come from, from the least to the most specific.
 *
 * @typedef {'site' | 'tag' | 'post' | 'image'} PolicyLevel
 */

/**
 * Where a decision came from.
 *
 * @typedef {object} PolicySource
 * @property {PolicyLevel} level
 * @property {string | null} origin For `tag`, the path of the `tags.yaml` entry that carries the setting (an ancestor of the post's tag, or the tag itself); for `post`, the post file; for `image`, the key in the post's `images:` map; null for `site`.
 */

/**
 * One resolved setting.
 *
 * @template {string} V
 * @typedef {object} PolicyDecision
 * @property {V} value
 * @property {PolicySource} source
 */

/**
 * The effective policy of one image.
 *
 * @typedef {object} ImagePolicy
 * @property {PolicyDecision<'strip' | 'coarse' | 'keep'>} location
 * @property {PolicyDecision<'strip' | 'keep'>} camera
 */

/**
 * The overrides of one image in a post's `images:` map; null for a setting the
 * image leaves to the levels above.
 *
 * @typedef {object} ImageOverride
 * @property {string | null} location As written; checked when the policy is resolved.
 * @property {string | null} camera As written; checked when the policy is resolved.
 */

/**
 * The site-wide settings (`location` in the configuration).
 *
 * @typedef {object} SitePolicy
 * @property {string} default Location policy.
 * @property {string} camera Camera policy.
 */

/**
 * The tag settings, as read from `tags.yaml`.
 *
 * @typedef {object} TagPolicy
 * @property {string | null} location As written; checked when the resolver is created.
 * @property {string | null} camera As written; checked when the resolver is created.
 */

/**
 * The parts of a post the policy depends on.
 *
 * @typedef {object} PolicyPost
 * @property {string} file Path shown in messages.
 * @property {readonly string[]} tags Normalized tag paths.
 * @property {string | null} location As written; checked when the policy is resolved.
 * @property {string | null} camera As written; checked when the policy is resolved.
 * @property {ReadonlyMap<string, ImageOverride>} images The `images:` map of the front matter, by normalized key.
 */

/**
 * Raised when a policy value is not one the setting accepts. Every problem is
 * listed in {@link PolicyError#errors}; the message joins them.
 */
export class PolicyError extends Error {
  /**
   * @param {string[]} errors One entry per problem, each starting with the file path.
   */
  constructor(errors) {
    super(errors.join('\n'));
    this.name = 'PolicyError';
    /** @type {string[]} */
    this.errors = errors;
  }
}

/** @type {Readonly<Record<PolicySetting, readonly string[]>>} */
const ACCEPTED = Object.freeze({ location: LOCATION_POLICIES, camera: CAMERA_POLICIES });

/**
 * Explains why a value is not accepted for a setting.
 *
 * @param {PolicySetting} setting
 * @param {unknown} value
 * @returns {string | null} The reason, or null when the value is accepted.
 */
export function policyValueProblem(setting, value) {
  const accepted = ACCEPTED[setting];
  if (typeof value === 'string' && accepted.includes(value)) return null;
  return `must be one of: ${accepted.join(', ')}`;
}

/**
 * The key under which an image is listed in a post's `images:` map: the path
 * of the image as the post refers to it, with `/` separators, without a
 * leading `./`, and with percent escapes decoded.
 *
 * @param {string} reference A path written in the front matter or in Markdown.
 * @returns {string}
 */
export function normalizeImageKey(reference) {
  let key = reference.trim().replaceAll('\\', '/');
  try {
    key = decodeURI(key);
  } catch {
    // Not a valid percent escape: the text is taken as it is.
  }
  const segments = key.split('/').filter((segment) => segment !== '' && segment !== '.');
  return segments.join('/');
}

/**
 * Finds the entry of a post's `images:` map for an image.
 *
 * A key matches the image whose normalized path it equals. A key that is a bare
 * file name, with no folder, also matches an image of that name in a
 * sub-folder of the post.
 *
 * @param {ReadonlyMap<string, ImageOverride>} images
 * @param {string} reference The image as the post refers to it.
 * @returns {{ key: string, override: ImageOverride } | null}
 */
export function findImageOverride(images, reference) {
  if (images.size === 0) return null;
  const path = normalizeImageKey(reference);
  const exact = images.get(path);
  if (exact !== undefined) return { key: path, override: exact };
  const name = path.slice(path.lastIndexOf('/') + 1);
  if (name !== path) {
    const byName = images.get(name);
    if (byName !== undefined) return { key: name, override: byName };
  }
  return null;
}

/**
 * Words for a source, for messages and the build report.
 *
 * @param {PolicySource} source
 * @returns {string}
 */
export function describeSource(source) {
  switch (source.level) {
    case 'site':
      return 'the site configuration';
    case 'tag':
      return `tag "${source.origin}" in tags.yaml`;
    case 'post':
      return `the front matter of ${source.origin}`;
    default:
      return `images entry "${source.origin}" in the front matter`;
  }
}

/**
 * Walks from a tag towards the root and returns the first entry that has the
 * setting.
 *
 * @param {ReadonlyMap<string, TagPolicy>} tagPolicies
 * @param {string} tag
 * @param {PolicySetting} setting
 * @returns {{ path: string, value: string } | null}
 */
function nearestTagSetting(tagPolicies, tag, setting) {
  let path = tag;
  for (;;) {
    const value = tagPolicies.get(path)?.[setting];
    if (value !== null && value !== undefined) return { path, value };
    const cut = path.lastIndexOf('/');
    if (cut < 0) return null;
    path = path.slice(0, cut);
  }
}

/**
 * What the tags of a post say about a setting: the strictest of the values the
 * tags give, or null when no tag gives one. When several tags give the strictest
 * value, the first in the post's tag order is named.
 *
 * @param {ReadonlyMap<string, TagPolicy>} tagPolicies
 * @param {readonly string[]} tags
 * @param {PolicySetting} setting
 * @returns {{ path: string, value: string } | null}
 */
function strictestTagSetting(tagPolicies, tags, setting) {
  const accepted = ACCEPTED[setting];
  /** @type {{ path: string, value: string } | null} */
  let best = null;
  for (const tag of tags) {
    const found = nearestTagSetting(tagPolicies, tag, setting);
    if (found === null) continue;
    if (best === null || accepted.indexOf(found.value) < accepted.indexOf(best.value)) best = found;
  }
  return best;
}

/**
 * Creates the function that resolves the policy of images. The site settings
 * and the entries of `tags.yaml` are checked once, here, whether or not a post
 * uses them, so that a typo in a rarely used tag does not wait for its post to
 * fail the build.
 *
 * @param {object} inputs
 * @param {SitePolicy} inputs.site The `location` section of the configuration.
 * @param {ReadonlyMap<string, TagPolicy>} [inputs.tags] Settings of the tags, by normalized tag path.
 * @param {string} [inputs.tagsFile] Path of `tags.yaml`, shown in messages.
 * @returns {(post: PolicyPost, image?: string) => ImagePolicy} Resolves the policy for an image of a post, given the image as the post refers to it; without an image, the policy of the post's images that have no override of their own.
 * @throws {PolicyError} When a site or tag value is not accepted.
 */
export function createPolicyResolver({ site, tags = new Map(), tagsFile = 'tags.yaml' }) {
  /** @type {string[]} */
  const problems = [];
  /** @type {[PolicySetting, unknown][]} */
  const siteValues = [
    ['location', site.default],
    ['camera', site.camera],
  ];
  for (const [setting, value] of siteValues) {
    const problem = policyValueProblem(setting, value);
    if (problem !== null) {
      problems.push(`location.${setting === 'location' ? 'default' : 'camera'}: ${problem}`);
    }
  }
  for (const [path, entry] of tags) {
    for (const setting of /** @type {PolicySetting[]} */ (['location', 'camera'])) {
      const value = entry[setting];
      if (value === null || value === undefined) continue;
      const problem = policyValueProblem(setting, value);
      if (problem !== null) problems.push(`${tagsFile}: ${path}.${setting}: ${problem}`);
    }
  }
  if (problems.length > 0) throw new PolicyError(problems);

  return (post, image) => {
    const own = [];
    for (const setting of /** @type {PolicySetting[]} */ (['location', 'camera'])) {
      const value = post[setting];
      if (value === null) continue;
      const problem = policyValueProblem(setting, value);
      if (problem !== null) own.push(`${post.file}: ${setting}: ${problem}`);
    }
    for (const [key, override] of post.images) {
      for (const setting of /** @type {PolicySetting[]} */ (['location', 'camera'])) {
        const value = override[setting];
        if (value === null) continue;
        const problem = policyValueProblem(setting, value);
        if (problem !== null) own.push(`${post.file}: images.${key}.${setting}: ${problem}`);
      }
    }
    if (own.length > 0) throw new PolicyError(own);

    const found = image === undefined ? null : findImageOverride(post.images, image);

    /**
     * @param {PolicySetting} setting
     * @returns {PolicyDecision<any>}
     */
    const decide = (setting) => {
      const imageValue = found?.override[setting];
      if (found !== null && imageValue !== null && imageValue !== undefined) {
        return { value: imageValue, source: { level: 'image', origin: found.key } };
      }
      const postValue = post[setting];
      if (postValue !== null) {
        return { value: postValue, source: { level: 'post', origin: post.file } };
      }
      const fromTags = strictestTagSetting(tags, post.tags, setting);
      if (fromTags !== null) {
        return { value: fromTags.value, source: { level: 'tag', origin: fromTags.path } };
      }
      return {
        value: setting === 'location' ? site.default : site.camera,
        source: { level: 'site', origin: null },
      };
    };

    return { location: decide('location'), camera: decide('camera') };
  };
}
