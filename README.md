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
})
```

The container element should be an empty block-level element. The editor creates a `<canvas>` and a hidden `<textarea>` (for input/IME) inside it.

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
- [x] Arrow key navigation (left/right, home/end)
- [ ] Enter key / paragraph splitting
- [ ] Arrow up/down (line-aware vertical movement)
- [ ] Selection rendering
- [ ] Scroll virtualization
- [ ] Marks (bold, italic, code)
- [ ] Variable-width layout (text around floated elements)

## Architecture

```
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
