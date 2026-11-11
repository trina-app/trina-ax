// /slack/link?t=<token>: the one-time link a Slack user got in Slack (docs/SLACK.md). It opens only signed in (a
// signed-out visitor signs in first and comes back here); it shows both accounts, the Slack one the link was sent to and
// the person signed in here, and links them only on an explicit "Connect" (Cancel throws the link away). The token goes
// in a POST body only.
import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { SLACK, type SlackLinkPreview } from '@mycel/shared/api'
import { api, errorText } from '../lib/api'
import { useLocale, useT } from '../i18n'
import { Button, Skeleton } from '../components/ui'

/** The display name, with the full name and the user name when they say more */
const slackName = (s: SlackLinkPreview['slack']) => {
  const name = s.name ?? s.realName ?? s.handle ?? s.userId
  const more = [s.realName && s.realName !== name ? s.realName : null, s.handle && s.handle !== name ? `@${s.handle}` : null].filter(Boolean).join(' · ')
  return more ? `${name} (${more})` : name
}

export default function SlackLink() {
  const [params] = useSearchParams()
  const token = params.get('t') ?? ''
  const t = useT(), locale = useLocale()
  const [info, setInfo] = useState<SlackLinkPreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<'linked' | 'cancelled' | null>(null)
  const [busy, setBusy] = useState(false)
  const writing = useRef(false)
  useEffect(() => {
    let live = true
    setInfo(null); setError(null); setDone(null)
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) { setError(t('slack.link.bad')); return }
    api.call(SLACK.previewSlackLink, { body: { token } }).then((v) => { if (live) setInfo(v) }, (e) => { if (live) setError(errorText(e, locale, t('error.network'))) })
    return () => { live = false }
    // locale only changes the words, never the link
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])
  const signIn = async () => {
    if (writing.current) return
    writing.current = true; setBusy(true); setError(null)
    try { window.location.assign((await api.call(SLACK.startSlackSignIn, { body: {} })).authorizationUrl) }
    catch (e) { setError(errorText(e, locale, t('error.network'))); writing.current = false; setBusy(false) }
  }
  const decide = async (link: boolean) => {
    if (writing.current) return
    writing.current = true; setBusy(true); setError(null)
    try {
      if (link) { await api.call(SLACK.confirmSlackLink, { body: { token } }); setDone('linked') }
      else { await api.call(SLACK.cancelSlackLink, { body: { token } }); setDone('cancelled') }
    } catch (e) { setError(errorText(e, locale, t('error.network'))) }
    finally { writing.current = false; setBusy(false) }
  }
  return (
    <section className="mx-auto max-w-xl space-y-5 p-4 sm:p-6" data-testid="slack-link">
      <div>
        <h1 className="text-xl font-semibold">{t('slack.link.title')}</h1>
        {!done && <p className="mt-2 text-sm text-muted">{t('slack.link.desc')}</p>}
      </div>
      {/* what went wrong, as a line like the outcome on /slack/done and in Settings: no box */}
      {error && <p role="alert" className="text-sm text-warn" data-testid="slack-link-error">{error}</p>}
      {!info && !error && <Skeleton lines={4} />}
      {done && <p className="text-sm" data-testid="slack-link-done">{t(done === 'linked' ? 'slack.link.linked' : 'slack.link.cancelled')}</p>}
      {info && !done && (
        <>
          {/* two plain lines: the Slack account the link was sent to (its names are the person's own choice: the full
              name and the user name go with the display name) and the account here with the e-mail that was compared */}
          <div className="space-y-1 text-sm">
            <p className="break-words" data-testid="slack-link-slack">{t('slack.link.slackLine', { name: slackName(info.slack) })}</p>
            <p className="break-words" data-testid="slack-link-me">{t('slack.link.meLine', { name: info.me.name, email: info.email ?? t('slack.noEmail') })}</p>
          </div>
          {info.emailCheck !== 'match' && !info.linkedElsewhere ? (
            // the e-mail does not prove it: the person signs in to Slack instead, which proves the Slack account
            <p className="text-sm text-warn" data-testid="slack-link-email">{info.emailCheck === 'unavailable' ? t('slack.link.emailUnavailable')
              : `${t(info.emailCheck === 'mismatch' ? 'slack.link.emailMismatch' : info.emailCheck === 'missing' ? 'slack.link.emailMissing' : 'slack.link.emailRecent')} ${t(info.signIn ? 'slack.link.useSignIn' : 'slack.signin.off')}`}</p>
          ) : info.linkedElsewhere ? (
            <p className="text-sm text-warn" data-testid="slack-link-elsewhere">
              {t('slack.link.elsewhere')} <Link to="/connectors" className="text-accent underline-offset-2 hover:underline">{t('slack.link.toSettings')}</Link>
            </p>
          ) : (
            <p className="text-sm text-warn">{t('slack.link.warning')}</p>
          )}
          <div className="flex items-center gap-4">
            {!info.linkedElsewhere && info.emailCheck === 'match' && <Button variant="primary" busy={busy} disabled={busy} onClick={() => void decide(true)} data-testid="slack-link-confirm">{t('slack.link.confirm')}</Button>}
            {!info.linkedElsewhere && info.emailCheck !== 'match' && info.emailCheck !== 'unavailable' && info.signIn && <Button variant="primary" busy={busy} disabled={busy} onClick={() => void signIn()} data-testid="slack-signin">{t('slack.signin.button')}</Button>}
            <button type="button" className="text-sm text-muted underline underline-offset-2 disabled:opacity-50" disabled={busy} onClick={() => void decide(false)} data-testid="slack-link-cancel">{t('slack.link.cancel')}</button>
          </div>
        </>
      )}
    </section>
  )
}
