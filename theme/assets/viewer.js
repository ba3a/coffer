/* Fullscreen image viewer of the default theme of coffer.

   Every image of a page that has a full-size file is a link to it, so without
   this script a click opens the high-resolution file. With it, a click on such
   a link opens PhotoSwipe on the same image, and the viewer walks through all
   the images of the page, carousel slides included, in document order.

   The page lists its images in a JSON element (id "coffer-viewer"):
   { labels: { close, zoom, previous, next, error, showOnMap },
     images: [{ src, width, height, alt, caption, latitude?, longitude?, precision? }] }
   and the link of the n-th image has data-viewer="n".

   What the viewer does, besides what PhotoSwipe does by itself (pinch, double
   tap and click to zoom, swipe and arrow keys to move, Esc to close):

   - a caption under the image;
   - the browser's back gesture (Android back, the back button) closes the
     viewer instead of leaving the page: opening pushes a history entry and
     closing by any other means takes it off again;
   - a "show on map" button for images that have a published position, when the
     page has a map (an element with the attribute data-map). It closes the
     viewer and then fires the event "coffer:show-on-map" on the document, with
     { index, latitude, longitude, src } as detail, for the map script.

   Nothing is animated. Modified clicks (new tab, new window) are left alone. */
(function () {
  'use strict';

  var DATA_ID = 'coffer-viewer';
  var LINK_SELECTOR = 'a[data-viewer]';
  var STATE_KEY = 'cofferViewer';

  /** The data the page gives the viewer, or null. */
  function readData() {
    var element = document.getElementById(DATA_ID);
    if (!element) return null;
    try {
      var data = JSON.parse(element.textContent || '');
      return data && data.images && data.images.length ? data : null;
    } catch (error) {
      return null;
    }
  }

  function hasPosition(image) {
    return !!image && typeof image.latitude === 'number' && typeof image.longitude === 'number';
  }

  function init() {
    var data = readData();
    var PhotoSwipe = window.PhotoSwipe;
    var PhotoSwipeLightbox = window.PhotoSwipeLightbox;
    // Without the data or the library the links stay what they are: links to the full-size files.
    if (!data || !PhotoSwipe || !PhotoSwipeLightbox) return;

    var images = data.images;
    var labels = data.labels || {};

    var lightbox = new PhotoSwipeLightbox({
      dataSource: images,
      pswpModule: PhotoSwipe,
      // Nothing moves by itself: no zoom from the thumbnail, no fade.
      showHideAnimationType: 'none',
      zoomAnimationDuration: false,
      closeTitle: labels.close,
      zoomTitle: labels.zoom,
      arrowPrevTitle: labels.previous,
      arrowNextTitle: labels.next,
      errorMsg: labels.error
    });

    /** Whether the viewer owns the newest history entry. */
    var ownsEntry = false;
    /** What to tell the map once the viewer has closed. */
    var pendingMap = null;

    function current(pswp) {
      var slide = pswp.currSlide;
      return (slide && slide.data) || images[pswp.currIndex] || null;
    }

    lightbox.on('uiRegister', function () {
      var pswp = lightbox.pswp;

      pswp.ui.registerElement({
        name: 'coffer-caption',
        order: 9,
        isButton: false,
        appendTo: 'root',
        html: '',
        onInit: function (element) {
          element.setAttribute('aria-live', 'polite');
          function show() {
            var image = current(pswp);
            var caption = image && image.caption ? String(image.caption) : '';
            element.textContent = caption;
            element.hidden = caption === '';
          }
          pswp.on('change', show);
          show();
        }
      });

      pswp.ui.registerElement({
        name: 'show-on-map',
        order: 7,
        isButton: true,
        appendTo: 'bar',
        html: '',
        onInit: function (element) {
          element.textContent = labels.showOnMap || 'Show on map';
          element.setAttribute('type', 'button');
          function show() {
            var image = current(pswp);
            element.hidden = !(hasPosition(image) && document.querySelector('[data-map]'));
          }
          element.addEventListener('click', function () {
            var image = current(pswp);
            if (!hasPosition(image)) return;
            pendingMap = {
              index: pswp.currIndex,
              latitude: image.latitude,
              longitude: image.longitude,
              src: image.src
            };
            pswp.close();
          });
          pswp.on('change', show);
          show();
        }
      });
    });

    // The back gesture closes the viewer. Opening pushes an entry; a back step
    // (popstate) while the viewer owns it closes the viewer; closing in any
    // other way (Esc, the close button, a tap outside) takes the entry off again.
    lightbox.on('afterInit', function () {
      try {
        var state = {};
        state[STATE_KEY] = true;
        window.history.pushState(state, '');
        ownsEntry = true;
      } catch (error) {
        ownsEntry = false;
      }
    });
    lightbox.on('close', function () {
      if (!ownsEntry) return;
      ownsEntry = false;
      try {
        window.history.back();
      } catch (error) {
        // The entry stays; it is harmless.
      }
    });
    lightbox.on('destroy', function () {
      var wanted = pendingMap;
      pendingMap = null;
      if (!wanted) return;
      var event;
      if (typeof window.CustomEvent === 'function') event = new window.CustomEvent('coffer:show-on-map', { detail: wanted });
      else {
        event = document.createEvent('CustomEvent');
        event.initCustomEvent('coffer:show-on-map', false, false, wanted);
      }
      document.dispatchEvent(event);
    });
    window.addEventListener('popstate', function () {
      if (!ownsEntry) return;
      ownsEntry = false;
      if (lightbox.pswp) lightbox.pswp.close();
    });

    lightbox.init();

    document.addEventListener('click', function (event) {
      if (event.defaultPrevented) return;
      if (event.button > 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      var target = event.target;
      var link = target && target.closest ? target.closest(LINK_SELECTOR) : null;
      if (!link) return;
      var index = Number(link.getAttribute('data-viewer'));
      if (!(index >= 0 && index < images.length) || index !== Math.floor(index)) return;
      event.preventDefault();
      lightbox.loadAndOpen(index);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
