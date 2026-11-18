// Reading (and editing) the XML parts of an Office package with a real XML parser (saxes, namespaces resolved), so no
// quoting, spacing, prefix or ">" inside an attribute value can hide anything from the checks. Shared by the template
// check (office-template.ts) and the check of every finished Word / PowerPoint / Excel file (office-links-check.ts),
// both of which run only in the office worker, never in the server process. A ToolError names the first problem.
import { SaxesParser, type SaxesTagNS } from 'saxes'
import { ToolError } from '../policy/errors'
import type { FieldCode } from './office-rules'

/** the WordprocessingML namespaces (transitional and strict) and the package relationships namespace */
export const W_NS = new Set(['http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'http://purl.oclc.org/ooxml/wordprocessingml/main'])
export const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'
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
  if (d !== null && (d.includes('[') || !r || r.local !== 'svg' || r.uri !== SVG_NS)) err ??= 'a DTD'
  if (err) fail(part, `is not a well-formed XML part (${String(err).slice(0, 120)})`)
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
        // a field opening inside the name of the field above (nothing but white space read yet): that name is built by a field
        if (top?.reading) { top.nested = true; if (!top.nameStarted) top.nestedName = true }
        stack.push({ code: '', reading: true, nested: false, nameStarted: false, nestedName: false })
      } else if (type === 'separate' && top) end(top)
      else if (type === 'end') { const f = stack.pop(); if (f) end(f) }
    },
    close: (t) => { if (W_NS.has(t.uri) && (t.local === 'instrText' || t.local === 'delInstrText') && !t.isSelfClosing) inInstr = Math.max(0, inInstr - 1) },
    text: (s) => { const top = stack[stack.length - 1]; if (inInstr && top?.reading) { top.code += s; if (s.trim()) top.nameStarted = true } },
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

const escAttr = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
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
