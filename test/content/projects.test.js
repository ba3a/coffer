import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  COMMON_PROJECT_KEYS,
  getProjectKind,
  listProjectKinds,
  registerProjectKind,
  unregisterProjectKind,
} from '../../src/content/project-kinds.js';
import {
  PROJECT_STATUSES,
  ProjectError,
  compareProjects,
  loadProjects,
  parseProjectSource,
  projectUrl,
  showcaseOf,
} from '../../src/content/projects.js';
import { TINY_PNG } from '../helpers/images.js';

const COMMON = 'name: Lathe\npitch: Turns wood.\nkind: tool\nstatus: released\ncard: card.png\n';
const TOOL = `${COMMON}repo: https://github.example/me/lathe\n`;

/**
 * Writes a projects directory, runs `body` with its path and removes it.
 *
 * @param {Record<string, string | Buffer>} files Paths below the projects directory.
 * @param {(dir: string) => void} body
 */
function inProjects(files, body) {
  const root = mkdtempSync(join(tmpdir(), 'coffer-project-'));
  try {
    for (const [name, content] of Object.entries(files)) {
      const target = join(root, ...name.split('/'));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Parses a project.yaml that sits in a folder with a card picture.
 *
 * @param {string} text
 * @param {(result: ReturnType<typeof parseProjectSource>, errors: string[], file: string, dir: string) => void} body
 * @param {Record<string, string | Buffer>} [extra] More files in the project folder.
 */
function parse(text, body, extra = {}) {
  inProjects({ 'lathe/card.png': TINY_PNG, ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [`lathe/${k}`, v])) }, (root) => {
    const dir = join(root, 'lathe');
    const file = join(dir, 'project.yaml');
    /** @type {string[]} */
    const errors = [];
    const result = parseProjectSource({ slug: 'lathe', dir, file, text }, errors);
    body(result, errors, file, dir);
  });
}

test('a tool has the common fields, the tool fields and defaults for the rest', () => {
  parse(TOOL, (project, errors, file, dir) => {
    assert.deepEqual(errors, []);
    assert.deepEqual(project, {
      slug: 'lathe',
      dir,
      file,
      name: 'Lathe',
      pitch: 'Turns wood.',
      kind: 'tool',
      status: 'released',
      card: join(dir, 'card.png'),
      cardAlt: '',
      featured: false,
      order: null,
      tag: null,
      license: null,
      fields: { repo: 'https://github.example/me/lathe', docs: null },
    });
  });
});

test('featured, order, tag, license and the kind fields are read', () => {
  parse(
    `${TOOL}featured: true\norder: 3\ntag: Projects/Lathe\nlicense: MIT\ncardAlt: " A lathe "\ndocs:\n  path: ../docs\n`,
    (project, errors) => {
      assert.deepEqual(errors, []);
      assert.equal(project?.featured, true);
      assert.equal(project?.order, 3);
      assert.equal(project?.tag, 'projects/lathe');
      assert.equal(project?.license, 'MIT');
      assert.equal(project?.cardAlt, 'A lathe');
      assert.deepEqual(project?.fields.docs, { path: '../docs' });
    },
  );
});

test('every problem is reported with the file and the field', () => {
  parse(
    [
      'name: ""',
      'status: finished',
      'card: nope.png',
      'featured: yes please',
      'order: 1.5',
      'tag: "a b"',
      'license: 7',
      'colour: red',
      'kind: tool',
    ].join('\n'),
    (project, errors, file) => {
      assert.equal(project, undefined);
      assert.deepEqual(errors, [
        `${file}: name: must be a non-empty string`,
        `${file}: pitch: is required`,
        `${file}: status: unknown status "finished" (one of: ${PROJECT_STATUSES.join(', ')})`,
        `${file}: card: the picture "nope.png" does not exist in the project folder`,
        `${file}: featured: must be true or false`,
        `${file}: order: must be a whole number`,
        `${file}: tag: must be a tag path such as "projects/lathe" (letters, digits, ".", "_" and "-", separated by "/")`,
        `${file}: license: must be a non-empty string`,
        `${file}: repo: is required for a tool (an http(s) URL)`,
        `${file}: colour: unknown key for a tool (expected one of: ${[...COMMON_PROJECT_KEYS, 'repo', 'docs'].join(', ')})`,
      ]);
    },
  );
});

test('an unknown kind names the known ones', () => {
  parse(COMMON.replace('kind: tool', 'kind: book'), (project, errors, file) => {
    assert.equal(project, undefined);
    assert.deepEqual(errors, [`${file}: kind: unknown kind "book" (known kinds: game, tool)`]);
  });
  parse(COMMON.replace('kind: tool\n', ''), (_project, errors, file) => {
    assert.deepEqual(errors, [`${file}: kind: is required (one of: game, tool)`]);
  });
  parse(COMMON.replace('kind: tool', 'kind: [tool]'), (_project, errors, file) => {
    assert.match(errors[0], new RegExp(`^${file.replace(/[\\.]/g, '\\$&')}: kind: unknown kind`));
  });
});

test('the slug is the folder name, so it is not a field', () => {
  parse(`${TOOL}slug: other\n`, (_project, errors, file) => {
    assert.deepEqual(errors, [`${file}: slug: is not a field: the slug is the name of the project folder`]);
  });
});

test('the card must be a picture inside the project folder', () => {
  parse(TOOL.replace('card.png', '../card.png'), (_project, errors, file) => {
    assert.deepEqual(errors, [`${file}: card: "../card.png" must be a picture inside the project folder`]);
  });
  parse(TOOL.replace('card.png', 'notes.txt'), (_project, errors, file) => {
    assert.match(errors[0], new RegExp(`: card: "notes.txt" must be one of \\.jpg`));
    assert.ok(errors[0].startsWith(file));
  });
});

test('yaml syntax errors and non-mappings are reported with the file', () => {
  parse('name: [unclosed\n', (project, errors, file) => {
    assert.equal(project, undefined);
    assert.equal(errors.length > 0, true);
    assert.ok(errors.every((message) => message.startsWith(`${file}: `)));
  });
  parse('- a\n- b\n', (_project, errors, file) => {
    assert.deepEqual(errors, [`${file}: must be a mapping of keys to values`]);
  });
  parse('', (_project, errors, file) => {
    assert.equal(errors[0], `${file}: name: is required`);
  });
});

test('game fields: stores with a link are kept, platforms, price, accent, font and press kit are checked', () => {
  const game = 'name: G\npitch: P.\nkind: game\nstatus: idea\ncard: card.png\n';
  parse(
    `${game}stores:\n  itch: https://a.itch.example/g\n  steam:\n  gog: ""\nplatforms: [Linux, Web]\nprice: Free\naccent: "#ABC"\ndisplayFont: Handjet\npressKit: press\n`,
    (project, errors) => {
      assert.deepEqual(errors, []);
      assert.deepEqual(project?.fields, {
        stores: { itch: 'https://a.itch.example/g' },
        platforms: ['Linux', 'Web'],
        price: 'Free',
        pressKit: 'press',
        accent: '#abc',
        displayFont: 'Handjet',
      });
    },
    { 'press/logo.png': TINY_PNG },
  );
  parse(game, (project, errors) => {
    assert.deepEqual(errors, []);
    assert.deepEqual(project?.fields, {
      stores: {},
      platforms: [],
      price: null,
      pressKit: null,
      accent: null,
      displayFont: null,
    });
  });
  parse(
    `${game}stores:\n  itch: ftp://x\n  Steam: https://s.example\nplatforms: [Linux, Linux]\naccent: red\npressKit: missing\nprice: 5\n`,
    (_project, errors, file) => {
      assert.deepEqual(errors, [
        `${file}: stores: itch: must be an absolute http(s) URL, or empty while it is not set`,
        `${file}: platforms: "Linux" is listed twice`,
        `${file}: price: must be a non-empty string`,
        `${file}: pressKit: the folder "missing" does not exist in the project folder`,
        `${file}: accent: must be a colour written as #rgb or #rrggbb`,
      ]);
    },
  );
  parse(`${game}pressKit: ../elsewhere\nstores:\n  Steam: https://s.example\n`, (_project, errors, file) => {
    assert.deepEqual(errors, [
      `${file}: stores: "Steam" is not a usable name (use lower-case letters, digits, "-" and "_")`,
      `${file}: pressKit: must name a folder inside the project folder`,
    ]);
  });
});

test('loadProjects reads every folder, in showcase order, and ignores hidden and underscore folders and loose files', () => {
  inProjects(
    {
      'b/project.yaml': `${TOOL.replace('Lathe', 'Bravo')}order: 2\n`,
      'b/index.md': 'B.\n',
      'b/card.png': TINY_PNG,
      'a/project.yaml': `${TOOL.replace('Lathe', 'Alpha')}`,
      'a/index.md': 'A.\n\nSecond.\n',
      'a/card.png': TINY_PNG,
      'c/project.yaml': `${TOOL.replace('Lathe', 'Charlie')}order: 1\n`,
      'c/index.md': 'C.\n',
      'c/card.png': TINY_PNG,
      '.git/config': 'x',
      '_drafts/notes.md': 'x',
      'README.md': 'Loose file.',
    },
    (dir) => {
      const projects = loadProjects(dir);
      assert.deepEqual(
        projects.map((project) => [project.slug, project.name, project.order]),
        [
          ['c', 'Charlie', 1],
          ['b', 'Bravo', 2],
          ['a', 'Alpha', null],
        ],
      );
      const alpha = projects[2];
      assert.equal(alpha.body, 'A.\n\nSecond.\n');
      assert.equal(alpha.bodyLine, 1);
      assert.equal(alpha.pageFile, join(dir, 'a', 'index.md'));
      assert.equal(alpha.file, join(dir, 'a', 'project.yaml'));
    },
  );
});

test('loadProjects collects the problems of all projects, each with its file', () => {
  inProjects(
    {
      'one/project.yaml': TOOL.replace('kind: tool', 'kind: nope'),
      'one/index.md': 'x',
      'one/card.png': TINY_PNG,
      'two/project.yaml': TOOL,
      'two/card.png': TINY_PNG,
      'Three/project.yaml': TOOL,
      'Three/index.md': 'x',
      'Three/card.png': TINY_PNG,
      'four/project.yaml': TOOL,
      'four/index.md': '---\ntitle: x\n---\n',
      'four/card.png': TINY_PNG,
    },
    (dir) => {
      assert.throws(
        () => loadProjects(dir),
        (error) => {
          assert.ok(error instanceof ProjectError);
          assert.deepEqual(error.errors, [
            `${join(dir, 'Three')}: slug: "Three" (the folder name) must be lower-case letters, digits, "-" and "_", starting with a letter or a digit`,
            `${join(dir, 'four', 'index.md')}: front matter: not used; the fields of a project are in project.yaml`,
            `${join(dir, 'one', 'project.yaml')}: kind: unknown kind "nope" (known kinds: game, tool)`,
            `${join(dir, 'two', 'index.md')}: missing; every project folder needs an index.md with the text of the page`,
          ]);
          assert.equal(error.message, error.errors.join('\n'));
          return true;
        },
      );
    },
  );
});

test('loadProjects fails for a directory that does not exist', () => {
  inProjects({}, (dir) => {
    assert.throws(() => loadProjects(join(dir, 'nowhere')), {
      name: 'ProjectError',
      message: `${join(dir, 'nowhere')}: projects directory does not exist`,
    });
  });
});

test('compareProjects and showcaseOf order by order, then name; only featured projects are in the showcase', () => {
  const list = [
    { slug: 'd', name: 'Delta', order: null, featured: true },
    { slug: 'a', name: 'alpha', order: null, featured: true },
    { slug: 'x', name: 'Xray', order: 9, featured: true },
    { slug: 'n', name: 'Not featured', order: 0, featured: false },
    { slug: 'o', name: 'Omega', order: -1, featured: true },
  ];
  assert.deepEqual(showcaseOf(list).map((project) => project.slug), ['o', 'x', 'a', 'd']);
  assert.deepEqual([...list].sort(compareProjects).map((project) => project.slug), ['o', 'n', 'x', 'a', 'd']);
  assert.equal(list.length, 5, 'the input is not changed');
});

test('projectUrl uses the configured prefix', () => {
  assert.equal(projectUrl('made', 'lathe'), '/made/lathe/');
  assert.equal(projectUrl('work/things', 'x'), '/work/things/x/');
});

test('tool and game ship; a kind needs a name, a template and known field types', () => {
  assert.deepEqual(listProjectKinds().map((kind) => kind.name), ['game', 'tool']);
  assert.equal(getProjectKind('tool')?.template, 'project.njk');
  assert.deepEqual(Object.keys(getProjectKind('tool')?.fields ?? {}), ['repo', 'docs']);
  assert.deepEqual(Object.keys(getProjectKind('game')?.fields ?? {}), [
    'stores',
    'platforms',
    'price',
    'pressKit',
    'accent',
    'displayFont',
  ]);
  assert.throws(() => registerProjectKind({ name: 'Bad Name', template: 'x.njk', fields: {} }), /needs a name/);
  assert.throws(() => registerProjectKind({ name: 'ok', template: '', fields: {} }), /template/);
  assert.throws(() => registerProjectKind({ name: 'tool', template: 'x.njk', fields: {} }), /already registered/);
  assert.throws(
    () => registerProjectKind({ name: 'ok', template: 'x.njk', fields: { name: { type: 'string' } } }),
    /"name" is a field of every project/,
  );
  assert.throws(
    () => registerProjectKind({ name: 'ok', template: 'x.njk', fields: { x: { type: /** @type {any} */ ('number') } } }),
    /unknown type "number" \(known: /,
  );
  assert.equal(getProjectKind('ok'), undefined);
  assert.equal(unregisterProjectKind('ok'), false);
});

test('a registered kind validates its own fields', () => {
  registerProjectKind({
    name: 'book',
    template: 'project.njk',
    fields: { isbn: { type: 'string', required: true }, shop: { type: 'url' } },
  });
  try {
    parse(COMMON.replace('kind: tool', 'kind: book'), (_project, errors, file) => {
      assert.deepEqual(errors, [`${file}: isbn: is required for a book (text)`]);
    });
    parse(`${COMMON.replace('kind: tool', 'kind: book')}isbn: "123"\nshop: https://shop.example\n`, (project, errors) => {
      assert.deepEqual(errors, []);
      assert.deepEqual(project?.fields, { isbn: '123', shop: 'https://shop.example' });
    });
  } finally {
    assert.equal(unregisterProjectKind('book'), true);
  }
  parse(COMMON.replace('kind: tool', 'kind: book'), (_project, errors, file) => {
    assert.deepEqual(errors, [`${file}: kind: unknown kind "book" (known kinds: game, tool)`]);
  });
});

test('displayFont is a plain font family name or a comma-separated list of them', () => {
  const game = 'name: G\npitch: P.\nkind: game\nstatus: idea\ncard: card.png\n';
  for (const [written, kept] of [
    ['Fraunces', 'Fraunces'],
    ['Press Start 2P', 'Press Start 2P'],
    ['Space-Grotesk,   Inter', 'Space-Grotesk, Inter'],
  ]) {
    parse(`${game}displayFont: ${JSON.stringify(written)}\n`, (project, errors) => {
      assert.deepEqual(errors, [], written);
      assert.equal(/** @type {any} */ (project?.fields).displayFont, kept);
    });
  }
  for (const bad of [
    'x}</style><script>',
    '"Quoted"',
    "Font'; color: red",
    String.raw`Back\slash`,
    'Two\nlines',
    '',
    'Fraunces,',
    ',Inter',
    '-leading',
    'a'.repeat(65),
    'Font;Other',
    'url(x)',
  ]) {
    parse(`${game}displayFont: ${JSON.stringify(bad)}\n`, (_project, errors, file) => {
      assert.equal(errors.length, 1, JSON.stringify(bad));
      assert.ok(errors[0].startsWith(`${file}: displayFont: `), errors[0]);
    });
  }
});
