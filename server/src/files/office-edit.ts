// edit_office (tools/edit-office.ts; plan docs/AGENTS/plan/20261118-1041-office-edit-in-place.md): an EXISTING .docx,
// .xlsx or .pptx changed in place, everything outside the edited parts kept as it was. This file holds what the three
// editors share (docx-edit.ts, xlsx-edit.ts, pptx-edit.ts) and the office worker's two modes:
// - `office-edit`: the file and the changes in, the changed file and a report out;
// - `office-verify`: the old and the new file in, run in a fresh worker: every changed XML part is well-formed XML
//   (saxes, namespaces checked), and the text reads as the old text with only the reported changes (paragraphs for
//   .docx / .pptx, compared with a diff; every cell of every sheet for .xlsx, read with SheetJS, not with our patcher).
// The documents are untrusted, so all of this runs ONLY in the office worker (files/office-worker.ts, isolated like
// the readers), never in the server process. The zip is checked first (zip-guard.ts: sizes, ratio, count, no zip64,
// no encryption) and every part that is not changed is copied with its compressed bytes as they were (zip-write.ts
// readZip / writeZip `raw`). An XML part is changed by splicing byte ranges found with a linear tag scan (ooxml.ts
// tags): nothing else in the part is rewritten.
import { SaxesParser } from 'saxes'
import * as XLSX from 'xlsx'
import { ToolError } from '../policy/errors'
import { xmlSafe } from './docx-comment'
import { tags, unescapeXml } from './ooxml'
import { checkZip, isZip, ZIP_TOTAL_MAX } from './zip-guard'
import { readZip, writeZip, type ZipEntry } from './zip-write'
import {
  frame, OFFICE_EDIT_LIMITS, unframe, type CellWrite, type EditNote, type EditReport, type OfficeKind, type VerifyRequest,
} from './office-edit-check'

export { frame, unframe, OFFICE_EDIT_LIMITS, OFFICE_EDIT_MAX, OFFICE_EDIT_MODE, OFFICE_VERIFY_MODE, type CellWrite, type EditNote, type EditReport, type OfficeKind } from './office-edit-check'

const MIB = 1024 * 1024
export const refuse = (why: string): never => { throw new ToolError(`${why}; nothing was saved`) }

// ---------------------------------------------------------------- XML: a tree of tag offsets, and splices

export interface XNode {
  name: string
  /** the start tag's attribute text */
  head: string
  /** where the element starts, where its start tag ends, where its end tag starts, where it ends */
  start: number; openEnd: number; closeStart: number; end: number
  self: boolean
  parent: XNode | null
  kids: XNode[]
}

/**
 * The elements of an XML part as a tree of offsets (text is not copied; it is sliced from the part when needed).
 * Refused: a DTD, comments, CDATA or processing instructions after the declaration (the tag scan cannot vouch for
 * what is inside them, and Office never writes them in these parts), and an end tag that does not close the open element.
 */
export function xmlTree(xml: string, part: string): XNode {
  const bad = (why: string): never => refuse(`this file cannot be changed (${part}: ${why})`)
  if (xml.includes('<!')) bad('it holds a DTD, comments or CDATA')
  const root: XNode = { name: '#root', head: '', start: 0, openEnd: 0, closeStart: xml.length, end: xml.length, self: false, parent: null, kids: [] }
  let top = root
  let nodes = 0
  let first = true
  for (const t of tags(xml)) {
    if (t.name.startsWith('?')) {
      if (!first || t.name !== '?xml') bad('it holds a processing instruction')
      first = false
      continue
    }
    first = false
    if (++nodes > OFFICE_EDIT_LIMITS.nodes) bad('it has too many elements')
    if (t.close) {
      if (top === root || top.name !== t.name) bad(`the element ${t.name} is not closed where it should be`)
      top.closeStart = t.start
      top.end = t.end
      top = top.parent!
      continue
    }
    const n: XNode = { name: t.name, head: t.head, start: t.start, openEnd: t.end, closeStart: t.end, end: t.end, self: t.selfClose, parent: top, kids: [] }
    top.kids.push(n)
    if (!t.selfClose) top = n
  }
  if (top !== root) bad(`the element ${top.name} is not closed`)
  return root
}

/** The first element of this name below `n` (depth first), or null. */
export function find(n: XNode, name: string): XNode | null {
  const stack = [...n.kids].reverse()
  while (stack.length) {
    const x = stack.pop()!
    if (x.name === name) return x
    for (let i = x.kids.length - 1; i >= 0; i--) stack.push(x.kids[i]!)
  }
  return null
}
/** Every element of this name below `n` in document order (not below one already found unless `nested`). */
export function findAll(n: XNode, name: string, nested = false): XNode[] {
  const out: XNode[] = []
  const stack = [...n.kids].reverse()
  while (stack.length) {
    const x = stack.pop()!
    if (x.name === name) { out.push(x); if (!nested) continue }
    for (let i = x.kids.length - 1; i >= 0; i--) stack.push(x.kids[i]!)
  }
  return out
}
export const kid = (n: XNode, name: string) => n.kids.find((k) => k.name === name) ?? null
export const kidsNamed = (n: XNode, name: string) => n.kids.filter((k) => k.name === name)
export function ancestor(n: XNode, name: string, stop?: XNode): XNode | null {
  for (let p = n.parent; p && p !== stop; p = p.parent) if (p.name === name) return p
  return null
}
/** An attribute of an element's start tag, unescaped. */
export function attrOf(head: string, name: string): string | undefined {
  const m = new RegExp(`(?:^|\\s)${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(head)
  return m ? unescapeXml(m[2] ?? m[3] ?? '') : undefined
}
/** The value of a prefixed `…:id` attribute (r:id, the relationship an element points at), either quoting, or ''. */
export function relId(head: string): string {
  const m = /(?:^|\s)[A-Za-z_][\w.-]*:id\s*=\s*("([^"]*)"|'([^']*)')/.exec(head)
  return m ? unescapeXml(m[2] ?? m[3] ?? '') : ''
}
/** The prefix of that attribute ("r"), for a new element written next to the others. */
export const relIdPrefix = (head: string) => /(?:^|\s)([A-Za-z_][\w.-]*):id\s*=/.exec(head)?.[1] ?? 'r'
/** The start tag's attribute text with one attribute set (added at the end when it is not there) or removed (null). */
export function withAttr(head: string, name: string, value: string | null): string {
  const re = new RegExp(`\\s${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*("[^"]*"|'[^']*')`)
  if (value === null) return head.replace(re, '')
  const a = ` ${name}="${escAttr(value)}"`
  return re.test(head) ? head.replace(re, a) : head.replace(/\s*$/, '') + a
}
export const slice = (xml: string, n: XNode) => xml.slice(n.start, n.end)
export const inner = (xml: string, n: XNode) => (n.self ? '' : xml.slice(n.openEnd, n.closeStart))
export const textOf = (xml: string, n: XNode) => unescapeXml(inner(xml, n))
/** text for XML content: cleaned of what XML 1.0 forbids, escaped */
export const escText = (s: string) => xmlSafe(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
export const escAttr = (s: string) => escText(s).replace(/"/g, '&quot;')
/** The element's XML with every element of these names (and what is inside) left out. */
export function without(xml: string, n: XNode, names: ReadonlySet<string>): string {
  const cuts: [number, number][] = []
  const stack = [...n.kids]
  while (stack.length) {
    const x = stack.pop()!
    if (names.has(x.name)) { cuts.push([x.start, x.end]); continue }
    stack.push(...x.kids)
  }
  cuts.sort((a, b) => a[0] - b[0])
  let out = '', p = n.start
  for (const [s, e] of cuts) { out += xml.slice(p, s); p = e }
  return out + xml.slice(p, n.end)
}

export interface Splice { from: number; to: number; text: string; change: number }
/** The part with the splices applied; two that overlap (or an insertion inside a replaced range) are refused. */
export function applySplices(xml: string, splices: Splice[], part: string): string {
  const s = [...splices].sort((a, b) => a.from - b.from || a.to - b.to || a.change - b.change)
  for (let i = 1; i < s.length; i++) {
    const a = s[i - 1]!, b = s[i]!
    const overlap = b.from < a.to || (b.from === a.from && a.to > a.from && b.to > b.from)
    if (overlap) refuse(`changes ${Math.min(a.change, b.change) + 1} and ${Math.max(a.change, b.change) + 1} touch the same place in ${part}; give them in separate calls`)
  }
  let out = '', p = 0
  for (const x of s) { out += xml.slice(p, x.from) + x.text; p = x.to }
  return out + xml.slice(p)
}

// ---------------------------------------------------------------- the package

const decoder = new TextDecoder('utf-8', { fatal: true })
export class Pkg {
  readonly entries: ZipEntry[]
  private readonly byName = new Map<string, ZipEntry>()
  private readonly texts = new Map<string, string>()
  private readonly changedText = new Map<string, string>()
  private readonly addedParts = new Map<string, Uint8Array>()
  private readonly removedParts = new Set<string>()

  constructor(bytes: Uint8Array, readonly kind: OfficeKind) {
    const what = { docx: 'a Word document', xlsx: 'an Excel workbook', pptx: 'a PowerPoint deck' }[kind]
    if (!isZip(bytes)) refuse(`this file is not ${what} (not a zip container)`)
    checkZip(bytes, { total: ZIP_TOTAL_MAX, entries: OFFICE_EDIT_LIMITS.entries })
    let entries: ZipEntry[] = []
    try { entries = readZip(bytes) } catch (e) { refuse(`its zip container is damaged (${String((e as Error).message).slice(0, 120)})`) }
    this.entries = entries
    for (const e of entries) {
      if (this.byName.has(e.name)) refuse(`its zip container has two parts named ${e.name.slice(0, 80)}`)
      this.byName.set(e.name, e)
    }
    if (!this.byName.has('[Content_Types].xml')) refuse(`this file is not ${what} (no content types part)`)
    // a signed package: any change breaks the signature, which Office then reports as tampering
    if (entries.some((e) => /^_xmlsignatures\//i.test(e.name))) refuse('this file is digitally signed, and changing it would break the signature; ask the person to remove the signature in Office first, or save the changes as a new document with make_file')
    if (entries.some((e) => /vbaProject\.bin$/i.test(e.name))) refuse('this file holds macros (a macro-enabled document saved with a .docx/.xlsx/.pptx name), which are not changed here')
  }
  has(name: string) { return !this.removedParts.has(name) && (this.changedText.has(name) || this.addedParts.has(name) || this.byName.has(name)) }
  names(): string[] { return [...this.entries.map((e) => e.name).filter((n) => !this.removedParts.has(n)), ...this.addedParts.keys()] }
  /** an XML part's text (as it is now in this edit), or null */
  text(name: string): string | null {
    if (this.removedParts.has(name)) return null
    const c = this.changedText.get(name)
    if (c !== undefined) return c
    const cached = this.texts.get(name)
    if (cached !== undefined) return cached
    const added = this.addedParts.get(name)
    const e = this.byName.get(name)
    const data = added ?? e?.data
    if (!data) return null
    if (data.length > OFFICE_EDIT_LIMITS.xmlBytes) refuse(`this file cannot be changed (${name} is larger than ${OFFICE_EDIT_LIMITS.xmlBytes / MIB} MB)`)
    let t: string
    try { t = decoder.decode(data) } catch { return refuse(`this file cannot be changed (${name} is not UTF-8 text)`) }
    this.texts.set(name, t)
    return t
  }
  need(name: string): string { return this.text(name) ?? refuse(`this file cannot be changed (it has no ${name})`) }
  set(name: string, xml: string) {
    if (this.addedParts.has(name)) { this.addedParts.set(name, new TextEncoder().encode(xml)); return }
    if (!this.byName.has(name)) { this.addedParts.set(name, new TextEncoder().encode(xml)); return }
    this.changedText.set(name, xml)
  }
  add(name: string, data: Uint8Array) {
    if (this.has(name)) throw new Error(`part exists: ${name}`)
    this.addedParts.set(name, data)
  }
  remove(name: string) { if (this.byName.has(name)) this.removedParts.add(name); this.addedParts.delete(name); this.changedText.delete(name) }
  /** a name not in the package: `${prefix}${n}${suffix}` with the first free n from `from` */
  free(prefix: string, suffix: string, from = 1): string {
    const taken = new Set(this.names().map((n) => n.toLowerCase()))
    let n = from
    while (taken.has(`${prefix}${n}${suffix}`.toLowerCase())) n++
    return `${prefix}${n}${suffix}`
  }
  write(): { file: Uint8Array; changed: string[]; added: string[]; removed: string[] } {
    const enc = new TextEncoder()
    const changed: string[] = []
    const out: ZipEntry[] = []
    for (const e of this.entries) {
      if (this.removedParts.has(e.name)) continue
      const t = this.changedText.get(e.name)
      if (t === undefined || t === this.texts.get(e.name)) { out.push(e); continue }
      changed.push(e.name)
      out.push({ name: e.name, data: enc.encode(t), utf8: e.utf8, time: e.time, date: e.date })
    }
    for (const [name, data] of this.addedParts) out.push({ name, data })
    let file: Uint8Array
    try { file = writeZip(out) } catch (e) { return refuse(`the changed file could not be written (${String((e as Error).message).slice(0, 120)})`) }
    return { file, changed, added: [...this.addedParts.keys()], removed: [...this.removedParts] }
  }
}

/** A part's relationships: id -> { type (the last path segment), target (resolved to a part name), external }. */
export interface Rel { id: string; type: string; target: string; external: boolean; node: XNode }
export function relsPartOf(part: string): string {
  const i = part.lastIndexOf('/')
  return `${part.slice(0, i + 1)}_rels/${part.slice(i + 1)}.rels`
}
export function resolveTarget(fromPart: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  const parts = fromPart.split('/').slice(0, -1)
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop()
    else if (seg !== '.' && seg !== '') parts.push(seg)
  }
  return parts.join('/')
}
export function readRels(pkg: Pkg, part: string): { xml: string; tree: XNode; rels: Rel[] } | null {
  const name = relsPartOf(part)
  const xml = pkg.text(name)
  if (xml === null) return null
  const tree = xmlTree(xml, name)
  const root = find(tree, 'Relationships')
  const rels: Rel[] = []
  for (const n of root ? kidsNamed(root, 'Relationship') : []) {
    const id = attrOf(n.head, 'Id') ?? ''
    const type = (attrOf(n.head, 'Type') ?? '').split('/').pop() ?? ''
    const raw = attrOf(n.head, 'Target') ?? ''
    const external = attrOf(n.head, 'TargetMode') === 'External'
    rels.push({ id, type, target: external ? raw : resolveTarget(part, raw), external, node: n })
  }
  return { xml, tree, rels }
}
/** The relationships part with one relationship added; returns its new id. */
export function addRel(pkg: Pkg, part: string, typeUri: string, target: string, alsoTaken: Iterable<string> = []): string {
  const name = relsPartOf(part)
  const xml = pkg.text(name) ?? '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>'
  // every Id as XML has it (either quoting, spaces around =), so a new one never repeats one (security review)
  const root = kid(xmlTree(xml, name), 'Relationships')
  const taken = new Set((root ? kidsNamed(root, 'Relationship') : []).map((r) => attrOf(r.head, 'Id') ?? ''))
  // ids the part already points at without a relationship (a broken reference must not come to show the new target)
  for (const t of alsoTaken) taken.add(t)
  let n = taken.size + 1
  while (taken.has(`rId${n}`)) n++
  const id = `rId${n}`
  pkg.set(name, appendTo(xml, 'Relationships', `<Relationship Id="${id}" Type="${typeUri}" Target="${escAttr(target)}"/>`, name))
  return id
}
/** `extra` put before the root's end tag (a self-closed root is opened first) */
export function appendTo(xml: string, root: string, extra: string, part: string): string {
  const t = xmlTree(xml, part)
  const r = kid(t, root) ?? refuse(`this file cannot be changed (${part} has no ${root})`)
  if (r.self) return xml.slice(0, r.start) + `<${root}${r.head}>${extra}</${root}>` + xml.slice(r.end)
  return xml.slice(0, r.closeStart) + extra + xml.slice(r.closeStart)
}
/** [Content_Types].xml with an Override for a new part (or a Default for an extension) when it has none */
export function ensureContentType(pkg: Pkg, o: { part?: string; ext?: string; type: string }) {
  const name = '[Content_Types].xml'
  const xml = pkg.need(name)
  if (o.part) {
    if (new RegExp(`PartName\\s*=\\s*["']/${o.part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`, 'i').test(xml)) return
    pkg.set(name, appendTo(xml, 'Types', `<Override PartName="/${escAttr(o.part)}" ContentType="${o.type}"/>`, name))
  } else if (o.ext) {
    if (new RegExp(`Extension\\s*=\\s*["']${o.ext}["']`, 'i').test(xml)) return
    pkg.set(name, appendTo(xml, 'Types', `<Default Extension="${o.ext}" ContentType="${o.type}"/>`, name))
  }
}
/** The main part of the package (the officeDocument relationship of _rels/.rels). */
export function mainPart(pkg: Pkg, fallback: string): string {
  const r = readRels(pkg, '')
  const main = r?.rels.find((x) => x.type === 'officeDocument' && !x.external)
  return main?.target ?? fallback
}

// ---------------------------------------------------------------- paragraphs and runs (docx w:, pptx a:)

/** A piece of a paragraph's text: a text element of a run (editable), or a tab / break / field (kept as it is). */
export interface Piece {
  node: XNode
  /** the run element it is in (w:r / a:r), or null for a break outside a run (a:br) */
  run: XNode | null
  text: string
  editable: boolean
  /** why it is not editable */
  why?: string
  /** inside a tracked change (w:ins, w:del, w:moveTo, w:moveFrom) */
  tracked: boolean
  /** start in the paragraph's text */
  at: number
}
export interface Para { part: string; node: XNode; pieces: Piece[]; text: string; box: boolean }

export interface RunDialect {
  p: string; r: string; t: string; rPr: string; pPr: string
  /** elements that stand for one character in the paragraph's text */
  fixed: Record<string, string>
  /** elements whose text is shown but not changed here (a field) */
  fields: ReadonlySet<string>
  tracked: ReadonlySet<string>
  /** text boxes: a paragraph inside is its own */
  boxes: ReadonlySet<string>
}
export const W: RunDialect = {
  p: 'w:p', r: 'w:r', t: 'w:t', rPr: 'w:rPr', pPr: 'w:pPr',
  fixed: { 'w:tab': '\t', 'w:br': '\n', 'w:cr': '\n' },
  fields: new Set(['w:fldSimple']),
  tracked: new Set(['w:ins', 'w:del', 'w:moveTo', 'w:moveFrom']),
  boxes: new Set(['w:txbxContent']),
}
export const A: RunDialect = {
  p: 'a:p', r: 'a:r', t: 'a:t', rPr: 'a:rPr', pPr: 'a:pPr',
  fixed: { 'a:br': '\n' },
  fields: new Set(['a:fld']),
  tracked: new Set(),
  boxes: new Set(),
}

/** The paragraphs of a part in reading order, each with its pieces of text (the older copy in mc:Fallback is left out,
 * as Office does not show it; a paragraph in a text box is its own). Complex Word fields (w:fldChar begin ... end) mark
 * their result text as not editable. */
export function paragraphs(xml: string, tree: XNode, part: string, d: RunDialect): Para[] {
  const out: Para[] = []
  const open: Para[] = []
  let field = 0
  type Frame = { n: XNode; exit: boolean }
  const stack: Frame[] = tree.kids.map((n) => ({ n, exit: false })).reverse()
  let boxes = 0
  let tracked = 0
  let fieldEl = 0
  while (stack.length) {
    const { n, exit } = stack.pop()!
    if (exit) {
      if (n.name === d.p) open.pop()
      if (d.boxes.has(n.name)) boxes--
      if (d.tracked.has(n.name)) tracked--
      if (d.fields.has(n.name)) fieldEl--
      continue
    }
    if (n.name === 'mc:Fallback') continue
    const top = open[open.length - 1]
    if (n.name === 'w:fldChar') {
      const t = attrOf(n.head, 'w:fldCharType')
      if (t === 'begin') field++
      else if (t === 'end') field = Math.max(0, field - 1)
    }
    if (n.name === d.p) {
      const p: Para = { part, node: n, pieces: [], text: '', box: boxes > 0 }
      out.push(p)
      open.push(p)
    } else if (top && n.name === d.t) {
      const run = n.parent && n.parent.name === d.r ? n.parent : null
      const text = textOf(xml, n)
      const inField = fieldEl > 0 || field > 0 || !run
      top.pieces.push({ node: n, run, text, editable: !inField, why: inField ? 'a field (a page number, a date, a table of contents)' : undefined, tracked: tracked > 0, at: top.text.length })
      top.text += text
      continue
    } else if (top && d.fixed[n.name] !== undefined && !(d.p === 'w:p' && ancestor(n, 'w:rPr'))) {
      const ch = d.fixed[n.name]!
      top.pieces.push({ node: n, run: n.parent?.name === d.r ? n.parent : null, text: ch, editable: false, why: ch === '\t' ? 'a tab' : 'a line break', tracked: tracked > 0, at: top.text.length })
      top.text += ch
      continue
    }
    if (d.boxes.has(n.name)) boxes++
    if (d.tracked.has(n.name)) tracked++
    if (d.fields.has(n.name)) fieldEl++
    stack.push({ n, exit: true })
    for (let i = n.kids.length - 1; i >= 0; i--) stack.push({ n: n.kids[i]!, exit: false })
  }
  return out
}

/** Where the text `find` is, in the paragraphs: every match as [paragraph, start] (non-overlapping per paragraph). */
export function matchesOf(paras: Para[], find: string): { para: Para; at: number }[] {
  const out: { para: Para; at: number }[] = []
  for (const para of paras) {
    for (let i = para.text.indexOf(find); i >= 0; i = para.text.indexOf(find, i + find.length)) out.push({ para, at: i })
  }
  return out
}

/** Picks the matches a change means: one (refused when there are several and no occurrence), the n-th, or all. */
export function pick<T>(hits: T[], c: { occurrence?: number; all?: boolean }, i: number, what: string, find: string): T[] {
  const q = JSON.stringify(find.length > 80 ? find.slice(0, 80) + '…' : find)
  if (!hits.length) return refuse(`change ${i + 1}: ${q} is not in the text of any one paragraph${what} (give exact text from a single paragraph, as read shows it, without Markdown marks such as ** or \\)`)
  if (c.all) return hits
  if (c.occurrence !== undefined) {
    const h = hits[c.occurrence - 1]
    if (!h) refuse(`change ${i + 1}: occurrence ${c.occurrence} is past the ${hits.length} places that hold ${q}`)
    return [h!]
  }
  if (hits.length > 1) refuse(`change ${i + 1}: ${q} is in ${hits.length} places${what}; give occurrence (1 to ${hits.length}), all: true, or longer text`)
  return [hits[0]!]
}

export interface TextEdit { at: number; len: number; text: string; change: number }

/**
 * The splices that replace text in one paragraph: each edit's new text goes into the first piece it touches (so it takes
 * that run's formatting); the rest of the matched text is cut out of the pieces after it. Refused when an edit touches
 * a tab, a line break, a field, a tracked change, or runs in different places (a link and the text after it).
 * `textXml` writes a piece's text element with the new text.
 */
export function textSplices(xml: string, para: Para, edits: TextEdit[], textXml: (piece: Piece, text: string) => string): Splice[] {
  edits = [...edits].sort((a, b) => a.at - b.at)
  for (let i = 1; i < edits.length; i++) if (edits[i]!.at < edits[i - 1]!.at + edits[i - 1]!.len) refuse(`changes ${edits[i - 1]!.change + 1} and ${edits[i]!.change + 1} change overlapping text`)
  const touched = new Map<Piece, string>()
  for (const e of edits) {
    const end = e.at + e.len
    const hit = para.pieces.filter((p) => p.at < end && p.at + p.text.length > e.at)
    const where = `change ${e.change + 1}`
    const fixed = hit.find((p) => !p.editable)
    if (fixed) refuse(`${where}: the text runs across ${fixed.why}, which is kept as it is; give text on one side of it`)
    if (hit.some((p) => p.tracked)) refuse(`${where}: the text is inside a tracked change (a suggested edit); accept or reject it in Word first, or add a comment with comment_docx`)
    const parents = new Set(hit.map((p) => p.run?.parent))
    if (parents.size > 1) refuse(`${where}: the text runs across a link or a field box into the text next to it; change the two parts separately`)
  }
  // each touched piece's new text: its characters outside every edit, and an edit's new text at the edit's start
  for (const p of para.pieces) {
    const s = p.at, e = p.at + p.text.length
    const mine = edits.filter((x) => x.at < e && x.at + x.len > s)
    if (!mine.length) continue
    let out = '', pos = s
    for (const x of mine) {
      if (x.at > pos) out += p.text.slice(pos - s, x.at - s)
      if (x.at >= s) out += x.text
      pos = Math.max(pos, x.at + x.len)
    }
    if (pos < e) out += p.text.slice(pos - s)
    touched.set(p, out)
  }
  const change = edits[0]!.change
  return [...touched].map(([p, text]) => ({ from: p.node.start, to: p.node.end, text: textXml(p, text), change }))
}

// ---------------------------------------------------------------- verification (a fresh worker)

/** a diff of two lists of strings: the indexes of `a` not kept and of `b` not kept (Myers, O((N+M)D), D capped) */
export function listDiff(a: string[], b: string[], maxD = 20_000): { removed: number[]; added: number[] } | null {
  let s = 0
  while (s < a.length && s < b.length && a[s] === b[s]) s++
  let ea = a.length, eb = b.length
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb-- }
  const A1 = a.slice(s, ea), B1 = b.slice(s, eb)
  const N = A1.length, M = B1.length
  const max = Math.min(N + M, maxD)
  const off = max + 1
  const v = new Int32Array(2 * max + 3)
  const trace: Int32Array[] = []
  let found = -1
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice())
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!) ? v[off + k + 1]! : v[off + k - 1]! + 1
      let y = x - k
      while (x < N && y < M && A1[x] === B1[y]) { x++; y++ }
      v[off + k] = x
      if (x >= N && y >= M) { found = d; break }
    }
    if (found >= 0) break
  }
  if (found < 0) return null
  const removed: number[] = [], added: number[] = []
  let x = N, y = M
  for (let d = found; d > 0; d--) {
    const vv = trace[d]!
    const k = x - y
    const prevK = k === -d || (k !== d && vv[off + k - 1]! < vv[off + k + 1]!) ? k + 1 : k - 1
    const px = vv[off + prevK]!, py = px - prevK
    while (x > px && y > py) { x--; y-- }
    if (x === px) added.push(s + py); else removed.push(s + px)
    x = px; y = py
  }
  return { removed: removed.reverse(), added: added.reverse() }
}

/** Well-formed XML with every prefix bound (saxes, the parser of hwpx-write.ts), no DTD. */
export function assertWellFormed(xml: string, part: string): void {
  const parser = new SaxesParser({ xmlns: true })
  let err: Error | null = null
  parser.on('error', (e) => { err ??= e })
  parser.on('doctype', () => { err ??= new Error('a DTD') })
  try { parser.write(xml).close() } catch (e) { err ??= e as Error }
  if (err) refuse(`the changed file did not pass the checks (${part} is not well-formed XML: ${String((err as Error).message).slice(0, 160)})`)
}

/** Every cell's value and formula, per sheet name and A1 address (SheetJS, an independent reader). */
function cellsOf(bytes: Uint8Array): Map<string, string> {
  const wb = XLSX.read(bytes, { type: 'array', dense: false, cellFormula: true, cellStyles: false, cellHTML: false, bookVBA: false, bookFiles: false, sheetStubs: true })
  const out = new Map<string, string>()
  for (const s of wb.SheetNames) {
    const ws = wb.Sheets[s]!
    for (const [k, c] of Object.entries(ws)) {
      if (k.startsWith('!')) continue
      const cell = c as XLSX.CellObject
      const f = cell.f ? `=${cell.f}` : ''
      out.set(`${s}!${k}`, f || (cell.t === 'z' || cell.v === undefined || cell.v === null || cell.v === '' ? '' : `${cell.t}:${String(cell.v)}`))
    }
  }
  return out
}
export function expectedCell(w: CellWrite): string {
  if (w.formula !== undefined) return `=${w.formula}`
  if (w.value === null || w.value === '') return ''
  if (typeof w.value === 'number') return `n:${w.value}`
  if (typeof w.value === 'boolean') return `b:${w.value}`
  return `s:${w.value}`
}

/** The paragraphs' text of a whole .docx (body, headers, footers, notes) or .pptx (slides in order). */
type ParaLister = (pkg: Pkg) => string[]
const listers: Partial<Record<OfficeKind, ParaLister>> = {}
export function registerLister(kind: OfficeKind, f: ParaLister) { listers[kind] = f }

/** every wp:docPr id (a drawing's id in a Word document) of the XML parts directly in `dir` (body, headers, footers,
 * notes, comments) */
export function docPrIds(pkg: Pkg, dir: string): number[] {
  const out: number[] = []
  for (const n of pkg.names()) {
    if (!n.startsWith(dir) || !/^[^/]+\.xml$/.test(n.slice(dir.length))) continue
    const x = pkg.text(n)
    if (x === null || !x.includes('docPr')) continue
    for (const m of x.matchAll(/<[A-Za-z_][\w.-]*:docPr\b[^>]*?\sid\s*=\s*["'](\d+)["']/g)) out.push(Number(m[1]))
  }
  return out
}
const counted = <T>(xs: T[]) => { const m = new Map<T, number>(); for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1); return m }

/** A .docx with new pictures (edit_office insert_picture): every new wp:docPr id is used once in the whole document, and
 * every new r:embed of the main part names an internal image relationship whose target is a part this edit added and
 * that has a content type. The paragraph read-back cannot see pictures, so this is what vouches for them. */
function assertNewPictures(oldPkg: Pkg, neu: Pkg, r: VerifyRequest): void {
  const bad = (why: string): never => refuse(`the changed file did not pass the checks (${why})`)
  const main = mainPart(neu, 'word/document.xml')
  const dir = main.slice(0, main.lastIndexOf('/') + 1)
  const rels = readRels(neu, main)?.rels ?? []
  const ct = neu.need('[Content_Types].xml')
  const added = new Set(r.added)
  const before = counted(docPrIds(oldPkg, dir))
  for (const [id, n] of counted(docPrIds(neu, dir))) if (n > (before.get(id) ?? 0) && n !== 1) bad(`a picture id ${id} is used twice`)
  // the relationships: every old one as it was, every new one an internal image relationship to a part added here
  const oldRels = new Map((readRels(oldPkg, main)?.rels ?? []).map((x) => [x.id, x]))
  for (const x of readRels(neu, main)?.rels ?? []) {
    const o = oldRels.get(x.id)
    if (o) { if (o.type !== x.type || o.target !== x.target || o.external !== x.external) bad(`the relationship ${JSON.stringify(x.id.slice(0, 40))} changed`); oldRels.delete(x.id); continue }
    if (x.external || x.type !== 'image' || !added.has(x.target)) bad(`a new relationship ${JSON.stringify(x.id.slice(0, 40))} is not a picture added here`)
  }
  if (oldRels.size) bad('a relationship was removed')
  // the content types: only a Default for png or jpeg may be new, nothing else changes
  const entries = (x: string) => [...x.matchAll(/<(?:[A-Za-z_][\w.-]*:)?(?:Default|Override)\b[^>]*>/g)].map((m) => m[0])
  const oldCt = counted(entries(oldPkg.need('[Content_Types].xml')))
  for (const e of entries(ct)) {
    const n = oldCt.get(e) ?? 0
    if (n > 0) { oldCt.set(e, n - 1); continue }
    if (!/^<Default Extension="(png|jpeg)" ContentType="image\/(png|jpeg)"\/>$/.test(e)) bad('the content types changed')
  }
  if ([...oldCt.values()].some((n) => n > 0)) bad('a content type was removed')
  const embeds = (x: string) => counted([...x.matchAll(/\s[A-Za-z_][\w.-]*:embed\s*=\s*["']([^"']*)["']/g)].map((m) => m[1]!))
  const oldE = embeds(oldPkg.need(main))
  for (const [id, n] of embeds(neu.need(main))) {
    if (n <= (oldE.get(id) ?? 0)) continue
    const rel = rels.find((x) => x.id === id)
    if (!rel || rel.external || rel.type !== 'image' || !added.has(rel.target)) bad(`a new picture points at ${JSON.stringify(id.slice(0, 40))}, which is not a picture added here`)
    const ext = rel!.target.split('.').pop()!.toLowerCase()
    if (!new RegExp(`Extension="${ext}"`, 'i').test(ct) && !ct.includes(`PartName="/${rel!.target}"`)) bad(`${rel!.target} has no content type`)
  }
}

export function verifyOfficeEdit(r: VerifyRequest, oldBytes: Uint8Array, newBytes: Uint8Array): void {
  const neu = new Pkg(newBytes, r.kind)
  for (const name of [...r.changed, ...r.added]) {
    if (!/\.(xml|rels)$/i.test(name)) continue
    assertWellFormed(neu.need(name), name)
  }
  assertUniqueRelIds(neu, [...r.changed, ...r.added])
  if (r.kind === 'xlsx') {
    const before = cellsOf(oldBytes), after = cellsOf(newBytes)
    const written = new Map((r.cells ?? []).map((w) => [`${w.sheet}!${w.ref}`, w]))
    for (const [k, w] of written) {
      const got = after.get(k) ?? ''
      const want = expectedCell(w)
      // SheetJS gives a formula without its leading "_xlfn." prefixes the same as we wrote them
      if (got !== want && !(want.startsWith('=') && got.replace(/_xlfn\./g, '') === want.replace(/_xlfn\./g, ''))) refuse(`the changed workbook did not read back as asked (${k} reads ${JSON.stringify(got.slice(0, 80))}, not ${JSON.stringify(want.slice(0, 80))})`)
    }
    for (const k of new Set([...before.keys(), ...after.keys()])) {
      if (written.has(k)) continue
      if ((before.get(k) ?? '') !== (after.get(k) ?? '')) refuse(`the changed workbook did not read back as asked (${k} changed, but no change named it)`)
    }
    return
  }
  // a docx edit that touched its relationships or content types (only insert_picture does) is checked part by part
  if (r.kind === 'docx' && [...r.changed, ...r.added].some((n) => /\/media\/|\.rels$|^\[Content_Types\]\.xml$/.test(n))) assertNewPictures(new Pkg(oldBytes, r.kind), neu, r)
  const lister = listers[r.kind]!
  const a = lister(new Pkg(oldBytes, r.kind)), b = lister(neu)
  const diff = listDiff(a, b)
  if (!diff) refuse('the changed file did not read back as asked (too many paragraphs differ)')
  // counted, not as sets: two paragraphs with the same text are two paragraphs (security review)
  const count = (xs: string[]) => { const m = new Map<string, number>(); for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1); return m }
  const before = count(r.notes.flatMap((n) => (n.before !== undefined ? [n.before] : [])))
  const after = count(r.notes.flatMap((n) => n.after ?? []))
  const take = (m: Map<string, number>, t: string) => { const n = m.get(t) ?? 0; if (n > 0) m.set(t, n - 1); return n > 0 }
  for (const i of diff!.removed) if (!take(before, a[i]!)) refuse(`the changed file did not read back as asked (the paragraph ${JSON.stringify(a[i]!.slice(0, 80))} changed, but no change named it)`)
  const want = new Map(after)
  for (const i of diff!.added) if (!take(after, b[i]!)) refuse(`the changed file did not read back as asked (the paragraph ${JSON.stringify(b[i]!.slice(0, 80))} is new, but no change made it)`)
  const have = count(b)
  for (const [t, n] of want) if (t !== '' && (have.get(t) ?? 0) < n) refuse(`the changed file did not read back as asked (${JSON.stringify(t.slice(0, 80))} is not in it)`)
}

/** Every changed or added relationships part has each Id once (a repeated one makes Office repair or misread the file). */
function assertUniqueRelIds(pkg: Pkg, names: string[]): void {
  for (const name of names) {
    if (!/\.rels$/i.test(name)) continue
    const root = kid(xmlTree(pkg.need(name), name), 'Relationships')
    const ids = (root ? kidsNamed(root, 'Relationship') : []).map((r) => attrOf(r.head, 'Id') ?? '')
    if (new Set(ids).size !== ids.length) refuse(`the changed file did not pass the checks (${name} has a relationship id twice)`)
  }
}

// ---------------------------------------------------------------- the worker's modes

export interface EditRequest { kind: OfficeKind; changes: unknown[] }
/** every string of the changes through xmlSafe (tabs and line breaks stay) */
function cleanStrings(v: unknown, depth = 0): unknown {
  if (depth > 8) return v
  if (typeof v === 'string') return xmlSafe(v)
  if (Array.isArray(v)) return v.map((x) => cleanStrings(x, depth + 1))
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cleanStrings(x, depth + 1)]))
  return v
}
type Editor = (pkg: Pkg, changes: unknown[], images: Uint8Array[]) => Omit<EditReport, 'changed' | 'added' | 'removed'>
const editors: Partial<Record<OfficeKind, Editor>> = {}
export function registerEditor(kind: OfficeKind, f: Editor) { editors[kind] = f }

export function officeEditRequest(input: Uint8Array): Uint8Array {
  let req: { json: EditRequest; blobs: Uint8Array[] }
  try { req = unframe<EditRequest>(input) } catch { return refuse('the request could not be read') }
  const { kind, changes } = req.json
  const editor = editors[kind]
  if (!editor || !Array.isArray(changes) || !req.blobs.length) return refuse('the request could not be read')
  if (changes.length > OFFICE_EDIT_LIMITS.changes) refuse(`give at most ${OFFICE_EDIT_LIMITS.changes} changes in one call`)
  const pkg = new Pkg(req.blobs[0]!, kind)
  // the AI's text without the characters XML cannot hold, before anything is matched or reported: the report and the
  // read-back then compare the text that is really written (security review)
  const report = editor(pkg, cleanStrings(changes) as unknown[], req.blobs.slice(1))
  const w = pkg.write()
  const full: EditReport = { ...report, changed: w.changed, added: w.added, removed: w.removed }
  return frame(full as unknown as Record<string, unknown>, [w.file])
}

export function officeVerifyRequest(input: Uint8Array): Uint8Array {
  let req: { json: VerifyRequest; blobs: Uint8Array[] }
  try { req = unframe<VerifyRequest>(input) } catch { return refuse('the request could not be read') }
  if (req.blobs.length !== 2) refuse('the request could not be read')
  verifyOfficeEdit(req.json, req.blobs[0]!, req.blobs[1]!)
  return new TextEncoder().encode('ok')
}
