// One notice for a conflict copy (QA TC-230). A save that met a newer version keeps the newer one and puts the saver's
// content in a copy next to it, and the server tells both people (live 'files.conflict'). The person who saved hears
// it in the first person ("내 내용은 사본으로…"), everyone else with the saver's name; the place is the folder as the
// file screen names it (전사 공유 › Notes), never a disk path. A save from this window (FilePanel) says it itself, so
// the live event for that same save is not shown again here.
import { t, currentLocale } from '../i18n'
import { useSession } from '../store/session'
import { folderWords } from './folderLabels'
import { baseName, parentPath } from './paths'

const OWN_SAVE_MS = 15_000
const ownSaves = new Map<string, number>()

/** this window is saving `path`: a conflict event for it in the next seconds is the one its own toast already told */
export function savingHere(path: string): void { ownSaves.set(path, Date.now() + OWN_SAVE_MS) }
/** the save ended without a conflict copy */
export function savedHere(path: string): void { ownSaves.delete(path) }
/** true once for a conflict this window's own save already told */
export function toldHere(path: string): boolean {
  const until = ownSaves.get(path)
  ownSaves.delete(path)
  return until !== undefined && until > Date.now()
}

function me(): string | null {
  const s = useSession.getState().status
  return s.kind === 'signed-in' ? s.me.user.id : null
}

/** The words for a conflict copy of `path`, saved by `by` (null: not known). */
export function conflictText(path: string, by: { id: string; name: string } | null): string {
  const myId = me()
  const parent = parentPath(path)
  const place = parent === '' ? t('files.root') : folderWords(currentLocale(), myId).path(parent, ' › ')
  const name = baseName(path)
  if (by && by.id === myId) return t('files.conflictNoticeMine', { name, place })
  return t('files.conflictNoticeOther', { name, place, by: by?.name ?? t('files.unknownAuthor') })
}
