// The room side chat (✦ Trina, components/rooms/SideChatPanel.tsx, docs/DECISIONS.md "트리나 사이드 채팅"): the panel
// opens the room's newest side chat or none; the first question makes a side chat of the room (POST /api/chats with
// sideRoomId) and sends the question there; an answer has one labelled button that sends it to the room or a thread
// (side-chat-send.test.tsx), and the same chat opened in full has the dialog with the room picked. Files go with a
// question as in the full chat's box (components/chat/ComposerFiles.tsx): 📎, paste and drop, uploaded into the side
// chat (made by the first file when there is none), shown above the box with ✕, their ids in the send body; a failed
// upload says why and is not sent.
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import { MESSAGE_ATTACHMENTS_MAX, PRODUCT_NAMED_AFTER_AI, SIDE_CHAT_QUICK, SIDE_CHAT_SEND, uuidv7, type Attachment, type Me } from '@mycel/shared/api'
import { AssistantMessage } from '../../src/components/chat/Messages'
import ShareToRoom from '../../src/components/chat/ShareToRoom'
import { SideChatPanel, withQuote } from '../../src/components/rooms/SideChatPanel'
import { askTrinaInRoom, fileSeed, messageSeed, onAskTrinaInRoom } from '../../src/lib/sideChatAsk'
import { RoomMessages } from '../../src/components/rooms/RoomMessages'
import { translate, useLocaleStore } from '../../src/i18n'
import { aiName } from '../../src/lib/tabs'
import { useChats } from '../../src/store/chats'
import { useRooms } from '../../src/store/rooms'
import { useSession } from '../../src/store/session'
import { forgetTeamAttach } from '../../src/lib/teamAttach'
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

function serve(existing: string | null, older: string[] = []) {
  calls = []
  const made = uuidv7()
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://team.localhost')
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({ method, path: u.pathname, search: u.search, body })
    const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } })
    const chat = (id: string) => ({ id, projectId: null, title: '', engine: 'claude-code', model: null, createdAt: at(1), updatedAt: at(1), deletedAt: null, runState: 'idle', sideRoomId: team.id })
    if (method === 'GET' && u.pathname === '/api/chats') return json({ items: existing ? [chat(existing), ...older.map(chat)] : [], nextCursor: null })
    if (method === 'POST' && u.pathname === '/api/chats') return json(chat(made))
    if (method === 'GET' && /^\/api\/chats\/[^/]+\/messages$/.test(u.pathname)) return json({ items: [], nextCursor: null, activeLeafId: null })
    if (method === 'POST' && /^\/api\/turns\/[^/]+\/answer$/.test(u.pathname)) return new Response(null, { status: 204 })
    return json({ error: { code: 'not_found', message: 'not here' } }, 404)
  }) as typeof fetch
  return { made }
}

test('no side chat yet: the empty line; the first question makes a side chat of the room and sends it there', async () => {
  signIn()
  const { made } = serve(null)
  const m = await mount(<MemoryRouter><SideChatPanel roomId={team.id} roomTitle="Marketing" onClose={() => {}} /></MemoryRouter>)
  try {
    await m.until(() => !!m.find('side-chat-empty'), 'the empty line')
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/api/chats' })
    expect(calls[0]!.search).toContain(`sideRoomId=${team.id}`)
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

test('the room\'s newest side chat opens again, with "open as a full chat"', async () => {
  signIn()
  const id = uuidv7()
  serve(id)
  const m = await mount(<MemoryRouter><SideChatPanel roomId={team.id} roomTitle="Marketing" onClose={() => {}} /></MemoryRouter>)
  try {
    await m.until(() => !!m.find('side-chat-open-full'), 'the chat found')
    expect(calls.some((c) => c.path === `/api/chats/${id}/messages`)).toBe(true)
    expect(calls.some((c) => c.method === 'POST')).toBe(false)
  } finally {
    await m.unmount()
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
  serve(id)
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
  serve(id, [old])
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
  serve(id)
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
    expect(m.get('side-chat-disclaimer').textContent).toBe(en('sideChat.disclaimer', { name: aiName((k) => en(k)) }))
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
  serve(id)
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

test('a picture pasted into the box shows as itself at once (not pasted as text); ✕ takes it out; a dropped file is attached too', async () => {
  signIn()
  const id = uuidv7()
  serve(id)
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

test('an upload that fails says why on its chip and is not sent; too many files say the limit', async () => {
  signIn()
  const id = uuidv7()
  serve(id)
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
  serve(id)
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
  serve(id)
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
  serve(id, [old])
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
