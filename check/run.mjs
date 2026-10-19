/**
 * Drives check/page.ts in a real browser and fails the build on a clipped line.
 *
 * This is the correctness counterpart to bench/: the unit suite mocks Pretext
 * and `measureText`, so nothing in it can see a disagreement between the
 * editor's placement arithmetic and the real layout engine's. That seam is
 * where the clipped-glyph bug lived, and it was found by hand rather than by a
 * test. Now it is a gate.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { chromium } from 'playwright-core'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 5179
const URL = `http://localhost:${PORT}/`

// CI runners ship a Chrome already; downloading another is a minute of nothing.
const CANDIDATES = [
    process.env.CHROME_PATH,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean)
const BROWSER = CANDIDATES.find((p) => existsSync(p))
if (!BROWSER) {
    console.error('No Chrome/Chromium found. Set CHROME_PATH to one.\nLooked in:\n  ' + CANDIDATES.join('\n  '))
    process.exit(2)
}

const vite = spawn(
    join(REPO, 'node_modules/.bin/vite'),
    ['--config', 'vite.check.config.ts', '--port', String(PORT), '--strictPort'],
    { cwd: REPO, stdio: 'ignore' },
)
const shutdown = () => { try { vite.kill() } catch { /* already gone */ } }
process.on('exit', shutdown)

let up = false
for (let i = 0; i < 100; i++) {
    try { if ((await fetch(URL)).ok) { up = true; break } } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 200))
}
if (!up) { console.error(`Dev server never came up on ${URL}`); shutdown(); process.exit(2) }

const browser = await chromium.launch({ executablePath: BROWSER, headless: true })
const page = await browser.newPage({ deviceScaleFactor: 2 })
const failures = []
page.on('pageerror', (e) => failures.push(String(e)))

await page.goto(URL, { waitUntil: 'load' })
// Real metrics need the fonts settled before anything is laid out.
await page.evaluate(() => document.fonts.ready)
await page.waitForFunction('!!window.__overrun')

// 61 widths, matching the sweep the TEXT_BLEED investigation ran by hand.
const widths = []
for (let w = 320; w <= 920; w += 10) widths.push(w)

const report = await page.evaluate((ws) => window.__overrun(ws), widths)
await browser.close()
shutdown()

if (failures.length) {
    console.error('Page errors during the sweep:\n  ' + failures.join('\n  '))
    process.exit(1)
}

const { widths: n, lines, bleed, clipped, worstPastColumn, worstPastColumnMarked, whitespaceOnly } = report
console.log(`\nlayout check — ${n} widths, ${lines} laid-out lines, TEXT_BLEED ${bleed}px\n`)
console.log(`  worst painted overshoot past the column : ${worstPastColumn.toFixed(2)}px`
    + ` (${worstPastColumnMarked ? 'marked line' : 'single-font line'})`)
console.log(`  headroom left in the bleed              : ${(bleed - worstPastColumn).toFixed(2)}px`)
console.log(`  lines over the column by whitespace only: ${whitespaceOnly}`)

if (clipped.length) {
    console.error(`\n✗ ${clipped.length} line(s) would be painted outside the canvas:\n`)
    for (const c of clipped.slice(0, 12)) {
        console.error(`    width ${c.width}  over by ${c.over.toFixed(2)}px  ${c.marked ? 'marked' : 'plain '}`
            + `  ${c.blockType}  "${c.lineText}…"`)
    }
    if (clipped.length > 12) console.error(`    … and ${clipped.length - 12} more`)
    console.error(`\nTEXT_BLEED (${bleed}px) no longer covers the measurement disagreement.`)
    process.exit(1)
}
console.log('\n✓ every painted glyph lands inside the canvas\n')
