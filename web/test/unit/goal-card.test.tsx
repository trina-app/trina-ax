// The 7-day team goal on Home (src/components/onboarding/GoalCard.tsx, src/lib/teamGoal.ts): the card's line
// "7일 안에 3명이 같은 스킬 써 보기 · 2/3 · 5일 남음", who ran the top skill (never who did not), the invite buttons,
// the "달성했어요" state; whether it shows instead of the owner checklist (hosted) or beside it; the owners' notice text.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Me, TeamGoal, TeamLinkResponse } from '@mycel/shared/api'
import { translate, useLocaleStore, type MessageKey, type Params } from '../../src/i18n'
import { GoalCard, GoalOrChecklist } from '../../src/components/onboarding/GoalCard'
import { firstRunText, goalProgressText, objectParticle, quotedSkill, runnerNames } from '../../src/lib/teamGoal'
import { useSession } from '../../src/store/session'
import { installDom, mount, removeDom } from './dom-host'

const ko = (k: MessageKey, p?: Params) => translate('ko', k, p)
const en = (k: MessageKey, p?: Params) => translate('en', k, p)
const me = (deployment: 'self' | 'hosted' = 'hosted'): Me => ({
  user: { id: 'olga', username: 'olga', name: '김하나', email: null, role: 'owner', locale: 'ko', localeChoice: null, mustChangePassword: false, prefs: {} },
  groups: [], team: { name: 'Acme', defaultLocale: 'ko' }, session: { id: '01900000-0000-7000-8000-00000000000a', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' },
  server: { version: '0', dev: false, deployment },
} as unknown as Me)
const goal = (o: Partial<TeamGoal> = {}): TeamGoal => ({
  state: 'open', target: 3, days: 7, startedAt: '2026-11-01T00:00:00.000Z', endsAt: '2026-11-08T00:00:00.000Z', daysLeft: 5,
  skill: { path: 'skills/marketing/ad-copy/SKILL.md', name: '광고 문구', runners: 2, people: ['김민지', '이수진'] }, reachedAt: null, ...o,
})
const LINK: TeamLinkResponse = {
  link: { id: '01900000-0000-7000-8000-000000000001', url: 'https://acme.example/join#t=abcdefghijklmnopqrstuvwxyz', groupIds: [], skill: { path: 'skills/marketing/ad-copy/SKILL.md', name: 'ad-copy' }, maxUses: 10, uses: 1, createdBy: null, createdAt: '2026-11-01T00:00:00.000Z', expiresAt: '2026-11-15T00:00:00.000Z', state: 'active' },
  seats: { used: 2, limit: null },
}

describe('text helpers', () => {
  test('the Korean object particle follows the last sound; quoted per language', () => {
    expect(['광고 문구', '보고서', '주간 리포트', '경쟁사 분석', '캠페인', 'v2', 'v3', 'ad-copy'].map(objectParticle)).toEqual(['를', '를', '를', '을', '을', '를', '을', '을(를)'])
    expect(quotedSkill('ko', '광고 문구')).toBe("'광고 문구'를")
    expect(quotedSkill('ja', '広告コピー')).toBe('「広告コピー」')
    expect(quotedSkill('en', 'Ad copy')).toBe("'Ad copy'")
  })
  test('progress up to the target, then a count; three names then +N (deleted people counted, never named)', () => {
    expect(goalProgressText(ko, 2, 3)).toBe('2/3')
    expect(goalProgressText(ko, 4, 3)).toBe('4명')
    expect(goalProgressText(en, 5, 3)).toBe('5 people')
    expect(runnerNames(['a', 'b'], 2)).toBe('a, b')
    expect(runnerNames(['a', 'b', 'c', 'd'], 5)).toBe('a, b, c +2')
    expect(runnerNames([], 1)).toBe('+1')
  })
  test('the owners\' notice: "○○님이 \'광고 문구\'를 처음 써 봤어요 (2/3)", and without a name once the account is gone', () => {
    const firstRun = { member: '김민지', skill: '광고 문구', runners: 2, target: 3 }
    expect(firstRunText(ko, 'ko', { firstRun })).toBe("김민지님이 '광고 문구'를 처음 써 봤어요 (2/3)")
    expect(firstRunText(en, 'en', { firstRun: { ...firstRun, skill: 'Ad copy' } })).toBe("김민지 tried 'Ad copy' for the first time (2/3)")
    expect(firstRunText(ko, 'ko', { firstRun: { ...firstRun, member: null, runners: 4 } })).toBe("팀원 한 명이 '광고 문구'를 처음 써 봤어요 (4명)")
    expect(firstRunText(ko, 'ko', {})).toBe(ko('goal.firstRunPlain'))
  })
})

describe('the card', () => {
  const before = useLocaleStore.getState().locale
  const status = useSession.getState().status
  beforeAll(() => {
    installDom()
    useLocaleStore.setState({ locale: 'ko' })
    useSession.setState({ status: { kind: 'signed-in', me: me() } } as never)
  })
  afterAll(() => {
    removeDom()
    useLocaleStore.setState({ locale: before })
    useSession.setState({ status })
  })
  const html = async (g: TeamGoal, link: TeamLinkResponse | null = null) => {
    const m = await mount(<GoalCard goal={g} onDismiss={() => {}} link={link} />)
    try { return m.html() } finally { await m.unmount() }
  }

  test('open: the goal, its progress and the days left on one line; who ran the top skill; invite', async () => {
    const h = await html(goal())
    expect(h).toContain('7일 안에 3명이 같은 스킬 써 보기')
    expect(h).toContain(' · 2/3 · 5일 남음')
    expect(h).toContain("'광고 문구' 스킬을 써 본 사람: 김민지, 이수진")
    expect(h).toContain('data-state="open"')
    expect(h).toContain('팀원 초대')
    // two of three segments filled
    expect(h.match(/rounded-full bg-accent/g)?.length).toBe(2)
    expect(h.match(/rounded-full bg-hover/g)?.length).toBe(1)
    // no team link yet: no message to copy (the invite dialog makes one)
    expect(h).not.toContain('초대 문구 복사')
    // phones: no frame of its own, a line under it; a card from sm up
    expect(h).toContain('border-b border-line')
    expect(h).toContain('sm:rounded-2xl sm:border')
  })
  test('with the team link: [초대 문구 복사] copies the ready-made message', async () => {
    expect(await html(goal(), LINK)).toContain('초대 문구 복사')
    // a link that no longer works offers nothing to copy
    expect(await html(goal(), { ...LINK, link: { ...LINK.link!, state: 'expired' } })).not.toContain('초대 문구 복사')
  })
  test('[팀원 초대] opens the team invite link step with the top skill', async () => {
    const m = await mount(<GoalCard goal={goal()} onDismiss={() => {}} link={null} />)
    try {
      expect(m.find('invite-step')).toBeNull()
      await m.click('team-goal-invite')
      await m.until(() => m.find('invite-step'), 'the invite step')
    } finally { await m.unmount() }
  })
  test('nobody yet: what to do, no names', async () => {
    const h = await html(goal({ skill: null }))
    expect(h).toContain(' · 0/3 · 5일 남음')
    expect(h).toContain('팀 스킬 하나를 골라 함께 써 보세요. 같은 스킬을 3명이 쓰면 달성이에요.')
  })
  test('reached: "달성했어요", who, and a way to hide it', async () => {
    let hidden = 0
    const m = await mount(<GoalCard goal={goal({ state: 'reached', reachedAt: '2026-11-04T00:00:00.000Z', skill: { path: 'skills/x/SKILL.md', name: '광고 문구', runners: 3, people: ['김민지', '이수진', '김하나'] } })} onDismiss={() => hidden++} link={null} />)
    try {
      const h = m.html()
      expect(h).toContain('달성했어요')
      expect(h).toContain("3명이 '광고 문구' 스킬을 함께 썼어요: 김민지, 이수진, 김하나")
      expect(h).not.toContain('일 남음')
      await m.click('team-goal-dismiss')
      expect(hidden).toBe(1)
    } finally { await m.unmount() }
  })
  test('English (the static renderer reads English)', () => {
    const h = renderToStaticMarkup(<GoalCard goal={goal({ daysLeft: 1 })} onDismiss={() => {}} link={null} />)
    expect(h).toContain('3 people use the same skill within 7 days')
    expect(h).toContain(' · 2/3 · 1 day left')
    expect(h).toContain('Invite teammates')
  })
})

describe('instead of the owner checklist, or beside it', () => {
  const realFetch = globalThis.fetch
  const status = useSession.getState().status
  let answer: () => Response = () => new Response('{}', { status: 500 })
  let asked = 0
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  beforeAll(() => {
    installDom()
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const u = String(input)
      if (u.includes('/api/onboarding/goal')) { asked++; return answer() }
      if (u.includes('/api/admin/team-link')) return json({ link: null, seats: { used: 1, limit: null } })
      return new Response('{}', { status: 404 })
    }) as unknown as typeof fetch
  })
  afterAll(() => {
    globalThis.fetch = realFetch
    removeDom()
    useSession.setState({ status })
  })
  const shown = async (deployment: 'self' | 'hosted', body: (() => Response)) => {
    useSession.setState({ status: { kind: 'signed-in', me: me(deployment) } } as never)
    answer = body
    const before = asked
    const m = await mount(<GoalOrChecklist checklist={<p data-testid="checklist">checklist</p>} />)
    try {
      await m.until(() => asked > before, 'the goal asked for')
      await m.settle(50)
      return { goal: m.find('team-goal')?.getAttribute('data-state') ?? null, checklist: !!m.find('checklist') }
    } finally { await m.unmount() }
  }

  test('a hosted team in its window: the card only; on its own server both', async () => {
    expect(await shown('hosted', () => json({ goal: goal() }))).toEqual({ goal: 'open', checklist: false })
    expect(await shown('self', () => json({ goal: goal() }))).toEqual({ goal: 'open', checklist: true })
  })
  test('the checklist does not wait for the goal', async () => {
    useSession.setState({ status: { kind: 'signed-in', me: me('hosted') } } as never)
    let release: (r: Response) => void = () => {}
    answer = () => new Promise<Response>((res) => { release = res }) as unknown as Response
    const m = await mount(<GoalOrChecklist checklist={<p data-testid="checklist">checklist</p>} />)
    try {
      expect(m.find('checklist')).not.toBeNull()
      expect(m.find('team-goal')).toBeNull()
      // then the goal of a new hosted team: the card takes the checklist's place
      release(json({ goal: goal() }))
      await m.until(() => m.find('team-goal'), 'the card')
      expect(m.find('checklist')).toBeNull()
    } finally { await m.unmount() }
  })
  test('no goal (an older team) or a failed load: the checklist as before', async () => {
    expect(await shown('hosted', () => json({ goal: null }))).toEqual({ goal: null, checklist: true })
    expect(await shown('hosted', () => new Response('{}', { status: 500 }))).toEqual({ goal: null, checklist: true })
  })
  test('"달성했어요" once: hidden after it was dismissed in this browser', async () => {
    const reached = goal({ state: 'reached', reachedAt: '2026-11-04T00:00:00.000Z' })
    expect(await shown('hosted', () => json({ goal: reached }))).toEqual({ goal: 'reached', checklist: false })
    localStorage.setItem(`mycel.teamGoalDone.${reached.startedAt}`, '1')
    expect(await shown('hosted', () => json({ goal: reached }))).toEqual({ goal: null, checklist: true })
    // a later team (another start) is not hidden by it
    expect(await shown('hosted', () => json({ goal: { ...reached, startedAt: '2026-12-01T00:00:00.000Z' } }))).toEqual({ goal: 'reached', checklist: false })
  })
})
