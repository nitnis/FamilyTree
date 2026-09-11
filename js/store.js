/* ---------------------------------------------------------------
   store.js — the family tree data model.

   A tree is people + unions. A union is a partnership (married,
   partners, divorced…) between one or two people, and it owns the
   children born into it. Modelling children on the union instead of
   on each parent keeps sibling groups and step-families honest, and
   gives the renderer a single point to hang the drop lines from.
   --------------------------------------------------------------- */
(function (window) {
  'use strict';

  var STORAGE_KEY = 'kinfolk.tree.v1';
  var FORMAT = 'kinfolk-family-tree';
  var VERSION = 1;
  var MAX_HISTORY = 60;

  var seq = 0;
  function uid(prefix) {
    seq += 1;
    return prefix + '_' + Date.now().toString(36) + '_' + seq.toString(36) +
      Math.random().toString(36).slice(2, 6);
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function emptyState() {
    return { format: FORMAT, version: VERSION, title: 'My Family Tree', people: [], unions: [] };
  }

  function makePerson(fields) {
    var p = {
      id: uid('p'),
      firstName: '',
      lastName: '',
      maidenName: '',
      gender: 'other',
      birthDate: '',
      deathDate: '',
      birthPlace: '',
      occupation: '',
      notes: '',
      deceased: false,
      x: 0,
      y: 0,
      pinned: false
    };
    return Object.assign(p, fields || {});
  }

  function makeUnion(a, b, fields) {
    var u = {
      id: uid('u'),
      a: a || null,
      b: b || null,
      type: 'married',
      date: '',
      children: []
    };
    return Object.assign(u, fields || {});
  }

  /* ------------------------------------------------------------- */

  var Store = {
    state: emptyState(),
    _undo: [],
    _redo: [],
    _listeners: [],
    _suspend: 0,
    _batching: false,
    persistPaused: false,

    /* --- subscriptions --- */

    subscribe: function (fn) {
      this._listeners.push(fn);
      return function () {
        var i = Store._listeners.indexOf(fn);
        if (i >= 0) Store._listeners.splice(i, 1);
      };
    },

    emit: function (reason) {
      if (this._suspend > 0) return;
      for (var i = 0; i < this._listeners.length; i++) {
        this._listeners[i](this.state, reason || 'change');
      }
      this.persist();
    },

    /* --- history --- */

    /** Snapshot the current state so the next mutation can be undone. */
    checkpoint: function () {
      if (this._batching) return;
      this._undo.push(clone(this.state));
      if (this._undo.length > MAX_HISTORY) this._undo.shift();
      this._redo.length = 0;
    },

    /** Run several mutations as one undo step and one repaint. */
    batch: function (fn, reason) {
      if (this._batching) return fn();
      this.checkpoint();
      this._batching = true;
      this._suspend++;
      try {
        return fn();
      } finally {
        this._batching = false;
        this._suspend--;
        this.emit(reason || 'batch');
      }
    },

    clearHistory: function () {
      this._undo.length = 0;
      this._redo.length = 0;
    },

    canUndo: function () { return this._undo.length > 0; },
    canRedo: function () { return this._redo.length > 0; },

    undo: function () {
      if (!this._undo.length) return false;
      this._redo.push(clone(this.state));
      this.state = this._undo.pop();
      this.emit('undo');
      return true;
    },

    redo: function () {
      if (!this._redo.length) return false;
      this._undo.push(clone(this.state));
      this.state = this._redo.pop();
      this.emit('redo');
      return true;
    },

    /* --- persistence --- */

    persist: function () {
      // A tree opened from a share link is only being viewed, so it must not
      // overwrite whatever this browser already has saved.
      if (this.persistPaused) return;
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
      } catch (err) {
        /* private mode, quota, or storage disabled — the tree still works,
           it just will not survive a reload. */
      }
    },

    restore: function () {
      var raw;
      try {
        raw = window.localStorage.getItem(STORAGE_KEY);
      } catch (err) { return false; }
      if (!raw) return false;
      try {
        var data = JSON.parse(raw);
        if (!data || !Array.isArray(data.people)) return false;
        this.state = this.normalize(data);
        return true;
      } catch (err) {
        return false;
      }
    },

    /** Accept anything shaped like a tree and fill in missing fields. */
    normalize: function (data) {
      var state = emptyState();
      state.title = typeof data.title === 'string' && data.title ? data.title : state.title;

      var seen = {};
      (data.people || []).forEach(function (raw) {
        if (!raw || typeof raw !== 'object') return;
        var p = makePerson(raw);
        if (!raw.id) p.id = uid('p');
        if (seen[p.id]) return;
        seen[p.id] = true;
        p.x = Number(p.x) || 0;
        p.y = Number(p.y) || 0;
        p.pinned = !!p.pinned;
        p.deceased = !!p.deceased || !!p.deathDate;
        if (['male', 'female', 'other'].indexOf(p.gender) < 0) p.gender = 'other';
        state.people.push(p);
      });

      (data.unions || []).forEach(function (raw) {
        if (!raw || typeof raw !== 'object') return;
        var u = makeUnion(raw.a || null, raw.b || null, raw);
        if (!raw.id) u.id = uid('u');
        u.children = (Array.isArray(raw.children) ? raw.children : []).filter(function (id) {
          return seen[id];
        });
        if (u.a && !seen[u.a]) u.a = null;
        if (u.b && !seen[u.b]) u.b = null;
        if (!u.a && u.b) { u.a = u.b; u.b = null; }
        if (!u.a && !u.children.length) return;
        state.unions.push(u);
      });

      return state;
    },

    load: function (data) {
      this.checkpoint();
      this.state = this.normalize(data);
      this.emit('load');
    },

    reset: function () {
      this.checkpoint();
      this.state = emptyState();
      this.emit('reset');
    },

    /* --- lookups --- */

    person: function (id) {
      var list = this.state.people;
      for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
      return null;
    },

    union: function (id) {
      var list = this.state.unions;
      for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
      return null;
    },

    /** Unions where the person is a partner (not a child). */
    unionsOf: function (id) {
      return this.state.unions.filter(function (u) { return u.a === id || u.b === id; });
    },

    /** The union the person was born into, if any. */
    parentUnionOf: function (id) {
      var list = this.state.unions;
      for (var i = 0; i < list.length; i++) {
        if (list[i].children.indexOf(id) >= 0) return list[i];
      }
      return null;
    },

    parentsOf: function (id) {
      var u = this.parentUnionOf(id);
      if (!u) return [];
      return [u.a, u.b].filter(Boolean).map(this.person, this).filter(Boolean);
    },

    partnersOf: function (id) {
      var out = [];
      this.unionsOf(id).forEach(function (u) {
        var otherId = u.a === id ? u.b : u.a;
        var other = otherId ? Store.person(otherId) : null;
        if (other) out.push({ person: other, union: u });
      });
      return out;
    },

    childrenOf: function (id) {
      var out = [];
      var seen = {};
      this.unionsOf(id).forEach(function (u) {
        u.children.forEach(function (cid) {
          if (seen[cid]) return;
          seen[cid] = true;
          var c = Store.person(cid);
          if (c) out.push(c);
        });
      });
      return out.sort(byBirth);
    },

    siblingsOf: function (id) {
      var u = this.parentUnionOf(id);
      if (!u) return [];
      return u.children
        .filter(function (cid) { return cid !== id; })
        .map(this.person, this)
        .filter(Boolean)
        .sort(byBirth);
    },

    /* --- mutations (each one checkpoints first) --- */

    addPerson: function (fields) {
      this.checkpoint();
      var p = makePerson(fields);
      this.state.people.push(p);
      this.emit('add-person');
      return p;
    },

    updatePerson: function (id, fields) {
      var p = this.person(id);
      if (!p) return null;
      this.checkpoint();
      Object.keys(fields).forEach(function (k) { p[k] = fields[k]; });
      if (p.deathDate) p.deceased = true;
      this.emit('update-person');
      return p;
    },

    /** Position updates are continuous while dragging, so they skip history
        unless the caller asks for a checkpoint at the start of the gesture. */
    movePerson: function (id, x, y) {
      var p = this.person(id);
      if (!p) return;
      p.x = x;
      p.y = y;
      p.pinned = true;
      this.emit('move');
    },

    removePerson: function (id) {
      this.checkpoint();
      this.state.people = this.state.people.filter(function (p) { return p.id !== id; });
      this.state.unions.forEach(function (u) {
        if (u.a === id) u.a = null;
        if (u.b === id) u.b = null;
        if (!u.a && u.b) { u.a = u.b; u.b = null; }
        u.children = u.children.filter(function (cid) { return cid !== id; });
      });
      // Drop unions that no longer connect anyone.
      this.state.unions = this.state.unions.filter(function (u) {
        return u.a && (u.b || u.children.length);
      });
      this.emit('remove-person');
    },

    /** Link two people as partners, reusing an existing union if there is one. */
    addPartner: function (aId, bId, fields) {
      var existing = this.unionsOf(aId).filter(function (u) {
        return u.a === bId || u.b === bId;
      })[0];
      if (existing) return existing;

      this.checkpoint();
      // A solo parent union with a free slot becomes the couple's union.
      var solo = this.unionsOf(aId).filter(function (u) { return !u.a || !u.b; })[0];
      if (solo) {
        if (!solo.a) solo.a = bId; else solo.b = bId;
        Object.assign(solo, fields || {});
        this.emit('add-partner');
        return solo;
      }
      var u = makeUnion(aId, bId, fields);
      this.state.unions.push(u);
      this.emit('add-partner');
      return u;
    },

    /** Attach an existing person as a child of a union (or of a lone parent). */
    addChildToUnion: function (unionId, childId) {
      var u = this.union(unionId);
      if (!u || u.children.indexOf(childId) >= 0) return u;
      if (u.a === childId || u.b === childId) return u;
      this.checkpoint();
      // A child belongs to exactly one parent union.
      var prev = this.parentUnionOf(childId);
      if (prev) prev.children = prev.children.filter(function (c) { return c !== childId; });
      u.children.push(childId);
      this.emit('add-child');
      return u;
    },

    /** The union a person's children should hang from — created if needed. */
    ensureUnionFor: function (personId, preferredPartnerId) {
      var unions = this.unionsOf(personId);
      if (preferredPartnerId) {
        var match = unions.filter(function (u) {
          return u.a === preferredPartnerId || u.b === preferredPartnerId;
        })[0];
        if (match) return match;
      }
      if (unions.length) return unions[0];
      this.checkpoint();
      var u = makeUnion(personId, null);
      this.state.unions.push(u);
      this.emit('add-union');
      return u;
    },

    /** Make `parentId` a parent of `childId`, joining an existing parent union. */
    addParent: function (childId, parentId) {
      var pu = this.parentUnionOf(childId);
      this.checkpoint();
      if (pu) {
        if (!pu.a) pu.a = parentId;
        else if (!pu.b && pu.a !== parentId) pu.b = parentId;
        else if (pu.a !== parentId && pu.b !== parentId) {
          // Already two parents: nothing sensible to do without replacing one.
          this._undo.pop();
          return null;
        }
        this.emit('add-parent');
        return pu;
      }
      var u = makeUnion(parentId, null);
      u.children.push(childId);
      this.state.unions.push(u);
      this.emit('add-parent');
      return u;
    },

    updateUnion: function (unionId, fields) {
      var u = this.union(unionId);
      if (!u) return null;
      this.checkpoint();
      Object.keys(fields).forEach(function (k) { u[k] = fields[k]; });
      this.emit('update-union');
      return u;
    },

    removeUnion: function (unionId) {
      this.checkpoint();
      this.state.unions = this.state.unions.filter(function (u) { return u.id !== unionId; });
      this.emit('remove-union');
    },

    /** Split a partnership but keep both people and their children. */
    unlinkPartners: function (unionId) {
      var u = this.union(unionId);
      if (!u) return;
      this.checkpoint();
      if (u.children.length) {
        u.b = null;               // children stay with the first-listed parent
      } else {
        this.state.unions = this.state.unions.filter(function (x) { return x.id !== unionId; });
      }
      this.emit('unlink-partners');
    },

    detachChild: function (childId) {
      var u = this.parentUnionOf(childId);
      if (!u) return;
      this.checkpoint();
      u.children = u.children.filter(function (c) { return c !== childId; });
      if (!u.b && !u.children.length) {
        this.state.unions = this.state.unions.filter(function (x) { return x.id !== u.id; });
      }
      this.emit('detach-child');
    },

    setTitle: function (title) {
      this.state.title = title;
      this.emit('title');
    },

    /* --- helpers --- */

    /** True when making `ancestorId` an ancestor of `personId` would loop. */
    wouldCycle: function (personId, ancestorId) {
      if (personId === ancestorId) return true;
      var stack = [personId];
      var seen = {};
      while (stack.length) {
        var cur = stack.pop();
        if (seen[cur]) continue;
        seen[cur] = true;
        var u = this.parentUnionOf(cur);
        if (!u) continue;
        [u.a, u.b].forEach(function (pid) {
          if (!pid) return;
          if (pid === ancestorId) seen.__hit = true;
          stack.push(pid);
        });
      }
      return !!seen.__hit;
    }
  };

  function byBirth(a, b) {
    if (a.birthDate && b.birthDate) return a.birthDate < b.birthDate ? -1 : (a.birthDate > b.birthDate ? 1 : 0);
    if (a.birthDate) return -1;
    if (b.birthDate) return 1;
    return 0;
  }

  /* --- display helpers shared by the canvas and the DOM --- */

  function fullName(p) {
    if (!p) return '';
    var name = [p.firstName, p.lastName].filter(Boolean).join(' ').trim();
    return name || 'Unnamed';
  }

  function initials(p) {
    if (!p) return '?';
    var a = (p.firstName || '').trim().charAt(0);
    var b = (p.lastName || '').trim().charAt(0);
    var s = (a + b).toUpperCase();
    return s || '?';
  }

  function year(date) {
    if (!date) return '';
    var m = String(date).match(/\d{4}/);
    return m ? m[0] : String(date);
  }

  function lifespan(p) {
    if (!p) return '';
    var b = year(p.birthDate);
    var d = year(p.deathDate);
    if (b && d) return b + ' – ' + d;
    if (b) return p.deceased ? b + ' – ?' : 'b. ' + b;
    if (d) return 'd. ' + d;
    return p.deceased ? 'deceased' : '';
  }

  window.FT = window.FT || {};
  window.FT.Store = Store;
  window.FT.uid = uid;
  window.FT.clone = clone;
  window.FT.makePerson = makePerson;
  window.FT.makeUnion = makeUnion;
  window.FT.emptyState = emptyState;
  window.FT.fullName = fullName;
  window.FT.initials = initials;
  window.FT.lifespan = lifespan;
  window.FT.year = year;
  window.FT.STORAGE_KEY = STORAGE_KEY;
  window.FT.FORMAT = FORMAT;
})(window);
