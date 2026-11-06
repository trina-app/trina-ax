// The intro deck as a PDF (docs/DECISIONS.md "D2"): a typst document that places what the display list says (layout.ts)
// on 13.333 × 7.5 in pages (1 px = 0.5 pt), each line `place`d at its baseline (typst breaks Hangul between any two
// syllables, so it never wraps a line here), pictures in clipped boxes offset by the crop, gradients with alpha. Every
// text goes in as a typst string literal in code mode, escaped, never as markup: "#", "$" or "[" in a company name
// stay text. The pictures are copied into the work folder (typst reads nothing outside it, `--root`).
import type { Locale } from '@mycel/shared/api'
import { SLIDE_H, SLIDE_W, type DeckOut, type Fill, type Item } from './layout'
import { extOf } from './pptx'
import { recolorPng } from './png'

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
  const one = (it: Item): string => {
    if (it.t === 'rect') {
      if (it.ellipse) return place(it.x, it.y, `ellipse(width: ${pt(it.w)}, height: ${pt(it.h)}, fill: ${paint(it.fill)})`)
      return place(it.x, it.y, `rect(width: ${pt(it.w)}, height: ${pt(it.h)}, fill: ${paint(it.fill)}, radius: ${pt(it.radius)})`)
    }
    if (it.t === 'line') {
      return place(it.x1, it.y1, `line(start: (0pt, 0pt), end: (${pt(it.x2 - it.x1)}, ${pt(it.y2 - it.y1)}), stroke: (paint: ${col(it.color)}, thickness: ${pt(it.width)}))`)
    }
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
  const pages = deck.slides.map((s) => `#page(fill: ${col(s.ground)})[\n${s.items.map(one).filter(Boolean).join('\n')}\n]`).join('\n')
  const source = `#set document(title: ${lit(o.title)}, author: (), date: none)
#set page(width: ${pt(SLIDE_W)}, height: ${pt(SLIDE_H)}, margin: 0pt)
#set text(font: ${FONTS[o.lang]}, lang: ${lit(o.lang)}, top-edge: "baseline", bottom-edge: "baseline", hyphenate: false)
#set par(spacing: 0pt, leading: 0pt)
${pages}
`
  return { source, files }
}
