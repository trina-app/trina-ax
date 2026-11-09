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
import { drawFigure, hub, layers, type Box, type ChartInk, type FigEnv } from './figures'
import { PIC_RULES, type DeckLogo, type DeckOut, type Focus, type Item, type PicInfo, type SlideOut } from './layout'
import { lookFor2, type G2, type Look2 } from './look'
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
}

const LABEL_DECK: Record<Locale, string> = { ko: '회사 소개서', en: 'Company profile', id: 'Profil perusahaan', ja: '会社紹介資料', es: 'Presentación corporativa' }
const LABEL_CONTACT: Record<Locale, Record<'person' | 'phone' | 'email' | 'website' | 'address', string>> = {
  ko: { person: '담당', phone: '전화', email: '이메일', website: '웹사이트', address: '주소' },
  en: { person: 'Contact', phone: 'Phone', email: 'Email', website: 'Website', address: 'Address' },
  id: { person: 'Kontak', phone: 'Telepon', email: 'Email', website: 'Situs web', address: 'Alamat' },
  ja: { person: '担当', phone: '電話', email: 'メール', website: 'ウェブサイト', address: '住所' },
  es: { person: 'Contacto', phone: 'Teléfono', email: 'Correo', website: 'Sitio web', address: 'Dirección' },
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
/** The feature ground's light: the mesh (brand) or one or two glows (ink, warm black). */
function featureLight(cv: Canvas, c: Ctx, at: { x: number; y: number }, flip = false) {
  if (c.look.featureKind === 'mesh' && c.look.mesh) return mesh(cv, c.look, flip)
  if (c.look.glow) {
    cv.glow(at.x, at.y, 900, c.look.glow, c.look.theme === 'ink' ? 0.5 : 0.2)
    if (c.look.theme === 'ink') cv.glow(flip ? 1600 : 300, 1100, 700, c.look.glow, 0.18)
  }
}
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
function footer(cv: Canvas, c: Ctx, o: { name?: boolean; left?: boolean } = {}) {
  const g = cv.g
  const page = String(c.i + 1).padStart(2, '0'), total = String(c.n).padStart(2, '0')
  const runs = [{ text: page, color: g.dim }, { text: ` / ${total}`, color: g.mute }]
  cv.runs(o.left ? ML : W - MR - 240, FOOTER_Y, 240, 22, 700, 0.02, runs, { role: 'footer', align: o.left ? 'l' : 'r', lh: 1.3 })
  if (o.name === false) return
  const sec = c.doc.sections[c.i] ?? ''
  const name = fit(fc(c), 'company', c.doc.company, R2.footer, 700, 1, { quiet: true })
  const nm = name ? name.lines[0]!.map((r) => r.text).join('') : c.doc.company.slice(0, 30)
  const room = 1200 - width(nm, 22, 700, 0.02)
  const sf = sec ? fit(fc(c), 'section', sec, R2.footer, Math.max(100, room - 60), 1, { quiet: true }) : null
  const secText = sf ? sf.lines[0]!.map((r) => r.text).join('') : ''
  cv.runs(ML, FOOTER_Y, 1300, 22, 700, 0.02, [{ text: nm, color: g.dim }, ...(secText ? [{ text: `  ·  ${secText}`, color: g.mute }] : [])], { role: 'footer', lh: 1.3 })
}
/** The title (and an optional lead under it); returns where the figure band may start. */
function header(cv: Canvas, c: Ctx, title: string | undefined, lead: string | undefined, w = 1400): number {
  const t = fit(fc(c), 'title', title?.replace(/\*/g, ''), R2.title, w, 2)
  let y = TITLE_Y + cv.text(t, ML, TITLE_Y, w, cv.g.text, { role: 'title' })
  const l = fit(fc(c), 'sub', lead, R2.lead, Math.min(w, 1400), 2)
  if (l) y += 20 + cv.text(l, ML, y + 20, Math.min(w, 1400), cv.g.dim, { role: 'sub' })
  return Math.max(BAND_TOP, y + 56)
}
/** The soft light of a content slide: a corner glow (brand), a glow behind the figure (ink), nothing on paper. */
function contentLight(cv: Canvas, c: Ctx, behind?: { x: number; y: number; r?: number }) {
  if (!c.look.glow) return
  if (c.look.theme === 'brand') cv.glow(behind ? behind.x : 1760, behind ? behind.y : 60, behind?.r ?? 820, c.look.glow, 0.09)
  else if (c.look.theme === 'ink') cv.glow(behind?.x ?? 1700, behind?.y ?? 80, behind?.r ?? 700, c.look.glow, behind ? 0.4 : 0.26)
}
const band = (top: number): Box => ({ x: ML, y: top, w: CW, h: BAND_BOTTOM - top })

/** The cover's or closing's type block: a hairline, "회사 소개서" and the website at the bottom. */
function coverFoot(cv: Canvas, c: Ctx, x2: number, lineColor: string) {
  cv.line(ML, 936, x2, 936, lineColor, 2)
  const lab = fit(fc(c), 'label', LABEL_DECK[c.doc.lang], R2.footer, 500, 1, { quiet: true })
  cv.text(lab, ML, 962, 500, cv.g.dim, { role: 'footer' })
  if (c.doc.website) {
    const wf = fit(fc(c), 'website', siteText(c.doc.website), R2.footer, 600, 1, { quiet: true })
    cv.text(wf, x2 - 600, 962, 600, cv.g.dim, { role: 'website', align: 'r' })
  }
}
/** Headline (display) and sub (lead) from `top`; returns [bottom, widest line]. */
function coverType(cv: Canvas, c: Ctx, d: { headline: string; sub?: string }, x: number, top: number, w: number, role: Role = R2.display): [number, number] {
  const hd = fit(fc(c), 'headline', d.headline, role, w, 2)
  const sb = fit(fc(c), 'sub', d.sub, R2.lead, Math.min(w, 900), 2)
  let y = top + cv.text(hd, x, top, w, cv.g.text, { accent: cv.g.accent, role: 'headline' })
  if (sb) y += 26 + cv.text(sb, x, y + 26, Math.min(w, 900), cv.g.dim, { role: 'sub' })
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
    const scrimBg = L.feature.dark ? L.feature.bg : '#0b0b0d'
    const cv = new Canvas({ ...L.photo, bg: scrimBg })
    base(cv)
    cv.image(d.picture!, p!, 0, 0, W, H, d.focus, 0)
    if (note?.tone === 'light' || note?.tone === 'mixed') cv.rect(0, 0, W, H, { solid: alphaHex(L.brand ? mixDark(L.brand) : scrimBg, 0.45) })
    const s = strong ? [0.98, 0.94, 0.55, 0] : [0.96, 0.86, 0.35, 0]
    cv.rect(0, 0, W, H, { linear: { angle: right ? 270 : 90, stops: [{ at: 0, color: alphaHex(scrimBg, s[0]!) }, { at: 0.3, color: alphaHex(scrimBg, s[1]!) }, { at: 0.52, color: alphaHex(scrimBg, s[2]!) }, { at: strong ? 0.8 : 0.7, color: alphaHex(scrimBg, 0) }] } })
    cv.rect(0, 0, W, H, { linear: { angle: 0, stops: [{ at: 0, color: alphaHex(scrimBg, 0.7) }, { at: 0.22, color: alphaHex(scrimBg, 0) }] } })
    cv.rect(0, 0, W, 260, { linear: { angle: 180, stops: [{ at: 0, color: alphaHex(scrimBg, 0.45) }, { at: 1, color: alphaHex(scrimBg, 0) }] } })
    logo(cv, c)
    coverType(cv, c, d, right ? W - ML - 1000 : ML, 352, right ? 1000 : 1100)
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
  featureLight(cv, c, { x: 1560, y: 520 })
  // the pattern fades to zero 48 px before the headline's longest line
  const hdC = fit({ problems: [], where: '' }, 'h', d.headline, R2.display, 1000, 2, { quiet: true })
  pattern(cv, c, { x: 960, y: 0, w: W - 960, h: H }, { radial: { cx: 1460, cy: 520, r: Math.max(240, Math.min(640, 1460 - (ML + widest(hdC)) - 48)), inner: 1, outer: 0 } })
  const acc = c.doc.accents[c.i]
  if (acc) cv.svg(acc, ...Object.values(ACCENT_BOX(1440, 540, 760)) as [number, number, number, number])
  logo(cv, c)
  coverType(cv, c, d, ML, 404, 1000)
  coverFoot(cv, c, W - MR, cv.g.line)
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
  // the statement alone, set large, with the facts under it
  contentLight(cv, c)
  const st = fit(fc(c), 'statement', d.statement, { size: 80, min: 68, weight: 700, tracking: -0.032, lh: 1.26 }, span(10), 4)
  cv.text(st, ML, 168, span(10), cv.g.text, { accent: cv.g.accent, role: 'statement' })
  if (facts.length) {
    const k = facts.length, cw = (CW - (k - 1) * 40) / k, y0 = 760
    facts.forEach((ft, j) => {
      const x = ML + j * (cw + 40)
      cv.line(x, y0, x + cw, y0, cv.g.line, 2)
      cv.text(fit(fc(c), `facts[${j}].label`, ft.label, R2.label, cw, 1), x, y0 + 30, cw, cv.g.mute, { role: 'label' })
      cv.text(fit(fc(c), `facts[${j}].value`, ft.value, R2.head, cw, 2), x, y0 + 30 + 29 + 12, cw, cv.g.text, { role: 'value' })
    })
  }
  footer(cv, c)
  return { cv, variant: 'statement' }
}

/** A content slide: the title (and a lead), one figure in the band. */
function content(c: Ctx, title: string | undefined, lead: string | undefined, f: DeckFigure | undefined, o: { ground?: 'feature' } = {}): { cv: Canvas; variant: string } {
  const feature = o.ground === 'feature'
  const g: G2 = feature ? c.look.feature : c.look.content
  const cv = new Canvas(g)
  base(cv)
  if (!f) { header(cv, c, title, lead); footer(cv, c); return { cv, variant: 'none' } }
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
    drawFigure(e, f, band(top), ink)
  }
  footer(cv, c)
  return { cv, variant: f.kind }
}

function proof(c: Ctx, d: K<'proof'>): { cv: Canvas; variant: string } {
  const given = [d.quote, d.names?.length, d.figure].filter(Boolean).length
  if (given !== 1) c.problems.push(`slides[${c.i}] (proof): give exactly one of quote, names or a compare figure`)
  if (d.figure) return content(c, d.title, undefined, d.figure)
  const cv = new Canvas(c.look.content)
  base(cv)
  if (d.quote) {
    if (c.look.glow) cv.glow(200, 1000, 900, c.look.glow, c.look.theme === 'ink' ? 0.3 : 0.1)
    // a drawn quote mark in the mark colour
    const qx = ML, qy = 170, m = cv.g.mark
    cv.path('M0 70C0 30 30 0 70 0L70 22C46 25 30 44 28 70L70 70L70 140L0 140Z'.replace(/(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g, (_, a, b) => `${+a + qx} ${+b + qy}`), { fill: m })
    cv.path('M100 70C100 30 130 0 170 0L170 22C146 25 130 44 128 70L170 70L170 140L100 140Z'.replace(/(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g, (_, a, b) => `${+a + qx} ${+b + qy}`), { fill: m })
    const q = fit(fc(c), 'quote.text', d.quote.text, R2.quote, 1500, 4)
    const qy2 = 380
    const qb = qy2 + cv.text(q, ML, qy2, 1500, cv.g.text, { role: 'quote' })
    cv.line(ML, qb + 44, ML + 80, qb + 44, cv.g.mark, 4)
    const who = fit(fc(c), 'quote.who', d.quote.who, R2.headS, 1200, 1)
    cv.text(who, ML, qb + 76, 1200, cv.g.text, { role: 'who' })
    footer(cv, c)
    return { cv, variant: 'quote' }
  }
  contentLight(cv, c)
  const top = header(cv, c, d.title, undefined)
  const names = d.names ?? []
  const k = names.length, cols = k <= 4 ? k : k <= 6 ? 3 : 4, rws = Math.ceil(k / cols), cw = CW / cols
  const rh = Math.min(rws <= 2 ? 190 : 150, Math.floor((BAND_BOTTOM - top) / rws))
  const y0 = Math.round(top + (BAND_BOTTOM - top - rh * rws) / 2)
  for (let r = 0; r <= rws; r++) cv.line(ML, y0 + r * rh, ML + CW, y0 + r * rh, cv.g.line, 2)
  for (let col = 1; col < cols; col++) cv.line(ML + col * cw, y0 + 28, ML + col * cw, y0 + rws * rh - 28, cv.g.line, 2)
  names.forEach((nm, j) => {
    const r = Math.floor(j / cols), col = j % cols
    const f = fit(fc(c), `names[${j}]`, nm, { ...R2.headL, size: k > 8 ? 36 : 40, min: 32 }, cw - 64, 2)
    cv.text(f, ML + col * cw + 32, y0 + r * rh + (rh - linesH(f)) / 2, cw - 64, cv.g.dim, { role: 'name', align: 'c' })
  })
  footer(cv, c)
  return { cv, variant: 'names' }
}

function contact(c: Ctx, d: K<'contact'>): { cv: Canvas; variant: string } {
  const cv = new Canvas(c.look.feature)
  base(cv)
  featureLight(cv, c, { x: 1560, y: 600 }, true)
  const acc = c.doc.accents[c.i]
  const lnC = fit({ problems: [], where: '' }, 'l', d.line, R2.section, 1000, 2, { quiet: true })
  pattern(cv, c, { x: 980, y: 0, w: W - 980, h: H }, { radial: { cx: 1500, cy: 560, r: Math.max(240, Math.min(700, 1500 - (ML + widest(lnC)) - 48)), inner: 1, outer: 0 } }, acc ? 0.8 : 1)
  if (acc) cv.svg(acc, ...Object.values(ACCENT_BOX(1520, 560, 800)) as [number, number, number, number])
  logo(cv, c)
  const ln = fit(fc(c), 'line', d.line, R2.section, 1000, 2)
  let y = 330 + cv.text(ln, ML, 330, 1000, cv.g.text, { accent: cv.g.accent, role: 'line' })
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
  footer(cv, c, { name: false })
  return { cv, variant: acc ? 'accent' : 'drawn' }
}

// ── the deck ────────────────────────────────────────────────────────────────────────────────────────────────────────
export function slideLabel2(d: DeckSlide2): string {
  const t = 'title' in d && d.title ? d.title : 'headline' in d ? d.headline : 'statement' in d ? d.statement : 'line' in d ? d.line : d.kind
  return String(t).replace(/\*/g, '').replace(/\s+/g, ' ').trim()
}

/** Is a slide on a dark ground? (paper and brand: never three dark slides in a row) */
function numbersGround(c: Ctx): 'feature' | undefined {
  if (c.look.theme === 'ink') return undefined
  if (c.look.theme !== 'brand') return undefined
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
    case 'needs': out = content(c, d.title, undefined, d.figure); break
    case 'offer': out = content(c, d.title, d.sub, d.figure); break
    case 'numbers': out = content(c, d.title, d.note, d.figure, { ground: numbersGround(c) }); break
    case 'products': out = content(c, d.title, undefined, d.figure); break
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
