// The intro deck's vector items (round 2: paths, patterns, outlined shapes, dashed lines) as SVG, shared by the preview
// (an inline <svg> layer per run of them) and the PDF (an SVG file per run, typst draws it through usvg), so both
// draw the same geometry. Nothing reaches the markup that was not read back as a number or as a "#rrggbb(aa)" colour:
// a path's `d` is parsed (absolute M, L, C, Z only) and written again, colours are checked, ids are made here.
import type { Item, LineItem, PathItem, RectItem, Stroke } from './layout'
import { num, patternSvg, rgbOf } from './grounds'

export type PathCmd = ['M', number, number] | ['L', number, number] | ['C', number, number, number, number, number, number] | ['Z']
const ARGS = { M: 2, L: 2, C: 6, Z: 0 } as const
const MAX_CMDS = 20_000
const LIMIT = 100_000

/** A path's `d` read as absolute M, L, C and Z (repeated coordinates after a command repeat it, after M as L); null
 * when anything else is in it, a number is not finite or out of range, or it does not start with M. */
export function parsePath(d: string): PathCmd[] | null {
  if (typeof d !== 'string' || d.length > 400_000) return null
  const toks = d.match(/[A-Za-z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?|[^\s,]/g) ?? []
  const out: PathCmd[] = []
  let cmd: keyof typeof ARGS | null = null
  let i = 0
  while (i < toks.length) {
    const t = toks[i]!
    if (/^[A-Za-z]$/.test(t)) {
      if (!(t in ARGS)) return null
      cmd = t as keyof typeof ARGS
      i++
      if (cmd === 'Z') { if (!out.length) return null; out.push(['Z']); cmd = null; continue }
    } else if (!cmd) return null
    const n = ARGS[cmd!]
    const vals: number[] = []
    for (let k = 0; k < n; k++) {
      const v = Number(toks[i + k])
      if (toks[i + k] === undefined || /^[A-Za-z]$/.test(toks[i + k]!) || !Number.isFinite(v) || Math.abs(v) > LIMIT) return null
      vals.push(v)
    }
    i += n
    if (!out.length && cmd !== 'M') return null
    out.push([cmd!, ...vals] as PathCmd)
    if (cmd === 'M') cmd = 'L'
    if (out.length > MAX_CMDS) return null
  }
  return out.length && out.some((c) => c[0] !== 'M' && c[0] !== 'Z') ? out : null
}

/** The commands as path data again (2 decimals), optionally moved by (dx, dy) and scaled by k. */
export function pathD(cmds: PathCmd[], dx = 0, dy = 0, k = 1): string {
  return cmds.map((c) => c[0] + c.slice(1).map((v, i) => num(((v as number) + (i % 2 ? dy : dx)) * k)).join(' ')).join('')
}

/** The box of every point a path names (its control points too: the curve stays inside it). */
export function pathBox(cmds: PathCmd[]): { x: number; y: number; w: number; h: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const c of cmds) for (let i = 1; i + 1 < c.length; i += 2) {
    const px = c[i] as number, py = c[i + 1] as number
    if (px < x0) x0 = px
    if (px > x1) x1 = px
    if (py < y0) y0 = py
    if (py > y1) y1 = py
  }
  if (!Number.isFinite(x0)) return { x: 0, y: 0, w: 0, h: 0 }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

const op = (a: number) => String(Math.round(a * 1000) / 1000)
/** fill="…" (+ fill-opacity) for a "#rrggbb(aa)" colour; none for anything else or nothing */
export function fillAttrs(color: string | undefined): string {
  const c = color ? rgbOf(color) : null
  if (!c || c.a <= 0) return 'fill="none"'
  return `fill="${c.hex}"${c.a < 1 ? ` fill-opacity="${op(c.a)}"` : ''}`
}
/** A stroke's attributes (empty when it draws nothing) */
export function strokeAttrs(s: Stroke | undefined): string {
  const c = s ? rgbOf(s.color) : null
  if (!s || !c || c.a <= 0 || !(s.width > 0) || !Number.isFinite(s.width)) return ''
  let a = ` stroke="${c.hex}"${c.a < 1 ? ` stroke-opacity="${op(c.a)}"` : ''} stroke-width="${num(s.width)}"`
  if (s.cap === 'round') a += ' stroke-linecap="round"'
  if (s.join === 'round') a += ' stroke-linejoin="round"'
  const dash = dashOf(s.dash)
  if (dash) a += ` stroke-dasharray="${num(dash[0])} ${num(dash[1])}"`
  return a
}
/** a dash [on, off] that draws something (both finite, not negative, not both 0) */
export function dashOf(d: [number, number] | undefined): [number, number] | null {
  if (!Array.isArray(d) || d.length !== 2) return null
  const [a, b] = d
  if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b < 0 || a + b <= 0) return null
  return [a, b]
}
/** A line's stroke as a Stroke */
export const lineStroke = (l: LineItem): Stroke => ({ color: l.color, width: l.width, dash: l.dash, cap: l.cap })

/** Does the preview draw this item in an SVG layer? Paths, patterns, outlined rects and ellipses, and lines that are
 * dashed, capped or slanted (a plain level or upright line stays a box). */
export function svgInHtml(it: Item): boolean {
  if (it.t === 'path' || it.t === 'pattern') return true
  if (it.t === 'rect') return !!it.stroke
  if (it.t === 'line') return !!dashOf(it.dash) || !!it.cap || (it.x1 !== it.x2 && it.y1 !== it.y2)
  return false
}

function pathSvg(it: PathItem): string {
  const cmds = parsePath(it.d)
  if (!cmds) return ''
  const fill = fillAttrs(it.fill), stroke = strokeAttrs(it.stroke)
  if (fill === 'fill="none"' && !stroke) return ''
  // filled even-odd, as PowerPoint fills a custom shape with several outlines
  return `<path d="${pathD(cmds)}" ${fill}${fill === 'fill="none"' ? '' : ' fill-rule="evenodd"'}${stroke}/>`
}
/** an outlined rect or ellipse (its fill only when solid: a gradient is drawn by the caller underneath) */
function rectSvg(it: RectItem): string {
  const fill = 'solid' in it.fill ? fillAttrs(it.fill.solid) : 'fill="none"'
  const stroke = strokeAttrs(it.stroke)
  if (fill === 'fill="none"' && !stroke) return ''
  if (it.ellipse) return `<ellipse cx="${num(it.x + it.w / 2)}" cy="${num(it.y + it.h / 2)}" rx="${num(it.w / 2)}" ry="${num(it.h / 2)}" ${fill}${stroke}/>`
  const r = Math.max(0, Math.min(it.radius || 0, it.w / 2, it.h / 2))
  return `<rect x="${num(it.x)}" y="${num(it.y)}" width="${num(it.w)}" height="${num(it.h)}"${r ? ` rx="${num(r)}"` : ''} ${fill}${stroke}/>`
}
function lineSvg(it: LineItem): string {
  const stroke = strokeAttrs(lineStroke(it))
  return stroke ? `<line x1="${num(it.x1)}" y1="${num(it.y1)}" x2="${num(it.x2)}" y2="${num(it.y2)}"${stroke}/>` : ''
}

/** A run of vector items as one SVG fragment in slide coordinates; `id` prefixes every id inside (unique per page). */
export function vectorSvg(items: Item[], id: string): string {
  const k = id.replace(/[^A-Za-z0-9_-]/g, '')
  return items.map((it, i) => {
    if (it.t === 'path') return pathSvg(it)
    if (it.t === 'pattern') return patternSvg(it, `${k}p${i}`)
    if (it.t === 'rect') return rectSvg(it)
    if (it.t === 'line') return lineSvg(it)
    return ''
  }).join('')
}

/** A whole SVG document of a run (the PDF's file), the slide's size. */
export const svgDoc = (inner: string, w = 1920, h = 1080) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${inner}</svg>`

/** The accent's SVG with the SVG namespace on its root (an <img> and usvg draw nothing without it). */
export function withXmlns(svg: string): string {
  const s = typeof svg === 'string' ? svg.trim() : ''
  if (!/^<svg[\s>]/i.test(s)) return s
  return /^<svg[^>]*\sxmlns\s*=\s*["']http:\/\/www\.w3\.org\/2000\/svg["']/i.test(s) ? s : s.replace(/^<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"')
}
