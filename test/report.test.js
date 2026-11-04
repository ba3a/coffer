import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Report, ReportError, formatExactLocations, formatIssue, writeReport } from '../src/report.js';

test('formatIssue puts file, line and column in front of the message', () => {
  assert.equal(
    formatIssue({ file: 'content/journal/foo/index.md', line: 12, column: 5, message: "broken link '../bar/'" }),
    "content/journal/foo/index.md:12:5 broken link '../bar/'",
  );
  assert.equal(formatIssue({ file: 'a.md', line: 3, message: 'odd' }), 'a.md:3 odd');
  assert.equal(formatIssue({ file: 'a.md', message: 'odd' }), 'a.md odd');
  assert.equal(formatIssue({ line: 3, column: 1, message: 'odd' }), 'odd');
});

test('a report keeps errors, warnings and info apart', () => {
  const report = new Report();
  assert.equal(report.ok, true);
  report.addWarning('careful').addInfo({ site: 'demo', message: 'FYI' });
  assert.equal(report.ok, true);
  report.throwIfFailed();
  report.addError({ file: 'a.md', line: 1, column: 2, message: 'bad' }).addError('worse');
  assert.equal(report.ok, false);
  assert.deepEqual(report.toJSON(), {
    reportVersion: 1,
    errors: [{ file: 'a.md', line: 1, column: 2, message: 'bad' }, { message: 'worse' }],
    warnings: [{ message: 'careful' }],
    exactLocations: [],
    info: [{ site: 'demo', message: 'FYI' }],
  });
  assert.equal(
    report.format(),
    'Errors (2)\n  a.md:1:2 bad\n  worse\n\nWarnings (1)\n  careful\n\nInfo (1)\n  FYI\n',
  );
  assert.throws(
    () => report.throwIfFailed(),
    (error) => {
      assert.ok(error instanceof ReportError);
      assert.deepEqual(error.errors, ['a.md:1:2 bad', 'worse']);
      assert.equal(error.message, 'a.md:1:2 bad\nworse');
      return true;
    },
  );
});

test('the report lists the posts that publish exact locations in a section of their own', () => {
  const report = new Report();
  assert.deepEqual(report.toJSON().exactLocations, []);
  assert.equal(report.format(), '', 'no post publishes an exact location, so there is nothing to show');
  report
    .addExactLocation({ site: 'demo', file: 'content/journal/hike/index.md', images: 3 })
    .addExactLocation({ site: 'demo', file: 'content/journal/walk.md', images: 1 })
    .addWarning('careful');
  assert.deepEqual(report.toJSON().exactLocations, [
    { site: 'demo', file: 'content/journal/hike/index.md', images: 3 },
    { site: 'demo', file: 'content/journal/walk.md', images: 1 },
  ]);
  assert.equal(
    report.format(),
    'Warnings (1)\n  careful\n\nPosts publishing exact locations (2)\n  content/journal/hike/index.md: 3 image(s)\n  content/journal/walk.md: 1 image(s)\n',
  );
  assert.equal(report.ok, true, 'exact locations are information, not errors');
});

test('formatExactLocations always says something, and names the site only when there are several', () => {
  assert.equal(formatExactLocations([]), 'Posts publishing exact locations: none\n');
  assert.equal(
    formatExactLocations([{ site: 'a', file: 'x.md', images: 2 }]),
    'Posts publishing exact locations (1)\n  x.md: 2 image(s)\n',
  );
  assert.equal(
    formatExactLocations([
      { site: 'a', file: 'x.md', images: 2 },
      { site: 'b', file: 'x.md', images: 1 },
    ]),
    'Posts publishing exact locations (2)\n  a: x.md: 2 image(s)\n  b: x.md: 1 image(s)\n',
  );
});

test('an empty report formats as nothing', () => {
  assert.equal(new Report().format(), '');
});

test('writeReport creates the folder and writes JSON', () => {
  const root = mkdtempSync(join(tmpdir(), 'coffer-report-'));
  try {
    const file = join(root, 'deep', '.coffer', 'report.json');
    writeReport(new Report().addError('bad'), file);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).errors, [{ message: 'bad' }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
