import { createRequire } from 'node:module';
import decodeHeicImage from 'heic-decode';
import exifr from 'exifr';

const require = createRequire(import.meta.url);

/** File extensions of HEIC and HEIF files, lower case. */
export const HEIC_EXTENSIONS = Object.freeze(['.heic', '.heif']);

/** Brands that, as the major brand of a file, mark HEIF with HEVC pictures (what phones write). */
const HEVC_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs']);

/** Generic HEIF brands; the file is HEIC only when a compatible brand says HEVC too (else it may be AVIF). */
const GENERIC_BRANDS = new Set(['mif1', 'msf1']);

/**
 * Version of the HEIC decoder and of the libheif build inside it, so that
 * pictures decoded by another version are made again.
 */
export const HEIC_DECODER_VERSION = `${require('heic-decode/package.json').version}+libheif-js@${
  require('libheif-js/package.json').version
}`;

/**
 * Whether the bytes are a HEIC picture: an `ftyp` box at the start of the file
 * with a HEVC brand. The file name plays no part.
 *
 * @param {Uint8Array} bytes
 * @returns {boolean}
 */
export function isHeic(bytes) {
  if (bytes.length < 16 || fourcc(bytes, 4) !== 'ftyp') return false;
  const size = view(bytes).getUint32(0);
  const end = Math.min(size < 16 ? 16 : size, bytes.length);
  const major = fourcc(bytes, 8);
  if (HEVC_BRANDS.has(major)) return true;
  if (!GENERIC_BRANDS.has(major)) return false;
  // Compatible brands follow the major brand and its version.
  for (let at = 16; at + 4 <= end; at += 4) {
    if (HEVC_BRANDS.has(fourcc(bytes, at))) return true;
  }
  return false;
}

/**
 * @param {Uint8Array} bytes
 * @returns {DataView}
 */
function view(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * @param {Uint8Array} bytes
 * @param {number} at
 * @returns {string}
 */
function fourcc(bytes, at) {
  return String.fromCharCode(bytes[at] ?? 0, bytes[at + 1] ?? 0, bytes[at + 2] ?? 0, bytes[at + 3] ?? 0);
}

/**
 * Whether the picture carries a rotation (`irot`) or mirror (`imir`) property.
 * The decoder applies those itself, and the HEIF standard says they win over
 * an Exif orientation.
 *
 * @param {Uint8Array} bytes
 * @returns {boolean}
 */
function hasContainerTransform(bytes) {
  /**
   * @param {number} start
   * @param {number} end
   * @param {string[]} path Box types to enter, outermost first.
   * @returns {boolean}
   */
  const search = (start, end, path) => {
    const data = view(bytes);
    let at = start;
    while (at + 8 <= end) {
      let size = data.getUint32(at);
      const type = fourcc(bytes, at + 4);
      if (size === 0) size = end - at;
      if (size < 8 || at + size > end) return false;
      if (path.length === 0 && (type === 'irot' || type === 'imir')) return true;
      if (path[0] === type) {
        // `meta` is a full box: a version and flags come before its children.
        const body = at + 8 + (type === 'meta' ? 4 : 0);
        if (search(body, at + size, path.slice(1))) return true;
      }
      at += size;
    }
    return false;
  };
  return search(0, bytes.length, ['meta', 'iprp', 'ipco']);
}

/**
 * Turns RGBA or RGB pixels upright by an Exif orientation.
 *
 * @param {Buffer} data
 * @param {number} width
 * @param {number} height
 * @param {number} channels
 * @param {number} orientation 1 to 8, as in Exif.
 * @returns {{ data: Buffer, width: number, height: number }}
 */
export function orientPixels(data, width, height, channels, orientation) {
  if (!(orientation >= 2 && orientation <= 8)) return { data, width, height };
  const turned = orientation >= 5;
  const outWidth = turned ? height : width;
  const out = Buffer.allocUnsafe(data.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      /** @type {number} */
      let dx;
      /** @type {number} */
      let dy;
      switch (orientation) {
        case 2: [dx, dy] = [width - 1 - x, y]; break;
        case 3: [dx, dy] = [width - 1 - x, height - 1 - y]; break;
        case 4: [dx, dy] = [x, height - 1 - y]; break;
        case 5: [dx, dy] = [y, x]; break;
        case 6: [dx, dy] = [height - 1 - y, x]; break;
        case 7: [dx, dy] = [height - 1 - y, width - 1 - x]; break;
        default: [dx, dy] = [y, width - 1 - x];
      }
      data.copy(out, (dy * outWidth + dx) * channels, (y * width + x) * channels, (y * width + x + 1) * channels);
    }
  }
  return { data: out, width: outWidth, height: turned ? width : height };
}

/**
 * A decoded picture: raw pixels, upright, without any metadata.
 *
 * @typedef {object} DecodedImage
 * @property {Buffer} data Pixels, row by row, `channels` bytes each.
 * @property {number} width
 * @property {number} height
 * @property {3 | 4} channels 3 (RGB) when the picture is fully opaque, else 4 (RGBA).
 */

/**
 * Decodes the first picture of a HEIC file with libheif (WebAssembly), which
 * sharp's prebuilt binaries cannot do. libheif applies the rotation and
 * mirroring stored in the file. When the file has none but an Exif item that
 * asks for a turn, that turn is applied here.
 *
 * @param {Uint8Array} bytes The whole file.
 * @returns {Promise<DecodedImage>}
 * @throws {Error} With the reason, when the file cannot be decoded.
 */
export async function decodeHeic(bytes) {
  /** @type {{ width: number, height: number, data: Uint8ClampedArray }} */
  let decoded;
  try {
    decoded = await decodeHeicImage({ buffer: bytes });
  } catch (error) {
    throw new Error(reasonOf(error));
  }
  const { width, height } = decoded;
  if (!(width > 0 && height > 0) || decoded.data.length !== width * height * 4) {
    throw new Error('the picture has no size');
  }
  const rgba = Buffer.from(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength);

  let opaque = true;
  for (let at = 3; at < rgba.length; at += 4) {
    if (rgba[at] !== 255) {
      opaque = false;
      break;
    }
  }
  /** @type {Buffer} */
  let data = rgba;
  let channels = /** @type {3 | 4} */ (4);
  if (opaque) {
    // Drop the alpha channel that every decoded picture has, so that the
    // published files do not carry an empty one.
    data = Buffer.allocUnsafe(width * height * 3);
    for (let from = 0, to = 0; from < rgba.length; from += 4, to += 3) {
      data[to] = /** @type {number} */ (rgba[from]);
      data[to + 1] = /** @type {number} */ (rgba[from + 1]);
      data[to + 2] = /** @type {number} */ (rgba[from + 2]);
    }
    channels = 3;
  }

  if (hasContainerTransform(bytes)) return { data, width, height, channels };
  /** @type {number | undefined} */
  let orientation;
  try {
    orientation = await exifr.orientation(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  } catch {
    // Unreadable Exif is no reason to refuse the picture; it is shown as stored.
  }
  return { ...orientPixels(data, width, height, channels, orientation ?? 1), channels };
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function reasonOf(error) {
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return text.trim() === '' ? 'the file is damaged or uses an unsupported HEIF feature' : text.trim();
}
