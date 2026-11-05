// A new member's arrival with the lead's files (docs/DECISIONS.md "M — One meeting note, everyone's own tasks"):
// - the join page holds the link's starter for the new account (lib/starter.ts: this tab, per person, a reload keeps
//   it, blocked storage still works for the page) and goes Home instead of a skill form;
// - Home then shows one line ("김하나님이 이번 주 팀 회의록 2개를 올려 뒀어요"), the box filled with "/meeting-tasks 내 할
//   일 정리해 줘" and the files attached once, who sees the chat under it, and nothing else; sending clears it;
// - the owner who ended the welcome steps without files gets one line pointing at the team's folder.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { uuidv7, type Attachment, type JoinStarter } from '@mycel/shared/api'
import { useLocaleStore } from '../../src/i18n'
import Home from '../../src/pages/Home'
import { TeamJoin } from '../../src/pages/Auth'
import { clearStarter, forgetStarters, heldStarter, holdStarter, markStarterAttached, starterAttached } from '../../src/lib/starter'
import { forgetTeamAttach } from '../../src/lib/teamAttach'
import { useAiAccess } from '../../src/store/aiAccess'
import { useChats } from '../../src/store/chats'
import { useSession } from '../../src/store/session'
import { useWelcome } from '../../src/store/welcome'
import { installDom, mount, removeDom, type Mounted } from './dom-host'

const CHAT = '01900000-0000-7000-8000-0000000000c7'
const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde'
const FILES = ['groups/Acme/회의록/11월 1주 회의.md', 'groups/Acme/회의록/11월 2주 회의.md']
const STARTER: JoinStarter = {
  kind: 'tasks', skill: { path: 'skills/general/meeting-tasks/SKILL.md', name: 'meeting-tasks', title: '할 일 정리' },
  files: FILES.map((path) => ({ path, name: path.split('/').at(-1)! })), by: '김하나',
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const meOf = (id: string, name: string, role: 'owner' | 'member') => ({
  user: { id, username: id, name, email: null, role, locale: 'ko', localeChoice: null, mustChangePassword: false, prefs: {} },
  groups: [], team: { name: 'Acme', defaultLocale: 'ko' },
  session: { id: '01900000-0000-7000-8000-00000000000a', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' }, server: { version: '0', dev: true },
})

let calls: { key: string; body: any }[] = []
const routes: Record<string, (body: any) => Response> = {
  'GET /api/me/ai-access': () => json(200, { usable: true, action: 'ask_owner', requested: false }),
  'GET /api/skills': () => json(200, { items: [] }),
  'GET /api/questions/frequent': () => json(200, { items: [] }),
  'GET /api/skills/popular': () => json(200, { items: [] }),
  'GET /api/onboarding/welcome': () => json(200, { progress: null }),
  'GET /api/onboarding/goal': () => json(200, { goal: null }),
  'POST /api/chats': () => json(201, { id: CHAT, projectId: null, title: '', engine: 'claude-code', model: null, createdAt: '2026-11-04T00:00:00.000Z', updatedAt: '2026-11-04T00:00:00.000Z', deletedAt: null, runState: 'idle' }),
  'POST /api/attachments/team-file': (b) => json(201, { id: uuidv7(), name: b.path.slice(b.path.lastIndexOf('/') + 1), path: b.path, size: 10, mime: 'text/markdown', kind: 'text', source: 'team' } satisfies Attachment),
}
const called = (key: string) => calls.filter((c) => c.key === key)

const realFetch = globalThis.fetch
const before = { locale: useLocaleStore.getState().locale, status: useSession.getState().status, signedIn: useSession.getState().signedIn }
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'ko' })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input).split('?')[0]}`
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({ key, body })
    return routes[key]?.(body) ?? json(404, { error: { code: 'not_found', message: `no route ${key}` } })
  }) as unknown as typeof fetch
})
afterEach(() => {
  calls = []
  forgetStarters()
  forgetTeamAttach()
  sessionStorage.clear()
  // the box's draft is kept per person (a draft left by a test before would fill it)
  localStorage.clear()
  useChats.getState().reset()
  useAiAccess.getState().reset()
  useWelcome.getState().reset()
})
afterAll(() => {
  globalThis.fetch = realFetch
  removeDom()
  useLocaleStore.setState({ locale: before.locale })
  useSession.setState({ status: before.status, signedIn: before.signedIn })
})

function Where() { const l = useLocation(); return <p data-testid="where">{l.pathname}</p> }
const home = (entry: string | { pathname: string; state: unknown } = '/') => mount(
  <MemoryRouter initialEntries={[entry]}>
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="*" element={<Where />} />
    </Routes>
  </MemoryRouter>,
)
const value = (m: Mounted, id: string) => (m.get(id) as unknown as { value: string }).value

describe('holding the starter', () => {
  test('per person, in this tab: read back, marked attached once, cleared; a stored copy is checked before use', () => {
    holdStarter('minji', STARTER)
    expect(heldStarter('minji')).toEqual(STARTER)
    expect(heldStarter('jihun')).toBeNull()
    expect(starterAttached('minji')).toBe(false)
    markStarterAttached('minji')
    expect(starterAttached('minji')).toBe(true)
    expect(JSON.parse(sessionStorage.getItem('mycel.starter:minji')!)).toEqual({ starter: STARTER, attached: true })
    clearStarter('minji')
    expect(heldStarter('minji')).toBeNull()
    expect(sessionStorage.getItem('mycel.starter:minji')).toBeNull()
    // after a reload only the tab's copy is there: read when it is a starter, ignored when it is not
    sessionStorage.setItem('mycel.starter:jihun', JSON.stringify({ starter: STARTER, attached: false }))
    expect(heldStarter('jihun')).toEqual(STARTER)
    sessionStorage.setItem('mycel.starter:olga', JSON.stringify({ starter: { kind: 'tasks', files: [] } }))
    expect(heldStarter('olga')).toBeNull()
    sessionStorage.setItem('mycel.starter:sam', '{not json')
    expect(heldStarter('sam')).toBeNull()
    // signing out forgets every one
    holdStarter('minji', STARTER)
    forgetStarters()
    expect(heldStarter('minji')).toBeNull()
    expect(heldStarter('jihun')).toBeNull()
  })

  test('blocked storage: the page still has it', () => {
    const g = globalThis as Record<string, unknown>
    const was = Object.getOwnPropertyDescriptor(g, 'sessionStorage')
    Object.defineProperty(g, 'sessionStorage', { configurable: true, get() { throw new Error('blocked') } })
    try {
      holdStarter('minji', STARTER)
      expect(heldStarter('minji')).toEqual(STARTER)
      clearStarter('minji')
      expect(heldStarter('minji')).toBeNull()
    } finally {
      Object.defineProperty(g, 'sessionStorage', was!)
    }
  })

  test('the join page: a link with a starter holds it for the new account and goes Home, not to the skill form', async () => {
    const g = globalThis as Record<string, unknown>
    const was = { location: Object.getOwnPropertyDescriptor(g, 'location'), history: Object.getOwnPropertyDescriptor(g, 'history') }
    Object.defineProperty(g, 'location', { configurable: true, writable: true, value: { pathname: '/join', search: '', hash: `#t=${TOKEN}`, origin: 'https://acme.example', href: `https://acme.example/join#t=${TOKEN}` } })
    Object.defineProperty(g, 'history', { configurable: true, writable: true, value: { state: null, replaceState: () => {} } })
    routes['POST /api/team-link/info'] = () => json(200, { teamName: 'Acme', valid: true, problem: null, expiresAt: '2026-11-18T00:00:00.000Z', skillName: 'meeting-tasks' })
    routes['POST /api/team-link/join'] = () => json(201, { me: meOf('minji', '민지', 'member'), next: `/skills?run=${encodeURIComponent(STARTER.skill.path)}`, starter: STARTER })
    useSession.setState({ signedIn: () => {} } as never)
    const m = await mount(<MemoryRouter initialEntries={['/join']}><Routes><Route path="/join" element={<TeamJoin />} /><Route path="*" element={<Where />} /></Routes></MemoryRouter>)
    try {
      await m.until(() => m.find('join-form'), 'the join form')
      await m.type('invite-name', '민지')
      await m.type('invite-username', 'minji')
      await m.type('invite-password', 'tulip meadow 2026')
      await m.click('invite-submit')
      await m.until(() => m.find('where'), 'the next page')
      expect(m.get('where').textContent).toBe('/')
      expect(heldStarter('minji')).toEqual(STARTER)
    } finally {
      await m.unmount()
      delete routes['POST /api/team-link/info']
      delete routes['POST /api/team-link/join']
      for (const [k, d] of Object.entries(was)) { if (d) Object.defineProperty(g, k, d); else delete g[k] }
    }
  })
})

describe('Home on arrival', () => {
  test('one line, the box filled with the skill and the question, the files attached once, who sees the chat; nothing else; sent, it is gone', async () => {
    useSession.setState({ status: { kind: 'signed-in', me: meOf('minji', '민지', 'member') } } as never)
    holdStarter('minji', STARTER)
    const m = await home()
    try {
      await m.until(() => m.find('starter-line'), 'the line')
      expect(m.get('starter-line').textContent).toBe('김하나님이 이번 주 팀 회의록 2개를 올려 뒀어요')
      expect(value(m, 'composer-input')).toBe('/meeting-tasks 내 할 일 정리해 줘')
      expect(m.get('starter-private').textContent).toBe('이 채팅은 민지님만 봐요. 김하나님도 못 봐요.')
      await m.until(() => m.container.querySelectorAll('[data-testid="attachment-chip"]').length === 2 && starterAttached('minji'), 'the files in the box')
      expect(called('POST /api/attachments/team-file').map((c) => c.body)).toEqual(FILES.map((path) => ({ chatId: CHAT, path })))
      // nothing else on Home: no first-time folders and examples, no frequent questions or skills
      for (const gone of ['first-time-folders', 'example', 'frequent-questions', 'popular-skills']) expect({ gone, there: !!m.find(gone) }).toEqual({ gone, there: false })
      expect(called('GET /api/questions/frequent')).toEqual([])
      expect(called('GET /api/skills/popular')).toEqual([])
      // the box's own send button is the one action
      await m.until(() => !m.get('send').hasAttribute('disabled'), 'send on')
      await m.click('send')
      await m.until(() => m.find('where'), 'the chat')
      expect(m.get('where').textContent).toBe(`/c/${CHAT}`)
      const sent = called(`POST /api/chats/${CHAT}/messages`)[0]?.body as { content: string; attachmentIds: string[] } | undefined
      expect(sent?.content).toBe('/meeting-tasks 내 할 일 정리해 줘')
      expect(sent?.attachmentIds).toHaveLength(2)
      expect(heldStarter('minji')).toBeNull()
    } finally { await m.unmount() }
  })

  test('a brief without a known sender; shown again, the files are not attached twice', async () => {
    useSession.setState({ status: { kind: 'signed-in', me: meOf('minji', '민지', 'member') } } as never)
    holdStarter('minji', { ...STARTER, kind: 'brief', skill: { path: 'skills/general/doc-brief/SKILL.md', name: 'doc-brief', title: '핵심 정리' }, files: STARTER.files.slice(0, 1), by: null })
    let m = await home()
    try {
      await m.until(() => m.find('starter-line'), 'the line')
      expect(m.get('starter-line').textContent).toBe('팀 자료 1개가 올라와 있어요')
      expect(value(m, 'composer-input')).toBe('/doc-brief 내가 알아야 할 것만 알려 줘')
      expect(m.get('starter-private').textContent).toBe('이 채팅은 민지님만 봐요.')
      await m.until(() => starterAttached('minji'), 'attached')
    } finally { await m.unmount() }
    m = await home()
    try {
      await m.until(() => m.find('starter-line'), 'the line again')
      await m.settle(30)
      expect(called('POST /api/attachments/team-file')).toHaveLength(1)
    } finally { await m.unmount() }
  })

  test('no starter: the usual Home', async () => {
    useSession.setState({ status: { kind: 'signed-in', me: meOf('minji', '민지', 'member') } } as never)
    const m = await home()
    try {
      await m.until(() => called('GET /api/questions/frequent').length, 'the usual Home')
      expect(m.find('starter-line')).toBeNull()
      expect(m.find('starter-private')).toBeNull()
      expect(value(m, 'composer-input')).toBe('')
    } finally { await m.unmount() }
  })

  test('the owner after "자료 없이 해 볼게요": one line, the team\'s folder a link to the file screen', async () => {
    useSession.setState({ status: { kind: 'signed-in', me: meOf('olga', '올가', 'owner') } } as never)
    const m = await home({ pathname: '/', state: { welcomeNotes: { folder: 'groups/Acme', team: 'Acme' } } })
    try {
      await m.until(() => m.find('welcome-notes-line'), 'the line')
      expect(m.get('welcome-notes-line').textContent).toBe('회의록이 생기면 Acme 폴더에 놓아 주세요')
      expect(m.get('welcome-notes-folder').getAttribute('href')).toBe('/files?path=groups%2FAcme')
    } finally { await m.unmount() }
  })
})
