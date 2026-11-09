// Who and where in a room push on the iPhone (docs/DECISIONS.md "아이폰 알림의 이름"). The app's notification service
// extension (plugins/notification-service/) asks the current team for a room push's title. What it needs is one keychain
// item, in a keychain group only the app and the extension share: the team's origin, this phone's device id there and a
// label key. The app makes the key (it never leaves the phone: the page registers only its sha256), adds the device id
// once the team registered the phone, and deletes the item when the team changes, the person signs out, at a reinstall
// and at a launch that finds it belongs to another team or device. One operation at a time (a sign-out's delete never
// lands after the next sign-in's key). Pure (storage and crypto are passed in), so tests can drive it.
import { parseTeamAddress } from './address'
import type { Slot } from './device'
export { labelSetup } from './product'

/** The keychain item the extension reads: service `<LABEL_SERVICE>:no-auth` and account `LABEL_ITEM` (expo-secure-store's
 * naming, ios/SecureStoreModule.swift; plugins/notification-service.js checks it at prebuild), in the shared group. */
export const LABEL_SERVICE = 'team-ax.push-label'
export const LABEL_ITEM = 'label'

export interface LabelItem { v: 1; origin: string; key: string; deviceId?: string }
export interface LabelDeps { slot: Slot; random(): Promise<Uint8Array>; sha256Hex(text: string): Promise<string> }

const KEY = /^[A-Za-z0-9_-]{43}$/, DEVICE = /^[A-Za-z0-9_-]{1,100}$/
const teamOrigin = (origin: string) => { const a = parseTeamAddress(origin); return !!a && a.origin === origin && a.entryPath === '/' }

/** base64url without padding: 32 bytes are 43 characters, the team server's key format. */
export function base64url(bytes: Uint8Array): string {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += abc[(n >> 18) & 63]! + abc[(n >> 12) & 63]! + (i + 1 < bytes.length ? abc[(n >> 6) & 63]! : '') + (i + 2 < bytes.length ? abc[n & 63]! : '')
  }
  return out
}

/** The stored item, or null when there is none or it is not what this app writes. */
export function parseLabelItem(raw: string | null): LabelItem | null {
  if (!raw || raw.length > 2048) return null
  try {
    const o = JSON.parse(raw) as Record<string, unknown>
    if (o?.v !== 1 || typeof o.origin !== 'string' || !teamOrigin(o.origin) || typeof o.key !== 'string' || !KEY.test(o.key)) return null
    if (o.deviceId !== undefined && (typeof o.deviceId !== 'string' || !DEVICE.test(o.deviceId))) return null
    return { v: 1, origin: o.origin, key: o.key, ...(typeof o.deviceId === 'string' ? { deviceId: o.deviceId } : {}) }
  } catch { return null }
}

export class LabelStore {
  private queue: Promise<unknown> = Promise.resolve()
  constructor(private d: LabelDeps) {}
  private run<T>(op: () => Promise<T>): Promise<T> {
    const next = this.queue.then(op, op)
    this.queue = next.catch(() => {})
    return next
  }
  private async read(): Promise<LabelItem | null> { return parseLabelItem(await this.d.slot.get().catch(() => null)) }
  private write(item: LabelItem | null) { return this.d.slot.set(item ? JSON.stringify(item) : null) }

  /** At a token request for this team: the hash of this team's label key, made now if there is none (the same key
   * again otherwise, so registering again changes nothing). null when it cannot be kept (then no names). */
  keyHash(origin: string): Promise<string | null> {
    return this.run(async () => {
      if (!teamOrigin(origin)) return null
      let item = await this.read()
      if (!item || item.origin !== origin) {
        const key = base64url(await this.d.random())
        if (!KEY.test(key)) return null
        item = { v: 1, origin, key }
        await this.write(item)
        // only a key that is really in the keychain may be registered
        if ((await this.read())?.key !== key) return null
      }
      const hash = await this.d.sha256Hex(item.key)
      return /^[0-9a-f]{64}$/.test(hash) ? hash : null
    })
  }
  /** The team registered this phone: the extension may now ask it for this device's pushes. */
  registered(origin: string, deviceId: string): Promise<void> {
    return this.run(async () => {
      const item = await this.read()
      if (!item || item.origin !== origin || !DEVICE.test(deviceId) || item.deviceId === deviceId) return
      await this.write({ ...item, deviceId })
    })
  }
  /** Team change, sign-out, reinstall: the extension names nobody until the next registration makes a new key. */
  forget(): Promise<void> { return this.run(() => this.write(null)) }
  /** At launch: an item of another team or another device than the app has now is deleted. */
  tidy(origin: string | null, deviceId: string | null): Promise<void> {
    return this.run(async () => {
      const raw = await this.d.slot.get().catch(() => null)
      if (raw === null) return
      const item = parseLabelItem(raw)
      if (!item || !origin || item.origin !== origin || (item.deviceId !== undefined && item.deviceId !== deviceId)) await this.write(null)
    })
  }
}
