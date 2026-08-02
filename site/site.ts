/**
 * The one demo. It backs both `bun run dev` and `bun run dev:site`, and doubles
 * as the usage example on the docs site: schema, sample doc, toolbar, an
 * interactive node view, decorations, render stats, a screen-reader-mirror
 * peek, read-only + placeholder toggles — and a scroll-virtualization lab that
 * measures per-keystroke cost against document size.
 */
import { Schema, type NodeSpec, type MarkType, type Node as PMNode } from 'prosemirror-model'
import { EditorState, TextSelection, type Command } from 'prosemirror-state'
import { toggleMark, setBlockType } from 'prosemirror-commands'
import { history, undo, redo } from 'prosemirror-history'
import { wrapInList, liftListItem } from 'prosemirror-schema-list'
import { CanvasEditor, markSpecs, buildMarkKeymap, Decoration, type RenderStats, type Decoration as Deco } from '../src'

// A clean editorial serif for the writing surface — reads like a real editor,
// not a toy (the playful rounded fonts stay in the page chrome around it).
const EDITOR_FONT = '17px Georgia, "Times New Roman", serif'

/**
 * The editor's built-in colors are tuned for a dark chrome (#d4d4d8 text, a
 * periwinkle first-line accent). On this page's white writing surface that
 * lands at roughly 1.3:1 contrast, so both editors get the site palette.
 */
const EDITOR_THEME = {
    textColor: '#33502a',
    firstLineColor: '#33502a', // no first-line accent: it reads as a rendering bug on white
    caretColor: '#4f9e2c',
    selectionColor: 'rgba(126, 193, 75, .3)',
    ruleColor: '#cfe3c2',
} as const
const photo = (seed: string, w: number, h: number) => `https://picsum.photos/seed/${seed}/${w}/${h}`

// Clean line icons (Lucide-style) for the toolbar. Bold/italic/underline/strike
// and H1/H2 stay as styled text; everything else is an icon.
const ICONS: Record<string, string> = {
    code: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
    link: '<path d="M9 17H7A5 5 0 0 1 7 7h2"/><path d="M15 7h2a5 5 0 1 1 0 10h-2"/><line x1="8" y1="12" x2="16" y2="12"/>',
    highlight: '<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>',
    quote: '<line x1="4" y1="5" x2="4" y2="19"/><line x1="9" y1="7" x2="20" y2="7"/><line x1="9" y1="12" x2="20" y2="12"/><line x1="9" y1="17" x2="16" y2="17"/>',
    codeblock: '<rect x="3" y="4" width="18" height="16" rx="2"/><polyline points="9 9 7 12 9 15"/><polyline points="15 9 17 12 15 15"/>',
    list: '<line x1="9" y1="6" x2="20" y2="6"/><line x1="9" y1="12" x2="20" y2="12"/><line x1="9" y1="18" x2="20" y2="18"/><circle cx="4.5" cy="6" r="1.1" fill="currentColor" stroke="none"/><circle cx="4.5" cy="12" r="1.1" fill="currentColor" stroke="none"/><circle cx="4.5" cy="18" r="1.1" fill="currentColor" stroke="none"/>',
    listOrdered: '<line x1="10" y1="6" x2="20" y2="6"/><line x1="10" y1="12" x2="20" y2="12"/><line x1="10" y1="18" x2="20" y2="18"/><text x="2" y="8.2" font-size="7" fill="currentColor" stroke="none">1</text><text x="2" y="14.2" font-size="7" fill="currentColor" stroke="none">2</text><text x="2" y="20.2" font-size="7" fill="currentColor" stroke="none">3</text>',
    alignLeft: '<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="15" y2="12"/><line x1="3" y1="18" x2="18" y2="18"/>',
    alignCenter: '<line x1="3" y1="6" x2="21" y2="6"/><line x1="6" y1="12" x2="18" y2="12"/><line x1="5" y1="18" x2="19" y2="18"/>',
    alignRight: '<line x1="3" y1="6" x2="21" y2="6"/><line x1="9" y1="12" x2="21" y2="12"/><line x1="6" y1="18" x2="21" y2="18"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.6"/><path d="m21 15-5-5L5 21"/>',
    rule: '<line x1="3" y1="12" x2="21" y2="12"/>',
    undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-1"/>',
    redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h1"/>',
}
const icon = (name: string) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`

// ── Schema (the full set of node types the editor supports) ──────────────────
const nodes: Record<string, NodeSpec> = {
    doc: { content: '(heading | paragraph | blockquote | code_block | horizontal_rule | bullet_list | ordered_list | image | run_button)+' },
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
    // A leaf/atom block rendered as real interactive DOM (see `runButtonView`):
    // the editor reserves the space, we own what goes in it.
    run_button: {
        atom: true, group: 'block', attrs: { code: { default: '6 * 7' } },
        toDOM: (n) => ['div', { 'data-run': n.attrs['code'] }, `Run ${n.attrs['code']}`],
        parseDOM: [{ tag: 'div[data-run]', getAttrs: (d) => ({ code: (d as HTMLElement).getAttribute('data-run') }) }],
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

// Keep the floated photo from eating the whole column on a phone.
const FLOAT_W = Math.max(150, Math.min(220, Math.round((typeof window !== 'undefined' ? window.innerWidth : 900) * 0.42)))
const doc = schema.node('doc', null, [
    schema.node('heading', { level: 1 }, [schema.text('hello from the pond 🐸')]),
    schema.node('image', { src: photo('pondlily', FLOAT_W, Math.round(FLOAT_W * 0.68)), alt: 'a calm pond', x: 0, y: 120, width: FLOAT_W }),
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
    schema.node('run_button', { code: 'new Date().toLocaleTimeString()' }),
    schema.node('paragraph', null, [
        m('That green strip is a leaf '), m('node view', 'em'),
        m(' — real, focusable DOM the editor mounts over space it reserved in the canvas layout. Press it; the answer is also spoken through '),
        m('editor.announce()', 'code'),
        m('. Arrow into it to select it, Backspace to delete it.'),
    ]),
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

// ── A large synthetic document, for the virtualization lab ──────────────────
const LOREM = 'The pond is quiet at this hour and the layout engine is quieter still: every line break below is arithmetic, never a reflow. '

/**
 * `n` top-level blocks of mixed structure (headings, prose, quotes, lists) —
 * enough variety that the layout cache and the incremental-relayout path are
 * both exercised, not just a wall of identical paragraphs.
 */
function buildBigDoc(n: number): PMNode {
    const out: PMNode[] = [
        schema.node('heading', { level: 1 }, [schema.text(`${n.toLocaleString()} blocks, one canvas`)]),
        schema.node('paragraph', null, [schema.text('Type anywhere in here — or scroll. Only the blocks intersecting the viewport are painted.')]),
    ]
    for (let i = 1; i < n - 1; i++) {
        if (i % 40 === 0) out.push(schema.node('heading', { level: 2 }, [schema.text(`Section ${i / 40}`)]))
        else if (i % 17 === 0) out.push(schema.node('blockquote', null, [schema.text(`Note ${i}. ${LOREM}`)]))
        else if (i % 11 === 0) out.push(schema.node('bullet_list', null, [li(m(`bullet ${i}`)), li(m(`bullet ${i + 1}`))]))
        else out.push(schema.node('paragraph', null, [schema.text(`${i}. ${LOREM}`)]))
    }
    return schema.node('doc', null, out)
}

/**
 * Yield long enough for a pending style change to paint before we hog the main
 * thread. `requestAnimationFrame` alone is throttled to nothing in a background
 * tab, so a timer races it — otherwise a mount kicked off in a hidden tab would
 * simply never resume.
 */
const nextPaint = (): Promise<void> => new Promise<void>((resolve) => {
    const timer = setTimeout(done, 60)
    function done(): void { clearTimeout(timer); resolve() }
    requestAnimationFrame(done)
})

interface Sample { p50: number, p95: number, max: number }

const summarize = (xs: number[]): Sample => {
    const s = [...xs].sort((a, b) => a - b)
    const q = (f: number) => s[Math.min(s.length - 1, Math.floor(f * s.length))]
    return { p50: q(0.5), p95: q(0.95), max: s[s.length - 1] }
}

/**
 * The read-after-write tax, measured exactly the way `bench/` measures it:
 * insert a character in the MIDDLE of the document, then immediately ask for
 * the caret's pixel coordinates — the thing every bubble menu / slash command /
 * collab cursor must do on each keystroke. `coordsAtPos` recomputes the dirty
 * layout on demand, so this one number covers edit → relayout → caret read.
 *
 * A DOM editor pays a synchronous reflow here that grows with the document; the
 * point of the readout is that this number does not move as `n` goes up.
 */
function measureKeystrokes(ed: CanvasEditor, keystrokes = 150, warmup = 20): Sample {
    const mid = Math.floor(ed.state.doc.content.size / 2)
    ed.dispatch(ed.state.tr.setSelection(TextSelection.near(ed.state.doc.resolve(mid))))
    ed.flush()
    for (let i = 0; i < warmup; i++) {
        ed.dispatch(ed.state.tr.insertText('a'))
        ed.coordsAtPos(ed.state.selection.head)
    }
    const samples: number[] = []
    for (let i = 0; i < keystrokes; i++) {
        const t0 = performance.now()
        ed.dispatch(ed.state.tr.insertText('a'))
        ed.coordsAtPos(ed.state.selection.head)
        samples.push(performance.now() - t0)
    }
    // Put the document back the way we found it.
    const head = ed.state.selection.head
    ed.dispatch(ed.state.tr.delete(head - (keystrokes + warmup), head))
    ed.flush()
    return summarize(samples)
}

/**
 * The scroll-virtualization showcase. Mounts a second editor with `maxHeight`
 * set — so the content area scrolls and only the visible slice is laid out and
 * painted — over documents of increasing size, and reports both the render
 * stats and the measured per-keystroke cost.
 */
function setupScaleLab(): void {
    const embed = document.getElementById('scale-embed') as HTMLElement
    const bar = document.getElementById('scale-sizes') as HTMLElement
    const statsEl = document.getElementById('scale-stats') as HTMLElement
    const runBtn = document.getElementById('scale-measure') as HTMLButtonElement
    const tbody = document.getElementById('scale-rows') as HTMLElement
    const empty = document.getElementById('scale-empty') as HTMLElement
    if (!embed) return

    const SIZES = [500, 2000, 4000, 8000]
    const VIEWPORT = 420 // px — the `maxHeight` the scroller is capped at

    let editor: CanvasEditor | null = null
    let size = 0
    let mountMs = 0
    let lastStats: RenderStats | null = null

    const buttons = SIZES.map((n) => {
        const b = document.createElement('button')
        b.className = 'mini-btn'
        b.textContent = n.toLocaleString()
        b.addEventListener('click', () => void mount(n))
        bar.appendChild(b)
        return b
    })

    // `first paint` is the one-off cost of laying the whole document out;
    // `repaint` is what every frame after it costs, and is the number that
    // should barely move between 500 blocks and 8,000 — only the visible slice
    // is ever drawn.
    const showStats = () => {
        if (!lastStats) return
        statsEl.innerHTML =
            `${lastStats.blockCount.toLocaleString()} layout blocks · ${lastStats.lineCount.toLocaleString()} lines · ` +
            `first paint ${mountMs.toFixed(0)}ms · ` +
            `<span class="reflow">repaint ${lastStats.renderTimeMs.toFixed(1)}ms</span>`
    }

    async function mount(n: number): Promise<void> {
        if (n === size) return
        for (const b of buttons) b.disabled = true
        statsEl.textContent = `building a ${n.toLocaleString()}-block document…`
        runBtn.disabled = true
        empty.hidden = true
        await nextPaint() // let the "building…" label show before we block

        editor?.destroy()
        const t0 = performance.now()
        const next = new CanvasEditor({
            state: EditorState.create({ doc: buildBigDoc(n), schema, plugins: [history()] }),
            container: embed,
            // Leave a scrollbar's worth of room beside the canvas (see the
            // `#scale-embed > div` note in index.html).
            width: Math.max(280, Math.min(660, (embed.clientWidth || window.innerWidth - 80) - 20)),
            font: EDITOR_FONT, ...EDITOR_THEME,
            // The headline: cap the content height and the editor virtualizes —
            // the scroller's scrollbar spans the whole document while the canvas
            // only ever covers one viewport.
            maxHeight: VIEWPORT,
            ariaLabel: `Virtualized editor, ${n} blocks`,
            autofocus: false, // never steal focus / scroll the page on mount
            keymap: { ...buildMarkKeymap(schema), 'Mod-z': undo, 'Mod-y': redo, 'Shift-Mod-z': redo },
            onRender(s) { lastStats = s; showStats() },
        })
        // Construction only schedules the first frame; flush it here so the
        // number we report as "first paint" is the real cost of laying out the
        // whole document, not just wiring up the editor.
        next.flush()
        mountMs = performance.now() - t0
        next.flush() // a second, warm frame → `repaint` is steady-state

        editor = next
        size = n
        buttons.forEach((b, i) => { b.disabled = false; b.classList.toggle('on', SIZES[i] === n) })
        runBtn.disabled = false
        showStats()
    }

    runBtn.addEventListener('click', async () => {
        const target = editor
        if (!target) return
        // Label the row from the document we're about to measure, not from
        // whatever is mounted when we finish — and lock the sizes meanwhile, so
        // a click mid-run can't swap the editor out from under us. These are the
        // real layout counts, so the row matches the readout above (a bullet
        // list contributes more layout blocks than the one node you asked for).
        const label = lastStats?.blockCount ?? size
        const lines = lastStats?.lineCount ?? 0
        runBtn.disabled = true
        runBtn.textContent = 'measuring…'
        for (const b of buttons) b.disabled = true
        await nextPaint() // so the disabled state shows before we hog the thread

        const s = measureKeystrokes(target)
        const row = document.createElement('tr')
        row.innerHTML =
            `<td>${label.toLocaleString()}</td><td>${lines.toLocaleString()}</td>` +
            `<td><b>${s.p50.toFixed(2)}</b></td><td>${s.p95.toFixed(2)}</td><td>${s.max.toFixed(2)}</td>`
        tbody.appendChild(row)
        document.getElementById('scale-table')!.hidden = false

        runBtn.disabled = false
        runBtn.textContent = '⏱ measure 150 keystrokes'
        for (const b of buttons) b.disabled = false
    })

    // Don't build a few thousand blocks until the section is near the viewport.
    // A plain scroll check rather than IntersectionObserver: it's two lines, and
    // it can't be defeated by a zero-area target or a throttled observer.
    const section = document.getElementById('scale')!
    const maybeMount = (): void => {
        const r = section.getBoundingClientRect()
        if (r.top > window.innerHeight + 300 || r.bottom < -300) return
        window.removeEventListener('scroll', maybeMount)
        window.removeEventListener('resize', maybeMount)
        void mount(2000)
    }
    window.addEventListener('scroll', maybeMount, { passive: true })
    window.addEventListener('resize', maybeMount)
    maybeMount() // in case the page loads already scrolled to #scale
}

async function boot(): Promise<void> {
    await document.fonts.ready
    await new Promise((r) => setTimeout(r, 60))

    let sync = () => {}
    let query = ''
    const statsEl = document.getElementById('render-stats')!
    const peek = document.getElementById('mirror-peek') as HTMLElement

    let collabOn = false
    let collabPos = 6

    // A simulated remote caret. In a real app the *position* would come from a
    // collab transport (Yjs / y-prosemirror or prosemirror-collab + a socket);
    // the *rendering* is just a widget decoration like this one.
    function collabCursor(): HTMLElement {
        const el = document.createElement('span')
        el.style.cssText = 'display:inline-block;position:relative'
        el.innerHTML = '<span style="position:absolute;width:2px;height:22px;background:#e0488a;border-radius:1px"></span>' +
            '<span style="position:absolute;top:-18px;left:-2px;white-space:nowrap;background:#e0488a;color:#fff;font:600 11px/1.4 system-ui;padding:1px 6px;border-radius:6px">Keroppi 🐸</span>'
        return el
    }

    // Decorations = search highlights + (optionally) the collaborator's caret.
    const decorationsFn = (state: EditorState): Deco[] => {
        const decos: Deco[] = []
        if (query) {
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
        }
        if (collabOn) {
            const max = state.doc.content.size
            decos.push(Decoration.widget(Math.min(collabPos, max), collabCursor(), { key: 'collab' }))
        }
        return decos
    }
    const embed = document.getElementById('editor-embed')!
    // Fit the phone/tablet screen instead of overflowing at a fixed 600px.
    const editorWidth = Math.max(
        280,
        Math.min(600, embed.clientWidth || window.innerWidth - 80),
    )
    const editor = new CanvasEditor({
        state: EditorState.create({ doc, schema, plugins: [history()] }),
        container: embed,
        width: editorWidth, font: EDITOR_FONT, ...EDITOR_THEME,
        ariaLabel: 'prosemirror-pretext live demo',
        // Painted only while the document is empty — try "empty the doc" below.
        placeholder: 'Start typing… every glyph lands via ctx.fillText()',
        placeholderColor: '#a9bd9c',
        keymap: { ...buildMarkKeymap(schema), 'Mod-z': undo, 'Mod-y': redo, 'Shift-Mod-z': redo },
        nodeViews: { image: imageView, run_button: runButtonView },
        floatRect: (n) => n.type.name === 'image' && n.attrs['x'] != null ? { x: n.attrs['x'], y: n.attrs['y'], width: n.attrs['width'] ?? 220 } : null,
        decorations: decorationsFn,
        onRender(s: RenderStats) {
            statsEl.innerHTML = `${s.blockCount} blocks · ${s.lineCount} lines · ${s.renderTimeMs.toFixed(1)}ms · <span class="reflow">0 reflows ✨</span>`
            if (!peek.hidden) renderPeek()
            sync()
        },
    })
    ;(window as any).editor = editor

    // ── Toolbar (grouped icon buttons) ──
    const bar = document.getElementById('embed-toolbar')!
    const items: { el: HTMLButtonElement, on: () => boolean }[] = []
    const add = (inner: string, aria: string, cmd: Command, on: () => boolean = () => false) => {
        const el = document.createElement('button'); el.className = 'tb'; el.innerHTML = inner
        el.title = aria; el.setAttribute('aria-label', aria)
        el.addEventListener('mousedown', (e) => { e.preventDefault(); editor.command(cmd) })
        bar.appendChild(el); items.push({ el, on })
    }
    const sep = () => { const s = document.createElement('span'); s.className = 'sep'; bar.appendChild(s) }
    const mk = (n: string) => schema.marks[n]
    add('<span class="tb-b">B</span>', 'Bold', toggleMark(mk('strong')), () => markActive(editor.state, mk('strong')))
    add('<span class="tb-i">I</span>', 'Italic', toggleMark(mk('em')), () => markActive(editor.state, mk('em')))
    add('<span class="tb-u">U</span>', 'Underline', toggleMark(mk('underline')), () => markActive(editor.state, mk('underline')))
    add('<span class="tb-s">S</span>', 'Strikethrough', toggleMark(mk('strikethrough')), () => markActive(editor.state, mk('strikethrough')))
    add(icon('code'), 'Inline code', toggleMark(mk('code')), () => markActive(editor.state, mk('code')))
    add(icon('link'), 'Link', linkCmd, () => markActive(editor.state, mk('link')))
    add(icon('highlight'), 'Highlight', toggleMark(mk('highlight')), () => markActive(editor.state, mk('highlight')))
    sep()
    add('H1', 'Heading 1', toggleBlock('heading', { level: 1 }), () => blockActive(editor.state, 'heading', { level: 1 }))
    add('H2', 'Heading 2', toggleBlock('heading', { level: 2 }), () => blockActive(editor.state, 'heading', { level: 2 }))
    add(icon('quote'), 'Blockquote', toggleBlock('blockquote'), () => blockActive(editor.state, 'blockquote'))
    add(icon('codeblock'), 'Code block', toggleBlock('code_block'), () => blockActive(editor.state, 'code_block'))
    sep()
    add(icon('list'), 'Bulleted list', toggleList('bullet_list'), () => inList(editor.state, 'bullet_list'))
    add(icon('listOrdered'), 'Numbered list', toggleList('ordered_list'), () => inList(editor.state, 'ordered_list'))
    sep()
    add(icon('alignLeft'), 'Align left', setAlign(null))
    add(icon('alignCenter'), 'Align center', setAlign('center'))
    add(icon('alignRight'), 'Align right', setAlign('right'))
    sep()
    add(icon('image'), 'Insert image', insertImage)
    add(icon('rule'), 'Divider', insertHr)
    sep()
    add(icon('undo'), 'Undo', undo)
    add(icon('redo'), 'Redo', redo)
    sync = () => { for (const { el, on } of items) el.classList.toggle('active', on()) }
    sync()

    // ── Read-only toggle ──
    const ro = document.getElementById('readonly-toggle') as HTMLButtonElement
    ro.addEventListener('click', () => {
        editor.setEditable(!editor.editable)
        ro.classList.toggle('on', !editor.editable)
        ro.textContent = editor.editable ? '🔒 read-only' : '🔓 editable'
        // Toggling a mode is exactly the kind of event the canvas can't show a
        // screen reader on its own, so we voice it through the live region.
        editor.announce(editor.editable ? 'Editing enabled' : 'Read-only mode')
        editor.focus()
    })

    // ── Empty the doc, to reveal the `placeholder` option ──
    const ph = document.getElementById('placeholder-toggle') as HTMLButtonElement
    const fullDoc = editor.state.doc
    ph.addEventListener('click', () => {
        const emptied = editor.state.doc.childCount === 1
        editor.command((s, d) => {
            const next = emptied ? fullDoc : schema.node('doc', null, [schema.node('paragraph')])
            d?.(s.tr.replaceWith(0, s.doc.content.size, next.content))
            return true
        })
        ph.classList.toggle('on', !emptied)
        ph.textContent = emptied ? '🧹 empty the doc' : '↩︎ put it back'
        editor.announce(emptied ? 'Document restored' : 'Document emptied, placeholder showing')
        editor.focus()
    })

    // ── Search highlight (decorations recompute each render) ──
    const search = document.getElementById('search') as HTMLInputElement
    search.addEventListener('input', () => {
        query = search.value
        editor.dispatch(editor.state.tr) // empty tr → re-render → decorations() reruns
    })

    // ── Simulated collaborator (a widget decoration that wanders the doc) ──
    const collabBtn = document.getElementById('collab-toggle') as HTMLButtonElement
    let collabTimer: ReturnType<typeof setInterval> | null = null
    collabBtn.addEventListener('click', () => {
        collabOn = !collabOn
        collabBtn.classList.toggle('on', collabOn)
        if (collabOn) {
            collabTimer = setInterval(() => {
                collabPos = 2 + Math.floor(Math.random() * Math.max(1, editor.state.doc.content.size - 4))
                editor.dispatch(editor.state.tr) // refresh decorations
            }, 1400)
        } else if (collabTimer) {
            clearInterval(collabTimer); collabTimer = null
        }
        editor.dispatch(editor.state.tr)
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

/**
 * A leaf/atom node view: a snippet with a Run button. The editor reserves the
 * element's measured height in the canvas layout and positions it there — the
 * DOM inside is entirely ours, and stays interactive (and focusable, so it's
 * left visible to assistive tech rather than deferred to the a11y mirror).
 */
function runButtonView(node: PMNode): HTMLElement {
    const root = document.createElement('div')
    root.className = 'run-block'

    const code = document.createElement('code')
    code.textContent = node.attrs['code'] as string

    const out = document.createElement('span')
    out.className = 'run-out'

    const btn = document.createElement('button')
    btn.className = 'run-btn'
    btn.textContent = '▶ Run'
    btn.setAttribute('aria-label', `Run ${node.attrs['code']}`)
    btn.addEventListener('mousedown', (e) => e.stopPropagation()) // don't select the node
    btn.addEventListener('click', () => {
        // Demo-only eval: the expression is authored by this file, not the user.
        let result: string
        try { result = String(new Function(`return (${node.attrs['code']})`)()) }
        catch (err) { result = (err as Error).message }
        out.textContent = ` → ${result}`
        // Speak it: a node view's result is invisible to the structural mirror.
        ;((window as any).editor as CanvasEditor | undefined)?.announce(`Result: ${result}`)
    })

    root.append(btn, code, out)
    return root
}

// A single fixed-position vertical guide line, shown while an image snaps.
let guideEl: HTMLElement | null = null
function showGuide(left: number, top: number, height: number): void {
    if (!guideEl) {
        guideEl = document.createElement('div')
        guideEl.style.cssText = 'position:fixed;width:2px;background:#e0488a;z-index:50;pointer-events:none;box-shadow:0 0 6px #e0488a'
        document.body.appendChild(guideEl)
    }
    guideEl.style.left = `${left}px`
    guideEl.style.top = `${top}px`
    guideEl.style.height = `${height}px`
    guideEl.style.display = 'block'
}
function hideGuide(): void { if (guideEl) guideEl.style.display = 'none' }

// A draggable image node view: corner handle resizes; dragging the body floats
// it (text wraps). We preview with a transform and commit attrs on release so
// the node view isn't recreated mid-drag.
function imageView(node: PMNode, getPos: () => number): HTMLElement {
    const wrap = document.createElement('div')
    wrap.style.cssText = 'position:relative;display:inline-block;max-width:100%'
    const img = document.createElement('img')
    img.src = node.attrs['src'] as string
    img.alt = (node.attrs['alt'] as string) ?? ''
    // touch-action:none lets a finger-drag reposition the photo (float) instead
    // of scrolling the page — this is what was broken on phones.
    img.style.cssText = 'display:block;max-width:100%;border-radius:12px;cursor:grab;box-shadow:0 4px 14px rgba(0,0,0,.18);touch-action:none'
    if (node.attrs['width']) img.style.width = `${node.attrs['width']}px`
    wrap.appendChild(img)

    const handle = document.createElement('div')
    handle.style.cssText = 'position:absolute;right:-6px;bottom:-6px;width:18px;height:18px;border-radius:50%;background:#4f9e2c;border:2px solid #fff;cursor:nwse-resize;box-shadow:0 1px 4px rgba(0,0,0,.3);touch-action:none'
    handle.setAttribute('aria-hidden', 'true')
    wrap.appendChild(handle)

    const ed = () => (window as any).editor as CanvasEditor

    // ── Float controls: appear on hover/tap so you don't have to drag precisely ──
    const tools = document.createElement('div')
    tools.style.cssText = 'position:absolute;top:8px;left:50%;transform:translateX(-50%);display:none;gap:1px;background:rgba(20,54,31,.94);border-radius:11px;padding:3px;box-shadow:0 3px 12px rgba(0,0,0,.35);z-index:6;white-space:nowrap'
    let hideT: ReturnType<typeof setTimeout>
    const setPos = (kind: 'left' | 'center' | 'right' | 'inline') => {
        const cw = (ed() as any).canvas.getBoundingClientRect().width as number
        const w = (node.attrs['width'] as number) ?? img.offsetWidth ?? 220
        const x = kind === 'inline' ? null
            : kind === 'left' ? 0
                : kind === 'center' ? Math.max(0, Math.round((cw - w) / 2))
                    : Math.max(0, Math.round(cw - w))
        ed().command((s, d) => { d?.(s.tr.setNodeMarkup(getPos(), undefined, { ...node.attrs, x, y: x === null ? null : (node.attrs['y'] ?? 40) })); return true })
        ed().focus()
    }
    const tbtn = (inner: string, aria: string, fn: () => void) => {
        const b = document.createElement('button')
        b.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true" style="width:19px;height:19px;fill:none;stroke:#eafff2;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round">${inner}</svg>`
        b.title = aria; b.setAttribute('aria-label', aria)
        b.style.cssText = 'width:32px;height:30px;border:0;background:transparent;border-radius:8px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;touch-action:none'
        b.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation() })
        b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); fn() })
        b.addEventListener('pointerenter', () => { b.style.background = 'rgba(255,255,255,.16)' })
        b.addEventListener('pointerleave', () => { b.style.background = 'transparent' })
        return b
    }
    const INLINE_ICON = '<rect x="3" y="4" width="8" height="7" rx="1"/><line x1="13" y1="6" x2="21" y2="6"/><line x1="13" y1="10" x2="21" y2="10"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="3" y1="19" x2="21" y2="19"/>'
    tools.append(
        tbtn(ICONS['alignLeft'], 'Float left', () => setPos('left')),
        tbtn(ICONS['alignCenter'], 'Center', () => setPos('center')),
        tbtn(ICONS['alignRight'], 'Float right', () => setPos('right')),
        tbtn(INLINE_ICON, 'Inline (in text flow)', () => setPos('inline')),
    )
    wrap.appendChild(tools)
    wrap.addEventListener('pointerenter', () => { clearTimeout(hideT); tools.style.display = 'flex' })
    wrap.addEventListener('pointerleave', (e) => {
        clearTimeout(hideT)
        hideT = setTimeout(() => { tools.style.display = 'none' }, e.pointerType === 'touch' ? 2600 : 160)
    })

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
        const imgW = (node.attrs['width'] as number) ?? img.offsetWidth ?? 220
        const snaps = [0, (cr.width - imgW) / 2, cr.width - imgW] // left / center / right
        let dx = 0, dy = 0
        const move = (ev: PointerEvent) => {
            dx = ev.clientX - sx; dy = ev.clientY - sy
            // Snap the left edge to the content's left/center/right guides.
            const target = snaps.find((t) => Math.abs(x0 + dx - t) < 14)
            if (target !== undefined) { dx = target - x0; showGuide(cr.left + target, cr.top, cr.height) }
            else hideGuide()
            wrap.style.transform = `translate(${dx}px,${dy}px)`
        }
        const up = (ev: PointerEvent) => {
            img.releasePointerCapture(ev.pointerId); wrap.removeEventListener('pointermove', move); wrap.removeEventListener('pointerup', up)
            wrap.style.transform = ''; hideGuide()
            if (dx === 0 && dy === 0) return
            ed().command((s, d) => { d?.(s.tr.setNodeMarkup(getPos(), undefined, { ...node.attrs, x: Math.max(0, Math.round(x0 + dx)), y: Math.max(0, Math.round(y0 + dy)), width: node.attrs['width'] ?? 220 })); return true })
        }
        wrap.addEventListener('pointermove', move); wrap.addEventListener('pointerup', up)
    })
    return wrap
}

boot()
setupScaleLab()
