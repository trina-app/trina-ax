// Settings › Security & devices › Google account: Sign in with Google (server/src/auth/google-login.ts;
// docs/AGENTS/plan/20261122-0454-google-login.md). Connect asks for the current password (ReauthDialog), then Google's
// page opens in this window and comes back here with ?google=<result>. Connect shows only where it can work: this
// server has a Google client and Google returns to this address (GET /api/me/google `available`), in a browser (Google
// refuses to sign in inside the apps' own windows). A connected account always shows, with Disconnect.
import { LogIn } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import type { MyGoogle } from '@mycel/shared/api'
import { api, API, errorText } from '../../lib/api'
import { clientKind } from '../../lib/desktop'
import { formatDateTime } from '../../lib/format'
import { useLocale, useT, type MessageKey } from '../../i18n'
import { toast } from '../../store/ui'
import { passwordRefusal, ReauthDialog } from '../../pages/admin/common'
import { Button, confirmDialog } from '../ui'
import { PhoneListGroup, PhoneListRow } from '../phone/PhoneList'
import { SettingRow } from './SettingRow'

/** how a connect that came back here ended (?google=<result>) */
const RESULT: Record<string, MessageKey> = {
  connected: 'settings.google.result.connected', in_use: 'settings.google.result.in_use', cancelled: 'settings.google.result.cancelled',
  expired: 'settings.google.result.expired', failed: 'settings.google.result.failed',
}

/** `frame`: the computer layout's section around the row (Settings.tsx Section), left out when nothing shows */
export function GoogleAccount({ phone, frame }: { phone: boolean; frame?: (children: ReactNode) => ReactNode }) {
  const t = useT()
  const locale = useLocale()
  const location = useLocation()
  const navigate = useNavigate()
  const [value, setValue] = useState<MyGoogle | null>(null)
  const [asking, setAsking] = useState(false)
  const load = async () => {
    try { setValue(await api.call(API.myGoogle)) } catch { setValue(null) }
  }
  useEffect(() => { void load() }, [])
  // back from Google: say once how it went, and take ?google= off the address so a reload does not say it again
  useEffect(() => {
    const p = new URLSearchParams(location.search)
    const r = p.get('google')
    if (!r) return
    const key = RESULT[r]
    if (key) toast({ level: r === 'connected' ? 'success' : 'error', text: t(key) })
    p.delete('google')
    navigate({ pathname: location.pathname, search: p.size ? `?${p}` : '' }, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search])
  const canConnect = !!value?.available && clientKind() === 'web'
  if (!value || (!value.account && !canConnect)) return null
  const account = value.account
  const connect = async (password: string): Promise<string | null> => {
    try {
      const r = await api.call(API.connectGoogle, { body: { password } })
      window.location.assign(r.url)
      return null
    } catch (e) {
      // a wrong password stays in the dialog; anything else is a toast
      const refused = passwordRefusal(e, locale)
      if (refused) return refused
      setAsking(false)
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
      return null
    }
  }
  const disconnect = async () => {
    if (!(await confirmDialog({ title: t('settings.google.disconnectTitle'), body: t('settings.google.disconnectBody'), confirm: t('settings.google.disconnect'), danger: true }))) return
    try {
      await api.call(API.disconnectGoogle)
      toast({ level: 'success', text: t('settings.google.disconnected') })
      void load()
    } catch (e) {
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
    }
  }
  const used = account && (account.lastUsedAt ? t('settings.google.lastUsed', { date: formatDateTime(account.lastUsedAt, locale) }) : t('settings.google.neverUsed'))
  const dialog = asking && (
    <ReauthDialog title={t('settings.google.connectTitle')} body={t('settings.google.connectBody')} confirm={t('settings.google.connect')} onClose={() => setAsking(false)} onConfirm={connect} />
  )
  if (phone) {
    return (
      <>
        <PhoneListGroup title={t('settings.google.title')} footer={t('settings.google.desc')} testId="security-google">
          <PhoneListRow
            icon={<LogIn size={16} />}
            title={account ? <span className="block min-w-0"><span className="block truncate" data-testid="google-email">{account.email ?? t('settings.google.title')}</span><span className="block truncate text-xs text-faint">{used}</span></span> : t('settings.google.none')}
            onClick={account ? () => void disconnect() : () => setAsking(true)}
            end={<span className="shrink-0 text-sm text-accent-text" data-testid={account ? 'google-disconnect' : 'google-connect'}>{account ? t('settings.google.disconnect') : t('settings.google.connect')}</span>}
          />
        </PhoneListGroup>
        {dialog}
      </>
    )
  }
  const row = (
    <SettingRow
      divided
      inline
      testId="security-google"
      title={account ? <span data-testid="google-email">{account.email ?? t('settings.google.title')}</span> : t('settings.google.none')}
      desc={used ?? undefined}
      control={account
        ? <Button size="sm" variant="ghost" onClick={() => void disconnect()} data-testid="google-disconnect">{t('settings.google.disconnect')}</Button>
        : <Button size="sm" onClick={() => setAsking(true)} data-testid="google-connect">{t('settings.google.connect')}</Button>}
    />
  )
  return (
    <>
      {frame ? frame(row) : row}
      {dialog}
    </>
  )
}
