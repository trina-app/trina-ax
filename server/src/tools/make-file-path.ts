// Where make_file and the PDF and Word tools save (tools/make-file.ts, pdf-tools.ts, stamp-pdf.ts, comment-docx.ts), apart
// so the chat turn's cards (chat/turn.ts confirmSkillWrite, the shared chat's save card through rooms/ai-tools.ts
// OUTPUT_PATH_OF) ask about the same path without loading the converters.
import { ext } from '../files/extract'

/** Where make_file saves: its output without a trailing slash, with the format's extension added when it has another
 * ("x.md" as docx is "x.md.docx"). */
export function makeFileOutputPath(output: string, format: string): string {
  const rel = output.replace(/\/+$/, '')
  return ext(rel) === format ? rel : `${rel}.${format}`
}

/** Where edit_pdf and merge_pdfs save a given output: trimmed, no trailing slash, ".pdf" added when missing
 * (pdf-tools.ts target). */
export function pdfOutputPath(output: string): string {
  const o = output.trim().replace(/\/+$/, '')
  return /\.pdf$/i.test(o) ? o : `${o}.pdf`
}

/** Where stamp_pdf saves a given output (null: none given, a new file next to the original). */
export function stampOutputOf(output: unknown): string | null {
  if (typeof output !== 'string' || output.trim() === '') return null
  const o = output.trim()
  return /\.pdf$/i.test(o) ? o : `${o.replace(/\/+$/, '')}.pdf`
}

/** Where comment_docx saves a given output: a .docx ("x" and "x/" save x.docx). */
export const commentDocxOutput = (o: string) => (ext(o) === 'docx' ? o : `${o.replace(/\/+$/, '')}.docx`)

/** Where edit_office saves a given output: the source's format ("x" and "x/" save x.docx for a .docx; tools/edit-office.ts). */
export const editOfficeOutput = (o: string, src: string) => { const x = ext(src); return ext(o) === x ? o : `${o.replace(/\/+$/, '')}.${x}` }
