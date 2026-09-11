/* ---------------------------------------------------------------
   focus.js — show one person's corner of a large tree.

   A tree of any size can be read a family at a time: pick a person
   and keep only those within a few steps of them. Steps are counted
   along parent/child links only. Partners come along so no couple is
   left half-drawn, but they are not walked through — otherwise every
   marriage would drag in another whole family and the radius would
   mean nothing.

   Depth 1 is parents and children; 2 adds grandparents, grandchildren
   and siblings; 3 adds great-grandparents, aunts, uncles, nieces and
   nephews.
   --------------------------------------------------------------- */
(function (window) {
  'use strict';

  var FT = window.FT;

  function index(people) {
    var byId = {};
    people.forEach(function (p) { byId[p.id] = p; });
    return byId;
  }

  /** Parent and child adjacency, derived from the unions. */
  function adjacency(state, byId) {
    var parents = {}, children = {};
    state.unions.forEach(function (u) {
      var ps = [u.a, u.b].filter(function (id) { return id && byId[id]; });
      (u.children || []).forEach(function (c) {
        if (!byId[c]) return;
        parents[c] = (parents[c] || []).concat(ps);
        ps.forEach(function (p) { children[p] = (children[p] || []).concat([c]); });
      });
    });
    return { parents: parents, children: children };
  }

  /**
   * Everyone within `depth` parent/child steps of `rootId`, plus the
   * partners of those people. Returns a set of ids, or null if the person
   * is not in this tree.
   */
  function related(state, rootId, depth) {
    var byId = index(state.people);
    if (!byId[rootId]) return null;

    var adj = adjacency(state, byId);
    var limit = (depth === Infinity || !depth) ? Infinity : depth;

    var seen = {};
    seen[rootId] = 0;
    var queue = [rootId];
    for (var i = 0; i < queue.length; i++) {
      var id = queue[i];
      var d = seen[id];
      if (d >= limit) continue;
      var next = (adj.parents[id] || []).concat(adj.children[id] || []);
      for (var n = 0; n < next.length; n++) {
        var other = next[n];
        if (seen[other] !== undefined) continue;
        seen[other] = d + 1;
        queue.push(other);
      }
    }

    // One level of partners, taken from the walked set only, so a marriage
    // cannot chain outwards into another family.
    var core = seen;
    var ids = {};
    Object.keys(core).forEach(function (id) { ids[id] = true; });
    state.unions.forEach(function (u) {
      if (!u.a || !u.b) return;
      if (core[u.a] !== undefined && byId[u.b]) ids[u.b] = true;
      if (core[u.b] !== undefined && byId[u.a]) ids[u.a] = true;
    });
    return ids;
  }

  function count(ids) {
    return Object.keys(ids || {}).length;
  }

  /**
   * A standalone tree holding only those people, laid out afresh. The
   * people are copies, so arranging the excerpt never disturbs the
   * positions of the real tree.
   */
  function subtree(state, rootId, depth) {
    var ids = related(state, rootId, depth);
    if (!ids) return null;

    var out = {
      format: state.format,
      version: state.version,
      title: state.title,
      people: [],
      unions: []
    };

    state.people.forEach(function (p) {
      if (ids[p.id]) out.people.push(FT.clone(p));
    });

    state.unions.forEach(function (u) {
      var a = u.a && ids[u.a] ? u.a : null;
      var b = u.b && ids[u.b] ? u.b : null;
      if (!a && b) { a = b; b = null; }
      var kids = (u.children || []).filter(function (c) { return ids[c]; });
      // With neither parent in view the children are roots of the excerpt,
      // so the union has nothing left to draw.
      if (!a) return;
      if (!b && !kids.length) return;
      out.unions.push({
        id: u.id, a: a, b: b, type: u.type, date: u.date, children: kids
      });
    });

    out.people.forEach(function (p) { p.x = 0; p.y = 0; p.pinned = false; });
    FT.Layout.autoArrange(out);
    return out;
  }

  window.FT.Focus = {
    related: related,
    subtree: subtree,
    count: count,
    DEPTHS: [1, 2, 3, Infinity],
    DEFAULT_DEPTH: 2
  };
})(window);
