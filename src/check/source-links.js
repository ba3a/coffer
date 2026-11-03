import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';

import { mapHtmlUrls } from '../html-urls.js';

/**
 * @typedef {import('../content/posts.js').Post} Post
 * @typedef {import('../markdown/render.js').FoundLink} FoundLink
 * @typedef {import('../report.js').ReportIssue} ReportIssue
 */

/**
 * A post as the link check sees it.
 *
 * @typedef {object} SourcePost
 * @property {Post} post
 * @property {string} url Site-relative canonical URL of the post, ending in a slash.
 * @property {{ links: FoundLink[], ids: string[] } | null} rendered What the Markdown renderer found in the text, or null when the post is not part of this build (a draft, or a post dated in the future, in a normal build).
 */

/**
 * @typedef {object} SourceLinkOptions
 * @property {SourcePost[]} posts Every post of the site, built or not; the unbuilt ones let a link to them be explained.
 * @property {string} rootDir Directory that file names in the findings are relative to (the one holding the configuration file).
 * @property {string} contentDir Absolute path of the content directory; relative links and images must stay inside it.
 * @property {Set<string> | ReadonlySet<string>} projects Slugs of the registered projects.
 */

/**
 * Outcome of {@link checkSourceLinks}.
 *
 * @typedef {object} SourceLinkResult
 * @property {ReportIssue[]} issues Findings so far: every broken relative link, anchor, image and project reference.
 * @property {Map<Post, Map<string, string>>} rewrites For each post, the links to other posts as written, mapped to the canonical URL of the target (anchor and query kept). Apply them with {@link applyLinkRewrites}.
 * @property {(urlExists: (path: string) => boolean) => ReportIssue[]} verifyOutput Checks the links that start with `/` once the site's pages exist. `urlExists` receives a decoded site path such as `/journal/x/` or `/assets/site.css` and tells whether the output serves it. Returns the findings.
 */

const SCHEME_RE = /^([a-z][a-z0-9+.-]*):/i;

/** The slug of a `project:slug` reference is the text after the scheme, up to a query or an anchor. */
export const PROJECT_SCHEME = 'project';

/** Anchor that browsers accept for the top of any page. */
const TOP_ANCHOR = 'top';

/**
 * @param {string} text
 * @returns {string} The text with percent escapes decoded; unchanged when it holds a broken escape.
 */
function decode(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * @param {string} file
 * @returns {boolean}
 */
function isFile(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * Whether `target` is `root` or lies below it.
 *
 * @param {string} root
 * @param {string} target
 * @returns {boolean}
 */
function isInside(root, target) {
  const path = relative(root, target);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

/**
 * Lists the registered projects of a projects directory: the folders that
 * hold a `project.yaml`, each named by its slug.
 *
 * @param {string | null | undefined} dir Absolute path of the projects directory, or null when the site has none.
 * @returns {Set<string>}
 */
export function listProjectSlugs(dir) {
  /** @type {Set<string>} */
  const slugs = new Set();
  if (!dir || !existsSync(dir)) return slugs;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.name.startsWith('.') && isFile(join(dir, entry.name, 'project.yaml'))) {
      slugs.add(entry.name);
    }
  }
  return slugs;
}

/**
 * Why a post that exists is not part of the build.
 *
 * @param {Post} post
 * @returns {string}
 */
function unbuiltReason(post) {
  return post.draft ? 'the post is a draft' : 'the post is not published yet';
}

/**
 * Resolves every Markdown link and image of the posts of a site, for what can
 * be decided from the sources alone:
 *
 * - a relative link to another post's folder or file (`../other/`,
 *   `../other/index.md`, `../other.md`) must name a post that is part of the
 *   build, and is rewritten to the post's canonical URL;
 * - `#anchor` and `../other/#anchor` must name an id in the post it points at;
 * - a relative image must be a file inside the content directory;
 * - a `project:slug` reference must name a registered project;
 * - a link that starts with `/` is collected, to be checked by `verifyOutput`
 *   once the site's pages exist;
 * - other links (`https:`, `mailto:` and so on) are not checked here.
 *
 * Nothing is thrown: findings are returned, each located in its file by line
 * and column.
 *
 * @param {SourceLinkOptions} options
 * @returns {SourceLinkResult}
 */
export function checkSourceLinks({ posts, rootDir, contentDir, projects }) {
  /** @type {Map<string, SourcePost>} */
  const byPath = new Map();
  /** @type {Map<string, SourcePost>} */
  const byUrl = new Map();
  for (const entry of posts) {
    const { post } = entry;
    byPath.set(resolve(post.file), entry);
    // A folder post is addressed by its folder; a single-file post by the name it would have as a folder.
    byPath.set(post.kind === 'folder' ? resolve(post.dir) : resolve(post.dir, post.slug), entry);
    byUrl.set(entry.url, entry);
  }

  /** @param {string} file */
  const shown = (file) => relative(rootDir, file).split(sep).join('/');

  /** @type {ReportIssue[]} */
  const issues = [];
  /** @type {Map<Post, Map<string, string>>} */
  const rewrites = new Map();
  /** @type {{ entry: SourcePost, link: FoundLink, path: string, fragment: string, display: string }[]} */
  const deferred = [];

  /**
   * @param {SourcePost} entry
   * @param {FoundLink} link
   * @param {string} message
   * @returns {ReportIssue}
   */
  const issue = (entry, link, message) => ({
    file: shown(entry.post.file),
    line: link.line,
    column: link.column,
    message,
  });

  /**
   * Checks the anchor of a link to a post that is part of the build.
   *
   * @param {SourcePost} target
   * @param {string} fragment
   * @returns {boolean}
   */
  const hasAnchor = (target, fragment) =>
    fragment === '' || fragment === TOP_ANCHOR || (target.rendered?.ids.includes(fragment) ?? false);

  /**
   * @param {SourcePost} entry
   * @param {FoundLink} link
   */
  const check = (entry, link) => {
    const raw = link.url;
    if (raw === '') return;
    const display = decode(raw);
    const isImage = link.kind === 'image';
    const scheme = SCHEME_RE.exec(raw);

    if (scheme) {
      if (scheme[1].toLowerCase() !== PROJECT_SCHEME) return;
      const slug = decode(raw.slice(scheme[0].length).split(/[?#]/, 1)[0]);
      if (!projects.has(slug)) {
        const known = [...projects].sort();
        const hint = known.length === 0 ? 'the site has no projects' : `registered: ${known.join(', ')}`;
        issues.push(issue(entry, link, `unknown project '${slug}' in '${display}' (${hint})`));
      }
      return;
    }
    if (raw.startsWith('//')) return;

    const cut = raw.search(/[?#]/);
    const rawPath = cut < 0 ? raw : raw.slice(0, cut);
    const suffix = cut < 0 ? '' : raw.slice(cut);
    const hashAt = suffix.indexOf('#');
    const fragment = hashAt < 0 ? '' : decode(suffix.slice(hashAt + 1));
    const path = decode(rawPath);

    if (path.startsWith('/')) {
      deferred.push({ entry, link, path, fragment, display });
      return;
    }

    if (path === '') {
      if (isImage) {
        issues.push(issue(entry, link, `missing image '${display}'`));
      } else if (!hasAnchor(entry, fragment)) {
        issues.push(issue(entry, link, `broken link '${display}' (this post has no heading or id '${fragment}')`));
      }
      return;
    }

    const target = resolve(dirname(entry.post.file), path);
    if (isImage) {
      if (!isInside(contentDir, target)) {
        issues.push(issue(entry, link, `missing image '${display}' (outside the content directory)`));
      } else if (!isFile(target)) {
        issues.push(issue(entry, link, `missing image '${display}'`));
      }
      return;
    }

    const hit = byPath.get(target);
    if (hit) {
      if (hit.rendered === null) {
        issues.push(issue(entry, link, `broken link '${display}' (${unbuiltReason(hit.post)})`));
      } else if (!hasAnchor(hit, fragment)) {
        issues.push(
          issue(entry, link, `broken link '${display}' (the target post has no heading or id '${fragment}')`),
        );
      } else {
        let map = rewrites.get(entry.post);
        if (!map) rewrites.set(entry.post, (map = new Map()));
        map.set(raw, `${hit.url}${suffix}`);
      }
      return;
    }
    if (!isInside(contentDir, target)) {
      issues.push(issue(entry, link, `broken link '${display}' (outside the content directory)`));
    } else if (isFile(target)) {
      // A file beside the post, such as a download, is not checked further. A Markdown file is
      // text meant to become a page, so a link to one that is not a post cannot work.
      if (/\.(md|markdown)$/i.test(target)) {
        issues.push(issue(entry, link, `broken link '${display}' (this Markdown file is not a post)`));
      }
    } else {
      issues.push(issue(entry, link, `broken link '${display}'`));
    }
  };

  for (const entry of posts) {
    if (entry.rendered === null) continue;
    for (const link of entry.rendered.links) check(entry, link);
  }

  return {
    issues,
    rewrites,
    verifyOutput(urlExists) {
      /** @type {ReportIssue[]} */
      const found = [];
      for (const { entry, link, path, fragment, display } of deferred) {
        const isImage = link.kind === 'image';
        const normalized = posix.normalize(path);
        const hit = byUrl.get(normalized.endsWith('/') ? normalized : `${normalized}/`);
        if (hit && !isImage) {
          if (hit.rendered === null) {
            found.push(issue(entry, link, `broken link '${display}' (${unbuiltReason(hit.post)})`));
          } else if (!hasAnchor(hit, fragment)) {
            found.push(
              issue(entry, link, `broken link '${display}' (the target post has no heading or id '${fragment}')`),
            );
          }
        } else if (!urlExists(normalized)) {
          found.push(issue(entry, link, isImage ? `missing image '${display}'` : `broken link '${display}'`));
        }
      }
      return found;
    },
  };
}

/**
 * Replaces the `href` of every link in rendered HTML whose value, as written,
 * is a key of `rewrites`.
 *
 * @param {string} html
 * @param {ReadonlyMap<string, string> | undefined} rewrites As returned for a post by {@link checkSourceLinks}.
 * @returns {string}
 */
export function applyLinkRewrites(html, rewrites) {
  if (rewrites === undefined || rewrites.size === 0) return html;
  return mapHtmlUrls(html, (url, site) =>
    site.tag === 'a' && site.attribute === 'href' ? (rewrites.get(url) ?? url) : url,
  );
}
