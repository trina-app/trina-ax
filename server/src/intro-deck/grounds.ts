// The intro deck's drawn grounds (DESIGN.md §8 "Grounds"; docs/DECISIONS.md "D2"): dots, lines and contours, made
// from a seed so a rebuild looks the same, drawn the same in every output. The preview and the PDF draw the SVG
// fragment (patternSvg); the PowerPoint file places a picture of exactly the same geometry (patternPng, one slide px per
// PNG px), because a ground is not something a person edits shape by shape.
//
// The geometry, in slide px (1920 × 1080):
// - dots: a disc of radius `size` at (x + step/2 + i·step, y + step/2 + j·step), cut by the box;
// - lines: straight lines `size` wide, `step` apart, the first at step/2 from the box's corner; angle 0 is vertical
//   lines (as the mockups), a positive angle turns them clockwise;
// - contours: `levels` isolines of a seeded value noise sampled at (slide px × `scale`) on a grid of about 12 px over
//   the box (marching squares), chained into polylines, coordinates to 0.1 px, `size` wide with round caps and joins.
// Everything is cut to the box, coloured `color` at `opacity` (a colour's own alpha multiplies it) and faded by `fade`:
// a linear or radial mask whose value is exactly 0 where the fade says 0 (the type sits there).
import type { Fade, PatternItem } from './layout'
import { encodePng } from './png'

// ── seeds and noise ────────────────────────────────────────────────────────────────────────────────────────────
/** A small fast PRNG (mulberry32, as the mockups): numbers in [0, 1). */
export function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const utf8 = new TextEncoder()
/** A stable 32-bit seed from strings (the team id and the deck title): FNV-1a over their UTF-8 bytes, a 0 byte between
 * parts, then murmur3's finaliser so close strings land far apart. */
export function seedOf(...parts: string[]): number {
  let h = 0x811c9dc5
  parts.forEach((p, i) => {
    if (i) h = Math.imul(h, 0x01000193)
    for (const b of utf8.encode(p)) h = Math.imul(h ^ b, 0x01000193)
  })
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}

/** Seeded value noise on a 64 × 64 lattice (smoothstep), three octaves; about 0..1. The mockups' field. */
export function makeNoise(seed: number): (x: number, y: number) => number {
  const r = rng(seed), P = 64
  const g = new Float64Array(P * P)
  for (let i = 0; i < g.length; i++) g[i] = r()
  const at = (i: number, j: number) => g[(((j % P) + P) % P) * P + (((i % P) + P) % P)]!
  const sm = (t: number) => t * t * (3 - 2 * t)
  const n = (x: number, y: number) => {
    const i = Math.floor(x), j = Math.floor(y), fx = sm(x - i), fy = sm(y - j)
    const a = at(i, j), b = at(i + 1, j), c = at(i, j + 1), d = at(i + 1, j + 1)
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy
  }
  return (x, y) => 0.6 * n(x, y) + 0.28 * n(x * 2.03 + 11, y * 2.03 + 7) + 0.12 * n(x * 4.1 + 3, y * 4.1 + 19)
}

// ── shared bits ────────────────────────────────────────────────────────────────────────────────────────────────
const CELL = 12
const clamp01 = (v: number) => (v <= 0 ? 0 : v >= 1 ? 1 : v)
const fin = (v: number | undefined, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
/** a number as SVG writes it (2 decimals at most, never an exponent) */
export const num = (v: number) => { const r = Math.round(v * 100) / 100; return Object.is(r, -0) || Math.abs(r) < 0.005 ? '0' : String(r) }

/** "#rrggbb" or "#rrggbbaa" → its RGB and alpha (null: not a colour the theme makes) */
export function rgbOf(color: string): { hex: string; r: number; g: number; b: number; a: number } | null {
  const v = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(typeof color === 'string' ? color : '')
  if (!v) return null
  const n = Number.parseInt(v[1]!, 16)
  return { hex: '#' + v[1]!.toLowerCase(), r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: v[2] ? Number.parseInt(v[2], 16) / 255 : 1 }
}

/** The pattern's numbers, checked: a box of at least 1 px, a step of at least 4 px, a size above 0. */
function norm(p: PatternItem) {
  const x = fin(p.x, 0), y = fin(p.y, 0), w = Math.max(1, fin(p.w, 0)), h = Math.max(1, fin(p.h, 0))
  const step = Math.max(4, fin(p.step, 30)), size = Math.max(0.1, Math.min(step, fin(p.size, 1.5)))
  const levels = Math.max(1, Math.min(40, Math.round(fin(p.levels, 12))))
  const scale = Math.max(1e-5, Math.min(1, fin(p.scale, 0.0022)))
  const angle = fin(p.angle, 0)
  return { x, y, w, h, step, size, levels, scale, angle, seed: fin(p.seed, 1) >>> 0 }
}

/** The fade as a function of a slide point: the linear one runs from `from` at (x1, y1) to `to` at (x2, y2) along that
 * direction, clamped beyond; the radial one from `inner` at the centre to `outer` at r and beyond (as SVG's gradients
 * pad). No fade: 1 everywhere. */
export function fadeFn(f: Fade | undefined): (X: number, Y: number) => number {
  if (!f) return () => 1
  if ('linear' in f) {
    const l = f.linear, x1 = fin(l.x1, 0), y1 = fin(l.y1, 0), dx = fin(l.x2, 0) - x1, dy = fin(l.y2, 0) - y1, L2 = dx * dx + dy * dy
    const from = clamp01(fin(l.from, 1)), to = clamp01(fin(l.to, 1))
    if (!(L2 > 0)) return () => to
    return (X, Y) => {
      const t = ((X - x1) * dx + (Y - y1) * dy) / L2
      return t <= 0 ? from : t >= 1 ? to : from + (to - from) * t
    }
  }
  const r = f.radial, cx = fin(r.cx, 0), cy = fin(r.cy, 0), R = fin(r.r, 0), inner = clamp01(fin(r.inner, 1)), outer = clamp01(fin(r.outer, 1))
  if (!(R > 0)) return () => outer
  return (X, Y) => {
    const t = Math.hypot(X - cx, Y - cy) / R
    return t <= 0 ? inner : t >= 1 ? outer : inner + (outer - inner) * t
  }
}
export const fadeAt = (f: Fade | undefined, X: number, Y: number) => fadeFn(f)(X, Y)

// ── contours (marching squares) ────────────────────────────────────────────────────────────────────────────────
interface Field { nx: number; ny: number; cw: number; ch: number; v: Float64Array; th: number[] }
function field(p: PatternItem): Field {
  const q = norm(p)
  const noise = makeNoise(q.seed)
  const nx = Math.max(1, Math.ceil(q.w / CELL)), ny = Math.max(1, Math.ceil(q.h / CELL))
  const cw = q.w / nx, ch = q.h / ny
  const v = new Float64Array((nx + 1) * (ny + 1))
  let lo = Infinity, hi = -Infinity
  for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) {
    const s = noise((q.x + i * cw) * q.scale, (q.y + j * ch) * q.scale)
    v[j * (nx + 1) + i] = s
    if (s < lo) lo = s
    if (s > hi) hi = s
  }
  const th: number[] = []
  for (let k = 1; k <= q.levels; k++) th.push(lo + ((hi - lo) * k) / (q.levels + 1))
  return { nx, ny, cw, ch, v, th }
}

/** Each level's crossings as pairs of grid edges (an edge is named by its index, so two cells that share it share the
 * point exactly). Horizontal edges first (j·nx + i), then vertical ones. */
function crossings(F: Field, th: number): Int32Array {
  const { nx, ny, v } = F
  const H = nx * (ny + 1)
  const hE = (i: number, j: number) => j * nx + i
  const vE = (i: number, j: number) => H + j * (nx + 1) + i
  const out: number[] = []
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const a = v[j * (nx + 1) + i]!, b = v[j * (nx + 1) + i + 1]!, c = v[(j + 1) * (nx + 1) + i + 1]!, d = v[(j + 1) * (nx + 1) + i]!
    const idx = (a > th ? 8 : 0) | (b > th ? 4 : 0) | (c > th ? 2 : 0) | (d > th ? 1 : 0)
    if (idx === 0 || idx === 15) continue
    const T = hE(i, j), B = hE(i, j + 1), L = vE(i, j), R = vE(i + 1, j)
    switch (idx) {
      case 1: case 14: out.push(L, B); break
      case 2: case 13: out.push(B, R); break
      case 3: case 12: out.push(L, R); break
      case 4: case 11: out.push(T, R); break
      case 6: case 9: out.push(T, B); break
      case 7: case 8: out.push(L, T); break
      case 5: out.push(L, T, B, R); break
      case 10: out.push(L, B, T, R); break
    }
  }
  return Int32Array.from(out)
}

function edgePoint(F: Field, x0: number, y0: number, th: number, e: number): [number, number] {
  const { nx, ny, cw, ch, v } = F
  const H = nx * (ny + 1)
  if (e < H) {
    const j = Math.floor(e / nx), i = e - j * nx
    const a = v[j * (nx + 1) + i]!, b = v[j * (nx + 1) + i + 1]!
    return [x0 + (i + (th - a) / (b - a)) * cw, y0 + j * ch]
  }
  const k = e - H, j = Math.floor(k / (nx + 1)), i = k - j * (nx + 1)
  const a = v[j * (nx + 1) + i]!, d = v[(j + 1) * (nx + 1) + i]!
  return [x0 + i * cw, y0 + (j + (th - a) / (d - a)) * ch]
}

/** The isolines as segments, per level: [x1, y1, x2, y2, …] in slide px, inside the box. */
export function contourSegments(p: PatternItem): number[][] {
  const F = field(p), q = norm(p)
  return F.th.map((th) => {
    const e = crossings(F, th), out: number[] = []
    for (let s = 0; s < e.length; s++) out.push(...edgePoint(F, q.x, q.y, th, e[s]!))
    return out
  })
}

export interface Polyline { pts: number[]; closed: boolean }
const r1 = (v: number) => Math.round(v * 10) / 10
/** The isolines chained into polylines (each crossing joined to the next through the edge they share), coordinates
 * rounded to 0.1 px: what both the SVG and the picture draw. */
export function contourLines(p: PatternItem): Polyline[][] {
  const F = field(p), q = norm(p)
  return F.th.map((th) => {
    const e = crossings(F, th), n = e.length / 2
    // edge → the (at most two) segments that touch it
    const first = new Map<number, number>(), second = new Map<number, number>()
    for (let s = 0; s < n; s++) for (const k of [e[2 * s]!, e[2 * s + 1]!]) { if (first.has(k)) second.set(k, s); else first.set(k, s) }
    const other = (k: number, s: number) => { const a = first.get(k), b = second.get(k); return a === s ? b : a }
    const used = new Uint8Array(n)
    const lines: Polyline[] = []
    for (let s0 = 0; s0 < n; s0++) {
      if (used[s0]) continue
      used[s0] = 1
      const edges = [e[2 * s0]!, e[2 * s0 + 1]!]
      // forward from the second edge, then backward from the first
      let closed = false
      for (let s = s0, k = edges[1]!; ;) {
        const t = other(k, s)
        if (t === undefined) break
        if (used[t]) { if (t === s0 && edges.length > 2) closed = true; break }
        used[t] = 1
        const nk = e[2 * t] === k ? e[2 * t + 1]! : e[2 * t]!
        edges.push(nk)
        s = t; k = nk
      }
      if (!closed) {
        for (let s = s0, k = edges[0]!; ;) {
          const t = other(k, s)
          if (t === undefined || used[t]) break
          used[t] = 1
          const nk = e[2 * t] === k ? e[2 * t + 1]! : e[2 * t]!
          edges.unshift(nk)
          s = t; k = nk
        }
      }
      if (closed && edges[edges.length - 1] === edges[0]) edges.pop()
      const pts: number[] = []
      for (const k of edges) { const [px, py] = edgePoint(F, q.x, q.y, th, k); pts.push(r1(px), r1(py)) }
      lines.push({ pts, closed })
    }
    return lines
  })
}

// ── lines ──────────────────────────────────────────────────────────────────────────────────────────────────────
/** The straight lines that touch the box (each cut to the box grown by the line's width; the clip does the rest). */
function lineSegments(p: PatternItem): number[] {
  const q = norm(p)
  const a = (q.angle * Math.PI) / 180, nxv = Math.cos(a), nyv = Math.sin(a), dx = -nyv, dy = nxv
  const grow = q.size
  const bx0 = q.x - grow, by0 = q.y - grow, bx1 = q.x + q.w + grow, by1 = q.y + q.h + grow
  // the box's corners along the normal (from the box's corner)
  const proj = [[bx0, by0], [bx1, by0], [bx0, by1], [bx1, by1]].map(([X, Y]) => (X! - q.x) * nxv + (Y! - q.y) * nyv)
  const kLo = Math.ceil((Math.min(...proj) - q.step / 2) / q.step), kHi = Math.floor((Math.max(...proj) - q.step / 2) / q.step)
  const out: number[] = []
  for (let k = kLo; k <= kHi; k++) {
    const c = q.step / 2 + k * q.step
    const ox = q.x + c * nxv, oy = q.y + c * nyv
    // Liang–Barsky against the grown box
    let t0 = -Infinity, t1 = Infinity, ok = true
    for (const [p0, d, lo, hi] of [[ox, dx, bx0, bx1], [oy, dy, by0, by1]] as const) {
      if (Math.abs(d) < 1e-12) { if (p0 < lo || p0 > hi) ok = false; continue }
      let ta = (lo - p0) / d, tb = (hi - p0) / d
      if (ta > tb) [ta, tb] = [tb, ta]
      t0 = Math.max(t0, ta); t1 = Math.min(t1, tb)
    }
    if (!ok || t1 <= t0) continue
    out.push(r1(ox + dx * t0), r1(oy + dy * t0), r1(ox + dx * t1), r1(oy + dy * t1))
  }
  return out
}

// ── SVG ────────────────────────────────────────────────────────────────────────────────────────────────────────
/** A polyline as path data: absolute move, then relative lines (deltas of the rounded points, so nothing drifts). */
function polyD(pl: Polyline): string {
  const p = pl.pts
  let d = `M${num(p[0]!)} ${num(p[1]!)}l`
  for (let i = 2; i < p.length; i += 2) {
    const ddx = num(r1(p[i]! - p[i - 2]!)), ddy = num(r1(p[i + 1]! - p[i - 1]!))
    d += (i > 2 && !ddx.startsWith('-') ? ' ' : '') + ddx + (ddy.startsWith('-') ? '' : ' ') + ddy
  }
  if (p.length === 2) d += '0 0'
  return pl.closed ? d + 'z' : d
}

/** The pattern as an SVG fragment in slide coordinates, with its own <defs> (ids from `id`, which must be unique in
 * the document): cut to the box, faded by a mask. '' when its colour is not one the theme makes. */
export function patternSvg(p: PatternItem, id: string): string {
  const c = rgbOf(p.color)
  if (!c) return ''
  const q = norm(p)
  const op = clamp01(fin(p.opacity, 0) * c.a)
  if (op <= 0) return ''
  const k = id.replace(/[^A-Za-z0-9_-]/g, '') || 'g'
  const box = `x="${num(q.x)}" y="${num(q.y)}" width="${num(q.w)}" height="${num(q.h)}"`
  let defs = `<clipPath id="${k}c"><rect ${box}/></clipPath>`
  let mask = ''
  const f = p.fade
  if (f) {
    const stop = (at: number, o: number) => `<stop offset="${at}" stop-color="#fff" stop-opacity="${Math.round(clamp01(fin(o, 1)) * 1000) / 1000}"/>`
    if ('linear' in f) {
      const l = f.linear
      defs += `<linearGradient id="${k}g" gradientUnits="userSpaceOnUse" x1="${num(fin(l.x1, 0))}" y1="${num(fin(l.y1, 0))}" x2="${num(fin(l.x2, 0))}" y2="${num(fin(l.y2, 0))}">${stop(0, l.from)}${stop(1, l.to)}</linearGradient>`
    } else {
      const r = f.radial
      defs += `<radialGradient id="${k}g" gradientUnits="userSpaceOnUse" cx="${num(fin(r.cx, 0))}" cy="${num(fin(r.cy, 0))}" r="${num(Math.max(0, fin(r.r, 0)))}">${stop(0, r.inner)}${stop(1, r.outer)}</radialGradient>`
    }
    defs += `<mask id="${k}m" maskUnits="userSpaceOnUse" ${box}><rect ${box} fill="url(#${k}g)"/></mask>`
    mask = ` mask="url(#${k}m)"`
  }
  let body: string
  if (p.kind === 'dots') {
    defs += `<pattern id="${k}p" patternUnits="userSpaceOnUse" x="${num(q.x)}" y="${num(q.y)}" width="${num(q.step)}" height="${num(q.step)}"><circle cx="${num(q.step / 2)}" cy="${num(q.step / 2)}" r="${num(q.size)}" fill="${c.hex}"/></pattern>`
    body = `<rect ${box} fill="url(#${k}p)"/>`
  } else if (p.kind === 'lines') {
    const s = lineSegments(p)
    let d = ''
    for (let i = 0; i < s.length; i += 4) d += `M${num(s[i]!)} ${num(s[i + 1]!)}L${num(s[i + 2]!)} ${num(s[i + 3]!)}`
    body = d ? `<path d="${d}" fill="none" stroke="${c.hex}" stroke-width="${num(q.size)}"/>` : ''
  } else {
    body = contourLines(p).map((lv) => lv.length ? `<path d="${lv.map(polyD).join('')}" fill="none" stroke="${c.hex}" stroke-width="${num(q.size)}" stroke-linecap="round" stroke-linejoin="round"/>` : '').join('')
  }
  if (!body) return ''
  return `<defs>${defs}</defs><g clip-path="url(#${k}c)"${mask} opacity="${Math.round(op * 1000) / 1000}">${body}</g>`
}

/** The pattern as a whole SVG document of its own (the PDF's image file), in slide coordinates. */
export function patternSvgDoc(p: PatternItem, id = 'g'): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080">${patternSvg(p, id)}</svg>`
}

// ── the picture (PowerPoint) ───────────────────────────────────────────────────────────────────────────────────
/** How much of a pixel a band `s` wide covers when its centre line is `d` px from the pixel's centre (a box filter
 * across the band: exact for a band along an axis, close enough at an angle). */
const band = (d: number, s: number) => { const v = Math.min(d + s / 2, 0.5) - Math.max(d - s / 2, -0.5); return v <= 0 ? 0 : v >= 1 ? 1 : v }

/** The pattern drawn in pure JS: an RGBA PNG of exactly the box (1 slide px = 1 PNG px), anti-aliased, alpha =
 * opacity × fade, the colour everywhere (so a viewer's resampling never bleeds black into the edges). */
export function patternPng(p: PatternItem): Uint8Array {
  const q = norm(p)
  const c = rgbOf(p.color)
  const W = Math.max(1, Math.round(q.w)), H = Math.max(1, Math.round(q.h))
  const sx = q.w / W, sy = q.h / H
  const cov = new Float32Array(W * H)
  const op = c ? clamp01(fin(p.opacity, 0) * c.a) : 0
  // pixel i's centre in slide px, and back
  const X = (i: number) => q.x + (i + 0.5) * sx, Y = (j: number) => q.y + (j + 0.5) * sy
  const colOf = (v: number) => Math.floor((v - q.x) / sx - 0.5), rowOf = (v: number) => Math.floor((v - q.y) / sy - 0.5)
  if (op > 0 && p.kind === 'dots') {
    const r = q.size
    for (let cy = q.y + q.step / 2; cy - r < q.y + q.h; cy += q.step) for (let cx = q.x + q.step / 2; cx - r < q.x + q.w; cx += q.step) {
      const i0 = Math.max(0, colOf(cx - r - 1)), i1 = Math.min(W - 1, colOf(cx + r + 1) + 1)
      const j0 = Math.max(0, rowOf(cy - r - 1)), j1 = Math.min(H - 1, rowOf(cy + r + 1) + 1)
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const v = clamp01(r + 0.5 - Math.hypot(X(i) - cx, Y(j) - cy))
        if (v > cov[j * W + i]!) cov[j * W + i] = v
      }
    }
  } else if (op > 0 && p.kind === 'lines') {
    const a = (q.angle * Math.PI) / 180, nxv = Math.cos(a), nyv = Math.sin(a), st = q.step, half = q.size / 2
    for (let j = 0; j < H; j++) {
      const row = (Y(j) - q.y) * nyv - st / 2
      for (let i = 0, o = j * W; i < W; i++, o++) {
        const v = (X(i) - q.x) * nxv + row
        const d = Math.abs(v - st * Math.round(v / st))
        if (d < half + 0.5) cov[o] = band(d, q.size)
      }
    }
  } else if (op > 0) {
    const hw = q.size / 2 + 1
    for (const level of contourLines(p)) for (const pl of level) {
      const pts = pl.pts, n = pts.length / 2
      const segs = pl.closed ? n : n - 1
      for (let s = 0; s < Math.max(1, segs); s++) {
        const ax = pts[2 * s]!, ay = pts[2 * s + 1]!, bx = pts[(2 * (s + 1)) % pts.length] ?? ax, by = pts[((2 * (s + 1)) % pts.length) + 1] ?? ay
        const ex = bx - ax, ey = by - ay, L2 = ex * ex + ey * ey
        const i0 = Math.max(0, colOf(Math.min(ax, bx) - hw)), i1 = Math.min(W - 1, colOf(Math.max(ax, bx) + hw) + 1)
        const j0 = Math.max(0, rowOf(Math.min(ay, by) - hw)), j1 = Math.min(H - 1, rowOf(Math.max(ay, by) + hw) + 1)
        for (let j = j0; j <= j1; j++) {
          const py = Y(j)
          for (let i = i0; i <= i1; i++) {
            const px = X(i)
            const t = L2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * ex + (py - ay) * ey) / L2)) : 0
            const v = band(Math.hypot(px - ax - t * ex, py - ay - t * ey), q.size)
            if (v > cov[j * W + i]!) cov[j * W + i] = v
          }
        }
      }
    }
  }
  const data = new Uint8Array(W * H * 4)
  const rr = c?.r ?? 0, gg = c?.g ?? 0, bb = c?.b ?? 0
  const fade = fadeFn(p.fade), k = 255 * op
  for (let j = 0, o = 0; j < H; j++) {
    const py = Y(j)
    for (let i = 0; i < W; i++, o += 4) {
      data[o] = rr; data[o + 1] = gg; data[o + 2] = bb
      const v = cov[j * W + i]!
      if (v > 0) data[o + 3] = Math.round(k * v * fade(X(i), py))
    }
  }
  return encodePng({ width: W, height: H, data })
}
