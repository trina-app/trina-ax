// Serves a built docs site for a local preview. `bun run docs:serve` (after `bun run docs:build`).
//   bun scripts/docs/serve.ts [--dir dist/docs-site] [--port 19790] [--host 127.0.0.1]
// Loopback by default. Static files only: no directory listing, no paths outside --dir.
import fs from 'node:fs'
import path from 'node:path'
import { ROOT } from './site'

const args = process.argv.slice(2)
const opt = (name: string, fallback: string) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1]! : fallback }
const dir = path.resolve(opt('--dir', path.join(ROOT, 'dist/docs-site')))
const port = Number(opt('--port', '19790'))
const hostname = opt('--host', '127.0.0.1')
if (!fs.existsSync(path.join(dir, 'index.html'))) throw new Error(`No built site in ${dir}. Run bun run docs:build first.`)

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
}

function resolve(urlPath: string): string | null {
  let p = decodeURIComponent(urlPath)
  if (p.endsWith('/')) p += 'index.html'
  const file = path.resolve(dir, `.${p}`)
  if (file !== dir && !file.startsWith(dir + path.sep)) return null
  if (fs.existsSync(file) && fs.statSync(file).isFile()) return file
  const page = path.join(file, 'index.html')
  return fs.existsSync(page) ? page : null
}

Bun.serve({
  hostname, port,
  fetch(req) {
    const url = new URL(req.url)
    let file: string | null = null
    try { file = resolve(url.pathname) } catch { file = null }
    if (file && !url.pathname.endsWith('/') && file.endsWith(`${path.sep}index.html`) && !url.pathname.endsWith('.html')) {
      return Response.redirect(`${url.pathname}/${url.search}`, 301)
    }
    const headers = (f: string) => ({ 'content-type': TYPES[path.extname(f)] ?? 'application/octet-stream', 'x-content-type-options': 'nosniff', 'cache-control': 'no-cache' })
    if (!file) return new Response(Bun.file(path.join(dir, '404.html')), { status: 404, headers: headers('404.html') })
    return new Response(Bun.file(file), { headers: headers(file) })
  },
})
console.log(`Docs preview: http://${hostname}:${port}/  (${dir})`)
