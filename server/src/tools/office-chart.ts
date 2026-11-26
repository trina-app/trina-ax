// Native charts in the Word and PowerPoint files make_file writes from Markdown (tools/make-file.ts; plan
// docs/AGENTS/plan/20261125-1346-word-native-charts.md). Live QA 2026-11-25: a Korean request for a Word report with a
// chart got a PNG of a chart, which nobody can edit; pandoc writes no charts. A fenced block
//
//   ```chart
//   {"type": "column", "title": "Sales", "categories": ["Q1", "Q2"], "series": [{"name": "2026", "values": [12, 15]}]}
//   ```
//
// becomes a marker paragraph in pandoc's tree (chartBlocks), and after pandoc wrote the file each marker paragraph is
// replaced by a native chart (insertDocxCharts, insertPptxCharts): the chart part (word/charts/chartN.xml,
// ppt/charts/chartN.xml, written by xlsx-chart.ts chartXml over the cells of its own workbook), that workbook
// (word/embeddings/, ppt/embeddings/, linked by <c:externalData> and a `package` relationship, so Edit Data in Word,
// PowerPoint, Keynote and Google Slides opens the numbers), the relationships and the content types. The file then
// passes the same exit check as every made file (files/office-links-check.ts allows exactly this workbook, #573).
import crypto from 'node:crypto'
import * as XLSX from 'xlsx'
import { MAKE_FILE_CHARTS_MAX } from '@mycel/shared'
import { ToolError } from '../policy/errors'
import { readZip, writeZip, type ZipEntry } from '../files/zip-write'
import { CHART_TYPES, chartXml, esc, type ChartSheet, type ChartType } from './xlsx-chart'

/** a chart block's language: ```chart */
export const CHART_BLOCK_CLASS = 'chart'
const CATEGORIES_MAX = 1000
const SERIES_MAX = 50
const NAME_MAX = 200

export interface DocChart {
  type: ChartType
  title?: string
  categories: (string | number)[]
  series: { name: string; values: (number | null)[] }[]
}

/** The chart of one ```chart block; ToolError naming what is wrong (nothing is saved then). */
export function parseChartBlock(text: string, what: string): DocChart {
  let v: unknown
  try { v = JSON.parse(text) } catch (e) {
    throw new ToolError(`${what}: a chart block holds one JSON object, e.g. {"type":"column","title":"Sales","categories":["Q1","Q2"],"series":[{"name":"2026","values":[12,15]}]} (${String((e as Error).message).slice(0, 80)}); nothing was saved`)
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new ToolError(`${what}: a chart block holds one JSON object with type, categories and series; nothing was saved`)
  const o = v as Record<string, unknown>
  const unknown = Object.keys(o).filter((k) => !['type', 'title', 'categories', 'series'].includes(k))
  if (unknown.length) throw new ToolError(`${what}: unknown field${unknown.length === 1 ? '' : 's'} ${unknown.slice(0, 5).join(', ')} (a chart block takes type, title, categories and series); nothing was saved`)
  const type = o.type ?? 'column'
  if (typeof type !== 'string' || !(CHART_TYPES as readonly string[]).includes(type)) throw new ToolError(`${what}: type must be one of ${CHART_TYPES.join(', ')} (column = vertical bars, bar = horizontal bars); nothing was saved`)
  if (o.title !== undefined && (typeof o.title !== 'string' || o.title.length > NAME_MAX)) throw new ToolError(`${what}: title must be text of at most ${NAME_MAX} characters; nothing was saved`)
  const cats = o.categories
  if (!Array.isArray(cats) || !cats.length || cats.length > CATEGORIES_MAX || !cats.every((c) => (typeof c === 'string' && c.length <= NAME_MAX) || (typeof c === 'number' && Number.isFinite(c)))) {
    throw new ToolError(`${what}: categories must be a list of 1 to ${CATEGORIES_MAX} labels (text or numbers), e.g. ["Q1","Q2","Q3"]; nothing was saved`)
  }
  const series = o.series
  if (!Array.isArray(series) || !series.length || series.length > SERIES_MAX) throw new ToolError(`${what}: series must be a list of 1 to ${SERIES_MAX} series, each {"name":"2026","values":[12,15]}; nothing was saved`)
  if (type === 'pie' && series.length !== 1) throw new ToolError(`${what}: a pie chart takes one series; nothing was saved`)
  const out = series.map((s, i) => {
    const so = s as Record<string, unknown> | null
    if (!so || typeof so !== 'object' || Array.isArray(so)) throw new ToolError(`${what}: series ${i + 1} must be {"name":"...","values":[...]}; nothing was saved`)
    const name = so.name ?? ''
    if (typeof name !== 'string' || name.length > NAME_MAX) throw new ToolError(`${what}: series ${i + 1}: name must be text of at most ${NAME_MAX} characters; nothing was saved`)
    const values = so.values
    if (!Array.isArray(values) || values.length !== cats.length) throw new ToolError(`${what}: series ${i + 1} needs one value per category (${cats.length}), got ${Array.isArray(values) ? values.length : 'none'}; nothing was saved`)
    if (!values.every((x) => x === null || (typeof x === 'number' && Number.isFinite(x)))) throw new ToolError(`${what}: series ${i + 1}: values must be plain numbers (no currency signs, % or units; null for a gap); nothing was saved`)
    if (!values.some((x) => typeof x === 'number')) throw new ToolError(`${what}: series ${i + 1} has no numbers; nothing was saved`)
    return { name, values: values as (number | null)[] }
  })
  return { type: type as ChartType, ...(typeof o.title === 'string' && o.title.trim() ? { title: o.title } : {}), categories: cats as (string | number)[], series: out }
}

type Block = { t?: unknown; c?: unknown }

/**
 * Every ```chart block of a pandoc tree, replaced in place by a paragraph holding only a marker (a word no document
 * holds); returns the charts by marker, in document order. ToolError when a block is wrong or there are too many.
 */
export function chartBlocks(ast: unknown, format: 'docx' | 'pptx' | 'pdf' = 'docx'): Map<string, DocChart> {
  const nonce = crypto.randomBytes(6).toString('hex')
  const charts = new Map<string, DocChart>()
  /** a place a chart cannot stand: pandoc writes a footnote, speaker notes (::: notes) and a slide's table outside the
   * body paragraphs a chart replaces */
  const placeOf = (b: Block): string | null => {
    if (b.t === 'Note') return 'a footnote'
    if (b.t === 'Div' && Array.isArray(b.c) && Array.isArray((b.c[0] as unknown[])?.[1]) && ((b.c[0] as unknown[])[1] as unknown[]).includes('notes')) return 'speaker notes (::: notes)'
    if (b.t === 'Table' && format === 'pptx') return 'a table'
    return null
  }
  // document order: the tree is walked depth first, children in order
  const visit = (x: unknown, inside: string | null): void => {
    if (Array.isArray(x)) {
      for (let i = 0; i < x.length; i++) {
        const b = x[i] as Block
        if (b && typeof b === 'object' && b.t === 'CodeBlock' && Array.isArray(b.c)) {
          const [attr, text] = b.c as [[string, string[], unknown], string]
          if (Array.isArray(attr?.[1]) && attr[1].includes(CHART_BLOCK_CLASS) && typeof text === 'string') {
            if (inside) throw new ToolError(`chart ${charts.size + 1}: a chart block cannot stand in ${inside}; put it in the ${format === 'pptx' ? 'slide itself, alone under its ## heading' : 'document body, on its own lines'}; nothing was saved`)
            if (charts.size >= MAKE_FILE_CHARTS_MAX) throw new ToolError(`at most ${MAKE_FILE_CHARTS_MAX} charts per file; nothing was saved`)
            const marker = `MYCELCHART${nonce}N${charts.size + 1}`
            charts.set(marker, parseChartBlock(text, `chart ${charts.size + 1}`))
            x[i] = { t: 'Para', c: [{ t: 'Str', c: marker }] }
            continue
          }
        }
        visit(b, inside)
      }
      return
    }
    if (x && typeof x === 'object') {
      const here = inside ?? placeOf(x as Block)
      for (const v of Object.values(x)) if (v && typeof v === 'object') visit(v, here)
    }
  }
  visit(ast, null)
  return charts
}

/** The chart's own data sheet as make_file's Excel charts read it: A1 empty, series names in row 1, labels in column A. */
function sheetOf(c: DocChart): ChartSheet {
  return { name: 'Sheet1', rows: [['', ...c.series.map((s) => s.name)], ...c.categories.map((cat, r) => [cat, ...c.series.map((s) => s.values[r] ?? null)])] }
}

/** The chart's data workbook (Edit Data opens it). */
export function chartWorkbook(c: DocChart): Uint8Array {
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sheetOf(c).rows.map((r) => r.map((v) => (v === null ? undefined : v)))), 'Sheet1')
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx', compression: true }) as ArrayBuffer)
}

/** chartN.xml: the chart over its own workbook's cells, with the values cached, and <c:externalData> naming the
 * workbook's relationship (rId1 of the chart's .rels). */
export function docChartXml(c: DocChart): string {
  const sheet = sheetOf(c)
  const xml = chartXml({ spec: { type: c.type, range: '', ...(c.title ? { title: c.title } : {}) }, sheet: 0, area: { c1: 1, r1: 1, c2: 1 + c.series.length, r2: 1 + c.categories.length }, from: { col: 1, row: 1 } }, sheet)
  // CT_ChartSpace: externalData comes after c:chart (and spPr / txPr, which this chart has none of)
  return xml.replace('</c:chartSpace>', '<c:externalData r:id="rId1"><c:autoUpdate val="0"/></c:externalData></c:chartSpace>')
}

const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const RELS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'
const CHART_CT = 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml'
const XLSX_CT = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const CHART_URI = 'http://schemas.openxmlformats.org/drawingml/2006/chart'

/** The zip of a written .docx / .pptx, with helpers to read and change its parts. */
function pkg(bytes: Uint8Array) {
  const entries: ZipEntry[] = readZip(bytes)
  const td = new TextDecoder(), te = new TextEncoder()
  const get = (name: string) => entries.find((e) => e.name === name)
  const text = (name: string) => { const e = get(name); return e ? td.decode(e.data) : null }
  const put = (name: string, data: string | Uint8Array) => {
    const d = typeof data === 'string' ? te.encode(data) : data
    const e = get(name)
    if (e) { e.data = d; delete e.raw; delete e.store } else entries.push({ name, data: d })
  }
  const free = (dir: string, base: string, x: string) => { let n = 1; while (get(`${dir}/${base}${n}.${x}`)) n++; return n }
  let types = text('[Content_Types].xml')
  if (!types) throw new Error('office file without content types')
  return {
    get, text, put, free,
    /** adds one chart (its part, its workbook, the chart's .rels and content types) under `top` (word, ppt); returns its part name */
    addChart(top: string, c: DocChart): string {
      const n = free(`${top}/charts`, 'chart', 'xml')
      let w = 1
      while (get(`${top}/embeddings/Microsoft_Excel_Worksheet${w}.xlsx`)) w++
      put(`${top}/charts/chart${n}.xml`, docChartXml(c))
      put(`${top}/embeddings/Microsoft_Excel_Worksheet${w}.xlsx`, chartWorkbook(c))
      put(`${top}/charts/_rels/chart${n}.xml.rels`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${RELS_NS}"><Relationship Id="rId1" Type="${REL}/package" Target="../embeddings/Microsoft_Excel_Worksheet${w}.xlsx"/></Relationships>`)
      types = types!.replace('</Types>', `<Override PartName="/${top}/charts/chart${n}.xml" ContentType="${CHART_CT}"/></Types>`)
      if (!/<Default\b[^>]*\bExtension="xlsx"/i.test(types)) types = types.replace(/(<Types\b[^>]*>)/, `$1<Default Extension="xlsx" ContentType="${XLSX_CT}"/>`)
      return `chart${n}.xml`
    },
    /** adds a relationship to a part's .rels; returns its Id */
    relate(part: string, type: string, target: string): string {
      const dir = part.slice(0, part.lastIndexOf('/')), file = part.slice(part.lastIndexOf('/') + 1)
      const relsName = `${dir}/_rels/${file}.rels`
      const old = text(relsName) ?? `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${RELS_NS}"></Relationships>`
      let i = 1
      while (old.includes(`Id="rIdChart${i}"`)) i++
      put(relsName, old.replace('</Relationships>', `<Relationship Id="rIdChart${i}" Type="${REL}/${type}" Target="${target}"/></Relationships>`))
      return `rIdChart${i}`
    },
    finish(): Uint8Array { put('[Content_Types].xml', types!); return writeZip(entries) },
  }
}

/** the text of one element's runs (<w:t>, <a:t>), tags removed */
const textOf = (xml: string, tag: 'w:t' | 'a:t') => [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`, 'g'))].map((m) => m[1]).join('')

/** The element `<tag ...>...</tag>` around position `at` (no nesting of the same tag inside, as pandoc writes them). */
function around(xml: string, at: number, tag: string): { start: number; end: number } | null {
  const open = new RegExp(`<${tag}(?=[\\s>])`, 'g')
  let start = -1
  for (const m of xml.slice(0, at).matchAll(open)) start = m.index!
  const close = xml.indexOf(`</${tag}>`, at)
  return start < 0 || close < 0 ? null : { start, end: close + tag.length + 3 }
}

/** a marker pandoc did not write where a chart can go (a header, a caption, metadata): the AI's to fix, not a bug */
const missing = (_marker: string) => new ToolError('a chart block must stand in the document body (in PowerPoint: alone on a slide under its ## heading), not in a footnote, header, caption, table of a slide or speaker notes; nothing was saved')

/** Word: each marker paragraph becomes a paragraph holding the chart, inline and centred, 16 x 9.5 cm. */
export function insertDocxCharts(bytes: Uint8Array, charts: Map<string, DocChart>): Uint8Array {
  if (!charts.size) return bytes
  const p = pkg(bytes)
  const docPart = 'word/document.xml'
  const written = p.text(docPart)
  if (!written) throw new Error('docx without word/document.xml')
  let doc: string = written
  let id = Math.max(0, ...[...doc.matchAll(/<wp:docPr\b[^>]*\sid="(\d+)"/g)].map((m) => Number(m[1]))) + 1
  for (const [marker, c] of charts) {
    const at: number = doc.indexOf(marker)
    const para: { start: number; end: number } | null = at < 0 ? null : around(doc, at, 'w:p')
    if (!para) throw missing(marker)
    // a marker inside other text (a block inside a list item keeps its own paragraph, so this is only a guard)
    if (textOf(doc.slice(para.start, para.end), 'w:t').trim() !== marker) throw new ToolError('a chart block must stand on its own, with an empty line before and after it; nothing was saved')
    const part = p.addChart('word', c)
    const rid = p.relate(docPart, 'chart', `charts/${part}`)
    const cx = 5760000, cy = 3420000
    const name = esc((c.title ?? 'Chart').slice(0, 80))
    const drawing = `<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>` +
      `<wp:docPr id="${id}" name="Chart ${id}" descr="${name}"/><wp:cNvGraphicFramePr/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="${CHART_URI}">` +
      `<c:chart xmlns:c="${CHART_URI}" xmlns:r="${REL}" r:id="${rid}"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`
    id++
    doc = doc.slice(0, para.start) + drawing + doc.slice(para.end)
  }
  if (!/<w:document\b[^>]*\sxmlns:wp=/.test(doc)) doc = doc.replace(/<w:document\b/, '<w:document xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"')
  p.put(docPart, doc)
  return p.finish()
}

interface Box { x: number; y: number; cx: number; cy: number }
const xfrmOf = (xml: string): Box | null => {
  const m = /<a:off\s+x="(-?\d+)"\s+y="(-?\d+)"\s*\/>\s*<a:ext\s+cx="(\d+)"\s+cy="(\d+)"\s*\/>/.exec(xml)
  return m ? { x: Number(m[1]), y: Number(m[2]), cx: Number(m[3]), cy: Number(m[4]) } : null
}

/** PowerPoint: each marker, alone in its slide's content placeholder, becomes a chart in that placeholder's area. */
export function insertPptxCharts(bytes: Uint8Array, charts: Map<string, DocChart>): Uint8Array {
  if (!charts.size) return bytes
  const p = pkg(bytes)
  const slides = p.free('ppt/slides', 'slide', 'xml') - 1
  const size = /<p:sldSz\b[^>]*\scx="(\d+)"[^>]*\scy="(\d+)"/.exec(p.text('ppt/presentation.xml') ?? '')
  const W = Number(size?.[1] ?? 9144000), H = Number(size?.[2] ?? 5143500)
  const relTarget = (part: string, type: string): string | null => {
    const dir = part.slice(0, part.lastIndexOf('/')), file = part.slice(part.lastIndexOf('/') + 1)
    const rels = p.text(`${dir}/_rels/${file}.rels`) ?? ''
    for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
      if (!new RegExp(`Type="[^"]*/${type}"`).test(m[0])) continue
      const t = /Target="([^"]+)"/.exec(m[0])?.[1]
      if (t) return t.startsWith('/') ? t.slice(1) : `${dir}/${t}`.split('/').reduce<string[]>((a, s) => (s === '..' ? a.slice(0, -1) : s === '.' ? a : [...a, s]), []).join('/')
    }
    return null
  }
  /** the area of the placeholder `ph` (its <p:ph .../> tag) in a layout or master */
  const placeholderBox = (part: string | null, ph: string): Box | null => {
    const xml = part ? p.text(part) : null
    if (!xml) return null
    const idx = /\sidx="(\d+)"/.exec(ph)?.[1], type = /\stype="(\w+)"/.exec(ph)?.[1]
    for (const m of xml.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)) {
      const tag = /<p:ph\b[^>]*\/?>/.exec(m[0])?.[0]
      if (!tag) continue
      const tIdx = /\sidx="(\d+)"/.exec(tag)?.[1], tType = /\stype="(\w+)"/.exec(tag)?.[1]
      if ((idx !== undefined && tIdx === idx) || (type !== undefined && tType === type) || (idx !== undefined && !type && tType === 'body')) {
        const b = xfrmOf(m[0])
        if (b) return b
      }
    }
    return null
  }
  for (const [marker, c] of charts) {
    let done = false
    for (let s = 1; s <= slides && !done; s++) {
      const part = `ppt/slides/slide${s}.xml`
      let xml = p.text(part)
      const at = xml?.indexOf(marker) ?? -1
      if (!xml || at < 0) continue
      const sp = around(xml, at, 'p:sp')
      if (!sp) throw missing(marker)
      const shape = xml.slice(sp.start, sp.end)
      if (textOf(shape, 'a:t').trim() !== marker) {
        throw new ToolError('in PowerPoint a chart block goes on a slide of its own: a ## heading, then only the chart block (put the slide\'s other text on the slide before or after it); nothing was saved')
      }
      const ph = /<p:ph\b[^>]*\/?>/.exec(shape)?.[0]
      const layout = relTarget(part, 'slideLayout')
      const box = xfrmOf(shape) ?? (ph ? placeholderBox(layout, ph) ?? placeholderBox(layout ? relTarget(layout, 'slideMaster') : null, ph) : null) ??
        { x: Math.round(W * 0.05), y: Math.round(H * 0.22), cx: Math.round(W * 0.9), cy: Math.round(H * 0.7) }
      const cNvPr = /<p:cNvPr\b[^>]*\sid="(\d+)"/.exec(shape)?.[1] ?? '1000'
      const chartPart = p.addChart('ppt', c)
      const rid = p.relate(part, 'chart', `../charts/${chartPart}`)
      const name = esc((c.title ?? 'Chart').slice(0, 80))
      const frame = `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${cNvPr}" name="Chart ${cNvPr}" descr="${name}"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>` +
        `<p:xfrm><a:off x="${box.x}" y="${box.y}"/><a:ext cx="${box.cx}" cy="${box.cy}"/></p:xfrm><a:graphic><a:graphicData uri="${CHART_URI}">` +
        `<c:chart xmlns:c="${CHART_URI}" xmlns:r="${REL}" r:id="${rid}"/></a:graphicData></a:graphic></p:graphicFrame>`
      xml = xml.slice(0, sp.start) + frame + xml.slice(sp.end)
      p.put(part, xml)
      done = true
    }
    if (!done) throw missing(marker)
  }
  return p.finish()
}
