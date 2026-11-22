// A team project's own chat room, on the web (docs/decisions/20261120-project-is-room.md D5, D3):
// - the project page's Chat room: made the first time (POST /api/projects/:id/room), then the room opens; a project
//   that has one opens it at once, with its unread count; none for a personal project or one I manage from outside;
// - the room's header: the project's folder button (its name) in the Files button's place, no Files button;
// - the room's info: whose room it is, Manage people for whoever may change the project's people, Mute, Leave project;
//   no name row, no invite and no Remove (an admin either); the "⋯" ends with Leave project and has no invite;
// - read-only people: the box's clip is off, with why;
// - the delete confirm of a message with files: the file stays in <project> › Chat attachments (a link to it);
// - the lists: a project room shows once it has a message (until then it is reached from the project), with a folder;
// - the old link lines still read (rooms-lib.test.ts checks their words).
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { uuidv7, type Me, type Project, type Room } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import { ProjectHome } from '../../src/pages/Projects'
import RoomPage from '../../src/pages/Room'
import { MembersDialog } from '../../src/components/rooms/MembersDialog'
import { roomMenuActions } from '../../src/components/rooms/RoomMenu'
import { FileStaysLines, keptFiles, RoomMessages } from '../../src/components/rooms/RoomMessages'
import { RoomIcon } from '../../src/components/rooms/RoomIcon'
import { listedRoom, projectRoomOf, shownInLists } from '../../src/lib/rooms'
import { useRooms } from '../../src/store/rooms'
import { useSession } from '../../src/store/session'
import { useProjects } from '../../src/store/projects'
import { useUi } from '../../src/store/ui'
import { installDom, mount, removeDom } from './dom-host'
import { at, BEN, CY, ME, message, room } from './rooms-fixtures'

setDefaultTimeout(30_000)
const en = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate('en', key, vars)
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const PID = '01900000-0000-7000-8000-0000000004a1'
const RID = '01900000-0000-7000-8000-0000000004b1'
const projectRoom = (o: Partial<Room> = {}, canSave = true, leave: 'yes' | 'last' = 'yes'): Room =>
  room({ id: RID, kind: 'group', name: 'Launch site', canRename: false, managerId: null, groupId: null, memberCount: 3, projectRoom: true, project: { id: PID, name: 'Launch site', folderPath: 'projects/Launch site', canSave, room: true, attach: canSave ? 'ok' : 'read_only', leave }, ...o })
const project = (o: Partial<Project> = {}): Project =>
  ({ id: PID, name: 'Launch site', folderPath: 'projects/Launch site', instructions: 'x', createdBy: { id: ME.id, name: ME.name }, createdAt: at(-90), canEdit: true, canManage: true, audience: 3, ...o })
const meAs = (role: 'member' | 'admin' | 'guest' = 'member') => ({
  user: { id: ME.id, username: ME.id, name: ME.name, email: null, role, locale: 'en', localeChoice: null, mustChangePassword: false, prefs: {} },
  groups: [], team: { name: 'Acme', defaultLocale: 'en', projectCreators: 'members' }, session: { id: uuidv7(), client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' },
  server: { version: '0', dev: false, deployment: 'hosted', allChatsConfidential: false },
} as unknown as Me)

let routes: Record<string, (body: unknown) => Response> = {}
let asked: string[] = []
const realFetch = globalThis.fetch
const before = { locale: useLocaleStore.getState().locale, status: useSession.getState().status }
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'en' })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input).split('?')[0]}`
    asked.push(key)
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    return routes[key]?.(body) ?? json({ error: { code: 'not_found', message: `no route ${key}` } }, 404)
  }) as unknown as typeof fetch
})
afterEach(() => {
  routes = {}
  asked = []
  useUi.setState({ toasts: [] })
  useRooms.getState().reset()
  useProjects.setState({ byId: {} } as never)
  useSession.setState({ status: before.status })
})
afterAll(() => {
  globalThis.fetch = realFetch
  removeDom()
  useLocaleStore.setState({ locale: before.locale })
})
const signIn = (role: 'member' | 'admin' | 'guest' = 'member') => useSession.setState({ status: { kind: 'signed-in', me: meAs(role) } } as never)

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>
}
const projectPage = () => mount(
  <MemoryRouter initialEntries={[`/projects/${PID}`]}>
    <Routes>
      <Route path="/projects/:projectId" element={<ProjectHome />} />
      <Route path="*" element={<Where />} />
    </Routes>
  </MemoryRouter>,
)
const pageRoutes = (p: Project) => ({
  [`GET /api/projects/${p.id}`]: () => json(p),
  [`GET /api/projects/${p.id}/people`]: () => json({ people: [{ id: ME.id, name: ME.name, creator: true }, { id: BEN.id, name: BEN.name }] }),
  'GET /api/chats': () => json({ items: [], nextCursor: null }),
  'GET /api/files/tree': () => json({ path: p.folderPath, access: 'write', entries: [], nextCursor: null }),
})

describe('Project → room', () => {
  test('the project page: Chat room makes the room the first time, then opens it', async () => {
    signIn()
    routes = { ...pageRoutes(project()), [`POST /api/projects/${PID}/room`]: () => json(projectRoom()) }
    const m = await projectPage()
    try {
      await m.until(() => m.find('project-room-open'), 'the Chat room button', 3000)
      expect(m.get('project-room-open').textContent).toContain(en('projects.room.open'))
      expect(m.find('project-room-open-unread')).toBeNull()
      await m.click('project-room-open')
      await m.until(() => m.find('where'), 'the room', 3000)
      expect(m.get('where').textContent).toBe(`/rooms/${RID}`)
      expect(asked).toContain(`POST /api/projects/${PID}/room`)
      // the room is in my list now
      expect(useRooms.getState().rooms.some((r) => r.id === RID)).toBe(true)
    } finally { await m.unmount() }
  })

  test('a project with a room: its unread count, and the room opens without making anything', async () => {
    signIn()
    routes = pageRoutes(project({ room: { id: RID, unread: 3 } }))
    const m = await projectPage()
    try {
      await m.until(() => m.find('project-room-open-unread'), 'the unread count', 3000)
      expect(m.get('project-room-open-unread').textContent).toContain('3')
      // the room in my list is the one that counts (it moves with the room's messages)
      useRooms.setState({ rooms: [projectRoom({ unreadCount: 5, lastMessage: { id: uuidv7(), seq: 5, author: BEN, excerpt: 'hi', fileCount: 0, deleted: false, createdAt: at(1) } })], loaded: true })
      await m.until(() => m.get('project-room-open-unread').textContent?.includes('5'), 'the count from the room')
      await m.click('project-room-open')
      await m.until(() => m.find('where'), 'the room', 3000)
      expect(m.get('where').textContent).toBe(`/rooms/${RID}`)
      expect(asked).not.toContain(`POST /api/projects/${PID}/room`)
    } finally { await m.unmount() }
  })

  test('a personal project and one I manage without being in it: no Chat room', async () => {
    signIn()
    routes = pageRoutes(project({ folderPath: `users/${ME.id}/projects/Notes` }))
    let m = await projectPage()
    try {
      await m.until(() => m.find('project-files'), 'the page', 3000)
      expect(m.find('project-room-open')).toBeNull()
    } finally { await m.unmount() }
    signIn('admin')
    routes = pageRoutes(project({ member: false, instructions: '' }))
    m = await projectPage()
    try {
      await m.until(() => m.find('project-members-only'), 'the page', 3000)
      expect(m.find('project-room-open')).toBeNull()
    } finally { await m.unmount() }
  })

  test('no Channel box any more', async () => {
    signIn()
    routes = pageRoutes(project())
    const m = await projectPage()
    try {
      await m.until(() => m.find('project-files'), 'the page', 3000)
      expect(m.find('project-channel')).toBeNull()
    } finally { await m.unmount() }
  })
})

describe('Room → project', () => {
  const serveRoom = (r: Room) => {
    routes = {
      [`GET /api/rooms/${r.id}`]: () => json(r),
      [`GET /api/rooms/${r.id}/messages`]: () => json({ items: [], nextCursor: null }),
      [`GET /api/rooms/${r.id}/members`]: () => json({ items: [ME, BEN, CY].map((user) => ({ user, joinedAt: at(-60) })) }),
      [`GET /api/rooms/${r.id}/ai`]: () => json({ answering: 0, mine: [] }),
      [`GET /api/rooms/${r.id}/ai/requests`]: () => json({ items: [] }),
      'GET /api/chats': () => json({ items: [], nextCursor: null }),
    }
  }
  const roomPage = () => mount(
    <MemoryRouter initialEntries={[`/rooms/${RID}`]}>
      <Routes><Route path="/rooms/:roomId" element={<RoomPage />} /><Route path="*" element={<Where />} /></Routes>
    </MemoryRouter>,
  )

  test('the header: the project, its folder and name, in the Files button\'s place, a link to the project page', async () => {
    signIn()
    const r = projectRoom()
    serveRoom(r)
    useRooms.setState({ rooms: [r], loaded: true })
    const m = await roomPage()
    try {
      await m.until(() => m.find('room-project'), 'the project button', 3000)
      expect(m.get('room-project-label').textContent).toBe(en('rooms.project.open'))
      expect(m.get('room-project').getAttribute('aria-label')).toBe(en('rooms.project.open'))
      expect(m.get('room-project').getAttribute('href')).toBe(`/projects/${PID}`)
      expect(m.find('room-group-files')).toBeNull()
      expect(m.find('room-project-files')).toBeNull()
    } finally { await m.unmount() }
  })

  test('read-only: the clip is off and says why; a tap says it too', async () => {
    signIn()
    const r = projectRoom({}, false)
    serveRoom(r)
    useRooms.setState({ rooms: [r], loaded: true })
    const m = await roomPage()
    try {
      await m.until(() => m.find('room-attach-off'), 'the clip, off', 3000)
      expect(m.find('room-attach')).toBeNull()
      expect(m.get('room-attach-off').getAttribute('aria-label')).toBe(en('rooms.project.noAttach'))
      await m.click('room-attach-off')
      expect(useUi.getState().toasts.at(-1)?.text).toBe(en('rooms.project.noAttach'))
    } finally { await m.unmount() }
  })

  test('someone who may add files keeps the clip', async () => {
    signIn()
    const r = projectRoom()
    serveRoom(r)
    useRooms.setState({ rooms: [r], loaded: true })
    const m = await roomPage()
    try {
      await m.until(() => m.find('room-attach'), 'the clip', 3000)
      expect(m.find('room-attach-off')).toBeNull()
    } finally { await m.unmount() }
  })
})

describe('the room\'s info and menu', () => {
  const members = [ME, BEN, CY].map((user) => ({ user, joinedAt: at(-60) }))
  const info = (r: Room) => mount(<MemoryRouter><MembersDialog open onClose={() => {}} room={r} members={members} meId={ME.id} onInvite={() => {}} /></MemoryRouter>)

  test('whose room it is, Manage people, Mute and Leave project; no name, no invite, no Remove (an admin either)', async () => {
    signIn('admin')
    routes = { [`GET /api/projects/${PID}`]: () => json(project({ membersEditable: true, leave: 'yes' })) }
    const m = await info(projectRoom())
    try {
      await m.until(() => m.find('room-info-manage') && m.find('room-info-leave'), 'the project rows', 3000)
      expect(m.get('room-info-project-line').textContent).toBe(en('rooms.project.info', { name: 'Launch site' }))
      expect(m.get('room-info-project-name').getAttribute('href')).toBe(`/projects/${PID}`)
      expect(m.get('room-info-manage').textContent).toContain(en('rooms.project.manage'))
      expect(m.get('room-info-mute').textContent).toContain(en('rooms.project.mute'))
      expect(m.get('room-info-leave').textContent).toContain(en('projects.leave'))
      expect(m.find('room-name')).toBeNull()
      expect(m.find('room-invite')).toBeNull()
      expect(m.container.ownerDocument!.body.querySelectorAll('[data-testid="room-member-menu"]').length).toBe(0)
      expect(m.container.ownerDocument!.body.querySelectorAll('[data-testid="room-member"]').length).toBe(3)
    } finally { await m.unmount() }
  })

  test('someone who may not change the people: no Manage people; the last one in it cannot leave, and is told why', async () => {
    signIn()
    routes = { [`GET /api/projects/${PID}`]: () => json(project({ membersEditable: false })) }
    const m = await info(projectRoom({ notify: { own: 'off', byDefault: 'mentions', level: 'off' } }, true, 'last'))
    try {
      await m.until(() => m.find('room-info-leave'), 'the leave row', 3000)
      await m.until(() => asked.includes(`GET /api/projects/${PID}`), 'the project read')
      expect(m.find('room-info-manage')).toBeNull()
      expect(m.get('room-info-leave').textContent).toContain(en('projects.leaveLast'))
      // muted: the row turns it back on
      expect(m.get('room-info-mute').textContent).toContain(en('rooms.project.unmute'))
    } finally { await m.unmount() }
  })

  test('a member who cannot open the project now: the line without its name, Mute, no Manage people, no Leave, no invite', async () => {
    signIn()
    const r = projectRoom({ project: undefined })
    const m = await info(r)
    try {
      expect(m.get('room-info-project-line').textContent).toBe(en('rooms.project.infoUnnamed'))
      expect(m.find('room-info-mute')).not.toBeNull()
      expect(m.find('room-info-leave')).toBeNull()
      expect(m.find('room-invite')).toBeNull()
      expect(m.find('room-name')).toBeNull()
    } finally { await m.unmount() }
    // and its icon is the folder, not a private channel's lock
    expect(renderToStaticMarkup(<RoomIcon room={r} size={24} />)).toContain('lucide-folder')
  })

  test('the "⋯": Leave project in place of Leave (only when the server says I may), and no invite', () => {
    expect(roomMenuActions(projectRoom())).toEqual(['pin', 'notify', 'copyLink', 'leaveProject'])
    expect(roomMenuActions(projectRoom({ project: undefined }))).toEqual(['pin', 'notify', 'copyLink'])
    expect(roomMenuActions(room({ kind: 'group', name: 'Plan' }))).toEqual(['pin', 'notify', 'copyLink', 'leave'])
  })
})

describe('the delete confirm and the lists', () => {
  test('a message with files: the file stays in the project\'s Chat attachments, a link to it', () => {
    signIn()
    const html = renderToStaticMarkup(<FileStaysLines project={{ name: 'Launch site', folderPath: 'projects/Launch site' }} at="projects/Launch site/Chat attachments/brief.pdf" n={1} />)
    expect(html).toContain(en('rooms.deleteBodyKeepsFiles').replace(/'/g, '&#x27;'))
    expect(html).toContain('The file stays in ')
    expect(html).toContain('Launch site › Chat attachments')
    expect(html).toContain(`href="/files?path=${encodeURIComponent('projects/Launch site/Chat attachments')}"`)
    const two = renderToStaticMarkup(<FileStaysLines project={{ name: 'Launch site', folderPath: 'projects/Launch site' }} at="projects/Launch site/채팅 첨부/a.pdf" n={2} others />)
    expect(two).toContain('The files stay in ')
    // the folder it is really in (the link: the upload reuses one under another language's name), named in my language
    // (chatFilesWord, QA rerun E), and the plain words for the room's own files that go with it
    expect(two).toContain('Launch site › Chat attachments')
    expect(two).toContain(`href="/files?path=${encodeURIComponent('projects/Launch site/채팅 첨부')}"`)
    expect(two).toContain(en('rooms.deleteBody').replace(/'/g, '&#x27;'))
  })

  test('the delete confirm keeps its plain words for room-stored files (an ordinary room, a converted channel\'s older files)', () => {
    const r = room({ kind: 'group', name: 'Plan' })
    const plain = { id: uuidv7(), name: 'a.pdf', size: 1, mime: 'application/pdf', kind: 'pdf' as const, thumb: false }
    expect(keptFiles({ files: [plain] })).toEqual([])
    expect(keptFiles({ files: [{ ...plain, teamFile: true, state: 'unavailable' }] })).toEqual([])
    const team = { ...plain, id: uuidv7(), teamFile: true as const, teamPath: 'projects/Launch site/Chat attachments/a.pdf' }
    expect(keptFiles({ files: [plain, team] }).map((f) => f.id)).toEqual([team.id])
    expect(r.projectRoom).toBeUndefined()
  })

  test('the lists leave out a project room nobody wrote in, also for a member who cannot open the project', () => {
    const bare = projectRoom({ id: uuidv7(), project: undefined })
    expect(listedRoom(bare)).toBe(false)
    expect(shownInLists([bare])).toEqual([])
  })

  test('a project room is listed once it has a message, or while it is open; a folder in place of the lock', () => {
    const empty = projectRoom()
    const talked = projectRoom({ id: uuidv7(), lastMessage: { id: uuidv7(), seq: 1, author: BEN, excerpt: 'hi', fileCount: 0, deleted: false, createdAt: at(1) } })
    const channel = room({ kind: 'group', name: 'Plan' })
    expect(projectRoomOf(empty)?.id).toBe(PID)
    expect(projectRoomOf(channel)).toBeNull()
    expect(listedRoom(empty)).toBe(false)
    expect(listedRoom(empty, empty.id)).toBe(true)
    expect(shownInLists([empty, talked, channel]).map((r) => r.id)).toEqual([talked.id, channel.id])
    expect(shownInLists([empty, talked, channel], empty.id).map((r) => r.id)).toEqual([empty.id, talked.id, channel.id])
    // lucide's icon names are its classes
    expect(renderToStaticMarkup(<RoomIcon room={talked} size={24} />)).toContain('lucide-folder')
    expect(renderToStaticMarkup(<RoomIcon room={channel} size={24} />)).toContain('lucide-lock')
  })

  test('a project room\'s file trashed in Files: "File deleted"; one I cannot open: "File unavailable"; no name, no menu', () => {
    const r = projectRoom()
    const f = (o: Record<string, unknown>) => ({ id: uuidv7(), name: '', size: 0, mime: 'application/pdf', kind: 'pdf', thumb: false, teamFile: true, ...o })
    const m = message({ roomId: r.id, seq: 1, author: BEN, body: 'brief', files: [f({ state: 'deleted' }), f({ state: 'unavailable' }), f({ name: 'plan.pdf', size: 9, teamPath: 'projects/Launch site/Chat attachments/plan.pdf' })] as never })
    const html = renderToStaticMarkup(<MemoryRouter><RoomMessages roomId={r.id} messages={[m]} pending={[]} meId={ME.id} members={[ME, BEN]} onThread={() => {}} /></MemoryRouter>)
    expect(html).toContain(`data-state="deleted"`)
    expect(html).toContain(en('rooms.file.deleted'))
    expect(html).toContain(en('rooms.file.unavailable'))
    expect(html.split('data-testid="room-file"').length - 1).toBe(1)
  })

  test('an old link line still reads in the timeline (it is no longer written)', () => {
    const r = room({ kind: 'group', name: 'Plan' })
    const lines = [
      message({ roomId: r.id, seq: 1, author: BEN, body: '', event: { type: 'project_linked', project: null } }),
      message({ roomId: r.id, seq: 2, author: BEN, body: '', event: { type: 'project_unlinked', project: { id: PID, name: 'Launch site' } } }),
    ]
    const html = renderToStaticMarkup(<MemoryRouter><RoomMessages roomId={r.id} messages={lines} pending={[]} meId={ME.id} members={[ME, BEN]} onThread={() => {}} /></MemoryRouter>)
    expect(html).toContain(en('rooms.event.projectLinked', { actor: 'Ben' }))
    expect(html).toContain('data-testid="room-event-project"')
    expect(html).toContain('>Launch site</a>')
  })

  test('a project line links only a project I can open now: in the trash, deleted or out of reach it is plain text', () => {
    const r = room({ kind: 'group', name: 'Plan' })
    const lines = [
      message({ roomId: r.id, seq: 1, author: BEN, body: '', event: { type: 'project_linked', project: null, projectGone: { state: 'trash', name: 'Launch v2' } } }),
      message({ roomId: r.id, seq: 2, author: null, body: '', event: { type: 'project_room', project: null, projectGone: { state: 'deleted' } } }),
      message({ roomId: r.id, seq: 3, author: BEN, body: '', event: { type: 'project_unlinked', project: null } }),
      message({ roomId: r.id, seq: 4, author: null, body: '', event: { type: 'project_room', project: { id: PID, name: 'Launch v2' } } }),
    ]
    const html = renderToStaticMarkup(<MemoryRouter><RoomMessages roomId={r.id} messages={lines} pending={[]} meId={ME.id} members={[ME, BEN]} onThread={() => {}} /></MemoryRouter>)
    expect(html).toContain(en('rooms.event.projectLinkedTrash', { actor: 'Ben', name: 'Launch v2' }))
    expect(html).toContain(en('rooms.event.projectRoomDeleted'))
    expect(html).toContain(en('rooms.event.projectUnlinked', { actor: 'Ben' }))
    for (const s of ['trash', 'deleted', 'hidden', 'open']) expect(html).toContain(`data-project="${s}"`)
    // one link only: the open project room line's name
    expect(html.split('data-testid="room-event-project"').length - 1).toBe(1)
    expect(html).toContain(`href="/projects/${PID}"`)
    expect(html).toContain('>Launch v2</a>')
  })
})
