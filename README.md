# prosemirror-pretext

A canvas-based text editor that combines ProseMirror's document model with Pretext's pure-arithmetic text layout engine. No contenteditable, no DOM text nodes -- every glyph is placed by `ctx.fillText()` on an HTML5 Canvas.

## Why

The browser's DOM was never designed for high-frequency layout calculations. Every call to `getBoundingClientRect` triggers a synchronous reflow. By moving text measurement into pure arithmetic (via [Pretext](https://github.com/chenglou/pretext)) and text rendering to Canvas, we break free from this bottleneck entirely.

- **ProseMirror** handles the *what* -- document model, transactions, history.
- **Pretext** handles the *where* -- sub-millisecond line breaking and glyph positioning.
- **Canvas** handles the *how* -- pixel-level rendering at device resolution.

## Install

```bash
bun add prosemirror-pretext
```

## Usage

```ts
import { CanvasEditor } from 'prosemirror-pretext'
import { Schema } from 'prosemirror-model'
import { EditorState } from 'prosemirror-state'

const schema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: { content: 'text*', toDOM: () => ['p', 0], parseDOM: [{ tag: 'p' }] },
    text: { inline: true },
  },
})

const state = EditorState.create({
  doc: schema.node('doc', null, [
    schema.node('paragraph', null, [schema.text('Hello, canvas.')]),
  ]),
  schema,
})

const editor = new CanvasEditor({
  state,
  container: document.getElementById('editor')!,
  maxHeight: 480, // optional — content scrolls past this height
})
```

The container element should be an empty block-level element. The editor creates a `<canvas>` and a hidden `<textarea>` (for input/IME) inside it.

### Options

| Option | Default | Description |
| --- | --- | --- |
| `state` | *(required)* | ProseMirror `EditorState` with schema + initial doc |
| `container` | *(required)* | Element that will host the canvas + textarea |
| `font` | `'16px Inter'` | CSS font string for text rendering |
| `lineHeight` | `26` | Line height in px |
| `width` | `460` | Content area width in px |
| `blockGap` | `20` | Vertical gap between block nodes in px |
| `maxHeight` | `null` | If set, scrolls when content exceeds this height |
| `textColor` | `'#d4d4d8'` | Main text color |
| `firstLineColor` | `'#818cf8'` | First-line accent color |
| `caretColor` | `'#a5b4fc'` | Caret color |
| `selectionColor` | `'rgba(129, 140, 248, 0.25)'` | Selection highlight color |
| `placeholder` | `''` | Prompt drawn when the document is empty |
| `placeholderColor` | `'#5a5a64'` | Placeholder text color |
| `ruleColor` | `'#3a3a42'` | Color of a `horizontal_rule` leaf |
| `ariaLabel` | `'Rich text editor'` | Accessible name (the input's `aria-label`) |
| `a11yMirror` | `true` | Maintain a screen-reader-visible DOM mirror of the document |
| `markStyles` | defaults below | Maps mark names → a style `{ fontWeight, fontStyle, fontFamily, color, background, underline, strikethrough }`, or a `(mark) => style` function to read attributes |
| `blockStyles` | `heading` / `blockquote` / `code_block` defaults | Maps block-type names → text style `{ fontSize, fontWeight, fontStyle, fontFamily, lineHeight, color }` + box decorations `{ paddingLeft/Right/Top/Bottom, background, borderLeft }` (or a `(node) => style` fn) |
| `keymap` | `{}` | ProseMirror key bindings, checked before built-in keys |
| `floats` | `[]` | Rects (`{ x, y, width, height }`) the text flows around |
| `floatRect` | `undefined` | `(node) => { x, y, width } \| null` — float a doc node so text wraps around it (height comes from its node view); null keeps it in flow |
| `floatGutter` | `12` | Gap in px kept between text and each float |
| `linkMark` | `'link'` | Schema mark name treated as a followable link |
| `onFollowLink` | opens in new tab | `(href, event)` run on Cmd/Ctrl-click of a link |
| `nodeViews` | `{}` | `{ typeName: (node, getPos) => HTMLElement }` — custom DOM for atom blocks |
| `onRender` | — | Called after every render with cache + timing stats |

Default `markStyles`: `strong` → bold, `em` → italic, `code` → monospace + green,
`link` → blue + underline, `underline` → underline, `strikethrough` → line-through,
`textColor` → `mark.attrs.color`, `highlight` → background from `mark.attrs.color`
(default yellow), `superscript`/`subscript` → shrunk + baseline-shifted. The
colour marks read their value from the mark, so `markStyles` entries may be a
function of the mark, not just a fixed style.

## Marks (bold / italic / code)

Marks live in your ProseMirror schema — the editor just *renders* them (no
`prosemirror-view`, so mid-line font changes are laid out by hand via Pretext's
rich-inline and painted per run). `markStyles` maps mark names to styling and is
schema-agnostic; the defaults cover `strong`, `em`, and `code`.

A starter schema + key bindings are exported for convenience (bring your own if
you prefer):

```ts
import { CanvasEditor, markSpecs, buildMarkKeymap } from 'prosemirror-pretext'
import { toggleMark } from 'prosemirror-commands'

const schema = new Schema({ nodes, marks: markSpecs })

const editor = new CanvasEditor({
  state: EditorState.create({ doc, schema }),
  container,
  keymap: buildMarkKeymap(schema), // Cmd-B / Cmd-I / Cmd-`
})

// Toolbar buttons run commands directly:
button.onmousedown = (e) => { e.preventDefault(); editor.command(toggleMark(schema.marks.strong)) }
```

Typing at a collapsed cursor inherits stored marks, so `Cmd-B` then typing
produces bold text.

### Links

`markSpecs` includes a `link` mark (`href` attribute) that renders blue +
underlined by default. **Cmd/Ctrl-click** a link follows it (`onFollowLink`,
default opens in a new tab); plain click edits as normal, and the cursor turns
into a pointer when a modifier-click would follow. Apply links like any mark —
`editor.command(toggleMark(schema.marks.link, { href }))`. The `underline` and
`strikethrough` marks render their decoration lines too.

## Floats (text wrapping around elements)

Text flows around exclusion rectangles. The editor only reserves the space —
you render the actual element (image, callout, …) and keep the rect in sync:

```ts
editor.setFloats([{ x: 250, y: 30, width: 190, height: 130 }])
```

Coordinates are content-space (`x` from the content's left edge, `y` matches
`BlockLayout.yOffset`). Each line uses the **wider** free side of a rect, so a
rect on the right wraps text on the left and vice-versa; a full-width rect
pushes text below it. Pretext lays out each line at its own width via
`layoutNextLine`, so reflow on drag/resize is sub-millisecond.

Notes: text wraps on one side per line (no split-both-sides yet), and with
floats present the layout cache is bypassed (recomputed each frame) — the
no-float path stays fully cached.

## Undo / redo

History is a standard ProseMirror plugin — add it to your state and bind the
keys (the editor applies transactions through plugins, so it just works):

```ts
import { history, undo, redo } from 'prosemirror-history'

const editor = new CanvasEditor({
  state: EditorState.create({ doc, schema, plugins: [history()] }),
  container,
  keymap: {
    ...buildMarkKeymap(schema),
    'Mod-z': undo,
    'Mod-y': redo,
    'Shift-Mod-z': redo,
  },
})
```

## Node views (interactive blocks)

Canvas can't host a button or an `<iframe>`, so interactive/leaf block nodes are
rendered as **real DOM elements the editor positions over the space it reserves
for them** — ProseMirror's "node view" idea. Give `nodeViews` a factory per node
type:

```ts
const editor = new CanvasEditor({
  state, container,
  nodeViews: {
    runButton: (node, getPos) => {
      const el = document.createElement('div')
      el.textContent = node.attrs.code
      el.onclick = () => { /* run it, mutate el, or dispatch via getPos() */ }
      return el
    },
  },
})
```

The editor measures the element's height to reserve space (and re-flows when it
changes via `ResizeObserver`), mounts/positions/destroys it as the doc changes,
and handles selection: **arrow into** an atom block selects it (`NodeSelection`),
**click** its chrome selects it, **Backspace** deletes it, and arrows step past
it. `getPos()` returns the node's live position for commands. Interactive
children should `stopPropagation()` on mousedown so clicking them doesn't select
the node. This is the foundation for images, embeds, and runnable blocks. Scope:
flat atom blocks (no nesting), and a changed node's view is recreated, not
diffed.

## Selection-anchored UI (bubble menus)

Toolbars are yours to build — the editor exposes `editor.command(cmd)` to run
ProseMirror commands and `editor.state` to read active marks (see the demo's
fixed toolbar). For *floating* UI positioned over the selection, two methods map
document positions to the screen, mirroring `EditorView.coordsAtPos`:

```ts
editor.coordsAtPos(pos)   // → { x, y, height } in viewport coords (or null)
editor.selectionRect()    // → { left, right, top, bottom } in viewport coords (null if empty)
```

A bubble menu is then just a positioned DOM element updated on each render
(`onRender` fires on every selection change):

```ts
function update() {
  const r = editor.selectionRect()
  if (!r) { bubble.style.display = 'none'; return }
  bubble.style.display = 'flex'
  bubble.style.left = `${(r.left + r.right) / 2 - bubble.offsetWidth / 2}px`
  bubble.style.top  = `${r.top - bubble.offsetHeight - 8}px`
}
```

Same primitives power inline link editors, hovercards, and autocomplete popups.

## Demo

```bash
bun install
bun run dev          # the standalone playground (index.html + demo/)
bun run dev:site     # the kawaii docs site with an embedded live editor (site/)
```

## Docs site (GitHub Pages)

The 🐸 landing page in `site/` builds to `docs/` as a self-contained static app
(the editor + deps bundled in). A GitHub Actions workflow
(`.github/workflows/pages.yml`) builds and deploys it on every push to `main`, so
you just push — no committed build artifacts (`docs/` is gitignored).

One-time setup: **Settings → Pages → Source → GitHub Actions**. It then serves at
`https://<user>.github.io/prosemirror-pretext/` (base path set in
`vite.site.config.ts`). To preview locally: `bun run dev:site`.

## Rendering roadmap

Actively being built; not yet published to npm. Editing, selection, marks
(bold/italic/code), floats, undo/redo, clipboard, and viewport virtualization
already work (see the sections above).

Because this editor replaces `prosemirror-view` with canvas, **everything the
DOM would normally render has to be drawn by us.** The list below is the rest
of that surface — capabilities `prosemirror-view` gives you for free that this
editor needs to implement.

### Inline — marks & styling

- [x] **Links** — `link` mark, blue + underlined, Cmd/Ctrl-click to follow (see above)
- [x] **Underline / strikethrough** — drawn decoration lines via `markStyles`
- [x] **Text & highlight color** — `textColor` / `highlight` marks; per-run fill + a rect behind the glyphs
- [x] **Superscript / subscript** — `superscript` / `subscript` marks; shrunk + baseline-shifted runs

### Block types

- [x] **Headings** — per-block font size/weight + line height via `blockStyles` (built-in `heading` sized by level)
- [x] **Blockquote** — indent + left accent bar via `blockStyles` box decorations (built-in `blockquote`; text-only, not yet nesting paragraphs)
- [x] **Code block** — monospace + background panel + padding via `blockStyles` (built-in `code_block`); `pre-wrap` preserves whitespace
- [x] **Horizontal rule** — canvas-drawn leaf block (`horizontal_rule` / `hr`), selectable like an atom (`ruleColor`)
- [x] **Lists** (bullet / ordered) — recursive tree walk → per-level indent + bullet/number markers in the gutter; Enter splits an item, Tab/Shift-Tab nest/lift (via `prosemirror-schema-list`)
- [x] **Text alignment** — `left | center | right` via a block's `align` attribute (caret/click/selection all follow the shift). `justify` not yet (needs inter-word distribution)
- [ ] **Tables** — grid layout with per-cell text flow

### Media & embeds

- [x] **Atom block node views** — interactive DOM (buttons, embeds) positioned over reserved space (`nodeViews`)
- [x] **Images** — a block atom rendered by a node view (a real `<img>`); drag-to-resize (corner handle), and drag-to-float so text wraps around it (`floatRect`, reusing the float engine — the same obstacle-wrap Pretext's own demos use)
- [ ] **Inline atoms** — mentions/chips, emoji images, hard breaks, inline math (these are *inline*, not block)

### Selection & affordances

- [x] **Node selection** — select an atom block as a unit (arrow-into / click / Backspace)
- [x] **Placeholder text** — prompt rendered when the document is empty (`placeholder` option)
- [x] **Hard breaks** — Shift+Enter inserts a newline; honored by both the single-font (`pre-wrap`) path and the marked path (split into hard-line segments). In a code block, Enter inserts a newline and Mod-Enter (or a second Enter on a blank last line) exits to a paragraph
- [x] **Gap cursor** — caret in the seam between adjacent non-text blocks (stacked images, leading/trailing atoms). Reach it by arrow or click; Enter/typing inserts a paragraph, Backspace/Delete removes the neighbour. Uses `prosemirror-gapcursor`'s `GapCursor` selection

### Decorations

- [ ] **Inline decorations** — search highlights, spellcheck squiggles
- [ ] **Collaborative cursors / selections** — remote carets and ranges
- [ ] **Widget decorations** — inline buttons / annotations

### Input

- [x] **Rich paste** — `text/html` parsed through the schema's `parseDOM` rules (marks/headings/blocks survive); plain text splits blank lines into paragraphs
- [ ] **Drag & drop** — move nodes, drop images

## Architecture

```text
ProseMirror EditorState (headless)
  -> computeLayout(): walks doc, runs Pretext per block (cached via WeakMap)
  -> paintToCanvas(): iterates positioned lines, calls ctx.fillText()
  -> Hidden <textarea> captures input -> ProseMirror transactions -> re-render
```

The layout cache uses a `WeakMap` keyed on ProseMirror node identity (`===`). Unchanged blocks across transactions are reference-equal, so only the edited block pays the `prepareWithSegments` cost. This keeps typing latency flat regardless of document size.

## Accessibility

Canvas is a pixel buffer, so a naive canvas editor is **invisible to assistive technology** — the accessibility tree is empty. This is the defining a11y challenge of canvas/non-DOM editors (the same one Google Docs, Monaco, and CodeMirror all grapple with). Because our source of truth is a ProseMirror document, we follow the established patterns:

### What the editor does for you

- **Semantic DOM mirror** — a visually-hidden, screen-reader-visible copy of the document is serialized from your schema's `toDOM` (`<h1>`, `<p>`, `<ul><li>`, `<img alt>`, `<pre>`, …) and kept in sync on every change. Screen readers browse *that* for full document structure. Toggle with `a11yMirror`.
- **Hidden labelled input** — the canvas is `aria-hidden`; a hidden `<textarea>` (the same pattern Monaco/CodeMirror use) carries `role="textbox"`, `aria-multiline`, and your `ariaLabel`, and is moved to the caret so IME and magnifiers can track it.
- **Polite live region** — structural context (`Heading 2`, `Bullet list item`, `Code block`, `Between blocks`) is announced as the caret moves between block types. Call `editor.announce(message)` to voice your own events (e.g. a node view's result).
- **Full keyboard operability** — every action (navigation, lists `Tab`/`Shift-Tab`, the gap cursor, marks, code-block exit) works without a mouse, with no keyboard trap.
- **Reduced motion** — the caret stops blinking under `prefers-reduced-motion: reduce`.
- **Visible focus** — a focus ring is drawn while the editor holds focus.

### Inherent canvas limits (be aware when adopting)

- **Forced colors / Windows High Contrast** — the *visible* canvas text doesn't adapt to `forced-colors` (the mirror does, but the pixels you see won't).
- **User font scaling / reflow** (WCAG 1.4.4 / 1.4.10) — canvas text doesn't grow with browser/OS "200% text" settings; only pixel-zoom scales it. Expose a configurable base font size to your users.
- **Caret-following line-by-line reading** is partial — screen-reader *browse mode* reads the mirror; focus-mode line tracking on canvas is a hard, unsolved problem across all canvas editors.
- **Contrast** is partly yours: the editor draws on *your* background, so verify the default `textColor` / `firstLineColor` / `caretColor` hit WCAG AA (4.5:1) against it.

## Constraints

- **No DOM for text.** All text rendering goes through `ctx.fillText()`. No `<p>`, no `<span>`, no contenteditable.
- **No prosemirror-view.** ProseMirror manages the document model; rendering is entirely ours.
- **Font must be loaded before layout.** Always `await document.fonts.ready` before creating the editor.
- **Pretext is young** (released March 2026). Expect API changes. `system-ui` font causes measurement mismatches on macOS -- use named fonts like Inter.

## Dependencies

- [prosemirror-state](https://github.com/ProseMirror/prosemirror-state) / [prosemirror-model](https://github.com/ProseMirror/prosemirror-model) -- document model and transactions
- [@chenglou/pretext](https://github.com/chenglou/pretext) -- pure-TS text measurement and line breaking

## License

MIT
