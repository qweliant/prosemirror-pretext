# Changelog

## Unreleased

### Fixed

- **Copying carries marks and structure, not just characters.** `copy` and
  `cut` wrote `text/plain` and nothing else, while a *drag* of the same
  selection wrote `text/html` through the schema's own `toDOM`. So the same
  bold sentence kept its bold when dragged to another application and lost it
  when copied there — and worse, a copy/paste *inside this editor* round-tripped
  through plain text and came back stripped of every mark, because the paste
  path looks for `text/html` first and found none. Both now send the payload a
  drag already sent.

  The HTML also carries `data-pm-slice`, ProseMirror's own record of how deep
  the slice is open at each end, and a paste honours it. A parser can only infer
  depth from the elements it is given, and a complete `<p>` looks like a closed
  one: without the attribute, copying the back half of one paragraph and the
  front half of the next pasted back as two whole new blocks instead of merging
  into the paragraph at the caret. A cross-block copy pasted over itself is now
  a no-op, which is the test that pins it. Depths the content can't support fall
  back to what the parser worked out rather than failing the paste.

  Cell selections keep the plain-text-only payload: they serialize to bare
  `<td>`s that nothing can place without the table around them, so table
  clipboard stays the open roadmap item it was.

  Why it went unnoticed: the copy test asserted the *data* and threw away the
  MIME type it was handed (`setData: (_t, d) => …`). It could not see the flavour
  that was missing. It asserts the types now.

### Added

- **The IME composition is visible while it is being composed.** Everything
  about composition was handled except showing it: `compositionstart` set a
  flag, `compositionend` inserted the result, and `insertCompositionText` was
  explicitly ignored. Nothing painted in between. The in-flight text lives in a
  1px transparent textarea, so anyone composing Japanese, Korean, Chinese or
  Vietnamese saw the IME's candidate window and not one character of what they
  were actually writing, until it committed.

  `compositionupdate` now keeps the in-flight string and the canvas paints it at
  the caret, underlined the way every platform marks uncommitted text, with the
  caret and the textarea (which the candidate window tracks) both sitting after
  it rather than under it. A composition in a heading is drawn at the heading's
  size, since the block's own resolved style supplies the font.

  The string is deliberately *not* put in the document. An IME revises it on
  every keystroke, and a document that churned once per revision would fill the
  undo stack with text the user never committed and broadcast every intermediate
  guess to collaborators. Only the commit becomes a transaction.

  The honest limit: because the preview isn't in the layout, it cannot reflow
  the line around itself the way a DOM editor does. It lays the page's own
  backdrop down first so it occludes the text to the right of the caret rather
  than blending into it, and a commit replaces it with real content that lays
  out properly. Composing mid-line therefore covers what follows until the
  commit, rather than pushing it along.

## 0.3.0

### Added

- **Inline text-color decorations.** `Decoration.inline` takes a `color`, which
  repaints the glyphs rather than the space around them. Every other property on
  an inline decoration is an overlay — a rect behind the text, a line through it
  — and needs nothing from layout. Color is the one that cannot be: a range
  covering part of a run has to cut that run before it can fill half of it a
  different color.

  The cut happens during painting, not layout, and that is the whole design
  point. A fill color has no effect on metrics, so the pieces inherit the
  geometry already computed and no cache is touched — which matters because
  decorations are recomputed every render, so a decoration that dirtied layout
  would relayout the visible document on every keystroke of a search box. Each
  piece is placed at the same `xForOffsetInLine` the caret reports, so a
  recolored span lands on exactly the pixels a `background` over the same range
  would cover, and clicking a recolored character still puts the caret against
  it. Neighbouring pieces are shaped independently — kerning does not carry
  across a cut — which is inherent to splitting a run and already true of marks.

- **`setWidth(px)` re-lays the document into a different content column.** Width
  was fixed at construction, which made the editor the one part of a responsive
  layout that couldn't respond — hosts had to freeze their own dimensions to
  whatever the editor was built with, or clip it. The per-block layout cache
  already recorded the width each block was assembled at, so it needed no help;
  the *positional* cache and `lastLayouts` did, since both hand back absolute
  geometry by node identity, and are now dropped on a resize.

- **A magnifier loupe, and double/triple-tap selection, on touch.** A fingertip
  covers the very text it is aiming at, so placing or extending a selection now
  raises a magnifier above the touch. The magnified image is blitted straight
  off the editor's own canvas with `drawImage` — the text is already rendered
  pixels, so there is nothing to lay out or re-paint, one copy per touchmove,
  and the loupe agrees with the screen exactly, selection bands and decorations
  included. It appears for a long-press and while dragging either selection
  handle, which is where the finger hides the thing being aimed at.

  Tapping twice selects the word and three times selects the block, the touch
  counterpart of double- and triple-click. Slop matters more than it does for a
  mouse: a finger never lands twice in the same pixel, so taps within 24px and
  320ms count as the same run, and a swipe in between breaks it.

- **Dragging a text selection**, including out to another application. The
  selection now starts a real HTML5 drag, which is the only mechanism that can
  hand content to Finder, a mail client, or another tab — a pointer gesture
  cannot. It carries both `text/plain` and `text/html` (through the schema's own
  `toDOM`, so marks and structure survive), moves by default and copies with
  Alt, and when another application takes it as a move the source is removed on
  `dragend`. A drop back inside the editor is a document move rather than a
  paste of its own serialization: one undo step, and no round-trip through HTML.

  A press inside the selection no longer collapses it immediately — it may be
  the beginning of a drag, so the caret only moves once the press turns out to
  be an ordinary click. That press is also the one the editor no longer
  `preventDefault`s, since suppressing the default on mousedown stops the
  browser from ever starting a drag; the stack is `user-select: none` instead,
  so the browser doesn't begin selecting the accessibility mirror's text
  underneath. Copy is unaffected — it is served by the textarea's own handler,
  never by a DOM selection.

- **Edge auto-scroll while dragging.** A drag that reaches the top or bottom of
  a `maxHeight` scroller now pulls the view along, with speed ramping by how far
  into the band the pointer is, and the drop indicator re-resolving against the
  document moving underneath it. Without this a drag could only reach as far as
  the viewport already showed, which on a virtualized document is very little of
  it. Applies to both node drags and drags arriving from outside.

- **The editor is scale-aware, so it edits correctly under a CSS transform.**
  Put it on a zooming surface — a board, a slide canvas, a zoomed-out overview
  — and clicks land on the character you aimed at, `coordsAtPos` reports real
  viewport pixels, and the caret box scales with everything else.

  Nothing has to be configured, because the scale is *derived* rather than
  declared. `offsetWidth` is the canvas's own layout width; the client rect
  reports it after every transform between it and the viewport. Their ratio is
  the accumulated scale, whoever applied it and however deep — so mapping in
  divides by it, mapping out multiplies, and at 1:1 both are the identity and
  cost nothing. A canvas measuring zero maps as identity rather than emitting
  NaN coordinates. Rotation is the one thing this cannot see through, since it
  turns the client rect into an axis-aligned bounding box.

  The one thing the editor cannot discover is that the transform *changed*,
  because a CSS transform fires no event and does not resize the element (so
  `ResizeObserver` is silent). Hosts that zoom call the new
  **`invalidateGeometry()`** afterwards. Only the cached outbound path needs it:
  pointer mapping re-measures on every gesture, so a press is never stale even
  if you forget.

- **Collaborative cursors and selections.** `Decoration.cursor(pos, color, {
  label })` paints a remote participant's caret, and their name on a flag beside
  it, onto the canvas. A remote caret *could* be a widget decoration — the demo
  used to build one that way — but a widget is an absolutely-positioned element
  floating above the canvas, so it does not scroll, clip, or composite with the
  text it annotates the way the local caret does. Drawing it in the same pass as
  everything else is what makes a roomful of them cost nothing. The flag flips
  below the caret when it would clip off the top, and is pulled back inside the
  content column when the name would overhang the right edge.

  `remoteSelection({ from, to, head, color, name })` returns the band and the
  caret for one participant, the band derived from their color by `withAlpha`
  and the caret at `head` so a backwards selection reads as backwards. The
  transport is deliberately absent: whether positions arrive over Yjs,
  `prosemirror-collab`, or a socket of your own is an application concern, and
  what the editor owes you is the drawing.

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

  All three of this entry's original gaps — dragging content *out* to another
  application, dragging a text selection, and edge auto-scroll — landed later in
  this same cycle, on native HTML5 drag; see the entries above. Node moves stay
  on the pointer path, so they keep working on touch, which native drag does not
  reach.

### Fixed

- **Lines are no longer clipped a pixel or two short of their last glyph.** The
  canvas is now `TEXT_BLEED` (6px) wider than the content column, and a
  `maxHeight` scroller reserves that strip alongside the scrollbar gutter.

  Pretext lays marked text out as styled runs and trims the whitespace between
  them into a gap it reserves on its own terms. The editor re-expands that
  whitespace so every space stays an editable character, appends it to the
  preceding run, and re-measures it in *that* run's font — and a space in
  Georgia is not the same width as the same space in its italic. Each mark
  boundary on a line contributes a fraction of a pixel, and a line crossing
  several of them accumulates enough to overrun the width it was broken to. A
  canvas sized to exactly the column then guillotines the final glyph.

  Swept across 61 wrap widths of the demo document (2,248 laid-out lines): 5
  lines overran with real glyphs, worst case 5.1px, every one a marked line
  crossing a mark boundary. 47 more overran by trailing whitespace only, which
  paints nothing, and no single-font line ever overran. 6px covers the measured
  worst case with room to spare.

  This is a mitigation, and the strip is transparent — layout still wraps to the
  content width, and every painted rect still stops there. The honest fix is to
  stop re-expanding whitespace into the painted text (CSS `white-space: normal`
  renders a double space as one and still lets the caret walk both), but that is
  the most caret-test-dependent code in the repo and `prepareRichInline` offers
  no `pre-wrap` option to hand the problem back to.

- **The caret is drawn only while the editor has focus**, and the blink timer
  stops re-rendering a blurred editor. A stray caret in an unfocused editor
  merely looked odd when there was one editor on a page; put several on one
  surface — a board, a comment thread, a grid of cards — and every one of them
  blinks at once, each costing two renders a second to do it.

  Related, and worth knowing before mounting more than one: `autofocus` defaults
  to `true`, so editors mounted together fight over focus and the last one wins.
  Pass `autofocus: false` to all but one.

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
