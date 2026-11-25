// Parts of .docx and .pptx files that pandoc's plain text drops: Word headers, footers, comments and charts, PowerPoint
// speaker notes and chart data (series names, categories, values). extract.ts adds this text after pandoc's body
// text. The parsing expands untrusted zip and XML input, so it runs only in the office worker
// (files/office-worker.ts), never in the server process. The zip is checked first (zip-guard.ts) and the text is
// capped. Each section has a fixed label, so the AI can tell where the text came from. The text is document content,
// not instructions (chat/prompt.ts).
// The XML is untrusted, so every scan is linear in the size of the part: tags are found with indexOf from the current
// position, and a scan stops at the first tag or element that is not closed. No regex here can backtrack over a part
// (a lazy `[\s\S]*?` regex took 22 s for a 1.2 MB chart part with unclosed <c:pt> tags, QA review).
import zlib from 'node:zlib'
import * as XLSX from 'xlsx'
import { ToolError } from '../policy/errors'
import { checkZip, entryData, isZip, readCentral, ZIP_ENTRIES_MAX, type ZipEntry } from './zip-guard'

/** characters of extra text out of one file */
const EXTRA_TEXT_MAX = 4 * 1024 * 1024
/** characters of the body text that a comment refers to */
const ANCHOR_MAX = 200
/** comment ranges that take body text at the same time */
const ANCHORS_OPEN_MAX = 1000
/** Chart points with an index at or above this are skipped (the index is untrusted and sizes an array). */
const POINT_IDX_MAX = 10_000

/** The start of each section label; a line of the file's own text that starts like this is marked (see `quoteLine`). */
export const SECTION_MARK = '=== '

export type Parts = Map<string, Uint8Array>

export function parts(bytes: Uint8Array, what: string): Parts {
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

export const xmlOf = (p: Parts, name: string): string | null => {
  const b = p.get(name)
  return b ? new TextDecoder('utf-8').decode(b) : null
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
export const unescapeXml = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
  e[0] === '#' ? codePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENTITIES[e] ?? m))
/** a character reference's character; one past Unicode (or not a number) is U+FFFD, never a thrown RangeError */
const codePoint = (n: number) => (Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '\ufffd')
/** An attribute of a tag's attribute text (`head`). */
export const attr = (head: string, name: string) => {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(head)
  return m ? unescapeXml(m[1]!) : undefined
}

// ---------------- linear XML scanning ----------------

export type Tag = { name: string; close: boolean; selfClose: boolean; head: string; start: number; end: number }

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
export function* tags(xml: string): Generator<Tag> {
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
export function startTag(xml: string, name: string, from: number): Tag | null {
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
export function elements(xml: string, name: string, max = Infinity): { head: string; inner: string }[] {
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
export const inner = (xml: string, name: string) => elements(xml, name, 1)[0]?.inner

/**
 * Paragraph text of WordprocessingML or DrawingML: paragraphs are <w:p> / <a:p>, text runs <w:t> / <a:t>, with tabs and
 * line breaks. Deleted text (<w:delText>) and field codes (<w:instrText>) are not text runs, so they are left out.
 */
export function paragraphs(xml: string, ns: 'w' | 'a'): string[] {
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
export function rels(p: Parts, part: string): Map<string, { type: string; target: string }> {
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
 * range takes at most about ANCHOR_MAX non-empty text runs of at most ANCHOR_MAX + 1 characters, and at most
 * ANCHORS_OPEN_MAX ranges take text at the same time (a later range gets no text). So the time stays linear in the
 * document size. A range without an end tag gives no text.
 */
function commentAnchors(doc: string): Map<string, string> {
  const out = new Map<string, string>()
  const filling = new Map<string, string>() // open ranges that take more text
  const full = new Map<string, string>() // open ranges with enough text
  let inText = false
  let last = 0
  for (const t of tags(doc)) {
    if (inText && filling.size && t.start > last) {
      // only the first ANCHOR_MAX characters are kept, so a long run is cut once here
      const run = unescapeXml(doc.slice(last, t.start)).slice(0, ANCHOR_MAX + 1)
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
      if (!full.has(id) && (filling.has(id) || filling.size < ANCHORS_OPEN_MAX)) filling.set(id, filling.get(id) ?? '')
      continue
    }
    const got = filling.get(id) ?? full.get(id)
    filling.delete(id); full.delete(id)
    const text = got?.replace(/\s+/g, ' ').trim()
    if (text) out.set(id, text.length > ANCHOR_MAX ? text.slice(0, ANCHOR_MAX) + '…' : text)
  }
  return out
}

/** How each kind of tracked change shows in a changed paragraph. */
const CHANGE_MARK: Record<string, string> = { 'w:ins': 'inserted', 'w:del': 'deleted', 'w:moveFrom': 'moved away', 'w:moveTo': 'moved here' }

/**
 * The paragraphs of the body that hold tracked changes (Word's Track Changes, not yet accepted or rejected), each with
 * its changes marked in place: `[deleted: …]`, `[inserted: …]`, `[moved away: …]`, `[moved here: …]`, and who made them.
 * pandoc's body text accepts every change (insertions kept, deletions left out), so the deleted text is only here. One
 * pass over the tags, like `paragraphs`: <w:delText> is the text of a deleted run. A change mark without text (a
 * paragraph mark, a run property change) is left out.
 */
export function trackedChanges(doc: string): { text: string; who: string }[] {
  // `marks`: open marks on this paragraph (its text is kept until they close)
  const lines: { text: string; who: Set<string>; changed: boolean; marks: number }[] = []
  const open: number[] = [] // line index of each open paragraph
  // open change marks, innermost last: the line, the kind, who made it, and whether its `[kind: ` is written yet. A mark
  // is written when its first text comes, so a mark without text never costs a copy of the line.
  const marks: { line: number; kind: string; who: string; started: boolean }[] = []
  let inText = false
  let last = 0
  /** Text for the innermost paragraph: first the opening of each mark of it that waits for text (the open marks at
   * the top of the stack, back to the first one that is written or on another line), oldest first. */
  const add = (line: number, text: string) => {
    const l = lines[line]!
    let i = marks.length
    while (i > 0 && !marks[i - 1]!.started && marks[i - 1]!.line === line) i--
    for (; i < marks.length; i++) {
      const m = marks[i]!
      m.started = true
      l.text += `[${m.kind}: `
      if (m.who) l.who.add(m.who)
    }
    l.text += text
  }
  for (const t of tags(doc)) {
    const at = open.length ? open.at(-1)! : -1
    if (inText && at >= 0 && t.start > last) { const run = unescapeXml(doc.slice(last, t.start)); if (run) add(at, run) }
    last = t.end
    const kind = CHANGE_MARK[t.name]
    if (t.name === 'w:p') {
      if (t.close) {
        // the text of an unchanged paragraph without open marks is not kept
        const i = open.pop()
        if (i !== undefined && !lines[i]!.changed && !lines[i]!.marks) lines[i]!.text = ''
      } else if (!t.selfClose) { open.push(lines.length); lines.push({ text: '', who: new Set(), changed: false, marks: 0 }) }
    } else if (t.name === 'w:t' || t.name === 'w:delText') inText = !t.close && !t.selfClose
    else if ((t.name === 'w:tab' || t.name === 'w:br' || t.name === 'w:cr') && at >= 0 && !t.close) add(at, t.name === 'w:tab' ? '\t' : ' ')
    else if (kind && !t.selfClose) {
      if (!t.close) {
        // a mark outside a paragraph keeps its place on the stack (written, so no text waits for it), so its end tag
        // closes it and not another one
        if (at < 0) { marks.push({ line: -1, kind, who: '', started: true }); continue }
        const who = [attr(t.head, 'w:author'), attr(t.head, 'w:date')?.slice(0, 10)].filter(Boolean).map((v) => oneLine(v!)).join(', ')
        marks.push({ line: at, kind, who, started: false })
        lines[at]!.marks++
      } else {
        const m = marks.pop()
        if (!m || m.line < 0) continue
        const line = lines[m.line]!
        line.marks--
        // a mark that got text closes and marks its paragraph as changed; one without text leaves nothing
        if (m.started) { line.text += ']'; line.changed = true }
      }
    }
  }
  return lines.filter((l) => l.changed).map((l) => ({ text: oneLine(l.text).trim(), who: [...l.who].join('; ') }))
}

/** Headers, footers, comments, tracked changes and chart data of a .docx ('' when it has none). */
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
  const doc = xmlOf(p, 'word/document.xml')
  const changes = doc ? trackedChanges(doc) : []
  if (changes.length) {
    sections.push(`${SECTION_MARK}Word tracked changes (edits not yet accepted; the body above shows insertions and leaves deletions out) ===\n` +
      changes.map((c) => quoteLine(`- Changed${c.who ? ` by ${c.who}` : ''}:`) + `\n${indent(c.text, '    ')}`).join('\n'))
  }
  // charts of the body in the order they are placed (pandoc gives no chart data, like a deck's)
  if (doc) {
    const pos = idPositions(doc)
    const charts = [...rels(p, 'word/document.xml').entries()].filter(([, v]) => v.type.endsWith('/chart'))
      .sort(([a], [b]) => (pos.get(a) ?? Infinity) - (pos.get(b) ?? Infinity))
    const lines = [...new Set(charts.map(([, v]) => v.target))].filter((t) => p.has(t)).map((t) => chartText(xmlOf(p, t) ?? ''))
    if (lines.length) sections.push(`${SECTION_MARK}Word charts (the data of the charts in the body, in order) ===\n${lines.join('\n')}`)
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
export function points(xml: string | undefined): string[] {
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

/**
 * The chart XML with its chart elements under the prefix `c:`, as Office writes them. Other writers (openpyxl, some
 * converters) put the chart namespace as the default one (`<chartSpace>`, `<ser>`) or under another prefix. One pass
 * of a regex that cannot backtrack (each match is `<`, an optional `/` and a name start).
 */
export function chartPrefix(xml: string): string {
  let root: Tag | undefined
  for (const t of tags(xml)) if (!t.close && t.name.slice(t.name.indexOf(':') + 1) === 'chartSpace') { root = t; break }
  if (!root) return xml
  const at = root.name.indexOf(':')
  const prefix = at < 0 ? '' : root.name.slice(0, at)
  if (prefix === 'c') return xml
  if (!prefix) return xml.replace(/<(\/?)([A-Za-z_][\w.-]*)(?=[\s/>])/g, '<$1c:$2')
  return xml.split(`<${prefix}:`).join('<c:').split(`</${prefix}:`).join('</c:')
}

/** The formula of a chart reference (`<c:f>Sales!$B$2:$B$5</c:f>`), on one line, or undefined. */
const refOf = (xml: string | undefined) => {
  const f = xml ? inner(xml, 'c:f') : undefined
  return f && !f.includes('<') ? oneLine(unescapeXml(f)).trim() || undefined : undefined
}

/**
 * A chart part as text: title, kind and every series with its categories and cached values. `ranges`: each series
 * also names the cells its name, categories and values come from (an Excel chart, whose cells are in the workbook);
 * `where`: words after the chart's head ("on sheet …").
 */
export function chartText(xml: string, o: { ranges?: boolean; where?: string } = {}): string {
  xml = chartPrefix(xml)
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
    let from = ''
    if (o.ranges) {
      const refs = [['values', refOf(inner(ser, 'c:val') ?? inner(ser, 'c:yVal'))], ['categories', refOf(inner(ser, 'c:cat') ?? inner(ser, 'c:xVal'))], ['name', refOf(tx)]]
        .filter(([, r]) => r).map(([k, r]) => `${k} ${r}`)
      if (refs.length) from = ` (${refs.join(', ')})`
    }
    lines.push(`  - series${name ? ` "${oneLine(name)}"` : ''}${from}: ${pairs.length ? pairs.join('; ') : o.ranges ? '(no stored values; the cells above hold them)' : '(no stored values)'}`)
  }
  const head = `- Chart${title ? ` "${title}"` : ''}${kinds.length ? ` (${kinds.join(', ')} chart)` : ''}${o.where ? ` ${o.where}` : ''}:`
  return quoteLine([head, ...(lines.length ? lines : ['  (no series)'])].join('\n'))
}

/** Slides in show order: presentation.xml's slide list, else the slide parts by number. A slide is given once. */
export function slideOrder(p: Parts): string[] {
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

// ---------------- .xlsx ----------------

/** a part of a workbook that the charts need (workbook, relationships, drawings, charts) larger than this is not read */
const XLSX_CHART_PART_MAX = 16 * 1024 * 1024
/** inflated bytes of those parts out of one workbook */
const XLSX_CHART_TOTAL_MAX = 64 * 1024 * 1024
/** the declared size of a workbook that may still be read here (sheet-stream.ts STREAM_TOTAL_MAX): only the few parts
 * the charts need are inflated */
const XLSX_DECLARED_MAX = 4096 * 1024 * 1024
/** `<sheet>` tags of the workbook that are looked at (a real workbook has far fewer; each sheet part is read once) */
const XLSX_SHEET_TAGS_MAX = 4096
/** charts described out of one workbook */
const XLSX_CHARTS_MAX = 1000
/** wall clock for the charts of one workbook: well inside the worker's own time limit, so the sheets' text is never
 * lost to it (office-parse.ts withCharts gives a labelled line instead) */
export const XLSX_CHARTS_TIME_MS = 10_000

/** The label of the chart section of a workbook's text (files/locations.ts: the lines after it belong to no sheet). */
export const XLSX_CHARTS_LABEL = `${SECTION_MARK}Excel charts (charts drawn on the sheets above, with the cells they show) ===`

/** The chart section of a workbook's text, or the line that says it was not read (office-parse.ts withCharts). A cell
 * line of the workbook never starts with `=== ` (office-parse.ts quotes it), so only these lines match. */
export const XLSX_CHARTS_SECTION = /^=== (?:Excel charts \(|The charts of this workbook were not read \().* ===$/

/** A limit of the whole workbook's charts (size, time): every chart stops, the section says so. */
class ChartsStop extends ToolError {}

/**
 * The parts of a workbook, each inflated when it is first asked for and kept: a large workbook is not read whole for
 * its charts, its sheets stay compressed. Each part at most XLSX_CHART_PART_MAX, all of them XLSX_CHART_TOTAL_MAX, a
 * stored part must be the size it says (as checkZip), an inflated one may not pass its declared size. A part that is too
 * large or damaged throws a ToolError.
 */
class LazyParts extends Map<string, Uint8Array> {
  private index = new Map<string, ZipEntry>()
  private total = 0
  constructor(private bytes: Uint8Array) {
    super()
    let entries: ZipEntry[]
    try { entries = readCentral(bytes, { total: XLSX_DECLARED_MAX, entries: ZIP_ENTRIES_MAX }) } catch { throw new ToolError('the file could not be opened') }
    for (const e of entries) this.index.set(new TextDecoder('utf-8').decode(e.nameBytes).replace(/^\/+/, ''), e)
  }
  override has(name: string) { return this.index.has(name) }
  override get(name: string): Uint8Array | undefined {
    const kept = super.get(name)
    if (kept) return kept
    const e = this.index.get(name)
    if (!e) return undefined
    if (e.usize > XLSX_CHART_PART_MAX) throw new ToolError(`a part is over ${XLSX_CHART_PART_MAX / 1024 / 1024} MB`)
    this.total += e.usize
    if (this.total > XLSX_CHART_TOTAL_MAX) throw new ChartsStop(`its chart parts are over ${XLSX_CHART_TOTAL_MAX / 1024 / 1024} MB`)
    let out: Uint8Array
    try {
      const data = entryData(this.bytes, e)
      if (e.method === 0) {
        if (e.csize !== e.usize) throw new Error('stored entry with two sizes')
        out = data
      } else {
        out = new Uint8Array(zlib.inflateRawSync(data, { maxOutputLength: Math.max(e.usize, 1) }))
        if (out.byteLength !== e.usize) throw new Error('a part is not the size its header says')
      }
    } catch { throw new ToolError('a chart part is damaged') }
    super.set(name, out)
    return out
  }
}

/**
 * The charts of an .xlsx, sheet by sheet in the workbook's order and in the order each sheet's drawing places them:
 * type, title, and every series with the cells of its name, categories and values and their cached values (Excel stores
 * the values it last drew). '' when the workbook has no charts. SheetJS and the streaming reader give only cells.
 * Every part is read and scanned at most once (a sheet, drawing or chart named again is skipped), so the time is
 * linear in the parts; past XLSX_CHARTS_TIME_MS it stops with a ToolError. A chart whose part is missing or cannot be
 * read gets its own line.
 */
export function xlsxChartsText(bytes: Uint8Array, o: { timeMs?: number } = {}): string {
  if (!isZip(bytes)) return ''
  const deadline = Date.now() + (o.timeMs ?? XLSX_CHARTS_TIME_MS)
  const late = () => { if (Date.now() > deadline) throw new ChartsStop(`reading them took longer than ${Math.round((o.timeMs ?? XLSX_CHARTS_TIME_MS) / 1000)} s`) }
  const p = new LazyParts(bytes)
  const wb = xmlOf(p, 'xl/workbook.xml')
  if (!wb) return ''
  const relsMemo = new Map<string, ReturnType<typeof rels>>()
  const relsOf = (part: string) => { let r = relsMemo.get(part); if (!r) { r = rels(p, part); relsMemo.set(part, r) } return r }
  const wbRels = relsOf('xl/workbook.xml')
  const seen = new Set<string>() // sheet, drawing and chart parts already read
  const lines: string[] = []
  let sheetTags = 0
  for (const t of tags(wb)) {
    if (t.close || t.name.slice(t.name.indexOf(':') + 1) !== 'sheet') continue
    if (++sheetTags > XLSX_SHEET_TAGS_MAX || lines.length >= XLSX_CHARTS_MAX) break
    late()
    const rid = /\sr:id="([^"]*)"/.exec(t.head)?.[1] ?? /\s\w+:id="([^"]*)"/.exec(t.head)?.[1]
    const sheet = rid ? wbRels.get(unescapeXml(rid)) : undefined
    if (!sheet || seen.has(sheet.target)) continue
    seen.add(sheet.target)
    const name = oneLine(attr(t.head, 'name') ?? '').trim()
    const where = `${sheet.type.endsWith('/chartsheet') ? 'on chart sheet' : 'on sheet'} "${name}"`
    for (const v of relsOf(sheet.target).values()) {
      if (!v.type.endsWith('/drawing') || seen.has(v.target)) continue
      seen.add(v.target)
      late()
      const dxml = xmlOf(p, v.target)
      if (!dxml) continue
      const pos = idPositions(dxml)
      const charts = [...relsOf(v.target).entries()].filter(([, r]) => r.type.endsWith('/chart'))
        .sort(([a], [b]) => (pos.get(a) ?? Infinity) - (pos.get(b) ?? Infinity))
      for (const [, c] of charts) {
        if (seen.has(c.target) || lines.length >= XLSX_CHARTS_MAX) continue
        seen.add(c.target)
        late()
        if (!p.has(c.target)) { lines.push(`- A chart ${where} was not read (its part is missing from the file)`); continue }
        try { lines.push(chartText(xmlOf(p, c.target) ?? '', { ranges: true, where })) } catch (e) {
          // the whole workbook's limits (size, time) stop all charts; one damaged or too large chart only itself
          if (e instanceof ChartsStop) throw e
          lines.push(`- A chart ${where} was not read (${e instanceof ToolError ? e.message : 'the reader failed'})`)
        }
      }
    }
  }
  return lines.length ? capped([`${XLSX_CHARTS_LABEL}\n${lines.join('\n')}`]) : ''
}
