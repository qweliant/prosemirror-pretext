/**
 * ============================================================================
 *  Canvas Editor — "Base One" Proof of Concept
 * ============================================================================
 *
 *  DATA PIPELINE:
 *
 *    ┌─────────────────────┐
 *    │  ProseMirror State  │   Headless document model (no DOM, no view).
 *    │  (prosemirror-state  │   Schema defines: doc → paragraph → text.
 *    │   + prosemirror-model)│   Populated with a hardcoded two-paragraph doc.
 *    └─────────┬───────────┘
 *              │
 *              │  extractBlocks()  — walks the document tree and pulls
 *              │  the text content out of each top-level block node.
 *              ▼
 *    ┌─────────────────────┐
 *    │  BlockEntry[]       │   An intermediate array of { type, text } objects
 *    │  (plain TS data)    │   that decouples the ProseMirror tree structure
 *    │                     │   from the layout engine's input format.
 *    └─────────┬───────────┘
 *              │
 *              │  computeLayout()  — feeds each block's text into Pretext's
 *              │  prepareWithSegments() + layoutWithLines() pipeline.
 *              ▼
 *    ┌─────────────────────┐
 *    │  BlockLayout[]      │   Spatial geometry for every block: its Y offset,
 *    │  (ready for canvas) │   total height, and the individual line objects
 *    │                     │   (text string, measured width, X/Y coords).
 *    └─────────────────────┘
 *              │
 *              ▼
 *        console.log()       (Base One stops here — canvas paint comes next.)
 *
 * ============================================================================
 */

import { Schema, type NodeSpec } from 'prosemirror-model'
import { EditorState } from 'prosemirror-state'
import { prepareWithSegments, layoutWithLines, type LayoutLine } from '@chenglou/pretext'


// ─── 1. Schema ──────────────────────────────────────────────────────────────
//
// A minimal ProseMirror schema with just the three node types needed for
// plain-text paragraphs. No marks, no inline images, no lists — yet.

const nodes: Record<string, NodeSpec> = {
    doc: { content: 'paragraph+' },
    paragraph: {
        content: 'text*',
        toDOM: () => ['p', 0],          // unused — we never mount a DOM view
        parseDOM: [{ tag: 'p' }],       // unused — included for schema completeness
    },
    text: { inline: true },
}

const schema = new Schema({ nodes })


// ─── 2. Hardcoded Document ──────────────────────────────────────────────────
//
// Two paragraphs of dummy content, long enough to force line-wrapping at
// reasonable container widths.

const doc = schema.node('doc', null, [
    schema.node('paragraph', null, [
        schema.text(
            'The browser\'s DOM was never designed for the kind of high - frequency layout ' +
'calculations a modern word processor demands. Every call to getBoundingClientRect ' +
    'triggers a synchronous reflow that blocks the main thread. By moving text measurement ' +
    'into pure arithmetic we can break free from this bottleneck entirely.'
    ),
  ]),
schema.node('paragraph', null, [
    schema.text(
        'Pretext gives us the missing primitive: a sub-millisecond layout engine that turns ' +
        'a string and a font spec into exact line geometry — widths, cursors, break positions — ' +
        'without ever touching the DOM. Combined with ProseMirror\'s battle - tested transaction ' +
      'model, this creates a pipeline where document edits flow through a headless state machine ' +
        'and emerge as pixel-ready paint instructions for an HTML5 Canvas.'
    ),
]),
])


// ─── 3. Headless EditorState ────────────────────────────────────────────────

const state = EditorState.create({ doc, schema })


// ─── 4. Block Extraction ────────────────────────────────────────────────────
//
// Walk the top-level children of the ProseMirror document and extract each
// block's text content.  This is the seam between ProseMirror's tree model
// and the flat list of strings that Pretext consumes.

interface BlockEntry
{
    /** The ProseMirror node type name, e.g. 'paragraph' */
    type: string
    /** The concatenated text content of the block */
    text: string
}

function extractBlocks(state: EditorState): BlockEntry[]
{
    const blocks: BlockEntry[] = []
    state.doc.forEach((node) =>
    {
        blocks.push({
            type: node.type.name,
            text: node.textContent,
        })
    })
    return blocks
}


// ─── 5. Layout Computation ──────────────────────────────────────────────────
//
// For each extracted block, run Pretext's two-phase pipeline:
//   1. prepareWithSegments()  — one-time segmentation + measurement (cold path)
//   2. layoutWithLines()      — pure-arithmetic line breaking  (hot path)
//
// The result is a fully resolved spatial map: every line's text, width,
// and Y coordinate, plus the block's aggregate height.

/** Typography constants — will later come from a theme/config layer */
const CONTAINER_WIDTH = 400    // px
const FONT = '16px Inter'
const LINE_HEIGHT = 24     // px
const BLOCK_GAP = 16     // px between paragraphs

interface LineLayout
{
    /** The text content of this wrapped line */
    text: string
    /** Pixel width of the line as measured by Pretext */
    width: number
    /** X offset (0 for LTR flush-left; will matter for centered/RTL later) */
    x: number
    /** Absolute Y position of this line's baseline within the virtual page */
    y: number
}

interface BlockLayout
{
    /** Source block type */
    type: string
    /** Source text (for debugging) */
    sourceText: string
    /** Absolute Y of the block's top edge */
    yOffset: number
    /** Total height consumed by this block (lines × lineHeight) */
    height: number
    /** The individual wrapped lines with their geometry */
    lines: LineLayout[]
}

function computeLayout(blocks: BlockEntry[]): BlockLayout[]
{
    const result: BlockLayout[] = []
    let cursorY = 0

    for (const block of blocks)
    {
        // Phase 1 — Prepare: segment the text and measure with canvas
        const prepared = prepareWithSegments(block.text, FONT)

        // Phase 2 — Layout: break into lines at the container width
        const { lines, height: blockTextHeight } = layoutWithLines(prepared, CONTAINER_WIDTH, LINE_HEIGHT)

        // Map each LayoutLine into our spatial LineLayout with absolute Y coords
        const mappedLines: LineLayout[] = lines.map((line: LayoutLine, i: number) => ({
            text: line.text,
            width: line.width,
            x: 0,                       // flush-left for now
            y: cursorY + i * LINE_HEIGHT,
        }))

        result.push({
            type: block.type,
            sourceText: block.text,
            yOffset: cursorY,
            height: blockTextHeight,
            lines: mappedLines,
        })

        // Advance the cursor past this block + the inter-block gap
        cursorY += blockTextHeight + BLOCK_GAP
    }

    return result
}


// ─── 6. Execute & Log ───────────────────────────────────────────────────────

const blocks = extractBlocks(state)
const layouts = computeLayout(blocks)

console.log('═══════════════════════════════════════════════════════════════')
console.log('  Canvas Editor — Base One: ProseMirror → Pretext Pipeline')
console.log('═══════════════════════════════════════════════════════════════')
console.log()
console.log(`Container width : ${CONTAINER_WIDTH}px`)
console.log(`Font            : ${FONT}`)
console.log(`Line height     : ${LINE_HEIGHT}px`)
console.log(`Block gap       : ${BLOCK_GAP}px`)
console.log(`Blocks extracted: ${blocks.length}`)
console.log()

for (const block of layouts)
{
    console.log(`┌─ ${block.type.toUpperCase()} ─────────────────────────────────────────`)
    console.log(`│  Y offset : ${block.yOffset}px`)
    console.log(`│  Height   : ${block.height}px`)
    console.log(`│  Lines    : ${block.lines.length}`)
    console.log('│')

    for (const line of block.lines)
    {
        const truncated = line.text.length > 60
            ? line.text.slice(0, 57) + '...'
            : line.text
        console.log(`│  [y=${String(line.y).padStart(3)}  w=${line.width.toFixed(1).padStart(6)}]  "${truncated}"`)
    }

    console.log('└──────────────────────────────────────────────────────────────')
    console.log()
}

console.log('Pipeline complete. Ready for canvas rendering phase.')