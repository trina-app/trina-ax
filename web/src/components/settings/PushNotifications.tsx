import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import type { z } from 'zod'
import type { PushSettings } from '@mycel/shared/api'
import { api, API } from '../../lib/api'
import { disablePush, enablePush, pushRegistration, pushSupported } from '../../lib/push'
import { mobilePushApp, registerMobilePush } from '../../lib/mobile-push'
import { pushNeedsInstall } from '../../lib/pwa'
import { useT } from '../../i18n'
import { isAdmin, useMe } from '../../store/session'
import { notificationsChanged } from '../../store/live'
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
    const off = notificationsChanged.on(() => void load())
    return () => { life.current++; off() }
    // Capability and account are fixed for this mounted settings panel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
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
      if (generation === life.current) { setFailed(true); setDenied(app ? (error as Error)?.message === 'push_denied' : typeof Notification !== 'undefined' && Notification.permission === 'denied') }
    } finally { if (generation === life.current) setBusy(false) }
  }
  return <section className="space-y-3 rounded-xl border border-line p-4" data-testid="push-notifications">
    <h3 className="text-sm font-semibold">{t('push.title')}</h3>
    <p className="text-xs text-muted">{t('push.description')}</p>
    {settings && app && (settings.native?.available ? <>
      <p className="text-sm">{t(settings.enabled && settings.native.deviceId ? 'push.on' : 'push.off')}</p>
      {!(settings.enabled && settings.native.deviceId) && <Button busy={busy} onClick={() => void change(true)}>{t('push.enable')}</Button>}
      {settings.enabled && <Button className="ml-2" busy={busy} onClick={() => void change(false)}>{t('push.disable')}</Button>}
    </> : <p className="text-sm text-muted">{t('push.notConfigured')}</p>)}
    {settings && !app && !settings.configured && <p className="text-sm text-muted">{t('push.notConfigured')}</p>}
    {settings?.configured && !app && <>
      {needsInstall ? <p className="text-sm text-muted">{t('push.installIos')}{' '}<Link to="/settings/apps" className="text-accent-text underline">{t('push.installGuide')}</Link></p> : !supported ? <p className="text-sm text-muted">{t('push.unsupported')}</p> : <>
        <p className="text-sm">{t(settings.enabled && settings.subscriptionId && deviceReady ? 'push.on' : 'push.off')}</p>
        {(!settings.enabled || !settings.subscriptionId || !deviceReady) && <Button busy={busy} disabled={!registration} onClick={() => void change(true)}>{t('push.enable')}</Button>}
      </>}
      {settings.enabled && <Button className="ml-2" busy={busy} onClick={() => void change(false)}>{t('push.disable')}</Button>}
    </>}
    {settings?.native && me && isAdmin(me) && <p className="text-xs text-muted" data-testid="phone-push-gateway">{settings.native.gateway ? t('push.phoneGateway', { host: settings.native.gateway }) : t('push.phoneOff')}</p>}
    {failed && <ErrorNote>{t(denied ? (app ? 'push.deniedApp' : 'push.denied') : 'push.failed')}</ErrorNote>}
  </section>
}
