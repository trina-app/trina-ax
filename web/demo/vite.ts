// The demo build (`bun run build:demo` = `vite build --mode demo`, docs/AGENTS/plan/20261114-0507-mina-demo.md): the
// same web app, started by web/demo/main.tsx, which answers the API in the page with the e2e mock server
// (web/test/mock/server.ts) playing a scripted story. Only `--mode demo` reaches this file's settings; the normal build's
// config is untouched (web/vite.config.ts returns it as it is for every other mode).
import fs from 'node:fs'
import path from 'node:path'
import type { Plugin, UserConfig } from 'vite'

const here = import.meta.dirname
const shim = (f: string) => path.join(here, 'shims', f)
/** the story: the real one when its folder is there (written on feat/mina-demo-content), else the example */
export const contentDir = () => {
  const real = path.resolve(here, '../../scripts/demo/mina')
  return fs.existsSync(path.join(real, 'index.ts')) ? real : path.join(here, 'example')
}

const ASSETS_ID = 'virtual:demo-assets'

function demoPages(): Plugin {
  return {
    name: 'mycel-demo-pages',
    enforce: 'post',
    // the story's assets/ folder as { file name: its built URL } (web/demo/seed.ts reads them at the start)
    resolveId: (id) => (id === ASSETS_ID ? '\0' + ASSETS_ID : null),
    load(id) {
      if (id !== '\0' + ASSETS_ID) return null
      const dir = path.join(contentDir(), 'assets')
      const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => !f.startsWith('.')).sort() : []
      return files.map((f, i) => `import a${i} from ${JSON.stringify(path.join(dir, f) + '?url')}\n`).join('')
        + `export default {${files.map((f, i) => `${JSON.stringify(f)}: a${i}`).join(', ')}}\n`
    },
    // the dev server (bun run dev:demo) serves the demo's worker as /sw.js too
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split('?')[0] !== '/sw.js') return next()
        res.setHeader('content-type', 'text/javascript')
        res.end(fs.readFileSync(path.join(here, 'sw.js'), 'utf8'))
      })
    },
    // the page starts the demo's entry, which then loads the app's own src/main.tsx
    transformIndexHtml: (html) => html.replace('/src/main.tsx', '/demo/main.tsx'),
    // the mock loads the HWP renderer from the server's folder (Bun only): never in the browser
    transform(code, id) {
      if (!id.endsWith('/test/mock/server.ts')) return null
      const out = code.replace(/const hwpEngine = import\([^\n]*\n/, 'const hwpEngine = new Promise(() => {})\n')
      if (out === code) throw new Error('demo: the mock server no longer loads hwpEngine as expected')
      return { code: out, map: null }
    },
    // the app registers /sw.js (lib/pwa.ts): in the demo that is the worker that answers pictures and downloads from the
    // page (web/demo/sw.js) instead of the product's offline worker
    generateBundle(_o, bundle) {
      const sw = bundle['sw.js']
      if (!sw || sw.type !== 'asset') throw new Error('demo: sw.js was not emitted')
      sw.source = fs.readFileSync(path.join(here, 'sw.js'), 'utf8')
    },
  }
}

export function demoConfig(base: UserConfig): UserConfig {
  return {
    ...base,
    plugins: [...(base.plugins ?? []), demoPages()],
    resolve: {
      alias: [
        { find: /^node:(fs|os|path|zlib)$/, replacement: shim('node.ts') },
        { find: /^.*\/server\/src\/credentials\/seal$/, replacement: shim('server-stubs.ts') },
        { find: /^.*\/server\/src\/routes\/web-static$/, replacement: shim('server-stubs.ts') },
        { find: '@demo-content', replacement: path.join(contentDir(), 'index.ts') },
      ],
    },
    define: {
      ...base.define,
      'process.env.TMPDIR': 'undefined',
      'process.pid': '0',
    },
    build: { ...base.build, outDir: 'dist-demo' },
  }
}
