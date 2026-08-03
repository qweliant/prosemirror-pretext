/**
 * The grid model: resolving a table's rows and cells — which may span columns
 * and rows — into a rectangular grid of addressable positions.
 *
 * Everything that treats a table as a *grid* rather than a list of rows needs
 * this: laying out a `rowspan` cell, deleting a column, growing a cell
 * selection to a rectangle. Document order alone can't answer "what is directly
 * below this cell", because a spanning cell above shifts every later cell right.
 *
 * `prosemirror-tables` solves the same problem, and better in places — but its
 * only entry point imports `prosemirror-view` at module scope, which would make
 * the DOM view a runtime dependency of an editor whose whole point is not
 * having one. So the grid math lives here instead. The cell attribute names
 * (`colspan`, `rowspan`, `colwidth`) deliberately match theirs, so a
 * prosemirror-tables schema drops straight in.
 */

import type { Node as PMNode } from 'prosemirror-model'
import { isTableRow } from './blocks'

export interface GridCell
{
    node: PMNode
    /** Document position of the cell node itself. */
    pos: number
    /** Top-left grid coordinate the cell occupies. */
    row: number
    col: number
    rowspan: number
    colspan: number
}

export interface TableGrid
{
    /** Column count — the width of the widest row once spans are resolved. */
    width: number
    /** Row count. */
    height: number
    /** Unique cells in document order. */
    cells: GridCell[]
    /**
     * `width * height` entries; each holds the index into `cells` of whatever
     * occupies that slot. A spanning cell appears at every slot it covers, so
     * `cellAt` is a lookup rather than a search.
     */
    slots: number[]
    rows: { node: PMNode, pos: number }[]
}

const spanOf = (cell: PMNode, attr: 'colspan' | 'rowspan'): number =>
    Math.max(1, (cell.attrs[attr] as number) ?? 1)

/**
 * Resolve a table into a grid.
 *
 * The walk keeps an occupancy map: for each row, a cell takes the first column
 * not already claimed by a `rowspan` from above, then marks every slot it
 * covers. That single rule is what makes spans compose — a cell's grid column
 * is a function of what is above it, not of its index in its row.
 */
export function buildGrid(table: PMNode, tablePos: number): TableGrid
{
    const rows: { node: PMNode, pos: number }[] = []
    table.forEach((child, offset) =>
    {
        if (isTableRow(child)) rows.push({ node: child, pos: tablePos + 1 + offset })
    })

    const cells: GridCell[] = []
    // Sparse while building: `occupied[r][c]` is a cell index or undefined.
    const occupied: number[][] = rows.map(() => [])
    let width = 0

    for (let r = 0; r < rows.length; r++)
    {
        let col = 0
        rows[r].node.forEach((cellNode, cellOffset) =>
        {
            // Skip past slots already taken by a rowspan from an earlier row.
            while (occupied[r][col] !== undefined) col++

            const colspan = spanOf(cellNode, 'colspan')
            const rowspan = spanOf(cellNode, 'rowspan')
            const index = cells.length
            cells.push({
                node: cellNode,
                pos: rows[r].pos + 1 + cellOffset,
                row: r, col, rowspan, colspan,
            })

            for (let dr = 0; dr < rowspan && r + dr < rows.length; dr++)
            {
                for (let dc = 0; dc < colspan; dc++)
                {
                    occupied[r + dr][col + dc] = index
                }
            }
            col += colspan
            if (col > width) width = col
        })
    }

    const height = rows.length
    const slots = new Array<number>(width * height).fill(-1)
    for (let r = 0; r < height; r++)
    {
        for (let c = 0; c < width; c++)
        {
            const i = occupied[r][c]
            if (i !== undefined) slots[r * width + c] = i
        }
    }

    return { width, height, cells, slots, rows }
}

/** The cell occupying a grid slot, or null when the table is ragged there. */
export function cellAt(grid: TableGrid, row: number, col: number): GridCell | null
{
    if (row < 0 || col < 0 || row >= grid.height || col >= grid.width) return null
    const i = grid.slots[row * grid.width + col]
    return i < 0 ? null : grid.cells[i]
}

/** The grid cell containing a document position, or null if outside the table. */
export function cellAtPos(grid: TableGrid, pos: number): GridCell | null
{
    for (const c of grid.cells)
    {
        if (pos > c.pos && pos < c.pos + c.node.nodeSize) return c
    }
    return null
}

/**
 * The smallest rectangle of grid coordinates covering both cells. Spanning
 * cells make this iterative: pulling a wide cell into the rectangle can widen
 * it, which can pull in another spanning cell, and so on until it settles.
 * Without this a cell selection could clip a merged cell in half.
 */
export function rectBetween(
    grid: TableGrid,
    a: GridCell,
    b: GridCell,
): { top: number, left: number, bottom: number, right: number }
{
    let top = Math.min(a.row, b.row)
    let left = Math.min(a.col, b.col)
    let bottom = Math.max(a.row + a.rowspan, b.row + b.rowspan)
    let right = Math.max(a.col + a.colspan, b.col + b.colspan)

    for (let changed = true; changed;)
    {
        changed = false
        for (const c of grid.cells)
        {
            const overlaps = c.row < bottom && c.row + c.rowspan > top
                && c.col < right && c.col + c.colspan > left
            if (!overlaps) continue
            if (c.row < top) { top = c.row; changed = true }
            if (c.col < left) { left = c.col; changed = true }
            if (c.row + c.rowspan > bottom) { bottom = c.row + c.rowspan; changed = true }
            if (c.col + c.colspan > right) { right = c.col + c.colspan; changed = true }
        }
    }
    return { top, left, bottom, right }
}

/** Unique cells inside a grid rectangle, in document order. */
export function cellsInRect(
    grid: TableGrid,
    rect: { top: number, left: number, bottom: number, right: number },
): GridCell[]
{
    const seen = new Set<number>()
    const out: GridCell[] = []
    for (let r = rect.top; r < rect.bottom; r++)
    {
        for (let c = rect.left; c < rect.right; c++)
        {
            const i = grid.slots[r * grid.width + c]
            if (i < 0 || seen.has(i)) continue
            seen.add(i)
            out.push(grid.cells[i])
        }
    }
    return out.sort((x, y) => x.pos - y.pos)
}

/** The table node enclosing `pos`, with its position, or null. */
export function findTable(
    doc: PMNode,
    pos: number,
): { node: PMNode, pos: number } | null
{
    const $pos = doc.resolve(Math.max(0, Math.min(pos, doc.content.size)))
    for (let d = $pos.depth; d > 0; d--)
    {
        const n = $pos.node(d)
        if (n.type.name === 'table') return { node: n, pos: $pos.before(d) }
    }
    return null
}
