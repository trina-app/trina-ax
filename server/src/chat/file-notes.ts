// Facts a file tool's result carries for the AI, at the moment it needs them (AI scenario rerun on dev, 2026-11-17):
// - an edit (edit, or write over an existing file) keeps the version before it in the file's history
//   (files/store.ts saveVersion), but the result only said "Edited <path>", so the answer never told the person that
//   the old text is still there (EDIT-17);
// - a Hangul document read while Hangul writing is off (the HWP plugin, tools/hwp-writing.ts): the AI read the
//   agreement, saw it could not change it, and asked "shall I make a Word copy?" instead of making it (EDIT-07).
// Each note once a turn, so a batch of edits (edit_files runs each file as an edit) does not repeat it.
import type { Locale } from '@mycel/shared/api'
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
