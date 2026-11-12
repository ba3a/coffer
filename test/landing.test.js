import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';

const root = fileURLToPath(new URL('..', import.meta.url));

const KNOWN_MARKERS = [
  'hero',
  'problem',
  'audience',
  'how-it-works',
  'timeline',
  'spec-example',
  'features',
  'compare',
  'dogfood',
  'quick-start',
  'faq',
  'final-cta',
];

/**
 * Problems of a landing text, as a list of messages; empty when it is fine.
 * @param {string | null} text the file's content, or null when it is missing
 * @returns {string[]}
 */
function problems(text) {
  if (text === null) return ['site/landing.md does not exist'];
  const found = [];
  const front = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!front) return ['no front matter'];
  try {
    const data = parse(/** @type {string} */ (front[1]));
    if (data === null || typeof data !== 'object') found.push('front matter is not a mapping');
  } catch (error) {
    found.push(`front matter is not YAML: ${/** @type {Error} */ (error).message}`);
  }
  const seen = new Set();
  for (const match of text.slice(front[0].length).matchAll(/<div class="section-marker" id="([^"]*)"><\/div>/g)) {
    const id = /** @type {string} */ (match[1]);
    if (!KNOWN_MARKERS.includes(id)) found.push(`unknown marker "${id}"`);
    if (seen.has(id)) found.push(`duplicate marker "${id}"`);
    seen.add(id);
  }
  return found;
}

const marker = (/** @type {string} */ id) => `<div class="section-marker" id="${id}"></div>`;

test('the check reports a missing file, bad front matter, unknown and duplicate markers', () => {
  assert.deepEqual(problems(null), ['site/landing.md does not exist']);
  assert.deepEqual(problems(`# no front matter\n${marker('hero')}\n`), ['no front matter']);
  assert.match(String(problems('---\na: [unclosed\n---\n')[0]), /not YAML/);
  assert.deepEqual(problems(`---\na: 1\n---\n${marker('hero')}\n${marker('nope')}\n`), ['unknown marker "nope"']);
  assert.deepEqual(problems(`---\na: 1\n---\n${marker('hero')}\n${marker('faq')}\n${marker('hero')}\n`), ['duplicate marker "hero"']);
  assert.deepEqual(problems(`---\na: 1\n---\n${marker('hero')}\n${marker('faq')}\n`), []);
});

test('site/landing.md exists, parses and uses only known, unrepeated markers', () => {
  const file = join(root, 'site', 'landing.md');
  assert.deepEqual(problems(existsSync(file) ? readFileSync(file, 'utf8') : null), []);
});

test('the brand folder and the share card exist', () => {
  assert.ok(existsSync(join(root, 'site', 'brand')), 'site/brand exists');
  assert.ok(existsSync(join(root, 'site', 'card.png')), 'site/card.png exists');
});
