// Onboarding V (docs/DECISIONS.md "V — The first result is the company's promo video"): the AI fills the slots of our
// template with the promo_video tool and the server checks them (lengths measured with the bundled font, numbers
// written in the sources, pictures from a brand folder, the style that fits the brand colour), builds the HyperFrames
// composition (five beats on a 120 BPM grid, CSS animations on one clock, music and effects) and keeps it as the chat's
// artifact; the MP4 is made only where the server can (a development Mac with the pinned CLI), from the checked slots,
// never from the artifact's HTML.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { API, PROMO_ARTIFACT_KEY, PromoVideoInput } from '@mycel/shared/api'
import { startHarness, type Harness } from '../lib/b-harness'
import { waitFor } from '../lib/wait'
import { charWidth, fitSize, textWidth, wrapLines } from '../../server/src/promo-video/metrics'
import { contrast } from '../../server/src/promo-video/colors'
import { fittingFamilies, paletteFor, usableBrand } from '../../server/src/promo-video/palette'
import { DURATION, END_SETTLED, SETTLED, STARTS, fitDoc, segments, splitNumber, type VideoDoc } from '../../server/src/promo-video/layout'
import { hasNumber, inBrandFolder, numbersIn, spaced, squash } from '../../server/src/promo-video/spec'
import { artifactDocument, composition, renderDocument } from '../../server/src/promo-video/template'
import { AUDIO_DIR, SOUNDS, audioCues } from '../../server/src/promo-video/audio'
import { logoTreatFromPixels } from '../../server/src/promo-video/logo'
import { killTree, mp4Available, setRenderTimeoutForTests } from '../../server/src/promo-video/render'

setDefaultTimeout(60_000)

function png(w: number, h: number, pad = 4096): Buffer {
  const b = Buffer.alloc(33 + pad)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).copy(b, 0)
  b.write('IHDR', 12, 'latin1')
  b.writeUInt32BE(w, 16)
  b.writeUInt32BE(h, 20)
  b[24] = 8; b[25] = 6
  return b
}
const P = (src: string, w = 1600, h = 1200) => ({ src, width: w, height: h, focus: 'center' })
const doc = (over: Partial<VideoDoc> = {}): VideoDoc => ({
  family: 'ink', lang: 'ko', company: '아크메', website: 'acme.example', brand: '#1f4fd8', music: 'bright',
  logo: { ...P('/shared/브랜드/이미지/logo.png', 600, 600), treat: 'direct' },
  hook: { label: '공장 전기요금 확인', before: '한 달 뒤', after: '18%', line: '2025년 도입 고객 기준', mode: 'strike' },
  promise: { headline: ['설비마다 센서 하나,', '*새는 전기*가 보여요'], sub: '공장 설비의 전력 사용을 실시간으로 보여 줘요', picture: P('/shared/브랜드/이미지/a.png') },
  work: { kicker: '공장 에너지 관리', headline: ['대시보드에서', '바로 확인해요'], points: ['설비별 사용량', '이상 알림'], picture: P('/shared/브랜드/이미지/b.png', 1600, 2400) },
  proof: { stats: [{ number: '18%', label: '평균 전기요금 절감' }, { number: '87', label: '도입 사업장' }], headline: [], sub: '', picture: null },
  cta: { line: '공장 에너지 관리 파트너', offer: '무료 진단' },
  ...over,
})

describe('measuring, colours, numbers and families (pure)', () => {
  test('the bundled font\'s widths: every Hangul syllable 0.864 em, Latin narrower; lines break only at spaces', () => {
    expect(charWidth('가', 800)).toBe(864)
    expect(charWidth('힣', 500)).toBe(864)
    expect(charWidth('i', 700)).toBeLessThan(charWidth('W', 700))
    expect(textWidth('가나다', 100, 800)).toBeCloseTo(259.2, 5)
    expect(textWidth('가나다', 100, 800, -0.04)).toBeCloseTo(259.2 - 12, 5)
    expect(wrapLines('공장 설비의 전력 사용을 실시간으로', 300, 36, 500)).toEqual(['공장 설비의 전력', '사용을 실시간으로'])
    expect(wrapLines('가나다라마바사아자차카타파하', 300, 36, 500)).toBeNull()
    expect(fitSize(['가나다라'], 904, 800, -0.04, 156, 72)).toBe(156)
    expect(fitSize(['가나다라마바사아자차카타파하가나다라'], 904, 800, -0.04, 156, 72)).toBeNull()
  })

  test('families from the brand colour: a vivid colour burns as light (ink first), a deep one becomes the ground (deep first), none or grey is mono only', () => {
    expect(fittingFamilies('#ff5a1f')).toEqual(['ink', 'deep', 'mono'])
    expect(fittingFamilies('#1e4620')).toEqual(['deep', 'ink', 'mono'])
    expect(fittingFamilies(null)).toEqual(['mono'])
    expect(fittingFamilies('#808080')).toEqual(['mono'])
    expect(fittingFamilies('#050505')).toEqual(['mono'])
    expect(usableBrand('#fafafa')).toBe(false)
    // every accent reads on its ground by 4.5:1 (the card news' rule), whatever the brand colour
    for (const brand of ['#ff5a1f', '#1e4620', '#ffd400', '#0a1f6b', '#a8c5a0', '#e60012', null]) {
      for (const f of ['ink', 'deep', 'mono'] as const) {
        const c = paletteFor(f, brand)
        expect(contrast(c.accent, c.ground)).toBeGreaterThanOrEqual(4.5)
        expect(contrast(c.text, c.ground)).toBeGreaterThanOrEqual(7)
        // the offer pill: bold 40 px type, large text by WCAG (3:1)
        expect(contrast(c.onAccent, c.accent)).toBeGreaterThanOrEqual(3)
      }
    }
    // without a usable colour every family is the neutral one (nothing invented)
    expect(paletteFor('ink', null).family).toBe('mono')
  })

  test('numbers: as written, whole numbers only ("87" is not in "1,870"), whitespace aside; a stat split into sign, digits and unit', () => {
    expect(numbersIn('87개 사업장, 평균 18% 절감, 1,200곳, 3.5배')).toEqual(['87', '18', '1,200', '3.5'])
    const src = spaced('도입한 1,870개 사업장의 평균 18 % 절감 (2025년). 3.87배')
    expect(hasNumber(src, '1,870')).toBe(true)
    expect(hasNumber(spaced('bills. 87 plants'), '87')).toBe(true)
    expect(hasNumber(src, '3.87')).toBe(true)
    expect(hasNumber(src, '87')).toBe(false)
    expect(hasNumber(src, '870')).toBe(false)
    expect(squash('평균 18 % 절감').includes(squash('18%'))).toBe(true)
    expect(splitNumber('+300%')).toEqual({ pre: '+', digits: '300', unit: '%' })
    expect(splitNumber('1,200곳')).toEqual({ pre: '', digits: '1,200', unit: '곳' })
    expect(splitNumber('×5')).toEqual({ pre: '×', digits: '5', unit: '' })
    expect(splitNumber('4.92')).toEqual({ pre: '', digits: '4.92', unit: '' })
    expect(segments('한 번 세팅하면, *팀 전체*가 씁니다')).toEqual([{ text: '한 번 세팅하면, ', accent: false }, { text: '팀 전체', accent: true }, { text: '가 씁니다', accent: false }])
  })

  test('brand folders: groups/<team>/<브랜드>/… or shared/<브랜드>/…, in any language; nothing else', () => {
    expect(inBrandFolder('groups/마케팅팀/브랜드/이미지/a.png')).toBe(true)
    expect(inBrandFolder('groups/Acme/Brand/Images/a.png')).toBe(true)
    expect(inBrandFolder('shared/브랜드/a.png')).toBe(true)
    expect(inBrandFolder('groups/마케팅팀/회의록/a.png')).toBe(false)
    expect(inBrandFolder('users/dana/브랜드/a.png')).toBe(false)
    expect(inBrandFolder('groups/브랜드/a.png')).toBe(false)
  })

  test('a line too wide for its place is a problem in the AI\'s terms; one that fits gets the largest size', () => {
    const ok = fitDoc(doc())
    expect(ok.problems).toEqual([])
    expect(ok.sizes!.hook.before).toBeGreaterThanOrEqual(200)
    expect(ok.sizes!.promise.headline).toBeGreaterThanOrEqual(68)
    const bad = fitDoc(doc({ promise: { headline: ['어디서 새는지 아무도 모르던 공장의 전기요금'], sub: '', picture: null } }))
    expect(bad.sizes).toBeNull()
    expect(bad.problems.join('\n')).toMatch(/promise\.headline line: .* too wide/)
    const sub = fitDoc(doc({ promise: { headline: ['짧게'], sub: '월말 고지서가 나와야 사용량을 알 수 있었고 어느 설비가 얼마를 쓰는지도 몰라서 줄일 방법을 찾지 못했어요 그래서 이 문장은 화면 두 줄에 다 들어가지 않을 만큼 아주 길게 씁니다', picture: null } }))
    expect(sub.problems.join('\n')).toMatch(/promise\.sub: the sentence is too long/)
    expect(fitDoc(doc({ hook: { label: '시간', before: '아주 오래 걸리던 그 모든 일들', after: '짧게', line: '', mode: 'swap' } })).problems.join('\n')).toMatch(/hook\.before/)
  })

  test('the logo on the dark end card, from its pixels: opaque → tile, light → as it is, dark grey → white, dark in colour → a light card', () => {
    const px = (rgba: [number, number, number, number], n = 1024, bg?: [number, number, number, number]) => {
      const b = new Uint8Array(n * 4)
      for (let i = 0; i < n; i++) b.set(bg && i % 2 ? bg : rgba, i * 4)
      return b
    }
    const ground = '#0b0b0c'
    expect(logoTreatFromPixels(px([255, 255, 255, 255]), ground)).toBe('tile')
    expect(logoTreatFromPixels(px([250, 120, 30, 255], 1024, [0, 0, 0, 0]), ground)).toBe('direct')
    expect(logoTreatFromPixels(px([20, 20, 20, 255], 1024, [0, 0, 0, 0]), ground)).toBe('white')
    expect(logoTreatFromPixels(px([10, 30, 120, 255], 1024, [0, 0, 0, 0]), ground)).toBe('chip')
  })
})

describe('the composition and the sound (pure)', () => {
  test('one 4:5 root on a 120 BPM grid: five scenes, every scene start and the end card on a beat, every delay a plain number', () => {
    for (const family of ['ink', 'deep', 'mono'] as const) {
      const c = composition(doc({ family }), true)
      expect(c.root).toContain('data-composition-id="promo"')
      expect(c.root).toContain('data-width="1080" data-height="1350"')
      expect(c.root).toContain(`data-duration="${DURATION}"`)
      expect((c.root.match(/<section class="sc /g) ?? []).length).toBe(5)
      // the HyperFrames CSS adapter rewrites delays written with var(); every animation is plain seconds
      expect(c.root).not.toMatch(/animation:[^"]*var\(/)
      expect(c.css).toContain('@property --pvn')
      // no GSAP, no script, no address of the web in the composition
      expect(c.root + c.css).not.toMatch(/gsap|<script|https?:\/\//i)
    }
    for (const s of STARTS) expect((s * 2) % 1).toBe(0)
    expect(DURATION).toBeGreaterThanOrEqual(15)
    expect(DURATION).toBeLessThanOrEqual(20)
    // the end card holds at least two seconds after its last motion settles; the stills show each beat settled
    expect(DURATION - END_SETTLED).toBeGreaterThanOrEqual(2)
    expect(SETTLED).toHaveLength(5)
  })

  test('missing pictures make type-and-light beats (never an empty frame); a proof without numbers is a statement', () => {
    const c = composition(doc({ promise: { headline: ['한 번 세팅하면,', '*팀 전체*가 씁니다'], sub: '', picture: null }, work: { kicker: '하는 일', headline: ['설비마다 센서'], points: ['설비별 사용량'], picture: null }, proof: { stats: [], headline: ['합정에서 *제주까지*'], sub: '네 곳의 매장', picture: null }, logo: null }), true)
    expect(c.root).not.toContain('<img')
    expect(c.root).toContain('class="threads"')
    expect(c.root).toContain('class="row"')
    expect(c.root).toContain('class="horizon"')
    const proof = c.root.slice(c.root.indexOf('class="sc s3"'), c.root.indexOf('class="sc s4"'))
    expect(proof).not.toContain('class="cnt')
    expect(proof).toContain('제주까지')
    // a particle after the key phrase stays attached (no space the line does not have)
    const stuck = composition(doc({ proof: { stats: [], headline: ['구체적인 *성과*로'], sub: '', picture: null } }), true).root
    expect(stuck).toMatch(/>성과<\/span><span class="wd" [^>]*>로</)
    // the counts: a registered integer counted by CSS, the exact text taking over when it lands
    const n = composition(doc(), true)
    expect(n.root).toContain('class="cnt f0 g"')
    expect(n.root).toContain('class="fin g"')
  })

  test('sounds: three beds and six effects, the bed from frame 0, every effect peaking on a beat of the grid', () => {
    const cues = audioCues(doc())
    expect(cues[0]).toMatchObject({ id: 'bed', file: 'bed-bright', start: 0 })
    for (const q of cues.slice(1)) {
      const s = SOUNDS.find((x) => x.name === q.file)!
      expect(s.kind).toBe('sfx')
      expect(((q.start + s.peak) * 4) % 1).toBeCloseTo(0, 5)
    }
    expect(audioCues(doc({ hook: { ...doc().hook, mode: 'swap' } })).find((q) => q.id === 'sfx-swap')?.file).toBe('click')
  })

  test('every sound file is listed with an allowed licence (CC0 or public domain) and its source, and nothing else is in the folder', () => {
    const files = fs.readdirSync(AUDIO_DIR).filter((f) => !f.startsWith('.')).sort()
    expect(files).toEqual([...SOUNDS.map((s) => `${s.name}.m4a`), 'SOURCES.md'].sort())
    const sources = fs.readFileSync(path.join(AUDIO_DIR, 'SOURCES.md'), 'utf8')
    for (const s of SOUNDS) {
      const row = sources.split('\n').find((l) => l.startsWith(`| ${s.name}.m4a |`))
      expect(row, s.name).toBeDefined()
      expect(row!).toMatch(/\| (CC0 1\.0|Public domain|Made for this repository \(CC0 1\.0\)) \|/)
      expect(row!).toMatch(/https:\/\/|scripts\/promo-video\//)
    }
    expect(sources).not.toMatch(/pixabay|musicgen|CC[- ]BY/i)
    // the third-party notices list them too
    expect(fs.readFileSync(path.join(import.meta.dir, '../../docs/THIRD-PARTY-NOTICES.md'), 'utf8')).toContain('resources/promo-video/audio/SOURCES.md')
  })

  test('text is escaped; pictures by team path in the chat, files beside it for the render; the chat plays muted with a sound button', () => {
    const d = doc()
    d.promise = { ...d.promise, headline: ['<script>x</script>'], sub: '"quoted" & <b>' }
    const page = artifactDocument(d, { fontCss: '/vendor/fonts/promo-video.css', audioBase: '/vendor/promo-video/', cues: audioCues(d), title: 'A <title>', text: { play: '재생', pause: '일시정지', soundOn: '소리 켜기', soundOff: '소리 끄기', stills: '장면 {n}' } })
    expect(page).not.toContain('<script>x</script>')
    expect(page).toContain('&lt;script&gt;x&lt;/script&gt;')
    expect(page).toContain('src="/shared/브랜드/이미지/a.png"')
    expect(page).toContain('<link rel="stylesheet" href="/vendor/fonts/promo-video.css">')
    expect(page).not.toMatch(/https?:\/\//)
    expect(page).toContain('class="pv-snd" aria-pressed="false" aria-label="소리 켜기"')
    expect(page).toContain('"/vendor/promo-video/"')
    expect(page).not.toContain('<audio')
    expect(page).toContain('prefers-reduced-motion: reduce')
    const render = renderDocument({ ...d, promise: { ...d.promise, picture: { ...d.promise.picture!, src: 'img/1.png' } } }, 'fonts/PretendardVariable.woff2', { cues: audioCues(d), url: (f) => `audio/${f}.m4a`, durationOf: () => 1 })
    expect(render).toContain('@font-face{font-family:"Pretendard Promo";src:url("fonts/PretendardVariable.woff2")')
    expect(render).toContain('src="img/1.png"')
    expect(render).toContain('<audio id="bed" src="audio/bed-bright.m4a" data-start="0"')
    expect(render).not.toContain('<script')
  })
})

describe('the promo_video tool and the MP4 (a real app, the fake engine)', () => {
  let h: Harness
  const hfDir = path.join(os.tmpdir(), `mycel-hf-${process.pid}`)
  beforeAll(async () => {
    process.env.MYCEL_HYPERFRAMES_DIR = path.join(hfDir, 'none')
    h = await startHarness({ name: 'b-promo-video' })
    const put = (rel: string, b: Buffer | string) => { fs.mkdirSync(path.dirname(path.join(h.team, rel)), { recursive: true }); fs.writeFileSync(path.join(h.team, rel), b) }
    put('shared/Brand/Company intro.md', '# Acme\n\nAcme cuts factory power bills. 87 plants use it; the bill fell by 18% on average (2025 customers).\nWebsite: acme.example\n')
    put('shared/Brand/Images/factory.png', png(1600, 1200))
    put('shared/Brand/Images/tiny.png', png(300, 300))
    put('shared/Brand/Images/logo.png', png(600, 160))
    put('shared/Other/elsewhere.png', png(1600, 1200))
  })
  afterAll(async () => { await h?.close(); fs.rmSync(hfDir, { recursive: true, force: true }); delete process.env.MYCEL_HYPERFRAMES_DIR })

  const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
  const send = async (user: string, chatId: string, content: string) => {
    const r = await h.api(user).call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [] } })
    await waitFor(() => (h.ctx.db.query('SELECT status FROM messages WHERE id = ?').get(r.assistantMessage.id) as { status: string }).status !== 'streaming', { timeoutMs: 30_000 })
    const row = h.ctx.db.query('SELECT * FROM messages WHERE id = ?').get(r.assistantMessage.id) as { content: string }
    if (process.env.PV_DEBUG) console.log('DEBUG', JSON.stringify(row).slice(0, 3000))
    return row.content
  }
  const slots = (over: Record<string, unknown> = {}) => ({
    title: 'Acme promo video', company: 'Acme', website: 'acme.example', brand_color: '#0E5E4E', logo: 'shared/Brand/Images/logo.png',
    sources: ['shared/Brand/Company intro.md'],
    hook: { label: 'Your power bill', before: 'Guesswork', after: '18%', line: 'Customers as of 2025' },
    promise: { headline: ['See where the power', '*goes*'], sub: 'Live power data for every machine.', picture: 'shared/Brand/Images/factory.png' },
    work: { kicker: 'Factory energy', headline: ['One sensor', 'per machine'], points: ['Live usage', 'Leak alerts'] },
    proof: { stats: [{ number: '18%', label: 'lower power bill' }, { number: '87', label: 'plants' }] },
    cta: { line: 'Factory energy partner', offer: 'Free audit' },
    ...over,
  })

  test('the slots are a strict schema (no HTML field, the five beats, colours as #rrggbb, at most two stats)', () => {
    expect(PromoVideoInput.safeParse(slots()).success).toBe(true)
    expect(PromoVideoInput.safeParse({ ...slots(), html: '<p>x</p>' }).success).toBe(false)
    expect(PromoVideoInput.safeParse({ ...slots(), brand_color: 'red' }).success).toBe(false)
    expect(PromoVideoInput.safeParse({ ...slots(), style: 'neon' }).success).toBe(false)
    expect(PromoVideoInput.safeParse({ ...slots(), promise: { headline: ['a', 'b', 'c'] } }).success).toBe(false)
    expect(PromoVideoInput.safeParse({ ...slots(), proof: { stats: [1, 2, 3].map((n) => ({ number: `${n}`, label: 'x' })) } }).success).toBe(false)
  })

  test('every problem at once: a made-up number, a picture outside the brand folder or too small, a line too wide; nothing made', async () => {
    const chat = await h.api('dana').call(API.createChat, { body: {} })
    const bad = slots({
      promise: { headline: ['See every machine on every floor'], picture: 'shared/Other/elsewhere.png' },
      work: { kicker: 'Factory energy', headline: ['Running in 90 plants'], picture: 'shared/Brand/Images/tiny.png' },
      proof: { stats: [{ number: '20%', label: 'lower power bill' }] },
    })
    const answer = await send('dana', chat.id, fake({ tool: 'promo_video', args: bad, sayResult: true }))
    expect(answer).toContain('Nothing was made yet')
    expect(answer).toContain('"20%" is not written in the sources')
    expect(answer).toContain('the number "90" is not in the sources')
    expect(answer).toContain('is not in a brand folder')
    expect(answer).toContain('is too small (300×300')
    expect(answer).toMatch(/promise\.headline line: .* too wide/)
    expect(h.ctx.db.query('SELECT count(*) AS n FROM artifacts WHERE chat_id = ?').get(chat.id)).toEqual({ n: 0 })
    // a second failure in the same answer: stop and say why; a third call is refused at once
    const twice = await send('dana', chat.id, fake({ tool: 'promo_video', args: bad, sayResult: true }, { tool: 'promo_video', args: bad, sayResult: true }, { tool: 'promo_video', args: slots(), sayResult: true }))
    expect(twice).toContain('Do not call promo_video again in this answer')
    expect(h.ctx.db.query('SELECT count(*) AS n FROM promo_videos WHERE chat_id = ?').get(chat.id)).toEqual({ n: 0 })
  })

  test('checked slots: the video is the chat\'s artifact "promo-video", built from our template, its slots kept for the MP4', async () => {
    const chat = await h.api('dana').call(API.createChat, { body: {} })
    const answer = await send('dana', chat.id, fake({ tool: 'promo_video', args: slots(), sayResult: true }))
    expect(answer).toContain('Made the promo video "Acme promo video"')
    expect(answer).toContain('beats made with type and light instead of a picture: work')
    const art = h.ctx.db.query('SELECT id, key, type, title, content, version FROM artifacts WHERE chat_id = ?').get(chat.id) as { id: string; key: string; type: string; title: string; content: string; version: number }
    expect(art).toMatchObject({ key: PROMO_ARTIFACT_KEY, type: 'html', title: 'Acme promo video', version: 1 })
    expect(art.content).toContain('data-composition-id="promo"')
    // a deep teal: the brand's own colour becomes the ground (the server's choice, no style given)
    expect(art.content).toContain('class="pv pv--deep"')
    expect(art.content).toContain('class="pv-snd"')
    expect(art.content).toContain('src="/shared/Brand/Images/factory.png"')
    const row = h.ctx.db.query('SELECT user_id, spec, mp4_state FROM promo_videos WHERE artifact_id = ?').get(art.id) as { user_id: string; spec: string; mp4_state: string }
    expect(row.user_id).toBe('dana')
    expect(row.mp4_state).toBe('none')
    const spec = JSON.parse(row.spec)
    expect(spec.doc.website).toBe('acme.example')
    expect(spec.doc.brand).toBe('#0e5e4e')
    expect(spec.sources).toEqual(['shared/Brand/Company intro.md'])
    // the info: no MP4 where this server cannot make one (no CLI here): no button, and the start is refused
    const info = await h.api('dana').call(API.getPromoVideo, { params: { id: art.id } })
    expect(info).toMatchObject({ artifactId: art.id, chatId: chat.id, title: 'Acme promo video', style: 'deep', mp4: { available: false, state: 'none' } })
    expect((await h.req('dana', `/api/promo-videos/${art.id}/mp4`, { method: 'POST' })).status).toBe(404)
    // someone else's video is not found
    expect((await h.req('alice', `/api/promo-videos/${art.id}`)).status).toBe(404)
    // a second call makes a new version of the same artifact
    const again = await send('dana', chat.id, fake({ tool: 'promo_video', args: slots({ style: 'mono' }), sayResult: true }))
    expect(again).toContain('the "Mono" style')
    expect(h.ctx.db.query('SELECT max(version) AS v FROM artifacts WHERE chat_id = ? AND key = ?').get(chat.id, PROMO_ARTIFACT_KEY)).toEqual({ v: 2 })
    // a style that does not fit the colour is replaced by one that does, never refused
    const grey = await send('dana', chat.id, fake({ tool: 'promo_video', args: slots({ style: 'ink', brand_color: '#808080' }), sayResult: true }))
    expect(grey).toContain('so the server used "mono"')
  })

  test.if(process.platform === 'darwin' && !!Bun.which('node'))('the MP4 on a development Mac: the pinned CLI renders the checked slots (the pictures copied out with the owner\'s permissions); one download', async () => {
    // a stand-in for the CLI: checks what it is given and writes a small file where --output says
    const cli = path.join(hfDir, 'ok', 'node_modules', 'hyperframes', 'bin')
    fs.mkdirSync(cli, { recursive: true })
    fs.writeFileSync(path.join(cli, 'hyperframes.mjs'), `import fs from 'node:fs'
const a = process.argv.slice(2), dir = a[1], out = a[a.indexOf('--output') + 1]
const html = fs.readFileSync(dir + '/index.html', 'utf8')
if (!html.includes('data-composition-id="promo"') || !fs.existsSync(dir + '/fonts/PretendardVariable.woff2') || !fs.existsSync(dir + '/img/1.png') || !fs.existsSync(dir + '/audio/bed-calm.m4a') || !html.includes('src="audio/bed-calm.m4a"') || html.includes('/shared/')) process.exit(3)
if (process.env.HYPERFRAMES_NO_TELEMETRY !== '1') process.exit(4)
fs.writeFileSync(out, 'MP4-BYTES')
`)
    process.env.MYCEL_HYPERFRAMES_DIR = path.join(hfDir, 'ok')
    expect(mp4Available(h.ctx)).toBe(true)
    const chat = await h.api('dana').call(API.createChat, { body: {} })
    await send('dana', chat.id, fake({ tool: 'promo_video', args: slots(), sayResult: true }))
    const id = (h.ctx.db.query('SELECT artifact_id FROM promo_videos WHERE chat_id = ?').get(chat.id) as { artifact_id: string }).artifact_id
    expect((await h.api('dana').call(API.getPromoVideo, { params: { id } })).mp4.available).toBe(true)
    const started = await h.api('dana').call(API.renderPromoVideo, { params: { id } })
    expect(['rendering', 'done']).toContain(started.mp4.state)
    await waitFor(async () => (await h.api('dana').call(API.getPromoVideo, { params: { id } })).mp4.state === 'done', { timeoutMs: 20_000 })
    const res = await h.req('dana', `/api/promo-videos/${id}/mp4`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('MP4-BYTES')
    expect(res.headers.get('content-disposition')).toContain('Acme%20promo%20video.mp4')
    // the work folder is gone; the MP4 is kept and given again without a second render
    expect(fs.readdirSync(path.join(h.dataDir, 'promo-videos')).filter((f) => f.startsWith('work-'))).toEqual([])
    expect((await h.api('dana').call(API.renderPromoVideo, { params: { id } })).mp4.state).toBe('done')
    // not a development server (office mode): no MP4
    expect(mp4Available({ config: { ...h.ctx.config, office: true } })).toBe(false)
    expect(mp4Available({ config: { ...h.ctx.config, mode: 'prod' } })).toBe(false)
    process.env.MYCEL_HYPERFRAMES_DIR = path.join(hfDir, 'none')
  })

  test('the trash keeps the MP4; purging the chat removes it and a cut-off part file, never another video\'s', async () => {
    const make = async () => {
      const chat = await h.api('dana').call(API.createChat, { body: {} })
      await send('dana', chat.id, fake({ tool: 'promo_video', args: slots(), sayResult: true }))
      return { chat: chat.id, id: (h.ctx.db.query('SELECT artifact_id FROM promo_videos WHERE chat_id = ?').get(chat.id) as { artifact_id: string }).artifact_id }
    }
    const gone = await make(), kept = await make()
    const dir = path.join(h.dataDir, 'promo-videos')
    fs.mkdirSync(dir, { recursive: true })
    const files = [`${gone.id}.mp4`, `${gone.id}.mp4.part.mp4`, `${kept.id}.mp4`]
    for (const f of files) fs.writeFileSync(path.join(dir, f), 'MP4')
    await h.api('dana').call(API.deleteChat, { params: { id: gone.chat } })
    h.rt().purgeTrash()
    await h.rt().lastForget
    expect(files.filter((f) => fs.existsSync(path.join(dir, f)))).toEqual(files)
    h.ctx.db.query('UPDATE chats SET deleted_at = ? WHERE id = ?').run(new Date(Date.now() - 40 * 86400_000).toISOString(), gone.chat)
    expect(h.rt().purgeTrash()).toBeGreaterThanOrEqual(1)
    await h.rt().lastForget
    expect(h.ctx.db.query('SELECT count(*) AS n FROM promo_videos WHERE chat_id = ?').get(gone.chat)).toEqual({ n: 0 })
    expect(files.filter((f) => fs.existsSync(path.join(dir, f)))).toEqual([`${kept.id}.mp4`])
  })

  // a stand-in for the CLI that starts a "browser" in a process group of its own (as puppeteer starts Chrome), writes
  // both process ids next to it and never ends
  const hanging = (name: string) => {
    const root = path.join(hfDir, name)
    fs.mkdirSync(path.join(root, 'node_modules', 'hyperframes', 'bin'), { recursive: true })
    fs.writeFileSync(path.join(root, 'node_modules', 'hyperframes', 'bin', 'hyperframes.mjs'), `import fs from 'node:fs'
import { spawn } from 'node:child_process'
const browser = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })
fs.writeFileSync('pids.tmp', JSON.stringify({ cli: process.pid, browser: browser.pid }))
fs.renameSync('pids.tmp', 'pids.json')
setInterval(() => {}, 1000)
`)
    return root
  }
  const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' } }
  const pidsOf = async (root: string) => {
    expect(await waitFor(() => fs.existsSync(path.join(root, 'pids.json')), { timeoutMs: 20_000 })).toBe(true)
    return JSON.parse(fs.readFileSync(path.join(root, 'pids.json'), 'utf8')) as { cli: number; browser: number }
  }
  /** what a failed test leaves running: stopped by the process ids the stand-in wrote */
  const stop = (root: string) => {
    let p: { cli?: number; browser?: number } = {}
    try { p = JSON.parse(fs.readFileSync(path.join(root, 'pids.json'), 'utf8')) } catch { return }
    for (const pid of [p.cli, p.browser]) if (pid && alive(pid)) try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
  }

  test('killTree: the process, its group and the group of a child that started its own, by process id', async () => {
    const root = hanging('tree')
    const { spawn } = await import('node:child_process')
    const cli = spawn(process.execPath, [path.join(root, 'node_modules', 'hyperframes', 'bin', 'hyperframes.mjs')], { cwd: root, detached: true, stdio: 'ignore' })
    try {
      const p = await pidsOf(root)
      expect(p.cli).toBe(cli.pid!)
      expect([alive(p.cli), alive(p.browser)]).toEqual([true, true])
      killTree(cli.pid!)
      expect(await waitFor(() => !alive(p.browser), { timeoutMs: 10_000 })).toBe(true)
      await new Promise<void>((r) => (cli.exitCode !== null || cli.signalCode !== null ? r() : cli.on('exit', () => r())))
      expect(cli.signalCode).toBe('SIGKILL')
    } finally {
      stop(root)
      if (cli.pid && alive(cli.pid)) cli.kill('SIGKILL')
    }
  })

  test.if(process.platform === 'darwin' && !!Bun.which('node'))('the time limit ends the render and the browser it started in a group of its own; the row says failed', async () => {
    const root = hanging('slow')
    process.env.MYCEL_HYPERFRAMES_DIR = root
    setRenderTimeoutForTests(1500)
    try {
      const chat = await h.api('dana').call(API.createChat, { body: {} })
      await send('dana', chat.id, fake({ tool: 'promo_video', args: slots(), sayResult: true }))
      const id = (h.ctx.db.query('SELECT artifact_id FROM promo_videos WHERE chat_id = ?').get(chat.id) as { artifact_id: string }).artifact_id
      expect((await h.api('dana').call(API.renderPromoVideo, { params: { id } })).mp4.state).toBe('rendering')
      const p = await pidsOf(root)
      expect(await waitFor(async () => (await h.api('dana').call(API.getPromoVideo, { params: { id } })).mp4.state === 'failed', { timeoutMs: 20_000 })).toBe(true)
      expect(await waitFor(() => !alive(p.cli) && !alive(p.browser), { timeoutMs: 10_000 })).toBe(true)
      expect(fs.existsSync(path.join(h.dataDir, 'promo-videos', `${id}.mp4`))).toBe(false)
    } finally {
      stop(root)
      setRenderTimeoutForTests(null)
      process.env.MYCEL_HYPERFRAMES_DIR = path.join(hfDir, 'none')
    }
  })

  test.if(process.platform === 'darwin' && !!Bun.which('node'))('a server that shuts down ends a running render and its browser', async () => {
    const root = hanging('shutdown')
    process.env.MYCEL_HYPERFRAMES_DIR = root
    const h2 = await startHarness({ name: 'b-promo-video-close' })
    try {
      fs.mkdirSync(path.join(h2.team, 'shared/Brand/Images'), { recursive: true })
      fs.copyFileSync(path.join(h.team, 'shared/Brand/Company intro.md'), path.join(h2.team, 'shared/Brand/Company intro.md'))
      for (const f of ['factory.png', 'logo.png']) fs.copyFileSync(path.join(h.team, 'shared/Brand/Images', f), path.join(h2.team, 'shared/Brand/Images', f))
      const chat = await h2.api('dana').call(API.createChat, { body: {} })
      const r = await h2.api('dana').call(API.sendMessage, { params: { id: chat.id }, body: { content: fake({ tool: 'promo_video', args: slots(), sayResult: true }), clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [] } })
      await waitFor(() => (h2.ctx.db.query('SELECT status FROM messages WHERE id = ?').get(r.assistantMessage.id) as { status: string }).status !== 'streaming', { timeoutMs: 30_000 })
      const id = (h2.ctx.db.query('SELECT artifact_id FROM promo_videos WHERE chat_id = ?').get(chat.id) as { artifact_id: string }).artifact_id
      await h2.api('dana').call(API.renderPromoVideo, { params: { id } })
      const p = await pidsOf(root)
      await h2.close()
      expect(await waitFor(() => !alive(p.cli) && !alive(p.browser), { timeoutMs: 10_000 })).toBe(true)
    } finally {
      stop(root)
      await h2.close().catch(() => {})
      process.env.MYCEL_HYPERFRAMES_DIR = path.join(hfDir, 'none')
    }
  })
})
