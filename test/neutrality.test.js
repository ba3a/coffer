// Guards the rule that nothing in the engine mentions its author, their
// projects or their sites. The forbidden words live in this file, so this file
// necessarily excludes itself from the scan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const coffer = fileURLToPath(new URL('..', import.meta.url));
const SELF = 'test/neutrality.test.js';

/**
 * Forbidden words, matched case-insensitively. "roto" must not directly follow
 * a letter, so that words such as "protocol" and "prototype" are not flagged.
 */
const FORBIDDEN = [
  'ba3a',
  'specloop',
  '(?<![a-z])roto',
  'faultory',
  'vasily',
  'petrov',
];
const FORBIDDEN_RE = new RegExp(FORBIDDEN.join('|'), 'i');

const CREDITS_MARKER = '<!-- credits -->';
const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', '.cache', '.coffer']);
// CLAUDE.md and everything under site/ are exempt: the website landing page and
// its agent instructions name the author's site.
const EXEMPT_FILES = new Set(['LICENSE', 'NOTICE', 'CLAUDE.md', SELF]);
const EXEMPT_DIRS = ['site/'];

/**
 * @param {string} file Forward-slash path relative to the root.
 * @returns {boolean}
 */
const isExempt = (file) =>
  EXEMPT_FILES.has(file) || EXEMPT_DIRS.some((dir) => file.startsWith(dir));

/**
 * Files under `root` that are tracked or untracked-but-not-ignored, as
 * forward-slash paths relative to `root`. Falls back to walking the directory
 * when git is unavailable or `root` is not in a repository.
 *
 * @param {string} root
 * @param {boolean} useGit
 * @returns {string[]}
 */
function listFiles(root, useGit) {
  if (useGit) {
    try {
      const out = execFileSync(
        'git',
        ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
        { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      );
      return [...new Set(out.split('\0').filter(Boolean))].filter((file) =>
        existsSync(join(root, file)),
      );
    } catch {
      // fall through to the directory walk
    }
  }
  /** @type {string[]} */
  const files = [];
  /** @param {string} dir */
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) walk(full);
      } else if (entry.isFile()) {
        files.push(relative(root, full).split(sep).join('/'));
      }
    }
  };
  walk(root);
  return files;
}

/**
 * Scans the files under `root` and returns one message per offending line.
 * Skips node_modules, LICENSE, NOTICE and CLAUDE.md at the root, site/, this
 * test, binary files and any region delimited by two credits markers.
 *
 * @param {string} root
 * @param {{ useGit?: boolean }} [options]
 * @returns {string[]}
 */
function findViolations(root, { useGit = true } = {}) {
  /** @type {string[]} */
  const violations = [];
  for (const file of listFiles(root, useGit)) {
    if (isExempt(file)) continue;
    if (file.split('/').includes('node_modules')) continue;
    const buffer = readFileSync(join(root, file));
    if (buffer.includes(0)) continue;
    let inCredits = false;
    buffer
      .toString('utf8')
      .split(/\r?\n/)
      .forEach((line, index) => {
        if (line.includes(CREDITS_MARKER)) {
          inCredits = !inCredits;
          return;
        }
        if (!inCredits && FORBIDDEN_RE.test(line)) {
          violations.push(`${file}:${index + 1}: ${line.trim()}`);
        }
      });
  }
  return violations;
}

/**
 * @param {Record<string, string>} files
 * @param {(root: string) => void} check
 */
function withTree(files, check) {
  const root = mkdtempSync(join(tmpdir(), 'coffer-neutrality-'));
  try {
    for (const [name, content] of Object.entries(files)) {
      const target = join(root, ...name.split('/'));
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, content);
    }
    check(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('nothing under coffer/ mentions the author, their projects or sites', () => {
  const violations = findViolations(coffer);
  assert.deepEqual(violations, [], `forbidden words found:\n${violations.join('\n')}`);
});

test('a mention of ba3a is reported with file and line', () => {
  withTree({ 'src/page.js': 'const a = 1;\n// see BA3A.dev\n' }, (root) => {
    assert.deepEqual(findViolations(root, { useGit: false }), [
      'src/page.js:2: // see BA3A.dev',
    ]);
  });
});

test('every forbidden word is detected, in any case', () => {
  const words = ['ba3a', 'specloop', 'roto', 'faultory', 'Vasily', 'PETROV'];
  withTree(
    Object.fromEntries(words.map((word, i) => [`f${i}.txt`, `x ${word} y\n`])),
    (root) => {
      assert.equal(findViolations(root, { useGit: false }).length, words.length);
    },
  );
});

test('words that merely contain "roto" are not flagged', () => {
  withTree({ 'a.md': 'The protocol and a prototype.\n' }, (root) => {
    assert.deepEqual(findViolations(root, { useGit: false }), []);
  });
});

test('LICENSE, NOTICE, node_modules and credits sections are skipped', () => {
  withTree(
    {
      LICENSE: 'ba3a\n',
      NOTICE: 'Vasily Petrov\n',
      'node_modules/dep/index.js': '// specloop\n',
      'README.md': 'intro\n<!-- credits -->\nBy Vasily Petrov, ba3a.dev\n<!-- credits -->\noutro\n',
    },
    (root) => {
      assert.deepEqual(findViolations(root, { useGit: false }), []);
    },
  );
});

test('text after a closed credits section is scanned again', () => {
  withTree(
    { 'README.md': '<!-- credits -->\nba3a\n<!-- credits -->\nba3a\n' },
    (root) => {
      assert.deepEqual(findViolations(root, { useGit: false }), ['README.md:4: ba3a']);
    },
  );
});

test('LICENSE and NOTICE are only exempt at the root', () => {
  withTree({ 'docs/NOTICE': 'ba3a\n' }, (root) => {
    assert.deepEqual(findViolations(root, { useGit: false }), ['docs/NOTICE:1: ba3a']);
  });
});

test('CLAUDE.md and site/ are the only exemptions besides the license files and this test', () => {
  assert.deepEqual([...EXEMPT_FILES].sort(), ['CLAUDE.md', 'LICENSE', 'NOTICE', SELF].sort());
  assert.deepEqual(EXEMPT_DIRS, ['site/']);
});

test('CLAUDE.md and site/ are not scanned, but look-alike paths are', () => {
  withTree(
    {
      'CLAUDE.md': 'ba3a.dev\n',
      'site/landing.md': 'Vasily Petrov, ba3a.dev\n',
      'site/brand/note.txt': 'specloop\n',
      'docs/CLAUDE.md': 'ba3a\n',
      'website/page.md': 'ba3a\n',
      'src/site/page.js': 'ba3a\n',
    },
    (root) => {
      assert.deepEqual(findViolations(root, { useGit: false }).sort(), [
        'docs/CLAUDE.md:1: ba3a',
        'src/site/page.js:1: ba3a',
        'website/page.md:1: ba3a',
      ]);
    },
  );
});
