// Intro deck round 2, the measurable review (docs/DECISIONS.md "D2", round 2; review.ts) and the server's slide
// pictures (render.ts): contrast under type on the ground render (2nd percentile, WCAG limits on the printed slide,
// bold labels and the theme's tokens on flat fills as review.ts explains), busy grounds under type, type under 22 px,
// overlapping text, the same layout three times in a row, slides that read as empty; the brand pictures' mean
// luminance and the Paper accent by k-means. Every company here is made up.
//
// Calibration (scratchpad mockups `deck-plan/png/<deck>/sNN.png`, 25 deck slides and 9 ground tiles, rendered again
// by Chromium as they are and with every glyph transparent, halved to 960 × 540; typst's renders measure 4–10 % more
// edge than Chromium's on the same photographs):
//   - busy (mean Sobel of the luma in the busiest three-em window under a text): every mock text ≤ 0.030 except one
//     footer over a circuit board under the bottom scrim, 0.052; type on the lettering of a photo 0.150–0.253, on ivy
//     0.198, on railings 0.097, on a chip's markings 0.082, on bright circuitry 0.076 → limit 0.065.
//   - ink coverage (pixels ≥ 0.06 OKLab from the slide's ground, each claiming ±48 px): mfg 77.8 47.6 68.3 56.1 43.9
//     64.0 47.4 60.3, café 80.0 46.6 79.8 30.2 36.8 32.2 31.9 84.4, SaaS 64.5 40.0 35.8 42.6 57.6 30.9 38.2 21.5 (the
//     quote slide) 57.5, the twelve diagram specimens 19.5–43.1 %; a title and a footer alone 9.3 % (white with the
//     corner glow) and 10.9 % (paper, two-line title and a lead), a quote alone 3.1 % → limit 18 %. A glow counts as
//     ink: a title over an ink glow with no figure measures 37.4 % (the ink theme draws that glow only behind a figure).
//   - contrast: the decks' only findings are two 22 px footer runs at 2.88:1 and 2.66:1 (a page total over a lit
//     floor in a photo; a contour pattern that did not fade under a footer); `mute` labels on a step's tint measure
//     2.54:1, inside the flat-fill tolerance (80 % of 3:1).
import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import { contrast, luminance } from '../../server/src/promo-video/colors'
import type { Item, SlideOut, TextItem } from '../../server/src/intro-deck/layout'
import { decodePng, encodePng, type Rgba } from '../../server/src/intro-deck/png'
import { pretendardDir } from '../../server/src/intro-deck/files'
import { accentFromPictures, ACCENT_CHROMA, pictureStats, rasterizeSvg, renderAvailable, renderSlidePngs, samplePictures } from '../../server/src/intro-deck/render'
import { busyUnder, contrastUnder, edgeDensity, findingsText, inkCoverage, REVIEW, reviewDeck, reviewSlide, textSpans } from '../../server/src/intro-deck/review'
import { which } from '../../server/src/config'

setDefaultTimeout(60_000)

// ── pictures made in code (960 × 540, half the slide, like the typst render) ─────────────────────────────────────
const rgb = (hex: string): [number, number, number] => { const n = Number.parseInt(hex.slice(1, 7), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255] }
function canvas(hex: string, w = 960, h = 540): Rgba {
  const data = new Uint8Array(w * h * 4), [r, g, b] = rgb(hex)
  for (let i = 0; i < w * h; i++) data.set([r, g, b, 255], i * 4)
  return { width: w, height: h, data }
}
/** fill a rectangle given in slide px (1920 × 1080) */
function paint(img: Rgba, x: number, y: number, w: number, h: number, color: (px: number, py: number) => string | [number, number, number]) {
  const k = img.width / 1920
  for (let py = Math.round(y * k); py < Math.round((y + h) * k); py++) for (let px = Math.round(x * k); px < Math.round((x + w) * k); px++) {
    const c = color(px, py)
    img.data.set([...(typeof c === 'string' ? rgb(c) : c), 255], (py * img.width + px) * 4)
  }
}
/** through the PNG writer and reader, as the review receives the renders */
const roundTrip = (img: Rgba) => decodePng(encodePng(img))!

function txt(x: number, y: number, w: number, size: number, weight: 400 | 700 | 800, color: string, text: string, role = 'body', lines = 1): TextItem {
  return { t: 'text', x, y, w, size, weight, tracking: 0, lh: Math.round(size * 1.3), align: 'l', role, lines: Array.from({ length: lines }, () => [{ text, color }]) }
}
const slide = (items: Item[], o: Partial<SlideOut> = {}): SlideOut => ({ kind: 'about', variant: 'A', ground: '#f4f1eb', dark: false, label: '', items, notes: [], ...o })
const picture = (x: number, y: number, w: number, h: number): Item => ({ t: 'image', x, y, w, h, src: 'shared/브랜드/이미지/a.jpg', natural: { width: 2000, height: 1200 }, crop: { x: 0, y: 0, w: 2000, h: 1200 }, radius: 0 })

describe('contrast under type', () => {
  test('on a flat ground the 2nd percentile is exactly the WCAG ratio of the two colours', () => {
    const g = roundTrip(canvas('#f4f1eb'))
    for (const c of ['#171513', '#62605c', '#8c8a85', '#a5532b']) {
      const m = contrastUnder(g, { x0: 120, y0: 150, x1: 900, y1: 230 }, c)!
      expect(m.ratio).toBeCloseTo(contrast(c, '#f4f1eb'), 9)
      expect(m.spread).toBe(0)
    }
    // a colour with alpha is blended over the ground first: white at 50 % over black
    const k = contrastUnder(canvas('#000000'), { x0: 0, y0: 0, x1: 100, y1: 100 }, '#ffffff80')!
    expect(k.ratio).toBeCloseTo(contrast('#808080', '#000000'), 9)
  })

  test('the limits: 4.5:1 for regular type under 36 px, 3:1 for bold and large type; flat drawn fills get 80 %', () => {
    const g = canvas('#f4f1eb')
    // #8c8a85 on paper is 3.06:1: a bold 22 px label passes, a regular 28 px body (under 80 % of 4.5) does not
    const label = txt(120, 990, 300, 22, 700, '#8c8a85', '에이크미 · 공간', 'footer')
    const body = txt(120, 400, 900, 28, 400, '#8c8a85', '매일 볶은 원두를 집과 매장으로 보냅니다', 'body')
    // #77756f: under 4.5:1 but inside the flat-fill tolerance
    expect(contrast('#77756f', '#f4f1eb')).toBeGreaterThan(4.5 * 0.8)
    expect(contrast('#77756f', '#f4f1eb')).toBeLessThan(4.5)
    const dim = txt(120, 500, 900, 28, 400, '#77756f', '오래된 신발 공장을 고친 첫 공간', 'body')
    const f = reviewSlide(slide([label, body, dim]), 1, { ground: g })
    expect(f.filter((x) => x.code === 'contrast')).toEqual([{ slide: 1, code: 'contrast', where: 'body "매일 볶은 원두를 집과 매장으로 보냅니다"', value: Math.round(contrast('#8c8a85', '#f4f1eb') * 100) / 100, need: 4.5, fix: null }])
    // the same dim body over a picture: the full limit, and the scrim as the mechanical fix
    const g2 = canvas('#f4f1eb')
    const f2 = reviewSlide(slide([picture(0, 0, 1920, 1080), dim]), 0, { ground: g2 })
    expect(f2.find((x) => x.code === 'contrast')).toMatchObject({ value: Math.round(contrast('#77756f', '#f4f1eb') * 100) / 100, need: 4.5, fix: 'scrim' })
    // a scrim already at its strongest: the drawn ground is the fix
    const scrim: Item = { t: 'rect', x: 0, y: 0, w: 1920, h: 1080, radius: 0, fill: { linear: { angle: 90, stops: [{ at: 0, color: '#f4f1ebf5' }, { at: 0.6, color: '#f4f1eb00' }] } } }
    expect(reviewSlide(slide([picture(0, 0, 1920, 1080), scrim, dim]), 0, { ground: g2 }).find((x) => x.code === 'contrast')?.fix).toBe('ground')
  })

  test('a few light pixels under a word (a hairline) do not decide it; a ground that is light under a third of it does', () => {
    const white = txt(120, 400, 900, 40, 700, '#ffffff', 'Acme Precision', 'title')
    const [span] = textSpans(white)
    const hair = canvas('#101010')
    paint(hair, span!.x0 + 100, span!.y0, 2, span!.y1 - span!.y0, () => '#f0f0f0') // one light rule across the band
    expect(reviewSlide(slide([white], { ground: '#101010', dark: true }), 0, { ground: hair }).filter((x) => x.code === 'contrast')).toEqual([])
    const half = canvas('#101010')
    paint(half, span!.x0, span!.y0, (span!.x1 - span!.x0) / 3, span!.y1 - span!.y0, () => '#e0e0e0')
    const f = reviewSlide(slide([picture(0, 0, 1920, 1080), white], { ground: '#101010', dark: true }), 0, { ground: half })
    expect(f.find((x) => x.code === 'contrast')).toMatchObject({ need: 3, fix: 'scrim' })
    expect(f.find((x) => x.code === 'contrast')!.value!).toBeLessThan(1.4)
  })
})

describe('busy ground under type', () => {
  const title = txt(120, 560, 1200, 64, 700, '#ffffff', '정밀 부품을 제때 만드는 회사', 'title')
  const [span] = textSpans(title)
  test('stripes or noise under the words are busy; a flat or smoothly graded ground is not', () => {
    const flat = canvas('#14161c')
    expect(busyUnder(flat, [span!])).toBe(0)
    const graded = canvas('#14161c')
    paint(graded, 0, 0, 1920, 1080, (px) => { const v = Math.round(20 + (px / 960) * 60); return [v, v, v] })
    expect(busyUnder(graded, [span!])).toBeLessThan(0.01)
    // lettering-like stripes under one word of the line (a sign in a photo): the window finds them
    expect(span!.x1 - span!.x0).toBeGreaterThan(700)
    const stripes = canvas('#14161c')
    paint(stripes, span!.x0 + 400, span!.y0, 100, span!.y1 - span!.y0, (px) => (px % 4 < 2 ? '#707070' : '#202020'))
    expect(edgeDensity(stripes, [span!])).toBeLessThan(REVIEW.busy) // averaged over the whole line it would pass
    expect(busyUnder(stripes, [span!])).toBeGreaterThan(REVIEW.busy)
    let seed = 7
    const noise = canvas('#14161c')
    paint(noise, span!.x0, span!.y0, span!.x1 - span!.x0, span!.y1 - span!.y0, () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; const v = 40 + (seed % 120); return [v, v, v] })
    const f = reviewSlide(slide([picture(0, 0, 1920, 1080), title], { ground: '#14161c', dark: true }), 0, { ground: noise })
    expect(f.find((x) => x.code === 'busy')).toMatchObject({ slide: 0, need: REVIEW.busy, fix: 'scrim' })
    expect(reviewSlide(slide([title], { ground: '#14161c', dark: true }), 0, { ground: flat }).filter((x) => x.code === 'busy')).toEqual([])
  })
})

describe('layout checks', () => {
  test('type under 22 px', () => {
    const f = reviewSlide(slide([txt(120, 990, 300, 20, 700, '#171513', '2025년 기준', 'note'), txt(120, 150, 900, 64, 700, '#171513', '고객이 다시 찾는 이유', 'title')]), 3)
    expect(f).toEqual([{ slide: 3, code: 'small', where: 'note "2025년 기준"', value: 20, need: 22, fix: null }])
  })

  test('text boxes that overlap; a title with its sub-line under it does not', () => {
    const title = txt(120, 150, 1200, 64, 700, '#171513', '설계부터 납품까지 한 곳에서', 'title')
    const sub = txt(120, 150 + 83 + 8, 1200, 32, 400, '#62605c', '도면 한 장으로 시작해요', 'sub')
    expect(reviewSlide(slide([title, sub]), 2)).toEqual([])
    const onTop = txt(300, 170, 900, 32, 400, '#62605c', '도면 한 장으로 시작해요', 'sub')
    expect(reviewSlide(slide([title, onTop]), 2)).toEqual([{ slide: 2, code: 'overlap', where: 'title "설계부터 납품까지 한 곳에서" and sub "도면 한 장으로 시작해요"', fix: null }])
  })

  test('the same layout three slides in a row, once per run; a figure variant repeats across kinds', () => {
    const s = (kind: SlideOut['kind'], variant: string) => slide([], { kind, variant })
    expect(reviewDeck([s('cover', 'A'), s('offer', 'B'), s('offer', 'B'), s('about', 'A')])).toEqual([])
    expect(reviewDeck([s('cover', 'A'), s('offer', 'B'), s('offer', 'B'), s('offer', 'B'), s('offer', 'B'), s('contact', 'A')]))
      .toEqual([{ slide: 3, code: 'repeat', where: 'offer:B', value: 3, need: 2, fix: null }])
    expect(reviewDeck([s('about', 'A'), s('needs' as SlideOut['kind'], 'grid'), s('offer', 'grid'), s('products', 'grid')]).map((x) => [x.slide, x.where])).toEqual([[3, 'grid']])
  })
})

describe('a slide that reads as empty', () => {
  const ground = '#f4f1eb'
  test('a title and a footer alone are under 18 % ink; with its figure the slide is not', () => {
    const bare = canvas(ground)
    paint(bare, 120, 158, 940, 62, () => '#171513') // the title's band
    paint(bare, 120, 994, 300, 18, () => '#62605c') // the footer
    paint(bare, 1720, 994, 80, 18, () => '#62605c')
    const cov = inkCoverage(roundTrip(bare), ground)
    expect(cov).toBeGreaterThan(0.04)
    expect(cov).toBeLessThan(0.12)
    expect(reviewSlide(slide([]), 4, { full: bare })).toEqual([{ slide: 4, code: 'empty', value: Math.round(cov * 1000) / 1000, need: 0.18, fix: null }])
    // a figure: three cells with an outline and two lines of type each
    const fig = canvas(ground)
    paint(fig, 120, 158, 940, 62, () => '#171513')
    for (let c = 0; c < 3; c++) {
      const x = 120 + c * 580
      paint(fig, x, 360, 520, 2, () => '#8c8a85'); paint(fig, x, 840, 520, 2, () => '#8c8a85')
      paint(fig, x, 400, 64, 64, () => '#a5532b'); paint(fig, x, 500, 300, 36, () => '#171513'); paint(fig, x, 560, 460, 26, () => '#62605c')
    }
    expect(inkCoverage(fig, ground)).toBeGreaterThan(REVIEW.empty)
    expect(reviewSlide(slide([]), 4, { full: fig })).toEqual([])
    // the faint corner glow of a white content slide is not ink
    const glow = canvas('#ffffff')
    paint(glow, 1300, 0, 620, 500, (px, py) => { const t = Math.max(0, 1 - Math.hypot(px - 880, py) / 400) * 0.09; return [Math.round(255 - t * (255 - 82)), Math.round(255 - t * (255 - 36)), Math.round(255 - t * 2)] })
    expect(inkCoverage(glow, '#ffffff')).toBe(0)
  })
})

describe('findings for the AI', () => {
  test('one plain-English line each, naming the slide and what to change', () => {
    const lines = findingsText([
      { slide: 0, code: 'busy', where: 'headline "정밀 부품을"', value: 0.15, need: 0.065, fix: 'scrim' },
      { slide: 2, code: 'contrast', where: 'body "도면 한 장으로"', value: 3.2, need: 4.5, fix: null },
      { slide: 4, code: 'small', where: 'note "2025년 기준"', value: 20, need: 22, fix: null },
      { slide: 5, code: 'repeat', where: 'grid', value: 3, need: 2, fix: null },
      { slide: 7, code: 'empty', value: 0.093, need: 0.18, fix: null },
      { slide: 8, code: 'overlap', where: 'title "A" and sub "B"', fix: null },
    ], 'ko').split('\n')
    expect(lines).toHaveLength(6)
    expect(lines[0]).toStartWith('Slide 1 (index 0): the headline "정밀 부품을" sits on a busy part')
    expect(lines[0]).toContain('choose a picture whose calm side is plain')
    expect(lines[1]).toStartWith('Slide 3 (index 2): the body "도면 한 장으로" reads at 3.2:1')
    expect(lines[3]).toContain('third slide in a row with the same layout (grid)')
    expect(lines[4]).toContain('ink on 9 % of it, at least 18 %')
    expect(findingsText([], 'en')).toBe('')
  })
})

describe('brand pictures: mean luminance and the Paper accent', () => {
  const pic = (w: number, h: number, at: (x: number, y: number) => [number, number, number, number]): Rgba => {
    const data = new Uint8Array(w * h * 4)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(at(x, y), (y * w + x) * 4)
    return { width: w, height: h, data }
  }
  test('mean relative luminance over the opaque pixels', () => {
    expect(pictureStats(pic(8, 8, () => [255, 255, 255, 255])).luminance).toBeCloseTo(1, 9)
    expect(pictureStats(pic(8, 8, () => [0, 0, 0, 255])).luminance).toBe(0)
    // half black, half white, and a transparent surround that does not count
    expect(pictureStats(pic(8, 8, (x, y) => (y < 2 ? [255, 0, 0, 0] : x < 4 ? [0, 0, 0, 255] : [255, 255, 255, 255]))).luminance).toBeCloseTo(0.5, 9)
  })

  test('k-means: a rust patch on grey gives the rust; all greys give none; the same pixels the same answer', () => {
    const rust = pic(48, 48, (x, y) => (x >= 30 && x < 42 && y >= 8 && y < 20 ? [0xa5, 0x53, 0x2b, 255] : [128 + ((x * 7 + y * 3) % 9) - 4, 128 + ((x * 7 + y * 3) % 9) - 4, 128 + ((x * 7 + y * 3) % 9) - 4, 255]))
    const greys = pic(48, 48, (x, y) => { const v = 20 + Math.round(((x + y) / 94) * 210); return [v, v, Math.min(255, v + 6), 255] })
    const got = accentFromPictures([rust, greys])!
    expect(got).toMatch(/^#[0-9a-f]{6}$/)
    const [r, g, b] = rgb(got)
    expect(Math.abs(r - 0xa5) + Math.abs(g - 0x53) + Math.abs(b - 0x2b)).toBeLessThanOrEqual(3)
    expect(accentFromPictures([rust, greys])).toBe(got)
    expect(accentFromPictures([greys])).toBeNull()
    // a warm grey under the chroma bar stays monochrome; a transparent red surround is not part of the picture
    expect((0x8a - 0x80) / 255).toBeLessThan(ACCENT_CHROMA)
    expect(accentFromPictures([pic(32, 32, (x) => (x < 4 ? [255, 0, 0, 0] : [0x8a, 0x85, 0x80, 255]))])).toBeNull()
    expect(accentFromPictures([])).toBeNull()
  })
})

const typst = which('typst')
describe('slide pictures through typst', () => {
  test('without typst nothing is drawn (null), and the caller goes on', async () => {
    const before = process.env.MYCEL_TYPST_BIN
    process.env.MYCEL_TYPST_BIN = '/nonexistent/typst'
    try {
      expect(renderAvailable()).toBe(false)
      expect(await renderSlidePngs([slide([])], { title: 'Acme', lang: 'en', read: () => null })).toBeNull()
      expect(await rasterizeSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"/>', 64)).toBeNull()
      expect(await samplePictures([encodePng(canvas('#808080', 8, 8))])).toEqual([null])
    } finally {
      if (before === undefined) delete process.env.MYCEL_TYPST_BIN
      else process.env.MYCEL_TYPST_BIN = before
    }
  })

  test.if(!!typst && !!pretendardDir())('a title on a dark card over a light ground: both pages at 960 × 540, the ground page without type, its contrast as computed', async () => {
    const card: Item = { t: 'rect', x: 120, y: 120, w: 1100, h: 320, fill: { solid: '#171513' }, radius: 0 }
    const title = { ...txt(170, 200, 1000, 96, 800, '#f3eee6', 'Acme 정밀 부품', 'title'), tracking: -0.03, lh: 110 }
    const s = slide([card, title], { ground: '#f4f1eb', kind: 'cover', variant: 'C' })
    const r = (await renderSlidePngs([s, s], { title: 'Acme', lang: 'ko', read: () => null, ground: true }))!
    expect(r.full).toHaveLength(2)
    expect(r.ground).toHaveLength(2)
    const full = decodePng(r.full[0]!)!, ground = decodePng(r.ground![0]!)!
    expect([full.width, full.height, ground.width, ground.height]).toEqual([960, 540, 960, 540])
    // inside the card the ground page is the card's colour everywhere; the full page has the type there
    const inCard = (img: Rgba) => { const seen = new Set<string>(); for (let y = 64; y < 216; y++) for (let x = 64; x < 606; x++) seen.add(img.data.subarray((y * 960 + x) * 4, (y * 960 + x) * 4 + 3).join(',')); return seen }
    expect([...inCard(ground)]).toEqual([rgb('#171513').join(',')])
    expect(inCard(full).size).toBeGreaterThan(20)
    // outside the card both pages are the paper ground
    expect([...ground.data.subarray((500 * 960 + 900) * 4, (500 * 960 + 900) * 4 + 3)]).toEqual(rgb('#f4f1eb'))
    const [span] = textSpans(title)
    expect(Math.abs(contrastUnder(ground, span!, '#f3eee6')!.ratio - contrast('#f3eee6', '#171513'))).toBeLessThan(0.2)
    expect(reviewSlide(s, 0, { full, ground })).toEqual([])
    // without the ground pages
    const one = (await renderSlidePngs([s], { title: 'Acme', lang: 'ko', read: () => null, ppi: 144 }))!
    expect(one.ground).toBeNull()
    expect(decodePng(one.full[0]!)!.width).toBe(1920)
  })

  test.if(!!typst && !!pretendardDir())('the accent as a transparent PNG; tiny decodes of several pictures in one run', async () => {
    const png = (await rasterizeSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 800"><circle cx="400" cy="400" r="200" fill="#304ae5"/></svg>', 200))!
    const img = decodePng(png)!
    expect([img.width, img.height]).toEqual([200, 200])
    expect(img.data[3]).toBe(0) // a corner is transparent
    expect([...img.data.subarray((100 * 200 + 100) * 4, (100 * 200 + 100) * 4 + 4)]).toEqual([0x30, 0x4a, 0xe5, 255])
    const red = canvas('#c0392b', 300, 150), grey = canvas('#808080', 64, 64)
    const out = await samplePictures([encodePng(red), new Uint8Array([1, 2, 3]), encodePng(grey)])
    expect(out[1]).toBeNull()
    expect([out[0]!.width, out[0]!.height]).toEqual([68, 34]) // about 48 × 48 in area, the 2:1 aspect kept
    expect([...out[0]!.data.subarray(0, 4)]).toEqual([0xc0, 0x39, 0x2b, 255])
    expect([out[2]!.width, out[2]!.height]).toEqual([48, 48])
    expect(pictureStats(out[2]!).luminance).toBeCloseTo(luminance('#808080'), 3)
    const [r, g, b] = rgb(accentFromPictures([out[0]!, out[2]!])!)
    expect(Math.abs(r - 0xc0) + Math.abs(g - 0x39) + Math.abs(b - 0x2b)).toBeLessThanOrEqual(3)
  })
})
