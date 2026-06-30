import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { chromium } from 'playwright-core'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 5178, URL = `http://localhost:${PORT}/`
const BROWSER = [process.env.CHROME_PATH, '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean).find((p) => existsSync(p))

const vite = spawn(join(REPO, 'node_modules/.bin/vite'), ['--config', 'vite.bench.config.ts', '--port', String(PORT), '--strictPort'], { cwd: REPO, stdio: 'ignore' })
process.on('exit', () => vite.kill())
for (let i = 0; i < 100; i++) { try { if ((await fetch(URL)).ok) break } catch {} await new Promise((r) => setTimeout(r, 200)) }

const browser = await chromium.launch({ executablePath: BROWSER, headless: true })
const page = await browser.newPage({ deviceScaleFactor: 2 })
const cdp = await page.context().newCDPSession(page)
await cdp.send('Emulation.setCPUThrottlingRate', { rate: Number(process.env.THROTTLE ?? 4) })
await page.goto(URL, { waitUntil: 'load' })
await page.waitForFunction('!!window.__sweep')
const rows = await page.evaluate(() => window.__sweep([200, 800, 3200, 8000], 120))
console.log(`\nread-after-write (ms/keystroke), ${process.env.THROTTLE ?? 4}x throttle, typing mid-doc:\n`)
console.log('blocks'.padStart(7) + 'DOM p50'.padStart(10) + 'cvs p50'.padStart(10) + 'DOM max'.padStart(10) + 'cvs max'.padStart(10))
for (const r of rows) console.log(String(r.size).padStart(7) + r.dom.toFixed(2).padStart(10) + r.canvas.toFixed(2).padStart(10) + r.domMax.toFixed(2).padStart(10) + r.canvasMax.toFixed(2).padStart(10))
await browser.close(); vite.kill(); process.exit(0)
