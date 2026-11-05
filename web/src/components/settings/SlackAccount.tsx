// Settings › App connectors › Slack (docs/SLACK.md): one line, always there while the team uses Slack: the Slack account
// linked to me with Unlink, or how to link it (ask the app in Slack; it sends the link), or the owner's proposal to
// accept. Hidden when the team does not use Slack and nothing is linked. `onAvailable` tells the page whether it shows.
import { useEffect, useState } from 'react'
import { SLACK, type MySlack } from '@mycel/shared/api'
import { api, errorText } from '../../lib/api'
import { formatDateTime } from '../../lib/format'
import { useLocale, useT } from '../../i18n'
import { Button, ErrorNote, confirmDialog } from '../ui'

export function SlackAccount({ onShown }: { onShown?: (shown: boolean) => void }) {
  const t = useT(), locale = useLocale()
  const [me, setMe] = useState<MySlack | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let live = true
    api.call(SLACK.mySlack).then((v) => { if (live) setMe(v) }, () => {})
    return () => { live = false }
  }, [])
  const shown = !!me && (me.available || !!me.link || !!me.proposal)
  useEffect(() => { onShown?.(shown) }, [shown, onShown])
  if (!me || !shown) return null
  const answer = async (accept: boolean) => {
    if (!me.proposal) return
    setBusy(true); setError(null)
    try { setMe(await api.call(accept ? SLACK.acceptSlackProposal : SLACK.declineSlackProposal, { params: { id: me.proposal.id }, body: {} })) }
    catch (e) { setError(errorText(e, locale, t('error.network'))) } finally { setBusy(false) }
  }
  const unlink = async () => {
    if (!(await confirmDialog({ title: t('slack.mine.unlinkTitle'), body: t('slack.mine.unlinkBody'), confirm: t('slack.mine.unlink'), danger: true }))) return
    setBusy(true); setError(null)
    try { setMe(await api.call(SLACK.unlinkSlack)) } catch (e) { setError(errorText(e, locale, t('error.network'))) } finally { setBusy(false) }
  }
  const p = !me.link ? me.proposal : null
  return (
    <div className="space-y-2 border-t border-line pt-4" data-testid="slack-account">
      {error && <ErrorNote>{error}</ErrorNote>}
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1 text-sm">
          <p className="font-medium">Slack</p>
          {me.link ? (
            <p className="mt-1 text-xs text-muted">
              {t('slack.mine.linked', { name: me.link.slackName ?? me.link.slackUserId, workspace: me.workspace ?? '' })}
              <span className="mt-0.5 block text-faint">{t('slack.mine.since', { date: formatDateTime(me.link.linkedAt, locale) })}</span>
            </p>
          ) : p ? (
            // the owner proposed a Slack account: linked once I accept it here and open the link it gets in Slack
            <div className="mt-1 space-y-2" data-testid="slack-proposal">
              <p>{t('slack.mine.proposal')} <span className="font-medium">{p.slack.name ?? p.slack.realName ?? p.slack.handle ?? p.slack.userId}</span>
                <span className="block text-xs text-muted">{[p.slack.realName, p.slack.handle ? `@${p.slack.handle}` : null, p.slack.email ?? t('slack.people.noEmail')].filter(Boolean).join(' · ')}</span></p>
              {p.memberAccepted
                ? !p.slackConfirmed && <p className="text-xs" data-testid="slack-proposal-slack-half">{t('slack.mine.proposalSlackHalf')}</p>
                : <p className="text-xs text-warn">{t('slack.mine.proposalWarning')}</p>}
            </div>
          ) : (
            <>
              <p className="mt-1 text-xs text-muted">{t('slack.mine.how', { workspace: me.workspace ?? '' })}</p>
              {me.emailSetByOther && <p className="mt-1 text-xs text-warn" data-testid="slack-email-set-by-other">{t('slack.mine.emailSetByOther')}</p>}
            </>
          )}
        </div>
        {me.link && <Button variant="danger" size="sm" busy={busy} disabled={busy} onClick={() => void unlink()} data-testid="slack-unlink">{t('slack.mine.unlink')}</Button>}
      </div>
      {p && (
        <div className="flex items-center gap-3">
          {!p.memberAccepted && <Button variant="primary" size="sm" busy={busy} disabled={busy} onClick={() => void answer(true)} data-testid="slack-proposal-accept">{t('slack.link.confirm')}</Button>}
          <button type="button" className="text-xs text-muted underline underline-offset-2 disabled:opacity-50" disabled={busy} onClick={() => void answer(false)} data-testid="slack-proposal-decline">{t('slack.mine.decline')}</button>
        </div>
      )}
    </div>
  )
}
