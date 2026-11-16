// Threads on AI answers in shared chats (docs/decisions/20261116-chat-answer-threads.md): "Reply in thread" and the
// thread's line only on a finished answer of a shared chat (the page passes onThread; a private chat and a room's ✦ side
// chat never do), never on an answer still being written, one that failed or one hidden from me. "Send to Trina"'s
// draft (shared chats.ts chatThreadDraft): every line a quote, names on one line, the newest kept within 4,000
// characters with a line saying older ones were left out; the answer's own text never in it. The chat thread route
// lights the Trina place in the rail, and the store puts a live change's summary on the answer.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import { CHAT_THREAD_DRAFT_MAX, chatThreadDraft, type ChatThreadSummary } from '@mycel/shared/api'
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

async function render(m: ReturnType<typeof msg>, onThread?: (focus: boolean) => void, o: { pressMenu?: boolean } = {}) {
  const page = await mount(
    <MemoryRouter>
      <AssistantMessage m={m} chatId={CHAT} isLast busy={false} switchedFrom={null} onRegenerate={() => {}} onSelectBranch={() => {}} onAskOwnFolder={() => {}} shareable canSuggest={false} onThread={onThread} pressMenu={o.pressMenu} />
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
  for (const html of [await render(msg({ role: 'assistant', content: 'x', status: 'done', thread: SUMMARY })), await render(msg({ role: 'assistant', content: 'x', status: 'done', thread: SUMMARY }), undefined, { pressMenu: true })]) {
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

test('Send to Trina\'s draft: every line a quote, names on one line, an empty line for my own words', () => {
  const d = chatThreadDraft([
    { name: 'Minji', at: '2026-11-16T05:11:00Z', text: 'Corporate seal, or the CEO line?' },
    { name: 'Jae Lee', at: '2026-11-16T05:12:00Z', text: 'Seal.\r\nLegal said so.\n\nOK' },
  ], { head: "Thread on Trina's answer · 2:10 PM · 2 replies", cut: '…(earlier replies left out)', time: () => '2:11 PM' })
  expect(d).toBe("> Thread on Trina's answer · 2:10 PM · 2 replies\n> Minji · 2:11 PM\n> Corporate seal, or the CEO line?\n> Jae Lee · 2:11 PM\n> Seal.\n> Legal said so.\n>\n> OK\n\n")
})

test('the draft keeps the newest replies within 4,000 characters and says older ones were left out', () => {
  const many = Array.from({ length: 300 }, (_, i) => ({ name: `P${i}`, at: '2026-11-16T05:00:00Z', text: `reply ${i} `.repeat(4) }))
  const d = chatThreadDraft(many, { head: 'Thread', cut: '…(earlier replies left out)', time: () => '1:00 PM' })
  expect(d.trimEnd().length).toBeLessThanOrEqual(CHAT_THREAD_DRAFT_MAX)
  const lines = d.trimEnd().split('\n')
  expect(lines[1]).toBe('> …(earlier replies left out)')
  expect(d).toContain('reply 299')
  expect(d).not.toContain('reply 0 ')
  expect(lines.every((l) => l.startsWith('>'))).toBe(true)
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
