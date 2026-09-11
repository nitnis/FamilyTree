/* ---------------------------------------------------------------
   layout.js — generations, auto-arrangement and edge routing.

   autoArrange() assigns every person an (x, y); geometry() turns the
   current positions — auto or hand-dragged — into the polylines the
   renderer draws. Keeping the two apart means a dragged card keeps
   its connectors without a relayout.
   --------------------------------------------------------------- */
(function (window) {
  'use strict';

  var M = {
    NODE_W: 176,
    NODE_H: 78,
    H_GAP: 34,          // between sibling blocks
    SPOUSE_GAP: 42,     // between partners inside a block
    V_GAP: 108,         // between generations
    PAD: 80             // padding around the whole tree
  };

  /* ----------------------------- generations ----------------------------- */

  /** Generation index per person: children always sit below their parents,
      partners always share a row. Solved by relaxation — cheap, and stable
      for the tree sizes a browser canvas is going to hold. */
  function generations(state) {
    var byId = index(state.people);
    var gen = {};
    state.people.forEach(function (p) { gen[p.id] = 0; });

    var limit = state.people.length + 4;
    for (var iter = 0; iter < limit; iter++) {
      var changed = false;
      for (var i = 0; i < state.unions.length; i++) {
        var u = state.unions[i];
        var partners = [u.a, u.b].filter(function (id) { return id && byId[id]; });
        var g = 0;
        partners.forEach(function (id) { g = Math.max(g, gen[id]); });
        partners.forEach(function (id) {
          if (gen[id] < g) { gen[id] = g; changed = true; }
        });
        for (var c = 0; c < u.children.length; c++) {
          var cid = u.children[c];
          if (!byId[cid]) continue;
          if (gen[cid] < g + 1) { gen[cid] = g + 1; changed = true; }
        }
      }
      if (!changed) break;
    }
    return gen;
  }

  /* ------------------------------- blocks -------------------------------- */

  /** A block is one person plus everyone they are partnered with (and
      everyone those people are partnered with, for remarriages) — the run of
      cards that must stay side by side on one row. */
  function buildBlocks(state, gen) {
    var byId = index(state.people);
    var parent = {};
    state.people.forEach(function (p) { parent[p.id] = p.id; });

    function find(x) {
      while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
      return x;
    }
    function join(a, b) {
      var ra = find(a), rb = find(b);
      if (ra !== rb) parent[rb] = ra;
    }

    state.unions.forEach(function (u) {
      if (u.a && u.b && byId[u.a] && byId[u.b]) join(u.a, u.b);
    });

    var groups = {};
    state.people.forEach(function (p) {
      var root = find(p.id);
      (groups[root] || (groups[root] = [])).push(p.id);
    });

    var blocks = [];
    var blockOf = {};
    Object.keys(groups).forEach(function (root) {
      var members = orderMembers(groups[root], state, byId);
      var g = 0;
      members.forEach(function (id) { g = Math.max(g, gen[id] || 0); });
      var block = {
        id: root,
        members: members,
        gen: g,
        unions: [],
        childBlocks: [],
        parentBlock: null,
        indexOf: Object.create(null),
        anchorGroups: [],
        x: 0
      };
      members.forEach(function (id, i) { blockOf[id] = block; block.indexOf[id] = i; });
      blocks.push(block);
    });

    state.unions.forEach(function (u) {
      var anchor = (u.a && blockOf[u.a]) || (u.b && blockOf[u.b]);
      if (anchor) anchor.unions.push(u);
    });

    return { blocks: blocks, blockOf: blockOf };
  }

  /** Walk the partner chain so remarried people sit between their spouses. */
  function orderMembers(ids, state, byId) {
    if (ids.length === 1) return ids.slice();

    var adj = {};
    ids.forEach(function (id) { adj[id] = []; });
    state.unions.forEach(function (u) {
      if (!u.a || !u.b) return;
      if (adj[u.a] && adj[u.b]) { adj[u.a].push(u.b); adj[u.b].push(u.a); }
    });

    // Start from an end of the chain when there is one.
    var start = ids.slice().sort(function (a, b) { return adj[a].length - adj[b].length; })[0];
    var order = [];
    var seen = {};
    var cur = start;
    while (cur) {
      order.push(cur);
      seen[cur] = true;
      var next = null;
      for (var i = 0; i < adj[cur].length; i++) {
        if (!seen[adj[cur][i]]) { next = adj[cur][i]; break; }
      }
      cur = next;
    }
    // Anything left (branching partner graphs) is appended in input order.
    ids.forEach(function (id) { if (!seen[id]) order.push(id); });
    return order;
  }

  /* ----------------------------- arrangement ----------------------------- */

  /**
   * Re-position every person: generation rows top to bottom, parents
   * centred over their children, subtrees packed left to right.
   * Clears any manual pinning.
   */
  function autoArrange(state) {
    if (!state.people.length) return;

    var byId = index(state.people);
    var gen = generations(state);
    var built = buildBlocks(state, gen);
    var blocks = built.blocks;
    var blockOf = built.blockOf;

    // Which block adopts each block as a child subtree.
    blocks.forEach(function (b) {
      for (var i = 0; i < b.members.length; i++) {
        var pu = parentUnionOf(state, b.members[i]);
        if (!pu) continue;
        var owner = (pu.a && blockOf[pu.a]) || (pu.b && blockOf[pu.b]) || null;
        if (owner && owner !== b && owner.gen < b.gen) { b.parentBlock = owner; break; }
      }
    });

    blocks.forEach(function (b) {
      var kids = [];
      var groups = [];
      var seen = {};
      b.unions.forEach(function (u) {
        var mine = [];
        u.children.slice().sort(function (x, y) {
          return birthKey(byId[x]) - birthKey(byId[y]);
        }).forEach(function (cid) {
          var cb = blockOf[cid];
          if (!cb || cb === b || seen[cb.id]) return;
          if (cb.parentBlock !== b) return;
          seen[cb.id] = true;
          kids.push(cb);
          mine.push(cid);
        });
        // Each union keeps its own children, so its junction can be placed
        // over them rather than over every child in the block.
        if (mine.length) groups.push({ union: u, anchors: mine });
      });
      b.childBlocks = kids;
      b.anchorGroups = groups;
    });

    var cursor = {};
    var placed = {};

    function width(b) {
      return b.members.length * M.NODE_W + (b.members.length - 1) * M.SPOUSE_GAP;
    }
    function floorAt(g) {
      return cursor[g] === undefined ? 0 : cursor[g];
    }
    function shift(b, dx) {
      b.x += dx;
      cursor[b.gen] = Math.max(floorAt(b.gen), b.x + width(b) + M.H_GAP);
      b.childBlocks.forEach(function (k) { shift(k, dx); });
    }
    function memberOffset(b, personId) {
      return (b.indexOf[personId] || 0) * (M.NODE_W + M.SPOUSE_GAP);
    }
    function cardCentre(personId) {
      var cb = blockOf[personId];
      if (!cb) return 0;
      return cb.x + memberOffset(cb, personId) + M.NODE_W / 2;
    }

    /** Where a union's junction sits, measured from its block's left edge.
        Must match geometry(): the midpoint between a couple's facing edges,
        or the centre of a lone parent's card. */
    function junctionOffset(b, u) {
      var hasA = u.a !== null && u.a in b.indexOf;
      var hasB = u.b !== null && u.b in b.indexOf;
      if (!hasA && !hasB) return width(b) / 2;
      if (!hasA || !hasB) return memberOffset(b, hasA ? u.a : u.b) + M.NODE_W / 2;
      var oa = memberOffset(b, u.a);
      var ob = memberOffset(b, u.b);
      return (Math.min(oa, ob) + M.NODE_W + Math.max(oa, ob)) / 2;
    }

    /**
     * Where the block wants to sit so each junction lands over the middle of
     * that union's own children.
     *
     * A single union solves exactly. A remarriage with children on both sides
     * often cannot: the junctions are one member-step apart, while the sibling
     * groups below can be spread much wider, and closing that gap would mean
     * marriage bars several card-widths long. So the residual is shared out,
     * weighted by how much error each union can absorb — a junction over a
     * wide sibling bus still meets it well inside its span, whereas one over a
     * single child turns into a visible horizontal jog, so narrow groups pull
     * harder. With one union the weight cancels and the fit stays exact.
     */
    function desiredX(b) {
      if (b.anchorGroups.length) {
        var sum = 0, total = 0;
        b.anchorGroups.forEach(function (g) {
          var lo = Infinity, hi = -Infinity;
          g.anchors.forEach(function (cid) {
            var c = cardCentre(cid);
            lo = Math.min(lo, c);
            hi = Math.max(hi, c);
          });
          var weight = 1 / (hi - lo + M.NODE_W);
          sum += ((lo + hi) / 2 - junctionOffset(b, g.union)) * weight;
          total += weight;
        });
        return sum / total;
      }
      var left = Infinity, right = -Infinity;
      b.childBlocks.forEach(function (k) {
        left = Math.min(left, k.x + M.NODE_W / 2);
        right = Math.max(right, k.x + width(k) - M.NODE_W / 2);
      });
      return (left + right) / 2 - width(b) / 2;
    }
    function place(b) {
      if (placed[b.id]) return;
      placed[b.id] = true;

      b.childBlocks.forEach(place);

      var w = width(b);
      var min = floorAt(b.gen);
      var x = min;

      if (b.childBlocks.length) {
        x = desiredX(b);
        if (x < min) {
          // No room to centre here: push the whole subtree right instead.
          var dx = min - x;
          b.childBlocks.forEach(function (k) { shift(k, dx); });
          x = min;
        }
      }

      b.x = x;
      cursor[b.gen] = x + w + M.H_GAP;
    }

    blocks
      .filter(function (b) { return !b.parentBlock; })
      .sort(function (a, b) { return a.gen - b.gen; })
      .forEach(place);
    blocks.forEach(place); // anything unreachable (shouldn't happen, cheap to be safe)

    blocks.forEach(function (b) {
      var y = b.gen * (M.NODE_H + M.V_GAP);
      b.members.forEach(function (id, i) {
        var p = byId[id];
        if (!p) return;
        p.x = b.x + i * (M.NODE_W + M.SPOUSE_GAP);
        p.y = y;
        p.pinned = false;
      });
    });

    normalize(state);
  }

  /** Shift everything so the tree starts at a consistent top-left origin. */
  function normalize(state) {
    if (!state.people.length) return;
    var minX = Infinity, minY = Infinity;
    state.people.forEach(function (p) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
    });
    var dx = M.PAD - minX, dy = M.PAD - minY;
    state.people.forEach(function (p) { p.x += dx; p.y += dy; });
  }

  /* ------------------------------ geometry ------------------------------ */

  /**
   * Turn current person positions into drawable shapes:
   * node rects, partner bars, and orthogonal parent→child drops.
   */
  function geometry(state) {
    var nodes = {};
    state.people.forEach(function (p) {
      nodes[p.id] = {
        id: p.id,
        person: p,
        x: p.x,
        y: p.y,
        w: M.NODE_W,
        h: M.NODE_H,
        cx: p.x + M.NODE_W / 2,
        cy: p.y + M.NODE_H / 2
      };
    });

    var links = [];
    state.unions.forEach(function (u) {
      var a = u.a ? nodes[u.a] : null;
      var b = u.b ? nodes[u.b] : null;
      if (!a && !b) return;
      if (!a) { a = b; b = null; }

      var link = { union: u, a: a, b: b, bar: null, junction: null, drops: [], busY: 0 };

      if (b) {
        var left = a.cx <= b.cx ? a : b;
        var right = left === a ? b : a;
        var y = (left.cy + right.cy) / 2;
        link.bar = { x1: left.x + left.w, x2: right.x, y1: left.cy, y2: right.cy, y: y };
        link.junction = { x: (left.x + left.w + right.x) / 2, y: y };
      } else {
        link.junction = { x: a.cx, y: a.y + a.h };
      }

      var kids = u.children.map(function (id) { return nodes[id]; }).filter(Boolean);
      if (kids.length) {
        var parentBottom = Math.max(a.y + a.h, b ? b.y + b.h : -Infinity);
        var childTop = Infinity;
        kids.forEach(function (k) { childTop = Math.min(childTop, k.y); });

        var busY;
        if (childTop - parentBottom > 44) {
          busY = childTop - Math.min(34, (childTop - parentBottom) / 2);
        } else {
          busY = (parentBottom + childTop) / 2;
        }
        link.busY = busY;

        var minX = link.junction.x, maxX = link.junction.x;
        kids.forEach(function (k) {
          minX = Math.min(minX, k.cx);
          maxX = Math.max(maxX, k.cx);
          link.drops.push({ id: k.id, x: k.cx, top: k.y });
        });
        link.bus = { x1: minX, x2: maxX, y: busY };
        link.stem = { x: link.junction.x, y1: link.junction.y, y2: busY };
      }

      links.push(link);
    });

    return { nodes: nodes, links: links, bounds: bounds(state) };
  }

  function bounds(state) {
    if (!state.people.length) {
      return { minX: 0, minY: 0, maxX: M.NODE_W, maxY: M.NODE_H, w: M.NODE_W, h: M.NODE_H };
    }
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    state.people.forEach(function (p) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + M.NODE_W);
      maxY = Math.max(maxY, p.y + M.NODE_H);
    });
    return { minX: minX, minY: minY, maxX: maxX, maxY: maxY, w: maxX - minX, h: maxY - minY };
  }

  /* ------------------------------- helpers ------------------------------- */

  function index(people) {
    var byId = {};
    people.forEach(function (p) { byId[p.id] = p; });
    return byId;
  }

  function parentUnionOf(state, id) {
    for (var i = 0; i < state.unions.length; i++) {
      if (state.unions[i].children.indexOf(id) >= 0) return state.unions[i];
    }
    return null;
  }

  function birthKey(p) {
    if (!p || !p.birthDate) return Number.MAX_SAFE_INTEGER;
    var t = Date.parse(p.birthDate);
    if (!isNaN(t)) return t;
    var m = String(p.birthDate).match(/\d{4}/);
    return m ? Number(m[0]) * 31536000000 : Number.MAX_SAFE_INTEGER;
  }

  window.FT = window.FT || {};
  window.FT.Layout = {
    METRICS: M,
    generations: generations,
    autoArrange: autoArrange,
    geometry: geometry,
    bounds: bounds,
    normalize: normalize
  };
})(window);
