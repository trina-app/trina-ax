// The intro deck's preview (docs/DECISIONS.md "D2"): the display list as absolutely placed elements on a 1920 × 1080
// stage scaled to the panel (container units), every line its own `white-space: pre` element so the browser never
// re-wraps it, every text escaped. Pictures by team path (the panel inlines them as data: addresses,
// web/src/lib/frame-files.ts); Pretendard from /vendor/fonts/ (the frame's CSP allows fonts only from there).
// The page pages through the slides: ← → / PageUp PageDown / Home End, a swipe of 40 px or more, a click on the left
// or right third, and a slim bar ‹ 3 / 9 ›; a 160 ms slide-and-fade, none with reduced motion. On a phone (under
// 560 px) it pages the same way at the full width. Where the page has room under the bar (120 px or more: the panel on
// a computer), a strip of small slides (5 a row, 3 on a phone) shows them all, the current one ringed; a click shows
// that slide. The strip's slides are copies of the slides' own markup made by the script (the page's pictures are not
// sent twice). It shows once the font is there (at most 1.5 s).
// Round 2's vector items (paths, patterns, outlined shapes, dashed lines) are drawn in one inline <svg> layer per run
// of them (vector.ts: only numbers and checked colours reach it, ids unique per page); the AI's accent is an <img> of
// its SVG as a data: address, never markup in the page.
import type { Locale } from '@mycel/shared/api'
import { SLIDE_H, SLIDE_W, type DeckOut, type Fill, type Item, type SlideOut } from './layout'
import { svgInHtml, vectorSvg, withXmlns } from './vector'

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
const r2 = (n: number) => Math.round(n * 100) / 100
const u = (n: number) => `calc(${r2(n)}*var(--u))`
/** "#rrggbb" or "#rrggbbaa" → CSS (only colours the theme made reach here; anything else is dropped) */
export function css(color: string): string {
  if (!/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(color)) return 'transparent'
  if (color.length === 7) return color
  const n = Number.parseInt(color.slice(1, 7), 16), a = Number.parseInt(color.slice(7), 16) / 255
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${r2(a)})`
}
/** A team path as the page's address ("/groups/…", each part %-encoded; the panel decodes it). */
export const teamUrl = (p: string) => '/' + p.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/')

function fill(f: Fill, ellipse: boolean): string {
  if ('solid' in f) return `background:${css(f.solid)}`
  if ('linear' in f) return `background:linear-gradient(${f.linear.angle}deg,${f.linear.stops.map((s) => `${css(s.color)} ${r2(s.at * 100)}%`).join(',')})`
  return `background:radial-gradient(${ellipse ? 'ellipse' : 'circle'} closest-side at 50% 50%,${f.radial.stops.map((s) => `${css(s.color)} ${r2(s.at * 100)}%`).join(',')})`
}

function item(it: Item): string {
  if (it.t === 'svg') {
    // the accent (already sanitized and coloured) as a picture: never markup in the page
    const svg = withXmlns(it.svg)
    if (!/^<svg[\s>]/i.test(svg)) return ''
    return `<img class="a" alt="" src="data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}" style="left:${u(it.x)};top:${u(it.y)};width:${u(it.w)};height:${u(it.h)}">`
  }
  if (it.t === 'path' || it.t === 'pattern') return ''
  if (it.t === 'rect') {
    return `<i class="r" style="left:${u(it.x)};top:${u(it.y)};width:${u(it.w)};height:${u(it.h)};${fill(it.fill, !!it.ellipse)};border-radius:${it.ellipse ? '50%' : u(it.radius)}"></i>`
  }
  if (it.t === 'line') {
    const hor = it.y1 === it.y2
    const x = Math.min(it.x1, it.x2), y = Math.min(it.y1, it.y2)
    const w = hor ? Math.abs(it.x2 - it.x1) : it.width, h = hor ? it.width : Math.abs(it.y2 - it.y1)
    return `<i class="r" style="left:${u(hor ? x : x - it.width / 2)};top:${u(hor ? y - it.width / 2 : y)};width:${u(w)};height:${u(h)};background:${css(it.color)}"></i>`
  }
  if (it.t === 'image') {
    const k = it.w / it.crop.w
    const box = `left:${u(it.x)};top:${u(it.y)};width:${u(it.w)};height:${u(it.h)};border-radius:${u(it.radius)}`
    if (it.recolor) {
      // one colour, the logo's own shape: its pixels as a mask over the colour
      const m = `url(&quot;${esc(teamUrl(it.src))}&quot;)`
      return `<i class="r" style="${box};background:${css(it.recolor)};-webkit-mask-image:${m};mask-image:${m};-webkit-mask-size:100% 100%;mask-size:100% 100%"></i>`
    }
    return `<i class="i" style="${box}"><img alt="" src="${esc(teamUrl(it.src))}" style="left:${u(-it.crop.x * k)};top:${u(-it.crop.y * k)};width:${u(it.natural.width * k)};height:${u(it.natural.height * k)}"></i>`
  }
  const base = `left:${u(it.x)};width:${u(it.w)};font-size:${u(it.size)};line-height:${u(it.lh)};font-weight:${it.weight};letter-spacing:${it.tracking}em;text-align:${it.align === 'r' ? 'right' : it.align === 'c' ? 'center' : 'left'}${it.tabular ? ';font-variant-numeric:tabular-nums' : ''}`
  return it.lines.map((line, i) => `<p class="t" data-role="${esc(it.role)}" style="${base};top:${u(it.y + i * it.lh)}">${line.map((r) => `<span style="color:${css(r.color)}${r.size ? `;font-size:${u(r.size)}` : ''}${r.weight ? `;font-weight:${r.weight}` : ''}">${esc(r.text)}</span>`).join('')}</p>`).join('')
}

/** One slide's markup; `prefix` makes the ids of its SVG layers unique in the page. Consecutive vector items share
 * one layer, so the order of everything on the slide stays the display list's. */
export function slideMarkup(s: SlideOut, prefix = 's'): string {
  const parts: string[] = []
  let run: Item[] = [], n = 0
  const flush = () => {
    if (!run.length) return
    const inner = vectorSvg(run, `${prefix}v${n++}`)
    if (inner) parts.push(`<svg class="v" viewBox="0 0 ${SLIDE_W} ${SLIDE_H}" preserveAspectRatio="none" aria-hidden="true" focusable="false">${inner}</svg>`)
    run = []
  }
  for (const it of s.items) {
    if (svgInHtml(it)) {
      // an outlined rect with a gradient: the gradient as before, its outline in the layer above it
      if (it.t === 'rect' && !('solid' in it.fill)) { flush(); parts.push(item(it)) }
      run.push(it)
    } else { flush(); parts.push(item(it)) }
  }
  flush()
  return `<div class="c" style="background:${css(s.ground)}">${parts.join('')}</div>`
}

/** The page's own words (the slide counter has none). */
export interface PagerText { slide: string; prev: string; next: string; deck: string; all: string }
export const PAGER: Record<Locale, PagerText> = {
  ko: { slide: '슬라이드', prev: '이전 슬라이드', next: '다음 슬라이드', deck: '소개서', all: '모든 슬라이드' },
  en: { slide: 'slide', prev: 'Previous slide', next: 'Next slide', deck: 'Deck', all: 'All slides' },
  id: { slide: 'slide', prev: 'Slide sebelumnya', next: 'Slide berikutnya', deck: 'Presentasi', all: 'Semua slide' },
  ja: { slide: 'スライド', prev: '前のスライド', next: '次のスライド', deck: '資料', all: 'すべてのスライド' },
  es: { slide: 'diapositiva', prev: 'Diapositiva anterior', next: 'Diapositiva siguiente', deck: 'Presentación', all: 'Todas las diapositivas' },
}

const STYLE = `
*{box-sizing:border-box}
html,body{margin:0;background:#fff}
body{font-family:"Pretendard Web","Pretendard","Apple SD Gothic Neo","Noto Sans KR","Noto Sans CJK KR","Malgun Gothic",sans-serif;-webkit-font-smoothing:antialiased;font-synthesis:none}
.dk{max-width:1280px;margin:0 auto;padding:12px 12px 10px}
.st{position:relative;width:100%;aspect-ratio:16/9;border-radius:8px;overflow:hidden;background:#111;box-shadow:0 1px 2px rgba(0,0,0,.08),0 8px 28px rgba(0,0,0,.10);touch-action:pan-y;user-select:none;-webkit-user-select:none;opacity:0;transition:opacity .2s}
.ready .st{opacity:1}
.s{position:absolute;inset:0;container-type:inline-size;overflow:hidden;opacity:0;visibility:hidden;transition:opacity .16s ease,transform .16s ease}
.s.on{opacity:1;visibility:visible;transform:none}
.s.l{transform:translateX(-2.5%)}.s.rt{transform:translateX(2.5%)}
.c{position:absolute;inset:0;--u:calc(100cqw/${SLIDE_W});overflow:hidden}
.c .r,.c .i{position:absolute;display:block}
.c .i{overflow:hidden}.c .i img{position:absolute;max-width:none;display:block}
.c .t{position:absolute;margin:0;white-space:pre;font-kerning:normal}
.c .v{position:absolute;left:0;top:0;width:100%;height:100%;overflow:hidden;pointer-events:none}
.c .a{position:absolute;display:block;max-width:none;object-fit:contain}
.bar{display:flex;align-items:center;justify-content:center;gap:14px;margin-top:10px;color:#57534e;font:500 12px/1 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Noto Sans KR",sans-serif}
.bar button{all:unset;display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:999px;cursor:pointer;color:#1c1917}
.bar button:hover{background:#f5f5f4}.bar button:focus-visible{outline:2px solid #1c1917;outline-offset:2px}
.bar button[disabled]{opacity:.3;cursor:default;background:none}
.bar svg{width:16px;height:16px}
.n{font-variant-numeric:tabular-nums;min-width:52px;text-align:center}
.tb{display:none;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;margin-top:8px;padding:4px;opacity:0;transition:opacity .2s}
.thumbs .tb{display:grid}.ready .tb{opacity:1}
.th{all:unset;box-sizing:border-box;position:relative;display:block;aspect-ratio:16/9;border-radius:4px;overflow:hidden;cursor:pointer;background:#e7e5e4;container-type:inline-size;box-shadow:0 0 0 1px rgba(0,0,0,.06)}
.th[aria-current="true"]{box-shadow:0 0 0 2px #fff,0 0 0 3.5px #1c1917}
.th:focus-visible{outline:2px solid #1c1917;outline-offset:4px}
@media (max-width:559px){.dk{padding:0 0 8px}.st{border-radius:0;box-shadow:none}.tb{grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;padding:4px 12px}}
@media (prefers-reduced-motion:reduce){.s,.st{transition:none!important}}
`

const SCRIPT = `(function(){
var root=document.documentElement,st=document.querySelector(".st"),bar=document.querySelector(".bar"),ss=[].slice.call(document.querySelectorAll(".s")),th=[].slice.call(document.querySelectorAll(".th")),n=document.querySelector(".n"),pv=document.querySelector(".pv"),nx=document.querySelector(".nx"),i=0,N=ss.length;
var rm=window.matchMedia&&window.matchMedia("(prefers-reduced-motion: reduce)").matches;
function show(k){k=Math.max(0,Math.min(N-1,k));if(k===i&&ss[k].classList.contains("on"))return;var from=i;i=k;
for(var j=0;j<N;j++){var s=ss[j];s.classList.toggle("on",j===i);s.classList.toggle("l",!rm&&j<i&&j===from);s.classList.toggle("rt",!rm&&j>i&&j===from);s.setAttribute("aria-hidden",j===i?"false":"true")}
for(j=0;j<th.length;j++)th[j].setAttribute("aria-current",j===i?"true":"false");
if(!rm){var c=ss[i];c.classList.add(from<i?"rt":"l");void c.offsetWidth;c.classList.remove("rt","l")}
n.textContent=(i+1)+" / "+N;pv.disabled=i===0;nx.disabled=i===N-1}
document.addEventListener("keydown",function(e){if(e.altKey||e.ctrlKey||e.metaKey)return;var k=e.key;
if(k==="ArrowRight"||k==="PageDown"){show(i+1);e.preventDefault()}else if(k==="ArrowLeft"||k==="PageUp"){show(i-1);e.preventDefault()}else if(k==="Home"){show(0);e.preventDefault()}else if(k==="End"){show(N-1);e.preventDefault()}});
pv.addEventListener("click",function(){show(i-1)});nx.addEventListener("click",function(){show(i+1)});
var x0=null,y0=0;
st.addEventListener("pointerdown",function(e){x0=e.clientX;y0=e.clientY});
st.addEventListener("pointerup",function(e){if(x0===null)return;var dx=e.clientX-x0,dy=e.clientY-y0;x0=null;
if(Math.abs(dx)>=40&&Math.abs(dx)>Math.abs(dy)){show(dx<0?i+1:i-1);return}
if(Math.abs(dx)<8&&Math.abs(dy)<8){var r=st.getBoundingClientRect(),f=(e.clientX-r.left)/r.width;if(f<1/3)show(i-1);else if(f>2/3)show(i+1)}});
st.addEventListener("pointercancel",function(){x0=null});
th.forEach(function(b,k){b.addEventListener("click",function(){show(k)})});
function copy(b,k){var c=ss[k]&&ss[k].querySelector?ss[k].querySelector(".c"):null;if(!c||!b.appendChild)return;var d=c.cloneNode(true);d.setAttribute("aria-hidden","true");
var es=d.querySelectorAll("[id],[fill],[mask],[clip-path]");for(var j=0;j<es.length;j++){var el=es[j];if(el.id)el.id+="t";["fill","mask","clip-path"].forEach(function(a){var v=el.getAttribute(a);if(v&&v.indexOf("url(#")===0)el.setAttribute(a,v.replace(/\\)$/,"t)"))})}
b.appendChild(d)}
var copied=false;
function room(){var on=th.length>0&&!!bar&&window.innerHeight-bar.getBoundingClientRect().bottom>=120;root.classList.toggle("thumbs",on);
if(on&&!copied){copied=true;th.forEach(copy)}}
room();window.addEventListener("resize",room);
show(0);
var shown=false;function ready(){if(shown)return;shown=true;root.classList.add("ready")}
try{document.fonts.ready.then(ready)}catch(e){ready()}setTimeout(ready,1500);
})();`

const CHEVRON = (d: string) => `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`

/** The artifact page: every slide, the pager, the font. */
export function deckHtml(out: DeckOut, o: { fontCss: string; lang: Locale; title: string }): string {
  const t = PAGER[o.lang]
  const N = out.slides.length
  const label = (s: SlideOut, k: number) => esc(`${s.label} (${k + 1} / ${N})`)
  const slides = out.slides.map((s, k) => `<section class="s${k === 0 ? ' on' : ''}" role="group" aria-roledescription="${esc(t.slide)}" aria-label="${label(s, k)}">${slideMarkup(s, `s${k + 1}`)}</section>`).join('')
  // the strip: one button a slide (the script copies the slide into it when the strip has room)
  const strip = N > 1 ? `<div class="tb" role="group" aria-label="${esc(t.all)}">${out.slides.map((s, k) => `<button type="button" class="th" aria-label="${label(s, k)}" aria-current="${k === 0}"></button>`).join('')}</div>` : ''
  return `<!doctype html><html lang="${esc(o.lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(o.title)}</title><link rel="stylesheet" href="${esc(o.fontCss)}"><style>${STYLE}</style></head>`
    + `<body><div class="dk" aria-roledescription="${esc(t.deck)}" aria-label="${esc(o.title)}"><div class="st">${slides}</div>`
    // the first slide's state as the page opens (the script's show(0) has nothing to change then)
    + `<div class="bar"><button type="button" class="pv" aria-label="${esc(t.prev)}" disabled>${CHEVRON('M10 3.5L5.5 8l4.5 4.5')}</button><span class="n" aria-live="polite">1 / ${N}</span><button type="button" class="nx" aria-label="${esc(t.next)}"${N < 2 ? ' disabled' : ''}>${CHEVRON('M6 3.5L10.5 8 6 12.5')}</button></div>${strip}</div>`
    + `<script>${SCRIPT}</script></body></html>`
}

/** One slide alone at its full size (the quality gate's screenshots; never served). */
export function slidePage(s: SlideOut, fontCss: string, picBase = ''): string {
  const markup = slideMarkup(s, 'p').replace(/(src="|url\(&quot;)\/(?!\/)/g, `$1${picBase}/`)
  return `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="${esc(fontCss)}"><style>${STYLE}html,body{width:${SLIDE_W}px;height:${SLIDE_H}px;overflow:hidden}.one{position:relative;width:${SLIDE_W}px;height:${SLIDE_H}px;container-type:inline-size}</style></head><body><div class="one">${markup}</div></body></html>`
}
