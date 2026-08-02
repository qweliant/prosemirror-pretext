# Changelog

## Unreleased

### Added

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
