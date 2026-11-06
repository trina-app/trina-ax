// Onboarding D2, round 2 (docs/DECISIONS.md "D2"): the drawn grounds (grounds.ts: dots, lines and contours from a
// seed) and the new display-list items (paths, patterns, outlined shapes, dashed lines, the AI's accent) drawn alike by
// the preview (inline SVG layers, the accent as an <img>), the PDF (typst: native strokes, SVG files for paths and
// patterns) and the PowerPoint file (custGeom shapes and groups, the grounds and the accent as pictures).
// Every company here is made up.
import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { WORK } from '../lib/env'
import { which } from '../../server/src/config'
import { readZip } from '../../server/src/files/zip-write'
import { pretendardDir } from '../../server/src/intro-deck/files'
import { contourLines, contourSegments, fadeAt, makeNoise, patternPng, patternSvg, rng, seedOf } from '../../server/src/intro-deck/grounds'
import { deckHtml, slideMarkup } from '../../server/src/intro-deck/html'
import type { DeckOut, Item, PatternItem, SlideOut } from '../../server/src/intro-deck/layout'
import { buildPptx } from '../../server/src/intro-deck/pptx'
import { decodePng, encodePng } from '../../server/src/intro-deck/png'
import { buildTypst } from '../../server/src/intro-deck/typst'
import { parsePath } from '../../server/src/intro-deck/vector'

setDefaultTimeout(60_000)

// ── a slide with every new kind of item (a hub, its grounds, a dotted axis, an icon, an accent) ──────────────────
const K = 0.5523
const circleD = (cx: number, cy: number, r: number) =>
  `M${cx + r} ${cy}C${cx + r} ${cy + r * K} ${cx + r * K} ${cy + r} ${cx} ${cy + r}C${cx - r * K} ${cy + r} ${cx - r} ${cy + r * K} ${cx - r} ${cy}`
  + `C${cx - r} ${cy - r * K} ${cx - r * K} ${cy - r} ${cx} ${cy - r}C${cx + r * K} ${cy - r} ${cx + r} ${cy - r * K} ${cx + r} ${cy}Z`
const INK = '#0b100d', TEXT = '#ecf3ed', MARK = '#37ee6a', LINE = '#ecf3ed3d'
const ACCENT = '<svg viewBox="0 0 800 800"><circle cx="400" cy="400" r="300" fill="none" stroke="#37ee6a" stroke-width="6"/><circle cx="400" cy="400" r="120" fill="#ecf3ed"/></svg>'
const HOSTILE = '"/><script>alert(1)</script>'
const CX = 1400, CY = 560
const SAT = [[CX, CY - 300], [CX + 300, CY], [CX, CY + 300], [CX - 300, CY]] as const

function hubItems(): Item[] {
  return [
    { t: 'pattern', kind: 'contours', x: 900, y: 0, w: 1020, h: 1080, color: MARK, opacity: 0.2, step: 0, size: 1.5, seed: seedOf('team-acme', 'Acme Robotics deck'), levels: 14, scale: 0.0019, fade: { radial: { cx: CX, cy: CY, r: 640, inner: 1, outer: 0 } } },
    { t: 'pattern', kind: 'dots', x: 0, y: 0, w: 1920, h: 1080, color: TEXT, opacity: 0.16, step: 30, size: 2, fade: { linear: { x1: 760, y1: 0, x2: 1100, y2: 0, from: 0, to: 1 } } },
    { t: 'text', x: 120, y: 360, w: 580, size: 72, weight: 800, tracking: -0.02, lh: 86, align: 'l', lines: [[{ text: 'Acme Robotics', color: TEXT }], [{ text: 'connects every line', color: MARK }]], role: 'title' },
    // connectors under the satellites
    ...SAT.map(([x, y]): Item => ({ t: 'path', d: `M${CX} ${CY}L${x} ${y}`, stroke: { color: '#ecf3ed8f', width: 3, cap: 'round', join: 'round' }, role: 'connector' })),
    ...SAT.map(([x, y]): Item => ({ t: 'rect', x: x - 66, y: y - 66, w: 132, h: 132, fill: { solid: INK }, radius: 0, ellipse: true, stroke: { color: '#ecf3ed8f', width: 3 } })),
    // the key: a halo, the disc (a path), its label
    { t: 'rect', x: CX - 150, y: CY - 150, w: 300, h: 300, fill: { solid: '#37ee6a2e' }, radius: 0, ellipse: true },
    { t: 'path', d: circleD(CX, CY, 124), fill: MARK, role: 'key' },
    { t: 'text', x: CX - 120, y: CY - 22, w: 240, size: 36, weight: 800, tracking: 0, lh: 44, align: 'c', lines: [[{ text: 'Acme Hub', color: '#04180c' }]], role: 'label' },
    // an icon in the first satellite: three strokes, one group
    { t: 'path', d: `M${CX - 20} ${CY - 320}L${CX + 20} ${CY - 320}`, stroke: { color: TEXT, width: 3.5, cap: 'round', join: 'round' }, group: 'icon1', role: 'icon' },
    { t: 'path', d: `M${CX - 20} ${CY - 300}L${CX + 20} ${CY - 300}`, stroke: { color: TEXT, width: 3.5, cap: 'round', join: 'round' }, group: 'icon1', role: 'icon' },
    { t: 'path', d: `M${CX - 20} ${CY - 280}C${CX - 10} ${CY - 270} ${CX + 10} ${CY - 270} ${CX + 20} ${CY - 280}`, stroke: { color: TEXT, width: 3.5, cap: 'round', join: 'round' }, group: 'icon1', role: 'icon' },
    // a chevron with a translucent fill, a dotted axis, a solid hairline, a dashed outline on a gradient panel
    { t: 'path', d: 'M120 760L420 760L460 828L420 896L120 896L160 828Z', fill: '#37ee6acc', role: 'chevron' },
    { t: 'line', x1: 120, y1: 960, x2: 820, y2: 960, color: TEXT, width: 2, dash: [2, 12], cap: 'round' },
    { t: 'line', x1: 520, y1: 760, x2: 820, y2: 896, color: LINE, width: 2 },
    { t: 'rect', x: 500, y: 600, w: 320, h: 120, fill: { linear: { angle: 90, stops: [{ at: 0, color: '#37ee6a00' }, { at: 1, color: '#37ee6a40' }] } }, radius: 16, stroke: { color: MARK, width: 2, dash: [8, 6] } },
    { t: 'svg', x: 1640, y: 60, w: 220, h: 220, svg: ACCENT, role: 'accent' },
  ]
}
const slideOf = (items: Item[], label = 'Acme Robotics'): SlideOut => ({ kind: 'cover', variant: 'test', ground: INK, dark: true, label, items, notes: [] })
const deckOf = (...slides: SlideOut[]): DeckOut => ({ look: {} as DeckOut['look'], slides, problems: [], typeOnly: [] })
/** a slide that tries to smuggle markup in through every new field */
function hostileSlide(): SlideOut {
  return slideOf([
    { t: 'path', d: 'M0 0L10 10' + HOSTILE, fill: MARK },
    { t: 'path', d: 'M0 0L100 100Z', fill: 'red" onload="alert(1)' },
    { t: 'path', d: 'M0 0L100 100', stroke: { color: 'url(javascript:alert(1))', width: 3 } },
    { t: 'path', d: 'M0 0L100 100', stroke: { color: '#ffffff', width: 3, dash: [Number.NaN, 4] }, fill: '#123456;background:url(x)' },
    { t: 'pattern', kind: 'dots', x: 0, y: 0, w: 400, h: 400, color: 'expression(alert(1))', opacity: 1, step: 30, size: 2 },
    { t: 'rect', x: 0, y: 0, w: 100, h: 100, fill: { solid: '#000000' }, radius: 0, stroke: { color: '#fff" onclick="alert(1)', width: 2 } },
    { t: 'line', x1: 0, y1: 0, x2: 50, y2: 80, color: 'javascript:alert(1)', width: 2, dash: [2, 2] },
  ], 'Hostile')
}

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────────────────────
interface XNode { name: string; attrs: Record<string, string>; kids: XNode[] }
interface Sax {
  on(e: 'error', f: (e: Error) => void): void
  on(e: 'opentag', f: (t: { name: string; attributes: Record<string, string | { value: string }> }) => void): void
  on(e: 'closetag', f: (t: string) => void): void
  write(s: string): { close(): void }
}
const { SaxesParser } = createRequire(path.join(import.meta.dir, '../../server/package.json'))('saxes') as { SaxesParser: new (o: { xmlns: boolean }) => Sax }
function parseXml(xml: string, where: string): XNode {
  const p = new SaxesParser({ xmlns: false })
  const root: XNode = { name: '#doc', attrs: {}, kids: [] }
  const stack = [root]
  p.on('error', (e) => { throw new Error(`${where}: ${e.message}`) })
  p.on('opentag', (t) => {
    const n: XNode = { name: t.name, attrs: Object.fromEntries(Object.entries(t.attributes).map(([k, a]) => [k, typeof a === 'string' ? a : a.value])), kids: [] }
    stack.at(-1)!.kids.push(n)
    stack.push(n)
  })
  p.on('closetag', () => { stack.pop() })
  p.write(xml).close()
  return root
}
const all = (n: XNode, name: string): XNode[] => [...(n.name === name ? [n] : []), ...n.kids.flatMap((c) => all(c, name))]
const alphaAt = (png: { width: number; data: Uint8Array }, x: number, y: number) => png.data[(y * png.width + x) * 4 + 3]!
/** a PNG of one colour (the accent's stand-in: another stream makes the real one with typst) */
const solidPng = (w: number, h: number) => encodePng({ width: w, height: h, data: new Uint8Array(w * h * 4).fill(200) })

// ── the grounds ──────────────────────────────────────────────────────────────────────────────────────────────────
describe('the drawn grounds (grounds.ts)', () => {
  const contours = (seed: number, over: Partial<PatternItem> = {}): PatternItem => ({ t: 'pattern', kind: 'contours', x: 300, y: 120, w: 900, h: 600, color: '#1b6e3a', opacity: 0.8, step: 0, size: 1.5, seed, levels: 12, scale: 0.0022, ...over })

  test('seeds: a stable 32-bit hash of the parts; the noise and the random numbers follow the seed', () => {
    expect(seedOf('team-1', 'Acme deck')).toBe(seedOf('team-1', 'Acme deck'))
    // pinned: a rebuild of a stored deck must draw the same ground in a later version
    expect(seedOf('team-1', 'Acme deck')).toBe(630353771)
    expect(seedOf('team-1', 'Acme deck')).not.toBe(seedOf('team-1Acme deck'))
    expect(seedOf('a', 'b')).not.toBe(seedOf('b', 'a'))
    expect(seedOf('한글', '소개서')).toBeLessThan(2 ** 32)
    const a = rng(7), b = rng(7)
    expect([a(), a(), a()]).toEqual([b(), b(), b()])
    expect(rng(7)()).not.toBe(rng(8)())
    expect(makeNoise(3)(1.3, 2.7)).toBe(makeNoise(3)(1.3, 2.7))
    expect(makeNoise(3)(1.3, 2.7)).not.toBe(makeNoise(4)(1.3, 2.7))
  })

  test('the same seed gives the same SVG and the same PNG bytes; another seed another field', () => {
    const p = contours(11)
    expect(patternSvg(p, 'g')).toBe(patternSvg(contours(11), 'g'))
    expect(Buffer.from(patternPng(p)).equals(Buffer.from(patternPng(contours(11))))).toBe(true)
    expect(patternSvg(contours(12), 'g')).not.toBe(patternSvg(p, 'g'))
    expect(Buffer.from(patternPng(contours(12))).equals(Buffer.from(patternPng(p)))).toBe(false)
    const dots: PatternItem = { t: 'pattern', kind: 'dots', x: 0, y: 0, w: 640, h: 360, color: '#ffffff', opacity: 0.16, step: 30, size: 2 }
    expect(Buffer.from(patternPng(dots)).equals(Buffer.from(patternPng({ ...dots })))).toBe(true)
  })

  test('the fade is exactly zero at and beyond its zero edge (the type sits there): linear and radial, in the picture', () => {
    // a title box at x 120…552; the pattern's zero edge 48 px right of it, full strength from 1100
    const lin: PatternItem = { t: 'pattern', kind: 'dots', x: 0, y: 0, w: 1920, h: 1080, color: '#ecf3ed', opacity: 0.9, step: 30, size: 2, fade: { linear: { x1: 600, y1: 0, x2: 1100, y2: 0, from: 0, to: 1 } } }
    const a = decodePng(patternPng(lin))!
    expect([a.width, a.height]).toEqual([1920, 1080])
    let under = 0, past = 0
    for (let y = 0; y < 1080; y++) for (let x = 0; x < 1920; x++) {
      const v = alphaAt(a, x, y)
      if (x <= 600) under += v
      else if (x >= 1100 && v === Math.round(255 * 0.9)) past++
    }
    expect(under).toBe(0)
    expect(past).toBeGreaterThan(100)
    expect(fadeAt(lin.fade, 600, 0)).toBe(0)
    expect(fadeAt(lin.fade, -50, 900)).toBe(0)
    expect(fadeAt(lin.fade, 850, 10)).toBeCloseTo(0.5, 6)
    expect(fadeAt(lin.fade, 5000, 10)).toBe(1)
    // the same the other way round (strong at the left, zero toward the type on the right)
    const rev = { ...lin, fade: { linear: { x1: 900, y1: 0, x2: 1300, y2: 0, from: 1, to: 0 } } }
    const r = decodePng(patternPng(rev))!
    let right = 0
    for (let y = 0; y < 1080; y += 3) for (let x = 1300; x < 1920; x++) right += alphaAt(r, x, y)
    expect(right).toBe(0)
    // radial: zero at r and beyond
    const rad = contours(5, { x: 0, y: 0, w: 1920, h: 1080, fade: { radial: { cx: 1400, cy: 540, r: 500, inner: 1, outer: 0 } } })
    const c = decodePng(patternPng(rad))!
    let outside = 0, inside = 0
    for (let y = 0; y < 1080; y++) for (let x = 0; x < 1920; x++) {
      const d = Math.hypot(x + 0.5 - 1400, y + 0.5 - 540)
      if (d >= 500) outside += alphaAt(c, x, y)
      else inside += alphaAt(c, x, y)
    }
    expect(outside).toBe(0)
    expect(inside).toBeGreaterThan(0)
    // the SVG says the same: stops at 0 where the fade is 0, a mask on the pattern
    const svg = patternSvg(rad, 'f')
    expect(svg).toContain('<radialGradient id="fg" gradientUnits="userSpaceOnUse" cx="1400" cy="540" r="500"><stop offset="0" stop-color="#fff" stop-opacity="1"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>')
    expect(svg).toContain('mask="url(#fm)"')
  })

  test('dots: a disc of radius `size` every `step` from step/2 inside the box, nothing between', () => {
    const p: PatternItem = { t: 'pattern', kind: 'dots', x: 10, y: 20, w: 300, h: 200, color: '#000000', opacity: 1, step: 30, size: 2 }
    const a = decodePng(patternPng(p))!
    expect([a.width, a.height]).toEqual([300, 200])
    for (let j = 0; j < 6; j++) for (let i = 0; i < 10; i++) {
      // the disc's centre falls between four pixels (15, 15 from the box's corner): all four nearly full
      expect(alphaAt(a, 15 + 30 * i, 15 + 30 * j)).toBeGreaterThan(240)
      expect(alphaAt(a, 30 * i, 30 * j)).toBe(0)
      expect(alphaAt(a, 15 + 30 * i + 5, 15 + 30 * j)).toBe(0)
    }
    const svg = patternSvg(p, 'd')
    expect(svg).toContain('<pattern id="dp" patternUnits="userSpaceOnUse" x="10" y="20" width="30" height="30"><circle cx="15" cy="15" r="2" fill="#000000"/></pattern>')
    expect(svg).toContain('<rect x="10" y="20" width="300" height="200" fill="url(#dp)"/>')
  })

  test('lines: `size` wide, `step` apart from step/2; angle 0 upright, 90 level', () => {
    const p: PatternItem = { t: 'pattern', kind: 'lines', x: 0, y: 0, w: 230, h: 100, color: '#000000', opacity: 1, step: 23, size: 1.5, angle: 0 }
    const a = decodePng(patternPng(p))!
    // the line at 11.5 + 23k covers its pixel fully and a quarter of each neighbour
    for (let k = 0; k < 10; k++) {
      expect(alphaAt(a, 11 + 23 * k, 50)).toBe(255)
      expect(alphaAt(a, 10 + 23 * k, 50)).toBe(64)
      expect(alphaAt(a, 12 + 23 * k, 50)).toBe(64)
      expect(alphaAt(a, 23 * k + 1, 50)).toBe(0)
    }
    const level = decodePng(patternPng({ ...p, angle: 90, w: 100, h: 230 }))!
    for (let k = 0; k < 10; k++) {
      expect(alphaAt(level, 50, 11 + 23 * k)).toBe(255)
      expect(alphaAt(level, 50, 23 * k + 1)).toBe(0)
    }
    const svg = patternSvg(p, 'l')
    const xs = [...svg.matchAll(/M([\d.]+) [-\d.]+L([\d.]+) /g)].map((m) => [Number(m[1]), Number(m[2])])
    expect(xs.map((x) => x[0])).toEqual(Array.from({ length: 10 }, (_, k) => 11.5 + 23 * k))
    expect(xs.every((x) => x[0] === x[1])).toBe(true)
    expect(svg).toContain('stroke-width="1.5"')
    expect(svg).toContain('clip-path="url(#lc)"')
  })

  test('contours: every isoline inside the box, chained into polylines, cut to the box, as many paths as levels', () => {
    const p = contours(21, { levels: 14 })
    const segs = contourSegments(p)
    expect(segs).toHaveLength(14)
    const lines = contourLines(p)
    for (const level of [...segs, ...lines.flatMap((l) => l.map((pl) => pl.pts))]) {
      for (let i = 0; i < level.length; i += 2) {
        expect(level[i]!).toBeGreaterThanOrEqual(p.x - 0.05)
        expect(level[i]!).toBeLessThanOrEqual(p.x + p.w + 0.05)
        expect(level[i + 1]!).toBeGreaterThanOrEqual(p.y - 0.05)
        expect(level[i + 1]!).toBeLessThanOrEqual(p.y + p.h + 0.05)
      }
    }
    // chaining: far fewer polylines than segments, and the same points
    const nSegs = segs.reduce((n, l) => n + l.length / 4, 0), nLines = lines.reduce((n, l) => n + l.length, 0)
    expect(nSegs).toBeGreaterThan(300)
    expect(nLines * 5).toBeLessThan(nSegs)
    const svg = patternSvg(p, 'c')
    expect(svg.match(/<path /g)).toHaveLength(14)
    expect(svg).toContain('stroke-linecap="round" stroke-linejoin="round"')
    expect(svg).toContain('<clipPath id="cc"><rect x="300" y="120" width="900" height="600"/></clipPath>')
    // the SVG's points (absolute moves, relative lines) land on the polylines' points
    const d = /<path d="([^"]+)"/.exec(svg)![1]!
    const first = lines[0]![0]!.pts
    const m = /^M([-\d.]+) ([-\d.]+)l([-\d.]+)(-?[\d.]+)?/.exec(d.replace(/ (-)/g, '$1'))!
    expect([Number(m[1]), Number(m[2])]).toEqual([first[0]!, first[1]!])
  })

  test('the picture of a full-slide contour field is made in well under 300 ms here (and under a second anywhere)', () => {
    const p = contours(99, { x: 0, y: 0, w: 1920, h: 1080, levels: 16, fade: { linear: { x1: 700, y1: 0, x2: 1300, y2: 0, from: 0, to: 1 } } })
    patternPng({ ...p, w: 200, h: 100 })
    const t0 = performance.now()
    const png = patternPng(p)
    const ms = performance.now() - t0
    expect(decodePng(png)!.width).toBe(1920)
    expect(ms).toBeLessThan(1000)
  })
})

// ── the preview ──────────────────────────────────────────────────────────────────────────────────────────────────
describe('the preview draws the new items (html.ts)', () => {
  const deck = deckOf(slideOf(hubItems()), slideOf(hubItems(), 'Second'), hostileSlide())
  const html = deckHtml(deck, { fontCss: '/vendor/fonts/pretendard.css', lang: 'en', title: 'Acme Robotics deck' })

  test('runs of vector items are one inline SVG layer each, in the display list\'s order with the text and the accent', () => {
    const one = slideMarkup(slideOf(hubItems()), 'x1')
    // the patterns; the title; the connectors and satellites; the halo (a plain box); the disc; its label; the icon,
    // chevron, axis and slanted line; the panel's gradient (a box) and its outline; the accent
    const order = [...one.matchAll(/<svg class="v"|<p class="t"|<i class="r"|<img class="a"/g)].map((m) => m[0])
    expect(order).toEqual(['<svg class="v"', '<p class="t"', '<p class="t"', '<svg class="v"', '<i class="r"', '<svg class="v"', '<p class="t"', '<svg class="v"', '<i class="r"', '<svg class="v"', '<img class="a"'])
    const layers = [...one.matchAll(/<svg class="v"[^>]*>[\s\S]*?<\/svg>/g)].map((m) => m[0])
    expect(layers).toHaveLength(5)
    for (const l of layers) {
      expect(l).toStartWith(`<svg class="v" viewBox="0 0 1920 1080" preserveAspectRatio="none" aria-hidden="true" focusable="false">`)
      // well formed (as XML) and only SVG drawing elements in it
      const x = parseXml(l, 'layer')
      const names = new Set(all(x, '#doc')[0]!.kids.flatMap(function walk(n: XNode): string[] { return [n.name, ...n.kids.flatMap(walk)] }))
      for (const n of names) expect(['svg', 'defs', 'clipPath', 'rect', 'mask', 'radialGradient', 'linearGradient', 'stop', 'pattern', 'circle', 'g', 'path', 'ellipse', 'line']).toContain(n)
    }
    // the connectors: round caps and joins; the key disc filled even-odd; the satellites as outlined ellipses on the ground
    expect(layers[1]).toContain(`<path d="M${CX} ${CY}L${CX} ${CY - 300}" fill="none" stroke="#ecf3ed" stroke-opacity="0.561" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`)
    expect(layers[1]).toContain(`<ellipse cx="${CX}" cy="${CY - 300}" rx="66" ry="66" fill="${INK}" stroke="#ecf3ed" stroke-opacity="0.561" stroke-width="3"/>`)
    expect(layers[2]).toMatch(new RegExp(`^<svg[^>]*><path d="M${CX + 124} ${CY}C[^"]+Z" fill="#37ee6a" fill-rule="evenodd"/></svg>$`))
    expect(layers[3]).toContain('<line x1="120" y1="960" x2="820" y2="960" stroke="#ecf3ed" stroke-width="2" stroke-linecap="round" stroke-dasharray="2 12"/>')
    expect(layers[3]).toContain('<line x1="520" y1="760" x2="820" y2="896" stroke="#ecf3ed" stroke-opacity="0.239" stroke-width="2"/>')
    expect(layers[3]).toContain('fill="#37ee6a" fill-opacity="0.8" fill-rule="evenodd"')
    expect(layers[4]).toContain('<rect x="500" y="600" width="320" height="120" rx="16" fill="none" stroke="#37ee6a" stroke-width="2" stroke-dasharray="8 6"/>')
  })

  test('the accent is an <img> of its SVG (a data: address with the SVG namespace), never markup in the page', () => {
    const imgs = [...html.matchAll(/<img class="a" alt="" src="data:image\/svg\+xml;base64,([A-Za-z0-9+/=]+)" style="([^"]*)">/g)]
    expect(imgs).toHaveLength(2)
    const svg = Buffer.from(imgs[0]![1]!, 'base64').toString('utf8')
    expect(svg).toBe(ACCENT.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"'))
    expect(imgs[0]![2]).toBe('left:calc(1640*var(--u));top:calc(60*var(--u));width:calc(220*var(--u));height:calc(220*var(--u))')
    // the accent's own circles are nowhere in the page as markup
    expect(html).not.toContain('r="300"')
  })

  test('the page is well formed; ids are unique and every reference finds its id; no hostile colour or path reaches it', () => {
    // tags balance (void elements aside; SVG's self-closed ones close themselves)
    const VOID = new Set(['meta', 'link', 'img', 'br', 'input'])
    const stack: string[] = []
    for (const m of html.replace(/<script>[\s\S]*?<\/script>/, '').matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?(\/?)>/g)) {
      const [, close, name, self] = m
      if (close) expect(stack.pop(), `</${name}>`).toBe(name)
      else if (!self && !VOID.has(name!.toLowerCase())) stack.push(name!)
    }
    expect(stack).toEqual(['html', 'body'].filter(() => false))
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]!)
    expect(ids.length).toBeGreaterThan(6)
    expect(new Set(ids).size).toBe(ids.length)
    const body = html.replace(/<script>[\s\S]*?<\/script>/, '')
    for (const m of body.matchAll(/url\(#([^)]+)\)/g)) expect(ids).toContain(m[1]!)
    // the hostile slide: its bad path and its bad colours drop out; nothing of them is in the page
    expect(html).not.toContain('alert(1)')
    expect(html).not.toContain('javascript')
    expect(html).not.toContain('expression(')
    expect(html).not.toContain('onload')
    expect(html).not.toContain('onclick')
    expect(html).not.toContain('url(x)')
    expect(html).not.toContain('NaN')
    const hostile = slideMarkup(hostileSlide(), 'h')
    // what is left: the rect's fill (its outline dropped), the dashed path's stroke without its dash
    expect(hostile).toContain('<rect x="0" y="0" width="100" height="100" fill="#000000"/>')
    expect(hostile).toContain('<path d="M0 0L100 100" fill="none" stroke="#ffffff" stroke-width="3"/>')
    expect(hostile.match(/<path /g)).toHaveLength(1)
    // a path is read back as numbers: anything but M, L, C, Z is refused
    expect(parsePath('M0 0L10 10' + HOSTILE)).toBeNull()
    expect(parsePath('M0 0 A 5 5 0 0 1 10 10')).toBeNull()
    expect(parsePath('L0 0')).toBeNull()
    expect(parsePath('M1e400 0L1 1')).toBeNull()
    expect(parsePath('M0,0 10,10 C1 2 3 4 5 6Z')).toEqual([['M', 0, 0], ['L', 10, 10], ['C', 1, 2, 3, 4, 5, 6], ['Z']])
  })

  test('slides are prefixed apart: the same slide twice has no id in common', () => {
    const a = slideMarkup(slideOf(hubItems()), 's1'), b = slideMarkup(slideOf(hubItems()), 's2')
    const ids = (s: string) => new Set([...s.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]!))
    const ia = ids(a), ib = ids(b)
    expect(ia.size).toBeGreaterThan(0)
    expect([...ia].filter((x) => ib.has(x))).toEqual([])
  })
})

// ── the PowerPoint file ──────────────────────────────────────────────────────────────────────────────────────────
describe('the PowerPoint file draws the new items (pptx.ts)', () => {
  const deck = deckOf(slideOf(hubItems()), hostileSlide())
  const calls: [number, number][] = []
  const bytes = buildPptx(deck, { title: 'Acme Robotics deck', lang: 'en', read: () => null, fonts: null, created: '2026-11-06T09:00:00.000Z', svgPng: (svg, w, h) => { calls.push([w, h]); expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"'); return solidPng(440, 440) } })
  const zip = readZip(bytes)
  const part = (n: string) => Buffer.from(zip.find((e) => e.name === n)!.data).toString('utf8')
  const slide = parseXml(part('ppt/slides/slide1.xml'), 'slide1')
  const num = (v: string | undefined) => Number(v)

  test('every XML part is well formed; no hostile colour or path reaches any part', () => {
    for (const e of zip) if (/\.(xml|rels)$/.test(e.name)) parseXml(Buffer.from(e.data).toString('utf8'), e.name)
    const text = zip.filter((e) => /\.xml$/.test(e.name)).map((e) => Buffer.from(e.data).toString('utf8')).join('')
    for (const bad of ['alert', 'javascript', 'expression(', 'onload', 'url(x)', 'NaN']) expect(text).not.toContain(bad)
    // the hostile slide keeps only what is sound: one path (its stroke, no dash), the rect without its outline
    const h = parseXml(part('ppt/slides/slide2.xml'), 'slide2')
    expect(all(h, 'a:custGeom')).toHaveLength(1)
    expect(all(h, 'a:custDash')).toEqual([])
  })

  test('paths are native shapes in their own box: every point inside the path\'s w × h, which is the shape\'s size; solid fills only', () => {
    const shapes = all(slide, 'p:sp').filter((s) => all(s, 'a:custGeom').length)
    // 4 connectors, the disc, 3 icon strokes, the chevron
    expect(shapes).toHaveLength(9)
    for (const s of shapes) {
      const ext = all(s, 'a:ext')[0]!, p = all(s, 'a:path')[0]!
      expect([p.attrs.w, p.attrs.h]).toEqual([ext.attrs.cx, ext.attrs.cy])
      for (const pt of all(s, 'a:pt')) {
        expect(num(pt.attrs.x)).toBeGreaterThanOrEqual(0)
        expect(num(pt.attrs.x)).toBeLessThanOrEqual(num(p.attrs.w))
        expect(num(pt.attrs.y)).toBeGreaterThanOrEqual(0)
        expect(num(pt.attrs.y)).toBeLessThanOrEqual(num(p.attrs.h))
      }
      expect(all(s, 'a:gradFill')).toEqual([])
    }
    // the key disc: four curves and a close in a 248 px box at its place, filled in the mark colour
    const disc = shapes.find((s) => all(s, 'p:cNvPr')[0]!.attrs.name!.startsWith('key '))!
    expect(all(disc, 'a:cubicBezTo')).toHaveLength(4)
    expect(all(disc, 'a:close')).toHaveLength(1)
    expect(all(disc, 'a:off')[0]!.attrs).toEqual({ x: String((CX - 124) * 6350), y: String((CY - 124) * 6350) })
    expect(all(disc, 'a:ext')[0]!.attrs).toEqual({ cx: String(248 * 6350), cy: String(248 * 6350) })
    expect(all(all(disc, 'p:spPr')[0]!, 'a:srgbClr')[0]!.attrs.val).toBe('37EE6A')
    // the chevron's fill keeps its alpha; a connector is an outline with round caps and joins, no fill
    const chevron = shapes.find((s) => all(s, 'p:cNvPr')[0]!.attrs.name!.startsWith('chevron '))!
    expect(all(chevron, 'a:alpha')[0]!.attrs.val).toBe(String(Math.round((0xcc / 255) * 100000)))
    const conn = shapes.find((s) => all(s, 'p:cNvPr')[0]!.attrs.name!.startsWith('connector '))!
    expect(all(conn, 'a:path')[0]!.attrs.fill).toBe('none')
    const ln = all(conn, 'a:ln')[0]!
    expect(ln.attrs).toEqual({ w: String(3 * 6350), cap: 'rnd' })
    expect(ln.kids.map((k) => k.name)).toEqual(['a:solidFill', 'a:round'])
  })

  test('the icon\'s strokes are one group whose child space is the slide\'s (chOff = off, chExt = ext) around its children', () => {
    const groups = all(slide, 'p:grpSp')
    expect(groups).toHaveLength(1)
    const g = groups[0]!
    const gx = g.kids.find((k) => k.name === 'p:grpSpPr')!.kids[0]!
    const [off, ext, chOff, chExt] = gx.kids
    expect([off!.name, ext!.name, chOff!.name, chExt!.name]).toEqual(['a:off', 'a:ext', 'a:chOff', 'a:chExt'])
    expect(chOff!.attrs).toEqual(off!.attrs)
    expect(chExt!.attrs).toEqual(ext!.attrs)
    const kids = g.kids.filter((k) => k.name === 'p:sp')
    expect(kids).toHaveLength(3)
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const k of kids) {
      const o = all(k, 'a:off')[0]!.attrs, e = all(k, 'a:ext')[0]!.attrs
      x0 = Math.min(x0, num(o.x)); y0 = Math.min(y0, num(o.y)); x1 = Math.max(x1, num(o.x) + num(e.cx)); y1 = Math.max(y1, num(o.y) + num(e.cy))
    }
    expect([num(off!.attrs.x), num(off!.attrs.y), num(ext!.attrs.cx), num(ext!.attrs.cy)]).toEqual([x0, y0, x1 - x0, y1 - y0])
    expect([x0, y0]).toEqual([(CX - 20) * 6350, (CY - 320) * 6350])
    // every shape id on the slide once
    const ids = all(slide, 'p:cNvPr').map((c) => c.attrs.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('outlines, dashes and caps: the satellites\' rings, the dotted axis (round caps counted inside DrawingML\'s dash), the gradient panel\'s dashed outline over its picture', () => {
    const rings = all(slide, 'p:sp').filter((s) => all(s, 'a:prstGeom')[0]?.attrs.prst === 'ellipse' && all(s, 'a:ln')[0]!.attrs.w === String(3 * 6350))
    expect(rings).toHaveLength(4)
    const lines = all(slide, 'p:cxnSp')
    expect(lines).toHaveLength(2)
    const axis = all(lines[0]!, 'a:ln')[0]!
    expect(axis.attrs).toEqual({ w: String(2 * 6350), cap: 'rnd' })
    // SVG's [2, 12] with round caps of 2 px is a 4 px dash and a 10 px gap: 200 % and 500 % of the width
    expect(all(axis, 'a:ds')[0]!.attrs).toEqual({ d: '200000', sp: '500000' })
    // the slanted hairline runs down to the right: no flip; one rising would be flipped
    expect(all(lines[1]!, 'a:xfrm')[0]!.attrs.flipV).toBeUndefined()
    const rise = buildPptx(deckOf(slideOf([{ t: 'line', x1: 0, y1: 100, x2: 100, y2: 0, color: '#000000', width: 2 }])), { title: 't', lang: 'en', read: () => null, fonts: null })
    expect(Buffer.from(readZip(rise).find((e) => e.name === 'ppt/slides/slide1.xml')!.data).toString('utf8')).toContain('<a:xfrm flipV="1">')
    const shade = all(slide, 'p:pic').find((p) => all(p, 'p:cNvPr')[0]!.attrs.name!.startsWith('Shade '))!
    expect(shade).toBeDefined()
    const outline = all(slide, 'p:sp').find((s) => all(s, 'a:prstGeom')[0]?.attrs.prst === 'roundRect' && all(s, 'a:custDash').length)!
    expect(all(outline, 'a:ds')[0]!.attrs).toEqual({ d: '400000', sp: '300000' })
    expect(all(outline, 'a:ln')[0]!.attrs.cap).toBe('flat')
    expect(outline.kids.find((k) => k.name === 'p:spPr')!.kids.map((k) => k.name)).toEqual(['a:xfrm', 'a:prstGeom', 'a:noFill', 'a:ln'])
  })

  test('the grounds are pictures of exactly their box; the accent a picture from svgPng, centred in its box; none without it', () => {
    const pics = all(slide, 'p:pic')
    const patterns = pics.filter((p) => all(p, 'p:cNvPr')[0]!.attrs.name!.startsWith('Pattern '))
    expect(patterns).toHaveLength(2)
    const rels = parseXml(part('ppt/slides/_rels/slide1.xml.rels'), 'rels')
    const target = (rid: string) => all(rels, 'Relationship').find((r) => r.attrs.Id === rid)!.attrs.Target!.replace('../', 'ppt/')
    const items = hubItems().filter((i) => i.t === 'pattern') as PatternItem[]
    patterns.forEach((p, i) => {
      const it = items[i]!
      const img = decodePng(new Uint8Array(zip.find((e) => e.name === target(all(p, 'a:blip')[0]!.attrs['r:embed']!))!.data))!
      expect([img.width, img.height]).toEqual([it.w, it.h])
      expect(all(p, 'a:off')[0]!.attrs).toEqual({ x: String(it.x * 6350), y: String(it.y * 6350) })
      expect(all(p, 'a:ext')[0]!.attrs).toEqual({ cx: String(it.w * 6350), cy: String(it.h * 6350) })
    })
    const accent = pics.filter((p) => all(p, 'p:cNvPr')[0]!.attrs.name!.startsWith('Accent '))
    expect(accent).toHaveLength(1)
    expect(calls).toEqual([[220, 220]])
    expect(all(accent[0]!, 'a:off')[0]!.attrs).toEqual({ x: String(1640 * 6350), y: String(60 * 6350) })
    const none = buildPptx(deckOf(slideOf(hubItems())), { title: 't', lang: 'en', read: () => null, fonts: null, svgPng: () => null })
    expect(Buffer.from(readZip(none).find((e) => e.name === 'ppt/slides/slide1.xml')!.data).toString('utf8')).not.toContain('name="Accent ')
    const absent = buildPptx(deckOf(slideOf(hubItems())), { title: 't', lang: 'en', read: () => null, fonts: null })
    expect(Buffer.from(readZip(absent).find((e) => e.name === 'ppt/slides/slide1.xml')!.data).toString('utf8')).not.toContain('name="Accent ')
    // the same deck gives the same bytes
    expect(Buffer.from(buildPptx(deck, { title: 'Acme Robotics deck', lang: 'en', read: () => null, fonts: null, created: '2026-11-06T09:00:00.000Z', svgPng: () => solidPng(440, 440) })).equals(Buffer.from(bytes))).toBe(true)
  })
})

// ── the PDF ──────────────────────────────────────────────────────────────────────────────────────────────────────
const typst = which('typst')
describe('the PDF draws the new items (typst.ts)', () => {
  const deck = deckOf(slideOf(hubItems()), hostileSlide())
  const t = buildTypst(deck, { title: 'Acme Robotics deck', lang: 'en', read: () => null })

  test('runs of paths and patterns are SVG files of the slide\'s size; outlines, dashes and caps are typst\'s own strokes; the accent is its SVG file', () => {
    const svgs = t.files.filter(([n]) => n.endsWith('.svg'))
    // slide 1: the patterns; the connectors; the disc; the icon and chevron (rects and lines between them are typst's
    // own); the accent; slide 2: its one sound path
    expect(svgs).toHaveLength(6)
    for (const [n, b] of svgs) {
      const doc = parseXml(Buffer.from(b).toString('utf8'), n)
      expect(doc.kids[0]!.attrs.xmlns).toBe('http://www.w3.org/2000/svg')
    }
    expect(t.source).toContain('#place(top + left, dx: 0pt, dy: 0pt, image("img1.svg", width: 960pt, height: 540pt))')
    expect(t.source).toContain(`ellipse(width: 66pt, height: 66pt, fill: rgb("#0b100d"), stroke: (paint: rgb("#ecf3ed8f"), thickness: 1.5pt))`)
    expect(t.source).toContain('line(start: (0pt, 0pt), end: (350pt, 0pt), stroke: (paint: rgb("#ecf3ed"), thickness: 1pt, cap: "round", dash: (1pt, 6pt)))')
    expect(t.source).toContain('rect(width: 160pt, height: 60pt, fill: gradient.linear(')
    expect(t.source).toContain('radius: 8pt, stroke: (paint: rgb("#37ee6a"), thickness: 1pt, dash: (4pt, 3pt)))')
    expect(t.source).toMatch(/image\("img\d+\.svg", width: 110pt, height: 110pt, fit: "contain"\)/)
    // nothing of the hostile slide but numbers and checked colours
    for (const bad of ['alert', 'javascript', 'expression(', 'onload', 'url(x)', 'NaN']) {
      expect(t.source).not.toContain(bad)
      for (const [, b] of svgs) expect(Buffer.from(b).toString('utf8')).not.toContain(bad)
    }
  })

  test.if(!!typst && !!pretendardDir())('typst compiles a slide with every new kind to PDF and to PNG; the PNG shows the disc, the fade is zero under the type', () => {
    fs.mkdirSync(WORK, { recursive: true })
    const work = fs.mkdtempSync(path.join(WORK, 'intro-deck-draw-'))
    try {
      for (const [name, b] of t.files) fs.writeFileSync(path.join(work, name), b)
      fs.writeFileSync(path.join(work, 'deck.typ'), t.source)
      const pdf = Bun.spawnSync([typst!, 'compile', '--font-path', pretendardDir()!, '--root', work, path.join(work, 'deck.typ'), path.join(work, 'out.pdf')])
      expect(pdf.exitCode, pdf.stderr.toString()).toBe(0)
      expect(fs.readFileSync(path.join(work, 'out.pdf')).subarray(0, 5).toString()).toBe('%PDF-')
      const png = Bun.spawnSync([typst!, 'compile', '--format', 'png', '--ppi', '144', '--pages', '1', '--font-path', pretendardDir()!, '--root', work, path.join(work, 'deck.typ'), path.join(work, 'out.png')])
      expect(png.exitCode, png.stderr.toString()).toBe(0)
      const img = decodePng(new Uint8Array(fs.readFileSync(path.join(work, 'out.png'))))!
      expect([img.width, img.height]).toEqual([1920, 1080])
      const px = (x: number, y: number) => [...img.data.subarray((y * 1920 + x) * 4, (y * 1920 + x) * 4 + 3)]
      // the key disc in the mark colour, the ground where the faded dots would be under the title
      const near = (a: number[], b: number[], d = 3) => a.every((v, i) => Math.abs(v - b[i]!) <= d)
      expect(near(px(CX, CY + 60), [0x37, 0xee, 0x6a]), String(px(CX, CY + 60))).toBe(true)
      for (const [x, y] of [[75, 75], [555, 105], [705, 285], [45, 1035], [735, 555]]) expect(px(x!, y!), `${x},${y}`).toEqual([0x0b, 0x10, 0x0d])
      // past the fade the dots show (a dot centre at full strength, over the plain ground)
      expect(px(1185, 75)).not.toEqual([0x0b, 0x10, 0x0d])
    } finally { fs.rmSync(work, { recursive: true, force: true }) }
  })
})
