import sharp from 'sharp';

/**
 * A plain picture of the given size and format.
 *
 * @param {number} width
 * @param {number} height
 * @param {'jpeg' | 'png' | 'webp'} [format]
 * @param {string} [background]
 * @returns {Promise<Buffer>}
 */
export function solidImage(width, height, format = 'jpeg', background = '#6a8caf') {
  return sharp({ create: { width, height, channels: 3, background } })
    [format]()
    .toBuffer();
}

/**
 * A photograph that is stored sideways, as a phone does it: `width` by `height`
 * pixels, a red top-left corner, and the EXIF orientation 6, which means "turn a
 * quarter clockwise to show it". Shown upright it is `height` by `width`.
 *
 * @param {number} width
 * @param {number} height
 * @returns {Promise<Buffer>}
 */
export function sidewaysPhoto(width, height) {
  return sharp({ create: { width, height, channels: 3, background: '#3355aa' } })
    .composite([
      {
        input: { create: { width: Math.round(width / 4), height: Math.round(height / 4), channels: 3, background: '#ff0000' } },
        left: 0,
        top: 0,
      },
    ])
    .jpeg()
    .withMetadata({ orientation: 6 })
    .withExif({
      IFD3: {
        GPSLatitudeRef: 'N',
        GPSLatitude: '47/1 0/1 443/10',
        GPSLongitudeRef: 'E',
        GPSLongitude: '11/1 2/1 442/10',
      },
    })
    .toBuffer();
}

/**
 * Noise that does not compress, so that making variants takes noticeable time.
 *
 * @param {number} width
 * @param {number} height
 * @returns {Promise<Buffer>}
 */
export function noisyImage(width, height) {
  const raw = Buffer.alloc(width * height * 3);
  let state = 12345;
  for (let index = 0; index < raw.length; index += 1) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    raw[index] = state >> 16;
  }
  return sharp(raw, { raw: { width, height, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
}

/** A small valid JPEG for tests that only need an image to exist. */
export const TINY_JPEG = await solidImage(8, 6, 'jpeg');

/** A small valid PNG for tests that only need an image to exist. */
export const TINY_PNG = await solidImage(8, 6, 'png');
