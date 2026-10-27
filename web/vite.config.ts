// Vite: the product's name goes into index.html, the manifest and the service worker at build (scripts/product-pages.ts);
// dev server on 19140 (component D's port range) proxying /api (REST + WebSocket) to the team server's dev
// port 19100 (and /vendor, /sandbox: the artifact frames' libraries and receiver document; the Host header is kept so
// the receiver's CSP names this dev origin); production build to web/dist, which the team server serves (server/src/routes/web.ts).
// Artifact libraries (React, recharts, lucide, mermaid, Tailwind) are bundled separately into dist/vendor by
// scripts/build-vendor.ts and served from /vendor/ (artifact frames may not load anything from public CDNs).
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import pkg from './package.json' with { type: 'json' }
import { productPages } from './scripts/product-pages.ts'

const API_TARGET = process.env.MYCEL_API_TARGET ?? 'http://127.0.0.1:19100'

export default defineConfig({
  // one tsconfig for every file: web imports mobile/src/protocol.ts, and mobile/tsconfig.json extends
  // expo/tsconfig.base, which a clean checkout does not have (mobile/ is not a workspace; vite 8 reads the
  // nearest tsconfig per file otherwise and the build fails with "Tsconfig not found expo/tsconfig.base")
  tsconfig: 'tsconfig.json',
  plugins: [react(), tailwindcss(), productPages()],
  define: {
    __WEB_VERSION__: JSON.stringify(pkg.version),
    __WEB_BUILD__: JSON.stringify(process.env.MYCEL_WEB_BUILD ?? new Date().toISOString()),
  },
  server: {
    port: 19140,
    strictPort: true,
    proxy: { '/api': { target: API_TARGET, ws: true, changeOrigin: false }, '/vendor': { target: API_TARGET }, '/sandbox': { target: API_TARGET, changeOrigin: false } },
  },
  preview: { port: 19141, strictPort: true },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 3000,
  },
  worker: { format: 'es' },
})
