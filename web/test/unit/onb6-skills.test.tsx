// Onboarding v6, 내 스킬 (docs/DECISIONS.md "W6"; FLOW-v6 §2): the kept skills' part of the step
// (components/onboarding/SkillsStep.tsx, components/skills/PackRows.tsx), its one primary, the example viewer
// (components/skills/SkillExampleViewer.tsx) and the 30-second end of an own-skills check (SkillShareReview embedded),
// rendered and clicked against a small fake of the server (GET /api/onboarding/packs, POST …/packs/:id/install, the
// skill shares and their stop-check):
// - pre-checks without an AI: the three visual skills when a company profile is saved, 자연스러운 글 never, none on a
//   revisit of a done step; only the skills the team lacks are rows, and they never move;
// - the primary's words: the kept titles named up to three items ("카드뉴스 외 1개 넣기"), from four on "팀에 넣기 · n개";
// - the press: own skills first, then one install per pack with the names; all in → the toast and onNext; otherwise the
//   step stays: what went in marked, a name taken, the folder rules, a request that failed (다시 for only those; with
//   own skills in, "내 스킬 k개는 넣었어요 · …"), and the primary reads 다음;
// - the catalog that does not load: one note with 다시, the rest of the step working;
// - the viewer: "예시를 준비하고 있어요" until an example is made, a text example in the page, an image that fails, the
//   invented company line, the source line (the one link out), ‹ › and the arrow keys wrapping, the focus back on 예시;
// - a check still running after checkLimitMs: stop-check, the list with nothing ticked; a stop that fails offers 다시.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { act } from 'react'
import { MemoryRouter } from 'react-router-dom'
import type { PackCatalogSkill, ShareCandidate, SkillShare } from '@mycel/shared/api'
import { translate, useLocaleStore, useT, type MessageKey } from '../../src/i18n'
import { preChecked, primaryLabel, SHARE_CHECK_LIMIT_MS, SkillsStep } from '../../src/components/onboarding/SkillsStep'
import { SkillShareReview, type ShareReviewState } from '../../src/components/onboarding/SkillShareReview'
import { PackRows } from '../../src/components/skills/PackRows'
import { useUi } from '../../src/store/ui'
import { useWelcome } from '../../src/store/welcome'
import { FakeElement, FakeEvent, installDom, mount, removeDom, type Mounted } from './dom-host'

const ko = (k: MessageKey, p?: Record<string, string | number>) => translate('ko', k, p)
const t = ko as unknown as ReturnType<typeof useT>
const json = (status: number, body: unknown) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const failed = (message: string) => json(500, { error: { code: 'internal', message } })

const kept = (pack: 'general' | 'work', name: string, title: string, o: Partial<PackCatalogSkill> = {}): PackCatalogSkill => ({
  pack, name, path: `skills/${pack}/${name}/SKILL.md`, title, description: `${title} 한 줄`, inTeam: false, visual: pack === 'general', example: null, locale: 'ko', source: { kind: 'team' }, ...o,
})
/** the catalog's four, in its order (server/src/onboarding/skill-packs.ts CATALOG) */
const catalogOf = (inTeam: string[] = []) => [
  kept('general', 'intro-deck', '회사 소개서'), kept('general', 'card-news', '카드뉴스'), kept('general', 'promo-video', '홍보 영상'),
  kept('work', 'humanizer', '자연스러운 글', { source: { kind: 'team_writing' } }),
].map((s) => ({ ...s, inTeam: inTeam.includes(s.name) }))

const OWN = '01900000-0000-7000-8000-0000000007a1'
const cand = (name: string, title: string, group: ShareCandidate['group'], reason: ShareCandidate['reason']): ShareCandidate => ({
  name, title, description: title, origin: 'user', project: null, group, reason, detail: null, personalPath: false,
  files: [{ path: 'SKILL.md', bytes: 900 }], scriptsDropped: 0, sameName: null, similar: null, action: 'add', applied: null,
})
const ownShare = (o: Partial<SkillShare> = {}): SkillShare => ({
  id: OWN, source: 'browser', app: 'claude', status: 'ready', where: '.claude', projects: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), expiresAt: '2026-11-20T00:00:00.000Z',
  ai: 'done', candidates: [cand('weekly-report', '주간 업무 보고', 'recommended', 'team_any'), cand('my-schedule', '내 일정 정리', 'other', 'personal')], rule: null, tools: [], landing: null, ...o,
})

// ---- the fake server
let catalog = catalogOf()
let profile = true
let packsFail = 0
/** an install's answer per pack (default: every named skill created, and in the team from then on) */
let installs: Partial<Record<'general' | 'work', (names: string[]) => Response>> = {}
/** the person's proposals (GET /api/skill-shares); a share's own reads come from here too */
let shares: SkillShare[] = []
let stopFail = 0
let calls: { key: string; body: any }[] = []
const called = (key: string) => calls.filter((c) => c.key === key)
const posts = () => calls.filter((c) => c.key.startsWith('POST'))

function route(method: string, path: string, body: any): Response {
  const key = `${method} ${path}`
  if (key === 'GET /api/connectors/remote') return json(200, { configured: false, resource: null, items: [] })
  if (key === 'GET /api/onboarding/packs') return packsFail-- > 0 ? failed('지금은 불러오지 못했어요') : json(200, { skills: catalog, profile })
  const install = /^POST \/api\/onboarding\/packs\/(general|work)\/install$/.exec(key)
  if (install) {
    const id = install[1] as 'general' | 'work'
    const r = installs[id]?.(body.skills)
    if (r) return r
    catalog = catalog.map((s) => (body.skills.includes(s.name) ? { ...s, inTeam: true } : s))
    return json(200, { pack: id, locale: 'ko', skills: body.skills.map((name: string) => ({ name, path: `skills/${id}/${name}/SKILL.md`, status: 'created' })) })
  }
  if (key === 'GET /api/skill-shares') return json(200, { items: shares })
  const m = /^\/api\/skill-shares\/([^/]+)(\/apply|\/dismiss|\/stop-check)?$/.exec(path)
  const s = m && shares.find((x) => x.id === m[1])
  if (m && s) {
    if (method === 'GET') return json(200, s)
    if (m[2] === '/dismiss') return json(204, null)
    if (m[2] === '/stop-check') {
      if (stopFail-- > 0) return failed('지금은 멈추지 못했어요')
      const stopped: SkillShare = { ...s, status: 'ready', ai: 'failed', candidates: s.candidates.map((c) => ({ ...c, group: 'other', reason: 'unjudged' })) }
      shares = shares.map((x) => (x.id === s.id ? stopped : x))
      return json(200, stopped)
    }
    const applied: SkillShare = { ...s, status: 'applied', candidates: s.candidates.map((c) => (body.skills.some((x: { name: string }) => x.name === c.name) ? { ...c, applied: { status: 'added', path: `skills/${c.name}/SKILL.md`, chatId: null, error: null } } : c)), landing: `skills/${body.skills[0]?.name}/SKILL.md` }
    shares = shares.map((x) => (x.id === s.id ? applied : x))
    return json(200, applied)
  }
  return json(404, { error: { code: 'not_found', message: `no route ${key}` } })
}

const g = globalThis as Record<string, unknown>
const realFetch = globalThis.fetch
const localeBefore = useLocaleStore.getState().locale
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'ko' })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const path = String(input).split('?')[0]!
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({ key: `${method} ${path}`, body })
    return route(method, path, body)
  }) as unknown as typeof fetch
})
afterEach(() => {
  catalog = catalogOf()
  profile = true
  packsFail = 0
  installs = {}
  shares = []
  stopFail = 0
  calls = []
  useWelcome.getState().reset()
  useUi.setState({ toasts: [] })
  delete g.showDirectoryPicker
  g.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
})
afterAll(() => {
  globalThis.fetch = realFetch
  useLocaleStore.setState({ locale: localeBefore })
  removeDom()
})

/** Chrome on a computer: the folder window */
const computer = () => { g.showDirectoryPicker = async () => { throw Object.assign(new Error('closed'), { name: 'AbortError' }) } }
const phoneWidth = () => { g.matchMedia = (q: string) => ({ matches: q.includes('767.98'), addEventListener() {}, removeEventListener() {} }) }
const stepDone = () => useWelcome.setState({ loaded: true, progress: {
  startedAt: '2026-11-06T00:00:00.000Z', updatedAt: '2026-11-06T00:00:00.000Z', teamType: null, resultChatId: null, inviteShownAt: null, site: null, dismissedAt: null, finishedAt: null,
  steps: { profile: 'done', result: null, skills: 'done', files: null, invite: null },
} as never })
const events: string[] = []
/** the step, once the first look at the person's proposals and the catalog are in */
const step = async () => {
  events.length = 0
  const m = await mount(
    <MemoryRouter>
      <SkillsStep team="Acme" nextLabel="다음: 팀 파일 가져오기" onApplied={(s) => events.push(`applied:${s.id}`)} onNext={() => events.push('next')} onSkip={() => events.push('skip')} />
    </MemoryRouter>,
  )
  await m.until(() => m.find('skills-step')?.getAttribute('data-state') !== 'looking' && called('GET /api/onboarding/packs').length > 0, 'the first look')
  await m.settle(20)
  return m
}
const body = () => (globalThis.document as unknown as { body: FakeElement }).body
const packRows = () => body().querySelectorAll('[data-testid="skill-pack-row"]')
const rowOf = (name: string) => packRows().find((r) => r.getAttribute('data-name') === name)!
const checkOf = (name: string) => rowOf(name).querySelector('[data-testid="skill-pack-check"]') as (FakeElement & { checked: boolean }) | null
const checkedNames = () => packRows().filter((r) => (r.querySelector('[data-testid="skill-pack-check"]') as unknown as { checked: boolean } | null)?.checked).map((r) => r.getAttribute('data-name'))
const text = (m: Mounted, id: string) => m.get(id).textContent ?? ''
/** a browser checks a box before the click's listeners run, past React's value tracker (this small DOM does not) */
const tick = async (m: Mounted, el: FakeElement) => {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'checked')!.set!.call(el, !(el as unknown as { checked: boolean }).checked)
  await m.click(el)
}
const toasts = () => useUi.getState().toasts.map((x) => [x.level, x.text])
const retryIn = (el: FakeElement) => el.querySelectorAll('button').find((b) => b.textContent === ko('common.retry'))!
const ownListReady = (m: Mounted) => m.until(() => m.find('skill-review')?.getAttribute('data-status') === 'ready' && m.find('skills-primary'), 'the own list')

describe('the pre-checks and the primary\'s words (no AI decides)', () => {
  test('preChecked: the three visual skills with a company profile; none without one; none on a revisit of a done step', () => {
    const rows = catalogOf()
    expect([...preChecked(rows, { profile: true, done: false })]).toEqual(['intro-deck', 'card-news', 'promo-video'])
    expect([...preChecked(rows, { profile: false, done: false })]).toEqual([])
    expect([...preChecked(rows, { profile: true, done: true })]).toEqual([])
  })

  test('primaryLabel: kept titles named up to three items, with own skills "… 외 n개"; from four on, or own skills alone, "팀에 넣기 · n개"; nothing: none', () => {
    expect(primaryLabel(t, ['회사 소개서', '카드뉴스', '홍보 영상'], 0)).toBe('회사 소개서·카드뉴스·홍보 영상 넣기')
    expect(primaryLabel(t, ['카드뉴스'], 0)).toBe('카드뉴스 넣기')
    expect(primaryLabel(t, ['카드뉴스'], 1)).toBe('카드뉴스 외 1개 넣기')
    expect(primaryLabel(t, ['카드뉴스', '자연스러운 글'], 1)).toBe('카드뉴스·자연스러운 글 외 1개 넣기')
    expect(primaryLabel(t, ['회사 소개서', '카드뉴스', '홍보 영상', '자연스러운 글'], 0)).toBe(ko('welcome.skills.putN', { n: 4 }))
    expect(primaryLabel(t, ['회사 소개서', '카드뉴스', '홍보 영상'], 1)).toBe(ko('welcome.skills.putN', { n: 4 }))
    expect(primaryLabel(t, [], 2)).toBe(ko('welcome.skills.putN', { n: 2 }))
    expect(primaryLabel(t, [], 0)).toBeNull()
  })

  test('a company profile saved: the rows the team lacks, 회사 소개서·카드뉴스·홍보 영상 checked, 자연스러운 글 not; the primary names them', async () => {
    computer()
    const m = await step()
    try {
      expect(text(m, 'skill-packs')).toContain(ko('skills.catalog.title'))
      expect(packRows().map((r) => r.getAttribute('data-name'))).toEqual(['intro-deck', 'card-news', 'promo-video', 'humanizer'])
      expect(checkedNames()).toEqual(['intro-deck', 'card-news', 'promo-video'])
      // checkbox · title · one line · 예시
      const row = rowOf('card-news')
      expect(row.querySelector('[data-testid="skill-pack-title"]')!.textContent).toBe('카드뉴스')
      expect(row.querySelector('[data-testid="skill-pack-line"]')!.textContent).toBe('카드뉴스 한 줄')
      expect(row.querySelector('[data-testid="skill-pack-example"]')!.getAttribute('aria-label')).toBe(ko('skillPack.exampleNamed', { title: '카드뉴스' }))
      expect(m.get('skills-primary').getAttribute('data-state')).toBe('put')
      expect(text(m, 'skills-primary')).toBe('회사 소개서·카드뉴스·홍보 영상 넣기')
      expect(m.get('skills-primary').className).toContain('bg-accent')
      expect(m.get('skills-later').className).not.toContain('bg-accent')
      // the own part is under it: the folder button secondary
      expect(m.find('skills-own')).not.toBeNull()
      expect(m.get('skills-find').className).not.toContain('bg-accent')
      // nothing installs before a press
      expect(posts()).toEqual([])
    } finally { await m.unmount() }
  })

  test('no company profile: nothing checked, no primary (나중에 하기 has its style); the team\'s own skills are no rows; every one in: no kept part at all', async () => {
    computer()
    profile = false
    catalog = catalogOf(['intro-deck'])
    let m = await step()
    try {
      expect(packRows().map((r) => r.getAttribute('data-name'))).toEqual(['card-news', 'promo-video', 'humanizer'])
      expect(checkedNames()).toEqual([])
      expect(m.find('skills-primary')).toBeNull()
      expect(m.get('skills-later').className).toContain('bg-accent')
      await m.click('skills-later')
      expect(events).toEqual(['skip'])
      expect(posts()).toEqual([])
    } finally { await m.unmount() }
    catalog = catalogOf(['intro-deck', 'card-news', 'promo-video', 'humanizer'])
    m = await step()
    try {
      expect(m.find('skill-packs')).toBeNull()
      expect(m.find('skill-packs-failed')).toBeNull()
      expect(m.find('skills-own')).not.toBeNull()
    } finally { await m.unmount() }
  })

  test('a revisit of a done 내 스킬: nothing checked even with a profile; the primary reads 다음; no 나중에 하기', async () => {
    computer()
    stepDone()
    const m = await step()
    try {
      expect(packRows()).toHaveLength(4)
      expect(checkedNames()).toEqual([])
      expect(m.get('skills-primary').getAttribute('data-state')).toBe('next')
      expect(text(m, 'skills-primary')).toBe('다음: 팀 파일 가져오기')
      expect(m.find('skills-later')).toBeNull()
      await m.click('skills-primary')
      expect(events).toEqual(['next'])
    } finally { await m.unmount() }
  })

  test('the primary follows the checks and the own list: "카드뉴스 외 1개 넣기", three items named, then "팀에 넣기 · 4개"; own skills alone: "팀에 넣기 · 1개"', async () => {
    computer()
    profile = false
    shares = [ownShare()]
    const m = await step()
    try {
      await ownListReady(m)
      // the own list's recommended row is ticked: one own skill
      expect(text(m, 'skills-primary')).toBe(ko('welcome.skills.putN', { n: 1 }))
      await tick(m, checkOf('card-news')!)
      expect(text(m, 'skills-primary')).toBe('카드뉴스 외 1개 넣기')
      await tick(m, checkOf('humanizer')!)
      expect(text(m, 'skills-primary')).toBe('카드뉴스·자연스러운 글 외 1개 넣기')
      await tick(m, checkOf('intro-deck')!)
      expect(text(m, 'skills-primary')).toBe(ko('welcome.skills.putN', { n: 4 }))
      // the embedded list has no primary and no 나중에 하기 of its own
      expect(m.find('skills-share')).toBeNull()
      expect(body().querySelectorAll('[data-testid="skills-later"]')).toHaveLength(1)
    } finally { await m.unmount() }
  })

  test('a phone: the same rows without their line, one line that own skills go in on a computer, no folder button', async () => {
    computer()
    phoneWidth()
    const m = await step()
    try {
      expect(packRows()).toHaveLength(4)
      expect(checkedNames()).toEqual(['intro-deck', 'card-news', 'promo-video'])
      expect(body().querySelectorAll('[data-testid="skill-pack-line"]')).toHaveLength(0)
      expect(packRows().every((r) => r.querySelector('[data-testid="skill-pack-example"]'))).toBe(true)
      expect(text(m, 'skills-phone-own')).toBe(ko('welcome.skills.phoneOwn'))
      expect(m.find('skills-find')).toBeNull()
      expect(text(m, 'skills-primary')).toBe('회사 소개서·카드뉴스·홍보 영상 넣기')
    } finally { await m.unmount() }
  })
})

describe('the press', () => {
  test('own skills go in first, then one install per pack with the names (general, then work); all in: one toast and onNext; the rows never move', async () => {
    computer()
    shares = [ownShare()]
    const m = await step()
    try {
      await ownListReady(m)
      await tick(m, checkOf('humanizer')!)
      // four kept, one own
      expect(text(m, 'skills-primary')).toBe(ko('welcome.skills.putN', { n: 5 }))
      await m.click('skills-primary')
      await m.until(() => events.includes('next'), 'on to the next step')
      expect(posts().map((c) => [c.key, c.body])).toEqual([
        [`POST /api/skill-shares/${OWN}/apply`, { skills: [{ name: 'weekly-report', action: 'add' }], rule: false, tools: [] }],
        ['POST /api/onboarding/packs/general/install', { skills: ['intro-deck', 'card-news', 'promo-video'] }],
        ['POST /api/onboarding/packs/work/install', { skills: ['humanizer'] }],
      ])
      expect(events).toEqual([`applied:${OWN}`, 'next'])
      expect(toasts()).toEqual([['success', ko('welcome.skills.installed', { n: 5 })]])
      // what went in is marked; the catalog read again (the team skills changed) moves no row
      await m.until(() => called('GET /api/onboarding/packs').length > 1, 'the catalog read again')
      await m.settle(20)
      expect(packRows().map((r) => `${r.getAttribute('data-name')}:${r.getAttribute('data-state')}`)).toEqual(['intro-deck:in', 'card-news:in', 'promo-video:in', 'humanizer:in'])
      expect(rowOf('card-news').textContent).toContain(ko('skillPack.inNow'))
      expect(checkOf('card-news')).toBeNull()
    } finally { await m.unmount() }
  })

  test('a name taken: that row says so, the note counts it, no toast; the primary reads 다음 and goes on', async () => {
    computer()
    installs.general = (names) => json(200, { pack: 'general', locale: 'ko', skills: names.map((name) => (name === 'card-news'
      ? { name, path: `skills/general/${name}/SKILL.md`, status: 'blocked', sameNameAs: 'skills/card-news/SKILL.md' }
      : { name, path: `skills/general/${name}/SKILL.md`, status: 'created' })) })
    const m = await step()
    try {
      await m.click('skills-primary')
      await m.until(() => m.find('skill-pack-taken'), 'the note')
      expect(text(m, 'skill-pack-taken')).toBe(ko('skillPack.taken', { n: 1 }))
      expect(packRows().map((r) => `${r.getAttribute('data-name')}:${r.getAttribute('data-state')}`)).toEqual(['intro-deck:in', 'card-news:out', 'promo-video:in', 'humanizer:null'])
      expect(rowOf('card-news').textContent).toContain(ko('skillPack.takenOne'))
      expect(toasts()).toEqual([])
      expect(events).toEqual([])
      expect(m.get('skills-primary').getAttribute('data-state')).toBe('next')
      expect(text(m, 'skills-primary')).toBe('다음: 팀 파일 가져오기')
      await m.click('skills-primary')
      expect(events).toEqual(['next'])
    } finally { await m.unmount() }
  })

  test('the folder rules keep them out: the note says where to look; 다음 then puts the step off (nothing went in)', async () => {
    computer()
    installs.general = (names) => json(200, { pack: 'general', locale: 'ko', skills: names.map((name) => ({ name, path: `skills/general/${name}/SKILL.md`, status: 'blocked' })) })
    const m = await step()
    try {
      await m.click('skills-primary')
      await m.until(() => m.find('skill-pack-blocked'), 'the note')
      expect(text(m, 'skill-pack-blocked')).toBe(ko('skillPack.blockedRules'))
      expect(rowOf('intro-deck').getAttribute('data-state')).toBe('out')
      expect(rowOf('intro-deck').textContent).toContain(ko('skillPack.blockedOne'))
      expect(m.find('skill-pack-taken')).toBeNull()
      expect(m.get('skills-primary').getAttribute('data-state')).toBe('next')
      await m.click('skills-primary')
      expect(events).toEqual(['skip'])
    } finally { await m.unmount() }
  })

  test('own skills went in and the kept ones failed: "내 스킬 k개는 넣었어요 · …" with 다시 for only those; the primary reads 다음; 다시 then goes on', async () => {
    computer()
    profile = false
    shares = [ownShare()]
    let fails = 1
    installs.general = () => (fails-- > 0 ? failed('지금은 넣지 못했어요') : undefined as never)
    const m = await step()
    try {
      await ownListReady(m)
      await tick(m, checkOf('card-news')!)
      await m.click('skills-primary')
      await m.until(() => m.find('skill-pack-failed'), 'the note')
      expect(m.get('skill-pack-failed').querySelector('[role="alert"]')!.textContent).toBe(ko('welcome.skills.partOwn', { k: 1 }) + ko('common.retry'))
      expect(events).toEqual([`applied:${OWN}`])
      expect(toasts()).toEqual([])
      expect(m.get('skills-primary').getAttribute('data-state')).toBe('next')
      installs.general = undefined
      await m.click(retryIn(m.get('skill-pack-failed')))
      await m.until(() => events.includes('next'), 'on to the next step')
      // 다시 sends the failed kept skills only; the own skills are not applied again
      expect(called('POST /api/onboarding/packs/general/install').map((c) => c.body)).toEqual([{ skills: ['card-news'] }, { skills: ['card-news'] }])
      expect(called(`POST /api/skill-shares/${OWN}/apply`)).toHaveLength(1)
      expect(toasts()).toEqual([['success', ko('welcome.skills.installed', { n: 2 })]])
      expect(rowOf('card-news').getAttribute('data-state')).toBe('in')
    } finally { await m.unmount() }
  })

  test('one pack\'s request failed: the other went in; 다시 sends only the failed pack\'s skills, then goes on', async () => {
    computer()
    let fails = 1
    installs.general = () => (fails-- > 0 ? failed('지금은 넣지 못했어요') : undefined as never)
    const m = await step()
    try {
      await tick(m, checkOf('humanizer')!)
      await m.click('skills-primary')
      await m.until(() => m.find('skill-pack-failed'), 'the note')
      expect(m.get('skill-pack-failed').textContent).toContain('지금은 넣지 못했어요')
      expect(rowOf('humanizer').getAttribute('data-state')).toBe('in')
      expect(['intro-deck', 'card-news', 'promo-video'].map((n) => rowOf(n).getAttribute('data-state'))).toEqual([null, null, null])
      expect(events).toEqual([])
      installs.general = undefined
      await m.click(retryIn(m.get('skill-pack-failed')))
      await m.until(() => events.includes('next'), 'on to the next step')
      expect(posts().map((c) => [c.key, c.body])).toEqual([
        ['POST /api/onboarding/packs/general/install', { skills: ['intro-deck', 'card-news', 'promo-video'] }],
        ['POST /api/onboarding/packs/work/install', { skills: ['humanizer'] }],
        ['POST /api/onboarding/packs/general/install', { skills: ['intro-deck', 'card-news', 'promo-video'] }],
      ])
      // the toast counts every skill the press and its 다시 put in: humanizer, then the three
      expect(toasts()).toEqual([['success', ko('welcome.skills.installed', { n: 4 })]])
      expect(m.find('skill-pack-failed')).toBeNull()
    } finally { await m.unmount() }
  })

  test('a name taken and a request that failed: after a 다시 that works the step stays (the taken note still said), and 다음 goes on', async () => {
    computer()
    installs.general = (names) => json(200, { pack: 'general', locale: 'ko', skills: names.map((name) => (name === 'card-news'
      ? { name, path: `skills/general/${name}/SKILL.md`, status: 'blocked', sameNameAs: 'skills/card-news/SKILL.md' }
      : { name, path: `skills/general/${name}/SKILL.md`, status: 'created' })) })
    let fails = 1
    installs.work = () => (fails-- > 0 ? failed('지금은 넣지 못했어요') : undefined as never)
    const m = await step()
    try {
      await tick(m, checkOf('humanizer')!)
      await m.click('skills-primary')
      await m.until(() => m.find('skill-pack-failed'), 'the notes')
      expect(m.find('skill-pack-taken')).not.toBeNull()
      installs.work = undefined
      await m.click(retryIn(m.get('skill-pack-failed')))
      await m.until(() => rowOf('humanizer').getAttribute('data-state') === 'in', 'the retried row in')
      expect(called('POST /api/onboarding/packs/work/install').map((c) => c.body)).toEqual([{ skills: ['humanizer'] }, { skills: ['humanizer'] }])
      expect(m.find('skill-pack-failed')).toBeNull()
      expect(text(m, 'skill-pack-taken')).toBe(ko('skillPack.taken', { n: 1 }))
      expect(events).toEqual([])
      expect(toasts()).toEqual([])
      expect(m.get('skills-primary').getAttribute('data-state')).toBe('next')
      await m.click('skills-primary')
      expect(events).toEqual(['next'])
    } finally { await m.unmount() }
  })
})

describe('the catalog does not load', () => {
  test('that part says so with 다시; the own part and 나중에 하기 still work; 다시 brings the rows', async () => {
    computer()
    packsFail = 1
    const m = await step()
    try {
      await m.until(() => m.find('skill-packs-failed'), 'the note')
      expect(text(m, 'skill-packs-failed')).toContain(ko('skillPack.loadFailed'))
      expect(m.find('skill-packs')).toBeNull()
      expect(m.find('skills-find')).not.toBeNull()
      expect(m.get('skills-later').hasAttribute('disabled')).toBe(false)
      await m.click(retryIn(m.get('skill-packs-failed')))
      await m.until(() => m.find('skill-packs'), 'the rows')
      expect(m.find('skill-packs-failed')).toBeNull()
      expect(checkedNames()).toEqual(['intro-deck', 'card-news', 'promo-video'])
      expect(called('GET /api/onboarding/packs')).toHaveLength(2)
    } finally { await m.unmount() }
  })
})

describe('the example viewer', () => {
  const ROWS: PackCatalogSkill[] = [
    kept('general', 'intro-deck', '회사 소개서'),
    kept('general', 'card-news', '카드뉴스', { example: { kind: 'image', url: '/skill-examples/ko/card-news.webp' } }),
    kept('work', 'humanizer', 'Natural writing', {
      locale: 'en', description: 'Rewrites text that reads as AI-written',
      example: { kind: 'text', markdown: '**Before:** It is worth noting that our beans are, in essence, pivotal.\n\n**After:** Our beans are fresh.' },
      source: { kind: 'adapted', author: 'Siqi Chen', project: 'humanizer', license: 'MIT', url: 'https://github.com/blader/humanizer' },
    }),
  ]
  const rows = (items = ROWS) => mount(<MemoryRouter><PackRows items={items} checked={new Set()} onToggle={() => {}} /></MemoryRouter>)
  const exampleOf = (name: string) => rowOf(name).querySelector('[data-testid="skill-pack-example"]')!
  const viewer = (m: Mounted) => m.get('skill-example')
  const key = (el: FakeElement, k: string) => act(async () => { el.dispatchEvent(new FakeEvent('keydown', { bubbles: true, cancelable: true, key: k })) })

  test('예시 opens one dialog: "예시를 준비하고 있어요" until an example is made; an image that does not load says so; a text example in the page, the invented company, the source with its one link out', async () => {
    const m = await rows()
    try {
      await m.click(exampleOf('intro-deck'))
      expect(viewer(m).getAttribute('data-name')).toBe('intro-deck')
      expect(viewer(m).getAttribute('data-state')).toBe('placeholder')
      expect(body().querySelector('[role="dialog"]')!.querySelector('h2')!.textContent).toBe(ko('skillPack.exampleTitle', { title: '회사 소개서' }))
      expect(text(m, 'skill-example-body')).toBe(`회사 소개서 한 줄${ko('skillPack.preparing')}`)
      expect(m.find('skill-example-fictional')).toBeNull()
      expect(m.get('skill-example-source').getAttribute('data-kind')).toBe('team')
      expect(text(m, 'skill-example-source')).toBe(ko('skillPack.source.team'))
      expect(viewer(m).textContent).toContain('1/3')
      // ›: the cards, an image loading, then failing
      await m.click('skill-example-next')
      expect(viewer(m).getAttribute('data-name')).toBe('card-news')
      expect(viewer(m).getAttribute('data-state')).toBe('loading')
      const img = m.get('skill-example-image')
      expect(img.getAttribute('src')).toBe('/skill-examples/ko/card-news.webp')
      expect(img.getAttribute('alt')).toBe(ko('skillPack.exampleAlt', { title: '카드뉴스' }))
      await act(async () => { img.dispatchEvent(new FakeEvent('error')) })
      expect(viewer(m).getAttribute('data-state')).toBe('failed')
      expect(text(m, 'skill-example-body')).toBe(`카드뉴스 한 줄${ko('skillPack.exampleFailed')}`)
      expect(m.find('skill-example-image')).toBeNull()
      expect(m.find('skill-example-fictional')).toBeNull()
      // ›: the text example, drawn in the page; English text: the invented company in English; the open-source origin
      await m.click('skill-example-next')
      expect(viewer(m).getAttribute('data-state')).toBe('shown')
      expect(m.get('skill-example-body').getAttribute('data-kind')).toBe('text')
      expect(text(m, 'skill-example-body')).toContain('Our beans are fresh.')
      expect(m.get('skill-example-body').querySelector('strong')!.textContent).toBe('Before:')
      expect(text(m, 'skill-example-fictional')).toBe(ko('skillPack.fictional', { company: 'Example Coffee' }))
      expect(m.get('skill-example-source').getAttribute('data-kind')).toBe('adapted')
      expect(text(m, 'skill-example-source')).toContain(ko('skillPack.source.adapted', { author: 'Siqi Chen', project: 'humanizer', license: 'MIT' }))
      const link = m.get('skill-example-original')
      expect(link.getAttribute('href')).toBe('https://github.com/blader/humanizer')
      expect(link.getAttribute('target')).toBe('_blank')
      expect(link.getAttribute('rel')).toBe('noopener noreferrer')
      expect(link.textContent).toContain(ko('skillPack.source.original'))
      expect(body().querySelectorAll('a').map((a) => a.getAttribute('href'))).toEqual(['https://github.com/blader/humanizer'])
    } finally { await m.unmount() }
  })

  test('‹ › and the arrow keys go along the rows and wrap; an image comes back loading, then shown with the invented company; Esc closes, the focus back on the 예시 of the row shown', async () => {
    const m = await rows()
    try {
      await m.click(exampleOf('card-news'))
      expect(viewer(m).textContent).toContain('2/3')
      await m.click('skill-example-next')
      await m.click('skill-example-next')
      // past the last: the first
      expect(viewer(m).getAttribute('data-name')).toBe('intro-deck')
      await m.click('skill-example-prev')
      expect(viewer(m).getAttribute('data-name')).toBe('humanizer')
      await key(viewer(m), 'ArrowRight')
      expect(viewer(m).getAttribute('data-name')).toBe('intro-deck')
      await key(viewer(m), 'ArrowLeft')
      await key(viewer(m), 'ArrowLeft')
      expect(viewer(m).getAttribute('data-name')).toBe('card-news')
      expect(viewer(m).getAttribute('data-state')).toBe('loading')
      await act(async () => { m.get('skill-example-image').dispatchEvent(new FakeEvent('load')) })
      expect(viewer(m).getAttribute('data-state')).toBe('shown')
      expect(text(m, 'skill-example-fictional')).toBe(ko('skillPack.fictional', { company: '예시커피' }))
      await key(viewer(m), 'Escape')
      expect(m.find('skill-example')).toBeNull()
      expect((globalThis.document as unknown as { activeElement: unknown }).activeElement).toBe(exampleOf('card-news'))
    } finally { await m.unmount() }
  })

  test('one row: no ‹ ›; a Korean 자연스러운 글 reads that it grew from the team\'s own writing skill, with no link out', async () => {
    const m = await rows([kept('work', 'humanizer', '자연스러운 글', { source: { kind: 'team_writing' }, example: { kind: 'text', markdown: '예시 글' } })])
    try {
      await m.click(exampleOf('humanizer'))
      expect(m.find('skill-example-prev')).toBeNull()
      expect(m.find('skill-example-next')).toBeNull()
      expect(m.get('skill-example-source').getAttribute('data-kind')).toBe('team_writing')
      expect(text(m, 'skill-example-source')).toBe(ko('skillPack.source.teamWriting'))
      expect(m.find('skill-example-original')).toBeNull()
      await key(viewer(m), 'ArrowRight')
      expect(viewer(m).getAttribute('data-name')).toBe('humanizer')
    } finally { await m.unmount() }
  })
})

describe('the end of an own-skills check (walk M2)', () => {
  const HELD = '01900000-0000-7000-8000-0000000007b1'
  const held = () => ownShare({ id: HELD, status: 'checking', ai: 'pending' })
  const review = (states: ShareReviewState[], stopped: string[], limit = 60) => mount(
    <MemoryRouter>
      <SkillShareReview share={held()} team="Acme" doneLabel="다음" onDone={() => {}} onLater={() => {}} onStopped={() => stopped.push('stopped')}
        embedded inSetup onState={(s) => states.push(s)} checkLimitMs={limit} />
    </MemoryRouter>,
  )

  test('the step waits at most SHARE_CHECK_LIMIT_MS (30 s), its primary disabled meanwhile', async () => {
    expect(SHARE_CHECK_LIMIT_MS).toBe(30_000)
    computer()
    shares = [held()]
    const m = await step()
    try {
      await m.until(() => m.find('skill-review')?.getAttribute('data-status') === 'checking', 'the checking list')
      expect(m.get('skills-primary').getAttribute('data-state')).toBe('checking')
      expect(m.get('skills-primary').hasAttribute('disabled')).toBe(true)
      expect(text(m, 'skills-primary')).toContain(ko('welcome.skills.checking'))
      // nothing is stopped before the limit
      expect(called(`POST /api/skill-shares/${HELD}/stop-check`)).toEqual([])
    } finally { await m.unmount() }
  })

  test('a check still running at the limit is ended (stop-check): the list with nothing ticked, "AI 없이 찾았어요"; the step is told', async () => {
    shares = [held()]
    const states: ShareReviewState[] = []
    const m = await review(states, [])
    try {
      expect(m.get('skill-review').getAttribute('data-status')).toBe('checking')
      await m.until(() => m.find('skill-review')?.getAttribute('data-status') === 'ready', 'the list')
      expect(called(`POST /api/skill-shares/${HELD}/stop-check`)).toHaveLength(1)
      expect(text(m, 'skill-review-no-ai')).toBe(ko('welcome.skills.noAi'))
      const checks = body().querySelectorAll('[data-testid="skill-check"]') as unknown as { checked: boolean }[]
      expect(checks.every((c) => !c.checked)).toBe(true)
      expect(states.at(-1)).toMatchObject({ id: HELD, status: 'ready', count: 0, extras: 0, applying: false })
      // embedded: no primary and no 나중에 하기 of its own
      expect(m.find('skills-share')).toBeNull()
      expect(m.find('skills-later')).toBeNull()
    } finally { await m.unmount() }
  })

  test('a stop that fails says so with 다시 (the list keeps checking, 그만 찾기 still there); 다시 sends it again', async () => {
    shares = [held()]
    stopFail = 1
    const states: ShareReviewState[] = []
    const m = await review(states, [])
    try {
      await m.until(() => m.find('skill-review')?.querySelector('[role="alert"]'), 'the error')
      expect(m.get('skill-review').getAttribute('data-status')).toBe('checking')
      expect(m.get('skill-review').querySelector('[role="alert"]')!.textContent).toContain('지금은 멈추지 못했어요')
      expect(m.find('skill-review-stop')).not.toBeNull()
      expect(states.at(-1)?.status).toBe('checking')
      await m.click(retryIn(m.get('skill-review')))
      await m.until(() => m.find('skill-review')?.getAttribute('data-status') === 'ready', 'the list')
      expect(called(`POST /api/skill-shares/${HELD}/stop-check`)).toHaveLength(2)
      expect(m.get('skill-review').querySelector('[role="alert"]')).toBeNull()
    } finally { await m.unmount() }
  })
})
