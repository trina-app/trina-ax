// People in New project (components/NewProjectDialog.tsx with `people`, components/ProjectPeopleField.tsx;
// docs/DECISIONS.md "Share in the project's title row"):
// - nobody picked: a personal project, as before ("Only you see it. You can add people later.");
// - people picked: the count and what sharing does, and Create makes a team project with them (scope team), the
//   server's checks of a later share;
// - the people search is outside the name's form (Enter there never makes the project);
// - a guest is in one place already: greyed out with where they are;
// - a refused create keeps the name and the picks, with the server's words;
// - no field for a member whose team lets only admins share, nor where the dialog is opened without `people` (Move to
//   project).
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import type { Project } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import { NewProjectDialog } from '../../src/components/NewProjectDialog'
import { usePeople } from '../../src/store/people'
import { useSession } from '../../src/store/session'
import { installDom, mount, removeDom, type Mounted } from './dom-host'

const NEW = '01900000-0000-7000-8000-0000000000d1'
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const PEOPLE = { people: [{ id: 'mia', name: 'Mia' }, { id: 'bob', name: 'Bob' }, { id: 'gina', name: 'Gina Park', guest: true, guestPlace: { kind: 'room', id: 'r1', name: 'Quote prep' } }] }
const made = (folderPath: string): Project => ({ id: NEW, name: 'Weekly reports', folderPath, instructions: '', createdBy: { id: 'mia', name: 'Mia' }, createdAt: '2026-11-15T00:00:00.000Z', canEdit: true })
const en = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate('en', key, vars)

let sent: { key: string; body: unknown }[] = []
let routes: Record<string, (body: unknown) => Response> = {}
const realFetch = globalThis.fetch
const localeBefore = useLocaleStore.getState().locale
const sessionBefore = useSession.getState().status
const signedIn = (projectCreators: 'members' | 'admins') =>
  useSession.setState({ status: { kind: 'signed-in', me: { user: { id: 'mia', name: 'Mia', role: 'member' }, groups: [], team: { name: 'Acme', defaultLocale: 'en', projectCreators }, server: { version: '0', dev: false } } } } as never)
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'en' })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input).split('?')[0]}`
    const body = init?.body ? JSON.parse(String(init.body)) : null
    sent.push({ key, body })
    return routes[key]?.(body) ?? json(500, { error: { code: 'internal', message: `no route ${key}` } })
  }) as unknown as typeof fetch
})
afterEach(() => { sent = []; usePeople.getState().reset() })
afterAll(() => {
  globalThis.fetch = realFetch
  removeDom()
  useLocaleStore.setState({ locale: localeBefore })
  useSession.setState({ status: sessionBefore })
})
const routesWith = (create: (body: unknown) => Response) => {
  routes = {
    'GET /api/people': () => json(200, PEOPLE),
    'GET /api/projects': () => json(200, { items: [] }),
    'POST /api/projects/access-preview': () => json(200, { people: 2, added: 0, removed: 0, files: 0, othersFiles: 0, sharedChats: 0, skills: 0 }),
    'POST /api/projects': create,
  }
}
async function open(o: { people?: boolean } = {}) {
  let madeP: Project | null = null
  const m = await mount(<MemoryRouter><NewProjectDialog people={o.people ?? true} onClose={() => {}} onMade={(p) => { madeP = p }} /></MemoryRouter>)
  return { m, made: () => madeP as Project | null }
}
async function addBob(m: Mounted) {
  await m.type('project-participants-search', 'bob')
  await m.click(await m.until(() => m.find('participant-add-user-bob'), 'Bob to add', 2000))
  await m.until(() => m.find('participant-user-bob'), 'Bob in the list', 2000)
}
const creates = () => sent.filter((x) => x.key === 'POST /api/projects').map((x) => x.body)

describe('New project: People (optional)', () => {
  test('nobody picked: a personal project, the "later" line, no count, no share note', async () => {
    signedIn('members')
    routesWith(() => json(201, made('users/mia/projects/Weekly reports')))
    const { m, made: got } = await open()
    try {
      expect(m.html()).toContain(en('projects.newPeople'))
      expect(m.get('project-who').textContent).toBe(en('projects.who.later'))
      expect(m.find('project-share-note')).toBeNull()
      expect(m.find('project-access-summary')).toBeNull()
      await m.type('project-name', 'Weekly reports')
      await m.click('project-create')
      await m.until(() => got(), 'made', 2000)
      expect(creates()).toEqual([{ name: 'Weekly reports', scope: 'personal', instructions: '', participants: [] }])
    } finally { await m.unmount() }
  })

  test('a person picked: the count and what sharing does; Create makes a team project with them', async () => {
    signedIn('members')
    routesWith(() => json(201, made('projects/Weekly reports')))
    const { m, made: got } = await open()
    try {
      await m.type('project-name', 'Weekly reports')
      await addBob(m)
      expect(m.find('project-who')).toBeNull()
      expect(m.get('project-share-note').textContent).toBe(`${en('projects.shareNote')} ${en('projects.shareConfirmFinal')}`)
      await m.until(() => m.find('project-access-summary')?.textContent === en('projects.whoMembers', { n: 2 }), 'the count', 2000)
      await m.click('project-create')
      await m.until(() => got(), 'made', 2000)
      expect(creates()).toEqual([{ name: 'Weekly reports', scope: 'team', instructions: '', participants: [{ subjectType: 'user', subjectId: 'bob' }] }])
    } finally { await m.unmount() }
  })

  test('the people search is outside the name\'s form: Enter there never makes the project', async () => {
    signedIn('members')
    routesWith(() => json(201, made('projects/x')))
    const { m } = await open()
    try {
      const search = await m.until(() => m.find('project-participants-search'), 'the search', 2000)
      expect(m.get('project-name').closest('form')).not.toBeNull()
      expect(search.closest('form')).toBeNull()
    } finally { await m.unmount() }
  })

  test('a guest is in one place already: greyed out with where they are, no Add', async () => {
    signedIn('members')
    routesWith(() => json(201, made('projects/x')))
    const { m } = await open()
    try {
      await m.type('project-participants-search', 'gina')
      const row = await m.until(() => m.find('participant-elsewhere-user-gina'), 'Gina greyed out', 2000)
      expect(row.textContent).toContain(en('guest.inRoom', { place: 'Quote prep' }))
      expect(m.find('participant-add-user-gina')).toBeNull()
    } finally { await m.unmount() }
  })

  test('a refused create keeps the name and the picks, with the server\'s words', async () => {
    signedIn('members')
    routesWith(() => json(400, { error: { code: 'validation', message: 'Bob is not an active person.' } }))
    const { m, made: got } = await open()
    try {
      await m.type('project-name', 'Weekly reports')
      await addBob(m)
      await m.click('project-create')
      await m.until(() => m.html().includes('Bob is not an active person.'), 'the refusal', 2000)
      expect(got()).toBeNull()
      expect((m.get('project-name') as unknown as HTMLInputElement).value).toBe('Weekly reports')
      expect(m.find('participant-user-bob')).not.toBeNull()
    } finally { await m.unmount() }
  })

  test('no field for a member whose team lets only admins share, nor without `people` (Move to project)', async () => {
    signedIn('admins')
    routesWith(() => json(201, made('users/mia/projects/x')))
    let o = await open()
    try {
      await o.m.settle(30)
      expect(o.m.find('project-participants-search')).toBeNull()
      expect(o.m.get('project-who').textContent).toBe(en('projects.who.meOnly'))
    } finally { await o.m.unmount() }
    signedIn('members')
    o = await open({ people: false })
    try {
      await o.m.settle(30)
      expect(o.m.find('project-participants-search')).toBeNull()
      expect(o.m.get('project-who').textContent).toBe(en('projects.who.later'))
    } finally { await o.m.unmount() }
  })
})
