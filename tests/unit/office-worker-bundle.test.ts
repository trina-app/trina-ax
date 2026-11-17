// The PNG decoder in bundles that carry pdf-lib (server/src/files/bundle-pins.ts): Bun.build sometimes bundled
// @pdf-lib/upng as its CommonJS file, and every PDF image of that process then failed as "a damaged PNG or JPG"
// (TC-4636). The office worker built the way a source checkout builds it has no CommonJS import, a bundle built with
// the pin embeds a PNG seal in a PDF, and a bundle pinned to the CommonJS file is caught by the check.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { officeWorkerScript } from '../../server/src/files/extract'
import { assertNoCommonJsUpng, upngModulePath } from '../../server/src/files/bundle-pins'
import { pngRgbaOf } from '../lib/images'

const SEAL = pngRgbaOf(100, 100, (x, y) => ((x - 49.5) ** 2 + (y - 49.5) ** 2 < 45 ** 2 ? [220, 20, 20, 255] : [0, 0, 0, 0]))
const FILES = path.join(import.meta.dir, '../../server/src/files')

/** a small entry that embeds a PNG in a PDF with pdf-lib, bundled into a temp folder by a separate bun process:
 * under bun test 1.3.12 a second Bun.build in one test process can fail to read pdf-lib's files ("Unseekable reading
 * file"), so this file's own process builds only the office worker. `upng` = 'pin' (bundle-pins.ts) or 'cjs' (the
 * CommonJS file named on purpose). */
function buildStamper(upng: 'pin' | 'cjs'): { dir: string; out: string } {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'upng-bundle-')))
  // pdf-lib's ES module, as the server's own `import ... from 'pdf-lib'` bundles it (its CommonJS file uses require)
  const pdfLib = path.join(path.dirname(require.resolve('pdf-lib/package.json', { paths: [FILES] })), 'es', 'index.js')
  fs.writeFileSync(path.join(dir, 'entry.ts'), `import { PDFDocument } from ${JSON.stringify(pdfLib)}
const png = await Bun.file(process.argv[2]!).bytes()
const doc = await PDFDocument.create()
const img = await doc.embedPng(png)
doc.addPage([200, 200]).drawImage(img, { x: 10, y: 10, width: 50, height: 50 })
const bytes = await doc.save()
console.log('ok ' + img.width + 'x' + img.height + ' ' + bytes.length)
`)
  fs.writeFileSync(path.join(dir, 'build.ts'), `import path from 'node:path'
import { pdfLibBundlePlugins, upngModulePath } from ${JSON.stringify(path.join(FILES, 'bundle-pins.ts'))}
const cjs = path.join(path.dirname(upngModulePath()!), 'cjs', 'UPNG.js')
const plugins = ${JSON.stringify(upng)} === 'pin' ? pdfLibBundlePlugins()
  : [{ name: 'cjs-upng', setup(b: import('bun').PluginBuilder) { b.onResolve({ filter: /^@pdf-lib\\/upng$/ }, () => ({ path: cjs })) } }]
const res = await Bun.build({ entrypoints: [${JSON.stringify(path.join(dir, 'entry.ts'))}], target: 'bun', outdir: ${JSON.stringify(dir)}, naming: 'stamper.js', minify: false, plugins })
if (!res.success) { console.error(res.logs.map(String).join('\\n')); process.exit(1) }
`)
  const p = Bun.spawnSync([process.execPath, path.join(dir, 'build.ts')], { stderr: 'pipe', stdout: 'pipe' })
  if (p.exitCode !== 0) throw new Error('stamper build failed: ' + p.stderr.toString())
  return { dir, out: path.join(dir, 'stamper.js') }
}

describe('PNG decoder in pdf-lib bundles', () => {
  test('the check does not match its own source (main.js bundles it)', () => {
    expect(() => assertNoCommonJsUpng(path.join(FILES, 'bundle-pins.ts'))).not.toThrow()
  })

  test('the office worker built from source has no CommonJS PNG decoder', async () => {
    const script = await officeWorkerScript()
    expect(() => assertNoCommonJsUpng(script)).not.toThrow()
  }, 60_000)

  test('a bundle built with the pin embeds a PNG seal in a PDF', () => {
    const { dir, out } = buildStamper('pin')
    try {
      assertNoCommonJsUpng(out)
      fs.writeFileSync(path.join(dir, 'seal.png'), SEAL)
      const p = Bun.spawnSync([process.execPath, out, path.join(dir, 'seal.png')], { stderr: 'pipe' })
      expect(p.stderr.toString()).toBe('')
      expect(p.stdout.toString()).toMatch(/^ok 100x100 \d+/)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  }, 60_000)

  // (this small bundle still reads a PNG on Bun 1.3.12 and 1.4.4; the CI worker that failed had the same CommonJS
  // import and threw `import_upng.default.decode is not a function`, so the check refuses the shape, not a symptom)
  test('a bundle with the CommonJS decoder is refused by the check', () => {
    expect(fs.existsSync(path.join(path.dirname(upngModulePath()!), 'cjs', 'UPNG.js'))).toBe(true)
    const { dir, out } = buildStamper('cjs')
    try {
      expect(() => assertNoCommonJsUpng(out)).toThrow(/stamper\.js bundled the PNG reader \(@pdf-lib\/upng\) as a CommonJS import/)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  }, 60_000)
})
