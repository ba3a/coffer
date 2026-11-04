/**
 * Makes the HEIC test fixtures in `test/fixtures/`. Run it only to change them:
 *
 *     node test/helpers/make-heic-fixture.js
 *
 * It needs `ffmpeg` with the libx265 encoder on the PATH. ffmpeg cannot write
 * HEIF, so the picture is encoded as a one-frame MP4 and its HEVC parameters
 * (`hvcC`) and coded frame are lifted out and wrapped in a minimal HEIF file
 * (`ftyp`, `meta`, `mdat`) written here.
 *
 * Both pictures are 64 by 48 pixels as stored, with a red top-left quarter on a
 * blue field, and show 48 by 64 pixels upright, with the red corner at the top
 * right. `sideways.heic` says so with an `irot` property (what phones write);
 * `exif-sideways.heic` has no `irot` and only an Exif item with orientation 6.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

/**
 * @param {string} type Four characters.
 * @param {...Buffer} parts
 * @returns {Buffer}
 */
function box(type, ...parts) {
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
}

/**
 * @param {string} type
 * @param {number} version
 * @param {...Buffer} parts
 * @returns {Buffer}
 */
function fullBox(type, version, ...parts) {
  return box(type, Buffer.from([version, 0, 0, 0]), ...parts);
}

/**
 * @param {...number} values Unsigned 32 bit numbers.
 * @returns {Buffer}
 */
function u32(...values) {
  const buffer = Buffer.alloc(4 * values.length);
  values.forEach((value, index) => buffer.writeUInt32BE(value, 4 * index));
  return buffer;
}

/**
 * @param {...number} values Unsigned 16 bit numbers.
 * @returns {Buffer}
 */
function u16(...values) {
  const buffer = Buffer.alloc(2 * values.length);
  values.forEach((value, index) => buffer.writeUInt16BE(value, 2 * index));
  return buffer;
}

/**
 * The box of the given type that is nested anywhere in an MP4 file (found by
 * its name, which is good enough for a file that ffmpeg has just written).
 *
 * @param {Buffer} mp4
 * @param {string} type
 * @returns {Buffer}
 */
function findBox(mp4, type) {
  const at = mp4.indexOf(type, 0, 'latin1') - 4;
  if (at < 0) throw new Error(`no ${type} box in the MP4 file`);
  return mp4.subarray(at, at + mp4.readUInt32BE(at));
}

/**
 * An Exif item payload that holds only the orientation tag.
 *
 * @param {number} orientation 1 to 8.
 * @returns {Buffer}
 */
function exifItem(orientation) {
  return Buffer.concat([
    u32(0), // offset from here to the TIFF header
    Buffer.from('MM\0*', 'latin1'),
    u32(8), // offset of the first IFD
    u16(1), // one entry
    u16(0x0112, 3), // Orientation, type SHORT
    u32(1),
    u16(orientation, 0),
    u32(0), // no next IFD
  ]);
}

/**
 * Wraps one coded HEVC frame in a HEIF file.
 *
 * @param {{ hvcC: Buffer, frame: Buffer, width: number, height: number, quarterTurns: number, exifOrientation?: number }} picture
 *   `quarterTurns` is the `irot` angle: quarter turns anticlockwise, 0 to 3.
 *   `exifOrientation` adds an Exif item that holds that orientation.
 * @returns {Buffer}
 */
function heif({ hvcC, frame, width, height, quarterTurns, exifOrientation }) {
  const ftyp = box('ftyp', Buffer.from('heic'), u32(0), Buffer.from('mif1heic'));
  const properties = [hvcC, fullBox('ispe', 0, u32(width, height))];
  const associations = [0x81, 0x02];
  if (quarterTurns > 0) {
    properties.push(box('irot', Buffer.from([quarterTurns])));
    associations.push(0x83);
  }
  const exif = exifOrientation === undefined ? null : exifItem(exifOrientation);
  const meta = (/** @type {number} */ offset) =>
    fullBox(
      'meta',
      0,
      fullBox('hdlr', 0, u32(0), Buffer.from('pict'), u32(0, 0, 0), Buffer.from([0])),
      fullBox('pitm', 0, u16(1)),
      // Items are stored in one extent each, at absolute file offsets.
      fullBox(
        'iloc',
        0,
        Buffer.from([0x44, 0x00]),
        u16(exif ? 2 : 1),
        u16(1, 0, 1),
        u32(offset, frame.length),
        ...(exif ? [u16(2, 0, 1), u32(offset + frame.length, exif.length)] : []),
      ),
      fullBox(
        'iinf',
        0,
        u16(exif ? 2 : 1),
        fullBox('infe', 2, u16(1, 0), Buffer.from('hvc1'), Buffer.from([0])),
        ...(exif ? [fullBox('infe', 2, u16(2, 0), Buffer.from('Exif'), Buffer.from([0]))] : []),
      ),
      box(
        'iprp',
        box('ipco', ...properties),
        fullBox('ipma', 0, u32(1), u16(1), Buffer.from([associations.length, ...associations])),
      ),
    );
  const offset = ftyp.length + meta(0).length + 8;
  return Buffer.concat([ftyp, meta(offset), box('mdat', frame, ...(exif ? [exif] : []))]);
}

/**
 * @param {{ quarterTurns: number, exifOrientation?: number }} orientation How the picture is marked as turned.
 * @returns {Promise<Buffer>} A 64 by 48 HEIC picture with a red top-left quarter.
 */
async function makeHeic(orientation) {
  const width = 64;
  const height = 48;
  const work = mkdtempSync(join(tmpdir(), 'coffer-heic-'));
  try {
    await sharp({ create: { width, height, channels: 3, background: '#3355aa' } })
      .composite([
        {
          input: { create: { width: width / 2, height: height / 2, channels: 3, background: '#ff0000' } },
          left: 0,
          top: 0,
        },
      ])
      .png()
      .toFile(join(work, 'in.png'));
    execFileSync(
      'ffmpeg',
      [
        ...['-v', 'error', '-y', '-i', join(work, 'in.png'), '-frames:v', '1'],
        ...['-c:v', 'libx265', '-pix_fmt', 'yuv420p', '-crf', '12', '-tag:v', 'hvc1'],
        ...['-x265-params', 'log-level=none:info=0:repeat-headers=0'],
        join(work, 'out.mp4'),
      ],
      { stdio: 'inherit' },
    );
    const mp4 = readFileSync(join(work, 'out.mp4'));
    const hvcC = findBox(mp4, 'hvcC');
    const frame = findBox(mp4, 'mdat').subarray(8);
    return heif({ hvcC, frame, width, height, ...orientation });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const folder = fileURLToPath(new URL('../fixtures/', import.meta.url));
  mkdirSync(folder, { recursive: true });
  const fixtures = {
    'sideways.heic': { quarterTurns: 3 },
    'exif-sideways.heic': { quarterTurns: 0, exifOrientation: 6 },
  };
  for (const [name, orientation] of Object.entries(fixtures)) {
    writeFileSync(join(folder, name), await makeHeic(orientation));
    console.log(`wrote ${join(folder, name)}`);
  }
}
