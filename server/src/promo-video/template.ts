// The promo video template (docs/DECISIONS.md "V"): five beats, each with one camera idea, three or more depth planes
// (ground with glow and vignette → a picture full bleed or in a floating window → type → light and grain), type as
// the motion (per-word cuts, an in-place swap or a strike then a slam, decelerating counts) and velocity-matched seams
// (zoom-through, push-slide, blur crossfade). The AI fills slots; this file only lays out what the server checked
// (layout.ts measured it). Every motion is a CSS animation with an absolute delay on one clock (the root is the only
// data-start), compiled from a few timeline stops per element, so the same markup plays in the chat (one script seeks
// every animation) and renders frame by frame with HyperFrames' CSS adapter. No GSAP (its licence, DECISIONS "V"), no
// network, no clock. Sizes are design pixels × `--u` (1/1080 of the root's width), so it fills any width.
import type { AudioCue } from './audio'
import { AFFIX, DURATION, PROMO_H, PROMO_W, SEAMS, SEAM_LEN, SETTLED, STARTS, W, X, fitDoc, hasHangul, plain, segments, splitNumber, type Sizes, type Stat, type VideoDoc } from './layout'
import { paletteFor, rgba, type Palette } from './palette'

// ── motion: a tiny timeline → @keyframes compiler ─────────────────────────────────────────────────────────────
const EASE = {
  lin: 'linear',
  p2o: 'cubic-bezier(.33,1,.68,1)', p3o: 'cubic-bezier(.25,1,.5,1)', p4o: 'cubic-bezier(.22,1,.36,1)', xo: 'cubic-bezier(.16,1,.3,1)',
  p2i: 'cubic-bezier(.32,0,.67,0)', p3i: 'cubic-bezier(.5,0,.75,0)',
  p2io: 'cubic-bezier(.65,0,.35,1)', p3io: 'cubic-bezier(.76,0,.24,1)', sio: 'cubic-bezier(.37,0,.63,1)', so: 'cubic-bezier(.61,1,.88,1)',
} as const
type Ease = keyof typeof EASE
type Stop = [number, string, Ease?]

class Motion {
  rules: string[] = []
  private n = 0
  /** One animation over absolute times: each stop is [time, css declarations, ease to the next stop]. */
  a(stops: Stop[]): string {
    const name = `m${(this.n++).toString(36)}`
    const t0 = stops[0]![0], t1 = stops[stops.length - 1]![0]
    const d = Math.max(t1 - t0, 0.01)
    const body = stops.map(([t, decl, ease]) => `${r3(((t - t0) / d) * 100)}%{${decl}${ease ? `;animation-timing-function:${EASE[ease]}` : ''}}`).join('')
    this.rules.push(`@keyframes ${name}{${body}}`)
    return `${name} ${r3(d)}s linear ${r3(t0)}s 1 both`
  }
  /** A from → to over [t, t + d]. */
  ft(t: number, d: number, from: string, to: string, ease: Ease): string { return this.a([[t, from, ease], [t + d, to]]) }
}
const r3 = (n: number) => Math.round(n * 1000) / 1000
const u = (n: number) => `calc(${r3(n)}*var(--u))`
interface Tf { x?: number; y?: number; z?: number; s?: number; sx?: number; rx?: number; ry?: number; r?: number }
/** one transform with every function present, so stops interpolate cleanly */
const tf = (o: Tf = {}) => `transform:translate3d(${u(o.x ?? 0)},${u(o.y ?? 0)},${u(o.z ?? 0)}) rotateX(${o.rx ?? 0}deg) rotateY(${o.ry ?? 0}deg) rotate(${o.r ?? 0}deg) scale(${o.sx ?? o.s ?? 1},${o.s ?? 1})`
const op = (v: number) => `opacity:${v}`
const bl = (v: number) => `filter:blur(${u(v)})`
const j = (...d: string[]) => d.join(';')
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const st = (o: Record<string, string | number | undefined>) => Object.entries(o).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}:${v}`).join(';')
const box = (l: number, t: number, w?: number, h?: number) => st({ position: 'absolute', left: u(l), top: u(t), width: w === undefined ? undefined : u(w), height: h === undefined ? undefined : u(h) })

// ── pieces ─────────────────────────────────────────────────────────────────────────────────────────────────────
interface Ctx { m: Motion; c: Palette; doc: VideoDoc; sz: Sizes }

/** Words that rise out of a mask one after another (the accent part in the accent colour). */
function risingWords(x: Ctx, line: string, at: number, step: number, o: { dur?: number; blur?: boolean; ease?: Ease } = {}): { html: string; next: number } {
  let t = at
  const html = segments(line).map((sg) => sg.text.split(/(\s+)/).map((w) => {
    if (!w) return ''
    if (/^\s+$/.test(w)) return ' '
    const a = x.m.ft(t, o.dur ?? 0.62, j('transform:translateY(112%)', o.blur ? bl(6) : 'filter:none'), j('transform:translateY(0)', 'filter:none'), o.ease ?? 'p3o')
    t += step
    return `<span class="w"><span class="wi${sg.accent ? ' ac' : ''}" style="animation:${a}">${esc(w)}</span></span>`
  }).join('')).join('')
  return { html, next: t }
}

/** Characters that appear one by one (a typed line). */
function typed(x: Ctx, text: string, at: number, dur: number): string {
  const cs = [...text]
  return cs.map((ch, i) => (ch === ' ' ? ' ' : `<span style="animation:${x.m.ft(at + (dur * i) / Math.max(cs.length, 1), 0.01, op(0), op(1), 'lin')}">${esc(ch)}</span>`)).join('')
}

/**
 * A number that counts into the value written in the material, decelerating (a registered integer property animated
 * by CSS, shown through CSS counters, so every frame shows whole digits). When it lands, the exact text as written
 * takes over ("1,200" with its comma). `down`: counts down from all nines (the hook's "after").
 */
function countingNumber(x: Ctx, n: string, at: number, dur: number, o: { down?: boolean } = {}): string {
  const p = splitNumber(n)
  const core = p.digits.replace(/,/g, '')
  const dot = core.indexOf('.')
  const frac = dot < 0 ? 0 : Math.min(core.length - dot - 1, 3)
  const target = Number(core.replace('.', '').slice(0, dot < 0 ? undefined : dot + frac)) || 0
  // a year (founded in 1974) rolls up through the years before it, never from 0 ("1083년" reads as a fact)
  const year = !frac && /^(1[89]|20)\d\d$/.test(core)
  const from = o.down ? Math.max(target, 10 ** String(Math.floor(target / 10 ** frac)).length * 10 ** frac - 1) : year ? target - 30 : 0
  const land = at + dur
  const count = x.m.a([[at, `--pvn:${from}`, 'p2o'], [land, `--pvn:${target}`]])
  const swapOut = x.m.a([[at, op(1), 'lin'], [land - 0.001, op(1), 'lin'], [land, op(0)]])
  const swapIn = x.m.a([[at, op(0), 'lin'], [land - 0.001, op(0), 'lin'], [land, op(1)]])
  const reset = frac ? `pvi calc(round(down, var(--pvn) / ${10 ** frac})) pvf mod(var(--pvn), ${10 ** frac})` : 'pvi var(--pvn)'
  const counting = `<span class="cnt f${frac} g" style="counter-reset:${reset};animation:${count},${swapOut}"></span>`
  const exact = `<span class="fin g" style="animation:${swapIn}">${esc(p.digits)}</span>`
  return `${p.pre ? `<span class="af g">${esc(p.pre)}</span>` : ''}<span class="nstack">${counting}${exact}</span>${p.unit ? `<span class="af un g">${esc(p.unit)}</span>` : ''}`
}

/** The ground of a scene: colour, two glows, a vignette. */
function ground(x: Ctx, s: number, glows: { x: number; y: number; w: number; h: number; a: number; color?: string; at?: number; pulse?: number }[]): string {
  const c = x.c
  return `<div class="gnd" style="background:${c.ground}">` + glows.map((g) => {
    const col = g.color ?? c.glow
    const anim = g.pulse !== undefined
      ? x.m.a([[s, j(op(g.a * 0.45), tf({ s: 0.85 })), 'p2o'], [s + 1.2, j(op(g.a * 0.8), tf({ s: 1 })), 'sio'], [s + g.pulse, j(op(g.a * 0.8), tf({ s: 1 })), 'p2o'], [s + g.pulse + 0.14, j(op(g.a * 1.25), tf({ s: 1.08 })), 'p2o'], [s + g.pulse + 1.0, j(op(g.a), tf({ s: 1.04 }))]])
      : x.m.ft(s + (g.at ?? 0), 1.4, j(op(g.a * 0.4), tf({ s: 0.86 })), j(op(g.a), tf({ s: 1 })), 'p2o')
    return `<i class="glow" style="${box(g.x, g.y, g.w, g.h)};background:radial-gradient(closest-side,${rgba(col, 0.62)} 0%,${rgba(col, 0.26)} 45%,${rgba(col, 0)} 100%);animation:${anim}"></i>`
  }).join('') + `<i class="vig"></i></div>`
}

/** Light threads rising and fanning out from the bottom (the type-and-light version of a picture beat). */
function threads(x: Ctx, s: number, o: { cx?: number; n?: number; top?: number } = {}): string {
  const n = o.n ?? 7, cx = o.cx ?? 540, top = o.top ?? 120
  const paths: string[] = []
  for (let i = 0; i < n; i++) {
    const k = (i - (n - 1) / 2) / ((n - 1) / 2) // -1 … 1
    const endX = cx + k * 470, baseX = cx + k * 26
    const endY = top + Math.abs(k) * 70
    const d = `M ${r3(baseX)} 1420 C ${r3(baseX)} ${r3(1420 - (1420 - endY) * 0.55)}, ${r3(endX)} ${r3(endY + (1420 - endY) * 0.5)}, ${r3(endX)} ${r3(endY)}`
    const at = s + 0.15 + Math.abs(k) * 0.32 + (i % 2) * 0.06
    const draw = x.m.ft(at, 1.5, 'stroke-dashoffset:1', 'stroke-dashoffset:0', 'p3o')
    const w = 3 + (1 - Math.abs(k)) * 3
    paths.push(`<path d="${d}" pathLength="1" stroke-width="${r3(w * 5)}" class="th-glow" style="animation:${draw}"/><path d="${d}" pathLength="1" stroke-width="${r3(w)}" class="th-core" style="animation:${draw}"/>`)
  }
  return `<svg class="threads" viewBox="0 0 1080 1350" preserveAspectRatio="none" aria-hidden="true">${paths.join('')}</svg>`
}

/** A soft light sweep crossing the frame once (a light layer). */
function sweep(x: Ctx, at: number, dur: number, o: { top?: number; h?: number; a?: number } = {}): string {
  return `<i class="sweep" style="${box(-200, o.top ?? 200, 1480, o.h ?? 520)};opacity:${o.a ?? 0.5};animation:${x.m.a([[at, j(tf({ x: -1200, r: -16 })), 'sio'], [at + dur, j(tf({ x: 1200, r: -16 }))]])}"></i>`
}

function kicker(x: Ctx, text: string, at: number, top: number): string {
  const latin = !hasHangul(text)
  const bar = x.m.ft(at, 0.5, 'transform:scaleX(0)', 'transform:scaleX(1)', 'p3o')
  const rise = x.m.ft(at + 0.06, 0.6, 'transform:translateY(110%)', 'transform:translateY(0)', 'p3o')
  return `<div class="kick" style="${box(X, top)}"><i style="animation:${bar}"></i><span class="w"><span class="wi" style="letter-spacing:${latin ? '.16em' : '.04em'};animation:${rise}">${esc(latin ? text.toUpperCase() : text)}</span></span></div>`
}

// ── the five beats ─────────────────────────────────────────────────────────────────────────────────────────────
function hook(x: Ctx): string {
  const s = STARTS[0], h = x.doc.hook, z = x.sz.hook, c = x.c, m = x.m
  const T = z.top
  const parts: string[] = []
  parts.push(ground(x, s, [{ x: -260, y: 640, w: 1600, h: 1000, a: 0.55, color: c.glow2 }, { x: -120, y: T.after - 280, w: 1100, h: 900, a: 0.0001, pulse: h.mode === 'swap' ? 1.5 : 2.0 }]))
  // the glow that blooms behind the slam
  const hit = h.mode === 'swap' ? 1.5 : 2.0
  const bloom = m.a([[s, j(op(0), tf({ s: 0.55 })), 'xo'], [s + hit - 0.01, j(op(0), tf({ s: 0.55 })), 'xo'], [s + hit, j(op(0.2), tf({ s: 0.6 })), 'xo'], [s + hit + 0.75, j(op(1), tf({ s: 1 })), 'sio'], [s + 3.5, j(op(0.8), tf({ s: 1.02 }))]])
  parts.push(`<i class="glow" style="${box(-160, T.after - 300, 1240, 1000)};background:radial-gradient(closest-side,${rgba(c.glow, 0.5)} 0%,${rgba(c.glow, 0.24)} 40%,${rgba(c.glow, 0)} 100%);animation:${bloom}"></i>`)
  const cam = m.ft(s, 3.2, tf({ s: 1 }), tf({ s: 1.06 }), 'sio')
  const kick = h.mode === 'swap' ? 'none' : m.a([[s, tf({ y: 0 }), 'lin'], [s + 2.0, tf({ y: 0 }), 'p2o'], [s + 2.05, tf({ y: 9 }), 'p3o'], [s + 2.5, tf({ y: 0 })]])
  const inner: string[] = []
  // label + hairline
  inner.push(`<i class="rule" style="${box(X, T.label - 52, W, 2)};animation:${m.ft(s + 0.04, 0.9, 'transform:scaleX(0)', 'transform:scaleX(1)', 'xo')}"></i>`)
  let t = s + 0.08
  const labelWords = plain(h.label).split(/\s+/).map((w) => { const a = m.ft(t, 0.6, tf({ y: 12 }), tf({ y: 0 }), 'xo'); t += 0.06; return `<span class="wd" style="animation:${a}">${esc(w)}</span>` }).join(' ')
  inner.push(`<div class="label" style="${box(X, T.label)};font-size:${u(z.label)}">${labelWords}</div>`)
  // a sheen passes over the first words once while the viewer reads them
  const shine = m.ft(s + 0.45, 0.9, 'background-position:100% 0', 'background-position:0% 0', 'sio')
  if (h.mode === 'strike') {
    const move = m.a([[s, tf({ s: 1 }), 'lin'], [s + 1.7, tf({ s: 1 }), 'p3io'], [s + 2.12, tf({ s: 0.5, y: -40 })]])
    const settle = m.ft(s, 1.0, j(tf({ s: 1.07 }), bl(0)), j(tf({ s: 1 }), bl(0)), 'xo')
    const dim = m.a([[s, op(1), 'lin'], [s + 1.7, op(1), 'p2io'], [s + 2.12, op(0.32)]])
    const strike = m.ft(s + 1.5, 0.32, 'transform:scaleX(0) rotate(-2deg)', 'transform:scaleX(1) rotate(-2deg)', 'p2o')
    inner.push(`<div class="big-wrap" style="${box(X, T.before)};transform-origin:0 0;animation:${move}"><div style="transform-origin:20% 60%;animation:${settle}"><div class="big" style="font-size:${u(z.before)}"><span style="animation:${dim}"><span class="shine" style="animation:${shine}">${esc(h.before)}</span></span><i class="strike" style="animation:${strike}"></i></div></div></div>`)
    const slam = m.ft(s + 2.0, 0.5, j(op(0), tf({ s: 1.25 }), bl(10)), j(op(1), tf({ s: 1 }), bl(0)), 'xo')
    const count = m.ft(s + 2.0, 0.95, tf({ s: 1.07 }), tf({ s: 1 }), 'p2o')
    // a count runs toward the new state: down (half a day → 14 s) unless the old state is a smaller number (3.7 → 81)
    const value = (t: string) => { const d = splitNumber(t).digits.replace(/,/g, ''); return d ? Number(d) : Number.NaN }
    const n0 = value(h.before), n1 = value(h.after)
    const num = /\d/.test(h.after) ? countingNumber(x, h.after, s + 2.0, 0.95, { down: !(n0 < n1) }) : `<span class="g">${esc(h.after)}</span>`
    inner.push(`<div class="big-wrap" style="${box(X - 6, T.after)};transform-origin:30% 60%;animation:${slam}"><div class="big hot" style="font-size:${u(z.after)};transform-origin:30% 72%;animation:${count}">${num}</div></div>`)
  } else {
    // swap: the first word leaves upward through its mask, the new one rises into the same place
    const settle = m.ft(s, 1.0, j(tf({ s: 1.06 }), bl(0)), j(tf({ s: 1 }), bl(0)), 'xo')
    const out = m.a([[s, j(tf({ y: 0 }), bl(0), op(1)), 'lin'], [s + 1.4, j(tf({ y: 0 }), bl(0), op(1)), 'p3i'], [s + 1.68, j('transform:translateY(-135%)', bl(8), op(0))]])
    const inn = m.a([[s, j('transform:translateY(135%)', bl(8)), 'lin'], [s + 1.5, j('transform:translateY(135%)', bl(8)), 'xo'], [s + 2.05, j('transform:translateY(0)', bl(0))]])
    const under = m.ft(s + 1.8, 0.45, 'transform:scaleX(0)', 'transform:scaleX(1)', 'p3o')
    inner.push(`<div class="big-wrap" style="${box(X, T.before)};animation:${settle}"><div class="big swap" style="font-size:${u(z.before)}"><span class="sw"><span style="animation:${out}"><span class="shine" style="animation:${shine}">${esc(h.before)}</span></span></span><span class="sw sw2 hot"><span class="g" style="animation:${inn}">${esc(h.after)}</span></span><i class="under" style="animation:${under}"></i></div></div>`)
  }
  if (h.line) inner.push(`<div class="foot" style="${box(X, T.line)};font-size:${u(z.line)}">${typed(x, h.line, s + (h.mode === 'swap' ? 2.0 : 2.5), 0.42)}</div>`)
  parts.push(`<div class="cam" style="transform-origin:${u(470)} ${u(700)};animation:${cam}"><div class="cam" style="animation:${kick}">${inner.join('')}</div></div>`)
  return parts.join('')
}

function promise(x: Ctx): string {
  const s = STARTS[1], p = x.doc.promise, z = x.sz.promise, c = x.c, m = x.m
  const parts: string[] = []
  const lh = 1.08
  const top = p.picture ? 150 : 190
  if (p.picture) {
    parts.push(ground(x, s, [{ x: 300, y: -300, w: 1200, h: 900, a: 0.5 }]))
    // the picture: full bleed under a fade, the camera pulling back off it
    const pull = m.ft(s, 3.9, j(tf({ s: 1.2, y: 30 })), j(tf({ s: 1.04, y: 0 })), 'p2o')
    const reveal = m.ft(s, 0.9, j(op(0.2), bl(14)), j(op(1), bl(0)), 'p2o')
    parts.push(`<div class="bleed" style="top:${u(330)}"><div class="bleed-in" style="animation:${reveal}"><img src="${esc(p.picture.src)}" alt="" style="object-position:${p.picture.focus};transform-origin:50% 40%;animation:${pull}"></div><i class="bleed-fade" style="background:linear-gradient(180deg,${c.ground} 0%,${rgba(c.ground, 0.86)} 16%,${rgba(c.ground, 0.15)} 46%,${rgba(c.ground, 0)} 66%,${rgba(c.ground, 0.55)} 100%)"></i></div>`)
    parts.push(`<i class="leak" style="${box(-600, 380, 1500, 760)};background:radial-gradient(closest-side,${rgba(c.glow, 0.42)},${rgba(c.glow, 0)});animation:${m.ft(s, 3.9, j(tf({ x: 0, r: -24 }), op(0.2)), j(tf({ x: 620, r: -24 }), op(0.85)), 'sio')}"></i>`)
  } else {
    parts.push(ground(x, s, [{ x: -260, y: 700, w: 1600, h: 900, a: 0.65, pulse: 2.0 }]))
    parts.push(`<div class="cam" style="transform-origin:50% 100%;animation:${m.ft(s, 3.5, tf({ s: 1 }), tf({ s: 1.06 }), 'sio')}">${threads(x, s, { top: top + p.headline.length * z.headline * lh + (z.sub.length ? 34 + z.sub.length * 36 * 1.42 : 0) + 110 })}</div>`)
  }
  let t = s + 0.42
  const heads = p.headline.map((l) => { const r = risingWords(x, l, t, 0.07); t = r.next + 0.06; return `<div class="ln">${r.html}</div>` }).join('')
  const cam = m.ft(s, 3.4, tf({ s: 1.04 }), tf({ s: 1 }), 'p2o')
  const head = `<div class="hl" style="${box(X, top)};width:${u(W)};font-size:${u(z.headline)};line-height:${lh}">${heads}</div>`
  const subTop = top + p.headline.length * z.headline * lh + 34
  const sub = z.sub.length ? `<div class="sub" style="${box(X, subTop)};width:${u(W)};animation:${m.ft(s + 1.5, 0.8, j(op(0), tf({ y: 18 }), bl(6)), j(op(1), tf({ y: 0 }), bl(0)), 'xo')}">${z.sub.map((l) => `<div>${esc(l)}</div>`).join('')}</div>` : ''
  parts.push(`<div class="cam" style="transform-origin:${u(X)} ${u(top)};animation:${cam}">${head}${sub}</div>`)
  return parts.join('')
}

function work(x: Ctx): string {
  const s = STARTS[2], w = x.doc.work, z = x.sz.work, c = x.c, m = x.m
  const parts: string[] = []
  const lh = 1.1
  const headTop = 168
  if (w.picture) {
    parts.push(ground(x, s, [{ x: -60, y: 380, w: 1200, h: 900, a: 0.7, at: 0.3 }]))
    const pic = w.picture
    const winW = 980, winH = 690, bar = 44, left = 50, top = 410
    const viewH = winH - bar
    // the camera inside the window: a tall picture scrolls down, a wide one pans across, else a slow push
    const k = Math.max(winW / pic.width, viewH / pic.height)
    const sw = pic.width * k, sh = pic.height * k
    const scrollY = sh > viewH + 80 ? Math.min(sh - viewH, 420) : 0
    const panX = !scrollY && sw > winW + 80 ? Math.min(sw - winW, 360) : 0
    // a focus on the right starts there and pans back left
    const right = /^(?:[6-9]\d|100)%/.test(pic.focus)
    const x0 = right ? -panX : 0, x1 = right ? 0 : -panX
    const img = scrollY || panX
      ? `<img class="shot" src="${esc(pic.src)}" alt="" style="width:${u(sw)};height:${u(sh)};max-width:none;animation:${m.a([[s, tf({ x: x0 }), 'lin'], [s + 1.0, tf({ x: x0 }), 'p2io'], [s + 2.7, tf({ x: panX ? x1 : 0, y: -scrollY })]])}">`
      : `<img class="shot" src="${esc(pic.src)}" alt="" style="width:100%;height:100%;object-fit:cover;object-position:${pic.focus};animation:${m.ft(s, 3.9, tf({ s: 1.0 }), tf({ s: 1.08 }), 'sio')}">`
    const enter = m.ft(s, 1.0, j(tf({ y: 70, z: -420, rx: 18, ry: -12 })), j(tf({})), 'p2o')
    const fade = m.ft(s, 0.3, op(0), op(1), 'p2o')
    const shade = m.ft(s, 1.1, op(1), op(0), 'p2o')
    const push = m.a([[s, tf({ s: 1 }), 'lin'], [s + 1.0, tf({ s: 1 }), 'p2io'], [s + 2.5, tf({ s: 1.05 }), 'sio'], [s + 3.5, tf({ s: 1.06 })]])
    const host = x.doc.website ? `<span class="addr">${esc(x.doc.website)}</span>` : ''
    const back = m.ft(s + 0.35, 1.0, j(op(0), tf({ s: 0.86 })), j(op(0.6), tf({ s: 1 })), 'p2o')
    parts.push(`<div class="cam" style="${box(left, top, winW, winH)};transform-origin:50% 50%;perspective:${u(1800)};animation:${push}"><i class="backlight" style="background:${c.glow};animation:${back}"></i><div class="win" style="animation:${enter},${fade}"><div class="winbar" style="height:${u(bar)}"><i></i><i></i><i></i>${host}</div><div class="view" style="height:${u(viewH)}">${img}</div><i class="shade" style="animation:${shade}"></i></div></div>`)
    // points: glass chips sliding in over the window's lower right, one per half beat
    w.points.forEach((pt, i) => {
      const at = s + 2.0 + i * 0.25
      const a = m.ft(at, 0.7, j(tf({ x: 520, ry: -22 }), op(0)), j(tf({ x: 0, ry: 0 }), op(1)), 'xo')
      parts.push(`<div class="pt" style="right:${u(28)};top:${u(top + winH - 70 - (w.points.length - i) * 92)};font-size:${u(z.points)};animation:${a}"><i></i>${esc(pt)}</div>`)
    })
  } else {
    parts.push(ground(x, s, [{ x: -200, y: 520, w: 1500, h: 1000, a: 0.6, pulse: 1.5 }]))
    w.points.forEach((pt, i) => {
      const at = s + 1.0 + i * 0.5
      const a = m.ft(at, 0.8, j(tf({ x: 140, z: -200, ry: -24 }), op(0), bl(8)), j(tf({}), op(1), bl(0)), 'xo')
      parts.push(`<div class="row" style="${box(X, 580 + i * 156, W, 128)};font-size:${u(z.points)};animation:${a}"><i></i><span>${esc(pt)}</span></div>`)
    })
    parts.push(sweep(x, s + 2.2, 1.2, { top: 420, h: 700, a: 0.35 }))
  }
  parts.push(kicker(x, w.kicker, s + 0.45, headTop - 70))
  let t = s + 0.55
  const heads = w.headline.map((l) => { const r = risingWords(x, l, t, 0.06); t = r.next + 0.05; return `<div class="ln">${r.html}</div>` }).join('')
  parts.push(`<div class="hl" style="${box(X, headTop)};width:${u(W)};font-size:${u(z.headline)};line-height:${lh}">${heads}</div>`)
  return parts.join('')
}

function proof(x: Ctx): string {
  const s = STARTS[3], p = x.doc.proof, z = x.sz.proof, c = x.c, m = x.m
  const parts: string[] = []
  parts.push(ground(x, s, [{ x: -160, y: 260, w: 1400, h: 1000, a: 0.25, color: c.glow2 }]))
  if (p.picture) {
    const push = m.ft(s, 3.9, tf({ s: 1.0 }), tf({ s: 1.08 }), 'sio')
    parts.push(`<div class="back"><img src="${esc(p.picture.src)}" alt="" style="object-position:${p.picture.focus};animation:${push}"></div><i class="back-fade" style="background:radial-gradient(70% 55% at 50% 42%,${rgba(c.ground, 0.55)},${rgba(c.ground, 0.92)})"></i>`)
  }
  // a horizon of light under the words, drawn once (the light layer of a beat without a picture)
  const horizon = (y: number, at: number) => `<i class="glow" style="${box(-200, y - 330, 1480, 700)};background:radial-gradient(closest-side,${rgba(c.glow, 0.55)},${rgba(c.glow, 0.18)} 50%,${rgba(c.glow, 0)});animation:${m.ft(at, 1.2, j(op(0), tf({ s: 0.6, sx: 0.3 })), j(op(1), tf({ s: 1, sx: 1 })), 'xo')}"></i>` +
    `<i class="horizon" style="${box(0, y, 1080, 3)};animation:${m.ft(at, 1.1, j(op(0), 'transform:scaleX(.05)'), j(op(1), 'transform:scaleX(1)'), 'xo')}"></i>`
  const stat = (st0: { number: string; label: string }, size: number, at: number, top: number, o: { slam?: boolean } = {}) => {
    const bloom = m.a([[at, j(op(0), tf({ s: 0.6 })), 'p2o'], [at + 0.9, j(op(0.15), tf({ s: 0.8 })), 'p2o'], [at + 1.04, j(op(1), tf({ s: 1 })), 'p2o'], [at + 1.9, j(op(0.6), tf({ s: 1.06 }))]])
    const scale = o.slam
      ? m.ft(at, 0.5, j(op(0), tf({ s: 1.25 }), bl(10)), j(op(1), tf({ s: 1 }), bl(0)), 'xo')
      : m.ft(at, 1.0, j(op(1), tf({ s: 0.82 }), bl(0)), j(op(1), tf({ s: 1 }), bl(0)), 'p2o')
    const label = m.ft(at + 0.5, 0.6, j(op(0), tf({ y: 16 })), j(op(1), tf({ y: 0 })), 'xo')
    const rule = m.ft(at + 0.35, 0.6, 'transform:scaleX(0)', 'transform:scaleX(1)', 'p3o')
    return `<i class="glow" style="${box(40, top - 260, 1000, size + 560)};background:radial-gradient(closest-side,${rgba(c.glow, 0.55)} 0%,${rgba(c.glow, 0.2)} 50%,${rgba(c.glow, 0)} 100%);animation:${bloom}"></i>` +
      `<div class="stat" style="${box(0, top, 1080)};animation:${scale}"><div class="big hot num" style="font-size:${u(size)}">${countingNumber(x, st0.number, at, 1.0)}</div></div>` +
      `<i class="srule" style="${box(540 - 70, top + size * 1.04 + 26, 140, 3)};animation:${rule}"></i>` +
      `<div class="slabel" style="${box(0, top + size * 1.04 + 56, 1080)};font-size:${u(z.label)};animation:${label}">${esc(st0.label)}</div>`
  }
  if (p.stats.length === 2) {
    const [a, b] = p.stats as [Stat, Stat]
    const seam = m.a([[s, j(tf({ s: 1 }), bl(0), op(1)), 'lin'], [s + 1.5, j(tf({ s: 1 }), bl(0), op(1)), 'p3i'], [s + 2.0, j(tf({ s: 1.7 }), bl(18), op(0))]])
    parts.push(horizon(Math.round(440 + Math.max(z.stats[0]!, z.stats[1]!) * 1.04 + 56 + z.label * 1.3 + 150), s + 0.8))
    parts.push(`<div class="layer" style="transform-origin:50% 40%;animation:${seam}">${stat(a, z.stats[0]!, s, 440)}</div>`)
    parts.push(`<div class="layer">${stat(b, z.stats[1]!, s + 2.0, 440, { slam: true })}</div>`)
  } else if (p.stats.length === 1) {
    const top = p.headline.length || z.sub.length ? 340 : 440
    const cam = m.ft(s, 3.4, tf({ s: 1 }), tf({ s: 1.045 }), 'sio')
    if (!p.headline.length && !z.sub.length) parts.push(horizon(Math.round(top + z.stats[0]! * 1.04 + 56 + z.label * 1.3 + 150), s + 0.8))
    let html = stat(p.stats[0]!, z.stats[0]!, s, top)
    const after = top + z.stats[0]! * 1.04 + 56 + z.label * 1.3 + 60
    if (p.headline.length) {
      let t = s + 1.6
      html += `<div class="hl center" style="${box(0, after, 1080)};font-size:${u(z.headline)};line-height:1.1">${p.headline.map((l) => { const r = risingWords(x, l, t, 0.06); t = r.next; return `<div class="ln">${r.html}</div>` }).join('')}</div>`
    }
    if (z.sub.length) html += `<div class="sub center" style="${box(0, after + (p.headline.length ? p.headline.length * z.headline * 1.1 + 24 : 0), 1080)};animation:${m.ft(s + 2.0, 0.7, j(op(0), bl(6)), j(op(1), bl(0)), 'xo')}">${z.sub.map((l) => `<div>${esc(l)}</div>`).join('')}</div>`
    parts.push(`<div class="cam" style="transform-origin:50% 40%;animation:${cam}">${html}</div>`)
  } else {
    // a statement: each word slams in on the half beat (inverse zoom), then the sub line, over a horizon of light
    const blockH = p.headline.length * z.headline * 1.06 + (z.sub.length ? 40 + z.sub.length * 36 * 1.42 : 0)
    const top = Math.round(Math.max(220, 560 - blockH / 2))
    const hz = Math.round(top + blockH + 120)
    parts.push(horizon(hz, s + 1.4))
    let t = s + 0.1
    const heads = p.headline.map((l) => {
      // each word slams in; a space stays only where the line has one ("*성과*로" keeps its particle attached)
      const html = segments(l).map((sg) => sg.text.split(/(\s+)/).map((w) => {
        if (!w) return ''
        if (/^\s+$/.test(w)) return ' '
        const a = m.ft(t, 0.5, j(op(0), tf({ s: 1.3 }), bl(10)), j(op(1), tf({ s: 1 }), bl(0)), 'xo'); t += 0.25
        return `<span class="wd${sg.accent ? ' ac' : ''}" style="animation:${a}">${esc(w)}</span>`
      }).join('')).join('')
      return `<div class="ln">${html}</div>`
    }).join('')
    parts.push(`<i class="glow" style="${box(-100, 120, 1280, 1000)};background:radial-gradient(closest-side,${rgba(c.glow, 0.45)},${rgba(c.glow, 0)});animation:${m.ft(s, 2.4, j(op(0.2), tf({ s: 0.8 })), j(op(1), tf({ s: 1.04 })), 'p2o')}"></i>`)
    const cam = m.ft(s, 3.4, tf({ s: 1 }), tf({ s: 1.05 }), 'sio')
    parts.push(`<div class="cam" style="transform-origin:${u(X)} ${u(top)};animation:${cam}"><div class="hl" style="${box(X, top)};width:${u(W)};font-size:${u(z.headline)};line-height:1.06">${heads}</div>` +
      (z.sub.length ? `<div class="sub" style="${box(X, top + p.headline.length * z.headline * 1.06 + 40)};width:${u(W)};animation:${m.ft(Math.max(t, s + 1.6), 0.7, j(op(0), tf({ y: 16 }), bl(6)), j(op(1), tf({ y: 0 }), bl(0)), 'xo')}">${z.sub.map((l) => `<div>${esc(l)}</div>`).join('')}</div>` : '') + '</div>')
    parts.push(sweep(x, s + 2.1, 1.1, { top: 260, h: 640, a: 0.4 }))
  }
  return parts.join('')
}

function cta(x: Ctx): string {
  const s = STARTS[4], d = x.doc, z = x.sz.cta, c = x.c, m = x.m
  const LOCK = s + 1.0
  const parts: string[] = []
  parts.push(ground(x, s, [{ x: -160, y: 120, w: 1400, h: 900, a: 0.5, color: c.glow2 }]))
  const cam = m.ft(s, 2.0, tf({ s: 1 / 1.06 }), tf({ s: 1 }), 'p2io')
  const inner: string[] = []
  const wide = !!d.logo && d.logo.width / Math.max(1, d.logo.height) > 2.2
  let y = 300
  // the light that flashes on the lock
  const halo = m.a([[s, j(op(0), tf({ s: 0.75 })), 'p2i'], [LOCK - 0.04, j(op(0.25), tf({ s: 0.9 })), 'p2o'], [LOCK + 0.08, j(op(0.9), tf({ s: 1 })), 'p2o'], [LOCK + 1.5, j(op(0.4), tf({ s: 1.1 }))]])
  const flare = m.a([[s, j(op(0), 'transform:scaleX(.12)'), 'lin'], [LOCK - 0.01, j(op(0), 'transform:scaleX(.12)'), 'p2o'], [LOCK + 0.05, j(op(0.7), 'transform:scaleX(.5)'), 'xo'], [LOCK + 0.9, j(op(0), 'transform:scaleX(1)')]])
  if (d.logo) {
    const lw = wide ? Math.min(760, 220 * (d.logo.width / d.logo.height)) : 260
    const lh = wide ? lw / (d.logo.width / d.logo.height) : 260 / Math.max(d.logo.width / d.logo.height, 1)
    const reveal = m.a([[s + 0.05, j(op(0), tf({ s: 0.62 }), bl(26)), 'p3o'], [LOCK, j(op(1), tf({ s: 1 }), bl(0)), 'p2o'], [LOCK + 0.07, j(op(1), tf({ s: 1.03 }), bl(0)), 'p3o'], [LOCK + 0.8, j(op(1), tf({ s: 1 }), bl(0))]])
    const cy = y + lh / 2
    inner.push(`<i class="glow" style="${box(540 - 520, cy - 420, 1040, 840)};background:radial-gradient(closest-side,${rgba(c.glow, 0.7)},${rgba(c.glow, 0.22)} 45%,${rgba(c.glow, 0)});animation:${halo}"></i>`)
    inner.push(`<i class="flare" style="${box(40, cy - 3, 1000, 6)};animation:${flare}"></i>`)
    const chip = d.logo.treat === 'chip'
    const img = `<img${d.logo.treat === 'tile' ? ' class="tile"' : ''} src="${esc(d.logo.src)}" alt="${esc(d.company)}" style="width:${u(lw)};height:${u(lh)};${d.logo.treat === 'white' ? 'filter:brightness(0) invert(1);' : ''}">`
    inner.push(`<div class="logo${chip ? ' card' : ''}" style="${box(0, y, 1080)};animation:${reveal}">${chip ? `<span>${img}</span>` : img}</div>`)
    y += lh + (chip ? 68 + 64 : 64)
  } else {
    inner.push(`<i class="glow" style="${box(20, y - 260, 1040, 840)};background:radial-gradient(closest-side,${rgba(c.glow, 0.7)},${rgba(c.glow, 0.22)} 45%,${rgba(c.glow, 0)});animation:${halo}"></i>`)
    y += 60
    inner.push(`<i class="flare" style="${box(40, y + z.name * 0.55, 1000, 6)};animation:${flare}"></i>`)
  }
  if (!wide) {
    const at0 = d.logo ? s + 1.1 : s + 0.35
    const step = Math.min(0.04, 0.45 / Math.max([...d.company].length, 1))
    const letters = [...d.company].map((ch, i) => ch === ' ' ? ' ' : `<span style="animation:${m.ft(at0 + i * step, 0.7, j(op(0), 'transform:translateY(42%)', bl(14)), j(op(1), 'transform:translateY(0)', bl(0)), 'xo')}">${esc(ch)}</span>`).join('')
    inner.push(`<div class="name" style="${box(0, y, 1080)};font-size:${u(z.name)}">${letters}</div>`)
    y += z.name * 1.12 + 22
  }
  let t = s + 1.3
  const words = d.cta.line.split(/\s+/).map((w) => { const a = m.ft(t, 0.7, j(op(0), tf({ y: 26 }), bl(8)), j(op(1), tf({ y: 0 }), bl(0)), 'xo'); t += Math.min(0.08, 0.4 / Math.max(d.cta.line.split(/\s+/).length, 1)); return `<span class="wd" style="animation:${a}">${esc(w)}</span>` }).join(' ')
  inner.push(`<div class="cline" style="${box(0, y, 1080)};font-size:${u(z.line)}">${words}</div>`)
  y += z.line * 1.3 + 54
  if (d.cta.offer) {
    const pill = m.ft(s + 1.5, 0.8, j(op(0), tf({ y: 44, s: 0.94 }), bl(6)), j(op(1), tf({ y: 0, s: 1 }), bl(0)), 'xo')
    const sw = m.ft(s + 1.85, 0.5, 'transform:translateX(-120%) skewX(-20deg)', 'transform:translateX(220%) skewX(-20deg)', 'p2io')
    inner.push(`<div class="pillrow" style="${box(0, y, 1080)};animation:${pill}"><span class="pill" style="font-size:${u(z.offer)}">${esc(d.cta.offer)}<i style="animation:${sw}"></i></span></div>`)
    y += z.offer * 2.1 + 40
  }
  if (d.website) inner.push(`<div class="url" style="${box(0, y, 1080)}">${typed(x, d.website, s + 1.8, 0.4)}</div>`)
  // centre the lockup (y is now its bottom)
  const shift = Math.round((PROMO_H - (y + 40 - 300)) / 2 - 300 - 30)
  parts.push(`<div class="cam" style="transform-origin:50% 45%;animation:${cam}"><div class="layer" style="transform:translateY(${u(shift)})">${inner.join('')}</div></div>`)
  return parts.join('')
}

// ── the composition ───────────────────────────────────────────────────────────────────────────────────────────
function sceneMotion(m: Motion, i: number): string {
  const n = STARTS.length
  const stops: Stop[] = []
  const S = (o: { x?: number; s?: number; b?: number; o?: number }) => j(`transform:translate3d(${u(o.x ?? 0)},0,0) scale(${o.s ?? 1})`, bl(o.b ?? 0), op(o.o ?? 1))
  if (i > 0) {
    const seam = SEAMS[i - 1]!, T = STARTS[i]!, L = SEAM_LEN[seam]
    if (seam === 'zoom') stops.push([T, S({ s: 0.5, b: 8, o: 0 }), 'p3o'], [T + L, S({})])
    if (seam === 'push') stops.push([T, S({ x: 1080 }), 'p3io'], [T + L, S({})])
    if (seam === 'blur') stops.push([T, S({ s: 0.97, b: 10, o: 0 }), 'p2io'], [T + L, S({})])
  }
  if (i < n - 1) {
    const seam = SEAMS[i]!, T = STARTS[i + 1]!, L = SEAM_LEN[seam]
    if (!stops.length) stops.push([0, S({}), 'lin'])
    if (seam === 'zoom') stops.push([T, S({}), 'p3i'], [T + L, S({ s: 2.5, b: 8, o: 0 })])
    if (seam === 'push') stops.push([T, S({}), 'p3io'], [T + L, S({ x: -1080 })])
    if (seam === 'blur') stops.push([T, S({}), 'p2io'], [T + L, S({ s: 1.03, b: 10, o: 0 })])
  }
  return m.a(stops)
}

/** The font face of the template: the bundled Pretendard Variable (OFL-1.1), one file for every weight. */
export const PROMO_FONT_FILE = 'PretendardVariable.woff2'
export const PROMO_FONT_FAMILY = 'Pretendard Promo'
export const fontFace = (url: string) => `@font-face{font-family:"${PROMO_FONT_FAMILY}";src:url("${url}") format("woff2");font-weight:45 930;font-style:normal;font-display:block}`

function baseCss(c: Palette, render: boolean): string {
  const grain = `url("data:image/svg+xml,${encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.68' numOctaves='3' stitchTiles='stitch'/></filter><rect width='100%' height='100%' filter='url(#n)'/></svg>")}")`
  return [
    `.pv{--u:calc(100cqw / ${PROMO_W});position:relative;width:100%;height:100%;overflow:hidden;background:${c.ground};container-type:inline-size;color:${c.text};font-family:"${PROMO_FONT_FAMILY}",${render ? '' : '-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Noto Sans KR","Segoe UI",'}sans-serif;-webkit-font-smoothing:antialiased;font-synthesis:none;text-rendering:geometricPrecision}`,
    `.pv *{box-sizing:border-box;margin:0;padding:0}`,
    `.pv .sc{position:absolute;inset:0;overflow:hidden;transform-origin:50% 45%}`,
    `.pv .gnd,.pv .gnd .vig{position:absolute;inset:0}`,
    `.pv .gnd .vig{background:radial-gradient(120% 92% at 50% 44%,rgba(0,0,0,0) 52%,rgba(0,0,0,.66) 100%)}`,
    `.pv .glow,.pv .leak{position:absolute;display:block;pointer-events:none}`,
    `.pv .cam,.pv .layer{position:absolute;inset:0}`,
    `.pv .rule{display:block;background:${c.line};transform-origin:0 50%}`,
    `.pv .label{font-weight:600;letter-spacing:-.02em;line-height:1.15;color:${c.dim};white-space:nowrap}`,
    `.pv .wd{display:inline-block}`,
    `.pv .big-wrap{white-space:nowrap}`,
    `.pv .big{position:relative;display:inline-flex;align-items:baseline;font-weight:900;letter-spacing:-.045em;line-height:1;white-space:nowrap}`,
    `.pv .big>span:not(.nstack){display:inline-block;padding-right:.04em}`,
    `.pv .hot{filter:drop-shadow(0 0 ${u(26)} ${rgba(c.glow, 0.35)}) drop-shadow(0 0 ${u(70)} ${rgba(c.glow, 0.45)})}`,
    `.pv .hot .g{background:linear-gradient(180deg,${c.accentHi} 0%,${c.accent} 55%,${c.accentLo} 100%);-webkit-background-clip:text;background-clip:text;color:transparent}`,
    `.pv .shine{display:inline-block;background:linear-gradient(105deg,${c.text} 0%,${c.text} 34%,#ffffff 45%,${c.accentHi} 50%,#ffffff 55%,${c.text} 66%,${c.text} 100%);background-size:300% 100%;background-position:0% 0;-webkit-background-clip:text;background-clip:text;color:transparent}`,
    `.pv .strike{position:absolute;left:-.06em;right:-.06em;top:52%;height:.075em;border-radius:99px;background:${c.accent};box-shadow:0 0 ${u(16)} ${rgba(c.accent, 0.65)};transform-origin:0 50%}`,
    `.pv .swap{display:inline-grid}`,
    `.pv .sw{grid-area:1/1;display:block;overflow:hidden;padding:0 .06em .1em 0;margin-bottom:-.1em}`,
    `.pv .sw>span{display:block}`,
    `.pv .under{position:absolute;left:0;bottom:-.06em;width:100%;height:.06em;border-radius:99px;background:${c.accent};transform-origin:0 50%;box-shadow:0 0 ${u(14)} ${rgba(c.accent, 0.6)}}`,
    `.pv .foot{font-weight:500;letter-spacing:.02em;color:${c.mute};white-space:nowrap}`,
    `.pv .nstack{display:inline-grid;justify-items:end}`,
    `.pv .nstack>span{grid-area:1/1}`,
    `.pv .cnt.f0::after{content:counter(pvi)}`,
    `.pv .cnt.f1::after{content:counter(pvi) "." counter(pvf)}`,
    `.pv .cnt.f2::after{content:counter(pvi) "." counter(pvf,pv-pad2)}`,
    `.pv .cnt.f3::after{content:counter(pvi) "." counter(pvf,pv-pad3)}`,
    `.pv .num,.pv .big{font-variant-numeric:tabular-nums lining-nums}`,
    `.pv .af{font-size:${AFFIX}em;font-weight:800;letter-spacing:-.03em}`,
    `.pv .un{margin-left:.04em}`,
    `.pv .sep{display:inline-block}`,
    `.pv .hl{font-weight:800;letter-spacing:-.04em;white-space:nowrap;color:${c.text}}`,
    `.pv .hl.center,.pv .sub.center{text-align:center}`,
    `.pv .ln{display:block;white-space:nowrap}`,
    `.pv .w{display:inline-block;overflow:hidden;vertical-align:top;padding:0 .04em .12em;margin:0 -.04em -.12em}`,
    `.pv .wi{display:inline-block}`,
    `.pv .ac{color:${c.accent}}`,
    `.pv--mono .ac{text-shadow:0 0 .3em rgba(255,255,255,.55),0 0 .9em rgba(255,255,255,.25)}`,
    `.pv .sub{font-size:${u(36)};font-weight:500;line-height:1.42;letter-spacing:-.01em;color:${c.dim};word-break:keep-all}`,
    `.pv .bleed{position:absolute;left:0;right:0;bottom:0;overflow:hidden}`,
    `.pv .bleed-in{position:absolute;inset:0}`,
    `.pv .bleed img,.pv .back img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block}`,
    `.pv .bleed-fade{position:absolute;inset:0}`,
    `.pv .leak{mix-blend-mode:screen;filter:blur(${u(40)})}`,
    `.pv .threads{position:absolute;inset:0;width:100%;height:100%;overflow:visible}`,
    `.pv .threads path{fill:none;stroke-linecap:round;stroke-dasharray:1 1}`,
    `.pv .th-glow{stroke:${rgba(c.glow, 0.16)}}`,
    `.pv .th-core{stroke:${c.accent}}`,
    `.pv .sweep{position:absolute;display:block;background:linear-gradient(90deg,rgba(255,255,255,0) 0%,${rgba(c.accentHi, 0.18)} 45%,rgba(255,255,255,.28) 50%,${rgba(c.accentHi, 0.18)} 55%,rgba(255,255,255,0) 100%);mix-blend-mode:screen;filter:blur(${u(30)})}`,
    `.pv .kick{display:flex;align-items:center;gap:${u(16)};font-size:${u(26)};font-weight:700;color:${c.accent};white-space:nowrap}`,
    `.pv .kick>i{display:block;width:${u(36)};height:${u(4)};background:${c.accent};transform-origin:0 50%}`,
    `.pv .backlight{position:absolute;left:${u(-30)};top:${u(-20)};right:${u(-30)};bottom:${u(-20)};border-radius:${u(60)};filter:blur(${u(70)})}`,
    `.pv .win{position:absolute;inset:0;border-radius:${u(18)};overflow:hidden;background:#f6f5f2;box-shadow:0 0 0 ${u(1)} ${rgba('#ffffff', 0.2)},0 ${u(22)} ${u(40)} rgba(0,0,0,.42),0 ${u(60)} ${u(120)} ${u(-10)} rgba(0,0,0,.72)}`,
    `.pv .winbar{display:flex;align-items:center;gap:${u(9)};padding-left:${u(20)};background:#ebeae6;border-bottom:${u(1)} solid rgba(0,0,0,.08)}`,
    `.pv .winbar>i{display:block;width:${u(12)};height:${u(12)};border-radius:50%;background:#cfccc4}`,
    `.pv .addr{margin-left:${u(24)};padding:${u(5)} ${u(18)};border-radius:${u(99)};background:#fff;font-size:${u(18)};font-weight:500;color:#6b6862;letter-spacing:.01em}`,
    `.pv .view{position:relative;overflow:hidden;background:#fff}`,
    `.pv .shot{display:block;position:absolute;left:0;top:0}`,
    `.pv .shade{position:absolute;inset:0;background:linear-gradient(160deg,rgba(0,0,0,.62) 0%,rgba(0,0,0,.28) 55%,rgba(0,0,0,.08) 100%)}`,
    `.pv .pt{position:absolute;display:flex;align-items:center;gap:${u(16)};padding:${u(22)} ${u(30)};border-radius:${u(16)};background:${rgba(c.ground2, 0.92)};border:${u(1)} solid ${c.line};box-shadow:0 ${u(28)} ${u(60)} rgba(0,0,0,.55);font-weight:700;letter-spacing:-.01em;color:${c.text};white-space:nowrap;transform-origin:100% 50%}`,
    `.pv .pt>i{display:block;width:${u(12)};height:${u(12)};border-radius:50%;background:${c.accent};box-shadow:0 0 ${u(12)} ${c.accent}}`,
    `.pv .row{display:flex;align-items:center;gap:${u(30)};padding:0 ${u(40)};border-radius:${u(22)};background:linear-gradient(100deg,${rgba(c.ground2, 0.96)},${rgba(c.ground2, 0.7)});border:${u(1)} solid ${c.line};box-shadow:0 ${u(30)} ${u(70)} rgba(0,0,0,.5);font-weight:700;letter-spacing:-.02em;white-space:nowrap}`,
    `.pv .row>i{display:block;flex:none;width:${u(6)};height:${u(56)};border-radius:${u(3)};background:${c.accent};box-shadow:0 0 ${u(18)} ${c.accent}}`,
    `.pv .back{position:absolute;inset:0;overflow:hidden;opacity:.4;filter:blur(${u(3)}) saturate(.8)}`,
    `.pv .back-fade{position:absolute;inset:0}`,
    `.pv .stat{display:flex;justify-content:center;transform-origin:50% 60%}`,
    `.pv .srule{display:block;background:${c.accent};border-radius:99px;transform-origin:50% 50%}`,
    `.pv .slabel{text-align:center;font-weight:600;letter-spacing:-.02em;color:${c.text};white-space:nowrap}`,
    `.pv .logo{display:flex;justify-content:center;transform-origin:50% 50%}`,
    `.pv .logo img{display:block;object-fit:contain}`,
    `.pv .logo img.tile{object-fit:cover;border-radius:${u(36)};box-shadow:0 ${u(30)} ${u(80)} rgba(0,0,0,.55),0 0 0 ${u(1)} rgba(255,255,255,.18)}`,
    `.pv .logo.card>span{display:block;padding:${u(34)} ${u(44)};border-radius:${u(30)};background:#f7f6f2;box-shadow:0 ${u(30)} ${u(80)} rgba(0,0,0,.55),0 0 0 ${u(1)} rgba(255,255,255,.4)}`,
    `.pv .flare{display:block;background:linear-gradient(90deg,rgba(255,255,255,0),${rgba(c.accentHi, 0.9)} 50%,rgba(255,255,255,0));filter:blur(${u(2)});transform-origin:50% 50%}`,
    `.pv .name{text-align:center;font-weight:800;letter-spacing:-.04em;line-height:1.05;white-space:nowrap}`,
    `.pv .name>span{display:inline-block}`,
    `.pv .cline{text-align:center;font-weight:600;letter-spacing:-.02em;color:${c.dim};white-space:nowrap}`,
    `.pv .pillrow{display:flex;justify-content:center}`,
    `.pv .pill{position:relative;display:inline-block;overflow:hidden;padding:.42em 1.05em;border-radius:${u(14)};background:${c.accent};color:${c.onAccent};font-weight:700;letter-spacing:-.01em;box-shadow:0 0 ${u(40)} ${rgba(c.accent, 0.35)}}`,
    `.pv .pill>i{position:absolute;top:0;bottom:0;left:0;width:40%;background:linear-gradient(90deg,rgba(255,255,255,0),rgba(255,255,255,.55),rgba(255,255,255,0))}`,
    `.pv .horizon{display:block;background:linear-gradient(90deg,${rgba(c.accentHi, 0)},${c.accentHi} 50%,${rgba(c.accentHi, 0)});box-shadow:0 0 ${u(24)} ${rgba(c.accent, 0.9)},0 0 ${u(80)} ${rgba(c.glow, 0.6)};transform-origin:50% 50%}`,
    `.pv .url{text-align:center;font-size:${u(30)};font-weight:500;letter-spacing:.08em;color:${c.mute};white-space:nowrap}`,
    `.pv .grain{position:absolute;left:-50%;top:-50%;width:200%;height:200%;pointer-events:none;opacity:.06;background:${grain};background-size:${u(256)} ${u(256)};z-index:50}`,
    `@keyframes pv-grain{0%,100%{transform:translate(0,0)}10%{transform:translate(-5%,-5%)}20%{transform:translate(-10%,5%)}30%{transform:translate(5%,-10%)}40%{transform:translate(-5%,15%)}50%{transform:translate(-10%,5%)}60%{transform:translate(15%,0)}70%{transform:translate(0,10%)}80%{transform:translate(-15%,0)}90%{transform:translate(10%,5%)}}`,
    `.pv[lang="ko"] .sub{word-break:keep-all}`,
    `@property --pvn{syntax:"<integer>";inherits:false;initial-value:0}`,
    `@counter-style pv-pad2{system:extends decimal;pad:2 "0"}`,
    `@counter-style pv-pad3{system:extends decimal;pad:3 "0"}`,
  ].join('\n')
}

export interface Composition { root: string; css: string; duration: number }

export function composition(doc: VideoDoc, render = false): Composition {
  const fit = fitDoc(doc)
  if (!fit.sizes) throw new Error('promo video does not fit: ' + fit.problems.join('; '))
  const m = new Motion()
  const c = paletteFor(doc.family, doc.brand)
  const x: Ctx = { m, c, doc, sz: fit.sizes }
  const beats = [hook, promise, work, proof, cta]
  const scenes = beats.map((b, i) => `<section class="sc s${i}" style="z-index:${i + 1};animation:${sceneMotion(m, i)}">${b(x)}</section>`).join('')
  const grain = `<i class="grain" style="animation:pv-grain .5s steps(1) 0s ${Math.ceil(DURATION / 0.5)} both"></i>`
  const root = `<div id="promo" class="pv pv--${doc.family}" lang="${esc(doc.lang)}" data-composition-id="promo" data-no-timeline data-start="0" data-duration="${DURATION}" data-width="${PROMO_W}" data-height="${PROMO_H}">${scenes}${grain}</div>`
  return { root, css: baseCss(c, render) + '\n' + m.rules.join('\n'), duration: DURATION }
}

/** The standalone document for the HyperFrames render: fonts, pictures and sounds beside it, relative paths. */
export function renderDocument(doc: VideoDoc, fontUrl: string, audio: { cues: AudioCue[]; url: (file: string) => string; durationOf: (file: string) => number } | null): string {
  const c = composition(doc, true)
  const sounds = audio ? audio.cues.map((a) => `<audio id="${a.id}" src="${esc(audio.url(a.file))}" data-start="${a.start}" data-duration="${r3(Math.min(audio.durationOf(a.file), DURATION - a.start))}" data-track-index="${a.id === 'bed' ? 10 : 20}" data-volume="${a.volume}"></audio>`).join('') : ''
  const root = c.root.replace(/<\/div>$/, `${sounds}</div>`)
  return `<!doctype html><html lang="${esc(doc.lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=${PROMO_W}, height=${PROMO_H}"><title>promo</title><style>${fontFace(fontUrl)}html,body{margin:0;width:${PROMO_W}px;height:${PROMO_H}px;overflow:hidden;background:#000}\n${c.css}</style></head><body>${root}</body></html>`
}

export interface PlayerText { play: string; pause: string; soundOn: string; soundOff: string; stills: string }

/**
 * The page the chat shows (an artifact): the composition in a 4:5 stage that fills the panel's width, a slim bar under
 * it (play / pause, progress, time, sound) and a small script that runs every animation from one clock on a loop (it
 * starts once the font is in, at most 1.5 s later). The video plays muted (browsers allow that without a click); the
 * sound button loads the music and the effects from this server's /vendor/promo-video/ (scripts holding the audio as
 * data: addresses, the only way a sound reaches this frame) and keeps them on the same clock. With reduced motion the
 * page shows the five settled beats as stills instead. No network beyond /vendor/.
 */
export function artifactDocument(doc: VideoDoc, o: { fontCss: string; audioBase: string; cues: AudioCue[]; text: PlayerText; title: string }): string {
  const c = composition(doc)
  const t = o.text
  const icons = {
    pause: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="2" width="3.5" height="12" rx="1"/><rect x="9.5" y="2" width="3.5" height="12" rx="1"/></svg>',
    play: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.2v11.6c0 .6.7 1 1.2.6l9-5.8c.5-.3.5-1 0-1.3l-9-5.8C4.7 1.2 4 1.6 4 2.2z"/></svg>',
    muted: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 6h2.5L8 3v10L4.5 10H2z"/><path d="M10.5 6l4 4m0-4l-4 4" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round"/></svg>',
    sound: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 6h2.5L8 3v10L4.5 10H2z"/><path d="M10.5 5.5a3.5 3.5 0 010 5M12.5 3.5a6.3 6.3 0 010 9" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round"/></svg>',
  }
  const player = `
.pv-wrap{max-width:560px;margin:0 auto;padding:12px 12px 16px;font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Noto Sans KR","Segoe UI",sans-serif}
.pv-stage{position:relative;width:100%;aspect-ratio:4/5;container-type:inline-size;border-radius:10px;overflow:hidden;background:#000;cursor:pointer;box-shadow:0 1px 2px rgba(0,0,0,.08),0 8px 28px rgba(0,0,0,.10)}
.pv-stage>.pv{position:absolute;inset:0}
.pv-bar{display:flex;align-items:center;gap:10px;margin-top:10px;color:#57534e;font-size:12px}
.pv-bar button{all:unset;display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:999px;background:#1c1917;color:#fff;cursor:pointer;flex:none}
.pv-bar button.pv-snd{background:transparent;color:#1c1917;box-shadow:inset 0 0 0 1px #d6d3d1}
.pv-bar button:focus-visible{outline:2px solid #1c1917;outline-offset:2px}
.pv-bar svg{width:15px;height:15px;fill:currentColor}
.pv-track{position:relative;flex:1;height:4px;border-radius:99px;background:#e7e5e4;overflow:hidden}
.pv-track>i{position:absolute;inset:0;transform-origin:left center;transform:scaleX(0);background:#1c1917}
.pv-time{font-variant-numeric:tabular-nums;min-width:70px;text-align:right}
.pv-stills{display:none;gap:12px}
.pv-stills .pv-stage{cursor:default}
.pv-stills p{margin:6px 0 2px;font-size:12px;color:#57534e}
html.pv-rm .pv-player{display:none}
html.pv-rm .pv-stills{display:grid}
`
  const script = `(function(){
var D=${DURATION},S=${JSON.stringify(SETTLED)},CUES=${JSON.stringify(o.cues.map((q) => ({ f: q.file, s: q.start, v: q.volume })))},BASE=${JSON.stringify(o.audioBase)};
var root=document.documentElement,wrap=document.querySelector(".pv-wrap"),stage=document.querySelector(".pv-player .pv-stage"),btn=document.querySelector(".pv-pp"),snd=document.querySelector(".pv-snd"),bar=document.querySelector(".pv-track>i"),time=document.querySelector(".pv-time");
var L=${JSON.stringify({ play: t.play, pause: t.pause, on: t.soundOn, off: t.soundOff })},I=${JSON.stringify(icons)};
function anims(el){return document.getAnimations?document.getAnimations().filter(function(a){return el.contains(a.effect&&a.effect.target)}):[]}
function seekAll(list,x){for(var i=0;i<list.length;i++){try{list[i].pause();list[i].currentTime=x*1000}catch(e){}}}
var rm=window.matchMedia&&window.matchMedia("(prefers-reduced-motion: reduce)").matches;
if(rm){root.classList.add("pv-rm");var box=document.querySelector(".pv-stills");for(var k=0;k<S.length;k++){var st=document.createElement("div");st.className="pv-stage";st.appendChild(stage.firstElementChild.cloneNode(true));st.firstChild.removeAttribute("id");var cap=document.createElement("p");cap.textContent=${JSON.stringify(t.stills)}.replace("{n}",String(k+1));var cell=document.createElement("div");cell.appendChild(st);cell.appendChild(cap);box.appendChild(cell);seekAll(anims(st),S[k]);}return;}
var list=[],t=0,last=null,playing=false,sound=false,bed=null,fx={},prev=0;
function fmt(x){x=Math.floor(x);return "0:"+(x<10?"0":"")+x}
function seek(x){seekAll(list,x);bar.style.transform="scaleX("+(x/D)+")";time.textContent=fmt(x)+" / "+fmt(D);}
function audio(x,wrapped){if(!sound||!bed)return;if(!playing){bed.pause();return}
if(wrapped)bed.currentTime=0;else if(Math.abs(bed.currentTime-x)>0.25)bed.currentTime=x;if(bed.paused){var p=bed.play();if(p&&p.catch)p.catch(function(){})}
for(var i=0;i<CUES.length;i++){var q=CUES[i];if(q.f.indexOf("bed-")===0)continue;if((wrapped?q.s<=x:prev<q.s&&q.s<=x)&&fx[q.f]){var e=fx[q.f].cloneNode();e.volume=q.v;var r=e.play();if(r&&r.catch)r.catch(function(){})}}}
function frame(now){if(!playing){last=null;return}var w=false;if(last!==null)t+=(now-last)/1000;last=now;if(t>=D){t=t%D;w=true}seek(t);audio(t,w);prev=t;requestAnimationFrame(frame)}
function set(p){playing=p;btn.innerHTML=p?I.pause:I.play;btn.setAttribute("aria-label",p?L.pause:L.play);if(p){last=null;requestAnimationFrame(frame)}else if(bed)bed.pause()}
function load(name,cb){var A=window.__pvAudio=window.__pvAudio||{};if(A[name])return cb(A[name]);var s=document.createElement("script");s.src=BASE+name+".js";s.onload=function(){cb(A[name])};s.onerror=function(){cb(null)};document.head.appendChild(s)}
function setSound(on){sound=on;snd.innerHTML=on?I.sound:I.muted;snd.setAttribute("aria-label",on?L.off:L.on);snd.setAttribute("aria-pressed",on?"true":"false");if(!on){if(bed)bed.pause();return}
var need={};for(var i=0;i<CUES.length;i++)need[CUES[i].f]=CUES[i].v;Object.keys(need).forEach(function(f){if(f.indexOf("bed-")===0){if(bed)return;load(f,function(u){if(!u)return;bed=new Audio(u);bed.volume=need[f];bed.preload="auto";prev=t;audio(t,false)})}else if(!fx[f])load(f,function(u){if(u)fx[f]=new Audio(u)})});if(!playing)set(true)}
btn.addEventListener("click",function(e){e.stopPropagation();set(!playing)});
snd.addEventListener("click",function(e){e.stopPropagation();setSound(!sound)});
stage.addEventListener("click",function(){set(!playing)});
var started=false;function go(){if(started)return;started=true;list=anims(stage);seek(0);set(true)}
try{document.fonts.ready.then(go)}catch(e){go()}
setTimeout(go,1500);
})();`
  return `<!doctype html><html lang="${esc(doc.lang)}"><head><meta charset="utf-8"><title>${esc(o.title)}</title><link rel="stylesheet" href="${esc(o.fontCss)}"><style>body{margin:0;background:#fff}${player}\n${c.css}</style></head><body><div class="pv-wrap"><div class="pv-player"><div class="pv-stage" role="img" aria-label="${esc(o.title)}">${c.root}</div><div class="pv-bar"><button type="button" class="pv-pp" aria-label="${esc(t.pause)}">${icons.pause}</button><div class="pv-track"><i></i></div><span class="pv-time">0:00 / 0:${String(Math.floor(DURATION)).padStart(2, '0')}</span><button type="button" class="pv-snd" aria-pressed="false" aria-label="${esc(t.soundOn)}">${icons.muted}</button></div></div><div class="pv-stills"></div></div><script>${script}</script></body></html>`
}
