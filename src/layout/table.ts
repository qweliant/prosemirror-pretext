/**
 * Table layout — the first thing in this editor that puts two blocks side by
 * side.
 *
 * Every other block owns the full content column, so `computeLayout` can walk
 * the document with a single `cursorY` and never think about x. A table breaks
 * that: cells in a row share a vertical band and differ only in x, and the
 * row's height is not known until every cell in it has been laid out.
 *
 * The trick that keeps this small is that a cell is not a new kind of thing —
 * it is an ordinary block laid out into a different `LayoutFrame`. Cell
 * contents come back as normal `BlockLayout`s with absolute coordinates, so
 * painting, caret mapping, and selection keep working on them unchanged. Only
 * the grid chrome (rules, header fills) is new, and that is pure geometry.
 *
 * Cells are top-aligned, which is why one pass suffices: a cell's blocks can be
 * placed as they are measured, and the row only needs the max height afterwards
 * to size its boxes. Vertical centering would require a second pass.
 *
 * Not yet handled: `rowspan` (a spanning cell is laid out in its first row and
 * does not reserve height below), and non-textblock cell content such as nested
 * lists or nested tables.
 */

import type { Node as PMNode } from 'prosemirror-model'
import type { BlockLayout, LayoutFrame, TableCellBox, TableChrome } from '../types'
import { isHeaderCell, isTableRow } from './blocks'
import { CELL_PAD_X, CELL_PAD_Y, MIN_COL_WIDTH, TABLE_BORDER } from '../constants'

export interface TableLayoutContext
{
    blockGap: number
    /**
     * Lay out one block inside a cell. Supplied by the editor rather than
     * reimplemented here so cell content goes through the exact same pipeline
     * as everything else — styles, marks, the layout cache.
     */
    layoutBlock: (
        node: PMNode,
        pos: number,
        cursorY: number,
        frame: LayoutFrame,
    ) => BlockLayout
}

/** Total horizontal space a cell spends on borders and padding. */
const CELL_INSET_X = 2 * (TABLE_BORDER + CELL_PAD_X)
const CELL_INSET_Y = 2 * (TABLE_BORDER + CELL_PAD_Y)

const colspanOf = (cell: PMNode): number =>
    Math.max(1, (cell.attrs['colspan'] as number) ?? 1)

/** The grid width of a row, counting spans. */
function rowColumnCount(row: PMNode): number
{
    let n = 0
    row.forEach((cell) => { n += colspanOf(cell) })
    return n
}

/**
 * Share `total` out across `count` columns, honoring any explicit `colwidth`
 * attributes (prosemirror-tables writes these when a column is resized) and
 * splitting what remains evenly. Widths are rounded to whole pixels with the
 * drift pushed into the last column, so the table's right edge lands exactly
 * on the frame's — otherwise rounding makes the outer rule wobble by a pixel.
 */
export function columnWidths(rows: PMNode[], count: number, total: number): number[]
{
    const explicit: (number | null)[] = new Array(count).fill(null)
    for (const row of rows)
    {
        let c = 0
        row.forEach((cell) =>
        {
            const span = colspanOf(cell)
            const cw = cell.attrs['colwidth'] as number[] | null | undefined
            // Only single-column cells pin a width; a spanning cell says
            // nothing unambiguous about any one of the columns it covers.
            if (span === 1 && cw && cw[0] > 0 && explicit[c] === null) explicit[c] = cw[0]
            c += span
        })
    }

    const knownSum = explicit.reduce<number>((s, w) => s + (w ?? 0), 0)
    const unknown = explicit.filter((w) => w === null).length
    const each = unknown > 0
        ? Math.max(MIN_COL_WIDTH, (total - knownSum) / unknown)
        : 0

    let widths = explicit.map((w) => w ?? each)

    // Explicit widths can overflow the frame; scale everything to fit.
    const sum = widths.reduce((s, w) => s + w, 0)
    if (sum > 0 && sum !== total) widths = widths.map((w) => (w * total) / sum)

    const rounded = widths.map((w) => Math.max(MIN_COL_WIDTH, Math.round(w)))
    const drift = total - rounded.reduce((s, w) => s + w, 0)
    if (rounded.length > 0) rounded[rounded.length - 1] += drift
    return rounded
}

export function layoutTable(
    cx: TableLayoutContext,
    table: PMNode,
    pos: number,
    originY: number,
    frame: LayoutFrame,
): { blocks: BlockLayout[], chrome: TableChrome, height: number }
{
    const rows: { node: PMNode, pos: number }[] = []
    table.forEach((child, offset) =>
    {
        if (isTableRow(child)) rows.push({ node: child, pos: pos + 1 + offset })
    })

    const colCount = rows.reduce((n, r) => Math.max(n, rowColumnCount(r.node)), 0)
    if (colCount === 0 || rows.length === 0)
    {
        return {
            blocks: [],
            chrome: {
                x: frame.x, y: originY, width: frame.width, height: 0,
                pos, rows: [], cols: [], cells: [],
            },
            height: 0,
        }
    }

    const widths = columnWidths(rows.map((r) => r.node), colCount, frame.width)
    const colX: number[] = []
    let runningX = frame.x
    for (let i = 0; i < colCount; i++) { colX.push(runningX); runningX += widths[i] }

    const blocks: BlockLayout[] = []
    const cells: TableCellBox[] = []
    const rowRects: { y: number, height: number }[] = []

    let y = originY
    for (let r = 0; r < rows.length; r++)
    {
        const row = rows[r]
        // Cells are laid out where they start; the row's height is only known
        // once all of them have been measured, so boxes are sized afterwards.
        const pending: { box: TableCellBox, contentHeight: number }[] = []
        let col = 0

        row.node.forEach((cell, cellOffset) =>
        {
            const cellPos = row.pos + 1 + cellOffset
            const span = colspanOf(cell)
            const cellX = colX[Math.min(col, colCount - 1)]
            let cellW = 0
            for (let i = col; i < Math.min(col + span, colCount); i++) cellW += widths[i]

            const inner: LayoutFrame = {
                x: cellX + TABLE_BORDER + CELL_PAD_X,
                width: Math.max(1, cellW - CELL_INSET_X),
            }

            const contentTop = y + TABLE_BORDER + CELL_PAD_Y
            let cy = contentTop
            let laid = 0
            cell.forEach((child, childOffset) =>
            {
                if (!child.isTextblock) return
                const childPos = cellPos + 1 + childOffset
                const bl = cx.layoutBlock(child, childPos, cy, inner)
                blocks.push(bl)
                cy += bl.height + cx.blockGap
                laid++
            })
            const contentHeight = laid > 0 ? cy - contentTop - cx.blockGap : 0

            pending.push({
                box: {
                    x: cellX, y, width: cellW, height: 0,
                    row: r, col, header: isHeaderCell(cell), pos: cellPos,
                },
                contentHeight,
            })
            col += span
        })

        const rowHeight = pending.reduce(
            (h, p) => Math.max(h, p.contentHeight + CELL_INSET_Y),
            0,
        )
        for (const p of pending) { p.box.height = rowHeight; cells.push(p.box) }
        rowRects.push({ y, height: rowHeight })
        y += rowHeight
    }

    const height = y - originY
    return {
        blocks,
        chrome: {
            x: frame.x,
            y: originY,
            width: frame.width,
            height,
            pos,
            rows: rowRects,
            cols: colX.map((x, i) => ({ x, width: widths[i] })),
            cells,
        },
        height,
    }
}
