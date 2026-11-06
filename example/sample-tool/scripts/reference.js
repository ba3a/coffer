// Generates the reference of the sample tool as JSON, in the format that coffer
// renders (see docs/project-docs.md): one item for every object and function
// that src/main/kotlin/Sample.kt declares, with the text of its doc comment.
// A declaration without a doc comment is marked "undocumented".
//
// Usage: node scripts/reference.js <output file>
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const output = process.argv[2];
if (!output) {
  console.error('usage: node scripts/reference.js <output file>');
  process.exit(2);
}

const lines = readFileSync(join(root, 'src', 'main', 'kotlin', 'Sample.kt'), 'utf8').split(/\r?\n/);
const objects = [];
const functions = [];
let owner = null;
let inComment = false;
/** The lines of the doc comment before the declaration being read; null when there is none. */
let doc = null;

for (const line of lines) {
  const text = line.trim();
  if (text.startsWith('/**')) {
    inComment = true;
    doc = [];
  }
  if (inComment) {
    doc.push(text.replace(/^\/\*\*?/, '').replace(/\*\/$/, '').replace(/^\*\s?/, '').trim());
    if (text.endsWith('*/')) inComment = false;
    continue;
  }
  const declaration = /^(object|class|fun)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(text);
  if (declaration) {
    const [, keyword, name] = declaration;
    const prose = [];
    const parameters = [];
    for (const part of doc ?? []) {
      const parameter = /^@param\s+(\S+)\s+(.*)$/.exec(part);
      if (parameter) parameters.push(`${parameter[1]}: ${parameter[2]}`);
      else if (!part.startsWith('@')) prose.push(part);
    }
    // Lines of a comment run together; a blank line starts a new paragraph.
    const paragraphs = prose
      .join('\n')
      .split(/\n\s*\n/)
      .map((paragraph) => paragraph.replace(/\s+/g, ' ').trim());
    const description = [...paragraphs, ...parameters].filter(Boolean).join('\n\n');
    const isFunction = keyword === 'fun';
    const qualified = isFunction && owner ? `${owner}.${name}` : name;
    const item = {
      name: qualified,
      kind: isFunction ? 'function' : keyword,
      signature: text.replace(/\s*(\{|=.*)$/, ''),
      description,
      anchor: qualified.toLowerCase().replaceAll('.', '-'),
      undocumented: doc === null,
    };
    if (isFunction) functions.push(item);
    else {
      owner = name;
      objects.push(item);
    }
  }
  if (text !== '') doc = null;
}

mkdirSync(dirname(output), { recursive: true });
writeFileSync(
  output,
  `${JSON.stringify({ title: 'Kerfcalc reference', sections: [{ title: 'Objects', items: objects }, { title: 'Functions', items: functions }] }, null, 2)}\n`,
);
