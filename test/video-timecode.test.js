import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as engine from '../src/index.js';
import { formatTimecode, isoDuration, parseTimecode } from '../src/video/timecode.js';

test('the engine entry point exports the timecode functions', () => {
  assert.equal(engine.parseTimecode, parseTimecode);
  assert.equal(engine.formatTimecode, formatTimecode);
  assert.equal(engine.isoDuration, isoDuration);
});

/** Vector 15.1 of the video spec. @type {[string, number | null][]} */
const PARSE = [
  ['0', 0],
  ['83', 83],
  ['0083', 83],
  ['1:23', 83],
  ['01:23', 83],
  ['61:00', 3660],
  ['1:02:03', 3723],
  ['99:59:59', 359999],
  ['100:00:00', null],
  ['1:60', null],
  ['1:2', null],
  ['1:5:00', null],
  ['1h2m3s', 3723],
  ['1h', 3600],
  ['2m', 120],
  ['90s', 90],
  ['1m90s', 150],
  ['1s2m', null],
  ['h', null],
  ['', null],
  [' 83', null],
  ['1.5', null],
  ['-5', null],
];

for (const [input, expected] of PARSE) {
  test(`parseTimecode(${JSON.stringify(input)}) is ${expected}`, () => {
    assert.equal(parseTimecode(input), expected);
  });
}

test('parseTimecode does not trim and rejects values above 99:59:59', () => {
  assert.equal(parseTimecode('83 '), null);
  assert.equal(parseTimecode('1:23\n'), null);
  assert.equal(parseTimecode('359999'), 359999);
  assert.equal(parseTimecode('360000'), null);
  assert.equal(parseTimecode('9999:59'), null);
  assert.equal(parseTimecode('99h59m59s'), 359999);
  assert.equal(parseTimecode('100h'), null);
  assert.equal(parseTimecode('1234567'), null);
});

/** Vector 15.2 of the video spec. @type {[number, string, string][]} */
const FORMAT = [
  [0, '0:00', 'PT0S'],
  [12, '0:12', 'PT12S'],
  [60, '1:00', 'PT1M'],
  [65, '1:05', 'PT1M5S'],
  [3600, '1:00:00', 'PT1H'],
  [3605, '1:00:05', 'PT1H5S'],
  [3723, '1:02:03', 'PT1H2M3S'],
  [359999, '99:59:59', 'PT99H59M59S'],
];

for (const [seconds, timecode, duration] of FORMAT) {
  test(`${seconds} seconds format as ${timecode} and ${duration}`, () => {
    assert.equal(formatTimecode(seconds), timecode);
    assert.equal(isoDuration(seconds), duration);
  });
}

for (const value of [360000, -1, 1.5, NaN, Infinity]) {
  test(`formatTimecode and isoDuration throw a RangeError for ${value}`, () => {
    assert.throws(() => formatTimecode(value), RangeError);
    assert.throws(() => isoDuration(value), RangeError);
  });
}
