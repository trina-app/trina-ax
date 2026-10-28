// Ships pdf.js's data files with the app (web/src/lib/pdfjs-assets.ts says what they are for): copied from
// node_modules/pdfjs-dist into dist/assets/pdfjs-<version>/ after the build, and served from node_modules by the dev
// server. Licence files in those folders go along (OpenJPEG, JBIG2, qcms, Foxit and Liberation fonts).
// quickjs-eval (pdf.js's JavaScript sandbox for scripted PDFs) is left out: the preview runs no PDF scripts.
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import type { Plugin } from 'vite'
import { PDFJS_DATA_DIRS, pdfjsAssetsDir } from '../src/lib/pdfjs-assets.ts'

const require = createRequire(path.resolve(import.meta.dirname, '..', 'package.json'))

/** The pdfjs-dist the web app (react-pdf and the worker import) uses. */
export function pdfjsDist(): { root: string; version: string } {
  const pj = require.resolve('pdfjs-dist/package.json')
  return { root: path.dirname(pj), version: (JSON.parse(fs.readFileSync(pj, 'utf8')) as { version: string }).version }
}

const LEFT_OUT = /^quickjs-eval\./

/** [file inside pdfjs-dist, path under dist/] of every data file the preview may load. */
export function pdfjsDataFiles(root: string, version: string): [string, string][] {
  const out: [string, string][] = []
  for (const dir of PDFJS_DATA_DIRS) {
    for (const name of fs.readdirSync(path.join(root, dir)).sort()) {
      if (name.startsWith('.') || LEFT_OUT.test(name) || !fs.statSync(path.join(root, dir, name)).isFile()) continue
      out.push([`${dir}/${name}`, `${pdfjsAssetsDir(version)}${dir}/${name}`])
    }
  }
  return out
}

const TYPES: Record<string, string> = { '.wasm': 'application/wasm', '.js': 'text/javascript; charset=utf-8' }

export function pdfjsAssets(): Plugin {
  const { root, version } = pdfjsDist()
  let outDir = 'dist'
  return {
    name: 'mycel-pdfjs-assets',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir)
    },
    configureServer(server) {
      const files = new Map(pdfjsDataFiles(root, version).map(([src, dest]) => [`/${dest}`, src]))
      server.middlewares.use((req, res, next) => {
        const src = files.get((req.url ?? '').split('?')[0]!)
        if (!src) return next()
        res.setHeader('content-type', TYPES[path.extname(src)] ?? 'application/octet-stream')
        res.end(fs.readFileSync(path.join(root, src)))
      })
    },
    writeBundle() {
      for (const [src, dest] of pdfjsDataFiles(root, version)) {
        fs.mkdirSync(path.dirname(path.join(outDir, dest)), { recursive: true })
        fs.copyFileSync(path.join(root, src), path.join(outDir, dest))
      }
    },
  }
}
