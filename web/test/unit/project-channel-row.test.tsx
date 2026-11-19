// A private channel linked to a team project (docs/decisions/20261119-channel-project-link.md), rendered:
// - the project page's Channel: none yet (Create a channel, or link a channel), linked and I'm in it (Open, ⋯ › Unlink
//   when I may), linked and I'm not (Ask someone in the channel to add you; no Join button);
// - the two pickers' empty lines; the channel info's Project row by state;
// - Create a channel for a project: its people ticked, nobody past what a channel holds, with the line that says so;
// - the project is read again when the window comes back.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import type { Me, Project, Room } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import { ProjectHome } from '../../src/pages/Projects'
import { LinkChannelDialog, LinkProjectDialog, RoomProjectRow } from '../../src/components/rooms/ProjectLink'
import { PeoplePicker } from '../../src/components/rooms/PeoplePicker'
import { useRooms } from '../../src/store/rooms'
import { useSession } from '../../src/store/session'
import { usePeople } from '../../src/store/people'
import { useUi } from '../../src/store/ui'
import { installDom, mount, removeDom } from './dom-host'

const en = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate('en', key, vars)
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
let n = 0
const nextId = () => `01900000-0000-7000-8000-0000000002${String(++n).padStart(2, '0')}`
const ROOM = '01900000-0000-7000-8000-0000000003a1'
const project = (id: string, o: Partial<Project> = {}): Project =>
  ({ id, name: 'Launch site', folderPath: `projects/Launch site ${n}`, instructions: 'x', createdBy: { id: 'olga', name: 'Olga' }, createdAt: '2026-11-13T00:00:00.000Z', canEdit: true, canManage: true, audience: 8, ...o })
const room = (o: Partial<Room> = {}): Room =>
  ({ id: ROOM, kind: 'group', name: 'Launch', canRename: true, managerId: 'olga', groupId: null, memberCount: 7, peers: [], lastSeq: 0, unreadCount: 0, threadsUnread: 0, nextThreadId: null, mentioned: false, lastReadSeq: 0, lastMessage: null, muted: false, notify: { own: null, level: 'all' }, createdAt: '2026-11-13T00:00:00.000Z', activityAt: '2026-11-13T00:00:00.000Z', ...o }) as unknown as Room
const me = {
  user: { id: 'olga', username: 'olga', name: 'Olga', email: null, role: 'member', locale: 'en', localeChoice: null, mustChangePassword: false, prefs: {} },
  groups: [], team: { name: 'Acme', defaultLocale: 'en', projectCreators: 'members' }, session: { id: '01900000-0000-7000-8000-00000000000a', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' },
  server: { version: '0', dev: false, deployment: 'hosted' },
} as unknown as Me

let routes: Record<string, (url: string) => Response | Promise<Response>> = {}
let asked: string[] = []
const realFetch = globalThis.fetch
const before = { locale: useLocaleStore.getState().locale, status: useSession.getState().status }
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'en' })
  useSession.setState({ status: { kind: 'signed-in', me } } as never)
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const key = `${init?.method ?? 'GET'} ${url.split('?')[0]}`
    asked.push(key)
    return routes[key]?.(url) ?? json(404, { error: { code: 'not_found', message: `no route ${key}` } })
  }) as unknown as typeof fetch
})
afterEach(() => { useUi.setState({ toasts: [] }); asked = [] })
afterAll(() => {
  globalThis.fetch = realFetch
  removeDom()
  useLocaleStore.setState({ locale: before.locale })
  useSession.setState({ status: before.status })
})

const page = (id: string) => mount(
  <MemoryRouter initialEntries={[`/projects/${id}`]}>
    <Routes><Route path="/projects/:projectId" element={<ProjectHome />} /><Route path="*" element={<p data-testid="elsewhere" />} /></Routes>
  </MemoryRouter>,
)
const pageRoutes = (p: Project) => ({
  [`GET /api/projects/${p.id}`]: () => json(200, p),
  [`GET /api/projects/${p.id}/people`]: () => json(200, { people: [{ id: 'olga', name: 'Olga', creator: true }, { id: 'ben', name: 'Ben' }] }),
  'GET /api/chats': () => json(200, { items: [], nextCursor: null }),
  'GET /api/files/tree': () => json(200, { path: p.folderPath, access: 'write', entries: [], nextCursor: null }),
})

describe('the project page Channel', () => {
  test('none yet: Create a channel and link a channel', async () => {
    const id = nextId()
    routes = pageRoutes(project(id, { canLinkChannel: true }))
    const m = await page(id)
    try {
      await m.until(() => m.find('project-channel-create'), 'the channel box', 2000)
      expect(m.get('project-channel-empty').textContent).toBe(en('projects.channel.empty'))
      expect(m.get('project-channel-link').textContent).toBe(en('projects.channel.orLink'))
    } finally { await m.unmount() }
  })

  test('linked, I am in it: its name, count and Open; Unlink only when I may', async () => {
    const id = nextId()
    routes = pageRoutes(project(id, { channel: { roomId: ROOM, name: 'Launch', memberCount: 7, inIt: true, canUnlink: true } }))
    const m = await page(id)
    try {
      await m.until(() => m.find('project-channel-open'), 'the channel row', 2000)
      expect(m.get('project-channel-name').textContent).toContain('Launch')
      expect(m.get('project-channel-name').textContent).toContain(en('rooms.members', { n: 7 }))
      expect(m.find('project-channel-menu')).not.toBeNull()
      expect(m.find('project-channel-ask')).toBeNull()
    } finally { await m.unmount() }
  })

  test('linked, I am not in it: ask someone to add me; no Open, no Join, no Unlink', async () => {
    const id = nextId()
    routes = pageRoutes(project(id, { channel: { roomId: ROOM, name: 'Launch', memberCount: 7, inIt: false } }))
    const m = await page(id)
    try {
      await m.until(() => m.find('project-channel-ask'), 'the ask line', 2000)
      expect(m.get('project-channel-ask').textContent).toBe(en('projects.channel.askToJoin'))
      expect(m.find('project-channel-open')).toBeNull()
      expect(m.find('project-channel-menu')).toBeNull()
    } finally { await m.unmount() }
  })

  test('neither: no Channel at all; the project is read again when the window comes back', async () => {
    const id = nextId()
    routes = pageRoutes(project(id))
    const m = await page(id)
    try {
      await m.until(() => m.find('project-files'), 'the page', 2000)
      expect(m.find('project-channel')).toBeNull()
      const reads = () => asked.filter((k) => k === `GET /api/projects/${id}`).length
      const was = reads()
      routes[`GET /api/projects/${id}`] = () => json(200, project(id, { canLinkChannel: true }))
      window.dispatchEvent(new Event('focus'))
      await m.until(() => m.find('project-channel-create'), 'the channel box after focus', 2000)
      expect(reads()).toBeGreaterThan(was)
    } finally { await m.unmount() }
  })
})

describe('the pickers and the channel info', () => {
  test('Link to a project with nothing to link: the empty line and a way to Projects', async () => {
    routes = { 'GET /api/projects': () => json(200, { items: [project(nextId())] }) }
    const m = await mount(<MemoryRouter><LinkProjectDialog room={room({ canLinkProject: true })} onClose={() => {}} /></MemoryRouter>)
    try {
      await m.until(() => m.find('link-project-empty'), 'the empty line', 2000)
      expect(m.get('link-project-empty').textContent).toContain(en('rooms.linkProject.empty'))
      expect(m.get('link-project-empty').textContent).toContain(en('rooms.linkProject.toProjects'))
    } finally { await m.unmount() }
  })

  test('Link a channel with no free private channel: the empty line and Create a channel', async () => {
    useRooms.setState({ rooms: [room({ project: { id: nextId(), name: 'Other', folderPath: 'projects/Other', canSave: true } })], loaded: true })
    const m = await mount(<MemoryRouter><LinkChannelDialog project={project(nextId())} onClose={() => {}} onCreate={() => {}} onLinked={() => {}} /></MemoryRouter>)
    try {
      await m.until(() => m.find('link-channel-empty'), 'the empty line', 2000)
      expect(m.get('link-channel-empty').textContent).toContain(en('projects.channel.linkEmpty'))
      expect(m.find('link-channel-create')).not.toBeNull()
    } finally { await m.unmount() }
  })

  test('the Project row: linked (Unlink only with write), not linked, or none', async () => {
    const pid = nextId()
    const linked = await mount(<MemoryRouter><RoomProjectRow room={room({ project: { id: pid, name: 'Launch site', folderPath: 'projects/Launch site', canSave: true } })} /></MemoryRouter>)
    try {
      expect(linked.get('room-info-project-name').textContent).toContain('Launch site')
      expect(linked.find('room-info-project-unlink')).not.toBeNull()
    } finally { await linked.unmount() }
    const readOnly = await mount(<MemoryRouter><RoomProjectRow room={room({ project: { id: pid, name: 'Launch site', folderPath: 'projects/Launch site', canSave: false } })} /></MemoryRouter>)
    try { expect(readOnly.find('room-info-project-unlink')).toBeNull() } finally { await readOnly.unmount() }
    const free = await mount(<MemoryRouter><RoomProjectRow room={room({ canLinkProject: true })} /></MemoryRouter>)
    try {
      expect(free.get('room-info-project-none').textContent).toBe(en('rooms.info.projectNone'))
      expect(free.get('room-info-project-link').textContent).toBe(en('rooms.info.projectLink'))
    } finally { await free.unmount() }
    const none = await mount(<MemoryRouter><RoomProjectRow room={room()} /></MemoryRouter>)
    try { expect(none.find('room-info-project')).toBeNull() } finally { await none.unmount() }
    const groupDm = await mount(<MemoryRouter><RoomProjectRow room={room({ name: null, canLinkProject: true })} /></MemoryRouter>)
    try { expect(groupDm.find('room-info-project')).toBeNull() } finally { await groupDm.unmount() }
  })
})

describe('Create a channel for a project', () => {
  const people = (k: number) => Array.from({ length: k }, (_, i) => ({ id: `p${i}`, name: `P ${String(i).padStart(3, '0')}`, active: true }))
  test('the project people ticked, the name filled, the private-channel line', async () => {
    usePeople.setState({ people: people(3), loaded: true, byId: Object.fromEntries(people(3).map((p) => [p.id, p])), failed: false } as never)
    const m = await mount(<MemoryRouter><PeoplePicker open onClose={() => {}} mode={{ kind: 'channel', project: { id: nextId(), name: 'Launch site', preselect: ['p0', 'p1'], people: 3 } }} /></MemoryRouter>)
    try {
      await m.until(() => m.find('picker-project-note'), 'the note', 2000)
      expect((m.get('picker-name') as unknown as { value: string }).value).toBe('Launch site')
      expect(m.get('picker-count').textContent).toBe(en('rooms.picker.selected', { n: 2 }))
      expect(m.find('picker-project-too-many')).toBeNull()
      expect(m.find('picker-groups')).toBeNull()
    } finally { await m.unmount() }
  })

  test('more than 99 others: nobody ticked, the line that says a channel holds 100', async () => {
    const m = await mount(<MemoryRouter><PeoplePicker open onClose={() => {}} mode={{ kind: 'channel', project: { id: nextId(), name: 'Big', preselect: [], people: 140 } }} /></MemoryRouter>)
    try {
      await m.until(() => m.find('picker-project-too-many'), 'the line', 2000)
      expect(m.get('picker-project-too-many').textContent).toBe(en('projects.channel.tooMany', { n: 140 }))
      expect(m.get('picker-count').textContent).toBe('')
    } finally { await m.unmount() }
  })
})
