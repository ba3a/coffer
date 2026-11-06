import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { buildSites } from '../src/build.js';
import { loadConfig } from '../src/config.js';
import { renderMarkdown } from '../src/markdown/render.js';
import { VIEWER_DATA_ID, VIEWER_SCRIPTS, VIEWER_STYLES, viewerJson } from '../src/viewer.js';
import { TINY_JPEG } from './helpers/images.js';

const exampleDir = fileURLToPath(new URL('../example/', import.meta.url));
const themeAssets = fileURLToPath(new URL('../theme/assets/', import.meta.url));
const NOW = new Date('2026-06-01T12:00:00Z');

// ---- The markup ------------------------------------------------------------------------------

/**
 * A stand-in for the image resolver: every local image has a full-size file
 * `/img/<name>-full.jpg` of 4000 by 3000 pixels, and the names that contain
 * "located" publish a position.
 *
 * @param {{ viewer?: boolean }} [options] Leave the full-size files out with `viewer: false`.
 * @returns {import('../src/markdown/render.js').ImageOptions}
 */
function images({ viewer = true } = {}) {
  return {
    sizes: 'text-sizes',
    resolve: async ({ src }) => {
      if (/^https?:/.test(src)) return null;
      return {
        src: `/img/${src}-1200.webp`,
        width: 1200,
        height: 900,
        srcset: [{ url: `/img/${src}-1200.webp`, width: 1200 }],
        ...(viewer
          ? {
              viewer: { src: `/img/${src}-full.jpg`, width: 4000, height: 3000 },
              location: src.includes('located') ? { latitude: 47.01, longitude: 11.05, precision: /** @type {const} */ ('coarse') } : null,
            }
          : {}),
      };
    },
  };
}

test('an image on its own links to its full-size file and is listed for the viewer', async () => {
  const result = await renderMarkdown('![A hill](hill.jpg "Day one")', { images: images() });
  assert.match(
    result.html,
    /^<figure><a href="\/img\/hill\.jpg-full\.jpg" class="viewer-link" data-viewer="0"><picture>.*<\/picture><\/a><figcaption>Day one<\/figcaption><\/figure>$/,
  );
  assert.deepEqual(result.viewerImages, [
    { src: '/img/hill.jpg-full.jpg', width: 4000, height: 3000, alt: 'A hill', caption: 'Day one' },
  ]);
});

test('an image inside a sentence links to its full-size file too', async () => {
  const result = await renderMarkdown('Look at ![a hill](hill.jpg) here.', { images: images() });
  assert.match(result.html, /^<p>Look at <a href="\/img\/hill\.jpg-full\.jpg" class="viewer-link" data-viewer="0"><picture>/);
  assert.equal(result.viewerImages.length, 1);
});

test('the viewer walks through the images of the post in document order, carousel slides included', async () => {
  const source = [
    '![One](one.jpg "First")',
    '',
    ':::carousel[Trip]',
    '![Two](two.jpg "Second")',
    '',
    '![Three](three.jpg)',
    ':::',
    '',
    'Some text with ![Four](four.jpg) inside.',
    '',
    '![Five](five.jpg)',
  ].join('\n');
  const result = await renderMarkdown(source, { images: images() });
  assert.deepEqual(
    result.viewerImages.map((image) => [image.alt, image.caption]),
    [['One', 'First'], ['Two', 'Second'], ['Three', ''], ['Four', ''], ['Five', '']],
  );
  const indexes = [...result.html.matchAll(/<a href="([^"]*)" class="viewer-link" data-viewer="(\d+)"/g)].map((match) => [Number(match[2]), match[1]]);
  assert.deepEqual(
    indexes,
    result.viewerImages.map((image, index) => [index, image.src]),
    'the link of the n-th image has data-viewer="n" and points at its file, in document order',
  );
  // The slides of the carousel are links as well.
  const carousel = /<section class="carousel".*?<\/section>/s.exec(result.html)?.[0] ?? '';
  assert.equal(carousel.match(/class="viewer-link"/g)?.length, 2);
});

test('coordinates are listed only for images that publish a position', async () => {
  const result = await renderMarkdown('![Here](located.jpg)\n\n![There](plain.jpg)', { images: images() });
  assert.deepEqual(result.viewerImages[0], {
    src: '/img/located.jpg-full.jpg',
    width: 4000,
    height: 3000,
    alt: 'Here',
    caption: '',
    latitude: 47.01,
    longitude: 11.05,
    precision: 'coarse',
  });
  assert.ok(!('latitude' in result.viewerImages[1]));
  assert.ok(!('precision' in result.viewerImages[1]));
});

test('an image that is already a link, or has no full-size file, is left alone', async () => {
  const linked = await renderMarkdown('[![Hill](hill.jpg)](https://example.com/)\n\n![Other](other.jpg)', { images: images() });
  assert.equal(linked.html.match(/<a /g)?.length, 2, 'the existing link is not wrapped in a second one');
  assert.match(linked.html, /<a href="https:\/\/example\.com\/"><picture>/);
  assert.deepEqual(
    linked.viewerImages.map((image) => image.alt),
    ['Other'],
    'only the image that is not a link is listed',
  );
  assert.match(linked.html, /data-viewer="0"/);

  const none = await renderMarkdown('![Hill](hill.jpg)', { images: images({ viewer: false }) });
  assert.ok(!none.html.includes('<a '));
  assert.deepEqual(none.viewerImages, []);

  const remote = await renderMarkdown('![Far](https://example.com/far.jpg)', { images: images() });
  assert.ok(!remote.html.includes('viewer-link'));
  assert.deepEqual(remote.viewerImages, []);

  const plain = await renderMarkdown('![Hill](hill.jpg)');
  assert.deepEqual(plain.viewerImages, []);
});

test('an image without alt text but with a caption gets the caption as the name of its link', async () => {
  const result = await renderMarkdown('![](hill.jpg "Day one")', { images: images() });
  assert.match(result.html, /<a [^>]*aria-label="Day one"/);
});

test('the JSON for the page cannot close its script element', () => {
  const json = viewerJson({
    labels: { close: 'Close', zoom: 'Zoom', previous: 'Previous', next: 'Next', error: 'Error', showOnMap: 'Map' },
    images: [
      { src: '/a.jpg', width: 1, height: 1, alt: '</script><script>alert(1)</script>', caption: `a${String.fromCharCode(0x2028)}b <!--` },
    ],
  });
  assert.ok(!json.includes('<'), json);
  assert.ok(!json.includes(String.fromCharCode(0x2028)));
  const back = JSON.parse(json);
  assert.equal(back.images[0].alt, '</script><script>alert(1)</script>');
  assert.equal(back.images[0].caption, `a${String.fromCharCode(0x2028)}b <!--`);
});

// ---- The pages of the example site -------------------------------------------------------------

/**
 * @param {string} root
 * @param {Record<string, string | Buffer>} [extra]
 */
function addFiles(root, extra = {}) {
  for (const [name, content] of Object.entries(extra)) {
    const target = join(root, ...name.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

/**
 * @param {(result: import('../src/build.js').SiteResult, root: string) => Promise<void> | void} body
 * @param {Record<string, string | Buffer>} [extra]
 */
async function withExampleBuild(body, extra = {}) {
  const root = mkdtempSync(join(tmpdir(), 'coffer-viewer-'));
  try {
    cpSync(exampleDir, root, {
      recursive: true,
      filter: (source) => !/[\\/](dist|\.cache|\.coffer)([\\/]|$)/.test(source),
    });
    addFiles(root, extra);
    const [result] = await buildSites(loadConfig({ configPath: join(root, 'coffer.yaml') }), { out: join(root, 'dist'), now: NOW });
    await body(result, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * @param {import('../src/build.js').SiteResult} result
 * @param {string} file Path of the page relative to the output directory.
 */
function page(result, file) {
  return readFileSync(join(result.outDir, ...file.split('/')), 'utf8');
}

/**
 * @param {string} html
 * @returns {{ labels: Record<string, string>, images: import('../src/markdown/render.js').ViewerImage[] }}
 */
function viewerData(html) {
  const match = new RegExp(`<script type="application/json" id="${VIEWER_DATA_ID}">(.*?)</script>`, 's').exec(html);
  assert.ok(match, 'the page lists its images for the viewer');
  return JSON.parse(match[1]);
}

test('every image of a page links to its high-resolution file, which is published, and the page lists them in order', async () => {
  await withExampleBuild((result) => {
    const html = page(result, 'journal/photo-notes/index.html');
    const data = viewerData(html);
    const links = [...html.matchAll(/<a href="([^"]*)" class="viewer-link" data-viewer="(\d+)"[^>]*>/g)];
    assert.equal(links.length, 5, 'three slides, then two slides');
    assert.equal(data.images.length, 5);
    for (const [position, link] of links.entries()) {
      assert.equal(Number(link[2]), position, 'document order');
      assert.equal(link[1], data.images[position].src);
      assert.ok(existsSync(join(result.outDir, ...link[1].slice(1).split('/'))), `${link[1]} is published`);
      assert.match(link[1], /-full\.jpg$/);
    }
    // The file behind the link is the viewer JPEG that the manifest lists, at its size.
    for (const image of data.images) {
      const listed = result.manifest.images.flatMap((entry) => entry.outputs).find((output) => output.url === image.src);
      assert.ok(listed, `${image.src} is in the manifest`);
      assert.equal(listed.role, 'viewer');
      assert.equal(listed.width, image.width);
      assert.equal(listed.height, image.height);
    }
    assert.equal(data.images[0].caption, 'The marking gauge, set to the thickness of the board.');
    assert.equal(data.images[0].alt, 'A marking gauge and a knife line scribed across a pale board.');
    assert.equal(data.labels.close, 'Close (Esc)');
    assert.equal(data.labels.showOnMap, 'Show on map');

    // The viewer and its files are loaded in this order, after the page; the example blog also has a share summary, whose script comes last.
    const scripts = [...html.matchAll(/<script src="([^"]*)" defer><\/script>/g)].map((match) => match[1]);
    assert.deepEqual(scripts, ['/assets/carousel.js', ...VIEWER_SCRIPTS, '/assets/share.js']);
    for (const href of VIEWER_STYLES) assert.ok(html.includes(`<link rel="stylesheet" href="${href}">`), href);
    for (const file of [...VIEWER_SCRIPTS, ...VIEWER_STYLES]) {
      assert.ok(existsSync(join(result.outDir, ...file.slice(1).split('/'))), `${file} is published`);
    }
  });
});

test('an image with a published position gives the viewer its coordinates, others do not', async () => {
  await withExampleBuild((result) => {
    // The ridge photo of the hiking post is published with its position (the tag subtree says "keep").
    const hiking = viewerData(page(result, 'journal/mountain-weekend/index.html'));
    assert.equal(hiking.images.length, 1);
    const ridge = result.manifest.images.find((entry) => entry.post === '/journal/mountain-weekend/');
    assert.ok(ridge?.gps, 'the example photo has a position');
    assert.equal(hiking.images[0].latitude, ridge.gps.latitude);
    assert.equal(hiking.images[0].longitude, ridge.gps.longitude);
    assert.equal(hiking.images[0].precision, ridge.gps.precision);

    // The dovetail post says "coarse": the viewer gets rounded numbers, never the original ones.
    const dovetails = viewerData(page(result, 'journal/first-dovetail/index.html'));
    for (const image of dovetails.images) {
      if (image.latitude === undefined) continue;
      assert.equal(image.precision, 'coarse');
      assert.equal(image.latitude, Math.round(image.latitude * 100) / 100);
    }
  });
});

test('pages without images load none of the viewer', async () => {
  await withExampleBuild((result) => {
    const withoutImages = result.manifest.pages
      .filter((entry) => entry.file.endsWith('.html'))
      .filter((entry) => !readFileSync(join(result.outDir, ...entry.file.split('/')), 'utf8').includes('viewer-link'));
    assert.ok(withoutImages.length > 5, 'most pages have no images');
    for (const entry of withoutImages) {
      const html = page(result, entry.file);
      assert.ok(!html.includes('viewer'), `${entry.file} mentions the viewer`);
      assert.ok(!html.includes('photoswipe'), `${entry.file} loads PhotoSwipe`);
      assert.ok(!html.includes('application/json'), entry.file);
    }
  });
});

test('the home page text can have images that open in the viewer too', async () => {
  await withExampleBuild(
    (result) => {
      const html = page(result, 'index.html');
      const data = viewerData(html);
      assert.equal(data.images.length, 1);
      assert.match(html, /<a href="\/img\/[0-9a-f]{16}\/photo-full\.jpg" class="viewer-link" data-viewer="0">/);
      assert.ok(html.includes('/assets/viewer.js'));
    },
    (() => {
      const home = readFileSync(join(exampleDir, 'content', 'home.md'), 'utf8');
      return { 'content/home.md': `${home.trimEnd()}\n\n![A made-up photo](photo.jpg)\n`, 'content/photo.jpg': TINY_JPEG };
    })(),
  );
});

test('the language of the site decides the words of the viewer', async () => {
  const text = readFileSync(join(exampleDir, 'coffer.yaml'), 'utf8').replace('lang: en', 'lang: ru');
  await withExampleBuild(
    (result) => {
      const data = viewerData(page(result, 'journal/photo-notes/index.html'));
      assert.equal(data.labels.close, 'Закрыть (Esc)');
      assert.equal(data.labels.showOnMap, 'Показать на карте');
    },
    { 'coffer.yaml': text },
  );
});

// ---- The vendored library ----------------------------------------------------------------------

test('PhotoSwipe is vendored with its MIT license and without any mention of a CDN', () => {
  const directory = join(themeAssets, 'vendor', 'photoswipe');
  for (const file of ['LICENSE', 'photoswipe.css', 'photoswipe.umd.min.js', 'photoswipe-lightbox.umd.min.js']) {
    assert.ok(existsSync(join(directory, file)), file);
  }
  assert.match(readFileSync(join(directory, 'LICENSE'), 'utf8'), /^The MIT License \(MIT\)\n\nCopyright \(c\) 2014-2022 Dmitry Semenov/);
  assert.match(readFileSync(join(directory, 'photoswipe.umd.min.js'), 'utf8'), /^\/\*!\s+\* PhotoSwipe 5\.4\.4 /);
  assert.match(readFileSync(join(directory, 'photoswipe-lightbox.umd.min.js'), 'utf8'), /^\/\*!\s+\* PhotoSwipe Lightbox 5\.4\.4 /);
});

// ---- The script ----------------------------------------------------------------------------------

/** A stand-in for a DOM element, enough for the viewer script. */
class FakeElement {
  /** @param {string} tagName */
  constructor(tagName = 'div') {
    this.tagName = tagName;
    this.textContent = '';
    this.hidden = false;
    /** @type {Record<string, string>} */
    this.attributes = {};
    /** @type {Map<string, ((event: any) => void)[]>} */
    this.listeners = new Map();
  }

  /** @param {string} name @param {string} value */
  setAttribute(name, value) {
    this.attributes[name] = value;
  }

  /** @param {string} name */
  getAttribute(name) {
    return this.attributes[name] ?? null;
  }

  /** @param {string} type @param {(event: any) => void} listener */
  addEventListener(type, listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  click() {
    for (const listener of this.listeners.get('click') ?? []) listener({ type: 'click' });
  }
}

/**
 * Runs the viewer script on a page with the given images, with stand-ins for
 * PhotoSwipe, the lightbox, the history and the document.
 *
 * @param {object} [options]
 * @param {object[]} [options.images]
 * @param {boolean} [options.map] Whether the page has a map.
 * @param {boolean} [options.library] Whether PhotoSwipe is loaded (default true).
 * @param {boolean} [options.data] Whether the page has its list of images (default true).
 */
function viewerPage({ images = [], map = false, library = true, data = true } = {}) {
  /** @type {any[]} */
  const lightboxes = [];
  /** @type {string[]} */
  const log = [];
  /** @type {Map<string, ((event: any) => void)[]>} */
  const documentListeners = new Map();
  /** @type {Map<string, (() => void)[]>} */
  const windowListeners = new Map();
  /** @type {any[]} */
  const dispatched = [];

  class FakePhotoSwipe {}

  class FakeLightbox {
    /** @param {any} options */
    constructor(options) {
      this.options = options;
      /** @type {Map<string, ((...args: any[]) => void)[]>} */
      this.listeners = new Map();
      /** @type {any} */
      this.pswp = undefined;
      lightboxes.push(this);
    }

    /** @param {string} name @param {(...args: any[]) => void} listener */
    on(name, listener) {
      this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
    }

    init() {
      log.push('init');
    }

    /** @param {number} index */
    loadAndOpen(index) {
      log.push(`open ${index}`);
      const lightbox = this;
      /** @type {Map<string, ((...args: any[]) => void)[]>} */
      const events = new Map();
      /** @type {any[]} */
      const registered = [];
      const pswp = {
        currIndex: index,
        get currSlide() {
          return { data: lightbox.options.dataSource[pswp.currIndex] };
        },
        ui: { registerElement: (/** @type {any} */ definition) => registered.push(definition) },
        on: (/** @type {string} */ name, /** @type {() => void} */ listener) => events.set(name, [...(events.get(name) ?? []), listener]),
        /** @param {number} to */
        goTo(to) {
          pswp.currIndex = to;
          for (const listener of events.get('change') ?? []) listener();
        },
        closed: false,
        close() {
          if (pswp.closed) return;
          pswp.closed = true;
          log.push('close');
          lightbox.fire('close');
          lightbox.pswp = undefined;
          lightbox.fire('destroy');
        },
        registered,
      };
      this.pswp = pswp;
      this.fire('uiRegister');
      /** @type {FakeElement[]} */
      this.elements = [];
      for (const definition of registered) {
        const element = new FakeElement(definition.isButton ? 'button' : 'div');
        this.elements.push(element);
        definition.onInit(element, pswp);
        definition.element = element;
      }
      this.fire('afterInit');
    }

    /** @type {FakeElement[]} */
    elements = [];

    /** @param {string} name */
    fire(name) {
      for (const listener of this.listeners.get(name) ?? []) listener();
    }
  }

  const window = {
    ...(library ? { PhotoSwipe: FakePhotoSwipe, PhotoSwipeLightbox: FakeLightbox } : {}),
    history: {
      /** @type {any[]} */
      pushed: [],
      backs: 0,
      pushState(/** @type {any} */ state) {
        this.pushed.push(state);
      },
      back() {
        this.backs += 1;
      },
    },
    addEventListener: (/** @type {string} */ type, /** @type {() => void} */ listener) =>
      windowListeners.set(type, [...(windowListeners.get(type) ?? []), listener]),
    CustomEvent: class {
      /** @param {string} type @param {{ detail: any }} init */
      constructor(type, init) {
        this.type = type;
        this.detail = init.detail;
      }
    },
  };
  const json = JSON.stringify({
    labels: { close: 'Close', zoom: 'Zoom', previous: 'Back', next: 'Forward', error: 'Broken', showOnMap: 'On the map' },
    images,
  });
  const document = {
    readyState: 'complete',
    getElementById: (/** @type {string} */ id) => (data && id === VIEWER_DATA_ID ? { textContent: json } : null),
    querySelector: (/** @type {string} */ selector) => (map && selector === '[data-map]' ? {} : null),
    addEventListener: (/** @type {string} */ type, /** @type {(event: any) => void} */ listener) =>
      documentListeners.set(type, [...(documentListeners.get(type) ?? []), listener]),
    dispatchEvent: (/** @type {any} */ event) => dispatched.push(event),
  };
  vm.runInNewContext(readFileSync(join(themeAssets, 'viewer.js'), 'utf8'), { window, document });

  /**
   * Clicks a link of the page.
   *
   * @param {string | null} index Value of data-viewer, or null for something that is not an image link.
   * @param {Record<string, unknown>} [extra]
   */
  const click = (index, extra = {}) => {
    const link = index === null ? null : { getAttribute: (/** @type {string} */ name) => (name === 'data-viewer' ? index : null) };
    const event = {
      defaultPrevented: false,
      button: 0,
      target: { closest: () => link },
      preventDefault() {
        this.defaultPrevented = true;
      },
      ...extra,
    };
    for (const listener of documentListeners.get('click') ?? []) listener(event);
    return event;
  };
  const popstate = () => {
    for (const listener of windowListeners.get('popstate') ?? []) listener();
  };
  return { lightboxes, log, window, click, popstate, dispatched };
}

const PHOTOS = [
  { src: '/img/a-full.jpg', width: 4000, height: 3000, alt: 'A', caption: 'First' },
  { src: '/img/b-full.jpg', width: 3000, height: 4000, alt: 'B', caption: '', latitude: 47.01, longitude: 11.05, precision: 'coarse' },
  { src: '/img/c-full.jpg', width: 4000, height: 3000, alt: 'C', caption: 'Third' },
];

test('the script gives PhotoSwipe all the images of the page, with the words of the site', () => {
  const page = viewerPage({ images: PHOTOS });
  assert.equal(page.lightboxes.length, 1);
  const { options } = page.lightboxes[0];
  assert.deepEqual(JSON.parse(JSON.stringify(options.dataSource)), PHOTOS);
  assert.equal(typeof options.pswpModule, 'function');
  assert.equal(options.closeTitle, 'Close');
  assert.equal(options.zoomTitle, 'Zoom');
  assert.equal(options.arrowPrevTitle, 'Back');
  assert.equal(options.arrowNextTitle, 'Forward');
  assert.equal(options.errorMsg, 'Broken');
  assert.equal(options.showHideAnimationType, 'none', 'nothing flies in');
  assert.equal(options.zoomAnimationDuration, false);
  assert.notEqual(options.escKey, false, 'Esc closes');
  assert.notEqual(options.arrowKeys, false, 'the arrow keys walk through the images');
  assert.notEqual(options.imageClickAction, 'close');
  assert.deepEqual(page.log, ['init']);
});

test('a click on an image link opens the viewer at that image and does not follow the link', () => {
  const page = viewerPage({ images: PHOTOS });
  const event = page.click('2');
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(page.log, ['init', 'open 2']);
  page.lightboxes[0].pswp.close();
  page.click('0');
  assert.equal(page.log.at(-1), 'open 0');
});

test('clicks that are not plain clicks on an image link are left to the browser', () => {
  const page = viewerPage({ images: PHOTOS });
  assert.equal(page.click(null).defaultPrevented, false, 'not a viewer link');
  assert.equal(page.click('0', { ctrlKey: true }).defaultPrevented, false, 'new tab');
  assert.equal(page.click('0', { metaKey: true }).defaultPrevented, false);
  assert.equal(page.click('0', { shiftKey: true }).defaultPrevented, false, 'new window');
  assert.equal(page.click('0', { button: 1 }).defaultPrevented, false, 'middle button');
  assert.equal(page.click('0', { defaultPrevented: true }).defaultPrevented, true);
  assert.equal(page.click('7').defaultPrevented, false, 'there is no seventh image');
  assert.equal(page.click('x').defaultPrevented, false);
  assert.deepEqual(page.log, ['init']);
});

test('without PhotoSwipe or without the list of images the script does nothing and the links keep working', () => {
  const noLibrary = viewerPage({ images: PHOTOS, library: false });
  assert.equal(noLibrary.click('0').defaultPrevented, false);
  assert.deepEqual(noLibrary.log, []);
  const noData = viewerPage({ images: PHOTOS, data: false });
  assert.equal(noData.lightboxes.length, 0);
  const empty = viewerPage({ images: [] });
  assert.equal(empty.lightboxes.length, 0);
});

test('the back gesture closes the viewer: opening pushes a history entry, popstate closes', () => {
  const page = viewerPage({ images: PHOTOS });
  assert.deepEqual(page.window.history.pushed, []);
  page.click('1');
  assert.equal(page.window.history.pushed.length, 1, 'one entry on open');
  assert.ok(/** @type {any} */ (page.window.history.pushed[0]).cofferViewer);

  page.popstate();
  assert.equal(page.log.at(-1), 'close', 'the viewer is closed by the back gesture');
  assert.equal(page.window.history.backs, 0, 'the entry is already gone, so the page does not step back again');

  // A later back step, while no viewer is open, is not ours.
  page.popstate();
  assert.equal(page.log.filter((line) => line === 'close').length, 1);
});

test('closing in another way (Esc, the close button) takes the history entry off again', () => {
  const page = viewerPage({ images: PHOTOS });
  page.click('1');
  page.lightboxes[0].pswp.close();
  assert.equal(page.window.history.backs, 1, 'the entry pushed on open is taken off');
  // The popstate that this causes finds nothing to close.
  page.popstate();
  assert.equal(page.log.filter((line) => line === 'close').length, 1);

  // And the viewer can be opened again, with one more entry.
  page.click('0');
  assert.equal(page.window.history.pushed.length, 2);
  page.popstate();
  assert.equal(page.window.history.backs, 1, 'closing by back does not step back a second time');
});

test('a browser that refuses to push a history entry still opens and closes the viewer', () => {
  const page = viewerPage({ images: PHOTOS });
  page.window.history.pushState = () => {
    throw new Error('not allowed');
  };
  page.click('0');
  page.lightboxes[0].pswp.close();
  assert.equal(page.window.history.backs, 0);
  assert.equal(page.log.at(-1), 'close');
});

test('the caption of the current image is shown under it and follows the slides', () => {
  const page = viewerPage({ images: PHOTOS });
  page.click('0');
  const lightbox = page.lightboxes[0];
  const definition = lightbox.pswp.registered.find((/** @type {any} */ entry) => entry.name === 'coffer-caption');
  assert.ok(definition);
  const caption = definition.element;
  assert.equal(caption.textContent, 'First');
  assert.equal(caption.hidden, false);
  lightbox.pswp.goTo(1);
  assert.equal(caption.textContent, '');
  assert.equal(caption.hidden, true, 'an image without a caption shows no caption');
  lightbox.pswp.goTo(2);
  assert.equal(caption.textContent, 'Third');
  assert.equal(caption.hidden, false);
  assert.equal(caption.getAttribute('aria-live'), 'polite');
});

test('the caption is set as text, never as markup', () => {
  const page = viewerPage({ images: [{ src: '/a.jpg', width: 1, height: 1, alt: '', caption: '<img src=x onerror=alert(1)>' }] });
  page.click('0');
  const caption = page.lightboxes[0].pswp.registered.find((/** @type {any} */ entry) => entry.name === 'coffer-caption').element;
  assert.equal(caption.textContent, '<img src=x onerror=alert(1)>');
  const source = readFileSync(join(themeAssets, 'viewer.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/innerHTML|insertAdjacentHTML|document\.write/.test(source));
});

test('the show-on-map button appears for images with a published position when the page has a map', () => {
  const withMap = viewerPage({ images: PHOTOS, map: true });
  withMap.click('0');
  let button = withMap.lightboxes[0].pswp.registered.find((/** @type {any} */ entry) => entry.name === 'show-on-map').element;
  assert.equal(button.textContent, 'On the map');
  assert.equal(button.hidden, true, 'the first image has no position');
  withMap.lightboxes[0].pswp.goTo(1);
  assert.equal(button.hidden, false, 'the second image has one');
  withMap.lightboxes[0].pswp.goTo(2);
  assert.equal(button.hidden, true);

  // Without a map on the page the button would do nothing, so it stays hidden.
  const withoutMap = viewerPage({ images: PHOTOS, map: false });
  withoutMap.click('1');
  button = withoutMap.lightboxes[0].pswp.registered.find((/** @type {any} */ entry) => entry.name === 'show-on-map').element;
  assert.equal(button.hidden, true);
});

test('the show-on-map button closes the viewer and then tells the map which image to show', () => {
  const page = viewerPage({ images: PHOTOS, map: true });
  page.click('1');
  const button = page.lightboxes[0].pswp.registered.find((/** @type {any} */ entry) => entry.name === 'show-on-map').element;
  button.click();
  assert.equal(page.log.at(-1), 'close');
  assert.equal(page.dispatched.length, 1);
  assert.equal(page.dispatched[0].type, 'coffer:show-on-map');
  assert.deepEqual(JSON.parse(JSON.stringify(page.dispatched[0].detail)), { index: 1, latitude: 47.01, longitude: 11.05, src: '/img/b-full.jpg' });

  // Closing in the usual way tells the map nothing.
  page.click('1');
  page.lightboxes[0].pswp.close();
  assert.equal(page.dispatched.length, 1);
});

test('the script starts nothing by itself and animates nothing', () => {
  const source = readFileSync(join(themeAssets, 'viewer.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/setInterval|setTimeout|requestAnimationFrame|autoplay/i.test(source));
  const css = readFileSync(join(themeAssets, 'viewer.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(css, /(^|[\s{;])(animation|transition)[a-z-]*\s*:/);
});
