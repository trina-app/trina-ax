// The promo video templates (docs/DECISIONS.md "V — The first result is the company's promo video"). The AI never
// writes this HTML: it fills slots (promo-video/spec.ts checks them), and this file builds a HyperFrames composition
// from them: one 1080×1350 (4:5) root, five scenes on one clock, every motion a CSS animation with a fixed delay, so the
// same document plays in a browser as it is and renders frame by frame with HyperFrames (its CSS adapter seeks each
// animation to the frame's time; all of them hang off the root, data-start 0).
//
// - Three styles: bold (brand-coloured panels, heavy type, upward reveals), editorial (paper, a running header, wipes
//   and fades), night (dark, a brand glow, blur-in type). Each scene has a photo layout and a type-only layout; text
//   always sits on a solid area, never on a photo. No shape is ever data: a disc, a bar, a line.
// - Kinetic type: each headline line rises from a mask (night: blurs in), staggered; the proof number rolls digit by
//   digit to the number written in the material; the last scene locks the logo up with the company's name.
// - Sizes are design pixels times `--u` (1/1080 of the root's width, container units), so the video fills any width.
// - The visible end of every scene is its plain CSS: animations only say where things come from (`from` keyframes,
//   fill both). With the animations off, each scene is a finished card (the reduced-motion view, the stills).
import { BRAND, layoutFor, photoExtra, sceneTimes, type PromoDoc, type PromoScene, type PromoStyle, type SceneLayout, type TextBox } from './layout'
import { INK, WHITE } from './colors'

export const PROMO_W = 1080
export const PROMO_H = 1350

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const u = (n: number) => `calc(${n} * var(--u))`
const s2 = (n: number) => `${Math.round(n * 1000) / 1000}s`

/** The font face of the templates: the bundled Pretendard Variable (OFL-1.1), one file for every weight. */
export const PROMO_FONT_FILE = 'PretendardVariable.woff2'
export const PROMO_FONT_FAMILY = 'Pretendard Promo'
export const fontFace = (url: string) =>
  `@font-face{font-family:"${PROMO_FONT_FAMILY}";src:url("${url}") format("woff2");font-weight:45 930;font-style:normal;font-display:block}`

const EASE = {
  expo: 'cubic-bezier(.16,1,.3,1)',
  quart: 'cubic-bezier(.25,1,.5,1)',
  back: 'cubic-bezier(.34,1.56,.64,1)',
  inout: 'cubic-bezier(.65,0,.35,1)',
  out: 'cubic-bezier(.33,1,.68,1)',
}

/** One animation: name, length, easing, the delay after the scene's start (the scene's own `--s`). */
const anim = (name: string, dur: number, ease: keyof typeof EASE | 'linear', at: number, fill = 'both') =>
  `${name} ${s2(dur)} ${ease === 'linear' ? 'linear' : EASE[ease]} calc(var(--s) + ${s2(at)}) ${fill}`

function css(doc: PromoDoc, L: SceneLayout[], render: boolean): string {
  const c = BRAND(doc)
  const st = doc.style
  const { times, transition: T } = sceneTimes()
  const lines = [
    `.pv{--u:calc(100cqw / ${PROMO_W});position:relative;width:100%;height:100%;overflow:hidden;background:${c.base};container-type:inline-size;font-family:"${PROMO_FONT_FAMILY}",${render ? '' : '-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Noto Sans KR","Segoe UI",'}sans-serif;-webkit-font-smoothing:antialiased;font-synthesis:none;text-rendering:optimizeLegibility}`,
    `.pv *{box-sizing:border-box;margin:0;padding:0}`,
    `.pv .sc{position:absolute;inset:0;overflow:hidden;contain:strict;clip-path:inset(0 0 0 0)}`,
    `.pv .tx{position:absolute;display:flex;flex-direction:column}`,
    `.pv .ey{display:flex;align-items:center;gap:${u(14)};white-space:nowrap}`,
    `.pv .hl{display:flex;flex-direction:column;white-space:nowrap}`,
    `.pv .ln{display:block;overflow:hidden;padding:0 .06em .14em;margin:0 -.06em -.14em}`,
    `.pv .ln>span{display:block}`,
    `.pv .sb{text-wrap:balance}`,
    `.pv[lang="ko"] .sb,.pv[lang="ko"] .hl{word-break:keep-all}`,
    `.pv .ph{position:absolute;overflow:hidden;clip-path:inset(0 0 0 0)}`,
    `.pv .ph img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block}`,
    `.pv .logo{display:flex;align-items:center;justify-content:center;background:#fff;border-radius:${u(24)};box-shadow:0 ${u(10)} ${u(40)} rgba(0,0,0,.14)}`,
    `.pv .logo img{display:block;object-fit:contain}`,
    `.pv .wm{font-weight:800;letter-spacing:-.03em;white-space:nowrap}`,
    `.pv .num{display:flex;align-items:flex-start;white-space:nowrap;font-variant-numeric:tabular-nums lining-nums;line-height:1}`,
    `.pv .dg{display:inline-block;height:1em;overflow:hidden}`,
    `.pv .dg>i{display:block;font-style:normal;transform:translateY(calc(var(--k) * -1em))}`,
    `.pv .dg>i>b{display:block;height:1em;font-weight:inherit;text-align:center}`,
    `.pv .shape{position:absolute;display:block}`,
    // where things come from (every keyframe is a `from`: the plain CSS is the finished card)
    `@keyframes pv-up{from{transform:translateY(112%)}}`,
    `@keyframes pv-rise{from{opacity:0;transform:translateY(${u(30)})}}`,
    `@keyframes pv-fade{from{opacity:0}}`,
    `@keyframes pv-zoom{from{transform:scale(1.14)}}`,
    `@keyframes pv-zoom-out{from{transform:scale(1.06)}}`,
    `@keyframes pv-roll{from{transform:translateY(0)}}`,
    `@keyframes pv-pop{from{opacity:0;transform:scale(.55)}}`,
    `@keyframes pv-grow-x{from{transform:scaleX(0)}}`,
    `@keyframes pv-grow-y{from{transform:scaleY(0)}}`,
    `@keyframes pv-blur{from{opacity:0;filter:blur(${u(18)});transform:translateY(${u(22)})}}`,
    `@keyframes pv-wipe-down{from{clip-path:inset(0 0 100% 0)}}`,
    `@keyframes pv-wipe-right{from{clip-path:inset(0 100% 0 0)}}`,
    `@keyframes pv-panel-up{from{transform:translateY(102%)}}`,
    `@keyframes pv-slide-in{from{opacity:0;transform:translateX(${u(-36)})}}`,
    `@keyframes pv-drift{from{transform:translate(${u(-60)},${u(40)}) scale(.86)}}`,
    `@keyframes pv-glow{from{opacity:0;transform:scale(.7)}}`,
    // night's progress hairline, scene by scene
    ...[0, 1, 2, 3, 4].map((k) => `@keyframes pv-p${k}{from{transform:scaleX(${k / 5})}}`),
    // night: a fine film grain over every scene (a still noise picture, no network)
    st === 'night' ? `.pv .sc::before{content:"";position:absolute;inset:0;z-index:5;pointer-events:none;opacity:.09;mix-blend-mode:overlay;background-size:${u(260)} ${u(260)};background-image:url("data:image/svg+xml,${encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' width='260' height='260'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 .9 0'/></filter><rect width='100%' height='100%' filter='url(#n)'/></svg>")}")}` : '',
    // scenes come and go (the last scene stays)
    st === 'bold' ? `@keyframes pv-in{from{clip-path:inset(100% 0 0 0)}}@keyframes pv-out{to{transform:translateY(${u(-150)})}}`
      : st === 'editorial' ? `@keyframes pv-in{from{opacity:0}}@keyframes pv-out{to{opacity:0;transform:translateY(${u(-40)})}}`
        : `@keyframes pv-in{from{opacity:0;transform:scale(1.05);filter:blur(${u(12)})}}@keyframes pv-out{to{opacity:0;transform:scale(.96)}}`,
    `.pv .sc.go-out::after{content:"";position:absolute;inset:0;background:#000;opacity:0;pointer-events:none}`,
    `@keyframes pv-dim{to{opacity:${st === 'bold' ? 0.45 : 0}}}`,
    // the stills: every animation off, the finished card
    `.pv.still .sc,.pv.still .sc *,.pv.still .sc::after{animation:none!important}`,
    `.pv.still .sc::after{display:none}`,
  ]
  // the darkening of a scene as the next one covers it (a pseudo-element: its animation lives here, with plain times)
  times.slice(0, -1).forEach(([, e], i) => lines.push(`.pv .s${i}::after{animation:pv-dim ${s2(T)} ${EASE.inout} ${s2(e - T)} forwards}`))
  // colours of the style
  lines.push(`.pv{--brand:${c.brand};--on-brand:${c.onBrand};--brand-ink:${c.brandInk};--brand-light:${c.brandLight};--paper:${c.paper};--ink:${INK};--white:${WHITE}}`)
  // each text box: its place and its type
  L.forEach((l, i) => { for (const b of l.boxes) lines.push(boxCss(i, b)) })
  return lines.join('\n')
}

function boxCss(i: number, b: TextBox): string {
  const sel = `.pv .s${i} .${b.cls}`
  const p: string[] = []
  if (b.left !== undefined) p.push(`left:${u(b.left)}`)
  if (b.right !== undefined) p.push(`right:${u(b.right)}`)
  if (b.top !== undefined) p.push(`top:${u(b.top)}`)
  if (b.bottom !== undefined) p.push(`bottom:${u(b.bottom)}`)
  if (b.width !== undefined) p.push(`width:${u(b.width)}`)
  if (b.height !== undefined) p.push(`height:${u(b.height)}`)
  if (b.align) p.push(`align-items:${b.align === 'center' ? 'center' : 'flex-start'};text-align:${b.align}`)
  if (b.justify) p.push(`justify-content:${b.justify}`)
  if (b.gap !== undefined) p.push(`gap:${u(b.gap)}`)
  if (b.color) p.push(`color:${b.color}`)
  return `${sel}{${p.join(';')}}`
}

/** "1,200곳" → static characters and rolling digits; each digit column ends on its own digit. */
function numberHtml(n: string, delay: number, step: number, dur: number): string {
  let col = 0
  const digits = [...n].filter((ch) => /[0-9]/.test(ch)).length
  return [...n].map((ch) => {
    if (!/[0-9]/.test(ch)) return `<span class="nc">${esc(ch)}</span>`
    const d = Number(ch)
    // the leftmost columns turn one more round: the number counts up from the left
    const rounds = col < digits - 1 ? 2 : 1
    const strip = Array.from({ length: rounds * 10 + d + 1 }, (_, k) => `<b>${k % 10}</b>`).join('')
    const k = rounds * 10 + d
    const at = delay + col * step
    col++
    return `<span class="dg"><i style="--k:${k};animation:${anim('pv-roll', dur + (digits - col) * 0.08, 'expo', at)}">${strip}</i></span>`
  }).join('')
}

const lineSpans = (lines: string[], style: PromoStyle, at: number, step: number) => lines.map((l, j) => {
  const a = style === 'night' ? anim('pv-blur', 0.9, 'out', at + j * step) : anim('pv-up', style === 'editorial' ? 0.95 : 0.8, 'expo', at + j * step)
  return `<span class="ln"><span style="animation:${a}">${esc(l)}</span></span>`
}).join('')

function picture(cls: string, src: string, focus: string, reveal: string, at: number, dur: number, extra: string): string {
  return `<div class="ph ${cls}" style="${extra ? extra + ';' : ''}animation:${reveal}"><img src="${esc(src)}" alt="" style="object-position:${focus};animation:${anim('pv-zoom', dur, 'out', at)}"></div>`
}

/** The logo on its white tile (or the company's name as a wordmark when there is no logo). */
function logoHtml(doc: PromoDoc, l: SceneLayout, color: string, a: string): string {
  if (doc.logo && l.logo) {
    return `<div class="logo" style="width:${u(l.logo.tileW)};height:${u(l.logo.tileH)};animation:${a}"><img src="${esc(doc.logo.src)}" alt="${esc(doc.company)}" style="width:${u(l.logo.imgW)};height:${u(l.logo.imgH)}"></div>`
  }
  return `<div class="wm" style="font-size:${u(l.wordmark)};color:${color};animation:${a}">${esc(doc.company)}</div>`
}

function sceneHtml(doc: PromoDoc, s: PromoScene, i: number, l: SceneLayout, times: [number, number][], T: number): string {
  const [start, end] = times[i]!
  const dur = end - start
  const st = doc.style
  const last = i === times.length - 1
  const cls = ['sc', `s${i}`, `k-${s.kind}`, l.photo ? 'v-photo' : 'v-type', i > 0 ? 'go-in' : '', !last ? 'go-out' : ''].filter(Boolean).join(' ')
  const parts: string[] = []
  // background and shapes
  parts.push(...l.shapes.map((sh) => `<span class="shape" style="${sh.css};animation:${sh.anim}"></span>`))
  if (l.photo && s.picture) {
    const reveal = l.photo.reveal === 'none' ? 'none' : anim(l.photo.reveal, l.photo.reveal === 'pv-fade' ? 1.2 : 1.0, 'expo', 0)
    parts.push(picture(`p${i}`, s.picture.src, s.picture.focus, reveal, 0, dur + 0.4, photoExtra(st, s.kind)))
  }
  if (l.panel) parts.push(`<span class="shape" style="${l.panel.css};animation:${anim('pv-panel-up', 0.85, 'expo', 0.05)}"></span>`)
  // the running header (editorial)
  if (l.header) parts.push(l.header)
  const tx = l.boxes.find((b) => b.cls === 'tx')!
  const d = l.textDelay
  const inner: string[] = []
  if (l.logoInText) inner.push(`<div style="margin-bottom:${u(52)}">${logoHtml(doc, l, tx.color ?? l.headline.color, anim('pv-pop', 0.75, 'back', d + 0.15))}</div>`)
  if (s.eyebrow) {
    const mark = l.eyebrowMark ? `<span style="display:block;width:${u(l.eyebrowMark.w)};height:${u(l.eyebrowMark.h)};background:${l.eyebrowMark.color};border-radius:${u(l.eyebrowMark.r)};transform-origin:left center;animation:${anim('pv-grow-x', 0.6, 'expo', d + 0.1)}"></span>` : ''
    inner.push(`<div class="ey" style="font-size:${u(l.eyebrow.size)};font-weight:${l.eyebrow.weight};letter-spacing:${l.eyebrow.tracking}em;color:${l.eyebrow.color};animation:${anim(st === 'night' ? 'pv-blur' : 'pv-slide-in', 0.6, 'expo', d + 0.12)}">${mark}<span>${esc(l.eyebrow.text)}</span></div>`)
  }
  if (s.kind === 'proof' && s.number && l.number) {
    if (l.number.highlight) inner.push(`<span style="display:block;position:relative;height:0"><span style="position:absolute;left:${u(-12)};top:${u(l.number.mt + l.number.size * 0.52)};width:${u(Math.min(940, (l.number.size * 0.66) * [...s.number].length + 40))};height:${u(l.number.size * 0.36)};background:${l.number.highlight};transform-origin:left center;animation:${anim('pv-grow-x', 0.8, 'expo', d + 1.2)}"></span></span>`)
    inner.push(`<div class="num" style="position:relative;font-size:${u(l.number.size)};font-weight:${l.number.weight};letter-spacing:${l.number.tracking}em;color:${l.number.color};${l.number.glow ? `filter:drop-shadow(0 0 ${u(26)} ${l.number.glow});` : ''}margin:${u(l.number.mt)} 0 ${u(l.number.mb)}">${numberHtml(s.number, d + 0.28, 0.06, 1.35)}</div>`)
    if (l.number.rule) inner.push(`<span style="display:block;flex:none;margin-bottom:${u(26)};width:${u(l.number.rule.w)};height:${u(l.number.rule.h)};background:${l.number.rule.color};transform-origin:${l.number.rule.origin};animation:${anim('pv-grow-x', 0.9, 'expo', d + 0.5)}"></span>`)
    if (s.label) inner.push(`<p style="font-size:${u(l.label!.size)};font-weight:${l.label!.weight};letter-spacing:-.01em;line-height:1.3;color:${l.label!.color};animation:${anim('pv-rise', 0.6, 'expo', d + 0.55)}">${esc(s.label)}</p>`)
  }
  inner.push(`<h2 class="hl" style="font-size:${u(l.headline.size)};font-weight:${l.headline.weight};letter-spacing:${l.headline.tracking}em;line-height:${l.headline.lh};color:${l.headline.color};margin-top:${u(l.headline.mt)}">${lineSpans(s.headline, st, d + (s.kind === 'proof' && s.number ? 0.5 : s.kind === 'cta' ? 0.4 : 0.22), st === 'editorial' ? 0.12 : 0.09)}</h2>`)
  if (s.sub) inner.push(`<p class="sb" style="font-size:${u(l.sub.size)};font-weight:${l.sub.weight};line-height:${l.sub.lh};letter-spacing:-.01em;color:${l.sub.color};max-width:${u(l.sub.width)};margin-top:${u(l.sub.mt)};animation:${anim(st === 'night' ? 'pv-blur' : 'pv-rise', 0.7, 'expo', d + (s.kind === 'proof' && s.number ? 0.8 : s.kind === 'cta' ? 0.75 : 0.62))}">${esc(s.sub)}</p>`)
  if (s.kind === 'cta' && doc.website && l.website) {
    inner.push(`<p style="margin-top:${u(l.website.mt)};font-size:${u(l.website.size)};font-weight:600;letter-spacing:-.005em;color:${l.website.color};${l.website.pill ? `border:${u(3)} solid ${l.website.pill};border-radius:${u(999)};padding:${u(16)} ${u(34)};` : ''}${l.website.underline ? `text-decoration:underline;text-decoration-thickness:${u(3)};text-underline-offset:${u(10)};` : ''}animation:${anim('pv-rise', 0.7, 'expo', d + 1.0)}">${esc(doc.website)}</p>`)
  }
  parts.push(`<div class="tx">${inner.join('')}</div>`)
  if (l.logoCorner) parts.push(`<div style="position:absolute;left:${u(l.logoCorner.left)};top:${u(l.logoCorner.top)}">${logoHtml(doc, l, l.logoCorner.color, anim('pv-fade', 0.6, 'out', 0.35))}</div>`)
  if (l.logoFloat) parts.push(`<div style="position:absolute;left:0;right:0;top:${u(l.logoFloat.top)};display:flex;justify-content:center">${logoHtml(doc, l, l.logoFloat.color, anim('pv-pop', 0.75, 'back', 0.2))}</div>`)
  const sceneAnims = [
    i > 0 ? `pv-in ${s2(T)} ${st === 'bold' ? EASE.inout : EASE.out} ${s2(start)} both` : '',
    !last ? `pv-out ${s2(T)} ${EASE.inout} ${s2(end - T)} forwards` : '',
  ].filter(Boolean).join(',')
  const html = `<section class="${cls}" style="background:${l.bg}${sceneAnims ? `;animation:${sceneAnims}` : ''}" data-kind="${s.kind}">${parts.join('')}</section>`
  // every delay as a plain number of seconds from the start (the HyperFrames CSS adapter rewrites animation-delay of
  // inline styles, which would drop a delay written with var())
  return html.replace(/calc\(var\(--s\) \+ (-?[\d.]+)s\)/g, (_, x: string) => s2(start + Number(x)))
}

export interface Composition {
  /** the composition root and its style (no document around it) */
  root: string
  css: string
  duration: number
}

/** The composition (the root element and its CSS) for a checked document. */
export function composition(doc: PromoDoc, render = false): Composition {
  const { times, transition, duration } = sceneTimes()
  const L = doc.scenes.map((s, i) => layoutFor(doc, s, i))
  const scenes = doc.scenes.map((s, i) => sceneHtml(doc, s, i, L[i]!, times, transition)).join('')
  const root = `<div id="promo" class="pv pv--${doc.style}" lang="${doc.lang}" data-composition-id="promo" data-no-timeline data-start="0" data-duration="${duration}" data-width="${PROMO_W}" data-height="${PROMO_H}">${scenes}</div>`
  return { root, css: css(doc, L, render), duration }
}

/** A standalone HTML document for the HyperFrames render (fonts and pictures beside it, relative paths). */
export function renderDocument(doc: PromoDoc, fontUrl: string): string {
  const c = composition(doc, true)
  return `<!doctype html><html lang="${doc.lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=${PROMO_W}, height=${PROMO_H}"><title>promo</title><style>${fontFace(fontUrl)}html,body{margin:0;width:${PROMO_W}px;height:${PROMO_H}px;overflow:hidden;background:#000}\n${c.css}</style></head><body>${c.root}</body></html>`
}

export interface PlayerText { play: string; pause: string; replay: string; stills: string; scene: (n: number) => string }

/**
 * The page the chat shows (an artifact): the same composition in a 4:5 stage that fills the panel's width, a slim bar
 * under it (play / pause, the time), and a small script that runs every animation from one clock on a loop (the page
 * starts once the fonts are in, at most 1.5 s later). With reduced motion the script shows the five finished scenes as
 * cards instead. No network: the font comes from this server's /vendor/ (the frame allows nothing else), the pictures
 * are team files the chat inlines (lib/frame-files.ts).
 */
export function artifactDocument(doc: PromoDoc, o: { fontCss: string; text: PlayerText; title: string }): string {
  const c = composition(doc)
  const t = o.text
  const player = `
.pv-wrap{max-width:560px;margin:0 auto;padding:12px 12px 16px;font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Noto Sans KR","Segoe UI",sans-serif}
.pv-stage{position:relative;width:100%;aspect-ratio:4/5;container-type:inline-size;border-radius:10px;overflow:hidden;background:#000;cursor:pointer;box-shadow:0 1px 2px rgba(0,0,0,.08),0 8px 28px rgba(0,0,0,.10)}
.pv-stage>.pv{position:absolute;inset:0}
.pv-bar{display:flex;align-items:center;gap:10px;margin-top:10px;color:#57534e;font-size:12px}
.pv-bar button{all:unset;display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:999px;background:#1c1917;color:#fff;cursor:pointer;flex:none}
.pv-bar button:focus-visible{outline:2px solid #1c1917;outline-offset:2px}
.pv-bar svg{width:14px;height:14px;fill:currentColor}
.pv-track{position:relative;flex:1;height:4px;border-radius:99px;background:#e7e5e4;overflow:hidden}
.pv-track>i{position:absolute;inset:0;transform-origin:left center;transform:scaleX(0);background:#1c1917}
.pv-time{font-variant-numeric:tabular-nums;min-width:76px;text-align:right}
.pv-stills{display:none;gap:12px}
.pv-stills .pv-stage{cursor:default}
.pv-stills p{margin:6px 0 2px;font-size:12px;color:#57534e}
html.pv-rm .pv-player{display:none}
html.pv-rm .pv-stills{display:grid}
`
  const icons = {
    pause: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="2" width="3.5" height="12" rx="1"/><rect x="9.5" y="2" width="3.5" height="12" rx="1"/></svg>',
    play: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.2v11.6c0 .6.7 1 1.2.6l9-5.8c.5-.3.5-1 0-1.3l-9-5.8C4.7 1.2 4 1.6 4 2.2z"/></svg>',
  }
  const script = `(function(){
var D=${c.duration},root=document.documentElement,wrap=document.querySelector(".pv-wrap"),stage=document.querySelector(".pv-player .pv-stage"),btn=document.querySelector(".pv-pp"),bar=document.querySelector(".pv-track>i"),time=document.querySelector(".pv-time");
var L=${JSON.stringify({ play: t.play, pause: t.pause })},I=${JSON.stringify(icons)};
var rm=window.matchMedia&&window.matchMedia("(prefers-reduced-motion: reduce)").matches;
function stills(){var box=document.querySelector(".pv-stills");if(box.childNodes.length)return;var scenes=stage.querySelectorAll(".sc");for(var i=0;i<scenes.length;i++){var st=document.createElement("div");st.className="pv-stage";var pv=stage.firstElementChild.cloneNode(false);pv.classList.add("still");pv.removeAttribute("id");pv.removeAttribute("data-composition-id");var sc=scenes[i].cloneNode(true);sc.classList.remove("go-in","go-out");pv.appendChild(sc);st.appendChild(pv);var cap=document.createElement("p");cap.textContent=${JSON.stringify(t.stills)}.replace("{n}",String(i+1));var cell=document.createElement("div");cell.appendChild(st);cell.appendChild(cap);box.appendChild(cell);}}
if(rm){root.classList.add("pv-rm");stills();return;}
var anims=[],t=0,last=null,playing=false;
function grab(){anims=document.getAnimations?document.getAnimations().filter(function(a){return stage.contains(a.effect&&a.effect.target)}):[];for(var i=0;i<anims.length;i++)anims[i].pause();}
function seek(x){for(var i=0;i<anims.length;i++){try{anims[i].currentTime=x*1000}catch(e){}}bar.style.transform="scaleX("+(x/D)+")";time.textContent=fmt(x)+" / "+fmt(D);}
function fmt(x){x=Math.floor(x);return "0:"+(x<10?"0":"")+x}
function frame(now){if(!playing){last=null;return}if(last!==null)t+=(now-last)/1000;last=now;if(t>=D)t=t%D;seek(t);requestAnimationFrame(frame)}
function set(p){playing=p;wrap.classList.toggle("pv-paused",!p);btn.innerHTML=p?I.pause:I.play;btn.setAttribute("aria-label",p?L.pause:L.play);if(p){last=null;requestAnimationFrame(frame)}}
btn.addEventListener("click",function(e){e.stopPropagation();set(!playing)});
stage.addEventListener("click",function(){set(!playing)});
var started=false;function go(){if(started)return;started=true;grab();seek(0);set(true)}
try{document.fonts.ready.then(go)}catch(e){go()}
setTimeout(go,1500);
})();`
  return `<!doctype html><html lang="${doc.lang}"><head><meta charset="utf-8"><title>${esc(o.title)}</title><link rel="stylesheet" href="${esc(o.fontCss)}"><style>body{margin:0;background:#fff}${player}\n${c.css}</style></head><body><div class="pv-wrap"><div class="pv-player"><div class="pv-stage" role="img" aria-label="${esc(o.title)}">${c.root}</div><div class="pv-bar"><button type="button" class="pv-pp" aria-label="${esc(t.pause)}">${icons.pause}</button><div class="pv-track"><i></i></div><span class="pv-time">0:00 / 0:${String(Math.floor(c.duration)).padStart(2, '0')}</span></div></div><div class="pv-stills"></div></div><script>${script}</script></body></html>`
}
