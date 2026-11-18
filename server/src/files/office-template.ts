// A .docx / .pptx make_file uses as its template (pandoc --reference-doc; docs/decisions/20261118-any-file-template.md,
// QA TC-4948). Pandoc carries the template's headers, footers, settings, masters and layouts into the new file as they
// are, so whatever runs or fetches something in them would end up in every file made from it. Since any file the
// person can read may be a template, such a file is refused (nothing is stripped: the person learns which template is
// unsafe and why):
// - a Word field that runs or fetches something (DDE, DDEAUTO, INCLUDETEXT, INCLUDEPICTURE, INCLUDE, IMPORT, LINK,
//   DATABASE, MACROBUTTON, ...), as a complex field (w:instrText, a field's pieces joined) or a simple one
//   (w:fldSimple w:instr), in any XML part under word/ (document, headers, footers, notes, glossary);
// - a relationship to something outside the file (TargetMode="External": an attached template, a linked picture, an
//   OLE object, a frame, a subdocument, ...) other than a plain hyperlink, in any .rels part;
// - an embedded object or control (oleObject, package, control, ActiveX) and macros (vbaProject.bin).
// The template is untrusted, so this runs only in the office worker (office-worker.ts), never in the server process.
import { ToolError } from '../policy/errors'
import { attr, tags, unescapeXml } from './ooxml'
import { checkZip, isZip } from './zip-guard'
import { readZip } from './zip-write'

export const DOCX_TEMPLATE_CHECK_MODE = 'docx-template-check'
export const PPTX_TEMPLATE_CHECK_MODE = 'pptx-template-check'

/** Word fields that run something or read from outside the document */
export const UNSAFE_FIELDS = new Set(['DDE', 'DDEAUTO', 'INCLUDETEXT', 'INCLUDEPICTURE', 'INCLUDE', 'IMPORT', 'LINK', 'DATABASE', 'MACROBUTTON', 'AUTOTEXTLIST', 'PRIVATE', 'ADDIN', 'EMBED', 'SHAPE'])
/** relationship types (their last path segment) that hold or run an object */
const OBJECT_RELS = new Set(['oleObject', 'package', 'control', 'activeXControl', 'activeXControlBinary', 'vbaProject', 'attachedTemplate', 'subDocument', 'frame'])

const bad = (what: string, why: string): never => { throw new ToolError(`this ${what} cannot be used as a template: ${why}. Use another file, or no template`) }

/** The first word of each field instruction of a WordprocessingML part (complex fields joined across runs, simple ones). */
export function fieldWords(xml: string): string[] {
  const out: string[] = []
  /** the open complex fields (nested ones too): their instruction so far, and whether it is still being read */
  const open: { s: string; reading: boolean }[] = []
  let inInstr = false
  let last = 0
  for (const t of tags(xml)) {
    const top = open[open.length - 1]
    if (inInstr && top?.reading) top.s += unescapeXml(xml.slice(last, t.start))
    last = t.end
    if (t.name === 'w:instrText' || t.name === 'w:delInstrText') { inInstr = !t.close && !t.selfClose; continue }
    if (t.name === 'w:fldSimple' && !t.close) { const i = attr(t.head, 'w:instr'); if (i !== undefined) out.push(i) }
    if (t.name === 'w:fldChar' && !t.close) {
      const type = attr(t.head, 'w:fldCharType')
      if (type === 'begin') open.push({ s: '', reading: true })
      else if (type === 'separate' && top?.reading) { top.reading = false; out.push(top.s) }
      else if (type === 'end') { const f = open.pop(); if (f?.reading) out.push(f.s) }
    }
  }
  // a field never ended still counts
  for (const f of open) if (f.reading) out.push(f.s)
  return out.map((f) => f.replace(/^[\s\\"]+/, '').split(/[\s\\"]/)[0]!.toUpperCase()).filter(Boolean)
}

export function checkOfficeTemplate(kind: 'docx' | 'pptx', bytes: Uint8Array): void {
  const what = kind === 'docx' ? 'Word file' : 'PowerPoint file'
  if (!isZip(bytes)) bad(what, 'it is not a zip container')
  checkZip(bytes)
  let entries: ReturnType<typeof readZip>
  try { entries = readZip(bytes) } catch { return bad(what, 'its zip container is damaged') }
  const text = (d: Uint8Array) => { try { return new TextDecoder('utf-8', { fatal: true }).decode(d) } catch { return bad(what, 'a part is not UTF-8 text') } }
  for (const e of entries) {
    if (/vbaProject\.bin$/i.test(e.name)) bad(what, 'it holds macros')
    if (/(^|\/)(embeddings|activeX)\//i.test(e.name)) bad(what, `it holds an embedded object or control (${e.name})`)
    if (/\.rels$/i.test(e.name)) {
      for (const m of text(e.data).matchAll(/<Relationship\b[^>]*>/g)) {
        const type = (/\bType="([^"]*)"/.exec(m[0])?.[1] ?? '').split('/').pop() ?? ''
        const external = /\bTargetMode="External"/i.test(m[0])
        if (OBJECT_RELS.has(type)) bad(what, `it holds ${external ? 'a link to' : ''} an embedded object, a frame, a subdocument or an attached template (${type} in ${e.name})`)
        if (external && type !== 'hyperlink') bad(what, `it refers to something outside the file (${type} in ${e.name}), which would be fetched when a new file is opened`)
      }
    }
    if (kind === 'docx' && /^word\/.*\.xml$/i.test(e.name)) {
      const x = text(e.data)
      if (!x.includes('instr')) continue
      const hit = fieldWords(x).find((w) => UNSAFE_FIELDS.has(w))
      if (hit) bad(what, `${e.name} has a ${hit} field, which runs or fetches something when the file is opened`)
    }
  }
}

/** The office worker's modes: the template's bytes in, "ok" out (or the refusal). */
export const docxTemplateCheckRequest = (input: Uint8Array) => { checkOfficeTemplate('docx', input); return new TextEncoder().encode('ok') }
export const pptxTemplateCheckRequest = (input: Uint8Array) => { checkOfficeTemplate('pptx', input); return new TextEncoder().encode('ok') }
