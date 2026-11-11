// The 7-day team goal on Home (src/components/onboarding/GoalCard.tsx, src/lib/teamGoal.ts; docs/DECISIONS.md "G",
// "Y — Home shows one thing at a time" and "W5"): the title naming the skill "7일 안에 3명이 '광고 문구' 써 보기 · 1/3 · 5일
// 남음", ONE line of what to do next and ONE button (someone joined and has not run it: [다시 보내기]; one more person or
// nobody joined, from the third day: [초대 문구 복사], or [팀원 초대] while no link works, which goes to the welcome
// steps' invite step while they are unfinished), "달성했어요 · names"; a team with no team skill yet: the line says skills
// come first and [스킬 넣기] (the catalog open) is the filled one, the card's own button beside it quiet; the top of Home
// showing one thing (the welcome steps' row while unfinished, else the card); the owners' notice text.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { act } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import type { Me, TeamGoal, TeamLinkResponse, WelcomeProgress } from '@mycel/shared/api'
import { translate, useLocaleStore, type MessageKey, type Params } from '../../src/i18n'
import { GoalCard, INVITE_STEP_STATE } from '../../src/components/onboarding/GoalCard'
import { HomeTop } from '../../src/pages/Home'
import { firstRunText, goalNext, goalNextText, goalProgressText, goalTitleSkills, goalTitleText, NOBODY_AFTER_DAYS, objectParticle, quotedSkill, resendText, runnerNames, skillRunUrl, skillTopic, topicParticle } from '../../src/lib/teamGoal'
import { useSession } from '../../src/store/session'
import { useUi } from '../../src/store/ui'
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
  test('the Korean particles follow the last sound (은/을 after a final consonant, 는/를 after a vowel); none when it cannot be told, never "은(는)"; quoted per language', () => {
    expect(['광고 문구', '보고서', '주간 리포트', '경쟁사 분석', '캠페인', 'v2', 'v3', 'ad-copy'].map(objectParticle)).toEqual(['를', '를', '를', '을', '을', '를', '을', ''])
    expect(['광고 문구', '경쟁사 분석', '팀 스킬', 'v2', 'v3', 'ad-copy', 'quote maker', '견적 만들기', '세금계산서 확인'].map(topicParticle)).toEqual(['는', '은', '은', '는', '은', '', '', '는', '은'])
    expect(skillTopic('ko', '견적 만들기', '팀 스킬')).toBe("'견적 만들기'는")
    expect(skillTopic('ko', '세금계산서 확인', '팀 스킬')).toBe("'세금계산서 확인'은")
    expect(skillTopic('ko', 'quote maker', '팀 스킬')).toBe("'quote maker'")
    expect(quotedSkill('ko', 'quote maker')).toBe("'quote maker'")
    expect(quotedSkill('ko', '광고 문구')).toBe("'광고 문구'를")
    expect(quotedSkill('ja', '広告コピー')).toBe('「広告コピー」')
    expect(quotedSkill('en', 'Ad copy')).toBe("'Ad copy'")
    expect(skillTopic('ko', '광고 문구', '팀 스킬')).toBe("'광고 문구'는")
    expect(skillTopic('ko', null, '팀 스킬')).toBe('팀 스킬은')
    expect(skillTopic('ja', '広告コピー', 'x')).toBe('「広告コピー」')
    expect(skillTopic('en', null, 'a team skill')).toBe('a team skill')
  })
  test('the title: up to three skill names, the first given first, each once, never a skipped path; joined per language', () => {
    const list = [{ path: 'a', name: '신청서' }, { path: 'deck', name: '회사 소개서' }, { path: 'b', name: '광고 문구' }, { path: 'c', name: '견적' }, { path: 'd', name: '카드뉴스' }]
    expect(goalTitleSkills('광고 문구', list, ['deck'])).toEqual(['광고 문구', '신청서', '견적'])
    expect(goalTitleSkills(null, [], [])).toEqual([])
    expect(goalTitleText(ko, 'ko', ['광고 문구', '견적'])).toBe("동료와 함께 만들어 보기: '광고 문구', '견적'")
    expect(goalTitleText(en, 'en', ['Ad copy', 'Quotes', 'Promo cards'])).toBe("Make documents together with your colleagues: 'Ad copy', 'Quotes', and 'Promo cards'")
    expect(goalTitleText(en, 'en', [])).toBe('Make documents together with your colleagues')
    expect(goalTitleText((k, p) => translate('ja', k, p), 'ja', ['広告', '見積'])).toBe('同僚と一緒に作ってみる: 「広告」「見積」')
  })
  test('progress up to the target, then a count; three names with "·", then +N (deleted people counted, never named)', () => {
    expect(goalProgressText(ko, 2, 3)).toBe('2/3')
    expect(goalProgressText(ko, 4, 3)).toBe('4명')
    expect(goalProgressText(en, 5, 3)).toBe('5 people')
    expect(runnerNames(['민지', '지훈', 'Olga'], 3)).toBe('민지·지훈·Olga')
    expect(runnerNames(['a', 'b', 'c', 'd'], 5)).toBe('a·b·c +2')
    expect(runnerNames([], 1)).toBe('+1')
  })
  test('the one line: someone waiting first, then one more, then nobody joined (from the third day), then how many more', () => {
    const DAY = 86_400_000, start = Date.parse('2026-11-01T00:00:00.000Z'), day4 = start + 4 * DAY
    expect(goalNext(goal({ joined: 2, waiting: { first: '민지', more: 0 }, skill: { path: AD, name: '광고 문구', runners: 2, people: [] } }), day4)).toEqual({ kind: 'waiting', first: '민지', more: 0 })
    expect(goalNext(goal({ joined: 1, skill: { path: AD, name: '광고 문구', runners: 2, people: [] } }), day4)).toEqual({ kind: 'oneMore' })
    expect(goalNext(goal({ joined: 0 }), day4)).toEqual({ kind: 'nobody' })
    expect(goalNext(goal({ joined: 0, skill: null }), day4)).toEqual({ kind: 'nobody' })
    // the person who joined ran it, the owner did not: two more
    expect(goalNext(goal({ joined: 1 }), day4)).toEqual({ kind: 'more', n: 2 })
    // nobody joined yet on day 0 to 2 (the owner has not invited anyone yet): how many more, not "아직 아무도"
    expect(NOBODY_AFTER_DAYS).toBe(3)
    expect(goalNext(goal({ joined: 0 }), start)).toEqual({ kind: 'more', n: 2 })
    expect(goalNext(goal({ joined: 0, skill: null }), start + 3 * DAY - 1)).toEqual({ kind: 'more', n: 3 })
    expect(goalNext(goal({ joined: 0, skill: null }), start + 3 * DAY)).toEqual({ kind: 'nobody' })
    // neutral: the skill is not tried yet; never "들어왔지만" (the goal's skill may have changed after they joined)
    expect(goalNextText(ko, 'ko', { kind: 'waiting', first: '민지', more: 0 }, '광고 문구')).toBe("민지님이 들어왔어요. '광고 문구'는 아직 써 보기 전이에요.")
    expect(goalNextText(ko, 'ko', { kind: 'waiting', first: '민지', more: 2 }, '경쟁사 분석')).toBe("민지님 외 2명이 들어왔어요. '경쟁사 분석'은 아직 써 보기 전이에요.")
    expect(goalNextText(ko, 'ko', { kind: 'waiting', first: '한지민', more: 0 }, 'quote maker')).toBe("한지민님이 들어왔어요. 'quote maker' 아직 써 보기 전이에요.")
    expect(goalNextText(ko, 'ko', { kind: 'waiting', first: '민지', more: 0 }, null)).toBe('민지님이 들어왔어요. 팀 스킬은 아직 써 보기 전이에요.')
    for (const l of ['ko', 'en', 'ja', 'es', 'id'] as const) {
      const line = goalNextText((k, p) => translate(l, k, p), l, { kind: 'waiting', first: 'Minji', more: 0 }, 'Ad copy')
      expect(line).toContain('Ad copy')
      expect(line).not.toMatch(/들어왔지만|but|しましたが|pero|tetapi/)
    }
    expect(goalNextText(ko, 'ko', { kind: 'oneMore' }, null)).toBe('한 명만 더 쓰면 달성이에요.')
    expect(goalNextText(ko, 'ko', { kind: 'nobody' }, null)).toBe('아직 아무도 안 들어왔어요.')
    expect(goalNextText(ko, 'ko', { kind: 'more', n: 2 }, null)).toBe('2명 더 쓰면 달성이에요.')
    expect(goalNextText(en, 'en', { kind: 'waiting', first: 'Minji', more: 2 }, 'Ad copy')).toBe("Minji and 2 others joined. Not tried yet: 'Ad copy'.")
    expect(goalNextText(en, 'en', { kind: 'waiting', first: 'Minji', more: 0 }, null)).toBe('Minji joined. Not tried yet: a team skill.')
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
  afterAll(() => {
    removeDom()
    useLocaleStore.setState({ locale: before })
    useSession.setState({ status })
    if (clip) Object.defineProperty(globalThis.navigator, 'clipboard', clip)
    else delete (globalThis.navigator as { clipboard?: unknown }).clipboard
  })
  beforeEach(() => { copied = [] })
  const card = (g: TeamGoal, link: TeamLinkResponse | null) => mount(<MemoryRouter><GoalCard goal={g} onDismiss={() => {}} link={link} /></MemoryRouter>)
  const buttons = (html: string) => html.match(/<button/g)?.length ?? 0

  test('someone joined and has not run it: their name and [다시 보내기], which copies the nudge with the form\'s link', async () => {
    const m = await card(goal({ joined: 1, waiting: { first: '민지', more: 0 } }), LINK)
    try {
      const h = m.html()
      // the title invites people to make documents with the team's skill
      expect(h).toContain("동료와 함께 만들어 보기: '광고 문구'")
      expect(h).toContain(' · 1/3 · 5일 남음')
      expect(m.get('team-goal-next').textContent).toBe("민지님이 들어왔어요. '광고 문구'는 아직 써 보기 전이에요.")
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
      expect(m.get('team-goal-next').textContent).toBe("민지님 외 2명이 들어왔어요. '광고 문구'는 아직 써 보기 전이에요.")
      expect(m.html()).toContain(' · 0/3 · 5일 남음')
      await m.click('team-goal-resend')
      expect(copied).toEqual([`'광고 문구' 한 번 눌러 보세요: ${RUN}`])
    } finally { await m.unmount() }
  })
  test('nobody ran a skill yet and the team link still opens the intro deck: the deck is never named (the owner\'s own run, docs/DECISIONS.md "DS3")', async () => {
    const deck = { ...LINK, link: { ...LINK.link!, skill: { path: 'skills/general/intro-deck/SKILL.md', name: 'intro-deck', title: '회사 소개서' } } }
    const m = await card(goal({ skill: null, joined: 3, waiting: { first: '민지', more: 2 } }), deck)
    try {
      expect(m.html()).not.toContain('회사 소개서')
      expect(m.html()).toContain('동료와 함께 문서 만들어 보기')
      await m.click('team-goal-resend')
      expect(copied[0]).not.toContain('회사 소개서')
      expect(copied[0]).not.toContain('intro-deck')
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
      expect(m.get('team-goal-next').textContent).toBe('민지님이 들어왔어요. 팀 스킬은 아직 써 보기 전이에요.')
      // no skill to name: the plain invitation
      expect(m.html()).toContain('>동료와 함께 문서 만들어 보기<')
      await m.click('team-goal-resend')
      expect(copied[0]).toMatch(/^민지님, 팀 스킬 한 번 눌러 보세요: .*\/skills$/)
    } finally { await m.unmount() }
  })
  test('no team skill yet: skills come first, [스킬 넣기] is the filled one and opens 팀 스킬 with the catalog open; [다시 보내기] or the invite stays, quiet; never "아직 써 보기 전"', async () => {
    function Where() { const l = useLocation(); return <p data-testid="where">{`${l.pathname}${l.search}`}</p> }
    const filledIds = (m: Awaited<ReturnType<typeof mount>>) => m.get('team-goal').querySelectorAll('button').filter((b) => /(^|\s)bg-accent(\s|$)/.test(b.className)).map((b) => b.getAttribute('data-testid'))
    const at = (g: TeamGoal, link: TeamLinkResponse | null) => mount(
      <MemoryRouter initialEntries={['/']}><Routes>
        <Route path="/" element={<GoalCard goal={g} onDismiss={() => {}} link={link} hasSkills={false} />} />
        <Route path="/skills" element={<Where />} />
      </Routes></MemoryRouter>,
    )
    let m = await at(goal({ skill: null, joined: 1, waiting: { first: '민지', more: 0 } }), NO_LINK)
    try {
      expect(m.get('team-goal-next').textContent).toBe('민지님이 들어왔어요. 팀 스킬을 넣으면 같이 써 볼 수 있어요.')
      expect(m.get('team-goal-next').getAttribute('data-next')).toBe('noSkills')
      expect(m.html()).not.toContain('써 보기 전')
      expect(filledIds(m)).toEqual(['team-goal-add-skills'])
      expect(m.get('team-goal-add-skills').textContent).toContain(ko('home.prepared.addSkills'))
      // [다시 보내기] is still there, not filled
      expect(m.find('team-goal-resend')).not.toBeNull()
      await m.click('team-goal-add-skills')
      await m.until(() => m.find('where'), '팀 스킬')
      expect(m.get('where').textContent).toBe('/skills?catalog=open')
    } finally { await m.unmount() }
    m = await at(goal({ skill: null, joined: 3, waiting: { first: '민지', more: 2 } }), LINK)
    try {
      expect(m.get('team-goal-next').textContent).toBe('민지님 외 2명이 들어왔어요. 팀 스킬을 넣으면 같이 써 볼 수 있어요.')
    } finally { await m.unmount() }
    // nobody joined: the same first step, the invite beside it, quiet
    m = await at(goal({ skill: null, joined: 0 }), LINK)
    try {
      expect(m.get('team-goal-next').textContent).toBe('아직 팀 스킬이 없어요. 스킬을 넣으면 팀원이 바로 써 볼 수 있어요.')
      expect(filledIds(m)).toEqual(['team-goal-add-skills'])
      expect(m.find('team-goal-copy-invite')).not.toBeNull()
    } finally { await m.unmount() }
    m = await at(goal({ skill: null, joined: 0 }), NO_LINK)
    try {
      expect(filledIds(m)).toEqual(['team-goal-add-skills'])
      expect(m.find('team-goal-invite')).not.toBeNull()
    } finally { await m.unmount() }
    // with skills (as before): no [스킬 넣기]
    m = await mount(<MemoryRouter><GoalCard goal={goal({ skill: null, joined: 1, waiting: { first: '민지', more: 0 } })} onDismiss={() => {}} link={NO_LINK} hasSkills /></MemoryRouter>)
    try {
      expect(m.find('team-goal-add-skills')).toBeNull()
      expect(filledIds(m)).toEqual(['team-goal-resend'])
    } finally { await m.unmount() }
  })
  test('no team skill, read by the card itself (GET /api/skills/examples): [스킬 넣기]; a failed read keeps the card as it was', async () => {
    const realFetch = globalThis.fetch
    let skills: unknown[] | null = []
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://x')
      if (url.pathname === '/api/skills/examples' && skills) return new Response(JSON.stringify({ skills, teamFolder: null, landing: null, ranTeamSkill: false, hasProfile: false }), { status: 200, headers: { 'content-type': 'application/json' } })
      return new Response(JSON.stringify({ error: { code: 'internal', message: 'down' } }), { status: 500, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    try {
      let m = await card(goal({ skill: null, joined: 1, waiting: { first: '민지', more: 0 } }), NO_LINK)
      try {
        await m.until(() => m.find('team-goal-add-skills'), '[스킬 넣기]')
        expect(m.get('team-goal-next').textContent).toBe('민지님이 들어왔어요. 팀 스킬을 넣으면 같이 써 볼 수 있어요.')
      } finally { await m.unmount() }
      skills = null
      m = await card(goal({ skill: null, joined: 1, waiting: { first: '민지', more: 0 } }), NO_LINK)
      try {
        await m.settle(40)
        expect(m.find('team-goal-add-skills')).toBeNull()
        expect(m.get('team-goal-next').textContent).toBe('민지님이 들어왔어요. 팀 스킬은 아직 써 보기 전이에요.')
      } finally { await m.unmount() }
    } finally { globalThis.fetch = realFetch }
  })
  test("the title names a few of this team's own skills (GET /api/skills/examples): the goal's one first, then the others, never the intro deck; the count small", async () => {
    const realFetch = globalThis.fetch
    const s = (path: string, name: string, title: string) => ({ path, name, title, summary: '' })
    const skills = [s('skills/general/intro-deck/SKILL.md', 'intro-deck', '회사 소개서'), s('skills/forms/SKILL.md', 'forms', '신청서'), s(AD, 'ad-copy', '광고 문구'), s('skills/quote-maker/SKILL.md', 'quote-maker', 'quote-maker'), s('skills/card-news/SKILL.md', 'card-news', '카드뉴스')]
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://x')
      if (url.pathname === '/api/skills/examples') return new Response(JSON.stringify({ skills, teamFolder: null, landing: null, ranTeamSkill: false, hasProfile: false }), { status: 200, headers: { 'content-type': 'application/json' } })
      return new Response(JSON.stringify({ error: { code: 'internal', message: 'down' } }), { status: 500, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    try {
      const m = await card(goal({ joined: 1, waiting: { first: '민지', more: 0 } }), LINK)
      try {
        const title = () => m.get('team-goal').querySelectorAll('h2')[0]!.textContent
        await m.until(() => title()!.includes('신청서') || null, 'the team\'s skills in the title')
        expect(title()).toBe("동료와 함께 만들어 보기: '광고 문구', '신청서', 'quote maker' · 1/3 · 5일 남음")
        expect(m.get('team-goal-progress').className).toContain('text-xs')
      } finally { await m.unmount() }
    } finally { globalThis.fetch = realFetch }
  })
  test('day 0, nobody joined: how many more, not "아직 아무도 안 들어왔어요" (that waits for the third day)', async () => {
    const m = await card(goal({ joined: 0, startedAt: new Date().toISOString(), endsAt: new Date(Date.now() + 7 * 86_400_000).toISOString(), daysLeft: 7 }), LINK)
    try {
      expect(m.get('team-goal-next').textContent).toBe('2명 더 쓰면 달성이에요.')
      expect(m.html()).not.toContain('아직 아무도')
      expect(m.find('team-goal-copy-invite')).not.toBeNull()
    } finally { await m.unmount() }
  })
  test('a skill without a title: its folder name as words in the title and the invite message, never "quote-maker"', async () => {
    const QUOTE = 'skills/general/quote-maker/SKILL.md'
    // what the server sends without a metadata title: the title repeats the name (skillTitle)
    const link: TeamLinkResponse = { ...LINK, link: { ...LINK.link!, skill: { path: QUOTE, name: 'quote-maker', title: 'quote-maker' } } }
    const m = await card(goal({ skill: null, joined: 0 }), link)
    try {
      expect(m.html()).toContain("동료와 함께 만들어 보기: 'quote maker'")
      await m.click('team-goal-copy-invite')
      expect(copied[0]).toContain("'quote maker'")
      expect(m.html() + copied[0]).not.toContain('quote-maker')
    } finally { await m.unmount() }
  })
  test('setup unfinished: [팀원 초대] goes to the welcome steps\' invite step (router state), not a second invite dialog', async () => {
    function Welcome() { const l = useLocation(); return <p data-testid="where">{`${l.pathname} ${JSON.stringify(l.state)}`}</p> }
    const unfinished = {
      startedAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', teamType: 'marketing',
      steps: { profile: 'done', result: null, invite: null }, resultChatId: null, inviteShownAt: null, site: null, dismissedAt: null, finishedAt: null,
    } as unknown as WelcomeProgress
    useWelcome.setState({ loaded: true, progress: unfinished })
    const expired = { ...LINK, link: { ...LINK.link!, state: 'expired' as const } }
    const m = await mount(<MemoryRouter initialEntries={['/']}><Routes><Route path="/" element={<GoalCard goal={goal({ joined: 0 })} onDismiss={() => {}} link={expired} />} /><Route path="/welcome" element={<Welcome />} /></Routes></MemoryRouter>)
    try {
      await m.click('team-goal-invite')
      await m.until(() => m.find('where'), 'the welcome steps')
      expect(m.get('where').textContent).toBe(`/welcome ${JSON.stringify(INVITE_STEP_STATE)}`)
      expect(INVITE_STEP_STATE).toEqual({ step: 'invite' })
      expect(m.find('invite-step')).toBeNull()
    } finally {
      await m.unmount()
      useWelcome.getState().reset()
    }
  })
  test('setup unfinished, an admin who is not the owner: [팀원 초대] opens the invite dialog (the steps are the owner\'s; /welcome would send them Home)', async () => {
    function Welcome() { const l = useLocation(); return <p data-testid="where">{`${l.pathname} ${JSON.stringify(l.state)}`}</p> }
    const unfinished = {
      startedAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', teamType: 'marketing',
      steps: { profile: 'done', result: null, invite: null }, resultChatId: null, inviteShownAt: null, site: null, dismissedAt: null, finishedAt: null,
    } as unknown as WelcomeProgress
    // the team's progress, read by an admin too (the invite dialog's link panel, Files)
    useWelcome.setState({ loaded: true, progress: unfinished })
    useSession.setState({ status: { kind: 'signed-in', me: me('admin') } } as never)
    const expired = { ...LINK, link: { ...LINK.link!, state: 'expired' as const } }
    const m = await mount(<MemoryRouter initialEntries={['/']}><Routes><Route path="/" element={<GoalCard goal={goal({ joined: 0 })} onDismiss={() => {}} link={expired} />} /><Route path="/welcome" element={<Welcome />} /></Routes></MemoryRouter>)
    try {
      await m.click('team-goal-invite')
      await m.until(() => m.find('invite-step'), 'the invite dialog')
      expect(m.find('where')).toBeNull()
    } finally {
      await m.unmount()
      useWelcome.getState().reset()
      useSession.setState({ status: { kind: 'signed-in', me: me() } } as never)
    }
  })
  test('reached: "달성했어요 · names" and only a way to hide it', async () => {
    let hidden = 0
    const m = await mount(<MemoryRouter><GoalCard goal={goal({ state: 'reached', reachedAt: '2026-11-04T00:00:00.000Z', skill: { path: AD, name: '광고 문구', runners: 3, people: ['민지', '지훈', 'Olga'] } })} onDismiss={() => hidden++} link={null} /></MemoryRouter>)
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
        expect(toggle.textContent).toBe("동료와 함께 만들어 보기: '광고 문구'1/3 · 5일 남음")
        expect(m.get('team-goal-progress').textContent).toBe('1/3 · 5일 남음')
        expect(toggle.getAttribute('aria-expanded')).toBe('false')
        // no frame, no rule under it
        expect(m.get('team-goal').className).not.toContain('border')
        expect(m.get('team-goal-next').closest('[hidden]')).not.toBeNull()
        await m.click('team-goal-toggle')
        expect(m.get('team-goal-toggle').getAttribute('aria-expanded')).toBe('true')
        expect(m.get('team-goal-next').closest('[hidden]')).toBeNull()
        expect(m.get('team-goal-next').textContent).toBe("민지님이 들어왔어요. '광고 문구'는 아직 써 보기 전이에요.")
        expect(m.find('team-goal-resend')).toBeNull()
      } finally { await m.unmount() }
      // no team skill yet: the opened row has [스킬 넣기], still no [다시 보내기]
      m = await mount(<MemoryRouter><GoalCard goal={goal({ skill: null, joined: 1, waiting: { first: '민지', more: 0 } })} onDismiss={() => {}} link={LINK} hasSkills={false} /></MemoryRouter>)
      try {
        await m.click('team-goal-toggle')
        expect(m.get('team-goal-next').textContent).toBe('민지님이 들어왔어요. 팀 스킬을 넣으면 같이 써 볼 수 있어요.')
        expect(m.find('team-goal-add-skills')).not.toBeNull()
        expect(m.find('team-goal-resend')).toBeNull()
      } finally { await m.unmount() }
      // one more person: the line opens to [초대 문구 복사]
      m = await card(goal({ joined: 1, skill: { path: AD, name: '광고 문구', runners: 2, people: ['김하나', '민지'] } }), LINK)
      try {
        await m.click('team-goal-toggle')
        expect(m.find('team-goal-copy-invite')).not.toBeNull()
      } finally { await m.unmount() }
      m = await mount(<MemoryRouter><GoalCard goal={goal({ state: 'reached', reachedAt: '2026-11-04T00:00:00.000Z', skill: { path: AD, name: '광고 문구', runners: 3, people: ['민지', '지훈', 'Olga'] } })} onDismiss={() => {}} link={null} /></MemoryRouter>)
      try {
        expect(m.get('team-goal').textContent).toBe('달성했어요 · 민지·지훈·Olga')
        expect(m.get('team-goal').className).not.toContain('border')
      } finally { await m.unmount() }
    } finally { globalThis.matchMedia = media }
  })
  test('English (the static renderer reads English)', () => {
    const h = renderToStaticMarkup(<MemoryRouter><GoalCard goal={goal({ daysLeft: 1, joined: 1, waiting: { first: 'Minji', more: 0 } })} onDismiss={() => {}} link={LINK} /></MemoryRouter>)
    expect(h).toContain('Make documents together with your colleagues: &#x27;광고 문구&#x27;')
    expect(h).toContain(' · 1/3 · 1 day left')
    expect(h).toContain('Minji joined. Not tried yet: &#x27;광고 문구&#x27;.')
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
    steps: { profile: 'done', result: null, invite: null, ...steps }, resultChatId: null, inviteShownAt: null, site: null, dismissedAt: null, finishedAt: null, ...o,
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

  test('setup unfinished: on a phone only the quiet "설정 이어서 하기 · n/5" row, no goal card; on a computer the goal card (the sidebar\'s setup row stands for the steps, docs/DECISIONS.md "W5")', async () => {
    welcome = fresh(); teamGoal = goal()
    const media = globalThis.matchMedia
    globalThis.matchMedia = ((q: string) => ({ matches: q === '(max-width: 767.98px)', addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })) as unknown as typeof matchMedia
    try {
      const t = await top('owner')
      // the count and the total are lib/welcome.ts's (the steps decide how many there are): 회사 소개 saved counts as done
      // without a deck (docs/DECISIONS.md "W6"), so 1 of them
      expect(t.resume).toBe(`${translate('ko', 'setupRow.resume')} · 1/${stepTotal()}`)
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
  test('Home opened while the connection is down (QA TC-231): the card comes back by itself once the live connection is back, without a reload', async () => {
    welcome = null; teamGoal = goal()
    const working = globalThis.fetch
    let down = true
    let goalReads = 0
    // the connection is down: no answer at all (fetch rejects), as in a browser that lost the server
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/api/onboarding/goal')) goalReads++
      if (down) throw new TypeError('Failed to fetch')
      return working(input, init)
    }) as unknown as typeof fetch
    useUi.setState({ conn: 'reconnecting' })
    useSession.setState({ status: { kind: 'signed-in', me: me('admin') } } as never)
    const m = await mount(<MemoryRouter><HomeTop owner={false} /></MemoryRouter>)
    try {
      await m.settle(60)
      expect(m.find('team-goal')).toBeNull()
      const failed = goalReads
      expect(failed).toBeGreaterThan(0)
      // the live connection is back: the goal is read again at once (the backoff waits seconds; this does not)
      down = false
      await act(async () => { useUi.setState({ conn: 'open' }) })
      await m.until(() => m.find('team-goal'), 'the goal card back')
      expect(m.get('team-goal').getAttribute('data-state')).toBe('open')
      expect(goalReads).toBe(failed + 1)
    } finally {
      await m.unmount()
      globalThis.fetch = working
      useUi.setState({ conn: 'idle' })
    }
  })
})
