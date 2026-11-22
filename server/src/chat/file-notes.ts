// Facts a file tool's result carries for the AI, at the moment it needs them (AI scenario rerun on dev, 2026-11-17):
// - an edit (edit, or write over an existing file) keeps the version before it in the file's history
//   (files/store.ts saveVersion), but the result only said "Edited <path>", so the answer never told the person that
//   the old text is still there (EDIT-17);
// - a Hangul document read while Hangul writing is off (the HWP plugin, tools/hwp-writing.ts): the AI read the
//   agreement, saw it could not change it, and asked "shall I make a Word copy?" instead of making it (EDIT-07).
// Each note once a turn, so a batch of edits (edit_files runs each file as an edit) does not repeat it.
import type { Locale } from '@mycel/shared/api'
import { isReservedPlace } from '@mycel/shared/places'
import { SCREEN } from '../policy/refusal'

export type FileNoteKind = 'version' | 'hangul'

/** The version note, in the words of the person's app (the screen names are theirs). */
export const versionKeptNote = (L: Locale) =>
  `The version before this change is kept: the user can bring it back from ${SCREEN.fileHistory(L)}. Say so in one short sentence.`

/** The note on a Hangul document read while Hangul writing is off. */
export const hangulReadNote = () =>
  'Hangul writing is off for this team, so this file cannot be changed or filled here. If the user asked for a change to it, do not ask first: make a Word copy with the change now (make_file, format docx, next to the original, with the same content and only the asked change), then say in one sentence that Hangul writing is off and the owner or an admin can turn it on.'

/** A file tool's note for this turn, or null: `name`, its arguments and its result text as the file layer gave them. */
export function fileNote(o: { name: string; isError: boolean; args: unknown; text?: string; hangulOff: () => boolean; makeFile: boolean }): FileNoteKind | null {
  if (o.isError) return null
  const filePath = (o.args as { file_path?: unknown } | null)?.file_path
  // a chat file's new version says where its versions are itself (chat/chat-file-write.ts): not the Files screen's
  if (typeof filePath === 'string' && isReservedPlace(filePath)) return null
  if (o.name === 'edit' && o.text?.startsWith('Edited ')) return 'version'
  if (o.name === 'write' && o.text?.startsWith('Updated ')) return 'version'
  if (o.name === 'read' && o.makeFile && typeof filePath === 'string' && /\.hwpx?$/i.test(filePath.trim()) && o.hangulOff()) return 'hangul'
  return null
}

const given = new WeakMap<object, Set<FileNoteKind>>()

/** The note's text the first time this turn (`turn`: the turn's own object), else null. */
export function fileNoteOnce(turn: object, kind: FileNoteKind | null, L: Locale): string | null {
  if (!kind) return null
  const seen = given.get(turn) ?? new Set<FileNoteKind>()
  given.set(turn, seen)
  if (seen.has(kind)) return null
  seen.add(kind)
  return kind === 'version' ? versionKeptNote(L) : hangulReadNote()
}

/** A table of data whose numbers a page, chart or report is made from (QA TC-b3s-7 / S-102: the dashboard showed
 * "출처: …xlsx" and no date, so after the file changed nobody could tell which numbers it showed). */
const DATA_FILE = /\.(?:xlsx|xlsm|xls|ods|csv|tsv)$/i

/** The file's last change in the person's shown time zone ("2026-11-22 14:03 (Asia/Seoul)": a time in a tool result
 * with no zone is UTC to the AI, prompt.ts time line), for a read of a spreadsheet or CSV team file (never a chat place:
 * its card says when it came), or null. */
export function dataDateNote(o: { name: string; isError: boolean; args: unknown; changed: (path: string) => string | null }): { path: string; text: string } | null {
  if (o.isError || o.name !== 'read') return null
  const p = (o.args as { file_path?: unknown } | null)?.file_path
  if (typeof p !== 'string' || isReservedPlace(p) || !DATA_FILE.test(p.trim())) return null
  const at = o.changed(p)
  if (!at) return null
  return { path: p.trim().normalize('NFC'), text: `This file was last changed ${at}. A page, chart or report you make from it shows that as the date of its data next to the source (e.g. "Source: <file name>, as of ${at.slice(0, 10)}").` }
}
