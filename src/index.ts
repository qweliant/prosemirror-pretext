export { CanvasEditor } from './editor'
export type {
    CanvasEditorOptions,
    RenderStats,
    BlockLayout,
    LineLayout,
    LineFragment,
    MarkStyle,
    MarkStyleResolver,
    BlockStyle,
    BlockStyleResolver,
    FloatRect,
    NodeViewFn,
    EditorHandlers,
} from './editor'
export { markSpecs, buildMarkKeymap } from './marks'
export { Decoration } from './decoration'
export type {
    InlineDecoration,
    NodeDecoration,
    WidgetDecoration,
    InlineDecorationStyle,
    NodeDecorationStyle,
} from './decoration'

// ─── Tables ────────────────────────────────────────────────────────────────
export { CellSelection, selectCells } from './table-selection'
export {
    addRowBefore, addRowAfter, deleteRow,
    addColumnBefore, addColumnAfter, deleteColumn,
    deleteTable, selectRow, selectColumn, goToNextCell, tableKeymap,
} from './table-commands'
export { buildGrid, cellAt, cellAtPos, cellsInRect, rectBetween, findTable } from './layout/table-map'
export type { TableGrid, GridCell } from './layout/table-map'
