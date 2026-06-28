/**
 * The live editor embedded on the docs site — a full-featured showcase that
 * doubles as a usage example: schema, sample doc, toolbar, render stats, a
 * screen-reader-mirror peek, and a read-only toggle.
 */
import { Schema, type NodeSpec, type MarkType, type Node as PMNode } from 'prosemirror-model'
import { EditorState, type Command } from 'prosemirror-state'
import { toggleMark, setBlockType } from 'prosemirror-commands'
import { history, undo, redo } from 'prosemirror-history'
import { wrapInList, liftListItem } from 'prosemirror-schema-list'
import { CanvasEditor, markSpecs, buildMarkKeymap, Decoration, type RenderStats, type Decoration as Deco } from '../src'

const EDITOR_FONT = '17px "M PLUS Rounded 1c", system-ui, sans-serif'
const photo = (seed: string, w: number, h: number) => `https://picsum.photos/seed/${seed}/${w}/${h}`

// ── Schema (the full set of node types the editor supports) ──────────────────
const nodes: Record<string, NodeSpec> = {
    doc: { content: '(heading | paragraph | blockquote | code_block | horizontal_rule | bullet_list | ordered_list | image)+' },
    paragraph: {
        content: 'text*', attrs: { align: { default: null } },
        toDOM: (n) => ['p', n.attrs['align'] ? { style: `text-align:${n.attrs['align']}` } : {}, 0],
        parseDOM: [{ tag: 'p', getAttrs: (d) => ({ align: (d as HTMLElement).style.textAlign || null }) }],
    },
    heading: {
        content: 'text*', group: 'block', attrs: { level: { default: 1 }, align: { default: null } },
        toDOM: (n) => [`h${n.attrs['level']}`, n.attrs['align'] ? { style: `text-align:${n.attrs['align']}` } : {}, 0],
        parseDOM: [1, 2, 3].map((l) => ({ tag: `h${l}`, getAttrs: (d) => ({ level: l, align: (d as HTMLElement).style.textAlign || null }) })),
    },
    blockquote: { content: 'text*', group: 'block', toDOM: () => ['blockquote', 0], parseDOM: [{ tag: 'blockquote' }] },
    code_block: { content: 'text*', group: 'block', marks: '', code: true, toDOM: () => ['pre', ['code', 0]], parseDOM: [{ tag: 'pre', preserveWhitespace: 'full' }] },
    horizontal_rule: { group: 'block', toDOM: () => ['hr'], parseDOM: [{ tag: 'hr' }] },
    ordered_list: { content: 'list_item+', group: 'block', attrs: { order: { default: 1 } }, toDOM: () => ['ol', 0], parseDOM: [{ tag: 'ol' }] },
    bullet_list: { content: 'list_item+', group: 'block', toDOM: () => ['ul', 0], parseDOM: [{ tag: 'ul' }] },
    list_item: { content: 'paragraph block*', defining: true, toDOM: () => ['li', 0], parseDOM: [{ tag: 'li' }] },
    image: {
        atom: true, group: 'block',
        attrs: { src: {}, alt: { default: '' }, width: { default: null }, x: { default: null }, y: { default: null } },
        toDOM: (n) => ['img', { src: n.attrs['src'], alt: n.attrs['alt'] }],
        parseDOM: [{ tag: 'img[src]', getAttrs: (d) => ({ src: (d as HTMLElement).getAttribute('src'), alt: (d as HTMLElement).getAttribute('alt') ?? '' }) }],
    },
    text: { inline: true },
}
const schema = new Schema({ nodes, marks: markSpecs })

const m = (s: string, ...marks: string[]) => schema.text(s, marks.map((n) => schema.marks[n].create()))
const link = (s: string, href: string) => schema.text(s, [schema.marks['link'].create({ href })])
const colored = (s: string, color: string) => schema.text(s, [schema.marks['textColor'].create({ color })])
const hl = (s: string) => schema.text(s, [schema.marks['highlight'].create(null)])
const li = (...inline: PMNode[]) => schema.node('list_item', null, [schema.node('paragraph', null, inline)])
const liNest = (text: string, nested: PMNode) => schema.node('list_item', null, [schema.node('paragraph', null, [schema.text(text)]), nested])

const doc = schema.node('doc', null, [
    schema.node('heading', { level: 1 }, [schema.text('hello from the pond 🐸')]),
    schema.node('image', { src: photo('pondlily', 220, 150), alt: 'a calm pond', x: 0, y: 120, width: 220 }),
    schema.node('paragraph', null, [
        m('Every glyph here is painted by '), m('ctx.fillText()', 'code'),
        m(' — no contenteditable. The photo to the left is a real '), m('image node', 'em'),
        m(' you can drag: move its body to float it (text wraps), or drag its corner to resize. Select any text and use the toolbar — '),
        m('bold', 'strong'), m(', '), m('italic', 'em'), m(', '), m('underline', 'underline'),
        m(', '), m('strikethrough', 'strikethrough'), m(', '), colored('color', '#e0488a'),
        m(', '), hl('highlight'), m(', E=mc'), m('2', 'superscript'), m(', H'), m('2', 'subscript'),
        m('O, and '), link('links', 'https://github.com/qweliant/prosemirror-pretext'), m('.'),
    ]),
    schema.node('paragraph', { align: 'center' }, [m('…and paragraphs can be centered.')]),
    schema.node('blockquote', null, [schema.text('Block styles are pure arithmetic: padding, a left bar, a background panel — all measured and painted by hand.')]),
    schema.node('code_block', null, [schema.text('ctx.fillText(line.text, line.x, line.y)\n// every glyph, placed by hand')]),
    schema.node('horizontal_rule'),
    schema.node('bullet_list', null, [
        li(m('Nested lists with markers + indent')),
        liNest('Press Tab to nest, Shift-Tab to lift', schema.node('bullet_list', null, [
            li(m('a deeper bullet')),
            li(m('each level adds its own gutter')),
        ])),
    ]),
    schema.node('ordered_list', null, [li(m('ordered items')), li(m('count up')), li(m('one, two, three'))]),
    schema.node('paragraph', null, [
        m('There are two images — drag this one around too. Between any two stacked images you can place a '),
        m('gap cursor', 'em'), m(' (click the seam or arrow to it) and press Enter to slot a paragraph in.'),
    ]),
    schema.node('image', { src: photo('frogleaf', 260, 150), alt: 'a green leaf' }),
])

// ── Commands / helpers ──────────────────────────────────────────────────────
const markActive = (s: EditorState, t: MarkType) => {
    const { from, $from, to, empty } = s.selection
    return empty ? !!t.isInSet(s.storedMarks || $from.marks()) : s.doc.rangeHasMark(from, to, t)
}
const blockActive = (s: EditorState, name: string, attrs?: any) => s.selection.$from.parent.hasMarkup(schema.nodes[name], attrs)
const toggleBlock = (name: string, attrs?: any): Command => (s, d) =>
    setBlockType(blockActive(s, name, attrs) ? schema.nodes['paragraph'] : schema.nodes[name], blockActive(s, name, attrs) ? undefined : attrs)(s, d)
const inList = (s: EditorState, name: string) => {
    const $f = s.selection.$from
    for (let i = $f.depth; i > 0; i--) if ($f.node(i).type === schema.nodes[name]) return true
    return false
}
const toggleList = (name: string): Command => (s, d) =>
    inList(s, name) ? liftListItem(schema.nodes['list_item'])(s, d) : wrapInList(schema.nodes[name])(s, d)
const setAlign = (align: string | null): Command => (s, d) => {
    const { from, to } = s.selection; let tr = s.tr; let any = false
    s.doc.nodesBetween(from, to, (n, pos) => { if (n.isTextblock && n.type.spec.attrs?.['align']) { tr = tr.setNodeMarkup(pos, undefined, { ...n.attrs, align }); any = true } })
    if (any) d?.(tr); return any
}
const insertHr: Command = (s, d) => { d?.(s.tr.replaceSelectionWith(schema.nodes['horizontal_rule'].create()).scrollIntoView()); return true }
const insertImage: Command = (s, d) => { d?.(s.tr.replaceSelectionWith(schema.nodes['image'].create({ src: photo('pic' + Date.now(), 240, 150) })).scrollIntoView()); return true }
const linkCmd: Command = (s, d) => {
    const { from, to, empty } = s.selection, t = schema.marks['link']
    if (markActive(s, t)) { d?.(s.tr.removeMark(from, to, t)); return true }
    if (empty) return false
    const href = window.prompt('Link URL:'); if (!href) return false
    return toggleMark(t, { href })(s, d)
}

async function boot(): Promise<void> {
    await document.fonts.ready
    await new Promise((r) => setTimeout(r, 60))

    let sync = () => {}
    let query = ''
    const statsEl = document.getElementById('render-stats')!
    const peek = document.getElementById('mirror-peek') as HTMLElement

    // Search highlight: inline decorations over every match (not in the doc).
    const searchDecos = (state: EditorState): Deco[] => {
        if (!query) return []
        const decos: Deco[] = []
        const q = query.toLowerCase()
        state.doc.descendants((node, pos) => {
            if (!node.isText || !node.text) return
            const text = node.text.toLowerCase()
            let i = text.indexOf(q)
            while (i !== -1) {
                decos.push(Decoration.inline(pos + i, pos + i + q.length, { background: '#fff06a' }))
                i = text.indexOf(q, i + q.length)
            }
        })
        return decos
    }
    const editor = new CanvasEditor({
        state: EditorState.create({ doc, schema, plugins: [history()] }),
        container: document.getElementById('editor-embed')!,
        width: 600, font: EDITOR_FONT,
        ariaLabel: 'prosemirror-pretext live demo',
        keymap: { ...buildMarkKeymap(schema), 'Mod-z': undo, 'Mod-y': redo, 'Shift-Mod-z': redo },
        nodeViews: { image: imageView },
        floatRect: (n) => n.type.name === 'image' && n.attrs['x'] != null ? { x: n.attrs['x'], y: n.attrs['y'], width: n.attrs['width'] ?? 220 } : null,
        decorations: searchDecos,
        onRender(s: RenderStats) {
            statsEl.innerHTML = `${s.blockCount} blocks · ${s.lineCount} lines · ${s.renderTimeMs.toFixed(1)}ms · <span class="reflow">0 reflows ✨</span>`
            if (!peek.hidden) renderPeek()
            sync()
        },
    })
    ;(window as any).editor = editor

    // ── Toolbar ──
    const bar = document.getElementById('embed-toolbar')!
    const items: { el: HTMLButtonElement, on: () => boolean }[] = []
    const add = (label: string, cmd: Command, on: () => boolean = () => false) => {
        const el = document.createElement('button'); el.className = 'tb'; el.textContent = label
        el.addEventListener('mousedown', (e) => { e.preventDefault(); editor.command(cmd) })
        bar.appendChild(el); items.push({ el, on })
    }
    const sep = () => { const s = document.createElement('span'); s.className = 'sep'; bar.appendChild(s) }
    const mk = (n: string) => schema.marks[n]
    add('B', toggleMark(mk('strong')), () => markActive(editor.state, mk('strong')))
    add('I', toggleMark(mk('em')), () => markActive(editor.state, mk('em')))
    add('U', toggleMark(mk('underline')), () => markActive(editor.state, mk('underline')))
    add('S̶', toggleMark(mk('strikethrough')), () => markActive(editor.state, mk('strikethrough')))
    add('</>', toggleMark(mk('code')), () => markActive(editor.state, mk('code')))
    add('🔗', linkCmd, () => markActive(editor.state, mk('link')))
    add('🖍', toggleMark(mk('highlight')), () => markActive(editor.state, mk('highlight')))
    sep()
    add('H1', toggleBlock('heading', { level: 1 }), () => blockActive(editor.state, 'heading', { level: 1 }))
    add('H2', toggleBlock('heading', { level: 2 }), () => blockActive(editor.state, 'heading', { level: 2 }))
    add('❝', toggleBlock('blockquote'), () => blockActive(editor.state, 'blockquote'))
    add('{ }', toggleBlock('code_block'), () => blockActive(editor.state, 'code_block'))
    add('•', toggleList('bullet_list'), () => inList(editor.state, 'bullet_list'))
    add('1.', toggleList('ordered_list'), () => inList(editor.state, 'ordered_list'))
    sep()
    add('⇤', setAlign(null), () => false)
    add('↔', setAlign('center'), () => false)
    add('⇥', setAlign('right'), () => false)
    sep()
    add('🖼', insertImage)
    add('─', insertHr)
    add('↩︎', undo)
    add('↪︎', redo)
    sync = () => { for (const { el, on } of items) el.classList.toggle('active', on()) }
    sync()

    // ── Read-only toggle ──
    const ro = document.getElementById('readonly-toggle') as HTMLButtonElement
    ro.addEventListener('click', () => {
        editor.setEditable(!editor.editable)
        ro.classList.toggle('on', !editor.editable)
        ro.textContent = editor.editable ? '🔒 read-only' : '🔓 editable'
        editor.focus()
    })

    // ── Search highlight (decorations recompute each render) ──
    const search = document.getElementById('search') as HTMLInputElement
    search.addEventListener('input', () => {
        query = search.value
        editor.dispatch(editor.state.tr) // empty tr → re-render → decorations() reruns
    })

    // ── Screen-reader mirror peek (proof the canvas is still accessible) ──
    const mt = document.getElementById('mirror-toggle') as HTMLButtonElement
    function renderPeek() {
        const mirror = (editor as any).a11yMirror as HTMLElement | null
        peek.textContent = (mirror?.innerHTML ?? '(mirror disabled)').replace(/></g, '>\n<')
    }
    mt.addEventListener('click', () => {
        peek.hidden = !peek.hidden
        mt.classList.toggle('on', !peek.hidden)
        if (!peek.hidden) renderPeek()
    })

    editor.focus()
}

// A draggable image node view: corner handle resizes; dragging the body floats
// it (text wraps). We preview with a transform and commit attrs on release so
// the node view isn't recreated mid-drag.
function imageView(node: PMNode, getPos: () => number): HTMLElement {
    const wrap = document.createElement('div')
    wrap.style.cssText = 'position:relative;display:inline-block;max-width:100%'
    const img = document.createElement('img')
    img.src = node.attrs['src'] as string
    img.alt = (node.attrs['alt'] as string) ?? ''
    img.style.cssText = 'display:block;max-width:100%;border-radius:12px;cursor:grab;box-shadow:0 4px 14px rgba(0,0,0,.18)'
    if (node.attrs['width']) img.style.width = `${node.attrs['width']}px`
    wrap.appendChild(img)

    const handle = document.createElement('div')
    handle.style.cssText = 'position:absolute;right:-6px;bottom:-6px;width:16px;height:16px;border-radius:50%;background:#a5b4fc;border:2px solid #fff;cursor:nwse-resize;box-shadow:0 1px 4px rgba(0,0,0,.3);touch-action:none'
    handle.setAttribute('aria-hidden', 'true')
    wrap.appendChild(handle)

    const ed = () => (window as any).editor as CanvasEditor

    handle.addEventListener('pointerdown', (e) => {
        e.preventDefault(); e.stopPropagation()
        handle.setPointerCapture(e.pointerId)
        const sx = e.clientX, sw = img.offsetWidth
        const move = (ev: PointerEvent) => { img.style.width = `${Math.max(60, sw + (ev.clientX - sx))}px` }
        const up = (ev: PointerEvent) => {
            handle.releasePointerCapture(ev.pointerId); wrap.removeEventListener('pointermove', move); wrap.removeEventListener('pointerup', up)
            ed().command((s, d) => { d?.(s.tr.setNodeMarkup(getPos(), undefined, { ...node.attrs, width: img.offsetWidth })); return true })
        }
        wrap.addEventListener('pointermove', move); wrap.addEventListener('pointerup', up)
    })

    img.addEventListener('pointerdown', (e) => {
        e.preventDefault(); img.setPointerCapture(e.pointerId)
        const cr = ((ed() as any).canvas as HTMLCanvasElement).getBoundingClientRect()
        const wr = wrap.getBoundingClientRect()
        const x0 = wr.left - cr.left, y0 = wr.top - cr.top, sx = e.clientX, sy = e.clientY
        let dx = 0, dy = 0
        const move = (ev: PointerEvent) => { dx = ev.clientX - sx; dy = ev.clientY - sy; wrap.style.transform = `translate(${dx}px,${dy}px)` }
        const up = (ev: PointerEvent) => {
            img.releasePointerCapture(ev.pointerId); wrap.removeEventListener('pointermove', move); wrap.removeEventListener('pointerup', up)
            wrap.style.transform = ''
            if (dx === 0 && dy === 0) return
            ed().command((s, d) => { d?.(s.tr.setNodeMarkup(getPos(), undefined, { ...node.attrs, x: Math.max(0, Math.round(x0 + dx)), y: Math.max(0, Math.round(y0 + dy)), width: node.attrs['width'] ?? 220 })); return true })
        }
        wrap.addEventListener('pointermove', move); wrap.addEventListener('pointerup', up)
    })
    return wrap
}

boot()
