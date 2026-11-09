// The room side chat (✦ Trina, components/rooms/SideChatPanel.tsx, docs/DECISIONS.md "트리나 사이드 채팅"): the panel
// opens the room's newest side chat or none; the first question makes a side chat of the room (POST /api/chats with
// sideRoomId) and sends the question there; an answer's "Share to room" is a labelled button and the dialog starts with
// the room picked.
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import { uuidv7, type Me } from '@mycel/shared/api'
import { AssistantMessage } from '../../src/components/chat/Messages'
import ShareToRoom from '../../src/components/chat/ShareToRoom'
import { SideChatPanel } from '../../src/components/rooms/SideChatPanel'
import { translate, useLocaleStore } from '../../src/i18n'
import { aiName } from '../../src/lib/tabs'
import { useChats } from '../../src/store/chats'
import { useRooms } from '../../src/store/rooms'
import { useSession } from '../../src/store/session'
import { installDom, mount, removeDom } from './dom-host'
import { CHAT, msg } from './fixtures'
import { at, ME, room } from './rooms-fixtures'

const en = (k: Parameters<typeof translate>[1], p?: Record<string, string | number>) => translate('en', k, p)
const locale = useLocaleStore.getState().locale
const status = useSession.getState().status
const realFetch = globalThis.fetch
let calls: { method: string; path: string; search: string; body: Record<string, unknown> | undefined }[] = []

beforeAll(() => { installDom(); useLocaleStore.setState({ locale: 'en' }) })
afterEach(() => {
  globalThis.fetch = realFetch
  useSession.setState({ status })
  useRooms.getState().reset()
  useChats.getState().reset()
})
afterAll(() => { removeDom(); useLocaleStore.setState({ locale }) })

const team = room({ name: 'Marketing', memberCount: 6, activityAt: at(5) })
const signIn = () => useSession.setState({ status: { kind: 'signed-in', me: { user: { id: ME.id, name: ME.name }, server: { allChatsConfidential: false } } as unknown as Me } })

function serve(existing: string | null) {
  calls = []
  const made = uuidv7()
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://team.localhost')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, path: u.pathname, search: u.search, body })
    const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } })
    const chat = (id: string) => ({ id, projectId: null, title: '', engine: 'claude-code', model: null, createdAt: at(1), updatedAt: at(1), deletedAt: null, runState: 'idle', sideRoomId: team.id })
    if (method === 'GET' && u.pathname === '/api/chats') return json({ items: existing ? [chat(existing)] : [], nextCursor: null })
    if (method === 'POST' && u.pathname === '/api/chats') return json(chat(made))
    if (method === 'GET' && /^\/api\/chats\/[^/]+\/messages$/.test(u.pathname)) return json({ items: [], nextCursor: null, activeLeafId: null })
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
    expect(m.get('side-chat-private').textContent).toBe(en('sideChat.private'))
    // no chat yet: no "new chat" and no "open as a full chat"
    expect(m.get('side-chat-new').hasAttribute('disabled')).toBe(true)
    expect(m.find('side-chat-open-full')).toBeNull()
    await m.type('side-chat-input', 'summarize this room')
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

test('a side chat\'s answer: "Share to room" in words; the dialog starts with the room picked', async () => {
  signIn()
  const a = await mount(<MemoryRouter><AssistantMessage m={msg({ role: 'assistant', content: 'the plan', status: 'done' })} chatId={CHAT} isLast busy={false} switchedFrom={null} onRegenerate={() => {}} onSelectBranch={() => {}} onAskOwnFolder={() => {}} shareable shareRoomId={team.id} /></MemoryRouter>)
  try {
    expect(a.get('share-to-room').textContent).toBe(en('sideChat.share'))
  } finally {
    await a.unmount()
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
  expect(en('sideChat.open', { name: aiName((k) => en(k)) })).toContain('privately')
})
