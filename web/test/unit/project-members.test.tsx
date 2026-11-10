// A team project's members dialog (components/ProjectMembersDialog.tsx, docs/DECISIONS.md "Project members in one
// panel"), rendered and clicked:
// - the members now: the creator fixed, a person or group with a rule set in Admin › Folder permissions tagged and
//   without ×, the rules this screen does not change listed read-only; × takes one out (struck through, 되돌리기 until
//   the save), the search adds one (새로, the title kept);
// - the save asks first when someone gains it (what they will see, and how many lose it), or when the server's dry run
//   says the save also writes the floor rule or puts the creator's rule back; taking people out alone saves at once;
//   cancelling saves nothing; a change by someone else meanwhile (409 rules_changed) is shown with what is there now;
// - a project that cannot be changed here says who does it, with no save.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import type { Project, ProjectAccess, ProjectAccessPreview } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import { ProjectMembersDialog } from '../../src/components/ProjectMembersDialog'
import { DialogHost } from '../../src/components/ui'
import { usePeople } from '../../src/store/people'
import { useSession } from '../../src/store/session'
import { installDom, mount, removeDom, type Mounted } from './dom-host'

const P1 = '01900000-0000-7000-8000-0000000000a1'
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const project = (o: Partial<Project> = {}): Project =>
  ({ id: P1, name: 'Acme launch', folderPath: 'projects/acme', instructions: '', createdBy: { id: 'mia', name: 'Mia' }, createdAt: '2026-11-09T00:00:00.000Z', canEdit: true, audience: 3, membersEditable: true, creatorChangesMembers: true, ...o })
const PEOPLE = { people: [{ id: 'mia', name: 'Mia' }, { id: 'bob', name: 'Bob', title: 'Sales lead' }, { id: 'sora', name: 'Sora', title: 'Designer' }, { id: 'jiwoo', name: 'Jiwoo' }] }
const access = (o: Partial<ProjectAccess> = {}): ProjectAccess => ({
  editable: true, rulesHash: 'h1', people: 3,
  participants: [{ subjectType: 'user', subjectId: 'mia', name: 'Mia', creator: true }, { subjectType: 'user', subjectId: 'sora', name: 'Sora' }],
  otherRules: [], ...o,
})
const preview = (o: Partial<ProjectAccessPreview> = {}): ProjectAccessPreview => ({ people: 3, added: 0, removed: 0, files: 0, othersFiles: 0, sharedChats: 0, skills: 0, ...o })

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

function signedIn(role: 'member' | 'admin') {
  useSession.setState({ status: { kind: 'signed-in', me: { user: { id: 'mia', name: 'Mia', role }, groups: [], team: { name: 'Acme', defaultLocale: 'en', projectCreators: 'members' }, server: { version: '0', dev: false } } } } as never)
}
const calls = (key: string) => sent.filter((x) => x.key === key)
const en = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate('en', key, vars)
const state = (m: Mounted, id: string) => m.get(id).getAttribute('data-state')
const dialog = (o: { onSaved?: (p: Project) => void } = {}) =>
  mount(<MemoryRouter><ProjectMembersDialog project={project()} onClose={() => {}} onSaved={o.onSaved ?? (() => {})} /><DialogHost /></MemoryRouter>)
async function addBob(m: Mounted) {
  await m.type('project-participants-search', 'bob')
  await m.click(await m.until(() => m.find('participant-add-user-bob'), 'Bob to add', 2000))
}

describe('the members now', () => {
  test('the creator is fixed, a folder-permission rule is tagged, × and 되돌리기 before the save, 새로 with the title', async () => {
    signedIn('member')
    routes = {
      'GET /api/people': () => json(200, PEOPLE),
      [`GET /api/projects/${P1}/access`]: () => json(200, access({ otherRules: [{ path: 'projects/acme', subjectType: 'user', subjectId: 'jiwoo', name: 'Jiwoo', access: 'read' }, { path: 'projects/acme/hr', subjectType: 'everyone', subjectId: null, name: null, access: 'none' }] })),
      'POST /api/projects/access-preview': () => json(200, preview()),
    }
    const m = await dialog()
    await m.until(() => m.find('participant-user-sora'), 'the members', 2000)
    expect(state(m, 'participant-user-mia')).toBe('fixed')
    expect(m.get('participant-user-mia').textContent).toContain(en('projects.creatorTag'))
    expect(m.find('participant-remove-user-mia')).toBeNull()
    // Admin's read rule: in the list, tagged, without ×; and in the read-only box with the rule inside
    expect(state(m, 'participant-user-jiwoo')).toBe('fixed')
    expect(m.get('participant-user-jiwoo').textContent).toContain(`${en('access.read')} · ${en('projects.folderRuleTag')}`)
    expect(m.find('participant-remove-user-jiwoo')).toBeNull()
    const other = m.get('project-other-rules').textContent ?? ''
    expect(other).toContain(`Jiwoo: ${en('access.read')}`)
    expect(other).toContain(`${en('projects.ruleInside', { path: 'hr' })} · ${en('rules.everyone')}: ${en('access.none')}`)
    expect(other).not.toContain(en('projects.otherRulesLink')) // a member: no link to the admin screen
    // nothing changed yet: no save
    expect(m.get('project-members-save').hasAttribute('disabled')).toBe(true)
    expect(m.get('participant-user-sora').textContent).toContain('Designer')
    // × keeps the row, struck through, until the save; 되돌리기 brings it back
    await m.click('participant-remove-user-sora')
    expect(state(m, 'participant-user-sora')).toBe('removed')
    expect(m.get('project-members-save').hasAttribute('disabled')).toBe(false)
    await m.click('participant-undo-user-sora')
    expect(state(m, 'participant-user-sora')).toBe('member')
    expect(m.get('project-members-save').hasAttribute('disabled')).toBe(true)
    // the search never offers someone already in, or a fixed one
    await m.click('project-participants-search')
    await m.until(() => m.find('participant-add-user-bob'), 'the people to add', 2000)
    expect(m.find('participant-add-user-sora')).toBeNull()
    expect(m.find('participant-add-user-jiwoo')).toBeNull()
    expect(m.find('participant-add-user-mia')).toBeNull()
    await m.click('participant-add-user-bob')
    await m.until(() => m.find('participant-user-bob'), 'Bob in the list', 2000)
    expect(state(m, 'participant-user-bob')).toBe('new')
    expect(m.get('participant-user-bob').textContent).toContain(`Sales lead · ${en('projects.newTag')}`)
    await m.unmount()
  })

  test('the count line only: how many see it, the owner and admins included', async () => {
    signedIn('member')
    let n = 3
    routes = {
      'GET /api/people': () => json(200, PEOPLE),
      [`GET /api/projects/${P1}/access`]: () => json(200, access()),
      'POST /api/projects/access-preview': () => json(200, preview({ people: n })),
    }
    const m = await dialog()
    await m.until(() => m.find('project-access-summary')?.textContent === en('projects.whoCount', { n: 3 }), 'the count', 2000)
    n = 4
    await addBob(m)
    await m.until(() => m.get('project-access-summary').textContent === en('projects.whoCount', { n: 4 }), 'the new count', 2000)
    expect(m.get('project-access-summary').textContent).not.toContain('Sora')
    await m.unmount()
  })
})

describe('saving', () => {
  test('someone gaining it: the confirm says what they will see and how many lose it; yes saves with the hash', async () => {
    signedIn('member')
    routes = {
      'GET /api/people': () => json(200, PEOPLE),
      [`GET /api/projects/${P1}/access`]: () => json(200, access()),
      'POST /api/projects/access-preview': (init) => {
        const b = JSON.parse(String(init?.body)) as { participants: { subjectId: string }[] }
        return json(200, b.participants.some((x) => x.subjectId === 'bob') ? preview({ people: 3, added: 1, removed: 1, files: 12, othersFiles: 5, sharedChats: 3, skills: 2, skillNames: ['견적-현장', '견적서'] }) : preview())
      },
      [`PUT /api/projects/${P1}/participants`]: () => json(200, access({ rulesHash: 'h2', people: 3, participants: [{ subjectType: 'user', subjectId: 'mia', name: 'Mia', creator: true }, { subjectType: 'user', subjectId: 'bob', name: 'Bob' }] })),
    }
    let saved: Project | null = null
    const m = await dialog({ onSaved: (p) => { saved = p } })
    await m.until(() => m.find('participant-user-sora'), 'the members', 2000)
    await m.click('participant-remove-user-sora')
    await addBob(m)
    await m.click('project-members-save')
    const box = await m.until(() => m.find('project-widen-confirm'), 'the confirm', 2000)
    expect(box.textContent).toContain(en('projects.widenBody', { n: 1 }))
    expect(box.textContent).toContain(en('projects.widenFilesOthers', { n: 12, m: 5 }))
    expect(box.textContent).toContain(en('projects.widenChats', { n: 3 }))
    expect(box.textContent).toContain(en('projects.widenSkills', { n: 2, m: 1, names: '견적-현장, 견적서' }))
    // the person taken out at the same time: said too
    expect(m.get('project-narrow-line').textContent).toBe(en('projects.narrowBody', { n: 1 }))
    expect(calls(`PUT /api/projects/${P1}/participants`)).toEqual([])
    await m.click('dialog-confirm')
    await m.until(() => saved, 'the save', 2000)
    expect(calls(`PUT /api/projects/${P1}/participants`)[0]!.body).toEqual({ participants: [{ subjectType: 'user', subjectId: 'bob' }], expectedHash: 'h1' })
    expect(saved!.audience).toBe(3)
    await m.unmount()
  })

  test('taking people out alone saves at once; the floor rule or the creator coming back asks first; no saves nothing', async () => {
    signedIn('member')
    let extra: Partial<ProjectAccessPreview> = {}
    routes = {
      'GET /api/people': () => json(200, PEOPLE),
      [`GET /api/projects/${P1}/access`]: () => json(200, access()),
      'POST /api/projects/access-preview': () => json(200, preview({ people: 2, removed: 1, ...extra })),
      [`PUT /api/projects/${P1}/participants`]: () => json(200, access({ people: 2, participants: [{ subjectType: 'user', subjectId: 'mia', name: 'Mia', creator: true }] })),
    }
    let saved = 0
    const m = await dialog({ onSaved: () => { saved++ } })
    await m.until(() => m.find('participant-user-sora'), 'the members', 2000)
    await m.click('participant-remove-user-sora')
    await m.click('project-members-save')
    await m.until(() => saved === 1, 'the save', 2000)
    expect(m.find('project-widen-confirm')).toBeNull()
    expect(calls(`PUT /api/projects/${P1}/participants`)[0]!.body).toEqual({ participants: [], expectedHash: 'h1' })
    await m.unmount()

    for (const [o, line] of [[{ addsFloor: true }, 'project-adds-floor'], [{ restoresCreator: true }, 'project-restores-creator']] as const) {
      sent.length = 0
      extra = o
      const n = await dialog({ onSaved: () => { saved++ } })
      await n.until(() => n.find('participant-user-sora'), 'the members', 2000)
      await n.click('participant-remove-user-sora')
      await n.click('project-members-save')
      const box = await n.until(() => n.find('project-widen-confirm'), 'the confirm', 2000)
      expect(box.textContent).toContain(en(line === 'project-adds-floor' ? 'projects.addsFloor' : 'projects.restoresCreator'))
      expect(box.textContent).toContain(en('projects.narrowBody', { n: 1 }))
      expect(n.html()).toContain(en('projects.changeTitle'))
      expect(n.find('project-adds-floor') !== null).toBe(line === 'project-adds-floor')
      // cancel: nothing saved
      await n.click(n.get('dialog-confirm').parentElement!.querySelector('button')!)
      await n.settle(50)
      expect(calls(`PUT /api/projects/${P1}/participants`)).toEqual([])
      expect(saved).toBe(1)
      await n.unmount()
    }
  })

  test('someone else changed it meanwhile: the message, and the list shows what is there now', async () => {
    signedIn('member')
    let conflict = false
    routes = {
      'GET /api/people': () => json(200, PEOPLE),
      [`GET /api/projects/${P1}/access`]: () => json(200, access(conflict ? { rulesHash: 'h9', participants: [{ subjectType: 'user', subjectId: 'mia', name: 'Mia', creator: true }, { subjectType: 'user', subjectId: 'bob', name: 'Bob' }] } : {})),
      'POST /api/projects/access-preview': () => json(200, preview({ removed: 1 })),
      [`PUT /api/projects/${P1}/participants`]: () => json(409, { error: { code: 'conflict', message: 'Someone changed who sees this project in the meantime.', params: { reason: 'rules_changed' } } }),
    }
    const m = await dialog()
    await m.until(() => m.find('participant-user-sora'), 'the members', 2000)
    conflict = true
    await m.click('participant-remove-user-sora')
    await m.click('project-members-save')
    await m.until(() => m.html().includes('Someone changed who sees this project'), 'the message', 2000)
    await m.until(() => m.find('participant-user-bob')?.getAttribute('data-state') === 'member', 'Bob, added by someone else', 2000)
    expect(m.find('participant-user-sora')).toBeNull()
    await m.unmount()
  })
})

describe('a project not changed here', () => {
  test('an admin reads where to change it; a member reads that an admin does; no save', async () => {
    routes = {
      'GET /api/people': () => json(200, PEOPLE),
      [`GET /api/projects/${P1}/access`]: () => json(200, access({ editable: false })),
    }
    for (const role of ['admin', 'member'] as const) {
      signedIn(role)
      const m = await mount(<MemoryRouter><ProjectMembersDialog project={project({ folderPath: 'shared/acme' })} onClose={() => {}} onSaved={() => {}} /></MemoryRouter>)
      const line = await m.until(() => m.find('project-members-locked'), 'the line', 2000)
      expect(line.textContent).toBe(role === 'admin' ? en('projects.legacyNote', { folder: 'Company-wide/acme' }) : en('projects.membersByAdmins'))
      expect(m.find('project-participants')).toBeNull()
      expect(m.find('project-members-save')).toBeNull()
      await m.unmount()
    }
  })
})
