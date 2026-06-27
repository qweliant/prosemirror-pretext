import { defineConfig } from 'vite'
import { resolve } from 'path'

export default defineConfig({
    build: {
        sourcemap: true,
        lib: {
            entry: resolve(__dirname, 'src/index.ts'),
            formats: ['es'],
            fileName: 'index',
        },
        rollupOptions: {
            // Keep every ProseMirror package and Pretext external: they're peer
            // deps that MUST stay singletons (bundling transform/orderedmap would
            // re-create the "two ProseMirror copies" failure in consumer apps).
            external: [/^prosemirror-/, '@chenglou/pretext'],
        },
    },
})
