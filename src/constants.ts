/**
 * Module-level constants shared across the editor's subsystems. Grouped by the
 * area that owns them rather than alphabetically, so a change to (say) list
 * geometry reads as one thing.
 */

import type { MarkStyleResolver } from './types'


// ─── Block styling ─────────────────────────────────────────────────────────

/** Multiplier applied to the base font size per heading level. */
export const HEADING_SCALE: Record<number, number> = {
    1: 2, 2: 1.5, 3: 1.25, 4: 1.1, 5: 1, 6: 0.9,
}

export const DEFAULT_MARK_STYLES: Record<string, MarkStyleResolver> = {
    strong: { fontWeight: 700 },
    em: { fontStyle: 'italic' },
    code: { fontFamily: 'monospace', color: '#9ece6a' },
    link: { color: '#7aa2f7', underline: true },
    underline: { underline: true },
    strikethrough: { strikethrough: true },
    textColor: (mark) => ({ color: mark.attrs['color'] as string }),
    highlight: (mark) => ({ background: (mark.attrs['color'] as string) || '#fde047' }),
    superscript: { verticalAlign: 'super' },
    subscript: { verticalAlign: 'sub' },
}


// ─── List geometry ─────────────────────────────────────────────────────────

/** Horizontal indent added per list nesting level. */
export const LIST_INDENT = 26
/** Left pad of a list marker within its gutter. */
export const MARKER_PAD = 4


// ─── Table geometry ────────────────────────────────────────────────────────

/** Padding inside each cell, between its border and its content. */
export const CELL_PAD_X = 8
export const CELL_PAD_Y = 6
/** Width of the rules drawn between cells and around the table. */
export const TABLE_BORDER = 1
/** Narrowest a column may be squeezed to when widths are shared out. */
export const MIN_COL_WIDTH = 32


// ─── Paint ─────────────────────────────────────────────────────────────────

/**
 * Canvas width beyond the content column, in px.
 *
 * Pretext breaks lines using its own metrics; the editor then re-measures every
 * run with `measureText` to place it. The two agree closely but not exactly, so
 * a line occasionally paints a few px wider than the column it was broken to. A
 * canvas sized to exactly the column guillotines the last glyph of those lines
 * — a visibly chopped letter, for a disagreement of about three pixels.
 *
 * This strip is transparent and nothing is *placed* in it: layout still wraps to
 * the content width, and selection, decoration, and node-decoration rects all
 * still stop there. It exists only so a hair of overrun is drawn rather than cut.
 * It is not a fix for the underlying disagreement, which is worth chasing down
 * to whichever measurement is wrong.
 */
export const TEXT_BLEED = 6


// ─── Remote carets (collaboration) ─────────────────────────────────────────

/** Width of a remote participant's caret. Matches the local caret. */
export const REMOTE_CARET_WIDTH = 2
/** The name flag beside a remote caret. */
export const CARET_LABEL_FONT = '600 11px system-ui, -apple-system, sans-serif'
export const CARET_LABEL_HEIGHT = 15
export const CARET_LABEL_PAD_X = 5
/** Baseline inset of the label text within its flag. */
export const CARET_LABEL_PAD_Y = 2


// ─── Accessibility ─────────────────────────────────────────────────────────

/** Elements that make a node view interactive (so it must stay in the a11y tree). */
export const FOCUSABLE_SEL =
    'a[href], button, input, select, textarea, [tabindex], [contenteditable="true"]'

/** Visually hidden, but kept in the accessibility tree (the "sr-only" recipe). */
export const SR_ONLY: Partial<CSSStyleDeclaration> = {
    position: 'absolute',
    width: '1px', height: '1px',
    margin: '-1px', padding: '0', border: '0',
    overflow: 'hidden', clip: 'rect(0 0 0 0)', clipPath: 'inset(50%)',
    whiteSpace: 'nowrap',
}


// ─── Input ─────────────────────────────────────────────────────────────────

/** Travel before a press on a node becomes a drag rather than a click. */
export const DRAG_THRESHOLD_PX = 6
