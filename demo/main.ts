/**
 * Demo page — boots a CanvasEditor with marks (bold / italic / code), a
 * toolbar, and Cmd-B/I/` shortcuts, inside the dark "editor chrome" shell
 * defined in index.html.
 */

import { Schema, type NodeSpec, type MarkType, type Node as ProsemirrorNode } from 'prosemirror-model'
import { EditorState } from 'prosemirror-state'
import { toggleMark, setBlockType } from 'prosemirror-commands'
import { wrapInList, liftListItem } from 'prosemirror-schema-list'
import type { Command } from 'prosemirror-state'
import { history, undo, redo } from 'prosemirror-history'
import { CanvasEditor, markSpecs, buildMarkKeymap } from '../src'


// ─── Schema ────────────────────────────────────────────────────────────────

const nodes: Record<string, NodeSpec> = {
    doc: { content: '(heading | paragraph | blockquote | code_block | horizontal_rule | bullet_list | ordered_list | image | runButton)+' },
    paragraph: {
        content: 'text*',
        attrs: { align: { default: null } },
        toDOM: (n) => ['p', n.attrs['align'] ? { style: `text-align:${n.attrs['align']}` } : {}, 0],
        parseDOM: [{ tag: 'p', getAttrs: (d) => ({ align: (d as HTMLElement).style.textAlign || null }) }],
    },
    heading: {
        content: 'text*',
        group: 'block',
        attrs: { level: { default: 1 }, align: { default: null } },
        toDOM: (n) => [`h${n.attrs['level']}`, n.attrs['align'] ? { style: `text-align:${n.attrs['align']}` } : {}, 0],
        parseDOM: [1, 2, 3].map((l) => ({ tag: `h${l}`, getAttrs: (d) => ({ level: l, align: (d as HTMLElement).style.textAlign || null }) })),
    },
    // Simple (non-nesting) blockquote + code block: text-only blocks the flat
    // layout can style as boxes. Real nesting (quote → paragraphs) needs lists.
    blockquote: {
        content: 'text*',
        group: 'block',
        toDOM: () => ['blockquote', 0],
        parseDOM: [{ tag: 'blockquote' }],
    },
    code_block: {
        content: 'text*',
        group: 'block',
        marks: '',
        code: true,
        toDOM: () => ['pre', ['code', 0]],
        parseDOM: [{ tag: 'pre', preserveWhitespace: 'full' }],
    },
    horizontal_rule: {
        group: 'block',
        toDOM: () => ['hr'],
        parseDOM: [{ tag: 'hr' }],
    },
    ordered_list: {
        content: 'list_item+',
        group: 'block',
        attrs: { order: { default: 1 } },
        toDOM: () => ['ol', 0],
        parseDOM: [{ tag: 'ol' }],
    },
    bullet_list: {
        content: 'list_item+',
        group: 'block',
        toDOM: () => ['ul', 0],
        parseDOM: [{ tag: 'ul' }],
    },
    list_item: {
        content: 'paragraph block*',
        defining: true,
        toDOM: () => ['li', 0],
        parseDOM: [{ tag: 'li' }],
    },
    // An image: an atom block drawn by a node view (a real <img> element).
    image: {
        atom: true,
        group: 'block',
        attrs: { src: {}, alt: { default: '' }, width: { default: null }, x: { default: null }, y: { default: null } },
        toDOM: (n) => ['img', {
            src: n.attrs['src'], alt: n.attrs['alt'],
            ...(n.attrs['width'] ? { width: n.attrs['width'] } : {}),
        }],
        parseDOM: [{
            tag: 'img[src]',
            getAttrs: (d) => ({
                src: (d as HTMLElement).getAttribute('src'),
                alt: (d as HTMLElement).getAttribute('alt') ?? '',
                width: Number((d as HTMLElement).getAttribute('width')) || null,
            }),
        }],
    },
    // A leaf/atom block: a snippet of code with a Run button (a node view).
    runButton: {
        atom: true,
        group: 'block',
        attrs: { code: { default: '6 * 7' } },
        toDOM: (n) => ['div', { 'data-run': n.attrs['code'] }],
        parseDOM: [{ tag: 'div[data-run]', getAttrs: (d) => ({ code: (d as HTMLElement).getAttribute('data-run') }) }],
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

/** A list item: a paragraph of inline content, plus optional nested blocks. */
const item = (inline: ProsemirrorNode[], ...rest: ProsemirrorNode[]) =>
    schema.node('list_item', null, [schema.node('paragraph', null, inline), ...rest])

/** A solid-colour image, as an inline SVG data URI (offline demo asset). */
const swatch = (color: string) =>
    `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="460" height="90"><rect width="460" height="90" rx="6" fill="${color}"/></svg>`)}`


// ─── Sample Document ───────────────────────────────────────────────────────

const doc = schema.node('doc', null, [
    schema.node('heading', { level: 1 }, [schema.text('Canvas, all the way down')]),
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
    schema.node('runButton', { code: 'new Date().toLocaleTimeString()' }),
    schema.node('paragraph', null, [
        m('That block above is a leaf '), m('node view', 'em'),
        m(' — real interactive DOM the editor positions over reserved space. '),
        m('Arrow into it to select; Backspace deletes it.'),
    ]),
    schema.node('horizontal_rule'),
    schema.node('blockquote', null, [
        schema.text('Block styles are pure arithmetic: padding, a left bar, a background panel — all measured and painted by hand.'),
    ]),
    schema.node('code_block', null, [
        schema.text('ctx.fillText(line.text, line.x, line.y)\n// every glyph, placed by hand'),
    ]),
    schema.node('bullet_list', null, [
        item([m('Markers, indent, and nesting are pure arithmetic too.')]),
        item([m('Press '), m('Tab', 'code'), m(' to nest, '), m('Shift-Tab', 'code'), m(' to lift.')],
            schema.node('bullet_list', null, [
                item([m('A nested bullet, one level deeper.')]),
                item([m('Each level adds a fixed indent and its own gutter.')]),
            ]),
        ),
    ]),
    schema.node('ordered_list', null, [
        item([m('Ordered items count up,')]),
        item([m('one,')]),
        item([m('two, three.')]),
    ]),
    schema.node('paragraph', null, [
        m('Two images stacked below — click into the seam between them (or arrow '),
        m('to it) to get a '), m('gap cursor', 'em'), m(', then press Enter to slot a paragraph in.'),
    ]),
    schema.node('image', { src: swatch('#818cf8'), alt: 'indigo swatch' }),
    schema.node('image', { src: swatch('#e86482'), alt: 'rose swatch' }),
])


// ─── Toolbar ─────────────────────────────────────────────────────────────────

function markActive(state: EditorState, type: MarkType): boolean
{
    const { from, $from, to, empty } = state.selection
    return empty
        ? !!type.isInSet(state.storedMarks || $from.marks())
        : state.doc.rangeHasMark(from, to, type)
}

/** Is the cursor's block this node type (+ attrs)? */
function blockActive(state: EditorState, typeName: string, attrs?: Record<string, unknown>): boolean
{
    const { $from } = state.selection
    return $from.parent.hasMarkup(schema.nodes[typeName], attrs as any)
}

/** Toggle the cursor's textblock between `typeName` and a plain paragraph. */
function toggleBlock(typeName: string, attrs?: Record<string, unknown>): Command
{
    return (state, dispatch) =>
    {
        const active = blockActive(state, typeName, attrs)
        const target = active ? schema.nodes['paragraph'] : schema.nodes[typeName]
        return setBlockType(target, active ? undefined : attrs)(state, dispatch)
    }
}

/** Insert a horizontal rule at the selection. */
const insertRule: Command = (state, dispatch) =>
{
    dispatch?.(state.tr.replaceSelectionWith(schema.nodes['horizontal_rule'].create()).scrollIntoView())
    return true
}

/** Set the `align` attribute on every textblock in the selection. */
function setAlign(align: string | null): Command
{
    return (state, dispatch) =>
    {
        const { from, to } = state.selection
        let tr = state.tr
        let any = false
        state.doc.nodesBetween(from, to, (node, pos) =>
        {
            if (node.isTextblock && node.type.spec.attrs?.['align'])
            {
                tr = tr.setNodeMarkup(pos, undefined, { ...node.attrs, align })
                any = true
            }
        })
        if (any) dispatch?.(tr)
        return any
    }
}

/** Is every textblock in the selection set to this alignment? */
function alignActive(state: EditorState, align: string): boolean
{
    return (state.selection.$from.parent.attrs['align'] ?? 'left') === align
        || (align === 'left' && !state.selection.$from.parent.attrs['align'])
}

/** Prompt for an image URL and insert it at the selection. */
const insertImage: Command = (state, dispatch) =>
{
    const src = window.prompt('Image URL:')
    if (!src) return false
    dispatch?.(state.tr.replaceSelectionWith(schema.nodes['image'].create({ src })).scrollIntoView())
    return true
}

/** Is the cursor inside a list of the given type? */
function inList(state: EditorState, typeName: string): boolean
{
    const { $from } = state.selection
    for (let d = $from.depth; d > 0; d--)
    {
        if ($from.node(d).type === schema.nodes[typeName]) return true
    }
    return false
}

/** Wrap the selection in a list, or lift it back out if already in that list. */
function toggleList(typeName: string): Command
{
    return (state, dispatch) =>
        inList(state, typeName)
            ? liftListItem(schema.nodes['list_item'])(state, dispatch)
            : wrapInList(schema.nodes[typeName])(state, dispatch)
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

    // ── Block-type buttons (headings, quote, code, rule) ──
    const sep = document.createElement('span')
    sep.className = 'tb-sep'
    wrap.appendChild(sep)

    const blockButtons: { el: HTMLButtonElement, isActive: () => boolean }[] = []
    const addBlockButton = (
        label: string, command: Command, isActive: () => boolean,
    ) =>
    {
        const el = document.createElement('button')
        el.textContent = label
        el.className = 'tb'
        el.addEventListener('mousedown', (e) =>
        {
            e.preventDefault()
            editor.command(command)
        })
        wrap.appendChild(el)
        blockButtons.push({ el, isActive })
    }

    for (const level of [1, 2, 3])
    {
        addBlockButton(
            `H${level}`,
            toggleBlock('heading', { level }),
            () => blockActive(editor.state, 'heading', { level }),
        )
    }
    addBlockButton('❝', toggleBlock('blockquote'), () => blockActive(editor.state, 'blockquote'))
    addBlockButton('{ }', toggleBlock('code_block'), () => blockActive(editor.state, 'code_block'))
    addBlockButton('• List', toggleList('bullet_list'), () => inList(editor.state, 'bullet_list'))
    addBlockButton('1. List', toggleList('ordered_list'), () => inList(editor.state, 'ordered_list'))
    addBlockButton('⇤', setAlign(null), () => alignActive(editor.state, 'left'))
    addBlockButton('↔', setAlign('center'), () => alignActive(editor.state, 'center'))
    addBlockButton('⇥', setAlign('right'), () => alignActive(editor.state, 'right'))
    addBlockButton('🖼', insertImage, () => false)
    addBlockButton('─', insertRule, () => false)

    // Reflect the active marks/blocks at the caret/selection on every render.
    return () =>
    {
        for (const { el, type } of buttons)
        {
            el.classList.toggle('active', markActive(editor.state, type))
        }
        for (const { el, isActive } of blockButtons)
        {
            el.classList.toggle('active', isActive())
        }
    }
}

// ─── Bubble menu (floating toolbar over a selection) ─────────────────────────

function setupBubble(editor: CanvasEditor): () => void
{
    const bubble = document.createElement('div')
    bubble.className = 'bubble'
    const marks: { el: HTMLButtonElement, type: MarkType }[] = []
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
        marks.push({ el, type })
    }

    // List toggles, mirroring the main toolbar so a selection can be turned
    // into a list (or lifted back out) without leaving the floating menu.
    const sep = document.createElement('span')
    sep.className = 'tb-sep'
    bubble.appendChild(sep)

    const lists: { el: HTMLButtonElement, typeName: string }[] = []
    for (const [label, typeName] of [['•', 'bullet_list'], ['1.', 'ordered_list']] as const)
    {
        const el = document.createElement('button')
        el.textContent = label
        el.className = 'tb'
        el.addEventListener('mousedown', (e) =>
        {
            e.preventDefault()
            editor.command(toggleList(typeName))
        })
        bubble.appendChild(el)
        lists.push({ el, typeName })
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
        for (const { el, type } of marks)
        {
            el.classList.toggle('active', markActive(editor.state, type))
        }
        for (const { el, typeName } of lists)
        {
            el.classList.toggle('active', inList(editor.state, typeName))
        }
        const cx = (rect.left + rect.right) / 2
        bubble.style.left = `${Math.round(cx - bubble.offsetWidth / 2)}px`
        bubble.style.top = `${Math.round(Math.max(8, rect.top - bubble.offsetHeight - 8))}px`
    }
}


// ─── Node view: the "run" button block ──────────────────────────────────────

function imageView(node: ProsemirrorNode, getPos: () => number): HTMLElement
{
    const wrap = document.createElement('div')
    wrap.style.position = 'relative'
    wrap.style.display = 'inline-block'
    wrap.style.maxWidth = '100%'

    const img = document.createElement('img')
    img.src = node.attrs['src'] as string
    img.alt = (node.attrs['alt'] as string) ?? ''
    img.style.display = 'block'
    img.style.maxWidth = '100%'
    img.style.borderRadius = '6px'
    img.style.cursor = 'grab'
    if (node.attrs['width']) img.style.width = `${node.attrs['width']}px`
    wrap.appendChild(img)

    // Drag the image body to float it (text wraps around it). We preview with a
    // transform during the drag and only commit x/y/width on release — so the
    // node view isn't torn down and recreated on every move.
    img.addEventListener('pointerdown', (e) =>
    {
        e.preventDefault()
        img.setPointerCapture(e.pointerId)
        img.style.cursor = 'grabbing'
        const ed = (window as any).editor as CanvasEditor
        const cr = ((ed as any).canvas as HTMLCanvasElement).getBoundingClientRect()
        const wr0 = wrap.getBoundingClientRect()
        const x0 = wr0.left - cr.left
        const y0 = wr0.top - cr.top
        const startX = e.clientX
        const startY = e.clientY
        let dx = 0
        let dy = 0
        const move = (ev: PointerEvent) =>
        {
            dx = ev.clientX - startX
            dy = ev.clientY - startY
            wrap.style.transform = `translate(${dx}px, ${dy}px)`
        }
        const up = (ev: PointerEvent) =>
        {
            img.releasePointerCapture(ev.pointerId)
            img.style.cursor = 'grab'
            wrap.removeEventListener('pointermove', move)
            wrap.removeEventListener('pointerup', up)
            wrap.style.transform = ''
            if (dx === 0 && dy === 0) return // a click, not a drag
            ed.command((state, dispatch) =>
            {
                dispatch?.(state.tr.setNodeMarkup(getPos(), undefined, {
                    ...node.attrs,
                    x: Math.max(0, Math.round(x0 + dx)),
                    y: Math.max(0, Math.round(y0 + dy)),
                    width: node.attrs['width'] ?? 220,
                }))
                return true
            })
        }
        wrap.addEventListener('pointermove', move)
        wrap.addEventListener('pointerup', up)
    })

    // Bottom-right drag handle: live-previews the width (text below reflows via
    // the editor's ResizeObserver) and commits it to the node on release.
    const handle = document.createElement('div')
    handle.className = 'img-resize'
    handle.setAttribute('aria-hidden', 'true')
    wrap.appendChild(handle)
    handle.addEventListener('pointerdown', (e) =>
    {
        e.preventDefault()
        e.stopPropagation() // don't select the node
        const startX = e.clientX
        const startW = img.offsetWidth
        handle.setPointerCapture(e.pointerId)
        const move = (ev: PointerEvent) =>
        {
            img.style.width = `${Math.max(40, startW + (ev.clientX - startX))}px`
        }
        const up = (ev: PointerEvent) =>
        {
            handle.releasePointerCapture(ev.pointerId)
            wrap.removeEventListener('pointermove', move)
            wrap.removeEventListener('pointerup', up)
            const width = img.offsetWidth
            const ed = (window as any).editor as CanvasEditor
            ed.command((state, dispatch) =>
            {
                dispatch?.(state.tr.setNodeMarkup(getPos(), undefined, { ...node.attrs, width }))
                return true
            })
        }
        wrap.addEventListener('pointermove', move)
        wrap.addEventListener('pointerup', up)
    })
    return wrap
}

function runButtonView(node: ProsemirrorNode): HTMLElement
{
    const root = document.createElement('div')
    root.className = 'run-block'

    const code = document.createElement('code')
    code.textContent = node.attrs['code'] as string

    const out = document.createElement('span')
    out.className = 'run-out'
    out.setAttribute('aria-live', 'polite') // announce the result to screen readers

    const btn = document.createElement('button')
    btn.className = 'run-btn'
    btn.textContent = '▶ Run'
    btn.setAttribute('aria-label', `Run ${node.attrs['code']}`)
    btn.addEventListener('mousedown', (e) => e.stopPropagation()) // don't select the node
    btn.addEventListener('click', () =>
    {
        try { out.textContent = ` → ${String(new Function(`return (${node.attrs['code']})`)())}` }
        catch (err) { out.textContent = ` → ${(err as Error).message}` }
    })

    root.append(btn, code, out)
    return root
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
        width: CONTENT_WIDTH,
        keymap: {
            ...buildMarkKeymap(schema),
            'Mod-z': undo,
            'Mod-y': redo,
            'Shift-Mod-z': redo,
        },
        nodeViews: { runButton: runButtonView, image: imageView },
        // An image with an x/y becomes a float: text wraps around it.
        floatRect: (node) => node.type.name === 'image' && node.attrs['x'] != null
            ? { x: node.attrs['x'], y: node.attrs['y'], width: node.attrs['width'] ?? 220 }
            : null,
        placeholder: 'Start typing…',
        ariaLabel: 'Demo document — ProseMirror + Pretext canvas editor',
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

const CONTENT_WIDTH = 560

function setupFloat(editor: CanvasEditor): void
{
    const wrap = document.querySelector('.canvas-wrap') as HTMLElement
    const canvasEl = wrap.querySelector('canvas') as HTMLCanvasElement
    const box = document.createElement('div')
    box.className = 'float-box'
    box.textContent = 'float — drag me'
    wrap.appendChild(box)

    // Content-space rect; text flows around it. The visual box is offset to the
    // canvas's real origin (it sits below the toolbar inside .canvas-wrap), so
    // the box lines up with the exclusion rect instead of floating above it.
    const f = { x: 250, y: 34, width: 190, height: 132 }
    const place = () =>
    {
        const wrapRect = wrap.getBoundingClientRect()
        const canvasRect = canvasEl.getBoundingClientRect()
        box.style.left = `${(canvasRect.left - wrapRect.left) + f.x}px`
        box.style.top = `${(canvasRect.top - wrapRect.top) + f.y}px`
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
