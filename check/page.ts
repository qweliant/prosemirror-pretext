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
            if (w % 3 === 0) {
                const name = marks[(p + w) % marks.length]!
                inline.push(schema.text(word, [schema.marks[name]!.create()]))
            } else {
                inline.push(schema.text(word))
            }
            if (w < 43) inline.push(schema.text(' '))
        }
        blocks.push(p % 7 === 3
            ? schema.node('blockquote', null, [schema.node('paragraph', null, inline)])
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
            font: '16px Georgia, serif',
            lineHeight: 26,
            autofocus: false,
        })
        ed.flush()

        for (const block of (ed as unknown as { lastLayouts: BlockLayout[] }).lastLayouts) {
            // Blocks laid into a narrower frame (table cells) are bounded by the
            // frame, not the column; this document has none, so skip defensively.
            if (block.frame || block.isAtom) continue
            for (const line of block.lines) {
                report.lines++
                const marked = !!line.fragments?.length
                let right: number
                if (line.fragments?.length) {
                    right = 0
                    for (const f of line.fragments) {
                        const painted = f.text.replace(/\s+$/, '')
                        if (!painted) continue
                        right = Math.max(right, line.x + f.x + measure(painted, f.font))
                    }
                } else {
                    const painted = line.text.replace(/\s+$/, '')
                    right = painted ? line.x + measure(painted, block.font) : 0
                }
                if (right === 0) continue

                const pastColumn = right - width
                if (pastColumn > report.worstPastColumn) {
                    report.worstPastColumn = pastColumn
                    report.worstPastColumnMarked = marked
                }
                // Trailing whitespace pushed the line's own `width` past the
                // column but paints nothing — the harmless majority.
                if (line.width > width && pastColumn <= 0) report.whitespaceOnly++

                const over = right - (width + TEXT_BLEED)
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

;(window as unknown as { __overrun: typeof overrun }).__overrun = overrun

// Visible affordance for running it by hand via `bun run dev:check`.
document.getElementById('run')!.addEventListener('click', () => {
    const widths: number[] = []
    for (let w = 320; w <= 920; w += 10) widths.push(w)
    const r = overrun(widths)
    document.getElementById('out')!.textContent = JSON.stringify(r, null, 2)
})
