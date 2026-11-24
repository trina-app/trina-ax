// Settings › Profile › Delete account (/settings/account/delete; contract: shared/src/api/account-deletion.ts; App Store
// review 5.1.1(v) and Google Play: an app with accounts lets people delete them inside the app, and the phone app shows
// this page in its web view). The account is deleted by the server ACCOUNT_DELETION_GRACE_DAYS after the person asks
// (docs/DECISIONS.md "Self-service account deletion"). The page: the date it would be deleted, a short plain list of
// what goes, what moves to the owner and what stays (and for how long), and one button that asks for the password
// (ReauthDialog). Once asked: the date and a button to keep the account. The owner, who cannot ask, is sent to Members
// to hand the team over. The inbox entry of the owners and admins is deletionNoticeText (components/settings/
// Notifications.tsx), the person's own date notice deletionDueText.
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ACCOUNT_DELETION_GRACE_DAYS, type AccountDeletionRequest, type InboxNotification } from '@mycel/shared/api'
import { api, API, errorText } from '../../lib/api'
import { formatDate } from '../../lib/format'
import { useLocale, useT } from '../../i18n'
import { useMe, useMeStrict } from '../../store/session'
import { meGuest } from '../../lib/guests'
import { toast } from '../../store/ui'
import { ReauthDialog } from '../../pages/admin/common'
import { Button, ErrorNote, Skeleton } from '../ui'

type T = ReturnType<typeof useT>
type L = ReturnType<typeof useLocale>

/** the activity log's default keeping (Admin › Team settings), for an older server that does not say */
const DEFAULT_AUDIT_DAYS = 90

/** The owners' and admins' inbox text: who asks and on which date it goes while the account is there, and whether it
 * was taken back or done. */
export function deletionNoticeText(t: T, item: Pick<InboxNotification, 'deletionRequest'>, locale: L = 'en'): string {
  const d = item.deletionRequest
  if (d?.state === 'handled') return t('accountDeletion.noticeHandled')
  if (d?.name && d.state === 'cancelled') return t('accountDeletion.noticeCancelled', { name: d.name })
  if (d?.name && d.dueAt) return t('accountDeletion.noticeDue', { name: d.name, date: formatDate(d.dueAt, locale) })
  if (d?.name) return t('accountDeletion.notice', { name: d.name })
  return t('notifications.event.account.deletion_request')
}

/** The person's own inbox text when their open request got its date (a request from before automatic deletion). */
export function deletionDueText(t: T, item: Pick<InboxNotification, 'deletionDue'>, locale: L = 'en'): string {
  const due = item.deletionDue?.dueAt
  return due ? t('accountDeletion.dueNotice', { date: formatDate(due, locale) }) : t('accountDeletion.dueNoticeClosed')
}

/** Settings › Profile's "Delete account" row (TC-1976): while a deletion is pending it says the date and offers "Keep
 * my account" there, not "Delete my account" again; otherwise (no request, the owner, not read yet) the link to the page. */
export function deletionRowText(t: T, value: AccountDeletionRequest | null, locale: L = 'en'): { hint: string; keep: boolean } {
  if (value?.state === 'pending') {
    return { keep: true, hint: value.dueAt ? t('accountDeletion.pending', { date: formatDate(value.dueAt, locale) }) : t('accountDeletion.pendingAsked', { date: formatDate(value.requestedAt, locale) }) }
  }
  return { keep: false, hint: t('accountDeletion.rowHint', { days: ACCOUNT_DELETION_GRACE_DAYS }) }
}

/** The person's own deletion request (null until read, or when it could not be read) and "Keep my account" (the page
 * and the profile row share it). */
export function useMyDeletionRequest() {
  const t = useT()
  const locale = useLocale()
  const [value, setValue] = useState<AccountDeletionRequest | null>(null)
  const [busy, setBusy] = useState(false)
  const keep = async () => {
    if (busy) return
    setBusy(true)
    try {
      setValue(await api.call(API.cancelAccountDeletion))
      toast({ level: 'success', text: t('accountDeletion.cancelled') })
    } catch (e) {
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
    } finally {
      setBusy(false)
    }
  }
  return { value, setValue, busy, keep }
}

/** What happens, in plain lines: the same list before and after asking. */
function WhatHappens({ value, viewerIsAdmin }: { value: AccountDeletionRequest; viewerIsAdmin: boolean }) {
  const t = useT()
  // a guest (lib/guests.ts) has none of a member's things (team folders, shared skills, scheduled tasks or app
  // connections): only their account, their chats with the AI when it is on for them, the files they saved in "Your
  // files", and what they sent in their group chat and their project, which stays
  const guest = meGuest(useMe())
  const lines = guest ? [
    t('accountDeletion.told'),
    t(guest.ai === 'own' ? 'accountDeletion.goesGuestOwn' : guest.ai === 'team' ? 'accountDeletion.goesGuestAi' : 'accountDeletion.goesGuest'),
    // their own folder ("Your files" in the pickers): what they saved there goes to the owner's archive, as a member's
    t('accountDeletion.folderGuest'),
    // what stays in each of their places: their group chat and/or their project (a group chat when the server names none)
    ...(guest.room || !guest.project ? [t('accountDeletion.staysGuestRoom', { place: guest.room?.name ? t('accountDeletion.placeNamed', { name: guest.room.name }) : t('accountDeletion.guestRoom') })] : []),
    ...(guest.project ? [t('accountDeletion.staysGuestProject', { place: guest.project.name ? t('accountDeletion.placeNamed', { name: guest.project.name }) : t('accountDeletion.guestProject') })] : []),
    t('accountDeletion.kept', { days: value.auditDays ?? DEFAULT_AUDIT_DAYS }),
  ] : [
    t(viewerIsAdmin ? 'accountDeletion.toldAdmin' : 'accountDeletion.told'),
    t('accountDeletion.goes'),
    t('accountDeletion.folder'),
    t('accountDeletion.stays'),
    t('accountDeletion.kept', { days: value.auditDays ?? DEFAULT_AUDIT_DAYS }),
  ]
  return (
    <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted" data-testid="account-deletion-what">
      {lines.map((l) => <li key={l}>{l}</li>)}
    </ul>
  )
}

/** The page's content for one state (no requests of its own: AccountDeletion loads and sends). `now`: for the date
 * the account would be deleted if asked now. */
export function AccountDeletionView({ value, busy, onRequest, onCancel, viewerIsAdmin = false, hosted = false, now = Date.now() }: { value: AccountDeletionRequest; viewerIsAdmin?: boolean; hosted?: boolean; busy: boolean; onRequest: () => void; onCancel: () => void; now?: number }) {
  const t = useT()
  const locale = useLocale()
  const would = formatDate(new Date(now + ACCOUNT_DELETION_GRACE_DAYS * 86_400_000).toISOString(), locale)
  return (
    <div className="space-y-4" data-testid={`account-deletion-${value.state}`}>
      {value.state === 'owner' ? (
        <>
          <p className="text-sm text-muted">{t('accountDeletion.owner')}</p>
          {hosted && <p className="text-sm text-muted" data-testid="account-deletion-owner-hosted">{t('accountDeletion.ownerHosted')}</p>}
          <Link to="/admin/members" className="inline-block text-sm text-accent-text underline-offset-2 hover:underline" data-testid="account-deletion-transfer">
            {t('accountDeletion.transfer')}
          </Link>
        </>
      ) : value.state === 'pending' ? (
        <>
          <p className="text-sm font-medium" data-testid="account-deletion-date">
            {value.dueAt ? t('accountDeletion.pending', { date: formatDate(value.dueAt, locale) }) : t('accountDeletion.pendingAsked', { date: formatDate(value.requestedAt, locale) })}
          </p>
          <WhatHappens value={value} viewerIsAdmin={viewerIsAdmin} />
          <Button busy={busy} onClick={onCancel} data-testid="account-deletion-cancel">
            {t('accountDeletion.cancel')}
          </Button>
        </>
      ) : (
        <>
          <p className="text-sm font-medium" data-testid="account-deletion-date">{t('accountDeletion.when', { date: would, days: ACCOUNT_DELETION_GRACE_DAYS })}</p>
          <WhatHappens value={value} viewerIsAdmin={viewerIsAdmin} />
          <Button variant="danger" busy={busy} onClick={onRequest} data-testid="account-deletion-request">
            {t('accountDeletion.request')}
          </Button>
        </>
      )}
    </div>
  )
}

export function AccountDeletion() {
  const t = useT()
  const locale = useLocale()
  const me = useMeStrict()
  const { value, setValue, busy, keep } = useMyDeletionRequest()
  const [error, setError] = useState<string | null>(null)
  const [asking, setAsking] = useState(false)
  const load = async () => {
    try {
      setValue(await api.call(API.myDeletionRequest))
      setError(null)
    } catch (e) {
      setError(errorText(e, locale, t('error.network')))
    }
  }
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    // the way back is the dialog's: Profile stays marked in its list, and a phone's back arrow goes to Profile
    <section data-testid="account-deletion">
      <h2 className="mb-3 text-title font-semibold">{t('accountDeletion.title')}</h2>
      {error && <ErrorNote onRetry={() => void load()}>{error}</ErrorNote>}
      {!value && !error && <Skeleton lines={2} />}
      {value && <AccountDeletionView value={value} busy={busy} onRequest={() => setAsking(true)} onCancel={() => void keep()} viewerIsAdmin={me.user.role === 'admin'} hosted={me.server.deployment === 'hosted'} />}
      {asking && (
        <ReauthDialog
          danger
          title={t('accountDeletion.confirmTitle')}
          body={t('accountDeletion.confirmBody', { date: formatDate(new Date(Date.now() + ACCOUNT_DELETION_GRACE_DAYS * 86_400_000).toISOString(), locale) })}
          confirm={t('accountDeletion.request')}
          onClose={() => setAsking(false)}
          onConfirm={async (proof) => {
            try {
              const v = await api.call(API.requestAccountDeletion, { body: { confirm: true, ...proof } })
              setValue(v)
              setAsking(false)
              toast({ level: 'success', text: v.dueAt ? t('accountDeletion.sent', { date: formatDate(v.dueAt, locale) }) : t('accountDeletion.sentUndated') })
              return null
            } catch (e) {
              return errorText(e, locale, t('error.network'))
            }
          }}
        />
      )}
    </section>
  )
}
