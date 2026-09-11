# Kinfolk — a family tree on a canvas

A browser app for drawing a family tree. Everything is rendered on an HTML5
`<canvas>`: pan, zoom, drag cards around, and export the result as PNG or JSON.

No build step, no dependencies, no account, no server. Open `index.html` and
start typing.

## Running it

```
open index.html          # macOS
xdg-open index.html      # Linux
```

Or serve the folder if you prefer a URL:

```
npx http-server -p 8080 .
```

The tree is saved to `localStorage` as you work, so a reload picks up where you
left off. Use **Export** for a real backup.

## What it does

- **Canvas tree** — generational rows, couples side by side, orthogonal drop
  lines from each partnership to its children.
- **Auto arrange** — a tidy-tree pass that centres parents over their children
  and packs sibling subtrees without overlaps.
- **Hand placement** — drag any card; it keeps its spot (and its connectors)
  until you auto-arrange again.
- **Relationships** — parents, partners, children and siblings, added as new
  people or linked to people already in the tree.
- **Partnership kinds** — married (solid bar with a node), engaged and partners
  (dashed), divorced (struck through), drawn with the usual genealogy marks.
- **Person details** — names including maiden name, dates, birthplace,
  occupation, notes, and a deceased flag. Dates are free text, so `1890` and
  `abt. 1890` are as welcome as `1890-04-11`.
- **Search** — filters the sidebar and highlights matching cards on the canvas.
- **Undo / redo** across every edit, including drags.
- **Dark mode**, following your system preference on first run.
- **Export** as JSON (round-trips through Import) or PNG at 2× for printing.
- **Google Drive sync** — link a Drive file once and every edit is saved back to
  it, so the tree follows you between browsers and devices. See below.
- **Share links** — pack the whole tree into a URL. No hosting, no account.
- **Full screen view** — a read-only viewer with no toolbar or sidebar, which is
  how a shared link opens.
- **Focus view** — read one person's corner of a large tree instead of all of it.

## Controls

| Action | How |
| --- | --- |
| Pan | Drag empty canvas, space-drag, or middle-drag |
| Zoom | Scroll wheel, pinch, or the zoom controls |
| Select | Click a card |
| Move | Drag a card |
| Edit | Double-click a card, or `E` |
| Add person | `A`, or double-click empty canvas |
| Relationship menu | Right-click a card |
| Auto arrange | `L` |
| Fit to view | `F` |
| Delete selected | `Delete` |
| Undo / redo | `Ctrl+Z` / `Ctrl+Shift+Z` |
| Export JSON | `Ctrl+S` |
| Focus search | `/` |

## Share links

**Share link** turns the whole tree into a URL:

```
https://nitnis.github.io/FamilyTree/#tree=gH4sIAAAAAAAAA63WXU...
```

The tree travels *inside* the link. Nothing is uploaded, nothing is fetched, and
no account is involved — so there is nothing to keep in sync and nothing to
break later. The part after the `#` is never sent to a server, not even to
GitHub Pages, so the tree only ever exists in the browsers holding the link.

The JSON is gzipped with `CompressionStream` and base64url-encoded. Measured on
trees with realistic, non-repeating data:

| People | JSON | Link |
| --- | --- | --- |
| 12 | 3.3 KB | ~1.0 KB |
| 100 | 27 KB | ~4.5 KB |
| 300 | 82 KB | ~12 KB |

The share dialog shows the length and says how safely it will travel: browsers
handle these easily, but mail clients sometimes wrap very long links across
lines and break them, so for a large tree sending the JSON export is steadier.
A browser without `CompressionStream` still reads and writes links, just longer
ones — the payload's first character records which encoding was used.

### Opening one is safe

A share link opens in the full screen viewer (below), so **opening one writes
nothing**. Your own saved tree stays exactly as it was, and a linked Drive file
is left alone.

Pressing **✕** asks what to do with it, since it is not saved anywhere yet:

- **Edit this tree** — adopt it as this browser's tree, leave the viewer and
  resume saving. If a Drive file is linked, it says first that the file will be
  replaced.
- **Discard** — go back to the tree this browser already had.
- **Cancel** — carry on looking.

## Focus view

**Focus on this person** — on the details card, in the right-click menu, or `Z`
— narrows the canvas to that person's corner of the tree. A bar across the top
names them, reports how much of the tree is showing (`14 of 77`), and offers
**1 / 2 / 3 / All** for how far to reach:

| Depth | Reaches |
| --- | --- |
| 1 | Parents, partners, children |
| 2 | Also grandparents, grandchildren, siblings |
| 3 | Also great-grandparents, aunts, uncles, nieces, nephews |
| All | Everyone connected |

Steps are counted along parent and child links only. Partners come along so no
couple is drawn half-missing, but they are not walked *through* — otherwise
every marriage would drag in another whole family and the radius would mean
nothing.

Opening a focus picks the depth by what actually fits: it starts at 2 and
narrows if the result would be too small to read. Focusing on a leaf can afford
two generations either way; focusing on the oldest ancestor cannot, because
their descendants are most of the tree. On the 77-person tree above, focusing
on the patriarch at a fixed depth of 2 gives 50 people at 17% zoom, while the
chosen depth of 1 gives 14 at 52%. The buttons always override.

Focusing is a view, not an edit: the excerpt is a separate tree of copies
swapped in for the real one, so every view — canvas, sidebar, search, details —
works on it unchanged while the real tree is held aside untouched and saving is
paused. Editing is off until **Show all**, which restores the tree exactly,
undo history included.

## Full screen view

**Full screen** (or `V`) hides the toolbar and sidebar and gives the canvas the
whole page. Pan, zoom and fit all work, and clicking a person opens their card
as a floating panel — the same details as the editor, minus every control that
would change something. Relatives stay clickable, so a tree can be explored by
walking from person to person.

Nothing in this mode edits the tree: cards cannot be dragged, double-click and
right-click do nothing, and the editing keys are ignored. Dragging a card pans
instead, which is what a drag means when nothing can move.

**✕** in the corner leaves, or `Escape` (once to close an open card, again to
leave). A shared tree is asked about on the way out, as above.

### Opening scale

A tree is only fitted to the window when it can be read at that size. A wide
one — 37 people across is nearly 9,000px, which fits a phone only at 3%, where
a card is five pixels and no text is drawn — opens instead at a readable zoom,
anchored on the leftmost person of the oldest generation, with **⤢** beside the
zoom controls to see the whole shape. The anchor is a real card rather than the
midpoint of the top row, because the oldest generation of a wide tree is often
spread right across it and its midpoint falls in a gap.

## Saving to Google Drive

Press **Link to Drive**, give the file a name and paste the link to a file in
your Drive. From then on the button shows that name, and every edit is written
back to the file. Press it again to save now, reload the Drive copy, point at a
different file, or unlink. The local `localStorage` copy keeps working
throughout, so the tree is never only in one place.

If the file you link already contains a tree, the app asks which copy should
win before writing anything.

### One-time Google setup

This is a static page with no server, so it cannot hold a secret, and **a share
link alone is not enough to save anything**: Google Drive writes require an
OAuth access token, and the plain `drive.google.com` download endpoint sends no
CORS headers. The URL only says *which* file to use — the writing goes through
the Drive REST API with a token from Google Identity Services.

So you need your own OAuth client ID, which the app stores next to the link:

1. In [Google Cloud → Credentials](https://console.cloud.google.com/apis/credentials),
   create a project.
2. Enable the [Google Drive API](https://console.cloud.google.com/apis/library/drive.googleapis.com).
3. Create an **OAuth client ID** of type **Web application**.
4. Add the page's address as an **authorised JavaScript origin** — for the
   hosted copy that is `https://nitnis.github.io`, and for a local file
   `http://localhost:8080` (opening over `file://` has no origin Google will
   accept, so Drive sync needs the page served over http).
5. On the OAuth consent screen, add your own Google account as a test user.

The client ID is not a credential on its own — it is designed to sit in a page,
and Google enforces which origins may use it. Nothing is sent anywhere except
Google.

### Why the broad scope

The app asks for the `drive` scope rather than the narrower `drive.file`.
`drive.file` only covers files the app itself created or that you opened
through the Google Picker, so it cannot reach a file you paste as a URL.
Keeping the app in Testing mode with your own account as a test user means no
Google verification is needed.

## How it is put together

Four plain scripts on `window.FT`, loaded in order — no modules, so `file://`
works without a server.

| File | Responsibility |
| --- | --- |
| `js/store.js` | The data model, mutations, undo history, `localStorage` |
| `js/drive.js` | Google Drive linking, OAuth tokens, debounced save/load |
| `js/share.js` | Packing a tree into a URL fragment and reading it back |
| `js/focus.js` | Selecting one person's corner of a tree as a standalone excerpt |
| `js/layout.js` | Generation assignment, auto-arrangement, edge routing |
| `js/render.js` | Canvas painting, viewport (pan/zoom), hit testing, PNG export |
| `js/app.js` | DOM: toolbar, sidebar, inspector, modals, pointer and key handling |

### The data model

A tree is **people** plus **unions**. A union is a partnership between one or
two people, and it owns the children born into it:

```json
{
  "format": "kinfolk-family-tree",
  "version": 1,
  "title": "The Hart Family",
  "people": [
    { "id": "g1", "firstName": "William", "lastName": "Hart",
      "gender": "male", "birthDate": "1932-04-11", "deathDate": "2010-08-02",
      "x": 290, "y": 80, "pinned": false }
  ],
  "unions": [
    { "id": "u1", "a": "g1", "b": "g2", "type": "married",
      "date": "1956", "children": ["p1", "p3"] }
  ]
}
```

Hanging children off the union rather than off each parent is what makes
sibling groups, step-families and remarriages come out right: each union has
one junction point, and every child drops from it.

### Layout

`autoArrange()` runs three passes:

1. **Generations** — relaxation until stable: a child sits one row below the
   lower of its parents, and partners always share a row.
2. **Blocks** — people joined by partnership are merged (union-find) into one
   block, then ordered by walking the partner chain so a remarried person sits
   between their spouses.
3. **Placement** — depth-first over the block forest. Leaves take the next free
   slot on their row; a parent block centres over its children's cards, and
   when centring would collide with what is already on the row, the whole
   subtree shifts right instead.

`geometry()` is separate and runs on every frame, turning current positions
into the partner bars and child drop lines. That split is why a dragged card
keeps its connectors without a relayout.

A 161-person, 5-generation tree arranges in about 3 ms.

### Share encoding

`js/share.js` is self-contained: `encode()`/`decode()` move a tree between JSON
and a URL fragment, and `classify()` turns a link's length into advice. Only
errors raised deliberately carry their message through to the user — a failed
gunzip throws its own opaque text, so anything else is reported as a damaged or
truncated link.

Entering the shared view pauses `Store.persist()` rather than trying to undo a
write afterwards. It also cancels any queued Drive save, because that save holds
a *getter* rather than a snapshot and would otherwise upload the shared tree to
someone else's file when its timer fired.

Viewer mode is a `body.is-viewer` class plus a `ui.viewer` flag that every
editing path checks. Because a shared tree always opens in the viewer, and the
viewer permits no edits, "shared but edited" cannot occur — the banner that
used to cover that state was unreachable once the viewer existed and has been
removed, with the viewer's title chip reporting the same thing.

### Drive sync

`js/drive.js` owns the link, the token and the upload queue. Saves are
debounced, so a burst of drags becomes one upload, and edits that arrive during
an upload are coalesced into the next one rather than dropped. A rejected token
is refreshed once and the request retried; a failed save keeps its snapshot so
the next edit retries it. Loading from Drive cancels the queued save rather
than writing the same bytes back — unless the loaded tree had no positions, in
which case the freshly arranged layout is worth saving.
