// A room's Files list and ⌘K's recent files, on the web (docs/decisions/20261120-project-is-room.md D8):
// - the header's Files (a channel, a 1:1, a group chat; never a project's chat room, which has the project's button)
//   opens the list on the room's right in the side chat's place, and closes it again;
// - the list: each file's name, who sent it, when and its size, newest first; Load more for the next page; a row opens
//   the file viewer; plain words when there is none yet; a team room's group folder link at its top;
// - ⌘K before anything is typed: "Recent files" (at most five), a row opening the file viewer.
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { act } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { uuidv7, type Me, type Room, type RoomFileSearchHit } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import RoomPage from '../../src/pages/Room'
import SearchDialog from '../../src/components/SearchDialog'
import { closeImageViewer, getImageViewer } from '../../src/lib/imageViewer'
import { useRooms } from '../../src/store/rooms'
import { useSession } from '../../src/store/session'
import { useUi } from '../../src/store/ui'
import { installDom, mount, removeDom, type FakeElement } from './dom-host'
import { at, BEN, CY, ME, room } from './rooms-fixtures'

setDefaultTimeout(30_000)
const en = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate('en', key, vars)
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const me = {
  user: { id: ME.id, username: ME.id, name: ME.name, email: null, role: 'member', locale: 'en', localeChoice: null, mustChangePassword: false, prefs: {} },
  groups: [], team: { name: 'Acme', defaultLocale: 'en' }, session: { id: uuidv7(), client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' },
  server: { version: '0', dev: false, deployment: 'hosted', allChatsConfidential: false },
} as unknown as Me
const hit = (roomId: string, name: string, o: Partial<RoomFileSearchHit> = {}): RoomFileSearchHit => ({
  file: { id: uuidv7(), name, size: 2048, mime: 'application/pdf', kind: 'pdf', thumb: false }, messageId: uuidv7(), roomId, threadRootId: null, author: BEN, createdAt: at(-4), ...o,
})

let routes: Record<string, (url: URL) => Response> = {}
let asked: string[] = []
const realFetch = globalThis.fetch
const before = { locale: useLocaleStore.getState().locale, status: useSession.getState().status }
beforeAll(() => {
  installDom()
  ;(globalThis as { CSS?: unknown }).CSS = { escape: (s: string) => s, supports: () => false }
  useLocaleStore.setState({ locale: 'en' })
  useSession.setState({ status: { kind: 'signed-in', me } } as never)
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://x')
    const key = `${init?.method ?? 'GET'} ${url.pathname}`
    asked.push(`${key}${url.search}`)
    return routes[key]?.(url) ?? json({ error: { code: 'not_found', message: `no route ${key}` } }, 404)
  }) as unknown as typeof fetch
})
afterEach(() => {
  routes = {}
  asked = []
  closeImageViewer()
  useUi.setState({ toasts: [], searchOpen: false })
  useRooms.getState().reset()
})
afterAll(() => {
  globalThis.fetch = realFetch
  removeDom()
  useLocaleStore.setState({ locale: before.locale })
  useSession.setState({ status: before.status })
})

const serveRoom = (r: Room, files: (url: URL) => Response) => {
  routes = {
    [`GET /api/rooms/${r.id}`]: () => json(r),
    [`GET /api/rooms/${r.id}/messages`]: () => json({ items: [], nextCursor: null }),
    [`GET /api/rooms/${r.id}/members`]: () => json({ items: [ME, BEN, CY].map((user) => ({ user, joinedAt: at(-60) })) }),
    [`GET /api/rooms/${r.id}/ai`]: () => json({ answering: 0, mine: [] }),
    [`GET /api/rooms/${r.id}/ai/requests`]: () => json({ items: [] }),
    [`GET /api/rooms/${r.id}/files`]: files,
    'GET /api/chats': () => json({ items: [], nextCursor: null }),
  }
  useRooms.setState({ rooms: [r], loaded: true })
}
const roomPage = (id: string) => mount(
  <MemoryRouter initialEntries={[`/rooms/${id}`]}>
    <Routes><Route path="/rooms/:roomId" element={<RoomPage />} /></Routes>
  </MemoryRouter>,
)
const rowsOf = (el: FakeElement) => el.querySelectorAll('[data-testid="room-files-row"]')

describe('the room\'s Files list', () => {
  test('a group chat: Files opens the list (name, sender, date, size), pages, a row opens the viewer, Files closes it', async () => {
    const r = room({ kind: 'group', name: 'Launch crew', groupId: null })
    const first = [hit(r.id, 'brief.pdf'), hit(r.id, 'budget.xlsx', { author: CY, file: { id: uuidv7(), name: 'budget.xlsx', size: 1_500_000, mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', kind: 'spreadsheet', thumb: false } })]
    const second = [hit(r.id, 'old notes.txt')]
    serveRoom(r, (url) => json(url.searchParams.get('cursor') === 'p2' ? { items: second, nextCursor: null } : { items: first, nextCursor: 'p2' }))
    const m = await roomPage(r.id)
    try {
      await m.until(() => m.find('room-files-button'), 'the Files button', 3000)
      expect(m.get('room-files-button').getAttribute('aria-label')).toBe(en('rooms.files.open'))
      await m.click('room-files-button')
      await m.until(() => m.find('room-files-list'), 'the list', 3000)
      expect(useRooms.getState().side[r.id]).toBe('files')
      expect(m.get('room-files-panel').getAttribute('aria-label')).toBe(en('rooms.files.title'))
      const rows = rowsOf(m.get('room-files-list'))
      expect([...rows].map((x) => x.getAttribute('data-file-name'))).toEqual(['brief.pdf', 'budget.xlsx'])
      const meta = [...m.container.ownerDocument!.body.querySelectorAll('[data-testid="room-files-meta"]')].map((x) => x.textContent)
      expect(meta[0]).toContain('Ben')
      expect(meta[0]).toContain('2 KB')
      expect(meta[1]).toContain('Cy Park')
      await m.click('room-files-more')
      await m.until(() => rowsOf(m.get('room-files-list')).length === 3, 'the second page')
      expect(asked.some((a) => a.includes(`/api/rooms/${r.id}/files?cursor=p2`))).toBe(true)
      expect(m.find('room-files-more')).toBeNull()
      // a row opens the file viewer with the room's file
      const open = rowsOf(m.get('room-files-list'))[0]!.querySelector('button, a') as FakeElement
      await m.click(open)
      expect(getImageViewer()?.entry.item.key).toBe(`room:${r.id}:${first[0]!.file.id}`)
      closeImageViewer()
      // Files again closes it; ✦ would take its place
      await m.click('room-files-button')
      await m.until(() => !m.find('room-files-panel'), 'the list closed')
      expect(useRooms.getState().side[r.id]).toBeUndefined()
    } finally { await m.unmount() }
  })

  test('no files yet: plain words; a team room with a folder: its link at the top of the list, not in the header', async () => {
    const r = room({ name: 'design', groupFolder: 'groups/design' })
    serveRoom(r, () => json({ items: [], nextCursor: null }))
    const m = await roomPage(r.id)
    try {
      await m.until(() => m.find('room-files-button'), 'the Files button', 3000)
      expect(m.find('room-group-files')).toBeNull()
      await m.click('room-files-button')
      await m.until(() => m.find('room-files') && m.get('room-files').textContent?.includes(en('rooms.files.empty')), 'the empty state', 3000)
      expect(m.get('room-files').textContent).toContain(en('rooms.files.emptyHint'))
      expect(m.get('room-files-folder').getAttribute('href')).toBe(`/files?path=${encodeURIComponent('groups/design')}`)
      expect(m.get('room-files-folder').textContent).toBe(en('rooms.groupFilesTip', { name: 'design' }))
    } finally { await m.unmount() }
  })

  test('the side chat and the list share one place: opening one closes the other', async () => {
    const r = room({ kind: 'dm', name: null, peers: [BEN], memberCount: 2, groupId: null })
    serveRoom(r, () => json({ items: [hit(r.id, 'dm.pdf')], nextCursor: null }))
    useRooms.getState().setSide(r.id, 'trina')
    const m = await roomPage(r.id)
    try {
      await m.until(() => m.find('room-files-button'), 'the Files button', 3000)
      await m.click('room-files-button')
      await m.until(() => m.find('room-files-list'), 'the list', 3000)
      expect(m.find('room-side-chat')).toBeNull()
    } finally { await m.unmount() }
  })

  test('a project\'s chat room has no Files button (its files are the project\'s)', async () => {
    const r = room({ kind: 'group', name: 'Launch site', groupId: null, project: { id: uuidv7(), name: 'Launch site', folderPath: 'projects/Launch site', canSave: true, room: true } })
    serveRoom(r, () => json({ error: { code: 'not_found', message: 'x' } }, 404))
    const m = await roomPage(r.id)
    try {
      await m.until(() => m.find('room-project'), 'the project button', 3000)
      expect(m.find('room-files-button')).toBeNull()
      expect(asked.some((a) => a.includes('/files'))).toBe(false)
    } finally { await m.unmount() }
  })

  test('the list could not be read: says so, and Try again reads it again', async () => {
    const r = room({ kind: 'group', name: 'Flaky', groupId: null })
    let fail = true
    serveRoom(r, () => (fail ? json({ error: { code: 'internal', message: 'x' } }, 500) : json({ items: [hit(r.id, 'later.pdf')], nextCursor: null })))
    useRooms.getState().setSide(r.id, 'files')
    const m = await roomPage(r.id)
    try {
      await m.until(() => m.find('room-files')?.textContent?.includes(en('rooms.files.loadError')), 'the error', 3000)
      fail = false
      const retry = m.get('room-files').querySelector('[role="alert"]')?.querySelector('button') as FakeElement | undefined
      expect(retry).toBeTruthy()
      await m.click(retry!)
      await m.until(() => m.find('room-files-list'), 'the list after retry', 3000)
    } finally { await m.unmount() }
  })
})

describe('⌘K before anything is typed', () => {
  const TEAM = room({ name: 'acme-design' })
  test('"Recent files": at most five, with who sent it and where; a row opens the file viewer and closes search', async () => {
    const items = Array.from({ length: 5 }, (_, i) => hit(TEAM.id, `recent ${i}.pdf`))
    routes = {
      'GET /api/room-files/recent': () => json({ items, rooms: [{ id: TEAM.id, kind: 'team', name: 'acme-design', peers: [BEN], memberCount: 3 }] }),
      'GET /api/chats': () => json({ items: [], nextCursor: null }),
      'GET /api/projects': () => json({ items: [] }),
      'GET /api/skills': () => json({ items: [] }),
      'GET /api/schedules': () => json({ items: [] }),
      'GET /api/integrations': () => json({ items: [], personalAllowed: false }),
      'GET /api/rooms': () => json({ items: [TEAM] }),
    }
    useRooms.setState({ rooms: [TEAM], loaded: true })
    useUi.setState({ searchOpen: true })
    const m = await mount(<MemoryRouter initialEntries={['/']}><SearchDialog /></MemoryRouter>)
    try {
      const body = m.container.ownerDocument!.body
      const section = await m.until(() => body.querySelector('[data-testid="search-section-recentFiles"]'), 'the Recent files section', 3000)
      expect(section.textContent).toContain(en('search.recentFiles'))
      const rows = section.querySelectorAll('[role="option"]')
      expect(rows.length).toBe(5)
      expect(rows[0]!.textContent).toContain('recent 0.pdf')
      expect(rows[0]!.querySelector('[data-testid="search-room-file-where"]')?.textContent).toContain('Ben')
      await act(async () => { rows[0]!.click() })
      await m.settle(50)
      expect(getImageViewer()?.entry.item.key).toBe(`room:${TEAM.id}:${items[0]!.file.id}`)
      expect(useUi.getState().searchOpen).toBe(false)
    } finally { await m.unmount() }
  })
})
