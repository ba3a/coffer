import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

/** Brand files and the card, pinned by size and sha256 of the original bytes. */
const FILES = [
  { path: 'site/brand/logo.svg', size: 582, sha256: '89c2c5ab0b6e81b053d29616a5ca5bb22ed576f4ecdbefb642a69061cdd1760c' },
  { path: 'site/brand/logo-dark.svg', size: 582, sha256: '8ca8b75ad499f54f39bb066d29a8e9b0b3e488ef08fe43b9da0288ff1974e9d8' },
  { path: 'site/brand/favicon.svg', size: 433, sha256: '4295cd43071cd050c501e039f8d5567b92988a562b7bf3b7a12525061c9f9eaf' },
  { path: 'site/brand/favicon.ico', size: 2333, sha256: '2d0f1c857cfaa51dc45bdd25664ff0920393af005494ea969c174524204ca585' },
  { path: 'site/brand/apple-touch-icon.png', size: 5506, sha256: 'a87c6b44fe9cec4fc9b3af1ac2deba8a878cc616db6b6e96d75dc343b013d2f6' },
  { path: 'site/card.png', size: 29596, sha256: 'a3f625930b22d475fe2b2f808763c28c484d41daeb153bf8e895e86aaf4d5a24' },
];

for (const { path, size, sha256 } of FILES) {
  test(`${path} is byte-identical to the original`, () => {
    const bytes = readFileSync(join(root, path));
    assert.equal(bytes.length, size);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), sha256);
  });
}

test('SVG brand files use LF line endings only', () => {
  for (const { path } of FILES.filter((f) => f.path.endsWith('.svg'))) {
    assert.ok(!readFileSync(join(root, path)).includes(0x0d), `${path} contains CR`);
  }
});
