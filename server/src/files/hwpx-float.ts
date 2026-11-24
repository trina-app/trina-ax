// A .hwpx drawn by the HWP preview with Hangul's text flow around floating pictures (QA TC-8832).
//
// OWPML: a picture that floats behind or in front of the text (hp:pos treatAsChar="0", textWrap="BEHIND_TEXT" or
// "IN_FRONT_OF_TEXT") never moves the text; placed from its paragraph (vertRelTo="PARA"), its top is the paragraph's
// top plus vertOffset (negative: above it). The pinned renderer (rhwp 0.8.7) breaks that when a body paragraph holds
// such a picture: behind the text, the paragraph is laid out zero lines tall and the next one is drawn over it (every
// offset, horizontal reference, size and z-order, with or without Hangul's stored layout); a paragraph that holds only
// the picture is laid out a line lower, so the picture lands a line too low (measured: tests/unit/hwpx-float.test.ts).
// A picture placed from the paper or the page, or one that wraps the text (square, top and bottom), is drawn right.
//
// So before the renderer draws (or lays out) such a document, the preview driver (hwp-engine.ts job):
// 1. probe: this worker writes a copy without those pictures: the text flow Hangul gives the document, since they
//    move no text;
// 2. the renderer lays the probe out (export-render-tree, dump-pages); paragraphTops reads where each body paragraph's
//    first line is drawn;
// 3. pin: this worker writes the document with each of those pictures placed from the paper at its paragraph's top plus
//    its own offset, behind or in front as it was. Nothing else changes: the text, its stored layout, every other part.
// The probe and the pin run ONLY in the isolated preflight worker (hwp-preflight.ts): the document is an untrusted zip.
// paragraphTops runs in the server on the renderer's output, which is data: checked like parseRenderTree.
import { HWP_LIMITS as L } from '@mycel/shared/hwp'
import { checkZip } from './zip-guard'
import { readZip, writeZip, type ZipEntry } from './zip-write'

/** where the probe drew a body paragraph's first line (px at 96 dpi from the top of its page): its section and its
 * index among the section's top-level paragraphs */
export interface ParaTop { section: number; para: number; y: number }

const HU_PER_PX = 75
export const FLOAT_LIMITS = { pictures: 500, paragraphs: 100_000 }

interface Tag { name: string; local: string; start: number; end: number; attrs: Map<string, string>; self: boolean }
interface Pic { section: number; para: number; tag: Tag; end: number; pos: Tag }

const ATTR = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
/** the section's tags in order (comments, CDATA, processing instructions and text skipped; preflight checked the XML) */
function* tags(xml: string): Generator<Tag & { close: boolean }> {
  for (let i = xml.indexOf('<'); i >= 0; i = xml.indexOf('<', i + 1)) {
    if (xml.startsWith('<!--', i)) { i = xml.indexOf('-->', i); if (i < 0) return; continue }
    if (xml.startsWith('<![CDATA[', i)) { i = xml.indexOf(']]>', i); if (i < 0) return; continue }
    if (xml[i + 1] === '?' || xml[i + 1] === '!') { i = xml.indexOf('>', i); if (i < 0) return; continue }
    const end = endOfTag(xml, i)
    if (end < 0) return
    const close = xml[i + 1] === '/'
    const body = xml.slice(i + (close ? 2 : 1), end - 1)
    const self = body.endsWith('/')
    const name = /^[^\s/>]+/.exec(body)?.[0] ?? ''
    const attrs = new Map<string, string>()
    if (!close) for (const m of body.slice(name.length).matchAll(ATTR)) attrs.set(m[1]!, m[2] ?? m[3] ?? '')
    yield { name, local: name.slice(name.indexOf(':') + 1), start: i, end, attrs, self, close }
    i = end - 1
  }
}
/** the end of the tag at `i` (one past its ">"), quotes respected */
function endOfTag(xml: string, i: number): number {
  let q = ''
  for (let k = i + 1; k < xml.length; k++) {
    const c = xml[k]!
    if (q) { if (c === q) q = ''; continue }
    if (c === '"' || c === '\'') q = c
    else if (c === '>') return k + 1
  }
  return -1
}

/** The pictures the renderer lays out wrong: hp:pic right in a run of a top-level body paragraph (hp:sec > hp:p >
 * hp:run > hp:pic), floating (treatAsChar="0") behind or in front of the text, placed from the top of its paragraph
 * (vertRelTo="PARA", vertAlign="TOP"). Pictures in tables, text boxes or groups are left as they are. */
function targets(xml: string, section: number): Pic[] {
  const stack: Tag[] = []
  const out: Pic[] = []
  let para = -1
  let open: { tag: Tag; pos: Tag | null } | null = null
  for (const t of tags(xml)) {
    if (t.close) {
      const top = stack.pop()
      if (open && top === open.tag) {
        const pos = open.pos, wrap = open.tag.attrs.get('textWrap')
        if (pos && pos.attrs.get('treatAsChar') !== '1' && (wrap === 'BEHIND_TEXT' || wrap === 'IN_FRONT_OF_TEXT') &&
          pos.attrs.get('vertRelTo') === 'PARA' && (pos.attrs.get('vertAlign') ?? 'TOP') === 'TOP') out.push({ section, para, tag: open.tag, end: t.end, pos })
        open = null
      }
      continue
    }
    const parent = stack[stack.length - 1]
    if (t.local === 'p' && stack.length === 1) para++
    if (!open && t.local === 'pic' && !t.self && stack.length === 3 && parent?.local === 'run') open = { tag: t, pos: null }
    else if (open && parent === open.tag && t.local === 'pos') open.pos = t
    if (!t.self) stack.push(t)
  }
  return out
}

const isSection = (n: string) => /^Contents\/section\d+\.xml$/i.test(n)
const sectionNumber = (n: string) => Number(/(\d+)\.xml$/i.exec(n)![1])

interface Parsed { entries: ZipEntry[]; sections: { entry: ZipEntry; xml: string; index: number; pics: Pic[] }[] }
function parse(bytes: Uint8Array): Parsed {
  checkZip(bytes, { total: L.expandedBytes, entries: L.entries })
  const entries: ZipEntry[] = readZip(bytes)
  const sections = entries.filter((e) => isSection(e.name) && e.data.length)
    .sort((a, b) => sectionNumber(a.name) - sectionNumber(b.name))
    .map((entry, index) => {
      const xml = new TextDecoder('utf-8', { fatal: true }).decode(entry.data)
      return { entry, index, xml, pics: targets(xml, index) }
    })
  return { entries, sections }
}

/** a section with `edits` (ranges replaced by new text) */
function patched(xml: string, edits: { start: number; end: number; text: string }[]): string {
  let out = '', at = 0
  for (const e of [...edits].sort((a, b) => a.start - b.start)) { out += xml.slice(at, e.start) + e.text; at = e.end }
  return out + xml.slice(at)
}
/** the tag's text with `set` attributes replaced or added */
function withAttrs(xml: string, t: Tag, set: Record<string, string>): string {
  let s = xml.slice(t.start, t.end)
  for (const [k, v] of Object.entries(set)) {
    const re = new RegExp(`(\\s${k}\\s*=\\s*)(?:"[^"]*"|'[^']*')`)
    s = re.test(s) ? s.replace(re, `$1"${v}"`) : s.replace(/\s*(\/?)>$/, ` ${k}="${v}"$1>`)
  }
  return s
}
function rezip(p: Parsed, changed: Map<ZipEntry, string>): Uint8Array {
  return writeZip(p.entries.map((e) => {
    const xml = changed.get(e)
    return xml === undefined ? e : { ...e, data: new TextEncoder().encode(xml), raw: undefined }
  }))
}
/** an offset as Hangul writes it (32-bit unsigned for a negative one) or signed, in HWPUNIT */
function signed(v: string | undefined): number {
  const n = Number(v ?? 0)
  if (!Number.isFinite(n)) return 0
  return n >= 2 ** 31 ? n - 2 ** 32 : n
}

/** The probe: the document without the pictures the renderer lays out wrong (they move no text), or null when it has
 * none (the preview then draws the document as it is). */
export function floatProbe(bytes: Uint8Array): Uint8Array | null {
  const p = parse(bytes)
  if (p.sections.reduce((n, s) => n + s.pics.length, 0) > FLOAT_LIMITS.pictures) return null
  const changed = new Map<ZipEntry, string>()
  for (const s of p.sections) if (s.pics.length) changed.set(s.entry, patched(s.xml, s.pics.map((x) => ({ start: x.tag.start, end: x.end, text: '' }))))
  return changed.size ? rezip(p, changed) : null
}

/** The document with each picture the renderer lays out wrong placed from the paper: its paragraph's top as the probe
 * drew it (`tops`) plus its own offset. A picture whose paragraph has no top stays as it is. */
export function floatPin(bytes: Uint8Array, tops: ParaTop[]): Uint8Array {
  const p = parse(bytes)
  const at = new Map(tops.map((t) => [`${t.section}:${t.para}`, t.y]))
  const changed = new Map<ZipEntry, string>()
  for (const s of p.sections) {
    const edits = s.pics.flatMap((x) => {
      const y = at.get(`${x.section}:${x.para}`)
      if (y === undefined) return []
      const top = Math.round(y * HU_PER_PX) + signed(x.pos.attrs.get('vertOffset'))
      return [{ start: x.pos.start, end: x.pos.end, text: withAttrs(s.xml, x.pos, { vertRelTo: 'PAPER', vertOffset: String(top >>> 0) }) }]
    })
    if (edits.length) changed.set(s.entry, patched(s.xml, edits))
  }
  return changed.size ? rezip(p, changed) : bytes
}

/** Where the renderer drew each body paragraph's first line, from every page's render tree (export-render-tree) and its
 * section (dump-pages): the first body TextLine of each section and paragraph (pi) in page order; lines in tables,
 * headers and footers are left out. A tree that is not such a tree gives nothing. */
export function paragraphTops(trees: unknown[], sections: number[]): ParaTop[] {
  const out = new Map<string, ParaTop>()
  let nodes = 0
  const walk = (v: unknown, depth: number, section: number) => {
    if (++nodes > 400_000 || depth > 64 || !v || typeof v !== 'object' || Array.isArray(v)) return
    const n = v as Record<string, unknown>
    if (n.type === 'Header' || n.type === 'Footer' || n.type === 'Table' || n.type === 'Cell' || n.type === 'PageBg') return
    if (n.type === 'TextLine') {
      const y = (n.bbox as Record<string, unknown> | undefined)?.y
      const key = `${section}:${n.pi}`
      if (Number.isInteger(n.pi) && (n.pi as number) >= 0 && typeof y === 'number' && Number.isFinite(y) && Math.abs(y) < 1e6 && !out.has(key) && out.size < FLOAT_LIMITS.paragraphs) {
        out.set(key, { section, para: n.pi as number, y })
      }
      return
    }
    if (Array.isArray(n.children)) for (const k of n.children) walk(k, depth + 1, section)
  }
  trees.forEach((t, page) => { const s = sections[page]; if (s !== undefined && s >= 0) walk(t, 0, s) })
  return [...out.values()]
}
