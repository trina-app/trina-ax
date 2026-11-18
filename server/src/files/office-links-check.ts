// Every finished Word / PowerPoint / Excel file make_file writes is checked here before it is saved (QA TC-4949),
// whoever wrote the part: pandoc, a team template (office-template.ts), or our own docx-format.ts header and footer.
// A link or reference may only leave the file for a web page (http, https) or a mail address (mailto); a place inside
// the document (#name) is fine. Anything else — file:, a network share \\host\share (which also hands the reader's
// Windows sign-in to that host), javascript:, a protocol handler (ms-word:, search-ms:, ms-msdt:), a relative path
// that escapes the document, a linked picture, an OLE object, a frame or a subdocument — is refused and nothing is
// saved. Word fields are held to the allow-list in office-rules.ts (page numbers, dates, references, a HYPERLINK to an
// allowed target), so no DDE, INCLUDE*, DATABASE, RD, ADDIN, MACROBUTTON or a field whose name is built by another
// field can stay. An attached template (a Word template's own, usually a path to Normal.dotm) is taken out, not
// refused, so the team's templates keep working.
// Every .rels and every XML part is read with saxes (namespaces resolved); a part that is not well-formed is refused.
// This runs only in the office worker (office-worker.ts), never in the server process, because the bytes are untrusted.
import { ToolError } from '../policy/errors'
import { allowedLinkTarget, fieldProblem } from './office-rules'
import { attrNS, dropElements, fieldCodes, relationshipsOf, REL_NS } from './office-xml'
import { checkZip, isZip } from './zip-guard'
import { readZip, writeZip, type ZipEntry } from './zip-write'

/** relationship types (their last path segment) that pull in or run outside content: refused even when internal-looking */
const OBJECT_RELS = new Set(['oleObject', 'package', 'control', 'activeXControl', 'activeXControlBinary', 'vbaProject', 'subDocument', 'frame', 'aFChunk'])
const ATTACHED_TEMPLATE = 'attachedTemplate'

/** a .rels part's own part (word/_rels/settings.xml.rels -> word/settings.xml) */
const ownerOf = (relsName: string) => relsName.replace(/(^|\/)_rels\/([^/]+)\.rels$/i, '$1$2')

/**
 * The finished package checked (see the head of this file). Returns the bytes, with an attached template taken out if
 * there was one. Throws a ToolError naming the first problem; the caller saves nothing then. `kind` only shapes the
 * refusal wording.
 */
export function checkOfficeLinks(kind: 'docx' | 'pptx' | 'xlsx', bytes: Uint8Array): Uint8Array {
  const what = `the ${kind === 'docx' ? 'Word' : kind === 'pptx' ? 'PowerPoint' : 'Excel'} file would contain`
  const fail = (part: string, why: string): never => { throw new ToolError(`${what}: ${part} ${why}; links may only go to web pages (http, https), mail addresses (mailto) or places inside the document; nothing was saved`) }
  if (!isZip(bytes)) throw new ToolError(`${what} is not a valid ${kind} file; nothing was saved`)
  try { checkZip(bytes) } catch (e) { throw new ToolError(`${what} could not be checked (${String((e as Error).message).slice(0, 120)}); nothing was saved`) }
  let entries: ZipEntry[]
  try { entries = readZip(bytes) } catch (e) { throw new ToolError(`${what} a damaged zip container (${String((e as Error).message).slice(0, 120)}); nothing was saved`) }
  const dec = new TextDecoder('utf-8', { fatal: false })
  /** .rels parts that hold an attached-template relationship, and the owner parts (word/settings.xml) that hold the element */
  const stripRels = new Set<string>()
  const stripOwners = new Set<string>()

  for (const e of entries) {
    if (!/\.rels$/i.test(e.name)) continue
    const xml = dec.decode(e.data)
    const owner = ownerOf(e.name)
    for (const r of relationshipsOf(xml, e.name, fail)) {
      if (r.type === ATTACHED_TEMPLATE) {
        // taken out below (the element in the owner part and this relationship), not refused
        stripRels.add(e.name)
        stripOwners.add(owner)
        continue
      }
      if (OBJECT_RELS.has(r.type)) fail(e.name, `refers to ${r.external ? 'a link to ' : ''}an embedded object, a frame or a subdocument (${r.type})`)
      if (r.external) {
        if (r.type !== 'hyperlink') fail(e.name, `refers to "${clip(r.target)}" outside the file (${r.type || 'a relationship'})`)
        if (!allowedLinkTarget(r.target) || r.target.startsWith('#')) fail(e.name, `has a link to "${clip(r.target)}"`)
      } else if (/^[a-z][a-z0-9+.-]*:|^[\\/]{2}|\\/i.test(r.target)) {
        fail(e.name, `refers to "${clip(r.target)}" outside the file`)
      }
    }
  }

  // Word fields in any XML part of a .docx (document, headers, footers, notes, numbering, glossary)
  if (kind === 'docx') {
    for (const e of entries) {
      if (/\.rels$/i.test(e.name) || !/^word\/.*\.xml$/i.test(e.name)) continue
      const xml = dec.decode(e.data)
      if (!/instrText|fldSimple/.test(xml)) continue
      for (const f of fieldCodes(xml, e.name, fail)) { const why = fieldProblem(f); if (why) fail(e.name, `has ${why}`) }
    }
  }

  if (!stripOwners.size) return bytes
  // take the attached template out: its relationship(s) in the .rels, and the w:attachedTemplate element in the owner
  const enc = new TextEncoder()
  for (const e of entries) {
    if (stripRels.has(e.name)) {
      const next = dropElements(dec.decode(e.data), e.name, fail, (t) => t.uri === REL_NS && t.local === 'Relationship' && (attrNS(t, '', 'Type') ?? '').trim().split('/').pop() === ATTACHED_TEMPLATE)
      e.data = enc.encode(next); delete e.raw; delete e.store
    } else if (stripOwners.has(e.name)) {
      const next = dropElements(dec.decode(e.data), e.name, fail, (t) => t.local === 'attachedTemplate')
      e.data = enc.encode(next); delete e.raw; delete e.store
    }
  }
  return writeZip(entries)
}

const clip = (s: string, n = 80) => {
  // eslint-disable-next-line no-control-regex
  const shown = s.replace(/[\x00-\x1f\x7f\p{Cf}]/gu, (ch) => `\\u{${ch.codePointAt(0)!.toString(16)}}`)
  return shown.length > n ? shown.slice(0, n) + '…' : shown
}

export const DOCX_LINK_CHECK_MODE = 'docx-link-check'
export const PPTX_LINK_CHECK_MODE = 'pptx-link-check'
export const XLSX_LINK_CHECK_MODE = 'xlsx-link-check'
export const linkCheckRequest = (kind: 'docx' | 'pptx' | 'xlsx') => (input: Uint8Array) => checkOfficeLinks(kind, input)
