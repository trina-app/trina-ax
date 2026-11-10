// Where make_file saves (tools/make-file.ts), apart so the chat turn's skill-save card (chat/turn.ts confirmSkillWrite)
// asks about the same path without loading the converters.
import { ext } from '../files/extract'

/** Where make_file saves: its output without a trailing slash, with the format's extension added when it has another
 * ("x.md" as docx is "x.md.docx"). */
export function makeFileOutputPath(output: string, format: string): string {
  const rel = output.replace(/\/+$/, '')
  return ext(rel) === format ? rel : `${rel}.${format}`
}
