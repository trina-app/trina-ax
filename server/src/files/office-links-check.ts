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
import crypto from 'node:crypto'
import { ToolError } from '../policy/errors'
import { allowedLinkTarget } from './office-rules'
import { attrNS, CHART_CONTENT_TYPE, CHART_PART, dropElements, looksXml, parseXml, relationshipsOf, REL_NS, scanWordFields } from './office-xml'
import { checkZip, isZip } from './zip-guard'
import { readZip, writeZip, type ZipEntry } from './zip-write'

/** relationship types (their last path segment) that pull in or run outside content: refused even when internal-looking */
const OBJECT_RELS = new Set(['oleObject', 'package', 'control', 'activeXControl', 'activeXControlBinary', 'vbaProject', 'subDocument', 'frame', 'aFChunk'])
const ATTACHED_TEMPLATE = 'attachedTemplate'
/** where a chart's data workbook sits: an .xlsx in the embeddings folder beside the charts (never .xls / .bin / .xlsm) */
const CHART_WORKBOOK = /^(ppt|word|xl)\/embeddings\/[^/]+\.xlsx$/
/** a chart's relationship target that is a plain relative path: no scheme, share, rooted path, backslash, escape, query,
 * fragment or white space (a reader may cut the name at ? or # and open another part) */
const PLAIN_TARGET = /^(?![./]*\/\/)(?!\/)[^:\\%?#\s]+$/
/** chart data workbooks checked in one scan, at most, and their bytes together */
export const CHART_WORKBOOKS_MAX = 500
export const CHART_WORKBOOK_BYTES_MAX = 64 * 1024 * 1024
const CHART_NS = 'http://schemas.openxmlformats.org/drawingml/2006/chart'
const OFFICE_REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

/** a .rels part's own part (word/_rels/settings.xml.rels -> word/settings.xml) */
const ownerOf = (relsName: string) => relsName.replace(/(^|\/)_rels\/([^/]+)\.rels$/i, '$1$2')

/**
 * The finished package checked (see the head of this file). Returns the bytes, with an attached template taken out if
 * there was one. Throws a ToolError naming the first problem; the caller saves nothing then. `kind` only shapes the
 * refusal wording.
 */
export function checkOfficeLinks(kind: 'docx' | 'pptx' | 'xlsx', bytes: Uint8Array): Uint8Array {
  return scanOffice(kind, bytes, null)
}

/**
 * The same scan, collecting the risky items instead of stopping at the first (the work folder's exit check,
 * officeExitCheck): `risks` gets one entry per item, named by what it is and where it points, not by the part it is in,
 * so the same link moved to another part of an edited file is the same item. A damaged package still throws.
 */
export function scanOffice(kind: 'docx' | 'pptx' | 'xlsx', bytes: Uint8Array, risks: Map<string, string> | null, nested = false): Uint8Array {
  const what = `the ${kind === 'docx' ? 'Word' : kind === 'pptx' ? 'PowerPoint' : 'Excel'} file would contain`
  const stop = (part: string, why: string): never => { throw new ToolError(`${what}: ${part} ${why}; links may only go to web pages (http, https), mail addresses (mailto) or places inside the document; nothing was saved`) }
  /** one risky item: refused at once (make_file), or collected by its exact identity `id` (the exit check) */
  const fail = (part: string, why: string, id: string = why): never => { if (!risks) return stop(part, why); if (!risks.has(id)) risks.set(id, why); return undefined as never }
  if (!isZip(bytes)) throw new ToolError(`${what} is not a valid ${kind} file; nothing was saved`)
  try { checkZip(bytes) } catch (e) { throw new ToolError(`${what} could not be checked (${String((e as Error).message).slice(0, 120)}); nothing was saved`) }
  let entries: ZipEntry[]
  try { entries = readZip(bytes) } catch (e) { throw new ToolError(`${what} a damaged zip container (${String((e as Error).message).slice(0, 120)}); nothing was saved`) }
  const dec = new TextDecoder('utf-8', { fatal: false })
  /** .rels parts that hold an attached-template relationship, and the owner parts (word/settings.xml) that hold the element */
  const stripRels = new Set<string>()
  const stripOwners = new Set<string>()

  const partBytes = new Map(entries.map((e) => [e.name, e.data]))
  /** an item's identity: what it is and exactly where it points (normalized), or for an embedded part its bytes' hash */
  const norm = (t: string) => t.trim().replace(/\\/g, '/').toLowerCase()
  const resolve = (relsName: string, target: string) => {
    const base = ownerOf(relsName).split('/').slice(0, -1)
    const out = target.startsWith('/') ? [] : [...base]
    for (const seg of target.replace(/^\//, '').split('/')) { if (seg === '..') out.pop(); else if (seg && seg !== '.') out.push(seg) }
    return out.join('/')
  }
  const hashOf = (b: Uint8Array | undefined) => (b ? crypto.createHash('sha256').update(b).digest('hex') : 'missing')

  // chart parts by content type ([Content_Types].xml Override), not by name alone
  // (a part with any other Override as well is not a chart)
  const chartParts = new Set<string>()
  if (!nested) {
    const notChart = new Set<string>()
    const types = partBytes.get('[Content_Types].xml')
    if (types) parseXml(dec.decode(types), '[Content_Types].xml', stop, {
      open: (t) => {
        if (t.local !== 'Override') return
        const name = (attrNS(t, '', 'PartName') ?? '').replace(/^\//, '')
        if (CHART_PART.test(name) && (attrNS(t, '', 'ContentType') ?? '').trim().toLowerCase() === CHART_CONTENT_TYPE) chartParts.add(name)
        else notChart.add(name.toLowerCase())
      },
    })
    for (const name of chartParts) if (notChart.has(name.toLowerCase())) chartParts.delete(name)
  }
  /** the relationship id each chart part's <c:externalData r:id> names (read once per chart) */
  const dataIds = new Map<string, string | null>()
  const dataIdOf = (chart: string): string | null => {
    if (dataIds.has(chart)) return dataIds.get(chart)!
    let id: string | null = null
    const b = partBytes.get(chart)
    if (b) parseXml(dec.decode(b), chart, stop, { open: (t) => { if (id === null && t.uri === CHART_NS && t.local === 'externalData') id = attrNS(t, OFFICE_REL_NS, 'id') ?? null } })
    dataIds.set(chart, id)
    return id
  }
  /** the Id of each relationship of a .rels part, by its position (the order relationshipsOf gives them in) */
  const relIds = new Map<string, (string | undefined)[]>()
  const idsOf = (relsName: string): (string | undefined)[] => {
    let ids = relIds.get(relsName)
    if (!ids) {
      const found: (string | undefined)[] = []
      parseXml(dec.decode(partBytes.get(relsName) ?? new Uint8Array()), relsName, stop, { open: (t) => { if (t.local === 'Relationship' && t.uri === REL_NS) found.push(attrNS(t, '', 'Id')) } })
      relIds.set(relsName, (ids = found))
    }
    return ids
  }
  /** each workbook scanned once: its risky items, or why it could not be read */
  const checked = new Map<string, { risks: Map<string, string> } | { why: string }>()
  let checkedBytes = 0
  /**
   * Is this relationship a chart's data workbook that may stay: an internal `package` relationship, at a plain relative
   * target, of a part that is a chart by its content type, the one its <c:externalData> names, to an .xlsx in the
   * embeddings folder, which passes this same scan as a workbook (no macros, links, connections, objects; a chart in it
   * may not embed a workbook of its own). A workbook that holds a risky item fails, naming the workbook and the item.
   */
  const chartWorkbook = (relsName: string, r: { type: string; target: string; external: boolean }, at: number, target: string): boolean => {
    const owner = ownerOf(relsName)
    if (r.type !== 'package' || r.external || !PLAIN_TARGET.test(r.target) || !chartParts.has(owner) || !CHART_WORKBOOK.test(target)) return false
    if (target.split('/')[0] !== owner.split('/')[0]) return false
    const id = idsOf(relsName)[at]
    if (!id || dataIdOf(owner) !== id) return false
    const data = partBytes.get(target)
    if (!data || !isZip(data)) return false
    // memoized by the exact part name: two parts whose names differ only in case are two workbooks
    const key = target.toLowerCase()
    let got = checked.get(target)
    if (!got) {
      checkedBytes += data.length
      if (checked.size >= CHART_WORKBOOKS_MAX || checkedBytes > CHART_WORKBOOK_BYTES_MAX) got = { why: `is past what one file may hold in chart data workbooks (${CHART_WORKBOOKS_MAX}, ${CHART_WORKBOOK_BYTES_MAX / 1024 / 1024} MB)` }
      else {
        const risks = new Map<string, string>()
        try {
          // an attached template taken out would change the bytes: not a plain workbook
          if (scanOffice('xlsx', data, risks, true) !== data) risks.set('template', 'holds an attached template')
          got = { risks }
        } catch (e) { got = { why: `could not be checked (${String((e as Error).message).slice(0, 120)})` } }
      }
      checked.set(target, got)
    }
    const named = `has a chart data workbook ${clip(target)} that`
    if ('why' in got) fail(relsName, `${named} ${got.why}`, `chartdata|${key}|unreadable`)
    else for (const [rid, why] of got.risks) fail(relsName, `${named} ${why}`, `chartdata|${key}|${rid}`)
    return true
  }

  for (const e of entries) {
    if (!/\.rels$/i.test(e.name)) continue
    const xml = dec.decode(e.data)
    const owner = ownerOf(e.name)
    for (const [at, r] of relationshipsOf(xml, e.name, stop).entries()) {
      if (r.type === ATTACHED_TEMPLATE) {
        // taken out below (the element in the owner part and this relationship), not refused
        stripRels.add(e.name)
        stripOwners.add(owner)
        continue
      }
      // where it points first: outside the file is refused whatever the relationship is
      const outside = r.external || /^[a-z][a-z0-9+.-]*:|^[\\/]{2}|\\/i.test(r.target)
      if (r.external) {
        if (r.type !== 'hyperlink') fail(e.name, `refers to "${clip(r.target)}" outside the file (${r.type || 'a relationship'})`, `rel|${r.type}|ext|${norm(r.target)}`)
        else if (!allowedLinkTarget(r.target) || r.target.startsWith('#')) fail(e.name, `has a link to "${clip(r.target)}"`, `rel|hyperlink|ext|${norm(r.target)}`)
      } else if (outside) {
        fail(e.name, `refers to "${clip(r.target)}" outside the file`, `rel|${r.type}|int|${norm(r.target)}`)
      }
      if (OBJECT_RELS.has(r.type)) {
        // a chart's own data sheet (PowerPoint and Word: right-click > Edit Data; QA A-03-L): the workbook pptxgenjs,
        // python-pptx and Office write for every native chart passes when it holds nothing this scan refuses itself
        if (!nested && !outside && chartWorkbook(e.name, r, at, resolve(e.name, r.target))) continue
        const id = r.external ? `rel|${r.type}|ext|${norm(r.target)}` : `obj|${r.type}|${norm(resolve(e.name, r.target))}|${hashOf(partBytes.get(resolve(e.name, r.target)))}`
        fail(e.name, `refers to ${r.external ? 'a link to ' : ''}an embedded object, a frame or a subdocument (${r.type})`, id)
      }
    }
  }

  if (entries.some((e) => /(^|\/)workbook\.bin$/i.test(e.name))) stop('the package', 'is a binary workbook (.xlsb), whose links cannot be checked')
  // every XML part: a macro project, Excel's external links (DDE, OLE links), data connections and query tables, and any
  // src / href attribute (VML v:imagedata, v:fill, o:href ...) that points outside the document
  for (const e of entries) {
    const lower = e.name.toLowerCase()
    if (/(^|\/)vbaproject\.bin$|(^|\/)vbadata\.xml$/.test(lower)) fail(e.name, 'holds a macro project', `vba|${hashOf(e.data)}`)
    if (/\.rels$/i.test(e.name) || !looksXml(e.data)) continue
    const xml = dec.decode(e.data)
    const isConn = /(^|\/)connections\.xml$/.test(lower), isQuery = /(^|\/)querytables\//.test(lower), isExt = /(^|\/)externallinks\/[^/]+\.xml$/.test(lower)
    if (isQuery) fail(e.name, 'holds a query table that fetches data from outside the file', `query|${hashOf(e.data)}`)
    parseXml(xml, e.name, stop, {
      open: (t) => {
        if (isExt && (t.local === 'ddeLink' || t.local === 'oleLink')) {
          const a = (n: string) => attrNS(t, '', n) ?? ''
          fail(e.name, `holds an external ${t.local === 'ddeLink' ? 'DDE' : 'OLE'} link (${clip(a('ddeService') || a('progId'))})`, `${t.local}|${norm(a('ddeService'))}|${norm(a('ddeTopic'))}|${norm(a('progId'))}`)
        }
        if (isConn && t.local === 'connection') fail(e.name, 'holds a data connection that fetches data from outside the file', `conn|${Object.values(t.attributes).filter((x) => !['id'].includes(x.local)).map((x) => `${x.local}=${norm(x.value)}`).sort().join('|')}`)
        if (isConn && (t.local === 'webPr' || t.local === 'textPr' || t.local === 'dbPr' || t.local === 'olapPr')) fail(e.name, 'holds a data connection that fetches data from outside the file', `conn-${t.local}|${Object.values(t.attributes).map((x) => `${x.local}=${norm(x.value)}`).sort().join('|')}`)
        for (const at of Object.values(t.attributes)) {
          if (at.local !== 'src' && at.local !== 'href') continue
          const v = at.value.trim()
          if (!v || v.startsWith('#') || allowedLinkTarget(v)) continue
          // an absolute place outside the document: a share, a drive, a file: or other scheme, a rooted path
          if (/^[a-z][a-z0-9+.-]*:|^[\\/]{2}|^[a-z]:[\\/]|^[\\/]/i.test(v)) fail(e.name, `refers to "${clip(v)}" outside the file`, `attr|${at.local}|${norm(v)}`)
        }
      },
    })
  }

  // Word fields in every XML part of a .docx, wherever it is, UTF-16 refused: the same scan as the template check
  // every package, whatever its kind: a Word main part can sit anywhere (its kind comes only from its content type)
  scanWordFields(entries, stop, (part, why, code) => fail(part, why, `field|${code.trim().replace(/\s+/g, ' ').toLowerCase()}`))

  if (!stripOwners.size) return bytes
  // take the attached template out: its relationship(s) in the .rels, and the w:attachedTemplate element in the owner
  const enc = new TextEncoder()
  for (const e of entries) {
    if (stripRels.has(e.name)) {
      const next = dropElements(dec.decode(e.data), e.name, stop, (t) => t.uri === REL_NS && t.local === 'Relationship' && (attrNS(t, '', 'Type') ?? '').trim().split('/').pop() === ATTACHED_TEMPLATE)
      e.data = enc.encode(next); delete e.raw; delete e.store
    } else if (stripOwners.has(e.name)) {
      const next = dropElements(dec.decode(e.data), e.name, stop, (t) => t.local === 'attachedTemplate')
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

/** The office worker's exit check (files/office-exit.ts): a frame of [header length (4 bytes, big-endian), header JSON
 * { kind, sizes }, the new file, then each earlier version], answered with the file's bytes (an attached template taken
 * out) or a ToolError naming the first risky item the earlier versions did not already hold. */
export const OFFICE_EXIT_MODE = 'office-exit-check'
export function officeExitRequest(input: Uint8Array): Uint8Array {
  if (input.length < 4) throw new ToolError('the exit check got no file')
  const n = new DataView(input.buffer, input.byteOffset, 4).getUint32(0)
  const head = JSON.parse(new TextDecoder().decode(input.subarray(4, 4 + n))) as { kind: string; sizes: number[] }
  const kind = head.kind === 'docx' || head.kind === 'pptx' || head.kind === 'xlsx' ? head.kind : null
  if (!kind || !Array.isArray(head.sizes) || !head.sizes.length || head.sizes.some((x) => !Number.isSafeInteger(x) || x < 0)) throw new ToolError('the exit check got a bad request')
  const parts: Uint8Array[] = []
  let at = 4 + n
  for (const size of head.sizes) { if (at + size > input.length) throw new ToolError('the exit check got a bad request'); parts.push(input.subarray(at, at + size)); at += size }
  const [file, ...earlier] = parts as [Uint8Array, ...Uint8Array[]]
  const had = new Map<string, string>()
  for (const e of earlier) { try { scanOffice(kind, e, had) } catch { /* a damaged earlier version vouches for nothing */ } }
  const found = new Map<string, string>()
  const cleaned = scanOffice(kind, file, found)
  const fresh = [...found].filter(([id]) => !had.has(id)).map(([, why]) => why)
  if (fresh.length) throw new ToolError(`the ${kind === 'docx' ? 'Word' : kind === 'pptx' ? 'PowerPoint' : 'Excel'} file ${fresh[0]}${fresh.length > 1 ? ` (and ${fresh.length - 1} more)` : ''}; links may only go to web pages (http, https), mail addresses (mailto) or places inside the document, and embedded objects, linked pictures and fields that run something are not allowed. Remove it and save again`, 'office_unsafe')
  return cleaned
}
