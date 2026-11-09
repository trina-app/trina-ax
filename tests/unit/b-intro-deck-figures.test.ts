// Onboarding D2, round 2 (docs/DECISIONS.md "D2", round 2): the figures (figures.ts), the themes computed from one
// brand colour (look.ts) and the compositions (layout2.ts). Pure: no app, made-up companies only.
import { describe, expect, test } from 'bun:test'
import type { DeckFigure, DeckSlide2, DeckTheme } from '@mycel/shared/api'
import { contrast } from '../../server/src/promo-video/colors'
import { BAND_BOTTOM, BAND_TOP, Canvas, CW, H, ML, W } from '../../server/src/intro-deck/draw'
import { drawFigure, FIGURE_BAND, parseNum, comparable, type FigEnv } from '../../server/src/intro-deck/figures'
import { fadeAt } from '../../server/src/intro-deck/grounds'
import type { Item, PathItem, PicInfo, SlideOut, TextItem } from '../../server/src/intro-deck/layout'
import { layoutDeck2, layoutSlide2, type DeckDoc2 } from '../../server/src/intro-deck/layout2'
import { fittingThemes2, lookFor2, themeFor2, type G2 } from '../../server/src/intro-deck/look'
import { width, type Weight } from '../../server/src/intro-deck/text'

// ── pictures and a document (sizes only matter for the layout) ─────────────────────────────────────────────────────
const IMG = 'shared/브랜드/이미지/'
const PICS: Record<string, PicInfo> = {
  [IMG + 'wide.jpg']: { width: 1920, height: 1080 },
  [IMG + 'portrait.jpg']: { width: 1000, height: 1500 },
  [IMG + 'square.jpg']: { width: 1200, height: 1200 },
  [IMG + 'p1.jpg']: { width: 800, height: 600 },
  [IMG + 'p2.jpg']: { width: 800, height: 600 },
  [IMG + 'p3.jpg']: { width: 600, height: 800 },
  [IMG + 'p4.jpg']: { width: 900, height: 900 },
  [IMG + 'cut.png']: { width: 1800, height: 1000, cutout: true },
  [IMG + 'logo.png']: { width: 400, height: 120 },
}

function doc(slides: DeckSlide2[], over: Partial<DeckDoc2> = {}): DeckDoc2 {
  return {
    v: 2, theme: 'paper', lang: 'ko', title: '아크메정밀 회사 소개서', company: '아크메정밀', website: 'acme-precision.example', brand: '#1e4620', sampled: null,
    logo: { src: IMG + 'logo.png', width: 400, height: 120, light: 'direct', dark: 'mono' }, pattern: 'dots', seed: 7,
    slides, sections: slides.map((s) => (s.kind === 'cover' ? '표지' : s.kind === 'contact' ? '마무리' : '회사 소개')), pics: PICS,
    picNotes: { [IMG + 'wide.jpg']: { lettering: false, calm: 'left', tone: 'dark' }, [IMG + 'portrait.jpg']: { lettering: false, calm: 'none', tone: 'dark' }, [IMG + 'square.jpg']: { lettering: false, calm: 'left', tone: 'light' } },
    accents: {}, treat: {}, notes: slides.map(() => []), ...over,
  }
}
const ACCENT = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 800" width="800" height="800"><circle cx="400" cy="400" r="300" fill="none" stroke="#ffffff" stroke-width="2"/></svg>'

// ── helpers ───────────────────────────────────────────────────────────────────────────────────────────────────────
const texts = (items: Item[]) => items.filter((it): it is TextItem => it.t === 'text')
const paths = (items: Item[]) => items.filter((it): it is PathItem => it.t === 'path')
const lineText = (it: TextItem) => it.lines.map((l) => l.map((r) => r.text).join(''))
const allText = (items: Item[]) => texts(items).flatMap(lineText).join('\n')
/** The widest line of a text item, measured as the layout measures it. */
const lineWidth = (it: TextItem, k: number) => it.lines[k]!.reduce((a, r) => a + width(r.text, r.size ?? it.size, (r.weight ?? it.weight) as Weight, it.tracking), 0)

/** Path data: absolute M, L, C, Z only, every number finite. */
function pathOk(d: string): boolean {
  if (!/^[MLCZ]/.test(d)) return false
  const cmds = d.match(/[A-Za-z][^A-Za-z]*/g) ?? []
  for (const c of cmds) {
    const k = c[0]!, nums = c.slice(1).trim().split(/[\s,]+/).filter(Boolean).map(Number)
    if (!'MLCZ'.includes(k)) return false
    const want = k === 'Z' ? 0 : k === 'C' ? 6 : 2
    if (k === 'Z' ? nums.length !== 0 : nums.length % want !== 0 || nums.length === 0) return false
    if (!nums.every(Number.isFinite)) return false
  }
  return true
}
/** Items in the key colour (not icons, not tinted halos): the figure's one key. */
function markItems(items: Item[], g: G2): Item[] {
  const m = g.mark.toLowerCase()
  return items.filter((it) => {
    if (it.t === 'path') return it.role !== 'icon' && (it.fill?.toLowerCase() === m || it.stroke?.color.toLowerCase() === m)
    if (it.t === 'rect') return 'solid' in it.fill && it.fill.solid.toLowerCase() === m
    if (it.t === 'line') return it.color.toLowerCase() === m
    return false
  })
}
/** Every text at least 22 px (runs too); every text box on the slide; every path well formed. Returns what is wrong. */
function issues(items: Item[], o: { maxX?: number } = {}): string[] {
  const bad: string[] = []
  for (const it of texts(items)) {
    const what = lineText(it).join(' ').slice(0, 40)
    if (it.size < 22) bad.push(`${what}: ${it.size} px`)
    for (const l of it.lines) for (const r of l) if (r.size && r.size < 22) bad.push(`${what}: run "${r.text}" ${r.size} px`)
    if (it.x < 0 || it.x + it.w > (o.maxX ?? W)) bad.push(`${what}: x ${Math.round(it.x)}–${Math.round(it.x + it.w)}`)
    if (it.y < 0 || it.y + it.lh * it.lines.length > H) bad.push(`${what}: y ${it.y}`)
  }
  for (const p of paths(items)) if (!pathOk(p.d)) bad.push(`path ${p.d.slice(0, 60)}`)
  return bad
}
const sane = (items: Item[], o: { maxX?: number } = {}) => expect(issues(items, o)).toEqual([])

type Ground = 'paper' | 'ink' | 'brand'
function figEnv(ground: Ground, brand = '#1e4620'): { e: FigEnv; g: G2; problems: string[] } {
  const look = ground === 'paper' ? lookFor2('paper', brand) : ground === 'ink' ? lookFor2('ink', '#ff5a1f') : lookFor2('brand', '#5224fd')
  const g = ground === 'brand' ? look.feature : look.content
  const problems: string[] = []
  const cv = new Canvas(g)
  return { e: { cv, c: { problems, where: 'slides[3] (offer)' }, pics: PICS, radius: look.radius, lang: 'ko' }, g, problems }
}
const draw = (f: DeckFigure, ground: Ground = 'paper') => { const r = figEnv(ground); drawFigure(r.e, f, FIGURE_BAND); return { ...r, items: r.e.cv.items } }

// ── sample figures at their minimum and maximum counts ──────────────────────────────────────────────────────────────
const ko = ['설계', '가공', '검사', '포장', '납품', '상담', '교육', '관리']
const en = ['Plan', 'Machine', 'Inspect', 'Pack', 'Ship', 'Advise', 'Train', 'Care']
const icons = ['search', 'wrench', 'clipboard-check', 'package', 'truck', 'headset', 'graduation-cap', 'settings']
function samples(w: string[]): Record<string, [DeckFigure, DeckFigure]> {
  const body = w === ko ? '도면대로 정확하게 만들어요' : 'Made exactly to the drawing'
  return {
    flow: [{ kind: 'flow', steps: w.slice(0, 3).map((h, i) => ({ icon: icons[i], head: h, body })) }, { kind: 'flow', steps: w.slice(0, 5).map((h, i) => ({ icon: icons[i], head: h, body })) }],
    cycle: [{ kind: 'cycle', steps: w.slice(0, 3).map((h, i) => ({ icon: icons[i], head: h })) }, { kind: 'cycle', steps: w.slice(0, 6).map((h, i) => ({ icon: icons[i], head: h })), center: w === ko ? '한 바퀴' : 'A loop' }],
    hub: [{ kind: 'hub', center: w === ko ? '우리의\n기술' : 'Our\ncore', items: w.slice(0, 3).map((l, i) => ({ icon: icons[i], label: l })) }, { kind: 'hub', center: w === ko ? '중심' : 'Core', items: w.slice(0, 6).map((l, i) => ({ icon: icons[i], label: l })) }],
    layers: [{ kind: 'layers', items: w.slice(0, 3).map((h) => ({ head: h, body })) }, { kind: 'layers', key: 2, items: w.slice(0, 5).map((h, i) => ({ head: h, body, ...(i === 0 ? { stack: true } : {}) })) }],
    timeline: [{ kind: 'timeline', items: ['2009', '2014', '2019'].map((y, i) => ({ when: y, head: w[i]! })) }, { kind: 'timeline', items: ['2009', '2012', '2014', '2017', '2019', '2024'].map((y, i) => ({ when: y, head: w[i]!, body: w[i + 1] })), next: { head: w[7]! } }],
    compare: [{ kind: 'compare', before: { label: w === ko ? '이전' : 'Before', head: w[0]! }, after: { label: w === ko ? '지금' : 'Now', head: w[1]! } },
      { kind: 'compare', before: { label: w === ko ? '이전' : 'Before', head: w[0]!, items: [body, body, body] }, after: { label: w === ko ? '지금' : 'Now', head: w[1]!, items: [body, body, body] } }],
    funnel: [{ kind: 'funnel', stages: w.slice(0, 3) }, { kind: 'funnel', stages: w.slice(0, 5) }],
    merge: [{ kind: 'merge', inputs: w.slice(0, 3), target: { icon: 'inbox', head: w[5]!, body } }, { kind: 'merge', inputs: w.slice(0, 6), target: { icon: 'inbox', head: w[5]! } }],
    grid: [{ kind: 'grid', items: w.slice(0, 3).map((h, i) => ({ icon: icons[i], head: h, body, tags: ['ISO', 'Acme'] })) }, { kind: 'grid', items: w.slice(0, 8).map((h, i) => ({ icon: icons[i], head: h, body })) }],
    cards: [{ kind: 'cards', items: [{ name: w[0]!, body, picture: IMG + 'p1.jpg' }, { name: w[1]!, body, picture: IMG + 'p2.jpg' }] },
      { kind: 'cards', items: [{ name: w[0]!, body, picture: IMG + 'p1.jpg' }, { name: w[1]!, body, picture: IMG + 'p2.jpg' }, { name: w[2]!, picture: IMG + 'p3.jpg' }, { name: w[3]!, picture: IMG + 'cut.png' }] }],
    donut: [{ kind: 'donut', items: [{ value: '94%', label: w[0]! }] }, { kind: 'donut', items: [{ value: '80.2%', label: w[0]! }, { value: '98%', label: w[1]! }, { value: '100%', label: w[2]! }] }],
    bars: [{ kind: 'bars', items: [{ label: w[0]!, value: '340곳' }, { label: w[1]!, value: '120곳' }] }, { kind: 'bars', items: w.slice(0, 4).map((l, i) => ({ label: l, value: `${(i + 1) * 30}%` })) }],
    line: [{ kind: 'line', points: [{ x: '2022', value: '12곳' }, { x: '2023', value: '19곳' }, { x: '2024', value: '27곳' }] }, { kind: 'line', points: ['2017', '2018', '2019', '2020', '2021', '2022', '2023', '2024'].map((x, i) => ({ x, value: `${(i + 2) * 7}곳` })) }],
    figures: [{ kind: 'figures', items: [{ number: '340곳', label: w[0]! }, { number: '15년', label: w[1]! }] }, { kind: 'figures', items: [{ number: '340곳', label: w[0]! }, { number: '0.02%', label: w[1]! }, { number: '99.1%', label: w[2]! }, { number: '+30%', label: w[3]! }] }],
  }
}

describe('the figures (one drawing language)', () => {
  for (const [lang, words] of [['ko', ko], ['en', en]] as const) {
    for (const ground of ['paper', 'ink', 'brand'] as const) {
      test(`${lang} on ${ground}: every kind at its smallest and largest count draws without a problem, all type ≥ 22 px, inside the slide, paths of M/L/C/Z`, () => {
        const bad: string[] = []
        for (const [kind, pair] of Object.entries(samples(words))) {
          for (const [k, f] of pair.entries()) {
            const r = draw(f, ground)
            bad.push(...r.problems.map((p) => `${kind}[${k}] problem: ${p}`), ...issues(r.items).map((x) => `${kind}[${k}] ${x}`))
            if (r.items.length <= 3) bad.push(`${kind}[${k}] draws nothing`)
          }
        }
        expect(bad).toEqual([])
      })
    }
  }

  test('exactly one key in the mark colour (flow, timeline, hub, funnel); layers and merge: the key and its own leader', () => {
    for (const ground of ['paper', 'ink'] as const) {
      const s = samples(ko)
      const count = (f: DeckFigure) => { const r = draw(f, ground); return markItems(r.items, r.g).length }
      expect(count(s.flow[0])).toBe(1)
      expect(count(s.flow[1])).toBe(1)
      expect(count(s.timeline[0])).toBe(1)
      expect(count(s.timeline[1])).toBe(1)
      expect(count(s.hub[0])).toBe(1)
      expect(count(s.hub[1])).toBe(1)
      expect(count(s.funnel[1])).toBe(1)
      // the key slab's top face and the dot of its leader
      expect(count(s.layers[0])).toBe(2)
      // the target disc and its out line
      expect(count(s.merge[0])).toBe(2)
      // the flow's key is the last step unless the material stresses another
      const r = draw({ kind: 'flow', key: 0, steps: ko.slice(0, 4).map((h) => ({ head: h })) }, ground)
      const key = markItems(r.items, r.g)[0] as PathItem
      expect(Number(/^M([\d.]+)/.exec(key.d)![1])).toBe(ML)
    }
  })

  test('a text too long for its place is a problem naming the slot (every problem at once)', () => {
    const long = '아주아주아주아주아주아주긴이름입니다'
    const hub = draw({ kind: 'hub', center: '중심', items: [{ label: '모바일' }, { label: long }, { label: '서버' }] })
    expect(hub.problems.join('\n')).toContain('slides[3] (offer) figure.items[1].label: "아주아주아주아주아주아주긴이름입니다" is too long')
    const grid = draw({ kind: 'grid', items: [{ head: long }, { head: '가공' }, { head: long, body: long.repeat(8) }] })
    const p = grid.problems.join('\n')
    expect(p).toContain('figure.items[0].head')
    expect(p).toContain('figure.items[2].head')
    expect(p).toContain('figure.items[2].body')
    const flow = draw({ kind: 'flow', steps: [{ head: long }, { head: '가공' }, { head: '검사' }] })
    expect(flow.problems.join('\n')).toContain('figure.steps[0].head')
  })

  test('charts: a donut is a share written as a percent; bars of one unit, or durations at true scale; a line of one unit', () => {
    expect(draw({ kind: 'donut', items: [{ value: '340곳', label: '고객사' }] }).problems.join('\n')).toContain('a donut shows a share written as a percent')
    expect(draw({ kind: 'donut', items: [{ value: '120%', label: '성장' }] }).problems.join('\n')).toContain('a donut shows a share written as a percent')
    expect(draw({ kind: 'bars', items: [{ label: '고객사', value: '340곳' }, { label: '불량률', value: '0.02%' }] }).problems.join('\n')).toContain('bars compare values of one unit')
    // "2주" against "3분": 3 minutes is 0.015 % of 2 weeks, drawn as a 6 px tick with its number set large
    const t = draw({ kind: 'bars', items: [{ label: '이전', value: '2주' }, { label: '지금', value: '3분' }] })
    expect(t.problems).toEqual([])
    const fills = t.items.filter((it) => it.t === 'rect' && it.h === 44)
    expect(fills.some((it) => it.t === 'rect' && it.w === 6)).toBe(true)
    const big = texts(t.items).filter((it) => it.role === 'stat')
    expect(Math.max(...big.map((it) => it.size))).toBe(112)
    expect(comparable([parseNum('2주')!, parseNum('3분')!])).toEqual([20160, 3])
    expect(comparable([parseNum('340곳')!, parseNum('20%')!])).toBeNull()
    expect(draw({ kind: 'line', points: [{ x: '2022', value: '12곳' }, { x: '2023', value: '19%' }, { x: '2024', value: '27곳' }] }).problems.join('\n')).toContain('a line shows values of one unit')
    expect(draw({ kind: 'bars', items: [{ label: 'A', value: '0곳' }, { label: 'B', value: '0곳' }] }).problems.join('\n')).toContain('a bar chart needs values above zero')
  })

  test('timeline: the years at one size, a "next" as a hollow ring on a dotted axis; places draw contours', () => {
    const r = draw(samples(ko).timeline[1])
    const years = texts(r.items).filter((it) => it.role === 'year')
    expect(years.map(lineText).flat()).toEqual(['2009', '2012', '2014', '2017', '2019', '2024', '다음'])
    expect(new Set(years.map((y) => y.size)).size).toBe(1)
    expect(r.items.some((it) => it.t === 'line' && it.dash?.[0] === 2 && it.dash?.[1] === 12 && it.cap === 'round')).toBe(true)
    expect(paths(r.items).some((p) => p.fill === r.g.bg && p.stroke?.color === r.g.lineStrong)).toBe(true)
    // places in the order the material states: a contour field behind (history slide)
    const places: DeckSlide2 = { kind: 'history', title: '첫 공장을 시작으로 이어 왔어요', figure: { kind: 'timeline', items: [{ when: '안산', head: '첫 공장' }, { when: '시화', head: '두 번째' }, { when: '평택', head: '세 번째' }] } }
    const years2: DeckSlide2 = { kind: 'history', title: '한 걸음씩 걸어왔어요', figure: { kind: 'timeline', items: [{ when: '2009', head: '창업' }, { when: '2014', head: '의료 부품' }, { when: '2019', head: '두 번째 공장' }] } }
    const d = doc([{ kind: 'cover', headline: '정밀 부품' }, places, years2, { kind: 'contact', line: '연락 주세요' }])
    const out = layoutDeck2(d)
    expect(out.problems).toEqual([])
    expect(out.slides[1]!.items.some((it) => it.t === 'pattern' && it.kind === 'contours')).toBe(true)
    expect(out.slides[2]!.items.some((it) => it.t === 'pattern' && it.kind === 'dots')).toBe(true)
    expect(out.slides[2]!.items.some((it) => it.t === 'pattern' && it.kind === 'contours')).toBe(false)
  })

  test('compare: a picture of "now" next to the quiet "before", or two panels; cards show a cut-out whole', () => {
    const panels = draw(samples(ko).compare[1])
    expect(panels.items.some((it) => it.t === 'rect' && 'solid' in it.fill && it.fill.solid === panels.g.t10)).toBe(true)
    expect(panels.items.some((it) => it.t === 'rect' && it.stroke?.color === panels.g.line)).toBe(true)
    expect(panels.items.some((it) => it.t === 'image')).toBe(false)
    const pic = draw({ kind: 'compare', before: { label: '이전', head: '오래된 공장', items: ['멈춰진 건물'] }, after: { label: '지금', head: '본사', items: ['매일 만드는 곳'], picture: IMG + 'wide.jpg' } })
    expect(pic.problems).toEqual([])
    const img = pic.items.find((it) => it.t === 'image')
    expect(img).toMatchObject({ t: 'image', src: IMG + 'wide.jpg' })
    const cards = draw(samples(ko).cards[1])
    const cut = cards.items.find((it) => it.t === 'image' && it.src === IMG + 'cut.png')
    expect(cut && cut.t === 'image' && cut.crop).toEqual({ x: 0, y: 0, w: 1800, h: 1000 })
  })
})

describe('the themes from one brand colour', () => {
  const brands: [string, string | null, string | null][] = [['vivid', '#ff5a1f', null], ['deep', '#1428a0', null], ['violet', '#5224fd', null], ['muted', '#7a8b99', null], ['light', '#cad3fb', null], ['grey', '#888888', null], ['none', null, null], ['hueless + sampled', '#212121', '#a5532b'], ['yellow', '#ffd400', null]]
  test('text 4.5:1, dim 4.5:1, mute 3:1, accent 4.5:1, mark and connectors 3:1 on every ground of every theme', () => {
    for (const [name, b, sampled] of brands) for (const theme of ['paper', 'ink', 'brand'] as DeckTheme[]) {
      const look = lookFor2(theme, b, sampled)
      for (const [gname, g] of [['content', look.content], ['feature', look.feature]] as const) {
        const at = `${name} ${theme} ${gname}`
        expect(contrast(g.text, g.bg), at).toBeGreaterThanOrEqual(4.5)
        expect(contrast(g.dim, g.bg), at).toBeGreaterThanOrEqual(4.5)
        expect(contrast(g.mute, g.bg), at).toBeGreaterThanOrEqual(3)
        expect(contrast(g.accent, g.bg), at).toBeGreaterThanOrEqual(4.5)
        expect(contrast(g.mark, g.bg), at).toBeGreaterThanOrEqual(3)
        expect(contrast(g.lineStrong, g.bg), at).toBeGreaterThanOrEqual(3)
        expect(contrast(g.onMark, g.mark), at).toBeGreaterThanOrEqual(3)
      }
    }
  })
  test('a hueless brand takes the accent sampled from its pictures (paper), the café\'s rust on paper and on the warm black', () => {
    const look = lookFor2('paper', '#212121', '#a5532b')
    expect(look.content.accent).toBe('#a5532b')
    expect(look.feature.bg).toBe('#171513')
    expect(contrast(look.feature.accent, look.feature.bg)).toBeGreaterThanOrEqual(4.5)
    // no sampled colour: monochrome
    expect(lookFor2('paper', '#212121').glow).toBeNull()
  })
  test('deep colours go dark when the pictures are mostly dark; vivid ones go ink; light and grey ones paper', () => {
    expect(themeFor2(undefined, '#1428a0', true)).toEqual({ theme: 'ink', replaced: false })
    expect(themeFor2(undefined, '#1428a0', false)).toEqual({ theme: 'brand', replaced: false })
    expect(fittingThemes2('#ff5a1f', false)[0]).toBe('ink')
    expect(fittingThemes2('#cad3fb', false)[0]).toBe('paper')
    expect(fittingThemes2(null, true)[0]).toBe('paper')
    expect(themeFor2('brand', '#cad3fb', false)).toEqual({ theme: 'paper', replaced: true })
    // the ink ground pulls 6 % toward the brand; warm text for hues of 20–70°
    expect(lookFor2('ink', '#f59e0b').content.text).toBe('#f3eee6')
    expect(lookFor2('ink', '#1428a0').content.text).toBe('#eef1f8')
  })
})

describe('the compositions', () => {
  const cover = (over: Partial<Extract<DeckSlide2, { kind: 'cover' }>> = {}): DeckSlide2 => ({ kind: 'cover', headline: '정밀 부품을\n*제때* 만드는 회사', sub: '반도체 장비와 의료기기 부품', ...over })
  const contact: DeckSlide2 = { kind: 'contact', line: '부품 견적이 필요하면\n연락 주세요', offer: '첫 견적 무료', email: 'sales@acme-precision.example', phone: '031-555-0142', address: '경기도 안산시 단원구 예시로 12' }
  const one = (s: DeckSlide2, over: Partial<DeckDoc2> = {}) => {
    const d = doc([cover(), s, contact], over)
    const problems: string[] = [], typeOnly: number[] = []
    const out = layoutSlide2(d, 1, undefined, problems, typeOnly)
    return { out, problems, typeOnly }
  }
  const at = (slides: DeckSlide2[], i: number, over: Partial<DeckDoc2> = {}) => { const problems: string[] = []; const out = layoutSlide2(doc(slides, over), i, undefined, problems); return { out, problems } }
  /** Where a slide's pattern fades under a text's real lines (sampled every 8 px). */
  const fadeUnder = (out: SlideOut, role: string) => {
    const pat = out.items.find((it) => it.t === 'pattern')
    if (!pat || pat.t !== 'pattern') return 0
    let worst = 0
    for (const it of texts(out.items).filter((x) => x.role === role)) {
      it.lines.forEach((_, k) => {
        const w = lineWidth(it, k)
        for (let x = it.x; x <= it.x + w; x += 8) for (let y = it.y + k * it.lh; y <= it.y + (k + 1) * it.lh; y += 8) worst = Math.max(worst, fadeAt(pat.fade, x, y))
      })
    }
    return worst
  }

  test('cover A on a wide calm picture (type left or, on a calm right side, right); a picture with lettering never under type', () => {
    for (const theme of ['paper', 'ink', 'brand'] as const) {
      const a = at([cover({ picture: IMG + 'wide.jpg' }), contact], 0, { theme })
      expect(a.problems).toEqual([])
      expect(a.out.variant).toBe('A')
      expect(texts(a.out.items).find((t) => t.role === 'headline')!.x).toBe(ML)
    }
    const right = at([cover({ picture: IMG + 'wide.jpg' }), contact], 0, { picNotes: { [IMG + 'wide.jpg']: { lettering: false, calm: 'right', tone: 'dark' } } })
    expect(right.out.variant).toBe('A')
    expect(texts(right.out.items).find((t) => t.role === 'headline')!.x).toBe(W - ML - 1000)
    // lettering where the type would sit: the picture becomes a panel beside the type, never under it
    const lettered = at([cover({ picture: IMG + 'wide.jpg' }), contact], 0, { picNotes: { [IMG + 'wide.jpg']: { lettering: true, calm: 'left', tone: 'dark' } } })
    expect(lettered.out.variant).not.toBe('A')
    const img = lettered.out.items.find((it) => it.t === 'image' && !it.logo)
    if (img && img.t === 'image') for (const t of texts(lettered.out.items)) expect(t.x + t.w, lineText(t).join(' ')).toBeLessThanOrEqual(img.x)
  })

  test('cover B (a portrait picture as a panel) and C (drawn, with the accent); the pattern fades to zero under the headline', () => {
    const b = at([cover({ picture: IMG + 'portrait.jpg' }), contact], 0)
    expect(b.problems).toEqual([])
    expect(b.out.variant).toBe('B')
    expect(fadeUnder(b.out, 'headline')).toBe(0)
    expect(b.out.items.some((it) => it.t === 'svg')).toBe(false)
    const c = at([cover(), contact], 0, { accents: { 0: ACCENT } })
    expect(c.problems).toEqual([])
    expect(c.out.variant).toBe('C')
    expect(fadeUnder(c.out, 'headline')).toBe(0)
    expect(c.out.items.filter((it) => it.t === 'svg')).toHaveLength(1)
    // an accent on a picture cover is not drawn (the picture holds that side)
    const a = at([cover({ picture: IMG + 'wide.jpg' }), contact], 0, { accents: { 0: ACCENT } })
    expect(a.out.items.some((it) => it.t === 'svg')).toBe(false)
    // a picture too small for the cover makes the drawn cover and is recorded for the answer
    const small = at([cover({ picture: IMG + 'p1.jpg' }), contact], 0)
    expect(small.out.variant).toBe('C')
  })

  test('the opening: full bleed on a dark deck, the picture on two thirds, or drawn with its accent', () => {
    const slides = (picture?: string): DeckSlide2[] => [cover(), { kind: 'about', statement: '정밀 부품을 만듭니다' }, { kind: 'opening', line: '멈추지 않는 정밀함', sub: '도면 한 장으로 시작해요', ...(picture ? { picture } : {}) }, contact]
    const full = at(slides(IMG + 'wide.jpg'), 2, { theme: 'ink', picNotes: { [IMG + 'wide.jpg']: { lettering: false, calm: 'top', tone: 'dark' } } })
    expect(full.problems).toEqual([])
    expect(full.out.variant).toBe('A')
    const split = at(slides(IMG + 'square.jpg'), 2)
    expect(split.problems).toEqual([])
    expect(split.out.variant).toBe('B')
    const drawn = at(slides(), 2, { accents: { 2: ACCENT } })
    expect(drawn.problems).toEqual([])
    expect(drawn.out.variant).toBe('C')
    expect(drawn.out.items.filter((it) => it.t === 'svg')).toHaveLength(1)
    expect(fadeUnder(drawn.out, 'headline')).toBe(0)
    // a page number, no company footer on an opening
    expect(allText(drawn.out.items)).toContain('03 / 04')
    expect(allText(drawn.out.items)).not.toContain('아크메정밀  ·')
  })

  test('about: a hub beside the statement (labels inside 1,800 px), a compare, big figures, or the statement alone', () => {
    const hub = one({ kind: 'about', statement: '모바일, 서버, 자동차, 인공지능까지 우리의 부품이 들어갑니다', facts: [{ label: '설립', value: '2009년' }, { label: '위치', value: '경기도 안산' }], figure: { kind: 'hub', center: '우리의\n기술', items: [{ icon: 'smartphone', label: '모바일' }, { icon: 'server', label: '데이터 서버' }, { icon: 'car', label: '자동차' }, { icon: 'brain', label: '인공지능' }] } })
    expect(hub.problems).toEqual([])
    sane(hub.out.items, { maxX: W - ML })
    for (const l of ['모바일', '데이터 서버', '자동차', '인공지능']) expect(allText(hub.out.items)).toContain(l)
    const cmp = one({ kind: 'about', statement: '신발 공장에서 부품 공장으로', figure: { kind: 'compare', before: { label: '이전', head: '오래된 공장', items: ['멈춰진 건물'] }, after: { label: '지금', head: '본사', items: ['매일 만드는 곳'], picture: IMG + 'wide.jpg' } } })
    expect(cmp.problems).toEqual([])
    expect(cmp.out.variant).toBe('compare')
    const figs = one({ kind: 'about', statement: '정밀 부품을 만듭니다', figure: { kind: 'figures', items: [{ number: '340곳', label: '고객사' }, { number: '15년', label: '업력' }] } })
    expect(figs.problems).toEqual([])
    const alone = one({ kind: 'about', statement: '반도체 장비와 의료기기에 들어가는 *정밀 가공 부품*을 만듭니다', facts: [{ label: '설립', value: '2009년' }, { label: '직원', value: '48명' }] })
    expect(alone.problems).toEqual([])
    expect(alone.out.variant).toBe('statement')
  })

  test('proof: a quote, a wall of names or a case; exactly one of them', () => {
    const q = one({ kind: 'proof', quote: { text: '아크메정밀 덕분에 장비 조립 일정이 두 주 빨라졌어요', who: '아크메메디칼 구매팀 김하늘 팀장' } })
    expect(q.problems).toEqual([])
    expect(q.out.variant).toBe('quote')
    const n = one({ kind: 'proof', title: '함께 일하는 고객사', names: ['아크메전자', '아크메메디칼', '아크메테크', '아크메로보틱스', '아크메기계'] })
    expect(n.problems).toEqual([])
    expect(n.out.variant).toBe('names')
    const c = one({ kind: 'proof', title: '조립 일정을 앞당긴 사례', figure: { kind: 'compare', before: { label: '이전', head: '자주 멈춘 조립' }, after: { label: '결과', head: '두 주 빨라진 일정' } } })
    expect(c.problems).toEqual([])
    expect(one({ kind: 'proof', title: '고객', names: ['아크메전자', '아크메테크', '아크메기계'], quote: { text: '좋아요', who: '아크메' } }).problems.join('\n')).toContain('give exactly one of quote, names or a compare figure')
  })

  test('the closing: one line, an action pill, a ledger of contacts, the accent on the drawn ground; page number only', () => {
    const d = doc([cover(), { kind: 'about', statement: '정밀 부품을 만듭니다' }, contact], { accents: { 2: ACCENT } })
    const problems: string[] = []
    const out = layoutSlide2(d, 2, undefined, problems)
    expect(problems).toEqual([])
    expect(out.variant).toBe('accent')
    expect(out.items.filter((it) => it.t === 'svg')).toHaveLength(1)
    const t = allText(out.items)
    for (const s of ['첫 견적 무료', 'sales@acme-precision.example', '031-555-0142', '경기도 안산시 단원구 예시로 12', 'acme-precision.example', '03 / 03']) expect(t.replace(/\n/g, ' ')).toContain(s)
    // the pill behind the offer
    expect(paths(out.items).some((p) => !!p.fill && p.role === undefined && /C/.test(p.d))).toBe(true)
    expect(fadeUnder(out, 'line')).toBe(0)
  })

  test('content slides: the running footer ("company · section", "NN / TT"), one figure, no accent', () => {
    const slides: DeckSlide2[] = [cover(), { kind: 'about', statement: '정밀 부품을 만듭니다' },
      { kind: 'needs', title: '부품 때문에 일정이 밀린다면', figure: { kind: 'merge', inputs: ['전화', '이메일', '방문'], target: { icon: 'inbox', head: '한곳으로' } } },
      { kind: 'offer', title: '설계부터 납품까지', sub: '도면 한 장으로 시작해요', figure: { kind: 'layers', items: [{ head: '납품' }, { head: '가공' }, { head: '설계' }] } },
      { kind: 'numbers', title: '숫자로 보는 회사', note: '2025년 12월 기준', figure: { kind: 'figures', items: [{ number: '340곳', label: '고객사' }, { number: '0.02%', label: '불량률' }] } },
      { kind: 'products', title: '주요 부품', figure: { kind: 'cards', items: [{ name: '정밀 샤프트', picture: IMG + 'p1.jpg' }, { name: '진공 블록', picture: IMG + 'p2.jpg' }] } },
      { kind: 'process', title: '주문은 이렇게 진행돼요', figure: { kind: 'flow', steps: [{ head: '상담' }, { head: '견적' }, { head: '가공' }] } },
      { kind: 'history', title: '한 걸음씩 걸어왔어요', figure: { kind: 'timeline', items: [{ when: '2009', head: '창업' }, { when: '2014', head: '의료 부품' }, { when: '2019', head: '두 번째 공장' }] } },
      contact]
    for (const theme of ['paper', 'ink', 'brand'] as const) {
      const out = layoutDeck2(doc(slides, { theme, sections: slides.map((s, i) => (i === 0 ? '표지' : `섹션${i}`)), accents: { 4: ACCENT } }))
      expect(out.problems, theme).toEqual([])
      for (let i = 2; i <= 7; i++) {
        const s = out.slides[i]!
        const t = allText(s.items)
        expect(t, `${theme} ${i}`).toContain(`아크메정밀  ·  섹션${i}`)
        expect(t).toContain(`${String(i + 1).padStart(2, '0')} / 09`)
        expect(s.items.some((it) => it.t === 'svg'), `${theme} ${i}: no accent on a content slide`).toBe(false)
        sane(s.items)
      }
    }
  })

  test('every band: figures stay between the title and the footer', () => {
    for (const [kind, pair] of Object.entries(samples(ko))) {
      const r = draw(pair[1])
      for (const it of texts(r.items)) {
        expect(it.y, kind).toBeGreaterThanOrEqual(BAND_TOP - 140)
        expect(it.y + it.lh * it.lines.length, `${kind}: ${lineText(it).join(' ')}`).toBeLessThanOrEqual(BAND_BOTTOM + 40)
      }
      void CW
    }
  })
})
