// A page a model writes as text ("1") or a page list it writes as a number (3) is read the way it was meant, in
// stamp_pdf, edit_pdf, merge_pdfs and split_pdf (TC-5088). The JSON schema each tool shows stays the same.
import { expect, test } from 'bun:test'
import { EditPdfInput, MergePdfsInput, SplitPdfInput, StampPdfInput } from '@mycel/shared'

const stamp = (page: unknown) => StampPdfInput.safeParse({ file_path: 'a.pdf', image: 's.png', page })

test('stamp_pdf: a number, a numeric text and "last" are all pages', () => {
  expect(stamp(1).data?.page).toBe(1)
  expect(stamp('1').data?.page).toBe(1)
  expect(stamp(' 12 ').data?.page).toBe(12)
  expect(stamp('last').data?.page).toBe('last')
  expect(StampPdfInput.safeParse({ file_path: 'a.pdf', image: 's.png' }).data?.page).toBeUndefined()
})

test('stamp_pdf: nonsense is still refused', () => {
  for (const bad of ['first', '', '0', '-1', '1.5', 0, 1.5, 100_001, '100001', null]) expect(stamp(bad).success).toBe(false)
})

test('edit_pdf: stamp_image page and insert_pdf after take numeric text; a page list takes a bare number', () => {
  const r = EditPdfInput.safeParse({ file_path: 'a.pdf', operations: [
    { stamp_image: { image: 's.png', page: '2' } },
    { insert_pdf: { file: 'b.pdf', after: '0' } },
    { remove_pages: 3 },
    { rotate_pages: { pages: 2, degrees: 90 } },
  ] })
  expect(r.success).toBe(true)
  expect(r.data?.operations).toEqual([
    { stamp_image: { image: 's.png', page: 2 } },
    { insert_pdf: { file: 'b.pdf', after: 0 } },
    { remove_pages: '3' },
    { rotate_pages: { pages: '2', degrees: 90 } },
  ])
  expect(EditPdfInput.safeParse({ file_path: 'a.pdf', operations: [{ stamp_image: { image: 's.png', page: 'x' } }] }).success).toBe(false)
})

test('merge_pdfs and split_pdf: a page list as a number, every as text', () => {
  expect(MergePdfsInput.safeParse({ files: ['a.pdf', { path: 'b.pdf', pages: 1 }] }).data?.files[1]).toEqual({ path: 'b.pdf', pages: '1' })
  expect(SplitPdfInput.safeParse({ file_path: 'a.pdf', parts: [1, '2-last'] }).data?.parts).toEqual(['1', '2-last'])
  expect(SplitPdfInput.safeParse({ file_path: 'a.pdf', every: '2' }).data?.every).toBe(2)
  expect(SplitPdfInput.safeParse({ file_path: 'a.pdf', every: 'two' }).success).toBe(false)
})

// TC-5347: Claude Code hands a top-level text argument over as the model typed it, quotes included, so page "1" reached
// the server as the three characters "1" and every tool call with it failed on the live server. Checked with the real
// engine (Claude Code over MCP). Inside an object or a list the same text arrives clean.
test('a page with the quotes the model typed around it is the page', () => {
  expect(stamp('"1"').data?.page).toBe(1)
  expect(stamp("'12'").data?.page).toBe(12)
  expect(stamp('\u201c3\u201d').data?.page).toBe(3)
  expect(stamp(' "last" ').data?.page).toBe('last')
  for (const bad of ['"first"', '""', '"0"', '"1', '1"', '"1.5"']) expect(stamp(bad).success, bad).toBe(false)
  expect(SplitPdfInput.safeParse({ file_path: 'a.pdf', every: '"2"' }).data?.every).toBe(2)
  expect(SplitPdfInput.safeParse({ file_path: 'a.pdf', parts: ['"1-3"', '4-last'] }).data?.parts).toEqual(['1-3', '4-last'])
  expect(EditPdfInput.safeParse({ file_path: 'a.pdf', operations: [{ stamp_image: { image: 's.png', page: '"2"' } }, { remove_pages: '"4"' }] }).success).toBe(true)
})
