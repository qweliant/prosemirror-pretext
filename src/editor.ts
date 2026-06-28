import {
    type Mark, type Node as PMNode, type ResolvedPos,
    DOMParser as PMDOMParser, DOMSerializer, Slice, Fragment,
} from 'prosemirror-model'
import {
    EditorState, TextSelection, NodeSelection, Selection,
    type Command, type Transaction,
} from 'prosemirror-state'
import { GapCursor } from 'prosemirror-gapcursor'
import {
    clamp, expandCollapsedWhitespace, hitTestInText,
    nextGraphemeBoundary, prevGraphemeBoundary,
} from './text'

// prosemirror-gapcursor exposes these statics at runtime but omits them from
// its published types; alias them with the real signatures.
const GapCursorStatic = GapCursor as unknown as {
    findFrom($pos: ResolvedPos, dir: number, mustMove?: boolean): ResolvedPos | null
    valid($pos: ResolvedPos): boolean
}
import { joinBackward, joinForward } from 'prosemirror-commands'
import { splitListItem, liftListItem, sinkListItem } from 'prosemirror-schema-list'
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
    /** Prompt drawn when the document is empty. Default: none. */
    placeholder?: string
    /** Placeholder text color. Default: '#5a5a64'. */
    placeholderColor?: string
    /** Color of a horizontal-rule leaf node. Default: '#3a3a42'. */
    ruleColor?: string
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
     * Per-block-type text styling (font size/weight/family, line height, color)
     * — e.g. headings. Merged over the built-in `heading` default (sized by
     * `node.attrs.level`). An entry may be a `(node) => style` function.
     */
    blockStyles?: Record<string, BlockStyleResolver | null>
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
    /**
     * Render custom interactive DOM for leaf/atom block nodes (à la
     * ProseMirror node views). Keyed by node type name; the returned element is
     * mounted, positioned over the space the editor reserves for the node, and
     * destroyed when the node is removed. `getPos` returns the node's live
     * document position (e.g. for `NodeSelection.create(state.doc, getPos())`).
     */
    nodeViews?: Record<string, NodeViewFn>
    /** Called after every render with timing/cache stats. */
    onRender?: (stats: RenderStats) => void
    /**
     * Accessible name announced for the editor (the input's `aria-label`).
     * Default: 'Rich text editor'.
     */
    ariaLabel?: string
    /**
     * Maintain a visually-hidden, screen-reader-visible DOM mirror of the
     * document (built from the schema's `toDOM`) so assistive tech can read the
     * structure the canvas can't expose. Default: true.
     */
    a11yMirror?: boolean
    /**
     * Make a node float: text flows around it (à la Pretext's obstacles) instead
     * of it taking a block line. Return a content-space rect (height is the node
     * view's measured height) or null to keep the node in normal flow. The node
     * still needs a `nodeViews` entry that renders + positions it.
     */
    floatRect?: (node: PMNode) => { x: number, y: number, width: number } | null
}

/** Builds the DOM for a leaf/atom block node. See `nodeViews`. */
export type NodeViewFn = (node: PMNode, getPos: () => number) => HTMLElement

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

/** Per-block text styling + box decorations (headings, quotes, code). See `blockStyles`. */
export interface BlockStyle
{
    fontSize?: number
    fontWeight?: string | number
    fontStyle?: 'normal' | 'italic' | 'oblique'
    fontFamily?: string
    lineHeight?: number
    color?: string
    /** Horizontal text inset from the content edges. */
    paddingLeft?: number
    paddingRight?: number
    /** Vertical padding added inside the block's painted box. */
    paddingTop?: number
    paddingBottom?: number
    /** Background panel painted behind the whole block (e.g. code blocks). */
    background?: string
    /** Left accent bar (e.g. blockquotes). */
    borderLeft?: { width: number, color: string }
}

export type BlockStyleResolver = BlockStyle | ((node: PMNode) => BlockStyle | null)

/** Resolved block base style, ready for layout/paint. */
interface ResolvedBlockStyle
{
    font: string
    fontSize: number
    fontFamily: string
    fontWeight: string
    fontStyle: string
    lineHeight: number
    color: string | null
    paddingLeft: number
    paddingRight: number
    paddingTop: number
    paddingBottom: number
    background: string | null
    borderLeft: { width: number, color: string } | null
    textAlign: 'left' | 'center' | 'right'
}

const HEADING_SCALE: Record<number, number> = { 1: 2, 2: 1.5, 3: 1.25, 4: 1.1, 5: 1, 6: 0.9 }

/** Horizontal offset to add to a line's left edge for the block's alignment. */
function alignOffset(availWidth: number, lineWidth: number, align: 'left' | 'center' | 'right'): number
{
    if (align === 'center') return Math.max(0, (availWidth - lineWidth) / 2)
    if (align === 'right') return Math.max(0, availWidth - lineWidth)
    return 0
}

/** Elements that make a node view interactive (so it must stay in the a11y tree). */
const FOCUSABLE_SEL = 'a[href], button, input, select, textarea, [tabindex], [contenteditable="true"]'

/** Visually hidden, but kept in the accessibility tree (the "sr-only" recipe). */
const SR_ONLY: Partial<CSSStyleDeclaration> = {
    position: 'absolute',
    width: '1px', height: '1px',
    margin: '-1px', padding: '0', border: '0',
    overflow: 'hidden', clip: 'rect(0 0 0 0)', clipPath: 'inset(50%)',
    whiteSpace: 'nowrap',
}

/** Horizontal indent added per list nesting level. */
const LIST_INDENT = 26
/** Left pad of a list marker within its gutter. */
const MARKER_PAD = 4

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
    /** A leaf/atom block rendered by a node view (no text lines). */
    isAtom?: boolean
    /** Set when the block is a floating node: its content-space rect (text wraps
     *  around it; the node view is positioned here rather than full-width). */
    floatRect?: { x: number, y: number, width: number, height: number }
    /** Resolved block base style (per-block headings etc.; editor base by default). */
    lineHeight: number
    font: string
    fontSize: number
    color: string | null
    /** Box decorations (0/null for plain paragraphs). */
    paddingTop: number
    paddingBottom: number
    background: string | null
    borderLeft: { width: number, color: string } | null
    /** List marker (bullet/number) drawn in the gutter of the first line. */
    marker: { text: string, x: number } | null
}


// ─── Internal Types ────────────────────────────────────────────────────────

/** A document block flattened from the tree: its node, absolute position, list
 *  indent (px), and optional list marker. */
interface BlockDesc
{
    node: PMNode
    pos: number
    indent: number
    marker: { text: string, x: number } | null
    leaf: boolean
}

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
    // Resolved block base style (font/size/color); defaults to the editor base.
    font: string
    fontSize: number
    color: string | null
    // Box decorations (0/null for plain paragraphs).
    paddingLeft: number
    paddingRight: number
    paddingTop: number
    paddingBottom: number
    background: string | null
    borderLeft: { width: number, color: string } | null
    /** List indent (px) folded into paddingLeft; tracked for cache validity. */
    indent: number
}

/** A live node-view: the consumer element wrapped in a positioned container. */
interface MountedView
{
    container: HTMLDivElement
    dom: HTMLElement
    pos: number
    resizeObserver: ResizeObserver | null
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

/** One hard line of a marked block (the text between two '\n' boundaries). */
interface MarkedSegment
{
    items: RichInlineItem[]
    meta: MarkedLineCtx['meta']
    /** Block-space PM offset where this segment begins (after the preceding '\n'). */
    startOffset: number
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
    private readonly placeholder: string
    private readonly placeholderColor: string
    private readonly ruleColor: string
    private readonly maxHeight: number | null
    private readonly caretWidth = 2
    private readonly caretBlinkMs = 530
    private readonly caretHoldMs = 500
    private readonly onRender?: (stats: RenderStats) => void

    // ─── Marks & blocks ────────────────────────────────────────────────
    private readonly markStyles: Record<string, MarkStyleResolver>
    private readonly blockStyles: Record<string, BlockStyleResolver>
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
    // The full exclusion set used for a given layout pass: consumer `floats`
    // plus rects derived from floating nodes (see floatRect). Read by slotForBand.
    private activeFloats: FloatRect[] = []
    // Derives a float rect for a node (text wraps around it), or null for in-flow.
    private readonly floatRectFor: ((node: PMNode) => { x: number, y: number, width: number } | null) | null
    // Breathing room kept around each float so text never kisses its edge.
    private readonly floatGutter: number

    // ─── Links ─────────────────────────────────────────────────────────
    private readonly linkMark: string
    private readonly onFollowLink: (href: string, event: MouseEvent) => void

    // ─── Node views (atom blocks) ──────────────────────────────────────
    private readonly nodeViews: Record<string, NodeViewFn>
    // Mounted views keyed by node identity (stable across unrelated edits).
    private readonly mountedViews = new Map<PMNode, MountedView>()
    // Measured heights so layout can reserve space for each atom block.
    private readonly nodeViewHeights = new Map<PMNode, number>()
    private readonly defaultAtomHeight = 40
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
    // Accessibility: a screen-reader-visible structural mirror, a polite live
    // region for announcements, and whether motion is reduced (caret blink).
    private readonly a11yMirror: HTMLElement | null
    private readonly liveRegion: HTMLElement
    private readonly reducedMotion: boolean
    private readonly serializer: DOMSerializer
    private lastAnnouncedContext = ''
    private lastMirrorDoc: PMNode | null = null

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
        this.placeholder = options.placeholder ?? ''
        this.placeholderColor = options.placeholderColor ?? '#5a5a64'
        this.ruleColor = options.ruleColor ?? '#3a3a42'
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

        // Default block styles (headings sized by level); merge caller overrides.
        this.blockStyles = {
            heading: (node) =>
            {
                const size = Math.round(this.baseFontSize * (HEADING_SCALE[node.attrs['level'] as number] ?? 1))
                return { fontSize: size, fontWeight: 700, lineHeight: Math.round(size * 1.3) }
            },
            blockquote: {
                fontStyle: 'italic', color: '#8a8a96',
                paddingLeft: 18, paddingTop: 2, paddingBottom: 2,
                borderLeft: { width: 3, color: '#3a3a42' },
            },
            code_block: {
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                color: '#c0caf5', background: '#1c1c20',
                paddingLeft: 14, paddingRight: 14, paddingTop: 10, paddingBottom: 10,
            },
        }
        for (const [name, style] of Object.entries(options.blockStyles ?? {}))
        {
            if (style === null) delete this.blockStyles[name]
            else this.blockStyles[name] = style
        }

        // keydownHandler is typed against prosemirror-view's EditorView, but
        // only touches state/dispatch — feed it our minimal shim.
        const compiled = keydownHandler(options.keymap ?? {})
        this.keymapHandler = (event) =>
            compiled(this.commandView() as never, event)

        this.floats = options.floats ?? []
        this.floatRectFor = options.floatRect ?? null
        this.floatGutter = options.floatGutter ?? 12
        this.linkMark = options.linkMark ?? 'link'
        this.onFollowLink = options.onFollowLink
            ?? ((href) => { window.open(href, '_blank', 'noopener') })
        this.nodeViews = options.nodeViews ?? {}

        // Build DOM
        const stack = document.createElement('div')
        stack.style.position = 'relative'
        stack.style.cursor = 'text'
        this.stack = stack

        this.canvas = document.createElement('canvas')
        this.canvas.style.display = 'block'
        // The canvas is decorative pixels; assistive tech reads the mirror below.
        this.canvas.setAttribute('aria-hidden', 'true')
        this.canvas.setAttribute('role', 'presentation')

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
        this.textarea.setAttribute('aria-label', options.ariaLabel ?? 'Rich text editor')
        this.textarea.setAttribute('aria-multiline', 'true')
        this.textarea.setAttribute('role', 'textbox')

        // Polite live region: format/structure changes and custom announcements.
        this.liveRegion = document.createElement('div')
        this.liveRegion.setAttribute('aria-live', 'polite')
        this.liveRegion.setAttribute('aria-atomic', 'true')
        Object.assign(this.liveRegion.style, SR_ONLY)

        // Structural mirror: the document serialized via the schema's toDOM,
        // kept in the a11y tree (visually hidden) for screen-reader browse mode.
        this.serializer = DOMSerializer.fromSchema(this.state.schema)
        if (options.a11yMirror !== false)
        {
            this.a11yMirror = document.createElement('div')
            this.a11yMirror.setAttribute('aria-label', options.ariaLabel ?? 'Rich text editor')
            this.a11yMirror.setAttribute('role', 'document')
            Object.assign(this.a11yMirror.style, SR_ONLY)
        }
        else
        {
            this.a11yMirror = null
        }

        this.reducedMotion = typeof matchMedia !== 'undefined'
            && matchMedia('(prefers-reduced-motion: reduce)').matches

        // Visible focus indicator while the (offscreen) textarea holds focus.
        this.textarea.addEventListener('focus', () => { stack.style.outline = `2px solid ${this.caretColor}` ; stack.style.outlineOffset = '2px' })
        this.textarea.addEventListener('blur', () => { stack.style.outline = 'none' })

        stack.appendChild(this.canvas)
        stack.appendChild(this.textarea)
        stack.appendChild(this.liveRegion)
        if (this.a11yMirror) stack.appendChild(this.a11yMirror)

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
        this.syncA11y()
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
        this.syncA11y()
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

    // ─── Accessibility ─────────────────────────────────────────────────

    /**
     * Announce a message to screen readers via the polite live region. Public so
     * consumers can voice their own events (e.g. a node view's result).
     */
    announce(message: string): void
    {
        // Re-set even if identical: clear first so repeats are re-read.
        this.liveRegion.textContent = ''
        this.liveRegion.textContent = message
    }

    /** Refresh the structural mirror (on doc change) and announce a new block
     *  context (on selection change). Called from dispatch/construction. */
    private syncA11y(): void
    {
        if (this.a11yMirror && this.state.doc !== this.lastMirrorDoc)
        {
            this.lastMirrorDoc = this.state.doc
            this.a11yMirror.replaceChildren(
                this.serializer.serializeFragment(this.state.doc.content),
            )
        }
        const ctx = this.describeContext()
        if (ctx !== this.lastAnnouncedContext)
        {
            this.lastAnnouncedContext = ctx
            if (ctx) this.announce(ctx)
        }
    }

    /** A short label for the block at the caret, announced as the user navigates
     *  between structural contexts (plain paragraphs announce nothing). */
    private describeContext(): string
    {
        const sel = this.state.selection
        if (sel instanceof GapCursor) return 'Between blocks'
        if (sel instanceof NodeSelection)
        {
            const n = sel.node
            const alt = n.attrs['alt'] as string | undefined
            return `${n.type.name}${alt ? `, ${alt}` : ''}, selected`
        }
        const $from = sel.$from
        for (let d = $from.depth; d > 0; d--)
        {
            if (this.isListNode($from.node(d)))
            {
                const ordered = this.isOrderedList($from.node(d))
                return ordered ? 'Ordered list item' : 'Bullet list item'
            }
        }
        const name = $from.parent.type.name
        if (name === 'heading') return `Heading ${($from.parent.attrs['level'] as number) ?? 1}`
        if (name === 'code_block') return 'Code block'
        if (name === 'blockquote') return 'Quote'
        return ''
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
            height: coords.height,
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
        for (const view of this.mountedViews.values()) view.resizeObserver?.disconnect()
        this.mountedViews.clear()
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


    /** Lay out one block, choosing the single-font fast path or the marked path. */
    private layoutBlock(node: PMNode, indent = 0): CachedBlock
    {
        const base = this.blockBase(node, indent)
        const text = node.textContent
        if (text.length === 0)
        {
            return {
                prepared: null,
                width: this.containerWidth,
                lineHeight: base.lineHeight,
                lines: [],
                height: 0,
                ...this.boxFields(base, indent),
            }
        }

        if (this.blockHasMarks(node))
        {
            return this.layoutMarkedBlock(node, indent)
        }

        // Fast path: a single font for the whole block. 'pre-wrap' keeps every
        // space as a real character (default 'normal' collapses runs of
        // whitespace), so line text stays in lockstep with PM offsets and the
        // caret doesn't drift when you type consecutive spaces.
        const availW = this.blockContentWidth(base)
        const prepared = prepareWithSegments(text, base.font, { whiteSpace: 'pre-wrap' })
        const { lines, height } = layoutWithLines(
            prepared, availW, base.lineHeight,
        )
        let acc = 0
        const cachedLines: CachedLine[] = lines.map((l) =>
        {
            const cl = {
                text: l.text, width: l.width, pmStart: acc,
                x: base.paddingLeft + alignOffset(availW, l.width, base.textAlign),
            }
            acc += l.text.length
            // 'pre-wrap' breaks on a hard newline but drops it from the line
            // text; skip it so the next line's offset stays aligned with source.
            if (text[acc] === '\n') acc += 1
            return cl
        })
        return {
            prepared,
            width: this.containerWidth,
            lineHeight: base.lineHeight,
            lines: cachedLines,
            height,
            ...this.boxFields(base, indent),
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
    private resolveRunStyle(marks: readonly Mark[], base: ResolvedBlockStyle): {
        font: string, color: string | null, background: string | null,
        underline: boolean, strikethrough: boolean, baselineShift: number,
    }
    {
        // Marks compose over the block's base style (so bold in an h1 is bold
        // at h1 size).
        let fontStyle = base.fontStyle
        let fontWeight = base.fontWeight
        let family = base.fontFamily
        let color: string | null = base.color
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
            ? Math.round(base.fontSize * 0.72)
            : base.fontSize
        const baselineShift = verticalAlign === 'super'
            ? -Math.round(base.fontSize * 0.30)
            : verticalAlign === 'sub'
                ? Math.round(base.fontSize * 0.18)
                : 0

        const font = `${fontStyle} ${fontWeight} ${size}px ${family}`
            .replace(/\s+/g, ' ')
            .trim()
        return { font, color, background, underline, strikethrough, baselineShift }
    }

    /** The base text style for a block (font/line-height/color). Defaults to
     * the editor's base; `blockStyles` overrides per node type (e.g. headings). */
    private resolveBlockStyle(node: PMNode): ResolvedBlockStyle
    {
        // Per-instance text alignment from the node's `align` attribute.
        const a = node.attrs['align']
        const textAlign: 'left' | 'center' | 'right' =
            a === 'center' || a === 'right' ? a : 'left'

        const entry = this.blockStyles[node.type.name]
        const bs = typeof entry === 'function' ? entry(node) : entry
        if (!bs)
        {
            return {
                font: this.font, fontSize: this.baseFontSize,
                fontFamily: this.baseFontFamily, fontWeight: '', fontStyle: '',
                lineHeight: this.lineHeight, color: null,
                paddingLeft: 0, paddingRight: 0, paddingTop: 0, paddingBottom: 0,
                background: null, borderLeft: null, textAlign,
            }
        }
        const fontSize = bs.fontSize ?? this.baseFontSize
        const fontFamily = bs.fontFamily ?? this.baseFontFamily
        const fontWeight = bs.fontWeight !== undefined ? String(bs.fontWeight) : ''
        const fontStyle = bs.fontStyle ?? ''
        const font = `${fontStyle} ${fontWeight} ${fontSize}px ${fontFamily}`
            .replace(/\s+/g, ' ').trim()
        return {
            font, fontSize, fontFamily, fontWeight, fontStyle,
            lineHeight: bs.lineHeight ?? this.lineHeight, color: bs.color ?? null,
            paddingLeft: bs.paddingLeft ?? 0, paddingRight: bs.paddingRight ?? 0,
            paddingTop: bs.paddingTop ?? 0, paddingBottom: bs.paddingBottom ?? 0,
            background: bs.background ?? null, borderLeft: bs.borderLeft ?? null, textAlign,
        }
    }

    /** The style/box fields shared by every CachedBlock, from a resolved base.
     *  `indent` is the raw list indent already folded into base.paddingLeft. */
    private boxFields(base: ResolvedBlockStyle, indent = 0)
    {
        return {
            font: base.font, fontSize: base.fontSize, color: base.color,
            paddingLeft: base.paddingLeft, paddingRight: base.paddingRight,
            paddingTop: base.paddingTop, paddingBottom: base.paddingBottom,
            background: base.background, borderLeft: base.borderLeft, indent,
        }
    }

    /** Resolve a block's base style, folding a list indent into its left pad. */
    private blockBase(node: PMNode, indent: number): ResolvedBlockStyle
    {
        const rbs = this.resolveBlockStyle(node)
        return indent ? { ...rbs, paddingLeft: rbs.paddingLeft + indent } : rbs
    }

    /** Content width available to a block after its horizontal padding. */
    private blockContentWidth(base: ResolvedBlockStyle): number
    {
        return this.containerWidth - base.paddingLeft - base.paddingRight
    }

    /**
     * Lay out a block whose inline content carries marks. Adjacent runs that
     * resolve to the same style are merged into one Pretext rich-inline item;
     * we track each item's PM start so fragment text can be mapped back to
     * document offsets later (Pretext trims boundary whitespace into gaps, so
     * mapping is item-relative, not a flat character count).
     */
    /**
     * Split a marked block into hard-line segments at every '\n', preparing each
     * for rich-inline layout. The newline characters are boundaries (not part of
     * any run); within a segment, Pretext still soft-wraps on width. PM offsets
     * stay in block space, so caret/click mapping is unchanged for single-line
     * blocks and gains correct '\n' attribution for multi-line ones.
     */
    private prepareMarkedSegments(node: PMNode, base: ResolvedBlockStyle): { segments: MarkedSegment[], blockText: string }
    {
        const blockText = node.textContent
        type Run = {
            font: string, color: string | null, background: string | null,
            text: string, pmStart: number, underline: boolean, strikethrough: boolean,
            baselineShift: number,
        }
        const segments: MarkedSegment[] = []
        let seg: MarkedSegment = { items: [], meta: [], startOffset: 0 }
        segments.push(seg)
        let cur: Run | null = null

        const flushRun = () =>
        {
            if (!cur) return
            const leadTrim = cur.text.length - cur.text.trimStart().length
            const trimmed = cur.text.replace(/^\s+/, '').replace(/\s+$/, '')
            seg.items.push({ text: cur.text, font: cur.font })
            seg.meta.push({
                pmStart: cur.pmStart, leadTrim, font: cur.font, color: cur.color,
                background: cur.background, trimmed,
                underline: cur.underline, strikethrough: cur.strikethrough,
                baselineShift: cur.baselineShift,
            })
            cur = null
        }
        const breakSegment = (startOffset: number) =>
        {
            flushRun()
            seg = { items: [], meta: [], startOffset }
            segments.push(seg)
        }

        let offset = 0
        node.forEach((child) =>
        {
            const childText = child.isText ? (child.text ?? '') : ''
            const style = this.resolveRunStyle(child.marks, base)
            const parts = childText.split('\n')
            let local = offset
            for (let i = 0; i < parts.length; i++)
            {
                if (i > 0) { local += 1; breakSegment(local) } // skip the '\n'
                const part = parts[i]
                if (part.length === 0) continue
                if (
                    cur && cur.font === style.font && cur.color === style.color
                    && cur.background === style.background && cur.underline === style.underline
                    && cur.strikethrough === style.strikethrough && cur.baselineShift === style.baselineShift
                )
                {
                    cur.text += part
                }
                else
                {
                    flushRun()
                    cur = { ...style, text: part, pmStart: local }
                }
                local += part.length
            }
            offset += child.nodeSize
        })
        flushRun()

        return { segments, blockText }
    }

    private layoutMarkedBlock(node: PMNode, indent = 0): CachedBlock
    {
        const base = this.blockBase(node, indent)
        const { segments, blockText } = this.prepareMarkedSegments(node, base)
        const lines: CachedLine[] = []
        const ctx: MarkedLineCtx = { meta: [], blockText, consumed: [], prevLineEnd: 0 }
        const width = this.blockContentWidth(base)

        for (const seg of segments)
        {
            // A segment's first line owns the preceding '\n' offset (startOffset-1)
            // so an offset just after the break resolves onto the new line — the
            // same tiling the single-font 'pre-wrap' path produces.
            const segPmStart = seg.startOffset > 0 ? seg.startOffset - 1 : 0
            if (seg.items.length === 0)
            {
                lines.push({ text: '', width: 0, pmStart: segPmStart, x: base.paddingLeft, fragments: [] })
                ctx.prevLineEnd = segPmStart
                continue
            }
            const prepared = prepareRichInline(seg.items)
            ctx.meta = seg.meta
            ctx.consumed = new Array(seg.items.length).fill(0)
            const segLineStart = lines.length
            // Pretext decides which runs land on which line; buildMarkedLine then
            // measures geometry with the paint context so fragment widths match
            // fillText and stay consistent with measureText-based hit-testing.
            walkRichInlineLineRanges(prepared, width, (range) =>
            {
                const line = this.buildMarkedLine(prepared, range, ctx, lines.length === 0)
                line.x = base.paddingLeft + alignOffset(width, line.width, base.textAlign)
                lines.push(line)
            })
            if (segLineStart > 0 && lines.length > segLineStart)
            {
                lines[segLineStart].pmStart = segPmStart
            }
        }

        return {
            prepared: null,
            width: this.containerWidth,
            lineHeight: base.lineHeight,
            lines,
            height: lines.length * base.lineHeight,
            ...this.boxFields(base, indent),
        }
    }

    /** Float-aware counterpart of layoutBlock: lays each line at its own width. */
    private layoutBlockAt(node: PMNode, topY: number, indent = 0): CachedBlock
    {
        const base = this.blockBase(node, indent)
        const text = node.textContent
        if (text.length === 0)
        {
            return {
                prepared: null, width: this.containerWidth,
                lineHeight: base.lineHeight, lines: [], height: 0,
                ...this.boxFields(base, indent),
            }
        }
        if (this.blockHasMarks(node))
        {
            const { segments, blockText } = this.prepareMarkedSegments(node, base)
            return this.layoutMarkedBlockFloated(segments, blockText, base, topY)
        }
        const prepared = prepareWithSegments(text, base.font, { whiteSpace: 'pre-wrap' })
        return this.layoutBlockFloated(prepared, text, base, topY)
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
            const [text, end] = expandCollapsedWhitespace(m.trimmed, start, f.text)
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
    private slotForBand(bandTop: number, lineHeight: number = this.lineHeight): { x: number, width: number } | null
    {
        const bandBottom = bandTop + lineHeight
        const g = this.floatGutter
        let slots: { left: number, right: number }[] = [{ left: 0, right: this.containerWidth }]
        for (const f of this.activeFloats)
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
    private layoutBlockFloated(prepared: PreparedTextWithSegments, text: string, base: ResolvedBlockStyle, topY: number): CachedBlock
    {
        const lh = base.lineHeight
        const lines: CachedLine[] = []
        let cursor: LayoutCursor = { segmentIndex: 0, graphemeIndex: 0 }
        let bandTop = 0
        let acc = 0
        // Guard against a malformed float producing an unbounded skip loop.
        for (let guard = 0; guard < 20000; guard++)
        {
            const slot = this.slotForBand(topY + bandTop, lh)
            if (!slot) { bandTop += lh; continue }
            const w = slot.width - base.paddingLeft - base.paddingRight
            const line = layoutNextLine(prepared, cursor, w)
            if (!line) break
            lines.push({
                text: line.text, width: line.width, pmStart: acc,
                x: slot.x + base.paddingLeft + alignOffset(w, line.width, base.textAlign),
                yOffset: bandTop,
            })
            acc += line.text.length
            // Skip the hard newline 'pre-wrap' dropped at the break (see layoutBlock).
            if (text[acc] === '\n') acc += 1
            cursor = line.end
            bandTop += lh
        }
        const height = lines.length > 0 ? lines[lines.length - 1].yOffset! + lh : lh
        return {
            prepared, width: this.containerWidth, lineHeight: lh, lines, height,
            ...this.boxFields(base),
        }
    }

    /** Marked block laid out line-by-line (hard-line segments), flowing around floats. */
    private layoutMarkedBlockFloated(
        segments: MarkedSegment[], blockText: string, base: ResolvedBlockStyle, topY: number,
    ): CachedBlock
    {
        const lh = base.lineHeight
        const lines: CachedLine[] = []
        const ctx: MarkedLineCtx = { meta: [], blockText, consumed: [], prevLineEnd: 0 }
        let bandTop = 0
        for (const seg of segments)
        {
            const segPmStart = seg.startOffset > 0 ? seg.startOffset - 1 : 0
            if (seg.items.length === 0)
            {
                const slot = this.slotForBand(topY + bandTop, lh)
                lines.push({ text: '', width: 0, pmStart: segPmStart, x: (slot?.x ?? 0) + base.paddingLeft, yOffset: bandTop, fragments: [] })
                ctx.prevLineEnd = segPmStart
                bandTop += lh
                continue
            }
            const prepared = prepareRichInline(seg.items)
            ctx.meta = seg.meta
            ctx.consumed = new Array(seg.items.length).fill(0)
            const segLineStart = lines.length
            let cursor: RichInlineCursor | undefined
            for (let guard = 0; guard < 20000; guard++)
            {
                const slot = this.slotForBand(topY + bandTop, lh)
                if (!slot) { bandTop += lh; continue }
                const w = slot.width - base.paddingLeft - base.paddingRight
                const range = layoutNextRichInlineLineRange(prepared, w, cursor)
                if (!range) break
                const line = this.buildMarkedLine(prepared, range, ctx, lines.length === 0)
                line.x = slot.x + base.paddingLeft + alignOffset(w, line.width, base.textAlign)
                line.yOffset = bandTop
                lines.push(line)
                cursor = range.end
                bandTop += lh
            }
            if (segLineStart > 0 && lines.length > segLineStart)
            {
                lines[segLineStart].pmStart = segPmStart
            }
        }
        const height = lines.length > 0 ? lines[lines.length - 1].yOffset! + lh : lh
        return {
            prepared: null, width: this.containerWidth, lineHeight: lh, lines, height,
            ...this.boxFields(base),
        }
    }

    private computeLayout(): { layouts: BlockLayout[], totalHeight: number }
    {
        this.cacheHits = 0
        this.cacheMisses = 0

        const result: BlockLayout[] = []
        let cursorY = 0

        const descs: BlockDesc[] = []
        this.collectBlocks(this.state.doc, 0, 0, null, descs)

        // Pre-pass: derive float rects from floating nodes so text on every band
        // (not just below them) flows around them. Their measured node-view height
        // completes the rect; out of flow, they don't advance the block cursor.
        const floatRects = new Map<PMNode, { x: number, y: number, width: number, height: number }>()
        if (this.floatRectFor)
        {
            for (const d of descs)
            {
                if (!d.leaf || this.isRuleNode(d.node)) continue
                const r = this.floatRectFor(d.node)
                if (!r) continue
                floatRects.set(d.node, {
                    x: r.x, y: r.y, width: r.width,
                    height: this.nodeViewHeights.get(d.node) ?? this.defaultAtomHeight,
                })
            }
        }
        this.activeFloats = floatRects.size > 0
            ? [...this.floats, ...floatRects.values()]
            : this.floats
        const floating = this.activeFloats.length > 0

        for (const { node, pos, indent, marker, leaf } of descs)
        {
            // Leaf/atom block (node view or canvas-drawn rule): reserve height.
            if (leaf)
            {
                const fr = floatRects.get(node)
                if (fr)
                {
                    // Floating node: positioned at its rect, out of the flow.
                    result.push({
                        type: node.type.name, node, text: '', yOffset: fr.y, height: fr.height,
                        lines: [], pmStartPos: pos, pmEndPos: pos + node.nodeSize,
                        isAtom: true, lineHeight: this.lineHeight, font: this.font,
                        fontSize: this.baseFontSize, color: null,
                        paddingTop: 0, paddingBottom: 0, background: null, borderLeft: null,
                        marker, floatRect: fr,
                    })
                    continue
                }
                const height = this.isRuleNode(node)
                    ? this.lineHeight
                    : (this.nodeViewHeights.get(node) ?? this.defaultAtomHeight)
                result.push({
                    type: node.type.name, node, text: '', yOffset: cursorY, height,
                    lines: [], pmStartPos: pos, pmEndPos: pos + node.nodeSize,
                    isAtom: true, lineHeight: this.lineHeight, font: this.font,
                    fontSize: this.baseFontSize, color: null,
                    paddingTop: 0, paddingBottom: 0, background: null, borderLeft: null, marker,
                })
                cursorY += height + this.blockGap
                continue
            }

            let cached: CachedBlock
            if (floating)
            {
                // Float-aware layout depends on the block's Y (relative to the
                // floats), so it can't use the Y-independent cache.
                cached = this.layoutBlockAt(node, cursorY, indent)
                this.cacheMisses++
            }
            else
            {
                // Node identity + indent are sufficient (width/font are fixed).
                const hit = this.layoutCache.get(node)
                if (hit && hit.indent === indent)
                {
                    cached = hit
                    this.cacheHits++
                }
                else
                {
                    cached = this.layoutBlock(node, indent)
                    this.layoutCache.set(node, cached)
                    this.cacheMisses++
                }
            }

            const padTop = cached.paddingTop
            const positioned: LineLayout[] = cached.lines.map((line, i) => ({
                text: line.text,
                width: line.width,
                x: line.x ?? 0,
                y: cursorY + padTop + (line.yOffset ?? i * cached.lineHeight),
                pmStart: line.pmStart,
                fragments: line.fragments,
            }))

            if (positioned.length === 0)
            {
                positioned.push({ text: '', width: 0, x: cached.paddingLeft, y: cursorY + padTop, pmStart: 0 })
            }

            const blockHeight = (cached.height || cached.lineHeight) + padTop + cached.paddingBottom

            result.push({
                type: node.type.name,
                node,
                text: node.textContent,
                yOffset: cursorY,
                height: blockHeight,
                lines: positioned,
                pmStartPos: pos + 1,
                pmEndPos: pos + 1 + node.textContent.length,
                lineHeight: cached.lineHeight, font: cached.font,
                fontSize: cached.fontSize, color: cached.color,
                paddingTop: padTop, paddingBottom: cached.paddingBottom,
                background: cached.background, borderLeft: cached.borderLeft, marker,
            })

            cursorY += blockHeight + this.blockGap
        }

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

        // Block box decorations (code-block panel, blockquote bar) paint first,
        // beneath highlights, selection, and text.
        for (const block of layouts)
        {
            if (!isVisible(block)) continue
            if (block.isAtom && this.isRuleNode(block.node))
            {
                ctx.fillStyle = this.ruleColor
                ctx.fillRect(0, Math.round(block.yOffset + block.height / 2), this.containerWidth, 2)
                continue
            }
            if (!block.background && !block.borderLeft) continue
            if (block.background)
            {
                ctx.fillStyle = block.background
                ctx.fillRect(0, block.yOffset, this.containerWidth, block.height)
            }
            if (block.borderLeft)
            {
                ctx.fillStyle = block.borderLeft.color
                ctx.fillRect(0, block.yOffset, block.borderLeft.width, block.height)
            }
        }

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
                    ctx.fillRect(line.x + frag.x, line.y, frag.width, block.lineHeight)
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

            // List marker (bullet/number) in the gutter of the first line.
            if (block.marker && block.lines.length > 0)
            {
                ctx.font = block.font
                ctx.fillStyle = this.textColor
                ctx.fillText(block.marker.text, block.marker.x, block.lines[0].y)
            }

            for (let i = 0; i < block.lines.length; i++)
            {
                const line = block.lines[i]
                const lineColor = block.color ?? (i === 0 ? this.firstLineColor : this.textColor)

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
                            this.paintDecoration(ctx, frag, line, frag.baselineShift ?? 0, block.fontSize)
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

        // Placeholder prompt when the whole document is empty.
        if (this.placeholder && this.isDocEmpty() && layouts.length > 0)
        {
            const block = layouts[0]
            const line = block.lines[0]
            ctx.font = block.font
            ctx.fillStyle = this.placeholderColor
            ctx.fillText(this.placeholder, line.x, line.y)
        }
    }

    /** A leaf block conventionally rendered as a horizontal rule. */
    private isRuleNode(node: PMNode): boolean
    {
        const n = node.type.name
        return n === 'horizontal_rule' || n === 'hr'
    }

    private isListNode(node: PMNode): boolean
    {
        const n = node.type.name
        return n === 'bullet_list' || n === 'ordered_list'
            || n === 'bulletList' || n === 'orderedList'
    }

    private isOrderedList(node: PMNode): boolean
    {
        const n = node.type.name
        return n === 'ordered_list' || n === 'orderedList'
    }

    private isLeafBlock(node: PMNode): boolean
    {
        return !node.isTextblock && (!!this.nodeViews[node.type.name] || this.isRuleNode(node))
    }

    /**
     * Flatten the document tree into block descriptors in document order. Lists
     * recurse: each item's blocks carry a per-level indent, and the item's first
     * block gets the bullet/number marker. Non-list containers recurse without
     * indent. The flat (no-list) case yields exactly the top-level blocks.
     */
    private collectBlocks(node: PMNode, contentStart: number, depth: number, marker: BlockDesc['marker'], out: BlockDesc[]): void
    {
        let pending = marker
        node.forEach((child, offset) =>
        {
            const pos = contentStart + offset
            if (this.isListNode(child))
            {
                const ordered = this.isOrderedList(child)
                let n = ordered ? ((child.attrs['order'] as number) ?? (child.attrs['start'] as number) ?? 1) : 0
                const markerX = depth * LIST_INDENT + MARKER_PAD
                child.forEach((item, itemOffset) =>
                {
                    const itemPos = pos + 1 + itemOffset
                    const text = ordered ? `${n}.` : '•'
                    this.collectBlocks(item, itemPos + 1, depth + 1, { text, x: markerX }, out)
                    n++
                })
                pending = null
            }
            else if (child.isTextblock)
            {
                out.push({ node: child, pos, indent: depth * LIST_INDENT, marker: pending, leaf: false })
                pending = null
            }
            else if (this.isLeafBlock(child))
            {
                out.push({ node: child, pos, indent: depth * LIST_INDENT, marker: pending, leaf: true })
                pending = null
            }
            else if (child.isBlock)
            {
                // A generic block container (e.g. nesting blockquote): descend.
                this.collectBlocks(child, pos + 1, depth, pending, out)
                pending = null
            }
        })
    }

    /** True when the document is a single empty text block. */
    private isDocEmpty(): boolean
    {
        const doc = this.state.doc
        return doc.childCount === 1
            && !!doc.firstChild?.isTextblock
            && doc.firstChild.content.size === 0
    }

    /** Underline / strikethrough lines for a run, in the current fill color. */
    private paintDecoration(
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

    private paintSelectionRects(
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
                    ctx.fillRect(0, block.yOffset, this.containerWidth, block.height)
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
                const x1 = this.xForOffsetInLine(block, line, a - block.pmStartPos)

                // Selection continuing past this line trails to the container
                // edge; otherwise stop at the selection end on this line.
                const x2 = to > lineEnd
                    ? line.x + this.containerWidth
                    : this.xForOffsetInLine(block, line, Math.min(to, lineEnd) - block.pmStartPos)

                if (x2 > x1)
                {
                    ctx.fillRect(x1, line.y, x2 - x1, block.lineHeight)
                }
            }
        }
    }

    // ─── Caret + Coordinate Mapping ────────────────────────────────────

    private posToCoords(layouts: BlockLayout[], pos: number): { x: number, y: number, height: number } | null
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
    ): { x: number, y: number, height: number }
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
                return { x: this.xForOffsetInLine(block, line, offsetInBlock), y: line.y, height: block.lineHeight }
            }
        }

        return { x: 0, y: block.yOffset, height: block.lineHeight }
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
        this.measureCtx.font = block.font
        return line.x + this.measureCtx.measureText(line.text.substring(0, offsetInLine)).width
    }

    private ensureCaretVisible(coords: { x: number, y: number, height: number }): void
    {
        if (!this.scroller) return
        const scrollTop = this.scroller.scrollTop
        const viewH = this.scroller.clientHeight
        const caretTop = coords.y
        const caretBottom = coords.y + coords.height
        if (caretTop < scrollTop)
        {
            this.scroller.scrollTop = caretTop
        }
        else if (caretBottom > scrollTop + viewH)
        {
            this.scroller.scrollTop = caretBottom - viewH
        }
    }

    private paintCaret(coords: { x: number, y: number, height: number } | null): void
    {
        if (!this.caretVisible) return
        const ctx = this.canvas.getContext('2d')!
        const sel = this.state.selection
        // Gap cursor: a horizontal bar across the seam between two blocks.
        if (sel instanceof GapCursor)
        {
            ctx.fillStyle = this.caretColor
            ctx.fillRect(0, this.gapCursorY(sel.$from.pos) - 1, this.containerWidth, 2)
            return
        }
        if (!coords || !sel.empty) return
        ctx.fillStyle = this.caretColor
        ctx.fillRect(coords.x, coords.y, this.caretWidth, coords.height)
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

        // Atom block (no text lines): place the caret just before it.
        if (block.lines.length === 0) return { pos: block.pmStartPos, bias: -1 }

        let lineIdx = 0
        for (let i = 0; i < block.lines.length; i++)
        {
            if (canvasY >= block.lines[i].y && canvasY < block.lines[i].y + block.lineHeight)
            {
                lineIdx = i
                break
            }
            if (i === block.lines.length - 1) lineIdx = i
        }
        const line = block.lines[lineIdx]
        if (line.text.length === 0) return { pos: block.pmStartPos, bias: -1 }

        const targetX = Math.max(0, canvasX - line.x)
        const offsetInBlock = Math.min(block.text.length, this.hitTestX(block, line, targetX))

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
    private hitTestX(block: BlockLayout, line: LineLayout, targetX: number): number
    {
        if (line.fragments)
        {
            const frags = line.fragments
            if (frags.length === 0) return line.pmStart
            if (targetX <= frags[0].x)
            {
                return frags[0].pmStart + hitTestInText(this.measureCtx, this.segmenter, frags[0].text, frags[0].font, targetX - frags[0].x)
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
                    return f.pmStart + hitTestInText(this.measureCtx, this.segmenter, f.text, f.font, targetX - f.x)
                }
            }
            const last = frags[frags.length - 1]
            return last.pmStart + last.text.length
        }

        return line.pmStart + hitTestInText(this.measureCtx, this.segmenter, line.text, block.font, targetX)
    }

    /**
     * Binary-search grapheme boundaries of `text` (rendered in `font`) for the
     * boundary nearest `targetX`, returning a UTF-16 offset into `text`. Never
     * splits a surrogate pair, ZWJ sequence, or combining mark.
     */
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
        this.syncNodeViews(layouts)

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

    // ─── Node views ────────────────────────────────────────────────────

    /**
     * Mount/position/destroy the DOM elements for atom blocks. Positioned in
     * document space inside the stack (so they scroll with content); their
     * measured height is fed back into layout via nodeViewHeights.
     */
    private syncNodeViews(layouts: BlockLayout[]): void
    {
        const present = new Set<PMNode>()
        for (const block of layouts)
        {
            // Atom blocks without a registered node view (e.g. canvas-drawn
            // horizontal rules) are painted directly, not mounted as DOM.
            if (!block.isAtom || !this.nodeViews[block.type]) continue
            present.add(block.node)

            let view = this.mountedViews.get(block.node)
            if (!view)
            {
                view = this.createNodeView(block.node, block.pmStartPos)
                this.mountedViews.set(block.node, view)
            }
            view.pos = block.pmStartPos
            // Floating nodes sit at their rect; in-flow ones span the content.
            const fr = block.floatRect
            view.container.style.left = `${fr ? fr.x : 0}px`
            view.container.style.top = `${fr ? fr.y : block.yOffset}px`
            view.container.style.width = `${fr ? fr.width : this.containerWidth}px`

            // Reserve the element's real height; re-layout once when it changes.
            const measured = view.container.offsetHeight
            if (measured > 0 && this.nodeViewHeights.get(block.node) !== measured)
            {
                this.nodeViewHeights.set(block.node, measured)
                this.scheduleRender()
            }
        }

        for (const [node, view] of this.mountedViews)
        {
            if (present.has(node)) continue
            view.resizeObserver?.disconnect()
            view.container.remove()
            this.mountedViews.delete(node)
            this.nodeViewHeights.delete(node)
        }
    }

    private createNodeView(node: PMNode, pos: number): MountedView
    {
        const container = document.createElement('div')
        container.style.position = 'absolute'
        container.style.zIndex = '1'
        const view: MountedView = { container, dom: container, pos, resizeObserver: null }
        view.dom = this.nodeViews[node.type.name](node, () => view.pos)
        container.appendChild(view.dom)
        this.stack.appendChild(container)

        // Avoid the screen reader reading this atom twice: the structural mirror
        // already represents it in document order. A non-interactive view (e.g.
        // an image) is hidden here so only the mirror is read; an interactive one
        // (buttons/links) stays exposed because the mirror can't operate it.
        const interactive = view.dom.matches?.(FOCUSABLE_SEL) || !!view.dom.querySelector?.(FOCUSABLE_SEL)
        if (this.a11yMirror && !interactive) container.setAttribute('aria-hidden', 'true')

        // Click on the block's chrome (not an interactive child that stops
        // propagation) selects the node.
        container.addEventListener('mousedown', (e) =>
        {
            e.preventDefault()
            this.dispatch(this.state.tr.setSelection(
                NodeSelection.create(this.state.doc, view.pos),
            ))
            this.textarea.focus()
        }, { signal: this.abortController?.signal })
        if (typeof ResizeObserver !== 'undefined')
        {
            view.resizeObserver = new ResizeObserver(() => this.scheduleRender())
            view.resizeObserver.observe(container)
        }
        return view
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
                    if (!ie.data) break
                    // Typing at a gap cursor starts a new paragraph in the seam.
                    if (this.state.selection instanceof GapCursor) this.insertAtGap(ie.data)
                    else this.dispatch(this.state.tr.insertText(ie.data))
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
                    if (!this.gapNav('horiz', -1, e.shiftKey)) this.moveSelection(-1, e.shiftKey)
                    break
                case 'ArrowRight':
                    e.preventDefault()
                    if (!this.gapNav('horiz', 1, e.shiftKey)) this.moveSelection(1, e.shiftKey)
                    break
                case 'ArrowUp':
                    e.preventDefault()
                    if (!this.gapNav('vert', -1, e.shiftKey)) this.moveVertical(-1, e.shiftKey)
                    break
                case 'ArrowDown':
                    e.preventDefault()
                    if (!this.gapNav('vert', 1, e.shiftKey)) this.moveVertical(1, e.shiftKey)
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
                    this.onEnter(e.shiftKey, e.metaKey || e.ctrlKey)
                    break
                case 'Tab':
                {
                    const itemType = this.listItemType()
                    if (itemType)
                    {
                        e.preventDefault()
                        this.command(e.shiftKey ? liftListItem(itemType) : sinkListItem(itemType))
                    }
                    break
                }
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

            // A click in a block seam (between stacked atoms) sets a gap cursor.
            const gapPos = this.gapPosForClick(y)
            if (gapPos !== null)
            {
                this.dispatch(this.state.tr.setSelection(
                    new GapCursor(this.state.doc.resolve(gapPos)),
                ))
                this.dragging = false
                this.textarea.focus()
                return
            }

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

        // Rich paste: parse text/html through the schema's parseDOM rules so
        // bold/italic/links/headings survive; fall back to plain text (split on
        // blank lines into paragraphs). preventDefault stops the textarea's own
        // insert + the follow-up 'insertFromPaste' input event.
        this.textarea.addEventListener('paste', (e) =>
        {
            const cd = e.clipboardData
            if (!cd) return
            const html = cd.getData('text/html')
            const text = cd.getData('text/plain')
            if (!html && !text) return
            e.preventDefault()
            if (html) this.pasteHTML(html)
            else this.pastePlainText(text)
        }, { signal })

        // Repaint the visible slice as the user scrolls (virtualized mode).
        this.scroller?.addEventListener('scroll', () =>
        {
            this.scheduleRender()
        }, { signal })

        this.textarea.focus()
    }

    /** The schema's list-item node type, if it defines one. */
    private listItemType()
    {
        return this.state.schema.nodes['list_item'] ?? this.state.schema.nodes['listItem'] ?? null
    }

    /** Is the cursor inside a list item (its textblock's parent is a list item)? */
    private inListItem(): boolean
    {
        const itemType = this.listItemType()
        if (!itemType) return false
        const $from = this.state.selection.$from
        for (let d = $from.depth; d > 0; d--)
        {
            if ($from.node(d).type === itemType) return true
        }
        return false
    }

    private deleteBackward(): void
    {
        const sel = this.state.selection
        if (sel instanceof GapCursor) { this.deleteAroundGap(-1); return }
        if (!sel.empty)
        {
            this.dispatch(this.state.tr.deleteSelection())
            return
        }
        // At the start of a list item, lift it out of the list rather than
        // joining backward into the previous item's text.
        const itemType = this.listItemType()
        if (itemType && sel.$from.parentOffset === 0 && this.inListItem())
        {
            if (liftListItem(itemType)(this.state, (tr) => this.dispatch(tr))) return
        }
        // PM's joinBackward handles "at start of textblock" for any schema
        // (paragraphs, list items, blockquotes, …). Returns false otherwise.
        if (joinBackward(this.state, (tr) => this.dispatch(tr))) return
        const $from = sel.$from
        if ($from.parent.isTextblock)
        {
            const text = $from.parent.textContent
            const prev = prevGraphemeBoundary(this.segmenter, text, $from.parentOffset)
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
        if (sel instanceof GapCursor) { this.deleteAroundGap(1); return }
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
            const next = nextGraphemeBoundary(this.segmenter, text, $to.parentOffset)
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

    /**
     * Enter dispatch. In a code block a newline is inserted; Mod-Enter — or a
     * second Enter on a blank trailing line — exits to a paragraph after it.
     * Shift-Enter is a hard break elsewhere; a plain Enter splits the block.
     */
    private onEnter(shift: boolean, mod: boolean): void
    {
        const sel = this.state.selection
        // At a gap cursor, Enter slots an empty paragraph into the seam.
        if (sel instanceof GapCursor) { this.insertAtGap(''); return }
        const $from = sel.$from
        if ($from.parent.type.spec.code)
        {
            const atEnd = sel.empty && $from.parentOffset === $from.parent.content.size
            if (mod || (!shift && atEnd && /\n$/.test($from.parent.textContent)))
            {
                this.exitCodeBlock()
                return
            }
            this.dispatch(this.state.tr.insertText('\n'))
            return
        }
        // Shift-Enter is a hard line break within the block; 'pre-wrap' (and the
        // marked-segment layout) honor the newline character.
        if (shift) { this.dispatch(this.state.tr.insertText('\n')); return }
        // Inside a list, Enter splits the item (and lifts out an empty one).
        const itemType = this.listItemType()
        if (itemType && this.inListItem())
        {
            if (splitListItem(itemType)(this.state, (tr) => this.dispatch(tr))) return
        }
        this.splitBlock()
    }

    /** Leave a code block, dropping the blank trailing line if Enter triggered it. */
    private exitCodeBlock(): void
    {
        const sel = this.state.selection
        const $from = sel.$from
        const para = this.state.schema.nodes['paragraph']
        if (!para) { this.dispatch(this.state.tr.insertText('\n')); return }
        let tr = this.state.tr
        if (sel.empty && $from.parentOffset === $from.parent.content.size && /\n$/.test($from.parent.textContent))
        {
            tr = tr.delete(sel.from - 1, sel.from)
        }
        const after = tr.selection.$from.after()
        tr = tr.insert(after, para.createAndFill()!)
        tr = tr.setSelection(TextSelection.near(tr.doc.resolve(after + 1)))
        this.dispatch(tr.scrollIntoView())
    }

    private splitBlock(): void
    {
        const sel = this.state.selection
        let tr = this.state.tr
        if (!sel.empty) tr = tr.deleteSelection()
        const $from = tr.selection.$from
        if (!$from.parent.isTextblock) return
        const para = this.state.schema.nodes['paragraph']
        const atEnd = $from.parentOffset === $from.parent.content.size
        // A non-paragraph block (heading, blockquote) split at its end continues
        // as a paragraph; split mid-block keeps the same type.
        if (atEnd && para && $from.parent.type !== para)
        {
            tr = tr.split($from.pos, 1, [{ type: para }])
        }
        else
        {
            tr = tr.split($from.pos)
        }
        this.dispatch(tr.scrollIntoView())
    }

    /** Parse an HTML clipboard payload via the schema and replace the selection. */
    private pasteHTML(html: string): void
    {
        try
        {
            const dom = new DOMParser().parseFromString(html, 'text/html')
            const slice = PMDOMParser.fromSchema(this.state.schema)
                .parseSlice(dom.body, { preserveWhitespace: false })
            this.dispatch(this.state.tr.replaceSelection(slice))
        }
        catch
        {
            // Malformed HTML / unmapped nodes: fall back to the plain text.
            this.pastePlainText(new DOMParser().parseFromString(html, 'text/html').body.textContent ?? '')
        }
    }

    /**
     * Insert plain text: blank lines split paragraphs, single newlines become
     * hard breaks (kept as '\n' in the text). A single block is inserted inline
     * at the caret; multiple blocks replace the selection as block content.
     */
    private pastePlainText(text: string): void
    {
        if (!text) return
        const blocks = text.replace(/\r\n?/g, '\n').split(/\n{2,}/)
        if (blocks.length <= 1)
        {
            this.dispatch(this.state.tr.insertText(text.replace(/\r\n?/g, '\n')))
            return
        }
        const para = this.state.schema.nodes['paragraph']
        if (!para)
        {
            this.dispatch(this.state.tr.insertText(text.replace(/\r\n?/g, '\n')))
            return
        }
        const nodes = blocks.map((b) => para.create(null, b ? this.state.schema.text(b) : null))
        // openStart/End 1 lets the first/last paragraph merge into the block at
        // the caret, so pasting mid-paragraph doesn't orphan a new empty block.
        const slice = new Slice(Fragment.fromArray(nodes), 1, 1)
        this.dispatch(this.state.tr.replaceSelection(slice))
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
            const next = nextGraphemeBoundary(this.segmenter, text, offset)
            if (next > offset) return pos + (next - offset)
            return pos + 1
        }
        const prev = prevGraphemeBoundary(this.segmenter, text, offset)
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
        if (targetBlock.lines.length === 0)
        {
            // Atom block — select the node rather than placing a text caret.
            this.dispatch(this.state.tr.setSelection(
                NodeSelection.create(this.state.doc, targetBlock.pmStartPos),
            ))
            this.phantomX = targetX
            return
        }
        const targetLine = targetBlock.lines[targetLineIdx]

        // Re-use clickToPos against the target line's midline — it already
        // handles empty lines, binary search, and nearest-char snap, and hands
        // back the bias that keeps the caret on the target line even when the
        // landing offset sits on a soft-wrap boundary.
        const hit = this.clickToPos(
            this.lastLayouts,
            targetX,
            targetLine.y + targetBlock.lineHeight / 2,
        )
        if (hit !== null) this.setHead(hit.pos, extend)

        // Pin phantom X and bias after dispatch (which clears them).
        this.phantomX = targetX
        if (hit !== null) this.caretBias = hit.bias
    }

    // ─── Gap cursor ────────────────────────────────────────────────────

    /** True when the caret is on the visual edge line/column of its block, so
     *  an arrow there should step out into a gap rather than within the block. */
    private atTextblockEdge(axis: 'horiz' | 'vert', dir: 1 | -1): boolean
    {
        const sel = this.state.selection
        if (axis === 'horiz')
        {
            const $h = sel.$head
            return dir > 0 ? $h.parentOffset === $h.parent.content.size : $h.parentOffset === 0
        }
        const head = sel.head
        const coords = this.posToCoords(this.lastLayouts, head)
        if (!coords) return false
        const block = this.lastLayouts.find((b) => head >= b.pmStartPos && head <= b.pmEndPos)
        if (!block || block.lines.length === 0) return false
        const edge = dir > 0 ? block.lines[block.lines.length - 1] : block.lines[0]
        return coords.y === edge.y
    }

    /**
     * Try to move the selection into — or along — a gap cursor (the caret that
     * sits in seams between block nodes where no text cursor fits, e.g. between
     * two stacked images). Returns whether it handled the arrow; otherwise the
     * caller performs its normal text/vertical motion.
     */
    private gapNav(axis: 'horiz' | 'vert', dir: 1 | -1, extend: boolean): boolean
    {
        if (extend) return false
        const sel = this.state.selection

        // Already in a gap: step to the next gap, the adjacent atom, or the
        // nearest text position.
        if (sel instanceof GapCursor)
        {
            const $from = dir > 0 ? sel.$to : sel.$from
            const $g = GapCursorStatic.findFrom($from, dir, true)
            if ($g) { this.dispatch(this.state.tr.setSelection(new GapCursor($g))); return true }
            const node = dir > 0 ? $from.nodeAfter : $from.nodeBefore
            if (node && NodeSelection.isSelectable(node))
            {
                const at = dir > 0 ? $from.pos : $from.pos - node.nodeSize
                this.dispatch(this.state.tr.setSelection(NodeSelection.create(this.state.doc, at)))
                return true
            }
            const next = Selection.findFrom($from, dir, true)
            if (next) this.dispatch(this.state.tr.setSelection(next))
            return true
        }

        let $start: ResolvedPos
        let mustMove = sel.empty
        if (sel instanceof TextSelection && sel.empty)
        {
            if (sel.$head.depth === 0 || !this.atTextblockEdge(axis, dir)) return false
            $start = this.state.doc.resolve(dir > 0 ? sel.$head.after() : sel.$head.before())
            mustMove = false
        }
        else if (sel instanceof NodeSelection)
        {
            $start = dir > 0 ? sel.$to : sel.$from
        }
        else
        {
            return false
        }
        const $found = GapCursorStatic.findFrom($start, dir, mustMove)
        if (!$found) return false
        this.dispatch(this.state.tr.setSelection(new GapCursor($found)))
        return true
    }

    /** If a click at document-space `y` falls in a seam where a gap cursor is
     *  valid (e.g. between two stacked images), the gap position; else null. */
    private gapPosForClick(y: number): number | null
    {
        for (let i = 0; i < this.lastLayouts.length; i++)
        {
            const b = this.lastLayouts[i]
            const next = this.lastLayouts[i + 1]
            if (i === 0 && y < b.yOffset)
            {
                return GapCursorStatic.valid(this.state.doc.resolve(b.pmStartPos)) ? b.pmStartPos : null
            }
            if (y > b.yOffset + b.height && (!next || y < next.yOffset))
            {
                return GapCursorStatic.valid(this.state.doc.resolve(b.pmEndPos)) ? b.pmEndPos : null
            }
        }
        return null
    }

    /** Document-space Y where a gap cursor at `pos` is painted (in a block seam). */
    private gapCursorY(pos: number): number
    {
        let y = 1
        for (const b of this.lastLayouts)
        {
            if (pos <= b.pmStartPos) return Math.max(1, b.yOffset - this.blockGap / 2)
            if (pos >= b.pmEndPos) y = b.yOffset + b.height + this.blockGap / 2
        }
        return y
    }

    /** Insert a paragraph (optionally seeded with text) where the gap cursor is. */
    private insertAtGap(text: string): void
    {
        const sel = this.state.selection
        if (!(sel instanceof GapCursor)) return
        const para = this.state.schema.nodes['paragraph']
        if (!para) return
        const pos = sel.$from.pos
        const node = text ? para.create(null, this.state.schema.text(text)) : para.createAndFill()
        if (!node) return
        const tr = this.state.tr.insert(pos, node)
        tr.setSelection(TextSelection.near(tr.doc.resolve(pos + 1 + text.length)))
        this.dispatch(tr.scrollIntoView())
    }

    /** Delete the node on one side of the gap cursor (Backspace / Delete). */
    private deleteAroundGap(dir: -1 | 1): void
    {
        const $pos = this.state.selection.$from
        const node = dir < 0 ? $pos.nodeBefore : $pos.nodeAfter
        if (!node) return
        const from = dir < 0 ? $pos.pos - node.nodeSize : $pos.pos
        this.dispatch(this.state.tr.delete(from, from + node.nodeSize).scrollIntoView())
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
        // Honor prefers-reduced-motion: keep the caret solid (no blink).
        if (this.reducedMotion) { this.caretVisible = true; return }
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
