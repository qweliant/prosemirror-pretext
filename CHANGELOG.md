# Changelog

## Unreleased

### Added

- **Tables** (layout + paint). A `table` / `table_row` / `table_cell` /
  `table_header` subtree lays out as a grid: columns share the content width
  (honoring an explicit `colwidth`), and each row is as tall as its tallest
  cell. Cells are top-aligned.

  The design point: a cell is not a new kind of thing. It is an ordinary block
  laid out into its own `LayoutFrame` — a new concept threaded through block
  layout, being the first time anything needed a horizontal box narrower than
  the content column. Cell contents come back as normal `BlockLayout`s with
  absolute coordinates, so painting, caret mapping, and text editing work
  inside a cell with no special cases. Only the grid chrome (rules, header
  fills) is new geometry, exposed as `TableChrome`.

  Hit-testing narrows by x for cell blocks, reusing the predicate floats
  already needed: blocks that share a vertical band are told apart by x.

  New `tableBorderColor` and `tableHeaderBackground` options.

  **Spans.** Geometry runs off a resolved grid (`buildGrid`), so a cell's
  column is a function of what is above it rather than its index in its row.
  `colspan` widens a cell across the columns it covers; `rowspan` reserves
  height across its rows, with any shortfall given to the last row it covers so
  a shorter cell that already fixed an earlier row isn't disturbed.

  **Cell content is the document's own flow.** `layoutFlow` lays a container's
  children out down any frame, so a cell gets paragraphs, headings, lists (with
  markers and indent), leaf nodes, and *nested tables* without the table layout
  knowing what any of them are.

  **Cross-cell selection.** `CellSelection` is a real `Selection` subclass, so
  it maps through transactions, survives undo, and exposes the selected cells
  as ranges to ordinary commands. Dragging out of the cell it started in stops
  being a text range and becomes a rectangle — a text selection across a cell
  boundary would span the structural tokens between cells and read as
  gibberish. The rectangle snaps outward so a merged cell is never half
  selected. Selected cells are painted as filled boxes rather than line rects.

  **Commands**, all plain ProseMirror `Command`s so they bind through `keymap`
  and land as single undo steps: `addRowBefore`/`addRowAfter`/`deleteRow`,
  `addColumnBefore`/`addColumnAfter`/`deleteColumn`, `deleteTable`,
  `selectRow`/`selectColumn`, `goToNextCell(dir)` (Tab past the last cell adds
  a row), and `tableKeymap()`. They are span-aware: deleting a column narrows a
  cell that reaches beyond it instead of removing it, and inserting a row grows
  a cell that straddles the boundary rather than splitting it.

  Built without `prosemirror-tables`, whose only entry point imports
  `prosemirror-view` at module scope — that would make the DOM view a runtime
  dependency of an editor whose whole point is not having one. Attribute names
  (`colspan`, `rowspan`, `colwidth`) and the selection's JSON id (`"cell"`)
  match it, so a prosemirror-tables schema drops straight in.

  Not yet: merging and splitting cells, column resize handles, and copy/paste
  of a cell rectangle into another table. Typing in a table still falls back to
  full layout — a cell edit only moves later rows when that cell is its row's
  tallest, which the incremental path's "shift everything below by dy" cannot
  express.

- **Drag & drop.**
  - **Move a node** by dragging it: press a leaf/atom block and drag, and a
    drop indicator marks the seam it will land in (drawn where a gap cursor
    between those blocks would be). Releasing dispatches one transaction — a
    single undo step — and selects the node at its new home; `Escape` abandons
    the drag. Built on **pointer** events rather than HTML5 drag, so mouse,
    touch, and pen share one path; node view containers claim the touch gesture
    (`touch-action: none`) so a swipe on a node drags it instead of scrolling.
    On by default (`dragDrop: false` opts out); a node view running its own
    gesture opts out per-node by `preventDefault()`-ing its `pointerdown`.
  - **Drops from outside** — OS files and drags from other tabs — surface as
    `handlers.drop` and `handlers.dropFiles`. Files have no default: turning one
    into a node means uploading it, which is the app's story, not the editor's.
    Dropped `text/html` / `text/plain` insert at the drop position via the
    existing schema-aware paste path.
  - `moveNode(from, to)` and `startNodeDrag(pos, event)` are public, so keyboard
    reordering commands and custom drag handles run through the same path.
  - New: `dragDrop` and `dropIndicatorColor` options; `dragStart`, `drop`, and
    `dropFiles` handlers.

  Not yet: dragging content *out* to another application (that needs native
  HTML5 drag, which excludes touch), dragging a text selection, and edge
  auto-scroll inside a `maxHeight` scroller.

### Fixed

- **Frame cost no longer grows with document size.** Painting culled blocks one
  at a time, so every frame still walked the whole document even though a
  keystroke did not — the "flat as the document grows" claim held for typing but
  not for frames. The visible window is now found by binary search
  (`visibleRange`), making a frame O(visible + log n): a 400px viewport walks 9
  blocks whether the document has 500 or 8,000.

  The subtlety is that position order stops implying vertical order once a float
  or a table exists — two cells in a row share a band, so a multi-block cell
  yields y offsets like 7, 53, 7, and narrowing would silently drop blocks.
  Layout now checks directly whether its output is sorted and painting falls
  back to the full walk when it is not.

- **Typing outside a table is incremental again.** The first table release made
  the incremental path decline whenever the document contained one, so a
  keystroke in any paragraph of such a document paid a full layout pass. Only
  edits *inside a cell* need that — a cell's height change moves later rows only
  when it is its row's tallest, which the incremental shift cannot express.
  Edits elsewhere are incremental as before, with table chrome now shifted
  alongside the blocks it frames (it carries absolute coordinates of its own and
  would otherwise detach from the text by exactly the height the edit added).

- **The `maxHeight` scroller no longer clips the end of every line** on platforms
  with classic, space-taking scrollbars (Windows; macOS set to "always show").
  The scroller was sized to exactly the canvas width, so the vertical scrollbar
  was carved out of the content box and forced a spurious *horizontal* scrollbar
  over the canvas. It is now widened by the measured scrollbar width with the
  gutter reserved, so the content box measures `width` whether or not it happens
  to be scrolling. Overlay scrollbars measure 0 and are unaffected.

- Clicking the text beside a floated node no longer puts the caret before the
  float. Hit-testing matched a block on its vertical band alone, and a float
  owns a band but only part of the width — so every click on the text flowing
  next to it resolved to the float instead. Blocks with a `floatRect` are now
  narrowed by x as well as y, in both `posAtCoords` (including the `inside`
  it reports) and internal click mapping. In-flow blocks span the full column
  and are unaffected.

- A node view's container no longer swallows input meant for the content behind
  it. The container's box is often larger than the node view inside it (an
  in-flow image narrower than the column, a floated node, an atom's reserved
  height), and that empty area was absorbing clicks, drags, and hovers aimed at
  the text — or another node — underneath. The container is now
  `pointer-events: none` and only the node view's own element is interactive, so
  node selection is bound to the view element rather than the container.

## 0.2.0

### Added

- **Touch input.** The editor is now usable on phones and tablets:
  - **Tap** places the caret and raises the on-screen keyboard.
  - **Long-press** selects the word under your finger and shows draggable
    **selection handles**; drag a handle (or keep dragging after the long-press)
    to extend the selection.
  - **Swipe** scrolls natively (`touch-action: pan-y`), with no tap delay.
  - Input is unified across mouse, touch, and pen; taps `preventDefault` the
    synthesized mouse events so there's no double-handling.
  - When the on-screen keyboard opens, the caret is scrolled into view
    (`visualViewport`-aware).

  Not yet: an iOS-style magnifier loupe, and double/triple-tap selection.

## 0.1.4

### Changed

- The accessibility mirror now finds the changed block via a document diff and
  re-serializes only that one, instead of an identity scan over every top-level
  block each keystroke. With this, **no per-keystroke work in the editing path is
  O(document size)** — caret reads, layout, and the mirror are all O(log n) or
  better. (Marginal on benchmarks at typical sizes; it removes the last linear
  scan for pathological documents and slower devices.)

## 0.1.3

### Fixed

- `coordsAtPos` no longer forces a synchronous layout when the editor is
  virtualized (`maxHeight` scroller) with the accessibility mirror enabled — the
  common real-world setup. It was reading `getBoundingClientRect` and
  `scroller.scrollTop` on every call, each of which flushes layout (including the
  hidden DOM mirror) when the document is dirty. Both are now cached and
  refreshed once per frame, so per-keystroke caret reads stay flat with document
  size under virtualization too.

## 0.1.2

Performance and correctness work, much of it surfaced by the new latency
benchmark (`bench/`). Per-keystroke cost is now decoupled from document size:
typing in a large document and reading the caret each keystroke stays flat
(~1ms) where it previously grew linearly with the document (~10ms at 8k blocks).

### Added

- `flush()` — synchronously recompute layout and repaint instead of waiting for
  the next animation frame.

### Changed / Fixed

- `coordsAtPos` is now a pure cache lookup: the canvas's viewport rect is cached
  (invalidated on scroll/resize) instead of calling `getBoundingClientRect` on
  every read, which forced a synchronous reflow.
- `coordsAtPos` is now correct immediately after a `dispatch` — layout is
  recomputed lazily on read rather than only on the next frame (it could
  previously return a stale position between a keystroke and the next paint).
- Incremental layout: a single-block edit (typing) rebuilds only that block and
  shifts the scalar positions of the blocks after it, instead of re-walking and
  re-allocating the whole document's layout each keystroke. Structural edits
  (splits, joins, list ops, floats) fall back to a full pass.
- `coordsAtPos`/`posToCoords` binary-search for the block containing a position
  (O(log n)) instead of a linear scan.
- The hidden screen-reader DOM mirror updates incrementally — only the top-level
  block whose content changed is re-serialized, instead of re-serializing the
  whole document on every keystroke.

## 0.1.1

### Added

- `autofocus?: boolean` option (default `true`) — pass `false` to mount an editor
  without stealing focus (e.g. an embed mid-page). Construction-time focus also
  uses `{ preventScroll: true }`.
- `"./package.json"` is now exported (fixes `ERR_PACKAGE_PATH_NOT_EXPORTED`).

### Fixed

- Embedded editors size to their container's content width instead of overflowing.

## 0.1.0

Initial release: ProseMirror document model + Pretext layout + Canvas rendering.
Caret/selection, marks, lists, blockquotes, code blocks, decorations,
overridable handlers, float-wrap, and a screen-reader DOM mirror.
