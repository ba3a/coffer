import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { buildSites } from '../../src/build.js';
import { applyLinkRewrites, checkSourceLinks } from '../../src/check/source-links.js';
import { run } from '../../src/cli.js';
import { loadConfig } from '../../src/config.js';
import { ReportError } from '../../src/report.js';
import { TINY_JPEG, TINY_PNG } from '../helpers/images.js';

const NOW = new Date('2026-06-01T12:00:00Z');

const CONFIG = [
  'sites:',
  '  - id: demo',
  '    baseUrl: https://demo.example',
  '    lang: en',
  '    title: Demo',
  '    contentLicense: Some rights reserved',
  '    blogs:',
  '      - { id: journal, dir: content/journal, prefix: journal, title: Journal }',
  '    projects: { dir: content/projects }',
  '',
].join('\n');

/**
 * Writes a tree of files, runs `body` with its root, and removes the tree.
 *
 * @param {Record<string, string | Buffer>} files Relative path (forward slashes) to content.
 * @param {(root: string) => Promise<void>} body
 */
async function inTree(files, body) {
  const root = mkdtempSync(join(tmpdir(), 'coffer-links-'));
  try {
    mkdirSync(join(root, 'content', 'projects'), { recursive: true });
    for (const [name, content] of Object.entries({ 'coffer.yaml': CONFIG, ...files })) {
      const target = join(root, ...name.split('/'));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    await body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * A post whose body starts on line 6, after four lines of front matter and a blank line.
 *
 * @param {string} body
 * @param {string} [extra] More front matter lines.
 * @returns {string}
 */
function post(body, extra = '') {
  return `---\ntitle: A post\ndate: 2026-01-10\n${extra}---\n\n${body}\n`;
}

/**
 * @param {string} root
 * @param {{ drafts?: boolean }} [options]
 */
function build(root, options = {}) {
  return buildSites(loadConfig({ configPath: join(root, 'coffer.yaml') }), {
    out: join(root, 'out'),
    now: NOW,
    ...options,
  });
}

/**
 * Runs a build that must fail because of its sources and returns the errors it reports.
 *
 * @param {string} root
 * @param {{ drafts?: boolean }} [options]
 * @returns {Promise<string[]>}
 */
async function buildErrors(root, options = {}) {
  try {
    await build(root, options);
  } catch (error) {
    assert.ok(error instanceof ReportError, `expected a ReportError, got ${error}`);
    return error.errors;
  }
  return assert.fail('the build should have failed');
}

/**
 * @param {string} root
 * @param {string} url Site-relative URL of a page.
 * @returns {string}
 */
function pageHtml(root, url) {
  return readFileSync(join(root, 'out', 'demo', ...url.split('/').filter(Boolean), 'index.html'), 'utf8');
}

const target = post('The target.\n\n## A heading\n\n<a id="manual"></a>');

test('relative links between posts become canonical URLs, anchors and queries kept', async () => {
  await inTree(
    {
      'content/journal/foo/index.md': post(
        [
          '[folder](../bar/) [no slash](../bar) [index](../bar/index.md) [anchor](../bar/index.md#a-heading)',
          '[single file](../single.md) [single as folder](../single/) [query](../bar/?x=1#manual)',
          '[self](./) [self anchor](#own) [top](#top)',
          '',
          '## Own',
        ].join('\n'),
      ),
      'content/journal/bar/index.md': target,
      'content/journal/single.md': post('Single.'),
    },
    async (root) => {
      await build(root);
      const html = pageHtml(root, '/journal/foo/');
      for (const href of [
        '/journal/bar/',
        '/journal/bar/#a-heading',
        '/journal/single/',
        '/journal/bar/?x=1#manual',
        '/journal/foo/',
        '#own',
        '#top',
      ]) {
        assert.ok(html.includes(`href="${href}"`), `${href} in ${html}`);
      }
      assert.ok(!html.includes('index.md'), html);
      assert.ok(!html.includes('../'), html);
      assert.equal(html.split('href="/journal/bar/"').length - 1, 3, 'three links to the folder form');
    },
  );
});

test('links reach posts of another blog and Cyrillic folders and headings', async () => {
  await inTree(
    {
      'coffer.yaml': CONFIG.replace(
        '    projects:',
        '      - { id: other, dir: content/other, prefix: other, title: Other }\n    projects:',
      ),
      'content/journal/foo/index.md': post('[там](../../other/привет/#заголовок) и [здесь](#мой-раздел)\n\n## Мой раздел'),
      'content/other/привет/index.md': post('## Заголовок'),
    },
    async (root) => {
      await build(root);
      const html = pageHtml(root, '/journal/foo/');
      assert.ok(html.includes('href="/other/привет/#%D0%B7%D0%B0%D0%B3%D0%BE%D0%BB%D0%BE%D0%B2%D0%BE%D0%BA"'), html);
    },
  );
});

test('a broken relative link fails the build with file, line and column', async () => {
  await inTree(
    {
      'content/journal/foo/index.md': post('See [the other post](../bar/) now.'),
    },
    async (root) => {
      assert.deepEqual(await buildErrors(root), [
        "content/journal/foo/index.md:6:5 broken link '../bar/'",
      ]);
    },
  );
});

test('every broken link is reported, in one failure, with its own position', async () => {
  await inTree(
    {
      'content/journal/foo/index.md': post(
        ['First line.', '', 'A [gone](../gone/) link and a [second](../nope.md) one.', '', '* [list](../third/)'].join('\n'),
      ),
      'content/journal/other.md': post('Fine. [bad](../x/)'),
    },
    async (root) => {
      assert.deepEqual(await buildErrors(root), [
        "content/journal/foo/index.md:8:3 broken link '../gone/'",
        "content/journal/foo/index.md:8:31 broken link '../nope.md'",
        "content/journal/foo/index.md:10:3 broken link '../third/'",
        "content/journal/other.md:6:7 broken link '../x/'",
      ]);
    },
  );
});

test('the command line prints the errors and exits with 1', async () => {
  await inTree(
    { 'content/journal/foo/index.md': post('[gone](../bar/)') },
    async (root) => {
      let err = '';
      const code = await run(['build', '--config', join(root, 'coffer.yaml'), '--out', join(root, 'out')], {
        out: () => {},
        err: (text) => {
          err += text;
        },
      });
      assert.equal(code, 1);
      assert.equal(err, "content/journal/foo/index.md:6:1 broken link '../bar/'\n");
    },
  );
});

test('a missing image fails the build and points at the post file', async () => {
  await inTree(
    {
      'content/journal/foo/index.md': post('Text.\n\n![A hill](hill.jpg "caption") and ![ok](here.png)'),
      'content/journal/foo/here.png': TINY_PNG,
    },
    async (root) => {
      assert.deepEqual(await buildErrors(root), [
        "content/journal/foo/index.md:8:1 missing image 'hill.jpg'",
      ]);
    },
  );
});

test('an image beside the post, in a shared folder or with a space in its name passes', async () => {
  await inTree(
    {
      'content/journal/foo/index.md': post('![a](hill.jpg) ![b](../shared/bench.jpg) ![c](<my photo.jpg>) ![d](https://x.example/p.png)'),
      'content/journal/foo/hill.jpg': TINY_JPEG,
      'content/journal/foo/my photo.jpg': TINY_JPEG,
      'content/journal/shared/bench.jpg': TINY_JPEG,
      'content/journal/shared/index.md': post('Shared.'),
    },
    async (root) => {
      await build(root);
    },
  );
});

test('an image outside the content directory is an error', async () => {
  await inTree(
    {
      'content/journal/foo/index.md': post('![escape](../../../secret.png)'),
      'secret.png': TINY_PNG,
    },
    async (root) => {
      assert.deepEqual(await buildErrors(root), [
        "content/journal/foo/index.md:6:1 missing image '../../../secret.png' (outside the content directory)",
      ]);
    },
  );
});

test('a folder is not an image', async () => {
  await inTree(
    { 'content/journal/foo/index.md': post('![dir](./)'), },
    async (root) => {
      assert.deepEqual(await buildErrors(root), ["content/journal/foo/index.md:6:1 missing image './'"]);
    },
  );
});

test('an anchor must name a heading of the post, or an id in its raw HTML', async () => {
  await inTree(
    {
      'content/journal/foo/index.md': post(
        '[ok](#real) [raw](#by-hand) [bad](#nothing)\n\n## Real\n\n<span id="by-hand"></span>',
      ),
    },
    async (root) => {
      assert.deepEqual(await buildErrors(root), [
        "content/journal/foo/index.md:6:29 broken link '#nothing' (this post has no heading or id 'nothing')",
      ]);
    },
  );
});

test('an anchor on a link to another post must name something in that post', async () => {
  await inTree(
    {
      'content/journal/foo/index.md': post('[ok](../bar/#a-heading) [bad](../bar/#missing)'),
      'content/journal/bar/index.md': target,
    },
    async (root) => {
      assert.deepEqual(await buildErrors(root), [
        "content/journal/foo/index.md:6:25 broken link '../bar/#missing' (the target post has no heading or id 'missing')",
      ]);
    },
  );
});

test('a link to a Markdown file that is not a post, or to a missing folder, fails', async () => {
  await inTree(
    {
      'content/journal/foo/index.md': post('[notes](notes.md) [folder](../empty/) [download](data.csv)'),
      'content/journal/foo/notes.md': '# Notes',
      'content/journal/foo/data.csv': 'a,b',
      'content/journal/empty/readme.txt': 'nothing',
    },
    async (root) => {
      assert.deepEqual(await buildErrors(root), [
        "content/journal/foo/index.md:6:1 broken link 'notes.md' (this Markdown file is not a post)",
        "content/journal/foo/index.md:6:19 broken link '../empty/'",
      ]);
    },
  );
});

test('a link outside the content directory fails', async () => {
  await inTree(
    {
      'content/journal/foo/index.md': post('[readme](../../../README.md)'),
      'README.md': '# Readme',
    },
    async (root) => {
      assert.deepEqual(await buildErrors(root), [
        "content/journal/foo/index.md:6:1 broken link '../../../README.md' (outside the content directory)",
      ]);
    },
  );
});

test('site-absolute links must hit a page or a file of the built site', async () => {
  await inTree(
    {
      'content/journal/foo/index.md': post(
        [
          '[post](/journal/bar/) [no slash](/journal/bar) [index](/journal/) [home](/) [tags](/journal/tags/)',
          '[feed](/journal/feed.xml) [asset](/assets/coffer.css) [anchor](/journal/bar/#a-heading)',
          '[gone](/journal/nope/) [anchor gone](/journal/bar/#nope) ![img](/img/none.png)',
        ].join('\n'),
      ),
      'content/journal/bar/index.md': target,
    },
    async (root) => {
      assert.deepEqual(await buildErrors(root), [
        "content/journal/foo/index.md:8:1 broken link '/journal/nope/'",
        "content/journal/foo/index.md:8:24 broken link '/journal/bar/#nope' (the target post has no heading or id 'nope')",
        "content/journal/foo/index.md:8:58 missing image '/img/none.png'",
      ]);
    },
  );
});

test('a link to a draft or a scheduled post fails a normal build and passes in preview mode', async () => {
  await inTree(
    {
      'content/journal/foo/index.md': post('[draft](../wip/) [later](../soon/) [draft anchor](../wip/#a-heading) [abs](/journal/wip/)'),
      'content/journal/wip/index.md': post('## A heading', 'draft: true\n'),
      'content/journal/soon/index.md': `---\ntitle: Soon\ndate: 2099-01-01\n---\n\nLater.\n`,
    },
    async (root) => {
      assert.deepEqual(await buildErrors(root), [
        "content/journal/foo/index.md:6:1 broken link '../wip/' (the post is a draft)",
        "content/journal/foo/index.md:6:18 broken link '../soon/' (the post is not published yet)",
        "content/journal/foo/index.md:6:36 broken link '../wip/#a-heading' (the post is a draft)",
        "content/journal/foo/index.md:6:70 broken link '/journal/wip/' (the post is a draft)",
      ]);
      const [result] = await build(root, { drafts: true });
      const html = readFileSync(join(result.outDir, 'journal', 'foo', 'index.html'), 'utf8');
      assert.ok(html.includes('href="/journal/wip/"'));
      assert.ok(html.includes('href="/journal/soon/"'));
      assert.ok(html.includes('href="/journal/wip/#a-heading"'));
    },
  );
});

test('a project reference must name a registered project', async () => {
  await inTree(
    {
      'content/journal/foo/index.md': post('[tool](project:lathe) [gone](project:nope#x) ![pic](project:nope)'),
      'content/projects/lathe/project.yaml':
        'name: Lathe\npitch: Turns wood.\nkind: tool\nstatus: released\ncard: card.png\nrepo: https://github.example/me/lathe\n',
      'content/projects/lathe/index.md': 'The lathe.\n',
      'content/projects/lathe/card.png': TINY_PNG,
    },
    async (root) => {
      assert.deepEqual(await buildErrors(root), [
        "content/journal/foo/index.md:6:23 unknown project 'nope' in 'project:nope#x' (registered: lathe)",
        "content/journal/foo/index.md:6:46 unknown project 'nope' in 'project:nope' (registered: lathe)",
      ]);
    },
  );
});

test('a project reference on a site without projects fails and says so', async () => {
  await inTree(
    {
      'coffer.yaml': CONFIG.replace('    projects: { dir: content/projects }\n', ''),
      'content/journal/foo/index.md': post('[tool](project:lathe)'),
    },
    async (root) => {
      assert.deepEqual(await buildErrors(root), [
        "content/journal/foo/index.md:6:1 unknown project 'lathe' in 'project:lathe' (the site has no projects)",
      ]);
    },
  );
});

test('external links, mail links and plathecol-relative links are not checked', async () => {
  await inTree(
    {
      'content/journal/foo/index.md': post(
        '[a](https://example.com/x) [b](mailto:me@example.com) [c](tel:+123) [d](//cdn.example/x.js) ![e](data:image/gif;base64,R0lGODlhAQABAAAAACw=) [f]()\n\n[g]: https://example.com/',
      ),
    },
    async (root) => {
      await build(root);
    },
  );
});

test('links inside code and footnote references are not checked', async () => {
  await inTree(
    {
      'content/journal/foo/index.md': post('`[x](../gone/)` and a note[^1]\n\n```md\n[y](../gone/)\n```\n\n[^1]: The note.'),
    },
    async (root) => {
      await build(root);
    },
  );
});

test('the report file lists errors, warnings and info, outside the output', async () => {
  await inTree(
    {
      'content/journal/foo/index.md': post('[gone](../bar/)', 'cover: missing.jpg\n'),
    },
    async (root) => {
      await buildErrors(root);
      const reportFile = join(root, '.coffer', 'report.json');
      const report = JSON.parse(readFileSync(reportFile, 'utf8'));
      assert.equal(report.reportVersion, 1);
      assert.deepEqual(report.errors, [
        {
          site: 'demo',
          file: 'content/journal/foo/index.md',
          line: 7,
          column: 1,
          message: "broken link '../bar/'",
        },
      ]);
      assert.equal(report.warnings.length, 1);
      assert.match(report.warnings[0].message, /cover: "missing\.jpg" does not exist/);
      assert.deepEqual(report.info, [{ site: 'demo', message: '1 post(s), 6 page(s) built' }]);
      assert.ok(!existsSync(join(root, 'out', '.coffer')));
    },
  );
});

test('a good build writes a report with no errors and an info line, and a report dir can be chosen', async () => {
  await inTree(
    { 'content/journal/foo/index.md': post('Fine.') },
    async (root) => {
      await buildSites(loadConfig({ configPath: join(root, 'coffer.yaml') }), {
        out: join(root, 'out'),
        now: NOW,
        reportDir: join(root, 'elsewhere'),
      });
      const report = JSON.parse(readFileSync(join(root, 'elsewhere', 'report.json'), 'utf8'));
      assert.deepEqual(report.errors, []);
      assert.equal(report.info.length, 1);
      assert.equal(report.info[0].site, 'demo');
      assert.ok(!existsSync(join(root, '.coffer')));
    },
  );
});

test('a build that fails for another reason is also recorded in the report', async () => {
  await inTree(
    { 'content/journal/foo/index.md': '---\ntitle: No date\n---\n\nText.\n' },
    async (root) => {
      await assert.rejects(build(root));
      const report = JSON.parse(readFileSync(join(root, '.coffer', 'report.json'), 'utf8'));
      assert.equal(report.errors.length, 1);
      assert.match(report.errors[0].message, /date: is required/);
    },
  );
});

test('checkSourceLinks works on plain data and applyLinkRewrites only touches link hrefs', () => {
  const dir = join(tmpdir(), 'coffer-links-pure');
  const foo = { slug: 'foo', kind: /** @type {const} */ ('folder'), file: join(dir, 'c', 'j', 'foo', 'index.md'), dir: join(dir, 'c', 'j', 'foo') };
  const bar = { slug: 'bar', kind: /** @type {const} */ ('file'), file: join(dir, 'c', 'j', 'bar.md'), dir: join(dir, 'c', 'j'), draft: false };
  const result = checkSourceLinks({
    posts: [
      {
        post: /** @type {any} */ ({ ...foo, draft: false }),
        url: '/j/foo/',
        rendered: {
          ids: [],
          links: [
            { url: '../bar.md#x', kind: 'link', line: 3, column: 2 },
            { url: '../baz/', kind: 'link', line: 4, column: 7 },
          ],
        },
      },
      { post: /** @type {any} */ (bar), url: '/j/bar/', rendered: { ids: ['x'], links: [] } },
    ],
    rootDir: dir,
    contentDir: join(dir, 'c'),
    projects: new Set(),
  });
  assert.deepEqual(result.issues, [
    { file: 'c/j/foo/index.md', line: 4, column: 7, message: "broken link '../baz/'" },
  ]);
  const [rewrites] = [...result.rewrites.values()];
  assert.deepEqual([...rewrites], [['../bar.md#x', '/j/bar/#x']]);
  const html = '<a href="../bar.md#x">x</a> <img src="../bar.md#x"> <a href="other">y</a>';
  assert.equal(
    applyLinkRewrites(html, rewrites),
    '<a href="/j/bar/#x">x</a> <img src="../bar.md#x"> <a href="other">y</a>',
  );
  assert.equal(applyLinkRewrites(html, undefined), html);
});
