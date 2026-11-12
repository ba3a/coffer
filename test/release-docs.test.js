// Guards the material that presents the engine: README, documentation index,
// CONTRIBUTING, issue templates and changelog.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';
import { parse } from 'yaml';

const root = fileURLToPath(new URL('..', import.meta.url));

/**
 * @param {string} name Path relative to the engine's root, with forward slashes.
 * @returns {string}
 */
const read = (name) => readFileSync(join(root, ...name.split('/')), 'utf8').replace(/\r\n/g, '\n');

/**
 * The relative link targets of a Markdown text: code is left out, and so are
 * addresses with a scheme and links within the same page.
 *
 * @param {string} markdown
 * @returns {string[]} Targets without any fragment.
 */
function relativeLinks(markdown) {
  const text = markdown.replace(/^(```|~~~)[\s\S]*?^\1/gm, '').replace(/`[^`\n]*`/g, '');
  /** @type {string[]} */
  const targets = [];
  for (const match of text.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const target = match[1];
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) continue;
    targets.push(target.split('#')[0]);
  }
  return targets;
}

/**
 * @param {string} file Path of a Markdown file relative to the engine's root.
 * @param {(target: string) => boolean} [only] Selects the links to check; all by default.
 * @returns {string[]} Problems, one per link that leads nowhere.
 */
function brokenLinks(file, only = () => true) {
  const dir = dirname(join(root, ...file.split('/')));
  return relativeLinks(read(file))
    .filter(only)
    .filter((target) => !existsSync(resolve(dir, decodeURIComponent(target))))
    .map((target) => `${file}: ${target}`);
}

/** @returns {string[]} The feature pages in docs/, without the index. */
function featurePages() {
  return readdirSync(join(root, 'docs')).filter((name) => name.endsWith('.md') && name !== 'README.md');
}

/**
 * @param {string} text
 * @returns {string[]} The text of every heading.
 */
function headings(text) {
  return [...text.replace(/^```[\s\S]*?^```/gm, '').matchAll(/^#{1,6}\s+(.+?)\s*$/gm)].map((m) => m[1]);
}

test('the README has what, features, requirements, quick start, license and how to credit', () => {
  const readme = read('README.md');
  const titles = headings(readme).map((title) => title.toLowerCase());
  for (const wanted of ['features', 'requirements', 'quick start', 'license', 'how to credit']) {
    assert.ok(titles.includes(wanted), `README has no "${wanted}" heading`);
  }
  assert.match(readme, /static site engine for people who make things and write about them/);
  assert.match(readme, /Node\.js 24/);
});

test('the README quick start uses commands that exist', () => {
  const readme = read('README.md');
  const scripts = JSON.parse(read('package.json')).scripts;
  assert.ok(scripts.example, 'package.json has no "example" script');
  for (const command of [
    'npm install',
    'npm run example',
    'npx coffer serve example/dist/workshop',
    'npx coffer dev --config example/coffer.yaml',
  ]) {
    assert.ok(readme.includes(command), `README does not show "${command}"`);
  }
  assert.ok(existsSync(join(root, 'example', 'coffer.yaml')));
  assert.match(scripts.example, /example\/coffer\.yaml/);
  assert.match(scripts.example, /example\/dist/);
});

test('the README credits paragraph sits between two markers and names the conditions', () => {
  const readme = read('README.md');
  const parts = readme.split('<!-- credits -->');
  assert.equal(parts.length, 3, 'README needs exactly two credits markers');
  const credits = parts[1];
  assert.match(credits, /LICENSE/);
  assert.match(credits, /NOTICE/);
  assert.match(credits, /modified/);
  assert.match(credits, /built with coffer/i);
  assert.ok(
    parts[0].trimEnd().toLowerCase().endsWith('how to credit'),
    'the markers follow the "How to credit" heading',
  );
});

test('the README shows the screenshot, and it is a small PNG of the example site', async () => {
  assert.match(read('README.md'), /!\[[^\]]+\]\(docs\/screenshot\.png\)/);
  const buffer = readFileSync(join(root, 'docs', 'screenshot.png'));
  assert.deepEqual([...buffer.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.ok(buffer.length < 300 * 1024, `screenshot is ${buffer.length} bytes`);
  const meta = await sharp(buffer).metadata();
  assert.equal(meta.format, 'png');
  assert.ok((meta.width ?? 0) >= 800 && (meta.height ?? 0) >= 300);
});

test('every feature page is linked from the documentation index and from the README', () => {
  const pages = featurePages();
  assert.ok(pages.length >= 20, 'docs/ should hold a page per feature');
  const index = relativeLinks(read('docs/README.md'));
  const readme = relativeLinks(read('README.md')).map((target) => target.replace(/^docs\//, ''));
  for (const page of pages) {
    assert.ok(index.includes(page), `docs/README.md does not link ${page}`);
    assert.ok(readme.includes(page), `README.md does not link docs/${page}`);
  }
});

test('the documentation index links only to pages that exist', () => {
  const pages = new Set(featurePages());
  for (const target of relativeLinks(read('docs/README.md'))) {
    if (target.startsWith('../')) continue;
    assert.ok(pages.has(target), `docs/README.md links ${target}`);
  }
});

test('every relative link of the README, the documentation index and CONTRIBUTING resolves', () => {
  const broken = ['README.md', 'docs/README.md', 'CONTRIBUTING.md'].flatMap((file) => brokenLinks(file));
  assert.deepEqual(broken, []);
});

test('the links of every documentation page to another page resolve', () => {
  // Only links to Markdown files are checked: the pages show example Markdown whose image links are illustrations.
  const broken = featurePages().flatMap((page) =>
    brokenLinks(`docs/${page}`, (target) => target.endsWith('.md')),
  );
  assert.deepEqual(broken, []);
});

test('CONTRIBUTING covers setup, tests, style, neutrality, proposals and commits', () => {
  const text = read('CONTRIBUTING.md');
  const titles = headings(text).map((title) => title.toLowerCase());
  for (const wanted of ['setup', 'tests', 'style', 'the neutrality rule', 'proposing a feature']) {
    assert.ok(titles.includes(wanted), `CONTRIBUTING has no "${wanted}" heading`);
  }
  assert.ok(titles.some((title) => title.startsWith('commits')));
  assert.match(text, /npm test/);
  assert.match(text, /test\/neutrality\.test\.js/);
  assert.match(text, /Conventional Commits/);
});

/**
 * @param {string} file
 * @returns {Record<string, any>}
 */
const template = (file) => parse(read(`.github/ISSUE_TEMPLATE/${file}`));

for (const file of ['bug_report.yml', 'feature_request.yml']) {
  test(`the issue template ${file} is a valid issue form`, () => {
    const form = template(file);
    assert.equal(typeof form.name, 'string');
    assert.equal(typeof form.description, 'string');
    assert.ok(Array.isArray(form.labels) && form.labels.length > 0);
    assert.ok(Array.isArray(form.body) && form.body.length > 0);
    const known = ['markdown', 'textarea', 'input', 'dropdown', 'checkboxes'];
    const ids = new Set();
    for (const item of form.body) {
      assert.ok(known.includes(item.type), `unknown type ${item.type}`);
      if (item.type === 'markdown') {
        assert.equal(typeof item.attributes.value, 'string');
        continue;
      }
      assert.equal(typeof item.id, 'string');
      assert.ok(!ids.has(item.id), `duplicate id ${item.id}`);
      ids.add(item.id);
      assert.equal(typeof item.attributes.label, 'string');
      if (item.type === 'dropdown') assert.ok(item.attributes.options.length > 0);
    }
    assert.ok(
      form.body.some((item) => item.type !== 'markdown' && item.validations?.required === true),
      'at least one field is required',
    );
  });
}

test('the bug report asks for the version and the steps to reproduce', () => {
  const ids = template('bug_report.yml').body.map((/** @type {{ id?: string }} */ item) => item.id);
  assert.ok(ids.includes('version'));
  assert.ok(ids.includes('reproduce'));
});

test('the feature request asks for the problem and the proposal', () => {
  const ids = template('feature_request.yml').body.map((/** @type {{ id?: string }} */ item) => item.id);
  assert.ok(ids.includes('problem'));
  assert.ok(ids.includes('proposal'));
});

test('the issue template configuration parses and keeps blank issues off', () => {
  const config = template('config.yml');
  assert.equal(config.blank_issues_enabled, false);
});

test('the changelog follows Keep a Changelog and has a section for the next release', () => {
  const text = read('CHANGELOG.md');
  assert.match(text, /^# Changelog\n/);
  assert.match(text, /keepachangelog\.com/);
  assert.match(text, /^## Unreleased$/m);
});

test('the 0.1.0 section lists the features and has a date, or YYYY-MM-DD until it is dated', () => {
  const text = read('CHANGELOG.md');
  const heading = /^## 0\.1\.0 - (YYYY-MM-DD|\d{4}-\d{2}-\d{2})$/m.exec(text);
  assert.ok(heading, 'the heading is "## 0.1.0 - " and a date, or YYYY-MM-DD');
  if (heading[1] !== 'YYYY-MM-DD') assert.ok(!Number.isNaN(Date.parse(heading[1])), 'the date is a real date');
  const section = text.slice(heading.index + heading[0].length);
  const next = section.search(/^## /m);
  const body = next === -1 ? section : section.slice(0, next);
  assert.match(body, /^### Added$/m);
  assert.ok((body.match(/^- /gm) ?? []).length >= 10, 'the section lists the features');
  assert.ok(text.indexOf('## Unreleased') < heading.index, 'Unreleased is above the released sections');
});

test('the 0.1.2 section is dated and groups its entries under Added and Fixed', () => {
  const text = read('CHANGELOG.md');
  const heading = /^## 0\.1\.2 - (\d{4}-\d{2}-\d{2})$/m.exec(text);
  assert.ok(heading, 'the heading is "## 0.1.2 - " and a date');
  assert.ok(!Number.isNaN(Date.parse(heading[1])), 'the date is a real date');
  const section = text.slice(heading.index + heading[0].length);
  const next = section.search(/^## /m);
  const body = next === -1 ? section : section.slice(0, next);
  assert.match(body, /^### Added$/m);
  assert.match(body, /^### Fixed$/m);
  assert.ok(text.indexOf('## Unreleased') < heading.index, 'Unreleased is above the released sections');
  assert.ok(heading.index < text.indexOf('## 0.1.1 - '), '0.1.2 is above 0.1.1');
  const unreleased = text.slice(text.indexOf('## Unreleased'), heading.index);
  assert.doesNotMatch(unreleased, /^### Added$/m, 'the entries moved from Unreleased to 0.1.2');
});

test('package-lock.json has the version of package.json', () => {
  const version = JSON.parse(read('package.json')).version;
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(lock.version, version);
  assert.equal(lock.packages[''].version, version);
});

test('the changelog states the version policy', () => {
  const text = read('CHANGELOG.md');
  assert.match(text, /semver\.org/);
  assert.match(text, /pin/i);
  assert.match(text, /tag/i);
});

test('the package version is the version of the newest released section of the changelog', () => {
  const newest = /^## (\d+\.\d+\.\d+) - /m.exec(read('CHANGELOG.md'));
  assert.ok(newest, 'the changelog has a released section');
  assert.equal(JSON.parse(read('package.json')).version, newest[1]);
});

test('the files outside the package are where the project expects them', () => {
  for (const file of [
    'README.md',
    'CONTRIBUTING.md',
    'CHANGELOG.md',
    '.github/ISSUE_TEMPLATE/bug_report.yml',
    '.github/ISSUE_TEMPLATE/feature_request.yml',
    '.github/ISSUE_TEMPLATE/config.yml',
    'docs/README.md',
  ]) {
    assert.ok(existsSync(join(root, file)), `${relative(root, join(root, file))} is missing`);
  }
});
