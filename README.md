# Pretext Canvas Editor

A custom text rendering pipeline that completely decouples text layout from the browser DOM. By combining ProseMirror (data model), Pretext (layout math), and an HTML5 Canvas (renderer), this project treats text layout as a geometric data model.

If a Universal Node knows its own geometric layout *before* it touches the screen, you unlock the architecture that powers infinite-canvas tools like Figma, Muse, and Obsidian Canvas. You are no longer constrained by vertical web scrolling; you can build spatial, zoomable knowledge graphs where text natively routes around other nodes.

## The Architecture

The system is built on a strict, isolated pipeline to separate state, layout math, and paint:

1. **The State (ProseMirror):** Owns the document tree, history, and schema. No DOM manipulation allowed.
2. **The Math (Pretext):** Measures the ProseMirror tree and calculates exact X/Y coordinates, line breaks, and bounding boxes for every character and block using a system font baseline.
3. **The Paint (Canvas):** A HiDPI canvas renderer that waits for `document.fonts.ready` (to prevent scrambled rendering from font-loading mismatches) and paints the calculated geometry using Inter.

## Current Status: Base Two (Static Render)

Currently, the engine successfully executes "Base Two": rendering a static painting of a document from console logs to a HiDPI canvas with a debug overlay. 

- ✅ ProseMirror tree isolation
- ✅ Pretext geometric layout math
- ✅ HiDPI Canvas rendering
- ✅ Font-loading synchronization

## The Next Boss Fight: Base Three (Interactivity)

To make this feel like a text editor again, the next phase is building the two-way street between the Canvas (where the user clicks) and ProseMirror (where the text actually lives):

1. **The Hidden Text Area (The Proxy):** Floating an invisible `<textarea>` over the canvas to intercept native browser events (typing, pasting, mobile autocorrect) and firing `view.dispatch(tr.insertText(...))` to update the ProseMirror state.
2. **Canvas to ProseMirror (`posAtCoords`):** Mapping a mouse click at `(X: 150, Y: 300)` by looping through the `BlockLayout[]` array to find the exact character index, then telling ProseMirror to set the cursor selection.
3. **ProseMirror to Canvas (`coordsAtPos`):** Translating a ProseMirror state update (e.g., cursor moved to position 42) back to the canvas renderer to draw a blinking blue line at the exact X/Y coordinate.

## Author

Qwelian Tanner — [qwelian.com](https://www.qwelian.com)
