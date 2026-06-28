import { defineConfig } from 'vite'

// Builds the kawaii docs site (site/) into docs/ for GitHub Pages. Unlike the
// library build (vite.config.ts), this is a normal app build: everything is
// bundled so the page is fully self-contained static files.
export default defineConfig({
    root: 'site',
    // Project Pages are served from /<repo>/, so assets need this base.
    base: '/prosemirror-pretext/',
    build: {
        outDir: '../docs',
        emptyOutDir: true,
    },
})
