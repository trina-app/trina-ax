// Whether the charts of a PowerPoint or Word file can be edited where people open it (QA A-03-L, 2026-11-24: a deck's
// charts had no data sheet, so right-click > Edit Data in PowerPoint found no numbers; Claude Code's decks have one).
// A native chart (ppt/charts/chartN.xml, word/charts/chartN.xml) keeps its numbers in an embedded workbook
// (ppt/embeddings/*.xlsx) named by <c:externalData r:id> through the chart's relationships; every series points at its
// cells (<c:f>Sheet1!$B$2:$B$5</c:f>) and carries a cached copy of the values the slide shows. PowerPoint, Keynote and
// Google Slides open that workbook for Edit Data. A chart without one shows its cached values but cannot be edited.
// A file leaving the work folder (chat/places-copy.ts officeOut) is read back here, and the save result says which
// charts have their data and which do not, so the AI fixes its build before it answers.
// The bytes are untrusted, so this runs only in the office worker (mode `chart-data`); the zip is checked first
// (ooxml.ts parts), the XML is scanned linearly, and the workbook is read by SheetJS.
import * as XLSX from 'xlsx'
import { ToolError } from '../policy/errors'
import { attr, chartPrefix, elements, inner, paragraphs, parts, points, rels, slideOrder, startTag, xmlOf, type Parts } from './ooxml'

export const CHART_DATA_MODE = 'chart-data'

/** charts read at most (a deck with more is read up to here and says so) */
export const CHART_DATA_MAX = 200
/** an embedded workbook larger than this is not opened (counted as unreadable) */
const WORKBOOK_MAX = 32 * 1024 * 1024

/** What one chart's data is: `ok` the workbook is there and holds the numbers the chart shows; `none` no data
 * workbook named (<c:externalData> missing); `missing` named but not in the file; `unreadable` not a workbook;
 * `unlinked` the series name no cells (literal values only); `mismatch` its cells hold other values than the chart shows. */
export type ChartDataState = 'ok' | 'none' | 'missing' | 'unreadable' | 'unlinked' | 'mismatch'

export interface ChartData {
  /** where it is: "slide 3" (PowerPoint) or "chart 2" (Word, in part order) */
  where: string
  title: string
  state: ChartDataState
  /** for `mismatch`: the first series whose cells differ, and the reference */
  detail?: string
}

export interface ChartDataReview { kind: 'pptx' | 'docx'; charts: ChartData[]; more: number }

const CHART_REL = /\/relationships\/chart$/
const CHART_PART = /^(ppt|word)\/charts\/chart\d+\.xml$/

/** The charts of a .pptx or .docx and their data; ToolError when the file cannot be read. */
export function chartDataReview(bytes: Uint8Array): ChartDataReview {
  const p = parts(bytes, 'file')
  const kind = p.has('ppt/presentation.xml') ? 'pptx' : 'docx'
  const names = [...p.keys()].filter((n) => CHART_PART.test(n)).sort((a, b) => num(a) - num(b))
  // PowerPoint: a chart is named by the first slide that shows it
  const onSlide = new Map<string, number>()
  if (kind === 'pptx') {
    slideOrder(p).forEach((slide, i) => {
      for (const r of rels(p, slide).values()) if (CHART_REL.test(r.type) && !onSlide.has(r.target)) onSlide.set(r.target, i + 1)
    })
  }
  const charts: ChartData[] = []
  names.slice(0, CHART_DATA_MAX).forEach((name, i) => {
    const xml = chartPrefix(xmlOf(p, name) ?? '')
    const slide = onSlide.get(name)
    charts.push({ where: slide ? `slide ${slide}` : `chart ${i + 1}`, title: titleOf(xml), ...stateOf(p, name, xml) })
  })
  return { kind, charts, more: Math.max(0, names.length - CHART_DATA_MAX) }
}

const num = (n: string) => Number(/(\d+)\.xml$/.exec(n)?.[1] ?? 0)

function titleOf(xml: string): string {
  const plotAt = startTag(xml, 'c:plotArea', 0)
  const t = inner(plotAt ? xml.slice(0, plotAt.start) : xml, 'c:title')
  if (!t) return ''
  return (paragraphs(t, 'a').join(' ').trim() || points(t)[0] || '').replace(/\s+/g, ' ').slice(0, 80)
}

function stateOf(p: Parts, name: string, xml: string): { state: ChartDataState; detail?: string } {
  const ext = startTag(xml, 'c:externalData', 0)
  const id = ext ? attr(ext.head, 'r:id') : undefined
  if (!id) return { state: 'none' }
  const target = rels(p, name).get(id)?.target
  const data = target ? p.get(target) : undefined
  if (!target || !data) return { state: 'missing' }
  let wb: XLSX.WorkBook
  try {
    if (data.length > WORKBOOK_MAX) return { state: 'unreadable' }
    wb = XLSX.read(data, { type: 'buffer', cellFormula: false, cellHTML: false, cellStyles: false })
  } catch { return { state: 'unreadable' } }
  if (!wb.SheetNames.length) return { state: 'unreadable' }
  let linked = 0
  for (const { inner: ser } of elements(inner(xml, 'c:plotArea') ?? xml, 'c:ser')) {
    for (const [el, numeric] of [['c:val', true], ['c:yVal', true], ['c:xVal', false], ['c:cat', false], ['c:bubbleSize', true], ['c:tx', false]] as const) {
      const part = inner(ser, el)
      if (!part) continue
      const ref = inner(part, 'c:f')
      if (!ref) continue
      linked++
      const cached = points(part)
      // a name (c:tx) caches its one value in <c:v> of the strRef
      if (el === 'c:tx' && !cached.length) { const v = inner(part, 'c:v'); if (v !== undefined) cached[0] = v }
      const cells = cellsOf(wb, ref)
      if (!cells) return { state: 'mismatch', detail: `${ref.trim()} is not a range of its data sheet` }
      for (let i = 0; i < cached.length; i++) {
        if (cached[i] === undefined) continue
        if (!same(cached[i]!, cells[i], numeric)) {
          const name = inner(ser, 'c:tx')
          const shown = name ? (points(name)[0] ?? inner(name, 'c:v') ?? '') : ''
          return { state: 'mismatch', detail: `series${shown ? ` "${shown.slice(0, 40)}"` : ''} shows ${cached[i]!.slice(0, 20)} where its data sheet's ${ref.trim()} holds ${cells[i] === undefined ? 'nothing' : String(cells[i]).slice(0, 20)}` }
        }
      }
    }
  }
  return linked ? { state: 'ok' } : { state: 'unlinked' }
}

/** The values of a chart reference (Sheet1!$B$2:$B$5, 'My sheet'!$A$1), row by row; null when it names no sheet or range. */
function cellsOf(wb: XLSX.WorkBook, ref: string): (string | number | boolean | undefined)[] | null {
  const m = /^\s*(?:'((?:[^']|'')+)'|([^!'\s]+))!\$?([A-Z]{1,3})\$?(\d+)(?::\$?([A-Z]{1,3})\$?(\d+))?\s*$/.exec(ref.replace(/&apos;/g, "'"))
  if (!m) return null
  const sheet = (m[1] ?? m[2] ?? '').replace(/''/g, "'")
  const ws = wb.Sheets[sheet] ?? wb.Sheets[wb.SheetNames.find((n) => n.toLowerCase() === sheet.toLowerCase()) ?? '']
  if (!ws) return null
  const r = XLSX.utils.decode_range(`${m[3]}${m[4]}:${m[5] ?? m[3]}${m[6] ?? m[4]}`)
  if ((r.e.r - r.s.r + 1) * (r.e.c - r.s.c + 1) > 100_000) return null
  const out: (string | number | boolean | undefined)[] = []
  for (let row = r.s.r; row <= r.e.r; row++) for (let col = r.s.c; col <= r.e.c; col++) out.push((ws[XLSX.utils.encode_cell({ r: row, c: col })] as XLSX.CellObject | undefined)?.v as string | number | boolean | undefined)
  return out
}

function same(cached: string, cell: string | number | boolean | undefined, numeric: boolean): boolean {
  if (cell === undefined || cell === null) return cached.trim() === ''
  const a = Number(cached), b = typeof cell === 'number' ? cell : Number(cell)
  if ((numeric || typeof cell === 'number') && cached.trim() !== '' && Number.isFinite(a) && Number.isFinite(b)) return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b))
  return cached.trim() === String(cell).trim()
}

const n = (k: number, one: string, many: string = one + 's') => `${k} ${k === 1 ? one : many}`

const WHY: Record<Exclude<ChartDataState, 'ok'>, string> = {
  none: 'no data sheet (no <c:externalData>)',
  missing: 'its data sheet is named but not in the file',
  unreadable: 'its data sheet is not a workbook that can be read',
  unlinked: 'its series name no cells of a data sheet',
  mismatch: 'its data sheet holds other numbers than the chart shows',
}

/** One line for a save result ('' when the file has no chart): which charts can be edited with Edit Data, which cannot and why. */
export function chartDataLine(r: ChartDataReview): string {
  const total = r.charts.length + r.more
  if (!total) return ''
  const app = r.kind === 'pptx' ? 'PowerPoint' : 'Word'
  const bad = r.charts.filter((c) => c.state !== 'ok')
  if (!bad.length) return ` Read back: ${total === 1 ? 'its chart is a native chart' : `all ${total} charts are native charts`} with ${total === 1 ? 'its' : 'their'} data sheet, so Edit Data in ${r.kind === 'pptx' ? 'PowerPoint, Keynote and Google Slides' : 'Word'} opens ${total === 1 ? 'its' : 'their'} numbers.${r.more ? ` (${r.more} past the first ${CHART_DATA_MAX} were not read.)` : ''}`
  const list = bad.slice(0, 10).map((c) => `${c.where}${c.title ? ` "${c.title}"` : ''}: ${WHY[c.state as Exclude<ChartDataState, 'ok'>]}${c.detail ? ` (${c.detail})` : ''}`).join('; ')
  const fix = r.kind === 'pptx'
    ? 'Build each chart with addChart (pptxgenjs) or add_chart (python-pptx), which write the data sheet (ppt/embeddings/*.xlsx); never delete ppt/embeddings or <c:externalData> to get a file saved'
    : 'Build each chart so it keeps its data sheet (word/embeddings/*.xlsx linked by <c:externalData>); never delete it to get a file saved'
  return ` Read back: ${n(bad.length, 'chart')} of ${total} cannot be edited in ${app} (right-click > Edit Data finds no numbers): ${list}${bad.length > 10 ? `; and ${bad.length - 10} more` : ''}. ${fix}, then save again; if you cannot, say plainly in your answer that these charts cannot be edited.`
}

/** The office worker's mode: the .pptx or .docx in, the review as JSON out. */
export function chartDataRequest(input: Uint8Array): Uint8Array {
  try { return new TextEncoder().encode(JSON.stringify(chartDataReview(input))) } catch (e) {
    if (e instanceof ToolError) throw e
    throw new ToolError(`could not read the charts of this file (${String((e as Error).message).slice(0, 120)})`)
  }
}
