// Folders, project pages and file previews open at once (docs/DECISIONS.md "Folders, project pages and file previews
// open at once"): going back to a folder on the Files page, a project's page or a file's preview shows it as last read,
// with no loading placeholder, while it is read again behind it (store/teamFiles.ts, store/projectPage.ts). A project's
// page asks for the project, its chats and its folder at once (not one after the other); the Files page reads the projects
// store's list instead of its own. A newer read always wins over an older answer, changes made meanwhile are made again
// on top of a list read before them, a file event drops what it touched, an access change drops everything, and a
// sign-out empties both stores.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import type { Chat, FileEntry, Me, Project, TreeResponse } from '@mycel/shared/api'
import { useLocaleStore } from '../../src/i18n'
import Files from '../../src/pages/Files'
import { ProjectFiles, ProjectHome } from '../../src/pages/Projects'
import { useFileBlob } from '../../src/components/FileBody'
import { useWritable } from '../../src/components/FilePanel'
import { DialogHost } from '../../src/components/ui'
import { useProjects } from '../../src/store/projects'
import { useProjectPage } from '../../src/store/projectPage'
import { audienceRead, dropFolders, fileRead, folderKey, keptFile, keptFolder, readFolder, useTeamFiles } from '../../src/store/teamFiles'
import { accessChanged, chatChanged, filesChanged } from '../../src/store/live'
import { useSession } from '../../src/store/session'
import { installDom, mount, removeDom, type Mounted } from './dom-host'

const P1 = '01900000-0000-7000-8000-0000000000e1'
const C1 = '01900000-0000-7000-8000-0000000000f1', C2 = '01900000-0000-7000-8000-0000000000f2', C3 = '01900000-0000-7000-8000-0000000000f3'
const DIR = 'shared/acme'
const entry = (path: string, type: 'file' | 'folder' = 'file', access: 'write' | 'read' = 'write'): FileEntry =>
  ({ path, name: path.split('/').at(-1)!, type, size: type === 'file' ? 5 : null, mtime: '2026-11-12T00:00:00.000Z', mime: null, access })
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const project = (o: Partial<Project> = {}): Project =>
  ({ id: P1, name: 'Acme launch', folderPath: 'projects/acme-launch', instructions: '', createdBy: null, createdAt: '2026-11-09T00:00:00.000Z', canEdit: true, ...o })
const chat = (id: string, title: string, o: Partial<Chat> = {}): Chat =>
  ({ id, projectId: P1, title, engine: 'claude-code', model: null, createdAt: '2026-11-08T00:00:00.000Z', updatedAt: '2026-11-08T00:00:00.000Z', deletedAt: null, runState: 'idle', ...o }) as Chat
const me = { user: { id: 'mia', username: 'mia', name: 'Mia', email: null, role: 'member', locale: 'en', localeChoice: null, mustChangePassword: false, prefs: {} }, groups: [],
  team: { name: 'Acme', defaultLocale: 'en', projectCreators: 'members' }, session: { id: '01900000-0000-7000-8000-000000000099', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' }, server: { version: '0', dev: false, deployment: 'hosted' } } as unknown as Me

let folders: Record<string, FileEntry[]> = {}
let theProject = project()
let chats: Chat[] = []
let bytes = 'hello'
/** every request is held until released (a read on its way) */
let hold: Promise<void> | null = null
/** only the requests whose key matches are held */
let holdOnly: RegExp | null = null
const reads: string[] = []
const realFetch = globalThis.fetch
const localeBefore = useLocaleStore.getState().locale
const statusBefore = useSession.getState().status
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'en' })
  ;(globalThis as Record<string, unknown>).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://x')
    const key = `${init?.method ?? 'GET'} ${url.pathname}${url.search}`
    reads.push(key)
    // the answer is the folder as it was when it was asked (a read on its way answers from before a change)
    const asked = folders[url.searchParams.get('path') ?? '']
    const project = theProject
    if (hold && (!holdOnly || holdOnly.test(key))) await hold
    if (url.pathname === '/api/files/tree') {
      const path = url.searchParams.get('path') ?? ''
      const items = asked
      if (!items) return json(404, { error: { code: 'not_found', message: 'not found' } })
      return json(200, { path, access: 'write', entries: items, nextCursor: null } satisfies TreeResponse)
    }
    if (url.pathname === '/api/projects') return json(200, { items: [theProject] })
    if (url.pathname === `/api/projects/${P1}` && init?.method === 'PATCH') {
      theProject = { ...theProject, ...(JSON.parse(String(init.body)) as Partial<Project>) }
      return json(200, theProject)
    }
    if (url.pathname === `/api/projects/${P1}`) return json(200, project)
    if (url.pathname === '/api/chats') return json(200, { items: chats, nextCursor: null })
    if (url.pathname === '/api/files/audience') return json(200, { path: url.searchParams.get('path'), access: 'write', people: 3, everyone: false })
    if (url.pathname === '/api/files/download') return new Response(bytes, { status: 200, headers: { 'content-type': 'text/plain', 'content-length': String(bytes.length) } })
    if (url.pathname === '/api/files/content') return json(200, { path: url.searchParams.get('path'), size: 5, mtime: '2026-11-12T00:00:00.000Z', sha256: 'x', mime: 'text/plain', binary: false, content: 'h', truncated: true, access: 'write' })
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
  useSession.setState({ status: { kind: 'signed-in', me } } as never)
  folders = { [DIR]: [entry(`${DIR}/plan.md`), entry(`${DIR}/notes.txt`)], 'projects/acme-launch': [entry('projects/acme-launch/brief.md')] }
  theProject = project()
  chats = [chat(C1, 'Kickoff'), chat(C2, 'Budget')]
  bytes = 'hello'
  hold = null
  holdOnly = null
  reads.length = 0
  useTeamFiles.getState().reset()
  useProjectPage.getState().reset()
  useProjects.getState().reset()
})

const count = (re: RegExp) => reads.filter((r) => re.test(r)).length
const held = () => {
  let release!: () => void
  hold = new Promise((r) => (release = r))
  return () => {
    hold = null
    release()
  }
}
const TREE = (path: string) => new RegExp(`^GET /api/files/tree\\?path=${encodeURIComponent(path).replace(/%/g, '%')}&limit=200$`)
const skeleton = (m: Mounted) => m.html().includes('animate-pulse')
const until = async (fn: () => boolean, what: string) => {
  const end = Date.now() + 3000
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('team folders in memory (store/teamFiles.ts)', () => {
  test('a folder just shown joins a read on its way; a read after a change reads again, and the newest one is kept', async () => {
    const release = held()
    const a = readFolder(DIR), b = readFolder(DIR)
    expect(a).toBe(b)
    expect(count(TREE(DIR))).toBe(1)
    // a change made here: the read on its way may be from before it
    folders[DIR] = [entry(`${DIR}/plan.md`)]
    const c = readFolder(DIR, { fresh: true })
    expect(count(TREE(DIR))).toBe(2)
    release()
    const [ra] = await Promise.all([a, c])
    expect(ra.entries).toHaveLength(2)
    expect(keptFolder(DIR)!.entries.map((e) => e.name)).toEqual(['plan.md'])
  })

  test('an older answer that comes back last never replaces a newer one', async () => {
    let releaseOld!: () => void
    hold = new Promise((r) => (releaseOld = r))
    const old = readFolder(DIR)
    await until(() => count(TREE(DIR)) === 1, 'the first read asked')
    hold = null
    folders[DIR] = [entry(`${DIR}/new.md`)]
    await readFolder(DIR, { fresh: true })
    expect(keptFolder(DIR)!.entries.map((e) => e.name)).toEqual(['new.md'])
    folders[DIR] = [entry(`${DIR}/plan.md`), entry(`${DIR}/notes.txt`)]
    releaseOld()
    await old
    expect(keptFolder(DIR)!.entries.map((e) => e.name)).toEqual(['new.md'])
  })

  test('a file event drops the folders it touched and everything under a moved folder; an access change drops all', async () => {
    folders['shared/acme/sub'] = [entry('shared/acme/sub/a.md')]
    folders.shared = [entry(DIR, 'folder')]
    await Promise.all([readFolder(DIR), readFolder('shared/acme/sub'), readFolder('shared')])
    fileRead('shared/acme/sub/a.md', 'v')(new Blob(['a']))
    // a file saved in another folder: these stay
    filesChanged.emit([{ path: 'groups/x/y.md', action: 'update', by: null, turnId: null }])
    expect([!!keptFolder(DIR), !!keptFolder('shared/acme/sub'), !!keptFolder('shared')]).toEqual([true, true, true])
    // shared/acme renamed: its parent, itself and its subfolder go, with the bytes of a file in it
    filesChanged.emit([{ path: 'shared/acme-2', from: DIR, action: 'move', by: null, turnId: null }])
    expect([!!keptFolder(DIR), !!keptFolder('shared/acme/sub'), !!keptFolder('shared')]).toEqual([false, false, false])
    expect(keptFile('shared/acme/sub/a.md', 'v')).toBeNull()
    await readFolder(DIR)
    accessChanged.emit()
    expect(keptFolder(DIR)).toBeNull()
  })

  test('a folder that is gone is dropped; a read started before a sign-out or an access change never lands', async () => {
    await readFolder(DIR)
    delete folders[DIR]
    await expect(readFolder(DIR, { fresh: true })).rejects.toBeDefined()
    expect(keptFolder(DIR)).toBeNull()
    folders[DIR] = [entry(`${DIR}/plan.md`)]
    for (const end of [() => useTeamFiles.getState().reset(), () => accessChanged.emit(), () => dropFolders([DIR])]) {
      const release = held()
      const p = readFolder(DIR, { fresh: true })
      end()
      release()
      await p
      expect(keptFolder(DIR)).toBeNull()
    }
  })

  test("a preview's bytes: small files only, the last 8; not when the file changed or a reset came while they were read", () => {
    fileRead('shared/big.pdf', 'v')(new Blob([new Uint8Array(2 * 1024 * 1024)]))
    expect(keptFile('shared/big.pdf', 'v')).toBeNull()
    for (let i = 0; i < 10; i++) fileRead(`shared/f${i}.md`, 'v')(new Blob([`f${i}`]))
    expect(keptFile('shared/f0.md', 'v')).toBeNull()
    expect(keptFile('shared/f1.md', 'v')).toBeNull()
    expect(keptFile('shared/f9.md', 'v')).not.toBeNull()
    expect(keptFile('shared/f9.md', 'other')).toBeNull()
    // a failed read forgets them; one stopped (the preview moved on) does not
    fileRead('shared/f8.md', 'v')()
    expect(keptFile('shared/f8.md', 'v')).not.toBeNull()
    fileRead('shared/f9.md', 'v')(null)
    expect(keptFile('shared/f9.md', 'v')).toBeNull()
    // saved by someone while it was read: that answer is from before
    const late = fileRead('shared/f7.md', 'v')
    filesChanged.emit([{ path: 'shared/f7.md', action: 'update', by: null, turnId: null }])
    late(new Blob(['old']))
    expect(keptFile('shared/f7.md', 'v')).toBeNull()
    const lateCount = audienceRead(DIR)
    filesChanged.emit([{ path: `${DIR}/x.md`, action: 'create', by: null, turnId: null }])
    dropFolders([folderKey(DIR)])
    lateCount({ path: DIR, access: 'write', people: 9 })
    expect(useTeamFiles.getState().audiences[DIR]).toBeUndefined()
    const beforeReset = fileRead('shared/f6.md', 'v')
    useTeamFiles.getState().reset()
    beforeReset(new Blob(['x']))
    expect(keptFile('shared/f6.md', 'v')).toBeNull()
  })
})

const filesPage = (path: string) => mount(<MemoryRouter initialEntries={[`/files?path=${encodeURIComponent(path)}`]}><Files /><DialogHost /></MemoryRouter>)
const rows = (m: Mounted) => m.container.querySelectorAll('tr[data-testid="file-row"]').length

describe('the Files page', () => {
  test('back to a folder: its rows from the first frame with no placeholder, one read behind it, the projects list not again', async () => {
    let m = await filesPage(DIR)
    await m.until(() => rows(m) === 2, 'the rows')
    await m.until(() => count(/^GET \/api\/projects$/) === 1, 'the projects list')
    await m.unmount()
    reads.length = 0
    folders[DIR] = [...folders[DIR]!, entry(`${DIR}/third.md`)]
    const release = held()
    m = await filesPage(DIR)
    try {
      expect(rows(m)).toBe(2)
      expect(skeleton(m)).toBe(false)
      release()
      await m.until(() => rows(m) === 3, 'the new row after the read behind it')
      expect(count(TREE(DIR))).toBe(1)
      // the projects store read it a moment ago (Files reads it at most every 15 s)
      expect(count(/^GET \/api\/projects/)).toBe(0)
    } finally {
      await m.unmount()
    }
  })

  test('the chip says the count as last answered at once', async () => {
    let m = await filesPage(DIR)
    await m.until(() => m.find('folder-access-chip'), 'the chip')
    await m.unmount()
    const release = held()
    m = await filesPage(DIR)
    try {
      expect(m.find('folder-access-chip')?.textContent).toContain('3')
    } finally {
      release()
      await m.unmount()
    }
  })
})

const projectPage = () => mount(
  <MemoryRouter initialEntries={[`/projects/${P1}`]}>
    <Routes><Route path="/projects/:projectId" element={<ProjectHome />} /></Routes>
    <DialogHost />
  </MemoryRouter>,
)
const chatTitles = (m: Mounted) => m.container.querySelectorAll('[data-testid="project-chat"]').map((e) => e.textContent ?? '')

describe("a project's page", () => {
  test('the first visit asks for the project, its chats and its folder at once when its folder is known', async () => {
    useProjects.getState().put(theProject)
    const release = held()
    const m = await projectPage()
    try {
      // nothing answered yet: all three are on their way
      expect(count(new RegExp(`^GET /api/projects/${P1}\\?manage=1$`))).toBe(1)
      expect(count(/^GET \/api\/chats\?projectId=/)).toBe(1)
      expect(count(TREE('projects/acme-launch'))).toBe(1)
      release()
      await m.until(() => chatTitles(m).length === 2, 'the chats')
      await m.until(() => m.get('project-files').textContent?.includes('1 item'), 'the files')
    } finally {
      await m.unmount()
    }
  })

  test('back to it: the name, chats and files from the first frame, no placeholder; a chat renamed meanwhile shows renamed', async () => {
    let m = await projectPage()
    await m.until(() => chatTitles(m).length === 2 && m.get('project-files').textContent?.includes('1 item'), 'the page')
    await m.unmount()
    // while away: a chat of it renamed (its event), another one made
    chatChanged.emit({ chatId: C1, change: 'updated', chat: chat(C1, 'Kickoff notes', { updatedAt: '2026-11-08T01:00:00.000Z' }) })
    reads.length = 0
    const release = held()
    m = await projectPage()
    try {
      expect(m.html()).toContain('Acme launch')
      expect(skeleton(m)).toBe(false)
      expect(chatTitles(m).join('|')).toContain('Kickoff notes')
      expect(m.get('project-files').textContent).toContain('1 item')
      release()
      await m.settle(50)
      expect([count(/^GET \/api\/projects\//), count(/^GET \/api\/chats\?projectId=/), count(TREE('projects/acme-launch'))]).toEqual([1, 1, 1])
    } finally {
      await m.unmount()
    }
  })

  test('a chat event while the list is read is made again on top of its answer (an older list never undoes it)', async () => {
    holdOnly = /^GET \/api\/chats/
    const release = held()
    const m = await projectPage()
    try {
      await m.until(() => m.html().includes('Acme launch'), 'the project')
      // the list was read before this chat was made
      chatChanged.emit({ chatId: C3, change: 'created', chat: chat(C3, 'Fresh one', { updatedAt: '2026-11-09T00:00:00.000Z' }) })
      chatChanged.emit({ chatId: C2, change: 'deleted', chat: null })
      release()
      await m.until(() => chatTitles(m).length === 2, 'the chats')
      expect(chatTitles(m).map((t) => t.includes('Fresh one') || t.includes('Kickoff'))).toEqual([true, true])
      expect(chatTitles(m).join('|')).not.toContain('Budget')
    } finally {
      await m.unmount()
    }
  })

  test('renamed here while the project was read: that older answer does not put the old name back', async () => {
    useSession.setState({ status: { kind: 'signed-in', me: { ...me, user: { ...me.user, role: 'admin' } } } } as never)
    // a project an admin manages without being in it: its name menu has Rename (the name prompt)
    theProject = project({ member: false, canManage: true })
    const m = await projectPage()
    try {
      await m.until(() => m.find('project-members-only'), 'the page')
      holdOnly = new RegExp(`^GET /api/projects/${P1}`)
      const release = held()
      // a read on its way (an access change reads the page again), then a new name saved here
      accessChanged.emit()
      await until(() => count(new RegExp(`^GET /api/projects/${P1}`)) === 2, 'the read again')
      await m.click('project-menu')
      await m.click('project-rename')
      const field = await m.until(() => m.container.ownerDocument!.body.querySelector('[data-testid="dialog-input"]'), 'the prompt')
      await m.type(field as never, 'Acme launch 2')
      await m.click('dialog-confirm')
      await m.until(() => count(new RegExp(`^PATCH /api/projects/${P1}`)), 'the rename')
      await m.until(() => m.html().includes('Acme launch 2'), 'the new name')
      release()
      await m.settle(50)
      expect(m.html()).toContain('Acme launch 2')
      expect(useProjectPage.getState().pages[P1]?.project.name).toBe('Acme launch 2')
    } finally {
      await m.unmount()
    }
  })

  test('on a computer, /projects/:id/files goes on to its folder without asking for a project it knows', async () => {
    const m = await mount(
      <MemoryRouter initialEntries={[`/projects/${P1}/files`]}>
        <Routes><Route path="/projects/:projectId/files" element={<ProjectFiles />} /><Route path="/files" element={<p data-testid="files-screen" />} /></Routes>
      </MemoryRouter>,
    )
    try {
      await m.until(() => m.find('files-screen'), 'the Files screen')
      expect(count(/^GET \/api\/projects\//)).toBe(1)
      expect(count(/^GET \/api\/files\/tree/)).toBe(0)
    } finally {
      await m.unmount()
    }
    useProjects.getState().put(theProject)
    reads.length = 0
    const again = await mount(
      <MemoryRouter initialEntries={[`/projects/${P1}/files`]}>
        <Routes><Route path="/projects/:projectId/files" element={<ProjectFiles />} /><Route path="/files" element={<p data-testid="files-screen" />} /></Routes>
      </MemoryRouter>,
    )
    try {
      await again.until(() => again.find('files-screen'), 'the Files screen')
      expect(reads).toEqual([])
    } finally {
      await again.unmount()
    }
    // its folder renamed in another window: the project is asked for again
    filesChanged.emit([{ path: 'projects/acme-2', from: 'projects/acme-launch', action: 'move', by: null, turnId: null }])
    const moved = await mount(
      <MemoryRouter initialEntries={[`/projects/${P1}/files`]}>
        <Routes><Route path="/projects/:projectId/files" element={<ProjectFiles />} /><Route path="/files" element={<p data-testid="files-screen" />} /></Routes>
      </MemoryRouter>,
    )
    try {
      await moved.until(() => moved.find('files-screen'), 'the Files screen')
      expect(count(/^GET \/api\/projects\//)).toBe(1)
    } finally {
      await moved.unmount()
    }
  })

  test('an access change while the page is open: nothing of it is kept until the project is read again', async () => {
    const m = await projectPage()
    await m.until(() => chatTitles(m).length === 2, 'the page')
    holdOnly = new RegExp(`^GET /api/projects/${P1}`)
    const release = held()
    accessChanged.emit()
    expect(useProjectPage.getState().pages[P1]).toBeUndefined()
    // a chat event meanwhile changes what is on screen: still not kept
    chatChanged.emit({ chatId: C1, change: 'updated', chat: chat(C1, 'Kickoff notes', { updatedAt: '2026-11-08T01:00:00.000Z' }) })
    await m.settle(30)
    expect(useProjectPage.getState().pages[P1]).toBeUndefined()
    release()
    await m.until(() => useProjectPage.getState().pages[P1], 'kept again once read')
    await m.unmount()
  })

  test('a sign-out or an access change: the next visit starts from nothing', async () => {
    const m = await projectPage()
    await m.until(() => chatTitles(m).length === 2, 'the page')
    await m.unmount()
    expect(useProjectPage.getState().pages[P1]).toBeDefined()
    accessChanged.emit()
    expect(useProjectPage.getState().pages[P1]).toBeUndefined()
    expect(keptFolder('projects/acme-launch')).toBeNull()
  })
})

describe("a file's preview", () => {
  const file = { source: 'team' as const, path: `${DIR}/notes.txt`, name: 'notes.txt' }
  let seen: (Blob | null)[] = []
  function Probe({ f, rev = 0 }: { f: typeof file; rev?: number }) {
    const b = useFileBlob(f, rev)
    seen.push(b.blob)
    return <p data-testid="probe">{b.blob ? 'bytes' : 'loading'}</p>
  }
  test('opened again: its bytes at once, read again behind it, the same bytes keep the viewer as it was', async () => {
    seen = []
    let m = await mount(<Probe f={{ ...file }} />)
    await m.until(() => m.get('probe').textContent === 'bytes', 'the bytes')
    const first = seen.at(-1)!
    await m.unmount()
    reads.length = 0
    seen = []
    const release = held()
    m = await mount(<Probe f={{ ...file }} />)
    try {
      expect(m.get('probe').textContent).toBe('bytes')
      expect(seen.every((b) => b === first)).toBe(true)
      release()
      await m.settle(50)
      expect(count(/^GET \/api\/files\/download/)).toBe(1)
      expect(seen.at(-1)).toBe(first)
    } finally {
      await m.unmount()
    }
    // changed meanwhile: the new bytes replace them
    bytes = 'hello again'
    seen = []
    m = await mount(<Probe f={{ ...file }} />)
    try {
      await until(() => seen.at(-1) !== first && !!seen.at(-1), 'the new bytes')
      expect(await seen.at(-1)!.text()).toBe('hello again')
    } finally {
      await m.unmount()
    }
  })

  test('the pencil: the folder as listed answers, nothing to ask; without a listing it asks once', async () => {
    function Pencil({ path }: { path: string }) {
      const ok = useWritable({ source: 'team', path, name: path.split('/').at(-1)! }, true)
      return <p data-testid="pencil">{ok ? 'yes' : 'no'}</p>
    }
    folders[DIR] = [entry(`${DIR}/notes.txt`, 'file', 'read')]
    await readFolder(DIR)
    let m = await mount(<Pencil path={`${DIR}/notes.txt`} />)
    try {
      await m.settle(30)
      expect(m.get('pencil').textContent).toBe('no')
      expect(count(/^GET \/api\/files\/content/)).toBe(0)
    } finally {
      await m.unmount()
    }
    m = await mount(<Pencil path="groups/acme/other.md" />)
    try {
      await m.until(() => m.get('pencil').textContent === 'yes', 'the answer')
      expect(count(/^GET \/api\/files\/content/)).toBe(1)
    } finally {
      await m.unmount()
    }
  })
})
