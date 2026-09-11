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

### Drive sync

`js/drive.js` owns the link, the token and the upload queue. Saves are
debounced, so a burst of drags becomes one upload, and edits that arrive during
an upload are coalesced into the next one rather than dropped. A rejected token
is refreshed once and the request retried; a failed save keeps its snapshot so
the next edit retries it. Loading from Drive cancels the queued save rather
than writing the same bytes back — unless the loaded tree had no positions, in
which case the freshly arranged layout is worth saving.
