# Changelog

## 0.1.1

Performance and correctness work, much of it surfaced by the new latency
benchmark (`bench/`). Per-keystroke cost is now decoupled from document size:
typing in a large document and reading the caret each keystroke stays flat
(~1ms) where it previously grew linearly with the document.

### Added

- `autofocus?: boolean` option (default `true`) — pass `false` to mount an editor
  without stealing focus (e.g. an embed mid-page). Construction-time focus also
  uses `{ preventScroll: true }`.
- `flush()` — synchronously recompute layout and repaint instead of waiting for
  the next animation frame.
- `"./package.json"` is now exported.

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

## 0.1.0

Initial release: ProseMirror document model + Pretext layout + Canvas rendering.
Caret/selection, marks, lists, blockquotes, code blocks, decorations,
overridable handlers, float-wrap, and a screen-reader DOM mirror.
