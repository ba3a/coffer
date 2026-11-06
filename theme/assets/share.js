/* Copy button of the share summary of a post, in the default theme of coffer.

   The summary is plain text in a <pre> inside a <details>, with a link to the
   same text as a file; it works without this script. The copy button is in the
   page with the `hidden` attribute, and only this script shows it, so that a
   visitor without JavaScript never sees a button that does nothing.

   The words the button shows come from the data-copied and data-failed
   attributes of the button, already translated by the page. The script never
   animates; it only changes the text of the status line next to the button. */
(function () {
  'use strict';

  function select(node) {
    var range = document.createRange();
    range.selectNodeContents(node);
    var selection = window.getSelection();
    if (!selection) return;
    selection.removeAllRanges();
    selection.addRange(range);
  }

  // The fallback for a browser without the asynchronous clipboard API, or a page
  // that is not a secure context: select the text and ask the browser to copy it.
  function copyBySelection(node) {
    select(node);
    try {
      return document.execCommand('copy');
    } catch (e) {
      return false;
    }
  }

  function copyText(text, node) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(
        function () {
          return true;
        },
        function () {
          return copyBySelection(node);
        }
      );
    }
    return Promise.resolve(copyBySelection(node));
  }

  function enhance(block) {
    var button = block.querySelector('.share-copy');
    var text = block.querySelector('.share-text');
    var status = block.querySelector('.share-status');
    if (!button || !text) return;
    button.hidden = false;
    button.addEventListener('click', function () {
      copyText(text.textContent || '', text).then(function (copied) {
        if (status) {
          status.textContent = (copied ? button.getAttribute('data-copied') : button.getAttribute('data-failed')) || '';
        }
      });
    });
  }

  var blocks = document.querySelectorAll('.share');
  for (var i = 0; i < blocks.length; i++) enhance(blocks[i]);
})();
