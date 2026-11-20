// The Google account a sign-in came back with, for the step that asks to connect it (a Google app's page, Google Drive's,
// and the dialogs that share one account with the team: GoogleAppTeam.tsx, DriveShares.tsx). One block: the first letter
// on a neutral circle (Google sends no picture here), the name on one line and the email below it in muted text. Each
// line is cut with … and keeps the whole text in its tooltip, so a long email never breaks mid-word (owner, 11-20).
// `onOther`: sign in again to pick another Google account (the same as the waiting line's Try again: a new sign-in).
import type { DriveFlow } from '@mycel/shared/api'

type Account = DriveFlow['account']
import { firstLetter } from '../../lib/appTone'
import { useT } from '../../i18n'
import { Button } from '../ui'

export function GoogleAccountBlock({ account, testId, onOther, busy }: { account: Account | undefined; testId: string; onOther?: () => void; busy?: boolean }) {
  const t = useT()
  const name = account?.name?.trim() || null
  const email = account?.email?.trim() || null
  const main = name ?? email ?? ''
  const block = (
    <div className="flex items-center gap-3 rounded-xl border border-line px-3 py-2.5" data-testid={testId}>
      <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-hover text-sm font-semibold text-muted" aria-hidden>{firstLetter(main)}</span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-ink" title={main}>{main}</p>
        {name && email && <p className="truncate text-xs text-muted" title={email}>{email}</p>}
      </div>
    </div>
  )
  if (!onOther) return block
  return (
    <div className="space-y-1.5">
      {block}
      <button type="button" disabled={busy} onClick={onOther} className="rounded text-xs font-medium text-accent-text hover:underline disabled:opacity-50 max-md:min-h-11" data-testid={`${testId}-other`}>
        {t('drive.otherAccount')}
      </button>
    </div>
  )
}

/** A sign-in dialog's footer: Cancel (closes it, the sign-in with it), and Connect this account once Google is back. */
export function DialogSignInActions({ ready, busy, onCancel, onConfirm, testId }: { ready: boolean; busy: boolean; onCancel: () => void; onConfirm: () => void; testId: string }) {
  const t = useT()
  return <>
    <Button onClick={onCancel} disabled={ready && busy}>{t('common.cancel')}</Button>
    {ready && <Button variant="primary" busy={busy} onClick={onConfirm} data-testid={`${testId}-confirm`}>{t('drive.confirm')}</Button>}
  </>
}
