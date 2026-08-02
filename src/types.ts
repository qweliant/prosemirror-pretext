/**
 * Every type the editor traffics in — the public surface consumers configure
 * against, and the internal shapes layout and paint pass between themselves.
 *
 * These live apart from `editor.ts` because they are the contract, not the
 * machinery: the layout cache's shapes (`CachedBlock`, `CachedLine`) and the
 * positioned output (`BlockLayout`) are what any new layout mode has to speak,
 * so they should be readable without scrolling past four thousand lines of
 * implementation.
 *
 * `EditorHandlers` refers back to `CanvasEditor`, so the import below is
 * circular. It is `import type`, which TypeScript erases entirely — there is no
 * runtime cycle and no load-order hazard.
 */

import type { Mark, Node as PMNode } from 'prosemirror-model'
import type { EditorState, Command } from 'prosemirror-state'
import type { PreparedTextWithSegments } from '@chenglou/pretext'
import type { RichInlineItem } from '@chenglou/pretext/rich-inline'
import type { Decoration } from './decoration'
import type { CanvasEditor } from './editor'


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
    /** Color of the drop indicator drawn while dragging. Default: `caretColor`. */
    dropIndicatorColor?: string
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
    /** Start in editable (default) or read-only mode. Read-only still allows
     *  navigation, selection, and copy — it just drops document changes. */
    editable?: boolean
    /** Focus the editor on construction. Default true; set false for embeds so
     *  mounting one doesn't steal focus or scroll the page to it. */
    autofocus?: boolean
    /**
     * Transient, non-document styling layered over the text: search highlights,
     * spellcheck squiggles, collab cursors, inline widgets, per-node backgrounds.
     * Recomputed every render — derive it from your state/plugins. See `Decoration`.
     */
    decorations?: (state: EditorState) => Decoration[]
    /**
     * Overridable event handlers (à la prosemirror-view's `handle*` props). Each
     * receives the editor and the event; return `true` to mark it handled and
     * suppress the built-in behavior. The editor is passed in place of PM's view.
     */
    handlers?: EditorHandlers
    /**
     * Drag & drop: drag a leaf/atom block to a new place in the document, and
     * accept drops from outside (files, text, HTML). Default true. A node view
     * that runs its own pointer gesture opts out per-node by calling
     * `preventDefault()` on `pointerdown`; pass false to turn it off entirely.
     */
    dragDrop?: boolean
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

/**
 * Overridable event handlers. Each returns `true` to suppress the built-in
 * behavior (mirrors prosemirror-view's `handle*` props, with the editor in place
 * of the view). `handleDOMEvents` maps DOM event names to handlers bound on the
 * editor's container.
 */
export interface EditorHandlers
{
    keyDown?: (editor: CanvasEditor, event: KeyboardEvent) => boolean
    click?: (editor: CanvasEditor, pos: number, event: MouseEvent) => boolean
    doubleClick?: (editor: CanvasEditor, pos: number, event: MouseEvent) => boolean
    paste?: (editor: CanvasEditor, event: ClipboardEvent) => boolean
    /**
     * A drag of the block node at `pos` is about to begin (pointer events, so
     * mouse/touch/pen alike). Return `true` to veto the drag — e.g. to pin a
     * node, or to run your own gesture.
     */
    dragStart?: (editor: CanvasEditor, pos: number, event: PointerEvent) => boolean
    /**
     * Something was dropped onto the editor from outside (OS files, another
     * tab). `pos` is the document position under the pointer. Return `true` to
     * take the drop over completely — including file drops, which otherwise
     * fall through to `dropFiles`.
     */
    drop?: (editor: CanvasEditor, pos: number, event: DragEvent) => boolean
    /**
     * Files were dropped at `pos`. There is no default: turning a file into a
     * node means uploading it, which is the app's story, not the editor's.
     */
    dropFiles?: (editor: CanvasEditor, pos: number, files: File[], event: DragEvent) => boolean
    domEvents?: Record<string, (editor: CanvasEditor, event: Event) => boolean>
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

export interface BlockLayout {
  type: string;
  node: PMNode;
  text: string;
  yOffset: number;
  height: number;
  lines: LineLayout[];
  pmStartPos: number;
  pmEndPos: number;
  /** A leaf/atom block rendered by a node view (no text lines). */
  isAtom?: boolean;
  /** Set when the block is a floating node: its content-space rect (text wraps
   *  around it; the node view is positioned here rather than full-width). */
  floatRect?: { x: number; y: number; width: number; height: number };
  /** Resolved block base style (per-block headings etc.; editor base by default). */
  lineHeight: number;
  font: string;
  fontSize: number;
  color: string | null;
  /** Box decorations (0/null for plain paragraphs). */
  paddingTop: number;
  paddingBottom: number;
  background: string | null;
  borderLeft: { width: number; color: string } | null;
  /** List marker (bullet/number) drawn in the gutter of the first line. */
  marker: { text: string; x: number } | null;
  /** List indent (px) this layout was assembled at — used to validate reuse. */
  indent?: number;
}


// ─── Internal Types ────────────────────────────────────────────────────────

/** Resolved block base style, ready for layout/paint. */
export interface ResolvedBlockStyle
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

/** A document block flattened from the tree: its node, absolute position, list
 *  indent (px), and optional list marker. */
export interface BlockDesc
{
    node: PMNode
    pos: number
    indent: number
    marker: { text: string, x: number } | null
    leaf: boolean
}

export interface CachedFragment
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

export interface CachedLine
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

export interface CachedBlock
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
export interface MountedView
{
    container: HTMLDivElement
    dom: HTMLElement
    pos: number
    resizeObserver: ResizeObserver | null
}

/** Per-item run metadata threaded through marked line building. */
export interface MarkedLineCtx
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
export interface MarkedSegment
{
    items: RichInlineItem[]
    meta: MarkedLineCtx['meta']
    /** Block-space PM offset where this segment begins (after the preceding '\n'). */
    startOffset: number
}
