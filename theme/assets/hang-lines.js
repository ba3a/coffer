/* Line-start hanging punctuation of the default theme of coffer.

   With `typography: { hangLines: true }` the build wraps each opening quote or
   bracket that follows a space in <span class="hang-l" data-m="...">. Only the
   browser knows where lines break, so this script finds the marks that start a
   line and gives them the class "is-lead"; the stylesheet then shifts the mark
   into the margin. The shift is visual only and changes no layout, so it can
   never change where a line breaks. Without this script the marks stay where
   they are and the page is correct.

   It runs after the page and the fonts have loaded, and again when the width
   changes. It starts nothing else and never animates. */
(function () {
  'use strict';

  var BLOCKS = 'p, li, dd, dt, td, th, blockquote, h1, h2, h3, h4, h5, h6';
  var scheduled = false;

  /**
   * Whether the mark is the first thing on its line.
   *
   * @param {Element} mark
   * @returns {boolean}
   */
  function startsLine(mark) {
    var block = mark.closest(BLOCKS);
    if (!block) return false;
    var style = window.getComputedStyle(block);
    var box = block.getBoundingClientRect();
    var rect = mark.getBoundingClientRect();
    if (style.direction === 'rtl') {
      var right = box.right - (parseFloat(style.paddingRight) || 0) - (parseFloat(style.borderRightWidth) || 0);
      return Math.abs(right - rect.right) < 1;
    }
    var left = box.left + (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.borderLeftWidth) || 0);
    return Math.abs(rect.left - left) < 1;
  }

  function update() {
    scheduled = false;
    var marks = document.querySelectorAll('.hang-l');
    var lead = [];
    var index;
    // Measure first and change after, so the reads do not mix with the writes.
    for (index = 0; index < marks.length; index++) {
      var mark = marks[index];
      mark.classList.remove('is-lead');
    }
    for (index = 0; index < marks.length; index++) {
      if (startsLine(marks[index])) lead.push(marks[index]);
    }
    for (index = 0; index < lead.length; index++) {
      lead[index].classList.add('is-lead');
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
