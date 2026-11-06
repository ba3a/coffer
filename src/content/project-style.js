/**
 * The CSS that restyles the body of a project's page: an accent colour and a
 * display font.
 *
 * The values come from `project.yaml`, where the `color` and `font-name` field
 * types have already checked them, and they end up in CSS. They reach it only
 * through this module, which checks them once more and then builds the CSS
 * from nothing but the checked text, so no value can close a string, a rule or
 * a tag. A value that fails the check here is a bug in the caller and throws.
 */

/** What a colour is: `#rgb` or `#rrggbb`, as the `color` field type normalizes it. */
const COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/;

/** What one name of a font stack is, as the `font-name` field type allows it. */
const FONT_NAME = /^[A-Za-z0-9][A-Za-z0-9 -]{0,63}$/;

/** The family name of the font declared from a font file when `displayFont` does not name one. */
export const DEFAULT_DISPLAY_FAMILY = 'Project display';

/** The generic families of CSS, which are keywords and must not be quoted. */
const GENERIC_FAMILIES = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-serif',
  'ui-sans-serif',
  'ui-monospace',
  'ui-rounded',
  'math',
  'emoji',
  'fangsong',
]);

/** The addresses of the published font file that can be written into CSS: nothing that could end a string or a rule. */
const FONT_URL = /^\/[A-Za-z0-9._~/%-]+$/;

/**
 * @param {string} hex A checked colour.
 * @returns {string} `#000` or `#fff`: whichever reads better on the colour.
 */
function readableOn(hex) {
  const digits = hex.length === 4 ? [...hex.slice(1)].map((digit) => digit + digit).join('') : hex.slice(1);
  const [red, green, blue] = [0, 2, 4].map((at) => {
    const channel = Number.parseInt(digits.slice(at, at + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  return luminance > 0.179 ? '#000' : '#fff';
}

/**
 * The style of a project page.
 *
 * @typedef {object} ProjectStyle
 * @property {string} declarations Custom properties for the `style` attribute of the page's wrapper, such as `--project-accent:#dd6b4d;--project-font:"Fraunces", var(--coffer-font-heading)`. Empty when there is nothing to set.
 * @property {{ family: string, src: string, format: string } | null} fontFace The font to declare with `@font-face`: a checked family name, the site-relative address of the published font file and its CSS `format()`. Null when no font file is used.
 */

/**
 * Builds the style of a project page.
 *
 * @param {object} input
 * @param {string | null} [input.accent] A colour such as `#dd6b4d`.
 * @param {string | null} [input.displayFont] A comma-separated list of plain font family names.
 * @param {{ url: string, format: string } | null} [input.font] The published font file: its site-relative address and the CSS format name.
 * @returns {ProjectStyle | null} Null when the project sets no accent and no font.
 * @throws {Error} When a value is not one the field types of `project.yaml` produce.
 */
export function projectStyle({ accent = null, displayFont = null, font = null }) {
  /** @type {string[]} */
  const declarations = [];
  if (accent !== null) {
    if (!COLOR.test(accent)) throw new Error(`not a colour: ${JSON.stringify(accent)}`);
    declarations.push(`--project-accent:${accent}`, `--project-on-accent:${readableOn(accent)}`);
  }

  const names = displayFont === null ? [] : displayFont.split(',').map((name) => name.trim());
  for (const name of names) {
    if (!FONT_NAME.test(name)) throw new Error(`not a font family name: ${JSON.stringify(name)}`);
  }

  /** @type {ProjectStyle['fontFace']} */
  let fontFace = null;
  if (font !== null) {
    if (!FONT_URL.test(font.url) || !/^[a-z0-9]+$/.test(font.format)) {
      throw new Error(`not a font file address: ${JSON.stringify(font.url)}`);
    }
    fontFace = { family: names[0] ?? DEFAULT_DISPLAY_FAMILY, src: font.url, format: font.format };
  }
  const stack = fontFace !== null && names.length === 0 ? [fontFace.family] : names;
  if (stack.length > 0) {
    const families = stack.map((name) => (GENERIC_FAMILIES.has(name.toLowerCase()) ? name.toLowerCase() : `"${name}"`));
    declarations.push(`--project-font:${[...families, 'var(--coffer-font-heading)'].join(', ')}`);
  }

  if (declarations.length === 0 && fontFace === null) return null;
  return { declarations: declarations.join(';'), fontFace };
}
