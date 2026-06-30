# Latency bench: prosemirror-view (DOM) vs prosemirror-pretext (canvas)

A fair, reproducible micro-benchmark. Both editors use the **same**
`prosemirror-state`/`prosemirror-model` document and transactions; only the view
layer differs:

- **Editor A** — `prosemirror-view` → contenteditable DOM
- **Editor B** — `prosemirror-pretext` → `<canvas>`

## Run it

```sh
bun install
bun run bench                 # 1x, 4x, 6x CPU throttle; writes results.json + results.svg
KEYSTROKES=300 THROTTLE=1,6 bun run bench
CHROME_PATH=/path/to/chrome bun run bench   # if auto-detection misses your browser
bun run dev:bench             # open the page and click "Run" by hand
```

It boots the Vite bench page, drives `window.__bench.run()` in a real Chromium
under CDP CPU throttling (the architectural costs in DOM relayout only surface on
a realistically slow machine — a fast laptop hides them), and writes a table +
bar chart.

## The metric

Per keystroke, the synchronous cost of **edit → relayout → read caret**. Every
real rich-text editor with a bubble menu, slash command, or collab cursor asks
"where is the caret in pixels?" on every keystroke:

- DOM: `view.coordsAtPos()` → `range.getBoundingClientRect()`, which forces
  synchronous layout after the edit's DOM mutation.
- Canvas: `editor.coordsAtPos()` lazily recomputes the dirty layout (arithmetic,
  WeakMap-cached per block) and reads it back — no browser layout, no paint in
  the read path.

Four scenarios: simple vs structurally complex document × caret-read off vs on.

## What it shows

Two things, and the honest order matters:

**1. At ordinary document sizes, it's a tie.** For a few hundred blocks, both
editors answer in well under a millisecond — often below the timer's resolution.
The browser's incremental layout is genuinely excellent, and you do not need a
canvas editor to type fast into a short document. Say so.

**2. The read-after-write tax is real, and it scales with document size.** Run
the document-size sweep (`results-sweep.svg`). Typing in the middle of the
document and reading the caret each keystroke — what every editor with a bubble
menu / slash command / collab cursor does — the DOM grows **linearly** (a forced
relayout whose cost tracks the document), while the canvas stays **flat**:

| blocks | DOM | canvas | speedup |
|--:|--:|--:|--:|
| 200 | 0.1ms | 0.1ms | tie |
| 800 | 1.1ms | 0.1ms | 11× |
| 3200 | 3.8ms | 0.5ms | 8× |
| 8000 | 9.8ms | 0.9ms | 11× |

(6× CPU throttle; your numbers vary by machine — that's why it's reproducible.)

The flat line is not free. It took six optimizations — several of which this
benchmark *exposed as bugs* — to get there:

1. `coordsAtPos` was calling `getBoundingClientRect` on every read → a forced
   reflow. Now the canvas rect is cached.
2. Caret reads forced a full repaint. Now layout is lazy and paint-free.
3. Per-keystroke layout re-allocated every block. Now positioned blocks are
   cached and reused.
4. Layout re-walked the whole document each edit. Now a single-block edit
   rebuilds one block and shifts the rest's scalar positions (incremental).
5. `coordsAtPos` linearly scanned all blocks to find the caret. Now it's a
   binary search — O(log n).
6. The accessibility DOM mirror re-serialized the whole document every
   keystroke. Now it updates only the block that changed.

The takeaway: **the browser is great at typing; the canvas's edge is that its
per-keystroke cost is decoupled from document size and CSS complexity.** On top
of that it buys capabilities CSS can't (magazine float-wrap on both sides, no
contenteditable quirks, deterministic frames). This benchmark exists to keep
both halves of that claim honest.
