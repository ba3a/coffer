import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isRfc3339, validateFeed } from '../../src/check/feed-validator.js';

const SELF = 'https://site.example/blog/feed.xml';

/**
 * A small valid feed; `entry` and `head` replace parts of it.
 *
 * @param {{ head?: string, entry?: string, root?: string }} [parts]
 * @returns {string}
 */
function feed(parts = {}) {
  const head =
    parts.head ??
    `<id>${SELF}</id><title>Blog</title><updated>2025-04-10T09:00:00Z</updated>` +
      `<link rel="self" type="application/atom+xml" href="${SELF}"/>` +
      '<link rel="alternate" type="text/html" href="https://site.example/blog/"/>' +
      '<author><name>Tove</name></author>';
  const entry =
    parts.entry ??
    '<entry><id>https://site.example/blog/a/</id><title>A</title><updated>2025-04-10T09:00:00Z</updated>' +
      '<published>2025-04-10T09:00:00+02:00</published>' +
      '<link rel="alternate" href="https://site.example/blog/a/"/><summary>s</summary>' +
      '<content type="html">&lt;p&gt;&lt;a href="https://site.example/x/"&gt;x&lt;/a&gt;&lt;/p&gt;</content></entry>';
  return `<?xml version="1.0" encoding="utf-8"?><feed ${parts.root ?? 'xmlns="http://www.w3.org/2005/Atom"'}>${head}${entry}</feed>`;
}

/**
 * @param {string} xml
 * @param {string} [selfUrl]
 */
function errorsOf(xml, selfUrl = SELF) {
  return validateFeed(xml, { selfUrl }).errors;
}

test('a complete feed is valid', () => {
  const result = validateFeed(feed(), { selfUrl: SELF });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.valid, true);
  assert.equal(result.entries, 1);
});

test('RFC 3339 dates need a time, an offset and real calendar values', () => {
  for (const good of ['2025-04-10T09:00:00Z', '2025-04-10T09:00:00.123+04:00', '2024-02-29T00:00:00z']) {
    assert.equal(isRfc3339(good), true, good);
  }
  for (const bad of ['2025-04-10', '2025-04-10T09:00:00', '2025-02-29T00:00:00Z', '2025-13-01T00:00:00Z', '2025-04-10T24:00:00Z', 'Thu, 10 Apr 2025 09:00:00 GMT']) {
    assert.equal(isRfc3339(bad), false, bad);
  }
});

test('a document that is not well-formed XML is invalid', () => {
  const result = validateFeed('<feed xmlns="http://www.w3.org/2005/Atom"><id>x</feed>');
  assert.equal(result.valid, false);
  assert.match(result.errors[0], /not well-formed XML.*does not match/);
});

test('the root must be an Atom feed', () => {
  assert.match(errorsOf('<rss version="2.0"/>')[0], /root element must be <feed/);
  assert.match(errorsOf('<feed xmlns="urn:other"/>')[0], /root element must be <feed/);
});

test('the required feed elements are checked', () => {
  const errors = errorsOf(feed({ head: '', entry: '' }));
  assert.ok(errors.some((e) => /feed has no <id>/.test(e)), errors.join('\n'));
  assert.ok(errors.some((e) => /feed has no <title>/.test(e)));
  assert.ok(errors.some((e) => /feed has no <updated>/.test(e)));
  assert.ok(errors.some((e) => /no <link rel="self">/.test(e)));
  assert.ok(errors.some((e) => /no <author>/.test(e)));
});

test('the self link must be the address the feed is served from', () => {
  const wrong = feed().replace(`rel="self" type="application/atom+xml" href="${SELF}"`, 'rel="self" type="application/atom+xml" href="https://site.example/other.xml"');
  assert.match(errorsOf(wrong)[0], /self link is "https:\/\/site.example\/other.xml", the feed is served from/);
  assert.deepEqual(validateFeed(wrong).errors, []);
});

test('dates must be RFC 3339', () => {
  const errors = errorsOf(feed().replace('<updated>2025-04-10T09:00:00Z</updated><link', '<updated>2025-04-10</updated><link'));
  assert.match(errors[0], /feed <updated> is not an RFC 3339 date-time: "2025-04-10"/);
  const entryErrors = errorsOf(feed().replace('<published>2025-04-10T09:00:00+02:00', '<published>yesterday'));
  assert.match(entryErrors[0], /<published> is not an RFC 3339/);
});

test('entry ids must be unique and entries need their required elements', () => {
  const entry = feed().match(/<entry>.*<\/entry>/)?.[0] ?? '';
  const duplicated = errorsOf(feed({ entry: entry + entry }));
  assert.ok(duplicated.some((e) => /<id> is used by another entry/.test(e)), duplicated.join('\n'));
  const bare = errorsOf(feed({ entry: '<entry><link rel="alternate" href="https://site.example/a/"/></entry>' }));
  assert.ok(bare.some((e) => /entry has no <id>/.test(e)));
  assert.ok(bare.some((e) => /entry has no <title>/.test(e)));
  assert.ok(bare.some((e) => /entry has no <updated>/.test(e)));
});

test('an entry needs content or an alternate link, and an id that is an absolute IRI', () => {
  const noLink = feed().replace('<link rel="alternate" href="https://site.example/blog/a/"/>', '').replace(/<content.*<\/content>/, '');
  assert.ok(errorsOf(noLink).some((e) => /needs a <content> or a link/.test(e)));
  const relativeId = feed().replace('<id>https://site.example/blog/a/</id>', '<id>/blog/a/</id>');
  assert.ok(errorsOf(relativeId).some((e) => /not an absolute IRI/.test(e)));
});

test('links and HTML content must use absolute URLs', () => {
  const relativeLink = feed().replace('<link rel="alternate" href="https://site.example/blog/a/"/>', '<link rel="alternate" href="/blog/a/"/>');
  assert.ok(errorsOf(relativeLink).some((e) => /<link> href is not an absolute URL: "\/blog\/a\/"/.test(e)));

  const content = '&lt;p&gt;&lt;a href="../b/"&gt;b&lt;/a&gt; &lt;img src="p.png" srcset="p.png 1x, https://site.example/q.png 2x"&gt;&lt;/p&gt;';
  const relativeContent = feed().replace(/<content.*<\/content>/, `<content type="html">${content}</content>`);
  const errors = errorsOf(relativeContent);
  assert.equal(errors.length, 3, errors.join('\n'));
  assert.match(errors[0], /relative URL in a href: "\.\.\/b\/"/);
  assert.match(errors[1], /relative URL in img src: "p.png"/);
  assert.match(errors[2], /relative URL in img srcset: "p.png"/);
});

test('an entry without a summary is a warning when it has content, an error when it has none', () => {
  const noSummary = feed().replace('<summary>s</summary>', '');
  const result = validateFeed(noSummary, { selfUrl: SELF });
  assert.equal(result.valid, true);
  assert.match(result.warnings[0], /no <summary>/);
});

test('a feed-level author is enough; without one every entry needs its own', () => {
  const withoutFeedAuthor = feed().replace('<author><name>Tove</name></author>', '');
  assert.ok(errorsOf(withoutFeedAuthor).some((e) => /no <author>/.test(e)));
  const entryAuthor = withoutFeedAuthor.replace('<summary>', '<author><name>Tove</name></author><summary>');
  assert.deepEqual(errorsOf(entryAuthor), []);
});
