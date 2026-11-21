// A project page's Trina history (pages/Projects.tsx ProjectChatRow) shows my unread mentions in a chat as the 프로젝트
// panel's chat row does (panels/ProjectsPanel.tsx MentionPill): the same round count from the same store
// (store/chatMentions.ts), before the time, with who mentioned me for a screen reader, and the title bold. Opening the
// chat (pages/Chat.tsx readChatMentions) reads those notices, so the count goes from both lists at once.
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import { Chat, type Me } from '@mycel/shared/api'
import { ProjectChatRow } from '../../src/pages/Projects'
import { readChatMentions, useChatMentions, type ChatMention } from '../../src/store/chatMentions'
import { useLocaleStore } from '../../src/i18n'
import { useSession } from '../../src/store/session'
import { installDom, mount, removeDom, type FakeElement } from './dom-host'

const me: Me = {
  user: { id: 'alex', username: 'alex', name: 'Alex', email: null, role: 'member', locale: 'en', localeChoice: null, mustChangePassword: false, prefs: {} },
  groups: [], team: { name: 'Acme', defaultLocale: 'en', chatTrashRetentionDays: 14 }, session: { id: '01900000-0000-7000-8000-00000000000a', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' },
  server: { version: '0', dev: false, deployment: 'hosted' },
} as unknown as Me
const CHAT = '01900000-0000-7000-8000-0000000000c1'
const OTHER = '01900000-0000-7000-8000-0000000000c2'
const chat = Chat.parse({
  id: CHAT, projectId: '01900000-0000-7000-8000-000000000001', title: 'Follow our brand guide', engine: 'claude-code', model: null,
  createdAt: '2026-11-08T00:00:00.000Z', updatedAt: new Date(Date.now() - 60_000).toISOString(), deletedAt: null, runState: 'idle',
})

const realFetch = globalThis.fetch
const locale = useLocaleStore.getState().locale
const status = useSession.getState().status
/** the POSTs this test's server saw */
let posts: string[] = []
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'en' })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).split('?')[0]!
    if (init?.method === 'POST') posts.push(path)
    return new Response(JSON.stringify({ error: { code: 'not_found', message: 'not here' } }), { status: 404, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
})
afterEach(() => {
  posts = []
  useChatMentions.setState({ byChat: new Map(), projectOf: {} })
  useSession.setState({ status })
})
afterAll(() => {
  globalThis.fetch = realFetch
  useLocaleStore.setState({ locale })
  removeDom()
})

async function row(mention?: ChatMention) {
  useSession.setState({ status: { kind: 'signed-in', me } } as never)
  const page = await mount(<MemoryRouter><ProjectChatRow chat={chat} mention={mention} /></MemoryRouter>)
  await page.settle()
  return page
}
/** the classes from the title up to the row's link: the row's name weight is on one of them */
const nameClasses = (title: FakeElement) => {
  const out: string[] = []
  for (let n: FakeElement | null = title; n && n.getAttribute('data-testid') !== 'project-chat'; n = n.parentElement) out.push(n.getAttribute('class') ?? '')
  return out.join(' ')
}

test('a chat with unread mentions of me: the panel\'s count before the time, who for a screen reader, the title bold', async () => {
  const page = await row({ chatId: CHAT, count: 2, names: ['Bob', 'Dana'], ids: ['n1', 'n2'] })
  try {
    const pill = page.get('project-chat-mentions')
    expect(pill.querySelector('[aria-hidden]')!.textContent).toBe('2')
    expect(pill.textContent).toContain('Bob, Dana')
    // the same pill as the 프로젝트 panel (components/CountPill.tsx): the accent fill, round
    expect(pill.getAttribute('class')).toContain('bg-accent')
    expect(pill.getAttribute('class')).toContain('rounded-full')
    // before the time, in the row's end
    const end = page.get('project-chat').querySelector('time')!
    expect(end.parentElement!.contains(pill)).toBe(true)
    expect(nameClasses(page.get('project-row-title'))).toContain('font-semibold')
  } finally { await page.unmount() }
})

test('no mention: no count, the title at the page\'s normal weight', async () => {
  const page = await row()
  try {
    expect(page.find('project-chat-mentions')).toBeNull()
    expect(nameClasses(page.get('project-row-title'))).not.toContain('font-semibold')
    expect(nameClasses(page.get('project-row-title'))).toContain('font-normal')
  } finally { await page.unmount() }
})

test('opening the chat reads its mention notices: gone from the counts at once, the other chat\'s kept', async () => {
  useChatMentions.setState({
    byChat: new Map([
      [CHAT, { chatId: CHAT, count: 2, names: ['Bob'], ids: ['n1', 'n2'] }],
      [OTHER, { chatId: OTHER, count: 1, names: ['Dana'], ids: ['n3'] }],
    ]),
  })
  const done = readChatMentions(CHAT)
  // at once, before the server answers
  expect(useChatMentions.getState().byChat.has(CHAT)).toBe(false)
  expect(useChatMentions.getState().byChat.get(OTHER)?.count).toBe(1)
  await done
  expect(posts.sort()).toEqual(['/api/notifications/n1/read', '/api/notifications/n2/read'])
  // a chat with no mention of me: nothing is sent
  posts = []
  await readChatMentions('01900000-0000-7000-8000-0000000000c9')
  expect(posts).toEqual([])
})
