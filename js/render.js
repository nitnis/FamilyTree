/* ---------------------------------------------------------------
   render.js — everything that puts pixels on the canvas.

   The renderer owns the viewport (pan/zoom) and draws in world
   coordinates, so the same paint routine serves the live canvas and
   the PNG export.
   --------------------------------------------------------------- */
(function (window) {
  'use strict';

  var M = window.FT.Layout.METRICS;

  var THEMES = {
    light: {
      bg: '#f4f5f7',
      dot: 'rgba(29,33,41,.09)',
      card: '#ffffff',
      cardAlt: '#fbfcfd',
      cardBorder: '#dfe3e8',
      shadow: 'rgba(16,24,40,.16)',
      text: '#1d2129',
      dim: '#667085',
      faint: '#98a2b3',
      line: '#a9b2bf',
      lineStrong: '#7b8797',
      accent: '#2f6f4e',
      accentSoft: 'rgba(47,111,78,.14)',
      highlight: '#d9932a',
      male: '#3d7dd6',
      female: '#c0559a',
      other: '#8a6bd1',
      dead: '#98a2b3'
    },
    dark: {
      bg: '#14161a',
      dot: 'rgba(231,234,238,.08)',
      card: '#1e2228',
      cardAlt: '#23272e',
      cardBorder: '#343a44',
      shadow: 'rgba(0,0,0,.5)',
      text: '#e7eaee',
      dim: '#9aa3b0',
      faint: '#6f7885',
      line: '#4d5561',
      lineStrong: '#6f7885',
      accent: '#5fb98a',
      accentSoft: 'rgba(95,185,138,.18)',
      highlight: '#e0a84a',
      male: '#6ba3ea',
      female: '#dc82bd',
      other: '#a98ee6',
      dead: '#6f7885'
    }
  };

  var Renderer = {
    canvas: null,
    ctx: null,
    dpr: 1,
    width: 0,
    height: 0,
    theme: THEMES.light,
    themeName: 'light',
    view: { x: 0, y: 0, k: 1 },
    MIN_K: 0.02,
    MAX_K: 3,

    attach: function (canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.resize();
      return this;
    },

    setTheme: function (name) {
      this.themeName = THEMES[name] ? name : 'light';
      this.theme = THEMES[this.themeName];
    },

    resize: function () {
      var c = this.canvas;
      if (!c) return;
      var rect = c.getBoundingClientRect();
      var prevW = this.width, prevH = this.height;
      this.dpr = window.devicePixelRatio || 1;
      this.width = Math.max(1, Math.round(rect.width));
      this.height = Math.max(1, Math.round(rect.height));
      c.width = Math.round(this.width * this.dpr);
      c.height = Math.round(this.height * this.dpr);

      // Keep whatever was in the middle of the canvas in the middle, so
      // hiding a panel or resizing the window does not slide the tree away.
      if (prevW && prevH) {
        this.view.x += (this.width - prevW) / 2;
        this.view.y += (this.height - prevH) / 2;
      }
    },

    /* ----------------------------- viewport ----------------------------- */

    screenToWorld: function (sx, sy) {
      return { x: (sx - this.view.x) / this.view.k, y: (sy - this.view.y) / this.view.k };
    },

    worldToScreen: function (wx, wy) {
      return { x: wx * this.view.k + this.view.x, y: wy * this.view.k + this.view.y };
    },

    /** Zoom about a screen point so the world point under it stays put. */
    zoomAt: function (sx, sy, factor) {
      var k = clamp(this.view.k * factor, this.MIN_K, this.MAX_K);
      if (k === this.view.k) return;
      var w = this.screenToWorld(sx, sy);
      this.view.k = k;
      this.view.x = sx - w.x * k;
      this.view.y = sy - w.y * k;
    },

    setZoom: function (k) {
      this.zoomAt(this.width / 2, this.height / 2, clamp(k, this.MIN_K, this.MAX_K) / this.view.k);
    },

    panBy: function (dx, dy) {
      this.view.x += dx;
      this.view.y += dy;
    },

    /** Fit the whole tree in view with a comfortable margin. */
    fit: function (state, maxZoom) {
      var b = window.FT.Layout.bounds(state);
      var pad = 60;
      var kx = (this.width - pad * 2) / Math.max(1, b.w);
      var ky = (this.height - pad * 2) / Math.max(1, b.h);
      var k = clamp(Math.min(kx, ky), this.MIN_K, maxZoom || 1.1);
      this.view.k = k;
      this.view.x = this.width / 2 - (b.minX + b.w / 2) * k;
      this.view.y = this.height / 2 - (b.minY + b.h / 2) * k;
    },

    /**
     * Open at a scale the cards can actually be read at.
     *
     * A wide tree cannot fit legibly on any screen — 37 people across is
     * 8900px, which fits a phone only at 3%, where a card is five pixels and
     * no text is drawn at all. Rather than open on a blank-looking canvas,
     * frame the oldest generation at a readable zoom and let Fit show the
     * whole shape on demand. Returns true when it had to do that.
     */
    frame: function (state, minReadable) {
      if (!state.people.length) return false;
      var floor = minReadable || 0.6;
      var b = window.FT.Layout.bounds(state);
      var pad = 60;
      var fitK = Math.min((this.width - pad * 2) / Math.max(1, b.w),
                          (this.height - pad * 2) / Math.max(1, b.h));

      if (fitK >= floor) {
        this.fit(state);
        return false;
      }

      this.view.k = clamp(floor, this.MIN_K, this.MAX_K);
      // Anchor on a real card, not the midpoint of the row's extent: the
      // oldest generation can be spread right across a wide tree, and its
      // midpoint often falls in a gap between people.
      var start = firstPerson(state);
      this.view.x = pad - start.x * this.view.k;
      // Extra room at the top so the first card clears the viewer's title chip.
      this.view.y = 104 - start.y * this.view.k;
      return true;
    },

    /** Pan so a person is centred, keeping the current zoom. */
    centerOn: function (person) {
      if (!person) return;
      this.view.x = this.width / 2 - (person.x + M.NODE_W / 2) * this.view.k;
      this.view.y = this.height / 2 - (person.y + M.NODE_H / 2) * this.view.k;
    },

    /* ------------------------------ hit test ---------------------------- */

    hitTest: function (geo, wx, wy) {
      var ids = Object.keys(geo.nodes);
      // Later people sit on top, so walk backwards.
      for (var i = ids.length - 1; i >= 0; i--) {
        var n = geo.nodes[ids[i]];
        if (wx >= n.x && wx <= n.x + n.w && wy >= n.y && wy <= n.y + n.h) return n;
      }
      return null;
    },

    /* ------------------------------ drawing ----------------------------- */

    draw: function (state, geo, opts) {
      opts = opts || {};
      var ctx = this.ctx;
      if (!ctx) return;
      var t = this.theme;

      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.fillStyle = t.bg;
      ctx.fillRect(0, 0, this.width, this.height);

      this.drawDots();

      ctx.save();
      ctx.translate(this.view.x, this.view.y);
      ctx.scale(this.view.k, this.view.k);
      opts.lod = this.view.k;
      this.paint(ctx, state, geo, opts);
      ctx.restore();
    },

    drawDots: function () {
      var k = this.view.k;
      if (k < 0.45) return;
      var ctx = this.ctx;
      var step = 28 * k;
      while (step < 18) step *= 2;
      var ox = this.view.x % step;
      var oy = this.view.y % step;
      ctx.fillStyle = this.theme.dot;
      for (var x = ox; x < this.width; x += step) {
        for (var y = oy; y < this.height; y += step) {
          ctx.fillRect(x, y, 1.4, 1.4);
        }
      }
    },

    /** World-space paint shared by the screen canvas and PNG export. */
    paint: function (ctx, state, geo, opts) {
      var self = this;
      geo.links.forEach(function (link) { self.drawLink(ctx, link, opts); });
      state.people.forEach(function (p) {
        var n = geo.nodes[p.id];
        if (n) self.drawNode(ctx, n, opts);
      });
    },

    drawLink: function (ctx, link, opts) {
      var t = this.theme;
      var u = link.union;
      var related = opts.relatedUnions && opts.relatedUnions[u.id];

      ctx.save();
      ctx.lineWidth = related ? 2.4 : 1.8;
      ctx.strokeStyle = related ? t.accent : t.line;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      // Partner bar.
      if (link.bar) {
        var bar = link.bar;
        ctx.save();
        if (u.type === 'partners' || u.type === 'engaged') ctx.setLineDash([6, 5]);
        ctx.beginPath();
        ctx.moveTo(bar.x1, bar.y1);
        ctx.lineTo(bar.x2, bar.y2);
        ctx.stroke();
        ctx.restore();

        if (u.type === 'divorced') {
          // Two slashes across the bar, the genealogy convention for a split.
          var jx = link.junction.x, jy = link.junction.y;
          ctx.beginPath();
          ctx.moveTo(jx - 7, jy + 7); ctx.lineTo(jx - 1, jy - 7);
          ctx.moveTo(jx + 1, jy + 7); ctx.lineTo(jx + 7, jy - 7);
          ctx.stroke();
        } else if (u.type === 'married') {
          ctx.fillStyle = related ? t.accent : t.lineStrong;
          ctx.beginPath();
          ctx.arc(link.junction.x, link.junction.y, 3.4, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // Parent → children drop.
      if (link.drops && link.drops.length) {
        var r = 9;
        ctx.beginPath();
        ctx.moveTo(link.stem.x, link.stem.y1);
        ctx.lineTo(link.stem.x, link.stem.y2);
        ctx.stroke();

        if (link.drops.length === 1 && Math.abs(link.drops[0].x - link.stem.x) < 0.5) {
          ctx.beginPath();
          ctx.moveTo(link.stem.x, link.stem.y2);
          ctx.lineTo(link.drops[0].x, link.drops[0].top);
          ctx.stroke();
        } else {
          ctx.beginPath();
          ctx.moveTo(link.bus.x1, link.bus.y);
          ctx.lineTo(link.bus.x2, link.bus.y);
          ctx.stroke();
          link.drops.forEach(function (d) {
            ctx.beginPath();
            var dir = d.x < link.stem.x ? 1 : (d.x > link.stem.x ? -1 : 0);
            if (Math.abs(d.top - link.bus.y) > r * 2 && dir !== 0) {
              // Soften the elbow where the drop leaves the bus.
              ctx.moveTo(d.x - dir * r, link.bus.y);
              ctx.quadraticCurveTo(d.x, link.bus.y, d.x, link.bus.y + r);
              ctx.lineTo(d.x, d.top);
            } else {
              ctx.moveTo(d.x, link.bus.y);
              ctx.lineTo(d.x, d.top);
            }
            ctx.stroke();
            // Arrow-free tick where the line meets the card.
            ctx.fillStyle = related ? t.accent : t.line;
            ctx.beginPath();
            ctx.arc(d.x, d.top, 2.2, 0, Math.PI * 2);
            ctx.fill();
          });
        }
      }

      ctx.restore();
    },

    drawNode: function (ctx, n, opts) {
      var t = this.theme;
      var p = n.person;
      var selected = opts.selectedId === p.id;
      var hovered = opts.hoverId === p.id;
      var matched = opts.matchIds && opts.matchIds[p.id];
      var dimmed = opts.matchIds && !matched && opts.hasQuery;
      var accent = p.deceased ? t.dead : (t[p.gender] || t.other);

      ctx.save();
      if (dimmed) ctx.globalAlpha = 0.35;

      // Card body.
      ctx.save();
      ctx.shadowColor = t.shadow;
      ctx.shadowBlur = selected ? 18 : 10;
      ctx.shadowOffsetY = selected ? 5 : 3;
      roundRect(ctx, n.x, n.y, n.w, n.h, 12);
      ctx.fillStyle = t.card;
      ctx.fill();
      ctx.restore();

      // Gender stripe down the left edge.
      ctx.save();
      roundRect(ctx, n.x, n.y, n.w, n.h, 12);
      ctx.clip();
      ctx.fillStyle = accent;
      ctx.fillRect(n.x, n.y, 5, n.h);
      ctx.restore();

      // Border.
      roundRect(ctx, n.x + 0.5, n.y + 0.5, n.w - 1, n.h - 1, 12);
      ctx.lineWidth = selected ? 2 : 1;
      ctx.strokeStyle = selected ? t.accent : (hovered ? t.lineStrong : t.cardBorder);
      if (p.deceased && !selected) ctx.setLineDash([5, 4]);
      ctx.stroke();
      ctx.setLineDash([]);

      if (matched && opts.hasQuery) {
        roundRect(ctx, n.x - 3.5, n.y - 3.5, n.w + 7, n.h + 7, 15);
        ctx.lineWidth = 2;
        ctx.strokeStyle = t.highlight;
        ctx.stroke();
      }

      // Zoomed far out, text is unreadable mush — draw the card and its
      // colour stripe only, which also keeps big trees fast to pan.
      var lod = opts.lod === undefined ? 1 : opts.lod;

      // Avatar.
      var ax = n.x + 32, ay = n.y + n.h / 2;
      ctx.beginPath();
      ctx.arc(ax, ay, 17, 0, Math.PI * 2);
      ctx.fillStyle = accent;
      ctx.fill();
      if (lod < 0.3) { ctx.restore(); return; }

      ctx.fillStyle = '#ffffff';
      ctx.font = '600 12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(window.FT.initials(p), ax, ay + 0.5);

      // Name + dates.
      var tx = n.x + 56;
      var maxW = n.w - 56 - 12;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = t.text;
      ctx.font = '600 13.5px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      var name = window.FT.fullName(p);
      ctx.fillText(ellipsize(ctx, name, maxW), tx, n.y + 32);

      if (lod < 0.55) { ctx.restore(); return; }

      var sub = window.FT.lifespan(p);
      if (p.maidenName) sub = sub ? sub + ' · née ' + p.maidenName : 'née ' + p.maidenName;
      if (sub) {
        ctx.fillStyle = t.dim;
        ctx.font = '11.5px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        ctx.fillText(ellipsize(ctx, sub, maxW), tx, n.y + 48);
      }
      if (p.occupation) {
        ctx.fillStyle = t.faint;
        ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        ctx.fillText(ellipsize(ctx, p.occupation, maxW), tx, n.y + 63);
      }

      ctx.restore();
    },

    /* ---------------------------- png export ---------------------------- */

    exportCanvas: function (state, geo, scale) {
      var b = window.FT.Layout.bounds(state);
      var pad = 48;
      var s = scale || 2;
      var w = Math.max(1, Math.ceil((b.w + pad * 2) * s));
      var h = Math.max(1, Math.ceil((b.h + pad * 2) * s));

      var off = document.createElement('canvas');
      off.width = w;
      off.height = h;
      var ctx = off.getContext('2d');
      ctx.fillStyle = this.theme.bg;
      ctx.fillRect(0, 0, w, h);
      ctx.setTransform(s, 0, 0, s, 0, 0);
      ctx.translate(pad - b.minX, pad - b.minY);
      this.paint(ctx, state, geo, { lod: 1 });
      return off;
    }
  };

  /* -------------------------------- utils -------------------------------- */

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  /** The leftmost person of the oldest generation — where reading starts. */
  function firstPerson(state) {
    var best = null;
    state.people.forEach(function (p) {
      if (!best || p.y < best.y || (p.y === best.y && p.x < best.x)) best = p;
    });
    return best || { x: 0, y: 0 };
  }

  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h);
    ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
  }

  function ellipsize(ctx, text, maxWidth) {
    if (!text) return '';
    if (ctx.measureText(text).width <= maxWidth) return text;
    var s = text;
    while (s.length > 1 && ctx.measureText(s + '…').width > maxWidth) {
      s = s.slice(0, -1);
    }
    return s + '…';
  }

  window.FT = window.FT || {};
  window.FT.Renderer = Renderer;
  window.FT.THEMES = THEMES;
  window.FT.roundRect = roundRect;
})(window);
