import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildSites } from '../src/build.js';
import { parseDocsFetchArgs, run } from '../src/cli.js';
import { loadConfig } from '../src/config.js';
import {
  checkDocsConfig,
  checkGitUrl,
  cleanRelativePath,
  describeFetched,
  DocsSourceError,
  fetchDocsSources,
  findExecutable,
  githubOf,
  gitConfigArguments,
  gitEnvironment,
  manifestDocs,
  planDocsFetch,
  redactUrl,
  resolveInside,
  sshCommand,
} from '../src/docs/sources.js';
import { TINY_PNG } from './helpers/images.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixture = join(root, 'example', 'sample-tool');
const exampleConfig = join(root, 'example', 'coffer.yaml');

const GIT_AVAILABLE = spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;
const NO_GIT = GIT_AVAILABLE ? false : 'git is not installed';

/**
 * @template T
 * @param {(dir: string) => Promise<T> | T} body
 * @returns {Promise<T>}
 */
async function inTemp(body) {
  const dir = mkdtempSync(join(tmpdir(), 'coffer-docs-'));
  try {
    return await body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * @param {string} cwd
 * @param {string[]} args
 * @returns {string}
 */
function git(cwd, args) {
  return execFileSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
}

/**
 * A temporary git repository made from the fixture, with a branch and tags.
 *
 * @param {string} parent
 * @returns {string} Its path.
 */
function makeRepository(parent) {
  const repo = join(parent, 'origin');
  cpSync(fixture, repo, { recursive: true });
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'first']);
  git(repo, ['tag', 'light']);
  git(repo, ['tag', '-a', 'v1', '-m', 'version one']);
  git(repo, ['branch', 'feature']);
  return repo;
}

/**
 * @param {string} source
 * @param {string} dir
 * @returns {import('../src/docs/sources.js').DocsConfig}
 */
function docsConfig(source, dir) {
  const checked = checkDocsConfig(
    { source: { git: source, ref: 'main' }, guides: [{ dir: 'docs' }] },
    { dir },
  );
  assert.ok('value' in checked, 'problem' in checked ? checked.problem : '');
  return checked.value;
}

/**
 * @param {string} url
 * @param {string} ref
 * @param {string} [guideDir]
 * @returns {import('../src/docs/sources.js').DocsConfig}
 */
function gitDocs(url, ref, guideDir = 'docs') {
  const checked = checkDocsConfig({ source: { git: url, ref }, guides: [{ dir: guideDir, order: ['getting-started.md'] }] }, { dir: root });
  assert.ok('value' in checked, 'problem' in checked ? checked.problem : '');
  return checked.value;
}

// --- The schema ------------------------------------------------------------

test('a git source needs a ref, a path source must be a folder, and exactly one is given', () => {
  const ok = checkDocsConfig({ source: { git: 'https://github.com/octo-org/widget.git', ref: 'main' } }, { dir: root });
  assert.deepEqual(ok, {
    value: {
      source: { git: 'https://github.com/octo-org/widget.git', ref: 'main' },
      github: 'octo-org/widget',
      guides: [],
      reference: null,
    },
  });
  assert.deepEqual(checkDocsConfig({ source: { git: 'https://example.org/a/b.git' } }, { dir: root }), {
    problem: 'source.ref: is required with git (a branch or tag)',
  });
  assert.deepEqual(checkDocsConfig({ source: { git: 'https://example.org/a/b.git', ref: 'main', path: '.' } }, { dir: root }), {
    problem: 'source: needs exactly one of git (with ref) or path',
  });
  assert.deepEqual(checkDocsConfig({ source: {} }, { dir: root }), { problem: 'source: needs exactly one of git (with ref) or path' });
  assert.deepEqual(checkDocsConfig({}, { dir: root }), { problem: 'source: is required: {git: URL, ref: branch-or-tag} or {path: folder}' });
  assert.deepEqual(checkDocsConfig('x', { dir: root }), {
    problem: 'must be a mapping with some of: source, github, guides, reference (see the documentation of docs sources)',
  });
  const path = checkDocsConfig({ source: { path: 'example/sample-tool' } }, { dir: root });
  assert.ok('value' in path);
  assert.deepEqual(path.value.source, { path: 'example/sample-tool', dir: fixture });
  assert.equal(path.value.github, null);
  assert.match(
    /** @type {{ problem: string }} */ (checkDocsConfig({ source: { path: 'nowhere' } }, { dir: root })).problem,
    /source\.path: the folder "nowhere" does not exist/,
  );
  assert.match(
    /** @type {{ problem: string }} */ (checkDocsConfig({ source: { path: 'package.json' } }, { dir: root })).problem,
    /source\.path: "package\.json" is not a folder/,
  );
  assert.match(
    /** @type {{ problem: string }} */ (checkDocsConfig({ source: { path: '.', ref: 'main' } }, { dir: root })).problem,
    /source\.ref: only applies to a git source/,
  );
});

test('hostile or unusable repository addresses are refused', () => {
  const refused = [
    '--upload-pack=touch /tmp/x',
    '-oProxyCommand=evil',
    'ext::sh -c "touch /tmp/x"',
    'ext::sh -c touch% /tmp/x',
    'fd::17/foo',
    'https://example.org/a/b.git\nhttps://other.example/x',
    'https://example.org/a b.git',
    'https://example.org/a/b.git;rm',
    "https://example.org/a/'b'",
    'https://example.org/a/$(x)',
    'https://example.org/%0a/x',
    'https://-evil.example/a/b',
    'ssh://-oProxyCommand=x/a/b',
    'ssh://-user@example.org/a/b',
    '-user@example.org:a/b',
    'git@-evil.example:a/b',
    'git@example.org:-oFoo',
    'git@example.org:../../x',
    'http://example.org/a/b.git',
    'git://example.org/a/b.git',
    'ftp://example.org/a/b.git',
    'file://remote-host/a/b',
    'file:///',
    '/just/a/path',
    'C:\\repos\\x',
    '../relative',
    'https://',
    'https://example.org',
    'https://example.org/../x',
    // A token in the query or the fragment would be copied into messages and the manifest.
    'https://example.org/a/b.git?access_token=SECRET',
    'https://example.org/a/b.git#token',
    'https://example.org/a/b.git?',
    'ssh://git@example.org/a/b.git?x=1',
    'git@example.org:a/b.git#x',
    // ssh: percent-escapes in the user or the host could hide a leading "-", and odd ports or separators are not addresses.
    'ssh://%2DoProxyCommand=x@h/r',
    'ssh://a%2Db@h/r',
    'ssh://%2dX@h/r',
    'ssh://a@h%2D/r',
    'ssh://-oProxyCommand=x@h/r',
    'ssh://h:abc/r',
    'ssh://h:99999/r',
    'ssh://h:-1/r',
    'ssh://h:0/r',
    'ssh://h /r',
    'ssh://h\t/r',
    'ssh://h\\r',
    'ssh://a\\b@h/r',
    'ssh://h/r\u0000',
    'a%2Db@h:r',
    'git@h%2D:r',
    'git@h:r s',
    '',
  ];
  for (const url of refused) {
    const result = checkDocsConfig({ source: { git: url, ref: 'main' } }, { dir: root });
    assert.ok('problem' in result, `accepted ${JSON.stringify(url)}`);
    assert.match(result.problem, /^source\.git: /);
  }
  assert.ok('problem' in checkDocsConfig({ source: { git: 'https://example.org/' + 'a'.repeat(600), ref: 'main' } }, { dir: root }));
  assert.ok('problem' in checkDocsConfig({ source: { git: 7, ref: 'main' } }, { dir: root }));
  for (const url of [
    'https://example.org/a/b.git',
    'https://user:pw@example.org/a/b.git',
    'ssh://git@example.org:2222/a/b.git',
    'git@example.org:a/b.git',
    'file:///tmp/repo',
    'file:///C:/work/repo',
    'file://localhost/tmp/repo',
    'ssh://[::1]/r',
    'ssh://git@[::1]:2222/a/b.git',
    'ssh://git@example.org:65535/a/b.git',
    'https://user:p%40ss@example.org/a/b.git',
  ]) {
    assert.ok('value' in checkGitUrl(url), `refused ${url}`);
  }
  assert.equal(/** @type {{ transport: string }} */ (checkGitUrl('git@example.org:a/b.git')).transport, 'ssh');
});

test('a ref is a conservative branch or tag name', () => {
  for (const ref of ['--upload-pack=x', 'a?token=1', 'a#frag', 'u:p@h', '-b', 'a..b', '/main', 'main/', 'a//b', 'a b', 'a;b', 'x.lock', 'x.', 'a@{1}', 'a~1', 'a:b', 'v*', '', 7, 'a'.repeat(201)]) {
    const result = checkDocsConfig({ source: { git: 'https://example.org/a/b.git', ref } }, { dir: root });
    assert.ok('problem' in result, `accepted ${JSON.stringify(ref)}`);
    assert.match(result.problem, /^source\.ref: /);
  }
  for (const ref of ['main', 'v1.2.3', 'release/2.x', 'feature_a-b']) {
    assert.ok('value' in checkDocsConfig({ source: { git: 'https://example.org/a/b.git', ref } }, { dir: root }), ref);
  }
});

test('github is inferred from a github.com address, or given as owner/repo', () => {
  assert.equal(githubOf('https://github.com/octo-org/widget'), 'octo-org/widget');
  assert.equal(githubOf('https://github.com/octo-org/widget.git'), 'octo-org/widget');
  assert.equal(githubOf('https://token@github.com/octo-org/widget.git/'), 'octo-org/widget');
  assert.equal(githubOf('git@github.com:octo-org/widget.git'), 'octo-org/widget');
  assert.equal(githubOf('ssh://git@github.com/octo-org/widget.git'), 'octo-org/widget');
  assert.equal(githubOf('https://gitlab.com/octo-org/widget.git'), null);
  assert.equal(githubOf('https://github.com.evil.example/octo-org/widget.git'), null);
  assert.equal(githubOf('https://github.com/octo-org/widget/tree/main'), null);
  const source = { git: 'https://gitlab.example/octo-org/widget.git', ref: 'main' };
  assert.equal(/** @type {{ value: { github: string | null } }} */ (checkDocsConfig({ source }, { dir: root })).value.github, null);
  assert.equal(
    /** @type {{ value: { github: string | null } }} */ (checkDocsConfig({ source, github: 'octo-org/widget' }, { dir: root })).value.github,
    'octo-org/widget',
  );
  for (const github of ['widget', 'a/b/c', 'octo org/widget', 'octo-org/widget.git', 'octo-org/..', '-x/y', 5]) {
    const result = checkDocsConfig({ source, github }, { dir: root });
    assert.ok('problem' in result, String(github));
    assert.match(result.problem, /^github: must be owner\/repo/);
  }
});

test('guides are checked: paths stay inside the repository, counts and lengths are bounded, defaults apply', () => {
  const ok = checkDocsConfig(
    {
      source: { path: '.' },
      guides: [{ dir: './docs//guide/', order: ['intro.md', './a/b.md'], include: ['**/*.md'], exclude: ['drafts/**'] }, { dir: '.' }],
    },
    { dir: root },
  );
  assert.ok('value' in ok);
  assert.deepEqual(ok.value.guides, [
    { dir: 'docs/guide', order: ['intro.md', 'a/b.md'], include: ['**/*.md'], exclude: ['drafts/**'] },
    { dir: '.', order: [], include: ['**/*.md'], exclude: [] },
  ]);
  const bad = checkDocsConfig(
    {
      source: { path: '.' },
      guides: [
        { dir: '../outside' },
        { dir: '/abs' },
        { dir: 'C:/win' },
        { dir: 'back\\slash' },
        { dir: 'ok', order: ['../x.md', 'a.md', 'a.md'] },
        { dir: 'ok2', include: ['/etc/*'], exclude: 'no' },
        { dir: 'ok3', extra: 1 },
        { order: [] },
        'text',
        { dir: 'ok' },
        { dir: 'ok' },
      ],
    },
    { dir: root },
  );
  assert.ok('problem' in bad);
  const problems = bad.problem.split('; ');
  assert.deepEqual(problems, [
    'guides: item 1: dir must stay inside the repository (no "..")',
    'guides: item 2: dir must be relative to the repository, not absolute',
    'guides: item 3: dir must be relative to the repository, not absolute',
    'guides: item 4: dir must use "/" as the separator',
    'guides: item 5: order: item 1 must stay inside the repository (no "..")',
    'guides: item 5: order: "a.md" is listed twice',
    'guides: item 6: include: item 1 must be relative to the repository, not absolute',
    'guides: item 6: exclude: must be a list',
    'guides: item 7: unknown key "extra" (expected one of: dir, order, include, exclude)',
    'guides: item 8: dir is required (the folder of the guide in the repository, "." for its root)',
    'guides: item 9: must be a mapping with dir, order, include, exclude',
    'guides: item 11: the folder "ok" is listed twice',
  ]);
  assert.match(
    /** @type {{ problem: string }} */ (checkDocsConfig({ source: { path: '.' }, guides: Array.from({ length: 21 }, (_, i) => ({ dir: `d${i}` })) }, { dir: root })).problem,
    /guides: at most 20 guides/,
  );
  assert.match(
    /** @type {{ problem: string }} */ (checkDocsConfig({ source: { path: '.' }, guides: [{ dir: 'a'.repeat(201) }] }, { dir: root })).problem,
    /dir must be at most 200 characters/,
  );
  assert.match(
    /** @type {{ problem: string }} */ (
      checkDocsConfig({ source: { path: '.' }, guides: [{ dir: 'a', order: Array.from({ length: 201 }, (_, i) => `f${i}.md`) }] }, { dir: root })
    ).problem,
    /order: at most 200 items/,
  );
  assert.deepEqual(cleanRelativePath('a/./b//c/'), { value: 'a/b/c' });
  assert.deepEqual(cleanRelativePath('.', { allowRoot: true }), { value: '.' });
  assert.ok('problem' in cleanRelativePath('.'));
  assert.ok('problem' in cleanRelativePath('a\u0000b'));
});

test('reference is accepted but not used yet; every problem is reported at once', () => {
  const ok = checkDocsConfig({ source: { path: '.' }, reference: { command: 'x', format: 'json' } }, { dir: root });
  assert.ok('value' in ok);
  assert.deepEqual(ok.value.reference, { command: 'x', format: 'json' });
  const bad = checkDocsConfig({ source: { git: '-x', ref: '..' }, github: 'no', guides: 'x', reference: 5, colour: 1 }, { dir: root });
  assert.ok('problem' in bad);
  assert.deepEqual(
    bad.problem.split('; ').map((text) => text.split(':')[0]),
    ['colour', 'source.git', 'source.ref', 'github', 'guides', 'reference'],
  );
});

test('a project.yaml with a bad docs block names the file and the field', async () => {
  const { parseProjectSource } = await import('../src/content/projects.js');
  const errors = /** @type {string[]} */ ([]);
  const file = join(root, 'p', 'project.yaml');
  parseProjectSource(
    {
      slug: 'p',
      dir: root,
      file,
      text: 'name: P\npitch: x\nkind: tool\nstatus: released\ncard: package.json\nrepo: https://example.org/r\ndocs:\n  source: { git: "ext::sh -c x", ref: main }\n',
    },
    errors,
  );
  assert.ok(errors.some((line) => line.startsWith(`${file}: docs: source.git: `)), errors.join('\n'));
});

// --- Small helpers -----------------------------------------------------------

test('credentials are removed from addresses in messages', () => {
  assert.equal(redactUrl('https://user:secret@example.org/a/b.git'), 'https://example.org/a/b.git');
  assert.equal(redactUrl('https://token@example.org/a/b.git'), 'https://example.org/a/b.git');
  assert.equal(redactUrl('ssh://git:secret@example.org/a/b.git'), 'ssh://git@example.org/a/b.git');
  assert.equal(redactUrl('ssh://git@example.org/a/b.git'), 'ssh://git@example.org/a/b.git');
  assert.equal(redactUrl('git@example.org:a/b.git'), 'git@example.org:a/b.git');
  assert.equal(redactUrl('fatal: unable to access https://u:p@h.example/x.git/: nope'), 'fatal: unable to access https://h.example/x.git/: nope');
});

test('a password in the scp form or without a scheme is removed from a text', () => {
  assert.equal(redactUrl('git:secret@github.com:o/r.git'), 'git@github.com:o/r.git');
  assert.equal(redactUrl('user:pw@host:o/r'), 'user@host:o/r');
  assert.equal(redactUrl('user:pw@host'), 'user@host');
  assert.equal(redactUrl("fatal: could not read from 'git:se/cret@github.com:o/r.git': nope"), "fatal: could not read from 'git@github.com:o/r.git': nope");
  assert.equal(redactUrl('a https://u:p@h/x.git and git:pw@h:r.git end'), 'a https://h/x.git and git@h:r.git end');
  // Text that has no password is left alone: an ssh address, a port, a Windows path, a path with "@", and plain sentences.
  for (const same of [
    'git@github.com:o/r.git',
    'ssh://git@h:22/x.git',
    'https://h/a@b/c.git',
    'host:22',
    'C:/Users/me@work/repo',
    'fatal: repository not found',
    'Permission denied (publickey).',
    'git@github.com: Permission denied',
  ]) {
    assert.equal(redactUrl(same), same);
  }
});

test('no message echoes a password, whatever form the address has', async () => {
  const secret = 'SECRETPW';
  const addresses = [
    `git:${secret}@github.com:o/r.git`,
    `user:${secret}@host:o/r`,
    `user:${secret}@host`,
    `git:${secret}/x@github.com:o/r.git`,
    `https://user:${secret}@`,
    `ssh://git:${secret}@h:bad port/r`,
    `https://user:${secret}@exa mple.org/r.git`,
    `https://user:${secret}@example.org/a/b.git?access_token=${secret}`,
    `-oProxyCommand=user:${secret}@host`,
    secret,
  ];
  for (const address of addresses) {
    const problem = checkGitUrl(address);
    assert.ok('problem' in problem, address);
    assert.doesNotMatch(problem.problem, new RegExp(secret), `checkGitUrl: ${address}`);
    const checked = checkDocsConfig({ source: { git: address, ref: 'main' } }, { dir: root });
    assert.ok('problem' in checked, address);
    assert.doesNotMatch(checked.problem, new RegExp(secret), `checkDocsConfig: ${address}`);
    // Configuration that was not checked (a caller of the fetch can pass anything) fails with a message that has no password either.
    await inTemp(async (dir) => {
      const exec = async () => {
        throw new Error('git must not be started');
      };
      await assert.rejects(
        fetchDocsSources([{ slug: 'lathe', docs: { source: { git: address, ref: 'main' }, github: null, guides: [], reference: null } }], {
          cacheDir: join(dir, 'repos'),
          exec,
        }),
        (error) => {
          assert.ok(error instanceof DocsSourceError);
          assert.match(error.errors[0], /^project "lathe": docs source /);
          assert.doesNotMatch(error.message, new RegExp(secret), `fetchDocsSources: ${address}`);
          return true;
        },
      );
      // The cache folder cannot be made: the other message that names the address.
      const blocker = join(dir, 'blocker');
      writeFileSync(blocker, 'x');
      await assert.rejects(
        fetchDocsSources([{ slug: 'lathe', docs: { source: { git: address, ref: 'main' }, github: null, guides: [], reference: null } }], {
          cacheDir: join(blocker, 'repos'),
          exec,
        }),
        (error) => {
          assert.ok(error instanceof DocsSourceError);
          assert.doesNotMatch(error.message, new RegExp(secret), `cache folder: ${address}`);
          return true;
        },
      );
    });
  }
  assert.equal(
    /** @type {{ problem: string }} */ (checkGitUrl(`git:${secret}@github.com:o/r.git`)).problem,
    'is not a usable address (use an https:// or ssh:// URL, a file:// URL, or user@host:owner/repo)',
  );
});

test('no message echoes a password given as a ref or a folder', async () => {
  const secret = 'SECRETPW';
  for (const ref of [`https://user:${secret}@h/x`, `user:${secret}@host:ref`, `main?token=${secret}`, `${secret} x`]) {
    const checked = checkDocsConfig({ source: { git: 'https://example.org/a/b.git', ref } }, { dir: root });
    assert.ok('problem' in checked, ref);
    assert.doesNotMatch(checked.problem, new RegExp(secret), ref);
    await inTemp(async (dir) => {
      await assert.rejects(
        fetchDocsSources([{ slug: 'lathe', docs: { source: { git: 'https://example.org/a/b.git', ref }, github: null, guides: [], reference: null } }], {
          cacheDir: join(dir, 'repos'),
          exec: async () => {
            throw new Error('git must not be started');
          },
        }),
        (error) => {
          assert.ok(error instanceof DocsSourceError);
          assert.doesNotMatch(error.message, new RegExp(secret), ref);
          return true;
        },
      );
    });
  }
  for (const path of [`https://user:${secret}@h/x`, `git:${secret}@h:x`]) {
    const checked = checkDocsConfig({ source: { path } }, { dir: root });
    assert.ok('problem' in checked, path);
    assert.doesNotMatch(checked.problem, new RegExp(secret), path);
    await inTemp(async (dir) => {
      await assert.rejects(
        fetchDocsSources([{ slug: 'lathe', docs: { source: { path, dir: join(dir, 'nowhere') }, github: null, guides: [], reference: null } }], {
          cacheDir: join(dir, 'repos'),
        }),
        (error) => {
          assert.ok(error instanceof DocsSourceError);
          assert.doesNotMatch(error.message, new RegExp(secret), path);
          return true;
        },
      );
    });
  }
});

test('a password in git output is removed from a fetch failure', async () => {
  await inTemp(async (dir) => {
    const exec = async () => ({
      code: 128,
      stdout: '',
      stderr: "fatal: could not read from 'git:SECRETPW@example.org:a/b.git' and 'https://u:SECRETPW@example.org/a/b.git'\n",
      timedOut: false,
    });
    await assert.rejects(
      fetchDocsSources([{ slug: 'lathe', docs: gitDocs('ssh://git@example.org/a/b.git', 'main') }], { cacheDir: join(dir, 'repos'), exec }),
      (error) => {
        assert.ok(error instanceof DocsSourceError);
        assert.match(error.message, /could not read from 'git@example\.org:a\/b\.git' and 'https:\/\/example\.org\/a\/b\.git'/);
        assert.doesNotMatch(error.message, /SECRETPW/);
        return true;
      },
    );
  });
});

test('coffer docs fetch and a build refuse an address with a password in the scp form without printing it', async () => {
  const files = siteFiles('docs:\n  source: { git: "git:SECRETPW@github.com:o/r.git", ref: main }\n');
  await inSite(files, async (dir) => {
    const result = await runCli(['docs', 'fetch', '--config', join(dir, 'coffer.yaml')]);
    assert.equal(result.code, 1);
    assert.match(result.err, /docs: source\.git: is not a usable address/);
    assert.doesNotMatch(result.err + result.out, /SECRETPW/);
    const built = await runCli(['build', '--config', join(dir, 'coffer.yaml'), '--out', join(dir, 'out')]);
    assert.equal(built.code, 1);
    assert.doesNotMatch(built.err + built.out, /SECRETPW/);
  });
});

test('a query or a fragment is removed from every address in a text, as defence in depth', () => {
  assert.equal(redactUrl('https://example.org/a/b.git?access_token=SECRET'), 'https://example.org/a/b.git');
  assert.equal(redactUrl('https://u:p@example.org/a/b.git?x=1#frag'), 'https://example.org/a/b.git');
  assert.equal(redactUrl('https://example.org/a/b.git#SECRET'), 'https://example.org/a/b.git');
  assert.equal(
    redactUrl("fatal: unable to access 'https://h.example/x.git?access_token=SECRETQ/': Could not resolve host"),
    "fatal: unable to access 'https://h.example/x.git': Could not resolve host",
  );
  assert.equal(redactUrl('ssh://git@h/x.git?k=SECRET and https://h/y?z=SECRET2 end'), 'ssh://git@h/x.git and https://h/y end');
  assert.doesNotMatch(redactUrl('see https://h/x.git?access_token=SECRET#SECRET2'), /SECRET/);
  assert.equal(redactUrl('no address here? just #text'), 'no address here? just #text');
});

test('resolveInside returns real paths and refuses anything that leads out', async () => {
  await inTemp((dir) => {
    const repo = join(dir, 'repo');
    mkdirSync(join(repo, 'docs'), { recursive: true });
    writeFileSync(join(repo, 'docs', 'a.md'), '# A');
    writeFileSync(join(dir, 'secret.txt'), 'secret');
    const inside = resolveInside(repo, 'docs/a.md');
    assert.ok(inside.ok);
    assert.equal(readFileSync(inside.path, 'utf8'), '# A');
    assert.ok(resolveInside(repo, '.').ok);
    assert.ok(resolveInside(repo, '').ok);
    assert.deepEqual({ ...resolveInside(repo, '../secret.txt'), message: '' }, { ok: false, reason: 'invalid', message: '' });
    assert.equal(/** @type {{ reason: string }} */ (resolveInside(repo, '/etc/passwd')).reason, 'invalid');
    assert.equal(/** @type {{ reason: string }} */ (resolveInside(repo, 'docs\\a.md')).reason, 'invalid');
    assert.equal(/** @type {{ reason: string }} */ (resolveInside(repo, 'docs/missing.md')).reason, 'missing');
    assert.equal(/** @type {{ reason: string }} */ (resolveInside(join(dir, 'none'), 'a')).reason, 'missing');
    // A directory junction (a directory link that needs no privilege on Windows; a plain link elsewhere) pointing out of the repository.
    symlinkSync(dir, join(repo, 'up'), 'junction');
    assert.equal(/** @type {{ reason: string }} */ (resolveInside(repo, 'up/secret.txt')).reason, 'outside');
    assert.equal(/** @type {{ reason: string }} */ (resolveInside(repo, 'up')).reason, 'outside');
    // A junction that stays inside is fine.
    symlinkSync(join(repo, 'docs'), join(repo, 'alias'), 'junction');
    const aliased = resolveInside(repo, 'alias/a.md');
    assert.ok(aliased.ok);
    assert.equal(readFileSync(aliased.path, 'utf8'), '# A');
    // A file link needs a privilege on some systems, so it is tried on its own.
    let fileLinked = true;
    try {
      symlinkSync(join(dir, 'secret.txt'), join(repo, 'docs', 'link.md'), 'file');
    } catch {
      fileLinked = false;
    }
    if (fileLinked) {
      const file = resolveInside(repo, 'docs/link.md');
      assert.equal(file.ok, false);
      assert.equal(/** @type {{ reason: string }} */ (file).reason, 'outside');
    }
  });
});

test('git runs in a controlled environment with safe settings', () => {
  const env = gitEnvironment(
    { emptyConfig: '/x/empty' },
    'https',
    { PATH: '/bin', HOME: '/h', GIT_DIR: '/elsewhere', GIT_WORK_TREE: '/w', GIT_SSH_COMMAND: 'ssh -i key', SSH_ASKPASS: '/p', GIT_ASKPASS: '/q', GIT_EXEC_PATH: '/e' },
  );
  assert.equal(env.PATH, '/bin');
  assert.equal(env.HOME, '/h');
  assert.equal(env.GIT_DIR, undefined);
  assert.equal(env.GIT_WORK_TREE, undefined);
  assert.equal(env.GIT_EXEC_PATH, undefined);
  assert.equal(env.SSH_ASKPASS, undefined);
  assert.equal(env.GIT_ASKPASS, '');
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(env.GIT_CONFIG_GLOBAL, '/x/empty');
  assert.equal(env.GIT_ALLOW_PROTOCOL, 'https');
  assert.equal(env.GIT_SSH_COMMAND, 'ssh -i key -o BatchMode=yes');
  assert.equal(gitEnvironment({ emptyConfig: 'e' }, 'ssh', {}).GIT_SSH_COMMAND, 'ssh -o BatchMode=yes');
  assert.equal(gitEnvironment({ emptyConfig: 'e' }, 'ssh', { GIT_SSH_VARIANT: 'plink', GIT_SSH: 'C:\\tools\\plink.exe' }).GIT_SSH_VARIANT, 'plink');
  assert.equal(gitEnvironment({ emptyConfig: 'e' }, null, {}).GIT_ALLOW_PROTOCOL, 'none');
  const settings = gitConfigArguments({ hooksDir: 'C:\\a\\b' }).join(' ');
  assert.match(settings, /core\.hooksPath=C:\\a\\b|core\.hooksPath=C:\/a\/b/);
  assert.match(settings, /credential\.helper= /);
  assert.match(settings, /submodule\.recurse=false/);
});

test('-o BatchMode=yes is added to OpenSSH only; another ssh client is run as the user set it up', () => {
  assert.equal(sshCommand(undefined), 'ssh -o BatchMode=yes');
  assert.equal(sshCommand(''), 'ssh -o BatchMode=yes');
  assert.equal(sshCommand('ssh -i key'), 'ssh -i key -o BatchMode=yes');
  assert.equal(sshCommand('/usr/bin/ssh'), '/usr/bin/ssh -o BatchMode=yes');
  assert.equal(sshCommand('"C:\\Program Files\\Git\\usr\\bin\\ssh.exe" -F cfg'), '"C:\\Program Files\\Git\\usr\\bin\\ssh.exe" -F cfg -o BatchMode=yes');
  assert.equal(sshCommand('plink -batch -ssh'), 'plink -batch -ssh');
  assert.equal(sshCommand('"C:\\Program Files\\PuTTY\\plink.exe"'), '"C:\\Program Files\\PuTTY\\plink.exe"');
  assert.equal(sshCommand('TortoiseGitPlink.exe'), 'TortoiseGitPlink.exe');
  assert.equal(sshCommand('./my-ssh-wrapper.sh --flag'), './my-ssh-wrapper.sh --flag');
  assert.equal(gitEnvironment({ emptyConfig: 'e' }, 'ssh', { GIT_SSH_COMMAND: 'plink -batch' }).GIT_SSH_COMMAND, 'plink -batch');
  assert.equal(gitEnvironment({ emptyConfig: 'e' }, 'ssh', { GIT_SSH: 'C:\\p\\plink.exe' }).GIT_SSH_COMMAND, '"C:\\p\\plink.exe"');
  assert.equal(gitEnvironment({ emptyConfig: 'e' }, 'ssh', { GIT_SSH: '/usr/bin/ssh' }).GIT_SSH_COMMAND, '"/usr/bin/ssh" -o BatchMode=yes');
});

test('git is found by an absolute path from the PATH, never from the current folder or a relative entry', async () => {
  await inTemp((dir) => {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const name = process.platform === 'win32' ? 'git.exe' : 'git';
    writeFileSync(join(bin, name), 'x', { mode: 0o755 });
    const separator = process.platform === 'win32' ? ';' : ':';
    assert.equal(findExecutable('git', bin), join(bin, name));
    assert.equal(findExecutable('git', ['', '.', 'bin', dir, bin].join(separator)), join(bin, name));
    assert.equal(findExecutable('git', ['', '.', 'bin', dir].join(separator)), null);
    assert.equal(findExecutable('git', undefined), null);
    const relativeBin = relative(process.cwd(), bin);
    if (!isAbsolute(relativeBin)) assert.equal(findExecutable('git', relativeBin), null);
    assert.equal(findExecutable('no-such-program-here', bin), null);
  });
});

// --- Fetching with a replaced git -------------------------------------------

test('git is called with argument lists, the address after --, and the controlled environment', async () => {
  await inTemp(async (dir) => {
    /** @type {{ args: string[], env: Record<string, string>, cwd: string }[]} */
    const calls = [];
    const sha = 'a'.repeat(40);
    const exec = async (/** @type {string[]} */ args, /** @type {import('../src/docs/sources.js').GitCall} */ call) => {
      calls.push({ args, env: call.env, cwd: call.cwd });
      if (args.includes('clone')) mkdirSync(join(args[args.length - 1], 'docs'), { recursive: true });
      return { code: 0, stdout: args.includes('rev-parse') ? `${sha}\n` : '', stderr: '', timedOut: false };
    };
    const url = 'https://user:secret@example.org/octo-org/widget.git';
    const result = await fetchDocsSources([{ slug: 'widget', docs: gitDocs(url, 'v1') }], { cacheDir: join(dir, 'repos'), exec });
    const fetched = /** @type {import('../src/docs/sources.js').FetchedDocs} */ (result.get('widget'));
    assert.deepEqual(fetched.source, { type: 'git', git: 'https://example.org/octo-org/widget.git', ref: 'v1', sha });
    assert.equal(fetched.github, null);
    assert.doesNotMatch(describeFetched(fetched), /secret/);
    assert.equal(describeFetched(fetched), `widget: ${sha} (https://example.org/octo-org/widget.git, ref v1)`);
    const clone = /** @type {(typeof calls)[number]} */ (calls.find((call) => call.args.includes('clone')));
    const at = clone.args.indexOf('--');
    assert.ok(at > 0);
    assert.deepEqual(clone.args.slice(at), ['--', url, join(dir, 'repos', 'widget')]);
    for (const flag of ['--depth', '--single-branch', '--no-tags', '--no-recurse-submodules', '--branch=v1']) {
      assert.ok(clone.args.includes(flag), flag);
    }
    for (const call of calls) {
      assert.equal(call.env.GIT_TERMINAL_PROMPT, '0');
      assert.equal(call.env.GIT_ALLOW_PROTOCOL, call.args.includes('clone') ? 'https' : 'https');
      assert.ok(call.args.some((arg) => arg.startsWith('core.hooksPath=')));
    }
    assert.ok(existsSync(join(dir, 'repos', '.coffer-git', 'empty-config')));
  });
});

test('a cache that holds the same repository is fetched and reset, not cloned; a different one is cloned again', async () => {
  await inTemp(async (dir) => {
    const sha = 'b'.repeat(40);
    /** @type {string[][]} */
    const calls = [];
    let origin = 'https://example.org/a/b.git';
    const exec = async (/** @type {string[]} */ args) => {
      calls.push(args);
      if (args.includes('clone')) {
        mkdirSync(join(args[args.length - 1], '.git'), { recursive: true });
        mkdirSync(join(args[args.length - 1], 'docs'), { recursive: true });
      }
      return {
        code: 0,
        stdout: args.includes('config') ? `${origin}\n` : args.includes('rev-parse') ? `${sha}\n` : '',
        stderr: '',
        timedOut: false,
      };
    };
    const options = { cacheDir: join(dir, 'repos'), exec };
    const docs = gitDocs('https://example.org/a/b.git', 'main');
    await fetchDocsSources([{ slug: 'b', docs }], options);
    assert.equal(calls.filter((args) => args.includes('clone')).length, 1);
    calls.length = 0;
    await fetchDocsSources([{ slug: 'b', docs }], options);
    assert.equal(calls.filter((args) => args.includes('clone')).length, 0);
    const verbs = calls.map((args) => args.find((arg) => ['config', 'fetch', 'reset', 'clean', 'rev-parse'].includes(arg)));
    assert.deepEqual(verbs, ['config', 'fetch', 'reset', 'clean', 'rev-parse']);
    const fetchCall = /** @type {string[]} */ (calls.find((args) => args.includes('fetch')));
    assert.deepEqual(fetchCall.slice(fetchCall.indexOf('--')), ['--', 'origin', 'main']);
    assert.ok(fetchCall.some((arg) => arg.startsWith('--git-dir=')));
    assert.ok(fetchCall.some((arg) => arg.startsWith('--work-tree=')));
    calls.length = 0;
    origin = 'https://example.org/other/repo.git';
    await fetchDocsSources([{ slug: 'b', docs }], options);
    assert.equal(calls.filter((args) => args.includes('clone')).length, 1);
    assert.equal(calls.filter((args) => args.includes('fetch')).length, 0);
  });
});

test('a failed update removes the checkout and is retried with a fresh clone; if that fails too, the failure is reported', async () => {
  await inTemp(async (dir) => {
    /** @type {string[][]} */
    const calls = [];
    let cloneWorks = false;
    const exec = async (/** @type {string[]} */ args) => {
      calls.push(args);
      if (args.includes('fetch')) {
        return { code: 128, stdout: '', stderr: "fatal: Unable to create '/x/.git/shallow.lock': File exists. https://u:pw@example.org/a/b.git/?access_token=SECRETQ", timedOut: false };
      }
      if (args.includes('config')) return { code: 0, stdout: 'https://example.org/a/b.git\n', stderr: '', timedOut: false };
      if (args.includes('clone')) {
        if (!cloneWorks) {
          return { code: 128, stdout: '', stderr: "fatal: unable to access 'https://u:pw@example.org/a/b.git/?access_token=SECRETQ': Could not resolve host", timedOut: false };
        }
        mkdirSync(join(args[args.length - 1], 'docs'), { recursive: true });
        return { code: 0, stdout: '', stderr: '', timedOut: false };
      }
      return { code: 0, stdout: 'c'.repeat(40), stderr: '', timedOut: false };
    };
    const cache = join(dir, 'repos');
    const stale = () => {
      mkdirSync(join(cache, 'b', '.git'), { recursive: true });
      mkdirSync(join(cache, 'b', 'docs'), { recursive: true });
      writeFileSync(join(cache, 'b', 'docs', 'stale.md'), 'stale');
    };
    const docs = gitDocs('https://example.org/a/b.git', 'main');
    stale();
    await assert.rejects(fetchDocsSources([{ slug: 'b', docs }], { cacheDir: cache, exec }), (error) => {
      assert.ok(error instanceof DocsSourceError);
      assert.equal(error.errors.length, 1);
      // The failure reported is that of the fresh clone, with the project and the address.
      assert.match(error.errors[0], /^project "b": cannot fetch the docs source https:\/\/example\.org\/a\/b\.git \(ref main\): clone: git failed \(exit code 128\)/);
      assert.doesNotMatch(error.message, /pw|SECRETQ/);
      return true;
    });
    // The stale copy is gone: it is neither used nor left to wedge the next build.
    assert.equal(existsSync(join(cache, 'b')), false);
    assert.deepEqual(
      calls.map((args) => args.find((arg) => ['config', 'fetch', 'clone'].includes(arg))),
      ['config', 'fetch', 'clone'],
    );

    // The same failed update, with a clone that works: the content is the fresh one.
    calls.length = 0;
    cloneWorks = true;
    stale();
    const result = await fetchDocsSources([{ slug: 'b', docs }], { cacheDir: cache, exec });
    assert.equal(/** @type {{ source: { sha: string } }} */ (result.get('b')).source.sha, 'c'.repeat(40));
    assert.equal(existsSync(join(cache, 'b', 'docs', 'stale.md')), false);
    assert.equal(calls.filter((args) => args.includes('clone')).length, 1);
  });
});

test('a git that is missing or runs out of time during an update is not retried, and the copy is removed', async () => {
  await inTemp(async (dir) => {
    for (const failure of [
      { code: null, stdout: '', stderr: '', timedOut: false, spawnError: 'spawn git ENOENT' },
      { code: null, stdout: '', stderr: '', timedOut: true },
    ]) {
      const calls = /** @type {string[][]} */ ([]);
      const exec = async (/** @type {string[]} */ args) => {
        calls.push(args);
        if (args.includes('config')) return { code: 0, stdout: 'https://example.org/a/b.git\n', stderr: '', timedOut: false };
        return failure;
      };
      const cache = join(dir, 'repos');
      mkdirSync(join(cache, 'b', '.git'), { recursive: true });
      await assert.rejects(fetchDocsSources([{ slug: 'b', docs: gitDocs('https://example.org/a/b.git', 'main') }], { cacheDir: cache, exec }), DocsSourceError);
      assert.equal(calls.filter((args) => args.includes('clone')).length, 0);
      assert.equal(existsSync(join(cache, 'b')), false);
    }
  });
});

test('a cache folder that cannot be created fails every project with its name and address', async () => {
  await inTemp(async (dir) => {
    const blocker = join(dir, 'not-a-folder');
    writeFileSync(blocker, 'x');
    const exec = async () => {
      assert.fail('git must not run when the cache cannot be made');
    };
    const path = checkDocsConfig({ source: { path: '.' }, guides: [] }, { dir });
    assert.ok('value' in path);
    await assert.rejects(
      fetchDocsSources(
        [
          { slug: 'one', docs: gitDocs('https://user:topsecret@example.org/a/one.git', 'main') },
          { slug: 'two', docs: path.value },
        ],
        { cacheDir: join(blocker, 'repos'), exec: /** @type {never} */ (exec) },
      ),
      (error) => {
        assert.ok(error instanceof DocsSourceError);
        assert.equal(error.errors.length, 2);
        assert.match(error.errors[0], /^project "one": cannot fetch the docs source https:\/\/example\.org\/a\/one\.git: cannot prepare the cache folder /);
        assert.match(error.errors[1], /^project "two": cannot fetch the docs source \.: cannot prepare the cache folder /);
        assert.doesNotMatch(error.message, /topsecret/);
        return true;
      },
    );
  });
});

test('git runs in a folder of the cache, never in the source folder, which is only named with -C', async () => {
  await inTemp(async (dir) => {
    mkdirSync(join(dir, 'src', 'docs'), { recursive: true });
    const docs = checkDocsConfig({ source: { path: 'src' }, guides: [{ dir: 'docs' }] }, { dir });
    assert.ok('value' in docs);
    /** @type {{ args: string[], cwd: string }[]} */
    const calls = [];
    const exec = async (/** @type {string[]} */ args, /** @type {import('../src/docs/sources.js').GitCall} */ call) => {
      calls.push({ args, cwd: call.cwd });
      return { code: 0, stdout: args.includes('rev-parse') ? `${'d'.repeat(40)}\n` : '', stderr: '', timedOut: false };
    };
    const cache = join(dir, 'repos');
    await fetchDocsSources([{ slug: 'inplace', docs: docs.value }], { cacheDir: cache, exec });
    assert.ok(calls.length >= 2);
    for (const call of calls) {
      assert.equal(call.cwd, cache);
      const at = call.args.indexOf('-C');
      assert.equal(call.args[at + 1], join(dir, 'src'));
    }
  });
});

test('a token that reaches git output is scrubbed from the failure', async () => {
  await inTemp(async (dir) => {
    const exec = async () => ({
      code: 128,
      stdout: '',
      stderr: "fatal: unable to access 'https://tok:en@example.org/a/b.git?access_token=SECRETQ#SECRETF/': Could not resolve host: example.org",
      timedOut: false,
    });
    await assert.rejects(fetchDocsSources([{ slug: 'b', docs: gitDocs('https://example.org/a/b.git', 'main') }], { cacheDir: join(dir, 'repos'), exec }), (error) => {
      assert.ok(error instanceof DocsSourceError);
      assert.doesNotMatch(error.message, /SECRET|tok|en@/);
      assert.match(error.message, /unable to access 'https:\/\/example\.org\/a\/b\.git': Could not resolve host/);
      return true;
    });
  });
});

test('a missing git is reported plainly, and every failing project is listed', async () => {
  await inTemp(async (dir) => {
    const exec = async () => ({ code: null, stdout: '', stderr: '', timedOut: false, spawnError: 'spawn git ENOENT' });
    await assert.rejects(
      fetchDocsSources(
        [
          { slug: 'one', docs: gitDocs('https://example.org/a/one.git', 'main') },
          { slug: 'two', docs: gitDocs('https://example.org/a/two.git', 'main') },
        ],
        { cacheDir: join(dir, 'repos'), exec },
      ),
      (error) => {
        assert.ok(error instanceof DocsSourceError);
        assert.equal(error.errors.length, 2);
        assert.match(error.errors[0], /project "one".*one\.git.*git was not found; install git/);
        assert.match(error.errors[1], /project "two".*two\.git/);
        return true;
      },
    );
  });
});

// --- Fetching with real git --------------------------------------------------

test('a git source is cloned from a file:// URL and its commit recorded (branch, tag, annotated tag)', { skip: NO_GIT }, async () => {
  await inTemp(async (dir) => {
    const repo = makeRepository(dir);
    const url = pathToFileURL(repo).href;
    const head = git(repo, ['rev-parse', 'HEAD']);
    for (const ref of ['main', 'light', 'v1', 'feature']) {
      const cache = join(dir, `cache-${ref}`);
      const fetched = await fetchDocsSources([{ slug: 'sample', docs: gitDocs(url, ref) }], { cacheDir: cache, timeoutMs: 60_000 });
      const entry = /** @type {import('../src/docs/sources.js').FetchedDocs} */ (fetched.get('sample'));
      assert.deepEqual(entry.source, { type: 'git', git: url, ref, sha: head }, ref);
      assert.equal(entry.root, join(cache, 'sample'));
      assert.ok(existsSync(join(entry.root, 'docs', 'getting-started.md')));
      assert.ok(existsSync(join(entry.root, 'CHANGELOG.md')));
      assert.equal(readFileSync(join(entry.root, 'docs', 'usage.md'), 'utf8'), readFileSync(join(fixture, 'docs', 'usage.md'), 'utf8'));
      // The clone is shallow.
      assert.equal(git(entry.root, ['rev-list', '--count', 'HEAD']), '1');
    }
  });
});

test('a second fetch after a new commit updates the checkout, and a changed ref is followed', { skip: NO_GIT }, async () => {
  await inTemp(async (dir) => {
    const repo = makeRepository(dir);
    const url = pathToFileURL(repo).href;
    const cache = join(dir, 'cache');
    const first = await fetchDocsSources([{ slug: 'sample', docs: gitDocs(url, 'main') }], { cacheDir: cache });
    const before = /** @type {import('../src/docs/sources.js').FetchedDocs} */ (first.get('sample'));
    writeFileSync(join(repo, 'docs', 'usage.md'), '# Usage\n\nChanged.\n');
    writeFileSync(join(repo, 'docs', 'extra.md'), '# Extra\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'second']);
    const second = await fetchDocsSources([{ slug: 'sample', docs: gitDocs(url, 'main') }], { cacheDir: cache });
    const after = /** @type {import('../src/docs/sources.js').FetchedDocs} */ (second.get('sample'));
    assert.notEqual(before.source.type === 'git' && before.source.sha, after.source.type === 'git' && after.source.sha);
    assert.equal(after.source.type === 'git' && after.source.sha, git(repo, ['rev-parse', 'HEAD']));
    assert.match(readFileSync(join(after.root, 'docs', 'usage.md'), 'utf8'), /Changed\./);
    // Untracked leftovers in the cache are removed by an update.
    writeFileSync(join(after.root, 'stray.txt'), 'x');
    await fetchDocsSources([{ slug: 'sample', docs: gitDocs(url, 'main') }], { cacheDir: cache });
    assert.equal(existsSync(join(after.root, 'stray.txt')), false);
    // Following the tag moves the checkout back to the first commit.
    const tagged = await fetchDocsSources([{ slug: 'sample', docs: gitDocs(url, 'v1') }], { cacheDir: cache });
    const back = /** @type {import('../src/docs/sources.js').FetchedDocs} */ (tagged.get('sample'));
    assert.equal(back.source.type === 'git' && back.source.sha, git(repo, ['rev-parse', 'v1^{commit}']));
    assert.equal(existsSync(join(back.root, 'docs', 'extra.md')), false);
  });
});

test('a cache of another repository is replaced, and a cache folder that is not a clone is never operated on', { skip: NO_GIT }, async () => {
  await inTemp(async (dir) => {
    const repo = makeRepository(dir);
    const other = join(dir, 'other');
    cpSync(repo, other, { recursive: true });
    writeFileSync(join(other, 'marker.txt'), 'other');
    git(other, ['add', '-A']);
    git(other, ['commit', '-q', '-m', 'other']);
    const cache = join(dir, 'cache');
    await fetchDocsSources([{ slug: 'sample', docs: gitDocs(pathToFileURL(repo).href, 'main') }], { cacheDir: cache });
    const switched = await fetchDocsSources([{ slug: 'sample', docs: gitDocs(pathToFileURL(other).href, 'main') }], { cacheDir: cache });
    assert.ok(existsSync(join(/** @type {{ root: string }} */ (switched.get('sample')).root, 'marker.txt')));
    // A plain folder (no .git) inside a repository, standing where the cache entry should be.
    const outer = join(dir, 'outer');
    mkdirSync(outer);
    git(outer, ['init', '-q', '-b', 'main']);
    writeFileSync(join(outer, 'keep.txt'), 'keep');
    git(outer, ['add', '-A']);
    git(outer, ['commit', '-q', '-m', 'keep']);
    const cache2 = join(outer, 'repos');
    mkdirSync(join(cache2, 'sample'), { recursive: true });
    writeFileSync(join(cache2, 'sample', 'precious.txt'), 'x');
    writeFileSync(join(outer, 'uncommitted.txt'), 'work in progress');
    await fetchDocsSources([{ slug: 'sample', docs: gitDocs(pathToFileURL(repo).href, 'main') }], { cacheDir: cache2 });
    assert.equal(readFileSync(join(outer, 'uncommitted.txt'), 'utf8'), 'work in progress');
    assert.equal(readFileSync(join(outer, 'keep.txt'), 'utf8'), 'keep');
    assert.ok(existsSync(join(cache2, 'sample', 'docs', 'usage.md')));
  });
});

test('a cache left behind by a killed or failed update is replaced by a fresh clone instead of wedging every later build', { skip: NO_GIT }, async () => {
  await inTemp(async (dir) => {
    const repo = makeRepository(dir);
    const url = pathToFileURL(repo).href;
    const cache = join(dir, 'cache');
    const head = git(repo, ['rev-parse', 'HEAD']);
    const fetchOnce = async () => {
      const result = await fetchDocsSources([{ slug: 'sample', docs: gitDocs(url, 'main') }], { cacheDir: cache, timeoutMs: 60_000 });
      const entry = /** @type {import('../src/docs/sources.js').FetchedDocs} */ (result.get('sample'));
      assert.deepEqual(entry.source, { type: 'git', git: url, ref: 'main', sha: head });
      assert.ok(existsSync(join(entry.root, 'docs', 'usage.md')));
      return entry.root;
    };
    const checkout = await fetchOnce();
    const gitDir = join(checkout, '.git');
    // The copy is recognizable by a file in .git that an update would not remove and a fresh clone does not have.
    const damages = /** @type {[string, () => void][]} */ ([
      ['shallow.lock', () => writeFileSync(join(gitDir, 'shallow.lock'), '')],
      ['index.lock', () => writeFileSync(join(gitDir, 'index.lock'), '')],
      ['truncated .git (no HEAD, no objects)', () => {
        rmSync(join(gitDir, 'HEAD'), { force: true });
        rmSync(join(gitDir, 'objects'), { recursive: true, force: true });
      }],
      ['truncated .git (empty folder)', () => {
        rmSync(gitDir, { recursive: true, force: true });
        mkdirSync(gitDir);
      }],
    ]);
    for (const [name, damage] of damages) {
      writeFileSync(join(gitDir, 'marker'), 'old copy');
      if (name.startsWith('truncated .git (empty')) writeFileSync(join(checkout, 'stray.txt'), 'old');
      damage();
      await fetchOnce();
      assert.equal(existsSync(join(gitDir, 'marker')), false, `${name}: the old copy was reused`);
      assert.equal(existsSync(join(gitDir, 'shallow.lock')), false, name);
      assert.equal(existsSync(join(gitDir, 'index.lock')), false, name);
      assert.equal(existsSync(join(checkout, 'stray.txt')), false, name);
    }
    // And the next, undamaged update works as before.
    assert.equal(await fetchOnce(), checkout);
  });
});

test(
  'a git.exe in the folder of a path source is not run',
  { skip: process.platform !== 'win32' ? 'only Windows searches the current folder for programs' : NO_GIT },
  async () => {
    const decoy = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'whoami.exe');
    if (!existsSync(decoy)) return;
    await inTemp(async (dir) => {
      const repo = makeRepository(dir);
      // A harmless program that is not git: if it were run in place of git, no commit would be found.
      copyFileSync(decoy, join(repo, 'docs', 'git.exe'));
      const docs = checkDocsConfig({ source: { path: join('origin', 'docs') }, guides: [{ dir: '.' }] }, { dir });
      assert.ok('value' in docs);
      const saved = process.env.NoDefaultCurrentDirectoryInExePath;
      delete process.env.NoDefaultCurrentDirectoryInExePath; // The default of Windows: the current folder is searched first.
      try {
        const result = await fetchDocsSources([{ slug: 'inplace', docs: docs.value }], { cacheDir: join(dir, 'cache'), env: { ...process.env } });
        const entry = /** @type {import('../src/docs/sources.js').FetchedDocs} */ (result.get('inplace'));
        assert.deepEqual(entry.source, { type: 'path', path: join('origin', 'docs'), sha: git(repo, ['rev-parse', 'HEAD']), dirty: true }); // dirty: the decoy is an untracked file
      } finally {
        if (saved !== undefined) process.env.NoDefaultCurrentDirectoryInExePath = saved;
      }
    });
  },
);

test('a missing ref, a missing guide folder and an unreachable repository fail with the project and the address', { skip: NO_GIT }, async () => {
  await inTemp(async (dir) => {
    const repo = makeRepository(dir);
    const url = pathToFileURL(repo).href;
    const cache = join(dir, 'cache');
    /**
     * @param {import('../src/docs/sources.js').DocsConfig} docs
     * @param {string} [slug]
     * @param {number} [timeoutMs]
     * @returns {Promise<string[]>}
     */
    const failures = async (docs, slug = 'sample', timeoutMs = 30_000) => {
      try {
        await fetchDocsSources([{ slug, docs }], { cacheDir: cache, timeoutMs });
      } catch (error) {
        assert.ok(error instanceof DocsSourceError, String(error));
        return error.errors;
      }
      return assert.fail('the fetch should have failed');
    };
    const [missingRef] = await failures(gitDocs(url, 'no-such-branch'));
    assert.match(missingRef, /^project "sample": cannot fetch the docs source file:\/\/\//);
    assert.ok(missingRef.includes(url));
    assert.match(missingRef, /ref no-such-branch/);
    assert.match(missingRef, /the branch or tag does not exist in the repository/);
    assert.equal(existsSync(join(cache, 'sample')), false);

    const [missingGuide] = await failures(gitDocs(url, 'main', 'no-guides-here'));
    assert.ok(missingGuide.includes('project "sample"'));
    assert.ok(missingGuide.includes(url));
    assert.match(missingGuide, /the guide folder "no-guides-here" does not exist in the source/);

    const [notFolder] = await failures(gitDocs(url, 'main', 'README.md'));
    assert.match(notFolder, /the guide folder "README\.md" is not a folder/);

    const gone = pathToFileURL(join(dir, 'does-not-exist')).href;
    const [unreachable] = await failures(gitDocs(gone, 'main'), 'gone');
    assert.match(unreachable, /^project "gone": cannot fetch the docs source /);
    assert.ok(unreachable.includes(gone));

    const started = Date.now();
    const [refused] = await failures(gitDocs('https://user:topsecret@127.0.0.1:1/x.git', 'main'), 'refused', 20_000);
    assert.ok(Date.now() - started < 20_000);
    assert.match(refused, /^project "refused": cannot fetch the docs source https:\/\/127\.0\.0\.1:1\/x\.git \(ref main\)/);
    assert.doesNotMatch(refused, /topsecret/);
    assert.equal(existsSync(join(cache, 'refused')), false);
  });
});

test('a server that never answers is stopped at the timeout', { skip: NO_GIT }, async () => {
  /** @type {Set<import('node:net').Socket>} */
  const sockets = new Set();
  const server = createServer((socket) => {
    // Accept and say nothing.
    sockets.add(socket);
    socket.on('error', () => {});
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', () => done(undefined)));
  try {
    const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
    await inTemp(async (dir) => {
      const started = Date.now();
      await assert.rejects(
        fetchDocsSources([{ slug: 'slow', docs: gitDocs(`https://127.0.0.1:${port}/x.git`, 'main') }], { cacheDir: join(dir, 'cache'), timeoutMs: 800 }),
        (error) => {
          assert.ok(error instanceof DocsSourceError);
          assert.match(error.errors[0], /project "slow": cannot fetch the docs source https:\/\/127\.0\.0\.1:\d+\/x\.git \(ref main\): clone: git did not finish within 0\.8 s and was stopped/);
          return true;
        },
      );
      assert.ok(Date.now() - started < 15_000);
    });
  } finally {
    await new Promise((done) => {
      server.close(() => done(undefined));
      for (const socket of sockets) socket.destroy();
    });
  }
});

test('a path source is read in place; its commit comes from the repository it is in, and is null outside one', { skip: NO_GIT }, async () => {
  await inTemp(async (dir) => {
    const repo = makeRepository(dir);
    const docs = checkDocsConfig({ source: { path: join('origin', 'docs') }, guides: [{ dir: '.' }] }, { dir });
    assert.ok('value' in docs);
    const clean = await fetchDocsSources([{ slug: 'inplace', docs: docs.value }], { cacheDir: join(dir, 'cache') });
    const entry = /** @type {import('../src/docs/sources.js').FetchedDocs} */ (clean.get('inplace'));
    assert.equal(entry.root, join(repo, 'docs'));
    assert.deepEqual(entry.source, { type: 'path', path: join('origin', 'docs'), sha: git(repo, ['rev-parse', 'HEAD']), dirty: false });
    writeFileSync(join(repo, 'docs', 'usage.md'), '# changed\n');
    const dirty = await fetchDocsSources([{ slug: 'inplace', docs: docs.value }], { cacheDir: join(dir, 'cache') });
    assert.equal(/** @type {{ source: { dirty: boolean } }} */ (dirty.get('inplace')).source.dirty, true);
    assert.match(describeFetched(/** @type {import('../src/docs/sources.js').FetchedDocs} */ (dirty.get('inplace'))), /uncommitted changes/);

    const plain = join(dir, 'plain');
    mkdirSync(join(plain, 'docs'), { recursive: true });
    const outside = checkDocsConfig({ source: { path: 'plain' }, guides: [{ dir: 'docs' }] }, { dir });
    assert.ok('value' in outside);
    const none = await fetchDocsSources([{ slug: 'plain', docs: outside.value }], { cacheDir: join(dir, 'cache') });
    assert.deepEqual(/** @type {{ source: unknown }} */ (none.get('plain')).source, { type: 'path', path: 'plain', sha: null, dirty: null });
    assert.match(describeFetched(/** @type {import('../src/docs/sources.js').FetchedDocs} */ (none.get('plain'))), /not in a git repository/);

    const missingGuide = checkDocsConfig({ source: { path: 'plain' }, guides: [{ dir: 'nope' }] }, { dir });
    assert.ok('value' in missingGuide);
    await assert.rejects(
      fetchDocsSources([{ slug: 'plain', docs: missingGuide.value }], { cacheDir: join(dir, 'cache') }),
      /project "plain": docs source plain: the guide folder "nope" does not exist in the source/,
    );
    rmSync(plain, { recursive: true, force: true });
    await assert.rejects(
      fetchDocsSources([{ slug: 'plain', docs: outside.value }], { cacheDir: join(dir, 'cache') }),
      /project "plain": docs source path "plain" is not a folder or does not exist/,
    );
  });
});

test('the example fixture is a small made-up repository with the pieces the docs steps need', () => {
  for (const file of ['README.md', 'CHANGELOG.md', 'LICENSE', 'docs/getting-started.md', 'docs/usage.md', 'docs/board.png', 'src/main/kotlin/Sample.kt']) {
    assert.ok(existsSync(join(fixture, file)), file);
  }
  assert.equal(existsSync(join(fixture, '.git')), false);
  const start = readFileSync(join(fixture, 'docs', 'getting-started.md'), 'utf8');
  assert.match(start, /\]\(\.\.\/CHANGELOG\.md\)/);
  assert.match(start, /\]\(\.\.\/src\/main\/kotlin\/Sample\.kt\)/);
  assert.match(start, /!\[[^\]]*\]\(board\.png\)/);
  assert.match(readFileSync(join(fixture, 'README.md'), 'utf8'), /fixture/);
});

// --- The build and the CLI ---------------------------------------------------

const SITE_CONFIG = [
  'sites:',
  '  - id: demo',
  '    baseUrl: https://demo.example',
  '    lang: en',
  '    title: Demo',
  '    description: A demo site.',
  '    projects: { dir: content/projects }',
  '',
].join('\n');

/**
 * @param {string} docsYaml Indented lines of the `docs` block.
 * @returns {Record<string, string | Buffer>}
 */
function siteFiles(docsYaml) {
  return {
    'coffer.yaml': SITE_CONFIG,
    'content/home.md': '---\ntitle: Demo\n---\n\nAbout.\n',
    'content/projects/lathe/project.yaml': `name: Lathe\npitch: Turns wood.\nkind: tool\nstatus: released\ncard: card.png\nrepo: https://github.example/me/lathe\n${docsYaml}`,
    'content/projects/lathe/index.md': 'Text.\n',
    'content/projects/lathe/card.png': TINY_PNG,
  };
}

/**
 * @template T
 * @param {Record<string, string | Buffer>} files
 * @param {(dir: string) => Promise<T>} body
 * @returns {Promise<T>}
 */
function inSite(files, body) {
  return inTemp(async (dir) => {
    for (const [name, content] of Object.entries(files)) {
      const target = join(dir, ...name.split('/'));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    return body(dir);
  });
}

/**
 * @param {string} dir
 * @param {Parameters<typeof buildSites>[1]} [options]
 */
function build(dir, options = {}) {
  return buildSites(loadConfig({ configPath: join(dir, 'coffer.yaml') }), {
    out: join(dir, 'out'),
    now: new Date('2026-06-01T12:00:00Z'),
    ...options,
  });
}

test('a build fetches the docs source, records it in the manifest and writes no docs link before the pages exist', async () => {
  await inSite(siteFiles('docs:\n  source: { path: ../../../elsewhere }\n  github: me/lathe\n  guides:\n    - { dir: docs, order: [a.md] }\n'), async (dir) => {
    mkdirSync(join(dir, 'elsewhere', 'docs'), { recursive: true });
    const [result] = await build(dir);
    const entry = /** @type {import('../src/build.js').ManifestProject} */ (result.manifest.projects[0]);
    assert.equal(entry.docs?.source.type, 'path');
    assert.deepEqual(entry.docs?.source && 'path' in entry.docs.source ? entry.docs.source.path : null, 'elsewhere');
    assert.equal(entry.docs?.github, 'me/lathe');
    assert.deepEqual(entry.docs?.guides, [{ dir: 'docs', order: ['a.md'], include: ['**/*.md'], exclude: [] }]);
    const html = readFileSync(join(dir, 'out', 'demo', 'made', 'lathe', 'index.html'), 'utf8');
    assert.doesNotMatch(html, /project-fact-docs/);
    // With pages published by the docs step, the link appears.
    await build(dir, { docsPages: new Map([['lathe', ['index.html']]]) });
    assert.match(readFileSync(join(dir, 'out', 'demo', 'made', 'lathe', 'index.html'), 'utf8'), /href="\/made\/lathe\/docs\/"/);
  });
});

test('a project without docs has no docs entry in the manifest', async () => {
  await inSite(siteFiles(''), async (dir) => {
    const [result] = await build(dir);
    assert.equal(result.manifest.projects[0].docs, null);
  });
});

test('the build fails with the project and the address when the source cannot be fetched, and never falls back to empty docs', async () => {
  const missing = 'file:///no/such/coffer-test-repository.git';
  await inSite(siteFiles(`docs:\n  source: { git: "${missing}", ref: main }\n  guides:\n    - { dir: docs }\n`), async (dir) => {
    /** @type {string[]} */
    let errors = [];
    try {
      await build(dir, { docsFetch: { timeoutMs: 30_000 } });
      assert.fail('the build should have failed');
    } catch (error) {
      assert.ok(error instanceof DocsSourceError, String(error));
      errors = error.errors;
    }
    assert.equal(errors.length, 1);
    assert.match(errors[0], /^project "lathe": cannot fetch the docs source file:\/\/\/no\/such\/coffer-test-repository\.git \(ref main\)/);
    assert.equal(existsSync(join(dir, 'out', 'demo', 'made', 'lathe', 'index.html')), false);
  });
});

test('a missing folder for a path source fails the build naming the project file', async () => {
  await inSite(siteFiles('docs:\n  source: { path: ../../../missing }\n'), async (dir) => {
    await assert.rejects(build(dir), (error) => {
      assert.ok(error instanceof Error && 'errors' in error);
      const errors = /** @type {string[]} */ (error.errors);
      assert.match(errors[0], /lathe[\\/]project\.yaml: docs: source\.path: the folder "..\/..\/..\/missing" does not exist/);
      return true;
    });
  });
});

test('the example site fetches its docs source from the fixture folder', async () => {
  const config = loadConfig({ configPath: exampleConfig });
  const out = mkdtempSync(join(tmpdir(), 'coffer-example-docs-'));
  try {
    const [result] = await buildSites(config, { out, now: new Date('2026-06-01T12:00:00Z') });
    const tool = /** @type {import('../src/build.js').ManifestProject} */ (result.manifest.projects.find((entry) => entry.slug === 'kerfcalc'));
    assert.equal(tool.docs?.source.type, 'path');
    assert.equal(tool.docs?.source && 'path' in tool.docs.source ? tool.docs.source.path : '', 'sample-tool');
    assert.equal(tool.docs?.github, 'tove-marlowe/kerfcalc');
    assert.deepEqual(tool.docs?.guides.map((guide) => guide.dir), ['docs']);
    assert.equal(manifestDocs(/** @type {never} */ ({ ...tool.docs, root: fixture, source: { type: 'path', path: 'x', sha: null, dirty: null }, github: null, guides: [] }), config.dir).source.type, 'path');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

/**
 * @param {string[]} argv
 * @param {import('../src/cli.js').Services} [services]
 */
async function runCli(argv, services = {}) {
  let out = '';
  let err = '';
  const code = await run(argv, { out: (text) => (out += text), err: (text) => (err += text) }, services);
  return { code, out, err };
}

test('coffer docs fetch parses its options', () => {
  assert.deepEqual(parseDocsFetchArgs([]), {});
  assert.deepEqual(parseDocsFetchArgs(['--config', 'a.yaml', '--project=lathe']), { configPath: 'a.yaml', project: 'lathe' });
  assert.deepEqual(parseDocsFetchArgs(['--project']), { error: '--project needs a value' });
  assert.deepEqual(parseDocsFetchArgs(['--force']), { error: 'unexpected argument "--force"' });
});

test('coffer docs fetch prints the commit of each docs source of the example', async () => {
  const result = await runCli(['docs', 'fetch', '--config', exampleConfig]);
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /^kerfcalc: (?:[0-9a-f]{40}|not in a git repository) \(\.\.\/\.\.\/\.\.\/sample-tool(?:, uncommitted changes)?\)\n$/);
  const one = await runCli(['docs', 'fetch', '--config', exampleConfig, '--project', 'kerfcalc']);
  assert.equal(one.code, 0);
  const none = await runCli(['docs', 'fetch', '--config', exampleConfig, '--project', 'tenon-tumble']);
  assert.equal(none.code, 1);
  assert.match(none.err, /no project "tenon-tumble" with a docs source/);
  assert.equal((await runCli(['docs'])).code, 1);
  assert.match((await runCli(['docs', 'pull'])).err, /unknown docs subcommand "pull"/);
  assert.match((await runCli(['docs', 'fetch', '--bogus'])).err, /unexpected argument "--bogus"/);
});

test('coffer docs fetch reports every failing project and exits 1', async () => {
  const files = siteFiles('docs:\n  source: { git: "file:///no/such/one.git", ref: main }\n');
  files['content/projects/plane/project.yaml'] = String(files['content/projects/lathe/project.yaml'])
    .replace('name: Lathe', 'name: Plane')
    .replace('file:///no/such/one.git', 'file:///no/such/two.git');
  files['content/projects/plane/index.md'] = 'Text.\n';
  files['content/projects/plane/card.png'] = TINY_PNG;
  await inSite(files, async (dir) => {
    const result = await runCli(['docs', 'fetch', '--config', join(dir, 'coffer.yaml')], { docs: { timeoutMs: 30_000 } });
    assert.equal(result.code, 1);
    assert.equal(result.out, '');
    const lines = result.err.trim().split('\n');
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^project "lathe": .*one\.git/);
    assert.match(lines[1], /^project "plane": .*two\.git/);
  });
});

/**
 * A site configuration with a second site whose projects are in content2/, and the same project folder name in both.
 *
 * @param {string} firstDocs Indented lines of the first site's docs block.
 * @param {string} secondDocs The second site's.
 * @returns {Record<string, string | Buffer>}
 */
function twoSiteFiles(firstDocs, secondDocs) {
  const files = siteFiles(firstDocs);
  files['coffer.yaml'] =
    SITE_CONFIG +
    [
      '  - id: second',
      '    baseUrl: https://second.example',
      '    lang: en',
      '    title: Second',
      '    description: Another site.',
      '    contentDir: content2',
      '    projects: { dir: content2/projects }',
      '',
    ].join('\n');
  files['content2/home.md'] = files['content/home.md'];
  const first = String(files['content/projects/lathe/project.yaml']);
  files['content2/projects/lathe/project.yaml'] = first.slice(0, first.indexOf('docs:')) + secondDocs;
  files['content2/projects/lathe/index.md'] = files['content/projects/lathe/index.md'];
  files['content2/projects/lathe/card.png'] = files['content/projects/lathe/card.png'];
  return files;
}

/**
 * A replacement for git that clones nothing but makes a checkout with some folders; it counts the clones.
 *
 * @param {string[]} folders Folders the "clone" has.
 * @returns {{ exec: NonNullable<import('../src/docs/sources.js').FetchOptions['exec']>, clones: string[][] }}
 */
function fakeGit(folders) {
  /** @type {string[][]} */
  const clones = [];
  /** @type {NonNullable<import('../src/docs/sources.js').FetchOptions['exec']>} */
  const exec = async (args) => {
    if (args.includes('clone')) {
      clones.push(args);
      for (const folder of folders) mkdirSync(join(String(args.at(-1)), folder), { recursive: true });
      return { code: 0, stdout: '', stderr: '', timedOut: false };
    }
    if (args.includes('rev-parse')) return { code: 0, stdout: 'd'.repeat(40), stderr: '', timedOut: false };
    return { code: 1, stdout: '', stderr: '', timedOut: false };
  };
  return { exec, clones };
}

test('coffer docs fetch reports two sites that share a project folder name and use different git sources', async () => {
  const cases = [
    ['a different address', 'https://example.org/a/other.git', 'main'],
    ['a different ref', 'https://example.org/a/one.git', 'v2'],
  ];
  for (const [label, url, ref] of cases) {
    const files = twoSiteFiles(
      'docs:\n  source: { git: "https://tok:SECRETPW@example.org/a/one.git", ref: main }\n',
      `docs:\n  source: { git: "${url}", ref: ${ref} }\n`,
    );
    await inSite(files, async (dir) => {
      const fake = fakeGit(['docs']);
      const result = await runCli(['docs', 'fetch', '--config', join(dir, 'coffer.yaml')], { docs: { exec: fake.exec } });
      assert.equal(result.code, 1, label);
      assert.equal(result.out, '', label);
      assert.equal(fake.clones.length, 0, 'nothing is fetched when the sources conflict');
      const lines = result.err.trim().split('\n');
      assert.equal(lines.length, 1, label);
      assert.match(lines[0], /^project "lathe": site "second" configures the docs source /, label);
      assert.ok(lines[0].includes(`${url} (ref ${ref})`), `${label}: names the address of the later site`);
      assert.ok(lines[0].includes('https://example.org/a/one.git (ref main)'), `${label}: names the address of the earlier site, without credentials`);
      assert.doesNotMatch(result.err, /SECRETPW|tok:/, label);
    });
  }
});

test('coffer docs fetch fetches the same git source once when two sites configure different guides', async () => {
  const files = twoSiteFiles(
    'docs:\n  source: { git: "https://example.org/a/one.git", ref: main }\n  guides:\n    - { dir: docs }\n',
    'docs:\n  source: { git: "https://example.org/a/one.git", ref: main }\n  guides:\n    - { dir: docs, order: [usage.md] }\n    - { dir: de }\n',
  );
  await inSite(files, async (dir) => {
    const fake = fakeGit(['docs', 'de']);
    const result = await runCli(['docs', 'fetch', '--config', join(dir, 'coffer.yaml')], { docs: { exec: fake.exec } });
    assert.equal(result.code, 0, result.err);
    assert.equal(fake.clones.length, 1);
    assert.equal(result.out, `lathe: ${'d'.repeat(40)} (https://example.org/a/one.git, ref main)\n`);
  });
  // The guide folders of both sites are checked against the one checkout.
  await inSite(files, async (dir) => {
    const fake = fakeGit(['docs']);
    const result = await runCli(['docs', 'fetch', '--config', join(dir, 'coffer.yaml')], { docs: { exec: fake.exec } });
    assert.equal(result.code, 1);
    assert.match(result.err, /^project "lathe": docs source https:\/\/example\.org\/a\/one\.git \(ref main\): the guide folder "de" does not exist in the source/);
  });
});

test('coffer docs fetch accepts the same folder source in two sites with different guides', async () => {
  const files = twoSiteFiles(
    'docs:\n  source: { path: ../../../elsewhere }\n  guides:\n    - { dir: docs }\n',
    'docs:\n  source: { path: ../../../elsewhere }\n  guides:\n    - { dir: docs, order: [usage.md] }\n',
  );
  await inSite(files, async (dir) => {
    mkdirSync(join(dir, 'elsewhere', 'docs'), { recursive: true });
    const result = await runCli(['docs', 'fetch', '--config', join(dir, 'coffer.yaml')]);
    assert.equal(result.code, 0, result.err);
  });
});

test('coffer docs fetch fetches folder sources that differ although the project folder name is the same', async () => {
  const files = twoSiteFiles(
    'docs:\n  source: { path: ../../../elsewhere }\n  guides:\n    - { dir: docs }\n',
    'docs:\n  source: { path: ../../elsewhere2 }\n  guides:\n    - { dir: docs }\n',
  );
  await inSite(files, async (dir) => {
    mkdirSync(join(dir, 'elsewhere', 'docs'), { recursive: true });
    mkdirSync(join(dir, 'content2', 'elsewhere2', 'docs'), { recursive: true });
    const result = await runCli(['docs', 'fetch', '--config', join(dir, 'coffer.yaml')]);
    assert.equal(result.code, 0, result.err);
    assert.equal(result.out.trim().split('\n').length, 2);
    // A guide folder that is missing in the second one is not lost behind the first.
    rmSync(join(dir, 'content2', 'elsewhere2', 'docs'), { recursive: true });
    const missing = await runCli(['docs', 'fetch', '--config', join(dir, 'coffer.yaml')]);
    assert.equal(missing.code, 1);
    assert.match(missing.err, /the guide folder "docs" does not exist in the source/);
  });
});

test('planDocsFetch flags only git sources that share a folder name and differ in address or ref', () => {
  /**
   * @param {string} site
   * @param {Record<string, unknown>} source
   * @param {unknown[]} [guides]
   */
  const entry = (site, source, guides = [{ dir: 'docs' }]) => {
    const checked = checkDocsConfig({ source, guides }, { dir: root });
    assert.ok('value' in checked, 'problem' in checked ? checked.problem : '');
    return { site, slug: 'lathe', docs: checked.value };
  };
  const one = { git: 'https://example.org/a/b.git', ref: 'main' };
  const same = planDocsFetch([entry('a', one), entry('b', one, [{ dir: 'docs', order: ['x.md'] }, { dir: 'de' }])]);
  assert.deepEqual(same.conflicts, []);
  assert.equal(same.runs.length, 1);
  assert.deepEqual(same.runs[0].map((item) => item.docs.guides.map((guide) => guide.dir)), [['docs', 'de']]);
  const otherRef = planDocsFetch([entry('a', one), entry('b', { ...one, ref: 'v2' })]);
  assert.equal(otherRef.conflicts.length, 1);
  assert.match(otherRef.conflicts[0], /^project "lathe": site "b" configures .*\(ref v2\), but site "a" has .*\(ref main\)/);
  const otherUrl = planDocsFetch([entry('a', one), entry('b', { ...one, git: 'git@example.org:a/b.git' })]);
  assert.equal(otherUrl.conflicts.length, 1);
  // A folder source never conflicts with anything, and a git source and a folder source with the same name are fetched in separate runs.
  const mixed = planDocsFetch([entry('a', one), entry('b', { path: '.' }), entry('c', { path: 'example' })]);
  assert.deepEqual(mixed.conflicts, []);
  assert.equal(mixed.runs.length, 3);
  assert.ok(mixed.runs.every((run) => new Set(run.map((item) => item.slug)).size === run.length));
});

test('coffer docs fetch clones a git source into .cache/repos next to the configuration', { skip: NO_GIT }, async () => {
  await inTemp(async (parent) => {
    const repo = makeRepository(parent);
    const url = pathToFileURL(repo).href;
    await inSite(siteFiles(`docs:\n  source: { git: "${url}", ref: v1 }\n  guides:\n    - { dir: docs }\n`), async (dir) => {
      const result = await runCli(['docs', 'fetch', '--config', join(dir, 'coffer.yaml')]);
      assert.equal(result.code, 0, result.err);
      assert.equal(result.out, `lathe: ${git(repo, ['rev-parse', 'HEAD'])} (${url}, ref v1)\n`);
      assert.ok(existsSync(join(dir, '.cache', 'repos', 'lathe', 'docs', 'usage.md')));
      const [built] = await build(dir);
      const docs = built.manifest.projects[0].docs;
      assert.deepEqual(docs?.source, { type: 'git', git: url, ref: 'v1', sha: git(repo, ['rev-parse', 'HEAD']) });
    });
  });
});
