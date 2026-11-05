// Settings › App connectors › Slack (docs/SLACK.md): one line, always there while the team uses Slack: the Slack account
// linked to me with Unlink, or "Sign in with Slack" to link the Slack account I sign in to (or, without it, how to get a
// link in Slack). The outcome of a sign-in comes back in the address (?slack=…). Hidden when the team does not use Slack
// and nothing is linked. `onShown` tells the page whether it shows.
import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { SLACK, type MySlack } from '@mycel/shared/api'
import { api, errorText } from '../../lib/api'
import { formatDateTime } from '../../lib/format'
import { useLocale, useT } from '../../i18n'
import { outcomeText } from '../../lib/slackSignIn'
import { Button, ErrorNote, confirmDialog } from '../ui'

export function SlackAccount({ onShown }: { onShown?: (shown: boolean) => void }) {
  const t = useT(), locale = useLocale()
  const [params, setParams] = useSearchParams()
  // the outcome of a sign-in, said once: taken out of the address so a reload or a shared link does not say it again
  const [outcome] = useState(() => params.get('slack'))
  useEffect(() => { if (params.has('slack')) setParams((p) => { p.delete('slack'); return p }, { replace: true }) }, [params, setParams])
  const [me, setMe] = useState<MySlack | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const load = useCallback(() => { api.call(SLACK.mySlack).then(setMe, () => {}) }, [])
  useEffect(() => {
    load()
    // a sign-in finished in another browser (the desktop app's system browser, the phone app's in-app browser): the
    // line shows it when the app is used again
    const again = () => { if (document.visibilityState !== 'hidden') load() }
    window.addEventListener('focus', again)
    document.addEventListener('visibilitychange', again)
    return () => { window.removeEventListener('focus', again); document.removeEventListener('visibilitychange', again) }
  }, [load])
  const shown = !!me && (me.available || !!me.link)
  useEffect(() => { onShown?.(shown) }, [shown, onShown])
  if (!me || !shown) return null
  const signIn = async () => {
    setBusy(true); setError(null)
    // the person's own browser goes to Slack and comes back to this page
    try { window.location.assign((await api.call(SLACK.startSlackSignIn, { body: {} })).authorizationUrl) }
    catch (e) { setError(errorText(e, locale, t('error.network'))); setBusy(false) }
  }
  const unlink = async () => {
    if (!(await confirmDialog({ title: t('slack.mine.unlinkTitle'), body: t('slack.mine.unlinkBody'), confirm: t('slack.mine.unlink'), danger: true }))) return
    setBusy(true); setError(null)
    try { setMe(await api.call(SLACK.unlinkSlack)) } catch (e) { setError(errorText(e, locale, t('error.network'))) } finally { setBusy(false) }
  }
  return (
    <div className="space-y-2 border-t border-line pt-4" data-testid="slack-account">
      {error && <ErrorNote>{error}</ErrorNote>}
      {outcome && <p className={`text-sm ${outcome === 'linked' ? '' : 'text-warn'}`} role="status" data-testid="slack-signin-outcome">{t(outcomeText(outcome))}</p>}
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1 text-sm">
          <p className="font-medium">Slack</p>
          {me.link ? (
            <p className="mt-1 text-xs text-muted">
              {t('slack.mine.linked', { name: me.link.slackName ?? me.link.slackUserId, workspace: me.workspace ?? '' })}
              <span className="mt-0.5 block text-faint">{t('slack.mine.since', { date: formatDateTime(me.link.linkedAt, locale) })}</span>
            </p>
          ) : (
            <>
              <p className="mt-1 text-xs text-muted">{t(me.signIn ? 'slack.mine.signInHow' : 'slack.mine.how', { workspace: me.workspace ?? '' })}</p>
              {me.emailSetByOther && <p className="mt-1 text-xs text-warn" data-testid="slack-email-set-by-other">{t('slack.mine.emailSetByOther')}</p>}
            </>
          )}
        </div>
        {me.link
          ? <Button variant="danger" size="sm" busy={busy} disabled={busy} onClick={() => void unlink()} data-testid="slack-unlink">{t('slack.mine.unlink')}</Button>
          : me.signIn && <Button variant="primary" size="sm" busy={busy} disabled={busy} onClick={() => void signIn()} data-testid="slack-signin">{t('slack.signin.button')}</Button>}
      </div>
    </div>
  )
}
