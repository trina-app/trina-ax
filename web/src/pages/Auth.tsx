// Sign-in, first-run setup (/setup#token=… or /setup?token=), invite acceptance (/invite/:token), the team invite link
// (/join#t=…) and the forced password change.
import clsx from 'clsx'
import { Eye, EyeOff, Loader2 } from 'lucide-react'
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { APP_DOWNLOADS, PRODUCT } from '@mycel/shared'
import { skillLabel, type InviteInfo, type Locale, type PasswordResetInfo, type TeamLinkInfo } from '@mycel/shared/api'
import { api, API, errorText, isApiError } from '../lib/api'
import { formatDateTime } from '../lib/format'
import { browserLocale, LOCALES, storedLocale, storeLocale, useLocale, useLocaleStore, useT, type MessageKey } from '../i18n'
import { useMe, useSession } from '../store/session'
import { toast } from '../store/ui'
import { clientKind } from '../lib/desktop'
import { mobileApp } from '../lib/mobile'
import { isTextField } from '../lib/viewport'
import { clearLocalData } from '../lib/localData'
import { forgetSetupToken, keptSetupToken, readSetupLink, rememberSetupSite } from '../lib/setupLink'
import { setAfterSetup } from '../lib/welcome'
import { landingPath } from '../lib/tabs'
import { forgetJoinToken, getAppHref, joinNext, openInAppHref, openInAppShown, setAfterJoin, tabJoinToken } from '../lib/team-link'
import { safeNext } from '../lib/nav'
import { platform } from '../lib/pwa'
import { copyInTap } from '../lib/copy-in-tap'
import { APP_LINKS } from '@mycel/shared/app-links'
import { holdMadeBy } from '../lib/starter'
import { SourceCodeLink } from '../components/SourceCodeLink'
import { Button, Field, IconButton, inputCls } from '../components/ui'
import { browserTimeZone } from '../lib/time-zones'
import { DemoStart, useDemoInfo } from '../components/demo/Demo'

/** The password rule's minimum (server: server/src/auth/passwords.ts, the same 8 everywhere). */
export const PASSWORD_MIN = 8

/**
 * A username with characters the server refuses (tab 5: the invite screen checks the rule while typing), so the hint
 * turns into an error at once instead of a browser bubble after pressing the button. Length is left to submit.
 */
export const usernameProblem = (v: string) => v.length > 0 && !/^[A-Za-z0-9._@-]*$/.test(v)

/** What is wrong with a username field on submit: empty, characters the server refuses, or not 2–64 characters. */
const usernameCheck = (v: string): MessageKey | null => {
  const u = v.trim()
  if (!u) return 'auth.required'
  return usernameProblem(u) || u.length < 2 || u.length > 64 ? 'auth.usernameHint' : null
}
const requiredCheck = (v: string): MessageKey | null => (v.trim() ? null : 'auth.required')

/**
 * The auth forms check their own fields (they use noValidate), so all errors show in one style under the field and in
 * the screen language, never as the browser's popup. `problems` lists the fields in screen order (the key is the
 * input's `name`). After a submit attempt each field with a problem shows its error; the error goes away as soon as the
 * field is correct. `check` gives the focus to the first field with a problem and says whether the form may be sent.
 */
function useFieldChecks<K extends string>(problems: Record<K, MessageKey | null>) {
  const t = useT()
  const [tried, setTried] = useState(false)
  const errorOf = (k: K) => {
    const key = problems[k]
    return tried && key ? t(key) : null
  }
  const check = (form: HTMLFormElement) => {
    const first = (Object.keys(problems) as K[]).find((k) => problems[k])
    if (!first) return true
    setTried(true)
    const el = form.elements.namedItem(first)
    if (el instanceof HTMLElement) el.focus()
    return false
  }
  return { errorOf, check }
}

/** The language switcher of the sign-in style screens. Before sign-in the pick is kept in this browser (sent with an
 * invite acceptance as the new account's language, saved to the account at sign-in when it has none); without one
 * the team default shows. Signed in (forced password change, reset link) it is the person's own language setting. */
export function LanguageSwitcher() {
  const t = useT()
  const locale = useLocale()
  const pick = useSession((s) => s.pickLocale)
  return (
    <label className="mt-6 flex items-center justify-center gap-2 text-xs text-faint">
      {t('settings.language')}
      <select className="rounded border border-field-border bg-surface px-1.5 py-1 text-xs text-ink" value={locale} data-testid="auth-locale" onChange={(e) => pick(e.target.value as Locale)}>
        {LOCALES.map((l) => (
          <option key={l.id} value={l.id} lang={l.id}>
            {l.label}
          </option>
        ))}
      </select>
    </label>
  )
}

/** The sign-in style screens. From 640px the form is a card in the middle of the screen; on a phone it has no frame
 * (the card's edge sat 16px from the screen's and only boxed the fields in once more) and it starts near the top, so
 * the button is in view and the keyboard does not push the page around. On a phone the page scrolls in its own box,
 * as high as what the keyboard leaves (#root's --app-h, lib/viewport.ts), so a form's button (SubmitBar) can stay on
 * that box's bottom edge, above the keyboard (QA TC-272). Inside the phone app the website's footer (the source code
 * link, the language select) is left out: the app's Settings › About has the source offer, and the language is the
 * person's or the team's. */
function AuthFrame({ title, children, sub, switcher = true }: { title: string; children: ReactNode; sub?: ReactNode; switcher?: boolean }) {
  const inApp = !!mobileApp()
  const box = useFieldAboveBar()
  return (
    <div ref={box} className="flex min-h-full flex-col items-center justify-center bg-canvas px-4 py-10 max-sm:h-full max-sm:justify-start max-sm:overflow-y-auto max-sm:scroll-pb-28 max-sm:pt-[max(2.5rem,8vh)]" data-testid="auth-frame">
      <main className="w-full max-w-sm">
        <p className="mb-6 flex items-center justify-center gap-2 text-xl font-semibold tracking-tight max-sm:mb-8">
          <img src="/favicon.svg" alt="" aria-hidden className="size-7 rounded-lg dark:ring-1 dark:ring-line" />
          {PRODUCT.displayName}
        </p>
        <div className="rounded-2xl border border-line bg-surface p-6 shadow-[var(--c-shadow)] max-sm:rounded-none max-sm:border-0 max-sm:bg-transparent max-sm:p-0 max-sm:shadow-none">
          <h1 className={clsx('text-lg font-semibold', sub ? 'mb-1' : 'mb-4')}>{title}</h1>
          {sub && <div className="mb-4 text-sm text-balance text-muted">{sub}</div>}
          {children}
        </div>
        {switcher && !inApp && <LanguageSwitcher />}
        {!inApp && <SourceCodeLink className="mt-4 block text-center text-xs text-faint hover:text-muted" />}
      </main>
    </div>
  )
}

/** On a phone, the field being typed in stays in sight above the button bar (SubmitBar) and the keyboard: when it gets
 * the focus, and when the keyboard opens and the box gets shorter (visualViewport's resize), the box scrolls it into
 * view, keeping the bar's height free under it (the box's scroll-padding-bottom). A computer's page does not scroll. */
function useFieldAboveBar() {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = box.current
    const phone = window.matchMedia?.('(max-width: 639.98px)')
    if (!el || !phone) return
    const reveal = () => {
      const f = document.activeElement
      if (phone.matches && isTextField(f) && el.contains(f)) f.scrollIntoView?.({ block: 'nearest' })
    }
    // after the keyboard's own scrolling and the new --app-h have settled
    const later = () => requestAnimationFrame(reveal)
    el.addEventListener('focusin', later)
    window.visualViewport?.addEventListener('resize', later)
    return () => {
      el.removeEventListener('focusin', later)
      window.visualViewport?.removeEventListener('resize', later)
    }
  }, [])
  return box
}

/** An error on screen: a text key of ours, or what the server said. Drawn in the language on screen: our own texts,
 * network errors and the server's default messages follow a language switch (errorText); a server's own sentence
 * ("Wrong username or password.") stays as it was said, so the error does not vanish. */
type Shown = { key: MessageKey } | { e: unknown }

function useSubmit() {
  const t = useT()
  const locale = useLocale()
  const [busy, setBusy] = useState(false)
  const [shown, setShown] = useState<Shown | null>(null)
  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setShown(null)
    try {
      await fn()
    } catch (e) {
      setShown({ e })
    } finally {
      setBusy(false)
    }
  }
  const error = !shown ? null : 'key' in shown ? t(shown.key) : errorText(shown.e, locale, t('error.network'))
  return { busy, error, run, setError: (key: MessageKey) => setShown({ key }), setFailure: (e: unknown) => setShown({ e }) }
}

/**
 * Typing a new password once (invite, team link, setup) or twice (password change): the eye button shows what was
 * typed and Caps Lock is named, which catches a typo better than typing blind twice. `caps` goes on the password
 * inputs' onKeyDown and onKeyUp; the row goes under the last password field.
 */
function usePasswordReveal() {
  const [show, setShow] = useState(false)
  const [capsOn, setCapsOn] = useState(false)
  const caps = (e: React.KeyboardEvent) => setCapsOn(e.getModifierState?.('CapsLock') ?? false)
  return { show, capsOn, caps, toggle: () => setShow((v) => !v) }
}

/** A password field with its eye button inside, at the field's right edge (before, the button had a row of its own
 * under the field, which pushed a phone's button under the keyboard: QA TC-272). `reveal` is shared by the fields of
 * one form, so one tap shows both of a password change; `eye` is false on the second of them (one button is enough). */
function PasswordField({ label, hint, error, reveal, eyeTestId, eye = true, ...props }: Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'className'> & { label: string; hint?: string; error?: string | null; reveal: ReturnType<typeof usePasswordReveal>; eyeTestId?: string; eye?: boolean; 'data-testid': string }) {
  const t = useT()
  const { show, caps, toggle } = reveal
  const name = show ? t('auth.hidePassword') : t('auth.showPassword')
  const button = eye ? (
    <IconButton label={name} aria-pressed={show} onClick={toggle} className="mr-0.5 max-sm:mr-0" data-testid={eyeTestId}>
      {show ? <EyeOff size={16} /> : <Eye size={16} />}
    </IconButton>
  ) : undefined
  return (
    <Field label={label} hint={hint} error={error} aside={button}>
      <input {...props} className={clsx(inputCls, eye && 'pr-11')} type={show ? 'text' : 'password'} onKeyDown={caps} onKeyUp={caps} autoCapitalize="none" />
    </Field>
  )
}

/** The Caps Lock note under the last password field (empty while it is off); with `hint`, on the field's hint line
 * instead: the input names `hint.id` in aria-describedby, and the text is left empty while the field shows an error
 * (an error takes the hint's place, as in Field). */
function CapsLockNote({ reveal, hint }: { reveal: ReturnType<typeof usePasswordReveal>; hint?: { id: string; text: string } }) {
  const t = useT()
  const { capsOn } = reveal
  return (
    <p className={clsx('text-xs', (capsOn || hint) && 'mt-1')}>
      <span role="status" className="text-warn" data-testid="caps-lock">
        {capsOn ? t('auth.capsLock') : ''}
      </span>
      {hint && !capsOn && <span id={hint.id} className="text-faint">{hint.text}</span>}
    </p>
  )
}

/** A form's button with the error above it. On a phone it stays on the bottom edge of the page's box (AuthFrame) while
 * the form runs on below it, so it is above the keyboard while a field is being typed in. `plain`: just the children (the
 * password change inside Settings, not a sign-in style page). */
function SubmitBar({ children, plain }: { children: ReactNode; plain?: boolean }) {
  if (plain) return <>{children}</>
  return <div className="space-y-3 bg-canvas max-sm:sticky max-sm:bottom-0 max-sm:z-10 max-sm:-mx-4 max-sm:px-4 max-sm:py-2" data-testid="auth-submit-bar">{children}</div>
}

/** The details of an invite or a team link did not load (no connection, a server error): why, and a way to try again;
 * never "the link is wrong" (QA TC-171 for the team link, 11-11 for the personal invite). */
function LoadFailed({ e, onRetry }: { e: unknown; onRetry: () => void }) {
  const t = useT()
  const locale = useLocale()
  return (
    <>
      <p role="alert" className="text-sm text-danger" data-testid="join-load-error">{errorText(e, locale, t('error.network'))}</p>
      <Button variant="primary" className="mt-4 w-full" onClick={onRetry} data-testid="join-retry">
        {t('common.retry')}
      </Button>
    </>
  )
}

/** A group of fields under a quiet heading and a hairline (the setup form: the team, then the owner's own account). */
function FormSection({ title, children, testId }: { title: string; children: ReactNode; testId: string }) {
  return (
    <fieldset className="min-w-0" data-testid={testId}>
      <legend className="mb-3 w-full">
        <span className="flex items-center gap-3 text-xs font-medium text-muted">
          {title}
          <span className="h-px flex-1 bg-line" aria-hidden />
        </span>
      </legend>
      <div className="space-y-3">{children}</div>
    </fieldset>
  )
}

export function Login() {
  const t = useT()
  const signedIn = useSession((s) => s.signedIn)
  const status = useSession((s) => s.status)
  const navigate = useNavigate()
  const location = useLocation()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const { busy, error, run } = useSubmit()
  const { errorOf, check } = useFieldChecks({ username: requiredCheck(username), password: password ? null : 'auth.required' })
  const reason = status.kind === 'signed-out' ? status.reason : undefined
  // a demo server (`bun run demo:company`): one action, start as the new hire; the usual form is one link away
  const { info: demo } = useDemoInfo()
  const [form, setForm] = useState(false)
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!check(e.currentTarget)) return
    void run(async () => {
      const r = await api.call(API.login, { body: { username: username.trim(), password, client: clientKind(), tokenMode: 'cookie' } })
      signedIn(r.me, { adoptPick: true })
      // the router sends a signed-in person on /login to ?next= (App.tsx AfterSignIn), or to /password, which keeps
      // ?next= for after the new password (a Slack or connector link opened with a temporary password)
      const next = safeNext(location.search)
      if (r.me.user.mustChangePassword) navigate(`/password${next ? `?next=${encodeURIComponent(next)}` : ''}`, { replace: true })
    })
  }
  if (demo && !form) {
    return (
      <AuthFrame title={t('demo.signIn.title', { company: demo.company })}>
        <DemoStart info={demo} onOtherAccount={() => setForm(true)} />
      </AuthFrame>
    )
  }
  return (
    <AuthFrame title={t('auth.signIn')} sub={reason === 'ended' ? t('auth.sessionEnded') : reason === 'expired' ? t('auth.sessionExpired') : undefined}>
      <form onSubmit={submit} noValidate className="space-y-4">
        <Field label={t('auth.username')} error={errorOf('username')}>
          <input className={inputCls} name="username" autoComplete="username" autoCapitalize="none" value={username} onChange={(e) => setUsername(e.target.value)} required data-testid="login-username" />
        </Field>
        <Field label={t('auth.password')} error={errorOf('password')}>
          <input className={inputCls} name="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required data-testid="login-password" />
        </Field>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <Button type="submit" variant="primary" className="w-full" busy={busy} data-testid="login-submit">
          {t('auth.signIn')}
        </Button>
        <p className="text-center text-xs text-faint">{t('auth.forgot')}</p>
      </form>
    </AuthFrame>
  )
}

export function Setup() {
  const t = useT()
  const locale = useLocale()
  const setLocale = useLocaleStore((s) => s.setLocale)
  const signedIn = useSession((s) => s.signedIn)
  const navigate = useNavigate()
  // the link from the account console (#token=…&team=…&lang=…&site=…) or the installer (?token=…), read once
  const [link] = useState(() => readSetupLink(window.location))
  // after a reload the token is no longer in the address: the one this tab's link carried (lib/setupLink.ts)
  const [linkToken] = useState(() => link.token ?? keptSetupToken())
  const [form, setForm] = useState({ setupToken: linkToken ?? '', teamName: link.team ?? '', name: '', username: '', password: '' })
  const reveal = usePasswordReveal()
  const passwordHintId = useId()
  const { busy, error, run, setError } = useSubmit()
  useEffect(() => {
    // the token leaves the address bar (history, screenshots) as soon as it is in the form
    if (link.cleanUrl) window.history.replaceState(window.history.state, '', link.cleanUrl)
    // the language the team signed up with; else, with none picked in this browser yet, the browser's own
    if (link.lang && !storedLocale()) { if (link.lang !== locale) setLocale(link.lang); return }
    if (storedLocale()) return
    const l = browserLocale(typeof navigator === 'undefined' ? [] : navigator.languages?.length ? navigator.languages : [navigator.language])
    if (l && l !== locale) setLocale(l)
  }, []) // once, on arrival
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }))
  const { errorOf, check } = useFieldChecks({
    setupToken: linkToken ? null : requiredCheck(form.setupToken),
    teamName: requiredCheck(form.teamName),
    name: requiredCheck(form.name),
    username: usernameCheck(form.username),
    password: form.password ? null : 'auth.required',
  })
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!check(e.currentTarget)) return
    if ([...form.password].length < PASSWORD_MIN) return setError('auth.passwordRule')
    void run(async () => {
      // the team's time zone starts as this browser's (Admin > Settings changes it)
      const timeZone = browserTimeZone()
      const r = await api.call(API.setup, { body: { setupToken: form.setupToken.trim(), teamName: form.teamName.trim(), locale, ...(timeZone ? { timeZone } : {}), owner: { username: form.username.trim(), name: form.name.trim(), password: form.password } } })
      // the company website from the link: the company profile step starts from it (components/onboarding)
      rememberSetupSite(link.site)
      forgetSetupToken()
      // then the welcome steps (pages/Welcome.tsx): set before the session switch re-renders /setup (App.tsx AfterSetup)
      setAfterSetup('/welcome')
      signedIn(r.me)
      navigate('/welcome', { replace: true })
    })
  }
  return (
    // the "Team language" field below is this screen's language switcher too (one picker, not two). Two groups under
    // quiet headings, so it is plain where the team ends and the owner's own account begins.
    <AuthFrame title={t('setup.title')} sub={t('setup.sub')} switcher={false}>
      <form onSubmit={submit} noValidate className="space-y-6">
        <FormSection title={t('setup.section.team')} testId="setup-section-team">
          {!linkToken && (
            <Field label={t('setup.token')} hint={t('setup.tokenHint')} error={errorOf('setupToken')}>
              <input className={inputCls} name="setupToken" value={form.setupToken} onChange={set('setupToken')} required autoComplete="off" />
            </Field>
          )}
          <Field label={t('setup.teamName')} error={errorOf('teamName')}>
            <input className={inputCls} name="teamName" value={form.teamName} onChange={set('teamName')} required maxLength={100} data-testid="setup-team" />
          </Field>
          <Field label={t('setup.teamLocale')} hint={t('setup.teamLocaleHint')}>
            {/* the team language is the language on screen: picking one here switches this page too */}
            <select
              className={inputCls}
              value={locale}
              data-testid="setup-locale"
              onChange={(e) => {
                const l = e.target.value as Locale
                storeLocale(l)
                setLocale(l)
              }}
            >
              {LOCALES.map((l) => (
                <option key={l.id} value={l.id} lang={l.id}>
                  {l.label}
                </option>
              ))}
            </select>
          </Field>
        </FormSection>
        <FormSection title={t('setup.section.owner')} testId="setup-section-owner">
          <Field label={t('setup.name')} error={errorOf('name')}>
            <input className={inputCls} name="name" value={form.name} onChange={set('name')} required autoComplete="name" maxLength={100} data-testid="setup-name" />
          </Field>
          <Field label={t('auth.username')} hint={t('auth.usernameHint')} error={errorOf('username') ?? (usernameProblem(form.username) ? t('auth.usernameHint') : null)}>
            <input className={inputCls} name="username" value={form.username} onChange={set('username')} required autoComplete="username" autoCapitalize="none" pattern="[A-Za-z0-9._@\-]{2,64}" data-testid="setup-username" />
          </Field>
          {/* one password field, as when joining: the eye button shows what was typed (no second field to type blind) */}
          <div>
            <PasswordField label={t('auth.password')} error={errorOf('password')} reveal={reveal} eyeTestId="setup-password-show" name="password" value={form.password} onChange={set('password')} required autoComplete="new-password" aria-describedby={passwordHintId} data-testid="setup-password" />
            <CapsLockNote reveal={reveal} hint={{ id: passwordHintId, text: errorOf('password') ? '' : t('setup.passwordHint') }} />
          </div>
        </FormSection>
        <SubmitBar>
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
          <Button type="submit" variant="primary" className="w-full" busy={busy} data-testid="setup-submit">
            {t('setup.create')}
          </Button>
        </SubmitBar>
      </form>
    </AuthFrame>
  )
}

export interface JoinValues { name: string; username: string; password: string }

/**
 * The new-account form of an invite and of the team invite link: name, username, password. No second password field:
 * the eye button inside the field shows what was typed (PasswordField; the setup form has the same).
 * The same rules as before: the username rule while typing, the length before sending, the server's words after.
 */
export function JoinForm({ submitLabel, busy, error, onSubmit, onTooShort }: { submitLabel: string; busy: boolean; error: string | null; onSubmit: (v: JoinValues) => void; onTooShort: () => void }) {
  const t = useT()
  const [form, setForm] = useState({ name: '', username: '', password: '' })
  const reveal = usePasswordReveal()
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }))
  // the form checks its own fields (noValidate): errors under the field in the screen language, never a browser popup
  const { errorOf, check } = useFieldChecks({ name: requiredCheck(form.name), username: usernameCheck(form.username), password: form.password ? null : 'auth.required' })
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!check(e.currentTarget)) return
    if ([...form.password].length < PASSWORD_MIN) return onTooShort()
    onSubmit({ name: form.name.trim(), username: form.username.trim(), password: form.password })
  }
  return (
    <form onSubmit={submit} noValidate className="space-y-3" data-testid="join-form">
      <Field label={t('auth.name')} error={errorOf('name')}>
        <input className={inputCls} name="name" value={form.name} onChange={set('name')} required autoComplete="name" maxLength={100} data-testid="invite-name" />
      </Field>
      <Field label={t('auth.username')} hint={t('auth.usernameHint')} error={errorOf('username') ?? (usernameProblem(form.username) ? t('auth.usernameHint') : null)}>
        <input className={inputCls} name="username" value={form.username} onChange={set('username')} required autoComplete="username" autoCapitalize="none" pattern="[A-Za-z0-9._@\-]{2,64}" data-testid="invite-username" />
      </Field>
      <PasswordField label={t('auth.password')} hint={t('auth.passwordRule')} error={errorOf('password')} reveal={reveal} eyeTestId="invite-password-show" name="password" value={form.password} onChange={set('password')} required autoComplete="new-password" data-testid="invite-password" />
      <CapsLockNote reveal={reveal} />
      <SubmitBar>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <Button type="submit" variant="primary" className="w-full" busy={busy} data-testid="invite-submit">
          {submitLabel}
        </Button>
      </SubmitBar>
    </form>
  )
}

/**
 * A used, expired or unknown invite or team link: the person may well have joined with it already (the link worked
 * once, then they opened it again from the chat), so the page leads to signing in, with a real button.
 */
function SignInInstead() {
  const t = useT()
  const navigate = useNavigate()
  return (
    <>
      <p className="mt-3 text-sm text-ink">{t('auth.alreadyJoined')}</p>
      <Button variant="primary" className="mt-4 w-full" onClick={() => navigate('/login')} data-testid="invalid-signin">
        {t('auth.signIn')}
      </Button>
    </>
  )
}

/** "앱에서 열기": the same join page in the desktop or phone app (its screen ④ asks first). Web browsers on the apps'
 * systems only. On Android, without the app, Chrome opens the "Get the app" address instead. */
function OpenInApp({ path }: { path: string }) {
  const t = useT()
  const href = openInAppHref({ scheme: PRODUCT.linkScheme, origin: window.location.origin, path, platform: platform(), androidPackage: APP_LINKS.androidPackage, androidFallback: getAppHref('android', clientKind(), APP_DOWNLOADS) })
  if (!openInAppShown(clientKind(), href)) return null
  return (
    <p className="mt-2 text-center text-sm">
      <a href={href} className="text-accent-text underline" data-testid="open-in-app">
        {t('auth.openInApp')}
      </a>
    </p>
  )
}

/**
 * Both join pages (docs/DECISIONS.md "Get the app"). In a phone's web browser the link landed here because the app is
 * not installed (with it, the link opens the app), so the page leads with one button that copies this invite or team
 * link and goes to the App Store (or Android's download page), and says to paste the link on the app's first screen
 * (its one box takes an invite link, a team link or an address). The copy happens only on that tap, never on load, and
 * nothing else carries the token into the new app (no fingerprint; the app never reads the clipboard by itself). The
 * form stays behind "Continue in the browser". Computers and our own apps get the form as before.
 */
function JoinChoices({ path, children }: { path: string; children: ReactNode }) {
  const t = useT()
  const [web, setWeb] = useState(false)
  // after a tap whose copy was not certain at once: the page stays ('checking'), then says it copied, or shows the
  // link to copy by hand ('failed'); both offer the store as a plain link
  const [manual, setManual] = useState<null | 'checking' | 'copied' | 'failed'>(null)
  const store = getAppHref(platform(), clientKind(), APP_DOWNLOADS)
  if (!store || web)
    return (
      <>
        {children}
        <HaveAccount />
        <OpenInApp path={path} />
      </>
    )
  // this page's own link (the team link's token from memory: the address bar no longer has it), for the person's own
  // paste in the app; the store address stays the fixed one, with nothing of it
  const link = window.location.origin + path
  const onAndroid = platform() === 'android'
  const copied = () => {
    setManual('copied')
    toast({ level: 'success', text: t('auth.linkCopied') })
  }
  // the copy runs inside the tap; when it worked, the tap's own navigation to the store goes ahead (no scripted
  // navigation after an await: Safari and iOS web views treat those differently). When it did not, the page stays,
  // so nobody installs with nothing to paste
  const tap = (e: React.MouseEvent<HTMLAnchorElement>) => {
    const r = copyInTap(link, { doc: document, clipboard: navigator.clipboard })
    if (r.now) {
      toast({ level: 'success', text: t('auth.linkCopied') })
      return
    }
    e.preventDefault()
    setManual('checking')
    void (r.later ?? Promise.resolve(false)).then((ok) => (ok ? copied() : setManual('failed')))
  }
  const copyAgain = () => {
    const r = copyInTap(link, { doc: document, clipboard: navigator.clipboard })
    if (r.now) return copied()
    void r.later?.then((ok) => ok && copied())
  }
  // the store this button opens: the App Store, Google Play, or (a build without a Play listing) the download page
  const goLabel = t(!onAndroid ? 'auth.goAppStore' : APP_DOWNLOADS.android && store === APP_DOWNLOADS.android ? 'auth.goGooglePlay' : 'auth.goDownloadPage')
  return (
    <div data-testid="get-app">
      <a
        href={store}
        rel="noreferrer noopener"
        onClick={tap}
        className="flex min-h-10 w-full items-center justify-center rounded-lg bg-accent px-3.5 py-2 text-center text-sm font-medium text-accent-ink hover:bg-accent-hover"
        data-testid="get-app-store"
      >
        {t('auth.getApp')}
      </a>
      {manual === 'failed' && (
        <div className="mt-3 flex flex-col gap-2" data-testid="get-app-manual">
          <p role="alert" className="text-sm text-ink">{t('auth.linkNotCopied')}</p>
          <div className="flex gap-2">
            <input
              readOnly
              value={link}
              aria-label={t('auth.inviteLinkLabel')}
              onFocus={(e) => e.currentTarget.select()}
              className={clsx(inputCls, 'min-w-0 flex-1')}
              data-testid="get-app-link"
            />
            <Button onClick={copyAgain} data-testid="get-app-copy">{t('common.copy')}</Button>
          </div>
        </div>
      )}
      {(manual === 'failed' || manual === 'copied') && (
        <p className="mt-2 text-center text-sm">
          <a href={store} rel="noreferrer noopener" className="text-accent-text underline" data-testid="get-app-go">{goLabel}</a>
        </p>
      )}
      <p className="mt-2 text-center text-sm text-muted" data-testid="get-app-hint">{t('auth.getAppHint')}</p>
      <OpenInApp path={path} />
      <p className="mt-4 text-center text-sm">
        <button type="button" className="text-accent-text underline" onClick={() => setWeb(true)} data-testid="get-app-web">
          {t('auth.continueInBrowser')}
        </button>
      </p>
      <HaveAccount />
    </div>
  )
}

/** Both join pages' title: "{inviter} invited you to {team}" when the link's or invite's maker is known (docs/DECISIONS.md
 * "A welcome for invited people"), else "Join {team}". */
export const joinTitle = (t: ReturnType<typeof useT>, team: string, inviter: string | null | undefined) =>
  inviter ? t('invite.invitedBy', { inviter, team }) : t('invite.joinTeam', { team })

/** Under both join forms: someone who already has an account here signs in instead of making a second one. */
function HaveAccount() {
  const t = useT()
  return (
    <p className="mt-4 text-center text-sm text-muted" data-testid="join-have-account">
      {t('auth.haveAccount')}{' '}
      <Link to="/login" className="text-accent-text underline" data-testid="join-signin">
        {t('auth.signIn')}
      </Link>
    </p>
  )
}

/**
 * An invite link opened while someone is signed in (a shared phone or computer, an admin trying the link they made, the
 * phone app already on this team): say who is signed in and offer to sign out to accept it, or to keep the account.
 * Before, the link opened Home without a word and the invite was lost (QA TC-134, TC-174). Signing out shows the
 * invite page at the same address (the signed-out routes in App.tsx).
 */
export function InviteWhileSignedIn() {
  const t = useT()
  const me = useMe()
  const { token } = useParams()
  const signedOut = useSession((s) => s.signedOut)
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  const leave = async () => {
    setBusy(true)
    await api.call(API.logout).catch(() => {})
    clearLocalData()
    signedOut()
    navigate(`/invite/${encodeURIComponent(token ?? '')}`, { replace: true })
  }
  return (
    <AuthFrame title={t('invite.signedInTitle')} sub={t('invite.signedInBody', { name: me?.user.name ?? me?.user.username ?? '' })} switcher={false}>
      <div className="flex flex-col gap-2" data-testid="invite-signed-in">
        <Button variant="primary" disabled={busy} onClick={() => void leave()} data-testid="invite-sign-out">{t('invite.signOutAccept')}</Button>
        <Button disabled={busy} onClick={() => navigate('/', { replace: true })} data-testid="invite-keep">{t('invite.keepAccount')}</Button>
      </div>
    </AuthFrame>
  )
}

export function AcceptInvite() {
  const t = useT()
  const locale = useLocale()
  const { token } = useParams()
  const signedIn = useSession((s) => s.signedIn)
  const navigate = useNavigate()
  const [info, setInfo] = useState<InviteInfo | null | 'missing'>(null)
  // the details did not load (no connection, a server error): why, and a way to try again (LoadFailed), as the team link
  const [loadFailed, setLoadFailed] = useState<{ e: unknown } | null>(null)
  const [attempt, setAttempt] = useState(0)
  const { busy, error, run, setError } = useSubmit()
  useEffect(() => {
    let live = true
    setLoadFailed(null)
    api.call(API.inviteInfo, { params: { token: token! } }).then(
      (i) => live && setInfo(i),
      (e) => {
        if (!live) return
        // the server's own "no such invite" / "used or expired"; a 404 page without its answer (a relay or proxy in
        // between) is a failed load, as on the team link
        if ((isApiError(e, 'not_found') && e.body.params?.httpStatus === undefined) || isApiError(e, 'gone')) setInfo('missing')
        else setLoadFailed({ e })
      },
    )
    return () => {
      live = false
    }
  }, [token, attempt])
  const submit = (v: JoinValues) =>
    void run(async () => {
      const r = await api.call(API.acceptInvite, { params: { token: token! }, body: { ...v, locale: storedLocale() ?? undefined, client: clientKind(), tokenMode: 'cookie' } })
      signedIn(r.me)
      navigate('/', { replace: true })
    })
  if (info === null)
    return (
      <AuthFrame title={t('invite.title')}>
        {loadFailed ? <LoadFailed e={loadFailed.e} onRetry={() => setAttempt((n) => n + 1)} /> : <Loader2 className="mx-auto animate-spin text-faint" aria-label={t('common.loading')} />}
      </AuthFrame>
    )
  if (info === 'missing' || !info.valid)
    return (
      <AuthFrame title={t('invite.title')}>
        <p className="text-sm text-muted">{t('invite.invalid')}</p>
        <SignInInstead />
      </AuthFrame>
    )
  return (
    <AuthFrame title={joinTitle(t, info.teamName, info.inviterName)} sub={t('invite.sub', { role: t(`role.${info.role}`), date: formatDateTime(info.expiresAt, locale) })}>
      <JoinChoices path={`/invite/${token}`}>
        <JoinForm submitLabel={t('invite.accept')} busy={busy} error={error} onSubmit={submit} onTooShort={() => setError('auth.passwordRule')} />
      </JoinChoices>
    </AuthFrame>
  )
}

/**
 * /join#t=<token>: the team invite link (one link for many people; it makes members only). The token is read from the
 * fragment and leaves the address bar at once; it goes to the server only in a POST body. This tab keeps it until the
 * person joined or the server said the link does not work (lib/team-link.ts tabJoinToken), and details that did not
 * load (a weak connection) can be loaded again. After joining, a link that names a skill opens that skill's form
 * (`/skills?run=`) when the new member can read it, else Home.
 */
export function TeamJoin() {
  const t = useT()
  const locale = useLocale()
  const signedIn = useSession((s) => s.signedIn)
  const navigate = useNavigate()
  const [link] = useState(() => tabJoinToken(window.location))
  const [info, setInfo] = useState<TeamLinkInfo | null | 'missing'>(link.token ? null : 'missing')
  // the details did not load (no connection, a server error): why, and a way to try again; never "the link is wrong"
  const [loadFailed, setLoadFailed] = useState<{ e: unknown } | null>(null)
  const [attempt, setAttempt] = useState(0)
  const { busy, error, run, setError } = useSubmit()
  useEffect(() => {
    if (link.cleanUrl) window.history.replaceState(window.history.state, '', link.cleanUrl)
  }, [link])
  useEffect(() => {
    if (!link.token) return
    let live = true
    setLoadFailed(null)
    api.call(API.teamLinkInfo, { body: { token: link.token } }).then(
      (i) => {
        if (!live) return
        if (!i.valid) forgetJoinToken()
        setInfo(i)
      },
      (e) => {
        if (!live) return
        // the server's own "no such link"; a 404 page without its answer (a relay or proxy in between) is a failed load
        if (isApiError(e, 'not_found') && e.body.params?.httpStatus === undefined) {
          forgetJoinToken()
          setInfo('missing')
        } else setLoadFailed({ e })
      },
    )
    return () => {
      live = false
    }
  }, [link, attempt])
  const submit = (v: JoinValues) =>
    void run(async () => {
      const r = await api.call(API.joinTeamLink, { body: { token: link.token!, ...v, locale: storedLocale() ?? undefined, client: clientKind(), tokenMode: 'cookie' } })
      // every skill opens on its form, whose box starts with the skill's own example when it has no fields
      // (docs/DECISIONS.md "W5"); no skill: Home
      const next = joinNext(r.next)
      // a team skill a person made: its form says who ("지훈님이 만든 팀 스킬이에요", docs/DECISIONS.md "S")
      const by = r.skillBy ?? null
      const formPath = by && next.startsWith('/skills?run=') ? new URLSearchParams(next.slice('/skills?'.length)).get('run') : null
      if (formPath && by) holdMadeBy(r.me.user.id, formPath, by)
      forgetJoinToken()
      setAfterJoin(next)
      signedIn(r.me)
      navigate(next, { replace: true })
    })
  if (info === null)
    return (
      <AuthFrame title={t('invite.title')}>
        {loadFailed ? <LoadFailed e={loadFailed.e} onRetry={() => setAttempt((n) => n + 1)} /> : <Loader2 className="mx-auto animate-spin text-faint" aria-label={t('common.loading')} />}
      </AuthFrame>
    )
  if (info === 'missing' || !info.valid)
    return (
      <AuthFrame title={t('invite.title')}>
        <p className="text-sm text-muted" data-testid="join-problem">{t(info === 'missing' ? 'teamLink.problem.missing' : `teamLink.problem.${info.problem === 'stopped' || !info.problem ? 'revoked' : info.problem}`)}</p>
        <SignInInstead />
      </AuthFrame>
    )
  return (
    <AuthFrame title={joinTitle(t, info.teamName, info.inviterName)} sub={info.skillName ? t('teamLink.joinSubSkill', { skill: skillLabel({ name: info.skillName, title: info.skillTitle }) }) : t('teamLink.joinSub', { date: formatDateTime(info.expiresAt, locale) })}>
      <JoinChoices path={`/join#t=${link.token}`}>
        <JoinForm submitLabel={t('invite.accept')} busy={busy} error={error} onSubmit={submit} onTooShort={() => setError('auth.passwordRule')} />
      </JoinChoices>
    </AuthFrame>
  )
}

/** /reset-password/<token>: a one-time link an admin made (or the owner's recovery from the server Mac). */
export function ResetPassword() {
  const t = useT()
  const locale = useLocale()
  const { token } = useParams()
  const signedIn = useSession((s) => s.signedIn)
  const navigate = useNavigate()
  const [info, setInfo] = useState<PasswordResetInfo | null | 'missing'>(null)
  const [form, setForm] = useState({ password: '', password2: '' })
  const { busy, error, run, setError, setFailure } = useSubmit()
  useEffect(() => {
    let live = true
    api.call(API.passwordResetInfo, { params: { token: token! } }).then(
      (i) => live && setInfo(i),
      (e) => live && (isApiError(e, 'not_found') || isApiError(e, 'gone') ? setInfo('missing') : setFailure(e)),
    )
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }))
  const { errorOf, check } = useFieldChecks({ password: form.password ? null : 'auth.required', password2: form.password2 ? null : 'auth.required' })
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!check(e.currentTarget)) return
    if (form.password !== form.password2) return setError('auth.passwordMismatch')
    if ([...form.password].length < PASSWORD_MIN) return setError('auth.passwordRule')
    void run(async () => {
      const r = await api.call(API.completePasswordReset, { params: { token: token! }, body: { newPassword: form.password, client: clientKind(), tokenMode: 'cookie' } })
      signedIn(r.me, { adoptPick: true })
      navigate('/', { replace: true })
    })
  }
  if (info === null)
    return (
      <AuthFrame title={t('reset.title')}>
        {error ? <p role="alert" className="text-sm text-danger">{error}</p> : <Loader2 className="mx-auto animate-spin text-faint" aria-label={t('common.loading')} />}
      </AuthFrame>
    )
  if (info === 'missing' || !info.valid)
    return (
      <AuthFrame title={t('reset.title')}>
        <p className="text-sm text-muted">{t('reset.invalid')}</p>
        <Link to="/login" className="mt-4 inline-block text-sm text-accent-text underline">
          {t('auth.signIn')}
        </Link>
      </AuthFrame>
    )
  return (
    <AuthFrame title={t('reset.title')} sub={t('reset.sub', { name: info.name ?? '', username: info.username ?? '', date: info.expiresAt ? formatDateTime(info.expiresAt, locale) : '' })}>
      <form onSubmit={submit} noValidate className="space-y-3">
        <input type="text" name="username" value={info.username ?? ''} autoComplete="username" readOnly hidden />
        <Field label={t('auth.password')} hint={t('auth.passwordRule')} error={errorOf('password')}>
          <input className={inputCls} name="password" type="password" value={form.password} onChange={set('password')} required autoComplete="new-password" data-testid="reset-password" />
        </Field>
        <Field label={t('auth.passwordAgain')} error={errorOf('password2')}>
          <input className={inputCls} name="password2" type="password" value={form.password2} onChange={set('password2')} required autoComplete="new-password" data-testid="reset-password2" />
        </Field>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <Button type="submit" variant="primary" className="w-full" busy={busy} data-testid="reset-submit">
          {t('reset.submit')}
        </Button>
      </form>
    </AuthFrame>
  )
}

/**
 * Change own password. Settings: current + new + again. Forced change right after signing in with a temporary
 * password (`Me.session.tempLogin`): only new + again, the sign-in just proved the temporary one (the server allows
 * that only for such a session). A forced change in an older session still asks for the temporary password.
 */
export function ChangePasswordForm({ onDone, forced }: { onDone: () => void; forced?: boolean }) {
  const t = useT()
  const me = useMe()
  const withoutCurrent = !!forced && !!me?.session.tempLogin
  const [form, setForm] = useState({ current: '', next: '', next2: '' })
  // typing blind twice: let the person see what they typed, and say when Caps Lock is on
  const reveal = usePasswordReveal()
  const { busy, error, run, setError } = useSubmit()
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }))
  const { errorOf, check } = useFieldChecks({
    current: withoutCurrent || form.current ? null : 'auth.required',
    next: form.next ? null : 'auth.required',
    next2: form.next2 ? null : 'auth.required',
  })
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!check(e.currentTarget)) return
    if (form.next !== form.next2) return setError('auth.passwordMismatch')
    if ([...form.next].length < PASSWORD_MIN) return setError('auth.passwordRule')
    void run(async () => {
      await api.call(API.changePassword, { body: withoutCurrent ? { newPassword: form.next } : { currentPassword: form.current, newPassword: form.next } })
      setForm({ current: '', next: '', next2: '' })
      onDone()
    })
  }
  return (
    <form onSubmit={submit} noValidate className="space-y-3">
      {/* lets a password manager file the new password under the right account */}
      {me && <input type="text" name="username" value={me.user.username} autoComplete="username" readOnly hidden />}
      {!withoutCurrent && (
        <Field label={forced ? t('auth.temporaryPassword') : t('auth.currentPassword')} error={errorOf('current')}>
          <input className={inputCls} name="current" type="password" value={form.current} onChange={set('current')} required autoComplete="current-password" data-testid="password-current" />
        </Field>
      )}
      <PasswordField label={t('auth.newPassword')} hint={t('auth.passwordRule')} error={errorOf('next')} reveal={reveal} eyeTestId="password-show" name="next" value={form.next} onChange={set('next')} required autoComplete="new-password" autoFocus={withoutCurrent} data-testid="password-new" />
      {/* the one eye button above shows both fields */}
      <PasswordField label={t('auth.passwordAgain')} error={errorOf('next2')} reveal={reveal} eye={false} name="next2" value={form.next2} onChange={set('next2')} required autoComplete="new-password" data-testid="password-new2" />
      <CapsLockNote reveal={reveal} />
      {/* the forced change is a sign-in style page: its button stays above a phone's keyboard; in Settings it is a plain row */}
      <SubmitBar plain={!forced}>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <Button type="submit" variant="primary" busy={busy} className={forced ? 'w-full' : undefined} data-testid="password-submit">
          {t('auth.changePassword')}
        </Button>
      </SubmitBar>
    </form>
  )
}

/** Where a signed-in person lands (after the sign-in page, and after the forced password change): Home, or on a phone
 * (where the tab bar is) the list of the tab the app opens on (lib/tabs.ts START_TAB: 트리나, which is Home). */
export function signedInHome(): string {
  const phone = typeof window !== 'undefined' && !!window.matchMedia && !window.matchMedia('(min-width: 768px)').matches
  return landingPath(phone)
}

export function ForcedPassword() {
  const t = useT()
  const load = useSession((s) => s.load)
  const signedOut = useSession((s) => s.signedOut)
  const me = useMe()
  const tempLogin = !!me?.session.tempLogin
  const navigate = useNavigate()
  // where the person was heading (a Slack or connector link that asked them to sign in first): there after the change
  const next = safeNext(useLocation().search)
  // a shared desk: someone who signed in with the wrong account can leave without changing that password
  const otherAccount = async () => {
    await api.call(API.logout).catch(() => {})
    clearLocalData()
    signedOut()
    navigate('/login', { replace: true })
  }
  return (
    <AuthFrame title={t('auth.changePassword')} sub={t(tempLogin ? 'auth.mustChangeNew' : 'auth.mustChange')}>
      {me && <p className="mb-3 text-sm text-ink" data-testid="forced-username">{t('auth.username')}: <span className="font-mono">{me.user.username}</span></p>}
      <ChangePasswordForm
        forced
        onDone={async () => {
          await load()
          navigate(next ?? signedInHome(), { replace: true })
        }}
      />
      <button type="button" onClick={() => void otherAccount()} className="mt-4 block text-sm text-accent-text underline" data-testid="forced-other-account">
        {t('auth.otherAccount')}
      </button>
    </AuthFrame>
  )
}
