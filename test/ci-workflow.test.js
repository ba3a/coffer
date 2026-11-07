// Guards the continuous-integration setup that takes effect once coffer is its
// own repository: the workflow runs the tests on Linux and on Windows with the
// Node.js version named in `.nvmrc`, and the repository files it relies on
// exist. The workflow is checked for its structure because it cannot be run
// here; `actionlint` is a good extra check where it is installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const root = fileURLToPath(new URL('..', import.meta.url));
const workflowPath = join(root, '.github', 'workflows', 'ci.yml');
const workflowText = readFileSync(workflowPath, 'utf8');

/**
 * @typedef {object} Step
 * @property {string} [name]
 * @property {string} [uses]
 * @property {string} [run]
 * @property {Record<string, unknown>} [with]
 * @property {Record<string, unknown>} [env]
 * @property {string} [working-directory]
 */

/** @type {any} */
const workflow = parse(workflowText);
const job = workflow.jobs.test;
/** @type {Step[]} */
const steps = job.steps;

test('the workflow runs on every push and every pull request', () => {
  assert.deepEqual(Object.keys(workflow.on).sort(), ['pull_request', 'push']);
  // No branch or path filters: a null value means "all".
  assert.equal(workflow.on.push ?? null, null);
  assert.equal(workflow.on.pull_request ?? null, null);
});

test('the workflow only reads the repository', () => {
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.equal(job.permissions, undefined);
});

test('the job runs on Linux and on Windows, and one failure does not stop the other', () => {
  assert.deepEqual(job.strategy.matrix.os, ['ubuntu-latest', 'windows-latest']);
  assert.equal(job.strategy['fail-fast'], false);
  assert.equal(job['runs-on'], '${{ matrix.os }}');
});

test('the job has a time limit', () => {
  assert.equal(typeof job['timeout-minutes'], 'number');
  assert.ok(job['timeout-minutes'] > 0 && job['timeout-minutes'] <= 120);
});

test('a newer run of a pull request cancels the older one, a push never does', () => {
  assert.match(workflow.concurrency.group, /github\.event\.pull_request\.number/);
  assert.match(workflow.concurrency.group, /github\.run_id/);
  assert.equal(workflow.concurrency['cancel-in-progress'], "${{ github.event_name == 'pull_request' }}");
});

test('the steps check out, set up Node.js from .nvmrc with the npm cache, install, then test', () => {
  const uses = steps.map((step) => step.uses?.split('@')[0]);
  assert.deepEqual(uses, ['actions/checkout', 'actions/setup-node', undefined, undefined]);
  assert.deepEqual(steps[1].with, { 'node-version-file': '.nvmrc', cache: 'npm' });
  assert.equal(steps[2].run, 'npm ci');
  assert.equal(steps[3].run, 'npm test');
});

test('actions are pinned to a major version', () => {
  for (const step of steps.filter((s) => s.uses !== undefined)) {
    assert.match(step.uses ?? '', /^actions\/[a-z-]+@v[1-9]\d*$/, step.uses);
  }
});

test('the workflow treats the directory as the repository root and holds no secrets', () => {
  for (const step of steps) assert.equal(step['working-directory'], undefined);
  assert.equal(job.defaults, undefined);
  assert.doesNotMatch(workflowText, /secrets\./);
  assert.doesNotMatch(workflowText, /https?:\/\//);
});

test('the workflow file uses LF line endings', () => {
  assert.equal(workflowText.includes('\r'), false);
});

test('.nvmrc names a Node.js version the package supports', () => {
  const nvmrc = readFileSync(join(root, '.nvmrc'), 'utf8');
  assert.match(nvmrc, /^\d+(\.\d+){0,2}\n$/);
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const minimum = Number(/(\d+)/.exec(pkg.engines.node)?.[1]);
  assert.ok(Number(nvmrc.split('.')[0]) >= minimum, `${nvmrc.trim()} is older than engines.node ${pkg.engines.node}`);
});

test('.gitignore keeps dependencies, build output and caches out of the repository', () => {
  const rules = readFileSync(join(root, '.gitignore'), 'utf8').split(/\r?\n/);
  for (const rule of ['node_modules/', 'example/dist/', '.cache/', '.coffer/']) {
    assert.ok(rules.includes(rule), `${rule} is missing from .gitignore`);
  }
});

test('.gitattributes makes working trees LF on every system', () => {
  const lines = readFileSync(join(root, '.gitattributes'), 'utf8').split(/\r?\n/);
  assert.ok(lines.includes('* text=auto eol=lf'));
});

test('a fresh install resolves: nunjucks takes the chokidar the package depends on', () => {
  // nunjucks lists chokidar 3 as an optional peer, which makes `npm install`
  // without a lock file fail with ERESOLVE when the package depends on chokidar 5.
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.ok(pkg.dependencies.chokidar);
  assert.deepEqual(pkg.overrides, { nunjucks: { chokidar: '$chokidar' } });
});
