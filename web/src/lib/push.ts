import { ERROR_MESSAGES, PUSH_KEY_REASON } from '@mycel/shared/api'
import { api, API, ApiError, isNetworkError } from './api'
import { isDesktop } from './desktop'
import { mobileApp } from './mobile'

let session: string | null = null, epoch = 0, changing = false

/** Whether this page can get Web Push: 'app' inside the phone app (native push through the gateway) and the desktop app
 * (Electron has the browser's push objects but no push service, so a subscription always fails: it notifies through the
 * computer itself, components/settings/DesktopNotifications.tsx); 'insecure' on an address without https (an office
 * address over plain http); 'browser' when this browser has no service worker, push or notifications (Firefox private
 * windows have no service worker). */
export type PushSupport = 'ok' | 'app' | 'insecure' | 'browser'
export function pushSupport(): PushSupport {
  if (typeof window === 'undefined') return 'browser'
  if (mobileApp() || isDesktop()) return 'app'
  if (!window.isSecureContext) return 'insecure'
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window ? 'ok' : 'browser'
}
export const pushSupported = (): boolean => pushSupport() === 'ok'

/** Notification.permission, or null where there is none. */
export const notificationPermission = (): NotificationPermission | null => (typeof Notification === 'undefined' ? null : Notification.permission)

/** A step of turning push on that failed, with what it threw (`cause`): the service worker, the browser's subscription or
 * the team server's save. pushFailure reads it to say why. */
export class PushError extends Error {
  constructor(readonly step: 'worker' | 'subscribe' | 'server', cause: unknown) {
    super(`push ${step} failed`, { cause })
    this.name = 'PushError'
  }
}

/** Retire pending subscriptions and worker deliveries as soon as the account changes. */
export function setPushSession(next: string | null) {
  if (next === session) return
  const previous = session, generation = ++epoch
  session = next
  if (!previous || !pushSupported()) return
  navigator.serviceWorker.controller?.postMessage({ type: 'push.invalidate' })
  void navigator.serviceWorker.getRegistration('/').then(async registration => {
    registration?.active?.postMessage({ type: 'push.invalidate' })
    const subscription = await registration?.pushManager.getSubscription()
    if (generation === epoch) await subscription?.unsubscribe()
  }).catch(() => {})
}

/** How long the service worker may take to start (then PushError 'worker'). */
export const WORKER_WAIT_MS = 10000

export async function pushRegistration(): Promise<ServiceWorkerRegistration> {
  if (!pushSupported()) throw new Error('push unsupported')
  try { await navigator.serviceWorker.register('/sw.js', { scope: '/' }) } catch (error) { throw new PushError('worker', error) }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([navigator.serviceWorker.ready, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new PushError('worker', new Error('push worker unavailable'))), WORKER_WAIT_MS) })])
  } finally { clearTimeout(timer) }
}

export function vapidBytes(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]{87}$/.test(value)) throw new Error('invalid push key')
  const bytes = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='), c => c.charCodeAt(0))
  if (bytes.length !== 65 || bytes[0] !== 4) throw new Error('invalid push key')
  return bytes
}

/** Called from the explicit click: requestPermission runs before any await. */
export async function enablePush(registration: ServiceWorkerRegistration, publicKey: string, existingId: string | null): Promise<void> {
  if (!session) throw new Error('push session unavailable')
  // another turn-on or turn-off is still running (the web ask's browser question may be open)
  if (changing) throw new Error('push busy')
  const generation = epoch, key = vapidBytes(publicKey)
  const permission = Notification.permission === 'default' ? Notification.requestPermission() : Promise.resolve(Notification.permission)
  changing = true
  let created: PushSubscription | null = null
  const check = () => { if (generation !== epoch || !session) throw new Error('push session changed') }
  try {
    if (await permission !== 'granted') throw new Error('push permission denied')
    check()
    let subscription = await registration.pushManager.getSubscription()
    check()
    // A browser endpoint from another session must not move silently to this account.
    const priorKey = subscription?.options?.applicationServerKey
    const sameKey = priorKey && new Uint8Array(priorKey).length === key.length && new Uint8Array(priorKey).every((byte, i) => byte === key[i])
    if (subscription && (!existingId || !sameKey)) { await subscription.unsubscribe(); check(); subscription = null }
    if (!subscription) {
      try { subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }) } catch (error) { throw new PushError('subscribe', error) }
      created = subscription
    }
    check()
    const value = subscription.toJSON()
    if (!value.endpoint || !value.keys?.auth || !value.keys?.p256dh) throw new Error('invalid browser subscription')
    try { await api.call(API.subscribePush, { body: { consent: true, endpoint: value.endpoint, keys: { p256dh: value.keys.p256dh, auth: value.keys.auth } } }) } catch (error) { throw new PushError('server', error) }
    check()
  } catch (error) {
    // Only the new subscription created by this operation is ours to roll back.
    await created?.unsubscribe().catch(() => {})
    throw error
  } finally { changing = false }
}

export async function disablePush(registration: ServiceWorkerRegistration | null): Promise<void> {
  const generation = epoch
  if (!session) throw new Error('push session unavailable')
  if (changing) throw new Error('push busy')
  changing = true
  try {
    try { await api.call(API.updatePushSettings, { body: { enabled: false } }) } catch (error) { throw new PushError('server', error) }
    if (generation !== epoch) return
    registration?.active?.postMessage({ type: 'push.invalidate' })
    const subscription = await registration?.pushManager.getSubscription()
    if (generation === epoch) await subscription?.unsubscribe()
  } finally { changing = false }
}

/**
 * Why push could not be turned on (or off) here, from what pushRegistration, enablePush, disablePush or the settings
 * read threw (Settings › Notifications and the web ask say it: pushFailureText):
 * - unsupported / insecure: this browser has no push, or the address is not https;
 * - service: the browser's push service is off or out of reach (pushManager.subscribe's AbortError "push service not
 *   available / error": Brave without "Use Google services for push messaging", a private window);
 * - browserService: the team server does not take this browser's push service (it delivers only through Google's,
 *   Mozilla's and Apple's);
 * - worker: the service worker did not start (in WORKER_WAIT_MS); storage: the browser refused to register it because
 *   this site may not keep data (Firefox's SecurityError: site data blocked, or "never remember history");
 * - key: the team server has no usable Web Push key (an admin's matter);
 * - denied: notifications are blocked for this site; dismissed: the browser's question was closed without an answer;
 * - tooMany: the server keeps push for at most 10 devices of a person;
 * - server: the team server refused with an error it explains itself (`error`); network: it could not be reached;
 * - busy: another turn-on or turn-off is still running (a browser question from the web ask is open);
 * - cancelled: the account changed meanwhile (nothing to say); unknown: anything else (logged to the console).
 */
export type PushFailureKind = 'unsupported' | 'insecure' | 'service' | 'browserService' | 'worker' | 'storage' | 'key' | 'denied' | 'dismissed' | 'tooMany' | 'server' | 'network' | 'busy' | 'cancelled' | 'unknown'
export interface PushFailure { kind: PushFailureKind; error?: ApiError }

export function pushFailure(error: unknown, permission: NotificationPermission | null = notificationPermission()): PushFailure {
  const step = error instanceof PushError ? error.step : null
  const cause = error instanceof PushError ? error.cause : error
  if (step === 'server' || cause instanceof ApiError) return serverFailure(cause)
  if (step === 'worker') return { kind: (cause as { name?: unknown } | null)?.name === 'SecurityError' ? 'storage' : 'worker' }
  if (step === 'subscribe') {
    const name = (cause as { name?: unknown } | null)?.name
    // Chrome in a private window and Safari answer NotAllowedError; only a blocked site is the person's own "no"
    if (name === 'NotAllowedError') return { kind: permission === 'denied' ? 'denied' : 'service' }
    if (name === 'AbortError') return { kind: 'service' }
    if (name === 'NotSupportedError') return { kind: 'unsupported' }
    // the browser refused the server's key
    if (name === 'InvalidAccessError') return { kind: 'key' }
    return { kind: 'unknown' }
  }
  switch (cause instanceof Error ? cause.message : '') {
    case 'push unsupported': return { kind: pushSupport() === 'insecure' ? 'insecure' : 'unsupported' }
    case 'push permission denied': return { kind: permission === 'denied' ? 'denied' : 'dismissed' }
    case 'invalid push key': return { kind: 'key' }
    case 'push busy': return { kind: 'busy' }
    case 'push session unavailable': case 'push session changed': return { kind: 'cancelled' }
  }
  return { kind: 'unknown' }
}

function serverFailure(cause: unknown): PushFailure {
  if (!(cause instanceof ApiError)) return { kind: isNetworkError(cause) ? 'network' : 'unknown' }
  // the team server itself says it has no usable Web Push key; every other `unavailable` is passing: the relay (the team
  // server offline, in maintenance, busy, timed out, its connection lost) or a proxy without the server's JSON
  if (cause.code === 'unavailable') return { kind: cause.body.params?.reason === PUSH_KEY_REASON ? 'key' : 'network' }
  if (cause.body.params?.httpStatus !== undefined && cause.status >= 502 && cause.status <= 504) return { kind: 'network' }
  if (cause.code === 'plan_limit') return { kind: 'tooMany' }
  // the browser's push address is not one the server delivers to (server/src/notifications/push-transport.ts HOSTS)
  if (cause.code === 'validation') return { kind: 'browserService' }
  return cause.code in ERROR_MESSAGES ? { kind: 'server', error: cause } : { kind: 'unknown', error: cause }
}

/** A server error worth trying again (too many requests, a server fault), or no answer at all. */
export const pushRetryHelps = (f: PushFailure) => f.kind === 'network' || (f.kind === 'server' && !!f.error && (f.error.status === 429 || f.error.status >= 500))

/** An unexpected failure goes to the browser console, to find out what happened: the error's name and message only
 * (addresses cut out). The subscription's endpoint and keys never reach a log. */
export function logPushFailure(error: unknown, failure: PushFailure = pushFailure(error)): void {
  if (failure.kind !== 'unknown' && failure.kind !== 'service' && failure.kind !== 'worker') return
  const step = error instanceof PushError ? error.step : 'push'
  const cause = error instanceof PushError ? error.cause : error
  const name = (cause as { name?: unknown } | null)?.name, message = (cause as { message?: unknown } | null)?.message
  const clean = (v: unknown) => String(v ?? '').replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<address>').slice(0, 200)
  console.warn(`[push] ${step}: ${failure.kind}`, clean(name), clean(message))
}

/** Microsoft Edge: its push service (Windows Notification Service) is not one the team server delivers through
 * (server/src/notifications/push-transport.ts HOSTS), so the web ask leaves it out until that is decided; Settings says
 * so when someone tries (browserService). */
export function isEdge(): boolean {
  if (typeof navigator === 'undefined') return false
  const brands = (navigator as { userAgentData?: { brands?: { brand?: unknown }[] } }).userAgentData?.brands
  return /\bEdg\//.test(navigator.userAgent ?? '') || (Array.isArray(brands) && brands.some((b) => b?.brand === 'Microsoft Edge'))
}

/** Brave (it hides push behind a setting of its own: "Use Google services for push messaging"). */
export const isBrave = (): boolean => typeof navigator !== 'undefined' && typeof (navigator as { brave?: { isBrave?: unknown } }).brave?.isBrave === 'function'
