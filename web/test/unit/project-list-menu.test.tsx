// The "…" on each card of the Projects list (pages/Projects.tsx), rendered and clicked:
// - what it offers: 이름 바꾸기 and 삭제 only to people who may edit the project (Project.canEdit), 링크 복사 to everyone;
// - 링크 복사 copies the project page's full address on this origin and says so;
// - 이름 바꾸기 is the chat rename's small prompt, and the card shows the new name;
// - 삭제 is the project page's own confirm: the line with the number of shared chats that go with it only when it has
//   any (by the server's count now, not the list's), then the delete, and the card goes; the history forgets the
//   project on its private chats; a project that is not found any more (deleted by someone else, or no longer mine to
//   see) just leaves the list, and my chats keep it, as the server does.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import type { Chat, Project } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import { ProjectList } from '../../src/pages/Projects'
import { DialogHost } from '../../src/components/ui'
import { useChats } from '../../src/store/chats'
import { useProjects } from '../../src/store/projects'
import { useUi } from '../../src/store/ui'
import { installDom, mount, removeDom, type FakeElement, type Mounted } from './dom-host'

const ko = (k: Parameters<typeof translate>[1], p?: Parameters<typeof translate>[2]) => translate('ko', k, p)
const MINE = '01900000-0000-7000-8000-000000000011', SHARED = '01900000-0000-7000-8000-000000000012', READ_ONLY = '01900000-0000-7000-8000-000000000013'
const ORIGIN = 'https://team.acme.example'
const project = (id: string, name: string, o: Partial<Project> = {}): Project =>
  ({ id, name, folderPath: `shared/${name.toLowerCase().replace(/ /g, '-')}`, instructions: '', createdBy: null, createdAt: '2026-11-03T00:00:00.000Z', canEdit: true, ...o })
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

let list: Project[] = []
/** the server's own view of a project now, where it differs from the list (null: gone) */
let now: Record<string, Project | null> = {}
const calls: { key: string; body: unknown }[] = []
const copied: string[] = []
const realFetch = globalThis.fetch
const realNavigator = globalThis.navigator
const localeBefore = useLocaleStore.getState().locale
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'ko' })
  const g = globalThis as Record<string, unknown>
  g.location = { origin: ORIGIN }
  Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: { ...realNavigator, clipboard: { writeText: async (s: string) => void copied.push(s) } } })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input).split('?')[0]}`
    calls.push({ key, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (key === 'GET /api/projects') return json(200, { items: list })
    const id = key.split('/').at(-1)!
    const p = id in now ? now[id] : list.find((x) => x.id === id)
    if (!p && key.startsWith('GET /api/projects/')) return json(404, { error: { code: 'not_found', message: 'not found' } })
    if (key.startsWith('GET /api/projects/')) return json(200, p)
    if (key.startsWith('PATCH /api/projects/') && p) return json(200, { ...p, ...(JSON.parse(String(init!.body)) as object) })
    if (key.startsWith('DELETE /api/projects/') && p) return new Response(null, { status: 204 })
    return json(500, { error: { code: 'internal', message: `no route ${key}` } })
  }) as unknown as typeof fetch
})
afterAll(() => {
  globalThis.fetch = realFetch
  Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: realNavigator })
  delete (globalThis as Record<string, unknown>).location
  removeDom()
  useLocaleStore.setState({ locale: localeBefore })
})
beforeEach(() => {
  list = [project(MINE, 'Acme launch'), project(SHARED, 'Acme sales', { sharedChats: 2 }), project(READ_ONLY, 'Acme finance', { canEdit: false })]
  now = {}
  calls.length = 0
  copied.length = 0
})

const page = () => mount(<MemoryRouter><ProjectList /><DialogHost /></MemoryRouter>)
const cards = (m: Mounted) => [...m.container.querySelectorAll('[data-testid="project-card"]')] as unknown as FakeElement[]
const card = (m: Mounted, name: string) => {
  const c = cards(m).find((x) => x.textContent?.includes(name))
  if (!c) throw new Error(`no card ${name} in ${m.html()}`)
  return c
}
const within = (el: FakeElement, testId: string) => el.querySelector(`[data-testid="${testId}"]`) as FakeElement | null
/** the card's "…" opened: its items as [test id, words] */
async function open(m: Mounted, name: string) {
  await m.click(within(card(m, name), 'project-card-menu')!)
  return ([...card(m, name).querySelectorAll('[role="menuitem"]')] as unknown as FakeElement[]).map((e) => [e.getAttribute('data-testid'), e.textContent?.trim()])
}
const loaded = (m: Mounted) => m.until(() => cards(m).length === 3, 'the cards')

describe('the Projects list', () => {
  test('each card has a "…" that names its project; an editor gets rename, copy link and delete, anyone else copy link only', async () => {
    const m = await page()
    try {
      await loaded(m)
      const more = within(card(m, 'Acme launch'), 'project-card-menu')!
      expect(more.getAttribute('aria-label')).toBe(ko('rooms.menu.rowLabel', { name: 'Acme launch' }))
      expect(more.getAttribute('aria-haspopup')).toBe('menu')
      // the "…" is beside the card's link, not inside it: the link keeps the whole card
      expect(more.closest('a')).toBeNull()
      expect(card(m, 'Acme launch').querySelector('a')?.getAttribute('href')).toBe(`/projects/${MINE}`)
      expect(await open(m, 'Acme launch')).toEqual([
        ['project-card-rename', ko('chat.rename')],
        ['project-card-copy-link', ko('rooms.menu.copyLink')],
        ['project-card-delete', ko('common.delete')],
      ])
      await m.click(within(card(m, 'Acme launch'), 'project-card-menu')!)
      expect(await open(m, 'Acme finance')).toEqual([['project-card-copy-link', ko('rooms.menu.copyLink')]])
    } finally {
      await m.unmount()
    }
  })

  test('copy link: the project page\'s full address on this origin, and a toast that says it was copied', async () => {
    const m = await page()
    try {
      await loaded(m)
      // also for someone who may not edit it
      await open(m, 'Acme finance')
      await m.click(within(card(m, 'Acme finance'), 'project-card-copy-link')!)
      await m.until(() => copied.length, 'the copy')
      expect(copied).toEqual([`${ORIGIN}/projects/${READ_ONLY}`])
      expect(useUi.getState().toasts.at(-1)?.text).toBe(ko('rooms.menu.linkCopied'))
      // the menu is closed
      expect(card(m, 'Acme finance').querySelector('[role="menu"]')).toBeNull()
      // useCopy's "copied" state ends after 1.5 s: let it end while the page is here, not in a later test file
      await m.settle(1600)
    } finally {
      await m.unmount()
    }
  })

  test('rename: the small prompt with the name in it; the card and the rest of the window show the new one', async () => {
    const m = await page()
    try {
      await loaded(m)
      await open(m, 'Acme launch')
      await m.click(within(card(m, 'Acme launch'), 'project-card-rename')!)
      const dialog = await m.until(() => m.container.ownerDocument!.body.querySelector('[role="dialog"]'), 'the prompt')
      expect(dialog.textContent).toContain(ko('chat.rename'))
      expect(dialog.textContent).toContain(ko('projects.name'))
      const field = dialog.querySelector('input') as unknown as FakeElement
      expect((field as unknown as { value: string }).value).toBe('Acme launch')
      await m.type(field, '  Acme launch 2027 ')
      await m.click('dialog-confirm')
      await m.until(() => cards(m).some((c) => c.textContent?.includes('Acme launch 2027')), 'the new name on the card')
      expect(calls.filter((c) => c.key.startsWith('PATCH'))).toEqual([{ key: `PATCH /api/projects/${MINE}`, body: { name: 'Acme launch 2027' } }])
      expect(useProjects.getState().byId[MINE]?.name).toBe('Acme launch 2027')
    } finally {
      await m.unmount()
    }
  })

  test('delete without shared chats: the project page\'s confirm, then the card goes', async () => {
    const chatsBefore = useChats.getState().chats
    const c = (title: string, projectId: string, shared?: boolean): Chat => ({ id: `c-${title}`, projectId, title, engine: 'claude-code', model: null, createdAt: '2026-11-03T00:00:00.000Z', updatedAt: '2026-11-03T00:00:00.000Z', deletedAt: null, runState: 'idle', ...(shared ? { shared: { by: { id: 'u-bob', name: 'Bob' }, audience: 3, answering: null, mine: true, canDelete: true } } : {}) })
    useChats.setState({ chats: [c('mine', MINE), c('shared', MINE, true), c('elsewhere', SHARED)] })
    const m = await page()
    try {
      await loaded(m)
      await open(m, 'Acme launch')
      await m.click(within(card(m, 'Acme launch'), 'project-card-delete')!)
      const dialog = await m.until(() => m.container.ownerDocument!.body.querySelector('[role="dialog"]'), 'the confirm')
      expect(dialog.textContent).toContain(ko('projects.deleteTitle', { name: 'Acme launch' }))
      expect(dialog.textContent).toContain(ko('projects.deleteBody'))
      expect(m.find('project-delete-shared')).toBeNull()
      await m.click('dialog-confirm')
      await m.until(() => cards(m).length === 2, 'the card to go')
      expect(calls.map((c) => c.key)).toContain(`DELETE /api/projects/${MINE}`)
      expect(cards(m).some((c) => c.textContent?.includes('Acme launch'))).toBe(false)
      // the history forgets the project on my chats there (the server took it off them); a shared chat goes by its own event
      expect(useChats.getState().chats.map((c) => [c.title, c.projectId])).toEqual([['mine', null], ['shared', MINE], ['elsewhere', SHARED]])
    } finally {
      await m.unmount()
      useChats.setState({ chats: chatsBefore })
    }
  })

  test('delete with shared chats: the line that says they go too; cancel keeps the project', async () => {
    const m = await page()
    try {
      await loaded(m)
      await open(m, 'Acme sales')
      await m.click(within(card(m, 'Acme sales'), 'project-card-delete')!)
      const line = await m.until(() => m.find('project-delete-shared'), 'the shared chats line')
      expect(line.textContent).toBe(ko('projects.deleteShared', { n: 2 }))
      const dialog = m.container.ownerDocument!.body.querySelector('[role="dialog"]')!
      expect(dialog.textContent).toContain(ko('projects.deleteBodyShared'))
      const cancel = ([...dialog.querySelectorAll('button')] as unknown as FakeElement[]).find((b) => b.textContent?.trim() === ko('common.cancel'))!
      await m.click(cancel)
      await m.settle()
      expect(calls.some((c) => c.key.startsWith('DELETE'))).toBe(false)
      expect(cards(m).length).toBe(3)
    } finally {
      await m.unmount()
    }
  })

  test('the shared chats line goes by the count the server gives now: one started since the list loaded is said', async () => {
    now = { [MINE]: project(MINE, 'Acme launch', { sharedChats: 1 }) }
    const m = await page()
    try {
      await loaded(m)
      await open(m, 'Acme launch')
      await m.click(within(card(m, 'Acme launch'), 'project-card-delete')!)
      const line = await m.until(() => m.find('project-delete-shared'), 'the shared chats line')
      expect(line.textContent).toBe(ko('projects.deleteShared', { n: 1 }))
      expect(calls.map((c) => c.key)).toContain(`GET /api/projects/${MINE}`)
      // closed, so the next page does not start with it
      const dialog = m.container.ownerDocument!.body.querySelector('[role="dialog"]')!
      await m.click(([...dialog.querySelectorAll('button')] as unknown as FakeElement[]).find((b) => b.textContent?.trim() === ko('common.cancel'))!)
    } finally {
      await m.unmount()
    }
  })

  test('a project not found any more: no confirm, the card goes with a line that says so; my chats keep it', async () => {
    now = { [MINE]: null }
    const chatsBefore = useChats.getState().chats
    useChats.setState({ chats: [{ id: 'c-mine', projectId: MINE, title: 'mine', engine: 'claude-code', model: null, createdAt: '2026-11-03T00:00:00.000Z', updatedAt: '2026-11-03T00:00:00.000Z', deletedAt: null, runState: 'idle' }] })
    const m = await page()
    try {
      await loaded(m)
      await open(m, 'Acme launch')
      await m.click(within(card(m, 'Acme launch'), 'project-card-delete')!)
      await m.until(() => cards(m).length === 2, 'the card to go')
      expect(m.container.ownerDocument!.body.querySelector('[role="dialog"]')).toBeNull()
      expect(calls.some((c) => c.key.startsWith('DELETE'))).toBe(false)
      expect(useUi.getState().toasts.at(-1)?.text).toBe(ko('projects.missing'))
      // it may still be there for others (no read access any more): the server keeps it on my chats, so does the history
      expect(useChats.getState().chats[0]?.projectId).toBe(MINE)
      expect(useProjects.getState().byId[MINE]).toBeUndefined()
    } finally {
      await m.unmount()
      useChats.setState({ chats: chatsBefore })
    }
  })
})
