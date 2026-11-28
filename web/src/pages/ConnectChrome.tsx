// /connect-chrome and /connect-chrome/done (docs/decisions/20261128-trina-in-chrome.md "Pairing"): the <app> extension's
// Connect opens /connect-chrome?challenge=<sha256 of its secret> in the Chrome it runs in. Signed in (a signed-out
// visitor signs in first and comes back here with the query, App.tsx `next`), the page names the team's address and the
// account in large type and asks. Connect makes a one-time code bound to the challenge (POST /api/chrome/pair) and moves
// the tab to /connect-chrome/done#code=…; the extension reads that address, closes the tab and spends the code with its
// secret. Neither page reads location.hash, and nothing the app runs on every page keeps or sends it (problem reports
// name only the first part of the path, lib/problemReport.ts), so the code never reaches a server or a log. Cancel goes Home. Not for guests (App.tsx).
import { useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { PRODUCT } from '@mycel/shared'
import { CHROME_CONNECT_DONE_PATH, ChromeSecret } from '@mycel/shared/api'
import { useLocale, useT } from '../i18n'
import { api, API, errorText } from '../lib/api'
import { useMeStrict } from '../store/session'
import { Button } from '../components/ui'
import { AuthFrame } from './Auth'

/** The challenge in `?challenge=`, when it is one the extension makes (43 base64url characters), else null. */
export function readChallenge(search: string): string | null {
  const c = new URLSearchParams(search).get('challenge')
  return c && ChromeSecret.safeParse(c).success ? c : null
}

/** Where the tab goes with the code: the done page, the code only in the fragment. */
export const chromeDoneHref = (code: string) => `${CHROME_CONNECT_DONE_PATH}#code=${encodeURIComponent(code)}`

export function ConnectChrome() {
  const t = useT()
  const locale = useLocale()
  const me = useMeStrict()
  const navigate = useNavigate()
  const challenge = readChallenge(useLocation().search)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const product = PRODUCT.displayName
  if (!challenge)
    return (
      <AuthFrame title={t('connectChrome.missingTitle')} switcher={false}>
        <p className="text-sm text-muted" data-testid="connect-chrome-missing">{t('connectChrome.missing', { product })}</p>
      </AuthFrame>
    )
  const connect = async () => {
    setBusy(true)
    setError(null)
    try {
      const r = await api.call(API.chromePair, { body: { challenge } })
      // replace: Back never comes to this page again with a spent challenge
      window.location.replace(chromeDoneHref(r.code))
    } catch (e) {
      setError(errorText(e, locale, t('error.network')))
      setBusy(false)
    }
  }
  return (
    <AuthFrame title={t('connectChrome.title', { product })} switcher={false}>
      <dl className="mb-4 space-y-3 rounded-xl bg-subtle px-4 py-3" data-testid="connect-chrome-who">
        <div>
          <dt className="text-xs text-muted">{t('connectChrome.team')}</dt>
          <dd className="text-lg font-semibold break-all text-ink" data-testid="connect-chrome-host">{window.location.host}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">{t('connectChrome.account')}</dt>
          <dd className="text-lg font-semibold break-words text-ink" data-testid="connect-chrome-account">
            {me.user.name} <span className="font-normal text-muted">@{me.user.username}</span>
          </dd>
        </div>
      </dl>
      <ul className="mb-5 list-disc space-y-1.5 ps-5 text-sm text-muted">
        <li>{t('connectChrome.onlyAsked')}</li>
        <li>{t('connectChrome.asksSite')}</li>
        <li>{t('connectChrome.disconnect', { place: `${t('settings.title')} › ${t('settings.browser')}` })}</li>
      </ul>
      {error && <p role="alert" className="mb-3 text-sm text-danger" data-testid="connect-chrome-error">{error}</p>}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="ghost" disabled={busy} onClick={() => navigate('/', { replace: true })} data-testid="connect-chrome-cancel">{t('common.cancel')}</Button>
        <Button variant="primary" busy={busy} onClick={() => void connect()} data-testid="connect-chrome-connect">{t('connectChrome.connect')}</Button>
      </div>
    </AuthFrame>
  )
}

/** /connect-chrome/done: the extension takes the code from this tab's address and closes it. */
export function ConnectChromeDone() {
  const t = useT()
  return (
    <AuthFrame title={t('connectChrome.done')} switcher={false}>
      <p className="text-sm text-muted" data-testid="connect-chrome-done">{t('connectChrome.doneHint')}</p>
    </AuthFrame>
  )
}
