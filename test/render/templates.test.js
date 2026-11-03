import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Translator, formatDate, loadStrings } from '../../src/render/i18n.js';
import { createTemplates, siteUrl } from '../../src/render/templates.js';
import * as engine from '../../src/index.js';

/**
 * Builds a directory from a map of relative paths to file contents and passes
 * it to `body`; the directory is removed afterwards.
 *
 * @template T
 * @param {Record<string, string>} files
 * @param {(dir: string) => T} body
 * @returns {T}
 */
function inTree(files, body) {
  const dir = mkdtempSync(join(tmpdir(), 'coffer-theme-'));
  try {
    for (const [name, content] of Object.entries(files)) {
      const target = join(dir, ...name.split('/'));
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, content);
    }
    return body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const site = {
  title: 'Example Site',
  contentLicense: 'CC BY 4.0',
};
const page = { title: 'Hello', content: '<p>Body text</p>' };

/**
 * @param {string} html
 * @returns {string}
 */
function withoutFooter(html) {
  return html.replace(/<footer[\s\S]*?<\/footer>/, '<footer></footer>');
}

test('the engine entry point exports the template layer', () => {
  assert.equal(engine.createTemplates, createTemplates);
  assert.equal(engine.Translator, Translator);
  assert.equal(engine.siteUrl, siteUrl);
});

test('the default theme renders a page with the base layout', () => {
  const html = createTemplates({ lang: 'en' }).render('page.njk', { site, page });
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<title>Hello \| Example Site<\/title>/);
  assert.match(html, /<main id="main">[\s\S]*<h1>Hello<\/h1>[\s\S]*<p>Body text<\/p>[\s\S]*<\/main>/);
  assert.match(html, /<nav aria-label="Main navigation">[\s\S]*<a href="\/">Home<\/a>/);
});

test('the footer shows the content license and a credit line', () => {
  const html = createTemplates({ lang: 'en' }).render('page.njk', { site, page });
  assert.match(html, /<footer[^>]*>[\s\S]*Content: CC BY 4\.0[\s\S]*Built with coffer[\s\S]*<\/footer>/);
});

test('the footer omits the license line when the site has none', () => {
  const html = createTemplates({ lang: 'en' }).render('page.njk', {
    site: { title: 'Example Site', contentLicense: '' },
    page,
  });
  assert.doesNotMatch(html, /Content:/);
  assert.match(html, /Built with coffer/);
});

test('base.njk has the blocks head, header, nav, main, footer and scripts', () => {
  const templates = createTemplates({ lang: 'en' });
  const html = templates.renderString(
    [
      '{% extends "base.njk" %}',
      '{% block head %}<!--head-->{% endblock %}',
      '{% block header %}<!--header-->{% endblock %}',
      '{% block main %}<!--main-->{% endblock %}',
      '{% block footer %}<!--footer-->{% endblock %}',
      '{% block scripts %}<!--scripts-->{% endblock %}',
    ].join('\n'),
    { site, page },
  );
  for (const name of ['head', 'header', 'main', 'footer', 'scripts']) {
    assert.ok(html.includes(`<!--${name}-->`), `block ${name} is rendered`);
  }
  const navOnly = templates.renderString(
    '{% extends "base.njk" %}{% block nav %}<!--nav-->{% endblock %}',
    { site, page },
  );
  assert.ok(navOnly.includes('<!--nav-->'));
  assert.match(navOnly, /class="site-title"/, 'overriding nav keeps the rest of the header');
});

test('a theme overriding only the footer block changes only the footer', () => {
  const plain = createTemplates({ lang: 'en' }).render('page.njk', { site, page });
  inTree(
    {
      'templates/page.njk':
        '{% extends "coffer:page.njk" %}\n{% block footer %}<p class="mine">Custom footer</p>{% endblock %}\n',
    },
    (theme) => {
      const themed = createTemplates({ lang: 'en', theme }).render('page.njk', { site, page });
      assert.match(themed, /<footer class="site-footer">\s*<p class="mine">Custom footer<\/p>\s*<\/footer>/);
      assert.doesNotMatch(themed, /Built with coffer/);
      assert.notEqual(themed, plain);
      assert.equal(withoutFooter(themed), withoutFooter(plain));
    },
  );
});

test('a theme base.njk overriding the footer applies to engine pages', () => {
  const plain = createTemplates({ lang: 'en' }).render('page.njk', { site, page });
  inTree(
    {
      'templates/base.njk':
        '{% extends "coffer:base.njk" %}{% block footer %}<p>Theme footer</p>{% endblock %}',
    },
    (theme) => {
      const themed = createTemplates({ lang: 'en', theme }).render('page.njk', { site, page });
      assert.match(themed, /Theme footer/);
      assert.equal(withoutFooter(themed), withoutFooter(plain));
    },
  );
});

test('a template missing from the theme falls back to the engine template', () => {
  inTree({ 'templates/other.njk': 'other' }, (theme) => {
    const themed = createTemplates({ lang: 'en', theme }).render('page.njk', { site, page });
    const plain = createTemplates({ lang: 'en' }).render('page.njk', { site, page });
    assert.equal(themed, plain);
  });
});

test('a theme without a templates folder still works', () => {
  inTree({ 'README.txt': 'empty theme' }, (theme) => {
    const html = createTemplates({ lang: 'en', theme }).render('page.njk', { site, page });
    assert.match(html, /Built with coffer/);
  });
});

test('a theme template replaces the engine template of the same name', () => {
  inTree({ 'templates/page.njk': 'theme page' }, (theme) => {
    assert.equal(createTemplates({ lang: 'en', theme }).render('page.njk', { site, page }), 'theme page');
  });
});

test('the coffer: prefix always resolves to the engine copy', () => {
  inTree({ 'templates/page.njk': 'theme page' }, (theme) => {
    const templates = createTemplates({ lang: 'en', theme });
    assert.equal(templates.renderString('{% include "page.njk" %}'), 'theme page');
    assert.match(templates.renderString('{% include "coffer:page.njk" %}', { site, page }), /<h1>Hello<\/h1>/);
  });
});

test('a template found nowhere is an error', () => {
  assert.throws(() => createTemplates({ lang: 'en' }).render('nope.njk'), /nope\.njk/);
});

test('output is escaped unless a template marks it safe', () => {
  const html = createTemplates({ lang: 'en' }).render('page.njk', {
    site: { title: 'A & B <i>' },
    page: { title: '<script>', content: '<p>ok</p>' },
  });
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /A &amp; B &lt;i&gt;/);
  assert.match(html, /<p>ok<\/p>/);
});

test('Russian plural forms are right for 1, 2, 5 and 21', () => {
  const t = new Translator({ lang: 'ru' });
  const minutes = [1, 2, 5, 21].map((count) => t.t('post.reading_time', { count }));
  assert.deepEqual(minutes, ['1 минута', '2 минуты', '5 минут', '21 минута']);
  assert.deepEqual(
    [0, 11, 12, 14, 22, 25, 100, 101, 111].map((count) => t.t('post.reading_time', { count })),
    ['0 минут', '11 минут', '12 минут', '14 минут', '22 минуты', '25 минут', '100 минут', '101 минута', '111 минут'],
  );
  assert.deepEqual(t.missing(), []);
});

test('Russian plural forms work through the t filter in a template', () => {
  const templates = createTemplates({ lang: 'ru' });
  const out = [1, 2, 5, 21].map((count) =>
    templates.renderString("{{ 'post.reading_time' | t({ count: n }) }}", { n: count }),
  );
  assert.deepEqual(out, ['1 минута', '2 минуты', '5 минут', '21 минута']);
});

test('English plural forms', () => {
  const t = new Translator({ lang: 'en' });
  assert.equal(t.t('post.reading_time', { count: 1 }), '1 minute');
  assert.equal(t.t('post.reading_time', { count: 5 }), '5 minutes');
});

test('parameters are filled in', () => {
  assert.equal(new Translator({ lang: 'en' }).t('post.series_part', { n: 2, m: 5 }), 'Part 2 of 5');
  assert.equal(new Translator({ lang: 'ru' }).t('post.series_part', { n: 2, m: 5 }), 'Часть 2 из 5');
});

test('a plural string without a count is an error', () => {
  assert.throws(() => new Translator({ lang: 'en' }).t('post.reading_time'), /count/);
});

test('English and Russian files define the same keys', () => {
  const en = [...loadStrings('en').strings.keys()].sort();
  const ru = [...loadStrings('ru').strings.keys()].sort();
  assert.deepEqual(ru, en);
});

test('the pages render in Russian', () => {
  const html = createTemplates({ lang: 'ru' }).render('page.njk', { site, page });
  assert.match(html, /<html lang="ru">/);
  assert.match(html, /Главная/);
  assert.match(html, /Сделано на coffer/);
  assert.match(html, /Материалы: CC BY 4\.0/);
});

test('missing keys fall back to English and are reported once', () => {
  inTree(
    {
      'engine/en.yaml': 'a: Hello\nb: World\n',
      'engine/ru.yaml': 'a: Привет\n',
    },
    (dir) => {
      const reported = /** @type {string[]} */ ([]);
      const t = new Translator({
        lang: 'ru',
        engineDir: join(dir, 'engine'),
        onMissing: (message) => reported.push(message),
      });
      assert.equal(t.t('a'), 'Привет');
      assert.equal(t.t('b'), 'World');
      assert.equal(t.t('b'), 'World');
      assert.equal(t.t('c'), 'c');
      assert.deepEqual(reported, [
        'ru: missing string "b"; using English',
        'ru: missing string "c"',
      ]);
      assert.deepEqual(t.missing(), reported);
    },
  );
});

test('the template engine reports missing strings', () => {
  const reported = /** @type {string[]} */ ([]);
  const templates = createTemplates({ lang: 'en', onMissing: (m) => reported.push(m) });
  assert.equal(templates.renderString("{{ 'no.such.key' | t }}"), 'no.such.key');
  assert.deepEqual(templates.missingStrings(), ['en: missing string "no.such.key"']);
  assert.deepEqual(reported, templates.missingStrings());
});

test('a theme can override strings for a language', () => {
  inTree({ 'i18n/en.yaml': 'footer:\n  credit: Made by hand\n' }, (theme) => {
    const html = createTemplates({ lang: 'en', theme }).render('page.njk', { site, page });
    assert.match(html, /Made by hand/);
    assert.match(html, /Home/, 'strings the theme does not list keep the engine text');
  });
});

test('a theme can add a language', () => {
  inTree(
    {
      'i18n/de.yaml':
        'nav:\n  home: Startseite\nfooter:\n  credit: Gebaut mit coffer\npost:\n  reading_time:\n    one: "{count} Minute"\n    other: "{count} Minuten"\n',
    },
    (theme) => {
      const templates = createTemplates({ lang: 'de', theme });
      const html = templates.render('page.njk', { site, page });
      assert.match(html, /<html lang="de">/);
      assert.match(html, /Startseite/);
      assert.match(html, /Gebaut mit coffer/);
      assert.match(html, /Skip to content/, 'strings missing in German use English');
      assert.ok(templates.missingStrings().some((m) => m.includes('"nav.skip"')));
      assert.equal(templates.translator.t('post.reading_time', { count: 3 }), '3 Minuten');
    },
  );
});

test('a language without any strings falls back to English and says so', () => {
  const templates = createTemplates({ lang: 'fr' });
  assert.match(templates.render('page.njk', { site, page }), /Skip to content/);
  assert.match(templates.missingStrings()[0], /no UI strings for language "fr"/);
});

test('a regional language tag uses the base language strings', () => {
  const t = new Translator({ lang: 'ru-RU' });
  assert.equal(t.t('nav.home'), 'Главная');
  assert.deepEqual(t.missing(), []);
});

test('an invalid strings file is reported with its path', () => {
  inTree({ 'i18n/en.yaml': 'nav: [1, 2]\n' }, (theme) => {
    assert.throws(() => new Translator({ lang: 'en', themeDir: theme }), /en\.yaml.*"nav/);
  });
  inTree({ 'i18n/en.yaml': 'a: [unclosed\n' }, (theme) => {
    assert.throws(() => new Translator({ lang: 'en', themeDir: theme }), /en\.yaml/);
  });
});

test('a language tag cannot escape the strings directory', () => {
  assert.throws(() => loadStrings('../secret'), /not a valid language tag/);
});

test('the date filter formats in the language and the time zone of the site', () => {
  const en = createTemplates({ lang: 'en', timezone: 'Europe/Samara' });
  const ru = createTemplates({ lang: 'ru', timezone: 'Europe/Samara' });
  const moment = new Date('2024-05-01T21:30:00Z');
  assert.equal(en.renderString('{{ d | date }}', { d: moment }), 'May 2, 2024');
  assert.equal(en.renderString("{{ d | date('long') }}", { d: moment }), 'May 2, 2024');
  assert.equal(ru.renderString("{{ d | date('long') }}", { d: moment }), '2 мая 2024 г.');
  assert.equal(en.renderString("{{ d | date('iso') }}", { d: moment }), '2024-05-02');
  assert.equal(
    ru.renderString("{{ d | date({ month: 'long', year: 'numeric' }) }}", { d: moment }),
    'май 2024 г.',
  );
});

test('a calendar date string is never shifted by the time zone', () => {
  assert.equal(formatDate('en', '2024-05-01', 'long', 'America/Los_Angeles'), 'May 1, 2024');
  assert.equal(formatDate('en', '2024-05-01', 'iso', 'Pacific/Auckland'), '2024-05-01');
});

test('the date filter rejects values that are not dates and unknown formats', () => {
  assert.throws(() => formatDate('en', 'yesterday'), /cannot format/);
  assert.throws(() => formatDate('en', new Date(), 'huge'), /unknown date format/);
});

test('the url filter prefixes and adds the trailing slash', () => {
  assert.equal(siteUrl('/devlog'), '/devlog/');
  assert.equal(siteUrl('/devlog/'), '/devlog/');
  assert.equal(siteUrl('/'), '/');
  assert.equal(siteUrl('/a/b?x=1#top'), '/a/b/?x=1#top');
  assert.equal(siteUrl('/a//b'), '/a/b/');
  assert.equal(siteUrl('/devlog', '/docs'), '/docs/devlog/');
  assert.equal(siteUrl('/', '/docs'), '/docs/');
});

test('the url filter leaves files, absolute URLs and fragments alone', () => {
  assert.equal(siteUrl('/feed.xml'), '/feed.xml');
  assert.equal(siteUrl('/devlog/feed.xml', '/docs'), '/docs/devlog/feed.xml');
  assert.equal(siteUrl('/style.css?v=2'), '/style.css?v=2');
  assert.equal(siteUrl('/post/v1.2'), '/post/v1.2/');
  assert.equal(siteUrl('https://example.org/a', '/docs'), 'https://example.org/a');
  assert.equal(siteUrl('mailto:me@example.org'), 'mailto:me@example.org');
  assert.equal(siteUrl('//cdn.example.org/a'), '//cdn.example.org/a');
  assert.equal(siteUrl('#top'), '#top');
  assert.equal(siteUrl('relative/path'), 'relative/path');
});

test('the url filter uses the path of the site base URL', () => {
  const nested = createTemplates({ lang: 'en', baseUrl: 'https://example.org/sub' });
  assert.equal(nested.renderString("{{ '/devlog' | url }}"), '/sub/devlog/');
  const root = createTemplates({ lang: 'en', baseUrl: 'https://example.org' });
  assert.equal(root.renderString("{{ '/devlog' | url }}"), '/devlog/');
  const html = nested.render('page.njk', { site, page });
  assert.match(html, /<a class="site-title" href="\/sub\/">/);
});
