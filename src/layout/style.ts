/**
 * Style resolution: given a node or a run of marks, what font, color, padding,
 * and content width does it get.
 *
 * This is the half of layout that tables do not change. A table cell resolves
 * its blocks' styles exactly the way a top-level block does — what tables
 * change is *topology* (where boxes go, how wide they are, how rows size), and
 * that lives in editor.ts still. Keeping the two apart means the topology work
 * can be reshaped without dragging style resolution through it.
 *
 * All free functions over an explicit `StyleContext`, so nothing here needs the
 * editor. Two of them don't even need the context.
 */

import type { Mark, Node as PMNode } from 'prosemirror-model'
import type {
    BlockStyleResolver, MarkStyleResolver, ResolvedBlockStyle,
} from '../types'

/** The editor configuration style resolution reads. Nothing mutable. */
export interface StyleContext
{
    /** The editor's base CSS font string. */
    font: string
    baseFontSize: number
    baseFontFamily: string
    lineHeight: number
    containerWidth: number
    markStyles: Record<string, MarkStyleResolver>
    blockStyles: Record<string, BlockStyleResolver>
}

/** Whether any inline child of a block carries a mark (picks the layout path). */
export function blockHasMarks(node: PMNode): boolean
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
export function resolveRunStyle(
    cx: StyleContext,
    marks: readonly Mark[],
    base: ResolvedBlockStyle,
): {
    font: string
    color: string | null
    background: string | null
    underline: boolean
    strikethrough: boolean
    baselineShift: number
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
        const entry = cx.markStyles[mark.type.name]
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
    const size = verticalAlign ? Math.round(base.fontSize * 0.72) : base.fontSize
    const baselineShift = verticalAlign === 'super'
        ? -Math.round(base.fontSize * 0.3)
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
export function resolveBlockStyle(cx: StyleContext, node: PMNode): ResolvedBlockStyle
{
    // Per-instance text alignment from the node's `align` attribute.
    const a = node.attrs['align']
    const textAlign: 'left' | 'center' | 'right' =
        a === 'center' || a === 'right' ? a : 'left'

    const entry = cx.blockStyles[node.type.name]
    const bs = typeof entry === 'function' ? entry(node) : entry
    if (!bs)
    {
        return {
            font: cx.font,
            fontSize: cx.baseFontSize,
            fontFamily: cx.baseFontFamily,
            fontWeight: '',
            fontStyle: '',
            lineHeight: cx.lineHeight,
            color: null,
            paddingLeft: 0,
            paddingRight: 0,
            paddingTop: 0,
            paddingBottom: 0,
            background: null,
            borderLeft: null,
            textAlign,
        }
    }
    const fontSize = bs.fontSize ?? cx.baseFontSize
    const fontFamily = bs.fontFamily ?? cx.baseFontFamily
    const fontWeight = bs.fontWeight !== undefined ? String(bs.fontWeight) : ''
    const fontStyle = bs.fontStyle ?? ''
    const font = `${fontStyle} ${fontWeight} ${fontSize}px ${fontFamily}`
        .replace(/\s+/g, ' ')
        .trim()
    return {
        font,
        fontSize,
        fontFamily,
        fontWeight,
        fontStyle,
        lineHeight: bs.lineHeight ?? cx.lineHeight,
        color: bs.color ?? null,
        paddingLeft: bs.paddingLeft ?? 0,
        paddingRight: bs.paddingRight ?? 0,
        paddingTop: bs.paddingTop ?? 0,
        paddingBottom: bs.paddingBottom ?? 0,
        background: bs.background ?? null,
        borderLeft: bs.borderLeft ?? null,
        textAlign,
    }
}

/** The style/box fields shared by every CachedBlock, from a resolved base.
 *  `indent` is the raw list indent already folded into base.paddingLeft. */
export function boxFields(base: ResolvedBlockStyle, indent = 0)
{
    return {
        font: base.font,
        fontSize: base.fontSize,
        color: base.color,
        paddingLeft: base.paddingLeft,
        paddingRight: base.paddingRight,
        paddingTop: base.paddingTop,
        paddingBottom: base.paddingBottom,
        background: base.background,
        borderLeft: base.borderLeft,
        indent,
    }
}

/** Resolve a block's base style, folding a list indent into its left pad. */
export function blockBase(
    cx: StyleContext,
    node: PMNode,
    indent: number,
): ResolvedBlockStyle
{
    const rbs = resolveBlockStyle(cx, node)
    return indent ? { ...rbs, paddingLeft: rbs.paddingLeft + indent } : rbs
}

/** Content width available to a block after its horizontal padding. */
export function blockContentWidth(cx: StyleContext, base: ResolvedBlockStyle): number
{
    return cx.containerWidth - base.paddingLeft - base.paddingRight
}
