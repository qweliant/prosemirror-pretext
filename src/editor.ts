import { type Node as PMNode } from 'prosemirror-model'
import { EditorState, TextSelection, type Transaction } from 'prosemirror-state'
import { joinBackward, joinForward } from 'prosemirror-commands'
import {
    prepareWithSegments,
    layoutWithLines,
    type LayoutLine,
    type PreparedTextWithSegments,
} from '@chenglou/pretext'


// ─── Public Types ──────────────────────────────────────────────────────────

export interface CanvasEditorOptions
{
    /** Initial ProseMirror state (includes schema + doc). */
    state: EditorState
    /** Container element — the editor creates its own canvas + textarea inside it. */
    container: HTMLElement
    /** CSS font string for text rendering. Default: '16px Inter'. */
    font?: string
    /** Line height in px. Default: 26. */
    lineHeight?: number
    /** Content area width in px. Default: 460. */
    width?: number
    /** Gap between block nodes in px. Default: 20. */
    blockGap?: number
    /** Main text color. Default: '#d4d4d8'. */
    textColor?: string
    /** First-line accent color. Default: '#818cf8'. */
    firstLineColor?: string
    /** Caret color. Default: '#a5b4fc'. */
    caretColor?: string
    /** Selection highlight color. Default: 'rgba(129, 140, 248, 0.25)'. */
    selectionColor?: string
    /** If set, the content area scrolls when it exceeds this height in px. */
    maxHeight?: number
    /** Called after every render with timing/cache stats. */
    onRender?: (stats: RenderStats) => void
}

export interface RenderStats
{
    blockCount: number
    lineCount: number
    cacheHits: number
    cacheMisses: number
    renderTimeMs: number
}

export interface LineLayout
{
    text: string
    width: number
    x: number
    y: number
}

export interface BlockLayout
{
    type: string
    node: PMNode
    text: string
    yOffset: number
    height: number
    lines: LineLayout[]
    pmStartPos: number
    pmEndPos: number
}


// ─── Internal Types ────────────────────────────────────────────────────────

interface CachedBlock
{
    prepared: PreparedTextWithSegments | null
    width: number
    lineHeight: number
    lines: LayoutLine[]
    height: number
}


// ─── Editor ────────────────────────────────────────────────────────────────

export class CanvasEditor
{
    // ─── Config ────────────────────────────────────────────────────────
    private readonly font: string
    private readonly lineHeight: number
    private readonly containerWidth: number
    private readonly blockGap: number
    private readonly textColor: string
    private readonly firstLineColor: string
    private readonly caretColor: string
    private readonly selectionColor: string
    private readonly maxHeight: number | null
    private readonly caretWidth = 2
    private readonly caretBlinkMs = 530
    private readonly caretHoldMs = 500
    private readonly onRender?: (stats: RenderStats) => void

    // ─── State ─────────────────────────────────────────────────────────
    state: EditorState

    // ─── DOM ───────────────────────────────────────────────────────────
    private readonly container: HTMLElement
    private readonly scroller: HTMLDivElement | null
    private readonly stack: HTMLDivElement
    private readonly canvas: HTMLCanvasElement
    private readonly textarea: HTMLTextAreaElement
    private readonly measureCtx: CanvasRenderingContext2D

    // ─── Layout ────────────────────────────────────────────────────────
    private readonly layoutCache = new WeakMap<PMNode, CachedBlock>()
    private lastLayouts: BlockLayout[] = []
    private cacheHits = 0
    private cacheMisses = 0

    // ─── Render ────────────────────────────────────────────────────────
    private pendingRender = false
    // Set when the caret moves (dispatch) so the next render scrolls it into
    // view. Renders from plain scrolling or caret blink leave it false, so the
    // user can freely scroll away from the caret without the view snapping back.
    private scrollCaretIntoView = false

    // ─── Caret ─────────────────────────────────────────────────────────
    private caretVisible = true
    private lastInputTime = 0
    private blinkInterval: ReturnType<typeof setInterval> | null = null

    // ─── Input ─────────────────────────────────────────────────────────
    private composing = false
    private abortController: AbortController | null = null
    private dragging = false

    // ─── Vertical Navigation ───────────────────────────────────────────
    // Target X pinned across consecutive vertical moves so the caret
    // drifts back to its original column when passing through short lines.
    // Reset by any horizontal motion (see dispatch).
    private phantomX: number | null = null

    // ─── Caret Bias (soft-wrap affinity) ───────────────────────────────
    // A PM position at a soft-wrap boundary is ambiguous: it is both the end
    // of the upper line and the start of the lower line. caretBias picks which
    // one the caret renders on. -1 = end of upper line (the default, matching
    // a click/step that arrives from the left); +1 = start of lower line.
    // Reset to -1 on every dispatch; re-pinned by click / vertical motion so
    // the caret lands on the line the user actually moved to.
    private caretBias: -1 | 1 = -1

    // ─── Grapheme Awareness ────────────────────────────────────────────
    // PM positions are UTF-16 code units; perceived characters can span
    // multiple. We use Intl.Segmenter to step/delete by grapheme so emoji,
    // flags, and combining marks behave atomically.
    private readonly segmenter = new Intl.Segmenter(undefined, {
        granularity: 'grapheme',
    })

    constructor(options: CanvasEditorOptions)
    {
        this.state = options.state
        this.container = options.container
        this.font = options.font ?? '16px Inter'
        this.lineHeight = options.lineHeight ?? 26
        this.containerWidth = options.width ?? 460
        this.blockGap = options.blockGap ?? 20
        this.textColor = options.textColor ?? '#d4d4d8'
        this.firstLineColor = options.firstLineColor ?? '#818cf8'
        this.caretColor = options.caretColor ?? '#a5b4fc'
        this.selectionColor = options.selectionColor ?? 'rgba(129, 140, 248, 0.25)'
        this.maxHeight = options.maxHeight ?? null
        this.onRender = options.onRender

        // Build DOM
        const stack = document.createElement('div')
        stack.style.position = 'relative'
        stack.style.cursor = 'text'
        this.stack = stack

        this.canvas = document.createElement('canvas')
        this.canvas.style.display = 'block'

        this.textarea = document.createElement('textarea')
        Object.assign(this.textarea.style, {
            position: 'absolute',
            top: '0', left: '0',
            width: '1px', height: '1px',
            padding: '0', margin: '0', border: '0', outline: '0',
            background: 'transparent', color: 'transparent',
            caretColor: 'transparent',
            resize: 'none', overflow: 'hidden', whiteSpace: 'nowrap',
            font: 'inherit', zIndex: '2',
            pointerEvents: 'none',
            transform: 'translate(0, 0)',
        })
        this.textarea.autocapitalize = 'off'
        this.textarea.autocomplete = 'off'
        this.textarea.spellcheck = false
        this.textarea.tabIndex = 0

        stack.appendChild(this.canvas)
        stack.appendChild(this.textarea)

        if (this.maxHeight !== null)
        {
            this.scroller = document.createElement('div')
            this.scroller.style.maxHeight = `${this.maxHeight}px`
            this.scroller.style.overflowY = 'auto'
            this.scroller.style.width = `${this.containerWidth}px`
            this.scroller.appendChild(stack)
            this.container.appendChild(this.scroller)
        }
        else
        {
            this.scroller = null
            this.container.appendChild(stack)
        }

        // Dedicated measurement context (avoids touching the paint context)
        const mc = document.createElement('canvas')
        this.measureCtx = mc.getContext('2d')!

        this.setupInput()
        this.startCaretBlink()
        this.render()
    }

    // ─── Public API ────────────────────────────────────────────────────

    dispatch(tr: Transaction): void
    {
        this.state = this.state.apply(tr)
        this.lastInputTime = performance.now()
        this.caretVisible = true
        this.scrollCaretIntoView = true
        // Horizontal motion resets the phantom X and caret bias. Click and
        // moveVertical restore them after dispatching.
        this.phantomX = null
        this.caretBias = -1
        this.scheduleRender()
    }

    focus(): void
    {
        this.textarea.focus()
    }

    destroy(): void
    {
        if (this.blinkInterval !== null)
        {
            clearInterval(this.blinkInterval)
            this.blinkInterval = null
        }
        this.abortController?.abort()
        this.container.innerHTML = ''
    }

    // ─── Layout (cache-aware) ──────────────────────────────────────────

    private computeLayout(): { layouts: BlockLayout[], totalHeight: number }
    {
        this.cacheHits = 0
        this.cacheMisses = 0

        const result: BlockLayout[] = []
        let cursorY = 0

        this.state.doc.forEach((node, offset) =>
        {
            let cached = this.layoutCache.get(node)

            if (
                !cached
                || cached.width !== this.containerWidth
                || cached.lineHeight !== this.lineHeight
            )
            {
                const text = node.textContent
                if (text.length === 0)
                {
                    cached = {
                        prepared: null,
                        width: this.containerWidth,
                        lineHeight: this.lineHeight,
                        lines: [],
                        height: 0,
                    }
                }
                else
                {
                    const prepared = prepareWithSegments(text, this.font)
                    const { lines, height } = layoutWithLines(
                        prepared, this.containerWidth, this.lineHeight,
                    )
                    cached = {
                        prepared,
                        width: this.containerWidth,
                        lineHeight: this.lineHeight,
                        lines,
                        height,
                    }
                }
                this.layoutCache.set(node, cached)
                this.cacheMisses++
            }
            else
            {
                this.cacheHits++
            }

            const positioned: LineLayout[] = cached.lines.map((line, i) => ({
                text: line.text,
                width: line.width,
                x: 0,
                y: cursorY + i * this.lineHeight,
            }))

            if (positioned.length === 0)
            {
                positioned.push({ text: '', width: 0, x: 0, y: cursorY })
            }

            const blockHeight = positioned.length * this.lineHeight

            result.push({
                type: node.type.name,
                node,
                text: node.textContent,
                yOffset: cursorY,
                height: blockHeight,
                lines: positioned,
                pmStartPos: offset + 1,
                pmEndPos: offset + 1 + node.textContent.length,
            })

            cursorY += blockHeight + this.blockGap
        })

        const totalHeight = Math.max(this.lineHeight, cursorY - this.blockGap)
        return { layouts: result, totalHeight }
    }

    // ─── Painting ──────────────────────────────────────────────────────

    /**
     * Pin the canvas to the viewport and stretch the stack to the full
     * document height when virtualizing, so the scroller's scrollbar spans
     * the whole document while the canvas only ever covers one viewport.
     * Reverts to in-flow, full-height painting otherwise.
     */
    private applyVirtualLayout(virtualized: boolean, totalHeight: number): void
    {
        if (virtualized)
        {
            if (this.canvas.style.position !== 'sticky')
            {
                this.canvas.style.position = 'sticky'
                this.canvas.style.top = '0'
            }
            this.stack.style.height = `${totalHeight}px`
        }
        else if (this.canvas.style.position === 'sticky')
        {
            this.canvas.style.position = ''
            this.canvas.style.top = ''
            this.stack.style.height = ''
        }
    }

    private paintToCanvas(
        layouts: BlockLayout[],
        totalHeight: number,
        virtualized: boolean,
    ): void
    {
        const dpr = window.devicePixelRatio || 1
        const cssWidth = this.containerWidth

        const viewH = virtualized ? this.scroller!.clientHeight : 0
        const scrollTop = virtualized ? this.scroller!.scrollTop : 0
        // When the doc is shorter than the viewport there is nothing to
        // scroll, so the canvas need only cover the content.
        const cssHeight = virtualized
            ? Math.min(viewH, totalHeight)
            : totalHeight

        const targetW = Math.round(cssWidth * dpr)
        const targetH = Math.round(cssHeight * dpr)

        if (this.canvas.width !== targetW || this.canvas.height !== targetH)
        {
            this.canvas.width = targetW
            this.canvas.height = targetH
            this.canvas.style.width = `${cssWidth}px`
            this.canvas.style.height = `${cssHeight}px`
        }

        const ctx = this.canvas.getContext('2d')!
        // Scale for HiDPI, then shift document-space coords up by scrollTop so
        // only the visible slice lands on the canvas. All downstream painting
        // (selection, caret) keeps working in document space unchanged.
        ctx.setTransform(dpr, 0, 0, dpr, 0, -scrollTop * dpr)
        ctx.clearRect(0, scrollTop, cssWidth, cssHeight)

        const viewTop = scrollTop
        const viewBottom = scrollTop + cssHeight

        const sel = this.state.selection
        if (!sel.empty)
        {
            ctx.fillStyle = this.selectionColor
            this.paintSelectionRects(ctx, layouts, sel.from, sel.to)
        }

        ctx.font = this.font
        ctx.textBaseline = 'top'

        for (const block of layouts)
        {
            // Cull blocks fully outside the viewport — the per-block yOffsets
            // are the spatial index.
            if (
                virtualized
                && (block.yOffset + block.height < viewTop
                    || block.yOffset > viewBottom)
            )
            {
                continue
            }

            for (let i = 0; i < block.lines.length; i++)
            {
                const line = block.lines[i]
                ctx.fillStyle = i === 0 ? this.firstLineColor : this.textColor
                ctx.fillText(line.text, line.x, line.y)
            }
        }
    }

    private paintSelectionRects(
        ctx: CanvasRenderingContext2D,
        layouts: BlockLayout[],
        from: number,
        to: number,
    ): void
    {
        this.measureCtx.font = this.font
        const stubWidth = this.lineHeight / 3

        for (const block of layouts)
        {
            if (block.pmEndPos < from || block.pmStartPos > to) continue

            // Empty paragraph fully inside the selection range: paint a stub.
            if (block.text.length === 0)
            {
                if (from <= block.pmStartPos && to >= block.pmEndPos)
                {
                    const line = block.lines[0]
                    ctx.fillRect(line.x, line.y, stubWidth, this.lineHeight)
                }
                continue
            }

            let consumed = 0
            for (let li = 0; li < block.lines.length; li++)
            {
                const line = block.lines[li]
                const lineStart = block.pmStartPos + consumed
                const lineEnd = lineStart + line.text.length
                consumed += line.text.length

                if (lineEnd < from) continue
                if (lineStart > to) break

                const selStartInLine = Math.max(0, from - lineStart)
                const selEndInLine = Math.min(line.text.length, to - lineStart)

                const x1 = selStartInLine === 0
                    ? line.x
                    : line.x + this.measureCtx.measureText(
                        line.text.substring(0, selStartInLine),
                    ).width

                let x2: number
                if (to > lineEnd)
                {
                    // Selection continues past this line — trail to container edge.
                    x2 = line.x + this.containerWidth
                }
                else
                {
                    x2 = selEndInLine === 0
                        ? line.x
                        : line.x + this.measureCtx.measureText(
                            line.text.substring(0, selEndInLine),
                        ).width
                }

                if (x2 > x1)
                {
                    ctx.fillRect(x1, line.y, x2 - x1, this.lineHeight)
                }
            }
        }
    }

    // ─── Caret + Coordinate Mapping ────────────────────────────────────

    private posToCoords(layouts: BlockLayout[], pos: number): { x: number, y: number } | null
    {
        for (const block of layouts)
        {
            if (pos >= block.pmStartPos && pos <= block.pmEndPos)
            {
                return this.offsetToCoordsInBlock(block, pos - block.pmStartPos)
            }
        }
        if (layouts.length > 0)
        {
            const last = layouts[layouts.length - 1]
            return this.offsetToCoordsInBlock(last, last.text.length)
        }
        return null
    }

    private offsetToCoordsInBlock(
        block: BlockLayout,
        offsetInBlock: number,
    ): { x: number, y: number }
    {
        this.measureCtx.font = this.font

        let consumed = 0
        for (let i = 0; i < block.lines.length; i++)
        {
            const line = block.lines[i]
            const lineLen = line.text.length
            const isLast = i === block.lines.length - 1
            const lineEnd = consumed + lineLen

            // A position exactly at this line's end boundary normally renders
            // here, but a +1 bias leans it onto the next line's start instead
            // (the two are the same PM offset across a soft wrap).
            const leansToNextLine =
                offsetInBlock === lineEnd && !isLast && this.caretBias === 1

            if (!leansToNextLine && (offsetInBlock <= lineEnd || isLast))
            {
                const offsetInLine = Math.max(0, Math.min(lineLen, offsetInBlock - consumed))
                const w = offsetInLine === 0
                    ? 0
                    : this.measureCtx.measureText(line.text.substring(0, offsetInLine)).width
                return { x: line.x + w, y: line.y }
            }

            consumed = lineEnd
        }

        return { x: 0, y: block.yOffset }
    }

    private ensureCaretVisible(coords: { x: number, y: number }): void
    {
        if (!this.scroller) return
        const scrollTop = this.scroller.scrollTop
        const viewH = this.scroller.clientHeight
        const caretTop = coords.y
        const caretBottom = coords.y + this.lineHeight
        if (caretTop < scrollTop)
        {
            this.scroller.scrollTop = caretTop
        }
        else if (caretBottom > scrollTop + viewH)
        {
            this.scroller.scrollTop = caretBottom - viewH
        }
    }

    private paintCaret(coords: { x: number, y: number } | null): void
    {
        if (!coords || !this.caretVisible) return
        if (!this.state.selection.empty) return
        const ctx = this.canvas.getContext('2d')!
        ctx.fillStyle = this.caretColor
        ctx.fillRect(coords.x, coords.y, this.caretWidth, this.lineHeight)
    }

    // ─── Click → Doc Position ──────────────────────────────────────────

    /**
     * Map a mouse event to document-space canvas coords. When virtualized the
     * canvas is pinned to the viewport, so its rect is viewport-relative —
     * adding scrollTop recovers the document Y. scrollTop is 0 otherwise.
     */
    private eventToDocCoords(e: MouseEvent): { x: number, y: number }
    {
        const rect = this.canvas.getBoundingClientRect()
        return {
            x: e.clientX - rect.left,
            y: e.clientY - rect.top + (this.scroller?.scrollTop ?? 0),
        }
    }

    private clickToPos(
        layouts: BlockLayout[],
        canvasX: number,
        canvasY: number,
    ): { pos: number, bias: -1 | 1 } | null
    {
        if (layouts.length === 0) return null

        let block: BlockLayout | null = null
        for (const b of layouts)
        {
            if (canvasY >= b.yOffset && canvasY < b.yOffset + b.height)
            {
                block = b
                break
            }
        }
        if (!block)
        {
            // canvasY landed in an inter-block gap (or past either end). Snap
            // to the vertically nearest block — defaulting to the last block
            // would teleport the caret to the end of the document whenever a
            // click or drag crossed the gap between two paragraphs.
            let bestDist = Infinity
            for (const b of layouts)
            {
                const dist = canvasY < b.yOffset
                    ? b.yOffset - canvasY
                    : canvasY - (b.yOffset + b.height)
                if (dist < bestDist)
                {
                    bestDist = dist
                    block = b
                }
            }
            block = block ?? layouts[layouts.length - 1]
        }

        let lineIdx = 0
        for (let i = 0; i < block.lines.length; i++)
        {
            if (canvasY >= block.lines[i].y && canvasY < block.lines[i].y + this.lineHeight)
            {
                lineIdx = i
                break
            }
            if (i === block.lines.length - 1) lineIdx = i
        }
        const line = block.lines[lineIdx]
        if (line.text.length === 0) return { pos: block.pmStartPos, bias: -1 }

        this.measureCtx.font = this.font
        const targetX = Math.max(0, canvasX - line.x)

        // Search only over grapheme boundaries so we never land mid-grapheme
        // (avoids splitting surrogate pairs, ZWJ sequences, combining marks).
        const bounds = this.graphemeBoundaries(line.text)
        let lo = 0
        let hi = bounds.length - 1
        while (lo < hi)
        {
            const mid = (lo + hi + 1) >> 1
            const w = this.measureCtx.measureText(
                line.text.substring(0, bounds[mid]),
            ).width
            if (w <= targetX) lo = mid
            else hi = mid - 1
        }

        let offsetInLine = bounds[lo]
        if (lo < bounds.length - 1)
        {
            const wLo = bounds[lo] === 0
                ? 0
                : this.measureCtx.measureText(
                    line.text.substring(0, bounds[lo]),
                ).width
            const wHi = this.measureCtx.measureText(
                line.text.substring(0, bounds[lo + 1]),
            ).width
            if ((targetX - wLo) > (wHi - targetX)) offsetInLine = bounds[lo + 1]
        }

        let charOffsetInBlock = 0
        for (let i = 0; i < lineIdx; i++)
        {
            charOffsetInBlock += block.lines[i].text.length
        }
        charOffsetInBlock = Math.min(block.text.length, charOffsetInBlock + offsetInLine)

        // When the click lands at the very start of a wrapped line (not the
        // first line of the block), that offset is shared with the previous
        // line's end — bias +1 so the caret renders on the line clicked, not
        // the one above. Every other case keeps the default -1.
        const bias: -1 | 1 = lineIdx > 0 && offsetInLine === 0 ? 1 : -1

        return { pos: block.pmStartPos + charOffsetInBlock, bias }
    }

    // ─── Render Loop ───────────────────────────────────────────────────

    private scheduleRender(): void
    {
        if (this.pendingRender) return
        this.pendingRender = true
        requestAnimationFrame(() =>
        {
            this.pendingRender = false
            this.render()
        })
    }

    private render(): void
    {
        const t0 = performance.now()

        const { layouts, totalHeight } = this.computeLayout()
        this.lastLayouts = layouts

        // Virtualize only when the scroller has a measurable viewport. In
        // headless/zero-height environments we fall back to painting the
        // whole document (the canvas is sized to totalHeight).
        const virtualized =
            this.scroller !== null && this.scroller.clientHeight > 0
        this.applyVirtualLayout(virtualized, totalHeight)

        const caretCoords = this.posToCoords(layouts, this.state.selection.head)

        // Adjust the scroll position before painting so the visible slice we
        // draw already reflects where the caret needs to be — but only when the
        // caret actually moved. Renders from scrolling or blinking must not
        // fight the user's scroll position.
        if (caretCoords && this.scrollCaretIntoView)
        {
            this.ensureCaretVisible(caretCoords)
            this.scrollCaretIntoView = false
        }

        this.paintToCanvas(layouts, totalHeight, virtualized)
        this.paintCaret(caretCoords)

        if (caretCoords)
        {
            this.textarea.style.transform =
                `translate(${caretCoords.x}px, ${caretCoords.y}px)`
        }

        const dt = performance.now() - t0

        this.onRender?.({
            blockCount: layouts.length,
            lineCount: layouts.reduce((sum, b) => sum + b.lines.length, 0),
            cacheHits: this.cacheHits,
            cacheMisses: this.cacheMisses,
            renderTimeMs: dt,
        })
    }

    // ─── Input Handling ────────────────────────────────────────────────

    private setupInput(): void
    {
        const ac = new AbortController()
        this.abortController = ac
        const signal = ac.signal

        this.textarea.addEventListener('compositionstart', () =>
        {
            this.composing = true
        }, { signal })

        this.textarea.addEventListener('compositionend', (e) =>
        {
            this.composing = false
            if (e.data) this.dispatch(this.state.tr.insertText(e.data))
            this.textarea.value = ''
        }, { signal })

        this.textarea.addEventListener('input', (e) =>
        {
            const ie = e as InputEvent
            if (this.composing || ie.isComposing) return

            switch (ie.inputType)
            {
                case 'insertText':
                case 'insertFromPaste':
                case 'insertFromDrop':
                case 'insertReplacementText':
                    if (ie.data) this.dispatch(this.state.tr.insertText(ie.data))
                    break

                case 'insertCompositionText':
                    break

                case 'insertParagraph':
                case 'insertLineBreak':
                    this.splitBlock()
                    break

                case 'deleteContentBackward':
                case 'deleteWordBackward':
                case 'deleteByCut':
                    this.deleteBackward()
                    break

                case 'deleteContentForward':
                case 'deleteWordForward':
                    this.deleteForward()
                    break
            }

            this.textarea.value = ''
        }, { signal })

        this.textarea.addEventListener('keydown', (e) =>
        {
            if (this.composing || e.isComposing) return

            switch (e.key)
            {
                case 'ArrowLeft':
                    e.preventDefault()
                    this.moveSelection(-1, e.shiftKey)
                    break
                case 'ArrowRight':
                    e.preventDefault()
                    this.moveSelection(1, e.shiftKey)
                    break
                case 'ArrowUp':
                    e.preventDefault()
                    this.moveVertical(-1, e.shiftKey)
                    break
                case 'ArrowDown':
                    e.preventDefault()
                    this.moveVertical(1, e.shiftKey)
                    break
                case 'Home':
                    e.preventDefault()
                    this.moveToBlockBoundary('start', e.shiftKey)
                    break
                case 'End':
                    e.preventDefault()
                    this.moveToBlockBoundary('end', e.shiftKey)
                    break
                case 'Enter':
                    e.preventDefault()
                    this.splitBlock()
                    break
                case 'Backspace':
                    e.preventDefault()
                    this.deleteBackward()
                    break
                case 'Delete':
                    e.preventDefault()
                    this.deleteForward()
                    break
            }
        }, { signal })

        this.canvas.addEventListener('mousedown', (e) =>
        {
            if (e.button !== 0) return
            e.preventDefault()
            const { x, y } = this.eventToDocCoords(e)
            const hit = this.clickToPos(this.lastLayouts, x, y)
            if (hit !== null)
            {
                this.setHead(hit.pos, e.shiftKey)
                this.caretBias = hit.bias
            }
            this.dragging = true
            this.textarea.focus()
        }, { signal })

        window.addEventListener('mousemove', (e) =>
        {
            if (!this.dragging) return
            const { x, y } = this.eventToDocCoords(e)
            const hit = this.clickToPos(this.lastLayouts, x, y)
            if (hit !== null)
            {
                this.setHead(hit.pos, true)
                this.caretBias = hit.bias
            }
        }, { signal })

        window.addEventListener('mouseup', () =>
        {
            this.dragging = false
        }, { signal })

        // Repaint the visible slice as the user scrolls (virtualized mode).
        this.scroller?.addEventListener('scroll', () =>
        {
            this.scheduleRender()
        }, { signal })

        this.textarea.focus()
    }

    private deleteBackward(): void
    {
        const sel = this.state.selection
        if (!sel.empty)
        {
            this.dispatch(this.state.tr.deleteSelection())
            return
        }
        // PM's joinBackward handles "at start of textblock" for any schema
        // (paragraphs, list items, blockquotes, …). Returns false otherwise.
        if (joinBackward(this.state, (tr) => this.dispatch(tr))) return
        const $from = sel.$from
        if ($from.parent.isTextblock)
        {
            const text = $from.parent.textContent
            const prev = this.prevGraphemeBoundary(text, $from.parentOffset)
            const delta = $from.parentOffset - prev
            if (delta > 0)
            {
                this.dispatch(this.state.tr.delete(sel.from - delta, sel.from))
            }
        }
        else if (sel.from > 1)
        {
            this.dispatch(this.state.tr.delete(sel.from - 1, sel.from))
        }
    }

    private deleteForward(): void
    {
        const sel = this.state.selection
        if (!sel.empty)
        {
            this.dispatch(this.state.tr.deleteSelection())
            return
        }
        if (joinForward(this.state, (tr) => this.dispatch(tr))) return
        const $to = sel.$to
        if ($to.parent.isTextblock)
        {
            const text = $to.parent.textContent
            const next = this.nextGraphemeBoundary(text, $to.parentOffset)
            const delta = next - $to.parentOffset
            if (delta > 0)
            {
                this.dispatch(this.state.tr.delete(sel.to, sel.to + delta))
            }
        }
        else if (sel.to < this.state.doc.content.size - 1)
        {
            this.dispatch(this.state.tr.delete(sel.to, sel.to + 1))
        }
    }

    private splitBlock(): void
    {
        const sel = this.state.selection
        let tr = this.state.tr
        if (!sel.empty) tr = tr.deleteSelection()
        const $from = tr.selection.$from
        if ($from.parent.type.name === 'paragraph')
        {
            tr = tr.split($from.pos)
            this.dispatch(tr)
        }
    }

    // ─── Grapheme helpers ──────────────────────────────────────────────

    private nextGraphemeBoundary(text: string, pos: number): number
    {
        if (pos >= text.length) return text.length
        for (const { index } of this.segmenter.segment(text))
        {
            if (index > pos) return index
        }
        return text.length
    }

    private prevGraphemeBoundary(text: string, pos: number): number
    {
        if (pos <= 0) return 0
        let prev = 0
        for (const { index } of this.segmenter.segment(text))
        {
            if (index >= pos) return prev
            prev = index
        }
        return prev
    }

    private graphemeBoundaries(text: string): number[]
    {
        const boundaries: number[] = []
        for (const { index } of this.segmenter.segment(text))
        {
            boundaries.push(index)
        }
        boundaries.push(text.length)
        return boundaries
    }

    /**
     * Step `direction` graphemes from `pos` within the current textblock.
     * Falls through to a single-position step when at a block edge so
     * cross-block navigation still works via TextSelection.near.
     */
    private steppedGraphemePos(pos: number, direction: 1 | -1): number
    {
        const $pos = this.state.doc.resolve(pos)
        if (!$pos.parent.isTextblock) return pos + direction
        const text = $pos.parent.textContent
        const offset = $pos.parentOffset
        if (direction > 0)
        {
            const next = this.nextGraphemeBoundary(text, offset)
            if (next > offset) return pos + (next - offset)
            return pos + 1
        }
        const prev = this.prevGraphemeBoundary(text, offset)
        if (prev < offset) return pos - (offset - prev)
        return pos - 1
    }

    private setHead(newHead: number, extend: boolean, bias: 1 | -1 = 1): void
    {
        const size = this.state.doc.content.size
        const $head = this.state.doc.resolve(clamp(newHead, 0, size))
        if (extend)
        {
            const $anchor = this.state.doc.resolve(
                clamp(this.state.selection.anchor, 0, size),
            )
            this.dispatch(this.state.tr.setSelection(
                TextSelection.between($anchor, $head, bias),
            ))
        }
        else
        {
            this.dispatch(this.state.tr.setSelection(TextSelection.near($head, bias)))
        }
    }

    private moveSelection(delta: number, extend: boolean): void
    {
        const head = this.state.selection.head
        const target = (delta === 1 || delta === -1)
            ? this.steppedGraphemePos(head, delta)
            : head + delta
        this.setHead(target, extend, delta < 0 ? -1 : 1)
        // If the step lands on a soft-wrap boundary, bias the caret in the
        // direction of travel: rightward shows it at the start of the next
        // visual line, leftward at the end of the previous one. setHead's
        // dispatch reset bias to -1, so we only need to override for rightward.
        if (this.isAtSoftWrapBoundary(this.state.selection.head))
        {
            this.caretBias = delta > 0 ? 1 : -1
        }
    }

    /**
     * True when `pos` sits exactly on an internal soft-wrap boundary — the end
     * of one visual line and the start of the next within the same block
     * (block starts/ends and hard paragraph breaks don't count).
     */
    private isAtSoftWrapBoundary(pos: number): boolean
    {
        for (const block of this.lastLayouts)
        {
            if (pos < block.pmStartPos || pos > block.pmEndPos) continue
            const offsetInBlock = pos - block.pmStartPos
            let consumed = 0
            for (let i = 0; i < block.lines.length - 1; i++)
            {
                consumed += block.lines[i].text.length
                if (consumed === offsetInBlock) return true
            }
            return false
        }
        return false
    }

    private moveVertical(direction: 1 | -1, extend: boolean): void
    {
        if (this.lastLayouts.length === 0) return

        const head = this.state.selection.head
        const currentCoords = this.posToCoords(this.lastLayouts, head)
        if (!currentCoords) return

        // Locate current block by PM position, current line by caret Y.
        let currentBlockIdx = -1
        for (let bi = 0; bi < this.lastLayouts.length; bi++)
        {
            const b = this.lastLayouts[bi]
            if (head >= b.pmStartPos && head <= b.pmEndPos)
            {
                currentBlockIdx = bi
                break
            }
        }
        if (currentBlockIdx === -1) return

        const currentBlock = this.lastLayouts[currentBlockIdx]
        let currentLineIdx = 0
        for (let li = 0; li < currentBlock.lines.length; li++)
        {
            if (currentBlock.lines[li].y === currentCoords.y)
            {
                currentLineIdx = li
                break
            }
        }

        // Capture the phantom X from the current caret on the first vertical
        // move of a run. Subsequent vertical moves reuse it.
        const targetX = this.phantomX ?? currentCoords.x

        // Pick the target line (wrapping across block boundaries).
        let targetBlockIdx = currentBlockIdx
        let targetLineIdx = currentLineIdx + direction

        if (targetLineIdx < 0)
        {
            if (currentBlockIdx === 0)
            {
                // Top of doc — clamp to very start.
                this.setHead(0, extend)
                this.phantomX = targetX
                return
            }
            targetBlockIdx = currentBlockIdx - 1
            const prev = this.lastLayouts[targetBlockIdx]
            targetLineIdx = Math.max(0, prev.lines.length - 1)
        }
        else if (targetLineIdx >= currentBlock.lines.length)
        {
            if (currentBlockIdx === this.lastLayouts.length - 1)
            {
                // Bottom of doc — clamp to very end.
                this.setHead(this.state.doc.content.size, extend)
                this.phantomX = targetX
                return
            }
            targetBlockIdx = currentBlockIdx + 1
            targetLineIdx = 0
        }

        const targetBlock = this.lastLayouts[targetBlockIdx]
        const targetLine = targetBlock.lines[targetLineIdx]

        // Re-use clickToPos against the target line's midline — it already
        // handles empty lines, binary search, and nearest-char snap, and hands
        // back the bias that keeps the caret on the target line even when the
        // landing offset sits on a soft-wrap boundary.
        const hit = this.clickToPos(
            this.lastLayouts,
            targetX,
            targetLine.y + this.lineHeight / 2,
        )
        if (hit !== null) this.setHead(hit.pos, extend)

        // Pin phantom X and bias after dispatch (which clears them).
        this.phantomX = targetX
        if (hit !== null) this.caretBias = hit.bias
    }

    private moveToBlockBoundary(end: 'start' | 'end', extend: boolean): void
    {
        for (const block of this.lastLayouts)
        {
            const head = this.state.selection.head
            if (head >= block.pmStartPos && head <= block.pmEndPos)
            {
                const target = end === 'start' ? block.pmStartPos : block.pmEndPos
                this.setHead(target, extend, end === 'start' ? -1 : 1)
                return
            }
        }
    }

    // ─── Caret Blink ───────────────────────────────────────────────────

    private startCaretBlink(): void
    {
        this.blinkInterval = setInterval(() =>
        {
            const sinceInput = performance.now() - this.lastInputTime
            if (sinceInput < this.caretHoldMs)
            {
                if (!this.caretVisible)
                {
                    this.caretVisible = true
                    this.scheduleRender()
                }
                return
            }
            this.caretVisible = !this.caretVisible
            this.scheduleRender()
        }, this.caretBlinkMs)
    }
}


// ─── Helpers ───────────────────────────────────────────────────────────────

function clamp(n: number, min: number, max: number): number
{
    return Math.max(min, Math.min(max, n))
}
