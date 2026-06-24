import { type Mark, type Node as PMNode } from 'prosemirror-model'
import {
    EditorState, TextSelection, type Command, type Transaction,
} from 'prosemirror-state'
import { joinBackward, joinForward } from 'prosemirror-commands'
import { keydownHandler } from 'prosemirror-keymap'
import {
    prepareWithSegments,
    layoutWithLines,
    layoutNextLine,
    type LayoutCursor,
    type PreparedTextWithSegments,
} from '@chenglou/pretext'
import {
    prepareRichInline,
    walkRichInlineLineRanges,
    layoutNextRichInlineLineRange,
    materializeRichInlineLineRange,
    type RichInlineItem,
    type RichInlineCursor,
    type PreparedRichInline,
    type RichInlineLineRange,
} from '@chenglou/pretext/rich-inline'


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
    /**
     * Maps ProseMirror mark names to text styling. Keeps the renderer
     * schema-agnostic: the consumer names their marks, we map names → font
     * weight/style/family + color. Merged over the built-in defaults for
     * `strong` (bold), `em` (italic), and `code` (monospace + green). Pass
     * `{ strong: null }` to disable a default.
     */
    markStyles?: Record<string, MarkStyleResolver | null>
    /**
     * ProseMirror key bindings, e.g. `{ 'Mod-b': toggleMark(schema.marks.strong) }`.
     * Checked on keydown before the editor's built-in navigation/editing keys.
     * Use `buildMarkKeymap(schema)` for sensible bold/italic/code defaults.
     */
    keymap?: Record<string, Command>
    /**
     * Rectangles the text must flow around (e.g. a floated image). Coordinates
     * are content-space: `x` from the content's left edge, `y` in document
     * space (matching `BlockLayout.yOffset`). The editor only reserves the
     * space — render the actual element yourself and keep the rects in sync
     * via `setFloats`. Text wraps on the wider free side of each rect.
     */
    floats?: FloatRect[]
    /** Gap (px) kept between text and each float rect. Default: 12. */
    floatGutter?: number
    /** Schema mark name treated as a followable link. Default: 'link'. */
    linkMark?: string
    /**
     * Invoked on Cmd/Ctrl-click of a link's text. Default opens `href` in a new
     * tab. The mark's `href` attribute supplies the value.
     */
    onFollowLink?: (href: string, event: MouseEvent) => void
    /** Called after every render with timing/cache stats. */
    onRender?: (stats: RenderStats) => void
}

/** A rectangle that text flows around, in content-space coordinates. */
export interface FloatRect
{
    x: number
    y: number
    width: number
    height: number
}

/** Styling applied to text carrying a given ProseMirror mark. */
export interface MarkStyle
{
    /** CSS font-weight, e.g. 'bold' or 700. */
    fontWeight?: string | number
    /** CSS font-style. */
    fontStyle?: 'normal' | 'italic' | 'oblique'
    /** CSS font-family override, e.g. 'monospace' for code. */
    fontFamily?: string
    /** Fill color override. When omitted the run uses the editor's line color. */
    color?: string
    /** Background color painted behind the run (e.g. highlight). */
    background?: string
    /** Draw an underline beneath the run (e.g. links). */
    underline?: boolean
    /** Draw a line through the run. */
    strikethrough?: boolean
    /** Shrink + raise/lower the run (superscript / subscript). */
    verticalAlign?: 'super' | 'sub'
}

/**
 * A mark's styling — either a fixed style, or a function of the mark so the
 * style can read its attributes (e.g. a `textColor` mark whose colour lives in
 * `mark.attrs.color`). Returning null contributes nothing.
 */
export type MarkStyleResolver = MarkStyle | ((mark: Mark) => MarkStyle | null)

const DEFAULT_MARK_STYLES: Record<string, MarkStyleResolver> = {
    strong: { fontWeight: 700 },
    em: { fontStyle: 'italic' },
    code: { fontFamily: 'monospace', color: '#9ece6a' },
    link: { color: '#7aa2f7', underline: true },
    underline: { underline: true },
    strikethrough: { strikethrough: true },
    textColor: (mark) => ({ color: mark.attrs['color'] as string }),
    highlight: (mark) => ({ background: (mark.attrs['color'] as string) || '#fde047' }),
    superscript: { verticalAlign: 'super' },
    subscript: { verticalAlign: 'sub' },
}

export interface RenderStats
{
    blockCount: number
    lineCount: number
    cacheHits: number
    cacheMisses: number
    renderTimeMs: number
}

/**
 * A styled run within a line. Present only on lines that carry marks; plain
 * lines leave `LineLayout.fragments` undefined and use the single-font path.
 */
export interface LineFragment
{
    text: string
    /** CSS font string for this run. */
    font: string
    /** Fill color, or null to use the editor's default line color. */
    color: string | null
    /** Left offset relative to the line's `x`. */
    x: number
    width: number
    /** Char offset within the block where this run's first character sits. */
    pmStart: number
    /** Background color painted behind the run (highlight). */
    background?: string | null
    /** Drawn text decorations (links, underline, strikethrough marks). */
    underline?: boolean
    strikethrough?: boolean
    /** Vertical paint offset for super/subscript runs. */
    baselineShift?: number
}

export interface LineLayout
{
    text: string
    width: number
    x: number
    y: number
    /** Char offset within the block where this line's content begins. */
    pmStart: number
    /** Styled runs, when the line carries marks. Undefined for plain text. */
    fragments?: LineFragment[]
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

interface CachedFragment
{
    text: string
    font: string
    color: string | null
    background: string | null
    x: number
    width: number
    pmStart: number
    underline?: boolean
    strikethrough?: boolean
    baselineShift?: number
}

interface CachedLine
{
    text: string
    width: number
    pmStart: number
    fragments?: CachedFragment[]
    // Set only by float-aware layout (lines aren't uniformly placed then):
    // absolute left edge, and top relative to the block (bands may be skipped).
    x?: number
    yOffset?: number
}

interface CachedBlock
{
    prepared: PreparedTextWithSegments | null
    width: number
    lineHeight: number
    lines: CachedLine[]
    height: number
}

/** Per-item run metadata threaded through marked line building. */
interface MarkedLineCtx
{
    meta: {
        pmStart: number, leadTrim: number, font: string,
        color: string | null, background: string | null, trimmed: string,
        underline: boolean, strikethrough: boolean, baselineShift: number,
    }[]
    blockText: string
    consumed: number[]
    prevLineEnd: number
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

    // ─── Marks ─────────────────────────────────────────────────────────
    private readonly markStyles: Record<string, MarkStyleResolver>
    // Compiled key bindings (prosemirror-keymap); consulted before built-ins.
    private readonly keymapHandler: (event: KeyboardEvent) => boolean
    // Base font split into size + family so marked runs can compose new font
    // strings (weight/style/family) on top of the editor's base size.
    private readonly baseFontSize: number
    private readonly baseFontFamily: string

    // ─── Floats ────────────────────────────────────────────────────────
    // Exclusion rects the text flows around. Empty by default — the cached,
    // fixed-width layout path is used whenever there are no floats.
    private floats: FloatRect[]
    // Breathing room kept around each float so text never kisses its edge.
    private readonly floatGutter: number

    // ─── Links ─────────────────────────────────────────────────────────
    private readonly linkMark: string
    private readonly onFollowLink: (href: string, event: MouseEvent) => void
    // Below this, a slot is too narrow to set text; the line flows past it.
    private readonly minSlotWidth = 24

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
    // Not readonly: replaced wholesale to invalidate when web fonts load
    // (WeakMap has no clear()). Marked-block geometry is measured at layout
    // time, so it must be recomputed once the real font is available.
    private layoutCache = new WeakMap<PMNode, CachedBlock>()
    // Memoized full-run widths (key: "<font> <text>") so re-laying out a
    // marked block on each keystroke only measures the run that changed.
    private readonly widthCache = new Map<string, number>()
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
    // Word boundaries for double-click selection.
    private readonly wordSegmenter = new Intl.Segmenter(undefined, {
        granularity: 'word',
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

        // Merge caller mark styles over the defaults; an explicit null disables
        // a default mark.
        this.markStyles = { ...DEFAULT_MARK_STYLES }
        for (const [name, style] of Object.entries(options.markStyles ?? {}))
        {
            if (style === null) delete this.markStyles[name]
            else this.markStyles[name] = style
        }

        // Split the base font into size + family for composing marked runs.
        const fontMatch = this.font.match(/(\d+(?:\.\d+)?)px\s+(.+)$/)
        this.baseFontSize = fontMatch ? parseFloat(fontMatch[1]) : 16
        this.baseFontFamily = fontMatch ? fontMatch[2].trim() : 'sans-serif'

        // keydownHandler is typed against prosemirror-view's EditorView, but
        // only touches state/dispatch — feed it our minimal shim.
        const compiled = keydownHandler(options.keymap ?? {})
        this.keymapHandler = (event) =>
            compiled(this.commandView() as never, event)

        this.floats = options.floats ?? []
        this.floatGutter = options.floatGutter ?? 12
        this.linkMark = options.linkMark ?? 'link'
        this.onFollowLink = options.onFollowLink
            ?? ((href) => { window.open(href, '_blank', 'noopener') })

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

    /**
     * Run a ProseMirror command against the current state (e.g. `toggleMark`).
     * Returns whether the command applied. Handy for wiring toolbar buttons:
     * `editor.command(toggleMark(schema.marks.strong))`.
     */
    command(cmd: Command): boolean
    {
        const handled = cmd(this.state, (tr) => this.dispatch(tr))
        this.textarea.focus()
        return handled
    }

    /** Minimal view shim so ProseMirror commands/keymaps can dispatch. */
    private commandView(): { state: EditorState, dispatch: (tr: Transaction) => void }
    {
        return { state: this.state, dispatch: (tr) => this.dispatch(tr) }
    }

    focus(): void
    {
        this.textarea.focus()
    }

    /**
     * Replace the float rectangles the text flows around and re-layout. Call
     * this as a floated element moves or resizes (e.g. while dragging).
     */
    setFloats(floats: FloatRect[]): void
    {
        this.floats = floats
        this.scheduleRender()
    }

    /**
     * Viewport coordinates of a document position — the top-left of the caret
     * there, plus the line height. The anchor for selection-positioned UI
     * (bubble menus, inline link editors, hovercards). Mirrors
     * `EditorView.coordsAtPos`. Returns null if the doc has no layout yet.
     */
    coordsAtPos(pos: number): { x: number, y: number, height: number } | null
    {
        const coords = this.posToCoords(
            this.lastLayouts, clamp(pos, 0, this.state.doc.content.size),
        )
        if (!coords) return null
        const rect = this.canvas.getBoundingClientRect()
        const scrollTop = this.scroller?.scrollTop ?? 0
        return {
            x: rect.left + coords.x,
            y: rect.top + coords.y - scrollTop,
            height: this.lineHeight,
        }
    }

    /**
     * Viewport bounding box of the current selection, or null when it's empty.
     * Built from the selection's endpoints — enough to anchor a floating
     * toolbar above (`top`) and centered (`(left + right) / 2`).
     */
    selectionRect(): { left: number, right: number, top: number, bottom: number } | null
    {
        const sel = this.state.selection
        if (sel.empty) return null
        const a = this.coordsAtPos(sel.from)
        const b = this.coordsAtPos(sel.to)
        if (!a || !b) return null
        return {
            left: Math.min(a.x, b.x),
            right: Math.max(a.x, b.x),
            top: Math.min(a.y, b.y),
            bottom: Math.max(a.y + a.height, b.y + b.height),
        }
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

    /** measureText for a whole string, memoized by font+text (see widthCache). */
    private measureWidth(text: string, font: string): number
    {
        const key = `${font} ${text}`
        let w = this.widthCache.get(key)
        if (w === undefined)
        {
            this.measureCtx.font = font
            w = this.measureCtx.measureText(text).width
            if (this.widthCache.size > 8000) this.widthCache.clear()
            this.widthCache.set(key, w)
        }
        return w
    }

    /**
     * Map a fragment's collapsed text back onto its source run, preserving the
     * original (uncollapsed) whitespace. Non-space characters align exactly;
     * each collapsed space stands for a run of whitespace in the source. Any
     * whitespace trimmed at a line start is skipped first. Returns the real
     * slice and the new source index.
     */
    private expandCollapsedWhitespace(
        source: string, start: number, collapsed: string,
    ): [string, number]
    {
        const ws = /\s/
        let si = start
        // Leading whitespace dropped at a line/wrap start.
        if (collapsed.length > 0 && collapsed[0] !== ' ')
        {
            while (si < source.length && ws.test(source[si])) si++
        }
        for (let ci = 0; ci < collapsed.length; ci++)
        {
            if (collapsed[ci] === ' ')
            {
                while (si < source.length && ws.test(source[si])) si++
            }
            else if (si < source.length)
            {
                si++
            }
        }
        return [source.slice(start, si), si]
    }

    /** Lay out one block, choosing the single-font fast path or the marked path. */
    private layoutBlock(node: PMNode): CachedBlock
    {
        const text = node.textContent
        if (text.length === 0)
        {
            return {
                prepared: null,
                width: this.containerWidth,
                lineHeight: this.lineHeight,
                lines: [],
                height: 0,
            }
        }

        if (this.blockHasMarks(node))
        {
            return this.layoutMarkedBlock(node)
        }

        // Fast path: a single font for the whole block. 'pre-wrap' keeps every
        // space as a real character (default 'normal' collapses runs of
        // whitespace), so line text stays in lockstep with PM offsets and the
        // caret doesn't drift when you type consecutive spaces.
        const prepared = prepareWithSegments(text, this.font, { whiteSpace: 'pre-wrap' })
        const { lines, height } = layoutWithLines(
            prepared, this.containerWidth, this.lineHeight,
        )
        let acc = 0
        const cachedLines: CachedLine[] = lines.map((l) =>
        {
            const cl = { text: l.text, width: l.width, pmStart: acc }
            acc += l.text.length
            return cl
        })
        return {
            prepared,
            width: this.containerWidth,
            lineHeight: this.lineHeight,
            lines: cachedLines,
            height,
        }
    }

    private blockHasMarks(node: PMNode): boolean
    {
        let has = false
        node.forEach((child) =>
        {
            if (child.marks.length > 0) has = true
        })
        return has
    }

    /**
     * Resolve a run's marks to a CSS font string + fill color, composing
     * weight/style/family over the base font size. Color is null when no mark
     * overrides it (so the caller can fall back to the line color / accent).
     */
    private resolveRunStyle(marks: readonly Mark[]): {
        font: string, color: string | null, background: string | null,
        underline: boolean, strikethrough: boolean, baselineShift: number,
    }
    {
        let fontStyle = ''
        let fontWeight = ''
        let family = this.baseFontFamily
        let color: string | null = null
        let background: string | null = null
        let underline = false
        let strikethrough = false
        let verticalAlign: 'super' | 'sub' | null = null

        for (const mark of marks)
        {
            const entry = this.markStyles[mark.type.name]
            const ms = typeof entry === 'function' ? entry(mark) : entry
            if (!ms) continue
            if (ms.fontStyle) fontStyle = ms.fontStyle
            if (ms.fontWeight !== undefined) fontWeight = String(ms.fontWeight)
            if (ms.fontFamily) family = ms.fontFamily
            if (ms.color) color = ms.color
            if (ms.background) background = ms.background
            if (ms.underline) underline = true
            if (ms.strikethrough) strikethrough = true
            if (ms.verticalAlign) verticalAlign = ms.verticalAlign
        }

        // Super/subscript shrink the run and shift it off the baseline.
        const size = verticalAlign
            ? Math.round(this.baseFontSize * 0.72)
            : this.baseFontSize
        const baselineShift = verticalAlign === 'super'
            ? -Math.round(this.baseFontSize * 0.30)
            : verticalAlign === 'sub'
                ? Math.round(this.baseFontSize * 0.18)
                : 0

        const font = `${fontStyle} ${fontWeight} ${size}px ${family}`
            .replace(/\s+/g, ' ')
            .trim()
        return { font, color, background, underline, strikethrough, baselineShift }
    }

    /**
     * Lay out a block whose inline content carries marks. Adjacent runs that
     * resolve to the same style are merged into one Pretext rich-inline item;
     * we track each item's PM start so fragment text can be mapped back to
     * document offsets later (Pretext trims boundary whitespace into gaps, so
     * mapping is item-relative, not a flat character count).
     */
    private prepareMarkedBlock(node: PMNode): { prepared: PreparedRichInline, ctx: MarkedLineCtx }
    {
        const blockText = node.textContent
        const items: RichInlineItem[] = []
        // Per item: PM offset (within block) of its first char, the leading
        // whitespace Pretext trims, the run's style, and the trimmed source
        // text (used to re-expand whitespace Pretext collapses in fragments).
        const meta: MarkedLineCtx['meta'] = []

        let offset = 0
        type Run = {
            font: string, color: string | null, background: string | null,
            text: string, pmStart: number, underline: boolean, strikethrough: boolean,
            baselineShift: number,
        }
        let cur: Run | null = null
        const flush = () =>
        {
            if (!cur) return
            const leadTrim = cur.text.length - cur.text.trimStart().length
            const trimmed = cur.text.replace(/^\s+/, '').replace(/\s+$/, '')
            items.push({ text: cur.text, font: cur.font })
            meta.push({
                pmStart: cur.pmStart, leadTrim, font: cur.font, color: cur.color,
                background: cur.background, trimmed,
                underline: cur.underline, strikethrough: cur.strikethrough,
                baselineShift: cur.baselineShift,
            })
            cur = null
        }

        node.forEach((child) =>
        {
            const childText = child.isText ? (child.text ?? '') : ''
            const { font, color, background, underline, strikethrough, baselineShift } = this.resolveRunStyle(child.marks)
            if (
                cur && cur.font === font && cur.color === color && cur.background === background
                && cur.underline === underline && cur.strikethrough === strikethrough
                && cur.baselineShift === baselineShift
            )
            {
                cur.text += childText
            }
            else
            {
                flush()
                cur = {
                    font, color, background, text: childText, pmStart: offset,
                    underline, strikethrough, baselineShift,
                }
            }
            offset += child.nodeSize
        })
        flush()

        return {
            prepared: prepareRichInline(items),
            ctx: { meta, blockText, consumed: new Array(items.length).fill(0), prevLineEnd: 0 },
        }
    }

    private layoutMarkedBlock(node: PMNode): CachedBlock
    {
        const { prepared, ctx } = this.prepareMarkedBlock(node)
        const lines: CachedLine[] = []

        // Pretext decides which runs land on which line; buildMarkedLine then
        // measures geometry with the paint context so fragment widths match
        // fillText and stay consistent with measureText-based hit-testing.
        walkRichInlineLineRanges(prepared, this.containerWidth, (range) =>
        {
            lines.push(this.buildMarkedLine(prepared, range, ctx, lines.length === 0))
        })

        return {
            prepared: null,
            width: this.containerWidth,
            lineHeight: this.lineHeight,
            lines,
            height: lines.length * this.lineHeight,
        }
    }

    /** Float-aware counterpart of layoutBlock: lays each line at its own width. */
    private layoutBlockAt(node: PMNode, topY: number): CachedBlock
    {
        const text = node.textContent
        if (text.length === 0)
        {
            return {
                prepared: null, width: this.containerWidth,
                lineHeight: this.lineHeight, lines: [], height: 0,
            }
        }
        if (this.blockHasMarks(node))
        {
            const { prepared, ctx } = this.prepareMarkedBlock(node)
            return this.layoutMarkedBlockFloated(prepared, ctx, topY)
        }
        const prepared = prepareWithSegments(text, this.font, { whiteSpace: 'pre-wrap' })
        return this.layoutBlockFloated(prepared, topY)
    }

    /**
     * Build one CachedLine from a rich-inline range: re-expand whitespace
     * Pretext collapsed, append boundary whitespace to the preceding run, and
     * measure each run in its own font. Shared by the fixed-width and
     * float-aware marked layout paths. Mutates ctx (consumed, prevLineEnd).
     */
    private buildMarkedLine(
        prepared: PreparedRichInline,
        range: RichInlineLineRange,
        ctx: MarkedLineCtx,
        isFirstLine: boolean,
    ): CachedLine
    {
        const mat = materializeRichInlineLineRange(prepared, range)
        const fragments: CachedFragment[] = []
        let x = 0
        let lineText = ''
        let prevPmEnd = -1
        for (const f of mat.fragments)
        {
            const m = ctx.meta[f.itemIndex]
            const start = ctx.consumed[f.itemIndex]
            // Pretext collapses runs of whitespace inside a fragment; re-expand
            // against the source so every space stays a real editable character.
            const [text, end] = this.expandCollapsedWhitespace(m.trimmed, start, f.text)
            ctx.consumed[f.itemIndex] = end
            const pmStart = m.pmStart + m.leadTrim + start

            // A jump in PM offset means Pretext trimmed whitespace between the
            // runs into a gap. Append the real boundary whitespace to the
            // previous run so every space stays navigable (rather than
            // collapsing several to one). Never at a line start.
            if (fragments.length > 0 && pmStart > prevPmEnd)
            {
                const prev = fragments[fragments.length - 1]
                const gap = ctx.blockText.substring(prevPmEnd, pmStart)
                const gapWidth = this.measureWidth(gap, prev.font)
                prev.text += gap
                prev.width += gapWidth
                x += gapWidth
                lineText += gap
            }

            const width = this.measureWidth(text, m.font)
            fragments.push({
                text, font: m.font, color: m.color, background: m.background,
                x, width, pmStart,
                underline: m.underline, strikethrough: m.strikethrough,
                baselineShift: m.baselineShift,
            })
            x += width
            lineText += text
            prevPmEnd = pmStart + text.length
        }
        // Line 0 owns the block start (offset 0); each later line begins at its
        // first fragment, so whitespace collapsed at a wrap belongs to the line
        // before it. This tiles [0, blockLen) with no gaps.
        const linePmStart = isFirstLine
            ? 0
            : (fragments.length > 0 ? fragments[0].pmStart : ctx.prevLineEnd)
        ctx.prevLineEnd = fragments.length > 0
            ? fragments[fragments.length - 1].pmStart + fragments[fragments.length - 1].text.length
            : ctx.prevLineEnd
        return { text: lineText, width: x, pmStart: linePmStart, fragments }
    }

    // ─── Float-aware layout ────────────────────────────────────────────

    /**
     * The widest free horizontal slot for a line whose top is at document
     * `bandTop`, after subtracting any floats it vertically intersects.
     * Returns null when nothing usable fits (the caller flows past the band).
     */
    private slotForBand(bandTop: number): { x: number, width: number } | null
    {
        const bandBottom = bandTop + this.lineHeight
        const g = this.floatGutter
        let slots: { left: number, right: number }[] = [{ left: 0, right: this.containerWidth }]
        for (const f of this.floats)
        {
            // Inflate the rect by the gutter so text clears it on every side.
            if (bandBottom <= f.y - g || bandTop >= f.y + f.height + g) continue
            const blockLeft = f.x - g
            const blockRight = f.x + f.width + g
            const next: { left: number, right: number }[] = []
            for (const s of slots)
            {
                if (blockRight <= s.left || blockLeft >= s.right) { next.push(s); continue }
                if (blockLeft > s.left) next.push({ left: s.left, right: blockLeft })
                if (blockRight < s.right) next.push({ left: blockRight, right: s.right })
            }
            slots = next
        }
        let best: { left: number, right: number } | null = null
        for (const s of slots)
        {
            if (s.right - s.left < this.minSlotWidth) continue
            if (!best || s.right - s.left > best.right - best.left) best = s
        }
        return best ? { x: best.left, width: best.right - best.left } : null
    }

    /** Single-font block laid out line-by-line, flowing around floats. */
    private layoutBlockFloated(prepared: PreparedTextWithSegments, topY: number): CachedBlock
    {
        const lines: CachedLine[] = []
        let cursor: LayoutCursor = { segmentIndex: 0, graphemeIndex: 0 }
        let bandTop = 0
        let acc = 0
        // Guard against a malformed float producing an unbounded skip loop.
        for (let guard = 0; guard < 20000; guard++)
        {
            const slot = this.slotForBand(topY + bandTop)
            if (!slot) { bandTop += this.lineHeight; continue }
            const line = layoutNextLine(prepared, cursor, slot.width)
            if (!line) break
            lines.push({
                text: line.text, width: line.width, pmStart: acc,
                x: slot.x, yOffset: bandTop,
            })
            acc += line.text.length
            cursor = line.end
            bandTop += this.lineHeight
        }
        const height = lines.length > 0
            ? lines[lines.length - 1].yOffset! + this.lineHeight
            : this.lineHeight
        return { prepared, width: this.containerWidth, lineHeight: this.lineHeight, lines, height }
    }

    /** Marked block laid out line-by-line, flowing around floats. */
    private layoutMarkedBlockFloated(
        prepared: PreparedRichInline, ctx: MarkedLineCtx, topY: number,
    ): CachedBlock
    {
        const lines: CachedLine[] = []
        let cursor: RichInlineCursor | undefined
        let bandTop = 0
        for (let guard = 0; guard < 20000; guard++)
        {
            const slot = this.slotForBand(topY + bandTop)
            if (!slot) { bandTop += this.lineHeight; continue }
            const range = layoutNextRichInlineLineRange(prepared, slot.width, cursor)
            if (!range) break
            const line = this.buildMarkedLine(prepared, range, ctx, lines.length === 0)
            line.x = slot.x
            line.yOffset = bandTop
            lines.push(line)
            cursor = range.end
            bandTop += this.lineHeight
        }
        const height = lines.length > 0
            ? lines[lines.length - 1].yOffset! + this.lineHeight
            : this.lineHeight
        return { prepared: null, width: this.containerWidth, lineHeight: this.lineHeight, lines, height }
    }

    private computeLayout(): { layouts: BlockLayout[], totalHeight: number }
    {
        this.cacheHits = 0
        this.cacheMisses = 0

        const result: BlockLayout[] = []
        let cursorY = 0

        const floating = this.floats.length > 0

        this.state.doc.forEach((node, offset) =>
        {
            let cached: CachedBlock
            if (floating)
            {
                // Float-aware layout depends on the block's Y (relative to the
                // floats), so it can't use the Y-independent cache.
                cached = this.layoutBlockAt(node, cursorY)
                this.cacheMisses++
            }
            else
            {
                const hit = this.layoutCache.get(node)
                if (
                    hit
                    && hit.width === this.containerWidth
                    && hit.lineHeight === this.lineHeight
                )
                {
                    cached = hit
                    this.cacheHits++
                }
                else
                {
                    cached = this.layoutBlock(node)
                    this.layoutCache.set(node, cached)
                    this.cacheMisses++
                }
            }

            const positioned: LineLayout[] = cached.lines.map((line, i) => ({
                text: line.text,
                width: line.width,
                x: line.x ?? 0,
                y: cursorY + (line.yOffset ?? i * this.lineHeight),
                pmStart: line.pmStart,
                fragments: line.fragments,
            }))

            if (positioned.length === 0)
            {
                positioned.push({ text: '', width: 0, x: 0, y: cursorY, pmStart: 0 })
            }

            const blockHeight = cached.height || this.lineHeight

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

        const isVisible = (block: BlockLayout) => !virtualized
            || (block.yOffset + block.height >= viewTop && block.yOffset <= viewBottom)

        // Highlight backgrounds paint under everything (before the selection
        // overlay, so selecting highlighted text still shows the selection).
        for (const block of layouts)
        {
            if (!isVisible(block)) continue
            for (const line of block.lines)
            {
                if (!line.fragments) continue
                for (const frag of line.fragments)
                {
                    if (!frag.background) continue
                    ctx.fillStyle = frag.background
                    ctx.fillRect(line.x + frag.x, line.y, frag.width, this.lineHeight)
                }
            }
        }

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
                const lineColor = i === 0 ? this.firstLineColor : this.textColor

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
                            this.paintDecoration(ctx, frag, line, frag.baselineShift ?? 0)
                        }
                    }
                    ctx.font = this.font
                }
                else
                {
                    ctx.fillStyle = lineColor
                    ctx.fillText(line.text, line.x, line.y)
                }
            }
        }
    }

    /** Underline / strikethrough lines for a run, in the current fill color. */
    private paintDecoration(
        ctx: CanvasRenderingContext2D,
        frag: LineFragment,
        line: LineLayout,
        shift: number,
    ): void
    {
        const x = line.x + frag.x
        const thickness = Math.max(1, Math.round(this.baseFontSize / 14))
        if (frag.underline)
        {
            ctx.fillRect(x, line.y + shift + Math.round(this.baseFontSize * 0.92), frag.width, thickness)
        }
        if (frag.strikethrough)
        {
            ctx.fillRect(x, line.y + shift + Math.round(this.baseFontSize * 0.52), frag.width, thickness)
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
                const x1 = this.xForOffsetInLine(block, line, a - block.pmStartPos)

                // Selection continuing past this line trails to the container
                // edge; otherwise stop at the selection end on this line.
                const x2 = to > lineEnd
                    ? line.x + this.containerWidth
                    : this.xForOffsetInLine(block, line, Math.min(to, lineEnd) - block.pmStartPos)

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
        const lines = block.lines
        for (let i = 0; i < lines.length; i++)
        {
            const line = lines[i]
            const isLast = i === lines.length - 1
            const lineEnd = isLast ? block.text.length : lines[i + 1].pmStart

            // A position exactly at this line's end boundary normally renders
            // here, but a +1 bias leans it onto the next line's start instead
            // (the two are the same PM offset across a soft wrap).
            const leansToNextLine =
                offsetInBlock === lineEnd && !isLast && this.caretBias === 1

            if (!leansToNextLine && (offsetInBlock <= lineEnd || isLast))
            {
                return { x: this.xForOffsetInLine(block, line, offsetInBlock), y: line.y }
            }
        }

        return { x: 0, y: block.yOffset }
    }

    /**
     * Absolute x of a PM offset (within the block) on a given line. Dispatches
     * to the line's styled fragments (each measured in its own font) or, for a
     * plain line, a single measureText over the line text.
     */
    private xForOffsetInLine(block: BlockLayout, line: LineLayout, offsetInBlock: number): number
    {
        if (line.fragments)
        {
            for (const f of line.fragments)
            {
                const fEnd = f.pmStart + f.text.length
                if (offsetInBlock <= f.pmStart) return line.x + f.x
                if (offsetInBlock <= fEnd)
                {
                    this.measureCtx.font = f.font
                    const w = this.measureCtx.measureText(
                        f.text.substring(0, offsetInBlock - f.pmStart),
                    ).width
                    return line.x + f.x + w
                }
            }
            const last = line.fragments[line.fragments.length - 1]
            if (!last) return line.x
            // Past the last run: the offset is in collapsed trailing whitespace
            // (e.g. a space just typed at the end of a styled run). Pretext
            // dropped it from the run text, so advance the caret by the real
            // width of those characters — otherwise the caret looks "stuck".
            const lastEnd = last.pmStart + last.text.length
            this.measureCtx.font = last.font
            const trail = this.measureCtx.measureText(
                block.text.substring(lastEnd, offsetInBlock),
            ).width
            return line.x + last.x + last.width + trail
        }

        const offsetInLine = Math.max(0, Math.min(line.text.length, offsetInBlock - line.pmStart))
        if (offsetInLine === 0) return line.x
        this.measureCtx.font = this.font
        return line.x + this.measureCtx.measureText(line.text.substring(0, offsetInLine)).width
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

        const targetX = Math.max(0, canvasX - line.x)
        const offsetInBlock = Math.min(block.text.length, this.hitTestX(line, targetX))

        // When the click lands at the very start of a wrapped line (not the
        // first line of the block), that offset is shared with the previous
        // line's end — bias +1 so the caret renders on the line clicked, not
        // the one above. Every other case keeps the default -1.
        const bias: -1 | 1 = lineIdx > 0 && offsetInBlock === line.pmStart ? 1 : -1

        return { pos: block.pmStartPos + offsetInBlock, bias }
    }

    /**
     * The PM offset (within the block) nearest to a horizontal position on a
     * line. Snaps to grapheme boundaries. For styled lines it finds the
     * fragment under `targetX` (or the nearest one across a gap) and hit-tests
     * within it using that run's font.
     */
    private hitTestX(line: LineLayout, targetX: number): number
    {
        if (line.fragments)
        {
            const frags = line.fragments
            if (frags.length === 0) return line.pmStart
            if (targetX <= frags[0].x)
            {
                return frags[0].pmStart + this.hitTestInText(frags[0].text, frags[0].font, targetX - frags[0].x)
            }
            for (let i = 0; i < frags.length; i++)
            {
                const f = frags[i]
                const right = f.x + f.width
                if (targetX <= right)
                {
                    if (targetX < f.x)
                    {
                        // In the collapsed-whitespace gap between two runs —
                        // snap to whichever boundary is nearer.
                        const prev = frags[i - 1]
                        const mid = (prev.x + prev.width + f.x) / 2
                        return targetX < mid
                            ? prev.pmStart + prev.text.length
                            : f.pmStart
                    }
                    return f.pmStart + this.hitTestInText(f.text, f.font, targetX - f.x)
                }
            }
            const last = frags[frags.length - 1]
            return last.pmStart + last.text.length
        }

        return line.pmStart + this.hitTestInText(line.text, this.font, targetX)
    }

    /**
     * Binary-search grapheme boundaries of `text` (rendered in `font`) for the
     * boundary nearest `targetX`, returning a UTF-16 offset into `text`. Never
     * splits a surrogate pair, ZWJ sequence, or combining mark.
     */
    private hitTestInText(text: string, font: string, targetX: number): number
    {
        this.measureCtx.font = font
        const bounds = this.graphemeBoundaries(text)
        let lo = 0
        let hi = bounds.length - 1
        while (lo < hi)
        {
            const mid = (lo + hi + 1) >> 1
            const w = this.measureCtx.measureText(text.substring(0, bounds[mid])).width
            if (w <= targetX) lo = mid
            else hi = mid - 1
        }

        let offset = bounds[lo]
        if (lo < bounds.length - 1)
        {
            const wLo = bounds[lo] === 0
                ? 0
                : this.measureCtx.measureText(text.substring(0, bounds[lo])).width
            const wHi = this.measureCtx.measureText(text.substring(0, bounds[lo + 1])).width
            if ((targetX - wLo) > (wHi - targetX)) offset = bounds[lo + 1]
        }
        return offset
    }

    /**
     * The href of a link mark covering the document position, or null. Checks
     * the characters on both sides so a click anywhere on the link resolves.
     */
    private linkHrefAt(pos: number): string | null
    {
        const linkType = this.state.schema.marks[this.linkMark]
        if (!linkType) return null
        const $pos = this.state.doc.resolve(clamp(pos, 0, this.state.doc.content.size))
        const mark = (
            ($pos.nodeAfter ? linkType.isInSet($pos.nodeAfter.marks) : undefined)
            ?? ($pos.nodeBefore ? linkType.isInSet($pos.nodeBefore.marks) : undefined)
        )
        return mark ? (mark.attrs['href'] as string) : null
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

        // Web fonts often finish loading after construction (document.fonts.ready
        // can resolve before a font is even requested). Cached marked-block
        // geometry is measured at layout time, so drop the cache and repaint
        // when fonts settle — otherwise marked runs keep fallback-font metrics.
        if (typeof document !== 'undefined' && document.fonts)
        {
            const onFontsLoaded = () =>
            {
                this.layoutCache = new WeakMap()
                this.widthCache.clear()
                this.scheduleRender()
            }
            document.fonts.ready.then(onFontsLoaded)
            document.fonts.addEventListener('loadingdone', onFontsLoaded, { signal })
        }

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

            // Consumer key bindings (mark toggles, etc.) take precedence over
            // the built-in navigation/editing keys below.
            if (this.keymapHandler(e))
            {
                e.preventDefault()
                return
            }

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
            if (hit === null) return

            // Cmd/Ctrl-click follows a link instead of moving the caret.
            if (e.metaKey || e.ctrlKey)
            {
                const href = this.linkHrefAt(hit.pos)
                if (href !== null)
                {
                    this.onFollowLink(href, e)
                    return
                }
            }

            this.setHead(hit.pos, e.shiftKey)
            this.caretBias = hit.bias
            this.dragging = true
            this.textarea.focus()
        }, { signal })

        // Pointer cursor when a modifier-click would follow a link.
        this.canvas.addEventListener('mousemove', (e) =>
        {
            if (this.dragging) return
            let overLink = false
            if (e.metaKey || e.ctrlKey)
            {
                const { x, y } = this.eventToDocCoords(e)
                const hit = this.clickToPos(this.lastLayouts, x, y)
                overLink = hit !== null && this.linkHrefAt(hit.pos) !== null
            }
            this.canvas.style.cursor = overLink ? 'pointer' : ''
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

        this.canvas.addEventListener('dblclick', (e) =>
        {
            if (e.button !== 0) return
            e.preventDefault()
            this.dragging = false
            const { x, y } = this.eventToDocCoords(e)
            const hit = this.clickToPos(this.lastLayouts, x, y)
            if (hit === null) return
            const word = this.wordRangeAt(hit.pos)
            if (word)
            {
                const $a = this.state.doc.resolve(word.from)
                const $b = this.state.doc.resolve(word.to)
                this.dispatch(this.state.tr.setSelection(TextSelection.between($a, $b)))
            }
            this.textarea.focus()
        }, { signal })

        // The canvas selection lives in ProseMirror, not the DOM, so the
        // browser would copy the (empty) textarea. Serialize the selection
        // ourselves. Cut additionally deletes the range.
        this.textarea.addEventListener('copy', (e) =>
        {
            const text = this.selectionText()
            if (text === null) return
            e.preventDefault()
            e.clipboardData?.setData('text/plain', text)
        }, { signal })

        this.textarea.addEventListener('cut', (e) =>
        {
            const text = this.selectionText()
            if (text === null) return
            e.preventDefault()
            e.clipboardData?.setData('text/plain', text)
            this.dispatch(this.state.tr.deleteSelection())
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

    // ─── Selection helpers ─────────────────────────────────────────────

    /** Plain text of the current selection, or null when it's empty. */
    private selectionText(): string | null
    {
        const sel = this.state.selection
        if (sel.empty) return null
        return this.state.doc.textBetween(sel.from, sel.to, '\n')
    }

    /**
     * The document range of the word at a doc position, for double-click
     * selection. Returns the Intl word segment under the cursor (or the last
     * segment when the position sits at the block's end). Null if not in a
     * non-empty text block.
     */
    private wordRangeAt(pos: number): { from: number, to: number } | null
    {
        let block: BlockLayout | null = null
        for (const b of this.lastLayouts)
        {
            if (pos >= b.pmStartPos && pos <= b.pmEndPos) { block = b; break }
        }
        if (!block || block.text.length === 0) return null

        const offset = pos - block.pmStartPos
        let last: { start: number, end: number } | null = null
        for (const seg of this.wordSegmenter.segment(block.text))
        {
            const start = seg.index
            const end = start + seg.segment.length
            if (offset >= start && offset < end)
            {
                return { from: block.pmStartPos + start, to: block.pmStartPos + end }
            }
            last = { start, end }
        }
        // Position at the very end of the block — select the last segment.
        if (last) return { from: block.pmStartPos + last.start, to: block.pmStartPos + last.end }
        return null
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
            // Every line after the first begins at an internal soft-wrap
            // boundary (the block start at offset 0 doesn't count).
            for (let i = 1; i < block.lines.length; i++)
            {
                if (block.lines[i].pmStart === offsetInBlock) return true
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
