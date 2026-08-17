import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      // Two entry points, not one - the kiosk dashboard (index.html)
      // and the internal discovery results view (discovery.html) are
      // deliberately separate pages, not routes within one app (no
      // router in this project). Vite dev serves both automatically
      // by path; this only matters for `npm run build`.
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        discovery: resolve(import.meta.dirname, 'discovery.html'),
      },
    },
  },
})
