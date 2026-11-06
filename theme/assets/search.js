/* Search enhancement of the default theme of coffer.

   The search page is plain text, and a link to the tag tree, until this script
   has found Pagefind's modular UI (written next to the index, in /pagefind/).
   Then it marks the page as ready, which shows the form, the status line and
   the results, and hides the explanation.

   The page tells the script, in its data-search attribute (JSON), where the
   Pagefind bundle is, which filters to search with (so a blog's search page only
   finds that blog's posts) and the words to show. It never starts a search by
   itself, except for a term in the address (?q=...), and it never animates. */
(function () {
  'use strict';

  var root = document.querySelector('[data-search]');
  if (!root || !window.PagefindModularUI) return;

  var data;
  try {
    data = JSON.parse(root.getAttribute('data-search') || '');
  } catch (e) {
    return;
  }
  var text = data.text || {};
  var form = root.querySelector('.search-form');
  var input = root.querySelector('.search-input');
  var status = root.querySelector('.search-status');
  var list = root.querySelector('.search-results');
  if (!form || !input || !status || !list) return;

  var UI = window.PagefindModularUI;
  var instance = new UI.Instance({ bundlePath: data.bundle });
  // Registered before the Input component's own listeners, so that the filters
  // are in place before the first search.
  var filtersApplied = false;
  function applyFilters() {
    if (filtersApplied) return;
    filtersApplied = true;
    instance.searchFilters = data.filters || {};
  }
  input.addEventListener('focus', applyFilters);
  input.addEventListener('input', applyFilters);
  instance.add(new UI.Input({ inputElement: '#' + input.id }));

  form.addEventListener('submit', function (event) {
    event.preventDefault();
  });

  var shown = 0;

  function setStatus(message) {
    status.textContent = message;
  }

  function fill(template, values) {
    return String(template || '').replace(/\{(\w+)\}/g, function (whole, name) {
      return Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : whole;
    });
  }

  function resultItem(result) {
    var item = document.createElement('li');
    item.className = 'search-result';
    var title = document.createElement('h2');
    title.className = 'search-result-title';
    var link = document.createElement('a');
    link.href = (result.meta && result.meta.url) || result.url;
    link.textContent = (result.meta && result.meta.title) || result.url;
    title.appendChild(link);
    item.appendChild(title);
    var excerpt = document.createElement('p');
    excerpt.className = 'search-result-excerpt';
    // Pagefind escapes the text of the excerpt and marks the matches with <mark>.
    excerpt.innerHTML = result.excerpt;
    item.appendChild(excerpt);
    return item;
  }

  instance.on('loading', function () {
    shown += 1;
    if (input.value.trim() !== '') setStatus(text.searching);
  });

  instance.on('results', function (found) {
    var term = input.value.trim();
    var token = ++shown;
    list.textContent = '';
    if (term === '' || !found || !found.results) {
      setStatus('');
      return;
    }
    var results = found.results;
    if (results.length === 0) {
      setStatus(fill(text.none, { query: '“' + term + '”' }));
      return;
    }
    setStatus(fill(text.found, { count: results.length }));
    Promise.all(
      results.map(function (result) {
        return result.data();
      }),
    ).then(function (all) {
      if (token !== shown) return;
      for (var i = 0; i < all.length; i++) list.appendChild(resultItem(all[i]));
    });
  });

  // Fail visibly if the index cannot be loaded; the explanation and the link to the tags come back.
  function failed() {
    root.removeAttribute('data-search-ready');
    var note = root.querySelector('.search-nojs p');
    if (note && text.error) note.textContent = text.error;
  }

  import(data.bundle + 'pagefind.js').then(
    function () {
      root.setAttribute('data-search-ready', 'true');
      var params = new URLSearchParams(window.location.search);
      var initial = params.get('q');
      if (initial) {
        input.value = initial;
        applyFilters();
        instance.triggerSearch(initial);
      }
    },
    function () {
      failed();
    },
  );
})();
