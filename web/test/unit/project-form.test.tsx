// The project dialog and who sees a project (docs/DECISIONS.md "Projects live only in projects/"), rendered and clicked:
// - a member makes a team project (a new projects/<name>) with the people and groups chosen, and always reads who will
//   see it ("볼 수 있는 사람", the server's count); a team that lets only admins offers members their own project only;
// - the creator changes the participants in the edit dialog: someone gaining it asks first, with what they will see (the
//   server's dry run); narrowing saves at once; a change by someone else meanwhile (409 rules_changed) is shown;
// - rules set in Admin › Folder permissions show read-only; a project on another folder says so to admins only.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import type { Project, ProjectAccess } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import { ProjectForm } from '../../src/components/ProjectForm'
import { DialogHost } from '../../src/components/ui'
import { usePeople } from '../../src/store/people'
import { useSession } from '../../src/store/session'
import { installDom, mount, removeDom, type FakeElement, type Mounted } from './dom-host'

const P1 = '01900000-0000-7000-8000-0000000000a1'
const SALES = '01900000-0000-7000-8000-0000000000b1'
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const project = (folderPath: string, o: Partial<Project> = {}): Project =>
  ({ id: P1, name: 'Acme launch', folderPath, instructions: '', createdBy: { id: 'mia', name: 'Mia' }, createdAt: '2026-11-09T00:00:00.000Z', canEdit: true, audience: 3, shareChats: false, sharedChats: 0, ...o })
const PEOPLE = { people: [{ id: 'mia', name: 'Mia' }, { id: 'bob', name: 'Bob' }, { id: 'sora', name: 'Sora' }] }

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
/** a browser checks a box before the click's listeners run, past React's value tracker (this small DOM does not) */
const tick = async (m: Mounted, id: string) => {
  const el = m.get(id) as FakeElement
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'checked')!.set!.call(el, !(el as unknown as { checked: boolean }).checked)
  await m.click(el)
}
const calls = (key: string) => sent.filter((x) => x.key === key)
const en = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate('en', key, vars)

describe('a new project', () => {
  test('a member makes a team project with the people chosen and reads who will see it', async () => {
    signedIn('member')
    let people = 3
    routes = {
      'GET /api/people': () => json(200, PEOPLE),
      'POST /api/projects/access-preview': () => json(200, { people, added: 0, removed: 0, files: 0, othersFiles: 0, sharedChats: 0, skills: 0 }),
      'POST /api/projects': () => json(201, project('projects/Launch')),
    }
    const m = await mount(<MemoryRouter><ProjectForm onClose={() => {}} onSaved={() => {}} /></MemoryRouter>)
    // the team kind first; no folder to choose: the server makes projects/<name>
    expect((m.get('project-kind-team') as unknown as { checked: boolean }).checked).toBe(true)
    expect(m.find('project-folder')).toBeNull()
    // my own group and the people; me always (not a box to untick)
    await m.until(() => m.find('participant-user-bob'), 'the people', 2000)
    expect(m.find(`participant-group-${SALES}`)).not.toBeNull()
    expect(m.get('participant-user-mia').hasAttribute('disabled')).toBe(true)
    await m.until(() => m.get('project-access-summary').textContent === `${en('projects.who')} ${en('projects.whoLine', { names: `${en('projects.whoMe')} · ${en('projects.whoAdmins')}`, n: 3 })}`, 'the line with the count', 2000)
    people = 7
    await tick(m, `participant-group-${SALES}`)
    await tick(m, 'participant-user-bob')
    const line = `${en('projects.whoMe')} · ${en('projects.whoGroup', { name: 'Sales' })} · Bob · ${en('projects.whoAdmins')}`
    await m.until(() => m.get('project-access-summary').textContent?.includes(en('projects.whoLine', { names: line, n: 7 })), 'the new count', 2000)
    await m.type('project-name', 'Launch')
    await m.click('project-save')
    await m.until(() => calls('POST /api/projects').length, 'the save', 2000)
    expect(calls('POST /api/projects')[0]!.body).toEqual({ name: 'Launch', scope: 'team', instructions: '', participants: [{ subjectType: 'group', subjectId: SALES }, { subjectType: 'user', subjectId: 'bob' }] })
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

describe('the creator changes who sees it', () => {
  const access = (o: Partial<ProjectAccess> = {}): ProjectAccess => ({
    editable: true, rulesHash: 'h1', people: 3,
    participants: [{ subjectType: 'user', subjectId: 'mia', name: 'Mia', creator: true }, { subjectType: 'user', subjectId: 'sora', name: 'Sora' }],
    otherRules: [], ...o,
  })

  test('someone gaining it: a confirm says what they will see; yes saves the participants with the hash, then the rest', async () => {
    signedIn('member')
    routes = {
      'GET /api/people': () => json(200, PEOPLE),
      [`GET /api/projects/${P1}/access`]: () => json(200, access({ otherRules: [{ path: 'projects/acme', subjectType: 'group', subjectId: 'g-fin', name: 'Finance', access: 'read' }, { path: 'projects/acme/hr', subjectType: 'everyone', subjectId: null, name: null, access: 'none' }] })),
      'POST /api/projects/access-preview': (init) => {
        const b = JSON.parse(String(init?.body)) as { participants: unknown[] }
        return json(200, b.participants.length > 1 ? { people: 5, added: 1, removed: 0, files: 12, othersFiles: 5, sharedChats: 3, skills: 2, skillNames: ['견적-현장', '견적서'] } : { people: 4, added: 0, removed: 0, files: 0, othersFiles: 0, sharedChats: 0, skills: 0 })
      },
      [`PUT /api/projects/${P1}/participants`]: () => json(200, access({ rulesHash: 'h2' })),
      [`PATCH /api/projects/${P1}`]: () => json(200, project('projects/acme')),
    }
    const m = await mount(<MemoryRouter><ProjectForm project={project('projects/acme')} onClose={() => {}} onSaved={() => {}} /><DialogHost /></MemoryRouter>)
    await m.until(() => m.find('participant-user-bob'), 'the picker', 2000)
    // the creator stays; Sora is ticked; the rules of Admin › Folder permissions show read-only
    expect(m.get('participant-user-mia').hasAttribute('disabled')).toBe(true)
    expect((m.get('participant-user-sora') as unknown as { checked: boolean }).checked).toBe(true)
    const other = m.get('project-other-rules').textContent ?? ''
    expect(other).toContain(`${en('projects.whoGroup', { name: 'Finance' })}: ${en('access.read')}`)
    expect(other).toContain(`${en('projects.ruleInside', { path: 'hr' })} · ${en('rules.everyone')}: ${en('access.none')}`)
    expect(other).not.toContain(en('projects.otherRulesLink')) // a member: no link to the admin screen
    await tick(m, 'participant-user-bob')
    await m.click('project-save')
    const box = await m.until(() => m.find('project-widen-confirm'), 'the confirm', 2000)
    expect(box.textContent).toContain(en('projects.widenBody', { n: 1 }))
    expect(box.textContent).toContain(en('projects.widenFilesOthers', { n: 12, m: 5 }))
    expect(box.textContent).toContain(en('projects.widenChats', { n: 3 }))
    expect(box.textContent).toContain(en('projects.widenSkills', { n: 2, m: 1, names: '견적-현장, 견적서' }))
    expect(box.textContent).toContain('견적-현장, 견적서')
    expect(calls(`PUT /api/projects/${P1}/participants`)).toEqual([])
    await m.click('dialog-confirm')
    await m.until(() => calls(`PATCH /api/projects/${P1}`).length, 'the save', 2000)
    expect(calls(`PUT /api/projects/${P1}/participants`)[0]!.body).toEqual({ participants: [{ subjectType: 'user', subjectId: 'sora' }, { subjectType: 'user', subjectId: 'bob' }], expectedHash: 'h1' })
    expect(sent.findIndex((x) => x.key === `PUT /api/projects/${P1}/participants`)).toBeLessThan(sent.findIndex((x) => x.key === `PATCH /api/projects/${P1}`))
    await m.unmount()
  })

  test('cancelling the confirm saves nothing; narrowing saves at once; someone else\'s change meanwhile is shown', async () => {
    signedIn('member')
    let conflict = false
    routes = {
      'GET /api/people': () => json(200, PEOPLE),
      [`GET /api/projects/${P1}/access`]: () => json(200, access(conflict ? { rulesHash: 'h9', participants: [{ subjectType: 'user', subjectId: 'mia', name: 'Mia', creator: true }, { subjectType: 'user', subjectId: 'bob', name: 'Bob' }] } : {})),
      'POST /api/projects/access-preview': (init) => {
        const b = JSON.parse(String(init?.body)) as { participants: unknown[] }
        return json(200, b.participants.length > 1 ? { people: 4, added: 1, removed: 0, files: 0, othersFiles: 0, sharedChats: 0, skills: 0 } : { people: 2, added: 0, removed: 1, files: 0, othersFiles: 0, sharedChats: 0, skills: 0 })
      },
      [`PUT /api/projects/${P1}/participants`]: () => (conflict ? json(409, { error: { code: 'conflict', message: 'Someone changed who sees this project in the meantime.', params: { reason: 'rules_changed' } } }) : json(200, access({ participants: [{ subjectType: 'user', subjectId: 'mia', name: 'Mia', creator: true }] }))),
      [`PATCH /api/projects/${P1}`]: () => json(200, project('projects/acme')),
    }
    const m = await mount(<MemoryRouter><ProjectForm project={project('projects/acme')} onClose={() => {}} onSaved={() => {}} /><DialogHost /></MemoryRouter>)
    await m.until(() => m.find('participant-user-bob'), 'the picker', 2000)
    await tick(m, 'participant-user-bob')
    await m.click('project-save')
    await m.until(() => m.find('project-widen-confirm'), 'the confirm', 2000)
    await m.click(m.get('dialog-confirm').parentElement!.querySelector('button')!)
    await m.settle(50)
    expect(calls(`PUT /api/projects/${P1}/participants`)).toEqual([])
    expect(calls(`PATCH /api/projects/${P1}`)).toEqual([])
    // narrowing (Sora out, Bob not added): no confirm
    await tick(m, 'participant-user-bob')
    await tick(m, 'participant-user-sora')
    await m.click('project-save')
    await m.until(() => calls(`PATCH /api/projects/${P1}`).length, 'the save', 2000)
    expect(m.find('project-widen-confirm')).toBeNull()
    expect(calls(`PUT /api/projects/${P1}/participants`)[0]!.body).toEqual({ participants: [], expectedHash: 'h1' })
    await m.unmount()
    // someone changed it meanwhile: 409, the message, and the picker shows what is there now
    sent.length = 0
    const n = await mount(<MemoryRouter><ProjectForm project={project('projects/acme')} onClose={() => {}} onSaved={() => {}} /><DialogHost /></MemoryRouter>)
    await n.until(() => n.find('participant-user-bob'), 'the picker', 2000)
    conflict = true
    await tick(n, 'participant-user-sora')
    await n.click('project-save')
    await n.until(() => n.html().includes('Someone changed who sees this project'), 'the message', 2000)
    await n.until(() => (n.get('participant-user-bob') as unknown as { checked: boolean }).checked, 'Bob, added by someone else', 2000)
    expect(calls(`PATCH /api/projects/${P1}`)).toEqual([])
    await n.unmount()
  })

  test('a project on another folder (made before): admins read where to change it, members read nothing of it', async () => {
    routes = {
      'GET /api/people': () => json(200, PEOPLE),
      [`GET /api/projects/${P1}/access`]: () => json(200, access({ editable: false })),
    }
    signedIn('admin')
    const a = await mount(<MemoryRouter><ProjectForm project={project('shared/acme')} onClose={() => {}} onSaved={() => {}} /></MemoryRouter>)
    // the folder as the screen names it (shared/ is Company-wide)
    expect(a.get('project-form-legacy').textContent).toBe(en('projects.legacyNote', { folder: 'Company-wide/acme' }))
    await a.until(() => a.find('project-access-summary'), 'who sees it', 2000)
    expect(a.find('project-participants')).toBeNull()
    await a.unmount()
    signedIn('member')
    const b = await mount(<MemoryRouter><ProjectForm project={project('shared/acme')} onClose={() => {}} onSaved={() => {}} /></MemoryRouter>)
    expect(b.find('project-form-legacy')).toBeNull()
    expect(b.find('project-participants')).toBeNull()
    await b.unmount()
    // a personal project: nobody to choose
    sent.length = 0
    const c = await mount(<MemoryRouter><ProjectForm project={project('users/mia/projects/notes')} onClose={() => {}} onSaved={() => {}} /></MemoryRouter>)
    await c.settle(50)
    expect(c.find('project-participants')).toBeNull()
    expect(calls(`GET /api/projects/${P1}/access`)).toEqual([])
    await c.unmount()
  })
})
