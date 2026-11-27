// Threads on AI answers in shared chats (docs/decisions/20261116-chat-answer-threads.md): "Reply in thread" and the
// thread's line only on a finished answer of a shared chat (the page passes onThread; a private chat and a room's ✦ side
// chat never do), never on an answer still being written, one that failed or one hidden from me. The chat thread route
// lights the Trina place in the rail, and the store puts a live change's summary on the answer.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { act } from 'react'
import { MemoryRouter } from 'react-router-dom'
import type { ChatThreadSummary } from '@mycel/shared/api'
import { AssistantMessage } from '../../src/components/chat/Messages'
import { useLocaleStore } from '../../src/i18n'
import { railOf } from '../../src/lib/rail'
import { useChats } from '../../src/store/chats'
import { useChatThreads } from '../../src/store/chatThreads'
import { emptyThread } from '../../src/store/thread'
import { CHAT, msg } from './fixtures'
import { installDom, mount, removeDom } from './dom-host'

const locale = useLocaleStore.getState().locale
beforeAll(() => { installDom(); useLocaleStore.setState({ locale: 'en' }) })
afterAll(() => { useLocaleStore.setState({ locale }); removeDom() })

const SUMMARY: ChatThreadSummary = { replyCount: 3, lastReplyAt: '2026-11-16T05:10:00.000Z', repliers: [{ id: 'u1', name: 'Minji' }], newReplies: true }

async function render(m: ReturnType<typeof msg>, onThread?: (focus: boolean) => void, o: { sideChat?: boolean } = {}) {
  const page = await mount(
    <MemoryRouter>
      <AssistantMessage m={m} chatId={CHAT} isLast busy={false} switchedFrom={null} onRegenerate={() => {}} onSelectBranch={() => {}} onAskOwnFolder={() => {}} shareable canSuggest={false} onThread={onThread} sendHere={o.sideChat ? { roomId: 'room-1', target: null, onView: () => {} } : undefined} />
    </MemoryRouter>,
  )
  const html = page.html()
  await page.unmount()
  return html
}

test('a finished answer of a shared chat: Reply in thread, and the line with its replies (a dot and words for new ones)', async () => {
  const html = await render(msg({ role: 'assistant', content: 'Use the seal.', status: 'done', thread: SUMMARY }), () => {})
  expect(html).toContain('data-testid="reply-in-thread"')
  expect(html).toContain('aria-label="Reply in thread"')
  expect(html).toContain('data-testid="chat-thread-line"')
  expect(html).toContain('3 replies')
  expect(html).toContain('New replies')
  // a stopped answer can have one too
  expect(await render(msg({ role: 'assistant', content: 'Half', status: 'stopped' }), () => {})).toContain('reply-in-thread')
})

test('no onThread (a private chat, a room\'s side chat): no button, no line, even with a summary', async () => {
  for (const html of [await render(msg({ role: 'assistant', content: 'x', status: 'done', thread: SUMMARY })), await render(msg({ role: 'assistant', content: 'x', status: 'done', thread: SUMMARY }), undefined, { sideChat: true })]) {
    expect(html).not.toContain('reply-in-thread')
    expect(html).not.toContain('chat-thread-line')
  }
})

test('an answer being written, one that failed or one hidden from me has no thread', async () => {
  for (const m of [msg({ role: 'assistant', content: 'so far', status: 'streaming' }), msg({ role: 'assistant', content: '', status: 'error', error: { code: 'internal', message: 'boom' } }), msg({ role: 'assistant', content: '', status: 'done', withheld: true })]) {
    const html = await render(m, () => {})
    expect(html).not.toContain('reply-in-thread')
    expect(html).not.toContain('chat-thread-line')
  }
})

test('the thread route belongs to Trina\'s place in the rail', () => {
  expect(railOf('/c/0190a0a0-0000-7000-8000-000000000001/t/0190a0a0-0000-7000-8000-000000000002')).toBe('ai')
})

test('a live change puts the summary on its answer (and takes it off when no reply is left)', () => {
  const answer = msg({ role: 'assistant', content: 'x', status: 'done' })
  useChats.setState((s) => ({ threads: { ...s.threads, [CHAT]: { ...emptyThread(), messages: [answer] } } }))
  useChatThreads.getState().handleEvent({ chatId: CHAT, rootId: answer.id, change: 'reply', thread: SUMMARY })
  expect(useChats.getState().threads[CHAT]!.messages[0]!.thread).toEqual(SUMMARY)
  useChatThreads.getState().handleEvent({ chatId: CHAT, rootId: answer.id, change: 'deleted', replyId: answer.id, thread: null })
  expect(useChats.getState().threads[CHAT]!.messages[0]!.thread).toBeUndefined()
  useChats.getState().reset()
  useChatThreads.getState().reset()
})

test('replies sent fast wait out the budget with one line for the thread, not a toast each, and then go by themselves (QA TC-3887)', async () => {
  const { useUi } = await import('../../src/store/ui')
  const realFetch = globalThis.fetch
  const realTimeout = globalThis.setTimeout
  let n = 0
  const posted: string[] = []
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { text: string; clientId: string }
    // the first try of each reply: 429 for a second; then 201
    if (n++ < 5) return new Response(JSON.stringify({ error: { code: 'rate_limited', message: 'slow down', retryAfter: 1 } }), { status: 429, headers: { 'content-type': 'application/json' } })
    posted.push(body.text)
    return new Response(JSON.stringify({ id: `0190a0a0-0000-7000-8000-00000000000${posted.length}`, chatId: CHAT, rootId: '0190a0a0-0000-7000-8000-0000000000aa', author: null, content: body.text, createdAt: '2026-11-16T05:00:00.000Z', canDelete: true }), { status: 201, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  // the wait is the server's second, made instant here
  globalThis.setTimeout = ((fn: () => void) => realTimeout(fn, 0)) as unknown as typeof setTimeout
  const toastsBefore = (useUi.getState() as { toasts?: unknown[] }).toasts?.length ?? 0
  try {
    const root = '0190a0a0-0000-7000-8000-0000000000aa'
    const sends = Array.from({ length: 5 }, (_, i) => useChatThreads.getState().send(CHAT, root, `reply ${i}`))
    // all five wait: the thread says it once
    await new Promise((r) => realTimeout(r, 0))
    expect(Object.keys(useChatThreads.getState().slowUntil)).toEqual([`${CHAT}:${root}`])
    await Promise.all(sends)
    expect(posted.sort()).toEqual(['reply 0', 'reply 1', 'reply 2', 'reply 3', 'reply 4'])
    expect(useChatThreads.getState().pending[`${CHAT}:${root}`]).toBeUndefined()
    expect(((useUi.getState() as { toasts?: unknown[] }).toasts?.length ?? 0) - toastsBefore).toBe(0)
  } finally {
    globalThis.fetch = realFetch
    globalThis.setTimeout = realTimeout
    useChatThreads.getState().reset()
  }
})

test('"no longer a member" is a sentence in every language, without quotes, the name in <bdi> (QA TC-3889)', async () => {
  const { isolate } = await import('../../src/components/handover/isolate')
  const { translate } = await import('../../src/i18n')
  const { renderToStaticMarkup } = await import('react-dom/server')
  for (const l of ['en', 'ko', 'id', 'ja', 'es', 'zh'] as const) {
    const text = translate(l, 'projects.noLongerMember', { name: 'THR Gone' })
    expect({ l, quotes: /['"“”「」‘’]THR Gone|THR Gone['"“”「」‘’]/.test(text), sentence: /[.。]$/.test(text) }).toEqual({ l, quotes: false, sentence: true })
    expect(renderToStaticMarkup(<>{isolate(l, 'projects.noLongerMember', { name: 'THR Gone' }, ['name'])}</>)).toContain('<bdi>THR Gone</bdi>')
  }
})

test('while the server is updating the thread says so in the one line under the box, and stops when it is back (QA TC-3886)', async () => {
  const { ThreadWaitLine } = await import('../../src/components/chat/ChatThreadPanel')
  const { useServerUpdating } = await import('../../src/lib/serverUpdating')
  const { translate } = await import('../../src/i18n')
  const page = await mount(<ThreadWaitLine slow={false} />)
  const line = () => page.find('chat-thread-updating')?.textContent ?? null
  try {
    // nothing to say: no line at all
    expect(page.find('chat-thread-updating')).toBeNull()
    expect(page.find('chat-thread-slow')).toBeNull()
    // the window's update signal (the chat's box follows the same one): the line says the reply goes once it is back
    await act(async () => useServerUpdating.setState({ updating: true }))
    expect(line()).toBe(translate('en', 'chat.thread.updating'))
    expect(page.find('chat-thread-slow')).toBeNull()
    // back: the line goes
    await act(async () => useServerUpdating.setState({ updating: false }))
    expect(line()).toBeNull()
  } finally {
    await act(async () => useServerUpdating.setState({ updating: false }))
    await page.unmount()
  }
  // the same slot as "sending fast": the update is said instead of it, never both
  const both = await mount(<ThreadWaitLine slow />)
  try {
    expect(both.find('chat-thread-slow')?.textContent).toBe(translate('en', 'chat.thread.fast'))
    await act(async () => useServerUpdating.setState({ updating: true }))
    expect(both.find('chat-thread-slow')).toBeNull()
    expect(both.find('chat-thread-updating')?.textContent).toBe(translate('en', 'chat.thread.updating'))
  } finally {
    await act(async () => useServerUpdating.setState({ updating: false }))
    await both.unmount()
  }
  // a plain sentence in every language, about a reply (not the chat's "message" line)
  for (const l of ['en', 'ko', 'id', 'ja', 'es', 'zh'] as const) {
    const text = translate(l, 'chat.thread.updating')
    expect({ l, sentence: /[.。]$/.test(text), own: text !== translate(l, 'conn.updatingUnsent') }).toEqual({ l, sentence: true, own: true })
  }
})
