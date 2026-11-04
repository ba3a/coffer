/* Carousel enhancement of the default theme of coffer.

   A carousel is a sideways scrolling list of slides that works without this
   script (see "Carousels" in coffer.css). This script only adds, for carousels
   with more than one slide:

   - Previous and Next buttons,
   - a position indicator such as "2 / 7",
   - the arrow keys, Home and End while the focus is in the carousel.

   It never starts anything by itself and never animates: a slide is shown by
   jumping to it. */
(function () {
  'use strict';

  var SELECTOR = '[data-carousel]';

  /**
   * @param {Element} root The carousel region.
   */
  function enhance(root) {
    if (root.getAttribute('data-carousel-ready') === 'true') return;
    var track = root.querySelector('.carousel-track');
    if (!track) return;
    var slides = track.children;
    var count = slides.length;
    if (count < 2) return;
    root.setAttribute('data-carousel-ready', 'true');

    var previous = button('previous', root.getAttribute('data-label-previous') || 'Previous image', '‹');
    var next = button('next', root.getAttribute('data-label-next') || 'Next image', '›');
    var position = document.createElement('span');
    position.className = 'carousel-position';
    // The position is announced when it changes, without taking the focus.
    position.setAttribute('aria-live', 'polite');
    var controls = document.createElement('div');
    controls.className = 'carousel-controls';
    controls.appendChild(previous);
    controls.appendChild(position);
    controls.appendChild(next);
    root.appendChild(controls);

    var index = 0;

    function button(kind, label, text) {
      var element = document.createElement('button');
      element.type = 'button';
      element.className = 'carousel-button carousel-' + kind;
      element.setAttribute('aria-label', label);
      element.textContent = text;
      return element;
    }

    /** The slide whose left edge is closest to the left edge of the track. */
    function nearest() {
      var origin = track.getBoundingClientRect().left;
      var best = 0;
      var distance = Infinity;
      for (var i = 0; i < count; i++) {
        var d = Math.abs(slides[i].getBoundingClientRect().left - origin);
        if (d < distance) {
          distance = d;
          best = i;
        }
      }
      return best;
    }

    function show(shown) {
      index = shown;
      position.textContent = shown + 1 + ' / ' + count;
      previous.setAttribute('aria-disabled', shown === 0 ? 'true' : 'false');
      next.setAttribute('aria-disabled', shown === count - 1 ? 'true' : 'false');
    }

    function go(wanted) {
      var target = Math.max(0, Math.min(count - 1, wanted));
      var shift = slides[target].getBoundingClientRect().left - track.getBoundingClientRect().left;
      // 'instant' keeps the jump from animating even where a style sheet asks for smooth scrolling.
      track.scrollTo({ left: track.scrollLeft + shift, behavior: 'instant' });
      show(target);
    }

    previous.addEventListener('click', function () {
      go(index - 1);
    });
    next.addEventListener('click', function () {
      go(index + 1);
    });
    track.addEventListener('scroll', function () {
      show(nearest());
    });
    root.addEventListener('keydown', function (event) {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      var wanted;
      if (event.key === 'ArrowLeft') wanted = index - 1;
      else if (event.key === 'ArrowRight') wanted = index + 1;
      else if (event.key === 'Home') wanted = 0;
      else if (event.key === 'End') wanted = count - 1;
      else return;
      event.preventDefault();
      go(wanted);
    });

    show(nearest());
  }

  function enhanceAll() {
    var roots = document.querySelectorAll(SELECTOR);
    for (var i = 0; i < roots.length; i++) enhance(roots[i]);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', enhanceAll);
  else enhanceAll();
})();
