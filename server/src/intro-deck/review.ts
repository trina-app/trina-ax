// The intro deck's measurable review (docs/DECISIONS.md "D2", round 2; the plan's step 3): after the last slide the
// server renders every slide twice with typst (render.ts: as it is, and with every text item removed — the ground
// under the type) and checks what code can see. On the pixels (960 × 540, half the slide):
//   - contrast: the 2nd-percentile contrast under each run of type, between its colour and the ground render (not
//     the single worst pixel: the antialiased edge of a hairline or a dot under a word is not the ground it is read
//     on). The limits follow WCAG 1.4.3 on the printed slide (13.333 in wide, 1 px = 0.5 pt): 4.5:1, and 3:1 for
//     large type, 18 pt (36 px) or 14 pt bold (28 px at weight ≥ 700). Bold type under 28 px is the deck's labels and
//     running footer, which DESIGN §4 sets in `mute` at 3:1 on purpose: held to 3:1 too. On a flat drawn ground (no
//     picture under it, the luma under the run spreading < 0.04) the colours are the theme's tokens on the layout's
//     own fills, and the tints of cards and steps cost a token up to a fifth of its contrast (mockups: `mute` labels
//     at 2.54:1 on a step's t10): there a run is flagged only below 80 % of its limit, which still catches a token on
//     the wrong fill. Over pictures, gradients, meshes, glows and patterns the limits hold as they are.
//   - busy: the mean Sobel gradient of the ground's luma in the busiest three-em window under the type (type sitting
//     on lettering, circuitry, railings or foliage inside a picture), calibrated on the mockups (REVIEW.busy).
//   - empty: the share of the slide that carries ink, below 18 % (REVIEW.empty).
// And on the layout: type under 22 px, text boxes that overlap, the same layout three slides in a row.
// The findings go back to the AI as words (findingsText) with the pictures; a contrast or busy finding over a picture
// carries the mechanical fix the server applies past the time limit (a stronger scrim, then the drawn ground).
import type { Locale } from '@mycel/shared/api'
import { DECK_FIGURES } from '@mycel/shared/api'
import { SLIDE_W, type Fill, type Item, type SlideOut, type TextItem } from './layout'
import type { Rgba } from './png'
import { width, type Weight } from './text'

export type FindingCode = 'contrast' | 'busy' | 'small' | 'overlap' | 'repeat' | 'empty'
export interface Finding {
  /** the slide's index in the deck (0 = the cover), as the tool's `index` */
  slide: number
  code: FindingCode
  /** the text's role and its first words, or the layout */
  where?: string
  /** what was measured (contrast ratio, mean gradient, size in px, ink share 0–1, slides in a row) */
  value?: number
  /** the limit it missed */
  need?: number
  /** the mechanical fix: over a picture a stronger scrim first, the drawn ground when the scrim is already at its
   * strongest; null where nothing mechanical helps */
  fix?: 'scrim' | 'ground' | null
}

/** The limits. Calibration (scratchpad mockups `deck-plan/png/<deck>/sNN.png`, rendered again by Chromium with every
 * glyph transparent for the ground, then halved to 960 × 540 like the typst render) is in the tests' header and in
 * docs/DECISIONS.md D2 round 2. */
export const REVIEW = {
  /** WCAG body / large text */
  body: 4.5,
  large: 3,
  /** large type in slide px: 18 pt (1 px = 0.5 pt); bold type is held to 3:1 at every size (needFor) */
  largePx: 36,
  /** the low percentile of the contrast under a run */
  percentile: 0.02,
  /** a run counts as on a flat ground when the luma under it spreads less than this between its 2nd and 98th
   * percentile (0–1) */
  flat: 0.04,
  /** on a flat drawn ground a run is flagged below this share of its limit */
  flatShare: 0.8,
  /** the mean Sobel gradient of the luma (0–1 per px at 960 × 540) over the busiest window under a text (busyUnder)
   * above which the ground under type is busy. Calibration (Chromium renders; typst's measure 4–10 % higher): the
   * mockups' busiest window 0.052 (a footer over a circuit board under the bottom scrim), every other mock text
   * ≤ 0.030; type on the lettering of a photo 0.150–0.253, on ivy 0.198, on railings 0.097, on a chip's markings
   * 0.082, on bright circuitry 0.076 */
  busy: 0.065,
  /** the type floor in slide px (DESIGN §3) */
  minSize: 22,
  /** the share of the slide that must carry ink (PLAN step 3) */
  empty: 0.18,
  /** a pixel is ink when its OKLab distance from the slide's ground colour is at least this */
  inkDelta: 0.06,
  /** ink claims the square within this many slide px around it (a line of type counts as the band it occupies, not
   * its strokes; DESIGN's 48 px of clear room around type) */
  inkReach: 48,
  /** the same layout this many slides in a row */
  repeat: 3,
} as const

// ── colour ─────────────────────────────────────────────────────────────────────────────────────────────────────
const LIN = new Float64Array(256)
for (let i = 0; i < 256; i++) { const v = i / 255; LIN[i] = v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
/** "#rrggbb" or "#rrggbbaa" → [r, g, b, a 0–1] (null: not a colour) */
export function rgbaOf(hex: string): [number, number, number, number] | null {
  const v = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(hex)
  if (!v) return null
  const n = Number.parseInt(v[1]!, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, v[2] ? Number.parseInt(v[2], 16) / 255 : 1]
}
/** WCAG relative luminance of an sRGB colour (0–255 channels, fractional allowed for blends) */
export function relLum(r: number, g: number, b: number): number {
  const l = (c: number) => { if (Number.isInteger(c) && c >= 0 && c <= 255) return LIN[c]!; const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
  return 0.2126 * l(r) + 0.7152 * l(g) + 0.0722 * l(b)
}
const ratio = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
/** OKLab of an sRGB colour (0–255 channels) */
export function oklab(r: number, g: number, b: number): [number, number, number] {
  const R = LIN[r]!, G = LIN[g]!, B = LIN[b]!
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B)
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B)
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B)
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s]
}

// ── geometry ───────────────────────────────────────────────────────────────────────────────────────────────────
/** A rectangle in slide px. */
export interface Box { x0: number; y0: number; x1: number; y1: number }
/** One run of type where it is drawn: its line's glyph band (Pretendard's ascender + descender, 1.193 em, centred in
 * the line box as typst.ts places it) and the run's measured width. */
export interface Span extends Box { color: string; size: number; weight: number; line: number; /** the baseline's y */ base: number }

/** Where each run of a text item is drawn (the layout's lines measured with the bundled Pretendard widths; the
 * layout's box is often wider than its lines, and the ground beside a short line is not under the type). */
export function textSpans(it: TextItem): Span[] {
  const out: Span[] = []
  it.lines.forEach((line, i) => {
    const widths = line.map((r) => (r.text ? width(r.text, r.size ?? it.size, (r.weight ?? it.weight) as Weight, it.tracking) : 0))
    const total = widths.reduce((a, b) => a + b, 0)
    let x = it.align === 'r' ? it.x + it.w - total : it.align === 'c' ? it.x + (it.w - total) / 2 : it.x
    const top = it.y + i * it.lh + (it.lh - 1.193 * it.size) / 2
    line.forEach((r, k) => {
      if (r.text.trim() && widths[k]! > 0) out.push({ x0: x, y0: top, x1: x + widths[k]!, y1: top + 1.193 * it.size, color: r.color, size: r.size ?? it.size, weight: r.weight ?? it.weight, line: i, base: top + 0.952 * it.size })
      x += widths[k]!
    })
  })
  return out
}
const meets = (a: Box, b: Box) => Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 0 && Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > 0
const itemBox = (it: Item): Box | null =>
  it.t === 'line' ? { x0: Math.min(it.x1, it.x2), y0: Math.min(it.y1, it.y2), x1: Math.max(it.x1, it.x2), y1: Math.max(it.y1, it.y2) }
    : it.t === 'path' || it.t === 'text' ? null
      : { x0: it.x, y0: it.y, x1: it.x + it.w, y1: it.y + it.h }
/** The pixel rectangle of a box on a render (clamped; null when nothing is left). */
function pixels(img: Rgba, b: Box): { x0: number; y0: number; x1: number; y1: number } | null {
  const k = img.width / SLIDE_W
  const x0 = Math.max(0, Math.floor(b.x0 * k)), y0 = Math.max(0, Math.floor(b.y0 * k))
  const x1 = Math.min(img.width, Math.ceil(b.x1 * k)), y1 = Math.min(img.height, Math.ceil(b.y1 * k))
  return x1 > x0 && y1 > y0 ? { x0, y0, x1, y1 } : null
}
const words = (it: TextItem) => {
  const s = it.lines.map((l) => l.map((r) => r.text).join('')).join(' ').replace(/\s+/g, ' ').trim()
  return s.length > 32 ? `${s.slice(0, 30).trimEnd()}…` : s
}
const whereOf = (it: TextItem) => `${it.role} "${words(it)}"`

// ── pixel measures ─────────────────────────────────────────────────────────────────────────────────────────────
function percentileOf(v: Float64Array, p: number): number {
  v.sort()
  return v[Math.min(v.length - 1, Math.floor(p * v.length))]!
}

/** The contrast between type in `color` and the ground render under `box`, at the low percentile (null: the box is
 * off the slide). A colour with alpha is blended over each pixel first, as the renderers do. Also the luma spread
 * under the box (98th − 2nd percentile, 0–1), which says whether the ground is flat. */
export function contrastUnder(ground: Rgba, box: Box, color: string, p: number = REVIEW.percentile): { ratio: number; spread: number } | null {
  const c = rgbaOf(color), px = pixels(ground, box)
  if (!c || !px) return null
  const n = (px.x1 - px.x0) * (px.y1 - px.y0)
  const ratios = new Float64Array(n), luma = new Float64Array(n)
  const d = ground.data, a = c[3]
  const solid = a >= 1 ? relLum(c[0], c[1], c[2]) : 0
  let i = 0
  for (let y = px.y0; y < px.y1; y++) for (let x = px.x0; x < px.x1; x++) {
    const o = (y * ground.width + x) * 4
    const r = d[o]!, g = d[o + 1]!, b = d[o + 2]!
    const lg = 0.2126 * LIN[r]! + 0.7152 * LIN[g]! + 0.0722 * LIN[b]!
    const lt = a >= 1 ? solid : relLum(r + (c[0] - r) * a, g + (c[1] - g) * a, b + (c[2] - b) * a)
    ratios[i] = ratio(lt, lg)
    luma[i++] = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
  }
  const lo = percentileOf(ratios, p)
  luma.sort()
  const spread = luma[Math.min(n - 1, Math.floor(0.98 * n))]! - luma[Math.floor(0.02 * n)]!
  return { ratio: lo, spread }
}

/** The mean Sobel gradient magnitude of the luma (sRGB-encoded, 0–1; a hard step of Δ gives Δ on the two pixels
 * beside it) over the union of the boxes. */
export function edgeDensity(img: Rgba, boxes: Box[]): number {
  const { width: W, height: H, data: d } = img
  const Y = (x: number, y: number) => {
    const o = (Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))) * 4
    return (0.2126 * d[o]! + 0.7152 * d[o + 1]! + 0.0722 * d[o + 2]!) / 255
  }
  const rects = boxes.map((b) => pixels(img, b)).filter((r): r is NonNullable<typeof r> => !!r)
  if (!rects.length) return 0
  // each pixel once where boxes overlap (a mask over their bounds)
  const bx0 = Math.min(...rects.map((r) => r.x0)), by0 = Math.min(...rects.map((r) => r.y0))
  const bw = Math.max(...rects.map((r) => r.x1)) - bx0, bh = Math.max(...rects.map((r) => r.y1)) - by0
  const seen = rects.length > 1 ? new Uint8Array(bw * bh) : null
  let sum = 0, n = 0
  for (const px of rects) {
    for (let y = px.y0; y < px.y1; y++) for (let x = px.x0; x < px.x1; x++) {
      if (seen) { const k = (y - by0) * bw + (x - bx0); if (seen[k]) continue; seen[k] = 1 }
      const gx = Y(x + 1, y - 1) + 2 * Y(x + 1, y) + Y(x + 1, y + 1) - Y(x - 1, y - 1) - 2 * Y(x - 1, y) - Y(x - 1, y + 1)
      const gy = Y(x - 1, y + 1) + 2 * Y(x, y + 1) + Y(x + 1, y + 1) - Y(x - 1, y - 1) - 2 * Y(x, y - 1) - Y(x + 1, y - 1)
      sum += Math.hypot(gx, gy) / 4
      n++
    }
  }
  return n ? sum / n : 0
}

/** The share of the slide that carries ink: pixels whose OKLab distance from the slide's ground colour is at least
 * `delta` (a text, a hairline, a figure, a picture; not the faint corner glow of a content slide), each claiming the
 * square within `reach` slide px around it, so a line of type counts as the band it occupies rather than its thin
 * strokes. */
export function inkCoverage(full: Rgba, groundHex: string, o: { delta?: number; reach?: number } = {}): number {
  const gc = rgbaOf(groundHex)
  const { width: W, height: H, data: d } = full
  if (!gc || !W || !H) return 0
  const [gl, ga, gb] = oklab(gc[0], gc[1], gc[2])
  const delta = o.delta ?? REVIEW.inkDelta, d2 = delta * delta
  const ink = new Uint8Array(W * H)
  // most pixels repeat a few colours: remember their verdict
  const memo = new Map<number, number>()
  for (let i = 0; i < W * H; i++) {
    const key = (d[i * 4]! << 16) | (d[i * 4 + 1]! << 8) | d[i * 4 + 2]!
    let v = memo.get(key)
    if (v === undefined) {
      const [l, a, b] = oklab(d[i * 4]!, d[i * 4 + 1]!, d[i * 4 + 2]!)
      v = (l - gl) ** 2 + (a - ga) ** 2 + (b - gb) ** 2 >= d2 ? 1 : 0
      if (memo.size < 200_000) memo.set(key, v)
    }
    ink[i] = v
  }
  const r = Math.round(((o.reach ?? REVIEW.inkReach) * W) / SLIDE_W)
  if (r <= 0) { let n = 0; for (let i = 0; i < ink.length; i++) n += ink[i]!; return n / ink.length }
  // a square dilation, one axis at a time (a running count of ink within ±r)
  const row = new Uint8Array(W * H)
  for (let y = 0; y < H; y++) {
    let c = 0
    for (let x = 0; x < Math.min(W, r); x++) c += ink[y * W + x]!
    for (let x = 0; x < W; x++) {
      if (x + r < W) c += ink[y * W + x + r]!
      if (x - r - 1 >= 0) c -= ink[y * W + x - r - 1]!
      row[y * W + x] = c > 0 ? 1 : 0
    }
  }
  let covered = 0
  for (let x = 0; x < W; x++) {
    let c = 0
    for (let y = 0; y < Math.min(H, r); y++) c += row[y * W + x]!
    for (let y = 0; y < H; y++) {
      if (y + r < H) c += row[(y + r) * W + x]!
      if (y - r - 1 >= 0) c -= row[(y - r - 1) * W + x]!
      if (c > 0) covered++
    }
  }
  return covered / (W * H)
}

/** The busiest stretch under a text: edgeDensity over windows about three em wide sliding along each run by half their
 * width (one word on a sign inside a photo must not be averaged away by a long line on a calm ground). */
export function busyUnder(ground: Rgba, spans: Span[]): number {
  let max = 0
  for (const s of spans) {
    const w = Math.min(s.x1 - s.x0, 3 * s.size)
    if (w <= 0) continue
    for (let x = s.x0; ; x += w / 2) {
      const x1 = Math.min(s.x1, x + w)
      max = Math.max(max, edgeDensity(ground, [{ x0: x1 - w, y0: s.y0, x1, y1: s.y1 }]))
      if (x1 >= s.x1) break
    }
  }
  return max
}

// ── the checks ─────────────────────────────────────────────────────────────────────────────────────────────────
/** 3:1 for large type (18 pt = 36 px, or 14 pt = 28 px bold) and for the bold labels and footer under 28 px (`mute`,
 * 3:1 by design), so for all bold type; 4.5:1 for regular type under 36 px */
const needFor = (size: number, weight: number) => (size >= REVIEW.largePx || weight >= 700 ? REVIEW.large : REVIEW.body)
const maxAlpha = (f: Fill): number => {
  const a = (hex: string) => rgbaOf(hex)?.[3] ?? 1
  return 'solid' in f ? a(f.solid) : Math.max(...('linear' in f ? f.linear.stops : f.radial.stops).map((s) => a(s.color)))
}

/** Under a text item: the pictures (not logos) drawn before it, and the strongest scrim (a gradient or translucent
 * rect drawn over such a picture) that covers it. */
function under(items: Item[], at: number, spans: Span[]): { picture: boolean; scrim: number } {
  let picture = false, scrim = 0
  for (let i = 0; i < at; i++) {
    const it = items[i]!
    const b = itemBox(it)
    if (!b || !spans.some((s) => meets(s, b))) continue
    if (it.t === 'image' && !it.logo) { picture = true; scrim = 0 }
    else if (picture && it.t === 'rect' && !('solid' in it.fill && maxAlpha(it.fill) >= 1)) scrim = Math.max(scrim, maxAlpha(it.fill))
  }
  return { picture, scrim }
}

/** The checks of one slide on its renders (`full`, `ground` at any scale of 1920 × 1080; either may be missing, and
 * then only the layout checks run). */
export function reviewSlide(slide: SlideOut, index: number, renders: { full?: Rgba | null; ground?: Rgba | null } = {}): Finding[] {
  const out: Finding[] = []
  const texts = slide.items.map((it, i) => ({ it, i })).filter((x): x is { it: TextItem; i: number } => x.it.t === 'text')
  const spans = new Map<TextItem, Span[]>(texts.map(({ it }) => [it, textSpans(it)]))
  // type under the floor
  for (const { it } of texts) {
    const smallest = Math.min(it.size, ...it.lines.flat().map((r) => r.size ?? it.size))
    if (smallest < REVIEW.minSize) out.push({ slide: index, code: 'small', where: whereOf(it), value: smallest, need: REVIEW.minSize, fix: null })
  }
  // text over text: where the glyphs are (Hangul and capitals from 0.82 em above the baseline to 0.14 em below; the
  // line box's leading may touch the next text's), more than a hair
  const ink = (s: Span): Box => ({ x0: s.x0, x1: s.x1, y0: s.base - 0.82 * s.size, y1: s.base + 0.14 * s.size })
  for (let a = 0; a < texts.length; a++) for (let b = a + 1; b < texts.length; b++) {
    const A = spans.get(texts[a]!.it)!.map(ink), B = spans.get(texts[b]!.it)!.map(ink)
    const hit = A.some((s) => B.some((t) => Math.min(s.x1, t.x1) - Math.max(s.x0, t.x0) >= 4 && Math.min(s.y1, t.y1) - Math.max(s.y0, t.y0) >= 4))
    if (hit) out.push({ slide: index, code: 'overlap', where: `${whereOf(texts[a]!.it)} and ${whereOf(texts[b]!.it)}`, fix: null })
  }
  const ground = renders.ground
  if (ground) {
    for (const { it, i } of texts) {
      const sp = spans.get(it)!
      if (!sp.length) continue
      const u = under(slide.items, i, sp)
      const fix = u.picture ? (u.scrim >= 0.955 ? 'ground' : 'scrim') : null
      // contrast: the run that misses its limit by the most
      let worst: { value: number; need: number } | null = null
      for (const s of sp) {
        const m = contrastUnder(ground, s, s.color)
        if (!m) continue
        const need = needFor(s.size, s.weight)
        // the theme's tokens on the layout's own flat fills: flagged only well below the limit
        const floor = !u.picture && m.spread < REVIEW.flat ? need * REVIEW.flatShare : need
        if (m.ratio < floor && (!worst || m.ratio / need < worst.value / worst.need)) worst = { value: m.ratio, need }
      }
      if (worst) out.push({ slide: index, code: 'contrast', where: whereOf(it), value: Math.round(worst.value * 100) / 100, need: worst.need, fix })
      const busy = busyUnder(ground, sp)
      if (busy > REVIEW.busy) out.push({ slide: index, code: 'busy', where: whereOf(it), value: Math.round(busy * 1000) / 1000, need: REVIEW.busy, fix })
    }
  }
  if (renders.full) {
    const cov = inkCoverage(renders.full, slide.ground)
    if (cov < REVIEW.empty) out.push({ slide: index, code: 'empty', value: Math.round(cov * 1000) / 1000, need: REVIEW.empty, fix: null })
  }
  return out
}

/** The layout that repeats: a round-2 figure variant is a layout of its own whatever the slide's kind; any other
 * variant is the kind's. */
const layoutKey = (s: SlideOut) => ((DECK_FIGURES as readonly string[]).includes(s.variant) ? s.variant : `${s.kind}:${s.variant}`)

/** The whole deck: every slide's checks (renders by slide; missing ones skip the pixel checks) and the same layout
 * three slides in a row (one finding on the third slide of each run). */
export function reviewDeck(slides: SlideOut[], renders?: { full?: (Rgba | null)[] | null; ground?: (Rgba | null)[] | null } | null): Finding[] {
  const out: Finding[] = []
  slides.forEach((s, i) => out.push(...reviewSlide(s, i, { full: renders?.full?.[i] ?? null, ground: renders?.ground?.[i] ?? null })))
  let run = 1
  for (let i = 1; i < slides.length; i++) {
    run = layoutKey(slides[i]!) === layoutKey(slides[i - 1]!) ? run + 1 : 1
    if (run === REVIEW.repeat) out.push({ slide: i, code: 'repeat', where: layoutKey(slides[i]!), value: run, need: REVIEW.repeat - 1, fix: null })
  }
  return out.sort((a, b) => a.slide - b.slide)
}

/** The findings in plain English for the AI, one line each (the slide as "slide 3 (index 2)"; quoted words stay in
 * the deck's language). Empty string: nothing found. */
export function findingsText(findings: Finding[], lang: Locale): string {
  const n = (i: number) => `Slide ${i + 1} (index ${i})`
  const pct = (v: number) => `${Math.round(v * 100)} %`
  const lines = findings.map((f) => {
    const w = f.where ?? ''
    switch (f.code) {
      case 'contrast':
        return `${n(f.slide)}: the ${w} reads at ${f.value?.toFixed(1)}:1 on what is under it (needs ${f.need}:1). ` + (f.fix
          ? `It sits on a picture: choose a picture with a plain, calm side for the type, correct the picture's calm side, or drop the picture${f.fix === 'scrim' ? ' (otherwise the server darkens the scrim)' : ' (otherwise the server puts the slide on its drawn ground)'}.`
          : 'Drop or move what sits under it (the accent or the figure), or shorten the text so it clears it.')
      case 'busy':
        return `${n(f.slide)}: the ${w} sits on a busy part of the ground (edge density ${f.value?.toFixed(3)}, limit ${f.need}): ` + (f.fix
          ? 'choose a picture whose calm side is plain (no lettering, no fine detail where the type goes), correct its calm side, or drop the picture.'
          : 'drop the accent or the pattern behind it, or shorten the text.')
      case 'small':
        return `${n(f.slide)}: the ${w} is set at ${f.value} px (the floor is ${f.need} px): shorten it so it fits at its normal size.`
      case 'overlap':
        return `${n(f.slide)}: the ${w} overlap: shorten one of them.`
      case 'repeat':
        return `${n(f.slide)}: this is the ${f.value === 3 ? 'third' : `${f.value}th`} slide in a row with the same layout (${w}): give one of them another figure kind.`
      case 'empty':
        return `${n(f.slide)}: the slide reads as empty (ink on ${pct(f.value ?? 0)} of it, at least ${pct(f.need ?? REVIEW.empty)}): add its figure or a sub-line, or merge it with a neighbour.`
    }
  })
  void lang // the AI reads English; the quoted words are the deck's own
  return lines.join('\n')
}
