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

/** The link itself, for the owner and admins only (the GuestInvite "See plans" rule: admin && manageUrl). `phoneLine`:
 * in a wrapping row (flex-wrap), on a phone the link and what follows it start a line of their own, so a long refusal,
 * the link, Try again and ✕ never run past a 390 px screen (QA TC-1969 walk: the file screen's row did). */
export function StoragePlansLink({ url, className = '', phoneLine = false }: { url?: string; className?: string; phoneLine?: boolean }) {
  const t = useT()
  const me = useMe()
  if (!url || !isAdmin(me)) return null
  return (
    <>
      {phoneLine && <span aria-hidden className="h-0 basis-full sm:hidden" data-testid="storage-plans-break" />}
      <a href={url} target="_blank" rel="noreferrer" className={`shrink-0 font-medium whitespace-nowrap text-accent-text underline ${phoneLine ? 'max-sm:ml-5' : ''} ${className}`} data-testid="storage-plans">
        {t('storage.choosePlan')}
      </a>
    </>
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
