// "Choose a plan" after a storage-full upload refusal (QA TC-1969): the owner and admins can make room by moving to a
// bigger plan, so the refusal links the plan page the server names; members keep the plain line (they cannot change
// the plan). Every place that shows the refusal of a file going up uses it: the file screen's rows, a folder upload,
// a chat's and a room's attachments, the welcome step's files.
import { isApiError } from '../lib/api'
import { noPurchaseLinks } from '../lib/desktop'
import { t as tNow, useT } from '../i18n'
import { isAdmin, useMe, useSession } from '../store/session'

/** The plan page a 507 storage_full names (server/src/system/storage.ts assertStorageRoom params.manageUrl), or
 * undefined: another error, no page (a team without a plan page), or a store app, which shows no purchase link
 * (lib/desktop.ts noPurchaseLinks; lib/api.ts storeSafeError only words the 409 seat refusal, so it is dropped here). */
export function storagePlansUrl(e: unknown, store = noPurchaseLinks()): string | undefined {
  if (store || !isApiError(e, 'storage_full')) return undefined
  const url = e.body.params?.manageUrl
  return typeof url === 'string' && /^https?:\/\//.test(url) ? url : undefined
}

/** The link itself, for the owner and admins only (the GuestInvite "See plans" rule: admin && manageUrl). */
export function StoragePlansLink({ url, className = '' }: { url?: string; className?: string }) {
  const t = useT()
  const me = useMe()
  if (!url || !isAdmin(me)) return null
  return (
    <a href={url} target="_blank" rel="noreferrer" className={`shrink-0 font-medium whitespace-nowrap text-accent-text underline ${className}`} data-testid="storage-plans">
      {t('storage.choosePlan')}
    </a>
  )
}

/** The same link as a toast's action (a folder upload that stopped says so in a toast as well as on its row): the
 * owner and admins only, read when the refusal comes. */
export function storagePlansAction(e: unknown): { action: { label: string; run: () => void } } | Record<string, never> {
  const url = storagePlansUrl(e)
  const s = useSession.getState().status
  if (!url || s.kind !== 'signed-in' || !isAdmin(s.me)) return {}
  return { action: { label: tNow('storage.choosePlan'), run: () => void window.open(url, '_blank', 'noopener,noreferrer') } }
}
