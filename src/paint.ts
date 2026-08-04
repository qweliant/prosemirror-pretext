/**
 * Canvas painting: turning positioned `BlockLayout`s into pixels.
 *
 * This is the back half of a frame and a strict consumer — it reads layout and
 * writes to a 2D context, and nothing here feeds back into layout. That is why
 * it extracts cleanly: its whole dependency on the editor is the `PaintContext`
 * below, which is the honest list of what drawing a frame needs.
 *
 * Paint order is load-bearing and matches the original single-pass routine:
 * block boxes → node decorations → mark highlights → inline-decoration
 * backgrounds → selection → text → inline-decoration lines → placeholder.
 * Backgrounds must land under the selection overlay so selected highlighted
 * text still reads as selected.
 */

import type { Node as PMNode } from 'prosemirror-model'
import type { Selection } from 'prosemirror-state'
import type {
    Decoration, InlineDecoration, NodeDecoration,
} from './decoration'
import type { BlockLayout, LineFragment, LineLayout, TableChrome } from './types'
import { TABLE_BORDER } from './constants'
import { isRuleNode, isDocEmpty } from './layout/blocks'
import { CellSelection } from './table-selection'

/**
 * Everything painting needs from the editor. Passed explicitly rather than
 * handing over the editor itself: it keeps the editor's fields private, and it
 * makes the coupling countable — if this grows, painting is learning things it
 * shouldn't know.
 */
export interface PaintContext
{
    canvas: HTMLCanvasElement
    /** Present only when virtualizing; supplies the visible window. */
    scroller: HTMLDivElement | null
    containerWidth: number
    font: string
    textColor: string
    firstLineColor: string
    selectionColor: string
    ruleColor: string
    /** Rules between and around table cells. Defaults to `ruleColor`. */
    tableBorderColor: string
    /** Fill behind header cells. */
    tableHeaderBackground: string
    placeholder: string
    placeholderColor: string
    /** Read only to decide whether the placeholder shows. */
    doc: PMNode
    selection: Selection
    /**
     * Horizontal position of a block-relative offset on a line. Owned by
     * coordinate mapping, not painting — selection and decoration rects need
     * the same measurement the caret uses, so it is threaded in rather than
     * duplicated.
     */
    xForOffsetInLine: (block: BlockLayout, line: LineLayout, offset: number) => number
}

/**
 * Pin the canvas to the viewport and stretch the stack to the full document
 * height when virtualizing, so the scroller's scrollbar spans the whole
 * document while the canvas only ever covers one viewport. Reverts to in-flow,
 * full-height painting otherwise.
 */
export function applyVirtualLayout(
    canvas: HTMLCanvasElement,
    stack: HTMLDivElement,
    virtualized: boolean,
    totalHeight: number,
): void
{
    if (virtualized)
    {
        if (canvas.style.position !== 'sticky')
        {
            canvas.style.position = 'sticky'
            canvas.style.top = '0'
        }
        stack.style.height = `${totalHeight}px`
    }
    else if (canvas.style.position === 'sticky')
    {
        canvas.style.position = ''
        canvas.style.top = ''
        stack.style.height = ''
    }
}

export function paintToCanvas(
    cx: PaintContext,
    layouts: BlockLayout[],
    totalHeight: number,
    virtualized: boolean,
    decorations: Decoration[] = [],
    tables: TableChrome[] = [],
    sortedByY = false,
): void
{
    const inlineDecos = decorations.filter((d): d is InlineDecoration => d.kind === 'inline')
    const nodeDecos = decorations.filter((d): d is NodeDecoration => d.kind === 'node')
    const dpr = window.devicePixelRatio || 1
    const cssWidth = cx.containerWidth

    const viewH = virtualized ? cx.scroller!.clientHeight : 0
    const scrollTop = virtualized ? cx.scroller!.scrollTop : 0
    // When the doc is shorter than the viewport there is nothing to
    // scroll, so the canvas need only cover the content.
    const cssHeight = virtualized ? Math.min(viewH, totalHeight) : totalHeight

    const targetW = Math.round(cssWidth * dpr)
    const targetH = Math.round(cssHeight * dpr)

    if (cx.canvas.width !== targetW || cx.canvas.height !== targetH)
    {
        cx.canvas.width = targetW
        cx.canvas.height = targetH
        cx.canvas.style.width = `${cssWidth}px`
        cx.canvas.style.height = `${cssHeight}px`
    }

    const ctx = cx.canvas.getContext('2d')!
    // Scale for HiDPI, then shift document-space coords up by scrollTop so
    // only the visible slice lands on the canvas. All downstream painting
    // (selection, caret) keeps working in document space unchanged.
    ctx.setTransform(dpr, 0, 0, dpr, 0, -scrollTop * dpr)
    ctx.clearRect(0, scrollTop, cssWidth, cssHeight)

    const viewTop = scrollTop
    const viewBottom = scrollTop + cssHeight

    const isVisible = (block: BlockLayout) =>
        !virtualized
        || (block.yOffset + block.height >= viewTop && block.yOffset <= viewBottom)

    // The slice of `layouts` worth walking at all. Pure and exported so the
    // window can be tested against a brute-force filter — a wrong window drops
    // blocks from the frame, which a stubbed test canvas cannot observe.
    const [lo, hi] = visibleRange(layouts, viewTop, viewBottom, virtualized && sortedByY)
    const visible = lo === 0 && hi === layouts.length ? layouts : layouts.slice(lo, hi)

    // Table chrome underlies everything: header fills, then rules. Drawn
    // before block boxes so a cell's own background still paints over its fill.
    for (const t of tables)
    {
        if (t.height === 0) continue
        if (t.y + t.height < viewTop || t.y > viewBottom) continue
        paintTableChrome(cx, ctx, t)
    }

    // Block box decorations (code-block panel, blockquote bar) paint first,
    // beneath highlights, selection, and text.
    for (const block of visible)
    {
        if (!isVisible(block)) continue
        if (block.isAtom && isRuleNode(block.node))
        {
            ctx.fillStyle = cx.ruleColor
            ctx.fillRect(0, Math.round(block.yOffset + block.height / 2), cx.containerWidth, 2)
            continue
        }
        if (!block.background && !block.borderLeft) continue
        if (block.background)
        {
            ctx.fillStyle = block.background
            ctx.fillRect(0, block.yOffset, cx.containerWidth, block.height)
        }
        if (block.borderLeft)
        {
            ctx.fillStyle = block.borderLeft.color
            ctx.fillRect(0, block.yOffset, block.borderLeft.width, block.height)
        }
    }

    // Node decorations: a transient background / left bar over a whole block.
    for (const nd of nodeDecos)
    {
        const block = layouts.find(
            (b) => b.pmStartPos - 1 === nd.from || b.pmStartPos === nd.from,
        )
        if (!block || !isVisible(block)) continue
        if (nd.style.background)
        {
            ctx.fillStyle = nd.style.background
            ctx.fillRect(0, block.yOffset, cx.containerWidth, block.height)
        }
        if (nd.style.borderLeft)
        {
            ctx.fillStyle = nd.style.borderLeft.color
            ctx.fillRect(0, block.yOffset, nd.style.borderLeft.width, block.height)
        }
    }

    // Highlight backgrounds paint under everything (before the selection
    // overlay, so selecting highlighted text still shows the selection).
    for (const block of visible)
    {
        if (!isVisible(block)) continue
        for (const line of block.lines)
        {
            if (!line.fragments) continue
            for (const frag of line.fragments)
            {
                if (!frag.background) continue
                ctx.fillStyle = frag.background
                ctx.fillRect(line.x + frag.x, line.y, frag.width, block.lineHeight)
            }
        }
    }

    // Inline decoration backgrounds (e.g. search highlight) — under selection.
    for (const d of inlineDecos)
    {
        if (!d.style.background) continue
        ctx.fillStyle = d.style.background
        forEachRangeRect(cx, layouts, d.from, d.to, (r) =>
        {
            if (r.y + r.h >= viewTop && r.y <= viewBottom) ctx.fillRect(r.x, r.y, r.w, r.h)
        })
    }

    const sel = cx.selection
    if (sel instanceof CellSelection)
    {
        // A cell selection is a shape, not a range: fill each selected cell's
        // whole box rather than tracing line rects through structural tokens.
        const selected = new Set(sel.cells.map((c) => c.pos))
        ctx.fillStyle = cx.selectionColor
        for (const t of tables)
        {
            for (const c of t.cells)
            {
                if (selected.has(c.pos)) ctx.fillRect(c.x, c.y, c.width, c.height)
            }
        }
    }
    else if (!sel.empty)
    {
        ctx.fillStyle = cx.selectionColor
        paintSelectionRects(cx, ctx, layouts, sel.from, sel.to)
    }

    ctx.font = cx.font
    ctx.textBaseline = 'top'

    for (const block of visible)
    {
        // Cull blocks fully outside the viewport — the per-block yOffsets
        // are the spatial index.
        if (virtualized
            && (block.yOffset + block.height < viewTop || block.yOffset > viewBottom))
        {
            continue
        }

        // List marker (bullet/number) in the gutter of the first line.
        if (block.marker && block.lines.length > 0)
        {
            ctx.font = block.font
            ctx.fillStyle = cx.textColor
            ctx.fillText(block.marker.text, block.marker.x, block.lines[0].y)
        }

        for (let i = 0; i < block.lines.length; i++)
        {
            const line = block.lines[i]
            const lineColor = block.color ?? (i === 0 ? cx.firstLineColor : cx.textColor)

            if (line.fragments)
            {
                // Marked line: paint each run with its own font/color. A
                // null fragment color falls back to the line color so plain
                // runs keep the first-line accent.
                for (const frag of line.fragments)
                {
                    ctx.font = frag.font
                    ctx.fillStyle = frag.color ?? lineColor
                    const fy = line.y + (frag.baselineShift ?? 0)
                    ctx.fillText(frag.text, line.x + frag.x, fy)
                    if (frag.underline || frag.strikethrough)
                    {
                        paintDecoration(ctx, frag, line, frag.baselineShift ?? 0, block.fontSize)
                    }
                }
            }
            else
            {
                ctx.font = block.font
                ctx.fillStyle = lineColor
                ctx.fillText(line.text, line.x, line.y)
            }
        }
    }

    // Inline decoration lines (underline / spellcheck squiggle / strike) —
    // painted over the text.
    for (const d of inlineDecos)
    {
        const { underline, strikethrough, wavy } = d.style
        if (!underline && !strikethrough) continue
        forEachRangeRect(cx, layouts, d.from, d.to, (r) =>
        {
            if (r.y + r.h < viewTop || r.y > viewBottom) return
            if (underline)
            {
                const y = r.y + Math.round(r.h * 0.82)
                if (wavy) paintWavy(ctx, r.x, r.x + r.w, y, underline)
                else
                {
                    ctx.fillStyle = underline
                    ctx.fillRect(r.x, y, r.w, 2)
                }
            }
            if (strikethrough)
            {
                ctx.fillStyle = strikethrough
                ctx.fillRect(r.x, r.y + Math.round(r.h * 0.5), r.w, 2)
            }
        })
    }

    // Placeholder prompt when the whole document is empty.
    if (cx.placeholder && isDocEmpty(cx.doc) && layouts.length > 0)
    {
        const block = layouts[0]
        const line = block.lines[0]
        ctx.font = block.font
        ctx.fillStyle = cx.placeholderColor
        ctx.fillText(cx.placeholder, line.x, line.y)
    }
}

/** A wavy line from x1→x2 at baseline y (spellcheck-squiggle underline). */
function paintWavy(
    ctx: CanvasRenderingContext2D,
    x1: number,
    x2: number,
    y: number,
    color: string,
): void
{
    ctx.save()
    ctx.strokeStyle = color
    ctx.lineWidth = 1.4
    ctx.beginPath()
    const amp = 1.6
    const period = 5
    for (let x = x1; x <= x2; x++)
    {
        const yy = y + Math.sin(((x - x1) / period) * Math.PI) * amp
        if (x === x1) ctx.moveTo(x, yy)
        else ctx.lineTo(x, yy)
    }
    ctx.stroke()
    ctx.restore()
}

/** Underline / strikethrough lines for a run, in the current fill color. */
function paintDecoration(
    ctx: CanvasRenderingContext2D,
    frag: LineFragment,
    line: LineLayout,
    shift: number,
    fontSize: number,
): void
{
    const x = line.x + frag.x
    const thickness = Math.max(1, Math.round(fontSize / 14))
    if (frag.underline)
    {
        ctx.fillRect(x, line.y + shift + Math.round(fontSize * 0.92), frag.width, thickness)
    }
    if (frag.strikethrough)
    {
        ctx.fillRect(x, line.y + shift + Math.round(fontSize * 0.52), frag.width, thickness)
    }
}

/** Invoke `cb` with the canvas rect of each line-slice of doc range
 *  [from, to). Used by inline decorations (and shaped like selection rects). */
function forEachRangeRect(
    cx: PaintContext,
    layouts: BlockLayout[],
    from: number,
    to: number,
    cb: (r: { x: number, y: number, w: number, h: number }) => void,
): void
{
    for (const block of layouts)
    {
        if (block.isAtom || block.text.length === 0) continue
        if (block.pmEndPos < from || block.pmStartPos > to) continue
        for (let li = 0; li < block.lines.length; li++)
        {
            const line = block.lines[li]
            const isLast = li === block.lines.length - 1
            const lineStart = block.pmStartPos + line.pmStart
            const lineEnd = block.pmStartPos
                + (isLast ? block.text.length : block.lines[li + 1].pmStart)
            if (lineEnd < from || lineStart > to) continue
            const a = Math.max(from, lineStart)
            const b = Math.min(to, lineEnd)
            const x1 = cx.xForOffsetInLine(block, line, a - block.pmStartPos)
            const x2 = cx.xForOffsetInLine(block, line, b - block.pmStartPos)
            if (x2 > x1) cb({ x: x1, y: line.y, w: x2 - x1, h: block.lineHeight })
        }
    }
}

function paintSelectionRects(
    cx: PaintContext,
    ctx: CanvasRenderingContext2D,
    layouts: BlockLayout[],
    from: number,
    to: number,
): void
{
    for (const block of layouts)
    {
        if (block.pmEndPos < from || block.pmStartPos > to) continue

        // Selected atom block: box its whole region (node selection).
        if (block.isAtom)
        {
            if (from <= block.pmStartPos && to >= block.pmEndPos)
            {
                ctx.fillRect(0, block.yOffset, cx.containerWidth, block.height)
            }
            continue
        }

        // Empty paragraph fully inside the selection range: paint a stub.
        if (block.text.length === 0)
        {
            if (from <= block.pmStartPos && to >= block.pmEndPos)
            {
                const line = block.lines[0]
                ctx.fillRect(line.x, line.y, block.lineHeight / 3, block.lineHeight)
            }
            continue
        }

        for (let li = 0; li < block.lines.length; li++)
        {
            const line = block.lines[li]
            const isLast = li === block.lines.length - 1
            const lineStart = block.pmStartPos + line.pmStart
            const lineEnd = block.pmStartPos
                + (isLast ? block.text.length : block.lines[li + 1].pmStart)

            if (lineEnd < from) continue
            if (lineStart > to) break

            const a = Math.max(from, lineStart)
            const x1 = cx.xForOffsetInLine(block, line, a - block.pmStartPos)

            // Selection continuing past this line trails to the container
            // edge; otherwise stop at the selection end on this line.
            const x2 = to > lineEnd
                ? line.x + cx.containerWidth
                : cx.xForOffsetInLine(block, line, Math.min(to, lineEnd) - block.pmStartPos)

            if (x2 > x1)
            {
                ctx.fillRect(x1, line.y, x2 - x1, block.lineHeight)
            }
        }
    }
}

/**
 * The grid: header fills, then one rule per cell edge. Cells are adjacent, so
 * neighbouring rules land on identical coordinates and coincide rather than
 * doubling — which is what makes this read as collapsed borders without any
 * edge bookkeeping.
 */
function paintTableChrome(
    cx: PaintContext,
    ctx: CanvasRenderingContext2D,
    t: TableChrome,
): void
{
    for (const c of t.cells)
    {
        if (!c.header) continue
        ctx.fillStyle = cx.tableHeaderBackground
        ctx.fillRect(c.x, c.y, c.width, c.height)
    }

    ctx.fillStyle = cx.tableBorderColor
    const b = TABLE_BORDER
    for (const c of t.cells)
    {
        ctx.fillRect(c.x, c.y, c.width, b)                 // top
        ctx.fillRect(c.x, c.y + c.height - b, c.width, b)  // bottom
        ctx.fillRect(c.x, c.y, b, c.height)                // left
        ctx.fillRect(c.x + c.width - b, c.y, b, c.height)  // right
    }
}


/**
 * The half-open index range of `layouts` that can intersect [viewTop,
 * viewBottom].
 *
 * Culling per block still costs a pass over every block in the document, which
 * is what made frame time grow with document size even though a keystroke did
 * not. When layouts are sorted by y the window is a binary search instead,
 * making a frame O(visible + log n).
 *
 * `sorted` must be false whenever a float or a table is in play: position order
 * is then not vertical order (two cells in a row share a band, so a multi-block
 * cell yields y values like 7, 53, 7), and narrowing would drop blocks. The
 * whole array is returned in that case, which is what the code did before.
 */
export function visibleRange(
    layouts: BlockLayout[],
    viewTop: number,
    viewBottom: number,
    sorted: boolean,
): [number, number]
{
    if (!sorted || layouts.length === 0) return [0, layouts.length]

    // First block whose bottom reaches the viewport. Heights vary, so search on
    // `yOffset` then widen left while a taller predecessor still overlaps.
    let a = 0
    let b = layouts.length
    while (a < b)
    {
        const mid = (a + b) >> 1
        if (layouts[mid].yOffset < viewTop) a = mid + 1
        else b = mid
    }
    let lo = a
    while (lo > 0 && layouts[lo - 1].yOffset + layouts[lo - 1].height >= viewTop) lo--

    // First block starting past the viewport.
    a = lo
    b = layouts.length
    while (a < b)
    {
        const mid = (a + b) >> 1
        if (layouts[mid].yOffset <= viewBottom) a = mid + 1
        else b = mid
    }
    return [lo, a]
}
