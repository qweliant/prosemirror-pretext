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

export type Decoration = InlineDecoration | NodeDecoration | WidgetDecoration

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
}
