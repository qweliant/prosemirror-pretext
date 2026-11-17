import {
    type Mark, type Node as PMNode, type NodeType, type ResolvedPos,
    DOMParser as PMDOMParser, DOMSerializer, Slice, Fragment,
} from 'prosemirror-model'
import {
    EditorState, TextSelection, NodeSelection, Selection,
    type Command, type Transaction,
} from 'prosemirror-state'
import { GapCursor } from 'prosemirror-gapcursor'
import {
    clamp, expandCollapsedWhitespace, hitTestInText,
    nextGraphemeBoundary, prevGraphemeBoundary, ATOM_CHAR, inlineText,
} from './text'
import type {
    Decoration, InlineDecoration, NodeDecoration, WidgetDecoration,
} from './decoration'

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
import type {
    CanvasEditorOptions, NodeViewFn, EditorHandlers, FloatRect,
    MarkStyle, MarkStyleResolver, BlockStyle, BlockStyleResolver,
    RenderStats, LineFragment, LineLayout, BlockLayout,
    ResolvedBlockStyle, BlockDesc, CachedFragment, CachedLine, CachedBlock,
    MountedView, MarkedLineCtx, MarkedSegment, LayoutFrame, TableChrome,
    CanvasGeometry, InlineNodeSpec, InlineAtomBox,
    ContainerNodeSpec, ContainerChrome, Insets, PerNode,
} from './types'
import {
    HEADING_SCALE, DEFAULT_MARK_STYLES, LIST_INDENT, MARKER_PAD,
    FOCUSABLE_SEL, SR_ONLY, DRAG_THRESHOLD_PX, TEXT_BLEED,
    AUTOSCROLL_ZONE_PX, AUTOSCROLL_SPEED_PX,
    MULTI_TAP_MS, MULTI_TAP_SLOP_PX,
    LOUPE_WIDTH, LOUPE_HEIGHT, LOUPE_ZOOM, LOUPE_LIFT, LOUPE_DROP,
} from './constants'
import {
    isRuleNode, isListNode, isOrderedList, isLeafBlock, collectBlocks, isDocEmpty,
    isTableNode,
} from './layout/blocks'
import { layoutTable, type TableLayoutContext } from './layout/table'
import { CellSelection } from './table-selection'
import { applyVirtualLayout, paintToCanvas, atomPillRect, type PaintContext } from './paint'
import {
  BoxTransitions, planComposite, DEFAULT_TRANSITION_MS,
  type Presentation, type Snapshot,
} from './box-transition'
import {
    blockHasMarks, resolveRunStyle, resolveBlockStyle, boxFields, blockBase,
    blockContentWidth, type StyleContext,
} from './layout/style'

// The public types live in ./types but are re-exported here so `src/index.ts`
// and existing `from './editor'` imports keep resolving unchanged.
export type {
    CanvasEditorOptions, NodeViewFn, EditorHandlers, FloatRect,
    MarkStyle, MarkStyleResolver, BlockStyle, BlockStyleResolver,
    RenderStats, LineFragment, LineLayout, BlockLayout,
    LayoutFrame, TableChrome, TableCellBox, CanvasGeometry,
    InlineNodeSpec, InlineAtomBox, ContainerNodeSpec, ContainerChrome, Insets, PerNode,
} from './types'

/**
 * Width a classic scrollbar takes out of a scroll container's content box.
 * Zero for overlay scrollbars. Measured once with a throwaway probe — reading
 * it off the live scroller would need content that already overflows, which is
 * not true when the editor mounts.
 */
let cachedScrollbarWidth: number | null = null
function scrollbarWidth(): number
{
    if (cachedScrollbarWidth !== null) return cachedScrollbarWidth
    const probe = document.createElement('div')
    probe.style.cssText =
        'position:absolute;top:-9999px;width:100px;height:100px;overflow:scroll'
    document.body.appendChild(probe)
    cachedScrollbarWidth = probe.offsetWidth - probe.clientWidth
    probe.remove()
    return cachedScrollbarWidth
}

/**
 * The span one dispatch changed, as findDiffStart/findDiffEnd report it:
 * `[from, toPrev)` in the previous document became `[from, toCur)` in the
 * current one, and every position after it moved by `delta`.
 */
interface DocEdit
{
    from: number
    toPrev: number
    toCur: number
    delta: number
}

/** First index in a list where `pred` turns true (it must be monotonic). */
function lowerBound<T>(list: T[], pred: (item: T) => boolean): number
{
    let lo = 0
    let hi = list.length
    while (lo < hi)
    {
        const mid = (lo + hi) >> 1
        if (pred(list[mid])) hi = mid
        else lo = mid + 1
    }
    return lo
}

/**
 * Insert `items` into a chrome list (kept in document order) where the
 * entries positioned after `pos` begin.
 */
function insertAt<T extends { pos: number }>(list: T[], pos: number, items: T[]): void
{
    list.splice(lowerBound(list, (c) => c.pos > pos), 0, ...items)
}

/** Whether block layouts are non-decreasing in `yOffset`. See
 *  `CanvasEditor.layoutsSortedByY`. */
function isSortedByY(layouts: BlockLayout[]): boolean
{
    for (let i = 1; i < layouts.length; i++)
    {
        if (layouts[i].yOffset < layouts[i - 1].yOffset) return false
    }
    return true
}

/** Horizontal offset to add to a line's left edge for the block's alignment. */
function alignOffset(availWidth: number, lineWidth: number, align: 'left' | 'center' | 'right'): number
{
    if (align === 'center') return Math.max(0, (availWidth - lineWidth) / 2)
    if (align === 'right') return Math.max(0, availWidth - lineWidth)
    return 0
}

/** A spec value that may be fixed or computed from the node. */
function perNode<T>(v: PerNode<T> | undefined, node: PMNode, fallback: T): T
{
    if (v === undefined) return fallback
    return typeof v === 'function' ? (v as (n: PMNode) => T)(node) : v
}

/** A padding value as four sides: a number applies to all of them. */
function resolveInsets(p: number | Partial<Insets>): Insets
{
    if (typeof p === 'number') return { top: p, right: p, bottom: p, left: p }
    return { top: p.top ?? 0, right: p.right ?? 0, bottom: p.bottom ?? 0, left: p.left ?? 0 }
}

/** Whether two block markers (list bullets) are visually identical — used to
 *  decide if a cached, positioned block layout can be reused as-is. */
function sameMarker(a: { text: string, x: number } | null, b: { text: string, x: number } | null): boolean
{
    if (a === b) return true
    return !!a && !!b && a.text === b.text && a.x === b.x
}

// ─── Editor ────────────────────────────────────────────────────────────────

export class CanvasEditor {
  // ─── Config ────────────────────────────────────────────────────────
  private readonly font: string;
  private readonly lineHeight: number;
  // Not readonly: `setWidth` re-lays the document into a new column.
  private containerWidth: number;
  private readonly blockGap: number;
  private readonly textColor: string;
  private readonly firstLineColor: string;
  private readonly caretColor: string;
  private readonly selectionColor: string;
  private readonly placeholder: string;
  private readonly placeholderColor: string;
  private readonly ruleColor: string;
  private readonly tableBorderColor: string;
  private readonly tableHeaderBackground: string;
  private readonly dropIndicatorColor: string;
  private readonly maxHeight: number | null;
  private readonly caretWidth = 2;
  private readonly caretBlinkMs = 530;
  private readonly caretHoldMs = 500;
  private readonly onRender?: (stats: RenderStats) => void;

  // ─── Marks & blocks ────────────────────────────────────────────────
  private readonly markStyles: Record<string, MarkStyleResolver>;
  private readonly blockStyles: Record<string, BlockStyleResolver>;
  // Compiled key bindings (prosemirror-keymap); consulted before built-ins.
  private readonly keymapHandler: (event: KeyboardEvent) => boolean;
  // Base font split into size + family so marked runs can compose new font
  // strings (weight/style/family) on top of the editor's base size.
  private readonly baseFontSize: number;
  private readonly baseFontFamily: string;

  // ─── Floats ────────────────────────────────────────────────────────
  // Exclusion rects the text flows around. Empty by default — the cached,
  // fixed-width layout path is used whenever there are no floats.
  private floats: FloatRect[];
  // The full exclusion set used for a given layout pass: consumer `floats`
  // plus rects derived from floating nodes (see floatRect). Read by slotForBand.
  private activeFloats: FloatRect[] = [];
  // Derives a float rect for a node (text wraps around it), or null for in-flow.
  private readonly floatRectFor:
    | ((node: PMNode) => { x: number; y: number; width: number } | null)
    | null;
  // Breathing room kept around each float so text never kisses its edge.
  private readonly floatGutter: number;

  // ─── Links ─────────────────────────────────────────────────────────
  private readonly linkMark: string;
  private readonly onFollowLink: (href: string, event: MouseEvent) => void;

  // ─── Node views (atom blocks) ──────────────────────────────────────
  private readonly nodeViews: Record<string, NodeViewFn>;
  // The one thing ./layout/blocks needs from the editor: which node types
  // render as a view. Bound once so the walk isn't rebuilding a closure per
  // block — collectBlocks recurses over the whole document.
  private readonly hasNodeView = (typeName: string): boolean =>
    !!this.nodeViews[typeName];
  // Mounted views keyed by node identity (stable across unrelated edits).
  private readonly mountedViews = new Map<PMNode, MountedView>();
  // Measured heights so layout can reserve space for each atom block.
  private readonly nodeViewHeights = new Map<PMNode, number>();
  private readonly defaultAtomHeight = 40;
  // ─── Inline atoms (mentions, chips) ────────────────────────────────
  private readonly inlineNodes: Record<string, InlineNodeSpec>;
  // DOM-rendered inline atoms. A list per node because one node object can
  // legitimately sit in the document twice (a pasted copy shares it); each
  // render pass hands the list's entries out in document order.
  private readonly inlineViews = new Map<PMNode, MountedView[]>();
  // Measured widths of DOM-rendered atoms whose spec gives no `width`.
  private readonly inlineWidths = new Map<PMNode, number>();
  // ─── Container nodes (callouts, <details>) ─────────────────────────
  private readonly containerNodes: Record<string, ContainerNodeSpec>;
  private readonly isContainer = (typeName: string): boolean =>
    !!this.containerNodes[typeName];
  private lastContainers: ContainerChrome[] = [];
  // Header DOM, matched to containers by type and document order. Editing a
  // container's *children* replaces the node object on every keystroke, so
  // identity can't be the key; the header is rebuilt only when the node's own
  // markup (attrs) changes, which is all a header should depend on.
  private headerViews: { node: PMNode; view: MountedView }[] = [];
  // Collapse / expand animation (see ./box-transition). The clock is a field
  // so tests can drive it.
  private clock = (): number => performance.now();
  private readonly transitions = new BoxTransitions(() => this.clock());
  // Where the last frame was painted, for snapshotting it.
  private paintedTop = 0;
  // Scratch canvases for compositing: a copy of the live frame, and the strip
  // below the viewport an expanding box pulls up into view.
  private liveCanvas: HTMLCanvasElement | null = null;
  private stripCanvas: HTMLCanvasElement | null = null;
  // Whether overlays currently carry a transition's displacement.
  private overlaysDisplaced = false;
  // Transient decorations: a resolver + the live widget DOM (keyed for reuse).
  private readonly decorationsFor:
    | ((state: EditorState) => Decoration[])
    | null;
  private readonly mountedWidgets = new Map<string, HTMLElement>();
  private readonly handlers: EditorHandlers;
  // Below this, a slot is too narrow to set text; the line flows past it.
  private readonly minSlotWidth = 24;

  // ─── State ─────────────────────────────────────────────────────────
  // Read-only to consumers: everything downstream of a state change — layout
  // caches, the caret, the accessibility mirror, the next paint — is arranged
  // by `dispatch`, so a plain assignment would leave the editor showing a
  // document it no longer has.
  private _state: EditorState;

  // ─── DOM ───────────────────────────────────────────────────────────
  private readonly container: HTMLElement;
  private readonly scroller: HTMLDivElement | null;
  private readonly stack: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly textarea: HTMLTextAreaElement;
  private readonly measureCtx: CanvasRenderingContext2D;
  // Accessibility: a screen-reader-visible structural mirror, a polite live
  // region for announcements, and whether motion is reduced (caret blink).
  private readonly a11yMirror: HTMLElement | null;
  private readonly liveRegion: HTMLElement;
  private readonly reducedMotion: boolean;
  private readonly serializer: DOMSerializer;
  private lastAnnouncedContext = "";
  private lastMirrorDoc: PMNode | null = null;

  // ─── Layout ────────────────────────────────────────────────────────
  // Not readonly: replaced wholesale to invalidate when web fonts load
  // (WeakMap has no clear()). Marked-block geometry is measured at layout
  // time, so it must be recomputed once the real font is available.
  private layoutCache = new WeakMap<PMNode, CachedBlock>();
  // Memoized full-run widths (key: "<font> <text>") so re-laying out a
  // marked block on each keystroke only measures the run that changed.
  private readonly widthCache = new Map<string, number>();
  private lastLayouts: BlockLayout[] = [];
  private cacheHits = 0;
  private cacheMisses = 0;
  // Assembled, positioned BlockLayouts, reused across renders when a block's
  // visual position (yOffset) and indent are unchanged — only the PM positions,
  // which shift with edits above, are refreshed. Turns per-keystroke assembly
  // from O(blocks) allocation into ~O(blocks that moved) for the common case
  // (plain typing that doesn't reflow line breaks).
  private positionedCache = new WeakMap<PMNode, BlockLayout>();
  // The canvas's viewport position *and the scale it is being displayed at*.
  // Cached so `coordsAtPos` is a pure lookup — reading
  // `getBoundingClientRect()` on every caret query would force a synchronous
  // layout (the very read-after-write tax canvas is meant to avoid).
  // Invalidated on scroll/resize, the only things that move the canvas's
  // top-left; growing its height does not. A host that puts the editor under a
  // CSS transform must call `invalidateGeometry()` when that transform changes,
  // since nothing about it is observable from in here.
  private canvasRectCache: CanvasGeometry | null = null;
  // Cached scroller offset, refreshed each frame and on scroll. Reading
  // `scroller.scrollTop` directly on the coordsAtPos hot path would force a
  // synchronous layout (of the a11y mirror) when the document is dirty.
  private lastScrollTop = 0;
  // Layout is recomputed lazily: a dispatch marks it dirty, and the next
  // `coordsAtPos` or frame render rebuilds it (paint stays on the frame). So a
  // caret read right after a keystroke is both fresh and paint-free.
  private layoutDirty = true;
  private lastTotalHeight = 0;
  private lastTables: TableChrome[] = [];
  /**
   * Whether `lastLayouts` is non-decreasing in `yOffset`, which lets painting
   * binary-search the visible window instead of walking the whole document.
   *
   * Position order usually implies vertical order, but not always: a float sits
   * at an arbitrary `y`, and two cells in one table row share a band, so a
   * multi-block cell yields y values like 7, 53, 7. Painting only the
   * binary-searched slice in that case would silently drop blocks, so the flag
   * is set per pass and the walk falls back when it is false.
   */
  private layoutsSortedByY = true;
  // The document `lastLayouts` was built from, so the incremental layout path
  // can diff against it to find the single block that changed.
  private prevDoc: PMNode | null = null;
  // Whether the previous layout pass was float-affected. Floats change line
  // widths document-wide, so when this regime flips, cached/positional layouts
  // from the other regime must not be reused.
  private hadFloats = false;

  // ─── Render ────────────────────────────────────────────────────────
  private pendingRender = false;
  // Set when the caret moves (dispatch) so the next render scrolls it into
  // view. Renders from plain scrolling or caret blink leave it false, so the
  // user can freely scroll away from the caret without the view snapping back.
  private scrollCaretIntoView = false;

  // ─── Caret ─────────────────────────────────────────────────────────
  private caretVisible = true;
  private lastInputTime = 0;
  private blinkInterval: ReturnType<typeof setInterval> | null = null;

  // ─── Input ─────────────────────────────────────────────────────────
  private composing = false;
  // The IME's in-flight string. Deliberately not in the document: an IME
  // revises it on every keystroke, and a document that churned once per
  // revision would fill the undo stack with text the user never committed and
  // broadcast every intermediate guess to collaborators. It is painted
  // instead, and only the committed result becomes a transaction.
  private composingText = "";
  private abortController: AbortController | null = null;
  private dragging = false;
  // Touch state: distinguish a tap (caret), a long-press (word select), and a
  // swipe (native scroll). Selection handles are shown after a touch selection.
  private touchStartX = 0;
  private touchStartY = 0;
  private touchMoved = false;
  private longPressTimer: ReturnType<typeof setTimeout> | null = null;
  private touchMode: "idle" | "scroll" | "select" | "atomDrag" = "idle";
  // A long-press on an inline atom picked it up; this is where it came from.
  private touchAtomFrom: number | null = null;
  private touchSelection = false;
  private selHandles: { from: HTMLElement; to: HTMLElement } | null = null;
  private draggingHandle: "from" | "to" | null = null;
  // Multi-tap: consecutive quick taps in the same spot escalate caret → word →
  // block, the touch counterpart of double- and triple-click.
  private tapCount = 0;
  private lastTapTime = 0;
  private lastTapX = 0;
  private lastTapY = 0;
  // The magnifier overlay, built on first use.
  private loupe: { el: HTMLElement; canvas: HTMLCanvasElement } | null = null;
  // ─── Drag & drop ───────────────────────────────────────────────────
  private readonly dragDrop: boolean;
  // An in-flight node drag. It stays inert until the pointer passes the
  // threshold, so a press that never moves is still just a click/selection.
  private nodeDrag: {
    pointerId: number;
    from: number;
    startX: number;
    startY: number;
    active: boolean;
  } | null = null;
  // What the next paint marks as the drop target: the seam between two blocks
  // (a node move) or a text position (an external drop). Null when idle.
  private dropTarget: { pos: number; seam: boolean } | null = null;
  // A native drag that started from this editor's own text selection. Set at
  // dragstart, read at drop (to move rather than paste) and at dragend (to
  // remove the source when another application took it as a move).
  private textDrag: { from: number; to: number } | null = null;
  // Whether the current native drag ended inside this editor, which is what
  // decides between "we already moved it" and "someone else took it".
  private textDragHandled = false;
  // Set on a press that lands inside the selection: the browser may be about to
  // start a native drag, so the caret is not moved until the press proves to be
  // an ordinary click.
  private pressInSelection: number | null = null;
  // The press was on an inline atom it just selected; a click keeps it so.
  private pressKeepsSelection = false;
  // Edge auto-scroll while dragging. `dy` is px per frame, signed.
  private autoScrollRaf = 0;
  private autoScrollDy = 0;
  private lastDragClientX = 0;
  private lastDragClientY = 0;
  // Read-only mode drops document-changing transactions (see dispatch).
  private isEditable = true;
  private readonly autofocus: boolean = true;

  // ─── Vertical Navigation ───────────────────────────────────────────
  // Target X pinned across consecutive vertical moves so the caret
  // drifts back to its original column when passing through short lines.
  // Reset by any horizontal motion (see dispatch).
  private phantomX: number | null = null;

  // ─── Caret Bias (soft-wrap affinity) ───────────────────────────────
  // A PM position at a soft-wrap boundary is ambiguous: it is both the end
  // of the upper line and the start of the lower line. caretBias picks which
  // one the caret renders on. -1 = end of upper line (the default, matching
  // a click/step that arrives from the left); +1 = start of lower line.
  // Reset to -1 on every dispatch; re-pinned by click / vertical motion so
  // the caret lands on the line the user actually moved to.
  private caretBias: -1 | 1 = -1;

  // ─── Grapheme Awareness ────────────────────────────────────────────
  // PM positions are UTF-16 code units; perceived characters can span
  // multiple. We use Intl.Segmenter to step/delete by grapheme so emoji,
  // flags, and combining marks behave atomically.
  private readonly segmenter = new Intl.Segmenter(undefined, {
    granularity: "grapheme",
  });
  // Word boundaries for double-click selection.
  private readonly wordSegmenter = new Intl.Segmenter(undefined, {
    granularity: "word",
  });

  constructor(options: CanvasEditorOptions) {
    this._state = options.state;
    this.container = options.container;
    this.font = options.font ?? "16px Inter";
    this.lineHeight = options.lineHeight ?? 26;
    this.containerWidth = options.width ?? 460;
    this.blockGap = options.blockGap ?? 20;
    this.textColor = options.textColor ?? "#d4d4d8";
    this.firstLineColor = options.firstLineColor ?? "#818cf8";
    this.caretColor = options.caretColor ?? "#a5b4fc";
    this.selectionColor = options.selectionColor ?? "rgba(129, 140, 248, 0.25)";
    this.placeholder = options.placeholder ?? "";
    this.placeholderColor = options.placeholderColor ?? "#5a5a64";
    this.ruleColor = options.ruleColor ?? "#3a3a42";
    this.tableBorderColor = options.tableBorderColor ?? this.ruleColor;
    this.tableHeaderBackground =
      options.tableHeaderBackground ?? "rgba(127,127,127,0.10)";
    this.dropIndicatorColor = options.dropIndicatorColor ?? this.caretColor;
    this.maxHeight = options.maxHeight ?? null;
    this.onRender = options.onRender;

    // Merge caller mark styles over the defaults; an explicit null disables
    // a default mark.
    this.markStyles = { ...DEFAULT_MARK_STYLES };
    for (const [name, style] of Object.entries(options.markStyles ?? {})) {
      if (style === null) delete this.markStyles[name];
      else this.markStyles[name] = style;
    }

    // Split the base font into size + family for composing marked runs.
    const fontMatch = this.font.match(/(\d+(?:\.\d+)?)px\s+(.+)$/);
    this.baseFontSize = fontMatch ? parseFloat(fontMatch[1]) : 16;
    this.baseFontFamily = fontMatch ? fontMatch[2].trim() : "sans-serif";

    // Default block styles (headings sized by level); merge caller overrides.
    this.blockStyles = {
      heading: (node) => {
        const size = Math.round(
          this.baseFontSize *
            (HEADING_SCALE[node.attrs["level"] as number] ?? 1),
        );
        return {
          fontSize: size,
          fontWeight: 700,
          lineHeight: Math.round(size * 1.3),
        };
      },
      blockquote: {
        fontStyle: "italic",
        color: "#8a8a96",
        paddingLeft: 18,
        paddingTop: 2,
        paddingBottom: 2,
        borderLeft: { width: 3, color: "#3a3a42" },
      },
      code_block: {
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        color: "#c0caf5",
        background: "#1c1c20",
        paddingLeft: 14,
        paddingRight: 14,
        paddingTop: 10,
        paddingBottom: 10,
      },
    };
    for (const [name, style] of Object.entries(options.blockStyles ?? {})) {
      if (style === null) delete this.blockStyles[name];
      else this.blockStyles[name] = style;
    }

    // keydownHandler is typed against prosemirror-view's EditorView, but
    // only touches state/dispatch — feed it our minimal shim.
    const compiled = keydownHandler(options.keymap ?? {});
    this.keymapHandler = (event) =>
      compiled(this.commandView() as never, event);

    this.floats = options.floats ?? [];
    this.floatRectFor = options.floatRect ?? null;
    this.floatGutter = options.floatGutter ?? 12;
    this.linkMark = options.linkMark ?? "link";
    this.onFollowLink =
      options.onFollowLink ??
      ((href) => {
        window.open(href, "_blank", "noopener");
      });
    this.nodeViews = options.nodeViews ?? {};
    this.inlineNodes = options.inlineNodes ?? {};
    this.containerNodes = options.containerNodes ?? {};
    this.decorationsFor = options.decorations ?? null;
    this.handlers = options.handlers ?? {};
    this.dragDrop = options.dragDrop !== false;

    // Build DOM
    const stack = document.createElement("div");
    stack.style.position = "relative";
    stack.style.cursor = "text";
    // Selection here belongs to ProseMirror, never to the DOM. Mousedown used
    // to suppress the browser's default outright, but a press that might become
    // a drag of the selection has to be left alone (see the mousedown handler),
    // and without this the browser would start selecting the accessibility
    // mirror's text underneath instead. Copy still works: it is served by the
    // textarea's own `copy` handler, not by a DOM selection.
    stack.style.userSelect = "none";
    (stack.style as unknown as Record<string, string>).webkitUserSelect = "none";
    this.stack = stack;

    this.canvas = document.createElement("canvas");
    this.canvas.style.display = "block";
    // Let the browser own vertical scrolling (native momentum), while taps and
    // long-presses are handled in JS. Also stops the 300ms tap delay / double-tap
    // zoom on the editor surface.
    this.canvas.style.touchAction = "pan-y";
    // The canvas is decorative pixels; assistive tech reads the mirror below.
    this.canvas.setAttribute("aria-hidden", "true");
    this.canvas.setAttribute("role", "presentation");

    this.textarea = document.createElement("textarea");
    Object.assign(this.textarea.style, {
      position: "absolute",
      top: "0",
      left: "0",
      width: "1px",
      height: "1px",
      padding: "0",
      margin: "0",
      border: "0",
      outline: "0",
      background: "transparent",
      color: "transparent",
      caretColor: "transparent",
      resize: "none",
      overflow: "hidden",
      whiteSpace: "nowrap",
      font: "inherit",
      zIndex: "2",
      pointerEvents: "none",
      transform: "translate(0, 0)",
    });
    this.textarea.autocapitalize = "off";
    this.textarea.autocomplete = "off";
    this.textarea.spellcheck = false;
    this.textarea.tabIndex = 0;
    this.textarea.setAttribute(
      "aria-label",
      options.ariaLabel ?? "Rich text editor",
    );
    this.textarea.setAttribute("aria-multiline", "true");
    this.textarea.setAttribute("role", "textbox");
    this.isEditable = options.editable ?? true;
    this.autofocus = options.autofocus ?? true;
    this.textarea.readOnly = !this.isEditable;
    this.textarea.setAttribute("aria-readonly", String(!this.isEditable));

    // Polite live region: format/structure changes and custom announcements.
    this.liveRegion = document.createElement("div");
    this.liveRegion.setAttribute("aria-live", "polite");
    this.liveRegion.setAttribute("aria-atomic", "true");
    Object.assign(this.liveRegion.style, SR_ONLY);

    // Structural mirror: the document serialized via the schema's toDOM,
    // kept in the a11y tree (visually hidden) for screen-reader browse mode.
    this.serializer = DOMSerializer.fromSchema(this.state.schema);
    if (options.a11yMirror !== false) {
      this.a11yMirror = document.createElement("div");
      this.a11yMirror.setAttribute(
        "aria-label",
        options.ariaLabel ?? "Rich text editor",
      );
      this.a11yMirror.setAttribute("role", "document");
      Object.assign(this.a11yMirror.style, SR_ONLY);
    } else {
      this.a11yMirror = null;
    }

    this.reducedMotion =
      typeof matchMedia !== "undefined" &&
      matchMedia("(prefers-reduced-motion: reduce)").matches;

    // Visible focus indicator while the (offscreen) textarea holds focus.
    this.textarea.addEventListener("focus", () => {
      stack.style.outline = `2px solid ${this.caretColor}`;
      stack.style.outlineOffset = "2px";
      // The caret is drawn only while focused, so gaining or losing focus is a
      // repaint — nothing else would schedule one.
      this.caretVisible = true;
      this.scheduleRender();
    });
    this.textarea.addEventListener("blur", () => {
      stack.style.outline = "none";
      this.scheduleRender();
    });

    stack.appendChild(this.canvas);
    stack.appendChild(this.textarea);
    stack.appendChild(this.liveRegion);
    if (this.a11yMirror) stack.appendChild(this.a11yMirror);

    if (this.maxHeight !== null) {
      this.scroller = document.createElement("div");
      this.scroller.style.maxHeight = `${this.maxHeight}px`;
      this.scroller.style.overflowY = "auto";
      // A classic, space-taking scrollbar (Windows; macOS set to "always show")
      // is carved out of the content box. Sizing the scroller to exactly
      // `containerWidth` therefore leaves the canvas — which is exactly that
      // wide — overflowing by the scrollbar's width, producing a spurious
      // horizontal scrollbar that clips the end of every line.
      //
      // So widen the scroller by the scrollbar and always reserve the gutter:
      // content then measures `containerWidth` whether or not it happens to be
      // scrolling, instead of the width changing as the document grows past a
      // viewport. Overlay scrollbars (modern macOS default) measure 0 and this
      // is a no-op.
      // The canvas is TEXT_BLEED wider than the content column (see the
      // constant), so the scroller has to be too or that strip becomes the
      // horizontal overflow this whole calculation exists to avoid.
      const gutter = scrollbarWidth();
      this.scroller.style.width =
        `${this.containerWidth + TEXT_BLEED + gutter}px`;
      this.scroller.style.boxSizing = "border-box";
      if (gutter > 0) this.scroller.style.scrollbarGutter = "stable";
      this.scroller.appendChild(stack);
      this.container.appendChild(this.scroller);
    } else {
      this.scroller = null;
      this.container.appendChild(stack);
    }

    // Dedicated measurement context (avoids touching the paint context)
    const mc = document.createElement("canvas");
    this.measureCtx = mc.getContext("2d")!;

    this.setupInput();
    this.startCaretBlink();
    this.render();
    this.syncA11y();
  }

  // ─── Public API ────────────────────────────────────────────────────

  dispatch(tr: Transaction): void {
    // Read-only: allow selection/navigation transactions, drop edits.
    if (!this.isEditable && tr.docChanged) return;
    const before = this._state.selection;
    this._state = this._state.apply(tr);
    if (tr.docChanged) this.transitions.mapThrough(tr.mapping);
    this.liftOutOfCollapsed();
    this.layoutDirty = true;
    this.lastInputTime = performance.now();
    this.caretVisible = true;
    if (this.movesCaret(tr, before)) this.scrollCaretIntoView = true;
    // Horizontal motion resets the phantom X and caret bias. Click and
    // moveVertical restore them after dispatching.
    this.phantomX = null;
    this.caretBias = -1;
    this.scheduleRender();
    this.syncA11y();
  }

  /**
   * Whether a transaction should bring the caret into view: it asked to, or
   * it moved the selection, or it edited at the caret (typing). Not for an
   * edit elsewhere — a collaborator's, or a toggle on a box far from the
   * caret — which would otherwise yank the view back to wherever the caret is.
   */
  private movesCaret(tr: Transaction, before: Selection): boolean {
    if (tr.scrolledIntoView) return true;
    if (!before.map(tr.doc, tr.mapping).eq(tr.selection)) return true;
    // Walk the caret through each step, checking whether a step's range
    // reaches it.
    let head = before.head;
    for (const map of tr.mapping.maps) {
      let touched = false;
      map.forEach((from, to) => {
        if (from <= head && head <= to) touched = true;
      });
      if (touched) return true;
      head = map.map(head);
    }
    return false;
  }

  /**
   * A collapsed container lays none of its children out, so a selection left
   * inside one has no caret to draw, and typing would edit text nobody can
   * see. Select the container instead (or step past it when it can't be
   * selected) — the same place a click on its header would leave you.
   */
  private liftOutOfCollapsed(): void {
    if (!this.hasCollapsible()) return;
    const sel = this._state.selection;
    const hidden = (pos: number): number | null => {
      const $p = this._state.doc.resolve(pos);
      for (let d = 1; d <= $p.depth; d++) {
        const n = $p.node(d);
        if (this.containerNodes[n.type.name]?.collapsed?.(n)) return $p.before(d);
      }
      return null;
    };
    const at = hidden(sel.from) ?? hidden(sel.to);
    if (at === null) return;
    const doc = this._state.doc;
    const node = doc.nodeAt(at)!;
    const next = NodeSelection.isSelectable(node)
      ? NodeSelection.create(doc, at)
      : Selection.near(doc.resolve(at + node.nodeSize), 1);
    this._state = this._state.apply(this._state.tr.setSelection(next));
  }

  private hasCollapsible(): boolean {
    for (const k in this.containerNodes)
      if (this.containerNodes[k].collapsed) return true;
    return false;
  }

  /**
   * Run a ProseMirror command against the current state (e.g. `toggleMark`).
   * Returns whether the command applied. Handy for wiring toolbar buttons:
   * `editor.command(toggleMark(schema.marks.strong))`.
   */
  command(cmd: Command): boolean {
    const handled = cmd(this.state, (tr) => this.dispatch(tr));
    this.textarea.focus();
    return handled;
  }

  /** Minimal view shim so ProseMirror commands/keymaps can dispatch. */
  private commandView(): {
    state: EditorState;
    dispatch: (tr: Transaction) => void;
  } {
    return { state: this.state, dispatch: (tr) => this.dispatch(tr) };
  }

  // ─── Accessibility ─────────────────────────────────────────────────

  /**
   * Announce a message to screen readers via the polite live region. Public so
   * consumers can voice their own events (e.g. a node view's result).
   */
  announce(message: string): void {
    // Re-set even if identical: clear first so repeats are re-read.
    this.liveRegion.textContent = "";
    this.liveRegion.textContent = message;
  }

  /** Refresh the structural mirror (on doc change) and announce a new block
   *  context (on selection change). Called from dispatch/construction. */
  private syncA11y(): void {
    if (this.a11yMirror && this.state.doc !== this.lastMirrorDoc) {
      this.updateMirror(this.lastMirrorDoc, this.state.doc);
      this.lastMirrorDoc = this.state.doc;
    }
    const ctx = this.describeContext();
    if (ctx !== this.lastAnnouncedContext) {
      this.lastAnnouncedContext = ctx;
      if (ctx) this.announce(ctx);
    }
  }

  /**
   * Keep the hidden screen-reader mirror in sync incrementally. A document diff
   * (`findDiffStart`/`findDiffEnd`) locates the contiguous range of top-level
   * blocks that changed, and only those are re-serialized — so typing in one
   * block is O(log n) to find it + O(1) DOM work, not an O(blocks) scan every
   * keystroke. Falls back to a full rebuild when the block count changes.
   */
  private updateMirror(prev: PMNode | null, cur: PMNode): void {
    const mirror = this.a11yMirror;
    if (!mirror) return;
    const kids = cur.content;
    if (
      !prev ||
      prev.childCount !== kids.childCount ||
      mirror.childNodes.length !== kids.childCount
    ) {
      mirror.replaceChildren(this.serializer.serializeFragment(kids));
      return;
    }
    const ds = prev.content.findDiffStart(kids);
    if (ds === null) return; // identical content
    const de = prev.content.findDiffEnd(kids);
    // Map the changed position range to top-level child indices. The identity
    // skip below makes an over-wide range harmless, so a boundary-rounded end is
    // fine.
    const start = prev.resolve(ds).index(0);
    const end = de
      ? prev.resolve(Math.min(prev.content.size, de.a)).index(0)
      : start;
    for (let i = start; i <= end && i < kids.childCount; i++) {
      if (prev.child(i) === kids.child(i)) continue; // unchanged subtree
      mirror.replaceChild(
        this.serializer.serializeNode(kids.child(i)),
        mirror.childNodes[i],
      );
    }
  }

  /** A short label for the block at the caret, announced as the user navigates
   *  between structural contexts (plain paragraphs announce nothing). */
  private describeContext(): string {
    const sel = this.state.selection;
    if (sel instanceof GapCursor) return "Between blocks";
    if (sel instanceof NodeSelection) {
      const n = sel.node;
      const alt = n.attrs["alt"] as string | undefined;
      return `${n.type.name}${alt ? `, ${alt}` : ""}, selected`;
    }
    const $from = sel.$from;
    for (let d = $from.depth; d > 0; d--) {
      if (this.isListNode($from.node(d))) {
        const ordered = this.isOrderedList($from.node(d));
        return ordered ? "Ordered list item" : "Bullet list item";
      }
    }
    const name = $from.parent.type.name;
    if (name === "heading")
      return `Heading ${($from.parent.attrs["level"] as number) ?? 1}`;
    if (name === "code_block") return "Code block";
    if (name === "blockquote") return "Quote";
    return "";
  }

  focus(): void {
    this.textarea.focus();
  }

  /** Whether the editor's input surface currently holds focus. */
  hasFocus(): boolean {
    return (
      typeof document !== "undefined" &&
      document.activeElement === this.textarea
    );
  }

  /** Read-only mode: navigation/selection/copy still work; edits are dropped. */
  get editable(): boolean {
    return this.isEditable;
  }

  setEditable(value: boolean): void {
    this.isEditable = value;
    this.textarea.readOnly = !value;
    this.textarea.setAttribute("aria-readonly", String(!value));
    this.scheduleRender();
  }

  /** The current document + selection. Change it with `dispatch`. */
  get state(): EditorState {
    return this._state;
  }

  /** The content column's width in px — what `options.width` set. */
  get width(): number {
    return this.containerWidth;
  }

  /**
   * Re-lay the document into a different content width.
   *
   * Width was fixed at construction until now, which made the editor the one
   * part of a responsive layout that could not respond: hosts had to freeze
   * their own dimensions to whatever the editor was built with, or clip it.
   *
   * Everything downstream falls out of two caches. The per-block layout cache
   * already records the width each block was assembled at and misses when it
   * differs, so it needs no help. The *positional* cache does not — it reuses a
   * block's absolute geometry by node identity, and every one of those y-offsets
   * and x-positions is now wrong — so it is dropped wholesale.
   */
  setWidth(width: number): void {
    const next = Math.max(1, Math.round(width));
    if (next === this.containerWidth) return;
    this.containerWidth = next;
    // A snapshot of the old column can't be composited into the new one.
    this.transitions.reset();

    this.positionedCache = new WeakMap();
    // `lastLayouts` is the other half of positional reuse: the assembler checks
    // the block at the same index there before consulting the cache, so leaving
    // it in place would hand back the old column's geometry unchanged.
    this.lastLayouts = [];
    this.layoutDirty = true;
    // The canvas is resized during paint, but the scroller is not — it was
    // sized once in the constructor and has to be brought along by hand.
    if (this.scroller) {
      this.scroller.style.width =
        `${this.containerWidth + TEXT_BLEED + scrollbarWidth()}px`;
    }
    // The canvas is about to change size, so any cached mapping between its
    // pixels and the viewport is stale.
    this.invalidateGeometry();
    this.scheduleRender();
  }

  /**
   * Map viewport coordinates to a document position (mirrors
   * `EditorView.posAtCoords`). `inside` is the position of a directly-enclosing
   * atom block, or -1. Returns null when there's no layout / nothing hit.
   */
  posAtCoords(coords: {
    left: number;
    top: number;
  }): { pos: number; inside: number } | null {
    const g = this.readGeometry();
    const x = (coords.left - g.left) / g.scaleX;
    const y = this.transitions.presentation.unmapY(
      (coords.top - g.top) / g.scaleY + (this.scroller?.scrollTop ?? 0),
    );
    const hit = this.clickToPos(this.lastLayouts, x, y);
    if (!hit) return null;
    let inside = -1;
    for (const b of this.lastLayouts) {
      if (
        b.isAtom &&
        y >= b.yOffset &&
        y <= b.yOffset + b.height &&
        this.claimsX(b, x)
      ) {
        inside = b.pmStartPos;
        break;
      }
    }
    return { pos: hit.pos, inside };
  }

  /**
   * Whether the caret is at the visual edge of its textblock in `dir` (mirrors
   * `EditorView.endOfTextblock`) — useful for deciding when an arrow should
   * leave the block. 'up'/'down' test the first/last line; the rest test the
   * block's start/end column.
   */
  endOfTextblock(
    dir: "up" | "down" | "left" | "right" | "forward" | "backward",
  ): boolean {
    const axis = dir === "up" || dir === "down" ? "vert" : "horiz";
    const d: 1 | -1 =
      dir === "down" || dir === "right" || dir === "forward" ? 1 : -1;
    return this.atTextblockEdge(axis, d);
  }

  /** Programmatically paste plain text (blank lines split paragraphs). */
  pasteText(text: string): void {
    this.pastePlainText(text);
  }

  /**
   * Replace the float rectangles the text flows around and re-layout. Call
   * this as a floated element moves or resizes (e.g. while dragging).
   */
  setFloats(floats: FloatRect[]): void {
    this.floats = floats;
    this.layoutDirty = true; // float geometry changes line widths document-wide
    this.scheduleRender();
  }

  /**
   * Move the block node at `from` (the position *before* it) so it sits at the
   * insertion position `to`. One transaction, so it's a single undo step, and
   * the moved node ends up selected. Returns false when the node can't live
   * there, or when `to` is inside the node / already its slot.
   *
   * Public because reordering shouldn't require a pointer: this is what a
   * keyboard "move block up/down" command, a slash menu, or a drag handle all
   * bottom out in.
   */
  moveNode(from: number, to: number): boolean {
    if (!this.isEditable) return false;
    const node = this.state.doc.nodeAt(from);
    if (!node || !node.isBlock) return false;
    const end = from + node.nodeSize;
    if (to > from && to < end) return false; // dropped on itself
    const insertAt = this.insertPointFor(to, node.type);
    if (insertAt === null || insertAt === from || insertAt === end) return false;

    const tr = this.state.tr.delete(from, end);
    const at = tr.mapping.map(insertAt);
    tr.insert(at, node);
    // `insert` fits the node into the parent, so it usually lands exactly at
    // `at` — but not if the schema made it wrap. Only select what's really there.
    const landed = tr.doc.nodeAt(at);
    tr.setSelection(
      landed && landed.type === node.type && NodeSelection.isSelectable(landed)
        ? NodeSelection.create(tr.doc, at)
        : Selection.near(tr.doc.resolve(at)),
    );
    this.dispatch(tr.scrollIntoView());
    return true;
  }

  /**
   * Start dragging the block node at `pos` from a pointer press — for building
   * your own drag affordance (a Notion-style handle beside a paragraph, say).
   * The editor takes over move/release and commits the move itself. Returns
   * false if the node can't be dragged or a `dragStart` handler vetoed it.
   */
  startNodeDrag(pos: number, event: PointerEvent): boolean {
    if (!this.isEditable) return false;
    const node = this.state.doc.nodeAt(pos);
    if (!node || !node.isBlock) return false;
    if (this.handlers.dragStart?.(this, pos, event)) return false;
    this.nodeDrag = {
      pointerId: event.pointerId,
      from: pos,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
    };
    return true;
  }

  /**
   * Viewport coordinates of a document position — the top-left of the caret
   * there, plus the line height. The anchor for selection-positioned UI
   * (bubble menus, inline link editors, hovercards). Mirrors
   * `EditorView.coordsAtPos`. Returns null if the doc has no layout yet.
   */
  coordsAtPos(pos: number): { x: number; y: number; height: number } | null {
    this.ensureLayout();
    const coords = this.posToCoords(
      this.lastLayouts,
      clamp(pos, 0, this.state.doc.content.size),
    );
    if (!coords) return null;
    // Layout space → viewport space: offset by where the canvas sits, scaled by
    // how large it is being drawn. The scroll offset is in layout px too, so it
    // is subtracted before scaling, not after.
    const g = this.canvasOffset();
    // Mid-transition, where it is drawn rather than where layout has it.
    const y = this.transitions.presentation.mapY(coords.y).y;
    return {
      x: g.left + coords.x * g.scaleX,
      y: g.top + (y - this.lastScrollTop) * g.scaleY,
      height: coords.height * g.scaleY,
    };
  }

  /**
   * The canvas's viewport-relative top-left and display scale, cached across
   * calls. The cache is cleared on scroll/resize (see `setupInput`); height
   * changes from a render don't move the top-left, so a repaint needn't
   * invalidate it. Keeps `coordsAtPos` a pure cache lookup with no forced
   * layout.
   */
  private canvasOffset(): CanvasGeometry {
    if (this.canvasRectCache) return this.canvasRectCache;
    this.canvasRectCache = this.readGeometry();
    return this.canvasRectCache;
  }

  /**
   * Measure where the canvas is and how big it is being *drawn* relative to how
   * big it *is*.
   *
   * `offsetWidth` is the element's own layout width; `getBoundingClientRect()`
   * reports it after every transform on the way up to the viewport. Their ratio
   * is therefore the accumulated scale, whoever applied it and however deep —
   * the editor never has to be told about a camera, and a host that zooms with
   * a CSS transform gets correct hit-testing for free.
   *
   * The one thing this cannot see through is rotation, which turns the rect
   * into an axis-aligned bounding box and makes both ratios lies. A rotated
   * editor would need a real matrix inverse.
   */
  private readGeometry(): CanvasGeometry {
    const rect = this.canvas.getBoundingClientRect();
    const w = this.canvas.offsetWidth;
    const h = this.canvas.offsetHeight;
    return {
      left: rect.left,
      top: rect.top,
      // A detached or display:none canvas measures 0; 1 keeps the mapping an
      // identity rather than producing NaN coordinates.
      scaleX: w > 0 ? rect.width / w : 1,
      scaleY: h > 0 ? rect.height / h : 1,
    };
  }

  /**
   * Drop the cached canvas geometry, so the next coordinate mapping re-measures.
   *
   * Call this after moving or scaling the editor by means it cannot observe —
   * a CSS transform on an ancestor, most of all. Scroll and resize already
   * invalidate on their own; a transform fires no event, so this is the seam a
   * zooming host reaches for.
   */
  invalidateGeometry(): void {
    this.canvasRectCache = null;
  }

  /**
   * Viewport bounding box of the current selection, or null when it's empty.
   * Built from the selection's endpoints — enough to anchor a floating
   * toolbar above (`top`) and centered (`(left + right) / 2`).
   */
  selectionRect(): {
    left: number;
    right: number;
    top: number;
    bottom: number;
  } | null {
    const sel = this.state.selection;
    if (sel.empty) return null;
    const a = this.coordsAtPos(sel.from);
    const b = this.coordsAtPos(sel.to);
    if (!a || !b) return null;
    return {
      left: Math.min(a.x, b.x),
      right: Math.max(a.x, b.x),
      top: Math.min(a.y, b.y),
      bottom: Math.max(a.y + a.height, b.y + b.height),
    };
  }

  destroy(): void {
    if (this.blinkInterval !== null) {
      clearInterval(this.blinkInterval);
      this.blinkInterval = null;
    }
    this.abortController?.abort();
    this.stopAutoScroll();
    // An animation in flight would keep scheduling frames.
    this.transitions.reset();
    for (const view of this.mountedViews.values())
      view.resizeObserver?.disconnect();
    this.mountedViews.clear();
    this.inlineViews.clear();
    this.headerViews = [];
    this.container.innerHTML = "";
    // Emptying the container detaches these, but the fields went on pointing at
    // them — so a lazily-built overlay would be handed back already orphaned,
    // and the nodes themselves stayed reachable from the editor.
    this.loupe = null;
    this.selHandles = null;
    this.mountedWidgets.clear();
  }

  // ─── Layout (cache-aware) ──────────────────────────────────────────

  /** measureText for a whole string, memoized by font+text (see widthCache). */
  private measureWidth(text: string, font: string): number {
    const key = `${font}${text}`;
    let w = this.widthCache.get(key);
    if (w === undefined) {
      this.measureCtx.font = font;
      w = this.measureCtx.measureText(text).width;
      if (this.widthCache.size > 8000) this.widthCache.clear();
      this.widthCache.set(key, w);
    }
    return w;
  }

  /** Lay out one block, choosing the single-font fast path or the marked path. */
  private layoutBlock(
    node: PMNode,
    indent = 0,
    frame?: LayoutFrame,
  ): CachedBlock {
    const base = this.blockBase(node, indent);
    const frameX = frame?.x ?? 0;
    const frameW = frame?.width ?? this.containerWidth;
    const text = inlineText(node);
    if (text.length === 0) {
      return {
        prepared: null,
        width: frameW,
        lineHeight: base.lineHeight,
        lines: [],
        height: 0,
        ...this.boxFields(base, indent),
      };
    }

    if (this.blockHasMarks(node)) {
      return this.layoutMarkedBlock(node, indent, frame);
    }

    // Fast path: a single font for the whole block. 'pre-wrap' keeps every
    // space as a real character (default 'normal' collapses runs of
    // whitespace), so line text stays in lockstep with PM offsets and the
    // caret doesn't drift when you type consecutive spaces.
    const availW = frameW - base.paddingLeft - base.paddingRight;
    const prepared = prepareWithSegments(text, base.font, {
      whiteSpace: "pre-wrap",
    });
    const { lines, height } = layoutWithLines(
      prepared,
      availW,
      base.lineHeight,
    );
    let acc = 0;
    const cachedLines: CachedLine[] = lines.map((l) => {
      const cl = {
        text: l.text,
        width: l.width,
        pmStart: acc,
        x: frameX + base.paddingLeft
          + alignOffset(availW, l.width, base.textAlign),
      };
      acc += l.text.length;
      // 'pre-wrap' breaks on a hard newline but drops it from the line
      // text; skip it so the next line's offset stays aligned with source.
      if (text[acc] === "\n") acc += 1;
      return cl;
    });
    return {
      prepared,
      width: frameW,
      lineHeight: base.lineHeight,
      lines: cachedLines,
      height,
      ...this.boxFields(base, indent),
    };
  }

  // Style resolution lives in ./layout/style — the half of layout tables do
  // not change. These forward with the config it reads; `styleCx` is a getter
  // over readonly fields, so it costs an object and nothing else.
  private get styleCx(): StyleContext {
    return {
      font: this.font,
      baseFontSize: this.baseFontSize,
      baseFontFamily: this.baseFontFamily,
      lineHeight: this.lineHeight,
      containerWidth: this.containerWidth,
      markStyles: this.markStyles,
      blockStyles: this.blockStyles,
    };
  }

  private blockHasMarks(node: PMNode): boolean {
    return blockHasMarks(node);
  }

  /** What ./layout/table needs: the block gap, and a way to lay a cell's
   *  block out through the ordinary pipeline at a given frame. */
  private get tableCx(): TableLayoutContext {
    return {
      blockGap: this.blockGap,
      layoutFlow: (parent, contentStart, originY, frame) =>
        this.layoutFlow(parent, contentStart, originY, frame),
    };
  }

  /**
   * Lay a container's block children out down a frame, starting at `originY`.
   *
   * This is the document's own flow, reachable for any sub-frame — which is how
   * a table cell gets paragraphs, headings, lists, leaf nodes, and nested
   * tables without the table layout knowing what any of those are. Floats are
   * deliberately absent: they are a document-level concept, and a float rect is
   * in document space, so they do not apply inside a cell.
   */
  private layoutFlow(
    parent: PMNode,
    contentStart: number,
    originY: number,
    frame: LayoutFrame,
  ): {
    blocks: BlockLayout[];
    tables: TableChrome[];
    containers: ContainerChrome[];
    height: number;
  } {
    const descs: BlockDesc[] = [];
    collectBlocks(parent, contentStart, 0, null, descs, this.hasNodeView, this.isContainer);

    const blocks: BlockLayout[] = [];
    const tables: TableChrome[] = [];
    const containers: ContainerChrome[] = [];
    let y = originY;

    for (const { node, pos, indent, marker, leaf, table, container } of descs) {
      if (table) {
        const sub = layoutTable(this.tableCx, node, pos, y, {
          x: frame.x + indent,
          width: Math.max(1, frame.width - indent),
        });
        blocks.push(...sub.blocks);
        tables.push(sub.chrome, ...sub.nested);
        containers.push(...sub.containers);
        y += sub.height + this.blockGap;
        continue;
      }
      if (container) {
        const sub = this.layoutContainer(node, pos, y, {
          x: frame.x + indent,
          width: Math.max(1, frame.width - indent),
        });
        blocks.push(...sub.blocks);
        tables.push(...sub.tables);
        containers.push(...sub.containers);
        y += sub.height + this.blockGap;
        continue;
      }
      if (leaf) {
        const h = this.isRuleNode(node)
          ? this.lineHeight
          : (this.nodeViewHeights.get(node) ?? this.defaultAtomHeight);
        blocks.push(
          this.atomLayout(node, pos, y, h, marker, this.lineHeight),
        );
        y += h + this.blockGap;
        continue;
      }
      // A list indent narrows the frame rather than only padding the text, so
      // a nested list inside a narrow cell still wraps inside the cell.
      const bl = this.assembleTextBlock(node, indent, y, marker, pos, false, {
        x: frame.x,
        width: frame.width,
      });
      blocks.push(bl);
      y += bl.height + this.blockGap;
    }

    const height = y > originY ? y - originY - this.blockGap : 0;
    return { blocks, tables, containers, height };
  }

  /**
   * Lay a content-holding node out: its children flow through the ordinary
   * pipeline into a frame inset by the spec's padding and header, and the box
   * around them is recorded as chrome for painting. The chrome is pushed
   * before the children's, so an outer box always paints beneath an inner one.
   */
  private layoutContainer(
    node: PMNode,
    pos: number,
    originY: number,
    frame: LayoutFrame,
  ): {
    blocks: BlockLayout[];
    tables: TableChrome[];
    containers: ContainerChrome[];
    height: number;
  } {
    const spec = this.containerNodes[node.type.name];
    const pad = resolveInsets(perNode(spec.padding, node, 12));
    const header = Math.max(0, perNode(spec.header, node, 0));
    const collapsed = spec.collapsed?.(node) ?? false;
    const chrome: ContainerChrome = {
      node,
      pos,
      x: frame.x,
      y: originY,
      width: frame.width,
      height: 0,
      header,
      collapsed,
      background: perNode(spec.background, node, null),
      borderColor: perNode(spec.borderColor, node, null),
      accentColor: perNode(spec.accentColor, node, null),
      accentWidth: spec.accentWidth ?? 4,
      radius: spec.radius ?? 6,
    };
    const flow = collapsed
      ? { blocks: [], tables: [], containers: [], height: 0 }
      : this.layoutFlow(node, pos + 1, originY + header + pad.top, {
          x: frame.x + pad.left,
          width: Math.max(1, frame.width - pad.left - pad.right),
        });
    // Collapsed, the padding still frames the header so the box keeps its
    // shape; with no header either, it shrinks to its padding.
    chrome.height = collapsed
      ? header > 0
        ? header
        : pad.top + pad.bottom
      : header + pad.top + flow.height + pad.bottom;
    return {
      blocks: flow.blocks,
      tables: flow.tables,
      containers: [chrome, ...flow.containers],
      height: chrome.height,
    };
  }

  /** The BlockLayout for a leaf/atom block occupying reserved height. */
  private atomLayout(
    node: PMNode,
    pos: number,
    yOffset: number,
    height: number,
    marker: BlockDesc["marker"],
    lineHeight: number,
  ): BlockLayout {
    return {
      type: node.type.name,
      node,
      text: "",
      yOffset,
      height,
      lines: [],
      pmStartPos: pos,
      pmEndPos: pos + node.nodeSize,
      isAtom: true,
      lineHeight,
      font: this.font,
      fontSize: this.baseFontSize,
      color: null,
      paddingTop: 0,
      paddingBottom: 0,
      background: null,
      borderLeft: null,
      marker,
    };
  }

  private resolveRunStyle(marks: readonly Mark[], base: ResolvedBlockStyle) {
    return resolveRunStyle(this.styleCx, marks, base);
  }

  private resolveBlockStyle(node: PMNode): ResolvedBlockStyle {
    return resolveBlockStyle(this.styleCx, node);
  }

  private boxFields(base: ResolvedBlockStyle, indent = 0) {
    return boxFields(base, indent);
  }

  private blockBase(node: PMNode, indent: number): ResolvedBlockStyle {
    return blockBase(this.styleCx, node, indent);
  }

  private blockContentWidth(base: ResolvedBlockStyle): number {
    return blockContentWidth(this.styleCx, base);
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
  private prepareMarkedSegments(
    node: PMNode,
    base: ResolvedBlockStyle,
  ): { segments: MarkedSegment[]; blockText: string } {
    const blockText = inlineText(node);
    type Run = {
      font: string;
      color: string | null;
      background: string | null;
      text: string;
      pmStart: number;
      underline: boolean;
      strikethrough: boolean;
      baselineShift: number;
    };
    const segments: MarkedSegment[] = [];
    let seg: MarkedSegment = { items: [], meta: [], startOffset: 0 };
    segments.push(seg);
    let cur: Run | null = null;

    const flushRun = () => {
      if (!cur) return;
      const leadTrim = cur.text.length - cur.text.trimStart().length;
      const trimmed = cur.text.replace(/^\s+/, "").replace(/\s+$/, "");
      seg.items.push({ text: cur.text, font: cur.font });
      seg.meta.push({
        pmStart: cur.pmStart,
        leadTrim,
        font: cur.font,
        color: cur.color,
        background: cur.background,
        trimmed,
        underline: cur.underline,
        strikethrough: cur.strikethrough,
        baselineShift: cur.baselineShift,
      });
      cur = null;
    };
    const breakSegment = (startOffset: number) => {
      flushRun();
      seg = { items: [], meta: [], startOffset };
      segments.push(seg);
    };

    let offset = 0;
    node.forEach((child) => {
      if (!child.isText) {
        // An inline leaf (mention, chip) is one unbreakable box: Pretext's
        // `break: 'never'` keeps it whole, and `extraWidth` reserves the
        // chrome around its label, so the line breaks around it like a word.
        if (child.isLeaf) {
          flushRun();
          const style = this.resolveRunStyle(child.marks, base);
          const { box, width } = this.inlineAtomBox(child, style.font);
          const text = box.label || ATOM_CHAR;
          seg.items.push({
            text,
            font: box.font,
            break: "never",
            extraWidth: Math.max(0, width - this.measureWidth(text, box.font)),
          });
          seg.meta.push({
            pmStart: offset,
            leadTrim: 0,
            font: box.font,
            color: null,
            background: style.background,
            trimmed: ATOM_CHAR,
            underline: false,
            strikethrough: false,
            baselineShift: 0,
            atom: box,
            atomWidth: width,
          });
        }
        offset += child.nodeSize;
        return;
      }
      const childText = child.text ?? "";
      const style = this.resolveRunStyle(child.marks, base);
      const parts = childText.split("\n");
      let local = offset;
      for (let i = 0; i < parts.length; i++) {
        if (i > 0) {
          local += 1;
          breakSegment(local);
        } // skip the '\n'
        const part = parts[i];
        if (part.length === 0) continue;
        if (
          cur &&
          cur.font === style.font &&
          cur.color === style.color &&
          cur.background === style.background &&
          cur.underline === style.underline &&
          cur.strikethrough === style.strikethrough &&
          cur.baselineShift === style.baselineShift
        ) {
          cur.text += part;
        } else {
          flushRun();
          cur = { ...style, text: part, pmStart: local };
        }
        local += part.length;
      }
      offset += child.nodeSize;
    });
    flushRun();

    return { segments, blockText };
  }

  /**
   * How an inline atom is drawn and how wide its box is. The width is
   * measured with the same context as every text run, so the box the line
   * breaker reserved is the box that gets painted and hit-tested.
   */
  private inlineAtomBox(
    node: PMNode,
    runFont: string,
  ): { box: InlineAtomBox; width: number } {
    const spec = this.inlineNodes[node.type.name] ?? {};
    const font = spec.font ?? runFont;
    const leafText = node.type.spec.leafText;
    const attrLabel = node.attrs["label"];
    const label = (
      spec.label?.(node) ??
      (leafText
        ? leafText(node)
        : typeof attrLabel === "string"
          ? attrLabel
          : node.type.name)
    ).trim();
    const paddingX = spec.paddingX ?? 6;
    // A DOM atom with no fixed width reserves its element's measured width,
    // and the label's until it has been measured.
    const width =
      spec.width?.(node) ??
      (spec.render ? this.inlineWidths.get(node) : undefined) ??
      (label ? this.measureWidth(label, font) : 0) + 2 * paddingX;
    return {
      box: {
        node,
        label,
        font,
        paddingX,
        background: spec.background ?? "rgba(59, 130, 246, 0.14)",
        color: spec.color ?? "#1d4ed8",
        radius: spec.radius ?? 4,
        dom: !!spec.render,
      },
      width,
    };
  }

  private layoutMarkedBlock(
    node: PMNode,
    indent = 0,
    frame?: LayoutFrame,
  ): CachedBlock {
    const base = this.blockBase(node, indent);
    const frameX = frame?.x ?? 0;
    const frameW = frame?.width ?? this.containerWidth;
    const { segments, blockText } = this.prepareMarkedSegments(node, base);
    const lines: CachedLine[] = [];
    const ctx: MarkedLineCtx = {
      meta: [],
      blockText,
      consumed: [],
      prevLineEnd: 0,
    };
    const width = frameW - base.paddingLeft - base.paddingRight;

    for (const seg of segments) {
      // A segment's first line owns the preceding '\n' offset (startOffset-1)
      // so an offset just after the break resolves onto the new line — the
      // same tiling the single-font 'pre-wrap' path produces.
      const segPmStart = seg.startOffset > 0 ? seg.startOffset - 1 : 0;
      if (seg.items.length === 0) {
        lines.push({
          text: "",
          width: 0,
          pmStart: segPmStart,
          x: frameX + base.paddingLeft,
          fragments: [],
        });
        ctx.prevLineEnd = segPmStart;
        continue;
      }
      const prepared = prepareRichInline(seg.items);
      ctx.meta = seg.meta;
      ctx.consumed = new Array(seg.items.length).fill(0);
      const segLineStart = lines.length;
      // Pretext decides which runs land on which line; buildMarkedLine then
      // measures geometry with the paint context so fragment widths match
      // fillText and stay consistent with measureText-based hit-testing.
      walkRichInlineLineRanges(prepared, width, (range) => {
        const line = this.buildMarkedLine(
          prepared,
          range,
          ctx,
          lines.length === 0,
        );
        line.x = frameX + base.paddingLeft
          + alignOffset(width, line.width, base.textAlign);
        lines.push(line);
      });
      if (segLineStart > 0 && lines.length > segLineStart) {
        lines[segLineStart].pmStart = segPmStart;
      }
    }

    return {
      prepared: null,
      width: frameW,
      lineHeight: base.lineHeight,
      lines,
      height: lines.length * base.lineHeight,
      ...this.boxFields(base, indent),
    };
  }

  /** Float-aware counterpart of layoutBlock: lays each line at its own width. */
  private layoutBlockAt(node: PMNode, topY: number, indent = 0): CachedBlock {
    const base = this.blockBase(node, indent);
    const text = inlineText(node);
    if (text.length === 0) {
      return {
        prepared: null,
        width: this.containerWidth,
        lineHeight: base.lineHeight,
        lines: [],
        height: 0,
        ...this.boxFields(base, indent),
      };
    }
    if (this.blockHasMarks(node)) {
      const { segments, blockText } = this.prepareMarkedSegments(node, base);
      return this.layoutMarkedBlockFloated(segments, blockText, base, topY);
    }
    const prepared = prepareWithSegments(text, base.font, {
      whiteSpace: "pre-wrap",
    });
    return this.layoutBlockFloated(prepared, text, base, topY);
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
  ): CachedLine {
    const mat = materializeRichInlineLineRange(prepared, range);
    const fragments: CachedFragment[] = [];
    let x = 0;
    let lineText = "";
    let prevPmEnd = -1;
    // A jump in PM offset means Pretext trimmed whitespace between the runs
    // into a gap. Append the real boundary whitespace to the previous run so
    // every space stays navigable (rather than collapsing several to one).
    // Never at a line start. Returns the advance.
    //
    // Advance by the gap Pretext reserved, not by re-measuring the whitespace
    // in the previous run's font.
    //
    // Pretext broke this line to a width that already includes its own
    // `gapBefore` for each boundary. Re-measuring the gap in the preceding
    // run's font answers a slightly different question, and the difference
    // is per-boundary and cumulative: every later fragment on the line is
    // pushed right by the running error, so a line crossing several
    // boundaries paints past the column it was broken to and the canvas
    // guillotines its last glyph. Across fonts of the same family that is
    // hundredths of a pixel; across a family switch — a `code` span in
    // prose, serif to monospace — it was over 11px, far past the 6px
    // `TEXT_BLEED` meant to absorb it.
    //
    // The gap text still joins the previous run, so every space stays a
    // real editable character. Only the advance changes, which also makes
    // several collapsed spaces occupy one space's width — what CSS
    // `white-space: normal` does, and what this was always supposed to be.
    //
    // An atom's box is exactly its own width and its text exactly one
    // character, so whitespace after one can't join it: it becomes a
    // fragment of its own, styled like the run that follows.
    const joinGap = (
      pmStart: number,
      gapBefore: number,
      next: MarkedLineCtx["meta"][number],
    ): number => {
      const prev = fragments[fragments.length - 1];
      const gap = ctx.blockText.substring(prevPmEnd, pmStart);
      const font = prev.atom ? next.font : prev.font;
      const gapWidth = gapBefore > 0 ? gapBefore : this.measureWidth(gap, font);
      if (prev.atom) {
        fragments.push({
          text: gap,
          font,
          color: next.color,
          background: null,
          x,
          width: gapWidth,
          pmStart: prevPmEnd,
        });
      } else {
        prev.text += gap;
        prev.width += gapWidth;
      }
      lineText += gap;
      return gapWidth;
    };
    for (const f of mat.fragments) {
      const m = ctx.meta[f.itemIndex];
      if (m.atom) {
        // An atom is one position wide and exactly as wide as its box. Any
        // whitespace Pretext trimmed in front of it joins the run before.
        if (fragments.length > 0 && m.pmStart > prevPmEnd) {
          x += joinGap(m.pmStart, f.gapBefore, m);
        }
        fragments.push({
          text: ATOM_CHAR,
          font: m.font,
          color: null,
          background: m.background,
          x,
          width: m.atomWidth ?? 0,
          pmStart: m.pmStart,
          atom: m.atom,
        });
        x += m.atomWidth ?? 0;
        lineText += ATOM_CHAR;
        prevPmEnd = m.pmStart + 1;
        ctx.consumed[f.itemIndex] = 1;
        continue;
      }
      const start = ctx.consumed[f.itemIndex];
      // Pretext collapses runs of whitespace inside a fragment; re-expand
      // against the source so every space stays a real editable character.
      const [text, end] = expandCollapsedWhitespace(m.trimmed, start, f.text);
      ctx.consumed[f.itemIndex] = end;
      const pmStart = m.pmStart + m.leadTrim + start;

      // Whitespace Pretext trimmed into a gap (see joinGap).
      if (fragments.length > 0 && pmStart > prevPmEnd) {
        x += joinGap(pmStart, f.gapBefore, m);
      }

      const width = this.measureWidth(text, m.font);
      fragments.push({
        text,
        font: m.font,
        color: m.color,
        background: m.background,
        x,
        width,
        pmStart,
        underline: m.underline,
        strikethrough: m.strikethrough,
        baselineShift: m.baselineShift,
      });
      x += width;
      lineText += text;
      prevPmEnd = pmStart + text.length;
    }
    // Line 0 owns the block start (offset 0); each later line begins at its
    // first fragment, so whitespace collapsed at a wrap belongs to the line
    // before it. This tiles [0, blockLen) with no gaps.
    const linePmStart = isFirstLine
      ? 0
      : fragments.length > 0
        ? fragments[0].pmStart
        : ctx.prevLineEnd;
    ctx.prevLineEnd =
      fragments.length > 0
        ? fragments[fragments.length - 1].pmStart +
          fragments[fragments.length - 1].text.length
        : ctx.prevLineEnd;
    return { text: lineText, width: x, pmStart: linePmStart, fragments };
  }

  // ─── Float-aware layout ────────────────────────────────────────────

  /**
   * The widest free horizontal slot for a line whose top is at document
   * `bandTop`, after subtracting any floats it vertically intersects.
   * Returns null when nothing usable fits (the caller flows past the band).
   */
  private slotForBand(
    bandTop: number,
    lineHeight: number = this.lineHeight,
  ): { x: number; width: number } | null {
    const bandBottom = bandTop + lineHeight;
    const g = this.floatGutter;
    let slots: { left: number; right: number }[] = [
      { left: 0, right: this.containerWidth },
    ];
    for (const f of this.activeFloats) {
      // Inflate the rect by the gutter so text clears it on every side.
      if (bandBottom <= f.y - g || bandTop >= f.y + f.height + g) continue;
      const blockLeft = f.x - g;
      const blockRight = f.x + f.width + g;
      const next: { left: number; right: number }[] = [];
      for (const s of slots) {
        if (blockRight <= s.left || blockLeft >= s.right) {
          next.push(s);
          continue;
        }
        if (blockLeft > s.left) next.push({ left: s.left, right: blockLeft });
        if (blockRight < s.right)
          next.push({ left: blockRight, right: s.right });
      }
      slots = next;
    }
    let best: { left: number; right: number } | null = null;
    for (const s of slots) {
      if (s.right - s.left < this.minSlotWidth) continue;
      if (!best || s.right - s.left > best.right - best.left) best = s;
    }
    return best ? { x: best.left, width: best.right - best.left } : null;
  }

  /** Single-font block laid out line-by-line, flowing around floats. */
  private layoutBlockFloated(
    prepared: PreparedTextWithSegments,
    text: string,
    base: ResolvedBlockStyle,
    topY: number,
  ): CachedBlock {
    const lh = base.lineHeight;
    const lines: CachedLine[] = [];
    let cursor: LayoutCursor = { segmentIndex: 0, graphemeIndex: 0 };
    let bandTop = 0;
    let acc = 0;
    // Guard against a malformed float producing an unbounded skip loop.
    for (let guard = 0; guard < 20000; guard++) {
      const slot = this.slotForBand(topY + bandTop, lh);
      if (!slot) {
        bandTop += lh;
        continue;
      }
      const w = slot.width - base.paddingLeft - base.paddingRight;
      const line = layoutNextLine(prepared, cursor, w);
      if (!line) break;
      lines.push({
        text: line.text,
        width: line.width,
        pmStart: acc,
        x:
          slot.x +
          base.paddingLeft +
          alignOffset(w, line.width, base.textAlign),
        yOffset: bandTop,
      });
      acc += line.text.length;
      // Skip the hard newline 'pre-wrap' dropped at the break (see layoutBlock).
      if (text[acc] === "\n") acc += 1;
      cursor = line.end;
      bandTop += lh;
    }
    const height =
      lines.length > 0 ? lines[lines.length - 1].yOffset! + lh : lh;
    return {
      prepared,
      width: this.containerWidth,
      lineHeight: lh,
      lines,
      height,
      ...this.boxFields(base),
    };
  }

  /** Marked block laid out line-by-line (hard-line segments), flowing around floats. */
  private layoutMarkedBlockFloated(
    segments: MarkedSegment[],
    blockText: string,
    base: ResolvedBlockStyle,
    topY: number,
  ): CachedBlock {
    const lh = base.lineHeight;
    const lines: CachedLine[] = [];
    const ctx: MarkedLineCtx = {
      meta: [],
      blockText,
      consumed: [],
      prevLineEnd: 0,
    };
    let bandTop = 0;
    for (const seg of segments) {
      const segPmStart = seg.startOffset > 0 ? seg.startOffset - 1 : 0;
      if (seg.items.length === 0) {
        const slot = this.slotForBand(topY + bandTop, lh);
        lines.push({
          text: "",
          width: 0,
          pmStart: segPmStart,
          x: (slot?.x ?? 0) + base.paddingLeft,
          yOffset: bandTop,
          fragments: [],
        });
        ctx.prevLineEnd = segPmStart;
        bandTop += lh;
        continue;
      }
      const prepared = prepareRichInline(seg.items);
      ctx.meta = seg.meta;
      ctx.consumed = new Array(seg.items.length).fill(0);
      const segLineStart = lines.length;
      let cursor: RichInlineCursor | undefined;
      for (let guard = 0; guard < 20000; guard++) {
        const slot = this.slotForBand(topY + bandTop, lh);
        if (!slot) {
          bandTop += lh;
          continue;
        }
        const w = slot.width - base.paddingLeft - base.paddingRight;
        const range = layoutNextRichInlineLineRange(prepared, w, cursor);
        if (!range) break;
        const line = this.buildMarkedLine(
          prepared,
          range,
          ctx,
          lines.length === 0,
        );
        line.x =
          slot.x +
          base.paddingLeft +
          alignOffset(w, line.width, base.textAlign);
        line.yOffset = bandTop;
        lines.push(line);
        cursor = range.end;
        bandTop += lh;
      }
      if (segLineStart > 0 && lines.length > segLineStart) {
        lines[segLineStart].pmStart = segPmStart;
      }
    }
    const height =
      lines.length > 0 ? lines[lines.length - 1].yOffset! + lh : lh;
    return {
      prepared: null,
      width: this.containerWidth,
      lineHeight: lh,
      lines,
      height,
      ...this.boxFields(base),
    };
  }

  /**
   * Assemble one textblock's positioned layout at `cursorY`. Shared by the full
   * layout pass and the incremental single-block path so both produce identical
   * BlockLayouts. Reuses the per-node geometry cache (`layoutCache`) and stores
   * the result in `positionedCache` for cheap reuse next frame.
   */
  private assembleTextBlock(
    node: PMNode,
    indent: number,
    cursorY: number,
    marker: BlockDesc["marker"],
    pos: number,
    floating: boolean,
    frame?: LayoutFrame,
  ): BlockLayout {
    let cached: CachedBlock;
    const frameW = frame?.width ?? this.containerWidth;
    if (floating) {
      // Float-aware layout depends on the block's Y (relative to the floats),
      // so it can't use the Y-independent cache.
      cached = this.layoutBlockAt(node, cursorY, indent);
      this.cacheMisses++;
    } else {
      // Node identity + indent are sufficient (width/font are fixed).
      const hit = this.layoutCache.get(node);
      if (hit && hit.indent === indent && hit.width === frameW) {
        cached = hit;
        this.cacheHits++;
      } else {
        cached = this.layoutBlock(node, indent, frame);
        this.layoutCache.set(node, cached);
        this.cacheMisses++;
      }
    }

    const padTop = cached.paddingTop;
    const positioned: LineLayout[] = cached.lines.map((line, i) => ({
      text: line.text,
      width: line.width,
      x: line.x ?? 0,
      y: cursorY + padTop + (line.yOffset ?? i * cached.lineHeight),
      pmStart: line.pmStart,
      fragments: line.fragments,
    }));

    if (positioned.length === 0) {
      positioned.push({
        text: "",
        width: 0,
        x: cached.paddingLeft,
        y: cursorY + padTop,
        pmStart: 0,
      });
    }

    const blockHeight =
      (cached.height || cached.lineHeight) + padTop + cached.paddingBottom;

    const layout: BlockLayout = {
      type: node.type.name,
      node,
      text: inlineText(node),
      yOffset: cursorY,
      height: blockHeight,
      lines: positioned,
      pmStartPos: pos + 1,
      pmEndPos: pos + 1 + inlineText(node).length,
      lineHeight: cached.lineHeight,
      font: cached.font,
      fontSize: cached.fontSize,
      color: cached.color,
      paddingTop: padTop,
      paddingBottom: cached.paddingBottom,
      background: cached.background,
      borderLeft: cached.borderLeft,
      marker,
      indent,
      ...(frame ? { frame } : {}),
    };
    // A cell block's position depends on its table's layout, not on the
    // document cursor, so it must not seed the positional-reuse cache.
    if (!floating && !frame) this.positionedCache.set(node, layout);
    return layout;
  }

  /**
   * Incremental layout: when a dispatch changed one region of the document,
   * rebuild only that region and move everything after it, instead of walking
   * the whole document. Two shapes qualify:
   *
   * - one top-level-flow textblock changed (typing): `relayoutTextblock`;
   * - the edit sits inside a table or container: `relayoutFramedUnit` rebuilds
   *   the outermost such unit around it, whatever happened inside.
   *
   * Anything else (an edit spanning blocks in the main flow, a node's attrs
   * changing, floats) returns false and takes a full `computeLayout`. The test
   * suite checks every incremental result against a full pass.
   */
  private tryIncrementalLayout(): boolean {
    const prevDoc = this.prevDoc;
    if (!prevDoc || this.lastLayouts.length === 0) return false;
    // Floats make layout Y-dependent across the whole document; `hadFloats`
    // also bails the frame right after floats clear (stale widths below).
    if (this.floats.length > 0 || this.floatRectFor || this.hadFloats)
      return false;

    const ds = prevDoc.content.findDiffStart(this.state.doc.content);
    if (ds === null) {
      // Selection-only change: every block's layout is still valid.
      this.cacheHits = this.lastLayouts.length;
      this.cacheMisses = 0;
      return true;
    }
    const de = prevDoc.content.findDiffEnd(this.state.doc.content);
    if (!de) return false;
    // findDiffEnd can overlap findDiffStart when the edit repeats adjacent
    // content ("aa" → "aaa"); the changed span is whatever both bound.
    const edit: DocEdit = {
      from: Math.min(ds, de.a, de.b),
      toPrev: Math.max(ds, de.a),
      toCur: Math.max(ds, de.b),
      delta: this.state.doc.content.size - prevDoc.content.size,
    };
    return this.relayoutTextblock(edit) || this.relayoutFramedUnit(edit);
  }

  /**
   * One textblock in the main flow changed without altering structure. Its
   * blocks after it only move, so this is O(1) layout plus O(blocks after) of
   * number updates.
   */
  private relayoutTextblock(edit: DocEdit): boolean {
    const layouts = this.lastLayouts;
    // lastLayouts is sorted by position, so binary-search for the block
    // (in the *previous* document's coordinates) containing the change.
    let lo = 0,
      hi = layouts.length - 1,
      k = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const b = layouts[mid];
      const start = b.isAtom ? b.pmStartPos : b.pmStartPos - 1;
      const end = b.pmEndPos + 1;
      if (edit.from < start) hi = mid - 1;
      else if (edit.from > end) lo = mid + 1;
      else {
        k = mid;
        break;
      }
    }
    if (k < 0) return false;
    const blk = layouts[k];
    // An atom changing is structural; a framed block (in a table cell or a
    // container) can move its siblings in ways "shift what follows" cannot
    // express, so `relayoutFramedUnit` rebuilds its whole unit instead.
    if (blk.isAtom || blk.frame) return false;

    // The whole change must stay inside this one block; otherwise the edit
    // crossed a boundary (split/join).
    if (edit.from < blk.pmStartPos - 1 || edit.toPrev > blk.pmEndPos + 1)
      return false;

    // Content before the block is identical, so its start position holds.
    const curNode = this.state.doc.resolve(blk.pmStartPos).parent;
    if (!curNode.isTextblock || curNode === blk.node) return false;

    // The whole document delta must be explained by this block's own length
    // change; a split/join/list op changes the block count, so it won't be.
    const prevTextLen = blk.pmEndPos - blk.pmStartPos;
    if (edit.delta !== curNode.content.size - prevTextLen) return false;

    const rebuilt = this.assembleTextBlock(
      curNode,
      blk.indent ?? 0,
      blk.yOffset,
      blk.marker,
      blk.pmStartPos - 1,
      false,
    );
    layouts[k] = rebuilt;
    this.shiftAfterEdit(k + 1, edit, rebuilt.height - blk.height);
    this.cacheHits = layouts.length - 1;
    this.cacheMisses = 1;
    return true;
  }

  /**
   * The edit sits inside a table or a container. A row's height is its
   * tallest cell's and a box's is its content's, so one block's change can
   * move its neighbours in ways a plain shift cannot express. Instead, rebuild
   * the outermost table or container around the edit with the same functions
   * the full pass uses, splice it in, and shift what follows. Structure inside
   * the unit can change freely (splits, joins, a nested table appearing).
   */
  private relayoutFramedUnit(edit: DocEdit): boolean {
    const prevDoc = this.prevDoc!;
    const doc = this.state.doc;

    // The outermost unit is the one containing the edit with the lowest
    // position: units nest, so their ranges are nested intervals.
    let unit: TableChrome | ContainerChrome | null = null;
    for (const c of [...this.lastTables, ...this.lastContainers]) {
      if (unit && c.pos >= unit.pos) continue;
      const before = prevDoc.nodeAt(c.pos);
      if (before && c.pos < edit.from && edit.toPrev < c.pos + before.nodeSize)
        unit = c;
    }
    if (!unit) return false;

    // Strictly inside means the unit's own open and close tokens are in the
    // unchanged prefix and suffix, so the same node type still sits at `pos`.
    const pos = unit.pos;
    const prevEnd = pos + prevDoc.nodeAt(pos)!.nodeSize;
    const node = doc.nodeAt(pos);
    if (!node || edit.toCur >= pos + node.nodeSize) return false;

    // Chrome records exactly the frame it was laid out into.
    const frame: LayoutFrame = { x: unit.x, width: unit.width };
    this.cacheHits = 0;
    this.cacheMisses = 0;
    let sub: {
      blocks: BlockLayout[];
      tables: TableChrome[];
      containers: ContainerChrome[];
      height: number;
    };
    if ("cells" in unit) {
      const t = layoutTable(this.tableCx, node, pos, unit.y, frame);
      sub = {
        blocks: t.blocks,
        tables: [t.chrome, ...t.nested],
        containers: t.containers,
        height: t.height,
      };
    } else {
      sub = this.layoutContainer(node, pos, unit.y, frame);
    }
    const dy = sub.height - unit.height;

    // Swap the unit out: drop its old blocks and chrome, shift what follows,
    // then insert the rebuilt unit. Shifting before inserting matters: the new
    // chrome is already in the current document's positions.
    const layouts = this.lastLayouts;
    const a = lowerBound(layouts, (l) => l.pmStartPos > pos);
    const b = lowerBound(layouts, (l) => l.pmStartPos >= prevEnd);
    layouts.splice(a, b - a);
    const outside = (c: { pos: number }) => c.pos < pos || c.pos >= prevEnd;
    this.lastTables = this.lastTables.filter(outside);
    this.lastContainers = this.lastContainers.filter(outside);

    this.shiftAfterEdit(a, edit, dy);

    layouts.splice(a, 0, ...sub.blocks);
    insertAt(this.lastTables, pos, sub.tables);
    insertAt(this.lastContainers, pos, sub.containers);
    // Cell blocks sit side by side, so the order by Y can change inside.
    this.layoutsSortedByY = isSortedByY(layouts);
    this.cacheHits += layouts.length - sub.blocks.length;
    return true;
  }

  /**
   * Carry everything after an edit forward: document positions by the edit's
   * size delta, and pixels by `dy` (the rebuilt region's height change).
   * Everything after the edit in the document is also below it on screen,
   * because both incremental paths rebuild a region in the main flow.
   *
   * Chrome keeps its own positions — table cells for painting a CellSelection,
   * a container's for its header's getPos — so it has to move too.
   */
  private shiftAfterEdit(firstBlock: number, edit: DocEdit, dy: number): void {
    const layouts = this.lastLayouts;
    for (let i = firstBlock; i < layouts.length; i++) {
      const L = layouts[i];
      L.pmStartPos += edit.delta;
      L.pmEndPos += edit.delta;
      if (dy !== 0) {
        L.yOffset += dy;
        for (const ln of L.lines) ln.y += dy;
      }
    }
    for (const t of this.lastTables) {
      if (t.pos < edit.toPrev) continue;
      t.pos += edit.delta;
      t.y += dy;
      for (const r of t.rows) r.y += dy;
      for (const c of t.cells) {
        c.pos += edit.delta;
        c.y += dy;
      }
    }
    for (const c of this.lastContainers) {
      if (c.pos < edit.toPrev) continue;
      c.pos += edit.delta;
      c.y += dy;
    }
    this.lastTotalHeight += dy;
  }

  private computeLayout(): {
    layouts: BlockLayout[];
    totalHeight: number;
    tables: TableChrome[];
    containers: ContainerChrome[];
  } {
    this.cacheHits = 0;
    this.cacheMisses = 0;

    const result: BlockLayout[] = [];
    const tables: TableChrome[] = [];
    const containers: ContainerChrome[] = [];
    let cursorY = 0;

    const descs: BlockDesc[] = [];
    this.collectBlocks(this.state.doc, 0, 0, null, descs);

    // Pre-pass: derive float rects from floating nodes so text on every band
    // (not just below them) flows around them. Their measured node-view height
    // completes the rect; out of flow, they don't advance the block cursor.
    const floatRects = new Map<
      PMNode,
      { x: number; y: number; width: number; height: number }
    >();
    if (this.floatRectFor) {
      for (const d of descs) {
        if (!d.leaf || this.isRuleNode(d.node)) continue;
        const r = this.floatRectFor(d.node);
        if (!r) continue;
        floatRects.set(d.node, {
          x: r.x,
          y: r.y,
          width: r.width,
          height: this.nodeViewHeights.get(d.node) ?? this.defaultAtomHeight,
        });
      }
    }
    this.activeFloats =
      floatRects.size > 0
        ? [...this.floats, ...floatRects.values()]
        : this.floats;
    const floating = this.activeFloats.length > 0;
    // When the float regime flips, layouts cached under the other regime have
    // stale line widths; drop the positioned cache and skip positional reuse
    // this pass. (Per-block reuse resumes next frame once `hadFloats` agrees.)
    const floatRegimeChanged = floating !== this.hadFloats;
    if (floatRegimeChanged) this.positionedCache = new WeakMap();
    const canReuse = !floating && !floatRegimeChanged;

    for (const { node, pos, indent, marker, leaf, table, container } of descs) {
      if (container) {
        const sub = this.layoutContainer(node, pos, cursorY, {
          x: indent,
          width: this.containerWidth - indent,
        });
        result.push(...sub.blocks);
        tables.push(...sub.tables);
        containers.push(...sub.containers);
        this.cacheMisses++;
        cursorY += sub.height + this.blockGap;
        continue;
      }
      // A table lays its own cells out side by side and reports one height.
      // Its cell blocks come back already positioned, in document order, so
      // the rest of the pipeline sees them as ordinary blocks.
      if (table) {
        const { blocks, chrome, height, nested, containers: tableContainers } = layoutTable(
          this.tableCx,
          node,
          pos,
          cursorY,
          { x: indent, width: this.containerWidth - indent },
        );
        result.push(...blocks);
        tables.push(chrome, ...nested);
        containers.push(...tableContainers);
        this.cacheMisses++;
        cursorY += height + this.blockGap;
        continue;
      }

      // Leaf/atom block (node view or canvas-drawn rule): reserve height.
      if (leaf) {
        const fr = floatRects.get(node);
        if (fr) {
          // Floating node: positioned at its rect, out of the flow.
          result.push({
            type: node.type.name,
            node,
            text: "",
            yOffset: fr.y,
            height: fr.height,
            lines: [],
            pmStartPos: pos,
            pmEndPos: pos + node.nodeSize,
            isAtom: true,
            lineHeight: this.lineHeight,
            font: this.font,
            fontSize: this.baseFontSize,
            color: null,
            paddingTop: 0,
            paddingBottom: 0,
            background: null,
            borderLeft: null,
            marker,
            floatRect: fr,
          });
          continue;
        }
        const height = this.isRuleNode(node)
          ? this.lineHeight
          : (this.nodeViewHeights.get(node) ?? this.defaultAtomHeight);
        result.push({
          type: node.type.name,
          node,
          text: "",
          yOffset: cursorY,
          height,
          lines: [],
          pmStartPos: pos,
          pmEndPos: pos + node.nodeSize,
          isAtom: true,
          lineHeight: this.lineHeight,
          font: this.font,
          fontSize: this.baseFontSize,
          color: null,
          paddingTop: 0,
          paddingBottom: 0,
          background: null,
          borderLeft: null,
          marker,
        });
        cursorY += height + this.blockGap;
        continue;
      }

      // Fast path: reuse a previously assembled + positioned layout when this
      // block hasn't moved (same node identity, indent, marker, and yOffset).
      // Edits above shift its PM positions but not its pixels, so only the
      // scalar pmStartPos/pmEndPos need refreshing — no per-line reallocation.
      if (canReuse) {
        // The block at this index last frame is almost always the same node
        // (typing doesn't reorder blocks), so an array index + identity check
        // beats a WeakMap lookup; fall back to the identity cache when an
        // insert/remove shifts indices.
        let reuse: BlockLayout | undefined = this.lastLayouts[result.length];
        if (!reuse || reuse.node !== node)
          reuse = this.positionedCache.get(node);
        if (
          reuse &&
          reuse.node === node &&
          reuse.indent === indent &&
          reuse.yOffset === cursorY &&
          sameMarker(reuse.marker, marker)
        ) {
          reuse.pmStartPos = pos + 1;
          reuse.pmEndPos = pos + 1 + inlineText(node).length;
          result.push(reuse);
          cursorY += reuse.height + this.blockGap;
          this.cacheHits++;
          continue;
        }
      }

      const layout = this.assembleTextBlock(
        node,
        indent,
        cursorY,
        marker,
        pos,
        floating,
      );
      result.push(layout);
      cursorY += layout.height + this.blockGap;
    }

    const totalHeight = Math.max(this.lineHeight, cursorY - this.blockGap);
    this.hadFloats = floating;
    // Cheap to verify directly rather than inferred from "no floats and no
    // tables" — one pass over data already in cache, and it cannot drift out
    // of step with whatever the layout actually produced.
    this.layoutsSortedByY = isSortedByY(result);
    return { layouts: result, totalHeight, tables, containers };
  }

  // ─── Painting ──────────────────────────────────────────────────────

  /**
   * Painting lives in ./paint; these two forward with the context it needs.
   * `paintCx` is rebuilt per frame because `doc` and `selection` change every
   * dispatch — the rest are readonly config, so the object is the only cost.
   */
  private get paintCx(): PaintContext {
    return {
      canvas: this.canvas,
      scroller: this.scroller,
      containerWidth: this.containerWidth,
      font: this.font,
      textColor: this.textColor,
      firstLineColor: this.firstLineColor,
      selectionColor: this.selectionColor,
      ruleColor: this.ruleColor,
      tableBorderColor: this.tableBorderColor,
      tableHeaderBackground: this.tableHeaderBackground,
      placeholder: this.placeholder,
      placeholderColor: this.placeholderColor,
      doc: this.state.doc,
      selection: this.state.selection,
      xForOffsetInLine: (block, line, offset) =>
        this.xForOffsetInLine(block, line, offset),
      posToCoords: (layouts, pos) => this.posToCoords(layouts, pos),
    };
  }

  private applyVirtualLayout(virtualized: boolean, totalHeight: number): void {
    applyVirtualLayout(this.canvas, this.stack, virtualized, totalHeight);
  }

  private paintToCanvas(
    layouts: BlockLayout[],
    totalHeight: number,
    virtualized: boolean,
    decorations: Decoration[] = [],
    target?: { canvas: HTMLCanvasElement; top: number; height: number },
  ): void {
    paintToCanvas(
      target ? { ...this.paintCx, canvas: target.canvas } : this.paintCx,
      layouts,
      totalHeight,
      virtualized,
      decorations,
      this.lastTables,
      this.layoutsSortedByY,
      this.lastContainers,
      target,
    );
  }

  /** Mount/position/remove widget-decoration DOM at their document positions
   *  (overlays inside the scroll stack, reused by `key`). */
  private syncWidgets(layouts: BlockLayout[], decorations: Decoration[]): void {
    const present = new Set<string>();
    const widgets = decorations.filter(
      (d): d is WidgetDecoration => d.kind === "widget",
    );
    for (let i = 0; i < widgets.length; i++) {
      const w = widgets[i];
      const key = w.key ?? `__w${i}`;
      present.add(key);
      let el = this.mountedWidgets.get(key);
      if (!el) {
        el = typeof w.dom === "function" ? w.dom() : w.dom;
        el.style.position = "absolute";
        el.style.zIndex = "3";
        if (!el.style.pointerEvents) el.style.pointerEvents = "none";
        this.stack.appendChild(el);
        this.mountedWidgets.set(key, el);
      }
      const co = this.posToCoords(layouts, w.pos);
      if (co) {
        el.style.left = `${co.x + (w.offsetX ?? 0)}px`;
        el.style.top = `${co.y + (w.offsetY ?? 0)}px`;
        el.style.display = "";
      } else {
        el.style.display = "none";
      }
    }
    for (const [key, el] of this.mountedWidgets) {
      if (present.has(key)) continue;
      el.remove();
      this.mountedWidgets.delete(key);
    }
  }

  // Document-structure predicates and the tree->flat-list walk live in
  // ./layout/blocks as free functions; these forward so call sites (and the
  // test suite, which reaches for them) keep one spelling.

  private isRuleNode(node: PMNode): boolean {
    return isRuleNode(node);
  }

  private isListNode(node: PMNode): boolean {
    return isListNode(node);
  }

  private isOrderedList(node: PMNode): boolean {
    return isOrderedList(node);
  }

  private isLeafBlock(node: PMNode): boolean {
    return isLeafBlock(node, this.hasNodeView);
  }

  private collectBlocks(
    node: PMNode,
    contentStart: number,
    depth: number,
    marker: BlockDesc["marker"],
    out: BlockDesc[],
  ): void {
    collectBlocks(node, contentStart, depth, marker, out, this.hasNodeView, this.isContainer);
  }

  /** True when the document is a single empty text block. */
  private isDocEmpty(): boolean {
    return isDocEmpty(this.state.doc);
  }

  // ─── Caret + Coordinate Mapping ────────────────────────────────────

  private posToCoords(
    layouts: BlockLayout[],
    pos: number,
  ): { x: number; y: number; height: number } | null {
    if (layouts.length === 0) return null;
    // Blocks are in document order, so binary-search for the one containing pos
    // instead of scanning — this keeps coordsAtPos O(log n) on huge documents.
    let lo = 0,
      hi = layouts.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const block = layouts[mid];
      if (pos < block.pmStartPos) hi = mid - 1;
      else if (pos > block.pmEndPos) lo = mid + 1;
      else return this.offsetToCoordsInBlock(block, pos - block.pmStartPos);
    }
    // Between blocks (a boundary token) or out of range: fall back to the last
    // block's end, matching the previous linear scan's behavior.
    const last = layouts[layouts.length - 1];
    return this.offsetToCoordsInBlock(last, last.text.length);
  }

  private offsetToCoordsInBlock(
    block: BlockLayout,
    offsetInBlock: number,
  ): { x: number; y: number; height: number } {
    const lines = block.lines;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const isLast = i === lines.length - 1;
      const lineEnd = isLast ? block.text.length : lines[i + 1].pmStart;

      // A position exactly at this line's end boundary normally renders
      // here, but a +1 bias leans it onto the next line's start instead
      // (the two are the same PM offset across a soft wrap).
      const leansToNextLine =
        offsetInBlock === lineEnd && !isLast && this.caretBias === 1;

      if (!leansToNextLine && (offsetInBlock <= lineEnd || isLast)) {
        return {
          x: this.xForOffsetInLine(block, line, offsetInBlock),
          y: line.y,
          height: block.lineHeight,
        };
      }
    }

    return { x: 0, y: block.yOffset, height: block.lineHeight };
  }

  /**
   * Absolute x of a PM offset (within the block) on a given line. Dispatches
   * to the line's styled fragments (each measured in its own font) or, for a
   * plain line, a single measureText over the line text.
   */
  private xForOffsetInLine(
    block: BlockLayout,
    line: LineLayout,
    offsetInBlock: number,
  ): number {
    if (line.fragments) {
      for (const f of line.fragments) {
        const fEnd = f.pmStart + f.text.length;
        if (offsetInBlock <= f.pmStart) return line.x + f.x;
        if (offsetInBlock <= fEnd) {
          // An atom has no interior: its two positions are its two edges.
          if (f.atom)
            return line.x + f.x + (offsetInBlock > f.pmStart ? f.width : 0);
          this.measureCtx.font = f.font;
          const w = this.measureCtx.measureText(
            f.text.substring(0, offsetInBlock - f.pmStart),
          ).width;
          return line.x + f.x + w;
        }
      }
      const last = line.fragments[line.fragments.length - 1];
      if (!last) return line.x;
      // Past the last run: the offset is in collapsed trailing whitespace
      // (e.g. a space just typed at the end of a styled run). Pretext
      // dropped it from the run text, so advance the caret by the real
      // width of those characters — otherwise the caret looks "stuck".
      const lastEnd = last.pmStart + last.text.length;
      this.measureCtx.font = last.font;
      const trail = this.measureCtx.measureText(
        block.text.substring(lastEnd, offsetInBlock),
      ).width;
      return line.x + last.x + last.width + trail;
    }

    const offsetInLine = Math.max(
      0,
      Math.min(line.text.length, offsetInBlock - line.pmStart),
    );
    if (offsetInLine === 0) return line.x;
    this.measureCtx.font = block.font;
    return (
      line.x +
      this.measureCtx.measureText(line.text.substring(0, offsetInLine)).width
    );
  }

  private ensureCaretVisible(coords: {
    x: number;
    y: number;
    height: number;
  }): void {
    if (!this.scroller) return;
    const scrollTop = this.scroller.scrollTop;
    const viewH = this.scroller.clientHeight;
    const caretTop = coords.y;
    const caretBottom = coords.y + coords.height;
    if (caretTop < scrollTop) {
      this.scroller.scrollTop = caretTop;
    } else if (caretBottom > scrollTop + viewH) {
      this.scroller.scrollTop = caretBottom - viewH;
    }
  }

  /**
   * Draw the IME's in-flight composition at the caret, returning how wide it
   * was so the caret — and the IME's own candidate window, which tracks the
   * textarea — can sit after it rather than under it.
   *
   * The composing text is not in the layout, so this cannot reflow the line
   * around it the way a DOM editor does. What it can do is occupy the space
   * honestly: the page's own backdrop goes down first, so the preview occludes
   * whatever was painted to the right of the caret instead of blending into
   * it, and the underline marks the text as uncommitted the way every platform
   * does. A commit replaces it with real content that lays out properly.
   */
  private paintComposition(
    coords: { x: number; y: number; height: number } | null,
  ): number {
    if (!this.composing || !this.composingText || !coords) return 0;
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return 0;

    // The block at the caret, so a composition in a heading is drawn at the
    // heading's size rather than the editor's base font.
    const $head = this.state.doc.resolve(this.state.selection.head);
    const style = this.resolveBlockStyle($head.parent);
    const text = this.composingText;
    const width = this.measureWidth(text, style.font);

    ctx.fillStyle = this.backdropColor();
    ctx.fillRect(coords.x, coords.y, width, coords.height);

    ctx.font = style.font;
    ctx.textBaseline = "top";
    ctx.fillStyle = style.color ?? this.textColor;
    ctx.fillText(text, coords.x, coords.y);

    // Uncommitted-text underline, sat on the bottom of the line box.
    ctx.fillRect(coords.x, coords.y + coords.height - 1, width, 1);
    return width;
  }

  private paintCaret(
    coords: { x: number; y: number; height: number } | null,
  ): void {
    if (!this.caretVisible) return;
    // An unfocused editor has no caret. With one editor on a page a stray caret
    // merely looked odd; put several on one surface — a board, a comment
    // thread, a grid of cards — and every one of them blinks at once.
    if (!this.hasFocus()) return;
    const ctx = this.canvas.getContext("2d")!;
    const sel = this.state.selection;
    // Gap cursor: a horizontal bar across the seam between two blocks.
    if (sel instanceof GapCursor) {
      ctx.fillStyle = this.caretColor;
      ctx.fillRect(
        0,
        this.gapCursorY(sel.$from.pos) - 1,
        this.containerWidth,
        2,
      );
      return;
    }
    if (!coords || !sel.empty) return;
    ctx.fillStyle = this.caretColor;
    ctx.fillRect(coords.x, coords.y, this.caretWidth, coords.height);
  }

  /**
   * Where a drag would land: a bar across the seam for a node move (the same
   * place, and the same look, as a gap cursor between those two blocks), or a
   * caret for an external drop that inserts at a text position.
   */
  private paintDropIndicator(): void {
    const target = this.dropTarget;
    if (!target) return;
    const ctx = this.canvas.getContext("2d")!;
    ctx.fillStyle = this.dropIndicatorColor;
    if (target.seam) {
      ctx.fillRect(
        0,
        this.gapCursorY(target.pos) - 1,
        this.containerWidth,
        2,
      );
      return;
    }
    const coords = this.posToCoords(this.lastLayouts, target.pos);
    if (coords)
      ctx.fillRect(coords.x, coords.y, this.caretWidth, coords.height);
  }

  // ─── Click → Doc Position ──────────────────────────────────────────

  /**
   * Map a mouse event to document-space canvas coords. When virtualized the
   * canvas is pinned to the viewport, so its rect is viewport-relative —
   * adding scrollTop recovers the document Y. scrollTop is 0 otherwise.
   *
   * Measured fresh rather than read from the cache: this runs once per pointer
   * gesture, not per keystroke, so the layout read costs nothing anyone can
   * feel, and a press must land where the user aimed even if the editor was
   * moved or zoomed since the last frame.
   */
  private eventToDocCoords(e: {
    clientX: number;
    clientY: number;
  }): { x: number; y: number } {
    const g = this.readGeometry();
    const y = (e.clientY - g.top) / g.scaleY + (this.scroller?.scrollTop ?? 0);
    return {
      x: (e.clientX - g.left) / g.scaleX,
      // Mid-transition, what is under the pointer is where it is drawn.
      y: this.transitions.presentation.unmapY(y),
    };
  }

  /**
   * Whether a block owns the given x within its vertical band. In-flow blocks
   * span the full column, so they always do. A floated node is the exception:
   * it occupies a band but only part of the width, and text flows beside it at
   * the same y — so claiming the whole band would put the caret before the
   * float every time you clicked the text next to it.
   */
  private claimsX(b: BlockLayout, canvasX: number): boolean {
    const fr = b.floatRect;
    if (fr) return canvasX >= fr.x && canvasX < fr.x + fr.width;
    // A table cell's block owns only its column of the row's band. Same
    // reasoning as a float, arrived at from the other direction: blocks that
    // share a vertical band must be told apart by x.
    const f = b.frame;
    if (f) return canvasX >= f.x && canvasX < f.x + f.width;
    return true;
  }

  private clickToPos(
    layouts: BlockLayout[],
    canvasX: number,
    canvasY: number,
  ): { pos: number; bias: -1 | 1 } | null {
    if (layouts.length === 0) return null;

    let block: BlockLayout | null = null;
    for (const b of layouts) {
      if (canvasY >= b.yOffset && canvasY < b.yOffset + b.height) {
        if (!this.claimsX(b, canvasX)) continue;
        block = b;
        break;
      }
    }
    if (!block) {
      // canvasY landed in an inter-block gap (or past either end). Snap
      // to the vertically nearest block — defaulting to the last block
      // would teleport the caret to the end of the document whenever a
      // click or drag crossed the gap between two paragraphs.
      let bestDist = Infinity;
      for (const b of layouts) {
        if (!this.claimsX(b, canvasX)) continue;
        const dist =
          canvasY < b.yOffset
            ? b.yOffset - canvasY
            : canvasY - (b.yOffset + b.height);
        if (dist < bestDist) {
          bestDist = dist;
          block = b;
        }
      }
      block = block ?? layouts[layouts.length - 1];
    }

    // Atom block (no text lines): place the caret just before it.
    if (block.lines.length === 0) return { pos: block.pmStartPos, bias: -1 };

    let lineIdx = 0;
    for (let i = 0; i < block.lines.length; i++) {
      if (
        canvasY >= block.lines[i].y &&
        canvasY < block.lines[i].y + block.lineHeight
      ) {
        lineIdx = i;
        break;
      }
      if (i === block.lines.length - 1) lineIdx = i;
    }
    const line = block.lines[lineIdx];
    if (line.text.length === 0) return { pos: block.pmStartPos, bias: -1 };

    const targetX = Math.max(0, canvasX - line.x);
    const offsetInBlock = Math.min(
      block.text.length,
      this.hitTestX(block, line, targetX),
    );

    // When the click lands at the very start of a wrapped line (not the
    // first line of the block), that offset is shared with the previous
    // line's end — bias +1 so the caret renders on the line clicked, not
    // the one above. Every other case keeps the default -1.
    const bias: -1 | 1 = lineIdx > 0 && offsetInBlock === line.pmStart ? 1 : -1;

    return { pos: block.pmStartPos + offsetInBlock, bias };
  }

  /**
   * The PM offset (within the block) nearest to a horizontal position on a
   * line. Snaps to grapheme boundaries. For styled lines it finds the
   * fragment under `targetX` (or the nearest one across a gap) and hit-tests
   * within it using that run's font.
   */
  /** Offset within one fragment nearest to `dx` px from its left edge. An
   *  atom snaps to whichever of its two edges is nearer. */
  private hitTestFragment(f: LineFragment, dx: number): number {
    if (f.atom) return dx < f.width / 2 ? 0 : 1;
    return hitTestInText(this.measureCtx, this.segmenter, f.text, f.font, dx);
  }

  /**
   * The document position of the inline atom whose box contains the
   * document-space point, or null. A click there selects the node, as it
   * does in prosemirror-view, rather than dropping a caret beside it.
   */
  private inlineAtomAt(x: number, y: number): number | null {
    for (const block of this.lastLayouts) {
      if (y < block.yOffset || y >= block.yOffset + block.height) continue;
      for (const line of block.lines) {
        if (!line.fragments) continue;
        if (y < line.y || y >= line.y + block.lineHeight) continue;
        for (const f of line.fragments) {
          if (!f.atom) continue;
          const left = line.x + f.x;
          if (x >= left && x < left + f.width) return block.pmStartPos + f.pmStart;
        }
      }
    }
    return null;
  }

  private hitTestX(
    block: BlockLayout,
    line: LineLayout,
    targetX: number,
  ): number {
    if (line.fragments) {
      const frags = line.fragments;
      if (frags.length === 0) return line.pmStart;
      if (targetX <= frags[0].x) {
        return frags[0].pmStart + this.hitTestFragment(frags[0], targetX - frags[0].x);
      }
      for (let i = 0; i < frags.length; i++) {
        const f = frags[i];
        const right = f.x + f.width;
        if (targetX <= right) {
          if (targetX < f.x) {
            // In the collapsed-whitespace gap between two runs —
            // snap to whichever boundary is nearer.
            const prev = frags[i - 1];
            const mid = (prev.x + prev.width + f.x) / 2;
            return targetX < mid ? prev.pmStart + prev.text.length : f.pmStart;
          }
          return f.pmStart + this.hitTestFragment(f, targetX - f.x);
        }
      }
      const last = frags[frags.length - 1];
      return last.pmStart + last.text.length;
    }

    return (
      line.pmStart +
      hitTestInText(
        this.measureCtx,
        this.segmenter,
        line.text,
        block.font,
        targetX,
      )
    );
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
  private linkHrefAt(pos: number): string | null {
    const linkType = this.state.schema.marks[this.linkMark];
    if (!linkType) return null;
    const $pos = this.state.doc.resolve(
      clamp(pos, 0, this.state.doc.content.size),
    );
    const mark =
      ($pos.nodeAfter ? linkType.isInSet($pos.nodeAfter.marks) : undefined) ??
      ($pos.nodeBefore ? linkType.isInSet($pos.nodeBefore.marks) : undefined);
    return mark ? (mark.attrs["href"] as string) : null;
  }

  // ─── Render Loop ───────────────────────────────────────────────────

  /**
   * Drop every cached layout of one textblock, so the next pass breaks its
   * lines again: the geometry cache, the positional cache, and its entry in
   * `lastLayouts`, which positional reuse checks by index before the cache.
   */
  private forgetBlockLayout(node: PMNode): void {
    this.layoutCache.delete(node);
    this.positionedCache.delete(node);
    this.lastLayouts = this.lastLayouts.filter((b) => b.node !== node);
  }

  /**
   * Force the next layout to be a full pass, and schedule it. The incremental
   * path finds what changed by diffing documents, so it can't see a change to
   * one of layout's other inputs — a node view's measured size, a web font
   * arriving — and would keep the stale layout.
   */
  private relayout(): void {
    this.prevDoc = null;
    this.layoutDirty = true;
    this.scheduleRender();
  }

  private scheduleRender(): void {
    if (this.pendingRender) return;
    this.pendingRender = true;
    requestAnimationFrame(() => {
      this.pendingRender = false;
      this.render();
    });
  }

  /**
   * Recompute layout and repaint *synchronously*, instead of waiting for the
   * next animation frame. After this, `coordsAtPos` reflects the current
   * document. Mirrors the intent of `EditorView.updateState`'s synchronous
   * DOM write — useful when measuring, or when reading caret coordinates
   * immediately after a `dispatch`.
   */
  flush(): void {
    this.pendingRender = false;
    this.render();
  }

  /**
   * Recompute layout if a dispatch dirtied it; otherwise reuse the cached
   * result. Layout only (no paint) — paint stays on the animation frame. This
   * is what lets `coordsAtPos` answer immediately after a keystroke without
   * forcing a repaint.
   */
  private ensureLayout(): void {
    if (!this.layoutDirty) return;
    // Try the cheap incremental path (single-block edit); fall back to a full
    // pass for anything structural.
    if (!this.tryIncrementalLayout()) {
      const { layouts, totalHeight, tables, containers } = this.computeLayout();
      this.lastLayouts = layouts;
      this.lastTotalHeight = totalHeight;
      this.lastTables = tables;
      this.lastContainers = containers;
    }
    this.prevDoc = this.state.doc;
    this.layoutDirty = false;
  }

  private render(): void {
    const t0 = performance.now();

    this.layoutDirty = true; // a frame always reflects the latest document
    this.ensureLayout();
    const layouts = this.lastLayouts;
    // Mid-transition the picture is taller or shorter than the layout; the
    // canvas and the scroll height follow the picture.
    const shown = this.presentTransitions();
    const totalHeight = this.lastTotalHeight + shown.offset;

    // Virtualize only when the scroller has a measurable viewport. In
    // headless/zero-height environments we fall back to painting the
    // whole document (the canvas is sized to totalHeight).
    const virtualized =
      this.scroller !== null && this.scroller.clientHeight > 0;
    this.applyVirtualLayout(virtualized, totalHeight);

    const caretCoords = this.posToCoords(layouts, this.state.selection.head);

    // Adjust the scroll position before painting so the visible slice we
    // draw already reflects where the caret needs to be — but only when the
    // caret actually moved. Renders from scrolling or blinking must not
    // fight the user's scroll position.
    if (caretCoords && this.scrollCaretIntoView) {
      this.ensureCaretVisible(caretCoords);
      this.scrollCaretIntoView = false;
    }

    const decorations = this.decorationsFor
      ? this.decorationsFor(this.state)
      : [];
    this.paintToCanvas(layouts, totalHeight, virtualized, decorations);
    // The composition preview sits between the text and the caret: it paints
    // over the line, and the caret belongs after it.
    const composingWidth = this.paintComposition(caretCoords);
    this.paintCaret(
      caretCoords && composingWidth
        ? { ...caretCoords, x: caretCoords.x + composingWidth }
        : caretCoords,
    );
    this.paintDropIndicator();
    this.paintedTop = virtualized ? this.scroller!.scrollTop : 0;
    if (shown.active) {
      this.compositeTransitions(shown, layouts, decorations);
    }
    this.syncNodeViews(layouts);
    this.syncInlineViews(layouts);
    this.syncContainerHeaders();
    this.syncWidgets(layouts, decorations);
    this.syncSelectionHandles();
    this.displaceOverlays(shown);
    if (shown.active) this.scheduleRender();

    if (caretCoords) {
      // Past the preview too, so the IME's candidate window sits under the end
      // of what is being composed rather than under its start.
      this.textarea.style.transform =
        `translate(${caretCoords.x + composingWidth}px, ${shown.mapY(caretCoords.y).y}px)`;
    }

    // Refresh the cached canvas offset + scroll position once per frame (layout
    // is already being touched here), so coordsAtPos never reads layout on the
    // hot path — which would force a synchronous layout of the a11y mirror.
    this.canvasRectCache = this.readGeometry();
    if (this.scroller) this.lastScrollTop = this.scroller.scrollTop;

    const dt = performance.now() - t0;

    this.onRender?.({
      blockCount: layouts.length,
      lineCount: layouts.reduce((sum, b) => sum + b.lines.length, 0),
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
      renderTimeMs: dt,
    });
  }

  // ─── Collapse / expand transitions ──────────────────────────────────

  /**
   * Advance container transitions to this frame (see ./box-transition). Layout
   * is already final; this works out how the picture is displaced from it.
   */
  private presentTransitions(): Presentation {
    if (!this.hasCollapsible()) return this.transitions.presentation;
    return this.transitions.frame(
      this.lastContainers,
      (c) => this.transitionMs(c),
      () => this.snapshotCanvas(),
    );
  }

  /** How long a toggle of this container animates; 0 for not at all. */
  private transitionMs(c: ContainerChrome): number {
    const spec = this.containerNodes[c.node.type.name];
    const ms = spec?.animate ?? DEFAULT_TRANSITION_MS;
    if (!ms) return 0;
    if (
      typeof matchMedia === "function" &&
      matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return 0;
    // The picture moves in full-width bands, which is only right in a
    // vertical flow: in a table cell, neighbours sit beside the box.
    const doc = this.state.doc;
    for (const t of this.lastTables) {
      const table = doc.nodeAt(t.pos);
      if (table && c.pos > t.pos && c.pos < t.pos + table.nodeSize) return 0;
    }
    // A float stays put while the flow around it slides, so one level with
    // or below the box would be drawn in the wrong place. One above it is
    // untouched by the transition.
    if (this.activeFloats.some((f) => f.y + f.height > c.y)) return 0;
    return ms;
  }

  /** A copy of what is on screen now, before this frame repaints it. */
  private snapshotCanvas(): Snapshot | null {
    const { width, height } = this.canvas;
    if (width === 0 || height === 0) return null;
    const copy = document.createElement("canvas");
    copy.width = width;
    copy.height = height;
    const ctx = copy.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(this.canvas, 0, 0);
    return {
      image: copy,
      top: this.paintedTop,
      scale: window.devicePixelRatio || 1,
    };
  }

  /**
   * Rebuild the canvas for a transition frame. The canvas now holds the final
   * layout, painted as usual (caret and all); recompose it from bands of that
   * and the snapshots, as `planComposite` lays out.
   */
  private compositeTransitions(
    shown: Presentation,
    layouts: BlockLayout[],
    decorations: Decoration[],
  ): void {
    const canvas = this.canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx || canvas.width === 0 || canvas.height === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const top = this.paintedTop;
    const height = canvas.height / dpr;

    const live = (this.liveCanvas ??= document.createElement("canvas"));
    live.width = canvas.width;
    live.height = canvas.height;
    live.getContext("2d")?.drawImage(canvas, 0, 0);
    const sources: Snapshot[] = [{ image: live, top, scale: dpr }];

    const ops = planComposite(shown, top, height);
    // An expanding box pulls up rows from below what was painted: paint
    // that strip of the final layout too.
    let need = top + height;
    for (const op of ops) if (op.source === "live") need = Math.max(need, op.to);
    if (need > top + height) {
      const strip = (this.stripCanvas ??= document.createElement("canvas"));
      const band = { top: top + height, height: Math.ceil(need - top - height) };
      this.paintToCanvas(layouts, band.top + band.height, true, decorations, {
        canvas: strip,
        ...band,
      });
      sources.push({ image: strip, top: band.top, scale: dpr });
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const op of ops) {
      for (const src of op.source === "live" ? sources : [op.source]) {
        // Each source covers rows [src.top, src.top + its height).
        const a = Math.max(op.from, src.top);
        const b = Math.min(op.to, src.top + src.image.height / src.scale);
        if (b <= a) continue;
        ctx.drawImage(
          src.image,
          0, (a - src.top) * src.scale, src.image.width, (b - a) * src.scale,
          0, (op.dest + (a - op.from) - top) * dpr, canvas.width, (b - a) * dpr,
        );
      }
    }
  }

  /**
   * DOM overlays (node views, chips, headers, widgets, handles) are placed in
   * final-layout coordinates; mid-transition, move each to where its row is
   * drawn, and hide those in the part of a box not revealed yet. A CSS
   * `translate` leaves `top` and any `transform` of their own alone.
   */
  private displaceOverlays(shown: Presentation): void {
    if (!shown.active && !this.overlaysDisplaced) return;
    const els: HTMLElement[] = [];
    for (const v of this.mountedViews.values()) els.push(v.container);
    for (const list of this.inlineViews.values())
      for (const v of list) els.push(v.container);
    for (const h of this.headerViews) els.push(h.view.container);
    for (const el of this.mountedWidgets.values()) els.push(el);
    if (this.selHandles) els.push(this.selHandles.from, this.selHandles.to);
    for (const el of els) {
      const y = parseFloat(el.style.top);
      const at = shown.active && !Number.isNaN(y) ? shown.mapY(y) : null;
      el.style.translate = at && at.y !== y ? `0 ${at.y - y}px` : "";
      el.style.visibility = at?.hidden ? "hidden" : "";
    }
    this.overlaysDisplaced = shown.active;
  }

  // ─── Node views ────────────────────────────────────────────────────

  /**
   * Mount/position/destroy the DOM elements for atom blocks. Positioned in
   * document space inside the stack (so they scroll with content); their
   * measured height is fed back into layout via nodeViewHeights.
   */
  private syncNodeViews(layouts: BlockLayout[]): void {
    const present = new Set<PMNode>();
    for (const block of layouts) {
      // Atom blocks without a registered node view (e.g. canvas-drawn
      // horizontal rules) are painted directly, not mounted as DOM.
      if (!block.isAtom || !this.nodeViews[block.type]) continue;
      present.add(block.node);

      let view = this.mountedViews.get(block.node);
      if (!view) {
        view = this.createNodeView(block.node, block.pmStartPos);
        this.mountedViews.set(block.node, view);
      }
      view.pos = block.pmStartPos;
      // Floating nodes sit at their rect; in-flow ones span the content.
      const fr = block.floatRect;
      view.container.style.left = `${fr ? fr.x : 0}px`;
      view.container.style.top = `${fr ? fr.y : block.yOffset}px`;
      view.container.style.width = `${fr ? fr.width : this.containerWidth}px`;

      // Reserve the element's real height; re-layout once when it changes.
      const measured = view.container.offsetHeight;
      if (measured > 0 && this.nodeViewHeights.get(block.node) !== measured) {
        this.nodeViewHeights.set(block.node, measured);
        this.relayout();
      }
    }

    for (const [node, view] of this.mountedViews) {
      if (present.has(node)) continue;
      view.resizeObserver?.disconnect();
      view.container.remove();
      this.mountedViews.delete(node);
      this.nodeViewHeights.delete(node);
    }
  }

  /**
   * Mount/position/destroy the DOM for inline atoms whose spec has `render`.
   * Each element covers exactly the box the line breaker reserved, so the
   * DOM and the text around it can't drift apart.
   *
   * With no fixed `width` in the spec, the element sizes itself and its
   * measured width is fed back into layout: the line is broken again around
   * the real box, as block node views feed back their height.
   */
  private syncInlineViews(layouts: BlockLayout[]): void {
    if (this.inlineViews.size === 0 && !this.hasInlineRender()) return;
    const seen = new Map<PMNode, number>();
    const live = new Set<MountedView>();
    // Measured after every element is placed, so the reads don't interleave
    // with the writes and force a browser layout per atom.
    const toMeasure: { view: MountedView; node: PMNode; block: PMNode; reserved: number }[] = [];
    for (const block of layouts) {
      for (const line of block.lines) {
        if (!line.fragments) continue;
        for (const f of line.fragments) {
          if (!f.atom?.dom) continue;
          const node = f.atom.node;
          const spec = this.inlineNodes[node.type.name];
          if (!spec?.render) continue;
          const i = seen.get(node) ?? 0;
          seen.set(node, i + 1);
          let list = this.inlineViews.get(node);
          if (!list) {
            list = [];
            this.inlineViews.set(node, list);
          }
          const pos = block.pmStartPos + f.pmStart;
          let view = list[i];
          if (!view) {
            view = this.createNodeView(node, pos, spec.render, false);
            list.push(view);
          }
          view.pos = pos;
          const r = atomPillRect(line.y, block.fontSize, block.lineHeight);
          const st = view.container.style;
          st.left = `${line.x + f.x}px`;
          st.top = `${r.y}px`;
          st.height = `${r.height}px`;
          if (spec.width) {
            st.width = `${f.width}px`;
          } else {
            st.width = "max-content";
            toMeasure.push({ view, node, block: block.node, reserved: f.width });
          }
          live.add(view);
        }
      }
    }
    let changed = false;
    for (const { view, node, block, reserved } of toMeasure) {
      const measured = Math.ceil(view.container.getBoundingClientRect().width);
      // Zero means not rendered (detached, display: none, a test DOM).
      if (measured <= 0 || measured === reserved) continue;
      this.inlineWidths.set(node, measured);
      // The paragraph's cached line breaks assumed the old width.
      this.forgetBlockLayout(block);
      changed = true;
    }
    if (changed) this.relayout();

    for (const [node, list] of this.inlineViews) {
      const keep = list.filter((v) => live.has(v));
      for (const v of list) if (!live.has(v)) v.container.remove();
      if (keep.length > 0) {
        this.inlineViews.set(node, keep);
      } else {
        this.inlineViews.delete(node);
        this.inlineWidths.delete(node);
      }
    }
  }

  /**
   * Mount/position/destroy header DOM for containers whose spec has
   * `renderHeader`. Matched by type in document order; a header is reused
   * while its node keeps the same markup and rebuilt when the attrs change.
   */
  private syncContainerHeaders(): void {
    const prev = this.headerViews;
    if (prev.length === 0 && !this.hasHeaderRender()) return;
    const pool = new Map<string, { node: PMNode; view: MountedView }[]>();
    for (const h of prev) {
      const list = pool.get(h.node.type.name) ?? [];
      list.push(h);
      pool.set(h.node.type.name, list);
    }
    const next: { node: PMNode; view: MountedView }[] = [];
    for (const c of this.lastContainers) {
      const spec = this.containerNodes[c.node.type.name];
      if (!spec?.renderHeader || c.header <= 0) continue;
      let h = pool.get(c.node.type.name)?.shift();
      if (h && !h.node.sameMarkup(c.node)) {
        h.view.container.remove();
        h = undefined;
      }
      if (!h) {
        h = {
          node: c.node,
          view: this.createNodeView(c.node, c.pos, spec.renderHeader, false),
        };
      }
      h.node = c.node;
      h.view.pos = c.pos;
      const st = h.view.container.style;
      st.left = `${c.x}px`;
      st.top = `${c.y}px`;
      st.width = `${c.width}px`;
      st.height = `${c.header}px`;
      next.push(h);
    }
    for (const list of pool.values())
      for (const h of list) h.view.container.remove();
    this.headerViews = next;
  }

  private hasHeaderRender(): boolean {
    for (const k in this.containerNodes)
      if (this.containerNodes[k].renderHeader) return true;
    return false;
  }

  private hasInlineRender(): boolean {
    for (const k in this.inlineNodes) if (this.inlineNodes[k].render) return true;
    return false;
  }

  private createNodeView(
    node: PMNode,
    pos: number,
    build: NodeViewFn = this.nodeViews[node.type.name],
    observeSize = true,
  ): MountedView {
    const container = document.createElement("div");
    container.style.position = "absolute";
    container.style.zIndex = "1";
    // A container's box is often wider/taller than the node view inside it
    // (an in-flow image narrower than the column, a floated node, reserved
    // atom height). Its empty area must not swallow clicks, drags, or hovers
    // meant for the text — or another node — behind it. Only the node view's
    // own element is interactive.
    container.style.pointerEvents = "none";
    // Dragging the node has to win the vertical swipe on touch; with the
    // scroller's pan gesture in play the pointer stream is cancelled instead.
    // Set on the container rather than the view: touch-action is resolved up
    // the DOM ancestor chain from the hit element, so this still governs
    // touches landing on the view despite the container being unhittable.
    if (this.dragDrop) container.style.touchAction = "none";
    const view: MountedView = {
      container,
      dom: container,
      pos,
      resizeObserver: null,
    };
    view.dom = build(node, () => view.pos);
    view.dom.style.pointerEvents = "auto";
    // The stack turns DOM text selection off (its own selection is
    // ProseMirror's), but a node view is the consumer's DOM and may well hold
    // text worth selecting — a code snippet, a caption — so it opts back in.
    view.dom.style.userSelect = "text";
    (view.dom.style as unknown as Record<string, string>).webkitUserSelect =
      "text";
    container.appendChild(view.dom);
    this.stack.appendChild(container);

    // Avoid the screen reader reading this atom twice: the structural mirror
    // already represents it in document order. A non-interactive view (e.g.
    // an image) is hidden here so only the mirror is read; an interactive one
    // (buttons/links) stays exposed because the mirror can't operate it.
    const interactive =
      view.dom.matches?.(FOCUSABLE_SEL) ||
      !!view.dom.querySelector?.(FOCUSABLE_SEL);
    if (this.a11yMirror && !interactive)
      container.setAttribute("aria-hidden", "true");

    // Pressing the view selects its node. Bound to the view element, not the
    // container, so the container's empty area stays click-through
    // (pointer-events: none above).
    view.dom.addEventListener(
      "mousedown",
      (e) => {
        // A press on a control inside the view (a toggle, a link, an input)
        // is the control's: no selection change, and no preventDefault, so it
        // can take focus. The consumer can't opt out of this listener with
        // stopPropagation when the control *is* the view's root element, so
        // the editor has to recognise controls itself.
        const target = e.target as Element | null;
        const control = target?.closest?.(FOCUSABLE_SEL);
        if (control && view.dom.contains(control)) return;
        e.preventDefault();
        this.dispatch(
          this.state.tr.setSelection(
            NodeSelection.create(this.state.doc, view.pos),
          ),
        );
        this.textarea.focus();
      },
      { signal: this.abortController?.signal },
    );
    // Block views feed their measured height back into layout; an inline
    // view's box is fixed by its spec, so there is nothing to observe.
    if (observeSize && typeof ResizeObserver !== "undefined") {
      view.resizeObserver = new ResizeObserver(() => this.scheduleRender());
      view.resizeObserver.observe(container);
    }
    return view;
  }

  // ─── Input Handling ────────────────────────────────────────────────

  private setupInput(): void {
    const ac = new AbortController();
    this.abortController = ac;
    const signal = ac.signal;

    // Web fonts often finish loading after construction (document.fonts.ready
    // can resolve before a font is even requested). Cached marked-block
    // geometry is measured at layout time, so drop the cache and repaint
    // when fonts settle — otherwise marked runs keep fallback-font metrics.
    if (typeof document !== "undefined" && document.fonts) {
      const onFontsLoaded = () => {
        this.layoutCache = new WeakMap();
        this.positionedCache = new WeakMap();
        this.widthCache.clear();
        this.relayout();
      };
      document.fonts.ready.then(onFontsLoaded);
      document.fonts.addEventListener("loadingdone", onFontsLoaded, { signal });
    }

    this.textarea.addEventListener(
      "compositionstart",
      () => {
        this.composing = true;
        this.composingText = "";
      },
      { signal },
    );

    // Every revision of the in-flight string. Without this the canvas shows
    // nothing at all until the composition commits: the text lives in a 1px
    // transparent textarea, so someone composing CJK, Korean or Vietnamese
    // would see the IME's candidate window but not a single character of what
    // they are actually writing.
    this.textarea.addEventListener(
      "compositionupdate",
      (e) => {
        this.composingText = (e as CompositionEvent).data ?? "";
        this.scheduleRender();
      },
      { signal },
    );

    this.textarea.addEventListener(
      "compositionend",
      (e) => {
        this.composing = false;
        this.composingText = "";
        if (e.data) this.dispatch(this.state.tr.insertText(e.data));
        this.textarea.value = "";
        // The preview is gone and the committed text is in; if `insertText`
        // above dispatched, that already scheduled a paint, but an empty
        // commit (the user cancelled) still has a stale preview to clear.
        if (!e.data) this.scheduleRender();
      },
      { signal },
    );

    this.textarea.addEventListener(
      "input",
      (e) => {
        const ie = e as InputEvent;
        if (this.composing || ie.isComposing) return;

        switch (ie.inputType) {
          case "insertText":
          case "insertFromPaste":
          case "insertFromDrop":
          case "insertReplacementText":
            if (!ie.data) break;
            // Typing at a gap cursor starts a new paragraph in the seam.
            if (this.state.selection instanceof GapCursor)
              this.insertAtGap(ie.data);
            else this.dispatch(this.state.tr.insertText(ie.data));
            break;

          case "insertCompositionText":
            break;

          case "insertParagraph":
          case "insertLineBreak":
            this.splitBlock();
            break;

          case "deleteContentBackward":
          case "deleteWordBackward":
          case "deleteByCut":
            this.deleteBackward();
            break;

          case "deleteContentForward":
          case "deleteWordForward":
            this.deleteForward();
            break;
        }

        this.textarea.value = "";
      },
      { signal },
    );

    this.textarea.addEventListener(
      "keydown",
      (e) => {
        if (this.composing || e.isComposing) return;

        // Escape abandons a drag in progress (the node stays put).
        if (e.key === "Escape" && this.nodeDrag) {
          e.preventDefault();
          this.cancelNodeDrag();
          return;
        }

        // Consumer override: handled keys skip both keymap and built-ins.
        if (this.handlers.keyDown?.(this, e)) {
          e.preventDefault();
          return;
        }

        // Consumer key bindings (mark toggles, etc.) take precedence over
        // the built-in navigation/editing keys below.
        if (this.keymapHandler(e)) {
          e.preventDefault();
          return;
        }

        switch (e.key) {
          case "ArrowLeft":
            e.preventDefault();
            if (!this.gapNav("horiz", -1, e.shiftKey))
              this.moveSelection(-1, e.shiftKey);
            break;
          case "ArrowRight":
            e.preventDefault();
            if (!this.gapNav("horiz", 1, e.shiftKey))
              this.moveSelection(1, e.shiftKey);
            break;
          case "ArrowUp":
            e.preventDefault();
            if (!this.gapNav("vert", -1, e.shiftKey))
              this.moveVertical(-1, e.shiftKey);
            break;
          case "ArrowDown":
            e.preventDefault();
            if (!this.gapNav("vert", 1, e.shiftKey))
              this.moveVertical(1, e.shiftKey);
            break;
          case "Home":
            e.preventDefault();
            this.moveToBlockBoundary("start", e.shiftKey);
            break;
          case "End":
            e.preventDefault();
            this.moveToBlockBoundary("end", e.shiftKey);
            break;
          case "Enter":
            e.preventDefault();
            this.onEnter(e.shiftKey, e.metaKey || e.ctrlKey);
            break;
          case "Tab": {
            const itemType = this.listItemType();
            if (itemType) {
              e.preventDefault();
              this.command(
                e.shiftKey ? liftListItem(itemType) : sinkListItem(itemType),
              );
            }
            break;
          }
          case "Backspace":
            e.preventDefault();
            this.deleteBackward();
            break;
          case "Delete":
            e.preventDefault();
            this.deleteForward();
            break;
        }
      },
      { signal },
    );

    this.canvas.addEventListener(
      "mousedown",
      (e) => {
        if (e.button !== 0) return;
        const { x, y } = this.eventToDocCoords(e);
        const gapPos = this.gapPosForClick(y);
        const hit =
          gapPos === null ? this.clickToPos(this.lastLayouts, x, y) : null;
        const sel = this.state.selection;

        // Whether this press could become a native drag of the selection —
        // worked out before anything is suppressed, because `preventDefault` on
        // mousedown also stops the browser from ever *starting* a drag, and
        // handing content to another application is only possible through one.
        // Modifier presses are excluded: those mean extend or follow-link.
        const plain = !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey;
        const mayDragSelection =
          this.dragDrop && plain &&
          !sel.empty && hit !== null &&
          hit.pos > sel.from && hit.pos < sel.to;
        // An inline atom is selected and draggable in the same press, the way a
        // block node view is: the press can't be inside its selection first,
        // since the selection is a single position wide.
        const atomPos = !e.shiftKey && gapPos === null ? this.inlineAtomAt(x, y) : null;
        const mayDragAtom = this.dragDrop && plain && atomPos !== null;

        if (!mayDragSelection && !mayDragAtom) e.preventDefault();
        this.touchSelection = false; // mouse in use → hide touch handles

        // A click in a block seam (between stacked atoms) sets a gap cursor.
        if (gapPos !== null) {
          this.dispatch(
            this.state.tr.setSelection(
              new GapCursor(this.state.doc.resolve(gapPos)),
            ),
          );
          this.dragging = false;
          this.textarea.focus();
          return;
        }

        if (hit === null) return;

        // Consumer override (e.g. open a mention, toggle a checkbox).
        if (this.handlers.click?.(this, hit.pos, e)) {
          this.textarea.focus();
          return;
        }

        // Cmd/Ctrl-click follows a link instead of moving the caret.
        if (e.metaKey || e.ctrlKey) {
          const href = this.linkHrefAt(hit.pos);
          if (href !== null) {
            this.onFollowLink(href, e);
            return;
          }
        }

        // A plain click on an inline atom selects it, like a block atom.
        if (atomPos !== null) {
          this.dispatch(
            this.state.tr.setSelection(
              NodeSelection.create(this.state.doc, atomPos),
            ),
          );
          this.dragging = false;
          if (mayDragAtom) {
            // As below, but a press that doesn't become a drag keeps the
            // atom selected rather than collapsing to a caret.
            this.pressInSelection = atomPos;
            this.pressKeepsSelection = true;
            this.stack.draggable = true;
            this.textarea.focus({ preventScroll: true });
            return;
          }
          this.textarea.focus();
          return;
        }

        // A press inside the selection leaves it alone: the browser may be
        // about to start a drag of it, and the caret only moves once the press
        // turns out to be an ordinary click (see the mouseup below).
        if (mayDragSelection) {
          this.pressInSelection = hit.pos;
          this.stack.draggable = true;
          // `preventScroll` because this is the one branch that leaves the
          // browser's default in place: focusing the offscreen textarea while
          // the default is still live can otherwise scroll it into view.
          this.textarea.focus({ preventScroll: true });
          return;
        }

        this.setHead(hit.pos, e.shiftKey);
        this.caretBias = hit.bias;
        this.dragging = true;
        this.textarea.focus();
      },
      { signal },
    );

    // A press inside the selection that never became a drag is just a click:
    // collapse to where it landed. `draggable` is cleared either way, so the
    // editor doesn't stay draggable once the gesture is over.
    window.addEventListener(
      "mouseup",
      () => {
        if (this.pressInSelection === null) return;
        const pos = this.pressInSelection;
        const keep = this.pressKeepsSelection;
        this.pressInSelection = null;
        this.pressKeepsSelection = false;
        this.stack.draggable = false;
        if (!this.textDrag && !keep) this.setHead(pos, false);
      },
      { signal },
    );

    // Pointer cursor when a modifier-click would follow a link.
    this.canvas.addEventListener(
      "mousemove",
      (e) => {
        if (this.dragging) return;
        let overLink = false;
        if (e.metaKey || e.ctrlKey) {
          const { x, y } = this.eventToDocCoords(e);
          const hit = this.clickToPos(this.lastLayouts, x, y);
          overLink = hit !== null && this.linkHrefAt(hit.pos) !== null;
        }
        this.canvas.style.cursor = overLink ? "pointer" : "";
      },
      { signal },
    );

    window.addEventListener(
      "mousemove",
      (e) => {
        if (!this.dragging) return;
        const { x, y } = this.eventToDocCoords(e);
        const hit = this.clickToPos(this.lastLayouts, x, y);
        if (hit !== null) {
          this.setHead(hit.pos, true);
          this.caretBias = hit.bias;
        }
      },
      { signal },
    );

    window.addEventListener(
      "mouseup",
      () => {
        this.dragging = false;
      },
      { signal },
    );

    this.canvas.addEventListener(
      "dblclick",
      (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        this.dragging = false;
        const { x, y } = this.eventToDocCoords(e);
        const hit = this.clickToPos(this.lastLayouts, x, y);
        if (hit === null) return;
        if (this.handlers.doubleClick?.(this, hit.pos, e)) {
          this.textarea.focus();
          return;
        }
        const word = this.wordRangeAt(hit.pos);
        if (word) {
          const $a = this.state.doc.resolve(word.from);
          const $b = this.state.doc.resolve(word.to);
          this.dispatch(
            this.state.tr.setSelection(TextSelection.between($a, $b)),
          );
        }
        this.textarea.focus();
      },
      { signal },
    );

    // ── Touch input ──────────────────────────────────────────────────
    // A tap places the caret; a long-press selects the word (and shows
    // draggable handles); a swipe scrolls natively. Mouse events aren't used on
    // touch (we preventDefault the tap/selection to suppress the synthesized
    // click), so there's no double-handling.
    const LONG_PRESS_MS = 500;
    const TOUCH_MOVE_PX = 10;

    this.canvas.addEventListener(
      "touchstart",
      (e) => {
        if (e.touches.length !== 1) {
          this.cancelLongPress(); // pinch/second finger: bail out of caret intent
          this.touchMode = "scroll";
          return;
        }
        const t = e.touches[0];
        this.touchStartX = t.clientX;
        this.touchStartY = t.clientY;
        this.touchMoved = false;
        this.touchMode = "idle";
        this.cancelLongPress();
        this.longPressTimer = setTimeout(() => {
          this.longPressTimer = null;
          if (this.touchMoved) return;
          const { x, y } = this.eventToDocCoords({
            clientX: this.touchStartX,
            clientY: this.touchStartY,
          });
          if (this.beginTouchAtomDrag(x, y)) return;
          this.touchMode = "select";
          this.selectWordAt(x, y);
          this.touchSelection = true;
          this.textarea.focus({ preventScroll: true });
          this.showLoupe({ x, y });
          this.scheduleRender();
        }, LONG_PRESS_MS);
      },
      { signal, passive: true },
    );

    this.canvas.addEventListener(
      "touchmove",
      (e) => {
        if (e.touches.length !== 1) return;
        const t = e.touches[0];
        if (
          !this.touchMoved &&
          Math.hypot(t.clientX - this.touchStartX, t.clientY - this.touchStartY) >
            TOUCH_MOVE_PX
        ) {
          this.touchMoved = true;
          if (this.touchMode !== "select" && this.touchMode !== "atomDrag") {
            this.touchMode = "scroll";
            this.cancelLongPress();
          }
        }
        if (this.touchMode === "atomDrag") {
          e.preventDefault(); // the finger carries the atom, not the page
          this.moveTouchAtomDrag(t.clientX, t.clientY);
          return;
        }
        if (this.touchMode === "select") {
          // Long-press engaged: drag extends the selection, so suppress scroll.
          e.preventDefault();
          const { x, y } = this.eventToDocCoords(t);
          const hit = this.clickToPos(this.lastLayouts, x, y);
          if (hit) {
            this.setHead(hit.pos, true);
            this.caretBias = hit.bias;
            this.scheduleRender();
          }
          this.showLoupe({ x, y });
        }
        // Otherwise it's a scroll — let the browser handle it (touch-action).
      },
      { signal, passive: false },
    );

    this.canvas.addEventListener(
      "touchend",
      (e) => {
        const wasAtomDrag = this.touchMode === "atomDrag";
        const wasSelect = this.touchMode === "select";
        const wasScroll = this.touchMode === "scroll" || this.touchMoved;
        this.cancelLongPress();
        this.touchMode = "idle";
        this.showLoupe(null);
        if (wasAtomDrag) {
          e.preventDefault();
          this.endTouchAtomDrag();
          this.textarea.focus({ preventScroll: true });
          return;
        }
        if (wasSelect) {
          e.preventDefault(); // keep the selection + suppress synthesized click
          this.textarea.focus({ preventScroll: true });
          return;
        }
        if (wasScroll) {
          this.tapCount = 0; // a swipe breaks any multi-tap in progress
          return; // the browser already scrolled
        }
        // Quick tap → place the caret, unless it's the second or third of a
        // multi-tap, which escalate to the word and then the whole block.
        e.preventDefault();
        const { x, y } = this.eventToDocCoords({
          clientX: this.touchStartX,
          clientY: this.touchStartY,
        });
        if (this.registerTap()) {
          const hit = this.clickToPos(this.lastLayouts, x, y);
          if (hit && this.selectForTapCount(hit.pos)) {
            this.touchSelection = true;
            this.textarea.focus({ preventScroll: true });
            this.scheduleRender();
            return;
          }
        }
        const gapPos = this.gapPosForClick(y);
        if (gapPos !== null) {
          this.dispatch(
            this.state.tr.setSelection(
              new GapCursor(this.state.doc.resolve(gapPos)),
            ),
          );
        } else {
          const hit = this.clickToPos(this.lastLayouts, x, y);
          if (hit) {
            // Consumer override (mention, checkbox…) — same as a mouse click.
            if (this.handlers.click?.(this, hit.pos, e as unknown as MouseEvent)) {
              this.textarea.focus({ preventScroll: true });
              return;
            }
            // A tap on an inline atom selects it, as a click does.
            const atomPos = this.inlineAtomAt(x, y);
            if (atomPos !== null) {
              this.dispatch(
                this.state.tr.setSelection(
                  NodeSelection.create(this.state.doc, atomPos),
                ),
              );
              this.textarea.focus({ preventScroll: true });
              return;
            }
            this.setHead(hit.pos, false);
            this.caretBias = hit.bias;
          }
        }
        this.touchSelection = false; // collapsed caret → hide handles
        this.textarea.focus({ preventScroll: true });
      },
      { signal, passive: false },
    );

    // The system took the touch (a gesture, a call): abandon an atom drag
    // rather than leave its drop caret behind.
    this.canvas.addEventListener(
      "touchcancel",
      () => {
        if (this.touchMode !== "atomDrag") return;
        this.touchMode = "idle";
        this.touchAtomFrom = null;
        this.dropTarget = null;
        this.stopAutoScroll();
        this.scheduleRender();
      },
      { signal },
    );

    // ── Drag & drop ──────────────────────────────────────────────────
    // Moving a node runs on pointer events so mouse, touch, and pen share one
    // path — native HTML5 drag never fires on touch. Drops *into* the editor
    // are the other half, and those only exist as native drag events.
    if (this.dragDrop) {
      this.stack.addEventListener(
        "pointerdown",
        (e) => {
          // A node view running its own gesture (resize, custom drag) marks
          // the press handled; leave it alone.
          if (e.defaultPrevented || !this.isEditable) return;
          if (e.pointerType === "mouse" && e.button !== 0) return;
          const block = this.atomBlockForEvent(e);
          if (block) this.startNodeDrag(block.pmStartPos, e);
        },
        { signal },
      );
      // On window, not the stack: the pointer routinely leaves the editor
      // mid-drag (and touch's implicit capture still bubbles here).
      window.addEventListener(
        "pointermove",
        (e) => this.onNodeDragMove(e),
        { signal },
      );
      window.addEventListener("pointerup", (e) => this.onNodeDragEnd(e), {
        signal,
      });
      window.addEventListener("pointercancel", () => this.cancelNodeDrag(), {
        signal,
      });

      // Dragging a text selection is the one drag we *do* originate natively,
      // because native drag is the only way content can leave for another
      // application — a pointer-based gesture can never hand anything to
      // Finder, a mail client, or another tab. It also gets internal moves for
      // free, since a drop back inside is just this drag landing at home.
      //
      // Everything else the browser would drag natively (an <img> node view, a
      // link) is refused, because it would tear the pointer stream out from
      // under a node drag. A node view wanting its own can stopPropagation
      // before this bubble-phase listener.
      this.stack.addEventListener(
        "dragstart",
        (e) => {
          const de = e as DragEvent;
          const sel = this.state.selection;
          if (this.pressInSelection === null || sel.empty) {
            de.preventDefault();
            return;
          }
          const payload = this.selectionClipboard();
          if (!payload) {
            de.preventDefault();
            return;
          }
          this.textDrag = { from: sel.from, to: sel.to };
          this.textDragHandled = false;
          de.dataTransfer?.setData("text/plain", payload.text);
          de.dataTransfer?.setData("text/html", payload.html);
          // A read-only editor can still be dragged *from* — the same way it can
          // still be copied from — but only as a copy, so nothing downstream
          // reports back a "move" that this side would have to honour by
          // deleting. Otherwise both are offered and the drop target picks.
          if (de.dataTransfer) {
            de.dataTransfer.effectAllowed = this.isEditable ? "copyMove" : "copy";
          }
        },
        { signal },
      );

      this.stack.addEventListener(
        "dragend",
        (e) => {
          const de = e as DragEvent;
          const d = this.textDrag;
          this.textDrag = null;
          this.pressInSelection = null;
          this.pressKeepsSelection = false;
          this.stack.draggable = false;
          this.dropTarget = null;
          this.stopAutoScroll();
          this.scheduleRender();
          // Another application took the selection as a move, so this side has
          // to give it up. A drop back inside already moved it, and a cancelled
          // drag reports "none".
          if (
            d && !this.textDragHandled && this.isEditable &&
            de.dataTransfer?.dropEffect === "move"
          ) {
            this.dispatch(this.state.tr.delete(d.from, d.to));
          }
        },
        { signal },
      );

      // Claim the drag (both events, for Safari) so the browser doesn't open
      // the dropped file in place of the page.
      const allowDrop = (e: DragEvent) => {
        if (!this.isEditable) return;
        e.preventDefault();
        if (!e.dataTransfer) return;
        // Our own selection moves by default and copies with Alt, matching
        // every other editor; anything arriving from outside is a copy.
        e.dataTransfer.dropEffect =
          this.textDrag && !e.altKey ? "move" : "copy";
      };
      this.stack.addEventListener(
        "dragenter",
        (e) => allowDrop(e as DragEvent),
        { signal },
      );
      this.stack.addEventListener(
        "dragover",
        (e) => {
          const de = e as DragEvent;
          allowDrop(de);
          if (!this.isEditable) return;
          this.dropTarget = { pos: this.dropPosForEvent(de), seam: false };
          this.updateAutoScroll(de.clientX, de.clientY);
          this.scheduleRender();
        },
        { signal },
      );
      this.stack.addEventListener(
        "dragleave",
        (e) => {
          // Also fires when crossing onto a child (a node view); only a real
          // exit from the editor clears the indicator.
          const to = (e as DragEvent).relatedTarget as Node | null;
          if (to && this.stack.contains(to)) return;
          this.dropTarget = null;
          this.stopAutoScroll();
          this.scheduleRender();
        },
        { signal },
      );
      this.stack.addEventListener(
        "drop",
        (e) => {
          const de = e as DragEvent;
          this.dropTarget = null;
          this.stopAutoScroll();
          this.scheduleRender();
          if (!this.isEditable) return;
          de.preventDefault();
          // Our own selection landing back inside is a move within the
          // document, not a paste of its serialized form — which keeps it one
          // undo step and preserves nodes the clipboard round-trip would flatten.
          if (this.textDrag) {
            this.textDragHandled = true;
            this.moveSelectionTo(this.dropPosForEvent(de), de.altKey);
            return;
          }
          this.handleExternalDrop(de);
        },
        { signal },
      );
    }

    // Keep the caret above the on-screen keyboard: when the visual viewport
    // shrinks (keyboard opens), scroll the caret-tracking textarea into view.
    if (typeof window !== "undefined" && window.visualViewport) {
      window.visualViewport.addEventListener(
        "resize",
        () => {
          if (document.activeElement !== this.textarea) return;
          this.textarea.scrollIntoView({ block: "center", behavior: "smooth" });
        },
        { signal },
      );
    }

    // The canvas selection lives in ProseMirror, not the DOM, so the
    // browser would copy the (empty) textarea. Serialize the selection
    // ourselves. Cut additionally deletes the range.
    this.textarea.addEventListener(
      "copy",
      (e) => {
        const payload = this.selectionClipboard();
        if (!payload) return;
        e.preventDefault();
        e.clipboardData?.setData("text/plain", payload.text);
        // The same HTML a drag of this selection carries. Without it a copy is
        // plain text, so bold survived being dragged to another app but not
        // being copied there — and a copy/paste inside this very editor went
        // through plain text and came back stripped of every mark.
        if (payload.html) e.clipboardData?.setData("text/html", payload.html);
      },
      { signal },
    );

    this.textarea.addEventListener(
      "cut",
      (e) => {
        const payload = this.selectionClipboard();
        if (!payload) return;
        e.preventDefault();
        e.clipboardData?.setData("text/plain", payload.text);
        if (payload.html) e.clipboardData?.setData("text/html", payload.html);
        this.dispatch(this.state.tr.deleteSelection());
      },
      { signal },
    );

    // Rich paste: parse text/html through the schema's parseDOM rules so
    // bold/italic/links/headings survive; fall back to plain text (split on
    // blank lines into paragraphs). preventDefault stops the textarea's own
    // insert + the follow-up 'insertFromPaste' input event.
    this.textarea.addEventListener(
      "paste",
      (e) => {
        if (this.handlers.paste?.(this, e)) {
          e.preventDefault();
          return;
        }
        const cd = e.clipboardData;
        if (!cd) return;
        const html = cd.getData("text/html");
        const text = cd.getData("text/plain");
        if (!html && !text) return;
        e.preventDefault();
        if (html) this.pasteHTML(html);
        else this.pastePlainText(text);
      },
      { signal },
    );

    // Consumer-supplied DOM event handlers, bound on the container.
    for (const [name, fn] of Object.entries(this.handlers.domEvents ?? {})) {
      this.stack.addEventListener(
        name,
        (e) => {
          if (fn(this, e)) e.preventDefault();
        },
        { signal },
      );
    }

    // Repaint the visible slice as the user scrolls (virtualized mode). The
    // render refreshes the cached canvas offset, so we don't null it here —
    // nulling would push a getBoundingClientRect onto the next coordsAtPos read,
    // forcing a synchronous layout.
    this.scroller?.addEventListener(
      "scroll",
      () => {
        if (this.scroller) this.lastScrollTop = this.scroller.scrollTop;
        this.scheduleRender();
      },
      { signal },
    );

    // The canvas's viewport top-left only moves when the page scrolls or
    // reflows; a render (which refreshes the cached offset) is enough.
    if (typeof window !== "undefined") {
      const refresh = () => this.scheduleRender();
      window.addEventListener("scroll", refresh, {
        signal,
        passive: true,
        capture: true,
      });
      window.addEventListener("resize", refresh, { signal });
    }

    // preventScroll so mounting an editor mid-page doesn't jump the viewport.
    if (this.autofocus) this.textarea.focus({ preventScroll: true });
  }

  // ─── Drag & Drop ───────────────────────────────────────────────────

  /**
   * Track a live node drag. Below the threshold the press is still a click, so
   * nothing is disturbed until the pointer really travels; past it the drag
   * takes over from any text-selection drag the same press started.
   */
  private onNodeDragMove(e: PointerEvent): void {
    const d = this.nodeDrag;
    if (!d || e.pointerId !== d.pointerId) return;
    if (!d.active) {
      if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < DRAG_THRESHOLD_PX)
        return;
      d.active = true;
      this.dragging = false;
      this.cancelLongPress();
      this.stack.style.cursor = "grabbing";
    }
    const { y } = this.eventToDocCoords(e);
    const pos = this.seamPosAt(y);
    this.dropTarget = pos === null ? null : { pos, seam: true };
    this.updateAutoScroll(e.clientX, e.clientY);
    this.scheduleRender();
  }

  private onNodeDragEnd(e: PointerEvent): void {
    const d = this.nodeDrag;
    if (!d || e.pointerId !== d.pointerId) return;
    const target = d.active ? this.dropTarget : null;
    this.cancelNodeDrag();
    if (target) this.moveNode(d.from, target.pos);
  }

  private cancelNodeDrag(): void {
    this.stopAutoScroll();
    if (!this.nodeDrag) return;
    this.nodeDrag = null;
    this.dropTarget = null;
    this.stack.style.cursor = "text";
    this.scheduleRender();
  }

  // ─── Edge auto-scroll ──────────────────────────────────────────────

  /**
   * Follow a drag that has reached the top or bottom of a `maxHeight` scroller.
   *
   * Without this a drag can only reach as far as the viewport already shows,
   * which on a virtualized document means most of it is unreachable. Speed
   * ramps with depth into the band so a drag can creep or race, and the whole
   * thing is inert when the editor isn't scrolling anything.
   */
  private updateAutoScroll(clientX: number, clientY: number): void {
    this.lastDragClientX = clientX;
    this.lastDragClientY = clientY;
    const sc = this.scroller;
    if (!sc) return;
    const r = sc.getBoundingClientRect();
    const zone = Math.min(AUTOSCROLL_ZONE_PX, r.height / 3);
    let ramp = 0;
    if (clientY < r.top + zone) ramp = -(1 - (clientY - r.top) / zone);
    else if (clientY > r.bottom - zone) ramp = 1 - (r.bottom - clientY) / zone;
    this.autoScrollDy = clamp(ramp, -1, 1) * AUTOSCROLL_SPEED_PX;
    if (this.autoScrollDy !== 0) this.startAutoScroll();
    else this.stopAutoScroll();
  }

  private startAutoScroll(): void {
    if (this.autoScrollRaf) return;
    const step = (): void => {
      this.autoScrollRaf = 0;
      const sc = this.scroller;
      if (!sc || this.autoScrollDy === 0) return;
      const before = sc.scrollTop;
      sc.scrollTop = before + this.autoScrollDy;
      // Already at an end: stop rather than spin a frame loop forever.
      if (sc.scrollTop === before) return;
      // The pointer hasn't moved but the document under it has, so the drop
      // target is now somewhere else.
      this.refreshDropTargetForAutoScroll();
      this.autoScrollRaf = requestAnimationFrame(step);
    };
    this.autoScrollRaf = requestAnimationFrame(step);
  }

  private stopAutoScroll(): void {
    if (this.autoScrollRaf) cancelAnimationFrame(this.autoScrollRaf);
    this.autoScrollRaf = 0;
    this.autoScrollDy = 0;
  }

  /** Recompute the drop indicator against the last pointer position after the
   *  view scrolled under it. */
  private refreshDropTargetForAutoScroll(): void {
    if (!this.dropTarget) return;
    const { x, y } = this.eventToDocCoords({
      clientX: this.lastDragClientX,
      clientY: this.lastDragClientY,
    });
    if (this.nodeDrag?.active) {
      const pos = this.seamPosAt(y);
      this.dropTarget = pos === null ? null : { pos, seam: true };
    } else {
      const hit = this.clickToPos(this.lastLayouts, x, y);
      if (hit) this.dropTarget = { pos: hit.pos, seam: false };
    }
    this.scheduleRender();
  }

  /**
   * The leaf/atom block a pointer press lands on, or null. The event target
   * settles it whenever a node view is under the pointer (exact, and immune to
   * a view that overflows its reserved box); canvas-drawn atoms (rules) fall
   * back to the layout's boxes.
   */
  private atomBlockForEvent(e: PointerEvent): BlockLayout | null {
    const target = e.target as Node | null;
    if (target) {
      for (const [node, view] of this.mountedViews) {
        if (!view.container.contains(target)) continue;
        return this.lastLayouts.find((b) => b.node === node) ?? null;
      }
    }
    const { x, y } = this.eventToDocCoords(e);
    for (const b of this.lastLayouts) {
      if (!b.isAtom) continue;
      // A float owns only part of its y-band, so it has to be hit-tested in x
      // too — otherwise text beside it would drag the float.
      const fr = b.floatRect;
      if (fr) {
        if (x >= fr.x && x <= fr.x + fr.width && y >= fr.y && y <= fr.y + fr.height)
          return b;
      } else if (y >= b.yOffset && y <= b.yOffset + b.height) {
        return b;
      }
    }
    return null;
  }

  /**
   * The seam a node dropped at document-space `y` would land in: the position
   * before or after the nearest in-flow block, whichever edge is closer.
   * Floated blocks are skipped — being out of the flow, their y says nothing
   * about document order.
   */
  private seamPosAt(y: number): number | null {
    const inFlow = this.lastLayouts.filter((b) => !b.floatRect);
    const layouts = inFlow.length > 0 ? inFlow : this.lastLayouts;
    if (layouts.length === 0) return null;
    let best = layouts[0];
    let bestDist = Infinity;
    for (const b of layouts) {
      const dist = Math.abs(y - (b.yOffset + b.height / 2));
      if (dist < bestDist) {
        bestDist = dist;
        best = b;
      }
    }
    // An atom's pmStartPos is already the position before it; a textblock's is
    // inside it (pos + 1), so step back out to the boundary.
    const before = best.isAtom ? best.pmStartPos : best.pmStartPos - 1;
    const after = best.isAtom ? best.pmEndPos : best.pmEndPos + 1;
    return y < best.yOffset + best.height / 2 ? before : after;
  }

  /**
   * The nearest position to `pos` where `type` can be inserted, climbing out of
   * parents that reject it (a mirror of prosemirror-transform's `insertPoint`,
   * inlined so drag & drop doesn't widen the peer-dependency surface). Null
   * when nothing on the path can hold it.
   */
  private insertPointFor(pos: number, type: NodeType): number | null {
    const $pos = this.state.doc.resolve(pos);
    if ($pos.parent.canReplaceWith($pos.index(), $pos.index(), type)) return pos;
    if ($pos.parentOffset === 0) {
      for (let d = $pos.depth - 1; d >= 0; d--) {
        const index = $pos.index(d);
        if ($pos.node(d).canReplaceWith(index, index, type))
          return $pos.before(d + 1);
        if (index > 0) return null;
      }
    }
    if ($pos.parentOffset === $pos.parent.content.size) {
      for (let d = $pos.depth - 1; d >= 0; d--) {
        const index = $pos.indexAfter(d);
        if ($pos.node(d).canReplaceWith(index, index, type))
          return $pos.after(d + 1);
        if (index < $pos.node(d).childCount) return null;
      }
    }
    return null;
  }

  /** The document position an external drag is hovering, in text terms. */
  private dropPosForEvent(e: { clientX: number; clientY: number }): number {
    const { x, y } = this.eventToDocCoords(e);
    const hit = this.clickToPos(this.lastLayouts, x, y);
    return hit ? hit.pos : this.state.selection.from;
  }

  /** Route a drop that came from outside: consumer handler, then files, then
   *  the HTML/plain-text paste path — all landing where it was dropped. */
  private handleExternalDrop(e: DragEvent): void {
    const pos = this.dropPosForEvent(e);
    if (this.handlers.drop?.(this, pos, e)) return;

    const files = e.dataTransfer ? Array.from(e.dataTransfer.files) : [];
    if (files.length > 0) {
      // No fallback: making a node out of a file means uploading it.
      this.handlers.dropFiles?.(this, pos, files, e);
      return;
    }

    const html = e.dataTransfer?.getData("text/html");
    const text = e.dataTransfer?.getData("text/plain");
    if (!html && !text) return;
    this.dispatch(
      this.state.tr.setSelection(
        Selection.near(
          this.state.doc.resolve(clamp(pos, 0, this.state.doc.content.size)),
        ),
      ),
    );
    if (html) this.pasteHTML(html);
    else this.pastePlainText(text!);
    this.textarea.focus();
  }

  /** The schema's list-item node type, if it defines one. */
  private listItemType() {
    return (
      this.state.schema.nodes["list_item"] ??
      this.state.schema.nodes["listItem"] ??
      null
    );
  }

  /** Is the cursor inside a list item (its textblock's parent is a list item)? */
  private inListItem(): boolean {
    const itemType = this.listItemType();
    if (!itemType) return false;
    const $from = this.state.selection.$from;
    for (let d = $from.depth; d > 0; d--) {
      if ($from.node(d).type === itemType) return true;
    }
    return false;
  }

  private deleteBackward(): void {
    const sel = this.state.selection;
    if (sel instanceof GapCursor) {
      this.deleteAroundGap(-1);
      return;
    }
    if (!sel.empty) {
      this.dispatch(this.state.tr.deleteSelection());
      return;
    }
    // At the start of a list item, lift it out of the list rather than
    // joining backward into the previous item's text.
    const itemType = this.listItemType();
    if (itemType && sel.$from.parentOffset === 0 && this.inListItem()) {
      if (liftListItem(itemType)(this.state, (tr) => this.dispatch(tr))) return;
    }
    // PM's joinBackward handles "at start of textblock" for any schema
    // (paragraphs, list items, blockquotes, …). Returns false otherwise.
    if (joinBackward(this.state, (tr) => this.dispatch(tr))) return;
    const $from = sel.$from;
    if ($from.parent.isTextblock) {
      const text = inlineText($from.parent);
      const prev = prevGraphemeBoundary(
        this.segmenter,
        text,
        $from.parentOffset,
      );
      const delta = $from.parentOffset - prev;
      if (delta > 0) {
        this.dispatch(this.state.tr.delete(sel.from - delta, sel.from));
      }
    } else if (sel.from > 1) {
      this.dispatch(this.state.tr.delete(sel.from - 1, sel.from));
    }
  }

  private deleteForward(): void {
    const sel = this.state.selection;
    if (sel instanceof GapCursor) {
      this.deleteAroundGap(1);
      return;
    }
    if (!sel.empty) {
      this.dispatch(this.state.tr.deleteSelection());
      return;
    }
    if (joinForward(this.state, (tr) => this.dispatch(tr))) return;
    const $to = sel.$to;
    if ($to.parent.isTextblock) {
      const text = inlineText($to.parent);
      const next = nextGraphemeBoundary(this.segmenter, text, $to.parentOffset);
      const delta = next - $to.parentOffset;
      if (delta > 0) {
        this.dispatch(this.state.tr.delete(sel.to, sel.to + delta));
      }
    } else if (sel.to < this.state.doc.content.size - 1) {
      this.dispatch(this.state.tr.delete(sel.to, sel.to + 1));
    }
  }

  /**
   * Enter dispatch. In a code block a newline is inserted; Mod-Enter — or a
   * second Enter on a blank trailing line — exits to a paragraph after it.
   * Shift-Enter is a hard break elsewhere; a plain Enter splits the block.
   */
  private onEnter(shift: boolean, mod: boolean): void {
    const sel = this.state.selection;
    // At a gap cursor, Enter slots an empty paragraph into the seam.
    if (sel instanceof GapCursor) {
      this.insertAtGap("");
      return;
    }
    const $from = sel.$from;
    if ($from.parent.type.spec.code) {
      const atEnd =
        sel.empty && $from.parentOffset === $from.parent.content.size;
      if (mod || (!shift && atEnd && /\n$/.test($from.parent.textContent))) {
        this.exitCodeBlock();
        return;
      }
      this.dispatch(this.state.tr.insertText("\n"));
      return;
    }
    // Shift-Enter is a hard line break within the block; 'pre-wrap' (and the
    // marked-segment layout) honor the newline character.
    if (shift) {
      this.dispatch(this.state.tr.insertText("\n"));
      return;
    }
    // Inside a list, Enter splits the item (and lifts out an empty one).
    const itemType = this.listItemType();
    if (itemType && this.inListItem()) {
      if (splitListItem(itemType)(this.state, (tr) => this.dispatch(tr)))
        return;
    }
    this.splitBlock();
  }

  /** Leave a code block, dropping the blank trailing line if Enter triggered it. */
  private exitCodeBlock(): void {
    const sel = this.state.selection;
    const $from = sel.$from;
    const para = this.state.schema.nodes["paragraph"];
    if (!para) {
      this.dispatch(this.state.tr.insertText("\n"));
      return;
    }
    let tr = this.state.tr;
    if (
      sel.empty &&
      $from.parentOffset === $from.parent.content.size &&
      /\n$/.test($from.parent.textContent)
    ) {
      tr = tr.delete(sel.from - 1, sel.from);
    }
    const after = tr.selection.$from.after();
    tr = tr.insert(after, para.createAndFill()!);
    tr = tr.setSelection(TextSelection.near(tr.doc.resolve(after + 1)));
    this.dispatch(tr.scrollIntoView());
  }

  private splitBlock(): void {
    const sel = this.state.selection;
    let tr = this.state.tr;
    if (!sel.empty) tr = tr.deleteSelection();
    const $from = tr.selection.$from;
    if (!$from.parent.isTextblock) return;
    const para = this.state.schema.nodes["paragraph"];
    const atEnd = $from.parentOffset === $from.parent.content.size;
    // A non-paragraph block (heading, blockquote) split at its end continues
    // as a paragraph; split mid-block keeps the same type.
    if (atEnd && para && $from.parent.type !== para) {
      tr = tr.split($from.pos, 1, [{ type: para }]);
    } else {
      tr = tr.split($from.pos);
    }
    this.dispatch(tr.scrollIntoView());
  }

  /** Parse an HTML string via the schema and replace the selection (rich paste). */
  pasteHTML(html: string): void {
    try {
      const dom = new DOMParser().parseFromString(html, "text/html");
      let slice = PMDOMParser.fromSchema(this.state.schema).parseSlice(
        dom.body,
        { preserveWhitespace: false },
      );
      slice = this.reopenSlice(dom, slice);
      this.dispatch(this.state.tr.replaceSelection(slice));
    } catch {
      // Malformed HTML / unmapped nodes: fall back to the plain text.
      this.pastePlainText(
        new DOMParser().parseFromString(html, "text/html").body.textContent ??
          "",
      );
    }
  }

  /**
   * Restore the open depths a `data-pm-slice` records, when the HTML was
   * written by an editor that leaves one (ours, or prosemirror-view).
   *
   * A parser can only infer depth from the elements it sees, and complete
   * elements imply a closed slice — so half a paragraph arrives looking like a
   * whole one. The attribute is the copying side telling the pasting side what
   * the parser cannot know.
   *
   * Depths that the content can't actually support throw, so an attribute that
   * disagrees with the markup beside it (hand-written HTML, a different
   * schema, a truncated clipboard) falls back to what the parser worked out
   * rather than failing the paste.
   */
  private reopenSlice(dom: Document, slice: Slice): Slice {
    const marked = dom.body.querySelector("[data-pm-slice]");
    const spec = marked?.getAttribute("data-pm-slice")?.match(/^(\d+) (\d+)/);
    if (!spec) return slice;
    try {
      return new Slice(slice.content, Number(spec[1]), Number(spec[2]));
    } catch {
      return slice;
    }
  }

  /**
   * Insert plain text: blank lines split paragraphs, single newlines become
   * hard breaks (kept as '\n' in the text). A single block is inserted inline
   * at the caret; multiple blocks replace the selection as block content.
   */
  private pastePlainText(text: string): void {
    if (!text) return;
    const blocks = text.replace(/\r\n?/g, "\n").split(/\n{2,}/);
    if (blocks.length <= 1) {
      this.dispatch(this.state.tr.insertText(text.replace(/\r\n?/g, "\n")));
      return;
    }
    const para = this.state.schema.nodes["paragraph"];
    if (!para) {
      this.dispatch(this.state.tr.insertText(text.replace(/\r\n?/g, "\n")));
      return;
    }
    const nodes = blocks.map((b) =>
      para.create(null, b ? this.state.schema.text(b) : null),
    );
    // openStart/End 1 lets the first/last paragraph merge into the block at
    // the caret, so pasting mid-paragraph doesn't orphan a new empty block.
    const slice = new Slice(Fragment.fromArray(nodes), 1, 1);
    this.dispatch(this.state.tr.replaceSelection(slice));
  }

  // ─── Selection helpers ─────────────────────────────────────────────

  /** Plain text of the current selection, or null when it's empty. */
  private selectionText(): string | null {
    const sel = this.state.selection;
    if (sel.empty) return null;
    return this.state.doc.textBetween(sel.from, sel.to, "\n");
  }

  /**
   * The current selection as both flavours a drop target might ask for. HTML
   * goes through the schema's own `toDOM` rules, so marks and block structure
   * survive into whatever receives it.
   */
  private selectionClipboard(): { text: string; html: string } | null {
    const text = this.selectionText();
    if (text === null) return null;
    const sel = this.state.selection;
    // A cell selection serializes to bare <td>s, which nothing can place
    // without the table around them. Table clipboard is still open on the
    // roadmap, so a cell selection keeps the plain-text-only payload it has
    // always had rather than shipping HTML no parser can use.
    if (sel instanceof CellSelection) return { text, html: "" };

    const slice = this.state.doc.slice(sel.from, sel.to);
    const holder = document.createElement("div");
    holder.appendChild(this.serializer.serializeFragment(slice.content));

    // How deep the slice is open at each end, in ProseMirror's own
    // `data-pm-slice` format, so a paste can put it back the way it came out.
    // A parser only sees complete elements: without this, copying the back
    // half of one paragraph and the front half of the next pastes as two whole
    // new blocks instead of merging into the paragraph at the caret.
    //
    // Only stamped when it says something — an inline-only slice is already
    // 0/0, which is what a parser assumes anyway, so stamping it would just
    // leave a stray attribute on whatever element happened to come first.
    if (slice.openStart || slice.openEnd) {
      const first = holder.firstElementChild;
      if (first) {
        first.setAttribute(
          "data-pm-slice",
          `${slice.openStart} ${slice.openEnd} []`,
        );
      }
    }
    return { text, html: holder.innerHTML };
  }

  /**
   * Move (or, with `copy`, duplicate) the current selection to `pos` as a
   * single transaction, so the whole thing is one undo step.
   */
  private moveSelectionTo(pos: number, copy: boolean): void {
    const d = this.textDrag;
    if (d) this.moveRange(d.from, d.to, pos, copy);
  }

  /** Move (or copy) the content `[from, to)` to `pos`, as one undo step. */
  private moveRange(from: number, to: number, pos: number, copy: boolean): void {
    const d = { from, to };
    // Dropped inside the content being moved: there is nowhere for it to go.
    if (pos >= d.from && pos <= d.to) return;

    const slice = this.state.doc.slice(d.from, d.to);
    const tr = this.state.tr;
    if (!copy) tr.delete(d.from, d.to);
    // After a delete above the drop point, the target has shifted.
    const at = copy ? pos : tr.mapping.map(pos);
    const before = tr.doc.content.size;
    tr.replaceRange(at, at, slice);
    const added = tr.doc.content.size - before;
    // A lone inline atom stays selected as itself. Otherwise `between`
    // tolerates endpoints that aren't valid text positions (the slice may
    // have landed as whole blocks), unlike TextSelection.create.
    const moved = tr.doc.nodeAt(at);
    tr.setSelection(
      added === 1 && moved?.isInline && NodeSelection.isSelectable(moved)
        ? NodeSelection.create(tr.doc, at)
        : TextSelection.between(tr.doc.resolve(at), tr.doc.resolve(at + added)),
    );
    this.dispatch(tr.scrollIntoView());
  }

  /**
   * Touch drag of an inline atom. Native HTML5 drag, which moves an atom
   * under a mouse, never fires on touch, and a swipe on the canvas is the
   * page's to scroll. So the mobile convention: a long-press picks the atom
   * up (selecting it), the finger carries it with the usual drop caret, and
   * lifting drops it. Returns false when the long-press isn't on an atom.
   */
  private beginTouchAtomDrag(x: number, y: number): boolean {
    if (!this.dragDrop || !this.isEditable) return false;
    const pos = this.inlineAtomAt(x, y);
    if (pos === null) return false;
    this.touchMode = "atomDrag";
    this.touchAtomFrom = pos;
    this.dispatch(
      this.state.tr.setSelection(NodeSelection.create(this.state.doc, pos)),
    );
    this.textarea.focus({ preventScroll: true });
    return true;
  }

  private moveTouchAtomDrag(clientX: number, clientY: number): void {
    const { x, y } = this.eventToDocCoords({ clientX, clientY });
    const hit = this.clickToPos(this.lastLayouts, x, y);
    this.dropTarget = hit ? { pos: hit.pos, seam: false } : null;
    this.updateAutoScroll(clientX, clientY);
    this.scheduleRender();
  }

  private endTouchAtomDrag(): void {
    const from = this.touchAtomFrom;
    const target = this.dropTarget;
    this.touchAtomFrom = null;
    this.dropTarget = null;
    this.stopAutoScroll();
    this.scheduleRender();
    // Lifted without moving: the long-press just selected it.
    if (from !== null && target) this.moveRange(from, from + 1, target.pos, false);
  }

  /**
   * Cancel a pending long-press (finger moved, lifted, or a second touch).
   */
  private cancelLongPress(): void {
    if (this.longPressTimer !== null) {
      clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
  }

  /** Select the word under a canvas-space point (long-press / double-tap). */
  private selectWordAt(x: number, y: number): void {
    const hit = this.clickToPos(this.lastLayouts, x, y);
    if (!hit) return;
    const word = this.wordRangeAt(hit.pos);
    if (!word) {
      this.setHead(hit.pos, false);
      this.caretBias = hit.bias;
      return;
    }
    this.dispatch(
      this.state.tr.setSelection(
        TextSelection.between(
          this.state.doc.resolve(word.from),
          this.state.doc.resolve(word.to),
        ),
      ),
    );
  }

  /** Move one end of the current selection to `pos`, keeping the other end
   *  anchored — used by the draggable touch selection handles. */
  private dragSelectionEnd(which: "from" | "to", pos: number): void {
    const sel = this.state.selection;
    const anchor = which === "from" ? sel.to : sel.from;
    const size = this.state.doc.content.size;
    this.dispatch(
      this.state.tr.setSelection(
        TextSelection.between(
          this.state.doc.resolve(clamp(anchor, 0, size)),
          this.state.doc.resolve(clamp(pos, 0, size)),
        ),
      ),
    );
    this.scheduleRender();
  }

  // ─── Multi-tap (touch) ─────────────────────────────────────────────

  /**
   * Fold this tap into a run of taps at the same spot, returning whether it is
   * a follow-up (the 2nd or later) rather than a fresh first tap.
   *
   * Slop matters more here than for a mouse: a finger never lands twice in
   * exactly the same place, so requiring that would make double-tap a gesture
   * nobody can perform on purpose.
   */
  private registerTap(): boolean {
    const now = Date.now();
    const near =
      Math.hypot(
        this.touchStartX - this.lastTapX,
        this.touchStartY - this.lastTapY,
      ) <= MULTI_TAP_SLOP_PX;
    this.tapCount = now - this.lastTapTime <= MULTI_TAP_MS && near
      ? this.tapCount + 1
      : 1;
    this.lastTapTime = now;
    this.lastTapX = this.touchStartX;
    this.lastTapY = this.touchStartY;
    return this.tapCount >= 2;
  }

  /** Word for a double tap, the whole textblock for a triple. Returns whether
   *  a selection was actually made. */
  private selectForTapCount(pos: number): boolean {
    const doc = this.state.doc;
    if (this.tapCount === 2) {
      const word = this.wordRangeAt(pos);
      if (!word) return false;
      this.dispatch(
        this.state.tr.setSelection(
          TextSelection.between(doc.resolve(word.from), doc.resolve(word.to)),
        ),
      );
      return true;
    }
    // Three or more: the block. Beyond three there is nothing further to
    // escalate to, so it simply stays there rather than cycling back.
    const $pos = doc.resolve(clamp(pos, 0, doc.content.size));
    if (!$pos.parent.isTextblock || $pos.parent.content.size === 0) return false;
    this.dispatch(
      this.state.tr.setSelection(
        TextSelection.between(
          doc.resolve($pos.start()),
          doc.resolve($pos.end()),
        ),
      ),
    );
    return true;
  }

  // ─── Magnifier loupe (touch) ───────────────────────────────────────

  /**
   * Show the magnifier over a document-space point, or hide it when `at` is
   * null.
   *
   * The magnified image is copied straight off the editor's own canvas with
   * `drawImage`, which is the whole reason this is cheap: the text is already
   * rendered pixels, so there is nothing to lay out or re-paint — one blit per
   * touchmove. It also means the loupe is always in perfect agreement with what
   * is on screen, including selection bands and decorations.
   *
   * Takes document coordinates rather than client ones because every caller has
   * already paid for the conversion; asking for client coordinates here would
   * mean a second `getBoundingClientRect` — a forced synchronous layout — on
   * every touchmove of a drag.
   */
  private showLoupe(at: { x: number; y: number } | null): void {
    if (!at) {
      if (this.loupe) this.loupe.el.style.display = "none";
      return;
    }
    const { el, canvas } = this.ensureLoupe();
    // The canvas covers the whole document unless virtualizing, where it is a
    // viewport onto it — so the source rect is document space less the scroll.
    const scrollTop = this.scroller?.scrollTop ?? 0;
    const cx = at.x;
    const cy = at.y - scrollTop;

    const dpr = window.devicePixelRatio || 1;
    const sw = LOUPE_WIDTH / LOUPE_ZOOM;
    const sh = LOUPE_HEIGHT / LOUPE_ZOOM;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, LOUPE_WIDTH, LOUPE_HEIGHT);
    ctx.drawImage(
      this.canvas,
      (cx - sw / 2) * dpr, (cy - sh / 2) * dpr, sw * dpr, sh * dpr,
      0, 0, LOUPE_WIDTH, LOUPE_HEIGHT,
    );

    // Positioned in stack space, which is document space.
    const docY = at.y;
    // Above the finger by default. On the first line or two there is no room up
    // there, and a loupe clipped off the top of the editor is worse than none —
    // so it drops below the touch instead, the way the remote-caret flag does.
    const above = docY - LOUPE_LIFT;
    const top = above >= scrollTop ? above : docY + LOUPE_DROP;
    const left = clamp(cx, LOUPE_WIDTH / 2, this.containerWidth - LOUPE_WIDTH / 2);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.display = "";
  }

  /** The first opaque background above the canvas — whatever the page is
   *  actually showing behind the text. Falls back to white. */
  private backdropColor(): string {
    if (typeof getComputedStyle === "undefined") return "#fff";
    let el: HTMLElement | null = this.container;
    while (el) {
      const bg = getComputedStyle(el).backgroundColor;
      if (bg && bg !== "transparent" && !/rgba\(0, 0, 0, 0\)/.test(bg)) return bg;
      el = el.parentElement;
    }
    return "#fff";
  }

  private ensureLoupe(): { el: HTMLElement; canvas: HTMLCanvasElement } {
    if (this.loupe) return this.loupe;
    const el = document.createElement("div");
    Object.assign(el.style, {
      position: "absolute",
      width: `${LOUPE_WIDTH}px`,
      height: `${LOUPE_HEIGHT}px`,
      marginLeft: `${-LOUPE_WIDTH / 2}px`,
      borderRadius: `${LOUPE_HEIGHT / 2}px`,
      overflow: "hidden",
      border: "2px solid rgba(255,255,255,0.9)",
      boxShadow: "0 4px 14px rgba(0,0,0,0.3)",
      pointerEvents: "none",
      zIndex: "5",
      display: "none",
      // The editor's canvas is transparent wherever nothing is painted, so the
      // loupe has to supply the backdrop the page would have shown through it.
      background: this.backdropColor(),
    });
    el.setAttribute("aria-hidden", "true");
    const canvas = document.createElement("canvas");
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(LOUPE_WIDTH * dpr);
    canvas.height = Math.round(LOUPE_HEIGHT * dpr);
    canvas.style.width = `${LOUPE_WIDTH}px`;
    canvas.style.height = `${LOUPE_HEIGHT}px`;
    el.appendChild(canvas);
    this.stack.appendChild(el);
    this.loupe = { el, canvas };
    return this.loupe;
  }

  /** Lazily build the two selection-handle overlays (touch only). */
  private ensureHandles(): { from: HTMLElement; to: HTMLElement } {
    if (this.selHandles) return this.selHandles;
    const make = (which: "from" | "to"): HTMLElement => {
      const el = document.createElement("div");
      Object.assign(el.style, {
        position: "absolute",
        width: "20px",
        height: "20px",
        marginLeft: "-10px",
        borderRadius: "50%",
        background: this.caretColor,
        border: "2px solid #fff",
        boxShadow: "0 1px 4px rgba(0,0,0,0.35)",
        touchAction: "none",
        zIndex: "4",
        display: "none",
      });
      el.setAttribute("aria-hidden", "true");
      const signal = this.abortController?.signal;
      el.addEventListener(
        "touchstart",
        (e) => {
          e.preventDefault();
          this.draggingHandle = which;
        },
        { signal, passive: false },
      );
      el.addEventListener(
        "touchmove",
        (e) => {
          if (this.draggingHandle !== which) return;
          e.preventDefault();
          const t = e.touches[0];
          if (!t) return;
          const { x, y } = this.eventToDocCoords(t);
          const hit = this.clickToPos(this.lastLayouts, x, y);
          if (hit) this.dragSelectionEnd(which, hit.pos);
          // The handle sits under the fingertip, so the end being dragged is
          // exactly what's hidden — the loupe matters most here.
          this.showLoupe({ x, y });
        },
        { signal, passive: false },
      );
      el.addEventListener(
        "touchend",
        (e) => {
          e.preventDefault();
          this.draggingHandle = null;
          this.showLoupe(null);
          this.textarea.focus({ preventScroll: true });
        },
        { signal, passive: false },
      );
      this.stack.appendChild(el);
      return el;
    };
    this.selHandles = { from: make("from"), to: make("to") };
    return this.selHandles;
  }

  /** Position/hide the touch selection handles (called each render). */
  private syncSelectionHandles(): void {
    const sel = this.state.selection;
    const show =
      this.touchSelection && !sel.empty && sel instanceof TextSelection;
    if (!show) {
      if (this.selHandles) {
        this.selHandles.from.style.display = "none";
        this.selHandles.to.style.display = "none";
      }
      return;
    }
    const handles = this.ensureHandles();
    const place = (el: HTMLElement, pos: number) => {
      const c = this.posToCoords(this.lastLayouts, pos);
      if (!c) {
        el.style.display = "none";
        return;
      }
      el.style.display = "block";
      el.style.left = `${c.x}px`;
      el.style.top = `${c.y + c.height}px`;
    };
    place(handles.from, sel.from);
    place(handles.to, sel.to);
  }

  /**
   * The document range of the word at a doc position, for double-click
   * selection. Returns the Intl word segment under the cursor (or the last
   * segment when the position sits at the block's end). Null if not in a
   * non-empty text block.
   */
  private wordRangeAt(pos: number): { from: number; to: number } | null {
    let block: BlockLayout | null = null;
    for (const b of this.lastLayouts) {
      if (pos >= b.pmStartPos && pos <= b.pmEndPos) {
        block = b;
        break;
      }
    }
    if (!block || block.text.length === 0) return null;

    const offset = pos - block.pmStartPos;
    let last: { start: number; end: number } | null = null;
    for (const seg of this.wordSegmenter.segment(block.text)) {
      const start = seg.index;
      const end = start + seg.segment.length;
      if (offset >= start && offset < end) {
        return { from: block.pmStartPos + start, to: block.pmStartPos + end };
      }
      last = { start, end };
    }
    // Position at the very end of the block — select the last segment.
    if (last)
      return {
        from: block.pmStartPos + last.start,
        to: block.pmStartPos + last.end,
      };
    return null;
  }

  /**
   * Step `direction` graphemes from `pos` within the current textblock.
   * Falls through to a single-position step when at a block edge so
   * cross-block navigation still works via TextSelection.near.
   */
  private steppedGraphemePos(pos: number, direction: 1 | -1): number {
    const $pos = this.state.doc.resolve(pos);
    if (!$pos.parent.isTextblock) return pos + direction;
    const text = inlineText($pos.parent);
    const offset = $pos.parentOffset;
    if (direction > 0) {
      const next = nextGraphemeBoundary(this.segmenter, text, offset);
      if (next > offset) return pos + (next - offset);
      return pos + 1;
    }
    const prev = prevGraphemeBoundary(this.segmenter, text, offset);
    if (prev < offset) return pos - (offset - prev);
    return pos - 1;
  }

  private setHead(newHead: number, extend: boolean, bias: 1 | -1 = 1): void {
    const size = this.state.doc.content.size;
    const $head = this.state.doc.resolve(clamp(newHead, 0, size));
    if (extend) {
      const anchor = clamp(this.state.selection.anchor, 0, size);
      const $anchor = this.state.doc.resolve(anchor);
      // Extending out of the cell it started in stops being a text range and
      // becomes a rectangle of cells — a text selection across a cell boundary
      // would span the structural tokens between them and read as gibberish.
      const cells = CellSelection.between(this.state.doc, anchor, $head.pos);
      this.dispatch(
        this.state.tr.setSelection(
          cells ?? TextSelection.between($anchor, $head, bias),
        ),
      );
    } else {
      this.dispatch(
        this.state.tr.setSelection(TextSelection.near($head, bias)),
      );
    }
  }

  private moveSelection(delta: number, extend: boolean): void {
    const head = this.state.selection.head;
    const target =
      delta === 1 || delta === -1
        ? this.steppedGraphemePos(head, delta)
        : head + delta;
    this.setHead(target, extend, delta < 0 ? -1 : 1);
    // If the step lands on a soft-wrap boundary, bias the caret in the
    // direction of travel: rightward shows it at the start of the next
    // visual line, leftward at the end of the previous one. setHead's
    // dispatch reset bias to -1, so we only need to override for rightward.
    if (this.isAtSoftWrapBoundary(this.state.selection.head)) {
      this.caretBias = delta > 0 ? 1 : -1;
    }
  }

  /**
   * True when `pos` sits exactly on an internal soft-wrap boundary — the end
   * of one visual line and the start of the next within the same block
   * (block starts/ends and hard paragraph breaks don't count).
   */
  private isAtSoftWrapBoundary(pos: number): boolean {
    for (const block of this.lastLayouts) {
      if (pos < block.pmStartPos || pos > block.pmEndPos) continue;
      const offsetInBlock = pos - block.pmStartPos;
      // Every line after the first begins at an internal soft-wrap
      // boundary (the block start at offset 0 doesn't count).
      for (let i = 1; i < block.lines.length; i++) {
        if (block.lines[i].pmStart === offsetInBlock) return true;
      }
      return false;
    }
    return false;
  }

  private moveVertical(direction: 1 | -1, extend: boolean): void {
    if (this.lastLayouts.length === 0) return;

    const head = this.state.selection.head;
    const currentCoords = this.posToCoords(this.lastLayouts, head);
    if (!currentCoords) return;

    // Locate current block by PM position, current line by caret Y.
    let currentBlockIdx = -1;
    for (let bi = 0; bi < this.lastLayouts.length; bi++) {
      const b = this.lastLayouts[bi];
      if (head >= b.pmStartPos && head <= b.pmEndPos) {
        currentBlockIdx = bi;
        break;
      }
    }
    if (currentBlockIdx === -1) return;

    const currentBlock = this.lastLayouts[currentBlockIdx];
    let currentLineIdx = 0;
    for (let li = 0; li < currentBlock.lines.length; li++) {
      if (currentBlock.lines[li].y === currentCoords.y) {
        currentLineIdx = li;
        break;
      }
    }

    // Capture the phantom X from the current caret on the first vertical
    // move of a run. Subsequent vertical moves reuse it.
    const targetX = this.phantomX ?? currentCoords.x;

    // Pick the target line (wrapping across block boundaries).
    let targetBlockIdx = currentBlockIdx;
    let targetLineIdx = currentLineIdx + direction;

    if (targetLineIdx < 0) {
      if (currentBlockIdx === 0) {
        // Top of doc — clamp to very start.
        this.setHead(0, extend);
        this.phantomX = targetX;
        return;
      }
      targetBlockIdx = currentBlockIdx - 1;
      const prev = this.lastLayouts[targetBlockIdx];
      targetLineIdx = Math.max(0, prev.lines.length - 1);
    } else if (targetLineIdx >= currentBlock.lines.length) {
      if (currentBlockIdx === this.lastLayouts.length - 1) {
        // Bottom of doc — clamp to very end.
        this.setHead(this.state.doc.content.size, extend);
        this.phantomX = targetX;
        return;
      }
      targetBlockIdx = currentBlockIdx + 1;
      targetLineIdx = 0;
    }

    const targetBlock = this.lastLayouts[targetBlockIdx];
    if (targetBlock.lines.length === 0) {
      // Atom block — select the node rather than placing a text caret.
      this.dispatch(
        this.state.tr.setSelection(
          NodeSelection.create(this.state.doc, targetBlock.pmStartPos),
        ),
      );
      this.phantomX = targetX;
      return;
    }
    const targetLine = targetBlock.lines[targetLineIdx];

    // Re-use clickToPos against the target line's midline — it already
    // handles empty lines, binary search, and nearest-char snap, and hands
    // back the bias that keeps the caret on the target line even when the
    // landing offset sits on a soft-wrap boundary.
    const hit = this.clickToPos(
      this.lastLayouts,
      targetX,
      targetLine.y + targetBlock.lineHeight / 2,
    );
    if (hit !== null) this.setHead(hit.pos, extend);

    // Pin phantom X and bias after dispatch (which clears them).
    this.phantomX = targetX;
    if (hit !== null) this.caretBias = hit.bias;
  }

  // ─── Gap cursor ────────────────────────────────────────────────────

  /** True when the caret is on the visual edge line/column of its block, so
   *  an arrow there should step out into a gap rather than within the block. */
  private atTextblockEdge(axis: "horiz" | "vert", dir: 1 | -1): boolean {
    const sel = this.state.selection;
    if (axis === "horiz") {
      const $h = sel.$head;
      return dir > 0
        ? $h.parentOffset === $h.parent.content.size
        : $h.parentOffset === 0;
    }
    const head = sel.head;
    const coords = this.posToCoords(this.lastLayouts, head);
    if (!coords) return false;
    const block = this.lastLayouts.find(
      (b) => head >= b.pmStartPos && head <= b.pmEndPos,
    );
    if (!block || block.lines.length === 0) return false;
    const edge = dir > 0 ? block.lines[block.lines.length - 1] : block.lines[0];
    return coords.y === edge.y;
  }

  /**
   * Try to move the selection into — or along — a gap cursor (the caret that
   * sits in seams between block nodes where no text cursor fits, e.g. between
   * two stacked images). Returns whether it handled the arrow; otherwise the
   * caller performs its normal text/vertical motion.
   */
  private gapNav(
    axis: "horiz" | "vert",
    dir: 1 | -1,
    extend: boolean,
  ): boolean {
    if (extend) return false;
    const sel = this.state.selection;

    // Already in a gap: step to the next gap, the adjacent atom, or the
    // nearest text position.
    if (sel instanceof GapCursor) {
      const $from = dir > 0 ? sel.$to : sel.$from;
      const $g = GapCursorStatic.findFrom($from, dir, true);
      if ($g) {
        this.dispatch(this.state.tr.setSelection(new GapCursor($g)));
        return true;
      }
      const node = dir > 0 ? $from.nodeAfter : $from.nodeBefore;
      if (node && NodeSelection.isSelectable(node)) {
        const at = dir > 0 ? $from.pos : $from.pos - node.nodeSize;
        this.dispatch(
          this.state.tr.setSelection(NodeSelection.create(this.state.doc, at)),
        );
        return true;
      }
      const next = Selection.findFrom($from, dir, true);
      if (next) this.dispatch(this.state.tr.setSelection(next));
      return true;
    }

    let $start: ResolvedPos;
    let mustMove = sel.empty;
    if (sel instanceof TextSelection && sel.empty) {
      if (sel.$head.depth === 0 || !this.atTextblockEdge(axis, dir))
        return false;
      $start = this.state.doc.resolve(
        dir > 0 ? sel.$head.after() : sel.$head.before(),
      );
      mustMove = false;
    } else if (sel instanceof NodeSelection) {
      $start = dir > 0 ? sel.$to : sel.$from;
    } else {
      return false;
    }
    const $found = GapCursorStatic.findFrom($start, dir, mustMove);
    if (!$found) return false;
    this.dispatch(this.state.tr.setSelection(new GapCursor($found)));
    return true;
  }

  /** If a click at document-space `y` falls in a seam where a gap cursor is
   *  valid (e.g. between two stacked images), the gap position; else null. */
  private gapPosForClick(y: number): number | null {
    for (let i = 0; i < this.lastLayouts.length; i++) {
      const b = this.lastLayouts[i];
      const next = this.lastLayouts[i + 1];
      if (i === 0 && y < b.yOffset) {
        return GapCursorStatic.valid(this.state.doc.resolve(b.pmStartPos))
          ? b.pmStartPos
          : null;
      }
      if (y > b.yOffset + b.height && (!next || y < next.yOffset)) {
        return GapCursorStatic.valid(this.state.doc.resolve(b.pmEndPos))
          ? b.pmEndPos
          : null;
      }
    }
    return null;
  }

  /** Document-space Y where a gap cursor at `pos` is painted (in a block seam). */
  private gapCursorY(pos: number): number {
    let y = 1;
    for (const b of this.lastLayouts) {
      if (pos <= b.pmStartPos)
        return Math.max(1, b.yOffset - this.blockGap / 2);
      if (pos >= b.pmEndPos) y = b.yOffset + b.height + this.blockGap / 2;
    }
    return y;
  }

  /** Insert a paragraph (optionally seeded with text) where the gap cursor is. */
  private insertAtGap(text: string): void {
    const sel = this.state.selection;
    if (!(sel instanceof GapCursor)) return;
    const para = this.state.schema.nodes["paragraph"];
    if (!para) return;
    const pos = sel.$from.pos;
    const node = text
      ? para.create(null, this.state.schema.text(text))
      : para.createAndFill();
    if (!node) return;
    const tr = this.state.tr.insert(pos, node);
    tr.setSelection(TextSelection.near(tr.doc.resolve(pos + 1 + text.length)));
    this.dispatch(tr.scrollIntoView());
  }

  /** Delete the node on one side of the gap cursor (Backspace / Delete). */
  private deleteAroundGap(dir: -1 | 1): void {
    const $pos = this.state.selection.$from;
    const node = dir < 0 ? $pos.nodeBefore : $pos.nodeAfter;
    if (!node) return;
    const from = dir < 0 ? $pos.pos - node.nodeSize : $pos.pos;
    this.dispatch(
      this.state.tr.delete(from, from + node.nodeSize).scrollIntoView(),
    );
  }

  private moveToBlockBoundary(end: "start" | "end", extend: boolean): void {
    for (const block of this.lastLayouts) {
      const head = this.state.selection.head;
      if (head >= block.pmStartPos && head <= block.pmEndPos) {
        const target = end === "start" ? block.pmStartPos : block.pmEndPos;
        this.setHead(target, extend, end === "start" ? -1 : 1);
        return;
      }
    }
  }

  // ─── Caret Blink ───────────────────────────────────────────────────

  private startCaretBlink(): void {
    // Honor prefers-reduced-motion: keep the caret solid (no blink).
    if (this.reducedMotion) {
      this.caretVisible = true;
      return;
    }
    this.blinkInterval = setInterval(() => {
      // Blurred: nothing to blink, and re-rendering twice a second for it is
      // waste that multiplies by however many editors are on the page.
      if (!this.hasFocus()) return;
      const sinceInput = performance.now() - this.lastInputTime;
      if (sinceInput < this.caretHoldMs) {
        if (!this.caretVisible) {
          this.caretVisible = true;
          this.scheduleRender();
        }
        return;
      }
      this.caretVisible = !this.caretVisible;
      this.scheduleRender();
    }, this.caretBlinkMs);
  }
}
