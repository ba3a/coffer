import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { run } from '../src/cli.js';
import { findExecutable } from '../src/docs/sources.js';
import { HOOK_NAMES, HOOKS_DIR_NAME, installHooks, isGeneratedHook, parsePushRefs, pushSendsRefs, readPushRefs, renderHook, runHook } from '../src/hooks.js';
import { envLocalWarning } from '../src/media/credentials.js';

/**
 * Every test here makes its own throw-away git repositories and sets only their
 * local configuration. Nothing touches the repository coffer is developed in,
 * its hooks or its configuration; nothing is pushed; no host is contacted; the
 * credentials are made up.
 */

const BIN = fileURLToPath(new URL('../bin/coffer.js', import.meta.url)).split('\\').join('/');
const GIT = findExecutable('git', process.env.PATH);

/**
 * The `sh` of Git for Windows, or the system's.
 *
 * @returns {string | null}
 */
function findSh() {
  if (process.platform !== 'win32') return findExecutable('sh', process.env.PATH);
  const onPath = findExecutable('sh', process.env.PATH);
  if (onPath !== null) return onPath;
  if (GIT === null) return null;
  const dir = dirname(GIT);
  for (const rel of [['..', 'usr', 'bin'], ['..', '..', 'usr', 'bin'], ['..', 'bin'], ['..', '..', 'bin']]) {
    const candidate = join(dir, ...rel, 'sh.exe');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const SH = findSh();
const NO_GIT = GIT === null ? 'git is not installed' : false;
const NO_SH = GIT === null ? 'git is not installed' : SH === null ? 'no POSIX sh was found (Git for Windows provides one)' : false;

/** @param {string} dir */
function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

/**
 * @param {string} text
 * @returns {string} The text with `\` as `/`, for a path in a shell.
 */
const slashes = (text) => text.split('\\').join('/');

/** @param {string} data */
const sha = (data) => createHash('sha256').update(data).digest('hex');

/** The environment of every git and sh call of the tests: no GIT_* variable, no user or system git configuration. */
let emptyConfig = '';
/**
 * @param {Record<string, string | undefined>} [extra]
 * @returns {Record<string, string>}
 */
function testEnv(extra = {}) {
  if (emptyConfig === '') {
    const dir = mkdtempSync(join(tmpdir(), 'coffer-hooks-env-'));
    emptyConfig = join(dir, 'gitconfig');
    writeFileSync(emptyConfig, '');
  }
  /** @type {Record<string, string>} */
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.toUpperCase().startsWith('GIT_') && !key.startsWith('COFFER')) env[key] = value;
  }
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH');
  const basePath = pathKey === undefined ? '' : env[pathKey];
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key];
  env.PATH = `${dirname(process.execPath)}${delimiter}${basePath}`;
  env.GIT_CONFIG_GLOBAL = emptyConfig;
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_TERMINAL_PROMPT = '0';
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

/**
 * Runs git in a throw-away folder.
 *
 * @param {string} cwd
 * @param {string[]} args
 * @param {Record<string, string | undefined>} [extraEnv]
 * @returns {{ status: number | null, stdout: string, stderr: string }}
 */
function git(cwd, args, extraEnv) {
  assert.ok(resolve(cwd).startsWith(resolve(tmpdir())), `${cwd} must be a temporary folder`);
  const result = spawnSync(/** @type {string} */ (GIT), args, { cwd, env: testEnv(extraEnv), encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * @param {string} cwd
 * @param {string[]} args
 * @param {Record<string, string | undefined>} [extraEnv]
 * @returns {string}
 */
function gitOk(cwd, args, extraEnv) {
  const result = git(cwd, args, extraEnv);
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}${result.stdout}`);
  return result.stdout;
}

const FS_CONFIG = `sites:
  - { id: s, baseUrl: "https://example.org", title: T, contentDir: content }
media:
  store: { type: fs, dir: ../store }
`;

const S3_CONFIG = `sites:
  - { id: s, baseUrl: "https://example.org", title: T, contentDir: content }
media:
  store: { type: s3, endpoint: "https://abc.example.com", bucket: my-media }
`;

const NO_MEDIA_CONFIG = 'sites:\n  - { id: s, baseUrl: "https://example.org", title: T, contentDir: content }\n';

/**
 * A working copy: a git repository in `{root}/{name}` with a configuration and a content folder.
 *
 * @param {{ config?: string | null, name?: string, root?: string, init?: boolean }} [options]
 */
function workingCopy({ config = FS_CONFIG, name = 'a', root = mkdtempSync(join(tmpdir(), 'coffer-hooks-')), init = true } = {}) {
  const repo = join(root, name);
  mkdirSync(join(repo, 'content', 'p'), { recursive: true });
  if (init) {
    gitOk(repo, ['init', '-q', '-b', 'main']);
    gitOk(repo, ['config', '--local', 'user.name', 'Test']);
    gitOk(repo, ['config', '--local', 'user.email', 'test@example.invalid']);
    gitOk(repo, ['config', '--local', 'commit.gpgsign', 'false']);
  }
  if (config !== null) writeFileSync(join(repo, 'coffer.yaml'), config);
  return { root, repo, store: join(root, 'store') };
}

/**
 * @param {string} repo
 * @param {string} rel
 * @param {string} content
 */
function photo(repo, rel, content) {
  const file = join(repo, ...rel.split('/'));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  const past = new Date(Date.now() - 60_000);
  utimesSync(file, past, past);
}

/**
 * @returns {{ io: import('../src/cli.js').Io, out: () => string, err: () => string }}
 */
function capture() {
  let out = '';
  let err = '';
  return { io: { out: (text) => (out += text), err: (text) => (err += text) }, out: () => out, err: () => err };
}

const PHOTO = 'content/p/IMG_0001.jpg';

// ---------------------------------------------------------------------------
// The scripts

test('every hook script is POSIX sh with LF line ends, quoted, strict and free of bashisms', () => {
  for (const name of HOOK_NAMES) {
    const text = renderHook(name);
    assert.ok(!text.includes('\r'), `${name}: LF only`);
    assert.ok(text.startsWith(`#!/bin/sh\n# coffer-hook: ${name} version 1\n`), name);
    assert.ok(text.endsWith('\n') && !text.endsWith('\n\n'), `${name}: one final newline`);
    assert.ok(isGeneratedHook(text));
    assert.match(text, /^set -eu$/m);
    assert.match(text, /^root=\$\(git rev-parse --show-toplevel/m, 'runs from the root of the repository');
    assert.match(text, /COFFER_SKIP_HOOKS/);
    assert.match(text, /"\$program" hooks run "\$hook"/);
    // No bashisms.
    for (const bashism of [/\[\[/, /\]\]/, /\bfunction\s+\w+/, /\blocal\s/, /\$'/, /==/, /<\(/, /\bsource\s/, /\becho\s+-e/, /\$\{[^}]*[,^]{1,2}\}/, /\$RANDOM/, /&>/, /\bdeclare\b/, /\barray\b/]) {
      assert.ok(!bashism.test(text), `${name}: ${bashism}`);
    }
    // Never forced, never destructive.
    assert.ok(!/--force|\brm\b|--global|--system/.test(text), name);
  }
  assert.match(renderHook('pre-commit'), /exit "\$status"\n$/);
  assert.match(renderHook('pre-push'), /exit "\$status"\n$/);
  for (const name of ['post-checkout', 'post-merge', 'post-rewrite']) {
    assert.match(renderHook(name), /\nexit 0\n$/);
    assert.match(renderHook(name), /^blocking=0$/m);
  }
  assert.match(renderHook('pre-push'), /^blocking=1$/m);
  assert.match(renderHook('pre-push'), /git push --no-verify/);
  assert.match(renderHook('post-checkout'), /\[ "\$\{3:-\}" = '1' \] \|\| exit 0/);
  assert.ok(!renderHook('post-merge').includes('${3'));
  assert.throws(() => renderHook('pre-rebase'), /there is no hook/);
});

test('a configuration path is written into the scripts in single quotes', () => {
  assert.match(renderHook('pre-commit', { config: 'sites/coffer.yaml' }), /^config='sites\/coffer\.yaml'$/m);
  assert.match(renderHook('pre-commit', { config: "it's here.yaml" }), /^config='it'\\''s here\.yaml'$/m);
  assert.match(renderHook('pre-commit'), /^config=''$/m);
});

test('every generated script passes the syntax check of sh', { skip: NO_SH }, () => {
  for (const name of HOOK_NAMES) {
    for (const config of [undefined, "a b/it's.yaml"]) {
      const result = spawnSync(/** @type {string} */ (SH), ['-n'], { input: renderHook(name, { config }), encoding: 'utf8' });
      assert.equal(result.status, 0, `${name}: ${result.stderr}`);
    }
  }
});

// ---------------------------------------------------------------------------
// install, uninstall, status

test('install writes the five scripts with LF and the executable bit and sets core.hooksPath locally', { skip: NO_GIT }, async () => {
  const w = workingCopy();
  try {
    const result = await installHooks({ cwd: w.repo });
    assert.deepEqual(result.files.map((file) => `${file.name}:${file.action}`), HOOK_NAMES.map((name) => `${name}:written`));
    assert.equal(result.hooksPath, 'set');
    assert.deepEqual(readdirSync(join(w.repo, HOOKS_DIR_NAME)).sort(), [...HOOK_NAMES].sort());
    for (const name of HOOK_NAMES) {
      const file = join(w.repo, HOOKS_DIR_NAME, name);
      const bytes = readFileSync(file);
      assert.ok(!bytes.includes(13), `${name}: no CR`);
      assert.equal(bytes.toString('utf8'), renderHook(name));
      if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o755, name);
    }
    assert.equal(gitOk(w.repo, ['config', '--local', '--get', 'core.hooksPath']).trim(), HOOKS_DIR_NAME);
    // Only the local configuration was written.
    assert.equal(git(w.repo, ['config', '--global', '--get', 'core.hooksPath']).status, 1);
    assert.equal(git(w.repo, ['config', '--system', '--get', 'core.hooksPath']).status, 1);
    assert.match(readFileSync(join(w.repo, '.git', 'config'), 'utf8'), /hooksPath = \.coffer-hooks/);

    // Idempotent: a second run changes nothing.
    const again = await installHooks({ cwd: w.repo });
    assert.deepEqual(again.files.map((file) => file.action), HOOK_NAMES.map(() => 'unchanged'));
    assert.equal(again.hooksPath, 'unchanged');
  } finally {
    cleanup(w.root);
  }
});

test('install marks hooks that git tracks as executable in the index, which a file system without modes cannot hold', { skip: NO_GIT }, async () => {
  const w = workingCopy();
  try {
    await installHooks({ cwd: w.repo });
    gitOk(w.repo, ['add', '--', HOOKS_DIR_NAME]);
    // On Windows the files go in as 100644; on Linux as 100755 already.
    const result = await installHooks({ cwd: w.repo });
    const listed = gitOk(w.repo, ['ls-files', '-s', '--', HOOKS_DIR_NAME]);
    for (const name of HOOK_NAMES) assert.match(listed, new RegExp(`^100755 [0-9a-f]+ 0\\t${HOOKS_DIR_NAME}/${name}$`, 'm'), name);
    assert.equal(result.hooksPath, 'unchanged');
    if (process.platform === 'win32') assert.equal(result.modeFixed.length, HOOK_NAMES.length);
  } finally {
    cleanup(w.root);
  }
});

test('install replaces an older generated script but not a hooksPath or a hook that is not coffer\'s, unless forced', { skip: NO_GIT }, async () => {
  const w = workingCopy();
  try {
    // An older version of a generated script is brought up to date.
    mkdirSync(join(w.repo, HOOKS_DIR_NAME));
    writeFileSync(join(w.repo, HOOKS_DIR_NAME, 'pre-push'), '#!/bin/sh\n# coffer-hook: pre-push version 0\necho old\n');
    const first = await installHooks({ cwd: w.repo });
    assert.equal(first.files.find((file) => file.name === 'pre-push')?.action, 'updated');

    // A hook somebody wrote: nothing is touched, not even the files that were free.
    cleanup(join(w.repo, HOOKS_DIR_NAME));
    mkdirSync(join(w.repo, HOOKS_DIR_NAME));
    writeFileSync(join(w.repo, HOOKS_DIR_NAME, 'post-merge'), '#!/bin/sh\necho mine\n');
    gitOk(w.repo, ['config', '--local', '--unset', 'core.hooksPath']);
    await assert.rejects(installHooks({ cwd: w.repo }), (error) => {
      assert.match(/** @type {Error} */ (error).message, /\.coffer-hooks\/post-merge exists and was not generated by coffer, so it is not overwritten/);
      assert.match(/** @type {Error} */ (error).message, /Nothing was changed/);
      return true;
    });
    assert.deepEqual(readdirSync(join(w.repo, HOOKS_DIR_NAME)), ['post-merge']);
    assert.equal(git(w.repo, ['config', '--local', '--get', 'core.hooksPath']).status, 1);
    const forced = await installHooks({ cwd: w.repo, force: true });
    assert.equal(forced.files.find((file) => file.name === 'post-merge')?.action, 'updated');
    assert.ok(isGeneratedHook(readFileSync(join(w.repo, HOOKS_DIR_NAME, 'post-merge'), 'utf8')));

    // Another core.hooksPath is not replaced silently.
    gitOk(w.repo, ['config', '--local', 'core.hooksPath', '.husky']);
    await assert.rejects(installHooks({ cwd: w.repo }), /core\.hooksPath of this repository is already ".husky"[\s\S]*Nothing was changed/);
    assert.equal(gitOk(w.repo, ['config', '--local', '--get', 'core.hooksPath']).trim(), '.husky');
    const replaced = await installHooks({ cwd: w.repo, force: true });
    assert.equal(replaced.hooksPath, 'replaced');
    assert.equal(replaced.previousHooksPath, '.husky');
    assert.equal(gitOk(w.repo, ['config', '--local', '--get', 'core.hooksPath']).trim(), '.coffer-hooks');

    // "./.coffer-hooks/" is the same place.
    gitOk(w.repo, ['config', '--local', 'core.hooksPath', './.coffer-hooks/']);
    assert.equal((await installHooks({ cwd: w.repo })).hooksPath, 'unchanged');
  } finally {
    cleanup(w.root);
  }
});

test('install warns about hooks in .git/hooks that stop running', { skip: NO_GIT }, async () => {
  const w = workingCopy();
  try {
    writeFileSync(join(w.repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 0\n');
    const result = await installHooks({ cwd: w.repo });
    assert.match(result.warnings.join('\n'), /hooks in \.git\/hooks \(pre-commit\) no longer run/);
  } finally {
    cleanup(w.root);
  }
});

test('install outside a repository fails clearly and writes nothing', { skip: NO_GIT }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'coffer-hooks-nogit-'));
  try {
    if (git(dir, ['rev-parse', '--show-toplevel']).status === 0) {
      t.skip('the temporary folder is inside a git repository');
      return;
    }
    await assert.rejects(installHooks({ cwd: dir }), /is not inside a git repository/);
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    cleanup(dir);
  }
});

test('install --config puts the path of the configuration into the scripts, if it is a file in the repository', { skip: NO_GIT }, async () => {
  const w = workingCopy({ config: null });
  try {
    mkdirSync(join(w.repo, 'sites'));
    writeFileSync(join(w.repo, 'sites', 'coffer.yaml'), FS_CONFIG);
    const outside = join(w.root, 'other.yaml');
    writeFileSync(outside, FS_CONFIG);
    await assert.rejects(installHooks({ cwd: w.repo, config: 'missing.yaml' }), /file not found/);
    await assert.rejects(installHooks({ cwd: w.repo, config: outside }), /must be inside the repository/);
    assert.equal(existsSync(join(w.repo, HOOKS_DIR_NAME)), false);
    await installHooks({ cwd: w.repo, config: 'sites/coffer.yaml' });
    assert.match(readFileSync(join(w.repo, HOOKS_DIR_NAME, 'pre-commit'), 'utf8'), /^config='sites\/coffer\.yaml'$/m);
    // Installing again without it takes it out again, and status notices a stale script.
    const status = capture();
    assert.equal(await run(['hooks', 'status'], status.io, { hooks: { cwd: w.repo } }), 0, status.err());
  } finally {
    cleanup(w.root);
  }
});

test('hooks install, status and uninstall through the command line', { skip: NO_GIT }, async () => {
  const w = workingCopy();
  try {
    const services = { hooks: { cwd: w.repo }, env: testEnv() };
    let c = capture();
    assert.equal(await run(['hooks', 'status'], c.io, services), 1);
    assert.match(c.err(), /core\.hooksPath: not set[\s\S]*pre-commit: missing/);

    c = capture();
    assert.equal(await run(['hooks', 'install'], c.io, services), 0, c.err());
    assert.match(c.out(), /pre-commit: written[\s\S]*post-rewrite: written\ncore\.hooksPath set to \.coffer-hooks in the configuration of this repository\./);

    c = capture();
    assert.equal(await run(['hooks', 'install'], c.io, services), 0);
    assert.match(c.out(), /pre-commit: unchanged[\s\S]*core\.hooksPath is already \.coffer-hooks\./);

    c = capture();
    assert.equal(await run(['hooks', 'status'], c.io, services), 0, c.err());
    assert.match(c.out(), /core\.hooksPath: \.coffer-hooks\npre-commit: installed/);

    writeFileSync(join(w.repo, HOOKS_DIR_NAME, 'post-merge'), '#!/bin/sh\necho mine\n');
    writeFileSync(join(w.repo, HOOKS_DIR_NAME, 'pre-push'), renderHook('pre-push').replace('version 1', 'version 0'));
    c = capture();
    assert.equal(await run(['hooks', 'status'], c.io, services), 1);
    assert.match(c.err(), /pre-push: outdated[\s\S]*post-merge: not generated by coffer/);

    c = capture();
    assert.equal(await run(['hooks', 'uninstall'], c.io, services), 0, c.err());
    assert.match(c.out(), /removed \.coffer-hooks\/pre-commit/);
    assert.match(c.out(), /kept \.coffer-hooks\/post-merge: it was not generated by coffer/);
    assert.match(c.out(), /core\.hooksPath unset/);
    assert.deepEqual(readdirSync(join(w.repo, HOOKS_DIR_NAME)), ['post-merge']);
    assert.equal(git(w.repo, ['config', '--local', '--get', 'core.hooksPath']).status, 1);
  } finally {
    cleanup(w.root);
  }
});

test('hooks usage errors exit 2', async () => {
  /** @param {string[]} args */
  const call = async (args) => {
    const c = capture();
    return { code: await run(['hooks', ...args], c.io, {}), err: c.err() };
  };
  assert.deepEqual(await call([]), { code: 2, err: 'coffer: hooks needs a subcommand (install, uninstall, status, run)\n' });
  assert.match((await call(['sync'])).err, /unknown hooks subcommand "sync"/);
  assert.equal((await call(['sync'])).code, 2);
  assert.match((await call(['install', '--bogus'])).err, /unexpected argument "--bogus" for "hooks install"/);
  assert.equal((await call(['install', '--bogus'])).code, 2);
  assert.equal((await call(['status', '--force'])).code, 2);
  assert.equal((await call(['uninstall', '--config', 'x'])).code, 2);
  const flaglike = await call(['install', '--config', '--force']);
  assert.equal(flaglike.code, 2);
  assert.match(flaglike.err, /--config needs a path, but "--force" looks like an option/);
  assert.equal((await call(['install', '--config'])).code, 2);
  assert.match((await call(['run'])).err, /hooks run needs the name of a hook/);
  assert.match((await call(['run', 'pre-rebase'])).err, /unknown hook "pre-rebase"/);
  assert.equal((await call(['run', 'pre-rebase'])).code, 2);
});

// ---------------------------------------------------------------------------
// What the hooks do (the code the scripts call)

/**
 * @param {string} cwd
 * @param {Record<string, string | undefined>} [extraEnv]
 */
function hookOptions(cwd, extraEnv) {
  return { cwd, env: testEnv(extraEnv) };
}

test('pre-commit refreshes the lock file and stages it', { skip: NO_GIT }, async () => {
  const w = workingCopy();
  try {
    photo(w.repo, PHOTO, 'photo one');
    const c = capture();
    assert.equal(await runHook('pre-commit', c.io, hookOptions(w.repo)), 0, c.err());
    assert.match(c.out(), /media\.lock\.json: 1 original\(s\), 1 added/);
    const lock = readFileSync(join(w.repo, 'media.lock.json'), 'utf8');
    assert.ok(lock.includes(sha('photo one')));
    assert.equal(gitOk(w.repo, ['diff', '--cached', '--name-only']).trim(), 'media.lock.json');
    // The original itself is not staged by the hook (it is the user's, and gitignored in real use).
    assert.ok(!gitOk(w.repo, ['diff', '--cached', '--name-only']).includes('IMG_0001'));

    // Nothing changed: nothing to say, and still fine.
    const second = capture();
    assert.equal(await runHook('pre-commit', second.io, hookOptions(w.repo)), 0);
    assert.equal(second.out(), '');

    // A second photo is picked up the next time.
    photo(w.repo, 'content/p/IMG_0002.jpg', 'photo two');
    assert.equal(await runHook('pre-commit', capture().io, hookOptions(w.repo)), 0);
    assert.ok(readFileSync(join(w.repo, 'media.lock.json'), 'utf8').includes(sha('photo two')));
  } finally {
    cleanup(w.root);
  }
});

test('hooks do nothing when there is no configuration or no media block, and complain when a named configuration is missing', { skip: NO_GIT }, async () => {
  const none = workingCopy({ config: null });
  const plain = workingCopy({ config: NO_MEDIA_CONFIG });
  try {
    for (const w of [none, plain]) {
      photo(w.repo, PHOTO, 'photo');
      for (const name of HOOK_NAMES) {
        const c = capture();
        assert.equal(await runHook(name, c.io, hookOptions(w.repo)), 0, name);
        assert.equal(c.out() + c.err(), '', name);
      }
      assert.equal(existsSync(join(w.repo, 'media.lock.json')), false);
      assert.equal(existsSync(join(w.repo, '.coffer')), false);
    }
    const named = capture();
    assert.equal(await runHook('pre-commit', named.io, { ...hookOptions(none.repo), configPath: 'nowhere.yaml' }), 1);
    assert.match(named.err(), /nowhere\.yaml: file not found/);
    const post = capture();
    assert.equal(await runHook('post-merge', post.io, { ...hookOptions(none.repo), configPath: 'nowhere.yaml' }), 0, 'a post hook never fails');
  } finally {
    cleanup(none.root);
    cleanup(plain.root);
  }
});

test('pre-commit fails, saying why, when the lock file cannot be staged', { skip: NO_GIT }, async () => {
  const w = workingCopy();
  try {
    photo(w.repo, PHOTO, 'photo');
    writeFileSync(join(w.repo, '.gitignore'), 'media.lock.json\n');
    const c = capture();
    assert.equal(await runHook('pre-commit', c.io, hookOptions(w.repo)), 1);
    assert.match(c.err(), /the lock file media\.lock\.json could not be added to the commit/);
    assert.match(c.err(), /must be committed/);
  } finally {
    cleanup(w.root);
  }
});

test('pre-push uploads what the store lacks, and stops the push when it cannot', { skip: NO_GIT }, async () => {
  const w = workingCopy();
  try {
    photo(w.repo, PHOTO, 'photo one');
    assert.equal(await runHook('pre-commit', capture().io, hookOptions(w.repo)), 0);
    const c = capture();
    assert.equal(await runHook('pre-push', c.io, hookOptions(w.repo)), 0, c.err());
    assert.match(c.out(), /1 object\(s\) uploaded/);
    assert.ok(existsSync(join(w.store, 'originals', sha('photo one'))));
    // Nothing more to upload: quiet.
    const again = capture();
    assert.equal(await runHook('pre-push', again.io, hookOptions(w.repo)), 0);
    assert.equal(again.out(), '');

    // A file changed after locking cannot be uploaded: exit 1 (git aborts the push).
    photo(w.repo, 'content/p/IMG_0002.jpg', 'photo two');
    assert.equal(await runHook('pre-commit', capture().io, hookOptions(w.repo)), 0);
    photo(w.repo, 'content/p/IMG_0002.jpg', 'photo two, edited since');
    const failing = capture();
    assert.equal(await runHook('pre-push', failing.io, hookOptions(w.repo)), 1);
    assert.match(failing.err(), /IMG_0002\.jpg: the store lacks its content/);

    // No lock file: nothing to push.
    const bare = workingCopy();
    try {
      const quiet = capture();
      assert.equal(await runHook('pre-push', quiet.io, hookOptions(bare.repo)), 0);
      assert.equal(quiet.err(), '');
    } finally {
      cleanup(bare.root);
    }
  } finally {
    cleanup(w.root);
  }
});

test('pre-push without credentials fails once with the actionable message; pre-commit does not need them', { skip: NO_GIT }, async () => {
  const w = workingCopy({ config: S3_CONFIG });
  try {
    photo(w.repo, PHOTO, 'photo');
    assert.equal(await runHook('pre-commit', capture().io, hookOptions(w.repo)), 0);
    const c = capture();
    assert.equal(await runHook('pre-push', c.io, hookOptions(w.repo)), 1);
    assert.equal(c.out(), '');
    assert.match(c.err(), /^coffer: the media store "my-media" cannot be used/);
    assert.match(c.err(), /COFFER_MEDIA_ACCESS_KEY_ID=your-access-key-id/);
    assert.equal(c.err().match(/not set/g)?.length, 1);
  } finally {
    cleanup(w.root);
  }
});

test('post-checkout, post-merge and post-rewrite fetch missing originals and never fail the git operation', { skip: NO_GIT }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'coffer-hooks-'));
  const a = workingCopy({ root, name: 'a' });
  const b = workingCopy({ root, name: 'b' });
  try {
    photo(a.repo, PHOTO, 'photo one');
    assert.equal(await runHook('pre-commit', capture().io, hookOptions(a.repo)), 0);
    assert.equal(await runHook('pre-push', capture().io, hookOptions(a.repo)), 0);

    for (const name of ['post-checkout', 'post-merge', 'post-rewrite']) {
      // The other working copy receives the lock file, as a merge would deliver it.
      cleanup(join(b.repo, 'content'));
      mkdirSync(join(b.repo, 'content', 'p'), { recursive: true });
      cleanup(join(b.repo, '.coffer'));
      writeFileSync(join(b.repo, 'media.lock.json'), readFileSync(join(a.repo, 'media.lock.json')));
      const c = capture();
      assert.equal(await runHook(name, c.io, hookOptions(b.repo)), 0, `${name}: ${c.err()}`);
      assert.match(c.out(), /downloaded content\/p\/IMG_0001\.jpg/, name);
      assert.equal(readFileSync(join(b.repo, ...PHOTO.split('/')), 'utf8'), 'photo one', name);
    }

    // Quiet when everything is in place.
    const quiet = capture();
    assert.equal(await runHook('post-merge', quiet.io, hookOptions(b.repo)), 0);
    assert.equal(quiet.out() + quiet.err(), '');

    // A local file that differs from the lock and was never synced is a conflict: reported, kept, and the hook still succeeds.
    photo(b.repo, PHOTO, 'my own edit');
    writeFileSync(join(b.repo, 'media.lock.json'), readFileSync(join(a.repo, 'media.lock.json')));
    cleanup(join(b.repo, '.coffer'));
    const conflict = capture();
    assert.equal(await runHook('post-checkout', conflict.io, hookOptions(b.repo)), 0);
    assert.match(conflict.err(), /conflict content\/p\/IMG_0001\.jpg/);
    assert.equal(readFileSync(join(b.repo, ...PHOTO.split('/')), 'utf8'), 'my own edit', 'nothing was overwritten');
  } finally {
    cleanup(root);
  }
});

const ZERO = '0'.repeat(40);
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
/** A line git writes to pre-push: a branch is created or updated. */
const BRANCH_LINE = `refs/heads/main ${SHA_A} refs/heads/main ${SHA_B}\n`;
/** A new tag. */
const TAG_LINE = `refs/tags/v1 ${SHA_A} refs/tags/v1 ${ZERO}\n`;
/** git push origin --delete topic */
const DELETE_BRANCH_LINE = `(delete) ${ZERO} refs/heads/topic ${SHA_B}\n`;
/** git push origin --delete v1 */
const DELETE_TAG_LINE = `(delete) ${ZERO} refs/tags/v1 ${SHA_B}\n`;
const EMPTY_LOCK = '{"version":1,"files":[\n]}\n';

/** @param {string} text */
const validRefs = (text) => {
  const refs = parsePushRefs(text);
  assert.ok(refs, 'the lines are understood');
  return refs;
};

test('the refs git sends to pre-push are read, and only a push that creates or updates a ref sends anything', () => {
  assert.deepEqual(parsePushRefs(BRANCH_LINE), [{ localRef: 'refs/heads/main', localSha: SHA_A, remoteRef: 'refs/heads/main', remoteSha: SHA_B }]);
  assert.deepEqual(parsePushRefs(''), []);
  assert.deepEqual(parsePushRefs('\n   \r\n\n'), [], 'blank lines are nothing');
  assert.equal(parsePushRefs(`${BRANCH_LINE.trimEnd()}\r\n${DELETE_BRANCH_LINE}`)?.length, 2, 'CRLF is fine');
  assert.equal(parsePushRefs(`${DELETE_BRANCH_LINE.trimEnd()}\r\n`)?.length, 1, 'CRLF-terminated line');
  assert.equal(parsePushRefs(DELETE_BRANCH_LINE.trimEnd())?.length, 1, 'no trailing newline');
  // Input that cannot be understood is "unknown", never "nothing".
  for (const bad of [
    'not four fields\n\n   \r\n',
    'garbage\n',
    `${BRANCH_LINE.trimEnd()} extra\n`,
    `refs/heads/a ${SHA_A} refs/heads/a ${ZERO} extra\n`,
    DELETE_BRANCH_LINE + 'garbage\n',
    `refs/heads/a ${'g'.repeat(40)} refs/heads/a ${ZERO}\n`,
    `refs/heads/a ${SHA_A} refs/heads/a ${'0'.repeat(64)}\n`,
  ]) {
    assert.equal(parsePushRefs(bad), undefined, JSON.stringify(bad));
  }

  assert.equal(pushSendsRefs(validRefs(BRANCH_LINE)), true);
  assert.equal(pushSendsRefs(validRefs(TAG_LINE)), true, 'a new tag can point at commits whose originals are not uploaded');
  assert.equal(pushSendsRefs(validRefs(DELETE_BRANCH_LINE)), false);
  assert.equal(pushSendsRefs(validRefs(DELETE_BRANCH_LINE + DELETE_TAG_LINE)), false);
  assert.equal(pushSendsRefs(validRefs(DELETE_BRANCH_LINE + BRANCH_LINE)), true, 'one branch among deletions is enough');
  assert.equal(pushSendsRefs([]), false, 'no refs: nothing is pushed');
  // A repository that uses SHA-256 object names.
  assert.equal(pushSendsRefs(validRefs(`(delete) ${'0'.repeat(64)} refs/heads/x ${'b'.repeat(64)}\n`)), false);
});

test('readPushRefs reads the standard input, and gives up on a terminal or a stream that stays silent', async () => {
  const { PassThrough } = await import('node:stream');
  const piped = new PassThrough();
  const reading = readPushRefs(piped);
  piped.write(BRANCH_LINE.slice(0, 10));
  piped.end(BRANCH_LINE.slice(10) + DELETE_TAG_LINE);
  assert.equal((await reading)?.length, 2);

  const garbled = new PassThrough();
  const garbledReading = readPushRefs(garbled);
  garbled.end('garbage\n');
  assert.equal(await garbledReading, undefined, 'lines that cannot be understood are unknown');

  const terminal = Object.assign(new PassThrough(), { isTTY: true });
  assert.equal(await readPushRefs(terminal), undefined, 'a terminal is not read (it would wait for the person)');

  const silent = new PassThrough();
  assert.equal(await readPushRefs(silent, 20), undefined, 'a stream that never ends is given up on');
  silent.destroy();
});

test('pre-push needs no credentials and no store for a push that only deletes refs', { skip: NO_GIT }, async () => {
  const w = workingCopy({ config: S3_CONFIG });
  try {
    photo(w.repo, PHOTO, 'photo');
    assert.equal(await runHook('pre-commit', capture().io, hookOptions(w.repo)), 0);
    /** @param {string | undefined} lines */
    const push = async (lines) => {
      const c = capture();
      const code = await runHook('pre-push', c.io, { ...hookOptions(w.repo), pushRefs: lines === undefined ? undefined : parsePushRefs(lines) });
      return { code, out: c.out(), err: c.err() };
    };
    const deleteWithCrlf = `${DELETE_BRANCH_LINE.trimEnd()}\r\n`;
    const deleteNoNewline = DELETE_TAG_LINE.trimEnd();
    for (const lines of [DELETE_BRANCH_LINE, DELETE_TAG_LINE, DELETE_BRANCH_LINE + DELETE_TAG_LINE, deleteWithCrlf, deleteNoNewline, '', '\n\r\n']) {
      assert.deepEqual(await push(lines), { code: 0, out: '', err: '' }, JSON.stringify(lines));
    }
    // Creating or updating a branch or a tag is checked: without credentials it stops with the one actionable message.
    // So is a push that cannot be read: garbage, a line with five fields, or a deletion next to a line that cannot be understood.
    const garbageLines = [
      'garbage\n',
      `refs/heads/a ${SHA_A} refs/heads/a ${ZERO} extra\n`,
      DELETE_BRANCH_LINE + 'garbage\n',
      DELETE_BRANCH_LINE + `refs/heads/a ${SHA_A} refs/heads/a ${ZERO} extra\n`,
    ];
    for (const lines of [BRANCH_LINE, TAG_LINE, DELETE_BRANCH_LINE + BRANCH_LINE, undefined, ...garbageLines]) {
      const result = await push(lines);
      assert.equal(result.code, 1, JSON.stringify(lines));
      assert.equal(result.out, '');
      assert.match(result.err, /^coffer: the media store "my-media" cannot be used/);
      assert.equal(result.err.match(/not set/g)?.length, 1);
    }
  } finally {
    cleanup(w.root);
  }
});

test('pre-push and push need no store, so no credentials, when there is no lock file or the lock lists nothing', { skip: NO_GIT }, async () => {
  const w = workingCopy({ config: S3_CONFIG });
  try {
    for (const pushRefs of [undefined, parsePushRefs(BRANCH_LINE)]) {
      const c = capture();
      assert.equal(await runHook('pre-push', c.io, { ...hookOptions(w.repo), pushRefs }), 0, 'no lock file');
      assert.deepEqual([c.out(), c.err()], ['', '']);
    }
    writeFileSync(join(w.repo, 'media.lock.json'), EMPTY_LOCK);
    const c = capture();
    assert.equal(await runHook('pre-push', c.io, { ...hookOptions(w.repo), pushRefs: parsePushRefs(BRANCH_LINE) }), 0, 'empty lock');
    assert.deepEqual([c.out(), c.err()], ['', '']);
    // The post hooks are not changed by this: they still say what they skip.
    assert.equal(await runHook('post-merge', capture().io, hookOptions(w.repo)), 0);
  } finally {
    cleanup(w.root);
  }
});

test('a .env.local that git tracks or does not ignore is warned about; every other case is silent', { skip: NO_GIT }, async () => {
  const w = workingCopy();
  const outside = mkdtempSync(join(tmpdir(), 'coffer-hooks-outside-'));
  try {
    const env = testEnv();
    assert.equal(await envLocalWarning(w.repo, env), null, 'no file');

    writeFileSync(join(w.repo, '.env.local'), 'SOMETHING=1\n');
    assert.match(/** @type {string} */ (await envLocalWarning(w.repo, env)), /^\.env\.local is not ignored by git/);

    writeFileSync(join(w.repo, '.gitignore'), '.env.local\n');
    assert.equal(await envLocalWarning(w.repo, env), null, 'ignored');

    gitOk(w.repo, ['add', '-f', '.env.local']);
    assert.match(/** @type {string} */ (await envLocalWarning(w.repo, env)), /^\.env\.local is tracked by git/);
    gitOk(w.repo, ['rm', '-q', '--cached', '.env.local']);
    assert.equal(await envLocalWarning(w.repo, env), null, 'untracked again');

    // GIT_* variables of the caller (a hook runs with GIT_DIR set) cannot point the check at another repository.
    writeFileSync(join(w.repo, '.gitignore'), '');
    assert.match(/** @type {string} */ (await envLocalWarning(w.repo, { ...env, GIT_DIR: join(outside, 'nowhere') })), /not ignored by git/);

    // Not in a repository, or git not available: no word.
    writeFileSync(join(outside, '.env.local'), 'SOMETHING=1\n');
    assert.equal(await envLocalWarning(outside, env), null, 'not a repository');
    assert.equal(await envLocalWarning(w.repo, { ...env, PATH: '' }), null, 'no git');
  } finally {
    cleanup(w.root);
    cleanup(outside);
  }
});

test('a hook that reads .env.local warns once, on the error channel, when it is not ignored', { skip: NO_GIT }, async () => {
  const w = workingCopy({ config: S3_CONFIG });
  try {
    writeFileSync(join(w.repo, '.env.local'), 'UNRELATED=1\n');
    const c = capture();
    assert.equal(await runHook('post-merge', c.io, hookOptions(w.repo)), 0);
    assert.equal(c.out(), '');
    assert.equal(c.err().match(/warning: \.env\.local is not ignored by git/g)?.length, 1);
    assert.match(c.err(), /coffer: warning: \.env\.local is not ignored by git/);
    assert.match(c.err(), /the media originals were not fetched: no credentials/);

    writeFileSync(join(w.repo, '.gitignore'), '.env.local\n');
    const quiet = capture();
    assert.equal(await runHook('post-merge', quiet.io, hookOptions(w.repo)), 0);
    assert.doesNotMatch(quiet.err(), /warning/);
  } finally {
    cleanup(w.root);
  }
});

test('install warns when there is no coffer.yaml for the hooks to find, unless --config names one', { skip: NO_GIT }, async () => {
  const w = workingCopy({ config: null });
  try {
    const result = await installHooks({ cwd: w.repo });
    assert.equal(result.warnings.filter((warning) => /no coffer\.yaml/.test(warning)).length, 1);
    assert.match(result.warnings.join('\n'), /--config <path to coffer\.yaml>/);
    const c = capture();
    assert.equal(await run(['hooks', 'install'], c.io, { env: testEnv(), hooks: { cwd: w.repo } }), 0);
    assert.match(c.out(), /warning: there is no coffer\.yaml in the root of this repository/);

    mkdirSync(join(w.repo, 'sites'));
    writeFileSync(join(w.repo, 'sites', 'coffer.yaml'), FS_CONFIG);
    const named = await installHooks({ cwd: w.repo, config: 'sites/coffer.yaml' });
    assert.ok(!named.warnings.some((warning) => /no coffer\.yaml/.test(warning)));

    writeFileSync(join(w.repo, 'coffer.yaml'), FS_CONFIG);
    const found = await installHooks({ cwd: w.repo });
    assert.ok(!found.warnings.some((warning) => /no coffer\.yaml/.test(warning)));
  } finally {
    cleanup(w.root);
  }
});

test('the post hooks skip with one notice when there are no credentials', { skip: NO_GIT }, async () => {
  const w = workingCopy({ config: S3_CONFIG });
  try {
    photo(w.repo, PHOTO, 'photo');
    assert.equal(await runHook('pre-commit', capture().io, hookOptions(w.repo)), 0);
    for (const name of ['post-checkout', 'post-merge', 'post-rewrite']) {
      const c = capture();
      assert.equal(await runHook(name, c.io, hookOptions(w.repo)), 0, name);
      assert.equal(c.out(), '');
      assert.equal(c.err().split('\n').filter((line) => line !== '').length, 1, 'one line');
      assert.match(c.err(), /the media originals were not fetched: no credentials for the media store \(missing: COFFER_MEDIA_ACCESS_KEY_ID, COFFER_MEDIA_SECRET_ACCESS_KEY\)/);
      assert.match(c.err(), /\.env\.local/);
    }
    assert.equal(readFileSync(join(w.repo, ...PHOTO.split('/')), 'utf8'), 'photo');
  } finally {
    cleanup(w.root);
  }
});

// ---------------------------------------------------------------------------
// The scripts, run with a shell and a stand-in for coffer

/**
 * A stand-in for the coffer program: it records its arguments and exits with
 * the status the test asks for.
 *
 * @param {string} dir
 * @returns {string} Its path, with `/`.
 */
function writeStub(dir) {
  const file = join(dir, 'stub-coffer');
  writeFileSync(file, '#!/bin/sh\nprintf \'%s\\n\' "$@" >> "$STUB_LOG"\nprintf -- \'--end--\\n\' >> "$STUB_LOG"\nif [ -n "${STUB_STDIN:-}" ]; then cat > "$STUB_STDIN"; fi\nexit "${STUB_EXIT:-0}"\n');
  chmodSync(file, 0o755);
  return slashes(file);
}

/**
 * Runs a generated script with sh, in a repository.
 *
 * @param {string} repo
 * @param {string} name
 * @param {string[]} args
 * @param {Record<string, string | undefined>} env
 * @param {string} [input] What goes to the standard input of the script (default: nothing, a closed pipe).
 * @param {string | null} [shell] The shell to run it with (default: the sh of Git for Windows, or the system's).
 */
function runScript(repo, name, args, env, input = '', shell = SH) {
  const script = join(repo, HOOKS_DIR_NAME, name);
  const result = spawnSync(/** @type {string} */ (shell), [slashes(script), ...args], { cwd: repo, env: testEnv(env), encoding: 'utf8', input });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** @param {string} log */
const calls = (log) => (existsSync(log) ? readFileSync(log, 'utf8').split('--end--\n').filter((call) => call !== '').map((call) => call.trimEnd().split('\n')) : []);

test('the scripts call the coffer program with the hook name and what git passed, and keep its exit status', { skip: NO_SH }, async () => {
  const w = workingCopy({ name: 'a repo with spaces' });
  try {
    await installHooks({ cwd: w.repo });
    const stub = writeStub(w.root);
    const log = slashes(join(w.root, 'calls.log'));
    const env = { COFFER: stub, STUB_LOG: log };

    // pre-commit: runs, its failure fails the commit and says how to get around it.
    let result = runScript(w.repo, 'pre-commit', [], env);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(calls(log), [['hooks', 'run', 'pre-commit', '--']]);
    result = runScript(w.repo, 'pre-commit', [], { ...env, STUB_EXIT: '3' });
    assert.equal(result.status, 3);
    assert.match(result.stderr, /coffer \(pre-commit hook\): the commit was stopped[\s\S]*git commit --no-verify/);

    // pre-push: gets the remote and the address, fails the push.
    rmSync(log);
    result = runScript(w.repo, 'pre-push', ['origin', 'https://example.invalid/r.git'], { ...env, STUB_EXIT: '1' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /the push was stopped because the originals could not be uploaded[\s\S]*git push --no-verify/);
    assert.deepEqual(calls(log), [['hooks', 'run', 'pre-push', '--', 'origin', 'https://example.invalid/r.git']]);

    // post hooks: a failing coffer never fails git.
    for (const name of ['post-merge', 'post-rewrite']) {
      rmSync(log);
      result = runScript(w.repo, name, ['0'], { ...env, STUB_EXIT: '5' });
      assert.equal(result.status, 0, name);
      assert.match(result.stderr, new RegExp(`coffer \\(${name} hook\\): the originals were not fetched`));
      assert.deepEqual(calls(log), [['hooks', 'run', name, '--', '0']]);
    }

    // post-checkout: only for a branch checkout.
    rmSync(log);
    assert.equal(runScript(w.repo, 'post-checkout', ['aaa', 'bbb', '0'], env).status, 0);
    assert.deepEqual(calls(log), [], 'a file checkout does nothing');
    assert.equal(runScript(w.repo, 'post-checkout', ['aaa', 'bbb', '1'], { ...env, STUB_EXIT: '9' }).status, 0);
    assert.deepEqual(calls(log), [['hooks', 'run', 'post-checkout', '--', 'aaa', 'bbb', '1']]);

    // COFFER_SKIP_HOOKS turns every hook off.
    rmSync(log);
    for (const name of HOOK_NAMES) assert.equal(runScript(w.repo, name, ['a', 'b', '1'], { ...env, COFFER_SKIP_HOOKS: '1', STUB_EXIT: '1' }).status, 0, name);
    assert.deepEqual(calls(log), []);
  } finally {
    cleanup(w.root);
  }
});

test('a baked-in configuration path is passed on, and the scripts find coffer in node_modules/.bin', { skip: NO_SH }, async () => {
  const w = workingCopy();
  try {
    mkdirSync(join(w.repo, 'sites'));
    writeFileSync(join(w.repo, 'sites', 'coffer.yaml'), FS_CONFIG);
    await installHooks({ cwd: w.repo, config: 'sites/coffer.yaml' });
    const log = slashes(join(w.root, 'calls.log'));
    mkdirSync(join(w.repo, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(w.repo, 'node_modules', '.bin', 'coffer'), readFileSync(writeStub(w.root), 'utf8'));
    chmodSync(join(w.repo, 'node_modules', '.bin', 'coffer'), 0o755);
    const result = runScript(w.repo, 'pre-commit', [], { STUB_LOG: log });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(calls(log), [['hooks', 'run', 'pre-commit', '--config', 'sites/coffer.yaml', '--']]);
  } finally {
    cleanup(w.root);
  }
});

test('when coffer cannot be found a guarding hook fails and a following hook only says so', { skip: NO_SH }, async () => {
  const w = workingCopy();
  try {
    await installHooks({ cwd: w.repo });
    // A PATH that holds git (the scripts ask it for the root) and nothing else of ours.
    const bare = { PATH: `${dirname(/** @type {string} */ (GIT))}${delimiter}${dirname(/** @type {string} */ (SH))}` };
    const guard = runScript(w.repo, 'pre-commit', [], bare);
    assert.equal(guard.status, 1);
    assert.match(guard.stderr, /the coffer program was not found: run "npm install" in the repository, or set COFFER/);
    const follow = runScript(w.repo, 'post-merge', ['0'], bare);
    assert.equal(follow.status, 0);
    assert.match(follow.stderr, /the coffer program was not found/);
  } finally {
    cleanup(w.root);
  }
});

const DASH = findExecutable('dash', process.env.PATH);

test('the pre-push script hands the ref lines on its standard input to coffer, unchanged', { skip: NO_SH }, async () => {
  const w = workingCopy({ name: 'a repo with spaces' });
  try {
    await installHooks({ cwd: w.repo });
    const stub = writeStub(w.root);
    const log = slashes(join(w.root, 'calls.log'));
    const seen = slashes(join(w.root, 'stdin.txt'));
    const lines = BRANCH_LINE + TAG_LINE + DELETE_BRANCH_LINE;
    for (const shell of [SH, DASH]) {
      if (shell === null) continue;
      rmSync(seen, { force: true });
      const result = runScript(w.repo, 'pre-push', ['origin', 'https://example.invalid/r.git'], { COFFER: stub, STUB_LOG: log, STUB_STDIN: seen }, lines, shell);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readFileSync(seen, 'utf8'), lines, `through ${shell}`);
    }
  } finally {
    cleanup(w.root);
  }
});

test('the pre-push script, with the real program: a deletion passes without credentials, a push of a branch is stopped once, an empty lock passes', { skip: NO_SH }, async () => {
  const w = workingCopy({ config: S3_CONFIG });
  try {
    await installHooks({ cwd: w.repo });
    const program = join(w.root, 'real-coffer');
    writeFileSync(program, `#!/bin/sh\nexec "${slashes(process.execPath)}" "${BIN}" "$@"\n`);
    chmodSync(program, 0o755);
    const env = { COFFER: slashes(program) };
    photo(w.repo, PHOTO, 'photo');
    assert.equal(await runHook('pre-commit', capture().io, hookOptions(w.repo)), 0);
    const args = ['origin', 'https://example.invalid/r.git'];

    for (const shell of [SH, DASH]) {
      if (shell === null) continue;
      const label = `through ${shell}`;
      for (const lines of [DELETE_BRANCH_LINE, DELETE_TAG_LINE, DELETE_BRANCH_LINE + DELETE_TAG_LINE, '']) {
        const deletion = runScript(w.repo, 'pre-push', args, env, lines, shell);
        assert.deepEqual([deletion.status, deletion.stdout, deletion.stderr], [0, '', ''], `${label}: ${JSON.stringify(lines)}`);
      }
      for (const lines of [BRANCH_LINE, TAG_LINE, DELETE_BRANCH_LINE + BRANCH_LINE]) {
        const pushed = runScript(w.repo, 'pre-push', args, env, lines, shell);
        assert.equal(pushed.status, 1, `${label}: ${JSON.stringify(lines)}`);
        assert.equal(pushed.stderr.match(/COFFER_MEDIA_ACCESS_KEY_ID, COFFER_MEDIA_SECRET_ACCESS_KEY are not set/g)?.length, 1, 'the credentials message, once');
        assert.match(pushed.stderr, /the push was stopped because the originals could not be uploaded/);
      }
    }

    // Nothing in the lock: nothing to upload, so nothing to ask for.
    writeFileSync(join(w.repo, 'media.lock.json'), EMPTY_LOCK);
    const empty = runScript(w.repo, 'pre-push', args, env, BRANCH_LINE);
    assert.deepEqual([empty.status, empty.stdout, empty.stderr], [0, '', '']);
    rmSync(join(w.repo, 'media.lock.json'));
    const missing = runScript(w.repo, 'pre-push', args, env, BRANCH_LINE);
    assert.deepEqual([missing.status, missing.stdout, missing.stderr], [0, '', '']);
  } finally {
    cleanup(w.root);
  }
});

test('with the real program: a commit refreshes and stages the lock file, and a branch checkout runs the pull', { skip: NO_SH }, async () => {
  const w = workingCopy();
  try {
    await installHooks({ cwd: w.repo });
    // The program is this checkout's bin/coffer.js, started by a stand-in script.
    const program = join(w.root, 'real-coffer');
    writeFileSync(program, `#!/bin/sh\nexec "${slashes(process.execPath)}" "${BIN}" "$@"\n`);
    chmodSync(program, 0o755);
    const env = { COFFER: slashes(program) };
    photo(w.repo, PHOTO, 'photo one');
    writeFileSync(join(w.repo, '.gitignore'), `${PHOTO}\n.coffer/\n`);
    gitOk(w.repo, ['add', 'coffer.yaml', '.gitignore']);
    const commit = git(w.repo, ['commit', '-q', '-m', 'first'], env);
    assert.equal(commit.status, 0, commit.stderr + commit.stdout);
    const tree = gitOk(w.repo, ['ls-tree', '-r', '--name-only', 'HEAD']).split('\n');
    assert.ok(tree.includes('media.lock.json'), `the lock file is in the commit: ${tree.join(', ')}`);
    assert.ok(!tree.includes(PHOTO), 'the original stays out of git');
    assert.ok(readFileSync(join(w.repo, 'media.lock.json'), 'utf8').includes(sha('photo one')));

    // The hook ran from git: a branch checkout runs post-checkout, which pulls (nothing to do) and succeeds.
    const checkout = git(w.repo, ['checkout', '-q', '-b', 'other'], env);
    assert.equal(checkout.status, 0, checkout.stderr);

    // A commit that fails in the hook is stopped.
    writeFileSync(join(w.repo, 'coffer.yaml'), `${FS_CONFIG}  lock: ../outside.json\n`);
    gitOk(w.repo, ['add', 'coffer.yaml']);
    const stopped = git(w.repo, ['commit', '-q', '-m', 'broken'], env);
    assert.notEqual(stopped.status, 0);
    assert.match(stopped.stderr, /the commit was stopped/);
    // ... and --no-verify gets around it, as documented.
    assert.equal(git(w.repo, ['commit', '-q', '--no-verify', '-m', 'broken anyway'], env).status, 0);
  } finally {
    cleanup(w.root);
  }
});
