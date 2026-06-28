/**
 * The live editor embedded on the docs site. It doubles as a compact usage
 * example: a small schema, a sample doc, a toolbar, and one CanvasEditor.
 */
import { Schema, type NodeSpec, type MarkType, type Node as PMNode } from 'prosemirror-model'
import { EditorState, type Command } from 'prosemirror-state'
import { toggleMark, setBlockType } from 'prosemirror-commands'
import { history, undo, redo } from 'prosemirror-history'
import { wrapInList, liftListItem } from 'prosemirror-schema-list'
import { CanvasEditor, markSpecs, buildMarkKeymap } from '../src'

const EDITOR_FONT = '17px "M PLUS Rounded 1c", system-ui, sans-serif'

// ── Schema ──────────────────────────────────────────────────────────────────
const nodes: Record<string, NodeSpec> = {
    doc: { content: '(heading | paragraph | bullet_list | image)+' },
    paragraph: {
        content: 'text*',
        attrs: { align: { default: null } },
        toDOM: (n) => ['p', n.attrs['align'] ? { style: `text-align:${n.attrs['align']}` } : {}, 0],
        parseDOM: [{ tag: 'p' }],
    },
    heading: {
        content: 'text*', group: 'block', attrs: { level: { default: 1 } },
        toDOM: (n) => [`h${n.attrs['level']}`, 0],
        parseDOM: [1, 2, 3].map((l) => ({ tag: `h${l}`, attrs: { level: l } })),
    },
    bullet_list: {
        content: 'list_item+', group: 'block',
        toDOM: () => ['ul', 0], parseDOM: [{ tag: 'ul' }],
    },
    list_item: {
        content: 'paragraph block*', defining: true,
        toDOM: () => ['li', 0], parseDOM: [{ tag: 'li' }],
    },
    image: {
        atom: true, group: 'block',
        attrs: { src: {}, alt: { default: '' }, width: { default: null }, x: { default: null }, y: { default: null } },
        toDOM: (n) => ['img', { src: n.attrs['src'], alt: n.attrs['alt'] }],
        parseDOM: [{ tag: 'img[src]', getAttrs: (d) => ({ src: (d as HTMLElement).getAttribute('src'), alt: '' }) }],
    },
    text: { inline: true },
}
const schema = new Schema({ nodes, marks: markSpecs })

const m = (s: string, ...marks: string[]) => schema.text(s, marks.map((n) => schema.marks[n].create()))
const li = (text: string) => schema.node('list_item', null, [schema.node('paragraph', null, [schema.text(text)])])
const swatch = (c: string) =>
    `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="180" height="120"><rect width="180" height="120" rx="14" fill="${c}"/><circle cx="56" cy="52" r="20" fill="#fff"/><circle cx="104" cy="52" r="20" fill="#fff"/><circle cx="56" cy="54" r="8" fill="#1b1b1b"/><circle cx="104" cy="54" r="8" fill="#1b1b1b"/><path d="M58 84 q32 26 64 0" stroke="#1b1b1b" stroke-width="5" fill="none" stroke-linecap="round"/></svg>`)}`

const doc = schema.node('doc', null, [
    schema.node('heading', { level: 1 }, [schema.text('hello from the pond 🐸')]),
    schema.node('paragraph', null, [
        m('This whole editor is painted on a '), m('<canvas>', 'code'),
        m(' — no contenteditable. Select text and hit '), m('B', 'code'), m(' / '), m('I', 'code'),
        m(' / the toolbar. Drag the frog image to float it and watch the text wrap around. '),
        m('Try it!', 'strong'),
    ]),
    schema.node('image', { src: swatch('#7ec14b'), alt: 'a friendly frog', x: 0, y: 70, width: 180 }),
    schema.node('paragraph', null, [
        m('Lists, headings, marks, links, blockquotes, code blocks, alignment, gap cursors, and a screen-reader mirror all work. The document is a real ProseMirror doc with real transactions and undo/redo — we only replaced the view layer.'),
    ]),
    schema.node('bullet_list', null, [
        li('pure-arithmetic line breaking (Pretext)'),
        li('float-wrap around images'),
        li('keyboard-first, a11y-minded'),
    ]),
])

// ── Toolbar ───────────────────────────────────────────────────────────────
function markActive(state: EditorState, type: MarkType): boolean {
    const { from, $from, to, empty } = state.selection
    return empty ? !!type.isInSet(state.storedMarks || $from.marks()) : state.doc.rangeHasMark(from, to, type)
}
function blockActive(state: EditorState, name: string, attrs?: Record<string, unknown>): boolean {
    return state.selection.$from.parent.hasMarkup(schema.nodes[name], attrs as any)
}
function toggleBlock(name: string, attrs?: Record<string, unknown>): Command {
    return (state, dispatch) => {
        const active = blockActive(state, name, attrs)
        return setBlockType(active ? schema.nodes['paragraph'] : schema.nodes[name], active ? undefined : attrs)(state, dispatch)
    }
}
function inList(state: EditorState): boolean {
    const $f = state.selection.$from
    for (let d = $f.depth; d > 0; d--) if ($f.node(d).type === schema.nodes['bullet_list']) return true
    return false
}

async function boot(): Promise<void> {
    await document.fonts.ready
    await new Promise((r) => setTimeout(r, 60))

    let sync = () => {}
    const editor = new CanvasEditor({
        state: EditorState.create({ doc, schema, plugins: [history()] }),
        container: document.getElementById('editor-embed')!,
        width: 600,
        font: EDITOR_FONT,
        ariaLabel: 'prosemirror-pretext live demo',
        keymap: { ...buildMarkKeymap(schema), 'Mod-z': undo, 'Mod-y': redo, 'Shift-Mod-z': redo },
        nodeViews: { image: imageView },
        floatRect: (n) => n.type.name === 'image' && n.attrs['x'] != null
            ? { x: n.attrs['x'], y: n.attrs['y'], width: n.attrs['width'] ?? 180 } : null,
        onRender: () => sync(),
    })
    ;(window as any).editor = editor

    const bar = document.getElementById('embed-toolbar')!
    const marks: { el: HTMLButtonElement, on: () => boolean }[] = []
    const add = (label: string, cmd: Command, on: () => boolean) => {
        const el = document.createElement('button')
        el.className = 'tb'
        el.textContent = label
        el.addEventListener('mousedown', (e) => { e.preventDefault(); editor.command(cmd) })
        bar.appendChild(el)
        marks.push({ el, on })
    }
    const sep = () => { const s = document.createElement('span'); s.className = 'sep'; bar.appendChild(s) }

    add('B', toggleMark(schema.marks['strong']), () => markActive(editor.state, schema.marks['strong']))
    add('I', toggleMark(schema.marks['em']), () => markActive(editor.state, schema.marks['em']))
    add('</>', toggleMark(schema.marks['code']), () => markActive(editor.state, schema.marks['code']))
    sep()
    add('H1', toggleBlock('heading', { level: 1 }), () => blockActive(editor.state, 'heading', { level: 1 }))
    add('H2', toggleBlock('heading', { level: 2 }), () => blockActive(editor.state, 'heading', { level: 2 }))
    add('• List', (s, d) => inList(s) ? liftListItem(schema.nodes['list_item'])(s, d) : wrapInList(schema.nodes['bullet_list'])(s, d), () => inList(editor.state))
    sep()
    add('↩︎', undo, () => false)
    add('↪︎', redo, () => false)

    sync = () => { for (const { el, on } of marks) el.classList.toggle('active', on()) }
    sync()
    editor.focus()
}

// A draggable image node view: drag the body to float it; text wraps around it.
function imageView(node: PMNode, getPos: () => number): HTMLElement {
    const wrap = document.createElement('div')
    wrap.style.cssText = 'position:relative;display:inline-block;max-width:100%'
    const img = document.createElement('img')
    img.src = node.attrs['src'] as string
    img.alt = (node.attrs['alt'] as string) ?? ''
    img.style.cssText = 'display:block;max-width:100%;border-radius:12px;cursor:grab'
    if (node.attrs['width']) img.style.width = `${node.attrs['width']}px`
    wrap.appendChild(img)
    img.addEventListener('pointerdown', (e) => {
        e.preventDefault()
        img.setPointerCapture(e.pointerId)
        const ed = (window as any).editor as CanvasEditor
        const cr = ((ed as any).canvas as HTMLCanvasElement).getBoundingClientRect()
        const wr = wrap.getBoundingClientRect()
        const x0 = wr.left - cr.left, y0 = wr.top - cr.top, sx = e.clientX, sy = e.clientY
        let dx = 0, dy = 0
        const move = (ev: PointerEvent) => { dx = ev.clientX - sx; dy = ev.clientY - sy; wrap.style.transform = `translate(${dx}px,${dy}px)` }
        const up = (ev: PointerEvent) => {
            img.releasePointerCapture(ev.pointerId)
            wrap.removeEventListener('pointermove', move); wrap.removeEventListener('pointerup', up)
            wrap.style.transform = ''
            if (dx === 0 && dy === 0) return
            ed.command((s, d) => { d?.(s.tr.setNodeMarkup(getPos(), undefined, { ...node.attrs, x: Math.max(0, Math.round(x0 + dx)), y: Math.max(0, Math.round(y0 + dy)), width: node.attrs['width'] ?? 180 })); return true })
        }
        wrap.addEventListener('pointermove', move); wrap.addEventListener('pointerup', up)
    })
    return wrap
}

boot()
