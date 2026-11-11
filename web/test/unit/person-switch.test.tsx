// Another person signs in over a signed-in one in the same window (docs/DECISIONS.md "Another person signs in over a
// session"): a shared computer, Acme's Ana is signed in and Ben completes his own password reset link in her tab. Ben must
// see nothing of Ana's: her stores are emptied, her live connection closes, his opens, and the page loads again.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import type { Chat, Me } from '@mycel/shared/api'
import { useLocaleStore } from '../../src/i18n'
import { personSwitch, useSessionLifecycle } from '../../src/App'
import { ResetPassword } from '../../src/pages/Auth'
import { useChats } from '../../src/store/chats'
import { useEngines } from '../../src/store/engines'
import { usePeople } from '../../src/store/people'
import { useProjects } from '../../src/store/projects'
import { useRooms } from '../../src/store/rooms'
import { useSideChats } from '../../src/store/sideChats'
import { useSession } from '../../src/store/session'
import { stopLive } from '../../src/store/live'
import { readDraft, writeDraft } from '../../src/lib/localData'
import { useEffect } from 'react'
import { installDom, mount, removeDom } from './dom-host'

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const meOf = (id: string, name: string, session: string): Me => ({
  user: { id, username: id, name, email: null, role: 'member', locale: 'en', localeChoice: 'en', mustChangePassword: false, prefs: {} },
  groups: [], team: { name: 'Acme', defaultLocale: 'en' },
  session: { id: session, client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' }, server: { version: '0', dev: true },
}) as unknown as Me
const ANA = meOf('ana', 'Ana', '01900000-0000-7000-8000-0000000000a2')
const BEN = meOf('ben', 'Ben', '01900000-0000-7000-8000-0000000000b2')
const ANA_CHAT = { id: '01900000-0000-7000-8000-0000000000c1', projectId: null, title: 'Ana: salary review', engine: 'claude-code', model: null, createdAt: '2026-11-03T00:00:00.000Z', updatedAt: '2026-11-03T00:00:00.000Z', deletedAt: null, runState: 'idle' } as unknown as Chat

/** the sockets the app opened, in order */
class FakeSocket {
  static made: FakeSocket[] = []
  readyState = 0
  closed = false
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: ((e: { code: number; reason: string }) => void) | null = null
  onerror: (() => void) | null = null
  constructor(public url: string) { FakeSocket.made.push(this) }
  send() {}
  close() { this.closed = true; this.readyState = 3 }
  addEventListener() {}
  removeEventListener() {}
}

let routes: Record<string, (init?: RequestInit) => Response | Promise<Response>> = {}
const realFetch = globalThis.fetch
const g = globalThis as Record<string, unknown>
const realSocket = g.WebSocket
const realReload = personSwitch.reload
const localeBefore = useLocaleStore.getState().locale
let reloads = 0
beforeAll(() => {
  installDom()
  // signing in applies the account's theme and text size to the page (lib/theme.ts, lib/textSize.ts)
  const root = document.documentElement as unknown as Record<string, unknown>
  root.classList ??= { toggle() {}, add() {}, remove() {}, contains: () => false }
  useLocaleStore.setState({ locale: 'en' })
  g.WebSocket = FakeSocket
  g.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })
  g.location = { protocol: 'http:', host: 'acme.test', hostname: 'acme.test', origin: 'http://acme.test', pathname: '/', search: '', hash: '', href: 'http://acme.test/' }
  personSwitch.reload = () => { reloads++ }
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input).split('?')[0]}`
    return routes[key]?.(init) ?? json(404, { error: { code: 'not_found', message: `no route ${key}` } })
  }) as unknown as typeof fetch
})
afterAll(() => {
  stopLive()
  globalThis.fetch = realFetch
  g.WebSocket = realSocket
  personSwitch.reload = realReload
  removeDom()
  useLocaleStore.setState({ locale: localeBefore })
  useSession.setState({ status: { kind: 'loading' } })
})
beforeEach(() => {
  stopLive()
  FakeSocket.made = []
  reloads = 0
})

/** Ana's window as it is after she used the app for a while */
function anaWorked() {
  useChats.getState().upsertChat(ANA_CHAT)
  useProjects.getState().put({ id: '01900000-0000-7000-8000-0000000000d1', name: 'Ana private', folderPath: 'users/ana/p', instructions: '', createdBy: null, createdAt: '2026-11-03T00:00:00.000Z', canEdit: true } as never)
  useRooms.setState({ rooms: [{ id: 'r1', name: 'Ana and HR' }] as never, loaded: true })
  useSideChats.setState({ byRoom: { r1: [ANA_CHAT] } as never })
  usePeople.setState({ people: [{ id: ANA.user.id, name: 'Ana' }] as never, loaded: true })
  useEngines.setState({ loaded: true, canChoose: true, engines: ['claude-code'], models: { 'claude-code': [{ id: 'acme-model', label: 'Acme model' }] } })
}

function nothingOfAna() {
  expect(useChats.getState().chats.some((c) => c.id === ANA_CHAT.id)).toBe(false)
  expect(Object.keys(useProjects.getState().byId)).toEqual([])
  expect(useRooms.getState().rooms).toEqual([])
  expect(useSideChats.getState().byRoom).toEqual({})
  expect(usePeople.getState().people).toBeNull()
  expect(useEngines.getState()).toMatchObject({ loaded: false, canChoose: false, engines: [], models: {} })
}

describe('another person signs in over a signed-in one', () => {
  test('a reset link completed by Ben in Ana\'s tab: nothing of Ana stays, her socket closes, his opens, the page reloads', async () => {
    useSession.setState({ status: { kind: 'signed-in', me: ANA } })
    let completed = 0
    routes = {
      'GET /api/password-resets/tok-ben': () => json(200, { valid: true, username: 'ben', name: 'Ben', expiresAt: '2026-11-12T00:00:00.000Z' }),
      'POST /api/password-resets/tok-ben': () => { completed++; return json(200, { me: BEN }) },
    }
    // as in Gate: the hook in the parent, so the new person's screens run their effects before it does
    function Session({ children }: { children: React.ReactNode }) { useSessionLifecycle(); return <>{children}</> }
    let seenOnMount = null as string[] | null
    function Home() {
      useEffect(() => { seenOnMount = useChats.getState().chats.map((c) => c.title) }, [])
      return <p data-testid="home">home</p>
    }
    const m = await mount(
      <MemoryRouter initialEntries={['/reset-password/tok-ben']}>
        <Session>
          <Routes>
            <Route path="/reset-password/:token" element={<ResetPassword />} />
            <Route path="/" element={<Home />} />
          </Routes>
        </Session>
      </MemoryRouter>,
    )
    await m.until(() => FakeSocket.made.length === 1, 'Ana\'s live connection', 2000)
    const anaSocket = FakeSocket.made[0]!
    anaWorked()
    writeDraft(ANA.user.id, ANA_CHAT.id, 'Ana: draft about the salary review')
    await m.until(() => m.find('reset-password'), 'the reset form', 2000)
    await m.type('reset-password', 'acme-new-pass-1')
    await m.type('reset-password2', 'acme-new-pass-1')
    await m.click('reset-submit')
    await m.until(() => m.find('home'), 'Home after the reset', 2000)
    await m.until(() => reloads === 1, 'the page to load again', 2000)
    expect(completed).toBe(1)
    // emptied before Ben's first screen mounted, and this browser's drafts went as at a sign-out
    expect(seenOnMount).toEqual([])
    expect(readDraft(ANA.user.id, ANA_CHAT.id)).toBe('')
    expect(useSession.getState().status).toMatchObject({ kind: 'signed-in', me: { user: { id: BEN.user.id } } })
    nothingOfAna()
    expect(anaSocket.closed).toBe(true)
    // Ben's own connection (the session cookie is his now)
    expect(FakeSocket.made.length).toBe(2)
    expect(FakeSocket.made[1]!.closed).toBe(false)
    await m.unmount()
    stopLive()
  })

  test('the same person signed in again (a new session of their own) is no switch: no reload, the stores stay', async () => {
    useSession.setState({ status: { kind: 'signed-in', me: ANA } })
    function Session() { useSessionLifecycle(); return null }
    const m = await mount(<Session />)
    await m.until(() => FakeSocket.made.length === 1, 'the live connection', 2000)
    anaWorked()
    useSession.setState({ status: { kind: 'signed-in', me: { ...ANA, session: { ...ANA.session, id: '01900000-0000-7000-8000-0000000000a3' } } } })
    await m.settle(100)
    expect(reloads).toBe(0)
    expect(useChats.getState().chats.some((c) => c.id === ANA_CHAT.id)).toBe(true)
    expect(FakeSocket.made.length).toBe(1)
    await m.unmount()
    stopLive()
  })

  test('signing out also forgets the AI picker\'s list and the room side chats', async () => {
    useSession.setState({ status: { kind: 'signed-in', me: ANA } })
    function Session() { useSessionLifecycle(); return null }
    const m = await mount(<Session />)
    anaWorked()
    useSession.getState().signedOut()
    await m.until(() => useEngines.getState().engines.length === 0, 'the picker emptied', 2000)
    nothingOfAna()
    expect(reloads).toBe(0)
    await m.unmount()
  })
})

describe('the AI picker\'s list', () => {
  test('a failed read is asked again by the next load; an answer to a request from before a reset is dropped', async () => {
    useEngines.getState().reset()
    let asked = 0
    let answer: (r: Response) => void = () => {}
    routes = { 'GET /api/engines': () => { asked++; return json(500, { error: { code: 'internal', message: 'x' } }) } }
    await useEngines.getState().load()
    expect(useEngines.getState()).toMatchObject({ loaded: true, engines: [] })
    const ok = { canChoose: true, defaultEngine: 'claude-code', defaultModel: null, engines: [{ id: 'claude-code', label: 'Claude', models: [{ id: 'acme-model', label: 'Acme model' }] }] }
    routes = { 'GET /api/engines': () => { asked++; return json(200, ok) } }
    await useEngines.getState().load()
    expect(asked).toBe(2)
    expect(useEngines.getState().engines).toEqual(['claude-code'])
    await useEngines.getState().load() // answered: not asked again
    expect(asked).toBe(2)
    // a slow answer for the last person, arriving after the reset
    useEngines.getState().reset()
    routes = { 'GET /api/engines': () => new Promise<Response>((r) => { answer = r }) }
    const late = useEngines.getState().load()
    useEngines.getState().reset()
    answer(json(200, ok))
    await late
    expect(useEngines.getState()).toMatchObject({ loaded: false, engines: [] })
  })
})
