import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';

const root = fileURLToPath(new URL('..', import.meta.url));
const landingFile = join(root, 'site', 'landing.md');

/**
 * Links of the text that pointed at a site address when the text was moved
 * here, and the repository path they were changed to. Nothing else was edited.
 */
const ADJUSTED_LINKS = [
  { text: '/made/coffer/docs/', was: '/made/coffer/docs/', now: '../docs/README.md' },
  { text: 'Read the docs', was: '/made/coffer/docs/', now: '../docs/README.md' },
];

const SECTIONS = [
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

/** @returns {{ data: any, body: string }} */
function readLanding() {
  const text = readFileSync(landingFile, 'utf8');
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(match, 'the file starts with front matter');
  return { data: parse(/** @type {string} */ (match[1])), body: text.slice(match[0].length) };
}

/** Code fences are not links: blank them out, keeping the line count. */
function withoutCode(/** @type {string} */ body) {
  return body.replace(/^```[\s\S]*?^```$/gm, (block) => block.replace(/[^\n]/g, ' '));
}

test('the landing text has the twelve section markers, in order', () => {
  const { body } = readLanding();
  const ids = [...body.matchAll(/^<div class="section-marker" id="([^"]*)"><\/div>$/gm)].map((m) => m[1]);
  assert.deepEqual(ids, SECTIONS);
});

test('the front matter carries the layout settings and the accent palette', () => {
  const { data } = readLanding();
  assert.deepEqual(data.layout.visual, {
    hero: 'pre',
    problem: 'pre',
    timeline: 'ul',
    'spec-example': 'pre',
    'quick-start': 'pre',
  });
  assert.equal(data.layout.dogfood, 'plain');
  assert.equal(data.layout.when, 'span class="lp-when"');
  assert.equal(data.layout.brand, 0);
  assert.deepEqual(Object.keys(data.layout.strings), ['terminal_title', 'hero_terminal', 'problem_terminal', 'dogfood_terminal']);
  for (const value of Object.values(data.layout.strings)) assert.equal(typeof value, 'string');
  assert.deepEqual(data.accent.light, { accent: '#9a6b1f', 'accent-text': '#7c5516', 'accent-soft': '#f4e8cc' });
  assert.deepEqual(data.accent.dark, { accent: '#d9a84e', 'accent-text': '#d9a84e', 'accent-soft': '#2b2214' });
});

test('every relative link and image target of the landing text exists', () => {
  const { body } = readLanding();
  const targets = [...withoutCode(body).matchAll(/!?\[[^\]]*\]\(([^)\s]+)\)/g)].map((m) => /** @type {string} */ (m[1]));
  assert.ok(targets.length > 0);
  for (const target of targets) {
    if (/^(https?:|mailto:|ref:|#)/.test(target)) continue;
    assert.ok(!target.startsWith('/'), `${target} is a site address, not a path in the repository`);
    const path = resolve(dirname(landingFile), decodeURIComponent(target.replace(/[?#].*$/, '')));
    assert.ok(existsSync(path), `${target} does not exist`);
  }
});

test('in-page links lead to a section marker', () => {
  const { body } = readLanding();
  for (const match of withoutCode(body).matchAll(/\]\(#([^)\s]+)\)/g)) {
    assert.ok(SECTIONS.includes(/** @type {string} */ (match[1])), `#${match[1]} is not a section`);
  }
});

test('the links that were adjusted when the text moved point into the repository', () => {
  const { body } = readLanding();
  for (const { text, now } of ADJUSTED_LINKS) {
    assert.ok(body.includes(`[${text}](${now})`), `[${text}](${now}) is in the text`);
    assert.ok(existsSync(resolve(dirname(landingFile), now)), `${now} exists`);
  }
});
