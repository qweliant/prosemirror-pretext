/**
 * `CellSelection` — a selection of a rectangle of table cells.
 *
 * A text selection is a range; a cell selection is a *shape*. Selecting from
 * one cell to another has to snap outward to a full rectangle, because a merged
 * cell cannot be half-selected, and the rectangle must survive spans pulling it
 * wider. That logic lives in `rectBetween`; this class is the ProseMirror
 * plumbing around it.
 *
 * It is a real `Selection` subclass rather than editor-local state so it maps
 * through transactions, survives undo/redo, and lets ordinary commands
 * (`deleteSelection` and friends) see the selected cells as ranges.
 *
 * Deliberately not `prosemirror-tables`' CellSelection, which is better tested
 * but reachable only through an entry point that imports `prosemirror-view`.
 * The JSON id (`"cell"`) and the attribute names match theirs, so documents and
 * schemas move between the two.
 */

import { Fragment, Slice, type Node as PMNode, type ResolvedPos } from 'prosemirror-model'
import { Selection, SelectionRange, type Transaction } from 'prosemirror-state'
import type { Mappable } from 'prosemirror-transform'
import {
    buildGrid, cellAtPos, cellsInRect, findTable, rectBetween, type GridCell,
} from './layout/table-map'

/** Resolve the grid and the two anchor/head cells for a pair of positions. */
function resolveCells(doc: PMNode, anchorPos: number, headPos: number)
{
    const table = findTable(doc, anchorPos)
    if (!table) return null
    const grid = buildGrid(table.node, table.pos)
    const anchor = cellAtPos(grid, anchorPos)
    const head = cellAtPos(grid, headPos) ?? anchor
    if (!anchor || !head) return null
    return { table, grid, anchor, head }
}

export class CellSelection extends Selection
{
    /** Document position of the anchor cell node. */
    readonly anchorCell: number
    /** Document position of the head cell node. */
    readonly headCell: number
    /** The selected cells, in document order. */
    readonly cells: readonly GridCell[]

    constructor(doc: PMNode, anchorCell: number, headCell: number = anchorCell)
    {
        const resolved = resolveCells(doc, anchorCell + 1, headCell + 1)
        if (!resolved) throw new RangeError('CellSelection: positions are not in a table')
        const { grid, anchor, head } = resolved
        const cells = cellsInRect(grid, rectBetween(grid, anchor, head))

        const ranges = cells.map((c) => new SelectionRange(
            doc.resolve(c.pos + 1),
            doc.resolve(c.pos + c.node.nodeSize - 1),
        ))
        super(ranges[0].$from, ranges[ranges.length - 1].$to, ranges)

        this.anchorCell = anchor.pos
        this.headCell = head.pos
        this.cells = cells
    }

    /**
     * The caret is never drawn for a cell selection — the editor paints the
     * selected cell boxes instead, which is what makes it read as a shape.
     * (A plain field, not an accessor: `Selection` declares it as a property.)
     */
    override readonly visible: boolean = false

    eq(other: Selection): boolean
    {
        return other instanceof CellSelection
            && other.anchorCell === this.anchorCell
            && other.headCell === this.headCell
    }

    map(doc: PMNode, mapping: Mappable): Selection
    {
        const anchor = mapping.map(this.anchorCell, 1)
        const head = mapping.map(this.headCell, 1)
        try
        {
            const sel = new CellSelection(doc, anchor, head)
            return sel
        }
        catch
        {
            // The table (or these cells) no longer exist — fall back to a plain
            // text selection near where the anchor ended up, rather than
            // throwing out of a transaction.
            return Selection.near(doc.resolve(Math.min(anchor, doc.content.size)))
        }
    }

    /** The selected cells, as rows, so copy/paste round-trips a sub-table. */
    content(): Slice
    {
        const byRow = new Map<number, GridCell[]>()
        for (const c of this.cells)
        {
            const list = byRow.get(c.row) ?? []
            list.push(c)
            byRow.set(c.row, list)
        }
        const rowNodes: PMNode[] = []
        const table = findTable(this.$from.doc, this.anchorCell + 1)
        const rowType = table?.node.firstChild?.type
        for (const [, cellsInRow] of [...byRow.entries()].sort((a, b) => a[0] - b[0]))
        {
            const frag = Fragment.from(cellsInRow.map((c) => c.node))
            rowNodes.push(rowType ? rowType.create(null, frag) : cellsInRow[0].node)
        }
        const tableNode = table ? table.node.type.create(table.node.attrs, Fragment.from(rowNodes)) : null
        return new Slice(Fragment.from(tableNode ?? rowNodes), 0, 0)
    }

    toJSON(): { type: string, anchorCell: number, headCell: number }
    {
        return { type: 'cell', anchorCell: this.anchorCell, headCell: this.headCell }
    }

    static fromJSON(doc: PMNode, json: { anchorCell: number, headCell: number }): CellSelection
    {
        return new CellSelection(doc, json.anchorCell, json.headCell)
    }

    /** Whether two positions sit in different cells of the same table. */
    static spansCells(doc: PMNode, a: number, b: number): boolean
    {
        const resolved = resolveCells(doc, a, b)
        if (!resolved) return false
        const { grid } = resolved
        const ca = cellAtPos(grid, a)
        const cb = cellAtPos(grid, b)
        return !!ca && !!cb && ca.pos !== cb.pos
    }

    /**
     * A cell selection covering both positions, or null when they are not in
     * two different cells of one table. This is the hook drag-selection uses:
     * once a drag leaves its starting cell, the selection stops being textual.
     */
    static between(doc: PMNode, a: number, b: number): CellSelection | null
    {
        const resolved = resolveCells(doc, a, b)
        if (!resolved) return null
        const { anchor, head } = resolved
        if (anchor.pos === head.pos) return null
        return new CellSelection(doc, anchor.pos, head.pos)
    }

    /** Select an entire row (used by row handles / commands). */
    static rowSelection(doc: PMNode, pos: number): CellSelection | null
    {
        const resolved = resolveCells(doc, pos, pos)
        if (!resolved) return null
        const { grid, anchor } = resolved
        const left = grid.cells.find((c) => c.row === anchor.row && c.col === 0)
        let right: GridCell | null = null
        for (const c of grid.cells)
        {
            if (c.row <= anchor.row && c.row + c.rowspan > anchor.row) right = c
        }
        if (!left || !right) return null
        return new CellSelection(doc, left.pos, right.pos)
    }

    /** Select an entire column. */
    static colSelection(doc: PMNode, pos: number): CellSelection | null
    {
        const resolved = resolveCells(doc, pos, pos)
        if (!resolved) return null
        const { grid, anchor } = resolved
        let top: GridCell | null = null
        let bottom: GridCell | null = null
        for (const c of grid.cells)
        {
            if (c.col <= anchor.col && c.col + c.colspan > anchor.col)
            {
                if (!top || c.row < top.row) top = c
                if (!bottom || c.row > bottom.row) bottom = c
            }
        }
        if (!top || !bottom) return null
        return new CellSelection(doc, top.pos, bottom.pos)
    }
}

// Register so `Selection.fromJSON` round-trips a serialized cell selection.
Selection.jsonID('cell', CellSelection)

/** Put a cell selection on a transaction. */
export function selectCells(tr: Transaction, anchorCell: number, headCell: number): Transaction
{
    return tr.setSelection(new CellSelection(tr.doc, anchorCell, headCell))
}
