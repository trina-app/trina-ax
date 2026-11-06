import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { IDBFactory } from 'fake-indexeddb'
import { Locale, NotificationEventType, PushEventType } from '@mycel/shared/api'
import { pushMessages } from '../../../server/src/notifications/text'

const source = readFileSync(new URL('../../pwa/sw.js', import.meta.url), 'utf8')
const payload = { notificationId: 'event-1', subscriptionId: 'subscription-1', code: 'schedule.success' }
/** an open page of the app: answers the worker's room-sound question (lib/roomSound.ts), or never (an older page) */
type Page = { handled?: boolean | 'never'; url?: string }
function worker(database = new IDBFactory(), pages: Page[] = [{}]) {
  const listeners = new Map<string, (event: any) => void>()
  const shown: { title: string; options: any; closed: boolean; close(): void }[] = []
  const requests: { path: string; options: RequestInit }[] = [], navigated: string[] = [], asked: unknown[] = [], closed = { n: 0 }
  let settings = { configured: true, enabled: true, subscriptionId: 'subscription-1', messages: pushMessages('en') }
  let preferences = { scheduleSuccess: true, scheduleFailure: true, connectionReconnect: true, skillSuggestions: true, roomMessages: true }
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
      matchAll: async () => pages.map((page) => ({
        url: page.url ?? 'https://team.example/', navigate: async (url: string) => { navigated.push(url) }, focus: async () => {},
        ...(page.handled === undefined ? {} : { postMessage: (data: any, [port]: MessagePort[]) => { asked.push(data); if (page.handled !== 'never') port!.postMessage({ type: 'room-sound.answer', handled: page.handled }) } }),
      })),
      openWindow: async (url: string) => { navigated.push(url) },
    },
  }
  // MessageChannel that counts the worker's own ports it closes
  class CountedChannel extends MessageChannel {
    constructor() {
      super()
      const close = this.port1.close.bind(this.port1)
      this.port1.close = () => { closed.n++; close() }
    }
  }
  vm.runInNewContext(source, { self, indexedDB: database, URL, AbortController, setTimeout, clearTimeout, MessageChannel: CountedChannel,
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
    shown, requests, navigated, asked, closed,
    push: (data: unknown = payload) => event('push', { data: { json: () => data } }),
    invalidate: () => event('message', { data: { type: 'push.invalidate' }, source: { url: 'https://team.example/' } }),
    click: () => event('notificationclick', { notification: { close() {}, data: { url: 'https://attacker.invalid/secret' } } }),
    /** a click on a notification this worker showed (with the data it stored then) */
    clickShown: (i = 0) => event('notificationclick', { notification: { close() {}, data: shown[i]!.options.data } }),
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

test('a room notice opens its room; the room id comes from the signed-in notice, never from the payload', async () => {
  const roomId = '0190f5a0-0000-7000-8000-000000000001'
  const messages = { title: 'Team', bodies: { 'room.dm': 'New direct message', 'room.mention': 'You were mentioned' } }
  const w = worker()
  w.configure({ messages: messages as any })
  w.item({ id: 'event-1', code: 'room.dm', readAt: null, link: 'room', room: { id: roomId, from: 'Ben' } })
  await w.push({ ...payload, code: 'room.dm', roomId: 'evil', url: 'https://attacker.invalid' })
  expect(w.shown).toHaveLength(1)
  expect(w.shown[0]!.options).toMatchObject({ body: 'New direct message', data: { notificationId: 'event-1', roomId } })
  // the sender's name and the text stay out of the OS notice
  expect(JSON.stringify(w.shown)).not.toMatch(/Ben|evil|attacker/)
  await w.clickShown()
  expect(w.navigated).toEqual([`https://team.example/rooms/${roomId}`])

  // a room id that is not an opaque id is never a path: the inbox opens instead
  const odd = worker()
  odd.configure({ messages: messages as any })
  odd.item({ id: 'event-1', code: 'room.mention', readAt: null, link: 'room', room: { id: '../../admin', from: null } })
  await odd.push({ ...payload, code: 'room.mention' })
  expect(odd.shown[0]!.options.data).toEqual({ notificationId: 'event-1' })
  await odd.clickShown()
  expect(odd.navigated).toEqual(['https://team.example/settings/notifications'])

  // a reply in a thread opens that thread, its id from the notice too; a thread id that is no opaque id opens the room
  const rootId = '0190f5a0-0000-7000-8000-000000000002'
  const reply = worker()
  reply.configure({ messages: messages as any })
  reply.item({ id: 'event-1', code: 'room.dm', readAt: null, link: 'room', room: { id: roomId, from: 'Ben', thread: rootId } })
  await reply.push({ ...payload, code: 'room.dm', threadId: 'evil' })
  expect(reply.shown[0]!.options.data).toEqual({ notificationId: 'event-1', roomId, threadId: rootId })
  await reply.clickShown()
  expect(reply.navigated).toEqual([`https://team.example/rooms/${roomId}/t/${rootId}`])
  const badThread = worker()
  badThread.configure({ messages: messages as any })
  badThread.item({ id: 'event-1', code: 'room.dm', readAt: null, link: 'room', room: { id: roomId, from: 'Ben', thread: '../x' } })
  await badThread.push({ ...payload, code: 'room.dm' })
  await badThread.clickShown()
  expect(badThread.navigated).toEqual([`https://team.example/rooms/${roomId}`])

  // the default 받지 않음 (the older switch roomMessages false): a room at its own level still alerts, and the server sent
  // this push only because that level asks for it (docs/DECISIONS.md "대화방 알림 설정"): it shows
  const own = worker()
  own.configure({ messages: messages as any })
  own.preferences({ roomMessages: false })
  own.item({ id: 'event-1', code: 'room.dm', readAt: null, link: 'room', room: { id: roomId, from: 'Ben' } })
  await own.push({ ...payload, code: 'room.dm' })
  expect(own.shown).toHaveLength(1)
  // read meanwhile: nothing shows
  const read = worker()
  read.configure({ messages: messages as any })
  read.item({ id: 'event-1', code: 'room.dm', readAt: '2026-11-06T00:00:00.000Z', link: 'room', room: { id: roomId, from: 'Ben' } })
  await read.push({ ...payload, code: 'room.dm' })
  expect(read.shown).toHaveLength(0)
})

test('a room notice is silent when an open page takes care of the sound; otherwise, and for other notices, it is not', async () => {
  const roomId = '0190f5a0-0000-7000-8000-000000000001'
  const messages = { title: 'Team', bodies: { ...pushMessages('en').bodies, 'room.dm': 'New direct message', 'room.mention': 'You were mentioned' } }
  const roomItem = { id: 'event-1', code: 'room.dm', readAt: null, link: 'room', room: { id: roomId, from: 'Ben' } }
  const shown = async (pages: Page[], code = 'room.dm') => {
    const w = worker(new IDBFactory(), pages)
    w.configure({ messages: messages as any })
    w.item(code === 'room.dm' ? roomItem : { id: 'event-1', code, readAt: null })
    await w.push({ ...payload, code })
    expect(w.shown).toHaveLength(1)
    // every port the worker opened is closed again, answered or not
    expect(w.closed.n).toBe(w.asked.length)
    return { silent: w.shown[0]!.options.silent, asked: w.asked }
  }
  // one page plays the chime (or this device turned the sound off): the system's own sound stays out
  expect(await shown([{ handled: false }, { handled: true }])).toEqual({ silent: true, asked: [{ type: 'room-sound.ask' }, { type: 'room-sound.ask' }] })
  // pages that cannot play (audio not unlocked yet, offline), no page, or a page of another site: the system's sound
  expect((await shown([{ handled: false }])).silent).toBe(false)
  expect((await shown([])).silent).toBe(false)
  expect((await shown([{ handled: true, url: 'https://other.example/' }])).silent).toBe(false)
  // a page from before this (no answer) or a frozen tab: shown after a short wait, with the system's sound
  expect((await shown([{}])).silent).toBe(false)
  const started = Date.now()
  expect((await shown([{ handled: 'never' }])).silent).toBe(false)
  expect(Date.now() - started).toBeGreaterThanOrEqual(350)
  expect(Date.now() - started).toBeLessThan(2000)
  // other notices never ask
  expect(await shown([{ handled: true }], 'schedule.success')).toEqual({ silent: false, asked: [] })
})
