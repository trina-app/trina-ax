// Settings › App connectors › Slack (docs/SLACK.md): the Slack account linked to me, with Unlink; or, when the team
// uses Slack and nothing is linked, how to link (ask the app in Slack; it sends the link). Hidden when the team does not
// use Slack and nothing is linked.
import { useEffect, useState } from 'react'
import { SLACK, type MySlack } from '@mycel/shared/api'
import { api, errorText } from '../../lib/api'
import { formatDateTime } from '../../lib/format'
import { useLocale, useT } from '../../i18n'
import { Button, ErrorNote, confirmDialog } from '../ui'

export function SlackAccount() {
  const t = useT(), locale = useLocale()
  const [me, setMe] = useState<MySlack | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let live = true
    api.call(SLACK.mySlack).then((v) => { if (live) setMe(v) }, () => {})
    return () => { live = false }
  }, [])
  if (!me || (!me.available && !me.link)) return null
  const unlink = async () => {
    if (!(await confirmDialog({ title: t('slack.mine.unlinkTitle'), body: t('slack.mine.unlinkBody'), confirm: t('slack.mine.unlink'), danger: true }))) return
    setBusy(true); setError(null)
    try { setMe(await api.call(SLACK.unlinkSlack)) } catch (e) { setError(errorText(e, locale, t('error.network'))) } finally { setBusy(false) }
  }
  return (
    <div className="space-y-2 border-t border-line pt-5" data-testid="slack-account">
      <h3 className="text-sm font-semibold">Slack</h3>
      {error && <ErrorNote>{error}</ErrorNote>}
      {me.link ? (
        <div className="flex items-start gap-3">
          <p className="min-w-0 flex-1 text-sm">
            {t('slack.mine.linked', { name: me.link.slackName ?? me.link.slackUserId, workspace: me.workspace ?? '' })}
            <span className="mt-1 block text-xs text-faint">{t('slack.mine.since', { date: formatDateTime(me.link.linkedAt, locale) })}</span>
          </p>
          <Button variant="danger" size="sm" busy={busy} disabled={busy} onClick={() => void unlink()} data-testid="slack-unlink">{t('slack.mine.unlink')}</Button>
        </div>
      ) : (
        <p className="text-sm text-muted">{t('slack.mine.how', { workspace: me.workspace ?? '' })}</p>
      )}
    </div>
  )
}
