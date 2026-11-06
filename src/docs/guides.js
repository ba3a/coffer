import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, posix } from 'node:path';

import { applyLinkRewrites } from '../check/source-links.js';
import { withoutMapPlaceholders } from '../geo/post-maps.js';
import { excerptOf } from '../feeds.js';
import { mapHtmlUrls } from '../html-urls.js';
import { IMAGE_EXTENSIONS } from '../images/defaults.js';
import { decodeEntities } from '../xml.js';
import { GlobError, compileGlob, matchGlob } from './glob.js';
import { resolveInside } from './sources.js';

/**
 * The guides of a project's documentation.
 *
 * {@link planGuides} picks the Markdown files of the fetched source that are
 * published (the `guides` of the `docs` block), reads them, and gives each one
 * its address and its place in the sidebar. The build renders them with the
 * site's Markdown pipeline, then {@link resolveGuideLinks} decides where every
 * link of every page leads and {@link finishGuidePage} makes the HTML ready for
 * the template.
 *
 * The files are untrusted repository content. Every file is reached through
 * `resolveInside` (a symbolic link that leads out of the repository is refused),
 * files and the number of pages are bounded, and every finding names the file
 * as `{repo}:{path}` with the line when there is one.
 */

/** The most pages one project can publish. */
export const MAX_GUIDE_PAGES = 500;

/** The largest guide file, in bytes. */
export const MAX_GUIDE_FILE_BYTES = 1024 * 1024;

/** The most directory entries looked at in one guide folder. */
export const MAX_GUIDE_ENTRIES = 20_000;

/** A path longer than this is not looked at. */
const MAX_PATH_LENGTH = 1000;

/** Folders that are never searched for guides. */
const SKIPPED_FOLDERS = new Set(['.git', 'node_modules']);

/** The first segment of a page address that belongs to the docs section itself. */
export const RESERVED_PAGE_SLUGS = Object.freeze(['reference', 'search']);

/** The links a guide can have besides links to files: these schemes only. */
const ALLOWED_SCHEMES = new Set(['http', 'https', 'mailto']);

/** The branch a link points at when the source is a folder that is not a repository of its own. */
export const DEFAULT_GITHUB_REF = 'main';

/**
 * A finding of the guides, located as `{repo}:{path}` (and the line).
 *
 * @typedef {object} GuideIssue
 * @property {string} message
 * @property {string} [file] `{repo}:{path}` of the guide file.
 * @property {number} [line]
 * @property {number} [column]
 */

/**
 * A published guide file, read.
 *
 * @typedef {object} GuidePage
 * @property {string} rel Path from the root of the source, with `/`.
 * @property {string} inGuide Path from the folder of the guide, with `/`.
 * @property {number} guide Index of the guide in the `guides` list.
 * @property {string} label `{repo}:{path}`, how findings name the file.
 * @property {string} text The Markdown, without a byte order mark, with `\n` line ends.
 * @property {string} slug Address of the page below the docs index (`usage`, `api/errors`); empty for the docs index.
 * @property {boolean} isIndex Whether this page is the docs index.
 */

/**
 * What {@link planGuides} returns.
 *
 * @typedef {object} GuidePlan
 * @property {string} repo The name findings use for the source.
 * @property {GuidePage[]} pages In sidebar order, the docs index (when a file is) first.
 * @property {GuideIssue[]} issues Errors: the build fails.
 * @property {string[]} warnings
 */

/**
 * @param {import('./sources.js').FetchedDocs} fetched
 * @returns {string} The name findings use: the folder name for a folder source, the GitHub repository name (else the project slug) for a git one.
 */
export function repoLabelOf(fetched) {
  if (fetched.source.type === 'path') return basename(fetched.root) || fetched.slug;
  return fetched.github?.split('/')[1] ?? fetched.slug;
}

/**
 * The branch, tag or commit that links to files of the repository point at.
 * A git source: the configured ref. A folder: the commit, when the folder is
 * the root of a repository of its own (it has a `.git`) and the commit is
 * known, because a commit never moves; otherwise `main`, because the commit of
 * a larger repository that merely holds the folder is not one of the GitHub
 * repository.
 *
 * @param {import('./sources.js').FetchedDocs} fetched
 * @returns {string}
 */
export function githubRefOf(fetched) {
  const { source } = fetched;
  if (source.type === 'git') return source.ref;
  if (source.sha !== null && hasEntry(fetched.root, '.git')) return source.sha;
  return DEFAULT_GITHUB_REF;
}

/**
 * @param {string} dir
 * @param {string} name
 * @returns {boolean}
 */
function hasEntry(dir, name) {
  try {
    statSync(join(dir, name));
    return true;
  } catch {
    return false;
  }
}

/**
 * The address of a file or a folder of the repository on GitHub.
 *
 * @param {object} target
 * @param {string} target.github `owner/repo`.
 * @param {string} target.ref Branch, tag or commit.
 * @param {'blob' | 'tree'} target.kind `blob` for a file, `tree` for a folder.
 * @param {string} target.path Path from the root of the repository, with `/`; empty for the root.
 * @param {string} [target.fragment] Anchor, with its `#`, or empty.
 * @returns {string}
 */
export function githubUrl({ github, ref, kind, path, fragment = '' }) {
  const encode = (/** @type {string} */ text) => text.split('/').filter((part) => part !== '').map(encodeURIComponent).join('/');
  const where = path === '' ? '' : `/${encode(path)}`;
  const anchor = fragment.length > 1 ? `#${encodeURIComponent(decodeSafe(fragment.slice(1)))}` : '';
  return `https://github.com/${github}/${kind}/${encode(ref)}${where}${anchor}`;
}

/**
 * @param {string} text
 * @returns {string}
 */
function decodeSafe(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * Code-point order, the same on every machine.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function byCodePoint(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The last part of an address for a name: lower case letters and digits, with
 * single dashes between words.
 *
 * @param {string} name
 * @returns {string}
 */
export function slugOf(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * A readable title from a file name: `getting-started.md` is "Getting Started".
 *
 * @param {string} name
 * @returns {string}
 */
export function titleFromName(name) {
  const stem = name.replace(/\.(?:md|markdown)$/i, '');
  const words = stem.split(/[-_.\s]+/).filter((word) => word !== '');
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ') || stem;
}

const MARKDOWN_FILE = /\.(?:md|markdown)$/i;

/**
 * Lists the files of a guide that its patterns select, as paths from the
 * guide's folder. Symbolic links to folders are not followed (so a link cannot
 * make the search leave the repository or loop); a symbolic link to a file is a
 * candidate and is checked when the file is read.
 *
 * @param {string} guideReal Real path of the guide's folder.
 * @param {import('./sources.js').DocsGuide} guide
 * @param {(issue: GuideIssue) => void} report
 * @param {string} repo
 * @returns {string[]} Sorted by code point.
 */
function selectFiles(guideReal, guide, report, repo) {
  /** @type {import('./glob.js').CompiledGlob[]} */
  let include;
  /** @type {import('./glob.js').CompiledGlob[]} */
  let exclude;
  try {
    include = guide.include.map((pattern) => compileGlob(pattern));
    exclude = guide.exclude.map((pattern) => compileGlob(pattern));
  } catch (error) {
    if (!(error instanceof GlobError)) throw error;
    report({ file: `${repo}:${guide.dir}`, message: `guides: ${error.message}` });
    return [];
  }
  /** @type {string[]} */
  const found = [];
  /** @type {string[]} */
  const stack = [''];
  let visited = 0;
  while (stack.length > 0) {
    const relDir = /** @type {string} */ (stack.pop());
    let entries;
    try {
      entries = readdirSync(relDir === '' ? guideReal : join(guideReal, ...relDir.split('/')), { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => byCodePoint(a.name, b.name));
    for (const entry of entries) {
      visited += 1;
      if (visited > MAX_GUIDE_ENTRIES) {
        report({ file: `${repo}:${guide.dir}`, message: `the guide folder has more than ${MAX_GUIDE_ENTRIES} entries; narrow "dir" to the folder that holds the guides` });
        return found.sort(byCodePoint);
      }
      const path = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIPPED_FOLDERS.has(entry.name)) stack.push(path);
        continue;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      if (!MARKDOWN_FILE.test(entry.name) || path.length > MAX_PATH_LENGTH) continue;
      if (include.some((glob) => matchGlob(glob, path)) && !exclude.some((glob) => matchGlob(glob, path))) found.push(path);
    }
  }
  return found.sort(byCodePoint);
}

/**
 * Reads a guide file.
 *
 * @param {string} root
 * @param {string} rel
 * @param {string} label
 * @param {(issue: GuideIssue) => void} report
 * @returns {string | null} The text, or null when it cannot be used (reported).
 */
function readGuideFile(root, rel, label, report) {
  const found = resolveInside(root, rel);
  if (!found.ok) {
    report({
      file: label,
      message: found.reason === 'outside' ? 'the file leads out of the repository (a symbolic link points outside it) and is not read' : `the file cannot be read: ${found.message}`,
    });
    return null;
  }
  /** @type {Buffer} */
  let bytes;
  try {
    const stat = statSync(found.path);
    if (!stat.isFile()) return null;
    if (stat.size > MAX_GUIDE_FILE_BYTES) {
      report({ file: label, message: `the file is ${stat.size} bytes; a guide can have at most ${MAX_GUIDE_FILE_BYTES} bytes` });
      return null;
    }
    bytes = readFileSync(found.path);
  } catch (error) {
    report({ file: label, message: `the file cannot be read: ${error instanceof Error ? error.message : String(error)}` });
    return null;
  }
  try {
    // The decoder drops a byte order mark; invalid UTF-8 is an error rather than replacement characters.
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\r\n?/g, '\n');
  } catch {
    report({ file: label, message: 'the file is not valid UTF-8' });
    return null;
  }
}

/**
 * The address of a page below the docs index, from its path in the guide.
 *
 * @param {string} inGuide
 * @returns {{ slug: string } | { problem: string }}
 */
function slugFromPath(inGuide) {
  const segments = inGuide.split('/');
  const last = /** @type {string} */ (segments.pop()).replace(MARKDOWN_FILE, '');
  // A README or an index file of a folder stands for the folder.
  if (segments.length > 0 && /^(?:readme|index)$/i.test(last)) {
    /* the folder's own address */
  } else {
    segments.push(last);
  }
  const parts = segments.map(slugOf);
  if (parts.some((part) => part === '')) {
    return { problem: `no address can be made from the path "${inGuide}" (use letters and digits in the names of files and folders)` };
  }
  return { slug: parts.join('/') };
}

/**
 * Picks, reads and orders the guide files of a fetched source.
 *
 * Which files: those the patterns of a guide select, `.md` and `.markdown`
 * only. Which order: for each guide, the files named in `order` first, in that
 * order, then the others by path; guides in the order they are listed. The
 * docs index is the `index.md` (else `README.md`) in the folder of the first
 * guide, and comes first. A file selected by two guides belongs to the first.
 *
 * @param {import('./sources.js').FetchedDocs} fetched
 * @returns {GuidePlan}
 */
export function planGuides(fetched) {
  const repo = repoLabelOf(fetched);
  /** @type {GuideIssue[]} */
  const issues = [];
  /** @type {string[]} */
  const warnings = [];
  /** @param {GuideIssue} issue */
  const report = (issue) => issues.push(issue);

  /** @type {{ rel: string, inGuide: string, guide: number }[]} */
  const selected = [];
  /** @type {Set<string>} */
  const seen = new Set();
  for (const [index, guide] of fetched.guides.entries()) {
    const dir = resolveInside(fetched.root, guide.dir);
    if (!dir.ok) {
      report({ file: `${repo}:${guide.dir}`, message: `the guide folder cannot be used: ${dir.message}` });
      continue;
    }
    const files = selectFiles(dir.path, guide, report, repo).filter((inGuide) => {
      const rel = guide.dir === '.' ? inGuide : `${guide.dir}/${inGuide}`;
      if (seen.has(rel)) return false;
      seen.add(rel);
      return true;
    });
    if (files.length === 0 && !issues.some((issue) => issue.file === `${repo}:${guide.dir}`)) {
      report({
        file: `${repo}:${guide.dir}`,
        message: `the guide "${guide.dir}" selects no Markdown file (include: ${guide.include.join(', ')}${guide.exclude.length > 0 ? `; exclude: ${guide.exclude.join(', ')}` : ''}); there is no fallback to empty documentation, fix "guides" or remove the guide`,
      });
    }
    for (const name of guide.order) {
      if (!files.includes(name)) {
        warnings.push(`${repo}:${guide.dir}: "order" lists "${name}", which is not one of the published files of the guide`);
      }
    }
    const ordered = [...guide.order.filter((name) => files.includes(name)), ...files.filter((name) => !guide.order.includes(name))];
    for (const inGuide of ordered) {
      selected.push({ rel: guide.dir === '.' ? inGuide : `${guide.dir}/${inGuide}`, inGuide, guide: index });
    }
  }
  if (selected.length > MAX_GUIDE_PAGES) {
    issues.push({ message: `${repo}: the guides select ${selected.length} files; a project can publish at most ${MAX_GUIDE_PAGES} pages (narrow "include" or add "exclude")` });
    return { repo, pages: [], issues, warnings };
  }

  // The docs index: index.md, else README.md, in the root of the first guide.
  const rootNames = selected.filter((entry) => entry.guide === 0 && !entry.inGuide.includes('/')).map((entry) => entry.inGuide);
  const indexName =
    rootNames.find((name) => /^index\.(?:md|markdown)$/i.test(name)) ?? rootNames.find((name) => /^readme\.(?:md|markdown)$/i.test(name));

  /** @type {GuidePage[]} */
  const pages = [];
  /** @type {Map<string, GuidePage>} */
  const bySlug = new Map();
  for (const entry of selected) {
    const label = `${repo}:${entry.rel}`;
    const text = readGuideFile(fetched.root, entry.rel, label, report);
    if (text === null) continue;
    const isIndex = entry.guide === 0 && entry.inGuide === indexName;
    let slug = '';
    if (!isIndex) {
      const made = slugFromPath(entry.inGuide);
      if ('problem' in made) {
        report({ file: label, message: made.problem });
        continue;
      }
      slug = made.slug;
      if (RESERVED_PAGE_SLUGS.includes(slug.split('/')[0])) {
        report({ file: label, message: `the address "${slug}" belongs to the documentation itself (${RESERVED_PAGE_SLUGS.join(', ')}); rename the file or the folder` });
        continue;
      }
      const other = bySlug.get(slug);
      if (other) {
        report({ file: label, message: `has the same address as ${other.rel} (${slug}); rename one of the files` });
        continue;
      }
    }
    /** @type {GuidePage} */
    const page = { rel: entry.rel, inGuide: entry.inGuide, guide: entry.guide, label, text, slug, isIndex };
    if (!isIndex) bySlug.set(slug, page);
    pages.push(page);
  }
  // The index comes first in the sidebar.
  pages.sort((a, b) => Number(b.isIndex) - Number(a.isIndex));
  return { repo, pages, issues, warnings };
}

// ---------------------------------------------------------------------------
// Links

const SCHEME = /^([a-z][a-z0-9+.-]*):/i;

/**
 * The URL as a browser reads it for its scheme: white space and control
 * characters inside it are ignored (`java\tscript:` is `javascript:`).
 *
 * @param {string} url
 * @returns {string}
 */
function compact(url) {
  // eslint-disable-next-line no-control-regex
  return url.replace(/[\u0000- \u007f-\u009f]/g, '');
}

/**
 * @param {string} url
 * @returns {string | null} The lower-case scheme of the URL, or null when it has none.
 */
function schemeOf(url) {
  const match = SCHEME.exec(compact(url));
  return match ? match[1].toLowerCase() : null;
}

/**
 * @param {string[]} ids
 * @param {string} fragment Decoded.
 * @returns {boolean}
 */
function hasAnchor(ids, fragment) {
  return fragment === '' || fragment === 'top' || ids.includes(fragment);
}

/**
 * What a rendered page tells the link check.
 *
 * @typedef {object} RenderedGuide
 * @property {import('../markdown/render.js').FoundLink[]} links
 * @property {string[]} ids
 */

/**
 * @typedef {object} GuideLinkOptions
 * @property {string} root Absolute path of the source.
 * @property {string} repo See {@link repoLabelOf}.
 * @property {string | null} github `owner/repo`, or null when unknown.
 * @property {string} ref See {@link githubRefOf}.
 * @property {(page: GuidePage) => string} urlOf Site-relative address of a published page.
 * @property {string} indexUrl Site-relative address of the docs index.
 * @property {ReadonlyMap<GuidePage, RenderedGuide>} rendered
 */

/**
 * @typedef {object} GuideLinkResult
 * @property {GuideIssue[]} issues
 * @property {Map<GuidePage, Map<string, string>>} rewrites For each page, the links as written, mapped to where they lead on the site or on GitHub. Apply them with `applyLinkRewrites`.
 * @property {Map<GuidePage, Set<string>>} refused For each page, the links (as written) whose scheme is refused.
 */

/**
 * Decides where every link of every page leads.
 *
 * A link is resolved from the folder of the page that holds it (`/path` from
 * the root of the repository, as on GitHub):
 *
 * - a link to another published guide file, README or index of the first guide
 *   included, becomes the address of its page, the anchor and the query kept;
 *   an anchor must be a heading or id of that page;
 * - a link to a file or folder of the repository that is not published (source,
 *   `LICENSE`, `../CHANGELOG.md`) becomes its address on GitHub (`blob` for a
 *   file, `tree` for a folder); without a `github` setting that is an error;
 * - a link to something that does not exist, or that leaves the repository, is
 *   an error;
 * - `http:`, `https:` and `mailto:` links and `//host` links are left alone; any
 *   other scheme is refused;
 * - `#anchor` must be a heading or id of the page.
 *
 * Images are not links here: the build resolves them with {@link locateGuideImage}.
 *
 * @param {readonly GuidePage[]} pages
 * @param {GuideLinkOptions} options
 * @returns {GuideLinkResult}
 */
export function resolveGuideLinks(pages, { root, repo, github, ref, urlOf, indexUrl, rendered }) {
  /** @type {Map<string, GuidePage>} */
  const byRel = new Map(pages.map((page) => [page.rel, page]));
  const index = pages.find((page) => page.isIndex);
  const indexDir = index ? posix.dirname(index.rel) : null;
  /** @type {GuideIssue[]} */
  const issues = [];
  /** @type {Map<GuidePage, Map<string, string>>} */
  const rewrites = new Map();
  /** @type {Map<GuidePage, Set<string>>} */
  const refused = new Map();
  /** @type {Map<string, Set<string>>} */
  const listings = new Map();

  /**
   * @param {string} dir Absolute real path of a folder of the source.
   * @returns {Set<string>}
   */
  const namesIn = (dir) => {
    let names = listings.get(dir);
    if (!names) {
      try {
        names = new Set(readdirSync(dir));
      } catch {
        names = new Set();
      }
      listings.set(dir, names);
    }
    return names;
  };

  /**
   * Whether every part of the path has exactly the case it is written in, so a
   * link that works on a case-insensitive disk does not break on GitHub.
   *
   * @param {string} path
   * @returns {boolean}
   */
  const exactCase = (path) => {
    const base = resolveInside(root, '.');
    if (!base.ok) return false;
    let dir = base.path;
    for (const part of path.split('/')) {
      if (!namesIn(dir).has(part)) return false;
      dir = join(dir, part);
    }
    return true;
  };

  for (const page of pages) {
    const found = rendered.get(page);
    if (!found) continue;
    /** @type {Map<string, string>} */
    const map = new Map();
    rewrites.set(page, map);
    /** @type {Set<string>} */
    const refusedHere = new Set();
    refused.set(page, refusedHere);
    for (const link of found.links) {
      if (link.kind === 'image') {
        // The build reports images when it resolves them; the address is only noted here, so that it is not reported again.
        const imageScheme = schemeOf(link.url);
        if (imageScheme !== null && !ALLOWED_SCHEMES.has(imageScheme)) refusedHere.add(link.url);
        continue;
      }
      if (link.url === '') continue;
      const raw = link.url;
      const shown = decodeSafe(raw);
      /**
       * @param {string} message
       */
      const fail = (message) => issues.push({ file: page.label, line: link.line, column: link.column, message });

      const scheme = schemeOf(raw);
      if (scheme !== null) {
        if (!ALLOWED_SCHEMES.has(scheme)) {
          refusedHere.add(raw);
          fail(`refused link '${raw.length > 80 ? `${raw.slice(0, 80)}...` : raw}': a guide can link with http:, https: or mailto: only, not ${scheme}:`);
        }
        continue;
      }
      if (compact(raw).startsWith('//')) continue;

      const cut = raw.search(/[?#]/);
      const rawPath = cut < 0 ? raw : raw.slice(0, cut);
      const suffix = cut < 0 ? '' : raw.slice(cut);
      const hashAt = suffix.indexOf('#');
      const fragment = hashAt < 0 ? '' : decodeSafe(suffix.slice(hashAt + 1));

      if (rawPath === '') {
        if (!hasAnchor(found.ids, fragment)) fail(`broken link '${shown}' (this page has no heading or id '${fragment}')`);
        continue;
      }

      const path = decodeSafe(rawPath);
      let target = path.startsWith('/') ? posix.normalize(path.slice(1) || '.') : posix.normalize(posix.join(posix.dirname(page.rel), path));
      target = target.replace(/\/+$/, '');
      if (target === '..' || target.startsWith('../')) {
        fail(`broken link '${shown}' (it leads out of the repository)`);
        continue;
      }
      if (target === '') target = '.';

      const published = byRel.get(target);
      if (published) {
        const other = rendered.get(published);
        if (other && !hasAnchor(other.ids, fragment)) {
          fail(`broken link '${shown}' (${published.rel} has no heading or id '${fragment}')`);
        } else {
          map.set(raw, `${urlOf(published)}${suffix}`);
        }
        continue;
      }
      if (indexDir !== null && target === indexDir && index) {
        map.set(raw, `${indexUrl}${suffix}`);
        continue;
      }

      const resolved = resolveInside(root, target);
      if (!resolved.ok) {
        if (resolved.reason === 'missing') fail(`broken link '${shown}' (${target} does not exist in the repository)`);
        else if (resolved.reason === 'outside') fail(`broken link '${shown}' (${target} leads out of the repository)`);
        else fail(`broken link '${shown}' (${resolved.message})`);
        continue;
      }
      if (target !== '.' && !exactCase(target)) {
        fail(`broken link '${shown}' (${target} does not exist with exactly this capitalisation; GitHub and most systems tell "Usage.md" from "usage.md")`);
        continue;
      }
      let kind;
      try {
        kind = statSync(resolved.path).isDirectory() ? 'tree' : 'blob';
      } catch {
        fail(`broken link '${shown}' (${target} cannot be read)`);
        continue;
      }
      if (github === null) {
        fail(`link '${shown}' leads to ${target}, a file of the repository that is not published, and a link to it needs the "github" setting (owner/repo) in the "docs" block of project.yaml`);
        continue;
      }
      map.set(raw, githubUrl({ github, ref, kind: /** @type {'blob' | 'tree'} */ (kind), path: target === '.' ? '' : target, fragment: hashAt < 0 ? '' : suffix.slice(hashAt) }));
    }
  }
  return { issues, rewrites, refused };
}

/**
 * Finds the file an image of a guide names, for the image pipeline.
 *
 * The address is read from the folder of the page (`/path` from the root of the
 * repository, as on GitHub); remote images (`http:`, `https:`) are left as they
 * are; other schemes (`data:`, `javascript:`) are refused. The file has to
 * exist inside the repository, as a JPEG, PNG, WebP or HEIC picture. SVG is not
 * published from a guide: it can carry script and its text cannot be turned into
 * the variants the pipeline makes, so the author converts it to a raster picture.
 *
 * @param {string} root
 * @param {string} pageRel Path of the page that holds the image, from the root, with `/`.
 * @param {string} src The address as written.
 * @returns {{ file: string } | { error: string } | null} Null for a remote image, which stays as it is.
 */
export function locateGuideImage(root, pageRel, src) {
  const scheme = schemeOf(src);
  if (scheme !== null) {
    return ALLOWED_SCHEMES.has(scheme) && scheme !== 'mailto' ? null : { error: `refused image '${src.length > 80 ? `${src.slice(0, 80)}...` : src}': a guide can show pictures from http: or https: addresses or from files of the repository, not ${scheme}:` };
  }
  if (compact(src).startsWith('//')) return null;
  const cut = src.search(/[?#]/);
  const path = decodeSafe(cut < 0 ? src : src.slice(0, cut));
  if (path === '') return { error: `missing image '${src}'` };
  const target = (path.startsWith('/') ? posix.normalize(path.slice(1) || '.') : posix.normalize(posix.join(posix.dirname(pageRel), path))).replace(/\/+$/, '');
  if (target === '..' || target.startsWith('../')) return { error: `missing image '${path}' (it leads out of the repository)` };
  const found = resolveInside(root, target === '' ? '.' : target);
  if (!found.ok) {
    return { error: found.reason === 'missing' ? `missing image '${path}' (${target} does not exist in the repository)` : `image '${path}' cannot be used: ${found.message}` };
  }
  let isFile = false;
  try {
    isFile = statSync(found.path).isFile();
  } catch {
    isFile = false;
  }
  if (!isFile) return { error: `missing image '${path}' (${target} is not a file)` };
  const extension = posix.extname(target).toLowerCase();
  if (extension === '.svg') {
    return { error: `image '${path}' is an SVG, which a guide cannot publish; convert it to PNG, WebP or JPEG` };
  }
  if (!IMAGE_EXTENSIONS.includes(extension)) {
    return { error: `unsupported image format '${path}' (use ${IMAGE_EXTENSIONS.join(', ')})` };
  }
  return { file: found.path };
}

// ---------------------------------------------------------------------------
// Finishing a page

/**
 * A rendered page, ready for the template.
 *
 * @typedef {object} FinishedGuide
 * @property {string} title From the first H1; else from the name of the file.
 * @property {string | null} titleId The `id` the H1 had, which links to it point at.
 * @property {string} html The body, without the title, links rewritten, no map placeholders.
 * @property {string} description The first words of the text.
 * @property {GuideIssue[]} issues Addresses with a scheme that is refused, found in raw HTML.
 */

const FIRST_H1 = /<h1(\s[^>]*)?>([\s\S]*?)<\/h1>\s*/i;

/**
 * Takes the title out of the rendered HTML, applies the link rewrites and makes
 * every remaining address safe: a scheme other than `http:`, `https:` or
 * `mailto:` (`javascript:`, `data:`, `vbscript:`, `file:`) in any `href`,
 * `src`, `srcset` or `poster`, wherever it came from (raw HTML included), is
 * replaced by `#` and reported.
 *
 * @param {object} input
 * @param {GuidePage} input.page
 * @param {string} input.html The rendered HTML.
 * @param {ReadonlyMap<string, string> | undefined} input.rewrites
 * @param {ReadonlySet<string> | undefined} input.refused Links whose scheme is refused and already reported.
 * @param {string} input.indexTitle The title of the docs index when its file has no heading.
 * @returns {FinishedGuide}
 */
export function finishGuidePage({ page, html, rewrites, refused, indexTitle }) {
  let body = html;
  let title = '';
  /** @type {string | null} */
  let titleId = null;
  const match = FIRST_H1.exec(body);
  if (match) {
    title = decodeEntities(match[2].replace(/<[^>]*>/g, ''), { html: true }).replace(/\s+/g, ' ').trim();
    const id = /\sid\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(match[1] ?? '');
    titleId = id ? (id[1] ?? id[2]) : null;
    if (title !== '') body = body.slice(0, match.index) + body.slice(match.index + match[0].length);
  }
  if (title === '') title = page.isIndex ? indexTitle : titleFromName(posix.basename(page.inGuide));
  body = applyLinkRewrites(body, rewrites);
  body = withoutMapPlaceholders(body);
  /** @type {GuideIssue[]} */
  const issues = [];
  /** @type {Set<string>} */
  const reported = new Set();
  body = mapHtmlUrls(body, (url) => {
    const scheme = schemeOf(url);
    if (scheme === null || ALLOWED_SCHEMES.has(scheme)) return url;
    if (!refused?.has(url) && !reported.has(url)) {
      reported.add(url);
      const at = page.text.indexOf(url);
      const line = at < 0 ? undefined : page.text.slice(0, at).split('\n').length;
      issues.push({
        file: page.label,
        ...(line === undefined ? {} : { line }),
        message: `refused address '${url.length > 80 ? `${url.slice(0, 80)}...` : url}' in the HTML of the page: only http:, https: and mailto: addresses are published (it is replaced by "#")`,
      });
    }
    return '#';
  });
  return { title, titleId, html: body, description: excerptOf(body, 200), issues };
}
