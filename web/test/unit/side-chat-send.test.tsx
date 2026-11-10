// One click from a room's side chat (components/rooms/SendHere.tsx, lib/sideChatSend.ts, docs/DECISIONS.md "Trina side
// chat: send here"). The thread token in a question's quote (shared rooms.ts threadRefToken): written by withQuote only
// for a message that can have a thread, read from the first line only, hidden where the question shows (its copy and
// edit too; an edit keeps it while the quote's header stays). Which answer goes where: the nearest earlier question that
// quotes something (a follow-up keeps the thread; a file or a message without a thread is the room; an older chat
// without tokens is the room only). The control: "Send to room", or "Send to thread" with ▾ for the room; one click
// sends at once (one request however many clicks while it goes), then "✓ Sent to … · View" with the focus on View and
// a status line, kept for the session; the server's "confirm" opens only the confirm step with the target, 취소 gives
// the focus back; a thread that is gone is one line under the answer and the room is offered; ids per click (reused
// only for the confirm and a try again after no answer); never in a confidential chat; no toast.
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { hideThreadRef, SIDE_CHAT_SEND, threadRefOf, threadRefToken, uuidv7, type Me } from '@mycel/shared/api'
import { AssistantMessage, UserMessage } from '../../src/components/chat/Messages'
import { SideChatPanel, withQuote } from '../../src/components/rooms/SideChatPanel'
import type { SentHere } from '../../src/components/rooms/SendHere'
import { translate, useLocaleStore } from '../../src/i18n'
import { messageSeed } from '../../src/lib/sideChatAsk'
import { keepThreadRef, quotedOf, sendTargets, type SendTarget } from '../../src/lib/sideChatSend'
import { useChats } from '../../src/store/chats'
import { useRooms } from '../../src/store/rooms'
import { useSession } from '../../src/store/session'
import { useSideChats } from '../../src/store/sideChats'
import { useUi } from '../../src/store/ui'
import { FakeEvent, installDom, mount, removeDom, type FakeElement, type Mounted } from './dom-host'
import { CHAT, msg } from './fixtures'
import { at, BEN, ME, message, room } from './rooms-fixtures'

const en = (k: Parameters<typeof translate>[1], p?: Record<string, string | number>) => translate('en', k, p)
const locale = useLocaleStore.getState().locale
const status = useSession.getState().status
const realFetch = globalThis.fetch

beforeAll(() => { installDom(); useLocaleStore.setState({ locale: 'en' }) })
afterEach(() => {
  globalThis.fetch = realFetch
  useSession.setState({ status })
  useRooms.getState().reset()
  useUi.setState({ toasts: [] })
})
afterAll(() => { removeDom(); useLocaleStore.setState({ locale }) })

const ROOT = uuidv7()
const ROOT2 = uuidv7()
const time = () => 'Nov 5, 9:00 AM'

// ---------------- the token ----------------
test('the token: at the end of the quote\'s header line only; read from the first line; hidden where people read it', () => {
  const q = `> Ben · Nov 5, 9:00 AM${threadRefToken(ROOT)}\n> logo drafts by Friday?\n\nOne line, please`
  expect(threadRefOf(q)).toBe(ROOT)
  expect(hideThreadRef(q)).toBe('> Ben · Nov 5, 9:00 AM\n> logo drafts by Friday?\n\nOne line, please')
  // only the first line, only a quote, only a real id
  expect(threadRefOf(`hello\n> Ben · Nov 5${threadRefToken(ROOT)}`)).toBeNull()
  expect(threadRefOf(`Ben · Nov 5${threadRefToken(ROOT)}`)).toBeNull()
  expect(threadRefOf('> Ben · Nov 5 (thread_id not-an-id in this room)')).toBeNull()
  expect(threadRefOf(`> Ben · Nov 5${threadRefToken(ROOT)} and more`)).toBeNull()
  // a question without one is as it was
  expect(hideThreadRef('> Ben · Nov 5\n> hi\n\nq')).toBe('> Ben · Nov 5\n> hi\n\nq')
  expect(quotedOf(q)).toEqual({ head: 'Ben · Nov 5, 9:00 AM', text: 'logo drafts by Friday?' })
  expect(quotedOf('no quote')).toBeNull()
})

test('withQuote writes it only for a message that can have a thread (messageSeed): its own id, or its thread\'s first message', () => {
  const base = { roomId: uuidv7(), seq: 3, author: BEN, body: 'logo drafts by Friday?' }
  const own = message({ ...base, id: ROOT })
  expect(messageSeed(own, 'Trina').thread).toBe(ROOT)
  expect(withQuote(messageSeed(own, 'Trina'), 'One line, please', time)).toBe(`> Ben · Nov 5, 9:00 AM${threadRefToken(ROOT)}\n> logo drafts by Friday?\n\nOne line, please`)
  // a reply: its thread's first message
  expect(messageSeed(message({ ...base, threadRootId: ROOT2 }), 'Trina').thread).toBe(ROOT2)
  // a private AI preview, an event line: none, and the quote is as before
  const preview = message({ ...base, authorKind: 'ai', author: null, visibility: 'private' })
  expect(messageSeed(preview, 'Trina').thread).toBeUndefined()
  expect(withQuote(messageSeed(preview, 'Trina'), 'q', time)).toBe('> Trina · Nov 5, 9:00 AM\n> logo drafts by Friday?\n\nq')
  expect(messageSeed(message({ ...base, event: { type: 'renamed', name: 'x' } }), 'Trina').thread).toBeUndefined()
  // a file ask: room only (none)
  expect(withQuote({ key: 'k', author: '', at: at(1), text: '', file: { id: 'f-1', name: 'brief.pdf' } }, 'q', time)).toBe('> 📎 brief.pdf (file_id f-1 in this room)\n\nq')
})

// ---------------- which answer goes where ----------------
const q = (id: string, content: string) => ({ id, role: 'user', content })
const a = (id: string) => ({ id, role: 'assistant', content: 'answer' })
const quoteOf = (root: string | null, text: string) => `> Ben · Nov 5${root ? threadRefToken(root) : ''}\n> ${text}\n\nsummarize`

test('the nearest earlier question that quotes something decides; a follow-up keeps its thread; a file or no token is the room', () => {
  const t = sendTargets([
    a('a0'),
    q('q1', quoteOf(ROOT, 'logo drafts?')), a('a1'),
    q('q2', 'shorter'), a('a2'),
    q('q3', '> 📎 brief.pdf (file_id f-1 in this room)\n\nsummarize'), a('a3'),
    q('q4', 'shorter'), a('a4'),
    q('q5', quoteOf(ROOT2, 'budget?')), a('a5'),
    q('q6', quoteOf(null, 'a private preview')), a('a6'),
    q('q7', 'and again'), a('a7'),
  ])
  const root = (id: string) => t.get(id)?.rootId ?? null
  expect([...t.keys()]).toEqual(['a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7'])
  expect(['a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7'].map(root)).toEqual([null, ROOT, ROOT, null, null, ROOT2, null, null])
  expect(t.get('a2')).toEqual({ rootId: ROOT, head: 'Ben · Nov 5', text: 'logo drafts?' })
  // an older chat: quotes without tokens are the room only (nothing guessed from their text)
  const old = sendTargets([q('q1', '> Ben · Nov 5\n> logo drafts?\n\nsummarize'), a('a1'), q('q2', 'shorter'), a('a2')])
  expect([...old.values()]).toEqual([null, null])
  // regenerate: another answer to the same question (the branch shows it in place of the first) goes the same way
  expect(sendTargets([q('q1', quoteOf(ROOT, 'x')), a('a1-again')]).get('a1-again')?.rootId).toBe(ROOT)
})

test('an edit keeps the token while the quote\'s header line is the same; a quote rewritten or taken out leaves it', () => {
  const original = quoteOf(ROOT, 'logo drafts?')
  const shown = hideThreadRef(original)
  expect(keepThreadRef(shown.replace('summarize', 'summarize in Korean'), original)).toBe(original.replace('summarize', 'summarize in Korean'))
  expect(keepThreadRef('> Ben · Nov 6\n> logo drafts?\n\nsummarize', original)).toBe('> Ben · Nov 6\n> logo drafts?\n\nsummarize')
  expect(keepThreadRef('just a question', original)).toBe('just a question')
  expect(keepThreadRef('> Ben · Nov 5', original)).toBe(`> Ben · Nov 5${threadRefToken(ROOT)}`)
  expect(keepThreadRef('anything', 'no token here')).toBe('anything')
})

test('a question about a message shows it as a quote (who, when, its lines), then the question: no Markdown, no token; the edit keeps the token', async () => {
  const content = quoteOf(ROOT, 'logo drafts?')
  const edited: string[] = []
  const m = await mount(<MemoryRouter><UserMessage m={{ ...msg({ role: 'user', content }), branch: { index: 0, count: 1, siblings: [] } } as never} chatId={CHAT} busy={false} onEdit={(_m, text) => { edited.push(text) }} onSelectBranch={() => {}} sideChat /></MemoryRouter>)
  try {
    const quote = m.get('user-quote')
    expect(quote.localName).toBe('blockquote')
    expect(m.get('user-quote-head').textContent).toBe('Ben Nov 5')
    expect(m.get('user-quote-text').textContent).toBe('logo drafts?')
    expect(m.get('user-text').textContent).toBe('Ben Nov 5logo drafts?summarize')
    expect(m.html()).not.toContain('thread_id')
    expect(m.html()).not.toContain('&gt; ')
    await m.click('edit-message')
    expect((m.get('edit-input') as unknown as { value: string }).value).toBe(hideThreadRef(content))
    await m.type('edit-input', hideThreadRef(content).replace('summarize', 'shorter'))
    await m.click('edit-send')
    expect(edited).toEqual([content.replace('summarize', 'shorter')])
  } finally {
    await m.unmount()
  }
})

// ---------------- the control ----------------
const team = room({ name: 'Design review', memberCount: 4, activityAt: at(5) })
const signIn = () => useSession.setState({ status: { kind: 'signed-in', me: { user: { id: ME.id, name: ME.name }, server: { allChatsConfidential: false } } as unknown as Me } })
let calls: { body: Record<string, unknown> }[] = []
/** answers to POST …/share-to-room, in order (the last one repeats); 'network': no answer; 'hold': waits for release(),
 * then sent; 'hold-network': waits for release(), then no answer */
let answers: ({ status?: number; body: unknown } | 'network' | 'hold' | 'hold-network')[] = []
let release: () => void = () => {}
const sent = (o: { threadRootId?: string; cut?: boolean } = {}) => ({ status: 'sent', cut: !!o.cut, message: message({ roomId: team.id, seq: 20, author: ME, body: 'answer', sharedAnswer: { at: 0, cut: !!o.cut }, ...(o.threadRootId ? { threadRootId: o.threadRootId } : {}) }) })
const confirmAnswer = { status: 'confirm', people: 3, places: [], otherPlaces: false, files: [{ name: 'logo-v2.png', path: 'users/ada/logo-v2.png', missing: false, attach: 'yes', unable: 3 }], provenance: null, confirmKey: 'k1' }
function serve() {
  calls = []
  let n = 0
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://team.localhost').pathname
    const json = (body: unknown, s = 200) => new Response(JSON.stringify(body), { status: s, headers: { 'content-type': 'application/json' } })
    if (init?.method === 'POST' && path.endsWith('/share-to-room')) {
      calls.push({ body: JSON.parse(String(init.body)) })
      const x = answers[Math.min(n++, answers.length - 1)]!
      if (x === 'network') throw new TypeError('Failed to fetch')
      if (x === 'hold' || x === 'hold-network') {
        await new Promise<void>((r) => { release = r })
        if (x === 'hold-network') throw new TypeError('Failed to fetch')
        return json(sent())
      }
      return json(x.body, x.status ?? 200)
    }
    return json({ error: { code: 'not_found', message: 'not here' } }, 404)
  }) as typeof fetch
}

/** a side chat's finished answer with the control (and a text box beside it: `other`); `views`: what 보기 was asked to open */
async function answerWith(target: SendTarget | null, o: { shareable?: boolean; id?: string } = {}) {
  signIn()
  useRooms.setState({ rooms: [team], loaded: true })
  const views: SentHere[] = []
  const m = await mount(
    <MemoryRouter>
      <input data-testid="other" />
      <AssistantMessage m={msg({ id: o.id ?? uuidv7(), role: 'assistant', content: 'Wednesday, two drafts.', status: 'done' })} chatId={CHAT} isLast busy={false} switchedFrom={null} onRegenerate={() => {}} onSelectBranch={() => {}} onAskOwnFolder={() => {}} shareable={o.shareable ?? true} canSuggest={false}
        sendHere={{ roomId: team.id, target, onView: (s) => views.push(s) }} />
    </MemoryRouter>,
  )
  return { m, views }
}
const thread: SendTarget = { rootId: ROOT, head: 'Ben · Nov 5, 9:00 AM', text: 'logo drafts by Friday?' }
const body = (m: Mounted) => m.container.ownerDocument!.body
const active = (m: Mounted) => m.container.ownerDocument!.activeElement
const dialogTitle = (m: Mounted) => body(m).querySelector('[role="dialog"]')!.querySelector('h2')!.textContent

test('no thread: "Send to room" sends at once; then "✓ Sent to room · View", the focus on View, said; View opens it; no toast', async () => {
  serve()
  answers = [{ body: sent() }]
  const { m, views } = await answerWith(null)
  try {
    expect(m.get('send-here-room').textContent).toBe(SIDE_CHAT_SEND.room.en)
    expect(m.find('send-here-thread')).toBeNull()
    expect(m.find('send-here-more')).toBeNull()
    expect(m.find('share-to-room')).toBeNull()
    await m.click('send-here-room')
    await m.until(() => m.find('send-here-sent'), 'the sent line')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.body).toEqual({ roomId: team.id, clientMessageId: expect.any(String) })
    expect(m.get('send-here-sent').textContent).toBe(`${en('sideChat.sentRoom')}·${en('sideChat.view')}`)
    expect(m.get('send-here-status').getAttribute('role')).toBe('status')
    expect(m.get('send-here-status').textContent).toBe(en('sideChat.sentRoom'))
    await m.until(() => active(m) === m.get('send-here-view'), 'the focus on View')
    // no picker, no toast
    expect(body(m).querySelector('[data-testid="share-room-list"]')).toBeNull()
    expect(useUi.getState().toasts).toEqual([])
    await m.click('send-here-view')
    expect(views).toEqual([{ to: 'room', roomId: team.id, rootId: null, messageId: expect.any(String), cut: false }])
  } finally {
    await m.unmount()
  }
})

test('a thread: "Send to thread" sends there; cut says so; ▾ has one item, "Send to room"; many clicks while it goes are one send', async () => {
  serve()
  answers = ['hold']
  const { m } = await answerWith(thread)
  try {
    expect(m.get('send-here-thread').textContent).toBe(SIDE_CHAT_SEND.thread.en)
    expect(m.get('send-here-more').getAttribute('aria-label')).toBe(en('sideChat.sendElsewhere'))
    await m.click('send-here-thread')
    await m.click('send-here-thread')
    await m.click('send-here-thread')
    await m.settle()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.body).toEqual({ roomId: team.id, threadRootId: ROOT, clientMessageId: expect.any(String) })
    release()
    await m.until(() => m.find('send-here-sent'), 'the sent line')
    expect(m.get('send-here-sent').getAttribute('data-to')).toBe('thread')
    expect(m.get('send-here-sent').textContent).toContain(en('sideChat.sentThread'))
  } finally {
    await m.unmount()
  }
  // the room by ▾ (another answer): its one item; cut: "first part only"
  serve()
  answers = [{ body: sent({ cut: true }) }]
  const r = await answerWith(thread)
  try {
    await r.m.click('send-here-more')
    const items = body(r.m).querySelectorAll('[role="menuitem"]')
    expect(items.map((i) => i.textContent)).toEqual([SIDE_CHAT_SEND.room.en])
    await r.m.click('send-here-room-item')
    await r.m.until(() => r.m.find('send-here-sent'), 'the sent line')
    expect(calls[0]!.body).toEqual({ roomId: team.id, clientMessageId: expect.any(String) })
    expect(r.m.get('send-here-sent').getAttribute('data-to')).toBe('room')
    expect(r.m.get('send-here-sent').textContent).toContain(en('sideChat.sentRoomCut'))
  } finally {
    await r.m.unmount()
  }
})

test('the server asks first: only the confirm step, with the thread\'s message; yes sends with the same id; 취소 gives the focus back and the next click is a new id', async () => {
  serve()
  answers = [{ body: confirmAnswer }, { body: confirmAnswer }, { body: sent({ threadRootId: ROOT }) }]
  const { m } = await answerWith(thread)
  try {
    await m.click('send-here-thread')
    await m.until(() => body(m).querySelector('[data-testid="share-room-confirm"]'), 'the confirm step')
    // no list, no search, no note: the target, the file row with its switch on, the primary button focused
    expect(body(m).querySelector('[data-testid="share-room-list"]')).toBeNull()
    expect(body(m).querySelector('[data-testid="share-room-note"]')).toBeNull()
    expect(dialogTitle(m)).toBe(SIDE_CHAT_SEND.thread.en)
    expect(m.get('share-room-to').textContent).toContain('Design review')
    expect(m.get('share-room-thread').textContent).toBe('Ben · Nov 5, 9:00 AMlogo drafts by Friday?')
    expect(m.get('share-room-confirm-send').textContent).toBe(en('shareRoom.sendAttached'))
    expect(active(m)).toBe(m.get('share-room-confirm-send'))
    // 취소: closed, the focus back on the control, nothing sent
    await m.click('share-room-back')
    expect(body(m).querySelector('[data-testid="share-room-confirm"]')).toBeNull()
    await m.until(() => active(m) === m.get('send-here-thread'), 'the focus back on the control')
    // a new click: a new id; asked, then yes: the same id with the key and the file
    await m.click('send-here-thread')
    await m.until(() => body(m).querySelector('[data-testid="share-room-confirm"]'), 'the confirm step again')
    await m.click('share-room-confirm-send')
    await m.until(() => m.find('send-here-sent'), 'the sent line')
    expect(calls).toHaveLength(3)
    expect(calls[1]!.body.clientMessageId).not.toBe(calls[0]!.body.clientMessageId)
    expect(calls[2]!.body).toEqual({ roomId: team.id, threadRootId: ROOT, confirmKey: 'k1', attach: ['users/ada/logo-v2.png'], clientMessageId: calls[1]!.body.clientMessageId })
    expect(body(m).querySelector('[data-testid="share-room-confirm"]')).toBeNull()
    await m.until(() => active(m) === m.get('send-here-view'), 'the focus on View')
  } finally {
    await m.unmount()
  }
})

test('Esc closes the confirm step too', async () => {
  serve()
  answers = [{ body: confirmAnswer }]
  const { m } = await answerWith(null)
  try {
    await m.click('send-here-room')
    await m.until(() => body(m).querySelector('[data-testid="share-room-confirm"]'), 'the confirm step')
    expect(dialogTitle(m)).toBe(SIDE_CHAT_SEND.room.en)
    expect(m.find('share-room-thread')).toBeNull()
    await act(async () => { active(m)!.dispatchEvent(new FakeEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' })) })
    expect(body(m).querySelector('[data-testid="share-room-confirm"]')).toBeNull()
    await m.until(() => active(m) === m.get('send-here-room'), 'the focus back on the control')
  } finally {
    await m.unmount()
  }
})

test('a thread that is gone: one line under the answer, the room offered instead (for the session); no toast', async () => {
  serve()
  answers = [{ status: 409, body: { error: { code: 'conflict', message: 'gone', params: { reason: 'thread_root' } } } }, { body: sent() }]
  const id = uuidv7()
  const { m } = await answerWith(thread, { id })
  try {
    await m.click('send-here-thread')
    await m.until(() => m.find('send-here-error'), 'the line')
    expect(m.get('send-here-error').textContent).toBe(en('sideChat.noThread'))
    expect(m.get('send-here-error').getAttribute('role')).toBe('alert')
    expect(m.find('send-here-thread')).toBeNull()
    expect(m.get('send-here-room').textContent).toBe(SIDE_CHAT_SEND.room.en)
    expect(useUi.getState().toasts).toEqual([])
    await m.click('send-here-room')
    await m.until(() => m.find('send-here-sent'), 'sent to the room')
    expect(calls[1]!.body).toEqual({ roomId: team.id, clientMessageId: expect.any(String) })
    expect(calls[1]!.body.clientMessageId).not.toBe(calls[0]!.body.clientMessageId)
    expect(m.find('send-here-error')).toBeNull()
  } finally {
    await m.unmount()
  }
  // the panel drawn again (✦ after 보기): still sent, and the focus is left where it is
  const again = await answerWith(thread, { id })
  try {
    expect(again.m.get('send-here-sent').getAttribute('data-to')).toBe('room')
    expect(active(again.m)).not.toBe(again.m.get('send-here-view'))
  } finally {
    await again.m.unmount()
    useSideChats.getState().reset()
  }
})

test('no answer: the line says so and the next click tries the same id again; a refusal (4xx): the next click is a new id', async () => {
  serve()
  answers = ['network', { status: 429, body: { error: { code: 'rate_limited', message: 'Too many messages. Try again in 3 s.', retryAfter: 3 } } }, { body: sent() }]
  const { m } = await answerWith(null)
  try {
    await m.click('send-here-room')
    await m.until(() => m.find('send-here-error'), 'the line')
    expect(m.get('send-here-error').textContent).toBe(en('error.network'))
    await m.click('send-here-room')
    await m.until(() => m.find('send-here-error')?.textContent?.includes('Too many'), 'the refusal')
    expect(calls[1]!.body.clientMessageId).toBe(calls[0]!.body.clientMessageId)
    await m.click('send-here-room')
    await m.until(() => m.find('send-here-sent'), 'sent')
    expect(calls[2]!.body.clientMessageId).not.toBe(calls[1]!.body.clientMessageId)
    expect(useUi.getState().toasts).toEqual([])
  } finally {
    await m.unmount()
  }
})

test('never in a confidential chat (the server refuses it): no control', async () => {
  serve()
  const { m } = await answerWith(thread, { shareable: false })
  try {
    expect(m.find('send-here-thread')).toBeNull()
    expect(m.find('send-here-room')).toBeNull()
    expect(m.find('share-to-room')).toBeNull()
  } finally {
    await m.unmount()
  }
})

test('the keyboard: ▾ opens its menu, Enter on its item sends to the room', async () => {
  serve()
  answers = [{ body: sent() }]
  const { m } = await answerWith(thread)
  try {
    await m.click('send-here-more')
    const item = m.get('send-here-room-item') as FakeElement
    await m.until(() => active(m) === item, 'the item focused')
    await m.click(item)
    await m.until(() => m.find('send-here-sent'), 'sent')
    expect(calls[0]!.body.threadRootId).toBeUndefined()
  } finally {
    await m.unmount()
  }
})

test('the confirm step stays while its yes is on its way (Esc does nothing then): one message, one id', async () => {
  serve()
  answers = [{ body: confirmAnswer }, 'hold']
  const { m } = await answerWith(thread)
  try {
    await m.click('send-here-thread')
    await m.until(() => body(m).querySelector('[data-testid="share-room-confirm"]'), 'the confirm step')
    await m.click('share-room-confirm-send')
    await m.settle()
    await act(async () => { active(m)!.dispatchEvent(new FakeEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' })) })
    expect(body(m).querySelector('[data-testid="share-room-confirm"]')).not.toBeNull()
    release()
    await m.until(() => m.find('send-here-sent'), 'sent')
    expect(calls).toHaveLength(2)
    expect(calls[1]!.body.clientMessageId).toBe(calls[0]!.body.clientMessageId)
  } finally {
    await m.unmount()
  }
})

test('a panel closed while it goes and opened again: the button busy, then a try again keeps the click\'s id', async () => {
  serve()
  answers = ['hold-network', { body: sent() }]
  const id = uuidv7()
  const first = await answerWith(null, { id })
  await first.m.click('send-here-room')
  await first.m.settle()
  await first.m.unmount()
  const again = await answerWith(null, { id })
  try {
    expect(again.m.get('send-here-room').hasAttribute('disabled')).toBe(true)
    release()
    await again.m.until(() => again.m.find('send-here-error'), 'the line')
    expect(again.m.get('send-here-room').hasAttribute('disabled')).toBe(false)
    await again.m.click('send-here-room')
    await again.m.until(() => again.m.find('send-here-sent'), 'sent')
    expect(calls).toHaveLength(2)
    expect(calls[1]!.body.clientMessageId).toBe(calls[0]!.body.clientMessageId)
  } finally {
    await again.m.unmount()
    useSideChats.getState().reset()
  }
})

test('the focus stays where the person went meanwhile (the next question\'s box): not pulled to View', async () => {
  serve()
  answers = ['hold']
  const { m } = await answerWith(null)
  try {
    await m.click('send-here-room')
    m.get('other').focus()
    release()
    await m.until(() => m.find('send-here-sent'), 'sent')
    await m.settle()
    expect(active(m)).toBe(m.get('other'))
  } finally {
    await m.unmount()
  }
})

test('a long side chat after a reload: older pages are read until the question an answer follows up, so it still goes to the thread', async () => {
  signIn()
  useRooms.setState({ rooms: [team], loaded: true })
  const chatId = uuidv7()
  const [q1, a1, q2, a2] = [uuidv7(), uuidv7(), uuidv7(), uuidv7()]
  const m1 = (o: Parameters<typeof msg>[0]) => ({ ...msg(o), chatId })
  const pages: Record<string, { items: unknown[]; nextCursor: string | null }> = {
    '': { items: [m1({ id: q2, parentId: a1, role: 'user', content: 'shorter' }), m1({ id: a2, parentId: q2, role: 'assistant', content: 'Wednesday.', status: 'done' })], nextCursor: 'c1' },
    c1: { items: [m1({ id: q1, role: 'user', content: quoteOf(ROOT, 'logo drafts?') }), m1({ id: a1, parentId: q1, role: 'assistant', content: 'Wednesday, two drafts.', status: 'done' })], nextCursor: null },
  }
  const read: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://team.localhost')
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } })
    // its last answer not seen yet: the panel opens on it (else on a new chat)
    if ((init?.method ?? 'GET') === 'GET' && u.pathname === '/api/chats') return json({ items: [{ id: chatId, projectId: null, title: '', engine: 'claude-code', model: null, createdAt: at(1), updatedAt: at(1), deletedAt: null, runState: 'idle', unseen: true, sideRoomId: team.id }], nextCursor: null })
    if (u.pathname === `/api/chats/${chatId}/messages`) {
      const cursor = u.searchParams.get('cursor') ?? ''
      read.push(cursor)
      return json({ ...pages[cursor]!, activeLeafId: a2 })
    }
    return new Response(JSON.stringify({ error: { code: 'not_found', message: 'x' } }), { status: 404, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  const m = await mount(<MemoryRouter><SideChatPanel roomId={team.id} roomTitle="Design review" onClose={() => {}} /></MemoryRouter>)
  try {
    await m.until(() => body(m).querySelectorAll('[data-testid="assistant-message"]').length === 2, 'both pages')
    expect(read).toEqual(['', 'c1'])
    const answers = body(m).querySelectorAll('[data-testid="assistant-message"]')
    for (const a of answers) expect(a.querySelector('[data-testid="send-here-thread"]')).not.toBeNull()
  } finally {
    await m.unmount()
    useChats.getState().reset()
    useSideChats.getState().reset()
  }
})

test('a question about a file shows the file by its name, then the question; a quote typed by hand stays as typed', async () => {
  const file = `> 📎 brief.pdf (file_id 019a5f00-0000-7000-8000-000000000502 in this room)\n\nSummarize this file.`
  const one = await mount(<MemoryRouter><UserMessage m={{ ...msg({ role: 'user', content: file }), branch: { index: 0, count: 1, siblings: [] } } as never} chatId={CHAT} busy={false} onEdit={() => {}} onSelectBranch={() => {}} sideChat /></MemoryRouter>)
  try {
    expect(one.get('user-quote-file').textContent).toBe('brief.pdf')
    expect(one.get('user-text').textContent).toBe('brief.pdfSummarize this file.')
    expect(one.html()).not.toContain('file_id')
  } finally {
    await one.unmount()
  }
  const typed = '> to be or not to be\nthat is the question'
  const two = await mount(<MemoryRouter><UserMessage m={{ ...msg({ role: 'user', content: typed }), branch: { index: 0, count: 1, siblings: [] } } as never} chatId={CHAT} busy={false} onEdit={() => {}} onSelectBranch={() => {}} sideChat /></MemoryRouter>)
  try {
    expect(two.find('user-quote')).toBeNull()
    expect(two.get('user-text').textContent).toBe(typed)
  } finally {
    await two.unmount()
  }
})

const userMessage = (content: string, sideChat: boolean) => (
  <MemoryRouter><UserMessage m={{ ...msg({ role: 'user', content }), branch: { index: 0, count: 1, siblings: [] } } as never} chatId={CHAT} busy={false} onEdit={() => {}} onSelectBranch={() => {}} sideChat={sideChat} /></MemoryRouter>
)
const showAll = (m: Mounted) => [...m.container.querySelectorAll('button')].find((b) => b.textContent === en('chat.showAll')) ?? null

test('only a side chat shows the quote block: another chat shows the same text as it was typed', async () => {
  const content = `> Ben · Nov 5\n> logo drafts?\n\nsummarize`
  const m = await mount(userMessage(content, false))
  try {
    expect(m.find('user-quote')).toBeNull()
    expect(m.get('user-text').textContent).toBe(content)
  } finally {
    await m.unmount()
  }
})

test('a long quote is folded to its first lines, and 전체 보기 opens all of it; a short one shows whole, with no button', async () => {
  const long = Array.from({ length: 80 }, (_, i) => `line ${i + 1} of the venue's exhibitor rules, with the booth sizes and the hours`).join(' ')
  expect(long.length).toBeGreaterThan(4000 - 1000)
  const m = await mount(userMessage(`> Ben · Nov 5${threadRefToken(ROOT)}\n> ${long}\n\nshorter`, true))
  try {
    expect(m.get('user-quote-text').getAttribute('class')).toContain('line-clamp-3')
    const button = showAll(m)
    expect(button).not.toBeNull()
    await m.click(button!)
    expect(m.get('user-quote-text').getAttribute('class')).not.toContain('line-clamp-3')
    expect(m.get('user-quote-text').textContent).toBe(long)
    expect(showAll(m)).toBeNull()
  } finally {
    await m.unmount()
  }
  const short = await mount(userMessage(`> Ben · Nov 5\n> one\n> two\n> three\n> four\n> five\n\nsummarize`, true))
  try {
    expect(short.get('user-quote-text').getAttribute('class')).not.toContain('line-clamp-3')
    expect(short.get('user-quote-text').textContent).toBe('one\ntwo\nthree\nfour\nfive')
    expect(showAll(short)).toBeNull()
  } finally {
    await short.unmount()
  }
})

test('a thread found gone is gone for every answer about that message: each offers the room, other threads stay', async () => {
  serve()
  answers = [{ status: 409, body: { error: { code: 'conflict', message: 'gone', params: { reason: 'thread_root' } } } }]
  signIn()
  useRooms.setState({ rooms: [team], loaded: true })
  const other: SendTarget = { rootId: ROOT2, head: 'Cy · Nov 5', text: 'budget?' }
  const answer = (target: SendTarget, testId: string) => (
    <div data-testid={testId}>
      <AssistantMessage m={msg({ role: 'assistant', content: 'an answer', status: 'done' })} chatId={CHAT} isLast busy={false} switchedFrom={null} onRegenerate={() => {}} onSelectBranch={() => {}} onAskOwnFolder={() => {}} shareable canSuggest={false} sendHere={{ roomId: team.id, target, onView: () => {} }} />
    </div>
  )
  const m = await mount(<MemoryRouter>{answer(thread, 'first')}{answer(thread, 'second')}{answer(other, 'third')}</MemoryRouter>)
  const inside = (testId: string, id: string) => m.get(testId).querySelector(`[data-testid="${id}"]`)
  try {
    await m.click(inside('first', 'send-here-thread') as FakeElement)
    await m.until(() => inside('first', 'send-here-error'), 'the line')
    expect(inside('first', 'send-here-room')).not.toBeNull()
    expect(inside('second', 'send-here-thread')).toBeNull()
    expect(inside('second', 'send-here-room')).not.toBeNull()
    // (the line is the first answer's: the click was there)
    expect(inside('second', 'send-here-error')).toBeNull()
    expect(inside('third', 'send-here-thread')).not.toBeNull()
  } finally {
    await m.unmount()
    useSideChats.getState().reset()
  }
})
