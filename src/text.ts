/**
 * Pure text/grapheme utilities used by the editor's layout and navigation.
 * Kept free of editor state so they're trivially testable: callers pass the
 * `Intl.Segmenter` (and a measuring context where needed).
 */

import type { Node as PMNode } from 'prosemirror-model'

/**
 * Stand-in character for an inline atom (mention, chip) in a block's text.
 * An atom occupies one ProseMirror position but contributes nothing to
 * `textContent`, so every offset after it would be off by one. Giving it this
 * one-character placeholder keeps block text and PM offsets aligned, and it is
 * a grapheme of its own, so caret steps and Backspace treat the atom as one
 * unit.
 */
export const ATOM_CHAR = '\uFFFC'

/**
 * A textblock's text in PM-offset space: text verbatim, each inline leaf as
 * `ATOM_CHAR`. Use this instead of `node.textContent` anywhere an index into
 * the string must equal an offset into the block.
 */
export function inlineText(node: PMNode): string
{
    return node.textBetween(0, node.content.size, '', ATOM_CHAR)
}

export function clamp(n: number, min: number, max: number): number
{
    return Math.max(min, Math.min(max, n))
}

/**
 * Map a fragment's collapsed text back onto its source run, preserving the
 * original (uncollapsed) whitespace. Non-space characters align exactly; each
 * collapsed space stands for a run of whitespace in the source. Whitespace
 * trimmed at a line start is skipped first. Returns the real slice + new index.
 */
export function expandCollapsedWhitespace(
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

export function nextGraphemeBoundary(seg: Intl.Segmenter, text: string, pos: number): number
{
    if (pos >= text.length) return text.length
    for (const { index } of seg.segment(text))
    {
        if (index > pos) return index
    }
    return text.length
}

export function prevGraphemeBoundary(seg: Intl.Segmenter, text: string, pos: number): number
{
    if (pos <= 0) return 0
    let prev = 0
    for (const { index } of seg.segment(text))
    {
        if (index >= pos) return prev
        prev = index
    }
    return prev
}

export function graphemeBoundaries(seg: Intl.Segmenter, text: string): number[]
{
    const boundaries: number[] = []
    for (const { index } of seg.segment(text)) boundaries.push(index)
    boundaries.push(text.length)
    return boundaries
}

/**
 * Binary-search the grapheme boundary nearest to `targetX` (px) within `text`
 * rendered in `font`, using `mc` to measure. Returns the offset into `text`.
 */
export function hitTestInText(
    mc: CanvasRenderingContext2D, seg: Intl.Segmenter,
    text: string, font: string, targetX: number,
): number
{
    mc.font = font
    const bounds = graphemeBoundaries(seg, text)
    let lo = 0
    let hi = bounds.length - 1
    while (lo < hi)
    {
        const mid = (lo + hi + 1) >> 1
        const w = mc.measureText(text.substring(0, bounds[mid])).width
        if (w <= targetX) lo = mid
        else hi = mid - 1
    }

    let offset = bounds[lo]
    if (lo < bounds.length - 1)
    {
        const wLo = bounds[lo] === 0
            ? 0
            : mc.measureText(text.substring(0, bounds[lo])).width
        const wHi = mc.measureText(text.substring(0, bounds[lo + 1])).width
        if ((targetX - wLo) > (wHi - targetX)) offset = bounds[lo + 1]
    }
    return offset
}
