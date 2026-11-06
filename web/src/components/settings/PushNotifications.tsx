import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { z } from 'zod'
import type { PushSettings } from '@mycel/shared/api'
import { api, API } from '../../lib/api'
import { disablePush, enablePush, pushRegistration, pushSupported } from '../../lib/push'
import { askLater, mobilePushApp, phonePushView, refreshPhonePush, registerMobilePush, usePhonePush } from '../../lib/mobile-push'
import { canOpenAppSettings, openAppSettings } from '../../lib/mobile'
import { pushNeedsInstall } from '../../lib/pwa'
import { useRealPath } from '../../lib/realPath'
import { useT } from '../../i18n'
import { isAdmin, useMe } from '../../store/session'
import { notificationsChanged } from '../../store/live'
import { hidesTabs } from '../../lib/tabs'
import { Button, ErrorNote } from '../ui'

export function PushNotifications() {
  const t = useT()
  const [settings, setSettings] = useState<z.infer<typeof PushSettings> | null>(null)
  const [registration, setRegistration] = useState<ServiceWorkerRegistration | null>(null)
  const [busy, setBusy] = useState(false), [failed, setFailed] = useState(false)
  const [denied, setDenied] = useState(false)
  const [deviceReady, setDeviceReady] = useState(false)
  const life = useRef(0), revision = useRef(0)
  const supported = pushSupported(), needsInstall = pushNeedsInstall()
  // Inside the phone app: native push through the team's push gateway instead of Web Push.
  const app = mobilePushApp(), me = useMe()
  const phone = usePhonePush()
  const load = async () => {
    const generation = life.current, rev = ++revision.current
    try {
      const next = await api.call(API.getPushSettings)
      if (generation !== life.current || rev !== revision.current) return
      setSettings(next)
      if (next.configured && supported && !needsInstall) {
        const worker = await pushRegistration()
        const subscription = await worker.pushManager.getSubscription()
        if (generation === life.current && rev === revision.current) { setRegistration(worker); setDeviceReady(!!subscription && Notification.permission === 'granted') }
      }
    } catch { if (generation === life.current && rev === revision.current) setFailed(true) }
  }
  useEffect(() => {
    life.current++; void load()
    // the phone app: what the OS says now (it may have changed in the phone's Settings)
    if (app) void refreshPhonePush().catch(() => {})
    const off = notificationsChanged.on(() => void load())
    return () => { life.current++; off() }
    // Capability and account are fixed for this mounted settings panel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // the phone app registered or the OS answer changed (the question's button, back from the phone's Settings)
  useEffect(() => { if (app && phone.registered) void load() }, [phone.registered]) // eslint-disable-line react-hooks/exhaustive-deps
  const change = async (enabled: boolean) => {
    if (busy || !settings) return
    const generation = life.current
    setBusy(true); setFailed(false); setDenied(false)
    try {
      if (enabled && app) await registerMobilePush()
      else if (enabled) {
        if (!registration || !settings.publicKey) return
        await enablePush(registration, settings.publicKey, settings.subscriptionId)
      } else await disablePush(registration)
      if (generation === life.current) await load()
    } catch (error) {
      // the phone app: a "no" from the OS is shown as the status line below, not as an error
      if (generation === life.current && !(app && (error as Error)?.message === 'push_denied')) { setFailed(true); setDenied(!app && typeof Notification !== 'undefined' && Notification.permission === 'denied') }
    } finally { if (generation === life.current) setBusy(false) }
  }
  const view = phonePushView({ permission: phone.permission, on: !!(settings?.enabled && settings.native?.deviceId), canOpenSettings: canOpenAppSettings() })
  // One row of 이 기기 (Settings › Notifications): the name, where push stands on this device under it, the action on the
  // right; what push sends (and, for admins, the phone gateway) in a quieter line below. No frame.
  let status: ReactNode = null, action: ReactNode = null
  if (settings && app) {
    if (settings.native?.available) {
      status = <span data-testid="phone-push-status">{t(view.status)}</span>
      action = view.action === 'open-settings' ? <Button onClick={() => void openAppSettings().catch(() => {})} data-testid="phone-push-settings">{t('push.openSettings')}</Button>
        : view.action === 'disable' ? <Button busy={busy} onClick={() => void change(false)}>{t('push.disable')}</Button>
          : <Button variant="primary" busy={busy} onClick={() => void change(true)} data-testid="phone-push-enable">{t('push.turnOn')}</Button>
    } else status = t('push.notConfigured')
  } else if (settings && !settings.configured) status = t('push.notConfigured')
  else if (settings?.configured) {
    if (needsInstall) status = <>{t('push.installIos')}{' '}<Link to="/settings/apps" className="text-accent-text underline">{t('push.installGuide')}</Link></>
    else if (!supported) status = t('push.unsupported')
    else {
      const on = !!(settings.enabled && settings.subscriptionId && deviceReady)
      status = t(on ? 'push.on' : 'push.off')
      if (!on) action = <Button busy={busy} disabled={!registration} onClick={() => void change(true)}>{t('push.enable')}</Button>
    }
    if (settings.enabled) action = <>{action}<Button busy={busy} onClick={() => void change(false)}>{t('push.disable')}</Button></>
  }
  return (
    <div className="py-3.5" data-testid="push-notifications">
      <div className="flex items-start gap-4 max-sm:flex-col max-sm:gap-2.5">
        <div className="min-w-0 flex-1">
          <h4 className="text-sm font-medium text-ink">{t('push.title')}</h4>
          {status && <p className="mt-0.5 text-sm text-muted">{status}</p>}
        </div>
        {action && <div className="flex shrink-0 flex-wrap items-center gap-2">{action}</div>}
      </div>
      {/* what push sends: about the browser's push service (the phone app's status line says what matters there) */}
      {!app && settings?.configured && <p className="mt-2 text-xs text-faint max-md:text-sm">{t('push.description')}</p>}
      {settings?.native && me && isAdmin(me) && <p className="mt-2 text-xs text-faint max-md:text-sm" data-testid="phone-push-gateway">{settings.native.gateway ? t('push.phoneGateway', { host: settings.native.gateway }) : t('push.phoneOff')}</p>}
      {failed && <div className="mt-2"><ErrorNote>{t(denied ? 'push.denied' : 'push.failed')}</ErrorNote></div>}
    </div>
  )
}

/** Signed in inside the phone app, when the OS has not been asked yet: the app's own question, above the tab bar (not
 * inside a room or an AI chat, whose message box needs the bottom). Only [알림 켜기] shows the OS prompt; [나중에]
 * puts it away (lib/mobile-push.ts askLater: a week, then for good after the second time). */
export function PhonePushAsk() {
  const t = useT()
  const ask = usePhonePush((s) => s.ask)
  const path = useRealPath()
  const [busy, setBusy] = useState(false), [failed, setFailed] = useState(false)
  if (!ask || hidesTabs(path)) return null
  const turnOn = async () => {
    setBusy(true); setFailed(false)
    try { await registerMobilePush() }
    catch (error) {
      // a "no" in the OS prompt closes the question (Settings says so), and so does a build without push; a cancelled
      // one (logout) says nothing
      const code = (error as Error)?.message
      if (code !== 'push_denied' && code !== 'push_unavailable' && !(error instanceof DOMException && error.name === 'AbortError')) setFailed(true)
    } finally { setBusy(false) }
  }
  return <div role="region" aria-label={t('push.title')} className="mx-3 mb-2 shrink-0 rounded-xl border border-line bg-surface p-3 shadow-sm" data-testid="phone-push-ask">
    <p className="text-sm font-medium">{t('push.ask')}</p>
    {failed && <p className="mt-1 text-sm text-danger" role="alert">{t('push.failed')}</p>}
    <div className="mt-2.5 flex justify-end gap-2">
      <Button variant="ghost" onClick={() => askLater()} data-testid="phone-push-later">{t('push.later')}</Button>
      <Button variant="primary" busy={busy} onClick={() => void turnOn()} data-testid="phone-push-on">{t('push.turnOn')}</Button>
    </div>
  </div>
}

/** The 나 tab's list, under 알림: when the phone's Settings turned this app's notifications off, says so with the way
 * back there (only an app with push-permission-v1 can open it; an older one gets the words only). */
export function PhonePushLine() {
  const t = useT()
  const denied = usePhonePush((s) => s.permission === 'denied')
  if (!denied || !mobilePushApp()) return null
  return <div className="flex items-center gap-2 px-3 pb-1 text-sm md:hidden" data-testid="phone-push-line">
    <span className="min-w-0 flex-1 text-muted">{t('push.phoneOffShort')}</span>
    {canOpenAppSettings() && <Button size="sm" onClick={() => void openAppSettings().catch(() => {})}>{t('push.openSettings')}</Button>}
  </div>
}
