// Onboarding wave 2, the welcome steps (docs/DECISIONS.md "W — Welcome steps"), rendered and clicked against a small
// fake of the server's rules (tests/unit/b-onboarding-welcome.test.ts checks the server itself):
// - /welcome is the owner's: members and admins are sent Home; right after /setup the owner lands there;
// - choosing 마케팅 installs the pack once; resuming (another device) opens the next step and never installs again;
// - the first result: the ad copy form, which opens its chat; without a usable AI, A's connect button instead;
// - the chat of the first result offers the invite with that skill; Home offers to continue until finished or hidden;
// - the company profile step (D) shows A's connect button instead of starting a draft that cannot run.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { WELCOME_RESULT_SKILL, type SkillInfo, type WelcomeProgress, type WelcomeUpdate } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import Welcome from '../../src/pages/Welcome'
import { Setup } from '../../src/pages/Auth'
import { AfterSetup } from '../../src/App'
import { WelcomeInviteBar } from '../../src/components/onboarding/WelcomeInviteBar'
import { WelcomeResume } from '../../src/components/onboarding/WelcomeResume'
import ProfileStep from '../../src/components/onboarding/ProfileStep'
import { doneCount, nextStep, resumeStep, showInviteBar, showResume } from '../../src/lib/welcome'
import { rememberSetupSite, setupSite } from '../../src/lib/setupLink'
import { useAiAccess } from '../../src/store/aiAccess'
import { useSession } from '../../src/store/session'
import { useWelcome } from '../../src/store/welcome'
import { installDom, mount, removeDom, type Mounted } from './dom-host'

const CHAT = '01900000-0000-7000-8000-0000000000c1'
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const meOf = (role: 'owner' | 'admin' | 'member') => ({
  user: { id: 'olga', username: 'olga', name: '올가', email: null, role, locale: 'ko', localeChoice: null, mustChangePassword: false, prefs: {} },
  groups: [], team: { name: 'Acme', defaultLocale: 'ko' },
  session: { id: '01900000-0000-7000-8000-00000000000a', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' }, server: { version: '0', dev: true },
})
const adCopy: SkillInfo = { path: WELCOME_RESULT_SKILL, name: 'ad-copy', description: '광고 문구 — 3안', inputs: [{ name: 'product', label: '알릴 제품·서비스', required: true, prefill: 'company.products' }] }
const fresh = (): WelcomeProgress => ({
  startedAt: '2026-11-04T00:00:00.000Z', updatedAt: '2026-11-04T00:00:00.000Z', teamType: null,
  steps: { team: null, profile: null, result: null, invite: null }, pack: null, resultChatId: null, inviteShownAt: null, site: null, dismissedAt: null, finishedAt: null,
})
const PACK = { id: 'marketing' as const, at: '2026-11-04T00:00:00.000Z', skillPath: WELCOME_RESULT_SKILL }

// ---- a fake of the server: the progress row (the server's rules in short) and the few other answers the steps need
let progress: WelcomeProgress | null = null
let ai = { usable: true, action: 'connect_team', requested: false }
let calls: { key: string; body: unknown }[] = []
let packStatus: 'created' | 'blocked' = 'created'
function apply(u: WelcomeUpdate): WelcomeProgress {
  const p = progress ?? fresh()
  if (u.teamType) p.teamType = u.teamType
  if (u.resultChatId) p.resultChatId = u.resultChatId
  if (u.step && (u.step.state === 'done' || p.steps[u.step.id] !== 'done')) p.steps[u.step.id] = u.step.state
  if (u.step?.id === 'result' && u.step.state === 'done' && p.steps.invite === 'skipped') p.steps.invite = null
  if (u.inviteShown) p.inviteShownAt ??= '2026-11-04T00:01:00.000Z'
  if (u.site) p.site = u.site
  if (u.dismissed !== undefined) p.dismissedAt = u.dismissed ? '2026-11-04T00:02:00.000Z' : null
  if (!p.finishedAt && p.steps.team === 'done' && p.steps.profile === 'done' && p.steps.result === 'done' && p.steps.invite) p.finishedAt = '2026-11-04T00:03:00.000Z'
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
  'GET /api/me/ai-access': () => json(200, ai),
  'GET /api/onboarding/profile': () => json(200, { profile: null }),
  'GET /api/skills': () => json(200, { items: [adCopy] }),
  'POST /api/chats': () => json(201, { id: CHAT, projectId: null, title: '', engine: 'claude-code', model: null, createdAt: '2026-11-04T00:00:00.000Z', updatedAt: '2026-11-04T00:00:00.000Z', deletedAt: null, runState: 'idle' }),
  'GET /api/admin/groups': () => json(200, { items: [] }),
  'GET /api/admin/team-link': () => json(200, { link: null, seats: { used: 1, limit: null } }),
  'POST /api/admin/team-link': (b) => json(201, {
    link: { id: '01900000-0000-7000-8000-000000000001', url: 'https://acme.example/join#t=x', groupIds: [], skill: b.skillPath ? { path: b.skillPath, name: 'ad-copy' } : null, maxUses: 20, uses: 0, createdBy: { id: 'olga', name: '올가' }, createdAt: '2026-11-04T00:00:00.000Z', expiresAt: '2026-11-18T00:00:00.000Z', state: 'active' },
    seats: { used: 1, limit: null },
  }),
}
const called = (key: string) => calls.filter((c) => c.key === key)

const realFetch = globalThis.fetch
const localeBefore = useLocaleStore.getState().locale
const sessionBefore = { status: useSession.getState().status, signedIn: useSession.getState().signedIn }
const g = globalThis as Record<string, unknown>
const was = { location: Object.getOwnPropertyDescriptor(g, 'location'), history: Object.getOwnPropertyDescriptor(g, 'history') }
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'ko' })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input).split('?')[0]}`
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({ key, body })
    return routes[key]?.(body) ?? json(404, { error: { code: 'not_found', message: `no route ${key}` } })
  }) as unknown as typeof fetch
  Object.defineProperty(g, 'history', { configurable: true, writable: true, value: { state: null, replaceState: () => {} } })
})
afterEach(() => {
  progress = null
  ai = { usable: true, action: 'connect_team', requested: false }
  calls = []
  packStatus = 'created'
  useWelcome.getState().reset()
  useAiAccess.getState().reset()
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
function Where() { const l = useLocation(); return <p data-testid="where">{l.pathname + l.search}</p> }
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

describe('where the steps go', () => {
  test('resume: the first open step, then a put-off one; after a step, only open steps ahead of it', () => {
    expect(resumeStep(null)).toBe('team')
    const p = fresh()
    p.steps = { team: 'done', profile: 'skipped', result: null, invite: null }
    expect(resumeStep(p)).toBe('result')
    expect(nextStep(p, 'team')).toBe('result')
    p.steps = { team: 'done', profile: 'skipped', result: 'done', invite: 'skipped' }
    // everything has an answer: "later" is now, the put-off profile comes back from Home
    expect(resumeStep(p)).toBe('profile')
    // but never straight after putting off the invite (Home instead)
    expect(nextStep(p, 'invite')).toBeNull()
    expect(doneCount(p)).toBe(2)
    expect(showResume(p)).toBe(true)
    expect(showResume({ ...p, dismissedAt: 'x' })).toBe(false)
    expect(showResume({ ...p, finishedAt: 'x' })).toBe(false)
    expect(resumeStep({ ...p, finishedAt: 'x' })).toBeNull()
    expect(showInviteBar({ ...p, resultChatId: CHAT, steps: { ...p.steps, invite: null } }, CHAT)).toBe(true)
    expect(showInviteBar({ ...p, resultChatId: CHAT }, CHAT)).toBe(false)
    expect(showInviteBar({ ...p, resultChatId: CHAT, steps: { ...p.steps, invite: null } }, 'other')).toBe(false)
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

  test('마케팅 installs the pack once; resuming on another device opens the next step and never installs again', async () => {
    signIn('owner')
    rememberSetupSite('https://acme.example/')
    let m = await app()
    try {
      await m.until(() => m.find('welcome-team'), 'step 1')
      // the first visit started the progress on the server, with the setup link's website (for any device)
      expect(called('PATCH /api/onboarding/welcome')[0]!.body).toEqual({ site: 'https://acme.example/' })
      expect(m.get('welcome-progress').textContent).toContain('1/3 팀 유형')
      expect(m.html()).toContain(translate('ko', 'welcome.team.title'))
      // 영업 has no pack: it says so (honestly) before going on
      await m.click('welcome-team-sales')
      expect(m.get('welcome-team-no-pack').textContent).toBe(translate('ko', 'welcome.team.noPack'))
      await m.click('welcome-team-marketing')
      expect(m.get('welcome-team-marketing').getAttribute('aria-pressed')).toBe('true')
      await m.click('welcome-next')
      await m.until(() => stepOf(m) === 'profile', 'step 2')
      expect(called('POST /api/onboarding/welcome/pack')).toHaveLength(1)
      expect(progress!.teamType).toBe('marketing')
      expect(progress!.steps.team).toBe('done')
      await m.until(() => m.find('profile-step-site'), 'the profile step (D)')
    } finally { await m.unmount() }
    sessionStorage.clear()

    // another device: the progress comes from the server, the steps open on the profile
    useWelcome.getState().reset()
    calls = []
    m = await app()
    try {
      await m.until(() => stepOf(m) === 'profile', 'resumed on step 2')
      // the website came from the server's copy, not this tab
      await m.until(() => m.find('profile-step-site'), 'the profile step')
      expect((m.get('profile-step-site').querySelector('input[inputmode="url"]') as unknown as { value: string }).value).toBe('https://acme.example/')
      expect(m.find('welcome-progress')!.querySelector('[aria-current="step"]')!.textContent).toContain('2/3 회사 소개')
      // back to step 1 and the same choice again: no second install
      await m.click('welcome-back')
      await m.until(() => m.find('welcome-team'), 'step 1 again')
      expect(m.get('welcome-team-marketing').getAttribute('aria-pressed')).toBe('true')
      expect(m.html()).toContain(translate('ko', 'welcome.team.packThere'))
      await m.click('welcome-next')
      await m.until(() => stepOf(m) === 'profile', 'step 2 again')
      expect(called('POST /api/onboarding/welcome/pack')).toEqual([])
      // "나중에 하기" on the profile: put off, on to the first result
      await m.until(() => m.html().includes(translate('ko', 'welcome.later')), 'the later button')
      const later = (globalThis.document as any).body.querySelectorAll('button').find((b: any) => b.textContent === translate('ko', 'welcome.later'))
      await m.click(later)
      await m.until(() => stepOf(m) === 'result', 'step 3')
      expect(progress!.steps.profile).toBe('skipped')
    } finally { await m.unmount() }
  })

  test('the first result: the ad copy form, filled from the profile, opens its chat and records it', async () => {
    signIn('owner')
    progress = { ...fresh(), teamType: 'marketing', pack: PACK, steps: { team: 'done', profile: 'done', result: null, invite: null } }
    const m = await app()
    try {
      await m.until(() => m.find('skill-form'), 'the ad copy form')
      expect(m.html()).toContain(translate('ko', 'welcome.result.title'))
      expect(m.get('skill-form').getAttribute('data-path')).toBe(WELCOME_RESULT_SKILL)
      await m.until(() => !m.get('skill-form-run').hasAttribute('disabled'), 'Run on')
      await m.type('skill-input-product', '종이 플래너')
      await m.click('skill-form-run')
      await m.until(() => at(m) === `/c/${CHAT}`, 'the chat')
      expect(progress!.steps.result).toBe('done')
      expect(progress!.resultChatId).toBe(CHAT)
    } finally { await m.unmount() }
  })

  test('the first result with no usable AI (self-hosted, no trial key): A\'s connect button, no form', async () => {
    signIn('owner')
    ai = { usable: false, action: 'connect_team', requested: false }
    progress = { ...fresh(), teamType: 'marketing', pack: PACK, steps: { team: 'done', profile: 'done', result: null, invite: null } }
    const m = await app()
    try {
      await m.until(() => m.find('welcome-result-no-ai'), 'the no-AI step')
      expect(m.get('ai-access-button').getAttribute('data-action')).toBe('connect_team')
      expect(m.get('ai-access-button').textContent).toBe(translate('ko', 'aiAccess.connectTeam'))
      expect(m.find('skill-form')).toBeNull()
      await m.click('welcome-later')
      await m.until(() => stepOf(m) === 'invite', 'on to the invite')
      expect(progress!.steps.result).toBe('skipped')
      // no result yet: E's own words, but people who join still land on the ad copy
      expect(m.html()).toContain(translate('ko', 'teamLink.stepTitle'))
    } finally { await m.unmount() }
  })

  test('the pack blocked by folder rules: the steps say so and stay; nothing is recorded', async () => {
    signIn('owner')
    packStatus = 'blocked'
    const m = await app()
    try {
      await m.until(() => m.find('welcome-team'), 'step 1')
      await m.click('welcome-team-marketing')
      await m.click('welcome-next')
      await m.until(() => m.html().includes(translate('ko', 'welcome.packBlocked')), 'the message')
      expect(stepOf(m)).toBe('team')
      expect(progress!.pack).toBeNull()
      expect(progress!.steps.team).toBeNull()
    } finally { await m.unmount() }
  })

  test('a team without a pack: step 3 offers the marketing pack (installed once, on the click)', async () => {
    signIn('owner')
    progress = { ...fresh(), teamType: 'operations', steps: { team: 'done', profile: 'done', result: null, invite: null } }
    const m = await app()
    try {
      await m.until(() => m.find('welcome-result-no-pack'), 'the offer')
      expect(m.html()).toContain(translate('ko', 'welcome.result.noPackOther'))
      expect(called('POST /api/onboarding/welcome/pack')).toEqual([])
      await m.click('welcome-result-install')
      await m.until(() => m.find('skill-form'), 'the form after the install')
      expect(called('POST /api/onboarding/welcome/pack')).toHaveLength(1)
    } finally { await m.unmount() }
  })
})

describe('after the first result', () => {
  const ran = (): WelcomeProgress => ({ ...fresh(), teamType: 'marketing', pack: PACK, resultChatId: CHAT, steps: { team: 'done', profile: 'done', result: 'done', invite: null } })

  test('the chat of the first result offers the invite with the skill just used; done finishes the steps', async () => {
    signIn('owner')
    progress = ran()
    const m = await mount(<MemoryRouter><WelcomeInviteBar chatId={CHAT} answered /></MemoryRouter>)
    try {
      await m.until(() => m.find('welcome-invite-bar'), 'the bar')
      expect(m.get('welcome-invite-bar').textContent).toContain(translate('ko', 'welcome.bar.text'))
      await m.click('welcome-invite-open')
      await m.until(() => m.find('team-link-create'), 'the invite step')
      expect(m.get('invite-step').textContent).toContain("방금 쓴 '광고 문구' 스킬, 팀원도 써 보게 할까요?")
      expect(progress!.inviteShownAt).not.toBeNull()
      await m.click('team-link-create')
      await m.until(() => called('POST /api/admin/team-link').length, 'the link made')
      // people who join land on the ad copy form
      expect(called('POST /api/admin/team-link')[0]!.body).toMatchObject({ skillPath: WELCOME_RESULT_SKILL })
      await m.until(() => m.find('invite-step-done'), 'done button')
      await m.click('invite-step-done')
      await m.until(() => !m.find('welcome-invite-bar'), 'the bar gone')
      expect(progress!.steps.invite).toBe('done')
      expect(progress!.finishedAt).not.toBeNull()
    } finally { await m.unmount() }
  })

  test('the bar waits for the answer, shows only on that chat and only to the owner; closing it asks softly first', async () => {
    signIn('owner')
    progress = ran()
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

  test('Home: "시작 설정 이어하기 (n/3)" for the owner until finished or hidden', async () => {
    signIn('owner')
    progress = { ...fresh(), steps: { team: 'done', profile: 'skipped', result: null, invite: null } }
    let m = await mount(<MemoryRouter><WelcomeResume /></MemoryRouter>)
    try {
      await m.until(() => m.find('welcome-resume'), 'the entry')
      expect(m.get('welcome-resume-link').textContent).toContain('시작 설정 이어하기 (1/3)')
      expect(m.get('welcome-resume-link').getAttribute('href')).toBe('/welcome')
      await m.click('welcome-resume-hide')
      await m.until(() => !m.find('welcome-resume'), 'hidden')
      expect(progress!.dismissedAt).not.toBeNull()
    } finally { await m.unmount() }
    // the three counted steps done: only the invite is left, and the entry says so
    useWelcome.getState().reset()
    progress = ran()
    m = await mount(<MemoryRouter><WelcomeResume /></MemoryRouter>)
    try {
      await m.until(() => m.find('welcome-resume'), 'the entry')
      expect(m.get('welcome-resume-link').textContent).toContain(translate('ko', 'welcome.resume.inviteLeft'))
    } finally { await m.unmount() }
    // never started (a team from before the steps), or finished: nothing
    for (const p of [null, { ...ran(), steps: { team: 'done', profile: 'done', result: 'done', invite: 'done' }, finishedAt: 'x' } as WelcomeProgress]) {
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
