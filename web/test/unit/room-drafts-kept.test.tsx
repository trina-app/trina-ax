// A room's drafts and its sends that did not go are kept on this device (store/rooms.ts keepRoomDraft, keptUnsent), like
// the AI chat's drafts (lib/localData.ts): closing the app (QA TC-374) or a Reload after an update (QA TC-375) does not
// lose them. Per signed-in person and gone at sign-out (QA TC-373). A send that comes back after the app was closed is
// "not sent" with Try again, which sends it with the same client id: the server's copy, never a second message.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { act } from 'react'
import type { Me } from '@mycel/shared/api'
import { RoomComposer } from '../../src/components/rooms/RoomComposer'
import { useLocaleStore } from '../../src/i18n'
import { clearLocalData, draftKey, readDraft, writeDraft } from '../../src/lib/localData'
import { keepUnsentAsDrafts } from '../../src/lib/reload-guard'
import { keepRoomDraft, keptUnsent, onDeviceChange, placeKey, restoreRoomDraft, ROOM_DEVICE_DAYS, roomDraftMentions, roomDrafts, useRooms } from '../../src/store/rooms'
import { useSession } from '../../src/store/session'
import { FakeElement, FakeEvent, installDom, mount, removeDom } from './dom-host'
import { BEN, ME, message, room } from './rooms-fixtures'

const OTHER = { id: 'dana', name: 'Dana' }
const realFetch = globalThis.fetch
const locale = useLocaleStore.getState().locale

/** this device's storage (localStorage) */
class Memory {
  m = new Map<string, string>()
  get length() { return this.m.size }
  key(i: number) { return [...this.m.keys()][i] ?? null }
  getItem(k: string) { return this.m.get(k) ?? null }
  setItem(k: string, v: string) { this.m.set(k, String(v)) }
  removeItem(k: string) { this.m.delete(k) }
  clear() { this.m.clear() }
}
let device = new Memory()

const signIn = (who: { id: string; name: string } = ME) => useSession.setState({ status: { kind: 'signed-in', me: { user: { id: who.id, name: who.name } } as unknown as Me } })

/** the app closed (or the page loaded again): nothing in this page's memory, what this device keeps stays */
function restartApp(who: { id: string; name: string } = ME) {
  useSession.setState({ status: { kind: 'loading' } })
  useRooms.getState().reset()
  signIn(who)
}

/** a fake team server: the newest page of each room (held while `newestHeld` is set), GET /api/rooms, and POST
 * …/messages (the same client id again: the first message, as the server does) */
let posts: { clientMessageId: string; body: string }[] = []
let online = true
let newest: Record<string, ReturnType<typeof message>[]> = {}
const byClientId = new Map<string, ReturnType<typeof message>>()
let newestHeld: Promise<void> | null = null
let roomList: ReturnType<typeof room>[] = []
function server() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://team.localhost').pathname
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } })
    const send = path.match(/^\/api\/rooms\/([^/]+)\/messages$/)
    if (send && init?.method === 'POST') {
      if (!online) throw new TypeError('Failed to fetch')
      const b = JSON.parse(String(init.body)) as { clientMessageId: string; body: string }
      posts.push(b)
      let m = byClientId.get(b.clientMessageId)
      if (!m) {
        m = message({ roomId: send[1]!, seq: 10 + byClientId.size, author: ME, body: b.body, clientMessageId: b.clientMessageId })
        byClientId.set(b.clientMessageId, m)
      }
      return json(m, 201)
    }
    if (send) {
      if (newestHeld) await newestHeld
      return json({ items: newest[send[1]!] ?? [], nextCursor: null })
    }
    if (path === '/api/rooms') return json({ items: roomList })
    if (path.endsWith('/leave')) return json({ ok: true })
    return json({ error: { code: 'not_found', message: 'no' } }, 404)
  }) as typeof fetch
}
const tick = () => new Promise((res) => setTimeout(res, 20))

beforeEach(() => {
  device = new Memory()
  ;(globalThis as { localStorage?: unknown }).localStorage = device
  posts = []
  online = true
  newest = {}
  newestHeld = null
  roomList = []
  byClientId.clear()
  signIn()
  server()
})
afterEach(() => {
  globalThis.fetch = realFetch
  useSession.setState({ status: { kind: 'loading' } })
  useRooms.getState().reset()
  delete (globalThis as { localStorage?: unknown }).localStorage
})

describe("a room box's draft", () => {
  test('kept on this device with its mentions, and back once when the page has none', () => {
    const key = placeKey('room-1')
    roomDrafts.set(key, '@Ben can you check the Q3 deck')
    roomDraftMentions.set(key, [{ start: 0, end: 4, id: BEN.id, name: BEN.name }])
    keepRoomDraft(key)
    restartApp()
    expect(roomDrafts.has(key)).toBe(false)
    restoreRoomDraft(key)
    expect(roomDrafts.get(key)).toBe('@Ben can you check the Q3 deck')
    expect(roomDraftMentions.get(key)).toEqual([{ start: 0, end: 4, id: BEN.id, name: BEN.name }])
    // what the page has wins over what the device kept
    roomDrafts.set(key, 'typed since')
    restoreRoomDraft(key)
    expect(roomDrafts.get(key)).toBe('typed since')
  })

  test('another person signed in on this device gets nothing; signing out clears it (QA TC-373)', () => {
    const key = placeKey('room-1', 'root-1')
    roomDrafts.set(key, 'the thread reply')
    keepRoomDraft(key)
    restartApp(OTHER)
    restoreRoomDraft(key)
    expect(roomDrafts.has(key)).toBe(false)
    restartApp(ME)
    clearLocalData()
    restoreRoomDraft(key)
    expect(roomDrafts.has(key)).toBe(false)
    expect(device.length).toBe(0)
  })

  test('an emptied box removes it from the device', () => {
    const key = placeKey('room-1')
    roomDrafts.set(key, 'x')
    keepRoomDraft(key)
    roomDrafts.delete(key)
    keepRoomDraft(key)
    expect(device.length).toBe(0)
  })

  test('a Reload the person asks for keeps every box\'s draft (QA TC-375)', () => {
    roomDrafts.set(placeKey('room-1'), 'see you at 3')
    roomDrafts.set(placeKey('room-2', 'root-9'), 'a thread reply')
    keepUnsentAsDrafts()
    restartApp()
    restoreRoomDraft(placeKey('room-1'))
    restoreRoomDraft(placeKey('room-2', 'root-9'))
    expect(roomDrafts.get(placeKey('room-1'))).toBe('see you at 3')
    expect(roomDrafts.get(placeKey('room-2', 'root-9'))).toBe('a thread reply')
  })
})

describe('a send that did not go (QA TC-374)', () => {
  const failedSend = async (roomId: string, body = 'on the train') => {
    online = false
    useRooms.getState().send(roomId, { body, mentions: [], files: [] })
    await tick()
    online = true
    return useRooms.getState().pending[roomId]!.at(-1)!
  }
  const openRoom = async (roomId: string) => {
    useRooms.getState().open(roomId)
    await tick()
  }

  test('comes back as not sent after the app was closed; Try again sends it once, then it is gone from the device', async () => {
    const r = room()
    const p = await failedSend(r.id)
    expect(p.state).toBe('failed')
    expect(keptUnsent(r.id)).toMatchObject([{ clientMessageId: p.clientMessageId, body: 'on the train', state: 'failed' }])
    restartApp()
    expect(useRooms.getState().pending[r.id]).toBeUndefined()
    await openRoom(r.id)
    expect(useRooms.getState().pending[r.id]).toMatchObject([{ clientMessageId: p.clientMessageId, body: 'on the train', state: 'failed' }])
    useRooms.getState().retry(r.id, p.clientMessageId)
    await tick()
    expect(posts.map((x) => x.clientMessageId)).toEqual([p.clientMessageId])
    expect(useRooms.getState().pending[r.id]).toBeUndefined()
    expect(useRooms.getState().timeline!.messages.map((m) => m.body)).toEqual(['on the train'])
    expect(keptUnsent(r.id)).toEqual([])
    // opening again brings nothing back
    restartApp()
    await openRoom(r.id)
    expect(useRooms.getState().pending[r.id]).toBeUndefined()
  })

  test('one still on its way when the app closed comes back as not sent; the server already had it: Try again gives its message, not a second one', async () => {
    const r = room()
    // the server got it, its answer never came (the app was closed)
    let lose: () => void = () => {}
    globalThis.fetch = (async () => new Promise<Response>((_, reject) => { lose = () => reject(new TypeError('closed')) })) as unknown as typeof fetch
    useRooms.getState().send(r.id, { body: 'late ack', mentions: [], files: [] })
    const p = useRooms.getState().pending[r.id]![0]!
    expect(keptUnsent(r.id)).toMatchObject([{ clientMessageId: p.clientMessageId }])
    server()
    byClientId.set(p.clientMessageId, message({ roomId: r.id, seq: 3, author: ME, body: 'late ack', clientMessageId: p.clientMessageId }))
    restartApp()
    lose()
    // not on the newest page (an older one): shown not sent
    await openRoom(r.id)
    expect(useRooms.getState().pending[r.id]).toMatchObject([{ clientMessageId: p.clientMessageId, state: 'failed' }])
    useRooms.getState().retry(r.id, p.clientMessageId)
    await tick()
    expect(byClientId.size).toBe(1)
    expect(useRooms.getState().pending[r.id]).toBeUndefined()
    expect(useRooms.getState().timeline!.messages.filter((m) => m.body === 'late ack')).toHaveLength(1)
  })

  test('one the newest page already shows is not shown as not sent, and goes from the device', async () => {
    const r = room()
    const p = await failedSend(r.id, 'got there')
    newest[r.id] = [message({ roomId: r.id, seq: 1, author: ME, body: 'got there', clientMessageId: p.clientMessageId })]
    restartApp()
    await openRoom(r.id)
    expect(useRooms.getState().pending[r.id]).toBeUndefined()
    expect(useRooms.getState().timeline!.messages).toHaveLength(1)
    expect(keptUnsent(r.id)).toEqual([])
    expect(posts).toEqual([])
  })

  test('Discard lets it go here and on the device; a second open brings back nothing twice', async () => {
    const r = room()
    const a = await failedSend(r.id, 'first')
    await failedSend(r.id, 'second')
    restartApp()
    await openRoom(r.id)
    await openRoom(r.id)
    expect(useRooms.getState().pending[r.id]!.map((x) => x.body)).toEqual(['first', 'second'])
    useRooms.getState().discard(r.id, a.clientMessageId)
    expect(keptUnsent(r.id).map((x) => x.body)).toEqual(['second'])
  })

  test('per person, and gone at sign-out', async () => {
    const r = room()
    await failedSend(r.id)
    restartApp(OTHER)
    await openRoom(r.id)
    expect(useRooms.getState().pending[r.id]).toBeUndefined()
    restartApp(ME)
    clearLocalData()
    await openRoom(r.id)
    expect(useRooms.getState().pending[r.id]).toBeUndefined()
  })
})

describe('kept sends are never written over before they are back', () => {
  const failedSend = async (roomId: string, body: string) => {
    online = false
    useRooms.getState().send(roomId, { body, mentions: [], files: [] })
    await tick()
    online = true
    return useRooms.getState().pending[roomId]!.at(-1)!
  }

  test('a new message sent before the newest page came: the kept one is there too, here and on the device', async () => {
    const r = room()
    const old = await failedSend(r.id, 'from before')
    restartApp()
    let release = () => {}
    newestHeld = new Promise<void>((res) => { release = res })
    useRooms.getState().open(r.id)
    useRooms.getState().send(r.id, { body: 'new one', mentions: [], files: [] })
    await tick()
    expect(keptUnsent(r.id).map((p) => p.body)).toEqual(['from before'])
    expect(useRooms.getState().pending[r.id]!.map((p) => [p.body, p.restored ?? false])).toEqual([['from before', true]])
    release()
    await tick()
    expect(useRooms.getState().pending[r.id]!.map((p) => p.clientMessageId)).toEqual([old.clientMessageId])
    expect(posts.map((p) => p.body)).toEqual(['new one'])
  })

  test('a send in a room before it is opened here (a thread reply, a shared answer): the kept one stays', async () => {
    const r = room()
    await failedSend(r.id, 'from before')
    restartApp()
    online = false
    useRooms.getState().send(r.id, { body: 'a thread reply', mentions: [], files: [], threadRootId: 'root-1' })
    await tick()
    expect(keptUnsent(r.id).map((p) => p.body)).toEqual(['from before', 'a thread reply'])
    // opening the room adds nothing twice
    online = true
    useRooms.getState().open(r.id)
    await tick()
    expect(useRooms.getState().pending[r.id]!.map((p) => p.body)).toEqual(['from before', 'a thread reply'])
  })

  test('shown as not confirmed until tried again; a failed retry is an ordinary failure', async () => {
    const r = room()
    const p = await failedSend(r.id, 'maybe sent')
    restartApp()
    useRooms.getState().open(r.id)
    await tick()
    expect(useRooms.getState().pending[r.id]![0]!.restored).toBe(true)
    online = false
    useRooms.getState().retry(r.id, p.clientMessageId)
    await tick()
    expect(useRooms.getState().pending[r.id]![0]).toMatchObject({ state: 'failed' })
    expect(useRooms.getState().pending[r.id]![0]!.restored).toBeUndefined()
  })
})

describe('two tabs of the same person', () => {
  test('a send the other tab let go (or sent) goes here too; nothing is sent from here', async () => {
    const r = room()
    online = false
    useRooms.getState().send(r.id, { body: 'from tab one', mentions: [], files: [] })
    await tick()
    online = true
    const key = draftKey(ME.id, `roomUnsent:${r.id}`)
    // the other tab discarded it: the device's copy no longer has it
    device.removeItem(key)
    onDeviceChange(key, null)
    expect(useRooms.getState().pending[r.id]).toBeUndefined()
    expect(posts).toEqual([])
    // and a send this page is still making stays
    let hold: () => void = () => {}
    globalThis.fetch = (async () => new Promise<Response>((_, reject) => { hold = () => reject(new TypeError('x')) })) as unknown as typeof fetch
    useRooms.getState().send(r.id, { body: 'on its way', mentions: [], files: [] })
    onDeviceChange(key, '[]')
    expect(useRooms.getState().pending[r.id]!.map((p) => p.state)).toEqual(['sending'])
    hold()
  })

  test("this tab's writes keep the other tab's sends and never bring back one this tab saw end", async () => {
    const r = room()
    online = false
    useRooms.getState().send(r.id, { body: 'mine', mentions: [], files: [] })
    await tick()
    const key = draftKey(ME.id, `roomUnsent:${r.id}`)
    // the other tab adds one of its own
    const theirs = { clientMessageId: 'tab-two-0001', body: 'theirs', mentions: [], files: [], threadRootId: null, alsoInRoom: false, createdAt: new Date().toISOString() }
    device.setItem(key, JSON.stringify([...JSON.parse(device.getItem(key)!), theirs]))
    const mine = useRooms.getState().pending[r.id]![0]!
    useRooms.getState().discard(r.id, mine.clientMessageId)
    expect(keptUnsent(r.id).map((p) => p.body)).toEqual(['theirs'])
    // the other tab writes its old copy back with mine in it: this tab's next write drops it again
    device.setItem(key, JSON.stringify([{ ...theirs, clientMessageId: mine.clientMessageId, body: 'mine' }, theirs]))
    useRooms.getState().send(r.id, { body: 'third', mentions: [], files: [] })
    await tick()
    expect(keptUnsent(r.id).map((p) => p.body).sort()).toEqual(['theirs', 'third'])
  })

  test('a draft the other tab sent or changed is what this page has; a Reload here does not bring the old one back', () => {
    const key = placeKey('room-1')
    roomDrafts.set(key, 'old text')
    keepRoomDraft(key)
    const k = draftKey(ME.id, `room:${key}`)
    device.removeItem(k)
    onDeviceChange(k, null)
    expect(roomDrafts.has(key)).toBe(false)
    keepUnsentAsDrafts()
    expect(device.getItem(k)).toBeNull()
    const v = JSON.stringify({ text: 'typed in tab two', mentions: [], at: Date.now() })
    device.setItem(k, v)
    onDeviceChange(k, v)
    expect(roomDrafts.get(key)).toBe('typed in tab two')
    // another person's key is not ours
    onDeviceChange(draftKey(OTHER.id, `room:${key}`), JSON.stringify({ text: 'not mine', mentions: [], at: Date.now() }))
    expect(roomDrafts.get(key)).toBe('typed in tab two')
  })
})

describe('how long the device keeps them', () => {
  const old = new Date(Date.now() - (ROOM_DEVICE_DAYS + 1) * 86_400_000)
  test(`older than ${ROOM_DEVICE_DAYS} days: not brought back`, () => {
    const r = room()
    writeDraft(ME.id, `roomUnsent:${r.id}`, JSON.stringify([{ clientMessageId: 'old-00000001', body: 'old', mentions: [], files: [], threadRootId: null, alsoInRoom: false, createdAt: old.toISOString() }]))
    writeDraft(ME.id, `room:${r.id}`, JSON.stringify({ text: 'old draft', mentions: [], at: old.getTime() }))
    expect(keptUnsent(r.id)).toEqual([])
    restoreRoomDraft(r.id)
    expect(roomDrafts.has(r.id)).toBe(false)
  })

  test('the room list read: rooms I am no longer in, and old drafts, are dropped from the device', async () => {
    const kept = room()
    const gone = room()
    roomList = [kept]
    writeDraft(ME.id, `room:${kept.id}`, JSON.stringify({ text: 'stay', mentions: [], at: Date.now() }))
    writeDraft(ME.id, `room:${kept.id}/root-1`, JSON.stringify({ text: 'too old', mentions: [], at: old.getTime() }))
    writeDraft(ME.id, `room:${gone.id}/root-2`, JSON.stringify({ text: 'left', mentions: [], at: Date.now() }))
    writeDraft(ME.id, `roomUnsent:${gone.id}`, '[]x')
    writeDraft(OTHER.id, `room:${gone.id}`, JSON.stringify({ text: 'not mine to drop', mentions: [], at: Date.now() }))
    await useRooms.getState().loadRooms()
    expect([...device.m.keys()].sort()).toEqual([draftKey(ME.id, `room:${kept.id}`), draftKey(OTHER.id, `room:${gone.id}`)].sort())
  })

  test('leaving a room drops what the device kept for it', async () => {
    const r = room()
    useRooms.setState({ rooms: [r], loaded: true })
    writeDraft(ME.id, `room:${r.id}`, JSON.stringify({ text: 'bye', mentions: [], at: Date.now() }))
    writeDraft(ME.id, `roomUnsent:${r.id}`, '[]')
    await useRooms.getState().leave(r.id)
    expect(device.length).toBe(0)
  })
})

describe('the box itself', () => {
  beforeAll(() => { installDom() })
  afterAll(() => { removeDom() })
  beforeEach(() => { useLocaleStore.setState({ locale: 'en' }) })
  afterEach(() => { useLocaleStore.setState({ locale }) })
  const setValue = Object.getOwnPropertyDescriptor(FakeElement.prototype, 'value')!.set!

  test('what was typed is in the box again after the app was closed, and sending it takes it off the device', async () => {
    const r = room()
    useRooms.setState({ rooms: [r], loaded: true, openRoomId: r.id })
    let m = await mount(<RoomComposer roomId={r.id} members={[ME, BEN]} meId={ME.id} onSent={() => {}} />)
    let box = m.get('room-input') as FakeElement & { value: string }
    await act(async () => {
      box.focus()
      box.dispatchEvent(new FakeEvent('focusin', { bubbles: true }))
      setValue.call(box, 'half a reply')
      box.dispatchEvent(new FakeEvent('input', { bubbles: true }))
      box.dispatchEvent(new FakeEvent('keyup', { bubbles: true }))
    })
    expect(readDraft(ME.id, `room:${r.id}`)).toContain('half a reply')
    await m.unmount()
    restartApp()
    useRooms.setState({ rooms: [r], loaded: true, openRoomId: r.id })
    m = await mount(<RoomComposer roomId={r.id} members={[ME, BEN]} meId={ME.id} onSent={() => {}} />)
    box = m.get('room-input') as FakeElement & { value: string }
    expect(box.value).toBe('half a reply')
    await m.click('room-send')
    await m.until(() => posts.length > 0, 'the send', 4000)
    expect(posts.map((x) => x.body)).toEqual(['half a reply'])
    expect(box.value).toBe('')
    expect(readDraft(ME.id, `room:${r.id}`)).toBe('')
    await m.unmount()
  }, 20_000)
})
