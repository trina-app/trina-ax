// The deck panel while an intro deck is made (components/ArtifactPanel.tsx with components/chat/DeckProgress.tsx
// DeckBuildView; docs/DECISIONS.md "D2", round 2): the newest finished slide large, ‹ 4 / 9 › through the finished
// ones, the tiles under it, "만드는 중 · 5 / 9" in the header and [받기] there but disabled. Before the first slide a
// quiet stage, never an error or an empty state. Once the saved deck is listed the panel shows it.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { act } from 'react'
import { DECK_ARTIFACT_KEY, DeckBuild as DeckBuildSchema, uuidv7, type Artifact, type DeckBuild, type DeckBuildSlide, type Me } from '@mycel/shared/api'
import { useLocaleStore } from '../../src/i18n'
import ArtifactPanel from '../../src/components/ArtifactPanel'
import { useDeckBuilds } from '../../src/store/deckBuilds'
import { useChats } from '../../src/store/chats'
import { useSession } from '../../src/store/session'
import { installDom, mount as mountUi, removeDom, type Mounted } from './dom-host'

const CHAT = uuidv7()
const MSG = uuidv7()
const T0 = Date.parse('2026-11-06T01:00:00.000Z')
const iso = (s: number) => new Date(T0 + s * 1000).toISOString()
const SECTIONS = ['표지', '회사 소개', '고객의 고민', '하는 일', '숫자', '제품', '일하는 방식', '고객의 말', '마무리']
function build(done: number, o: Partial<DeckBuild> = {}): DeckBuild {
  const slides: DeckBuildSlide[] = SECTIONS.map((section, i) => ({ kind: i === 0 ? 'cover' : i === 8 ? 'contact' : 'about', section, figure: null, picture: false, status: i < done ? 'done' : i === done ? 'working' : 'planned', rev: i < done ? 1 : 0 }))
  return DeckBuildSchema.parse({ id: 'b1', chatId: CHAT, messageId: MSG, title: 'Acme 회사 소개서', phase: 'slides', slides, current: done, startedAt: iso(0), outlineAt: iso(35), slidesAt: null, finishedAt: null, artifactId: null, thumbs: true, ...o })
}

const me = { user: { id: 'alex', username: 'alex', name: 'Alex Kim', email: null, role: 'owner', locale: 'ko', localeChoice: null, mustChangePassword: false, prefs: {} }, groups: [], team: { name: 'Acme', defaultLocale: 'ko' }, session: { id: '01900000-0000-7000-8000-00000000000a', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' }, server: { version: '0', dev: false, deployment: 'self' } } as unknown as Me
const realFetch = globalThis.fetch
let calls: string[] = []
let saved: Artifact[] = []
let mounted: Mounted[] = []
const mount = async (ui: Parameters<typeof mountUi>[0]) => { const m = await mountUi(ui); mounted.push(m); return m }
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } })
let sessionBefore: unknown
let locationBefore: PropertyDescriptor | undefined
const localeBefore = useLocaleStore.getState().locale

beforeAll(() => {
  installDom()
  sessionBefore = useSession.getState().status
  useSession.setState({ status: { kind: 'signed-in', me } } as never)
  locationBefore = Object.getOwnPropertyDescriptor(globalThis, 'location')
  Object.defineProperty(globalThis, 'location', { configurable: true, writable: true, value: { origin: 'http://team.localhost', href: `http://team.localhost/c/${CHAT}`, pathname: `/c/${CHAT}` } })
  useLocaleStore.setState({ locale: 'ko' })
})
afterAll(() => {
  removeDom()
  useSession.setState({ status: sessionBefore } as never)
  if (locationBefore) Object.defineProperty(globalThis, 'location', locationBefore)
  else delete (globalThis as { location?: unknown }).location
  useLocaleStore.setState({ locale: localeBefore })
})
beforeEach(() => {
  calls = []
  saved = []
  useDeckBuilds.getState().reset()
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://team.localhost')
    const call = `${init?.method ?? 'GET'} ${url.pathname}`
    calls.push(call)
    if (call === `GET /api/chats/${CHAT}/artifacts`) return json({ items: saved.length ? [{ key: DECK_ARTIFACT_KEY, versions: saved.map(({ content, ...a }) => ({ ...a, size: content.length })) }] : [] })
    const one = /^GET \/api\/artifacts\/([^/]+)$/.exec(call)
    if (one) return json(saved.find((a) => a.id === one[1]))
    if (/^GET \/api\/intro-decks\/[^/]+$/.test(call)) return json({ artifactId: saved[0]?.id, chatId: CHAT, title: 'Acme 회사 소개서', theme: 'paper', slides: 9, pptx: true, pdf: false })
    // the chat (confidential or not): left waiting, the panel's frame is not what is tested here
    if (/^GET \/api\/chats\/[^/]+$/.test(call)) return new Promise<Response>(() => {})
    return json({ error: { code: 'not_found', message: 'not here' } }, 404)
  }) as typeof fetch
})
afterEach(async () => {
  for (const m of mounted.splice(0)) await m.unmount()
  globalThis.fetch = realFetch
  useDeckBuilds.getState().reset()
  useChats.setState({ artifactsRev: {} })
})

/** the chat's newest build becomes this (inside act: the panel follows it) */
const put = (b: DeckBuild) => act(async () => { useDeckBuilds.setState((s) => ({ builds: { ...s.builds, [CHAT]: [b] } })) })
const panel = () => mount(<ArtifactPanel chatId={CHAT} artifactKey={DECK_ARTIFACT_KEY} onClose={() => {}} />)

describe('the deck panel while the deck is made', () => {
  test('the newest finished slide large, 4 / 9, the tiles; "만드는 중 · 5 / 9" and [받기] there but disabled', async () => {
    await put(build(4))
    const m = await panel()
    await m.until(() => m.find('deck-build-view'), 'the build view')
    expect(m.get('artifact-panel').querySelector('h2')!.textContent).toBe('Acme 회사 소개서')
    expect(m.get('deck-build-badge').textContent).toBe('만드는 중 · 5 / 9')
    const get = m.get('deck-get')
    expect(get.getAttribute('disabled')).not.toBeNull()
    expect(get.textContent).toContain('받기')
    expect(m.get('deck-stage').querySelector('img')!.getAttribute('src')).toBe('/api/intro-decks/builds/b1/slides/3?v=1')
    expect(m.get('deck-page').textContent!.replace(/\s+/g, ' ').trim()).toBe('4 / 9')
    expect(m.get('deck-next').getAttribute('disabled')).not.toBeNull()
    expect(m.get('deck-strip').querySelectorAll('[data-testid="deck-tile"]').map((x) => x.getAttribute('data-state'))).toEqual(['done', 'done', 'done', 'done', 'current', 'planned', 'planned', 'planned', 'planned'])
    // the panel has five columns, the chat three on a phone
    expect(m.get('deck-strip').getAttribute('class')).toContain('grid-cols-5')
    // no deck content is asked for while it is made, and nothing says it failed
    expect(calls.some((c) => c.startsWith('GET /api/artifacts/'))).toBe(false)
    expect(m.html()).not.toContain('text-danger')
  })

  test('‹ › page through the finished slides; a tile shows its slide; a new slide is followed only from the newest', async () => {
    await put(build(4))
    const m = await panel()
    await m.until(() => m.find('deck-build-view'), 'the build view')
    const src = () => m.get('deck-stage').querySelector('img')!.getAttribute('src')
    const page = () => m.get('deck-page').textContent!.replace(/\s+/g, ' ').trim()
    await m.click('deck-prev')
    expect(page()).toBe('3 / 9')
    await m.click('deck-prev')
    await m.click('deck-prev')
    expect(page()).toBe('1 / 9')
    expect(m.get('deck-prev').getAttribute('disabled')).not.toBeNull()
    expect(src()).toBe('/api/intro-decks/builds/b1/slides/0?v=1')
    // a slide finished meanwhile: the page stays where the person is
    await put(build(5))
    await m.settle()
    expect(page()).toBe('1 / 9')
    // a tile of a finished slide shows it; back on the newest, the next finished slide is followed again
    await m.click(m.get('deck-strip').querySelectorAll('button')[4]!)
    expect(page()).toBe('5 / 9')
    await put(build(6))
    await m.settle()
    expect(page()).toBe('6 / 9')
  })

  test('right after the outline (no slide yet): a quiet stage and the planned tiles, no pager, no error', async () => {
    await put(build(0))
    const m = await panel()
    await m.until(() => m.find('deck-build-view'), 'the build view')
    expect(m.get('deck-stage').querySelector('img')).toBeNull()
    expect(m.find('deck-page')).toBeNull()
    expect(m.get('deck-build-badge').textContent).toBe('만드는 중 · 1 / 9')
    expect(m.html()).not.toContain('text-danger')
  })

  test('the review says so; done, the panel shows the saved deck once it is listed', async () => {
    const review = build(9, { phase: 'review', current: null, slidesAt: iso(120) })
    await put(review)
    const m = await panel()
    await m.until(() => m.find('deck-build-view'), 'the build view')
    expect(m.get('deck-build-badge').textContent).toBe('다듬는 중')
    const art: Artifact = { id: uuidv7(), chatId: CHAT, messageId: MSG, key: DECK_ARTIFACT_KEY, version: 1, type: 'html', title: 'Acme 회사 소개서', language: null, content: '<h1>Acme</h1>', createdAt: iso(150) }
    // done, but the list does not have the deck yet: still the slides
    await put({ ...review, phase: 'done', finishedAt: iso(154), artifactId: art.id })
    await m.settle()
    expect(m.find('deck-build-view')).not.toBeNull()
    saved = [art]
    await act(async () => { useChats.setState({ artifactsRev: { [CHAT]: 1 } }) })
    await m.until(() => !m.find('deck-build-view'), 'the saved deck', 3000)
    expect(m.get('artifact-panel').getAttribute('data-building')).toBeNull()
    expect(m.find('deck-build-badge')).toBeNull()
  })
})
