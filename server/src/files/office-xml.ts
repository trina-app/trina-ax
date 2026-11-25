// Reading (and editing) the XML parts of an Office package with a real XML parser (saxes, namespaces resolved), so no
// quoting, spacing, prefix or ">" inside an attribute value can hide anything from the checks. Shared by the template
// check (office-template.ts) and the check of every finished Word / PowerPoint / Excel file (office-links-check.ts),
// both of which run only in the office worker, never in the server process. A ToolError names the first problem.
import { SaxesParser, type SaxesTagNS } from 'saxes'
import { ToolError } from '../policy/errors'
import { fieldProblem, type FieldCode } from './office-rules'

/** the WordprocessingML namespaces (transitional and strict) and the package relationships namespace */
export const W_NS = new Set(['http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'http://purl.oclc.org/ooxml/wordprocessingml/main'])
export const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'
/** a chart part by name, as PowerPoint, Word and Excel write it (ppt/charts/chart1.xml); with its content type below */
export const CHART_PART = /^(ppt|word|xl)\/charts\/chart\d+\.xml$/
export const CHART_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml'
const SVG_NS = 'http://www.w3.org/2000/svg'

export const badFile = (what: string, why: string): never => { throw new ToolError(`${what}: ${why}`) }

/**
 * Parses one XML part with saxes (namespaces resolved). A DTD (except a harmless one on an SVG root) or a part that is
 * not well-formed is refused: what a parser cannot vouch for is not copied. `fail(part, why)` throws.
 */
export function parseXml(xml: string, part: string, fail: (part: string, why: string) => never, on: { open?: (t: SaxesTagNS) => void; close?: (t: SaxesTagNS) => void; text?: (s: string) => void }): void {
  const p = new SaxesParser({ xmlns: true, position: false })
  let err: string | null = null
  let doctype: string | null = null
  let root: SaxesTagNS | null = null
  p.on('error', (e) => { err ??= e.message })
  p.on('doctype', (d) => { doctype = d })
  p.on('opentag', (t) => { root ??= t; on.open?.(t) })
  if (on.close) p.on('closetag', on.close)
  if (on.text) { p.on('text', on.text); p.on('cdata', on.text) }
  try { p.write(xml).close() } catch (e) { err ??= String((e as Error).message) }
  const d = doctype as string | null, r = root as SaxesTagNS | null
  if (d !== null && (d.includes('[') || !r || r.local !== 'svg' || r.uri !== SVG_NS || !svgDoctype(d))) err ??= 'a DTD'
  if (err) fail(part, `is not a well-formed XML part (${String(err).slice(0, 120)})`)
}
/** the W3C's own SVG 1.0 / 1.1 DTD, by its public id and its w3.org address, and nothing else (QA TC-4966) */
const SVG_DTD_IDS = new Set(['-//W3C//DTD SVG 20010904//EN', '-//W3C//DTD SVG 1.0//EN', '-//W3C//DTD SVG 1.1//EN'])
function svgDoctype(d: string): boolean {
  const m = /^\s*svg\s+PUBLIC\s+(["'])([^"']*)\1\s+(["'])([^"']*)\3\s*$/.exec(d)
  return !!m && SVG_DTD_IDS.has(m[2]!) && /^https?:\/\/www\.w3\.org\/[\w./-]+\.dtd$/.test(m[4]!)
}

/** an attribute by its namespace ('' for none) and local name, whatever its prefix */
export const attrNS = (t: SaxesTagNS, uri: string | Set<string>, local: string): string | undefined => {
  for (const a of Object.values(t.attributes)) if (a.local === local && (typeof uri === 'string' ? a.uri === uri : uri.has(a.uri))) return a.value
  return undefined
}

/**
 * Every field of a WordprocessingML part: complex fields (fldChar begin / instrText / separate / end) joined across
 * runs, with a note of whether another field is nested inside this one's code and whether one comes before or inside
 * its name; and simple fields (w:fldSimple w:instr). Another prefix for WordprocessingML hides nothing (namespaces).
 */
export function fieldCodes(xml: string, part: string, fail: (part: string, why: string) => never): FieldCode[] {
  const out: FieldCode[] = []
  const stack: { code: string; reading: boolean; nested: boolean; nameStarted: boolean; nestedName: boolean }[] = []
  let inInstr = 0
  const end = (f: (typeof stack)[number]) => { if (f.reading) { f.reading = false; out.push({ code: f.code, nested: f.nested, nestedName: f.nestedName }) } }
  parseXml(xml, part, fail, {
    open: (t) => {
      if (!W_NS.has(t.uri)) return
      const top = stack[stack.length - 1]
      if (t.local === 'instrText' || t.local === 'delInstrText') { if (!t.isSelfClosing) inInstr++; return }
      if (t.local === 'fldSimple') { const i = attrNS(t, W_NS, 'instr'); if (i !== undefined) out.push({ code: i, nested: false, nestedName: false }); if (top?.reading) top.nested = true; return }
      if (t.local !== 'fldChar') return
      const type = attrNS(t, W_NS, 'fldCharType')
      if (type === 'begin') {
        // a field opening inside the name of the field above (nothing but white space, quotes or backslashes read
        // yet, as in { "{QUOTE 68 68 69}" ... }): that name is built by a field
        if (top?.reading) { top.nested = true; if (!top.nameStarted) top.nestedName = true }
        stack.push({ code: '', reading: true, nested: false, nameStarted: false, nestedName: false })
      } else if (type === 'separate' && top) end(top)
      else if (type === 'end') { const f = stack.pop(); if (f) end(f) }
    },
    close: (t) => { if (W_NS.has(t.uri) && (t.local === 'instrText' || t.local === 'delInstrText') && !t.isSelfClosing) inInstr = Math.max(0, inInstr - 1) },
    text: (s) => { const top = stack[stack.length - 1]; if (inInstr && top?.reading) { top.code += s; if (/[^\s"\\]/.test(s)) top.nameStarted = true } },
  })
  for (const f of stack) end(f)
  return out
}

/** Every relationship of a .rels part: its type's last path segment, its target, and whether it points outside the file. */
export function relationshipsOf(xml: string, part: string, fail: (part: string, why: string) => never): { type: string; target: string; external: boolean }[] {
  const out: { type: string; target: string; external: boolean }[] = []
  parseXml(xml, part, fail, {
    open: (t) => {
      if (t.local !== 'Relationship') return
      if (t.uri !== REL_NS) fail(part, 'has a relationship in an unknown namespace')
      const type = (attrNS(t, '', 'Type') ?? '').trim().split('/').pop() ?? ''
      out.push({ type, target: attrNS(t, '', 'Target') ?? '', external: (attrNS(t, '', 'TargetMode') ?? '').trim().toLowerCase() === 'external' })
    },
  })
  return out
}

// tab, line feed and carriage return as character references: a parser turns them into spaces otherwise (attribute
// value normalisation), which would change a docVar value in a rebuilt settings.xml
const escAttr = (s: string) => s.replace(/[&<>"\t\n\r]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\t': '&#9;', '\n': '&#10;', '\r': '&#13;' })[c]!)
const escText = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!)

/**
 * The XML part again, with every element for which `drop(t)` is true left out together with its whole subtree.
 * Rebuilt from the parser's events (so it is well-formed by construction); attribute order and the kind of quotation
 * may change, which OOXML does not depend on. Used only to take an attached template out of settings.xml and its rels.
 */
export function dropElements(xml: string, part: string, fail: (part: string, why: string) => never, drop: (t: SaxesTagNS) => boolean): string {
  const parts: string[] = []
  let skipDepth = 0 // >0: inside a dropped subtree
  let depth = 0
  parseXml(xml, part, fail, {
    open: (t) => {
      depth++
      if (skipDepth) return
      if (drop(t)) { skipDepth = depth; return }
      let s = `<${t.name}`
      for (const a of Object.values(t.attributes)) s += ` ${a.name}="${escAttr(a.value)}"`
      parts.push(t.isSelfClosing ? s + '/>' : s + '>')
    },
    close: (t) => {
      if (skipDepth) { if (depth === skipDepth) skipDepth = 0; depth--; return }
      if (!t.isSelfClosing) parts.push(`</${t.name}>`)
      depth--
    },
    text: (s) => { if (!skipDepth) parts.push(escText(s)) },
  })
  const decl = /^\s*<\?xml[^?]*\?>/.exec(xml)?.[0] ?? '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  return decl + parts.join('')
}

/** UTF-16 (a byte order mark, or "<" with a zero byte next to it): Word always writes UTF-8, and a UTF-16 part would
 * not be scanned as text, so such a part is refused rather than skipped (security review of #1281) */
export const isUtf16 = (d: Uint8Array) => (d[0] === 0xff && d[1] === 0xfe) || (d[0] === 0xfe && d[1] === 0xff) || (d[0] === 0x3c && d[1] === 0x00) || (d[0] === 0x00 && d[1] === 0x3c)
/** UTF-32 (a byte order mark, or "<" as a 32-bit unit) in any part, whatever its name: never written by Office and not
 * scanned as text, so refused (review of #1341) */
const isUtf32 = (d: Uint8Array) => d.length >= 4 && [[0, 0, 0xfe, 0xff], [0xff, 0xfe, 0, 0], [0, 0, 0, 0x3c], [0x3c, 0, 0, 0]].some((p) => p.every((b, k) => d[k] === b))
/** fonts (.odttf is scrambled bytes), pictures and other binary parts may start with FF FE by chance: there a part
 * counts as UTF-16 text when, read as UTF-16 (little or big endian, after a byte order mark if there is one), its first
 * character that is not white space is "<" (QA TC-4966; white space before "<" is still XML, review of #1341) */
const BINARY_PART = /(^|\/)(fonts|media|embeddings)\/|\.(odttf|ttf|otf|bin|png|jpe?g|gif|bmp|tiff?|emf|wmf|svg)$/i
function utf16Text(d: Uint8Array): boolean {
  const opensWithTag = (le: boolean, from: number) => {
    for (let i = from; i + 1 < d.length; i += 2) {
      const u = le ? d[i]! | (d[i + 1]! << 8) : (d[i]! << 8) | d[i + 1]!
      if (u === 0x20 || u === 0x09 || u === 0x0a || u === 0x0d || u === 0xfeff) continue
      return u === 0x3c
    }
    return false
  }
  if (d[0] === 0xff && d[1] === 0xfe) return opensWithTag(true, 2)
  if (d[0] === 0xfe && d[1] === 0xff) return opensWithTag(false, 2)
  return opensWithTag(true, 0) || opensWithTag(false, 0)
}
/** why a part is refused as wide text Office never writes (UTF-32 anywhere; UTF-16, for a binary-named part only when
 * it reads as UTF-16 XML), or null */
export function wideTextProblem(name: string, d: Uint8Array): string | null {
  if (isUtf32(d)) return 'is UTF-32 text, which Office does not write in these files'
  if (BINARY_PART.test(name) ? utf16Text(d) : isUtf16(d)) return 'is UTF-16 text, which Office does not write in these files'
  return null
}
/** the part starts with "<" (after an optional UTF-8 byte order mark and white space): XML, or text pretending to be */
export function looksXml(d: Uint8Array): boolean {
  let i = d[0] === 0xef && d[1] === 0xbb && d[2] === 0xbf ? 3 : 0
  while (i < d.length && (d[i] === 0x20 || d[i] === 0x09 || d[i] === 0x0a || d[i] === 0x0d)) i++
  return d[i] === 0x3c
}

/**
 * The Word-field scan both checks use (the template check, office-template.ts, and the finished-file check,
 * office-links-check.ts), so they cannot differ: every part of the package, wherever it is and whatever its name
 * (_rels/.rels and [Content_Types].xml can put the main document or a header anywhere), UTF-16 refused, and every
 * part that starts with "<" (not a .rels) read for its fields. `problem(part, why)` is called for the first field
 * that is not allowed; `fail` for a part that cannot be read.
 */
export function scanWordFields(entries: { name: string; data: Uint8Array }[], fail: (part: string, why: string) => never, problem: (part: string, why: string, code: string) => never): void {
  for (const e of entries) {
    const wide = wideTextProblem(e.name, e.data)
    if (wide) fail(e.name, wide)
    if (/\.rels$/i.test(e.name) || !looksXml(e.data)) continue
    let xml: string
    try { xml = new TextDecoder('utf-8', { fatal: true }).decode(e.data) } catch { return fail(e.name, 'is not UTF-8 text') }
    for (const f of fieldCodes(xml, e.name, fail)) { const why = fieldProblem(f); if (why) problem(e.name, `has ${why}`, f.code) }
  }
}
