/**
 * Collapse / expand transitions for container nodes.
 *
 * The approach is the one the platform's View Transitions API takes, and the
 * one a browser compositor takes for any animation it can: never animate
 * layout. When a container collapses or expands, layout jumps to its final
 * state at once, so the document, the selection, hit-testing and every other
 * consumer of layout stay as simple as they are without animation. What
 * animates is the *picture*:
 *
 * - The frame on screen when the toggle happened is kept as a bitmap (the
 *   "before" snapshot).
 * - Each animation frame paints the final layout once, as usual (the "live"
 *   frame), and then recomposites the canvas from horizontal bands of the two
 *   bitmaps: everything above the box as painted, the box's interior revealed
 *   (or hidden) down to its animated height, the box's bottom edge drawn as a
 *   separate slice so its border and rounded corners stay intact (the
 *   nine-slice idea behind CSS `border-image`), and everything below the box
 *   slid by the difference between the animated and the final height.
 *
 * So a frame costs one ordinary paint plus a handful of `drawImage` blits, and
 * nothing is laid out at all. The interior comes from whichever bitmap holds
 * it: the live frame when expanding (the children are laid out now), the
 * snapshot when collapsing (they no longer are).
 *
 * Bands are full-width, which is only right for a box in a vertical flow. A
 * container inside a table cell has neighbours beside it at the same height,
 * so it isn't animated (the editor decides that, not this module).
 *
 * Everything here is geometry and bookkeeping; the editor owns the canvases.
 */
import type { Mappable } from 'prosemirror-transform'

/** A cubic Bézier easing curve, as CSS `cubic-bezier(x1, y1, x2, y2)`. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number
{
    const bez = (a: number, b: number, t: number) =>
        3 * a * (1 - t) * (1 - t) * t + 3 * b * (1 - t) * t * t + t * t * t
    const slope = (a: number, b: number, t: number) =>
        3 * a * (1 - t) * (1 - t) + 6 * (b - a) * (1 - t) * t + 3 * (1 - b) * t * t
    return (x: number) =>
    {
        if (x <= 0) return 0
        if (x >= 1) return 1
        // Solve bez(x1, x2, t) = x for t: Newton's method, which converges in a
        // few steps for easing curves, with bisection as the fallback.
        let t = x
        for (let i = 0; i < 8; i++)
        {
            const err = bez(x1, x2, t) - x
            if (Math.abs(err) < 1e-6) return bez(y1, y2, t)
            const d = slope(x1, x2, t)
            if (Math.abs(d) < 1e-6) break
            t -= err / d
        }
        let lo = 0
        let hi = 1
        t = x
        for (let i = 0; i < 30; i++)
        {
            const v = bez(x1, x2, t)
            if (Math.abs(v - x) < 1e-6) break
            if (v < x) lo = t
            else hi = t
            t = (lo + hi) / 2
        }
        return bez(y1, y2, t)
    }
}

/**
 * Material Design's "standard" easing: a quick start that settles gently, the
 * convention for an element changing size in place.
 */
export const standardEasing = cubicBezier(0.2, 0, 0, 1)

/** Default length of a collapse / expand, in ms (Material's "medium" range). */
export const DEFAULT_TRANSITION_MS = 220

/** A container box as one frame painted it. */
export interface BoxFrame
{
    /** Document position of the container node. */
    pos: number
    /** Top of the box, in the coordinates it was painted at. */
    top: number
    /** Height as painted (mid-transition, the animated height). */
    shown: number
    collapsed: boolean
}

/** The frame on screen when a transition started, kept as a bitmap. */
export interface Snapshot
{
    image: CanvasImageSource & { width: number, height: number }
    /** Document y of the bitmap's first row. */
    top: number
    /** Bitmap pixels per CSS pixel. */
    scale: number
}

/** One container's transition, in flight. */
interface Transition
{
    pos: number
    /** Height on screen when it started. */
    from: number
    start: number
    duration: number
    before: Snapshot
    /** Where the box was in the snapshot. */
    beforeTop: number
}

/** One box's state in the current frame. */
export interface Band
{
    /** Top of the box in the final layout. */
    top: number
    /** Height in the final layout. */
    final: number
    /** Height to draw it at this frame. */
    shown: number
    /** Height of the bottom-edge slice kept whole (border and corners). */
    cap: number
    /**
     * Where the interior comes from: the live frame when the box is growing
     * toward a taller final layout, the snapshot when shrinking.
     */
    source: 'live' | 'before'
    before: Snapshot
    beforeTop: number
    beforeHeight: number
}

/** The current frame of every transition: how final geometry is displaced. */
export class Presentation
{
    constructor(readonly bands: Band[]) {}

    get active(): boolean
    {
        return this.bands.length > 0
    }

    /** How much taller (positive) or shorter the picture is than the layout. */
    get offset(): number
    {
        let off = 0
        for (const b of this.bands) off += b.shown - b.final
        return off
    }

    /**
     * Where a point at final-layout `y` is drawn, and whether it is hidden
     * because it lies in a box's interior beyond what is revealed so far.
     */
    mapY(y: number): { y: number, hidden: boolean }
    {
        let off = 0
        for (const b of this.bands)
        {
            if (y < b.top) break
            if (y < b.top + b.final) return { y: y + off, hidden: y - b.top >= b.shown }
            off += b.shown - b.final
        }
        return { y: y + off, hidden: false }
    }

    /** The final-layout y under a drawn y: `mapY`'s inverse, for hit-testing. */
    unmapY(y: number): number
    {
        let off = 0
        for (const b of this.bands)
        {
            if (y < b.top + off) break
            if (y < b.top + off + b.shown) return y - off
            off += b.shown - b.final
        }
        return y - off
    }
}

/** One `drawImage` of a run of rows, in document coordinates. */
export interface CopyOp
{
    source: 'live' | Snapshot
    /** Source rows `[from, to)`, in the source's document coordinates. */
    from: number
    to: number
    /** Document y the first row lands at, in drawn coordinates. */
    dest: number
}

/**
 * The copies that build one frame from the live frame and the snapshots, for a
 * viewport `[viewTop, viewTop + viewHeight)` of drawn coordinates. Pure, so
 * the band arithmetic is tested without a canvas.
 */
export function planComposite(p: Presentation, viewTop: number, viewHeight: number): CopyOp[]
{
    const ops: CopyOp[] = []
    const viewBottom = viewTop + viewHeight
    // Copy source rows [a, b) of `source` to start at drawn y `dest`, trimmed
    // to what lands in the viewport.
    const copy = (source: CopyOp['source'], a: number, b: number, dest: number) =>
    {
        const lo = Math.max(a, a + (viewTop - dest))
        const hi = Math.min(b, b + (viewBottom - (dest + b - a)))
        if (hi > lo) ops.push({ source, from: lo, to: hi, dest: dest + (lo - a) })
    }
    let off = 0
    // Next final-layout row still to place. Rows above the viewport never
    // need placing, and before the first band nothing is displaced yet.
    let cursor = viewTop
    for (const b of p.bands)
    {
        copy('live', cursor, b.top, cursor + off)
        const top = b.top + off
        const src = b.source === 'live' ? 'live' : b.before
        const srcTop = b.source === 'live' ? b.top : b.beforeTop
        const srcHeight = b.source === 'live' ? b.final : b.beforeHeight
        const cap = Math.min(b.cap, b.shown / 2, srcHeight / 2)
        // The interior, cut off where the bottom edge begins...
        copy(src, srcTop, srcTop + b.shown - cap, top)
        // ...and the bottom edge itself, moved up (or down) to close the box.
        copy(src, srcTop + srcHeight - cap, srcTop + srcHeight, top + b.shown - cap)
        off += b.shown - b.final
        cursor = b.top + b.final
    }
    copy('live', cursor, viewBottom - off, cursor + off)
    return ops
}

/**
 * Starts, advances and retires transitions. The editor feeds it each frame's
 * container boxes and gets back a `Presentation` for that frame.
 */
export class BoxTransitions
{
    private running: Transition[] = []
    /** The boxes as the last frame drew them, in the current document's positions. */
    private seen: BoxFrame[] = []
    private current = new Presentation([])

    constructor(private readonly now: () => number = () => performance.now()) {}

    get presentation(): Presentation
    {
        return this.current
    }

    /** Keep stored positions in step with a transaction. */
    mapThrough(mapping: Mappable): void
    {
        const map = <T extends { pos: number }>(list: T[]) =>
            list.filter((x) =>
            {
                const r = mapping.mapResult(x.pos, 1)
                x.pos = r.pos
                // Not `deleted`: changing a node's attrs replaces its own open
                // token, which reports its start as deleted. A box is gone
                // only when content on both sides of its position went.
                return !r.deletedAcross
            })
        this.running = map(this.running)
        this.seen = map(this.seen)
    }

    /** Forget everything: the document was replaced without a mapping. */
    reset(): void
    {
        this.running = []
        this.seen = []
        this.current = new Presentation([])
    }

    /**
     * Work out this frame. `boxes` are the containers in the final layout;
     * `duration(box)` is how long a toggle of that box animates (0 for not
     * at all), and `snapshot()` captures what is on screen now, called at most
     * once and only when a transition starts.
     */
    frame<B extends { pos: number, y: number, height: number, collapsed: boolean, radius: number }>(
        boxes: B[],
        duration: (box: B) => number,
        snapshot: () => Snapshot | null,
    ): Presentation
    {
        const now = this.now()
        const byPos = new Map(boxes.map((b) => [b.pos, b]))

        let shot: Snapshot | null | undefined
        for (const prev of this.seen)
        {
            const box = byPos.get(prev.pos)
            if (!box || box.collapsed === prev.collapsed) continue
            const ms = duration(box)
            this.running = this.running.filter((t) => t.pos !== prev.pos)
            if (ms <= 0) continue
            if (shot === undefined) shot = snapshot()
            if (!shot) continue
            this.running.push({
                pos: prev.pos, from: prev.shown, start: now, duration: ms,
                before: shot, beforeTop: prev.top,
            })
        }

        const bands: (Band & { pos: number, started: number })[] = []
        this.running = this.running.filter((t) =>
        {
            const box = byPos.get(t.pos)
            const progress = (now - t.start) / t.duration
            if (!box || progress >= 1) return false
            const shown = t.from + (box.height - t.from) * standardEasing(progress)
            bands.push({
                pos: t.pos, started: t.start,
                top: box.y, final: box.height, shown,
                cap: Math.max(2, box.radius + 2),
                source: box.height >= t.from ? 'live' : 'before',
                before: t.before, beforeTop: t.beforeTop, beforeHeight: t.from,
            })
            return true
        })

        // Bands must not overlap: a box toggled inside one that is already
        // animating would be displaced twice. The newer one wins; the older
        // jumps to its end.
        bands.sort((a, b) => a.top - b.top)
        const kept: typeof bands = []
        for (const b of bands)
        {
            const last = kept[kept.length - 1]
            if (last && b.top < last.top + Math.max(last.final, last.shown))
            {
                if (b.started > last.started) kept[kept.length - 1] = b
                continue
            }
            kept.push(b)
        }
        if (kept.length !== bands.length)
        {
            const live = new Set(kept.map((b) => b.pos))
            this.running = this.running.filter((t) => live.has(t.pos))
        }

        this.current = new Presentation(kept)
        this.seen = boxes.map((b) =>
        {
            const band = kept.find((k) => k.pos === b.pos)
            return {
                pos: b.pos,
                top: this.current.mapY(b.y).y,
                shown: band ? band.shown : b.height,
                collapsed: b.collapsed,
            }
        })
        return this.current
    }
}
