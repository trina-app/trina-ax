import { api, API } from './api'
import { mobileApp } from './mobile'

let session: string | null = null, epoch = 0, changing = false

export function pushSupported(): boolean {
  return typeof window !== 'undefined' && window.isSecureContext && !mobileApp() && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
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

export async function pushRegistration(): Promise<ServiceWorkerRegistration> {
  if (!pushSupported()) throw new Error('push unsupported')
  await navigator.serviceWorker.register('/sw.js', { scope: '/' })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([navigator.serviceWorker.ready, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('push worker unavailable')), 10000) })])
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
  if (!session || changing) throw new Error('push session unavailable')
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
      subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
      created = subscription
    }
    check()
    const value = subscription.toJSON()
    if (!value.endpoint || !value.keys?.auth || !value.keys?.p256dh) throw new Error('invalid browser subscription')
    await api.call(API.subscribePush, { body: { consent: true, endpoint: value.endpoint, keys: { p256dh: value.keys.p256dh, auth: value.keys.auth } } })
    check()
  } catch (error) {
    // Only the new subscription created by this operation is ours to roll back.
    await created?.unsubscribe().catch(() => {})
    throw error
  } finally { changing = false }
}

export async function disablePush(registration: ServiceWorkerRegistration | null): Promise<void> {
  const generation = epoch
  if (!session || changing) throw new Error('push session unavailable')
  changing = true
  try {
    await api.call(API.updatePushSettings, { body: { enabled: false } })
    if (generation !== epoch) return
    registration?.active?.postMessage({ type: 'push.invalidate' })
    const subscription = await registration?.pushManager.getSubscription()
    if (generation === epoch) await subscription?.unsubscribe()
  } finally { changing = false }
}
