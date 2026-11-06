// The intro deck's preview (docs/DECISIONS.md "D2"): the display list as absolutely placed elements on a 1920 × 1080
// stage scaled to the panel (container units), every line its own `white-space: pre` element so the browser never
// re-wraps it, every text escaped. Pictures by team path (the panel inlines them as data: addresses,
// web/src/lib/frame-files.ts); Pretendard from /vendor/fonts/ (the frame's CSP allows fonts only from there).
// The page pages through the slides: ← → / PageUp PageDown / Home End, a swipe of 40 px or more, a click on the left
// or right third, and a slim bar ‹ 3 / 9 ›; a 160 ms slide-and-fade, none with reduced motion. In a narrow panel (a
// phone's sheet, under 560 px) every slide stands in one scrolling column instead. It shows once the font is there
// (at most 1.5 s).
import type { Locale } from '@mycel/shared/api'
import { SLIDE_H, SLIDE_W, type DeckOut, type Fill, type Item, type SlideOut } from './layout'

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

export function slideMarkup(s: SlideOut): string {
  return `<div class="c" style="background:${css(s.ground)}">${s.items.map(item).join('')}</div>`
}

/** The page's own words (the slide counter has none). */
export interface PagerText { slide: string; prev: string; next: string; deck: string }
export const PAGER: Record<Locale, PagerText> = {
  ko: { slide: '슬라이드', prev: '이전 슬라이드', next: '다음 슬라이드', deck: '소개서' },
  en: { slide: 'slide', prev: 'Previous slide', next: 'Next slide', deck: 'Deck' },
  id: { slide: 'slide', prev: 'Slide sebelumnya', next: 'Slide berikutnya', deck: 'Presentasi' },
  ja: { slide: 'スライド', prev: '前のスライド', next: '次のスライド', deck: '資料' },
  es: { slide: 'diapositiva', prev: 'Diapositiva anterior', next: 'Diapositiva siguiente', deck: 'Presentación' },
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
.bar{display:flex;align-items:center;justify-content:center;gap:14px;margin-top:10px;color:#57534e;font:500 12px/1 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Noto Sans KR",sans-serif}
.bar button{all:unset;display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:999px;cursor:pointer;color:#1c1917}
.bar button:hover{background:#f5f5f4}.bar button:focus-visible{outline:2px solid #1c1917;outline-offset:2px}
.bar button[disabled]{opacity:.3;cursor:default;background:none}
.bar svg{width:16px;height:16px}
.n{font-variant-numeric:tabular-nums;min-width:52px;text-align:center}
.narrow .dk{padding:0}
.narrow .st{aspect-ratio:auto;border-radius:0;box-shadow:none;background:none;display:flex;flex-direction:column;gap:8px;opacity:1}
.narrow .s{position:relative;inset:auto;aspect-ratio:16/9;opacity:1;visibility:visible;transform:none;transition:none}
.narrow .bar{display:none}
@media (prefers-reduced-motion:reduce){.s,.st{transition:none!important}}
`

const SCRIPT = `(function(){
var root=document.documentElement,st=document.querySelector(".st"),ss=[].slice.call(document.querySelectorAll(".s")),n=document.querySelector(".n"),pv=document.querySelector(".pv"),nx=document.querySelector(".nx"),i=0,N=ss.length;
var rm=window.matchMedia&&window.matchMedia("(prefers-reduced-motion: reduce)").matches;
function show(k){k=Math.max(0,Math.min(N-1,k));if(k===i&&ss[k].classList.contains("on"))return;var from=i;i=k;
for(var j=0;j<N;j++){var s=ss[j];s.classList.toggle("on",j===i);s.classList.toggle("l",!rm&&j<i&&j===from);s.classList.toggle("rt",!rm&&j>i&&j===from);s.setAttribute("aria-hidden",j===i?"false":"true")}
if(!rm){var c=ss[i];c.classList.add(from<i?"rt":"l");void c.offsetWidth;c.classList.remove("rt","l")}
n.textContent=(i+1)+" / "+N;pv.disabled=i===0;nx.disabled=i===N-1}
function narrow(){return root.classList.contains("narrow")}
document.addEventListener("keydown",function(e){if(narrow()||e.altKey||e.ctrlKey||e.metaKey)return;var k=e.key;
if(k==="ArrowRight"||k==="PageDown"){show(i+1);e.preventDefault()}else if(k==="ArrowLeft"||k==="PageUp"){show(i-1);e.preventDefault()}else if(k==="Home"){show(0);e.preventDefault()}else if(k==="End"){show(N-1);e.preventDefault()}});
pv.addEventListener("click",function(){show(i-1)});nx.addEventListener("click",function(){show(i+1)});
var x0=null,y0=0,moved=false;
st.addEventListener("pointerdown",function(e){if(narrow())return;x0=e.clientX;y0=e.clientY;moved=false});
st.addEventListener("pointerup",function(e){if(narrow()||x0===null)return;var dx=e.clientX-x0,dy=e.clientY-y0;x0=null;
if(Math.abs(dx)>=40&&Math.abs(dx)>Math.abs(dy)){show(dx<0?i+1:i-1);return}
if(Math.abs(dx)<8&&Math.abs(dy)<8){var r=st.getBoundingClientRect(),f=(e.clientX-r.left)/r.width;if(f<1/3)show(i-1);else if(f>2/3)show(i+1)}});
st.addEventListener("pointercancel",function(){x0=null});
function fitMode(){root.classList.toggle("narrow",window.innerWidth<560)}
fitMode();window.addEventListener("resize",fitMode);
show(0);
var shown=false;function ready(){if(shown)return;shown=true;root.classList.add("ready")}
try{document.fonts.ready.then(ready)}catch(e){ready()}setTimeout(ready,1500);
})();`

const CHEVRON = (d: string) => `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`

/** The artifact page: every slide, the pager, the font. */
export function deckHtml(out: DeckOut, o: { fontCss: string; lang: Locale; title: string }): string {
  const t = PAGER[o.lang]
  const N = out.slides.length
  const slides = out.slides.map((s, k) => `<section class="s${k === 0 ? ' on' : ''}" role="group" aria-roledescription="${esc(t.slide)}" aria-label="${esc(`${s.label} (${k + 1} / ${N})`)}">${slideMarkup(s)}</section>`).join('')
  return `<!doctype html><html lang="${esc(o.lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(o.title)}</title><link rel="stylesheet" href="${esc(o.fontCss)}"><style>${STYLE}</style></head>`
    + `<body><div class="dk" aria-roledescription="${esc(t.deck)}" aria-label="${esc(o.title)}"><div class="st">${slides}</div>`
    // the first slide's state as the page opens (the script's show(0) has nothing to change then)
    + `<div class="bar"><button type="button" class="pv" aria-label="${esc(t.prev)}" disabled>${CHEVRON('M10 3.5L5.5 8l4.5 4.5')}</button><span class="n" aria-live="polite">1 / ${N}</span><button type="button" class="nx" aria-label="${esc(t.next)}"${N < 2 ? ' disabled' : ''}>${CHEVRON('M6 3.5L10.5 8 6 12.5')}</button></div></div>`
    + `<script>${SCRIPT}</script></body></html>`
}

/** One slide alone at its full size (the quality gate's screenshots; never served). */
export function slidePage(s: SlideOut, fontCss: string, picBase = ''): string {
  const markup = slideMarkup(s).replace(/(src="|url\(&quot;)\/(?!\/)/g, `$1${picBase}/`)
  return `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="${esc(fontCss)}"><style>${STYLE}html,body{width:${SLIDE_W}px;height:${SLIDE_H}px;overflow:hidden}.one{position:relative;width:${SLIDE_W}px;height:${SLIDE_H}px;container-type:inline-size}</style></head><body><div class="one">${markup}</div></body></html>`
}
