# Changelog

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
