/**
 * Canvas-native decorations — transient, non-document styling layered over the
 * rendered text (search highlights, spellcheck squiggles, collab cursors, inline
 * widgets, per-node backgrounds). PM-shaped (`Decoration.inline/node/widget`)
 * but styled with the canvas-renderable subset the editor already paints, since
 * a canvas can't apply a CSS class.
 *
 * Supply them via the `decorations(state)` option; they're recomputed each
 * render, so derive them from your state/plugins (e.g. a search query).
 */

/** Canvas-renderable styling for a decorated text range. */
export interface InlineDecorationStyle
{
    /** Background painted behind the range (e.g. search highlight). */
    background?: string
    /** Underline color (omit to use the text color). */
    underline?: string
    /** Draw the underline as a wavy line (e.g. spellcheck squiggle). */
    wavy?: boolean
    /** Strikethrough color. */
    strikethrough?: string
    /**
     * Fill color for the glyphs themselves.
     *
     * The other properties here are overlays painted *around* the text, so they
     * need nothing from layout — a rect is a rect. Color is different: it
     * repaints the glyphs, so any run the range only partly covers has to be
     * split at the range's edges before it can be drawn. Painting does that
     * split itself (see `splitRunsByColor`), which is only sound because a fill
     * color has no effect on metrics: the pieces inherit the geometry layout
     * already computed, and no cache is invalidated. Were this a font change,
     * it would have to happen during layout instead.
     */
    color?: string
}

/** Box styling for a decorated block node. */
export interface NodeDecorationStyle
{
    background?: string
    borderLeft?: { width: number, color: string }
}

export interface InlineDecoration
{
    kind: 'inline'
    from: number
    to: number
    style: InlineDecorationStyle
}

export interface NodeDecoration
{
    kind: 'node'
    /** Document position of the block node to decorate (its `nodeStart`). */
    from: number
    style: NodeDecorationStyle
}

export interface WidgetDecoration
{
    kind: 'widget'
    pos: number
    /** The element to mount at `pos` (or a factory). Pure overlay — reserves no
     *  space. */
    dom: HTMLElement | (() => HTMLElement)
    /** Stable identity so the element is reused across renders, not remounted. */
    key?: string
    /** Pixel nudge from the caret position at `pos` (e.g. center a cursor). */
    offsetX?: number
    offsetY?: number
}

/**
 * A caret belonging to someone other than the local user, painted on the canvas
 * rather than mounted as DOM.
 *
 * A remote caret *can* be built from a widget decoration — and the demo used to
 * — but a widget is an absolutely-positioned element floating above the canvas,
 * so it does not scroll, clip, or composite with the text it annotates the way
 * the local caret does. This draws in the same pass as everything else, which
 * is what makes ten of them cost nothing.
 */
export interface CursorDecoration
{
    kind: 'cursor'
    /** Where the caret sits. */
    pos: number
    /** Caret and name-flag color — one per participant. */
    color: string
    /** Name flag drawn against the caret. Omitted: a bare caret. */
    label?: string
    /** Text color inside the flag. Default: white. */
    labelColor?: string
}

export type Decoration =
    | InlineDecoration
    | NodeDecoration
    | WidgetDecoration
    | CursorDecoration

/** Factories mirroring prosemirror-view's `Decoration.{inline,node,widget}`. */
export const Decoration = {
    inline(from: number, to: number, style: InlineDecorationStyle): InlineDecoration
    {
        return { kind: 'inline', from, to, style }
    },
    node(from: number, style: NodeDecorationStyle): NodeDecoration
    {
        return { kind: 'node', from, style }
    },
    widget(pos: number, dom: WidgetDecoration['dom'], spec: Omit<WidgetDecoration, 'kind' | 'pos' | 'dom'> = {}): WidgetDecoration
    {
        return { kind: 'widget', pos, dom, ...spec }
    },
    cursor(pos: number, color: string, spec: Omit<CursorDecoration, 'kind' | 'pos' | 'color'> = {}): CursorDecoration
    {
        return { kind: 'cursor', pos, color, ...spec }
    },
}

/** One remote participant's selection, as the collab transport reports it. */
export interface RemoteSelection
{
    /** The selected range. Equal ends mean a collapsed caret. */
    from: number
    to: number
    /**
     * Which end the caret sits on. Defaults to `to`. Supplying it is what makes
     * a backwards selection look backwards — the flag follows the end the
     * remote user is actually dragging.
     */
    head?: number
    /** The participant's color; the band behind their selection is derived from it. */
    color: string
    /** Shown in the flag beside their caret. */
    name?: string
    /**
     * Band color behind the selected text. Defaults to `color` at 25% alpha,
     * which only works when `color` is a hex string — pass this explicitly for
     * `rgb()`, `hsl()`, or named colors.
     */
    selectionColor?: string
}

/**
 * The decorations for one remote participant: a band over their selection and a
 * caret with their name at its head.
 *
 * The transport is deliberately not here. Whether positions arrive over Yjs,
 * `prosemirror-collab`, or a websocket of your own is an application concern;
 * what the editor owes you is the drawing, and one participant is exactly this
 * much of it.
 */
export function remoteSelection(user: RemoteSelection): Decoration[]
{
    const out: Decoration[] = []
    const from = Math.min(user.from, user.to)
    const to = Math.max(user.from, user.to)
    if (to > from)
    {
        out.push(Decoration.inline(from, to, {
            background: user.selectionColor ?? withAlpha(user.color, 0.25),
        }))
    }
    const head = user.head ?? to
    out.push(Decoration.cursor(head, user.color, user.name ? { label: user.name } : {}))
    return out
}

/** `#rgb`/`#rrggbb` → `rgba(...)`. Anything else is returned untouched, so a
 *  caller passing a non-hex color gets an opaque band rather than a crash. */
export function withAlpha(color: string, alpha: number): string
{
    const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color)
    if (!hex) return color
    let h = hex[1]
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
    const n = parseInt(h, 16)
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}
