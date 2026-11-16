// Word comments added to an existing .docx (comment_docx, tools/comment-docx.ts; AI flow check FL-21, QA TC-3818): each
// comment is a review note in the margin next to the paragraph that holds the given text, as Word's Review > New
// Comment makes it. The OOXML: word/comments.xml gets a <w:comment> (made when the file has none, with its content type
// and the document's relationship), and the paragraph gets <w:commentRangeStart/> after its properties and
// <w:commentRangeEnd/> plus a run with <w:commentReference/> at its end. Nothing else changes: every other part of the
// zip is copied with its compressed bytes as they were (zip-write.ts readZip / writeZip), and the paragraphs' text is
// read again afterwards and must be what it was.
// The document is untrusted, so this runs only in the office worker (files/office-worker.ts, mode `docx-comment`); the
// zip is checked first (zip-guard.ts) and the XML is scanned linearly (ooxml.ts tags).
import { ToolError } from '../policy/errors'
import { attr, tags } from './ooxml'
import { checkZip, isZip } from './zip-guard'
import { readZip, writeZip, type ZipEntry } from './zip-write'

export const DOCX_COMMENT_MODE = 'docx-comment'
/** the documents comment_docx changes */
export const DOCX_COMMENT_MAX = 64 * 1024 * 1024
export const COMMENTS_MAX = 20

export interface DocxComment { on: string; text: string; occurrence?: number }
export interface DocxCommentRequest { file: string; comments: DocxComment[]; author: string; date: string }
export interface DocxCommentResult { file: string; added: { on: string; paragraph: string }[] }

const DOC = 'word/document.xml'
const COMMENTS = 'word/comments.xml'
const DOC_RELS = 'word/_rels/document.xml.rels'
const TYPES = '[Content_Types].xml'
const COMMENTS_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml'
const COMMENTS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments'
const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'

/** text without the characters XML 1.0 forbids (controls, U+FFFE/FFFF, lone surrogates), which would make the part
 * not well-formed and Word refuse the file; comment_docx compares the read-back with the same cleaning */
export const xmlSafe = (s: string) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '')
/** text for XML: cleaned and escaped */
const esc = (s: string) => xmlSafe(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
const codePoint = (n: number) => (Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '\ufffd')
const unescapeXml = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
  e[0] === '#' ? codePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENTITIES[e] ?? m))
/** a part with its root `<name …/>` opened when it is self-closed; null when it does not end with `</name>` then */
function openRoot(xml: string, name: string): string | null {
  const opened = xml.replace(new RegExp(`<${name}(\\s[^<>]*)?/>\\s*$`), (_m, head: string | undefined) => `<${name}${head ?? ''}></${name}>`)
  return new RegExp(`</${name}>\\s*$`).test(opened) ? opened : null
}
/** `extra` put before the part's last end tag `</name>` (a self-closed root is opened first); refused when it has none */
function appendTo(xml: string, name: string, extra: string): string {
  const opened = openRoot(xml, name) ?? refuse(`the ${name} part of this document could not be read`)
  return opened.replace(new RegExp(`</${name}>\\s*$`), `${extra}</${name}>`)
}
const refuse = (why: string): never => { throw new ToolError(`${why}; nothing was saved`) }

/** A paragraph of the body: where its start tag ends, where its properties end (or -1), where its end tag starts, its
 * text, and whether it is in a text box (a shape's text: a comment goes next to body text only). */
interface Para { open: number; pPrEnd: number; close: number; text: string; box: boolean }

/** The body's paragraphs in reading order (a paragraph inside a text box is its own; its text is not its outer one's). */
export function docxParagraphs(xml: string): Para[] {
  const out: Para[] = []
  const stack: Para[] = []
  let inText = false
  let last = 0
  // the older copy of new content (mc:Fallback; Word shows mc:Choice) is not read, as Word does not show it
  let fallback = 0, boxes = 0
  for (const t of tags(xml)) {
    const top = stack[stack.length - 1]
    if (inText && top && t.start > last) top.text += unescapeXml(xml.slice(last, t.start))
    last = t.end
    if (t.name === 'mc:Fallback' && !t.selfClose) { fallback = Math.max(0, fallback + (t.close ? -1 : 1)); continue }
    if (t.name === 'w:txbxContent' && !t.selfClose) { boxes = Math.max(0, boxes + (t.close ? -1 : 1)); continue }
    if (fallback) continue
    if (t.name === 'w:p') {
      if (t.selfClose) { out.push({ open: t.end, pPrEnd: -1, close: -1, text: '', box: boxes > 0 }); continue }
      if (!t.close) { const p = { open: t.end, pPrEnd: -1, close: -1, text: '', box: boxes > 0 }; out.push(p); stack.push(p) } else { const p = stack.pop(); if (p) p.close = t.start }
    } else if (t.name === 'w:pPr' && (t.close || t.selfClose) && top) top.pPrEnd = t.end
    else if (t.name === 'w:t') inText = !t.close && !t.selfClose
    else if ((t.name === 'w:tab' || t.name === 'w:br' || t.name === 'w:cr') && top && !t.close) top.text += t.name === 'w:tab' ? '\t' : '\n'
  }
  return out
}

/** The ids comments already use (comments.xml and the body's ranges and references). */
function usedIds(...xmls: string[]): Set<number> {
  const ids = new Set<number>()
  for (const x of xmls) for (const t of tags(x)) {
    if (t.close || !/^w:(comment|commentRangeStart|commentRangeEnd|commentReference)$/.test(t.name)) continue
    const id = Number(attr(t.head, 'w:id'))
    if (Number.isInteger(id)) ids.add(id)
  }
  return ids
}

const decode = (b: Uint8Array): string => { try { return new TextDecoder('utf-8', { fatal: true }).decode(b) } catch { return refuse('a part of this document is not UTF-8 text, so it cannot be changed here') } }
const encode = (s: string) => new TextEncoder().encode(s)

/** The document with the comments added, and where each went. */
export function addDocxComments(bytes: Uint8Array, comments: DocxComment[], author: string, date: string): { file: Uint8Array; added: DocxCommentResult['added'] } {
  if (!comments.length || comments.length > COMMENTS_MAX) refuse(`give 1 to ${COMMENTS_MAX} comments`)
  if (!isZip(bytes)) refuse('this file is not a Word document (not a zip container)')
  checkZip(bytes)
  let entries: ReturnType<typeof readZip>
  try { entries = readZip(bytes) } catch (e) { return refuse(`its zip container is damaged (${String((e as Error).message).slice(0, 120)})`) }
  const part = (name: string) => entries.find((e) => e.name === name)
  const docEntry = part(DOC) ?? refuse('this file is not a Word document (no word/document.xml)')
  let doc = decode(docEntry.data)
  const commentsEntry = part(COMMENTS)
  // the comments part the document's relationship names: only word/comments.xml is changed here
  const relsNow = part(DOC_RELS)
  for (const m of (relsNow ? decode(relsNow.data) : '').matchAll(/<Relationship\b[^>]*>/g)) {
    if (m[0].includes(COMMENTS_REL) && !/Target="(\/word\/comments\.xml|comments\.xml)"/.test(m[0])) refuse('this document keeps its comments in a part with another name, which cannot be changed here')
  }
  // an empty part may be one self-closed root (pandoc writes <w:comments … />)
  let cxml = commentsEntry ? decode(commentsEntry.data) : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:comments xmlns:w="${W_NS}"></w:comments>`
  cxml = openRoot(cxml, 'w:comments') ?? refuse('the comments part of this document could not be read')
  const before = docxParagraphs(doc).map((p) => p.text)

  // where each comment goes, found in the text as the document reads (all before any change)
  const paras = docxParagraphs(doc)
  const ids = usedIds(doc, cxml)
  let next = 0
  for (const id of ids) if (id >= next) next = id + 1
  if (next + comments.length > 0x7fffffff) refuse('the document\'s comment numbers are used up')
  type Spot = { para: Para; id: number; c: DocxComment }
  const spots: Spot[] = []
  for (const [i, c] of comments.entries()) {
    const on = c.on.normalize('NFC')
    const all = paras.filter((p) => p.close >= 0 && p.text.normalize('NFC').includes(on))
    const hits = all.filter((p) => !p.box)
    if (all.length && !hits.length) refuse(`comment ${i + 1}: "${c.on.slice(0, 80)}" is only in a text box; a comment goes next to body text`)
    if (!hits.length) refuse(`comment ${i + 1}: "${c.on.slice(0, 80)}" is not in the text of any one paragraph (give exact text from a single paragraph, as read shows it)`)
    if (hits.length > 1 && c.occurrence === undefined) refuse(`comment ${i + 1}: "${c.on.slice(0, 80)}" is in ${hits.length} paragraphs; give occurrence (1 to ${hits.length}) or longer text`)
    const para = hits[(c.occurrence ?? 1) - 1] ?? refuse(`comment ${i + 1}: occurrence ${c.occurrence} is past the ${hits.length} paragraphs that hold this text`)
    spots.push({ para, id: next++, c })
  }
  // the body, changed from the end backwards so earlier positions stay right
  const inserts: { at: number; text: string }[] = []
  for (const s of spots) {
    inserts.push({ at: s.para.pPrEnd >= 0 ? s.para.pPrEnd : s.para.open, text: `<w:commentRangeStart w:id="${s.id}"/>` })
    inserts.push({ at: s.para.close, text: `<w:commentRangeEnd w:id="${s.id}"/><w:r><w:commentReference w:id="${s.id}"/></w:r>` })
  }
  inserts.sort((a, b) => b.at - a.at)
  for (const ins of inserts) doc = doc.slice(0, ins.at) + ins.text + doc.slice(ins.at)
  const initials = author.split(/\s+/).map((w) => [...w][0] ?? '').join('').slice(0, 9)
  const notes = spots.map((s) => `<w:comment w:id="${s.id}" w:author="${esc(author)}" w:date="${esc(date)}" w:initials="${esc(initials)}">` +
    s.c.text.split(/\r?\n/).map((line) => `<w:p><w:r><w:t xml:space="preserve">${esc(line)}</w:t></w:r></w:p>`).join('') + '</w:comment>').join('')
  cxml = appendTo(cxml, 'w:comments', notes)

  // read back: every paragraph reads as before (a comment adds no text to the body)
  const after = docxParagraphs(doc).map((p) => p.text)
  if (after.length !== before.length || after.some((t, i) => t !== before[i])) refuse('the document did not read back the same after the comments were added')

  const changed = new Map<string, string>([[DOC, doc], [COMMENTS, cxml]])
  // the content type and the relationship, when the file lacks them (a new part, or one nothing links to)
  {
    const types = decode((part(TYPES) ?? refuse('this file has no content types part')).data)
    if (!types.includes('PartName="/word/comments.xml"')) changed.set(TYPES, appendTo(types, 'Types', `<Override PartName="/word/comments.xml" ContentType="${COMMENTS_TYPE}"/>`))
    const relsEntry = part(DOC_RELS)
    const rels = relsEntry ? decode(relsEntry.data) : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>'
    if (!rels.includes(COMMENTS_REL)) {
      const taken = new Set([...rels.matchAll(/\sId="([^"]*)"/g)].map((m) => m[1]))
      let n = taken.size + 1
      while (taken.has(`rId${n}`)) n++
      changed.set(DOC_RELS, appendTo(rels, 'Relationships', `<Relationship Id="rId${n}" Type="${COMMENTS_REL}" Target="comments.xml"/>`))
    }
  }
  const out: ZipEntry[] = entries.map((e) => {
    const text = changed.get(e.name)
    if (text === undefined) return e
    changed.delete(e.name)
    return { name: e.name, data: encode(text), utf8: e.utf8, time: e.time, date: e.date }
  })
  for (const [name, text] of changed) out.push({ name, data: encode(text) })
  let file: Uint8Array
  try { file = writeZip(out) } catch (e) { return refuse(`the changed document could not be written (${String((e as Error).message).slice(0, 120)})`) }
  return { file, added: spots.map((s) => ({ on: s.c.on, paragraph: s.para.text.replace(/\s+/g, ' ').trim().slice(0, 200) })) }
}

/** The office worker's mode: a JSON request in (the file as base64), a JSON answer out. */
export function docxCommentRequest(input: Uint8Array): Uint8Array {
  let r: DocxCommentRequest
  try { r = JSON.parse(decode(input)) } catch { return refuse('the request could not be read') }
  if (typeof r.file !== 'string' || !Array.isArray(r.comments) || typeof r.author !== 'string' || typeof r.date !== 'string') refuse('the request could not be read')
  const done = addDocxComments(new Uint8Array(Buffer.from(r.file, 'base64')), r.comments, r.author, r.date)
  const res: DocxCommentResult = { file: Buffer.from(done.file).toString('base64'), added: done.added }
  return encode(JSON.stringify(res))
}
