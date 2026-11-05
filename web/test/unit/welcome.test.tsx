// The welcome steps (docs/DECISIONS.md "W — Welcome steps", "X — Lean onboarding", "M — One meeting note, everyone's
// own tasks", "N — The first result is the company's card news", "W2 — AI connection first"), rendered and clicked
// against a small fake of the server's rules (tests/unit/b-onboarding-welcome.test.ts checks the server itself):
// - /welcome is the owner's: members and admins are sent Home; right after /setup the owner lands there;
// - without an AI that answers the owner, the AI step first (1/3 AI 연결: Claude 구독 연결, the other ways folded,
//   나중에 leaves the steps), never in front of the invite; with one, two steps (회사 소개 → 첫 결과); one quiet line
//   above the first: "팀 스킬을 넣어 둘게요 · 마케팅팀이에요" (the tap adds
//   the marketing pack, 취소 takes it back); leaving the first step sets the team up once (the general pack, the team's
//   group and folders) and installs the marketing pack once, only when asked; resuming never installs again;
// - the first result for every team, the company card news: files into the team's brand folder, the server starts the
//   result (its chat, the files to attach), then "/card-news …" with them in that chat; "자료 없이 만들게요": the same
//   without files (the server's 회사 소개.md attached); the server's refusal in its own words; AI gone by then: the AI
//   step comes back;
// - the chat of the first result: with the lead's team files, "마음에 드시나요? 팀 스킬로 저장하면 …" and the team skill
//   card (docs/DECISIONS.md "S"), then the invite with that skill; with the ad copy, the invite;
//   Home offers to continue until finished or hidden;
// - the company profile step (D) shows A's connect button instead of starting a draft that cannot run.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { act } from 'react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { GENERAL_BRIEF_SKILL, GENERAL_CARDNEWS_SKILL, GENERAL_TASKS_SKILL, uuidv7, WELCOME_RESULT_SKILL, type Attachment, type SkillInfo, type TeamGroupRef, type WelcomeProgress, type WelcomeUpdate } from '@mycel/shared/api'
import { useChats } from '../../src/store/chats'
import { translate, useLocaleStore } from '../../src/i18n'
import Welcome from '../../src/pages/Welcome'
import { Setup } from '../../src/pages/Auth'
import { AfterSetup } from '../../src/App'
import { WelcomeInviteBar } from '../../src/components/onboarding/WelcomeInviteBar'
import { forgetSkillDrafts } from '../../src/components/onboarding/SkillShareCard'
import { WelcomeResume } from '../../src/components/onboarding/WelcomeResume'
import ProfileStep from '../../src/components/onboarding/ProfileStep'
import { countedSteps, doneCount, isBriefSwitch, nextStep, packsRecorded, prevStep, readNotesHint, resultStarter, resumeStep, showInviteBar, showResume, skillNameOf, stepTotal, teamReach, wantsPack, wantsTeam } from '../../src/lib/welcome'
import { rememberSetupSite, setupSite } from '../../src/lib/setupLink'
import { useAiAccess } from '../../src/store/aiAccess'
import { useSession } from '../../src/store/session'
import { useWelcome } from '../../src/store/welcome'
import { FakeEvent, installDom, mount, removeDom, type FakeElement, type Mounted } from './dom-host'

const CHAT = '01900000-0000-7000-8000-0000000000c1'
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const meOf = (role: 'owner' | 'admin' | 'member') => ({
  user: { id: 'olga', username: 'olga', name: '올가', email: null, role, locale: 'ko', localeChoice: null, mustChangePassword: false, prefs: {} },
  groups: [], team: { name: 'Acme', defaultLocale: 'ko' },
  session: { id: '01900000-0000-7000-8000-00000000000a', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' }, server: { version: '0', dev: true },
})
const adCopy: SkillInfo = {
  path: WELCOME_RESULT_SKILL, name: 'ad-copy', title: '광고 문구', description: '광고 문구 — 알릴 제품과 실을 곳을 받아 3안을 써요', inputs: [
    { name: 'product', label: '알릴 제품·서비스', required: true, prefill: 'company.products' },
    { name: 'channel', label: '어디에 실을까요', type: 'choice', default: 'instagram', options: [{ value: 'instagram', label: '인스타그램 피드' }, { value: 'search', label: '네이버 검색광고' }, { value: 'banner', label: '카카오 배너' }, { value: 'sms', label: '문자' }] },
    { name: 'audience', label: '누구에게 알리나요', prefill: 'company.audience', advanced: true },
    { name: 'tone', label: '말투', advanced: true },
  ],
}
const fresh = (): WelcomeProgress => ({
  startedAt: '2026-11-04T00:00:00.000Z', updatedAt: '2026-11-04T00:00:00.000Z', teamType: null,
  steps: { profile: null, result: null, invite: null }, pack: null, resultChatId: null, inviteShownAt: null, site: null, dismissedAt: null, finishedAt: null,
})
const PACK = { id: 'marketing' as const, at: '2026-11-04T00:00:00.000Z', skillPath: WELCOME_RESULT_SKILL }
const GENERAL = { at: '2026-11-04T00:00:00.000Z', tasksPath: GENERAL_TASKS_SKILL, briefPath: GENERAL_BRIEF_SKILL, cardNewsPath: GENERAL_CARDNEWS_SKILL }
const TEAM: TeamGroupRef = { id: '01900000-0000-7000-8000-0000000000e1', name: 'Acme', folder: 'groups/Acme', notesFolder: 'groups/Acme/회의록', brandFolder: 'groups/Acme/브랜드' }
const INTRO = 'groups/Acme/브랜드/회사 소개.md'
const QUESTION = '/card-news 우리 회사 홍보 카드뉴스 5장 만들어 줘'
/** the team set up and the first step behind: the files step */
const atResult = (over: Partial<WelcomeProgress> = {}): WelcomeProgress => ({ ...fresh(), general: GENERAL, teamGroup: TEAM, steps: { profile: 'done', result: null, invite: null }, ...over })

// ---- a fake of the server: the progress row (the server's rules in short) and the few other answers the steps need
let progress: WelcomeProgress | null = null
let ai = { usable: true, action: 'connect_team', requested: false }
let calls: { key: string; body: any }[] = []
let packStatus: 'created' | 'blocked' = 'created'
let teamBlocked = false
/** uploads that fail before one works (a retry then goes through) */
let failUploads = 0
/** the first result refused (no profile and no website yet, say), in the server's words */
let firstResultRefusal: string | null = null
/** attaching that fails before one works */
let failAttach = 0
function apply(u: WelcomeUpdate): WelcomeProgress {
  const p = progress ?? fresh()
  if (u.teamType) p.teamType = u.teamType
  if (u.resultChatId) p.resultChatId = u.resultChatId
  if (u.step && (u.step.state === 'done' || p.steps[u.step.id] !== 'done')) p.steps[u.step.id] = u.step.state
  if (u.step?.id === 'result' && u.step.state === 'done' && p.steps.invite === 'skipped') p.steps.invite = null
  if (u.inviteShown) p.inviteShownAt ??= '2026-11-04T00:01:00.000Z'
  if (u.site) p.site = u.site
  if (u.dismissed !== undefined) p.dismissedAt = u.dismissed ? '2026-11-04T00:02:00.000Z' : null
  if (u.finish) {
    if (p.steps.result !== 'done') p.steps.result = 'skipped'
    p.steps.invite ??= 'skipped'
    p.finishedAt ??= '2026-11-04T00:03:00.000Z'
  }
  if (!p.finishedAt && p.steps.profile === 'done' && p.steps.result === 'done' && p.steps.invite) p.finishedAt = '2026-11-04T00:03:00.000Z'
  progress = { ...p, steps: { ...p.steps } }
  return progress
}
const routes: Record<string, (body: any) => Response> = {
  'GET /api/onboarding/welcome': () => json(200, { progress }),
  'PATCH /api/onboarding/welcome': (b) => json(200, { progress: apply(b) }),
  'POST /api/onboarding/welcome/pack': () => {
    const p = apply({})
    if (p.pack) return json(200, { progress: p, install: null, outcome: 'already' })
    const install = { pack: 'marketing', locale: 'ko', skills: [{ name: 'ad-copy', path: WELCOME_RESULT_SKILL, status: packStatus }, { name: 'seo-brief', path: 'skills/marketing/seo-brief/SKILL.md', status: packStatus }], folders: [] }
    // folder rules kept the first-result skill out: nothing recorded
    if (packStatus === 'blocked') return json(200, { progress: p, install, outcome: 'blocked' })
    progress = { ...p, pack: PACK }
    return json(200, { progress, install, outcome: 'installed' })
  },
  'POST /api/onboarding/welcome/team': () => {
    const p = apply({})
    if (p.general && p.teamGroup?.brandFolder) return json(200, { progress: p, install: null, outcome: 'already' })
    const install = { pack: 'general', locale: 'ko', skills: [{ name: 'meeting-tasks', path: GENERAL_TASKS_SKILL, status: teamBlocked ? 'blocked' : 'created' }], folders: [] }
    // a group recorded before the brand folder keeps its folders and gets the brand folder
    progress = { ...p, teamGroup: { ...(p.teamGroup ?? TEAM), brandFolder: TEAM.brandFolder }, general: teamBlocked ? null : GENERAL }
    return json(200, { progress, install, outcome: teamBlocked ? 'blocked' : 'installed' })
  },
  'POST /api/onboarding/welcome/first-result': (b) => {
    if (firstResultRefusal) return json(409, { error: { code: 'conflict', message: firstResultRefusal } })
    return json(201, { chatId: CHAT, title: '우리 회사 홍보 카드뉴스', skillPath: GENERAL_CARDNEWS_SKILL, files: b.files.length ? b.files : [INTRO], intro: b.files.length ? null : INTRO, imagesFolder: 'groups/Acme/브랜드/이미지', images: [] })
  },
  [`GET /api/chats/${CHAT}`]: () => json(200, { id: CHAT, projectId: null, title: '우리 회사 홍보 카드뉴스', engine: 'claude-code', model: null, createdAt: '2026-11-04T00:00:00.000Z', updatedAt: '2026-11-04T00:00:00.000Z', deletedAt: null, runState: 'idle' }),
  'POST /api/files/upload': (b) => {
    if (failUploads > 0) { failUploads--; return json(500, { error: { code: 'internal', message: '저장하지 못했어요' } }) }
    const path = `${b.folder}/${b.name}`
    return json(201, { name: b.name, path, type: 'file', size: Number(b.size), mtime: '2026-11-04T00:00:00.000Z', mime: 'text/markdown', access: 'write' })
  },
  'POST /api/attachments/team-file': (b) => failAttach-- > 0 ? json(500, { error: { code: 'internal', message: '붙이지 못했어요' } }) : json(201, { id: uuidv7(), name: b.path.slice(b.path.lastIndexOf('/') + 1), path: b.path, size: 10, mime: 'text/markdown', kind: 'text', source: 'team' } satisfies Attachment),
  'GET /api/me/ai-access': () => json(200, ai),
  // the AI step's dialog reads the team's ways to connect (Admin › AI connections)
  'GET /api/admin/credentials': () => json(200, { items: [], memberOwn: false, sharedSubscriptions: true, allowedKinds: ['anthropic-oauth', 'anthropic-api-key', 'chatgpt', 'openai-api-key'], pricesAsOf: '2026-11-01', anthropicGateway: null }),
  'GET /api/onboarding/profile': () => json(200, { profile: null }),
  'GET /api/skills': () => json(200, { items: [adCopy] }),
  'POST /api/chats': () => json(201, { id: CHAT, projectId: null, title: '', engine: 'claude-code', model: null, createdAt: '2026-11-04T00:00:00.000Z', updatedAt: '2026-11-04T00:00:00.000Z', deletedAt: null, runState: 'idle' }),
  'GET /api/admin/groups': () => json(200, { items: [] }),
  'GET /api/admin/team-link': () => json(200, { link: null, seats: { used: 1, limit: null } }),
  'POST /api/admin/team-link': (b) => json(201, {
    link: { id: '01900000-0000-7000-8000-000000000001', url: 'https://acme.example/join#t=x', groupIds: b.groupIds, skill: b.skillPath ? { path: b.skillPath, name: 'ad-copy' } : null, starter: b.starter ? { kind: b.starter.kind, files: b.starter.files.length } : null, maxUses: 20, uses: 0, createdBy: { id: 'olga', name: '올가' }, createdAt: '2026-11-04T00:00:00.000Z', expiresAt: '2026-11-18T00:00:00.000Z', state: 'active' },
    seats: { used: 1, limit: null },
  }),
}
const called = (key: string) => calls.filter((c) => c.key === key)

/** what a request body carries: JSON, or a form's text fields (an upload) */
function bodyOf(body: unknown): any {
  if (typeof body === 'string') return JSON.parse(body)
  if (body instanceof FormData) return Object.fromEntries([...body.entries()].filter(([, v]) => typeof v === 'string'))
  return undefined
}

/** An upload with its progress goes through XMLHttpRequest (lib/xhr.ts): this one answers from the same routes. */
class FakeXHR {
  status = 0
  response: Blob | null = null
  responseType = ''
  withCredentials = false
  upload: { onprogress: ((e: unknown) => void) | null; onload: (() => void) | null } = { onprogress: null, onload: null }
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  private method = 'GET'
  private url = ''
  private headers: Record<string, string> = {}
  private type: string | null = null
  open(method: string, url: string) { this.method = method; this.url = url }
  setRequestHeader(k: string, v: string) { this.headers[k] = v }
  getResponseHeader(k: string) { return k.toLowerCase() === 'content-type' ? this.type : null }
  abort() { this.onabort?.() }
  send(body: unknown) {
    void (async () => {
      const res = await globalThis.fetch(this.url, { method: this.method, headers: this.headers, body: body as BodyInit })
      this.status = res.status
      this.type = res.headers.get('content-type')
      this.response = await res.blob()
      this.upload.onload?.()
      this.onload?.()
    })()
  }
}

const realFetch = globalThis.fetch
const localeBefore = useLocaleStore.getState().locale
const sessionBefore = { status: useSession.getState().status, signedIn: useSession.getState().signedIn }
const g = globalThis as Record<string, unknown>
const was = { location: Object.getOwnPropertyDescriptor(g, 'location'), history: Object.getOwnPropertyDescriptor(g, 'history'), XMLHttpRequest: Object.getOwnPropertyDescriptor(g, 'XMLHttpRequest') }
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'ko' })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input).split('?')[0]}`
    const body = bodyOf(init?.body)
    calls.push({ key, body })
    return routes[key]?.(body) ?? json(404, { error: { code: 'not_found', message: `no route ${key}` } })
  }) as unknown as typeof fetch
  Object.defineProperty(g, 'history', { configurable: true, writable: true, value: { state: null, replaceState: () => {} } })
  Object.defineProperty(g, 'XMLHttpRequest', { configurable: true, writable: true, value: FakeXHR })
})
afterEach(() => {
  progress = null
  ai = { usable: true, action: 'connect_team', requested: false }
  calls = []
  packStatus = 'created'
  teamBlocked = false
  failUploads = 0
  firstResultRefusal = null
  failAttach = 0
  useWelcome.getState().reset()
  useAiAccess.getState().reset()
  // a first-result message this file sent stays "sending" in the chats store: the files after this one (the reload
  // guard) must not see it
  useChats.setState({ threads: {} })
  sessionStorage.clear()
})
afterAll(() => {
  globalThis.fetch = realFetch
  for (const [k, d] of Object.entries(was)) { if (d) Object.defineProperty(g, k, d); else delete g[k] }
  useSession.setState(sessionBefore as never)
  useLocaleStore.setState({ locale: localeBefore })
  removeDom()
})

const signIn = (role: 'owner' | 'admin' | 'member') => useSession.setState({ status: { kind: 'signed-in', me: meOf(role) } } as never)
function Where() { const l = useLocation(); return <p data-testid="where" data-state={JSON.stringify(l.state ?? null)}>{l.pathname + l.search}</p> }
const at = (m: Mounted) => m.find('where')?.textContent
const app = (start = '/welcome') => mount(
  <MemoryRouter initialEntries={[start]}>
    <Routes>
      <Route path="/welcome" element={<Welcome />} />
      <Route path="*" element={<Where />} />
    </Routes>
  </MemoryRouter>,
)
const stepOf = (m: Mounted) => m.container.querySelector('[data-step]')?.getAttribute('data-step')
const laterButton = () => (globalThis.document as any).body.querySelectorAll('button').find((b: any) => b.textContent === translate('ko', 'welcome.later'))
/** what choosing files in the picker does: the input's files, then its change event */
async function choose(m: Mounted, files: File[]) {
  const input = m.get('welcome-files-input') as FakeElement
  Object.defineProperty(input, 'files', { configurable: true, value: files })
  await act(async () => { input.dispatchEvent(new FakeEvent('change', { bubbles: true })) })
}
const note = (name: string, text = '# Acme 회사 소개\n- 조용한 책상 선풍기\n') => new File([text], name, { type: 'text/markdown' })

describe('where the steps go', () => {
  test('resume: the first open step, then a put-off one; after a step, only open steps ahead of it', () => {
    expect(resumeStep(null)).toBe('profile')
    expect(stepTotal()).toBe(2)
    const p = fresh()
    p.steps = { profile: 'skipped', result: null, invite: null }
    expect(resumeStep(p)).toBe('result')
    expect(nextStep(p, 'profile')).toBe('result')
    p.steps = { profile: 'skipped', result: 'done', invite: 'skipped' }
    // everything has an answer: "later" is now, the put-off profile comes back from Home
    expect(resumeStep(p)).toBe('profile')
    // but never straight after putting off the invite (Home instead)
    expect(nextStep(p, 'invite')).toBeNull()
    expect(doneCount(p)).toBe(1)
    expect(showResume(p)).toBe(true)
    expect(showResume({ ...p, dismissedAt: 'x' })).toBe(false)
    expect(showResume({ ...p, finishedAt: 'x' })).toBe(false)
    expect(resumeStep({ ...p, finishedAt: 'x' })).toBeNull()
    expect(showInviteBar({ ...p, resultChatId: CHAT, steps: { ...p.steps, invite: null } }, CHAT)).toBe(true)
    expect(showInviteBar({ ...p, resultChatId: CHAT }, CHAT)).toBe(false)
    expect(showInviteBar({ ...p, resultChatId: CHAT, steps: { ...p.steps, invite: null } }, 'other')).toBe(false)
  })

  test('the AI step: first while no AI answers the owner, whatever else is open; counted then, and after it was done there', () => {
    // no AI: the AI step, from the very first visit and from any step left open
    expect(resumeStep(null, false)).toBe('ai')
    const p = fresh()
    expect(resumeStep(p, false)).toBe('ai')
    p.steps = { profile: 'done', result: null, invite: null }
    expect(resumeStep(p, false)).toBe('ai')
    expect(countedSteps(p, false)).toEqual(['ai', 'profile', 'result'])
    expect(stepTotal(p, false)).toBe(3)
    expect(doneCount(p, false)).toBe(1)
    // a finished row stays finished
    expect(resumeStep({ ...p, finishedAt: 'x' }, false)).toBeNull()
    // after the AI step: the first open step after it; never back to it
    const q = fresh()
    q.steps = { ai: 'done', profile: null, result: null, invite: null }
    expect(nextStep(q, 'ai')).toBe('profile')
    expect(prevStep('profile')).toBeNull()
    expect(prevStep('ai')).toBeNull()
    expect(prevStep('result')).toBe('profile')
    // connected there: still counted ("1/3 AI 연결" stays done), two steps left; shown and not connected yet: counted
    expect(countedSteps(q, true)).toEqual(['ai', 'profile', 'result'])
    expect(countedSteps({ ...q, steps: { ...q.steps, ai: 'skipped' } }, true)).toEqual(['ai', 'profile', 'result'])
    expect(doneCount(q, true)).toBe(1)
    expect(resumeStep(q, true)).toBe('profile')
    // AI from the start (a hosted trial credit, a managed engine, a working connection): two steps, no AI step
    expect(countedSteps(fresh(), true)).toEqual(['profile', 'result'])
    expect(resumeStep(fresh(), true)).toBe('profile')
    expect(stepTotal(fresh(), true)).toBe(2)
  })

  test('without AI, only the invite left: the invite, never the AI step in front of it; the bar has two steps', () => {
    // 회사 소개 and 첫 결과 answered (done or put off), the invite open: AI is not needed for it
    for (const steps of [{ profile: 'done', result: 'done', invite: null }, { profile: 'skipped', result: 'skipped', invite: null }, { profile: 'done', result: 'skipped', invite: null }] as const) {
      const p = { ...fresh(), steps: { ...steps } }
      expect(resumeStep(p, false)).toBe('invite')
      expect(resumeStep(p, true)).toBe('invite')
      expect(countedSteps(p, false)).toEqual(['profile', 'result'])
      expect(stepTotal(p, false)).toBe(2)
    }
    // shown before: the bar keeps it
    expect(countedSteps({ ...fresh(), steps: { ai: 'skipped', profile: 'done', result: 'done', invite: null } }, false)).toEqual(['ai', 'profile', 'result'])
    // everything answered, a counted step put off: "later" is now, and that step needs AI
    expect(resumeStep({ ...fresh(), steps: { profile: 'done', result: 'skipped', invite: 'skipped' } }, false)).toBe('ai')
    expect(resumeStep({ ...fresh(), steps: { profile: 'done', result: 'skipped', invite: 'skipped' } }, true)).toBe('result')
    // all done: nothing to resume, with or without AI
    expect(resumeStep({ ...fresh(), steps: { profile: 'done', result: 'done', invite: 'done' } }, false)).toBeNull()
  })

  test('who sees the team folder: its group and the owners and admins, active ones; members outside it can be added', () => {
    const u = (id: string, role: 'owner' | 'admin' | 'member', status: 'active' | 'disabled' = 'active') => ({ id, role, status })
    const users = [u('olga', 'owner'), u('ada', 'admin'), u('mia', 'member'), u('jun', 'member'), u('ha', 'member'), u('old', 'member', 'disabled')]
    expect(teamReach(users, ['olga', 'mia', 'old'])).toEqual({ viewers: 3, outside: ['jun', 'ha'] })
    expect(teamReach([u('olga', 'owner')], ['olga'])).toEqual({ viewers: 1, outside: [] })
  })

  test('the packs: every team gets its start; the marketing pack only when asked for, and never by default', () => {
    // no answer is the general pack only (it used to read as marketing)
    expect(wantsPack(fresh())).toBe(false)
    expect(wantsPack({ ...fresh(), teamType: 'marketing' })).toBe(true)
    expect(wantsPack({ ...fresh(), teamType: 'sales' })).toBe(false)
    expect(wantsPack({ ...fresh(), teamType: 'other' })).toBe(false)
    expect(wantsPack({ ...fresh(), teamType: 'marketing', pack: PACK })).toBe(false)
    expect(wantsPack({ ...fresh(), teamSkipped: true })).toBe(false)
    expect(wantsPack(null)).toBe(false)
    expect(wantsTeam(fresh())).toBe(true)
    expect(wantsTeam({ ...fresh(), general: GENERAL })).toBe(true)
    expect(wantsTeam({ ...fresh(), teamGroup: TEAM })).toBe(true)
    expect(wantsTeam({ ...fresh(), general: GENERAL, teamGroup: TEAM })).toBe(false)
    // a group recorded before the brand folder existed: the start runs again (and adds it)
    expect(wantsTeam({ ...fresh(), general: GENERAL, teamGroup: { ...TEAM, brandFolder: undefined } })).toBe(true)
    expect(wantsTeam(null)).toBe(false)
    // the line above the first step goes once what it promised is recorded
    expect(packsRecorded(fresh())).toBe(false)
    expect(packsRecorded({ ...fresh(), general: GENERAL })).toBe(true)
    expect(packsRecorded({ ...fresh(), general: GENERAL, teamType: 'marketing' })).toBe(false)
    expect(packsRecorded({ ...fresh(), general: GENERAL, teamType: 'marketing', pack: PACK })).toBe(true)
    // the name a skill runs by
    expect(skillNameOf(GENERAL_TASKS_SKILL)).toBe('meeting-tasks')
    expect(skillNameOf(GENERAL_CARDNEWS_SKILL)).toBe('card-news')
    expect(skillNameOf('skills/할-일.md')).toBe('할-일')
    expect(skillNameOf(null)).toBe('meeting-tasks')
  })

  test('the skill\'s "not meeting notes" sentence, whatever the punctuation, near the start only', () => {
    expect(isBriefSwitch('회의록이 아니라서 핵심만 정리했어요.\n\n## 핵심\n- 가격 정책 변경')).toBe(true)
    expect(isBriefSwitch('회의록이 아니라서, 핵심만 정리했어요!')).toBe(true)
    expect(isBriefSwitch("These aren't meeting notes, so here is the gist.")).toBe(true)
    expect(isBriefSwitch('These aren’t meeting notes — the key points:')).toBe(true)
    expect(isBriefSwitch('## 민지\n- 시안 금요일까지')).toBe(false)
    expect(isBriefSwitch(`${'가'.repeat(400)} 회의록이 아니라서 핵심만 정리했어요`)).toBe(false)
  })

  test('what the invite carries: the first question\'s team files (still there), and tasks or a brief', () => {
    const team = (path: string, over: Partial<Attachment> = {}): Attachment => ({ id: uuidv7(), name: path.split('/').at(-1)!, path, size: 1, mime: 'text/markdown', kind: 'text', source: 'team', ...over })
    const upload: Attachment = { id: uuidv7(), name: 'x.png', path: 'users/olga/.attachments/x.png', size: 1, mime: 'image/png', kind: 'image' }
    const question = { role: 'user' as const, content: '/meeting-tasks …', attachments: [team('groups/Acme/회의록/a.md'), team('groups/Acme/회의록/b.md'), team('', { unavailable: true }), upload] }
    expect(resultStarter([question, { role: 'assistant', content: '## 민지\n- 시안', attachments: [] }])).toEqual({ kind: 'tasks', files: ['groups/Acme/회의록/a.md', 'groups/Acme/회의록/b.md'] })
    expect(resultStarter([question, { role: 'assistant', content: '회의록이 아니라서 핵심만 정리했어요.', attachments: [] }])?.kind).toBe('brief')
    expect(resultStarter([{ role: 'user', content: '/ad-copy', attachments: [upload] }, { role: 'assistant', content: '3안', attachments: [] }])).toBeNull()
    expect(readNotesHint({ welcomeNotes: { folder: 'groups/Acme', team: 'Acme' } })).toEqual({ folder: 'groups/Acme', team: 'Acme' })
    expect(readNotesHint(null)).toBeNull()
    expect(readNotesHint({ welcomeNotes: { folder: '' } })).toBeNull()
  })
})

describe('/welcome', () => {
  test('only the owner: a member or an admin is sent Home without asking the server', async () => {
    for (const role of ['member', 'admin'] as const) {
      signIn(role)
      const m = await app()
      try {
        await m.until(() => at(m) === '/', `${role} sent Home`)
        expect(m.find('welcome')).toBeNull()
        expect(called('GET /api/onboarding/welcome')).toEqual([])
      } finally { await m.unmount() }
    }
  })

  test('right after /setup the owner lands on the steps (the setup link\'s website kept for the profile step)', async () => {
    Object.defineProperty(g, 'location', { configurable: true, writable: true, value: { pathname: '/setup', search: '', hash: '#token=setup-token-0123&team=Acme&site=acme.example', origin: 'https://acme.example' } })
    useSession.setState({ status: { kind: 'setup' }, signedIn: (me: unknown) => useSession.setState({ status: { kind: 'signed-in', me } } as never) } as never)
    routes['POST /api/setup'] = () => json(201, { me: meOf('owner') })
    // like App.tsx's Gate: the setup page while there is no team, the signed-in routes after
    function Gate() {
      const status = useSession((s) => s.status)
      return status.kind === 'signed-in'
        ? <Routes><Route path="/setup" element={<AfterSetup />} /><Route path="*" element={<Where />} /></Routes>
        : <Routes><Route path="*" element={<Setup />} /></Routes>
    }
    const m = await mount(<MemoryRouter initialEntries={['/setup']}><Gate /></MemoryRouter>)
    try {
      const doc = globalThis.document as unknown as { body: { querySelector: (s: string) => any; querySelectorAll: (s: string) => any[] } }
      await m.type('setup-team', 'Acme')
      await m.type(doc.body.querySelector('input[autocomplete="name"]'), '올가')
      await m.type(doc.body.querySelector('input[autocomplete="username"]'), 'olga')
      for (const pw of doc.body.querySelectorAll('input[autocomplete="new-password"]')) await m.type(pw, 'a long password 1')
      await m.click(doc.body.querySelector('button[type="submit"]'))
      await m.until(() => at(m) === '/welcome', 'the welcome steps')
      expect(called('POST /api/setup')).toHaveLength(1)
      expect(setupSite()).toBe('https://acme.example/')
    } finally {
      await m.unmount()
      delete routes['POST /api/setup']
      delete g.location
    }
  })

  test('the line: team skills for every team; 마케팅팀이에요 adds the marketing pack, 취소 takes it back; leaving the first step sets the team up and installs it, once; resuming never installs again', async () => {
    signIn('owner')
    rememberSetupSite('https://acme.example/')
    let m = await app()
    try {
      await m.until(() => stepOf(m) === 'profile', 'step 1')
      // the first visit started the progress on the server, with the setup link's website (for any device)
      expect(called('PATCH /api/onboarding/welcome')[0]!.body).toEqual({ site: 'https://acme.example/' })
      expect(m.get('welcome-progress').textContent).toContain('1/2 회사 소개')
      expect(m.get('welcome-progress').textContent).toContain('2/2 첫 결과')
      // one line, no chooser of team types
      expect(m.get('welcome-pack-line').textContent).toBe('팀 스킬을 넣어 둘게요 · 마케팅팀이에요')
      expect(m.find('welcome-team')).toBeNull()
      expect(m.html()).not.toContain('준비 중')
      await m.click('welcome-marketing')
      await m.until(() => m.find('welcome-marketing-cancel'), 'the marketing promise')
      expect(progress!.teamType).toBe('marketing')
      expect(m.get('welcome-pack-line').textContent).toBe('팀 스킬과 마케팅 스킬 7개를 넣어 둘게요 · 취소')
      // 취소 takes it back (the type "other": not marketing), and the tap again adds it once more
      await m.click('welcome-marketing-cancel')
      await m.until(() => m.find('welcome-marketing'), 'back to the team skills only')
      expect(progress!.teamType).toBe('other')
      await m.click('welcome-marketing')
      await m.until(() => progress!.teamType === 'marketing', 'marketing again')
      expect(called('POST /api/onboarding/welcome/pack')).toEqual([])
      expect(called('POST /api/onboarding/welcome/team')).toEqual([])
      // "나중에 하기" on the profile: the team's start and the marketing pack go in (once), on to the first result
      await m.until(() => m.find('profile-step-site'), 'the profile step (D)')
      await m.click(laterButton())
      await m.until(() => stepOf(m) === 'result', 'step 2')
      expect(called('POST /api/onboarding/welcome/team')).toHaveLength(1)
      expect(called('POST /api/onboarding/welcome/pack')).toHaveLength(1)
      expect(progress!.general).toEqual(GENERAL)
      expect(progress!.teamGroup).toEqual(TEAM)
      expect(progress!.pack).toEqual(PACK)
      expect(progress!.steps.profile).toBe('skipped')
      expect(m.find('welcome-progress')!.querySelector('[aria-current="step"]')!.textContent).toContain('2/2 첫 결과')
      // every team's first result: the team's files
      await m.until(() => m.find('welcome-files-pick'), 'the files step')
    } finally { await m.unmount() }
    sessionStorage.clear()

    // another device: the progress comes from the server, the steps open on the first result
    useWelcome.getState().reset()
    calls = []
    m = await app()
    try {
      await m.until(() => stepOf(m) === 'result', 'resumed on step 2')
      // back to step 1: the website came from the server's copy, the packs are in (no line), leaving again installs nothing
      await m.click('welcome-back')
      await m.until(() => m.find('profile-step-site'), 'the profile step')
      expect((m.get('profile-step-site').querySelector('input[inputmode="url"]') as unknown as { value: string }).value).toBe('https://acme.example/')
      expect(m.find('welcome-pack-line')).toBeNull()
      await m.click(laterButton())
      await m.until(() => stepOf(m) === 'result', 'step 2 again')
      expect(called('POST /api/onboarding/welcome/pack')).toEqual([])
      expect(called('POST /api/onboarding/welcome/team')).toEqual([])
    } finally { await m.unmount() }
  })

  test('no marketing (no answer, another type from before, or a team question put off): leaving sets the team up, no marketing pack', async () => {
    for (const start of [fresh(), { ...fresh(), teamType: 'operations' as const }, { ...fresh(), teamSkipped: true }]) {
      signIn('owner')
      progress = start
      const m = await app()
      try {
        await m.until(() => m.find('welcome-pack-line'), 'the line')
        expect(m.get('welcome-pack-line').textContent).toBe('팀 스킬을 넣어 둘게요 · 마케팅팀이에요')
        await m.until(() => m.find('profile-step-site'), 'the profile step (D)')
        await m.click(laterButton())
        await m.until(() => m.find('welcome-files-pick'), 'the files step')
        expect(called('POST /api/onboarding/welcome/team')).toHaveLength(1)
        expect(called('POST /api/onboarding/welcome/pack')).toEqual([])
        // the type is never set to marketing by itself
        expect(progress!.teamType).toBe(start.teamType)
      } finally { await m.unmount() }
      useWelcome.getState().reset()
      calls = []
    }
  })

  test('the first result: the files go into the team\'s brand folder, the server starts the card news, "/card-news …" goes into its chat with the files, recorded', async () => {
    signIn('owner')
    progress = atResult()
    failUploads = 1
    const m = await app()
    try {
      await m.until(() => m.find('welcome-files-pick'), 'the files step')
      expect(m.html()).toContain('회사 소개서나 팀 소개 자료가 있으면 놓아 주세요')
      expect(m.html()).toContain('없으면 홈페이지에서 찾은 내용으로 만들게요')
      // one primary: pick files; who sees what in one quiet line; a text link without files
      expect(m.get('welcome-files-pick').textContent).toContain('파일 고르기')
      expect(m.get('welcome-files-who').textContent).toBe('여기 올린 파일은 Acme만 봐요 · 채팅은 각자만 봐요')
      expect(m.get('welcome-files-none').textContent).toBe('자료 없이 만들게요')
      expect(m.container.querySelectorAll('button').filter((b) => (b.getAttribute('class') ?? '').includes('bg-accent ')).length).toBe(1)
      // no meeting notes, no ad copy here any more
      expect(m.html()).not.toContain('회의록')
      expect(m.find('skill-form')).toBeNull()
      // files only, several at once (phones pick files, not folders)
      expect(m.get('welcome-files-input').getAttribute('type')).toBe('file')
      // (React sets it as a property)
      expect((m.get('welcome-files-input') as unknown as { multiple: boolean }).multiple).toBe(true)
      expect(m.get('welcome-files-input').hasAttribute('webkitdirectory')).toBe(false)
      await choose(m, [note('회사 소개서.md'), note('팀 소개.md')])
      // the first upload fails: the files stay, "다시 시도" goes on with them
      await m.until(() => m.find('welcome-files-list') && m.html().includes('role="alert"'), 'the failure')
      expect(m.container.querySelectorAll('[data-testid="welcome-file"]').length).toBe(2)
      expect(called('POST /api/onboarding/welcome/first-result')).toEqual([])
      const retry = (globalThis.document as any).body.querySelectorAll('button').find((b: any) => b.textContent === translate('ko', 'common.retry'))
      await m.click(retry)
      await m.until(() => at(m) === `/c/${CHAT}`, 'the chat')
      // into groups/<team>/브랜드/, each once (the one that went up first is not sent again)
      const ups = called('POST /api/files/upload').map((c) => `${c.body.folder}/${c.body.name}`)
      expect(ups.filter((u) => u === 'groups/Acme/브랜드/회사 소개서.md').length + ups.filter((u) => u === 'groups/Acme/브랜드/팀 소개.md').length).toBe(3)
      expect(called('POST /api/files/upload').every((c) => c.body.onExists === 'rename')).toBe(true)
      // the server starts the result with the uploaded paths and makes the chat (the page makes none)
      expect(called('POST /api/onboarding/welcome/first-result').map((c) => c.body)).toEqual([{ files: ['groups/Acme/브랜드/회사 소개서.md', 'groups/Acme/브랜드/팀 소개.md'] }])
      expect(called('POST /api/chats')).toEqual([])
      expect(useChats.getState().chats.find((c) => c.id === CHAT)?.title).toBe('우리 회사 홍보 카드뉴스')
      // the files it named, attached by reference, and the card news skill with the lead's question
      expect(called('POST /api/attachments/team-file').map((c) => c.body)).toEqual([{ chatId: CHAT, path: 'groups/Acme/브랜드/회사 소개서.md' }, { chatId: CHAT, path: 'groups/Acme/브랜드/팀 소개.md' }])
      const sent = called(`POST /api/chats/${CHAT}/messages`)[0]?.body as { content: string; attachmentIds: string[] } | undefined
      expect(sent?.content).toBe(QUESTION)
      expect(sent?.attachmentIds).toHaveLength(2)
      expect(progress!.steps.result).toBe('done')
      expect(progress!.resultChatId).toBe(CHAT)
    } finally { await m.unmount() }
  })

  test('the line says how many see the team folder; members who joined before can be added in one quiet click', async () => {
    signIn('owner')
    progress = atResult()
    let members = ['olga']
    const user = (id: string, role: string, status = 'active') => ({ id, username: id, name: id, email: null, role, status, mustChangePassword: false, locale: 'ko', localeChoice: null, groupIds: members.includes(id) ? [TEAM.id] : [], createdAt: '2026-11-04T00:00:00.000Z', lastSeenAt: null })
    const saved = { groups: routes['GET /api/admin/groups']! }
    routes['GET /api/admin/users'] = () => json(200, { items: [user('olga', 'owner'), user('ada', 'admin'), user('jun', 'member'), user('ha', 'member'), user('old', 'member', 'disabled')], noAi: [] })
    routes['GET /api/admin/groups'] = () => json(200, { items: [{ id: TEAM.id, name: 'Acme', description: null, memberIds: members }] })
    routes[`PATCH /api/admin/groups/${TEAM.id}`] = (b) => { members = b.memberIds; return json(200, { id: TEAM.id, name: 'Acme', description: null, memberIds: members }) }
    const m = await app()
    try {
      // the owner and the admin see it; jun and ha joined before the group was made
      await m.until(() => m.get('welcome-files-who')?.textContent === '여기 올린 파일은 Acme 2명만 봐요 · 채팅은 각자만 봐요', 'the count')
      expect(m.get('welcome-files-add-members').textContent).toBe('지금 있는 팀원 2명도 넣기')
      // nobody is added by itself
      expect(called(`PATCH /api/admin/groups/${TEAM.id}`)).toEqual([])
      await m.click('welcome-files-add-members')
      await m.until(() => m.get('welcome-files-who')?.textContent === '여기 올린 파일은 Acme 4명만 봐요 · 채팅은 각자만 봐요', 'the new count')
      expect(called(`PATCH /api/admin/groups/${TEAM.id}`).map((c) => c.body)).toEqual([{ memberIds: ['olga', 'jun', 'ha'] }])
      expect(m.find('welcome-files-add-members')).toBeFalsy()
    } finally {
      await m.unmount()
      delete routes['GET /api/admin/users']
      delete routes[`PATCH /api/admin/groups/${TEAM.id}`]
      routes['GET /api/admin/groups'] = saved.groups
    }
  })

  test('up to ten files go up; an older row without the team\'s start, or whose group has no brand folder yet, sets it up first', async () => {
    for (const start of [{ ...fresh(), steps: { profile: 'done' as const, result: null, invite: null } }, atResult({ teamGroup: { ...TEAM, brandFolder: undefined } })]) {
      signIn('owner')
      progress = start
      const m = await app()
      try {
        await m.until(() => m.find('welcome-files-pick'), 'the files step')
        // the line names the team
        expect(m.get('welcome-files-who').textContent).toContain('Acme만 봐요')
        await choose(m, Array.from({ length: 12 }, (_, i) => note(`소개 ${i + 1}.md`)))
        await m.until(() => at(m) === `/c/${CHAT}`, 'the chat')
        expect(called('POST /api/onboarding/welcome/team')).toHaveLength(1)
        expect(called('POST /api/files/upload')).toHaveLength(10)
        expect(called('POST /api/files/upload').every((c) => c.body.folder === 'groups/Acme/브랜드')).toBe(true)
        expect(called('POST /api/onboarding/welcome/first-result')[0]!.body.files).toHaveLength(10)
        expect(called('POST /api/attachments/team-file')).toHaveLength(10)
      } finally { await m.unmount() }
      useWelcome.getState().reset()
      calls = []
    }
  })

  test('"자료 없이 만들게요": the same without files (the server\'s 회사 소개.md attached), with or without the marketing pack; nothing uploaded, the steps go on', async () => {
    for (const start of [atResult(), atResult({ teamType: 'marketing', pack: PACK })]) {
      signIn('owner')
      progress = start
      const m = await app()
      try {
        await m.until(() => m.find('welcome-files-none'), 'the text link')
        await m.click('welcome-files-none')
        await m.until(() => at(m) === `/c/${CHAT}`, 'the chat')
        expect(called('POST /api/onboarding/welcome/first-result').map((c) => c.body)).toEqual([{ files: [] }])
        expect(called('POST /api/files/upload')).toEqual([])
        expect(called('POST /api/attachments/team-file').map((c) => c.body)).toEqual([{ chatId: CHAT, path: INTRO }])
        expect((called(`POST /api/chats/${CHAT}/messages`)[0]?.body as { content: string }).content).toBe(QUESTION)
        // no ad copy form, and the steps are not ended by it
        expect(called('PATCH /api/onboarding/welcome').some((c) => c.body.finish)).toBe(false)
        expect(progress!.steps.result).toBe('done')
        expect(progress!.finishedAt).toBeNull()
      } finally { await m.unmount() }
      useWelcome.getState().reset()
      useChats.setState({ threads: {} })
      calls = []
    }
  })

  test('the server refuses (no profile and no website yet): its words in a note, nothing sent; 다시 시도 goes on, a later failure keeps the same chat', async () => {
    signIn('owner')
    progress = atResult()
    firstResultRefusal = '홈페이지나 회사 소개가 아직 없어요. 회사 소개를 먼저 해 주세요.'
    const m = await app()
    try {
      await m.until(() => m.find('welcome-files-none'), 'the text link')
      await m.click('welcome-files-none')
      await m.until(() => m.html().includes(firstResultRefusal!), 'the refusal')
      expect(called(`POST /api/chats/${CHAT}/messages`)).toEqual([])
      expect(called('POST /api/attachments/team-file')).toEqual([])
      expect(stepOf(m)).toBe('result')
      expect(progress!.steps.result).toBeNull()
      // a refusal later on: attaching fails once
      firstResultRefusal = null
      failAttach = 1
      const retry = () => (globalThis.document as any).body.querySelectorAll('button').find((b: any) => b.textContent === translate('ko', 'common.retry'))
      await m.click(retry())
      await m.until(() => m.html().includes('붙이지 못했어요'), 'the attach failure')
      expect(called('POST /api/onboarding/welcome/first-result')).toHaveLength(2)
      await m.click(retry())
      await m.until(() => at(m) === `/c/${CHAT}`, 'the chat')
      // the chat the server made is used again: no third start
      expect(called('POST /api/onboarding/welcome/first-result')).toHaveLength(2)
      expect(called('POST /api/onboarding/welcome/first-result').every((c) => c.body.files.length === 0)).toBe(true)
      expect(called(`POST /api/chats/${CHAT}/messages`)).toHaveLength(1)
    } finally { await m.unmount() }
  })

  test('no AI that answers the owner (self-hosted, no trial key): the AI step comes first (1/3), Claude 구독 연결 opens the browser sign-in, the other ways are folded; 나중에 leaves the steps', async () => {
    signIn('owner')
    ai = { usable: false, action: 'connect_team', requested: false }
    progress = fresh()
    const m = await app()
    try {
      await m.until(() => m.find('welcome-ai-claude'), 'the AI step')
      expect(stepOf(m)).toBe('ai')
      expect(m.html()).toContain(translate('ko', 'welcome.ai.title'))
      expect(m.html()).toContain(translate('ko', 'welcome.ai.why', { product: 'Trina AX' }).slice(-12))
      // three steps on the bar, the first one current
      const items = m.get('welcome-progress').querySelectorAll('li')
      expect(items.map((li: any) => li.getAttribute('data-progress-step'))).toEqual(['ai', 'profile', 'result'])
      expect(items[0]!.getAttribute('aria-current')).toBe('step')
      expect(items[0]!.textContent).toContain(translate('ko', 'welcome.progress.item', { n: 1, total: 3, label: translate('ko', 'welcome.progress.ai') }))
      // the other ways folded; nothing of the steps after it
      expect(m.get('welcome-ai-other').hasAttribute('open')).toBe(false)
      expect(m.find('welcome-files-pick')).toBeNull()
      expect(m.find('profile-step-site')).toBeNull()
      expect(m.find('welcome-back')).toBeNull()
      // the one button: the Claude sign-in dialog (Admin › AI connections' own), Claude already chosen
      await m.click('welcome-ai-claude')
      await m.until(() => (globalThis.document as any).body.querySelector('[data-testid="claude-login-how"]'), 'the Claude sign-in dialog')
      expect((globalThis.document as any).body.querySelector('[data-testid="kind-chatgpt"]')).toBeNull()
      // shown: recorded as needed, so the progress keeps the step once AI is connected anywhere
      await m.until(() => progress!.steps.ai === 'skipped', 'the AI step recorded as needed')
      // 나중에: out of the steps (Home keeps its connect line); nothing recorded for the step
      await act(async () => { (globalThis.document as any).body.querySelectorAll('button').find((b: any) => b.textContent === translate('ko', 'common.cancel'))?.click() })
      await m.click('welcome-later')
      await m.until(() => at(m) === '/', 'Home')
      expect(progress!.steps.ai).toBe('skipped')
      expect(progress!.steps.profile).toBeNull()
    } finally { await m.unmount() }
  })

  test('AI connected in the AI step: recorded once, then on to 회사 소개 (2/3); an owner with AI from the start sees two steps', async () => {
    signIn('owner')
    ai = { usable: false, action: 'connect_team', requested: false }
    progress = fresh()
    const m = await app()
    try {
      await m.until(() => m.find('welcome-ai-claude'), 'the AI step')
      // what the dialog's "done" leads to: AI answers now
      ai = { usable: true, action: 'connect_team', requested: false }
      await act(async () => { await useAiAccess.getState().load(true) })
      await m.until(() => stepOf(m) === 'profile', 'on to 회사 소개')
      expect(progress!.steps.ai).toBe('done')
      expect(called('PATCH /api/onboarding/welcome').filter((c) => c.body?.step?.id === 'ai').map((c) => c.body.step.state)).toEqual(['skipped', 'done'])
      // the bar keeps the AI step, done, and 2/3 is current
      const items = m.get('welcome-progress').querySelectorAll('li')
      expect(items.map((li: any) => li.getAttribute('data-progress-step'))).toEqual(['ai', 'profile', 'result'])
      expect(items[1]!.getAttribute('aria-current')).toBe('step')
    } finally { await m.unmount() }
    // AI connected elsewhere (Home's line, Admin) after the step was shown: opening the steps records it done
    progress = { ...fresh(), steps: { ai: 'skipped', profile: null, result: null, invite: null } }
    const m1 = await app()
    try {
      await m1.until(() => stepOf(m1) === 'profile', 'the profile step')
      expect(progress!.steps.ai).toBe('done')
    } finally { await m1.unmount() }
    // the same owner later, with AI: the bar keeps the AI step done once it was recorded
    progress = { ...fresh(), steps: { ai: 'done', profile: null, result: null, invite: null } }
    const m2 = await app()
    try {
      await m2.until(() => stepOf(m2) === 'profile', 'the profile step')
      const items = m2.get('welcome-progress').querySelectorAll('li')
      expect(items.map((li: any) => li.getAttribute('data-progress-step'))).toEqual(['ai', 'profile', 'result'])
      expect(items[1]!.getAttribute('aria-current')).toBe('step')
    } finally { await m2.unmount() }
    progress = fresh()
    const m3 = await app()
    try {
      await m3.until(() => stepOf(m3) === 'profile', 'the profile step')
      expect(m3.get('welcome-progress').querySelectorAll('li').map((li: any) => li.getAttribute('data-progress-step'))).toEqual(['profile', 'result'])
    } finally { await m3.unmount() }
  })

  test('AI gone by the first result (the trial credit used): the AI step holds the steps back, no picker', async () => {
    signIn('owner')
    ai = { usable: false, action: 'connect_team', requested: false }
    progress = atResult({ teamType: 'marketing', pack: PACK })
    const m = await app()
    try {
      await m.until(() => m.find('welcome-ai-claude'), 'the AI step')
      expect(stepOf(m)).toBe('ai')
      expect(m.find('welcome-files-pick')).toBeNull()
      expect(called('POST /api/onboarding/welcome/first-result')).toEqual([])
    } finally { await m.unmount() }
  })

  test('without AI, only the invite left (AI gone after the first result): the steps open on the invite, not the AI step', async () => {
    signIn('owner')
    ai = { usable: false, action: 'connect_team', requested: false }
    progress = atResult({ steps: { profile: 'done', result: 'done', invite: null }, resultChatId: CHAT })
    const m = await app()
    try {
      await m.until(() => stepOf(m) === 'invite', 'the invite')
      expect(m.find('welcome-ai')).toBeNull()
      expect(m.get('welcome-progress').querySelectorAll('li').map((li: any) => li.getAttribute('data-progress-step'))).toEqual(['profile', 'result'])
      // nothing recorded for the AI step: it was not shown
      await act(async () => { await new Promise((r) => setTimeout(r, 30)) })
      expect(progress!.steps.ai).toBeUndefined()
      expect(called('PATCH /api/onboarding/welcome').filter((c) => c.body?.step?.id === 'ai')).toEqual([])
    } finally { await m.unmount() }
  })

  test('the marketing pack blocked by folder rules: the step says so; the card news still works', async () => {
    signIn('owner')
    packStatus = 'blocked'
    progress = { ...fresh(), teamType: 'marketing' }
    const m = await app()
    try {
      await m.until(() => m.find('profile-step-site'), 'step 1')
      await m.click(laterButton())
      await m.until(() => m.html().includes(translate('ko', 'welcome.packBlocked')), 'the message')
      expect(stepOf(m)).toBe('result')
      expect(progress!.pack).toBeNull()
      expect(called('POST /api/onboarding/welcome/pack')).toHaveLength(1)
      // no install offer here: the card news does not need the marketing pack
      await m.until(() => m.find('welcome-files-none'), 'the files step')
      await m.click('welcome-files-none')
      await m.until(() => at(m) === `/c/${CHAT}`, 'the chat')
      expect(called('POST /api/onboarding/welcome/pack')).toHaveLength(1)
    } finally { await m.unmount() }
  })

  test('the general pack blocked: a pick says so and sends nothing', async () => {
    signIn('owner')
    teamBlocked = true
    progress = { ...fresh(), steps: { profile: 'done', result: null, invite: null } }
    const m = await app()
    try {
      await m.until(() => m.find('welcome-files-pick'), 'the files step')
      await choose(m, [note('회사 소개서.md')])
      await m.until(() => m.html().includes(translate('ko', 'welcome.packBlocked')), 'the message')
      expect(called('POST /api/files/upload')).toEqual([])
      expect(called('POST /api/onboarding/welcome/first-result')).toEqual([])
      expect(stepOf(m)).toBe('result')
    } finally { await m.unmount() }
  })
})

describe('after the first result', () => {
  const ran = (over: Partial<WelcomeProgress> = {}): WelcomeProgress => ({ ...fresh(), general: GENERAL, teamGroup: TEAM, resultChatId: CHAT, steps: { profile: 'done', result: 'done', invite: null }, ...over })
  const ask = (files: string[]) => ({ role: 'user' as const, content: '/meeting-tasks 이 회의록으로 이번 주 할 일, 사람별로 정리해 줘', attachments: files.map((path) => ({ id: uuidv7(), name: path.split('/').at(-1)!, path, size: 1, mime: 'text/markdown', kind: 'text' as const, source: 'team' as const })) })
  const FILES = ['groups/Acme/회의록/11월 1주 회의.md', 'groups/Acme/회의록/11월 2주 회의.md']
  const withGroup = () => { routes['GET /api/admin/groups'] = () => json(200, { items: [{ id: TEAM.id, name: 'Acme', description: null, memberIds: ['olga'] }] }) }
  afterEach(() => { routes['GET /api/admin/groups'] = () => json(200, { items: [] }) })

  const DRAFT = '01900000-0000-7000-8000-0000000000d1'
  const SHARED = { path: 'skills/general/juganhoeui-hal-il/SKILL.md', name: 'juganhoeui-hal-il', title: '주간 회의 할 일' }
  const CARD = {
    title: '주간회의 할 일', description: '팀 회의록에서 사람마다 할 일을 정리해요', recurring: true,
    inputs: [{ name: 'scope', label: '누구 할 일', type: 'choice', default: 'mine', options: [{ value: 'mine', label: '내 할 일' }, { value: 'all', label: '사람별' }] }],
    files: [{ path: 'groups/Acme/회의록', latest: true }],
  }
  /** the server's draft: running for the first read, then the card (or a failure) */
  const drafting = (end: { status: 'done' | 'failed'; draft?: unknown; problem?: string }, o: { rewrite?: boolean } = {}) => {
    let reads = 0
    routes['POST /api/onboarding/skill-draft'] = () => json(201, { draftChatId: DRAFT })
    // with `rewrite`: the second read says the first answer needs its rewrite (the card starts the draft again for it)
    routes[`GET /api/onboarding/skill-draft/${DRAFT}`] = () => json(200, ++reads < 2 ? { status: 'running', draft: null, problem: null, saved: null }
      : o.rewrite && reads === 2 ? { status: 'running', draft: null, problem: null, saved: null, rewrite: true }
      : { status: end.status, draft: end.draft ?? null, problem: end.problem ?? null, saved: null })
    routes[`POST /api/onboarding/skill-draft/${DRAFT}/save`] = () => json(200, SHARED)
  }
  afterEach(() => {
    forgetSkillDrafts()
    for (const k of Object.keys(routes)) if (k.includes('/skill-draft')) delete routes[k]
    routes['GET /api/admin/team-link'] = () => json(200, { link: null, seats: { used: 1, limit: null } })
  })

  test('the lead\'s files (the card news): "마음에 드시나요? 팀 스킬로 저장하면 …"; the card: six things, the title changed by a tap; shared, then the invite with that skill', async () => {
    signIn('owner')
    progress = ran()
    withGroup()
    drafting({ status: 'done', draft: CARD })
    // the card news question with the intro the server wrote attached
    const messages = [{ ...ask([INTRO]), content: QUESTION }, { role: 'assistant' as const, content: '카드뉴스 5장을 만들었어요', attachments: [] }]
    const m = await mount(<MemoryRouter><WelcomeInviteBar chatId={CHAT} answered messages={messages} /></MemoryRouter>)
    try {
      await m.until(() => m.find('welcome-invite-bar'), 'the bar')
      // the bar asks about the lead's way, not about inviting: one button and its X
      expect(m.get('welcome-invite-text').textContent).toBe('마음에 드시나요? 팀 스킬로 저장하면 다른 분들도 같은 방식으로 만들 수 있어요')
      expect(m.get('skill-share-open').textContent).toBe('팀 스킬로 저장')
      expect(m.find('welcome-invite-open')).toBeNull()
      await m.click('skill-share-open')
      expect(called('POST /api/onboarding/skill-draft').map((c) => c.body)).toEqual([{ chatId: CHAT }])
      await m.until(() => m.find('skill-share')?.getAttribute('data-state') === 'drafting', 'drafting')
      expect(m.get('skill-share').textContent).toContain('팀 스킬로 정리하는 중…')
      await m.until(() => m.find('skill-share')?.getAttribute('data-state') === 'ready', 'the card', 6000)
      // 1 the title (tap), 2 one line, 3 what teammates are asked (a choice: its chips, the default first), 4 the files
      expect(m.get('skill-share-title').textContent).toBe('주간회의 할 일')
      expect(m.get('skill-share-description').textContent).toBe('팀 회의록에서 사람마다 할 일을 정리해요')
      expect(m.find('skill-share-asks')).toBeNull()
      expect(m.get('skill-share-choice').textContent).toBe('누구 할 일내 할 일사람별')
      expect(m.get('skill-share-files').textContent).toBe('쓰는 자료:Acme 회의록 폴더의 가장 최근 회의록')
      // 5 [팀에 공유] 6 나중에, then the quiet line; no steps, no folder name, no slug
      expect(m.get('skill-share-share').textContent).toBe('팀에 공유')
      expect(m.get('skill-share-later').textContent).toBe('나중에')
      expect(m.get('skill-share-note').textContent).toBe('팀 전체 AI가 이 방식을 따라요 · 팀 스킬에서 언제든 고칠 수 있어요')
      expect(m.get('skill-share').textContent).not.toContain('juganhoeui')
      expect(m.get('skill-share').textContent).not.toContain('SKILL.md')
      await m.click('skill-share-title')
      await m.type('skill-share-title-input', '주간 회의 할 일')
      const input = m.get('skill-share-title-input')
      await act(async () => { input.dispatchEvent(new FakeEvent('keydown', { bubbles: true, key: 'Enter' })) })
      await m.until(() => m.find('skill-share-title'), 'the title back')
      await m.click('skill-share-share')
      await m.until(() => m.find('team-link-create'), 'the invite step')
      expect(called(`POST /api/onboarding/skill-draft/${DRAFT}/save`).map((c) => c.body)).toEqual([{ title: '주간 회의 할 일' }])
      // the link carries the new skill, no file list
      await m.click('team-link-create')
      await m.until(() => called('POST /api/admin/team-link').length, 'the link made')
      expect(called('POST /api/admin/team-link')[0]!.body).toEqual({ groupIds: [TEAM.id], expiresInDays: 14, skillPath: SHARED.path })
    } finally { await m.unmount() }
  })

  test('the invite after sharing: an open link that led elsewhere is changed to the skill (no files); the message says it was made', async () => {
    signIn('owner')
    progress = ran()
    withGroup()
    drafting({ status: 'done', draft: { ...CARD, inputs: [{ name: 'customer', label: '고객사', required: true }, { name: 'items', label: '품목' }], files: [{ path: 'groups/Acme/회의록/견적서_양식.xlsx', latest: false }], recurring: false } })
    const open = { id: '01900000-0000-7000-8000-000000000001', url: 'https://acme.example/join#t=x', groupIds: [TEAM.id], skill: { path: GENERAL_TASKS_SKILL, name: 'meeting-tasks', title: '할 일 정리' }, starter: { kind: 'tasks', files: 2, paths: FILES }, maxUses: 20, uses: 0, createdBy: { id: 'olga', name: '올가' }, createdAt: '2026-11-04T00:00:00.000Z', expiresAt: '2026-11-18T00:00:00.000Z', state: 'active' }
    routes['GET /api/admin/team-link'] = () => json(200, { link: open, seats: { used: 1, limit: null } })
    routes['PATCH /api/admin/team-link'] = (b) => json(200, { link: { ...open, skill: { path: b.skillPath, name: SHARED.name, title: SHARED.title }, starter: null }, seats: { used: 1, limit: null } })
    const m = await mount(<MemoryRouter><WelcomeInviteBar chatId={CHAT} answered messages={[ask(FILES.slice(0, 1)), { role: 'assistant' as const, content: '이렇게 읽었어요: 견적서 양식', attachments: [] }]} /></MemoryRouter>)
    try {
      await m.until(() => m.find('skill-share-open'), 'the bar')
      await m.click('skill-share-open')
      await m.until(() => m.find('skill-share')?.getAttribute('data-state') === 'ready', 'the card', 6000)
      expect(m.get('skill-share-asks').textContent).toBe('팀원에게 물어볼 것:고객사 · 품목')
      expect(m.get('skill-share-files').textContent).toBe('쓰는 자료:견적서_양식.xlsx')
      expect(m.find('skill-share-choice')).toBeNull()
      await m.click('skill-share-share')
      await m.until(() => m.find('team-link-message'), 'the message')
      expect(called('PATCH /api/admin/team-link').map((c) => c.body)).toEqual([{ skillPath: SHARED.path, starter: null, addGroupIds: [TEAM.id] }])
      expect(m.get('team-link-message').textContent).toBe("우리 팀 '주간 회의 할 일' 스킬을 만들어 뒀어요. 링크 열면 같은 방식으로 바로 써요.\nhttps://acme.example/join#t=x")
      await m.click('invite-step-done')
      await m.until(() => !m.find('welcome-invite-bar'), 'the bar gone')
      expect(progress!.steps.invite).toBe('done')
    } finally { await m.unmount() }
  })

  test('no card when the draft could not be made: "지금은 정리하지 못했어요"; 나중에 closes it, the bar stays; its X puts the invite off', async () => {
    signIn('owner')
    progress = ran()
    drafting({ status: 'failed', problem: 'specific' }, { rewrite: true })
    const m = await mount(<MemoryRouter><WelcomeInviteBar chatId={CHAT} answered messages={[ask(FILES), { role: 'assistant' as const, content: '## 민지', attachments: [] }]} /></MemoryRouter>)
    try {
      await m.until(() => m.find('skill-share-open'), 'the bar')
      await m.click('skill-share-open')
      await m.until(() => m.find('skill-share')?.getAttribute('data-state') === 'failed', 'no card', 12000)
      expect(m.get('skill-share').textContent).toContain('지금은 정리하지 못했어요')
      expect(m.find('skill-share-share')).toBeNull()
      // the rewrite was asked by starting again (reading asks for nothing); then one way on: 다시 정리하기
      expect(called('POST /api/onboarding/skill-draft')).toHaveLength(2)
      expect(m.get('skill-share-retry').textContent).toBe('다시 정리하기')
      drafting({ status: 'done', draft: CARD })
      await m.click('skill-share-retry')
      await m.until(() => m.find('skill-share')?.getAttribute('data-state') === 'ready', 'the card after trying again', 12000)
      expect(called('POST /api/onboarding/skill-draft')).toHaveLength(3)
      await m.click('skill-share-later')
      await m.until(() => !m.find('skill-share'), 'closed')
      // opened again: the same draft read again (no new start)
      await m.click('skill-share-open')
      await m.until(() => m.find('skill-share')?.getAttribute('data-state') === 'ready', 'the same card', 12000)
      expect(called('POST /api/onboarding/skill-draft')).toHaveLength(3)
      await m.click('skill-share-later')
      await m.until(() => !m.find('skill-share'), 'closed again')
      expect(m.find('welcome-invite-bar')).not.toBeNull()
      expect(called(`POST /api/onboarding/skill-draft/${DRAFT}/save`)).toEqual([])
      // the bar's X: the invite is put off, without the soft question (it asked about a skill, not an invite)
      await m.click('welcome-invite-close')
      await m.until(() => !m.find('welcome-invite-bar'), 'the bar gone')
      expect(m.html()).not.toContain(translate('ko', 'teamLink.skipTitle'))
      expect(progress!.steps.invite).toBe('skipped')
    } finally { await m.unmount() }
  }, 30_000)

  test('a conversation the server refuses (files the team cannot open): its reason, and no 다시 정리하기', async () => {
    signIn('owner')
    progress = ran()
    routes['POST /api/onboarding/skill-draft'] = () => json(409, { error: { code: 'conflict', message: '팀원이 모두 볼 수는 없는 파일을 쓴 답이라 팀 스킬로 만들 수 없어요: 급여.xlsx', params: { reason: 'private' } } })
    const m = await mount(<MemoryRouter><WelcomeInviteBar chatId={CHAT} answered messages={[ask(FILES), { role: 'assistant' as const, content: '## 민지', attachments: [] }]} /></MemoryRouter>)
    try {
      await m.until(() => m.find('skill-share-open'), 'the bar')
      await m.click('skill-share-open')
      await m.until(() => m.find('skill-share')?.getAttribute('data-state') === 'failed', 'refused')
      expect(m.get('skill-share-failed').textContent).toBe('팀원이 모두 볼 수는 없는 파일을 쓴 답이라 팀 스킬로 만들 수 없어요: 급여.xlsx')
      expect(m.find('skill-share-retry')).toBeNull()
    } finally { await m.unmount() }
  })

  test('the ad copy (no team files): "팀원도 이 스킬을 바로 써 볼 수 있어요" with the skill just used; done finishes the steps', async () => {
    signIn('owner')
    progress = ran({ teamType: 'marketing', pack: PACK })
    const m = await mount(<MemoryRouter><WelcomeInviteBar chatId={CHAT} answered messages={[{ role: 'user', content: '/ad-copy', attachments: [] }, { role: 'assistant', content: '3안', attachments: [] }]} /></MemoryRouter>)
    try {
      await m.until(() => m.find('welcome-invite-bar'), 'the bar')
      expect(m.get('welcome-invite-text').textContent).toBe('팀원도 이 스킬을 바로 써 볼 수 있어요')
      await m.click('welcome-invite-open')
      await m.until(() => m.find('team-link-create'), 'the invite step')
      // the dialog's title asks the question; the step inside adds no second heading
      expect(m.html()).toContain("방금 쓴 '광고 문구' 스킬, 팀원도 써 보게 할까요?")
      expect(m.get('invite-step').textContent).not.toContain('방금 쓴')
      expect(m.get('invite-step').querySelector('h2')).toBeNull()
      expect(progress!.inviteShownAt).not.toBeNull()
      await m.click('team-link-create')
      await m.until(() => called('POST /api/admin/team-link').length, 'the link made')
      // people who join land on the ad copy form; no starter
      expect(called('POST /api/admin/team-link')[0]!.body).toEqual({ groupIds: [], expiresInDays: 14, skillPath: WELCOME_RESULT_SKILL })
      await m.until(() => m.find('invite-step-done'), 'done button')
      await m.click('invite-step-done')
      await m.until(() => !m.find('welcome-invite-bar'), 'the bar gone')
      expect(progress!.steps.invite).toBe('done')
      expect(progress!.finishedAt).not.toBeNull()
    } finally { await m.unmount() }
  })

  test('the bar waits for the answer, shows only on that chat and only to the owner; closing it asks softly first', async () => {
    signIn('owner')
    progress = ran({ teamType: 'marketing', pack: PACK })
    let m = await mount(<MemoryRouter><WelcomeInviteBar chatId={CHAT} answered={false} /><WelcomeInviteBar chatId="other" answered /></MemoryRouter>)
    try {
      await m.until(() => useWelcome.getState().loaded, 'the progress')
      await m.settle()
      expect(m.find('welcome-invite-bar')).toBeNull()
    } finally { await m.unmount() }
    m = await mount(<MemoryRouter><WelcomeInviteBar chatId={CHAT} answered /></MemoryRouter>)
    try {
      await m.until(() => m.find('welcome-invite-bar'), 'the bar')
      await m.click('welcome-invite-close')
      expect(m.html()).toContain(translate('ko', 'teamLink.skipTitle'))
      await m.click('invite-step-later')
      await m.until(() => !m.find('welcome-invite-bar'), 'the bar gone')
      expect(progress!.steps.invite).toBe('skipped')
    } finally { await m.unmount() }
    useWelcome.getState().reset()
    calls = []
    signIn('member')
    m = await mount(<MemoryRouter><WelcomeInviteBar chatId={CHAT} answered /></MemoryRouter>)
    try {
      await m.settle(50)
      expect(m.find('welcome-invite-bar')).toBeNull()
      expect(called('GET /api/onboarding/welcome')).toEqual([])
    } finally { await m.unmount() }
  })

  test('Home: "시작 설정 이어하기 (n/2)" for the owner until finished or hidden', async () => {
    signIn('owner')
    progress = { ...fresh(), steps: { profile: 'done', result: null, invite: null } }
    let m = await mount(<MemoryRouter><WelcomeResume /></MemoryRouter>)
    try {
      await m.until(() => m.find('welcome-resume'), 'the entry')
      expect(m.get('welcome-resume-link').textContent).toContain('시작 설정 이어하기 (1/2)')
      expect(m.get('welcome-resume-link').getAttribute('href')).toBe('/welcome')
      await m.click('welcome-resume-hide')
      await m.until(() => !m.find('welcome-resume'), 'hidden')
      expect(progress!.dismissedAt).not.toBeNull()
    } finally { await m.unmount() }
    // both counted steps done: only the invite is left, and the entry says so
    useWelcome.getState().reset()
    progress = ran()
    m = await mount(<MemoryRouter><WelcomeResume /></MemoryRouter>)
    try {
      await m.until(() => m.find('welcome-resume'), 'the entry')
      expect(m.get('welcome-resume-link').textContent).toContain(translate('ko', 'welcome.resume.inviteLeft'))
    } finally { await m.unmount() }
    // never started (a team from before the steps), or finished: nothing
    for (const p of [null, { ...ran(), steps: { profile: 'done', result: 'done', invite: 'done' }, finishedAt: 'x' } as WelcomeProgress]) {
      useWelcome.getState().reset()
      progress = p
      m = await mount(<MemoryRouter><WelcomeResume /></MemoryRouter>)
      try {
        await m.until(() => useWelcome.getState().loaded, 'the progress')
        await m.settle()
        expect(m.find('welcome-resume')).toBeNull()
      } finally { await m.unmount() }
    }
  })
})

describe('the company profile step without AI (stream D, also in Admin › Team settings)', () => {
  test('no usable AI: A\'s connect button instead of reading the website; the three questions still work', async () => {
    signIn('owner')
    ai = { usable: false, action: 'connect_team', requested: false }
    const m = await mount(<MemoryRouter><ProfileStep onDone={() => {}} initialWebsite="https://acme.example/" /></MemoryRouter>)
    try {
      await m.until(() => m.find('profile-step-no-ai'), 'the no-AI note')
      expect(m.get('ai-access-button').getAttribute('data-action')).toBe('connect_team')
      expect(m.get('profile-step-no-ai').textContent).toContain(translate('ko', 'onboarding.profile.noAi'))
      const read = (globalThis.document as any).body.querySelector('button[type="submit"]')
      expect(read.hasAttribute('disabled')).toBe(true)
      await m.click('profile-step-no-ai-questions')
      await m.until(() => m.find('profile-step-questions'), 'the questions')
      expect(called('POST /api/onboarding/profile/draft')).toEqual([])
    } finally { await m.unmount() }
  })

  test('AI gone by the time the person presses Read (the trial credit ran out): no draft, the button instead', async () => {
    signIn('owner')
    const m = await mount(<MemoryRouter><ProfileStep onDone={() => {}} initialWebsite="https://acme.example/" /></MemoryRouter>)
    try {
      await m.until(() => useAiAccess.getState().loaded, 'the first check')
      expect(m.find('profile-step-no-ai')).toBeNull()
      ai = { usable: false, action: 'connect_team', requested: false }
      await m.click((globalThis.document as any).body.querySelector('button[type="submit"]'))
      await m.until(() => m.find('profile-step-fallback'), 'the fallback')
      await m.until(() => m.find('ai-access-button'), 'the connect button')
      expect(called('POST /api/onboarding/profile/draft')).toEqual([])
      // pasted text is read by the AI too: only the questions are offered
      expect(m.html()).not.toContain(`>${translate('ko', 'onboarding.profile.paste')}<`)
      expect(m.html()).toContain(translate('ko', 'onboarding.profile.answer'))
    } finally { await m.unmount() }
  })
})
