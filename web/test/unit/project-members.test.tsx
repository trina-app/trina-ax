// A team project's members dialog (components/ProjectMembersDialog.tsx, docs/DECISIONS.md "Project members in one
// panel"), rendered and clicked:
// - the members now: the creator fixed, a person or group with a rule set in Admin › Folder permissions tagged and
//   without ×, the rules this screen does not change listed read-only; × takes one out (struck through, 되돌리기 until
//   the save), the search adds one (새로, the title kept);
// - the save asks first when someone gains it (what they will see, and how many lose it), or when the server's dry run
//   says the save also writes the floor rule or puts the creator's rule back; taking people out alone saves at once;
//   cancelling saves nothing; a change by someone else meanwhile (409 rules_changed) is shown with what is there now;
// - a project that cannot be changed here says who does it, with no save;
// - the independent review: Esc on the search or a result closes the results, not the dialog; a "no access" rule from Admin is no
//   member (only in the read-only box); after × the keyboard is on 되돌리기, after 되돌리기 on ×.
// - members only (docs/DECISIONS.md "Project contents only for members"): the count line is the members ("3 members"),
//   for the owner and admins too, with no part for them by role; another setting of the folder itself has × (sent as
//   removeRules, in the dry run too), those inside stay read-only, and those inside the caller may not read are counted;
//   a save that adds only the caller asks with the "Add me" confirm; for someone who manages it without being a member
//   the widening confirm says they will see its files and chats, with no numbers; the project is read again with
//   manage=1 after a save.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { act } from 'react'
import { MemoryRouter } from 'react-router-dom'
import type { Project, ProjectAccess, ProjectAccessPreview } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import { ProjectMembersDialog } from '../../src/components/ProjectMembersDialog'
import { DialogHost } from '../../src/components/ui'
import { usePeople } from '../../src/store/people'
import { useSession } from '../../src/store/session'
import { FakeEvent, installDom, mount, removeDom, type Mounted } from './dom-host'

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
const sent: { key: string; url: string; body: unknown }[] = []
const realFetch = globalThis.fetch
const localeBefore = useLocaleStore.getState().locale
const sessionBefore = useSession.getState().status
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'en' })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input).split('?')[0]}`
    sent.push({ key, url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null })
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
    expect(en('projects.folderRuleTag')).toBe('set separately')
    expect(translate('ko', 'projects.folderRuleTag')).toBe('따로 정함')
    expect(m.find('participant-remove-user-jiwoo')).toBeNull()
    const other = m.get('project-other-rules').textContent ?? ''
    // its title: who else sees it, in plain words (not "rules set in folder permissions")
    expect(other).toContain('Others who can see it')
    expect(translate('ko', 'projects.otherRules')).toBe('멤버 말고도 볼 수 있는 사람')
    expect(other).toContain(`Jiwoo: ${en('access.read')}`)
    expect(other).toContain(`${en('projects.ruleInside', { path: 'hr' })} · ${en('rules.everyone')}: ${en('access.none')}`)
    expect(other).not.toContain(en('projects.otherRulesLink')) // no link to the admin screen
    expect(other).not.toContain('cannot be changed here')
    // the setting of the folder itself can go (×); the one of a folder inside cannot
    expect(m.find('project-other-rule-remove-user-jiwoo')).not.toBeNull()
    expect(m.get('project-other-rule-everyone-all').getAttribute('data-state')).toBe('inside')
    expect(m.find('project-other-rule-remove-everyone-all')).toBeNull()
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

  test('an admin (the owner\'s case): its members only, with no part for the owner and admins by role, no names', async () => {
    signedIn('admin')
    let n = 3
    routes = {
      'GET /api/people': () => json(200, PEOPLE),
      'GET /api/admin/groups': () => json(200, { items: [] }),
      [`GET /api/projects/${P1}/access`]: () => json(200, access({ people: 3 })),
      'POST /api/projects/access-preview': () => json(200, preview({ people: n, split: { direct: n, byRole: 0 } })),
    }
    const m = await dialog()
    await m.until(() => m.find('project-access-summary')?.textContent === en('projects.whoMembers', { n: 3 }), 'the members', 2000)
    expect(m.find('project-access-summary-role')).toBeNull()
    n = 4
    await addBob(m)
    await m.until(() => m.get('project-access-summary').textContent === en('projects.whoMembers', { n: 4 }), 'the new count', 2000)
    for (const name of ['Mia', 'Bob', 'Sora', 'Jiwoo']) expect(m.get('project-access-summary').textContent).not.toContain(name)
    await m.unmount()
  })

  test('the count line only: its members, for a member who manages it too', async () => {
    signedIn('member')
    let n = 3
    routes = {
      'GET /api/people': () => json(200, PEOPLE),
      [`GET /api/projects/${P1}/access`]: () => json(200, access()),
      'POST /api/projects/access-preview': () => json(200, preview({ people: n })),
    }
    const m = await dialog()
    await m.until(() => m.find('project-access-summary')?.textContent === en('projects.whoMembers', { n: 3 }), 'the count', 2000)
    n = 4
    await addBob(m)
    await m.until(() => m.get('project-access-summary').textContent === en('projects.whoMembers', { n: 4 }), 'the new count', 2000)
    expect(m.get('project-access-summary').textContent).not.toContain('Sora')
    expect(m.find('project-access-summary-role')).toBeNull()
    await m.unmount()
  })
})

describe('the keyboard and Admin\'s rules', () => {
  test('Esc from the search or a result closes the results and the dialog stays; × then 되돌리기 keep the focus on the row', async () => {
    signedIn('member')
    routes = {
      'GET /api/people': () => json(200, PEOPLE),
      [`GET /api/projects/${P1}/access`]: () => json(200, access()),
      'POST /api/projects/access-preview': () => json(200, preview()),
    }
    let closed = 0
    const m = await mount(<MemoryRouter><ProjectMembersDialog project={project()} onClose={() => { closed++ }} onSaved={() => {}} /><DialogHost /></MemoryRouter>)
    await m.until(() => m.find('participant-user-sora'), 'the members', 2000)
    const esc = async (el: ReturnType<Mounted['get']>) => act(async () => { el.dispatchEvent(new FakeEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' })) })
    await m.type('project-participants-search', 'bo')
    await m.until(() => m.find('participant-add-user-bob'), 'the results', 2000)
    await esc(m.get('participant-add-user-bob'))
    expect(m.find('project-participants-results')).toBeNull()
    expect(m.find('participant-user-sora')).not.toBeNull()
    expect((m.get('project-participants-search') as unknown as { value: string }).value).toBe('')
    expect(closed).toBe(0)
    await m.click('participant-remove-user-sora')
    await m.settle(20)
    expect(document.activeElement).toBe(m.get('participant-undo-user-sora') as unknown as Element)
    await m.click('participant-undo-user-sora')
    await m.settle(20)
    expect(document.activeElement).toBe(m.get('participant-remove-user-sora') as unknown as Element)
    // the results did not open on the way
    expect(m.find('project-participants-results')).toBeNull()
    await m.unmount()
  })

  test('a "no access" rule from Admin is not a member: only the read-only box lists it', async () => {
    signedIn('member')
    routes = {
      'GET /api/people': () => json(200, PEOPLE),
      [`GET /api/projects/${P1}/access`]: () => json(200, access({ otherRules: [{ path: 'projects/acme', subjectType: 'user', subjectId: 'jiwoo', name: 'Jiwoo', access: 'none' }] })),
      'POST /api/projects/access-preview': () => json(200, preview()),
    }
    const m = await dialog()
    await m.until(() => m.find('participant-user-sora'), 'the members', 2000)
    expect(m.find('participant-user-jiwoo')).toBeNull()
    expect(m.get('project-other-rules').textContent).toContain(`Jiwoo: ${en('access.none')}`)
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

  test('after a save the project is read again: its count and whether anyone else sees it by a rule (the line under the box)', async () => {
    signedIn('member')
    let read: Project | null = project({ audience: 4 })
    routes = {
      'GET /api/people': () => json(200, PEOPLE),
      [`GET /api/projects/${P1}/access`]: () => json(200, access()),
      'POST /api/projects/access-preview': () => json(200, preview({ people: 2, removed: 1 })),
      [`PUT /api/projects/${P1}/participants`]: () => json(200, access({ people: 2, participants: [{ subjectType: 'user', subjectId: 'mia', name: 'Mia', creator: true }] })),
      [`GET /api/projects/${P1}`]: () => (read ? json(200, read) : json(500, { error: { code: 'internal', message: 'down' } })),
    }
    for (const [answer, want] of [[project({ audience: 3, alone: true }), { audience: 3, alone: true }], [null, { audience: 2, alone: undefined }]] as const) {
      read = answer
      sent.length = 0
      let saved: Project | null = null
      // the dialog opened on a project that said nobody else sees it by a rule
      const m = await mount(<MemoryRouter><ProjectMembersDialog project={project({ audience: 3, alone: true })} onClose={() => {}} onSaved={(p) => { saved = p }} /><DialogHost /></MemoryRouter>)
      await m.until(() => m.find('participant-user-sora'), 'the members', 2000)
      await m.click('participant-remove-user-sora')
      await m.click('project-members-save')
      await m.until(() => saved, 'the save', 2000)
      expect(calls(`GET /api/projects/${P1}`)).toHaveLength(1)
      // the server's answer; unread, the count from the save and no `alone` (it may no longer be true)
      expect({ audience: saved!.audience, alone: saved!.alone }).toEqual(want)
      await m.unmount()
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
      expect(line.textContent).toBe(role === 'admin' ? en('projects.legacyNote') : en('projects.membersByAdmins'))
      // no folder path in the words
      expect(line.textContent).not.toContain('shared/acme')
      expect(m.find('project-participants')).toBeNull()
      expect(m.find('project-members-save')).toBeNull()
      await m.unmount()
    }
  })

  test('a team project whose folder is missing: what the admin can do (delete it), not a trip to Folder permissions that refuses it', async () => {
    routes = {
      'GET /api/people': () => json(200, PEOPLE),
      [`GET /api/projects/${P1}/access`]: () => json(200, access({ editable: false })),
    }
    signedIn('admin')
    const m = await mount(<MemoryRouter><ProjectMembersDialog project={project({ folderPath: 'projects/acme' })} onClose={() => {}} onSaved={() => {}} /></MemoryRouter>)
    const line = await m.until(() => m.find('project-members-locked'), 'the line', 2000)
    expect(line.textContent).toBe("This project's folder is missing, so its members can't be changed. You can delete the project.")
    expect(translate('ko', 'projects.membersFolderMissing')).toBe('이 프로젝트의 폴더가 없어서 멤버를 바꿀 수 없어요. 프로젝트를 삭제할 수 있어요.')
    for (const l of ['en', 'ko', 'es', 'id', 'ja'] as const) expect(translate(l, 'projects.membersFolderMissing')).not.toContain('›')
    await m.unmount()
  })
})

describe('members only (docs/DECISIONS.md "Project contents only for members")', () => {
  const OWN = { path: 'projects/acme', subjectType: 'group' as const, subjectId: 'g-leads', name: 'Leads', access: 'read' as const }
  const INSIDE = { path: 'projects/acme/hr', subjectType: 'user' as const, subjectId: 'jiwoo', name: 'Jiwoo', access: 'write' as const }

  test('another setting of the folder itself: × takes it out (the dry run and the save send it), 되돌리기 keeps it; one inside stays', async () => {
    signedIn('admin')
    const previews: unknown[] = []
    routes = {
      'GET /api/people': () => json(200, PEOPLE),
      'GET /api/admin/groups': () => json(200, { items: [{ id: 'g-leads', name: 'Leads', description: '', memberIds: [] }] }),
      [`GET /api/projects/${P1}/access`]: () => json(200, access({ otherRules: [OWN, INSIDE] })),
      'POST /api/projects/access-preview': (init) => {
        const b = JSON.parse(String(init?.body)) as { removeRules?: unknown[] }
        previews.push(b.removeRules ?? null)
        return json(200, preview({ people: b.removeRules ? 2 : 3, removed: b.removeRules ? 1 : 0 }))
      },
      [`PUT /api/projects/${P1}/participants`]: () => json(200, access({ rulesHash: 'h2' })),
      [`GET /api/projects/${P1}`]: () => json(200, project({ audience: 2 })),
    }
    let saved: Project | null = null
    const m = await dialog({ onSaved: (p) => { saved = p } })
    await m.until(() => m.find('project-other-rule-remove-group-g-leads'), 'the × of the folder\'s own setting', 2000)
    // the group that only reads is in the list, tagged, until it is taken out
    expect(state(m, 'participant-group-g-leads')).toBe('fixed')
    expect(m.find('project-other-rule-remove-user-jiwoo')).toBeNull()
    expect(m.get('project-other-rule-user-jiwoo').textContent).toContain(en('projects.ruleInside', { path: 'hr' }))
    expect(m.get('project-other-rule-remove-group-g-leads').getAttribute('aria-label')).toBe(en('projects.removeMember', { name: en('projects.whoGroup', { name: 'Leads' }) }))
    await m.click('project-other-rule-remove-group-g-leads')
    expect(m.get('project-other-rule-group-g-leads').getAttribute('data-state')).toBe('removed')
    expect(m.find('participant-group-g-leads')).toBeNull()
    expect(m.get('project-members-save').hasAttribute('disabled')).toBe(false)
    await m.until(() => m.get('project-access-summary').textContent === en('projects.whoMembers', { n: 2 }), 'the count without it', 2000)
    // 되돌리기, then × again
    await m.click('project-other-rule-undo-group-g-leads')
    expect(m.get('project-other-rule-group-g-leads').getAttribute('data-state')).toBe('own')
    expect(m.get('project-members-save').hasAttribute('disabled')).toBe(true)
    await m.click('project-other-rule-remove-group-g-leads')
    await m.click('project-members-save')
    // taking it out only narrows: saved at once, with removeRules
    await m.until(() => saved, 'the save', 2000)
    expect(m.find('project-widen-confirm')).toBeNull()
    expect(calls(`PUT /api/projects/${P1}/participants`)[0]!.body).toEqual({ participants: [{ subjectType: 'user', subjectId: 'sora' }], expectedHash: 'h1', removeRules: [{ subjectType: 'group', subjectId: 'g-leads' }] })
    expect(previews).toContainEqual([{ subjectType: 'group', subjectId: 'g-leads' }])
    // read again as the caller manages it (an owner or admin who is not a member gets it without its contents)
    expect(sent.find((x) => x.key === `GET /api/projects/${P1}`)!.url).toContain('manage=1')
    await m.unmount()
  })

  test('settings inside the caller may not read: counted, never named; no read-only box without any', async () => {
    signedIn('admin')
    routes = {
      'GET /api/people': () => json(200, PEOPLE),
      'GET /api/admin/groups': () => json(200, { items: [] }),
      [`GET /api/projects/${P1}/access`]: () => json(200, access({ otherRulesHidden: 2 })),
      'POST /api/projects/access-preview': () => json(200, preview()),
    }
    const m = await dialog()
    const line = await m.until(() => m.find('project-other-rules-hidden'), 'the count inside', 2000)
    expect(line.textContent).toBe(en('projects.insideOwn', { n: 2 }))
    expect(translate('ko', 'projects.insideOwn', { n: 2 })).toBe('안쪽 폴더 2개는 볼 수 있는 사람이 따로 정해져 있어요')
    expect(m.get('project-other-rules').textContent).not.toContain(en('projects.otherRules'))
    await m.unmount()
  })

  test('a save that adds only me: the "Add me" confirm, not "Let more people see it?"; cancel saves nothing', async () => {
    useSession.setState({ status: { kind: 'signed-in', me: { user: { id: 'olga', name: 'Olga', role: 'owner' }, groups: [], team: { name: 'Acme', defaultLocale: 'en', projectCreators: 'members' }, server: { version: '0', dev: false } } } } as never)
    routes = {
      'GET /api/people': () => json(200, { people: [...PEOPLE.people, { id: 'olga', name: 'Olga' }] }),
      'GET /api/admin/groups': () => json(200, { items: [] }),
      [`GET /api/projects/${P1}/access`]: () => json(200, access()),
      'POST /api/projects/access-preview': () => json(200, preview({ people: 4, added: 1, contentsHidden: true })),
      [`PUT /api/projects/${P1}/participants`]: () => json(200, access({ rulesHash: 'h2' })),
      [`GET /api/projects/${P1}`]: () => json(200, project({ audience: 4 })),
    }
    let saved: Project | null = null
    const m = await dialog({ onSaved: (p) => { saved = p } })
    await m.until(() => m.find('participant-user-sora'), 'the members', 2000)
    await m.type('project-participants-search', 'olga')
    await m.click(await m.until(() => m.find('participant-add-user-olga'), 'me to add', 2000))
    await m.click('project-members-save')
    const box = await m.until(() => m.find('project-add-me-confirm'), 'the Add me confirm', 2000)
    expect(m.html()).toContain(en('projects.addMeTitle', { name: 'Acme launch' }))
    expect(box.textContent).toBe(en('projects.addMeBody'))
    expect(m.find('project-widen-confirm')).toBeNull()
    expect(m.get('dialog-confirm').textContent).toBe(en('projects.addMe'))
    await m.click(m.get('dialog-confirm').parentElement!.querySelector('button')!)
    await m.settle(30)
    expect(calls(`PUT /api/projects/${P1}/participants`)).toEqual([])
    await m.click('project-members-save')
    await m.until(() => m.find('project-add-me-confirm'), 'asked again', 2000)
    await m.click('dialog-confirm')
    await m.until(() => saved, 'the save', 2000)
    expect(calls(`PUT /api/projects/${P1}/participants`)[0]!.body).toEqual({ participants: [{ subjectType: 'user', subjectId: 'sora' }, { subjectType: 'user', subjectId: 'olga' }], expectedHash: 'h1' })
    await m.unmount()
  })

  test('someone who manages it without being a member adds others: "They\'ll see its files and chats", no numbers', async () => {
    signedIn('admin')
    routes = {
      'GET /api/people': () => json(200, PEOPLE),
      'GET /api/admin/groups': () => json(200, { items: [] }),
      [`GET /api/projects/${P1}/access`]: () => json(200, access()),
      'POST /api/projects/access-preview': () => json(200, preview({ people: 4, added: 1, contentsHidden: true })),
    }
    const m = await dialog()
    await m.until(() => m.find('participant-user-sora'), 'the members', 2000)
    await addBob(m)
    await m.click('project-members-save')
    const box = await m.until(() => m.find('project-widen-confirm'), 'the confirm', 2000)
    expect(box.textContent).toContain(en('projects.othersSee'))
    expect(translate('ko', 'projects.othersSee')).toBe('이 사람들은 파일과 채팅을 보게 돼요.')
    expect(box.textContent).not.toContain(en('projects.widenFiles', { n: 0 }))
    expect(box.querySelectorAll('li').length).toBe(1)
    await m.unmount()
  })
})
