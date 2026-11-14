// Leaving a team project (docs/DECISIONS.md "Leaving a project"; QA TC-1020; components/LeaveProject.tsx), rendered and
// clicked:
// - the card's "…" offers "Leave project" to a member (Project.leave 'yes'); the last person sees it off, with what to
//   do instead beside it; a personal project, or one I am not in, has none;
// - one confirm in plain words, then POST …/leave: the card goes, my private chats there become my own chats, a toast;
//   cancelling sends nothing;
// - the members dialog shows a group's people who left on the group's row: "Marketing · except Kim"; the others who left
//   on one line, "Left: Bob", with Add back (they are named again, and the save sends them).
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import type { Chat, Project, ProjectAccess } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import { ProjectList } from '../../src/pages/Projects'
import { ProjectMembersDialog } from '../../src/components/ProjectMembersDialog'
import { DialogHost } from '../../src/components/ui'
import { useChats } from '../../src/store/chats'
import { usePeople } from '../../src/store/people'
import { useProjects } from '../../src/store/projects'
import { useSession } from '../../src/store/session'
import { useUi } from '../../src/store/ui'
import { installDom, mount, removeDom, type FakeElement, type Mounted } from './dom-host'

const en = (k: Parameters<typeof translate>[1], p?: Parameters<typeof translate>[2]) => translate('en', k, p)
const TEAM = '01900000-0000-7000-8000-0000000000c1', LAST = '01900000-0000-7000-8000-0000000000c2', MINE = '01900000-0000-7000-8000-0000000000c3'
const CHAT = '01900000-0000-7000-8000-0000000000c4', SHARED_CHAT = '01900000-0000-7000-8000-0000000000c5'
const project = (id: string, name: string, o: Partial<Project> = {}): Project =>
  ({ id, name, folderPath: `projects/${name.toLowerCase().replace(/ /g, '-')}`, instructions: '', createdBy: null, createdAt: '2026-11-13T00:00:00.000Z', canEdit: false, audience: 3, ...o })
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

let list: Project[] = []
let routes: Record<string, () => Response> = {}
const calls: string[] = []
const realFetch = globalThis.fetch
const localeBefore = useLocaleStore.getState().locale
const sessionBefore = useSession.getState().status
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'en' })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input).split('?')[0]}`
    calls.push(key)
    if (routes[key]) return routes[key]!()
    if (key === 'GET /api/projects') return json(200, { items: list })
    if (key.startsWith('POST /api/projects/') && key.endsWith('/leave')) return json(200, { movedChats: 1 })
    const p = list.find((x) => x.id === key.split('/').at(-1))
    if (key.startsWith('GET /api/projects/') && p) return json(200, p)
    return json(500, { error: { code: 'internal', message: `no route ${key}` } })
  }) as unknown as typeof fetch
})
afterAll(() => {
  globalThis.fetch = realFetch
  removeDom()
  useLocaleStore.setState({ locale: localeBefore })
  useSession.setState({ status: sessionBefore })
})
beforeEach(() => {
  list = [project(TEAM, 'Acme team', { leave: 'yes' }), project(LAST, 'Acme alone', { leave: 'last', audience: 1 }), project(MINE, 'Notes', { folderPath: 'users/mia/projects/notes', canEdit: true })]
  routes = {}
  calls.length = 0
  useProjects.getState().reset()
  usePeople.getState().reset()
})

const cards = (m: Mounted) => [...m.container.querySelectorAll('[data-testid="project-card"]')] as unknown as FakeElement[]
const card = (m: Mounted, name: string) => {
  const c = cards(m).find((x) => x.textContent?.includes(name))
  if (!c) throw new Error(`no card ${name} in ${m.html()}`)
  return c
}
const within = (el: FakeElement, testId: string) => el.querySelector(`[data-testid="${testId}"]`) as FakeElement | null
async function open(m: Mounted, name: string) {
  await m.click(within(card(m, name), 'project-card-menu')!)
  return ([...card(m, name).querySelectorAll('[role="menuitem"]')] as unknown as FakeElement[]).map((e) => e.getAttribute('data-testid'))
}
const page = () => mount(<MemoryRouter><ProjectList /><DialogHost /></MemoryRouter>)

describe('Leave project on a card', () => {
  test('for a member; off with the reason for the last person; none on a personal project', async () => {
    const m = await page()
    try {
      await m.until(() => cards(m).length === 3, 'the cards')
      expect(await open(m, 'Acme team')).toContain('project-card-leave')
      const item = within(card(m, 'Acme team'), 'project-card-leave')!
      expect(item.textContent?.trim()).toBe(en('projects.leave'))
      expect(en('projects.leave')).toBe('Leave project') // no trailing "…" (house rule)
      expect(item.hasAttribute('disabled')).toBe(false)
      await m.click(within(card(m, 'Acme team'), 'project-card-menu')!)
      expect(await open(m, 'Acme alone')).toContain('project-card-leave')
      const off = within(card(m, 'Acme alone'), 'project-card-leave')!
      expect(off.hasAttribute('disabled')).toBe(true)
      expect(off.textContent).toContain(en('projects.leaveLast'))
      await m.click(within(card(m, 'Acme alone'), 'project-card-menu')!)
      expect(await open(m, 'Notes')).not.toContain('project-card-leave')
    } finally {
      await m.unmount()
    }
  })

  test('one confirm in plain words; then the card goes, my private chats there become mine, a toast', async () => {
    useChats.setState({ chats: [{ id: CHAT, projectId: TEAM, title: 'mine' } as Chat, { id: SHARED_CHAT, projectId: TEAM, title: 'ours', shared: { by: { id: 'kim', name: 'Kim' } } } as unknown as Chat] })
    const m = await page()
    try {
      await m.until(() => cards(m).length === 3, 'the cards')
      await open(m, 'Acme team')
      await m.click(within(card(m, 'Acme team'), 'project-card-leave')!)
      const dialog = await m.until(() => m.container.ownerDocument!.body.querySelector('[role="dialog"]'), 'the confirm')
      expect(dialog.textContent).toContain(en('projects.leaveTitle', { name: 'Acme team' }))
      expect(dialog.textContent).toContain("You won't see this project or its shared chats anymore. Your private chats in it move to your own chats.")
      // cancelled: nothing sent
      await m.click(([...dialog.querySelectorAll('button')] as unknown as FakeElement[]).find((b) => b.textContent === en('common.cancel'))!)
      await m.settle(50)
      expect(calls).not.toContain(`POST /api/projects/${TEAM}/leave`)
      await open(m, 'Acme team')
      await m.click(within(card(m, 'Acme team'), 'project-card-leave')!)
      await m.until(() => m.find('dialog-confirm'), 'the confirm again')
      await m.click('dialog-confirm')
      await m.until(() => cards(m).length === 2, 'the card gone')
      expect(calls).toContain(`POST /api/projects/${TEAM}/leave`)
      const chats = useChats.getState().chats
      expect(chats.find((c) => c.id === CHAT)?.projectId).toBeNull()
      expect(chats.find((c) => c.id === SHARED_CHAT)?.projectId).toBe(TEAM)
      expect(useUi.getState().toasts.at(-1)?.text).toBe(en('projects.left', { name: 'Acme team' }))
    } finally {
      await m.unmount()
      useChats.setState({ chats: [] })
    }
  })
})

describe('the members dialog', () => {
  test("a group's people who left: \"Marketing · except Kim\" on its row, and nowhere else", async () => {
    useSession.setState({ status: { kind: 'signed-in', me: { user: { id: 'mia', name: 'Mia', role: 'admin' }, groups: [], team: { name: 'Acme', defaultLocale: 'en', projectCreators: 'members' }, server: { version: '0', dev: false } } } } as never)
    const access: ProjectAccess = {
      editable: true, rulesHash: 'h1', people: 3, otherRules: [],
      participants: [{ subjectType: 'group', subjectId: 'marketing', name: 'Marketing', except: [{ id: 'kim', name: 'Kim' }, { id: 'lee', name: 'Lee' }] }, { subjectType: 'user', subjectId: 'sora', name: 'Sora' }],
      left: [{ id: 'bob', name: 'Bob' }],
    }
    routes = {
      'GET /api/people': () => json(200, { people: [{ id: 'mia', name: 'Mia' }, { id: 'sora', name: 'Sora' }, { id: 'kim', name: 'Kim' }, { id: 'bob', name: 'Bob' }] }),
      [`GET /api/projects/${TEAM}/access`]: () => json(200, access),
      [`GET /api/projects/${TEAM}/people`]: () => json(200, { people: [{ id: 'mia', name: 'Mia' }, { id: 'sora', name: 'Sora' }] }),
    }
    const m = await mount(<MemoryRouter><ProjectMembersDialog project={project(TEAM, 'Acme team', { membersEditable: true, canManage: true })} onClose={() => {}} onSaved={() => {}} /><DialogHost /></MemoryRouter>)
    try {
      await m.until(() => m.find('participant-group-marketing'), 'the group row', 2000)
      expect(m.get('participant-group-marketing').textContent).toContain(en('projects.except', { names: 'Kim, Lee' }))
      expect(en('projects.except', { names: 'Kim' })).toBe('except Kim')
      // not a separate rule
      expect(m.find('project-other-rules')).toBeNull()
      expect(m.get('participant-user-sora').textContent).not.toContain('except')
      // a leaver shows only on a group row (owner, QA TC-1074): no separate "Left: … / Add back" line
      expect(m.find('project-left')).toBeNull()
      expect(m.find('project-add-back-bob')).toBeNull()
      // one count, everyone in it (me included), and no second list of the same people for whoever changes them (TC-1065)
      expect(m.find('project-people')).toBeNull()
    } finally {
      await m.unmount()
    }
  })
})
