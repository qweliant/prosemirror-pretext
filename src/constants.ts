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
 * Insurance, now that the overrun it was built for is fixed at the source.
 *
 * The history is worth keeping, because the strip is the reason the bug was
 * survivable. Pretext lays marked text out as styled runs and trims the
 * whitespace between them into a `gapBefore` it reserves on its own terms. The
 * editor re-expands that whitespace so every space stays an editable
 * character, and it used to *re-measure* it in the preceding run's font —
 * answering a slightly different question than the engine had, once per mark
 * boundary, cumulatively. Every later fragment on the line was pushed right by
 * the running error, so a line crossing several boundaries painted past the
 * width it was broken to, and a canvas sized to exactly the column guillotined
 * its last glyph.
 *
 * Across fonts of one family that is hundredths of a pixel. Across a family
 * switch — an inline `code` span in prose, serif to monospace — a real-browser
 * sweep measured over 11px, well past this strip. `buildMarkedLine` now
 * advances by Pretext's own `gapBefore`, so the editor and the engine agree
 * about where a line ends; the same sweep measures 0.00px of painted overshoot.
 * `check/` is that sweep, and it runs in CI.
 *
 * The strip stays because it costs nothing — transparent, nothing *placed* in
 * it, layout still wraps to the content width, and selection, inline-decoration
 * and node-decoration rects all still stop there — and because glyph side
 * bearings are a different source of overhang from the one that was fixed. It
 * is now headroom rather than a mitigation.
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

/**
 * How close to a scroller's edge a drag must come before the view starts
 * following it, and how fast it moves at the very edge (px per frame).
 *
 * The band is capped at a third of the scroller so a short editor doesn't end
 * up with overlapping top and bottom trigger zones — which would make the
 * middle of it scroll in both directions at once.
 */
export const AUTOSCROLL_ZONE_PX = 40
export const AUTOSCROLL_SPEED_PX = 14


// ─── Touch ─────────────────────────────────────────────────────────────────

/** Longest gap between taps that still counts as part of the same multi-tap. */
export const MULTI_TAP_MS = 320
/** How far a follow-up tap may land from the first and still count. */
export const MULTI_TAP_SLOP_PX = 24

/**
 * The magnifier shown while a finger is placing or extending a selection.
 *
 * A fingertip covers the very text it is aiming at, so the loupe repeats that
 * region above the touch — the region is copied straight off the editor's own
 * canvas, which is the one place the rendered text already exists as pixels.
 */
export const LOUPE_WIDTH = 112
export const LOUPE_HEIGHT = 56
export const LOUPE_ZOOM = 1.5
/** How far above the touch point the loupe floats. */
export const LOUPE_LIFT = 76
/** Where it goes instead when the touch is too near the top for that. */
export const LOUPE_DROP = 30
