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
 * Marked lines can paint a little wider than the width they were broken to, and
 * a canvas sized to exactly the column guillotines the last glyph when they do.
 * This strip is transparent and nothing is *placed* in it: layout still wraps to
 * the content width, and selection, inline-decoration, and node-decoration rects
 * all still stop there. It exists only so a hair of overrun is drawn, not cut.
 *
 * Where the overrun comes from — measured, not guessed. Pretext lays marked text
 * out as styled runs and trims the whitespace between them into a `gapBefore` it
 * reserves on its own terms. The editor re-expands that whitespace so every
 * space stays an editable character, appends it to the *preceding* run, and
 * re-measures with `measureText` in that run's font. A space in Georgia and the
 * same space in its italic are not the same width, so each mark boundary on a
 * line contributes a fraction of a pixel, and a line crossing several of them
 * accumulates a few.
 *
 * Sweeping the demo document across 61 wrap widths (2,248 laid-out lines):
 *
 *   - 5 lines (0.2%) overran with real glyphs, worst case 5.1px, every one of
 *     them a marked line crossing a mark boundary;
 *   - 47 more "overran" by trailing whitespace only, which paints nothing;
 *   - no single-font line ever overran.
 *
 * 6px covers the measured worst case with room to spare. The honest fix is for
 * the editor to stop re-expanding whitespace into the painted text — CSS
 * `white-space: normal` renders a double space as one and still lets the caret
 * walk both — but that is the most caret-test-dependent code in the repo, and
 * `prepareRichInline` has no `pre-wrap` option to hand the problem back to.
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
