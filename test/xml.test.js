import { test } from 'node:test';
import assert from 'node:assert/strict';

import { absolutizeHtml, excerptOf } from '../src/feeds.js';
import { isAbsoluteUrl, listHtmlUrls, mapHtmlUrls } from '../src/html-urls.js';
import { XmlError, decodeEntities, escapeXml, parseXml } from '../src/xml.js';

test('escapeXml escapes markup characters and drops characters XML cannot carry', () => {
  assert.equal(escapeXml('a < b & c > d\u0001'), 'a &lt; b &amp; c &gt; d');
});

test('decodeEntities knows the XML entities and character references', () => {
  assert.equal(decodeEntities('&lt;a&gt; &amp; &quot;x&quot; &apos;y&apos; &#65;&#x42;'), '<a> & "x" \'y\' AB');
  assert.throws(() => decodeEntities('&nbsp;'), /unknown entity/);
  assert.throws(() => decodeEntities('&#0;'), /not allowed/);
  assert.equal(decodeEntities('a&nbsp;b &unknown; &#x3C;', { html: true }), 'a b &unknown; <');
});

test('parseXml reads elements, attributes, namespaces, CDATA and entities', () => {
  const root = parseXml(
    '<?xml version="1.0" encoding="utf-8"?>\n<!-- c -->\n<a:root xmlns:a="urn:a" xmlns="urn:d" id="1">\n  <child x=\'&quot;q&quot;\'>t&amp;<![CDATA[<raw>]]></child>\n  <empty/>\n</a:root>\n',
  );
  assert.equal(root.local, 'root');
  assert.equal(root.namespace, 'urn:a');
  assert.equal(root.attributes.id, '1');
  assert.equal(root.children.length, 2);
  assert.equal(root.children[0].namespace, 'urn:d');
  assert.equal(root.children[0].attributes.x, '"q"');
  assert.equal(root.children[0].text, 't&<raw>');
  assert.equal(root.children[1].local, 'empty');
  assert.equal(root.children[1].line, 5);
});

test('parseXml refuses documents that are not well-formed, with a position', () => {
  /** @type {[string, RegExp][]} */
  const cases = [
    ['<a><b></a>', /does not match <b>/],
    ['<a>', /not closed/],
    ['<a/><b/>', /more than one root/],
    ['', /no root element/],
    ['text<a/>', /text outside/],
    ['<a>1 < 2</a>', /"<" must start a tag/],
    ['<a>&nbsp;</a>', /unknown entity/],
    ['<a b="1" b="2"/>', /duplicate attribute/],
    ['<a b=1/>', /malformed attribute/],
    ['<a b="<"/>', /"<" is not allowed/],
    ['<p:a/>', /undeclared namespace prefix/],
    ['<!DOCTYPE a><a/>', /DOCTYPE/],
    ['<a>\u0001</a>', /not allowed in XML/],
    ['<a><!-- -- --></a>', /"--"/],
  ];
  for (const [source, pattern] of cases) {
    assert.throws(() => parseXml(source), (error) => error instanceof XmlError && pattern.test(error.message), source);
  }
  assert.throws(() => parseXml('<a>\n<b></c>\n</a>'), /line 2/);
});

test('mapHtmlUrls rewrites href, src, srcset and poster and leaves other text alone', () => {
  const html =
    '<p><a href="../x/">x</a> <img src=a.png alt="a > b" srcset="a-1.png 480w, a-2.png 960w"><a href=\'/y?a=1&amp;b=2\' class="k">y</a> &lt;a href="no"&gt;</p>';
  const seen = listHtmlUrls(html).map((found) => `${found.tag}.${found.attribute}=${found.url}`);
  assert.deepEqual(seen, [
    'a.href=../x/',
    'img.src=a.png',
    'img.srcset=a-1.png',
    'img.srcset=a-2.png',
    'a.href=/y?a=1&b=2',
  ]);
  const mapped = mapHtmlUrls(html, (url) => `https://h.example/${url.replace(/^[./]+/, '')}`);
  assert.equal(
    mapped,
    '<p><a href="https://h.example/x/">x</a> <img src="https://h.example/a.png" alt="a > b" srcset="https://h.example/a-1.png 480w, https://h.example/a-2.png 960w"><a href="https://h.example/y?a=1&amp;b=2" class="k">y</a> &lt;a href="no"&gt;</p>',
  );
  assert.equal(mapHtmlUrls(html, (url) => url), html);
});

test('isAbsoluteUrl wants a scheme', () => {
  assert.equal(isAbsoluteUrl('https://a.example/'), true);
  assert.equal(isAbsoluteUrl('mailto:a@b.example'), true);
  for (const relative of ['/a', '//a.example/', '#x', 'a/b.png', '../a']) {
    assert.equal(isAbsoluteUrl(relative), false, relative);
  }
});

test('absolutizeHtml resolves against the page and the site root', () => {
  const html =
    '<a href="../walnut-box/">a</a><a href="#top">b</a><a href="/about/">c</a><a href="//cdn.example/x">d</a>' +
    '<img src="photo.jpg" srcset="photo-480.jpg 480w, /img/p.jpg 2x"><a href="https://o.example/">e</a><a href="mailto:t@e.example">f</a>';
  assert.equal(
    absolutizeHtml(html, 'https://site.example/sub/journal/first/', 'https://site.example/sub'),
    '<a href="https://site.example/sub/journal/walnut-box/">a</a><a href="https://site.example/sub/journal/first/#top">b</a>' +
      '<a href="https://site.example/sub/about/">c</a><a href="https://cdn.example/x">d</a>' +
      '<img src="https://site.example/sub/journal/first/photo.jpg" srcset="https://site.example/sub/journal/first/photo-480.jpg 480w, https://site.example/sub/img/p.jpg 2x">' +
      '<a href="https://o.example/">e</a><a href="mailto:t@e.example">f</a>',
  );
});

test('excerptOf gives plain text without code blocks, cut at a word', () => {
  assert.equal(excerptOf('<h2>Hi</h2><pre><code>skip &lt;me&gt;</code></pre><p>Tom &amp; Jerry <em>ran</em>.</p>'), 'Hi Tom & Jerry ran.');
  const long = excerptOf(`<p>${'word '.repeat(100)}</p>`, 50);
  assert.ok(long.length <= 51 && long.endsWith('…'), long);
});
