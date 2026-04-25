/**
 * Demo page — boots a CanvasEditor with sample content inside the
 * dark "editor chrome" shell defined in index.html.
 */

import { Schema, type NodeSpec } from 'prosemirror-model'
import { EditorState } from 'prosemirror-state'
import { CanvasEditor } from '../src'


// ─── Schema ────────────────────────────────────────────────────────────────

const nodes: Record<string, NodeSpec> = {
    doc: { content: 'paragraph+' },
    paragraph: {
        content: 'text*',
        toDOM: () => ['p', 0],
        parseDOM: [{ tag: 'p' }],
    },
    text: { inline: true },
}

const schema = new Schema({ nodes })


// ─── Sample Document ───────────────────────────────────────────────────────

const doc = schema.node('doc', null, [
    schema.node('paragraph', null, [
        schema.text(
            "The browser's DOM was never designed for the kind of high-frequency layout " +
            'calculations a modern word processor demands. Every call to getBoundingClientRect ' +
            'triggers a synchronous reflow that blocks the main thread. By moving text measurement ' +
            'into pure arithmetic we can break free from this bottleneck entirely.'
        ),
    ]),
    schema.node('paragraph', null, [
        schema.text(
            'Pretext gives us the missing primitive: a sub-millisecond layout engine that turns ' +
            'a string and a font spec into exact line geometry — widths, cursors, break positions — ' +
            "without ever touching the DOM. Combined with ProseMirror's battle-tested transaction " +
            'model, this creates a pipeline where document edits flow through a headless state machine ' +
            'and emerge as pixel-ready paint instructions for an HTML5 Canvas.'
        ),
    ]),
    schema.node('paragraph', null, [
        schema.text(
            'Try it: click anywhere in this paragraph, type, hit backspace, use the arrow keys. ' +
            'Every keystroke flows through a ProseMirror transaction, only the changed block re-runs ' +
            'Pretext segmentation, and the entire canvas repaints in well under a millisecond.'
        ),
    ]),
])


// ─── Boot ──────────────────────────────────────────────────────────────────

async function boot(): Promise<void>
{
    const container = document.getElementById('editor-container')!
    const statusEl = document.getElementById('status-info')!

    statusEl.textContent = 'Loading font...'
    await document.fonts.ready
    await new Promise((r) => setTimeout(r, 50))

    const editor = new CanvasEditor({
        state: EditorState.create({ doc, schema }),
        container,
        maxHeight: 480,
        onRender(stats)
        {
            statusEl.textContent =
                `${stats.blockCount} blocks · ${stats.lineCount} lines · ` +
                `cache ${stats.cacheHits}H/${stats.cacheMisses}M · ` +
                `${stats.renderTimeMs.toFixed(1)}ms`
        },
    })

    editor.focus()

    console.log('Canvas Editor — Demo')
    console.log('  Type to edit. Arrow keys / click to move. Shift-arrow / drag to select.')
    console.log('  Enter splits; Backspace at block start joins; Home/End jump to line ends.')

    // Expose for console debugging
    ;(window as any).editor = editor
}

boot()
