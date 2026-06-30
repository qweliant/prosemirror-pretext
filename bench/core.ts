/**
 * Shared benchmark core: one document model, two view layers.
 *
 * The whole point of a *fair* benchmark is that both editors edit the exact
 * same ProseMirror document with the same schema and transactions — only the
 * view layer differs:
 *
 *   - Editor A (control): prosemirror-view  → contenteditable DOM
 *   - Editor B (ours):    prosemirror-pretext → <canvas>
 *
 * The metric is the **read-after-write tax**: every real rich-text editor with
 * a bubble menu / slash command / collab cursor must ask "where is the caret in
 * pixels?" on every keystroke. We measure the synchronous cost of
 * `edit → (recompute layout) → read caret coords`, all in one task, the way it
 * happens before the next frame paints.
 *
 *   - DOM: `view.coordsAtPos()` calls `range.getBoundingClientRect()` right
 *     after a DOM mutation → forces synchronous layout of the page.
 *   - Canvas: `editor.flush()` recomputes only the changed block's layout
 *     (WeakMap-cached arithmetic), then `coordsAtPos()` is a lookup.
 *
 * We deliberately *handicap ourselves*: `flush()` also repaints the canvas, so
 * our number includes paint, while the DOM number (getBoundingClientRect) forces
 * layout but not paint. If we still win, it isn't cherry-picked.
 */
import { Schema, type Node as PMNode } from 'prosemirror-model'
import { EditorState, TextSelection } from 'prosemirror-state'
import { CanvasEditor, markSpecs } from '../src/index'
import { EditorView } from 'prosemirror-view'

// ─── Shared schema (handled natively by BOTH view layers) ────────────────────

export const schema = new Schema({
    nodes: {
        doc: { content: 'block+' },
        paragraph: { group: 'block', content: 'inline*', toDOM: () => ['p', 0], parseDOM: [{ tag: 'p' }] },
        heading: {
            group: 'block', content: 'inline*', attrs: { level: { default: 1 } },
            toDOM: (n) => [`h${n.attrs.level}`, 0],
            parseDOM: [1, 2, 3].map((l) => ({ tag: `h${l}`, attrs: { level: l } })),
        },
        blockquote: { group: 'block', content: 'block+', toDOM: () => ['blockquote', 0], parseDOM: [{ tag: 'blockquote' }] },
        bullet_list: { group: 'block', content: 'list_item+', toDOM: () => ['ul', 0], parseDOM: [{ tag: 'ul' }] },
        list_item: { content: 'paragraph block*', toDOM: () => ['li', 0], parseDOM: [{ tag: 'li' }] },
        text: { group: 'inline' },
    },
    marks: markSpecs,
})

const SENTENCE = 'The quick brown fox jumps over the lazy dog, and then keeps right on going. '

const p = (text: string) => schema.node('paragraph', null, text ? [schema.text(text)] : [])
const li = (children: PMNode[]) => schema.node('list_item', null, children)

/** A flat run of `n` simple paragraphs. The "browser is already good at this" case. */
export function buildSimpleDoc(n: number): PMNode {
    const blocks: PMNode[] = [p('Type here — first line of a long flat document.')]
    for (let i = 0; i < n; i++) blocks.push(p(`${i}. ${SENTENCE}`))
    return schema.node('doc', null, blocks)
}

/**
 * A structurally complex doc: `units` blockquote-wrapped nested bullet lists,
 * each `depth` levels deep. Same total block count knob as the simple doc, but
 * every block is boxed inside others — the case where a DOM relayout near the
 * top must recompute the geometry of everything below it.
 *
 * The first block is a plain paragraph; we always type there (worst case for the
 * DOM: maximal subtree below the edit).
 */
export function buildComplexDoc(units: number): PMNode {
    const blocks: PMNode[] = [p('Type here — first line, with a big nested subtree below it.')]
    for (let u = 0; u < units; u++) {
        // depth-3 nested list inside a blockquote: ul > li > (p + ul > li > (p + ul > li > p))
        const inner = schema.node('bullet_list', null, [li([p(`${u}.2 ${SENTENCE}`)])])
        const mid = schema.node('bullet_list', null, [li([p(`${u}.1 ${SENTENCE}`), inner])])
        const outer = schema.node('bullet_list', null, [li([p(`${u}.0 ${SENTENCE}`), mid])])
        blocks.push(schema.node('blockquote', null, [p(`Note ${u}: ${SENTENCE}`), outer]))
    }
    return schema.node('doc', null, blocks)
}

// ─── Adapters ────────────────────────────────────────────────────────────────

export interface EditorAdapter {
    /** Move the caret to a text position near the top of the doc. */
    setCaret(pos: number): void
    /** Insert one character at the current selection. */
    type(): void
    /** Hook for any work that must happen between edit and read. Both view layers
     *  now fold this into the read itself (DOM: getBoundingClientRect forces
     *  layout; canvas: coordsAtPos lazily recomputes the dirty layout), so this is
     *  a no-op — kept so the measured loop is identical for both. */
    sync(): void
    /** Read the caret's pixel coordinates (the read-after-write). */
    readCaret(): unknown
    destroy(): void
}

export function makeDomAdapter(doc: PMNode, mount: HTMLElement): EditorAdapter {
    const view = new EditorView(mount, { state: EditorState.create({ doc, schema }) })
    return {
        setCaret(pos) {
            const sel = TextSelection.near(view.state.doc.resolve(pos))
            view.dispatch(view.state.tr.setSelection(sel))
        },
        type() { view.dispatch(view.state.tr.insertText('a')) },
        sync() { /* DOM layout is forced by readCaret(); nothing to do here */ },
        readCaret() { return view.coordsAtPos(view.state.selection.head) },
        destroy() { view.destroy() },
    }
}

export function makeCanvasAdapter(doc: PMNode, mount: HTMLElement, width: number): EditorAdapter {
    const editor = new CanvasEditor({
        state: EditorState.create({ doc, schema }),
        container: mount,
        width,
        font: '16px Georgia, serif',
        lineHeight: 26,
        autofocus: false,
    })
    return {
        setCaret(pos) {
            const sel = TextSelection.near(editor.state.doc.resolve(pos))
            editor.dispatch(editor.state.tr.setSelection(sel))
        },
        type() { editor.dispatch(editor.state.tr.insertText('a')) },
        sync() { /* coordsAtPos recomputes the dirty layout on demand */ },
        readCaret() { return editor.coordsAtPos(editor.state.selection.head) },
        destroy() { editor.destroy() },
    }
}

// ─── Measurement ─────────────────────────────────────────────────────────────

export interface Stats { p50: number, p95: number, max: number, mean: number, n: number }

function summarize(samples: number[]): Stats {
    const s = [...samples].sort((a, b) => a - b)
    const q = (f: number) => s[Math.min(s.length - 1, Math.floor(f * s.length))]
    const mean = s.reduce((a, b) => a + b, 0) / s.length
    return { p50: q(0.5), p95: q(0.95), max: s[s.length - 1], mean, n: s.length }
}

/**
 * Run `keystrokes` insertions at `caretPos`, timing the synchronous cost of
 * `type → sync → (optionally) readCaret` per keystroke. `readCaret: true` is the
 * realistic "editor with caret-positioned UI" case (the kill shot).
 */
export function measure(
    adapter: EditorAdapter,
    opts: { caretPos: number, keystrokes: number, readCaret: boolean, warmup?: number },
): Stats {
    const warmup = opts.warmup ?? 20
    adapter.setCaret(opts.caretPos)
    for (let i = 0; i < warmup; i++) { adapter.type(); adapter.sync(); if (opts.readCaret) adapter.readCaret() }
    const samples: number[] = []
    for (let i = 0; i < opts.keystrokes; i++) {
        const t0 = performance.now()
        adapter.type()
        adapter.sync()
        if (opts.readCaret) adapter.readCaret()
        samples.push(performance.now() - t0)
    }
    return summarize(samples)
}
