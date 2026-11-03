import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import nunjucks from 'nunjucks';
import { Translator, formatDate } from './i18n.js';

/** Directory holding the templates of the default theme. */
export const ENGINE_TEMPLATES_DIR = fileURLToPath(new URL('../../theme/templates/', import.meta.url));

/** A template name with this prefix always resolves to the engine's copy. */
export const ENGINE_PREFIX = 'coffer:';

/**
 * @typedef {object} TemplateOptions
 * @property {string} lang Language of the site (`en`, `ru`, ...); selects the UI strings and the date format.
 * @property {string | null} [theme] Absolute path of the theme directory; its `templates/` folder is searched first.
 * @property {string} [baseUrl] Absolute URL of the site; its path (if any) prefixes every URL made by the `url` filter.
 * @property {string} [timezone] IANA time zone in which the `date` filter shows moments (default `UTC`).
 * @property {string} [engineTemplatesDir] Directory of the engine's templates (defaults to the one shipped with coffer).
 * @property {string} [engineI18nDir] Directory of the engine's UI strings (defaults to the one shipped with coffer).
 * @property {boolean} [noCache] Re-read templates from disk on every render (for live preview).
 * @property {(message: string) => void} [onMissing] Receives each missing UI string once, when it is first needed.
 */

/**
 * Finds templates in the theme first and in the engine second. A name with the
 * `coffer:` prefix skips the theme, which is what lets a theme template extend
 * the engine template of the same name.
 */
export class ThemeLoader {
  /**
   * @param {{ themeDir?: string | null, engineDir: string, noCache?: boolean }} options
   */
  constructor({ themeDir, engineDir, noCache = false }) {
    this.engine = new nunjucks.FileSystemLoader(engineDir, { noCache });
    this.theme = themeDir ? new nunjucks.FileSystemLoader(join(themeDir, 'templates'), { noCache }) : null;
    /** The loader is synchronous. */
    this.async = /** @type {const} */ (false);
  }

  /**
   * @param {string} name
   * @returns {nunjucks.LoaderSource}
   */
  getSource(name) {
    if (name.startsWith(ENGINE_PREFIX)) {
      return /** @type {nunjucks.LoaderSource} */ (this.engine.getSource(name.slice(ENGINE_PREFIX.length)));
    }
    return /** @type {nunjucks.LoaderSource} */ (this.theme?.getSource(name) ?? this.engine.getSource(name));
  }
}

/**
 * Turns the path of a site URL into the form that is served: prefixed with the
 * site's base path and ending in a slash.
 *
 * Absolute URLs (`https:`, `mailto:`, `//host`), fragments (`#x`) and paths not
 * starting with `/` are returned unchanged. A query and a fragment are kept.
 * The last segment is a file, and gets no slash, when it ends in a dot and a
 * short extension that starts with a letter (`/feed.xml`, `/style.css`).
 *
 * @param {string} value
 * @param {string} [basePath] Path prefix such as `/docs`, without a trailing slash.
 * @returns {string}
 */
export function siteUrl(value, basePath = '') {
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//') || value.startsWith('#')) {
    return value;
  }
  if (!value.startsWith('/')) return value;
  const split = /^([^?#]*)(.*)$/s.exec(value);
  let path = (split?.[1] ?? value).replace(/\/{2,}/g, '/');
  const rest = split?.[2] ?? '';
  const last = path.slice(path.lastIndexOf('/') + 1);
  if (!path.endsWith('/') && !/\.[a-z][a-z0-9]{0,7}$/i.test(last)) path += '/';
  return `${basePath}${path}${rest}`;
}

/**
 * @param {string | undefined} baseUrl
 * @returns {string}
 */
function basePathOf(baseUrl) {
  if (!baseUrl) return '';
  let pathname;
  try {
    pathname = new URL(baseUrl).pathname;
  } catch {
    pathname = baseUrl;
  }
  return pathname.replace(/\/+$/, '');
}

/**
 * A Nunjucks environment wired to a theme, the UI strings of a language and
 * the filters `t`, `date` and `url`.
 */
export class TemplateEngine {
  /**
   * @param {TemplateOptions} options
   */
  constructor(options) {
    const engineDir = options.engineTemplatesDir ?? ENGINE_TEMPLATES_DIR;
    const basePath = basePathOf(options.baseUrl);
    const timezone = options.timezone ?? 'UTC';
    this.lang = options.lang;
    this.basePath = basePath;
    this.translator = new Translator({
      lang: options.lang,
      themeDir: options.theme ?? null,
      engineDir: options.engineI18nDir,
      onMissing: options.onMissing,
    });
    this.loader = new ThemeLoader({
      themeDir: options.theme ?? null,
      engineDir,
      noCache: options.noCache,
    });
    this.env = new nunjucks.Environment(this.loader, {
      autoescape: true,
      trimBlocks: true,
      lstripBlocks: true,
    });
    const translator = this.translator;
    this.env.addGlobal('lang', options.lang);
    this.env.addGlobal('basePath', basePath);
    this.env.addFilter('t', (/** @type {unknown} */ key, /** @type {Record<string, unknown> | undefined} */ params) => {
      if (typeof key !== 'string') {
        throw new TypeError(`the "t" filter needs a string key, got ${String(key)}`);
      }
      return translator.t(key, params ?? {});
    });
    this.env.addFilter('date', (/** @type {Date | string | number} */ value, /** @type {string | Intl.DateTimeFormatOptions | undefined} */ format) =>
      formatDate(options.lang, value, format, timezone),
    );
    this.env.addFilter('url', (/** @type {unknown} */ value) => siteUrl(String(value ?? ''), basePath));
  }

  /**
   * Renders a template found by name in the theme or the engine.
   *
   * @param {string} name Template name such as `page.njk`.
   * @param {Record<string, unknown>} [context] Variables for the template.
   * @returns {string}
   */
  render(name, context = {}) {
    return this.env.render(name, context);
  }

  /**
   * Renders template source text; `{% extends %}` and `{% include %}` resolve like in a theme.
   *
   * @param {string} source
   * @param {Record<string, unknown>} [context]
   * @returns {string}
   */
  renderString(source, context = {}) {
    return this.env.renderString(source, context);
  }

  /**
   * Missing-string messages found so far (English fallbacks and unknown keys).
   *
   * @returns {string[]}
   */
  missingStrings() {
    return this.translator.missing();
  }
}

/**
 * Creates the template engine for a site. Pass `theme`, `lang`, `baseUrl` and
 * `timezone` of the site's configuration.
 *
 * @param {TemplateOptions} options
 * @returns {TemplateEngine}
 */
export function createTemplates(options) {
  return new TemplateEngine(options);
}
