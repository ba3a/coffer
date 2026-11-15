import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MarkdownError, renderMarkdown } from '../src/markdown/render.js';
import { VIDEO_PLACEHOLDER_ATTRIBUTE } from '../src/markdown/directives/video.js';
import { DEFAULT_VIDEO_RULES, matchVideoUrl } from '../src/video/rules.js';
import * as coffer from '../src/index.js';

const YT = 'https://youtu.be/aBcD3fGh1_-';

/**
 * Renders `source` as `post.md` and returns the error message it fails with.
 *
 * @param {string} source
 * @param {import('../src/markdown/render.js').RenderOptions} [options]
 * @returns {Promise<string>}
 */
async function errorOf(source, options = {}) {
  try {
    await renderMarkdown(source, { file: 'post.md', ...options });
  } catch (error) {
    assert.ok(error instanceof MarkdownError, String(error));
    return error.message;
  }
  assert.fail(`no error for ${JSON.stringify(source)}`);
}

/**
 * @param {import('../src/markdown/render.js').RenderResult} result
 * @returns {string[]}
 */
function warningsOf(result) {
  return result.videoWarnings.map((warning) => `${warning.line}:${warning.column}: ${warning.message}`);
}

/** Finds `clip.mp4` and `Glue Up.MP4`, as a build would for files beside the post. */
const locateFile = (/** @type {string} */ src) =>
  ({ 'clip.mp4': '/journal/p/clip.mp4', 'Glue Up.MP4': '/journal/walnut-box/glue-up.mp4', 'b.WebM': '/journal/p/b.webm' })[src] ?? null;
const LOCAL = { video: { rules: DEFAULT_VIDEO_RULES, load: /** @type {const} */ ('click'), locateFile } };

test('VIDEO_PLACEHOLDER_ATTRIBUTE is data-coffer-video and is exported by the package', () => {
  assert.equal(VIDEO_PLACEHOLDER_ATTRIBUTE, 'data-coffer-video');
  assert.equal(coffer.VIDEO_PLACEHOLDER_ATTRIBUTE, 'data-coffer-video');
});

test('a ::video directive leaves a placeholder and is listed with every field', async () => {
  const result = await renderMarkdown(`::video[Fitting the drawer]{src="${YT}?t=12" id="drawer"}\n`);
  assert.equal(result.html, '<div data-coffer-video="0"></div>');
  assert.deepEqual(result.videos, [
    {
      index: 0,
      source: 'directive',
      id: 'drawer',
      htmlId: 'video-drawer',
      src: `${YT}?t=12`,
      provider: 'youtube',
      providerName: 'YouTube',
      match: matchVideoUrl(`${YT}?t=12`, DEFAULT_VIDEO_RULES),
      file: null,
      title: 'Fitting the drawer',
      start: 12,
      end: null,
      poster: null,
      load: 'click',
      embedUrl: 'https://www.youtube-nocookie.com/embed/aBcD3fGh1_-?start=12',
      playUrl: 'https://www.youtube-nocookie.com/embed/aBcD3fGh1_-?start=12&autoplay=1',
      watchUrl: 'https://www.youtube.com/watch?v=aBcD3fGh1_-&t=12s',
      chapters: [],
      line: 1,
      column: 1,
    },
  ]);
  assert.deepEqual(result.videoWarnings, []);
  assert.ok(result.ids.includes('video-drawer'));
});

test('a text without videos has empty video lists', async () => {
  const result = await renderMarkdown('Just words.');
  assert.deepEqual(result.videos, []);
  assert.deepEqual(result.videoWarnings, []);
});

test('videos are numbered in document order, and the html id uses the number when there is no id', async () => {
  const source = `Intro\n\n::video{src="${YT}"}\n\n- item\n\n  ::video{src="https://vimeo.com/76979871" id="planing"}\n\n::video{src="${YT}"}\n`;
  const result = await renderMarkdown(source, { startLine: 4 });
  assert.deepEqual(
    result.videos.map((video) => [video.index, video.htmlId, video.line, video.column]),
    [
      [0, 'video-1', 6, 1],
      [1, 'video-planing', 10, 3],
      [2, 'video-3', 12, 1],
    ],
  );
  for (const index of [0, 1, 2]) assert.ok(result.html.includes(`<div data-coffer-video="${index}"></div>`));
  for (const id of ['video-1', 'video-planing', 'video-3']) assert.ok(result.ids.includes(id), id);
});

test('the html id carries the idPrefix, and ids lists it without the prefix', async () => {
  const result = await renderMarkdown(`::video{src="${YT}" id="drawer"}\n\n::video{src="${YT}"}\n\n[back](#video-drawer)\n`, {
    idPrefix: 'p1-',
  });
  assert.deepEqual(
    result.videos.map((video) => video.htmlId),
    ['p1-video-drawer', 'p1-video-2'],
  );
  assert.ok(result.ids.includes('video-drawer'));
  assert.ok(result.ids.includes('video-2'));
  assert.ok(!result.ids.some((id) => id.startsWith('p1-')));
  // A link to the video points at the prefixed id of the page.
  assert.match(result.html, /href="#p1-video-drawer"/);
});

test('the title is the label reduced to plain text and trimmed; an empty one is none', async () => {
  const titleOf = async (/** @type {string} */ label) =>
    (await renderMarkdown(`::video${label}{src="${YT}"}\n`)).videos[0].title;
  assert.equal(await titleOf('[  Sawing the *tails* with `saw` ]'), 'Sawing the tails with saw');
  assert.equal(await titleOf('[   ]'), null);
  assert.equal(await titleOf('[]'), null);
  assert.equal(await titleOf(''), null);
});

test('the title, src and poster of a video are not words, links or images', async () => {
  const result = await renderMarkdown(`One two.\n\n::video[Three four five]{src="${YT}" poster="cover.jpg"}\n`);
  assert.equal(result.words, 2);
  assert.deepEqual(result.links, []);
  assert.deepEqual(result.images, []);
  assert.equal(result.firstImage, null);
  assert.equal(result.videos[0].poster, 'cover.jpg');
});

test('start and end: the attribute overrides the URL, start="0" removes the start of the URL', async () => {
  const one = async (/** @type {string} */ attributes) => (await renderMarkdown(`::video{${attributes}}\n`)).videos[0];
  const embed = 'https://www.youtube.com/embed/aBcD3fGh1_-?start=30&end=95';

  let video = await one(`src="${embed}"`);
  assert.deepEqual([video.start, video.end], [30, 95]);
  video = await one(`src="${embed}" start="1:00" end="2m"`);
  assert.deepEqual([video.start, video.end], [60, 120]);
  assert.equal(video.embedUrl, 'https://www.youtube-nocookie.com/embed/aBcD3fGh1_-?start=60&end=120');
  assert.equal(video.playUrl, 'https://www.youtube-nocookie.com/embed/aBcD3fGh1_-?start=60&end=120&autoplay=1');
  assert.equal(video.watchUrl, 'https://www.youtube.com/watch?v=aBcD3fGh1_-&t=60s');
  video = await one(`src="${embed}" start="0"`);
  assert.deepEqual([video.start, video.end], [null, 95]);
  assert.equal(video.watchUrl, 'https://www.youtube.com/watch?v=aBcD3fGh1_-');
  video = await one(`src="${YT}?t=12" start="1h2m3s"`);
  assert.equal(video.start, 3723);
});

test('load comes from the attribute, else from the option', async () => {
  const load = async (/** @type {string} */ attributes, /** @type {'click' | 'iframe'} */ option) =>
    (await renderMarkdown(`::video{src="${YT}"${attributes}}\n`, { video: { rules: DEFAULT_VIDEO_RULES, load: option, locateFile } }))
      .videos[0].load;
  assert.equal(await load('', 'click'), 'click');
  assert.equal(await load('', 'iframe'), 'iframe');
  assert.equal(await load(' load="iframe"', 'click'), 'iframe');
  assert.equal(await load(' load="click"', 'iframe'), 'click');
});

test('the rules of the option decide which addresses are videos', async () => {
  const rules = [
    {
      pattern: 'https://tube\\.example/v/(?<id>[a-z0-9]{8})(?:[?#].*)?',
      flags: /** @type {const} */ (''),
      provider: /** @type {const} */ ('generic'),
      generic: {
        name: 'Example Tube',
        embed: 'https://player.tube.example/e/{id}',
        watch: 'https://tube.example/v/{id}',
        startParam: 't',
        endParam: null,
        autoplayParam: 'autoplay',
        thumbnail: null,
        oembed: null,
      },
    },
  ];
  const options = { file: 'post.md', video: { rules, load: /** @type {const} */ ('click'), locateFile } };
  const result = await renderMarkdown('::video{src="https://tube.example/v/abcd1234?t=15"}\n', options);
  const [video] = result.videos;
  assert.equal(video.provider, 'generic');
  assert.equal(video.providerName, 'Example Tube');
  assert.equal(video.start, 15);
  assert.equal(video.playUrl, 'https://player.tube.example/e/abcd1234?t=15&autoplay=1');
  assert.equal(
    await errorOf(`::video{src="${YT}"}`, options),
    `post.md:1:1: "${YT}" is not a video address that any rule knows`,
  );
});

test('a local video is located with locateFile and has no remote fields', async () => {
  /** @type {string[]} */
  const asked = [];
  const result = await renderMarkdown('::video[Glue-up, sped up]{src="Glue Up.MP4" start="5" poster="glue.jpg"}\n', {
    video: {
      rules: DEFAULT_VIDEO_RULES,
      load: 'iframe',
      locateFile: (src) => {
        asked.push(src);
        return locateFile(src);
      },
    },
  });
  assert.deepEqual(asked, ['Glue Up.MP4']);
  assert.deepEqual(result.videos, [
    {
      index: 0,
      source: 'directive',
      id: null,
      htmlId: 'video-1',
      src: 'Glue Up.MP4',
      provider: 'file',
      providerName: '',
      match: null,
      file: { url: '/journal/walnut-box/glue-up.mp4', type: 'video/mp4' },
      title: 'Glue-up, sped up',
      start: 5,
      end: null,
      poster: 'glue.jpg',
      load: null,
      embedUrl: null,
      playUrl: null,
      watchUrl: null,
      chapters: [],
      line: 1,
      column: 1,
    },
  ]);
  const webm = await renderMarkdown('::video{src="b.WebM" end="10"}\n', LOCAL);
  assert.deepEqual(webm.videos[0].file, { url: '/journal/p/b.webm', type: 'video/webm' });
  assert.equal(webm.videos[0].end, 10);
  assert.deepEqual(webm.videoWarnings, []);
});

test('the error vectors of a ::video directive', async () => {
  const vectors = [
    ['::video', 'post.md:1:1: a video needs src="..."'],
    [
      `::video{src="${YT}" size="big"}`,
      'post.md:1:1: a video has no attribute "size" (the attributes are src, start, end, poster, load and id)',
    ],
    ['::video{src="https://example.org/x"}', 'post.md:1:1: "https://example.org/x" is not a video address that any rule knows'],
    [
      '::video{src="/clips/x.mp4"}',
      'post.md:1:1: src="/clips/x.mp4" is not allowed: a video is an http(s) address or a file beside the post',
    ],
    ['::video{src="clip.avi"}', 'post.md:1:1: a local video must be an .mp4 or .webm file: "clip.avi"'],
    ['::video{src="clip.mp4"}', 'post.md:1:1: local video "clip.mp4" does not exist'],
    [`::video{src="${YT}" start="1:60"}`, 'post.md:1:1: start="1:60" is not a timecode (write 83, 1:23, 1:02:03 or 1m23s)'],
    [`::video{src="${YT}" start="90" end="1:30"}`, 'post.md:1:1: end must be later than start'],
    [`::video{src="${YT}" load="auto"}`, 'post.md:1:1: load must be "click" or "iframe"'],
    [
      `::video{src="${YT}" id="Drawer"}`,
      'post.md:1:1: id must start with a lower-case letter and hold only lower-case letters, digits and "-"',
    ],
  ];
  for (const [source, message] of vectors) assert.equal(await errorOf(source), message, source);
});

test('more errors of a ::video directive', async () => {
  const cases = [
    // V3: a protocol-relative address, other schemes.
    ['::video{src="//cdn.example/x.mp4"}', 'post.md:1:1: src="//cdn.example/x.mp4" is not allowed: a video is an http(s) address or a file beside the post'],
    ['::video{src="ftp://example.org/x.mp4"}', 'post.md:1:1: src="ftp://example.org/x.mp4" is not allowed: a video is an http(s) address or a file beside the post'],
    ['::video{src="data:video/mp4,AAAA"}', 'post.md:1:1: src="data:video/mp4,AAAA" is not allowed: a video is an http(s) address or a file beside the post'],
    // V1 for an empty src.
    ['::video{src=""}', 'post.md:1:1: a video needs src="..."'],
    // V5 for a file without an extension.
    ['::video{src="clip"}', 'post.md:1:1: a local video must be an .mp4 or .webm file: "clip"'],
    // V8.
    ['::video{src="clip.mp4" load="iframe"}', 'post.md:1:1: load does not apply to a local video'],
    // V10, at the second.
    [`::video{src="${YT}" id="drawer"}\n\nText\n\n::video{src="clip.mp4" id="drawer"}`, 'post.md:5:1: two videos have the id "drawer"'],
    // V11 for end, and for an empty value.
    [`::video{src="${YT}" end="soon"}`, 'post.md:1:1: end="soon" is not a timecode (write 83, 1:23, 1:02:03 or 1m23s)'],
    [`::video{src="${YT}" start}`, 'post.md:1:1: start="" is not a timecode (write 83, 1:23, 1:02:03 or 1m23s)'],
    // V12: the end of the URL against the start attribute, end="0", a local video.
    ['::video{src="https://www.youtube.com/embed/aBcD3fGh1_-?end=20" start="30"}', 'post.md:1:1: end must be later than start'],
    [`::video{src="${YT}" end="0"}`, 'post.md:1:1: end must be later than start'],
    ['::video{src="clip.mp4" start="10" end="5"}', 'post.md:1:1: end must be later than start'],
    // The position is that of the directive, with the lines of the front matter.
    [`Text\n\n  ::video{src="${YT}" load="x"}`, 'post.md:3:3: load must be "click" or "iframe"'],
  ];
  for (const [source, message] of cases) assert.equal(await errorOf(source, LOCAL), message, source);
  assert.equal(await errorOf('Text\n\n::video', { startLine: 6 }), 'post.md:8:1: a video needs src="..."');
});

test('the checks of a video run in the order of the specification', async () => {
  const cases = [
    // V2 in source order, before V1.
    ['::video{size="big" colour="red"}', 'post.md:1:1: a video has no attribute "size" (the attributes are src, start, end, poster, load and id)'],
    ['::video{.wide src="x.mp4"}', 'post.md:1:1: a video has no attribute "class" (the attributes are src, start, end, poster, load and id)'],
    // V1 before V7.
    ['::video{load="auto"}', 'post.md:1:1: a video needs src="..."'],
    // V3 before V7.
    ['::video{src="/x.mp4" load="auto"}', 'post.md:1:1: src="/x.mp4" is not allowed: a video is an http(s) address or a file beside the post'],
    // V4 before V7, V5 before V6.
    ['::video{src="https://example.org/x" load="auto"}', 'post.md:1:1: "https://example.org/x" is not a video address that any rule knows'],
    ['::video{src="missing.avi"}', 'post.md:1:1: a local video must be an .mp4 or .webm file: "missing.avi"'],
    // V6 before V7.
    ['::video{src="missing.mp4" load="auto"}', 'post.md:1:1: local video "missing.mp4" does not exist'],
    // V7 before V8.
    ['::video{src="clip.mp4" load="auto"}', 'post.md:1:1: load must be "click" or "iframe"'],
    // V8 before V9.
    ['::video{src="clip.mp4" load="click" id="X"}', 'post.md:1:1: load does not apply to a local video'],
    // V9 before V11.
    [`::video{src="${YT}" id="9a" start="x"}`, 'post.md:1:1: id must start with a lower-case letter and hold only lower-case letters, digits and "-"'],
    // V10 before V11.
    [`::video{src="${YT}" id="a"}\n\n::video{src="${YT}" id="a" start="x"}`, 'post.md:3:1: two videos have the id "a"'],
    // V11: start before end, both before V12.
    [`::video{src="${YT}" end="x" start="y"}`, 'post.md:1:1: start="y" is not a timecode (write 83, 1:23, 1:02:03 or 1m23s)'],
    // An earlier video is checked first.
    [`::video{src="${YT}" end="x"}\n\n::video`, 'post.md:1:1: end="x" is not a timecode (write 83, 1:23, 1:02:03 or 1m23s)'],
  ];
  for (const [source, message] of cases) assert.equal(await errorOf(source, LOCAL), message, source);
});

test('the warning vectors of a ::video directive', async () => {
  let result = await renderMarkdown('::video{src="https://vimeo.com/76979871" end="20"}\n', { file: 'post.md' });
  assert.deepEqual(warningsOf(result), ['1:1: Vimeo videos cannot stop at a given time; end="20" is ignored']);
  assert.equal(result.videos[0].end, null);
  assert.equal(result.videos[0].embedUrl, 'https://player.vimeo.com/video/76979871?dnt=1');

  result = await renderMarkdown('::video{src="https://vimeo.com/76979871" start="90" end="30"}\n', { file: 'post.md' });
  assert.deepEqual(warningsOf(result), ['1:1: Vimeo videos cannot stop at a given time; end="30" is ignored']);
  assert.deepEqual([result.videos[0].start, result.videos[0].end], [90, null]);

  result = await renderMarkdown('::video{src="https://vkvideo.ru/video-12345_456239017" start="5" end="1:00"}\n', { file: 'post.md' });
  assert.deepEqual(warningsOf(result), [
    '1:1: VK Video videos cannot start at a given time; start="5" is ignored',
    '1:1: VK Video videos cannot stop at a given time; end="1:00" is ignored',
  ]);
  assert.deepEqual([result.videos[0].start, result.videos[0].end], [null, null]);
  assert.equal(result.videos[0].playUrl, 'https://vkvideo.ru/video_ext.php?oid=-12345&id=456239017&autoplay=1');

  result = await renderMarkdown(`::video{src="${YT}" start="5" end="1:00"}\n`, { file: 'post.md' });
  assert.deepEqual(result.videoWarnings, []);
});

test('warnings are in document order and their lines include the startLine offset', async () => {
  const result = await renderMarkdown(
    'Text\n\n::video{src="https://rutube.ru/video/0123456789abcdef0123456789abcdef/" end="9"}\n\n  ::video{src="https://vkvideo.ru/video-12345_456239017" start="0"}\n',
    { file: 'post.md', startLine: 5 },
  );
  assert.deepEqual(result.videoWarnings, [
    { message: 'Rutube videos cannot stop at a given time; end="9" is ignored', line: 7, column: 1 },
    { message: 'VK Video videos cannot start at a given time; start="0" is ignored', line: 9, column: 3 },
  ]);
});

test('a local video never gets a warning', async () => {
  const result = await renderMarkdown('::video{src="clip.mp4" start="3" end="9"}\n', LOCAL);
  assert.deepEqual(result.videoWarnings, []);
  assert.deepEqual([result.videos[0].start, result.videos[0].end], [3, 9]);
});

test('an error discards the warnings found before it', async () => {
  assert.equal(
    await errorOf('::video{src="https://vimeo.com/76979871" end="20"}\n\n::video{src="clip.avi"}'),
    'post.md:3:1: a local video must be an .mp4 or .webm file: "clip.avi"',
  );
});

test('auto-embed: of the three paragraphs of 3.3 only the lone address becomes a video', async () => {
  const source = `I copied the joint from ${YT} last week.\n\n${YT}\n\n[${YT}](${YT})\n`;
  const result = await renderMarkdown(source, { file: 'post.md', startLine: 3 });
  assert.deepEqual(result.videos, [
    {
      index: 0,
      source: 'link',
      id: null,
      htmlId: 'video-1',
      src: YT,
      provider: 'youtube',
      providerName: 'YouTube',
      match: matchVideoUrl(YT, DEFAULT_VIDEO_RULES),
      file: null,
      title: null,
      start: null,
      end: null,
      poster: null,
      load: 'click',
      embedUrl: 'https://www.youtube-nocookie.com/embed/aBcD3fGh1_-',
      playUrl: 'https://www.youtube-nocookie.com/embed/aBcD3fGh1_-?autoplay=1',
      watchUrl: 'https://www.youtube.com/watch?v=aBcD3fGh1_-',
      chapters: [],
      line: 5,
      column: 1,
    },
  ]);
  assert.equal(
    result.html,
    `<p>I copied the joint from <a href="${YT}">${YT}</a> last week.</p>\n` +
      '<div data-coffer-video="0"></div>\n' +
      `<p><a href="${YT}">${YT}</a></p>`,
  );
  // The address of the video is not a link of the text; the other two are.
  assert.deepEqual(
    result.links.map((link) => [link.url, link.line]),
    [
      [YT, 3],
      [YT, 7],
    ],
  );
  assert.ok(result.ids.includes('video-1'));
});

test('auto-embed: an address in angle brackets becomes a video with src without the brackets', async () => {
  const result = await renderMarkdown(`  <${YT}>  \n`);
  assert.equal(result.html, '<div data-coffer-video="0"></div>');
  assert.equal(result.videos.length, 1);
  assert.equal(result.videos[0].src, YT);
  assert.equal(result.videos[0].source, 'link');
  assert.deepEqual(result.links, []);
});

test('auto-embed: a lone address inside a list item, a block quote or a footnote stays a link', async () => {
  for (const source of [`- ${YT}\n`, `> ${YT}\n`, `Text[^1].\n\n[^1]: ${YT}\n`, `1. Step\n\n   ${YT}\n`]) {
    const result = await renderMarkdown(source);
    assert.deepEqual(result.videos, [], source);
    assert.ok(result.links.some((link) => link.url === YT), source);
  }
});

test('auto-embed: a lone address that matches no rule stays a link without an error', async () => {
  const result = await renderMarkdown('https://example.org/x\n\n<https://example.org/y>\n', { file: 'post.md' });
  assert.deepEqual(result.videos, []);
  assert.deepEqual(result.videoWarnings, []);
  assert.deepEqual(
    result.links.map((link) => link.url),
    ['https://example.org/x', 'https://example.org/y'],
  );
});

test('auto-embed: only a paragraph that is exactly one address becomes a video', async () => {
  for (const source of [
    `${YT} ${YT}\n`,
    `${YT}\n${YT}\n`,
    `*${YT}*\n`,
    `See ${YT}\n`,
    `<${YT}> again\n`,
    `www.youtube.com/watch?v=aBcD3fGh1_-\n`,
  ]) {
    const result = await renderMarkdown(source);
    assert.deepEqual(result.videos, [], source);
  }
});

test('auto-embed: the lone VK Video address of vector 15.7 D', async () => {
  const result = await renderMarkdown('https://vkvideo.ru/video-12345_456239017\n');
  assert.equal(result.videos.length, 1);
  const [video] = result.videos;
  assert.equal(video.index, 0);
  assert.equal(video.htmlId, 'video-1');
  assert.equal(video.source, 'link');
  assert.equal(video.provider, 'vkvideo');
  assert.equal(video.providerName, 'VK Video');
  assert.equal(video.title, null);
  assert.equal(video.load, 'click');
  assert.equal(video.playUrl, 'https://vkvideo.ru/video_ext.php?oid=-12345&id=456239017&autoplay=1');
  assert.equal(video.watchUrl, 'https://vkvideo.ru/video-12345_456239017');
  assert.deepEqual(result.videoWarnings, []);
});

test('auto-embed: times come from the URL, and the video takes the load of the option', async () => {
  const result = await renderMarkdown(`${YT}?t=1m5s\n`, {
    video: { rules: DEFAULT_VIDEO_RULES, load: 'iframe', locateFile: () => null },
  });
  assert.equal(result.videos[0].start, 65);
  assert.equal(result.videos[0].load, 'iframe');
  assert.equal(result.videos[0].embedUrl, 'https://www.youtube-nocookie.com/embed/aBcD3fGh1_-?start=65');
});

test('auto-embed: the rules of the option decide which lone addresses are videos', async () => {
  const none = await renderMarkdown('https://vimeo.com/76979871\n', { video: { rules: [], load: 'click', locateFile: () => null } });
  assert.deepEqual(none.videos, []);
  assert.deepEqual(none.links.map((link) => link.url), ['https://vimeo.com/76979871']);
  const known = await renderMarkdown('https://vimeo.com/76979871\n');
  assert.equal(known.videos[0].provider, 'vimeo');
});

test('auto-embedded videos and directives are numbered together in document order', async () => {
  const source = `::video{src="${YT}" id="first"}\n\nhttps://vimeo.com/76979871\n\n::video{src="${YT}"}\n\n${YT}\n`;
  const result = await renderMarkdown(source, { idPrefix: 'p-' });
  assert.deepEqual(
    result.videos.map((video) => [video.index, video.source, video.htmlId, video.line]),
    [
      [0, 'directive', 'p-video-first', 1],
      [1, 'link', 'p-video-2', 3],
      [2, 'directive', 'p-video-3', 5],
      [3, 'link', 'p-video-4', 7],
    ],
  );
  for (const index of [0, 1, 2, 3]) assert.ok(result.html.includes(`<div data-coffer-video="${index}"></div>`));
  for (const id of ['video-first', 'video-2', 'video-3', 'video-4']) assert.ok(result.ids.includes(id), id);
});

test('an auto-embedded address is checked like ::video{src="URL"}', async () => {
  assert.equal(
    await errorOf('Text\n\nhttps://www.youtube.com/embed/aBcD3fGh1_-?start=90&end=30\n'),
    'post.md:3:1: end must be later than start',
  );
});
