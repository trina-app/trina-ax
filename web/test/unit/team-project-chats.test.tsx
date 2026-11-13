// Team project chats shared by default (docs/DECISIONS.md "Team project chats shared by default"; QA TC-949, TC-951,
// TC-952, TC-959): under a team project's box the line says the members see new chats, with an "Only me" switch on every
// screen size; on, the line says only I see it and the first message makes the chat with `private`; the next new chat
// starts shared again. Safe operations: why new chats are only mine, no switch. A private chat in a team project may be
// shared from its row menu (not gated by a project setting) and its copied link says nobody else can open it, with
// "Share with members".
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import type { Chat, Me, Project } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import { NewChatComposer } from '../../src/components/chat/NewChatComposer'
import { mayShareChat } from '../../src/components/chat/ShareChat'
import { useCopyChatLink } from '../../src/components/chat/copyChatLink'
import { isTeamProject, privateInTeamProject, sharedRights } from '../../src/lib/sharedChat'
import { useChats } from '../../src/store/chats'
import { useProjects } from '../../src/store/projects'
import { useSession } from '../../src/store/session'
import { useUi } from '../../src/store/ui'
import { draftChat, draftChatIfAny, dropDraft, isDraftChat, rememberDraftShared } from '../../src/lib/teamAttach'
import { installDom, mount, removeDom } from './dom-host'

const P1 = '01900000-0000-7000-8000-0000000000c1'
const C1 = '01900000-0000-7000-8000-0000000000c2'
const en = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate('en', key, vars)
const project = (o: Partial<Project> = {}): Project =>
  ({ id: P1, name: 'Launch', folderPath: 'projects/launch', instructions: '', createdBy: { id: 'alice', name: 'Alice' }, createdAt: '2026-11-13T00:00:00.000Z', canEdit: true, audience: 3, shareChats: true, membersEditable: true, ...o })
const meAs = (confidential = false) => ({
  user: { id: 'alice', username: 'alice', name: 'Alice', email: null, role: 'member', locale: 'en', localeChoice: null, mustChangePassword: false, prefs: {} },
  groups: [], team: { name: 'Acme', defaultLocale: 'en', projectCreators: 'members' }, session: { id: '01900000-0000-7000-8000-00000000000a', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' },
  server: { version: '0', dev: false, deployment: 'hosted', ...(confidential ? { allChatsConfidential: true } : {}) },
}) as unknown as Me
const chat = (o: Partial<Chat> = {}): Chat => ({ id: C1, title: 'Plan', projectId: P1, engine: 'claude-code', model: null, createdAt: '2026-11-13T00:00:00.000Z', updatedAt: '2026-11-13T00:00:00.000Z', runState: 'idle', ...o }) as unknown as Chat

const sent: { key: string; body: unknown }[] = []
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const before = { locale: useLocaleStore.getState().locale, status: useSession.getState().status }
const realFetch = globalThis.fetch
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'en' })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input).split('?')[0]}`
    const body = init?.body ? JSON.parse(String(init.body)) : null
    sent.push({ key, body })
    if (key === 'POST /api/chats') return json(201, chat({ id: '01900000-0000-7000-8000-0000000000c9' }))
    return json(404, { error: { code: 'not_found', message: 'not here' } })
  }) as unknown as typeof fetch
})
afterEach(() => { sent.length = 0; localStorage.clear(); useUi.setState({ toasts: [] }) })
afterAll(() => {
  globalThis.fetch = realFetch
  removeDom()
  useLocaleStore.setState({ locale: before.locale })
  useSession.setState({ status: before.status })
})

describe('the box of a team project', () => {
  test('shared by default; "Only me" says so; the switch is a real button; personal projects have none', async () => {
    useSession.setState({ status: { kind: 'signed-in', me: meAs() } } as never)
    const m = await mount(<MemoryRouter><NewChatComposer projectId={P1} project={project()} aiLine={false} /></MemoryRouter>)
    try {
      expect(m.get('who-sees').textContent).toBe(en('projects.newChatShared', { n: 3 }))
      const toggle = m.get('only-me-toggle')
      expect([toggle.tagName, toggle.getAttribute('aria-pressed'), toggle.textContent]).toEqual(['BUTTON', 'false', en('projects.onlyMe')])
      // 44 px on a phone (touch-hit), on every screen size (not the computer-only row of the box)
      expect(toggle.getAttribute('class')).toContain('touch-hit')
      expect(m.find('composer-footer')?.querySelector('[data-testid="who-sees"]') ?? null).toBeNull()
      await m.click(toggle)
      expect(m.get('only-me-toggle').getAttribute('aria-pressed')).toBe('true')
      expect(m.get('who-sees').textContent).toBe(en('projects.onlyMeOn'))
      expect(m.get('team-chat-line').getAttribute('data-who')).toBe('me')
      await m.click('only-me-toggle')
      expect(m.get('who-sees').textContent).toBe(en('projects.newChatShared', { n: 3 }))
    } finally { await m.unmount() }
    const personal = await mount(<MemoryRouter><NewChatComposer projectId={P1} project={project({ folderPath: 'users/alice/projects/notes', audience: 1, shareChats: false })} aiLine={false} /></MemoryRouter>)
    try {
      expect(personal.find('only-me-toggle')).toBeNull()
      expect(personal.find('team-chat-line')).toBeNull()
    } finally { await personal.unmount() }
  })

  test('the first message with "Only me" makes a private chat; the next new chat starts shared again', async () => {
    useSession.setState({ status: { kind: 'signed-in', me: meAs() } } as never)
    let sends: unknown[] = []
    const realSend = useChats.getState().send
    useChats.setState({ send: (async (o: unknown) => { sends.push(o); return { chatId: 'x', sent: Promise.resolve() } }) as never })
    const m = await mount(<MemoryRouter><NewChatComposer projectId={P1} project={project()} aiLine={false} /></MemoryRouter>)
    try {
      await m.click('only-me-toggle')
      await m.type('composer-input', 'Summarise my Gmail')
      await m.click('send')
      await m.until(() => sends.length > 0, 'the send', 2000)
      expect(sends[0]).toMatchObject({ projectId: P1, private: true, content: 'Summarise my Gmail' })
      expect(m.get('only-me-toggle').getAttribute('aria-pressed')).toBe('false')
      sends = []
      await m.type('composer-input', 'For everyone')
      await m.click('send')
      await m.until(() => sends.length > 0, 'the second send', 2000)
      expect((sends[0] as { private?: boolean }).private).toBeUndefined()
    } finally { await m.unmount(); useChats.setState({ send: realSend }) }
  })

  test('"Continue in a chat only you see" starts the box "Only me" with the question in it', async () => {
    useSession.setState({ status: { kind: 'signed-in', me: meAs() } } as never)
    const m = await mount(<MemoryRouter><NewChatComposer projectId={P1} project={project()} aiLine={false} startPrivate initialText="Check my calendar" resetKey={7} /></MemoryRouter>)
    try {
      expect(m.get('only-me-toggle').getAttribute('aria-pressed')).toBe('true')
      expect((m.get('composer-input') as unknown as { value: string }).value).toBe('Check my calendar')
    } finally { await m.unmount() }
  })

  test('a draft chat made shared for attachments: the switch shows it; "Continue privately" drops it and sends to a new private chat (review M1)', async () => {
    useSession.setState({ status: { kind: 'signed-in', me: meAs() } } as never)
    const draft = `project:${P1}`
    const shared = '01900000-0000-7000-8000-0000000000d1'
    // attached in the box, then left: the box's chat was made shared
    await draftChat('alice', draft, async () => shared)
    rememberDraftShared('alice', draft, true)
    const sends: { chatId: string | null; private?: boolean }[] = []
    const realSend = useChats.getState().send
    useChats.setState({ send: (async (o: { chatId: string | null; private?: boolean }) => { sends.push(o); return { chatId: 'x', sent: Promise.resolve() } }) as never })
    try {
      // back on the page: the switch says what that chat is (shared) and cannot change it
      const plain = await mount(<MemoryRouter><NewChatComposer projectId={P1} project={project()} aiLine={false} /></MemoryRouter>)
      expect(plain.get('only-me-toggle').getAttribute('aria-pressed')).toBe('false')
      expect(plain.get('only-me-toggle').hasAttribute('disabled')).toBe(true)
      await plain.unmount()
      // "Continue in a chat only you see": the shared draft (and its chips) go; the question goes to a new private chat
      const m = await mount(<MemoryRouter><NewChatComposer projectId={P1} project={project()} aiLine={false} startPrivate initialText="My Gmail please" resetKey={3} /></MemoryRouter>)
      expect(draftChatIfAny('alice', draft)).toBeNull()
      expect(m.get('only-me-toggle').getAttribute('aria-pressed')).toBe('true')
      expect(m.get('only-me-toggle').hasAttribute('disabled')).toBe(false)
      await m.click('send')
      await m.until(() => sends.length > 0, 'the send', 2000)
      expect(sends[0]).toMatchObject({ chatId: null, private: true })
      await m.unmount()
    } finally { useChats.setState({ send: realSend }) }
  })

  test('a draft dropped while its chat was still being made is not written back (re-review L1)', async () => {
    let resolve: (id: string) => void = () => {}
    const made = draftChat('alice', 'project:late', () => new Promise<string>((r) => { resolve = r }))
    expect(isDraftChat('alice', 'project:late', made)).toBe(true)
    dropDraft('alice', 'project:late')
    resolve('01900000-0000-7000-8000-0000000000f9')
    await made
    expect(isDraftChat('alice', 'project:late', made)).toBe(false)
    expect(draftChatIfAny('alice', 'project:late')).toBeNull()
  })

  test("a project's box sends nothing before the project is known (Home's ?project=, review S3)", async () => {
    useSession.setState({ status: { kind: 'signed-in', me: meAs() } } as never)
    const m = await mount(<MemoryRouter><NewChatComposer projectId={P1} project={null} aiLine={false} initialText="hello" /></MemoryRouter>)
    try {
      expect(m.get('send').hasAttribute('disabled')).toBe(true)
      expect(m.find('only-me-toggle')).toBeNull()
    } finally { await m.unmount() }
    const ready = await mount(<MemoryRouter><NewChatComposer projectId={P1} project={project()} aiLine={false} initialText="hello" /></MemoryRouter>)
    try { expect(ready.get('send').hasAttribute('disabled')).toBe(false) } finally { await ready.unmount() }
  })

  test('safe operations: why new chats are only mine, no switch', async () => {
    useSession.setState({ status: { kind: 'signed-in', me: meAs(true) } } as never)
    const m = await mount(<MemoryRouter><NewChatComposer projectId={P1} project={project()} aiLine={false} /></MemoryRouter>)
    try {
      expect(m.get('who-sees').textContent).toBe(en('projects.newChatSafeOps'))
      expect(m.find('only-me-toggle')).toBeNull()
    } finally { await m.unmount() }
  })
})

describe('a private chat in a team project', () => {
  test('may be shared by its creator whatever the old setting said; never a shared, personal or trashed one', () => {
    expect(isTeamProject(project())).toBe(true)
    expect(isTeamProject(project({ folderPath: 'users/alice/projects/notes' }))).toBe(false)
    expect(mayShareChat(chat(), project({ shareChats: false }), false)).toBe(true)
    expect(mayShareChat(chat({ shared: { by: { id: 'alice', name: 'Alice' } } as never }), project(), false)).toBe(false)
    expect(mayShareChat(chat(), project({ folderPath: 'users/alice/projects/notes' }), false)).toBe(false)
    expect(mayShareChat(chat(), project({ inTrash: true }), false)).toBe(false)
    expect(mayShareChat(chat(), project(), true)).toBe(false)
    expect(privateInTeamProject(chat(), project())).toBe(true)
    // a room's side chat: never moved into a project, never shared (QA TC-1010)
    const side = chat({ projectId: null, sideRoomId: '01900000-0000-7000-8000-0000000000e1' } as Partial<Chat>)
    expect(sharedRights(side, 'alice').canMove).toBe(false)
    expect(sharedRights(chat({ projectId: null }), 'alice').canMove).toBe(true)
    expect(mayShareChat({ ...chat(), sideRoomId: '01900000-0000-7000-8000-0000000000e1' } as Chat, project(), false)).toBe(false)
  })

  test('its copied link says nobody else can open it, with Share with members; a personal chat keeps the old toast', async () => {
    useSession.setState({ status: { kind: 'signed-in', me: meAs() } } as never)
    useProjects.getState().put(project())
    Object.defineProperty(globalThis.navigator, 'clipboard', { value: { writeText: async () => {} }, configurable: true })
    let copy: ((c: Chat) => Promise<void>) | null = null
    function Grab() { copy = useCopyChatLink(); return null }
    const m = await mount(<Grab />)
    try {
      await copy!(chat())
      const t = useUi.getState().toasts.at(-1)!
      expect([t.text, t.action?.label]).toEqual([en('chat.linkCopiedOnlyMe'), en('chat.linkShareAction')])
      await copy!(chat({ projectId: null }))
      expect([useUi.getState().toasts.at(-1)!.text, useUi.getState().toasts.at(-1)!.action]).toEqual([en('chat.linkCopiedPrivate'), undefined])
    } finally { await m.unmount() }
  })
})
