// Sign-in, first-run setup (/setup#token=… or /setup?token=), invite acceptance (/invite/:token), the team invite link
// (/join#t=…) and the forced password change.
import clsx from 'clsx'
import { Eye, EyeOff, Loader2 } from 'lucide-react'
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { PRODUCT } from '@mycel/shared'
import type { InviteInfo, Locale, PasswordResetInfo, TeamLinkInfo } from '@mycel/shared/api'
import { api, API, errorText, isApiError } from '../lib/api'
import { ERROR_MESSAGES } from '@mycel/shared/api'
import { formatDateTime } from '../lib/format'
import { browserLocale, LOCALES, storedLocale, storeLocale, useLocale, useLocaleStore, useT, type MessageKey } from '../i18n'
import { useMe, useSession } from '../store/session'
import { clientKind } from '../lib/desktop'
import { clearLocalData } from '../lib/localData'
import { readSetupLink, rememberSetupSite } from '../lib/setupLink'
import { setAfterSetup } from '../lib/welcome'
import { joinNext, readJoinToken, setAfterJoin } from '../lib/team-link'
import { holdStarter } from '../lib/starter'
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

function AuthFrame({ title, children, sub, switcher = true }: { title: string; children: ReactNode; sub?: ReactNode; switcher?: boolean }) {
  return (
    <div className="flex min-h-full flex-col items-center justify-center bg-canvas px-4 py-10">
      <main className="w-full max-w-sm">
        <p className="mb-6 flex items-center justify-center gap-2 text-xl font-semibold tracking-tight">
          <img src="/favicon.svg" alt="" aria-hidden className="size-7 rounded-lg" />
          {PRODUCT.displayName}
        </p>
        <div className="rounded-2xl border border-line bg-surface p-6 shadow-[var(--c-shadow)]">
          <h1 className={clsx('text-lg font-semibold', sub ? 'mb-1' : 'mb-4')}>{title}</h1>
          {sub && <div className="mb-4 text-sm text-muted">{sub}</div>}
          {children}
        </div>
        {switcher && <LanguageSwitcher />}
        <SourceCodeLink className="mt-4 block text-center text-xs text-faint hover:text-muted" />
      </main>
    </div>
  )
}

/** An error on screen: a text key of ours, or what the server said. Drawn in the language on screen. */
type Shown = { key: MessageKey } | { e: unknown }

function useSubmit() {
  const t = useT()
  const locale = useLocale()
  const [busy, setBusy] = useState(false)
  const [shown, setShown] = useState<Shown | null>(null)
  // a server's own sentence can't be redrawn in another language: after a switch it goes (our own texts follow)
  const [shownIn, setShownIn] = useState(locale)
  if (shownIn !== locale) {
    setShownIn(locale)
    if (shown && 'e' in shown && !followsLocale(shown.e)) setShown(null)
  }
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

/** errorText() draws network errors and the server's default messages in the screen language. */
const followsLocale = (e: unknown) => !isApiError(e) || Object.values(ERROR_MESSAGES[e.code] ?? {}).includes(e.message)

export function Login() {
  const t = useT()
  const signedIn = useSession((s) => s.signedIn)
  const status = useSession((s) => s.status)
  const navigate = useNavigate()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const { busy, error, run } = useSubmit()
  const { errorOf, check } = useFieldChecks({ username: requiredCheck(username), password: password ? null : 'auth.required' })
  const reason = status.kind === 'signed-out' ? status.reason : undefined
  // a demo server (`bun run demo:trina`): one action, start as the new hire; the usual form is one link away
  const { info: demo } = useDemoInfo()
  const [form, setForm] = useState(false)
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!check(e.currentTarget)) return
    void run(async () => {
      const r = await api.call(API.login, { body: { username: username.trim(), password, client: clientKind(), tokenMode: 'cookie' } })
      signedIn(r.me, { adoptPick: true })
      // the router sends a signed-in person on /login to ?next= (App.tsx AfterSignIn), or to /password
      if (r.me.user.mustChangePassword) navigate('/password', { replace: true })
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
  const [form, setForm] = useState({ setupToken: link.token ?? '', teamName: link.team ?? '', name: '', username: '', password: '', password2: '' })
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
    setupToken: link.token ? null : requiredCheck(form.setupToken),
    teamName: requiredCheck(form.teamName),
    name: requiredCheck(form.name),
    username: usernameCheck(form.username),
    password: form.password ? null : 'auth.required',
    password2: form.password2 ? null : 'auth.required',
  })
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!check(e.currentTarget)) return
    if (form.password !== form.password2) return setError('auth.passwordMismatch')
    if ([...form.password].length < PASSWORD_MIN) return setError('auth.passwordRule')
    void run(async () => {
      // the team's time zone starts as this browser's (Admin > Settings changes it)
      const timeZone = browserTimeZone()
      const r = await api.call(API.setup, { body: { setupToken: form.setupToken.trim(), teamName: form.teamName.trim(), locale, ...(timeZone ? { timeZone } : {}), owner: { username: form.username.trim(), name: form.name.trim(), password: form.password } } })
      // the company website from the link: the company profile step starts from it (components/onboarding)
      rememberSetupSite(link.site)
      // then the welcome steps (pages/Welcome.tsx): set before the session switch re-renders /setup (App.tsx AfterSetup)
      setAfterSetup('/welcome')
      signedIn(r.me)
      navigate('/welcome', { replace: true })
    })
  }
  return (
    // the "Team language" field below is this screen's language switcher too (one picker, not two)
    <AuthFrame title={t('setup.title')} sub={t('setup.sub')} switcher={false}>
      <form onSubmit={submit} noValidate className="space-y-3">
        {!link.token && (
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
        <Field label={t('auth.name')} error={errorOf('name')}>
          <input className={inputCls} name="name" value={form.name} onChange={set('name')} required autoComplete="name" maxLength={100} />
        </Field>
        <Field label={t('auth.username')} hint={t('auth.usernameHint')} error={errorOf('username') ?? (usernameProblem(form.username) ? t('auth.usernameHint') : null)}>
          <input className={inputCls} name="username" value={form.username} onChange={set('username')} required autoComplete="username" autoCapitalize="none" pattern="[A-Za-z0-9._@\-]{2,64}" />
        </Field>
        <Field label={t('auth.password')} hint={t('auth.passwordRule')} error={errorOf('password')}>
          <input className={inputCls} name="password" type="password" value={form.password} onChange={set('password')} required autoComplete="new-password" />
        </Field>
        <Field label={t('auth.passwordAgain')} error={errorOf('password2')}>
          <input className={inputCls} name="password2" type="password" value={form.password2} onChange={set('password2')} required autoComplete="new-password" />
        </Field>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <Button type="submit" variant="primary" className="w-full" busy={busy}>
          {t('setup.create')}
        </Button>
      </form>
    </AuthFrame>
  )
}

export interface JoinValues { name: string; username: string; password: string }

/**
 * The new-account form of an invite and of the team invite link: name, username, password. No second password field:
 * the eye button shows what was typed (and Caps Lock is named), which catches a typo better than typing blind twice.
 * The same rules as before: the username rule while typing, the length before sending, the server's words after.
 */
export function JoinForm({ submitLabel, busy, error, onSubmit, onTooShort }: { submitLabel: string; busy: boolean; error: string | null; onSubmit: (v: JoinValues) => void; onTooShort: () => void }) {
  const t = useT()
  const [form, setForm] = useState({ name: '', username: '', password: '' })
  const [show, setShow] = useState(false)
  const [capsOn, setCapsOn] = useState(false)
  const caps = (e: React.KeyboardEvent) => setCapsOn(e.getModifierState?.('CapsLock') ?? false)
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
      <Field label={t('auth.password')} hint={t('auth.passwordRule')} error={errorOf('password')}>
        <input className={inputCls} name="password" type={show ? 'text' : 'password'} value={form.password} onChange={set('password')} onKeyDown={caps} onKeyUp={caps} required autoComplete="new-password" autoCapitalize="none" data-testid="invite-password" />
      </Field>
      <div className="flex items-center justify-between gap-2">
        <span role="status" className="text-xs text-warn" data-testid="caps-lock">
          {capsOn ? t('auth.capsLock') : ''}
        </span>
        <IconButton label={show ? t('auth.hidePassword') : t('auth.showPassword')} aria-pressed={show} onClick={() => setShow(!show)} data-testid="invite-password-show">
          {show ? <EyeOff size={15} /> : <Eye size={15} />}
          <span className="ml-1 text-xs">{show ? t('auth.hidePassword') : t('auth.showPassword')}</span>
        </IconButton>
      </div>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <Button type="submit" variant="primary" className="w-full" busy={busy} data-testid="invite-submit">
        {submitLabel}
      </Button>
    </form>
  )
}

export function AcceptInvite() {
  const t = useT()
  const locale = useLocale()
  const { token } = useParams()
  const signedIn = useSession((s) => s.signedIn)
  const navigate = useNavigate()
  const [info, setInfo] = useState<InviteInfo | null | 'missing'>(null)
  const { busy, error, run, setError, setFailure } = useSubmit()
  useEffect(() => {
    let live = true
    api.call(API.inviteInfo, { params: { token: token! } }).then(
      (i) => live && setInfo(i),
      (e) => live && (isApiError(e, 'not_found') || isApiError(e, 'gone') ? setInfo('missing') : setFailure(e)),
    )
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])
  const submit = (v: JoinValues) =>
    void run(async () => {
      const r = await api.call(API.acceptInvite, { params: { token: token! }, body: { ...v, locale: storedLocale() ?? undefined, client: clientKind(), tokenMode: 'cookie' } })
      signedIn(r.me)
      navigate('/', { replace: true })
    })
  if (info === null)
    return (
      <AuthFrame title={t('invite.title')}>
        {error ? <p role="alert" className="text-sm text-danger">{error}</p> : <Loader2 className="mx-auto animate-spin text-faint" aria-label={t('common.loading')} />}
      </AuthFrame>
    )
  if (info === 'missing' || !info.valid)
    return (
      <AuthFrame title={t('invite.title')}>
        <p className="text-sm text-muted">{t('invite.invalid')}</p>
        <Link to="/login" className="mt-4 inline-block text-sm text-accent-text underline">
          {t('auth.signIn')}
        </Link>
      </AuthFrame>
    )
  return (
    <AuthFrame title={t('invite.joinTeam', { team: info.teamName })} sub={t('invite.sub', { role: t(`role.${info.role}`), date: formatDateTime(info.expiresAt, locale) })}>
      <JoinForm submitLabel={t('invite.accept')} busy={busy} error={error} onSubmit={submit} onTooShort={() => setError('auth.passwordRule')} />
    </AuthFrame>
  )
}

/**
 * /join#t=<token>: the team invite link (one link for many people; it makes members only). The token is read from the
 * fragment and leaves the address bar at once; it goes to the server only in a POST body. After joining, a link that
 * names a skill opens that skill's form (`/skills?run=`) when the new member can read it, else Home.
 */
export function TeamJoin() {
  const t = useT()
  const locale = useLocale()
  const signedIn = useSession((s) => s.signedIn)
  const navigate = useNavigate()
  const [link] = useState(() => readJoinToken(window.location))
  const [info, setInfo] = useState<TeamLinkInfo | null | 'missing'>(link.token ? null : 'missing')
  const { busy, error, run, setError, setFailure } = useSubmit()
  useEffect(() => {
    if (link.cleanUrl) window.history.replaceState(window.history.state, '', link.cleanUrl)
    if (!link.token) return
    let live = true
    api.call(API.teamLinkInfo, { body: { token: link.token } }).then(
      (i) => live && setInfo(i),
      (e) => live && (isApiError(e, 'not_found') ? setInfo('missing') : setFailure(e)),
    )
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const submit = (v: JoinValues) =>
    void run(async () => {
      const r = await api.call(API.joinTeamLink, { body: { token: link.token!, ...v, locale: storedLocale() ?? undefined, client: clientKind(), tokenMode: 'cookie' } })
      // the lead's files waiting for them (docs/DECISIONS.md "M"): Home fills the box with them and the question
      if (r.starter) holdStarter(r.me.user.id, r.starter)
      const next = r.starter ? '/' : joinNext(r.next)
      setAfterJoin(next)
      signedIn(r.me)
      navigate(next, { replace: true })
    })
  if (info === null)
    return (
      <AuthFrame title={t('invite.title')}>
        {error ? <p role="alert" className="text-sm text-danger">{error}</p> : <Loader2 className="mx-auto animate-spin text-faint" aria-label={t('common.loading')} />}
      </AuthFrame>
    )
  if (info === 'missing' || !info.valid)
    return (
      <AuthFrame title={t('invite.title')}>
        <p className="text-sm text-muted" data-testid="join-problem">{t(info === 'missing' ? 'teamLink.problem.missing' : `teamLink.problem.${info.problem === 'stopped' || !info.problem ? 'revoked' : info.problem}`)}</p>
        <Link to="/login" className="mt-4 inline-block text-sm text-accent-text underline">
          {t('auth.signIn')}
        </Link>
      </AuthFrame>
    )
  return (
    <AuthFrame title={t('invite.joinTeam', { team: info.teamName })} sub={info.skillName ? t('teamLink.joinSubSkill', { skill: info.skillTitle ?? info.skillName }) : t('teamLink.joinSub', { date: formatDateTime(info.expiresAt, locale) })}>
      <JoinForm submitLabel={t('invite.accept')} busy={busy} error={error} onSubmit={submit} onTooShort={() => setError('auth.passwordRule')} />
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
  const [show, setShow] = useState(false)
  const [capsOn, setCapsOn] = useState(false)
  const caps = (e: React.KeyboardEvent) => setCapsOn(e.getModifierState?.('CapsLock') ?? false)
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
      <Field label={t('auth.newPassword')} hint={t('auth.passwordRule')} error={errorOf('next')}>
        <input className={inputCls} name="next" type={show ? 'text' : 'password'} value={form.next} onChange={set('next')} onKeyDown={caps} onKeyUp={caps} required autoComplete="new-password" autoCapitalize="none" autoFocus={withoutCurrent} data-testid="password-new" />
      </Field>
      <Field label={t('auth.passwordAgain')} error={errorOf('next2')}>
        <input className={inputCls} name="next2" type={show ? 'text' : 'password'} value={form.next2} onChange={set('next2')} onKeyDown={caps} onKeyUp={caps} required autoComplete="new-password" autoCapitalize="none" data-testid="password-new2" />
      </Field>
      <div className="flex items-center justify-between gap-2">
        <span role="status" className="text-xs text-warn" data-testid="caps-lock">
          {capsOn ? t('auth.capsLock') : ''}
        </span>
        <IconButton label={show ? t('auth.hidePassword') : t('auth.showPassword')} aria-pressed={show} onClick={() => setShow(!show)} data-testid="password-show">
          {show ? <EyeOff size={15} /> : <Eye size={15} />}
          <span className="ml-1 text-xs">{show ? t('auth.hidePassword') : t('auth.showPassword')}</span>
        </IconButton>
      </div>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <Button type="submit" variant="primary" busy={busy} data-testid="password-submit">
        {t('auth.changePassword')}
      </Button>
    </form>
  )
}

export function ForcedPassword() {
  const t = useT()
  const load = useSession((s) => s.load)
  const signedOut = useSession((s) => s.signedOut)
  const me = useMe()
  const tempLogin = !!me?.session.tempLogin
  const navigate = useNavigate()
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
          navigate('/', { replace: true })
        }}
      />
      <button type="button" onClick={() => void otherAccount()} className="mt-4 block text-sm text-accent-text underline" data-testid="forced-other-account">
        {t('auth.otherAccount')}
      </button>
    </AuthFrame>
  )
}
