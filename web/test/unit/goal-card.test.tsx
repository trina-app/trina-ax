// The 7-day team goal on Home (src/components/onboarding/GoalCard.tsx, src/lib/teamGoal.ts; docs/DECISIONS.md "G" and
// "Y — Home shows one thing at a time"): the title "7일 안에 3명이 같은 스킬 써 보기 · 1/3 · 5일 남음", ONE line of what to
// do next and ONE button (someone joined and has not run it: [다시 보내기]; one more person or nobody joined: [초대 문구
// 복사], or [팀원 초대] while no link works), "달성했어요 · names"; the top of Home showing one thing (the welcome
// steps' row while unfinished, else the card); the owners' notice text.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import type { Me, TeamGoal, TeamLinkResponse, WelcomeProgress } from '@mycel/shared/api'
import { translate, useLocaleStore, type MessageKey, type Params } from '../../src/i18n'
import { GoalCard } from '../../src/components/onboarding/GoalCard'
import { HomeTop } from '../../src/pages/Home'
import { firstRunText, goalNext, goalNextText, goalProgressText, objectParticle, quotedSkill, resendText, runnerNames, skillRunUrl, skillTopic, topicParticle } from '../../src/lib/teamGoal'
import { useSession } from '../../src/store/session'
import { useWelcome } from '../../src/store/welcome'
import { stepTotal } from '../../src/lib/welcome'
import { installDom, mount, removeDom } from './dom-host'

const ko = (k: MessageKey, p?: Params) => translate('ko', k, p)
const en = (k: MessageKey, p?: Params) => translate('en', k, p)
const me = (role: 'owner' | 'admin' = 'owner'): Me => ({
  user: { id: 'olga', username: 'olga', name: '김하나', email: null, role, locale: 'ko', localeChoice: null, mustChangePassword: false, prefs: {} },
  groups: [], team: { name: 'Acme', defaultLocale: 'ko' }, session: { id: '01900000-0000-7000-8000-00000000000a', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' },
  server: { version: '0', dev: false, deployment: 'hosted' },
} as unknown as Me)
const AD = 'skills/marketing/ad-copy/SKILL.md'
const goal = (o: Partial<TeamGoal> = {}): TeamGoal => ({
  state: 'open', target: 3, days: 7, startedAt: '2026-11-01T00:00:00.000Z', endsAt: '2026-11-08T00:00:00.000Z', daysLeft: 5,
  skill: { path: AD, name: '광고 문구', runners: 1, people: ['김하나'] }, reachedAt: null, joined: 0, waiting: null, ...o,
})
const LINK: TeamLinkResponse = {
  link: { id: '01900000-0000-7000-8000-000000000001', url: 'https://acme.example/join#t=abcdefghijklmnopqrstuvwxyz', groupIds: [], skill: { path: AD, name: 'ad-copy', title: '광고 문구' }, maxUses: 10, uses: 1, createdBy: null, createdAt: '2026-11-01T00:00:00.000Z', expiresAt: '2026-11-15T00:00:00.000Z', state: 'active' },
  seats: { used: 2, limit: null },
}
const NO_LINK: TeamLinkResponse = { link: null, seats: { used: 1, limit: null } }
const RUN = `https://acme.example/skills?run=${encodeURIComponent(AD)}`

describe('text helpers', () => {
  test('the Korean particles follow the last sound; quoted per language', () => {
    expect(['광고 문구', '보고서', '주간 리포트', '경쟁사 분석', '캠페인', 'v2', 'v3', 'ad-copy'].map(objectParticle)).toEqual(['를', '를', '를', '을', '을', '를', '을', '을(를)'])
    expect(['광고 문구', '경쟁사 분석', '팀 스킬', 'v2', 'v3', 'ad-copy'].map(topicParticle)).toEqual(['는', '은', '은', '는', '은', '은(는)'])
    expect(quotedSkill('ko', '광고 문구')).toBe("'광고 문구'를")
    expect(quotedSkill('ja', '広告コピー')).toBe('「広告コピー」')
    expect(quotedSkill('en', 'Ad copy')).toBe("'Ad copy'")
    expect(skillTopic('ko', '광고 문구', '팀 스킬')).toBe("'광고 문구'는")
    expect(skillTopic('ko', null, '팀 스킬')).toBe('팀 스킬은')
    expect(skillTopic('ja', '広告コピー', 'x')).toBe('「広告コピー」')
    expect(skillTopic('en', null, 'a team skill')).toBe('a team skill')
  })
  test('progress up to the target, then a count; three names with "·", then +N (deleted people counted, never named)', () => {
    expect(goalProgressText(ko, 2, 3)).toBe('2/3')
    expect(goalProgressText(ko, 4, 3)).toBe('4명')
    expect(goalProgressText(en, 5, 3)).toBe('5 people')
    expect(runnerNames(['민지', '지훈', 'Olga'], 3)).toBe('민지·지훈·Olga')
    expect(runnerNames(['a', 'b', 'c', 'd'], 5)).toBe('a·b·c +2')
    expect(runnerNames([], 1)).toBe('+1')
  })
  test('the one line: someone waiting first, then one more, then nobody joined, then how many more', () => {
    expect(goalNext(goal({ joined: 2, waiting: { first: '민지', more: 0 }, skill: { path: AD, name: '광고 문구', runners: 2, people: [] } }))).toEqual({ kind: 'waiting', first: '민지', more: 0 })
    expect(goalNext(goal({ joined: 1, skill: { path: AD, name: '광고 문구', runners: 2, people: [] } }))).toEqual({ kind: 'oneMore' })
    expect(goalNext(goal({ joined: 0 }))).toEqual({ kind: 'nobody' })
    expect(goalNext(goal({ joined: 0, skill: null }))).toEqual({ kind: 'nobody' })
    // the person who joined ran it, the owner did not: two more
    expect(goalNext(goal({ joined: 1 }))).toEqual({ kind: 'more', n: 2 })
    expect(goalNextText(ko, 'ko', { kind: 'waiting', first: '민지', more: 0 }, '광고 문구')).toBe("민지님이 들어왔지만 '광고 문구'는 아직이에요.")
    expect(goalNextText(ko, 'ko', { kind: 'waiting', first: '민지', more: 2 }, '경쟁사 분석')).toBe("민지님 외 2명이 들어왔지만 '경쟁사 분석'은 아직이에요.")
    expect(goalNextText(ko, 'ko', { kind: 'waiting', first: '민지', more: 0 }, null)).toBe('민지님이 들어왔지만 팀 스킬은 아직이에요.')
    expect(goalNextText(ko, 'ko', { kind: 'oneMore' }, null)).toBe('한 명만 더 쓰면 달성이에요.')
    expect(goalNextText(ko, 'ko', { kind: 'nobody' }, null)).toBe('아직 아무도 안 들어왔어요.')
    expect(goalNextText(ko, 'ko', { kind: 'more', n: 2 }, null)).toBe('2명 더 쓰면 달성이에요.')
    expect(goalNextText(en, 'en', { kind: 'waiting', first: 'Minji', more: 2 }, 'Ad copy')).toBe("Minji and 2 others joined but haven't tried 'Ad copy' yet.")
    expect(goalNextText(en, 'en', { kind: 'waiting', first: 'Minji', more: 0 }, null)).toBe("Minji joined but hasn't tried a team skill yet.")
  })
  test('[다시 보내기]: the nudge with the skill form\'s link on the team\'s address; to several people without a name', () => {
    expect(skillRunUrl('https://acme.example/', AD)).toBe(RUN)
    expect(skillRunUrl('https://acme.example', null)).toBe('https://acme.example/skills')
    expect(resendText(ko, 'ko', { first: '민지', more: 0, skill: '광고 문구', url: RUN })).toBe(`민지님, '광고 문구' 한 번 눌러 보세요: ${RUN}`)
    expect(resendText(ko, 'ko', { first: '민지', more: 2, skill: '광고 문구', url: RUN })).toBe(`'광고 문구' 한 번 눌러 보세요: ${RUN}`)
    expect(resendText(ko, 'ko', { first: '민지', more: 0, skill: null, url: 'https://acme.example/skills' })).toBe('민지님, 팀 스킬 한 번 눌러 보세요: https://acme.example/skills')
    expect(resendText(en, 'en', { first: 'Minji', more: 0, skill: 'Ad copy', url: RUN })).toBe(`Minji, give 'Ad copy' a try: ${RUN}`)
  })
  test('the owners\' notice: "○○님이 \'광고 문구\'를 처음 써 봤어요 (2/3)", and without a name once the account is gone', () => {
    const firstRun = { member: '김민지', skill: '광고 문구', runners: 2, target: 3 }
    expect(firstRunText(ko, 'ko', { firstRun })).toBe("김민지님이 '광고 문구'를 처음 써 봤어요 (2/3)")
    expect(firstRunText(en, 'en', { firstRun: { ...firstRun, skill: 'Ad copy' } })).toBe("김민지 tried 'Ad copy' for the first time (2/3)")
    expect(firstRunText(ko, 'ko', { firstRun: { ...firstRun, member: null, runners: 4 } })).toBe("팀원 한 명이 '광고 문구'를 처음 써 봤어요 (4명)")
    expect(firstRunText(ko, 'ko', {})).toBe(ko('goal.firstRunPlain'))
  })
})

describe('the card: a title, one line, one button', () => {
  const before = useLocaleStore.getState().locale
  const status = useSession.getState().status
  const clip = Object.getOwnPropertyDescriptor(globalThis.navigator, 'clipboard')
  let copied: string[] = []
  beforeAll(() => {
    installDom()
    useLocaleStore.setState({ locale: 'ko' })
    useSession.setState({ status: { kind: 'signed-in', me: me() } } as never)
    Object.defineProperty(globalThis.navigator, 'clipboard', { configurable: true, value: { writeText: async (s: string) => void copied.push(s) } })
  })
  afterAll(async () => {
    // "복사했어요" turns back after 1.5 s (ui.tsx useCopy): let those timers run while the page still exists
    await new Promise((r) => setTimeout(r, 1600))
    removeDom()
    useLocaleStore.setState({ locale: before })
    useSession.setState({ status })
    if (clip) Object.defineProperty(globalThis.navigator, 'clipboard', clip)
    else delete (globalThis.navigator as { clipboard?: unknown }).clipboard
  })
  beforeEach(() => { copied = [] })
  const card = (g: TeamGoal, link: TeamLinkResponse | null) => mount(<GoalCard goal={g} onDismiss={() => {}} link={link} />)
  const buttons = (html: string) => html.match(/<button/g)?.length ?? 0

  test('someone joined and has not run it: their name and [다시 보내기], which copies the nudge with the form\'s link', async () => {
    const m = await card(goal({ joined: 1, waiting: { first: '민지', more: 0 } }), LINK)
    try {
      const h = m.html()
      expect(h).toContain('7일 안에 3명이 같은 스킬 써 보기')
      expect(h).toContain(' · 1/3 · 5일 남음')
      expect(m.get('team-goal-next').textContent).toBe("민지님이 들어왔지만 '광고 문구'는 아직이에요.")
      expect(buttons(h)).toBe(1)
      // no progress bar, no list of who ran it
      expect(h).not.toContain('rounded-full bg-accent')
      expect(h).not.toContain('김하나')
      await m.click('team-goal-resend')
      expect(copied).toEqual([`민지님, '광고 문구' 한 번 눌러 보세요: ${RUN}`])
      // from 768px a card (phones: one line, below)
      expect(h).toContain('rounded-2xl border border-line')
    } finally { await m.unmount() }
  })
  test('several waiting: the first named and "외 n명"; nobody ran a skill yet: the team link\'s skill', async () => {
    const m = await card(goal({ skill: null, joined: 3, waiting: { first: '민지', more: 2 } }), LINK)
    try {
      expect(m.get('team-goal-next').textContent).toBe("민지님 외 2명이 들어왔지만 '광고 문구'는 아직이에요.")
      expect(m.html()).toContain(' · 0/3 · 5일 남음')
      await m.click('team-goal-resend')
      expect(copied).toEqual([`'광고 문구' 한 번 눌러 보세요: ${RUN}`])
    } finally { await m.unmount() }
  })
  test('one more person: the line and [초대 문구 복사] (the team link\'s message)', async () => {
    const m = await card(goal({ joined: 1, skill: { path: AD, name: '광고 문구', runners: 2, people: ['김하나', '민지'] } }), LINK)
    try {
      expect(m.get('team-goal-next').textContent).toBe('한 명만 더 쓰면 달성이에요.')
      expect(buttons(m.html())).toBe(1)
      await m.click('team-goal-copy-invite')
      expect(copied[0]).toContain(LINK.link!.url!)
      expect(copied[0]).toContain("'광고 문구'")
    } finally { await m.unmount() }
  })
  test('nobody joined: the line and [초대 문구 복사]; without a working link [팀원 초대] opens the invite step', async () => {
    let m = await card(goal({ joined: 0 }), LINK)
    try {
      expect(m.get('team-goal-next').textContent).toBe('아직 아무도 안 들어왔어요.')
      expect(m.find('team-goal-copy-invite')).not.toBeNull()
      expect(buttons(m.html())).toBe(1)
    } finally { await m.unmount() }
    m = await card(goal({ joined: 0 }), { ...LINK, link: { ...LINK.link!, state: 'expired' } })
    try {
      expect(m.find('team-goal-copy-invite')).toBeNull()
      expect(m.find('invite-step')).toBeNull()
      await m.click('team-goal-invite')
      await m.until(() => m.find('invite-step'), 'the invite step')
    } finally { await m.unmount() }
    // without a link, a nudge links to the form on this page's address (no skill named by the link either)
    m = await card(goal({ skill: null, joined: 1, waiting: { first: '민지', more: 0 } }), NO_LINK)
    try {
      expect(m.get('team-goal-next').textContent).toBe('민지님이 들어왔지만 팀 스킬은 아직이에요.')
      await m.click('team-goal-resend')
      expect(copied[0]).toMatch(/^민지님, 팀 스킬 한 번 눌러 보세요: .*\/skills$/)
    } finally { await m.unmount() }
  })
  test('reached: "달성했어요 · names" and only a way to hide it', async () => {
    let hidden = 0
    const m = await mount(<GoalCard goal={goal({ state: 'reached', reachedAt: '2026-11-04T00:00:00.000Z', skill: { path: AD, name: '광고 문구', runners: 3, people: ['민지', '지훈', 'Olga'] } })} onDismiss={() => hidden++} link={null} />)
    try {
      expect(m.get('team-goal').textContent).toBe('달성했어요 · 민지·지훈·Olga')
      expect(m.html()).not.toContain('일 남음')
      expect(buttons(m.html())).toBe(1)
      await m.click('team-goal-dismiss')
      expect(hidden).toBe(1)
    } finally { await m.unmount() }
  })
  test('phones: one row with the progress under the title, a tap shows the next step; no [다시 보내기] there; reached on one row', async () => {
    const media = globalThis.matchMedia
    globalThis.matchMedia = ((q: string) => ({ matches: q === '(max-width: 767.98px)', addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })) as unknown as typeof matchMedia
    try {
      let m = await card(goal({ joined: 1, waiting: { first: '민지', more: 0 } }), LINK)
      try {
        const toggle = m.get('team-goal-toggle')
        // the title, and the counts as its second line
        expect(toggle.textContent).toBe('7일 안에 3명이 같은 스킬 써 보기1/3 · 5일 남음')
        expect(m.get('team-goal-progress').textContent).toBe('1/3 · 5일 남음')
        expect(toggle.getAttribute('aria-expanded')).toBe('false')
        // no frame, no rule under it
        expect(m.get('team-goal').className).not.toContain('border')
        expect(m.get('team-goal-next').closest('[hidden]')).not.toBeNull()
        await m.click('team-goal-toggle')
        expect(m.get('team-goal-toggle').getAttribute('aria-expanded')).toBe('true')
        expect(m.get('team-goal-next').closest('[hidden]')).toBeNull()
        expect(m.get('team-goal-next').textContent).toBe("민지님이 들어왔지만 '광고 문구'는 아직이에요.")
        expect(m.find('team-goal-resend')).toBeNull()
      } finally { await m.unmount() }
      // one more person: the line opens to [초대 문구 복사]
      m = await card(goal({ joined: 1, skill: { path: AD, name: '광고 문구', runners: 2, people: ['김하나', '민지'] } }), LINK)
      try {
        await m.click('team-goal-toggle')
        expect(m.find('team-goal-copy-invite')).not.toBeNull()
      } finally { await m.unmount() }
      m = await mount(<GoalCard goal={goal({ state: 'reached', reachedAt: '2026-11-04T00:00:00.000Z', skill: { path: AD, name: '광고 문구', runners: 3, people: ['민지', '지훈', 'Olga'] } })} onDismiss={() => {}} link={null} />)
      try {
        expect(m.get('team-goal').textContent).toBe('달성했어요 · 민지·지훈·Olga')
        expect(m.get('team-goal').className).not.toContain('border')
      } finally { await m.unmount() }
    } finally { globalThis.matchMedia = media }
  })
  test('English (the static renderer reads English)', () => {
    const h = renderToStaticMarkup(<GoalCard goal={goal({ daysLeft: 1, joined: 1, waiting: { first: 'Minji', more: 0 } })} onDismiss={() => {}} link={LINK} />)
    expect(h).toContain('Get 3 people using the same skill in 7 days')
    expect(h).toContain(' · 1/3 · 1 day left')
    expect(h).toContain("Minji joined but hasn&#x27;t tried &#x27;광고 문구&#x27; yet.")
    expect(h).toContain('Send again')
  })
})

describe('the top of Home: one thing', () => {
  const realFetch = globalThis.fetch
  const status = useSession.getState().status
  let welcome: WelcomeProgress | null = null
  let teamGoal: TeamGoal | null = null
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  const fresh = (steps: Partial<WelcomeProgress['steps']> = {}, o: Partial<WelcomeProgress> = {}): WelcomeProgress => ({
    startedAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', teamType: 'marketing',
    steps: { profile: 'done', result: null, invite: null, ...steps }, pack: null, resultChatId: null, inviteShownAt: null, site: null, dismissedAt: null, finishedAt: null, ...o,
  })
  const locale = useLocaleStore.getState().locale
  beforeAll(() => {
    installDom()
    useLocaleStore.setState({ locale: 'ko' })
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const u = String(input)
      if (u.includes('/api/onboarding/welcome')) return json({ progress: welcome })
      if (u.includes('/api/onboarding/goal')) return json({ goal: teamGoal })
      if (u.includes('/api/admin/team-link')) return json(LINK)
      return new Response('{}', { status: 404 })
    }) as unknown as typeof fetch
  })
  afterAll(() => {
    globalThis.fetch = realFetch
    removeDom()
    useLocaleStore.setState({ locale })
    useSession.setState({ status })
    useWelcome.getState().reset()
  })
  const top = async (role: 'owner' | 'admin') => {
    useSession.setState({ status: { kind: 'signed-in', me: me(role) } } as never)
    useWelcome.getState().reset()
    const m = await mount(<MemoryRouter><HomeTop owner={role === 'owner'} /></MemoryRouter>)
    try {
      await m.settle(60)
      return { resume: m.find('welcome-resume')?.textContent ?? null, goal: m.find('team-goal')?.getAttribute('data-state') ?? null, dots: m.html().includes('h-1.5 w-4') }
    } finally { await m.unmount() }
  }

  test('setup unfinished: on a phone only the quiet "설정 이어서 하기 · n/4" row, no goal card; on a computer the goal card (the sidebar\'s setup row stands for the steps, docs/DECISIONS.md "W5")', async () => {
    welcome = fresh(); teamGoal = goal()
    const media = globalThis.matchMedia
    globalThis.matchMedia = ((q: string) => ({ matches: q === '(max-width: 767.98px)', addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })) as unknown as typeof matchMedia
    try {
      const t = await top('owner')
      // the count and the total are lib/welcome.ts's (the steps decide how many there are): 회사 소개 saved without a deck
      // is not answered yet (an old row), so 0 of them
      expect(t.resume).toBe(`${translate('ko', 'setupRow.resume')} · 0/${stepTotal()}`)
      expect({ ...t, resume: null }).toEqual({ resume: null, goal: null, dots: false })
    } finally { globalThis.matchMedia = media }
    expect(await top('owner')).toEqual({ resume: null, goal: 'open', dots: false })
  })
  test('setup finished or hidden: only the goal card; an admin gets the card at once', async () => {
    teamGoal = goal()
    welcome = fresh({ profile: 'done', result: 'done', invite: 'done' }, { finishedAt: '2026-11-02T00:00:00.000Z' })
    expect(await top('owner')).toEqual({ resume: null, goal: 'open', dots: false })
    welcome = fresh({}, { dismissedAt: '2026-11-02T00:00:00.000Z' })
    expect(await top('owner')).toEqual({ resume: null, goal: 'open', dots: false })
    // a team from before the steps (never started)
    welcome = null
    expect(await top('owner')).toEqual({ resume: null, goal: 'open', dots: false })
    welcome = fresh()
    expect(await top('admin')).toEqual({ resume: null, goal: 'open', dots: false })
  })
  test('no goal (an older team, or its time is over): nothing at the top', async () => {
    welcome = null; teamGoal = null
    expect(await top('owner')).toEqual({ resume: null, goal: null, dots: false })
  })
})
