// The Team skills page under its lists (docs/DECISIONS.md "W6"; FLOW-v6 §4.2; components/AvailableSkills.tsx). For
// owners and admins: the kept skills the team does not have, folded in one line ("{product}가 준비한 스킬 · N개 더"), open
// with nothing checked; [팀에 넣기 · n개] installs the checked ones, one request per pack (POST
// /api/onboarding/packs/:id/install with `skills`), says what went in, and the rows that went in leave the fold; a name
// taken or a request that failed is said under the rows (다시 for only the failed ones). Hidden while the search box has
// text, absent when nothing is missing, a note with 다시 when the catalog does not load; members never read it. Then
// "내 스킬 가져오기": owners and admins open the bring sheet, members the contribute sheet; a phone reads one plain line.
// The empty page's one install button ("추천 스킬 4개 넣기") is gone.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import type { PackCatalogSkill, SkillInfo } from '@mycel/shared/api'
import { translate, useLocaleStore, type MessageKey } from '../../src/i18n'
import { AvailableSkillsList } from '../../src/components/AvailableSkills'
import { useSession } from '../../src/store/session'
import { useUi } from '../../src/store/ui'
import { FakeElement, installDom, mount, removeDom, type Mounted } from './dom-host'

const ko = (k: MessageKey, p?: Record<string, string | number>) => translate('ko', k, p)
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const kept = (pack: 'general' | 'work', name: string, title: string, inTeam = false): PackCatalogSkill => ({
  pack, name, path: `skills/${pack}/${name}/SKILL.md`, title, description: `${title} 한 줄`, inTeam, visual: pack === 'general', example: null, locale: 'ko', source: { kind: 'team' },
})
const catalogOf = (inTeam: string[] = []) => [
  kept('general', 'intro-deck', '회사 소개서'), kept('general', 'card-news', '카드뉴스'), kept('general', 'promo-video', '홍보 영상'), kept('work', 'humanizer', '자연스러운 글'),
].map((s) => ({ ...s, inTeam: inTeam.includes(s.name) }))

// ---- the fake server: the catalog, the installs (what went in is in the team from then on)
let catalog = catalogOf()
let packsFail = 0
/** an install's answer per pack (default: every named skill created) */
let installs: Partial<Record<'general' | 'work', (names: string[]) => Response>> = {}
let calls: { key: string; body: any }[] = []
const called = (key: string) => calls.filter((c) => c.key === key)
const SKILLS: SkillInfo[] = [{ path: 'skills/weekly/SKILL.md', name: 'weekly', description: 'Friday team report' }]

const g = globalThis as Record<string, unknown>
const realFetch = globalThis.fetch
const before = { locale: useLocaleStore.getState().locale, status: useSession.getState().status }
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'ko' })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const path = String(input).split('?')[0]!
    const key = `${method} ${path}`
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({ key, body })
    if (key === 'GET /api/onboarding/packs') {
      if (packsFail-- > 0) return json(500, { error: { code: 'internal', message: '지금은 불러오지 못했어요' } })
      return json(200, { skills: catalog, profile: true })
    }
    const m = /^POST \/api\/onboarding\/packs\/(general|work)\/install$/.exec(key)
    if (m) {
      const id = m[1] as 'general' | 'work'
      const r = installs[id]?.(body.skills) ?? json(200, { pack: id, locale: 'ko', skills: body.skills.map((name: string) => ({ name, path: `skills/${id}/${name}/SKILL.md`, status: 'created' })) })
      if (r.ok) {
        const out = await r.clone().json() as { skills: { name: string; status: string }[] }
        const went = out.skills.filter((s) => s.status !== 'blocked').map((s) => s.name)
        catalog = catalog.map((s) => (went.includes(s.name) ? { ...s, inTeam: true } : s))
      }
      return r
    }
    return json(404, { error: { code: 'not_found', message: `no route ${key}` } })
  }) as unknown as typeof fetch
})
afterEach(() => {
  catalog = catalogOf()
  packsFail = 0
  installs = {}
  calls = []
  useUi.setState({ toasts: [] })
  delete g.showDirectoryPicker
  g.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
})
afterAll(() => {
  globalThis.fetch = realFetch
  useLocaleStore.setState({ locale: before.locale })
  useSession.setState({ status: before.status })
  removeDom()
})

const as = (role: 'owner' | 'admin' | 'member') => useSession.setState({ status: { kind: 'signed-in', me: { user: { id: 'olga', role }, team: { name: 'Acme', defaultLocale: 'ko' } } } } as never)
/** a computer whose browser picks folders (Chrome: the folder window) */
const computer = () => { g.showDirectoryPicker = async () => { throw Object.assign(new Error('closed'), { name: 'AbortError' }) } }
const phoneWidth = () => { g.matchMedia = (q: string) => ({ matches: q.includes('767.98'), addEventListener() {}, removeEventListener() {} }) }
const page = (items: SkillInfo[] = SKILLS, query?: string) => mount(<MemoryRouter><AvailableSkillsList items={items} query={query} /></MemoryRouter>)
const body = () => (globalThis.document as unknown as { body: FakeElement }).body
const rowNames = () => body().querySelectorAll('[data-testid="skill-pack-row"]').map((r) => r.getAttribute('data-name'))
const rowOf = (name: string) => body().querySelectorAll('[data-testid="skill-pack-row"]').find((r) => r.getAttribute('data-name') === name)!
const checkOf = (name: string) => rowOf(name).querySelector('[data-testid="skill-pack-check"]')! as FakeElement & { checked: boolean }
/** a browser checks a box before the click's listeners run, past React's value tracker (this small DOM does not) */
const tick = async (m: Mounted, el: FakeElement) => {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'checked')!.set!.call(el, !(el as unknown as { checked: boolean }).checked)
  await m.click(el)
}
const toasts = () => useUi.getState().toasts.map((t) => [t.level, t.text])

describe('the kept skills the team lacks (owners and admins)', () => {
  test('one folded line counts them; open, nothing is checked; [팀에 넣기 · n개] installs the checked ones per pack, says so, and they leave the fold; 접기 folds it', async () => {
    as('owner')
    catalog = catalogOf(['intro-deck'])
    const m = await page()
    try {
      await m.until(() => m.find('skill-catalog-toggle'), 'the fold')
      expect(m.get('skill-catalog-toggle').textContent).toBe(ko('skills.catalog.more', { n: 3 }))
      expect(m.get('skill-catalog-toggle').getAttribute('aria-expanded')).toBe('false')
      expect(rowNames()).toEqual([])
      // under the lists, not in them
      expect(m.get('skill-list').querySelector('[data-testid="skill-catalog"]')).toBeNull()
      await m.click('skill-catalog-toggle')
      expect(m.get('skill-catalog-toggle').getAttribute('aria-expanded')).toBe('true')
      // the team's own (회사 소개서) is not offered; nothing checked even with a company profile saved
      expect(rowNames()).toEqual(['card-news', 'promo-video', 'humanizer'])
      expect(rowNames().map((n) => checkOf(n!).checked)).toEqual([false, false, false])
      expect(rowOf('card-news').querySelector('[data-testid="skill-pack-line"]')!.textContent).toBe('카드뉴스 한 줄')
      expect(m.get('skill-catalog-install').hasAttribute('disabled')).toBe(true)
      expect(m.get('skill-catalog-install').textContent).toBe(ko('skills.catalog.install', { n: 0 }))
      await tick(m, checkOf('card-news'))
      await tick(m, checkOf('humanizer'))
      expect(m.get('skill-catalog-install').textContent).toBe(ko('skills.catalog.install', { n: 2 }))
      expect(called('POST /api/onboarding/packs/general/install')).toEqual([])
      await m.click('skill-catalog-install')
      await m.until(() => toasts().length > 0, 'the toast')
      expect(calls.filter((c) => c.key.startsWith('POST')).map((c) => [c.key, c.body])).toEqual([
        ['POST /api/onboarding/packs/general/install', { skills: ['card-news'] }],
        ['POST /api/onboarding/packs/work/install', { skills: ['humanizer'] }],
      ])
      expect(toasts()).toEqual([['success', ko('skillPack.installed', { n: 2 })]])
      // the catalog is read again (the team skills changed): what went in leaves the fold
      await m.until(() => m.get('skill-catalog-toggle').textContent === ko('skills.catalog.more', { n: 1 }), 'the fold counted again')
      expect(called('GET /api/onboarding/packs')).toHaveLength(2)
      expect(rowNames()).toEqual(['promo-video'])
      await m.click('skill-catalog-fold')
      expect(rowNames()).toEqual([])
      expect(m.get('skill-catalog-toggle').getAttribute('aria-expanded')).toBe('false')
    } finally { await m.unmount() }
  })

  test('a name taken: the row says so and the toast warns; a pack whose request failed offers 다시 for only its skills', async () => {
    as('admin')
    installs = {
      general: (names) => json(200, { pack: 'general', locale: 'ko', skills: names.map((name) => (name === 'promo-video'
        ? { name, path: `skills/general/${name}/SKILL.md`, status: 'blocked', sameNameAs: 'skills/promo-video/SKILL.md' }
        : { name, path: `skills/general/${name}/SKILL.md`, status: 'created' })) }),
      work: () => json(500, { error: { code: 'internal', message: '지금은 넣지 못했어요' } }),
    }
    const m = await page()
    try {
      await m.until(() => m.find('skill-catalog-toggle'), 'the fold')
      await m.click('skill-catalog-toggle')
      for (const n of ['card-news', 'promo-video', 'humanizer']) await tick(m, checkOf(n))
      await m.click('skill-catalog-install')
      await m.until(() => m.find('skill-pack-failed'), 'the notes')
      expect(toasts()).toEqual([['warn', ko('skillPack.installed', { n: 1 })]])
      expect(m.get('skill-pack-taken').textContent).toBe(ko('skillPack.taken', { n: 1 }))
      expect(rowOf('promo-video').getAttribute('data-state')).toBe('out')
      expect(rowOf('promo-video').textContent).toContain(ko('skillPack.takenOne'))
      expect(m.get('skill-pack-failed').textContent).toContain('지금은 넣지 못했어요')
      // the failed one stays checked
      expect(checkOf('humanizer').checked).toBe(true)
      useUi.setState({ toasts: [] })
      installs.work = undefined
      const retry = m.get('skill-pack-failed').querySelectorAll('button').find((b) => b.textContent === ko('common.retry'))!
      await m.click(retry)
      await m.until(() => toasts().length > 0, 'the toast after 다시')
      expect(called('POST /api/onboarding/packs/work/install').map((c) => c.body)).toEqual([{ skills: ['humanizer'] }, { skills: ['humanizer'] }])
      expect(called('POST /api/onboarding/packs/general/install')).toHaveLength(1)
      expect(toasts()).toEqual([['success', ko('skillPack.installed', { n: 1 })]])
      await m.until(() => !m.find('skill-pack-failed'), 'the failure gone')
    } finally { await m.unmount() }
  })

  test('the empty page has it under its line; hidden while the search box has text; absent when nothing is missing', async () => {
    as('owner')
    let m = await page([])
    try {
      await m.until(() => m.find('skill-catalog-toggle'), 'the fold under the empty page')
      expect(m.get('skill-catalog-toggle').textContent).toBe(ko('skills.catalog.more', { n: 4 }))
      expect(m.find('skill-pack-install')).toBeNull()
      expect(m.container.textContent).toContain(ko('skills.noSkills'))
    } finally { await m.unmount() }
    calls = []
    for (const q of ['week', 'nothing like this']) {
      m = await page(SKILLS, q)
      try {
        await m.settle(30)
        expect(m.find('skill-catalog')).toBeNull()
        expect(called('GET /api/onboarding/packs')).toEqual([])
      } finally { await m.unmount() }
    }
    catalog = catalogOf(['intro-deck', 'card-news', 'promo-video', 'humanizer'])
    m = await page()
    try {
      await m.until(() => called('GET /api/onboarding/packs').length > 0, 'the catalog read')
      await m.settle(30)
      expect(m.find('skill-catalog')).toBeNull()
      expect(m.find('skill-catalog-failed')).toBeNull()
    } finally { await m.unmount() }
  })

  test('the catalog does not load: one note with 다시, which reads it again', async () => {
    as('owner')
    packsFail = 1
    const m = await page()
    try {
      await m.until(() => m.find('skill-catalog-failed'), 'the note')
      expect(m.get('skill-catalog-failed').textContent).toContain(ko('skillPack.loadFailed'))
      expect(m.find('skill-catalog-toggle')).toBeNull()
      await m.click(m.get('skill-catalog-failed').querySelector('button')!)
      await m.until(() => m.find('skill-catalog-toggle'), 'the fold')
      expect(m.find('skill-catalog-failed')).toBeNull()
      expect(called('GET /api/onboarding/packs')).toHaveLength(2)
    } finally { await m.unmount() }
  })

  test('members never read the catalog and see no fold', async () => {
    as('member')
    computer()
    const m = await page()
    try {
      await m.until(() => m.find('skill-bring'), 'the bring line')
      await m.settle(30)
      expect(called('GET /api/onboarding/packs')).toEqual([])
      expect(m.find('skill-catalog')).toBeNull()
    } finally { await m.unmount() }
  })
})

describe('내 스킬 가져오기, by role', () => {
  test('on a computer: owners and admins open the bring sheet (they apply), members the contribute sheet (they suggest)', async () => {
    computer()
    for (const role of ['owner', 'admin'] as const) {
      as(role)
      const m = await page()
      try {
        await m.until(() => m.find('skill-bring'), 'the bring line')
        expect(m.get('skill-bring').getAttribute('data-role')).toBe('admin')
        expect(m.get('skill-bring').textContent).toBe(ko('skills.catalog.bring'))
        expect(m.find('skill-bring-phone')).toBeNull()
        await m.click('skill-bring')
        await m.until(() => m.find('bring-sheet'), 'the bring sheet')
        expect(m.get('bring-sheet').getAttribute('data-state')).toBe('pick')
        expect(m.find('bring-find')).not.toBeNull()
        expect(m.find('contribute-sheet')).toBeNull()
      } finally { await m.unmount() }
    }
    as('member')
    const m = await page()
    try {
      await m.until(() => m.find('skill-bring'), 'the bring line')
      expect(m.get('skill-bring').getAttribute('data-role')).toBe('member')
      await m.click('skill-bring')
      await m.until(() => m.find('contribute-sheet'), 'the contribute sheet')
      expect(m.find('bring-sheet')).toBeNull()
    } finally { await m.unmount() }
  })

  test('on a phone (or a browser that cannot pick folders): one plain line, no button, for every role', async () => {
    for (const setup of [() => { computer(); phoneWidth() }, () => {}]) {
      for (const role of ['owner', 'member'] as const) {
        setup()
        as(role)
        const m = await page()
        try {
          await m.until(() => m.find('skill-bring-phone'), 'the plain line')
          expect(m.get('skill-bring-phone').textContent).toBe(ko('skills.catalog.bringPhone'))
          expect(m.get('skill-bring-phone').localName).toBe('p')
          expect(m.find('skill-bring')).toBeNull()
        } finally { await m.unmount(); delete g.showDirectoryPicker }
      }
    }
  })
})
