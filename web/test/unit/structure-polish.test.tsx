// Structure polish on the web (docs/AGENTS/plan/20261121-0619-structure-polish.md; docs/decisions/
// 20261121-make-project-from-room.md, 20261121-department-room-files.md, 20261121-sidebar-projects-group.md):
// - C: the built-in Projects group of the Chats list: Pinned › my sections › Channels › Projects › Direct messages,
//   by name, by the Room.projectRoom flag; a pinned or filed project room stays out of it, and its header shows while I
//   have one anywhere (so a room can be dropped back); a room the server no longer lists (its project in the trash) is
//   gone; the Projects header takes a dragged room out of its section;
// - A: the "⋯" items per kind and role (Make it a project, New project with {name}), the confirm's lines (the live
//   name, the added line, the "-2" note, the files that stay, a guest who blocks it for an admin and a member, "The
//   people changed" and the read again), and the event lines (project_made, project_files_moved);
// - D: the empty ✦ side chat's line in a project room with the project page link, and "Same people as #{group}".
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { act } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { uuidv7, type MakeProjectInfo, type Me, type NavFolder, type Room } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import { foldOf, roomsByKind, RoomsByKind, withKinds } from '../../src/components/panels/RoomsByKind'
import { roomMenuActions } from '../../src/components/rooms/RoomMenu'
import { DmProjectDialog, MakeProjectDialog, projectNameProblem } from '../../src/components/rooms/MakeProjectDialog'
import { InTeamLink } from '../../src/components/rooms/RoomMessages'
import { SameAsGroupLine } from '../../src/components/rooms/MembersDialog'
import { ProjectSideHint } from '../../src/components/rooms/SideChatPanel'
import { eventText, roomFilesButtonShown, shownInLists } from '../../src/lib/rooms'
import { setNavigator } from '../../src/lib/nav'
import { useNavFolders } from '../../src/store/navFolders'
import { useRooms } from '../../src/store/rooms'
import { mayMakeTeamProject, useSession } from '../../src/store/session'
import { useUi } from '../../src/store/ui'
import { FakeEvent, installDom, mount, removeDom, type FakeElement } from './dom-host'
import { at, BEN, CY, ME, room } from './rooms-fixtures'

setDefaultTimeout(30_000)
const en = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate('en', key, vars)
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const PID = '01900000-0000-7000-8000-0000000005a1'
const msg = (id: string) => ({ id, seq: 1, author: BEN, excerpt: 'hi', fileCount: 0, deleted: false, createdAt: at(1) })
/** a plain room for the list's pure functions (any id), and a project's room */
const plain = (id: string, o: Partial<Room> = {}) => ({ id, kind: 'team', name: id, peers: [], unreadCount: 0, threadsUnread: 0, mentioned: false, muted: false, activityAt: at(0), ...o }) as Room
const proj = (id: string, name: string, o: Partial<Room> = {}): Room =>
  plain(id, { kind: 'group', name, groupId: null, projectRoom: true, project: { id: uuidv7(), name, folderPath: `projects/${name}`, canSave: true, room: true }, lastMessage: msg(uuidv7()), ...o })
/** the same, checked by the shared schema (for the mounted list) */
const projRoom = (id: string, name: string, o: Partial<Room> = {}): Room => room({ ...proj(id, name), canRename: false, managerId: null, memberCount: 3, peers: [BEN, CY], lastSeq: 1, lastReadSeq: 1, nextThreadId: null, createdAt: at(-60), ...o })
const section = (id: string, name: string, position = 0): NavFolder => ({ id, kind: 'rooms', name, position, count: 0, top: [] })
const keys = (s: ReturnType<typeof withKinds>) => s.map((x) => (x.folder ? `section:${x.folder.name}` : x.key))
const ids = (s: ReturnType<typeof withKinds>) => s.map((x) => x.rooms.map((r) => r.id))
const meAs = (role: 'member' | 'admin' | 'owner' | 'guest' = 'member', projectCreators: 'members' | 'admins' = 'members') => ({
  user: { id: ME.id, username: ME.id, name: ME.name, email: null, role, locale: 'en', localeChoice: null, mustChangePassword: false, prefs: {} },
  groups: [], team: { name: 'Acme', defaultLocale: 'en', projectCreators }, session: { id: uuidv7(), client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' },
  server: { version: '0', dev: false, deployment: 'hosted', allChatsConfidential: false },
} as unknown as Me)

let routes: Record<string, (body: unknown, url: string) => Response> = {}
let asked: { key: string; url: string; body: unknown }[] = []
const realFetch = globalThis.fetch
const before = { locale: useLocaleStore.getState().locale, status: useSession.getState().status }
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'en' })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const key = `${init?.method ?? 'GET'} ${url.split('?')[0]}`
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    asked.push({ key, url, body })
    return routes[key]?.(body, url) ?? json({ error: { code: 'not_found', message: `no route ${key}` } }, 404)
  }) as unknown as typeof fetch
})
afterEach(() => {
  routes = {}
  asked = []
  useUi.setState({ toasts: [] })
  useRooms.getState().reset()
  useNavFolders.getState().reset()
  useSession.setState({ status: before.status })
})
afterAll(() => {
  globalThis.fetch = realFetch
  removeDom()
  useLocaleStore.setState({ locale: before.locale })
})
const signIn = (role: 'member' | 'admin' | 'owner' | 'guest' = 'member', creators: 'members' | 'admins' = 'members') => useSession.setState({ status: { kind: 'signed-in', me: meAs(role, creators) } } as never)

describe('C: the Projects group of the Chats list', () => {
  const titleOf = (r: Room) => r.name ?? ''
  test('Pinned › my sections › Channels › Projects › Direct messages; projects by name, numbers by their value', () => {
    const rooms = [
      plain('ch', { name: 'general' }),
      proj('p10', 'Site 10'), proj('p2', 'Site 2'), proj('pa', 'Atlas'),
      plain('dm', { kind: 'dm', name: null, peers: [BEN] }),
      plain('pin', { name: 'pinned', pinnedAt: at(0) }),
      plain('filed', { name: 'filed', folderId: 's1' }),
    ]
    const s = withKinds(roomsByKind(rooms, titleOf, 'en', [section('s1', 'Mine')]))
    expect(keys(s)).toEqual(['pinned', 'section:Mine', 'team', 'project', 'dm'])
    expect(ids(s)).toEqual([['pin'], ['filed'], ['ch'], ['pa', 'p2', 'p10'], ['dm']])
  })
  test('by the projectRoom flag: a member who cannot open the project (no Room.project) still sees it under Projects', () => {
    const r = proj('p', 'Atlas', { project: undefined })
    const s = withKinds(roomsByKind([r], titleOf, 'en'))
    expect(s.find((x) => x.key === 'project')?.rooms.map((x) => x.id)).toEqual(['p'])
    expect(s.find((x) => x.key === 'team')?.rooms).toEqual([])
  })
  test('a pinned or filed project room stays out of Projects; the header stays while one is filed or pinned', () => {
    let s = withKinds(roomsByKind([proj('p', 'Atlas', { folderId: 's1' })], titleOf, 'en', [section('s1', 'Mine')]))
    expect(keys(s)).toEqual(['section:Mine', 'team', 'project', 'dm'])
    expect(s.find((x) => x.key === 'project')!.rooms).toEqual([])
    expect(s.find((x) => x.folder)!.rooms.map((r) => r.id)).toEqual(['p'])
    s = withKinds(roomsByKind([proj('p', 'Atlas', { pinnedAt: at(0) })], titleOf, 'en'))
    expect(keys(s)).toEqual(['pinned', 'team', 'project', 'dm'])
    expect(s.find((x) => x.key === 'project')!.rooms).toEqual([])
  })
  test('no project room anywhere: no Projects header (and none before a project room has its first message)', () => {
    expect(keys(withKinds(roomsByKind([plain('ch')], titleOf, 'en')))).toEqual(['team', 'dm'])
    // listed only after its first message (lib/rooms.ts listedRoom): the lists leave it out until then
    const s = withKinds(roomsByKind(shownInLists([plain('ch'), proj('p', 'Atlas', { lastMessage: null })]), titleOf, 'en'))
    expect(keys(s)).toEqual(['team', 'dm'])
  })
  test("a trashed project's room, which the server stops listing, leaves the list; it comes back with the room", async () => {
    signIn()
    const p = projRoom('01900000-0000-7000-8000-0000000005b1', 'Atlas')
    useRooms.setState({ rooms: [room({ id: '01900000-0000-7000-8000-0000000005b2', name: 'general', lastMessage: msg(uuidv7()) }), p], loaded: true })
    useNavFolders.setState({ folders: [] })
    routes = { 'GET /api/nav-folders': () => json({ items: [] }) }
    const m = await mount(<MemoryRouter initialEntries={['/']}><RoomsByKind /></MemoryRouter>)
    try {
      const projects = () => m.container.querySelector('[data-testid="chats-panel-section"][data-section="project"]')
      await m.until(() => projects(), 'the Projects header')
      expect(projects()!.textContent).toContain(en('rooms.section.project'))
      expect(projects()!.textContent).toContain('Atlas')
      // the list read again after the trash leaves it out (the server's held rooms)
      await act(async () => useRooms.setState({ rooms: useRooms.getState().rooms.filter((r) => r.id !== p.id) }))
      await m.until(() => !projects(), 'the header gone')
      // a restore lists it again
      await act(async () => useRooms.setState({ rooms: [...useRooms.getState().rooms, p] }))
      await m.until(() => projects(), 'the header back')
    } finally { await m.unmount() }
  })
  test("its fold key is the account's section:chats:project", () => {
    expect(foldOf({ key: 'project', rooms: [] })).toBe('section:chats:project')
  })
  test('the Projects header takes a dragged room out of its section (useSectionDrop(null)); it has no "+"', async () => {
    signIn()
    const id = '01900000-0000-7000-8000-0000000005c1'
    const filed = projRoom(id, 'Atlas', { folderId: '01900000-0000-7000-8000-0000000005c2' })
    const mine = section('01900000-0000-7000-8000-0000000005c2', 'Mine')
    useRooms.setState({ rooms: [filed], loaded: true })
    useNavFolders.setState({ folders: [mine] })
    routes = {
      'GET /api/nav-folders': () => json({ items: [mine] }),
      [`PUT /api/rooms/${id}/folder`]: () => json({ ...filed, folderId: undefined }),
    }
    const m = await mount(<MemoryRouter initialEntries={['/']}><RoomsByKind /></MemoryRouter>)
    try {
      const header = await m.until(() => m.container.querySelector('[data-testid="chats-panel-section"][data-section="project"]') as FakeElement | null, 'the Projects header')
      expect(header.querySelector('[data-testid="rooms-channels-add"]')).toBeNull()
      expect(header.querySelector('[data-testid="rooms-new-message"]')).toBeNull()
      const dt = { types: ['application/x-trina-room'], files: [], dropEffect: 'none', getData: (t: string) => (t === 'application/x-trina-room' ? id : '') }
      for (const type of ['dragover', 'drop']) {
        const e = Object.assign(new FakeEvent(type, { bubbles: true, cancelable: true }), { dataTransfer: dt, relatedTarget: null })
        await act(async () => { header.dispatchEvent(e) })
      }
      await m.until(() => asked.find((a) => a.key === `PUT /api/rooms/${id}/folder`), 'the move out')
      expect(asked.find((a) => a.key === `PUT /api/rooms/${id}/folder`)!.body).toEqual({ folderId: null })
      await m.until(() => !useRooms.getState().rooms[0]!.folderId, 'out of its section')
    } finally { await m.unmount() }
  })
})

describe('A: the "⋯" items per kind and role', () => {
  test('who may make team projects: owner and admins; members when the team lets them; never a guest', () => {
    expect(mayMakeTeamProject(meAs('owner', 'admins'))).toBe(true)
    expect(mayMakeTeamProject(meAs('admin', 'admins'))).toBe(true)
    expect(mayMakeTeamProject(meAs('member', 'members'))).toBe(true)
    expect(mayMakeTeamProject(meAs('member', 'admins'))).toBe(false)
    expect(mayMakeTeamProject(meAs('guest', 'members'))).toBe(false)
    expect(mayMakeTeamProject(null)).toBe(false)
  })
  test('a named private channel and an unnamed group chat: Make it a project, after Copy link (the one list: docs/decisions/20261126-shared-menus.md)', () => {
    expect(roomMenuActions({ kind: 'group', name: 'Launch' }, false, true)).toEqual(['pin', 'notify', 'copyLink', 'makeProject', 'leave'])
    expect(roomMenuActions({ kind: 'group' }, false, true)).toEqual(['pin', 'notify', 'copyLink', 'makeProject', 'leave'])
  })
  test('a 1:1: New project with {name}; a hidden or gone one: none', () => {
    expect(roomMenuActions({ kind: 'dm' }, false, true)).toEqual(['pin', 'notify', 'copyLink', 'dmProject', 'hide'])
    expect(roomMenuActions({ kind: 'dm', hidden: true }, false, true)).toEqual(['notify', 'copyLink', 'show'])
    expect(roomMenuActions({ kind: 'dm', gone: true }, false, true)).toEqual(['pin', 'notify', 'copyLink', 'hide'])
  })
  test("a project's room, a team room and the everyone room: none; nobody without the right (a guest, a member of an admins-only team)", () => {
    expect(roomMenuActions({ kind: 'group', name: 'Atlas', projectRoom: true }, false, true)).not.toContain('makeProject')
    expect(roomMenuActions({ kind: 'team' }, false, true)).toEqual(['pin', 'notify', 'copyLink', 'hide'])
    expect(roomMenuActions({ kind: 'all' }, false, true)).toEqual(['pin', 'notify', 'copyLink', 'hide'])
    expect(roomMenuActions({ kind: 'group', name: 'Launch' })).toEqual(['pin', 'notify', 'copyLink', 'leave'])
    expect(roomMenuActions({ kind: 'dm' })).toEqual(['pin', 'notify', 'copyLink', 'hide'])
  })
})

describe('A: the confirm', () => {
  const RID = '01900000-0000-7000-8000-0000000005d1'
  const GUEST = { id: 'gus', name: 'Gus' }
  const info = (o: Partial<MakeProjectInfo> = {}): MakeProjectInfo => ({ suggestedName: 'Launch', members: [ME, BEN, CY], guestsBlocked: [], filesMoving: 2, filesStaying: 0, membersHash: 'h1', folderName: 'Launch', nameTaken: false, ...o })
  const dialog = () => mount(<MemoryRouter><MakeProjectDialog roomId={RID} onClose={() => {}} /></MemoryRouter>)
  const text = (m: Awaited<ReturnType<typeof mount>>, id: string) => m.get(id).textContent

  test('its lines: N members, the live name in the body, the added line, nothing about files that stay', async () => {
    signIn()
    routes = { [`GET /api/rooms/${RID}/make-project`]: (_b, url) => json(info(url.includes('name=') ? { folderName: decodeURIComponent(url.split('name=')[1]!) } : {})) }
    const m = await dialog()
    try {
      await m.until(() => m.find('make-project-body'), 'the body')
      expect((m.get('make-project-name') as unknown as { value: string }).value).toBe('Launch')
      expect(text(m, 'make-project-body')).toBe(en('rooms.makeProject.body', { n: 3, name: 'Launch', folder: 'Chat attachments' }))
      expect(text(m, 'make-project-body')).toBe("Its 3 members become the project's people. Files sent here move to Launch › Chat attachments. People added later see messages from now on.")
      expect(text(m, 'make-project-later')).toBe('People added to the project later can open these files.')
      expect(m.find('make-project-staying')).toBeNull()
      expect(m.find('make-project-guest')).toBeNull()
      // {name} follows the field as it is typed
      await m.type('make-project-name', 'Spring launch')
      expect(text(m, 'make-project-body')).toContain('Spring launch › Chat attachments')
      expect(m.get('make-project-confirm').hasAttribute('disabled')).toBe(false)
    } finally { await m.unmount() }
  })

  test('a name another project has: the "-2" line; a refused name: inline, and the button is off; files that stay', async () => {
    signIn()
    routes = { [`GET /api/rooms/${RID}/make-project`]: (_b, url) => {
      const typed = url.includes('name=') ? decodeURIComponent(url.split('name=')[1]!.replace(/\+/g, ' ')) : 'Launch'
      return json(info({ filesStaying: 3, ...(typed === 'Launch' ? { nameTaken: true, folderName: 'Launch-2' } : typed === 'CLAUDE.md' ? { nameError: 'A project can’t have this name.', folderName: typed } : { folderName: typed }) }))
    } }
    const m = await dialog()
    try {
      await m.until(() => m.html().includes('Launch-2'), 'the -2 line')
      expect(m.html()).toContain(en('rooms.makeProject.nameTaken', { name: 'Launch', folder: 'Launch-2' }))
      // the body names the same folder as the hint (QA TC-6953)
      expect(text(m, 'make-project-body')).toContain('Launch-2 › Chat attachments')
      expect(text(m, 'make-project-staying')).toBe('3 files stay in the conversation only, because not everyone here can see them.')
      await m.type('make-project-name', 'CLAUDE.md')
      await m.until(() => m.html().includes('A project can’t have this name.'), 'the refusal', 3000)
      expect(m.get('make-project-confirm').hasAttribute('disabled')).toBe(true)
    } finally { await m.unmount() }
  })

  test('an emptied name says why the button is off (QA TC-6954)', async () => {
    signIn()
    routes = { [`GET /api/rooms/${RID}/make-project`]: () => json(info()) }
    const m = await dialog()
    try {
      await m.until(() => m.find('make-project-body'), 'the body')
      expect(m.html()).not.toContain(en('rooms.makeProject.nameEmpty'))
      await m.type('make-project-name', '   ')
      await m.until(() => m.html().includes(en('rooms.makeProject.nameEmpty')), 'the empty-name line')
      expect(en('rooms.makeProject.nameEmpty')).toBe('Enter a project name.')
      // the body names no project while there is none
      expect(text(m, 'make-project-body')).toContain('move to … › Chat attachments')
      expect(m.get('make-project-confirm').hasAttribute('disabled')).toBe(true)
    } finally { await m.unmount() }
    const d = await mount(<MemoryRouter><DmProjectDialog peer={{ id: BEN.id, name: BEN.name }} onClose={() => {}} /></MemoryRouter>)
    try {
      await d.type('make-project-name', '')
      await d.until(() => d.html().includes(en('rooms.makeProject.nameEmpty')), 'the empty-name line (a 1:1)')
      expect(d.get('make-project-confirm').hasAttribute('disabled')).toBe(true)
    } finally { await d.unmount() }
  })

  test('"Moving files…" clears when the moves settle before the answer arrives (QA TC-6946)', async () => {
    signIn()
    const moving = projRoom(RID, 'Launch', { filesMoving: true })
    const settled = projRoom(RID, 'Launch')
    routes = {
      [`GET /api/rooms/${RID}/make-project`]: () => json(info()),
      // the moves settle and say so (room.updated without filesMoving) while the answer, read before them, is on its way
      [`POST /api/rooms/${RID}/make-project`]: () => {
        useRooms.getState().handleEvent({ type: 'room.updated', data: { roomId: RID, change: 'updated', room: settled } } as never)
        return json({ project: { id: PID, name: 'Launch', folderPath: 'projects/Launch', instructions: '', createdBy: ME, createdAt: at(0), canEdit: true }, room: moving }, 201)
      },
    }
    const closed: number[] = []
    const m = await mount(<MemoryRouter><MakeProjectDialog roomId={RID} onClose={() => closed.push(1)} /></MemoryRouter>)
    try {
      await m.until(() => m.find('make-project-body'), 'the body')
      await m.click('make-project-confirm')
      await m.until(() => closed.length === 1, 'made')
      const r = useRooms.getState().rooms.find((x) => x.id === RID)!
      expect(r.projectRoom).toBe(true)
      expect(r.filesMoving).toBeUndefined()
    } finally { await m.unmount() }
    // nothing heard meanwhile: the answer's word stands (the moves still run)
    useRooms.getState().reset()
    routes[`POST /api/rooms/${RID}/make-project`] = () => json({ project: { id: PID, name: 'Launch', folderPath: 'projects/Launch', instructions: '', createdBy: ME, createdAt: at(0), canEdit: true }, room: moving }, 201)
    await useRooms.getState().makeProject(RID, 'Launch', 'h1')
    expect(useRooms.getState().rooms.find((x) => x.id === RID)?.filesMoving).toBe(true)
  })

  test('a guest in another place: the button is off; an admin gets the link to them in Admin, a member is told to ask', async () => {
    routes = { [`GET /api/rooms/${RID}/make-project`]: () => json(info({ members: [ME, BEN, GUEST], guestsBlocked: [GUEST] })) }
    signIn('admin')
    let m = await dialog()
    try {
      await m.until(() => m.find('make-project-guest'), 'the guest line')
      expect(m.get('make-project-guest').textContent).toContain('Make Gus a team member first.')
      expect(m.get('make-project-guest-link').getAttribute('href')).toBe('/admin/members?member=gus#guests')
      expect(m.get('make-project-confirm').hasAttribute('disabled')).toBe(true)
    } finally { await m.unmount() }
    signIn('member')
    m = await dialog()
    try {
      await m.until(() => m.find('make-project-guest'), 'the guest line')
      expect(m.get('make-project-guest').textContent).toBe('Ask an admin to make Gus a team member first.')
      expect(m.find('make-project-guest-link')).toBeNull()
      expect(m.get('make-project-confirm').hasAttribute('disabled')).toBe(true)
    } finally { await m.unmount() }
  })

  test('the people changed since the read (409 members_changed): "The people changed", the count read again; then it is made', async () => {
    signIn()
    let reads = 0
    let posts = 0
    const made = projRoom(RID, 'Launch')
    routes = {
      [`GET /api/rooms/${RID}/make-project`]: () => json(++reads === 1 ? info() : info({ members: [ME, BEN, CY, GUEST], membersHash: 'h2' })),
      [`POST /api/rooms/${RID}/make-project`]: (body) => {
        posts++
        if ((body as { membersHash: string }).membersHash === 'h1') return json({ error: { code: 'conflict', message: 'The people in this conversation changed.', params: { reason: 'members_changed' } } }, 409)
        return json({ project: { id: PID, name: 'Launch', folderPath: 'projects/Launch', instructions: '', createdBy: ME, createdAt: at(0), canEdit: true }, room: made }, 201)
      },
    }
    const closed: number[] = []
    const m = await mount(<MemoryRouter><MakeProjectDialog roomId={RID} onClose={() => closed.push(1)} /></MemoryRouter>)
    try {
      await m.until(() => m.find('make-project-body'), 'the body')
      await m.click('make-project-confirm')
      await m.until(() => m.find('make-project-changed'), 'the people changed')
      expect(text(m, 'make-project-changed')).toBe('The people changed')
      await m.until(() => text(m, 'make-project-body')?.includes('4 members'), 'the new count')
      await m.click('make-project-confirm')
      await m.until(() => closed.length === 1, 'closed after it is made')
      expect(posts).toBe(2)
      expect(asked.filter((a) => a.key === `POST /api/rooms/${RID}/make-project`).map((a) => a.body)).toEqual([{ name: 'Launch', membersHash: 'h1' }, { name: 'Launch', membersHash: 'h2' }])
      expect(useRooms.getState().rooms.find((r) => r.id === RID)?.projectRoom).toBe(true)
      expect(useUi.getState().toasts.at(-1)?.text).toBe('Launch is a project now.')
    } finally { await m.unmount() }
  })
})

describe('A: the confirm, when the server says no', () => {
  const RID = '01900000-0000-7000-8000-0000000005d2'
  const GUEST = { id: 'gus', name: 'Gus' }
  const info = (o: Partial<MakeProjectInfo> = {}): MakeProjectInfo => ({ suggestedName: 'Launch', members: [ME, BEN, CY], guestsBlocked: [], filesMoving: 2, filesStaying: 0, membersHash: 'h1', folderName: 'Launch', nameTaken: false, ...o })
  const conflict = (reason: string, message: string, more: Record<string, string> = {}) => json({ error: { code: 'conflict', message, params: { reason, ...more } } }, 409)

  test('409 not_convertible: the server\'s words, and Make project stays off', async () => {
    signIn()
    routes = {
      [`GET /api/rooms/${RID}/make-project`]: () => json(info()),
      [`POST /api/rooms/${RID}/make-project`]: () => conflict('not_convertible', 'This conversation can no longer be made a project.'),
    }
    const m = await mount(<MemoryRouter><MakeProjectDialog roomId={RID} onClose={() => {}} /></MemoryRouter>)
    try {
      await m.until(() => m.find('make-project-body'), 'the body')
      await m.click('make-project-confirm')
      await m.until(() => m.find('make-project-error'), 'the error')
      expect(m.get('make-project-error').textContent).toBe('This conversation can no longer be made a project.')
      expect(m.get('make-project-confirm').hasAttribute('disabled')).toBe(true)
    } finally { await m.unmount() }
  })

  test('409 guest_one_place when the read again shows no blocked guest: the server\'s words; with one, the guest line', async () => {
    signIn()
    let blocked = false
    routes = {
      [`GET /api/rooms/${RID}/make-project`]: () => json(info(blocked ? { members: [ME, BEN, GUEST], guestsBlocked: [GUEST] } : {})),
      [`POST /api/rooms/${RID}/make-project`]: () => conflict('guest_one_place', 'Gus is already in another place.', { guestId: 'gus' }),
    }
    const m = await mount(<MemoryRouter><MakeProjectDialog roomId={RID} onClose={() => {}} /></MemoryRouter>)
    try {
      await m.until(() => m.find('make-project-body'), 'the body')
      await m.click('make-project-confirm')
      await m.until(() => m.find('make-project-error'), 'the server\'s words')
      expect(m.get('make-project-error').textContent).toBe('Gus is already in another place.')
      expect(m.find('make-project-guest')).toBeNull()
      blocked = true
      await m.click('make-project-confirm')
      await m.until(() => m.find('make-project-guest'), 'the guest line')
      expect(m.find('make-project-error')).toBeNull()
      expect(m.get('make-project-confirm').hasAttribute('disabled')).toBe(true)
    } finally { await m.unmount() }
  })

  test('a read that works again clears an earlier error (a 429)', async () => {
    signIn()
    let reads = 0
    routes = { [`GET /api/rooms/${RID}/make-project`]: (_b, url) => (++reads === 2 ? json({ error: { code: 'rate_limited', message: 'Slow down a little.' } }, 429) : json(info(url.includes('name=') ? { folderName: 'X' } : {}))) }
    const m = await mount(<MemoryRouter><MakeProjectDialog roomId={RID} onClose={() => {}} /></MemoryRouter>)
    try {
      await m.until(() => m.find('make-project-body'), 'the body')
      await m.type('make-project-name', 'Spring')
      await m.until(() => m.find('make-project-error'), 'the 429', 3000)
      await m.type('make-project-name', 'Spring launch')
      await m.until(() => !m.find('make-project-error'), 'the error cleared', 3000)
    } finally { await m.unmount() }
  })

  test('after a 409 the checks follow the trimmed name: the "-2" line stays for "Launch " with a space', async () => {
    signIn()
    let reads = 0
    routes = {
      [`GET /api/rooms/${RID}/make-project`]: () => json(info({ nameTaken: true, folderName: 'Launch-2', membersHash: ++reads === 1 ? 'h1' : 'h2' })),
      [`POST /api/rooms/${RID}/make-project`]: () => conflict('members_changed', 'The people changed.'),
    }
    const m = await mount(<MemoryRouter><MakeProjectDialog roomId={RID} onClose={() => {}} /></MemoryRouter>)
    try {
      await m.until(() => m.html().includes('Launch-2'), 'the -2 line')
      await m.type('make-project-name', 'Launch ')
      await m.click('make-project-confirm')
      await m.until(() => m.find('make-project-changed'), 'the people changed')
      await m.until(() => reads >= 2, 'read again')
      expect(m.html()).toContain(en('rooms.makeProject.nameTaken', { name: 'Launch', folder: 'Launch-2' }))
    } finally { await m.unmount() }
  })
})

describe('A: New project with {name} (a 1:1)', () => {
  const PEER = { id: BEN.id, name: BEN.name }
  const project = { id: PID, name: 'Ben', folderPath: 'projects/Ben', instructions: '', createdBy: ME, createdAt: at(0), canEdit: true }
  test('the room cannot be opened after the project is made: the project page opens, and no second project is made', async () => {
    signIn()
    const went: string[] = []
    setNavigator((to) => went.push(to))
    let creates = 0
    routes = {
      'POST /api/projects': () => { creates++; return json(project, 201) },
      [`POST /api/projects/${PID}/room`]: () => json({ error: { code: 'internal', message: 'x' } }, 500),
    }
    const closed: number[] = []
    const m = await mount(<MemoryRouter><DmProjectDialog peer={PEER} onClose={() => closed.push(1)} /></MemoryRouter>)
    try {
      await m.click('make-project-confirm')
      await m.until(() => went.length === 1, 'went somewhere', 3000)
      expect(went).toEqual([`/projects/${PID}`])
      expect(closed).toEqual([1])
      expect(creates).toBe(1)
    } finally { await m.unmount(); setNavigator(null) }
  })

  test('the name checks: an AI instructions file\'s name inline, the button off; an empty name, the button off', async () => {
    signIn()
    const m = await mount(<MemoryRouter><DmProjectDialog peer={PEER} onClose={() => {}} /></MemoryRouter>)
    try {
      await m.type('make-project-name', 'CLAUDE.md')
      await m.until(() => m.html().includes(en('rooms.makeProject.nameReserved')), 'the refusal')
      expect(m.get('make-project-confirm').hasAttribute('disabled')).toBe(true)
      await m.type('make-project-name', '   ')
      await m.until(() => !m.html().includes(en('rooms.makeProject.nameReserved')), 'the refusal gone')
      expect(m.get('make-project-confirm').hasAttribute('disabled')).toBe(true)
    } finally { await m.unmount() }
    expect(projectNameProblem('_files.md')).toBe('nameReserved')
    expect(projectNameProblem('x'.repeat(101))).toBe('nameLong')
    expect(projectNameProblem(' Launch ')).toBeNull()
  })
})

describe('the Files button of a room whose files go to a team folder', () => {
  test('a project room (by projectRoom too) and a department room with its folder: only with files of its own; others always', () => {
    expect(roomFilesButtonShown({ projectRoom: true })).toBe(false)
    expect(roomFilesButtonShown({ projectRoom: true, roomFiles: true })).toBe(true)
    expect(roomFilesButtonShown({ project: { id: PID, name: 'L', folderPath: 'projects/L', canSave: true, room: true } })).toBe(false)
    expect(roomFilesButtonShown({ kind: 'team', groupFolder: 'groups/Sales' })).toBe(false)
    expect(roomFilesButtonShown({ kind: 'team', groupFolder: 'groups/Sales', roomFiles: true })).toBe(true)
    expect(roomFilesButtonShown({ kind: 'team' })).toBe(true)
    expect(roomFilesButtonShown({ kind: 'group' })).toBe(true)
  })
})

describe('A: the event lines', () => {
  const w = (l: 'en' | 'ko') => ({ t: (k: Parameters<typeof translate>[1], p?: Record<string, string | number>) => translate(l, k, p), nameOf: (u: { name: string } | null) => u?.name ?? '?', folder: l === 'ko' ? '채팅 첨부' : 'Chat attachments' })
  const project = { id: PID, name: 'Atlas' }
  test('project_made: by the person, the name for a viewer who can open it', () => {
    expect(eventText({ type: 'project_made', project }, BEN, w('en'))).toBe('Ben made this conversation the project Atlas.')
    expect(eventText({ type: 'project_made', project: null }, BEN, w('en'))).toBe('Ben made this conversation a project.')
    expect(eventText({ type: 'project_made', project }, BEN, w('ko'))).toBe('Ben님이 이 대화방을 Atlas 프로젝트로 만들었어요.')
  })
  test('project_files_moved: the second sentence only when some stayed', () => {
    expect(eventText({ type: 'project_files_moved', project, moved: 4, kept: 0 }, null, w('en'))).toBe('4 files moved to Atlas › Chat attachments.')
    expect(eventText({ type: 'project_files_moved', project, moved: 1, kept: 2 }, null, w('en'))).toBe('1 file moved to Atlas › Chat attachments. 2 stayed in this conversation.')
    expect(eventText({ type: 'project_files_moved', project: null, moved: 2, kept: 0 }, null, w('en'))).toBe("2 files moved to the project's Chat attachments.")
    expect(eventText({ type: 'project_files_moved', project, moved: 3, kept: 1 }, null, w('ko'))).toBe('파일 3개를 Atlas › 채팅 첨부로 옮겼어요. 1개는 이 대화방에 남았어요.')
    // another project had the name: the folder the files are in, the "-2" one (QA TC-6953)
    expect(eventText({ type: 'project_files_moved', project: { ...project, folder: 'Atlas-2' }, moved: 1, kept: 0 }, null, w('en'))).toBe('1 file moved to Atlas-2 › Chat attachments.')
  })
})

describe('D: the two hints', () => {
  test("the empty ✦ side chat of a project room: it is mine only, and the project page is where its people ask", async () => {
    const m = await mount(<MemoryRouter><ProjectSideHint project={{ id: PID, name: 'Atlas' }} /></MemoryRouter>)
    try {
      expect(m.get('side-chat-intro').textContent).toBe("Only you see this. To ask where Atlas's people see it, ask on the project page.")
      expect(m.get('side-chat-project-link').textContent).toBe('the project page')
      expect(m.get('side-chat-project-link').getAttribute('href')).toBe(`/projects/${PID}`)
    } finally { await m.unmount() }
  })
  test('Korean: 대화방 words as planned', () => {
    expect(translate('ko', 'sideChat.emptyProject', { project: 'Atlas', page: translate('ko', 'sideChat.projectPage') })).toBe('나만 보는 채팅이에요. Atlas 사람들이 함께 보는 곳에서 물어보려면 프로젝트 페이지에서 물어보세요.')
    expect(translate('ko', 'rooms.makeProject.menu')).toBe('프로젝트로 만들기')
    expect(translate('ko', 'rooms.makeProject.confirm')).toBe('프로젝트 만들기')
    expect(translate('ko', 'rooms.project.sameAsGroup', { group: '#영업', project: 'Atlas' })).toBe('#영업과 같은 사람들이에요. Atlas 이야기는 여기서 해요.')
  })
  test('Same people as #{group}: the group a link to its room; nothing without sameAsGroup', async () => {
    const g = { groupId: uuidv7(), name: 'Sales', roomId: '01900000-0000-7000-8000-0000000005e1' }
    const m = await mount(<MemoryRouter><SameAsGroupLine project={{ name: 'Atlas', sameAsGroup: g }} /><SameAsGroupLine project={{ name: 'Other' }} testId="none" /></MemoryRouter>)
    try {
      expect(m.get('room-same-as-group').textContent).toBe('Same people as #Sales. Keep Atlas talk here.')
      expect(m.get('room-same-as-group-link').getAttribute('href')).toBe(`/rooms/${g.roomId}`)
      expect(m.find('none')).toBeNull()
    } finally { await m.unmount() }
  })
})

// P3 polish (docs/AGENTS/plan/20261121-p3-structure-polish.md; QA TC-6731 to TC-6733)
describe('P3: the loser of two conversions (TC-6731)', () => {
  const RID = '01900000-0000-7000-8000-0000000005e2'
  const info: MakeProjectInfo = { suggestedName: 'Launch', members: [ME, BEN, CY], guestsBlocked: [], filesMoving: 0, filesStaying: 0, membersHash: 'h1', folderName: 'Launch', nameTaken: false }
  const already = (more: Record<string, string> = {}) => json({ error: { code: 'conflict', message: 'This conversation just became a project.', params: { reason: 'already_project', ...more } } }, 409)
  test('409 already_project: "just became a project" with a link to it, not the cannot-become line', async () => {
    signIn()
    routes = { [`GET /api/rooms/${RID}/make-project`]: () => json(info), [`POST /api/rooms/${RID}/make-project`]: () => already({ projectId: PID }) }
    const m = await mount(<MemoryRouter><MakeProjectDialog roomId={RID} onClose={() => {}} /></MemoryRouter>)
    try {
      await m.until(() => m.find('make-project-body'), 'the body')
      await m.click('make-project-confirm')
      await m.until(() => m.find('make-project-already'), 'the line')
      expect(m.get('make-project-already').textContent).toContain(en('rooms.makeProject.already'))
      expect(m.get('make-project-already-link').getAttribute('href')).toBe(`/projects/${PID}`)
      expect(m.find('make-project-error')).toBeNull()
      expect(m.get('make-project-confirm').hasAttribute('disabled')).toBe(true)
    } finally { await m.unmount() }
  })
  test('without a project id (one I cannot read) the line stands alone; the read says it too', async () => {
    signIn()
    routes = { [`GET /api/rooms/${RID}/make-project`]: () => already() }
    const m = await mount(<MemoryRouter><MakeProjectDialog roomId={RID} onClose={() => {}} /></MemoryRouter>)
    try {
      await m.until(() => m.find('make-project-already'), 'the line')
      expect(m.find('make-project-already-link')).toBeNull()
    } finally { await m.unmount() }
  })
})

describe('P3: a project room made on purpose stays listed (TC-6733)', () => {
  test('Room.listed: listed before its first message; the project page\'s room is not', () => {
    const made = proj('made', 'Made', { lastMessage: null, listed: true })
    const lazy = proj('lazy', 'Lazy', { lastMessage: null })
    expect(shownInLists([made, lazy, plain('ch')]).map((r) => r.id)).toEqual(['made', 'ch'])
    // the room on screen is always shown
    expect(shownInLists([lazy], 'lazy').map((r) => r.id)).toEqual(['lazy'])
  })
  test('"Hidden conversations" counts only what I hid, not a project room waiting for its first message', async () => {
    signIn()
    const lazy = projRoom('01900000-0000-7000-8000-0000000005f1', 'Lazy', { lastMessage: null })
    const made = projRoom('01900000-0000-7000-8000-0000000005f2', 'Made', { lastMessage: null, listed: true })
    const hid = room({ id: '01900000-0000-7000-8000-0000000005f3', name: 'old', hidden: true, lastMessage: msg(uuidv7()) })
    useRooms.setState({ rooms: [lazy, made, hid], loaded: true })
    useNavFolders.setState({ folders: [] })
    routes = { 'GET /api/nav-folders': () => json({ items: [] }) }
    const m = await mount(<MemoryRouter initialEntries={['/']}><RoomsByKind /></MemoryRouter>)
    try {
      await m.until(() => m.find('chats-panel-hidden'), 'the hidden link')
      expect(m.get('chats-panel-hidden').textContent).toContain(en('rooms.hidden.title', { n: 1 }))
      expect(m.container.textContent).toContain('Made')
      expect(m.container.textContent).not.toContain('Lazy')
    } finally { await m.unmount() }
  })
  test('"New project with" opens its room with ?listed=1', async () => {
    signIn()
    setNavigator(() => {})
    routes = {
      'POST /api/projects': () => json({ id: PID, name: 'Ben', folderPath: 'projects/Ben', instructions: '', createdBy: ME, createdAt: at(0), canEdit: true }, 201),
      [`POST /api/projects/${PID}/room`]: () => json({ error: { code: 'internal', message: 'x' } }, 500),
    }
    const m = await mount(<MemoryRouter><DmProjectDialog peer={{ id: BEN.id, name: BEN.name }} onClose={() => {}} /></MemoryRouter>)
    try {
      await m.click('make-project-confirm')
      await m.until(() => asked.some((a) => a.key === `POST /api/projects/${PID}/room`), 'the room asked', 3000)
      expect(asked.find((a) => a.key === `POST /api/projects/${PID}/room`)!.url).toContain('listed=1')
    } finally { await m.unmount(); setNavigator(null) }
  })
})

describe('P3: the file chip\'s folder link in a department room (TC-6732)', () => {
  test('"Chat attachments" is whole: the group\'s name is the part that is cut', async () => {
    signIn()
    const m = await mount(<InTeamLink path="groups/QA-Team3/Chat attachments/zq-dept.txt" onOpen={() => {}} place="QA-Team3 › Chat attachments" />)
    try {
      expect(m.get('room-file-in-team-head').textContent).toBe('QA-Team3')
      expect(m.get('room-file-in-team-head').getAttribute('class')).toContain('truncate')
      expect(m.get('room-file-in-team-tail').textContent).toBe(' › Chat attachments')
      expect(m.get('room-file-in-team-tail').getAttribute('class')).toContain('shrink-0')
    } finally { await m.unmount() }
  })
  test('a one-folder place stays one truncating name', async () => {
    signIn()
    const m = await mount(<InTeamLink path="shared/Quotes/a.txt" onOpen={() => {}} />)
    try {
      expect(m.find('room-file-in-team-place')).toBeNull()
      expect(m.get('room-file-in-team').textContent).toContain('Quotes')
    } finally { await m.unmount() }
  })
})
