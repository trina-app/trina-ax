// The intro deck's layout (docs/DECISIONS.md "D2"): the checked slots and the theme become a display list, one per
// slide, and every decision is made here once: the variant of each slide, line breaks and sizes (text.ts), crops,
// grounds. The preview (html.ts), the PowerPoint file (pptx.ts) and the PDF (typst.ts) only place what this says, so
// the three look the same.
//
// The grid: 1920 × 1080, margins 120 left and right, 104 top, 96 bottom, 12 columns with 40 px gutters; the eyebrow
// and the title stand in the same place on every content slide; content sits between y 360 and 984.
import type { DeckSlide, DeckTheme, Locale } from '@mycel/shared/api'
import { fitText, labelCase, perLine, ROLES, SLACK, width, type Fitted, type Role, type Weight } from './text'
import { lookFor, type DeckLook, type Ground } from './theme'

export const SLIDE_W = 1920
export const SLIDE_H = 1080
const ML = 120
const CW = 1680
const TOP = 104
const BOTTOM = 984
const GUT = 40
const COL = (CW - 11 * GUT) / 12
const span = (n: number) => n * COL + (n - 1) * GUT
const EYEBROW_Y = TOP
const TITLE_Y = 160
const FOOTER_Y = 1006
/** Where a block `h` tall starts under a title ending at `above`: a little below the middle of the room left, at
 * least `min` under the title, never past the content area's bottom. */
function settle(above: number, h: number, min = 88): number {
  const lo = above + min, hi = BOTTOM - h
  if (lo >= hi) return Math.round(Math.max(hi, above + 32))
  return Math.round(Math.min(hi, Math.max(lo, above + (BOTTOM - above - h) * 0.56)))
}

export type Focus = 'center' | 'top' | 'bottom' | 'left' | 'right'
export type LogoTreat = 'direct' | 'mono' | 'chip' | 'tile'
export interface PicInfo { width: number; height: number; /** a PNG with a transparent surround (a product cut out, a screen mock-up): shown whole, never cropped */ cutout?: boolean }
export interface DeckLogo { src: string; width: number; height: number; /** on dark grounds */ dark: LogoTreat; /** on light grounds */ light: LogoTreat }

/** The checked deck: the slots as the AI wrote them (trimmed), the pictures that can be read (by team path), the
 * notes of each slide (the sources of its numbers and names). */
export interface DeckDoc {
  theme: DeckTheme
  lang: Locale
  title: string
  company: string
  website: string | null
  brand: string | null
  logo: DeckLogo | null
  slides: DeckSlide[]
  pics: Record<string, PicInfo>
  notes: string[][]
}

// ── the display list ───────────────────────────────────────────────────────────────────────────────────────────
export interface TextRun { text: string; color: string; size?: number; weight?: Weight }
export interface TextItem {
  t: 'text'
  /** the box: left, top of the first line box, width */
  x: number; y: number; w: number
  size: number; weight: Weight; tracking: number
  /** line pitch in px */
  lh: number
  align: 'l' | 'r' | 'c'
  lines: TextRun[][]
  /** tabular figures (numbers) */
  tabular?: boolean
  role: string
}
export interface Crop { x: number; y: number; w: number; h: number }
export interface ImageItem {
  t: 'image'
  x: number; y: number; w: number; h: number
  /** team path */
  src: string
  natural: PicInfo
  crop: Crop
  radius: number
  /** draw it in one colour (a logo on a ground it does not read on as it is) */
  recolor?: string
  logo?: boolean
}
export interface Stop { at: number; color: string }
/** linear: `angle` as in CSS (0 runs from the bottom up, 90 from left to right); radial: from the centre to the edge of
 * an ellipse that fills the box */
export type Fill = { solid: string } | { linear: { angle: number; stops: Stop[] } } | { radial: { stops: Stop[] } }
export interface RectItem { t: 'rect'; x: number; y: number; w: number; h: number; fill: Fill; radius: number; ellipse?: boolean }
export interface LineItem { t: 'line'; x1: number; y1: number; x2: number; y2: number; color: string; width: number }
export type Item = TextItem | ImageItem | RectItem | LineItem
export interface SlideOut {
  kind: DeckSlide['kind']
  variant: string
  ground: string
  dark: boolean
  /** what a screen reader calls the slide */
  label: string
  items: Item[]
  notes: string[]
}
export interface DeckOut { look: DeckLook; slides: SlideOut[]; problems: string[]; typeOnly: number[] }

// ── pictures ───────────────────────────────────────────────────────────────────────────────────────────────────
const FOCUS: Record<Focus, [number, number]> = { center: [0.5, 0.5], top: [0.5, 0.2], bottom: [0.5, 0.8], left: [0.2, 0.5], right: [0.8, 0.5] }
/** The part of a picture that fills a frame (cover), kept around the focus. */
export function cropFor(pic: PicInfo, fw: number, fh: number, focus: Focus = 'center'): Crop {
  const fr = fw / fh, ir = pic.width / pic.height
  const [fx, fy] = FOCUS[focus] ?? FOCUS.center
  if (ir > fr) {
    const w = Math.round(pic.height * fr)
    return { x: Math.round((pic.width - w) * fx), y: 0, w, h: pic.height }
  }
  const h = Math.round(pic.width / fr)
  return { x: 0, y: Math.round((pic.height - h) * fy), w: pic.width, h }
}
/** Pictures by frame: full bleed (landscape 1.3–2.4:1, ≥ 1,600 px wide), half a slide (≥ 800 px short side), card (≥ 400). */
export const PIC_RULES = {
  bleed: (p: PicInfo) => p.width >= 1600 && p.width / p.height >= 1.3 && p.width / p.height <= 2.4,
  half: (p: PicInfo) => Math.min(p.width, p.height) >= 800,
  card: (p: PicInfo) => Math.min(p.width, p.height) >= 400,
}

// ── building ───────────────────────────────────────────────────────────────────────────────────────────────────
type Fit = Fitted & { role: Role }
class Slide {
  items: Item[] = []
  constructor(public g: Ground) {}
  rect(x: number, y: number, w: number, h: number, fill: Fill, radius = 0, ellipse = false) { this.items.push({ t: 'rect', x, y, w, h, fill, radius, ellipse }) }
  line(x1: number, y1: number, x2: number, y2: number, color = this.g.line, w = 2) { this.items.push({ t: 'line', x1, y1, x2, y2, color, width: w }) }
  /** A fitted text at (x, y) in a box `w` wide; returns its height. */
  text(f: Fit, x: number, y: number, w: number, color: string, o: { accent?: string; align?: 'l' | 'r' | 'c'; role: string; lh?: number; tabular?: boolean }): number {
    const lh = Math.round(f.size * (o.lh ?? f.role.lh))
    this.items.push({
      t: 'text', x, y, w, size: f.size, weight: f.role.weight, tracking: f.role.tracking, lh, align: o.align ?? 'l', role: o.role, tabular: o.tabular,
      lines: f.lines.map((l) => l.map((r) => ({ text: r.text, color: r.accent && o.accent ? o.accent : color }))),
    })
    return lh * f.lines.length
  }
  image(src: string, pic: PicInfo, x: number, y: number, w: number, h: number, focus: Focus | undefined, radius: number) {
    if (pic.cutout) {
      // whole, inside the frame, centred (a cut-out has its own edges)
      const k = Math.min(w / pic.width, h / pic.height)
      const iw = Math.round(pic.width * k), ih = Math.round(pic.height * k)
      this.items.push({ t: 'image', x: Math.round(x + (w - iw) / 2), y: Math.round(y + (h - ih) / 2), w: iw, h: ih, src, natural: pic, crop: { x: 0, y: 0, w: pic.width, h: pic.height }, radius: 0 })
      return
    }
    this.items.push({ t: 'image', x, y, w, h, src, natural: pic, crop: cropFor(pic, w, h, focus), radius })
  }
}

interface Ctx {
  doc: DeckDoc
  look: DeckLook
  problems: string[]
  typeOnly: number[]
  /** slide index (0-based) */
  i: number
}

/** Fit or report: `where` names the slot in the AI's own terms. */
function fit(c: Ctx, where: string, raw: string | undefined, role: Role, boxW: number, maxLines: number, o: { notch?: boolean; balanced?: boolean; size?: number } = {}): Fit | null {
  if (!raw?.trim()) return null
  const f = fitText(raw, role, boxW, maxLines, o)
  if (!f) {
    c.problems.push(`slides[${c.i}] (${c.doc.slides[c.i]!.kind}) ${where}: "${raw.replace(/\*/g, '').slice(0, 60)}" is too long; it must fit ${maxLines} line${maxLines > 1 ? 's' : ''} of about ${perLine(role, boxW)} Korean characters (or ${Math.round(perLine(role, boxW) * 1.7)} Latin letters)`)
    return null
  }
  return { ...f, role }
}

const label = (s: string) => labelCase(s)
/** A web address as people read it: no scheme, no "www.", no trailing slash. */
export const siteText = (u: string) => u.trim().replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, '')

/** The eyebrow and the title in their fixed place; returns the y under them. */
function header(c: Ctx, s: Slide, eyebrow: string | undefined, title: string | undefined, w = span(10)): number {
  let y = TITLE_Y
  const eb = fit(c, 'eyebrow', eyebrow ? label(eyebrow) : undefined, ROLES.label, w, 1)
  if (eb) s.text(eb, ML, EYEBROW_Y, w, s.g.accent, { role: 'eyebrow' })
  // the accent stays rare: a starred phrase shows on the cover, the about statement and the closing line only; a
  // content slide's title is set in one colour (its eyebrow is the slide's accent)
  const t = fit(c, 'title', title?.replace(/\*/g, ''), ROLES.title, w, 2)
  if (t) y = TITLE_Y + s.text(t, ML, TITLE_Y, w, s.g.text, { role: 'title' })
  return y
}

/** The logo (or the company name) in a box at most `mw` × `mh`; returns its size. */
function logoAt(c: Ctx, s: Slide, x: number, y: number, mw: number, mh: number, o: { name?: Role; nameColor?: string; anchor?: 'top' | 'bottom' } = {}): { w: number; h: number } {
  const L = c.doc.logo
  const pic = L ? c.doc.pics[L.src] : null
  if (L && pic) {
    const treat = s.g.dark ? L.dark : L.light
    const pad = treat === 'chip' || treat === 'tile' ? Math.round(mh * 0.28) : 0
    const k = Math.min((mw - pad * 2) / pic.width, (mh - pad * 2) / pic.height)
    const w = Math.round(pic.width * k), h = Math.round(pic.height * k)
    const top = o.anchor === 'bottom' ? y - h - pad * 2 : y
    if (treat === 'chip') s.rect(x, top, w + pad * 2, h + pad * 2, { solid: s.g.dark ? '#ffffff' : '#141414' }, Math.min(14, pad))
    if (treat === 'tile') {
      s.items.push({ t: 'image', x, y: top, w, h, src: L.src, natural: pic, crop: { x: 0, y: 0, w: pic.width, h: pic.height }, radius: Math.min(16, Math.round(h * 0.18)), logo: true })
      return { w, h }
    }
    s.items.push({ t: 'image', x: x + pad, y: top + pad, w, h, src: L.src, natural: pic, crop: { x: 0, y: 0, w: pic.width, h: pic.height }, radius: 0, logo: true, ...(treat === 'mono' ? { recolor: s.g.text } : {}) })
    return { w: w + pad * 2, h: h + pad * 2 }
  }
  const role = o.name ?? { ...ROLES.head, weight: 800 as const, size: 40, min: 32 }
  // the name as written, however long: up to two lines in a wider box (the AI cannot shorten it)
  const f = fit(c, 'company', c.doc.company, role, Math.max(mw, span(6)), 2)
  if (!f) return { w: 0, h: 0 }
  const h = Math.round(f.size * role.lh)
  s.text(f, x, o.anchor === 'bottom' ? y - h * f.lines.length : y, Math.max(mw, span(6)), o.nameColor ?? s.g.text, { role: 'company' })
  return { w: Math.max(...f.widths, 0), h: h * f.lines.length }
}

/** A logo wider than 2.2:1 is a wordmark: it stands for the name. */
const wordmark = (c: Ctx) => { const L = c.doc.logo; const p = L ? c.doc.pics[L.src] : null; return !!p && p.width / p.height > 2.2 }

function footer(c: Ctx, s: Slide, n: number, o: { name?: boolean; right?: number } = {}) {
  const f = ROLES.footer
  const num = fitText(String(n).padStart(2, '0'), f, 120, 1, { notch: false })!
  s.text({ ...num, role: f }, (o.right ?? SLIDE_W - ML) - 120, FOOTER_Y, 120, s.g.mute, { align: 'r', role: 'footer', tabular: true })
  if (o.name === false) return
  const L = c.doc.logo
  const treat = L ? (s.g.dark ? L.dark : L.light) : null
  if (L && c.doc.pics[L.src] && (treat === 'direct' || treat === 'mono')) {
    const pic = c.doc.pics[L.src]!
    const h = wordmark(c) ? 26 : 34
    const k = Math.min(220 / pic.width, h / pic.height)
    const w = Math.round(pic.width * k), hh = Math.round(pic.height * k)
    s.items.push({ t: 'image', x: ML, y: FOOTER_Y + 15 - Math.round(hh / 2), w, h: hh, src: L.src, natural: pic, crop: { x: 0, y: 0, w: pic.width, h: pic.height }, radius: 0, logo: true, ...(treat === 'mono' ? { recolor: s.g.mute } : {}) })
    return
  }
  const name = fitText(c.doc.company, f, 600, 1, { notch: false })
  if (name) s.text({ ...name, role: f }, ML, FOOTER_Y, 600, s.g.mute, { role: 'footer' })
}

const pic = (c: Ctx, src: string | undefined) => (src && c.doc.pics[src]) || null
const alpha = (hex: string, a: number) => hex.slice(0, 7) + Math.round(Math.max(0, Math.min(1, a)) * 255).toString(16).padStart(2, '0')

/** The soft light behind a cover or the numbers on ink. */
function glow(s: Slide, cx: number, cy: number, r: number, strength = 0.32) {
  if (!s.g.glow) return
  s.rect(cx - r, cy - r * 0.78, r * 2, r * 1.56, { radial: { stops: [{ at: 0, color: alpha(s.g.glow, strength) }, { at: 0.38, color: alpha(s.g.glow, strength * 0.34) }, { at: 0.7, color: alpha(s.g.glow, 0) }, { at: 1, color: alpha(s.g.glow, 0) }] } }, 0, true)
}

// ── the slide kinds ────────────────────────────────────────────────────────────────────────────────────────────
type K<T extends DeckSlide['kind']> = Extract<DeckSlide, { kind: T }>
const lines = (f: Fit | null) => (f ? Math.round(f.size * f.role.lh) * f.lines.length : 0)

function cover(c: Ctx, d: K<'cover'>): { s: Slide; variant: string } {
  const p = pic(c, d.picture)
  const variant = p && !p.cutout && PIC_RULES.bleed(p) ? 'A' : p && PIC_RULES.half(p) ? 'B' : 'C'
  if (d.picture && variant === 'C') c.typeOnly.push(c.i)
  const L = c.look
  const wm = wordmark(c)
  if (variant === 'A') {
    const s = new Slide(L.photo)
    s.image(d.picture!, p!, 0, 0, SLIDE_W, SLIDE_H, d.focus, 0)
    // scrims only where the type sits: from the bottom, from the left, and a little under the logo
    // (a photograph with its own lettering must not fight the headline: the type's corner is held dark enough)
    s.rect(0, 0, SLIDE_W, SLIDE_H, { linear: { angle: 0, stops: [{ at: 0, color: alpha(L.scrim, 0.9) }, { at: 0.42, color: alpha(L.scrim, 0.58) }, { at: 0.8, color: alpha(L.scrim, 0) }] } })
    s.rect(0, 0, SLIDE_W, SLIDE_H, { linear: { angle: 90, stops: [{ at: 0, color: alpha(L.scrim, 0.62) }, { at: 0.38, color: alpha(L.scrim, 0.32) }, { at: 0.7, color: alpha(L.scrim, 0) }] } })
    s.rect(0, 0, SLIDE_W, 320, { linear: { angle: 180, stops: [{ at: 0, color: alpha(L.scrim, 0.4) }, { at: 1, color: alpha(L.scrim, 0) }] } })
    logoAt(c, s, ML, TOP, wm ? 420 : 260, wm ? 80 : 112, { name: { ...ROLES.head, weight: 800, size: 40, min: 32 } })
    coverType(c, s, d, span(11), 952)
    return { s, variant }
  }
  if (variant === 'B') {
    const s = new Slide(L.feature)
    s.rect(0, 0, SLIDE_W, SLIDE_H, { solid: s.g.bg })
    glow(s, 260, 980, 900, 0.26)
    if (p!.cutout) s.image(d.picture!, p!, 1040, 150, SLIDE_W - 1040 - 40, SLIDE_H - 300, d.focus, 0)
    else s.image(d.picture!, p!, 1152, 0, SLIDE_W - 1152, SLIDE_H, d.focus, 0)
    logoAt(c, s, ML, TOP, wm ? 420 : 260, wm ? 80 : 112)
    coverType(c, s, d, (p!.cutout ? 1040 : 1152) - ML - 96, 952, 3, false)
    return { s, variant }
  }
  // type only: the logo, one brand bar, the headline set large, a hairline with the name and the website
  const s = new Slide(L.feature)
  s.rect(0, 0, SLIDE_W, SLIDE_H, { solid: s.g.bg })
  glow(s, 1560, 220, 1100, 0.42)
  logoAt(c, s, ML, TOP, wm ? 420 : 260, wm ? 80 : 112)
  const top = coverType(c, s, d, span(11), 852, 2, false, { ...ROLES.display, size: 128, min: 104 })
  if (top > 0) s.rect(ML, top - 72, 96, 12, { solid: s.g.mark === s.g.bg ? s.g.text : s.g.mark })
  s.line(ML, 936, ML + CW, 936, s.g.line, 2)
  const f = ROLES.footer
  const name = fitText(c.doc.company, f, 800, 1, { notch: false })
  if (name) s.text({ ...name, role: f }, ML, 960, 800, s.g.mute, { role: 'company' })
  if (c.doc.website) {
    const w = fitText(c.doc.website, f, 700, 1, { notch: false })
    if (w) s.text({ ...w, role: f }, SLIDE_W - ML - 700, 960, 700, s.g.mute, { align: 'r', role: 'website' })
  }
  return { s, variant }
}

/** The cover's type, set from the bottom up (its last line's box ends at `bottom`); returns its top. */
function coverType(c: Ctx, s: Slide, d: K<'cover'>, w: number, bottom: number, maxLines = 2, website = true, role: Role = ROLES.display): number {
  const head = fit(c, 'headline', d.headline, role, w, maxLines)
  const sub = fit(c, 'sub', d.sub, ROLES.body, Math.min(w, span(8)), 2)
  const eb = fit(c, 'eyebrow', d.eyebrow ? label(d.eyebrow) : undefined, ROLES.label, w, 1)
  const ebH = Math.round(24 * 1.3) + 32
  let y = bottom - lines(sub) - (sub ? 36 : 0) - lines(head) - (eb ? ebH : 0)
  const top = y
  const photo = s.g === c.look.photo
  if (eb) { s.text(eb, ML, y, w, photo ? s.g.dim : s.g.accent === s.g.text ? s.g.dim : s.g.accent, { role: 'eyebrow' }); y += ebH }
  if (head) y += s.text(head, ML, y, w, s.g.text, { accent: photo ? s.g.text : s.g.accent, role: 'headline' }) + (sub ? 36 : 0)
  if (sub) s.text(sub, ML, y, Math.min(w, span(8)), s.g.dim, { role: 'sub' })
  // the website, small, at the bottom right
  if (website && c.doc.website) {
    const f = fitText(c.doc.website, ROLES.footer, 600, 1, { notch: false })
    if (f) s.text({ ...f, role: ROLES.footer }, SLIDE_W - ML - 600, bottom - Math.round(22 * 1.3), 600, s.g.mute, { align: 'r', role: 'website' })
  }
  return top
}

function about(c: Ctx, d: K<'about'>, n: number): Slide {
  const s = new Slide(c.look.light)
  s.rect(0, 0, SLIDE_W, SLIDE_H, { solid: s.g.bg })
  const eb = fit(c, 'eyebrow', label(d.eyebrow), ROLES.label, span(9), 1)
  if (eb) s.text(eb, ML, EYEBROW_Y, span(9), s.g.accent, { role: 'eyebrow' })
  const facts = d.facts ?? []
  // without facts the statement is the whole slide: set larger
  const role: Role = facts.length ? ROLES.statement : { size: 88, min: 76, weight: 700, tracking: -0.035, lh: 1.26 }
  const st = fit(c, 'statement', d.statement, role, facts.length ? span(9) : span(10), facts.length ? 3 : 4)
  if (st) s.text(st, ML, TITLE_Y, facts.length ? span(9) : span(10), s.g.text, { accent: s.g.accent, role: 'statement' })
  if (facts.length) {
    const k = facts.length
    const cw = (CW - (k - 1) * GUT) / k
    const vals = facts.map((f, i) => fit(c, `facts[${i}].value`, f.value, ROLES.head, cw, 2))
    const y0 = Math.max(TITLE_Y + lines(st) + 96, BOTTOM - 40 - 31 - 18 - Math.max(...vals.map(lines)) - 36)
    facts.forEach((f, i) => {
      const x = ML + i * (cw + GUT)
      s.line(x, y0, x + cw, y0, s.g.line, 2)
      const lb = fit(c, `facts[${i}].label`, label(f.label), ROLES.label, cw, 1)
      if (lb) s.text(lb, x, y0 + 36, cw, s.g.mute, { role: 'label' })
      if (vals[i]) s.text(vals[i]!, x, y0 + 36 + 31 + 18, cw, s.g.text, { role: 'value' })
    })
  }
  footer(c, s, n)
  return s
}

/** Columns of {numeral?, head, body} under hairlines, settled under the title. */
function columns(c: Ctx, s: Slide, above: number, list: { head: string; body?: string }[], o: { numerals?: boolean; where: string; headRole?: Role; bodyLines?: number; maxW?: number }) {
  const k = list.length
  const cw = (CW - (k - 1) * GUT) / k
  const tw = Math.min(cw, o.maxW ?? cw) - (k > 2 ? 24 : 0)
  const heads = list.map((p, i) => fit(c, `${o.where}[${i}].head`, p.head, o.headRole ?? ROLES.head, tw, 2))
  const bodies = list.map((p, i) => fit(c, `${o.where}[${i}].body`, p.body, ROLES.body, tw, o.bodyLines ?? 3))
  const hh = Math.max(...heads.map(lines)), bh = Math.max(...bodies.map(lines))
  const numH = o.numerals ? 64 + 40 : 0
  const block = 44 + numH + hh + (bh ? 20 + bh : 0)
  const y0 = settle(above, block)
  list.forEach((_, i) => {
    const x = ML + i * (cw + GUT)
    s.line(x, y0, x + cw, y0, s.g.line, 2)
    let y = y0 + 44
    if (o.numerals) {
      const nf = fitText(String(i + 1).padStart(2, '0'), { ...ROLES.title, size: 64, min: 64, weight: 800, tracking: -0.02 }, 200, 1, { notch: false })!
      s.text({ ...nf, role: ROLES.title }, x, y, 200, s.g.accent, { role: 'numeral', tabular: true, lh: 1 })
      y += numH
    }
    if (heads[i]) s.text(heads[i]!, x, y, tw, s.g.text, { role: 'head' })
    if (bodies[i]) s.text(bodies[i]!, x, y + hh + 20, tw, s.g.dim, { role: 'body' })
  })
}

/** Rows of {head | body} under hairlines (a ledger): heads in the left `hw` px, bodies beside; settled under the title. */
function rows(c: Ctx, s: Slide, above: number, list: { head: string; body?: string }[], o: { where: string; x: number; w: number; hw: number; headRole?: Role; headColor?: string; bodyLines?: number; pad?: number }) {
  const bw = o.w - o.hw - GUT
  const pad = o.pad ?? 30
  const heads = list.map((p, i) => fit(c, `${o.where}[${i}].head`, p.head, o.headRole ?? ROLES.head, o.hw, 2))
  const bodies = list.map((p, i) => fit(c, `${o.where}[${i}].body`, p.body, ROLES.body, bw, o.bodyLines ?? 2))
  const hs = list.map((_, i) => Math.max(lines(heads[i]!), lines(bodies[i]!)) + pad * 2)
  const total = hs.reduce((a, b) => a + b, 0)
  if (total > BOTTOM - above - 40) c.problems.push(`slides[${c.i}] (${c.doc.slides[c.i]!.kind}): the ${o.where} take more room than the slide has; make them shorter or fewer`)
  let y = settle(above, total, 72)
  list.forEach((_, i) => {
    s.line(o.x, y, o.x + o.w, y, s.g.line, 2)
    const h = heads[i], b = bodies[i]
    // the head's and the body's first baselines on one line
    const hb = h ? Math.round(h.size * h.role.lh) : 0, bb = b ? Math.round(b.size * b.role.lh) : 0
    const shift = h && b ? Math.round((h.size * 0.952 + (hb - h.size * 1.193) / 2) - (b.size * 0.952 + (bb - b.size * 1.193) / 2)) : 0
    if (h) s.text(h, o.x, y + pad, o.hw, o.headColor ?? s.g.text, { role: 'head' })
    if (b) s.text(b, o.x + o.hw + GUT, y + pad + shift, bw, s.g.dim, { role: 'body' })
    y += hs[i]!
  })
  s.line(o.x, y, o.x + o.w, y, s.g.line, 2)
}

function needs(c: Ctx, d: K<'needs'>, n: number): Slide {
  const s = new Slide(c.look.light)
  s.rect(0, 0, SLIDE_W, SLIDE_H, { solid: s.g.bg })
  const above = header(c, s, d.eyebrow, d.title)
  columns(c, s, above, d.points, { numerals: true, where: 'points', maxW: d.points.length === 2 ? span(5) : undefined })
  footer(c, s, n)
  return s
}

function offer(c: Ctx, d: K<'offer'>, n: number): { s: Slide; variant: string } {
  const p = pic(c, d.picture)
  const variant = p && PIC_RULES.half(p) ? 'A' : 'B'
  if (d.picture && variant === 'B') c.typeOnly.push(c.i)
  const s = new Slide(c.look.light)
  s.rect(0, 0, SLIDE_W, SLIDE_H, { solid: s.g.bg })
  const PX = 1152
  const textW = variant === 'A' ? PX - ML - 96 : span(10)
  let y = header(c, s, d.eyebrow, d.title, textW)
  const sub = fit(c, 'sub', d.sub, ROLES.body, Math.min(textW, span(8)), 2)
  if (sub) y += 24 + s.text(sub, ML, y + 24, Math.min(textW, span(8)), s.g.dim, { role: 'sub' })
  if (variant === 'A') {
    if (p!.cutout) { s.rect(PX, 0, SLIDE_W - PX, SLIDE_H, { solid: s.g.panel }); s.image(d.picture!, p!, PX + 64, 120, SLIDE_W - PX - 128, SLIDE_H - 240, d.focus, 0) }
    else s.image(d.picture!, p!, PX, 0, SLIDE_W - PX, SLIDE_H, d.focus, 0)
  }
  rows(c, s, y, d.pillars, { where: 'pillars', x: ML, w: variant === 'A' ? textW : CW, hw: variant === 'A' ? 300 : span(4), pad: variant === 'A' ? 26 : 32 })
  footer(c, s, n, variant === 'A' ? { right: PX - 96 } : {})
  return { s, variant }
}

function numbers(c: Ctx, d: K<'numbers'>, n: number, light: boolean): Slide {
  const s = new Slide(light ? c.look.light : c.look.feature)
  s.rect(0, 0, SLIDE_W, SLIDE_H, { solid: s.g.bg })
  glow(s, 960, 760, 1000, 0.34)
  const above = header(c, s, d.eyebrow, d.title)
  const k = d.stats.length
  // one size for every number: the largest at which each fits its column
  const statSize = (num: string, size: number) => {
    const m = /^(\D*?)(\d[\d.,]*\d|\d)(.*)$/.exec(num.normalize('NFKC'))
    const pre = m?.[1] ?? '', digits = m?.[2] ?? num, unit = m?.[3] ?? ''
    const dw = [...digits].reduce((a, ch) => a + (/\d/.test(ch) ? 0.668 * size : width(ch, size, 800, 0)), 0) - [...digits].length * 0.02 * size
    return { pre, digits, unit: unit.trim(), w: dw + width(pre + unit, size * 0.45, 700, 0) + (unit ? size * 0.06 : 0) }
  }
  const fits = (cols: number, size: number) => { const gap = cols >= 4 ? 64 : 96; const cw = (CW - (cols - 1) * gap) / cols; return d.stats.every((st) => statSize(st.number, size).w * SLACK <= cw) }
  // one row when the numbers fit it large enough; long figures ("1,286,781+") go two to a row instead
  const oneRow = k <= 2 || fits(k, k >= 4 ? 96 : 112)
  const cols = oneRow ? k : 2
  const rowsN = Math.ceil(k / cols)
  const gap = cols >= 4 ? 64 : 96
  const cw = (CW - (cols - 1) * gap) / cols
  const cands = !oneRow ? (rowsN > 1 ? [128, 112, 96, 88] : [150, 128, 112, 96]) : k >= 4 ? [150, 128, 112, 96] : k === 3 ? [168, 150, 128, 112] : [188, 168, 150, 128]
  let size = cands[0]!
  for (const cand of cands) { size = cand; if (d.stats.every((st) => statSize(st.number, cand).w * SLACK <= cw)) break }
  d.stats.forEach((st, i) => { if (statSize(st.number, size).w * SLACK > cw) c.problems.push(`slides[${c.i}] (numbers) stats[${i}].number "${st.number}" is too long to show large; give only the number and its unit as written`) })
  const labels = d.stats.map((st, i) => fit(c, `stats[${i}].label`, st.label, { ...ROLES.body, size: 30, min: 28 }, cw, 2))
  const block = size + 36 + Math.max(...labels.map(lines))
  const rowGap = 56
  const y0 = settle(above, block * rowsN + rowGap * (rowsN - 1) + 60, rowsN > 1 ? 64 : 96)
  d.stats.forEach((st, i) => {
    const col = i % cols, row = Math.floor(i / cols)
    const x = ML + col * (cw + gap), y = y0 + row * (block + rowGap)
    if (col > 0) s.line(x - gap / 2, y + 12, x - gap / 2, y + block, s.g.line, 2)
    const p = statSize(st.number, size)
    const runs: TextRun[] = []
    const small = Math.round(size * 0.45)
    if (p.pre) runs.push({ text: p.pre, color: s.g.text, size: small, weight: 700 })
    runs.push({ text: p.digits, color: s.g.text })
    if (p.unit) runs.push({ text: (/^[%°/]/.test(p.unit) ? '' : '\u2009') + p.unit, color: s.g.text, size: small, weight: 700 })
    s.items.push({ t: 'text', x, y, w: cw, size, weight: 800, tracking: -0.025, lh: size, align: 'l', role: 'stat', tabular: true, lines: [runs] })
    if (labels[i]) s.text(labels[i]!, x, y + size + 36, cw, s.g.dim, { role: 'label' })
  })
  const note = fit(c, 'note', d.note, ROLES.small, CW, 1)
  if (note) s.text(note, ML, 940, CW, s.g.mute, { role: 'note' })
  footer(c, s, n)
  return s
}

function products(c: Ctx, d: K<'products'>, n: number): { s: Slide; variant: string } {
  const withPics = d.items.every((it) => { const p = pic(c, it.picture); return p && PIC_RULES.card(p) })
  if (!withPics && d.items.some((it) => it.picture)) c.typeOnly.push(c.i)
  const variant = withPics ? 'A' : 'B'
  const s = new Slide(c.look.light)
  s.rect(0, 0, SLIDE_W, SLIDE_H, { solid: s.g.bg })
  const yh = header(c, s, d.eyebrow, d.title)
  const k = d.items.length
  const cw = (CW - (k - 1) * GUT) / k
  const R = c.look.radius
  const headRole: Role = k >= 4 ? { ...ROLES.head, size: 36, min: 32 } : ROLES.head
  const pad = variant === 'B' ? 44 : 0
  const names = d.items.map((it, i) => fit(c, `items[${i}].name`, it.name, headRole, cw - pad * 2, 2))
  const bodies = d.items.map((it, i) => fit(c, `items[${i}].body`, it.body, ROLES.body, cw - pad * 2, k >= 4 ? 4 : 3))
  const nh = Math.max(...names.map(lines)), bh = Math.max(...bodies.map(lines))
  const top = Math.max(400, yh + 80)
  if (variant === 'A') {
    const ph = Math.min(k >= 4 ? 330 : k === 3 ? 360 : 380, BOTTOM - top - 36 - nh - 12 - bh)
    const y0 = settle(yh, ph + 36 + nh + 12 + bh, 80)
    d.items.forEach((it, i) => {
      const x = ML + i * (cw + GUT)
      const p = pic(c, it.picture)!
      if (p.cutout) { s.rect(x, y0, cw, ph, { solid: s.g.panel }, R); s.image(it.picture!, p, x + 24, y0 + 24, cw - 48, ph - 48, it.focus, 0) }
      else s.image(it.picture!, p, x, y0, cw, ph, it.focus, R)
      if (names[i]) s.text(names[i]!, x, y0 + ph + 36, cw, s.g.text, { role: 'head' })
      if (bodies[i]) s.text(bodies[i]!, x, y0 + ph + 36 + nh + 12, cw, s.g.dim, { role: 'body' })
    })
  } else {
    const ch = Math.min(BOTTOM - top, Math.max(400, 44 + 40 + 120 + nh + 14 + bh + 44))
    const y0 = settle(yh, ch, 80)
    d.items.forEach((_, i) => {
      const x = ML + i * (cw + GUT)
      s.rect(x, y0, cw, ch, { solid: s.g.panel }, R)
      const nf = fitText(String(i + 1).padStart(2, '0'), { ...ROLES.label, size: 28, min: 28, weight: 800, tracking: 0.04 }, 200, 1, { notch: false })!
      s.text({ ...nf, role: ROLES.label }, x + pad, y0 + pad, 200, s.g.accent, { role: 'numeral', tabular: true })
      const b = bodies[i], nm = names[i]
      // every card's name on one line across the row, every body under it at one height
      const y = y0 + ch - pad - bh - (bh ? 14 : 0) - nh
      if (nm) s.text(nm, x + pad, y + nh - lines(nm), cw - pad * 2, s.g.text, { role: 'head' })
      if (b) s.text(b, x + pad, y + nh + 14, cw - pad * 2, s.g.dim, { role: 'body' })
    })
  }
  footer(c, s, n)
  return { s, variant }
}

function process(c: Ctx, d: K<'process'>, n: number): Slide {
  const s = new Slide(c.look.light)
  s.rect(0, 0, SLIDE_W, SLIDE_H, { solid: s.g.bg })
  const above = header(c, s, d.eyebrow, d.title)
  const k = d.steps.length
  const cw = (CW - (k - 1) * GUT) / k
  const headRole: Role = k >= 5 ? { ...ROLES.head, size: 36, min: 32 } : ROLES.head
  const heads = d.steps.map((st, i) => fit(c, `steps[${i}].head`, st.head, headRole, cw - 16, 2))
  const bodies = d.steps.map((st, i) => fit(c, `steps[${i}].body`, st.body, ROLES.body, cw - 16, 3))
  const hh = Math.max(...heads.map(lines)), bh = Math.max(...bodies.map(lines))
  const block = 72 + 40 + 44 + hh + (bh ? 14 + bh : 0)
  const top = settle(above, block)
  const lineY = top + 72 + 40
  s.line(ML, lineY, ML + CW, lineY, s.g.line, 2)
  d.steps.forEach((_, i) => {
    const x = ML + i * (cw + GUT)
    const nf = fitText(String(i + 1).padStart(2, '0'), { ...ROLES.title, size: 72, min: 72, weight: 800, tracking: -0.02 }, 240, 1, { notch: false })!
    s.text({ ...nf, role: ROLES.title }, x, top, 240, s.g.text, { role: 'numeral', tabular: true, lh: 1 })
    s.rect(x, lineY - 8, 16, 16, { solid: s.g.mark }, 8)
    if (heads[i]) s.text(heads[i]!, x, lineY + 44, cw - 16, s.g.text, { role: 'head' })
    if (bodies[i]) s.text(bodies[i]!, x, lineY + 44 + hh + 14, cw - 16, s.g.dim, { role: 'body' })
  })
  footer(c, s, n)
  return s
}

function proof(c: Ctx, d: K<'proof'>, n: number): { s: Slide; variant: string } {
  const s = new Slide(c.look.light)
  s.rect(0, 0, SLIDE_W, SLIDE_H, { solid: s.g.bg })
  const above = header(c, s, d.eyebrow, d.title)
  const given = [d.names?.length, d.quote, d.case].filter(Boolean).length
  if (given !== 1) c.problems.push(`slides[${c.i}] (proof): give exactly one of names, quote or case`)
  if (d.names?.length) {
    const k = d.names.length
    const cols = k <= 4 ? k : k <= 6 ? 3 : 4
    const rws = Math.ceil(k / cols)
    const cw = CW / cols
    const rh = Math.min(rws <= 2 ? 190 : 168, Math.floor((BOTTOM - above - 96) / rws))
    const y0 = settle(above, rh * rws)
    const role: Role = { ...ROLES.head, size: k > 8 ? 36 : 40, min: 32 }
    for (let r = 0; r <= rws; r++) s.line(ML, y0 + r * rh, ML + CW, y0 + r * rh, s.g.line, 2)
    for (let col = 1; col < cols; col++) s.line(ML + col * cw, y0 + 28, ML + col * cw, y0 + rws * rh - 28, s.g.line, 2)
    d.names.forEach((name, i) => {
      const r = Math.floor(i / cols), col = i % cols
      const f = fit(c, `names[${i}]`, name, role, cw - 64, 2)
      if (!f) return
      s.text(f, ML + col * cw + 32, y0 + r * rh + (rh - lines(f)) / 2, cw - 64, s.g.dim, { role: 'name', align: 'c' })
    })
    return { s: (footer(c, s, n), s), variant: 'A' }
  }
  if (d.quote) {
    // a short quote is set large, a long one smaller
    const big: Role = { ...ROLES.quote, size: 72, min: 72, tracking: -0.03, lh: 1.32 }
    const q = fitText(d.quote.text, big, span(10) - 64, 2, { notch: false }) ? fit(c, 'quote.text', d.quote.text, big, span(10) - 64, 2) : fit(c, 'quote.text', d.quote.text, ROLES.quote, span(10) - 64, 4)
    const who = fit(c, 'quote.who', d.quote.who, { ...ROLES.body, weight: 700 }, span(8), 1)
    const block = lines(q) + (who ? 44 + lines(who) : 0)
    const y0 = settle(above, block)
    // a pull quote: one accent rule beside the words
    s.rect(ML, y0 + 8, 8, lines(q) - 16, { solid: s.g.mark })
    if (q) s.text(q, ML + 64, y0, span(10) - 64, s.g.text, { role: 'quote' })
    if (who) s.text(who, ML + 64, y0 + lines(q) + 44, span(8), s.g.dim, { role: 'who' })
    return { s: (footer(c, s, n), s), variant: 'B' }
  }
  if (d.case) {
    const parts = [d.case.before, d.case.action, d.case.result]
    const names = ['before', 'action', 'result']
    const gap = 112
    const cw = (CW - 2 * gap) / 3
    const texts = parts.map((p, i) => fit(c, `case.${names[i]}.text`, p.text, i === 2 ? ROLES.head : ROLES.body, cw, i === 2 ? 3 : 4))
    const block = 40 + 31 + 24 + Math.max(...texts.map(lines))
    const y0 = settle(above, block)
    parts.forEach((p, i) => {
      const x = ML + i * (cw + gap)
      s.line(x, y0, x + cw, y0, i === 2 ? s.g.mark : s.g.line, i === 2 ? 4 : 2)
      const lb = fit(c, `case.${names[i]}.label`, label(p.label), ROLES.label, cw, 1)
      if (lb) s.text(lb, x, y0 + 40, cw, i === 2 ? s.g.accent : s.g.mute, { role: 'label' })
      if (texts[i]) s.text(texts[i]!, x, y0 + 40 + 31 + 24, cw, i === 2 ? s.g.text : s.g.dim, { role: i === 2 ? 'head' : 'body' })
      if (i < 2) {
        const ar = fitText('→', { ...ROLES.head, size: 44, min: 44, weight: 400, tracking: 0 }, 80, 1, { notch: false })!
        s.text({ ...ar, role: ROLES.head }, x + cw + (gap - 60) / 2, y0 + 40 + 31 + 18, 60, s.g.mute, { role: 'arrow', align: 'c' })
      }
    })
    return { s: (footer(c, s, n), s), variant: 'C' }
  }
  footer(c, s, n)
  return { s, variant: 'A' }
}

function history(c: Ctx, d: K<'history'>, n: number): { s: Slide; variant: string } {
  const s = new Slide(c.look.light)
  s.rect(0, 0, SLIDE_W, SLIDE_H, { solid: s.g.bg })
  const above = header(c, s, d.eyebrow, d.title)
  if ([d.items?.length, d.trust?.length].filter(Boolean).length !== 1) c.problems.push(`slides[${c.i}] (history): give exactly one of items or trust`)
  if (d.items?.length) {
    rows(c, s, above, d.items.map((it) => ({ head: it.when, body: it.what })), {
      where: 'items', x: ML, w: CW, hw: span(3), headRole: { ...ROLES.head, size: 40, min: 36, weight: 800, tracking: -0.01 }, headColor: s.g.accent,
      pad: d.items.length > 4 ? 20 : 28,
    })
    return { s: (footer(c, s, n), s), variant: 'A' }
  }
  if (d.trust?.length) {
    const k = d.trust.length
    const cols = k <= 3 ? k : k === 4 ? 2 : 3
    const rws = Math.ceil(k / cols)
    const cw = (CW - (cols - 1) * GUT) / cols
    const fits = d.trust.map((t, i) => fit(c, `trust[${i}]`, t, ROLES.head, cw - 48, 2))
    const rh = Math.max(...fits.map(lines)) + 72
    const y0 = settle(above, rh * rws)
    d.trust.forEach((_, i) => {
      const r = Math.floor(i / cols), col = i % cols
      const x = ML + col * (cw + GUT), y = y0 + r * rh
      s.line(x, y, x + cw, y, s.g.line, 2)
      s.rect(x, y + 36 + 17, 14, 14, { solid: s.g.mark }, c.look.radius ? 7 : 0)
      if (fits[i]) s.text(fits[i]!, x + 48, y + 36, cw - 48, s.g.text, { role: 'head' })
    })
    s.line(ML, y0 + rws * rh, ML + CW, y0 + rws * rh, s.g.line, 2)
    return { s: (footer(c, s, n), s), variant: 'B' }
  }
  footer(c, s, n)
  return { s, variant: 'A' }
}

function scene(c: Ctx, d: K<'scene'>, n: number): { s: Slide; variant: string } | null {
  const p = pic(c, d.picture)
  if (!p || p.cutout || !PIC_RULES.bleed(p)) return null
  const s = new Slide(c.look.photo)
  s.image(d.picture, p, 0, 0, SLIDE_W, SLIDE_H, d.focus, 0)
  s.rect(0, 0, SLIDE_W, SLIDE_H, { linear: { angle: 0, stops: [{ at: 0, color: alpha(c.look.scrim, 0.88) }, { at: 0.36, color: alpha(c.look.scrim, 0.5) }, { at: 0.7, color: alpha(c.look.scrim, 0) }] } })
  s.rect(0, 0, SLIDE_W, SLIDE_H, { linear: { angle: 90, stops: [{ at: 0, color: alpha(c.look.scrim, 0.45) }, { at: 0.6, color: alpha(c.look.scrim, 0) }] } })
  const line = fit(c, 'line', d.line, { ...ROLES.statement, size: 80, min: 68, weight: 800, tracking: -0.035, lh: 1.18 }, span(10), 2)
  const eb = fit(c, 'eyebrow', d.eyebrow ? label(d.eyebrow) : undefined, ROLES.label, span(10), 1)
  let y = 936 - lines(line) - (eb ? 31 + 28 : 0)
  if (eb) { s.text(eb, ML, y, span(10), s.g.dim, { role: 'eyebrow' }); y += 31 + 28 }
  if (line) s.text(line, ML, y, span(10), s.g.text, { role: 'line' })
  footer(c, s, n, { name: false })
  return { s, variant: 'A' }
}

function contact(c: Ctx, d: K<'contact'>, n: number): Slide {
  const s = new Slide(c.look.feature)
  s.rect(0, 0, SLIDE_W, SLIDE_H, { solid: s.g.bg })
  glow(s, 300, 1000, 1000, 0.3)
  logoAt(c, s, ML, TOP, wordmark(c) ? 420 : 260, wordmark(c) ? 80 : 112)
  const eb = fit(c, 'eyebrow', d.eyebrow ? label(d.eyebrow) : undefined, ROLES.label, span(10), 1)
  const line = fit(c, 'line', d.line, ROLES.closing, span(10), 2)
  let y = 404
  if (eb) s.text(eb, ML, y - 31 - 32, span(10), s.g.accent === s.g.text ? s.g.dim : s.g.accent, { role: 'eyebrow' })
  if (line) y += s.text(line, ML, y, span(10), s.g.text, { accent: s.g.accent, role: 'line' })
  if (d.offer) {
    const of = fit(c, 'offer', d.offer, { ...ROLES.body, weight: 700, size: 30, min: 28 }, 700, 1)
    if (of) {
      const tw = of.widths[0] ?? 0
      const w = Math.round(tw + 72)
      const pill = s.g.mark === s.g.bg ? s.g.text : s.g.mark
      s.rect(ML, y + 48, w, 68, { solid: pill }, 34)
      const onPill = pill.toLowerCase() === s.g.text.toLowerCase() ? s.g.bg : (s.g.dark ? '#111111' : '#ffffff')
      // the text's box keeps the 10 % spare room past the pill's padding
      s.text(of, ML + 36, y + 48 + (68 - Math.round(of.size * 1.55)) / 2, Math.round(tw * SLACK) + 4, onPill, { role: 'offer' })
    }
  }
  // the details in up to three columns of four grid columns each: person and phone, email and website, address
  type F = { text: string; strong?: boolean; where: string }
  const cols: F[][] = [
    [d.person ? { text: d.person, strong: true, where: 'person' } : null, d.phone ? { text: d.phone, where: 'phone' } : null],
    [d.email ? { text: d.email, where: 'email' } : null, d.website || c.doc.website ? { text: siteText(d.website || c.doc.website!), where: 'website' } : null],
    [d.address ? { text: d.address, where: 'address' } : null],
  ].map((col) => col.filter((f): f is F => !!f)).filter((col) => col.length)
  if (cols.length) {
    const y0 = 800
    const cw = span(4)
    s.line(ML, y0, ML + CW, y0, s.g.line, 2)
    cols.forEach((col, i) => {
      const x = ML + i * (cw + GUT)
      let yy = y0 + 40
      for (const f of col) {
        const ft = fit(c, f.where, f.text, { ...ROLES.body, weight: f.strong ? 700 : 400 }, cw, 2)
        if (ft) yy += s.text(ft, x, yy, cw, f.strong ? s.g.text : s.g.dim, { role: f.where }) + 4
      }
    })
  }
  footer(c, s, n, { name: false })
  return s
}

// ── the deck ───────────────────────────────────────────────────────────────────────────────────────────────────
/** What a slide is called: its title, headline, statement or line, without the stars. */
export function slideLabel(d: DeckSlide): string {
  const t = 'title' in d && d.title ? d.title : 'headline' in d ? d.headline : 'statement' in d ? d.statement : 'line' in d ? d.line : d.kind
  return String(t).replace(/\*/g, '').replace(/\s+/g, ' ').trim()
}

export function layoutDeck(doc: DeckDoc): DeckOut {
  const look = lookFor(doc.theme, doc.brand)
  const c: Ctx = { doc, look, problems: [], typeOnly: [], i: 0 }
  // numbers on the light ground when it would make three dark slides in a row (paper and brand only)
  const darkAt = (i: number): boolean => {
    const d = doc.slides[i]
    if (!d) return false
    if (look.theme === 'ink') return true
    return d.kind === 'cover' || d.kind === 'numbers' || d.kind === 'contact' || d.kind === 'scene'
  }
  const slides: SlideOut[] = []
  const at: number[] = []
  doc.slides.forEach((d, i) => {
    c.i = i
    const n = i + 1
    let out: { s: Slide; variant: string } | null = null
    switch (d.kind) {
      case 'cover': out = cover(c, d); break
      case 'about': out = { s: about(c, d, n), variant: 'A' }; break
      case 'needs': out = { s: needs(c, d, n), variant: 'A' }; break
      case 'offer': out = offer(c, d, n); break
      case 'numbers': {
        const light = look.theme !== 'ink' && darkAt(i - 1) && darkAt(i + 1)
        out = { s: numbers(c, d, n, light), variant: light ? 'B' : 'A' }
        break
      }
      case 'products': out = products(c, d, n); break
      case 'process': out = { s: process(c, d, n), variant: 'A' }; break
      case 'proof': out = proof(c, d, n); break
      case 'history': out = history(c, d, n); break
      case 'scene': out = scene(c, d, n); if (!out) { c.problems.push(`slides[${i}] (scene): the picture must be a landscape picture at least 1,600 px wide from the brand images folder; choose another or leave the scene out`) } break
      case 'contact': out = { s: contact(c, d, n), variant: 'A' }; break
    }
    if (!out) return
    slides.push({ kind: d.kind, variant: out.variant, ground: out.s.g.bg, dark: out.s.g.dark, label: slideLabel(d), items: out.s.items, notes: doc.notes[i] ?? [] })
    at.push(i)
  })
  // text over 40 % of the slide is too much for one message
  slides.forEach((sl, i) => {
    const area = sl.items.reduce((a, it) => a + (it.t === 'text' ? it.lines.reduce((b, l) => b + l.reduce((w, r) => w + width(r.text, r.size ?? it.size, (r.weight ?? it.weight) as Weight, it.tracking), 0) * it.lh, 0) : 0), 0)
    if (area > SLIDE_W * SLIDE_H * 0.4) c.problems.push(`slides[${at[i]}] (${sl.kind}): too much text for one slide; say less`)
  })
  return { look, slides, problems: [...new Set(c.problems)], typeOnly: [...new Set(c.typeOnly)] }
}
