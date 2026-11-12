import { copyFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { exactCase } from './readme.js';
import { repoLabelOf } from './guides.js';
import { resolveInside } from './sources.js';

/**
 * Files of a project's docs source that are published or used as pictures:
 * the brand folder (`brand: { dir }`, copied unchanged to
 * `/assets/{slug}/...`) and the pictures written `repo:path`.
 *
 * Everything here reads untrusted repository content through
 * {@link resolveInside}, so nothing outside the checkout is ever read.
 */

/** The most files a brand folder can hold. */
export const MAX_BRAND_FILES = 500;

/**
 * Finds a picture written `repo:path` in the fetched source.
 *
 * @param {import('./sources.js').FetchedDocs} fetched
 * @param {string} rel Path of the picture inside the source, with `/`.
 * @returns {{ ok: true, file: string } | { ok: false, message: string }} The real path of the picture, or what is wrong with it.
 */
export function resolveRepoPicture(fetched, rel) {
  const repo = repoLabelOf(fetched);
  const found = resolveInside(fetched.root, rel);
  if (!found.ok) {
    return {
      ok: false,
      message: found.reason === 'missing' ? `the file does not exist in the docs source ${repo}` : `the file cannot be used: ${found.message}`,
    };
  }
  let isFile = false;
  try {
    isFile = statSync(found.path).isFile();
  } catch {
    isFile = false;
  }
  if (!isFile) return { ok: false, message: `"${rel}" is not a file in the docs source ${repo}` };
  if (!exactCase(fetched.root, rel)) {
    return { ok: false, message: `the file does not exist in the docs source ${repo} with exactly this capitalisation` };
  }
  return { ok: true, file: found.path };
}

/**
 * What is already at an address of the output, by lower-case path (two paths
 * that differ only in case are one file on many systems).
 *
 * @typedef {Map<string, { kind: 'file' | 'dir', label: string }>} OutputClaims
 */

/**
 * The files and folders of the output's `assets` folder at this moment (the
 * theme's assets), as claims that brand files must not collide with.
 *
 * @param {string} outDir Absolute path of the site's output.
 * @returns {OutputClaims}
 */
export function claimThemeAssets(outDir) {
  /** @type {OutputClaims} */
  const claims = new Map();
  /**
   * @param {string} dir
   * @param {string} path
   */
  const walk = (dir, path) => {
    claims.set(path.toLowerCase(), { kind: 'dir', label: `the theme asset folder "${path}"` });
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory()) walk(join(dir, entry.name), child);
      else claims.set(child.toLowerCase(), { kind: 'file', label: `the theme asset "${child}"` });
    }
  };
  walk(join(outDir, 'assets'), 'assets');
  return claims;
}

/**
 * Lists the files of a folder of the source, with their real paths. Symbolic
 * links are followed only when the target is a file inside the source.
 *
 * @param {import('./sources.js').FetchedDocs} fetched
 * @param {string} dir Folder inside the source, with `/`.
 * @param {string[]} problems Receives what is wrong.
 * @returns {{ rel: string, path: string }[] | null} Null when the folder cannot be used.
 */
function listBrandFiles(fetched, dir, problems) {
  const repo = repoLabelOf(fetched);
  const found = resolveInside(fetched.root, dir);
  if (!found.ok) {
    problems.push(found.reason === 'missing' ? `the folder "${dir}" does not exist in the docs source ${repo}` : `the folder cannot be used: ${found.message}`);
    return null;
  }
  let isDirectory = false;
  try {
    isDirectory = statSync(found.path).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (!isDirectory) {
    problems.push(`"${dir}" is not a folder in the docs source ${repo}`);
    return null;
  }
  if (!exactCase(fetched.root, dir)) {
    problems.push(`the folder "${dir}" does not exist in the docs source ${repo} with exactly this capitalisation`);
    return null;
  }
  /** @type {{ rel: string, path: string }[]} */
  const files = [];
  let tooMany = false;
  /**
   * @param {string} realDir
   * @param {string} rel Path below the brand folder, with `/`; empty for the folder itself.
   */
  const walk = (realDir, rel) => {
    const entries = readdirSync(realDir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (tooMany) return;
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(join(realDir, entry.name), childRel);
        continue;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      const inSource = resolveInside(fetched.root, `${dir}/${childRel}`);
      if (!inSource.ok) {
        problems.push(`"${childRel}" cannot be used: ${inSource.message}`);
        continue;
      }
      let kind = 'other';
      try {
        const stat = statSync(inSource.path);
        kind = stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : 'other';
      } catch {
        kind = 'other';
      }
      if (kind !== 'file') {
        problems.push(`"${childRel}" is a symbolic link to something that is not a file; only files are published`);
        continue;
      }
      if (files.length >= MAX_BRAND_FILES) {
        tooMany = true;
        problems.push(`the folder holds more than ${MAX_BRAND_FILES} files`);
        return;
      }
      files.push({ rel: childRel, path: inSource.path });
    }
  };
  walk(found.path, '');
  return files;
}

/**
 * Copies every file of a project's brand folder, unchanged, to
 * `assets/{slug}/{path in the folder}` in the output. A file whose address is
 * already taken by a theme asset, by another brand file or by a folder fails
 * the build and the message names both.
 *
 * @param {object} options
 * @param {import('./sources.js').FetchedDocs} options.fetched
 * @param {string} options.dir The brand folder inside the source, with `/`.
 * @param {string} options.slug The project's slug.
 * @param {string} options.outDir Absolute path of the site's output.
 * @param {OutputClaims} options.claims The addresses taken so far; updated.
 * @returns {{ problems: string[], published: string[] }} What is wrong, and the addresses written (site-relative, with the leading `/`).
 */
export function publishBrandFiles({ fetched, dir, slug, outDir, claims }) {
  /** @type {string[]} */
  const problems = [];
  /** @type {string[]} */
  const published = [];
  const files = listBrandFiles(fetched, dir, problems);
  if (files === null) return { problems, published };
  const repo = repoLabelOf(fetched);
  for (const file of files) {
    const target = `assets/${slug}/${file.rel}`;
    const label = `the brand file ${repo}:${dir}/${file.rel} of the project "${slug}"`;
    const segments = target.split('/');
    // A file or a folder that is already there at this address, or a file where this one needs a folder.
    const same = claims.get(target.toLowerCase());
    let clash = same === undefined ? undefined : same.label;
    for (let end = 1; clash === undefined && end < segments.length; end += 1) {
      const above = claims.get(segments.slice(0, end).join('/').toLowerCase());
      if (above?.kind === 'file') clash = above.label;
    }
    if (clash !== undefined) {
      problems.push(`"/${target}" is published twice: by ${label} and by ${clash}`);
      continue;
    }
    for (let end = 1; end < segments.length; end += 1) {
      const folder = segments.slice(0, end).join('/');
      if (!claims.has(folder.toLowerCase())) claims.set(folder.toLowerCase(), { kind: 'dir', label: `the folder "${folder}" of ${label}` });
    }
    claims.set(target.toLowerCase(), { kind: 'file', label });
    const out = join(outDir, ...segments);
    mkdirSync(dirname(out), { recursive: true });
    copyFileSync(file.path, out);
    published.push(`/${target}`);
  }
  return { problems, published };
}
