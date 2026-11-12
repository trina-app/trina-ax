// The "…" on each card of the Projects list (pages/Projects.tsx), rendered and clicked:
// - what it offers: 이름 바꾸기 and 삭제 only to people who may edit the project (Project.canEdit), 멤버 only to people who
//   may change its members (Project.membersEditable), 링크 복사 to everyone;
// - 멤버 opens the members dialog over the list (components/ProjectMembersDialog.tsx), and a save goes to the project;
// - 링크 복사 copies the project page's full address on this origin and says so;
// - 이름 바꾸기 is the chat rename's small prompt, and the card shows the new name;
// - 삭제 is the project page's own confirm: the sentence that says its shared chats go to their creators' trash (by the
//   trash's own name, no red line) only when it has any (by the server's count now, not the list's), then the delete,
//   and the card goes; the history forgets the
//   project on its private chats; a project that is not found any more (deleted by someone else, or no longer mine to
//   see) just leaves the list, and my chats keep it, as the server does.
// - members only (docs/DECISIONS.md "Project contents only for members"): the list asks with manage=1; the owner's or
//   an admin's card of a project they are not in has 이름 바꾸기, 멤버 and 삭제 (Project.canManage), no "not a member" tag;
//   its instructions do not come, so the card says "멤버만 내용을 볼 수 있어요." with a lock (nothing while it is in the
//   trash), not "지침이 없어요."; a team project nobody active is in says "남은 멤버 없음"; deleting a team project in
//   projects/ moves it to the trash (its own confirm, the card stays and says so), and deleting one in the trash is
//   for good.
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
const calls: { key: string; url: string; body: unknown }[] = []
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
    calls.push({ key, url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (key === 'GET /api/projects') return json(200, { items: list })
    // the members dialog (project-members.test.tsx has the rest)
    if (key === 'GET /api/people') return json(200, { people: [{ id: 'mia', name: 'Mia' }, { id: 'sora', name: 'Sora' }] })
    if (key.endsWith('/access')) return json(200, { editable: true, rulesHash: 'h1', people: 3, otherRules: [], participants: [{ subjectType: 'user', subjectId: 'mia', name: 'Mia', creator: true }, { subjectType: 'user', subjectId: 'sora', name: 'Sora' }] })
    if (key === 'POST /api/projects/access-preview') return json(200, { people: 2, added: 0, removed: 1, files: 0, othersFiles: 0, sharedChats: 0, skills: 0 })
    if (key.endsWith('/participants')) {
      // the project as the server says it after the save (the dialog reads it again)
      const pid = key.split('/').at(-2)!
      list = list.map((x) => (x.id === pid ? { ...x, audience: 2 } : x))
      return json(200, { editable: true, rulesHash: 'h2', people: 2, otherRules: [], participants: [{ subjectType: 'user', subjectId: 'mia', name: 'Mia', creator: true }] })
    }
    const id = key.split('/').at(-1)!
    const p = id in now ? now[id] : list.find((x) => x.id === id)
    if (!p && key.startsWith('GET /api/projects/')) return json(404, { error: { code: 'not_found', message: 'not found' } })
    if (key.startsWith('GET /api/projects/')) return json(200, p)
    if (key.startsWith('PATCH /api/projects/') && p) return json(200, { ...p, ...(JSON.parse(String(init!.body)) as object) })
    // a team project in projects/ goes to the trash first (it stays, inTrash); a second DELETE (or any other): for good
    if (key.startsWith('DELETE /api/projects/') && p) {
      now[id] = /^projects\/[^/]+$/.test(p.folderPath) && !p.inTrash ? { ...p, inTrash: true, audience: 0, membersEditable: false } : null
      return new Response(null, { status: 204 })
    }
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

  test('멤버 for whoever may change the members: the members dialog opens over the list and saves there', async () => {
    list = list.map((p) => (p.id === SHARED ? { ...p, folderPath: 'projects/acme-sales', membersEditable: true, audience: 3 } : p))
    const m = await page()
    try {
      await loaded(m)
      expect(await open(m, 'Acme sales')).toEqual([
        ['project-card-rename', ko('chat.rename')],
        ['project-card-members', ko('projects.participants')],
        ['project-card-copy-link', ko('rooms.menu.copyLink')],
        ['project-card-delete', ko('common.delete')],
      ])
      await m.click(within(card(m, 'Acme sales'), 'project-card-members')!)
      await m.until(() => m.find('participant-user-sora'), 'the members dialog')
      expect(m.html()).toContain(ko('projects.membersTitle', { name: 'Acme sales' }))
      await m.click('participant-remove-user-sora')
      await m.click('project-members-save')
      await m.until(() => !m.find('project-members-dialog'), 'the dialog closed')
      expect(calls.find((c) => c.key === `PUT /api/projects/${SHARED}/participants`)?.body).toEqual({ participants: [], expectedHash: 'h1' })
      expect(useProjects.getState().byId[SHARED]?.audience).toBe(2)
      // still on the list
      expect(cards(m).length).toBe(3)
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
      expect(calls.filter((c) => c.key.startsWith('PATCH')).map(({ key, body }) => ({ key, body }))).toEqual([{ key: `PATCH /api/projects/${MINE}`, body: { name: 'Acme launch 2027' } }])
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

  test('delete with shared chats: the sentence that says they go to their creators\' trash, by its name; cancel keeps the project', async () => {
    const m = await page()
    try {
      await loaded(m)
      await open(m, 'Acme sales')
      await m.click(within(card(m, 'Acme sales'), 'project-card-delete')!)
      const dialog = await m.until(() => m.container.ownerDocument!.body.querySelector('[role="dialog"]'), 'the confirm')
      // the trash by the sidebar's name for it (no copy of it in the sentence), the team's days (the default here)
      expect(dialog.textContent).toContain(ko('projects.deleteBodyShared', { days: 7, trash: ko('sidebar.trash') }))
      expect(dialog.textContent).toContain(`"${ko('sidebar.trash')}"`)
      // no red line that says they are deleted for good
      expect(m.find('project-delete-shared')).toBeNull()
      expect(dialog.querySelectorAll('span').some((e) => (e.getAttribute('class') ?? '').includes('text-danger'))).toBe(false)
      const cancel = ([...dialog.querySelectorAll('button')] as unknown as FakeElement[]).find((b) => b.textContent?.trim() === ko('common.cancel'))!
      await m.click(cancel)
      await m.settle()
      expect(calls.some((c) => c.key.startsWith('DELETE'))).toBe(false)
      expect(cards(m).length).toBe(3)
    } finally {
      await m.unmount()
    }
  })

  test('the shared chats sentence goes by the count the server gives now: one started since the list loaded is said', async () => {
    now = { [MINE]: project(MINE, 'Acme launch', { sharedChats: 1 }) }
    const m = await page()
    try {
      await loaded(m)
      await open(m, 'Acme launch')
      await m.click(within(card(m, 'Acme launch'), 'project-card-delete')!)
      const dialog = await m.until(() => m.container.ownerDocument!.body.querySelector('[role="dialog"]'), 'the confirm')
      expect(dialog.textContent).toContain(ko('projects.deleteBodyShared', { days: 7, trash: ko('sidebar.trash') }))
      expect(calls.map((c) => c.key)).toContain(`GET /api/projects/${MINE}`)
      // closed, so the next page does not start with it
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

describe('members only (docs/DECISIONS.md "Project contents only for members")', () => {
  const OUTSIDE = '01900000-0000-7000-8000-000000000014', ORPHAN = '01900000-0000-7000-8000-000000000015', TRASHED = '01900000-0000-7000-8000-000000000016'
  const outside = (o: Partial<Project> = {}) => project(OUTSIDE, 'Acme legal', { folderPath: 'projects/acme-legal', member: false, canEdit: false, canManage: true, membersEditable: true, audience: 2, ...o })
  const loaded4 = (m: Mounted) => m.until(() => cards(m).length === 4, 'the cards')

  test('the list asks with manage=1; a card of a project I am not in: rename, members, copy link, delete, and no tag', async () => {
    list = [...list, outside()]
    const m = await page()
    try {
      await loaded4(m)
      expect(calls.find((c) => c.key === 'GET /api/projects')!.url).toContain('manage=1')
      expect(await open(m, 'Acme legal')).toEqual([
        ['project-card-rename', ko('chat.rename')],
        ['project-card-members', ko('projects.participants')],
        ['project-card-copy-link', ko('rooms.menu.copyLink')],
        ['project-card-delete', ko('common.delete')],
      ])
      expect(within(card(m, 'Acme legal'), 'project-card-state')).toBeNull()
      // the rename is the small prompt and sends the name only
      await m.click(within(card(m, 'Acme legal'), 'project-card-rename')!)
      const dialog = await m.until(() => m.container.ownerDocument!.body.querySelector('[role="dialog"]'), 'the prompt')
      await m.type(dialog.querySelector('input') as unknown as FakeElement, 'Acme legal 2027')
      await m.click('dialog-confirm')
      await m.until(() => cards(m).some((c) => c.textContent?.includes('Acme legal 2027')), 'the new name')
      expect(calls.filter((c) => c.key.startsWith('PATCH'))).toEqual([{ key: `PATCH /api/projects/${OUTSIDE}`, url: `/api/projects/${OUTSIDE}`, body: { name: 'Acme legal 2027' } }])
    } finally {
      await m.unmount()
    }
  })

  test('a card of a project I am not in: a lock and "멤버만 내용을 볼 수 있어요." in place of its instructions, never "지침이 없어요."', async () => {
    list = [...list, outside(), project(TRASHED, 'Acme gone', { folderPath: 'projects/acme-gone', member: false, canEdit: false, canManage: true, inTrash: true, audience: 0 })]
    const m = await page()
    try {
      await m.until(() => cards(m).length === 5, 'the cards')
      const about = (name: string) => within(card(m, name), 'project-card-about')!
      // its instructions do not come to me, so the card says why there are none, in plain words, with the lock
      expect(about('Acme legal').textContent).toBe(ko('projects.cardMembersOnly'))
      expect(ko('projects.cardMembersOnly')).toBe('멤버만 내용을 볼 수 있어요.')
      expect(translate('en', 'projects.cardMembersOnly')).toBe("Only members can see what's inside.")
      expect(about('Acme legal').querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
      // in the same two lines' room, faint
      expect(about('Acme legal').getAttribute('class')).toContain('min-h-[2lh]')
      expect(about('Acme legal').getAttribute('class')).toContain('text-faint')
      // in the trash nobody sees its contents: nothing said there (its line above says it is in the trash)
      expect(about('Acme gone').textContent).toBe('')
      expect(about('Acme gone').getAttribute('class')).toContain('min-h-[2lh]')
      // a project of mine without instructions still says so, without the lock
      expect(about('Acme launch').textContent).toBe(ko('projects.noInstructions'))
      expect(about('Acme launch').querySelector('svg')).toBeNull()
    } finally {
      await m.unmount()
    }
  })

  test('a team project nobody active is in: "남은 멤버 없음" in place of a count; one in the trash says so', async () => {
    list = [...list, outside({ id: ORPHAN, name: 'Acme old', folderPath: 'projects/acme-old', audience: 0 }), project(TRASHED, 'Acme gone', { folderPath: 'projects/acme-gone', member: false, canEdit: false, canManage: true, inTrash: true, audience: 0 })]
    const m = await page()
    try {
      await m.until(() => cards(m).length === 5, 'the cards')
      // the card's who-sees line says it (dev's cards say who sees it in place of the folder path)
      expect(within(card(m, 'Acme old'), 'project-card-who')!.textContent).toBe(ko('projects.noMembers'))
      expect(within(card(m, 'Acme old'), 'project-card-state')).toBeNull()
      expect(ko('projects.noMembers')).toBe('남은 멤버 없음')
      expect(within(card(m, 'Acme gone'), 'project-card-who')!.textContent).toBe(`${ko('projects.noMembers')} · ${ko('chat.project.inTrash')}`)
      expect(within(card(m, 'Acme gone'), 'project-card-state')!.textContent).toBe(` · ${ko('chat.project.inTrash')}`)
      // a personal project with nobody else: nothing said
      expect(within(card(m, 'Acme launch'), 'project-card-state')).toBeNull()
    } finally {
      await m.unmount()
    }
  })

  test('delete a team project in projects/: "휴지통으로 옮길까요?", the card stays, in the trash; delete again: for good, the card goes', async () => {
    list = [...list, outside()]
    const m = await page()
    try {
      await loaded4(m)
      await open(m, 'Acme legal')
      await m.click(within(card(m, 'Acme legal'), 'project-card-delete')!)
      const dialog = await m.until(() => m.container.ownerDocument!.body.querySelector('[role="dialog"]'), 'the confirm')
      expect(dialog.textContent).toContain(ko('projects.trashTitle', { name: 'Acme legal' }))
      expect(ko('projects.trashTitle', { name: 'Acme legal' })).toBe("'Acme legal'을(를) 휴지통으로 옮길까요?")
      expect(dialog.textContent).toContain(ko('projects.trashBody'))
      // what happens, not "its files and chats go with it" (an admin's own chats there stay where they are)
      expect(ko('projects.trashBody')).toBe('팀장이나 관리자가 되돌릴 때까지 멤버도 파일과 공유 채팅을 열 수 없어요.')
      expect(translate('en', 'projects.trashBody')).toBe("Members can't open its files or shared chats until the owner or an admin restores it.")
      expect(m.get('dialog-confirm').textContent).toBe(ko('files.moveToTrash'))
      // no checkbox to choose the folder: it always goes with the project
      expect(m.find('project-delete-trash-folder')).toBeNull()
      await m.click('dialog-confirm')
      await m.until(() => within(card(m, 'Acme legal'), 'project-card-state'), 'the card in the trash')
      expect(within(card(m, 'Acme legal'), 'project-card-state')!.textContent).toBe(` · ${ko('chat.project.inTrash')}`)
      expect(cards(m).length).toBe(4)
      expect(calls.filter((c) => c.key === `DELETE /api/projects/${OUTSIDE}`).map((c) => c.url)).toEqual([`/api/projects/${OUTSIDE}`])
      // again: for good
      await open(m, 'Acme legal')
      await m.click(within(card(m, 'Acme legal'), 'project-card-delete')!)
      const again = await m.until(() => m.container.ownerDocument!.body.querySelector('[role="dialog"]'), 'the confirm')
      expect(again.textContent).toContain(ko('projects.deleteForGoodTitle', { name: 'Acme legal' }))
      expect(again.textContent).toContain(ko('projects.deleteForGoodBody'))
      expect(m.get('dialog-confirm').textContent).toBe(ko('projects.deleteForGood'))
      await m.click('dialog-confirm')
      await m.until(() => cards(m).length === 3, 'the card to go')
      expect(calls.filter((c) => c.key === `DELETE /api/projects/${OUTSIDE}`)).toHaveLength(2)
    } finally {
      await m.unmount()
    }
  })
})
