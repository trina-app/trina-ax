// The product's name in the files the browser reads before the app runs (shared/src/product.ts is the one place it is
// written): index.html (title, home-screen title, noscript), /manifest.webmanifest and /sw.js (its offline page).
// The templates are web/index.html and web/pwa/*; their __PRODUCT_*__ placeholders are filled here, at build (emitted
// into dist/) and by the dev server (served from memory). A placeholder left over fails the build.
import fs from 'node:fs'
import path from 'node:path'
import type { Plugin } from 'vite'
// relative, not @mycel/shared: Vite bundles the config's relative imports, the workspace package it would load raw
import { PRODUCT } from '../../shared/src/product.ts'

const PWA_DIR = path.resolve(import.meta.dirname, '../pwa')
/** the generated files: served at /<name>, emitted as dist/<name> */
export const PWA_FILES = { 'manifest.webmanifest': 'application/manifest+json', 'sw.js': 'text/javascript' } as const

const html = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
/** inside a JSON string or a JS template literal: JSON escaping, plus ` and ${ for the template literal */
const jsText = (s: string) => JSON.stringify(s).slice(1, -1).replace(/`/g, '\\`').replace(/\$\{/g, '\\${')

/** Fill the placeholders: __PRODUCT_NAME__ / __PRODUCT_SHORT_NAME__ as text, *_HTML__ escaped for HTML. In the
 * manifest (JSON) and sw.js (its offline page is a JS template literal) the value is also escaped for the string. */
export function fillProduct(text: string, file: string, inString = false): string {
  const esc = inString ? jsText : (s: string) => s
  const out = text
    .replace(/__PRODUCT_NAME_HTML__/g, () => esc(html(PRODUCT.displayName)))
    .replace(/__PRODUCT_SHORT_NAME_HTML__/g, () => esc(html(PRODUCT.shortName)))
    .replace(/__PRODUCT_NAME__/g, () => esc(PRODUCT.displayName))
    .replace(/__PRODUCT_SHORT_NAME__/g, () => esc(PRODUCT.shortName))
  const left = /__PRODUCT_[A-Z_]*__/.exec(out)
  if (left) throw new Error(`${file}: unknown placeholder ${left[0]}`)
  return out
}

export function pwaFile(name: keyof typeof PWA_FILES): string {
  const text = fillProduct(fs.readFileSync(path.join(PWA_DIR, name), 'utf8'), `web/pwa/${name}`, true)
  if (name === 'manifest.webmanifest') JSON.parse(text) // a broken manifest fails the build, not the phone
  return text
}

export function productPages(): Plugin {
  return {
    name: 'mycel-product-pages',
    transformIndexHtml: { order: 'pre', handler: (text) => fillProduct(text, 'web/index.html') },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const name = (req.url ?? '').split('?')[0]!.slice(1) as keyof typeof PWA_FILES
        if (!(name in PWA_FILES)) return next()
        res.setHeader('content-type', `${PWA_FILES[name]}; charset=utf-8`)
        res.setHeader('cache-control', 'no-store')
        res.end(pwaFile(name))
      })
    },
    generateBundle() {
      for (const name of Object.keys(PWA_FILES) as (keyof typeof PWA_FILES)[]) this.emitFile({ type: 'asset', fileName: name, source: pwaFile(name) })
    },
  }
}
