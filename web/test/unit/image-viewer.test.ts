// The image viewer's list and state (web/src/lib/imageViewer.ts): a pane's pictures in page order, only those on the
// page; each kind of picture with the app's own addresses (no new ones); Back closes the viewer through one history
// entry, and closing it otherwise goes back off that entry.
import { afterEach, describe, expect, test } from 'bun:test'
import { uuidv7, type Attachment, type RoomFile } from '@mycel/shared/api'
import { attachmentItem, closeImageViewer, getImageViewer, localItem, openImageViewer, orderEntries, roomItem, teamImageItem, ViewerGroup, type ViewerEntry } from '../../src/lib/imageViewer'
import { FakeEvent, installDom, removeDom } from './dom-host'

/** an element at a place on the page (document order is `pos`) */
const el = (pos: number, connected = true) =>
  ({ pos, isConnected: connected, compareDocumentPosition: (o: { pos: number }) => (o.pos > pos ? 4 : 2) }) as unknown as HTMLElement
const entry = (key: string, e: HTMLElement | null): ViewerEntry => ({ item: { key, name: key, original: null }, el: e })

describe('a pane\'s pictures', () => {
  test('in page order, whatever order they registered in', () => {
    const a = entry('a', el(1))
    const b = entry('b', el(2))
    const c = entry('c', el(3))
    expect(orderEntries([c, a, b]).map((e) => e.item.key)).toEqual(['a', 'b', 'c'])
  })
  test('a picture taken off the page, or not drawn yet, is left out', () => {
    expect(orderEntries([entry('a', el(1)), entry('gone', el(2, false)), entry('none', null)]).map((e) => e.item.key)).toEqual(['a'])
  })
  test('the same picture twice (two answers) is two places', () => {
    expect(orderEntries([entry('x', el(2)), entry('x', el(1))])).toHaveLength(2)
  })
  test('a group adds and removes, and tells once for many', async () => {
    const g = new ViewerGroup()
    let told = 0
    g.subscribe(() => told++)
    const a = entry('a', el(2))
    const offA = g.add(a)
    g.add(entry('b', el(1)))
    await Promise.resolve()
    expect(told).toBe(1)
    expect(g.list().map((e) => e.item.key)).toEqual(['b', 'a'])
    offA()
    await Promise.resolve()
    expect(told).toBe(2)
    expect(g.list().map((e) => e.item.key)).toEqual(['b'])
  })
})

describe('the pictures and their addresses', () => {
  const roomId = uuidv7()
  const f: RoomFile = { id: uuidv7(), name: 'acme-shot.png', size: 300_000, mime: 'image/png', kind: 'image', width: 2880, height: 1800, thumb: true }
  test('a room photo: the thumbnail, then the original through the room, its download, and who sent it', () => {
    const it = roomItem(roomId, f, { sender: { kind: 'ai' }, at: '2026-11-09T05:10:00.000Z' })
    expect(it.thumb).toBe(`/api/rooms/${roomId}/files/${f.id}?thumb=1`)
    expect(it.original).toBe(`/api/rooms/${roomId}/files/${f.id}`)
    expect(it.href).toBe(it.original)
    expect(it).toMatchObject({ width: 2880, height: 1800, sender: { kind: 'ai' }, at: '2026-11-09T05:10:00.000Z' })
    expect(it.download).toBeFunction()
  })
  test('a room photo the browser cannot draw, or past the preview limit, keeps its thumbnail', () => {
    expect(roomItem(roomId, { ...f, name: 'acme.heic' }).original).toBeNull()
    expect(roomItem(roomId, { ...f, size: 30 * 1024 * 1024 }).original).toBeNull()
    expect(roomItem(roomId, { ...f, size: 30 * 1024 * 1024 }).href).toBeNull()
  })
  test('a chat attachment: its thumbnail, then the team file by its path; a HEIC photo as the server\'s JPEG', () => {
    const a: Attachment = { id: uuidv7(), name: 'acme.png', path: 'users/alex/.attachments/c/acme.png', size: 1000, mime: 'image/png', kind: 'image' }
    const it = attachmentItem(a)
    expect(it.thumb).toBe(`/api/uploads/${a.id}/thumbnail`)
    expect(it.original).toBe('/api/files/download?path=users%2Falex%2F.attachments%2Fc%2Facme.png&disposition=inline')
    const heic = attachmentItem({ ...a, name: 'acme.heic', path: 'users/alex/.attachments/c/acme.heic' })
    expect(heic.original).toBe('/api/files/preview?path=users%2Falex%2F.attachments%2Fc%2Facme.heic')
    expect(heic.href).toBeNull()
  })
  test('an answer\'s team picture is the original already; a picture in a box has its bytes and nothing to download', () => {
    const it = teamImageItem('shared/acme/chart.png', 'chart.png')
    expect(it.thumb).toBe(it.original)
    const local = localItem('1', new Blob(['x'], { type: 'image/png' }), 'paste.png')
    expect(local.blob).toBeDefined()
    expect(local.download).toBeUndefined()
    expect(local.href).toBeUndefined()
  })
})

describe('Back closes the viewer', () => {
  type State = Record<string, unknown> | null
  let stack: State[] = []
  let at = 0
  let backs = 0
  const fakeHistory = () => ({
    get state() { return stack[at] ?? null },
    pushState(s: State) { stack = [...stack.slice(0, at + 1), s]; at = stack.length - 1 },
    back() { backs++; at = Math.max(0, at - 1); globalThis.dispatchEvent(new FakeEvent('popstate') as unknown as Event) },
  })
  afterEach(() => {
    closeImageViewer(false)
    removeDom()
  })
  const start = () => {
    installDom()
    stack = [{ idx: 3, key: 'k1', usr: null }]
    at = 0
    backs = 0
    Object.defineProperty(globalThis, 'history', { configurable: true, writable: true, value: fakeHistory() })
  }
  const open = () => {
    const e = entry('a', el(1))
    openImageViewer({ group: null, entry: e, opener: null, openerKey: 'a' })
  }

  test('opening adds one entry that keeps the router\'s state; ✕ goes back off it', () => {
    start()
    open()
    expect(stack).toHaveLength(2)
    expect(stack[1]).toMatchObject({ idx: 3, key: 'k1' })
    closeImageViewer()
    expect(getImageViewer()).toBeNull()
    expect(backs).toBe(1)
    expect(at).toBe(0)
  })
  test('the browser\'s Back closes it', () => {
    start()
    open()
    at = 0
    globalThis.dispatchEvent(new FakeEvent('popstate') as unknown as Event)
    expect(getImageViewer()).toBeNull()
    expect(backs).toBe(0)
  })
  test('a page change closes it without going back (its entry is no longer the current one)', () => {
    start()
    open()
    // the router pushed the new page on top
    stack.push({ idx: 4, key: 'k2' })
    at = 2
    closeImageViewer(false)
    expect(getImageViewer()).toBeNull()
    expect(backs).toBe(0)
  })
  test('stepping to another picture adds no entry', () => {
    start()
    open()
    openImageViewer({ group: null, entry: entry('b', el(2)), opener: null, openerKey: 'a' })
    expect(stack).toHaveLength(2)
  })
})
