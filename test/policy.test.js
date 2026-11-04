import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PolicyError,
  createPolicyResolver,
  describeSource,
  findImageOverride,
  normalizeImageKey,
  policyValueProblem,
} from '../src/images/policy.js';
import { parseTagMeta } from '../src/content/tags.js';
import { parsePostSource } from '../src/content/posts.js';

const SITE = { default: 'strip', camera: 'strip' };

/**
 * @param {Record<string, { location?: string, camera?: string }>} entries
 * @returns {Map<string, { name: null, description: null, location: string | null, camera: string | null }>}
 */
function tagMap(entries) {
  return new Map(
    Object.entries(entries).map(([path, value]) => [
      path,
      { name: null, description: null, location: value.location ?? null, camera: value.camera ?? null },
    ]),
  );
}

/**
 * @param {{ tags?: string[], location?: string | null, camera?: string | null, images?: Record<string, { location?: string, camera?: string }> }} [fields]
 */
function post(fields = {}) {
  return {
    file: 'journal/trip/index.md',
    tags: fields.tags ?? [],
    location: fields.location ?? null,
    camera: fields.camera ?? null,
    images: new Map(
      Object.entries(fields.images ?? {}).map(([key, value]) => [
        normalizeImageKey(key),
        { location: value.location ?? null, camera: value.camera ?? null },
      ]),
    ),
  };
}

/**
 * @typedef {object} Case
 * @property {string} name
 * @property {{ default: string, camera: string }} [site]
 * @property {Record<string, { location?: string, camera?: string }>} [tags]
 * @property {Parameters<typeof post>[0]} [post]
 * @property {string} [image]
 * @property {[string, string, string | null]} location Value, level and origin that are expected.
 * @property {[string, string, string | null]} camera
 */

/** @type {Case[]} */
const CASES = [
  {
    name: 'the site setting applies when nothing is more specific',
    site: { default: 'coarse', camera: 'keep' },
    tags: { hike: { location: 'keep' } },
    post: { tags: ['woodwork'] },
    location: ['coarse', 'site', null],
    camera: ['keep', 'site', null],
  },
  {
    name: 'a tag applies to itself',
    tags: { hike: { location: 'keep' } },
    post: { tags: ['hike'] },
    location: ['keep', 'tag', 'hike'],
    camera: ['strip', 'site', null],
  },
  {
    name: 'a tag applies to its whole subtree',
    tags: { hike: { location: 'keep', camera: 'keep' } },
    post: { tags: ['hike/alps/day-2'] },
    location: ['keep', 'tag', 'hike'],
    camera: ['keep', 'tag', 'hike'],
  },
  {
    name: 'the nearest ancestor with a setting applies',
    tags: { hike: { location: 'keep' }, 'hike/alps': { location: 'coarse' } },
    post: { tags: ['hike/alps/day-2'] },
    location: ['coarse', 'tag', 'hike/alps'],
    camera: ['strip', 'site', null],
  },
  {
    name: 'a more permissive descendant overrides a stricter ancestor',
    tags: { work: { location: 'strip' }, 'work/outdoors': { location: 'keep' } },
    post: { tags: ['work/outdoors'] },
    location: ['keep', 'tag', 'work/outdoors'],
    camera: ['strip', 'site', null],
  },
  {
    name: 'a tag outside the subtree is not affected',
    tags: { hike: { location: 'keep' } },
    post: { tags: ['hiking', 'hikes/alps'] },
    location: ['strip', 'site', null],
    camera: ['strip', 'site', null],
  },
  {
    name: 'a tag overrides a stricter site setting',
    site: { default: 'strip', camera: 'strip' },
    tags: { hike: { location: 'keep', camera: 'keep' } },
    post: { tags: ['hike'] },
    location: ['keep', 'tag', 'hike'],
    camera: ['keep', 'tag', 'hike'],
  },
  {
    name: 'two disagreeing tags give the stricter location',
    tags: { hike: { location: 'keep' }, home: { location: 'strip' } },
    post: { tags: ['hike', 'home'] },
    location: ['strip', 'tag', 'home'],
    camera: ['strip', 'site', null],
  },
  {
    name: 'the stricter location wins whatever the order of the tags',
    tags: { hike: { location: 'keep' }, home: { location: 'coarse' } },
    post: { tags: ['home', 'hike'] },
    location: ['coarse', 'tag', 'home'],
    camera: ['strip', 'site', null],
  },
  {
    name: 'the stricter of two disagreeing inherited settings wins',
    tags: { hike: { location: 'keep' }, home: { location: 'coarse' } },
    post: { tags: ['hike/alps', 'home/garden'] },
    location: ['coarse', 'tag', 'home'],
    camera: ['strip', 'site', null],
  },
  {
    name: 'two disagreeing tags give the stricter camera policy',
    site: { default: 'strip', camera: 'keep' },
    tags: { hike: { camera: 'keep' }, home: { camera: 'strip' } },
    post: { tags: ['hike', 'home'] },
    location: ['strip', 'site', null],
    camera: ['strip', 'tag', 'home'],
  },
  {
    name: 'a tag without a setting does not weaken another tag',
    tags: { hike: { location: 'coarse' } },
    post: { tags: ['woodwork', 'hike'] },
    location: ['coarse', 'tag', 'hike'],
    camera: ['strip', 'site', null],
  },
  {
    name: 'agreeing tags name the first of them',
    tags: { a: { location: 'keep' }, b: { location: 'keep' } },
    post: { tags: ['b', 'a'] },
    location: ['keep', 'tag', 'b'],
    camera: ['strip', 'site', null],
  },
  {
    name: 'the post overrides the tags',
    tags: { hike: { location: 'keep', camera: 'keep' } },
    post: { tags: ['hike'], location: 'strip', camera: 'strip' },
    location: ['strip', 'post', 'journal/trip/index.md'],
    camera: ['strip', 'post', 'journal/trip/index.md'],
  },
  {
    name: 'the post wins even when it is less strict than a tag',
    tags: { home: { location: 'strip' } },
    post: { tags: ['home'], location: 'keep' },
    location: ['keep', 'post', 'journal/trip/index.md'],
    camera: ['strip', 'site', null],
  },
  {
    name: 'the post overrides the site',
    post: { location: 'coarse' },
    location: ['coarse', 'post', 'journal/trip/index.md'],
    camera: ['strip', 'site', null],
  },
  {
    name: 'an image overrides the post',
    post: { location: 'keep', images: { 'IMG_1.jpg': { location: 'strip' } } },
    image: 'IMG_1.jpg',
    location: ['strip', 'image', 'IMG_1.jpg'],
    camera: ['strip', 'site', null],
  },
  {
    name: 'an image overrides the tags and may be less strict',
    tags: { home: { location: 'strip', camera: 'strip' } },
    post: { tags: ['home'], images: { 'IMG_1.jpg': { location: 'keep', camera: 'keep' } } },
    image: 'IMG_1.jpg',
    location: ['keep', 'image', 'IMG_1.jpg'],
    camera: ['keep', 'image', 'IMG_1.jpg'],
  },
  {
    name: 'another image of the post gets the post policy',
    post: { location: 'coarse', images: { 'IMG_1.jpg': { location: 'keep' } } },
    image: 'IMG_2.jpg',
    location: ['coarse', 'post', 'journal/trip/index.md'],
    camera: ['strip', 'site', null],
  },
  {
    name: 'an image that sets one setting leaves the other to the levels above',
    tags: { hike: { camera: 'keep' } },
    post: { tags: ['hike'], images: { 'IMG_1.jpg': { location: 'keep' } } },
    image: 'IMG_1.jpg',
    location: ['keep', 'image', 'IMG_1.jpg'],
    camera: ['keep', 'tag', 'hike'],
  },
  {
    name: 'location and camera come from different levels',
    site: { default: 'coarse', camera: 'keep' },
    tags: { hike: { location: 'keep' } },
    post: { tags: ['hike'], camera: 'strip', images: { 'a.jpg': { location: 'strip' } } },
    image: 'a.jpg',
    location: ['strip', 'image', 'a.jpg'],
    camera: ['strip', 'post', 'journal/trip/index.md'],
  },
  {
    name: 'location and camera of a post come from the tags and the site',
    site: { default: 'coarse', camera: 'keep' },
    tags: { hike: { location: 'keep' } },
    post: { tags: ['hike'] },
    location: ['keep', 'tag', 'hike'],
    camera: ['keep', 'site', null],
  },
];

for (const c of CASES) {
  test(`policy: ${c.name}`, () => {
    const resolve = createPolicyResolver({ site: c.site ?? SITE, tags: tagMap(c.tags ?? {}) });
    const policy = resolve(post(c.post), c.image);
    assert.deepEqual(
      [policy.location.value, policy.location.source.level, policy.location.source.origin],
      c.location,
      'location',
    );
    assert.deepEqual(
      [policy.camera.value, policy.camera.source.level, policy.camera.source.origin],
      c.camera,
      'camera',
    );
  });
}

test('without an image the policy of the post is returned', () => {
  const resolve = createPolicyResolver({ site: SITE });
  const policy = resolve(post({ location: 'keep', images: { 'a.jpg': { location: 'strip' } } }));
  assert.equal(policy.location.value, 'keep');
  assert.equal(policy.location.source.level, 'post');
});

test('an image is found by its path as written, with or without ./ and by file name', () => {
  const resolve = createPolicyResolver({ site: SITE });
  const p = post({
    images: { 'IMG_1.jpg': { location: 'keep' }, 'photos/day2/IMG_7.jpg': { location: 'coarse' } },
  });
  for (const reference of ['IMG_1.jpg', './IMG_1.jpg', 'photos/IMG_1.jpg', 'photos\\IMG_1.jpg']) {
    assert.equal(resolve(p, reference).location.value, 'keep', reference);
  }
  assert.equal(resolve(p, './photos/day2/IMG_7.jpg').location.value, 'coarse');
  // A key with a folder names exactly that image.
  assert.equal(resolve(p, 'IMG_7.jpg').location.value, 'strip');
  assert.equal(resolve(p, 'photos/IMG_7.jpg').location.value, 'strip');
  // File names are case sensitive.
  assert.equal(resolve(p, 'img_1.jpg').location.value, 'strip');
});

test('image references with percent escapes match the keys written with spaces', () => {
  const resolve = createPolicyResolver({ site: SITE });
  const p = post({ images: { 'my photo.jpg': { location: 'keep' } } });
  assert.equal(resolve(p, 'my%20photo.jpg').location.value, 'keep');
});

test('normalizeImageKey and findImageOverride', () => {
  assert.equal(normalizeImageKey(' ./a//b\\c.jpg '), 'a/b/c.jpg');
  assert.equal(normalizeImageKey('bad%zz.jpg'), 'bad%zz.jpg');
  assert.equal(findImageOverride(new Map(), 'a.jpg'), null);
});

test('describeSource says where a decision came from', () => {
  assert.match(describeSource({ level: 'site', origin: null }), /site configuration/);
  assert.match(describeSource({ level: 'tag', origin: 'hike' }), /tag "hike" in tags\.yaml/);
  assert.match(describeSource({ level: 'post', origin: 'a/index.md' }), /front matter of a\/index\.md/);
  assert.match(describeSource({ level: 'image', origin: 'IMG_1.jpg' }), /images entry "IMG_1\.jpg"/);
});

test('policyValueProblem accepts only the values of the setting', () => {
  assert.equal(policyValueProblem('location', 'coarse'), null);
  assert.equal(policyValueProblem('camera', 'keep'), null);
  assert.match(String(policyValueProblem('camera', 'coarse')), /one of: strip, keep/);
  assert.match(String(policyValueProblem('location', 'Keep')), /one of: strip, coarse, keep/);
  assert.notEqual(policyValueProblem('location', 3), null);
});

test('invalid values are reported with the file and the key', () => {
  assert.throws(
    () => createPolicyResolver({ site: { default: 'exact', camera: 'coarse' } }),
    (error) => {
      assert.ok(error instanceof PolicyError);
      assert.deepEqual(error.errors, [
        'location.default: must be one of: strip, coarse, keep',
        'location.camera: must be one of: strip, keep',
      ]);
      return true;
    },
  );

  assert.throws(
    () =>
      createPolicyResolver({
        site: SITE,
        tags: tagMap({ hike: { location: 'everything' }, 'hike/alps': { camera: 'coarse' } }),
        tagsFile: 'journal/tags.yaml',
      }),
    (error) => {
      assert.ok(error instanceof PolicyError);
      assert.deepEqual(error.errors, [
        'journal/tags.yaml: hike.location: must be one of: strip, coarse, keep',
        'journal/tags.yaml: hike/alps.camera: must be one of: strip, keep',
      ]);
      return true;
    },
  );

  const resolve = createPolicyResolver({ site: SITE });
  assert.throws(
    () => resolve(post({ location: 'approx', images: { 'a.jpg': { camera: 'coarse' } } })),
    (error) => {
      assert.ok(error instanceof PolicyError);
      assert.deepEqual(error.errors, [
        'journal/trip/index.md: location: must be one of: strip, coarse, keep',
        'journal/trip/index.md: images.a.jpg.camera: must be one of: strip, keep',
      ]);
      return true;
    },
  );
});

test('a typo in an unused image entry is still reported', () => {
  const resolve = createPolicyResolver({ site: SITE });
  assert.throws(
    () => resolve(post({ images: { 'other.jpg': { location: 'kepp' } } }), 'a.jpg'),
    /images\.other\.jpg\.location/,
  );
});

test('the resolver works on what tags.yaml and the front matter produce', () => {
  const { meta } = parseTagMeta(
    'tags.yaml',
    ['hike:', '  location: keep', '  camera: keep', 'hike/private:', '  location: strip'].join('\n'),
  );
  const parsed = parsePostSource({
    file: 'trip.md',
    slug: 'trip',
    text: [
      '---',
      'title: Trip',
      'date: 2024-05-01',
      'tags: [Hike/Alps, hike/private]',
      'images:',
      '  IMG_1.jpg:',
      '    location: coarse',
      '---',
      'Text',
      '',
    ].join('\n'),
  });
  const resolve = createPolicyResolver({ site: SITE, tags: meta });
  const first = resolve(parsed, './IMG_1.jpg');
  assert.deepEqual(first.location, { value: 'coarse', source: { level: 'image', origin: 'IMG_1.jpg' } });
  assert.deepEqual(first.camera, { value: 'keep', source: { level: 'tag', origin: 'hike' } });
  const second = resolve(parsed, 'IMG_2.jpg');
  assert.deepEqual(second.location, { value: 'strip', source: { level: 'tag', origin: 'hike/private' } });
});
