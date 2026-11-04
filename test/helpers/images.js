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

/** The position of {@link geotaggedPhoto}: 47 deg 0' 44.444" N, 11 deg 2' 44.199" E. */
export const PHOTO_POSITION = Object.freeze({
  latitude: 47 + 0 / 60 + 44.444 / 3600,
  longitude: 11 + 2 / 60 + 44.199 / 3600,
});

/** The camera of {@link geotaggedPhoto}, as `readOriginalMetadata` reports it. */
export const PHOTO_CAMERA = Object.freeze({
  make: 'Examplecam',
  model: 'Made-up 1',
  lensModel: '35mm f/1.8',
  exposureTime: 1 / 250,
  fNumber: 5.6,
  iso: 200,
  focalLength: 35,
});

/**
 * A photograph with a made-up position and camera, and also things that must
 * never be published: a serial number and the time it was taken.
 *
 * @param {object} [options]
 * @param {number} [options.width]
 * @param {number} [options.height]
 * @param {number} [options.orientation] EXIF orientation to store (default 1).
 * @param {boolean} [options.southWest] Put the position in the southern and western hemisphere (same numbers).
 * @returns {Promise<Buffer>}
 */
export function geotaggedPhoto({ width = 1200, height = 800, orientation = 1, southWest = false } = {}) {
  return sharp({ create: { width, height, channels: 3, background: '#3355aa' } })
    .jpeg()
    .withMetadata({ orientation })
    .withExif({
      IFD0: { Make: 'Examplecam', Model: 'Made-up 1' },
      IFD2: {
        LensModel: '35mm f/1.8',
        ExposureTime: '1/250',
        FNumber: '56/10',
        ISOSpeedRatings: '200',
        FocalLength: '35/1',
        BodySerialNumber: 'SN-0042',
        DateTimeOriginal: '2025:05:01 10:20:30',
      },
      IFD3: {
        GPSLatitudeRef: southWest ? 'S' : 'N',
        GPSLatitude: '47/1 0/1 44444/1000',
        GPSLongitudeRef: southWest ? 'W' : 'E',
        GPSLongitude: '11/1 2/1 44199/1000',
        GPSAltitude: '1234/1',
      },
    })
    .toBuffer();
}
