/* ---------------------------------------------------------------
   app.js — UI wiring: canvas interaction, sidebar, inspector,
   context menu, modals, import/export and keyboard shortcuts.
   --------------------------------------------------------------- */
(function (window, document) {
  'use strict';

  var FT = window.FT;
  var Store = FT.Store;
  var Drive = FT.Drive;
  var Share = FT.Share;
  var Layout = FT.Layout;
  var R = FT.Renderer;
  var M = Layout.METRICS;

  var el = {};
  var ui = {
    selectedId: null,
    hoverId: null,
    query: '',
    theme: 'light',
    spaceDown: false,
    shared: false,       // viewing a tree that arrived in the URL
    viewer: false        // full screen, read only
  };
  var geo = { nodes: {}, links: [], bounds: null };
  var frame = null;
  var missingElements = [];

  /* =========================== bootstrap =========================== */

  /** Bind a handler only if the element is actually on the page. */
  function on(name, event, handler) {
    if (el[name]) el[name].addEventListener(event, handler);
  }

  function init() {
    [
      'treeTitle', 'btnAddPerson', 'btnArrange', 'btnFit', 'btnUndo', 'btnRedo',
      'btnSample', 'btnImport', 'btnExport', 'btnPng', 'btnClear', 'btnTheme',
      'btnDrive', 'driveLabel', 'btnShare',
      'btnViewer', 'btnExitViewer', 'viewerTitle', 'viewerTitleName', 'viewerTitleMeta',
      'fileInput', 'sidebar', 'search', 'peopleList', 'peopleCount', 'canvasWrap',
      'tree', 'emptyState', 'btnZoomIn', 'btnZoomOut', 'btnZoomReset', 'inspector',
      'inspectorTitle', 'inspectorBody', 'btnCloseInspector', 'contextMenu', 'modal', 'modalTitle',
      'modalBody', 'modalFoot', 'modalClose', 'toast'
    ].forEach(function (id) {
      el[id] = document.getElementById(id);
      if (!el[id]) missingElements.push(id);
    });

    ui.theme = readStoredTheme();
    applyTheme(ui.theme);

    R.attach(el.tree);
    R.setTheme(ui.theme);

    var restored = Store.restore();
    if (!restored) {
      Store.state = FT.emptyState();
    }

    Drive.restore();
    Drive.onChange(renderDriveButton);
    renderDriveButton();

    Store.subscribe(onStoreChange);
    bindToolbar();
    bindCanvas();
    bindKeyboard();
    bindWindow();

    el.treeTitle.value = Store.state.title;
    refreshAll();
    if (Store.state.people.length) R.fit(Store.state);
    schedule();

    var shared = Share.fromLocation();
    if (shared) openSharedPayload(shared);
    else if (Share.hasLink()) clearShareHash();   // an empty #tree= is just noise

    // A page whose HTML and scripts came from different versions — a stale
    // cache, usually — used to die on the first missing element. Now it runs
    // and says what happened.
    if (missingElements.length) reportStalePage('Missing: ' + missingElements.join(', '));
  }

  /** Say plainly that the page is out of date rather than half-working. */
  function reportStalePage(detail) {
    if (window.console && window.console.warn) {
      window.console.warn('Kinfolk: this page looks out of date. ' + detail);
    }
    if (document.getElementById('staleWarning')) return;
    var bar = document.createElement('div');
    bar.id = 'staleWarning';
    bar.setAttribute('role', 'alert');
    // The body is a flex column, so as its first child the bar pushes the
    // app down instead of covering the toolbar.
    bar.style.cssText = 'flex:0 0 auto;padding:10px 14px;' +
      'font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
      'color:#7a2012;background:#fee4e2;border-bottom:1px solid #b42318;text-align:center;';
    bar.textContent = 'This page did not load completely — part of it is out of date. ' +
      'Reload with Ctrl+Shift+R (\u2318\u21E7R on a Mac).';
    var host = document.body || document.documentElement;
    host.insertBefore(bar, host.firstChild);
  }

  function onStoreChange(state, reason) {
    if (reason !== 'move') refreshAll();
    else refreshChrome();
    schedule();
    // Undo/redo and loads are edits too — anything that changes the tree is
    // queued, and Drive.schedule() debounces the burst into one upload.
    // A shared tree is only being viewed: it must not reach this browser's
    // storage or the linked Drive file until it is explicitly kept.
    if (ui.shared) return;
    if (Drive.isLinked() && reason !== 'drive-load') queueDriveSave();
  }

  function queueDriveSave() {
    Drive.schedule(function () { return JSON.stringify(Store.state, null, 2); });
  }

  function refreshAll() {
    if (el.treeTitle.value !== Store.state.title && document.activeElement !== el.treeTitle) {
      el.treeTitle.value = Store.state.title;
    }
    if (ui.selectedId && !Store.person(ui.selectedId)) ui.selectedId = null;
    renderPeopleList();
    renderInspector();
    refreshChrome();
  }

  function refreshChrome() {
    el.btnUndo.disabled = !Store.canUndo();
    el.btnRedo.disabled = !Store.canRedo();
    el.peopleCount.textContent = String(Store.state.people.length);
    el.emptyState.hidden = Store.state.people.length > 0;
    el.btnZoomReset.textContent = Math.round(R.view.k * 100) + '%';
    renderViewerTitle();
  }

  /* ============================ rendering =========================== */

  /** The canvas box changes when panels appear or the mode switches. */
  function onResize() {
    R.resize();
    schedule();
  }

  function schedule() {
    if (frame) return;
    frame = window.requestAnimationFrame(function () {
      frame = null;
      paint();
    });
  }

  function paint() {
    geo = Layout.geometry(Store.state);
    var q = ui.query.trim().toLowerCase();
    var matchIds = null;
    if (q) {
      matchIds = {};
      Store.state.people.forEach(function (p) {
        if (searchText(p).indexOf(q) >= 0) matchIds[p.id] = true;
      });
    }
    R.draw(Store.state, geo, {
      selectedId: ui.selectedId,
      hoverId: ui.hoverId,
      matchIds: matchIds,
      hasQuery: !!q,
      relatedUnions: relatedUnions(ui.selectedId)
    });
    el.btnZoomReset.textContent = Math.round(R.view.k * 100) + '%';
  }

  /** Unions touching the selected person, so their lines can be emphasised. */
  function relatedUnions(id) {
    if (!id) return null;
    var map = {};
    Store.unionsOf(id).forEach(function (u) { map[u.id] = true; });
    var pu = Store.parentUnionOf(id);
    if (pu) map[pu.id] = true;
    return map;
  }

  function searchText(p) {
    return [p.firstName, p.lastName, p.maidenName, p.occupation, p.birthPlace, p.notes]
      .filter(Boolean).join(' ').toLowerCase();
  }

  /* ============================ sidebar ============================= */

  function renderPeopleList() {
    var q = ui.query.trim().toLowerCase();
    var people = Store.state.people.slice().sort(function (a, b) {
      return FT.fullName(a).localeCompare(FT.fullName(b));
    });
    if (q) people = people.filter(function (p) { return searchText(p).indexOf(q) >= 0; });

    el.peopleList.textContent = '';
    if (!people.length) {
      var li = document.createElement('li');
      li.className = 'list-empty';
      li.textContent = Store.state.people.length ? 'No one matches that search.' : 'No people yet.';
      el.peopleList.appendChild(li);
      return;
    }

    people.forEach(function (p) {
      el.peopleList.appendChild(personRow(p, function () {
        select(p.id);
        R.centerOn(p);
        schedule();
      }));
    });
  }

  function personRow(p, onClick) {
    var li = document.createElement('li');
    li.className = 'person-row' + (p.id === ui.selectedId ? ' is-selected' : '');
    li.setAttribute('role', 'option');
    li.tabIndex = 0;

    var av = document.createElement('span');
    av.className = 'avatar';
    av.style.background = genderColor(p);
    av.textContent = FT.initials(p);

    var meta = document.createElement('span');
    meta.className = 'meta';
    var nm = document.createElement('div');
    nm.className = 'nm';
    nm.textContent = FT.fullName(p);
    var dt = document.createElement('div');
    dt.className = 'dt';
    dt.textContent = FT.lifespan(p) || '—';
    meta.appendChild(nm);
    meta.appendChild(dt);

    li.appendChild(av);
    li.appendChild(meta);
    li.addEventListener('click', onClick);
    li.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); }
    });
    return li;
  }

  function genderColor(p) {
    var t = FT.THEMES[ui.theme];
    if (p.deceased) return t.dead;
    return t[p.gender] || t.other;
  }

  /* =========================== inspector ============================ */

  function renderInspector() {
    var p = ui.selectedId ? Store.person(ui.selectedId) : null;
    el.inspectorBody.textContent = '';

    if (!p) {
      el.inspectorTitle.textContent = 'Details';
      var note = document.createElement('p');
      note.className = 'empty-note';
      note.textContent = ui.viewer
        ? 'Select a person on the canvas to see their details.'
        : 'Select a person on the canvas to see and edit their details.';
      el.inspectorBody.appendChild(note);
      el.inspector.classList.remove('is-open');
      return;
    }

    el.inspectorTitle.textContent = 'Details';

    var head = document.createElement('div');
    head.className = 'insp-header';
    var av = document.createElement('div');
    av.className = 'avatar-lg';
    av.style.background = genderColor(p);
    av.textContent = FT.initials(p);
    var box = document.createElement('div');
    var nm = document.createElement('div');
    nm.className = 'nm';
    nm.textContent = FT.fullName(p);
    var dt = document.createElement('div');
    dt.className = 'dt';
    dt.textContent = FT.lifespan(p) || 'No dates yet';
    box.appendChild(nm); box.appendChild(dt);
    head.appendChild(av); head.appendChild(box);
    el.inspectorBody.appendChild(head);

    if (ui.viewer) {
      var ro = document.createElement('p');
      ro.className = 'read-only-note';
      ro.textContent = 'View only. Leave full screen to make changes.';
      el.inspectorBody.appendChild(ro);
    } else {
      var editBtn = button('Edit details', 'btn', function () { openPersonForm(p.id); });
      editBtn.style.width = '100%';
      el.inspectorBody.appendChild(editBtn);
    }

    // Quick facts
    var facts = [
      ['Born', p.birthDate || '—'],
      ['Died', p.deathDate || (p.deceased ? 'unknown' : '—')],
      ['Birthplace', p.birthPlace || '—'],
      ['Occupation', p.occupation || '—']
    ].filter(function (f) { return f[1] !== '—'; });

    if (facts.length) {
      el.inspectorBody.appendChild(sectionTitle('Facts'));
      facts.forEach(function (f) {
        var row = document.createElement('div');
        row.className = 'rel-item';
        var k = document.createElement('span');
        k.className = 'tag';
        k.style.minWidth = '76px';
        k.textContent = f[0];
        var v = document.createElement('span');
        v.className = 'nm';
        v.style.cursor = 'default';
        v.textContent = f[1];
        row.appendChild(k); row.appendChild(v);
        el.inspectorBody.appendChild(row);
      });
    }

    if (p.notes) {
      el.inspectorBody.appendChild(sectionTitle('Notes'));
      var np = document.createElement('p');
      np.style.cssText = 'margin:0;font-size:12.5px;color:var(--text-dim);white-space:pre-wrap;';
      np.textContent = p.notes;
      el.inspectorBody.appendChild(np);
    }

    // Relationships
    var editable = !ui.viewer;

    el.inspectorBody.appendChild(sectionTitle('Parents'));
    relList(Store.parentsOf(p.id), null, editable ? function (parent) {
      Store.detachChild(p.id);
      toast('Detached from parents');
    } : null);

    if (editable) {
      el.inspectorBody.appendChild(actionRow([
        ['Add parent', function () { addParent(p.id); }],
        ['Link existing…', function () { linkParent(p.id); }]
      ]));
    }

    el.inspectorBody.appendChild(sectionTitle('Partners'));
    var partners = Store.partnersOf(p.id);
    relList(partners.map(function (x) { return x.person; }), function (i) {
      return editable ? unionTypeSelect(partners[i].union) : unionLabel(partners[i].union);
    }, editable ? function (other, i) {
      Store.unlinkPartners(partners[i].union.id);
      toast('Partnership removed');
    } : null);

    if (editable) {
      el.inspectorBody.appendChild(actionRow([
        ['Add partner', function () { addPartner(p.id); }],
        ['Link existing…', function () { linkPartner(p.id); }]
      ]));
    }

    el.inspectorBody.appendChild(sectionTitle('Children'));
    var kids = Store.childrenOf(p.id);
    relList(kids, null, editable ? function (child) {
      Store.detachChild(child.id);
      toast('Child detached');
    } : null);

    if (editable) {
      el.inspectorBody.appendChild(actionRow([
        ['Add child', function () { addChild(p.id); }],
        ['Link existing…', function () { linkChild(p.id); }]
      ]));
    }

    var sibs = Store.siblingsOf(p.id);
    if (sibs.length) {
      el.inspectorBody.appendChild(sectionTitle('Siblings'));
      relList(sibs, null, null);
    }

    if (editable) {
      var danger = document.createElement('div');
      danger.className = 'danger-zone';
      var del = button('Delete person', 'btn btn-danger', function () { confirmDelete(p.id); });
      del.style.width = '100%';
      danger.appendChild(del);
      el.inspectorBody.appendChild(danger);
    }
  }

  function relList(people, tagFn, onUnlink) {
    if (!people.length) {
      var e = document.createElement('div');
      e.className = 'rel-empty';
      e.textContent = 'None recorded.';
      el.inspectorBody.appendChild(e);
      return;
    }
    var ul = document.createElement('ul');
    ul.className = 'rel-list';
    people.forEach(function (p, i) {
      var li = document.createElement('li');
      li.className = 'rel-item';

      var av = document.createElement('span');
      av.className = 'avatar';
      av.style.background = genderColor(p);
      av.textContent = FT.initials(p);

      var nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = FT.fullName(p);
      nm.title = 'Go to ' + FT.fullName(p);
      nm.addEventListener('click', function () {
        select(p.id);
        R.centerOn(p);
        schedule();
      });

      li.appendChild(av);
      li.appendChild(nm);

      if (tagFn) {
        var tag = tagFn(i);
        if (typeof tag === 'string') {
          var span = document.createElement('span');
          span.className = 'tag';
          span.textContent = tag;
          tag = span;
        }
        if (tag) li.appendChild(tag);
      }
      if (onUnlink) {
        var x = document.createElement('button');
        x.className = 'unlink';
        x.title = 'Remove this link';
        x.setAttribute('aria-label', 'Remove link to ' + FT.fullName(p));
        x.textContent = '✕';
        x.addEventListener('click', function () { onUnlink(p, i); });
        li.appendChild(x);
      }
      ul.appendChild(li);
    });
    el.inspectorBody.appendChild(ul);
  }

  function unionLabel(u) {
    return { married: 'married', divorced: 'divorced', partners: 'partners',
             engaged: 'engaged' }[u.type] || '';
  }

  /** The relationship kind doubles as its own editor — it changes how the
      partner bar is drawn (solid, dashed, or struck through for a divorce). */
  function unionTypeSelect(u) {
    var sel = document.createElement('select');
    sel.className = 'tag';
    sel.title = 'Relationship type';
    [['married', 'married'], ['engaged', 'engaged'], ['partners', 'partners'], ['divorced', 'divorced']]
      .forEach(function (opt) {
        var o = document.createElement('option');
        o.value = opt[0];
        o.textContent = opt[1];
        if (u.type === opt[0]) o.selected = true;
        sel.appendChild(o);
      });
    sel.addEventListener('change', function () {
      Store.updateUnion(u.id, { type: sel.value });
    });
    return sel;
  }

  function sectionTitle(text) {
    var h = document.createElement('div');
    h.className = 'section-title';
    h.textContent = text;
    return h;
  }

  function actionRow(pairs) {
    var row = document.createElement('div');
    row.className = 'rel-actions';
    pairs.forEach(function (pair) {
      row.appendChild(button(pair[0], 'btn', pair[1]));
    });
    return row;
  }

  function button(label, cls, onClick) {
    var b = document.createElement('button');
    b.className = cls || 'btn';
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  /* ======================= relationship actions ===================== */

  function addParent(childId) {
    var parents = Store.parentsOf(childId);
    if (parents.length >= 2) {
      toast('This person already has two parents');
      return;
    }
    openPersonForm(null, { title: 'Add parent', onCreate: function (fields) {
      Store.batch(function () {
        var p = Store.addPerson(fields);
        Store.addParent(childId, p.id);
        arrangeIfUnpinned();
        select(p.id);
      }, 'add-parent');
    } });
  }

  function linkParent(childId) {
    var parents = Store.parentsOf(childId);
    if (parents.length >= 2) { toast('This person already has two parents'); return; }
    openPicker('Link an existing parent', function (p) {
      return p.id !== childId &&
        parents.every(function (x) { return x.id !== p.id; }) &&
        !isDescendant(p.id, childId);
    }, function (p) {
      Store.batch(function () {
        Store.addParent(childId, p.id);
        arrangeIfUnpinned();
      }, 'link-parent');
      toast(FT.fullName(p) + ' linked as parent');
    });
  }

  function addPartner(personId) {
    openPersonForm(null, { title: 'Add partner', onCreate: function (fields) {
      Store.batch(function () {
        var p = Store.addPerson(fields);
        Store.addPartner(personId, p.id);
        arrangeIfUnpinned();
        select(p.id);
      }, 'add-partner');
    } });
  }

  function linkPartner(personId) {
    var existing = Store.partnersOf(personId).map(function (x) { return x.person.id; });
    openPicker('Link an existing partner', function (p) {
      return p.id !== personId && existing.indexOf(p.id) < 0;
    }, function (p) {
      Store.batch(function () {
        Store.addPartner(personId, p.id);
        arrangeIfUnpinned();
      }, 'link-partner');
      toast(FT.fullName(p) + ' linked as partner');
    });
  }

  function addChild(personId) {
    withUnion(personId, function (union) {
      openPersonForm(null, { title: 'Add child', onCreate: function (fields) {
        Store.batch(function () {
          var p = Store.addPerson(fields);
          Store.addChildToUnion(union.id, p.id);
          arrangeIfUnpinned();
          select(p.id);
        }, 'add-child');
      } });
    });
  }

  function linkChild(personId) {
    withUnion(personId, function (union) {
      openPicker('Link an existing child', function (p) {
        return p.id !== personId && union.children.indexOf(p.id) < 0 &&
          p.id !== union.a && p.id !== union.b && !isDescendant(p.id, personId);
      }, function (p) {
        Store.batch(function () {
          Store.addChildToUnion(union.id, p.id);
          arrangeIfUnpinned();
        }, 'link-child');
        toast(FT.fullName(p) + ' linked as child');
      });
    });
  }

  function addSibling(personId) {
    var pu = Store.parentUnionOf(personId);
    openPersonForm(null, { title: 'Add sibling', onCreate: function (fields) {
      Store.batch(function () {
        var p = Store.addPerson(fields);
        var union = pu;
        if (!union) {
          // No parents recorded yet: invent the shared parent union so the
          // two really are siblings rather than two unconnected roots.
          union = Store.ensureUnionFor(Store.addPerson({ firstName: 'Unknown', gender: 'other' }).id);
          Store.addChildToUnion(union.id, personId);
        }
        Store.addChildToUnion(union.id, p.id);
        arrangeIfUnpinned();
        select(p.id);
      }, 'add-sibling');
    } });
  }

  /** Pick which partnership new children belong to when there is more than one. */
  function withUnion(personId, done) {
    var unions = Store.unionsOf(personId);
    if (unions.length <= 1) {
      done(Store.ensureUnionFor(personId));
      return;
    }
    var body = document.createElement('div');
    var note = document.createElement('p');
    note.className = 'modal-note';
    note.textContent = 'Which partnership does this child belong to?';
    body.appendChild(note);

    var ul = document.createElement('ul');
    ul.className = 'picker-list';
    unions.forEach(function (u) {
      var otherId = u.a === personId ? u.b : u.a;
      var other = otherId ? Store.person(otherId) : null;
      var li = document.createElement('li');
      li.className = 'person-row';
      var av = document.createElement('span');
      av.className = 'avatar';
      av.style.background = other ? genderColor(other) : 'var(--text-faint)';
      av.textContent = other ? FT.initials(other) : '—';
      var meta = document.createElement('span');
      meta.className = 'meta';
      var nm = document.createElement('div');
      nm.className = 'nm';
      nm.textContent = other ? 'With ' + FT.fullName(other) : 'No partner recorded';
      var dt = document.createElement('div');
      dt.className = 'dt';
      dt.textContent = u.children.length + ' child' + (u.children.length === 1 ? '' : 'ren');
      meta.appendChild(nm); meta.appendChild(dt);
      li.appendChild(av); li.appendChild(meta);
      li.addEventListener('click', function () { closeModal(); done(u); });
      ul.appendChild(li);
    });
    body.appendChild(ul);
    openModal('Choose a partnership', body, [button('Cancel', 'btn', closeModal)]);
  }

  /** Guard against loops: is `maybeDescendant` below `personId` in the tree? */
  function isDescendant(maybeDescendant, personId) {
    var stack = [personId];
    var seen = {};
    while (stack.length) {
      var cur = stack.pop();
      if (seen[cur]) continue;
      seen[cur] = true;
      if (cur === maybeDescendant && cur !== personId) return true;
      Store.unionsOf(cur).forEach(function (u) {
        u.children.forEach(function (c) {
          if (c === maybeDescendant) seen.__hit = true;
          stack.push(c);
        });
      });
    }
    return !!seen.__hit;
  }

  function confirmDelete(id) {
    var p = Store.person(id);
    if (!p) return;
    var body = document.createElement('div');
    var msg = document.createElement('p');
    msg.className = 'modal-note';
    msg.innerHTML = 'Delete <b></b>? Their relationships will be removed too. This can be undone with Ctrl+Z.';
    msg.querySelector('b').textContent = FT.fullName(p);
    body.appendChild(msg);
    openModal('Delete person', body, [
      button('Cancel', 'btn', closeModal),
      button('Delete', 'btn btn-danger', function () {
        closeModal();
        Store.removePerson(id);
        if (ui.selectedId === id) ui.selectedId = null;
        toast('Deleted ' + FT.fullName(p));
      })
    ]);
  }

  /* ========================== person form =========================== */

  function openPersonForm(personId, opts) {
    opts = opts || {};
    var existing = personId ? Store.person(personId) : null;
    var draft = existing
      ? FT.clone(existing)
      : FT.makePerson(opts.defaults || {});

    var body = document.createElement('div');
    var gender = draft.gender;

    function field(label, node) {
      var wrap = document.createElement('div');
      wrap.className = 'field';
      var l = document.createElement('label');
      l.textContent = label;
      wrap.appendChild(l);
      wrap.appendChild(node);
      return wrap;
    }
    function input(key, placeholder, type) {
      var i = document.createElement('input');
      i.type = type || 'text';
      i.value = draft[key] || '';
      if (placeholder) i.placeholder = placeholder;
      i.addEventListener('input', function () { draft[key] = i.value; });
      return i;
    }

    var row1 = document.createElement('div');
    row1.className = 'field-row';
    var firstInput = input('firstName', 'Jane');
    row1.appendChild(field('First name', firstInput));
    row1.appendChild(field('Last name', input('lastName', 'Doe')));
    body.appendChild(row1);

    body.appendChild(field('Maiden name (optional)', input('maidenName', 'Smith')));

    // Gender: a segmented control, since it only tints the card.
    var seg = document.createElement('div');
    seg.className = 'seg';
    [['female', 'Female'], ['male', 'Male'], ['other', 'Other']].forEach(function (opt) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = opt[1];
      b.setAttribute('aria-pressed', String(gender === opt[0]));
      b.addEventListener('click', function () {
        gender = opt[0];
        draft.gender = opt[0];
        Array.prototype.forEach.call(seg.children, function (c) {
          c.setAttribute('aria-pressed', String(c === b));
        });
      });
      seg.appendChild(b);
    });
    body.appendChild(field('Gender', seg));

    var row2 = document.createElement('div');
    row2.className = 'field-row';
    // Free text rather than <input type=date>: genealogy dates are often
    // just a year, or "abt 1890".
    row2.appendChild(field('Born', input('birthDate', 'YYYY-MM-DD or 1890')));
    row2.appendChild(field('Died', input('deathDate', 'blank if living')));
    body.appendChild(row2);

    var deadWrap = document.createElement('label');
    deadWrap.style.cssText = 'display:flex;gap:8px;align-items:center;font-size:13px;margin:2px 0 12px;color:var(--text-dim);cursor:pointer;';
    var dead = document.createElement('input');
    dead.type = 'checkbox';
    dead.checked = !!draft.deceased;
    dead.style.width = 'auto';
    dead.addEventListener('change', function () { draft.deceased = dead.checked; });
    deadWrap.appendChild(dead);
    deadWrap.appendChild(document.createTextNode('Deceased (date unknown)'));
    body.appendChild(deadWrap);

    var row3 = document.createElement('div');
    row3.className = 'field-row';
    row3.appendChild(field('Birthplace', input('birthPlace', 'City, Country')));
    row3.appendChild(field('Occupation', input('occupation', 'Teacher')));
    body.appendChild(row3);

    var notes = document.createElement('textarea');
    notes.value = draft.notes || '';
    notes.placeholder = 'Anything worth remembering…';
    notes.addEventListener('input', function () { draft.notes = notes.value; });
    body.appendChild(field('Notes', notes));

    function save() {
      draft.firstName = draft.firstName.trim();
      draft.lastName = draft.lastName.trim();
      if (draft.deathDate) draft.deceased = true;
      closeModal();
      if (existing) {
        Store.updatePerson(personId, {
          firstName: draft.firstName, lastName: draft.lastName, maidenName: draft.maidenName,
          gender: draft.gender, birthDate: draft.birthDate, deathDate: draft.deathDate,
          birthPlace: draft.birthPlace, occupation: draft.occupation,
          notes: draft.notes, deceased: draft.deceased
        });
      } else if (opts.onCreate) {
        opts.onCreate(draft);
      } else {
        var p = Store.addPerson(draft);
        select(p.id);
      }
    }

    body.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') { e.preventDefault(); save(); }
    });

    openModal(opts.title || (existing ? 'Edit person' : 'Add person'), body, [
      button('Cancel', 'btn', closeModal),
      button(existing ? 'Save' : 'Add', 'btn btn-primary', save)
    ]);

    window.setTimeout(function () { firstInput.focus(); firstInput.select(); }, 30);
  }

  /* ============================= picker ============================= */

  function openPicker(title, filter, onPick) {
    var candidates = Store.state.people.filter(filter);
    var body = document.createElement('div');

    if (!candidates.length) {
      var note = document.createElement('p');
      note.className = 'modal-note';
      note.textContent = 'No one in this tree can be linked here yet.';
      body.appendChild(note);
      openModal(title, body, [button('Close', 'btn', closeModal)]);
      return;
    }

    var search = document.createElement('input');
    search.type = 'search';
    search.placeholder = 'Search…';
    body.appendChild(search);

    var ul = document.createElement('ul');
    ul.className = 'picker-list';
    body.appendChild(ul);

    function fill() {
      var q = search.value.trim().toLowerCase();
      ul.textContent = '';
      candidates
        .filter(function (p) { return !q || searchText(p).indexOf(q) >= 0; })
        .sort(function (a, b) { return FT.fullName(a).localeCompare(FT.fullName(b)); })
        .forEach(function (p) {
          ul.appendChild(personRow(p, function () { closeModal(); onPick(p); }));
        });
    }
    search.addEventListener('input', fill);
    fill();

    openModal(title, body, [button('Cancel', 'btn', closeModal)]);
    window.setTimeout(function () { search.focus(); }, 30);
  }

  /* ============================= modal ============================== */

  function openModal(title, bodyNode, footNodes) {
    el.modalTitle.textContent = title;
    el.modalBody.textContent = '';
    el.modalBody.appendChild(bodyNode);
    el.modalFoot.textContent = '';
    (footNodes || []).forEach(function (n) { el.modalFoot.appendChild(n); });
    el.modal.hidden = false;
  }

  function closeModal() {
    el.modal.hidden = true;
    el.modalBody.textContent = '';
    el.modalFoot.textContent = '';
  }

  /* =========================== context menu ========================= */

  function showMenu(clientX, clientY, items) {
    el.contextMenu.textContent = '';
    items.forEach(function (item) {
      if (item === '-') {
        var sep = document.createElement('div');
        sep.className = 'menu-sep';
        el.contextMenu.appendChild(sep);
        return;
      }
      if (item.label) {
        var lab = document.createElement('div');
        lab.className = 'menu-label';
        lab.textContent = item.label;
        el.contextMenu.appendChild(lab);
        return;
      }
      var b = document.createElement('button');
      b.className = 'menu-item' + (item.danger ? ' danger' : '');
      b.textContent = item.text;
      if (item.key) {
        var k = document.createElement('span');
        k.className = 'k';
        k.textContent = item.key;
        b.appendChild(k);
      }
      b.addEventListener('click', function () { hideMenu(); item.run(); });
      el.contextMenu.appendChild(b);
    });

    el.contextMenu.hidden = false;
    var rect = el.contextMenu.getBoundingClientRect();
    var x = Math.min(clientX, window.innerWidth - rect.width - 8);
    var y = Math.min(clientY, window.innerHeight - rect.height - 8);
    el.contextMenu.style.left = Math.max(8, x) + 'px';
    el.contextMenu.style.top = Math.max(8, y) + 'px';
  }

  function hideMenu() { el.contextMenu.hidden = true; }

  function nodeMenu(id, clientX, clientY) {
    var p = Store.person(id);
    if (!p) return;
    showMenu(clientX, clientY, [
      { label: FT.fullName(p) },
      { text: 'Edit details…', run: function () { openPersonForm(id); } },
      '-',
      { text: 'Add parent', run: function () { addParent(id); } },
      { text: 'Add partner', run: function () { addPartner(id); } },
      { text: 'Add child', run: function () { addChild(id); } },
      { text: 'Add sibling', run: function () { addSibling(id); } },
      '-',
      { text: 'Link existing partner…', run: function () { linkPartner(id); } },
      { text: 'Link existing child…', run: function () { linkChild(id); } },
      { text: 'Link existing parent…', run: function () { linkParent(id); } },
      '-',
      { text: 'Delete person', danger: true, key: 'Del', run: function () { confirmDelete(id); } }
    ]);
  }

  function canvasMenu(world, clientX, clientY) {
    showMenu(clientX, clientY, [
      { text: 'Add person here', key: 'A', run: function () { addPersonAt(world); } },
      { text: 'Auto arrange', key: 'L', run: doArrange },
      { text: 'Fit to view', key: 'F', run: doFit }
    ]);
  }

  /* ========================= canvas interaction ===================== */

  var drag = null;      // { id, dx, dy, moved }
  var pan = null;       // { x, y }
  var pointers = {};    // active pointers, for pinch zoom
  var pinch = null;

  function bindCanvas() {
    var c = el.tree;

    c.addEventListener('pointerdown', function (e) {
      hideMenu();
      c.focus();
      pointers[e.pointerId] = { x: e.clientX, y: e.clientY };

      if (Object.keys(pointers).length === 2) {
        startPinch();
        drag = pan = null;
        return;
      }
      if (e.button === 2) return;

      c.setPointerCapture(e.pointerId);
      var pt = localPoint(e);
      var w = R.screenToWorld(pt.x, pt.y);
      var hit = (ui.spaceDown || e.button === 1) ? null : R.hitTest(geo, w.x, w.y);

      if (hit) {
        select(hit.id);
        if (!ui.viewer) {
          drag = { id: hit.id, dx: w.x - hit.x, dy: w.y - hit.y, moved: false };
          c.classList.add('is-dragging');
        } else {
          // Dragging a card would move it, so in view-only a card drag pans.
          pan = { x: e.clientX, y: e.clientY };
          c.classList.add('is-panning');
        }
      } else {
        pan = { x: e.clientX, y: e.clientY };
        c.classList.add('is-panning');
        if (!ui.spaceDown && e.button === 0) select(null);
      }
      schedule();
    });

    c.addEventListener('pointermove', function (e) {
      if (pointers[e.pointerId]) {
        pointers[e.pointerId].x = e.clientX;
        pointers[e.pointerId].y = e.clientY;
      }
      if (pinch) { updatePinch(); return; }

      if (drag) {
        var pt = localPoint(e);
        var w = R.screenToWorld(pt.x, pt.y);
        if (!drag.moved) {
          Store.checkpoint();   // one undo entry for the whole gesture
          drag.moved = true;
        }
        Store.movePerson(drag.id, w.x - drag.dx, w.y - drag.dy);
        return;
      }

      if (pan) {
        R.panBy(e.clientX - pan.x, e.clientY - pan.y);
        pan.x = e.clientX;
        pan.y = e.clientY;
        schedule();
        return;
      }

      var p2 = localPoint(e);
      var w2 = R.screenToWorld(p2.x, p2.y);
      var over = R.hitTest(geo, w2.x, w2.y);
      var id = over ? over.id : null;
      c.classList.toggle('over-node', !!id && !ui.spaceDown);
      if (id !== ui.hoverId) {
        ui.hoverId = id;
        schedule();
      }
    });

    function endPointer(e) {
      delete pointers[e.pointerId];
      if (Object.keys(pointers).length < 2) pinch = null;
      if (drag && drag.moved) toast('Moved — press L to auto arrange again', 1400);
      drag = null;
      pan = null;
      c.classList.remove('is-panning', 'is-dragging');
      try { c.releasePointerCapture(e.pointerId); } catch (err) { /* already gone */ }
    }
    c.addEventListener('pointerup', endPointer);
    c.addEventListener('pointercancel', endPointer);

    c.addEventListener('wheel', function (e) {
      e.preventDefault();
      var pt = localPoint(e);
      if (e.ctrlKey || e.metaKey || !e.shiftKey) {
        var factor = Math.pow(0.999, e.deltaY * (e.deltaMode === 1 ? 16 : 1));
        R.zoomAt(pt.x, pt.y, factor);
      } else {
        R.panBy(-e.deltaX, -e.deltaY);
      }
      schedule();
    }, { passive: false });

    c.addEventListener('dblclick', function (e) {
      if (ui.viewer) return;
      var pt = localPoint(e);
      var w = R.screenToWorld(pt.x, pt.y);
      var hit = R.hitTest(geo, w.x, w.y);
      if (hit) openPersonForm(hit.id);
      else addPersonAt(w);
    });

    c.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      if (ui.viewer) return;
      var pt = localPoint(e);
      var w = R.screenToWorld(pt.x, pt.y);
      var hit = R.hitTest(geo, w.x, w.y);
      if (hit) {
        select(hit.id);
        nodeMenu(hit.id, e.clientX, e.clientY);
      } else {
        canvasMenu(w, e.clientX, e.clientY);
      }
      schedule();
    });
  }

  function startPinch() {
    var ids = Object.keys(pointers);
    var a = pointers[ids[0]], b = pointers[ids[1]];
    pinch = { dist: dist(a, b), k: R.view.k };
  }

  function updatePinch() {
    var ids = Object.keys(pointers);
    if (ids.length < 2) return;
    var a = pointers[ids[0]], b = pointers[ids[1]];
    var d = dist(a, b);
    if (!pinch.dist) return;
    var rect = el.tree.getBoundingClientRect();
    var mid = { x: (a.x + b.x) / 2 - rect.left, y: (a.y + b.y) / 2 - rect.top };
    var target = pinch.k * (d / pinch.dist);
    R.zoomAt(mid.x, mid.y, target / R.view.k);
    schedule();
  }

  function dist(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function localPoint(e) {
    var rect = el.tree.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function addPersonAt(world) {
    openPersonForm(null, {
      title: 'Add person',
      defaults: {
        x: Math.round((world ? world.x : 0) - M.NODE_W / 2),
        y: Math.round((world ? world.y : 0) - M.NODE_H / 2),
        pinned: true
      },
      onCreate: function (fields) {
        var p = Store.addPerson(fields);
        select(p.id);
      }
    });
  }

  function select(id) {
    ui.selectedId = id;
    renderPeopleList();
    renderInspector();
    if (id && (ui.viewer || window.innerWidth <= 860)) el.inspector.classList.add('is-open');
    else if (!id && ui.viewer) el.inspector.classList.remove('is-open');
    schedule();
  }


  /* ============================ google drive ======================== */

  var DRIVE_LABELS = {
    unlinked:   function () { return 'Link to Drive'; },
    connecting: function () { return 'Connecting…'; },
    pending:    function (c) { return c.name; },
    saving:     function (c) { return c.name; },
    synced:     function (c) { return c.name; },
    error:      function (c) { return c.name; },
    paused:     function (c) { return c.name; }
  };

  var DRIVE_TITLES = {
    unlinked:   'Keep this tree in a Google Drive file',
    connecting: 'Connecting to Google Drive…',
    pending:    'Unsaved changes — saving to Drive shortly',
    saving:     'Saving to Google Drive…',
    synced:     'Saved to Google Drive',
    error:      'Could not save to Google Drive',
    paused:     'Paused while a shared tree is open'
  };

  function renderDriveButton() {
    var linked = Drive.isLinked();
    var status = linked ? Drive.status : 'unlinked';
    // Nothing is saved while a shared tree is on screen, so the dot must not
    // promise a save that is never coming.
    if (linked && ui.shared) status = 'paused';
    var label = (DRIVE_LABELS[status] || DRIVE_LABELS.unlinked)(Drive.config || {});

    el.driveLabel.textContent = label;
    el.btnDrive.dataset.status = status;
    el.btnDrive.title = Drive.message || DRIVE_TITLES[status] || DRIVE_TITLES.unlinked;
  }

  function openDriveDialog() {
    if (Drive.isLinked()) openDriveManage();
    else openDriveLink();
  }

  /** Status line plus the actions available on an existing link. */
  function openDriveManage() {
    var cfg = Drive.config;
    var body = document.createElement('div');

    var state = document.createElement('div');
    state.className = 'drive-state' + (Drive.status === 'error' ? ' is-error' : '');
    var txt = document.createElement('div');
    var head = document.createElement('div');
    head.innerHTML = 'Linked to <b></b>';
    head.querySelector('b').textContent = cfg.name;
    var sub = document.createElement('div');
    sub.style.marginTop = '3px';
    sub.textContent = Drive.message || driveStatusText();
    txt.appendChild(head);
    txt.appendChild(sub);
    state.appendChild(txt);
    body.appendChild(state);

    var note = document.createElement('p');
    note.className = 'modal-note';
    note.textContent = 'Every change is saved to this file automatically. ' +
      'Loading replaces the tree on screen with the copy in Drive.';
    body.appendChild(note);

    openModal('Google Drive', body, [
      button('Unlink', 'btn btn-danger', function () {
        closeModal();
        Drive.unlink();
        toast('Unlinked from Drive — still saving locally');
      }),
      button('Load from Drive', 'btn', function () { closeModal(); driveLoad(); }),
      button('Change file…', 'btn', function () { closeModal(); openDriveLink(); }),
      button('Save now', 'btn btn-primary', function () { closeModal(); driveSaveNow(); })
    ]);
  }

  function driveStatusText() {
    if (Drive.status === 'saving') return 'Saving…';
    if (Drive.status === 'pending') return 'Unsaved changes — saving shortly.';
    if (Drive.status === 'synced') {
      return Drive.lastSaved ? 'Saved at ' + new Date(Drive.lastSaved).toLocaleTimeString() : 'Saved.';
    }
    return 'Ready.';
  }

  function openDriveLink() {
    var cfg = Drive.config || {};
    var body = document.createElement('div');

    var note = document.createElement('p');
    note.className = 'modal-note';
    note.textContent = 'Paste the link to a file in your Drive. The tree is saved into that ' +
      'file from then on, so it follows you between browsers and devices.';
    body.appendChild(note);

    function field(label, node) {
      var wrap = document.createElement('div');
      wrap.className = 'field';
      var l = document.createElement('label');
      l.textContent = label;
      wrap.appendChild(l);
      wrap.appendChild(node);
      return wrap;
    }

    var nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.placeholder = 'Family tree';
    nameInput.value = cfg.name || '';
    body.appendChild(field('Name (shown on the button)', nameInput));

    var urlInput = document.createElement('input');
    urlInput.type = 'text';
    urlInput.placeholder = 'https://drive.google.com/file/d/…/view';
    urlInput.value = cfg.url || '';
    body.appendChild(field('Google Drive file link', urlInput));

    var idInput = document.createElement('input');
    idInput.type = 'text';
    idInput.placeholder = '…apps.googleusercontent.com';
    idInput.value = cfg.clientId || '';
    var idField = field('Google OAuth client ID', idInput);

    // The setup steps matter once; hide them when a client ID is already known.
    var setup = document.createElement('div');
    setup.className = 'setup-box';
    setup.hidden = !!cfg.clientId;
    setup.innerHTML =
      '<ol>' +
      '<li>Open <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener">Google Cloud → Credentials</a> and create a project.</li>' +
      '<li>Enable the <a href="https://console.cloud.google.com/apis/library/drive.googleapis.com" target="_blank" rel="noopener">Google Drive API</a>.</li>' +
      '<li>Create an <b>OAuth client ID</b> of type <b>Web application</b>.</li>' +
      '<li>Add this page\u2019s address as an authorised JavaScript origin: <code class="origin-hint"></code></li>' +
      '<li>On the OAuth consent screen, add your own Google account as a test user.</li>' +
      '</ol>';
    setup.querySelector('.origin-hint').textContent = window.location.origin;
    setup.appendChild(idField);

    var toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'setup-toggle';
    toggle.textContent = cfg.clientId ? 'Change Google account setup' : 'Hide setup steps';
    toggle.addEventListener('click', function () {
      setup.hidden = !setup.hidden;
      toggle.textContent = setup.hidden ? 'Change Google account setup' : 'Hide setup steps';
    });
    body.appendChild(toggle);
    body.appendChild(setup);

    var errorBox = document.createElement('div');
    errorBox.className = 'drive-state is-error';
    errorBox.hidden = true;
    body.appendChild(errorBox);

    var applyBtn = button('Apply', 'btn btn-primary', apply);

    function apply() {
      var name = nameInput.value.trim();
      var url = urlInput.value.trim();
      var clientId = idInput.value.trim();

      errorBox.hidden = true;
      if (!url) { return fail('Paste the link to the Drive file first.'); }
      if (!Drive.parseFileId(url)) { return fail('That does not look like a Google Drive file link.'); }
      if (!clientId) {
        setup.hidden = false;
        toggle.textContent = 'Hide setup steps';
        return fail('A Google OAuth client ID is needed before the page can reach Drive.');
      }

      applyBtn.disabled = true;
      applyBtn.textContent = 'Connecting…';

      Drive.link({ name: name, url: url, clientId: clientId }).then(function (result) {
        closeModal();
        if (result.remote) askDriveDirection(result);
        else {
          // Nothing usable in the file yet: the tree on screen becomes its content.
          driveSaveNow();
          toast('Linked to ' + Drive.config.name);
        }
      }, function (err) {
        applyBtn.disabled = false;
        applyBtn.textContent = 'Apply';
        fail(err.message);
      });
    }

    function fail(message) {
      errorBox.textContent = message;
      errorBox.hidden = false;
    }

    body.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); apply(); }
    });

    openModal('Link to Drive', body, [button('Cancel', 'btn', closeModal), applyBtn]);
    window.setTimeout(function () { (cfg.name ? urlInput : nameInput).focus(); }, 30);
  }

  /** The linked file already holds a tree, so ask before either side is lost. */
  function askDriveDirection(result) {
    var remote = result.remote;
    var body = document.createElement('div');
    var note = document.createElement('p');
    note.className = 'modal-note';
    note.innerHTML = 'That file already holds a family tree (<b></b>). ' +
      'The tree open here has <b class="local"></b>. Which one should win?';
    note.querySelector('b').textContent = countPeople(remote.people.length) +
      (remote.title ? ' — “' + remote.title + '”' : '');
    note.querySelector('.local').textContent = countPeople(Store.state.people.length);
    body.appendChild(note);

    openModal('This file is not empty', body, [
      button('Keep what is on screen', 'btn', function () {
        closeModal();
        driveSaveNow();
        toast('Drive file overwritten with the tree on screen');
      }),
      button('Load the Drive copy', 'btn btn-primary', function () {
        closeModal();
        applyRemoteTree(remote);
        toast('Loaded ' + countPeople(Store.state.people.length) + ' from Drive');
      })
    ]);
  }

  function countPeople(n) {
    return n + (n === 1 ? ' person' : ' people');
  }

  function applyRemoteTree(data) {
    Store.load(data);
    ui.selectedId = null;

    // A tree saved without positions needs arranging before it can be read.
    var arranged = false;
    if (!Store.state.people.some(function (p) { return p.x || p.y; })) {
      Layout.autoArrange(Store.state);
      arranged = true;
    }
    R.fit(Store.state);
    schedule();

    // This came *from* Drive, so drop the save that Store.load queued rather
    // than writing the same bytes back. The arranged positions are new local
    // data, though, so those are worth keeping.
    Drive.markSynced();
    if (arranged) queueDriveSave();
  }

  function driveLoad() {
    if (!Drive.isLinked()) return;
    toast('Loading from Drive…');
    Drive.read(false).then(function (text) {
      var data = JSON.parse(text);
      if (!data || !Array.isArray(data.people)) throw new Error('That file is not a family tree.');
      applyRemoteTree(data);
      toast('Loaded ' + countPeople(Store.state.people.length) + ' from Drive');
    }).catch(function (err) {
      toast(err.message || 'Could not load from Drive', 3600);
      renderDriveButton();
    });
  }

  function driveSaveNow() {
    if (!Drive.isLinked()) return;
    queueDriveSave();
    Drive.flush().then(function (ok) {
      if (ok) toast('Saved to ' + Drive.config.name);
      else if (Drive.status === 'error') toast(Drive.message || 'Could not save to Drive', 3600);
    });
  }



  /* =========================== viewer mode ========================== */

  /**
   * Full screen, read only: no toolbar, no sidebar, and nothing that would
   * change the tree. A person's card still opens, just without its editing
   * controls. This is how a shared link opens.
   */
  function enterViewer() {
    if (ui.viewer) return;
    ui.viewer = true;
    document.body.classList.add('is-viewer');
    el.btnExitViewer.hidden = false;
    el.viewerTitle.hidden = false;
    hideMenu();
    closeModal();
    el.inspector.classList.remove('is-open');
    renderViewerTitle();
    renderInspector();
    onResize();
    el.btnExitViewer.focus();
  }

  function toggleViewer() {
    if (ui.viewer) leaveViewer();
    else enterViewer();
  }

  function exitViewer() {
    if (!ui.viewer) return;
    ui.viewer = false;
    document.body.classList.remove('is-viewer');
    el.btnExitViewer.hidden = true;
    el.viewerTitle.hidden = true;
    el.inspector.classList.remove('is-open');
    renderInspector();
    onResize();
  }

  function renderViewerTitle() {
    if (!ui.viewer) return;
    var n = Store.state.people.length;
    el.viewerTitleName.textContent = Store.state.title || 'Family tree';
    el.viewerTitleMeta.textContent = countPeople(n) +
      (ui.shared ? ' · shared with you · view only' : ' · view only');
  }

  /**
   * The X button. A tree that arrived in a link has not been kept anywhere
   * yet, so leaving is the moment to decide what happens to it.
   */
  function leaveViewer() {
    if (!ui.shared) {
      exitViewer();
      return;
    }

    var body = document.createElement('div');
    var note = document.createElement('p');
    note.className = 'modal-note';
    note.innerHTML = 'This tree came from a share link and is not saved anywhere yet. ' +
      'Editing keeps it in this browser' +
      (Drive.isLinked() ? ' and replaces your linked Drive file' : '') +
      '; discarding returns to the tree you already had.';
    body.appendChild(note);

    openModal('Leave full screen', body, [
      button('Cancel', 'btn', closeModal),
      button('Discard', 'btn btn-danger', function () {
        closeModal();
        exitViewer();
        discardShared();
      }),
      button('Edit this tree', 'btn btn-primary', function () {
        closeModal();
        keepShared(exitViewer);
      })
    ]);
  }

  /* ======================== share links (#tree=) ==================== */

  /** Open a tree that arrived in the URL, without touching anything saved. */
  function openSharedPayload(payload) {
    return Share.decode(payload).then(function (data) {
      // A Drive save already queued would serialise whatever is in the store
      // when its timer fires, which is about to become the shared tree — so
      // drop it. The local copy still holds those edits, and discarding the
      // share re-uploads them.
      if (Drive.isLinked()) Drive.cancelPending();

      Store.persistPaused = true;
      ui.shared = true;
      Store.load(data);
      ui.selectedId = null;
      if (!Store.state.people.some(function (p) { return p.x || p.y; })) {
        Layout.autoArrange(Store.state);
      }
      Store.clearHistory();       // undo must not reach back past the share
      // Enter first: hiding the toolbar and sidebar grows the canvas, and a
      // fit measured before that leaves the tree off to one side.
      enterViewer();
      R.fit(Store.state);
      schedule();
      return true;
    }, function (err) {
      clearShareHash();
      toast(err.message || 'That share link could not be opened', 4200);
      return false;
    });
  }

  /** Adopt the shared tree as this browser's own. */
  function keepShared(after) {
    var linked = Drive.isLinked();
    function commit() {
      ui.shared = false;
      Store.persistPaused = false;
      Store.persist();
      clearShareHash();
      if (typeof after === 'function') after();
      if (linked) {
        queueDriveSave();
        toast('Kept — now saving here and to ' + Drive.config.name);
      } else {
        toast('Kept — now saving in this browser');
      }
    }

    if (!linked) return commit();

    // Keeping would also replace the linked Drive file, so say so first.
    var body = document.createElement('div');
    var note = document.createElement('p');
    note.className = 'modal-note';
    note.innerHTML = 'This tree will be saved in this browser <b>and will replace the ' +
      'contents of your linked Drive file</b> (<b class="f"></b>).';
    note.querySelector('.f').textContent = Drive.config.name;
    body.appendChild(note);

    openModal('Keep this tree?', body, [
      button('Cancel', 'btn', closeModal),
      button('Keep and replace', 'btn btn-primary', function () { closeModal(); commit(); })
    ]);
  }

  /** Drop the shared tree and go back to whatever this browser had. */
  function discardShared() {
    exitViewer();
    ui.shared = false;
    Store.persistPaused = false;
    clearShareHash();

    var restored = Store.restore();
    if (!restored) Store.state = FT.emptyState();
    Store.clearHistory();
    ui.selectedId = null;
    Store.emit('restore');
    if (Store.state.people.length) R.fit(Store.state);
    schedule();
    toast('Shared tree discarded');
  }

  function clearShareHash() {
    if (!Share.hasLink()) return;
    if (window.history && window.history.replaceState) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    } else {
      window.location.hash = '';
    }
  }

  function openShareDialog() {
    if (!Store.state.people.length) {
      toast('Add someone to the tree first');
      return;
    }

    var body = document.createElement('div');
    var note = document.createElement('p');
    note.className = 'modal-note';
    note.textContent = 'This link carries the whole tree inside it. Nothing is uploaded ' +
      'anywhere — the part after the # never leaves the browser — so it keeps working ' +
      'without any account, and it is a snapshot rather than a live copy.';
    body.appendChild(note);

    var field = document.createElement('textarea');
    field.className = 'share-url';
    field.readOnly = true;
    field.value = 'Building link…';
    body.appendChild(field);

    var size = document.createElement('div');
    size.className = 'share-size';
    size.textContent = ' ';
    body.appendChild(size);

    var copyBtn = button('Copy link', 'btn btn-primary', function () {
      field.select();
      copyText(field.value).then(function (ok) {
        toast(ok ? 'Link copied' : 'Press Ctrl+C to copy the selected link');
      });
    });
    copyBtn.disabled = true;

    openModal('Share link', body, [button('Close', 'btn', closeModal), copyBtn]);

    Share.link(Store.state).then(function (url) {
      field.value = url;
      copyBtn.disabled = false;
      var verdict = Share.classify(url);
      size.className = 'share-size level-' + verdict.level;
      size.textContent = '';
      var strong = document.createElement('b');
      strong.textContent = verdict.chars.toLocaleString() + ' characters';
      size.appendChild(strong);
      size.appendChild(document.createTextNode(' · ' + verdict.note));
      field.focus();
      field.select();
    }, function () {
      field.value = '';
      size.className = 'share-size level-risk';
      size.textContent = 'This tree could not be packed into a link.';
    });
  }

  function copyText(text) {
    if (window.navigator.clipboard && window.navigator.clipboard.writeText) {
      return window.navigator.clipboard.writeText(text).then(function () { return true; },
        function () { return legacyCopy(); });
    }
    return Promise.resolve(legacyCopy());
  }

  function legacyCopy() {
    try {
      return document.execCommand('copy');
    } catch (err) {
      return false;
    }
  }

  /* ============================ toolbar ============================= */

  function bindToolbar() {
    on('btnAddPerson', 'click', function () { addPersonAt(centerWorld()); });
    on('btnArrange', 'click', doArrange);
    on('btnFit', 'click', doFit);
    on('btnUndo', 'click', function () { Store.undo(); });
    on('btnRedo', 'click', function () { Store.redo(); });
    on('btnSample', 'click', loadSample);
    on('btnTheme', 'click', toggleTheme);
    on('btnClear', 'click', confirmClear);

    on('btnExport', 'click', exportJSON);
    on('btnPng', 'click', exportPNG);
    on('btnDrive', 'click', openDriveDialog);
    on('btnShare', 'click', openShareDialog);
    on('btnViewer', 'click', enterViewer);
    on('btnExitViewer', 'click', leaveViewer);
    on('btnImport', 'click', function () { el.fileInput.click(); });
    on('fileInput', 'change', importJSON);

    on('btnZoomIn', 'click', function () { R.zoomAt(R.width / 2, R.height / 2, 1.2); schedule(); });
    on('btnZoomOut', 'click', function () { R.zoomAt(R.width / 2, R.height / 2, 1 / 1.2); schedule(); });
    on('btnZoomReset', 'click', function () { R.setZoom(1); schedule(); });

    on('search', 'input', function () {
      ui.query = el.search.value;
      renderPeopleList();
      schedule();
    });

    on('treeTitle', 'change', function () {
      Store.setTitle(el.treeTitle.value.trim() || 'My Family Tree');
    });

    on('btnCloseInspector', 'click', function () {
      el.inspector.classList.remove('is-open');
    });

    on('modalClose', 'click', closeModal);
    on('modal', 'mousedown', function (e) {
      if (e.target === el.modal) closeModal();
    });

    Array.prototype.forEach.call(el.emptyState.querySelectorAll('[data-act]'), function (b) {
      b.addEventListener('click', function () {
        if (b.dataset.act === 'add') addPersonAt(centerWorld());
        else loadSample();
      });
    });
  }

  function centerWorld() {
    return R.screenToWorld(R.width / 2, R.height / 2);
  }

  function doArrange() {
    if (!Store.state.people.length) return;
    Store.checkpoint();
    Layout.autoArrange(Store.state);
    Store.emit('arrange');
    R.fit(Store.state);
    schedule();
    toast('Tree arranged');
  }

  /** Relayout after structural edits, unless the user has hand-placed cards. */
  function arrangeIfUnpinned() {
    var pinned = Store.state.people.some(function (p) { return p.pinned; });
    if (!pinned) Layout.autoArrange(Store.state);
  }

  function doFit() {
    if (!Store.state.people.length) return;
    R.fit(Store.state);
    schedule();
  }

  function confirmClear() {
    if (!Store.state.people.length) return;
    var body = document.createElement('div');
    var p = document.createElement('p');
    p.className = 'modal-note';
    p.textContent = 'Remove every person and start an empty tree? Undo still works afterwards.';
    body.appendChild(p);
    openModal('Clear tree', body, [
      button('Cancel', 'btn', closeModal),
      button('Clear everything', 'btn btn-danger', function () {
        closeModal();
        var title = Store.state.title;
        Store.reset();
        Store.setTitle(title);
        ui.selectedId = null;
        toast('Tree cleared');
      })
    ]);
  }

  /* ======================== import and export ======================= */

  function exportJSON() {
    var data = FT.clone(Store.state);
    download(
      new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
      slug(Store.state.title) + '.json'
    );
    toast('Tree exported');
  }

  function importJSON(e) {
    var file = e.target.files && e.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var data = JSON.parse(String(reader.result));
        Store.load(data);
        ui.selectedId = null;
        if (!Store.state.people.some(function (p) { return p.x || p.y; })) {
          Layout.autoArrange(Store.state);
        }
        R.fit(Store.state);
        schedule();
        toast('Imported ' + Store.state.people.length + ' people');
      } catch (err) {
        toast('That file is not a valid tree');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  function exportPNG() {
    if (!Store.state.people.length) { toast('Nothing to export yet'); return; }
    var canvas = R.exportCanvas(Store.state, Layout.geometry(Store.state), 2);
    canvas.toBlob(function (blob) {
      if (!blob) { toast('PNG export failed'); return; }
      download(blob, slug(Store.state.title) + '.png');
      toast('PNG saved');
    }, 'image/png');
  }

  function download(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function slug(text) {
    return String(text || 'family-tree').toLowerCase().replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'family-tree';
  }

  /* ============================ keyboard ============================ */

  function bindKeyboard() {
    document.addEventListener('keydown', function (e) {
      if (e.key === ' ' && !isTyping(e.target)) {
        ui.spaceDown = true;
        el.tree.classList.remove('over-node');
        if (!isTyping(e.target)) e.preventDefault();
      }

      if (e.key === 'Escape') {
        if (!el.modal.hidden) { closeModal(); return; }
        if (!el.contextMenu.hidden) { hideMenu(); return; }
        if (ui.selectedId) { select(null); return; }
        if (ui.viewer) { leaveViewer(); return; }
      }

      if (isTyping(e.target)) return;

      var mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) Store.redo(); else Store.undo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); Store.redo(); return; }
      if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); exportJSON(); return; }
      if (mod) return;

      // Panning, zooming and fitting are fine while viewing. Everything that
      // would change the tree — including auto-arrange, which moves cards — is
      // not, so those keys do nothing until the viewer is left.
      var key = e.key.toLowerCase();
      var EDIT_KEYS = ['a', 'l', 'e', 'delete', 'backspace'];
      if (ui.viewer && EDIT_KEYS.indexOf(key) >= 0) return;

      switch (key) {
        case 'a': e.preventDefault(); addPersonAt(centerWorld()); break;
        case 'l': doArrange(); break;
        case 'f': doFit(); break;
        case 'v': toggleViewer(); break;
        case '+': case '=': R.zoomAt(R.width / 2, R.height / 2, 1.2); schedule(); break;
        case '-': R.zoomAt(R.width / 2, R.height / 2, 1 / 1.2); schedule(); break;
        case 'delete': case 'backspace':
          if (ui.selectedId) { e.preventDefault(); confirmDelete(ui.selectedId); }
          break;
        case 'e':
          if (ui.selectedId) openPersonForm(ui.selectedId);
          break;
        case '/':
          e.preventDefault();
          el.search.focus();
          break;
      }
    });

    document.addEventListener('keyup', function (e) {
      if (e.key === ' ') ui.spaceDown = false;
    });
  }

  function isTyping(node) {
    if (!node) return false;
    var tag = node.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || node.isContentEditable;
  }

  /* ============================= window ============================= */

  function bindWindow() {
    var resizeTimer = null;
    window.addEventListener('resize', function () {
      onResize();
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(schedule, 120);
    });
    document.addEventListener('click', function (e) {
      if (!el.contextMenu.hidden && !el.contextMenu.contains(e.target)) hideMenu();
    });
    window.addEventListener('hashchange', function () {
      var payload = Share.fromLocation();
      if (payload) openSharedPayload(payload);
    });
    window.addEventListener('beforeunload', function () {
      Store.persist();
      // keepalive lets this upload outlive the page.
      if (Drive.isLinked() && Drive.hasUnsaved()) Drive.flush({ keepalive: true });
    });
  }

  /* ============================= theme ============================== */

  function readStoredTheme() {
    var saved;
    try { saved = window.localStorage.getItem('kinfolk.theme'); } catch (err) { saved = null; }
    if (saved === 'light' || saved === 'dark') return saved;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark' : 'light';
  }

  function applyTheme(name) {
    document.documentElement.setAttribute('data-theme', name);
    if (el.btnTheme) {
      el.btnTheme.textContent = name === 'dark' ? '☀' : '☾';
      el.btnTheme.title = name === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
    }
  }

  function toggleTheme() {
    ui.theme = ui.theme === 'dark' ? 'light' : 'dark';
    applyTheme(ui.theme);
    R.setTheme(ui.theme);
    try { window.localStorage.setItem('kinfolk.theme', ui.theme); } catch (err) { /* ignore */ }
    renderPeopleList();
    renderInspector();
    schedule();
  }

  /* ============================= toast ============================== */

  var toastTimer = null;
  function toast(message, ms) {
    el.toast.textContent = message;
    el.toast.hidden = false;
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function () { el.toast.hidden = true; }, ms || 2000);
  }

  /* =========================== sample tree ========================== */

  function loadSample() {
    Store.load(sampleTree());
    Layout.autoArrange(Store.state);
    Store.emit('sample');
    ui.selectedId = null;
    R.fit(Store.state);
    schedule();
    toast('Demo family loaded');
  }

  function sampleTree() {
    function p(id, first, last, gender, birth, death, extra) {
      return Object.assign({
        id: id, firstName: first, lastName: last, gender: gender,
        birthDate: birth || '', deathDate: death || '', deceased: !!death
      }, extra || {});
    }
    return {
      format: FT.FORMAT,
      version: 1,
      title: 'The Hart Family',
      people: [
        p('g1', 'William', 'Hart', 'male', '1932-04-11', '2010-08-02', { occupation: 'Carpenter', birthPlace: 'Leeds, UK' }),
        p('g2', 'Margaret', 'Hart', 'female', '1935-09-30', '2018-01-17', { maidenName: 'Ellis', occupation: 'Teacher' }),
        p('p1', 'Robert', 'Hart', 'male', '1958-02-14', '', { occupation: 'Engineer' }),
        p('p2', 'Diane', 'Hart', 'female', '1960-07-05', '', { maidenName: 'Cole' }),
        p('p3', 'Susan', 'Nguyen', 'female', '1961-11-23', '', { maidenName: 'Hart', occupation: 'Physician' }),
        p('p4', 'Paul', 'Nguyen', 'male', '1959-03-19', ''),
        p('c1', 'Emma', 'Reyes', 'female', '1986-06-08', '', { maidenName: 'Hart', occupation: 'Architect' }),
        p('c2', 'Tom', 'Reyes', 'male', '1984-12-01', ''),
        p('c3', 'Jack', 'Hart', 'male', '1989-05-16', '', { occupation: 'Chef' }),
        p('c4', 'Lily', 'Nguyen', 'female', '1990-10-02', ''),
        p('d1', 'Noah', 'Reyes', 'male', '2015-03-22', ''),
        p('d2', 'Ava', 'Reyes', 'female', '2018-09-14', '')
      ],
      unions: [
        { id: 'u1', a: 'g1', b: 'g2', type: 'married', date: '1956', children: ['p1', 'p3'] },
        { id: 'u2', a: 'p1', b: 'p2', type: 'married', date: '1984', children: ['c1', 'c3'] },
        { id: 'u3', a: 'p3', b: 'p4', type: 'married', date: '1988', children: ['c4'] },
        { id: 'u4', a: 'c1', b: 'c2', type: 'married', date: '2013', children: ['d1', 'd2'] }
      ]
    };
  }

  /* ================================================================= */

  function boot() {
    try {
      init();
    } catch (err) {
      reportStalePage(String((err && err.message) || err));
      throw err;
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window, document);
