/**
 * The benchmark page. Mounts both editors into constrained scroll containers and
 * exposes `window.__bench.run()` for the automated runner (or the buttons below)
 * to drive. Each row builds a fresh document, mounts one adapter, measures, and
 * tears down — so editors never interfere with each other's timings.
 */
import {
    buildSimpleDoc, buildComplexDoc,
    makeDomAdapter, makeCanvasAdapter, measure,
    type EditorAdapter, type Stats,
} from './core'

const WIDTH = 680
const CARET_POS = 2 // inside the first paragraph (worst case: max subtree below)

type Build = () => import('prosemirror-model').Node
type Make = (doc: ReturnType<Build>, mount: HTMLElement) => EditorAdapter

const docs: Record<string, Build> = {
    simple: () => buildSimpleDoc(400),
    complex: () => buildComplexDoc(50),
}
const editors: Record<string, Make> = {
    dom: (doc, mount) => makeDomAdapter(doc, mount),
    canvas: (doc, mount) => makeCanvasAdapter(doc, mount, WIDTH),
}

export interface Row {
    scenario: string
    docKind: 'simple' | 'complex'
    editor: 'dom' | 'canvas'
    readCaret: boolean
    stats: Stats
}

const SCENARIOS: { name: string, docKind: 'simple' | 'complex', readCaret: boolean }[] = [
    { name: 'A · simple, no caret read', docKind: 'simple', readCaret: false },
    { name: 'A · simple, read caret', docKind: 'simple', readCaret: true },
    { name: 'B · complex, no caret read', docKind: 'complex', readCaret: false },
    { name: 'C · complex, read caret (kill shot)', docKind: 'complex', readCaret: true },
]

const stage = () => document.getElementById('stage') as HTMLElement
const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()))

async function runOne(docKind: 'simple' | 'complex', editor: 'dom' | 'canvas', readCaret: boolean, keystrokes: number): Promise<Stats> {
    const mount = document.createElement('div')
    mount.className = 'mount'
    stage().appendChild(mount)
    const adapter = editors[editor](docs[docKind](), mount)
    await nextFrame() // let the initial layout settle before timing
    const stats = measure(adapter, { caretPos: CARET_POS, keystrokes, readCaret })
    adapter.destroy()
    mount.remove()
    return stats
}

export async function run(keystrokes = 200): Promise<Row[]> {
    const rows: Row[] = []
    for (const sc of SCENARIOS) {
        for (const editor of ['dom', 'canvas'] as const) {
            const stats = await runOne(sc.docKind, editor, sc.readCaret, keystrokes)
            rows.push({ scenario: sc.name, docKind: sc.docKind, editor, readCaret: sc.readCaret, stats })
            await nextFrame()
        }
    }
    return rows
}

// Expose for the Playwright runner.
;(window as unknown as { __bench: { run: typeof run } }).__bench = { run }

// Size sweep: read-after-write p50 for DOM vs canvas as the document grows.
// Types in the MIDDLE of the doc (so there's a large subtree on both sides) and
// reads the caret each keystroke. Reveals whether either editor's per-keystroke
// cost scales with document size.
async function sweep(sizes = [200, 800, 3200], keystrokes = 150) {
    const { buildSimpleDoc: bs, makeDomAdapter: md, makeCanvasAdapter: mc, measure } = await import('./core')
    const rows: { size: number, dom: number, canvas: number }[] = []
    for (const size of sizes) {
        const doc = bs(size)
        const caretPos = Math.floor(doc.content.size / 2)
        const out: Record<string, number> = {}
        for (const [name, make] of [['dom', md], ['canvas', (d: import('prosemirror-model').Node, m: HTMLElement) => mc(d, m, WIDTH)]] as const) {
            const mount = document.createElement('div'); mount.className = 'mount'; stage().appendChild(mount)
            const adapter = (make as (d: import('prosemirror-model').Node, m: HTMLElement) => import('./core').EditorAdapter)(doc, mount)
            await new Promise<void>((r) => requestAnimationFrame(() => r()))
            out[name] = measure(adapter, { caretPos, keystrokes, readCaret: true }).p50
            adapter.destroy(); mount.remove()
            await new Promise<void>((r) => requestAnimationFrame(() => r()))
        }
        rows.push({ size, dom: out.dom, canvas: out.canvas })
    }
    return rows
}
;(window as unknown as { __sweep: typeof sweep }).__sweep = sweep

// ─── In-page UI (manual runs) ────────────────────────────────────────────────

const out = document.getElementById('out') as HTMLPreElement
document.getElementById('go')!.addEventListener('click', async () => {
    out.textContent = 'running…'
    const rows = await run(200)
    const fmt = (n: number) => n.toFixed(3).padStart(8)
    const lines = ['scenario'.padEnd(38) + 'editor'.padEnd(8) + 'p50'.padStart(8) + 'p95'.padStart(8) + 'max'.padStart(8)]
    for (const r of rows) {
        lines.push(r.scenario.padEnd(38) + r.editor.padEnd(8) + fmt(r.stats.p50) + fmt(r.stats.p95) + fmt(r.stats.max))
    }
    out.textContent = lines.join('\n') + '\n\n(times are ms per keystroke: edit → relayout → read caret)'
})
