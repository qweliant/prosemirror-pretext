/**
 * Real-browser layout correctness check.
 *
 * The unit suite runs against a *mocked* Pretext and a `measureText` that
 * returns `text.length * 8`, which is what makes its coordinate assertions
 * deterministic — and what makes it structurally blind to the one class of bug
 * that lives in the seam between this editor and the real layout engine. The
 * clipped-glyph overrun that `TEXT_BLEED` exists to absorb was found by hand,
 * in a browser, and never became a test. This is that test.
 *
 * The invariant, not a golden number: for every laid-out line, the right edge
 * of the last glyph actually painted must fall inside the canvas. The canvas is
 * the content column plus `TEXT_BLEED`, so a line may exceed the column it was
 * broken to — that is the known Pretext/measureText disagreement — but it may
 * never exceed the pixels available to draw it, because past that the final
 * letter is guillotined.
 *
 * Fonts are deliberately not pinned. A headless Linux runner may substitute
 * something else for Georgia, which changes *which* lines overrun; it cannot
 * make overrunning acceptable. Anything the substituted metrics turn up is a
 * real finding about the same arithmetic.
 */
import { Schema, type Node as PMNode } from 'prosemirror-model'
import { EditorState } from 'prosemirror-state'
import { CanvasEditor, markSpecs, type BlockLayout } from '../src/index'
import { TEXT_BLEED } from '../src/constants'

const schema = new Schema({
    nodes: {
        doc: { content: 'block+' },
        paragraph: { group: 'block', content: 'inline*', toDOM: () => ['p', 0], parseDOM: [{ tag: 'p' }] },
        heading: {
            group: 'block', content: 'inline*', attrs: { level: { default: 1 } },
            toDOM: (n) => [`h${n.attrs.level}`, 0],
            parseDOM: [1, 2, 3].map((l) => ({ tag: `h${l}`, attrs: { level: l } })),
        },
        blockquote: { group: 'block', content: 'block+', toDOM: () => ['blockquote', 0], parseDOM: [{ tag: 'blockquote' }] },
        // A content-holding node: its paragraphs wrap inside a padded frame,
        // so their limit is the frame's edge, not the column's.
        callout: { group: 'block', content: 'block+', toDOM: () => ['aside', 0] },
        // An inline atom: Pretext lays it out as one unbreakable box whose
        // width the editor sets, so it is a third way for a line to overrun.
        mention: {
            group: 'inline', inline: true, atom: true, attrs: { label: { default: '' } },
            toDOM: (n) => ['span', n.attrs.label],
        },
        text: { group: 'inline' },
    },
    marks: markSpecs,
})

const WORDS = ('the quick brown fox jumps over a lazy dog while autumn rain '
    + 'settles on the quiet roofs of a town nobody remembers the name of').split(' ')

/**
 * A document whose lines cross as many mark boundaries as possible, because
 * that is where the overrun comes from: Pretext reserves a gap between styled
 * runs, the editor re-expands it into the preceding run and re-measures it in
 * *that* run's font, and a space in a serif is not a space in its italic. One
 * boundary contributes a fraction of a pixel; a line crossing several of them
 * accumulates enough to matter.
 */
function markedDoc(paragraphs: number): PMNode {
    const marks = ['strong', 'em', 'code', 'strong', 'em']
    const blocks: PMNode[] = []
    for (let p = 0; p < paragraphs; p++) {
        const inline: PMNode[] = []
        for (let w = 0; w < 44; w++) {
            const word = WORDS[(p * 7 + w) % WORDS.length]!
            // The separating space is its own *unmarked* node, so it falls on
            // the run boundary rather than inside the styled run. That is the
            // case that matters: Pretext trims boundary whitespace into a gap
            // it reserves on its own terms, and the editor re-expands it into
            // the preceding run and re-measures it in that run's font. A space
            // folded inside the marked run never crosses a boundary at all,
            // and reproduces nothing.
            if (w % 11 === 5) {
                inline.push(schema.nodes.mention!.create({ label: `@${word}` }))
            } else if (w % 3 === 0) {
                const name = marks[(p + w) % marks.length]!
                inline.push(schema.text(word, [schema.marks[name]!.create()]))
            } else {
                inline.push(schema.text(word))
            }
            if (w < 43) inline.push(schema.text(' '))
        }
        blocks.push(p % 7 === 3
            ? schema.node('blockquote', null, [schema.node('paragraph', null, inline)])
            : p % 10 === 7
            // A callout holding a callout, so edits reach a nested frame.
            ? schema.node('callout', null, [
                schema.node('paragraph', null, inline.slice(0, 20)),
                schema.node('callout', null, [schema.node('paragraph', null, inline.slice(20))]),
            ])
            : p % 5 === 2
            ? schema.node('callout', null, [schema.node('paragraph', null, inline)])
            : schema.node('paragraph', null, inline))
    }
    blocks.push(schema.node('heading', { level: 1 }, [schema.text('A heading that is quite long and will itself need to wrap somewhere')]))
    return schema.node('doc', null, blocks)
}

export interface Overrun {
    width: number
    blockType: string
    lineText: string
    /** Right edge of the last painted glyph, in content-column space. */
    right: number
    /** How far past the drawable canvas it reached. */
    over: number
    marked: boolean
}

export interface OverrunReport {
    widths: number
    lines: number
    bleed: number
    /** Lines whose painted glyphs leave the canvas — must be empty. */
    clipped: Overrun[]
    /** Worst painted overshoot past the *column* (inside the bleed is fine). */
    worstPastColumn: number
    worstPastColumnMarked: boolean
    /** Lines that exceed the column only by trailing whitespace, which paints
     *  nothing. Informational: the original investigation found 47 of these. */
    whitespaceOnly: number
}

const measure = (() => {
    const ctx = document.createElement('canvas').getContext('2d')!
    return (text: string, font: string): number => {
        ctx.font = font
        return ctx.measureText(text).width
    }
})()

/**
 * Lay the document out at each width and measure what would actually be
 * painted, the same way `paintToCanvas` places it: a plain line is drawn at
 * `line.x`, a marked line one fragment at a time at `line.x + frag.x`.
 */
function overrun(widths: number[], paragraphs = 24): OverrunReport {
    const doc = markedDoc(paragraphs)
    const host = document.getElementById('stage')!
    const report: OverrunReport = {
        widths: widths.length, lines: 0, bleed: TEXT_BLEED,
        clipped: [], worstPastColumn: 0, worstPastColumnMarked: false,
        whitespaceOnly: 0,
    }

    for (const width of widths) {
        const container = document.createElement('div')
        host.appendChild(container)
        const ed = new CanvasEditor({
            state: EditorState.create({ doc, schema }),
            container,
            width,
            ...CHECK_OPTIONS,
        })
        ed.flush()

        for (const block of (ed as unknown as { lastLayouts: BlockLayout[] }).lastLayouts) {
            // Blocks laid into a narrower frame (table cells) are bounded by the
            // frame, not the column; this document has none, so skip defensively.
            if (block.isAtom) continue
            // A framed block (callout content) may not paint past its frame;
            // everything else is held to the column.
            const limit = block.frame ? block.frame.x + block.frame.width : width
            for (const line of block.lines) {
                report.lines++
                const marked = !!line.fragments?.length
                let right: number
                if (line.fragments?.length) {
                    right = 0
                    for (const f of line.fragments) {
                        // A chip paints its whole box, label and padding alike.
                        if (f.atom) {
                            right = Math.max(right, line.x + f.x + f.width)
                            continue
                        }
                        const painted = f.text.replace(/\s+$/, '')
                        if (!painted) continue
                        right = Math.max(right, line.x + f.x + measure(painted, f.font))
                    }
                } else {
                    const painted = line.text.replace(/\s+$/, '')
                    right = painted ? line.x + measure(painted, block.font) : 0
                }
                if (right === 0) continue

                const pastColumn = right - limit
                if (pastColumn > report.worstPastColumn) {
                    report.worstPastColumn = pastColumn
                    report.worstPastColumnMarked = marked
                }
                // Trailing whitespace pushed the line's own `width` past the
                // column (or frame) but paints nothing — the harmless majority.
                if (line.x + line.width > limit && pastColumn <= 0) report.whitespaceOnly++

                const over = right - (limit + TEXT_BLEED)
                if (over > 0.01) {
                    report.clipped.push({
                        width, blockType: block.type, over, right, marked,
                        lineText: line.text.slice(0, 60),
                    })
                }
            }
        }
        ed.destroy()
        container.remove()
    }
    return report
}

const CHECK_OPTIONS = {
    font: '16px Georgia, serif',
    lineHeight: 26,
    autofocus: false,
    containerNodes: { callout: { padding: { top: 10, right: 14, bottom: 10, left: 18 } } },
}

export interface IncrementalReport {
    edits: number
    /** Edits the incremental path handled (no full layout pass). */
    incremental: number
    /** Edits whose patched layout differed from a full pass — must be empty. */
    mismatches: { step: number, edit: string, field: string, got: unknown, want: unknown }[]
}

/** What painting and hit-testing read from a layout, rounded past float noise. */
function layoutSnapshot(ed: CanvasEditor): Record<string, unknown[]> {
    const s = ed as unknown as {
        ensureLayout(): void
        lastLayouts: BlockLayout[]
        lastContainers: { pos: number, x: number, y: number, width: number, height: number }[]
    }
    s.ensureLayout()
    const r = (n: number) => Math.round(n * 1000) / 1000
    return {
        blocks: s.lastLayouts.map((b) => [b.type, r(b.yOffset), r(b.height), b.pmStartPos, b.pmEndPos,
            b.lines.map((l) => [r(l.x), r(l.y), l.text, l.pmStart, r(l.width)])]),
        containers: s.lastContainers.map((c) => [c.pos, r(c.x), r(c.y), r(c.width), r(c.height)]),
    }
}

/**
 * The incremental layout path, checked against real metrics: apply seeded
 * random edits (half of them inside callouts, some nested), and after each one
 * compare the patched layout with a full pass over the same document. The
 * unit suite checks the same thing on mocked metrics; this one sees real line
 * breaks moving, wrapping and unwrapping.
 */
function incremental(steps = 60, width = 560): IncrementalReport {
    let seed = 0x5eed
    const rand = () => {
        seed = (seed + 0x6d2b79f5) | 0
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    const host = document.getElementById('stage')!
    const mount = (doc: PMNode) => {
        const container = document.createElement('div')
        host.appendChild(container)
        const ed = new CanvasEditor({ state: EditorState.create({ doc, schema }), container, width, ...CHECK_OPTIONS })
        return { ed, container }
    }
    const { ed, container } = mount(markedDoc(16))
    let fullPasses = 0
    const s = ed as unknown as { computeLayout(): unknown }
    const full = s.computeLayout.bind(ed)
    s.computeLayout = () => { fullPasses++; return full() }
    ed.flush()

    const report: IncrementalReport = { edits: steps, incremental: 0, mismatches: [] }
    for (let step = 0; step < steps; step++) {
        // Every textblock's content range, and whether it sits in a callout.
        const blocks: { from: number, to: number, framed: boolean }[] = []
        ed.state.doc.descendants((n, pos, parent) => {
            if (n.isTextblock) {
                blocks.push({ from: pos + 1, to: pos + 1 + n.content.size, framed: parent?.type.name === 'callout' })
            }
            return true
        })
        const pool = step % 2 === 0 ? blocks.filter((b) => b.framed) : blocks
        const b = pool[Math.floor(rand() * pool.length)]!
        const at = b.from + Math.floor(rand() * (b.to - b.from + 1))
        let tr = ed.state.tr
        let edit: string
        const kind = rand()
        if (kind < 0.5 || b.to === b.from) {
            const word = WORDS[Math.floor(rand() * WORDS.length)]!.repeat(1 + Math.floor(rand() * 4)) + ' '
            tr = tr.insertText(word, at)
            edit = `insert "${word}" at ${at}`
        } else if (kind < 0.85) {
            const end = Math.min(b.to, at + 1 + Math.floor(rand() * 30))
            const from = Math.min(at, end - 1)
            tr = tr.delete(from, end)
            edit = `delete ${from}..${end}`
        } else {
            tr = tr.split(at)
            edit = `split at ${at}`
        }
        const before = fullPasses
        ed.dispatch(tr)
        const got = layoutSnapshot(ed)
        if (fullPasses === before) report.incremental++

        const oracle = mount(ed.state.doc)
        const want = layoutSnapshot(oracle.ed)
        oracle.ed.destroy()
        oracle.container.remove()
        for (const field of Object.keys(want)) {
            const g = JSON.stringify(got[field])
            const w = JSON.stringify(want[field])
            if (g === w) continue
            // Report the first differing entry, not the whole document.
            const i = want[field]!.findIndex((x, k) => JSON.stringify(x) !== JSON.stringify(got[field]![k]))
            report.mismatches.push({ step, edit, field, got: got[field]![i], want: want[field]![i] })
        }
    }
    ed.destroy()
    container.remove()
    return report
}

;(window as unknown as { __overrun: typeof overrun }).__overrun = overrun
;(window as unknown as { __incremental: typeof incremental }).__incremental = incremental

// Visible affordance for running it by hand via `bun run dev:check`.
document.getElementById('run')!.addEventListener('click', () => {
    const widths: number[] = []
    for (let w = 320; w <= 920; w += 10) widths.push(w)
    const r = overrun(widths)
    document.getElementById('out')!.textContent = JSON.stringify(r, null, 2)
})
