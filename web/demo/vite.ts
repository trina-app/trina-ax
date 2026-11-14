// The demo build (`bun run build:demo` = `vite build --mode demo`, docs/AGENTS/plan/20261114-0507-mina-demo.md): the
// same web app, started by web/demo/main.tsx, which answers the API in the page with the e2e mock server
// (web/test/mock/server.ts) playing a scripted story. Only `--mode demo` reaches this file's settings; the normal build's
// config is untouched (web/vite.config.ts returns it as it is for every other mode).
import fs from 'node:fs'
import path from 'node:path'
import type { Plugin, UserConfig } from 'vite'

const here = import.meta.dirname
const shim = (f: string) => path.join(here, 'shims', f)
const STORY = path.resolve(here, '../../scripts/demo/mina')
/** the story's language (DEMO_LOCALE=en|ko|ja|es|id, default en) and its file: scripts/demo/mina/index.<locale>.ts when
 * there, else scripts/demo/mina/index.ts (English), else the example. The app shows its own words in that language. */
export const demoLocale = () => process.env.DEMO_LOCALE ?? 'en'
export const contentFile = () => {
  for (const f of [path.join(STORY, `index.${demoLocale()}.ts`), path.join(STORY, 'index.ts')]) if (fs.existsSync(f)) return f
  return path.join(here, 'example', 'index.ts')
}
export const contentDir = () => path.dirname(contentFile())
/** assets/ next to the story file, then the story's shared assets/ (a language's own file of the same name wins) */
const assetFiles = () => {
  const out = new Map<string, string>()
  for (const dir of [path.join(contentDir(), 'assets'), path.join(STORY, 'assets')]) {
    if (!fs.existsSync(dir)) continue
    for (const f of fs.readdirSync(dir).sort()) if (!f.startsWith('.') && !out.has(f)) out.set(f, path.join(dir, f))
  }
  return [...out]
}

const ASSETS_ID = 'virtual:demo-assets'

/** where the demo is served on its site (DEMO_BASE, e.g. /demo/ for https://ax.trina.app/demo/; default the root) */
export const demoBase = () => {
  const b = process.env.DEMO_BASE?.trim() || '/'
  return `/${b.replace(/^\/+|\/+$/g, '')}/`.replace(/^\/\/$/, '/')
}

/** The demos of every language on one site, for the guide line's language links: DEMO_LANGS="en=/demo/,ko=/demo/ko/",
 * by default English at the base (a language's own build sits in <English base><locale>/) and Korean next to it */
export const demoLangs = (): { locale: string; base: string }[] => {
  const given = process.env.DEMO_LANGS?.trim()
  if (given) return given.split(',').map((x) => { const [locale, base] = x.split('='); return { locale: locale!.trim(), base: base!.trim() } })
  const base = demoBase()
  const locale = demoLocale()
  const en = locale !== 'en' && base.endsWith(`/${locale}/`) ? base.slice(0, -(locale.length + 1)) : base
  return [{ locale: 'en', base: en }, { locale: 'ko', base: `${en}ko/` }]
}

/** The app under a base without a change to web/src (web/demo/base.ts says how): on the app's source, in the demo build
 * only, its history gets the demo's window, its direct reads of the address read the demo's location, and its worker
 * is registered at the base. A source that no longer reads as expected stops the build. */
function demoBaseSource(): Plugin {
  const win = '((globalThis as { __mycelDemoWindow?: Window }).__mycelDemoWindow ?? window)'
  const loc = '((globalThis as { __mycelDemoLocation?: Location }).__mycelDemoLocation ?? window.location)'
  return {
    name: 'mycel-demo-base-source',
    enforce: 'pre',
    transform(code, id) {
      const file = id.split('?')[0]!
      if (!file.includes('/web/src/') || !/\.tsx?$/.test(file)) return null
      let out = code.replaceAll('window.location.pathname', `${loc}.pathname`)
      if (file.endsWith('/web/src/lib/screenHistory.ts')) {
        const next = out.replace('createScreenHistory(win: Window = window)', `createScreenHistory(win: Window = ${win})`)
        if (next === out) throw new Error('demo: lib/screenHistory.ts no longer takes its window as expected')
        out = next
      }
      // the app's worker (lib/pwa.ts) and push (lib/push.ts) register the worker at the base
      if (file.endsWith('/web/src/lib/pwa.ts') || file.endsWith('/web/src/lib/push.ts')) {
        const next = out.replaceAll("register('/sw.js', { scope: '/' })", "register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL })")
          .replaceAll("getRegistration('/')", 'getRegistration(import.meta.env.BASE_URL)')
        if (next === out) throw new Error(`demo: ${file} no longer registers /sw.js as expected`)
        out = next
      }
      return out === code ? null : { code: out, map: null }
    },
  }
}

function demoPages(): Plugin {
  return {
    name: 'mycel-demo-pages',
    enforce: 'post',
    // the story's assets/ folder as { file name: its built URL } (web/demo/seed.ts reads them at the start)
    resolveId: (id) => (id === ASSETS_ID ? '\0' + ASSETS_ID : null),
    load(id) {
      // a Markdown file the mock imports `with { type: 'text' }` (server/src/onboarding/skill-examples.ts), as Bun does
      if (id.endsWith('.md') && !id.includes('?')) return `export default ${JSON.stringify(fs.readFileSync(id, 'utf8'))}\n`
      if (id !== '\0' + ASSETS_ID) return null
      const files = assetFiles()
      return files.map(([, file], i) => `import a${i} from ${JSON.stringify(file + '?url')}\n`).join('')
        + `export default {${files.map(([name], i) => `${JSON.stringify(name)}: a${i}`).join(', ')}}\n`
    },
    // the dev server (bun run dev:demo) serves the demo's worker at the base too
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split('?')[0] !== `${demoBase()}sw.js`) return next()
        res.setHeader('content-type', 'text/javascript')
        res.end(fs.readFileSync(path.join(here, 'sw.js'), 'utf8'))
      })
    },
    // the page starts the demo's entry, which then loads the app's own src/main.tsx
    transformIndexHtml: { order: 'pre', handler: (html) => html.replace('/src/main.tsx', '/demo/main.tsx').replace(/\s*<link rel="manifest"[^>]*>/, '') },
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
    base: demoBase(),
    plugins: [demoBaseSource(), ...(base.plugins ?? []), demoPages()],
    resolve: {
      alias: [
        { find: /^node:(fs|os|path|zlib)$/, replacement: shim('node.ts') },
        { find: /^.*\/server\/src\/credentials\/seal$/, replacement: shim('server-stubs.ts') },
        { find: /^.*\/server\/src\/routes\/web-static$/, replacement: shim('server-stubs.ts') },
        { find: '@demo-content', replacement: contentFile() },
      ],
    },
    define: {
      ...base.define,
      'process.env.TMPDIR': 'undefined',
      'process.pid': '0',
      __DEMO_LANGS__: JSON.stringify(demoLangs()),
    },
    // DEMO_OUT: another folder, e.g. one per language (dist-demo-ko)
    build: { ...base.build, outDir: process.env.DEMO_OUT?.trim() || 'dist-demo' },
  }
}
