// A project page's chat row "···" (pages/Projects.tsx ProjectChatRow, components/chat/chatMenuItems.tsx): the same items
// as the sidebar row's by the same rules (QA TC-248: it had 링크 복사 only), and on a phone a bottom sheet across the
// window (a transform on the button's box held the fixed sheet in a 30 px strip).
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import { Chat, type Me } from '@mycel/shared/api'
import { ProjectChatRow } from '../../src/pages/Projects'
import { translate, useLocaleStore } from '../../src/i18n'
import { usePeople } from '../../src/store/people'
import { useSession } from '../../src/store/session'
import { installDom, mount, removeDom, type FakeElement } from './dom-host'

const ID = '01900000-0000-7000-8000-0000000000c1'
const P = '01900000-0000-7000-8000-000000000001'
const me = {
  user: { id: 'alex', username: 'alex', name: 'Alex', email: null, role: 'member', locale: 'ko', localeChoice: null, mustChangePassword: false, prefs: {} },
  groups: [], team: { name: 'Acme', defaultLocale: 'ko', chatTrashRetentionDays: 14 }, session: { id: '01900000-0000-7000-8000-00000000000a', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' },
  server: { version: '0', dev: false, deployment: 'hosted' },
} as unknown as Me
const base = {
  id: ID, projectId: P, title: 'Launch plan', engine: 'claude-code', model: null,
  createdAt: '2026-11-08T00:00:00.000Z', updatedAt: '2026-11-08T00:00:00.000Z', deletedAt: null, runState: 'idle',
}
const chat = (o: { shared?: { by: string; canDelete: boolean }; pinnedAt?: string } = {}) => Chat.parse({
  ...base,
  ...(o.pinnedAt ? { pinnedAt: o.pinnedAt } : {}),
  ...(o.shared ? { shared: { by: { id: o.shared.by, name: o.shared.by }, audience: 3, answering: null, mine: o.shared.by === 'alex', canDelete: o.shared.canDelete } } : {}),
})

const calls: string[] = []
const realFetch = globalThis.fetch
const status = useSession.getState().status
const locale = useLocaleStore.getState().locale
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
beforeAll(() => {
  installDom()
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input).split('?')[0]
    calls.push(`${init?.method ?? 'GET'} ${url}`)
    if (url === `/api/chats/${ID}/pin`) return json({ ...base, pinnedAt: '2026-11-12T00:00:00.000Z' })
    return json({ people: [] })
  }) as unknown as typeof fetch
})
beforeEach(() => {
  calls.length = 0
  useLocaleStore.setState({ locale: 'ko' })
  useSession.setState({ status: { kind: 'signed-in', me } } as never)
})
afterEach(() => {
  usePeople.getState().reset()
  useSession.setState({ status })
  useLocaleStore.setState({ locale })
})
afterAll(() => {
  globalThis.fetch = realFetch
  removeDom()
})

const ko = (k: Parameters<typeof translate>[1]) => translate('ko', k)
const pin = ['project-chat-pin', ko('chat.pin')]
const link = ['project-chat-copy-link', ko('rooms.menu.copyLink')]
const rename = ['project-chat-rename', ko('chat.rename')]
const move = ['project-chat-move', ko('chat.project.change')]
const del = ['project-chat-delete', ko('common.delete')]

/** the row's "···" opened: its items as [test id, words] */
async function items(c: Chat, o: { onMove?: (c: Chat) => void } = {}) {
  const m = await mount(<MemoryRouter><ProjectChatRow chat={c} {...o} /></MemoryRouter>)
  try {
    if (c.shared) await m.until(() => usePeople.getState().loaded, 'the people directory')
    await m.click('project-chat-menu')
    return (m.container.querySelectorAll('[role="menuitem"]') as unknown as FakeElement[]).map((e) => [e.getAttribute('data-testid'), e.textContent?.trim()])
  } finally {
    await m.unmount()
  }
}

test('a chat of my own: pin, 링크 복사, rename, 프로젝트 변경 and delete, as on the sidebar row', async () => {
  expect(await items(chat(), { onMove: () => {} })).toEqual([pin, link, rename, move, del])
})

test('shared project chats follow the sidebar\'s rules: never a move; rename for the creator; delete for the creator or a project editor', async () => {
  const onMove = () => {}
  expect(await items(chat({ shared: { by: 'alex', canDelete: true } }), { onMove })).toEqual([pin, link, rename, del])
  expect(await items(chat({ shared: { by: 'bob', canDelete: true } }), { onMove })).toEqual([pin, link, del])
  // someone else's shared chat I may not delete: no delete, no rename
  expect(await items(chat({ shared: { by: 'bob', canDelete: false }, pinnedAt: '2026-11-02T00:00:00.000Z' }), { onMove })).toEqual([['project-chat-unpin', ko('chat.unpin')], link])
})

test('상단에 고정 pins it and hands the row back as it is now', async () => {
  const changed: Chat[] = []
  const m = await mount(<MemoryRouter><ProjectChatRow chat={chat()} onChanged={(c) => changed.push(c)} /></MemoryRouter>)
  try {
    await m.click('project-chat-menu')
    await m.click('project-chat-pin')
    await m.until(() => changed.length, 'the pinned chat')
    expect(calls).toContain(`POST /api/chats/${ID}/pin`)
    expect(changed[0]!.pinnedAt).toBe('2026-11-12T00:00:00.000Z')
    // the menu closed, the keyboard back on "···"
    expect(m.find('project-chat-pin')).toBeNull()
    expect(document.activeElement).toBe(m.get('project-chat-menu') as never)
  } finally {
    await m.unmount()
  }
})

test('on a phone the sheet is not held by its button\'s box: no transform on any box around the menu', async () => {
  const m = await mount(<MemoryRouter><ProjectChatRow chat={chat()} /></MemoryRouter>)
  try {
    await m.click('project-chat-menu')
    const sheet = m.container.querySelector('[role="menu"]') as unknown as FakeElement
    expect(sheet.getAttribute('class')).toContain('max-md:inset-x-0')
    for (let el: FakeElement | null = sheet.parentElement as FakeElement | null; el && el !== (m.container as unknown); el = el.parentElement as FakeElement | null) {
      expect(el.getAttribute('class') ?? '').not.toMatch(/(^|\s)-?(translate|scale|rotate|transform)/)
    }
  } finally {
    await m.unmount()
  }
})
