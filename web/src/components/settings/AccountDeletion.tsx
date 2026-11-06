// Settings › Profile › 계정 삭제 요청 (/settings/account/delete; contract: shared/src/api/account-deletion.ts; App Store
// review 5.1.1(v): an app with accounts lets people start the deletion inside the app, and the phone app shows this
// page in its web view). The team owner deletes accounts, so the page asks the owner: one short paragraph of what
// happens and one button; once asked, when it was asked and a cancel; the owner, who cannot ask, is sent to Team
// settings to make someone else the owner. The owners' inbox entry is deletionNoticeText (components/settings/
// Notifications.tsx); the owner deletes the account in Admin › Members.
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { AccountDeletionRequest, InboxNotification } from '@mycel/shared/api'
import { api, API, errorText } from '../../lib/api'
import { chatTrashDays } from '../../lib/chat-trash'
import { formatDateTime } from '../../lib/format'
import { useLocale, useT } from '../../i18n'
import { useMeStrict } from '../../store/session'
import { toast } from '../../store/ui'
import { Button, ErrorNote, Skeleton } from '../ui'

type T = ReturnType<typeof useT>

/** The owners' inbox text: who asks while the account is there, and whether it was taken back or done. */
export function deletionNoticeText(t: T, item: Pick<InboxNotification, 'deletionRequest'>): string {
  const d = item.deletionRequest
  if (d?.state === 'handled') return t('accountDeletion.noticeHandled')
  if (d?.name && d.state === 'cancelled') return t('accountDeletion.noticeCancelled', { name: d.name })
  if (d?.name) return t('accountDeletion.notice', { name: d.name })
  return t('notifications.event.account.deletion_request')
}

/** The page's content for one state (no requests of its own: AccountDeletion loads and sends). */
export function AccountDeletionView({ value, days, busy, onRequest, onCancel }: { value: AccountDeletionRequest; days: number; busy: boolean; onRequest: () => void; onCancel: () => void }) {
  const t = useT()
  const locale = useLocale()
  return (
    <div className="space-y-4" data-testid={`account-deletion-${value.state}`}>
      {value.state === 'owner' ? (
        <>
          <p className="text-sm text-muted">{t('accountDeletion.owner')}</p>
          <Link to="/admin/settings" className="inline-block text-sm text-accent-text underline-offset-2 hover:underline" data-testid="account-deletion-transfer">
            {t('accountDeletion.transfer')}
          </Link>
        </>
      ) : value.state === 'pending' ? (
        <>
          <p className="text-sm text-muted">{t('accountDeletion.pending', { date: value.requestedAt ? formatDateTime(value.requestedAt, locale) : '' })}</p>
          <Button busy={busy} onClick={onCancel} data-testid="account-deletion-cancel">
            {t('accountDeletion.cancel')}
          </Button>
        </>
      ) : (
        <>
          <p className="text-sm text-muted">{t('accountDeletion.body', { days })}</p>
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
  const [value, setValue] = useState<AccountDeletionRequest | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
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
  const send = async (cancel: boolean) => {
    if (busy) return
    setBusy(true)
    try {
      setValue(cancel ? await api.call(API.cancelAccountDeletion) : await api.call(API.requestAccountDeletion, { body: { confirm: true } }))
      toast({ level: 'success', text: t(cancel ? 'accountDeletion.cancelled' : 'accountDeletion.sent') })
    } catch (e) {
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
    } finally {
      setBusy(false)
    }
  }
  return (
    // the way back is the dialog's: Profile stays marked in its list, and a phone's back arrow goes to Profile
    <section data-testid="account-deletion">
      <h2 className="mb-3 text-base font-semibold">{t('accountDeletion.title')}</h2>
      {error && <ErrorNote onRetry={() => void load()}>{error}</ErrorNote>}
      {!value && !error && <Skeleton lines={2} />}
      {value && <AccountDeletionView value={value} days={chatTrashDays(me)} busy={busy} onRequest={() => void send(false)} onCancel={() => void send(true)} />}
    </section>
  )
}
