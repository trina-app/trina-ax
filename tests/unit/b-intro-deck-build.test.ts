// Onboarding D2, round 2 (docs/DECISIONS.md "D2", round 2): the intro deck built slide by slide in one chat turn
// through the `intro_deck` tool (build.ts): the outline checked at once, one slide per call with its own problems and
// tries, `deck.progress` to the chat's owner, the server's pictures of the slides and the one review round, the finish
// into the artifact "intro-deck" and its row in intro_decks, the builds' routes and the downloads of a round-2 deck.
// A real app with the fake engine; every company here is made up.
import { layoutDeck2 } from '../../server/src/intro-deck/layout2'
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { API, DECK_ARTIFACT_KEY, type DeckBuild, type DeckSlide2, type ServerEventInput } from '@mycel/shared/api'
import { startHarness, type Harness } from '../lib/b-harness'
import { waitFor } from '../lib/wait'
import { which } from '../../server/src/config'
import { readZip } from '../../server/src/files/zip-write'
import { encodePng } from '../../server/src/intro-deck/png'
import { pdfAvailable, pretendardDir } from '../../server/src/intro-deck/files'

setDefaultTimeout(120_000)

// ── pictures made in code ───────────────────────────────────────────────────────────────────────────────────────────
function realPng(w: number, h: number, rgba: [number, number, number, number] = [40, 90, 70, 255], clearEdge = 0): Buffer {
  const data = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const inside = x >= clearEdge && y >= clearEdge && x < w - clearEdge && y < h - clearEdge
    if (inside) data.set(rgba, (y * w + x) * 4)
  }
  return Buffer.from(encodePng({ width: w, height: h, data }))
}

// ── XML of the PowerPoint file (saxes is the server's dependency) ───────────────────────────────────────────────────
interface XNode { name: string; attrs: Record<string, string>; kids: XNode[]; text: string }
interface Sax {
  on(e: 'error', f: (e: Error) => void): void
  on(e: 'opentag', f: (t: { name: string; attributes: Record<string, string | { value: string }> }) => void): void
  on(e: 'closetag' | 'text', f: (t: string) => void): void
  write(s: string): { close(): void }
}
const { SaxesParser } = createRequire(path.join(import.meta.dir, '../../server/package.json'))('saxes') as { SaxesParser: new (o: { xmlns: boolean }) => Sax }
function parseXml(xml: string, where: string): XNode {
  const p = new SaxesParser({ xmlns: true })
  const root: XNode = { name: '#doc', attrs: {}, kids: [], text: '' }
  const stack = [root]
  p.on('error', (e) => { throw new Error(`${where}: ${e.message}`) })
  p.on('opentag', (t) => {
    const n: XNode = { name: t.name, attrs: Object.fromEntries(Object.entries(t.attributes).map(([key, a]) => [key, typeof a === 'string' ? a : a.value])), kids: [], text: '' }
    stack.at(-1)!.kids.push(n)
    stack.push(n)
  })
  p.on('closetag', () => { stack.pop() })
  p.on('text', (t) => { stack.at(-1)!.text += t })
  p.write(xml).close()
  return root
}
const all = (n: XNode, name: string): XNode[] => [...(n.name === name ? [n] : []), ...n.kids.flatMap((c) => all(c, name))]
const typst = which('typst')
const withTypst = !!typst && !!pretendardDir()

// ── the material and the deck the stand-in AI writes ────────────────────────────────────────────────────────────────
const IMG = 'shared/브랜드/이미지/'
const SRC = 'shared/브랜드/회사 소개.md'
const MATERIAL = `# 아크메정밀 회사 소개

아크메정밀은 2009년 경기도 안산에서 시작한 정밀 가공 부품 회사입니다.
반도체 장비와 의료기기에 들어가는 부품을 만들어 340곳의 고객사에 납품합니다 (2025년 12월 기준).
불량률 0.02%, 납기 준수율 99.1%, 직원 48명.
주문은 도면 상담, 견적, 가공, 검사와 납품의 순서로 진행합니다.
2014년 의료기기 부품을 시작했고, 2019년 두 번째 공장을 지었습니다.

고객사: 아크메전자, 아크메메디칼, 아크메테크, 아크메로보틱스

영업팀 박서준 이사
이메일 sales@acme-precision.example
전화 031-555-0142
주소 경기도 안산시 단원구 예시로 12
웹사이트 acme-precision.example
`
const FLOW_BASIS = '주문은 도면 상담, 견적, 가공, 검사와 납품의 순서로 진행합니다.'
const TIMELINE_BASIS = '2014년 의료기기 부품을 시작했고, 2019년 두 번째 공장을 지었습니다.'
const ACCENT = '<svg viewBox="0 0 800 800"><circle cx="400" cy="400" r="300" fill="none" stroke="mark" stroke-width="2"/><circle cx="400" cy="400" r="120" fill="mark" fill-opacity="0.2"/></svg>'

type Stub = { kind: string; section: string; headline: string; figure?: string; basis?: string; picture?: string }
const STUBS: Stub[] = [
  { kind: 'cover', section: '표지', headline: '정밀 부품을 제때', picture: IMG + 'factory.png' },
  { kind: 'about', section: '회사 소개', headline: '정밀 가공 부품' },
  { kind: 'numbers', section: '숫자', headline: '고객이 다시 찾는 이유', figure: 'figures' },
  { kind: 'process', section: '진행 방식', headline: '주문은 이렇게', figure: 'flow', basis: FLOW_BASIS },
  { kind: 'proof', section: '고객사', headline: '함께 일하는 고객사' },
  { kind: 'history', section: '연혁', headline: '한 걸음씩', figure: 'timeline', basis: TIMELINE_BASIS },
  { kind: 'contact', section: '마무리', headline: '연락 주세요' },
]
const outline = (over: Record<string, unknown> = {}) => ({
  step: 'outline', title: '아크메정밀 회사 소개서', company: '아크메정밀', website: 'acme-precision.example', brand_color: '#1e4620', logo: IMG + 'logo.png',
  sources: [SRC], pattern: 'dots', pictures: [{ path: IMG + 'factory.png', subject: '공장 안의 가공 장비', lettering: false, calm: 'left', tone: 'dark' }],
  slides: STUBS, ...over,
})
const SLIDES: DeckSlide2[] = [
  { kind: 'cover', headline: '정밀 부품을\n*제때* 만드는 회사', sub: '반도체 장비와 의료기기 부품', picture: IMG + 'factory.png' },
  { kind: 'about', statement: '반도체 장비와 의료기기에 들어가는 *정밀 가공 부품*을 만듭니다', facts: [{ label: '설립', value: '2009년' }, { label: '위치', value: '경기도 안산' }, { label: '직원', value: '48명' }] },
  { kind: 'numbers', title: '고객이 다시 찾는 이유', note: '2025년 12월 기준', figure: { kind: 'figures', items: [{ number: '340곳', label: '고객사' }, { number: '0.02%', label: '불량률' }, { number: '99.1%', label: '납기 준수율' }] } },
  { kind: 'process', title: '주문은 이렇게 진행돼요', figure: { kind: 'flow', steps: [{ icon: 'clipboard-list', head: '도면 상담' }, { icon: 'receipt', head: '견적' }, { icon: 'cog', head: '가공' }, { icon: 'package', head: '검사와 납품' }] } },
  { kind: 'proof', title: '함께 일하는 고객사', names: ['아크메전자', '아크메메디칼', '아크메테크', '아크메로보틱스'] },
  { kind: 'history', title: '한 걸음씩 걸어온 길', figure: { kind: 'timeline', items: [{ when: '2009', head: '안산에서 창업' }, { when: '2014', head: '의료기기 부품' }, { when: '2019', head: '두 번째 공장' }] } },
  { kind: 'contact', line: '부품 견적이 필요하면\n연락 주세요', email: 'sales@acme-precision.example', phone: '031-555-0142', address: '경기도 안산시 단원구 예시로 12' },
]
const slide = (i: number, s: DeckSlide2 = SLIDES[i]!, extra: Record<string, unknown> = {}) => ({ tool: 'intro_deck', args: { step: 'slide', index: i, slide: s }, sayResult: true, ...extra })
const step = (args: unknown, extra: Record<string, unknown> = {}) => ({ tool: 'intro_deck', args, sayResult: true, ...extra })
const allSlides = (from = 0, to = SLIDES.length) => SLIDES.slice(from, to).map((_, k) => slide(from + k))

/** Run `fn` with typst off (no slide pictures: the deck finishes at its last slide) or as configured. */
async function typstOff<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.MYCEL_TYPST_BIN
  process.env.MYCEL_TYPST_BIN = ''
  try { return await fn() } finally { if (prev === undefined) delete process.env.MYCEL_TYPST_BIN; else process.env.MYCEL_TYPST_BIN = prev }
}

describe('the intro deck built slide by slide (a real app, the fake engine)', () => {
  let h: Harness
  const events: { user: string; ev: ServerEventInput }[] = []
  const put = (rel: string, b: Buffer | string) => { const abs = path.join(h.team, rel); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, b) }
  const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
  const start = async (user: string, chatId: string, content: string) => h.api(user).call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [] } })
  const finished = async (messageId: string) => {
    await waitFor(() => (h.ctx.db.query('SELECT status FROM messages WHERE id = ?').get(messageId) as { status: string }).status !== 'streaming', { timeoutMs: 90_000 })
    return (h.ctx.db.query('SELECT content FROM messages WHERE id = ?').get(messageId) as { content: string }).content
  }
  const send = async (user: string, chatId: string, content: string) => finished((await start(user, chatId, content)).assistantMessage.id)
  const newChat = async (user = 'dana') => (await h.api(user).call(API.createChat, { body: {} })).id
  const builds = (chatId: string) => h.ctx.db.query('SELECT id, status, plan, state, outline_at, slides_at, finished_at, artifact_id FROM intro_deck_builds WHERE chat_id = ? ORDER BY started_at').all(chatId) as { id: string; status: string; plan: string; state: string; outline_at: string | null; slides_at: string | null; finished_at: string | null; artifact_id: string | null }[]
  const progress = (chatId: string): DeckBuild[] => events.filter((e) => e.ev.type === 'deck.progress' && e.ev.data.chatId === chatId).map((e) => (e.ev as Extract<ServerEventInput, { type: 'deck.progress' }>).data.build)

  beforeAll(async () => {
    h = await startHarness({ name: 'b-intro-deck-build' })
    h.ctx.db.query("INSERT OR REPLACE INTO settings (key, value) VALUES ('defaultLocale', ?)").run(JSON.stringify('ko'))
    const hub = h.ctx.services.realtime
    const orig = hub.publish.bind(hub)
    hub.publish = (user: string, ev: ServerEventInput) => { events.push({ user, ev }); orig(user, ev) }
    put(SRC, MATERIAL)
    put(IMG + 'factory.png', realPng(1920, 1080))
    put(IMG + 'line.png', realPng(1600, 1000, [200, 200, 190, 255]))
    put(IMG + 'tiny.png', realPng(399, 399))
    put(IMG + 'logo.png', realPng(400, 120, [20, 20, 20, 255], 12))
    put(IMG + 'logo-big.png', realPng(1200, 900, [20, 20, 20, 255], 60))
  })
  afterAll(async () => { await h?.close() })

  test('the outline: every problem at once (order, figures and their basis, pictures and their notes, the logo)', async () => {
    const chat = await newChat()
    const bad = outline({
      logo: IMG + 'logo-big.png',
      pictures: [{ path: IMG + 'logo-big.png', subject: '로고', lettering: true, calm: 'none', tone: 'light' }, { path: IMG + 'tiny.png', subject: '작은 그림', lettering: false, calm: 'left', tone: 'dark' }],
      slides: [
        { kind: 'about', section: '회사 소개', headline: '정밀 가공 부품' },
        { kind: 'cover', section: '표지', headline: '정밀 부품을 제때', picture: IMG + 'line.png' },
        { kind: 'offer', section: '하는 일', headline: '하는 일', figure: 'donut' },
        { kind: 'process', section: '진행 방식', headline: '주문은 이렇게', figure: 'flow' },
        { kind: 'history', section: '연혁', headline: '한 걸음씩', figure: 'timeline', basis: '2010년에 시작했습니다' },
        { kind: 'contact', section: '마무리', headline: '연락 주세요' },
      ],
    })
    const answer = await send('dana', chat, fake(step(bad)))
    expect(answer).toContain('The outline was not accepted. Fix every problem below and call intro_deck step "outline" once more')
    expect(answer).toContain('slides[0] must be the cover')
    expect(answer).toContain('slides[1] must be the about slide')
    expect(answer).toContain('slides[2] (offer): a offer slide takes layers, grid, hub, not donut')
    expect(answer).toContain('slides[3] (process): a flow needs a basis')
    expect(answer).toContain('slides[4] (history) basis: "2010년에 시작했습니다" is not written in the sources word for word')
    expect(answer).toContain(`pictures: "${IMG}logo-big.png" is the logo; it goes only in \`logo\``)
    expect(answer).toContain(`pictures: "${IMG}tiny.png"`)
    expect(answer).toContain('is too small')
    expect(answer).toContain(`slides[1] (cover) picture "${IMG}line.png": add a note for it in \`pictures\``)
    expect(h.ctx.db.query('SELECT count(*) AS n FROM artifacts WHERE chat_id = ?').get(chat)).toEqual({ n: 0 })
    // a failed outline shows no progress and lists no build the panel could open
    expect(progress(chat)).toEqual([])
    expect((await h.api('dana').call(API.listDeckBuilds, { query: { chatId: chat } })).builds).toEqual([])
  })

  test('outline → one slide per call → the deck at the last slide (no typst: no review); progress per slide; the artifact and its row', async () => {
    const chat = await newChat()
    const answer = await typstOff(() => send('dana', chat, fake(step(outline()), ...allSlides())))
    expect(answer).toContain('Outline accepted: 7 slides')
    expect(answer).toContain('Next: intro_deck step "slide", index 0: a cover slide')
    expect(answer).toContain('Slide 0 is done. Next: intro_deck step "slide", index 1: a about slide')
    expect(answer).toContain('Slide 3 is done. Next: intro_deck step "slide", index 4')
    expect(answer).toContain('The intro deck "아크메정밀 회사 소개서" is finished (7 slides')
    expect(answer).toContain('slides that could have had a picture but were made without one: none')
    // the build: done, its times, the artifact
    const [b] = builds(chat)
    expect(b).toMatchObject({ status: 'done' })
    expect(b!.outline_at && b!.slides_at && b!.finished_at).toBeTruthy()
    const art = h.ctx.db.query('SELECT id, key, type, title, content, version FROM artifacts WHERE chat_id = ?').all(chat) as { id: string; key: string; type: string; title: string; content: string; version: number }[]
    expect(art).toHaveLength(1)
    expect(art[0]).toMatchObject({ id: b!.artifact_id, key: DECK_ARTIFACT_KEY, type: 'html', title: '아크메정밀 회사 소개서', version: 1 })
    expect(art[0]!.content.match(/<section class="s/g)).toHaveLength(7)
    const row = h.ctx.db.query('SELECT chat_id, user_id, spec FROM intro_decks WHERE artifact_id = ?').get(b!.artifact_id) as { chat_id: string; user_id: string; spec: string }
    const spec = JSON.parse(row.spec)
    expect(row).toMatchObject({ chat_id: chat, user_id: 'dana' })
    expect(spec.doc.v).toBe(2)
    expect(spec.doc.slides.map((s: DeckSlide2) => s.kind)).toEqual(STUBS.map((s) => s.kind))
    expect(spec.doc.sections).toEqual(STUBS.map((s) => s.section))
    expect(spec.sources).toEqual([SRC])
    // the notes quote where the numbers and names stand
    expect(spec.doc.notes[2].join('\n')).toContain('출처: 회사 소개.md — "')
    expect(spec.doc.notes[4].join('\n')).toContain('아크메전자')
    // progress: the outline (all planned, the cover being made), then each slide done in order, then the end
    const ev = progress(chat)
    expect(ev.length).toBeGreaterThanOrEqual(1 + SLIDES.length)
    expect(ev[0]!.phase).toBe('slides')
    expect(ev[0]!.slides.map((s) => s.status)).toEqual(['working', 'planned', 'planned', 'planned', 'planned', 'planned', 'planned'])
    expect(ev[0]!.slides.map((s) => s.section)).toEqual(STUBS.map((s) => s.section))
    expect(ev[0]!.slides[2]).toMatchObject({ kind: 'numbers', figure: 'figures', picture: false, rev: 0 })
    expect(ev[0]!.slides[0]).toMatchObject({ kind: 'cover', picture: true })
    expect(ev[0]!.outlineAt).toBeTruthy()
    for (let k = 0; k < SLIDES.length; k++) {
      const after = ev.find((e) => e.slides.filter((s) => s.status === 'done').length === k + 1)!
      expect(after.slides[k]).toMatchObject({ status: 'done', rev: 1 })
      if (k + 1 < SLIDES.length) { expect(after.slides[k + 1]!.status).toBe('working'); expect(after.current).toBe(k + 1) }
    }
    const last = ev.at(-1)!
    expect(last).toMatchObject({ phase: 'done', artifactId: b!.artifact_id, current: null, thumbs: false })
    expect(last.finishedAt).toBeTruthy()
    // only to the chat's owner
    expect(events.filter((e) => e.ev.type === 'deck.progress' && e.ev.data.chatId === chat).every((e) => e.user === 'dana')).toBe(true)
    // the builds' routes: the owner's list; nobody else's; a slide picture only once drawn (no typst: none)
    const listed = await h.api('dana').call(API.listDeckBuilds, { query: { chatId: chat } })
    expect(listed.builds.map((x) => x.id)).toEqual([b!.id])
    expect(listed.builds[0]).toMatchObject({ phase: 'done', title: '아크메정밀 회사 소개서', artifactId: b!.artifact_id })
    expect((await h.req('alice', `/api/intro-decks/builds?chatId=${chat}`)).status).toBe(404)
    expect((await h.req('dana', `/api/intro-decks/builds/${b!.id}/slides/0`)).status).toBe(404)
    expect((await h.req('alice', `/api/intro-decks/builds/${b!.id}/slides/0`)).status).toBe(404)
    // the deck's info answers for round 2's document as for round 1's
    const info = await h.api('dana').call(API.getIntroDeck, { params: { id: b!.artifact_id! } })
    expect(info).toMatchObject({ artifactId: b!.artifact_id, chatId: chat, title: '아크메정밀 회사 소개서', slides: 7, pptx: true })
  })

  test('a picture a slide uses that the outline did not note is measured and kept with the deck (its card is drawn)', async () => {
    put(IMG + 'part1.png', realPng(600, 600, [60, 80, 100, 255]))
    put(IMG + 'part2.png', realPng(600, 600, [120, 80, 100, 255]))
    const stubs = [...STUBS.slice(0, 3), { kind: 'products', section: '제품', headline: '주요 부품', figure: 'cards' }, ...STUBS.slice(3)]
    const cards: DeckSlide2 = { kind: 'products', title: '주요 부품을 만듭니다', figure: { kind: 'cards', items: [{ name: '정밀 샤프트', picture: IMG + 'part1.png' }, { name: '진공 블록', picture: IMG + 'part2.png' }] } }
    const slides = [...SLIDES.slice(0, 3), cards, ...SLIDES.slice(3)]
    const chat = await newChat()
    await typstOff(() => send('dana', chat, fake(step(outline({ slides: stubs })), ...slides.map((s, i) => slide(i, s)))))
    const [b] = builds(chat)
    expect(b!.status).toBe('done')
    const spec = JSON.parse((h.ctx.db.query('SELECT spec FROM intro_decks WHERE artifact_id = ?').get(b!.artifact_id) as { spec: string }).spec)
    expect(spec.doc.pics[IMG + 'part1.png']).toEqual({ width: 600, height: 600 })
    expect(spec.doc.pics[IMG + 'part2.png']).toEqual({ width: 600, height: 600 })
    const out = layoutDeck2(spec.doc)
    const imgs = out.slides[3]!.items.filter((it) => it.t === 'image').map((it) => (it as { src: string }).src)
    expect(imgs).toEqual([IMG + 'part1.png', IMG + 'part2.png'])
  })

  test('a slide with problems gets them back alone; the next try is accepted; two failed tries leave a content slide out', async () => {
    const chat = await newChat()
    const badAbout: DeckSlide2 = { kind: 'about', statement: '고객사 34곳에 부품을 만듭니다', facts: [{ label: '설립', value: '2010년' }] }
    const badNumbers: DeckSlide2 = { kind: 'numbers', title: '숫자로 보는 회사', figure: { kind: 'figures', items: [{ number: '340개', label: '고객사' }, { number: '0.02%', label: '불량률' }] } }
    const otherFigure: DeckSlide2 = { kind: 'numbers', title: '숫자로 보는 회사', figure: { kind: 'donut', items: [{ value: '99.1%', label: '납기 준수율' }] } }
    const cycle: DeckSlide2 = { kind: 'process', title: '주문은 이렇게 진행돼요', figure: { kind: 'cycle', steps: [{ head: '상담' }, { head: '견적' }, { head: '가공' }] } }
    const badNames: DeckSlide2 = { kind: 'proof', title: '함께 일하는 고객사', names: ['아크메전자', '아크메물산', '아크메테크'] }
    const answer = await typstOff(() => send('dana', chat, fake(step(outline()), slide(0), slide(1, badAbout), slide(1), slide(2, badNumbers), slide(2, otherFigure), slide(3, cycle), slide(3), slide(4, badNames), slide(4), slide(5), slide(6))))
    expect(answer).toContain('Slide 1 was not accepted. Fix every problem below and send this slide again (step "slide", index 1)')
    expect(answer).toContain('slides[1] (about) statement: the number "34" is not in the sources')
    expect(answer).toContain('slides[1] (about) facts[0].value: the number "2010" is not in the sources')
    expect(answer).toContain('Slide 1 is done.')
    expect(answer).toContain('slides[2] (numbers) figure.items[0].number "340개" is not written in the sources exactly like that')
    expect(answer).toContain('slides[3] (process) figure: the outline planned a flow here; draw a flow (a cycle needs its own basis quote from the sources)')
    expect(answer).toContain('Slide 2 is left out after 2 tries')
    expect(answer).toContain('slides[4] (proof) names[1]: "아크메물산" is not written in the sources like that')
    expect(answer).toContain('The intro deck "아크메정밀 회사 소개서" is finished (6 slides')
    expect(answer).toContain('1 planned slide was left out after failed tries')
    const [b] = builds(chat)
    expect(JSON.parse(b!.state).skipped).toEqual([2])
    const spec = JSON.parse((h.ctx.db.query('SELECT spec FROM intro_decks WHERE artifact_id = ?').get(b!.artifact_id) as { spec: string }).spec)
    expect(spec.doc.slides.map((s: DeckSlide2) => s.kind)).toEqual(['cover', 'about', 'process', 'proof', 'history', 'contact'])
    expect(spec.doc.sections).toEqual(['표지', '회사 소개', '진행 방식', '고객사', '연혁', '마무리'])
    // the progress after the second failed try: the left-out slide is gone from the plan the chat shows
    const ev = progress(chat)
    expect(ev.at(-1)!.slides.map((s) => s.kind)).toEqual(['cover', 'about', 'process', 'proof', 'history', 'contact'])
    // after the skip, `current` counts positions in that list: the process slide (outline index 3) is position 2
    const working = ev.find((e) => e.slides.some((x) => x.kind === 'process' && x.status === 'working') && e.slides.length === 6)!
    expect(working.current).toBe(2)
    expect(working.slides[working.current!]!.kind).toBe('process')
  })

  test('three failed covers end the build; nothing is made', async () => {
    const chat = await newChat()
    const bad: DeckSlide2 = { kind: 'cover', headline: '정밀 부품을 만드는 회사입니다.' }
    const answer = await typstOff(() => send('dana', chat, fake(step(outline()), slide(0, bad), slide(0, bad), slide(0, bad), slide(1))))
    expect(answer).toContain('slides[0] (cover) headline: no full stop at the end of a headline')
    expect(answer).toContain('The deck could not be made (the cover failed three times)')
    expect(answer).toContain('Call intro_deck with step "outline" first.')
    expect(builds(chat)[0]).toMatchObject({ status: 'failed' })
    expect(progress(chat).at(-1)!.phase).toBe('failed')
    expect(h.ctx.db.query('SELECT count(*) AS n FROM artifacts WHERE chat_id = ?').get(chat)).toEqual({ n: 0 })
  })

  test('accents: a hostile one is dropped and the slide made; at most two per deck; only on cover, opening and closing', async () => {
    const chat = await newChat()
    const stubs = [STUBS[0]!, STUBS[1]!, { kind: 'opening', section: '시작', headline: '도면 한 장이면 돼요' }, ...STUBS.slice(2)]
    const o = outline({ slides: stubs.map((s, i) => (i === 0 ? { ...s, picture: undefined } : s)), pictures: [] })
    const cover: DeckSlide2 = { kind: 'cover', headline: '정밀 부품을\n제때 만드는 회사', accent: '<svg viewBox="0 0 800 800"><script>alert(1)</script><circle cx="1" cy="1" r="1" fill="mark"/></svg>' }
    const opening: DeckSlide2 = { kind: 'opening', line: '도면 한 장이면 돼요', accent: ACCENT }
    const contact: DeckSlide2 = { ...SLIDES[6]!, accent: ACCENT } as DeckSlide2
    const cover2: DeckSlide2 = { ...cover, accent: ACCENT } as DeckSlide2
    const seq = [slide(0, cover), slide(1, SLIDES[1]), slide(2, opening), slide(3, SLIDES[2]), slide(4, SLIDES[3]), slide(5, SLIDES[4]), slide(6, SLIDES[5]), slide(7, contact)]
    const answer = await typstOff(() => send('dana', chat, fake(step(o), ...seq)))
    expect(answer).toContain('Slide 0 is done. Its accent was not used (')
    expect(answer).toContain('the drawn pattern stays')
    expect(answer).not.toContain('Slide 2 is done. Its accent was not used')
    const [b] = builds(chat)
    const st = JSON.parse(b!.state)
    expect(Object.keys(st.accents)).toEqual(['2', '7'])
    for (const svg of Object.values(st.accents) as string[]) { expect(svg).not.toContain('script'); expect(svg).toStartWith('<svg xmlns="http://www.w3.org/2000/svg"') }
    // a third accent: dropped
    const chat2 = await newChat()
    const answer2 = await typstOff(() => send('dana', chat2, fake(step(o), slide(0, cover2), slide(1, SLIDES[1]), slide(2, opening), slide(3, SLIDES[2]), slide(4, SLIDES[3]), slide(5, SLIDES[4]), slide(6, SLIDES[5]), slide(7, contact))))
    expect(answer2).toContain('The intro deck "아크메정밀 회사 소개서" is finished (8 slides')
    expect(Object.keys(JSON.parse(builds(chat2)[0]!.state).accents)).toEqual(['0', '2'])
    // the artifact's preview shows the accents as pictures, never inline markup
    const html = (h.ctx.db.query('SELECT content FROM artifacts WHERE chat_id = ?').get(chat2) as { content: string }).content
    expect(html).toContain('data:image/svg+xml;base64,')
    expect(html).not.toContain('<circle cx="400"')
  })

  test.if(withTypst)('with typst: each slide drawn as a picture; after the last one the pictures go to the AI; the one fix round', async () => {
    const chat = await newChat()
    const fixedAbout: DeckSlide2 = { kind: 'about', statement: '의료기기와 반도체 장비의 *정밀 부품*을 만듭니다', facts: [{ label: '설립', value: '2009년' }] }
    const badFix: DeckSlide2 = { kind: 'numbers', title: '숫자', figure: { kind: 'figures', items: [{ number: '999곳', label: '고객사' }, { number: '0.02%', label: '불량률' }] } }
    const o = outline({ slides: [...STUBS.slice(0, 6), { ...STUBS[6]! }] })
    const contact: DeckSlide2 = { ...SLIDES[6]!, accent: ACCENT } as DeckSlide2
    const answer = await send('dana', chat, fake(step(o), ...allSlides(0, 6), slide(6, contact, { sayResult: false, inspectImages: true }),
      { say: '\n' }, step({ step: 'finish', fixes: [{ index: 1, slide: fixedAbout }, { index: 2, slide: badFix }], drop_accents: [6] })))
    // the review: one picture per slide, phase review on the way
    const review = /\{"text":"Every slide is made[\s\S]*?\}\]\}/.exec(answer)
    void review
    const [b] = builds(chat)
    expect(b).toMatchObject({ status: 'done' })
    const ev = progress(chat)
    expect(ev.some((e) => e.phase === 'review')).toBe(true)
    expect(ev.every((e) => e.thumbs)).toBe(true)
    expect(answer).toContain('the change to slide 2 was not used')
    expect(answer).toContain('The intro deck "아크메정밀 회사 소개서" is finished (7 slides')
    const st = JSON.parse(b!.state)
    expect(st.reviewed).toBe(true)
    expect(st.accents).toEqual({})
    expect(st.slides[1].statement).toBe('의료기기와 반도체 장비의 *정밀 부품*을 만듭니다')
    expect(st.rev[1]).toBe(2)
    expect(st.slides[2].figure.items[0].number).toBe('340곳')
    // the slide pictures: 960 × 540 PNGs for the owner only
    const res = await h.req('dana', `/api/intro-decks/builds/${b!.id}/slides/0`)
    expect(res.status).toBe(200)
    const png = new Uint8Array(await res.arrayBuffer())
    expect([...png.subarray(1, 4)].map((c) => String.fromCharCode(c)).join('')).toBe('PNG')
    expect(new DataView(png.buffer, png.byteOffset).getUint32(16)).toBe(960)
    expect((await h.req('alice', `/api/intro-decks/builds/${b!.id}/slides/0`)).status).toBe(404)
    expect((await h.req('dana', `/api/intro-decks/builds/${b!.id}/slides/19`)).status).toBe(404)
    // the published deck has no accent left (dropped in the fix round)
    const html = (h.ctx.db.query('SELECT content FROM artifacts WHERE chat_id = ?').get(chat) as { content: string }).content
    expect(html).not.toContain('data:image/svg+xml')
  })

  test.if(withTypst)('with typst: the review result carries one picture per slide', async () => {
    const chat = await newChat()
    const answer = await send('dana', chat, fake(step(outline()), ...allSlides(0, 6), slide(6, SLIDES[6], { inspectImages: true })))
    const r = JSON.parse(answer.slice(answer.lastIndexOf('{"text":')).trim()) as { text: string; images: { mimeType: string; magic: string }[] }
    expect(r.text).toContain('Every slide is made. Here they are as pictures')
    expect(r.text).toContain('call intro_deck step "finish" once')
    expect(r.images).toHaveLength(7)
    for (const im of r.images) expect(im).toEqual({ mimeType: 'image/png', magic: '89504e470d0a1a0a' })
    expect(builds(chat)[0]).toMatchObject({ status: 'review' })
  })

  test.if(withTypst)('past 2:30 the AI review is skipped: the last slide finishes the deck', async () => {
    const chat = await newChat()
    const sent = await start('dana', chat, fake(step(outline()), ...allSlides(0, 6), { sleep: 2500 }, slide(6)))
    const turnId = (h.ctx.db.query('SELECT id FROM turns WHERE message_id = ?').get(sent.assistantMessage.id) as { id: string } | null)?.id
    await waitFor(() => { const b = builds(chat)[0]; return !!b && JSON.parse(b.state).slides.filter(Boolean).length === 6 }, { timeoutMs: 60_000 })
    const tid = turnId ?? (h.ctx.db.query('SELECT turn_id FROM intro_deck_builds WHERE chat_id = ?').get(chat) as { turn_id: string }).turn_id
    h.ctx.db.query('UPDATE turns SET started_at = ? WHERE id = ?').run(new Date(Date.now() - 180_000).toISOString(), tid)
    const answer = await finished(sent.assistantMessage.id)
    expect(answer).toContain('The intro deck "아크메정밀 회사 소개서" is finished (7 slides')
    expect(answer).not.toContain('Every slide is made. Here they are as pictures')
    expect(builds(chat)[0]).toMatchObject({ status: 'done' })
    expect(progress(chat).some((e) => e.phase === 'review')).toBe(false)
  })

  test('the downloads of a round-2 deck: the PowerPoint file with native shapes; the PDF through typst', async () => {
    const chat = await newChat()
    await typstOff(() => send('dana', chat, fake(step(outline()), ...allSlides())))
    const id = builds(chat)[0]!.artifact_id!
    const res = await h.req('dana', `/api/intro-decks/${id}/pptx`)
    expect(res.status).toBe(200)
    const zip = readZip(new Uint8Array(await res.arrayBuffer()))
    const xml = new Map<string, XNode>()
    for (const e of zip) if (/\.(xml|rels)$/.test(e.name)) xml.set(e.name, parseXml(Buffer.from(e.data).toString('utf8'), e.name))
    const slides = [...xml.keys()].filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    expect(slides).toHaveLength(7)
    // the figures are editable shapes: custom geometry with moveTo / lnTo / cubicBezTo; icons grouped
    const process = xml.get('ppt/slides/slide4.xml')!
    expect(all(process, 'a:custGeom').length).toBeGreaterThan(4)
    expect(all(process, 'a:moveTo').length).toBeGreaterThan(0)
    expect(all(process, 'p:grpSp').length).toBeGreaterThan(0)
    // the cover's drawn pattern and gradients are pictures; every relationship target is in the file
    const names = new Set(zip.map((e) => e.name))
    for (const [n, t] of xml) if (n.endsWith('.rels')) {
      const dir = path.posix.dirname(path.posix.dirname(n))
      for (const r of all(t, 'Relationship')) if (r.attrs.TargetMode !== 'External') expect(names.has(path.posix.normalize(path.posix.join(dir === '.' ? '' : dir, r.attrs.Target!))), `${n} → ${r.attrs.Target}`).toBe(true)
    }
    // the notes are the sources
    expect(all(xml.get('ppt/notesSlides/notesSlide3.xml')!, 'a:t').map((t) => t.text).join('\n')).toContain('출처: 회사 소개.md')
    if (withTypst && pdfAvailable()) {
      const pdf = await h.req('dana', `/api/intro-decks/${id}/pdf`)
      expect(pdf.status, await pdf.clone().text().then((t) => t.slice(0, 300))).toBe(200)
      const bytes = new Uint8Array(await pdf.arrayBuffer())
      expect(Buffer.from(bytes.subarray(0, 5)).toString('latin1')).toBe('%PDF-')
      const file = path.join(h.dataDir, 'intro-decks', `${id}.pdf`)
      const info = which('pdfinfo')
      if (info) expect(Number(/Pages:\s+(\d+)/.exec(Bun.spawnSync([info, file]).stdout.toString())![1])).toBe(7)
    }
  })

  test('purging the chat removes its builds and their pictures; another chat\'s stay', async () => {
    const gone = await newChat(), kept = await newChat()
    await typstOff(() => send('dana', gone, fake(step(outline()), ...allSlides())))
    await typstOff(() => send('dana', kept, fake(step(outline()), ...allSlides())))
    const g = builds(gone)[0]!.id, k = builds(kept)[0]!.id
    const dir = path.join(h.dataDir, 'intro-decks', 'builds')
    for (const id of [g, k]) { fs.mkdirSync(path.join(dir, id), { recursive: true }); fs.writeFileSync(path.join(dir, id, 's00.png'), 'PNG') }
    await h.api('dana').call(API.deleteChat, { params: { id: gone } })
    h.rt().purgeTrash()
    await h.rt().lastForget
    expect(fs.existsSync(path.join(dir, g))).toBe(true)
    h.ctx.db.query('UPDATE chats SET deleted_at = ? WHERE id = ?').run(new Date(Date.now() - 40 * 86400_000).toISOString(), gone)
    expect(h.rt().purgeTrash()).toBeGreaterThanOrEqual(1)
    await h.rt().lastForget
    expect(builds(gone)).toEqual([])
    expect(fs.existsSync(path.join(dir, g))).toBe(false)
    expect(fs.existsSync(path.join(dir, k, 's00.png'))).toBe(true)
  })
})
