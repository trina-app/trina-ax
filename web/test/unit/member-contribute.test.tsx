// Members contribute (docs/DECISIONS.md "MC"; components/onboarding/ResultSuggestion.tsx, components/skills/
// ContributeSheet.tsx, pages/Skills.tsx, components/settings/Notifications.tsx, components/AvailableSkills.tsx):
//   - the `contribute` line under the member's first good run: [올리기] opens the skill folder pick on a computer, with
//     the team folder's link only when the server named one; ✕ closes it for good; on a phone the line is the team
//     folder only (asked with phone=1), and nothing without one;
//   - the pick: a skill with a key stays in the browser (shown as left out, its key never in what goes up); nothing is
//     ticked first; at most 10, fewer near the 20 waiting; "팀장이 내용을 보고 정해요" before [팀에 제안 · N개]; what the
//     server did not take, with its reason; CLAUDE.md and tools never go;
//   - Skills › 검토 groups by person; a skill folder is reviewed and approved as skills/<folder name>/ (the body);
//     ?batch= opens 검토;
//   - the Inbox line of a batch ("Bob Lee 님이 스킬 2개를 팀에 올리자고 했어요 · 확인") and the saved skill's "님이 제안".
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { act } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import type { ContributedSkills, InboxNotification, ResultSuggestion as Suggestion, SkillSuggestion } from '@mycel/shared/api'
import { translate, useLocaleStore, type MessageKey } from '../../src/i18n'
import { ResultSuggestion } from '../../src/components/onboarding/ResultSuggestion'
import { skillHead } from '../../src/components/skills/ContributeSheet'
import { AvailableSkillsList } from '../../src/components/AvailableSkills'
import { Notifications, skillsLink } from '../../src/components/settings/Notifications'
import Skills, { byPerson } from '../../src/pages/Skills'
import { useSession } from '../../src/store/session'
import type { ViewMessage } from '../../src/store/thread'
import type { DirectoryHandleLike } from '../../src/lib/skillScan'
import { installDom, mount, removeDom, type FakeElement, type Mounted } from './dom-host'

const ko = (k: MessageKey, p?: Record<string, string | number>) => translate('ko', k, p)
const json = (status: number, body: unknown) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const CHAT = '01900000-0000-7000-8000-0000000000c1'
const ASK = '01900000-0000-7000-8000-0000000000a1'
const ANSWER = '01900000-0000-7000-8000-0000000000a2'
const BATCH = '01900000-0000-7000-8000-0000000000b1'
// fake keys, obviously not real, that still match shared/src/secrets.ts
const SLACK = 'xoxb-0000000000-FAKE-NOT-REAL'
const OPENAI = 'sk-FAKE0000notreal0000KEY1234'

const msg = (id: string, role: 'user' | 'assistant', content: string): ViewMessage => ({
  id, chatId: CHAT, parentId: role === 'assistant' ? ASK : null, role, author: null, content, attachments: [], steps: [], status: 'done', error: null, turnId: null,
  engine: null, model: null, files: null, usage: null, createdAt: '2026-11-07T00:00:00.000Z', branch: { index: 0, count: 1, siblingIds: [id] },
})
const thread = () => [msg(ASK, 'user', '/meeting-tasks 이번 주 회의록'), msg(ANSWER, 'assistant', '민준: 견적서 보내기')]
const meOf = (role: 'owner' | 'admin' | 'member') => ({ user: { id: role === 'member' ? 'bob' : 'dana', username: role, name: role === 'member' ? '민준' : '대표', role, locale: 'ko', prefs: {} }, groups: [], team: { name: 'Acme', defaultLocale: 'ko' } })
const signIn = (role: 'owner' | 'admin' | 'member') => useSession.setState({ status: { kind: 'signed-in', me: meOf(role) } } as never)

type Tree = { [name: string]: Tree | string }
const dirHandle = (name: string, tree: Tree): DirectoryHandleLike => ({
  kind: 'directory', name,
  async getDirectoryHandle(n) { const v = tree[n]; if (v && typeof v === 'object') return dirHandle(n, v); throw Object.assign(new Error('nf'), { name: 'NotFoundError' }) },
  async getFileHandle(n) { const v = tree[n]; if (typeof v === 'string') return { name: n, getFile: async () => new File([v], n) }; throw Object.assign(new Error('nf'), { name: 'NotFoundError' }) },
  async *entries() { for (const [k, v] of Object.entries(tree)) yield [k, { kind: typeof v === 'string' ? 'file' : 'directory' }] as [string, { kind: 'file' | 'directory' }] },
})
const skillMd = (name: string, title?: string) => `---\nname: ${name}\ndescription: ${name} — 팀 노트를 읽고 정리해요\n${title ? `metadata:\n  title: ${title}\n` : ''}---\n# ${name}\n1. 노트를 읽어요.\n`
const CLAUDE: Tree = {
  'CLAUDE.md': `- 보고서는 결론부터 써요\nOPENAI_API_KEY=${OPENAI}\n`,
  '.credentials.json': '{"accessToken":"never-read"}',
  skills: {
    'quote-maker': { 'SKILL.md': skillMd('quote-maker', '견적 만들기'), 'quote.md': '| 품목 | 가격 |\n' },
    'weekly-report': { 'SKILL.md': skillMd('weekly-report') },
    'slack-notify': { 'SKILL.md': `---\nname: slack-notify\ndescription: 슬랙 알림\n---\ntoken: ${SLACK}\n` },
    ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`extra-${i}`, { 'SKILL.md': skillMd(`extra-${i}`) }])),
  },
}

let suggestion: Suggestion | null = null
let myPending = 0
let contributed: ContributedSkills | null = null
let review: SkillSuggestion[] = []
let inbox: InboxNotification[] = []
let calls: { key: string; url: string; body: any }[] = []
const called = (key: string) => calls.filter((c) => c.key === key)
function route(method: string, path: string, body: any): Response {
  const key = `${method} ${path}`
  if (key === 'GET /api/onboarding/suggestion') return json(200, { suggestion })
  if (key === 'POST /api/onboarding/suggestion/dismiss') return json(204, null)
  if (key === 'GET /api/skills/overview') return json(200, { managedFolders: review.length ? ['skills'] : [], suggestFolders: ['skills'], pendingReview: review.filter((s) => s.status === 'pending').length, myPending })
  if (key === 'POST /api/skills/suggestions/batch') return json(201, contributed ?? { batchId: BATCH, items: body.skills.map((s: { name: string }) => folderSuggestion(s.name)), refused: [] })
  if (key === 'GET /api/skills/suggestions') return json(200, { items: path && calls.at(-1)!.url.includes('scope=review') ? review : [], nextCursor: null })
  if (key === 'GET /api/admin/skill-changes') return json(200, { items: [], nextCursor: null })
  if (key === 'GET /api/skills') return json(200, { items: [] })
  if (key === 'GET /api/skills/issues') return json(200, { items: [] })
  if (key === 'GET /api/skills/popular') return json(200, { items: [], days: 30 })
  if (key === 'GET /api/notifications') return json(200, { items: inbox, nextCursor: null, unreadCount: inbox.length })
  if (key === 'GET /api/notification-preferences') return json(200, { scheduleSuccess: true, scheduleFailure: true, connectionReconnect: true, skillSuggestions: true })
  const one = /^\/api\/skills\/suggestions\/([^/]+)$/.exec(path)
  if (method === 'GET' && one) {
    const s = review.find((x) => x.id === one[1])
    return s ? json(200, { ...s, folder: s.folder && { ...s.folder, files: s.folder.files.map((f) => (f.path === 'quote.md' ? { ...f, text: '| 품목 | 가격 |' } : f)) } }) : json(404, { error: { code: 'not_found', message: 'x' } })
  }
  const approve = /^\/api\/skills\/suggestions\/([^/]+)\/approve$/.exec(path)
  if (method === 'POST' && approve) {
    const s = review.find((x) => x.id === approve[1])!
    return json(200, { ...s, status: 'approved', resultPath: `${body.targetFolder}/${body.name}/SKILL.md`, reviewer: { id: 'dana', name: '대표' } })
  }
  return json(404, { error: { code: 'not_found', message: key } })
}
function folderSuggestion(name: string, o: Partial<SkillSuggestion> = {}): SkillSuggestion {
  return {
    id: `01900000-0000-7000-8000-${String(Math.abs([...name].reduce((a, c) => a * 31 + c.charCodeAt(0), 7)) % 1e12).padStart(12, '0')}`,
    status: 'pending', targetFolder: 'skills', name, description: `${name} — 팀 노트를 읽고 정리해요`, content: `# ${name}\n1. 노트를 읽어요.\n`,
    source: { kind: 'folder', path: null }, suggester: { id: 'bob', name: '민준' }, reviewer: null, reviewNote: null, resultPath: null,
    createdAt: '2026-11-07T00:00:00.000Z', reviewedAt: null, canReview: true, batchId: BATCH,
    folder: { app: 'claude', title: null, files: [{ path: 'SKILL.md', bytes: 120 }], scriptsDropped: 0, personalPath: false, sameName: null }, ...o,
  }
}

const g = globalThis as Record<string, unknown>
const realFetch = globalThis.fetch
const localeBefore = useLocaleStore.getState().locale
const sessionBefore = useSession.getState().status
const phoneWidth = () => { g.matchMedia = (q: string) => ({ matches: q.includes('767.98'), addEventListener() {}, removeEventListener() {} }) }
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'ko' })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const path = url.split('?')[0]!
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({ key: `${method} ${path}`, url, body })
    return route(method, path, body)
  }) as unknown as typeof fetch
  Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' })
})
afterEach(() => {
  suggestion = null
  myPending = 0
  contributed = null
  review = []
  inbox = []
  calls = []
  delete g.showDirectoryPicker
  g.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
})
afterAll(() => {
  globalThis.fetch = realFetch
  removeDom()
  useLocaleStore.setState({ locale: localeBefore })
  useSession.setState({ status: sessionBefore })
})

/** A click on a checkbox turns it over before its handlers run (the browser's own step, which the fake DOM leaves out). */
const tick = async (m: Mounted, box: FakeElement) => {
  const checked = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(box), 'checked')!
  checked.set!.call(box, !checked.get!.call(box))
  await m.click(box)
}
const isChecked = (box: FakeElement) => (box as unknown as { checked: boolean }).checked

function Where() { const l = useLocation(); return <p data-testid="where">{l.pathname}{l.search}</p> }
const line = () => (
  <MemoryRouter initialEntries={[`/c/${CHAT}`]}>
    <Routes>
      <Route path="*" element={<><ResultSuggestion chatId={CHAT} messages={thread()} busy={false} onSend={() => {}} /><Where /></>} />
    </Routes>
  </MemoryRouter>
)

describe('the contribute line', () => {
  test('a computer: the line, [올리기] opens the pick with the team folder\'s link; nothing closed for good', async () => {
    signIn('member')
    suggestion = { kind: 'contribute', key: 'contribute', folder: 'groups/Acme' }
    const m = await mount(line())
    try {
      await m.until(() => m.find('result-suggestion'), 'the line')
      expect(m.get('result-suggestion').getAttribute('data-kind')).toBe('contribute')
      expect(m.get('result-suggestion').textContent).toContain(ko('resultTip.contribute.text'))
      expect(m.get('result-suggestion-act').textContent).toBe(ko('resultTip.contribute.act'))
      expect(called('GET /api/onboarding/suggestion')[0]!.url).not.toContain('phone=')
      await m.click('result-suggestion-act')
      await m.until(() => m.find('contribute-sheet'), 'the sheet')
      expect(m.find('result-suggestion')).toBeNull()
      expect(m.get('contribute-sheet').getAttribute('data-state')).toBe('pick')
      expect(m.get('contribute-files').getAttribute('href')).toBe('/files?path=groups%2FAcme')
      expect(called('POST /api/onboarding/suggestion/dismiss')).toEqual([])
    } finally { await m.unmount() }
  })

  test('no team folder the member can write: no files part', async () => {
    signIn('member')
    suggestion = { kind: 'contribute', key: 'contribute', folder: null }
    const m = await mount(line())
    try {
      await m.until(() => m.find('result-suggestion'), 'the line')
      await m.click('result-suggestion-act')
      await m.until(() => m.find('contribute-sheet'), 'the sheet')
      expect(m.find('contribute-files')).toBeNull()
    } finally { await m.unmount() }
  })

  test('✕ closes it for good', async () => {
    signIn('member')
    suggestion = { kind: 'contribute', key: 'contribute', folder: null }
    const m = await mount(line())
    try {
      await m.until(() => m.find('result-suggestion'), 'the line')
      await m.click('result-suggestion-close')
      expect(m.find('result-suggestion')).toBeNull()
      await m.until(() => called('POST /api/onboarding/suggestion/dismiss').length, 'closed on the server')
      expect(called('POST /api/onboarding/suggestion/dismiss')[0]!.body).toEqual({ key: 'contribute' })
    } finally { await m.unmount() }
  })

  test('a phone: asked with phone=1; the team folder only, and nothing without one', async () => {
    signIn('member')
    phoneWidth()
    suggestion = { kind: 'contribute', key: 'contribute', folder: 'groups/Acme' }
    let m = await mount(line())
    try {
      await m.until(() => m.find('result-suggestion'), 'the line')
      expect(called('GET /api/onboarding/suggestion')[0]!.url).toContain('phone=1')
      expect(m.get('result-suggestion').textContent).toContain(ko('resultTip.contribute.textPhone'))
      expect(m.get('result-suggestion-act').textContent).toBe(ko('resultTip.contribute.actPhone'))
      await m.click('result-suggestion-act')
      expect(m.find('contribute-sheet')).toBeNull()
      expect(m.get('where').textContent).toBe('/files?path=groups%2FAcme')
    } finally { await m.unmount() }
    // an older server that sends the line anyway: nothing on a phone without a folder
    suggestion = { kind: 'contribute', key: 'contribute', folder: null }
    m = await mount(line())
    try {
      await m.until(() => called('GET /api/onboarding/suggestion').length >= 2, 'asked')
      await m.settle(50)
      expect(m.find('result-suggestion')).toBeNull()
    } finally { await m.unmount() }
  })
})

describe('the skill folder pick', () => {
  const open = async () => {
    signIn('member')
    suggestion = { kind: 'contribute', key: 'contribute', folder: 'groups/Acme' }
    g.showDirectoryPicker = async () => dirHandle('.claude', CLAUDE)
    const m = await mount(line())
    await m.until(() => m.find('result-suggestion'), 'the line')
    await m.click('result-suggestion-act')
    // the member's waiting count is in (the pick, or "full")
    await m.until(() => called('GET /api/skills/overview').length && (m.find('contribute-find') || m.find('contribute-full')), 'the pick')
    await m.settle()
    return m
  }

  test('a key stays in the browser: left out with its kind; nothing ticked first; the owner decides; what goes up has no key, no CLAUDE.md', async () => {
    const m = await open()
    try {
      await m.click('contribute-find')
      await m.until(() => m.find('contribute-list'), 'the list')
      const rows = [...m.container.ownerDocument!.body.querySelectorAll('[data-testid="contribute-row"]')].map((r) => r.getAttribute('data-name'))
      expect(rows).toContain('quote-maker')
      expect(rows).not.toContain('slack-notify')
      // the title the member reads; the left-out skill under its fold, with the kind of key
      expect(m.get('contribute-list').textContent).toContain('견적 만들기')
      expect(m.get('contribute-excluded-toggle').textContent).toContain(ko('welcome.skills.short.secret'))
      await m.click('contribute-excluded-toggle')
      expect(m.get('contribute-excluded').textContent).toContain('slack-notify')
      expect(m.get('contribute-excluded').textContent).toContain('Slack')
      // nothing ticked: the primary waits; the owner line is there before anything goes
      expect(m.get('contribute-send').hasAttribute('disabled')).toBe(true)
      expect(m.get('contribute-owner').textContent).toBe(ko('contribute.owner'))
      const checks = [...m.container.ownerDocument!.body.querySelectorAll('[data-testid="contribute-check"]')]
      await tick(m, checks[rows.indexOf('quote-maker')]!)
      await tick(m, checks[rows.indexOf('weekly-report')]!)
      expect(m.get('contribute-send').textContent).toBe(ko('contribute.send', { n: 2 }))
      await m.click('contribute-send')
      await m.until(() => m.find('contribute-sent'), 'sent')
      const sent = called('POST /api/skills/suggestions/batch')
      expect(sent).toHaveLength(1)
      expect(sent[0]!.body.skills.map((s: { name: string }) => s.name)).toEqual(['quote-maker', 'weekly-report'])
      const raw = JSON.stringify(sent[0]!.body)
      for (const k of [SLACK, OPENAI, 'never-read', '결론부터']) expect(raw).not.toContain(k)
      expect(Object.keys(sent[0]!.body).sort()).toEqual(['skills'])
      expect(m.get('contribute-sent').textContent).toContain(ko('contribute.sent', { n: 2 }))
      // another folder (Codex's): back to the pick
      await m.click('contribute-more')
      expect(m.get('contribute-sheet').getAttribute('data-state')).toBe('pick')
    } finally { await m.unmount() }
  })

  test('at most 10 ticked; fewer when the member\'s waiting suggestions are near 20; none at 20', async () => {
    let m = await open()
    try {
      await m.click('contribute-find')
      await m.until(() => m.find('contribute-list'), 'the list')
      const checks = () => [...m.container.ownerDocument!.body.querySelectorAll('[data-testid="contribute-check"]')]
      expect(checks()).toHaveLength(12)
      for (const c of checks()) if (!c.hasAttribute('disabled')) await tick(m, c)
      expect(checks().filter(isChecked)).toHaveLength(10)
      expect(checks().filter((c) => c.hasAttribute('disabled'))).toHaveLength(2)
      expect(m.get('contribute-send').textContent).toBe(ko('contribute.send', { n: 10 }))
      expect(m.get('contribute-list').textContent).toContain(ko('contribute.cap', { n: 10 }))
    } finally { await m.unmount() }
    myPending = 17
    m = await open()
    try {
      await m.until(() => called('GET /api/skills/overview').length, 'the count')
      await m.click('contribute-find')
      await m.until(() => m.find('contribute-list'), 'the list')
      const checks = () => [...m.container.ownerDocument!.body.querySelectorAll('[data-testid="contribute-check"]')]
      for (const c of checks()) if (!c.hasAttribute('disabled')) await tick(m, c)
      expect(checks().filter(isChecked)).toHaveLength(3)
    } finally { await m.unmount() }
    myPending = 20
    m = await open()
    try {
      await m.until(() => m.find('contribute-full'), 'full')
      expect(m.find('contribute-find')).toBeNull()
    } finally { await m.unmount() }
  })

  test('two skills of one name in a folder are two rows: ticking one sends that one', async () => {
    signIn('member')
    suggestion = { kind: 'contribute', key: 'contribute', folder: null }
    g.showDirectoryPicker = async () => dirHandle('.claude', { skills: { review: { 'SKILL.md': skillMd('review') } }, commands: { 'review.md': '# Review a diff\n1. Read it.\n' } })
    const m = await mount(line())
    try {
      await m.until(() => m.find('result-suggestion'), 'the line')
      await m.click('result-suggestion-act')
      await m.until(() => called('GET /api/skills/overview').length && m.find('contribute-find'), 'the pick')
      await m.settle()
      await m.click('contribute-find')
      await m.until(() => m.find('contribute-list'), 'the list')
      const checks = [...m.container.ownerDocument!.body.querySelectorAll('[data-testid="contribute-check"]')]
      expect(checks).toHaveLength(2)
      await tick(m, checks[1]!)
      expect(checks.filter(isChecked)).toHaveLength(1)
      expect(m.get('contribute-send').textContent).toBe(ko('contribute.send', { n: 1 }))
      await m.click('contribute-send')
      await m.until(() => called('POST /api/skills/suggestions/batch').length, 'sent')
      expect(called('POST /api/skills/suggestions/batch')[0]!.body.skills.map((x: { name: string; origin: string }) => `${x.origin}:${x.name}`)).toEqual(['command:review'])
    } finally { await m.unmount() }
  })

  test('nothing can be ticked before the member\'s waiting count is in', async () => {
    signIn('member')
    suggestion = { kind: 'contribute', key: 'contribute', folder: null }
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    const fetchBefore = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith('/api/skills/overview')) await gate
      return fetchBefore(input, init)
    }) as unknown as typeof fetch
    g.showDirectoryPicker = async () => dirHandle('.claude', CLAUDE)
    const m = await mount(line())
    try {
      await m.until(() => m.find('result-suggestion'), 'the line')
      await m.click('result-suggestion-act')
      await m.until(() => m.find('contribute-find'), 'the pick')
      await m.click('contribute-find')
      await m.until(() => m.find('contribute-list'), 'the list')
      const checks = () => [...m.container.ownerDocument!.body.querySelectorAll('[data-testid="contribute-check"]')]
      expect(checks().every((c) => c.hasAttribute('disabled'))).toBe(true)
      release()
      await m.until(() => checks().some((c) => !c.hasAttribute('disabled')), 'the count')
    } finally { globalThis.fetch = fetchBefore; release(); await m.unmount() }
  })

  test('what the server did not take, with its reason', async () => {
    contributed = { batchId: BATCH, items: [folderSuggestion('quote-maker')], refused: [{ name: 'weekly-report', reason: 'pending', detail: null }, { name: 'runs-python', reason: 'scripts', detail: null }] }
    const m = await open()
    try {
      await m.click('contribute-find')
      await m.until(() => m.find('contribute-list'), 'the list')
      await tick(m, [...m.container.ownerDocument!.body.querySelectorAll('[data-testid="contribute-check"]')][0]!)
      await m.click('contribute-send')
      await m.until(() => m.find('contribute-sent'), 'sent')
      const refused = [...m.container.ownerDocument!.body.querySelectorAll('[data-testid="contribute-refused"]')].map((x) => x.textContent)
      expect(refused).toEqual([`weekly-report · ${ko('contribute.pending')}`, `runs-python · ${ko('welcome.skills.reason.scripts')}`])
    } finally { await m.unmount() }
  })

  test('the list reads a skill\'s title and description from its header (a command: its own file)', () => {
    expect(skillHead({ name: 'quote-maker', origin: 'user', files: [{ path: 'SKILL.md', text: skillMd('quote-maker', '견적 만들기') }] })).toEqual({ title: '견적 만들기', description: 'quote-maker — 팀 노트를 읽고 정리해요' })
    expect(skillHead({ name: 'weekly-report', origin: 'user', files: [{ path: 'SKILL.md', text: '---\nname: weekly-report\ndescription: "주간 보고"\n---\n' }] })).toEqual({ title: 'weekly report', description: '주간 보고' })
    expect(skillHead({ name: 'deploy', origin: 'command', files: [{ path: 'deploy.md', text: 'no header' }] })).toEqual({ title: 'deploy', description: '' })
  })
})

describe('Skills › 검토', () => {
  test('grouped by person, in the list\'s order', () => {
    const a = folderSuggestion('a'), b = folderSuggestion('b', { suggester: { id: 'jin', name: '지은' } }), c = folderSuggestion('c')
    expect(byPerson([a, b, c]).map((g) => [g.id, g.items.map((s) => s.name)])).toEqual([['bob', ['a', 'c']], ['jin', ['b']]])
  })

  test('?batch= opens 검토 with the groups; a skill folder is approved as skills/<folder name>/', async () => {
    signIn('owner')
    review = [
      folderSuggestion('quote-maker', { folder: { app: 'codex', title: '견적 만들기', files: [{ path: 'SKILL.md', bytes: 120 }, { path: 'quote.md', bytes: 30 }], scriptsDropped: 1, personalPath: true, sameName: { path: 'skills/quote-maker/SKILL.md', title: '견적' } } }),
      folderSuggestion('weekly-report'),
      folderSuggestion('notes', { suggester: { id: 'jin', name: '지은' }, batchId: '01900000-0000-7000-8000-0000000000b2' }),
    ]
    const m = await mount(
      <MemoryRouter initialEntries={[`/skills?batch=${BATCH}`]}>
        <Routes><Route path="/skills" element={<><Skills /><Where /></>} /></Routes>
      </MemoryRouter>,
    )
    try {
      await m.until(() => m.find('review-list'), 'the review list')
      const groups = [...m.container.ownerDocument!.body.querySelectorAll('[data-testid="review-group"]')]
      expect(groups.map((x) => x.getAttribute('data-person'))).toEqual(['bob', 'jin'])
      expect(groups[0]!.textContent).toContain(ko('skills.groupBy', { name: '민준', n: 2 }))
      expect(m.get('review-list').textContent).toContain('견적 만들기')
      expect(m.get('review-list').textContent).toContain(ko('skills.folderMeta', { app: 'Codex', n: 2 }))
      expect(m.get('where').textContent).toBe('/skills')
      await m.click('review-open')
      await m.until(() => m.find('review-dialog'), 'the dialog')
      expect(m.get('review-dialog').textContent).toContain(ko('skills.folderPersonalPath'))
      expect(m.get('review-dialog').textContent).toContain('quote.md')
      // the reviewer reads the file that goes with it, not only SKILL.md
      await m.until(() => m.find('review-file-text'), 'the file\'s text')
      expect(m.get('review-file-text').textContent).toBe('| 품목 | 가격 |')
      expect(m.find('review-file-name')).toBeNull()
      // a name that is no folder name: the primary waits
      await m.type('review-name', 'Quote Maker')
      expect(m.get('review-approve').hasAttribute('disabled')).toBe(true)
      await m.type('review-name', 'quote-maker-2')
      await m.click('review-approve')
      await m.until(() => called(`POST /api/skills/suggestions/${review[0]!.id}/approve`).length, 'approved')
      expect(called(`POST /api/skills/suggestions/${review[0]!.id}/approve`)[0]!.body).toEqual({
        targetFolder: 'skills', name: 'quote-maker-2', description: review[0]!.description, content: review[0]!.content,
      })
    } finally { await m.unmount() }
  })

  test('suggestions waiting: /skills lands on 검토, but 스킬 넣기\'s /skills?catalog=open stays on the skills', async () => {
    signIn('owner')
    review = [folderSuggestion('weekly-report')]
    const selected = async (url: string) => {
      const m = await mount(
        <MemoryRouter initialEntries={[url]}>
          <Routes><Route path="/skills" element={<Skills />} /></Routes>
        </MemoryRouter>,
      )
      try {
        const body = m.container.ownerDocument!.body
        await m.until(() => body.querySelector('[role="tab"]'), 'the tabs')
        // the overview's landing runs once the overview is in; give it its turn
        await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
        return body.querySelector('[role="tab"][aria-selected="true"]')!.id
      } finally { await m.unmount() }
    }
    expect(await selected('/skills')).toEndWith('-tab-review')
    expect(await selected('/skills?catalog=open')).toEndWith('-tab-skills')
  })
})

describe('the Inbox line and the saved skill', () => {
  test('a batch: who and how many, opening 검토 at that person; a single suggestion keeps its own link', async () => {
    signIn('owner')
    const item: InboxNotification = { id: 'n1', eventType: 'skill.suggested', sourceId: BATCH, code: 'skill.suggested', createdAt: '2026-11-07T00:00:00.000Z', readAt: null, chatId: null, link: 'skills', outcome: null, contribution: { name: '민준', n: 2 } }
    expect(skillsLink(item)).toBe(`/skills?batch=${BATCH}`)
    expect(skillsLink({ code: 'skill.suggested', sourceId: 'x' })).toBe('/skills?review=x')
    inbox = [item, { ...item, id: 'n2', sourceId: 'b2', contribution: { name: null, n: 3 } }, { ...item, id: 'n3', sourceId: 'one', contribution: undefined }]
    const m = await mount(<MemoryRouter><Notifications /></MemoryRouter>)
    try {
      await m.until(() => m.find('notifications-inbox'), 'the inbox')
      const text = m.get('notifications-inbox').textContent
      expect(text).toContain(ko('notifications.event.skill.contributed', { name: '민준', n: 2 }))
      expect(text).toContain('민준님이 스킬 2개를 팀에 올리자고 했어요')
      expect(text).toContain(ko('notifications.event.skill.contributedGone', { n: 3 }))
      expect(text).toContain(ko('notifications.event.skill.suggested'))
      // the whole row is the link (no separate "확인하기" under it)
      const links = [...m.container.ownerDocument!.body.querySelectorAll('[data-testid="notification-skills-link"]')]
      expect(links.map((l) => l.getAttribute('href'))).toEqual([`/skills?batch=${BATCH}`, '/skills?batch=b2', '/skills?review=one'])
      expect(links[0]!.textContent).toContain(ko('notifications.event.skill.contributed', { name: '민준', n: 2 }))
      expect(links[2]!.textContent).toContain(ko('notifications.event.skill.suggested'))
    } finally { await m.unmount() }
  })

  test('"민준님이 제안" on the saved skill in the skills list', () => {
    signIn('member')
    // a static render reads the store's first state (as test/unit/available-skills.test.tsx does)
    const before = useLocaleStore.getInitialState().locale
    Object.assign(useLocaleStore.getInitialState(), { locale: 'ko' })
    const html = renderToStaticMarkup(<AvailableSkillsList items={[{ path: 'skills/quote-maker/SKILL.md', name: 'quote-maker', title: '견적 만들기', description: '견적서를 써요', suggestedBy: '민준' }]} />)
    expect(html).toContain(ko('skills.suggestedBy', { name: '민준' }))
    expect(html).toContain('민준님이 제안')
    Object.assign(useLocaleStore.getInitialState(), { locale: before })
  })
})
