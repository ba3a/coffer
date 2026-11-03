import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import nunjucks from 'nunjucks';
import { parse as parseYaml } from 'yaml';

import { readFontMetrics } from './font-metrics.js';

/** Width of a title card in pixels; the size Open Graph previews are drawn at. */
export const CARD_WIDTH = 1200;

/** Height of a title card in pixels. */
export const CARD_HEIGHT = 630;

/** The most lines of title a card shows; a longer title is cut with an ellipsis. */
export const CARD_MAX_TITLE_LINES = 3;

/** Directory of the engine's card template and fonts. */
export const ENGINE_THEME_DIR = fileURLToPath(new URL('../theme/', import.meta.url));

/** Name of the card template, in the engine's theme and in a site theme. */
export const CARD_TEMPLATE_NAME = 'card.svg.njk';

/** Name of the folder with the card fonts, in the engine's theme and in a site theme. */
export const CARD_FONTS_DIR_NAME = 'fonts';

/** Name of the file in which a theme sets its colours. */
export const THEME_CONFIG_NAME = 'theme.yaml';

/** Folder of the output (and address prefix) in which cards are published. */
export const CARDS_OUT_DIR = 'cards';

/** Folder of the cache, below the cache root, that keeps rendered cards. */
export const CARDS_CACHE_DIR = 'cards';

/**
 * Changes whenever the layout code changes in a way that alters the picture, so
 * that cards cached by an older engine are not reused.
 */
const CARD_LAYOUT_VERSION = 1;

/** Title sizes to try, largest first, until the title fits in the allowed lines. */
const TITLE_SIZES = [76, 68, 60, 52, 46];
const SITE_TITLE_SIZE = 36;
const PADDING = 80;
const TITLE_LINE_HEIGHT = 1.22;
/** The title block is centred between these two lines. */
const TITLE_TOP = 64;
const TITLE_BOTTOM = 450;
const SITE_TITLE_Y = 566;

/** Colours of a card unless the theme says otherwise: a dark card reads well in any feed. */
const DEFAULT_COLOURS = Object.freeze({
  background: '#16181d',
  foreground: '#f4f4f6',
  muted: '#b4b4be',
  accent: '#7ab7ff',
});

const FONT_EXTENSIONS = new Set(['.ttf', '.otf', '.ttc']);
const COLOUR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Raised for a card theme, template or font that cannot be used. */
export class CardError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = 'CardError';
  }
}

/**
 * The colours of a card.
 *
 * @typedef {object} CardColours
 * @property {string} background
 * @property {string} foreground Colour of the page title.
 * @property {string} muted Colour of the site title.
 * @property {string} accent
 */

/**
 * Reads the colours a theme sets for its cards from `theme.yaml` in the theme
 * directory:
 *
 * ```yaml
 * accent: "#c9a0ff"       # the accent colour of the theme
 * card:                   # optional; any of these may be left out
 *   background: "#101014"
 *   text: "#ffffff"
 *   mutedText: "#b0b0c0"
 * ```
 *
 * @param {string | null} themeDir Absolute path of the theme, or null for the default theme.
 * @returns {CardColours}
 * @throws {CardError} When the file is not valid YAML or a colour is not `#rgb` or `#rrggbb`.
 */
export function loadCardColours(themeDir) {
  /** @type {CardColours} */
  const colours = { ...DEFAULT_COLOURS };
  if (!themeDir) return colours;
  const file = join(themeDir, THEME_CONFIG_NAME);
  if (!existsSync(file)) return colours;
  /** @type {unknown} */
  let parsed;
  try {
    parsed = parseYaml(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new CardError(`${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed === null || parsed === undefined) return colours;
  if (!isMapping(parsed)) throw new CardError(`${file}: must be a mapping`);

  /**
   * @param {Record<string, unknown>} source
   * @param {string} key
   * @param {string} shown
   * @param {keyof CardColours} target
   */
  const read = (source, key, shown, target) => {
    const value = source[key];
    if (value === undefined || value === null) return;
    if (typeof value !== 'string' || !COLOUR_RE.test(value)) {
      throw new CardError(`${file}: ${shown} must be a colour such as "#7ab7ff", not ${JSON.stringify(value)}`);
    }
    colours[target] = value;
  };
  read(parsed, 'accent', 'accent', 'accent');
  const card = parsed.card;
  if (card !== undefined && card !== null) {
    if (!isMapping(card)) throw new CardError(`${file}: card must be a mapping`);
    read(card, 'background', 'card.background', 'background');
    read(card, 'text', 'card.text', 'foreground');
    read(card, 'mutedText', 'card.mutedText', 'muted');
    read(card, 'accent', 'card.accent', 'accent');
  }
  return colours;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isMapping(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Cuts a string, one character at a time from the end, until it and an ellipsis
 * fit the width.
 *
 * @param {string} text
 * @param {(text: string) => number} measure
 * @param {number} maxWidth
 * @returns {string}
 */
function ellipsize(text, measure, maxWidth) {
  const chars = Array.from(text.trimEnd());
  while (chars.length > 0 && measure(`${chars.join('')}…`) > maxWidth) chars.pop();
  return `${chars.join('').trimEnd()}…`;
}

/**
 * Breaks a word that is wider than a line into pieces that each fit.
 *
 * @param {string} word
 * @param {(text: string) => number} measure
 * @param {number} maxWidth
 * @returns {string[]}
 */
function breakWord(word, measure, maxWidth) {
  /** @type {string[]} */
  const pieces = [];
  let current = '';
  for (const char of word) {
    if (current !== '' && measure(current + char) > maxWidth) {
      pieces.push(current);
      current = char;
    } else {
      current += char;
    }
  }
  if (current !== '') pieces.push(current);
  return pieces;
}

/**
 * Greedy word wrap.
 *
 * @param {string} text Text with single spaces.
 * @param {(text: string) => number} measure
 * @param {number} maxWidth
 * @returns {string[]}
 */
export function wrapWords(text, measure, maxWidth) {
  /** @type {string[]} */
  const lines = [];
  let current = '';
  for (const word of text.split(' ')) {
    if (word === '') continue;
    if (measure(word) > maxWidth) {
      if (current !== '') lines.push(current);
      const pieces = breakWord(word, measure, maxWidth);
      current = /** @type {string} */ (pieces.pop());
      lines.push(...pieces);
      continue;
    }
    const candidate = current === '' ? word : `${current} ${word}`;
    if (measure(candidate) <= maxWidth) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current !== '') lines.push(current);
  return lines;
}

/**
 * Chooses the font size and the lines of a title: the largest size at which the
 * title takes no more than `maxLines` lines, else the smallest size with the
 * last line cut and ended with an ellipsis.
 *
 * @param {string} title
 * @param {(text: string, size: number) => number} width Width of a text at a size.
 * @param {{ maxWidth?: number, maxLines?: number, sizes?: number[] }} [options]
 * @returns {{ size: number, lines: string[] }}
 */
export function layoutTitle(title, width, options = {}) {
  const maxWidth = options.maxWidth ?? CARD_WIDTH - 2 * PADDING;
  const maxLines = options.maxLines ?? CARD_MAX_TITLE_LINES;
  const sizes = options.sizes ?? TITLE_SIZES;
  const text = cleanText(title);
  for (const size of sizes) {
    const lines = wrapWords(text, (part) => width(part, size), maxWidth);
    if (lines.length <= maxLines) return { size, lines: lines.length > 0 ? lines : [''] };
  }
  const size = /** @type {number} */ (sizes[sizes.length - 1]);
  const measure = (/** @type {string} */ part) => width(part, size);
  const lines = wrapWords(text, measure, maxWidth).slice(0, maxLines);
  lines[maxLines - 1] = ellipsize(/** @type {string} */ (lines[maxLines - 1]), measure, maxWidth);
  return { size, lines };
}

/**
 * Collapses white space and drops characters that cannot be written in XML.
 *
 * @param {string} text
 * @returns {string}
 */
function cleanText(text) {
  return text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿\ud800-\udfff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {string} dir
 * @returns {string[]} Absolute paths of the font files in the directory, sorted by name.
 */
function fontFilesIn(dir) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir)
    .filter((name) => FONT_EXTENSIONS.has(extname(name).toLowerCase()))
    .sort()
    .map((name) => join(dir, name));
}

/**
 * @param {string} file
 * @returns {string}
 */
function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** @returns {string} Version of the SVG renderer, which is part of what a card's bytes depend on. */
function rendererVersion() {
  try {
    const require = createRequire(import.meta.url);
    const found = require.resolve('@resvg/resvg-js');
    let dir = dirname(found);
    for (let depth = 0; depth < 4; depth++) {
      const manifest = join(dir, 'package.json');
      if (existsSync(manifest)) {
        const version = JSON.parse(readFileSync(manifest, 'utf8')).version;
        if (typeof version === 'string') return version;
      }
      dir = dirname(dir);
    }
  } catch {
    // fall through
  }
  return 'unknown';
}

/**
 * One title card, rendered or found in the cache.
 *
 * @typedef {object} Card
 * @property {string} hash Content hash; the card is published as `cards/{hash}.png`.
 * @property {string} file Absolute path of the PNG in the cache.
 * @property {boolean} cached True when the card was already in the cache.
 */

/**
 * @typedef {object} CardMakerOptions
 * @property {string | null} [themeDir] Absolute path of the site's theme. Its `card.svg.njk`, `fonts/` and `theme.yaml` replace the engine's.
 * @property {string} cacheDir Directory in which rendered cards are kept by hash (created when needed).
 * @property {string} siteTitle Title of the site, shown on every card.
 */

/**
 * Creates the maker of the title cards of one site. A card is a 1200 by 630 PNG
 * with the site title and the page title, written in a bundled font (Inter, which
 * covers Latin and Cyrillic) by an SVG renderer that never looks at the fonts of
 * the machine, so a card is the same on every operating system. Cards are cached
 * by the hash of everything they depend on: the SVG, the fonts and the renderer.
 *
 * @param {CardMakerOptions} options
 * @throws {CardError} When the theme's colours, template or fonts are unusable.
 */
export function createCardMaker(options) {
  const themeDir = options.themeDir ?? null;
  const colours = loadCardColours(themeDir);

  const themeTemplate = themeDir ? join(themeDir, CARD_TEMPLATE_NAME) : null;
  const templateFile =
    themeTemplate && existsSync(themeTemplate) ? themeTemplate : join(ENGINE_THEME_DIR, CARD_TEMPLATE_NAME);
  const template = readFileSync(templateFile, 'utf8');

  const themeFonts = themeDir ? fontFilesIn(join(themeDir, CARD_FONTS_DIR_NAME)) : [];
  const fontFiles = themeFonts.length > 0 ? themeFonts : fontFilesIn(join(ENGINE_THEME_DIR, CARD_FONTS_DIR_NAME));
  if (fontFiles.length === 0) {
    throw new CardError(`no font for the title cards: put .ttf or .otf files in ${join(themeDir ?? ENGINE_THEME_DIR, CARD_FONTS_DIR_NAME)}`);
  }
  const faces = fontFiles.map((file) => readFontMetrics(file));
  /** @param {number} weight */
  const closest = (weight) =>
    /** @type {import('./font-metrics.js').FontMetrics} */ (
      faces.reduce((best, face) => (Math.abs(face.weight - weight) < Math.abs(best.weight - weight) ? face : best))
    );
  const titleFace = closest(700);
  const siteFace = closest(400);
  const fontFamily = titleFace.family;
  const fontHashes = fontFiles.map(sha256);
  const version = rendererVersion();

  const environment = new nunjucks.Environment([], { autoescape: true });
  const cardsDir = options.cacheDir;
  const siteName = cleanText(options.siteTitle);
  const measureSite = (/** @type {string} */ text) => siteFace.width(text, SITE_TITLE_SIZE);
  const siteTitle =
    measureSite(siteName) <= CARD_WIDTH - 2 * PADDING
      ? siteName
      : ellipsize(siteName, measureSite, CARD_WIDTH - 2 * PADDING);

  const stats = { generated: 0, reused: 0 };

  /**
   * Finds or renders the card of a page.
   *
   * @param {string} title Title of the page.
   * @returns {Card}
   * @throws {CardError} When the template does not produce a 1200 by 630 picture.
   */
  function make(title) {
    const { size, lines } = layoutTitle(title, (text, fontSize) => titleFace.width(text, fontSize));
    const lineHeight = Math.round(size * TITLE_LINE_HEIGHT);
    const blockTop = Math.round((TITLE_TOP + TITLE_BOTTOM - lineHeight * lines.length) / 2);
    const svg = environment.renderString(template, {
      width: CARD_WIDTH,
      height: CARD_HEIGHT,
      padding: PADDING,
      ...colours,
      fontFamily,
      siteTitle,
      siteTitleSize: SITE_TITLE_SIZE,
      siteTitleY: SITE_TITLE_Y,
      titleSize: size,
      titleLines: lines.map((text, index) => ({
        text,
        y: Math.round(blockTop + lineHeight * index + lineHeight / 2 + size * 0.36),
      })),
    });
    const hash = createHash('sha256')
      .update(JSON.stringify({ layout: CARD_LAYOUT_VERSION, renderer: version, fonts: fontHashes, svg }))
      .digest('hex')
      .slice(0, 16);
    const file = join(cardsDir, `${hash}.png`);
    if (existsSync(file)) {
      stats.reused += 1;
      return { hash, file, cached: true };
    }

    const resvg = new Resvg(svg, {
      fitTo: { mode: 'width', value: CARD_WIDTH },
      font: {
        loadSystemFonts: false,
        fontFiles,
        defaultFontFamily: fontFamily,
        sansSerifFamily: fontFamily,
      },
    });
    const image = resvg.render();
    if (image.width !== CARD_WIDTH || image.height !== CARD_HEIGHT) {
      throw new CardError(
        `${templateFile}: the card must be ${CARD_WIDTH} by ${CARD_HEIGHT} pixels, not ${image.width} by ${image.height}`,
      );
    }
    mkdirSync(cardsDir, { recursive: true });
    const temporary = join(cardsDir, `${hash}.${process.pid}.tmp`);
    writeFileSync(temporary, image.asPng());
    renameSync(temporary, file);
    stats.generated += 1;
    return { hash, file, cached: false };
  }

  /**
   * Writes a card to `cards/{hash}.png` in a site's output directory.
   *
   * @param {Card} card
   * @param {string} outDir Output directory of the site.
   * @returns {string} Site-relative address of the published card.
   */
  function publish(card, outDir) {
    const name = `${card.hash}.png`;
    const target = join(outDir, CARDS_OUT_DIR, name);
    if (!existsSync(target)) {
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(card.file, target);
    }
    return `/${CARDS_OUT_DIR}/${name}`;
  }

  return {
    /** Family name the template writes in `font-family`. */
    fontFamily,
    /** Font files the renderer uses. */
    fontFiles,
    /** The template the cards are made from. */
    templateFile,
    /** Colours of the cards. */
    colours,
    /** Cards rendered and cards found in the cache since the maker was created. */
    stats,
    /** Whether the font has a glyph for a character. */
    hasGlyph: (/** @type {string} */ char) => titleFace.has(/** @type {number} */ (char.codePointAt(0))),
    make,
    publish,
    /**
     * Makes the card of a page and publishes it.
     *
     * @param {string} title
     * @param {string} outDir
     * @returns {string} Site-relative address of the card.
     */
    makeAndPublish: (title, outDir) => publish(make(title), outDir),
  };
}

/**
 * The cover of a post that is a file beside it, made ready to publish. Until the
 * image pipeline exists the file is copied as it is, under a name that comes
 * from its content.
 *
 * @param {string} source Absolute path of the image.
 * @param {string} outDir Output directory of the site.
 * @returns {string} Site-relative address of the copy.
 */
export function copyCover(source, outDir) {
  const hash = createHash('sha256').update(readFileSync(source)).digest('hex').slice(0, 16);
  const name = `${hash}${extname(basename(source)).toLowerCase()}`;
  const target = join(outDir, 'covers', name);
  if (!existsSync(target)) {
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
  }
  return `/covers/${name}`;
}

/** Extensions a cover can have. */
export const COVER_EXTENSIONS = Object.freeze(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif']);
