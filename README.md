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

## How it is put together

Four plain scripts on `window.FT`, loaded in order — no modules, so `file://`
works without a server.

| File | Responsibility |
| --- | --- |
| `js/store.js` | The data model, mutations, undo history, `localStorage` |
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
