import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../theme/assets/video.js', import.meta.url), 'utf8');
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const ALLOW = 'autoplay; encrypted-media; fullscreen; picture-in-picture';

/**
 * Whether `element` matches a simple selector such as `a.video-preview`,
 * `figure.video`, `iframe` or `[data-video-seek]`.
 *
 * @param {FakeElement} element
 * @param {string} selector
 */
function matches(element, selector) {
  const parsed = /^([a-z]*)((?:\.[\w-]+)*)((?:\[[\w-]+\])*)$/.exec(selector);
  assert.ok(parsed, `the script uses only simple selectors: ${selector}`);
  const [, tag = '', classes = '', attributes = ''] = parsed;
  if (tag && element.tagName !== tag) return false;
  const own = element.className.split(/\s+/);
  for (const name of classes.split('.').filter(Boolean)) if (!own.includes(name)) return false;
  for (const name of attributes.slice(1, -1).split('][').filter(Boolean)) if (!element.attributes.has(name)) return false;
  return true;
}

class FakeElement {
  /** @param {string} tagName @param {Record<string, string>} [attributes] */
  constructor(tagName, attributes = {}) {
    this.tagName = tagName;
    this.className = attributes.class ?? '';
    /** @type {Map<string, string>} */
    this.attributes = new Map(Object.entries(attributes).filter(([name]) => name !== 'class'));
    /** @type {FakeElement[]} */
    this.children = [];
    /** @type {FakeElement | null} */
    this.parentNode = null;
    this.focused = false;
    /** @type {unknown[]} */
    this.scrolls = [];
    this.currentTime = 0;
    this.plays = 0;
  }

  get firstChild() {
    return this.children[0] ?? null;
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
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  /** @param {FakeElement} child @param {FakeElement | null} before */
  insertBefore(child, before) {
    child.parentNode = this;
    const at = before ? this.children.indexOf(before) : -1;
    if (at < 0) this.children.push(child);
    else this.children.splice(at, 0, child);
    return child;
  }

  /** @param {FakeElement} child @param {FakeElement} old */
  replaceChild(child, old) {
    const at = this.children.indexOf(old);
    assert.ok(at >= 0, 'the replaced element is a child');
    this.children[at] = child;
    child.parentNode = this;
    old.parentNode = null;
    return old;
  }

  /** @param {string} selector @returns {FakeElement | null} */
  closest(selector) {
    /** @type {FakeElement | null} */
    let at = this;
    while (at && !matches(at, selector)) at = at.parentNode;
    return at;
  }

  /** @param {string} selector @returns {FakeElement | null} */
  querySelector(selector) {
    for (const child of this.children) {
      if (matches(child, selector)) return child;
      const found = child.querySelector(selector);
      if (found) return found;
    }
    return null;
  }

  focus() {
    this.focused = true;
  }

  /** @param {unknown} options */
  scrollIntoView(options) {
    this.scrolls.push(options);
  }

  play() {
    this.plays++;
    return Promise.reject(new Error('NotAllowedError'));
  }
}

/**
 * @param {string} tag
 * @param {Record<string, string>} attributes
 * @param {FakeElement[]} [children]
 */
function el(tag, attributes, children = []) {
  const element = new FakeElement(tag, attributes);
  for (const child of children) element.appendChild(child);
  return element;
}

const PLAY = 'https://www.youtube-nocookie.com/embed/aBcD3fGh1_-?start=12&autoplay=1';
const PLAY_65 = 'https://www.youtube-nocookie.com/embed/aBcD3fGh1_-?start=65&autoplay=1';

/** A page with the figures of vectors A, C and E of section 15.7, a seek link to each and a figure as a feed has it. */
function page() {
  const preview = el('a', { class: 'video-preview', href: 'https://www.youtube.com/watch?v=aBcD3fGh1_-&t=12s' }, [
    el('img', {}),
    el('span', { class: 'video-play' }),
  ]);
  const chapter = el('a', {
    href: 'https://www.youtube.com/watch?v=aBcD3fGh1_-&t=65s',
    'data-video-seek': '65',
    'data-video-target': 'video-drawer',
    'data-video-play': PLAY_65,
  }, [el('time', {})]);
  const click = el('figure', {
    class: 'video',
    id: 'video-drawer',
    'data-video': 'youtube',
    'data-video-load': 'click',
    'data-video-play': PLAY,
    'data-video-title': 'Fitting the drawer',
  }, [preview, el('figcaption', {}), el('ol', { class: 'video-chapters' }, [el('li', {}, [chapter])])]);

  const existing = el('iframe', { src: 'https://player.vimeo.com/video/76979871?dnt=1' });
  const iframe = el('figure', {
    class: 'video',
    id: 'video-vimeo',
    'data-video': 'vimeo',
    'data-video-load': 'iframe',
    'data-video-title': 'Planing end grain',
  }, [el('div', { class: 'video-frame' }, [existing]), el('figcaption', {})]);

  const video = el('video', {});
  const file = el('figure', { class: 'video', id: 'video-glue', 'data-video': 'file' }, [video]);

  const feedPreview = el('a', { class: 'video-preview', href: 'https://vimeo.com/1' }, [el('span', { class: 'video-play' })]);
  const feed = el('figure', { class: 'video', id: 'video-feed' }, [feedPreview]);

  /** @param {string} target @param {string} seconds @param {string | null} play */
  const seekLink = (target, seconds, play) =>
    el('a', {
      class: 'video-seek',
      href: '#',
      'data-video-seek': seconds,
      'data-video-target': target,
      ...(play ? { 'data-video-play': play } : {}),
    }, [el('time', {})]);
  const seekVimeo = seekLink('video-vimeo', '160', 'https://player.vimeo.com/video/76979871?dnt=1&autoplay=1#t=160s');
  const seekFile = seekLink('video-glue', '7', null);
  const seekMissing = seekLink('video-gone', '7', 'https://example.org/');
  const paragraph = el('p', {}, [seekVimeo, seekFile, seekMissing]);

  const body = el('main', {}, [click, iframe, file, feed, paragraph]);

  /** @type {((event: any) => void)[]} */
  const listeners = [];
  const document = {
    createElement: (/** @type {string} */ tag) => new FakeElement(tag),
    getElementById: (/** @type {string} */ id) => {
      /** @param {FakeElement} at @returns {FakeElement | null} */
      const find = (at) => {
        if (at.getAttribute('id') === id) return at;
        for (const child of at.children) {
          const found = find(child);
          if (found) return found;
        }
        return null;
      };
      return find(body);
    },
    addEventListener: (/** @type {string} */ type, /** @type {(event: any) => void} */ listener) => {
      assert.equal(type, 'click');
      listeners.push(listener);
    },
  };
  vm.runInNewContext(source, { document });

  /**
   * A click as the browser delivers it, for the mouse and for Enter on a link.
   *
   * @param {FakeElement} target
   * @param {Record<string, unknown>} [extra]
   */
  const dispatch = (target, extra = {}) => {
    const event = {
      type: 'click',
      target,
      button: 0,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      ...extra,
    };
    for (const listener of listeners) listener(event);
    return event;
  };

  return { click, preview, chapter, iframe, existing, file, video, feed, feedPreview, seekVimeo, seekFile, seekMissing, dispatch };
}

/** @param {FakeElement} iframe */
function iframeAttributes(iframe) {
  return Object.fromEntries(iframe.attributes);
}

test('the script uses no module syntax, no library, no timer and no address of another host', () => {
  assert.doesNotMatch(code, /\bimport\b|\bexport\b|\brequire\s*\(/);
  assert.doesNotMatch(code, /https?:|\/\/[a-z]/i, 'no address');
  assert.doesNotMatch(code, /createElement\(\s*['"]script/, 'loads no script');
  assert.doesNotMatch(code, /\b(jQuery|\$\(|fetch\s*\(|XMLHttpRequest)/);
  assert.doesNotMatch(code, /setInterval|setTimeout|requestAnimationFrame|animate|transition/);
  assert.doesNotMatch(code, /behavior:\s*'smooth'/);
  assert.match(source, /^\/\*[\s\S]*?\*\/\n\(function \(\) \{\n  'use strict';/, 'a strict function that leaks no global');
});

test('a click on the preview puts the player in its place and moves the focus to it', () => {
  const run = page();
  const event = run.dispatch(/** @type {FakeElement} */ (run.preview.children[1]));
  assert.equal(event.defaultPrevented, true);
  assert.equal(run.preview.parentNode, null, 'the preview is gone');

  const box = run.click.children[0];
  assert.equal(box?.tagName, 'div');
  assert.equal(box?.className, 'video-frame');
  assert.equal(box?.children.length, 1);
  const player = /** @type {FakeElement} */ (box?.children[0]);
  assert.equal(player.tagName, 'iframe');
  assert.deepEqual(iframeAttributes(player), {
    src: PLAY,
    title: 'Fitting the drawer',
    allow: ALLOW,
    allowfullscreen: '',
    referrerpolicy: 'strict-origin-when-cross-origin',
  });
  assert.deepEqual([...player.attributes.keys()], ['src', 'title', 'allow', 'allowfullscreen', 'referrerpolicy']);
  assert.equal(player.focused, true);
  assert.equal(run.click.children[1]?.tagName, 'figcaption', 'the rest of the figure stays');
});

test('Enter on the preview, which the browser delivers as a click with no pointer, plays too', () => {
  const run = page();
  assert.equal(run.dispatch(run.preview, { detail: 0 }).defaultPrevented, true);
  assert.equal(run.click.children[0]?.className, 'video-frame');
});

test('a click with another button or a modifier key keeps its usual meaning', () => {
  for (const extra of [{ button: 1 }, { button: 2 }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }]) {
    const run = page();
    assert.equal(run.dispatch(run.preview, extra).defaultPrevented, false, JSON.stringify(extra));
    assert.equal(run.dispatch(run.chapter, extra).defaultPrevented, false, JSON.stringify(extra));
    assert.equal(run.preview.parentNode, run.click, 'the preview stays');
  }
});

test('a click another handler already took is left alone', () => {
  const run = page();
  run.dispatch(run.preview, { defaultPrevented: true });
  assert.equal(run.preview.parentNode, run.click);
});

test('a preview without a player address, as in a feed, stays a link', () => {
  const run = page();
  assert.equal(run.dispatch(run.feedPreview).defaultPrevented, false);
  assert.equal(run.feedPreview.parentNode, run.feed);
});

test('a chapter of a video not yet loaded puts the player at its time in place of the preview', () => {
  const run = page();
  const event = run.dispatch(/** @type {FakeElement} */ (run.chapter.children[0]));
  assert.equal(event.defaultPrevented, true);
  assert.equal(run.preview.parentNode, null);
  const player = /** @type {FakeElement} */ (run.click.children[0]?.children[0]);
  assert.equal(player.getAttribute('src'), PLAY_65);
  assert.equal(player.getAttribute('title'), 'Fitting the drawer');
  assert.equal(player.getAttribute('allow'), ALLOW);
  assert.deepEqual(JSON.parse(JSON.stringify(run.click.scrolls)), [{ block: 'nearest', behavior: 'instant' }]);
});

test('seeking again reuses the player and only changes its address', () => {
  const run = page();
  run.dispatch(run.preview);
  const player = /** @type {FakeElement} */ (run.click.children[0]?.children[0]);
  run.dispatch(run.chapter);
  assert.equal(run.click.children[0]?.children[0], player, 'the same iframe');
  assert.equal(run.click.children.filter((child) => child.className === 'video-frame').length, 1);
  assert.equal(player.getAttribute('src'), PLAY_65);
});

test('a seek link to a video in iframe mode points its player at the time', () => {
  const run = page();
  const event = run.dispatch(run.seekVimeo);
  assert.equal(event.defaultPrevented, true);
  assert.equal(run.existing.getAttribute('src'), 'https://player.vimeo.com/video/76979871?dnt=1&autoplay=1#t=160s');
  assert.equal(run.iframe.children.length, 2, 'no second player');
  assert.deepEqual(JSON.parse(JSON.stringify(run.iframe.scrolls)), [{ block: 'nearest', behavior: 'instant' }]);
});

test('a seek link to a local video sets its time and plays it', async () => {
  const run = page();
  const event = run.dispatch(run.seekFile);
  assert.equal(event.defaultPrevented, true);
  assert.equal(run.video.currentTime, 7);
  assert.equal(run.video.plays, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(run.file.scrolls)), [{ block: 'nearest', behavior: 'instant' }]);
  // A refused play() is caught, so it is not reported as an unhandled rejection.
  await new Promise((resolve) => setImmediate(resolve));
});

test('a seek link whose video is not on the page stays a link', () => {
  const run = page();
  assert.equal(run.dispatch(run.seekMissing).defaultPrevented, false);
});

test('clicks elsewhere are ignored', () => {
  const run = page();
  assert.equal(run.dispatch(el('a', { href: '/elsewhere' })).defaultPrevented, false);
  assert.equal(run.dispatch(/** @type {any} */ ({})).defaultPrevented, false, 'a target that is not an element');
});
