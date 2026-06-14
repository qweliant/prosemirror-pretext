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
| `markStyles` | bold/italic/code defaults | Maps mark names → `{ fontWeight, fontStyle, fontFamily, color }` |
| `keymap` | `{}` | ProseMirror key bindings, checked before built-in keys |
| `onRender` | — | Called after every render with cache + timing stats |

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

## Demo

```bash
bun install
bun run dev
```

## Current State

Actively being built. Not yet published to npm.

- [x] Headless ProseMirror state (`doc > paragraph+ > text*`)
- [x] Pretext-powered layout (segmentation, line breaking, positioning)
- [x] Canvas rendering with HiDPI support
- [x] Live editing via hidden textarea overlay
- [x] IME composition support (CJK input methods)
- [x] Incremental layout cache (only changed blocks re-segment)
- [x] Caret rendering with blink
- [x] Click-to-position
- [x] Arrow key navigation (left/right, home/end, up/down with phantom X)
- [x] Enter key / paragraph splitting
- [x] Backspace joins adjacent paragraphs at block start
- [x] Selection rendering (shift+arrows, shift+click, mouse drag)
- [x] Scroll container with `ensureCaretVisible`
- [x] Scroll virtualization (viewport-sized canvas + spatial index)
- [x] Marks (bold, italic, code) — per-run fonts via Pretext rich-inline, with toggling keymap
- [x] Double-click word selection + clipboard copy/cut
- [x] Undo / redo via `prosemirror-history`
- [ ] Variable-width layout (text around floated elements)

## Architecture

```text
ProseMirror EditorState (headless)
  -> computeLayout(): walks doc, runs Pretext per block (cached via WeakMap)
  -> paintToCanvas(): iterates positioned lines, calls ctx.fillText()
  -> Hidden <textarea> captures input -> ProseMirror transactions -> re-render
```

The layout cache uses a `WeakMap` keyed on ProseMirror node identity (`===`). Unchanged blocks across transactions are reference-equal, so only the edited block pays the `prepareWithSegments` cost. This keeps typing latency flat regardless of document size.

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
