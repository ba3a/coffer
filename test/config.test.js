import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { run } from '../src/cli.js';
import {
  ConfigError,
  findConfigFile,
  loadConfig,
  normalizeConfig,
} from '../src/config.js';

const bin = fileURLToPath(new URL('../bin/coffer.js', import.meta.url));

/**
 * Creates a temporary directory holding `coffer.yaml` with the given text.
 *
 * @param {string} yaml
 * @param {string} [name]
 * @returns {string} The directory.
 */
function project(yaml, name = 'coffer.yaml') {
  const dir = mkdtempSync(join(tmpdir(), 'coffer-config-'));
  writeFileSync(join(dir, name), yaml);
  return dir;
}

/**
 * @param {string} yaml
 * @param {(dir: string) => void} body
 */
function withProject(yaml, body) {
  const dir = project(yaml);
  try {
    body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * @param {() => unknown} action
 * @returns {string[]}
 */
function errorsOf(action) {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof ConfigError, String(error));
    return error.errors;
  }
  assert.fail('expected a ConfigError');
}

/**
 * Normalizes a document as if it lived in `/work/coffer.yaml`.
 *
 * @param {unknown} raw
 */
function normalize(raw) {
  return normalizeConfig(raw, { file: resolve('/work/coffer.yaml') });
}

/**
 * @param {unknown} raw
 * @returns {string[]}
 */
function normalizeErrors(raw) {
  return errorsOf(() => normalize(raw));
}

const MINIMAL = {
  sites: [{ id: 'main', baseUrl: 'https://example.org', title: 'Main' }],
};

/**
 * @param {Record<string, unknown>} overrides Merged over the minimal site.
 */
function oneSite(overrides) {
  return { sites: [{ ...MINIMAL.sites[0], ...overrides }] };
}

const TWO_SITES = `
sites:
  - id: english
    baseUrl: https://example.org/
    lang: en
    timezone: Europe/Samara
    title: Example Maker
    description: Things made and written about.
    contentDir: content/english
    theme: themes/crisp
    contentLicense: All rights reserved
    links:
      - { label: Code, url: https://example.com/maker }
      - { label: Mail, url: "mailto:maker@example.org" }
    blogs:
      - { id: journal, dir: content/english/journal, prefix: journal, title: Journal }
    urls: { projects: built, docs: manual }
    location: { default: coarse, camera: keep }
    projects: { dir: content/english/projects }
  - id: russian
    baseUrl: https://my.example.org
    lang: ru
    title: Заметки
    contentDir: content/russian
    blogs:
      - { id: notes, dir: content/russian, prefix: "" }
`;

test('a valid two-site configuration loads with its values', () => {
  withProject(TWO_SITES, (dir) => {
    const config = loadConfig({ cwd: dir });
    assert.equal(config.file, join(dir, 'coffer.yaml'));
    assert.equal(config.dir, dir);
    assert.equal(config.sites.length, 2);

    const [english, russian] = config.sites;
    assert.equal(english.id, 'english');
    assert.equal(english.baseUrl, 'https://example.org');
    assert.equal(english.lang, 'en');
    assert.equal(english.timezone, 'Europe/Samara');
    assert.equal(english.title, 'Example Maker');
    assert.equal(english.description, 'Things made and written about.');
    assert.equal(english.contentDir, join(dir, 'content/english'));
    assert.equal(english.theme, join(dir, 'themes/crisp'));
    assert.equal(english.contentLicense, 'All rights reserved');
    assert.deepEqual(english.links, [
      { label: 'Code', url: 'https://example.com/maker' },
      { label: 'Mail', url: 'mailto:maker@example.org' },
    ]);
    assert.deepEqual(english.blogs, [
      {
        id: 'journal',
        dir: join(dir, 'content/english/journal'),
        prefix: 'journal',
        title: 'Journal',
      },
    ]);
    assert.deepEqual(english.urls, {
      projects: 'built',
      docs: 'manual',
      tags: 'tags',
      series: 'series',
    });
    assert.deepEqual(english.location, { default: 'coarse', camera: 'keep' });
    assert.deepEqual(english.projects, {
      dir: join(dir, 'content/english/projects'),
    });

    assert.equal(russian.id, 'russian');
    assert.equal(russian.lang, 'ru');
    assert.equal(russian.baseUrl, 'https://my.example.org');
    assert.equal(russian.title, 'Заметки');
  });
});

test('two sites keep their own languages and settings', () => {
  withProject(TWO_SITES, (dir) => {
    const [english, russian] = loadConfig({ cwd: dir }).sites;
    assert.notEqual(english.lang, russian.lang);
    assert.equal(russian.timezone, 'UTC');
    assert.equal(russian.theme, null);
    assert.deepEqual(russian.location, { default: 'strip', camera: 'strip' });
    assert.equal(russian.urls.projects, 'made');
    assert.equal(russian.projects, null);
    assert.equal(russian.blogs[0].prefix, '');
    assert.equal(russian.blogs[0].title, 'Заметки');
  });
});

test('defaults are applied to a minimal site', () => {
  const config = normalize(MINIMAL);
  assert.deepEqual(config.sites[0], {
    id: 'main',
    baseUrl: 'https://example.org',
    lang: 'en',
    timezone: 'UTC',
    title: 'Main',
    description: '',
    contentDir: resolve('/work/content'),
    theme: null,
    contentLicense: '',
    defaultImage: '/assets/social-default.png',
    author: { name: 'Main', email: null, url: null },
    feeds: { limit: 20 },
    links: [],
    blogs: [],
    urls: { projects: 'made', docs: 'docs', tags: 'tags', series: 'series' },
    location: { default: 'strip', camera: 'strip' },
    images: {
      widths: [480, 800, 1200, 1600, 2400],
      viewerMaxEdge: 3200,
      webpQuality: 80,
      jpegQuality: 85,
      sizes: '(min-width: 44rem) 41rem, calc(100vw - 2rem)',
      carouselSizes: '(min-width: 44rem) 41rem, calc(100vw - 2rem)',
    },
    tracks: { tolerance: 10, elevationThreshold: 3 },
    projects: null,
  });
});

test('blog defaults: dir and prefix follow the id, title follows the site', () => {
  const config = normalize(oneSite({ blogs: [{ id: 'devlog' }] }));
  assert.deepEqual(config.sites[0].blogs, [
    {
      id: 'devlog',
      dir: resolve('/work/devlog'),
      prefix: 'devlog',
      title: 'Main',
    },
  ]);
});

test('an empty prefix is kept as the root blog', () => {
  const config = normalize(
    oneSite({ blogs: [{ id: 'root', dir: 'posts', prefix: '' }] }),
  );
  assert.equal(config.sites[0].blogs[0].prefix, '');
});

test('paths resolve relative to the configuration file, not the working directory', () => {
  const dir = project(
    'sites:\n  - { id: a, baseUrl: "https://example.org", title: A, contentDir: ../elsewhere, theme: t }\n',
    'coffer.yaml',
  );
  try {
    const other = mkdtempSync(join(tmpdir(), 'coffer-cwd-'));
    try {
      const config = loadConfig({
        cwd: other,
        configPath: join(dir, 'coffer.yaml'),
      });
      assert.equal(config.sites[0].contentDir, resolve(dir, '../elsewhere'));
      assert.equal(config.sites[0].theme, join(dir, 't'));
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('base URL is normalized without a trailing slash', () => {
  const config = normalize(oneSite({ baseUrl: 'https://Example.org/' }));
  assert.equal(config.sites[0].baseUrl, 'https://example.org');
  const nested = normalize(oneSite({ baseUrl: 'https://example.org/sub/' }));
  assert.equal(nested.sites[0].baseUrl, 'https://example.org/sub');
});

test('the timezone and language are canonicalized', () => {
  const config = normalize(oneSite({ lang: 'RU', timezone: 'utc' }));
  assert.equal(config.sites[0].lang, 'ru');
  assert.equal(config.sites[0].timezone, 'UTC');
});

test('an invalid base URL is reported with the file name and key path', () => {
  const errors = normalizeErrors({
    sites: [
      MINIMAL.sites[0],
      { id: 'second', baseUrl: 'http://example.org', title: 'Second' },
    ],
  });
  assert.deepEqual(errors, [
    'coffer.yaml: sites[1].baseUrl: must be an absolute https URL',
  ]);
});

for (const [name, value, message] of /** @type {[string, unknown, string][]} */ ([
  ['a relative value', '/blog', 'must be an absolute https URL'],
  ['a plain host name', 'example.org', 'must be an absolute https URL'],
  ['a non-string', 42, 'must be a non-empty string'],
  ['credentials', 'https://user:pw@example.org', 'must not contain credentials'],
  ['a query', 'https://example.org/?a=1', 'must not contain a query or a fragment'],
  ['a fragment', 'https://example.org/#top', 'must not contain a query or a fragment'],
])) {
  test(`baseUrl rejects ${name}`, () => {
    assert.deepEqual(normalizeErrors(oneSite({ baseUrl: value })), [
      `coffer.yaml: sites[0].baseUrl: ${message}`,
    ]);
  });
}

test('required keys are reported when missing', () => {
  assert.deepEqual(normalizeErrors({ sites: [{}] }), [
    'coffer.yaml: sites[0].id: is required',
    'coffer.yaml: sites[0].baseUrl: is required',
    'coffer.yaml: sites[0].title: is required',
  ]);
});

test('unknown keys are rejected so typos do not pass silently', () => {
  const errors = normalizeErrors({
    ...oneSite({ titel: 'x', urls: { blog: 'b' }, location: { gps: 'keep' } }),
    extra: true,
  });
  assert.equal(errors.length, 4);
  assert.match(errors[0], /^coffer\.yaml: extra: unknown key/);
  assert.match(errors[1], /^coffer\.yaml: sites\[0\]\.titel: unknown key/);
  assert.match(errors[2], /^coffer\.yaml: sites\[0\]\.urls\.blog: unknown key/);
  assert.match(errors[3], /^coffer\.yaml: sites\[0\]\.location\.gps: unknown key/);
});

test('sites must be a non-empty list', () => {
  assert.deepEqual(normalizeErrors({}), ['coffer.yaml: sites: is required']);
  assert.deepEqual(normalizeErrors({ sites: [] }), [
    'coffer.yaml: sites: must contain at least one site',
  ]);
  assert.deepEqual(normalizeErrors({ sites: {} }), [
    'coffer.yaml: sites: must be a list',
  ]);
  assert.deepEqual(normalizeErrors({ sites: ['x'] }), [
    'coffer.yaml: sites[0]: must be a mapping',
  ]);
  assert.deepEqual(normalizeErrors(null), [
    'coffer.yaml: must be a mapping with a "sites" list',
  ]);
});

test('duplicate site ids are rejected', () => {
  assert.deepEqual(normalizeErrors({ sites: [MINIMAL.sites[0], MINIMAL.sites[0]] }), [
    'coffer.yaml: sites[1].id: duplicates sites[0].id',
  ]);
});

test('site id must be a safe directory name', () => {
  assert.deepEqual(normalizeErrors(oneSite({ id: '../x' })), [
    'coffer.yaml: sites[0].id: must be made of letters, digits, ".", "_" and "-"',
  ]);
});

test('lang must be a language tag', () => {
  assert.deepEqual(normalizeErrors(oneSite({ lang: 'not a tag' })), [
    'coffer.yaml: sites[0].lang: must be a valid language tag such as "en" or "ru"',
  ]);
});

test('timezone must be an IANA name', () => {
  for (const timezone of ['Mars/Olympus', '+04:00', 'Russia Time Zone 3']) {
    assert.deepEqual(normalizeErrors(oneSite({ timezone })), [
      'coffer.yaml: sites[0].timezone: must be an IANA time zone such as "UTC" or "Europe/Samara"',
    ]);
  }
});

test('text keys must be strings and paths non-empty', () => {
  assert.deepEqual(
    normalizeErrors(
      oneSite({ description: 5, contentLicense: [], contentDir: '', theme: 7 }),
    ),
    [
      'coffer.yaml: sites[0].description: must be a string',
      'coffer.yaml: sites[0].contentDir: must be a non-empty string',
      'coffer.yaml: sites[0].theme: must be a non-empty string',
      'coffer.yaml: sites[0].contentLicense: must be a string',
    ],
  );
});

test('links need a label and a usable URL', () => {
  assert.deepEqual(
    normalizeErrors(
      oneSite({
        links: [
          { label: 'Good', url: '/about/' },
          { label: 'Bad', url: 'javascript:alert(1)' },
          { url: 'https://example.com' },
          'text',
          { label: 'Odd', url: 'https://example.com', rel: 'me' },
        ],
      }),
    ),
    [
      'coffer.yaml: sites[0].links[1].url: must be an http(s) or mailto: URL, or a path starting with "/"',
      'coffer.yaml: sites[0].links[2].label: is required',
      'coffer.yaml: sites[0].links[3]: must be a mapping with "label" and "url"',
      'coffer.yaml: sites[0].links[4].rel: unknown key (expected one of: label, url)',
    ],
  );
  assert.deepEqual(normalizeErrors(oneSite({ links: 'x' })), [
    'coffer.yaml: sites[0].links: must be a list',
  ]);
});

test('blogs are validated: id, prefix and duplicates', () => {
  assert.deepEqual(
    normalizeErrors(
      oneSite({
        blogs: [
          { id: 'a', prefix: 'notes' },
          { id: 'a', prefix: 'notes' },
          { prefix: '/lead' },
          { id: 'c', prefix: 'two words' },
          { id: 'd', prefix: 7 },
          'x',
        ],
      }),
    ),
    [
      'coffer.yaml: sites[0].blogs[1].id: duplicates sites[0].blogs[0].id',
      'coffer.yaml: sites[0].blogs[1].prefix: duplicates sites[0].blogs[0].prefix',
      'coffer.yaml: sites[0].blogs[2].id: is required',
      'coffer.yaml: sites[0].blogs[2].prefix: must not start or end with a slash',
      'coffer.yaml: sites[0].blogs[3].prefix: must be made of letters, digits, ".", "_" and "-", separated by single slashes',
      'coffer.yaml: sites[0].blogs[4].prefix: must be a string',
      'coffer.yaml: sites[0].blogs[5]: must be a mapping',
    ],
  );
  assert.deepEqual(normalizeErrors(oneSite({ blogs: {} })), [
    'coffer.yaml: sites[0].blogs: must be a list',
  ]);
});

test('urls must be usable and not collide', () => {
  assert.deepEqual(
    normalizeErrors(
      oneSite({ urls: { projects: '', docs: 7, tags: 'labels', series: 'labels' } }),
    ),
    [
      'coffer.yaml: sites[0].urls.projects: must not be empty',
      'coffer.yaml: sites[0].urls.docs: must be a string',
      'coffer.yaml: sites[0].urls.series: must differ from sites[0].urls.tags',
    ],
  );
  assert.deepEqual(
    normalizeErrors(
      oneSite({ blogs: [{ id: 'm', prefix: 'made' }] }),
    ),
    [
      'coffer.yaml: sites[0].urls.projects: collides with the prefix of blog "m"',
    ],
  );
});

test('location policies are restricted to their values', () => {
  assert.deepEqual(
    normalizeErrors(oneSite({ location: { default: 'exact', camera: 'coarse' } })),
    [
      'coffer.yaml: sites[0].location.default: must be one of: strip, coarse, keep',
      'coffer.yaml: sites[0].location.camera: must be one of: strip, keep',
    ],
  );
  assert.deepEqual(normalizeErrors(oneSite({ location: 'keep' })), [
    'coffer.yaml: sites[0].location: must be a mapping',
  ]);
});

test('projects needs a dir', () => {
  assert.deepEqual(normalizeErrors(oneSite({ projects: {} })), [
    'coffer.yaml: sites[0].projects.dir: is required',
  ]);
  assert.deepEqual(normalizeErrors(oneSite({ projects: 'here' })), [
    'coffer.yaml: sites[0].projects: must be a mapping',
  ]);
});

test('all errors are reported together, across sites', () => {
  const errors = normalizeErrors({
    sites: [
      { id: 'a', baseUrl: 'ftp://example.org', title: 'A', lang: '!!' },
      { id: 'b', title: 'B', location: { default: 'x' } },
    ],
  });
  assert.equal(errors.length, 4);
  assert.deepEqual(errors, [
    'coffer.yaml: sites[0].baseUrl: must be an absolute https URL',
    'coffer.yaml: sites[0].lang: must be a valid language tag such as "en" or "ru"',
    'coffer.yaml: sites[1].baseUrl: is required',
    'coffer.yaml: sites[1].location.default: must be one of: strip, coarse, keep',
  ]);
});

test('the error message joins every problem, one per line', () => {
  try {
    normalize({ sites: [{ id: 'a' }] });
    assert.fail('expected a ConfigError');
  } catch (error) {
    assert.ok(error instanceof ConfigError);
    assert.equal(error.message, error.errors.join('\n'));
    assert.equal(error.errors.length, 2);
  }
});

test('loadConfig names the file in YAML syntax errors', () => {
  withProject('sites: [\n  - id: a\n', (dir) => {
    const errors = errorsOf(() => loadConfig({ cwd: dir }));
    assert.ok(errors.length > 0);
    for (const line of errors) assert.match(line, /^coffer\.yaml: line \d+: /);
  });
});

test('loadConfig rejects duplicate YAML keys', () => {
  withProject('sites: []\nsites: []\n', (dir) => {
    const errors = errorsOf(() => loadConfig({ cwd: dir }));
    assert.match(errors[0], /^coffer\.yaml: line 2: /);
  });
});

test('loadConfig reports an empty file', () => {
  withProject('', (dir) => {
    assert.deepEqual(errorsOf(() => loadConfig({ cwd: dir })), [
      'coffer.yaml: must be a mapping with a "sites" list',
    ]);
  });
});

test('coffer.yaml is found in a parent directory', () => {
  withProject(TWO_SITES, (dir) => {
    const nested = join(dir, 'a', 'b');
    mkdirSync(nested, { recursive: true });
    assert.equal(findConfigFile({ cwd: nested }), join(dir, 'coffer.yaml'));
    assert.equal(loadConfig({ cwd: nested }).dir, dir);
  });
});

test('a missing configuration is an error naming the file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coffer-empty-'));
  try {
    assert.deepEqual(
      errorsOf(() => loadConfig({ cwd: dir, configPath: 'nope.yaml' })),
      ['nope.yaml: file not found'],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--config selects a differently named file and labels messages with it', () => {
  const dir = project('sites: []\n', 'site.yaml');
  try {
    assert.deepEqual(
      errorsOf(() => loadConfig({ cwd: dir, configPath: 'site.yaml' })),
      ['site.yaml: sites: must contain at least one site'],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * @param {string[]} argv
 * @param {string} cwd
 */
async function runCli(argv, cwd) {
  let out = '';
  let err = '';
  const previous = process.cwd();
  process.chdir(cwd);
  try {
    const code = await run(argv, {
      out: (text) => {
        out += text;
      },
      err: (text) => {
        err += text;
      },
    });
    return { code, out, err };
  } finally {
    process.chdir(previous);
  }
}

test('the config command lists the sites of a valid configuration', async () => {
  const dir = project(TWO_SITES);
  try {
    const result = await runCli(['config'], dir);
    assert.equal(result.code, 0);
    assert.equal(result.out, '2 site(s) configured: english, russian\n');
    assert.equal(result.err, '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the config command exits 1 and prints every error for an invalid file', async () => {
  const dir = project(
    'sites:\n  - { id: a, baseUrl: "https://example.org", title: A }\n  - { id: b, baseUrl: "http://example.org" }\n',
  );
  try {
    const result = await runCli(['config'], dir);
    assert.equal(result.code, 1);
    assert.equal(result.out, '');
    assert.equal(
      result.err,
      'coffer.yaml: sites[1].baseUrl: must be an absolute https URL\ncoffer.yaml: sites[1].title: is required\n',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the config command accepts --config and rejects bad arguments', async () => {
  const dir = project('sites: []\n', 'other.yaml');
  try {
    const bad = await runCli(['config', '--config', 'other.yaml'], dir);
    assert.equal(bad.code, 1);
    assert.match(bad.err, /^other\.yaml: sites:/);
    const equals = await runCli(['config', '--config=other.yaml'], dir);
    assert.equal(equals.code, 1);
    assert.match(equals.err, /^other\.yaml: sites:/);
    const missing = await runCli(['config', '--config'], dir);
    assert.equal(missing.code, 1);
    assert.match(missing.err, /--config needs a path/);
    const extra = await runCli(['config', 'oops'], dir);
    assert.equal(extra.code, 1);
    assert.match(extra.err, /unexpected argument "oops"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the executable exits non-zero for an invalid configuration', () => {
  const dir = project('sites:\n  - { id: a, baseUrl: "http://example.org", title: A }\n');
  try {
    const result = spawnSync(process.execPath, [bin, 'config'], {
      cwd: dir,
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /^coffer\.yaml: sites\[0\]\.baseUrl: must be an absolute https URL/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('docs/configuration.md documents every configuration key', () => {
  const page = readFileSync(
    new URL('../docs/configuration.md', import.meta.url),
    'utf8',
  );
  const keys = [
    'sites',
    'id',
    'baseUrl',
    'lang',
    'timezone',
    'title',
    'description',
    'contentDir',
    'theme',
    'contentLicense',
    'defaultImage',
    'links',
    'label',
    'url',
    'blogs',
    'dir',
    'prefix',
    'urls',
    'projects',
    'docs',
    'tags',
    'series',
    'location',
    'default',
    'camera',
    'tracks',
    'tolerance',
    'elevationThreshold',
    'images',
    'widths',
    'viewerMaxEdge',
    'webpQuality',
    'jpegQuality',
    'sizes',
  ];
  for (const key of keys) {
    assert.ok(page.includes(`\`${key}\``), `configuration.md misses \`${key}\``);
  }
});

test('images set the widths, the viewer size, the qualities and the sizes attribute', () => {
  const images = normalize(
    oneSite({
      images: { widths: [1000, 400, 400, 2000], viewerMaxEdge: 2500, webpQuality: 70, jpegQuality: 90, sizes: '100vw', carouselSizes: '50vw' },
    }),
  ).sites[0].images;
  assert.deepEqual(images, {
    widths: [400, 1000, 2000],
    viewerMaxEdge: 2500,
    webpQuality: 70,
    jpegQuality: 90,
    sizes: '100vw',
    carouselSizes: '50vw',
  });
  assert.deepEqual(normalize(oneSite({ images: { widths: [640] } })).sites[0].images.widths, [640]);
});

test('tracks set the simplification tolerance and the elevation threshold', () => {
  assert.deepEqual(normalize(oneSite({ tracks: { tolerance: 25.5, elevationThreshold: 0 } })).sites[0].tracks, {
    tolerance: 25.5,
    elevationThreshold: 0,
  });
  assert.deepEqual(normalize(oneSite({ tracks: { tolerance: 0 } })).sites[0].tracks, { tolerance: 0, elevationThreshold: 3 });
  assert.deepEqual(normalizeErrors(oneSite({ tracks: { tolerance: -1, elevationThreshold: 'high', speed: 3 } })), [
    'coffer.yaml: sites[0].tracks.speed: unknown key (expected one of: tolerance, elevationThreshold)',
    'coffer.yaml: sites[0].tracks.tolerance: must be a number of metres from 0 to 1000',
    'coffer.yaml: sites[0].tracks.elevationThreshold: must be a number of metres from 0 to 100',
  ]);
});

test('invalid image settings are reported with their keys', () => {
  assert.deepEqual(
    normalizeErrors(
      oneSite({ images: { widths: [], viewerMaxEdge: 10, webpQuality: 0, jpegQuality: 101, sizes: '', carouselSizes: '', quality: 5 } }),
    ),
    [
      'coffer.yaml: sites[0].images.quality: unknown key (expected one of: widths, viewerMaxEdge, webpQuality, jpegQuality, sizes, carouselSizes)',
      'coffer.yaml: sites[0].images.widths: must be a non-empty list of integers from 16 to 20000',
      'coffer.yaml: sites[0].images.viewerMaxEdge: must be an integer from 64 to 30000',
      'coffer.yaml: sites[0].images.webpQuality: must be an integer from 1 to 100',
      'coffer.yaml: sites[0].images.jpegQuality: must be an integer from 1 to 100',
      'coffer.yaml: sites[0].images.sizes: must be a non-empty string',
      'coffer.yaml: sites[0].images.carouselSizes: must be a non-empty string',
    ],
  );
  assert.deepEqual(normalizeErrors(oneSite({ images: { widths: [480, 'wide'] } })), [
    'coffer.yaml: sites[0].images.widths: must be a non-empty list of integers from 16 to 20000',
  ]);
  assert.deepEqual(normalizeErrors(oneSite({ images: 'big' })), [
    'coffer.yaml: sites[0].images: must be a mapping',
  ]);
});

test('author is a name or a mapping, and defaults to the site title', () => {
  assert.deepEqual(normalize(oneSite({ author: 'Ada Lovelace' })).sites[0].author, {
    name: 'Ada Lovelace',
    email: null,
    url: null,
  });
  assert.deepEqual(
    normalize(
      oneSite({ author: { name: 'Ada', email: 'ada@example.org', url: 'https://ada.example.org/' } }),
    ).sites[0].author,
    { name: 'Ada', email: 'ada@example.org', url: 'https://ada.example.org/' },
  );
  assert.deepEqual(normalize(oneSite({ author: { email: 'ada@example.org' } })).sites[0].author, {
    name: 'Main',
    email: 'ada@example.org',
    url: null,
  });
  assert.deepEqual(normalizeErrors(oneSite({ author: { name: 'A', email: 'nope', url: '/x' } })), [
    'coffer.yaml: sites[0].author.email: must be an email address',
    'coffer.yaml: sites[0].author.url: must be an absolute http(s) URL',
  ]);
});

test('feeds.limit is a positive integer', () => {
  assert.equal(normalize(oneSite({ feeds: { limit: 5 } })).sites[0].feeds.limit, 5);
  assert.deepEqual(normalizeErrors(oneSite({ feeds: { limit: 0 } })), [
    'coffer.yaml: sites[0].feeds.limit: must be a positive integer',
  ]);
  assert.deepEqual(normalizeErrors(oneSite({ feeds: { count: 3 } })), [
    'coffer.yaml: sites[0].feeds.count: unknown key (expected one of: limit)',
  ]);
});
