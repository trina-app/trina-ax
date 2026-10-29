import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { IDBFactory } from 'fake-indexeddb'
import { Locale, NotificationEventType, PushEventType } from '@mycel/shared/api'
import { pushMessages } from '../../../server/src/notifications/text'

const source = readFileSync(new URL('../../pwa/sw.js', import.meta.url), 'utf8')
const payload = { notificationId: 'event-1', subscriptionId: 'subscription-1', code: 'schedule.success' }
function worker(database = new IDBFactory()) {
  const listeners = new Map<string, (event: any) => void>()
  const shown: { title: string; options: any; closed: boolean; close(): void }[] = []
  const requests: { path: string; options: RequestInit }[] = [], navigated: string[] = []
  let settings = { configured: true, enabled: true, subscriptionId: 'subscription-1', messages: pushMessages('en') }
  let preferences = { scheduleSuccess: true, scheduleFailure: true, connectionReconnect: true, skillSuggestions: true }
  let item: any = { id: 'event-1', code: 'schedule.success', readAt: null }
  let status = 200, gate: Promise<void> | null = null
  const self = {
    location: { origin: 'https://team.example' },
    addEventListener: (name: string, fn: (event: any) => void) => listeners.set(name, fn),
    registration: {
      showNotification: async (title: string, options: any) => { shown.push({ title, options, closed: false, close() { this.closed = true } }) },
      getNotifications: async (options?: { tag: string }) => shown.filter(item => !item.closed && (!options || options.tag === item.options.tag)),
    },
    clients: {
      matchAll: async () => [{ url: 'https://team.example/', navigate: async (url: string) => { navigated.push(url) }, focus: async () => {} }],
      openWindow: async (url: string) => { navigated.push(url) },
    },
  }
  vm.runInNewContext(source, { self, indexedDB: database, URL, AbortController, setTimeout, clearTimeout,
    fetch: async (path: string, options: RequestInit) => {
      requests.push({ path, options })
      if (gate) await gate
      if (!['/api/push', '/api/notification-preferences', '/api/notifications/event-1'].includes(path)) throw new Error('unexpected network target')
      return { ok: status === 200, json: async () => path === '/api/push' ? { ...settings } : path === '/api/notification-preferences' ? { ...preferences } : { ...item } }
    },
  })
  const event = async (type: string, data: any) => {
    let promise: Promise<unknown> | undefined
    listeners.get(type)!({ ...data, waitUntil: (work: Promise<unknown>) => { promise = work } })
    await promise
  }
  return {
    shown, requests, navigated,
    push: (data: unknown = payload) => event('push', { data: { json: () => data } }),
    invalidate: () => event('message', { data: { type: 'push.invalidate' }, source: { url: 'https://team.example/' } }),
    click: () => event('notificationclick', { notification: { close() {}, data: { url: 'https://attacker.invalid/secret' } } }),
    configure: (next: Partial<typeof settings>) => { settings = { ...settings, ...next } },
    preferences: (next: Partial<typeof preferences>) => { preferences = { ...preferences, ...next } },
    item: (next: any) => { item = next },
    status: (next: number) => { status = next },
    hold: (next: Promise<void>) => { gate = next },
  }
}

test('worker displays only a current-session own unread event, with generic text and persistent deduplication', async () => {
  const database = new IDBFactory(), w = worker(database)
  await w.push({ ...payload, title: 'PRIVATE PROMPT', body: 'PRIVATE FILE', url: 'https://attacker.invalid' })
  expect(w.shown).toHaveLength(1)
  expect(w.shown[0]!.options.body).toBe('A scheduled task completed.')
  expect(JSON.stringify(w.shown)).not.toMatch(/PRIVATE|attacker/)
  expect(w.requests).toHaveLength(3)
  for (const request of w.requests) expect(request.options).toMatchObject({ credentials: 'include', cache: 'no-store', redirect: 'error' })
  w.shown[0]!.close()
  const restarted = worker(database)
  await restarted.push()
  expect(restarted.shown).toHaveLength(0)
  expect(restarted.requests).toHaveLength(0)
})

test('worker rejects revoked subscriptions, disabled preferences, read events and inaccessible or foreign notifications', async () => {
  for (const deny of [
    (w: ReturnType<typeof worker>) => w.configure({ subscriptionId: 'new-session' }),
    (w: ReturnType<typeof worker>) => w.configure({ enabled: false }),
    (w: ReturnType<typeof worker>) => w.preferences({ scheduleSuccess: false }),
    (w: ReturnType<typeof worker>) => w.item({ id: 'another-user-event', code: 'schedule.success', readAt: null }),
    (w: ReturnType<typeof worker>) => w.item({ id: 'event-1', code: 'schedule.success', readAt: '2026-10-27T01:00:00Z' }),
    (w: ReturnType<typeof worker>) => w.status(401),
  ]) {
    const w = worker(); deny(w); await w.push(); expect(w.shown).toHaveLength(0)
  }
})

test.each(Locale.options)('worker displays server-selected %s title and body for every push event', async locale => {
  for (const code of PushEventType.options) {
    const w = worker(), messages = pushMessages(locale)
    w.configure({ messages })
    w.item({ id: 'event-1', code, readAt: null })
    await w.push({ ...payload, code, title: 'PRIVATE PROMPT', body: 'PRIVATE FILE', locale: 'en' })
    expect(w.shown).toHaveLength(1)
    expect(w.shown[0]!.title).toBe(messages.title)
    expect(w.shown[0]!.options.body).toBe(messages.bodies[code])
    expect(JSON.stringify(w.shown)).not.toMatch(/PRIVATE/)
  }
})

test('inbox-only events (skill suggestion notices) never show as OS push', async () => {
  for (const code of NotificationEventType.options.filter(c => !(PushEventType.options as readonly string[]).includes(c))) {
    const w = worker()
    w.configure({ messages: pushMessages('en') })
    w.item({ id: 'event-1', code, readAt: null })
    await w.push({ ...payload, code })
    expect(w.shown).toHaveLength(0)
  }
})

test('worker fails closed if authenticated localized text is missing', async () => {
  const w = worker()
  w.configure({ messages: undefined as any })
  await w.push()
  expect(w.shown).toHaveLength(0)
})

test('logout while a delivery awaits authorization suppresses it and closes prior notifications', async () => {
  const w = worker()
  let release!: () => void
  w.hold(new Promise(resolve => { release = resolve }))
  const pending = w.push()
  for (let i = 0; i < 50 && w.requests.length < 3; i++) await new Promise(resolve => setTimeout(resolve, 0))
  expect(w.requests).toHaveLength(3)
  await w.invalidate(); release(); await pending
  expect(w.shown).toHaveLength(0)
  const already = worker(); await already.push(); await already.invalidate()
  expect(already.shown[0]!.closed).toBe(true)
})

test('malformed IDs cannot become fetch paths and a click always opens the fixed inbox', async () => {
  const w = worker()
  for (const value of [{ ...payload, notificationId: '../secret' }, { ...payload, subscriptionId: 'https://evil.invalid' }, { ...payload, code: 'constructor' }, null]) await w.push(value)
  expect(w.requests).toHaveLength(0)
  expect(w.shown).toHaveLength(0)
  await w.click()
  expect(w.navigated).toEqual(['https://team.example/settings/notifications'])
})
