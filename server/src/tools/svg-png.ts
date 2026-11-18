// SVG pictures to PNG for make_file (second limits audit N4, QA TC-4916; docs/decisions/20261118-rich-office-output.md):
// format "png" (a chart, a Gantt chart or a diagram the AI drew as SVG becomes a picture file), and an .svg picture in a
// Word or PowerPoint file (turned into a PNG before pandoc, so every Word, PowerPoint and preview shows it).
// typst draws it: every install that makes PDFs has typst already (the Linux bundle's bin/, Homebrew on a Mac), and
// typst renders SVG with resvg, its text in the document's fonts (the bundled Noto Sans CJK on Linux, the Mac's own).
// It runs like the PDF: in the converter isolation, in an empty work folder holding only the SVG, `--root` that
// folder (an SVG that refers to another file or a web address gets nothing).
import fs from 'node:fs'
import path from 'node:path'
import { ToolError } from '../policy/errors'
import { typstJobs } from '../system/limits'
import { dirBytes, readOutput, runIsolated } from './isolate'

/** the largest SVG drawn */
export const SVG_MAX = 10 * 1024 * 1024
/** the PNG is drawn at twice the SVG's size (sharp in a document and on a phone), its longest side at most this */
export const PNG_MAX_SIDE = 4000
const PNG_MAX_BYTES = 64 * 1024 * 1024
/** one drawing: time and memory (a 100 KB SVG of blur filters reached 4.4 GB and ran a full minute without them) */
export const SVG_TIMEOUT_MS = 20_000
export const SVG_RSS_MIB = 1024
/** filter primitives (feGaussianBlur, feTurbulence ...) in one SVG at most: a chart needs none or a few */
export const SVG_MAX_FILTERS = 50

/** A number in CSS pixels from an SVG length ("400", "400px", "4in", "10cm", "300pt"); null for "100%" and the rest. */
function cssPx(v: string | undefined): number | null {
  if (!v) return null
  const m = /^\s*([0-9]*\.?[0-9]+)\s*(px|pt|in|cm|mm)?\s*$/i.exec(v)
  if (!m) return null
  const n = Number(m[1]), u = (m[2] ?? 'px').toLowerCase()
  return n * ({ px: 1, pt: 4 / 3, in: 96, cm: 96 / 2.54, mm: 96 / 25.4 } as Record<string, number>)[u]!
}

/** The size the SVG asks for, in CSS pixels: width/height, else the viewBox, else 800 × 600; an aspect from the other. */
export function svgSize(svg: string): { w: number; h: number } {
  const root = /<svg\b[^>]*>/i.exec(svg)?.[0]
  if (!root) throw new ToolError('this is not an SVG picture (no <svg> element); nothing was saved')
  const attr = (n: string) => new RegExp(`\\s${n}\\s*=\\s*["']([^"']*)["']`, 'i').exec(root)?.[1]
  const vb = attr('viewBox')?.trim().split(/[\s,]+/).map(Number)
  const vw = vb && vb.length === 4 && vb[2]! > 0 && vb[3]! > 0 ? vb[2]! : null
  const vh = vw ? vb![3]! : null
  let w = cssPx(attr('width')), h = cssPx(attr('height'))
  if (w && !h) h = vw && vh ? (w * vh) / vw : w * 0.75
  if (h && !w) w = vw && vh ? (h * vw) / vh : h / 0.75
  if (!w || !h) { w = vw ?? 800; h = vh ?? 600 }
  return { w, h }
}

/** The SVG's size drawn: twice its own, the longest side at most PNG_MAX_SIDE, at least 16 px. In typst points
 * (1 CSS px = 0.75 pt) at 192 pixels per inch (2 PNG pixels per CSS pixel). */
export function drawSize(s: { w: number; h: number }): { wPt: number; hPt: number } {
  const scale = Math.min(1, PNG_MAX_SIDE / (2 * Math.max(s.w, s.h)))
  const w = Math.max(8, s.w * scale), h = Math.max(8, s.h * scale)
  return { wPt: Math.round(w * 0.75 * 100) / 100, hPt: Math.round(h * 0.75 * 100) / 100 }
}

export interface SvgPngTools { typst: string | null; fonts?: string | null }

/**
 * The PNG of `svg`, drawn in the work folder `work` (made by the caller, removed by it): the SVG and a small typst
 * document go there under names nothing has taken (`name`), typst compiles to `<name>.png`. `fonts`: the font list
 * (make-file.ts pdfFonts) used for SVG text whose own font is not on the server.
 */
export async function svgToPng(tools: SvgPngTools, svg: Uint8Array, work: string, name: string, fonts: string[], signal?: AbortSignal): Promise<Uint8Array> {
  if (!tools.typst) throw new ToolError('typst is not installed on the server, so an SVG picture cannot be turned into a PNG here; nothing was saved')
  if (svg.byteLength > SVG_MAX) throw new ToolError(`the SVG picture is larger than ${SVG_MAX / 1024 / 1024} MB; nothing was saved`)
  const text = new TextDecoder().decode(svg)
  const filters = (text.match(/<(?:[\w-]+:)?fe[A-Z]\w*\b/g) ?? []).length
  if (filters > SVG_MAX_FILTERS) throw new ToolError(`the SVG picture has ${filters} filter effects (at most ${SVG_MAX_FILTERS}); draw it without them; nothing was saved`)
  const { wPt, hPt } = drawSize(svgSize(text))
  fs.writeFileSync(path.join(work, `${name}.svg`), svg, { flag: 'wx', mode: 0o600 })
  const doc = [
    '#set page(width: auto, height: auto, margin: 0pt, fill: none)',
    `#set text(font: (${fonts.map((f) => JSON.stringify(f)).join(', ')}))`,
    `#image("${name}.svg", width: ${wPt}pt, height: ${hPt}pt, fit: "contain")`,
    '',
  ].join('\n')
  fs.writeFileSync(path.join(work, `${name}.typ`), doc, { flag: 'wx', mode: 0o600 })
  const jobs = typstJobs()
  const r = await runIsolated({
    cmd: tools.typst,
    args: ['compile', ...(jobs ? ['--jobs', String(jobs)] : []), ...(tools.fonts ? ['--font-path', tools.fonts] : []), '--root', work, '--format', 'png', '--ppi', '192', `${name}.typ`, `${name}.png`],
    workDir: work, readPaths: tools.fonts ? [tools.fonts] : [], timeoutMs: SVG_TIMEOUT_MS, signal,
    // what the work folder holds already (a Word file's other pictures) plus the PNG
    maxRssMiB: SVG_RSS_MIB, maxWorkBytes: dirBytes(work) + PNG_MAX_BYTES + 1024 * 1024,
  })
  if (r.code !== 0) {
    if (r.killed === 'timeout') throw new ToolError('drawing the SVG picture took too long; make it simpler (fewer shapes, no filter effects); nothing was saved')
    if (r.killed === 'memory') throw new ToolError('drawing the SVG picture needs too much memory; make it simpler (fewer shapes, no filter effects); nothing was saved')
    if (r.killed === 'disk') throw new ToolError('the PNG would be too large; nothing was saved')
    const why = r.stderr.split(work + '/').join('').split(work).join('.').split('\n').filter((l) => /error/i.test(l)).slice(0, 2).join(' ').slice(0, 300)
    throw new ToolError(`the SVG picture could not be drawn (${why || 'unknown error'}); check that it is a complete SVG; nothing was saved`)
  }
  const got = readOutput(work, `${name}.png`, PNG_MAX_BYTES)
  if (!got.ok) throw new ToolError(got.why === 'too_large' ? 'the PNG would be too large; nothing was saved' : 'the converter produced no file')
  return new Uint8Array(got.bytes)
}
