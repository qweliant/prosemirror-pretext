import { defineConfig } from 'vite'

// Dev/build config for the latency benchmark page (bench/). Served by the
// automated runner (bench/run.mjs) and usable standalone via `bun run dev:bench`.
export default defineConfig({
    root: 'bench',
    server: { port: 5178 },
    build: { outDir: '../bench-dist', emptyOutDir: true },
})
