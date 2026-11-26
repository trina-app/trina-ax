// The room side chat (✦ Trina, components/rooms/SideChatPanel.tsx, docs/DECISIONS.md "트리나 사이드 채팅"): the panel
// opens the room's newest side chat or none; the first question makes a side chat of the room (POST /api/chats with
// sideRoomId) and sends the question there; an answer has one labelled button that sends it to the room or a thread
// (side-chat-send.test.tsx), and the same chat opened in full has the dialog with the room picked. Files go with a
// question as in the full chat's box (components/chat/ComposerFiles.tsx): 📎, paste and drop, uploaded into the side
// chat (made by the first file when there is none), shown above the box with ✕, their ids in the send body; a failed
// upload says why and is not sent.
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act } from 'react'
import { MemoryRouter, Route, Routes, useNavigate, type NavigateFunction } from 'react-router-dom'
import { MESSAGE_ATTACHMENTS_MAX, MESSAGE_TEXT_MAX, PRODUCT_NAMED_AFTER_AI, SIDE_CHAT_QUICK, SIDE_CHAT_SEND, uuidv7, type Attachment, type Chat, type Me, type Message as MessageT, type ServerEvent } from '@mycel/shared/api'
import { AssistantMessage } from '../../src/components/chat/Messages'
import ShareToRoom from '../../src/components/chat/ShareToRoom'
import { SideChatPanel, withQuote, withThread } from '../../src/components/rooms/SideChatPanel'
import { formatDateTime } from '../../src/lib/format'
import { askTrinaInRoom, fileSeed, messageSeed, onAskTrinaInRoom } from '../../src/lib/sideChatAsk'
import { RoomMessages } from '../../src/components/rooms/RoomMessages'
import { useViewerColumn, ViewerColumn } from '../../src/components/rooms/ViewerColumn'
import RoomPage from '../../src/pages/Room'
import { translate, useLocaleStore } from '../../src/i18n'
import { aiName } from '../../src/lib/tabs'
import { useChats } from '../../src/store/chats'
import { useSendQueue } from '../../src/store/sendQueue'
import { useRooms } from '../../src/store/rooms'
import { sideChatOf, useSideChats } from '../../src/store/sideChats'
import { useSession } from '../../src/store/session'
import { useUi } from '../../src/store/ui'
import { forgetTeamAttach } from '../../src/lib/teamAttach'
import { keepSideChatOpen, resetSideChatOpenForTest } from '../../src/lib/sideChatOpenKeep'
import { FakeEvent, installDom, mount, removeDom, type FakeElement, type Mounted } from './dom-host'
import { CHAT, msg } from './fixtures'
import { at, BEN, ME, message, room } from './rooms-fixtures'

const en = (k: Parameters<typeof translate>[1], p?: Record<string, string | number>) => translate('en', k, p)
const locale = useLocaleStore.getState().locale
const status = useSession.getState().status
const realFetch = globalThis.fetch
let calls: { method: string; path: string; search: string; body: Record<string, unknown> | undefined }[] = []

/** The uploads, which go through XMLHttpRequest (an upload reports its progress: lib/xhr.ts): what was sent, and the
 * answer for each by its name (an attachment by default; null: held, never answered). */
let uploads: { chatId: string; name: string }[] = []
let attached: Attachment[] = []
let answerUpload: (name: string, chatId: string, size: number) => { status: number; body: unknown } | null = (name, chatId, size) => {
  const a: Attachment = { id: uuidv7(), name, path: `users/${ME.id}/.attachments/${chatId}/${name}`, size, mime: name.endsWith('.png') ? 'image/png' : 'application/pdf', kind: name.endsWith('.png') ? 'image' : 'pdf' }
  attached.push(a)
  return { status: 201, body: a }
}
const answerAttachment = answerUpload
let xhrs: FakeXhr[] = []
class FakeXhr {
  aborted = false
  constructor() { xhrs.push(this) }
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
    uploads.push({ chatId, name })
    const a = answerUpload(name, chatId, Number(body.get('size')))
    if (!a) return
    setTimeout(() => {
      this.upload.onload?.()
      this.status = a.status
      this.response = new Blob([JSON.stringify(a.body)], { type: 'application/json' })
      this.onload?.()
    }, 0)
  }
  abort() { this.aborted = true; this.onabort?.() }
}
const realXhr = globalThis.XMLHttpRequest

beforeAll(() => { installDom(); useLocaleStore.setState({ locale: 'en' }); globalThis.XMLHttpRequest = FakeXhr as unknown as typeof XMLHttpRequest })
afterEach(() => {
  globalThis.fetch = realFetch
  useSession.setState({ status })
  useRooms.getState().reset()
  useChats.getState().reset()
  forgetTeamAttach()
  uploads = []
  attached = []
  xhrs = []
  answerUpload = answerAttachment
})
afterAll(() => { removeDom(); useLocaleStore.setState({ locale }); globalThis.XMLHttpRequest = realXhr })

const pdf = (name = 'acme-brief.pdf') => new File(['%PDF-1.4 acme'], name, { type: 'application/pdf' })
const png = (name = 'image.png') => new File([new Uint8Array([137, 80, 78, 71])], name, { type: 'image/png' })
/** files picked with 📎's file input */
async function pick(m: Mounted, files: File[]) {
  const input = m.get('side-chat-file-input')
  await m.click('side-chat-attach')
  Object.assign(input, { files })
  input.dispatchEvent(new FakeEvent('change', { bubbles: true }))
  await m.settle()
}
/** files pasted into the box (a screenshot: the clipboard's files) */
async function paste(m: Mounted, files: File[]) {
  const e = Object.assign(new FakeEvent('paste', { bubbles: true, cancelable: true }), { clipboardData: { files, items: [] } })
  m.get('side-chat-input').dispatchEvent(e)
  await m.settle()
  return e
}
const chips = (m: Mounted) => [...m.container.ownerDocument!.body.querySelectorAll('[data-testid="attachment-chip"]')]
const sentTo = (id: string) => calls.find((c) => c.method === 'POST' && c.path === `/api/chats/${id}/messages`)

const team = room({ name: 'Marketing', memberCount: 6, activityAt: at(5) })
const signIn = () => useSession.setState({ status: { kind: 'signed-in', me: { user: { id: ME.id, name: ME.name }, server: { allChatsConfidential: false } } as unknown as Me } })

/** The fake server: the room's side chats (`existing` the newest, then `older`; `newest`: more of the newest's fields,
 * such as an answer not seen), each one made added in front; `turns`: a question is taken and its answer starts (else
 * refused); the room page's reads (its messages: ben's `root`, members, AI, the thread). */
function serve(existing: string | null, older: string[] = [], o: { newest?: Partial<Chat>; turns?: boolean } = {}) {
  calls = []
  turns = {}
  const made = uuidv7()
  let next = made
  const chat = (id: string): Chat => ({ id, projectId: null, title: '', engine: 'claude-code', model: null, createdAt: at(1), updatedAt: at(1), deletedAt: null, runState: 'idle', sideRoomId: team.id, ...(id === existing ? o.newest : {}) })
  const list = [...(existing ? [existing] : []), ...older]
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://team.localhost')
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({ method, path: u.pathname, search: u.search, body })
    const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } })
    if (method === 'GET' && u.pathname === '/api/chats') return json({ items: list.slice(0, Number(u.searchParams.get('limit') ?? 50)).map(chat), nextCursor: null })
    if (method === 'POST' && u.pathname === '/api/chats') {
      const id = next
      next = uuidv7()
      list.unshift(id)
      return json(chat(id))
    }
    const sent = /^\/api\/chats\/([^/]+)\/messages$/.exec(u.pathname)
    if (method === 'GET' && sent) return json({ items: turns[sent[1]!] ?? [], nextCursor: null, activeLeafId: null })
    if (method === 'POST' && sent && o.turns) {
      const chatId = sent[1]!
      const userMessage = msg({ chatId, role: 'user', content: body.content, parentId: turns[chatId]?.at(-1)?.id ?? null })
      const assistantMessage = msg({ chatId, role: 'assistant', parentId: userMessage.id, status: 'streaming', turnId: uuidv7() })
      turns[chatId] = [...(turns[chatId] ?? []), userMessage, assistantMessage]
      return json({ userMessage, assistantMessage, turnId: assistantMessage.turnId, queuePosition: 0 }, 202)
    }
    if (method === 'POST' && /^\/api\/turns\/[^/]+\/answer$/.test(u.pathname)) return new Response(null, { status: 204 })
    const base = `/api/rooms/${team.id}`
    if (method === 'GET' && u.pathname === `${base}/messages`) return json({ items: [root], nextCursor: null })
    if (method === 'GET' && u.pathname === `${base}/members`) return json({ items: [ME, BEN].map((user) => ({ user, joinedAt: at(-60) })) })
    if (method === 'GET' && u.pathname === `${base}/ai`) return json({ answering: 0, mine: [] })
    if (method === 'GET' && u.pathname === `${base}/ai/requests`) return json({ items: [] })
    if (method === 'GET' && u.pathname === `${base}/messages/${root.id}/thread`) return json({ root, items: [], nextCursor: null })
    return json({ error: { code: 'not_found', message: 'not here' } }, 404)
  }) as typeof fetch
  return { made }
}
/** the room's newest side chat has an answer I have not seen: a panel opens on it (else on a new chat) */
const UNSEEN = { newest: { unseen: true } } as const
/** each side chat's messages on the fake server (`serve` with `turns`), by chat */
let turns: Record<string, MessageT[]> = {}
/** the answer of the chat's last question ends (message.done), with `unseen` when no panel had it on screen (chat.updated) */
function answerEnds(chatId: string, o: { unseen?: boolean } = {}) {
  const a = turns[chatId]!.at(-1)!
  const done = { ...a, status: 'done' as const, content: 'Wednesday, two drafts.' }
  turns[chatId] = [...turns[chatId]!.slice(0, -1), done]
  act(() => {
    useChats.getState().handleEvent({ type: 'message.done', seq: 1, at: 0, data: { chatId, messageId: a.id, status: 'done', message: done } } as ServerEvent)
    const row = useChats.getState().chats.find((c) => c.id === chatId)!
    useChats.getState().handleEvent({ type: 'chat.updated', seq: 2, at: 0, data: { chatId, change: 'updated', chat: { ...row, runState: 'idle', ...(o.unseen ? { unseen: true } : {}) } } } as ServerEvent)
  })
}
const root = message({ roomId: team.id, seq: 1, author: BEN, body: 'logo drafts by Friday?' })
/** the page's navigate (a link, Back) */
let go: NavigateFunction = () => {}
function Nav() {
  go = useNavigate()
  return null
}
/** the room page at `path` (/rooms/:id, or a thread: /rooms/:id/t/:root) */
const roomPage = (path = `/rooms/${team.id}`) => mount(
  <MemoryRouter initialEntries={[path]}>
    <Nav />
    <Routes>
      <Route path="/rooms/:roomId" element={<RoomPage />} />
      <Route path="/rooms/:roomId/t/:messageId" element={<RoomPage />} />
    </Routes>
  </MemoryRouter>,
)

test('no side chat yet: the empty line; the first question makes a side chat of the room and sends it there', async () => {
  signIn()
  const { made } = serve(null)
  const m = await mount(<MemoryRouter><SideChatPanel roomId={team.id} roomTitle="Marketing" onClose={() => {}} /></MemoryRouter>)
  try {
    await m.until(() => !!m.find('side-chat-empty'), 'the empty line')
    // (the box's "no usable AI" line asks GET /api/me/ai-access beside it)
    const first = calls.find((c) => c.path !== '/api/me/ai-access')
    expect(first).toMatchObject({ method: 'GET', path: '/api/chats' })
    expect(first!.search).toContain(`sideRoomId=${team.id}`)
    expect(m.get('side-chat-room').textContent).toBe('Marketing')
    // no "only you see this" under the box (the empty line says it), and send is the room box's round ↑, named
    expect(m.find('side-chat-private')).toBeNull()
    expect(m.get('side-chat-send').getAttribute('aria-label')).toBe(en('sideChat.send'))
    expect(m.get('side-chat-send').textContent).toBe('')
    expect(m.get('side-chat-send').querySelector('svg')!.getAttribute('class')).toContain('lucide-arrow-up')
    expect(m.get('side-chat-send').hasAttribute('disabled')).toBe(true)
    expect(m.get('side-chat-send').getAttribute('class')).toContain('bg-subtle text-faint')
    // no chat yet: no "new chat" and no "open as a full chat"
    expect(m.get('side-chat-new').hasAttribute('disabled')).toBe(true)
    expect(m.find('side-chat-open-full')).toBeNull()
    await m.type('side-chat-input', 'summarize this room')
    expect(m.get('side-chat-send').hasAttribute('disabled')).toBe(false)
    expect(m.get('side-chat-send').getAttribute('class')).toContain('bg-accent text-accent-ink')
    await m.click('side-chat-send')
    await m.until(() => calls.some((c) => c.method === 'POST' && c.path === `/api/chats/${made}/messages`), 'the question sent')
    expect(calls.find((c) => c.method === 'POST' && c.path === '/api/chats')!.body).toMatchObject({ sideRoomId: team.id })
    expect(calls.find((c) => c.path === `/api/chats/${made}/messages`)!.body).toMatchObject({ content: 'summarize this room' })
  } finally {
    await m.unmount()
  }
})

test('the box has the mic right before send, as every message box (voice input off for the team: no mic)', async () => {
  signIn()
  serve(null)
  const m = await mount(<MemoryRouter><SideChatPanel roomId={team.id} roomTitle="Marketing" onClose={() => {}} /></MemoryRouter>)
  try {
    await m.until(() => !!m.find('side-chat-empty'), 'the empty line')
    const tools = m.get('side-chat-tools')
    const mic = tools.querySelector('[data-testid="voice-button"]')!
    expect(mic.getAttribute('aria-label')).toBe(en('voice.start'))
    expect(mic.hasAttribute('disabled')).toBe(false)
    // the clip, then the mic, then send
    const order = [...tools.querySelectorAll('[data-testid]')].map((e) => e.getAttribute('data-testid'))
    expect(order.filter((id) => ['side-chat-attach', 'voice-button', 'side-chat-send'].includes(id!))).toEqual(['side-chat-attach', 'voice-button', 'side-chat-send'])
    // the live region is there before a recording, so its first words are read
    expect(m.get('voice-live').textContent).toBe('')
  } finally {
    await m.unmount()
  }
  useSession.setState({ status: { kind: 'signed-in', me: { user: { id: ME.id, name: ME.name }, server: { allChatsConfidential: false }, team: { voiceInput: false } } as unknown as Me } })
  serve(null)
  const off = await mount(<MemoryRouter><SideChatPanel roomId={team.id} roomTitle="Marketing" onClose={() => {}} /></MemoryRouter>)
  try {
    await off.until(() => !!off.find('side-chat-empty'), 'the empty line')
    expect(off.find('voice-button')).toBeNull()
    expect(off.get('side-chat-send')).toBeTruthy()
  } finally {
    await off.unmount()
  }
})

test('opened, it is a new chat: the room\'s earlier side chat is not shown but listed in 🕘, where it opens', async () => {
  signIn()
  const id = uuidv7()
  serve(id)
  const m = await mount(<MemoryRouter><SideChatPanel roomId={team.id} roomTitle="Marketing" onClose={() => {}} /></MemoryRouter>)
  try {
    await m.until(() => !!m.find('side-chat-empty'), 'a new chat')
    expect(m.find('side-chat-starters')).not.toBeNull()
    expect(m.find('side-chat-open-full')).toBeNull()
    // the newest asked for once, its messages not read, nothing made
    expect(calls.filter((c) => c.method === 'GET' && c.path === '/api/chats')).toHaveLength(1)
    expect(calls.some((c) => c.path === `/api/chats/${id}/messages`)).toBe(false)
    expect(calls.some((c) => c.method === 'POST')).toBe(false)
    await m.click('side-chat-history')
    await m.until(() => !!m.find('side-chat-history-item'), 'the list')
    const item = m.get('side-chat-history-item')
    expect(item.getAttribute('aria-current')).toBeNull()
    await m.click(item)
    await m.until(() => !!m.find('side-chat-open-full'), 'the earlier chat')
    expect(calls.some((c) => c.path === `/api/chats/${id}/messages`)).toBe(true)
  } finally {
    await m.unmount()
  }
})

test('the first opening on this page (after a reload): the newest side chat while it is not done (running, queued, an answer not seen, failed unseen, the AI waiting on me)', async () => {
  const cases: Partial<Chat>[] = [{ runState: 'running' }, { runState: 'queued' }, { unseen: true }, { unseen: true, lastOutcome: 'error' }, { waiting: true }]
  for (const newest of cases) {
    signIn()
    const id = uuidv7()
    serve(id, [], { newest })
    const m = await mount(<MemoryRouter><SideChatPanel roomId={team.id} roomTitle="Marketing" onClose={() => {}} /></MemoryRouter>)
    try {
      await m.until(() => !!m.find('side-chat-open-full'), `the chat (${JSON.stringify(newest)})`)
      expect(calls.some((c) => c.path === `/api/chats/${id}/messages`)).toBe(true)
      expect(calls.some((c) => c.method === 'POST' && c.path === '/api/chats')).toBe(false)
    } finally {
      await m.unmount()
      useRooms.getState().reset()
      useChats.getState().reset()
    }
  }
})

test('a side chat\'s answer: one click in words (side-chat-send.test.tsx); as a full chat (↗) the dialog starts with its room picked', async () => {
  signIn()
  const a = await mount(<MemoryRouter><AssistantMessage m={msg({ role: 'assistant', content: 'the plan', status: 'done' })} chatId={CHAT} isLast busy={false} switchedFrom={null} onRegenerate={() => {}} onSelectBranch={() => {}} onAskOwnFolder={() => {}} shareable sendHere={{ roomId: team.id, target: null, onView: () => {} }} /></MemoryRouter>)
  try {
    expect(a.get('send-here-room').textContent).toBe(SIDE_CHAT_SEND.room.en)
    expect(a.find('share-to-room')).toBeNull()
  } finally {
    await a.unmount()
  }
  // the full chat: the dialog's button, its room picked when the dialog opens (pages/Chat.tsx: chat.sideRoomId)
  const full = await mount(<MemoryRouter><AssistantMessage m={msg({ role: 'assistant', content: 'the plan', status: 'done' })} chatId={CHAT} isLast busy={false} switchedFrom={null} onRegenerate={() => {}} onSelectBranch={() => {}} onAskOwnFolder={() => {}} shareable shareRoomId={team.id} /></MemoryRouter>)
  try {
    expect(full.get('share-to-room').getAttribute('aria-label')).toBe(en('chat.shareToRoom'))
    expect(full.find('send-here-room')).toBeNull()
  } finally {
    await full.unmount()
  }
  useRooms.setState({ rooms: [team, room({ name: 'Other', activityAt: at(4) })], loaded: true })
  const m = await mount(<ShareToRoom chatId={CHAT} messageId={uuidv7()} answer="short" roomId={team.id} onClose={() => {}} />)
  try {
    const picked = m.container.ownerDocument!.body.querySelector(`[data-room-id="${team.id}"]`)!
    expect(picked.getAttribute('aria-selected')).toBe('true')
    expect(m.get('share-room-send').hasAttribute('disabled')).toBe(false)
  } finally {
    await m.unmount()
  }
  expect(en('sideChat.open', { name: aiName((k) => en(k)) })).not.toContain('privately')
})

test("two panels of a room (the page's and the file viewer's) are one chat: the same chat, draft and quote; an ask is quoted once", async () => {
  signIn()
  const id = uuidv7()
  serve(id, [], UNSEEN)
  const seed = { key: 'kq', author: 'acme', at: at(1), text: 'the launch date' }
  const m = await mount(
    <MemoryRouter>
      <div data-testid="page"><SideChatPanel roomId={team.id} roomTitle="Marketing" seed={seed} onClose={() => {}} /></div>
      <div data-testid="viewer"><SideChatPanel roomId={team.id} roomTitle="Marketing" frame={false} autoFocus={false} onClose={() => {}} /></div>
    </MemoryRouter>,
  )
  const inEach = (testId: string) => [...m.container.ownerDocument!.body.querySelectorAll(`[data-testid="${testId}"]`)]
  try {
    await m.until(() => inEach('side-chat-open-full').length === 2, 'the chat found in both')
    // looked for once: the second panel takes the chat the room has on this page
    expect(calls.filter((c) => c.method === 'GET' && c.path === '/api/chats')).toHaveLength(1)
    // frame={false}: no column of its own (the caller's RoomSideColumn draws it)
    expect(m.get('viewer').querySelector('section')).toBeNull()
    expect(m.get('viewer').querySelector('[data-testid="side-chat-divider"]')).toBeNull()
    expect(m.get('page').querySelector('[data-testid="room-side-chat"]')).not.toBeNull()
    // the ask is quoted in both, and what is typed in one is in the other
    expect(inEach('side-chat-quote')).toHaveLength(2)
    await m.type(m.get('viewer').querySelector('[data-testid="side-chat-input"]')! as never, 'when is it?')
    expect(inEach('side-chat-input').map((x) => (x as unknown as { value: string }).value)).toEqual(['when is it?', 'when is it?'])
    // the quote taken off in one goes from both
    await m.click(m.get('viewer').querySelector('[data-testid="side-chat-quote-remove"]')! as never)
    expect(inEach('side-chat-quote')).toHaveLength(0)
  } finally {
    await m.unmount()
  }
  // drawn again with the same ask (the room page keeps its last one): not quoted again; the draft is still there
  const again = await mount(<MemoryRouter><SideChatPanel roomId={team.id} roomTitle="Marketing" seed={seed} onClose={() => {}} /></MemoryRouter>)
  try {
    await again.until(() => !!again.find('side-chat-open-full'), 'the chat')
    expect(again.find('side-chat-quote')).toBeNull()
    expect((again.get('side-chat-input') as unknown as { value: string }).value).toBe('when is it?')
    // the chat it had, read again (not looked for anew)
    expect(calls.filter((c) => c.method === 'GET' && c.path === '/api/chats')).toHaveLength(1)
  } finally {
    await again.unmount()
  }
})

test("an ask is quoted once, also after a newer one: the room page's last ask does not come back over the viewer's file", async () => {
  signIn()
  serve(null)
  const message = { key: 'km', author: 'acme', at: at(1), text: 'the launch date' }
  const fileAsk = { key: 'kf2', author: '', at: at(2), text: '', file: { id: 'f-2', name: 'acme.pdf' } }
  const page = await mount(<MemoryRouter><SideChatPanel roomId={team.id} roomTitle="Marketing" seed={message} onClose={() => {}} /></MemoryRouter>)
  try {
    await page.until(() => !!page.find('side-chat-quote'), 'the message quoted')
    await page.click('side-chat-quote-remove')
  } finally {
    await page.unmount()
  }
  // ✦ in the viewer asks about a file
  const viewer = await mount(<MemoryRouter><SideChatPanel roomId={team.id} roomTitle="Marketing" seed={fileAsk} frame={false} onClose={() => {}} /></MemoryRouter>)
  try {
    await viewer.until(() => !!viewer.find('side-chat-quote-file'), 'the file quoted')
  } finally {
    await viewer.unmount()
  }
  // the room page's side chat again, with its last ask still in hand: the file stays quoted
  const again = await mount(<MemoryRouter><SideChatPanel roomId={team.id} roomTitle="Marketing" seed={message} onClose={() => {}} /></MemoryRouter>)
  try {
    await again.until(() => !!again.find('side-chat-quote'), 'the quote')
    expect(again.find('side-chat-quote-file')).not.toBeNull()
  } finally {
    await again.unmount()
  }
})

test('autoFocus false: the box leaves the focus where it is as the panel opens; an ask still takes it', async () => {
  signIn()
  serve(null)
  const doc = () => m.container.ownerDocument as unknown as { activeElement: unknown }
  const m = await mount(<MemoryRouter><SideChatPanel roomId={team.id} roomTitle="Marketing" frame={false} autoFocus={false} onClose={() => {}} /></MemoryRouter>)
  try {
    await m.until(() => !!m.find('side-chat-empty'), 'the panel')
    expect(doc().activeElement).not.toBe(m.get('side-chat-input'))
  } finally {
    await m.unmount()
  }
  const f = await mount(<MemoryRouter><SideChatPanel roomId={team.id} roomTitle="Marketing" onClose={() => {}} /></MemoryRouter>)
  try {
    await f.until(() => !!f.find('side-chat-empty'), 'the panel')
    expect((f.container.ownerDocument as unknown as { activeElement: unknown }).activeElement).toBe(f.get('side-chat-input'))
  } finally {
    await f.unmount()
  }
})

test('🕘 lists the room\'s side chats and opens one; "New chat" leaves the list', async () => {
  signIn()
  const id = uuidv7(), old = uuidv7()
  serve(id, [old], UNSEEN)
  const m = await mount(<MemoryRouter><SideChatPanel roomId={team.id} roomTitle="Marketing" onClose={() => {}} /></MemoryRouter>)
  try {
    await m.until(() => !!m.find('side-chat-open-full'), 'the chat found')
    await m.click('side-chat-history')
    await m.until(() => !!m.find('side-chat-history-list'), 'the list')
    const listCall = calls.filter((c) => c.method === 'GET' && c.path === '/api/chats').at(-1)!
    expect(listCall.search).toContain(`sideRoomId=${team.id}`)
    expect(listCall.search).toContain('limit=30')
    const items = m.container.ownerDocument!.body.querySelectorAll('[data-testid="side-chat-history-item"]')
    expect(items).toHaveLength(2)
    expect(items[0]!.getAttribute('aria-current')).toBe('true')
    await m.click(items[1]!)
    await m.until(() => !m.find('side-chat-history-list'), 'the list closed')
    expect(calls.some((c) => c.path === `/api/chats/${old}/messages`)).toBe(true)
  } finally {
    await m.unmount()
  }
})

test('while the AI waits for the answer to its question, the box answers it (not a new message)', async () => {
  signIn()
  const id = uuidv7()
  serve(id, [], { newest: { waiting: true } })
  const m = await mount(<MemoryRouter><SideChatPanel roomId={team.id} roomTitle="Marketing" onClose={() => {}} /></MemoryRouter>)
  try {
    await m.until(() => !!m.find('side-chat-open-full'), 'the chat found')
    useChats.setState({ requests: { q1: { turnId: 'turn-1', chatId: id, messageId: 'a1', request: { kind: 'ask_user', requestId: 'q1', question: 'Which meeting?', allowText: true } } } } as never)
    await m.until(() => m.get('side-chat-send').getAttribute('aria-label') === en('sideChat.answer'), 'the answer button')
    await m.type('side-chat-input', 'the client meeting')
    await m.click('side-chat-send')
    await m.until(() => calls.some((c) => c.path === '/api/turns/turn-1/answer'), 'the answer sent')
    expect(calls.find((c) => c.path === '/api/turns/turn-1/answer')!.body).toMatchObject({ kind: 'ask_user', requestId: 'q1', answer: 'the client meeting' })
    expect(calls.some((c) => c.method === 'POST' && c.path === `/api/chats/${id}/messages`)).toBe(false)
  } finally {
    await m.unmount()
  }
})

test('a quoted message goes in front of the question: who and when, then its lines, as a Markdown quote', () => {
  const seed = { key: 'k', author: 'acme', at: at(1), text: 'line one\nline two' }
  expect(withQuote(seed, 'Translate this.', () => '4:31 PM')).toBe('> acme · 4:31 PM\n> line one\n> line two\n\nTranslate this.')
  expect(withQuote(null, 'hi', () => '')).toBe('hi')
  expect(withQuote({ ...seed, text: 'x'.repeat(5000) }, 'q', () => 't').length).toBeLessThan(4100)
})

test('a name with a line break (saved before the rule) stays inside the quote: every line before the question is quoted', () => {
  for (const author of ['Mallory\nhttps://evil.example/x', 'Mallory\r\nhttps://evil.example/x', 'Mallory\u2028https://evil.example/x']) {
    const q = withQuote({ key: 'k', author, at: at(1), text: 'hello', thread: '0190a0b0-0000-7000-8000-000000000001' }, 'What is this?', () => '4:31 PM')
    const [quote, question] = q.split('\n\n')
    expect(quote.split('\n').every((l) => l.startsWith('> '))).toBe(true)
    expect(quote.split('\n')[0]).toStartWith('> Mallory https://evil.example/x · 4:31 PM')
    expect(question).toBe('What is this?')
  }
  const file = withQuote({ key: 'k', author: '', at: at(1), text: '', file: { id: 'f-1', name: 'a\nhttps://evil.example/y' } }, 'q', () => 't')
  expect(file.split('\n\n')[0].split('\n').every((l) => l.startsWith('> '))).toBe(true)
})

test('a quoted message with a file link shows the link as its name, never its address (TC-ask2-4)', async () => {
  signIn()
  serve(null)
  const seed = { key: 'k-link', author: 'acme', at: at(1), text: 'Draft quote: [deal-2026-11-22.docx](/files/view?path=users%2Fjunho%2Fdeal-2026-11-22.docx) **ready**' }
  const m = await mount(<MemoryRouter><SideChatPanel roomId={team.id} roomTitle="Marketing" seed={seed} onClose={() => {}} /></MemoryRouter>)
  try {
    await m.until(() => !!m.find('side-chat-quote'), 'the message quoted')
    const shown = m.get('side-chat-quote-text').textContent!
    expect(shown).toBe('Draft quote: deal-2026-11-22.docx ready')
    expect(shown).not.toContain('/files/view')
  } finally {
    await m.unmount()
  }
})

test('"Ask Trina about this": the panel opens with the message quoted; a quick button sends it with its question (a failed send keeps the quote); ✕ takes the quote off', async () => {
  signIn()
  const { made } = serve(null)
  const seed = { key: 'k1', author: 'acme', at: at(1), text: '5. cloud side: owner-recovery-claimed' }
  const m = await mount(<MemoryRouter><SideChatPanel roomId={team.id} roomTitle="Marketing" seed={seed} onClose={() => {}} /></MemoryRouter>)
  try {
    await m.until(() => !!m.find('side-chat-empty'), 'the panel')
    expect(m.get('side-chat-quote').textContent).toContain('owner-recovery-claimed')
    expect(m.get('side-chat-input').getAttribute('placeholder')).toBe(en('sideChat.placeholderQuoted', { name: aiName((k) => en(k)) }))
    await m.click('side-chat-quick-translate')
    await m.until(() => calls.some((c) => c.path === `/api/chats/${made}/messages`), 'the question sent')
    const body = calls.find((c) => c.path === `/api/chats/${made}/messages`)!.body as { content: string }
    expect(body.content.startsWith('> acme · ')).toBe(true)
    expect(body.content).toContain('> 5. cloud side: owner-recovery-claimed')
    expect(body.content.endsWith(SIDE_CHAT_QUICK.translate.ask.en)).toBe(true)
    // (this fake server refuses the send: the quote comes back with the failure, for a second try)
    await m.until(() => !!m.find('side-chat-quote'), 'the quote back after the failed send')
  } finally {
    await m.unmount()
  }
  const m2 = await mount(<MemoryRouter><SideChatPanel roomId={team.id} roomTitle="Marketing" seed={{ ...seed, key: 'k2' }} onClose={() => {}} /></MemoryRouter>)
  try {
    await m2.until(() => !!m2.find('side-chat-quote'), 'the quote')
    await m2.click('side-chat-quote-remove')
    expect(m2.find('side-chat-quote')).toBeNull()
  } finally {
    await m2.unmount()
  }
})

test('a message offers "Ask Trina about this" only where the room gives it (not an event line, not a deleted one)', async () => {
  signIn()
  const asked: string[] = []
  const msgs = [message({ roomId: team.id, seq: 1, author: BEN, body: 'please translate' }), message({ roomId: team.id, seq: 2, author: BEN, body: '', deletedAt: at(1) })]
  const m = await mount(<MemoryRouter><RoomMessages roomId={team.id} messages={msgs} pending={[]} meId={ME.id} members={[ME, BEN]} onAskTrina={(x) => asked.push(x.id)} /></MemoryRouter>)
  try {
    const buttons = m.container.ownerDocument!.body.querySelectorAll('[data-testid="message-ask-trina"]')
    expect(buttons).toHaveLength(1)
    // the mark without a circle (AiMark), as in the room header: no grey circle of a person without a photo
    expect(buttons[0]!.querySelector('[data-testid="ai-face"]')).toBeNull()
    const mark = buttons[0]!.querySelector('svg')!
    expect(mark.getAttribute('width')).toBe(PRODUCT_NAMED_AFTER_AI ? '22' : '18')
    expect(mark.hasAttribute('data-trina-star')).toBe(PRODUCT_NAMED_AFTER_AI)
    await m.click(buttons[0]!)
    expect(asked).toEqual([msgs[0]!.id])
  } finally {
    await m.unmount()
  }
  const none = await mount(<MemoryRouter><RoomMessages roomId={team.id} messages={msgs} pending={[]} meId={ME.id} members={[ME, BEN]} /></MemoryRouter>)
  try {
    expect(none.find('message-ask-trina')).toBeNull()
  } finally {
    await none.unmount()
  }
})

test('an empty side chat says what it looks at, offers Catch up / Anything for me? / Summarize, and that the AI can be wrong', async () => {
  signIn()
  const { made } = serve(null)
  const m = await mount(<MemoryRouter><SideChatPanel roomId={team.id} roomTitle="Marketing" onClose={() => {}} /></MemoryRouter>)
  try {
    await m.until(() => !!m.find('side-chat-empty'), 'the panel')
    expect(m.get('side-chat-context').textContent).toBe(en('sideChat.context', { room: 'Marketing' }))
    expect(m.get('side-chat-disclaimer').textContent).toBe(en('chat.footerAi'))
    expect(['catchUp', 'forMe', 'summarize'].map((k) => m.get(`side-chat-starter-${k}`).textContent)).toEqual([en('sideChat.starterLabel.catchUp'), en('sideChat.starterLabel.forMe'), en('sideChat.starterLabel.summarize')])
    await m.click('side-chat-starter-forMe')
    await m.until(() => calls.some((c) => c.path === `/api/chats/${made}/messages`), 'the question sent')
    expect((calls.find((c) => c.path === `/api/chats/${made}/messages`)!.body as { content: string }).content).toBe(en('sideChat.starter.forMe'))
  } finally {
    await m.unmount()
  }
})

test('a file of the room: quoted by name and id (the AI opens it with room_file), with the file questions', async () => {
  expect(withQuote({ key: 'k', author: '', at: at(1), text: '', file: { id: 'f-1', name: 'quote.pdf' } }, 'Summarize this file.', () => 't'))
    .toBe('> 📎 quote.pdf (file_id f-1 in this room)\n\nSummarize this file.')
  signIn()
  serve(null)
  const seed = { key: 'kf', author: '', at: at(1), text: '', file: { id: 'f-1', name: 'quote.pdf' } }
  const m = await mount(<MemoryRouter><SideChatPanel roomId={team.id} roomTitle="Marketing" seed={seed} onClose={() => {}} /></MemoryRouter>)
  try {
    await m.until(() => !!m.find('side-chat-quote-file'), 'the file quoted')
    expect(m.get('side-chat-quote-file').textContent).toContain('quote.pdf')
    // the box asks about the file, not "this message"
    const name = aiName((k) => en(k))
    expect(m.get('side-chat-input').getAttribute('placeholder')).toBe(en('sideChat.placeholderQuotedFile', { name }))
    expect(m.get('side-chat-input').getAttribute('aria-label')).toBe(en('sideChat.placeholderQuotedFile', { name }))
    expect(en('sideChat.placeholderQuotedFile', { name })).not.toBe(en('sideChat.placeholderQuoted', { name }))
    for (const k of ['fileSummarize', 'fileKeyPoints', 'fileCheck', 'fileSave']) expect(m.find(`side-chat-quick-${k}`)).not.toBeNull()
    expect(m.find('side-chat-quick-translate')).toBeNull()
    // 팀 폴더에 저장: through the AI (save_room_file and its card), as a question with the file quoted
    expect(m.get('side-chat-quick-fileSave').textContent).toBe(SIDE_CHAT_QUICK.fileSave.label.en)
    await m.click('side-chat-quick-fileSave')
    await m.until(() => calls.some((c) => c.method === 'POST' && /^\/api\/chats\/[^/]+\/messages$/.test(c.path)), 'the question sent')
    expect((calls.find((c) => c.method === 'POST' && /^\/api\/chats\/[^/]+\/messages$/.test(c.path))!.body as { content: string }).content).toBe(`> 📎 quote.pdf (file_id f-1 in this room)\n\n${SIDE_CHAT_QUICK.fileSave.ask.en}`)
  } finally {
    await m.unmount()
  }
})

test('the asks: a message by who wrote it (the AI by its name), a file by its id and name', () => {
  const m = message({ roomId: team.id, seq: 1, author: BEN, body: 'the plan' })
  expect(messageSeed(m, 'Trina')).toMatchObject({ author: BEN.name, at: m.createdAt, text: 'the plan' })
  expect(messageSeed({ ...m, authorKind: 'ai', author: null }, 'Trina').author).toBe('Trina')
  const a = fileSeed('f-1', 'acme.pdf')
  expect(a).toMatchObject({ author: '', text: '', file: { id: 'f-1', name: 'acme.pdf' } })
  // each ask its own key: the same file asked about again is quoted again
  expect(a.key.startsWith('f-1:')).toBe(true)
})

test('"Ask Trina about this file" reaches the room page that listens, only for its room', () => {
  const heard: string[] = []
  const off = onAskTrinaInRoom((a) => heard.push(`${a.roomId}:${a.seed.file?.name}`))
  expect(askTrinaInRoom('r1', { key: 'k', author: '', at: at(1), text: '', file: { id: 'f', name: 'a.pdf' } })).toBe(true)
  off()
  expect(askTrinaInRoom('r1', { key: 'k2', author: '', at: at(1), text: '' })).toBe(false)
  expect(heard).toEqual(['r1:a.pdf'])
})

test('📎 attaches a file into the side chat: a chip with its size and ✕; sent, its id goes with the question and the message shows it', async () => {
  signIn()
  const id = uuidv7()
  serve(id, [], UNSEEN)
  const m = await mount(<MemoryRouter><SideChatPanel roomId={team.id} roomTitle="Marketing" onClose={() => {}} /></MemoryRouter>)
  try {
    await m.until(() => !!m.find('side-chat-open-full'), 'the chat found')
    expect(m.get('side-chat-attach').getAttribute('aria-label')).toBe(en('composer.attach'))
    await pick(m, [pdf()])
    await m.until(() => chips(m)[0]?.getAttribute('data-status') === 'done', 'the file attached')
    // uploaded into this side chat (the person's own attachments, as in any chat of theirs)
    expect(uploads).toEqual([{ chatId: id, name: 'acme-brief.pdf' }])
    expect(chips(m)[0]!.textContent).toContain('acme-brief.pdf')
    expect(chips(m)[0]!.querySelector(`[aria-label="${en('composer.removeAttachment', { name: 'acme-brief.pdf' })}"]`)).not.toBeNull()
    // a file may go alone
    expect(m.get('side-chat-send').hasAttribute('disabled')).toBe(false)
    await m.type('side-chat-input', 'what does it say?')
    await m.click('side-chat-send')
    await m.until(() => sentTo(id), 'the question sent')
    expect(sentTo(id)!.body).toMatchObject({ content: 'what does it say?', attachmentIds: [attached[0]!.id] })
    // the file left the box and shows in the message
    expect(chips(m)).toHaveLength(0)
    expect(m.get('user-message').textContent).toContain('acme-brief.pdf')
  } finally {
    await m.unmount()
  }
})

test('a file alone with the thread\'s chip on: the thread line goes with it; ✕ on the chip and it goes as a file alone', async () => {
  signIn()
  const id = uuidv7()
  serve(id, [], UNSEEN)
  const beside = { rootId: root.id, author: BEN.name, at: root.createdAt }
  const m = await mount(<MemoryRouter><SideChatPanel roomId={team.id} roomTitle="Marketing" onClose={() => {}} thread={beside} /></MemoryRouter>)
  try {
    await m.until(() => !!m.find('side-chat-open-full'), 'the chat found')
    expect(m.find('side-chat-thread-chip')).not.toBeNull()
    await pick(m, [pdf()])
    await m.until(() => chips(m)[0]?.getAttribute('data-status') === 'done', 'the file attached')
    await m.click('side-chat-send')
    await m.until(() => sentTo(id), 'the file sent')
    expect(sentTo(id)!.body).toMatchObject({ content: withThread(beside, '', (iso) => formatDateTime(iso, 'en')), attachmentIds: [attached[0]!.id] })
    // the bubble: the thread's mark and the file, no line
    expect(m.get('user-quote-thread').textContent).toContain(BEN.name)
    expect(m.get('user-message').textContent).toContain('acme-brief.pdf')
    expect((m.get('user-message').textContent ?? '').includes('thread_id')).toBe(false)
  } finally {
    await m.unmount()
  }
})

test('a picture pasted into the box shows as itself at once (not pasted as text); ✕ takes it out; a dropped file is attached too', async () => {
  signIn()
  const id = uuidv7()
  serve(id, [], UNSEEN)
  // the upload is held: the tile shows while it uploads
  answerUpload = (name, chatId, size) => (name === 'image.png' ? null : answerAttachment(name, chatId, size))
  const m = await mount(<MemoryRouter><SideChatPanel roomId={team.id} roomTitle="Marketing" onClose={() => {}} /></MemoryRouter>)
  try {
    await m.until(() => !!m.find('side-chat-open-full'), 'the chat found')
    const e = await paste(m, [png()])
    expect(e.defaultPrevented).toBe(true)
    await m.until(() => chips(m).length === 1, 'the tile')
    expect(chips(m)[0]!.getAttribute('data-status')).toBe('uploading')
    expect(chips(m)[0]!.querySelector('[data-testid="chip-thumb"]')).not.toBeNull()
    // nothing goes while a file is still uploading
    await m.type('side-chat-input', 'what is this?')
    expect(m.get('side-chat-send').hasAttribute('disabled')).toBe(true)
    await m.click(chips(m)[0]!.querySelector(`[aria-label="${en('composer.removeAttachment', { name: 'image.png' })}"]`)! as FakeElement)
    expect(chips(m)).toHaveLength(0)
    // its upload stops
    expect(xhrs[0]!.aborted).toBe(true)
    expect(m.get('side-chat-send').hasAttribute('disabled')).toBe(false)
    // text pasted is the box's own (nothing attached, the browser pastes it)
    expect((await paste(m, [])).defaultPrevented).toBe(false)
    // a file dropped anywhere on the panel
    const drop = Object.assign(new FakeEvent('drop', { bubbles: true, cancelable: true }), { dataTransfer: { types: ['Files'], files: [pdf('acme-drop.pdf')], getData: () => '' } })
    m.get('side-chat-scroller').dispatchEvent(drop)
    await m.until(() => chips(m)[0]?.getAttribute('data-status') === 'done', 'the dropped file attached')
    expect(drop.defaultPrevented).toBe(true)
    expect(uploads.map((u) => u.name)).toEqual(['image.png', 'acme-drop.pdf'])
  } finally {
    await m.unmount()
  }
})

// docs/decisions/20261118-audit2-web-limits.md: the box took 20,000 characters and cut a longer paste without a word
test('a paste past what a message holds goes in as a text file, never cut; the box itself has no 20,000 limit', async () => {
  signIn()
  const id = uuidv7()
  serve(id, [], UNSEEN)
  const m = await mount(<MemoryRouter><SideChatPanel roomId={team.id} roomTitle="Marketing" onClose={() => {}} /></MemoryRouter>)
  try {
    await m.until(() => !!m.find('side-chat-open-full'), 'the chat found')
    expect(m.get('side-chat-input').getAttribute('maxlength')).toBeNull()
    const pasteText = async (text: string) => {
      const e = Object.assign(new FakeEvent('paste', { bubbles: true, cancelable: true }), { clipboardData: { files: [], items: [], getData: (k: string) => (k === 'text/plain' ? text : '') } })
      m.get('side-chat-input').dispatchEvent(e)
      await m.settle()
      return e
    }
    // 50,000 characters: the box's own text, as the full chat's box (the browser pastes it)
    expect((await pasteText('a'.repeat(50_000))).defaultPrevented).toBe(false)
    expect(chips(m)).toHaveLength(0)
    // past 200,000: every character goes in as a file, and the person is told
    const long = 'b'.repeat(MESSAGE_TEXT_MAX + 1)
    expect((await pasteText(long)).defaultPrevented).toBe(true)
    await m.until(() => chips(m)[0]?.getAttribute('data-status') === 'done', 'the text file attached')
    expect(uploads.map((u) => u.name)).toEqual([`${en('composer.pastedTextName')}.txt`])
    expect(useUi.getState().toasts.map((t) => t.text)).toContain(en('composer.pastedAsFile', { max: MESSAGE_TEXT_MAX.toLocaleString('en') }))
  } finally {
    await m.unmount()
  }
})

test('an upload that fails says why on its chip and is not sent; too many files say the limit', async () => {
  signIn()
  const id = uuidv7()
  serve(id, [], UNSEEN)
  answerUpload = (name, chatId, size) => (name === 'huge.pdf' ? { status: 413, body: { error: { code: 'payload_too_large', message: 'The file is too large.' } } } : answerAttachment(name, chatId, size))
  const m = await mount(<MemoryRouter><SideChatPanel roomId={team.id} roomTitle="Marketing" onClose={() => {}} /></MemoryRouter>)
  try {
    await m.until(() => !!m.find('side-chat-open-full'), 'the chat found')
    await pick(m, [pdf('huge.pdf'), pdf()])
    await m.until(() => chips(m).every((c) => c.getAttribute('data-status') !== 'uploading'), 'both done')
    const failed = chips(m).find((c) => c.getAttribute('data-status') === 'failed')!
    expect(failed.textContent).toContain('huge.pdf')
    expect(failed.querySelector('[role="alert"]')!.textContent).toContain('The file is too large.')
    await m.type('side-chat-input', 'compare them')
    await m.click('side-chat-send')
    await m.until(() => sentTo(id), 'the question sent')
    // only the one that made it
    expect(sentTo(id)!.body!.attachmentIds).toEqual([attached[0]!.id])
    expect(attached[0]!.name).toBe('acme-brief.pdf')
    // the failed one stays, with its reason, until it is taken out
    expect(chips(m).map((c) => c.getAttribute('data-status'))).toEqual(['failed'])
    // more than a message takes: the first ones, and the limit said
    await pick(m, Array.from({ length: MESSAGE_ATTACHMENTS_MAX + 1 }, (_, i) => pdf(`acme-${i}.pdf`)))
    expect(m.get('side-chat-file-error').textContent).toBe(en('composer.tooMany', { n: MESSAGE_ATTACHMENTS_MAX }))
    expect(chips(m).filter((c) => c.getAttribute('data-status') !== 'failed')).toHaveLength(MESSAGE_ATTACHMENTS_MAX)
    await m.until(() => chips(m).every((c) => c.getAttribute('data-status') !== 'uploading'), 'all done')
  } finally {
    await m.unmount()
  }
})

test('no side chat yet: the first file makes one of the room and goes into it; a starter goes alone; "New chat" drops the files', async () => {
  signIn()
  const { made } = serve(null)
  const m = await mount(<MemoryRouter><SideChatPanel roomId={team.id} roomTitle="Marketing" onClose={() => {}} /></MemoryRouter>)
  try {
    await m.until(() => !!m.find('side-chat-empty'), 'the empty line')
    await paste(m, [png()])
    await m.until(() => chips(m)[0]?.getAttribute('data-status') === 'done', 'the picture attached')
    expect(calls.find((c) => c.method === 'POST' && c.path === '/api/chats')!.body).toMatchObject({ sideRoomId: team.id })
    expect(calls.filter((c) => c.method === 'POST' && c.path === '/api/chats')).toHaveLength(1)
    expect(uploads).toEqual([{ chatId: made, name: 'image.png' }])
    // the panel shows the chat made for it; with nothing in it yet it is a new chat already
    await m.until(() => !!m.find('side-chat-open-full'), 'the chat shown')
    expect(m.get('side-chat-new').hasAttribute('disabled')).toBe(true)
    // a starter's question goes alone and leaves the picture in the box
    await m.click('side-chat-starter-forMe')
    await m.until(() => sentTo(made), 'the starter sent')
    expect(sentTo(made)!.body!.attachmentIds).toEqual([])
    expect(chips(m)).toHaveLength(1)
    // another chat: the picture was uploaded into this one, so it goes
    await m.click('side-chat-new')
    await m.until(() => chips(m).length === 0, 'the files dropped')
  } finally {
    await m.unmount()
  }
})

test('two panels of a room show the same files', async () => {
  signIn()
  const id = uuidv7()
  serve(id, [], UNSEEN)
  const m = await mount(
    <MemoryRouter>
      <div data-testid="page"><SideChatPanel roomId={team.id} roomTitle="Marketing" onClose={() => {}} /></div>
      <div data-testid="viewer"><SideChatPanel roomId={team.id} roomTitle="Marketing" frame={false} autoFocus={false} onClose={() => {}} /></div>
    </MemoryRouter>,
  )
  const inBoth = () => [m.get('page'), m.get('viewer')].map((p) => p.querySelectorAll('[data-testid="attachment-chip"]').length)
  try {
    await m.until(() => m.container.ownerDocument!.body.querySelectorAll('[data-testid="side-chat-open-full"]').length === 2, 'the chat found in both')
    const input = m.get('viewer').querySelector('[data-testid="side-chat-file-input"]')!
    Object.assign(input, { files: [pdf()] })
    input.dispatchEvent(new FakeEvent('change', { bubbles: true }))
    await m.until(() => inBoth().every((n) => n === 1) && chips(m).every((c) => c.getAttribute('data-status') === 'done'), 'the file in both')
    // taken out in one, gone from both
    await m.click(m.get('page').querySelector(`[aria-label="${en('composer.removeAttachment', { name: 'acme-brief.pdf' })}"]`)!)
    expect(inBoth()).toEqual([0, 0])
  } finally {
    await m.unmount()
  }
})

test('the first question and a file at the same moment make one side chat, and both go into it', async () => {
  signIn()
  const { made } = serve(null)
  // the side chat is still being made when the picture comes
  const inner = globalThis.fetch
  let release!: () => void
  const held = new Promise<void>((r) => (release = r))
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if ((init?.method ?? 'GET') === 'POST' && new URL(String(input), 'http://team.localhost').pathname === '/api/chats') await held
    return inner(input, init)
  }) as typeof fetch
  const m = await mount(<MemoryRouter><SideChatPanel roomId={team.id} roomTitle="Marketing" onClose={() => {}} /></MemoryRouter>)
  try {
    await m.until(() => !!m.find('side-chat-empty'), 'the empty line')
    await m.type('side-chat-input', 'what did I miss?')
    await m.click('side-chat-send')
    await paste(m, [png()])
    release()
    await m.until(() => sentTo(made), 'the question sent')
    await m.until(() => chips(m)[0]?.getAttribute('data-status') === 'done', 'the picture attached')
    expect(calls.filter((c) => c.method === 'POST' && c.path === '/api/chats')).toHaveLength(1)
    expect(uploads).toEqual([{ chatId: made, name: 'image.png' }])
    // the question went alone (the picture came after it) and the picture waits for the next one
    expect(sentTo(made)!.body!.attachmentIds).toEqual([])
  } finally {
    await m.unmount()
  }
})

test('while the AI waits for the answer to its question, the box answers with its text alone; the files stay for the next message', async () => {
  signIn()
  const id = uuidv7()
  serve(id, [], { newest: { waiting: true } })
  const m = await mount(<MemoryRouter><SideChatPanel roomId={team.id} roomTitle="Marketing" onClose={() => {}} /></MemoryRouter>)
  try {
    await m.until(() => !!m.find('side-chat-open-full'), 'the chat found')
    await pick(m, [pdf()])
    await m.until(() => chips(m)[0]?.getAttribute('data-status') === 'done', 'the file attached')
    useChats.setState({ requests: { q1: { turnId: 'turn-1', chatId: id, messageId: 'a1', request: { kind: 'ask_user', requestId: 'q1', question: 'Which meeting?', allowText: true } } } } as never)
    await m.until(() => m.get('side-chat-send').getAttribute('aria-label') === en('sideChat.answer'), 'the answer button')
    // files alone do not answer it
    expect(m.get('side-chat-send').hasAttribute('disabled')).toBe(true)
    await m.type('side-chat-input', 'the client meeting')
    await m.click('side-chat-send')
    await m.until(() => calls.some((c) => c.path === '/api/turns/turn-1/answer'), 'the answer sent')
    expect(calls.find((c) => c.path === '/api/turns/turn-1/answer')!.body).toEqual({ kind: 'ask_user', requestId: 'q1', answer: 'the client meeting' })
    expect(sentTo(id)).toBeUndefined()
    expect(chips(m)).toHaveLength(1)
  } finally {
    await m.unmount()
  }
})

test('another side chat from 🕘 drops the files (they were uploaded into the one shown)', async () => {
  signIn()
  const id = uuidv7(), old = uuidv7()
  serve(id, [old], UNSEEN)
  const m = await mount(<MemoryRouter><SideChatPanel roomId={team.id} roomTitle="Marketing" onClose={() => {}} /></MemoryRouter>)
  try {
    await m.until(() => !!m.find('side-chat-open-full'), 'the chat found')
    await pick(m, [pdf()])
    await m.until(() => chips(m)[0]?.getAttribute('data-status') === 'done', 'the file attached')
    await m.click('side-chat-history')
    await m.until(() => !!m.find('side-chat-history-list'), 'the list')
    await m.click(m.container.ownerDocument!.body.querySelectorAll('[data-testid="side-chat-history-item"]')[1]!)
    await m.until(() => chips(m).length === 0, 'the files dropped')
    // the chat that was open again: nothing comes back
    await m.click('side-chat-history')
    await m.until(() => !!m.find('side-chat-history-list'), 'the list')
    await m.click(m.container.ownerDocument!.body.querySelectorAll('[data-testid="side-chat-history-item"]')[0]!)
    await m.settle()
    expect(chips(m)).toHaveLength(0)
  } finally {
    await m.unmount()
  }
})

// ---------------- opened again: a new chat (docs/DECISIONS.md "The side chat opens on a new chat") ----------------
const body = (m: Mounted) => m.container.ownerDocument!.body
const count = (m: Mounted, testId: string) => body(m).querySelectorAll(`[data-testid="${testId}"]`).length
const answerDone = (m: Mounted) => !!body(m).querySelector('[data-testid="assistant-message"][data-status="done"]')
const boxText = (m: Mounted) => (m.get('side-chat-input') as unknown as { value: string }).value
/** ✦ in the room header, and the panel's chat drawn (a new one, or one kept) */
async function openSide(m: Mounted) {
  await m.click('room-side-chat-button')
  await m.until(() => !!m.find('side-chat-panel') && !m.find('side-chat-history-list') && !body(m).querySelector('[data-testid="side-chat-panel"] [aria-label="' + en('common.loading') + '"]'), 'the side chat')
}
async function askInSide(m: Mounted, text: string) {
  const before = count(m, 'user-message')
  await m.type('side-chat-input', text)
  await m.click('side-chat-send')
  await m.until(() => count(m, 'user-message') === before + 1 && !!m.find('side-chat-open-full'), 'the question in its chat')
}
const fresh = (m: Mounted) => !!m.find('side-chat-empty') && !!m.find('side-chat-starters') && count(m, 'user-message') === 0 && !m.find('side-chat-open-full')

test('the room page: ✦, a question, ✕, ✦: a new empty chat (nothing made for it), the asked one in 🕘; ✦ to close and leaving the room do the same', async () => {
  signIn()
  const { made } = serve(null, [], { turns: true })
  useRooms.setState({ rooms: [team], loaded: true })
  const m = await roomPage()
  try {
    await m.until(() => !!m.find('room-message'), 'the room')
    await openSide(m)
    expect(fresh(m)).toBe(true)
    await askInSide(m, 'what did I miss?')
    answerEnds(made)
    await m.until(() => answerDone(m), 'the answer')
    // ✕, then ✦: a new chat, its starters; opening it made nothing
    await m.click('side-chat-close')
    expect(m.find('side-chat-panel')).toBeNull()
    await openSide(m)
    expect(fresh(m)).toBe(true)
    expect(m.get('side-chat-new').hasAttribute('disabled')).toBe(true)
    expect(calls.filter((c) => c.method === 'POST' && c.path === '/api/chats')).toHaveLength(1)
    // 🕘: the one asked, which opens with its question and answer
    await m.click('side-chat-history')
    await m.until(() => count(m, 'side-chat-history-item') === 1, 'the list')
    await m.click('side-chat-history-item')
    await m.until(() => count(m, 'user-message') === 1 && answerDone(m), 'the asked chat')
    // ✦ closes it, ✦ opens a new one
    await m.click('room-side-chat-button')
    expect(m.find('side-chat-panel')).toBeNull()
    await openSide(m)
    expect(fresh(m)).toBe(true)
    // the old one again from 🕘, then the room left with it open
    await m.click('side-chat-history')
    await m.until(() => count(m, 'side-chat-history-item') === 1, 'the list')
    await m.click('side-chat-history-item')
    await m.until(() => count(m, 'user-message') === 1, 'the asked chat')
  } finally {
    await m.unmount()
  }
  const back = await roomPage()
  try {
    await back.until(() => !!back.find('room-message'), 'the room again')
    expect(back.find('side-chat-panel')).toBeNull()
    await openSide(back)
    expect(fresh(back)).toBe(true)
  } finally {
    await back.unmount()
  }
})

test('an answer still on its way when it closes: ✦ shows that chat; one that ended while closed and is not seen, too; seen, the next ✦ is new', async () => {
  signIn()
  const { made } = serve(null, [], { turns: true })
  useRooms.setState({ rooms: [team], loaded: true })
  const m = await roomPage()
  try {
    await m.until(() => !!m.find('room-message'), 'the room')
    await openSide(m)
    await askInSide(m, 'summarize the launch thread')
    expect(answerDone(m)).toBe(false)
    await m.click('side-chat-close')
    // running: the same chat, its answer still coming (nothing more can be asked meanwhile)
    await openSide(m)
    expect(count(m, 'user-message')).toBe(1)
    expect(m.find('side-chat-open-full')).not.toBeNull()
    expect(m.get('side-chat-new').hasAttribute('disabled')).toBe(true)
    await m.click('side-chat-close')
    // it ends while the panel is closed: not seen
    answerEnds(made, { unseen: true })
    await openSide(m)
    await m.until(() => count(m, 'user-message') === 1 && answerDone(m), 'the answer shown')
    // seen now: the server's word (after the /seen of the chat on screen, store/sessionMarkers.ts)
    act(() => {
      const row = useChats.getState().chats.find((c) => c.id === made)!
      const { unseen: _, ...seen } = row
      useChats.getState().handleEvent({ type: 'chat.updated', seq: 3, at: 0, data: { chatId: made, change: 'updated', chat: seen } } as ServerEvent)
    })
    await m.click('side-chat-close')
    await openSide(m)
    expect(fresh(m)).toBe(true)
  } finally {
    await m.unmount()
  }
})

test('what was typed or attached when it closed stays for this page\'s session, with the chat it was going into', async () => {
  signIn()
  const { made } = serve(null, [], { turns: true })
  useRooms.setState({ rooms: [team], loaded: true })
  const m = await roomPage()
  try {
    await m.until(() => !!m.find('room-message'), 'the room')
    await openSide(m)
    await askInSide(m, 'who sends the drafts?')
    answerEnds(made)
    await m.until(() => answerDone(m), 'the answer')
    // a follow-up typed, not sent: the same chat and the text
    await m.type('side-chat-input', 'and by when?')
    await m.click('side-chat-close')
    await openSide(m)
    expect(count(m, 'user-message')).toBe(1)
    expect(boxText(m)).toBe('and by when?')
    // the box emptied: the next opening is new
    await m.type('side-chat-input', '')
    await m.click('side-chat-close')
    await openSide(m)
    expect(fresh(m)).toBe(true)
    // a new chat's draft stays in it; a file attached keeps the chat it was uploaded into
    await pick(m, [pdf()])
    await m.until(() => chips(m)[0]?.getAttribute('data-status') === 'done', 'the file attached')
    const into = uploads[0]!.chatId
    expect(into).not.toBe(made)
    await m.click('side-chat-close')
    await openSide(m)
    expect(chips(m)).toHaveLength(1)
    expect(useSideChats.getState().byRoom[team.id]!.chatId).toBe(into)
    // the file taken out: that chat has nothing in it, a new chat already, so it stays (no empty one left in 🕘)
    await m.click(m.get(`side-chat-box`).querySelector(`[aria-label="${en('composer.removeAttachment', { name: 'acme-brief.pdf' })}"]`)!)
    await m.click('side-chat-close')
    await openSide(m)
    expect(!!m.find('side-chat-empty') && !!m.find('side-chat-starters') && count(m, 'user-message') === 0).toBe(true)
    expect(useSideChats.getState().byRoom[team.id]!.chatId).toBe(into)
    await pick(m, [pdf('second.pdf')])
    await m.until(() => uploads.length === 2, 'the second file')
    expect(uploads[1]!.chatId).toBe(into)
    expect(calls.filter((c) => c.method === 'POST' && c.path === '/api/chats')).toHaveLength(2)
  } finally {
    await m.unmount()
  }
})

test('"Ask Trina about this" on a message after the side chat was closed: a new empty chat with the message quoted', async () => {
  signIn()
  const { made } = serve(null, [], { turns: true })
  useRooms.setState({ rooms: [team], loaded: true })
  const m = await roomPage()
  try {
    await m.until(() => !!m.find('room-message'), 'the room')
    await openSide(m)
    await askInSide(m, 'what did I miss?')
    answerEnds(made)
    await m.until(() => answerDone(m), 'the answer')
    await m.click('side-chat-close')
    await m.click('message-ask-trina')
    await m.until(() => !!m.find('side-chat-quote'), 'the message quoted')
    expect(m.get('side-chat-quote').textContent).toContain('logo drafts by Friday?')
    expect(count(m, 'user-message')).toBe(0)
    expect(m.find('side-chat-empty')).not.toBeNull()
    expect(m.find('side-chat-open-full')).toBeNull()
    // its quick questions, not the starters
    expect(m.find('side-chat-starters')).toBeNull()
    expect(m.find('side-chat-quick-summarize')).not.toBeNull()
    // closed without asking: the next ✦ is new, its starters, no quote left over
    await m.click('side-chat-close')
    await openSide(m)
    expect(fresh(m)).toBe(true)
    expect(m.find('side-chat-quote')).toBeNull()
  } finally {
    await m.unmount()
  }
})

test('a thread beside the side chat: both show; the box\'s chip names the thread and a question carries its line; ✕ takes it off; the thread closing leaves the chat open', async () => {
  signIn()
  const { made } = serve(null, [], { turns: true })
  useRooms.setState({ rooms: [team], loaded: true })
  const m = await roomPage()
  const sent = () => calls.filter((c) => c.method === 'POST' && /^\/api\/chats\/[^/]+\/messages$/.test(c.path)).map((c) => (c.body as { content: string }).content)
  try {
    await m.until(() => !!m.find('room-message'), 'the room')
    await openSide(m)
    // no thread: no chip, the room's line and starters
    expect(m.find('side-chat-thread-chip')).toBeNull()
    expect(m.find('side-chat-context')).not.toBeNull()
    expect(m.find('side-chat-starter-catchUp')).not.toBeNull()
    expect(m.get('side-chat-intro').textContent).toBe(en('sideChat.empty', { name: aiName((k) => en(k)) }))
    // a thread opens: the side chat stays beside it (docs/decisions/20261117-thread-plus-trina.md), its box says so
    await act(async () => { await go(`/rooms/${team.id}/t/${root.id}`) })
    await m.until(() => !!m.find('room-thread') && !!m.find('side-chat-thread-chip'), 'the thread beside the side chat, its chip in the box')
    expect(m.find('side-chat-panel')).not.toBeNull()
    expect(m.get('side-chat-thread-chip').textContent).toBe(en('sideChat.threadChip'))
    expect(m.get('side-chat-thread-chip-off').getAttribute('aria-label')).toBe(en('sideChat.threadChipOff'))
    expect(m.get('side-chat-input').getAttribute('placeholder')).toBe(en('sideChat.placeholderThread', { name: aiName((k) => en(k)) }))
    // one line says what is looked at, and the one starter is the thread's
    expect(m.find('side-chat-context')).toBeNull()
    expect(m.find('side-chat-starter-catchUp')).toBeNull()
    expect(m.get('side-chat-starter-thread').textContent).toBe(en('roomApps.chipThread'))
    // the intro line says thread too (and conversation again once the chip is off: below, after an answer, it is gone)
    expect(m.get('side-chat-intro').textContent).toBe(en('sideChat.emptyThread', { name: aiName((k) => en(k)) }))
    // a question with the chip on: the thread line on top (who started it, when, its id), no message text
    await askInSide(m, 'what was decided?')
    expect(sent().at(-1)).toBe(withThread({ rootId: root.id, author: BEN.name, at: root.createdAt }, 'what was decided?', (iso) => formatDateTime(iso, 'en')))
    expect(sent().at(-1)!.split('\n')).toEqual([expect.stringMatching(new RegExp(`^> 🧵 ${BEN.name} · .+ \\(thread_id ${root.id} in this room\\)$`)), '', 'what was decided?'])
    // its bubble: the "Thread" mark, never the line
    const bubble = m.get('user-text').textContent ?? ''
    expect(m.get('user-quote-thread').textContent).toContain(`${en('rooms.thread')} · ${BEN.name}`)
    expect(bubble).toContain('what was decided?')
    expect(bubble.includes('thread_id') || bubble.includes('🧵')).toBe(false)
    answerEnds(made)
    await m.until(() => answerDone(m), 'the answer')
    // ✕: no chip, the room's placeholder, and the next question goes as typed
    await m.click('side-chat-thread-chip-off')
    expect(m.find('side-chat-thread-chip')).toBeNull()
    expect(useSideChats.getState().byRoom[team.id]!.chipOff).toBe(root.id)
    expect(m.get('side-chat-input').getAttribute('placeholder')).toBe(en('sideChat.placeholder', { name: aiName((k) => en(k)) }))
    await askInSide(m, 'and in the room?')
    expect(sent().at(-1)).toBe('and in the room?')
    answerEnds(made)
    // the thread closed: the side chat is still there, the same chat; the chip's ✕ is forgotten with the thread
    await act(async () => { await go(`/rooms/${team.id}`) })
    await m.until(() => !m.find('room-thread'), 'the thread closed')
    expect(m.find('side-chat-panel')).not.toBeNull()
    expect(count(m, 'user-message')).toBe(2)
    expect(useSideChats.getState().byRoom[team.id]!.chipOff).toBeNull()
    // opened again: the chip is back
    await act(async () => { await go(`/rooms/${team.id}/t/${root.id}`) })
    await m.until(() => !!m.find('side-chat-thread-chip'), 'the chip again')
    // a quoted message takes the chip's place while it shows
    await m.click('message-ask-trina')
    await m.until(() => !!m.find('side-chat-quote'), 'the message quoted')
    expect(m.find('side-chat-thread-chip')).toBeNull()
    expect(m.find('room-thread')).not.toBeNull()
    await m.click('side-chat-quote-remove')
    expect(m.find('side-chat-thread-chip')).not.toBeNull()
    // ✦ closes the side chat; the thread stays
    await m.click('room-side-chat-button')
    expect(m.find('side-chat-panel')).toBeNull()
    expect(m.find('room-thread')).not.toBeNull()
  } finally {
    await m.unmount()
  }
})

test('after a reload: a side chat with messages kept waiting in this browser opens again with them (QA TC-4912)', async () => {
  signIn()
  const id = uuidv7()
  serve(id)
  const q = msg({ chatId: id, role: 'user', content: 'what was decided?' })
  turns[id] = [q, msg({ chatId: id, role: 'assistant', parentId: q.id, status: 'done', content: 'Wednesday.' })]
  localStorage.setItem(`mycel.queue:${ME.id}:${id}`, JSON.stringify({ v: 1, items: [{ id: uuidv7(), content: 'and who does it?', attachments: [], author: { id: ME.id, name: ME.name }, createdAt: at(2), lead: withThread({ rootId: root.id, author: BEN.name, at: root.createdAt }, '', () => 't').trimEnd() }], paused: null, after: null }))
  const m = await mount(<MemoryRouter><SideChatPanel roomId={team.id} roomTitle="Marketing" onClose={() => {}} /></MemoryRouter>)
  try {
    // not a new chat: the one they wait in, the message under it with its thread; it waits for "Send now" (typed long ago)
    await m.until(() => !!m.find('outbox-item'), 'the waiting message')
    expect(m.find('side-chat-empty')).toBeNull()
    expect(m.get('outbox-item').querySelector('[data-testid="user-quote-thread"]')).not.toBeNull()
    expect(m.find('outbox-send-now')).not.toBeNull()
    await m.click('outbox-send-now')
    await m.until(() => !!sentTo(id), 'sent')
    expect((sentTo(id)!.body as { content: string }).content).toBe(withThread({ rootId: root.id, author: BEN.name, at: root.createdAt }, 'and who does it?', () => 't'))
  } finally {
    await m.unmount()
    useSendQueue.getState().reset()
    localStorage.clear()
  }
})

test('sent while an answer runs: the message waits under the chat with the thread it was about, can be edited, stays when the panel closes and opens again, and goes with its thread line when the answer ends (QA TC-4912)', async () => {
  signIn()
  const { made } = serve(null, [], { turns: true })
  useRooms.setState({ rooms: [team], loaded: true })
  const m = await roomPage()
  const sent = () => calls.filter((c) => c.method === 'POST' && /^\/api\/chats\/[^/]+\/messages$/.test(c.path)).map((c) => (c.body as { content: string }).content)
  const time = (iso: string) => formatDateTime(iso, 'en')
  const beside = { rootId: root.id, author: BEN.name, at: root.createdAt }
  try {
    await m.until(() => !!m.find('room-message'), 'the room')
    await openSide(m)
    await act(async () => { await go(`/rooms/${team.id}/t/${root.id}`) })
    await m.until(() => !!m.find('side-chat-thread-chip'), 'the thread chip')
    await askInSide(m, 'what was decided?')
    // the answer runs: send is "send when the answer is done", not off
    await m.type('side-chat-input', 'and who does it?')
    expect(m.get('side-chat-input').getAttribute('placeholder')).toBe(en('outbox.placeholder'))
    expect(m.get('side-chat-send').hasAttribute('disabled')).toBe(false)
    expect(m.get('side-chat-send').getAttribute('aria-label')).toBe(en('outbox.sendLater'))
    await m.click('side-chat-send')
    await m.until(() => !!m.find('outbox-item'), 'the message waiting')
    expect(sent()).toHaveLength(1)
    expect(boxText(m)).toBe('')
    expect(m.get('outbox-status').textContent).toContain(en('outbox.waitingOne'))
    // the thread it was about shows on it, as on the sent bubble
    expect(m.get('outbox-item').querySelector('[data-testid="user-quote-thread"]')).not.toBeNull()
    expect(m.get('outbox-text').textContent).toContain('and who does it?')
    expect(m.get('outbox-text').textContent!.includes('thread_id')).toBe(false)
    // edited: the text alone (the thread stays on it)
    await m.click('outbox-edit')
    expect((m.get('outbox-edit-input') as unknown as { value: string }).value).toBe('and who does it?')
    await m.type('outbox-edit-input', 'and who does it by Friday?')
    await m.click('outbox-save')
    await m.until(() => !m.find('outbox-edit-input'), 'the edit saved')
    // closed and opened again while the answer runs: the same chat, the message still waiting (kept in this browser too)
    await m.click('side-chat-close')
    await m.until(() => !m.find('side-chat-panel'), 'the side chat closed')
    expect(localStorage.getItem(`mycel.queue:${ME.id}:${made}`)).toContain('and who does it by Friday?')
    await act(async () => { await go(`/rooms/${team.id}`) })
    await openSide(m)
    await m.until(() => !!m.find('outbox-item'), 'the message still waiting')
    expect(sent()).toHaveLength(1)
    // the answer ends: it goes by itself, under the thread it was asked about, though that thread is closed now
    answerEnds(made)
    await m.until(() => sent().length === 2, 'the waiting message sent')
    expect(sent()[1]).toBe(withThread(beside, 'and who does it by Friday?', time))
    await m.until(() => !m.find('outbox-item'), 'nothing waiting')
    expect(localStorage.getItem(`mycel.queue:${ME.id}:${made}`)).toBeNull()
  } finally {
    await m.unmount()
    useSendQueue.getState().reset()
    localStorage.clear()
  }
})

/** the file viewer's column (components/ImageViewer.tsx keeps its state for one opening of the viewer): ✦ in its bar
 * asks about the file */
function ViewerHarness() {
  const column = useViewerColumn(team.id)
  return (
    <>
      <button type="button" data-testid="viewer-ask" onClick={() => column.ask(fileSeed('f-1', 'acme-brief.pdf'))} />
      <ViewerColumn place={{ roomId: team.id, fileId: 'f-1', messageId: root.id }} state={column.state} onAsk={column.ask} onThread={column.toThread} onHide={column.hide} />
    </>
  )
}

test('the file viewer: ✦ is a new chat with the file quoted; "스레드로 돌아가기" and ✦ again keep it; closing the viewer on it closes it, unless the room page has it open', async () => {
  signIn()
  const { made } = serve(null, [], { turns: true })
  useRooms.setState({ rooms: [team], loaded: true })
  const v = await mount(<MemoryRouter><ViewerHarness /></MemoryRouter>)
  const shows = () => v.get('viewer-column').getAttribute('data-show')
  try {
    await v.until(() => shows() === 'thread', 'the file\'s thread')
    await v.click('viewer-ask')
    await v.until(() => shows() === 'trina' && !!v.find('side-chat-empty'), 'the side chat')
    expect(v.get('side-chat-quote-file').textContent).toContain('acme-brief.pdf')
    expect(count(v, 'user-message')).toBe(0)
    await askInSide(v, 'when is the launch?')
    answerEnds(made)
    await v.until(() => answerDone(v), 'the answer')
    // the thread, then ✦ again: the same chat, the file quoted again
    await v.click('viewer-column-back')
    await v.until(() => shows() === 'thread', 'the thread again')
    await v.click('viewer-ask')
    await v.until(() => shows() === 'trina' && count(v, 'user-message') === 1 && answerDone(v), 'the same chat')
    expect(v.find('side-chat-quote-file')).not.toBeNull()
    await v.click('side-chat-quote-remove')
    // back on the thread when the viewer closes: it showed the side chat, so that closes too
    await v.click('viewer-column-back')
    await v.until(() => shows() === 'thread', 'the thread again')
  } finally {
    await v.unmount()
  }
  expect(useSideChats.getState().byRoom[team.id]!.open).toBe(false)
  // ✦ on the room page afterwards: a new chat
  const p = await mount(<MemoryRouter><SideChatPanel roomId={team.id} roomTitle="Marketing" onClose={() => {}} /></MemoryRouter>)
  try {
    await p.until(() => !!p.find('side-chat-empty'), 'the panel')
    expect(fresh(p)).toBe(true)
    await askInSide(p, 'and the budget?')
    // the room page has it open: the viewer starts on it, the same chat, and closing the viewer leaves it open
    useRooms.getState().setSide(team.id, 'trina')
    const v2 = await mount(<MemoryRouter><ViewerHarness /></MemoryRouter>)
    try {
      await v2.until(() => v2.get('viewer-column').getAttribute('data-show') === 'trina' && v2.get('viewer-column').querySelectorAll('[data-testid="user-message"]').length === 1, 'the same chat beside the file')
    } finally {
      await v2.unmount()
    }
    expect(useSideChats.getState().byRoom[team.id]!.open).toBe(true)
    expect(count(p, 'user-message')).toBe(1)
  } finally {
    await p.unmount()
  }
})

test('a first read that cannot reach the server: the calm notice; a chat the person opens meanwhile stays (the notice goes, no read takes it away)', async () => {
  signIn()
  useSideChats.setState(useSideChats.getInitialState())
  const old = uuidv7()
  serve(uuidv7(), [old], UNSEEN)
  const served = globalThis.fetch
  let down = true
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://team.localhost')
    if (down && (init?.method ?? 'GET') === 'GET' && u.pathname === '/api/chats') throw new TypeError('Failed to fetch')
    return served(input, init)
  }) as typeof fetch
  const m = await mount(<MemoryRouter><SideChatPanel roomId={team.id} roomTitle="Marketing" onClose={() => {}} /></MemoryRouter>)
  try {
    await m.until(() => m.find('load-error'), 'the notice')
    expect(m.get('load-error').getAttribute('data-what')).toBe('side-chat')
    expect(m.get('load-error').getAttribute('data-state')).toBe('connection')
    expect(m.container.ownerDocument!.body.querySelector('[role="alert"]')).toBeNull()
    // the connection is back; before the notice reads again, the person opens an older side chat from 🕘
    down = false
    await m.click('side-chat-history')
    await m.until(() => !!m.find('side-chat-history-list'), 'the list')
    const items = m.container.ownerDocument!.body.querySelectorAll('[data-testid="side-chat-history-item"]')
    await m.click(items[1]!)
    await m.until(() => sideChatOf(useSideChats.getState(), team.id).chatId === old, 'the chosen chat')
    expect(m.find('load-error')).toBeNull()
    await m.settle(2_500)
    expect(sideChatOf(useSideChats.getState(), team.id).chatId).toBe(old)
  } finally {
    await m.unmount()
  }
}, 10_000)

/** a computer's window (min-width 768 px matches) while `fn` runs; the test DOM is a phone otherwise */
async function onComputer<T>(fn: () => Promise<T>): Promise<T> {
  const was = window.matchMedia
  Object.assign(window, { matchMedia: (q: string) => ({ matches: q.includes('min-width'), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }) })
  try { return await fn() } finally { Object.assign(window, { matchMedia: was }) }
}
const queueOne = (chatId: string) => localStorage.setItem(`mycel.queue:${ME.id}:${chatId}`, JSON.stringify({ v: 1, items: [{ id: uuidv7(), content: 'and who does it?', attachments: [], author: { id: ME.id, name: ME.name }, createdAt: at(2) }], paused: null, after: null }))

test('a reload (QA TC-4963): on a computer the side chat opens by itself when a message of mine waits in it, with that message', async () => {
  signIn()
  const id = uuidv7()
  serve(id)
  const q = msg({ chatId: id, role: 'user', content: 'what was decided?' })
  turns[id] = [q, msg({ chatId: id, role: 'assistant', parentId: q.id, status: 'done', content: 'Wednesday.' })]
  queueOne(id)
  useRooms.setState({ rooms: [team], loaded: true })
  resetSideChatOpenForTest()
  await onComputer(async () => {
    const m = await roomPage()
    try {
      await m.until(() => !!m.find('side-chat-panel') && !!m.find('outbox-item'), 'the side chat, open by itself, with the waiting message')
      expect(m.get('room-side-chat-button').getAttribute('aria-pressed')).toBe('true')
    } finally {
      await m.unmount()
      useSendQueue.getState().reset()
      localStorage.clear()
    }
  })
})

test('a reload (QA TC-4963): nothing waits and it was closed: it stays closed, and the server is not asked for the side chat', async () => {
  signIn()
  serve(uuidv7())
  useRooms.setState({ rooms: [team], loaded: true })
  resetSideChatOpenForTest()
  await onComputer(async () => {
    const m = await roomPage()
    try {
      await m.until(() => !!m.find('room-message'), 'the room')
      await m.settle()
      expect(m.find('side-chat-panel')).toBeNull()
      expect(calls.some((c) => c.path === '/api/chats' && c.search.includes('sideRoomId'))).toBe(false)
    } finally { await m.unmount() }
  })
})

test('a reload (QA TC-4963): open before it, it is open after it, on a phone too; closing it, or leaving the room, keeps it closed the next time', async () => {
  signIn()
  serve(null)
  useRooms.setState({ rooms: [team], loaded: true })
  // the tab had it open: what the room page wrote before the reload
  keepSideChatOpen(ME.id, team.id, true)
  resetSideChatOpenForTest()
  const m = await roomPage()
  try {
    await m.until(() => !!m.find('side-chat-panel'), 'the side chat, open again (a phone)')
    // ✕ closes it: not kept for the next reload
    await m.click('room-side-chat-button')
    await m.until(() => !m.find('side-chat-panel'), 'closed')
    expect(sessionStorage.getItem(`mycel.sideChatOpen.${ME.id}`)).toBeNull()
    // ✦ opens it: kept; leaving the room closes it and forgets it
    await openSide(m)
    expect(JSON.parse(sessionStorage.getItem(`mycel.sideChatOpen.${ME.id}`) ?? '[]')).toEqual([team.id])
  } finally { await m.unmount() }
  expect(sessionStorage.getItem(`mycel.sideChatOpen.${ME.id}`)).toBeNull()
})

test('a phone (QA TC-4963): a waiting message alone does not cover the room with the side chat; ✦ opens it on that chat', async () => {
  signIn()
  const id = uuidv7()
  serve(id)
  turns[id] = [msg({ chatId: id, role: 'user', content: 'what was decided?' })]
  queueOne(id)
  useRooms.setState({ rooms: [team], loaded: true })
  resetSideChatOpenForTest()
  const m = await roomPage()
  try {
    await m.until(() => !!m.find('room-message'), 'the room')
    await m.settle()
    expect(m.find('side-chat-panel')).toBeNull()
    await m.click('room-side-chat-button')
    await m.until(() => !!m.find('outbox-item'), 'the side chat on the chat the message waits in')
  } finally {
    await m.unmount()
    useSendQueue.getState().reset()
    localStorage.clear()
  }
})

test('while my answer runs, the box has Stop (답변 멈추기) as the full chat\'s box: it stops the turn, then send is back', async () => {
  signIn()
  const { made } = serve(null, [], { turns: true })
  // the server's Stop (POST /api/chats/:id/stop): the chat's running turn stops
  const served = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://team.localhost')
    if (init?.method === 'POST' && u.pathname === `/api/chats/${made}/stop`) {
      calls.push({ method: 'POST', path: u.pathname, search: '', body: undefined })
      return new Response(JSON.stringify({ stopped: true, turnId: turns[made]!.at(-1)!.turnId }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return served(input, init)
  }) as typeof fetch
  const m = await mount(<MemoryRouter><SideChatPanel roomId={team.id} roomTitle="Marketing" onClose={() => {}} /></MemoryRouter>)
  try {
    await m.until(() => !!m.find('side-chat-empty'), 'the empty line')
    // no answer running: no Stop
    expect(m.find('side-chat-stop')).toBeNull()
    await m.type('side-chat-input', 'summarize this room')
    await m.click('side-chat-send')
    await m.until(() => !!m.find('side-chat-stop'), 'Stop while the answer runs')
    const stop = m.get('side-chat-stop')
    expect(stop.getAttribute('aria-label')).toBe(en('composer.stop'))
    expect(stop.querySelector('svg')!.getAttribute('class')).toContain('lucide-square')
    // nothing typed: only Stop at the end of the row (no greyed send); typed, the clock that waits for the answer too
    expect(m.find('side-chat-send')).toBeNull()
    const order = [...m.get('side-chat-tools').querySelectorAll('[data-testid]')].map((e) => e.getAttribute('data-testid'))
    expect(order.at(-1)).toBe('side-chat-stop')
    await m.type('side-chat-input', 'and the files?')
    expect(m.get('side-chat-send').getAttribute('aria-label')).toBe(en('outbox.sendLater'))
    expect(m.find('side-chat-stop')).not.toBeNull()
    await m.type('side-chat-input', '')
    await m.click('side-chat-stop')
    await m.until(() => calls.some((c) => c.method === 'POST' && c.path === `/api/chats/${made}/stop`), 'the stop sent')
    // the turn ends as stopped (message.done): Stop goes, send is back
    const a = turns[made]!.at(-1)!
    const stopped = { ...a, status: 'stopped' as const }
    turns[made] = [...turns[made]!.slice(0, -1), stopped]
    act(() => useChats.getState().handleEvent({ type: 'message.done', seq: 1, at: 0, data: { chatId: made, messageId: a.id, status: 'stopped', message: stopped } } as ServerEvent))
    await m.until(() => !m.find('side-chat-stop'), 'Stop gone once stopped')
    expect(m.get('side-chat-send').getAttribute('aria-label')).toBe(en('sideChat.send'))
  } finally {
    await m.unmount()
  }
})

test('Stop that fails: the reason as the panel\'s other errors, and Stop stays to press again', async () => {
  signIn()
  const { made } = serve(null, [], { turns: true })
  const served = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://team.localhost')
    if (init?.method === 'POST' && u.pathname === `/api/chats/${made}/stop`) {
      calls.push({ method: 'POST', path: u.pathname, search: '', body: undefined })
      return new Response(JSON.stringify({ error: { code: 'forbidden', message: 'Not yours to stop' } }), { status: 403, headers: { 'content-type': 'application/json' } })
    }
    return served(input, init)
  }) as typeof fetch
  useUi.setState({ toasts: [] })
  const m = await mount(<MemoryRouter><SideChatPanel roomId={team.id} roomTitle="Marketing" onClose={() => {}} /></MemoryRouter>)
  try {
    await m.until(() => !!m.find('side-chat-empty'), 'the empty line')
    await m.type('side-chat-input', 'summarize this room')
    await m.click('side-chat-send')
    await m.until(() => !!m.find('side-chat-stop'), 'Stop while the answer runs')
    await m.click('side-chat-stop')
    await m.until(() => useUi.getState().toasts.some((x) => x.text === 'Not yours to stop'), 'the error said')
    await m.until(() => m.get('side-chat-stop').hasAttribute('disabled') === false, 'Stop again')
  } finally {
    await m.unmount()
  }
})

test('a draft kept for an older side chat (opened from 🕘) waits after a reload: the new chat that opens does not erase it, and it comes back in that chat', async () => {
  signIn()
  const newest = uuidv7()
  const older = uuidv7()
  serve(newest, [older])
  const key = `mycel.draft:${ME.id}:side:${team.id}`
  const kept = JSON.stringify({ chatId: older, text: 'half a question' })
  localStorage.setItem(key, kept)
  const m = await mount(<MemoryRouter><SideChatPanel roomId={team.id} roomTitle="Marketing" onClose={() => {}} /></MemoryRouter>)
  try {
    // the newest chat is done: a new chat opens, its box empty, the older chat's draft still kept
    await m.until(() => !!m.find('side-chat-empty'), 'a new chat')
    await m.settle()
    expect(boxText(m)).toBe('')
    expect(localStorage.getItem(key)).toBe(kept)
    // opened from 🕘: the draft is back in its chat
    await m.click('side-chat-history')
    await m.until(() => m.container.ownerDocument!.body.querySelectorAll('[data-testid="side-chat-history-item"]').length === 2, 'the list')
    await m.click(m.container.ownerDocument!.body.querySelectorAll('[data-testid="side-chat-history-item"]')[1]!)
    await m.until(() => boxText(m) === 'half a question', 'the draft back')
  } finally {
    await m.unmount()
    localStorage.removeItem(key)
  }
})
