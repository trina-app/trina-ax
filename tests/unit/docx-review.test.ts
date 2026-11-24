// A Word file's tracked changes and comments read back from its saved bytes (server/src/files/docx-review.ts; QA A-43-L:
// the answer said four margin comments were saved in a file that had none). The read counts what Word shows and names
// the faults that hide comments: a comments part with no mark in the text (the docx skill's comment.py before its
// markers are placed), one nothing links to or with no content type, and marks that name no comment.
import { describe, expect, test } from 'bun:test'
import { addDocxComments } from '../../server/src/files/docx-comment'
import { docxReview, docxReviewLine, docxReviewRequest } from '../../server/src/files/docx-review'
import { docxExtraText } from '../../server/src/files/ooxml'
import { readZip, writeZip } from '../../server/src/files/zip-write'
import { docx } from '../lib/office-fixture'

const enc = new TextEncoder(), dec = new TextDecoder()
const W = 'w:author="QA Member" w:date="2026-11-24T09:00:00Z"'
/** two paragraphs with Word's Track Changes: "there" -> "their", "the " inserted, a deleted comma, a moved word, and a
 * deleted paragraph mark (a mark on the paragraph's properties: not a text change) */
const TRACKED = docx({
  body: 'Brightfield asked us to redesign',
  extra:
    `<w:p><w:r><w:t xml:space="preserve">They want </w:t></w:r><w:del w:id="101" ${W}><w:r><w:delText>there</w:delText></w:r></w:del>` +
    `<w:ins w:id="102" ${W}><w:r><w:t>their</w:t></w:r></w:ins><w:r><w:t xml:space="preserve"> booking system by the end of </w:t></w:r>` +
    `<w:ins w:id="103" ${W}><w:r><w:t xml:space="preserve">the </w:t></w:r></w:ins><w:r><w:t>year</w:t></w:r><w:del w:id="104" ${W}><w:r><w:delText>,</w:delText></w:r></w:del></w:p>` +
    `<w:p><w:pPr><w:rPr><w:del w:id="105" ${W}/></w:rPr></w:pPr><w:moveTo w:id="106" ${W}><w:r><w:t>Payment</w:t></w:r></w:moveTo><w:r><w:t xml:space="preserve"> terms: 50% upfront.</w:t></w:r></w:p>`,
})
/** the package with one part changed (or removed with null) */
function withPart(b: Uint8Array, name: string, f: ((x: string) => string) | null): Uint8Array {
  return writeZip(readZip(b).flatMap((e) => e.name !== name ? [e] : f === null ? [] : [{ name: e.name, data: enc.encode(f(dec.decode(e.data))) }]))
}
const part = (b: Uint8Array, name: string) => { const e = readZip(b).find((x) => x.name === name); return e ? dec.decode(e.data) : null }

describe('Word review read-back (docx-review.ts)', () => {
  test('a file with tracked changes and comments: written, saved and read back with every change and comment counted', () => {
    expect(docxReview(TRACKED)).toEqual({ inserted: 2, deleted: 2, moved: 1, comments: 0, placed: 0, unknownMarks: 0, unlinked: '' })
    // margin notes added by comment_docx's writer next to the tracked changes; the zip goes out and comes back as bytes
    const r = addDocxComments(TRACKED, [
      { on: 'They want their', text: 'Confirm the client name' },
      { on: 'Payment terms', text: '6 or 8 weeks? The proposal says both' },
    ], 'QA Member', '2026-11-24T09:00:00Z')
    const saved = new Uint8Array(writeZip(readZip(r.file)))
    const back = docxReview(saved)
    expect(back).toEqual({ inserted: 2, deleted: 2, moved: 1, comments: 2, placed: 2, unknownMarks: 0, unlinked: '' })
    expect(docxReviewLine(back)).toBe(' Read back from the saved file: 2 tracked insertions, 2 tracked deletions, 1 tracked move; 2 comments (all shown in the margin). Describe the file\'s tracked changes and comments only as this read-back says.')
    // the normal reader agrees: both comments and the tracked changes
    const extra = docxExtraText(saved)
    expect(extra).toContain('Confirm the client name')
    expect(extra).toContain('6 or 8 weeks? The proposal says both')
    expect(extra).toContain('[deleted: there][inserted: their]')
    // the worker mode answers the same as JSON
    expect(JSON.parse(dec.decode(docxReviewRequest(saved)))).toEqual(back)
  })

  test('no comments and no changes: said as such, no problems', () => {
    const r = docxReview(docx())
    expect(r).toEqual({ inserted: 0, deleted: 0, moved: 0, comments: 0, placed: 0, unknownMarks: 0, unlinked: '' })
    expect(docxReviewLine(r)).toBe(' Read back from the saved file: no tracked changes; no comments. Describe the file\'s tracked changes and comments only as this read-back says.')
  })

  test('comments with no mark in the text (comment.py before its markers are placed): counted, and Word not showing them is named', () => {
    const marked = addDocxComments(TRACKED, [{ on: 'Payment terms', text: 'Check the split' }, { on: 'They want', text: 'Tone' }], 'QA Member', '2026-11-24T09:00:00Z').file
    const bare = withPart(marked, 'word/document.xml', (x) => x.replace(/<w:commentRangeStart[^>]*\/>|<w:commentRangeEnd[^>]*\/>|<w:r><w:commentReference[^>]*\/><\/w:r>/g, ''))
    const r = docxReview(bare)
    expect(r).toMatchObject({ comments: 2, placed: 0, unknownMarks: 0, unlinked: '' })
    const line = docxReviewLine(r)
    expect(line).toContain('2 comments (0 shown in the margin)')
    expect(line).toContain('Problems: 2 comments have no w:commentReference in the text, so Word does not show them.')
  })

  test('a comments part nothing links to, or with no content type: Word shows none of them', () => {
    const marked = addDocxComments(TRACKED, [{ on: 'Payment terms', text: 'Check the split' }], 'QA Member', '2026-11-24T09:00:00Z').file
    const noRel = withPart(marked, 'word/_rels/document.xml.rels', (x) => x.replace(/<Relationship\b[^>]*relationships\/comments"[^>]*\/>/, ''))
    expect(part(noRel, 'word/_rels/document.xml.rels')).not.toContain('comments')
    const a = docxReview(noRel)
    expect(a).toMatchObject({ comments: 1, placed: 1, unlinked: 'no-relationship' })
    expect(docxReviewLine(a)).toContain('1 comment (0 shown in the margin)')
    expect(docxReviewLine(a)).toContain('its comments part is not linked from the document')
    const noType = withPart(marked, '[Content_Types].xml', (x) => x.replace(/<Override PartName="\/word\/comments\.xml"[^>]*\/>/, ''))
    const b = docxReview(noType)
    expect(b.unlinked).toBe('no-content-type')
    expect(docxReviewLine(b)).toContain('its comments part has no content type')
  })

  test('a mark in the text that names no comment (the comments part missing): Word may call the file damaged', () => {
    const marked = addDocxComments(TRACKED, [{ on: 'Payment terms', text: 'Check the split' }], 'QA Member', '2026-11-24T09:00:00Z').file
    const lost = withPart(marked, 'word/comments.xml', null)
    const r = docxReview(lost)
    expect(r).toMatchObject({ comments: 0, placed: 0, unknownMarks: 1 })
    expect(docxReviewLine(r)).toContain('no comments. Problems: 1 comment mark in the text names no comment, so Word may say the file is damaged.')
  })

  test('not a Word file: refused with words', () => {
    expect(() => docxReview(enc.encode('not a zip'))).toThrow(/not a zip/)
  })
})
