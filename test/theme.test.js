import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { createTemplates } from '../src/render/templates.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(join(root, 'theme', 'assets', 'coffer.css'), 'utf8');

const site = { title: 'Example Site', contentLicense: 'CC BY 4.0' };
const page = { title: 'Hello', content: '<p>Body</p>' };

/** The tokens a site theme may override. */
const TOKENS = [
  '--coffer-text',
  '--coffer-bg',
  '--coffer-muted',
  '--coffer-accent',
  '--coffer-code-bg',
  '--coffer-code-fg',
  '--coffer-border',
  '--coffer-font-heading',
  '--coffer-font-body',
  '--coffer-font-mono',
  '--coffer-measure',
];

/** The tokens that differ between the colour schemes. */
const COLOUR_TOKENS = TOKENS.filter((name) => !/font|measure/.test(name));

/**
 * Returns the body of the first rule whose selector is exactly `selector`,
 * searching in `source` (comments removed).
 *
 * @param {string} source
 * @param {string} selector
 * @returns {string}
 */
function ruleBody(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|[}\\s])${escaped}\\s*\\{([^{}]*)\\}`).exec(source);
  assert.ok(match, `rule "${selector}" exists`);
  return match[1];
}

/**
 * @param {string} body
 * @returns {Record<string, string>}
 */
function declarations(body) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const part of body.split(';')) {
    const at = part.indexOf(':');
    if (at > 0) out[part.slice(0, at).trim()] = part.slice(at + 1).trim();
  }
  return out;
}

const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
const darkMedia = [...bare.matchAll(/@media \(prefers-color-scheme: dark\) \{([\s\S]*?)\n\}\n/g)]
  .map((match) => match[1])
  .join('\n');

test('the stylesheet defines every design token on :root', () => {
  const light = declarations(ruleBody(bare, ':root'));
  for (const name of TOKENS) assert.ok(light[name], `${name} is defined`);
  assert.match(light['--coffer-measure'], /^6\dch$/);
  assert.match(light['--coffer-font-body'], /system-ui/);
});

test('dark values follow the system preference and [data-theme=dark], and light can be forced', () => {
  const light = declarations(ruleBody(bare, ':root'));
  const media = declarations(ruleBody(darkMedia, ':root'));
  const forcedDark = declarations(ruleBody(bare, ':root[data-theme="dark"]'));
  const forcedLight = declarations(ruleBody(bare, ':root[data-theme="light"]'));

  assert.ok(darkMedia, 'there is a prefers-color-scheme: dark block');
  for (const name of COLOUR_TOKENS) {
    assert.ok(media[name], `${name} has a dark value`);
    assert.notEqual(media[name], light[name], `${name} differs in dark mode`);
    assert.equal(forcedDark[name], media[name], `${name}: [data-theme=dark] equals the system dark value`);
    assert.equal(forcedLight[name], light[name], `${name}: [data-theme=light] equals the default`);
  }
  assert.equal(media['color-scheme'], 'dark');
  assert.equal(forcedDark['color-scheme'], 'dark');
  assert.equal(forcedLight['color-scheme'], 'light');
});

test('text keeps enough contrast against the background in both modes', () => {
  /** @param {string} hex */
  const luminance = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) =>
      c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
    );
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  /** @param {string} a @param {string} b */
  const contrast = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const modes = [declarations(ruleBody(bare, ':root')), declarations(ruleBody(darkMedia, ':root'))];
  for (const tokens of modes) {
    for (const name of ['--coffer-text', '--coffer-muted', '--coffer-accent']) {
      assert.ok(contrast(tokens[name], tokens['--coffer-bg']) >= 4.5, `${name} against the background`);
    }
    assert.ok(contrast(tokens['--coffer-code-fg'], tokens['--coffer-code-bg']) >= 4.5, 'code text');
  }
});

test('highlighted code uses the Shiki variables of both schemes', () => {
  assert.match(ruleBody(bare, '.shiki'), /background-color:\s*var\(--shiki-light-bg\)/);
  assert.match(ruleBody(bare, '.shiki,\n.shiki span'), /color:\s*var\(--shiki-light\)/);
  assert.match(ruleBody(darkMedia, '.shiki'), /background-color:\s*var\(--shiki-dark-bg\)/);
  assert.match(ruleBody(darkMedia, '.shiki,\n  .shiki span'), /color:\s*var\(--shiki-dark\)/);
  assert.match(ruleBody(bare, ':root[data-theme="dark"] .shiki'), /var\(--shiki-dark-bg\)/);
  assert.match(ruleBody(bare, ':root[data-theme="dark"] .shiki,\n:root[data-theme="dark"] .shiki span'), /var\(--shiki-dark\)/);
  assert.match(ruleBody(bare, ':root[data-theme="light"] .shiki'), /var\(--shiki-light-bg\)/);
  assert.match(ruleBody(bare, ':root[data-theme="light"] .shiki,\n:root[data-theme="light"] .shiki span'), /var\(--shiki-light\)/);
});

test('no animation or transition is defined', () => {
  assert.doesNotMatch(bare, /@keyframes/);
  assert.doesNotMatch(bare, /(^|[\s{;])(animation|transition)[a-z-]*\s*:/);
  assert.doesNotMatch(bare, /scroll-behavior\s*:\s*smooth/);
  assert.doesNotMatch(bare, /will-change/);
});

test('focus is visible, the layout adapts to small screens and the page prints', () => {
  assert.match(ruleBody(bare, ':focus-visible'), /outline:\s*\d+px solid var\(--coffer-accent\)/);
  assert.match(bare, /@media \(max-width: 30rem\)/);
  assert.match(bare, /@media print/);
  assert.match(ruleBody(bare, 'img,\nvideo,\nsvg'), /max-width:\s*100%/);
  assert.match(ruleBody(bare, 'body'), /overflow-wrap:\s*break-word/);
  assert.match(ruleBody(bare, 'pre'), /overflow-x:\s*auto/);
});

test('print styles force the light palette, including the data-theme variants', () => {
  const printStart = bare.indexOf('@media print');
  const printCss = bare.slice(printStart);
  const palette = declarations(ruleBody(printCss, ':root,\n  :root[data-theme]'));
  const light = declarations(ruleBody(bare, ':root'));
  assert.equal(palette['--coffer-bg'], light['--coffer-bg']);
  assert.match(printCss, /:root\[data-theme\] \.shiki span[\s\S]*var\(--shiki-light\)/);
});

test('every colour comes from a token or from Shiki', () => {
  const outside = bare
    .replace(/:root[^{]*\{[^}]*\}/g, '')
    .replace(/@media \(prefers-color-scheme: dark\) \{\s*\}/g, '');
  assert.doesNotMatch(outside, /#[0-9a-fA-F]{3,8}\b/, 'no hard-coded colours outside the token blocks');
});

test('the page has the theme switch button, labelled in the site language', () => {
  const en = createTemplates({ lang: 'en' }).render('page.njk', { site, page });
  assert.match(en, /<button type="button" class="theme-switch" data-theme-toggle[^>]*>Theme: System<\/button>/);
  assert.match(en, /data-label-light="Theme: Light"/);
  assert.match(en, /data-label-dark="Theme: Dark"/);
  const ru = createTemplates({ lang: 'ru' }).render('page.njk', { site, page });
  assert.match(ru, /data-label-dark="Тема: Тёмная"/);
  assert.match(ru, />Тема: Системная<\/button>/);
});

test('the button is only shown when scripts run', () => {
  assert.match(ruleBody(bare, '.theme-switch'), /display:\s*none/);
  assert.match(ruleBody(bare, '.js .theme-switch'), /display:\s*inline-block/);
});

test('the theme script sits in the head, before the stylesheet', () => {
  const html = createTemplates({ lang: 'en' }).render('page.njk', { site, page });
  const head = /<head>([\s\S]*?)<\/head>/.exec(html)?.[1] ?? '';
  const script = head.indexOf('<script>');
  assert.ok(script >= 0, 'an inline script is in the head');
  assert.ok(script < head.indexOf('rel="stylesheet"'), 'it runs before the stylesheet is applied');
  assert.doesNotMatch(html, /<script[^>]*\ssrc=/, 'the switch needs no extra request');
});

/**
 * Runs the inline theme script against a minimal fake browser.
 *
 * @param {{ stored?: string | null, storageThrows?: boolean }} [options]
 */
function runThemeScript({ stored = null, storageThrows = false } = {}) {
  const html = createTemplates({ lang: 'en' }).render('page.njk', { site, page });
  const source = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';

  /** @type {Map<string, string>} */
  const attributes = new Map();
  /** @type {Set<string>} */
  const classes = new Set();
  /** @type {Record<string, Function>} */
  const listeners = {};
  /** @type {Record<string, string | null>} */
  const store = { 'coffer-theme': stored };

  const button = {
    textContent: 'Theme: System',
    labels: { system: 'Theme: System', light: 'Theme: Light', dark: 'Theme: Dark' },
    attrs: /** @type {Record<string, string>} */ ({}),
    getAttribute(/** @type {string} */ name) {
      return this.labels[/** @type {'system'} */ (name.replace('data-label-', ''))];
    },
    setAttribute(/** @type {string} */ name, /** @type {string} */ value) {
      this.attrs[name] = value;
    },
    closest(/** @type {string} */ selector) {
      return selector === '[data-theme-toggle]' ? this : null;
    },
  };

  const localStorage = {
    getItem(/** @type {string} */ k) {
      if (storageThrows) throw new Error('blocked');
      return store[k] ?? null;
    },
    setItem(/** @type {string} */ k, /** @type {string} */ v) {
      if (storageThrows) throw new Error('blocked');
      store[k] = v;
    },
    removeItem(/** @type {string} */ k) {
      if (storageThrows) throw new Error('blocked');
      store[k] = null;
    },
  };

  const document = {
    documentElement: {
      setAttribute: (/** @type {string} */ k, /** @type {string} */ v) => attributes.set(k, v),
      removeAttribute: (/** @type {string} */ k) => attributes.delete(k),
      classList: { add: (/** @type {string} */ c) => classes.add(c) },
    },
    addEventListener: (/** @type {string} */ type, /** @type {Function} */ fn) => {
      listeners[type] = fn;
    },
    querySelectorAll: () => [button],
  };

  vm.runInNewContext(source, { document, window: { localStorage } });
  const click = () => listeners.click({ target: button });
  const clickElsewhere = () => listeners.click({ target: { closest: () => null } });
  return { attributes, classes, store, button, click, clickElsewhere, ready: () => listeners.DOMContentLoaded() };
}

test('without a stored choice the page follows the system and marks itself as scripted', () => {
  const { attributes, classes } = runThemeScript();
  assert.equal(attributes.has('data-theme'), false);
  assert.ok(classes.has('js'));
});

test('a stored choice is applied while the head is parsed, before first paint', () => {
  assert.equal(runThemeScript({ stored: 'dark' }).attributes.get('data-theme'), 'dark');
  assert.equal(runThemeScript({ stored: 'light' }).attributes.get('data-theme'), 'light');
  assert.equal(runThemeScript({ stored: 'sepia' }).attributes.has('data-theme'), false, 'unknown values are ignored');
});

test('the button cycles system, light, dark and stores the choice', () => {
  const run = runThemeScript();
  run.ready();
  assert.equal(run.button.textContent, 'Theme: System');

  run.click();
  assert.equal(run.attributes.get('data-theme'), 'light');
  assert.equal(run.store['coffer-theme'], 'light');
  assert.equal(run.button.textContent, 'Theme: Light');

  run.click();
  assert.equal(run.attributes.get('data-theme'), 'dark');
  assert.equal(run.store['coffer-theme'], 'dark');
  assert.equal(run.button.textContent, 'Theme: Dark');

  run.click();
  assert.equal(run.attributes.has('data-theme'), false);
  assert.equal(run.store['coffer-theme'], null);
  assert.equal(run.button.textContent, 'Theme: System');
});

test('the label matches a stored choice once the page is ready', () => {
  const run = runThemeScript({ stored: 'dark' });
  run.ready();
  assert.equal(run.button.textContent, 'Theme: Dark');
  run.click();
  assert.equal(run.attributes.has('data-theme'), false, 'dark is followed by system');
});

test('blocked storage does not break the switch', () => {
  const run = runThemeScript({ storageThrows: true });
  assert.equal(run.attributes.has('data-theme'), false);
  run.ready();
  run.click();
  assert.equal(run.attributes.get('data-theme'), 'light');
});

test('clicks elsewhere on the page are ignored', () => {
  const run = runThemeScript();
  run.clickElsewhere();
  assert.equal(run.attributes.has('data-theme'), false);
  assert.equal(run.store['coffer-theme'], null);
});
