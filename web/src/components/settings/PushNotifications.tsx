import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { z } from 'zod'
import type { Locale, PushSettings } from '@mycel/shared/api'
import { api, API, errorText } from '../../lib/api'
import { disablePush, enablePush, isBrave, logPushFailure, notificationPermission, PushError, pushFailure, pushRegistration, pushRetryHelps, pushSupport, type PushFailure } from '../../lib/push'
import { askLater, mobilePushApp, phonePushView, refreshPhonePush, registerMobilePush, usePhonePush } from '../../lib/mobile-push'
import { canOpenAppSettings, mobileApp, openAppSettings } from '../../lib/mobile'
import { isStandalone, platform, pushNeedsInstall, type Platform } from '../../lib/pwa'
import { isDesktop } from '../../lib/desktop'
import { useRealPath } from '../../lib/realPath'
import { useLocale, useT } from '../../i18n'
import { isAdmin, useMe } from '../../store/session'
import { notificationsChanged } from '../../store/live'
import { hidesTabs } from '../../lib/tabs'
import { Button, ErrorNote } from '../ui'

/** What a browser's push failure says (Settings › Notifications and the web ask, components/WebPushAsk.tsx): the reason
 * in plain words (lib/push.ts pushFailure), never the generic "check your connection and try again" when that cannot
 * help. null: nothing to say (the account changed meanwhile). A missing or broken server key is an admin's matter: a
 * member is only told to let an admin know. */
export function pushFailureText(f: PushFailure, t: ReturnType<typeof useT>, locale: Locale, o: { admin: boolean; brave?: boolean }): string | null {
  switch (f.kind) {
    case 'cancelled': return null
    case 'unsupported': return t('push.unsupported')
    case 'insecure': return t('push.insecure')
    case 'service': return t((o.brave ?? isBrave()) ? 'push.serviceBrave' : 'push.service')
    case 'browserService': return t('push.browserService')
    case 'worker': return t('push.worker')
    case 'storage': return t('push.storage')
    case 'busy': return t('push.busy')
    case 'key': return t(o.admin ? 'push.keyAdmin' : 'push.keyMember')
    case 'denied': return t('push.denied')
    case 'dismissed': return t('push.dismissed')
    case 'tooMany': return t('push.tooMany', { off: t('push.disable') })
    case 'network': return t('error.network')
    case 'server': return f.error ? errorText(f.error, locale, t('error.network')) : t('push.failedUnknown')
    default: return t('push.failedUnknown')
  }
}

/** An installed web app (display-mode: standalone, or an iPhone's Home Screen) whose browser can put a number on its
 * icon (the Badging API; store/sessionMarkers.ts sets it): where the system lets that number show, when it does not.
 * Elsewhere (a tab, the desktop app with its own badge, the phone app, a browser without the API): null. */
export function badgeHintKey(o: { installed: boolean; badging: boolean; app: boolean; p: Platform }): 'push.badgeHint.mac' | 'push.badgeHint.windows' | 'push.badgeHint.ios' | 'push.badgeHint.other' | null {
  if (!o.installed || !o.badging || o.app) return null
  return o.p === 'mac' ? 'push.badgeHint.mac' : o.p === 'windows' ? 'push.badgeHint.windows' : o.p === 'ios' ? 'push.badgeHint.ios' : 'push.badgeHint.other'
}
const badgeHintHere = () => badgeHintKey({
  installed: isStandalone(), badging: typeof navigator !== 'undefined' && typeof (navigator as { setAppBadge?: unknown }).setAppBadge === 'function',
  app: isDesktop() || !!mobileApp(), p: platform(),
})

export function PushNotifications() {
  const t = useT(), locale = useLocale()
  const [settings, setSettings] = useState<z.infer<typeof PushSettings> | null>(null)
  const [registration, setRegistration] = useState<ServiceWorkerRegistration | null>(null)
  const [busy, setBusy] = useState(false)
  // why the last load or change did not work (the phone app keeps its one line: push.failed)
  const [failure, setFailure] = useState<PushFailure | null>(null)
  const retry = useRef<(() => void) | null>(null)
  const [deviceReady, setDeviceReady] = useState(false)
  const life = useRef(0), revision = useRef(0)
  const support = pushSupport(), supported = support === 'ok', needsInstall = pushNeedsInstall(), badgeHint = badgeHintHere()
  // Inside the phone app: native push through the team's push gateway instead of Web Push.
  const app = mobilePushApp(), me = useMe()
  const phone = usePhonePush()
  const fail = (error: unknown, again: () => void) => {
    const f = pushFailure(error)
    if (!app) logPushFailure(error, f)
    retry.current = again
    setFailure(f)
  }
  const load = async () => {
    const generation = life.current, rev = ++revision.current
    try {
      let next: z.infer<typeof PushSettings>
      try { next = await api.call(API.getPushSettings) } catch (error) { throw new PushError('server', error) }
      if (generation !== life.current || rev !== revision.current) return
      setSettings(next)
      if (next.configured && supported && !needsInstall) {
        const worker = await pushRegistration()
        const subscription = await worker.pushManager.getSubscription()
        if (generation === life.current && rev === revision.current) { setRegistration(worker); setDeviceReady(!!subscription && Notification.permission === 'granted') }
      }
    } catch (error) { if (generation === life.current && rev === revision.current) fail(error, () => { setFailure(null); void load() }) }
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
    setBusy(true); setFailure(null)
    try {
      if (enabled && app) await registerMobilePush()
      else if (enabled) {
        if (!registration || !settings.publicKey) return
        await enablePush(registration, settings.publicKey, settings.subscriptionId)
      } else await disablePush(registration)
      if (generation === life.current) await load()
    } catch (error) {
      // the phone app: a "no" from the OS is shown as the status line below, not as an error
      if (generation === life.current && !(app && (error as Error)?.message === 'push_denied')) fail(error, () => void change(enabled))
    } finally { if (generation === life.current) setBusy(false) }
  }
  const view = phonePushView({ permission: phone.permission, on: !!(settings?.enabled && settings.native?.deviceId), canOpenSettings: canOpenAppSettings() })
  // the browser blocked notifications for this site: the status line says so and how to undo it
  const blocked = !app && supported && notificationPermission() === 'denied'
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
    else if (!supported) status = t(support === 'insecure' ? 'push.insecure' : 'push.unsupported')
    else {
      const on = !!(settings.enabled && settings.subscriptionId && deviceReady)
      status = <span data-testid="push-status">{on ? t('push.on') : blocked ? t('push.denied') : t('push.off')}</span>
      if (!on) action = <Button busy={busy} disabled={!registration} onClick={() => void change(true)}>{t('push.enable')}</Button>
    }
    if (settings.enabled) action = <>{action}<Button busy={busy} onClick={() => void change(false)}>{t('push.disable')}</Button></>
  }
  // the reason in words; the status line already says a blocked site
  const failureText = !failure ? null : app ? t('push.failed') : failure.kind === 'denied' && blocked ? null : pushFailureText(failure, t, locale, { admin: isAdmin(me) })
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
      {/* an installed web app: where the system lets the count show on its icon (one quiet line) */}
      {badgeHint && <p className="mt-2 text-xs text-faint max-md:text-sm" data-testid="push-badge-hint">{t(badgeHint)}</p>}
      {settings?.native && me && isAdmin(me) && <p className="mt-2 text-xs text-faint max-md:text-sm" data-testid="phone-push-gateway">{settings.native.gateway ? t('push.phoneGateway', { host: settings.native.gateway }) : t('push.phoneOff')}</p>}
      {/* "다시 시도" only where trying again can help: the team server could not be reached or had a passing fault */}
      {failureText && <div className="mt-2" data-testid="push-failure" data-kind={failure?.kind}><ErrorNote onRetry={!app && failure && pushRetryHelps(failure) ? () => retry.current?.() : undefined}>{failureText}</ErrorNote></div>}
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
  return <div role="region" aria-label={t('push.title')} className="mx-3 mb-2 shrink-0 rounded-xl border border-line bg-surface p-3 shadow-sm in-[.keyboard-open]:hidden" data-testid="phone-push-ask">
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
  return <div className="flex items-center gap-2 px-4 pt-2 text-sm md:hidden" data-testid="phone-push-line">
    <span className="min-w-0 flex-1 text-muted">{t('push.phoneOffShort')}</span>
    {canOpenAppSettings() && <Button size="sm" onClick={() => void openAppSettings().catch(() => {})}>{t('push.openSettings')}</Button>}
  </div>
}
