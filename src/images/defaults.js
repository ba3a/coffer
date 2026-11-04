/** Widths, in pixels, of the WebP variants unless the site says otherwise. */
export const DEFAULT_WIDTHS = Object.freeze([480, 800, 1200, 1600, 2400]);

/** Longest edge, in pixels, of the full-size viewer JPEG unless the site says otherwise. */
export const DEFAULT_VIEWER_MAX_EDGE = 3200;

/** WebP quality (1 to 100) of the variants unless the site says otherwise. */
export const DEFAULT_WEBP_QUALITY = 80;

/** JPEG quality (1 to 100) of the viewer image unless the site says otherwise. */
export const DEFAULT_JPEG_QUALITY = 85;

/**
 * The value of the `sizes` attribute of published pictures unless the site says
 * otherwise: the text column of the default theme on wide screens, the screen
 * width less the page margins on narrow ones.
 */
export const DEFAULT_SIZES = '(min-width: 44rem) 41rem, calc(100vw - 2rem)';

/**
 * The value of the `sizes` attribute of the pictures in carousels unless the
 * site says otherwise. A slide is as wide as the carousel, which is as wide as
 * the text column, so the value is that of {@link DEFAULT_SIZES}; it is a
 * setting of its own for themes whose carousels are wider or narrower than the text.
 */
export const DEFAULT_CAROUSEL_SIZES = DEFAULT_SIZES;

/** Width of the variant that stands in for the picture where no `srcset` is understood: feeds, link previews, old readers. */
export const DEFAULT_IMAGE_WIDTH = 1200;

/** File extensions of the images the pipeline reads, lower case. */
export const IMAGE_EXTENSIONS = Object.freeze(['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif']);
