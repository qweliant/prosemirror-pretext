/**
 * Table layout — the first thing in this editor that puts two blocks side by
 * side.
 *
 * Every other block owns the full content column, so `computeLayout` can walk
 * the document with a single `cursorY` and never think about x. A table breaks
 * that: cells in a row share a vertical band and differ only in x, and a row's
 * height is not known until every cell in it has been laid out.
 *
 * The trick that keeps this small is that a cell is not a new kind of thing —
 * it is an ordinary flow of blocks laid out into a different `LayoutFrame`.
 * Cell contents come back as normal `BlockLayout`s with absolute coordinates,
 * so painting, caret mapping, and selection keep working on them unchanged.
 * Only the grid chrome (rules, header fills) is new, and that is pure geometry.
 *
 * Geometry runs off `buildGrid`, so `colspan` and `rowspan` are resolved before
 * any measuring happens — a spanning cell is placed by its grid coordinate, not
 * by its index in its row.
 */

import type { Node as PMNode } from 'prosemirror-model'
import type { BlockLayout, LayoutFrame, TableCellBox, TableChrome } from '../types'
import { isHeaderCell } from './blocks'
import { buildGrid, type TableGrid } from './table-map'
import { CELL_PAD_X, CELL_PAD_Y, MIN_COL_WIDTH, TABLE_BORDER } from '../constants'

export interface TableLayoutResult
{
    /** Cell content, already positioned, in document order. */
    blocks: BlockLayout[]
    chrome: TableChrome
    height: number
    /** Chrome for any tables nested inside this one's cells. */
    nested: TableChrome[]
}

export interface TableLayoutContext
{
    blockGap: number
    /**
     * Lay a cell's whole content out inside `frame`, starting at `originY`.
     * Supplied by the editor rather than reimplemented here so cell content
     * goes through the same flow as the document itself — paragraphs, lists,
     * leaf nodes, and nested tables all work without this module knowing what
     * any of them are.
     */
    layoutFlow: (
        parent: PMNode,
        contentStart: number,
        originY: number,
        frame: LayoutFrame,
    ) => { blocks: BlockLayout[], tables: TableChrome[], height: number }
}

/** Total space a cell spends on borders and padding, per axis. */
const CELL_INSET_X = 2 * (TABLE_BORDER + CELL_PAD_X)
const CELL_INSET_Y = 2 * (TABLE_BORDER + CELL_PAD_Y)

/**
 * Share `total` out across the grid's columns, honoring any explicit
 * `colwidth` (prosemirror-tables writes these on column resize) and splitting
 * the remainder evenly. Rounded to whole pixels with the drift pushed into the
 * last column, so the table's right edge lands exactly on the frame's —
 * otherwise the outer rule wobbles by a pixel.
 */
export function columnWidths(grid: TableGrid, total: number): number[]
{
    const count = grid.width
    const explicit: (number | null)[] = new Array(count).fill(null)
    for (const cell of grid.cells)
    {
        const cw = cell.node.attrs['colwidth'] as number[] | null | undefined
        if (!cw) continue
        // A cell pins the widths of the columns it covers, one entry each.
        for (let i = 0; i < cell.colspan; i++)
        {
            const c = cell.col + i
            if (c < count && explicit[c] === null && cw[i] > 0) explicit[c] = cw[i]
        }
    }

    const knownSum = explicit.reduce<number>((s, w) => s + (w ?? 0), 0)
    const unknown = explicit.filter((w) => w === null).length
    const each = unknown > 0
        ? Math.max(MIN_COL_WIDTH, (total - knownSum) / unknown)
        : 0

    let widths = explicit.map((w) => w ?? each)
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
): TableLayoutResult
{
    const grid = buildGrid(table, pos)
    if (grid.width === 0 || grid.height === 0)
    {
        return {
            blocks: [],
            chrome: {
                x: frame.x, y: originY, width: frame.width, height: 0,
                pos, rows: [], cols: [], cells: [],
            },
            height: 0,
            nested: [],
        }
    }

    const widths = columnWidths(grid, frame.width)
    const colX: number[] = []
    for (let i = 0, x = frame.x; i < grid.width; i++) { colX.push(x); x += widths[i] }
    const spanWidth = (col: number, span: number): number =>
    {
        let w = 0
        for (let i = col; i < Math.min(col + span, grid.width); i++) w += widths[i]
        return w
    }

    // ── Pass 1: lay each cell's content out at a provisional origin ──
    // Cells are top-aligned, so a cell's blocks can be placed relative to its
    // own top before row positions are final; only a vertical offset is
    // outstanding, and rows above are resolved before rows below need it.
    const measured = grid.cells.map((cell) =>
    {
        const inner: LayoutFrame = {
            x: colX[cell.col] + TABLE_BORDER + CELL_PAD_X,
            width: Math.max(1, spanWidth(cell.col, cell.colspan) - CELL_INSET_X),
        }
        const flow = cx.layoutFlow(cell.node, cell.pos + 1, 0, inner)
        return { cell, flow, needed: flow.height + CELL_INSET_Y }
    })

    // ── Pass 2: size rows ──
    // A single-row cell constrains its own row. A rowspan cell constrains the
    // *sum* of the rows it covers, so it is applied afterwards and any shortfall
    // is given to its last row — the row that can grow without disturbing the
    // ones a shorter cell already fixed.
    const rowHeights = new Array<number>(grid.height).fill(0)
    for (const m of measured)
    {
        if (m.cell.rowspan !== 1) continue
        rowHeights[m.cell.row] = Math.max(rowHeights[m.cell.row], m.needed)
    }
    for (const m of measured)
    {
        if (m.cell.rowspan === 1) continue
        const last = Math.min(m.cell.row + m.cell.rowspan, grid.height) - 1
        let covered = 0
        for (let r = m.cell.row; r <= last; r++) covered += rowHeights[r]
        if (m.needed > covered) rowHeights[last] += m.needed - covered
    }
    // A row with no single-row cell at all (every cell spanning into it) can
    // still be zero; give it the minimum a cell would occupy empty.
    for (let r = 0; r < grid.height; r++)
    {
        if (rowHeights[r] === 0) rowHeights[r] = CELL_INSET_Y
    }

    const rowY: number[] = []
    for (let r = 0, y = originY; r < grid.height; r++) { rowY.push(y); y += rowHeights[r] }
    const height = rowHeights.reduce((s, h) => s + h, 0)

    // ── Pass 3: place ──
    const blocks: BlockLayout[] = []
    const tables: TableChrome[] = []
    const cells: TableCellBox[] = []

    for (const m of measured)
    {
        const { cell, flow } = m
        const top = rowY[cell.row]
        const lastRow = Math.min(cell.row + cell.rowspan, grid.height) - 1
        let boxH = 0
        for (let r = cell.row; r <= lastRow; r++) boxH += rowHeights[r]

        const dy = top + TABLE_BORDER + CELL_PAD_Y
        for (const b of flow.blocks) shiftBlock(b, dy)
        for (const t of flow.tables) shiftChrome(t, dy)
        blocks.push(...flow.blocks)
        tables.push(...flow.tables)

        cells.push({
            x: colX[cell.col],
            y: top,
            width: spanWidth(cell.col, cell.colspan),
            height: boxH,
            row: cell.row,
            col: cell.col,
            header: isHeaderCell(cell.node),
            pos: cell.pos,
        })
    }

    // Document order keeps the sorted-by-position invariant the caret's binary
    // search and the incremental-layout diff both rely on.
    blocks.sort((a, b) => a.pmStartPos - b.pmStartPos)

    const chrome: TableChrome = {
        x: frame.x,
        y: originY,
        width: frame.width,
        height,
        pos,
        rows: rowY.map((y, i) => ({ y, height: rowHeights[i] })),
        cols: colX.map((x, i) => ({ x, width: widths[i] })),
        cells: cells.sort((a, b) => a.pos - b.pos),
    }
    return { blocks, chrome, height, nested: tables }
}

/** Move a laid-out block (and its lines) down by `dy`. */
function shiftBlock(b: BlockLayout, dy: number): void
{
    b.yOffset += dy
    for (const line of b.lines) line.y += dy
}

/** Move a nested table's chrome down by `dy`. */
function shiftChrome(t: TableChrome, dy: number): void
{
    t.y += dy
    for (const r of t.rows) r.y += dy
    for (const c of t.cells) c.y += dy
}

export { buildGrid }
export type { TableGrid }
