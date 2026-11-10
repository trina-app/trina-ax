// Files dropped anywhere on a column (components/FileDropZone.tsx, components/chat/ComposerFiles.tsx useFileDrop): one
// overlay while files from this computer are over it, which moving over the column's own parts never takes away (the
// count of enters and leaves, and `relatedTarget` where the browser gives it), off on a drop, on leaving, at the drag's
// end and on Esc; a drop goes to the box inside, the nearest column winning; the box's own refusals show instead of
// "여기에 놓으면 첨부돼요" and the drop does nothing; text, links and the app's own drags are not taken. On the room page:
// the room's column, the thread beside it and the ✦ side chat each take what is dropped on them. The page-wide guard
// (lib/fileDrop.ts) keeps a file dropped where nothing took it from replacing the app.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { act } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { ROOM_FILES_MAX, uuidv7, type Attachment, type Me } from '@mycel/shared/api'
import { FileDropZone, useDropTarget } from '../../src/components/FileDropZone'
import { RoomComposer } from '../../src/components/rooms/RoomComposer'
import { translate, useLocaleStore } from '../../src/i18n'
import { guardFileDrops } from '../../src/lib/fileDrop'
import { TEAM_FILE_DRAG_TYPE, forgetTeamAttach } from '../../src/lib/teamAttach'
import RoomPage from '../../src/pages/Room'
import { useChats } from '../../src/store/chats'
import { useRooms } from '../../src/store/rooms'
import { useSession } from '../../src/store/session'
import { FakeEvent, installDom, mount, removeDom, type FakeElement, type Mounted } from './dom-host'
import { at, BEN, ME, message, room } from './rooms-fixtures'

const ko = (k: Parameters<typeof translate>[1], p?: Record<string, string | number>) => translate('ko', k, p)
const locale = useLocaleStore.getState().locale
const status = useSession.getState().status
const realFetch = globalThis.fetch
const realXhr = globalThis.XMLHttpRequest

const pdf = (name = 'brief.pdf') => new File(['%PDF-1.4 acme'], name, { type: 'application/pdf' })
type Dt = { types: string[]; files: File[]; dropEffect: string; getData: (type: string) => string }
/** a drag of files from this computer (a screenshot from the desktop) */
const filesDrag = (list: File[] = [pdf()]): Dt => ({ types: ['Files'], files: list, dropEffect: 'none', getData: () => '' })
/** a drag of selected text or a link (inside the app or from another window) */
const textDrag = (): Dt => ({ types: ['text/plain', 'text/uri-list'], files: [], dropEffect: 'none', getData: () => 'https://example.com' })
/** a team file dragged from the file screen, a preview or a message */
const teamDrag = (): Dt => ({ types: [TEAM_FILE_DRAG_TYPE, 'text/plain'], files: [], dropEffect: 'none', getData: (t) => (t === TEAM_FILE_DRAG_TYPE ? 'shared/brief.pdf' : 'brief.pdf') })

type DragEv = FakeEvent & { dataTransfer: Dt; relatedTarget: FakeElement | null }
/** one drag event on an element, as the browser fires it (bubbling, cancelable), inside act */
async function fire(el: FakeElement | { dispatchEvent(e: FakeEvent): boolean }, type: string, dt: Dt, relatedTarget: FakeElement | null = null): Promise<DragEv> {
  const e = Object.assign(new FakeEvent(type, { bubbles: true, cancelable: true }), { dataTransfer: dt, relatedTarget }) as DragEv
  await act(async () => { el.dispatchEvent(e) })
  return e
}
const overlays = (m: Mounted) => [...m.container.ownerDocument!.body.querySelectorAll('[data-testid="drop-overlay"]')]
const overlayText = (m: Mounted) => overlays(m)[0]?.textContent ?? null

beforeAll(() => { installDom(); useLocaleStore.setState({ locale: 'ko' }) })
afterAll(() => { removeDom(); useLocaleStore.setState({ locale }) })

/** a box inside the zone (as the room's or the AI chat's box registers itself), with what it got */
function Box({ got, refuse, id = 'box' }: { got: File[][]; refuse?: string; id?: string }) {
  const inZone = useDropTarget({ files: (f) => void got.push(f), refusal: () => refuse ?? null })
  return <div data-testid={id} data-in-zone={inZone ? 'yes' : 'no'}><span data-testid={`${id}-text`}>box</span></div>
}
/** a column: a header, a list with a message, the box */
function Column({ got, refuse, box = true, empty }: { got: File[][]; refuse?: string; box?: boolean; empty?: string }) {
  return (
    <FileDropZone data-testid="zone" empty={empty}>
      <header data-testid="header"><h1 data-testid="title">acme</h1></header>
      <ul data-testid="list"><li data-testid="msg">hello</li></ul>
      {box && <Box got={got} refuse={refuse} />}
    </FileDropZone>
  )
}

describe('a column that takes files', () => {
  test('files over it: one overlay, "여기에 놓으면 첨부돼요"; moving over its own parts never takes it away; leaving does', async () => {
    const got: File[][] = []
    const m = await mount(<><Column got={got} /><p data-testid="outside">elsewhere</p></>)
    try {
      expect(m.get('box').getAttribute('data-in-zone')).toBe('yes')
      const dt = filesDrag()
      // enters on the title
      await fire(m.get('title'), 'dragenter', dt)
      expect(overlays(m)).toHaveLength(1)
      expect(overlayText(m)).toBe(ko('drop.here'))
      const over = await fire(m.get('title'), 'dragover', dt)
      expect(over.defaultPrevented).toBe(true)
      expect(dt.dropEffect).toBe('copy')
      // Chromium: the next element is entered, then the last one left, saying where the pointer went
      await fire(m.get('msg'), 'dragenter', dt)
      expect(overlays(m)).toHaveLength(1)
      await fire(m.get('title'), 'dragleave', dt, m.get('msg'))
      expect(overlays(m)).toHaveLength(1)
      await fire(m.get('msg'), 'dragover', dt)
      // Safari: no relatedTarget on a leave; the count of enters and leaves keeps it
      await fire(m.get('box-text'), 'dragenter', dt)
      await fire(m.get('msg'), 'dragleave', dt, null)
      expect(overlays(m)).toHaveLength(1)
      // out of the column
      await fire(m.get('outside'), 'dragenter', dt)
      await fire(m.get('box-text'), 'dragleave', dt, m.get('outside'))
      expect(overlays(m)).toHaveLength(0)
      // again, and out without relatedTarget: the last leave of the count
      await fire(m.get('msg'), 'dragenter', dt)
      expect(overlays(m)).toHaveLength(1)
      await fire(m.get('msg'), 'dragleave', dt, null)
      expect(overlays(m)).toHaveLength(0)
      expect(got).toEqual([])
    } finally { await m.unmount() }
  })

  test('a drop anywhere on it goes to the box, as a drop on the box; the overlay goes', async () => {
    const got: File[][] = []
    const m = await mount(<Column got={got} />)
    try {
      const shot = new File([new Uint8Array([137, 80, 78, 71])], 'screenshot.png', { type: 'image/png' })
      const dt = filesDrag([shot])
      await fire(m.get('msg'), 'dragenter', dt)
      await fire(m.get('msg'), 'dragover', dt)
      const drop = await fire(m.get('msg'), 'drop', dt)
      expect(drop.defaultPrevented).toBe(true)
      expect(got).toEqual([[shot]])
      expect(overlays(m)).toHaveLength(0)
      // on the header too
      await fire(m.get('title'), 'dragenter', dt)
      await fire(m.get('title'), 'drop', dt)
      expect(got).toHaveLength(2)
    } finally { await m.unmount() }
  })

  test('Esc, the end of the drag and the pointer somewhere else on the page put the overlay away', async () => {
    const got: File[][] = []
    const m = await mount(<><Column got={got} /><p data-testid="outside">elsewhere</p></>)
    try {
      const dt = filesDrag()
      await fire(m.get('msg'), 'dragenter', dt)
      expect(overlays(m)).toHaveLength(1)
      await act(async () => { window.dispatchEvent(new FakeEvent('keydown', { key: 'Escape' }) as never) })
      expect(overlays(m)).toHaveLength(0)
      await fire(m.get('msg'), 'dragenter', dt)
      await act(async () => { window.dispatchEvent(new FakeEvent('dragend') as never) })
      expect(overlays(m)).toHaveLength(0)
      // the element it was over went away without a leave: the next dragover outside puts it away
      await fire(m.get('msg'), 'dragenter', dt)
      await fire(m.get('outside'), 'dragover', dt)
      expect(overlays(m)).toHaveLength(0)
      // a drop outside it does too
      await fire(m.get('msg'), 'dragenter', dt)
      await fire(m.get('outside'), 'drop', dt)
      expect(overlays(m)).toHaveLength(0)
      expect(got).toEqual([])
    } finally { await m.unmount() }
  })

  test('text, a link or a team file dragged over it: no overlay, nothing taken, the browser keeps its way', async () => {
    const got: File[][] = []
    const m = await mount(<Column got={got} />)
    try {
      for (const dt of [textDrag(), teamDrag()]) {
        await fire(m.get('msg'), 'dragenter', dt)
        const over = await fire(m.get('msg'), 'dragover', dt)
        expect(overlays(m)).toHaveLength(0)
        expect(over.defaultPrevented).toBe(false)
        const drop = await fire(m.get('msg'), 'drop', dt)
        expect(drop.defaultPrevented).toBe(false)
      }
      expect(got).toEqual([])
    } finally { await m.unmount() }
  })

  test('the box would refuse the drop: the overlay says why, no drop is offered, a drop does nothing', async () => {
    const got: File[][] = []
    const full = ko('rooms.tooMany', { n: ROOM_FILES_MAX })
    const m = await mount(<Column got={got} refuse={full} />)
    try {
      const dt = filesDrag()
      await fire(m.get('msg'), 'dragenter', dt)
      expect(overlayText(m)).toBe(full)
      expect(overlays(m)[0]!.getAttribute('data-refused')).toBe('')
      expect(overlayText(m)).not.toContain(ko('drop.here'))
      await fire(m.get('msg'), 'dragover', dt)
      expect(dt.dropEffect).toBe('none')
      // taken all the same, so the browser does not open the file in place of the app
      const drop = await fire(m.get('msg'), 'drop', dt)
      expect(drop.defaultPrevented).toBe(true)
      expect(got).toEqual([])
    } finally { await m.unmount() }
  })

  test('no box in the column (a thread that takes no reply, a chat in the trash): its own reason', async () => {
    const m = await mount(<Column got={[]} box={false} />)
    try {
      await fire(m.get('msg'), 'dragenter', filesDrag())
      expect(overlayText(m)).toBe(ko('drop.noBox'))
    } finally { await m.unmount() }
    const n = await mount(<Column got={[]} box={false} empty={ko('drop.trashed')} />)
    try {
      await fire(n.get('msg'), 'dragenter', filesDrag())
      expect(overlayText(n)).toBe(ko('drop.trashed'))
    } finally { await n.unmount() }
  })

  test('the nearest column wins: one overlay, on the column the pointer is over; its box gets the drop', async () => {
    const outer: File[][] = [], inner: File[][] = []
    const m = await mount(
      <FileDropZone data-testid="outer">
        <p data-testid="outer-text">room</p>
        <Box got={outer} id="outer-box" />
        <FileDropZone data-testid="inner">
          <p data-testid="inner-text">thread</p>
          <Box got={inner} id="inner-box" />
        </FileDropZone>
      </FileDropZone>,
    )
    try {
      const dt = filesDrag()
      await fire(m.get('inner-text'), 'dragenter', dt)
      await fire(m.get('inner-text'), 'dragover', dt)
      expect(overlays(m)).toHaveLength(1)
      expect(m.get('inner').contains(overlays(m)[0]!)).toBe(true)
      // over the outer column's own part: its overlay, the inner one goes
      await fire(m.get('outer-text'), 'dragenter', dt)
      await fire(m.get('inner-text'), 'dragleave', dt, m.get('outer-text'))
      await fire(m.get('outer-text'), 'dragover', dt)
      expect(overlays(m)).toHaveLength(1)
      expect(m.get('inner').contains(overlays(m)[0]!)).toBe(false)
      // back in: the inner one again
      await fire(m.get('inner-box-text'), 'dragenter', dt)
      await fire(m.get('outer-text'), 'dragleave', dt, m.get('inner-box-text'))
      await fire(m.get('inner-box-text'), 'dragover', dt)
      expect(overlays(m)).toHaveLength(1)
      expect(m.get('inner').contains(overlays(m)[0]!)).toBe(true)
      await fire(m.get('inner-box-text'), 'drop', dt)
      expect([inner.length, outer.length]).toEqual([1, 0])
      expect(overlays(m)).toHaveLength(0)
    } finally { await m.unmount() }
  })
})

// ---------------- the room page ----------------

const r = room({ name: 'acme-design', lastSeq: 1, lastReadSeq: 1 })
const root = message({ roomId: r.id, seq: 1, author: BEN, body: 'THE ROOT', thread: { replyCount: 0, lastReplyAt: null, repliers: [], newReplies: false } })
let roomUploads: string[] = []
let chatUploads: { chatId: string; name: string }[] = []

/** the side chat's uploads go through XMLHttpRequest (lib/xhr.ts: they report their progress) */
class FakeXhr {
  upload = { onprogress: null as unknown, onload: null as (() => void) | null }
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  responseType = ''
  withCredentials = false
  status = 0
  response: Blob | null = null
  open() {}
  setRequestHeader() {}
  getResponseHeader(k: string) { return k.toLowerCase() === 'content-type' ? 'application/json' : null }
  send(body: FormData) {
    const name = String(body.get('name')), chatId = String(body.get('chatId'))
    chatUploads.push({ chatId, name })
    const a: Attachment = { id: uuidv7(), name, path: `users/${ME.id}/.attachments/${chatId}/${name}`, size: Number(body.get('size')), mime: 'application/pdf', kind: 'pdf' }
    setTimeout(() => {
      this.upload.onload?.()
      this.status = 201
      this.response = new Blob([JSON.stringify(a)], { type: 'application/json' })
      this.onload?.()
    }, 0)
  }
  abort() { this.onabort?.() }
}

function serve() {
  roomUploads = []
  chatUploads = []
  const side = uuidv7()
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://team.localhost')
    const method = init?.method ?? 'GET'
    const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } })
    const base = `/api/rooms/${r.id}`
    if (method === 'GET' && u.pathname === `${base}/messages`) return json({ items: [root], nextCursor: null })
    if (method === 'GET' && u.pathname === `${base}/members`) return json({ items: [ME, BEN].map((user) => ({ user, joinedAt: at(-60) })) })
    if (method === 'GET' && u.pathname === `${base}/ai`) return json({ answering: 0, mine: [] })
    if (method === 'GET' && u.pathname === `${base}/ai/requests`) return json({ items: [] })
    if (method === 'GET' && u.pathname === `${base}/messages/${root.id}/thread`) return json({ root, items: [], nextCursor: null })
    if (method === 'POST' && u.pathname === `${base}/files`) {
      const f = (init!.body as FormData).get('file') as File
      roomUploads.push(f.name)
      return json({ id: uuidv7(), name: f.name, size: f.size, mime: 'application/pdf', kind: 'pdf', thumb: false }, 201)
    }
    if (method === 'GET' && u.pathname === '/api/chats') return json({ items: [], nextCursor: null })
    if (method === 'POST' && u.pathname === '/api/chats') return json({ id: side, projectId: null, title: '', engine: 'claude-code', model: null, createdAt: at(1), updatedAt: at(1), deletedAt: null, runState: 'idle', sideRoomId: r.id })
    return json({ error: { code: 'not_found', message: 'not here' } }, 404)
  }) as typeof fetch
  return { side }
}

const chipsIn = (m: Mounted, testId: string, chip: string) => [...m.get(testId).querySelectorAll(`[data-testid="${chip}"]`)]
const roomChips = (m: Mounted) => chipsIn(m, 'room-composer', 'room-file-chip')
/** the room page at `path` (/rooms/:id, or a thread: /rooms/:id/t/:root) */
const page = (path: string) => mount(
  <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path="/rooms/:roomId" element={<RoomPage />} />
      <Route path="/rooms/:roomId/t/:messageId" element={<RoomPage />} />
    </Routes>
  </MemoryRouter>,
)
/** files dragged in over an element and dropped there */
async function dropOn(el: FakeElement, list: File[]) {
  const dt = filesDrag(list)
  await fire(el, 'dragenter', dt)
  await fire(el, 'dragover', dt)
  return fire(el, 'drop', dt)
}

describe('the room page', () => {
  beforeAll(() => { globalThis.XMLHttpRequest = FakeXhr as unknown as typeof XMLHttpRequest })
  afterAll(() => { globalThis.XMLHttpRequest = realXhr })
  afterEach(() => {
    globalThis.fetch = realFetch
    useSession.setState({ status })
    useRooms.getState().reset()
    useChats.getState().reset()
    forgetTeamAttach()
  })
  const signIn = () => useSession.setState({ status: { kind: 'signed-in', me: { user: { id: ME.id, name: ME.name }, server: { allChatsConfidential: false } } as unknown as Me } })

  test('a file dropped on the messages or the header goes into the room\'s box; one dropped on the thread beside it into the thread\'s', async () => {
    signIn()
    serve()
    useRooms.setState({ rooms: [r], loaded: true })
    const m = await page(`/rooms/${r.id}/t/${root.id}`)
    try {
      await m.until(() => m.find('thread-count') && m.find('room-message'), 'the room and its thread')
      const boxes = () => [...m.container.querySelectorAll('[data-testid="room-composer"]')]
      await m.until(() => boxes().length === 2, 'both boxes')
      const [roomBox, threadBox] = [m.get('room').querySelector('[data-testid="room-composer"]')!, m.get('room-thread').querySelector('[data-testid="room-composer"]')!]
      const chips = (box: FakeElement) => [...box.querySelectorAll('[data-testid="room-file-chip"]')]
      // the message list, as the teammate asked
      const drop = await dropOn(m.get('room-scroller'), [pdf('screenshot.pdf')])
      expect(drop.defaultPrevented).toBe(true)
      await m.until(() => chips(roomBox)[0]?.getAttribute('data-status') === 'done', 'the room box\'s chip')
      expect(chips(threadBox)).toHaveLength(0)
      // the room's header
      await dropOn(m.get('room-title'), [pdf('header.pdf')])
      await m.until(() => chips(roomBox).length === 2, 'a second chip in the room box')
      // the thread beside it: its own box
      await dropOn(m.get('thread-scroller'), [pdf('reply.pdf')])
      await m.until(() => chips(threadBox)[0]?.getAttribute('data-status') === 'done', 'the thread box\'s chip')
      expect(chips(roomBox)).toHaveLength(2)
      expect(roomUploads).toEqual(['screenshot.pdf', 'header.pdf', 'reply.pdf'])
      expect(overlays(m)).toHaveLength(0)
    } finally { await m.unmount() }
  })

  test('the room\'s box full: the overlay says so and the drop adds nothing', async () => {
    signIn()
    serve()
    useRooms.setState({ rooms: [r], loaded: true })
    const m = await page(`/rooms/${r.id}`)
    try {
      await m.until(() => m.find('room-message'), 'the room')
      await dropOn(m.get('room-scroller'), Array.from({ length: ROOM_FILES_MAX }, (_, i) => pdf(`f${i}.pdf`)))
      await m.until(() => roomChips(m).length === ROOM_FILES_MAX, 'a full box')
      const dt = filesDrag([pdf('one-more.pdf')])
      await fire(m.get('room-scroller'), 'dragenter', dt)
      expect(overlayText(m)).toBe(ko('rooms.tooMany', { n: ROOM_FILES_MAX }))
      await fire(m.get('room-scroller'), 'drop', dt)
      await m.settle(30)
      expect(roomChips(m)).toHaveLength(ROOM_FILES_MAX)
      expect(roomUploads).not.toContain('one-more.pdf')
    } finally { await m.unmount() }
  })

  test('a file dropped on the ✦ side chat goes with my next question there; one dropped on the room, into the room\'s box', async () => {
    signIn()
    const { side } = serve()
    useRooms.setState({ rooms: [r], loaded: true })
    useRooms.getState().setSide(r.id, 'trina')
    const m = await page(`/rooms/${r.id}`)
    try {
      await m.until(() => m.find('side-chat-empty') && m.find('room-message'), 'the room and its side chat')
      const sideChips = () => chipsIn(m, 'side-chat-box', 'attachment-chip')
      await dropOn(m.get('side-chat-scroller'), [pdf('for-trina.pdf')])
      await m.until(() => sideChips()[0]?.getAttribute('data-status') === 'done', 'the side chat\'s chip')
      expect(chatUploads).toEqual([{ chatId: side, name: 'for-trina.pdf' }])
      expect(roomChips(m)).toHaveLength(0)
      expect(roomUploads).toEqual([])
      // the side chat's header is the side chat's too
      await dropOn(m.get('side-chat-room'), [pdf('also-trina.pdf')])
      await m.until(() => sideChips().length === 2, 'a second chip in the side chat')
      // the room's column: the room's box
      await dropOn(m.get('room-scroller'), [pdf('for-the-room.pdf')])
      await m.until(() => roomChips(m)[0]?.getAttribute('data-status') === 'done', 'the room box\'s chip')
      expect(sideChips()).toHaveLength(2)
      expect(roomUploads).toEqual(['for-the-room.pdf'])
    } finally { await m.unmount() }
  })

  test('a room box outside every column still takes a drop on itself; text dragged on it is left alone', async () => {
    signIn()
    serve()
    const m = await mount(<RoomComposer roomId={r.id} members={[ME, BEN]} meId={ME.id} onSent={() => {}} />)
    try {
      const box = m.get('room-composer')
      const text = await fire(box, 'dragover', textDrag())
      expect(text.defaultPrevented).toBe(false)
      await fire(box, 'dragenter', filesDrag())
      expect(box.getAttribute('class')).toContain('sm:ring-2')
      await dropOn(box, [pdf('on-the-box.pdf')])
      await m.until(() => roomChips(m)[0]?.getAttribute('data-status') === 'done', 'the chip')
      expect(roomUploads).toEqual(['on-the-box.pdf'])
      expect(box.getAttribute('class')).not.toContain('sm:ring-2')
    } finally { await m.unmount() }
  })
})

// last: the guard stays on the window of this file's document
test('the page-wide guard: a file dropped where nothing took it is not opened in place of the app; text and links keep the browser\'s way; a target\'s own answer stands', async () => {
  const got: File[][] = []
  const m = await mount(<><Column got={got} /><p data-testid="outside">elsewhere</p></>)
  try {
    guardFileDrops(window)
    const dt = filesDrag()
    const over = await fire(m.get('outside'), 'dragover', dt)
    expect(over.defaultPrevented).toBe(true)
    expect(dt.dropEffect).toBe('none')
    expect((await fire(m.get('outside'), 'drop', dt)).defaultPrevented).toBe(true)
    for (const other of [textDrag(), teamDrag()]) {
      expect((await fire(m.get('outside'), 'dragover', other)).defaultPrevented).toBe(false)
      expect((await fire(m.get('outside'), 'drop', other)).defaultPrevented).toBe(false)
    }
    // over a column: its "copy" stays, and its drop goes to its box
    const into = filesDrag()
    await fire(m.get('msg'), 'dragover', into)
    expect(into.dropEffect).toBe('copy')
    await fire(m.get('msg'), 'drop', into)
    expect(got).toHaveLength(1)
  } finally { await m.unmount() }
})
