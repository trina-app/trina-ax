// Where everything of a promo video scene goes, per style and per scene (docs/DECISIONS.md "V"). Pure geometry in
// design pixels of the 1080×1350 frame, sized from the measured font (metrics.ts): a headline gets the largest size at
// which its lines fit the text box and the whole block fits its area, down to the style's smallest; a line that does
// not fit even then is a problem the server sends back to the AI (spec.ts), never a clipped frame.
import { contrast, INK, isGrey, lightenToContrast, onColor, towardContrast, WHITE } from './colors'
import { fitSize, textWidth, wrapLines, type Weight } from './metrics'

export const PROMO_STYLE_IDS = ['bold', 'editorial', 'night'] as const
export type PromoStyle = (typeof PROMO_STYLE_IDS)[number]
export const SCENE_KINDS = ['cover', 'problem', 'solution', 'proof', 'cta'] as const
export type SceneKind = (typeof SCENE_KINDS)[number]

export interface PromoPicture { src: string; width: number; height: number; focus: string }
export interface PromoScene { kind: SceneKind; eyebrow: string; headline: string[]; sub: string; picture: PromoPicture | null; number?: string; label?: string }
export interface PromoDoc { style: PromoStyle; lang: string; company: string; website: string | null; brand: string | null; logo: PromoPicture | null; scenes: PromoScene[] }

/** Scene times: each scene's start and end (the next one starts `transition` before it ends), and the total. */
export function sceneTimes(): { times: [number, number][]; transition: number; duration: number } {
  const T = 0.5
  // the readable time of each scene (start to the next one's start); the last one holds the logo
  const lengths = [2.7, 2.7, 2.7, 2.8]
  const times: [number, number][] = []
  let at = 0
  for (const len of lengths) { times.push([at, at + len + T]); at += len }
  const duration = Math.round((at + 3.4) * 10) / 10
  times.push([at, duration])
  return { times, transition: T, duration }
}

const PAPER = { bold: '#f5f2ec', editorial: '#f3efe7' }
const NIGHT = '#0b0c0f'
const DARK = '#121212'

export interface Palette {
  base: string; brand: string; onBrand: string
  /** the brand colour as small text on the style's paper (4.5:1, hue kept); near-black for a light brand */
  brandInk: string
  /** the brand colour as large text on paper (3:1, as WCAG allows for large text); near-black for a light brand */
  brandBig: string
  /** a light brand (yellow, mint): its colour marks shapes and highlights only, never text on paper */
  light: boolean
  brandLight: string; paper: string; hasBrand: boolean
}
/** The style's colours from the brand colour (a grey or no brand colour: the style's neutral palette). */
export function BRAND(doc: Pick<PromoDoc, 'style' | 'brand'>): Palette {
  const has = !!doc.brand && !isGrey(doc.brand)
  // a black-and-white brand keeps its black
  const brand = doc.brand && (has || contrast(doc.brand, WHITE) >= 7) ? doc.brand : '#161616'
  const paper = doc.style === 'night' ? NIGHT : PAPER[doc.style]
  const onPaper = doc.style === 'night' ? PAPER.bold : paper
  const light = contrast(brand, onPaper) < 3
  return {
    base: doc.style === 'bold' ? brand : paper,
    brand,
    onBrand: onColor(brand),
    brandInk: light ? INK : towardContrast(brand, onPaper, 4.5, '#000000'),
    brandBig: light ? INK : brand,
    light,
    brandLight: has ? lightenToContrast(brand, doc.style === 'night' ? NIGHT : DARK, 4.5) : towardContrast('#d9d4c8', doc.style === 'night' ? NIGHT : DARK, 4.5, '#ffffff'),
    paper,
    hasBrand: has,
  }
}

export interface TextBox {
  cls: string
  left?: number; right?: number; top?: number; bottom?: number; width?: number; height?: number
  align?: 'left' | 'center'
  justify?: 'flex-start' | 'center' | 'flex-end'
  gap?: number
  color?: string
}
export interface SceneLayout {
  bg: string
  photo: { reveal: 'pv-wipe-down' | 'pv-wipe-right' | 'pv-fade' | 'none' } | null
  panel: { css: string } | null
  header: string | null
  shapes: { css: string; anim: string }[]
  boxes: TextBox[]
  eyebrow: { text: string; size: number; weight: Weight; tracking: number; color: string }
  eyebrowMark: { w: number; h: number; r: number; color: string } | null
  headline: { size: number; weight: Weight; tracking: number; lh: number; color: string; mt: number }
  sub: { size: number; weight: Weight; lh: number; color: string; width: number; mt: number }
  number: { size: number; weight: Weight; tracking: number; color: string; glow: string | null; mt: number; mb: number; rule: { w: number; h: number; color: string; origin: string } | null; highlight: string | null } | null
  label: { size: number; weight: Weight; color: string } | null
  website: { size: number; color: string; mt: number; pill: string | null; underline: boolean } | null
  logo: { tileW: number; tileH: number; imgW: number; imgH: number } | null
  wordmark: number
  logoInText: boolean
  logoCorner: { left: number; top: number; color: string } | null
  logoFloat: { top: number; color: string } | null
  /** extra delay of every text animation (a panel rises first) */
  textDelay: number
}

const W = 904
/** A proof scene without a number (the material has none) is set like a statement: the problem scene's type and box. */
const ruleKind = (s: Pick<PromoScene, 'kind' | 'number'>): SceneKind => (s.kind === 'proof' && !s.number ? 'problem' : s.kind)
const M = 88
const hasHangul = (s: string) => /[ㄱ-ㆎ가-힣]/.test(s)
/** an eyebrow without Hangul is set in capitals, spaced wider */
const eyebrowText = (s: string) => (hasHangul(s) ? s : s.toUpperCase())

/** What one scene's text needs: the box width, the area height it must fit in, and the type of each part. */
interface Rules {
  width: number
  /** the height the whole text block may take */
  area: number
  headline: { weight: Weight; tracking: number; lh: number; max: number; min: number }
  sub: { size: number; weight: Weight; lh: number }
  eyebrow: { size: number; weight: Weight; tracking: number }
  number?: { weight: Weight; tracking: number; max: number; min: number }
  label?: { size: number; weight: Weight }
}

/** The text block's box of a scene (the area its text must fit in). */
export function txBox(style: PromoStyle, kind: SceneKind, photo: boolean): TextBox {
  const tx = (top: number, bottom: number, justify: TextBox['justify'], align: TextBox['align'] = 'left'): TextBox =>
    ({ cls: 'tx', left: style === 'night' ? 100 : M, right: style === 'night' ? 100 : M, top, bottom, justify, align })
  if (style === 'bold') {
    switch (kind) {
      case 'cover': return photo ? tx(820, 112, 'flex-end') : tx(300, 124, 'flex-end')
      case 'problem': return photo ? tx(680, 90, 'center') : tx(180, 380, 'center')
      case 'solution': return photo ? tx(740, 90, 'center') : tx(220, 470, 'flex-start')
      case 'proof': return photo ? tx(540, 80, 'center') : tx(190, 120, 'flex-start')
      case 'cta': return photo ? tx(590, 80, 'center', 'center') : tx(120, 120, 'center', 'center')
    }
  }
  if (style === 'editorial') {
    switch (kind) {
      case 'cover': return photo ? tx(840, 100, 'center') : tx(520, 120, 'flex-end')
      case 'problem': return photo ? tx(840, 100, 'center') : tx(180, 160, 'center')
      case 'solution': return photo ? tx(840, 100, 'center') : tx(200, 300, 'flex-end')
      case 'proof': return photo ? tx(610, 100, 'flex-start') : tx(190, 110, 'flex-start')
      case 'cta': return photo ? tx(730, 90, 'flex-start', 'center') : tx(150, 130, 'center', 'center')
    }
  }
  const h = nightPhotoHeight(kind)
  return photo ? tx(h - 40, 100, 'flex-start', 'center') : tx(120, 120, 'center', 'center')
}
export const nightPhotoHeight = (kind: SceneKind) => (kind === 'cta' ? 640 : kind === 'proof' ? 560 : 780)
const areaOf = (b: TextBox) => 1350 - (b.top ?? 0) - (b.bottom ?? 0)

function rules(style: PromoStyle, kind: SceneKind, photo: boolean): Rules {
  const bold = style === 'bold', ed = style === 'editorial'
  const area = areaOf(txBox(style, kind, photo))
  const hw: Weight = bold ? 800 : 700
  const ht = bold ? -0.04 : ed ? -0.035 : -0.03
  const lh = bold ? 1.06 : ed ? 1.1 : 1.14
  const width = style === 'night' ? 880 : W
  const sub = { size: kind === 'proof' ? 34 : bold ? 38 : 36, weight: 500 as Weight, lh: 1.42 }
  const eyebrow = { size: bold ? 34 : 30, weight: (style === 'night' ? 600 : 700) as Weight, tracking: style === 'night' ? 0.2 : bold ? 0.06 : 0.04 }
  const H = (max: number, min: number) => ({ weight: hw, tracking: ht, lh, max, min })
  switch (kind) {
    case 'cover': return { width, area, headline: photo ? H(bold ? 112 : 92, 64) : H(bold ? 156 : ed ? 128 : 120, 72), sub, eyebrow }
    case 'problem': case 'solution': return { width, area, headline: photo ? H(bold ? 100 : 92, 62) : H(bold ? 124 : ed ? 120 : 116, 70), sub, eyebrow }
    case 'proof': return {
      width, area, headline: H(bold ? 76 : 68, 50), sub, eyebrow,
      number: { weight: bold ? 800 : ed ? 700 : 600, tracking: -0.04, max: photo ? 230 : (bold ? 320 : 300), min: 110 },
      label: { size: bold ? 40 : 36, weight: 600 },
    }
    case 'cta': return { width, area, headline: photo ? H(bold ? 88 : 84, 58) : H(bold ? 104 : 96, 62), sub, eyebrow }
  }
}

export interface Fitted { headline: number; sub: string[]; number: number | null; wordmark: number; eyebrowFits: boolean; height: number }

const LOGO_H = { corner: 100, text: 150, float: 136 }
const WORDMARK = 64

/** The sizes of one scene's text, or the problems that keep it from fitting (in the AI's own terms). */
export function fitScene(doc: Pick<PromoDoc, 'style' | 'company' | 'logo' | 'website'>, s: PromoScene, photo: boolean): { fit: Fitted | null; problems: string[] } {
  const r = rules(doc.style, ruleKind(s), photo)
  const problems: string[] = []
  const where = `scene "${s.kind}"`
  const eb = eyebrowText(s.eyebrow)
  const eyebrowFits = !s.eyebrow || textWidth(eb, r.eyebrow.size, r.eyebrow.weight, r.eyebrow.tracking) <= r.width
  if (!eyebrowFits) problems.push(`${where}: the eyebrow "${s.eyebrow}" is too long for one line; shorten it (at most about ${Math.floor(r.width / (r.eyebrow.size * (hasHangul(s.eyebrow) ? 0.92 : 0.7)))} characters)`)
  let size = fitSize(s.headline, r.width, r.headline.weight, r.headline.tracking, r.headline.max, r.headline.min)
  if (size === null) {
    const perLine = Math.floor(r.width / (r.headline.min * 0.864 + r.headline.min * r.headline.tracking))
    problems.push(`${where}: the headline line "${[...s.headline].sort((a, b) => textWidth(b, 1, 700) - textWidth(a, 1, 700))[0]}" is too wide; keep each headline line to about ${perLine} Korean characters or ${Math.round(perLine * 1.6)} Latin letters (split it into two lines or say it shorter)`)
  }
  const sub = s.sub ? wrapLines(s.sub, r.width, r.sub.size, r.sub.weight, -0.01) : []
  if (sub === null || sub.length > 2) problems.push(`${where}: the sub line is too long (it must fit two lines of about ${Math.floor(r.width / (r.sub.size * 0.874))} Korean characters each); shorten it`)
  let num: number | null = null
  if (s.kind === 'proof' && r.number && s.number) {
    num = fitSize([s.number], r.width, r.number.weight, r.number.tracking, r.number.max, r.number.min)
    if (num === null) problems.push(`${where}: the number "${s.number}" is too long to show large; give only the number and its unit (put the rest in the label)`)
  }
  let wordmark = WORDMARK
  if (!doc.logo) {
    const w = textWidth(doc.company, 1, 800, -0.03)
    wordmark = Math.max(34, Math.min(WORDMARK, Math.floor((r.width - 40) / w)))
  }
  if (problems.length || size === null || sub === null) return { fit: null, problems }
  // the whole block must fit its area: the headline gets smaller first (never below its smallest)
  const block = (h: number) => {
    let y = 0
    if (s.eyebrow) y += r.eyebrow.size * 1.25 + 26
    if (s.kind === 'proof' && num) y += num + 30 + (s.label ? (r.label!.size * 1.3) + 10 : 0) + 40
    // the last scene's logo is in the text block, except editorial's over the photo's edge
    if (s.kind === 'cta' && !(doc.style === 'editorial' && photo)) y += (doc.logo ? LOGO_H.text : wordmark * 1.2) + 56
    y += s.headline.length * h * r.headline.lh
    if (sub.length) y += 28 + sub.length * r.sub.size * r.sub.lh
    if (s.kind === 'cta' && doc.website) y += 52 + 72
    return y
  }
  while (block(size) > r.area && size > r.headline.min) size -= 2
  if (block(size) > r.area && s.kind === 'proof' && num) while (block(size) > r.area && num > r.number!.min) num -= 10
  const height = block(size)
  if (height > r.area) problems.push(`${where}: there is too much text for this scene; shorten the sub line or make the headline one line`)
  return { fit: problems.length ? null : { headline: size, sub, number: num, wordmark, eyebrowFits, height }, problems }
}

/** The logo's tile for a tile height: the picture inside with room around it, never wider than `maxW`. */
function tile(p: PromoPicture, h: number, maxW: number) {
  const pad = Math.round(h * 0.24)
  let ih = h - 2 * pad
  let iw = ih * (p.width / Math.max(1, p.height))
  const maxImg = maxW - 2 * Math.round(h * 0.3)
  if (iw > maxImg) { iw = maxImg; ih = iw / (p.width / Math.max(1, p.height)) }
  return { tileW: Math.max(h, Math.round(iw + 2 * Math.round(h * 0.3))), tileH: h, imgW: Math.round(iw), imgH: Math.round(ih) }
}

const px = (n: number) => `calc(${n} * var(--u))`
const shapeCss = (o: { left?: number; top?: number; right?: number; bottom?: number; w: number; h: number; bg: string; r?: string; extra?: string }) =>
  [o.left !== undefined ? `left:${px(o.left)}` : '', o.top !== undefined ? `top:${px(o.top)}` : '', o.right !== undefined ? `right:${px(o.right)}` : '', o.bottom !== undefined ? `bottom:${px(o.bottom)}` : '',
    `width:${px(o.w)}`, `height:${px(o.h)}`, `background:${o.bg}`, o.r ? `border-radius:${o.r}` : '', o.extra ?? ''].filter(Boolean).join(';')
const rgba = (hex: string, a: number) => {
  const n = Number.parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
}
const A = (name: string, dur: number, ease: string, at: number, fill = 'both') => `${name} ${dur}s ${ease} calc(var(--s) + ${at}s) ${fill}`
const E = { expo: 'cubic-bezier(.16,1,.3,1)', back: 'cubic-bezier(.34,1.56,.64,1)', out: 'cubic-bezier(.33,1,.68,1)', lin: 'linear' }

/** The full layout of one scene (fitScene must have passed: the server checked the slots first). */
export function layoutFor(doc: PromoDoc, s: PromoScene, i: number): SceneLayout {
  const photo = !!s.picture
  const r = rules(doc.style, ruleKind(s), photo)
  const f = fitScene(doc, s, photo).fit
  if (!f) throw new Error(`promo video scene ${s.kind} does not fit`)
  const c = BRAND(doc)
  const { times } = sceneTimes()
  const dur = times[i]![1] - times[i]![0]
  const st = doc.style
  const TX = txBox(st, ruleKind(s), photo)
  const base: Omit<SceneLayout, 'bg' | 'boxes'> = {
    photo: null, panel: null, header: null, shapes: [],
    eyebrow: { text: eyebrowText(s.eyebrow), size: r.eyebrow.size, weight: r.eyebrow.weight, tracking: hasHangul(s.eyebrow) ? Math.min(r.eyebrow.tracking, 0.12) : r.eyebrow.tracking + 0.08, color: INK },
    eyebrowMark: null,
    headline: { size: f.headline, weight: r.headline.weight, tracking: r.headline.tracking, lh: r.headline.lh, color: INK, mt: s.eyebrow ? 26 : 0 },
    sub: { size: r.sub.size, weight: r.sub.weight, lh: r.sub.lh, color: '#4a4741', width: r.width, mt: 28 },
    number: null, label: null, website: null, logo: null, wordmark: f.wordmark,
    logoInText: false, logoCorner: null, logoFloat: null, textDelay: 0,
  }
  const L = { ...base } as SceneLayout
  const setColors = (head: string, sub: string, eye: string) => { L.headline.color = head; L.sub.color = sub; L.eyebrow.color = eye }
  if (s.kind === 'proof' && r.number && f.number) {
    L.number = { size: f.number, weight: r.number.weight, tracking: r.number.tracking, color: c.brandBig, glow: null, mt: 14, mb: Math.round(f.number * 0.1), rule: null, highlight: c.light && st !== 'night' ? c.brand : null }
    L.label = { size: r.label!.size, weight: r.label!.weight, color: INK }
    L.headline.mt = 40
  }
  if (s.kind === 'cta') {
    L.logoInText = true
    if (doc.logo) L.logo = tile(doc.logo, LOGO_H.text, 560)
  }

  if (st === 'bold') {
    const onB = c.onBrand
    const onBsub = onB === WHITE ? 'rgba(255,255,255,.86)' : 'rgba(17,17,17,.78)'
    // a proof without a number (the material has none) is laid out as a statement
    switch (ruleKind(s)) {
      case 'cover':
        L.bg = c.brand
        setColors(onB, onBsub, onB)
        L.logoCorner = { left: M, top: M, color: photo ? WHITE : onB }
        if (doc.logo) L.logo = tile(doc.logo, LOGO_H.corner, 420)
        if (photo) {
          L.photo = { reveal: 'none' }
          L.panel = { css: shapeCss({ left: 0, right: 0, top: 760, w: 1080, h: 600, bg: c.brand }) }
          L.boxes = [{ cls: 'p' + i, left: 0, top: 0, width: 1080, height: 1350 }, TX]
          L.textDelay = 0.3
        } else {
          L.shapes.push({ css: shapeCss({ left: 430, top: -300, w: 900, h: 900, bg: rgba(onB, 0.1), r: '50%' }), anim: A('pv-pop', 1.2, E.expo, 0) })
          L.shapes.push({ css: shapeCss({ left: 640, top: 330, w: 190, h: 190, bg: 'transparent', r: '50%', extra: `border:${px(16)} solid ${rgba(onB, 0.92)}` }), anim: A('pv-pop', 0.9, E.back, 0.45) })
          L.boxes = [TX]
        }
        break
      case 'problem':
        L.bg = c.paper
        setColors(INK, '#4a4741', c.brandInk)
        L.eyebrowMark = { w: 44, h: 8, r: 0, color: c.brand }
        if (photo) {
          L.photo = { reveal: 'pv-wipe-down' }
          L.boxes = [{ cls: 'p' + i, left: 0, top: 0, width: 1080, height: 640 }, TX]
        } else {
          L.shapes.push({ css: shapeCss({ right: -200, bottom: -200, w: 560, h: 560, bg: c.brand, r: '50%' }), anim: A('pv-pop', 1.0, E.expo, 0.25) })
          L.boxes = [TX]
        }
        break
      case 'solution':
        L.bg = DARK
        setColors(WHITE, 'rgba(255,255,255,.78)', c.brandLight)
        if (photo) {
          L.photo = { reveal: 'pv-wipe-right' }
          L.boxes = [{ cls: 'p' + i, left: M, top: 112, width: W, height: 600 }, TX]
        } else {
          L.shapes.push({ css: shapeCss({ left: 560, top: 880, w: 720, h: 720, bg: c.brand, r: '50%' }), anim: A('pv-pop', 1.1, E.expo, 0.2) })
          L.boxes = [TX]
        }
        break
      case 'proof':
        L.bg = c.paper
        setColors(INK, '#4a4741', INK)
        if (photo) {
          L.photo = { reveal: 'pv-wipe-down' }
          L.boxes = [{ cls: 'p' + i, left: 0, top: 0, width: 1080, height: 500 }, TX]
        } else {
          L.shapes.push({ css: shapeCss({ left: 0, top: 0, w: 1080, h: 18, bg: c.brand, extra: 'transform-origin:left center' }), anim: A('pv-grow-x', 1.0, E.expo, 0) })
          L.boxes = [TX]
        }
        break
      case 'cta':
        L.bg = c.brand
        setColors(onB, onBsub, onB)
        L.website = { size: 30, color: onB, mt: 52, pill: rgba(onB, 0.9), underline: false }
        if (photo) {
          L.photo = { reveal: 'none' }
          L.panel = { css: shapeCss({ left: 0, right: 0, top: 540, w: 1080, h: 820, bg: c.brand }) }
          L.boxes = [{ cls: 'p' + i, left: 0, top: 0, width: 1080, height: 1350 }, TX]
          L.textDelay = 0.3
        } else {
          L.shapes.push({ css: shapeCss({ left: -260, top: -260, w: 700, h: 700, bg: rgba(onB, 0.08), r: '50%' }), anim: A('pv-pop', 1.2, E.expo, 0) })
          L.shapes.push({ css: shapeCss({ right: -180, bottom: -220, w: 560, h: 560, bg: rgba(onB, 0.08), r: '50%' }), anim: A('pv-pop', 1.2, E.expo, 0.15) })
          L.boxes = [TX]
        }
        break
    }
  } else if (st === 'editorial') {
    const muted = '#5f5a52'
    L.bg = c.paper
    setColors(INK, muted, c.brandInk)
    L.eyebrowMark = { w: 14, h: 14, r: 0, color: c.brand }
    L.header = `<div style="position:absolute;left:${px(M)};right:${px(M)};top:${px(58)};display:flex;justify-content:space-between;align-items:center;font-size:${px(25)};letter-spacing:.01em;color:${INK}"><span style="font-weight:600">${escText(doc.company)}</span><span style="font-weight:500;color:${muted};font-variant-numeric:tabular-nums">${String(i + 1).padStart(2, '0')} / 05</span></div><span class="shape" style="left:${px(M)};right:${px(M)};top:${px(106)};height:${px(2)};background:${rgba(INK, 0.16)};transform-origin:left center;animation:${i === 0 ? A('pv-grow-x', 1.2, E.expo, 0) : 'none'}"></span>`
    const frame = (h: number) => ({ cls: 'p' + i, left: M, top: 150, width: W, height: h })
    // a proof without a number (the material has none) is laid out as a statement
    switch (ruleKind(s)) {
      case 'cover':
        if (photo) {
          L.photo = { reveal: 'pv-wipe-right' }
          L.boxes = [frame(650), TX]
        } else {
          L.shapes.push({ css: shapeCss({ left: M, top: 190, w: 300, h: 300, bg: c.brand, r: '50%' }), anim: A('pv-pop', 1.0, E.expo, 0.05) })
          L.boxes = [TX]
        }
        break
      case 'problem':
      case 'solution':
        if (photo) {
          L.photo = { reveal: 'pv-wipe-right' }
          L.boxes = [frame(650), TX]
        } else if (s.kind === 'problem') {
          L.shapes.push({ css: shapeCss({ left: M, top: 170, w: 10, h: 300, bg: c.brand, extra: 'transform-origin:center top' }), anim: A('pv-grow-y', 0.9, E.expo, 0.05) })
          L.boxes = [TX]
        } else {
          L.shapes.push({ css: shapeCss({ left: 0, bottom: 0, w: 1080, h: 200, bg: c.brand, extra: 'clip-path:inset(0)' }), anim: A('pv-wipe-right', 1.1, E.expo, 0.05) })
          L.boxes = [TX]
        }
        break
      case 'proof':
        L.number!.rule = { w: W, h: 2, color: rgba(INK, 0.2), origin: 'left center' }
        L.number!.mb = Math.round(L.number!.mb + 16)
        L.label!.size = 34
        if (photo) {
          L.photo = { reveal: 'pv-wipe-right' }
          L.boxes = [frame(420), TX]
        } else {
          L.boxes = [TX]
        }
        break
      case 'cta':
        L.website = { size: 30, color: c.brandInk, mt: 50, pill: null, underline: true }
        if (doc.logo) L.logo = tile(doc.logo, LOGO_H.text, 560)
        if (photo) {
          L.photo = { reveal: 'pv-wipe-right' }
          L.logoInText = false
          if (doc.logo) L.logo = tile(doc.logo, LOGO_H.float, 520)
          L.logoFloat = { top: 630 - LOGO_H.float / 2, color: INK }
          L.headline.mt = 0
          L.boxes = [frame(480), TX]
        } else {
          L.boxes = [TX]
        }
        break
    }
  } else {
    // night
    const glow = c.brandLight
    L.bg = NIGHT
    setColors('#f4f3ef', '#a9a8a2', glow)
    L.sub.color = '#a9a8a2'
    const spots: [number, number][] = [[-200, -260], [380, 520], [-320, 300], [140, -340], [90, 360]]
    const [gx, gy] = spots[i % spots.length]!
    // the glow: the brand colour, or without one a cool neutral light (a light, never a colour shown as the brand's)
    const light = c.hasBrand ? glow : '#8fa4ff'
    L.shapes.push({ css: shapeCss({ left: gx, top: gy, w: 1100, h: 1100, bg: `radial-gradient(closest-side,${rgba(light, c.hasBrand ? 0.42 : 0.2)},${rgba(light, 0)})`, r: '50%' }), anim: `${A('pv-drift', dur + 0.4, E.out, 0)},${A('pv-fade', 1.4, E.out, 0)}` })
    // the frame: the company and the scene count on the dark (not over a photo), and a progress hairline that fills
    // scene by scene (a still shows how far it is)
    const counter = `${String(i + 1).padStart(2, '0')} / ${String(SCENE_KINDS.length).padStart(2, '0')}`
    L.header = (photo ? '' : `<div style="position:absolute;left:${px(100)};right:${px(100)};top:${px(76)};display:flex;justify-content:space-between;align-items:center;font-size:${px(24)};font-weight:600;letter-spacing:.06em;color:rgba(244,243,239,.62);animation:${A('pv-fade', 0.8, E.out, 0.1)}"><span>${escText(doc.company)}</span><span style="font-variant-numeric:tabular-nums">${counter}</span></div>`) +
      `<span class="shape" style="left:${px(100)};width:${px(880)};bottom:${px(72)};height:${px(2)};background:rgba(244,243,239,.14)"></span>` +
      `<span class="shape" style="left:${px(100)};width:${px(880)};bottom:${px(72)};height:${px(2)};background:${glow};transform-origin:left center;transform:scaleX(${(i + 1) / SCENE_KINDS.length});animation:${A(`pv-p${i}`, dur, E.lin, 0)}"></span>`
    if (L.number) {
      L.number.color = glow
      L.number.glow = rgba(glow, 0.55)
      L.number.rule = { w: 140, h: 3, color: glow, origin: 'center' }
      L.number.mb = Math.round(L.number.mb + 18)
      if (L.label) { L.label.color = '#f4f3ef'; L.label.size = 34 }
    }
    if (s.kind === 'cta') L.website = { size: 30, color: glow, mt: 50, pill: null, underline: false }
    if (photo) {
      L.photo = { reveal: 'pv-fade' }
      const h = nightPhotoHeight(ruleKind(s))
      L.boxes = [{ cls: 'p' + i, left: 0, top: 0, width: 1080, height: h }, TX]
    } else {
      L.boxes = [TX]
    }
  }
  return L
}

function escText(s: string) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') }

/** The CSS a photo box gets besides its place (night: the photo fades into the dark below it; bold solution: a card). */
export function photoExtra(style: PromoStyle, kind: SceneKind): string {
  if (style === 'night') return '-webkit-mask-image:linear-gradient(#000 45%,transparent 97%);mask-image:linear-gradient(#000 45%,transparent 97%)'
  if (style === 'bold' && kind === 'solution') return `border-radius:${px(28)}`
  return ''
}
