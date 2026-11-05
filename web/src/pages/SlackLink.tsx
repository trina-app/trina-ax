// /slack/link?t=<token>: the one-time link a Slack user got in Slack (docs/SLACK.md). It opens only signed in (a
// signed-out visitor signs in first and comes back here); it shows both accounts, the Slack one the link was sent to and
// the person signed in here, and links them only on an explicit "Connect". The token goes in a POST body only.
import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { SLACK, type SlackLinkPreview } from '@mycel/shared/api'
import { api, errorText } from '../lib/api'
import { useLocale, useT } from '../i18n'
import { Button, ErrorNote, Skeleton } from '../components/ui'

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
  const decide = async (link: boolean) => {
    if (writing.current) return
    writing.current = true; setBusy(true); setError(null)
    try {
      if (link) await api.call(SLACK.confirmSlackLink, { body: { token } })
      else await api.call(SLACK.cancelSlackLink, { body: { token } })
      setDone(link ? 'linked' : 'cancelled')
    } catch (e) { setError(errorText(e, locale, t('error.network'))) }
    finally { writing.current = false; setBusy(false) }
  }
  return (
    <section className="mx-auto max-w-xl space-y-5 p-6" data-testid="slack-link">
      <div>
        <h1 className="text-xl font-semibold">{t('slack.link.title')}</h1>
        {!done && <p className="mt-2 text-sm text-muted">{t('slack.link.desc')}</p>}
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
      {!info && !error && <Skeleton lines={4} />}
      {done && <p className="text-sm" data-testid="slack-link-done">{t(done === 'linked' ? 'slack.link.linked' : 'slack.link.cancelled')}</p>}
      {info && !done && (
        <>
          <dl className="space-y-3 rounded-xl border border-line p-4 text-sm">
            <div>
              <dt className="text-muted">{t('slack.link.slackAccount', { workspace: info.workspace })}</dt>
              <dd className="break-words" data-testid="slack-link-slack">
                <span className="font-medium">{info.slack.name ?? info.slack.userId}</span>
                {/* every name is the person's own choice: the full name, the user name and the id are shown with it */}
                <span className="mt-0.5 block text-xs text-muted">{[info.slack.realName && info.slack.realName !== info.slack.name ? info.slack.realName : null, info.slack.handle ? `@${info.slack.handle}` : null, info.slack.userId].filter(Boolean).join(' · ')}</span>
              </dd>
            </div>
            <div>
              <dt className="text-muted">{t('slack.link.meAccount')}</dt>
              <dd className="break-words font-medium" data-testid="slack-link-me">{info.me.name} <span className="text-xs text-faint">@{info.me.username}</span>
                {/* the e-mail that was compared with the Slack account's (Slack's own is not shown) */}
                <span className="mt-0.5 block text-xs font-normal text-muted" data-testid="slack-link-email-compared">{info.email ? t('slack.link.compared', { email: info.email }) : t('slack.people.noEmail')}</span></dd>
            </div>
          </dl>
          {info.emailCheck !== 'match' && !info.linkedElsewhere ? (
            <p className="text-sm text-warn" data-testid="slack-link-email">{t(info.emailCheck === 'mismatch' ? 'slack.link.emailMismatch' : info.emailCheck === 'missing' ? 'slack.link.emailMissing' : info.emailCheck === 'recent' ? 'slack.link.emailRecent' : 'slack.link.emailUnavailable')}</p>
          ) : info.linkedElsewhere ? (
            <p className="text-sm text-warn" data-testid="slack-link-elsewhere">
              {t('slack.link.elsewhere')} <Link to="/settings/connectors" className="text-accent underline-offset-2 hover:underline">{t('slack.link.toSettings')}</Link>
            </p>
          ) : (
            <p className="text-sm text-warn">{t('slack.link.warning')}</p>
          )}
          <div className="flex gap-3">
            {!info.linkedElsewhere && info.emailCheck === 'match' && <Button variant="primary" busy={busy} disabled={busy} onClick={() => void decide(true)} data-testid="slack-link-confirm">{t('slack.link.confirm')}</Button>}
            <Button disabled={busy} onClick={() => void decide(false)} data-testid="slack-link-cancel">{t('slack.link.cancel')}</Button>
          </div>
        </>
      )}
    </section>
  )
}
