// Projects and Files show each change at once (lib/optimistic.ts; docs/DECISIONS.md "Optimistic projects and files"):
// a file's rename, move, trash (and Undo), a new folder and a restore from the trash (pages/Files.tsx,
// store/fileChanges.ts); a project's rename, trash and restore (pages/Projects.tsx, store/projects.ts); a chat moved
// out of a project or deleted on its page. Each shows before the server answers, comes back with one toast when it
// refuses, and a read from before the change does not undo it on screen.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import type { Chat, FileEntry, Me, Project, TrashItem, TreeResponse } from '@mycel/shared/api'
import { useLocaleStore } from '../../src/i18n'
import { resetOptimistic } from '../../src/lib/optimistic'
import Files from '../../src/pages/Files'
import { ProjectHome, ProjectList } from '../../src/pages/Projects'
import { DialogHost } from '../../src/components/ui'
import { useChats } from '../../src/store/chats'
import { filesChanged } from '../../src/store/live'
import { useProjectPage } from '../../src/store/projectPage'
import { readManagedList, useProjects } from '../../src/store/projects'
import { useSession } from '../../src/store/session'
import { keptFolder, useTeamFiles } from '../../src/store/teamFiles'
import { useUi } from '../../src/store/ui'
import { act } from 'react'
import { FakeElement, FakeEvent, installDom, mount, removeDom, type Mounted } from './dom-host'

setDefaultTimeout(30_000)
const DIR = 'shared/acme'
const P1 = '01900000-0000-7000-8000-0000000000e1'
const P2 = '01900000-0000-7000-8000-0000000000e2'
const C1 = '01900000-0000-7000-8000-0000000000f1'
const C2 = '01900000-0000-7000-8000-0000000000f2'
const TRASH1 = '01900000-0000-7000-8000-0000000000a1'
const entry = (path: string, type: 'file' | 'folder' = 'file'): FileEntry =>
  ({ path, name: path.split('/').at(-1)!, type, size: type === 'file' ? 5 : null, mtime: '2026-11-12T00:00:00.000Z', mime: null, access: 'write' })
const project = (o: Partial<Project> = {}): Project =>
  ({ id: P1, name: 'Acme launch', folderPath: 'projects/acme-launch', instructions: '', createdBy: null, createdAt: '2026-11-09T00:00:00.000Z', canEdit: true, canManage: true, ...o })
const chat = (id: string, title: string, o: Partial<Chat> = {}): Chat =>
  ({ id, projectId: P1, title, engine: 'claude-code', model: null, createdAt: '2026-11-08T00:00:00.000Z', updatedAt: '2026-11-08T00:00:00.000Z', deletedAt: null, runState: 'idle', ...o }) as Chat
const meAs = (role: 'member' | 'admin'): Me => ({
  user: { id: 'mia', username: 'mia', name: 'Mia', email: null, role, locale: 'en', localeChoice: null, mustChangePassword: false, prefs: {} }, groups: [],
  team: { name: 'Acme', defaultLocale: 'en', projectCreators: 'members', chatTrashRetentionDays: 14 }, session: { id: '01900000-0000-7000-8000-000000000099', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' }, server: { version: '0', dev: false, deployment: 'hosted' },
}) as unknown as Me
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const refused = (message: string, params?: Record<string, unknown>) => json(409, { error: { code: 'conflict', message, ...(params ? { params } : {}) } })

let folders: Record<string, FileEntry[]> = {}
let projects: Project[] = []
let chats: Chat[] = []
let trash: TrashItem[] = []
/** requests whose "METHOD path" matches wait here for the test's answer */
let holdRe: RegExp | null = null
const waiting: { key: string; body: unknown; answer: (r: Response) => void }[] = []
const reads: string[] = []
const take = async (re: RegExp) => {
  const end = Date.now() + 3000
  for (;;) {
    const i = waiting.findIndex((w) => re.test(w.key))
    if (i >= 0) return waiting.splice(i, 1)[0]!
    if (Date.now() > end) throw new Error(`no request ${re}; waiting: ${waiting.map((w) => w.key).join(', ')}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}
const toasts = () => (useUi.getState() as unknown as { toasts: { level: string; text: string }[] }).toasts
const errors = () => toasts().filter((x) => x.level === 'error')

const realFetch = globalThis.fetch
const localeBefore = useLocaleStore.getState().locale
const statusBefore = useSession.getState().status
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'en' })
  ;(globalThis as Record<string, unknown>).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://x')
    const method = init?.method ?? 'GET'
    const key = `${method} ${url.pathname}${url.search}`
    reads.push(key)
    // a read answers from the moment it was asked (one on its way is from before a change)
    const asked = { folders: { ...folders }, projects: [...projects], chats: [...chats] }
    if (holdRe?.test(key)) return new Promise<Response>((answer) => waiting.push({ key, body: init?.body ? JSON.parse(String(init.body)) : undefined, answer }))
    if (url.pathname === '/api/files/tree') {
      const path = url.searchParams.get('path') ?? ''
      const items = asked.folders[path]
      if (!items) return json(404, { error: { code: 'not_found', message: 'not found' } })
      return json(200, { path, access: 'write', entries: items, nextCursor: null } satisfies TreeResponse)
    }
    if (url.pathname === '/api/files/trash') return json(200, { items: trash, nextCursor: null })
    if (url.pathname === '/api/projects') return json(200, { items: asked.projects })
    const pm = /^\/api\/projects\/([^/]+)$/.exec(url.pathname)
    if (pm && method === 'GET') {
      const p = asked.projects.find((x) => x.id === pm[1])
      return p ? json(200, p) : json(404, { error: { code: 'not_found', message: 'not found' } })
    }
    if (url.pathname === '/api/chats') return json(200, { items: asked.chats, nextCursor: null })
    if (url.pathname === '/api/files/audience') return json(200, { path: url.searchParams.get('path'), access: 'write', people: 3, everyone: false })
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
  useSession.setState({ status: { kind: 'signed-in', me: meAs('member') } } as never)
  folders = { [DIR]: [entry(`${DIR}/archive`, 'folder'), entry(`${DIR}/notes.txt`), entry(`${DIR}/plan.md`)], [`${DIR}/archive`]: [] }
  projects = [project()]
  chats = [chat(C1, 'Kickoff'), chat(C2, 'Budget')]
  trash = []
  holdRe = null
  waiting.length = 0
  reads.length = 0
})
afterEach(() => {
  resetOptimistic()
  useTeamFiles.getState().reset()
  useProjectPage.getState().reset()
  useProjects.getState().reset()
  useChats.getState().reset()
  useUi.setState({ toasts: [] } as never)
})

// ---------------- Files ----------------
const filesPage = (q = `path=${encodeURIComponent(DIR)}`) => mount(<MemoryRouter initialEntries={[`/files?${q}`]}><Files /><DialogHost /></MemoryRouter>)
const names = (m: Mounted) => m.container.querySelectorAll('tr[data-testid="file-row"]').map((r) => r.querySelector('button')?.textContent?.trim() ?? '')
const row = (m: Mounted, name: string) => m.container.querySelectorAll('tr[data-testid="file-row"]').find((r) => r.querySelectorAll('button').some((b) => b.textContent?.trim() === name))!
const body = (m: Mounted) => m.container.ownerDocument!.body as unknown as FakeElement
const inBody = (m: Mounted, id: string) => body(m).querySelector(`[data-testid="${id}"]`)
async function rowAction(m: Mounted, name: string, action: string) {
  await m.click(row(m, name).querySelector('[data-testid="file-menu"]')!)
  await m.click(action)
}
async function prompt(m: Mounted, text: string) {
  const field = await m.until(() => inBody(m, 'dialog-input'), 'the prompt')
  await m.type(field as never, text)
  await m.click(inBody(m, 'dialog-confirm')!)
}
async function confirm(m: Mounted, yes = true) {
  const ok = await m.until(() => inBody(m, 'dialog-confirm'), 'the confirm')
  await m.click(yes ? ok : (ok.parentNode as FakeElement).querySelectorAll('button').find((b) => b.textContent?.trim() === 'Cancel')!)
}

describe('the Files page', () => {
  test('rename: the new name in its place before the server answers; a listing from before does not undo it; refused, the old name comes back with one toast', async () => {
    const m = await filesPage()
    try {
      await m.until(() => names(m).length === 3, 'the rows')
      holdRe = /^POST \/api\/files\/move/
      await rowAction(m, 'plan.md', 'file-rename')
      await prompt(m, 'a-plan.md')
      // in the server's order at once: after the folder, before notes.txt
      expect(names(m)).toEqual(['archive', 'a-plan.md', 'notes.txt'])
      expect(keptFolder(DIR)!.entries.map((e) => e.name)).toEqual(['archive', 'a-plan.md', 'notes.txt'])
      const req = await take(/^POST \/api\/files\/move/)
      expect(req.body).toMatchObject({ from: `${DIR}/plan.md`, to: `${DIR}/a-plan.md`, onExists: 'fail' })
      // someone else's change in this folder: the listing read now is from before the rename
      holdRe = /^POST \/api\/files\/move/
      filesChanged.emit([{ path: `${DIR}/other.md`, action: 'create', by: null, turnId: null }])
      await m.settle(30)
      expect(names(m)).toEqual(['archive', 'a-plan.md', 'notes.txt'])
      req.answer(refused('A file with that name is already there.'))
      await m.until(() => names(m).includes('plan.md'), 'the old name back')
      expect(names(m)).toEqual(['archive', 'notes.txt', 'plan.md'])
      expect(errors().map((x) => x.text)).toEqual(['A file with that name is already there.'])
    } finally {
      await m.unmount()
    }
  })

  test('rename accepted: the server copy stays, and the listing read after it shows it', async () => {
    const m = await filesPage()
    try {
      await m.until(() => names(m).length === 3, 'the rows')
      holdRe = /^POST \/api\/files\/move/
      await rowAction(m, 'plan.md', 'file-rename')
      await prompt(m, 'z-plan.md')
      expect(names(m)).toEqual(['archive', 'notes.txt', 'z-plan.md'])
      const req = await take(/^POST \/api\/files\/move/)
      folders[DIR] = [entry(`${DIR}/archive`, 'folder'), entry(`${DIR}/notes.txt`), entry(`${DIR}/z-plan.md`)]
      req.answer(json(200, { entry: entry(`${DIR}/z-plan.md`) }))
      await m.settle(50)
      expect(names(m)).toEqual(['archive', 'notes.txt', 'z-plan.md'])
      expect(errors()).toEqual([])
    } finally {
      await m.unmount()
    }
  })

  test('move: the row leaves at once, "moved" comes with the answer; refused, it is back with one toast', async () => {
    const m = await filesPage()
    try {
      await m.until(() => names(m).length === 3, 'the rows')
      holdRe = /^POST \/api\/files\/move$/
      for (const answer of ['ok', 'refused'] as const) {
        await rowAction(m, 'notes.txt', 'file-move')
        const pick = await m.until(() => body(m).querySelectorAll('button').find((b) => b.textContent?.trim() === 'archive' && !b.closest('tr')), 'the picker folder')
        await m.click(pick)
        await m.until(() => inBody(m, 'folder-pick')?.getAttribute('disabled') === null, 'the pick button')
        await m.click(inBody(m, 'folder-pick')!)
        expect(names(m)).toEqual(['archive', 'plan.md'])
        const req = await take(/^POST \/api\/files\/move$/)
        expect(req.body).toMatchObject({ from: `${DIR}/notes.txt`, to: `${DIR}/archive/notes.txt`, onExists: 'rename' })
        if (answer === 'ok') {
          folders[DIR] = [entry(`${DIR}/archive`, 'folder'), entry(`${DIR}/plan.md`)]
          req.answer(json(200, { entry: entry(`${DIR}/archive/notes.txt`) }))
          await m.until(() => toasts().some((x) => x.level === 'success'), 'the moved toast')
          expect(names(m)).toEqual(['archive', 'plan.md'])
          // (back for the next round: the server put it back)
          useUi.setState({ toasts: [] } as never)
          folders[DIR] = [entry(`${DIR}/archive`, 'folder'), entry(`${DIR}/notes.txt`), entry(`${DIR}/plan.md`)]
          filesChanged.emit([{ path: `${DIR}/notes.txt`, action: 'create', by: null, turnId: null }])
          await m.until(() => names(m).length === 3, 'the row back from the server')
        } else {
          req.answer(refused('You cannot move it there.'))
          await m.until(() => names(m).length === 3, 'the row back')
          expect(names(m)).toEqual(['archive', 'notes.txt', 'plan.md'])
          expect(errors().map((x) => x.text)).toEqual(['You cannot move it there.'])
          expect(toasts().some((x) => x.level === 'success')).toBe(false)
        }
      }
    } finally {
      await m.unmount()
    }
  })

  test("move: the server's question is asked with the row already gone; a no puts it back without an error", async () => {
    const m = await filesPage()
    try {
      await m.until(() => names(m).length === 3, 'the rows')
      holdRe = /^POST \/api\/files\/move$/
      await rowAction(m, 'notes.txt', 'file-move')
      await m.click(await m.until(() => body(m).querySelectorAll('button').find((b) => b.textContent?.trim() === 'archive' && !b.closest('tr')), 'the picker folder'))
      await m.until(() => inBody(m, 'folder-pick')?.getAttribute('disabled') === null, 'the pick button')
      await m.click(inBody(m, 'folder-pick')!)
      ;(await take(/^POST \/api\/files\/move$/)).answer(refused('narrowed', { reason: 'audience_narrowed', lostViewers: 3 }))
      await m.until(() => inBody(m, 'dialog-confirm'), 'the question')
      expect(names(m)).toEqual(['archive', 'plan.md'])
      await confirm(m, false)
      await m.until(() => names(m).length === 3, 'the row back')
      expect(toasts()).toEqual([])
    } finally {
      await m.unmount()
    }
  })

  test('trash: gone before the server answers; Undo brings it back at once; a refused Undo takes it out again with one toast', async () => {
    const m = await filesPage()
    try {
      await m.until(() => names(m).length === 3, 'the rows')
      holdRe = /^(DELETE \/api\/files|POST \/api\/files\/trash)/
      await rowAction(m, 'plan.md', 'file-trash')
      await confirm(m)
      expect(names(m)).toEqual(['archive', 'notes.txt'])
      expect(toasts()).toEqual([])
      folders[DIR] = [entry(`${DIR}/archive`, 'folder'), entry(`${DIR}/notes.txt`)]
      ;(await take(/^DELETE \/api\/files\?path=/)).answer(json(200, { trashId: TRASH1, purgeAt: '2026-12-12T00:00:00.000Z' }))
      const told = await m.until(() => (toasts() as unknown as { level: string; action?: { run: () => void } }[]).find((x) => x.action), 'the trashed toast with Undo')
      expect(told.level).toBe('info')
      told.action!.run()
      await m.until(() => names(m).length === 3, 'back at once')
      expect(names(m)).toEqual(['archive', 'notes.txt', 'plan.md'])
      const undo = await take(new RegExp(`^POST /api/files/trash/${TRASH1}/restore`))
      undo.answer(json(404, { error: { code: 'not_found', message: 'It is not in the trash any more.' } }))
      await m.until(() => names(m).length === 2, 'out again')
      expect(errors().map((x) => x.text)).toEqual(['It is not in the trash any more.'])
    } finally {
      await m.unmount()
    }
  })

  test('trash refused: the row is back with the server words', async () => {
    const m = await filesPage()
    try {
      await m.until(() => names(m).length === 3, 'the rows')
      holdRe = /^DELETE \/api\/files/
      await rowAction(m, 'notes.txt', 'file-trash')
      await confirm(m)
      expect(names(m)).toEqual(['archive', 'plan.md'])
      ;(await take(/^DELETE \/api\/files/)).answer(json(403, { error: { code: 'forbidden', message: 'Only an admin can delete it.' } }))
      await m.until(() => names(m).length === 3, 'the row back')
      expect(errors().map((x) => x.text)).toEqual(['Only an admin can delete it.'])
    } finally {
      await m.unmount()
    }
  })

  test('the selection to the trash: all leave at once; the one refused comes back, one toast for the batch', async () => {
    const m = await filesPage()
    try {
      await m.until(() => names(m).length === 3, 'the rows')
      const tick = async (name: string) => {
        const box = row(m, name).querySelector('input[type="checkbox"]')!
        Object.getOwnPropertyDescriptor(FakeElement.prototype, 'checked')!.set!.call(box, true)
        await m.click(box)
      }
      await tick('notes.txt')
      await tick('plan.md')
      await m.until(() => m.find('bulk-bar'), 'the selection bar')
      holdRe = /^DELETE \/api\/files/
      await m.click('bulk-delete')
      await confirm(m)
      expect(names(m)).toEqual(['archive'])
      folders[DIR] = [entry(`${DIR}/archive`, 'folder'), entry(`${DIR}/plan.md`)]
      ;(await take(/^DELETE \/api\/files\?path=shared%2Facme%2Fnotes/)).answer(json(200, { trashId: TRASH1, purgeAt: '2026-12-12T00:00:00.000Z' }))
      ;(await take(/^DELETE \/api\/files\?path=shared%2Facme%2Fplan/)).answer(json(403, { error: { code: 'forbidden', message: 'Only an admin can delete it.' } }))
      await m.until(() => names(m).length === 2, 'the refused one back')
      expect(names(m)).toEqual(['archive', 'plan.md'])
      expect(toasts()).toHaveLength(1)
      expect(toasts()[0]!.level).toBe('warn')
    } finally {
      await m.unmount()
    }
  })

  test("the selection's Undo brings each row back at once with its own trash id; a read from before is not kept for the folder", async () => {
    const m = await filesPage()
    try {
      await m.until(() => names(m).length === 3, 'the rows')
      for (const name of ['notes.txt', 'plan.md']) {
        const box = row(m, name).querySelector('input[type="checkbox"]')!
        Object.getOwnPropertyDescriptor(FakeElement.prototype, 'checked')!.set!.call(box, true)
        await m.click(box)
      }
      await m.until(() => m.find('bulk-bar'), 'the selection bar')
      holdRe = /^(DELETE \/api\/files|POST \/api\/files\/trash|GET \/api\/files\/tree)/
      // a read of the folder on its way when the rows go (from before the change)
      filesChanged.emit([{ path: `${DIR}/x.md`, action: 'create', by: null, turnId: null }])
      const before = await take(/^GET \/api\/files\/tree/)
      await m.click('bulk-delete')
      await confirm(m)
      expect(names(m)).toEqual(['archive'])
      before.answer(json(200, { path: DIR, access: 'write', entries: folders[DIR], nextCursor: null }))
      await m.settle(20)
      expect(keptFolder(DIR)?.entries.map((e) => e.name) ?? ['archive']).toEqual(['archive'])
      expect(names(m)).toEqual(['archive'])
      folders[DIR] = [entry(`${DIR}/archive`, 'folder')]
      ;(await take(/notes/)).answer(json(200, { trashId: TRASH1, purgeAt: '2026-12-12T00:00:00.000Z' }))
      ;(await take(/plan/)).answer(json(200, { trashId: '01900000-0000-7000-8000-0000000000a2', purgeAt: '2026-12-12T00:00:00.000Z' }))
      holdRe = /^POST \/api\/files\/trash/
      const told = await m.until(() => (toasts() as unknown as { action?: { run: () => void } }[]).find((x) => x.action), 'the toast with Undo')
      told.action!.run()
      await m.until(() => names(m).length === 3, 'both back at once')
      const a = await take(new RegExp(`/api/files/trash/${TRASH1}/restore`))
      const b = await take(/\/api\/files\/trash\/01900000-0000-7000-8000-0000000000a2\/restore/)
      folders[DIR] = [entry(`${DIR}/archive`, 'folder'), entry(`${DIR}/notes.txt`), entry(`${DIR}/plan.md`)]
      a.answer(json(200, { entry: entry(`${DIR}/notes.txt`) }))
      b.answer(json(200, { entry: entry(`${DIR}/plan.md`) }))
      await m.settle(50)
      expect(names(m)).toEqual(['archive', 'notes.txt', 'plan.md'])
      expect(errors()).toEqual([])
    } finally {
      await m.unmount()
    }
  })

  test('new folder: in its place among the folders at once; refused, it goes with one toast', async () => {
    const m = await filesPage()
    try {
      await m.until(() => names(m).length === 3, 'the rows')
      holdRe = /^POST \/api\/files\/mkdir/
      await m.click('new-folder-button')
      await prompt(m, 'Budget')
      expect(names(m)).toEqual(['archive', 'Budget', 'notes.txt', 'plan.md'])
      ;(await take(/^POST \/api\/files\/mkdir/)).answer(refused('A folder with that name is already there.'))
      await m.until(() => names(m).length === 3, 'gone again')
      expect(errors().map((x) => x.text)).toEqual(['A folder with that name is already there.'])
      // accepted: the server's copy stays
      await m.click('new-folder-button')
      await prompt(m, 'Budget')
      expect(names(m)).toContain('Budget')
      const req = await take(/^POST \/api\/files\/mkdir/)
      expect(req.body).toEqual({ path: `${DIR}/Budget` })
      folders[DIR] = [entry(`${DIR}/archive`, 'folder'), entry(`${DIR}/Budget`, 'folder'), entry(`${DIR}/notes.txt`), entry(`${DIR}/plan.md`)]
      req.answer(json(201, entry(`${DIR}/Budget`, 'folder')))
      await m.settle(50)
      expect(names(m)).toEqual(['archive', 'Budget', 'notes.txt', 'plan.md'])
    } finally {
      await m.unmount()
    }
  })

  test('restore from the trash: the row leaves at once; refused, it is back in its place with one toast', async () => {
    trash = [
      { id: TRASH1, originalPath: `${DIR}/old.md`, type: 'file', deletedAt: '2026-11-12T00:00:00.000Z', purgeAt: '2026-12-12T00:00:00.000Z', deletedBy: null, size: 5, turnId: null } as unknown as TrashItem,
      { id: '01900000-0000-7000-8000-0000000000a2', originalPath: `${DIR}/older.md`, type: 'file', deletedAt: '2026-11-11T00:00:00.000Z', purgeAt: '2026-12-11T00:00:00.000Z', deletedBy: null, size: 5, turnId: null } as unknown as TrashItem,
    ]
    const m = await filesPage(`path=${encodeURIComponent(DIR)}&view=trash`)
    const items = () => m.container.querySelectorAll('[data-testid="trash-item"]').length
    try {
      await m.until(() => items() === 2, 'the trash')
      holdRe = /^POST \/api\/files\/trash/
      await m.click(m.container.querySelectorAll('[data-testid="trash-restore"]')[0]!)
      expect(items()).toBe(1)
      ;(await take(/^POST \/api\/files\/trash/)).answer(json(403, { error: { code: 'forbidden', message: 'You cannot put it back there.' } }))
      await m.until(() => items() === 2, 'back')
      expect(m.container.querySelectorAll('[data-testid="trash-item"]')[0]!.textContent).toContain('old.md')
      expect(errors().map((x) => x.text)).toEqual(['You cannot put it back there.'])
    } finally {
      await m.unmount()
    }
  })
})

// ---------------- Projects ----------------
const listPage = () => mount(<MemoryRouter initialEntries={['/projects']}><ProjectList /><DialogHost /></MemoryRouter>)
const cards = (m: Mounted) => m.container.querySelectorAll('[data-testid="project-card"]').map((c) => c.textContent ?? '')
const projectPage = () => mount(
  <MemoryRouter initialEntries={[`/projects/${P1}`]}>
    <Routes>
      <Route path="/projects/:projectId" element={<ProjectHome />} />
      <Route path="/projects" element={<p data-testid="projects-list-screen" />} />
    </Routes>
    <DialogHost />
  </MemoryRouter>,
)
const chatTitles = (m: Mounted) => m.container.querySelectorAll('[data-testid="project-chat"]').map((e) => e.textContent ?? '')
async function cardAction(m: Mounted, action: string) {
  await m.click(m.get('project-card-menu').querySelector('button') ?? m.get('project-card-menu'))
  await m.click(await m.until(() => inBody(m, action), action))
}

describe('projects', () => {
  test('rename on the list: the card and every name at once; a list read from before keeps it; refused, back with one toast', async () => {
    const m = await listPage()
    try {
      await m.until(() => cards(m).length === 1, 'the card')
      holdRe = /^PATCH \/api\/projects\//
      await cardAction(m, 'project-card-rename')
      await prompt(m, 'Acme go-live')
      expect(cards(m)[0]).toContain('Acme go-live')
      expect(useProjects.getState().byId[P1]?.name).toBe('Acme go-live')
      // a read of the list answered while the rename is on its way: the old name in it does not show
      await readManagedList({ fresh: true })
      expect(cards(m)[0]).toContain('Acme go-live')
      const req = await take(/^PATCH \/api\/projects\//)
      expect(req.body).toEqual({ name: 'Acme go-live' })
      req.answer(refused('A project with that name is already there.'))
      await m.until(() => cards(m)[0]?.includes('Acme launch'), 'the old name back')
      expect(useProjects.getState().byId[P1]?.name).toBe('Acme launch')
      expect(errors().map((x) => x.text)).toEqual(['A project with that name is already there.'])
    } finally {
      await m.unmount()
    }
  })

  test('to the trash from the list (a member): the card says "in the trash" after the confirm, before the server (its members keep it, QA TC-1060); refused, it is back as it was', async () => {
    const m = await listPage()
    try {
      await m.until(() => cards(m).length === 1, 'the card')
      holdRe = /^DELETE \/api\/projects\//
      await cardAction(m, 'project-card-delete')
      await confirm(m)
      await m.until(() => m.find('project-card-state'), 'in the trash at once')
      ;(await take(/^DELETE \/api\/projects\//)).answer(json(403, { error: { code: 'forbidden', message: 'Only an admin can delete it.' } }))
      await m.until(() => !m.find('project-card-state'), 'the card back as it was')
      expect(cards(m)).toHaveLength(1)
      expect(errors().map((x) => x.text)).toEqual(['Only an admin can delete it.'])
    } finally {
      await m.unmount()
    }
  })

  test('to the trash when someone deleted it first: the card stays gone, one note and no error', async () => {
    const m = await listPage()
    try {
      await m.until(() => cards(m).length === 1, 'the card')
      holdRe = /^DELETE \/api\/projects\//
      await cardAction(m, 'project-card-delete')
      await confirm(m)
      await m.until(() => m.find('project-card-state'), 'in the trash at once')
      ;(await take(/^DELETE \/api\/projects\//)).answer(json(404, { error: { code: 'not_found', message: 'not found' } }))
      await m.until(() => cards(m).length === 0, 'the card gone')
      await m.settle(50)
      expect(cards(m)).toHaveLength(0)
      expect(errors()).toEqual([])
      expect(toasts()).toHaveLength(1)
    } finally {
      await m.unmount()
    }
  })

  test('to the trash from the list (an admin who is a member): the card says "in the trash" at once and the server copy settles it', async () => {
    useSession.setState({ status: { kind: 'signed-in', me: meAs('admin') } } as never)
    const m = await listPage()
    try {
      await m.until(() => cards(m).length === 1, 'the card')
      holdRe = /^DELETE \/api\/projects\//
      await cardAction(m, 'project-card-delete')
      await confirm(m)
      await m.until(() => m.find('project-card-state'), 'in the trash at once')
      projects = [project({ inTrash: true, member: false, wasMember: true })]
      ;(await take(/^DELETE \/api\/projects\//)).answer(new Response(null, { status: 204 }))
      await m.settle(50)
      expect(cards(m)).toHaveLength(1)
      expect(m.find('project-card-state')).not.toBeNull()
      expect(useProjects.getState().byId[P1]?.member).toBe(false)
      expect(errors()).toEqual([])
    } finally {
      await m.unmount()
    }
  })

  test("restore on the project's page: the trash note goes at once; refused for a purged folder, it is back without 되돌리기", async () => {
    useSession.setState({ status: { kind: 'signed-in', me: meAs('admin') } } as never)
    projects = [project({ inTrash: true, member: false })]
    const m = await projectPage()
    try {
      await m.until(() => m.find('project-restore'), 'the trash note')
      holdRe = /^POST \/api\/projects\/[^/]+\/restore/
      await m.click('project-restore')
      expect(m.find('project-restore')).toBeNull()
      ;(await take(/restore/)).answer(refused('Its folder was deleted for good.', { reason: 'project_folder_purged' }))
      await m.until(() => m.html().includes('project-trash') || useProjects.getState().byId[P1]?.inTrash, 'back in the trash')
      await m.settle(30)
      expect(m.find('project-restore')).toBeNull()
      expect(useProjects.getState().byId[P1]?.inTrash).toBe(true)
      expect(errors().map((x) => x.text)).toEqual(['Its folder was deleted for good.'])
    } finally {
      await m.unmount()
    }
  })

  test("on a project's page: a chat moved out that the server refuses is back in the list", async () => {
    projects = [project(), project({ id: P2, name: 'Acme other', folderPath: 'projects/acme-other' })]
    const m = await projectPage()
    try {
      await m.until(() => chatTitles(m).length === 2, 'the chats')
      holdRe = /^PATCH \/api\/chats\//
      const first = m.container.querySelectorAll('[data-testid="project-chat-menu"]')[0]!
      await m.click(first.querySelector('button') ?? first)
      await m.click(await m.until(() => inBody(m, 'project-chat-move'), 'move'))
      const choices = await m.until(() => (m.find('chat-project-choices')?.textContent?.includes('Acme other') ? m.get('chat-project-choices') : null), 'the projects')
      const radio = choices.querySelectorAll('input').find((r) => r.parentNode?.textContent?.includes('Acme other'))!
      // a click on a radio checks it (past React's value tracker, as a browser does), then React hears the click
      await act(async () => {
        Object.getOwnPropertyDescriptor(FakeElement.prototype, 'checked')!.set!.call(radio, true)
        radio.dispatchEvent(new FakeEvent('click', { bubbles: true, cancelable: true }))
      })
      await m.click(await m.until(() => (inBody(m, 'chat-project-save')?.getAttribute('disabled') === null ? inBody(m, 'chat-project-save') : null), 'save'))
      await m.until(() => chatTitles(m).length === 1, 'the row gone at once')
      ;(await take(/^PATCH \/api\/chats\//)).answer(refused('It cannot move there.'))
      await m.until(() => chatTitles(m).length === 2, 'the row back')
      expect(errors()).toHaveLength(1)
    } finally {
      await m.unmount()
    }
  })

  test("on a project's page: a chat deleted leaves at once; refused, it is back; a chats read from before keeps it out", async () => {
    const m = await projectPage()
    try {
      await m.until(() => chatTitles(m).length === 2, 'the chats')
      holdRe = /^DELETE \/api\/chats\//
      const del = async () => {
        const menu = m.container.querySelectorAll('[data-testid="project-chat-menu"]')[0]!
        await m.click(menu.querySelector('button') ?? menu)
        await m.click(await m.until(() => inBody(m, 'project-chat-delete'), 'delete'))
        await confirm(m)
      }
      await del()
      await m.until(() => chatTitles(m).length === 1, 'gone at once')
      ;(await take(/^DELETE \/api\/chats\//)).answer(json(500, { error: { code: 'internal', message: 'Something went wrong.' } }))
      await m.until(() => chatTitles(m).length === 2, 'back')
      expect(errors()).toHaveLength(1)
      // again; while it is on its way the page reads its chats (from before the delete): the row stays out
      await del()
      await m.until(() => chatTitles(m).length === 1, 'gone at once')
      const req = await take(/^DELETE \/api\/chats\//)
      useProjectPage.getState().reset()
      ;(await import('../../src/store/live')).accessChanged.emit()
      await m.until(() => reads.filter((r) => r.startsWith('GET /api/chats?projectId=')).length >= 2, 'the chats read again')
      await m.settle(30)
      expect(chatTitles(m)).toHaveLength(1)
      chats = [chat(C2, 'Budget')]
      req.answer(json(200, { id: C1, deletedAt: '2026-11-13T00:00:00.000Z', purgeAt: '2026-11-27T00:00:00.000Z' }))
      await m.settle(30)
      expect(chatTitles(m)).toHaveLength(1)
      expect(errors()).toHaveLength(1)
    } finally {
      await m.unmount()
    }
  })
})
