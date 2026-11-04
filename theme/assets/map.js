/* Maps of the default theme of coffer, drawn with Leaflet.

   Every map of a page is an element with the attribute data-map. Without this
   script (or without Leaflet) it shows a drawing of the route and the photo
   points made at build time, the summary of each track and the download
   links. With both, the drawing is replaced by an interactive map with
   OpenStreetMap tiles (or whatever tile server the site names), the tracks
   and one marker for each place where photos were taken.

   The element holds its data in a JSON element (class "map-data"):
   { tiles: { url, attribution, maxZoom },
     labels: { zoomIn, zoomOut, label, photo },
     bounds: [[south, west], [north, east]],
     tracks: [{ title, geojson, color }],
     markers: [{ latitude, longitude, precision, indexes, label }] }
   "geojson" is the address of the simplified track, "indexes" are the places
   of the photos of a marker in the list of the viewer (viewer.js).

   - A click on a marker opens the first of its photos in the viewer, by
     clicking the link of that photo (a link with data-viewer="n").
   - The viewer's "show on map" button fires the event "coffer:show-on-map" on
     the document, with { index, latitude, longitude } as detail. The map that
     has the photo scrolls into view, centres on it and opens its marker.

   Nothing is animated. The mouse wheel zooms a map only while the map has the
   focus, so that scrolling the page past a map does not zoom it. */
(function () {
  'use strict';

  var instances = [];

  function readData(root) {
    var element = root.querySelector('script.map-data');
    if (!element) return null;
    try {
      var data = JSON.parse(element.textContent || '');
      return data && data.tiles && data.bounds ? data : null;
    } catch (error) {
      return null;
    }
  }

  /** The tooltip of a marker: plain text, never HTML. */
  function textNode(text) {
    var span = document.createElement('span');
    span.textContent = text;
    return span;
  }

  function openPhoto(index) {
    var link = document.querySelector('a[data-viewer="' + index + '"]');
    // The viewer script listens for clicks on these links; without it the
    // click opens the full-size file, which is the next best thing.
    if (link) link.click();
  }

  function select(instance, entry) {
    if (instance.selected && instance.selected.element) {
      instance.selected.element.classList.remove('is-selected');
      instance.selected.marker.closeTooltip();
    }
    instance.selected = entry;
    var element = entry.marker.getElement();
    if (element) {
      element.classList.add('is-selected');
      try {
        element.focus({ preventScroll: true });
      } catch (error) {
        // An old browser; the marker is still highlighted.
      }
    }
    entry.element = element;
    entry.marker.openTooltip();
  }

  function addMarker(L, instance, spec) {
    var count = spec.indexes.length;
    var icon = L.divIcon({
      className: 'map-marker map-marker-' + spec.precision + (count > 1 ? ' map-marker-group' : ''),
      html: count > 1 ? String(count) : '',
      iconSize: [22, 22]
    });
    var marker = L.marker([spec.latitude, spec.longitude], { icon: icon, keyboard: true, riseOnHover: true });
    marker.addTo(instance.map);
    marker.bindTooltip(textNode(spec.label), { direction: 'top', offset: [0, -12] });
    var element = marker.getElement();
    if (element) element.setAttribute('aria-label', spec.label);
    var entry = { marker: marker, indexes: spec.indexes, element: element };
    marker.on('click', function () {
      openPhoto(spec.indexes[0]);
    });
    instance.markers.push(entry);
    return entry;
  }

  function build(L, root) {
    var data = readData(root);
    var frame = root.querySelector('.map-frame');
    if (!data || !frame) return;
    var labels = data.labels || {};

    var view = document.createElement('div');
    view.className = 'map-view';
    frame.appendChild(view);

    var map = L.map(view, {
      zoomControl: false,
      scrollWheelZoom: false,
      worldCopyJump: false,
      // Leaflet animates by default; nothing on a coffer page moves by itself.
      zoomAnimation: false,
      fadeAnimation: false,
      markerZoomAnimation: false,
      inertia: false
    });
    L.control.zoom({ zoomInTitle: labels.zoomIn, zoomOutTitle: labels.zoomOut }).addTo(map);
    L.tileLayer(data.tiles.url, { attribution: data.tiles.attribution, maxZoom: data.tiles.maxZoom }).addTo(map);
    if (labels.label) view.setAttribute('aria-label', labels.label);

    var instance = { root: root, map: map, markers: [], selected: null, labels: labels };

    map.on('focus', function () {
      map.scrollWheelZoom.enable();
    });
    map.on('blur', function () {
      map.scrollWheelZoom.disable();
    });
    map.on('click', function () {
      if (instance.selected) {
        instance.selected.marker.closeTooltip();
        if (instance.selected.element) instance.selected.element.classList.remove('is-selected');
        instance.selected = null;
      }
    });

    var south = data.bounds[0][0];
    var west = data.bounds[0][1];
    var north = data.bounds[1][0];
    var east = data.bounds[1][1];
    function fit() {
      if (south === north && west === east) map.setView([south, west], 14);
      else map.fitBounds(data.bounds, { padding: [24, 24], maxZoom: 16 });
    }
    function hasSize() {
      var size = map.getSize();
      return size.x > 0 && size.y > 0;
    }
    var fitted = hasSize();
    fit();
    // A map made while its box had no size (a hidden tab, a page still laying
    // out) is fitted again when the box gets one.
    map.on('resize', function () {
      if (fitted || !hasSize()) return;
      fitted = true;
      fit();
    });

    (data.tracks || []).forEach(function (track) {
      if (typeof window.fetch !== 'function') return;
      window
        .fetch(track.geojson)
        .then(function (response) {
          if (!response.ok) throw new Error('track not found');
          return response.json();
        })
        .then(function (geojson) {
          L.geoJSON(geojson, {
            interactive: false,
            style: function () {
              return { className: 'map-track-line map-track-' + track.color, weight: 4, opacity: 1 };
            }
          }).addTo(map);
        })
        .catch(function () {
          // The track is listed and can be downloaded; the map just lacks the line.
        });
    });

    (data.markers || []).forEach(function (spec) {
      addMarker(L, instance, spec);
    });

    root.classList.add('map-live');
    // The map was created in a box that already had its size, but a theme may
    // change that after the first layout.
    map.invalidateSize();
    instances.push(instance);
  }

  function findMarker(index) {
    for (var i = 0; i < instances.length; i++) {
      for (var j = 0; j < instances[i].markers.length; j++) {
        if (instances[i].markers[j].indexes.indexOf(index) >= 0) return { instance: instances[i], entry: instances[i].markers[j] };
      }
    }
    return null;
  }

  function onShowOnMap(event) {
    var L = window.L;
    var detail = event.detail || {};
    var found = findMarker(detail.index);
    var instance = found ? found.instance : instances[0];
    if (!instance) return;
    var entry = found ? found.entry : null;
    var latitude = entry ? entry.marker.getLatLng().lat : detail.latitude;
    var longitude = entry ? entry.marker.getLatLng().lng : detail.longitude;
    if (typeof latitude !== 'number' || typeof longitude !== 'number') return;
    if (!entry) {
      // The map was told to leave this photo out; the button still answers.
      var photo = (instance.labels.photo || '{n}').replace('{n}', String(detail.index + 1));
      entry = addMarker(L, instance, {
        latitude: latitude,
        longitude: longitude,
        precision: 'exact',
        indexes: [detail.index],
        label: photo
      });
    }
    instance.root.scrollIntoView({ block: 'center' });
    instance.map.setView([latitude, longitude], Math.max(instance.map.getZoom(), 14), { animate: false });
    select(instance, entry);
  }

  function init() {
    var L = window.L;
    if (!L) return;
    var roots = document.querySelectorAll('[data-map]');
    for (var i = 0; i < roots.length; i++) {
      try {
        build(L, roots[i]);
      } catch (error) {
        // This map stays what it is without a script: the drawing.
        var half = roots[i].querySelector('.map-view');
        if (half && half.parentNode) half.parentNode.removeChild(half);
      }
    }
    document.addEventListener('coffer:show-on-map', onShowOnMap);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
