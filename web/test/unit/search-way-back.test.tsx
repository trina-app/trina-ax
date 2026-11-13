// Getting back to earlier work in ⌘K (docs/DECISIONS.md "Getting back to earlier work, part A"; components/SearchDialog.tsx):
//   - "Needs attention" shows the sidebar's own markers and words from the sidebar's own chat list (QA TC-419): a chat
//     waiting for my answer is "?" with "답을 기다려요" (it said "답하는 중"), a finished answer I have not seen is there
//     with the dot and "새 답" (it was missing);
//   - History rows, the list and the search results, say when the chat was last active and its project, grey on the
//     right (QA TC-420);
//   - opened on a project's page or in a chat of a project, History lists that project's chats first; anywhere else the
//     order stays (QA TC-421).
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { uuidv7, type Chat, type Me } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import SearchDialog from '../../src/components/SearchDialog'
import { formatRelative } from '../../src/lib/format'
import { useChats } from '../../src/store/chats'
import { useSession } from '../../src/store/session'
import { useSessionMarkers } from '../../src/store/sessionMarkers'
import { useUi } from '../../src/store/ui'
import { installDom, mount, removeDom, type FakeElement } from './dom-host'

setDefaultTimeout(30_000)
const ko = (k: Parameters<typeof translate>[1], p?: Record<string, string | number>) => translate('ko', k, p)
const json = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } })
const me = { user: { id: 'alex', username: 'alex', name: 'Alex', email: null, role: 'member', locale: 'ko', localeChoice: null, mustChangePassword: false, prefs: {} }, groups: [],
  team: { name: 'Acme', defaultLocale: 'ko' }, session: { id: '01900000-0000-7000-8000-00000000000a', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' }, server: { version: '0', dev: false } } as unknown as Me

const P = uuidv7(), OTHER = uuidv7()
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()
function chat(o: Partial<Chat> & { title: string }): Chat {
  return { id: uuidv7(), projectId: null, engine: 'claude-code', model: null, createdAt: ago(600), updatedAt: ago(10), deletedAt: null, runState: 'idle', ...o }
}
const PROJECTS = [{ id: P, name: 'Launch plan', folderPath: 'projects/launch', instructions: '', createdBy: null, createdAt: ago(900), canEdit: true },
  { id: OTHER, name: 'Board', folderPath: 'projects/board', instructions: '', createdBy: null, createdAt: ago(900), canEdit: true }]

/** my chat list as the server answers it (GET /api/chats), the project's (with projectId), a search's (with q) */
let mine: Chat[] = []
let ofProject: Chat[] = []
let found: Chat[] = []
const asked: string[] = []
const realFetch = globalThis.fetch
const locale = useLocaleStore.getState().locale
const status = useSession.getState().status
beforeAll(() => {
  installDom()
  ;(globalThis as { CSS?: unknown }).CSS = { escape: (s: string) => s, supports: () => false }
  useLocaleStore.setState({ locale: 'ko' })
  useSession.setState({ status: { kind: 'signed-in', me } } as never)
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://x')
    asked.push(`${url.pathname}${url.search}`)
    const one = url.pathname.match(/^\/api\/chats\/([^/]+)$/)
    if (one) {
      const c = [...mine, ...ofProject].find((x) => x.id === one[1])
      return c ? json(c) : json({ error: { code: 'not_found', message: 'no' } }, 404)
    }
    switch (url.pathname) {
      case '/api/chats': {
        const project = url.searchParams.get('projectId')
        // a project this person does not see (or not there any more): the server's 404
        if (project && project !== P) return json({ error: { code: 'not_found', message: 'no' } }, 404)
        return json({ items: project ? ofProject : url.searchParams.get('q') ? found : mine, nextCursor: null })
      }
      case '/api/projects': return json({ items: PROJECTS })
      case '/api/skills': case '/api/schedules': return json({ items: [] })
      case '/api/integrations': return json({ items: [], personalAllowed: false })
      case '/api/notifications': return json({ items: [], unreadCount: 0, nextCursor: null })
      case '/api/files/find': return json({ items: [], truncated: false })
      case '/api/room-files': case '/api/room-messages': return json({ items: [], rooms: [], nextCursor: null })
      case '/api/people': return json({ items: [] })
      case '/api/rooms': return json({ items: [] })
      default: return json({ error: { code: 'not_found', message: url.pathname } }, 404)
    }
  }) as typeof fetch
})
afterAll(() => {
  globalThis.fetch = realFetch
  useLocaleStore.setState({ locale })
  useSession.setState({ status })
  removeDom()
})
afterEach(() => {
  asked.length = 0
  mine = []; ofProject = []; found = []
  useUi.setState({ searchOpen: false })
  useChats.setState({ chats: [], others: {}, chatsLoaded: false, requests: {} })
  useSessionMarkers.setState({ onScreen: null })
})

async function openAt(path: string) {
  useUi.setState({ searchOpen: true })
  const v = await mount(
    <MemoryRouter initialEntries={[path]}>
      <SearchDialog />
      <Routes><Route path="*" element={null} /></Routes>
    </MemoryRouter>,
  )
  const input = v.container.ownerDocument!.body.querySelector('input[role="combobox"]') as FakeElement
  return { v, input }
}
const rowsIn = (section: FakeElement) => section.querySelectorAll('[role="option"]') as unknown as FakeElement[]
const titleOf = (row: FakeElement) => row.querySelector('[data-testid="search-row-name"]')!.childNodes[0]!.textContent
/** the History tab, once its rows are there */
async function history(v: Awaited<ReturnType<typeof openAt>>['v'], n: number) {
  await v.click('search-tab-chats')
  return v.until(() => { const s = v.find('search-section-chats'); return s && rowsIn(s).length === n ? rowsIn(s) : null }, `${n} History rows`)
}

describe('Needs attention: the sidebar\'s markers and words (TC-419)', () => {
  test('a chat waiting for me is "?" with 답을 기다려요, a new answer is there with the dot, a running one has the ring; ⌘K\'s own words are gone', async () => {
    const waits = chat({ title: '분기 보고서', runState: 'running', waiting: true, updatedAt: ago(30) })
    const fresh = chat({ title: '견적 정리', unseen: true, updatedAt: ago(5) })
    const failed = chat({ title: '실패한 답', unseen: true, lastOutcome: 'error', updatedAt: ago(50) })
    const running = chat({ title: '긴 답', runState: 'queued', updatedAt: ago(1) })
    const idle = chat({ title: '조용한 기록', updatedAt: ago(2) })
    // the sidebar's list is the one source; the palette's own first page (GET /api/chats) knows none of them
    useChats.setState({ chats: [running, idle, fresh, waits, failed], chatsLoaded: true })
    mine = [idle]
    const { v } = await openAt('/')
    try {
      const section = await v.until(() => { const s = v.find('search-section-attention'); return s && rowsIn(s).length === 4 ? s : null }, 'the attention rows')
      const rows = rowsIn(section)
      expect(rows.map((r) => [titleOf(r), r.querySelector('[data-testid="search-row-marker"]')!.getAttribute('data-marker'), r.querySelector('[data-testid="search-marker-reason"]')!.textContent])).toEqual([
        ['분기 보고서', 'ask', ko('marker.card')],
        ['실패한 답', 'ask', ko('marker.error')],
        ['견적 정리', 'new', ko('marker.new')],
        ['긴 답', 'running', ko('marker.queued')],
      ])
      // the marker is the sidebar's own component: "?" in its pill, the dot, the ring
      expect(rows[0]!.querySelector('[data-testid="marker-ask"]')).not.toBeNull()
      expect(rows[2]!.querySelector('[data-testid="marker-new"]')).not.toBeNull()
      expect(rows[3]!.querySelector('[data-testid="marker-running"]')).not.toBeNull()
      // no second dot on the icon; the chat waiting for me no longer says it is answering
      expect(section.querySelector('[data-testid="search-attention-dot"]')).toBeNull()
      expect(rows[0]!.textContent).not.toContain(ko('marker.running'))
      // an idle chat needs nothing; the chats there are not in 최근 again
      expect(section.textContent).not.toContain('조용한 기록')
      const recents = v.get('search-section-recents')
      expect(recents.textContent).toContain('조용한 기록')
      expect(recents.textContent).not.toContain('견적 정리')
    } finally { await v.unmount() }
  })

  test('the chat on screen shows no dot, as in the sidebar', async () => {
    const fresh = chat({ title: '견적 정리', unseen: true })
    useChats.setState({ chats: [fresh], chatsLoaded: true })
    useSessionMarkers.setState({ onScreen: fresh.id, visible: true })
    const { v } = await openAt(`/c/${fresh.id}`)
    try {
      await v.until(() => v.find('search-section-actions'), 'the palette')
      expect(v.find('search-section-attention')).toBeNull()
    } finally { await v.unmount() }
  })
})

describe('History rows say when and where (TC-420)', () => {
  test('the list: the last activity, and the project for a chat in one, grey on the right', async () => {
    const a = chat({ title: 'Acme 계약서', projectId: P, updatedAt: ago(120) })
    const b = chat({ title: '메모 정리', updatedAt: ago(3) })
    mine = [b, a]
    const { v } = await openAt('/')
    try {
      const rows = await history(v, 2)
      const meta = rows.map((r) => r.querySelector('[data-testid="search-row-meta"]')!.textContent)
      expect(meta).toEqual([formatRelative(b.updatedAt, 'ko'), `${formatRelative(a.updatedAt, 'ko')} · Launch plan`])
      expect(meta[1]).toBe('2시간 전 · Launch plan')
      // the project is said once, on the right
      expect(rows[1]!.querySelector('[data-testid="search-row-name"]')!.textContent).toBe('Acme 계약서')
    } finally { await v.unmount() }
  })

  test('search results too, on 전체 and on History', async () => {
    found = [chat({ title: '계약 검토', projectId: OTHER, updatedAt: ago(60 * 26) })]
    const { v, input } = await openAt('/')
    try {
      await v.type(input, '계약')
      const section = await v.until(() => v.find('search-section-chats'), 'the History results')
      expect(rowsIn(section)[0]!.querySelector('[data-testid="search-row-meta"]')!.textContent).toBe(`${formatRelative(found[0]!.updatedAt, 'ko')} · Board`)
      await v.click('search-tab-chats')
      const again = await v.until(() => v.find('search-section-chats'), 'History results')
      expect(rowsIn(again)[0]!.querySelector('[data-testid="search-row-meta"]')!.textContent).toContain('Board')
    } finally { await v.unmount() }
  })
})

describe('History from a project (TC-421)', () => {
  const inP = () => [chat({ title: 'P 오래된', projectId: P, updatedAt: ago(500) }), chat({ title: 'P 최근', projectId: P, updatedAt: ago(200) })]
  const elsewhere = () => [chat({ title: '다른 새 기록', updatedAt: ago(1) }), chat({ title: '다른 기록', projectId: OTHER, updatedAt: ago(2) })]

  test("on a project's page: its chats first (its own list, in its order), then the rest of mine, each once", async () => {
    const p = inP(), rest = elsewhere()
    ofProject = [p[1]!, p[0]!]
    mine = [rest[0]!, rest[1]!, p[1]!]
    const { v } = await openAt(`/projects/${P}`)
    try {
      const rows = await history(v, 4)
      expect(rows.map(titleOf)).toEqual(['P 최근', 'P 오래된', '다른 새 기록', '다른 기록'])
      expect(asked).toContain(`/api/chats?projectId=${P}&limit=30`)
    } finally { await v.unmount() }
  })

  test("on a project's files: the same", async () => {
    const p = inP(), rest = elsewhere()
    ofProject = [p[1]!]
    mine = rest
    const { v } = await openAt(`/projects/${P}/files`)
    try {
      expect((await history(v, 3)).map(titleOf)).toEqual(['P 최근', '다른 새 기록', '다른 기록'])
    } finally { await v.unmount() }
  })

  test('in a chat of a project (in my list, or read once when it is not)', async () => {
    const p = inP(), rest = elsewhere()
    ofProject = [p[1]!, p[0]!]
    mine = rest
    useChats.setState({ chats: [p[0]!], chatsLoaded: true })
    const a = await openAt(`/c/${p[0]!.id}`)
    try {
      expect((await history(a.v, 4)).map(titleOf)).toEqual(['P 최근', 'P 오래된', '다른 새 기록', '다른 기록'])
      expect(asked.some((x) => x === `/api/chats/${p[0]!.id}`)).toBe(false)
    } finally { await a.v.unmount() }
    useUi.setState({ searchOpen: false })
    useChats.setState({ chats: [], chatsLoaded: true })
    asked.length = 0
    const b = await openAt(`/c/${p[1]!.id}`)
    try {
      expect((await history(b.v, 4)).map(titleOf)).toEqual(['P 최근', 'P 오래된', '다른 새 기록', '다른 기록'])
      expect(asked).toContain(`/api/chats/${p[1]!.id}`)
    } finally { await b.v.unmount() }
  })

  test('anywhere else (Home, a chat in no project): my list as it is, and no project is read', async () => {
    const p = inP(), rest = elsewhere()
    ofProject = p
    mine = [rest[0]!, p[1]!, rest[1]!]
    for (const at of ['/', `/c/${rest[0]!.id}`, '/files']) {
      useChats.setState({ chats: [rest[0]!], chatsLoaded: true })
      asked.length = 0
      const { v } = await openAt(at)
      try {
        expect({ at, rows: (await history(v, 3)).map(titleOf) }).toEqual({ at, rows: ['다른 새 기록', 'P 최근', '다른 기록'] })
        expect(asked.some((x) => x.includes('projectId='))).toBe(false)
      } finally { await v.unmount() }
      useUi.setState({ searchOpen: false })
    }
  })

  test('a project whose chats cannot be read: my list as it is', async () => {
    const rest = elsewhere()
    mine = rest
    ofProject = inP()
    const { v } = await openAt(`/projects/${uuidv7()}`)
    try {
      expect((await history(v, 2)).map(titleOf)).toEqual(['다른 새 기록', '다른 기록'])
    } finally { await v.unmount() }
  })
})
