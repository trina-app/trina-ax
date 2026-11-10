// Who asked, in a shared project chat (components/chat/Messages.tsx MessageAuthor; docs/DECISIONS.md "Shared project
// chats"): every question, mine too, has one quiet row above it with the sender's name and picture. The picture comes
// from the people directory, which the row reads itself (a chat page outside the rooms has nobody else to read it); my
// own photo comes from /api/me while the directory has none. A person without a photo gets the letter, a question
// without an author an empty tile and "알 수 없는 사용자". A private chat shows no row at all.
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act } from 'react'
import { MemoryRouter } from 'react-router-dom'
import type { Me } from '@mycel/shared/api'
import { UserMessage } from '../../src/components/chat/Messages'
import { useLocaleStore } from '../../src/i18n'
import { usePeople } from '../../src/store/people'
import { useSession } from '../../src/store/session'
import { CHAT, msg } from './fixtures'
import { installDom, mount, removeDom, type FakeElement } from './dom-host'

const ALEX = { id: 'alex', name: 'Alex' }
const BOB = { id: 'bob', name: 'Bob' }
const me = (avatarVersion?: number): Me => ({
  user: { id: ALEX.id, username: 'alex', name: ALEX.name, email: null, role: 'member', locale: 'ko', localeChoice: null, mustChangePassword: false, prefs: {}, ...(avatarVersion ? { avatarVersion } : {}) },
  groups: [], team: { name: 'Acme', defaultLocale: 'ko', chatTrashRetentionDays: 14 }, session: { id: '01900000-0000-7000-8000-00000000000a', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' },
  server: { version: '0', dev: false, deployment: 'hosted' },
} as unknown as Me)

const realFetch = globalThis.fetch
const locale = useLocaleStore.getState().locale
const status = useSession.getState().status
/** what GET /api/people answers (null: it fails) */
let directory: { id: string; name: string; avatarVersion?: number }[] | null = []
let peopleCalls = 0
const json = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } })
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'ko' })
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).split('?')[0] === '/api/people') {
      peopleCalls++
      return directory ? json({ people: directory }) : json({ error: { code: 'internal', message: 'down' } }, 500)
    }
    return json({ error: { code: 'not_found', message: 'not here' } }, 404)
  }) as unknown as typeof fetch
})
afterEach(() => {
  usePeople.getState().reset()
  useSession.setState({ status })
  peopleCalls = 0
})
afterAll(() => {
  globalThis.fetch = realFetch
  useLocaleStore.setState({ locale })
  removeDom()
})

const question = (author: { id: string; name: string } | null, content: string) => ({ ...msg({ role: 'user', content, author }), local: undefined }) as never
const rows = (root: FakeElement) => root.querySelectorAll('[data-testid="message-author-row"]')

test('a shared chat: my question and Bob\'s each have a name and a picture above the bubble, mine with my own name', async () => {
  directory = [{ ...ALEX }, { ...BOB, avatarVersion: 3 }]
  useSession.setState({ status: { kind: 'signed-in', me: me() } } as never)
  const page = await mount(
    <MemoryRouter>
      <div data-testid="mine"><UserMessage m={question(ALEX, '출시 일정 정리해 줘')} chatId={CHAT} busy={false} onEdit={() => {}} onSelectBranch={() => {}} showAuthor /></div>
      <div data-testid="bobs"><UserMessage m={question(BOB, '안내 문구도 써 줘')} chatId={CHAT} busy={false} onEdit={() => {}} onSelectBranch={() => {}} showAuthor canEdit={false} /></div>
    </MemoryRouter>,
  )
  try {
    // the row reads the directory itself, once for both rows
    await page.until(() => page.get('bobs').querySelector('img'), 'Bob\'s photo')
    expect(peopleCalls).toBe(1)
    const mine = page.get('mine')
    const bobs = page.get('bobs')
    expect(rows(mine).length).toBe(1)
    expect(rows(bobs).length).toBe(1)
    // my name, not "나"
    expect(mine.querySelector('[data-testid="message-author"]')!.textContent).toBe('Alex')
    expect(bobs.querySelector('[data-testid="message-author"]')!.textContent).toBe('Bob')
    // Bob has a photo: an <img> of his photo's address, decorative; I have none: my letter on a tile
    const img = bobs.querySelector('img')!
    expect(img.getAttribute('src')).toContain('/api/people/bob/avatar')
    expect(img.getAttribute('alt')).toBe('')
    expect(img.getAttribute('aria-hidden')).toBe('true')
    expect(mine.querySelector('img')).toBeNull()
    const tile = rows(mine)[0]!.querySelector('[aria-hidden="true"]')!
    expect(tile.textContent).toBe('A')
    // one row only (it replaces the name line), above the bubble, so the name is read once and first
    const box = mine.querySelector('[data-testid="user-message"]')!
    expect(box.children[0]!.getAttribute('data-testid')).toBe('message-author-row')
    expect(page.html().match(/>Alex</g)!.length).toBe(1)
    // a long name stays on one line, cut with an ellipsis
    expect(mine.querySelector('[data-testid="message-author"]')!.getAttribute('class')).toContain('truncate')
    expect(rows(mine)[0]!.getAttribute('class')).toContain('max-w-[85%]')
  } finally {
    await page.unmount()
  }
})

test('a name that ends in 님 shows as it is (never "님님"); without a directory the letter, and my photo from /api/me', async () => {
  directory = null
  useSession.setState({ status: { kind: 'signed-in', me: me(7) } } as never)
  const KIM = { id: 'kim', name: '김대리님' }
  const page = await mount(
    <MemoryRouter>
      <div data-testid="mine"><UserMessage m={question(ALEX, '하나')} chatId={CHAT} busy={false} onEdit={() => {}} onSelectBranch={() => {}} showAuthor /></div>
      <div data-testid="kims"><UserMessage m={question(KIM, '둘')} chatId={CHAT} busy={false} onEdit={() => {}} onSelectBranch={() => {}} showAuthor canEdit={false} /></div>
    </MemoryRouter>,
  )
  try {
    await page.until(() => usePeople.getState().failed, 'the directory to fail')
    await page.settle()
    expect(page.get('kims').querySelector('[data-testid="message-author"]')!.textContent).toBe('김대리님')
    expect(page.html()).not.toContain('님님')
    // the directory failed: Kim's letter, never a broken message
    expect(page.get('kims').querySelector('img')).toBeNull()
    expect(rows(page.get('kims'))[0]!.querySelector('[aria-hidden="true"]')!.textContent).toBe('김')
    expect(page.get('kims').querySelector('[data-testid="user-text"]')!.textContent).toBe('둘')
    // my own photo is known from /api/me
    expect(page.get('mine').querySelector('img')!.getAttribute('src')).toContain('/api/people/alex/avatar')
  } finally {
    await page.unmount()
  }
})

test('a name changed since the messages were read shows at once: the directory has it (as in rooms)', async () => {
  directory = [{ id: BOB.id, name: 'Robert' }]
  useSession.setState({ status: { kind: 'signed-in', me: me() } } as never)
  const page = await mount(<MemoryRouter><UserMessage m={question(BOB, '안내 문구도 써 줘')} chatId={CHAT} busy={false} onEdit={() => {}} onSelectBranch={() => {}} showAuthor canEdit={false} /></MemoryRouter>)
  try {
    await page.until(() => page.get('message-author').textContent === 'Robert', 'the directory\'s name')
    expect(rows(page.container)[0]!.querySelector('[aria-hidden="true"]')!.textContent).toBe('R')
  } finally {
    await page.unmount()
  }
})

test('a question without an author: an empty tile and "알 수 없는 사용자"', async () => {
  directory = []
  useSession.setState({ status: { kind: 'signed-in', me: me() } } as never)
  const page = await mount(<MemoryRouter><UserMessage m={question(null, '누가 물었나')} chatId={CHAT} busy={false} onEdit={() => {}} onSelectBranch={() => {}} showAuthor canEdit={false} /></MemoryRouter>)
  try {
    expect(page.get('message-author').textContent).toBe('알 수 없는 사용자')
    const tile = page.get('message-author-unknown')
    expect(tile.getAttribute('aria-hidden')).toBe('true')
    expect(tile.textContent).toBe('')
    expect(page.find('message-author-row')!.querySelector('img')).toBeNull()
  } finally {
    await page.unmount()
  }
})

test('a private chat stays as it was: no name, no picture, no directory request', async () => {
  directory = [{ ...ALEX, avatarVersion: 2 }]
  useSession.setState({ status: { kind: 'signed-in', me: me(2) } } as never)
  const page = await mount(<MemoryRouter><UserMessage m={question(ALEX, '회의록 요약해 줘')} chatId={CHAT} busy={false} onEdit={() => {}} onSelectBranch={() => {}} /></MemoryRouter>)
  try {
    await act(async () => { await new Promise((r) => setTimeout(r, 30)) })
    expect(page.find('message-author-row')).toBeNull()
    expect(page.find('message-author')).toBeNull()
    expect(page.get('user-message').querySelector('img')).toBeNull()
    expect(page.html()).not.toContain('Alex')
    expect(peopleCalls).toBe(0)
  } finally {
    await page.unmount()
  }
})
