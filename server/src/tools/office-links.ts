// Links in the Word, PowerPoint, Excel and PDF files make_file writes (QA TC-4949; docs/decisions/20261118-docx-link-schemes.md).
// A link in an Office file opens whatever it points at when someone clicks it: file:///C:/...exe, a network share
// (\\host\share, which also hands the reader's Windows sign-in to that host), javascript:, a protocol handler such as
// ms-word:, search-ms: or ms-msdt:, or a relative path such as ..\..\x.exe next to wherever the file is saved.
// The only targets a file made here may carry are web pages (http, https), mail addresses (mailto) and places inside
// the document itself (#name).
// - In pandoc's tree of the Markdown (stripUnsafeLinks): any other link becomes its plain text (a Span with the same
//   words and attributes), and the AI is told which targets were dropped.
// - In the finished package (checkOfficePackage), whatever wrote it (pandoc, a team template from skills/, our own
//   docx-format.ts): every relationship that leaves the package must be a hyperlink to an allowed target, and every
//   Word field must be no HYPERLINK to anything else and none that pulls in outside content (DDE, INCLUDETEXT,
//   INCLUDEPICTURE, IMPORT, LINK). Anything else is refused and nothing is saved. The one exception is a Word
//   template's attached template (settings.xml -> attachedTemplate), which Word templates carry as a path on the
//   machine they were made on: it is removed, not refused, so the team's templates keep working.
import { readZip, writeZip, type ZipEntry } from '../files/zip-write'
import { checkZip } from '../files/zip-guard'
import { ToolError } from '../policy/errors'

// eslint-disable-next-line no-control-regex
const NOT_IN_URL = /[\s\x00-\x1f\x7f\\\p{Cf}]/u

/** A web page, a mail address or a place inside the document: the only link targets a file made here may carry. */
export function allowedLinkTarget(target: string): boolean {
  if (typeof target !== 'string' || NOT_IN_URL.test(target)) return false
  if (target.startsWith('#')) return !/[/%:]/.test(target)
  return /^https?:\/\/[^/?#]/i.test(target) || /^mailto:./i.test(target)
}

const clip = (s: string, n = 80) => (s.length > n ? s.slice(0, n) + '…' : s)
/** a target as it can be quoted to the AI: control and format characters shown, not acted on */
// eslint-disable-next-line no-control-regex
const shown = (s: string) => clip(s.replace(/[\x00-\x1f\x7f\p{Cf}]/gu, (ch) => `\\u{${ch.codePointAt(0)!.toString(16)}}`))

/**
 * Every Link node of pandoc's tree whose target is not allowed becomes a Span with the same attributes and words.
 * Walks the whole tree (metadata, footnotes, tables included), without recursion. Returns the dropped targets.
 */
export function stripUnsafeLinks(ast: unknown): string[] {
  const dropped: string[] = []
  const stack: unknown[] = [ast]
  while (stack.length) {
    const v = stack.pop()
    if (Array.isArray(v)) { for (const x of v) if (x && typeof x === 'object') stack.push(x); continue }
    if (!v || typeof v !== 'object') continue
    const node = v as { t?: unknown; c?: unknown }
    if (node.t === 'Link' && Array.isArray(node.c)) {
      const target = Array.isArray(node.c[2]) ? node.c[2][0] : undefined
      if (typeof target !== 'string' || !allowedLinkTarget(target)) {
        dropped.push(shown(String(target ?? '')))
        const attr = Array.isArray(node.c[0]) ? node.c[0] : ['', [], []]
        node.t = 'Span'
        node.c = [attr, Array.isArray(node.c[1]) ? node.c[1] : []]
      }
    }
    for (const x of Object.values(node)) if (x && typeof x === 'object') stack.push(x)
  }
  return dropped
}

/** XML text or attribute value as a reader sees it: entities and character references decoded, CDATA unwrapped. */
export function xmlText(s: string): string {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>|&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos);/gi, (m, cdata: string | undefined, ent: string | undefined) => {
    if (cdata !== undefined) return cdata
    const e = ent!.toLowerCase()
    if (e[0] === '#') {
      const n = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ''
    }
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[e]!
  })
}

function attrs(tag: string): Map<string, string> {
  const out = new Map<string, string>()
  // any namespace prefix: a template may write <r:Relationship r:Target=...>
  for (const m of tag.matchAll(/(?:^|\s)(?:[\w.-]+:)?([\w.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out.set(m[1]!.toLowerCase(), xmlText(m[2] ?? m[3] ?? ''))
  return out
}

/** Word fields that pull in content from outside the file (and DDE, which offers to run a program) */
const OUTSIDE_FIELDS = new Set(['DDE', 'DDEAUTO', 'INCLUDETEXT', 'INCLUDEPICTURE', 'INCLUDE', 'IMPORT', 'LINK'])

/** The words of a field code: "quoted text" or runs without spaces. */
function fieldWords(code: string): string[] {
  return [...code.matchAll(/"([^"]*)"?|(\S+)/g)].map((m) => m[1] ?? m[2]!)
}

/** Why a Word field code may not stay in a file made here, or null. `nested`: another field is part of its code. */
export function badField(code: string, nested = false): string | null {
  const words = fieldWords(code.replace(/\p{Cf}/gu, ''))
  const name = (words[0] ?? '').toUpperCase()
  if (OUTSIDE_FIELDS.has(name)) return `a ${name} field (it pulls in content from outside the file)`
  if (name !== 'HYPERLINK') return null
  if (nested) return 'a HYPERLINK field whose target is made by another field'
  for (let i = 1; i < words.length; i++) {
    const w = words[i]!
    if (/^\\[lot]$/i.test(w)) { i++; continue } // \l bookmark, \o tooltip, \t target frame: a value follows
    if (/^\\[a-z]$/i.test(w)) continue // \m, \n
    // Word reads a doubled backslash in a field's quoted text as one
    const target = w.replace(/\\\\/g, '\\')
    if (!allowedLinkTarget(target) || target.startsWith('#')) return `a HYPERLINK field to "${shown(target)}"`
  }
  return null
}

/** Every field code of one Word part: complex fields (fldChar begin / instrText / separate / end, nested) and simple ones. */
export function wordFieldCodes(xml: string): { code: string; nested: boolean }[] {
  const out: { code: string; nested: boolean }[] = []
  const stack: { code: string; nested: boolean; inCode: boolean }[] = []
  const done = (f: { code: string; nested: boolean; inCode: boolean }) => { if (f.inCode) { f.inCode = false; out.push({ code: f.code, nested: f.nested }) } }
  const re = /<(?:[\w.-]+:)?instrText\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:[\w.-]+:)?instrText\s*>)|<(?:[\w.-]+:)?(fldChar|fldSimple)\b([^>]*?)\/?>/g
  for (const m of xml.matchAll(re)) {
    const [, body, kind, rest] = m
    const top = stack[stack.length - 1]
    if (kind === undefined) { if (top?.inCode) top.code += xmlText(body ?? ''); continue }
    const a = attrs(rest!)
    if (kind === 'fldSimple') {
      if (top?.inCode) top.nested = true
      out.push({ code: a.get('instr') ?? '', nested: false })
      continue
    }
    const type = a.get('fldchartype')
    if (type === 'begin') { if (top?.inCode) top.nested = true; stack.push({ code: '', nested: false, inCode: true }) }
    else if (type === 'separate' && top) done(top)
    else if (type === 'end' && top) { done(top); stack.pop() }
  }
  for (const f of stack) done(f)
  return out
}

const REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/'

/**
 * The finished .docx / .pptx / .xlsx checked for links that leave the file (see the head of this file). Returns the
 * bytes, with a Word attached template taken out when there was one (`changed`). Throws a ToolError naming the first
 * problem; nothing is saved then.
 */
export function checkOfficePackage(bytes: Uint8Array, format: 'docx' | 'pptx' | 'xlsx', from = 'the file'): { bytes: Uint8Array; changed: boolean } {
  const refuse = (why: string): never => { throw new ToolError(`${from} would contain ${why}; links may only go to web pages (http, https), mail addresses (mailto) or places inside the document; nothing was saved`) }
  let entries: ZipEntry[]
  try { checkZip(bytes); entries = readZip(bytes) } catch (e) {
    throw new ToolError(`the converter wrote a ${format} file that could not be checked (${clip(String((e as Error).message), 120)}); nothing was saved`)
  }
  const dec = new TextDecoder()
  const enc = new TextEncoder()
  let changed = false
  /** relationships removed, by the part they belong to (word/settings.xml) */
  const removedIds = new Map<string, string[]>()
  for (const e of entries) {
    if (!/\.rels$/i.test(e.name)) continue
    const xml = dec.decode(e.data)
    let edited = false
    const next = xml.replace(/<(?:[\w.-]+:)?Relationship\b([^>]*?)\/?>(?:\s*<\/(?:[\w.-]+:)?Relationship>)?/g, (tag, rest: string) => {
      const a = attrs(rest)
      const type = (a.get('type') ?? '').trim()
      const target = a.get('target') ?? ''
      const external = (a.get('targetmode') ?? '').trim().toLowerCase() === 'external'
      // a Word template's own template (often C:\Users\...\Normal.dotm): taken out, not refused
      if (format === 'docx' && type === REL_TYPE + 'attachedTemplate') {
        const owner = e.name.replace(/(^|\/)_rels\/([^/]+)\.rels$/i, '$1$2')
        removedIds.set(owner, [...(removedIds.get(owner) ?? []), a.get('id') ?? ''])
        edited = true
        return ''
      }
      if (external) {
        if (type !== REL_TYPE + 'hyperlink') refuse(`a reference to "${shown(target)}" outside the file (${clip(type.slice(type.lastIndexOf('/') + 1), 40) || 'unknown kind'})`)
        if (!allowedLinkTarget(target) || target.startsWith('#')) refuse(`a link to "${shown(target)}"`)
      } else if (/^[a-z][a-z0-9+.-]*:|^[\\/]{2}|\\/i.test(target)) {
        refuse(`a reference to "${shown(target)}" outside the file`)
      }
      return tag
    })
    if (edited) { e.data = enc.encode(next); delete e.raw; delete e.store; changed = true }
  }
  for (const [owner, ids] of removedIds) {
    const part = entries.find((x) => x.name === owner)
    if (!part) continue
    const xml = dec.decode(part.data)
    const next = xml.replace(/<(?:[\w.-]+:)?attachedTemplate\b[^>]*?(?:\/>|>[\s\S]*?<\/(?:[\w.-]+:)?attachedTemplate>)/g, (tag) => {
      const id = attrs(tag.slice(tag.indexOf(' '))).get('id')
      return id === undefined || ids.includes(id) ? '' : tag
    })
    if (next !== xml) { part.data = enc.encode(next); delete part.raw; delete part.store }
  }
  if (format === 'docx') {
    for (const e of entries) {
      if (!/^word\/.*\.xml$/i.test(e.name)) continue
      const xml = dec.decode(e.data)
      if (!/(?:instrText|fldSimple)\b/.test(xml)) continue
      for (const f of wordFieldCodes(xml)) { const why = badField(f.code, f.nested); if (why) refuse(why) }
    }
  }
  return { bytes: changed ? writeZip(entries) : bytes, changed }
}
