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

// Pretendard (OFL-1.1, resources/notices/pretendard), one variable file for two artifact pages that load it from here
// (the frame allows fonts from /vendor/ only): the promo video templates (docs/DECISIONS.md "V") link
// fonts/promo-video.css, kept as it is because saved promo videos link it (the MP4 render reads the same woff2), and the
// intro deck's preview ("D2") links fonts/pretendard.css
const FONT = path.resolve(WEB, '..', 'resources', 'promo-video', 'fonts', 'PretendardVariable.woff2')
const fontFace = (family: string) => `@font-face{font-family:"${family}";src:url("PretendardVariable.woff2") format("woff2");font-weight:45 930;font-style:normal;font-display:block}\n`
fs.mkdirSync(path.join(OUT, 'fonts'), { recursive: true })
fs.copyFileSync(FONT, path.join(OUT, 'fonts', 'PretendardVariable.woff2'))
fs.writeFileSync(path.join(OUT, 'fonts', 'promo-video.css'), fontFace('Pretendard Promo'))
fs.writeFileSync(path.join(OUT, 'fonts', 'pretendard.css'), fontFace('Pretendard Web'))
// the promo video's sounds (docs/DECISIONS.md "V"; CC0, resources/promo-video/audio/SOURCES.md): the artifact frame lets a
// sound in only as a data: address, so each one is a script that puts its address in window.__pvAudio (the player loads
// them only when the person turns the sound on); the MP4 render reads the files themselves
const AUDIO = path.resolve(WEB, '..', 'resources', 'promo-video', 'audio')
fs.mkdirSync(path.join(OUT, 'promo-video'), { recursive: true })
for (const f of fs.readdirSync(AUDIO).filter((x) => x.endsWith('.m4a'))) {
  const name = f.replace(/\.m4a$/, '')
  const data = fs.readFileSync(path.join(AUDIO, f)).toString('base64')
  fs.writeFileSync(path.join(OUT, 'promo-video', `${name}.js`), `(window.__pvAudio=window.__pvAudio||{})[${JSON.stringify(name)}]="data:audio/mp4;base64,${data}";\n`)
}
fs.copyFileSync(path.join(pkgDir('@tailwindcss/browser'), 'dist', 'index.global.js'), path.join(OUT, 'tailwind.js'))

const version = (p: string) => (JSON.parse(fs.readFileSync(path.join(pkgDir(p), 'package.json'), 'utf8')) as { version: string }).version
const manifest = {
  generatedAt: new Date().toISOString(),
  modules: Object.keys(entries).concat('tailwind.js'),
  versions: Object.fromEntries(['react', 'react-dom', 'lucide-react', 'recharts', 'mermaid', '@tailwindcss/browser'].map((p) => [p, version(p)])),
}
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2))
const total = fs.readdirSync(OUT).reduce((n, f) => n + (fs.statSync(path.join(OUT, f)).isFile() ? fs.statSync(path.join(OUT, f)).size : 0), 0)
console.log(`vendor: ${fs.readdirSync(OUT).length} files, ${(total / 1024 / 1024).toFixed(1)} MB → ${path.relative(process.cwd(), OUT)}`)
