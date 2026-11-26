// The problem report sheet's preview (components/ProblemReportSheet.tsx, lib/problemReport.ts reportPreviewText): a
// file link in the answer reads as the file's name, never its "/files/view?path=users%2F…" address (QA after #651).
import { expect, test } from 'bun:test'
import { reportPreviewText } from '../../src/lib/problemReport'

test('a Markdown file link keeps its words; one with none reads as the file name', () => {
  expect(reportPreviewText('See [weekly report](/files/view?path=users%2Fqa-admin%2Freports%2Fweekly.md).')).toBe('See weekly report.')
  expect(reportPreviewText('[](/files/view?path=shared%2F%EA%B2%AC%EC%A0%81%EC%84%9C.pdf&page=2)')).toBe('견적서.pdf')
})

test('a bare address, with the server\'s origin or a download route, reads as the file name; the sentence keeps its full stop', () => {
  expect(reportPreviewText('Saved at /files/view?path=users%2Fqa-admin%2F%EB%B3%B4%EA%B3%A0%EC%84%9C.md.')).toBe('Saved at 보고서.md.')
  expect(reportPreviewText('https://qa.trina.app/api/files/download?path=shared%2Fa%20b.xlsx, done')).toBe('a b.xlsx, done')
})

test('anything else stays as written', () => {
  for (const s of ['no links here', '[a site](https://example.com/files/x)', '/files/view?nopath=1', 'users/qa-admin/reports']) expect(reportPreviewText(s)).toBe(s)
})
