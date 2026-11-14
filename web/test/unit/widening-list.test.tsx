// The widening warning and list in a project's Members dialog (components/ProjectMembersDialog.tsx,
// components/WideningList.tsx; docs/DECISIONS.md "People who see a shared chat later: nothing new is hidden"):
// - adding someone who would start seeing answers that used places they can't open: one line under the count with
//   "Show answers"; the list replaces the body in place, ‹ goes back with the picks kept;
// - each item: the chat, who asked, its first line, the places by name or "a place you can't open"; on a computer a
//   link to /c/<chat>?answer=<id> in a new tab;
// - a phone: an item opens on this screen after the draft is kept (store/wideningDraft.ts); back on the screen that
//   opened the dialog, WideningDraftHost opens it again on the list with the picks; a draft whose members were saved
//   meanwhile (another rules hash) or one older than 30 minutes is dropped and the dialog opens fresh.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import type { Project, ProjectAccess, ProjectAccessPreview, WideningAnswers } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import { ProjectMembersDialog } from '../../src/components/ProjectMembersDialog'
import { WideningDraftHost } from '../../src/components/WideningDraftHost'
import { DialogHost } from '../../src/components/ui'
import { usePeople } from '../../src/store/people'
import { useProjects } from '../../src/store/projects'
import { useSession } from '../../src/store/session'
import { DRAFT_MAX_AGE_MS, useWideningDraft } from '../../src/store/wideningDraft'
import { installDom, mount, removeDom } from './dom-host'

const P1 = '01900000-0000-7000-8000-0000000000a1'
const C1 = '01900000-0000-7000-8000-0000000000c1'
const M1 = '01900000-0000-7000-8000-0000000000d1'
const M2 = '01900000-0000-7000-8000-0000000000d2'
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const project: Project = { id: P1, name: 'Acme launch', folderPath: 'projects/acme', instructions: '', createdBy: { id: 'mia', name: 'Mia' }, createdAt: '2026-11-09T00:00:00.000Z', canEdit: true, audience: 2, membersEditable: true, creatorChangesMembers: true } as Project
const PEOPLE = { people: [{ id: 'mia', name: 'Mia' }, { id: 'bob', name: 'Bob' }, { id: 'sora', name: 'Sora' }] }
const access: ProjectAccess = { editable: true, rulesHash: 'h1', people: 2, participants: [{ subjectType: 'user', subjectId: 'mia', name: 'Mia', creator: true }, { subjectType: 'user', subjectId: 'sora', name: 'Sora' }], otherRules: [] } as ProjectAccess
const preview = (o: Partial<ProjectAccessPreview> = {}): ProjectAccessPreview => ({ people: 3, added: 0, removed: 0, files: 0, othersFiles: 0, sharedChats: 0, skills: 0, ...o })
const LIST: WideningAnswers = {
  total: 2, totalCapped: false, nextCursor: null, items: [
    { chatId: C1, chatTitle: 'Q3 budget questions', messageId: M1, at: '2026-11-12T03:00:00.000Z', askedBy: { id: 'mia', name: 'Mia' }, preview: 'The finance draft puts Q3 spend at 41 % over', places: [{ name: 'groups/finance/' }], missedBy: ['Bob'] },
    { chatId: C1, chatTitle: '', messageId: M2, at: '2026-11-09T03:00:00.000Z', askedBy: null, preview: 'Two contracts renew', places: [{ hidden: true }], missedBy: ['Bob'] },
  ],
}

let sent: { key: string; body: unknown }[] = []
const realFetch = globalThis.fetch
const localeBefore = useLocaleStore.getState().locale
const sessionBefore = useSession.getState().status
const g = globalThis as Record<string, unknown>
/** a phone (below 768 px) or a computer, as useMediaQuery reads it */
const screen = (isPhone: boolean) => { g.matchMedia = (q: string) => ({ matches: isPhone && q.includes('max-width'), addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }) }
let routes: Record<string, () => Response> = {}
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'en' })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input).split('?')[0]}`
    sent.push({ key, body: init?.body ? JSON.parse(String(init.body)) : null })
    return routes[key]?.() ?? json(500, { error: { code: 'internal', message: `no route ${key}` } })
  }) as unknown as typeof fetch
  useSession.setState({ status: { kind: 'signed-in', me: { user: { id: 'mia', name: 'Mia', role: 'member' }, groups: [], team: { name: 'Acme', defaultLocale: 'en', projectCreators: 'members' }, server: { version: '0', dev: false } } } } as never)
})
afterEach(() => { sent = []; screen(false); usePeople.getState().reset(); useWideningDraft.getState().drop() })
afterAll(() => {
  globalThis.fetch = realFetch
  removeDom()
  useLocaleStore.setState({ locale: localeBefore })
  useSession.setState({ status: sessionBefore })
})
const en = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate('en', key, vars)
const routesWith = (hidden: number) => {
  routes = {
    'GET /api/people': () => json(200, PEOPLE),
    [`GET /api/projects/${P1}/access`]: () => json(200, access),
    'POST /api/projects/access-preview': () => json(200, preview(hidden ? { added: 1, sharedChats: 1, hiddenAnswers: hidden } : {})),
    'POST /api/sharing/widening-answers': () => json(200, LIST),
  }
}

describe('the warning and the list', () => {
  test('adding Bob: the line, Show answers, the list in place, ‹ back with Bob still picked; a computer opens an answer in a new tab', async () => {
    screen(false)
    routesWith(2)
    const m = await mount(<MemoryRouter initialEntries={['/projects/x']}><ProjectMembersDialog project={project} onClose={() => {}} onSaved={() => {}} /><DialogHost /></MemoryRouter>)
    await m.until(() => m.find('participant-user-sora'), 'the members', 2000)
    expect(m.find('project-widen-answers')).toBeNull()
    await m.type('project-participants-search', 'bob')
    await m.click(await m.until(() => m.find('participant-add-user-bob'), 'Bob to add', 2000))
    const line = await m.until(() => m.find('project-widen-answers'), 'the widening line', 3000)
    expect(line.textContent).toContain(en('chat.share.widen', { n: 2, names: 'Bob' }))
    expect(en('chat.share.widen', { n: 2, names: 'Bob' })).toBe("2 answers here used places Bob can't open. Adding them shows those answers too.")
    await m.click('project-widen-show')
    const list = await m.until(() => m.find('widening-list'), 'the list', 2000)
    expect(m.get('widening-list-title').textContent).toBe('Answers Bob will see')
    await m.until(() => m.find(`widening-item-${M1}`), 'the items', 2000)
    const req = sent.find((x) => x.key === 'POST /api/sharing/widening-answers')!.body as { target: unknown; add: unknown[] }
    expect(req.target).toEqual({ kind: 'project', projectId: P1 })
    expect(req.add).toContainEqual({ subjectType: 'user', subjectId: 'bob' })
    const first = m.get(`widening-item-${M1}`)
    expect(first.textContent).toContain('Q3 budget questions')
    expect(first.textContent).toContain('The finance draft puts Q3 spend at 41 % over')
    expect(first.textContent).toContain('groups/finance/')
    const second = m.get(`widening-item-${M2}`)
    expect(second.textContent).toContain(en('chat.untitled'))
    expect(second.textContent).toContain(en('share.widenList.placeHidden'))
    const link = first.querySelector('a')!
    expect(link.getAttribute('href')).toBe(`/c/${C1}?answer=${M1}`)
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.textContent).toContain(en('share.widenList.open'))
    // no save on the list; ‹ back to the picks, Bob still there
    expect(m.find('project-members-save')).toBeNull()
    void list
    await m.click('widening-list-back')
    await m.until(() => m.find('participant-user-bob'), 'Bob still picked', 2000)
    expect(m.get('participant-user-bob').getAttribute('data-state')).toBe('new')
    await m.unmount()
  })

  test('the list empty (something changed since): says so', async () => {
    routesWith(1)
    routes['POST /api/sharing/widening-answers'] = () => json(200, { total: 0, totalCapped: false, nextCursor: null, items: [] })
    const m = await mount(<MemoryRouter><ProjectMembersDialog project={project} onClose={() => {}} onSaved={() => {}} /></MemoryRouter>)
    await m.until(() => m.find('participant-user-sora'), 'the members', 2000)
    await m.type('project-participants-search', 'bob')
    await m.click(await m.until(() => m.find('participant-add-user-bob'), 'Bob to add', 2000))
    await m.click(await m.until(() => m.find('project-widen-show'), 'Show answers', 3000))
    expect((await m.until(() => m.find('widening-list-empty'), 'empty', 2000)).textContent).toBe(en('share.widenList.empty'))
    await m.unmount()
  })
})

describe('a phone: the way back', () => {
  test('an item opens on this screen with the draft kept; back on the opener the dialog opens on the list with Bob picked', async () => {
    screen(true)
    routesWith(2)
    useProjects.getState().put(project)
    let closed = false
    const m = await mount(
      <MemoryRouter initialEntries={['/projects/x']}>
        <Routes>
          <Route path="/projects/x" element={<ProjectMembersDialog project={project} onClose={() => { closed = true }} onSaved={() => {}} />} />
          <Route path="/c/:id" element={<p data-testid="chat-page">chat</p>} />
        </Routes>
      </MemoryRouter>,
    )
    await m.until(() => m.find('participant-user-sora'), 'the members', 2000)
    await m.type('project-participants-search', 'bob')
    await m.click(await m.until(() => m.find('participant-add-user-bob'), 'Bob to add', 2000))
    await m.click(await m.until(() => m.find('project-widen-show'), 'Show answers', 3000))
    const open = await m.until(() => m.find(`widening-item-${M1}`)?.querySelector('button') ?? null, 'the item as a button', 2000)
    await m.click(open)
    await m.until(() => m.find('chat-page'), 'the chat page', 2000)
    expect(closed).toBe(true)
    const d = useWideningDraft.getState().draft!
    expect(d).toMatchObject({ projectId: P1, rulesHash: 'h1', from: '/projects/x', left: true })
    expect(d.participants).toContainEqual({ subjectType: 'user', subjectId: 'bob' })
    expect(JSON.parse(sessionStorage.getItem('trina.wideningDraft') ?? 'null')?.projectId).toBe(P1)
    await m.unmount()

    // back on the screen that opened it: the host opens the dialog on the list, Bob picked
    const back = await mount(<MemoryRouter initialEntries={['/projects/x']}><WideningDraftHost /></MemoryRouter>)
    await back.until(() => back.find('widening-list'), 'the list again', 3000)
    expect(back.get('widening-list-title').textContent).toBe('Answers Bob will see')
    expect(useWideningDraft.getState().draft).toBeNull()
    await back.click('widening-list-back')
    expect((await back.until(() => back.find('participant-user-bob'), 'Bob', 2000)).getAttribute('data-state')).toBe('new')
    await back.unmount()
  })

  test('members saved meanwhile (another rules hash) or too old: the dialog opens fresh', async () => {
    screen(true)
    routesWith(2)
    useProjects.getState().put(project)
    useWideningDraft.getState().keep({ projectId: P1, participants: [{ subjectType: 'user', subjectId: 'sora' }, { subjectType: 'user', subjectId: 'bob' }], removeRules: [], rulesHash: 'old', scroll: 0, from: '/projects/x', at: Date.now(), left: true })
    const m = await mount(<MemoryRouter initialEntries={['/projects/x']}><WideningDraftHost /></MemoryRouter>)
    await m.until(() => m.find('participant-user-sora'), 'the dialog, fresh', 3000)
    expect(m.find('widening-list')).toBeNull()
    expect(m.find('participant-user-bob')).toBeNull()
    await m.unmount()
    useWideningDraft.getState().keep({ projectId: P1, participants: [], removeRules: [], rulesHash: 'h1', scroll: 0, from: '/projects/x', at: Date.now() - DRAFT_MAX_AGE_MS - 1000, left: true })
    const n = await mount(<MemoryRouter initialEntries={['/projects/x']}><WideningDraftHost /></MemoryRouter>)
    await new Promise((r) => setTimeout(r, 50))
    expect(n.find('project-members-dialog')).toBeNull()
    expect(useWideningDraft.getState().draft).toBeNull()
    await n.unmount()
  })
})
