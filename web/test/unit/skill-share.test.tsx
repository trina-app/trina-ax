// 내 스킬 가져오기 (docs/DECISIONS.md "SK", "W7"): Team skills › Bring my skills (components/skills/BringSkillsSheet.tsx),
// its list (SkillShareReview.tsx) and /skills/share/:id (pages/SkillSharePage.tsx), rendered and clicked against a small
// fake of the server (GET/POST /api/skill-shares…). The setup steps no longer bring own skills (W7: the skills step shows
// only the skills Trina prepared, test/unit/onb6-skills.test.tsx), so the folder pick lives here only:
// - the picker: [내 스킬 찾기], the hidden-folder hint (⌘ ⇧ . read as words), the promise; the Mac App Store app's own
//   window at .claude; any other desktop build picks like a browser;
// - a picked folder: what is sent; while checking, the names with skeleton reasons and nothing to tick; then the list:
//   the recommended rows ticked, 그 밖에 and 빠진 것 folded, 빠진 것 without checkboxes, 합치기/따로 두기 on a
//   similar skill, the CLAUDE.md line unticked (보기 shows it); [팀에 넣기 · N개] sends the ticked rows and their action;
//   what went in (열기, 함께, 확인하기, the rule), 다른 폴더도 가져오기 and [닫기];
// - a closed folder window changes nothing; a folder without skills says so; 그만 찾기 and 닫기 drop the proposal; an
//   apply that fails offers 다시 시도;
// - /skills/share/:id: a Claude Code or Codex proposal (its source line, the tools line), a merge that waits while the
//   owner's setup is unfinished, the way back to /welcome during the setup and to the team skills after it; without
//   the AI (walk SHOULD 4) what was found is under "찾은 스킬 N개", not "그 밖에 · 나만 쓰는 것, 개발용".
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { act } from 'react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { PRODUCT } from '@mycel/shared'
import type { ApplySkillShare, ShareCandidate, SkillShare } from '@mycel/shared/api'
import { DICTS, translate, useLocaleStore, type MessageKey } from '../../src/i18n'
import { BringSkillsSheet } from '../../src/components/skills/BringSkillsSheet'
import SkillSharePage from '../../src/pages/SkillSharePage'
import { useSession } from '../../src/store/session'
import { useUi } from '../../src/store/ui'
import { useWelcome } from '../../src/store/welcome'
import type { DirectoryHandleLike } from '../../src/lib/skillScan'
import { FakeElement, FakeEvent, installDom, mount, removeDom, type Mounted } from './dom-host'

const ko = (k: MessageKey, p?: Record<string, string | number>) => translate('ko', k, p)
const json = (status: number, body: unknown) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const ID = '01900000-0000-7000-8000-0000000005a1'
const CC_ID = '01900000-0000-7000-8000-0000000005c1'
const MERGE_CHAT = '01900000-0000-7000-8000-0000000005d1'

const cand = (name: string, title: string, group: ShareCandidate['group'], reason: ShareCandidate['reason'], o: Partial<ShareCandidate> = {}): ShareCandidate => ({
  name, title, description: title, origin: 'user', project: null, group, reason, detail: null, personalPath: false,
  files: group === 'excluded' ? [] : [{ path: 'SKILL.md', bytes: 900 }], scriptsDropped: 0, sameName: null, similar: null, action: 'add', applied: null, ...o,
})
const candidates = (cc = false): ShareCandidate[] => [
  cand('weekly-report', '주간 업무 보고', 'recommended', 'team_any'),
  cand('quote-draft', '견적서 초안', 'recommended', 'with_file', { detail: '견적 양식' }),
  cand('meeting-notes', '회의록 정리', 'recommended', 'similar', { detail: '할 일 정리', similar: { path: 'skills/general/meeting-tasks/SKILL.md', title: '할 일 정리' }, action: 'merge' }),
  cand('my-schedule', '내 일정 정리', 'other', 'personal'),
  cand('vendor-mail', '거래처 메일', 'other', 'personal_path', { personalPath: true }),
  cand('commit-message', '커밋 메시지', 'other', 'dev', { scriptsDropped: 2 }),
  cand('pr-review', 'PR 리뷰', 'other', 'dev'),
  ...(cc ? [cand('api-docs', 'API 문서', 'other', 'dev', { origin: 'project', project: 'acme-api' })] : []),
  cand('slack-notify', '슬랙 알림', 'excluded', 'secret', { detail: 'slack' }),
  cand('deploy', '배포하기', 'excluded', 'scripts'),
  cand('frontend-design', 'frontend-design', 'excluded', 'plugin', { origin: 'plugin' }),
]
const shareOf = (o: Partial<SkillShare> = {}): SkillShare => ({
  id: ID, source: 'browser', app: 'claude', status: 'ready', where: '.claude', projects: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), expiresAt: '2026-11-13T00:00:00.000Z',
  ai: 'done', candidates: candidates(o.source === 'claude_code'), rule: { lines: 5, dropped: 12, text: '- 보고서는 결론부터 써요\n- 숫자는 표로 정리해요', path: null }, tools: [], landing: null, ...o,
})

// ---- the fake server
let created: SkillShare | null = null
/** how the proposal starts: checking reads once as checking, then ready */
let startChecking = false
let ccItems: SkillShare[] = []
let failApply = 0
/** the server's answer to a merge: started now (a chat) or waiting for the end of the owner's setup */
let mergeLater = false
/** the owner's welcome progress (GET /api/onboarding/welcome); null: none */
let welcome: { finishedAt: string | null } | null = null
/** the next proposal the server makes (a second folder: its own id and skills); null: the usual one */
let nextShare: Partial<SkillShare> | null = null
let calls: { key: string; url: string; body: any }[] = []
const called = (key: string) => calls.filter((c) => c.key === key)
const applyTo = (s: SkillShare, b: ApplySkillShare): SkillShare => ({
  ...s, status: 'applied',
  candidates: s.candidates.map((c) => {
    const x = b.skills.find((y) => y.name === c.name)
    if (!x) return c
    if (x.action === 'merge') return { ...c, applied: mergeLater ? { status: 'later', path: c.similar?.path ?? null, chatId: null, error: null } : { status: 'merge', path: null, chatId: MERGE_CHAT, error: null } }
    const name = x.action === 'separate' ? `${c.name}-2` : c.name
    return { ...c, applied: { status: 'added', path: `skills/${name}/SKILL.md`, chatId: null, error: null } }
  }),
  rule: s.rule && b.rule ? { ...s.rule, path: 'skills/일하는-방식.md' } : s.rule,
  tools: s.tools.map((x) => (b.tools?.includes(x.name) ? { ...x, templateId: 'tpl-1' } : x)),
  landing: 'skills/weekly-report/SKILL.md',
})
function route(method: string, path: string, body: any): Response {
  if (method === 'POST' && path === '/api/skill-shares') {
    created = shareOf({ status: startChecking ? 'checking' : 'ready', ai: startChecking ? 'pending' : 'done', where: body.where, ...nextShare })
    return json(201, created)
  }
  if (method === 'GET' && path === '/api/skill-shares') return json(200, { items: ccItems })
  const m = /^\/api\/skill-shares\/([^/]+)(\/apply|\/dismiss|\/stop-check)?$/.exec(path)
  if (m) {
    const s = [created, ...ccItems].find((x) => x?.id === m[1]) ?? null
    if (!s) return json(404, { error: { code: 'not_found', message: '없어요' } })
    if (method === 'GET') {
      const out = s
      if (s.status === 'checking') created = { ...s, status: 'ready', ai: 'done' }
      return json(200, out)
    }
    if (m[2] === '/dismiss') return json(204, null)
    // the page ends a check (SHARE_CHECK_LIMIT_MS): ready, nothing recommended
    if (m[2] === '/stop-check') return json(200, { ...s, status: 'ready', ai: 'failed', candidates: s.candidates.map((c) => (c.group === 'excluded' ? c : { ...c, group: 'other', reason: 'unjudged' })) })
    if (failApply-- > 0) return json(500, { error: { code: 'internal', message: '지금은 넣지 못했어요' } })
    return json(200, applyTo(s, body))
  }
  if (method === 'GET' && path === '/api/onboarding/welcome') return json(200, { progress: welcome ? { ...WELCOME_ROW, ...welcome } : null })
  if (method === 'GET' && path === '/api/admin/users') return json(200, { items: [{ id: 'olga', username: 'olga', name: '올가', email: null, role: 'owner', status: 'active' }] })
  return json(404, { error: { code: 'not_found', message: `no route ${method} ${path}` } })
}

const WELCOME_ROW = {
  startedAt: '2026-11-06T00:00:00.000Z', updatedAt: '2026-11-06T00:00:00.000Z', teamType: null,
  steps: { profile: 'done', result: null, skills: null, files: null, invite: null }, resultChatId: null, inviteShownAt: null, site: null, dismissedAt: null,
}

// ---- a picked .claude folder (Chrome's handle)
type Tree = { [name: string]: Tree | string }
const dirHandle = (name: string, tree: Tree): DirectoryHandleLike => ({
  kind: 'directory', name,
  async getDirectoryHandle(n) { const v = tree[n]; if (v && typeof v === 'object') return dirHandle(n, v); throw Object.assign(new Error('nf'), { name: 'NotFoundError' }) },
  async getFileHandle(n) { const v = tree[n]; if (typeof v === 'string') return { name: n, getFile: async () => new File([v], n) }; throw Object.assign(new Error('nf'), { name: 'NotFoundError' }) },
  async *entries() { for (const [k, v] of Object.entries(tree)) yield [k, { kind: typeof v === 'string' ? 'file' : 'directory' }] as [string, { kind: 'file' | 'directory' }] },
})
const CLAUDE: Tree = {
  'CLAUDE.md': '- 보고서는 결론부터 써요\n',
  skills: { 'weekly-report': { 'SKILL.md': '---\nname: weekly-report\ndescription: 주간 업무 보고\n---\n# 주간 업무 보고\n' }, 'slack-notify': { 'SKILL.md': '---\nname: slack-notify\n---\ntoken: xoxb-0000000000-FAKE-NOT-REAL\n' } },
}
let picker: (() => Promise<DirectoryHandleLike>) | null = null

const g = globalThis as Record<string, unknown>
const realFetch = globalThis.fetch
const localeBefore = useLocaleStore.getState().locale
const sessionBefore = { status: useSession.getState().status }
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
  created = null
  startChecking = false
  ccItems = []
  failApply = 0
  mergeLater = false
  welcome = null
  nextShare = null
  useWelcome.getState().reset()
  useUi.setState({ toasts: [] })
  calls = []
  picker = null
  delete g.showDirectoryPicker
  delete g.HTMLInputElement
  g.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
})
afterAll(() => {
  globalThis.fetch = realFetch
  useSession.setState(sessionBefore as never)
  useLocaleStore.setState({ locale: localeBefore })
  removeDom()
})

/** Chrome on a computer: the folder window gives a handle */
const chrome = () => { g.showDirectoryPicker = async () => (picker ? picker() : dirHandle('.claude', CLAUDE)) }
const events: string[] = []
function Where() { const l = useLocation(); return <p data-testid="where">{l.pathname + l.search}</p> }
/** Team skills › Bring my skills (owners and admins) */
const sheet = async () => {
  events.length = 0
  const m = await mount(
    <MemoryRouter initialEntries={['/skills']}>
      <Routes>
        <Route path="/skills" element={<BringSkillsSheet team="Acme" onClose={() => events.push('close')} />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  )
  await m.until(() => m.find('bring-sheet'), 'the sheet')
  return m
}
const hourAgo = () => new Date(Date.now() - 3_600_000).toISOString()
const text = (m: Mounted, id: string) => m.get(id).textContent ?? ''
const rows = (m: Mounted, group?: string) => m.container.ownerDocument!.body.querySelectorAll('[data-testid="skill-row"]').filter((r: FakeElement) => !group || r.getAttribute('data-group') === group)
const rowOf = (m: Mounted, name: string) => rows(m).find((r) => r.getAttribute('data-name') === name)!
const checkOf = (m: Mounted, name: string) => rowOf(m, name).querySelector('input') as FakeElement & { checked: boolean; disabled: boolean }
/** a browser checks a box before the click's listeners run, past React's value tracker (this small DOM does not) */
const tick = async (m: Mounted, el: FakeElement) => {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'checked')!.set!.call(el, !(el as unknown as { checked: boolean }).checked)
  await m.click(el)
}
const choose = async (el: FakeElement, value: string) => {
  Object.getOwnPropertyDescriptor(FakeElement.prototype, 'value')!.set!.call(el, value)
  await act(async () => { el.dispatchEvent(new FakeEvent('change', { bubbles: true })) })
}
const findAndList = async (m: Mounted) => {
  await m.click('bring-find')
  await m.until(() => m.find('skill-review')?.getAttribute('data-status') === 'ready', 'the list', 6000)
}

const meOf = (role: 'owner' | 'admin' | 'member') => ({
  user: { id: 'olga', username: 'olga', name: '올가', email: null, role, locale: 'ko', localeChoice: null, mustChangePassword: false, prefs: {} },
  groups: [], team: { name: 'Acme', defaultLocale: 'ko' },
  session: { id: '01900000-0000-7000-8000-00000000000a', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' }, server: { version: '0', dev: true },
})
/** /skills/share/:id as this role */
const page = (id: string, role: 'owner' | 'admin' | 'member') => {
  useSession.setState({ status: { kind: 'signed-in', me: meOf(role) } } as never)
  return mount(
    <MemoryRouter initialEntries={[`/skills/share/${id}`]}>
      <Routes>
        <Route path="/skills/share/:id" element={<SkillSharePage />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('the picker', () => {
  test('[내 스킬 찾기], the hidden-folder hint read as words, the promise; 닫기 closes and sends nothing', async () => {
    chrome()
    const m = await sheet()
    try {
      expect(m.get('bring-sheet').getAttribute('data-state')).toBe('pick')
      expect(text(m, 'bring-find')).toContain(ko('welcome.skills.find'))
      // ⌘ ⇧ . shown, hidden from screen readers, and said in words
      const hint = m.get('bring-hint')
      expect(hint.querySelectorAll('kbd').map((k) => k.textContent)).toEqual(['⌘', '⇧', '.'])
      expect(hint.querySelector('[aria-hidden]')!.textContent).toBe('⌘⇧.')
      expect(hint.querySelector('[class="sr-only"]')!.textContent).toBe(ko('welcome.skills.keysMac'))
      expect(hint.textContent).toContain('.claude')
      // Codex's folders beside Claude's (its settings in .codex, its skills in .agents)
      expect(hint.textContent).toContain('(Codex는 .codex나 .agents)')
      expect(text(m, 'bring-drop')).toContain(ko('welcome.skills.promise'))
      expect(called('POST /api/skill-shares')).toHaveLength(0)
    } finally { await m.unmount() }
  })
})

describe('the desktop app', () => {
  const picked = (path: string, content: string) => {
    const f = new File([content], path.split('/').pop()!)
    Object.defineProperty(f, 'webkitRelativePath', { value: path })
    return f
  }
  test('the Mac App Store app: [이 컴퓨터에서 찾기], its own window at .claude (data-open-at) with no key hint; the files it lists, filtered, go as "desktop"', async () => {
    g.mycelDesktop = { bridgeVersion: 1, platform: 'darwin', store: true }
    const m = await sheet()
    try {
      expect(text(m, 'bring-find')).toContain(ko('welcome.skills.findDesktop'))
      expect(text(m, 'bring-hint')).toBe(ko('welcome.skills.hintDesktop').replace('{folder}', '.claude').replace('{codex}', '.codex').replace('{agents}', '.agents').replace('{button}', ko('welcome.skills.desktopButton')))
      expect(m.get('bring-hint').querySelectorAll('kbd')).toHaveLength(0)
      const input = m.get('skills-input')
      expect(input.getAttribute('data-open-at')).toBe('claude')
      expect(input.hasAttribute('webkitdirectory')).toBe(true)
      Object.defineProperty(input, 'files', { configurable: true, value: [picked('.claude/history.jsonl', 'never'), picked('.claude/skills/weekly-report/SKILL.md', '---\nname: weekly-report\n---\n# 주간 업무 보고\n')] })
      await act(async () => { input.dispatchEvent(new FakeEvent('change', { bubbles: true })) })
      await m.until(() => called('POST /api/skill-shares').length > 0, 'the proposal')
      const sent = called('POST /api/skill-shares')[0]!.body
      expect(sent.source).toBe('desktop')
      expect(sent.where).toBe('.claude')
      expect(sent.skills.map((x: { name: string }) => x.name)).toEqual(['weekly-report'])
      expect(JSON.stringify(sent)).not.toContain('never')
    } finally { await m.unmount(); delete g.mycelDesktop }
  })
  // the Microsoft Store build is a store build too, but only the Mac App Store one answers file inputs itself
  for (const bridge of [{ bridgeVersion: 1 }, { bridgeVersion: 1, platform: 'win32', store: true }]) test(`any other desktop build picks like a browser (the folder window, the key hint), and says "desktop": ${JSON.stringify(bridge)}`, async () => {
    g.mycelDesktop = bridge
    chrome()
    const m = await sheet()
    try {
      expect(text(m, 'bring-find')).toContain(ko('welcome.skills.find'))
      expect(m.get('bring-hint').querySelectorAll('kbd').map((k) => k.textContent)).toEqual(['⌘', '⇧', '.'])
      expect(m.get('skills-input').getAttribute('data-open-at')).toBe('claude')
      await findAndList(m)
      expect(called('POST /api/skill-shares')[0]!.body.source).toBe('desktop')
    } finally { await m.unmount(); delete g.mycelDesktop }
  })
})

describe('a picked folder', () => {
  test('what is sent; while checking the names with skeletons and nothing to tick; then the list: recommended ticked, the rest folded, 빠진 것 not tickable', async () => {
    chrome()
    startChecking = true
    const m = await sheet()
    try {
      await m.click('bring-find')
      await m.until(() => m.find('skill-review')?.getAttribute('data-status') === 'checking', 'the checking rows')
      // only the filtered folder went up: the skill with a token as its name only, CLAUDE.md as the rule
      const sent = called('POST /api/skill-shares')[0]!.body
      expect(sent.source).toBe('browser')
      expect(sent.where).toBe('.claude')
      expect(sent.skills.map((s: { name: string }) => s.name)).toEqual(['weekly-report'])
      expect(sent.excluded).toEqual([{ name: 'slack-notify', origin: 'user', reason: 'secret', kind: 'slack' }])
      expect(sent.rule).toEqual({ text: '- 보고서는 결론부터 써요\n' })
      expect(JSON.stringify(sent)).not.toContain('xoxb-')
      // checking: five names, skeletons, disabled boxes, "5개 더 보는 중…", 그만 찾기
      expect(text(m, 'skill-review-source')).toContain(ko('welcome.skills.scanning', { n: 10 }).replace('{where}', '.claude'))
      expect(m.get('skill-review-source').getAttribute('aria-live')).toBe('polite')
      expect(rows(m)).toHaveLength(5)
      expect(rows(m).every((r) => (r.querySelector('input') as unknown as { disabled: boolean }).disabled)).toBe(true)
      expect(text(m, 'skill-review')).toContain(ko('welcome.skills.scanningMore', { n: 5 }))
      expect(text(m, 'skill-review')).toContain(ko('welcome.skills.scanningNote'))
      expect(m.find('skill-review-stop')).not.toBeNull()
      // the server's next read: ready
      await m.until(() => m.find('skill-review')?.getAttribute('data-status') === 'ready', 'the list', 6000)
      expect(text(m, 'skill-review-source')).toContain(ko('welcome.skills.found', { n: 10 }).replace('{where}', '.claude'))
      expect(text(m, 'skills-recommended')).toContain(ko('welcome.skills.recommended', { n: 3 }))
      expect(rows(m, 'recommended').map((r) => r.getAttribute('data-name'))).toEqual(['weekly-report', 'quote-draft', 'meeting-notes'])
      expect(rows(m, 'recommended').every((r) => (r.querySelector('input') as unknown as { checked: boolean }).checked)).toBe(true)
      // the AI title, the skill's own name in mono, the one-line reason
      expect(rowOf(m, 'weekly-report').textContent).toBe(`주간 업무 보고/weekly-report${ko('welcome.skills.reason.team_any')}`)
      expect(rowOf(m, 'quote-draft').textContent).toContain(ko('welcome.skills.reason.with_file', { detail: '견적 양식' }))
      expect(rowOf(m, 'meeting-notes').textContent).toContain(ko('welcome.skills.reason.similar', { detail: '할 일 정리' }))
      // folded: 그 밖에 4개 · 나만 쓰는 것, 개발용 / 빠진 것 3개 · 비밀 키, 스크립트, 플러그인
      expect(rows(m, 'other')).toHaveLength(0)
      expect(text(m, 'skills-other-toggle')).toBe(`${ko('welcome.skills.other', { n: 4 })}· ${ko('welcome.skills.otherHint')}`)
      expect(text(m, 'skills-excluded-toggle')).toBe(`${ko('welcome.skills.excluded', { n: 3 })}· 비밀 키, 스크립트, 플러그인`)
      await m.click('skills-other-toggle')
      await m.click('skills-excluded-toggle')
      expect(m.get('skills-other-toggle').getAttribute('aria-expanded')).toBe('true')
      expect(rows(m, 'other').every((r) => !(r.querySelector('input') as unknown as { checked: boolean }).checked)).toBe(true)
      expect(rowOf(m, 'vendor-mail').textContent).toContain(ko('welcome.skills.reason.personal_path'))
      expect(rowOf(m, 'commit-message').textContent).toContain(ko('welcome.skills.scriptsDropped'))
      // 빠진 것: an icon, no checkbox
      expect(rows(m, 'excluded').map((r) => r.querySelector('input'))).toEqual([null, null, null])
      expect(rowOf(m, 'slack-notify').textContent).toContain(ko('welcome.skills.reason.secret', { detail: 'Slack' }))
      expect(rowOf(m, 'deploy').textContent).toContain(ko('welcome.skills.reason.scripts'))
      expect(rowOf(m, 'frontend-design').textContent).toContain(ko('welcome.skills.reason.plugin'))
      // the rule line, unticked; the who line; [팀에 넣기 · 3개] and 닫기
      expect((m.get('skills-rule-check') as unknown as { checked: boolean }).checked).toBe(false)
      expect(text(m, 'skills-rule')).toContain(ko('welcome.skills.rule', { n: 5, file: 'CLAUDE.md' }))
      expect(text(m, 'skills-rule')).toContain(ko('welcome.skills.ruleNote', { m: 12 }))
      expect(m.find('skills-tools')).toBeNull()
      expect(text(m, 'skills-who')).toBe(ko('welcome.skills.who', { team: 'Acme' }))
      expect(text(m, 'skills-share')).toContain(ko('skills.catalog.install', { n: 3 }))
      expect(text(m, 'skills-later')).toBe(ko('common.close'))
    } finally { await m.unmount() }
  })

  test('tick, untick, 합치기 → 따로 두기, the rule (보기 shows it): what [팀에 넣기] sends; then what went in with 열기, 다른 폴더도 가져오기 and 닫기', async () => {
    chrome()
    const m = await sheet()
    try {
      await findAndList(m)
      await m.click('skills-other-toggle')
      await tick(m, checkOf(m, 'my-schedule'))
      await tick(m, checkOf(m, 'weekly-report'))
      await tick(m, checkOf(m, 'weekly-report'))
      await tick(m, checkOf(m, 'quote-draft'))
      expect(text(m, 'skills-share')).toContain(ko('skills.catalog.install', { n: 3 }))
      // only rows with a similar or same-named team skill choose
      expect(rows(m).filter((r) => r.querySelector('select')).map((r) => r.getAttribute('data-name'))).toEqual(['meeting-notes'])
      const pill = rowOf(m, 'meeting-notes').querySelector('select')!
      expect(pill.getAttribute('aria-label')).toBe(ko('welcome.skills.actionLabel', { name: '회의록 정리' }))
      await choose(pill, 'separate')
      await m.click('skills-rule-view')
      expect(text(m, 'skills-rule-text')).toBe('- 보고서는 결론부터 써요\n- 숫자는 표로 정리해요')
      await tick(m, m.get('skills-rule-check'))
      // the rule is one more item
      expect(text(m, 'skills-share')).toContain(ko('skills.catalog.install', { n: 4 }))
      await m.click('skills-share')
      await m.until(() => m.find('skill-review')?.getAttribute('data-status') === 'applied', 'what went in')
      expect(called(`POST /api/skill-shares/${ID}/apply`).map((c) => c.body)).toEqual([{
        skills: [{ name: 'weekly-report', action: 'add' }, { name: 'meeting-notes', action: 'separate' }, { name: 'my-schedule', action: 'add' }],
        rule: true, tools: [],
      }])
      expect(text(m, 'skills-done')).toBe(ko('welcome.skills.done'))
      const done = (globalThis.document as any).body.querySelectorAll('[data-testid="skill-done-row"]') as FakeElement[]
      expect(done.map((r) => `${r.getAttribute('data-kind')}:${r.getAttribute('data-name') ?? ''}`)).toEqual(['added:weekly-report', 'added:meeting-notes', 'added:my-schedule', 'rule:'])
      expect(done[0]!.textContent).toContain(ko('welcome.skills.doneAdded'))
      // not during the setup: each added skill opens
      expect(done[0]!.querySelector('a')!.getAttribute('href')).toBe('/skills?run=skills%2Fweekly-report%2FSKILL.md')
      expect(done[3]!.textContent).toContain(ko('welcome.skills.ruleName'))
      await m.until(() => m.find('skills-done-who'), 'the who line')
      expect(text(m, 'skills-done-who')).toBe(ko('welcome.skills.doneWho', { team: 'Acme' }))
      // 다른 폴더도 가져오기: back to the picker
      expect(text(m, 'skills-more')).toBe(ko('welcome.skills.more'))
      expect(m.get('skills-more').className).not.toContain('bg-accent')
      await m.click('skills-more')
      expect(m.get('bring-sheet').getAttribute('data-state')).toBe('pick')
      expect(m.find('bring-find')).not.toBeNull()
      await findAndList(m)
      await m.click('skills-share')
      await m.until(() => m.find('skills-done-next'), 'what went in')
      expect(text(m, 'skills-done-next')).toBe(ko('common.close'))
      await m.click('skills-done-next')
      expect(events).toEqual(['close'])
    } finally { await m.unmount() }
  })

  test('as recommended: the file goes with it, the merge waits in a chat ([확인하기]); an apply that fails offers 다시 시도', async () => {
    chrome()
    failApply = 1
    const m = await sheet()
    try {
      await findAndList(m)
      await m.click('skills-share')
      await m.until(() => m.get('skill-review').querySelector('[role="alert"]'), 'the error')
      expect(m.get('skill-review').querySelector('[role="alert"]')!.textContent).toContain('지금은 넣지 못했어요')
      const retry = (globalThis.document as any).body.querySelectorAll('button').find((b: FakeElement) => b.textContent === ko('common.retry'))
      await m.click(retry)
      await m.until(() => m.find('skill-review')?.getAttribute('data-status') === 'applied', 'what went in')
      expect(called(`POST /api/skill-shares/${ID}/apply`).map((c) => c.body.skills)).toEqual([
        [{ name: 'weekly-report', action: 'add' }, { name: 'quote-draft', action: 'add' }, { name: 'meeting-notes', action: 'merge' }],
        [{ name: 'weekly-report', action: 'add' }, { name: 'quote-draft', action: 'add' }, { name: 'meeting-notes', action: 'merge' }],
      ])
      const done = (globalThis.document as any).body.querySelectorAll('[data-testid="skill-done-row"]') as FakeElement[]
      expect(done.map((r) => r.getAttribute('data-kind'))).toEqual(['added', 'added', 'merge'])
      expect(done[1]!.textContent).toContain(ko('welcome.skills.doneWithFile', { file: '견적 양식' }))
      expect(done[2]!.textContent).toContain(ko('welcome.skills.merged', { x: '할 일 정리' }))
      expect(m.get('skill-done-review').getAttribute('href')).toBe(`/c/${MERGE_CHAT}`)
    } finally { await m.unmount() }
  })

  test('nothing ticked: [팀에 넣기] cannot be pressed; the rule alone can go', async () => {
    chrome()
    const m = await sheet()
    try {
      await findAndList(m)
      for (const n of ['weekly-report', 'quote-draft', 'meeting-notes']) await tick(m, checkOf(m, n))
      expect(m.get('skills-share').hasAttribute('disabled')).toBe(true)
      await tick(m, m.get('skills-rule-check'))
      expect(m.get('skills-share').hasAttribute('disabled')).toBe(false)
      expect(text(m, 'skills-share')).toContain(ko('skills.catalog.install', { n: 1 }))
    } finally { await m.unmount() }
  })

  test('the folder window closed: nothing happens; a folder without skills says so', async () => {
    chrome()
    picker = async () => { throw Object.assign(new Error('closed'), { name: 'AbortError' }) }
    const m = await sheet()
    try {
      await m.click('bring-find')
      await m.settle(30)
      expect(m.get('bring-sheet').getAttribute('data-state')).toBe('pick')
      expect(m.find('bring-none')).toBeNull()
      expect(m.find('skill-review')).toBeNull()
      expect((globalThis.document as any).body.querySelector('[role="alert"]')).toBeNull()
      picker = async () => dirHandle('Documents', { 'a.md': 'x' })
      await m.click('bring-find')
      await m.until(() => m.find('bring-none'), 'the note')
      expect(text(m, 'bring-none')).toBe(ko('welcome.skills.none'))
      expect(called('POST /api/skill-shares')).toHaveLength(0)
    } finally { await m.unmount() }
  })

  test('그만 찾기 drops the proposal and the picker comes back; 닫기 under a list drops it and closes', async () => {
    chrome()
    startChecking = true
    const m = await sheet()
    try {
      await m.click('bring-find')
      await m.until(() => m.find('skill-review-stop'), 'the checking rows')
      await m.click('skill-review-stop')
      await m.until(() => m.get('bring-sheet').getAttribute('data-state') === 'pick', 'the picker')
      expect(called(`POST /api/skill-shares/${ID}/dismiss`)).toHaveLength(1)
      startChecking = false
      await findAndList(m)
      await m.click('skills-later')
      expect(called(`POST /api/skill-shares/${ID}/dismiss`)).toHaveLength(2)
      expect(events).toEqual(['close'])
    } finally { await m.unmount() }
  })
})

describe('no product name of its own', () => {
  test('no 내 스킬 text writes a product name of its own, in any language', () => {
    for (const [locale, dict] of Object.entries(DICTS)) {
      for (const [key, value] of Object.entries(dict)) {
        if (key.startsWith('welcome.skills.')) expect({ locale, key, named: /트리나|Trina|トリナ/.test(value) }).toEqual({ locale, key, named: false })
      }
    }
    expect(translate('en', 'welcome.skills.reason.scripts')).toBe(`Needs scripts to run · ${PRODUCT.displayName} doesn't run scripts`)
  })
})

describe('/skills/share/:id', () => {
  test('a member stays (a proposal to their group is theirs to review); one not theirs reads as gone; an admin sees the proposal under its own heading, and after sharing the primary opens the team skills', async () => {
    ccItems = [shareOf({ id: CC_ID, source: 'claude_code', where: null, projects: 2 })]
    // the server answers 404 for a proposal the member may not review (docs/DECISIONS.md "Group skills")
    const member = await page('01900000-0000-7000-8000-0000000005fe', 'member')
    try {
      await member.until(() => member.find('skill-share-gone'), 'the note')
      expect(member.find('where')).toBeNull()
    } finally { await member.unmount() }
    const m = await page(CC_ID, 'admin')
    try {
      await m.until(() => m.find('skill-review')?.getAttribute('data-status') === 'ready', 'the proposal')
      expect(text(m, 'skill-share-page')).toContain(ko('skillShare.page.title'))
      await m.click('skills-share')
      await m.until(() => m.find('skills-done-next'), 'what went in')
      expect(text(m, 'skills-done-next')).toBe(ko('skillShare.page.toSkills'))
      await m.click('skills-done-next')
      expect(text(m, 'where')).toBe('/skills')
    } finally { await m.unmount() }
  })
  test('a proposal that is gone says so; 나중에 하기 leaves it as it is', async () => {
    const gone = await page('01900000-0000-7000-8000-0000000005ff', 'owner')
    try {
      await gone.until(() => gone.find('skill-share-gone'), 'the note')
      expect(text(gone, 'skill-share-gone')).toContain(ko('welcome.skills.gone'))
    } finally { await gone.unmount() }
    ccItems = [shareOf({ id: CC_ID, source: 'claude_code' })]
    const m = await page(CC_ID, 'owner')
    try {
      await m.until(() => m.find('skills-later'), 'the list')
      await m.click('skills-later')
      expect(text(m, 'where')).toBe('/skills')
      expect(called(`POST /api/skill-shares/${CC_ID}/dismiss`)).toHaveLength(0)
    } finally { await m.unmount() }
  })
})

describe('/skills/share/:id: proposals, the setup, merges', () => {
  test('a Codex proposal shows like Claude Code\'s: its sender in the source line, its tools, no 다른 폴더', async () => {
    ccItems = [shareOf({ id: CC_ID, source: 'codex', app: 'codex', where: null, projects: 1, tools: [{ name: 'Linear', url: 'https://mcp.linear.app/mcp', auth: 'oauth', header: null, templateId: null, error: null }] })]
    const m = await page(CC_ID, 'admin')
    try {
      await m.until(() => m.find('skill-review')?.getAttribute('data-status') === 'ready', 'the proposal', 6000)
      expect(m.get('skill-review-source').getAttribute('data-state')).toBe('codex')
      expect(text(m, 'skill-review-source')).toContain('Codex가 찾아서 보냈어요')
      expect(text(m, 'skill-review-source')).toContain('스킬 10개 (프로젝트 1곳 포함)')
      expect(m.find('skill-review-other-folder')).toBeNull()
      expect(text(m, 'skills-tools')).toContain(ko('welcome.skills.tools', { n: 1, names: 'Linear' }))
    } finally { await m.unmount() }
  })

  test('a Claude Code proposal: its source line, the projects, the tools line; the tools go when ticked', async () => {
    ccItems = [shareOf({ id: CC_ID, source: 'claude_code', where: null, projects: 2, tools: [{ name: 'Notion', url: 'https://mcp.notion.com/mcp', auth: 'oauth', header: null, templateId: null, error: null }, { name: 'Linear', url: 'https://mcp.linear.app/mcp', auth: 'oauth', header: null, templateId: null, error: null }] })]
    const m = await page(CC_ID, 'admin')
    try {
      await m.until(() => m.find('skill-review')?.getAttribute('data-status') === 'ready', 'the proposal')
      expect(m.get('skill-review-source').getAttribute('data-state')).toBe('cc')
      expect(text(m, 'skill-review-source')).toContain('Claude Code가 찾아서 보냈어요')
      expect(text(m, 'skill-review-source')).toContain('스킬 11개 (프로젝트 2곳 포함)')
      // no "다른 폴더" for a Claude Code proposal
      expect(m.find('skill-review-other-folder')).toBeNull()
      expect(text(m, 'skills-tools')).toContain(ko('welcome.skills.tools', { n: 2, names: 'Notion, Linear' }))
      expect(text(m, 'skills-tools')).toContain(ko('welcome.skills.toolsNote'))
      // each address is shown as it will be stored, so a key in it can be seen
      expect(text(m, 'skills-tools-urls')).toContain('Notion · ')
      await tick(m, m.get('skills-tools-check'))
      await m.click('skills-share')
      await m.until(() => m.find('skill-review')?.getAttribute('data-status') === 'applied', 'what went in')
      expect(called(`POST /api/skill-shares/${CC_ID}/apply`)[0]!.body).toEqual({ skills: [{ name: 'weekly-report', action: 'add' }, { name: 'quote-draft', action: 'add' }, { name: 'meeting-notes', action: 'merge' }], rule: false, tools: ['Notion', 'Linear'] })
      const done = (globalThis.document as any).body.querySelectorAll('[data-testid="skill-done-row"]') as FakeElement[]
      expect(done.filter((r) => r.getAttribute('data-kind') === 'tool').map((r) => r.textContent)).toEqual([`Notion${ko('welcome.skills.doneTool')}`, `Linear${ko('welcome.skills.doneTool')}`])
    } finally { await m.unmount() }
  })

  test('during the setup a merge into a team skill waits: "합치기는 설정 끝나고 확인해요", no chat to open', async () => {
    mergeLater = true
    welcome = { finishedAt: null }
    ccItems = [shareOf({ id: CC_ID, source: 'browser' })]
    const m = await page(CC_ID, 'owner')
    try {
      await m.until(() => m.find('skills-share'), 'the list')
      await m.click('skills-share')
      await m.until(() => m.find('skill-review')?.getAttribute('data-status') === 'applied', 'what went in')
      const done = (globalThis.document as any).body.querySelectorAll('[data-testid="skill-done-row"]') as FakeElement[]
      const later = done.find((r) => r.getAttribute('data-name') === 'meeting-notes')!
      expect(later.getAttribute('data-kind')).toBe('later')
      expect(later.textContent).toContain(ko('welcome.skills.mergeLater', { x: '할 일 정리' }))
      expect(later.querySelector('a')).toBeNull()
      expect(m.find('skill-done-review')).toBeNull()
    } finally { await m.unmount() }
  })

  test('/skills/share/:id while the owner\'s setup is unfinished: no 열기, and both ways go back to /welcome', async () => {
    welcome = { finishedAt: null }
    ccItems = [shareOf({ id: CC_ID, source: 'claude_code', where: null })]
    let m = await page(CC_ID, 'owner')
    try {
      await m.until(() => m.find('skill-review')?.getAttribute('data-status') === 'ready', 'the proposal')
      await m.click('skills-later')
      expect(text(m, 'where')).toBe('/welcome')
    } finally { await m.unmount() }
    useWelcome.getState().reset()
    m = await page(CC_ID, 'owner')
    try {
      await m.until(() => m.find('skills-share'), 'the list')
      await m.click('skills-share')
      await m.until(() => m.find('skills-done-next'), 'what went in')
      expect(m.find('skill-done-open')).toBeNull()
      expect(text(m, 'skills-done-next')).toBe(ko('skillShare.page.toSetup'))
      await m.click('skills-done-next')
      expect(text(m, 'where')).toBe('/welcome')
    } finally { await m.unmount() }
  })

  test('/skills/share/:id after the setup (or for an admin): 열기 on what went in, and the primary opens the team skills', async () => {
    welcome = { finishedAt: '2026-11-06T01:00:00.000Z' }
    ccItems = [shareOf({ id: CC_ID, source: 'claude_code', where: null })]
    const m = await page(CC_ID, 'owner')
    try {
      await m.until(() => m.find('skills-share'), 'the list')
      await m.click('skills-share')
      await m.until(() => m.find('skills-done-next'), 'what went in')
      expect(m.get('skill-done-open').getAttribute('href')).toBe('/skills?run=skills%2Fweekly-report%2FSKILL.md')
      expect(text(m, 'skills-done-next')).toBe(ko('skillShare.page.toSkills'))
      await m.click('skills-done-next')
      expect(text(m, 'where')).toBe('/skills')
    } finally { await m.unmount() }
  })

  test('a picked .codex folder\'s share reads its folder and offers its tools (no longer Claude Code\'s only)', async () => {
    ccItems = [shareOf({ id: CC_ID, source: 'browser', app: 'codex', where: '.codex', tools: [{ name: 'Notion', url: 'https://mcp.notion.com/mcp', auth: 'bearer', header: null, templateId: null, error: null }] })]
    const m = await page(CC_ID, 'admin')
    try {
      await m.until(() => m.find('skill-review')?.getAttribute('data-status') === 'ready', 'the proposal')
      expect(m.get('skill-review-source').getAttribute('data-state')).toBe('folder')
      expect(text(m, 'skill-review-source')).toContain(ko('welcome.skills.found', { n: 10 }).replace('{where}', '.codex'))
      expect(text(m, 'skills-tools')).toContain(ko('welcome.skills.tools', { n: 1, names: 'Notion' }))
    } finally { await m.unmount() }
  })
})

describe('without the AI (walk SHOULD 4)', () => {
  const unjudged = (): ShareCandidate[] => [
    cand('quote-maker', 'quote-maker', 'other', 'unjudged'),
    cand('weekly-report', 'weekly-report', 'other', 'unjudged'),
    cand('standup', 'standup', 'other', 'command', { origin: 'command' }),
    cand('vendor-mail', 'vendor-mail', 'other', 'personal_path', { personalPath: true }),
    cand('crm-sync', 'crm-sync', 'excluded', 'secret', { detail: 'anthropic' }),
    cand('meeting-notes', 'meeting-notes', 'excluded', 'scripts'),
  ]
  for (const ai of ['none', 'failed'] as const) {
    test(`ai "${ai}": what was found is under "찾은 스킬 N개", not "그 밖에 · 나만 쓰는 것, 개발용"; 빠진 것 as it is; a command and a path keep their reason`, async () => {
      ccItems = [shareOf({ ai, candidates: unjudged(), createdAt: hourAgo() })]
      const m = await page(ID, 'admin')
      try {
        await m.until(() => m.find('skill-review')?.getAttribute('data-status') === 'ready', 'the list')
        expect(text(m, 'skill-review-no-ai')).toBe(ko('welcome.skills.noAi'))
        expect(text(m, 'skills-other-toggle')).toBe(ko('welcome.skills.unjudged', { n: 4 }))
        expect(text(m, 'skill-review')).not.toContain(ko('welcome.skills.otherHint'))
        expect(text(m, 'skill-review')).not.toContain(ko('welcome.skills.other', { n: 4 }))
        // open, nothing ticked
        expect(rows(m, 'other').map((r) => r.getAttribute('data-name'))).toEqual(['quote-maker', 'weekly-report', 'standup', 'vendor-mail'])
        expect(rows(m, 'other').every((r) => !(r.querySelector('input') as unknown as { checked: boolean }).checked)).toBe(true)
        expect(rowOf(m, 'quote-maker').textContent).toBe('quote-maker/quote-maker')
        expect(rowOf(m, 'standup').textContent).toContain(ko('welcome.skills.reason.command'))
        expect(rowOf(m, 'vendor-mail').textContent).toContain(ko('welcome.skills.reason.personal_path'))
        expect(text(m, 'skills-excluded-toggle')).toBe(`${ko('welcome.skills.excluded', { n: 2 })}· 비밀 키, 스크립트`)
      } finally { await m.unmount() }
    })
  }
  test('judged by the AI: the rows it put aside stay under "그 밖에 · 나만 쓰는 것, 개발용"', async () => {
    ccItems = [shareOf({ ai: 'done', createdAt: hourAgo() })]
    const m = await page(ID, 'admin')
    try {
      await m.until(() => m.find('skill-review')?.getAttribute('data-status') === 'ready', 'the list')
      expect(text(m, 'skills-other-toggle')).toBe(`${ko('welcome.skills.other', { n: 4 })}· ${ko('welcome.skills.otherHint')}`)
    } finally { await m.unmount() }
  })
})
