// The welcome steps, v5 (docs/DECISIONS.md "W — Welcome steps", "X — Lean onboarding", "W2 — AI connection first",
// "D2 — The first result is the company's intro deck", "SK — 내 스킬 가져오기", "W5 — Onboarding v5"), rendered and clicked
// against a small fake of the server's rules (tests/unit/b-onboarding-*.test.ts check the server itself):
// - where the steps go: AI 연결 (only while no AI answers) → 회사 소개 → 내 스킬 → 팀 파일 → 팀원 초대 → the end screen;
//   "n/4" with the invite counted; old rows: (a) 회사 소개 saved with no deck resumes on 회사 소개, (b) a first result
//   answered, (d) put off: answered; the skill everything points at is the first shared skill, else none (the link
//   lands on Home), never the intro deck; the setup row's rules;
// - /welcome is the owner's; right after /setup the owner lands there; leaving 회사 소개 sets the team up once;
// - 회사 소개's "저장하고 계속" starts the intro deck once per team (the server's 409 deck_started: saving again only
//   saves), with the files of "소개 자료가 있으면 같이 넣기", and one line under the button (the tier's minutes, the chat
//   list; the ☰ menu on a phone); nothing about the deck on the later steps;
// - the end screen ("준비 끝났어요") once: the deck line only with a deck, "'{skill}' 먼저 써 보기" (or "AI 연결하기"),
//   홈으로 quiet; a later end goes Home with "시작 설정을 마쳤어요";
// - the invite: one skill, the link made in advance, a link that may still work never replaced; the team skill card
//   ("S") on its own; the company profile step (D) without AI; what a landing is.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { act, useState } from 'react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { deckMessageId, GENERAL_CARDNEWS_SKILL, GENERAL_DECK_SKILL, GENERAL_PROMO_SKILL, uuidv7, type Attachment, type CompanyProfile, type SavedSkillDraft, type SkillInfo, type TeamGroupRef, type TeamLink, type WelcomeProgress, type WelcomeUpdate } from '@mycel/shared/api'
import { useChats } from '../../src/store/chats'
import { translate, useLocaleStore } from '../../src/i18n'
import Welcome from '../../src/pages/Welcome'
import { Setup } from '../../src/pages/Auth'
import { AfterSetup } from '../../src/App'
import { forgetSkillDrafts, SkillShareCard } from '../../src/components/onboarding/SkillShareCard'
import { InviteStep } from '../../src/components/onboarding/InviteStep'
import { INVITE_STEP_STATE } from '../../src/components/onboarding/GoalCard'
import { forgetPatched } from '../../src/components/onboarding/TeamLinkPanel'
import ProfileStep from '../../src/components/onboarding/ProfileStep'
import { countedSteps, doneCount, forgetStepsSeen, historyName, inviteSkill, isLanding, nextStep, openHere, prevStep, profileAnswered, readNotesHint, resumeStep, resumesOnLanding, setupRowState, setupRowWords, showResume, skillNameOf, stepsLeft, stepsSeen, stepTotal, teamReach, wantsTeam } from '../../src/lib/welcome'
import { rememberSetupSite, setupSite } from '../../src/lib/setupLink'
import { useAiAccess } from '../../src/store/aiAccess'
import { chatActivity } from '../../src/store/live'
import { useSession } from '../../src/store/session'
import { useUi } from '../../src/store/ui'
import { useWelcome } from '../../src/store/welcome'
import { FakeEvent, installDom, mount, removeDom, type FakeElement, type Mounted } from './dom-host'
import { msg } from './fixtures'

const CHAT = '01900000-0000-7000-8000-0000000000c1'
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const meOf = (role: 'owner' | 'admin' | 'member') => ({
  user: { id: 'olga', username: 'olga', name: '올가', email: null, role, locale: 'ko', localeChoice: null, mustChangePassword: false, prefs: {} },
  groups: [], team: { name: 'Acme', defaultLocale: 'ko' },
  session: { id: '01900000-0000-7000-8000-00000000000a', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' }, server: { version: '0', dev: true },
})
/** a team skill the invite can point at (one the owner shared from 내 스킬 가져오기) */
const QUOTE_SKILL = 'skills/sales/quote-maker/SKILL.md'
const quote: SkillInfo = { path: QUOTE_SKILL, name: 'quote-maker', title: '견적서 쓰기', description: '견적서 쓰기 — 팀 양식으로 견적서를 만들어요. "견적서 만들어 줘"처럼 물을 때 써요.' }
const fresh = (): WelcomeProgress => ({
  startedAt: '2026-11-04T00:00:00.000Z', updatedAt: '2026-11-04T00:00:00.000Z', teamType: null,
  steps: { profile: null, result: null, skills: null, files: null, invite: null }, resultChatId: null, inviteShownAt: null, site: null, dismissedAt: null, finishedAt: null,
})
const GENERAL = { at: '2026-11-04T00:00:00.000Z', cardNewsPath: GENERAL_CARDNEWS_SKILL, promoVideoPath: GENERAL_PROMO_SKILL, introDeckPath: GENERAL_DECK_SKILL }
const TEAM: TeamGroupRef = { id: '01900000-0000-7000-8000-0000000000e1', name: 'Acme', folder: 'groups/Acme', notesFolder: 'groups/Acme/회의록', brandFolder: 'groups/Acme/브랜드' }
const INTRO = 'groups/Acme/브랜드/회사 소개.md'
const QUESTION = '/intro-deck 우리 회사 소개서 만들어 줘'
const SAVED: CompanyProfile = { website: 'https://acme.example/', name: 'Acme', oneLine: 'Acme makes quiet desk fans.', products: 'Desk fans', audience: '', tone: [], avoid: '', sources: [], updatedAt: '2026-11-05T00:00:00.000Z' } as CompanyProfile
/** the pack skills' titles as the team link names them */
const TITLES: Record<string, string> = { [GENERAL_DECK_SKILL]: '회사 소개서', [GENERAL_PROMO_SKILL]: '홍보 영상', [GENERAL_CARDNEWS_SKILL]: '카드뉴스', [QUOTE_SKILL]: '견적서 쓰기' }
/** the team set up and 회사 소개 saved (no deck yet: an old row (a) or a resumed one) */
const atProfile = (over: Partial<WelcomeProgress> = {}): WelcomeProgress => ({ ...fresh(), general: GENERAL, teamGroup: TEAM, ...over })
/** 회사 소개 saved with its deck started, the team set up */
const ran = (over: Partial<WelcomeProgress> = {}): WelcomeProgress => ({ ...fresh(), general: GENERAL, teamGroup: TEAM, resultChatId: CHAT, steps: { profile: 'done', result: null, skills: 'done', files: 'done', invite: null }, ...over })
/** Admin › Team settings as GET /api/admin/settings answers (the deck tier says how long) */
const settingsOf = (introDeckTier: 'quick' | 'standard' | 'deep') => ({ teamName: 'Acme', defaultLocale: 'ko', defaultEngine: 'claude-code', defaultModel: null, concurrency: 2, updateChannel: 'stable', updateWindow: null, auditRetentionDays: 365, fileHistoryRetentionDays: 90, trashRetentionDays: 30, chatTrashRetentionDays: 7, timeZone: 'Asia/Seoul', browserAllowAll: true, personalIntegrations: true, aiVision: true, aiSubagents: true, roomAlwaysAllow: true, answerStepLimit: 150, speechProvider: 'local', speechModel: 'openai/whisper-large-v3-turbo', aiMediaTranscripts: null, introDeckTier })

// ---- a fake of the server: the progress row (the server's rules in short) and the few other answers the steps need
let progress: WelcomeProgress | null = null
let ai = { usable: true, action: 'connect_team', requested: false }
let calls: { key: string; body: any }[] = []
let teamBlocked = false
/** uploads that fail before one works (a retry then goes through) */
let failUploads = 0
/** the first result refused (no profile and no website yet, say), in the server's words */
let firstResultRefusal: string | null = null
/** attaching that fails before one works */
let failAttach = 0
/** the saved company profile (GET /api/onboarding/profile) */
let profile: CompanyProfile | null = null
/** the team's deck tier */
let tier: 'quick' | 'standard' | 'deep' = 'standard'
/** a deck chat that already holds its message (started before this page) */
let deckBefore = false
/** the chat first-result made for the deck, kept until its message is in (server/src/onboarding/welcome.ts settleDeck) */
let deckKept: string | null = null
/** deck messages the fake server took (a resend of the same client message id is the same one) */
let delivered = new Set<string>()
/** sends that fail before one goes through, in the server's words */
let failSends: { status: number; code: string; message: string }[] = []
const sent = () => called(`POST /api/chats/${CHAT}/messages`)
const answered = (s: string | null | undefined) => s === 'done' || s === 'skipped'
function apply(u: WelcomeUpdate): WelcomeProgress {
  const p = progress ?? fresh()
  if (u.teamType) p.teamType = u.teamType
  // the deck's chat counts once it holds its message (server: holdsMessage)
  if (u.resultChatId && delivered.size) p.resultChatId = u.resultChatId
  if (u.step && (u.step.state === 'done' || p.steps[u.step.id] !== 'done')) p.steps[u.step.id] = u.step.state
  if (u.step?.id === 'skills') delete p.skillsLater
  if (u.skillsLater && !u.step && p.steps.skills !== 'done') { p.steps.skills = 'skipped'; p.skillsLater = true }
  if (u.landing && p.shared) p.shared = { ...p.shared, landing: u.landing }
  if (u.inviteShown) p.inviteShownAt ??= '2026-11-04T00:01:00.000Z'
  if (u.doneShown) p.doneShownAt ??= '2026-11-04T00:04:00.000Z'
  if (u.site) p.site = u.site
  if (u.dismissed !== undefined) p.dismissedAt = u.dismissed ? '2026-11-04T00:02:00.000Z' : null
  // finished: 회사 소개 answered (put off; saved with the deck started or a first result answered) and the rest each
  // answered, not while 내 스킬 waits for a computer (server/src/onboarding/welcome.ts welcomeFinished)
  const profileOk = p.steps.profile === 'skipped' || (p.steps.profile === 'done' && (!!p.resultChatId || (p.steps.result ?? null) !== null))
  if (!p.finishedAt && profileOk && answered(p.steps.skills) && answered(p.steps.files) && answered(p.steps.invite) && !p.skillsLater) p.finishedAt = '2026-11-04T00:03:00.000Z'
  progress = { ...p, steps: { ...p.steps } }
  return progress
}
const routes: Record<string, (body: any) => Response> = {
  'GET /api/onboarding/welcome': () => json(200, { progress }),
  'PATCH /api/onboarding/welcome': (b) => json(200, { progress: apply(b) }),
  'POST /api/onboarding/welcome/team': () => {
    const p = apply({})
    if (p.general && p.teamGroup?.brandFolder) return json(200, { progress: p, install: null, outcome: 'already' })
    const install = { pack: 'general', locale: 'ko', skills: [{ name: 'intro-deck', path: GENERAL_DECK_SKILL, status: teamBlocked ? 'blocked' : 'created' }] }
    progress = { ...p, teamGroup: { ...(p.teamGroup ?? TEAM), brandFolder: TEAM.brandFolder }, general: teamBlocked ? null : GENERAL }
    return json(200, { progress, install, outcome: teamBlocked ? 'blocked' : 'installed' })
  },
  // the intro deck once per team (server/src/onboarding/welcome-result.ts): a deck chat that holds its message answers
  // 409 deck_started before anything else; the chat is recorded at once (a chat whose message never went is handed out
  // again: the same id)
  'POST /api/onboarding/welcome/first-result': (b) => {
    if ((progress?.resultChatId || deckKept) && (deckBefore || delivered.size)) return json(409, { error: { code: 'conflict', message: '회사 소개서는 이미 만들기 시작했어요.', params: { reason: 'deck_started' } } })
    if (firstResultRefusal) return json(409, { error: { code: 'conflict', message: firstResultRefusal } })
    // kept for the deck, not yet `resultChatId`: that comes with its message
    deckKept = CHAT
    return json(201, { chatId: CHAT, title: '우리 회사 소개서', skillPath: GENERAL_DECK_SKILL, files: b.files.length ? b.files : [INTRO], intro: b.files.length ? null : INTRO, imagesFolder: 'groups/Acme/브랜드/이미지', images: [] })
  },
  [`POST /api/chats/${CHAT}/messages`]: (b) => {
    const f = failSends.shift()
    if (f) return json(f.status, { error: { code: f.code, message: f.message } })
    delivered.add(b.clientMessageId)
    const user = msg({ role: 'user', chatId: CHAT, content: b.content, id: uuidv7() })
    const answer = msg({ role: 'assistant', chatId: CHAT, status: 'streaming', parentId: user.id, turnId: uuidv7() })
    return json(202, { userMessage: user, assistantMessage: answer, turnId: answer.turnId, queuePosition: 0, queueEpoch: 'fake', queueRevision: 1 })
  },
  [`GET /api/chats/${CHAT}`]: () => json(200, { id: CHAT, projectId: null, title: '우리 회사 소개서', engine: 'claude-code', model: null, createdAt: '2026-11-04T00:00:00.000Z', updatedAt: '2026-11-04T00:00:00.000Z', deletedAt: null, runState: 'idle' }),
  'POST /api/files/upload': (b) => {
    if (failUploads > 0) { failUploads--; return json(500, { error: { code: 'internal', message: '저장하지 못했어요' } }) }
    const path = `${b.folder}/${b.name}`
    return json(201, { name: b.name, path, type: 'file', size: Number(b.size), mtime: '2026-11-04T00:00:00.000Z', mime: 'text/markdown', access: 'write' })
  },
  'POST /api/attachments/team-file': (b) => failAttach-- > 0 ? json(500, { error: { code: 'internal', message: '붙이지 못했어요' } }) : json(201, { id: uuidv7(), name: b.path.slice(b.path.lastIndexOf('/') + 1), path: b.path, size: 10, mime: 'text/markdown', kind: 'text', source: 'team' } satisfies Attachment),
  'GET /api/me/ai-access': () => json(200, ai),
  'GET /api/admin/credentials': () => json(200, { items: [], memberOwn: false, sharedSubscriptions: true, allowedKinds: ['anthropic-oauth', 'anthropic-api-key', 'chatgpt', 'openai-api-key'], pricesAsOf: '2026-11-01', anthropicGateway: null }),
  'GET /api/onboarding/profile': () => json(200, { profile }),
  'GET /api/admin/settings': () => json(200, settingsOf(tier)),
  'GET /api/skills': () => json(200, { items: [quote] }),
  'POST /api/chats': () => json(201, { id: CHAT, projectId: null, title: '', engine: 'claude-code', model: null, createdAt: '2026-11-04T00:00:00.000Z', updatedAt: '2026-11-04T00:00:00.000Z', deletedAt: null, runState: 'idle' }),
  'GET /api/admin/groups': () => json(200, { items: [] }),
  'GET /api/admin/folders': () => json(200, { items: [] }),
  'GET /api/admin/team-link': () => json(200, { link: null, seats: { used: 1, limit: null } }),
  'POST /api/admin/team-link': (b) => json(201, {
    link: { id: '01900000-0000-7000-8000-000000000001', url: 'https://acme.example/join#t=x', groupIds: b.groupIds, skill: b.skillPath ? { path: b.skillPath, name: skillNameOf(b.skillPath), title: TITLES[b.skillPath] ?? null } : null, starter: b.starter ? { kind: b.starter.kind, files: b.starter.files.length } : null, maxUses: 20, uses: 0, createdBy: { id: 'olga', name: '올가' }, createdAt: '2026-11-04T00:00:00.000Z', expiresAt: '2026-11-18T00:00:00.000Z', state: 'active' },
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
const computerMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })
/** a phone's width (below 768px), for the steps' and the step's own media queries */
const phoneWidth = () => { g.matchMedia = (q: string) => ({ ...computerMedia(), matches: q === '(max-width: 767.98px)' }) }
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
  teamBlocked = false
  failUploads = 0
  firstResultRefusal = null
  failAttach = 0
  profile = null
  tier = 'standard'
  deckBefore = false
  deckKept = null
  delivered = new Set()
  failSends = []
  g.matchMedia = computerMedia
  delete g.showDirectoryPicker
  useWelcome.getState().reset()
  useAiAccess.getState().reset()
  useUi.setState({ toasts: [] })
  // a deck message this file sent stays "sending" in the chats store: the files after this one (the reload guard)
  // must not see it
  useChats.setState({ threads: {} })
  sessionStorage.clear()
  forgetStepsSeen()
})
afterAll(() => {
  globalThis.fetch = realFetch
  for (const [k, d] of Object.entries(was)) { if (d) Object.defineProperty(g, k, d); else delete g[k] }
  g.matchMedia = computerMedia
  useSession.setState(sessionBefore as never)
  useLocaleStore.setState({ locale: localeBefore })
  removeDom()
})

const signIn = (role: 'owner' | 'admin' | 'member') => useSession.setState({ status: { kind: 'signed-in', me: meOf(role) } } as never)
function Where() { const l = useLocation(); return <p data-testid="where" data-state={JSON.stringify(l.state ?? null)}>{l.pathname + l.search}</p> }
const at = (m: Mounted) => m.find('where')?.textContent
const app = (start: string | { pathname: string; state: unknown } = '/welcome') => mount(
  <MemoryRouter initialEntries={[start]}>
    <Routes>
      <Route path="/welcome" element={<Welcome />} />
      <Route path="*" element={<Where />} />
    </Routes>
  </MemoryRouter>,
)
const stepOf = (m: Mounted) => m.container.querySelector('[data-step]')?.getAttribute('data-step')
const body = () => (globalThis.document as any).body
const buttonNamed = (text: string) => body().querySelectorAll('button').find((b: any) => b.textContent === text)
const laterButton = () => buttonNamed(translate('ko', 'welcome.later'))
const retryButton = () => buttonNamed(translate('ko', 'common.retry'))
const primaries = (m: Mounted) => m.container.querySelectorAll('button').filter((b) => (b.getAttribute('class') ?? '').includes('bg-accent ')).length
/** what choosing files in a picker does: the input's files, then its change event */
async function choose(m: Mounted, files: File[], testId = 'welcome-files-input') {
  const input = m.get(testId) as FakeElement
  Object.defineProperty(input, 'files', { configurable: true, value: files })
  await act(async () => { input.dispatchEvent(new FakeEvent('change', { bubbles: true })) })
}
const note = (name: string, text = '# Acme 회사 소개\n- 조용한 책상 선풍기\n') => new File([text], name, { type: 'text/markdown' })
const items = (m: Mounted) => m.get('welcome-progress').querySelectorAll('li').map((li: any) => li.getAttribute('data-progress-step'))

describe('where the steps go', () => {
  test('the order: 회사 소개 → 내 스킬 → 팀 파일 → 팀원 초대, n/4 with the invite counted; ← 이전 to 회사 소개 at any time', () => {
    expect(resumeStep(null)).toBe('profile')
    expect(stepTotal()).toBe(4)
    expect(countedSteps(fresh())).toEqual(['profile', 'skills', 'files', 'invite'])
    const p = fresh()
    expect(nextStep(p, 'profile')).toBe('skills')
    expect(nextStep(p, 'skills')).toBe('files')
    expect(nextStep(p, 'files')).toBe('invite')
    expect(nextStep({ ...p, steps: { ...p.steps, invite: 'done' } }, 'files')).toBeNull()
    // the first result is no step any more: nothing goes there
    expect(nextStep({ ...p, steps: { ...p.steps, profile: 'skipped' } }, 'profile')).toBe('skills')
    expect(prevStep('skills')).toBe('profile')
    expect(prevStep('files')).toBe('skills')
    expect(prevStep('invite')).toBe('files')
    expect(prevStep('profile')).toBeNull()
    expect(prevStep('ai')).toBeNull()
  })

  test('old progress rows: (a) 회사 소개 saved, no first result and no deck → 회사 소개 is still open; (b) a first result answered → answered; (d) put off → answered, no deck', () => {
    const a = { ...fresh(), steps: { profile: 'done', result: null, skills: null, files: null, invite: null } } as WelcomeProgress
    expect(profileAnswered(a)).toBe(false)
    expect(openHere(a, 'profile')).toBe(true)
    expect(resumeStep(a)).toBe('profile')
    expect(doneCount(a)).toBe(0)
    // the deck started: answered, on to 내 스킬
    expect(resumeStep({ ...a, resultChatId: CHAT })).toBe('skills')
    expect(doneCount({ ...a, resultChatId: CHAT })).toBe(1)
    // (b) the old first result done (its chat is just a chat), (d) put off (no deck): both answered
    for (const result of ['done', 'skipped'] as const) {
      const b = { ...a, steps: { ...a.steps, result } } as WelcomeProgress
      expect(profileAnswered(b)).toBe(true)
      expect(resumeStep(b)).toBe('skills')
    }
    // put off: answered whatever the rest says
    expect(profileAnswered({ ...fresh(), steps: { ...fresh().steps, profile: 'skipped' } })).toBe(true)
    // (c) a row from before 내 스킬 and 팀 파일 (no such fields): they read as open, the count recounts
    const old = { ...fresh(), resultChatId: CHAT, steps: { profile: 'done', result: 'done', invite: null } } as WelcomeProgress
    expect(resumeStep(old)).toBe('skills')
    expect(doneCount(old)).toBe(1)
    expect(stepTotal(old)).toBe(4)
  })

  test('resume: the first open step, then a put-off one; the count is what is done (put off is not)', () => {
    const p = { ...fresh(), steps: { profile: 'skipped', result: null, skills: 'done', files: null, invite: null } } as WelcomeProgress
    expect(resumeStep(p)).toBe('files')
    expect(doneCount(p)).toBe(1)
    // everything has an answer (a row the server has not finished, say): "later" is now, the put-off profile first
    const all = { ...fresh(), steps: { profile: 'skipped', result: null, skills: 'done', files: 'done', invite: 'skipped' } } as WelcomeProgress
    expect(resumeStep(all)).toBe('profile')
    expect(nextStep(all, 'invite')).toBeNull()
    expect(doneCount(all)).toBe(2)
    expect(showResume(all)).toBe(true)
    expect(showResume({ ...all, dismissedAt: 'x' })).toBe(false)
    expect(showResume({ ...all, finishedAt: 'x' })).toBe(false)
    expect(resumeStep({ ...all, finishedAt: 'x' })).toBeNull()
  })

  test('a landing resumes only started, unfinished, not hidden steps with a step to open (W4); 내 스킬 put off on a phone waits for a computer', () => {
    expect(resumesOnLanding(null)).toBe(false)
    expect(resumesOnLanding(fresh())).toBe(true)
    expect(resumesOnLanding({ ...fresh(), dismissedAt: '2026-11-04T01:00:00.000Z' })).toBe(false)
    expect(resumesOnLanding({ ...fresh(), finishedAt: '2026-11-04T01:00:00.000Z' })).toBe(false)
    const later = { ...fresh(), resultChatId: CHAT, skillsLater: true, steps: { profile: 'done', result: null, skills: 'skipped', files: 'done', invite: 'done' } } as WelcomeProgress
    expect(resumesOnLanding(later, true)).toBe(true)
    expect(resumeStep(later, true, true)).toBe('skills')
    expect(resumesOnLanding(later, false)).toBe(false)
    expect(resumeStep(later, true, false)).toBeNull()
    // the phone goes on to 팀 파일; a computer comes back to 내 스킬 first, and counts it open
    const mid = { ...later, steps: { ...later.steps, files: null, invite: null } } as WelcomeProgress
    expect(nextStep(mid, 'skills', false)).toBe('files')
    expect(resumeStep(mid, true, false)).toBe('files')
    expect(resumeStep(mid, true, true)).toBe('skills')
    expect(doneCount(mid)).toBe(1)
    // what is left: on a computer 내 스킬 too; on the phone only what it can do
    expect(stepsLeft(mid, true, true)).toEqual(['skills', 'files', 'invite'])
    expect(stepsLeft(mid, true, false)).toEqual(['files', 'invite'])
  })

  // the recheck of onboarding v5: a phone's Home read "설정 이어서 하기 · 4/4" with 팀 파일 put off and 내 스킬 waiting
  // for a computer (put off counted as answered): it names what is left, and the count is the steps done
  test('the setup row\'s words: one step left here is named ("남은 일: 팀 파일"); else "설정 이어서 하기" and the steps done', () => {
    const ko = (k: Parameters<typeof translate>[1], p?: Record<string, string | number>) => translate('ko', k, p)
    const phone = { ...fresh(), resultChatId: CHAT, skillsLater: true, steps: { profile: 'done', result: null, skills: 'skipped', files: 'skipped', invite: 'done' } } as WelcomeProgress
    expect(showResume(phone, false)).toBe(true)
    expect(doneCount(phone)).toBe(2)
    expect(stepsLeft(phone, true, false)).toEqual(['files'])
    expect(setupRowWords(ko, phone, true, false)).toEqual({ text: '남은 일: 팀 파일', count: null })
    // a computer has 내 스킬 left too: the steps done, "2/4", never "4/4"
    expect(stepsLeft(phone, true, true)).toEqual(['skills', 'files'])
    expect(setupRowWords(ko, phone, true, true)).toEqual({ text: '설정 이어서 하기', count: '2/4' })
    // only put-off steps left, no phone in it: the one left is named whether open or put off
    const off = { ...fresh(), resultChatId: CHAT, steps: { profile: 'done', result: null, skills: 'done', files: 'done', invite: 'skipped' } } as WelcomeProgress
    expect(setupRowWords(ko, off)).toEqual({ text: '남은 일: 팀원 초대', count: null })
    expect(setupRowWords(ko, { ...off, steps: { ...off.steps, profile: 'skipped' } })).toEqual({ text: '설정 이어서 하기', count: '2/4' })
    // nothing done yet: "0/4"; 회사 소개 saved without a deck (an old row) is not done either
    expect(setupRowWords(ko, fresh())).toEqual({ text: '설정 이어서 하기', count: '0/4' })
    expect(doneCount({ ...fresh(), steps: { ...fresh().steps, profile: 'done' } })).toBe(0)
    // the AI step counts with the others while it is on the bar
    expect(setupRowWords(ko, { ...off, steps: { ...off.steps, ai: 'skipped' } }, false)).toEqual({ text: '설정 이어서 하기', count: '3/5' })
    // every language has the words
    expect(setupRowWords((k, p) => translate('en', k, p), phone, true, false).text).toBe('Still to do: Team files')
  })

  test('the AI step: first while no AI answers the owner and 회사 소개 is open; never in front of the later steps; counted then', () => {
    expect(resumeStep(null, false)).toBe('ai')
    expect(resumeStep(fresh(), false)).toBe('ai')
    expect(countedSteps(fresh(), false)).toEqual(['ai', 'profile', 'skills', 'files', 'invite'])
    expect(stepTotal(fresh(), false)).toBe(5)
    // 회사 소개 answered: the later steps need no AI
    for (const steps of [{ profile: 'skipped' }, { profile: 'done', result: 'done' }] as const) {
      const p = { ...fresh(), steps: { ...fresh().steps, ...steps } } as WelcomeProgress
      expect(resumeStep(p, false)).toBe('skills')
      expect(countedSteps(p, false)).toEqual(['profile', 'skills', 'files', 'invite'])
    }
    // shown before: the bar keeps it; done counts once AI answers
    const q = { ...fresh(), steps: { ...fresh().steps, ai: 'done' } } as WelcomeProgress
    expect(countedSteps(q, true)).toEqual(['ai', 'profile', 'skills', 'files', 'invite'])
    expect(doneCount(q, true)).toBe(1)
    expect(doneCount({ ...q, steps: { ...q.steps, ai: 'skipped' } }, true)).toBe(0)
    expect(nextStep(q, 'ai')).toBe('profile')
    // everything answered, 회사 소개 put off: "later" is now, and it needs AI
    const off = { ...fresh(), steps: { profile: 'skipped', result: null, skills: 'done', files: 'done', invite: 'skipped' } } as WelcomeProgress
    expect(resumeStep(off, false)).toBe('ai')
    expect(resumeStep(off, true)).toBe('profile')
  })

  test('the skill everything points at: the first shared skill, else none (no pack skill stands in: docs/DECISIONS.md "DS3"); never the intro deck', () => {
    const p = atProfile()
    // nothing shared: none, so the link lands on Home; an old row's 할 일 정리 is not read
    expect(inviteSkill(p)).toBeNull()
    expect(inviteSkill({ ...p, general: { ...GENERAL, tasksPath: 'skills/general/meeting-tasks/SKILL.md' } as never })).toBeNull()
    expect(inviteSkill({ ...p, shared: { at: 'x', skills: [{ path: 'skills/weekly-report/SKILL.md', title: '주간 업무 보고' }], landing: 'skills/weekly-report/SKILL.md' } })).toBe('skills/weekly-report/SKILL.md')
    expect(inviteSkill({ ...p, general: null })).toBeNull()
    // the server's own choice wins whenever it sent one (a shared skill deleted since)
    const shared = { ...p, shared: { at: 'x', skills: [{ path: 'skills/weekly-report/SKILL.md', title: '주간 업무 보고' }], landing: 'skills/weekly-report/SKILL.md' } }
    expect(inviteSkill({ ...shared, landingSkill: QUOTE_SKILL })).toBe(QUOTE_SKILL)
    expect(inviteSkill({ ...shared, landingSkill: null })).toBeNull()
    // never the deck, also when an old row names it
    expect(inviteSkill({ ...p, shared: { at: 'x', skills: [], landing: GENERAL_DECK_SKILL } })).toBeNull()
  })

  test('the setup row: never on /welcome, finished or hidden; without AI "AI 연결하기" but not on Home; on a phone not on Home', () => {
    const p = atProfile()
    const at = (path: string, aiReady = true, computer = true, row: WelcomeProgress | null = p) => setupRowState(row, { path, aiReady, computer })
    expect(at('/c/abc')).toBe('resume')
    expect(at('/')).toBe('resume')
    expect(at('/welcome')).toBe('hidden')
    expect(at('/c/abc', true, true, null)).toBe('hidden')
    expect(at('/c/abc', true, true, { ...p, finishedAt: 'x' })).toBe('hidden')
    expect(at('/c/abc', true, true, { ...p, dismissedAt: 'x' })).toBe('hidden')
    // no AI: the connect dialog everywhere but Home (its no-AI card) and /welcome
    expect(at('/c/abc', false)).toBe('ai')
    expect(at('/skills', false, false)).toBe('ai')
    expect(at('/', false)).toBe('hidden')
    expect(at('/welcome', false)).toBe('hidden')
    // a phone: Home's own row under the box says it there
    expect(at('/', true, false)).toBe('hidden')
    expect(at('/rooms', true, false)).toBe('resume')
    // only 내 스킬 left, put off for a computer: nothing to resume on a phone
    const later = { ...p, resultChatId: CHAT, skillsLater: true, steps: { profile: 'done', result: null, skills: 'skipped', files: 'done', invite: 'done' } } as WelcomeProgress
    expect(at('/c/abc', true, false, later)).toBe('hidden')
    expect(at('/c/abc', true, true, later)).toBe('resume')
  })

  test('who sees the team folder: its group and the owners and admins, active ones; members outside it can be added', () => {
    const u = (id: string, role: 'owner' | 'admin' | 'member', status: 'active' | 'disabled' = 'active') => ({ id, role, status })
    const users = [u('olga', 'owner'), u('ada', 'admin'), u('mia', 'member'), u('jun', 'member'), u('ha', 'member'), u('old', 'member', 'disabled')]
    expect(teamReach(users, ['olga', 'mia', 'old'])).toEqual({ viewers: 3, outside: ['jun', 'ha'] })
    expect(teamReach([u('olga', 'owner')], ['olga'])).toEqual({ viewers: 1, outside: [] })
  })

  test('every team gets its start, while any part of it is missing; the name a skill runs by', () => {
    expect(wantsTeam(fresh())).toBe(true)
    expect(wantsTeam({ ...fresh(), general: GENERAL })).toBe(true)
    expect(wantsTeam({ ...fresh(), teamGroup: TEAM })).toBe(true)
    expect(wantsTeam({ ...fresh(), general: GENERAL, teamGroup: TEAM })).toBe(false)
    expect(wantsTeam({ ...fresh(), general: GENERAL, teamGroup: { ...TEAM, brandFolder: undefined } })).toBe(true)
    expect(wantsTeam(null)).toBe(false)
    expect(skillNameOf(QUOTE_SKILL)).toBe('quote-maker')
    expect(skillNameOf(GENERAL_DECK_SKILL)).toBe('intro-deck')
    expect(skillNameOf('skills/할-일.md')).toBe('할-일')
    expect(skillNameOf(null)).toBe('')
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
      // two groups under quiet headings: the team, then the owner's own account ("내 이름"), one password field with
      // the join page's show switch
      expect(m.get('setup-section-team').querySelector('legend')!.textContent).toBe('팀')
      expect(m.get('setup-section-owner').querySelector('legend')!.textContent).toBe('내 계정 · 팀장')
      expect(m.get('setup-section-team').querySelector('[data-testid="setup-team"]')).not.toBeNull()
      expect(m.get('setup-section-owner').textContent).toContain('내 이름')
      expect(doc.body.querySelectorAll('input[autocomplete="new-password"]')).toHaveLength(1)
      expect(m.html()).not.toContain('비밀번호 확인')
      expect(m.get('setup-password').getAttribute('type')).toBe('password')
      await m.click('setup-password-show')
      expect(m.get('setup-password').getAttribute('type')).toBe('text')
      expect(m.get('setup-password-show').getAttribute('aria-pressed')).toBe('true')
      await m.type('setup-team', 'Acme')
      await m.type('setup-name', '올가')
      await m.type('setup-username', 'olga')
      await m.type('setup-password', 'a long password 1')
      await m.click('setup-submit')
      await m.until(() => at(m) === '/welcome', 'the welcome steps')
      expect(called('POST /api/setup')).toHaveLength(1)
      expect(called('POST /api/setup')[0]!.body.owner).toEqual({ username: 'olga', name: '올가', password: 'a long password 1' })
      expect(setupSite()).toBe('https://acme.example/')
    } finally {
      await m.unmount()
      delete routes['POST /api/setup']
      delete g.location
    }
  })

  test('no team question; leaving 회사 소개 sets the team up once, never another pack; resuming never sets up again', async () => {
    signIn('owner')
    rememberSetupSite('https://acme.example/')
    let m = await app()
    try {
      await m.until(() => stepOf(m) === 'profile', 'step 1')
      expect(called('PATCH /api/onboarding/welcome')[0]!.body).toEqual({ site: 'https://acme.example/' })
      // four steps on the bar, the invite counted, no first result
      expect(items(m)).toEqual(['profile', 'skills', 'files', 'invite'])
      for (const [n, label] of [[1, '회사 소개'], [2, '내 스킬'], [3, '팀 파일'], [4, '팀원 초대']] as const) expect(m.get('welcome-progress').textContent).toContain(`${n}/4 ${label}`)
      expect(m.html()).not.toContain('첫 결과')
      await m.until(() => m.find('profile-step-site'), 'the profile step (D)')
      expect(m.html()).not.toContain('마케팅팀이에요')
      expect(called('POST /api/onboarding/welcome/team')).toEqual([])
      // 나중에 하기: the team's start goes in (once), on to 내 스킬, no deck
      await m.click(laterButton())
      await m.until(() => stepOf(m) === 'skills', 'step 2')
      expect(called('POST /api/onboarding/welcome/team')).toHaveLength(1)
      expect(calls.filter((c) => /\/packs?\b/.test(c.key))).toEqual([])
      expect(called('POST /api/onboarding/welcome/first-result')).toEqual([])
      expect(progress!.general).toEqual(GENERAL)
      expect(progress!.teamGroup).toEqual(TEAM)
      expect(progress!.steps.profile).toBe('skipped')
      expect(progress!.resultChatId).toBeNull()
      expect(m.find('welcome-progress')!.querySelector('[aria-current="step"]')!.textContent).toContain('2/4 내 스킬')
      // nothing about a deck on the later steps
      expect(m.find('welcome-deck-status')).toBeNull()
      expect(m.html()).not.toContain('회사 소개서')
    } finally { await m.unmount() }
    sessionStorage.clear()
    // another device: the progress comes from the server, the steps open on 내 스킬; back to 회사 소개 and put off again:
    // nothing is set up again
    useWelcome.getState().reset()
    calls = []
    m = await app()
    try {
      await m.until(() => stepOf(m) === 'skills', 'resumed on step 2')
      await m.click('welcome-back')
      await m.until(() => m.find('profile-step-site'), 'the profile step')
      expect((m.get('profile-step-site').querySelector('input[inputmode="url"]') as unknown as { value: string }).value).toBe('https://acme.example/')
      await m.click(laterButton())
      await m.until(() => stepOf(m) === 'skills', 'step 2 again')
      expect(calls.filter((c) => /\/packs?\b/.test(c.key))).toEqual([])
      expect(called('POST /api/onboarding/welcome/team')).toEqual([])
    } finally { await m.unmount() }
  })

  test('a row from before with a team type or the team question put off: leaving sets the team up, never another pack', async () => {
    for (const start of [{ ...fresh(), teamType: 'marketing' as const }, { ...fresh(), teamType: 'operations' as const }, { ...fresh(), teamSkipped: true }]) {
      signIn('owner')
      progress = start
      const m = await app()
      try {
        await m.until(() => m.find('profile-step-site'), 'the profile step (D)')
        await m.click(laterButton())
        await m.until(() => stepOf(m) === 'skills', '내 스킬')
        expect(called('POST /api/onboarding/welcome/team')).toHaveLength(1)
        expect(calls.filter((c) => /\/packs?\b/.test(c.key))).toEqual([])
        expect(progress!.teamType).toBe(start.teamType)
      } finally { await m.unmount() }
      useWelcome.getState().reset()
      calls = []
    }
  })

  test('the website read with a one-line intro: saved without the review; 회사 소개 shows "이렇게 이해했어요: … · 고치기", one primary "저장하고 계속" and the deck line; 고치기 changes the line; 저장하고 계속 starts the deck once', async () => {
    signIn('owner')
    rememberSetupSite('https://acme.example/')
    tier = 'deep'
    const DRAFT = '01900000-0000-7000-8000-0000000000d9'
    routes['POST /api/onboarding/profile/draft'] = () => json(201, { chatId: DRAFT, website: 'https://acme.example/', site: 'acme.example' })
    routes[`GET /api/onboarding/profile/draft/${DRAFT}`] = () => json(200, { status: 'done', website: 'https://acme.example/', error: null, steps: [], assets: { images: 0, logo: false, colors: ['#37ee6a'] },
      draft: { website: 'https://acme.example/', name: 'Acme', oneLine: 'Acme makes quiet desk fans.', products: 'Desk fans', audience: '', tone: [], avoid: '', sources: [] } })
    routes['PUT /api/onboarding/profile'] = (b) => json(200, (profile = { ...b, updatedAt: '2026-11-05T00:00:00.000Z' }))
    const m = await app()
    try {
      await m.until(() => m.find('profile-step-site'), 'step 1')
      await m.click(m.get('profile-step-site').querySelector('button[type="submit"]')!)
      await m.until(() => m.find('profile-step-reading'), 'reading')
      chatActivity.emit(DRAFT)
      await m.until(() => m.find('welcome-profile')?.getAttribute('data-state') === 'saved', 'the saved 회사 소개')
      // saved as it came, once; the review never showed; still on 회사 소개 (the deck waits for 저장하고 계속)
      expect(called('PUT /api/onboarding/profile').map((c) => c.body)).toEqual([{ website: 'https://acme.example/', name: 'Acme', oneLine: 'Acme makes quiet desk fans.', products: 'Desk fans', audience: '', tone: [], avoid: '', sources: [], colors: ['#37ee6a'] }])
      expect(m.find('profile-step-review')).toBeNull()
      expect(stepOf(m)).toBe('profile')
      expect(called('POST /api/onboarding/welcome/first-result')).toEqual([])
      expect(m.get('welcome-profile-line').textContent).toBe('이렇게 이해했어요: Acme makes quiet desk fans. · 고치기')
      expect(m.get('welcome-profile-site').getAttribute('target')).toBe('_blank')
      expect(m.get('welcome-files-pick').textContent).toContain('소개 자료가 있으면 같이 넣기')
      expect(m.get('welcome-profile-continue').textContent).toBe('저장하고 계속')
      // the line under the button: the deck starts, the tier's minutes, where it will be
      expect(m.get('welcome-deck-line').textContent).toBe(`저장하면 회사 소개서를 만들기 시작해요 · 10분쯤 · ${historyName((k, p) => translate('ko', k, p))}의 '우리 회사 소개서'`)
      expect(primaries(m)).toBe(1)
      // 고치기: the full review in a dialog, with what was saved; saving there changes the line
      await m.click('welcome-profile-fix')
      const review = await m.until(() => body().querySelector('[role="dialog"]') && m.find('profile-step-review'), 'the review in a dialog')
      const oneLine = review.querySelectorAll('input').find((i: any) => i.value === 'Acme makes quiet desk fans.')
      await m.type(oneLine, 'Acme makes quiet fans for small offices.')
      await m.click(review.querySelectorAll('button').find((b: any) => b.textContent === '저장'))
      await m.until(() => m.get('welcome-profile-line').textContent === '이렇게 이해했어요: Acme makes quiet fans for small offices. · 고치기', 'the line changed')
      expect(body().querySelector('[role="dialog"]')).toBeNull()
      // 저장하고 계속: the deck (the server's 회사 소개.md attached, "/intro-deck …" sent as the owner), then 내 스킬
      await m.click('welcome-profile-continue')
      await m.until(() => stepOf(m) === 'skills', '내 스킬')
      expect(called('POST /api/onboarding/welcome/first-result').map((c) => c.body)).toEqual([{ files: [] }])
      expect(called('POST /api/attachments/team-file').map((c) => c.body)).toEqual([{ chatId: CHAT, path: INTRO }])
      await m.until(() => sent().length === 1, 'the deck message')
      expect(sent()[0]!.body.content).toBe(QUESTION)
      // one message id per deck chat (another tab or a retry adds no second message), and 회사 소개 is recorded only
      // after the server took it
      expect(sent()[0]!.body.clientMessageId).toBe(deckMessageId(CHAT))
      expect(calls.findIndex((c) => c.key === `POST /api/chats/${CHAT}/messages`)).toBeLessThan(calls.findIndex((c) => c.key === 'PATCH /api/onboarding/welcome' && c.body.step?.id === 'profile'))
      expect(called('PATCH /api/onboarding/welcome').map((c) => c.body).filter((b) => b.step?.id === 'profile')).toEqual([{ step: { id: 'profile', state: 'done' }, resultChatId: CHAT }])
      expect(progress!.resultChatId).toBe(CHAT)
      expect(called('POST /api/onboarding/welcome/team')).toHaveLength(1)
      expect(called('POST /api/chats')).toEqual([])
      // ← 이전: 회사 소개 again, the deck line and the files link gone; 저장하고 계속 only saves (409 deck_started)
      await m.click('welcome-back')
      await m.until(() => m.find('welcome-profile')?.getAttribute('data-state') === 'saved', '회사 소개 again')
      expect(m.find('welcome-deck-line')).toBeNull()
      expect(m.find('welcome-files-pick')).toBeNull()
      await m.click('welcome-profile-continue')
      await m.until(() => stepOf(m) === 'skills', '내 스킬 again')
      expect(called('POST /api/onboarding/welcome/first-result')).toHaveLength(2)
      expect(sent()).toHaveLength(1)
      expect(called('POST /api/attachments/team-file')).toHaveLength(1)
      expect(called('PATCH /api/onboarding/welcome').map((c) => c.body).filter((b) => b.step?.id === 'profile').at(-1)).toEqual({ step: { id: 'profile', state: 'done' } })
    } finally {
      await m.unmount()
      delete routes['POST /api/onboarding/profile/draft']
      delete routes[`GET /api/onboarding/profile/draft/${DRAFT}`]
      delete routes['PUT /api/onboarding/profile']
    }
  }, 30_000)

  test('a saved 회사 소개 resumes in its saved state (old row (a): saved, no deck): the line, the primary, the deck line; another tab started the deck meanwhile: saving only saves', async () => {
    signIn('owner')
    profile = SAVED
    progress = atProfile({ steps: { profile: 'done', result: null, skills: null, files: null, invite: null } })
    const m = await app()
    try {
      await m.until(() => m.find('welcome-profile')?.getAttribute('data-state') === 'saved', 'the saved 회사 소개')
      expect(stepOf(m)).toBe('profile')
      expect(m.get('welcome-profile-line').textContent).toBe('이렇게 이해했어요: Acme makes quiet desk fans. · 고치기')
      expect(m.get('welcome-deck-line').textContent).toBe(`저장하면 회사 소개서를 만들기 시작해요 · 5분쯤 · ${historyName((k, p) => translate('ko', k, p))}의 '우리 회사 소개서'`)
      // another tab or device started the deck since: the server says so, nothing is sent twice
      progress = { ...progress!, resultChatId: CHAT }
      deckBefore = true
      await m.click('welcome-profile-continue')
      await m.until(() => stepOf(m) === 'skills', '내 스킬')
      expect(called('POST /api/onboarding/welcome/first-result')).toHaveLength(1)
      expect(sent()).toEqual([])
      expect(called('POST /api/attachments/team-file')).toEqual([])
      expect(progress!.steps.profile).toBe('done')
    } finally { await m.unmount() }
  })

  test('a saved profile with no one-line intro: the first line of what it sells, else "회사 소개를 저장했어요"', async () => {
    for (const [saved, line] of [[{ ...SAVED, oneLine: '' }, '이렇게 이해했어요: Desk fans · 고치기'], [{ ...SAVED, oneLine: '', products: '' }, '회사 소개를 저장했어요 · 고치기']] as const) {
      signIn('owner')
      profile = saved
      progress = atProfile()
      const m = await app()
      try {
        await m.until(() => m.find('welcome-profile-line'), 'the line')
        expect(m.get('welcome-profile-line').textContent).toBe(line)
      } finally { await m.unmount() }
      useWelcome.getState().reset()
      calls = []
    }
  })

  test('"소개 자료가 있으면 같이 넣기": files go into the team\'s brand folder (each on its own, a name taken renamed), and the deck is made from them; a failed upload is retried', async () => {
    signIn('owner')
    profile = SAVED
    progress = atProfile()
    failUploads = 1
    const m = await app()
    try {
      await m.until(() => m.find('welcome-files-pick'), 'the files link')
      // a quiet link, not a second primary; files, not folders
      expect(primaries(m)).toBe(1)
      expect(m.get('welcome-files-input').getAttribute('type')).toBe('file')
      expect((m.get('welcome-files-input') as unknown as { multiple: boolean }).multiple).toBe(true)
      expect(m.get('welcome-files-input').hasAttribute('webkitdirectory')).toBe(false)
      await choose(m, [note('회사 소개서.md'), note('팀 소개.md')])
      await m.until(() => m.container.querySelectorAll('[data-testid="welcome-file"][data-status="failed"]').length === 1, 'one failed')
      await m.click(retryButton())
      await m.until(() => m.container.querySelectorAll('[data-testid="welcome-file"][data-status="done"]').length === 2, 'both up')
      const ups = called('POST /api/files/upload').map((c) => `${c.body.folder}/${c.body.name}`)
      expect(ups).toHaveLength(3)
      expect(ups.every((u) => u.startsWith('groups/Acme/브랜드/'))).toBe(true)
      expect(called('POST /api/files/upload').every((c) => c.body.onExists === 'rename')).toBe(true)
      expect(called('POST /api/onboarding/welcome/first-result')).toEqual([])
      await m.click('welcome-profile-continue')
      await m.until(() => stepOf(m) === 'skills', '내 스킬')
      expect(called('POST /api/onboarding/welcome/first-result').map((c) => c.body)).toEqual([{ files: ['groups/Acme/브랜드/회사 소개서.md', 'groups/Acme/브랜드/팀 소개.md'] }])
      expect(called('POST /api/attachments/team-file').map((c) => c.body.path)).toEqual(['groups/Acme/브랜드/회사 소개서.md', 'groups/Acme/브랜드/팀 소개.md'])
      await m.until(() => sent().length === 1, 'the deck message')
      expect(sent()[0]!.body.attachmentIds).toHaveLength(2)
    } finally { await m.unmount() }
  })

  test('at most ten intro files; an older row without the team\'s start sets it up first', async () => {
    signIn('owner')
    profile = SAVED
    progress = { ...fresh(), steps: { profile: 'done', result: null, invite: null } } as WelcomeProgress
    const m = await app()
    try {
      await m.until(() => m.find('welcome-files-pick'), 'the files link')
      await choose(m, Array.from({ length: 12 }, (_, i) => note(`소개 ${i + 1}.md`)))
      await m.until(() => called('POST /api/files/upload').length === 10 && !m.container.querySelector('[data-testid="welcome-file"][data-status="uploading"]'), 'ten up')
      expect(called('POST /api/onboarding/welcome/team')).toHaveLength(1)
      expect(m.find('welcome-files-cut')).not.toBeNull()
      await m.click('welcome-profile-continue')
      await m.until(() => stepOf(m) === 'skills', '내 스킬')
      expect(called('POST /api/onboarding/welcome/first-result')[0]!.body.files).toHaveLength(10)
    } finally { await m.unmount() }
  })

  test('the deck line names the list as the sidebar heading does (its own message, sidebar.recents): on a phone in the ☰ menu', async () => {
    signIn('owner')
    phoneWidth()
    profile = SAVED
    progress = atProfile()
    tier = 'quick'
    const m = await app()
    try {
      await m.until(() => m.find('welcome-deck-line'), 'the deck line')
      expect(m.get('welcome-deck-line').textContent).toBe(`저장하면 회사 소개서를 만들기 시작해요 · 3분쯤 · ☰ 메뉴의 ${historyName((k, p) => translate('ko', k, p))} › '우리 회사 소개서'`)
    } finally { await m.unmount() }
  })

  test('나중에 on a saved 회사 소개: on to 내 스킬, no deck', async () => {
    signIn('owner')
    profile = SAVED
    progress = atProfile()
    const m = await app()
    try {
      await m.until(() => m.find('welcome-profile-continue'), 'the saved 회사 소개')
      await m.click(laterButton())
      await m.until(() => stepOf(m) === 'skills', '내 스킬')
      expect(called('POST /api/onboarding/welcome/first-result')).toEqual([])
      expect(progress!.steps.profile).toBe('skipped')
      expect(progress!.resultChatId).toBeNull()
    } finally { await m.unmount() }
  })

  test('the server refuses (no profile and no website yet): its words in a note, nothing sent; a later failure keeps the same chat; one message in the end', async () => {
    signIn('owner')
    profile = SAVED
    progress = atProfile()
    firstResultRefusal = '홈페이지나 회사 소개가 아직 없어요. 회사 소개를 먼저 해 주세요.'
    const m = await app()
    try {
      await m.until(() => m.find('welcome-profile-continue'), 'the saved 회사 소개')
      await m.click('welcome-profile-continue')
      await m.until(() => m.html().includes(firstResultRefusal!), 'the refusal')
      expect(sent()).toEqual([])
      expect(stepOf(m)).toBe('profile')
      expect(progress!.steps.profile).toBeNull()
      // then attaching fails once: the chat was made (and recorded) and is handed out again
      firstResultRefusal = null
      failAttach = 1
      await m.click(retryButton())
      await m.until(() => m.html().includes('붙이지 못했어요'), 'the attach failure')
      // the chat was made and is kept for the deck, but nothing counts before its message is in
      expect(deckKept).toBe(CHAT)
      expect(progress!.resultChatId).toBeNull()
      await m.click(retryButton())
      await m.until(() => stepOf(m) === 'skills', '내 스킬')
      expect(called('POST /api/onboarding/welcome/first-result')).toHaveLength(3)
      await m.until(() => sent().length === 1, 'the deck message')
    } finally { await m.unmount() }
  })

  test('the deck\'s message is not taken (its budget used up): 회사 소개 stays with the reason and counts nothing; 저장하고 계속 again sends into the same chat with the same message id', async () => {
    signIn('owner')
    profile = SAVED
    progress = atProfile({ steps: { profile: 'done', result: null, skills: 'done', files: 'done', invite: 'done' } })
    failSends = [{ status: 402, code: 'budget_exceeded', message: '이번 달 AI 사용 한도를 다 썼어요.' }]
    const m = await app()
    try {
      await m.until(() => m.find('welcome-profile-continue'), 'the saved 회사 소개')
      await m.click('welcome-profile-continue')
      await m.until(() => m.html().includes('이번 달 AI 사용 한도를 다 썼어요.'), 'the reason')
      // still 회사 소개: not answered, no deck recorded, no end screen
      expect(stepOf(m)).toBe('profile')
      expect(called('PATCH /api/onboarding/welcome').filter((c) => c.body.step?.id === 'profile')).toEqual([])
      expect(progress!.steps.profile).toBe('done')
      expect(progress!.resultChatId).toBeNull()
      expect(progress!.finishedAt).toBeNull()
      // again: the same chat (kept), the same message id; then the steps go on
      await m.click(retryButton())
      await m.until(() => m.find('welcome-done'), 'the end screen')
      expect(called('POST /api/onboarding/welcome/first-result')).toHaveLength(2)
      expect(sent().map((c) => c.body.clientMessageId)).toEqual([deckMessageId(CHAT), deckMessageId(CHAT)])
      expect(progress!.resultChatId).toBe(CHAT)
      expect(progress!.finishedAt).not.toBeNull()
    } finally { await m.unmount() }
  })

  test('a review in the steps asks once: its one button "저장하고 계속" saves and starts the deck, the files link above it and the deck line under it; a deck that fails stays on the review with its reason, and the same button goes on', async () => {
    signIn('owner')
    progress = atProfile()
    failSends = [{ status: 402, code: 'budget_exceeded', message: '이번 달 AI 사용 한도를 다 썼어요.' }]
    routes['PUT /api/onboarding/profile'] = (b) => json(200, (profile = { ...b, updatedAt: '2026-11-05T00:00:00.000Z' }))
    const m = await app()
    try {
      // no website: the three questions, then the review
      await m.until(() => m.find('profile-step-site'), '회사 소개')
      await m.click(buttonNamed('홈페이지가 없어요'))
      await m.click(await m.until(() => m.find('profile-step-to-questions'), 'the fallback'))
      await m.type(m.get('profile-step-questions').querySelector('textarea')!, 'Desk fans')
      await m.click(m.get('profile-step-questions').querySelector('button[type="submit"]')!)
      const review = await m.until(() => m.find('profile-step-review'), 'the review')
      // one save, and it goes on: no plain 저장, one primary, the deck line right under it, the files link above it
      expect(review.querySelectorAll('button').map((b: any) => b.textContent)).not.toContain('저장')
      expect(m.get('profile-step-save').textContent).toBe('저장하고 계속')
      expect(primaries(m)).toBe(1)
      const line = review.querySelector('[data-testid="welcome-deck-line"]')!
      expect(line.textContent).toBe(translate('ko', 'welcome.profile.deckLine', { min: 5, name: historyName((k, p) => translate('ko', k, p)) }))
      const html = m.html()
      expect(html.indexOf('data-testid="welcome-files-pick"')).toBeLessThan(html.indexOf('data-testid="profile-step-save"'))
      expect(html.indexOf('data-testid="profile-step-save"')).toBeLessThan(html.indexOf('data-testid="welcome-deck-line"'))
      // pressed once: saved, then the deck; its message is not taken: the reason on the review, nothing counted
      await m.click('profile-step-save')
      await m.until(() => m.get('profile-step-review').textContent!.includes('이번 달 AI 사용 한도를 다 썼어요.'), 'the reason on the review')
      expect(called('PUT /api/onboarding/profile').map((c) => c.body.products)).toEqual(['Desk fans'])
      expect(called('POST /api/onboarding/welcome/first-result')).toHaveLength(1)
      expect(stepOf(m)).toBe('profile')
      expect(called('PATCH /api/onboarding/welcome').filter((c) => c.body.step?.id === 'profile')).toEqual([])
      // the same button again: saved again, the deck goes in, on to 내 스킬; no "saved" toast (the next step says it)
      await m.click('profile-step-save')
      await m.until(() => stepOf(m) === 'skills', '내 스킬')
      expect(called('PUT /api/onboarding/profile')).toHaveLength(2)
      expect(sent().map((c) => c.body.clientMessageId)).toEqual([deckMessageId(CHAT), deckMessageId(CHAT)])
      expect(called('PATCH /api/onboarding/welcome').map((c) => c.body).filter((b) => b.step?.id === 'profile')).toEqual([{ step: { id: 'profile', state: 'done' }, resultChatId: CHAT }])
      expect(useUi.getState().toasts.map((x) => x.text)).not.toContain(translate('ko', 'onboarding.profile.saved'))
    } finally {
      await m.unmount()
      delete routes['PUT /api/onboarding/profile']
    }
  }, 30_000)

  test('leaving 회사 소개 while it reads the website and coming back: the typed address is still there (kept in the progress as the reading starts)', async () => {
    signIn('owner')
    progress = atProfile()
    const DRAFT = '01900000-0000-7000-8000-0000000000da'
    routes['POST /api/onboarding/profile/draft'] = () => json(201, { chatId: DRAFT, website: 'https://acme.example/', site: 'acme.example' })
    routes[`GET /api/onboarding/profile/draft/${DRAFT}`] = () => json(200, { status: 'running', website: 'https://acme.example/', draft: null, error: null, steps: [] })
    const siteInput = (m: Mounted) => m.get('profile-step-site').querySelector('input[inputmode="url"]') as unknown as FakeElement & { value: string }
    let m = await app()
    try {
      await m.until(() => m.find('profile-step-site'), '회사 소개')
      expect(siteInput(m).value).toBe('')
      await m.type(siteInput(m), 'acme.example')
      await m.click(m.get('profile-step-site').querySelector('button[type="submit"]')!)
      await m.until(() => m.find('profile-step-reading'), 'reading')
      await m.until(() => progress!.site === 'https://acme.example/', 'the address kept', 2000)
      expect(called('PATCH /api/onboarding/welcome').map((c) => c.body).filter((b) => b.site)).toEqual([{ site: 'https://acme.example/' }])
    } finally { await m.unmount() }
    // another page, then back through the setup row: the steps read the progress again
    useWelcome.getState().reset()
    calls = []
    m = await app()
    try {
      await m.until(() => m.find('profile-step-site'), '회사 소개 again')
      expect(siteInput(m).value).toBe('https://acme.example/')
    } finally {
      await m.unmount()
      delete routes['POST /api/onboarding/profile/draft']
      delete routes[`GET /api/onboarding/profile/draft/${DRAFT}`]
    }
  })

  test('the team\'s start blocked by the folder rules: leaving 회사 소개 says so, and the steps go on', async () => {
    signIn('owner')
    teamBlocked = true
    progress = fresh()
    const m = await app()
    try {
      await m.until(() => m.find('profile-step-site'), 'the profile step')
      await m.click(laterButton())
      await m.until(() => stepOf(m) === 'skills' && m.html().includes(translate('ko', 'welcome.packBlocked')), 'the message on 내 스킬')
    } finally { await m.unmount() }
  })

  test('no AI that answers the owner: the AI step comes first (1/5) with the three ways at once; 나중에 leaves the steps', async () => {
    signIn('owner')
    ai = { usable: false, action: 'connect_team', requested: false }
    progress = fresh()
    const m = await app()
    try {
      await m.until(() => m.find('welcome-ai-claude'), 'the AI step')
      expect(stepOf(m)).toBe('ai')
      const li = m.get('welcome-progress').querySelectorAll('li')
      expect(items(m)).toEqual(['ai', 'profile', 'skills', 'files', 'invite'])
      expect(li[0]!.getAttribute('aria-current')).toBe('step')
      expect(li[0]!.textContent).toContain(translate('ko', 'welcome.progress.item', { n: 1, total: 5, label: translate('ko', 'welcome.progress.ai') }))
      expect(m.get('welcome-ai-ways').querySelectorAll('button').map((b: any) => b.getAttribute('data-testid'))).toEqual(['welcome-ai-claude', 'welcome-ai-chatgpt', 'welcome-ai-keys'])
      expect(m.find('profile-step-site')).toBeNull()
      expect(m.find('welcome-back')).toBeNull()
      await m.click('welcome-ai-claude')
      await m.until(() => body().querySelector('[data-testid="claude-login-how"]'), 'the Claude sign-in dialog')
      await m.until(() => progress!.steps.ai === 'skipped', 'the AI step recorded as needed')
      await act(async () => { buttonNamed(translate('ko', 'common.cancel'))?.click() })
      await m.click('welcome-later')
      await m.until(() => at(m) === '/', 'Home')
      expect(progress!.steps.profile).toBeNull()
      expect(stepsSeen('olga')).toBe(true)
    } finally { await m.unmount() }
  })

  test('AI connected in the AI step: recorded once, then on to 회사 소개 (2/5); AI from the start: four steps', async () => {
    signIn('owner')
    ai = { usable: false, action: 'connect_team', requested: false }
    progress = fresh()
    const m = await app()
    try {
      await m.until(() => m.find('welcome-ai-claude'), 'the AI step')
      ai = { usable: true, action: 'connect_team', requested: false }
      await act(async () => { await useAiAccess.getState().load(true) })
      await m.until(() => stepOf(m) === 'profile', 'on to 회사 소개')
      expect(progress!.steps.ai).toBe('done')
      expect(called('PATCH /api/onboarding/welcome').filter((c) => c.body?.step?.id === 'ai').map((c) => c.body.step.state)).toEqual(['skipped', 'done'])
      expect(items(m)).toEqual(['ai', 'profile', 'skills', 'files', 'invite'])
      expect(m.get('welcome-progress').querySelectorAll('li')[1]!.getAttribute('aria-current')).toBe('step')
    } finally { await m.unmount() }
    // connected elsewhere after the step was shown: opening the steps records it done
    progress = { ...fresh(), steps: { ai: 'skipped', profile: null, result: null, invite: null } } as WelcomeProgress
    const m1 = await app()
    try {
      await m1.until(() => stepOf(m1) === 'profile', 'the profile step')
      expect(progress!.steps.ai).toBe('done')
    } finally { await m1.unmount() }
    progress = fresh()
    const m3 = await app()
    try {
      await m3.until(() => stepOf(m3) === 'profile', 'the profile step')
      expect(items(m3)).toEqual(['profile', 'skills', 'files', 'invite'])
    } finally { await m3.unmount() }
  })

  test('without AI, 회사 소개 answered: the steps open on 내 스킬, then the invite, never the AI step', async () => {
    signIn('owner')
    ai = { usable: false, action: 'connect_team', requested: false }
    for (const [steps, want] of [[{ profile: 'done', result: null, skills: null, files: null, invite: null }, 'skills'], [{ profile: 'done', result: null, skills: 'done', files: 'skipped', invite: null }, 'invite']] as const) {
      progress = ran({ steps: { ...steps } })
      const m = await app()
      try {
        await m.until(() => stepOf(m) === want, want)
        expect(m.find('welcome-ai')).toBeNull()
        expect(items(m)).toEqual(['profile', 'skills', 'files', 'invite'])
        await act(async () => { await new Promise((r) => setTimeout(r, 30)) })
        expect(progress!.steps.ai).toBeUndefined()
      } finally { await m.unmount() }
      useWelcome.getState().reset()
      calls = []
    }
  })

  test('the step bar to a screen reader: the AI step recorded as shown (`skipped`) is open, never "나중에 하기로 했어요"; a step put off says so', async () => {
    signIn('owner')
    ai = { usable: false, action: 'connect_team', requested: false }
    const putOff = translate('ko', 'welcome.progress.skipped')
    const label = (m: Mounted, s: string) => m.get('welcome-progress').querySelector(`[data-progress-step="${s}"]`)!.textContent
    // the AI step on screen, recorded as shown on an earlier visit
    progress = { ...fresh(), steps: { ai: 'skipped', profile: null, result: null, skills: null, files: null, invite: null } }
    let m = await app()
    try {
      await m.until(() => m.find('welcome-ai'), 'the AI step')
      expect(label(m, 'ai')).toBe(translate('ko', 'welcome.progress.item', { n: 1, total: 5, label: translate('ko', 'welcome.progress.ai') }))
    } finally { await m.unmount() }
    useWelcome.getState().reset()
    // 회사 소개 put off without AI: the steps go on with the AI step on the bar, still not "put off"
    progress = { ...atProfile(), steps: { ai: 'skipped', profile: 'skipped', result: null, skills: null, files: null, invite: null } }
    m = await app()
    try {
      await m.until(() => stepOf(m) === 'skills', '내 스킬')
      expect(label(m, 'ai')).not.toContain(putOff)
      expect(label(m, 'profile')).toContain(putOff)
    } finally { await m.unmount() }
  })
})

describe('the later steps and the end', () => {
  const withGroup = () => { routes['GET /api/admin/groups'] = () => json(200, { items: [{ id: TEAM.id, name: 'Acme', description: null, memberIds: ['olga'] }] }) }
  /** the open team link the server has (null: none) */
  const openLink = (over: Partial<TeamLink> = {}, seats: { used: number; limit: number | null } = { used: 1, limit: null }) => {
    const link: TeamLink = { id: '01900000-0000-7000-8000-000000000002', url: 'https://acme.example/join#t=open', groupIds: [TEAM.id], skill: null, maxUses: 20, uses: 0, createdBy: { id: 'olga', name: '올가' }, createdAt: '2026-11-04T00:00:00.000Z', expiresAt: '2026-11-18T00:00:00.000Z', state: 'active', ...over }
    routes['GET /api/admin/team-link'] = () => json(200, { link, seats })
    routes['PATCH /api/admin/team-link'] = (b) => json(200, { link: { ...link, skill: { path: b.skillPath, name: skillNameOf(b.skillPath), title: TITLES[b.skillPath] ?? null }, groupIds: [...new Set([...link.groupIds, ...b.addGroupIds])] }, seats })
    return link
  }
  afterEach(() => {
    routes['GET /api/admin/groups'] = () => json(200, { items: [] })
    routes['GET /api/admin/team-link'] = () => json(200, { link: null, seats: { used: 1, limit: null } })
    delete routes['PATCH /api/admin/team-link']
    forgetPatched()
  })

  test('팀 파일 가져오기: files into the team\'s folder with its who-sees line; the next step once in', async () => {
    signIn('owner')
    progress = ran({ steps: { profile: 'done', result: null, skills: 'skipped', files: null, invite: null } })
    const saved = routes['GET /api/admin/groups']!
    routes['GET /api/admin/groups'] = () => json(200, { items: [{ id: TEAM.id, name: 'Acme', description: null, memberIds: ['olga'] }, { id: '01900000-0000-7000-8000-0000000000e2', name: '영업', description: null, memberIds: [] }] })
    routes['GET /api/admin/folders'] = () => json(200, { items: [{ id: '01900000-0000-7000-8000-0000000000f2', path: 'groups/영업', exists: true, rules: [], createdAt: '2026-11-04T00:00:00.000Z', groupId: '01900000-0000-7000-8000-0000000000e2', keep: 'group' }] })
    const m = await app()
    try {
      await m.until(() => m.find('welcome-team-files-pick'), '팀 파일')
      expect(m.get('welcome-files-who').textContent).toContain('Acme')
      expect(m.find('welcome-team-files-next')).toBeNull()
      await m.until(() => m.find('welcome-team-files-place'), 'the folder choice')
      await choose(m, [note('2025 보고서.md'), note('견적 양식.md')], 'welcome-team-files-input')
      await m.until(() => m.find('welcome-team-files-next'), 'the files went in')
      expect(called('POST /api/files/upload').map((c) => `${c.body.folder}/${c.body.name}`)).toEqual(['groups/Acme/2025 보고서.md', 'groups/Acme/견적 양식.md'])
      expect(m.get('welcome-team-files-next').textContent).toBe('다음: 팀원 초대')
      await m.click('welcome-team-files-next')
      // the invite (no deck chat opens by itself any more)
      await m.until(() => stepOf(m) === 'invite', 'the invite')
      expect(progress!.steps.files).toBe('done')
      expect(m.find('where')).toBeNull()
    } finally {
      await m.unmount()
      routes['GET /api/admin/groups'] = saved
      routes['GET /api/admin/folders'] = () => json(200, { items: [] })
    }
  })

  test('the invite with nothing shared: the link made as it opens with no skill (it lands on Home: docs/DECISIONS.md "DS3"), the message at once; done → the end screen once, 홈으로 its one button', async () => {
    signIn('owner')
    progress = ran({ teamType: 'marketing' })
    withGroup()
    const m = await app()
    try {
      await m.until(() => stepOf(m) === 'invite', 'the invite')
      await m.until(() => m.find('team-link-message'), 'the message')
      // no pack skill stands in for the skill: never the deck, never an old 할 일 정리
      expect(called('POST /api/admin/team-link').map((c) => c.body)).toEqual([{ groupIds: [TEAM.id], expiresInDays: 14 }])
      expect(m.get('invite-step').querySelector('h2')?.textContent).toBe('팀원을 초대해요')
      expect(m.get('team-link-message').textContent).not.toContain('스킬을 같이 써 보자고')
      expect(m.get('team-link-message').textContent).not.toContain('회사 소개서')
      expect(m.find('team-link-create')).toBeNull()
      await m.click('invite-step-done')
      // 준비 끝났어요: the deck line (no button), 홈으로 the one primary
      await m.until(() => m.find('welcome-done'), 'the end screen')
      expect(stepOf(m)).toBe('done')
      expect(progress!.steps.invite).toBe('done')
      expect(progress!.finishedAt).not.toBeNull()
      expect(m.find('welcome-progress')).toBeNull()
      expect(m.find('welcome-back')).toBeNull()
      expect(m.get('welcome-done').querySelector('h2')?.textContent).toBe('준비 끝났어요')
      expect(m.get('welcome-done').textContent).toContain(`회사 소개서는 ${historyName((k, p) => translate('ko', k, p))}의 '우리 회사 소개서'에 있어요`)
      expect(m.find('welcome-done-try')).toBeNull()
      expect(m.get('welcome-done-home').textContent).toBe('홈으로')
      expect(primaries(m)).toBe(1)
      await m.until(() => called('PATCH /api/onboarding/welcome').filter((c) => c.body.doneShown).length === 1, 'shown once')
      expect(progress!.doneShownAt).not.toBeNull()
      await m.click('welcome-done-home')
      await m.until(() => at(m) === '/', 'Home')
      expect(called('PATCH /api/onboarding/welcome').filter((c) => c.body.doneShown)).toHaveLength(1)
    } finally { await m.unmount() }
  })

  test('the invite with a shared skill: the link made for it, the message names it; the end screen tries it first (the form a member lands on), 홈으로 quiet', async () => {
    signIn('owner')
    progress = ran({ shared: { at: '2026-11-04T00:05:00.000Z', skills: [{ path: QUOTE_SKILL, title: '견적서 쓰기' }], landing: QUOTE_SKILL }, landingSkill: QUOTE_SKILL })
    withGroup()
    const m = await app()
    try {
      await m.until(() => m.find('team-link-message'), 'the message')
      expect(called('POST /api/admin/team-link').map((c) => c.body)).toEqual([{ groupIds: [TEAM.id], expiresInDays: 14, skillPath: QUOTE_SKILL }])
      expect(m.get('team-link-message').textContent).toContain("'견적서 쓰기' 스킬을 같이 써 보자고 해요")
      await m.click('invite-step-done')
      await m.until(() => m.find('welcome-done'), 'the end screen')
      await m.until(() => m.get('welcome-done-try').textContent === "'견적서 쓰기' 먼저 써 보기", 'the skill named')
      expect(m.get('welcome-done-home').textContent).toBe('홈으로')
      expect(m.get('welcome-done-home').getAttribute('class') ?? '').not.toContain('bg-accent ')
      expect(primaries(m)).toBe(1)
      await m.click('welcome-done-try')
      await m.until(() => at(m) === `/skills?run=${encodeURIComponent(QUOTE_SKILL)}`, 'the skill form')
    } finally { await m.unmount() }
  })

  test('the end screen without a deck has no deck line; while no AI answers its primary is "AI 연결하기"; 홈으로 goes Home', async () => {
    signIn('owner')
    ai = { usable: false, action: 'connect_team', requested: false }
    progress = atProfile({ steps: { profile: 'skipped', result: null, skills: 'done', files: 'done', invite: null } })
    withGroup()
    const m = await app()
    try {
      await m.until(() => m.find('invite-step-done'), 'the invite')
      await m.click('invite-step-done')
      await m.until(() => m.find('welcome-done'), 'the end screen')
      expect(m.get('welcome-done').textContent).not.toContain('회사 소개서')
      expect(m.get('welcome-done-ai').textContent).toBe('AI 연결하기')
      expect(m.find('welcome-done-try')).toBeNull()
      await m.click('welcome-done-ai')
      await m.until(() => called('GET /api/admin/credentials').length, 'the connect dialog')
      await act(async () => { buttonNamed(translate('ko', 'common.cancel'))?.click() })
      await m.click('welcome-done-home')
      await m.until(() => at(m) === '/', 'Home')
    } finally { await m.unmount() }
  })

  test('the end screen\'s deck line and its skill are the server\'s facts: a first result of a row from before is no deck; the shared skill that is gone is not offered', async () => {
    signIn('owner')
    const weekly = 'skills/weekly-report/SKILL.md'
    // old row (b): a first result answered in its own chat (a card news), so `resultChatId` is set but no deck started;
    // the shared skill was deleted since, so the server points at none (no pack skill stands in: docs/DECISIONS.md "DS3")
    progress = ran({ steps: { profile: 'done', result: 'done', skills: 'done', files: 'done', invite: null }, resultChatId: CHAT, deckStarted: false,
      shared: { at: '2026-11-04T00:05:00.000Z', skills: [{ path: weekly, title: '주간 업무 보고' }], landing: weekly }, landingSkill: null })
    withGroup()
    const m = await app()
    try {
      await m.until(() => m.find('team-link-message'), 'the invite')
      expect(called('POST /api/admin/team-link').map((c) => c.body.skillPath)).toEqual([undefined])
      expect(m.get('team-link-message').textContent).not.toContain('주간 업무 보고')
      await m.click('invite-step-done')
      await m.until(() => m.find('welcome-done'), 'the end screen')
      expect(m.get('welcome-done').textContent).not.toContain('회사 소개서')
      expect(m.find('welcome-done-try')).toBeNull()
      expect(m.get('welcome-done-home').textContent).toBe('홈으로')
    } finally { await m.unmount() }
  })

  test('a shared skill without a title (no AI judged it) is named as words on the end screen and in 바꾸기, never "quote-maker"', async () => {
    signIn('owner')
    const quote = 'skills/quote-maker/SKILL.md', weekly = 'skills/weekly-report/SKILL.md'
    progress = ran({ shared: { at: '2026-11-04T00:05:00.000Z', skills: [{ path: quote, title: 'quote-maker' }, { path: weekly, title: 'weekly-report' }], landing: quote }, landingSkill: quote })
    withGroup()
    const m = await app()
    try {
      await m.until(() => m.find('team-link-landing-change'), 'the invite with 바꾸기')
      expect(m.get('team-link-landing-change').querySelectorAll('option').map((o: any) => o.textContent)).toEqual(['quote maker', 'weekly report'])
      await m.click('invite-step-done')
      await m.until(() => m.find('welcome-done-try')?.textContent === "'quote maker' 먼저 써 보기", 'the end screen names it as words')
    } finally { await m.unmount() }
  })

  test('the end screen shows once: 내 스킬 finished later on a computer (after the phone\'s end) goes Home with "시작 설정을 마쳤어요"', async () => {
    signIn('owner')
    // a computer's browser (the folder window)
    g.showDirectoryPicker = async () => { throw Object.assign(new Error('closed'), { name: 'AbortError' }) }
    progress = ran({ skillsLater: true, doneShownAt: '2026-11-04T00:04:00.000Z', steps: { profile: 'done', result: null, skills: 'skipped', files: 'done', invite: 'done' } })
    const m = await app()
    try {
      await m.until(() => stepOf(m) === 'skills' && m.find('skills-later'), '내 스킬 on a computer')
      await m.click('skills-later')
      await m.until(() => at(m) === '/', 'Home')
      expect(progress!.finishedAt).not.toBeNull()
      expect(useUi.getState().toasts.some((x) => x.text === translate('ko', 'welcome.finished'))).toBe(true)
      expect(called('PATCH /api/onboarding/welcome').filter((c) => c.body.doneShown)).toEqual([])
    } finally { await m.unmount() }
  })

  test('the invite names ONE skill (the landing one of those shared from 내 스킬); 바꾸기 picks another', async () => {
    signIn('owner')
    const weekly = 'skills/weekly-report/SKILL.md', quote = 'skills/quote-draft/SKILL.md'
    TITLES[weekly] = '주간 업무 보고'
    TITLES[quote] = '견적서 초안'
    progress = ran({ shared: { at: '2026-11-04T00:05:00.000Z', skills: [{ path: weekly, title: '주간 업무 보고' }, { path: quote, title: '견적서 초안' }], landing: weekly } })
    withGroup()
    const m = await app()
    try {
      await m.until(() => m.find('team-link-message'), 'the message')
      expect(called('POST /api/admin/team-link').map((c) => c.body.skillPath)).toEqual([weekly])
      expect(m.get('team-link-message').textContent).toContain("'주간 업무 보고' 스킬을 같이 써 보자고 해요")
      expect(m.get('team-link-message').textContent).not.toContain('견적서 초안')
      expect(m.get('team-link-landing').textContent).toContain("들어오면 '주간 업무 보고'부터 열려요")
      const select = m.get('team-link-landing-change') as any
      await act(async () => { select.value = quote; select.dispatchEvent(new FakeEvent('change', { bubbles: true })) })
      await m.until(() => progress!.shared!.landing === quote, 'the landing changed')
      expect(inviteSkill(progress!)).toBe(quote)
    } finally {
      await m.unmount()
      delete TITLES[weekly]
      delete TITLES[quote]
    }
  })

  test('the goal card\'s [팀원 초대] during the steps (its router state) opens the invite step itself, not where the steps would resume', async () => {
    signIn('owner')
    progress = atProfile({ steps: { profile: 'skipped', result: null, skills: null, files: null, invite: null } })
    withGroup()
    const m = await app({ pathname: '/welcome', state: INVITE_STEP_STATE })
    try {
      await m.until(() => stepOf(m) === 'invite' && m.find('team-link-message'), 'the invite step')
    } finally { await m.unmount() }
    useWelcome.getState().reset()
    // without it: where the steps resume (내 스킬)
    const n = await app()
    try {
      await n.until(() => stepOf(n) === 'skills', '내 스킬')
    } finally { await n.unmount() }
  })

  test('another screen of the owner made a link meanwhile: read again right before, that link is used, none made over it', async () => {
    signIn('owner')
    progress = ran()
    withGroup()
    const link = openLink({ skill: { path: QUOTE_SKILL, name: 'quote-maker', title: '견적서 쓰기' }, url: 'https://acme.example/join#t=other' })
    let reads = 0
    routes['GET /api/admin/team-link'] = () => json(200, reads++ === 0 ? { link: null, seats: { used: 1, limit: null } } : { link, seats: { used: 1, limit: null } })
    const m = await mount(<MemoryRouter><InviteStep skillPath={QUOTE_SKILL} retarget prepare onDone={() => {}} /></MemoryRouter>)
    try {
      await m.until(() => m.find('team-link-message'), 'the message')
      expect(reads).toBeGreaterThanOrEqual(2)
      expect(called('POST /api/admin/team-link')).toEqual([])
      expect(m.get('team-link-message').textContent).toContain('https://acme.example/join#t=other')
    } finally { await m.unmount() }
  })

  test('the read right before making a link fails: nothing is made, the form with its "make link" button stays', async () => {
    signIn('owner')
    progress = ran()
    withGroup()
    let reads = 0
    routes['GET /api/admin/team-link'] = () => reads++ === 0 ? json(200, { link: null, seats: { used: 1, limit: null } }) : json(500, { error: { code: 'internal', message: '읽지 못했어요' } })
    const m = await mount(<MemoryRouter><InviteStep skillPath={QUOTE_SKILL} retarget prepare onDone={() => {}} /></MemoryRouter>)
    try {
      await m.until(() => m.find('team-link-create'), 'the make-link button')
      expect(reads).toBeGreaterThanOrEqual(2)
      expect(called('POST /api/admin/team-link')).toEqual([])
      expect(m.find('team-link-message')).toBeNull()
    } finally { await m.unmount() }
  })

  test('an open link that still leads to the intro deck is changed to the landing skill, same address; nothing made', async () => {
    signIn('owner')
    progress = ran()
    withGroup()
    openLink({ groupIds: [], skill: { path: GENERAL_DECK_SKILL, name: 'intro-deck', title: '회사 소개서' } })
    const m = await mount(<MemoryRouter><InviteStep skillPath={QUOTE_SKILL} retarget prepare onDone={() => {}} /></MemoryRouter>)
    try {
      await m.until(() => m.find('team-link-message') && called('PATCH /api/admin/team-link').length, 'the message')
      expect(called('PATCH /api/admin/team-link').map((c) => c.body)).toEqual([{ skillPath: QUOTE_SKILL, addGroupIds: [TEAM.id] }])
      expect(called('POST /api/admin/team-link')).toEqual([])
      await m.until(() => m.get('team-link-message').textContent?.includes("'견적서 쓰기' 스킬을 같이 써 보자고 해요"), 'the landing skill named')
      expect(m.get('team-link-message').textContent).toContain('https://acme.example/join#t=open')
    } finally { await m.unmount() }
  })

  test('an open link that already leads there is used as it is; a link that may still work is never replaced by itself', async () => {
    signIn('owner')
    progress = ran()
    withGroup()
    openLink({ skill: { path: QUOTE_SKILL, name: 'quote-maker', title: '견적서 쓰기' } })
    let m = await mount(<MemoryRouter><InviteStep skillPath={QUOTE_SKILL} retarget prepare onDone={() => {}} /></MemoryRouter>)
    try {
      await m.until(() => m.find('team-link-message'), 'the message')
      expect(m.get('team-link-message').textContent).toContain('https://acme.example/join#t=open')
      expect(called('POST /api/admin/team-link')).toEqual([])
      expect(called('PATCH /api/admin/team-link')).toEqual([])
    } finally { await m.unmount() }
    for (const [over, seats] of [[{ state: 'stopped' }, undefined], [{ url: null }, undefined], [{ state: 'expired' }, { used: 5, limit: 5 }]] as const) {
      calls = []
      openLink(over as Partial<TeamLink>, seats)
      m = await mount(<MemoryRouter><InviteStep skillPath={QUOTE_SKILL} retarget prepare onDone={() => {}} /></MemoryRouter>)
      try {
        await m.until(() => m.find('team-link-create'), 'the button')
        await m.settle(30)
        expect(called('POST /api/admin/team-link')).toEqual([])
        expect(called('PATCH /api/admin/team-link')).toEqual([])
        expect(m.find(seats ? 'team-link-full' : 'team-link-stale')).not.toBeNull()
      } finally { await m.unmount() }
    }
  })

  test('a link that ran out (its date, or its uses) is replaced as the invite opens: its groups and the team\'s, the skill', async () => {
    signIn('owner')
    progress = ran()
    withGroup()
    for (const state of ['expired', 'used_up'] as const) {
      calls = []
      openLink({ state, groupIds: ['01900000-0000-7000-8000-0000000000e2'], skill: { path: GENERAL_DECK_SKILL, name: 'intro-deck', title: '회사 소개서' } })
      const m = await mount(<MemoryRouter><InviteStep skillPath={QUOTE_SKILL} retarget prepare onDone={() => {}} /></MemoryRouter>)
      try {
        await m.until(() => m.find('team-link-message'), 'the message')
        expect(called('POST /api/admin/team-link').map((c) => c.body)).toEqual([{ groupIds: ['01900000-0000-7000-8000-0000000000e2', TEAM.id], expiresInDays: 14, skillPath: QUOTE_SKILL }])
        expect(m.find('team-link-stale')).toBeNull()
      } finally { await m.unmount() }
    }
  })

  test('nothing shared (the wizard passes no skill): a ran-out link to the intro deck is replaced with a link to Home, never its skill', async () => {
    signIn('owner')
    progress = ran()
    withGroup()
    openLink({ state: 'expired', groupIds: ['01900000-0000-7000-8000-0000000000e2'], skill: { path: GENERAL_DECK_SKILL, name: 'intro-deck', title: '회사 소개서' } })
    const m = await mount(<MemoryRouter><InviteStep skillPath={null} prepare onDone={() => {}} /></MemoryRouter>)
    try {
      await m.until(() => m.find('team-link-message'), 'the message')
      expect(called('POST /api/admin/team-link').map((c) => c.body)).toEqual([{ groupIds: ['01900000-0000-7000-8000-0000000000e2', TEAM.id], expiresInDays: 14 }])
      expect(m.get('team-link-message').textContent).not.toContain('회사 소개서')
    } finally { await m.unmount() }
  })

  test('only the owner walking the steps gets a link made in advance: an admin, or the invite elsewhere (the goal card), presses the button', async () => {
    progress = ran()
    withGroup()
    for (const [role, prepare] of [['admin', true], ['owner', false]] as const) {
      calls = []
      useWelcome.getState().reset()
      signIn(role)
      const m = await mount(<MemoryRouter><InviteStep skillPath={QUOTE_SKILL} prepare={prepare} onDone={() => {}} /></MemoryRouter>)
      try {
        await m.until(() => m.find('team-link-create'), 'the button')
        await m.settle(30)
        expect(called('POST /api/admin/team-link')).toEqual([])
      } finally { await m.unmount() }
    }
  })

  // ---- the team skill card ("S") on its own: the bar under the first result shares the pack's skill now, and the card
  // opens from the one suggestion under a later answer (result-suggestion.test.tsx, "W3"); it keeps working with the
  // invite after it, as the bar showed it before
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
  })
  /** the card, then the invite with the skill it saved (the made message) */
  function CardThenInvite({ onLater = () => {} }: { onLater?: () => void }) {
    const [shared, setShared] = useState<SavedSkillDraft | null>(null)
    return shared ? <InviteStep title={null} skillPath={shared.path} made onDone={() => {}} /> : <SkillShareCard chatId={CHAT} onShared={setShared} onLater={onLater} />
  }

  test('the team skill card: six things, the title changed by a tap; shared, then the invite with that skill', async () => {
    signIn('owner')
    progress = ran()
    withGroup()
    drafting({ status: 'done', draft: CARD })
    const m = await mount(<MemoryRouter><CardThenInvite /></MemoryRouter>)
    try {
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

  test('the invite after sharing a card: an open link that led elsewhere is changed to the skill; the message says it was made', async () => {
    signIn('owner')
    progress = ran()
    withGroup()
    drafting({ status: 'done', draft: { ...CARD, inputs: [{ name: 'customer', label: '고객사', required: true }, { name: 'items', label: '품목' }], files: [{ path: 'groups/Acme/회의록/견적서_양식.xlsx', latest: false }], recurring: false } })
    const open = openLink({ skill: { path: QUOTE_SKILL, name: 'quote-maker', title: '견적서 쓰기' } })
    routes['PATCH /api/admin/team-link'] = (b) => json(200, { link: { ...open, skill: { path: b.skillPath, name: SHARED.name, title: SHARED.title } }, seats: { used: 1, limit: null } })
    const m = await mount(<MemoryRouter><CardThenInvite /></MemoryRouter>)
    try {
      await m.until(() => m.find('skill-share')?.getAttribute('data-state') === 'ready', 'the card', 6000)
      expect(m.get('skill-share-asks').textContent).toBe('팀원에게 물어볼 것:고객사 · 품목')
      expect(m.get('skill-share-files').textContent).toBe('쓰는 자료:견적서_양식.xlsx')
      expect(m.find('skill-share-choice')).toBeNull()
      await m.click('skill-share-share')
      await m.until(() => m.find('team-link-message'), 'the message')
      expect(called('PATCH /api/admin/team-link').map((c) => c.body)).toEqual([{ skillPath: SHARED.path, addGroupIds: [TEAM.id] }])
      expect(m.get('team-link-message').textContent).toBe("Acme에 '주간 회의 할 일' 스킬을 만들어 뒀어요. 링크 열면 같은 방식으로 바로 써요.\nhttps://acme.example/join#t=open")
    } finally { await m.unmount() }
  })

  test('no card when the draft could not be made: "지금은 정리하지 못했어요"; 다시 정리하기 drafts again; 나중에 closes it, and opening it again reads the same draft', async () => {
    signIn('owner')
    progress = ran()
    drafting({ status: 'failed', problem: 'specific' }, { rewrite: true })
    let later = 0
    let m = await mount(<MemoryRouter><CardThenInvite onLater={() => later++} /></MemoryRouter>)
    try {
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
      expect(later).toBe(1)
    } finally { await m.unmount() }
    // opened again: the same draft read again (no new start)
    m = await mount(<MemoryRouter><CardThenInvite /></MemoryRouter>)
    try {
      await m.until(() => m.find('skill-share')?.getAttribute('data-state') === 'ready', 'the same card', 12000)
      expect(called('POST /api/onboarding/skill-draft')).toHaveLength(3)
      expect(called(`POST /api/onboarding/skill-draft/${DRAFT}/save`)).toEqual([])
    } finally { await m.unmount() }
  }, 30_000)

  test('a conversation the server refuses (files the team cannot open): its reason, and no 다시 정리하기', async () => {
    signIn('owner')
    progress = ran()
    routes['POST /api/onboarding/skill-draft'] = () => json(409, { error: { code: 'conflict', message: '팀원이 모두 볼 수는 없는 파일을 쓴 답이라 팀 스킬로 만들 수 없어요: 급여.xlsx', params: { reason: 'private' } } })
    const m = await mount(<MemoryRouter><CardThenInvite /></MemoryRouter>)
    try {
      await m.until(() => m.find('skill-share')?.getAttribute('data-state') === 'failed', 'refused')
      expect(m.get('skill-share-failed').textContent).toBe('팀원이 모두 볼 수는 없는 파일을 쓴 답이라 팀 스킬로 만들 수 없어요: 급여.xlsx')
      expect(m.find('skill-share-retry')).toBeNull()
    } finally { await m.unmount() }
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

describe('a landing on Home (the steps take an unfinished owner back only from a real landing)', () => {
  test('the first entry of a tab on Home is a landing; one carrying a question or a project is not', () => {
    expect(isLanding({ key: 'default', state: null, search: '' })).toBe(true)
    expect(isLanding({ key: 'default', state: null })).toBe(true)
    expect(isLanding({ key: 'default', state: null, search: '?prompt=%EC%95%88%EB%85%95' })).toBe(false)
    expect(isLanding({ key: 'default', state: null, search: '?project=abc' })).toBe(false)
  })
  test('a sign-in lands; an ordinary move inside the app does not', () => {
    expect(isLanding({ key: 'k1', state: { landing: true }, search: '' })).toBe(true)
    expect(isLanding({ key: 'k2', state: null, search: '' })).toBe(false)
  })
})
