// Onboarding V (docs/DECISIONS.md "V — The first result is the company's promo video"): the AI fills the slots of our
// templates with the promo_video tool and the server checks them (lengths measured with the bundled font, numbers
// written in the sources, pictures from a brand folder, colours), builds the HyperFrames composition and keeps it as the
// chat's artifact; the MP4 is made only where the server can (a development Mac with the pinned CLI), from the checked
// slots, never from the artifact's HTML.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { API, PROMO_ARTIFACT_KEY, PromoVideoInput } from '@mycel/shared/api'
import { startHarness, type Harness } from '../lib/b-harness'
import { waitFor } from '../lib/wait'
import { charWidth, fitSize, textWidth, wrapLines } from '../../server/src/promo-video/metrics'
import { contrast, onColor, towardContrast } from '../../server/src/promo-video/colors'
import { BRAND, fitScene, sceneTimes, type PromoDoc } from '../../server/src/promo-video/layout'
import { hasNumber, inBrandFolder, numbersIn, spaced, squash } from '../../server/src/promo-video/spec'
import { artifactDocument, composition, renderDocument } from '../../server/src/promo-video/template'
import { mp4Available } from '../../server/src/promo-video/render'

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
const doc = (over: Partial<PromoDoc> = {}): PromoDoc => ({
  style: 'bold', lang: 'ko', company: '아크메', website: 'acme.example', brand: '#1f4fd8', logo: P('/shared/브랜드/이미지/logo.png', 600, 160),
  scenes: [
    { kind: 'cover', eyebrow: '공장 에너지 관리', headline: ['전기요금,', '이제 줄여서 봅니다'], sub: '공장 설비의 전력 사용을 실시간으로 보여 줘요', picture: P('/shared/브랜드/이미지/a.png') },
    { kind: 'problem', eyebrow: '이런 고민', headline: ['어디서 새는지', '아무도 몰랐어요'], sub: '고지서가 나와야 알 수 있었어요', picture: null },
    { kind: 'solution', eyebrow: '하는 일', headline: ['설비마다 센서 하나'], sub: '대시보드에서 바로 확인해요', picture: null },
    { kind: 'proof', eyebrow: '도입 효과', number: '18%', label: '평균 전기요금 절감', headline: ['87개 사업장이', '먼저 확인했어요'], sub: '2025년 도입 고객 기준', picture: null },
    { kind: 'cta', eyebrow: '무료 진단', headline: ['우리 공장도', '확인해 보세요'], sub: '일주일 안에 진단 리포트를 드려요', picture: null },
  ],
  ...over,
})

describe('measuring, colours and numbers (pure)', () => {
  test('the bundled font\'s widths: every Hangul syllable 0.864 em, Latin narrower; lines break only at spaces', () => {
    expect(charWidth('가', 800)).toBe(864)
    expect(charWidth('힣', 500)).toBe(864)
    expect(charWidth('i', 700)).toBeLessThan(charWidth('W', 700))
    expect(textWidth('가나다', 100, 800)).toBeCloseTo(259.2, 5)
    // letter-spacing counts after every character
    expect(textWidth('가나다', 100, 800, -0.04)).toBeCloseTo(259.2 - 12, 5)
    expect(wrapLines('공장 설비의 전력 사용을 실시간으로', 300, 36, 500)).toEqual(['공장 설비의 전력', '사용을 실시간으로'])
    // keep-all: a word wider than the box is not cut
    expect(wrapLines('가나다라마바사아자차카타파하', 300, 36, 500)).toBeNull()
    // the largest whole size at which the widest line fits, never below the smallest
    expect(fitSize(['가나다라'], 904, 800, -0.04, 156, 72)).toBe(156)
    expect(fitSize(['가나다라마바사아자차카타파하가나다라'], 904, 800, -0.04, 156, 72)).toBeNull()
  })

  test('colours: text on the brand by 4.5:1; the brand as text on paper darkened with its hue, or near-black for a light brand', () => {
    expect(onColor('#ffcc00')).toBe('#111111')
    expect(onColor('#1f4fd8')).toBe('#ffffff')
    const ink = towardContrast('#3fd0a5', '#f5f2ec', 4.5, '#000000')
    expect(contrast(ink, '#f5f2ec')).toBeGreaterThanOrEqual(4.5)
    const yellow = BRAND({ style: 'bold', brand: '#ffcc00' })
    expect(yellow).toMatchObject({ light: true, brandInk: '#111111', brandBig: '#111111', onBrand: '#111111' })
    const blue = BRAND({ style: 'editorial', brand: '#1f4fd8' })
    expect(blue.light).toBe(false)
    expect(contrast(blue.brandInk, blue.paper)).toBeGreaterThanOrEqual(4.5)
    // no brand colour, or a grey one: the style's neutral palette (nothing invented)
    expect(BRAND({ style: 'bold', brand: null }).hasBrand).toBe(false)
    expect(BRAND({ style: 'bold', brand: '#808080' }).hasBrand).toBe(false)
    // the dark style's light reaches 4.5:1 on its dark
    const night = BRAND({ style: 'night', brand: '#1b2a6b' })
    expect(contrast(night.brandLight, '#0b0c0f')).toBeGreaterThanOrEqual(4.5)
  })

  test('numbers: as written, whole numbers only ("87" is not in "1,870"), whitespace aside', () => {
    expect(numbersIn('87개 사업장, 평균 18% 절감, 1,200곳, 3.5배')).toEqual(['87', '18', '1,200', '3.5'])
    const src = spaced('도입한 1,870개 사업장의 평균 18 % 절감 (2025년). 3.87배')
    expect(hasNumber(src, '1,870')).toBe(true)
    expect(hasNumber(spaced('bills. 87 plants'), '87')).toBe(true)
    expect(hasNumber(src, '3.87')).toBe(true)
    expect(hasNumber(src, '87')).toBe(false)
    expect(hasNumber(src, '870')).toBe(false)
    expect(hasNumber(src, '18')).toBe(true)
    expect(squash('평균 18 % 절감').includes(squash('18%'))).toBe(true)
    expect(hasNumber(src, '2025')).toBe(true)
    expect(hasNumber(src, '202')).toBe(false)
  })

  test('brand folders: groups/<team>/<브랜드>/… or shared/<브랜드>/…, in any language; nothing else', () => {
    expect(inBrandFolder('groups/마케팅팀/브랜드/이미지/a.png')).toBe(true)
    expect(inBrandFolder('groups/Acme/Brand/Images/a.png')).toBe(true)
    expect(inBrandFolder('shared/브랜드/a.png')).toBe(true)
    expect(inBrandFolder('shared/Marca/x.jpg')).toBe(true)
    expect(inBrandFolder('groups/마케팅팀/회의록/a.png')).toBe(false)
    expect(inBrandFolder('users/dana/브랜드/a.png')).toBe(false)
    expect(inBrandFolder('groups/브랜드/a.png')).toBe(false)
  })

  test('a line too wide for its box is a problem in the AI\'s terms; one that fits gets the largest size of its style', () => {
    const d = doc()
    const ok = fitScene(d, d.scenes[1]!, false)
    expect(ok.problems).toEqual([])
    expect(ok.fit!.headline).toBeGreaterThanOrEqual(70)
    const long = { ...d.scenes[1]!, headline: ['어디서 새는지 아무도 모르던 공장의 전기요금'] }
    const bad = fitScene(d, long, false)
    expect(bad.fit).toBeNull()
    expect(bad.problems.join('\n')).toMatch(/headline line .* too wide/)
    const sub = fitScene(d, { ...d.scenes[1]!, sub: '월말 고지서가 나와야 사용량을 알 수 있었고 어느 설비가 얼마를 쓰는지도 몰라서 줄일 방법을 찾지 못했어요 그래서 더 길게' }, false)
    expect(sub.problems.join('\n')).toMatch(/sub line is too long/)
  })
})

describe('the composition (pure)', () => {
  test('one 4:5 root, five scenes on one clock, every delay a plain number (the HyperFrames CSS adapter rewrites var() delays)', () => {
    for (const style of ['bold', 'editorial', 'night'] as const) {
      const c = composition(doc({ style }), true)
      expect(c.root).toContain('data-composition-id="promo"')
      expect(c.root).toContain('data-width="1080" data-height="1350"')
      expect(c.root).toContain(`data-duration="${sceneTimes().duration}"`)
      expect(c.root).toContain('data-no-timeline')
      expect((c.root.match(/<section class="sc /g) ?? []).length).toBe(5)
      expect(c.root).not.toMatch(/var\(--s\)|var\(--e\)/)
      expect(c.css).not.toMatch(/animation[^;{}]*var\(/)
    }
    expect(sceneTimes().duration).toBeGreaterThanOrEqual(12)
    expect(sceneTimes().duration).toBeLessThanOrEqual(15)
  })

  test('a proof without a number (the material has none) is a statement scene in every style, with or without a photo', () => {
    for (const style of ['bold', 'editorial', 'night'] as const) {
      for (const picture of [null, P('/shared/브랜드/이미지/b.png')]) {
        const d = doc({ style })
        d.scenes[3] = { kind: 'proof', eyebrow: '매장', headline: ['합정에서 제주까지'], sub: '네 곳의 매장에서 기다려요', picture }
        const c = composition(d, true)
        const proof = c.root.slice(c.root.indexOf('data-kind="proof"'), c.root.indexOf('data-kind="cta"'))
        expect(proof).not.toContain('class="num"')
        expect(proof).toContain('합정에서 제주까지')
      }
    }
  })

  test('text is escaped; pictures by team path in the chat, by a file beside it for the render; no address of the web', () => {
    const d = doc()
    d.scenes[1] = { ...d.scenes[1]!, headline: ['<script>x</script>'], sub: '"quoted" & <b>' }
    const page = artifactDocument(d, { fontCss: '/vendor/fonts/promo-video.css', title: 'A <title>', text: { play: '재생', pause: '일시정지', replay: '처음부터', stills: '장면 {n}', scene: (n) => `장면 ${n}` } })
    expect(page).not.toContain('<script>x</script>')
    expect(page).toContain('&lt;script&gt;x&lt;/script&gt;')
    expect(page).toContain('src="/shared/브랜드/이미지/a.png"')
    expect(page).toContain('<link rel="stylesheet" href="/vendor/fonts/promo-video.css">')
    expect(page).not.toMatch(/https?:\/\//)
    // reduced motion: the five finished scenes as stills (every animation off), built by the page's own script
    expect(page).toContain('prefers-reduced-motion: reduce')
    expect(page).toContain('.pv.still .sc,.pv.still .sc *,.pv.still .sc::after{animation:none!important}')
    const render = renderDocument({ ...d, scenes: d.scenes.map((s) => (s.picture ? { ...s, picture: { ...s.picture, src: 'img/1.png' } } : s)) }, 'fonts/PretendardVariable.woff2')
    expect(render).toContain('@font-face{font-family:"Pretendard Promo";src:url("fonts/PretendardVariable.woff2")')
    expect(render).toContain('src="img/1.png"')
    // the render page carries no player and no script
    expect(render).not.toContain('<script')
  })

  test('a type-only scene has no photo box; a photo scene keeps its text off the photo (its own box below or beside)', () => {
    const c = composition(doc(), true)
    const cover = c.root.slice(c.root.indexOf('data-kind="cover"') - 200, c.root.indexOf('data-kind="problem"'))
    expect(cover).toContain('class="ph p0"')
    const problem = c.root.slice(c.root.indexOf('data-kind="problem"'), c.root.indexOf('data-kind="solution"'))
    expect(problem).not.toContain('class="ph ')
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
    return (h.ctx.db.query('SELECT content FROM messages WHERE id = ?').get(r.assistantMessage.id) as { content: string }).content
  }
  const scene = (eyebrow: string, headline: string[], sub: string, picture?: string) => ({ eyebrow, headline, sub, ...(picture ? { picture } : {}) })
  const slots = (over: Record<string, unknown> = {}) => ({
    title: 'Acme promo video', style: 'editorial', company: 'Acme', website: 'acme.example', brand_color: '#0E5E4E', logo: 'shared/Brand/Images/logo.png',
    sources: ['shared/Brand/Company intro.md'],
    cover: scene('Factory energy', ['Cut the power bill', 'you can now see'], 'Live power data for every machine.', 'shared/Brand/Images/factory.png'),
    problem: scene('The problem', ['Nobody knew', 'where it leaked'], 'Usage showed up only with the bill.'),
    solution: scene('What we do', ['One sensor', 'per machine'], 'Every wasted hour on one screen.'),
    proof: { ...scene('Results', ['Running in', '87 plants'], 'Customers as of 2025.'), number: '18%', label: 'lower power bill' },
    cta: scene('Free audit', ['See your plant', 'in a week'], 'Book a call and get a report.'),
    ...over,
  })

  test('the slots are a strict schema (no HTML field, a fixed scene order, colours as #rrggbb)', () => {
    expect(PromoVideoInput.safeParse(slots()).success).toBe(true)
    expect(PromoVideoInput.safeParse({ ...slots(), html: '<p>x</p>' }).success).toBe(false)
    expect(PromoVideoInput.safeParse({ ...slots(), brand_color: 'red' }).success).toBe(false)
    expect(PromoVideoInput.safeParse({ ...slots(), style: 'neon' }).success).toBe(false)
    expect(PromoVideoInput.safeParse({ ...slots(), cover: { ...slots().cover, headline: ['a', 'b', 'c'] } }).success).toBe(false)
  })

  test('every problem at once: a made-up number, a picture outside the brand folder or too small, a line too wide; nothing made', async () => {
    const chat = await h.api('dana').call(API.createChat, { body: {} })
    const bad = slots({
      problem: scene('The problem', ['Nobody knew', 'where it leaked'], 'Usage showed up only with the bill.', 'shared/Other/elsewhere.png'),
      solution: scene('What we do', ['One sensor per machine on every floor'], 'Every wasted hour on one screen.', 'shared/Brand/Images/tiny.png'),
      proof: { ...scene('Results', ['Running in', '90 plants'], 'Customers as of 2025.'), number: '20%', label: 'lower power bill' },
    })
    const answer = await send('dana', chat.id, fake({ tool: 'promo_video', args: bad, sayResult: true }))
    expect(answer).toContain('Nothing was made yet')
    expect(answer).toContain('"20%" is not written in the sources')
    expect(answer).toContain('the number "90" is not in the sources')
    expect(answer).toContain('is not in a brand folder')
    expect(answer).toContain('is too small (300×300')
    expect(answer).toMatch(/headline line .* too wide/)
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
    expect(answer).toContain('scenes with a photo: cover')
    const art = h.ctx.db.query('SELECT id, key, type, title, content, version FROM artifacts WHERE chat_id = ?').get(chat.id) as { id: string; key: string; type: string; title: string; content: string; version: number }
    expect(art).toMatchObject({ key: PROMO_ARTIFACT_KEY, type: 'html', title: 'Acme promo video', version: 1 })
    expect(art.content).toContain('data-composition-id="promo"')
    expect(art.content).toContain('class="pv pv--editorial"')
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
    expect(info).toMatchObject({ artifactId: art.id, chatId: chat.id, title: 'Acme promo video', style: 'editorial', mp4: { available: false, state: 'none' } })
    expect((await h.req('dana', `/api/promo-videos/${art.id}/mp4`, { method: 'POST' })).status).toBe(404)
    // someone else's video is not found
    expect((await h.req('alice', `/api/promo-videos/${art.id}`)).status).toBe(404)
    // a second call makes a new version of the same artifact
    await send('dana', chat.id, fake({ tool: 'promo_video', args: slots({ style: 'night' }), sayResult: true }))
    expect(h.ctx.db.query('SELECT max(version) AS v FROM artifacts WHERE chat_id = ? AND key = ?').get(chat.id, PROMO_ARTIFACT_KEY)).toEqual({ v: 2 })
  })

  test.if(process.platform === 'darwin' && !!Bun.which('node'))('the MP4 on a development Mac: the pinned CLI renders the checked slots (the pictures copied out with the owner\'s permissions); one download', async () => {
    // a stand-in for the CLI: checks what it is given and writes a small file where --output says
    const cli = path.join(hfDir, 'ok', 'node_modules', 'hyperframes', 'bin')
    fs.mkdirSync(cli, { recursive: true })
    fs.writeFileSync(path.join(cli, 'hyperframes.mjs'), `import fs from 'node:fs'
const a = process.argv.slice(2), dir = a[1], out = a[a.indexOf('--output') + 1]
const html = fs.readFileSync(dir + '/index.html', 'utf8')
if (!html.includes('data-composition-id="promo"') || !fs.existsSync(dir + '/fonts/PretendardVariable.woff2') || !fs.existsSync(dir + '/img/1.png') || html.includes('/shared/')) process.exit(3)
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
})
