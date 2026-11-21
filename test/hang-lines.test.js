import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const source = readFileSync(fileURLToPath(new URL('../theme/assets/hang-lines.js', import.meta.url)), 'utf8');

/**
 * A mark with a position, inside a block that starts at x = 100 with 10px of padding.
 *
 * @param {number} left
 * @param {'ltr' | 'rtl'} [direction]
 */
function fakeMark(left, direction = 'ltr') {
  const classes = new Set(['hang-l']);
  /** @type {Record<string, string>} */
  const props = {};
  const rtl = direction === 'rtl';
  const block = {
    getBoundingClientRect: () => ({ left: 100, right: 500 }),
    style: { direction, paddingLeft: '10px', paddingRight: '10px', borderLeftWidth: '0px', borderRightWidth: '0px' },
  };
  const mark = {
    classes,
    props,
    classList: { add: (/** @type {string} */ c) => classes.add(c), remove: (/** @type {string} */ c) => classes.delete(c), contains: (/** @type {string} */ c) => classes.has(c) },
    style: { setProperty: (/** @type {string} */ name, /** @type {string} */ value) => (props[name] = value) },
    closest: () => block,
    // A mark with is-lead sits 6px (its width) further into the margin.
    getBoundingClientRect: () => {
      const moved = classes.has('is-lead') ? (rtl ? 6 : -6) : 0;
      return { left: left + moved, right: left + 6 + moved, width: 6 };
    },
    block,
  };
  return mark;
}

/**
 * Runs the script against a stand-in page.
 *
 * @param {ReturnType<typeof fakeMark>[]} marks
 */
function run(marks) {
  /** @type {Record<string, () => void>} */
  const listeners = {};
  /** @type {(() => void)[]} */
  const frames = [];
  const window = {
    getComputedStyle: (/** @type {{ style: object }} */ block) => block.style,
    requestAnimationFrame: (/** @type {() => void} */ fn) => frames.push(fn),
    addEventListener: (/** @type {string} */ name, /** @type {() => void} */ fn) => {
      listeners[name] = fn;
    },
  };
  const document = {
    querySelector: () => (marks.length > 0 ? marks[0] : null),
    querySelectorAll: () => marks,
    fonts: undefined,
  };
  vm.runInNewContext(source, { window, document });
  return { listeners, frames };
}

test('a mark at the content edge of its block gets is-lead, one inside the line does not', () => {
  const marks = [fakeMark(110), fakeMark(240), fakeMark(110.4)];
  run(marks);
  assert.ok(marks[0]?.classes.has('is-lead'));
  assert.ok(!marks[1]?.classes.has('is-lead'));
  assert.ok(marks[2]?.classes.has('is-lead'));
  assert.equal(marks[0]?.props['--hang-w'], '6px', 'the width of the mark goes to the stylesheet');
});

test('a mark that a reflow moves off the line start loses is-lead', () => {
  const mark = fakeMark(110);
  const plain = mark.getBoundingClientRect;
  // After the hang is applied the word moves up to the previous line.
  mark.getBoundingClientRect = () => (mark.classes.has('is-lead') ? { left: 300, right: 306, width: 6 } : plain());
  run([mark]);
  assert.ok(!mark.classes.has('is-lead'));
});

test('a resize measures again and drops marks that moved off the line start', () => {
  const marks = [fakeMark(110)];
  const { listeners, frames } = run(marks);
  assert.ok(marks[0]?.classes.has('is-lead'));
  const mark = /** @type {ReturnType<typeof fakeMark>} */ (marks[0]);
  mark.getBoundingClientRect = () => ({ left: 300, right: 306, width: 6 });
  listeners.resize?.();
  listeners.resize?.();
  assert.equal(frames.length, 1, 'resize events in one frame run once');
  frames[0]?.();
  assert.ok(!mark.classes.has('is-lead'));
});

test('right-to-left text measures from the right edge', () => {
  const lead = fakeMark(0, 'rtl');
  const leadPlain = { left: 484, right: 490, width: 6 };
  lead.getBoundingClientRect = () => (lead.classes.has('is-lead') ? { left: 490, right: 496, width: 6 } : leadPlain);
  const inner = fakeMark(0, 'rtl');
  inner.getBoundingClientRect = () => ({ left: 300, right: 306, width: 6 });
  run([lead, inner]);
  assert.ok(lead.classes.has('is-lead'));
  assert.ok(!inner.classes.has('is-lead'));
});

test('a page with no marks starts nothing', () => {
  const { listeners, frames } = run([]);
  assert.deepEqual(Object.keys(listeners), []);
  assert.equal(frames.length, 0);
});
