// Onboarding v6, the skills step (docs/DECISIONS.md "W6", "W7"; FLOW-v6 §2): the kept skills
// (components/onboarding/SkillsStep.tsx, components/skills/PackRows.tsx), its one primary, the example viewer
// (components/skills/SkillExampleViewer.tsx) and the 30-second end of an own-skills check (Team skills › Bring my
// skills, SkillShareReview), rendered and clicked against a small fake of the server (GET /api/onboarding/packs, POST
// …/packs/:id/install, the skill shares and their stop-check):
// - pre-checks without an AI: the three visual skills when a company profile is saved, 자연스러운 글 never, none on a
//   revisit of a done step; only the skills the team lacks are rows, and they never move;
// - the primary's words: the kept titles named up to three, from four on "팀에 넣기 · n개";
// - no own skills in the step (W7): no folder button, no hidden-folder hint, no Claude Code or Codex line, on a computer
//   or a phone; every kept skill in the team already: one line and 다음;
// - the press: one install per pack with the names; all in → the toast and onNext; otherwise the step stays: what went
//   in marked, a name taken, the folder rules, a request that failed (다시 for only those), and the primary reads 다음;
// - the catalog that does not load: one note with 다시, 나중에 하기 working;
// - the viewer: "예시를 준비하고 있어요" until an example is made, a text example in the page, an image that fails, the
//   invented company line, the source line (the one link out), ‹ › and the arrow keys wrapping, the focus back on 예시;
//   the examples that ship (server/src/onboarding/skill-examples.ts) in Korean and English: a picture of each visual
//   result, the before → after text, and no "예시를 준비하고 있어요";
// - a check still running after checkLimitMs: stop-check, the list with nothing ticked; a stop that fails offers 다시.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { act } from 'react'
import { MemoryRouter } from 'react-router-dom'
import type { PackCatalogSkill, ShareCandidate, SkillShare } from '@mycel/shared/api'
import { translate, useLocaleStore, useT, type MessageKey } from '../../src/i18n'
import { preChecked, primaryLabel, SkillsStep } from '../../src/components/onboarding/SkillsStep'
import { SkillShareReview } from '../../src/components/onboarding/SkillShareReview'
import { PackRows } from '../../src/components/skills/PackRows'
import { BringSkillsSheet, SHARE_CHECK_LIMIT_MS } from '../../src/components/skills/BringSkillsSheet'
import { useUi } from '../../src/store/ui'
import { useWelcome } from '../../src/store/welcome'
import { namedProduct } from '../../src/lib/tabs'
import { FakeElement, FakeEvent, installDom, mount, removeDom, type Mounted } from './dom-host'
import { packExample } from '../../../server/src/onboarding/skill-examples'

const ko = (k: MessageKey, p?: Record<string, string | number>) => translate('ko', k, p)
/** the product as the catalog and the sources name it beside "트리나에게 묻기" (tabs.ts namedProduct) */
const PRODUCT_KO = namedProduct(ko)
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
  if (key === 'POST /api/skill-shares') { const made = ownShare(); shares = [made]; return json(201, made) }
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
/** the step, once the catalog is in */
const step = async () => {
  events.length = 0
  const m = await mount(
    <MemoryRouter>
      <SkillsStep nextLabel="다음: 팀 파일 가져오기" onNext={() => events.push('next')} onSkip={() => events.push('skip')} />
    </MemoryRouter>,
  )
  await m.until(() => m.find('skills-step') && called('GET /api/onboarding/packs').length > 0, 'the catalog')
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
/** nothing of the own-skills way in is on the step (docs/DECISIONS.md "W7") */
const noOwnPart = (m: Mounted) => {
  for (const id of ['skills-own', 'skills-find', 'skills-hint', 'skills-drop', 'skills-input', 'skills-cc', 'skills-phone-own', 'skill-review']) expect(m.find(id)).toBeNull()
  const words = body().textContent ?? ''
  for (const k of ['skills.catalog.bring', 'welcome.skills.find', 'welcome.skills.bringLead', 'welcome.skills.promise'] as const) expect(words).not.toContain(ko(k))
  expect(words).not.toContain('.claude')
  expect(calls.some((c) => c.key.includes('/api/skill-shares') || c.key === 'GET /api/connectors/remote')).toBe(false)
}

describe('the pre-checks and the primary\'s words (no AI decides)', () => {
  test('preChecked: the three visual skills with a company profile; none without one; none on a revisit of a done step', () => {
    const rows = catalogOf()
    expect([...preChecked(rows, { profile: true, done: false })]).toEqual(['intro-deck', 'card-news', 'promo-video'])
    expect([...preChecked(rows, { profile: false, done: false })]).toEqual([])
    expect([...preChecked(rows, { profile: true, done: true })]).toEqual([])
  })

  test('primaryLabel: every skill named up to three; from four on "팀에 넣기 · n개"; nothing: none', () => {
    expect(primaryLabel(t, ['회사 소개서', '카드뉴스', '홍보 영상'])).toBe('회사 소개서·카드뉴스·홍보 영상 넣기')
    expect(primaryLabel(t, ['카드뉴스'])).toBe('카드뉴스 넣기')
    expect(primaryLabel(t, ['회사 소개서', '카드뉴스', '홍보 영상', '자연스러운 글'])).toBe(ko('welcome.skills.putN', { n: 4 }))
    expect(primaryLabel(t, [])).toBeNull()
  })

  test('a company profile saved: the rows the team lacks, 회사 소개서·카드뉴스·홍보 영상 checked, 자연스러운 글 not; the primary names them', async () => {
    computer()
    const m = await step()
    try {
      expect(text(m, 'skill-packs')).toContain(ko('skills.catalog.title', PRODUCT_KO))
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
      // only the skills Trina prepared: no folder to pick, no hidden-folder hint, no Claude Code line
      noOwnPart(m)
      // nothing installs before a press
      expect(posts()).toEqual([])
    } finally { await m.unmount() }
  })

  test('no company profile: nothing checked, no primary (나중에 하기 has its style); the team\'s own skills are no rows; every one in: one line and 다음', async () => {
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
      expect(text(m, 'skill-packs-all-in')).toBe(ko('welcome.skills.allIn', PRODUCT_KO))
      noOwnPart(m)
      // nothing to choose: one way on, the step done; no 나중에 하기 beside it
      expect(m.get('skills-primary').getAttribute('data-state')).toBe('next')
      expect(m.find('skills-later')).toBeNull()
      await m.click('skills-primary')
      expect(events).toEqual(['next'])
      expect(posts()).toEqual([])
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

  test('a phone: the same rows with their line, nothing about own skills, the primary full width', async () => {
    computer()
    phoneWidth()
    const m = await step()
    try {
      expect(packRows()).toHaveLength(4)
      expect(checkedNames()).toEqual(['intro-deck', 'card-news', 'promo-video'])
      expect(body().querySelectorAll('[data-testid="skill-pack-line"]').map((l) => l.textContent)).toEqual(['회사 소개서 한 줄', '카드뉴스 한 줄', '홍보 영상 한 줄', '자연스러운 글 한 줄'])
      expect(packRows().every((r) => r.querySelector('[data-testid="skill-pack-example"]'))).toBe(true)
      noOwnPart(m)
      expect(text(m, 'skills-primary')).toBe('회사 소개서·카드뉴스·홍보 영상 넣기')
      expect(m.get('skills-primary').className).toContain('w-full')
    } finally { await m.unmount() }
  })
})

describe('the press', () => {
  test('one install per pack with the names (general, then work); all in: one toast and onNext; the rows never move', async () => {
    computer()
    const m = await step()
    try {
      await tick(m, checkOf('humanizer')!)
      expect(text(m, 'skills-primary')).toBe(ko('welcome.skills.putN', { n: 4 }))
      await m.click('skills-primary')
      await m.until(() => events.includes('next'), 'on to the next step')
      expect(posts().map((c) => [c.key, c.body])).toEqual([
        ['POST /api/onboarding/packs/general/install', { skills: ['intro-deck', 'card-news', 'promo-video'] }],
        ['POST /api/onboarding/packs/work/install', { skills: ['humanizer'] }],
      ])
      expect(events).toEqual(['next'])
      expect(toasts()).toEqual([['success', ko('welcome.skills.installed', { n: 4 })]])
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
  test('that part says so with 다시; 나중에 하기 still works; 다시 brings the rows', async () => {
    computer()
    packsFail = 1
    const m = await step()
    try {
      await m.until(() => m.find('skill-packs-failed'), 'the note')
      expect(text(m, 'skill-packs-failed')).toContain(ko('skillPack.loadFailed'))
      expect(m.find('skill-packs')).toBeNull()
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
      expect(text(m, 'skill-example-source')).toBe(ko('skillPack.source.team', PRODUCT_KO))
      await key(viewer(m), 'Escape')
      // the cards: an image loading, then failing
      await m.click(exampleOf('card-news'))
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
      await key(viewer(m), 'Escape')
      // the text example, drawn in the page; English text: the invented company in English; the open-source origin
      await m.click(exampleOf('humanizer'))
      expect(viewer(m).getAttribute('data-state')).toBe('shown')
      expect(m.get('skill-example-body').getAttribute('data-kind')).toBe('text')
      expect(text(m, 'skill-example-body')).toContain('Our beans are fresh.')
      expect(m.get('skill-example-body').querySelector('strong')!.textContent).toBe('Before:')
      expect(text(m, 'skill-example-fictional')).toBe(ko('skillPack.fictional', { company: 'Example Coffee' }))
      expect(m.get('skill-example-source').getAttribute('data-kind')).toBe('adapted')
      expect(text(m, 'skill-example-source')).toContain(ko('skillPack.source.adapted', { ...PRODUCT_KO, author: 'Siqi Chen', project: 'humanizer', license: 'MIT' }))
      const link = m.get('skill-example-original')
      expect(link.getAttribute('href')).toBe('https://github.com/blader/humanizer')
      expect(link.getAttribute('target')).toBe('_blank')
      expect(link.getAttribute('rel')).toBe('noopener noreferrer')
      expect(link.textContent).toContain(ko('skillPack.source.original'))
      expect(body().querySelectorAll('a').map((a) => a.getAttribute('href'))).toEqual(['https://github.com/blader/humanizer'])
    } finally { await m.unmount() }
  })

  test('one example per open (FLOW-v6 §2.4): no stepping to the next row, the arrow keys do nothing; an image loads, then the invented company; Esc closes, the focus back on that row\'s 예시', async () => {
    const m = await rows()
    try {
      await m.click(exampleOf('card-news'))
      expect(m.find('skill-example-prev')).toBeNull()
      expect(m.find('skill-example-next')).toBeNull()
      expect(viewer(m).textContent).not.toContain('2/3')
      await key(viewer(m), 'ArrowRight')
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

  test('a Korean 자연스러운 글 reads that it grew from the team\'s own writing skill, with no link out', async () => {
    const m = await rows([kept('work', 'humanizer', '자연스러운 글', { source: { kind: 'team_writing' }, example: { kind: 'text', markdown: '예시 글' } })])
    try {
      await m.click(exampleOf('humanizer'))
      expect(m.get('skill-example-source').getAttribute('data-kind')).toBe('team_writing')
      expect(text(m, 'skill-example-source')).toBe(ko('skillPack.source.teamWriting', PRODUCT_KO))
      expect(m.find('skill-example-original')).toBeNull()
    } finally { await m.unmount() }
  })

  test('the examples that ship (예시커피 / Example Coffee): a picture of each visual result, the before → after text in the page; "예시를 준비하고 있어요" nowhere', async () => {
    for (const locale of ['ko', 'en'] as const) {
      const m = await rows(catalogOf().map((s) => ({ ...s, locale, example: packExample(locale, s.name) })))
      try {
        for (const name of ['intro-deck', 'card-news', 'promo-video']) {
          await m.click(exampleOf(name))
          const img = m.get('skill-example-image')
          expect(img.getAttribute('src')).toBe(`/skill-examples/${locale}/${name}.webp`)
          await act(async () => { img.dispatchEvent(new FakeEvent('load')) })
          expect(viewer(m).getAttribute('data-state')).toBe('shown')
          expect(text(m, 'skill-example-fictional')).toBe(ko('skillPack.fictional', { company: locale === 'ko' ? '예시커피' : 'Example Coffee' }))
          expect(viewer(m).textContent).not.toContain(ko('skillPack.preparing'))
          await key(viewer(m), 'Escape')
        }
        await m.click(exampleOf('humanizer'))
        expect(viewer(m).getAttribute('data-state')).toBe('shown')
        const shown = m.get('skill-example-body')
        expect(shown.getAttribute('data-kind')).toBe('text')
        // the draft quoted, then the rewrite and what changed; none of the front matter
        expect(shown.querySelector('blockquote')!.textContent).toContain(locale === 'ko' ? '이번 공지에서는' : 'In today\'s fast-paced world')
        expect(shown.querySelectorAll('strong').map((x) => x.textContent)).toEqual(expect.arrayContaining(locale === 'ko' ? ['전', '후', '바뀐 점'] : ['Before', 'After', 'What changed']))
        expect(shown.textContent).toContain('hello@coffee.example')
        expect(shown.textContent).not.toMatch(/skillHash|fictional/)
        expect(viewer(m).textContent).not.toContain(ko('skillPack.preparing'))
      } finally { await m.unmount() }
    }
  })
})

describe('the end of an own-skills check (walk M2)', () => {
  const HELD = '01900000-0000-7000-8000-0000000007b1'
  const held = () => ownShare({ id: HELD, status: 'checking', ai: 'pending' })
  const review = (stopped: string[], limit = 60) => mount(
    <MemoryRouter>
      <SkillShareReview share={held()} team="Acme" doneLabel="닫기" onDone={() => {}} onLater={() => {}} onStopped={() => stopped.push('stopped')} checkLimitMs={limit} />
    </MemoryRouter>,
  )

  test('Bring my skills waits at most SHARE_CHECK_LIMIT_MS (30 s); nothing is stopped before it', async () => {
    expect(SHARE_CHECK_LIMIT_MS).toBe(30_000)
    shares = [held()]
    const m = await review([], SHARE_CHECK_LIMIT_MS)
    try {
      await m.settle(50)
      expect(m.get('skill-review').getAttribute('data-status')).toBe('checking')
      expect(called(`POST /api/skill-shares/${HELD}/stop-check`)).toEqual([])
    } finally { await m.unmount() }
  })

  test('a check still running at the limit is ended (stop-check): the list with nothing ticked, "AI 없이 찾았어요"', async () => {
    shares = [held()]
    const m = await review([])
    try {
      expect(m.get('skill-review').getAttribute('data-status')).toBe('checking')
      await m.until(() => m.find('skill-review')?.getAttribute('data-status') === 'ready', 'the list')
      expect(called(`POST /api/skill-shares/${HELD}/stop-check`)).toHaveLength(1)
      expect(text(m, 'skill-review-no-ai')).toBe(ko('welcome.skills.noAi'))
      const checks = body().querySelectorAll('[data-testid="skill-check"]') as unknown as { checked: boolean }[]
      expect(checks.every((c) => !c.checked)).toBe(true)
      // nothing ticked: its primary cannot apply yet
      expect(m.get('skills-share').hasAttribute('disabled')).toBe(true)
    } finally { await m.unmount() }
  })

  test('a stop that fails says so with 다시 (the list keeps checking, 그만 찾기 still there); 다시 sends it again', async () => {
    shares = [held()]
    stopFail = 1
    const m = await review([])
    try {
      await m.until(() => m.find('skill-review')?.querySelector('[role="alert"]'), 'the error')
      expect(m.get('skill-review').getAttribute('data-status')).toBe('checking')
      expect(m.get('skill-review').querySelector('[role="alert"]')!.textContent).toContain('지금은 멈추지 못했어요')
      expect(m.find('skill-review-stop')).not.toBeNull()
      await m.click(retryIn(m.get('skill-review')))
      await m.until(() => m.find('skill-review')?.getAttribute('data-status') === 'ready', 'the list')
      expect(called(`POST /api/skill-shares/${HELD}/stop-check`)).toHaveLength(2)
      expect(m.get('skill-review').querySelector('[role="alert"]')).toBeNull()
    } finally { await m.unmount() }
  })
})

describe('내 스킬 가져오기 on Team skills (owners, admins)', () => {
  test('the sheet: pick a folder → the list with [팀에 넣기 · n개] and [닫기] (not 나중에 하기); 닫기 drops the list and closes', async () => {
    type Tree = { [name: string]: Tree | string }
    const dir = (name: string, tree: Tree): unknown => ({
      kind: 'directory', name,
      async getDirectoryHandle(n: string) { const v = tree[n]; if (v && typeof v === 'object') return dir(n, v); throw Object.assign(new Error('nf'), { name: 'NotFoundError' }) },
      async getFileHandle(n: string) { const v = tree[n]; if (typeof v === 'string') return { name: n, getFile: async () => new File([v], n) }; throw Object.assign(new Error('nf'), { name: 'NotFoundError' }) },
      async *entries() { for (const [k, v] of Object.entries(tree)) yield [k, { kind: typeof v === 'string' ? 'file' : 'directory' }] },
    })
    g.showDirectoryPicker = async () => dir('.claude', { skills: { 'weekly-report': { 'SKILL.md': '---\nname: weekly-report\ndescription: 주간 업무 보고\n---\n# 주간 업무 보고\n' } } })
    let closed = 0
    const m = await mount(<MemoryRouter><BringSkillsSheet team="Acme" onClose={() => { closed++ }} /></MemoryRouter>)
    try {
      await m.click('bring-find')
      await m.until(() => m.find('skill-review')?.getAttribute('data-status') === 'ready', 'the list')
      expect(text(m, 'skills-share')).toContain(ko('skills.catalog.install', { n: 1 }))
      expect(text(m, 'skills-later')).toBe(ko('common.close'))
      await m.click('skills-later')
      expect(closed).toBe(1)
      expect(called(`POST /api/skill-shares/${OWN}/dismiss`)).toHaveLength(1)
    } finally { await m.unmount() }
  })
})
