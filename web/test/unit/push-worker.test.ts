import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { IDBFactory } from 'fake-indexeddb'
import { Locale, NotificationEventType, PushEventType } from '@mycel/shared/api'
import { pushMessages } from '../../../server/src/notifications/text'

const source = readFileSync(new URL('../../pwa/sw.js', import.meta.url), 'utf8')
const payload = { notificationId: 'event-1', subscriptionId: 'subscription-1', code: 'schedule.success' }
/** an open page of the app: answers the worker's room-sound question (lib/roomSound.ts), or never (an older page) */
type Page = { handled?: boolean | 'never'; url?: string }
/** the worker's navigator: the Badging API of an installed web app, or none */
type BadgeNav = { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> }
function worker(database = new IDBFactory(), pages: Page[] = [{}], nav?: BadgeNav) {
  const listeners = new Map<string, (event: any) => void>()
  const shown: { title: string; options: any; closed: boolean; close(): void }[] = []
  const requests: { path: string; options: RequestInit }[] = [], navigated: string[] = [], asked: unknown[] = [], closed = { n: 0 }
  let settings = { configured: true, enabled: true, subscriptionId: 'subscription-1', messages: pushMessages('en') }
  let preferences = { scheduleSuccess: true, scheduleFailure: true, connectionReconnect: true, skillSuggestions: true, roomMessages: true, chatAnswers: true, chatShares: true, roomThreadReplies: true, fileShares: true }
  // the signed-in notice names the task for the Inbox (schedule.title); the lock screen never shows it
  let item: any = { id: 'event-1', code: 'schedule.success', readAt: null, schedule: { title: 'PRIVATE TASK TITLE' } }
  let status = 200, gate: Promise<void> | null = null
  const self = {
    location: { origin: 'https://team.example' },
    ...(nav ? { navigator: nav } : {}),
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
    /** a press on a notification's button ("read": Mark as read) */
    action: (action: string, i = 0) => event('notificationclick', { action, notification: { close() {}, data: shown[i]!.options.data } }),
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
    // a request to open a file shows only while the signed-in notice says I may still answer it
    // (and a request to open my chat or project, the same)
    w.item({ id: 'event-1', code, readAt: null, ...(code === 'file.access_requested' ? { link: 'file', fileShare: { by: null, name: null, linkId: null, state: 'pending', canAnswer: true } } : {}), ...(code === 'access.requested' ? { link: null, accessRequest: { kind: 'chat', by: null, name: null, targetId: null, state: 'pending', canAnswer: true } } : {}), ...(code === 'chat.message' ? { link: 'chat', chatId: 'chat-1', chatMessage: { messageId: 'message-1' } } : {}) })
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

test('an AI chat\'s answer: generic words, a click opens the chat from the signed-in notice (never the payload); "AI answers" off shows nothing', async () => {
  const chatId = '0190f5a0-0000-7000-8000-0000000000c1'
  const w = worker()
  w.item({ id: 'event-1', code: 'chat.answer_done', readAt: null, link: 'chat', chatId })
  await w.push({ ...payload, code: 'chat.answer_done', chatId: 'evil' })
  expect(w.shown).toHaveLength(1)
  expect(w.shown[0]!.options).toMatchObject({ body: 'Trina replied in your chat.', data: { notificationId: 'event-1', chatId } })
  await w.clickShown()
  expect(w.navigated).toEqual([`https://team.example/c/${chatId}`])
  // a chat the person may no longer open (deleted, no link): the start page (the Inbox never lists these notices)
  const gone = worker()
  gone.item({ id: 'event-1', code: 'chat.answer_done', readAt: null, link: null, chatId: null })
  await gone.push({ ...payload, code: 'chat.answer_done' })
  expect(gone.shown[0]!.options.data).toEqual({ notificationId: 'event-1', home: true })
  await gone.clickShown()
  expect(gone.navigated).toEqual(['https://team.example/'])
  const off = worker()
  off.preferences({ chatAnswers: false })
  off.item({ id: 'event-1', code: 'chat.answer_done', readAt: null, link: 'chat', chatId })
  await off.push({ ...payload, code: 'chat.answer_done' })
  expect(off.shown).toHaveLength(0)
})

test('an app\'s paused notice: generic words (never the app\'s or the room\'s name), a click opens the room from the signed-in notice', async () => {
  const roomId = '0190f5a0-0000-7000-8000-0000000000a1'
  const w = worker()
  w.item({ id: 'event-1', code: 'room_app.paused', readAt: null, link: 'room', chatId: null, roomApp: { appId: 'app-1', name: 'PRIVATE APP', roomId, roomName: 'PRIVATE ROOM' } })
  await w.push({ ...payload, code: 'room_app.paused', roomId: 'evil' })
  expect(w.shown).toHaveLength(1)
  expect(w.shown[0]!.title).toBe(pushMessages('en').title)
  expect(w.shown[0]!.options).toMatchObject({ body: 'An app in a conversation was paused for today.', data: { notificationId: 'event-1', roomId } })
  expect(JSON.stringify(w.shown)).not.toMatch(/PRIVATE/)
  await w.clickShown()
  expect(w.navigated).toEqual([`https://team.example/rooms/${roomId}`])
  // no longer in the room (no link): the inbox, as the other notices
  const gone = worker()
  gone.item({ id: 'event-1', code: 'room_app.paused', readAt: null, link: null, chatId: null, roomApp: { appId: 'app-1', name: 'x', roomId: null } })
  await gone.push({ ...payload, code: 'room_app.paused' })
  expect(gone.shown[0]!.options.data).toEqual({ notificationId: 'event-1' })
  await gone.clickShown()
  expect(gone.navigated).toEqual(['https://team.example/settings/notifications'])
})

test('a connection that needs a sign-in again: generic words, a click opens its own page from the signed-in notice (QA TC-3053)', async () => {
  const id = '0190f5a0-0000-7000-8000-0000000000d1'
  const w = worker()
  w.item({ id: 'event-1', code: 'connection.reconnect', readAt: null, link: 'connections', chatId: null, connection: { id, name: 'PRIVATE SERVICE', googleApp: null } })
  await w.push({ ...payload, code: 'connection.reconnect', connectionId: 'evil' })
  expect(w.shown).toHaveLength(1)
  expect(w.shown[0]!.title).toBe(pushMessages('en').title)
  expect(w.shown[0]!.options).toMatchObject({ body: pushMessages('en').bodies['connection.reconnect'], data: { notificationId: 'event-1', connectionId: id } })
  expect(JSON.stringify(w.shown)).not.toMatch(/PRIVATE/)
  await w.clickShown()
  expect(w.navigated).toEqual([`https://team.example/settings/connectors/mcp/${id}`])
  // a Google app (Gmail): that app's page
  const mail = worker()
  mail.item({ id: 'event-1', code: 'connection.reconnect', readAt: null, link: 'connections', chatId: null, connection: { id, name: 'Gmail', googleApp: 'gmail' } })
  await mail.push({ ...payload, code: 'connection.reconnect' })
  await mail.clickShown()
  expect(mail.navigated).toEqual(['https://team.example/settings/connectors/gmail'])
  // Google Drive's, or a removed connection's (no connection in the notice): the Inbox, as before
  const gone = worker()
  gone.item({ id: 'event-1', code: 'connection.reconnect', readAt: null, link: 'connections', chatId: null })
  await gone.push({ ...payload, code: 'connection.reconnect' })
  expect(gone.shown[0]!.options.data).toEqual({ notificationId: 'event-1' })
  await gone.clickShown()
  expect(gone.navigated).toEqual(['https://team.example/settings/notifications'])
})

test('a chat shared with me by name: the sharer as the title from the signed-in notice, never the chat\'s title; a click opens the chat; "Chats shared with me" off shows nothing', async () => {
  const chatId = '0190f5a0-0000-7000-8000-0000000000c2'
  const w = worker()
  w.configure({ messages: pushMessages('en') })
  w.item({ id: 'event-1', code: 'chat.shared', readAt: null, link: 'chat', chatId, chatShared: { name: 'Mia\u202e Kim', title: 'PRIVATE TITLE' } })
  await w.push({ ...payload, code: 'chat.shared', chatId: 'evil', name: 'PRIVATE' })
  expect(w.shown).toHaveLength(1)
  expect(w.shown[0]!.title).toBe('Mia Kim')
  expect(w.shown[0]!.options).toMatchObject({ body: 'Shared a chat with you.', data: { notificationId: 'event-1', chatId } })
  expect(JSON.stringify(w.shown)).not.toMatch(/PRIVATE/)
  await w.clickShown()
  expect(w.navigated).toEqual([`https://team.example/c/${chatId}`])
  // a server that does not name the sharer (or a gone account): the generic words
  const unnamed = worker()
  unnamed.configure({ messages: pushMessages('en') })
  unnamed.item({ id: 'event-1', code: 'chat.shared', readAt: null, link: 'chat', chatId, chatShared: { name: null, title: null } })
  await unnamed.push({ ...payload, code: 'chat.shared' })
  expect(unnamed.shown[0]!.title).toBe(pushMessages('en').title)
  expect(unnamed.shown[0]!.options.body).toBe('Someone shared a chat with you.')
  // no longer shared with me (gone): the generic words, no name even if the server sent one
  const gone = worker()
  gone.configure({ messages: pushMessages('en') })
  gone.item({ id: 'event-1', code: 'chat.shared', readAt: null, link: null, chatId: null, chatShared: { name: 'Mia', title: null, gone: true } })
  await gone.push({ ...payload, code: 'chat.shared' })
  expect(gone.shown[0]!.title).toBe(pushMessages('en').title)
  expect(gone.shown[0]!.options.body).toBe('Someone shared a chat with you.')
  expect(JSON.stringify(gone.shown)).not.toContain('Mia')
  const off = worker()
  off.configure({ messages: pushMessages('en') })
  off.preferences({ chatShares: false })
  off.item({ id: 'event-1', code: 'chat.shared', readAt: null, link: 'chat', chatId, chatShared: { name: 'Mia', title: null } })
  await off.push({ ...payload, code: 'chat.shared' })
  expect(off.shown).toHaveLength(0)
})

test('a reply in a chat thread: the generic line, a click opens the thread from the signed-in notice; gone or the setting off shows nothing of it', async () => {
  const chatId = '0190f5a0-0000-7000-8000-0000000000d1', rootId = '0190f5a0-0000-7000-8000-0000000000d2'
  const w = worker()
  w.configure({ messages: pushMessages('en') })
  w.item({ id: 'event-1', code: 'chat.thread_reply', readAt: null, link: 'chat_thread', chatId, chatThread: { chatId, rootId, name: 'PRIVATE NAME', title: 'PRIVATE TITLE' } })
  await w.push({ ...payload, code: 'chat.thread_reply', chatId: 'evil' })
  expect(w.shown).toHaveLength(1)
  expect(w.shown[0]!.title).toBe(pushMessages('en').title)
  expect(w.shown[0]!.options).toMatchObject({ body: 'Someone replied in a thread.', data: { notificationId: 'event-1', chatId, chatThreadId: rootId } })
  expect(JSON.stringify(w.shown)).not.toMatch(/PRIVATE/)
  await w.clickShown()
  expect(w.navigated).toEqual([`https://team.example/c/${chatId}/t/${rootId}`])
  const gone = worker()
  gone.configure({ messages: pushMessages('en') })
  gone.item({ id: 'event-1', code: 'chat.thread_reply', readAt: null, link: null, chatId: null, chatThread: { chatId: null, rootId: null, name: null, title: null, gone: true } })
  await gone.push({ ...payload, code: 'chat.thread_reply' })
  expect(gone.shown[0]!.options.data).toEqual({ notificationId: 'event-1' })
  await gone.clickShown()
  expect(gone.navigated).toEqual(['https://team.example/settings/notifications'])
  const off = worker()
  off.configure({ messages: pushMessages('en') })
  off.preferences({ roomThreadReplies: false })
  off.item({ id: 'event-1', code: 'chat.thread_reply', readAt: null, link: 'chat_thread', chatId, chatThread: { chatId, rootId, name: null, title: null } })
  await off.push({ ...payload, code: 'chat.thread_reply' })
  expect(off.shown).toHaveLength(0)
})

test('a file shared with me (docs/decisions/20261116-file-share-everyone.md): the generic line only; a click opens the file or the press\'s list, the id from the signed-in notice, never from the payload', async () => {
  const linkId = 'AbCdEfGhIjKlMnOpQrStUv', batchId = 'ZyXwVuTsRqPoNmLkJiHgFe'
  const one = worker()
  one.item({ id: 'event-1', code: 'file.shared', readAt: null, link: 'file', chatId: null, fileShare: { by: 'Mia', name: 'PRIVATE FILE.pdf', linkId } })
  await one.push({ ...payload, code: 'file.shared', linkId: 'evil', path: '/evil' })
  expect(one.shown).toHaveLength(1)
  expect(one.shown[0]!.title).toBe(pushMessages('en').title)
  expect(one.shown[0]!.options.body).toBe('Someone shared files with you.')
  expect(JSON.stringify(one.shown)).not.toContain('PRIVATE')
  expect(JSON.stringify(one.shown)).not.toContain('Mia')
  await one.clickShown()
  expect(one.navigated).toEqual([`https://team.example/f/${linkId}`])
  const many = worker()
  many.item({ id: 'event-1', code: 'file.shared', readAt: null, link: 'file', chatId: null, fileShare: { by: 'Mia', name: null, linkId: null, count: 5, batchId } })
  await many.push({ ...payload, code: 'file.shared' })
  await many.clickShown()
  expect(many.navigated).toEqual([`https://team.example/f/batch/${batchId}`])
  // no longer shared with me: the start page
  const gone = worker()
  gone.item({ id: 'event-1', code: 'file.shared', readAt: null, link: null, chatId: null, fileShare: { by: 'Mia', name: null, linkId: null, gone: true } })
  await gone.push({ ...payload, code: 'file.shared' })
  await gone.clickShown()
  expect(gone.navigated).toEqual(['https://team.example/'])
  // read meanwhile: nothing shown
  const read = worker()
  read.item({ id: 'event-1', code: 'file.shared', readAt: '2026-11-16T00:00:00.000Z', link: 'file', chatId: null, fileShare: { by: 'Mia', name: 'x', linkId } })
  await read.push({ ...payload, code: 'file.shared' })
  expect(read.shown).toHaveLength(0)
})

test('a request to open my file (docs/decisions/20261116-file-share-push-gaps.md): the generic line only; a click opens that request in Activity by the signed-in notice\'s id; answered meanwhile or "File sharing" off shows nothing', async () => {
  const linkId = 'AbCdEfGhIjKlMnOpQrStUv'
  const asked = () => ({ id: 'event-1', code: 'file.access_requested', readAt: null, link: 'file', chatId: null, fileShare: { by: 'Jun Secret', name: 'PRIVATE PLAN.pdf', linkId, note: 'PRIVATE NOTE', requestId: 'req-1', state: 'pending', canAnswer: true } })
  const one = worker()
  one.item(asked())
  await one.push({ ...payload, code: 'file.access_requested', path: '/evil', linkId: 'evil' })
  expect(one.shown).toHaveLength(1)
  expect(one.shown[0]!.title).toBe(pushMessages('en').title)
  expect(one.shown[0]!.options.body).toBe('Someone asked to open a file.')
  expect(JSON.stringify(one.shown)).not.toContain('PRIVATE')
  expect(JSON.stringify(one.shown)).not.toContain('Jun')
  await one.clickShown()
  expect(one.navigated).toEqual(['https://team.example/activity?n=event-1'])
  // answered meanwhile (by me or someone else), or no longer mine to answer: nothing shown
  for (const fileShare of [{ ...asked().fileShare, state: 'approved', canAnswer: undefined }, { ...asked().fileShare, canAnswer: undefined }, { by: null, name: null, linkId: null, gone: true }]) {
    const w = worker()
    w.item({ ...asked(), fileShare })
    await w.push({ ...payload, code: 'file.access_requested' })
    expect(w.shown).toHaveLength(0)
  }
  // "File sharing" off: neither file push shows
  const off = worker()
  off.preferences({ fileShares: false })
  off.item(asked())
  await off.push({ ...payload, code: 'file.access_requested' })
  off.item({ id: 'event-1', code: 'file.shared', readAt: null, link: 'file', chatId: null, fileShare: { by: 'Mia', name: 'x', linkId } })
  await off.push({ ...payload, code: 'file.shared' })
  expect(off.shown).toHaveLength(0)
})

test('a request to open my chat or project (docs/decisions/20261116-chat-project-ask-access.md): the generic line only; a click opens it in Activity; answered meanwhile or "Sharing" off shows nothing', async () => {
  const asked = () => ({ id: 'event-1', code: 'access.requested', readAt: null, link: null, chatId: null, accessRequest: { kind: 'chat', by: 'Jun Secret', name: 'PRIVATE CHAT', targetId: 'chat-1', note: 'PRIVATE NOTE', requestId: 'req-1', state: 'pending', canAnswer: true } })
  const one = worker()
  one.item(asked())
  await one.push({ ...payload, code: 'access.requested', path: '/evil' })
  expect(one.shown).toHaveLength(1)
  expect(one.shown[0]!.options.body).toBe('Someone asked for access to a chat or project.')
  expect(JSON.stringify(one.shown)).not.toContain('PRIVATE')
  expect(JSON.stringify(one.shown)).not.toContain('Jun')
  await one.clickShown()
  expect(one.navigated).toEqual(['https://team.example/activity?n=event-1'])
  for (const accessRequest of [{ ...asked().accessRequest, state: 'approved', canAnswer: undefined }, { ...asked().accessRequest, canAnswer: undefined }, { kind: null, by: null, name: null, targetId: null, gone: true }]) {
    const w = worker()
    w.item({ ...asked(), accessRequest })
    await w.push({ ...payload, code: 'access.requested' })
    expect(w.shown).toHaveLength(0)
  }
  const off = worker()
  off.preferences({ fileShares: false })
  off.item(asked())
  await off.push({ ...payload, code: 'access.requested' })
  expect(off.shown).toHaveLength(0)
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

  // the message itself (a mention, a reply; from the signed-in notice, never the payload): the room or the thread at it
  // (?m=: the room goes to it, a thread's room to its first message), so the tap lands where the Activity row does
  const messageId = '0190f5a0-0000-7000-8000-000000000003'
  const mention = worker()
  mention.configure({ messages: messages as any })
  mention.item({ id: 'event-1', code: 'room.mention', readAt: null, link: 'room', room: { id: roomId, from: 'Ben', message: messageId } })
  await mention.push({ ...payload, code: 'room.mention', messageId: 'evil' })
  expect(mention.shown[0]!.options.data).toEqual({ notificationId: 'event-1', roomId, messageId })
  await mention.clickShown()
  expect(mention.navigated).toEqual([`https://team.example/rooms/${roomId}?m=${messageId}`])
  const inThread = worker()
  inThread.configure({ messages: messages as any })
  inThread.item({ id: 'event-1', code: 'room.dm', readAt: null, link: 'room', room: { id: roomId, from: 'Ben', thread: rootId, message: messageId } })
  await inThread.push({ ...payload, code: 'room.dm' })
  await inThread.clickShown()
  expect(inThread.navigated).toEqual([`https://team.example/rooms/${roomId}/t/${rootId}?m=${messageId}`])
  const oddMessage = worker()
  oddMessage.configure({ messages: messages as any })
  oddMessage.item({ id: 'event-1', code: 'room.mention', readAt: null, link: 'room', room: { id: roomId, from: 'Ben', message: '../x' } })
  await oddMessage.push({ ...payload, code: 'room.mention' })
  await oddMessage.clickShown()
  expect(oddMessage.navigated).toEqual([`https://team.example/rooms/${roomId}`])

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

test('a room notice says who and where in its title (from the signed-in notice, one plain line), the text only when the server sends it; an older server: the product\'s name', async () => {
  const roomId = '0190f5a0-0000-7000-8000-000000000001'
  const messages = { title: 'Team', bodies: { 'room.dm': 'New direct message', 'room.mention': 'You were mentioned' } }
  const shown = async (room: Record<string, unknown>, link: string | null = 'room') => {
    const w = worker()
    w.configure({ messages: messages as any })
    w.item({ id: 'event-1', code: 'room.mention', readAt: null, link, room: { id: roomId, from: 'Ben', ...room } })
    await w.push({ ...payload, code: 'room.mention', title: 'PRIVATE PROMPT' })
    return w.shown[0]!
  }
  // the person's message preview on: the server sends the first line, which is the body (one plain line)
  const n = await shown({ label: 'Ben · #design › Thread', preview: 'see the\u2028plan\n' })
  expect(n.title).toBe('Ben · #design › Thread')
  expect(n.options.body).toBe('see the plan')
  // off (no preview from the server), an empty one (only files) or an odd one: the generic line
  expect((await shown({ label: 'Ben' })).options.body).toBe('You were mentioned')
  expect((await shown({ label: 'Ben', preview: '' })).options.body).toBe('You were mentioned')
  expect((await shown({ label: 'Ben', preview: 42 })).options.body).toBe('You were mentioned')
  // never from a notice that has no room any more
  expect(JSON.stringify(await shown({ label: 'Ben', preview: 'SECRET TEXT' }, null))).not.toContain('SECRET')
  // control and bidirectional characters, line breaks and length: one plain line of at most 120 characters
  expect((await shown({ label: 'Be\u202En\n · #de\u2066sign\u200b' })).title).toBe('Ben · #design')
  expect([...(await shown({ label: 'x'.repeat(300) })).title]).toHaveLength(120)
  // an older server (no label), an empty or odd one, or a notice with no room any more: the product's name
  expect((await shown({})).title).toBe('Team')
  expect((await shown({ label: '\u202E\n' })).title).toBe('Team')
  expect((await shown({ label: 42 })).title).toBe('Team')
  expect((await shown({ label: 'Ben' }, null)).title).toBe('Team')
})

test('"Mark as read": a room notice with its place gets the button in the person\'s language; pressing it moves the read position there and opens nothing', async () => {
  const roomId = '0190f5a0-0000-7000-8000-000000000001', root = '0190f5a0-0000-7000-8000-000000000002'
  const at = async (room: Record<string, unknown>, messages: any = pushMessages('en')) => {
    const w = worker()
    w.configure({ messages })
    w.item({ id: 'event-1', code: 'room.dm', readAt: null, link: 'room', room: { id: roomId, from: 'Ben', label: 'Ben', ...room } })
    await w.push({ ...payload, code: 'room.dm' })
    return w
  }
  const w = await at({ seq: 42 })
  expect(w.shown[0]!.options.actions).toEqual([{ action: 'read', title: 'Mark as read' }])
  const before = w.requests.length
  await w.action('read')
  expect(w.requests.slice(before).map(r => [r.path, r.options.method, r.options.body, (r.options.headers as any)['x-mycel-csrf']])).toEqual([[`/api/rooms/${roomId}/read`, 'POST', JSON.stringify({ seq: 42 }), '1']])
  expect(w.navigated).toEqual([])
  // a reply in a thread: the thread's read position
  const t = await at({ seq: 43, thread: root })
  const n = t.requests.length
  await t.action('read')
  expect(t.requests.slice(n).map(r => r.path)).toEqual([`/api/rooms/${roomId}/messages/${root}/thread/read`])
  // no button: an older server (no seq or no words), an odd seq
  expect((await at({})).shown[0]!.options.actions).toBeUndefined()
  expect((await at({ seq: -1 })).shown[0]!.options.actions).toBeUndefined()
  expect((await at({ seq: '5' })).shown[0]!.options.actions).toBeUndefined()
  const { markRead: _, ...older } = pushMessages('en')
  expect((await at({ seq: 5 }, older)).shown[0]!.options.actions).toBeUndefined()
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
  // measured on the monotonic clock: a container's wall clock (Date.now) can be stepped back while the worker waits
  const started = performance.now()
  expect((await shown([{ handled: 'never' }])).silent).toBe(false)
  const waited = performance.now() - started
  expect(waited).toBeGreaterThanOrEqual(350)
  expect(waited).toBeLessThan(2000)
  // other notices never ask
  expect(await shown([{ handled: true }], 'schedule.success')).toEqual({ silent: false, asked: [] })
})

describe('the installed app\'s icon', () => {
  const roomItem = { id: 'event-1', code: 'room.dm', readAt: null, link: 'room', room: { id: '0190f5a0-0000-7000-8000-000000000001', from: 'Ben' } }
  const messages = { title: 'Team', bodies: { ...pushMessages('en').bodies, 'room.dm': 'New direct message', 'room.mention': 'You were mentioned' } }
  /** a push with these windows open; what reached the Badging API */
  const badgeAfter = async (pages: Page[], o: { code?: string; item?: any; reject?: boolean; database?: IDBFactory } = {}) => {
    const calls: unknown[][] = []
    const nav: BadgeNav = {
      setAppBadge: (...a: unknown[]) => { calls.push(['set', ...a]); return o.reject ? Promise.reject(new DOMException('no', 'NotAllowedError')) : Promise.resolve() },
      clearAppBadge: () => { calls.push(['clear']); return Promise.resolve() },
    }
    const w = worker(o.database ?? new IDBFactory(), pages, nav)
    w.configure({ messages: messages as any })
    const code = o.code ?? 'room.dm'
    w.item(o.item ?? (code === 'room.dm' ? roomItem : { id: 'event-1', code, readAt: null }))
    await w.push({ ...payload, code })
    return { calls, shown: w.shown.length, w }
  }
  test('a push shown while no window of the app is open: a dot (no number: the worker does not know the count)', async () => {
    expect(await badgeAfter([])).toMatchObject({ calls: [['set']], shown: 1 })
    expect(await badgeAfter([], { code: 'schedule.success' })).toMatchObject({ calls: [['set']], shown: 1 })
    // a window of another site does not count as open
    expect((await badgeAfter([{ url: 'https://other.example/' }])).calls).toEqual([['set']])
  })
  test('none with a window open (it keeps the exact count), for a silent notice (a page made the sound), or for a push not shown', async () => {
    expect((await badgeAfter([{}])).calls).toEqual([])
    expect((await badgeAfter([{ handled: true }])).calls).toEqual([])
    const read = await badgeAfter([], { item: { ...roomItem, readAt: '2026-11-07T00:00:00.000Z' } })
    expect(read).toMatchObject({ calls: [], shown: 0 })
  })
  test('a refusal changes nothing: the notice shows and is remembered (the same push again shows nothing)', async () => {
    const database = new IDBFactory()
    const first = await badgeAfter([], { reject: true, database })
    expect(first).toMatchObject({ calls: [['set']], shown: 1 })
    const again = await badgeAfter([], { database })
    expect(again.shown).toBe(0)
  })
  test('a browser without the Badging API: shown as before', async () => {
    const w = worker(new IDBFactory(), [])
    w.configure({ messages: messages as any })
    w.item(roomItem)
    await w.push({ ...payload, code: 'room.dm' })
    expect(w.shown).toHaveLength(1)
  })
  test('the account changes (push.invalidate): the dot goes with its notices', async () => {
    const { calls, w } = await badgeAfter([])
    await w.invalidate()
    expect(calls).toEqual([['set'], ['clear']])
  })
})
