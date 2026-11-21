/* Line-start hanging punctuation of the default theme of coffer.

   With `typography: { hangLines: true }` the build wraps each opening quote or
   bracket that follows a space in <span class="hang-l" data-m="...">. Only the
   browser knows where lines break, so this script finds the marks that start a
   line, stores the width of each in `--hang-w` and gives them the class
   "is-lead"; the stylesheet then moves the mark into the margin and pulls the
   text that follows it to the content edge. Without this script the marks
   stay where they are and the page is correct.

   The hang makes its line a little shorter, so a word can move up from the next
   line. The script checks for that and drops the marks that no longer start a
   line. It runs after the page and the fonts have loaded, and again when the
   width changes. It starts nothing else and never animates. */
(function () {
  'use strict';

  var BLOCKS = 'p, li, dd, dt, td, th, blockquote, h1, h2, h3, h4, h5, h6';
  var scheduled = false;

  /**
   * Whether the mark is the first thing on its line.
   *
   * @param {Element} mark
   * @param {number} shift How far the mark is already moved into the margin, in px.
   * @returns {boolean}
   */
  function startsLine(mark, shift) {
    var block = mark.closest(BLOCKS);
    if (!block) return false;
    var style = window.getComputedStyle(block);
    var box = block.getBoundingClientRect();
    var rect = mark.getBoundingClientRect();
    if (style.direction === 'rtl') {
      var right = box.right - (parseFloat(style.paddingRight) || 0) - (parseFloat(style.borderRightWidth) || 0);
      return Math.abs(rect.right - shift - right) < 1;
    }
    var left = box.left + (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.borderLeftWidth) || 0);
    return Math.abs(rect.left + shift - left) < 1;
  }

  function update() {
    scheduled = false;
    var marks = document.querySelectorAll('.hang-l');
    var lead = [];
    var widths = [];
    var index;
    // Measure first and change after, so the reads do not mix with the writes.
    for (index = 0; index < marks.length; index++) {
      marks[index].classList.remove('is-lead');
    }
    for (index = 0; index < marks.length; index++) {
      if (startsLine(marks[index], 0)) {
        lead.push(marks[index]);
        widths.push(marks[index].getBoundingClientRect().width);
      }
    }
    for (index = 0; index < lead.length; index++) {
      lead[index].style.setProperty('--hang-w', widths[index] + 'px');
      lead[index].classList.add('is-lead');
    }
    // Drop the marks that a reflow moved off the line start. This only removes,
    // so it ends.
    for (var pass = 0; pass < 3; pass++) {
      var dropped = false;
      for (index = 0; index < lead.length; index++) {
        if (lead[index].classList.contains('is-lead') && !startsLine(lead[index], widths[index])) {
          lead[index].classList.remove('is-lead');
          dropped = true;
        }
      }
      if (!dropped) break;
    }
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    window.requestAnimationFrame(update);
  }

  if (!document.querySelector('.hang-l')) return;
  update();
  window.addEventListener('resize', schedule);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(schedule);
})();
