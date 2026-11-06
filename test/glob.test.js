import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MAX_GLOB_LENGTH, checkGlobPattern, compileGlob, matchGlob } from '../src/docs/glob.js';

/**
 * @param {string} pattern
 * @param {string[]} yes Paths that match.
 * @param {string[]} no Paths that do not.
 */
function check(pattern, yes, no) {
  for (const path of yes) assert.equal(matchGlob(pattern, path), true, `${pattern} should match ${path}`);
  for (const path of no) assert.equal(matchGlob(pattern, path), false, `${pattern} should not match ${path}`);
}

test('a star matches inside one name, never across a slash', () => {
  check('*.md', ['a.md', 'getting-started.md', 'b.md'], ['dir/a.md', 'a.txt', 'a.md/b']);
  check('docs/*.md', ['docs/a.md'], ['a.md', 'docs/x/a.md', 'other/a.md']);
  check('a*c', ['ac', 'abc', 'abbbc'], ['ab', 'abcd', 'b/c']);
});

test('a double star matches any number of folders, also none', () => {
  check('**/*.md', ['a.md', 'x/a.md', 'x/y/z/a.md'], ['a.txt', 'x/a.md/b', 'a.md.bak']);
  check('docs/**', ['docs/a.md', 'docs/x/y.md'], ['other/docs/a.md', 'a.md']);
  check('**/drafts/**', ['drafts/a.md', 'x/drafts/a.md', 'x/drafts/y/z.md'], ['draft/a.md', 'x/draft/a.md']);
  check('a/**/b', ['a/b', 'a/x/b', 'a/x/y/b'], ['a', 'a/x', 'b']);
  // Inside a longer name `**` is an ordinary star.
  check('a**b', ['ab', 'axb'], ['a/b', 'axxc']);
});

test('a question mark is one character, and a class is one character of a set', () => {
  check('?.md', ['a.md', 'z.md'], ['ab.md', '.md', 'x/a.md']);
  check('v[0-9].md', ['v1.md', 'v9.md'], ['va.md', 'v10.md']);
  check('v[!0-9].md', ['va.md'], ['v1.md']);
  check('v[^0-9].md', ['vb.md'], ['v7.md']);
  check('[abc]x', ['ax', 'cx'], ['dx', 'abx']);
  // A "]" first in a class is a member of it.
  check('[]a]x', [']x', 'ax'], ['bx']);
});

test('matching is case-sensitive', () => {
  check('README.md', ['README.md'], ['readme.md', 'Readme.md']);
  check('*.MD', ['A.MD'], ['a.md']);
});

test('a name that starts with a dot is matched only by a pattern that starts with a literal dot', () => {
  check('*.md', ['a.md'], ['.hidden.md', '.md']);
  check('**/*.md', ['a/b.md'], ['.github/a.md', 'a/.draft.md', 'a/.hidden/b.md']);
  check('docs/**', ['docs/a.md'], ['docs/.secret.md', 'docs/.git/config']);
  check('.*', ['.hidden', '.md'], ['visible']);
  check('.github/*.md', ['.github/a.md'], ['github/a.md']);
  check('?hidden', ['xhidden'], ['.hidden']);
  check('[.]hidden', [], ['.hidden']);
});

test('a pattern is a whole path: a literal one matches that file only', () => {
  check('guide/intro.md', ['guide/intro.md'], ['intro.md', 'x/guide/intro.md', 'guide/intro.md/x']);
  check('./guide//intro.md', ['guide/intro.md'], ['intro.md']);
});

test('unsupported syntax is refused with a message that names the pattern', () => {
  for (const [pattern, reason] of /** @type {[string, RegExp][]} */ ([
    ['{a,b}/*.md', /"\{a,b\}\/\*\.md" uses "\{\.\.\.\}" alternatives/],
    ['!drafts/**', /"!drafts\/\*\*" starts with "!"/],
    ['a\\b', /"a\\b" contains "\\"/],
    ['../x', /"\.\.\/x" contains "\.\."/],
    ['[abc', /"\[abc" has a "\[" that is never closed/],
    ['[z-a]', /"\[z-a\]" has the range "z-a", which runs backwards/],
    ['', /is empty/],
    ['/', /is empty/],
  ])) {
    const checked = checkGlobPattern(pattern);
    assert.ok('problem' in checked, pattern);
    assert.match(checked.problem, reason, pattern);
  }
  assert.ok('problem' in checkGlobPattern('x'.repeat(MAX_GLOB_LENGTH + 1)));
  assert.deepEqual(checkGlobPattern('**/*.md'), { value: '**/*.md' });
});

test('a pattern can be compiled once and matched against many paths', () => {
  const glob = compileGlob('docs/**/*.md');
  assert.equal(matchGlob(glob, 'docs/a/b.md'), true);
  assert.equal(matchGlob(glob, 'docs/a/b.txt'), false);
});

test('matching takes linear time: the classic worst cases for a backtracking matcher finish at once', () => {
  const stars = `${'a*'.repeat(25)}b`;
  const long = 'a'.repeat(100_000);
  const started = performance.now();
  assert.equal(matchGlob(stars, long), false);
  assert.equal(matchGlob(`${'*'.repeat(30)}x`, long), false);
  assert.equal(matchGlob(`${'**/'.repeat(30)}x.md`, `${'d/'.repeat(5_000)}y.md`), false);
  assert.equal(matchGlob(`${'**/*'.repeat(20)}.md`, `${'d/'.repeat(5_000)}y.md`), true);
  assert.equal(matchGlob('[ab]*[ab]*[ab]*[ab]*c', 'ab'.repeat(50_000)), false);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 5_000, `the pathological patterns took ${Math.round(elapsed)} ms`);
});

test('a pattern with a hundred stars does not take longer to match twice as long a name by more than a small factor', () => {
  const pattern = `${'a*'.repeat(90)}b`;
  const time = (/** @type {number} */ length) => {
    const started = performance.now();
    matchGlob(pattern, 'a'.repeat(length));
    return performance.now() - started;
  };
  time(1000);
  const small = Math.max(time(20_000), 1);
  const large = time(40_000);
  // Linear in the name (times the pattern) would double; exponential would never finish.
  assert.ok(large < small * 6 + 50, `${large} ms for the longer name against ${small} ms`);
});
