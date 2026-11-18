// @mentions in the thread under an AI answer of a shared chat (docs/decisions/20261118-chat-thread-mentions.md;
// components/chat/ChatThreadPanel.tsx with the rooms' mention box): "@" lists exactly the people the server sent for
// the thread (never me, no "@everyone"), a pick is a token and the reply goes with its id, and a reply shows its
// mentions as names in the rooms' mention look (mine on the soft background).
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act } from 'react'
import { MemoryRouter } from 'react-router-dom'
import type { Chat, ChatThreadPage, Me, UserRef } from '@mycel/shared/api'
import { useLocaleStore } from '../../src/i18n'
import { ChatThreadPanel } from '../../src/components/chat/ChatThreadPanel'
import { useChatThreads } from '../../src/store/chatThreads'
import { useSession } from '../../src/store/session'
import { CHAT, msg } from './fixtures'
import { FakeElement, FakeEvent, installDom, mount, removeDom, type Mounted } from './dom-host'

const ME = { id: 'ada', name: 'Ada' }
const BEN = { id: 'ben', name: 'Ben' }
const CY = { id: 'cy', name: 'Cy Park' }
const WAIT = 4000
const locale = useLocaleStore.getState().locale
const status = useSession.getState().status
const realFetch = globalThis.fetch
let sent: { text: string; mentions?: string[] }[] = []
let live: Mounted | null = null

beforeAll(() => { installDom(); useLocaleStore.setState({ locale: 'en' }) })
afterEach(async () => {
  await live?.unmount()
  live = null
  globalThis.fetch = realFetch
  useSession.setState({ status })
  useChatThreads.getState().reset()
})
afterAll(() => { useLocaleStore.setState({ locale }); removeDom() })

const chat = { id: CHAT, projectId: null, title: 'Quote', engine: 'claude-code', model: null, createdAt: '2026-11-18T00:00:00.000Z', updatedAt: '2026-11-18T00:00:00.000Z', deletedAt: null, runState: 'idle' } as unknown as Chat
const root = msg({ role: 'assistant', content: 'Use the corporate seal.', status: 'done' })
const reply = (o: { text: string; mentions?: string[]; author?: UserRef }) => ({ id: `019a9000-0000-7000-8000-${String(Math.floor(Math.random() * 1e12)).padStart(12, '0')}`, chatId: CHAT, rootId: root.id, author: o.author ?? BEN, content: o.text, mentions: o.mentions ?? [], createdAt: '2026-11-18T01:00:00.000Z', canDelete: false })

async function open(o: { people?: UserRef[]; replies?: ReturnType<typeof reply>[] } = {}) {
  useSession.setState({ status: { kind: 'signed-in', me: { user: { id: ME.id, name: ME.name, role: 'member' }, server: {} } as unknown as Me } })
  const page = { root, replies: o.replies ?? [], nextCursor: null, canReply: true, version: { index: 1, count: 1 }, onShownBranch: true, full: false, ...(o.people ? { people: o.people } : {}) } as ChatThreadPage
  sent = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://team.localhost').pathname
    const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } })
    if (path === `/api/chats/${CHAT}/messages/${root.id}/thread` && init?.method === 'POST') {
      const b = JSON.parse(String(init.body))
      sent.push(b)
      return json(reply({ text: b.text, mentions: b.mentions, author: ME }), 201)
    }
    if (path === `/api/chats/${CHAT}/messages/${root.id}/thread`) return json(page)
    return json({ error: { code: 'not_found', message: 'no' } }, 404)
  }) as typeof fetch
  const m = await mount(<MemoryRouter><ChatThreadPanel chat={chat} rootId={root.id} meId={ME.id} onClose={() => {}} onShownBranch /></MemoryRouter>)
  live = m
  const box = (await m.until(() => m.find('chat-thread-input'), 'the reply box', WAIT)) as Box
  await act(async () => { box.focus(); box.dispatchEvent(new FakeEvent('focusin', { bubbles: true })) })
  return { m, box }
}

const setValue = Object.getOwnPropertyDescriptor(FakeElement.prototype, 'value')!.set!
type Box = FakeElement & { value: string; selectionStart: number; selectionEnd: number }
async function typeText(box: Box, s: string) {
  await act(async () => {
    const at = box.selectionEnd ?? box.value.length
    box.setSelectionRange(at, at)
    box.dispatchEvent(Object.assign(new FakeEvent('beforeinput', { bubbles: true, cancelable: true }), { inputType: 'insertText' }))
    setValue.call(box, box.value.slice(0, at) + s + box.value.slice(at))
    box.setSelectionRange(at + s.length, at + s.length)
    box.dispatchEvent(new FakeEvent('input', { bubbles: true }))
    box.dispatchEvent(new FakeEvent('keyup', { bubbles: true }))
  })
}
const key = (box: Box, k: string) => act(async () => { box.dispatchEvent(new FakeEvent('keydown', { bubbles: true, cancelable: true, key: k })) })
const rows = (m: Mounted) => (m.find('mention-menu')?.querySelectorAll('[data-testid="mention-option"]') ?? []).map((b) => (b.hasAttribute('data-all') ? 'all:' : '') + b.textContent)

test('"@" lists exactly the people who see the thread (never me, no "@everyone"); a pick goes with the reply as a mention', async () => {
  const { m, box } = await open({ people: [BEN, CY] })
  await typeText(box, '@')
  await m.until(() => m.find('mention-menu'), 'the "@" list', WAIT)
  // the avatar's letter, then the name
  expect(rows(m)).toEqual(['BBen', 'CCy Park'])
  expect(rows(m).some((r) => r.startsWith('all:'))).toBe(false)
  await typeText(box, 'c')
  expect(rows(m)).toEqual(['CCy Park'])
  await key(box, 'Enter')
  expect(box.value).toBe('@Cy Park ')
  expect(m.get('token-layer').querySelectorAll('[data-token]').map((el) => el.textContent)).toEqual(['@Cy Park'])
  await typeText(box, 'can you sign?')
  await key(box, 'Enter')
  await m.until(() => sent.length === 1, 'the reply sent', WAIT)
  expect(sent[0]).toMatchObject({ text: '@Cy Park can you sign?', mentions: ['cy'] })
})

test('no people from the server (an older one, or a thread I cannot reply to): "@" opens no list, the reply has no mentions', async () => {
  const { m, box } = await open()
  await typeText(box, '@Ben hi')
  expect(m.find('mention-menu')).toBeNull()
  await key(box, 'Enter')
  await m.until(() => sent.length === 1, 'the reply sent', WAIT)
  expect(sent[0]!.mentions).toBeUndefined()
})

test('a reply shows its mentions as names in the mention look; mine on the soft background; typed "@names" stay text', async () => {
  const { m } = await open({ people: [BEN, CY], replies: [reply({ text: '@Ada and @Cy Park, see this. @Nobody', mentions: [ME.id, CY.id] })] })
  await m.until(() => m.get('chat-thread-reply-text').querySelectorAll('span').length === 2, 'the mentions in the reply', WAIT)
  // (a person the directory does not list is a plain span in the same look: PersonButton)
  const names = m.get('chat-thread-reply-text').querySelectorAll('span')
  expect(names.map((n) => n.textContent)).toEqual(['@Ada', '@Cy Park'])
  // me: the soft background; someone else: the accent colour only
  expect(names[0]!.getAttribute('class')).toContain('bg-accent-soft')
  expect(names[1]!.getAttribute('class')).toContain('text-accent-text')
  expect(names[1]!.getAttribute('class')).not.toContain('bg-accent-soft')
  expect(m.get('chat-thread-reply-text').textContent).toBe('@Ada and @Cy Park, see this. @Nobody')
})
