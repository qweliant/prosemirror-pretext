// Automated, reproducible latency benchmark runner.
//
//   bun run bench            # default throttle rates: 1x, 4x, 6x
//   CHROME_PATH=/path/to/browser bun run bench
//
// Boots the Vite bench page, drives window.__bench.run() in a real browser under
// CDP CPU throttling (the architectural flaws in DOM relayout only show on a
// realistically slow machine), and writes bench/results.json + bench/results.svg.
import { spawn } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { chromium } from 'playwright-core'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = join(__dirname, '..')
const PORT = 5178
const URL = `http://localhost:${PORT}/`
const THROTTLE = (process.env.THROTTLE?.split(',').map(Number)) ?? [1, 4, 6]
const KEYSTROKES = Number(process.env.KEYSTROKES ?? 200)

const BROWSER_CANDIDATES = [
    process.env.CHROME_PATH,
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
].filter(Boolean)

function findBrowser() {
    const hit = BROWSER_CANDIDATES.find((p) => existsSync(p))
    if (!hit) {
        console.error('No Chromium-based browser found. Set CHROME_PATH=/path/to/chrome.')
        process.exit(1)
    }
    return hit
}

async function waitForServer(url, timeoutMs = 20000) {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
        try { if ((await fetch(url)).ok) return } catch { /* not up yet */ }
        await new Promise((r) => setTimeout(r, 200))
    }
    throw new Error(`Vite server did not start at ${url}`)
}

async function main() {
    const executablePath = findBrowser()
    console.log(`browser: ${executablePath}`)

    // Boot the Vite dev server.
    const vite = spawn(join(REPO, 'node_modules/.bin/vite'),
        ['--config', 'vite.bench.config.ts', '--port', String(PORT), '--strictPort'],
        { cwd: REPO, stdio: 'ignore' })
    const shutdown = () => { try { vite.kill() } catch { /* */ } }
    process.on('exit', shutdown); process.on('SIGINT', () => { shutdown(); process.exit(1) })

    await waitForServer(URL)
    console.log(`vite up at ${URL}`)

    const browser = await chromium.launch({ executablePath, headless: true })
    const results = [] // { throttle, rows }

    const topRate = THROTTLE[THROTTLE.length - 1]
    let sweep = null
    for (const rate of THROTTLE) {
        const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 2 })
        const cdp = await page.context().newCDPSession(page)
        await cdp.send('Emulation.setCPUThrottlingRate', { rate })
        await page.goto(URL, { waitUntil: 'load' })
        await page.waitForFunction('!!window.__bench')
        process.stdout.write(`running ${rate}x throttle … `)
        const rows = await page.evaluate((k) => window.__bench.run(k), KEYSTROKES)
        // The document-size sweep (the headline graph) at the heaviest throttle.
        if (rate === topRate) {
            process.stdout.write('sweep … ')
            sweep = { throttle: rate, rows: await page.evaluate(() => window.__sweep([200, 800, 3200, 8000], 120)) }
        }
        console.log('done')
        results.push({ throttle: rate, rows })
        await page.close()
    }

    await browser.close()
    shutdown()

    writeFileSync(join(__dirname, 'results.json'), JSON.stringify({ scenarios: results, sweep }, null, 2))
    writeFileSync(join(__dirname, 'results.svg'), renderSvg(results))
    if (sweep) writeFileSync(join(__dirname, 'results-sweep.svg'), renderSweepSvg(sweep))
    printTables(results)
    printSweep(sweep)
    console.log('\nwrote bench/results.json + bench/results.svg + bench/results-sweep.svg')
    process.exit(0)
}

// ─── Reporting ───────────────────────────────────────────────────────────────

function printTables(results) {
    for (const { throttle, rows } of results) {
        console.log(`\n### ${throttle}x CPU throttle (ms/keystroke: edit → relayout → read caret)\n`)
        console.log('| scenario | DOM p50 | DOM p95 | canvas p50 | canvas p95 | DOM/canvas p50 |')
        console.log('|---|--:|--:|--:|--:|--:|')
        const byScenario = new Map()
        for (const r of rows) {
            const e = byScenario.get(r.scenario) ?? {}
            e[r.editor] = r.stats; byScenario.set(r.scenario, e)
        }
        for (const [scenario, e] of byScenario) {
            // Both editors are often below the timer's ~0.1ms resolution at these
            // sizes; the document-size sweep is where the difference shows.
            const ratio = e.dom && e.canvas && e.canvas.p50 >= 0.05
                ? (e.dom.p50 / e.canvas.p50).toFixed(1) + '×'
                : '~tie'
            console.log(`| ${scenario} | ${e.dom.p50.toFixed(2)} | ${e.dom.p95.toFixed(2)} | ${e.canvas.p50.toFixed(2)} | ${e.canvas.p95.toFixed(2)} | **${ratio}** |`)
        }
    }
}

function printSweep(sweep) {
    if (!sweep) return
    console.log(`\n### Document-size sweep — read-after-write p50 (ms/keystroke), ${sweep.throttle}x throttle, typing mid-document\n`)
    console.log('| blocks | DOM | canvas | DOM/canvas |')
    console.log('|--:|--:|--:|--:|')
    for (const r of sweep.rows) {
        const ratio = r.canvas >= 0.05 ? (r.dom / r.canvas).toFixed(1) + '×' : '—'
        console.log(`| ${r.size} | ${r.dom.toFixed(2)} | ${r.canvas.toFixed(2)} | **${ratio}** |`)
    }
}

function renderSvg(results) {
    // Grouped bars of p50 per scenario (DOM vs canvas) at the highest throttle.
    const top = results[results.length - 1]
    const byScenario = new Map()
    for (const r of top.rows) {
        const e = byScenario.get(r.scenario) ?? {}; e[r.editor] = r.stats.p50; byScenario.set(r.scenario, e)
    }
    const entries = [...byScenario.entries()]
    const maxVal = Math.max(...entries.flatMap(([, e]) => [e.dom, e.canvas]))
    const W = 880, H = 420, padL = 60, padB = 130, padT = 40, padR = 20
    const plotH = H - padB - padT, plotW = W - padL - padR
    const groupW = plotW / entries.length, barW = groupW * 0.3
    const y = (v) => padT + plotH - (v / maxVal) * plotH
    const bars = entries.map(([name, e], i) => {
        const gx = padL + i * groupW + groupW / 2
        const dx = gx - barW - 4, cx = gx + 4
        const label = name.split(' · ')[0]
        return `
      <rect x="${dx}" y="${y(e.dom)}" width="${barW}" height="${padT + plotH - y(e.dom)}" fill="#d2691e"/>
      <rect x="${cx}" y="${y(e.canvas)}" width="${barW}" height="${padT + plotH - y(e.canvas)}" fill="#4f9e2c"/>
      <text x="${dx + barW / 2}" y="${y(e.dom) - 5}" font-size="11" text-anchor="middle" fill="#7a3d10">${e.dom.toFixed(1)}</text>
      <text x="${cx + barW / 2}" y="${y(e.canvas) - 5}" font-size="11" text-anchor="middle" fill="#2f6e1c">${e.canvas.toFixed(2)}</text>
      <text x="${gx}" y="${H - padB + 18}" font-size="12" text-anchor="middle" fill="#1b2a16">${label}</text>`
    }).join('')
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="ui-sans-serif, system-ui">
  <rect width="${W}" height="${H}" fill="#fbfff5"/>
  <text x="${padL}" y="24" font-size="15" font-weight="700" fill="#1b2a16">Per-keystroke latency (p50, ms) — ${top.throttle}× CPU throttle</text>
  <line x1="${padL}" y1="${padT + plotH}" x2="${W - padR}" y2="${padT + plotH}" stroke="#1b2a16" stroke-width="1"/>
  <rect x="${padL}" y="${H - 30}" width="12" height="12" fill="#d2691e"/><text x="${padL + 18}" y="${H - 20}" font-size="12">prosemirror-view (DOM)</text>
  <rect x="${padL + 200}" y="${H - 30}" width="12" height="12" fill="#4f9e2c"/><text x="${padL + 218}" y="${H - 20}" font-size="12">prosemirror-pretext (canvas)</text>
  ${bars}
</svg>`
}

function renderSweepSvg(sweep) {
    // The headline: read-after-write latency vs document size. DOM grows
    // linearly (relayout after each edit); canvas stays flat (incremental).
    const rows = sweep.rows
    const W = 880, H = 460, padL = 64, padB = 70, padT = 50, padR = 24
    const plotH = H - padB - padT, plotW = W - padL - padR
    const maxVal = Math.max(...rows.flatMap((r) => [r.dom, r.canvas])) * 1.1
    const maxSize = rows[rows.length - 1].size
    const x = (s) => padL + (s / maxSize) * plotW
    const y = (v) => padT + plotH - (v / maxVal) * plotH
    const line = (key, color) => rows.map((r, i) => `${i ? 'L' : 'M'}${x(r.size).toFixed(1)},${y(r[key]).toFixed(1)}`).join(' ')
    const dots = (key, color) => rows.map((r) => `<circle cx="${x(r.size).toFixed(1)}" cy="${y(r[key]).toFixed(1)}" r="3.5" fill="${color}"/>`).join('')
    const xticks = rows.map((r) => `<text x="${x(r.size).toFixed(1)}" y="${padT + plotH + 20}" font-size="11" text-anchor="middle" fill="#1b2a16">${r.size}</text>`).join('')
    const yticks = [0, 0.25, 0.5, 0.75, 1].map((f) => {
        const v = maxVal * f
        return `<line x1="${padL}" y1="${y(v).toFixed(1)}" x2="${W - padR}" y2="${y(v).toFixed(1)}" stroke="#e0ecd8"/><text x="${padL - 8}" y="${y(v).toFixed(1) + 4}" font-size="10" text-anchor="end" fill="#6a7a5c">${v.toFixed(1)}</text>`
    }).join('')
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="ui-sans-serif, system-ui">
  <rect width="${W}" height="${H}" fill="#fbfff5"/>
  <text x="${padL}" y="26" font-size="15" font-weight="700" fill="#1b2a16">Read-after-write latency vs document size — ${sweep.throttle}× CPU throttle</text>
  <text x="${padL}" y="${H - 14}" font-size="12" fill="#6a7a5c">document blocks →</text>
  ${yticks}
  <path d="${line('dom')}" fill="none" stroke="#d2691e" stroke-width="2.5"/>${dots('dom', '#d2691e')}
  <path d="${line('canvas')}" fill="none" stroke="#4f9e2c" stroke-width="2.5"/>${dots('canvas', '#4f9e2c')}
  ${xticks}
  <rect x="${padL}" y="${padT}" width="12" height="12" fill="#d2691e"/><text x="${padL + 18}" y="${padT + 10}" font-size="12">prosemirror-view (DOM) — grows linearly</text>
  <rect x="${padL + 320}" y="${padT}" width="12" height="12" fill="#4f9e2c"/><text x="${padL + 338}" y="${padT + 10}" font-size="12">prosemirror-pretext (canvas) — flat</text>
</svg>`
}

main().catch((e) => { console.error(e); process.exit(1) })
