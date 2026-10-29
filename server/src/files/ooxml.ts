// Parts of .docx and .pptx files that pandoc's plain text drops: Word headers, footers and comments, PowerPoint
// speaker notes and chart data (series names, categories, values). extract.ts adds this text after pandoc's body
// text. The parsing expands untrusted zip and XML input, so it runs only in the office worker
// (files/office-worker.ts), never in the server process. The zip is checked first (zip-guard.ts) and the text is
// capped. Each section has a fixed label, so the AI can tell where the text came from. The text is document content,
// not instructions (chat/prompt.ts).
import * as XLSX from 'xlsx'
import { ToolError } from '../policy/errors'
import { checkZip, isZip } from './zip-guard'

/** characters of extra text out of one file */
const EXTRA_TEXT_MAX = 4 * 1024 * 1024
/** characters of the body text that a comment refers to */
const ANCHOR_MAX = 200
/** Chart points with an index at or above this are skipped (the index is untrusted and sizes an array). */
const POINT_IDX_MAX = 10_000

/** The start of each section label; a line of the file's own text that starts like this is marked (see `quoteLine`). */
export const SECTION_MARK = '=== '

type Parts = Map<string, Uint8Array>

function parts(bytes: Uint8Array, what: string): Parts {
  if (!isZip(bytes)) throw new ToolError(`could not read the extra parts of this ${what} (not a zip container)`)
  checkZip(bytes)
  let c: { FullPaths: string[]; FileIndex: { content?: Uint8Array | number[] }[] }
  try { c = XLSX.CFB.read(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), { type: 'buffer' }) } catch { throw new ToolError(`could not read the extra parts of this ${what} (damaged file)`) }
  const out: Parts = new Map()
  c.FullPaths.forEach((p, i) => {
    const v = c.FileIndex[i]?.content
    if (v && v.length) out.set(p.replace(/^Root Entry\//, ''), v instanceof Uint8Array ? v : Uint8Array.from(v))
  })
  return out
}

const xmlOf = (p: Parts, name: string): string | null => {
  const b = p.get(name)
  return b ? new TextDecoder('utf-8').decode(b) : null
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
const unescapeXml = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
  e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENTITIES[e] ?? m))
const attr = (tag: string, name: string) => {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag)
  return m ? unescapeXml(m[1]!) : undefined
}

/**
 * Paragraph text of WordprocessingML or DrawingML: paragraphs are <w:p> / <a:p>, text runs <w:t> / <a:t>, with tabs and
 * line breaks. Deleted text (<w:delText>) and field codes (<w:instrText>) are not text runs, so they are left out.
 */
function paragraphs(xml: string, ns: 'w' | 'a'): string[] {
  const out: string[] = []
  const open: number[] = [] // line index of each open paragraph (a text box paragraph nests in a body paragraph)
  let inText = false
  let last = 0
  const re = new RegExp(`<(/?)${ns}:(p|t|tab|br|cr)\\b[^>]*?(/?)>`, 'g')
  for (const m of xml.matchAll(re)) {
    const [tag, close, name, selfClose] = m as unknown as [string, string, string, string]
    if (inText && open.length) out[open.at(-1)!] += unescapeXml(xml.slice(last, m.index).replace(/<[^>]+>/g, ''))
    last = m.index! + tag.length
    if (name === 'p') {
      if (close) open.pop()
      else if (!selfClose) { open.push(out.length); out.push('') }
    } else if (name === 't') inText = !close && !selfClose
    else if (open.length && !close) out[open.at(-1)!] += name === 'tab' ? '\t' : '\n'
  }
  return out
}

const tidy = (lines: string[]) => lines.map((l) => l.replace(/[ \t]+$/g, '')).join('\n').replace(/\n{3,}/g, '\n\n').trim()

/** A line of the file's own text that starts like a section label gets a space in front, so it cannot end a section. */
const quoteLine = (text: string) => text.split('\n').map((l) => (l.startsWith(SECTION_MARK) ? ' ' + l : l)).join('\n')
/** Attribute text (author, date, chart title, series name, category) on one line: line breaks become spaces. */
const oneLine = (text: string) => text.replace(/\r\n|[\n\r\v\f\u0085\u2028\u2029]/g, ' ')
const indent = (text: string, pad = '  ') => quoteLine(text).split('\n').map((l) => (l ? pad + l : l)).join('\n')

const num = (p: string) => Number(/(\d+)\.xml$/.exec(p)?.[1] ?? 0)
const byNumber = (a: string, b: string) => num(a) - num(b)

/** Relationships of a part: id -> target path inside the zip (relative targets resolved against the part's folder). */
function rels(p: Parts, part: string): Map<string, { type: string; target: string }> {
  const dir = part.slice(0, part.lastIndexOf('/') + 1)
  const xml = xmlOf(p, `${dir}_rels/${part.slice(dir.length)}.rels`)
  const out = new Map<string, { type: string; target: string }>()
  if (!xml) return out
  for (const m of xml.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(m[0], 'Id'), type = attr(m[0], 'Type') ?? '', target = attr(m[0], 'Target')
    if (!id || !target || attr(m[0], 'TargetMode') === 'External') continue
    out.set(id, { type, target: resolve(dir, target) })
  }
  return out
}

function resolve(dir: string, target: string): string {
  const segs = (target.startsWith('/') ? target.slice(1) : dir + target).split('/')
  const out: string[] = []
  for (const s of segs) {
    if (s === '..') out.pop()
    else if (s && s !== '.') out.push(s)
  }
  return out.join('/')
}

function capped(sections: string[]): string {
  let text = sections.filter(Boolean).join('\n\n')
  if (text.length > EXTRA_TEXT_MAX) text = text.slice(0, EXTRA_TEXT_MAX) + '\n… (the rest of the extra text is cut)'
  return text
}

// ---------------- .docx ----------------

/** Text of the comment ranges in the body: comment id -> the commented text (shortened). */
function commentAnchors(doc: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of doc.matchAll(/<w:commentRangeStart\b[^>]*>/g)) {
    const id = attr(m[0], 'w:id')
    if (id === undefined) continue
    const end = doc.indexOf(`<w:commentRangeEnd w:id="${id}"`, m.index)
    if (end < 0) continue
    let text = ''
    for (const t of doc.slice(m.index! + m[0].length, end).matchAll(/<w:t\b[^>]*>([^<]*)<\/w:t>/g)) {
      text += unescapeXml(t[1]!)
      if (text.length > ANCHOR_MAX) break
    }
    text = text.replace(/\s+/g, ' ').trim()
    if (text) out.set(id, text.length > ANCHOR_MAX ? text.slice(0, ANCHOR_MAX) + '…' : text)
  }
  return out
}

/** Headers, footers and comments of a .docx ('' when it has none). */
export function docxExtraText(bytes: Uint8Array): string {
  const p = parts(bytes, 'Word document')
  const sections: string[] = []
  for (const kind of ['header', 'footer'] as const) {
    const seen = new Set<string>()
    const lines: string[] = []
    for (const name of [...p.keys()].filter((n) => new RegExp(`^word/${kind}\\d*\\.xml$`).test(n)).sort(byNumber)) {
      const text = tidy(paragraphs(xmlOf(p, name)!, 'w'))
      if (!text || seen.has(text)) continue
      seen.add(text)
      lines.push(indent(text))
    }
    if (lines.length) sections.push(`${SECTION_MARK}Word ${kind}s (page ${kind} text, not part of the body above) ===\n${lines.join('\n\n')}`)
  }
  const comments = xmlOf(p, 'word/comments.xml')
  if (comments) {
    const anchors = commentAnchors(xmlOf(p, 'word/document.xml') ?? '')
    const lines: string[] = []
    for (const m of comments.matchAll(/<w:comment\b([^>]*)>([\s\S]*?)<\/w:comment>/g)) {
      const head = m[1]!, id = attr(head, 'w:id') ?? ''
      const text = tidy(paragraphs(m[2]!, 'w'))
      if (!text) continue
      const who = [attr(head, 'w:author'), attr(head, 'w:date')?.slice(0, 10)].filter(Boolean).map((v) => oneLine(v!)).join(', ')
      const on = anchors.get(id)
      lines.push(quoteLine(`- Comment${who ? ` by ${who}` : ''}${on ? ` on "${oneLine(on)}"` : ''}:`) + `\n${indent(text, '    ')}`)
    }
    if (lines.length) sections.push(`${SECTION_MARK}Word comments (review notes in the margin) ===\n${lines.join('\n')}`)
  }
  return capped(sections)
}

// ---------------- .pptx ----------------

/** Text of the notes body placeholder of a notes slide (not the slide image or the slide number). */
function notesText(xml: string): string {
  const shapes = [...xml.matchAll(/<p:sp\b[^>]*>([\s\S]*?)<\/p:sp>/g)].map((m) => m[1]!)
  const body = shapes.filter((s) => /<p:ph\b[^>]*type="body"/.test(s))
  const use = body.length ? body : shapes.filter((s) => !/<p:ph\b[^>]*type="(sldNum|sldImg|hdr|ftr|dt)"/.test(s))
  return tidy(use.flatMap((s) => paragraphs(s, 'a')))
}

/**
 * Cached values of a chart reference (<c:pt idx="n"><c:v>…</c:v></c:pt>), by index, on one line each. A point with an
 * index at or past the declared <c:ptCount>, or at POINT_IDX_MAX and more, is skipped: the index sizes the array.
 */
function points(xml: string | undefined): string[] {
  const out: string[] = []
  if (!xml) return out
  const count = /<c:ptCount\b[^>]*\sval="(\d+)"/.exec(xml)
  const max = Math.min(POINT_IDX_MAX, count ? Number(count[1]) : POINT_IDX_MAX)
  for (const m of xml.matchAll(/<c:pt\b[^>]*idx="(\d+)"[^>]*>[\s\S]*?<c:v>([^<]*)<\/c:v>[\s\S]*?<\/c:pt>/g)) {
    const i = Number(m[1])
    if (i < max) out[i] = oneLine(unescapeXml(m[2]!))
  }
  return out
}
const inner = (xml: string, tag: string, ns = 'c') => new RegExp(`<${ns}:${tag}\\b[^>]*>([\\s\\S]*?)</${ns}:${tag}>`).exec(xml)?.[1]

/** A chart part as text: title, kind and every series with its categories and cached values. */
function chartText(xml: string): string {
  // the chart's own title comes before the plot area (an axis title is inside it)
  const titleXml = inner(xml.split('<c:plotArea')[0]!, 'title')
  const title = titleXml ? oneLine(tidy(paragraphs(titleXml, 'a'))) || points(titleXml)[0] || '' : ''
  const plot = inner(xml, 'plotArea') ?? xml
  const kinds = [...new Set([...plot.matchAll(/<c:(\w+)Chart\b/g)].map((m) => m[1]!))]
  const lines: string[] = []
  for (const m of plot.matchAll(/<c:ser\b[^>]*>([\s\S]*?)<\/c:ser>/g)) {
    const ser = m[1]!
    const tx = inner(ser, 'tx')
    const name = tx ? (points(tx)[0] ?? unescapeXml(/<c:v>([^<]*)<\/c:v>/.exec(tx)?.[1] ?? '')) : ''
    const cats = points(inner(ser, 'cat') ?? inner(ser, 'xVal'))
    const vals = points(inner(ser, 'val') ?? inner(ser, 'yVal'))
    const n = Math.max(cats.length, vals.length)
    const pairs: string[] = []
    for (let i = 0; i < n; i++) if (vals[i] !== undefined) pairs.push(cats[i] !== undefined ? `${cats[i]} = ${vals[i]}` : vals[i]!)
    lines.push(`  - series "${oneLine(name)}": ${pairs.length ? pairs.join('; ') : '(no stored values)'}`)
  }
  const head = `- Chart${title ? ` "${title}"` : ''}${kinds.length ? ` (${kinds.join(', ')} chart)` : ''}:`
  return quoteLine([head, ...(lines.length ? lines : ['  (no series)'])].join('\n'))
}

/** Slides in show order: presentation.xml's slide list, else the slide parts by number. */
function slideOrder(p: Parts): string[] {
  const pres = xmlOf(p, 'ppt/presentation.xml')
  const r = rels(p, 'ppt/presentation.xml')
  const listed = pres ? [...(inner(pres, 'sldIdLst', 'p') ?? '').matchAll(/<p:sldId\b[^>]*>/g)]
    .map((m) => r.get(attr(m[0], 'r:id') ?? '')?.target).filter((t): t is string => !!t && p.has(t)) : []
  return listed.length ? listed : [...p.keys()].filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort(byNumber)
}

/** Speaker notes and chart data of a .pptx, by slide ('' when it has none). */
export function pptxExtraText(bytes: Uint8Array): string {
  const p = parts(bytes, 'presentation')
  const slides: string[] = []
  slideOrder(p).forEach((slide, i) => {
    const r = rels(p, slide)
    const xml = xmlOf(p, slide) ?? ''
    const out: string[] = []
    for (const { type, target } of r.values()) {
      if (!type.endsWith('/notesSlide')) continue
      const notes = notesText(xmlOf(p, target) ?? '')
      if (notes) out.push(`Speaker notes:\n${indent(notes)}`)
    }
    // charts in the order they are placed on the slide
    const charts = [...r.entries()].filter(([, v]) => v.type.endsWith('/chart'))
      .sort(([a], [b]) => (xml.indexOf(`r:id="${a}"`) >>> 0) - (xml.indexOf(`r:id="${b}"`) >>> 0))
    for (const [, { target }] of charts) {
      const c = xmlOf(p, target)
      if (c) out.push(chartText(c))
    }
    if (out.length) slides.push(`${SECTION_MARK}Slide ${i + 1} ===\n${out.join('\n')}`)
  })
  if (!slides.length) return ''
  return capped([`${SECTION_MARK}PowerPoint speaker notes and chart data, by slide (not part of the slide text above) ===`, ...slides])
}
