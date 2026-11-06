// An intro deck being built (docs/DECISIONS.md "D2", round 2; lib/deckProgress.ts, store/deckBuilds.ts,
// components/chat/DeckProgress.tsx): the builds a chat keeps from deck.progress events and the list (an older picture
// never replaces a newer one), the live line in the screen's language with Korean particles by the last syllable, the
// four steps and their times, the chat's block in each state (reading, slides, review, done folded, stopped), the
// panel opening by itself on a computer only, and the "done" toast only when the chat is not on screen.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { ReactNode } from 'react'
import { DECK_ARTIFACT_KEY, DeckBuild as DeckBuildSchema, uuidv7, type DeckBuild, type DeckBuildSlide, type Locale, type Step } from '@mycel/shared/api'
import { format, koEul, translate, useLocaleStore, type MessageKey, type Params } from '../../src/i18n'
import { deckRows, mergeBuild, nowLine, readCounts, readLine, readsForDeck, runsDeckSkill, showsBuild, tierMinutes, tileState, BUILDS_KEPT } from '../../src/lib/deckProgress'
import DeckProgress from '../../src/components/chat/DeckProgress'
import { Toaster } from '../../src/components/ui'
import { useDeckBuilds } from '../../src/store/deckBuilds'
import { useChats } from '../../src/store/chats'
import { useUi } from '../../src/store/ui'
import { installDom, mount, removeDom } from './dom-host'

const CHAT = uuidv7()
const T0 = Date.parse('2026-11-06T01:00:00.000Z')
const iso = (s: number) => new Date(T0 + s * 1000).toISOString()
const ko = (k: MessageKey, p?: Params) => translate('ko', k, p)
const en = (k: MessageKey, p?: Params) => translate('en', k, p)

const PLAN: [DeckBuildSlide['kind'], string, DeckBuildSlide['figure'], boolean][] = [
  ['cover', '표지', null, true], ['about', '회사 소개', 'hub', false], ['needs', '고객의 고민', 'merge', false], ['offer', '하는 일', 'layers', false],
  ['numbers', '숫자', 'donut', false], ['products', '제품', 'grid', false], ['process', '일하는 방식', 'flow', false], ['proof', '고객의 말', null, false],
  ['contact', '마무리', null, false],
]
/** A build `done` slides in (the next one working), in a phase; times: outline at 0:35, slides at 2:00, end at 2:34. */
function build(o: Partial<DeckBuild> & { done?: number } = {}): DeckBuild {
  const done = o.done ?? 4
  const phase = o.phase ?? 'slides'
  const all = phase === 'review' || phase === 'done'
  const b: DeckBuild = {
    id: o.id ?? 'b1', chatId: CHAT, messageId: o.messageId ?? 'm1', title: 'Acme 회사 소개서', phase,
    slides: PLAN.map(([kind, section, figure, picture], i) => ({ kind, section, figure, picture, status: all || i < done ? 'done' : i === done ? 'working' : 'planned', rev: all || i < done ? 1 : 0 })),
    current: phase === 'slides' ? done : null,
    startedAt: iso(0), outlineAt: iso(35), slidesAt: all ? iso(120) : null, finishedAt: phase === 'done' || phase === 'failed' ? iso(154) : null,
    artifactId: phase === 'done' ? 'art1' : null, thumbs: true,
  }
  const { done: _d, ...rest } = o
  return DeckBuildSchema.parse({ ...b, ...rest })
}
/** a longer budget's build while it reads the material: no outline, no slides yet */
const reading = (o: Partial<DeckBuild> = {}) => build({ phase: 'reading', outlineAt: null, current: null, slides: [], tier: 'standard', ...o })
const fetchStep = (id: string, url: string): Step => ({ id, kind: 'tool', tool: 'web_fetch', label: `웹 페이지 가져오기 · ${url}`, status: 'ok', startedAt: iso(3), endedAt: iso(4) })
const searchStep = (id: string): Step => ({ id, kind: 'web_search', tool: 'WebSearch', label: '웹 검색 "acme"', status: 'ok', startedAt: iso(3), endedAt: iso(4) })
const read: Step = { id: 'r1', kind: 'tool', tool: 'read', label: 'read', status: 'ok', startedAt: iso(2), endedAt: iso(21) }
const deckStep = (id: string, status: Step['status'] = 'ok'): Step => ({ id, kind: 'tool', tool: 'intro_deck', label: '회사 소개서 만들기 · Acme 회사 소개서', status, startedAt: iso(40), endedAt: iso(45) })

const setLocale = (l: Locale) => Object.assign(useLocaleStore.getInitialState(), { locale: l })
const localeBefore = useLocaleStore.getInitialState().locale
afterEach(() => setLocale(localeBefore))

describe('Korean particles after a filled-in value', () => {
  test('(을)를 by the last syllable: 을 after a final consonant, 를 after a vowel; digits as read; Latin keeps both', () => {
    expect(['숫자', '제품', '회사 소개', '연혁', '고객의 말'].map(koEul)).toEqual(['를', '을', '를', '을', '을'])
    expect(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'].map(koEul)).toEqual(['을', '을', '를', '을', '를', '를', '을', '을', '을', '를'])
    expect(koEul('Numbers')).toBe('(을)를')
    expect(format('{a}(을)를 {b}(으)로', { a: '숫자', b: '도넛 차트' }, 'ko')).toBe('숫자를 도넛 차트로')
    expect(format('{a}(을)를 {b}(으)로', { a: '하는 일', b: '층 도식' }, 'ko')).toBe('하는 일을 층 도식으로')
    // other languages carry no such marker; an unfilled one stays as written
    expect(format('{a}(을)를', { a: 'x' }, 'en')).toBe('x(을)를')
    expect(format('{a}(을)를', {}, 'ko')).toBe('{a}(을)를')
  })
})

describe('the live line', () => {
  test('what is being made now, by the slide\'s figure, picture or kind, with the right particles', () => {
    expect(nowLine(build({ done: 4 }), ko)).toBe('5장 · 숫자를 도넛 차트로 그리는 중')
    expect(nowLine(build({ done: 3 }), ko)).toBe('4장 · 하는 일을 층 도식으로 그리는 중')
    expect(nowLine(build({ done: 5 }), ko)).toBe('6장 · 제품을 아이콘 목록으로 그리는 중')
    expect(nowLine(build({ done: 6 }), ko)).toBe('7장 · 일하는 방식을 흐름도로 그리는 중')
    expect(nowLine(build({ done: 2 }), ko)).toBe('3장 · 고객의 고민을 모으기로 그리는 중')
    // the cover on a website picture, and without one; an opening or the closing on a drawn ground; a slide of words
    expect(nowLine(build({ done: 0 }), ko)).toBe('1장 · 홈페이지 사진에 브랜드색 입히는 중')
    const plain = build({ done: 0 })
    plain.slides[0]!.picture = false
    expect(nowLine(plain, ko)).toBe('1장 · 표지 배경 그리는 중')
    expect(nowLine(build({ done: 8 }), ko)).toBe('9장 · 마무리 배경 그리는 중')
    expect(nowLine(build({ done: 7 }), ko)).toBe('8장 · 고객의 말 정리하는 중')
    expect(nowLine(build({ phase: 'review' }), ko)).toBe('다 만든 장을 다시 보는 중')
    expect(nowLine(build({ phase: 'done' }), ko)).toBeNull()
    expect(nowLine(build({ outlineAt: null, current: null, done: 0 }), ko)).toBeNull()
  })

  test('in the language on screen (the section names stay as the outline wrote them)', () => {
    expect(nowLine(build({ done: 4 }), en)).toBe('Slide 5 · 숫자: drawing the donut chart')
    expect(nowLine(build({ done: 0 }), en)).toBe('Slide 1 · putting the brand color on a website photo')
    for (const l of ['id', 'ja', 'es'] as const) expect(nowLine(build({ done: 4 }), (k, p) => translate(l, k, p))).toContain('숫자')
  })

  test('the deck skill as the question runs it ("/intro-deck …", any case); only a streaming answer reads for it', () => {
    expect(runsDeckSkill('/intro-deck 우리 회사 소개서 만들어 줘')).toBe(true)
    expect(runsDeckSkill('/Intro-Deck\n누구에게 보낼까요: 제조업 고객사')).toBe(true)
    expect(runsDeckSkill('/intro-decks 다른 것')).toBe(false)
    expect(runsDeckSkill('회사 소개서 만들어 줘')).toBe(false)
    expect(readsForDeck({ role: 'assistant', status: 'streaming' }, '/intro-deck x')).toBe(true)
    expect(readsForDeck({ role: 'assistant', status: 'done' }, '/intro-deck x')).toBe(false)
  })
})

describe('the four steps', () => {
  const rows = (b: DeckBuild | null, live = true, steps: Step[] = [read]) => deckRows(b, steps, T0, b ? (b.phase === 'done' ? 'done' : b.phase === 'failed' || !live ? 'stopped' : 'live') : live ? 'live' : 'stopped', ko)
  const view = (r: ReturnType<typeof rows>) => r.map((x) => [x.label, x.state, x.right, x.now])

  test('reading the material: the first step runs, nothing has a time yet', () => {
    expect(view(rows(null, true, []))).toEqual([
      ['홈페이지와 자료 살펴보기', 'running', null, null],
      ['구성 짜기', 'todo', null, null],
      ['한 장씩 만들기', 'todo', null, null],
      ['다시 보고 다듬기', 'todo', null, null],
    ])
  })

  test('the slides: reading and planning done with their times (split where the reads ended), k / N and the live line', () => {
    expect(view(rows(build({ done: 4 })))).toEqual([
      ['홈페이지와 자료 살펴보기', 'done', '0:21', null],
      ['구성 짜기 · 9장', 'done', '0:14', null],
      ['한 장씩 만들기', 'running', '5 / 9', '5장 · 숫자를 도넛 차트로 그리는 중'],
      ['다시 보고 다듬기', 'todo', null, null],
    ])
    // the deck tool's own steps are no reads; with no reads at all, the outline has no time of its own
    expect(view(rows(build({ done: 4 }), true, [deckStep('d1')])).slice(0, 2)).toEqual([['홈페이지와 자료 살펴보기', 'done', '0:35', null], ['구성 짜기 · 9장', 'done', null, null]])
  })

  test('the review, then all done with each step\'s time', () => {
    expect(view(rows(build({ phase: 'review' }))).slice(2)).toEqual([['한 장씩 만들기', 'done', '1:25', null], ['다시 보고 다듬기', 'running', null, '다 만든 장을 다시 보는 중']])
    expect(view(rows(build({ phase: 'done' }))).map((x) => [x[1], x[2]])).toEqual([['done', '0:21'], ['done', '0:14'], ['done', '1:25'], ['done', '0:34']])
  })

  test('failed, or the answer ended before the end: the step it was on says stopped, the rest are not done', () => {
    expect(view(rows(build({ phase: 'failed', done: 3, slidesAt: null }))).slice(2).map((x) => x[1])).toEqual(['stopped', 'todo'])
    expect(view(rows(build({ done: 3 }), false)).slice(2)).toEqual([['한 장씩 만들기', 'stopped', '4 / 9', null], ['다시 보고 다듬기', 'todo', null, null]])
    expect(view(rows(null, false, []))[0]![1]).toBe('stopped')
  })

  test('the longer budgets: reading is still the first step, with what the extra time reads under it', () => {
    expect(view(rows(reading({ read: { pages: 9, articles: 0 } })))).toEqual([
      ['홈페이지와 자료 살펴보기', 'running', null, '홈페이지 9쪽 읽는 중'],
      ['구성 짜기', 'todo', null, null],
      ['한 장씩 만들기', 'todo', null, null],
      ['다시 보고 다듬기', 'todo', null, null],
    ])
    expect(readLine(reading({ read: { pages: 9, articles: 3 } }), [], ko)).toBe('홈페이지 9쪽 · 기사 3건 확인 중')
    expect(readLine(reading({ read: { pages: 9, articles: 3 } }), [], en)).toBe('Checking 9 website pages · 3 articles')
    expect(readLine(reading({ read: { pages: 1, articles: 0 } }), [], en)).toBe('Reading 1 website page')
    // not counted by the server yet: the answer's own steps (searches; the site fetched most is the company's own)
    const steps = [fetchStep('f1', 'https://www.acme.example/about'), fetchStep('f2', 'https://acme.example/products'), fetchStep('f3', 'https://news.example/a/1'), searchStep('w1'), searchStep('w2')]
    expect(readCounts(steps)).toEqual({ pages: 2, articles: 1, searches: 2 })
    expect(readLine(reading(), steps, ko)).toBe('홈페이지 2쪽 · 검색 2건 · 기사 1건 확인 중')
    expect(readLine(null, [read], ko)).toBeNull()
    // the quick budget reads only what was saved at setup: no line
    expect(view(rows(null, true, [read]))[0]![3]).toBeNull()
    // past the reading, the line goes
    expect(view(rows(build({ done: 4, read: { pages: 9, articles: 3 } })))[0]![3]).toBeNull()
  })

  test('the note says the budget\'s usual time', () => {
    expect([tierMinutes(null), tierMinutes(build()), tierMinutes(build({ tier: 'quick' })), tierMinutes(build({ tier: 'standard' })), tierMinutes(build({ tier: 'deep' }))]).toEqual([5, 5, 3, 5, 10])
    expect(ko('deck.progress.note', { min: 5 })).toBe('보통 5분 안에 끝나요. 다른 메뉴를 써도 돼요. 다 되면 알려 드릴게요.')
  })

  test('tiles: done, the one being made (only while it is made), planned', () => {
    const b = build({ done: 4 })
    expect(b.slides.map((_, i) => tileState(b, i, 'live'))).toEqual(['done', 'done', 'done', 'done', 'current', 'planned', 'planned', 'planned', 'planned'])
    expect(tileState(b, 4, 'stopped')).toBe('planned')
  })
})

describe('the builds of a chat', () => {
  test('newest first; an older picture of a build (a late event, a list computed before an event) never replaces a newer one', () => {
    let list = mergeBuild([], build({ done: 2 }))
    list = mergeBuild(list, build({ done: 4 }))
    expect(list[0]!.slides.filter((s) => s.status === 'done')).toHaveLength(4)
    // late: 3 done after 4 done; a slides picture after the review; anything after done
    expect(mergeBuild(list, build({ done: 3 }))).toBe(list)
    const review = mergeBuild(list, build({ phase: 'review' }))
    expect(mergeBuild(review, build({ done: 8 }))).toBe(review)
    // reading comes before the outline
    expect(mergeBuild(list, reading())).toBe(list)
    const done = mergeBuild(review, build({ phase: 'done' }))
    expect(mergeBuild(done, build({ phase: 'review' }))).toBe(done)
    // the same step again, or a slide marked working after the one before is done: taken
    expect(mergeBuild(list, build({ done: 4 }))).not.toBe(list)
    // a later build goes first; at most ten are kept
    const next = mergeBuild(done, build({ id: 'b2', startedAt: iso(600), outlineAt: null, current: null, done: 0 }))
    expect(next.map((b) => b.id)).toEqual(['b2', 'b1'])
    let many: readonly DeckBuild[] = []
    for (let i = 0; i < 12; i++) many = mergeBuild(many, build({ id: `x${i}`, startedAt: iso(i * 1000) }))
    expect(many).toHaveLength(BUILDS_KEPT)
    expect(many[0]!.id).toBe('x11')
  })

  test('the panel shows the build while it is made, until the saved deck is listed, and a stopped one only with no deck', () => {
    const v = (id: string, s: number) => ({ id, createdAt: iso(s) })
    expect(showsBuild(build(), 'live', [])).toBe(true)
    expect(showsBuild(build(), 'live', [v('old', -600)])).toBe(true)
    expect(showsBuild(build(), 'live', [v('newer', 60)])).toBe(false)
    expect(showsBuild(build({ phase: 'done' }), 'done', [v('old', -600)])).toBe(true)
    expect(showsBuild(build({ phase: 'done' }), 'done', [v('old', -600), v('art1', 150)])).toBe(false)
    expect(showsBuild(build({ phase: 'failed' }), 'stopped', [])).toBe(true)
    expect(showsBuild(build({ phase: 'failed' }), 'stopped', [v('old', -600)])).toBe(false)
  })
})

describe('the store', () => {
  const realFetch = globalThis.fetch
  const g = globalThis as Record<string, unknown>
  let saved: Record<string, PropertyDescriptor | undefined> = {}
  const stub = (name: string, value: unknown) => {
    if (!(name in saved)) saved[name] = Object.getOwnPropertyDescriptor(globalThis, name)
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
  }
  let notified: { title: string; body: string }[] = []
  const live = useLocaleStore.getState().locale
  beforeEach(() => {
    saved = {}
    notified = []
    useDeckBuilds.getState().reset()
    useChats.setState({ autoOpen: null, buildOpened: {} })
    useUi.setState({ toasts: [] })
    useLocaleStore.setState({ locale: 'ko' })
  })
  afterAll(() => useLocaleStore.setState({ locale: live }))
  afterEach(() => {
    for (const [name, d] of Object.entries(saved)) {
      if (d) Object.defineProperty(globalThis, name, d)
      else delete g[name]
    }
    globalThis.fetch = realFetch
    useDeckBuilds.getState().reset()
    useChats.setState({ autoOpen: null, buildOpened: {}, liveArtifacts: {}, artifactsRev: {} })
    useUi.setState({ toasts: [] })
  })
  const ev = (b: DeckBuild) => useDeckBuilds.getState().handleEvent(CHAT, b)
  const elsewhere = (path: string, focused = true) => {
    stub('location', { pathname: path, origin: 'http://team.localhost', href: `http://team.localhost${path}` })
    stub('document', { hasFocus: () => focused, hidden: false })
    stub('mycelDesktop', { bridgeVersion: 1, notify: (n: { title: string; body: string }) => notified.push(n) })
  }

  test('events in order and out of order: the newest picture stays', () => {
    elsewhere(`/c/${CHAT}`)
    ev(build({ done: 1 }))
    ev(build({ done: 3 }))
    ev(build({ done: 2 }))
    expect(useDeckBuilds.getState().builds[CHAT]![0]!.slides.filter((s) => s.status === 'done')).toHaveLength(3)
  })

  test('the list fills a chat opened later, and does not undo an event that came while it was asked for', async () => {
    elsewhere(`/c/${CHAT}`)
    let answer: (r: Response) => void = () => {}
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      expect(new URL(String(input), 'http://team.localhost').pathname).toBe('/api/intro-decks/builds')
      return new Promise<Response>((r) => { answer = r })
    }) as typeof fetch
    const loading = useDeckBuilds.getState().load(CHAT)
    ev(build({ done: 5 }))
    answer(new Response(JSON.stringify({ builds: [build({ done: 3 }), build({ id: 'b0', startedAt: iso(-3600), phase: 'done', messageId: 'm0' })] }), { headers: { 'content-type': 'application/json' } }))
    await loading
    const list = useDeckBuilds.getState().builds[CHAT]!
    expect(list.map((b) => b.id)).toEqual(['b1', 'b0'])
    expect(list[0]!.slides.filter((s) => s.status === 'done')).toHaveLength(5)
  })

  test('a chat\'s messages with a step of the deck tool ask for its builds once; other chats never do', async () => {
    const asked: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      asked.push(new URL(String(input), 'http://team.localhost').search)
      return new Response(JSON.stringify({ builds: [] }), { headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    const other = uuidv7()
    const m = (id: string, steps: Step[]) => ({ id, chatId: CHAT, parentId: null, author: null, content: '', attachments: [], steps, status: 'done' as const, error: null, turnId: null, engine: null, model: null, files: null, usage: null, createdAt: iso(0), branch: { index: 0, count: 1, siblingIds: [id] }, role: 'assistant' as const })
    const threadsBefore = useChats.getState().threads
    try {
      useChats.setState({ threads: { [other]: { messages: [m('a', [read])], nextCursor: null, stale: false } } })
      useChats.setState({ threads: { ...useChats.getState().threads, [CHAT]: { messages: [m('b', [read, deckStep('d1')])], nextCursor: null, stale: false } } })
      useChats.setState({ threads: { ...useChats.getState().threads, [CHAT]: { messages: [m('b', [read, deckStep('d1'), deckStep('d2')])], nextCursor: null, stale: false } } })
      await new Promise((r) => setTimeout(r, 10))
      expect(asked).toEqual([`?chatId=${CHAT}`])
    } finally { useChats.setState({ threads: threadsBefore }) }
  })

  test('the first event opens the deck panel by itself on a computer, once; its saved deck does not open it again', () => {
    elsewhere(`/c/${CHAT}`)
    stub('window', { matchMedia: () => ({ matches: false }) })
    ev(build({ outlineAt: iso(35), done: 0 }))
    expect(useChats.getState().autoOpen).toMatchObject({ chatId: CHAT, key: DECK_ARTIFACT_KEY })
    expect(useChats.getState().buildOpened).toEqual({ [CHAT]: 'm1' })
    useChats.setState({ autoOpen: null })
    ev(build({ done: 1 }))
    expect(useChats.getState().autoOpen).toBeNull()
    // the deck saved by that answer: no second opening (the person may have closed it); another answer's deck opens
    const saved = (messageId: string, key = DECK_ARTIFACT_KEY) => useChats.getState().handleEvent({ type: 'artifact.updated', seq: 1, at: Date.now(), data: { chatId: CHAT, messageId, key, type: 'html', title: 'Acme 회사 소개서', status: 'done', artifact: { id: uuidv7(), chatId: CHAT, messageId, key, version: 1, type: 'html', title: 'Acme 회사 소개서', language: null, createdAt: iso(150), size: 10 } } } as never)
    saved('m1')
    expect(useChats.getState().autoOpen).toBeNull()
    useChats.setState({ liveArtifacts: {} })
    saved('m9')
    expect(useChats.getState().autoOpen).toMatchObject({ chatId: CHAT, key: DECK_ARTIFACT_KEY })
  })

  test('a longer budget\'s build opens the panel when its outline comes, not while it reads; a listed outline never', () => {
    elsewhere(`/c/${CHAT}`)
    stub('window', { matchMedia: () => ({ matches: false }) })
    ev(reading({ read: { pages: 4, articles: 0 } }))
    ev(reading({ read: { pages: 9, articles: 0 } }))
    expect(useChats.getState().autoOpen).toBeNull()
    ev(build({ done: 0, tier: 'standard' }))
    expect(useChats.getState().autoOpen).toMatchObject({ chatId: CHAT, key: DECK_ARTIFACT_KEY })
    // the page opened again while the slides are made: the list has the outline, the next event opens nothing
    useDeckBuilds.getState().reset()
    useChats.setState({ autoOpen: null })
    useDeckBuilds.setState({ builds: { [CHAT]: [build({ done: 2 })] } })
    ev(build({ done: 3 }))
    expect(useChats.getState().autoOpen).toBeNull()
  })

  test('on a phone the build does not open the panel (the chat\'s tiles are enough); the saved deck opens it as before', () => {
    elsewhere(`/c/${CHAT}`)
    stub('window', { matchMedia: (q: string) => ({ matches: q.includes('max-width') }) })
    ev(build({ done: 0 }))
    expect(useChats.getState().autoOpen).toBeNull()
    expect(useChats.getState().buildOpened).toEqual({})
  })

  test('done while the chat is not on screen: a toast with the cover, the slides and the time, [열기]; a dot until opened', () => {
    elsewhere('/files')
    ev(build({ done: 8 }))
    ev(build({ phase: 'done' }))
    const toasts = useUi.getState().toasts
    expect(toasts).toHaveLength(1)
    expect(toasts[0]).toMatchObject({ level: 'info', text: '회사 소개서가 다 됐어요', detail: '9장 · 2분 34초', action: { label: '열기', primary: true } })
    expect(toasts[0]!.image).toBe('/api/intro-decks/builds/b1/slides/0?v=1')
    expect(useDeckBuilds.getState().unseen).toEqual({ [CHAT]: true })
    // the same end again (a reconnect, the list): said once
    ev(build({ phase: 'done' }))
    expect(useUi.getState().toasts).toHaveLength(1)
    // the window has the focus: no system notification
    expect(notified).toEqual([])
    useDeckBuilds.getState().seen(CHAT)
    expect(useDeckBuilds.getState().unseen).toEqual({})
  })

  test('done in the chat on screen: no toast and no dot (the chat shows it); a system notification while the window is not focused', () => {
    elsewhere(`/c/${CHAT}`, false)
    ev(build({ done: 8 }))
    ev(build({ phase: 'done' }))
    expect(useUi.getState().toasts).toEqual([])
    expect(useDeckBuilds.getState().unseen).toEqual({})
    expect(notified).toEqual([{ title: '회사 소개서가 다 됐어요', body: 'Acme 회사 소개서 · 9장 · 2분 34초', tag: 'deck-b1' } as never])
  })

  test('[열기] goes to that chat and asks for the deck beside it', () => {
    elsewhere('/files')
    const went: string[] = []
    stub('location', { pathname: '/files', assign: (to: string) => went.push(to) })
    ev(build({ done: 8 }))
    ev(build({ phase: 'done' }))
    useChats.setState({ autoOpen: null })
    useUi.getState().toasts[0]!.action!.run()
    expect(went).toEqual([`/c/${CHAT}`])
    expect(useChats.getState().autoOpen).toMatchObject({ chatId: CHAT, key: DECK_ARTIFACT_KEY })
  })
})

/** the page a component renders (mounted in the small DOM, then taken down) */
async function render(ui: ReactNode) {
  const page = await mount(ui)
  const html = page.html()
  await page.unmount()
  return html
}

describe('the block in the chat', () => {
  const html = (b: DeckBuild | null, o: { streaming?: boolean; steps?: Step[] } = {}) =>
    render(<DeckProgress build={b} steps={o.steps ?? [read, deckStep('d1'), deckStep('d2', 'error'), deckStep('d3')]} streaming={o.streaming ?? true} start={T0} chatId={CHAT} />)
  const count = (s: string, part: string) => s.split(part).length - 1
  const live = useLocaleStore.getState().locale
  beforeAll(() => { installDom() })
  afterAll(() => { removeDom(); useLocaleStore.setState({ locale: live }) })
  beforeEach(() => useLocaleStore.setState({ locale: 'ko' }))

  test('a longer budget reading the site: the line under the first step, the note with its time', async () => {
    const s = await html(reading({ tier: 'deep', read: { pages: 15, articles: 4 } }))
    expect(s).toContain('data-phase="reading"')
    expect(s).toMatch(/data-testid="deck-now">홈페이지 15쪽 · 기사 4건 확인 중</)
    expect(s).toContain('보통 10분 안에 끝나요.')
    expect(s).not.toContain('data-testid="deck-strip"')
  })

  test('reading the material: the title, a clock, four steps and the note; no tiles yet', async () => {
    const s = await html(null)
    expect(s).toContain('data-phase="reading"')
    expect(s).toContain('회사 소개서 만드는 중')
    expect(s).toContain('data-testid="deck-clock"')
    expect(count(s, 'data-testid="deck-row-')).toBe(4 + 0)
    expect(s).toContain('data-testid="deck-row-read" data-state="running"')
    // before the build exists the note gives the default budget (DEFAULT_DECK_TIER: 5 minutes)
    expect(s).toContain('보통 5분 안에 끝나요. 다른 메뉴를 써도 돼요. 다 되면 알려 드릴게요.')
    expect(s).not.toContain('data-testid="deck-strip"')
  })

  test('the slides: k / N, the live line in the accent, the tiles (done pictures, the one being made, planned ones)', async () => {
    const s = await html(build({ done: 4 }))
    expect(s).toContain('data-phase="slides"')
    expect(s).toMatch(/data-testid="deck-now">5장 · 숫자를 도넛 차트로 그리는 중</)
    expect(s).toContain('text-accent-text')
    expect(s).toContain('>5 / 9<')
    expect(count(s, 'data-testid="deck-tile" data-state="done"')).toBe(4)
    expect(count(s, 'data-testid="deck-tile" data-state="current"')).toBe(1)
    expect(count(s, 'data-testid="deck-tile" data-state="planned"')).toBe(4)
    expect(s).toContain('src="/api/intro-decks/builds/b1/slides/3?v=1"')
    expect(s).toContain('숫자 · 그리는 중')
    expect(s).toContain('deck-shimmer')
    // a slide tried twice is a normal step: no failed mark anywhere in the block
    expect(s).not.toContain('text-danger')
  })

  test('without slide pictures on this server: done tiles are a quiet check and the section', async () => {
    const s = await html(build({ done: 2, thumbs: false }))
    expect(s).not.toContain('/slides/')
    expect(count(s, 'data-testid="deck-tile" data-state="done"')).toBe(2)
    expect(s).toContain('회사 소개')
  })

  test('the review: the slides step has its time, the review runs with its line', async () => {
    const s = await html(build({ phase: 'review' }))
    expect(s).toContain('data-phase="review"')
    expect(s).toContain('data-testid="deck-row-review" data-state="running"')
    expect(s).toContain('다 만든 장을 다시 보는 중')
  })

  test('done: one folded step row "회사 소개서 · 9장 · 2분 34초"; no tiles, no clock, no note', async () => {
    const s = await html(build({ phase: 'done' }), { streaming: false })
    expect(s).toContain('data-run="done"')
    expect(s).toMatch(/data-testid="deck-folded"[^>]*>.*회사 소개서 · 9장 · 2분 34초/)
    expect(s).toContain('aria-expanded="false"')
    for (const gone of ['deck-strip', 'deck-clock', 'deck-rows', '보통 5분', '보통 3분']) expect(s).not.toContain(gone)
  })

  test('stopped: the row says it stopped and how far it got, with no red per-slide steps', async () => {
    const s = await html(build({ phase: 'failed', done: 3 }), { streaming: false })
    expect(s).toContain('data-run="stopped"')
    expect(s).toContain('회사 소개서를 만들다 멈췄어요 · 9장 중 3장')
    expect(s).not.toContain('text-danger')
    // an answer that ended while the build was still on its slides reads the same
    expect(await html(build({ done: 3 }), { streaming: false })).toContain('data-run="stopped"')
  })

  test('in the five languages', async () => {
    for (const l of ['en', 'id', 'ja', 'es'] as const) {
      useLocaleStore.setState({ locale: l })
      const s = await html(build({ done: 4 }))
      expect(s).toContain(translate(l, 'deck.progress.title'))
      expect(s).toContain(translate(l, 'deck.progress.note', { min: 5 }))
    }
  })
})

describe('the toast', () => {
  const live = useLocaleStore.getState().locale
  beforeAll(() => { installDom(); useLocaleStore.setState({ locale: 'ko' }) })
  afterAll(() => { removeDom(); useLocaleStore.setState({ locale: live }) })
  afterEach(() => useUi.setState({ toasts: [] }))
  test('a cover on the left, a quiet second line and one primary button; the plain toast keeps its link-style action', async () => {
    useUi.setState({ toasts: [
      { id: 1, level: 'info', text: '회사 소개서가 다 됐어요', detail: '9장 · 2분 34초', image: '/api/intro-decks/builds/b1/slides/0?v=1', action: { label: '열기', primary: true, run: () => {} } },
      { id: 2, level: 'info', text: 'plain', action: { label: 'Undo', run: () => {} } },
    ] })
    const s = await render(<Toaster />)
    const [deck, plain] = s.split('data-testid="toast"').slice(1)
    expect(deck).toContain('border-line bg-surface text-ink')
    expect(deck).toContain('src="/api/intro-decks/builds/b1/slides/0?v=1"')
    expect(deck).toContain('<span class="block text-xs text-faint">9장 · 2분 34초</span>')
    expect(deck).toMatch(/data-testid="toast-action"[^>]*>열기</)
    expect(deck).toContain('bg-accent')
    expect(plain).not.toContain('toast-action')
    expect(plain).toContain('underline')
  })
})
