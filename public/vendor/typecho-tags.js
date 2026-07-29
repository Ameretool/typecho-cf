/**
 * Typecho tags input component.
 *
 * Replaces a comma-separated text input with a tag-pill UI that supports
 * search suggestions from existing tags. Tags are NOT created until the
 * form is submitted — the backing hidden input holds the canonical
 * comma-separated value.
 *
 * Usage: <div data-tags-input="true" data-tags-api="/api/admin/tags-suggest">
 *          <input type="hidden" name="tags" value="foo,bar" />
 *        </div>
 *
 * Requires jQuery (loaded before this script).
 */
(function ($) {
  'use strict';

  function TagsInput(el) {
    var $el = $(el);
    var $hidden = $el.find('input[type=hidden]');
    var apiUrl = $el.data('tags-api') || '/api/admin/tags-suggest';
    var tags = [];
    var suggestTimer;

    // Parse initial value
    var raw = ($hidden.val() || '').trim();
    if (raw) tags = raw.split(',').map(function (t) { return t.trim(); }).filter(Boolean);

    // Build DOM
    $el.addClass('tag-input-area');
    var $pills = $('<span class="tag-pills"></span>').appendTo($el);
    var $input = $('<input type="text" class="tag-input text" placeholder="输入标签…" autocomplete="off">').appendTo($el);
    var $suggest = $('<div class="tag-suggestions"></div>').appendTo($el);

    function updateHidden() {
      $hidden.val(tags.join(','));
    }

    function renderPills() {
      $pills.empty();
      tags.forEach(function (t, i) {
        $pills.append(
          $('<span class="tag-pill">')
            .text(t)
            .append($('<span class="tag-pill-remove">&times;</span>').on('click', function () {
              tags.splice(i, 1);
              renderPills();
              updateHidden();
            }))
        );
      });
    }

    function showSuggestions(matches) {
      $suggest.empty();
      if (!matches || !matches.length) { $suggest.hide(); return; }
      var toAdd = matches.filter(function (m) { return tags.indexOf(m) === -1; });
      if (!toAdd.length) { $suggest.hide(); return; }
      toAdd.forEach(function (m) {
        $('<div class="tag-suggest-item">')
          .text(m)
          .on('mousedown', function (e) { e.preventDefault(); }) // prevent blur
          .on('click', function () {
            tags.push(m);
            renderPills();
            updateHidden();
            $input.val('');
            $suggest.hide();
          })
          .appendTo($suggest);
      });
      $suggest.show();
    }

    function fetchSuggestions(q) {
      $.getJSON(apiUrl + '?q=' + encodeURIComponent(q), function (data) {
        showSuggestions(data);
      });
    }

    $input.on('input', function () {
      var q = $input.val().trim();
      clearTimeout(suggestTimer);
      if (q.length < 1) { $suggest.hide(); return; }
      suggestTimer = setTimeout(function () { fetchSuggestions(q); }, 300);
    });

    $input.on('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        var v = $input.val().replace(/,/g, '').trim();
        if (v && tags.indexOf(v) === -1) {
          tags.push(v);
          renderPills();
          updateHidden();
        }
        $input.val('');
        $suggest.hide();
      }
      if (e.key === 'Backspace' && !$input.val() && tags.length) {
        tags.pop();
        renderPills();
        updateHidden();
      }
      if (e.key === 'Escape') { $suggest.hide(); }
    });

    $input.on('blur', function () {
      // Delay hiding suggestions so clicks register
      setTimeout(function () { $suggest.hide(); }, 150);
      // Flush any trailing text as a tag on blur
      var v = $input.val().replace(/,/g, '').trim();
      if (v && tags.indexOf(v) === -1) {
        tags.push(v);
        renderPills();
        updateHidden();
      }
      $input.val('');
    });

    // Hide suggestions when clicking outside
    $(document).on('click.tagInput', function (e) {
      if (!$.contains($el[0], e.target)) { $suggest.hide(); }
    });

    // Init
    renderPills();
    updateHidden();
  }

  // Plugin
  $(function () {
    $('[data-tags-input]').each(function () {
      new TagsInput(this);
    });
  });
})(jQuery);
