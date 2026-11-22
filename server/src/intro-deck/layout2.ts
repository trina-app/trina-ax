// The intro deck's compositions, round 2 (docs/DECISIONS.md "D2", round 2; the design system's §1, §2, §8, §9): the
// checked slots of each slide and the look become a display list (layout.ts types), drawn with the kit in draw.ts and
// the figures in figures.ts. The outputs (html.ts, typst.ts, pptx.ts) only place what this says.
//   cover    A picture (full bleed, a scrim only where the type sits, on the picture's calm side) · B split (the
//            feature ground with the deck's pattern fading toward the type, the picture as a panel) · C drawn (mesh or
//            glow, the pattern away from the type, the AI accent on the right).
//   opening  the picture on two thirds with the line on the content ground, or full bleed on a dark deck, or drawn.
//   content  the title at 150, an optional lead, exactly one figure in the band 330–930, the running footer
//            ("company · section" left, "03 / 09" right); one soft glow at most (brand: a corner; ink: behind the figure).
//   closing  the cover's ground mirrored, the logo, one line, an action pill only when the material has one, a ledger
//            of contacts.
// A picture whose note says it carries lettering is never under type (it becomes a panel or a card, or is not used).
import type { DeckFigure, DeckPattern, DeckPictureNote, DeckSlide2, DeckTheme, Locale } from '@mycel/shared/api'
import { BAND_BOTTOM, BAND_TOP, Canvas, CW, fit, FOOTER_Y, H, linesH, ML, MR, R2, roundRectD, span, TITLE_Y, W, widest, alphaHex, type Fit, type FitCtx } from './draw'
import { drawFigure, hub, layers, type Box, type ChartInk, type FigEnv, type GridStyle } from './figures'
import { PIC_RULES, type DeckLogo, type DeckOut, type Focus, type Item, type PicInfo, type SlideOut } from './layout'
import { lookFor2, type G2, type Look2 } from './look'
import { mix } from '../promo-video/colors'
import { width, type Role } from './text'

/** A checked round-2 deck: the outline's choices and the slides as the AI filled them (trimmed, pictures by team
 * path), the accents sanitized and coloured, and the review's mechanical fixes. */
export interface DeckDoc2 {
  v: 2
  theme: DeckTheme
  lang: Locale
  title: string
  company: string
  website: string | null
  brand: string | null
  /** the accent sampled from the brand pictures (paper, a brand colour without hue) */
  sampled: string | null
  logo: DeckLogo | null
  pattern: DeckPattern
  seed: number
  slides: DeckSlide2[]
  /** the section name of each slide (the outline's) */
  sections: string[]
  pics: Record<string, PicInfo>
  picNotes: Record<string, Pick<DeckPictureNote, 'lettering' | 'calm' | 'tone'>>
  /** sanitized accents by slide index (cover, opening, closing) */
  accents: Record<number, string>
  /** mechanical fixes by slide index: a stronger scrim, or the drawn ground instead of the picture */
  treat: Record<number, { scrim?: 'strong'; noPicture?: boolean }>
  notes: string[][]
  /** every picture the outline planned for a slide (spare pictures are the noted ones outside this list) */
  planned?: string[]
}

const LABEL_DECK: Record<Locale, string> = { ko: '회사 소개서', en: 'Company profile', id: 'Profil perusahaan', ja: '会社紹介資料', es: 'Presentación corporativa', zh: '公司介绍' }
const LABEL_CONTACT: Record<Locale, Record<'person' | 'phone' | 'email' | 'website' | 'address', string>> = {
  ko: { person: '담당', phone: '전화', email: '이메일', website: '웹사이트', address: '주소' },
  en: { person: 'Contact', phone: 'Phone', email: 'Email', website: 'Website', address: 'Address' },
  id: { person: 'Kontak', phone: 'Telepon', email: 'Email', website: 'Situs web', address: 'Alamat' },
  ja: { person: '担当', phone: '電話', email: 'メール', website: 'ウェブサイト', address: '住所' },
  es: { person: 'Contacto', phone: 'Teléfono', email: 'Correo', website: 'Sitio web', address: 'Dirección' },
  zh: { person: '联系人', phone: '电话', email: '邮箱', website: '网站', address: '地址' },
}
export const siteText = (u: string) => u.trim().replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, '')

interface Ctx { doc: DeckDoc2; look: Look2; i: number; n: number; problems: string[]; typeOnly: number[] }
type K<T extends DeckSlide2['kind']> = Extract<DeckSlide2, { kind: T }>
const fc = (c: Ctx): FitCtx => ({ problems: c.problems, where: `slides[${c.i}] (${c.doc.slides[c.i]!.kind})` })
const picOf = (c: Ctx, src: string | undefined) => (src && !c.doc.treat[c.i]?.noPicture && c.doc.pics[src]) || null
const noteOf = (c: Ctx, src: string | undefined) => (src ? c.doc.picNotes[src] : undefined)
const env = (c: Ctx, cv: Canvas): FigEnv => ({ cv, c: fc(c), pics: c.doc.pics, radius: c.look.radius, lang: c.doc.lang })

// ── shared pieces ───────────────────────────────────────────────────────────────────────────────────────────────────
function base(cv: Canvas) { cv.rect(0, 0, W, H, { solid: cv.g.bg }) }

/** The brand mesh (three blobs; `flip` mirrors it for the closing and the numbers). */
function mesh(cv: Canvas, look: Look2, flip: boolean) {
  const [a, b, c] = look.mesh!
  const blobs = flip
    ? [{ x: 300, y: 900, r: 1100, color: a, a: 0.75 }, { x: 1700, y: 120, r: 1000, color: b, a: 0.8 }, { x: 900, y: 1000, r: 760, color: c, a: 0.55 }]
    : [{ x: 1620, y: 160, r: 1100, color: a, a: 0.75 }, { x: 260, y: 980, r: 1000, color: b, a: 0.8 }, { x: 1500, y: 900, r: 760, color: c, a: 0.55 }]
  for (const bl of blobs) cv.glow(bl.x, bl.y, bl.r, bl.color, bl.a)
}
/** The feature ground's light. Since the 2026-11-22 design pass every ground is flat: one solid colour, no mesh and
 * no glows (the owner: "too tacky"); the arguments stay so the compositions read as before. */
function featureLight(_cv: Canvas, _c: Ctx, _at: { x: number; y: number }, _flip = false) {}
/** The brand mesh, kept for a deck that asks for it again (unused: flat grounds). */
export const meshFor = mesh
/** The deck's drawn pattern over a box, fading to zero toward the type. */
function pattern(cv: Canvas, c: Ctx, box: { x: number; y: number; w: number; h: number }, fade: Parameters<Canvas['pattern']>[0]['fade'], strength = 1) {
  const p = c.doc.pattern
  if (p === 'none') return
  const dark = cv.g.dark
  const color = p === 'contours' ? cv.g.mark : cv.g.text
  if (p === 'dots') cv.pattern({ kind: 'dots', ...box, color, opacity: (dark ? 0.16 : 0.11) * strength, step: 30, size: 2, fade })
  else if (p === 'lines') cv.pattern({ kind: 'lines', ...box, color, opacity: (dark ? 0.12 : 0.09) * strength, step: 23, size: 1.5, angle: 0, fade })
  else cv.pattern({ kind: 'contours', ...box, color, opacity: (dark ? 0.2 : 0.16) * strength, step: 0, size: 1.5, seed: c.doc.seed, levels: 14, scale: 0.0019, fade })
}
/** The logo top-left (or the company name), as round 1 treats it on this ground. */
function logo(cv: Canvas, c: Ctx, x = ML, y = 88) {
  const L = c.doc.logo, pic = L ? c.doc.pics[L.src] : null
  if (L && pic) {
    const word = pic.width / pic.height > 2.2
    const mw = word ? 360 : 140, mh = word ? 40 : 84
    const treat = cv.g.dark ? L.dark : L.light
    const pad = treat === 'chip' ? Math.round(mh * 0.24) : 0
    const k = Math.min((mw - pad * 2) / pic.width, (mh - pad * 2) / pic.height)
    const w = Math.round(pic.width * k), h = Math.round(pic.height * k)
    if (treat === 'chip') cv.rect(x, y, w + pad * 2, h + pad * 2, { solid: cv.g.dark ? '#ffffff' : '#141414' }, Math.min(14, pad))
    cv.items.push({ t: 'image', x: x + pad, y: y + pad, w, h, src: L.src, natural: pic, crop: { x: 0, y: 0, w: pic.width, h: pic.height }, radius: treat === 'tile' ? Math.min(16, Math.round(h * 0.2)) : 0, logo: true, ...(treat === 'mono' ? { recolor: cv.g.text } : {}) })
    return
  }
  const f = fit(fc(c), 'company', c.doc.company, { ...R2.head, weight: 800, size: 36, min: 30 }, span(6), 2)
  cv.text(f, x, y, span(6), cv.g.text, { role: 'company' })
}
/** "company · section" left, "03 / 09" right (content slides); the page alone elsewhere. */
function footer(cv: Canvas, c: Ctx, o: { name?: boolean; left?: boolean; x?: number; width?: number; pageX?: number } = {}) {
  const g = cv.g
  const page = String(c.i + 1).padStart(2, '0'), total = String(c.n).padStart(2, '0')
  const runs = [{ text: page, color: g.dim }, { text: ` / ${total}`, color: g.mute }]
  cv.runs(o.pageX ?? (o.left ? ML : W - MR - 240), FOOTER_Y, 240, 22, 700, 0.02, runs, { role: 'footer', align: o.left ? 'l' : 'r', lh: 1.3 })
  if (o.name === false) return
  const sec = c.doc.sections[c.i] ?? ''
  const name = fit(fc(c), 'company', c.doc.company, R2.footer, 700, 1, { quiet: true })
  const nm = name ? name.lines[0]!.map((r) => r.text).join('') : c.doc.company.slice(0, 30)
  const room = (o.width ?? 1300) - width(nm, 22, 700, 0.02)
  const sf = sec ? fit(fc(c), 'section', sec, R2.footer, Math.max(100, room - 60), 1, { quiet: true }) : null
  const secText = sf ? sf.lines[0]!.map((r) => r.text).join('') : ''
  cv.runs(o.x ?? ML, FOOTER_Y, o.width ?? 1300, 22, 700, 0.02, [{ text: nm, color: g.dim }, ...(secText ? [{ text: `  ·  ${secText}`, color: g.mute }] : [])], { role: 'footer', lh: 1.3 })
}
/** The first letter of the company set as a graphic (role "graphic": never read as type by the review), bleeding off
 * the bottom right corner, its left edge at `left` or further right; a quiet tint of the ground. */
function bigGlyph(cv: Canvas, c: Ctx, left: number) {
  const ch = glyphOf(c.doc.company)
  if (!ch) return
  const g = ch.toLocaleUpperCase()
  const size = 1000
  const gw = width(g, size, 800, -0.04)
  const x = Math.max(left, W - gw * 0.82)
  cv.items.push({ t: 'text', x, y: Math.round(H - size * 0.8), w: Math.round(gw + 40), size, weight: 800, tracking: -0.04, lh: size, align: 'l', role: 'graphic',
    lines: [[{ text: g, color: cv.g.dark ? mix(cv.g.bg, cv.g.text, 0.1) : mix(cv.g.bg, cv.g.mark, 0.1) }]] })
}
/** The company's letter for the graphic: the first letter or digit of its name after a legal form written before it
 * ("(주)", "㈜", "주식회사", "(유)", "유한회사", "(株)", "株式会社", "有限会社", "Inc.", "Ltd."), or null (draw none). */
export function glyphOf(company: string): string | null {
  const LEGAL = /^(?:\(\s*주\s*\)|㈜|주식회사|\(\s*유\s*\)|유한회사|\(\s*株\s*\)|㈱|株式会社|有限会社|\(\s*有\s*\)|inc\.?|ltd\.?|llc|co\.,?\s*ltd\.?)[\s,.]*/iu
  let name = company.normalize('NFC').trim()
  for (let k = 0; k < 3; k++) { const m = LEGAL.exec(name); if (!m || !m[0]) break; name = name.slice(m[0].length) }
  return /[\p{L}\p{N}]/u.exec(name)?.[0] ?? null
}
/** The pictures the slides may take beyond the ones the AI placed: noted brand pictures no slide uses (no lettering,
 * never the logo), given in a fixed order to the numbers (behind the figures), the about and the closing (as a half). */
const spareCache = new WeakMap<DeckDoc2, Map<number, string>>()
function spares(doc: DeckDoc2): Map<number, string> {
  const hit = spareCache.get(doc)
  if (hit) return hit
  const used = new Set<string>(doc.planned ?? [])
  if (doc.logo) used.add(doc.logo.src)
  for (const sl of doc.slides) {
    if ('picture' in sl && sl.picture) used.add(sl.picture)
    const f = 'figure' in sl ? sl.figure : undefined
    if (f?.kind === 'cards') for (const it of f.items) used.add(it.picture)
    if (f?.kind === 'compare' && f.after.picture) used.add(f.after.picture)
  }
  const free = Object.keys(doc.picNotes).sort().filter((src) => !used.has(src) && !doc.picNotes[src]!.lettering && doc.pics[src] && !doc.pics[src]!.cutout)
  const out = new Map<number, string>()
  const rank = { dark: 0, mixed: 1, light: 2 } as const
  const take = (i: number, ok: (p: PicInfo) => boolean, darkFirst: boolean) => {
    const order = free.map((src, k) => ({ src, k, r: rank[doc.picNotes[src]!.tone] ?? 1 })).sort((a, b) => (darkFirst ? a.r - b.r : b.r - a.r) || a.k - b.k)
    // behind the numbers the type covers the whole picture: only one with a calm side
    const hit = order.find((o) => ok(doc.pics[o.src]!) && (!darkFirst || doc.picNotes[o.src]!.calm !== 'none'))
    if (hit) { out.set(i, hit.src); free.splice(free.indexOf(hit.src), 1) }
  }
  for (const kind of ['numbers', 'about', 'contact'] as const) {
    const i = doc.slides.findIndex((sl) => sl.kind === kind && !(sl.kind === 'about' && sl.figure) && !(sl.kind === 'numbers' && sl.figure.kind !== 'figures'))
    if (i >= 0 && !doc.treat[i]?.noPicture) take(i, kind === 'numbers' ? PIC_RULES.bleed : PIC_RULES.half, kind === 'numbers')
  }
  spareCache.set(doc, out)
  return out
}
const spareOf = (c: Ctx) => { const src = spares(c.doc).get(c.i); return src ? { src, pic: c.doc.pics[src]! } : null }
/** The title (and an optional lead under it); returns where the figure band may start. */
function header(cv: Canvas, c: Ctx, title: string | undefined, lead: string | undefined, w = 1560, x = ML, maxLines = 2): number {
  const t = fit(fc(c), 'title', title?.replace(/\*/g, ''), R2.title, w, maxLines)
  let y = TITLE_Y + cv.text(t, x, TITLE_Y, w, cv.g.text, { role: 'title' })
  const l = fit(fc(c), 'sub', lead, R2.lead, Math.min(w, 1400), 2)
  if (l) y += 24 + cv.text(l, x, y + 24, Math.min(w, 1400), cv.g.dim, { role: 'sub' })
  return Math.max(BAND_TOP, y + 64)
}
/** The light of a content slide: none (flat grounds since the 2026-11-22 design pass). */
function contentLight(_cv: Canvas, _c: Ctx, _behind?: { x: number; y: number; r?: number }) {}
const band = (top: number): Box => ({ x: ML, y: top, w: CW, h: BAND_BOTTOM - top })

/** The cover's or closing's type block: a hairline, "회사 소개서" and the website at the bottom. */
function coverFoot(cv: Canvas, c: Ctx, x2: number, lineColor: string, label = true) {
  cv.line(ML, 936, x2, 936, lineColor, 2)
  const lab = label ? fit(fc(c), 'label', LABEL_DECK[c.doc.lang], R2.footer, 500, 1, { quiet: true }) : null
  if (lab) cv.text(lab, ML, 962, 500, cv.g.dim, { role: 'footer' })
  if (c.doc.website) {
    const wf = fit(fc(c), 'website', siteText(c.doc.website), R2.footer, 600, 1, { quiet: true })
    cv.text(wf, x2 - 600, 962, 600, cv.g.dim, { role: 'website', align: 'r' })
  }
}
/** Headline (display) and sub (lead) from `top`; returns [bottom, widest line]. */
function coverType(cv: Canvas, c: Ctx, d: { headline: string; sub?: string }, x: number, top: number, w: number, role: Role = R2.display, gap = 26): [number, number] {
  const hd = fit(fc(c), 'headline', d.headline, role, w, 2)
  const sb = fit(fc(c), 'sub', d.sub, R2.lead, Math.min(w, 900), 2)
  let y = top + cv.text(hd, x, top, w, cv.g.text, { accent: cv.g.accent, role: 'headline' })
  if (sb) y += gap + cv.text(sb, x, y + gap, Math.min(w, 900), cv.g.dim, { role: 'sub' })
  return [y, Math.max(widest(hd), widest(sb))]
}
const ACCENT_BOX = (cx: number, cy: number, s: number) => ({ x: cx - s / 2, y: cy - s / 2, w: s, h: s })

// ── slides ──────────────────────────────────────────────────────────────────────────────────────────────────────────
function cover(c: Ctx, d: K<'cover'>): { cv: Canvas; variant: string } {
  const p = picOf(c, d.picture), note = noteOf(c, d.picture)
  const strong = c.doc.treat[c.i]?.scrim === 'strong'
  const bleed = !!p && !p.cutout && PIC_RULES.bleed(p) && !note?.lettering && note?.calm !== 'none'
  const variant = bleed ? 'A' : p && PIC_RULES.half(p) ? 'B' : 'C'
  if (d.picture && variant === 'C') c.typeOnly.push(c.i)
  const L = c.look
  if (variant === 'A') {
    const right = note?.calm === 'right'
    const scrimBg = '#0b0d0c'
    const cv = new Canvas({ ...L.photo, bg: scrimBg })
    base(cv)
    cv.image(d.picture!, p!, 0, 0, W, H, d.focus, 0)
    if (note?.tone === 'light' || note?.tone === 'mixed') cv.rect(0, 0, W, H, { solid: alphaHex(scrimBg, note.tone === 'light' ? 0.4 : 0.25) })
    const s = strong ? [0.98, 0.94, 0.55, 0] : [0.96, 0.86, 0.35, 0]
    // the cover-size headline reaches further across: the scrim follows it
    const big = !!fit({ problems: [], where: '' }, 'h', d.headline, R2.cover, 1400, 2, { quiet: true })
    const at = big ? [0.42, 0.68, strong ? 0.92 : 0.86] : [0.3, 0.52, strong ? 0.8 : 0.7]
    cv.rect(0, 0, W, H, { linear: { angle: right ? 270 : 90, stops: [{ at: 0, color: alphaHex(scrimBg, s[0]!) }, { at: at[0]!, color: alphaHex(scrimBg, s[1]!) }, { at: at[1]!, color: alphaHex(scrimBg, s[2]!) }, { at: at[2]!, color: alphaHex(scrimBg, 0) }] } })
    cv.rect(0, 0, W, H, { linear: { angle: 0, stops: [{ at: 0, color: alphaHex(scrimBg, 0.7) }, { at: 0.22, color: alphaHex(scrimBg, 0) }] } })
    cv.rect(0, 0, W, 260, { linear: { angle: 180, stops: [{ at: 0, color: alphaHex(scrimBg, 0.45) }, { at: 1, color: alphaHex(scrimBg, 0) }] } })
    logo(cv, c)
    const aw = big ? 1400 : right ? 1000 : 1100
    coverType(cv, c, d, right ? W - ML - aw : ML, big ? 300 : 352, aw, big ? R2.cover : R2.display, 32)
    coverFoot(cv, c, W - MR, alphaHex('#ffffff', 0.18))
    return { cv, variant }
  }
  const cv = new Canvas(L.feature)
  base(cv)
  if (variant === 'B') {
    const px = p!.cutout ? 1040 : 1100
    featureLight(cv, c, { x: 1060, y: 160 })
    const hd = fit({ problems: [], where: '' }, 'h', d.headline, R2.display, 960, 2, { quiet: true })
    const textRight = ML + Math.max(widest(hd), 600)
    pattern(cv, c, { x: 0, y: 0, w: px, h: H }, { linear: { x1: px, y1: 0, x2: Math.min(px - 60, textRight + 48), y2: 0, from: 1, to: 0 } })
    if (p!.cutout) cv.image(d.picture!, p!, px, 140, W - px - 60, H - 280, d.focus, 0)
    else cv.image(d.picture!, p!, px, 0, W - px, H, d.focus, 0)
    logo(cv, c)
    coverType(cv, c, d, ML, 404, 960)
    coverFoot(cv, c, px - 100, cv.g.line)
    return { cv, variant }
  }
  // the drawn cover (round 3): a flat ground, the headline as large as it fits from the top left, the company's first
  // letter set huge as a graphic bleeding off the bottom right (an AI accent takes its place when there is one); the
  // label "회사 소개서" and the website on the bottom left
  const acc = c.doc.accents[c.i]
  const role = acc ? R2.display : R2.cover
  const tw = acc ? 1100 : 1560
  const top = 250
  // the deck's pattern (the company's world) quietly in the top right corner, clear of the type
  if (!acc) pattern(cv, c, { x: 1160, y: 0, w: W - 1160, h: 420 }, { radial: { cx: W, cy: 0, r: 720, inner: 0.85, outer: 0 } }, 0.8)
  logo(cv, c)
  const [, wide] = coverType(cv, c, d, ML, top, tw, role, 36)
  if (acc) cv.svg(acc, ...Object.values(ACCENT_BOX(1520, 620, 620)) as [number, number, number, number])
  else bigGlyph(cv, c, Math.max(1080, ML + wide + 80))
  const lab = fit(fc(c), 'label', LABEL_DECK[c.doc.lang], R2.label, 500, 1, { quiet: true })
  cv.text(lab, ML, 930, 500, cv.g.dim, { role: 'footer' })
  if (c.doc.website) {
    const wf = fit(fc(c), 'website', siteText(c.doc.website), { ...R2.footer, size: 26, min: 22 }, 700, 1, { quiet: true })
    cv.text(wf, ML, 966, 700, cv.g.text, { role: 'website' })
  }
  return { cv, variant }
}
const mixDark = (b: string) => { const n = Number.parseInt(b.slice(1), 16); const k = 0.45; return '#' + [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.round(v * k).toString(16).padStart(2, '0')).join('') }

function opening(c: Ctx, d: K<'opening'>): { cv: Canvas; variant: string } {
  const p = picOf(c, d.picture), note = noteOf(c, d.picture)
  const L = c.look
  const strong = c.doc.treat[c.i]?.scrim === 'strong'
  if (p && !p.cutout && PIC_RULES.bleed(p) && L.content.dark && !note?.lettering && (note?.calm === 'top' || note?.calm === 'left')) {
    const bg = L.content.bg
    const cv = new Canvas({ ...L.photo, bg })
    base(cv)
    cv.image(d.picture!, p, 0, 0, W, H, d.focus, 0)
    cv.rect(0, 0, W, H, { linear: { angle: 180, stops: [{ at: 0, color: alphaHex(bg, strong ? 0.96 : 0.9) }, { at: 0.3, color: alphaHex(bg, strong ? 0.75 : 0.55) }, { at: 0.55, color: alphaHex(bg, 0) }] } })
    cv.rect(0, 0, W, H, { linear: { angle: 90, stops: [{ at: 0, color: alphaHex(bg, 0.8) }, { at: 0.4, color: alphaHex(bg, 0.3) }, { at: 0.6, color: alphaHex(bg, 0) }] } })
    coverType(cv, c, { headline: d.line, sub: d.sub }, ML, 150, 1100, R2.section)
    footer(cv, c, { name: false })
    return { cv, variant: 'A' }
  }
  if (p && PIC_RULES.half(p) && !note?.lettering) {
    const cv = new Canvas(L.content)
    base(cv)
    if (p.cutout) { cv.rect(780, 0, W - 780, H, { solid: cv.g.t05 }); cv.image(d.picture!, p, 840, 120, W - 900, H - 240, d.focus, 0) }
    else cv.image(d.picture!, p, 780, 0, W - 780, H, d.focus, 0)
    const ln = fit(fc(c), 'line', d.line, { ...R2.section, size: 80, min: 68 }, 580, 3)
    const top = Math.round((H - linesH(ln) - 120) / 2)
    const y = top + cv.text(ln, ML, top, 580, cv.g.text, { accent: cv.g.accent, role: 'line' })
    const sb = fit(fc(c), 'sub', d.sub, R2.lead, 540, 3)
    cv.text(sb, ML, y + 30, 540, cv.g.dim, { role: 'sub' })
    footer(cv, c, { name: false, left: true })
    return { cv, variant: 'B' }
  }
  if (d.picture) c.typeOnly.push(c.i)
  const cv = new Canvas(L.feature)
  base(cv)
  featureLight(cv, c, { x: 1500, y: 560 }, true)
  pattern(cv, c, { x: 900, y: 0, w: W - 900, h: H }, { radial: { cx: 1480, cy: 540, r: 620, inner: 1, outer: 0 } })
  const acc = c.doc.accents[c.i]
  if (acc) cv.svg(acc, ...Object.values(ACCENT_BOX(1460, 540, 720)) as [number, number, number, number])
  coverType(cv, c, { headline: d.line, sub: d.sub }, ML, 380, 1000, R2.section)
  footer(cv, c, { name: false })
  return { cv, variant: 'C' }
}

function about(c: Ctx, d: K<'about'>): { cv: Canvas; variant: string } {
  const cv = new Canvas(c.look.content)
  base(cv)
  const f = d.figure
  const facts = d.facts ?? []
  if (f?.kind === 'hub') {
    contentLight(cv, c, { x: 1440, y: 540, r: 640 })
    const st = fit(fc(c), 'statement', d.statement, R2.statement, 700, 4)
    // one accent per slide: the hub's centre carries it, so the statement stays in one colour
    const sb = 168 + cv.text(st, ML, 168, 700, cv.g.text, { role: 'statement' })
    if (facts.length) {
      const y0 = Math.max(sb + 64, 660)
      cv.line(ML, y0, ML + 690, y0, cv.g.line, 2)
      facts.forEach((ft, k) => {
        const x = ML + (k % 2) * 360, y = y0 + 30 + Math.floor(k / 2) * 116
        cv.text(fit(fc(c), `facts[${k}].label`, ft.label, R2.label, 330, 1), x, y, 330, cv.g.mute, { role: 'label' })
        cv.text(fit(fc(c), `facts[${k}].value`, ft.value, R2.headS, 330, 1), x, y + 29 + 12, 330, cv.g.text, { role: 'value' })
      })
    }
    hub(env(c, cv), f, { cx: 1440, cy: 540, R: 290, rc: 128, rs: 68, labelW: 240, minX: 900 })
    footer(cv, c)
    return { cv, variant: 'hub' }
  }
  if (f) {
    contentLight(cv, c)
    const top = header(cv, c, d.statement, undefined)
    drawFigure(env(c, cv), f, band(top))
    footer(cv, c)
    return { cv, variant: f.kind }
  }
  const statementRole = (size: number, min: number): Role => ({ size, min, weight: 800, tracking: -0.035, lh: 1.24 })
  const factCol = (x: number, y0: number, w: number, rowH: number) => facts.forEach((ft, j) => {
    const y = y0 + j * rowH
    cv.line(x, y, x + w, y, cv.g.lineStrong, 2)
    cv.text(fit(fc(c), `facts[${j}].label`, ft.label, { ...R2.label, size: 24, min: 22 }, w, 1), x, y + 26, w, cv.g.mute, { role: 'label' })
    cv.text(fit(fc(c), `facts[${j}].value`, ft.value, { ...R2.headL, size: 52, min: 44 }, w, 1), x, y + 26 + 31 + 10, w, cv.g.text, { role: 'value' })
  })
  const spare = spareOf(c)
  if (spare) {
    // a half: the brand picture on the right, the statement and the facts on the left
    cv.image(spare.src, spare.pic, 1060, 0, W - 1060, H, undefined, 0)
    const tw = 1060 - ML - 100
    const st = fit(fc(c), 'statement', d.statement, statementRole(64, 52), tw, 4)
    const factsH = facts.length ? Math.ceil(facts.length / 2) * 150 : 0
    const sy = facts.length ? 170 : Math.max(170, Math.round((H - linesH(st)) / 2) - 40)
    cv.text(st, ML, sy, tw, cv.g.text, { accent: cv.g.accent, role: 'statement' })
    if (facts.length) {
      const cw = (tw - 48) / 2, y0 = 930 - factsH
      facts.forEach((ft, j) => {
        const x = ML + (j % 2) * (cw + 48), y = y0 + Math.floor(j / 2) * 150
        cv.line(x, y, x + cw, y, cv.g.lineStrong, 2)
        cv.text(fit(fc(c), `facts[${j}].label`, ft.label, { ...R2.label, size: 24, min: 22 }, cw, 1), x, y + 26, cw, cv.g.mute, { role: 'label' })
        cv.text(fit(fc(c), `facts[${j}].value`, ft.value, { ...R2.headL, size: 44, min: 36 }, cw, 1), x, y + 26 + 31 + 10, cw, cv.g.text, { role: 'value' })
      })
    }
    footer(cv, c, { width: 1060 - ML - 100 - 260, pageX: 1060 - 100 - 240 })
    return { cv, variant: 'half' }
  }
  if (facts.length) {
    // two columns: the statement large on the left, the facts as a ledger on the right, both centred on the slide
    const lw = 1040, rx = ML + lw + 120, rw = W - MR - rx
    const st = fit(fc(c), 'statement', d.statement, statementRole(80, 64), lw, 4)
    const rowH = 150, factsH = facts.length * rowH
    const sy = Math.round((H - linesH(st)) / 2) - 30
    cv.text(st, ML, sy, lw, cv.g.text, { accent: cv.g.accent, role: 'statement' })
    factCol(rx, Math.round((H - factsH) / 2) - 10, rw, rowH)
    footer(cv, c)
    return { cv, variant: 'statement' }
  }
  // the statement alone is the slide: set larger, across the whole width, in the middle
  const st = fit(fc(c), 'statement', d.statement, statementRole(100, 84), CW, 4)
  cv.text(st, ML, Math.max(200, Math.round((H - linesH(st)) / 2) - 40), CW, cv.g.text, { accent: cv.g.accent, role: 'statement' })
  footer(cv, c)
  return { cv, variant: 'statement' }
}

/** A content slide: the title (and a lead), one figure in the band. */
function content(c: Ctx, title: string | undefined, lead: string | undefined, f: DeckFigure | undefined, o: { ground?: 'feature'; grid?: GridStyle } = {}): { cv: Canvas; variant: string } {
  const feature = o.ground === 'feature'
  const g: G2 = feature ? c.look.feature : c.look.content
  const cv = new Canvas(g)
  base(cv)
  if (!f) { header(cv, c, title, lead); footer(cv, c); return { cv, variant: 'none' } }
  if (o.grid === 'statements' && f.kind === 'grid' && f.items.length <= 4 && !f.items.some((it) => it.tags?.length)) return blockList(c, title, f)
  const photo = c.doc.slides[c.i]!.kind === 'numbers' ? spareOf(c) : null
  if (photo) return photoNumbers(c, title, lead, f, photo)
  if (feature) featureLight(cv, c, { x: 960, y: 760 }, true)
  else if (f.kind === 'layers') contentLight(cv, c, { x: 520, y: 680, r: 560 })
  else if (f.kind === 'hub') contentLight(cv, c, { x: 1300, y: 600, r: 600 })
  else if (f.kind === 'timeline') contentLight(cv, c, { x: 1120, y: 640, r: 560 })
  else contentLight(cv, c)
  const e = env(c, cv)
  if (f.kind === 'hub') {
    // the words on the left, the hub on the right (the café's "who it reaches")
    header(cv, c, title, undefined, 760)
    const l = fit(fc(c), 'sub', lead, R2.lead, 620, 4)
    cv.text(l, ML, 420, 620, cv.g.dim, { role: 'sub' })
    hub(e, f, { cx: 1340, cy: 590, R: 270, rc: 124, rs: 66, labelW: 300, minX: 860 })
  } else if (f.kind === 'layers') {
    const top = header(cv, c, title, lead)
    layers(e, f, { x: 220, y: top + 24, w: 580, labelX: 1010, labelW: W - MR - 1010 })
  } else if (f.kind === 'timeline') {
    const top = header(cv, c, title, lead)
    const places = f.items.every((it) => !/\d/.test(it.when))
    if (places) cv.pattern({ kind: 'contours', x: 0, y: 0, w: W, h: H, color: cv.g.mark, opacity: cv.g.dark ? 0.2 : 0.16, step: 0, size: 1.5, seed: c.doc.seed, levels: 16, scale: 0.0019, fade: { linear: { x1: 0, y1: 300, x2: 0, y2: H, from: 0, to: 1 } } })
    else {
      const key = f.key ?? f.items.length - 1
      const n = f.items.length + (f.next ? 1 : 0)
      const kx = ML + (CW / n) * key + 12
      cv.pattern({ kind: 'dots', x: 0, y: 0, w: W, h: H, color: cv.g.text, opacity: cv.g.dark ? 0.1 : 0.08, step: 30, size: 2, fade: { radial: { cx: kx, cy: 660, r: 760, inner: 0.9, outer: 0 } } })
    }
    drawFigure(e, f, band(top))
  } else {
    const top = header(cv, c, title, lead)
    const ink: ChartInk | undefined = feature && cv.g.mark === cv.g.text ? { track: alphaHex(cv.g.text, 0.18), arc: cv.g.text, num: cv.g.text, label: cv.g.text } : undefined
    drawFigure(e, f, band(top), ink, o.grid)
  }
  footer(cv, c)
  return { cv, variant: f.kind }
}

/** A slide of pains: the title on a block of the feature colour (left), the pains as rows on the content ground. */
function blockList(c: Ctx, title: string | undefined, f: Extract<DeckFigure, { kind: 'grid' }>): { cv: Canvas; variant: string } {
  const cv = new Canvas(c.look.content)
  base(cv)
  const bw = 820
  const block = c.look.feature.bg !== c.look.content.bg ? c.look.feature : { ...c.look.content, bg: c.look.content.t10 }
  cv.rect(0, 0, bw, H, { solid: block.bg })
  const t = fit(fc(c), 'title', title?.replace(/\*/g, ''), { ...R2.title, size: 64, min: 52 }, bw - ML - 80, 4)
  cv.text(t, ML, 150, bw - ML - 80, block.text, { role: 'title' })
  const page = String(c.i + 1).padStart(2, '0'), total = String(c.n).padStart(2, '0')
  cv.runs(ML, FOOTER_Y, 400, 22, 700, 0.02, [{ text: page, color: block.dim }, { text: ` / ${total}`, color: block.mute }], { role: 'footer', lh: 1.3 })
  const x = bw + 120, w = W - MR - x, n = f.items.length
  const heads = f.items.map((it, i) => fit(fc(c), `figure.items[${i}].head`, it.head, { ...R2.headL, size: 48, min: 40 }, w - 120, 1))
  const bodies = f.items.map((it, i) => fit(fc(c), `figure.items[${i}].body`, it.body, { ...R2.body, size: 30, min: 26 }, w - 120, 2))
  const rowH = Math.min(260, Math.floor((H - 240) / n))
  const y0 = Math.round((H - rowH * n) / 2)
  f.items.forEach((it, i) => {
    const y = y0 + i * rowH
    if (i > 0) cv.line(x, y, x + w, y, cv.g.line, 2)
    const inner = linesH(heads[i]!) + (bodies[i] ? 14 + linesH(bodies[i]) : 0)
    const ty = y + Math.round((rowH - inner) / 2)
    cv.icon(it.icon, x, ty + 4, 64, f.key === i ? cv.g.mark : cv.g.accent, 1.6)
    cv.text(heads[i]!, x + 120, ty, w - 120, cv.g.text, { role: 'head' })
    if (bodies[i]) cv.text(bodies[i], x + 120, ty + linesH(heads[i]!) + 14, w - 120, cv.g.dim, { role: 'body' })
  })
  return { cv, variant: 'block' }
}

/** The numbers over a brand picture: the picture full bleed under a dark veil, the title and figures in white. */
function photoNumbers(c: Ctx, title: string | undefined, lead: string | undefined, f: DeckFigure, photo: { src: string; pic: PicInfo }): { cv: Canvas; variant: string } {
  const L = c.look
  const veil = L.feature.dark ? mix(L.feature.bg, '#000000', 0.35) : '#0b0b0d'
  // over a picture the secondary type stays near white (a grey token from the flat ground would not hold there)
  const cv = new Canvas({ ...L.photo, bg: veil, dim: '#e9ecea', mute: '#d3d8d5', line: alphaHex('#ffffff', 0.28) })
  base(cv)
  cv.image(photo.src, photo.pic, 0, 0, W, H, undefined, 0)
  const strong = c.doc.treat[c.i]?.scrim === 'strong'
  cv.rect(0, 0, W, H, { solid: alphaHex(veil, strong ? 0.86 : 0.76) })
  cv.rect(0, 0, W, H, { linear: { angle: 180, stops: [{ at: 0, color: alphaHex(veil, 0.35) }, { at: 0.5, color: alphaHex(veil, 0) }, { at: 1, color: alphaHex(veil, 0.45) }] } })
  const top = header(cv, c, title, lead)
  drawFigure(env(c, cv), f, band(top), { track: alphaHex('#ffffff', 0.2), arc: '#ffffff', num: '#ffffff', label: cv.g.text })
  footer(cv, c)
  return { cv, variant: 'photo' }
}

function proof(c: Ctx, d: K<'proof'>): { cv: Canvas; variant: string } {
  const given = [d.quote, d.names?.length, d.figure].filter(Boolean).length
  if (given !== 1) c.problems.push(`slides[${c.i}] (proof): give exactly one of quote, names or a compare figure`)
  if (d.figure) return content(c, d.title, undefined, d.figure)
  const next = c.doc.slides[c.i + 1]?.kind
  const darkQuote = !!d.quote && next !== 'contact' && next !== 'cover' && c.look.feature.bg !== c.look.content.bg
  const cv = new Canvas(darkQuote ? c.look.feature : c.look.content)
  base(cv)
  if (d.quote) {
    // the words set large in the middle of the slide, a drawn quote mark in the mark colour hanging over them
    if (!darkQuote && c.look.feature.bg !== c.look.content.bg) {
      // a block of the feature colour on the left carries the quote mark, the words on the right
      const bw = 560, F = c.look.feature, qx0 = bw + 120, qw = W - MR - qx0
      cv.rect(0, 0, bw, H, { solid: F.bg })
      const k2 = 2.4, mx = Math.round((bw - 122 * k2) / 2), my = Math.round(H / 2 - 50 * k2)
      const at2 = (d: string) => d.replace(/(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g, (_, a, b) => `${Math.round(+a * k2 + mx)} ${Math.round(+b * k2 + my)}`)
      cv.path(at2('M0 50C0 21 21 0 50 0L50 16C33 18 21 31 20 50L50 50L50 100L0 100Z'), { fill: F.text })
      cv.path(at2('M72 50C72 21 93 0 122 0L122 16C105 18 93 31 92 50L122 50L122 100L72 100Z'), { fill: F.text })
      const q = fit(fc(c), 'quote.text', d.quote.text, { ...R2.quote, size: 72, min: 54 }, qw, 5)
      const who = fit(fc(c), 'quote.who', d.quote.who, R2.headS, qw - 72, 1)
      const qy2 = Math.round((H - (linesH(q) + 56 + linesH(who))) / 2)
      const qb = qy2 + cv.text(q, qx0, qy2, qw, cv.g.text, { role: 'quote' })
      cv.line(qx0, qb + 56, qx0 + 48, qb + 56, cv.g.mark, 3)
      cv.text(who, qx0 + 72, qb + 56 - linesH(who) / 2, qw - 72, cv.g.dim, { role: 'who' })
      footer(cv, c, { x: qx0, width: qw - 260 })
      return { cv, variant: 'quote' }
    }
    const q = fit(fc(c), 'quote.text', d.quote.text, { ...R2.quote, size: 76 }, 1500, 4)
    const who = fit(fc(c), 'quote.who', d.quote.who, R2.headS, 1200, 1)
    const blockH = linesH(q) + 48 + linesH(who)
    const qy2 = Math.max(330, Math.round((H - blockH) / 2) + 30)
    const qx = ML, qy = qy2 - 168, m = cv.g.mark, k = 1.3
    const at = (d: string) => d.replace(/(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g, (_, a, b) => `${Math.round(+a * k + qx)} ${Math.round(+b * k + qy)}`)
    cv.path(at('M0 50C0 21 21 0 50 0L50 16C33 18 21 31 20 50L50 50L50 100L0 100Z'), { fill: m })
    cv.path(at('M72 50C72 21 93 0 122 0L122 16C105 18 93 31 92 50L122 50L122 100L72 100Z'), { fill: m })
    const qb = qy2 + cv.text(q, ML, qy2, 1500, cv.g.text, { role: 'quote' })
    cv.line(ML, qb + 48, ML + 48, qb + 48, cv.g.lineStrong, 3)
    cv.text(who, ML + 72, qb + 48 - linesH(who) / 2, 1200, cv.g.dim, { role: 'who' })
    footer(cv, c)
    return { cv, variant: 'quote' }
  }
  contentLight(cv, c)
  const top = header(cv, c, d.title, undefined)
  const names = d.names ?? []
  const k = names.length, cols = k <= 4 ? k : k <= 6 ? 3 : 4, rws = Math.ceil(k / cols), cw = CW / cols
  const rh = Math.min(rws <= 2 ? 240 : 170, Math.floor((BAND_BOTTOM - top) / rws))
  const y0 = Math.round(top + (BAND_BOTTOM - top - rh * rws) / 2)
  for (let r = 0; r <= rws; r++) cv.line(ML, y0 + r * rh, ML + CW, y0 + r * rh, cv.g.line, 2)
  for (let col = 1; col < cols; col++) cv.line(ML + col * cw, y0 + 28, ML + col * cw, y0 + rws * rh - 28, cv.g.line, 2)
  names.forEach((nm, j) => {
    const r = Math.floor(j / cols), col = j % cols
    const f = fit(fc(c), `names[${j}]`, nm, { ...R2.headL, size: k > 8 ? 44 : k > 4 ? 52 : 60, min: 36 }, cw - 64, 2)
    cv.text(f, ML + col * cw + 32, y0 + r * rh + (rh - linesH(f)) / 2, cw - 64, cv.g.text, { role: 'name', align: 'c' })
  })
  footer(cv, c)
  return { cv, variant: 'names' }
}

function contact(c: Ctx, d: K<'contact'>): { cv: Canvas; variant: string } {
  const cv = new Canvas(c.look.feature)
  base(cv)
  const spare = spareOf(c)
  if (spare) return contactHalf(c, d, cv, spare)
  const acc = c.doc.accents[c.i]
  const lnC = fit({ problems: [], where: '' }, 'l', d.line, R2.section, 1000, 2, { quiet: true })
  if (acc) cv.svg(acc, ...Object.values(ACCENT_BOX(1520, 560, 800)) as [number, number, number, number])
  else {
    pattern(cv, c, { x: 1160, y: 0, w: W - 1160, h: 420 }, { radial: { cx: W, cy: 0, r: 720, inner: 0.85, outer: 0 } }, 0.8)
    bigGlyph(cv, c, Math.max(1180, ML + widest(lnC) + 80))
  }
  logo(cv, c)
  const ln = fit(fc(c), 'line', d.line, R2.section, 1000, 2)
  // with nothing under it the line sits low, as the cover's headline does
  const bare = !d.offer && !d.person && !d.phone && !d.email && !d.address && !(d.website || c.doc.website)
  const ly = bare ? Math.max(330, 872 - linesH(ln)) : 330
  let y = ly + cv.text(ln, ML, ly, 1000, cv.g.text, { accent: cv.g.accent, role: 'line' })
  if (d.offer) {
    const of = fit(fc(c), 'offer', d.offer, { ...R2.head, weight: 800, size: 32, min: 28 }, 700, 1)
    if (of) {
      const tw = widest(of), w = Math.round(tw * 1.1 + 88)
      const pill = cv.g.dark || cv.g.mark === cv.g.text ? '#ffffff' : cv.g.mark
      cv.path(roundRectD(ML, y + 56, w, 84, 42), { fill: pill })
      cv.text(of, ML + 44, y + 56 + (84 - linesH(of)) / 2, w - 88 + 8, pill === '#ffffff' ? (c.look.brand && c.look.theme !== 'ink' ? c.look.content.accent : '#111111') : cv.g.onMark, { role: 'offer' })
      y += 56 + 84
    }
  }
  type Col = { label: string; value: string; where: string }
  const L = LABEL_CONTACT[c.doc.lang]
  const cols: Col[] = []
  if (d.person) cols.push({ label: L.person, value: d.person, where: 'person' })
  if (d.phone) cols.push({ label: L.phone, value: d.phone, where: 'phone' })
  if (d.email) cols.push({ label: L.email, value: d.email, where: 'email' })
  const site = d.website || c.doc.website
  if (site) cols.push({ label: L.website, value: siteText(site), where: 'website' })
  if (d.address) cols.push({ label: L.address, value: d.address, where: 'address' })
  if (cols.length) {
    const y0 = Math.max(y + 80, 800)
    const ledger = cols.slice(0, 4)
    const widths = ledger.map((col) => Math.min(620, Math.max(220, width(col.value, 28, 700, -0.01) * 1.1 + 40)))
    const total = widths.reduce((a, b) => a + b, 0) + (ledger.length - 1) * 48
    const scale = total > 1500 ? 1500 / total : 1
    cv.line(ML, y0, ML + Math.min(1500, Math.max(760, total)), y0, cv.g.line, 2)
    let x = ML
    ledger.forEach((col, k) => {
      const w = Math.floor(widths[k]! * scale)
      cv.text(fit(fc(c), `${col.where}.label`, col.label, R2.label, w, 1, { quiet: true }), x, y0 + 30, w, cv.g.mute, { role: 'label' })
      cv.text(fit(fc(c), col.where, col.value, { ...R2.body, weight: 700, size: 28, min: 24 }, w, 2), x, y0 + 30 + 29 + 12, w, cv.g.text, { role: col.where, weight: 700 })
      x += w + 48
    })
  }
  // no contact details: the cover's foot closes the deck (a hairline, "회사 소개서", the website)
  if (!cols.length) {
    const lab = fit(fc(c), 'label', LABEL_DECK[c.doc.lang], R2.label, 500, 1, { quiet: true })
    cv.text(lab, ML, 962, 500, cv.g.dim, { role: 'footer' })
  }
  else footer(cv, c, { name: false })
  return { cv, variant: acc ? 'accent' : 'drawn' }
}

/** The closing with a brand picture on the right: the line, the action and the contacts stacked on the left. */
function contactHalf(c: Ctx, d: K<'contact'>, cv: Canvas, spare: { src: string; pic: PicInfo }): { cv: Canvas; variant: string } {
  const px = 1100, tw = px - ML - 100
  cv.image(spare.src, spare.pic, px, 0, W - px, H, undefined, 0)
  logo(cv, c)
  const ln = fit(fc(c), 'line', d.line, { ...R2.section, size: 88, min: 72 }, tw, 3)
  let y = 300 + cv.text(ln, ML, 300, tw, cv.g.text, { accent: cv.g.accent, role: 'line' })
  if (d.offer) {
    const of = fit(fc(c), 'offer', d.offer, { ...R2.head, weight: 800, size: 32, min: 28 }, 700, 1)
    if (of) {
      const w = Math.round(widest(of) * 1.1 + 88)
      const pill = cv.g.dark || cv.g.mark === cv.g.text ? '#ffffff' : cv.g.mark
      cv.path(roundRectD(ML, y + 48, w, 84, 42), { fill: pill })
      cv.text(of, ML + 44, y + 48 + (84 - linesH(of)) / 2, w - 88 + 8, pill === '#ffffff' ? (c.look.brand && c.look.theme !== 'ink' ? c.look.content.accent : '#111111') : cv.g.onMark, { role: 'offer' })
      y += 48 + 84
    }
  }
  const L = LABEL_CONTACT[c.doc.lang]
  const rows: { label: string; value: string; where: string }[] = []
  if (d.person) rows.push({ label: L.person, value: d.person, where: 'person' })
  if (d.phone) rows.push({ label: L.phone, value: d.phone, where: 'phone' })
  if (d.email) rows.push({ label: L.email, value: d.email, where: 'email' })
  const site = d.website || c.doc.website
  if (site) rows.push({ label: L.website, value: siteText(site), where: 'website' })
  if (d.address) rows.push({ label: L.address, value: d.address, where: 'address' })
  const shown = rows.slice(0, 4)
  const y0 = Math.max(y + 72, 930 - shown.length * 58)
  shown.forEach((r, k) => {
    const ry = y0 + k * 58
    cv.text(fit(fc(c), `${r.where}.label`, r.label, R2.label, 180, 1, { quiet: true }), ML, ry + 4, 180, cv.g.mute, { role: 'label' })
    cv.text(fit(fc(c), r.where, r.value, { ...R2.body, weight: 700, size: 28, min: 24 }, tw - 200, 1), ML + 200, ry, tw - 200, cv.g.text, { role: r.where, weight: 700 })
  })
  return { cv, variant: 'half' }
}

// ── the deck ────────────────────────────────────────────────────────────────────────────────────────────────────────
export function slideLabel2(d: DeckSlide2): string {
  const t = 'title' in d && d.title ? d.title : 'headline' in d ? d.headline : 'statement' in d ? d.statement : 'line' in d ? d.line : d.kind
  return String(t).replace(/\*/g, '').replace(/\s+/g, ' ').trim()
}

/** Is a slide on a dark ground? (paper and brand: never three dark slides in a row) */
function numbersGround(c: Ctx): 'feature' | undefined {
  if (c.look.theme === 'ink' || c.look.feature.bg === c.look.content.bg) return undefined
  const prev = c.doc.slides[c.i - 1]?.kind, next = c.doc.slides[c.i + 1]?.kind
  const dark = (k: string | undefined) => k === 'cover' || k === 'contact'
  return dark(prev) && dark(next) ? undefined : 'feature'
}

/** One slide's display list (problems go to `problems`). */
export function layoutSlide2(doc: DeckDoc2, i: number, look: Look2 = lookFor2(doc.theme, doc.brand, doc.sampled), problems: string[] = [], typeOnly: number[] = []): SlideOut {
  const c: Ctx = { doc, look, i, n: doc.slides.length, problems, typeOnly }
  const d = doc.slides[i]!
  let out: { cv: Canvas; variant: string }
  switch (d.kind) {
    case 'cover': out = cover(c, d); break
    case 'about': out = about(c, d); break
    case 'opening': out = opening(c, d); break
    case 'needs': out = content(c, d.title, undefined, d.figure, { grid: 'statements' }); break
    case 'offer': out = content(c, d.title, d.sub, d.figure, { grid: 'panels' }); break
    case 'numbers': out = content(c, d.title, d.note, d.figure, { ground: numbersGround(c) }); break
    case 'products': out = content(c, d.title, undefined, d.figure, { grid: 'panels' }); break
    case 'process': out = content(c, d.title, undefined, d.figure); break
    case 'proof': out = proof(c, d); break
    case 'history': out = content(c, d.title, undefined, d.figure); break
    case 'contact': out = contact(c, d); break
  }
  const items: Item[] = out.cv.items
  // a content slide whose figure runs into the running footer is too full
  if (!['cover', 'opening', 'contact'].includes(d.kind) && items.some((it) => it.t === 'text' && it.role !== 'footer' && it.y + it.lh * it.lines.length > FOOTER_Y - 12)) {
    problems.push(`slides[${i}] (${d.kind}): the figure runs into the footer; give fewer items, shorter texts or fewer tags`)
  }
  return { kind: d.kind, variant: out.variant, ground: out.cv.g.bg.slice(0, 7), dark: out.cv.g.dark, label: slideLabel2(d), items, notes: doc.notes[i] ?? [] }
}

export function layoutDeck2(doc: DeckDoc2): DeckOut {
  const look = lookFor2(doc.theme, doc.brand, doc.sampled)
  const problems: string[] = [], typeOnly: number[] = []
  const slides = doc.slides.map((_, i) => layoutSlide2(doc, i, look, problems, typeOnly))
  return { look: look as unknown as DeckOut['look'], slides, problems: [...new Set(problems)], typeOnly: [...new Set(typeOnly)] }
}
export type { Fit, Focus }
