// The intro deck as a PDF (docs/DECISIONS.md "D2"): a typst document that places what the display list says (layout.ts)
// on 13.333 × 7.5 in pages (1 px = 0.5 pt), each line `place`d at its baseline (typst breaks Hangul between any two
// syllables, so it never wraps a line here), pictures in clipped boxes offset by the crop, gradients with alpha. Every
// text goes in as a typst string literal in code mode, escaped, never as markup: "#", "$" or "[" in a company name
// stay text. The pictures are copied into the work folder (typst reads nothing outside it, `--root`).
// Round 2: outlined rects and ellipses and dashed lines are typst's own strokes (centred on the edge, as SVG and
// DrawingML draw them); each run of paths and patterns is one SVG file of the slide's size (vector.ts, the preview's
// own SVG), drawn by typst through usvg (patterns, masks and clips included); the AI's accent is its SVG as a file.
import type { Locale } from '@mycel/shared/api'
import { SLIDE_H, SLIDE_W, type DeckOut, type Fill, type Item, type Stroke } from './layout'
import { extOf } from './pptx'
import { recolorPng } from './png'
import { dashOf, lineStroke, svgDoc, vectorSvg, withXmlns } from './vector'

const pt = (px: number) => `${Math.round(px * 50) / 100}pt`
/** a typst string literal */
// eslint-disable-next-line no-control-regex
export const lit = (s: string) => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\u0000-\u001f\u007f]/g, ' ') + '"'
function col(hex: string): string {
  const v = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(hex)
  return v ? `rgb("#${v[1]}${v[2] ?? ''}")` : 'rgb("#00000000")'
}
const WEIGHT: Record<number, string> = { 400: '"regular"', 700: '"bold"', 800: '"extrabold"' }
const FONTS: Record<Locale, string> = {
  ko: '("Pretendard", "Noto Sans CJK KR", "Apple SD Gothic Neo")',
  en: '("Pretendard", "Noto Sans CJK KR")',
  id: '("Pretendard", "Noto Sans CJK KR")',
  es: '("Pretendard", "Noto Sans CJK KR")',
  ja: '("Pretendard", "Noto Sans CJK JP", "Hiragino Sans")',
}

function stops(list: { at: number; color: string }[]): string {
  const s = [...list].sort((a, b) => a.at - b.at)
  if (s[0]!.at > 0) s.unshift({ at: 0, color: s[0]!.color })
  if (s[s.length - 1]!.at < 1) s.push({ at: 1, color: s[s.length - 1]!.color })
  return s.map((x) => `(${col(x.color)}, ${Math.round(x.at * 1000) / 10}%)`).join(', ')
}
function paint(f: Fill): string {
  if ('solid' in f) return col(f.solid)
  if ('linear' in f) return `gradient.linear(${stops(f.linear.stops)}, angle: ${(((f.linear.angle - 90) % 360) + 360) % 360}deg)`
  return `gradient.radial(${stops(f.radial.stops)})`
}

/** A stroke dictionary (none when it draws nothing) */
function stroke(s: Stroke | undefined): string {
  const v = s && /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(s.color)
  if (!s || !v || v[2] === '00' || !(s.width > 0) || !Number.isFinite(s.width)) return 'none'
  const dash = dashOf(s.dash)
  return `(paint: ${col(s.color)}, thickness: ${pt(s.width)}${s.cap === 'round' ? ', cap: "round"' : ''}${s.join === 'round' ? ', join: "round"' : ''}${dash ? `, dash: (${pt(dash[0])}, ${pt(dash[1])})` : ''})`
}
/** a fill, or none for a fully transparent solid one */
const fillOf = (f: Fill) => ('solid' in f && /^#[0-9a-f]{6}00$/i.test(f.solid) ? 'none' : paint(f))

export interface TypstOptions { title: string; lang: Locale; read: (src: string) => Uint8Array | null }
export interface TypstDoc { source: string; files: [string, Uint8Array][] }

export function buildTypst(deck: DeckOut, o: TypstOptions): TypstDoc {
  const files: [string, Uint8Array][] = []
  const named = new Map<string, string>()
  const file = (key: string, bytes: Uint8Array, ext: string) => {
    let n = named.get(key)
    if (!n) { n = `img${named.size + 1}.${ext === 'jpeg' ? 'jpg' : ext}`; named.set(key, n); files.push([n, bytes]) }
    return n
  }
  const place = (x: number, y: number, body: string) => `#place(top + left, dx: ${pt(x)}, dy: ${pt(y)}, ${body})`
  /** a run of paths and patterns: one SVG file the slide's size, laid over the whole page */
  const vectors = (run: Item[], id: string): string => {
    const inner = vectorSvg(run, id)
    if (!inner) return ''
    const name = file(`svg|${inner}`, Buffer.from(svgDoc(inner, SLIDE_W, SLIDE_H), 'utf8'), 'svg')
    return place(0, 0, `image(${lit(name)}, width: ${pt(SLIDE_W)}, height: ${pt(SLIDE_H)})`)
  }
  const one = (it: Item): string => {
    if (it.t === 'rect') {
      const st = it.stroke ? `, stroke: ${stroke(it.stroke)}` : ''
      if (it.ellipse) return place(it.x, it.y, `ellipse(width: ${pt(it.w)}, height: ${pt(it.h)}, fill: ${fillOf(it.fill)}${st})`)
      return place(it.x, it.y, `rect(width: ${pt(it.w)}, height: ${pt(it.h)}, fill: ${fillOf(it.fill)}, radius: ${pt(it.radius)}${st})`)
    }
    if (it.t === 'line') {
      const st = stroke(lineStroke(it))
      if (st === 'none') return ''
      return place(it.x1, it.y1, `line(start: (0pt, 0pt), end: (${pt(it.x2 - it.x1)}, ${pt(it.y2 - it.y1)}), stroke: ${st})`)
    }
    if (it.t === 'svg') {
      const svg = withXmlns(it.svg)
      if (!/^<svg[\s>]/i.test(svg)) return ''
      const name = file(`accent|${svg}`, Buffer.from(svg, 'utf8'), 'svg')
      return place(it.x, it.y, `image(${lit(name)}, width: ${pt(it.w)}, height: ${pt(it.h)}, fit: "contain")`)
    }
    if (it.t === 'path' || it.t === 'pattern') return ''
    if (it.t === 'image') {
      let bytes = o.read(it.src)
      if (!bytes) return ''
      let ext = extOf(bytes)
      if (!ext) return ''
      if (it.recolor) { bytes = recolorPng(bytes, it.recolor); ext = 'png'; if (!bytes) return '' }
      const name = file(`${it.src}|${it.recolor ?? ''}`, bytes, ext)
      const k = it.w / it.crop.w
      return place(it.x, it.y, `box(width: ${pt(it.w)}, height: ${pt(it.h)}, clip: true, radius: ${pt(it.radius)}, place(top + left, dx: ${pt(-it.crop.x * k)}, dy: ${pt(-it.crop.y * k)}, image(${lit(name)}, width: ${pt(it.natural.width * k)}, height: ${pt(it.natural.height * k)}, fit: "stretch")))`)
    }
    const base = (it.lh - 1.193 * it.size) / 2 + 0.952 * it.size
    // each line in a box as wide as its own text (never a box that could make typst wrap it), anchored at the left,
    // the right or the middle of the layout's box
    return it.lines.map((line, i) => {
      const runs = line.map((r) => `#text(fill: ${col(r.color)}${r.size ? `, size: ${pt(r.size)}` : ''}${r.weight ? `, weight: ${WEIGHT[r.weight]}` : ''}, ${lit(r.text)})`).join('')
      const body = `box(text(size: ${pt(it.size)}, weight: ${WEIGHT[it.weight]}, tracking: ${it.tracking}em${it.tabular ? ', number-width: "tabular"' : ''})[${runs}])`
      const y = it.y + i * it.lh + base
      if (it.align === 'r') return `#place(top + right, dx: ${pt(-(SLIDE_W - it.x - it.w))}, dy: ${pt(y)}, ${body})`
      if (it.align === 'c') return `#place(top + center, dx: ${pt(it.x + it.w / 2 - SLIDE_W / 2)}, dy: ${pt(y)}, ${body})`
      return place(it.x, y, body)
    }).join('\n')
  }
  const body = (items: Item[], k: number): string[] => {
    const out: string[] = []
    let run: Item[] = [], n = 0
    const flush = () => { if (run.length) out.push(vectors(run, `s${k}v${n++}`)); run = [] }
    for (const it of items) {
      if (it.t === 'path' || it.t === 'pattern') run.push(it)
      else { flush(); out.push(one(it)) }
    }
    flush()
    return out.filter(Boolean)
  }
  const pages = deck.slides.map((s, k) => `#page(fill: ${col(s.ground)})[\n${body(s.items, k + 1).join('\n')}\n]`).join('\n')
  const source = `#set document(title: ${lit(o.title)}, author: (), date: none)
#set page(width: ${pt(SLIDE_W)}, height: ${pt(SLIDE_H)}, margin: 0pt)
#set text(font: ${FONTS[o.lang]}, lang: ${lit(o.lang)}, top-edge: "baseline", bottom-edge: "baseline", hyphenate: false)
#set par(spacing: 0pt, leading: 0pt)
${pages}
`
  return { source, files }
}
