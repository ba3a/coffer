import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as engine from '../src/index.js';
import { loadStrings } from '../src/render/i18n.js';
import { DEFAULT_VIDEO_LABELS, renderVideoHtml } from '../src/video/html.js';
import { DEFAULT_VIDEO_RULES, matchVideoUrl } from '../src/video/rules.js';
import { embedUrl, watchUrl } from '../src/video/urls.js';

/** @typedef {import('../src/video/types.js').VideoDirective} VideoDirective */
/** @typedef {import('../src/video/types.js').VideoChapter} VideoChapter */
/** @typedef {import('../src/video/html.js').VideoRenderInput} VideoRenderInput */

const SIZES = '(min-width: 44rem) 41rem, calc(100vw - 2rem)';

/**
 * A remote video as the renderer would describe it.
 *
 * @param {string} src
 * @param {Partial<VideoDirective>} [fields]
 * @returns {VideoDirective}
 */
function remote(src, fields = {}) {
  const match = matchVideoUrl(src, DEFAULT_VIDEO_RULES);
  if (!match) throw new Error(`no rule matches ${src}`);
  const start = fields.start !== undefined ? fields.start : match.start;
  const end = fields.end !== undefined ? fields.end : match.end;
  return {
    index: 0,
    source: 'directive',
    id: null,
    htmlId: 'video-1',
    src,
    provider: match.provider,
    providerName: match.providerName,
    match,
    file: null,
    title: null,
    poster: null,
    load: 'click',
    chapters: [],
    line: 1,
    column: 1,
    ...fields,
    start,
    end,
    embedUrl: embedUrl(match, { start, end, autoplay: false }),
    playUrl: embedUrl(match, { start, end, autoplay: true }),
    watchUrl: watchUrl(match, start),
  };
}

/**
 * A local video as the renderer would describe it.
 *
 * @param {Partial<VideoDirective>} [fields]
 * @returns {VideoDirective}
 */
function local(fields = {}) {
  return {
    index: 0,
    source: 'directive',
    id: null,
    htmlId: 'video-1',
    src: 'Glue Up.MP4',
    provider: 'file',
    providerName: '',
    match: null,
    file: { url: '/journal/walnut-box/glue-up.mp4', type: 'video/mp4' },
    title: null,
    start: null,
    end: null,
    poster: null,
    load: null,
    embedUrl: null,
    playUrl: null,
    watchUrl: null,
    chapters: [],
    line: 1,
    column: 1,
    ...fields,
  };
}

/**
 * @param {VideoDirective} video
 * @param {Partial<VideoRenderInput>} [fields]
 * @returns {string}
 */
function render(video, fields = {}) {
  return renderVideoHtml({
    video,
    title: DEFAULT_VIDEO_LABELS.untitled,
    titleShown: false,
    preview: null,
    sizes: SIZES,
    labels: DEFAULT_VIDEO_LABELS,
    feed: false,
    ...fields,
  });
}

/** @param {string[]} lines */
const join = (lines) => lines.join('\n');

/** The video of vector 15.6. */
const DRAWER = remote('https://youtu.be/aBcD3fGh1_-?t=12', {
  id: 'drawer',
  htmlId: 'video-drawer',
  title: 'Fitting the drawer',
  chapters: [
    { seconds: 12, html: 'Marking out', text: 'Marking out' },
    { seconds: 65, html: 'Sawing the <em>tails</em>', text: 'Sawing the tails' },
  ],
});

const DRAWER_INPUT = {
  title: 'Fitting the drawer',
  titleShown: true,
  preview: {
    src: '/img/k1/youtube-preview-480.webp',
    width: 480,
    height: 360,
    srcset: [{ url: '/img/k1/youtube-preview-480.webp', width: 480 }],
  },
};

const VIMEO = remote('https://vimeo.com/76979871', { load: 'iframe' });

const VK = remote('https://vkvideo.ru/video-12345_456239017', { source: 'link' });

const VK_CHAPTERS = remote('https://vkvideo.ru/video-12345_456239017', {
  chapters: [
    { seconds: 0, html: 'Intro', text: 'Intro' },
    { seconds: 60, html: 'Cut', text: 'Cut' },
  ],
});

const GLUE = local({ title: 'Glue-up, sped up', start: 5, poster: 'glue.jpg' });

const GLUE_INPUT = {
  title: 'Glue-up, sped up',
  titleShown: true,
  preview: {
    src: '/img/k2/glue-800.webp',
    width: 800,
    height: 450,
    srcset: [
      { url: '/img/k2/glue-480.webp', width: 480 },
      { url: '/img/k2/glue-800.webp', width: 800 },
    ],
  },
};

test('the engine entry point exports renderVideoHtml and DEFAULT_VIDEO_LABELS', () => {
  assert.equal(engine.renderVideoHtml, renderVideoHtml);
  assert.equal(engine.DEFAULT_VIDEO_LABELS, DEFAULT_VIDEO_LABELS);
});

test('DEFAULT_VIDEO_LABELS is frozen and holds the English strings', () => {
  assert.ok(Object.isFrozen(DEFAULT_VIDEO_LABELS));
  assert.deepEqual(
    { ...DEFAULT_VIDEO_LABELS },
    {
      play: 'Play: {title}',
      watchOn: 'Watch on {provider}',
      untitled: 'Video',
      chapters: 'Chapters',
      download: 'Download the video',
    },
  );
});

test('the UI strings of the videos exist in English and Russian', () => {
  const en = loadStrings('en').strings;
  const ru = loadStrings('ru').strings;
  assert.equal(en.get('video.play'), 'Play: {title}');
  assert.equal(en.get('video.watch_on'), 'Watch on {provider}');
  assert.equal(en.get('video.untitled'), 'Video');
  assert.equal(en.get('video.chapters'), 'Chapters');
  assert.equal(en.get('video.download'), 'Download the video');
  assert.equal(ru.get('video.play'), 'Смотреть: {title}');
  assert.equal(ru.get('video.watch_on'), 'Смотреть на {provider}');
  assert.equal(ru.get('video.untitled'), 'Видео');
  assert.equal(ru.get('video.chapters'), 'Главы');
  assert.equal(ru.get('video.download'), 'Скачать видео');
});

test('the English strings and DEFAULT_VIDEO_LABELS agree', () => {
  const en = loadStrings('en').strings;
  assert.equal(en.get('video.play'), DEFAULT_VIDEO_LABELS.play);
  assert.equal(en.get('video.watch_on'), DEFAULT_VIDEO_LABELS.watchOn);
  assert.equal(en.get('video.untitled'), DEFAULT_VIDEO_LABELS.untitled);
  assert.equal(en.get('video.chapters'), DEFAULT_VIDEO_LABELS.chapters);
  assert.equal(en.get('video.download'), DEFAULT_VIDEO_LABELS.download);
});

test('vector 15.7 A: a remote video in click mode with a preview and chapters', () => {
  assert.equal(
    render(DRAWER, DRAWER_INPUT),
    join([
      '<figure class="video" id="video-drawer" data-video="youtube" data-video-load="click" data-video-play="https://www.youtube-nocookie.com/embed/aBcD3fGh1_-?start=12&amp;autoplay=1" data-video-title="Fitting the drawer">',
      '<a class="video-preview" href="https://www.youtube.com/watch?v=aBcD3fGh1_-&amp;t=12s"><img src="/img/k1/youtube-preview-480.webp" srcset="/img/k1/youtube-preview-480.webp 480w" sizes="(min-width: 44rem) 41rem, calc(100vw - 2rem)" width="480" height="360" alt="" loading="lazy" decoding="async"><span class="video-play">Play: Fitting the drawer</span></a>',
      '<figcaption><span class="video-title">Fitting the drawer</span> <a class="video-source" href="https://www.youtube.com/watch?v=aBcD3fGh1_-&amp;t=12s">Watch on YouTube</a></figcaption>',
      '<ol class="video-chapters" aria-label="Chapters"><li><a href="https://www.youtube.com/watch?v=aBcD3fGh1_-&amp;t=12s" data-video-seek="12" data-video-target="video-drawer" data-video-play="https://www.youtube-nocookie.com/embed/aBcD3fGh1_-?start=12&amp;autoplay=1"><time datetime="PT12S">0:12</time></a> Marking out</li><li><a href="https://www.youtube.com/watch?v=aBcD3fGh1_-&amp;t=65s" data-video-seek="65" data-video-target="video-drawer" data-video-play="https://www.youtube-nocookie.com/embed/aBcD3fGh1_-?start=65&amp;autoplay=1"><time datetime="PT1M5S">1:05</time></a> Sawing the <em>tails</em></li></ol>',
      '</figure>',
    ]),
  );
});

test('vector 15.7 B: the same video in a feed has no data attributes', () => {
  assert.equal(
    render(DRAWER, { ...DRAWER_INPUT, feed: true }),
    join([
      '<figure class="video" id="video-drawer">',
      '<a class="video-preview" href="https://www.youtube.com/watch?v=aBcD3fGh1_-&amp;t=12s"><img src="/img/k1/youtube-preview-480.webp" srcset="/img/k1/youtube-preview-480.webp 480w" sizes="(min-width: 44rem) 41rem, calc(100vw - 2rem)" width="480" height="360" alt="" loading="lazy" decoding="async"><span class="video-play">Play: Fitting the drawer</span></a>',
      '<figcaption><span class="video-title">Fitting the drawer</span> <a class="video-source" href="https://www.youtube.com/watch?v=aBcD3fGh1_-&amp;t=12s">Watch on YouTube</a></figcaption>',
      '<ol class="video-chapters" aria-label="Chapters"><li><a href="https://www.youtube.com/watch?v=aBcD3fGh1_-&amp;t=12s"><time datetime="PT12S">0:12</time></a> Marking out</li><li><a href="https://www.youtube.com/watch?v=aBcD3fGh1_-&amp;t=65s"><time datetime="PT1M5S">1:05</time></a> Sawing the <em>tails</em></li></ol>',
      '</figure>',
    ]),
  );
});

const VIMEO_LINES = [
  '<figure class="video" id="video-1" data-video="vimeo" data-video-load="iframe" data-video-title="Planing end grain">',
  '<div class="video-frame"><iframe src="https://player.vimeo.com/video/76979871?dnt=1" title="Planing end grain" loading="lazy" allow="autoplay; encrypted-media; fullscreen; picture-in-picture" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe></div>',
  '<figcaption><span class="video-title">Planing end grain</span> <a class="video-source" href="https://vimeo.com/76979871">Watch on Vimeo</a></figcaption>',
  '</figure>',
];

test('vector 15.7 C: a remote video in iframe mode without a preview', () => {
  assert.equal(render(VIMEO, { title: 'Planing end grain', titleShown: true }), join(VIMEO_LINES));
});

test('vector 15.7 D: an auto-embedded video without a title or preview', () => {
  assert.equal(
    render(VK),
    join([
      '<figure class="video" id="video-1" data-video="vkvideo" data-video-load="click" data-video-play="https://vkvideo.ru/video_ext.php?oid=-12345&amp;id=456239017&amp;autoplay=1" data-video-title="Video">',
      '<a class="video-preview" href="https://vkvideo.ru/video-12345_456239017"><span class="video-placeholder"></span><span class="video-play">Play: Video</span></a>',
      '<figcaption><a class="video-source" href="https://vkvideo.ru/video-12345_456239017">Watch on VK Video</a></figcaption>',
      '</figure>',
    ]),
  );
});

test('vector 15.7 E: a local video with a start and a poster', () => {
  assert.equal(
    render(GLUE, GLUE_INPUT),
    join([
      '<figure class="video" id="video-1" data-video="file">',
      '<video controls preload="metadata" poster="/img/k2/glue-800.webp"><source src="/journal/walnut-box/glue-up.mp4#t=5" type="video/mp4"><a href="/journal/walnut-box/glue-up.mp4">Download the video</a></video>',
      '<figcaption><span class="video-title">Glue-up, sped up</span></figcaption>',
      '</figure>',
    ]),
  );
});

test('vector 15.7 F: chapters of a provider that cannot seek have no links', () => {
  assert.equal(
    render(VK_CHAPTERS),
    join([
      '<figure class="video" id="video-1" data-video="vkvideo" data-video-load="click" data-video-play="https://vkvideo.ru/video_ext.php?oid=-12345&amp;id=456239017&amp;autoplay=1" data-video-title="Video">',
      '<a class="video-preview" href="https://vkvideo.ru/video-12345_456239017"><span class="video-placeholder"></span><span class="video-play">Play: Video</span></a>',
      '<figcaption><a class="video-source" href="https://vkvideo.ru/video-12345_456239017">Watch on VK Video</a></figcaption>',
      '<ol class="video-chapters" aria-label="Chapters"><li><time datetime="PT0S">0:00</time> Intro</li><li><time datetime="PT1M">1:00</time> Cut</li></ol>',
      '</figure>',
    ]),
  );
});

test('vector 15.7 G: the title is escaped', () => {
  const html = render(VIMEO, { title: 'Tom & "Jerry" <b>', titleShown: true });
  assert.equal(
    html.split('\n')[0],
    '<figure class="video" id="video-1" data-video="vimeo" data-video-load="iframe" data-video-title="Tom &amp; &quot;Jerry&quot; &lt;b&gt;">',
  );
  assert.ok(html.includes('title="Tom &amp; &quot;Jerry&quot; &lt;b&gt;"'));
  assert.ok(html.includes('<span class="video-title">Tom &amp; &quot;Jerry&quot; &lt;b&gt;</span>'));
});

test('an iframe-mode video is written in click mode in a feed', () => {
  assert.equal(
    render(VIMEO, { title: 'Planing end grain', titleShown: true, feed: true }),
    join([
      '<figure class="video" id="video-1">',
      '<a class="video-preview" href="https://vimeo.com/76979871"><span class="video-placeholder"></span><span class="video-play">Play: Planing end grain</span></a>',
      '<figcaption><span class="video-title">Planing end grain</span> <a class="video-source" href="https://vimeo.com/76979871">Watch on Vimeo</a></figcaption>',
      '</figure>',
    ]),
  );
});

test('an iframe-mode video writes its chapters after the caption', () => {
  const video = remote('https://vimeo.com/76979871', {
    load: 'iframe',
    chapters: [{ seconds: 65, html: 'Plane', text: 'Plane' }],
  });
  assert.equal(
    render(video, { title: 'Planing end grain', titleShown: true }),
    join([
      ...VIMEO_LINES.slice(0, 3),
      '<ol class="video-chapters" aria-label="Chapters"><li><a href="https://vimeo.com/76979871#t=65s" data-video-seek="65" data-video-target="video-1" data-video-play="https://player.vimeo.com/video/76979871?dnt=1&amp;autoplay=1#t=65s"><time datetime="PT1M5S">1:05</time></a> Plane</li></ol>',
      '</figure>',
    ]),
  );
});

test('a remote chapter link keeps the end of the video', () => {
  const video = remote('https://youtu.be/aBcD3fGh1_-', {
    end: 95,
    chapters: [{ seconds: 30, html: 'Glue', text: 'Glue' }],
  });
  const html = render(video);
  assert.ok(
    html.includes(
      '<li><a href="https://www.youtube.com/watch?v=aBcD3fGh1_-&amp;t=30s" data-video-seek="30" data-video-target="video-1" data-video-play="https://www.youtube-nocookie.com/embed/aBcD3fGh1_-?start=30&amp;end=95&amp;autoplay=1"><time datetime="PT30S">0:30</time></a> Glue</li>',
    ),
  );
});

test('the srcset lists every variant, narrowest first', () => {
  const html = render(remote('https://youtu.be/aBcD3fGh1_-'), {
    preview: {
      src: '/img/k1/a&b-800.webp',
      width: 800,
      height: 450,
      srcset: [
        { url: '/img/k1/a&b-480.webp', width: 480 },
        { url: '/img/k1/a&b-800.webp', width: 800 },
      ],
    },
    sizes: '100vw',
  });
  assert.ok(
    html.includes(
      '<img src="/img/k1/a&amp;b-800.webp" srcset="/img/k1/a&amp;b-480.webp 480w, /img/k1/a&amp;b-800.webp 800w" sizes="100vw" width="800" height="450" alt="" loading="lazy" decoding="async">',
    ),
  );
});

test('a local video without a title, poster or time', () => {
  assert.equal(
    render(local()),
    join([
      '<figure class="video" id="video-1" data-video="file">',
      '<video controls preload="metadata"><source src="/journal/walnut-box/glue-up.mp4" type="video/mp4"><a href="/journal/walnut-box/glue-up.mp4">Download the video</a></video>',
      '</figure>',
    ]),
  );
});

test('the fragment of a local video carries its start and end', () => {
  /** @param {Partial<VideoDirective>} fields */
  const source = (fields) => {
    const html = render(local({ file: { url: '/a/clip.webm', type: 'video/webm' }, ...fields }));
    return /<source [^>]*>/.exec(html)?.[0];
  };
  assert.equal(source({ start: 5, end: 30 }), '<source src="/a/clip.webm#t=5,30" type="video/webm">');
  assert.equal(source({ start: 5 }), '<source src="/a/clip.webm#t=5" type="video/webm">');
  assert.equal(source({ end: 30 }), '<source src="/a/clip.webm#t=0,30" type="video/webm">');
  assert.equal(source({}), '<source src="/a/clip.webm" type="video/webm">');
});

test('the chapters of a local video link to the file at the time', () => {
  const video = local({
    htmlId: 'video-glue',
    chapters: [
      { seconds: 5, html: 'Clamps', text: 'Clamps' },
      { seconds: 70, html: 'Wipe <code>glue</code>', text: 'Wipe glue' },
    ],
  });
  const lines = render(video, GLUE_INPUT).split('\n');
  assert.equal(lines.length, 5);
  assert.equal(
    lines[3],
    '<ol class="video-chapters" aria-label="Chapters"><li><a href="/journal/walnut-box/glue-up.mp4#t=5" data-video-seek="5" data-video-target="video-glue"><time datetime="PT5S">0:05</time></a> Clamps</li><li><a href="/journal/walnut-box/glue-up.mp4#t=70" data-video-seek="70" data-video-target="video-glue"><time datetime="PT1M10S">1:10</time></a> Wipe <code>glue</code></li></ol>',
  );
});

test('a local video in a feed has no data attributes', () => {
  const video = local({ chapters: [{ seconds: 5, html: 'Clamps', text: 'Clamps' }] });
  assert.equal(
    render(video, { ...GLUE_INPUT, feed: true }),
    join([
      '<figure class="video" id="video-1">',
      '<video controls preload="metadata" poster="/img/k2/glue-800.webp"><source src="/journal/walnut-box/glue-up.mp4" type="video/mp4"><a href="/journal/walnut-box/glue-up.mp4">Download the video</a></video>',
      '<figcaption><span class="video-title">Glue-up, sped up</span></figcaption>',
      '<ol class="video-chapters" aria-label="Chapters"><li><a href="/journal/walnut-box/glue-up.mp4#t=5"><time datetime="PT5S">0:05</time></a> Clamps</li></ol>',
      '</figure>',
    ]),
  );
});

test('a feed removes data attributes from chapter HTML but not from texts that look like them', () => {
  const video = remote('https://youtu.be/aBcD3fGh1_-', {
    chapters: [
      {
        seconds: 30,
        html: 'See <a class="video-seek" href="https://example.org/" data-video-seek="40">this</a> data-x="y"',
        text: 'See this data-x="y"',
      },
    ],
  });
  const html = render(video, { title: 'a data-video="b"', titleShown: true, feed: true });
  assert.ok(html.includes('See <a class="video-seek" href="https://example.org/">this</a> data-x="y"</li>'));
  assert.ok(html.includes('<span class="video-title">a data-video=&quot;b&quot;</span>'));
  assert.ok(!/<[^>]* data-/.test(html.replace(/="[^"]*"/g, '=""')));
});

test('labels have their placeholder replaced before they are escaped', () => {
  /** @type {import('../src/video/html.js').VideoLabels} */
  const labels = {
    play: '{title} <play> $& {title}',
    watchOn: 'On {provider} & more',
    untitled: 'Untitled',
    chapters: 'Parts & "bits"',
    download: 'Get <it>',
  };
  const video = remote('https://youtu.be/aBcD3fGh1_-', {
    chapters: [{ seconds: 30, html: 'Glue', text: 'Glue' }],
  });
  const html = render(video, { title: 'A&B {provider}', titleShown: true, labels });
  assert.ok(
    html.includes(
      '<span class="video-play">A&amp;B {provider} &lt;play&gt; $&amp; A&amp;B {provider}</span>',
    ),
  );
  assert.ok(html.includes('>On YouTube &amp; more</a></figcaption>'));
  assert.ok(html.includes('<ol class="video-chapters" aria-label="Parts &amp; &quot;bits&quot;">'));
  assert.ok(
    render(local(), { labels }).includes('<a href="/journal/walnut-box/glue-up.mp4">Get &lt;it&gt;</a>'),
  );
});

test('the output has no indentation, no empty line and no final newline', () => {
  for (const html of [
    render(DRAWER, DRAWER_INPUT),
    render(VK),
    render(local()),
    render(VIMEO, { feed: true }),
  ]) {
    assert.ok(html.endsWith('</figure>'));
    assert.ok(!html.includes('\n\n'));
    assert.ok(!/\n\s/.test(html));
    assert.ok(!html.includes('\r'));
  }
});
