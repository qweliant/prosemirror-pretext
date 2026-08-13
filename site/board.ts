/**
 * The board: an infinite, pannable, zoomable surface that the editor sits on.
 *
 * This exists to make a point the editor alone cannot. Excalidraw and its
 * relatives draw shapes with arithmetic and paint them to a canvas; this project
 * does the same for *prose*. Once text layout is arithmetic rather than reflow,
 * a paragraph and a rectangle stop being different kinds of thing — they are
 * both geometry you compute and then fill. So the board treats them the same:
 * one camera, one coordinate space, one paint pass for the shapes and one
 * canvas per document frame.
 *
 * It lives in `site/` on purpose. Nothing here is part of the library — a board
 * is an application, and `CanvasEditor` stays a text editor you can put on one.
 *
 * The seam between the two is one call. The editor derives its own display
 * scale, so it hit-tests correctly under any CSS transform and a card is as
 * editable at 40% as at 100%; what it cannot do is notice that the transform
 * changed, because nothing about a transform is observable from inside it. So
 * the board tells it, through `Frame.onGeometryChange` — which is the entire
 * contract, and the reason the editor still knows nothing about a camera.
 */

export type Tool = 'select' | 'note' | 'rect' | 'ellipse' | 'arrow' | 'pen'

export interface Camera
{
    /** Screen px of the board origin. */
    x: number
    y: number
    scale: number
}

export type ShapeKind = 'rect' | 'ellipse' | 'arrow' | 'pen'

export interface Shape
{
    id: number
    kind: ShapeKind
    /** Board-space coordinates. Boxed shapes carry [x1,y1,x2,y2]; a pen stroke
     *  carries the whole path as flat x,y pairs. */
    points: number[]
    stroke: string
    fill: string | null
    width: number
}

export interface Frame
{
    id: number
    /** Board-space box. Width/height are the frame's unscaled CSS size. */
    x: number
    y: number
    w: number
    h: number
    el: HTMLElement
    body: HTMLElement
    /**
     * Called when this frame's transform changes. A CSS transform fires no
     * event, so anything mounted inside that maps between its own coordinates
     * and the viewport has to be told — for a `CanvasEditor` that means
     * `invalidateGeometry()`, and it is what lets a card be edited while zoomed.
     */
    onGeometryChange?: () => void
    /** Last transform written, so the hook fires on change, not every frame. */
    lastTransform?: string
}

export interface FrameOptions
{
    x: number
    y: number
    w: number
    h: number
    label: string
    /** Accent color for the frame's label chip. */
    accent?: string
    /** A sticky note gets the paper treatment instead of the document card. */
    note?: boolean
}

/** Board-space size of one grid cell. */
const GRID = 26
const MIN_SCALE = 0.25
const MAX_SCALE = 2
/** How near a pointer must come to a thin shape to select it (board px). */
const HIT_SLOP = 8

export interface BoardOptions
{
    /** Called when the `note` tool places a note, to fill its body. The board
     *  owns the frame; the caller owns what goes inside — which is how a note
     *  ends up being another CanvasEditor without the board knowing. */
    onCreateNote?: (frame: Frame) => void
    /** Notified whenever the tool or zoom changes, so chrome can re-render. */
    onChange?: () => void
}

export class Board
{
    readonly root: HTMLElement
    /** Grid, and the hit target for every board gesture. Sits under the cards. */
    readonly canvas: HTMLCanvasElement
    readonly layer: HTMLElement
    /**
     * Shapes, painted *above* the cards.
     *
     * Frames are DOM and the base canvas is behind them, so a stroke drawn
     * across a card would disappear underneath it — and circling a paragraph is
     * one of the first things anyone tries on a board. Shapes therefore get
     * their own canvas on top, transparent to pointers so the base canvas keeps
     * receiving the gestures.
     */
    readonly overlay: HTMLCanvasElement
    readonly cam: Camera = { x: 0, y: 0, scale: 1 }

    private readonly frames: Frame[] = []
    private readonly shapes: Shape[] = []
    private readonly opts: BoardOptions
    private nextId = 1

    private tool: Tool = 'select'
    private selected: Shape | null = null
    /** In-flight gesture. Pan and draw are both drags; the mode says which. */
    private drag:
        | null
        | { mode: 'pan', sx: number, sy: number, cx: number, cy: number }
        | { mode: 'draw', shape: Shape }
        | { mode: 'move', shape: Shape, sx: number, sy: number, from: number[] }
        = null
    private spaceDown = false
    private raf = 0

    constructor(root: HTMLElement, opts: BoardOptions = {})
    {
        this.root = root
        this.opts = opts
        root.classList.add('board')

        this.canvas = document.createElement('canvas')
        this.canvas.className = 'board-canvas'
        this.layer = document.createElement('div')
        this.layer.className = 'board-layer'
        this.overlay = document.createElement('canvas')
        this.overlay.className = 'board-overlay'
        root.append(this.canvas, this.layer, this.overlay)

        this.canvas.addEventListener('pointerdown', this.onPointerDown)
        this.canvas.addEventListener('pointermove', this.onPointerMove)
        this.canvas.addEventListener('pointerup', this.onPointerUp)
        this.canvas.addEventListener('pointercancel', this.onPointerUp)
        this.canvas.addEventListener('wheel', this.onWheel, { passive: false })
        window.addEventListener('keydown', this.onKeyDown)
        window.addEventListener('keyup', this.onKeyUp)
        new ResizeObserver(() => this.schedule()).observe(root)

        this.schedule()
    }

    // ─── Public API ────────────────────────────────────────────────────────

    addFrame(o: FrameOptions): Frame
    {
        const el = document.createElement('div')
        el.className = o.note ? 'bframe note' : 'bframe'
        el.style.width = `${o.w}px`
        if (o.accent) el.style.setProperty('--accent', o.accent)

        const label = document.createElement('div')
        label.className = 'bframe-label'
        label.textContent = o.label

        const body = document.createElement('div')
        body.className = 'bframe-body'

        el.append(label, body)
        this.layer.appendChild(el)

        const frame: Frame = { id: this.nextId++, x: o.x, y: o.y, w: o.w, h: o.h, el, body }
        this.frames.push(frame)
        this.schedule()
        return frame
    }

    setTool(tool: Tool): void
    {
        this.tool = tool
        this.selected = null
        this.canvas.style.cursor = tool === 'select' ? 'grab' : 'crosshair'
        this.opts.onChange?.()
        // Whether frames take pointer events is input state, not paint state,
        // so it must not wait for the next animation frame — arming a tool and
        // dragging inside the same frame would otherwise land in a card.
        this.positionFrames()
        this.schedule()
    }

    get currentTool(): Tool { return this.tool }
    get zoom(): number { return this.cam.scale }
    get selectedShape(): Shape | null { return this.selected }

    /**
     * Whether frames should take pointer events at all.
     *
     * Only the armed tool decides this now — the zoom does not. `CanvasEditor`
     * maps pointers through its own display scale, so a card is as editable at
     * 40% as at 100%, and the board's job is just to tell it when the transform
     * moved (see `Frame.onGeometryChange`).
     *
     * Frames must still go inert while a drawing tool is held, or a stroke begun
     * over the document would land in the document — you would pick the
     * rectangle tool, drag across the prose, and get a text selection.
     */
    private get framesLive(): boolean
    {
        return this.tool === 'select'
    }

    /** Frame everything that exists, with margin — the overview shot. */
    fitAll(): void
    {
        const box = this.contentBox()
        if (!box) return
        const r = this.root.getBoundingClientRect()
        const pad = 40
        const scale = clamp(
            Math.min((r.width - pad * 2) / box.w, (r.height - pad * 2) / box.h),
            MIN_SCALE,
            1,
        )
        this.cam.scale = scale
        this.cam.x = r.width / 2 - (box.x + box.w / 2) * scale
        this.cam.y = r.height / 2 - (box.y + box.h / 2) * scale
        this.opts.onChange?.()
        this.positionFrames()
        this.schedule()
    }

    setZoom(scale: number): void
    {
        const r = this.root.getBoundingClientRect()
        this.zoomAround(clamp(scale, MIN_SCALE, MAX_SCALE), r.width / 2, r.height / 2)
    }

    /** A frame's measured height changes as its document does; the board only
     *  needs it for `fitAll` and for hit-testing while zoomed out. */
    remeasure(): void
    {
        for (const f of this.frames) f.h = f.el.offsetHeight || f.h
        this.schedule()
    }

    addShape(shape: Omit<Shape, 'id'>): Shape
    {
        const s: Shape = { ...shape, id: this.nextId++ }
        this.shapes.push(s)
        this.schedule()
        return s
    }

    clearShapes(): void
    {
        this.shapes.length = 0
        this.selected = null
        this.opts.onChange?.()
        this.schedule()
    }

    get shapeCount(): number { return this.shapes.length }

    // ─── Coordinates ───────────────────────────────────────────────────────

    private toBoard(e: { clientX: number, clientY: number }): { x: number, y: number }
    {
        const r = this.canvas.getBoundingClientRect()
        return {
            x: (e.clientX - r.left - this.cam.x) / this.cam.scale,
            y: (e.clientY - r.top - this.cam.y) / this.cam.scale,
        }
    }

    private contentBox(): { x: number, y: number, w: number, h: number } | null
    {
        let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity
        const grow = (ax: number, ay: number, bx: number, by: number) =>
        {
            x1 = Math.min(x1, ax); y1 = Math.min(y1, ay)
            x2 = Math.max(x2, bx); y2 = Math.max(y2, by)
        }
        for (const f of this.frames) grow(f.x, f.y, f.x + f.w, f.y + f.h)
        for (const s of this.shapes)
        {
            for (let i = 0; i < s.points.length; i += 2)
            {
                grow(s.points[i], s.points[i + 1], s.points[i], s.points[i + 1])
            }
        }
        if (!isFinite(x1)) return null
        return { x: x1, y: y1, w: Math.max(1, x2 - x1), h: Math.max(1, y2 - y1) }
    }

    private frameAt(x: number, y: number): Frame | null
    {
        for (let i = this.frames.length - 1; i >= 0; i--)
        {
            const f = this.frames[i]
            if (x >= f.x && x <= f.x + f.w && y >= f.y && y <= f.y + f.h) return f
        }
        return null
    }

    private shapeAt(x: number, y: number): Shape | null
    {
        const slop = HIT_SLOP / this.cam.scale
        for (let i = this.shapes.length - 1; i >= 0; i--)
        {
            const s = this.shapes[i]
            if (s.kind === 'pen' || s.kind === 'arrow')
            {
                for (let p = 0; p + 3 < s.points.length; p += 2)
                {
                    const d = distToSegment(
                        x, y,
                        s.points[p], s.points[p + 1], s.points[p + 2], s.points[p + 3],
                    )
                    if (d <= slop) return s
                }
                continue
            }
            const [x1, y1, x2, y2] = s.points
            const bx = Math.min(x1, x2) - slop
            const by = Math.min(y1, y2) - slop
            const bw = Math.abs(x2 - x1) + slop * 2
            const bh = Math.abs(y2 - y1) + slop * 2
            if (x >= bx && x <= bx + bw && y >= by && y <= by + bh) return s
        }
        return null
    }

    // ─── Input ─────────────────────────────────────────────────────────────

    private onPointerDown = (e: PointerEvent): void =>
    {
        const p = this.toBoard(e)

        // Space-drag and middle-drag pan whatever the tool, the way every
        // canvas app has trained people to expect.
        if (this.spaceDown || e.button === 1)
        {
            this.startPan(e)
            return
        }

        if (this.tool === 'note')
        {
            const frame = this.addFrame({
                x: Math.round(p.x - 90), y: Math.round(p.y - 20),
                w: 200, h: 120, label: 'note', note: true,
            })
            this.opts.onCreateNote?.(frame)
            this.setTool('select')
            return
        }

        if (this.tool === 'select')
        {
            const hit = this.shapeAt(p.x, p.y)
            const changed = hit !== this.selected
            this.selected = hit
            if (changed) this.opts.onChange?.()
            if (hit)
            {
                this.canvas.setPointerCapture(e.pointerId)
                this.drag = {
                    mode: 'move', shape: hit,
                    sx: p.x, sy: p.y, from: hit.points.slice(),
                }
                this.schedule()
                return
            }
            this.startPan(e)
            return
        }

        // A drawing tool: seed the shape and let pointermove size it.
        const shape: Shape = {
            id: this.nextId++,
            kind: this.tool,
            points: this.tool === 'pen' ? [p.x, p.y] : [p.x, p.y, p.x, p.y],
            stroke: '#2f6e1c',
            fill: this.tool === 'rect' || this.tool === 'ellipse' ? 'rgba(126,193,75,.16)' : null,
            width: 2.5,
        }
        this.shapes.push(shape)
        this.canvas.setPointerCapture(e.pointerId)
        this.drag = { mode: 'draw', shape }
        this.schedule()
    }

    private startPan(e: PointerEvent): void
    {
        this.canvas.setPointerCapture(e.pointerId)
        this.drag = {
            mode: 'pan',
            sx: e.clientX, sy: e.clientY,
            cx: this.cam.x, cy: this.cam.y,
        }
        this.canvas.style.cursor = 'grabbing'
    }

    private onPointerMove = (e: PointerEvent): void =>
    {
        const d = this.drag
        if (!d) return

        if (d.mode === 'pan')
        {
            this.cam.x = d.cx + (e.clientX - d.sx)
            this.cam.y = d.cy + (e.clientY - d.sy)
            this.schedule()
            return
        }

        const p = this.toBoard(e)
        if (d.mode === 'move')
        {
            const dx = p.x - d.sx
            const dy = p.y - d.sy
            for (let i = 0; i < d.from.length; i += 2)
            {
                d.shape.points[i] = d.from[i] + dx
                d.shape.points[i + 1] = d.from[i + 1] + dy
            }
            this.schedule()
            return
        }

        if (d.shape.kind === 'pen')
        {
            const n = d.shape.points.length
            // Drop samples the stroke will not notice, so a long scribble stays
            // a few hundred points rather than a few thousand.
            if (Math.hypot(p.x - d.shape.points[n - 2], p.y - d.shape.points[n - 1]) > 2)
            {
                d.shape.points.push(p.x, p.y)
            }
        }
        else
        {
            d.shape.points[2] = p.x
            d.shape.points[3] = p.y
        }
        this.schedule()
    }

    private onPointerUp = (e: PointerEvent): void =>
    {
        const d = this.drag
        this.drag = null
        this.canvas.style.cursor = this.tool === 'select' ? 'grab' : 'crosshair'
        if (!d) return
        if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId)

        if (d.mode === 'pan') return

        // A click with a drawing tool leaves a degenerate shape behind; drop it.
        if (d.mode === 'draw')
        {
            const s = d.shape
            const tiny = s.kind === 'pen'
                ? s.points.length < 6
                : Math.hypot(s.points[2] - s.points[0], s.points[3] - s.points[1]) < 5
            if (tiny) this.shapes.splice(this.shapes.indexOf(s), 1)
            else this.selected = s
            // The tool stays armed. Drawing one rectangle almost always means
            // drawing another, and silently disarming after each stroke is the
            // kind of thing that reads as the button not having worked.
            this.opts.onChange?.()
        }
        this.schedule()
    }

    private onWheel = (e: WheelEvent): void =>
    {
        // Pinch-zoom and ctrl-wheel arrive as a wheel event with ctrlKey set,
        // and that gesture is the only one the board takes.
        //
        // A plain wheel is deliberately left to the page. A board embedded in a
        // document must not become a scroll trap — reaching this section should
        // not mean your scroll wheel stops moving the page — and panning is
        // already what dragging does.
        if (!(e.ctrlKey || e.metaKey)) return
        e.preventDefault()
        const r = this.canvas.getBoundingClientRect()
        const next = clamp(this.cam.scale * Math.exp(-e.deltaY / 260), MIN_SCALE, MAX_SCALE)
        this.zoomAround(next, e.clientX - r.left, e.clientY - r.top)
    }

    /** Zoom so the board point under (px, py) stays under it. */
    private zoomAround(next: number, px: number, py: number): void
    {
        const bx = (px - this.cam.x) / this.cam.scale
        const by = (py - this.cam.y) / this.cam.scale
        this.cam.scale = next
        this.cam.x = px - bx * next
        this.cam.y = py - by * next
        this.opts.onChange?.()
        this.positionFrames()
        this.schedule()
    }

    private onKeyDown = (e: KeyboardEvent): void =>
    {
        // Never steal a key from anything being typed into — the editors on the
        // board, but also the page's own search box, where Space would
        // otherwise arm panning and Backspace would delete a shape.
        const el = document.activeElement as HTMLElement | null
        if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable))
        {
            return
        }
        if (e.code === 'Space') { this.spaceDown = true; return }
        if ((e.key === 'Delete' || e.key === 'Backspace') && this.selected)
        {
            this.deleteSelected()
            e.preventDefault()
        }
        if (e.key === 'Escape') this.setTool('select')
    }

    /** Remove the selected shape, if any. Also reachable from the toolbar, so
     *  the gesture is not keyboard-only. */
    deleteSelected(): void
    {
        if (!this.selected) return
        this.shapes.splice(this.shapes.indexOf(this.selected), 1)
        this.selected = null
        this.opts.onChange?.()
        this.schedule()
    }

    private onKeyUp = (e: KeyboardEvent): void =>
    {
        if (e.code === 'Space') this.spaceDown = false
    }

    // ─── Paint ─────────────────────────────────────────────────────────────

    private schedule(): void
    {
        if (this.raf) return
        this.raf = requestAnimationFrame(() =>
        {
            this.raf = 0
            this.render()
        })
    }

    render(): void
    {
        const r = this.root.getBoundingClientRect()
        if (r.width === 0 || r.height === 0) return
        const dpr = window.devicePixelRatio || 1
        for (const c of [this.canvas, this.overlay])
        {
            if (c.width === Math.round(r.width * dpr)
                && c.height === Math.round(r.height * dpr))
            {
                continue
            }
            c.width = Math.round(r.width * dpr)
            c.height = Math.round(r.height * dpr)
            c.style.width = `${r.width}px`
            c.style.height = `${r.height}px`
        }

        const ctx = this.canvas.getContext('2d')!
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        ctx.clearRect(0, 0, r.width, r.height)
        this.paintGrid(ctx, r.width, r.height)

        // Shapes go on the overlay, above the cards. The context is put into
        // board space first, so every shape is drawn with the numbers it was
        // authored in — the camera is the only thing that knows about pixels.
        const octx = this.overlay.getContext('2d')!
        octx.setTransform(dpr, 0, 0, dpr, 0, 0)
        octx.clearRect(0, 0, r.width, r.height)
        octx.setTransform(dpr, 0, 0, dpr, this.cam.x * dpr, this.cam.y * dpr)
        octx.scale(this.cam.scale, this.cam.scale)
        octx.lineCap = 'round'
        octx.lineJoin = 'round'
        for (const s of this.shapes) this.paintShape(octx, s)
        if (this.selected) this.paintSelection(octx, this.selected)

        this.positionFrames()
    }

    private paintGrid(ctx: CanvasRenderingContext2D, w: number, h: number): void
    {
        const step = GRID * this.cam.scale
        // Below about half a cell the dots stop reading as a grid and start
        // reading as noise, so they simply stop.
        if (step < 11) return
        const x0 = this.cam.x % step
        const y0 = this.cam.y % step
        ctx.fillStyle = 'rgba(79, 158, 44, .17)'
        const dot = this.cam.scale >= 1 ? 1.4 : 1
        for (let x = x0; x < w; x += step)
        {
            for (let y = y0; y < h; y += step) ctx.fillRect(x, y, dot, dot)
        }
    }

    private paintShape(ctx: CanvasRenderingContext2D, s: Shape): void
    {
        ctx.strokeStyle = s.stroke
        ctx.lineWidth = s.width
        const [x1, y1, x2, y2] = s.points

        if (s.kind === 'rect')
        {
            const x = Math.min(x1, x2), y = Math.min(y1, y2)
            const w = Math.abs(x2 - x1), h = Math.abs(y2 - y1)
            if (s.fill) { ctx.fillStyle = s.fill; ctx.fillRect(x, y, w, h) }
            ctx.strokeRect(x, y, w, h)
            return
        }
        if (s.kind === 'ellipse')
        {
            ctx.beginPath()
            ctx.ellipse(
                (x1 + x2) / 2, (y1 + y2) / 2,
                Math.abs(x2 - x1) / 2, Math.abs(y2 - y1) / 2, 0, 0, Math.PI * 2,
            )
            if (s.fill) { ctx.fillStyle = s.fill; ctx.fill() }
            ctx.stroke()
            return
        }
        if (s.kind === 'arrow')
        {
            ctx.beginPath()
            ctx.moveTo(x1, y1)
            ctx.lineTo(x2, y2)
            ctx.stroke()
            const a = Math.atan2(y2 - y1, x2 - x1)
            const head = 11
            ctx.beginPath()
            ctx.moveTo(x2, y2)
            ctx.lineTo(x2 - head * Math.cos(a - 0.42), y2 - head * Math.sin(a - 0.42))
            ctx.moveTo(x2, y2)
            ctx.lineTo(x2 - head * Math.cos(a + 0.42), y2 - head * Math.sin(a + 0.42))
            ctx.stroke()
            return
        }
        ctx.beginPath()
        ctx.moveTo(s.points[0], s.points[1])
        for (let i = 2; i < s.points.length; i += 2) ctx.lineTo(s.points[i], s.points[i + 1])
        ctx.stroke()
    }

    private paintSelection(ctx: CanvasRenderingContext2D, s: Shape): void
    {
        let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity
        for (let i = 0; i < s.points.length; i += 2)
        {
            x1 = Math.min(x1, s.points[i]); x2 = Math.max(x2, s.points[i])
            y1 = Math.min(y1, s.points[i + 1]); y2 = Math.max(y2, s.points[i + 1])
        }
        const pad = 6 / this.cam.scale
        ctx.save()
        ctx.strokeStyle = '#46a8d8'
        ctx.lineWidth = 1.5 / this.cam.scale
        ctx.setLineDash([5 / this.cam.scale, 4 / this.cam.scale])
        ctx.strokeRect(x1 - pad, y1 - pad, x2 - x1 + pad * 2, y2 - y1 + pad * 2)
        ctx.restore()
    }

    /**
     * Frames are DOM, so the camera reaches them as a transform rather than a
     * redraw — the browser composites them and the text inside each one stays
     * the crisp output of its own canvas.
     */
    private positionFrames(): void
    {
        const live = this.framesLive
        const s = this.cam.scale
        for (const f of this.frames)
        {
            const t =
                `translate(${this.cam.x + f.x * s}px, ${this.cam.y + f.y * s}px) scale(${s})`
            f.el.style.pointerEvents = live ? 'auto' : 'none'
            if (t === f.lastTransform) continue
            f.lastTransform = t
            f.el.style.transform = t
            // Only on an actual change: whatever is mounted inside now maps
            // between its coordinates and the viewport differently.
            f.onGeometryChange?.()
        }
    }

    destroy(): void
    {
        window.removeEventListener('keydown', this.onKeyDown)
        window.removeEventListener('keyup', this.onKeyUp)
        if (this.raf) cancelAnimationFrame(this.raf)
    }
}

function clamp(n: number, lo: number, hi: number): number
{
    return Math.max(lo, Math.min(hi, n))
}

/** Distance from (px,py) to segment (x1,y1)-(x2,y2) — the hit test for the
 *  shapes that have no interior to click. */
function distToSegment(
    px: number, py: number, x1: number, y1: number, x2: number, y2: number,
): number
{
    const dx = x2 - x1
    const dy = y2 - y1
    const len = dx * dx + dy * dy
    const t = len === 0 ? 0 : clamp(((px - x1) * dx + (py - y1) * dy) / len, 0, 1)
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
}
