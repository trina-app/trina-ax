// A project's page with nothing in it yet (pages/Projects.tsx ProjectPage; docs/DECISIONS.md "Making a project", owner
// 2026-11-13: empty, the quiet lines were easy to miss), rendered:
// - for someone who may edit, empty Instructions and Files are each a box with one line and one button ("Write
//   instructions", "Upload files"); instructions of only spaces and line breaks count as none (the server keeps them
//   untrimmed); while the folder is still being read the files box is there already, as grey bars (no jump);
// - filled, they are the one-line rows again, with no box buttons;
// - someone who cannot edit sees the rows, never the boxes.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import type { Me, Project } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import { ProjectHome } from '../../src/pages/Projects'
import { useSession } from '../../src/store/session'
import { useUi } from '../../src/store/ui'
import { installDom, mount, removeDom } from './dom-host'

const en = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate('en', key, vars)
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
let n = 0
/** a new id per test: the page keeps what it last showed per project (store/projectPage.ts) */
const nextId = () => `01900000-0000-7000-8000-0000000001${String(++n).padStart(2, '0')}`
const project = (id: string, o: Partial<Project> = {}): Project =>
  ({ id, name: 'Hello', folderPath: `users/olga/projects/hello-${n}`, instructions: '', createdBy: { id: 'olga', name: 'Olga' }, createdAt: '2026-11-13T00:00:00.000Z', canEdit: true, canManage: true, ...o })
const me = {
  user: { id: 'olga', username: 'olga', name: 'Olga', email: null, role: 'member', locale: 'en', localeChoice: null, mustChangePassword: false, prefs: {} },
  groups: [], team: { name: 'Acme', defaultLocale: 'en', projectCreators: 'members' }, session: { id: '01900000-0000-7000-8000-00000000000a', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' },
  server: { version: '0', dev: false, deployment: 'hosted' },
} as unknown as Me
const tree = (path: string, names: string[]) => ({ path, access: 'write', entries: names.map((name) => ({ name, path: `${path}/${name}`, type: 'file', size: 4, mtime: '2026-11-13T00:00:00.000Z', mime: 'text/markdown', access: 'write' })), nextCursor: null })

let routes: Record<string, (url: string) => Response | Promise<Response>> = {}
const realFetch = globalThis.fetch
const before = { locale: useLocaleStore.getState().locale, status: useSession.getState().status }
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'en' })
  useSession.setState({ status: { kind: 'signed-in', me } } as never)
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const key = `${init?.method ?? 'GET'} ${url.split('?')[0]}`
    return routes[key]?.(url) ?? json(404, { error: { code: 'not_found', message: `no route ${key}` } })
  }) as unknown as typeof fetch
})
afterEach(() => useUi.setState({ toasts: [] }))
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

describe('a project page with nothing in it yet', () => {
  test('instructions of only spaces and an empty folder: two boxes with their buttons; while the folder is read, the files box is there', async () => {
    const id = nextId()
    const p = project(id, { instructions: '  \n\t\n ' })
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    routes = {
      [`GET /api/projects/${id}`]: () => json(200, p),
      'GET /api/chats': () => json(200, { items: [], nextCursor: null }),
      'GET /api/files/tree': async () => (await held, json(200, tree(p.folderPath, []))),
    }
    const m = await page(id)
    try {
      await m.until(() => m.find('project-instructions-write'), 'the instructions box', 2000)
      expect(m.get('project-instructions-write').textContent?.trim()).toBe(en('projects.page.writeInstructions'))
      expect(m.get('project-instructions-empty').textContent).toBe(en('projects.page.instructionsEmpty', { ai: 'Trina' }))
      expect(m.find('project-instructions-toggle')).toBeNull()
      // still reading the folder: the files box with grey bars, not the one-line row
      expect(m.get('project-files').querySelector('[data-loading="true"]')).not.toBeNull()
      expect(m.find('project-files-toggle')).toBeNull()
      expect(m.find('project-files-upload')).toBeNull()
      release()
      await m.until(() => m.find('project-files-upload'), 'the files box', 2000)
      expect(m.get('project-files-upload').textContent?.trim()).toBe(en('projects.page.uploadFiles'))
      expect(m.get('project-files-empty').textContent).toBe(en('projects.page.filesEmptyHint', { ai: 'Trina' }))
      expect(m.get('project-files').querySelector('[data-loading]')).toBeNull()
      expect(m.find('project-files-toggle')).toBeNull()
      // words in English first, then Korean in plain words
      expect([en('projects.page.writeInstructions'), en('projects.page.uploadFiles')]).toEqual(['Write instructions', 'Upload files'])
      expect([translate('ko', 'projects.page.writeInstructions'), translate('ko', 'projects.page.uploadFiles')]).toEqual(['지침 쓰기', '파일 올리기'])
    } finally { await m.unmount() }
  })

  test('filled: the one-line rows again, no box buttons', async () => {
    const id = nextId()
    const p = project(id, { instructions: '# Hello\n\nShort answers.' })
    routes = {
      [`GET /api/projects/${id}`]: () => json(200, p),
      'GET /api/chats': () => json(200, { items: [], nextCursor: null }),
      'GET /api/files/tree': () => json(200, tree(p.folderPath, ['plan.md'])),
    }
    const m = await page(id)
    try {
      await m.until(() => m.find('project-files-toggle')?.textContent?.includes(en('projects.items', { n: 1 })), 'the files row', 2000)
      expect(m.get('project-files-toggle').textContent).toContain(en('projects.items', { n: 1 }))
      expect(m.find('project-instructions-toggle')).not.toBeNull()
      for (const x of ['project-instructions-write', 'project-files-upload']) expect({ x, shown: !!m.find(x) }).toEqual({ x, shown: false })
    } finally { await m.unmount() }
  })

  test('someone who cannot edit: the rows, never the boxes', async () => {
    const id = nextId()
    const p = project(id, { canEdit: false, canManage: false })
    routes = {
      [`GET /api/projects/${id}`]: () => json(200, p),
      'GET /api/chats': () => json(200, { items: [], nextCursor: null }),
      'GET /api/files/tree': () => json(200, tree(p.folderPath, [])),
    }
    const m = await page(id)
    try {
      await m.until(() => m.find('project-files-toggle')?.textContent?.includes(en('projects.items', { n: 0 })), 'the files row', 2000)
      expect(m.find('project-instructions-toggle')).not.toBeNull()
      for (const x of ['project-instructions-write', 'project-files-upload']) expect({ x, shown: !!m.find(x) }).toEqual({ x, shown: false })
    } finally { await m.unmount() }
  })
})
