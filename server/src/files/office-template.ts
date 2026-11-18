// A .docx / .pptx make_file uses as its template (pandoc --reference-doc; docs/decisions/20261118-any-file-template.md,
// QA TC-4948). Pandoc carries the template's headers, footers, settings, masters and layouts into the new file as they
// are, so whatever runs or fetches something in them would end up in every file made from it. Since any file the
// person can read may be a template, such a file is refused (nothing but an attached template is stripped: the person
// learns which template is unsafe and why):
// - a Word field not on the allow-list in office-rules.ts (DDE, DDEAUTO, INCLUDETEXT, INCLUDEPICTURE, INCLUDE, IMPORT,
//   LINK, DATABASE, RD, MACROBUTTON, ADDIN, ...), complex (w:instrText, joined) or simple (w:fldSimple w:instr), in any
//   XML part of the package wherever it is (document, headers, footers, notes, glossary), or a HYPERLINK to a bad target;
// - a relationship to something outside the file (TargetMode="External": a linked picture, an OLE object, a frame, a
//   subdocument, ...) other than a plain hyperlink to a web or mail address, in any .rels part;
// - an embedded object or control (oleObject, package, control, ActiveX) and macros (vbaProject.bin).
// An attached template (settings.xml w:attachedTemplate, usually a path to Normal.dotm on the machine that made the
// file) is taken OUT, not refused: real Word templates carry one, and the new file does not need it. The stripped bytes
// are returned and used as the template.
// Every .rels part and every XML part of a .docx is read with saxes (namespaces resolved): any quoting, spacing, prefix
// or ">" in an attribute value is seen for what it is, and a part that is not well-formed or has a DTD is refused.
// The template is untrusted, so this runs only in the office worker (office-worker.ts), never in the server process.
import { ToolError } from '../policy/errors'
import { fieldProblem, UNSAFE_FIELDS } from './office-rules'
import { attrNS, dropElements, fieldCodes, relationshipsOf, REL_NS } from './office-xml'
import { checkZip, isZip } from './zip-guard'
import { readZip, writeZip, type ZipEntry } from './zip-write'

export const DOCX_TEMPLATE_CHECK_MODE = 'docx-template-check'
export const PPTX_TEMPLATE_CHECK_MODE = 'pptx-template-check'
export { UNSAFE_FIELDS }

/** relationship types (their last path segment) that hold or run an object, pull in other content or a subdocument */
const OBJECT_RELS = new Set(['oleObject', 'package', 'control', 'activeXControl', 'activeXControlBinary', 'vbaProject', 'subDocument', 'frame', 'aFChunk'])
const ATTACHED_TEMPLATE = 'attachedTemplate'

const bad = (what: string, why: string): never => { throw new ToolError(`this ${what} cannot be used as a template: ${why}. Use another file, or no template`) }

/** The names of the fields of a WordprocessingML part (complex joined across runs and nested, simple), upper case.
 * Kept for the template tests; the check itself uses fieldCodes + fieldProblem. */
export function fieldWords(xml: string, part = 'part', what = 'file'): string[] {
  const fail = (p: string, why: string): never => bad(what, `${p} ${why}`)
  return fieldCodes(xml, part, fail).map((f) => (f.code.replace(/^[\s\\"]+/, '').split(/[\s\\"]/)[0] ?? '').toUpperCase()).filter(Boolean)
}

/** Every relationship of a .rels part: its type's last path segment and whether it points outside the file. */
export function relationships(xml: string, part = 'part', what = 'file'): { type: string; target: string; external: boolean }[] {
  const fail = (p: string, why: string): never => bad(what, `${p} ${why}`)
  return relationshipsOf(xml, part, fail)
}

/** UTF-16 (a byte order mark, or "<" with a zero byte next to it): Word always writes UTF-8, and a UTF-16 part would
 * not be scanned as text, so such a part is refused rather than skipped (security review) */
const utf16 = (d: Uint8Array) => (d[0] === 0xff && d[1] === 0xfe) || (d[0] === 0xfe && d[1] === 0xff) || (d[0] === 0x3c && d[1] === 0x00) || (d[0] === 0x00 && d[1] === 0x3c)
/** the part starts with "<" (after an optional UTF-8 byte order mark and white space): XML, or text pretending to be */
function looksXml(d: Uint8Array): boolean {
  let i = d[0] === 0xef && d[1] === 0xbb && d[2] === 0xbf ? 3 : 0
  while (i < d.length && (d[i] === 0x20 || d[i] === 0x09 || d[i] === 0x0a || d[i] === 0x0d)) i++
  return d[i] === 0x3c
}
const ownerOf = (relsName: string) => relsName.replace(/(^|\/)_rels\/([^/]+)\.rels$/i, '$1$2')

/** Checks the template and returns its bytes with any attached template taken out (the bytes to hand to pandoc). */
export function checkOfficeTemplate(kind: 'docx' | 'pptx', bytes: Uint8Array): Uint8Array {
  const what = kind === 'docx' ? 'Word file' : 'PowerPoint file'
  const fail = (part: string, why: string): never => bad(what, `${part} ${why}`)
  if (!isZip(bytes)) bad(what, 'it is not a zip container')
  checkZip(bytes)
  let entries: ZipEntry[]
  try { entries = readZip(bytes) } catch { return bad(what, 'its zip container is damaged') }
  const seen = new Set<string>()
  const text = (d: Uint8Array) => { try { return new TextDecoder('utf-8', { fatal: true }).decode(d) } catch { return bad(what, 'a part is not UTF-8 text') } }
  const stripRels = new Set<string>()
  const stripOwners = new Set<string>()
  for (const e of entries) {
    const lower = e.name.toLowerCase()
    if (seen.has(lower)) bad(what, `its zip container has two parts named ${e.name.slice(0, 80)}`)
    seen.add(lower)
    if (/vbaProject\.bin$/i.test(e.name)) bad(what, 'it holds macros')
    if (/(^|\/)(embeddings|activeX)\//i.test(e.name)) bad(what, `it holds an embedded object or control (${e.name})`)
    if (/\.rels$/i.test(e.name)) {
      for (const r of relationshipsOf(text(e.data), e.name, fail)) {
        if (r.type === ATTACHED_TEMPLATE) { stripRels.add(e.name); stripOwners.add(ownerOf(e.name)); continue }
        if (OBJECT_RELS.has(r.type)) bad(what, `it holds ${r.external ? 'a link to ' : ''}an embedded object, a frame or a subdocument (${r.type} in ${e.name})`)
        if (r.external && (r.type !== 'hyperlink')) bad(what, `it refers to something outside the file (${r.type || 'a relationship'} in ${e.name}), which would be fetched when a new file is opened`)
      }
    }
    // every XML part, wherever it is and whatever its name: _rels/.rels and [Content_Types].xml can put the main
    // document or a header anywhere in the package (security review); a part is XML when it starts with "<"
    if (utf16(e.data)) bad(what, `${e.name} is UTF-16 text, which Office does not write in these files`)
    if (kind === 'docx' && !/\.rels$/i.test(e.name) && looksXml(e.data)) {
      for (const f of fieldCodes(text(e.data), e.name, fail)) {
        const why = fieldProblem(f)
        if (why) bad(what, `${e.name} has ${why}`)
      }
    }
  }
  if (!stripOwners.size) return bytes
  const dec = new TextDecoder()
  const enc = new TextEncoder()
  for (const e of entries) {
    if (stripRels.has(e.name)) {
      e.data = enc.encode(dropElements(dec.decode(e.data), e.name, fail, (t) => t.uri === REL_NS && t.local === 'Relationship' && (attrNS(t, '', 'Type') ?? '').trim().split('/').pop() === ATTACHED_TEMPLATE))
      delete e.raw; delete e.store
    } else if (stripOwners.has(e.name)) {
      e.data = enc.encode(dropElements(dec.decode(e.data), e.name, fail, (t) => t.local === ATTACHED_TEMPLATE))
      delete e.raw; delete e.store
    }
  }
  return writeZip(entries)
}

/** The office worker's modes: the template's bytes in, the bytes to use (attached template taken out) out, or the refusal. */
export const docxTemplateCheckRequest = (input: Uint8Array) => checkOfficeTemplate('docx', input)
export const pptxTemplateCheckRequest = (input: Uint8Array) => checkOfficeTemplate('pptx', input)
