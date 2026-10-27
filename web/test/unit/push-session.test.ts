import { afterAll, beforeAll, expect, test } from 'bun:test'
import { enablePush, setPushSession, vapidBytes } from '../../src/lib/push'

const originals = new Map(['Notification', 'fetch'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
const publicKey = Buffer.from([4, ...new Uint8Array(64).fill(2)]).toString('base64url')
let permission: () => Promise<NotificationPermission>, apiCalls = 0, browserCalls = 0, unsubscribed = 0
const registration = {
  pushManager: {
    getSubscription: async () => null,
    subscribe: async () => {
      browserCalls++
      return { toJSON: () => ({ endpoint: 'https://push.example.test/synthetic', keys: { p256dh: 'synthetic-public-key', auth: 'synthetic-auth' } }), unsubscribe: async () => { unsubscribed++; return true } }
    },
  },
} as unknown as ServiceWorkerRegistration
beforeAll(() => {
  Object.defineProperty(globalThis, 'Notification', { configurable: true, value: { permission: 'default', requestPermission: () => permission() } })
  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: async () => { apiCalls++; return Response.json({ id: 'subscription-new' }) } })
})
afterAll(() => { setPushSession(null); for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) } })

test('explicit click calls permission immediately, but logout before it resolves prevents browser and server subscription', async () => {
  setPushSession('user-a:session-a')
  let release!: (permission: NotificationPermission) => void, requested = false
  permission = () => { requested = true; return new Promise(resolve => { release = resolve }) }
  const work = enablePush(registration, publicKey, null)
  expect(requested).toBe(true)
  setPushSession('user-b:session-b'); release('granted')
  await expect(work).rejects.toThrow('session changed')
  expect(browserCalls).toBe(0); expect(apiCalls).toBe(0)
})

test('logout while native subscription resolves rolls back just that subscription and never registers it to the next account', async () => {
  setPushSession('user-a:session-c'); permission = async () => 'granted'
  let release!: (value: unknown) => void
  const local = { pushManager: { getSubscription: async () => null, subscribe: async () => new Promise(resolve => { release = resolve }) } } as unknown as ServiceWorkerRegistration
  const work = enablePush(local, publicKey, null)
  for (let i = 0; i < 20 && !release; i++) await new Promise(resolve => setTimeout(resolve, 0))
  expect(release).toBeFunction()
  setPushSession('user-b:session-d')
  release({ unsubscribe: async () => { unsubscribed++; return true }, toJSON: () => { throw new Error('retired subscription serialized') } })
  await expect(work).rejects.toThrow('session changed')
  expect(unsubscribed).toBe(1); expect(apiCalls).toBe(0)
})

test('denial never subscribes and malformed VAPID values are refused before the permission prompt', async () => {
  setPushSession('user-a:session-e'); permission = async () => 'denied'
  await expect(enablePush(registration, publicKey, null)).rejects.toThrow('permission denied')
  expect(browserCalls).toBe(0); expect(apiCalls).toBe(0)
  expect(vapidBytes(publicKey)).toHaveLength(65)
  expect(() => vapidBytes('not-a-key')).toThrow('invalid push key')
})
