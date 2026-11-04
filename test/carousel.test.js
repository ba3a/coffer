import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { buildSites } from '../src/build.js';
import { loadConfig } from '../src/config.js';
import { MarkdownError, renderMarkdown } from '../src/markdown/render.js';

const exampleDir = fileURLToPath(new URL('../example/', import.meta.url));
const themeAssets = fileURLToPath(new URL('../theme/assets/', import.meta.url));
const NOW = new Date('2026-06-01T12:00:00Z');

/**
 * A stand-in for the image resolver: every local image is 1600 by 1200 with two variants.
 *
 * @returns {import('../src/markdown/render.js').ImageOptions & { asked: string[] }}
 */
function images() {
  /** @type {string[]} */
  const asked = [];
  return {
    asked,
    sizes: 'text-sizes',
    carouselSizes: 'carousel-sizes',
    resolve: async ({ src }) => {
      asked.push(src);
      if (/^https?:/.test(src)) return null;
      return {
        src: `/img/${src}-1200.webp`,
        width: 1200,
        height: 900,
        srcset: [
          { url: `/img/${src}-480.webp`, width: 480 },
          { url: `/img/${src}-1200.webp`, width: 1200 },
        ],
      };
    },
  };
}

/**
 * @param {string} tag
 * @param {string} name
 * @returns {string | null}
 */
function attribute(tag, name) {
  return new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? null;
}

/**
 * @param {string} source CSS or JavaScript.
 * @returns {string} The source without block comments.
 */
function withoutComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** @param {string} html */
function imgTags(html) {
  return [...html.matchAll(/<img\b[^>]*>/g)].map((match) => match[0]);
}

const BODY = [
  ':::carousel[Trip photos]',
  '![First view](a.jpg "Morning")',
  '',
  '![Second view](b.jpg)',
  '',
  '![Third view](c.jpg "Evening")',
  ':::',
].join('\n');

test('a carousel is a labelled region with a scrolling list of slides, each a figure with its caption', async () => {
  const options = images();
  const { html, carousels } = await renderMarkdown(BODY, { images: options });
  assert.equal(carousels, 1);
  assert.match(html, /^<section class="carousel" aria-label="Trip photos" data-carousel="" data-label-previous="Previous image" data-label-next="Next image">/);
  assert.match(html, /<ul class="carousel-track" tabindex="0">/, 'the list can be reached and scrolled with the keyboard');
  assert.equal(html.match(/<li class="carousel-slide">/g)?.length, 3);
  assert.equal(html.match(/<figure>/g)?.length, 3);
  assert.deepEqual(
    [...html.matchAll(/<figcaption>([^<]*)<\/figcaption>/g)].map((match) => match[1]),
    ['Morning', 'Evening'],
    'a slide without a title has no figcaption',
  );
  assert.deepEqual(
    imgTags(html).map((tag) => attribute(tag, 'alt')),
    ['First view', 'Second view', 'Third view'],
  );
  assert.ok(!/<button|<script|autoplay|aria-live/i.test(html), 'the markup holds no controls and no autoplay');
  assert.ok(!html.includes('<p>'), 'no stray paragraphs');
});

test('slides use the carousel sizes and are lazy except the first slide', async () => {
  const { html } = await renderMarkdown(`Text first.\n\n${BODY}`, { images: images() });
  const carousel = html.slice(html.indexOf('<section'));
  const sizes = [...carousel.matchAll(/<source [^>]*>/g)].map((tag) => attribute(tag[0], 'sizes'));
  assert.deepEqual(sizes, ['carousel-sizes', 'carousel-sizes', 'carousel-sizes']);
  const [first, second, third] = imgTags(carousel);
  assert.equal(attribute(first, 'loading'), null);
  assert.equal(attribute(second, 'loading'), 'lazy');
  assert.equal(attribute(second, 'decoding'), 'async');
  assert.equal(attribute(third, 'loading'), 'lazy');
  for (const tag of [first, second, third]) {
    assert.equal(attribute(tag, 'width'), '1200');
    assert.equal(attribute(tag, 'height'), '900');
  }
});

test('after another image, the first slide is lazy like every image but the first of the page', async () => {
  const { html } = await renderMarkdown(`![Before](pre.jpg)\n\n${BODY}`, { images: images() });
  const tags = imgTags(html);
  assert.equal(tags.length, 4);
  assert.equal(attribute(tags[0], 'loading'), null);
  assert.ok(html.slice(0, html.indexOf('<section')).includes('sizes="text-sizes"'), 'an image outside uses the text sizes');
  for (const tag of tags.slice(1)) assert.equal(attribute(tag, 'loading'), 'lazy', tag);
});

test('the sizes of carousels default to the sizes of the text', async () => {
  const options = images();
  delete options.carouselSizes;
  const { html } = await renderMarkdown(BODY, { images: options });
  assert.equal(html.match(/sizes="text-sizes"/g)?.length, 3);
});

test('a carousel without a name gets the default or the site label, and the buttons get their names from the site', async () => {
  const plain = await renderMarkdown(':::carousel\n![A](a.jpg)\n:::', { images: images() });
  assert.match(plain.html, /aria-label="Image carousel"/);
  const russian = await renderMarkdown(':::carousel\n![A](a.jpg)\n:::', {
    images: images(),
    carousel: { label: 'Галерея', previous: 'Назад', next: 'Вперёд' },
  });
  assert.match(russian.html, /aria-label="Галерея" data-carousel="" data-label-previous="Назад" data-label-next="Вперёд"/);
});

test('a carousel can be written as a list, and a line of images per paragraph is one slide per image', async () => {
  const list = await renderMarkdown(':::carousel\n- ![A](a.jpg "One")\n- ![B](b.jpg)\n:::', { images: images() });
  assert.equal(list.html.match(/<li class="carousel-slide">/g)?.length, 2);
  assert.ok(list.html.includes('<figcaption>One</figcaption>'));

  const lines = await renderMarkdown(':::carousel\n![A](a.jpg)\n![B](b.jpg)\n:::', { images: images() });
  assert.equal(lines.html.match(/<li class="carousel-slide">/g)?.length, 2);
  assert.equal(lines.html.match(/<figure>/g)?.length, 2);
});

test('carousel images join the images of the text in document order', async () => {
  const text = `![Top](top.jpg "T")\n\n${BODY}\n\n![Bottom](bottom.jpg)`;
  const { images: found, carousels } = await renderMarkdown(text, { images: images() });
  assert.equal(carousels, 1);
  assert.deepEqual(
    found.map((image) => [image.src, image.alt, image.caption, image.carousel]),
    [
      ['top.jpg', 'Top', 'T', false],
      ['a.jpg', 'First view', 'Morning', true],
      ['b.jpg', 'Second view', '', true],
      ['c.jpg', 'Third view', 'Evening', true],
      ['bottom.jpg', 'Bottom', '', false],
    ],
  );
  const plain = await renderMarkdown(text);
  assert.deepEqual(
    plain.images.map((image) => image.src),
    ['top.jpg', 'a.jpg', 'b.jpg', 'c.jpg', 'bottom.jpg'],
    'also without the image pipeline',
  );
  assert.equal((await renderMarkdown('No images.')).carousels, 0);
});

test('a carousel image is a link candidate like any other image', async () => {
  const { links } = await renderMarkdown(BODY, { file: 'post.md', startLine: 11 });
  assert.deepEqual(
    links.map((link) => [link.kind, link.url, link.line]),
    [
      ['image', 'a.jpg', 12],
      ['image', 'b.jpg', 14],
      ['image', 'c.jpg', 16],
    ],
  );
});

test('a carousel that holds anything but images is an error that names the file and the line', async () => {
  await assert.rejects(
    renderMarkdown('Intro.\n\n:::carousel\n![A](a.jpg)\n\nSome words.\n:::', { file: 'post.md', startLine: 5 }),
    (error) => {
      assert.ok(error instanceof MarkdownError);
      assert.match(error.message, /^post\.md:10:1: a carousel can only hold images/);
      return true;
    },
  );
  await assert.rejects(
    renderMarkdown(':::carousel\n![A](a.jpg) and words\n:::', { file: 'post.md' }),
    /^MarkdownError: post\.md:2:1: a carousel can only hold images/,
  );
  await assert.rejects(renderMarkdown(':::carousel\n- ![A](a.jpg)\n- text\n:::', { file: 'post.md' }), /post\.md:3:3: a carousel can only hold images/);
  await assert.rejects(renderMarkdown(':::carousel\n```\ncode\n```\n:::', { file: 'post.md' }), /post\.md:2:1: a carousel can only hold images/);
});

test('an empty carousel and a carousel with attributes are errors', async () => {
  await assert.rejects(renderMarkdown('x\n\n:::carousel\n:::', { file: 'post.md' }), /post\.md:3:1: a carousel needs at least one image/);
  await assert.rejects(renderMarkdown(':::carousel[Name]\n:::', { file: 'post.md' }), /a carousel needs at least one image/);
  await assert.rejects(
    renderMarkdown(':::carousel{.wide}\n![A](a.jpg)\n:::', { file: 'post.md' }),
    /post\.md:1:1: a carousel takes no attributes/,
  );
});

test('other directives are still errors', async () => {
  await assert.rejects(renderMarkdown(':::gallery\n![A](a.jpg)\n:::', { file: 'post.md' }), /post\.md:1:1: unknown directive "gallery"/);
});

test('the stylesheet makes the list scroll and snap sideways without a script, and moves nothing by itself', () => {
  const css = readFileSync(join(themeAssets, 'coffer.css'), 'utf8');
  /** @param {string} name */
  const rule = (name) => {
    const match = new RegExp(`\\.carousel ${name.replace('.', '\\.')}\\s*\\{([^}]*)\\}`).exec(css);
    assert.ok(match, `a rule for ${name}`);
    return match[1];
  };
  const track = rule('.carousel-track');
  assert.match(track, /display:\s*flex/);
  assert.match(track, /overflow-x:\s*auto/);
  assert.match(track, /scroll-snap-type:\s*x mandatory/);
  const slide = rule('.carousel-slide');
  assert.match(slide, /flex:\s*0 0 100%/);
  assert.match(slide, /scroll-snap-align:\s*start/);

  const carouselRules = [...withoutComments(css).matchAll(/[^{}]*carousel[^{}]*\{[^}]*\}/g)].map((match) => match[0]).join('\n');
  assert.ok(carouselRules.length > 0);
  assert.ok(!/animation|transition|(?<![-\w])scroll-behavior|@keyframes/.test(carouselRules), 'nothing animates');
});

// ---- The script, run against a very small stand-in for the page --------------------------

const SLIDE_WIDTH = 100;

class FakeElement {
  /** @param {string} tagName */
  constructor(tagName) {
    this.tagName = tagName;
    this.className = '';
    this.textContent = '';
    this.type = '';
    this.scrollLeft = 0;
    /** @type {FakeElement[]} */
    this.children = [];
    /** @type {Map<string, string>} */
    this.attributes = new Map();
    /** @type {Map<string, ((event: any) => void)[]>} */
    this.listeners = new Map();
    /** @type {{ left: number, behavior?: string }[]} */
    this.scrolls = [];
    /** @type {FakeElement | null} */
    this.parent = null;
    /** @type {number} */
    this.index = 0;
  }

  /** @param {string} name @param {string} value */
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  /** @param {string} name */
  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  /** @param {FakeElement} child */
  appendChild(child) {
    child.parent = this;
    child.index = this.children.length;
    this.children.push(child);
    return child;
  }

  /** @param {string} type @param {(event: any) => void} listener */
  addEventListener(type, listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  /**
   * @param {string} type
   * @param {Record<string, unknown>} [event]
   * @returns {{ defaultPrevented: boolean }}
   */
  dispatch(type, event = {}) {
    const full = { type, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...event };
    /** @type {FakeElement | null} */
    let target = this;
    while (target) {
      for (const listener of target.listeners.get(type) ?? []) listener(full);
      if (type === 'scroll') break; // scroll does not bubble
      target = target.parent;
    }
    return full;
  }

  click() {
    this.dispatch('click');
  }

  /** @param {string} cls @returns {FakeElement | null} */
  find(cls) {
    for (const child of this.children) {
      if (child.className.split(' ').includes(cls)) return child;
      const deeper = child.find(cls);
      if (deeper) return deeper;
    }
    return null;
  }

  /** @param {string} selector */
  querySelector(selector) {
    return this.find(selector.replace(/^\./, ''));
  }

  getBoundingClientRect() {
    const track = this.parent?.className.includes('carousel-track') ? this.parent : null;
    return { left: track ? this.index * SLIDE_WIDTH - track.scrollLeft : 0 };
  }

  /** @param {{ left: number, behavior?: string }} options */
  scrollTo(options) {
    this.scrolls.push(options);
    this.scrollLeft = options.left;
    this.dispatch('scroll');
  }
}

/**
 * Builds a page with one carousel of `slides` slides, runs the script on it
 * and returns the parts a test looks at.
 *
 * @param {number} slides
 */
function carouselPage(slides) {
  const root = new FakeElement('section');
  root.setAttribute('data-carousel', '');
  root.setAttribute('data-label-previous', 'Back');
  root.setAttribute('data-label-next', 'Forward');
  const track = new FakeElement('ul');
  track.className = 'carousel-track';
  root.appendChild(track);
  for (let i = 0; i < slides; i++) {
    const slide = new FakeElement('li');
    slide.className = 'carousel-slide';
    track.appendChild(slide);
  }
  /** @type {(() => void)[]} */
  const ready = [];
  const document = {
    readyState: 'loading',
    createElement: (/** @type {string} */ tag) => new FakeElement(tag),
    querySelectorAll: () => [root],
    addEventListener: (/** @type {string} */ _type, /** @type {() => void} */ listener) => ready.push(listener),
  };
  const source = readFileSync(join(themeAssets, 'carousel.js'), 'utf8');
  vm.runInNewContext(source, { document });
  for (const listener of ready) listener();
  return {
    root,
    track,
    document,
    previous: /** @type {FakeElement} */ (root.find('carousel-previous')),
    next: /** @type {FakeElement} */ (root.find('carousel-next')),
    position: /** @type {FakeElement} */ (root.find('carousel-position')),
  };
}

test('with the script, buttons and a position indicator appear', () => {
  const page = carouselPage(7);
  assert.equal(page.position.textContent, '1 / 7');
  assert.equal(page.previous.tagName, 'button');
  assert.equal(page.previous.type, 'button');
  assert.equal(page.previous.getAttribute('aria-label'), 'Back');
  assert.equal(page.next.getAttribute('aria-label'), 'Forward');
  assert.equal(page.previous.getAttribute('aria-disabled'), 'true', 'there is nothing before the first slide');
  assert.equal(page.next.getAttribute('aria-disabled'), 'false');
  assert.equal(page.position.getAttribute('aria-live'), 'polite');
  assert.equal(page.root.getAttribute('data-carousel-ready'), 'true');
});

test('the next and previous buttons move one slide at a time, at once and not past the ends', () => {
  const page = carouselPage(3);
  page.next.click();
  assert.deepEqual(JSON.parse(JSON.stringify(page.track.scrolls)), [{ left: SLIDE_WIDTH, behavior: 'instant' }]);
  assert.equal(page.position.textContent, '2 / 3');
  page.next.click();
  assert.equal(page.position.textContent, '3 / 3');
  assert.equal(page.next.getAttribute('aria-disabled'), 'true');
  page.next.click();
  assert.equal(page.position.textContent, '3 / 3', 'the last slide stays');
  assert.equal(page.track.scrollLeft, 2 * SLIDE_WIDTH);
  page.previous.click();
  assert.equal(page.position.textContent, '2 / 3');
  assert.equal(page.track.scrollLeft, SLIDE_WIDTH);
  page.previous.click();
  page.previous.click();
  assert.equal(page.position.textContent, '1 / 3');
  assert.equal(page.track.scrollLeft, 0);
  assert.equal(page.previous.getAttribute('aria-disabled'), 'true');
  assert.ok(page.track.scrolls.every((scroll) => scroll.behavior === 'instant'), 'no smooth scrolling');
});

test('the arrow keys, Home and End move between slides while the focus is in the carousel', () => {
  const page = carouselPage(4);
  const press = (/** @type {string} */ key, /** @type {Record<string, unknown>} */ extra = {}) =>
    page.track.dispatch('keydown', { key, ...extra });
  assert.equal(press('ArrowRight').defaultPrevented, true);
  assert.equal(page.position.textContent, '2 / 4');
  press('ArrowRight');
  assert.equal(page.position.textContent, '3 / 4');
  assert.equal(press('ArrowLeft').defaultPrevented, true);
  assert.equal(page.position.textContent, '2 / 4');
  press('End');
  assert.equal(page.position.textContent, '4 / 4');
  press('ArrowRight');
  assert.equal(page.position.textContent, '4 / 4');
  press('Home');
  assert.equal(page.position.textContent, '1 / 4');
  press('ArrowLeft');
  assert.equal(page.position.textContent, '1 / 4');

  const other = press('a');
  assert.equal(other.defaultPrevented, false, 'other keys are left alone');
  const shortcut = press('ArrowRight', { altKey: true });
  assert.equal(shortcut.defaultPrevented, false, 'browser shortcuts are left alone');
  assert.equal(page.position.textContent, '1 / 4');

  // The keys work from the buttons too.
  page.next.dispatch('keydown', { key: 'ArrowRight' });
  assert.equal(page.position.textContent, '2 / 4');
});

test('swiping or scrolling by hand updates the position and the buttons', () => {
  const page = carouselPage(5);
  page.track.scrollLeft = 3 * SLIDE_WIDTH + 10;
  page.track.dispatch('scroll');
  assert.equal(page.position.textContent, '4 / 5');
  page.next.click();
  assert.equal(page.position.textContent, '5 / 5');
  assert.equal(page.track.scrollLeft, 4 * SLIDE_WIDTH);
});

test('a carousel of one slide gets no controls, and the script starts nothing by itself', () => {
  const page = carouselPage(1);
  assert.equal(page.previous, null);
  assert.equal(page.next, null);
  assert.equal(page.position, null);

  const source = readFileSync(join(themeAssets, 'carousel.js'), 'utf8');
  const code = withoutComments(source);
  assert.ok(!/setInterval|setTimeout|requestAnimationFrame|animate|transition|autoplay/i.test(code), 'no timers and no animation');
  assert.ok(!/behavior:\s*'smooth'/.test(code));
});

// ---- The example site -----------------------------------------------------------------------

test('the example site has a post with carousels, and only that page loads the script', async () => {
  const root = mkdtempSync(join(tmpdir(), 'coffer-carousel-'));
  try {
    cpSync(exampleDir, root, {
      recursive: true,
      filter: (source) => !/[\\/](dist|\.cache|\.coffer)([\\/]|$)/.test(source),
    });
    const [result] = await buildSites(loadConfig({ configPath: join(root, 'coffer.yaml') }), {
      out: join(root, 'dist'),
      now: NOW,
    });
    const page = readFileSync(join(result.outDir, 'journal', 'photo-notes', 'index.html'), 'utf8');
    assert.equal(page.match(/<section class="carousel"/g)?.length, 2);
    assert.match(page, /<figcaption>The sixth attempt, unglued, on the bench\.<\/figcaption>/);
    assert.match(page, /<script src="\/assets\/carousel\.js" defer><\/script>/);
    assert.ok(existsSync(join(result.outDir, 'assets', 'carousel.js')), 'the script is published');
    assert.ok(!page.includes('autoplay'));

    const other = readFileSync(join(result.outDir, 'journal', 'mountain-weekend', 'index.html'), 'utf8');
    assert.ok(!other.includes('carousel'), 'a page without a carousel does not load the script');
    const home = readFileSync(join(result.outDir, 'index.html'), 'utf8');
    assert.ok(!home.includes('carousel.js'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
