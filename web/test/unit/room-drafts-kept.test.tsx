// A room's drafts and its sends that did not go are kept on this device (store/rooms.ts keepRoomDraft, keptUnsent), like
// the AI chat's drafts (lib/localData.ts): closing the app (QA TC-374) or a Reload after an update (QA TC-375) does not
// lose them. Per signed-in person and gone at sign-out (QA TC-373). A send that comes back after the app was closed is
// "not sent" with Try again, which sends it with the same client id: the server's copy, never a second message.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { act } from 'react'
import type { Me } from '@mycel/shared/api'
import { RoomComposer } from '../../src/components/rooms/RoomComposer'
import { useLocaleStore } from '../../src/i18n'
import { clearLocalData, readDraft } from '../../src/lib/localData'
import { keepUnsentAsDrafts } from '../../src/lib/reload-guard'
import { keepRoomDraft, keptUnsent, placeKey, restoreRoomDraft, roomDraftMentions, roomDrafts, useRooms } from '../../src/store/rooms'
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

/** a fake team server: the newest page of each room, and POST …/messages answered by `answer` (the same client id
 * again: the first message, as the server does) */
let posts: { clientMessageId: string; body: string }[] = []
let online = true
let newest: Record<string, ReturnType<typeof message>[]> = {}
const byClientId = new Map<string, ReturnType<typeof message>>()
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
    if (send) return json({ items: newest[send[1]!] ?? [], nextCursor: null })
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
