import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { run, USAGE } from '../src/cli.js';

const bin = fileURLToPath(new URL('../bin/coffer.js', import.meta.url));
const manifest = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);

/**
 * @param {string[]} argv
 */
async function runInProcess(argv) {
  let out = '';
  let err = '';
  const code = await run(argv, {
    out: (text) => {
      out += text;
    },
    err: (text) => {
      err += text;
    },
  });
  return { code, out, err };
}

/**
 * @param {string[]} args
 */
function runBin(args) {
  return spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' });
}

test('--version prints the package version', async () => {
  const result = await runInProcess(['--version']);
  assert.equal(result.code, 0);
  assert.equal(result.out, `${manifest.version}\n`);
  assert.equal(result.err, '');
});

test('help prints usage and exits 0', async () => {
  const result = await runInProcess(['help']);
  assert.equal(result.code, 0);
  assert.equal(result.out, USAGE);
});

test('an unknown command exits 1 with usage on stderr', async () => {
  const result = await runInProcess(['nonsense']);
  assert.equal(result.code, 1);
  assert.equal(result.out, '');
  assert.match(result.err, /unknown command "nonsense"/);
  assert.match(result.err, /Usage: coffer/);
});

test('no command exits 1 with usage', async () => {
  const result = await runInProcess([]);
  assert.equal(result.code, 1);
  assert.match(result.err, /Usage: coffer/);
});

test('inherited object keys are not commands', async () => {
  const result = await runInProcess(['toString']);
  assert.equal(result.code, 1);
});

test('the executable prints the package version for --version', () => {
  const result = runBin(['--version']);
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), manifest.version);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
});

test('the executable exits non-zero with usage for an unknown command', () => {
  const result = runBin(['nonsense']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Usage: coffer/);
});
