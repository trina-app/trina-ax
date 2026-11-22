// Who loses their changes from the latest content when a team file goes back to an earlier version (Files › version
// history, QA TC-7246): the people other than me who made a version after the restored one. Their versions stay in the
// history; the restore confirm names them so the person restoring knows whose work drops out of the file.
import type { ChatFileVersion, FileVersion, HistoryResponse, Locale, UserRef } from '@mycel/shared/api'
import { intlTag } from './format'

type Current = Pick<NonNullable<HistoryResponse['current']>, 'author'>

/** The people (newest first, each once, never `meId`) who made a version newer than `restored`. A stored version's
 * `savedBy` made it; its `author` replaced it, so made the next one; the current content's `author` made it. Someone not
 * known (an AI with no person, a change outside the app) is left out. */
export function restoreDropouts(items: readonly FileVersion[], current: Current | null | undefined, restored: number, meId: string): UserRef[] {
  const made: { v: number; who: UserRef | null | undefined }[] = []
  for (const it of items) {
    if (it.version > restored) made.push({ v: it.version, who: it.savedBy })
    if (it.version >= restored) made.push({ v: it.version + 1, who: it.author })
  }
  if (current) made.push({ v: Number.MAX_SAFE_INTEGER, who: current.author })
  const out: UserRef[] = []
  const seen = new Set<string>([meId])
  for (const m of made.sort((a, b) => b.v - a.v)) {
    if (!m.who || seen.has(m.who.id)) continue
    seen.add(m.who.id)
    out.push(m.who)
  }
  return out
}

/** A chat file's versions (the chat file panel's restore, QA TC-v1c-01): the people (newest first, each once, never
 * `meId`) who saved a version newer than `restored`, an AI version as the person whose answer saved it. */
export function chatRestoreDropouts(items: readonly Pick<ChatFileVersion, 'version' | 'by' | 'byName'>[], restored: number, meId: string): UserRef[] {
  const out: UserRef[] = []
  const seen = new Set<string>([meId])
  for (const v of [...items].sort((a, b) => b.version - a.version)) {
    if (v.version <= restored || !v.by || !v.byName || seen.has(v.by)) continue
    seen.add(v.by)
    out.push({ id: v.by, name: v.byName })
  }
  return out
}

/** "Jiwoo and Junho" in the reader's language */
export function nameList(locale: Locale, people: readonly UserRef[]): string {
  const names = people.map((p) => p.name)
  try { return new Intl.ListFormat(intlTag(locale) ?? locale, { type: 'conjunction' }).format(names) } catch { return names.join(', ') }
}
