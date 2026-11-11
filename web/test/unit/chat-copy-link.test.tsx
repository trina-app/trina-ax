// "링크 복사" for an AI chat (docs/AGENTS/plan: chat-copy-link), in the chat header's "⋯" and on a project page's chat row
// (the sidebar's row is in sidebar.test.tsx): the item is there, it copies the chat's address alone (`<origin>/c/<id>`),
// and the toast says who can open it: a shared project chat the project's N people, a private chat only me. The words in
// all five languages say the same and the address is the only text on the clipboard.
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import { Chat, type Me } from '@mycel/shared/api'
import { chatLink } from '../../src/components/chat/copyChatLink'
import { ChatTitleMenu } from '../../src/components/chat/ChatTitleMenu'
import { ProjectChatRow } from '../../src/pages/Projects'
import { translate, useLocaleStore } from '../../src/i18n'
import { usePeople } from '../../src/store/people'
import { useSession } from '../../src/store/session'
import { useUi } from '../../src/store/ui'
import { installDom, mount, removeDom, type FakeElement } from './dom-host'

const ORIGIN = 'https://team.acme.example'
const ID = '01900000-0000-7000-8000-0000000000c1'
const me = {
  user: { id: 'alex', username: 'alex', name: 'Alex', email: null, role: 'member', locale: 'ko', localeChoice: null, mustChangePassword: false, prefs: {} },
  groups: [], team: { name: 'Acme', defaultLocale: 'ko', chatTrashRetentionDays: 14 }, session: { id: '01900000-0000-7000-8000-00000000000a', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' },
  server: { version: '0', dev: false, deployment: 'hosted' },
} as unknown as Me
const chat = (shared: boolean) => Chat.parse({
  id: ID, projectId: '01900000-0000-7000-8000-000000000001', title: 'Launch plan', engine: 'claude-code', model: null,
  createdAt: '2026-11-08T00:00:00.000Z', updatedAt: new Date(Date.now() - 60_000).toISOString(), deletedAt: null, runState: 'idle',
  ...(shared ? { shared: { by: { id: 'alex', name: 'Alex' }, audience: 4, answering: null, mine: true, canDelete: true } } : {}),
})

const copied: string[] = []
const realFetch = globalThis.fetch
const realNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
const status = useSession.getState().status
const locale = useLocaleStore.getState().locale
beforeAll(() => {
  installDom()
  ;(globalThis as Record<string, unknown>).location = { origin: ORIGIN }
  globalThis.fetch = (async () => new Response(JSON.stringify({ people: [] }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
})
beforeEach(() => {
  copied.length = 0
  useLocaleStore.setState({ locale: 'ko' })
  useSession.setState({ status: { kind: 'signed-in', me } } as never)
  Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: { ...globalThis.navigator, clipboard: { writeText: async (s: string) => void copied.push(s) } } })
})
afterEach(() => {
  usePeople.getState().reset()
  useSession.setState({ status })
  useLocaleStore.setState({ locale })
  if (realNavigator) Object.defineProperty(globalThis, 'navigator', realNavigator)
})
afterAll(() => {
  globalThis.fetch = realFetch
  delete (globalThis as Record<string, unknown>).location
  removeDom()
})

const ko = (k: Parameters<typeof translate>[1], p?: Parameters<typeof translate>[2]) => translate('ko', k, p)

test('the address is the app\'s own chat route on the given origin', () => {
  expect(chatLink(ID, ORIGIN)).toBe(`${ORIGIN}/c/${ID}`)
  expect(chatLink(ID)).toBe(`${ORIGIN}/c/${ID}`)
})

test('the words: the same two sentences in every language, the shared one with the number of people', () => {
  expect(ko('chat.linkCopiedShared', { n: 4 })).toBe('링크를 복사했어요 · 멤버 4명이 열 수 있어요')
  expect(ko('chat.linkCopiedPrivate')).toBe('링크를 복사했어요 · 나만 열 수 있어요')
  for (const l of ['en', 'es', 'id', 'ja'] as const) {
    expect(translate(l, 'chat.linkCopiedShared', { n: 4 })).toContain('4')
    expect(translate(l, 'chat.linkCopiedPrivate')).not.toBe(ko('chat.linkCopiedPrivate'))
    expect(translate(l, 'rooms.menu.copyLink')).not.toBe('')
  }
  expect(translate('en', 'rooms.menu.copyLink')).toBe('Copy link')
})

for (const shared of [true, false]) {
  const text = shared ? ko('chat.linkCopiedShared', { n: 4 }) : ko('chat.linkCopiedPrivate')

  test(`the chat header's "⋯" has 링크 복사 (${shared ? 'shared project chat' : 'private chat'}): the address alone, then who can open it`, async () => {
    const c = chat(shared)
    // a person who may change nothing here still has the menu, with this item only
    const m = await mount(<ChatTitleMenu chat={c} title={c.title} />)
    try {
      await m.click('chat-menu')
      const items = (m.container.querySelectorAll('[role="menuitem"]') as unknown as FakeElement[]).map((e) => [e.getAttribute('data-testid'), e.textContent?.trim()])
      expect(items).toEqual([['chat-copy-link', ko('rooms.menu.copyLink')]])
      await m.click('chat-copy-link')
      await m.until(() => copied.length, 'the copy')
      expect(copied).toEqual([`${ORIGIN}/c/${ID}`])
      expect(useUi.getState().toasts.at(-1)?.text).toBe(text)
      await m.settle(1600)
    } finally {
      await m.unmount()
    }
  })

  test(`a project page's chat row has a "⋯" beside its link with 링크 복사 (${shared ? 'shared' : 'private'})`, async () => {
    const c = chat(shared)
    const m = await mount(<MemoryRouter><ProjectChatRow chat={c} /></MemoryRouter>)
    try {
      if (shared) await m.until(() => usePeople.getState().loaded, 'the people directory')
      const more = m.get('project-chat-menu')
      // beside the row's link, not inside it
      expect(more.closest('a')).toBeNull()
      expect(m.get('project-chat').getAttribute('href')).toBe(`/c/${ID}`)
      await m.click(more)
      const items = (m.container.querySelectorAll('[role="menuitem"]') as unknown as FakeElement[]).map((e) => [e.getAttribute('data-testid'), e.textContent?.trim()])
      expect(items).toEqual([['project-chat-copy-link', ko('rooms.menu.copyLink')]])
      await m.click('project-chat-copy-link')
      await m.until(() => copied.length, 'the copy')
      expect(copied).toEqual([`${ORIGIN}/c/${ID}`])
      expect(useUi.getState().toasts.at(-1)?.text).toBe(text)
      await m.settle(1600)
    } finally {
      await m.unmount()
    }
  })
}
