import { defineConfig } from 'vite'

// Dev/build config for the real-browser layout check (check/). Driven by
// check/run.mjs in CI, and usable by hand via `bun run dev:check`.
export default defineConfig({
    root: 'check',
    server: { port: 5179 },
    build: { outDir: '../check-dist', emptyOutDir: true },
})
