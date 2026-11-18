// A .docx / .pptx make_file uses as its template (pandoc --reference-doc; docs/decisions/20261118-any-file-template.md,
// QA TC-4948). Pandoc carries the template's headers, footers, settings, masters and layouts into the new file as they
// are, so whatever runs or fetches something in them would end up in every file made from it. Since any file the
// person can read may be a template, such a file is refused (nothing is stripped: the person learns which template is
// unsafe and why):
// - a Word field that runs or fetches something (DDE, DDEAUTO, INCLUDETEXT, INCLUDEPICTURE, INCLUDE, IMPORT, LINK,
//   DATABASE, MACROBUTTON, ...), as a complex field (w:instrText, a field's pieces joined) or a simple one
//   (w:fldSimple w:instr), in any XML part of the package wherever it is (document, headers, footers, notes, glossary);
// - a relationship to something outside the file (TargetMode="External": an attached template, a linked picture, an
//   OLE object, a frame, a subdocument, ...) other than a plain hyperlink, in any .rels part;
// - an embedded object or control (oleObject, package, control, ActiveX) and macros (vbaProject.bin).
// Every .rels part and every XML part of a .docx is read with saxes (namespaces resolved): any quoting, spacing or prefix
// is seen for what it is, and a part that is not well-formed or has a DTD is refused.
// The template is untrusted, so this runs only in the office worker (office-worker.ts), never in the server process.
import { SaxesParser, type SaxesTagNS } from 'saxes'
import { ToolError } from '../policy/errors'
import { checkZip, isZip } from './zip-guard'
import { readZip } from './zip-write'

export const DOCX_TEMPLATE_CHECK_MODE = 'docx-template-check'
export const PPTX_TEMPLATE_CHECK_MODE = 'pptx-template-check'

/** Word fields that run something or read from outside the document */
export const UNSAFE_FIELDS = new Set(['DDE', 'DDEAUTO', 'INCLUDETEXT', 'INCLUDEPICTURE', 'INCLUDE', 'IMPORT', 'LINK', 'DATABASE', 'MACROBUTTON', 'AUTOTEXTLIST', 'PRIVATE', 'ADDIN', 'EMBED', 'SHAPE'])
/** relationship types (their last path segment) that hold or run an object, pull in other content or attach a template */
const OBJECT_RELS = new Set(['oleObject', 'package', 'control', 'activeXControl', 'activeXControlBinary', 'vbaProject', 'attachedTemplate', 'subDocument', 'frame', 'aFChunk'])
/** the WordprocessingML namespaces (transitional and strict) and the package relationships namespace */
const W_NS = new Set(['http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'http://purl.oclc.org/ooxml/wordprocessingml/main'])
const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'
const SVG_NS = 'http://www.w3.org/2000/svg'

const bad = (what: string, why: string): never => { throw new ToolError(`this ${what} cannot be used as a template: ${why}. Use another file, or no template`) }

/**
 * Parses one XML part with saxes (namespaces resolved, so any prefix and either quoting of attributes is seen as what
 * it is). A DTD or a part that is not well-formed is refused: what a parser cannot vouch for is not copied.
 */
function parse(xml: string, part: string, what: string, on: { open?: (t: SaxesTagNS) => void; close?: (t: SaxesTagNS) => void; text?: (s: string) => void }): void {
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
  // a DTD is refused, but for a picture: SVG exports (Inkscape, Illustrator) carry <!DOCTYPE svg PUBLIC ...>. Allowed
  // only on an SVG root and without an internal subset ("["), so it declares no entity; nothing fetches the DTD
  const d = doctype as string | null, r = root as SaxesTagNS | null
  if (d !== null && (d.includes('[') || !r || r.local !== 'svg' || r.uri !== SVG_NS || !svgDoctype(d))) err ??= 'a DTD'
  if (err) bad(what, `${part} is not a well-formed XML part (${String(err).slice(0, 120)})`)
}
/** the W3C's own SVG 1.0 / 1.1 DTD, by its public id and its w3.org address, and nothing else (QA TC-4966) */
const SVG_DTD_IDS = new Set(['-//W3C//DTD SVG 20010904//EN', '-//W3C//DTD SVG 1.0//EN', '-//W3C//DTD SVG 1.1//EN'])
function svgDoctype(d: string): boolean {
  const m = /^\s*svg\s+PUBLIC\s+(["'])([^"']*)\1\s+(["'])([^"']*)\3\s*$/.exec(d)
  return !!m && SVG_DTD_IDS.has(m[2]!) && /^https?:\/\/www\.w3\.org\/[\w./-]+\.dtd$/.test(m[4]!)
}
/** an attribute by its namespace ('' for none) and local name, whatever its prefix */
const attrNS = (t: SaxesTagNS, uri: string | Set<string>, local: string): string | undefined => {
  for (const a of Object.values(t.attributes)) if (a.local === local && (typeof uri === 'string' ? a.uri === uri : uri.has(a.uri))) return a.value
  return undefined
}

/** The first word of each field instruction of a WordprocessingML part (complex fields joined across runs and nested
 * ones, simple ones), by namespace, so another prefix for WordprocessingML hides nothing. */
export function fieldWords(xml: string, part = 'part', what = 'file'): string[] {
  const out: string[] = []
  const open: { s: string; reading: boolean }[] = []
  let inInstr = 0
  parse(xml, part, what, {
    open: (t) => {
      if (!W_NS.has(t.uri)) return
      if (t.local === 'instrText' || t.local === 'delInstrText') { if (!t.isSelfClosing) inInstr++; return }
      if (t.local === 'fldSimple') { const i = attrNS(t, W_NS, 'instr'); if (i !== undefined) out.push(i); return }
      if (t.local === 'fldChar') {
        const top = open[open.length - 1]
        const type = attrNS(t, W_NS, 'fldCharType')
        if (type === 'begin') open.push({ s: '', reading: true })
        else if (type === 'separate' && top?.reading) { top.reading = false; out.push(top.s) }
        else if (type === 'end') { const f = open.pop(); if (f?.reading) out.push(f.s) }
      }
    },
    close: (t) => { if (W_NS.has(t.uri) && (t.local === 'instrText' || t.local === 'delInstrText') && !t.isSelfClosing) inInstr = Math.max(0, inInstr - 1) },
    text: (s) => { const top = open[open.length - 1]; if (inInstr && top?.reading) top.s += s },
  })
  // a field never ended still counts
  for (const f of open) if (f.reading) out.push(f.s)
  return out.map((f) => f.replace(/^[\s\\"]+/, '').split(/[\s\\"]/)[0]!.toUpperCase()).filter(Boolean)
}

/** Every relationship of a .rels part: its type's last path segment and whether it points outside the file. */
export function relationships(xml: string, part = 'part', what = 'file'): { type: string; external: boolean }[] {
  const out: { type: string; external: boolean }[] = []
  parse(xml, part, what, {
    open: (t) => {
      if (t.local !== 'Relationship') return
      // a relationship in another namespace is not one Office reads; refused rather than guessed about
      if (t.uri !== REL_NS) bad(what, `${part} has a relationship in an unknown namespace`)
      const type = (attrNS(t, '', 'Type') ?? '').trim().split('/').pop() ?? ''
      out.push({ type, external: (attrNS(t, '', 'TargetMode') ?? '').trim().toLowerCase() === 'external' })
    },
  })
  return out
}

/** UTF-16 (a byte order mark, or "<" with a zero byte next to it): Word always writes UTF-8, and a UTF-16 part would
 * not be scanned as text, so such a part is refused rather than skipped (security review) */
const utf16 = (d: Uint8Array) => (d[0] === 0xff && d[1] === 0xfe) || (d[0] === 0xfe && d[1] === 0xff) || (d[0] === 0x3c && d[1] === 0x00) || (d[0] === 0x00 && d[1] === 0x3c)
/** fonts (.odttf is scrambled bytes), pictures and other binary parts may start with FF FE by chance: there only a
 * byte order mark followed by "<" counts as UTF-16 text (QA TC-4966) */
const BINARY_PART = /(^|\/)(fonts|media|embeddings)\/|\.(odttf|ttf|otf|bin|png|jpe?g|gif|bmp|tiff?|emf|wmf|svg)$/i
const utf16Text = (d: Uint8Array) => (d[0] === 0xff && d[1] === 0xfe && d[2] === 0x3c && d[3] === 0x00) || (d[0] === 0xfe && d[1] === 0xff && d[2] === 0x00 && d[3] === 0x3c) || (d[0] === 0x3c && d[1] === 0x00) || (d[0] === 0x00 && d[1] === 0x3c)
/** the part starts with "<" (after an optional UTF-8 byte order mark and white space): XML, or text pretending to be */
function looksXml(d: Uint8Array): boolean {
  let i = d[0] === 0xef && d[1] === 0xbb && d[2] === 0xbf ? 3 : 0
  while (i < d.length && (d[i] === 0x20 || d[i] === 0x09 || d[i] === 0x0a || d[i] === 0x0d)) i++
  return d[i] === 0x3c
}

export function checkOfficeTemplate(kind: 'docx' | 'pptx', bytes: Uint8Array): void {
  const what = kind === 'docx' ? 'Word file' : 'PowerPoint file'
  if (!isZip(bytes)) bad(what, 'it is not a zip container')
  checkZip(bytes)
  let entries: ReturnType<typeof readZip>
  try { entries = readZip(bytes) } catch { return bad(what, 'its zip container is damaged') }
  const seen = new Set<string>()
  const text = (d: Uint8Array) => { try { return new TextDecoder('utf-8', { fatal: true }).decode(d) } catch { return bad(what, 'a part is not UTF-8 text') } }
  for (const e of entries) {
    const lower = e.name.toLowerCase()
    if (seen.has(lower)) bad(what, `its zip container has two parts named ${e.name.slice(0, 80)}`)
    seen.add(lower)
    if (/vbaProject\.bin$/i.test(e.name)) bad(what, 'it holds macros')
    if (/(^|\/)(embeddings|activeX)\//i.test(e.name)) bad(what, `it holds an embedded object or control (${e.name})`)
    if (/\.rels$/i.test(e.name)) {
      for (const r of relationships(text(e.data), e.name, what)) {
        if (OBJECT_RELS.has(r.type)) bad(what, `it holds ${r.external ? 'a link to ' : ''}an embedded object, a frame, a subdocument, an included document or an attached template (${r.type} in ${e.name})`)
        if (r.external && r.type !== 'hyperlink') bad(what, `it refers to something outside the file (${r.type || 'a relationship'} in ${e.name}), which would be fetched when a new file is opened`)
      }
    }
    // every XML part, wherever it is and whatever its name: _rels/.rels and [Content_Types].xml can put the main
    // document or a header anywhere in the package (security review); a part is XML when it starts with "<"
    if (BINARY_PART.test(e.name) ? utf16Text(e.data) : utf16(e.data)) bad(what, `${e.name} is UTF-16 text, which Office does not write in these files`)
    if (kind === 'docx' && !/\.rels$/i.test(e.name) && looksXml(e.data)) {
      const hit = fieldWords(text(e.data), e.name, what).find((w) => UNSAFE_FIELDS.has(w))
      if (hit) bad(what, `${e.name} has a ${hit} field, which runs or fetches something when the file is opened`)
    }
  }
}

/** The office worker's modes: the template's bytes in, "ok" out (or the refusal). */
export const docxTemplateCheckRequest = (input: Uint8Array) => { checkOfficeTemplate('docx', input); return new TextEncoder().encode('ok') }
export const pptxTemplateCheckRequest = (input: Uint8Array) => { checkOfficeTemplate('pptx', input); return new TextEncoder().encode('ok') }
