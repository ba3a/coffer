/**
 * Reads the position and the camera fields of a picture, applies a location
 * policy to them and turns the result into the EXIF data of a published JPEG.
 * Reading back what was published uses the same functions, so that what the
 * build writes and what `coffer check` expects cannot drift apart.
 *
 * Only a short list of fields is ever copied (see {@link CAMERA_FIELDS}): the
 * position as latitude and longitude, and the make, model, lens and exposure
 * settings of the camera. Everything else in the original, such as the time,
 * the altitude, serial numbers, the owner's name, thumbnails, maker notes and
 * XMP, is left behind.
 */
import exifr from 'exifr';

/**
 * A position in degrees, north and east positive.
 *
 * @typedef {object} Position
 * @property {number} latitude
 * @property {number} longitude
 */

/**
 * A position as it is published.
 *
 * @typedef {object} PublishedPosition
 * @property {number} latitude
 * @property {number} longitude
 * @property {'exact' | 'coarse'} precision Whether the coordinates are the original's or are rounded to two decimals (about a kilometre).
 */

/**
 * The camera fields of a picture, each present only when the picture has it.
 *
 * @typedef {object} CameraFields
 * @property {string} [make]
 * @property {string} [model]
 * @property {string} [lensMake]
 * @property {string} [lensModel]
 * @property {number} [exposureTime] Seconds.
 * @property {number} [fNumber]
 * @property {number} [iso]
 * @property {number} [focalLength] Millimetres.
 * @property {number} [focalLength35mm] Millimetres, as on a 35 mm film camera.
 */

/**
 * @typedef {object} OriginalMetadata
 * @property {Position | null} gps
 * @property {CameraFields | null} camera
 */

/**
 * @typedef {object} PublishedMetadata
 * @property {Position | null} gps
 * @property {CameraFields | null} camera
 * @property {string[]} cameraTags Names of the EXIF tags found that describe the camera or the shot, whether or not coffer writes them.
 */

/**
 * @typedef {{ name: keyof CameraFields, ifd: 'IFD0' | 'IFD2', write: string, read: string, kind: 'text' | 'rational' | 'integer' }} CameraField
 */

/**
 * The camera fields coffer copies when the camera policy is `keep`: the name in
 * {@link CameraFields}, where sharp writes the tag (`write`), what exifr calls
 * it when reading (`read`) and the kind of value.
 *
 * @type {readonly CameraField[]}
 */
export const CAMERA_FIELDS = Object.freeze([
  { name: 'make', ifd: 'IFD0', write: 'Make', read: 'Make', kind: 'text' },
  { name: 'model', ifd: 'IFD0', write: 'Model', read: 'Model', kind: 'text' },
  { name: 'lensMake', ifd: 'IFD2', write: 'LensMake', read: 'LensMake', kind: 'text' },
  { name: 'lensModel', ifd: 'IFD2', write: 'LensModel', read: 'LensModel', kind: 'text' },
  { name: 'exposureTime', ifd: 'IFD2', write: 'ExposureTime', read: 'ExposureTime', kind: 'rational' },
  { name: 'fNumber', ifd: 'IFD2', write: 'FNumber', read: 'FNumber', kind: 'rational' },
  { name: 'iso', ifd: 'IFD2', write: 'ISOSpeedRatings', read: 'ISO', kind: 'integer' },
  { name: 'focalLength', ifd: 'IFD2', write: 'FocalLength', read: 'FocalLength', kind: 'rational' },
  { name: 'focalLength35mm', ifd: 'IFD2', write: 'FocalLengthIn35mmFilm', read: 'FocalLengthIn35mmFormat', kind: 'integer' },
]);

/**
 * Tags, as exifr names them, that tell something about the camera or the shot.
 * A published file under the camera policy `strip` must have none of them.
 */
const CAMERA_TAGS = Object.freeze([
  ...CAMERA_FIELDS.map((field) => field.read),
  'ISOSpeedRatings',
  'LensInfo',
  'LensSpecification',
  'LensSerialNumber',
  'BodySerialNumber',
  'SerialNumber',
  'CameraSerialNumber',
  'CameraOwnerName',
  'OwnerName',
  'ExposureProgram',
  'ExposureBiasValue',
  'MeteringMode',
  'Flash',
  'WhiteBalance',
  'ShutterSpeedValue',
  'ApertureValue',
  'MaxApertureValue',
  'BrightnessValue',
  'SubjectDistance',
  'MakerNote',
]);

/** How far two coordinates may differ, in degrees, and still be the same position (about a centimetre). */
export const COORDINATE_TOLERANCE = 1e-7;

/** Number of decimals of a coarse position: 0.01 degrees is about 1.1 km. */
const COARSE_DECIMALS = 2;

/**
 * Reads the EXIF data of a file with the options that suit both the original
 * and what was published.
 *
 * @param {Uint8Array} bytes
 * @returns {Promise<Record<string, any> | null>} The tags by name, or null when there are none or the format is not one exifr reads.
 */
async function readTags(bytes) {
  try {
    const tags = await exifr.parse(bytes, {
      gps: true,
      mergeOutput: true,
      translateKeys: true,
      translateValues: false,
      reviveValues: false,
      sanitize: true,
    });
    return tags && typeof tags === 'object' ? tags : null;
  } catch {
    return null;
  }
}

/**
 * @param {Record<string, any> | null} tags
 * @returns {Position | null}
 */
function positionOf(tags) {
  if (tags === null) return null;
  const { latitude, longitude } = tags;
  if (
    typeof latitude !== 'number' ||
    typeof longitude !== 'number' ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180
  ) {
    return null;
  }
  return { latitude, longitude };
}

/**
 * @param {Record<string, any> | null} tags
 * @returns {CameraFields | null}
 */
function cameraOf(tags) {
  if (tags === null) return null;
  /** @type {Record<string, string | number>} */
  const fields = {};
  for (const field of CAMERA_FIELDS) {
    let value = tags[field.read];
    if (Array.isArray(value)) value = value[0];
    if (field.kind === 'text') {
      if (typeof value !== 'string') continue;
      // eslint-disable-next-line no-control-regex
      const text = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
      if (text !== '') fields[field.name] = text;
    } else if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      if (field.kind === 'integer') {
        if (Number.isInteger(value) && value <= 65535) fields[field.name] = value;
      } else {
        fields[field.name] = value;
      }
    }
  }
  return Object.keys(fields).length === 0 ? null : /** @type {CameraFields} */ (fields);
}

/**
 * Reads the position and the camera fields of an original (JPEG, HEIC or
 * another file exifr understands). A file without such data, or in a format
 * exifr cannot read, gives nulls: nothing is ever published that was not read.
 *
 * @param {Uint8Array} bytes
 * @returns {Promise<OriginalMetadata>}
 */
export async function readOriginalMetadata(bytes) {
  const tags = await readTags(bytes);
  return { gps: positionOf(tags), camera: cameraOf(tags) };
}

/**
 * Reads back what a published JPEG says about the position and the camera.
 *
 * @param {Uint8Array} bytes
 * @returns {Promise<PublishedMetadata>}
 */
export async function readPublishedMetadata(bytes) {
  const tags = await readTags(bytes);
  return {
    gps: positionOf(tags),
    camera: cameraOf(tags),
    cameraTags: tags === null ? [] : CAMERA_TAGS.filter((name) => tags[name] !== undefined),
  };
}

/**
 * Rounds a coordinate to about a kilometre.
 *
 * @param {number} value Degrees.
 * @returns {number}
 */
export function roundCoordinate(value) {
  const factor = 10 ** COARSE_DECIMALS;
  return Math.round(value * factor) / factor + 0;
}

/**
 * What a location policy lets through of a position.
 *
 * @param {Position | null} gps The original's position.
 * @param {'strip' | 'coarse' | 'keep' | string} policy
 * @returns {PublishedPosition | null} Null for `strip` and for a picture without a position.
 */
export function publishedPosition(gps, policy) {
  if (gps === null) return null;
  if (policy === 'keep') return { latitude: gps.latitude, longitude: gps.longitude, precision: 'exact' };
  if (policy === 'coarse') {
    return {
      latitude: roundCoordinate(gps.latitude),
      longitude: roundCoordinate(gps.longitude),
      precision: 'coarse',
    };
  }
  return null;
}

/**
 * @param {number} a
 * @param {number} b
 * @returns {boolean}
 */
export function sameCoordinate(a, b) {
  return Math.abs(a - b) <= COORDINATE_TOLERANCE;
}

/**
 * @param {Position} a
 * @param {Position} b
 * @returns {boolean}
 */
export function samePosition(a, b) {
  return sameCoordinate(a.latitude, b.latitude) && sameCoordinate(a.longitude, b.longitude);
}

/**
 * Whether a position is on the grid of coarse positions.
 *
 * @param {Position} position
 * @returns {boolean}
 */
export function isCoarse(position) {
  return samePosition(position, {
    latitude: roundCoordinate(position.latitude),
    longitude: roundCoordinate(position.longitude),
  });
}

/**
 * @param {CameraFields | null} a
 * @param {CameraFields | null} b
 * @returns {boolean}
 */
export function sameCamera(a, b) {
  if (a === null || b === null) return a === b;
  for (const field of CAMERA_FIELDS) {
    const left = a[field.name];
    const right = b[field.name];
    if (left === undefined || right === undefined) {
      if (left !== right) return false;
    } else if (typeof left === 'number' && typeof right === 'number') {
      if (Math.abs(left - right) > 1e-6 * Math.max(1, Math.abs(left))) return false;
    } else if (left !== right) {
      return false;
    }
  }
  return true;
}

/**
 * A degree value as the three rationals of an EXIF GPS field: whole degrees,
 * whole minutes and seconds in millionths.
 *
 * @param {number} degrees Absolute value.
 * @returns {string}
 */
function degreesMinutesSeconds(degrees) {
  const ticks = Math.round(degrees * 3600 * 1_000_000);
  const whole = Math.floor(ticks / 3_600_000_000);
  const minutes = Math.floor((ticks % 3_600_000_000) / 60_000_000);
  const seconds = ticks % 60_000_000;
  return `${whole}/1 ${minutes}/1 ${seconds}/1000000`;
}

/**
 * A number as an EXIF rational, `numerator/denominator`, exact for the values
 * cameras write (1/125, 28/10, 425/100).
 *
 * @param {number} value Positive.
 * @returns {string}
 */
function rational(value) {
  if (Number.isInteger(value)) return `${value}/1`;
  if (value < 1) {
    const inverse = 1 / value;
    if (Math.abs(inverse - Math.round(inverse)) < 1e-6 * inverse) return `1/${Math.round(inverse)}`;
  }
  for (const denominator of [10, 100, 1000, 10000, 100000]) {
    const numerator = Math.round(value * denominator);
    if (Math.abs(numerator / denominator - value) <= 1e-9 * Math.max(1, value)) {
      return `${numerator}/${denominator}`;
    }
  }
  return `${Math.round(value * 1_000_000)}/1000000`;
}

/**
 * The EXIF data to write into a published JPEG, in the form of sharp's
 * `withExif`. Orientation is not written: the pixels are already upright.
 *
 * @param {PublishedPosition | null} position
 * @param {CameraFields | null} camera
 * @returns {Record<string, Record<string, string>> | null} Null when there is nothing to write.
 */
export function exifFor(position, camera) {
  /** @type {Record<string, Record<string, string>>} */
  const exif = {};
  if (camera !== null) {
    for (const field of CAMERA_FIELDS) {
      const value = camera[field.name];
      if (value === undefined) continue;
      exif[field.ifd] ??= {};
      exif[field.ifd][field.write] =
        field.kind === 'text' ? String(value) : field.kind === 'integer' ? String(value) : rational(/** @type {number} */ (value));
    }
  }
  if (position !== null) {
    exif.IFD3 = {
      GPSLatitudeRef: position.latitude < 0 ? 'S' : 'N',
      GPSLatitude: degreesMinutesSeconds(Math.abs(position.latitude)),
      GPSLongitudeRef: position.longitude < 0 ? 'W' : 'E',
      GPSLongitude: degreesMinutesSeconds(Math.abs(position.longitude)),
    };
  }
  return Object.keys(exif).length === 0 ? null : exif;
}
