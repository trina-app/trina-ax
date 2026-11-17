// A file in a conversation refused because the team's disk is full (docs/decisions/20261116-storage-full-notices.md):
// 507 storage_full (the storage guard: hosted, Linux, a plan), or 413 from an upload session on a disk without room
// (uploads/sessions.ts, reason 'disk_full'; a Mac without a plan). The shared storage_full sentence ("Empty the trash or
// clean up files") is for places where the person can do that; in a conversation a member or guest can do neither, so
// the chip says who can help, and the owner and admins get the storage card.
import { Link } from 'react-router-dom'
import type { Locale } from '@mycel/shared/api'
import { isApiError } from '../../lib/api'
import { translate, useT } from '../../i18n'
import { StoragePlansLink } from '../StoragePlansLink'

/** a refusal for lack of space (not the 1 GB limit: that 413 has reason 'room_file_too_large') */
export function isStorageFull(e: unknown): boolean {
  if (isApiError(e, 'storage_full')) return true
  return isApiError(e, 'payload_too_large') && e.body.params?.reason === 'disk_full'
}

/** The chip's words, by role: a member or guest is told to ask an admin; the owner or an admin gets the link below. */
export function storageFullText(admin: boolean, locale: Locale): string {
  return translate(locale, admin ? 'rooms.storageFull' : 'rooms.storageFullAsk')
}

/** After a refused file's words, in the same line of text so it wraps with them (a phone's chip has no room for a row
 * of links): "See what uses the space" for the owner and admins when the disk is full, and a hosted team's "Choose a
 * plan" (StoragePlansLink, also the owner's and admins' only). Nothing for a member or guest. */
export function RefusalLinks({ full, plans }: { full: boolean; plans?: string }) {
  const t = useT()
  return (
    <>
      {full && (
        <>
          {' '}
          <Link to="/admin/system/storage" className="font-medium whitespace-nowrap text-accent-text underline" data-testid="room-storage-full-see">
            {t('rooms.storageFullSee')}
          </Link>
        </>
      )}
      {plans && <>{' '}<StoragePlansLink url={plans} /></>}
    </>
  )
}
