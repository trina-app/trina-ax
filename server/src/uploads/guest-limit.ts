// The largest file a guest may upload (docs/decisions/20261116-guest-room-file-limit.md): the team's choice
// (TeamSettings.guestFileMax: 100 MB unless the owner or an admin raised it to 1 GB or 10 GB), for every upload a guest
// makes: a file sent in a room, a file put in their project's folder, a file attached to an AI chat. Read from the
// person's role and the setting at every upload, where an upload starts and again where its file is kept, so a limit
// lowered meanwhile holds. Members are not limited here (each kind of upload has its own limit).
import type { Database } from 'bun:sqlite'
import { GUEST_FILE_MAX } from '@mycel/shared/api'
import { getTeamSettings } from '../admin/settings'
import { tr } from '../chat/i18n'
import { isGuestUser } from '../credentials/guest-ai'
import { personLocale } from '../files/media-text'
import { HttpError } from '../http/errors'

/** The guest's limit in bytes, or null for anyone who is not a guest. A stored value that is not one of the choices
 * counts as the smallest. */
export function guestUploadMax(db: Database, userId: string): number | null {
  if (!isGuestUser(db, userId)) return null
  return GUEST_FILE_MAX[getTeamSettings(db).guestFileMax] ?? GUEST_FILE_MAX['100mb']
}

/** "100 MB", "1 GB" */
export const sizeWords = (bytes: number) => (bytes >= 1024 ** 3 ? `${bytes / 1024 ** 3} GB` : `${bytes / 1024 ** 2} MB`)

/** 413 for a guest's file over their limit, in plain words with that limit ("This file is too big. As a guest you can
 * upload files up to 100 MB."); nothing for a member or a file that fits. */
export function assertGuestUploadSize(db: Database, userId: string, size: number): void {
  const max = guestUploadMax(db, userId)
  if (max === null || size <= max) return
  throw new HttpError('payload_too_large', tr('guestFileTooBig', personLocale(db, userId), { max: sizeWords(max) }), { params: { reason: 'guest_file_too_large', maxBytes: max } })
}
