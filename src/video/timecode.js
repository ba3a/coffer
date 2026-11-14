/**
 * Timecodes of videos: positions in whole seconds, as authors write them
 * (`83`, `1:23`, `1:02:03`, `1m23s`) and as pages show them.
 */

/** The largest timecode, 99:59:59. */
const MAX_SECONDS = 359999;

const SECONDS = /^(\d{1,6})$/;
const MINUTES_SECONDS = /^(\d{1,4}):([0-5]\d)$/;
const HOURS_MINUTES_SECONDS = /^(\d{1,2}):([0-5]\d):([0-5]\d)$/;
const UNITS = /^(?:(\d{1,6})h)?(?:(\d{1,6})m)?(?:(\d{1,6})s)?$/;

/**
 * Reads a timecode. `text` must be one of the forms in full, without
 * surrounding whitespace.
 *
 * @param {string} text
 * @returns {number | null} Whole seconds, or null when `text` is not a timecode or is above 99:59:59.
 */
export function parseTimecode(text) {
  /** @type {[string | undefined, string | undefined, string | undefined] | null} */
  let parts = null;
  let match;
  if ((match = SECONDS.exec(text))) {
    parts = [undefined, undefined, match[1]];
  } else if ((match = MINUTES_SECONDS.exec(text))) {
    parts = [undefined, match[1], match[2]];
  } else if ((match = HOURS_MINUTES_SECONDS.exec(text))) {
    parts = [match[1], match[2], match[3]];
  } else if ((match = UNITS.exec(text)) && (match[1] ?? match[2] ?? match[3]) !== undefined) {
    parts = [match[1], match[2], match[3]];
  }
  if (parts === null) return null;
  const [h, m, s] = parts.map((part) => (part === undefined ? 0 : Number(part)));
  const seconds = 3600 * h + 60 * m + s;
  return seconds > MAX_SECONDS ? null : seconds;
}

/**
 * Splits a timecode into hours, minutes and seconds.
 *
 * @param {number} seconds
 * @returns {[number, number, number]}
 * @throws {RangeError} When `seconds` is not an integer from 0 to 359999.
 */
function split(seconds) {
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > MAX_SECONDS) {
    throw new RangeError(`${seconds} is not a timecode: it must be a whole number of seconds from 0 to ${MAX_SECONDS}`);
  }
  return [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60];
}

/**
 * Writes a timecode as `M:SS` below an hour and `H:MM:SS` from an hour.
 *
 * @param {number} seconds An integer from 0 to 359999.
 * @returns {string}
 * @throws {RangeError} For any other value.
 */
export function formatTimecode(seconds) {
  const [h, m, s] = split(seconds);
  const ss = String(s).padStart(2, '0');
  return h === 0 ? `${m}:${ss}` : `${h}:${String(m).padStart(2, '0')}:${ss}`;
}

/**
 * Writes a timecode as the ISO 8601 duration of `<time datetime>`, such as
 * `PT1H2M3S`; zero parts are left out, and 0 is `PT0S`.
 *
 * @param {number} seconds An integer from 0 to 359999.
 * @returns {string}
 * @throws {RangeError} For any other value.
 */
export function isoDuration(seconds) {
  const [h, m, s] = split(seconds);
  if (seconds === 0) return 'PT0S';
  return `PT${h ? `${h}H` : ''}${m ? `${m}M` : ''}${s ? `${s}S` : ''}`;
}
