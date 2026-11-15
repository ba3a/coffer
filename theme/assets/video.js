/* Video player of the default theme of coffer.

   A remote video is published as its preview: a link to the host's page with
   the address of the player in the figure's data-video-play. Chapters and seek
   links are links to the host's page at a time. Without this script every one
   of them simply opens its address. This script adds:

   - a click on the preview puts the host's player in place of the preview and
     moves the focus to it;
   - a click on a chapter or a seek link plays the video from that time: a
     local video jumps there, a remote one reloads its player at the time
     (which works the same for every host and needs no script from it).

   Enter on a focused link reaches the page as a click of the primary button,
   so the keyboard takes the same path. A click with another button or with a
   modifier key keeps its usual meaning, such as opening a new tab.

   It loads nothing by itself, starts nothing on page load and never animates. */
(function () {
  'use strict';

  var ALLOW = 'autoplay; encrypted-media; fullscreen; picture-in-picture';

  /**
   * The player for a figure, as renderVideoHtml writes it in iframe mode.
   *
   * @param {Element} figure
   * @param {string} src
   * @returns {HTMLDivElement}
   */
  function frame(figure, src) {
    var iframe = document.createElement('iframe');
    iframe.setAttribute('src', src);
    iframe.setAttribute('title', figure.getAttribute('data-video-title') || '');
    iframe.setAttribute('allow', ALLOW);
    iframe.setAttribute('allowfullscreen', '');
    iframe.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    var box = document.createElement('div');
    box.className = 'video-frame';
    box.appendChild(iframe);
    return box;
  }

  /**
   * Puts a player playing `src` in the figure, in place of its preview, or
   * points the player already there at `src`.
   *
   * @param {Element} figure
   * @param {string} src
   * @returns {Element} The iframe.
   */
  function load(figure, src) {
    var iframe = figure.querySelector('iframe');
    if (iframe) {
      iframe.setAttribute('src', src);
      return iframe;
    }
    var box = frame(figure, src);
    var preview = figure.querySelector('a.video-preview');
    if (preview && preview.parentNode) preview.parentNode.replaceChild(box, preview);
    else figure.insertBefore(box, figure.firstChild);
    return box.firstChild;
  }

  /** @param {Element} link a.video-preview */
  function play(link, event) {
    var figure = link.closest('figure.video');
    var src = figure && figure.getAttribute('data-video-play');
    if (!src) return;
    event.preventDefault();
    load(figure, src).focus();
  }

  /** @param {Element} link An element with data-video-seek. */
  function seek(link, event) {
    var figure = document.getElementById(link.getAttribute('data-video-target') || '');
    if (!figure) return;
    var seconds = Number(link.getAttribute('data-video-seek'));
    if (!(seconds >= 0)) return;

    if (figure.getAttribute('data-video') === 'file') {
      var video = figure.querySelector('video');
      if (!video) return;
      event.preventDefault();
      video.currentTime = seconds;
      var started = video.play();
      // A browser may refuse to play; the video then waits at the time.
      if (started && typeof started.catch === 'function') started.catch(function () {});
    } else {
      var src = link.getAttribute('data-video-play');
      if (!src) return;
      event.preventDefault();
      load(figure, src);
    }
    // 'instant' keeps the jump from animating even where a style sheet asks for smooth scrolling.
    figure.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  }

  document.addEventListener('click', function (event) {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    var target = event.target;
    if (!target || typeof target.closest !== 'function') return;

    var seekLink = target.closest('[data-video-seek]');
    if (seekLink) {
      seek(seekLink, event);
      return;
    }
    var preview = target.closest('a.video-preview');
    if (preview) play(preview, event);
  });
})();
