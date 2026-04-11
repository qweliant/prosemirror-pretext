import { type Node as PMNode } from 'prosemirror-model'
import { EditorState, TextSelection, type Transaction } from 'prosemirror-state'
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
    private readonly caretWidth = 2
    private readonly caretBlinkMs = 530
    private readonly caretHoldMs = 500
    private readonly onRender?: (stats: RenderStats) => void

    // ─── State ─────────────────────────────────────────────────────────
    state: EditorState

    // ─── DOM ───────────────────────────────────────────────────────────
    private readonly container: HTMLElement
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

    // ─── Caret ─────────────────────────────────────────────────────────
    private caretVisible = true
    private lastInputTime = 0
    private blinkInterval: ReturnType<typeof setInterval> | null = null

    // ─── Input ─────────────────────────────────────────────────────────
    private composing = false
    private abortController: AbortController | null = null

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
        this.onRender = options.onRender

        // Build DOM
        const stack = document.createElement('div')
        stack.style.position = 'relative'
        stack.style.cursor = 'text'

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
        this.container.appendChild(stack)

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

    private paintToCanvas(layouts: BlockLayout[], totalHeight: number): void
    {
        const dpr = window.devicePixelRatio || 1
        const cssWidth = this.containerWidth
        const cssHeight = totalHeight

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
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        ctx.clearRect(0, 0, cssWidth, cssHeight)

        ctx.font = this.font
        ctx.textBaseline = 'top'

        for (const block of layouts)
        {
            for (let i = 0; i < block.lines.length; i++)
            {
                const line = block.lines[i]
                ctx.fillStyle = i === 0 ? this.firstLineColor : this.textColor
                ctx.fillText(line.text, line.x, line.y)
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

            if (offsetInBlock <= consumed + lineLen || isLast)
            {
                const offsetInLine = Math.max(0, Math.min(lineLen, offsetInBlock - consumed))
                const w = offsetInLine === 0
                    ? 0
                    : this.measureCtx.measureText(line.text.substring(0, offsetInLine)).width
                return { x: line.x + w, y: line.y }
            }

            consumed += lineLen
        }

        return { x: 0, y: block.yOffset }
    }

    private paintCaret(coords: { x: number, y: number } | null): void
    {
        if (!coords || !this.caretVisible) return
        const ctx = this.canvas.getContext('2d')!
        ctx.fillStyle = this.caretColor
        ctx.fillRect(coords.x, coords.y, this.caretWidth, this.lineHeight)
    }

    // ─── Click → Doc Position ──────────────────────────────────────────

    private clickToPos(layouts: BlockLayout[], canvasX: number, canvasY: number): number | null
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
            block = canvasY < layouts[0].yOffset
                ? layouts[0]
                : layouts[layouts.length - 1]
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
        if (line.text.length === 0) return block.pmStartPos

        this.measureCtx.font = this.font
        const targetX = Math.max(0, canvasX - line.x)

        let lo = 0
        let hi = line.text.length
        while (lo < hi)
        {
            const mid = (lo + hi + 1) >> 1
            const w = this.measureCtx.measureText(line.text.substring(0, mid)).width
            if (w <= targetX) lo = mid
            else hi = mid - 1
        }

        let offsetInLine = lo
        if (lo < line.text.length)
        {
            const wLo = lo === 0 ? 0 : this.measureCtx.measureText(line.text.substring(0, lo)).width
            const wHi = this.measureCtx.measureText(line.text.substring(0, lo + 1)).width
            if ((targetX - wLo) > (wHi - targetX)) offsetInLine = lo + 1
        }

        let charOffsetInBlock = 0
        for (let i = 0; i < lineIdx; i++)
        {
            charOffsetInBlock += block.lines[i].text.length
        }
        charOffsetInBlock = Math.min(block.text.length, charOffsetInBlock + offsetInLine)

        return block.pmStartPos + charOffsetInBlock
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

        this.paintToCanvas(layouts, totalHeight)

        const caretCoords = this.posToCoords(layouts, this.state.selection.head)
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
                {
                    const sel = this.state.selection
                    if (sel.empty)
                    {
                        if (sel.from > 1)
                        {
                            this.dispatch(this.state.tr.delete(sel.from - 1, sel.from))
                        }
                    }
                    else
                    {
                        this.dispatch(this.state.tr.deleteSelection())
                    }
                    break
                }

                case 'deleteContentForward':
                case 'deleteWordForward':
                {
                    const sel = this.state.selection
                    if (sel.empty)
                    {
                        if (sel.to < this.state.doc.content.size - 1)
                        {
                            this.dispatch(this.state.tr.delete(sel.to, sel.to + 1))
                        }
                    }
                    else
                    {
                        this.dispatch(this.state.tr.deleteSelection())
                    }
                    break
                }
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
                    this.moveSelection(-1)
                    break
                case 'ArrowRight':
                    e.preventDefault()
                    this.moveSelection(1)
                    break
                case 'ArrowUp':
                case 'ArrowDown':
                    e.preventDefault()
                    break
                case 'Home':
                    e.preventDefault()
                    this.moveToBlockBoundary('start')
                    break
                case 'End':
                    e.preventDefault()
                    this.moveToBlockBoundary('end')
                    break
                case 'Enter':
                    e.preventDefault()
                    this.splitBlock()
                    break
            }
        }, { signal })

        this.canvas.addEventListener('mousedown', (e) =>
        {
            e.preventDefault()
            const rect = this.canvas.getBoundingClientRect()
            const x = e.clientX - rect.left
            const y = e.clientY - rect.top
            const pos = this.clickToPos(this.lastLayouts, x, y)
            if (pos !== null)
            {
                const $pos = this.state.doc.resolve(
                    clamp(pos, 0, this.state.doc.content.size),
                )
                this.dispatch(this.state.tr.setSelection(TextSelection.near($pos)))
            }
            this.textarea.focus()
        }, { signal })

        this.textarea.focus()
    }

    private splitBlock(): void
    {
        const { $from } = this.state.selection
        // Only split if we're inside a block that supports it
        if ($from.parent.type.name === 'paragraph')
        {
            this.dispatch(this.state.tr.split($from.pos))
        }
    }

    private moveSelection(delta: number): void
    {
        const newPos = this.state.selection.head + delta
        const clamped = clamp(newPos, 0, this.state.doc.content.size)
        const $pos = this.state.doc.resolve(clamped)
        const sel = TextSelection.near($pos, delta < 0 ? -1 : 1)
        this.dispatch(this.state.tr.setSelection(sel))
    }

    private moveToBlockBoundary(end: 'start' | 'end'): void
    {
        for (const block of this.lastLayouts)
        {
            const head = this.state.selection.head
            if (head >= block.pmStartPos && head <= block.pmEndPos)
            {
                const target = end === 'start' ? block.pmStartPos : block.pmEndPos
                const $pos = this.state.doc.resolve(target)
                this.dispatch(this.state.tr.setSelection(TextSelection.near($pos)))
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
