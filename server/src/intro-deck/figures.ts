// The figures of round 2 (docs/DECISIONS.md "D2", round 2; the design system's §5–§6): one drawing language for every
// kind, drawn from the figure's slots only (the AI never writes coordinates). The parts and their numbers:
//   connector 3 px lineStrong, round · hairline 2 px line · satellite r 62–70, 3 px ring on the ground, icon 48 ·
//   key disc r 118–132 in mark with a halo +26 px at 10 % · timeline dot r 10, key r 13 with a halo r 34 at 18 %, a
//   "next" ring r 11 on a dotted axis (2 px dots every 14 px) · chevron 136 high, notch 40, gap 10, icon 56 above ·
//   isometric slabs 2:1 · trapezoids 92 high, 16 % narrower per level · pills 72 high on 2.5 px rings, curves into a key
//   disc · compare panels (before: a 2 px ring; after: t10) with a 40 px mark arrow disc · grid cells divided by
//   hairlines, no boxes · donuts, bars at true scale from zero, a line with direct labels, a row of big figures.
// Exactly one key per figure in `mark`; nothing else on the slide uses it except the key's own icon. Labels sit outside
// the shapes except in chevrons and the key disc, and never cross a connector. Only the cycle has arrowheads.
import type { DeckFigure, Locale } from '@mycel/shared/api'
import { alphaHex, BAND_BOTTOM, BAND_TOP, Canvas, CW, commonSize, fit, linesH, ML, polyD, R2, roundRectD, textW, W, widest, type FitCtx } from './draw'
import type { PicInfo, TextRun } from './layout'
import { mix } from '../promo-video/colors'
import { PIC_RULES, type Focus } from './layout'
import type { Role } from './text'

export interface FigEnv { cv: Canvas; c: FitCtx; pics: Record<string, PicInfo>; radius: number; lang: Locale }
export interface Box { x: number; y: number; w: number; h: number }
type F<K extends DeckFigure['kind']> = Extract<DeckFigure, { kind: K }>

const NEXT: Record<Locale, string> = { ko: '다음', en: 'Next', id: 'Berikut', ja: '次へ', es: 'Después' }
const center = (o: Box) => ({ cx: o.x + o.w / 2, cy: o.y + o.h / 2 })
const ROUND = { cap: 'round' as const, join: 'round' as const }
const clampKey = (k: number | undefined, n: number, dflt: number) => (k !== undefined && k >= 0 && k < n ? k : dflt)

// ── numbers as written ───────────────────────────────────────────────────────────────────────────────────────────
export interface Num { pre: string; digits: string; unit: string; value: number }
/** "80.2%" → 80.2 and "%"; "1,200만 개" → 1200 and "만 개" (the unit as written; the value of the digits). */
export function parseNum(s: string): Num | null {
  const m = /^(\D*?)(\d[\d,]*(?:\.\d+)?)(.*)$/.exec(s.normalize('NFKC').trim())
  if (!m) return null
  const value = Number.parseFloat(m[2]!.replace(/,/g, ''))
  return Number.isFinite(value) ? { pre: m[1]!.trim(), digits: m[2]!, unit: m[3]!.trim(), value } : null
}
/** Time units to minutes (bars that compare durations written in different units: "2주" and "3분"). */
const TIME: [RegExp, number][] = [[/^(초|seconds?|secs?|s)$/i, 1 / 60], [/^(분|minutes?|mins?|min)$/i, 1], [/^(시간|hours?|hrs?|h)$/i, 60], [/^(일|days?|d)$/i, 1440], [/^(주|weeks?|wks?|w)$/i, 10080], [/^(개월|달|months?|mo)$/i, 43200], [/^(년|years?|yrs?|y)$/i, 525600]]
export function inMinutes(n: Num): number | null { for (const [re, k] of TIME) if (re.test(n.unit)) return n.value * k; return null }
/** Values of one unit for a chart (null: they do not share a unit). */
export function comparable(list: Num[]): number[] | null {
  if (list.every((n) => n.unit === list[0]!.unit && n.pre === list[0]!.pre)) return list.map((n) => n.value)
  const mins = list.map(inMinutes)
  return mins.every((v): v is number => v !== null) ? mins : null
}
/** A big number with its unit at 0.45×. */
function numRuns(n: Num, color: string, size: number): TextRun[] {
  const small = Math.max(22, Math.round(size * 0.45))
  const out: TextRun[] = []
  if (n.pre) out.push({ text: n.pre, color, size: small, weight: 700 })
  out.push({ text: n.digits, color })
  if (n.unit) out.push({ text: (/^[%°]/.test(n.unit) ? '' : ' ') + n.unit, color, size: small, weight: 700 })
  return out
}
function numWidth(n: Num, size: number): number {
  const small = size * 0.45
  return textW(n.digits, { ...R2.year, tracking: -0.045 }, size) + (n.pre ? textW(n.pre, R2.label, small) : 0) + (n.unit ? textW(n.unit, { ...R2.label, tracking: -0.01 }, small) + size * 0.06 : 0)
}

// ── flow: chevrons in order, icons above, bodies under ─────────────────────────────────────────────────────────────
function flow(e: FigEnv, f: F<'flow'>, o: Box) {
  const { cv, c } = e, g = cv.g
  const n = f.steps.length, notch = 40, gap = 10, h = 136
  const sw = (o.w - gap * (n - 1) + notch * (n - 1)) / n
  const key = clampKey(f.key, n, n - 1)
  const bodies = f.steps.map((s, i) => { const x0 = o.x + i * (sw - notch + gap), tx = x0 + (i === 0 ? 36 : notch + 24); return fit(c, `figure.steps[${i}].body`, s.body, R2.body, sw - (tx - x0) - (i === n - 1 ? 24 : notch), 3) })
  const block = 104 + h + (bodies.some(Boolean) ? 40 + Math.max(...bodies.map((b) => linesH(b))) : 0)
  const y = Math.round(o.y + Math.max(0, (o.h - block) / 2)) + 104
  f.steps.forEach((s, i) => {
    const x0 = o.x + i * (sw - notch + gap), first = i === 0, last = i === n - 1, hot = i === key
    const pts: [number, number][] = [[x0, y]]
    if (last) pts.push([x0 + sw, y], [x0 + sw, y + h])
    else pts.push([x0 + sw - notch, y], [x0 + sw, y + h / 2], [x0 + sw - notch, y + h])
    pts.push([x0, y + h])
    if (!first) pts.push([x0 + notch, y + h / 2])
    cv.path(polyD(pts), { fill: hot ? g.mark : g.t10, role: 'chevron' })
    const tx = x0 + (first ? 36 : notch + 24)
    cv.icon(s.icon, tx, y - 104, 56, hot ? g.mark : g.text, 1.5)
    const num = fit(c, 'n', String(i + 1).padStart(2, '0'), R2.num, 120, 1)
    cv.text(num, tx, y + 30, 120, hot ? alphaHex(g.onMark, 0.75) : g.mute, { role: 'numeral', tabular: true })
    const head = fit(c, `figure.steps[${i}].head`, s.head, R2.head, sw - (tx - x0) - (last ? 24 : notch + 12), 1)
    cv.text(head, tx, y + 60, sw - (tx - x0) - notch, hot ? g.onMark : g.text, { role: 'head' })
    if (bodies[i]) cv.text(bodies[i], tx, y + h + 40, sw - (tx - x0) - (last ? 24 : notch), g.dim, { role: 'body' })
  })
}

// ── cycle: steps on a ring, arrowheads mid-arc, the start as the key ───────────────────────────────────────────────
function cycle(e: FigEnv, f: F<'cycle'>, o: Box) {
  const { cv, c } = e, g = cv.g
  const n = f.steps.length, { cx, cy } = center(o)
  const R = Math.min(250, o.h / 2 - 80)
  cv.circle(cx, cy, R, { stroke: { color: g.lineStrong, width: 3 } })
  f.steps.forEach((s, i) => {
    const a = ((-90 + (360 / n) * i) * Math.PI) / 180, sx = cx + R * Math.cos(a), sy = cy + R * Math.sin(a)
    const am = ((-90 + (360 / n) * (i + 0.5)) * Math.PI) / 180, ax = cx + R * Math.cos(am), ay = cy + R * Math.sin(am)
    const t = am + Math.PI / 2 // the tangent: the arrow points along the ring, clockwise
    const p = (u: number, v: number): [number, number] => [ax + u * Math.cos(t) - v * Math.sin(t), ay + u * Math.sin(t) + v * Math.cos(t)]
    cv.path(polyD([p(-9, -12), p(5, 0), p(-9, 12)], false), { stroke: { color: g.lineStrong, width: 3, ...ROUND } })
    const hot = i === 0
    cv.circle(sx, sy, 54, { fill: hot ? g.mark : g.bg, stroke: { color: hot ? g.mark : g.lineStrong, width: 3 } })
    cv.icon(s.icon, sx - 22, sy - 22, 44, hot ? g.onMark : g.text, 1.6)
    const cos = Math.cos(a), sin = Math.sin(a), lw = 260
    const vert = Math.abs(cos) < 0.3
    const lx = vert ? sx - lw / 2 : cos > 0 ? sx + 80 : sx - 80 - lw
    const lab = fit(c, `figure.steps[${i}].head`, s.head, R2.headS, lw, 2)
    const ly = vert ? (sin < 0 ? sy - 74 - linesH(lab) : sy + 74) : sy - linesH(lab) / 2
    cv.text(lab, lx, ly, lw, g.text, { role: 'label', align: vert ? 'c' : cos > 0 ? 'l' : 'r' })
  })
  if (f.center) { const t = fit(c, 'figure.center', f.center, R2.centre, 300, 2); cv.text(t, cx - 150, cy - linesH(t) / 2, 300, g.text, { role: 'centre', align: 'c' }) }
}

// ── hub: one centre and its satellites ─────────────────────────────────────────────────────────────────────────────
export function hub(e: FigEnv, f: F<'hub'>, o: { cx: number; cy: number; R?: number; rc?: number; rs?: number; labelW?: number; minX?: number; maxX?: number }) {
  const { cv, c } = e, g = cv.g
  const n = f.items.length
  const R = o.R ?? 290, rc = o.rc ?? 128, rs = o.rs ?? 66, labelW = o.labelW ?? 260
  const minX = o.minX ?? ML, maxX = o.maxX ?? W - ML
  const below = n === 3
  // no satellite straight down (its label would reach the footer): four on the diagonals, six turned by 30°
  const start = n === 4 ? -135 : n === 6 ? -60 : -90
  const ang = f.items.map((_, i) => ((start + (360 / n) * i) * Math.PI) / 180)
  const side = (i: number) => !below && Math.abs(Math.cos(ang[i]!)) >= 0.3
  // the labels beside a satellite as wide as they need (one line), the hub moved so they stay inside the margins
  const need = f.items.map((it) => Math.min(labelW, Math.ceil(Math.max(textW(it.label, R2.headS), it.sub ? textW(it.sub, R2.bodyS) : 0) * 1.1 + 8)))
  let cx = o.cx
  f.items.forEach((_, i) => {
    if (!side(i)) return
    const cos = Math.cos(ang[i]!)
    if (cos > 0) cx = Math.min(cx, maxX - R * cos - rs - 28 - need[i]!)
    else cx = Math.max(cx, minX + R * -cos + rs + 28 + need[i]!)
  })
  const { cy } = o
  cv.circle(cx, cy, R, { stroke: { color: g.line, width: 2, dash: [3, 10], cap: 'round' } })
  cv.circle(cx, cy, rc + 26, { fill: alphaHex(g.mark, 0.1) })
  f.items.forEach((it, i) => {
    const a = ang[i]!, cos = Math.cos(a), sin = Math.sin(a)
    const sx = cx + R * cos, sy = cy + R * sin
    cv.line(cx + (rc + 26) * cos, cy + (rc + 26) * sin, sx - rs * cos, sy - rs * sin, g.lineStrong, 3, { cap: 'round' })
    cv.circle(sx, sy, rs, { fill: g.bg, stroke: { color: g.lineStrong, width: 3 } })
    cv.icon(it.icon, sx - 24, sy - 24, 48, g.text, 1.6)
    const vert = !side(i)
    const lw = vert ? labelW : Math.max(60, need[i]!)
    let lx = vert ? sx - lw / 2 : cos > 0 ? sx + rs + 28 : sx - rs - 28 - lw
    if (vert) lx = Math.max(minX, Math.min(maxX - lw, lx))
    const lab = fit(c, `figure.items[${i}].label`, it.label, R2.headS, lw, 1)
    const sub = fit(c, `figure.items[${i}].sub`, it.sub, R2.bodyS, lw, 2)
    const hh = linesH(lab) + (sub ? 4 + linesH(sub, 1.3) : 0)
    const ly = vert ? (sin < -0.3 ? sy - rs - 22 - hh : sy + rs + 20) : sy - hh / 2
    const al = vert ? 'c' as const : cos > 0 ? 'l' as const : 'r' as const
    cv.text(lab, lx, ly, lw, g.text, { role: 'label', align: al })
    if (sub) cv.text(sub, lx, ly + linesH(lab) + 4, lw, g.dim, { role: 'sub', align: al, lh: 1.3 })
  })
  cv.circle(cx, cy, rc, { fill: g.mark })
  const t = fit(c, 'figure.center', f.center, R2.centre, (rc - 18) * 2, 3)
  cv.text(t, cx - (rc - 18), cy - linesH(t) / 2, (rc - 18) * 2, g.onMark, { role: 'centre', align: 'c' })
}

// ── layers: isometric slabs, labels right with leaders ─────────────────────────────────────────────────────────────
export function layers(e: FigEnv, f: F<'layers'>, o: { x: number; y: number; w?: number; labelX: number; labelW: number; bottom?: number }) {
  const { cv, c } = e, g = cv.g
  const n = f.items.length
  const w = o.w ?? 580, depth = n >= 5 ? 140 : n === 4 ? 150 : 166, slab = n >= 5 ? 40 : 46
  const room = (o.bottom ?? BAND_BOTTOM) - o.y - depth - slab
  const gap = Math.max(30, Math.min(118, room / Math.max(1, n - 1) - slab))
  const key = clampKey(f.key, n, 0)
  const tops = f.items.map((_, i) => o.y + i * (slab + gap))
  const x = o.x, d = depth / 2
  const labels: (() => void)[] = []
  for (let i = n - 1; i >= 0; i--) {
    const it = f.items[i]!, ty = tops[i]!, hot = i === key
    const top = hot ? g.mark : mix(g.bg, g.mark, g.dark ? 0.3 : 0.16)
    const front = hot ? mix(g.mark, '#000000', 0.22) : mix(g.bg, g.mark, g.dark ? 0.2 : 0.3)
    const side = hot ? mix(g.mark, '#000000', 0.38) : mix(g.bg, g.mark, g.dark ? 0.13 : 0.42)
    const edge = hot ? undefined : { color: g.dark ? alphaHex(g.text, 0.22) : alphaHex(g.mark, 0.35), width: 1.5, join: 'round' as const }
    const grp = `slab${i}-${tops[0]}`
    const one = (oy: number, th: number) => {
      cv.path(polyD([[x, ty + d + oy], [x + w / 2, ty + depth + oy], [x + w / 2, ty + depth + oy + th], [x, ty + d + oy + th]]), { fill: front, group: grp })
      cv.path(polyD([[x + w / 2, ty + depth + oy], [x + w, ty + d + oy], [x + w, ty + d + oy + th], [x + w / 2, ty + depth + oy + th]]), { fill: side, group: grp })
      cv.path(polyD([[x, ty + d + oy], [x + w / 2, ty + oy], [x + w, ty + d + oy], [x + w / 2, ty + depth + oy]]), { fill: top, stroke: edge, group: grp })
    }
    if (it.stack) for (let k = 5; k >= 0; k--) one(k * 16, 10)
    else one(0, slab)
    const ly = ty + d + (it.stack ? 48 : slab / 2)
    labels.push(() => {
      cv.line(x + w + 24, ly, o.labelX - 28, ly, g.line, 2)
      cv.circle(x + w + 24, ly, 5, { fill: hot ? g.mark : g.lineStrong })
      const hd = fit(c, `figure.items[${i}].head`, it.head, R2.headS, o.labelW, 1)
      const bd = fit(c, `figure.items[${i}].body`, it.body, R2.bodyS, o.labelW, 2)
      cv.text(hd, o.labelX, ly - 26, o.labelW, hot ? g.accent : g.text, { role: 'label' })
      cv.text(bd, o.labelX, ly + 20, o.labelW, g.dim, { role: 'body' })
    })
  }
  labels.reverse().forEach((l) => l())
}

// ── timeline: big years over an axis, events under ─────────────────────────────────────────────────────────────────
function timeline(e: FigEnv, f: F<'timeline'>, o: Box) {
  const { cv, c } = e, g = cv.g
  const events = [...f.items.map((it) => ({ ...it, next: false })), ...(f.next ? [{ when: NEXT[e.lang], head: f.next.head, body: f.next.body, next: true }] : [])]
  const n = events.length, step = o.w / n
  const places = f.items.every((it) => !/\d/.test(it.when))
  const key = clampKey(f.key, f.items.length, places ? 0 : f.items.length - 1)
  const y = o.y + Math.round(o.h * 0.52)
  const yearSize = commonSize(events.map((ev) => ev.when), R2.year, step - 36, [104, 96, 88, 76, 64, 56])
  if (!yearSize) c.problems.push(`${c.where} figure.items: a "when" is too long to set large; give the year or the place as written, short`)
  const solidEnd = f.next ? o.x + step * f.items.length + 12 : o.x + o.w
  cv.line(o.x, y, solidEnd, y, g.lineStrong, 3)
  if (f.next) cv.line(solidEnd, y, o.x + o.w, y, g.lineStrong, 3, { dash: [2, 12], cap: 'round' })
  events.forEach((ev, i) => {
    const cx = o.x + step * i + 12, hot = !ev.next && i === key
    if (hot) cv.circle(cx, y, 34, { fill: alphaHex(g.mark, 0.18) })
    if (ev.next) cv.circle(cx, y, 11, { fill: g.bg, stroke: { color: g.lineStrong, width: 3 } })
    else cv.circle(cx, y, hot ? 13 : 10, { fill: hot ? g.mark : g.text })
    if (yearSize) {
      const yf = fit(c, `figure.items[${i}].when`, ev.when, { ...R2.year, size: yearSize, min: yearSize }, step - 24, 1, { quiet: true })
      cv.text(yf, cx - 12, y - 46 - yearSize, step - 24, ev.next ? g.mute : hot ? g.accent : g.text, { role: 'year', tabular: true })
    }
    const hd = fit(c, ev.next ? 'figure.next.head' : `figure.items[${i}].head`, ev.head, R2.headS, step - 40, 2)
    cv.text(hd, cx - 12, y + 44, step - 40, ev.next ? g.dim : g.text, { role: 'head' })
    const bd = fit(c, ev.next ? 'figure.next.body' : `figure.items[${i}].body`, ev.body, R2.bodyS, step - 40, 2)
    if (bd) cv.text(bd, cx - 12, y + 44 + linesH(hd) + 6, step - 40, g.dim, { role: 'body' })
  })
}

// ── compare: before (quiet) → after (tinted), or before → a picture of now ─────────────────────────────────────────
function compare(e: FigEnv, f: F<'compare'>, o: Box) {
  const { cv, c } = e, g = cv.g
  const pic = f.after.picture ? e.pics[f.after.picture] : null
  if (pic && PIC_RULES.half(pic)) {
    // the before in big quiet type on the left, an arrow, the picture of now on the right with its caption
    const bw = 520
    cv.line(ML, o.y + 50, ML + 500, o.y + 50, g.line, 2)
    const lb = fit(c, 'figure.before.label', f.before.label, R2.label, bw, 1)
    cv.text(lb, ML, o.y + 82, bw, g.mute, { role: 'label' })
    const hd = fit(c, 'figure.before.head', f.before.head, { size: 72, min: 60, weight: 800, tracking: -0.032, lh: 1.14 }, bw, 3)
    const hy = o.y + 82 + 29 + 22
    cv.text(hd, ML, hy, bw, g.dim, { role: 'head' })
    const body = fit(c, 'figure.before.items[0]', f.before.items?.[0], R2.body, bw, 2)
    cv.text(body, ML, hy + linesH(hd) + 22, bw, g.dim, { role: 'body' })
    const px = 880, py = o.y + 30, pw = W - ML - px, ph = Math.min(500, o.h - 110)
    const ax = 760, ay = py + ph / 2 + 10
    cv.line(ML + bw, ay, ax - 72, ay, g.line, 2)
    cv.circle(ax, ay, 56, { fill: g.mark })
    cv.path(polyD([[ax - 18, ay - 22], [ax + 6, ay], [ax - 18, ay + 22]], false), { stroke: { color: g.onMark, width: 5, ...ROUND } })
    cv.image(f.after.picture!, pic, px, py, pw, ph, f.after.focus as Focus | undefined, e.radius)
    const cap = fit(c, 'figure.after.label', `${f.after.label} · ${f.after.head}`, R2.headS, 520, 1)
    const capW = widest(cap) + 20
    cv.text(cap, px, py + ph + 24, 560, g.text, { role: 'caption' })
    const more = fit(c, 'figure.after.items[0]', f.after.items?.[0], R2.bodyS, pw - capW - 10, 1)
    cv.text(more, px + capW, py + ph + 24 + 3, pw - capW, g.dim, { role: 'caption' })
    return
  }
  const cw = (o.w - 140) / 2, ax = o.x + cw + 70
  const col = (side: typeof f.before, x: number, hot: boolean, slot: string) => {
    const lb = fit(c, `figure.${slot}.label`, side.label, R2.label, cw - 96, 1)
    const hd = fit(c, `figure.${slot}.head`, side.head, R2.head, cw - 96, 2)
    const rows = (side.items ?? []).map((t, i) => fit(c, `figure.${slot}.items[${i}]`, t, R2.bodyS, cw - 96, 2))
    return { x, hot, lb, hd, rows, h: 44 + 29 + 18 + linesH(hd) + 22 + rows.reduce((a, r) => a + linesH(r) + 26, 0) + 36 }
  }
  const a = col(f.before, o.x, false, 'before'), b = col(f.after, o.x + cw + 140, true, 'after')
  const h = Math.max(320, a.h, b.h)
  const y = Math.round(o.y + Math.max(0, (o.h - h) / 2))
  cv.rect(b.x, y, cw, h, { solid: g.t10 }, e.radius)
  cv.rect(a.x, y, cw, h, { solid: alphaHex(g.bg, 0) }, e.radius, { stroke: { color: g.line, width: 2 } })
  const ay = y + h / 2
  cv.circle(ax, ay, 40, { fill: g.mark })
  cv.path(polyD([[ax - 12, ay - 16], [ax + 6, ay], [ax - 12, ay + 16]], false), { stroke: { color: g.onMark, width: 4, ...ROUND } })
  for (const s of [a, b]) {
    let yy = y + 44
    cv.text(s.lb, s.x + 48, yy, cw - 96, s.hot ? g.accent : g.mute, { role: 'label' }); yy += 29 + 18
    yy += cv.text(s.hd, s.x + 48, yy, cw - 96, s.hot ? g.text : g.dim, { role: 'head' }) + 22
    for (const r of s.rows) { cv.line(s.x + 48, yy, s.x + cw - 48, yy, g.line, 2); yy += 12; yy += cv.text(r, s.x + 48, yy, cw - 96, g.dim, { role: 'body' }) + 14 }
  }
}

// ── funnel: narrowing stages ───────────────────────────────────────────────────────────────────────────────────────
function funnel(e: FigEnv, f: F<'funnel'>, o: Box) {
  const { cv, c } = e, g = cv.g
  const n = f.stages.length, h = 92, gap = 10, w = 720, x = o.x + 100
  const y = Math.round(o.y + (o.h - (n * h + (n - 1) * gap)) / 2)
  const labelX = x + w + 140
  f.stages.forEach((st, i) => {
    const top = w * (1 - 0.16 * i), bot = w * (1 - 0.16 * (i + 1)), yy = y + i * (h + gap), last = i === n - 1
    const fill = last ? g.mark : [g.t10, g.t20, g.t40, mix(g.t40, g.mark, 0.5)][i] ?? g.t40
    cv.path(polyD([[x + (w - top) / 2, yy], [x + (w + top) / 2, yy], [x + (w + bot) / 2, yy + h], [x + (w - bot) / 2, yy + h]]), { fill })
    cv.line(x + (w + top) / 2 + 20, yy + h / 2, labelX - 24, yy + h / 2, g.line, 2)
    const t = fit(c, `figure.stages[${i}]`, st, R2.headS, 640, 1)
    cv.text(t, labelX, yy + h / 2 - linesH(t) / 2, 640, last ? g.accent : g.text, { role: 'label' })
  })
}

// ── merge: many inputs into one place ──────────────────────────────────────────────────────────────────────────────
function merge(e: FigEnv, f: F<'merge'>, o: Box) {
  const { cv, c } = e, g = cv.g
  const n = f.inputs.length, pillW = 300, pillH = 72, gap = n >= 6 ? 16 : 26
  const totalH = n * pillH + (n - 1) * gap
  const y = Math.round(o.y + (o.h - totalH) / 2), cy = y + totalH / 2
  const x = o.x, nodeX = o.x + 890, nodeR = 92
  f.inputs.forEach((t, i) => {
    const py = y + i * (pillH + gap), sx = x + pillW, sy = py + pillH / 2, ex = nodeX - nodeR, mx = (sx + ex) / 2
    cv.path(`M${sx} ${sy}C${mx + 40} ${sy} ${mx - 40} ${cy} ${ex} ${cy}`, { stroke: { color: g.lineStrong, width: 3, cap: 'round' } })
    cv.path(roundRectD(x, py, pillW, pillH, pillH / 2), { fill: g.bg, stroke: { color: g.lineStrong, width: 2.5 } })
    const tf = fit(c, `figure.inputs[${i}]`, t, R2.pill, pillW - 48, 1)
    cv.text(tf, x + 24, py + (pillH - linesH(tf)) / 2, pillW - 48, g.text, { role: 'pill', align: 'c' })
  })
  cv.circle(nodeX, cy, nodeR + 24, { fill: alphaHex(g.mark, 0.12) })
  cv.circle(nodeX, cy, nodeR, { fill: g.mark })
  cv.icon(f.target.icon ?? 'inbox', nodeX - 32, cy - 32, 64, g.onMark, 1.6)
  cv.line(nodeX + nodeR + 24, cy, nodeX + nodeR + 96, cy, g.mark, 3)
  const lw = W - ML - (nodeX + nodeR + 120)
  const hd = fit(c, 'figure.target.head', f.target.head, R2.headL, lw, 1)
  const bd = fit(c, 'figure.target.body', f.target.body, R2.body, Math.min(lw, 460), 3)
  const th = linesH(hd) + (bd ? 12 + linesH(bd) : 0)
  cv.text(hd, nodeX + nodeR + 120, cy - th / 2, lw, g.accent, { role: 'head' })
  cv.text(bd, nodeX + nodeR + 120, cy - th / 2 + linesH(hd) + 12, Math.min(lw, 460), g.dim, { role: 'body' })
}

// ── grid: offerings with icons, hairlines, no boxes ────────────────────────────────────────────────────────────────
function grid(e: FigEnv, f: F<'grid'>, o: Box) {
  const { cv, c } = e, g = cv.g
  const n = f.items.length
  const cols = n <= 3 ? n : n === 4 ? (f.items.some((it) => it.tags?.length) ? 2 : 4) : n <= 6 ? 3 : 4
  const rows = Math.ceil(n / cols), cw = o.w / cols
  const icon = rows > 1 ? 52 : 64
  const tw = (col: number) => cw - (col === 0 ? 48 : 96)
  type Tag = { f: NonNullable<ReturnType<typeof fit>>; w: number }
  type Cell = { hd: ReturnType<typeof fit>; bd: ReturnType<typeof fit>; tags: Tag[][] }
  const cells: Cell[] = f.items.map((it, i) => {
    const col = i % cols
    const hd = fit(c, `figure.items[${i}].head`, it.head, R2.head, tw(col), 1)
    const bd = fit(c, `figure.items[${i}].body`, it.body, R2.bodyS, tw(col), rows > 1 ? 2 : 3)
    const tagRows: Tag[][] = [[]]
    let lineW = 0
    for (const t of it.tags ?? []) {
      const tf = fit(c, `figure.items[${i}].tags`, t, R2.tag, tw(col) - 40, 1)
      if (!tf) continue
      const w = Math.ceil(widest(tf) * 1.1 + 36)
      if (lineW + w > tw(col) && tagRows[tagRows.length - 1]!.length) { tagRows.push([]); lineW = 0 }
      tagRows[tagRows.length - 1]!.push({ f: tf, w }); lineW += w + 10
    }
    return { hd, bd, tags: tagRows.filter((r) => r.length) }
  })
  const cellH = (cl: Cell) => 44 + icon + 36 + linesH(cl.hd) + 14 + linesH(cl.bd) + (cl.tags.length ? 30 + cl.tags.length * 50 : 0) + 40
  const rh = Math.max(rows > 1 ? 250 : 380, ...cells.map(cellH))
  const h = rh * rows
  const y = Math.round(o.y + Math.max(0, (o.h - h) / 2))
  for (let r = 0; r <= rows; r++) cv.line(o.x, y + r * rh, o.x + o.w, y + r * rh, g.line, 2)
  f.items.forEach((it, i) => {
    const col = i % cols, r = Math.floor(i / cols), cx = o.x + col * cw, cy = y + r * rh
    if (col > 0) cv.line(cx, cy + 32, cx, cy + rh - 32, g.line, 2)
    const px = col === 0 ? cx : cx + 48
    const hot = f.key !== undefined && f.key === i
    cv.icon(it.icon, px, cy + 44, icon, hot ? g.mark : g.text, 1.5)
    const cl = cells[i]!
    let yy = cy + 44 + icon + 36
    yy += cv.text(cl.hd, px, yy, tw(col), g.text, { role: 'head' }) + 14
    yy += cv.text(cl.bd, px, yy, tw(col), g.dim, { role: 'body' })
    if (cl.tags.length) {
      yy += 30
      for (const row of cl.tags) {
        let tx = px
        for (const t of row) {
          cv.path(roundRectD(tx, yy, t.w, 38, 19), { stroke: { color: g.line, width: 2 } })
          cv.text(t.f, tx + 18, yy + 19 - linesH(t.f) / 2, t.w - 36, g.dim, { role: 'tag' })
          tx += t.w + 10
        }
        yy += 50
      }
    }
  })
}

// ── cards: product pictures ────────────────────────────────────────────────────────────────────────────────────────
function cards(e: FigEnv, f: F<'cards'>, o: Box) {
  const { cv, c } = e, g = cv.g
  const n = f.items.length, gap = 40, cw = (o.w - gap * (n - 1)) / n
  const names = f.items.map((it, i) => fit(c, `figure.items[${i}].name`, it.name, R2.head, cw, 1))
  const bodies = f.items.map((it, i) => fit(c, `figure.items[${i}].body`, it.body, R2.bodyS, cw - 20, 2))
  const textH = 36 + Math.max(...names.map((x) => linesH(x))) + 12 + Math.max(0, ...bodies.map((x) => linesH(x)))
  const ph = Math.min(n >= 4 ? 400 : 440, Math.round(cw * 0.75), o.h - textH)
  const y = Math.round(o.y + Math.max(0, (o.h - ph - textH) / 2))
  f.items.forEach((it, i) => {
    const x = o.x + i * (cw + gap)
    const p = e.pics[it.picture]
    if (p) {
      if (p.cutout) { cv.rect(x, y, cw, ph, { solid: g.t05 }, e.radius); cv.image(it.picture, p, x + 24, y + 24, cw - 48, ph - 48, it.focus, 0) }
      else cv.image(it.picture, p, x, y, cw, ph, it.focus, e.radius)
    } else cv.rect(x, y, cw, ph, { solid: g.t10 }, e.radius)
    cv.text(names[i]!, x, y + ph + 36, cw, g.text, { role: 'head' })
    cv.text(bodies[i]!, x, y + ph + 36 + linesH(names[i]!) + 12, cw - 20, g.dim, { role: 'body' })
  })
}

// ── charts ─────────────────────────────────────────────────────────────────────────────────────────────────────────
export interface ChartInk { track: string; arc: string; num: string; label: string }
function donut(e: FigEnv, f: F<'donut'>, o: Box, ink?: ChartInk) {
  const { cv, c } = e, g = cv.g
  const n = f.items.length
  const r = n === 1 ? 190 : n === 2 ? 168 : 150, sw = n === 1 ? 34 : 30
  const gapX = o.w / n
  f.items.forEach((it, i) => {
    const v = parseNum(it.value)
    if (!v || !/^%/.test(v.unit) || v.value > 100) { c.problems.push(`${c.where} figure.items[${i}].value "${it.value}": a donut shows a share written as a percent (≤ 100 %); use bars or big figures for other numbers`); return }
    const cx = o.x + gapX * (i + 0.5), cy = o.y + Math.round((o.h - 80) / 2)
    cv.circle(cx, cy, r, { stroke: { color: ink?.track ?? g.t10, width: sw } })
    const t = Math.max(0.001, Math.min(1, v.value / 100))
    if (t >= 0.9995) cv.circle(cx, cy, r, { stroke: { color: ink?.arc ?? g.mark, width: sw } })
    else {
      // the value arc from 12 o'clock clockwise, as cubic segments of at most 90°
      const a0 = -Math.PI / 2, a1 = a0 + t * Math.PI * 2
      let d = `M${(cx + r * Math.cos(a0)).toFixed(2)} ${(cy + r * Math.sin(a0)).toFixed(2)}`
      const segs = Math.ceil((a1 - a0) / (Math.PI / 2))
      for (let k = 0; k < segs; k++) {
        const s = a0 + ((a1 - a0) * k) / segs, en = a0 + ((a1 - a0) * (k + 1)) / segs, q = (4 / 3) * Math.tan((en - s) / 4) * r
        const p0 = [cx + r * Math.cos(s), cy + r * Math.sin(s)], p3 = [cx + r * Math.cos(en), cy + r * Math.sin(en)]
        const p1 = [p0[0]! - q * Math.sin(s), p0[1]! + q * Math.cos(s)], p2 = [p3[0]! + q * Math.sin(en), p3[1]! - q * Math.cos(en)]
        d += `C${p1.map((z) => z.toFixed(2)).join(' ')} ${p2.map((z) => z.toFixed(2)).join(' ')} ${p3.map((z) => z.toFixed(2)).join(' ')}`
      }
      cv.path(d, { stroke: { color: ink?.arc ?? g.mark, width: sw, cap: 'butt' } })
    }
    const size = Math.min(96, Math.floor(((r - sw) * 1.6) / Math.max(1, numWidth(v, 96) / 96)))
    cv.runs(cx - r, cy - size * 0.56, 2 * r, size, 800, -0.04, numRuns(v, ink?.num ?? g.text, size), { align: 'c', role: 'stat' })
    const lb = fit(c, `figure.items[${i}].label`, it.label, R2.headS, 2 * r + 80, 1)
    cv.text(lb, cx - r - 40, cy + r + 40, 2 * r + 80, ink?.label ?? g.text, { role: 'label', align: 'c' })
  })
}

function bars(e: FigEnv, f: F<'bars'>, o: Box, ink?: ChartInk) {
  const { cv, c } = e, g = cv.g
  const nums = f.items.map((it) => parseNum(it.value))
  if (nums.some((x) => !x)) { c.problems.push(`${c.where} figure.items: every bar needs a number as written`); return }
  const vals = comparable(nums as Num[])
  if (!vals) { c.problems.push(`${c.where} figure.items: bars compare values of one unit (or durations); use big figures for numbers of different units`); return }
  const max = Math.max(...vals)
  if (!(max > 0)) { c.problems.push(`${c.where} figure.items: a bar chart needs values above zero`); return }
  const n = f.items.length, barH = 44, gap = n <= 2 ? 120 : 72, labelW = 300
  const key = clampKey(f.key, n, vals.indexOf(max))
  const h = n * barH + (n - 1) * gap
  const y = Math.round(o.y + (o.h - h) / 2)
  const valueRoom = 340
  const bwMax = o.w - labelW - valueRoom
  f.items.forEach((it, i) => {
    const by = y + i * (barH + gap), hot = i === key
    const bw = (bwMax * vals[i]!) / max
    const tiny = bw < 6
    const lb = fit(c, `figure.items[${i}].label`, it.label, R2.headS, labelW - 32, 2)
    cv.text(lb, o.x, by + barH / 2 - linesH(lb) / 2, labelW - 32, hot ? (ink?.label ?? g.text) : (ink?.label ?? g.dim), { role: 'label' })
    cv.rect(o.x + labelW, by, bwMax, barH, { solid: ink?.track ?? alphaHex(g.t10, 0.6) })
    cv.rect(o.x + labelW, by, Math.max(6, bw), barH, { solid: hot ? (ink?.arc ?? g.mark) : (ink ? alphaHex(ink.arc, 0.55) : g.t40) })
    const v = nums[i]!
    const size = tiny ? 112 : 44
    cv.runs(o.x + labelW + Math.max(6, bw) + 24, by + barH / 2 - size * 0.55, valueRoom - 24, size, 800, -0.03, numRuns(v, hot ? (ink?.num ?? g.text) : (ink?.num ?? g.dim), size), { role: 'stat' })
  })
}

function line(e: FigEnv, f: F<'line'>, o: Box) {
  const { cv, c } = e, g = cv.g
  const nums = f.points.map((p) => parseNum(p.value))
  if (nums.some((x) => !x)) { c.problems.push(`${c.where} figure.points: every point needs a number as written`); return }
  const vals = comparable(nums as Num[])
  if (!vals) { c.problems.push(`${c.where} figure.points: a line shows values of one unit`); return }
  const n = vals.length, max = Math.max(...vals) * 1.12
  if (!(max > 0)) { c.problems.push(`${c.where} figure.points: a line chart needs values above zero`); return }
  const x = o.x + 60, w = o.w - 120, y = o.y + 70, h = o.h - 150
  const px = (i: number) => x + (w * i) / (n - 1), py = (v: number) => y + h - (h * v) / max
  cv.line(x, y + h, x + w, y + h, g.lineStrong, 2)
  for (let k = 1; k <= 3; k++) cv.line(x, y + h - (h * k) / 4, x + w, y + h - (h * k) / 4, g.line, 1.5)
  cv.path(vals.map((v, i) => `${i ? 'L' : 'M'}${px(i).toFixed(1)} ${py(v).toFixed(1)}`).join(''), { stroke: { color: g.mark, width: 5, ...ROUND } })
  vals.forEach((v, i) => {
    const last = i === n - 1
    if (last) { cv.circle(px(i), py(v), 22, { fill: alphaHex(g.mark, 0.16) }); cv.circle(px(i), py(v), 11, { fill: g.mark }) }
    else cv.circle(px(i), py(v), 8, { fill: g.bg, stroke: { color: g.mark, width: 4 } })
    const xl = fit(c, `figure.points[${i}].x`, f.points[i]!.x, R2.bodyS, 200, 1)
    cv.text(xl, px(i) - 100, y + h + 20, 200, g.dim, { role: 'axis', align: 'c' })
    const vl = fit(c, `figure.points[${i}].value`, f.points[i]!.value, last ? R2.head : { ...R2.bodyS, weight: 700 }, 260, 1)
    cv.text(vl, px(i) - 130, py(v) - (last ? 76 : 58), 260, last ? g.accent : g.dim, { role: 'value', align: 'c' })
  })
}

function figures(e: FigEnv, f: F<'figures'>, o: Box, ink?: ChartInk) {
  const { cv, c } = e, g = cv.g
  const k = f.items.length
  const nums = f.items.map((it) => parseNum(it.number))
  nums.forEach((v, i) => { if (!v) c.problems.push(`${c.where} figure.items[${i}].number "${f.items[i]!.number}" must be a number as written`) })
  // one row when every number fits it large enough; long figures ("1,286,781+") go two to a row
  const fitsRow = (cols: number, size: number) => { const gap = cols >= 4 ? 64 : 96, cw = (o.w - (cols - 1) * gap) / cols; return nums.every((v) => !v || numWidth(v, size) * 1.1 <= cw) }
  const cols = k <= 2 || fitsRow(k, k >= 4 ? 88 : 96) ? k : 2
  const rowsN = Math.ceil(k / cols), gap = cols >= 4 ? 64 : 96, cw = (o.w - (cols - 1) * gap) / cols
  const cands = rowsN > 1 ? [128, 112, 96, 88] : cols >= 4 ? [128, 112, 96, 88] : cols === 3 ? [150, 128, 112, 96] : [168, 150, 128, 112]
  let size = cands[cands.length - 1]!
  for (const sz of cands) { if (nums.every((v) => !v || numWidth(v, sz) * 1.1 <= cw)) { size = sz; break } }
  nums.forEach((v, i) => { if (v && numWidth(v, size) * 1.1 > cw) c.problems.push(`${c.where} figure.items[${i}].number "${f.items[i]!.number}" is too long to show large; give only the number and its unit as written`) })
  const labels = f.items.map((it, i) => fit(c, `figure.items[${i}].label`, it.label, R2.headS, cw, 2))
  const block = size + 36 + Math.max(...labels.map((x) => linesH(x)))
  const rowGap = 56
  const y0 = Math.round(o.y + Math.max(0, (o.h - (block * rowsN + rowGap * (rowsN - 1))) / 2))
  f.items.forEach((_, i) => {
    const col = i % cols, row = Math.floor(i / cols)
    const x = o.x + col * (cw + gap), y = y0 + row * (block + rowGap), v = nums[i]
    if (col > 0) cv.line(x - gap / 2, y + 12, x - gap / 2, y + block, ink ? alphaHex(ink.label, 0.24) : g.line, 2)
    if (v) cv.runs(x, y, cw, size, 800, -0.045, numRuns(v, ink?.num ?? g.text, size), { role: 'stat' })
    cv.text(labels[i]!, x, y + size + 36, cw, ink?.label ?? g.dim, { role: 'label' })
  })
}

/** Draw a figure into its box (the composition chose the box). */
export function drawFigure(e: FigEnv, f: DeckFigure, o: Box, ink?: ChartInk): void {
  switch (f.kind) {
    case 'flow': return flow(e, f, o)
    case 'cycle': return cycle(e, f, o)
    case 'hub': return hub(e, f, { cx: o.x + o.w / 2, cy: o.y + o.h / 2, R: Math.min(290, o.h / 2 - 70) })
    case 'layers': return layers(e, f, { x: o.x + 100, y: o.y + 20, labelX: o.x + 890, labelW: o.w - 890, bottom: o.y + o.h })
    case 'timeline': return timeline(e, f, o)
    case 'compare': return compare(e, f, o)
    case 'funnel': return funnel(e, f, o)
    case 'merge': return merge(e, f, o)
    case 'grid': return grid(e, f, o)
    case 'cards': return cards(e, f, o)
    case 'donut': return donut(e, f, o, ink)
    case 'bars': return bars(e, f, o, ink)
    case 'line': return line(e, f, o)
    case 'figures': return figures(e, f, o, ink)
  }
}
export const FIGURE_BAND: Box = { x: ML, y: BAND_TOP, w: CW, h: BAND_BOTTOM - BAND_TOP }
export type { Role }
