// The thread under a shared chat's AI answer looks like a room's thread (components/chat/ChatThreadPanel.tsx with the
// rooms' parts, rooms/MessageRun.tsx and rooms/ThreadParts.tsx): one person's replies close together are one run under
// one face, name and time (lib/rooms.ts groupRuns), the answer on top is a run of the AI's, and the answer is cut on a
// block's edge, never through a table or a line (answerCut).
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import type { Chat, ChatThreadPage, Me, UserRef } from '@mycel/shared/api'
import { useLocaleStore } from '../../src/i18n'
import { answerCut, ChatThreadPanel } from '../../src/components/chat/ChatThreadPanel'
import { groupRuns } from '../../src/lib/rooms'
import { useChatThreads } from '../../src/store/chatThreads'
import { useSession } from '../../src/store/session'
import { CHAT, msg } from './fixtures'
import { installDom, mount, removeDom, type Mounted } from './dom-host'

const ME = { id: 'ada', name: 'Ada' }
const BEN = { id: 'ben', name: 'Ben' }
const WAIT = 4000
const locale = useLocaleStore.getState().locale
const status = useSession.getState().status
const realFetch = globalThis.fetch
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
const root = { ...msg({ role: 'assistant', content: 'Use the corporate seal.', status: 'done' }), createdAt: '2026-11-18T05:26:00.000Z' }
let n = 0
const reply = (author: UserRef, text: string, at: string) => ({ id: `019a9000-0000-7000-8000-${String(++n).padStart(12, '0')}`, chatId: CHAT, rootId: root.id, author, content: text, mentions: [], createdAt: at, canDelete: author.id === ME.id })

test('one person\'s replies within minutes are one run (one face, name and time); another person starts a new one', async () => {
  const replies = [
    reply(ME, 'Check the total again.', '2026-11-18T05:27:00.000Z'),
    reply(ME, 'VAT is extra.', '2026-11-18T05:27:20.000Z'),
    reply(ME, 'Sending it this afternoon.', '2026-11-18T05:27:40.000Z'),
    reply(BEN, 'Seal checked.', '2026-11-18T05:28:00.000Z'),
  ]
  expect(groupRuns(replies).map((r) => r.messages.length)).toEqual([3, 1])
  useSession.setState({ status: { kind: 'signed-in', me: { user: { id: ME.id, name: ME.name, role: 'member' }, server: {} } as unknown as Me } })
  const page = { root, replies, nextCursor: null, canReply: true, version: { index: 1, count: 1 }, onShownBranch: true, full: false } as unknown as ChatThreadPage
  globalThis.fetch = (async () => new Response(JSON.stringify(page), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
  const m = await mount(<MemoryRouter><ChatThreadPanel chat={chat} rootId={root.id} meId={ME.id} onClose={() => {}} onShownBranch /></MemoryRouter>)
  live = m
  await m.until(() => m.find('chat-thread-replies')?.querySelectorAll('[data-testid="chat-thread-reply"]').length === 4, 'the replies', WAIT)
  const list = m.get('chat-thread-replies')
  const runs = list.querySelectorAll('[data-testid="room-run"]')
  expect(runs.length).toBe(2)
  expect(runs[0]!.querySelectorAll('[data-testid="chat-thread-reply"]').length).toBe(3)
  expect(runs.map((r) => r.querySelectorAll('time').length)).toEqual([1, 1])
  // the answer on top: a run of the AI's, as a room thread's root; no date line between it and replies of its day
  expect(m.get('chat-thread-answer').querySelectorAll('[data-testid="room-run"]').length).toBe(1)
  expect(list.querySelectorAll('[data-testid="room-day"]').length).toBe(0)
  // a reply's actions are the rooms' hover bar (⋮ only: no reactions on a reply here)
  expect(list.querySelectorAll('[data-testid="message-hover-bar"]').length).toBe(4)
  expect(list.querySelectorAll('[data-testid="hover-react"]').length).toBe(0)
})

/** a fake laid-out answer: the box at top 0, its formatted wrapper, and blocks of these heights one under the other
 * (rows: a block's own table rows) */
function laidOut(blocks: { h: number; rows?: number[] }[]): HTMLElement {
  let y = 0
  const rect = (top: number, h: number) => ({ top, bottom: top + h })
  const els = blocks.map((b) => {
    const top = y
    y += b.h
    let ry = top
    const rows = (b.rows ?? []).map((h) => { const r = rect(ry, h); ry += h; return { getBoundingClientRect: () => r } })
    return { getBoundingClientRect: () => rect(top, b.h), querySelectorAll: () => rows }
  })
  const total = y
  return { scrollHeight: total, getBoundingClientRect: () => rect(0, total), firstElementChild: { children: els } } as unknown as HTMLElement
}

test('the answer is cut after the last whole block that fits, never through a table', () => {
  // a paragraph (56), then a table that would cross the line (280): only the paragraph shows, then "Show more"
  expect(answerCut(laidOut([{ h: 56 }, { h: 280, rows: [40, 40, 40, 40, 40, 40, 40] }, { h: 28 }]))).toBe(56)
  // short enough: all of it, no "Show more"
  expect(answerCut(laidOut([{ h: 56 }, { h: 200 }]))).toBeNull()
  // a table first and taller than the cut: after its last row that fits
  expect(answerCut(laidOut([{ h: 600, rows: [40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40] }]))).toBe(280)
  // a block with no rows taller than the cut: that block whole
  expect(answerCut(laidOut([{ h: 500 }, { h: 100 }]))).toBe(500)
  // plain text (the formatting code still loading): whole lines
  expect(answerCut({ scrollHeight: 900, getBoundingClientRect: () => ({ top: 0, bottom: 900 }), firstElementChild: { children: [] } } as unknown as HTMLElement)! % 28).toBe(0)
})
