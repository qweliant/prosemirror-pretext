/**
 * Table editing commands: add and remove rows and columns.
 *
 * All of them are ordinary ProseMirror `Command`s — `(state, dispatch) =>
 * boolean` — so they bind through the existing `keymap` option, run through
 * `editor.command()`, and land in history as single undo steps. Nothing here
 * touches the editor or the DOM.
 *
 * Spans are the whole difficulty. "The column at index 2" is a grid coordinate,
 * not a child index: a cell may start left of the column and reach into it, in
 * which case the right edit is to narrow that cell rather than delete it. Every
 * command below works off the resolved grid for that reason.
 */

import { Fragment, type Node as PMNode, type NodeType } from 'prosemirror-model'
import type { Command, EditorState, Transaction } from 'prosemirror-state'
import { TextSelection } from 'prosemirror-state'
import {
    buildGrid, cellAt, cellAtPos, findTable, type GridCell, type TableGrid,
} from './layout/table-map'
import { CellSelection } from './table-selection'

interface Ctx
{
    table: { node: PMNode, pos: number }
    grid: TableGrid
    cell: GridCell
}

/** Resolve the table, grid, and the cell the selection sits in. */
function ctxFor(state: EditorState): Ctx | null
{
    const sel = state.selection
    const probe = sel instanceof CellSelection ? sel.headCell + 1 : sel.from
    const table = findTable(state.doc, probe)
    if (!table) return null
    const grid = buildGrid(table.node, table.pos)
    const cell = cellAtPos(grid, probe)
    if (!cell) return null
    return { table, grid, cell }
}

/** An empty cell of the same type as `like`, carrying a reset colspan/rowspan. */
function emptyCellLike(like: PMNode): PMNode
{
    const attrs = { ...like.attrs, colspan: 1, rowspan: 1, colwidth: null }
    const inner = like.type.contentMatch.defaultType?.createAndFill()
    return like.type.createChecked(attrs, inner ? Fragment.from(inner) : Fragment.empty)
}

const setSpan = (cell: PMNode, attr: 'colspan' | 'rowspan', value: number): PMNode =>
    cell.type.create({ ...cell.attrs, [attr]: value }, cell.content, cell.marks)

// ─── Rows ──────────────────────────────────────────────────────────────────

function addRow(state: EditorState, dispatch: ((tr: Transaction) => void) | undefined, after: boolean): boolean
{
    const cx = ctxFor(state)
    if (!cx) return false
    const { table, grid, cell } = cx
    // Insert below the *bottom* of the anchor cell when adding after, so a
    // rowspan cell doesn't get a row wedged into its middle.
    const at = after ? cell.row + cell.rowspan : cell.row
    if (at < 0 || at > grid.height) return false
    if (!dispatch) return true

    const rowType = grid.rows[0]?.node.type
    if (!rowType) return false

    const cells: PMNode[] = []
    for (let col = 0; col < grid.width;)
    {
        const occupant = cellAt(grid, Math.min(at, grid.height - 1), col)
        // A cell spanning across this boundary grows instead of being split.
        const spanning = occupant
            && occupant.row < at && occupant.row + occupant.rowspan > at
        if (spanning && occupant)
        {
            col += occupant.colspan
            continue
        }
        const template = occupant?.node ?? grid.cells[0].node
        cells.push(emptyCellLike(template))
        col += 1
    }

    const tr = state.tr
    // Grow any cell that straddles the insertion line.
    for (const c of grid.cells)
    {
        if (c.row < at && c.row + c.rowspan > at)
        {
            tr.setNodeMarkup(tr.mapping.map(c.pos), undefined, {
                ...c.node.attrs, rowspan: c.rowspan + 1,
            })
        }
    }
    const insertPos = at >= grid.rows.length
        ? table.pos + table.node.nodeSize - 1
        : grid.rows[at].pos
    tr.insert(tr.mapping.map(insertPos), rowType.createChecked(null, Fragment.from(cells)))
    dispatch(tr.scrollIntoView())
    return true
}

export const addRowBefore: Command = (state, dispatch) => addRow(state, dispatch, false)
export const addRowAfter: Command = (state, dispatch) => addRow(state, dispatch, true)

export const deleteRow: Command = (state, dispatch) =>
{
    const cx = ctxFor(state)
    if (!cx) return false
    const { table, grid, cell } = cx
    if (grid.height <= 1) return false          // last row: delete the table instead
    const row = cell.row
    if (!dispatch) return true

    const tr = state.tr
    // Shrink cells that reach into this row from above; drop cells that start
    // here but reach below by re-homing them into the next row.
    for (const c of grid.cells)
    {
        if (c.rowspan === 1) continue
        if (c.row < row && c.row + c.rowspan > row)
        {
            tr.setNodeMarkup(tr.mapping.map(c.pos), undefined, {
                ...c.node.attrs, rowspan: c.rowspan - 1,
            })
        }
        else if (c.row === row && c.rowspan > 1)
        {
            const next = grid.rows[row + 1]
            if (next)
            {
                tr.insert(
                    tr.mapping.map(next.pos + 1),
                    setSpan(c.node, 'rowspan', c.rowspan - 1),
                )
            }
        }
    }
    const target = grid.rows[row]
    tr.delete(tr.mapping.map(target.pos), tr.mapping.map(target.pos + target.node.nodeSize))
    dispatch(setNearbyTextSelection(tr, table.pos).scrollIntoView())
    return true
}

// ─── Columns ───────────────────────────────────────────────────────────────

function addColumn(state: EditorState, dispatch: ((tr: Transaction) => void) | undefined, after: boolean): boolean
{
    const cx = ctxFor(state)
    if (!cx) return false
    const { grid, cell } = cx
    const at = after ? cell.col + cell.colspan : cell.col
    if (!dispatch) return true

    const tr = state.tr
    for (let r = 0; r < grid.height; r++)
    {
        const occupant = cellAt(grid, r, Math.min(at, grid.width - 1))
        // Straddling the insertion line: widen rather than insert.
        if (occupant && occupant.col < at && occupant.col + occupant.colspan > at)
        {
            if (occupant.row === r)
            {
                tr.setNodeMarkup(tr.mapping.map(occupant.pos), undefined, {
                    ...occupant.node.attrs, colspan: occupant.colspan + 1,
                })
            }
            continue
        }
        // A rowspan cell from above already covers this row at this column.
        if (occupant && occupant.row < r && at >= occupant.col
            && at < occupant.col + occupant.colspan) continue

        const template = occupant?.node ?? grid.cells[0].node
        const insertAt = at >= grid.width || !occupant
            ? grid.rows[r].pos + grid.rows[r].node.nodeSize - 1
            : occupant.pos
        tr.insert(tr.mapping.map(insertAt), emptyCellLike(template))
    }
    dispatch(tr.scrollIntoView())
    return true
}

export const addColumnBefore: Command = (state, dispatch) => addColumn(state, dispatch, false)
export const addColumnAfter: Command = (state, dispatch) => addColumn(state, dispatch, true)

export const deleteColumn: Command = (state, dispatch) =>
{
    const cx = ctxFor(state)
    if (!cx) return false
    const { table, grid, cell } = cx
    if (grid.width <= 1) return false
    const col = cell.col
    if (!dispatch) return true

    const tr = state.tr
    const handled = new Set<number>()
    for (let r = 0; r < grid.height; r++)
    {
        const occupant = cellAt(grid, r, col)
        if (!occupant || handled.has(occupant.pos)) continue
        handled.add(occupant.pos)
        if (occupant.colspan > 1)
        {
            // The cell covers more than this column — narrow it.
            tr.setNodeMarkup(tr.mapping.map(occupant.pos), undefined, {
                ...occupant.node.attrs, colspan: occupant.colspan - 1,
            })
        }
        else
        {
            const from = tr.mapping.map(occupant.pos)
            tr.delete(from, from + occupant.node.nodeSize)
        }
    }
    dispatch(setNearbyTextSelection(tr, table.pos).scrollIntoView())
    return true
}

// ─── Whole table ───────────────────────────────────────────────────────────

export const deleteTable: Command = (state, dispatch) =>
{
    const table = findTable(state.doc, state.selection.from)
    if (!table) return false
    if (!dispatch) return true
    dispatch(state.tr.delete(table.pos, table.pos + table.node.nodeSize).scrollIntoView())
    return true
}

/** Select the row / column the cursor sits in. */
export const selectRow: Command = (state, dispatch) =>
{
    const sel = CellSelection.rowSelection(state.doc, state.selection.from)
    if (!sel) return false
    if (dispatch) dispatch(state.tr.setSelection(sel))
    return true
}

export const selectColumn: Command = (state, dispatch) =>
{
    const sel = CellSelection.colSelection(state.doc, state.selection.from)
    if (!sel) return false
    if (dispatch) dispatch(state.tr.setSelection(sel))
    return true
}

/**
 * Move to the next / previous cell, the way Tab does in every other editor.
 * At the last cell, Tab appends a row rather than escaping the table.
 */
export function goToNextCell(dir: 1 | -1): Command
{
    return (state, dispatch) =>
    {
        const cx = ctxFor(state)
        if (!cx) return false
        const { grid, cell } = cx
        const idx = grid.cells.findIndex((c) => c.pos === cell.pos)
        const next = grid.cells[idx + dir]
        if (!next)
        {
            if (dir === -1) return false
            return addRowAfter(state, dispatch)
        }
        if (!dispatch) return true
        dispatch(
            state.tr
                .setSelection(TextSelection.near(state.doc.resolve(next.pos + 1)))
                .scrollIntoView(),
        )
        return true
    }
}

/** After a structural delete the old selection may point into removed content. */
function setNearbyTextSelection(tr: Transaction, near: number): Transaction
{
    const pos = Math.min(Math.max(near, 0), tr.doc.content.size)
    return tr.setSelection(TextSelection.near(tr.doc.resolve(pos)))
}

/** Default bindings — merge into the `keymap` option. */
export function tableKeymap(): Record<string, Command>
{
    return {
        Tab: goToNextCell(1),
        'Shift-Tab': goToNextCell(-1),
    }
}

export type { NodeType }
