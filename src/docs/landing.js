import { statSync } from 'node:fs';

import { LineCounter, parseDocument } from 'yaml';

import { exactCase } from './readme.js';
import { readGuideFile, repoLabelOf } from './guides.js';
import { resolveInside } from './sources.js';

/**
 * The landing file of a project: a Markdown file of the project's docs source
 * (`landing: { file }` in `project.yaml`) whose text is the body of the
 * project's page.
 *
 * The file is untrusted repository content. It is read like a guide
 * ({@link readGuideFile}: inside the repository, bounded, UTF-8), and every
 * finding names it as `{repo}:{path}` with the line and column in the file.
 */

/**
 * @typedef {object} LandingText
 * @property {import('./guides.js').GuidePage} page The file as a page the guide machinery can render and resolve links for: `rel` is the path in the source, `text` the whole file (front matter included, so lines count from the top of the file), `label` is `{repo}:{path}`.
 * @property {Record<string, unknown>} data The parsed front matter; empty when the file has none.
 * @property {string} body The Markdown after the front matter.
 * @property {number} bodyLine 1-based line of the file on which `body` starts.
 */

/**
 * Splits the front matter off a text with `\n` line ends and no byte order mark.
 *
 * @param {string} text
 * @returns {{ yaml: string, body: string, bodyLine: number } | { unclosed: true } | null} Null when the text does not start with a front matter fence.
 */
function splitFrontMatter(text) {
  const open = /^---[ \t]*\n/.exec(text);
  if (open === null) return null;
  const rest = text.slice(open[0].length);
  const close = /^(?:---|\.\.\.)[ \t]*(?:\n|$)/m.exec(rest);
  if (close === null) return { unclosed: true };
  const yaml = rest.slice(0, close.index);
  return { yaml, body: rest.slice(close.index + close[0].length), bodyLine: (yaml.match(/\n/g) ?? []).length + 3 };
}

/**
 * Reads the landing file of a fetched docs source: the text, its front matter
 * (YAML between `---` lines at the top; a mapping) and its body.
 *
 * A file that does not exist, leads out of the repository, cannot be read or
 * has a broken front matter is reported and gives null: the build fails, there
 * is no fallback to older or empty content.
 *
 * @param {import('./sources.js').FetchedDocs} fetched
 * @param {string} file Path of the landing file inside the source, with `/`.
 * @param {(issue: import('./guides.js').GuideIssue) => void} report
 * @returns {LandingText | null}
 */
export function readLanding(fetched, file, report) {
  const label = `${repoLabelOf(fetched)}:${file}`;
  const found = resolveInside(fetched.root, file);
  if (!found.ok) {
    report({
      file: label,
      message:
        found.reason === 'missing'
          ? 'the landing file does not exist in the docs source (landing.file in project.yaml)'
          : `the landing file cannot be used: ${found.message}`,
    });
    return null;
  }
  let isFile = false;
  try {
    isFile = statSync(found.path).isFile();
  } catch {
    isFile = false;
  }
  if (!isFile) {
    report({ file: label, message: 'the landing file is not a file (landing.file in project.yaml)' });
    return null;
  }
  if (!exactCase(fetched.root, file)) {
    report({
      file: label,
      message: 'the landing file does not exist with exactly this capitalisation (GitHub and most systems tell "Landing.md" from "landing.md")',
    });
    return null;
  }
  const text = readGuideFile(fetched.root, file, label, report);
  if (text === null) return null;
  const page = { rel: file, inGuide: file, guide: -1, label, text, slug: '', isIndex: false };

  const parts = splitFrontMatter(text);
  if (parts === null) return { page, data: {}, body: text, bodyLine: 1 };
  if ('unclosed' in parts) {
    report({ file: label, line: 1, column: 1, message: 'front matter: the file starts with a "---" line but no other "---" line closes the front matter' });
    return null;
  }
  const lineCounter = new LineCounter();
  const document = parseDocument(parts.yaml, { lineCounter, uniqueKeys: true });
  if (document.errors.length > 0) {
    for (const error of document.errors) {
      const at = error.linePos?.[0];
      const message = (error.message.split('\n')[0] ?? '').replace(/ at line \d+, column \d+:?/, '').trim();
      // The fence is the first line of the file.
      report({ file: label, ...(at === undefined ? {} : { line: at.line + 1, column: at.col }), message: `front matter: ${message}` });
    }
    return null;
  }
  const data = document.toJS();
  if (data === null || data === undefined) return { page, data: {}, body: parts.body, bodyLine: parts.bodyLine };
  if (typeof data !== 'object' || Array.isArray(data)) {
    report({ file: label, line: 1, column: 1, message: 'front matter: must be a mapping of keys to values' });
    return null;
  }
  const mapping = /** @type {Record<string, unknown>} */ (data);
  if ('file' in mapping) {
    report({
      file: label,
      line: 1,
      column: 1,
      message: 'front matter: file: is reserved (templates see project.landing.file as the path of the landing file)',
    });
    return null;
  }
  return { page, data: mapping, body: parts.body, bodyLine: parts.bodyLine };
}
