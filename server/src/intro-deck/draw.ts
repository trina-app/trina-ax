// The drawing kit of round 2 (docs/DECISIONS.md "D2", round 2; the design system's §2–§3, §5): the type scale, the
// grid, a canvas that collects display-list items (layout.ts) and fits text with the round-1 fitter (text.ts). The
// figures (figures.ts) and the compositions (layout2.ts) draw only through it, so every slide speaks one language.
import { iconItems } from './icons'
import type { Fade, Fill, Item, PathItem, PatternItem, PicInfo, Stroke, TextRun } from './layout'
import { cropFor, type Focus } from './layout'
import type { G2 } from './look'
import { fitText, perLine, width, type Fitted, type Role, type Weight } from './text'

export const W = 1920
export const H = 1080
export const ML = 120
export const MR = 120
export const CW = W - ML - MR
export const GUT = 40
export const COL = (CW - 11 * GUT) / 12
export const span = (n: number) => n * COL + (n - 1) * GUT
export const colX = (i: number) => ML + i * (COL + GUT)
/** the title's top, the optional lead's top, the figure band, the footer's line top */
export const TITLE_Y = 150
export const LEAD_Y = 246
export const BAND_TOP = 330
export const BAND_BOTTOM = 930
export const FOOTER_Y = 975

/** The type scale of round 2 at 1920 × 1080 (one notch down each when a text is long; nothing under 22 px). */
export const R2 = {
  display: { size: 120, min: 104, weight: 800, tracking: -0.035, lh: 1.1 },
  section: { size: 96, min: 84, weight: 800, tracking: -0.032, lh: 1.14 },
  title: { size: 60, min: 52, weight: 700, tracking: -0.025, lh: 1.27 },
  statement: { size: 56, min: 48, weight: 700, tracking: -0.025, lh: 1.36 },
  quote: { size: 64, min: 54, weight: 700, tracking: -0.028, lh: 1.42 },
  headL: { size: 44, min: 40, weight: 800, tracking: -0.025, lh: 1.25 },
  head: { size: 36, min: 32, weight: 700, tracking: -0.02, lh: 1.3 },
  headS: { size: 32, min: 28, weight: 700, tracking: -0.02, lh: 1.32 },
  lead: { size: 32, min: 28, weight: 400, tracking: -0.01, lh: 1.5 },
  body: { size: 28, min: 26, weight: 400, tracking: -0.01, lh: 1.55 },
  bodyS: { size: 26, min: 24, weight: 400, tracking: -0.01, lh: 1.55 },
  label: { size: 22, min: 22, weight: 700, tracking: 0.08, lh: 1.3 },
  num: { size: 22, min: 22, weight: 700, tracking: 0.06, lh: 1.3 },
  footer: { size: 22, min: 22, weight: 700, tracking: 0.02, lh: 1.3 },
  pill: { size: 28, min: 24, weight: 700, tracking: -0.01, lh: 1.3 },
  tag: { size: 22, min: 22, weight: 700, tracking: 0, lh: 1.2 },
  centre: { size: 36, min: 30, weight: 800, tracking: -0.02, lh: 1.25 },
  year: { size: 104, min: 88, weight: 800, tracking: -0.04, lh: 1 },
} satisfies Record<string, Role>

export type Fit = Fitted & { role: Role }
/** Where problems go and how a slot is named in them. */
export interface FitCtx { problems: string[]; where: string }

/** Fit a text into `maxLines` lines of `w` px (one notch down if needed), or report it in the AI's own terms. */
export function fit(c: FitCtx, slot: string, raw: string | undefined, role: Role, w: number, maxLines: number, o: { balanced?: boolean; notch?: boolean; size?: number; quiet?: boolean } = {}): Fit | null {
  if (!raw?.trim()) return null
  const f = fitText(raw, role, Math.max(40, w), maxLines, o)
  if (!f) {
    if (!o.quiet) c.problems.push(`${c.where} ${slot}: "${raw.replace(/\*/g, '').slice(0, 60)}" is too long; it must fit ${maxLines} line${maxLines > 1 ? 's' : ''} of about ${perLine(role, Math.max(40, w))} Korean characters (or ${Math.round(perLine(role, Math.max(40, w)) * 1.7)} Latin letters)`)
    return null
  }
  return { ...f, role }
}
/** The first of `sizes` at which every text fits one line of `w` (a row of years or numbers set at one size). */
export function commonSize(texts: string[], role: Role, w: number, sizes: number[]): number | null {
  for (const size of sizes) if (texts.every((t) => !!fitText(t, { ...role, size, min: size }, w, 1, { notch: false }))) return size
  return null
}
export const linesH = (f: Fit | null, lh?: number) => (f ? Math.round(f.size * (lh ?? f.role.lh)) * f.lines.length : 0)
export const widest = (f: Fit | null) => (f ? Math.max(0, ...f.widths) : 0)

const n2 = (v: number) => Math.round(v * 100) / 100
/** A circle as a path (four cubic arcs). */
export function circleD(cx: number, cy: number, r: number): string {
  const k = 0.5522847498 * r
  return `M${n2(cx + r)} ${n2(cy)}C${n2(cx + r)} ${n2(cy + k)} ${n2(cx + k)} ${n2(cy + r)} ${n2(cx)} ${n2(cy + r)}C${n2(cx - k)} ${n2(cy + r)} ${n2(cx - r)} ${n2(cy + k)} ${n2(cx - r)} ${n2(cy)}C${n2(cx - r)} ${n2(cy - k)} ${n2(cx - k)} ${n2(cy - r)} ${n2(cx)} ${n2(cy - r)}C${n2(cx + k)} ${n2(cy - r)} ${n2(cx + r)} ${n2(cy - k)} ${n2(cx + r)} ${n2(cy)}Z`
}
export const polyD = (pts: [number, number][], close = true) => pts.map(([x, y], i) => `${i ? 'L' : 'M'}${n2(x)} ${n2(y)}`).join('') + (close ? 'Z' : '')
/** A rounded rectangle (pill when r = h/2) as a path. */
export function roundRectD(x: number, y: number, w: number, h: number, r: number): string {
  const q = Math.min(r, w / 2, h / 2), k = 0.5522847498 * q
  return `M${n2(x + q)} ${n2(y)}L${n2(x + w - q)} ${n2(y)}C${n2(x + w - q + k)} ${n2(y)} ${n2(x + w)} ${n2(y + q - k)} ${n2(x + w)} ${n2(y + q)}L${n2(x + w)} ${n2(y + h - q)}C${n2(x + w)} ${n2(y + h - q + k)} ${n2(x + w - q + k)} ${n2(y + h)} ${n2(x + w - q)} ${n2(y + h)}L${n2(x + q)} ${n2(y + h)}C${n2(x + q - k)} ${n2(y + h)} ${n2(x)} ${n2(y + h - q + k)} ${n2(x)} ${n2(y + h - q)}L${n2(x)} ${n2(y + q)}C${n2(x)} ${n2(y + q - k)} ${n2(x + q - k)} ${n2(y)} ${n2(x + q)} ${n2(y)}Z`
}

let groupSeq = 0
/** A slide being drawn: its ground tokens and its items, in paint order. */
export class Canvas {
  items: Item[] = []
  constructor(public g: G2) {}
  rect(x: number, y: number, w: number, h: number, fill: Fill, radius = 0, o: { ellipse?: boolean; stroke?: Stroke } = {}) { this.items.push({ t: 'rect', x, y, w, h, fill, radius, ...(o.ellipse ? { ellipse: true } : {}), ...(o.stroke ? { stroke: o.stroke } : {}) }) }
  line(x1: number, y1: number, x2: number, y2: number, color = this.g.line, w = 2, o: { dash?: [number, number]; cap?: 'round' | 'butt' } = {}) { this.items.push({ t: 'line', x1, y1, x2, y2, color, width: w, ...o }) }
  path(d: string, o: { fill?: string; stroke?: Stroke; group?: string; role?: string }) { const it: PathItem = { t: 'path', d, ...o }; this.items.push(it) }
  circle(cx: number, cy: number, r: number, o: { fill?: string; stroke?: Stroke; role?: string }) { this.path(circleD(cx, cy, r), o) }
  /** a Lucide icon, `size` px, stroke in the 24 grid */
  icon(name: string | undefined, x: number, y: number, size: number, color: string, sw = 1.5) { this.items.push(...iconItems(name, x, y, size, color, sw, `icon${++groupSeq}`)) }
  pattern(p: Omit<PatternItem, 't'>) { this.items.push({ t: 'pattern', ...p }) }
  /** a radial glow: an ellipse fading from `a` at the centre to 0 at its edge */
  glow(cx: number, cy: number, r: number, color: string, a: number, ry = r * 0.8) {
    if (a <= 0) return
    this.rect(cx - r, cy - ry, r * 2, ry * 2, { radial: { stops: [{ at: 0, color: alphaHex(color, a) }, { at: 0.55, color: alphaHex(color, a * 0.42) }, { at: 1, color: alphaHex(color, 0) }] } }, 0, { ellipse: true })
  }
  svg(svg: string, x: number, y: number, w: number, h: number, role = 'accent') { this.items.push({ t: 'svg', x, y, w, h, svg, role }) }
  /** a picture filling a frame (cover crop around the focus); a cut-out shown whole */
  image(src: string, pic: PicInfo, x: number, y: number, w: number, h: number, focus: Focus | undefined, radius: number) {
    if (pic.cutout) {
      const k = Math.min(w / pic.width, h / pic.height)
      const iw = Math.round(pic.width * k), ih = Math.round(pic.height * k)
      this.items.push({ t: 'image', x: Math.round(x + (w - iw) / 2), y: Math.round(y + (h - ih) / 2), w: iw, h: ih, src, natural: pic, crop: { x: 0, y: 0, w: pic.width, h: pic.height }, radius: 0 })
      return
    }
    this.items.push({ t: 'image', x, y, w, h, src, natural: pic, crop: cropFor(pic, w, h, focus), radius })
  }
  /** A fitted text with its top-left at (x, y) in a box `w` wide; returns its height. */
  text(f: Fit | null, x: number, y: number, w: number, color: string, o: { accent?: string; align?: 'l' | 'r' | 'c'; role: string; lh?: number; tabular?: boolean; weight?: Weight }): number {
    if (!f) return 0
    const lh = Math.round(f.size * (o.lh ?? f.role.lh))
    this.items.push({
      t: 'text', x, y, w, size: f.size, weight: o.weight ?? f.role.weight, tracking: f.role.tracking, lh, align: o.align ?? 'l', role: o.role, tabular: o.tabular,
      lines: f.lines.map((l) => l.map((r): TextRun => ({ text: r.text, color: r.accent && o.accent ? o.accent : color }))),
    })
    return lh * f.lines.length
  }
  /** One line made of runs of different sizes (a big number with its unit). */
  runs(x: number, y: number, w: number, size: number, weight: Weight, tracking: number, runs: TextRun[], o: { align?: 'l' | 'r' | 'c'; role: string; lh?: number }) {
    this.items.push({ t: 'text', x, y, w, size, weight, tracking, lh: Math.round(size * (o.lh ?? 1)), align: o.align ?? 'l', role: o.role, tabular: true, lines: [runs] })
  }
}
export const alphaHex = (hex: string, a: number) => hex.slice(0, 7) + Math.round(Math.max(0, Math.min(1, a)) * 255).toString(16).padStart(2, '0')
export const textW = (s: string, role: Role, size = role.size) => width(s, size, role.weight, role.tracking)
export type { Fade }
