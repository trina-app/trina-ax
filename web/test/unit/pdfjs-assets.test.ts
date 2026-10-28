// pdf.js's data files ship with the app (web/scripts/pdfjs-assets.ts, web/src/lib/pdfjs-assets.ts): every file this
// pdf.js asks for by name is copied, the preview points pdf.js at them, and react-pdf runs the same pdf.js version
// whose files are copied (the folder name carries the version).
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pdfjsDataFiles, pdfjsDist } from '../../scripts/pdfjs-assets'
import { pdfjsAssetsDir, pdfjsDataOptions } from '../../src/lib/pdfjs-assets'

const { root, version } = pdfjsDist()
const files = pdfjsDataFiles(root, version)
const copied = new Set(files.map(([src]) => src))

describe('pdf.js data files', () => {
  test('react-pdf uses the pdfjs-dist whose files are copied', () => {
    const reactPdf = path.dirname(fs.realpathSync(createRequire(path.join(import.meta.dir, '../../package.json')).resolve('react-pdf')))
    const theirs = createRequire(path.join(reactPdf, 'x.js')).resolve('pdfjs-dist/package.json')
    expect(fs.realpathSync(path.dirname(theirs))).toBe(fs.realpathSync(root))
  })

  test('every file the worker loads by name is copied (a new pdf.js that needs another one fails here)', () => {
    const worker = fs.readFileSync(path.join(root, 'build', 'pdf.worker.mjs'), 'utf8')
    const named = new Set<string>()
    for (const m of worker.matchAll(/_(?:noWasm)?[fF]ilename = "([^"]+)"/g)) named.add(`wasm/${m[1]}`)
    for (const m of worker.matchAll(/\}([\w.-]+\.wasm)`/g)) named.add(`wasm/${m[1]}`)
    for (const m of worker.matchAll(/\}([\w.-]+\.icc)`/g)) named.add(`iccs/${m[1]}`)
    expect([...named].sort()).toEqual(['iccs/CGATS001Compat-v2-micro.icc', 'wasm/jbig2.wasm', 'wasm/jbig2_nowasm_fallback.js', 'wasm/openjpeg.wasm', 'wasm/openjpeg_nowasm_fallback.js', 'wasm/qcms_bg.wasm'])
    for (const f of named) expect(copied.has(f)).toBe(true)
  })

  test('CMaps (Korean ones too), the standard fonts and the licences go along; the PDF script sandbox does not', () => {
    for (const f of ['cmaps/UniKS-UCS2-H.bcmap', 'cmaps/KSC-EUC-H.bcmap', 'cmaps/Adobe-Korea1-UCS2.bcmap', 'cmaps/LICENSE', 'standard_fonts/FoxitSerif.pfb', 'standard_fonts/LiberationSans-Regular.ttf', 'standard_fonts/LICENSE_FOXIT', 'wasm/LICENSE_OPENJPEG', 'wasm/LICENSE_JBIG2', 'wasm/LICENSE_QCMS', 'iccs/LICENSE']) {
      expect(copied.has(f)).toBe(true)
    }
    expect([...copied].filter((f) => f.includes('quickjs'))).toEqual([])
    for (const [src, dest] of files) expect(dest).toBe(`assets/pdfjs-${version}/${src}`)
  })

  test('the preview points pdf.js at them with absolute folder URLs', () => {
    expect(pdfjsAssetsDir('6.3.289')).toBe('assets/pdfjs-6.3.289/')
    expect(pdfjsDataOptions('https://acme.example', version)).toEqual({
      cMapUrl: `https://acme.example/assets/pdfjs-${version}/cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `https://acme.example/assets/pdfjs-${version}/standard_fonts/`,
      wasmUrl: `https://acme.example/assets/pdfjs-${version}/wasm/`,
      iccUrl: `https://acme.example/assets/pdfjs-${version}/iccs/`,
    })
    // the option names this pdf.js reads
    const api = fs.readFileSync(path.join(root, 'build', 'pdf.mjs'), 'utf8')
    for (const k of ['cMapUrl', 'cMapPacked', 'standardFontDataUrl', 'wasmUrl', 'iccUrl']) expect(api).toContain(`src.${k}`)
  })
})
