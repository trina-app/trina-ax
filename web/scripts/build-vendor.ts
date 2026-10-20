// Bundles the libraries artifacts may use into web/dist/vendor/ (served by the team server at /vendor/, tab 5:
// artifact frames load nothing from public CDNs). One React instance is shared by every entry (code splitting).
//   react.js  react-jsx-runtime.js  react-dom.js  react-dom-client.js  lucide-react.js  recharts.js  mermaid.js
//   tailwind.js (Tailwind's in-browser build: compiles the classes the artifact uses into <style>, no eval)
// The import map in lib/artifacts.ts (VENDOR_MODULES) must match these names.
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const WEB = path.resolve(import.meta.dir, '..')
const OUT = path.join(WEB, 'dist', 'vendor')
const SRC = path.join(WEB, 'node_modules', '.mycel-vendor')
const require = createRequire(path.join(WEB, 'package.json'))

/** Named exports of a CommonJS package, so `import { useState } from "react"` works from the ESM bundle. */
function cjsEntry(spec: string): string {
  const mod = require(spec) as Record<string, unknown>
  const names = Object.keys(mod).filter((k) => /^[A-Za-z_$][\w$]*$/.test(k) && k !== 'default')
  return `import M from ${JSON.stringify(spec)};\nexport default M;\nexport const { ${names.join(', ')} } = M;\n`
}

const entries: Record<string, string> = {
  'react.js': cjsEntry('react'),
  'react-jsx-runtime.js': cjsEntry('react/jsx-runtime'),
  'react-dom.js': cjsEntry('react-dom'),
  'react-dom-client.js': cjsEntry('react-dom/client'),
  'lucide-react.js': `export * from 'lucide-react';\nimport * as L from 'lucide-react';\nexport default L;\n`,
  'recharts.js': `export * from 'recharts';\nimport * as R from 'recharts';\nexport default R;\n`,
  'mermaid.js': `export { default } from 'mermaid';\n`,
}

fs.rmSync(SRC, { recursive: true, force: true })
fs.mkdirSync(SRC, { recursive: true })
for (const [name, code] of Object.entries(entries)) fs.writeFileSync(path.join(SRC, name), code)
fs.rmSync(OUT, { recursive: true, force: true })
fs.mkdirSync(OUT, { recursive: true })

const result = await Bun.build({
  entrypoints: Object.keys(entries).map((n) => path.join(SRC, n)),
  outdir: OUT,
  root: SRC,
  target: 'browser',
  format: 'esm',
  splitting: true,
  minify: true,
  sourcemap: 'none',
  naming: { entry: '[name].[ext]', chunk: 'chunk-[hash].[ext]', asset: 'asset-[hash].[ext]' },
  define: { 'process.env.NODE_ENV': '"production"' },
})
if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

const pkgDir = (p: string) => path.dirname(require.resolve(`${p}/package.json`))
fs.copyFileSync(path.join(pkgDir('@tailwindcss/browser'), 'dist', 'index.global.js'), path.join(OUT, 'tailwind.js'))

const version = (p: string) => (JSON.parse(fs.readFileSync(path.join(pkgDir(p), 'package.json'), 'utf8')) as { version: string }).version
const manifest = {
  generatedAt: new Date().toISOString(),
  modules: Object.keys(entries).concat('tailwind.js'),
  versions: Object.fromEntries(['react', 'react-dom', 'lucide-react', 'recharts', 'mermaid', '@tailwindcss/browser'].map((p) => [p, version(p)])),
}
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2))
const total = fs.readdirSync(OUT).reduce((n, f) => n + fs.statSync(path.join(OUT, f)).size, 0)
console.log(`vendor: ${fs.readdirSync(OUT).length} files, ${(total / 1024 / 1024).toFixed(1)} MB → ${path.relative(process.cwd(), OUT)}`)
