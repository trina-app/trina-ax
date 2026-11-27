// Admin › Sign-in methods (docs/decisions/20261127-google-signin-selfhost.md): how people sign in to this team, in one
// place. A Password row (always on, no switch) and a Google row: its On/Off switch (TeamSettings.googleSignIn, saved as
// it is flipped), one status line that says how Google signs in here (through the hosting service's sign-in service,
// through the company's own Google app) or why it can't (no public web address, with the guide; the service can't be
// reached or doesn't serve this server yet), the optional "Only Google Workspace accounts from" domains
// (TeamSettings.googleSignInDomains, checked against Google's `hd` claim on the server, never the e-mail address) and
// "Try it", which opens Google and comes back to a page that says which account answered, signing nobody in
// (server/src/auth/google-login.ts startGoogleTry). It replaces the Google row of Team settings.
import { useEffect, useState } from 'react'
import { GOOGLE_SIGN_IN_DOMAINS_MAX, GoogleDomain, type GoogleSignInAdminStatus } from '@mycel/shared/api'
import { api, API, errorText } from '../../lib/api'
import { useLocale, useT } from '../../i18n'
import { toast } from '../../store/ui'
import { Button, inputCls, Switch } from '../../components/ui'
import { destructive } from '../../lib/destructive'
import { AdminPageHeader, SettingRow, SettingsSection, useAction, useLoad } from './common'

/** where a self-installed server without a public web address reads how to get one, and what Google sign-in needs */
export const SIGN_IN_GUIDE = 'https://ax.trina.app/docs/use/sign-in-with-google/#on-a-server-you-run-yourself'

/** The domains typed in the field: commas or spaces between them, a leading "@" and case dropped, each once. `bad`: the
 * first one that is no domain name. */
export function parseDomains(text: string): { domains: string[]; bad: string | null } {
  const domains: string[] = []
  for (const raw of text.split(/[\s,;]+/)) {
    const d = raw.trim().replace(/^@/, '').replace(/\.$/, '').toLowerCase()
    if (!d) continue
    if (!GoogleDomain.safeParse(d).success) return { domains, bad: raw.trim() }
    if (!domains.includes(d)) domains.push(d)
  }
  return { domains, bad: null }
}

/** The status line under the Google row (GET /api/admin/google-login). */
function statusKey(s: GoogleSignInAdminStatus) {
  if (s.client) return s.via === 'own' ? 'signIn.via.own' as const : 'signIn.via.service' as const
  if (s.reason === 'no_address') return 'signIn.reason.no_address' as const
  if (s.reason === 'unreachable') return 'signIn.reason.unreachable' as const
  if (s.reason === 'not_served') return 'signIn.reason.not_served' as const
  return 'signIn.reason.none' as const
}

export default function SignInMethods() {
  const t = useT()
  return (
    <>
      <AdminPageHeader title={t('admin.signIn')} desc={t('signIn.desc')} testId="sign-in-header" />
      <SettingsSection title={t('signIn.methods')} id="sign-in-methods" testId="sign-in-methods">
        <SettingRow id="sign-in-password" testId="sign-in-password" title={t('signIn.password')} desc={t('signIn.passwordDesc')} inline />
        <GoogleMethod />
      </SettingsSection>
    </>
  )
}

/** The Google row: the switch, the status line, the domains and Try it. */
export function GoogleMethod() {
  const t = useT()
  const locale = useLocale()
  const act = useAction()
  const status = useLoad(() => api.call(API.googleSignInAdminStatus))
  const settings = useLoad(() => api.call(API.settings))
  const [on, setOn] = useState<boolean | null>(null)
  const [saving, setSaving] = useState(false)
  useEffect(() => { if (settings.data) setOn(settings.data.googleSignIn !== false) }, [settings.data])
  // reading, or an older server without the read: no row
  if (!status.data || !settings.data || on === null) return null
  const s = status.data
  const flip = async (v: boolean) => {
    if (saving) return
    setOn(v)
    setSaving(true)
    const r = await act(() => api.call(API.updateSettings, { body: { googleSignIn: v } }), t('common.saved'))
    setSaving(false)
    if (!r) setOn(!v)
  }
  const line = (
    <span data-testid="sign-in-google-status" data-via={s.via ?? 'none'} data-reason={s.reason ?? ''}>
      {t(statusKey(s))}
      {s.reason === 'no_address' && (
        <>
          {' '}
          <a href={SIGN_IN_GUIDE} target="_blank" rel="noreferrer" className="font-medium text-accent-text underline-offset-2 hover:underline" data-testid="sign-in-google-how">{t('signIn.how')}</a>
        </>
      )}
    </span>
  )
  const tryIt = async () => {
    try {
      const r = await api.call(API.tryGoogleSignIn)
      window.location.assign(r.url)
    } catch (e) {
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
    }
  }
  return (
    <SettingRow id="sign-in-google" testId="sign-in-google" title={t('signIn.google')} attrs={{ 'data-on': on ? 'true' : 'false', 'data-client': s.client ? 'yes' : 'none' }} inline
      desc={<>{t('signIn.googleDesc')}<span className="mt-1 block">{line}</span></>} more={t('signIn.googleHint')}
      control={<Switch id="sign-in-google" external describedBy="sign-in-google-desc" checked={on} disabled={saving} onChange={(v) => void flip(v)} label={t('signIn.google')} testId="sign-in-google-switch" />}
      below={s.client ? (
        <div className="space-y-4">
          <GoogleDomains initial={settings.data.googleSignInDomains ?? []} />
          {s.tryable && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <Button size="sm" onClick={() => void tryIt()} data-testid="sign-in-google-try">{t('signIn.try')}</Button>
              <span className="text-xs text-muted">{t('signIn.tryHint')}</span>
            </div>
          )}
        </div>
      ) : undefined} />
  )
}

/** "Only Google Workspace accounts from": optional; saved with its own Save. */
function GoogleDomains({ initial }: { initial: string[] }) {
  const t = useT()
  const act = useAction()
  const [saved, setSaved] = useState(initial.join(', '))
  const [text, setText] = useState(saved)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const save = async () => {
    const { domains, bad } = parseDomains(text)
    if (bad) return setError(t('signIn.domainsBad', { value: bad }))
    if (domains.length > GOOGLE_SIGN_IN_DOMAINS_MAX) return setError(t('signIn.domainsTooMany', { n: GOOGLE_SIGN_IN_DOMAINS_MAX }))
    setError(null)
    setBusy(true)
    // people who sign in only with Google from other domains would be locked out: ask first (the server counts them)
    const check = domains.length ? await act(() => api.call(API.checkGoogleSignInDomains, { body: { domains } })) : { lockedOut: 0 }
    if (!check) return setBusy(false)
    // the one way to ask before something that shuts people out (lib/destructive.ts); the toast is act's "Saved"
    const r = await destructive({
      confirm: check.lockedOut > 0 ? { title: t('signIn.domainsLockTitle'), body: t('signIn.domainsLock', { n: check.lockedOut }), confirm: t('signIn.domainsLockSave') } : undefined,
      run: () => act(() => api.call(API.updateSettings, { body: { googleSignInDomains: domains } }), t('common.saved')),
      done: () => null,
    })
    setBusy(false)
    if (r) { const v = (r.googleSignInDomains ?? []).join(', '); setSaved(v); setText(v) }
  }
  return (
    <div data-testid="sign-in-google-domains">
      <label htmlFor="sign-in-google-domains" className="mb-1.5 block text-label font-medium text-ink">{t('signIn.domains')}</label>
      <div className="flex flex-wrap items-start gap-2">
        <input id="sign-in-google-domains" className={inputCls + ' min-w-0 flex-1 basis-56'} value={text} placeholder="acme.com" autoComplete="off" spellCheck={false} inputMode="url"
          aria-describedby="sign-in-google-domains-hint" aria-invalid={error ? true : undefined}
          onChange={(e) => { setText(e.target.value); setError(null) }} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void save() } }} data-testid="sign-in-google-domains-input" />
        <Button size="sm" className="max-md:min-h-11 md:h-9" busy={busy} disabled={text === saved} onClick={() => void save()} data-testid="sign-in-google-domains-save">{t('common.save')}</Button>
      </div>
      <p id="sign-in-google-domains-hint" className={error ? 'mt-1.5 text-xs text-danger' : 'mt-1.5 text-xs text-muted'} role={error ? 'alert' : undefined} data-testid="sign-in-google-domains-hint">
        {error ?? t('signIn.domainsHint')}
      </p>
    </div>
  )
}
