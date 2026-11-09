// The image viewer's list and state (web/src/lib/imageViewer.ts): a pane's pictures in page order, only those on the
// page; each kind of picture with the app's own addresses (no new ones); a room's file chips in the same list as its
// pictures (a document read through the room, or its card at once), stepped through together in message order, a file
// whose message went keeping its place; a swipe on a document; Back closes the viewer through one history entry, and
// closing it otherwise goes back off that entry.
import { afterEach, describe, expect, test } from 'bun:test'
import { uuidv7, type Attachment, type Me, type RoomFile } from '@mycel/shared/api'
import { attachmentItem, closeImageViewer, documentSwipe, getImageViewer, localItem, notePage, openImageViewer, orderEntries, roomFileItem, roomItem, showEntry, skipLeftEntry, stepTargets, teamImageItem, ViewerGroup, type ViewerEntry } from '../../src/lib/imageViewer'
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

describe('a room\'s files beside its pictures', () => {
  const roomId = uuidv7()
  const on = { server: { version: '0', dev: false, hwpPreview: true } } as unknown as Me
  const off = { server: { version: '0', dev: false } } as unknown as Me
  const MB = 1024 * 1024
  const f = (name: string, o: Partial<RoomFile> = {}): RoomFile => ({ id: uuidv7(), name, size: 300_000, mime: 'application/octet-stream', kind: 'other', thumb: false, ...o })

  test('a document: read through the room as the side panel reads it, the room\'s download, who and where', () => {
    const pdf = f('acme-q4.pdf', { mime: 'application/pdf', kind: 'pdf' })
    const it = roomFileItem(roomId, pdf, off, { sender: { kind: 'ai' }, at: '2026-11-09T05:10:00.000Z', where: '#acme에서' })
    expect(it).toMatchObject({ kind: 'file', key: `room:${roomId}:${pdf.id}`, name: 'acme-q4.pdf', original: null, size: 300_000, room: { roomId, fileId: pdf.id }, sender: { kind: 'ai' }, where: '#acme에서' })
    expect(it.file).toEqual({ source: 'room', roomId, fileId: pdf.id, name: 'acme-q4.pdf' })
    expect(it.card).toBeUndefined()
    // nothing to open in a new tab, no thumbnail: the stage is FileBody's
    expect(it.href).toBeUndefined()
    expect(it.thumb).toBeUndefined()
    expect(it.download).toBeFunction()
  })
  test('a picture without a thumbnail that the browser draws is a picture all the same; one it cannot draw is a file', () => {
    const png = f('acme-chart.png', { kind: 'image', mime: 'image/png', width: 800, height: 600 })
    const it = roomFileItem(roomId, png, off)
    expect(it.kind).toBeUndefined()
    expect(it.original).toBe(`/api/rooms/${roomId}/files/${png.id}`)
    expect(it.thumb).toBeNull()
    expect(it.room).toEqual({ roomId, fileId: png.id })
    // a HEIC photo (the server converts team files only) and a picture past the 20 MB preview limit: their cards
    expect(roomFileItem(roomId, f('acme.heic', { kind: 'image' }), off)).toMatchObject({ kind: 'file', card: 'unsupported' })
    expect(roomFileItem(roomId, { ...png, size: 30 * MB }, off)).toMatchObject({ kind: 'file', card: 'large' })
  })
  test('the card at once, nothing read: no viewer for it, a Hangul file while the HWP preview is off, past its limit', () => {
    expect(roomFileItem(roomId, f('acme-assets.zip'), on).card).toBe('unsupported')
    expect(roomFileItem(roomId, f('acme-form.hwp'), off).card).toBe('unsupported')
    expect(roomFileItem(roomId, f('acme-form.hwp'), null).card).toBe('unsupported')
    expect(roomFileItem(roomId, f('acme-form.hwp'), on).card).toBeUndefined()
    expect(roomFileItem(roomId, f('acme-scan.hwpx', { size: 20 * MB + 1 }), on).card).toBe('large')
    expect(roomFileItem(roomId, f('acme-report.pdf', { size: 60 * MB }), on).card).toBe('large')
    // text shows its beginning, so any size has a preview
    expect(roomFileItem(roomId, f('acme.log', { size: 60 * MB }), on).card).toBeUndefined()
    for (const name of ['a.docx', 'a.pptx', 'a.xlsx', 'a.csv', 'a.md', 'a.txt', 'a.html', 'a.svg', 'a.mp4', 'a.mp3']) expect(roomFileItem(roomId, f(name), off)).toMatchObject({ kind: 'file' })
    expect(roomFileItem(roomId, f('a.docx'), off).card).toBeUndefined()
  })

  // a message with a photo and a PDF, then one with a ZIP and a photo: drawn in message order, registered in any order
  const shot = { item: { key: 'shot', name: 'shot.png', original: 'x' }, el: el(1) }
  const pdf = { item: { key: 'pdf', name: 'q4.pdf', original: null, kind: 'file' as const }, el: el(2) }
  const zip = { item: { key: 'zip', name: 'assets.zip', original: null, kind: 'file' as const, card: 'unsupported' as const }, el: el(3) }
  const logo = { item: { key: 'logo', name: 'logo.png', original: 'y' }, el: el(4) }
  test('pictures and files are one list in message order; ← → walk it, nothing before the first or after the last', () => {
    const list = orderEntries([zip, logo, pdf, shot])
    expect(list.map((e) => e.item.key)).toEqual(['shot', 'pdf', 'zip', 'logo'])
    const at = (e: ViewerEntry) => { const r = stepTargets(list, e); return [r.index, r.prev?.item.key ?? null, r.next?.item.key ?? null] }
    expect(at(shot)).toEqual([0, null, 'pdf'])
    expect(at(pdf)).toEqual([1, 'shot', 'zip'])
    expect(at(zip)).toEqual([2, 'pdf', 'logo'])
    expect(at(logo)).toEqual([3, 'zip', null])
  })
  test('a file whose message was deleted while open keeps its place: ← → reach the nearest ones still there', () => {
    const before = orderEntries([shot, pdf, zip, logo])
    // the ZIP was open; its message (with the PDF) went, so both are off the page
    const now = orderEntries([shot, { ...pdf, el: el(2, false) }, { ...zip, el: el(3, false) }, logo])
    expect(now.map((e) => e.item.key)).toEqual(['shot', 'logo'])
    expect(stepTargets(now, zip, before)).toMatchObject({ index: -1, prev: shot, next: logo })
    // a neighbour drawn anew (its message re-rendered) is found by its key
    const logoAgain = { ...logo, el: el(4) }
    expect(stepTargets([shot, logoAgain], zip, before)).toMatchObject({ prev: shot, next: logoAgain })
    // the last one went: nothing after it; the only one went: nothing either way
    expect(stepTargets([shot, pdf, zip], logo, before)).toMatchObject({ index: -1, prev: zip, next: null })
    expect(stepTargets([], pdf, [pdf])).toMatchObject({ index: -1, prev: null, next: null })
    // never on the list (nothing seen yet): no steps
    expect(stepTargets([shot, logo], zip)).toMatchObject({ index: -1, prev: null, next: null })
  })
  test('a swipe on a document steps only when it is clearly sideways and quick; anything else is its own scroll', () => {
    expect(documentSwipe(-120, 10, 250)).toBe('next')
    expect(documentSwipe(120, -20, 250)).toBe('prev')
    // too short, too slow, or mostly up or down
    expect(documentSwipe(-40, 0, 200)).toBeNull()
    expect(documentSwipe(-200, 0, 900)).toBeNull()
    expect(documentSwipe(-100, 80, 200)).toBeNull()
  })
})

describe('Back closes the viewer', () => {
  type State = Record<string, unknown> | null
  let stack: State[] = []
  let at = 0
  let backs = 0
  let forwards = 0
  /** a browser's back lands a moment later (a task); `late` holds it until the test lets it land */
  let late: (() => void) | null = null
  let holdBack = false
  const pop = () => globalThis.dispatchEvent(new FakeEvent('popstate') as unknown as Event)
  const fakeHistory = () => ({
    get state() { return stack[at] ?? null },
    pushState(s: State) { stack = [...stack.slice(0, at + 1), s]; at = stack.length - 1 },
    back() {
      backs++
      const land = () => { at = Math.max(0, at - 1); pop() }
      if (holdBack) late = land
      else land()
    },
    forward() { forwards++; if (at < stack.length - 1) { at++; pop() } },
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
    forwards = 0
    late = null
    holdBack = false
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
    showEntry(entry('b', el(2)))
    expect(getImageViewer()?.entry.item.key).toBe('b')
    expect(stack).toHaveLength(2)
  })
  test('closed and opened again before the back has landed: its entry is added once the back lands, and it stays open', () => {
    start()
    holdBack = true
    open()
    closeImageViewer()
    open()
    // nothing pushed while the back is on its way
    expect(stack).toHaveLength(2)
    late!()
    expect(getImageViewer()).not.toBeNull()
    expect(at).toBe(1)
    expect(stack[1]).toMatchObject({ idx: 3, key: 'k1' })
    // and ✕ goes back off the new entry
    holdBack = false
    closeImageViewer()
    expect(at).toBe(0)
  })
  test('Back past a viewer\'s entry that a page change left behind: on to the page before it', () => {
    start()
    notePage()
    open()
    // a notice opened another page on top while the viewer was open
    stack.push({ idx: 4, key: 'k2' })
    at = 2
    closeImageViewer(false)
    notePage()
    // Back: lands on the left-behind entry (the same page again), which goes on back
    at = 1
    skipLeftEntry()
    expect(backs).toBe(1)
    expect(at).toBe(0)
    // Forward from the page below onto it goes on forward
    notePage()
    at = 1
    skipLeftEntry()
    expect(forwards).toBe(1)
    expect(at).toBe(2)
  })
})
