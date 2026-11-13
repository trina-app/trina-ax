// Projects and Files lists open at once (docs/DECISIONS.md "Projects and Files lists open at once"): going back to the
// Projects page (GET /api/projects?manage=1), 파일's places (GET /api/files/tree?path=) or 최근 파일 (GET
// /api/files/recent) shows the list as last read, with no loading placeholder, and reads it once behind it; the
// placeholder shows only on the very first read. One request at a time; a read started before a sign-out never lands,
// and a sign-out empties them (App.tsx dropPersonStores), so the next person starts from a first visit.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import type { FileEntry, Me, Project } from '@mycel/shared/api'
import { useLocaleStore } from '../../src/i18n'
import { ProjectList } from '../../src/pages/Projects'
import RecentFiles from '../../src/pages/RecentFiles'
import { FilesPanel } from '../../src/components/panels/FilesPanel'
import { DialogHost } from '../../src/components/ui'
import { readManagedList, useProjects } from '../../src/store/projects'
import { readRecentFiles, readTeamTop, useFileLists } from '../../src/store/fileLists'
import { filesChanged } from '../../src/store/live'
import { useSession } from '../../src/store/session'
import { installDom, mount, removeDom, type Mounted } from './dom-host'

const P1 = '01900000-0000-7000-8000-000000000021', P2 = '01900000-0000-7000-8000-000000000022', P3 = '01900000-0000-7000-8000-000000000023'
const project = (id: string, name: string, o: Partial<Project> = {}): Project =>
  ({ id, name, folderPath: `shared/${name.toLowerCase().replace(/ /g, '-')}`, instructions: '', createdBy: null, createdAt: '2026-11-03T00:00:00.000Z', canEdit: true, ...o })
const entry = (path: string, type: 'file' | 'folder' = 'file'): FileEntry =>
  ({ path, name: path.split('/').at(-1)!, type, size: type === 'file' ? 1 : null, mtime: '2026-11-12T00:00:00.000Z', mime: null, access: 'write' })
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

let projects: Project[] = []
let top: FileEntry[] = []
let recent: FileEntry[] = []
/** answers held back until released (a read on its way) */
let hold: Promise<void> | null = null
let failing = false
const reads: string[] = []
const me = { user: { id: 'mia', username: 'mia', name: 'Mia', email: null, role: 'member', locale: 'ko', localeChoice: null, mustChangePassword: false, prefs: {} }, groups: [],
  team: { name: 'Acme', defaultLocale: 'ko' }, session: { id: '01900000-0000-7000-8000-000000000099', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' }, server: { version: '0', dev: false, timeZone: 'Asia/Seoul' } } as unknown as Me
const statusBefore = useSession.getState().status
const realFetch = globalThis.fetch
const localeBefore = useLocaleStore.getState().locale
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'ko' })
  useSession.setState({ status: { kind: 'signed-in', me } } as never)
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://x')
    const key = `${init?.method ?? 'GET'} ${url.pathname}${url.search}`
    reads.push(key)
    if (hold) await hold
    if (failing) return json(503, { error: { code: 'unavailable', message: 'down' } })
    if (key === 'GET /api/projects?manage=1') return json(200, { items: projects })
    if (key === 'GET /api/projects') return json(200, { items: projects })
    if (url.pathname === '/api/files/tree') return json(200, { path: '', access: 'read', entries: top, nextCursor: null })
    if (url.pathname === '/api/files/recent') return json(200, { items: recent, truncated: false })
    if (url.pathname === '/api/chats/groups') return json(200, { groups: [], projectActivity: [] })
    return json(404, { error: { code: 'not_found', message: `no route ${key}` } })
  }) as unknown as typeof fetch
})
afterAll(() => {
  globalThis.fetch = realFetch
  removeDom()
  useLocaleStore.setState({ locale: localeBefore })
  useSession.setState({ status: statusBefore })
})
beforeEach(() => {
  projects = [project(P1, 'Acme launch'), project(P2, 'Acme sales')]
  top = [entry('shared', 'folder'), entry('groups', 'folder'), entry('loose.txt')]
  recent = [entry('shared/plan.md'), entry('shared/folder-a', 'folder'), entry('shared/notes.txt')]
  hold = null
  failing = false
  reads.length = 0
  useProjects.getState().reset()
  useFileLists.getState().reset()
})

const skeleton = (m: Mounted) => m.html().includes('animate-pulse')
const all = (m: Mounted, testId: string) => m.container.querySelectorAll(`[data-testid="${testId}"]`).length
const count = (pattern: RegExp) => reads.filter((r) => pattern.test(r)).length
const MANAGE = /^GET \/api\/projects\?manage=1$/, TREE = /^GET \/api\/files\/tree\?path=$/, RECENT = /^GET \/api\/files\/recent/

describe('the lists in memory', () => {
  test('the Projects list: one read at a time, kept in its order; a save or a delete here changes it in place', async () => {
    await Promise.all([readManagedList(), readManagedList()])
    expect(count(MANAGE)).toBe(1)
    expect(useProjects.getState().managed!.map((p) => p.name)).toEqual(['Acme launch', 'Acme sales'])
    // a rename saved anywhere (the project page, the dialog) is the list's too
    useProjects.getState().put({ ...projects[1]!, name: 'Acme sales 2' })
    expect(useProjects.getState().managed!.map((p) => p.name)).toEqual(['Acme launch', 'Acme sales 2'])
    // a plain read's not_found (a chat's project, ChatProject.tsx) may be a project an admin manages without being in
    // it: it stays on the Projects page; a delete there takes it off
    useProjects.getState().drop(P1)
    expect(useProjects.getState().managed!.map((p) => p.id)).toEqual([P1, P2])
    useProjects.getState().drop(P1, true)
    expect(useProjects.getState().managed!.map((p) => p.id)).toEqual([P2])
    // a failed read leaves what was there
    failing = true
    await expect(readManagedList()).rejects.toBeDefined()
    expect(useProjects.getState().managed!.map((p) => p.id)).toEqual([P2])
  })

  test('a read started before a sign-out never lands: the next person sees nothing of the last one\'s', async () => {
    let release!: () => void
    hold = new Promise((r) => (release = r))
    const p = readManagedList(), q = readTeamTop(), r = readRecentFiles()
    useProjects.getState().reset()
    useFileLists.getState().reset()
    release()
    await Promise.allSettled([p, q, r])
    expect(useProjects.getState().managed).toBeNull()
    expect(useProjects.getState().byId).toEqual({})
    expect(useFileLists.getState().top).toBeNull()
    expect(useFileLists.getState().recent).toBeNull()
  })

  test('파일\'s lists: one read at a time each; 최근 파일 keeps files only', async () => {
    await Promise.all([readTeamTop(), readTeamTop(), readRecentFiles(), readRecentFiles()])
    expect([count(TREE), count(RECENT)]).toEqual([1, 1])
    expect(useFileLists.getState().top!.map((e) => e.path)).toEqual(['shared', 'groups', 'loose.txt'])
    expect(useFileLists.getState().recent!.map((e) => e.path)).toEqual(['shared/plan.md', 'shared/notes.txt'])
  })
})

describe('asked again while a read is on its way', () => {
  test('a file event during a read reads once more after it (the first answer may be from before the change)', async () => {
    let release!: () => void
    hold = new Promise((r) => (release = r))
    const first = readRecentFiles()
    // the event's read joins the one on its way
    void readRecentFiles({ fresh: true })
    void readRecentFiles({ fresh: true })
    recent = [entry('shared/new.md'), ...recent]
    release()
    await first
    await Promise.resolve()
    const until = Date.now() + 2000
    while (useFileLists.getState().recent!.length < 3 && Date.now() < until) await new Promise((r) => setTimeout(r, 5))
    expect(count(RECENT)).toBe(2)
    expect(useFileLists.getState().recent!.map((e) => e.path)).toEqual(['shared/new.md', 'shared/plan.md', 'shared/notes.txt'])
  })

  test('a delete made here while the Projects list was asked: that answer does not bring the card back', async () => {
    await readManagedList()
    let release!: () => void
    hold = new Promise((r) => (release = r))
    const read = readManagedList()
    // deleted on this page while the read was on its way (the server answered before the delete)
    useProjects.getState().setManaged((xs) => xs.filter((x) => x.id !== P1))
    const answered = projects
    projects = projects.filter((p) => p.id !== P1)
    release()
    await read
    expect(answered).toHaveLength(2)
    expect(useProjects.getState().managed!.map((p) => p.id)).toEqual([P2])
    // read once more after it, which is the server's own list now
    expect(count(MANAGE)).toBe(3)
  })
})

describe('a visit after the first', () => {
  test('the Projects page: the last list at once, no placeholder, one read behind it that brings what changed', async () => {
    let open!: () => void
    hold = new Promise((r) => (open = r))
    const first = await mount(<MemoryRouter><ProjectList /><DialogHost /></MemoryRouter>)
    try {
      expect(skeleton(first)).toBe(true)
      open()
      await first.until(() => all(first, 'project-card') === 2, 'the cards')
    } finally {
      await first.unmount()
    }
    projects = [...projects, project(P3, 'Acme finance')]
    reads.length = 0
    let release!: () => void
    hold = new Promise((r) => (release = r))
    const again = await mount(<MemoryRouter><ProjectList /><DialogHost /></MemoryRouter>)
    try {
      expect(skeleton(again)).toBe(false)
      expect(all(again, 'project-card')).toBe(2)
      release()
      await again.until(() => all(again, 'project-card') === 3, 'the new card')
      expect(skeleton(again)).toBe(false)
      expect(count(MANAGE)).toBe(1)
    } finally {
      await again.unmount()
    }
  })

  test('최근 파일 and 파일\'s places: at once, one read each behind them; a file event reads again', async () => {
    const view = () => mount(<MemoryRouter initialEntries={['/files?view=recent']}><FilesPanel /><RecentFiles /></MemoryRouter>)
    let open!: () => void
    hold = new Promise((r) => (open = r))
    const first = await view()
    try {
      expect(skeleton(first)).toBe(true)
      open()
      await first.until(() => all(first, 'recent-file') === 2 && all(first, 'files-panel-team') === 2, 'the lists')
    } finally {
      await first.unmount()
    }
    recent = [entry('shared/new.md'), ...recent]
    reads.length = 0
    let release!: () => void
    hold = new Promise((r) => (release = r))
    const again = await view()
    try {
      expect(skeleton(again)).toBe(false)
      expect(all(again, 'recent-file')).toBe(2)
      expect(all(again, 'files-panel-team')).toBe(2)
      release()
      await again.until(() => all(again, 'recent-file') === 3, 'the new file')
      expect([count(TREE), count(RECENT)]).toEqual([1, 1])
      // a file changed elsewhere: read again (the place stays on screen meanwhile)
      recent = [entry('shared/newer.md'), ...recent]
      filesChanged.emit([{ path: 'shared/newer.md', change: 'created' } as never])
      await again.until(() => all(again, 'recent-file') === 4, 'the newer file')
      expect(skeleton(again)).toBe(false)
    } finally {
      await again.unmount()
    }
  })

  test('after a sign-out the next visit is a first one again (the placeholder, nothing of the last person\'s)', async () => {
    await Promise.all([readManagedList(), readRecentFiles()])
    useProjects.getState().reset()
    useFileLists.getState().reset()
    let release!: () => void
    hold = new Promise((r) => (release = r))
    const m = await mount(<MemoryRouter><ProjectList /><DialogHost /></MemoryRouter>)
    try {
      expect(skeleton(m)).toBe(true)
      expect(all(m, 'project-card')).toBe(0)
      release()
      await m.until(() => all(m, 'project-card') === 2, 'the cards')
    } finally {
      await m.unmount()
    }
  })
})
