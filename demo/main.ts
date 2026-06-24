/**
 * Demo page — boots a CanvasEditor with marks (bold / italic / code), a
 * toolbar, and Cmd-B/I/` shortcuts, inside the dark "editor chrome" shell
 * defined in index.html.
 */

import { Schema, type NodeSpec, type MarkType } from 'prosemirror-model'
import { EditorState } from 'prosemirror-state'
import { toggleMark } from 'prosemirror-commands'
import { history, undo, redo } from 'prosemirror-history'
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

const link = (s: string, href: string) =>
    schema.text(s, [schema.marks['link'].create({ href })])

const colored = (s: string, color: string) =>
    schema.text(s, [schema.marks['textColor'].create({ color })])

const highlighted = (s: string, color?: string) =>
    schema.text(s, [schema.marks['highlight'].create(color ? { color } : null)])


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
        m('per-run fonts', 'strong'), m(' computed by hand. Built on '),
        link('Pretext', 'https://github.com/chenglou/pretext'),
        m(' — ⌘/Ctrl-click the link to open it. Runs can be '),
        colored('colored', '#f7768e'), m(' or '), highlighted('highlighted'),
        m(' too — even '), m('E=mc'), m('2', 'superscript'),
        m(' and H'), m('2', 'subscript'), m('O.'),
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

    // Link button: prompt for a URL to add, or strip an existing link.
    const linkType = schema.marks['link']
    const linkEl = document.createElement('button')
    linkEl.textContent = '🔗'
    linkEl.className = 'tb'
    linkEl.addEventListener('mousedown', (e) =>
    {
        e.preventDefault()
        const { from, to, empty } = editor.state.selection
        if (markActive(editor.state, linkType))
        {
            editor.command((state, dispatch) =>
            {
                dispatch?.(state.tr.removeMark(from, to, linkType))
                return true
            })
            return
        }
        if (empty) return // need a selection to wrap
        const href = window.prompt('Link URL:')
        if (href) editor.command(toggleMark(linkType, { href }))
    })
    wrap.appendChild(linkEl)
    buttons.push({ el: linkEl, type: linkType })

    // Highlight button: toggle a yellow highlight over the selection.
    const hlType = schema.marks['highlight']
    const hlEl = document.createElement('button')
    hlEl.textContent = '🖍'
    hlEl.className = 'tb'
    hlEl.addEventListener('mousedown', (e) =>
    {
        e.preventDefault()
        editor.command(toggleMark(hlType))
    })
    wrap.appendChild(hlEl)
    buttons.push({ el: hlEl, type: hlType })

    // Reflect the active marks at the caret/selection on every render.
    return () =>
    {
        for (const { el, type } of buttons)
        {
            el.classList.toggle('active', markActive(editor.state, type))
        }
    }
}

// ─── Bubble menu (floating toolbar over a selection) ─────────────────────────

function setupBubble(editor: CanvasEditor): () => void
{
    const bubble = document.createElement('div')
    bubble.className = 'bubble'
    const buttons: { el: HTMLButtonElement, type: MarkType }[] = []
    for (const [label, markName] of [['B', 'strong'], ['I', 'em'], ['</>', 'code']] as const)
    {
        const type = schema.marks[markName]
        const el = document.createElement('button')
        el.textContent = label
        el.className = 'tb'
        el.addEventListener('mousedown', (e) =>
        {
            e.preventDefault() // keep the selection
            editor.command(toggleMark(type))
        })
        bubble.appendChild(el)
        buttons.push({ el, type })
    }
    document.body.appendChild(bubble)

    // Reposition over the selection (or hide) on every render.
    return () =>
    {
        const rect = editor.selectionRect()
        if (!rect)
        {
            bubble.style.display = 'none'
            return
        }
        bubble.style.display = 'flex'
        for (const { el, type } of buttons)
        {
            el.classList.toggle('active', markActive(editor.state, type))
        }
        const cx = (rect.left + rect.right) / 2
        bubble.style.left = `${Math.round(cx - bubble.offsetWidth / 2)}px`
        bubble.style.top = `${Math.round(Math.max(8, rect.top - bubble.offsetHeight - 8))}px`
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
    let syncBubble: () => void = () => {}

    const editor = new CanvasEditor({
        state: EditorState.create({ doc, schema, plugins: [history()] }),
        container,
        keymap: {
            ...buildMarkKeymap(schema),
            'Mod-z': undo,
            'Mod-y': redo,
            'Shift-Mod-z': redo,
        },
        onRender(stats)
        {
            statusEl.textContent =
                `${stats.blockCount} blocks · ${stats.lineCount} lines · ` +
                `cache ${stats.cacheHits}H/${stats.cacheMisses}M · ` +
                `${stats.renderTimeMs.toFixed(1)}ms`
            syncToolbar()
            syncBubble()
        },
    })

    syncToolbar = buildToolbar(editor)
    syncBubble = setupBubble(editor)
    syncToolbar()
    syncBubble()
    setupFloat(editor)
    editor.focus()

    ;(window as any).editor = editor
}

// ─── Draggable float ─────────────────────────────────────────────────────────

const CONTENT_WIDTH = 460
const CANVAS_PAD = 40

function setupFloat(editor: CanvasEditor): void
{
    const wrap = document.querySelector('.canvas-wrap') as HTMLElement
    const box = document.createElement('div')
    box.className = 'float-box'
    box.textContent = 'float — drag me'
    wrap.appendChild(box)

    // Content-space rect; text flows around it.
    const f = { x: 250, y: 34, width: 190, height: 132 }
    const place = () =>
    {
        box.style.left = `${CANVAS_PAD + f.x}px`
        box.style.top = `${CANVAS_PAD + f.y}px`
        box.style.width = `${f.width}px`
        box.style.height = `${f.height}px`
        editor.setFloats([{ ...f }])
    }
    place()

    let drag: { sx: number, sy: number, fx: number, fy: number } | null = null
    box.addEventListener('pointerdown', (e) =>
    {
        e.preventDefault()
        box.setPointerCapture(e.pointerId)
        drag = { sx: e.clientX, sy: e.clientY, fx: f.x, fy: f.y }
    })
    box.addEventListener('pointermove', (e) =>
    {
        if (!drag) return
        f.x = Math.max(0, Math.min(CONTENT_WIDTH - f.width, drag.fx + (e.clientX - drag.sx)))
        f.y = Math.max(0, drag.fy + (e.clientY - drag.sy))
        place()
    })
    const end = (e: PointerEvent) =>
    {
        drag = null
        box.releasePointerCapture(e.pointerId)
    }
    box.addEventListener('pointerup', end)
    box.addEventListener('pointercancel', end)
}

boot()
