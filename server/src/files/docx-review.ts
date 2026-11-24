// What a Word file really holds for review, read back from its saved bytes (QA A-43-L, 2026-11-24): the tracked changes
// of its body (Word's Track Changes: insertions, deletions, moves) and its comments, with the faults that make Word show
// fewer comments than the file seems to have or call the file damaged. A Word file built in the work folder (the docx
// skill's own scripts, or the AI's code) leaves it through save_work_file / copy_files (chat/places-copy.ts officeOut),
// and that result carries this read-back, so the AI's answer rests on what was saved, not on what it meant to write.
// The bytes are untrusted, so this runs only in the office worker (mode `docx-review`); the zip is checked first
// (ooxml.ts parts) and the XML is scanned linearly (ooxml.ts tags).
import { ToolError } from '../policy/errors'
import { attr, rels, tags, xmlOf, type Parts } from './ooxml'
import { checkZip, isZip } from './zip-guard'
import { readZip } from './zip-write'

export const DOCX_REVIEW_MODE = 'docx-review'

export interface DocxReview {
  /** tracked insertions, deletions and moves (a moved block counts once) in the body, each a w:ins / w:del /
   * w:moveTo element around content; a mark on a paragraph mark alone (an empty w:ins in a run's properties) is left out */
  inserted: number
  deleted: number
  moved: number
  /** comments in the comments part (w:comment elements) */
  comments: number
  /** comments of the part that the body marks with a commentReference (what Word shows in the margin) */
  placed: number
  /** comment ids the body marks that no comment of the part has (Word reports such a file as damaged) */
  unknownMarks: number
  /** why Word does not read the comments part at all: '' when it does */
  unlinked: '' | 'no-relationship' | 'no-content-type'
}

const COMMENTS_REL = /\/relationships\/comments$/
const COMMENTS_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml'
const OFFICE_DOC_REL = /\/relationships\/officeDocument$/

/** The parts the review reads: the XML of the package and its relationships, never pictures or other media. Only these
 * are kept in memory (checkZip still bounds every entry's expansion). */
export const REVIEW_PART = /^(\[Content_Types\]\.xml|_rels\/\.rels|word\/[^/]+\.xml|word\/_rels\/[^/]+\.xml\.rels)$/
/** the parts beside the body that can hold comment marks */
const MARK_PARTS = ['word/footnotes.xml', 'word/endnotes.xml']

/** The review read of a .docx; ToolError when it is not a Word file that can be read. */
export function docxReview(bytes: Uint8Array): DocxReview {
  if (!isZip(bytes)) throw new ToolError('could not read this Word document (not a zip container)')
  checkZip(bytes)
  const p: Parts = new Map()
  try { for (const e of readZip(bytes, (n) => REVIEW_PART.test(n))) p.set(e.name, e.data) } catch (e) { throw new ToolError(`could not read this Word document (${String((e as Error).message).slice(0, 120)})`) }
  // the main part as the package names it (Word's own files: word/document.xml)
  const main = [...rels(p, '').values()].find((r) => OFFICE_DOC_REL.test(r.type))?.target ?? 'word/document.xml'
  const doc = xmlOf(p, main)
  if (doc === null) throw new ToolError('this file is not a Word document (no main document part)')
  const out: DocxReview = { inserted: 0, deleted: 0, moved: 0, comments: 0, placed: 0, unknownMarks: 0, unlinked: '' }
  const marked = new Set<string>()
  let props = 0 // inside w:rPr / w:pPr: a change there marks a paragraph mark or a formatting change, not text
  for (const t of tags(doc)) {
    if (t.name === 'w:rPr' || t.name === 'w:pPr') { if (!t.selfClose) props = Math.max(0, props + (t.close ? -1 : 1)); continue }
    if (t.close || t.selfClose || props) {
      if (t.name === 'w:commentReference' && !t.close) { const id = attr(t.head, 'w:id'); if (id !== undefined) marked.add(id) }
      continue
    }
    if (t.name === 'w:ins') out.inserted++
    else if (t.name === 'w:del') out.deleted++
    else if (t.name === 'w:moveTo') out.moved++
    else if (t.name === 'w:commentReference') { const id = attr(t.head, 'w:id'); if (id !== undefined) marked.add(id) }
  }
  // comments can also be anchored in footnotes and endnotes
  for (const name of MARK_PARTS) {
    for (const t of tags(xmlOf(p, name) ?? '')) {
      if (t.name === 'w:commentReference' && !t.close) { const id = attr(t.head, 'w:id'); if (id !== undefined) marked.add(id) }
    }
  }
  // the comments part: the one the main part's relationship names, else word/comments.xml if the file has it anyway
  const rel = [...rels(p, main).values()].find((r) => COMMENTS_REL.test(r.type))
  const cpart = rel && p.has(rel.target) ? rel.target : p.has('word/comments.xml') ? 'word/comments.xml' : null
  const ids = new Set<string>()
  if (cpart) {
    for (const t of tags(xmlOf(p, cpart) ?? '')) {
      if (t.name !== 'w:comment' || t.close) continue
      out.comments++
      const id = attr(t.head, 'w:id')
      if (id !== undefined) ids.add(id)
    }
    const types = xmlOf(p, '[Content_Types].xml') ?? ''
    const typed = [...tags(types)].some((t) => t.name === 'Override' && !t.close && attr(t.head, 'PartName')?.replace(/^\//, '') === cpart && attr(t.head, 'ContentType') === COMMENTS_TYPE)
    out.unlinked = !rel || rel.target !== cpart ? 'no-relationship' : !typed ? 'no-content-type' : ''
  }
  for (const id of marked) { if (ids.has(id)) out.placed++; else out.unknownMarks++ }
  return out
}

const n = (k: number, one: string, many: string = one + 's') => `${k} ${k === 1 ? one : many}`

/** One line for a save result: what the saved Word file holds, and each fault that hides comments or damages it. */
export function docxReviewLine(r: DocxReview): string {
  const changes = r.inserted + r.deleted + r.moved
    ? [r.inserted && n(r.inserted, 'tracked insertion mark'), r.deleted && n(r.deleted, 'tracked deletion mark'), r.moved && n(r.moved, 'tracked move mark')].filter(Boolean).join(', ')
    : 'no tracked changes'
  const shown = r.unlinked ? 0 : r.placed
  const comments = r.comments ? `${n(r.comments, 'comment')} (${shown === r.comments ? 'all shown in the margin' : `${shown} shown in the margin`})` : 'no comments'
  const faults: string[] = []
  if (r.unlinked === 'no-relationship') faults.push(`its comments part is not linked from the document (no relationship in word/_rels/document.xml.rels), so Word shows none of its ${n(r.comments, 'comment')}`)
  else if (r.unlinked === 'no-content-type') faults.push(`its comments part has no content type in [Content_Types].xml, so Word shows none of its ${n(r.comments, 'comment')}`)
  else if (r.comments > r.placed) faults.push(`${n(r.comments - r.placed, 'comment')} ${r.comments - r.placed === 1 ? 'has' : 'have'} no w:commentReference in the text, so Word does not show ${r.comments - r.placed === 1 ? 'it' : 'them'}`)
  if (r.unknownMarks) faults.push(`${n(r.unknownMarks, 'comment mark')} in the text ${r.unknownMarks === 1 ? 'names' : 'name'} no comment, so Word may say the file is damaged`)
  return ` Read back from the saved file: ${changes}${r.inserted + r.deleted + r.moved ? ' (marks in the file\'s XML, not Word\'s Review count: one edit can be several marks)' : ''}; ${comments}.` +
    (faults.length ? ` Problems: ${faults.join('; ')}. Fix the file and save it again, or say this plainly in your answer.` : '') +
    ' Describe the file\'s tracked changes and comments only as this read-back says.'
}

/** The office worker's mode: the .docx in, the review as JSON out. */
export function docxReviewRequest(input: Uint8Array): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(docxReview(input)))
}
