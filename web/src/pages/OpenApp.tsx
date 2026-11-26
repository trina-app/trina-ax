// "Continue in the Mac app" (docs/decisions/20261116-desktop-first-onboarding.md, lib/open-app.ts):
// - /open-app, right after /setup in a Mac, Windows or Linux browser (and from the files line): one button that opens the
//   desktop app on this team already signed in, one quiet "Continue in the browser". The button makes a one-time code
//   (POST /api/auth/app-signin) and opens `<scheme>://open?url=<team>/app-signin#c=<code>`; the app asks first (its
//   screen ④). The page cannot tell whether the app opened (no polling, no check): it says how to get the app and to
//   press the button again, as Zoom does. Each press makes a new code; the one before stops working.
// - /app-signin, the page that link opens inside the app: takes the code out of the address first (the app keeps page
//   addresses to reopen after an update), spends it (POST /api/auth/app-signin/redeem) and says who is signed in to which
//   team, with Continue and a quiet "This isn't me" (signs out). Opened in a plain browser it spends nothing.
import { useEffect, useRef, useState } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { ExternalLink, Loader2 } from 'lucide-react'
import { APP_DOWNLOADS, PRODUCT } from '@mycel/shared'
import type { ConsoleSetupPreview, LoginResponse, Me } from '@mycel/shared/api'
import { api, API, errorText, isApiError } from '../lib/api'
import { useLocale, useT } from '../i18n'
import { useSession } from '../store/session'
import { clientKind, desktop, storeApp } from '../lib/desktop'
import { platform } from '../lib/pwa'
import { appComputer, appSignInHref, pageOrigin, readAppSetupClaim, readAppSignInCode } from '../lib/open-app'
import { LANDING_STATE } from '../lib/welcome'
import { useLogoutTo } from '../lib/logout'
import { Button } from '../components/ui'
import { AuthFrame, PasswordField, signedInHome, usePasswordReveal } from './Auth'

const quietLink = 'font-medium text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink max-md:inline-flex max-md:min-h-11 max-md:items-center'

/** /open-app: continue in the desktop app, or in the browser. */
export function OpenApp() {
  const t = useT()
  const locale = useLocale()
  const navigate = useNavigate()
  // from the files line (components/onboarding/OpenAppLine.tsx): "Continue in the browser" goes back there
  const fromLine = (useLocation().state as { openAppBack?: boolean } | null)?.openAppBack === true
  // a phone or our own apps never get here from setup; opened anyway, the welcome steps as usual
  const computer = appComputer({ platform: platform(), client: clientKind(), origin: pageOrigin() })
  const [busy, setBusy] = useState(false)
  const [pressed, setPressed] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!computer) return fromLine ? <Navigate to="/" replace /> : <Navigate to="/welcome" replace />
  const open = async () => {
    setBusy(true)
    setError(null)
    try {
      const r = await api.call(API.appSignIn)
      const href = appSignInHref({ scheme: PRODUCT.linkScheme, origin: pageOrigin(), code: r.code, computer })
      setPressed(true)
      // the app answers the link (its screen ④ asks first); without the app the browser shows nothing or its own note
      if (href) window.location.href = href
    } catch (e) {
      setError(errorText(e, locale, t('error.network')))
    } finally {
      setBusy(false)
    }
  }
  return (
    // Linux: no Find work files there (docs/decisions/20261119-linux-desktop-app.md "Off on Linux"), so its own reason
    <AuthFrame title={t('openApp.title')} sub={t(computer === 'linux' ? 'openApp.whyLinux' : 'openApp.why')} switcher={false}>
      <Button variant="primary" className="w-full" busy={busy} onClick={() => void open()} data-testid="open-app-button">
        {t(computer === 'mac' ? 'openApp.mac' : computer === 'windows' ? 'openApp.windows' : 'openApp.linux')}
      </Button>
      {error && <p className="mt-3 text-sm text-danger" role="alert" data-testid="open-app-error">{error}</p>}
      {pressed && !error && (
        // said after the press, the same whatever happened: the page cannot know whether the app opened
        <div className="mt-4 space-y-2 text-sm text-muted" role="status" data-testid="open-app-after">
          <p>{t('openApp.notOpened')}</p>
          {/* a line of its own: a full-height touch target on a narrow window without stretching the sentence above */}
          <p>
            <a href={APP_DOWNLOADS.page || undefined} target="_blank" rel="noopener noreferrer" className={`${quietLink} inline-flex items-center gap-1`} data-testid="open-app-download">
              {t('openApp.download')} <ExternalLink size={13} aria-hidden />
            </a>
          </p>
          <p>{t('openApp.close')}</p>
        </div>
      )}
      <p className="mt-5 text-center text-sm">
        <button type="button" className={quietLink} onClick={() => (fromLine ? navigate(-1) : navigate('/welcome', { replace: true }))} data-testid="open-app-browser">
          {t('openApp.browser')}
        </button>
      </p>
    </AuthFrame>
  )
}

// ---------------- /app-signin ----------------

/** The code of this page load: read once and taken out of the address before anything else (the desktop app saves page
 * addresses to reopen after an update, and history keeps them). */
let taken: { code: string | null } | null = null
function takeCode(): string | null {
  if (!taken) {
    taken = { code: readAppSignInCode(window.location.hash) }
    if (window.location.hash) window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search)
  }
  return taken.code
}
/** One redeem per code, whatever re-renders or remounts (the session switch remounts the page). */
let redeeming: { code: string; result: Promise<LoginResponse> } | null = null
const redeemOnce = (code: string) => {
  if (redeeming?.code !== code) redeeming = { code, result: api.call(API.redeemAppSignIn, { body: { code, client: 'desktop', tokenMode: 'cookie' } }) }
  return redeeming.result
}
/** Continue was pressed: the page signed in with this answer lands where a sign-in lands, after the session switch. */
let landing = false

type SignInState = { s: 'outside' } | { s: 'working' } | { s: 'done'; me: Me } | { s: 'gone' } | { s: 'other'; text: string } | { s: 'error'; text: string } | { s: 'none' }

/** /app-signin, signed in or out. */
export function AppSignIn() {
  const t = useT()
  const locale = useLocale()
  const signedIn = useSession((s) => s.signedIn)
  const signedInNow = useSession((s) => s.status.kind === 'signed-in')
  const logoutTo = useLogoutTo()
  const navigate = useNavigate()
  const [code] = useState(takeCode)
  const inApp = !!desktop()
  const [state, setState] = useState<SignInState>(() => (!inApp ? { s: 'outside' } : code ? { s: 'working' } : { s: 'none' }))
  const [, rerender] = useState(0)
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    // only inside the desktop app: a code opened in a plain browser is left unspent (it dies in 3 minutes)
    if (inApp && code) {
      redeemOnce(code).then(
        (r) => { if (live.current) setState({ s: 'done', me: r.me }) },
        // 409: this app is signed in as someone else on this team; the code never replaces that (server/src/auth/app-signin.ts)
        (e) => { if (live.current) setState(isApiError(e) && e.status === 410 ? { s: 'gone' } : isApiError(e) && e.status === 409 ? { s: 'other', text: errorText(e, locale, t('error.network')) } : { s: 'error', text: errorText(e, locale, t('error.network')) }) },
      )
    }
    // a newer link while this page is open (the button pressed again; the app loads the same page with a new fragment,
    // which is no new page load): start again from it
    const onHash = () => { if (readAppSignInCode(window.location.hash)) window.location.reload() }
    window.addEventListener('hashchange', onHash)
    return () => { live.current = false; window.removeEventListener('hashchange', onHash) }
    // once per page load
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  if (landing) return <Landing />
  // signed in already and no code left in this page (a reload after the sign-in): where a sign-in lands
  if (state.s === 'none' && signedInNow) return <Navigate to={signedInHome()} state={LANDING_STATE} replace />
  if (state.s === 'outside')
    return (
      <AuthFrame title={t('appSignIn.outside')} switcher={false}>
        <a href="/" className="text-sm text-accent-text underline max-md:inline-flex max-md:min-h-11 max-md:items-center" data-testid="app-signin-home">{t('appSignIn.home')}</a>
      </AuthFrame>
    )
  if (state.s === 'working')
    return (
      <AuthFrame title={t('appSignIn.working')} switcher={false}>
        <Loader2 size={20} className="animate-spin text-muted" aria-hidden />
      </AuthFrame>
    )
  if (state.s === 'done') {
    const me = state.me
    return (
      <AuthFrame title={t('appSignIn.done', { team: me.team.name, name: me.user.name })} switcher={false}>
        {storeApp() && (
          // the Mac App Store build cannot look through the computer's folders (docs/decisions/20261116-desktop-first-onboarding.md)
          <p className="mb-4 text-sm text-muted" data-testid="app-signin-store">
            {t('appSignIn.storeApp')}{' '}
            <a href={APP_DOWNLOADS.page || undefined} target="_blank" rel="noopener noreferrer" className={quietLink}>{t('appSignIn.getDownload')}</a>
          </p>
        )}
        <Button variant="primary" className="w-full" onClick={() => { landing = true; signedIn(me); rerender((n) => n + 1) }} data-testid="app-signin-continue">
          {t('appSignIn.continue')}
        </Button>
        <p className="mt-4 text-center text-sm">
          {/* someone else's team or account (a link sent to them): sign out at once */}
          <button type="button" className={quietLink} onClick={() => void logoutTo('/login')} data-testid="app-signin-not-me">{t('appSignIn.notMe')}</button>
        </p>
      </AuthFrame>
    )
  }
  // expired, used or no code; signed in as someone else here; or the request failed
  return (
    <AuthFrame title={t(state.s === 'other' ? 'appSignIn.otherTitle' : 'appSignIn.goneTitle')} sub={state.s === 'error' || state.s === 'other' ? state.text : t('appSignIn.gone')} switcher={false}>
      {signedInNow ? (
        <Button variant="primary" className="w-full" onClick={() => { landing = true; rerender((n) => n + 1) }} data-testid="app-signin-continue">{t('appSignIn.continue')}</Button>
      ) : (
        <Button variant="primary" className="w-full" onClick={() => navigate('/login', { replace: true })} data-testid="app-signin-login">{t('appSignIn.signIn')}</Button>
      )}
    </AuthFrame>
  )
}

// ---------------- /app-setup ----------------

/** The console's claim of this page load: read once and taken out of the address first, like /app-signin's code. */
let setupTaken: { claim: string | null } | null = null
function takeClaim(): string | null {
  if (!setupTaken) {
    setupTaken = { claim: readAppSetupClaim(window.location.hash) }
    if (window.location.hash) window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search)
  }
  return setupTaken.claim
}
/** One preview per claim, whatever re-renders or remounts. */
let previewing: { claim: string; result: Promise<ConsoleSetupPreview> } | null = null
const previewOnce = (claim: string) => {
  if (previewing?.claim !== claim) previewing = { claim, result: api.call(API.setupConsolePreview, { body: { claim } }) }
  return previewing.result
}

type SetupState = { s: 'outside' } | { s: 'loading' } | { s: 'ready'; p: ConsoleSetupPreview } | { s: 'gone' } | { s: 'setUp' } | { s: 'error'; text: string }

/**
 * /app-setup: a hosted team the desktop app just made on the hosting console (docs/decisions/20261126-desktop-create-team.md,
 * server/src/auth/setup-console.ts). "Welcome to {team}, {name}": an owner who signed in to the console with Google
 * presses Continue; one who signed in with an e-mail code chooses a password first (for the phone and other computers).
 * No "This isn't me": the console confirmed the e-mail in the browser. Opened in a plain browser it spends nothing.
 */
export function AppSetup() {
  const t = useT()
  const locale = useLocale()
  const signedIn = useSession((s) => s.signedIn)
  const signedInNow = useSession((s) => s.status.kind === 'signed-in')
  const navigate = useNavigate()
  const [claim] = useState(takeClaim)
  const inApp = !!desktop()
  const [state, setState] = useState<SetupState>(() => (!inApp ? { s: 'outside' } : claim ? { s: 'loading' } : { s: 'gone' }))
  const [password, setPassword] = useState('')
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [, rerender] = useState(0)
  const reveal = usePasswordReveal()
  const live = useRef(true)
  const failed = (e: unknown): SetupState =>
    isApiError(e) && e.status === 410 ? { s: 'gone' } : isApiError(e) && e.status === 409 ? { s: 'setUp' } : { s: 'error', text: errorText(e, locale, t('error.network')) }
  const preview = () => {
    if (inApp && claim) previewOnce(claim).then((p) => { if (live.current) setState({ s: 'ready', p }) }, (e) => { if (live.current) setState(failed(e)) })
  }
  useEffect(() => {
    live.current = true
    preview()
    return () => { live.current = false }
    // once per page load
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // the hosting service could not be asked (or another failure): the claim may still be good, so ask again
  if (state.s === 'error')
    return (
      <AuthFrame title={t('appSetup.errorTitle')} sub={state.text} switcher={false}>
        <Button variant="primary" className="w-full" onClick={() => { previewing = null; setState({ s: 'loading' }); preview() }} data-testid="app-setup-retry">
          {t('appSetup.retry')}
        </Button>
      </AuthFrame>
    )
  if (landing) return <Landing />
  if (state.s === 'gone' && !claim && signedInNow) return <Navigate to={signedInHome()} state={LANDING_STATE} replace />
  if (state.s === 'outside')
    return (
      <AuthFrame title={t('appSignIn.outside')} switcher={false}>
        <a href="/" className="text-sm text-accent-text underline max-md:inline-flex max-md:min-h-11 max-md:items-center" data-testid="app-setup-home">{t('appSignIn.home')}</a>
      </AuthFrame>
    )
  if (state.s === 'loading')
    return (
      <AuthFrame title={t('appSetup.working')} switcher={false}>
        <Loader2 size={20} className="animate-spin text-muted" aria-hidden />
      </AuthFrame>
    )
  if (state.s === 'ready') {
    const p = state.p
    const submit = async (e: React.FormEvent) => {
      e.preventDefault()
      setBusy(true)
      setFieldError(null)
      try {
        const r = await api.call(API.setupConsole, { body: { claim: claim!, ...(p.google ? {} : { password }), client: 'desktop', tokenMode: 'cookie' } })
        landing = true
        signedIn(r.me)
        rerender((n) => n + 1)
      } catch (err) {
        // a weak password: said at the field, the claim stays usable
        if (isApiError(err) && err.status === 400 && err.body.fields?.['body.password']) setFieldError(errorText(err, locale, t('error.network')))
        else setState(failed(err))
      } finally {
        setBusy(false)
      }
    }
    return (
      <AuthFrame title={t('appSetup.welcome', { team: p.teamName, name: p.name })} sub={p.email} switcher={false}>
        <form onSubmit={(e) => void submit(e)} noValidate>
          {!p.google && (
            <div className="mb-4">
              <PasswordField label={t('appSetup.password')} hint={t('appSetup.passwordHint')} error={fieldError} reveal={reveal} eyeTestId="app-setup-password-show"
                name="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus autoComplete="new-password" data-testid="app-setup-password" />
            </div>
          )}
          <Button type="submit" variant="primary" className="w-full" busy={busy} disabled={!p.google && password.length === 0} data-testid="app-setup-continue">
            {t('appSignIn.continue')}
          </Button>
        </form>
      </AuthFrame>
    )
  }
  // expired, used or no claim; or the team is set up already
  return (
    <AuthFrame title={t(state.s === 'setUp' ? 'appSetup.doneTitle' : 'appSetup.goneTitle')} sub={state.s === 'gone' ? t('appSetup.gone') : undefined} switcher={false}>
      {signedInNow ? (
        <Button variant="primary" className="w-full" onClick={() => { landing = true; rerender((n) => n + 1) }} data-testid="app-setup-home-button">{t('appSignIn.continue')}</Button>
      ) : (
        <Button variant="primary" className="w-full" onClick={() => navigate('/login', { replace: true })} data-testid="app-setup-login">{t('appSignIn.signIn')}</Button>
      )}
    </AuthFrame>
  )
}

/** Where a sign-in lands (an owner with unfinished welcome steps goes on with them: lib/welcome.ts LANDING_STATE), once. */
function Landing() {
  useEffect(() => { landing = false }, [])
  return <Navigate to={signedInHome()} state={LANDING_STATE} replace />
}
