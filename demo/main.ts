/**
 * Demo page — boots a CanvasEditor with marks (bold / italic / code), a
 * toolbar, and Cmd-B/I/` shortcuts, inside the dark "editor chrome" shell
 * defined in index.html.
 */

import { Schema, type NodeSpec, type MarkType } from 'prosemirror-model'
import { EditorState } from 'prosemirror-state'
import { toggleMark } from 'prosemirror-commands'
import { CanvasEditor, markSpecs, buildMarkKeymap } from '../src'


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

const schema = new Schema({ nodes, marks: markSpecs })

const m = (s: string, ...names: string[]) =>
    schema.text(s, names.map((n) => schema.marks[n].create()))


// ─── Sample Document ───────────────────────────────────────────────────────

const doc = schema.node('doc', null, [
    schema.node('paragraph', null, [
        m('Every glyph here is placed by '), m('ctx.fillText()', 'code'),
        m(' on a canvas — no contenteditable, no DOM text nodes. '),
        m('ProseMirror', 'strong'), m(' owns the document model, '),
        m('Pretext', 'strong'), m(' owns the layout, and the rendering is '),
        m('entirely ours', 'em'), m('.'),
    ]),
    schema.node('paragraph', null, [
        m('Select some text and hit '), m('B', 'code'), m(', '), m('I', 'code'),
        m(', or '), m('`', 'code'),
        m(' — or use the toolbar. Marks flow through real ProseMirror '),
        m('transactions', 'em'),
        m(', re-segment only the edited block, and repaint to canvas with '),
        m('per-run fonts', 'strong'), m(' computed by hand.'),
    ]),
])


// ─── Toolbar ─────────────────────────────────────────────────────────────────

function markActive(state: EditorState, type: MarkType): boolean
{
    const { from, $from, to, empty } = state.selection
    return empty
        ? !!type.isInSet(state.storedMarks || $from.marks())
        : state.doc.rangeHasMark(from, to, type)
}

function buildToolbar(editor: CanvasEditor): () => void
{
    const wrap = document.getElementById('toolbar')!
    const buttons: { el: HTMLButtonElement, type: MarkType }[] = []
    const defs: [string, string][] = [['B', 'strong'], ['I', 'em'], ['</>', 'code']]

    for (const [label, markName] of defs)
    {
        const type = schema.marks[markName]
        const el = document.createElement('button')
        el.textContent = label
        el.className = 'tb'
        el.addEventListener('mousedown', (e) =>
        {
            e.preventDefault() // keep editor focus / selection
            editor.command(toggleMark(type))
        })
        wrap.appendChild(el)
        buttons.push({ el, type })
    }

    // Reflect the active marks at the caret/selection on every render.
    return () =>
    {
        for (const { el, type } of buttons)
        {
            el.classList.toggle('active', markActive(editor.state, type))
        }
    }
}


// ─── Boot ──────────────────────────────────────────────────────────────────

async function boot(): Promise<void>
{
    const container = document.getElementById('editor-container')!
    const statusEl = document.getElementById('status-info')!

    statusEl.textContent = 'Loading font...'
    await document.fonts.ready
    await new Promise((r) => setTimeout(r, 50))

    let syncToolbar: () => void = () => {}

    const editor = new CanvasEditor({
        state: EditorState.create({ doc, schema }),
        container,
        maxHeight: 480,
        keymap: buildMarkKeymap(schema),
        onRender(stats)
        {
            statusEl.textContent =
                `${stats.blockCount} blocks · ${stats.lineCount} lines · ` +
                `cache ${stats.cacheHits}H/${stats.cacheMisses}M · ` +
                `${stats.renderTimeMs.toFixed(1)}ms`
            syncToolbar()
        },
    })

    syncToolbar = buildToolbar(editor)
    syncToolbar()
    editor.focus()

    ;(window as any).editor = editor
}

boot()
