// An intro deck being built (docs/DECISIONS.md "D2", round 2: an outline, then one slide per call, then one review):
// what the chat's progress block, the deck panel and the "done" toast say, from the server's DeckBuild
// (shared/src/api/intro-deck.ts) and the answer's steps. Pure text and time helpers, tested without a browser.
//   1 홈페이지와 자료 살펴보기   from the click (the turn's start) until the reads before the outline end
//   2 구성 짜기 · N장            until the outline exists (outlineAt)
//   3 한 장씩 만들기 · k/N       until the last slide (slidesAt), with a live line under it ("5장 · 숫자를 도넛 차트로 그리는 중")
//   4 다시 보고 다듬기           until the end (finishedAt)
import { DECK_TOOL, type DeckBuild, type DeckFigureKind, type Message, type Step } from '@mycel/shared/api'
import type { MessageKey, Params } from '../i18n'
import { api, API } from './api'
import { splitCommand } from './skillTitles'

type T = (key: MessageKey, params?: Params) => string

/** The skill that makes the deck, as a message runs it ("/intro-deck …": the welcome steps send "/intro-deck 우리 회사
 * 소개서 만들어 줘", a skill form "/intro-deck" and its answers). */
export const DECK_SKILL = 'intro-deck'
export const runsDeckSkill = (content: string | null | undefined): boolean => splitCommand(content ?? '')?.name.toLowerCase() === DECK_SKILL

/** live: being made (the answer runs) · done: finished · stopped: failed, or the answer ended before it finished */
export type DeckRunState = 'live' | 'done' | 'stopped'
export const deckRunState = (b: DeckBuild | null, streaming: boolean): DeckRunState =>
  b?.phase === 'done' ? 'done' : b?.phase === 'failed' || !streaming ? 'stopped' : 'live'

export const doneSlides = (b: DeckBuild) => b.slides.filter((s) => s.status === 'done').length

/** A chat's builds, newest first, with one more picture of a build put in (an event or a listed one). An older picture
 * never replaces a newer one: a list answer computed before an event, or an event that comes late. The order is the
 * phase (slides → review → done/failed), the outline, then while the slides are made how many are done and working. */
const PHASE = { reading: 0, slides: 1, review: 2, done: 3, failed: 3 } as const
const rank = (b: DeckBuild) => {
  const making = b.phase === 'slides'
  return [PHASE[b.phase], b.outlineAt ? 1 : 0, making ? doneSlides(b) : 0, making ? b.slides.filter((s) => s.status === 'working').length : 0]
}
export function isOlder(a: DeckBuild, than: DeckBuild): boolean {
  const x = rank(a), y = rank(than)
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i]! < y[i]!
  return false
}
export const BUILDS_KEPT = 10
export function mergeBuild(list: readonly DeckBuild[], b: DeckBuild): readonly DeckBuild[] {
  const have = list.find((x) => x.id === b.id)
  if (have && isOlder(b, have)) return list
  return [b, ...list.filter((x) => x.id !== b.id)].sort((x, y) => (x.startedAt < y.startedAt ? 1 : x.startedAt > y.startedAt ? -1 : 0)).slice(0, BUILDS_KEPT)
}

/** "1:24" (the block's clock) */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
/** "2분 34초" / "34초" */
export function duration(ms: number, t: T): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? t('steps.secs', { s }) : t('steps.minSecs', { m: Math.floor(s / 60), s: s % 60 })
}
const at = (iso: string | null | undefined) => (iso ? Date.parse(iso) : null)
/** the whole build, click to end */
export const buildMs = (b: DeckBuild) => (at(b.finishedAt) ?? Date.now()) - Date.parse(b.startedAt)

const FIGURE: Record<DeckFigureKind, MessageKey> = {
  flow: 'deck.progress.fig.flow', cycle: 'deck.progress.fig.cycle', hub: 'deck.progress.fig.hub', layers: 'deck.progress.fig.layers',
  timeline: 'deck.progress.fig.timeline', compare: 'deck.progress.fig.compare', funnel: 'deck.progress.fig.funnel', merge: 'deck.progress.fig.merge',
  grid: 'deck.progress.fig.grid', cards: 'deck.progress.fig.cards', donut: 'deck.progress.fig.donut', bars: 'deck.progress.fig.bars',
  line: 'deck.progress.fig.line', figures: 'deck.progress.fig.figures',
}

/** How long a deck of this budget usually takes, in minutes (the note under the block; DeckTier, older servers: quick). */
export const tierMinutes = (b: DeckBuild | null) => (b?.tier === 'deep' ? 10 : b?.tier === 'standard' ? 5 : 3)

const host = (url: string) => {
  try {
    return new URL(url).host.replace(/^www\./, '')
  } catch {
    return ''
  }
}
/** What the longer budgets read before the outline, while the server has not counted it yet: the answer's own steps.
 * Web searches; pages fetched from the site fetched most (the company's own) and articles from the other sites. */
export function readCounts(steps: readonly Step[]): { pages: number; articles: number; searches: number } {
  const searches = steps.filter((s) => s.kind === 'web_search' && !s.parentId).length
  const hosts = steps.filter((s) => (s.tool === 'web_fetch' || s.tool === 'WebFetch') && !s.parentId).map((s) => host(/https?:\/\/\S+/.exec(s.label)?.[0] ?? ''))
  const count = new Map<string, number>()
  for (const h of hosts) count.set(h, (count.get(h) ?? 0) + 1)
  const own = [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
  const pages = own === undefined ? 0 : count.get(own)!
  return { pages, articles: hosts.length - pages, searches }
}

/** The live line under the first step for the longer budgets: what the extra time reads ("홈페이지 9쪽 읽는 중",
 * "홈페이지 9쪽 · 기사 3건 확인 중"), from the server's count, else from the answer's steps; null when nothing is read
 * from the web. */
export function readLine(b: DeckBuild | null, steps: readonly Step[], t: T): string | null {
  const server = b?.read && (b.read.pages > 0 || b.read.articles > 0) ? { ...b.read, searches: 0 } : null
  const c = server ?? readCounts(steps)
  const parts = [
    c.pages > 0 ? t('deck.progress.read.pages', { n: c.pages }) : null,
    c.searches > 0 ? t('deck.progress.read.searches', { n: c.searches }) : null,
    c.articles > 0 ? t('deck.progress.read.articles', { n: c.articles }) : null,
  ].filter((x): x is string => !!x)
  if (!parts.length) return null
  return t(c.articles > 0 || c.searches > 0 ? 'deck.progress.read.checking' : 'deck.progress.read.reading', { what: parts.join(' · ') })
}

/** The live line under the running step: what is being made right now, in the screen's language ("5장 · 숫자를 도넛
 * 차트로 그리는 중", "1장 · 홈페이지 사진에 브랜드색 입히는 중", "다 만든 장을 다시 보는 중"); null when nothing is. */
export function nowLine(b: DeckBuild, t: T): string | null {
  if (b.phase === 'review') return t('deck.progress.now.review')
  if (b.phase !== 'slides' || !b.outlineAt) return null
  const i = currentSlide(b)
  const s = i === null ? undefined : b.slides[i]
  if (i === null || !s) return null
  const n = i + 1
  if (s.figure) return t('deck.progress.now.figure', { n, section: s.section, figure: t(FIGURE[s.figure]) })
  const ground = s.kind === 'cover' || s.kind === 'opening' || s.kind === 'contact'
  if (ground && s.picture) return t('deck.progress.now.picture', { n })
  if (s.kind === 'cover') return t('deck.progress.now.cover', { n })
  if (ground) return t('deck.progress.now.ground', { n, section: s.section })
  return t('deck.progress.now.text', { n, section: s.section })
}

/** The slide being made now: the server's `current`, else the one marked working, else the first not done. */
export function currentSlide(b: DeckBuild): number | null {
  if (b.current !== null && b.slides[b.current] && b.slides[b.current]!.status !== 'done') return b.current
  const working = b.slides.findIndex((s) => s.status === 'working')
  if (working >= 0) return working
  if (b.phase !== 'slides' || !b.outlineAt) return null
  const next = b.slides.findIndex((s) => s.status !== 'done')
  return next >= 0 ? next : null
}

export type TileState = 'done' | 'current' | 'planned'
export function tileState(b: DeckBuild, i: number, run: DeckRunState): TileState {
  const s = b.slides[i]!
  if (s.status === 'done') return 'done'
  return run === 'live' && (b.phase === 'slides' || b.phase === 'review') && currentSlide(b) === i ? 'current' : 'planned'
}

/** One finished slide's picture (960 × 540), new after each redraw (`rev`). */
export const slideUrl = (b: DeckBuild, i: number) => api.url(API.deckBuildSlide, { params: { id: b.id, n: String(i) }, query: { v: b.slides[i]?.rev ?? 0 } })

export type RowKey = 'read' | 'outline' | 'slides' | 'review'
export interface DeckRow {
  key: RowKey
  label: string
  state: 'done' | 'running' | 'todo' | 'stopped'
  /** on the right: the step's time once done ("0:21"), "5 / 9" while the slides are made */
  right: string | null
  /** the live line under the running step */
  now: string | null
}

/** When the reads before the outline ended (the last step that is not the deck tool's own, done before the outline):
 * the split between "살펴보기" and "구성 짜기"; null when no such step is known. */
function readsEnd(steps: readonly Step[], start: number, outline: number): number | null {
  let end: number | null = null
  for (const s of steps) {
    if (s.tool === DECK_TOOL || s.parentId || !s.endedAt) continue
    const e = Date.parse(s.endedAt)
    if (e >= start && e <= outline && (end === null || e > end)) end = e
  }
  return end
}

/** The four steps of the block. `start`: when the click was, for the reading part before any build exists (the
 * answer's own start); a build carries its own. */
export function deckRows(b: DeckBuild | null, steps: readonly Step[], start: number, run: DeckRunState, t: T): DeckRow[] {
  const begin = b ? Date.parse(b.startedAt) : start
  const outline = at(b?.outlineAt)
  const slidesEnd = at(b?.slidesAt)
  const end = at(b?.finishedAt)
  const n = b?.slides.length ?? 0
  // the step that runs now: 0 reading (the outline row has no moment of its own: it is done when the outline is), 2 the
  // slides, 3 the review, 4 all done; a failed build stops where it was
  const stage = !b || outline === null || b.phase === 'reading' ? 0 : b.phase === 'slides' ? 2 : b.phase === 'review' ? 3 : b.phase === 'done' ? 4 : slidesEnd !== null ? 3 : 2
  const reads = outline === null ? null : readsEnd(steps, begin, outline)
  const state = (i: number): DeckRow['state'] => (stage > i ? 'done' : stage === i ? (run === 'live' ? 'running' : 'stopped') : 'todo')
  const time = (from: number | null, to: number | null) => (from !== null && to !== null ? clock(to - from) : null)
  const slideNo = b ? Math.min(n, (currentSlide(b) ?? doneSlides(b)) + 1) : 0
  const rows: DeckRow[] = [
    { key: 'read', label: t('deck.progress.read'), state: state(0), right: stage > 0 ? time(begin, reads ?? outline) : null, now: null },
    { key: 'outline', label: n ? t('deck.progress.outlineN', { n }) : t('deck.progress.outline'), state: stage > 0 ? 'done' : 'todo', right: stage > 0 && reads !== null ? time(reads, outline) : null, now: null },
    { key: 'slides', label: t('deck.progress.slides'), state: state(2), right: stage > 2 ? time(outline, slidesEnd ?? end) : stage === 2 && n ? `${slideNo} / ${n}` : null, now: null },
    { key: 'review', label: t('deck.progress.review'), state: state(3), right: stage > 3 ? time(slidesEnd ?? end, end) : null, now: null },
  ]
  if (run === 'live' && stage === 0) rows[0]!.now = readLine(b, steps, t)
  if (b && run === 'live') {
    const line = nowLine(b, t)
    if (stage === 2) rows[2]!.now = line
    if (stage === 3) rows[3]!.now = line
  }
  return rows
}

/** Whether the deck panel shows the chat's newest build instead of a saved deck (`versions`: the deck's saved versions,
 * oldest first): while it is made, unless a deck was saved after it started; once done, until the saved deck is in the
 * list; stopped, only when there is no saved deck to show. */
export function showsBuild(b: DeckBuild, run: DeckRunState, versions: readonly { id: string; createdAt: string }[]): boolean {
  if (run === 'done') return b.artifactId ? !versions.some((v) => v.id === b.artifactId) : !versions.length
  if (run === 'stopped') return !versions.length
  const newest = versions.at(-1)
  return !newest || newest.createdAt < b.startedAt
}

/** "9장 · 2분 34초" (the toast's second line, the notification's text) */
export const doneDetail = (b: DeckBuild, t: T) => t('deck.progress.readyDetail', { n: b.slides.length, time: duration(buildMs(b), t) })

/** The answer whose question ran the deck skill, before the server has made the build (reading the material). */
export const readsForDeck = (m: Pick<Message, 'role' | 'status'>, question: string | null | undefined) => m.role === 'assistant' && m.status === 'streaming' && runsDeckSkill(question)
