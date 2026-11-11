// The project dialog (docs/DECISIONS.md "Projects live only in projects/", "Project members in one panel"), rendered
// and clicked:
// - a member makes a team project (a new projects/<name>) with the people and groups chosen: me always in it, the
//   others found with the search (focus lists everyone who can be added; typing narrows it) and taken out with ×, and
//   the line says how many will see it (the server's count); a team that lets only admins offers members their own
//   project only;
// - editing a project saves its name, instructions and sharing with one PATCH: its members are not here any more (they
//   have their own dialog, project-members.test.tsx).
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import type { Project } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import { ProjectForm } from '../../src/components/ProjectForm'
import { DialogHost } from '../../src/components/ui'
import { usePeople } from '../../src/store/people'
import { useSession } from '../../src/store/session'
import { installDom, mount, removeDom } from './dom-host'

const P1 = '01900000-0000-7000-8000-0000000000a1'
const SALES = '01900000-0000-7000-8000-0000000000b1'
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const project = (folderPath: string, o: Partial<Project> = {}): Project =>
  ({ id: P1, name: 'Acme launch', folderPath, instructions: '', createdBy: { id: 'mia', name: 'Mia' }, createdAt: '2026-11-09T00:00:00.000Z', canEdit: true, audience: 3, shareChats: false, sharedChats: 0, ...o })
const PEOPLE = { people: [{ id: 'mia', name: 'Mia' }, { id: 'bob', name: 'Bob', title: 'Sales lead' }, { id: 'sora', name: 'Sora', title: 'Designer' }] }

let routes: Record<string, (init?: RequestInit) => Response | Promise<Response>> = {}
const sent: { key: string; body: unknown }[] = []
const realFetch = globalThis.fetch
const localeBefore = useLocaleStore.getState().locale
const sessionBefore = useSession.getState().status
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'en' })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input).split('?')[0]}`
    sent.push({ key, body: init?.body ? JSON.parse(String(init.body)) : null })
    return routes[key]?.(init) ?? json(500, { error: { code: 'internal', message: `no route ${key}` } })
  }) as unknown as typeof fetch
})
afterEach(() => { sent.length = 0; usePeople.getState().reset(); useSession.setState({ status: sessionBefore }) })
afterAll(() => {
  globalThis.fetch = realFetch
  removeDom()
  useLocaleStore.setState({ locale: localeBefore })
})

function signedIn(role: 'member' | 'admin', projectCreators: 'members' | 'admins' = 'members') {
  useSession.setState({ status: { kind: 'signed-in', me: { user: { id: 'mia', name: 'Mia', role }, groups: [{ id: SALES, name: 'Sales' }], team: { name: 'Acme', defaultLocale: 'en', projectCreators }, server: { version: '0', dev: false } } } } as never)
}
const calls = (key: string) => sent.filter((x) => x.key === key)
const en = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate('en', key, vars)
/** the count line: the project's members (docs/DECISIONS.md "Project contents only for members": a team project is its
 * members', the owner and admins included only as members, so no part for them by role) */
const members = (n: number) => en('projects.whoMembers', { n })

describe('a new project', () => {
  test('a member makes a team project with the people chosen and reads how many will see it', async () => {
    signedIn('member')
    // a new project: the server counts me and the people chosen (members only)
    let people = 1
    routes = {
      'GET /api/people': () => json(200, PEOPLE),
      'POST /api/projects/access-preview': () => json(200, { people, added: 0, removed: 0, files: 0, othersFiles: 0, sharedChats: 0, skills: 0 }),
      'POST /api/projects': () => json(201, project('projects/Launch')),
    }
    const m = await mount(<MemoryRouter><ProjectForm onClose={() => {}} onSaved={() => {}} /></MemoryRouter>)
    // the team kind first; no folder to choose: the server makes projects/<name>
    expect((m.get('project-kind-team') as unknown as { checked: boolean }).checked).toBe(true)
    expect(m.find('project-folder')).toBeNull()
    // me, always (no × to take me out), and the count
    await m.until(() => m.find('participant-user-mia'), 'me in the list', 2000)
    expect(m.get('participant-user-mia').getAttribute('data-state')).toBe('fixed')
    expect(m.get('participant-user-mia').textContent).toContain(en('projects.whoMe'))
    expect(m.find('participant-remove-user-mia')).toBeNull()
    // "1 member": nothing about the owner and admins, who see it only as members
    await m.until(() => m.get('project-access-summary').textContent === members(1), 'the line with the count', 2000)
    expect(m.find('project-access-summary-role')).toBeNull()
    // the search lists everyone who can be added (my group and the people, not me); typing narrows it, titles too
    await m.click('project-participants-search')
    await m.until(() => m.find('participant-add-user-bob'), 'the people to add', 2000)
    expect(m.find(`participant-add-group-${SALES}`)).not.toBeNull()
    expect(m.find('participant-add-user-mia')).toBeNull()
    await m.type('project-participants-search', 'design')
    await m.until(() => !m.find('participant-add-user-bob'), 'narrowed', 2000)
    expect(m.get('participant-add-user-sora').textContent).toContain('Designer')
    await m.type('project-participants-search', 'bo')
    await m.until(() => m.find('participant-add-user-bob'), 'Bob found', 2000)
    expect(m.find('participant-add-user-sora')).toBeNull()
    people = 5
    await m.click('participant-add-user-bob')
    // added: the list again, with Bob in it and his title under his name
    await m.until(() => m.find('participant-user-bob'), 'Bob in the list', 2000)
    expect(m.find('project-participants-results')).toBeNull()
    expect(m.get('participant-user-bob').textContent).toContain('Sales lead')
    await m.type('project-participants-search', 'sal')
    await m.click(`participant-add-group-${SALES}`)
    await m.until(() => m.find(`participant-group-${SALES}`), 'the group in the list', 2000)
    await m.until(() => m.get('project-access-summary').textContent === members(5), 'the new count', 2000)
    // × takes one out again (nothing saved yet: the row goes)
    await m.type('project-participants-search', 'so')
    await m.click('participant-add-user-sora')
    await m.click('participant-remove-user-sora')
    expect(m.find('participant-user-sora')).toBeNull()
    await m.type('project-name', 'Launch')
    await m.click('project-save')
    await m.until(() => calls('POST /api/projects').length, 'the save', 2000)
    expect(calls('POST /api/projects')[0]!.body).toEqual({ name: 'Launch', scope: 'team', instructions: '', participants: [{ subjectType: 'user', subjectId: 'bob' }, { subjectType: 'group', subjectId: SALES }] })
    await m.unmount()
  })

  test('an admin\'s new project: its members too, with no part for the owner and admins by role', async () => {
    signedIn('admin')
    let people = 1
    routes = {
      'GET /api/people': () => json(200, PEOPLE),
      'POST /api/projects/access-preview': () => json(200, { people, added: 0, removed: 0, files: 0, othersFiles: 0, sharedChats: 0, skills: 0, split: { direct: people, byRole: 0 } }),
    }
    const m = await mount(<MemoryRouter><ProjectForm onClose={() => {}} onSaved={() => {}} /></MemoryRouter>)
    await m.until(() => m.find('project-access-summary')?.textContent === members(1), 'the line with the count', 2000)
    people = 2
    await m.click('project-participants-search')
    await m.click('participant-add-user-bob')
    await m.until(() => m.get('project-access-summary').textContent === members(2), 'the new count', 2000)
    expect(m.find('project-access-summary-role')).toBeNull()
    expect(m.html()).not.toContain(en('folderAccess.byRole', { n: 2 }))
    await m.unmount()
  })

  test('a team that lets only admins: a member makes a personal project, and is told why', async () => {
    signedIn('member', 'admins')
    routes = { 'POST /api/projects': () => json(201, project('users/mia/projects/Notes')) }
    const m = await mount(<MemoryRouter><ProjectForm onClose={() => {}} onSaved={() => {}} /></MemoryRouter>)
    expect(m.find('project-kind-team')).toBeNull()
    expect(m.find('project-participants')).toBeNull()
    expect(m.html()).toContain(en('projects.teamAdminsOnly'))
    await m.type('project-name', 'Notes')
    await m.click('project-save')
    await m.until(() => calls('POST /api/projects').length, 'the save', 2000)
    expect(calls('POST /api/projects')[0]!.body).toMatchObject({ scope: 'personal', participants: [] })
    expect(calls('POST /api/projects/access-preview')).toEqual([])
    await m.unmount()
  })
})

describe('editing a project', () => {
  test('one PATCH saves the name, the instructions and sharing; the members are not in this dialog', async () => {
    signedIn('member')
    routes = { [`PATCH /api/projects/${P1}`]: () => json(200, project('projects/acme', { name: 'Acme 2027' })) }
    let saved: Project | null = null
    const m = await mount(<MemoryRouter><ProjectForm project={project('projects/acme')} onClose={() => {}} onSaved={(p) => { saved = p }} /><DialogHost /></MemoryRouter>)
    await m.settle(50)
    expect(m.find('project-participants')).toBeNull()
    expect(m.find('project-access-summary')).toBeNull()
    expect(m.find('project-share-chats')).not.toBeNull()
    await m.type('project-name', 'Acme 2027')
    await m.click('project-save')
    await m.until(() => saved, 'the save', 2000)
    // nothing about who sees it: no access read, no dry run, no participants save
    expect(sent.map((x) => x.key).filter((k) => k !== 'GET /api/people')).toEqual([`PATCH /api/projects/${P1}`])
    expect(calls(`PATCH /api/projects/${P1}`)[0]!.body).toEqual({ name: 'Acme 2027', instructions: '' })
    await m.unmount()
  })

  test('the sharing switch: a project in projects/ says its members, for everyone; one made before outside projects/ keeps the owner and admins apart', async () => {
    signedIn('admin')
    const m = await mount(<MemoryRouter><ProjectForm project={project('projects/acme', { audience: 3, audienceSplit: { direct: 3, byRole: 0 } })} onClose={() => {}} onSaved={() => {}} /></MemoryRouter>)
    await m.settle(20)
    expect(m.get('project-share-chats-hint').textContent).toBe(en('projects.shareChatsOff', { n: 3 }))
    expect(m.get('project-share-chats-hint').textContent).not.toContain('admins')
    await m.unmount()
    const legacy = await mount(<MemoryRouter><ProjectForm project={project('shared/acme', { audience: 5, audienceSplit: { direct: 3, byRole: 2 } })} onClose={() => {}} onSaved={() => {}} /></MemoryRouter>)
    await legacy.settle(20)
    expect(legacy.get('project-share-chats-hint').textContent).toBe(en('projects.shareChatsOffApart', { n: 3, m: 2 }))
    await legacy.unmount()
    signedIn('member')
    const b = await mount(<MemoryRouter><ProjectForm project={project('projects/acme', { audience: 5 })} onClose={() => {}} onSaved={() => {}} /></MemoryRouter>)
    await b.settle(20)
    expect(b.get('project-share-chats-hint').textContent).toBe(en('projects.shareChatsOff', { n: 5 }))
    await b.unmount()
  })
})
