import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';

import { normalizeConfig } from '../src/config.js';
import { resolveTypography } from '../src/typography/settings.js';

/**
 * @param {Record<string, unknown>} site
 * @returns {import('../src/config.js').CofferConfig}
 */
function normalize(site) {
  return normalizeConfig(
    { sites: [{ id: 'main', baseUrl: 'https://example.org', title: 'Main', ...site }] },
    { file: resolve('/work/coffer.yaml') },
  );
}

/**
 * @param {Record<string, unknown>} site
 * @returns {string[]}
 */
function errors(site) {
  try {
    normalize(site);
  } catch (error) {
    return /** @type {import('../src/config.js').ConfigError} */ (error).errors;
  }
  return [];
}

test('defaults of resolveTypography', () => {
  assert.deepEqual(resolveTypography({ lang: 'en' }), {
    enabled: true,
    locale: 'en',
    hanging: true,
    hangLines: false,
    headings: 'locale',
    widows: true,
    feeds: true,
    dashStyle: 'locale',
    keep: [],
  });
});

test('resolveTypography merges post over blog over site and joins keep lists', () => {
  /** @type {{ lang: string, typography: import('../src/typography/settings.js').TypographyInput }} */
  const site = { lang: 'en', typography: { widows: false, hanging: false, headings: 'keep', keep: ['coffer', 'npm'] } };
  const blog = { typography: { hanging: true, feeds: false, keep: ['npm', 'iPhone'] } };
  const post = { typography: { hanging: false, keep: ['Zed'] } };
  assert.deepEqual(resolveTypography(site, blog, post), {
    enabled: true,
    locale: 'en',
    hanging: false,
    hangLines: false,
    headings: 'keep',
    widows: false,
    feeds: false,
    dashStyle: 'locale',
    keep: ['coffer', 'npm', 'iPhone', 'Zed'],
  });
  assert.equal(resolveTypography(site, blog).hanging, true);
});

test('the typography locale is the nearest locale key, else the nearest lang', () => {
  assert.equal(resolveTypography({ lang: 'en' }, { lang: 'ru' }).locale, 'ru');
  assert.equal(resolveTypography({ lang: 'en' }, { lang: 'ru' }, { lang: 'de' }).locale, 'de');
  assert.equal(resolveTypography({ lang: 'en' }, { lang: 'ru', typography: { locale: 'fr' } }, { lang: 'de' }).locale, 'fr');
  assert.equal(resolveTypography({ lang: 'en', typography: { locale: 'fr' } }, { typography: { locale: 'hy' } }).locale, 'hy');
});

test('the post can switch typography off', () => {
  assert.equal(resolveTypography({ lang: 'en' }, null, { typography: { enabled: false } }).enabled, false);
});

test('a site and a blog read typography; the resolved settings are on the config', () => {
  const site = normalize({
    lang: 'ru',
    typography: { widows: false, keep: ['coffer'], dashStyle: 'spaced-en' },
    blogs: [{ id: 'a' }, { id: 'b', lang: 'en', typography: { locale: 'de', keep: ['npm'] } }],
  }).sites[0];
  assert.deepEqual(site.typography, { widows: false, keep: ['coffer'], dashStyle: 'spaced-en' });
  assert.equal(site.resolvedTypography.locale, 'ru');
  assert.equal(site.resolvedTypography.widows, false);
  assert.equal(site.blogs[0].resolvedTypography.locale, 'ru');
  assert.deepEqual(site.blogs[0].typography, {});
  assert.equal(site.blogs[1].resolvedTypography.locale, 'de');
  assert.deepEqual(site.blogs[1].resolvedTypography.keep, ['coffer', 'npm']);
  assert.equal(site.blogs[1].resolvedTypography.widows, false);
});

test('blog lang falls back to the site lang, which defaults to en', () => {
  const [plain, russian] = normalize({ blogs: [{ id: 'a' }, { id: 'b', lang: 'RU' }] }).sites[0].blogs;
  assert.equal(plain.lang, 'en');
  assert.equal(russian.lang, 'ru');
  assert.equal(normalize({ lang: 'de', blogs: [{ id: 'a' }] }).sites[0].blogs[0].lang, 'de');
});

test('invalid typography values fail with the key path', () => {
  assert.deepEqual(
    errors({
      typography: { enabled: 'yes', locale: 'not a tag', hanging: 1, hangLines: 'yes', widows: 'no', feeds: [], dashStyle: 'em', extra: 1 },
      blogs: [{ id: 'a' }, { id: 'b', lang: '!!', typography: { headings: 'upper', keep: ['ok', '', 3] } }, { id: 'c', typography: 'on' }],
    }),
    [
      'coffer.yaml: sites[0].blogs[1].lang: must be a valid language tag such as "en" or "ru"',
      'coffer.yaml: sites[0].blogs[1].typography.headings: must be one of: locale, keep',
      'coffer.yaml: sites[0].blogs[1].typography.keep[1]: must be a non-empty string',
      'coffer.yaml: sites[0].blogs[1].typography.keep[2]: must be a non-empty string',
      'coffer.yaml: sites[0].blogs[2].typography: must be a mapping',
      'coffer.yaml: sites[0].typography.extra: unknown key (expected one of: enabled, locale, hanging, hangLines, headings, widows, feeds, dashStyle, keep)',
      'coffer.yaml: sites[0].typography.enabled: must be true or false',
      'coffer.yaml: sites[0].typography.hanging: must be true or false',
      'coffer.yaml: sites[0].typography.hangLines: must be true or false',
      'coffer.yaml: sites[0].typography.widows: must be true or false',
      'coffer.yaml: sites[0].typography.feeds: must be true or false',
      'coffer.yaml: sites[0].typography.dashStyle: must be one of: locale, spaced-en',
      'coffer.yaml: sites[0].typography.locale: must be a valid language tag such as "en" or "ru"',
    ],
  );
  assert.deepEqual(errors({ typography: { keep: 'coffer' } }), ['coffer.yaml: sites[0].typography.keep: must be a list of words']);
});
