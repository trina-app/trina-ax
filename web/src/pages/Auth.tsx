// Sign-in, first-run setup (/setup?token=), invite acceptance (/invite/:token) and the forced password change.
import { Loader2 } from 'lucide-react'
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { PRODUCT } from '@mycel/shared'
import type { InviteInfo, Locale, PasswordResetInfo } from '@mycel/shared/api'
import { api, API, errorText, isApiError } from '../lib/api'
import { formatDateTime } from '../lib/format'
import { LOCALES, useLocale, useLocaleStore, useT } from '../i18n'
import { useSession } from '../store/session'
import { Button, Field, inputCls } from '../components/ui'

function AuthFrame({ title, children, sub }: { title: string; children: ReactNode; sub?: ReactNode }) {
  const t = useT()
  const locale = useLocale()
  const setLocale = useLocaleStore((s) => s.setLocale)
  return (
    <div className="flex min-h-full flex-col items-center justify-center bg-canvas px-4 py-10">
      <main className="w-full max-w-sm">
        <p className="mb-6 text-center text-xl font-semibold tracking-tight">{PRODUCT.displayName}</p>
        <div className="rounded-2xl border border-line bg-surface p-6 shadow-[var(--c-shadow)]">
          <h1 className="mb-1 text-lg font-semibold">{title}</h1>
          {sub && <div className="mb-4 text-sm text-muted">{sub}</div>}
          {children}
        </div>
        <label className="mt-6 flex items-center justify-center gap-2 text-xs text-faint">
          {t('settings.language')}
          <select className="rounded border border-line bg-surface px-1.5 py-1 text-xs text-ink" value={locale} onChange={(e) => setLocale(e.target.value as Locale)}>
            {LOCALES.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </select>
        </label>
      </main>
    </div>
  )
}

function useSubmit() {
  const t = useT()
  const locale = useLocale()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(errorText(e, locale, t('error.network')))
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, run, setError }
}

export function Login() {
  const t = useT()
  const signedIn = useSession((s) => s.signedIn)
  const status = useSession((s) => s.status)
  const navigate = useNavigate()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const { busy, error, run } = useSubmit()
  const reason = status.kind === 'signed-out' ? status.reason : undefined
  const submit = (e: FormEvent) => {
    e.preventDefault()
    void run(async () => {
      const r = await api.call(API.login, { body: { username: username.trim(), password, client: 'web', tokenMode: 'cookie' } })
      signedIn(r.me)
      // the router sends a signed-in person on /login to ?next= (App.tsx AfterSignIn), or to /password
      if (r.me.user.mustChangePassword) navigate('/password', { replace: true })
    })
  }
  return (
    <AuthFrame title={t('auth.signIn')} sub={reason === 'ended' ? t('auth.sessionEnded') : reason === 'expired' ? t('auth.sessionExpired') : undefined}>
      <form onSubmit={submit} className="space-y-4">
        <Field label={t('auth.username')}>
          <input className={inputCls} autoComplete="username" autoCapitalize="none" value={username} onChange={(e) => setUsername(e.target.value)} required data-testid="login-username" />
        </Field>
        <Field label={t('auth.password')}>
          <input className={inputCls} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required data-testid="login-password" />
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
  const signedIn = useSession((s) => s.signedIn)
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const [form, setForm] = useState({ setupToken: params.get('token') ?? '', teamName: '', name: '', username: '', password: '', password2: '' })
  const { busy, error, run, setError } = useSubmit()
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }))
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (form.password !== form.password2) return setError(t('auth.passwordMismatch'))
    if (form.password.length < 10) return setError(t('auth.passwordRule'))
    void run(async () => {
      const r = await api.call(API.setup, { body: { setupToken: form.setupToken.trim(), teamName: form.teamName.trim(), locale, owner: { username: form.username.trim(), name: form.name.trim(), password: form.password } } })
      signedIn(r.me)
      navigate('/', { replace: true })
    })
  }
  return (
    <AuthFrame title={t('setup.title')} sub={t('setup.sub')}>
      <form onSubmit={submit} className="space-y-3">
        {!params.get('token') && (
          <Field label={t('setup.token')} hint={t('setup.tokenHint')}>
            <input className={inputCls} value={form.setupToken} onChange={set('setupToken')} required autoComplete="off" />
          </Field>
        )}
        <Field label={t('setup.teamName')}>
          <input className={inputCls} value={form.teamName} onChange={set('teamName')} required maxLength={100} data-testid="setup-team" />
        </Field>
        <Field label={t('auth.name')}>
          <input className={inputCls} value={form.name} onChange={set('name')} required autoComplete="name" maxLength={100} />
        </Field>
        <Field label={t('auth.username')} hint={t('auth.usernameHint')}>
          <input className={inputCls} value={form.username} onChange={set('username')} required autoComplete="username" autoCapitalize="none" pattern="[A-Za-z0-9._@\-]{2,64}" />
        </Field>
        <Field label={t('auth.password')} hint={t('auth.passwordRule')}>
          <input className={inputCls} type="password" value={form.password} onChange={set('password')} required minLength={10} autoComplete="new-password" />
        </Field>
        <Field label={t('auth.passwordAgain')}>
          <input className={inputCls} type="password" value={form.password2} onChange={set('password2')} required autoComplete="new-password" />
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

export function AcceptInvite() {
  const t = useT()
  const locale = useLocale()
  const { token } = useParams()
  const signedIn = useSession((s) => s.signedIn)
  const navigate = useNavigate()
  const [info, setInfo] = useState<InviteInfo | null | 'missing'>(null)
  const [form, setForm] = useState({ name: '', username: '', password: '', password2: '' })
  const { busy, error, run, setError } = useSubmit()
  useEffect(() => {
    let live = true
    api.call(API.inviteInfo, { params: { token: token! } }).then(
      (i) => live && setInfo(i),
      (e) => live && (isApiError(e, 'not_found') || isApiError(e, 'gone') ? setInfo('missing') : setError(errorText(e, locale, t('error.network')))),
    )
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }))
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (form.password !== form.password2) return setError(t('auth.passwordMismatch'))
    void run(async () => {
      const r = await api.call(API.acceptInvite, { params: { token: token! }, body: { username: form.username.trim(), name: form.name.trim(), password: form.password, locale, client: 'web', tokenMode: 'cookie' } })
      signedIn(r.me)
      navigate('/', { replace: true })
    })
  }
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
      <form onSubmit={submit} className="space-y-3">
        <Field label={t('auth.name')}>
          <input className={inputCls} value={form.name} onChange={set('name')} required autoComplete="name" maxLength={100} data-testid="invite-name" />
        </Field>
        <Field label={t('auth.username')} hint={t('auth.usernameHint')}>
          <input className={inputCls} value={form.username} onChange={set('username')} required autoComplete="username" autoCapitalize="none" pattern="[A-Za-z0-9._@\-]{2,64}" data-testid="invite-username" />
        </Field>
        <Field label={t('auth.password')} hint={t('auth.passwordRule')}>
          <input className={inputCls} type="password" value={form.password} onChange={set('password')} required minLength={10} autoComplete="new-password" data-testid="invite-password" />
        </Field>
        <Field label={t('auth.passwordAgain')}>
          <input className={inputCls} type="password" value={form.password2} onChange={set('password2')} required autoComplete="new-password" data-testid="invite-password2" />
        </Field>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <Button type="submit" variant="primary" className="w-full" busy={busy} data-testid="invite-submit">
          {t('invite.accept')}
        </Button>
      </form>
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
  const { busy, error, run, setError } = useSubmit()
  useEffect(() => {
    let live = true
    api.call(API.passwordResetInfo, { params: { token: token! } }).then(
      (i) => live && setInfo(i),
      (e) => live && (isApiError(e, 'not_found') || isApiError(e, 'gone') ? setInfo('missing') : setError(errorText(e, locale, t('error.network')))),
    )
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }))
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (form.password !== form.password2) return setError(t('auth.passwordMismatch'))
    void run(async () => {
      const r = await api.call(API.completePasswordReset, { params: { token: token! }, body: { newPassword: form.password, client: 'web', tokenMode: 'cookie' } })
      signedIn(r.me)
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
      <form onSubmit={submit} className="space-y-3">
        <input type="text" name="username" value={info.username ?? ''} autoComplete="username" readOnly hidden />
        <Field label={t('auth.password')} hint={t('auth.passwordRule')}>
          <input className={inputCls} type="password" value={form.password} onChange={set('password')} required minLength={10} autoComplete="new-password" data-testid="reset-password" />
        </Field>
        <Field label={t('auth.passwordAgain')}>
          <input className={inputCls} type="password" value={form.password2} onChange={set('password2')} required autoComplete="new-password" data-testid="reset-password2" />
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

export function ChangePasswordForm({ onDone, forced }: { onDone: () => void; forced?: boolean }) {
  const t = useT()
  const [form, setForm] = useState({ current: '', next: '', next2: '' })
  const { busy, error, run, setError } = useSubmit()
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }))
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (form.next !== form.next2) return setError(t('auth.passwordMismatch'))
    if (form.next.length < 10) return setError(t('auth.passwordRule'))
    void run(async () => {
      await api.call(API.changePassword, { body: { currentPassword: form.current, newPassword: form.next } })
      setForm({ current: '', next: '', next2: '' })
      onDone()
    })
  }
  return (
    <form onSubmit={submit} className="space-y-3">
      <Field label={forced ? t('auth.temporaryPassword') : t('auth.currentPassword')}>
        <input className={inputCls} type="password" value={form.current} onChange={set('current')} required autoComplete="current-password" />
      </Field>
      <Field label={t('auth.newPassword')} hint={t('auth.passwordRule')}>
        <input className={inputCls} type="password" value={form.next} onChange={set('next')} required minLength={10} autoComplete="new-password" />
      </Field>
      <Field label={t('auth.passwordAgain')}>
        <input className={inputCls} type="password" value={form.next2} onChange={set('next2')} required autoComplete="new-password" />
      </Field>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <Button type="submit" variant="primary" busy={busy}>
        {t('auth.changePassword')}
      </Button>
    </form>
  )
}

export function ForcedPassword() {
  const t = useT()
  const load = useSession((s) => s.load)
  const navigate = useNavigate()
  return (
    <AuthFrame title={t('auth.changePassword')} sub={t('auth.mustChange')}>
      <ChangePasswordForm
        forced
        onDone={async () => {
          await load()
          navigate('/', { replace: true })
        }}
      />
    </AuthFrame>
  )
}
