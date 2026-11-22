// A search for a file that found nothing, while a file of that name is in the trash (QA TC-7242, scenario QA 11-22):
// the AI ran four searches and said the deck "could not be found", although a teammate had put it in the trash that day.
// The glob result now ends with the trashed files the pattern matches, as the person's own Trash screen lists them
// (TeamFiles.trash: only what they could restore), so the AI says where it is and how to get it back.
//
// The main AI of the person's own chat only (chat/tools.ts afterFileTool): a shared chat's people may not see what the
// asker's Trash holds, and a guest has no Files screen.
import type { Locale } from '@mycel/shared/api'
import { componentC } from '../team-files/component'
import { SCREEN } from '../policy/refusal'
import type { AppContext } from '../context'

/** trashed files named in one note */
export const TRASH_HINT_MAX = 5
/** trash rows looked through for one note (the newest first) */
const TRASH_SCAN = 200

/** The pattern's last part as a test on a file name, without letter case ("**\/*교육자료*.pptx" -> *교육자료*.pptx). */
function nameTest(pattern: string): ((name: string) => boolean) | null {
  const last = pattern.normalize('NFC').split('/').filter(Boolean).pop()
  // a wide pattern ("*.pptx", "**/*") names nothing: two letters or more besides wildcards and the extension
  if (!last || last.replace(/\.[A-Za-z0-9{},]{1,12}$/, '').replace(/[*?[\]{}!,]/g, '').length < 2) return null
  try { const g = new Bun.Glob(last.toLowerCase()); return (n) => g.match(n.normalize('NFC').toLowerCase()) } catch { return null }
}

/** The note for a glob of `pattern` that found nothing, or null. */
export function trashHint(ctx: AppContext, userId: string, pattern: unknown, locale: Locale): string | null {
  if (typeof pattern !== 'string') return null
  const test = nameTest(pattern)
  if (!test) return null
  let items
  try { items = componentC(ctx).files.trash(userId, { limit: TRASH_SCAN }).items } catch { return null }
  const hits = items.filter((t) => t.type !== 'folder' && test(t.originalPath.split('/').pop() ?? '')).slice(0, TRASH_HINT_MAX)
  if (!hits.length) return null
  const line = (t: (typeof hits)[number]) => `${t.originalPath} (deleted by ${t.deletedBy?.name ?? "someone"} at ${t.deletedAt.slice(0, 16).replace('T', ' ')} UTC, kept until ${t.purgeAt.slice(0, 10)})`
  return `Nothing found outside the trash, but the trash holds: ${hits.map(line).join('; ')}. Tell the user it is in the trash, not that it does not exist; they can restore it on ${SCREEN.trash(locale)}.`
}
