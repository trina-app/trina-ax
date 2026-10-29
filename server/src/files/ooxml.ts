// Parts of .docx and .pptx files that pandoc's plain text drops: Word headers, footers and comments, PowerPoint
// speaker notes and chart data (series names, categories, values). extract.ts adds this text after pandoc's body
// text. The parsing expands untrusted zip and XML input, so it runs only in the office worker
// (files/office-worker.ts), never in the server process. The zip is checked first (zip-guard.ts) and the text is
// capped. Each section has a fixed label, so the AI can tell where the text came from. The text is document content,
// not instructions (chat/prompt.ts).
// The XML is untrusted, so every scan is linear in the size of the part: tags are found with indexOf from the current
// position, and a scan stops at the first tag or element that is not closed. No regex here can backtrack over a part
// (a lazy `[\s\S]*?` regex took 22 s for a 1.2 MB chart part with unclosed <c:pt> tags, QA review).
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
/** An attribute of a tag's attribute text (`head`). */
const attr = (head: string, name: string) => {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(head)
  return m ? unescapeXml(m[1]!) : undefined
}

// ---------------- linear XML scanning ----------------

type Tag = { name: string; close: boolean; selfClose: boolean; head: string; start: number; end: number }

/** The character after a tag name: white space, '>' or '/'. */
const nameEnds = (c: number) => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x3e || c === 0x2f

/** The tag that starts at `s` and ends at the '>' at `gt`. */
function tagAt(xml: string, s: number, gt: number): Tag {
  const close = xml.charCodeAt(s + 1) === 0x2f
  let i = s + (close ? 2 : 1)
  const n0 = i
  while (i < gt && !nameEnds(xml.charCodeAt(i))) i++
  const selfClose = !close && xml.charCodeAt(gt - 1) === 0x2f && gt - 1 >= i
  return { name: xml.slice(n0, i), close, selfClose, head: xml.slice(i, selfClose ? gt - 1 : gt), start: s, end: gt + 1 }
}

/**
 * Every tag of the XML in document order. The scan stops at the first '<' that has no '>' after it. A '<' in the text
 * before a tag (not valid XML) is skipped: the tag starts at the last '<' before its '>'.
 */
function* tags(xml: string): Generator<Tag> {
  let pos = 0
  for (;;) {
    let s = xml.indexOf('<', pos)
    if (s < 0) return
    const gt = xml.indexOf('>', s + 1)
    if (gt < 0) return
    s = xml.lastIndexOf('<', gt)
    yield tagAt(xml, s, gt)
    pos = gt + 1
  }
}

/** The next start tag `<name …>` or `<name …/>` at or after `from` (not `<nameMore`), or null. */
function startTag(xml: string, name: string, from: number): Tag | null {
  const pat = '<' + name
  for (let s = xml.indexOf(pat, from); s >= 0; s = xml.indexOf(pat, s + pat.length)) {
    if (!nameEnds(xml.charCodeAt(s + pat.length))) continue
    const gt = xml.indexOf('>', s + pat.length)
    return gt < 0 ? null : tagAt(xml, s, gt)
  }
  return null
}

/**
 * The elements `<name …>inner</name>` in order (`<name/>` gives an empty inner), at most `max`. The first end tag closes
 * the element (the same name is not nested in the parts read here). The scan stops at the first element without its
 * end tag, so the time is linear in the size of the XML.
 */
function elements(xml: string, name: string, max = Infinity): { head: string; inner: string }[] {
  const out: { head: string; inner: string }[] = []
  const endTag = `</${name}>`
  let pos = 0
  while (out.length < max) {
    const t = startTag(xml, name, pos)
    if (!t) break
    if (t.selfClose) { out.push({ head: t.head, inner: '' }); pos = t.end; continue }
    const e = xml.indexOf(endTag, t.end)
    if (e < 0) break
    out.push({ head: t.head, inner: xml.slice(t.end, e) })
    pos = e + endTag.length
  }
  return out
}
const inner = (xml: string, name: string) => elements(xml, name, 1)[0]?.inner

/**
 * Paragraph text of WordprocessingML or DrawingML: paragraphs are <w:p> / <a:p>, text runs <w:t> / <a:t>, with tabs and
 * line breaks. Deleted text (<w:delText>) and field codes (<w:instrText>) are not text runs, so they are left out.
 */
function paragraphs(xml: string, ns: 'w' | 'a'): string[] {
  const out: string[] = []
  const open: number[] = [] // line index of each open paragraph (a text box paragraph nests in a body paragraph)
  let inText = false
  let last = 0
  const P = `${ns}:p`, T = `${ns}:t`, TAB = `${ns}:tab`, BR = `${ns}:br`, CR = `${ns}:cr`
  for (const t of tags(xml)) {
    if (inText && open.length && t.start > last) out[open.at(-1)!] += unescapeXml(xml.slice(last, t.start))
    last = t.end
    if (t.name === P) {
      if (t.close) open.pop()
      else if (!t.selfClose) { open.push(out.length); out.push('') }
    } else if (t.name === T) inText = !t.close && !t.selfClose
    else if ((t.name === TAB || t.name === BR || t.name === CR) && open.length && !t.close) out[open.at(-1)!] += t.name === TAB ? '\t' : '\n'
  }
  return out
}

/** The line without spaces and tabs at its end (a loop: the regex /[ \t]+$/ is quadratic on a long run of spaces). */
function trimLineEnd(l: string): string {
  let e = l.length
  while (e > 0 && (l.charCodeAt(e - 1) === 0x20 || l.charCodeAt(e - 1) === 0x09)) e--
  return e === l.length ? l : l.slice(0, e)
}

// other line breaks (CR, U+0085, U+2028, U+2029, VT, FF) become '\n', so `quoteLine` sees every line
export const LINE_BREAK = /\r\n|[\n\r\v\f\u0085\u2028\u2029]/g
const tidy = (lines: string[]) => lines.join('\n').replace(LINE_BREAK, '\n').split('\n').map(trimLineEnd).join('\n').replace(/\n{3,}/g, '\n\n').trim()

/** A line of the file's own text that starts like a section label gets a space in front, so it cannot end a section. */
const quoteLine = (text: string) => text.split('\n').map((l) => (l.startsWith(SECTION_MARK) ? ' ' + l : l)).join('\n')
/**
 * Text that is not ours (pandoc's body text): a line that starts like a section label gets a space in front, as in
 * `quoteLine`, after every kind of line break. The rest of the text does not change.
 */
export const quoteLines = (text: string) => (text.startsWith(SECTION_MARK) ? ' ' : '') +
  text.replace(new RegExp(`(${LINE_BREAK.source})${SECTION_MARK}`, 'g'), `$1 ${SECTION_MARK}`)
/** Attribute text (author, date, chart title, series name, category) on one line: line breaks become spaces. */
const oneLine = (text: string) => text.replace(LINE_BREAK, ' ')
const indent = (text: string, pad = '  ') => quoteLine(text).split('\n').map((l) => (l ? pad + l : l)).join('\n')

const num = (p: string) => Number(/(\d+)\.xml$/.exec(p)?.[1] ?? 0)
const byNumber = (a: string, b: string) => num(a) - num(b)

/** Relationships of a part: id -> target path inside the zip (relative targets resolved against the part's folder). */
function rels(p: Parts, part: string): Map<string, { type: string; target: string }> {
  const dir = part.slice(0, part.lastIndexOf('/') + 1)
  const xml = xmlOf(p, `${dir}_rels/${part.slice(dir.length)}.rels`)
  const out = new Map<string, { type: string; target: string }>()
  if (!xml) return out
  for (const t of tags(xml)) {
    if (t.name !== 'Relationship' || t.close) continue
    const id = attr(t.head, 'Id'), type = attr(t.head, 'Type') ?? '', target = attr(t.head, 'Target')
    if (!id || !target || attr(t.head, 'TargetMode') === 'External') continue
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

/**
 * Text of the comment ranges in the body: comment id -> the commented text (shortened). One pass over the tags: the
 * text of a <w:t> goes to each open range that is not yet full, and a full range only waits for its end tag. So each
 * range takes at most about ANCHOR_MAX non-empty text runs, and the time stays linear in the document size. A range
 * without an end tag gives no text.
 */
function commentAnchors(doc: string): Map<string, string> {
  const out = new Map<string, string>()
  const filling = new Map<string, string>() // open ranges that take more text
  const full = new Map<string, string>() // open ranges with enough text
  let inText = false
  let last = 0
  for (const t of tags(doc)) {
    if (inText && filling.size && t.start > last) {
      const run = unescapeXml(doc.slice(last, t.start))
      if (run) for (const [id, text] of filling) {
        const next = text + run
        if (next.length > ANCHOR_MAX) { filling.delete(id); full.set(id, next) } else filling.set(id, next)
      }
    }
    last = t.end
    if (t.name === 'w:t') { inText = !t.close && !t.selfClose; continue }
    if (t.close || (t.name !== 'w:commentRangeStart' && t.name !== 'w:commentRangeEnd')) continue
    const id = attr(t.head, 'w:id')
    if (id === undefined || out.has(id)) continue
    if (t.name === 'w:commentRangeStart') {
      if (!full.has(id)) filling.set(id, filling.get(id) ?? '')
      continue
    }
    const got = filling.get(id) ?? full.get(id)
    filling.delete(id); full.delete(id)
    const text = got?.replace(/\s+/g, ' ').trim()
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
    for (const { head, inner: body } of elements(comments, 'w:comment')) {
      const id = attr(head, 'w:id') ?? ''
      const text = tidy(paragraphs(body, 'w'))
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
  const shapes = elements(xml, 'p:sp').map((e) => ({ xml: e.inner, ph: startTag(e.inner, 'p:ph', 0) }))
  const type = (s: (typeof shapes)[number]) => (s.ph ? attr(s.ph.head, 'type') : undefined)
  const body = shapes.filter((s) => type(s) === 'body')
  const use = body.length ? body : shapes.filter((s) => !['sldNum', 'sldImg', 'hdr', 'ftr', 'dt'].includes(type(s) ?? ''))
  return tidy(use.flatMap((s) => paragraphs(s.xml, 'a')))
}

/**
 * Cached values of a chart reference (<c:pt idx="n"><c:v>…</c:v></c:pt>), by index, on one line each. A point with an
 * index at or past the declared <c:ptCount>, or at POINT_IDX_MAX and more, is skipped: the index sizes the array.
 */
function points(xml: string | undefined): string[] {
  const out: string[] = []
  if (!xml) return out
  const count = startTag(xml, 'c:ptCount', 0)
  const declared = count ? attr(count.head, 'val') : undefined
  const max = Math.min(POINT_IDX_MAX, declared && /^\d+$/.test(declared) ? Number(declared) : POINT_IDX_MAX)
  for (const pt of elements(xml, 'c:pt')) {
    const idx = attr(pt.head, 'idx')
    if (!idx || !/^\d+$/.test(idx)) continue
    const v = inner(pt.inner, 'c:v')
    const i = Number(idx)
    if (v !== undefined && !v.includes('<') && i < max) out[i] = oneLine(unescapeXml(v))
  }
  return out
}

/** A chart part as text: title, kind and every series with its categories and cached values. */
function chartText(xml: string): string {
  // the chart's own title comes before the plot area (an axis title is inside it)
  const plotAt = startTag(xml, 'c:plotArea', 0)
  const titleXml = inner(plotAt ? xml.slice(0, plotAt.start) : xml, 'c:title')
  const title = titleXml ? oneLine(tidy(paragraphs(titleXml, 'a'))) || points(titleXml)[0] || '' : ''
  const plot = inner(xml, 'c:plotArea') ?? xml
  const kinds = [...new Set([...plot.matchAll(/<c:(\w+)Chart\b/g)].map((m) => m[1]!))]
  const lines: string[] = []
  for (const { inner: ser } of elements(plot, 'c:ser')) {
    const tx = inner(ser, 'c:tx')
    const name = tx ? (points(tx)[0] ?? unescapeXml(inner(tx, 'c:v') ?? '')) : ''
    const cats = points(inner(ser, 'c:cat') ?? inner(ser, 'c:xVal'))
    const vals = points(inner(ser, 'c:val') ?? inner(ser, 'c:yVal'))
    const n = Math.max(cats.length, vals.length)
    const pairs: string[] = []
    for (let i = 0; i < n; i++) if (vals[i] !== undefined) pairs.push(cats[i] !== undefined ? `${cats[i]} = ${vals[i]}` : vals[i]!)
    lines.push(`  - series "${oneLine(name)}": ${pairs.length ? pairs.join('; ') : '(no stored values)'}`)
  }
  const head = `- Chart${title ? ` "${title}"` : ''}${kinds.length ? ` (${kinds.join(', ')} chart)` : ''}:`
  return quoteLine([head, ...(lines.length ? lines : ['  (no series)'])].join('\n'))
}

/** Slides in show order: presentation.xml's slide list, else the slide parts by number. A slide is given once. */
function slideOrder(p: Parts): string[] {
  const pres = xmlOf(p, 'ppt/presentation.xml')
  const r = rels(p, 'ppt/presentation.xml')
  const listed: string[] = []
  for (const t of tags(pres ? inner(pres, 'p:sldIdLst') ?? '' : '')) {
    if (t.name !== 'p:sldId' || t.close) continue
    const target = r.get(attr(t.head, 'r:id') ?? '')?.target
    if (target && p.has(target)) listed.push(target)
  }
  return listed.length ? [...new Set(listed)] : [...p.keys()].filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort(byNumber)
}

/** First position of each `r:id="…"` value in a slide (one pass), to put the charts in the order of the slide. */
function idPositions(xml: string): Map<string, number> {
  const out = new Map<string, number>()
  const pat = 'r:id="'
  for (let i = xml.indexOf(pat); i >= 0; i = xml.indexOf(pat, i + pat.length)) {
    const e = xml.indexOf('"', i + pat.length)
    if (e < 0) break
    const id = xml.slice(i + pat.length, e)
    if (!out.has(id)) out.set(id, i)
    i = e
  }
  return out
}

/** Speaker notes and chart data of a .pptx, by slide ('' when it has none). */
export function pptxExtraText(bytes: Uint8Array): string {
  const p = parts(bytes, 'presentation')
  // a part that many slides or relationships refer to is read once
  const memo = new Map<string, string>()
  const once = (target: string, f: (xml: string) => string) => {
    if (!memo.has(target)) memo.set(target, f(xmlOf(p, target) ?? ''))
    return memo.get(target)!
  }
  const slides: string[] = []
  let size = 0
  for (const [i, slide] of slideOrder(p).entries()) {
    if (size > EXTRA_TEXT_MAX) break // `capped` cuts the text there
    const r = rels(p, slide)
    const pos = idPositions(xmlOf(p, slide) ?? '')
    const out: string[] = []
    const notes = new Set([...r.values()].filter((v) => v.type.endsWith('/notesSlide')).map((v) => v.target))
    for (const target of notes) {
      const text = once(target, notesText)
      if (text) out.push(`Speaker notes:\n${indent(text)}`)
    }
    // charts in the order they are placed on the slide
    const charts = [...r.entries()].filter(([, v]) => v.type.endsWith('/chart'))
      .sort(([a], [b]) => (pos.get(a) ?? Infinity) - (pos.get(b) ?? Infinity))
    for (const target of new Set(charts.map(([, v]) => v.target))) {
      if (!p.has(target)) continue
      out.push(once(target, chartText))
    }
    if (!out.length) continue
    const text = `${SECTION_MARK}Slide ${i + 1} ===\n${out.join('\n')}`
    slides.push(text)
    size += text.length
  }
  if (!slides.length) return ''
  return capped([`${SECTION_MARK}PowerPoint speaker notes and chart data, by slide (not part of the slide text above) ===`, ...slides])
}
