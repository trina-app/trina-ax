// Regenerates the brand, proposal, performance and letter samples of the Trina demo company
// (scripts/demo/trina/files/<team path>), which `bun run demo:trina` uploads. The outputs are committed, so this only
// runs when the samples change:
//
//   bun tests/demo/make-trina-assets.ts
//
// Everything here is made by this script, nothing is downloaded: the images are HTML/SVG drawn here and printed to
// PNG in Playwright's Chromium (system font only), the slides come from pandoc (Markdown to .pptx), the spreadsheets
// from SheetJS and the Hangul letter from pandoc's JSON tree through the product's own .hwpx writer. The company, its
// customers, the association and the competitors are all made up (scripts/demo/trina/README.md). The October ad spend
// is checked against the 마케팅팀 budget sheet that tests/demo/make-trina-files.ts writes; the script refuses to write
// if they drift apart.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium } from '@playwright/test'
import * as XLSX from 'xlsx'
import { hwpxText } from '../../server/src/files/hwp'
import { writeHwpx } from '../../server/src/files/hwpx-write'

const OUT = path.resolve(import.meta.dir, '..', '..', 'scripts', 'demo', 'trina', 'files')
const MKT = 'groups/마케팅팀'
const BRAND = `${MKT}/브랜드`
const PNG_MAX = 200 * 1024

function write(rel: string, data: string | Uint8Array) {
  const p = path.join(OUT, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, data)
  console.log(`wrote ${rel} (${typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength} bytes)`)
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)

// ---------------------------------------------------------------- images
// The brand guide (groups/마케팅팀/브랜드-가이드.md): forest green, cream, and tangerine only for prices and buttons;
// the logo is the words "트리나 박스" on cream, with half the logo's height of space around it.
const C = {
  forest: '#2F6B4F', forestDeep: '#234F3B', sage: '#DDE8DA', sageMid: '#A8C6AD',
  cream: '#F6F1E7', sand: '#EDE3CF', tangerine: '#F29E4C', priceInk: '#3A2412',
  kraft: '#D2A676', kraftShade: '#BC8E5F', kraftInner: '#9E7449', paper: '#FFFCF6',
  coffee: '#6B4632', mute: '#7A7466', red: '#BF4F3C', pear: '#BCCF78', banana: '#F1CF66', plum: '#8C5B86',
}
const FONT = `"Apple SD Gothic Neo", sans-serif`
type G = string
const at = (x: number, y: number, rot = 0, s = 1) => `translate(${x} ${y}) rotate(${rot}) scale(${s})`

function bean(x: number, y: number, r: number, rot = 0, fill = C.coffee): G {
  return `<g transform="${at(x, y, rot)}"><ellipse rx="${r}" ry="${r * 0.68}" fill="${fill}"/>` +
    `<path d="M${-r * 0.72} 1 Q0 ${-r * 0.4} ${r * 0.72} 1" stroke="#F1DEC6" stroke-width="${Math.max(1.4, r * 0.14)}" fill="none" stroke-linecap="round"/></g>`
}

/** a coffee drip bag, origin at its top centre */
function dripBag(x: number, y: number, rot: number, fill: string, s = 1): G {
  return `<g transform="${at(x, y, rot, s)}">
    <rect x="-30" y="0" width="60" height="84" rx="5" fill="${fill}"/>
    <rect x="-30" y="0" width="60" height="11" rx="4" fill="#000" opacity=".1"/>
    <rect x="-20" y="30" width="40" height="34" rx="5" fill="${C.paper}"/>
    ${bean(0, 47, 9, -28)}
  </g>`
}

function cookie(x: number, y: number, r: number): G {
  const dots = [[-0.42, -0.3], [0.3, -0.48], [0.46, 0.18], [-0.12, 0.38], [0.04, -0.06], [-0.5, 0.22]]
    .map(([a, b]) => `<circle cx="${a! * r}" cy="${b! * r}" r="${r * 0.11}" fill="#7A4A2E"/>`).join('')
  return `<g transform="translate(${x} ${y})"><circle r="${r}" fill="#DDAA69"/><circle r="${r * 0.92}" fill="none" stroke="#C99254" stroke-width="${r * 0.08}"/>${dots}</g>`
}

/** a star-shaped cookie for the year-end box */
function starCookie(x: number, y: number, r: number, rot = 0): G {
  const pts: string[] = []
  for (let i = 0; i < 10; i++) {
    const a = (Math.PI / 5) * i - Math.PI / 2
    const rr = i % 2 ? r * 0.48 : r
    pts.push(`${(Math.cos(a) * rr).toFixed(1)},${(Math.sin(a) * rr).toFixed(1)}`)
  }
  return `<g transform="${at(x, y, rot)}"><polygon points="${pts.join(' ')}" fill="#E0B272" stroke="#C99254" stroke-width="3" stroke-linejoin="round"/><circle r="${r * 0.16}" fill="${C.paper}"/></g>`
}

/** a snack bag with crimped ends, origin at its top centre */
function chips(x: number, y: number, rot: number, fill: string, w = 96, h = 128, mark = C.banana): G {
  const crimp = (yy: number) => Array.from({ length: 7 }, (_, i) => `<rect x="${-w / 2 + 6 + i * ((w - 12) / 7)}" y="${yy}" width="${(w - 12) / 14}" height="12" fill="#000" opacity=".1"/>`).join('')
  return `<g transform="${at(x, y, rot)}">
    <rect x="${-w / 2}" y="0" width="${w}" height="${h}" rx="12" fill="${fill}"/>
    ${crimp(3)}${crimp(h - 15)}
    <circle cx="0" cy="${h * 0.5}" r="${w * 0.27}" fill="${C.paper}"/>
    <path d="M${-w * 0.13} ${h * 0.56} L0 ${h * 0.38} L${w * 0.13} ${h * 0.56} Z" fill="${mark}" stroke="#C9A23E" stroke-width="2" stroke-linejoin="round"/>
  </g>`
}

/** a wrapped snack bar, centred */
function bar(x: number, y: number, rot: number, fill: string, w = 130, h = 38): G {
  return `<g transform="${at(x, y, rot)}">
    <rect x="${-w / 2}" y="${-h / 2}" width="${w}" height="${h}" rx="8" fill="${fill}"/>
    <rect x="${-w / 2}" y="${-h / 2}" width="14" height="${h}" rx="4" fill="#000" opacity=".12"/>
    <rect x="${w / 2 - 14}" y="${-h / 2}" width="14" height="${h}" rx="4" fill="#000" opacity=".12"/>
    <rect x="-26" y="${-h / 2 + 7}" width="52" height="${h - 14}" rx="4" fill="${C.paper}"/>
  </g>`
}

function apple(x: number, y: number, r: number, fill = C.red): G {
  return `<g transform="translate(${x} ${y})">
    <rect x="-2.5" y="${-r - 14}" width="5" height="18" rx="2.5" fill="${C.coffee}"/>
    <ellipse cx="${r * 0.36}" cy="${-r - 6}" rx="${r * 0.34}" ry="${r * 0.16}" transform="rotate(-25 ${r * 0.36} ${-r - 6})" fill="${C.forest}"/>
    <circle r="${r}" fill="${fill}"/>
    <ellipse cx="${-r * 0.38}" cy="${-r * 0.35}" rx="${r * 0.2}" ry="${r * 0.3}" fill="#fff" opacity=".28"/>
  </g>`
}

function pear(x: number, y: number, r: number, rot = 0): G {
  return `<g transform="${at(x, y, rot)}">
    <rect x="-2.5" y="${-r * 1.75}" width="5" height="16" rx="2.5" fill="${C.coffee}"/>
    <circle cy="${-r * 0.75}" r="${r * 0.62}" fill="${C.pear}"/>
    <circle r="${r}" fill="${C.pear}"/>
    <ellipse cx="${-r * 0.36}" cy="${-r * 0.2}" rx="${r * 0.18}" ry="${r * 0.3}" fill="#fff" opacity=".3"/>
  </g>`
}

function banana(x: number, y: number, rot = 0, s = 1): G {
  return `<g transform="${at(x, y, rot, s)}">
    <path d="M-62 -8 Q-10 46 60 -18 Q58 2 50 10 Q-6 58 -60 8 Z" fill="${C.banana}" stroke="#D5AE45" stroke-width="3" stroke-linejoin="round"/>
    <rect x="56" y="-24" width="9" height="14" rx="3" transform="rotate(30 60 -18)" fill="#7A5A2E"/>
  </g>`
}

/** a bag of coffee beans, origin at its top centre */
function beansPouch(x: number, y: number, rot: number, w = 108, h = 150): G {
  return `<g transform="${at(x, y, rot)}">
    <path d="M${-w / 2} 14 L${w / 2} 14 L${w / 2 - 4} ${h} Q0 ${h + 6} ${-w / 2 + 4} ${h} Z" fill="#7C5139"/>
    <rect x="${-w / 2}" y="0" width="${w}" height="18" rx="4" fill="#5E3C2A"/>
    <rect x="${-w / 2 + 16}" y="${h * 0.34}" width="${w - 32}" height="${h * 0.42}" rx="6" fill="${C.paper}"/>
    ${bean(-12, h * 0.55, 11, -30)}${bean(13, h * 0.52, 9, 25)}
  </g>`
}

function mug(x: number, y: number, s = 1): G {
  return `<g transform="${at(x, y, 0, s)}">
    <path d="M-20 -78 q-12 -16 0 -30 q12 -14 0 -30" stroke="${C.sageMid}" stroke-width="6" fill="none" stroke-linecap="round"/>
    <path d="M8 -74 q-12 -16 0 -30 q12 -14 0 -28" stroke="${C.sageMid}" stroke-width="6" fill="none" stroke-linecap="round"/>
    <circle cx="48" cy="-22" r="22" fill="none" stroke="${C.paper}" stroke-width="11"/>
    <path d="M-48 -64 L48 -64 L42 4 Q40 18 26 18 L-26 18 Q-40 18 -42 4 Z" fill="${C.paper}"/>
    <rect x="-46" y="-40" width="92" height="30" fill="${C.forest}"/>
    <ellipse cx="0" cy="-64" rx="48" ry="9" fill="#E9DFCF"/>
    <ellipse cx="0" cy="-63" rx="40" ry="6" fill="${C.coffee}"/>
  </g>`
}

/** an open kraft box: [inside and flaps, front with label]; items go between the two */
function openBox(cx: number, base: number, w: number, h: number, small: string, big: string, d = 44): [G, G] {
  const x = cx - w / 2
  const y = base - h
  const back = `
    <polygon points="${x},${y} ${x + d},${y - d} ${x - 34},${y - d - 44} ${x - 74},${y - 40}" fill="${C.kraftShade}"/>
    <polygon points="${x + w},${y} ${x + w - d},${y - d} ${x + w + 34},${y - d - 44} ${x + w + 74},${y - 40}" fill="${C.kraftShade}"/>
    <polygon points="${x},${y} ${x + d},${y - d} ${x + w - d},${y - d} ${x + w},${y}" fill="${C.kraftInner}"/>`
  const lw = Math.min(w - 70, 300)
  const front = `
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="${C.kraft}"/>
    <rect x="${x}" y="${y}" width="${w}" height="10" fill="#000" opacity=".06"/>
    <rect x="${cx - lw / 2}" y="${y + h * 0.26}" width="${lw}" height="${h * 0.5}" rx="12" fill="${C.paper}"/>
    <text x="${cx}" y="${y + h * 0.26 + 40}" text-anchor="middle" font-size="22" font-weight="700" fill="${C.forest}" letter-spacing="1">${small}</text>
    <text x="${cx}" y="${y + h * 0.26 + 88}" text-anchor="middle" font-size="46" font-weight="800" fill="${C.forest}">${big}</text>`
  return [back, front]
}

/** a closed gift box with a ribbon and bow */
function giftBox(cx: number, base: number, w: number, h: number, body: string, lid: string, ribbon: string): G {
  const x = cx - w / 2
  const y = base - h
  const lh = h * 0.2
  return `
    <rect x="${x + 8}" y="${y + lh - 4}" width="${w - 16}" height="${h - lh + 4}" rx="6" fill="${body}"/>
    <rect x="${cx - 18}" y="${y + lh - 4}" width="36" height="${h - lh + 4}" fill="${ribbon}"/>
    <rect x="${x - 6}" y="${y}" width="${w + 12}" height="${lh}" rx="8" fill="${lid}"/>
    <rect x="${cx - 20}" y="${y}" width="40" height="${lh}" fill="${ribbon}"/>
    <rect x="${x - 6}" y="${y + lh - 8}" width="${w + 12}" height="8" fill="#000" opacity=".08"/>
    <ellipse cx="${cx - 46}" cy="${y - 26}" rx="50" ry="26" transform="rotate(-24 ${cx - 46} ${y - 26})" fill="none" stroke="${ribbon}" stroke-width="18"/>
    <ellipse cx="${cx + 46}" cy="${y - 26}" rx="50" ry="26" transform="rotate(24 ${cx + 46} ${y - 26})" fill="none" stroke="${ribbon}" stroke-width="18"/>
    <path d="M${cx - 10} ${y - 6} L${cx - 40} ${y + 52} L${cx - 22} ${y + 46} L${cx - 14} ${y + 62} Z" fill="${ribbon}"/>
    <path d="M${cx + 10} ${y - 6} L${cx + 40} ${y + 52} L${cx + 22} ${y + 46} L${cx + 14} ${y + 62} Z" fill="${ribbon}"/>
    <circle cx="${cx}" cy="${y - 8}" r="20" fill="${ribbon}"/><circle cx="${cx}" cy="${y - 8}" r="20" fill="#000" opacity=".1"/>`
}

function sprig(x: number, y: number, rot = 0, s = 1): G {
  const leaves = [-1, 1].flatMap((side) => [0, 1, 2, 3].map((i) =>
    `<ellipse cx="${side * 16}" cy="${-14 - i * 22}" rx="18" ry="6" transform="rotate(${side * -38} ${side * 16} ${-14 - i * 22})" fill="${C.forest}"/>`)).join('')
  return `<g transform="${at(x, y, rot, s)}"><rect x="-2" y="-96" width="4" height="100" rx="2" fill="${C.forestDeep}"/>${leaves}<circle cx="0" cy="-102" r="8" fill="${C.red}"/></g>`
}

/** confetti / snow dots, deterministic */
function dots(n: number, w: number, h: number, colours: string[], seed: number, avoid?: (x: number, y: number) => boolean): G {
  let s = seed
  const rnd = () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646
  const out: string[] = []
  for (let i = 0; out.length < n && i < n * 20; i++) {
    const x = rnd() * w
    const y = rnd() * h
    const r = 3 + rnd() * 6
    const c = colours[Math.floor(rnd() * colours.length)]!
    if (avoid?.(x, y)) continue
    out.push(`<circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="${r.toFixed(1)}" fill="${c}"/>`)
  }
  return out.join('')
}

/** the bottom strip of a product image: name, one line, and a pill (tangerine only for a price) */
function strip(name: string, line: string, pill: string, pillSub: string, price: boolean): G {
  return `
    <rect x="0" y="652" width="800" height="148" fill="${C.forest}"/>
    <text x="48" y="716" font-size="38" font-weight="800" fill="${C.cream}">${name}</text>
    <text x="48" y="758" font-size="22" font-weight="500" fill="${C.cream}" opacity=".82">${line}</text>
    <rect x="${price ? 478 : 448}" y="684" width="${price ? 278 : 308}" height="64" rx="32" fill="${price ? C.tangerine : C.cream}"/>
    <text x="${price ? 617 : 602}" y="726" text-anchor="middle" font-size="${price ? 30 : 25}" font-weight="800" fill="${price ? C.priceInk : C.forest}">${pill}</text>
    <text x="${price ? 617 : 602}" y="778" text-anchor="middle" font-size="17" font-weight="500" fill="${C.cream}" opacity=".8">${pillSub}</text>`
}

const svg = (w: number, h: number, body: G) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family='${FONT}'>${body}</svg>`

function logo(): string {
  // the mark: an open box whose two flaps make a cup, with steam; then the word logo "트리나 박스"
  return svg(600, 240, `
    <rect width="600" height="240" fill="${C.cream}"/>
    <g transform="translate(60 60)">
      <rect width="120" height="120" rx="28" fill="${C.forest}"/>
      <path d="M50 44 q-7 -6 0 -12 q7 -6 0 -12" stroke="${C.cream}" stroke-width="5" fill="none" stroke-linecap="round"/>
      <path d="M70 44 q-7 -6 0 -12 q7 -6 0 -12" stroke="${C.cream}" stroke-width="5" fill="none" stroke-linecap="round"/>
      <polygon points="22,58 34,46 60,62 48,74" fill="${C.sageMid}"/>
      <polygon points="98,58 86,46 60,62 72,74" fill="${C.sageMid}"/>
      <path d="M30 62 L90 62 L86 98 Q85 102 81 102 L39 102 Q35 102 34 98 Z" fill="${C.cream}"/>
    </g>
    <text x="210" y="133" font-size="64" font-weight="800" fill="${C.forest}" letter-spacing="-1.5">트리나 박스</text>
    <text x="212" y="172" font-size="21" font-weight="500" fill="${C.mute}" letter-spacing="1">사무실 커피·간식 구독</text>`)
}

function basic(): string {
  const [back, front] = openBox(400, 600, 380, 232, '트리나 박스', '베이직')
  return svg(800, 800, `
    <rect width="800" height="800" fill="${C.cream}"/>
    <circle cx="400" cy="360" r="282" fill="${C.sand}"/>
    ${dots(14, 800, 640, [C.sageMid, C.sand], 7, (x, y) => Math.hypot(x - 400, y - 360) < 300)}
    <ellipse cx="400" cy="604" rx="270" ry="18" fill="#000" opacity=".08"/>
    ${back}
    ${dripBag(282, 268, -10, C.sageMid, 1.35)}
    ${dripBag(352, 240, -3, '#E7C9A1', 1.35)}
    ${chips(448, 222, 5, C.forest)}
    ${dripBag(528, 262, 9, C.sageMid, 1.3)}
    ${front}
    ${cookie(168, 574, 34)}${cookie(226, 592, 24)}
    ${bar(620, 588, -6, C.coffee)}
    ${mug(664, 520, 0.9)}
    ${strip('트리나 박스 베이직', '커피와 기본 간식을 정기적으로', '월 19만 원부터', '(부가세 별도)', true)}`)
}

function plus(): string {
  const [back, front] = openBox(400, 602, 430, 240, '트리나 박스', '플러스')
  return svg(800, 800, `
    <rect width="800" height="800" fill="${C.cream}"/>
    <circle cx="400" cy="350" r="292" fill="${C.sage}"/>
    ${dots(14, 800, 640, [C.sageMid, C.sand], 11, (x, y) => Math.hypot(x - 400, y - 350) < 310)}
    <ellipse cx="400" cy="606" rx="300" ry="18" fill="#000" opacity=".08"/>
    ${back}
    ${beansPouch(262, 220, -8)}
    ${dripBag(344, 236, -2, '#E7C9A1', 1.4)}
    ${chips(428, 214, 4, C.forest)}
    ${bar(522, 262, -62, C.plum, 140, 40)}
    ${dripBag(560, 252, 10, C.sageMid, 1.3)}
    ${apple(312, 344, 36)}${pear(486, 352, 30, 8)}
    ${front}
    ${banana(150, 566, -8, 1.05)}
    ${apple(246, 600, 26, C.red)}
    ${cookie(560, 604, 24)}
    <g transform="translate(676 600)">
      <rect x="-62" y="-104" width="124" height="104" rx="8" fill="${C.forest}"/>
      <rect x="-70" y="-122" width="140" height="26" rx="6" fill="${C.forestDeep}"/>
      <rect x="-9" y="-122" width="18" height="26" fill="${C.red}"/>
      <rect x="-46" y="-70" width="92" height="36" rx="8" fill="${C.paper}"/>
      <text x="0" y="-45" text-anchor="middle" font-size="17" font-weight="800" fill="${C.forest}">테마 박스</text>
    </g>
    ${strip('트리나 박스 플러스', '과일과 월 1회 테마 박스까지', '월 39만 원부터', '(부가세 별도)', true)}`)
}

function season(): string {
  return svg(800, 800, `
    <rect width="800" height="800" fill="${C.cream}"/>
    <circle cx="400" cy="350" r="286" fill="${C.sage}"/>
    ${dots(34, 800, 640, ['#FFFFFF', C.sageMid, '#E6C98F'], 23, (x, y) => Math.hypot(x - 400, y - 350) > 290 && y > 600)}
    <ellipse cx="400" cy="604" rx="250" ry="18" fill="#000" opacity=".08"/>
    ${sprig(196, 600, -18, 1.25)}${sprig(610, 604, 16, 1.1)}
    ${giftBox(400, 600, 330, 270, C.forest, C.forestDeep, C.red)}
    <g transform="translate(560 452) rotate(10)">
      <path d="M-18 -60 L-60 -96" stroke="${C.mute}" stroke-width="2"/>
      <rect x="-30" y="-64" width="150" height="64" rx="10" fill="${C.paper}"/>
      <circle cx="-14" cy="-32" r="6" fill="${C.sand}"/>
      <text x="50" y="-25" text-anchor="middle" font-size="19" font-weight="800" fill="${C.forest}">연말 시즌 박스</text>
    </g>
    ${starCookie(150, 470, 34, -12)}${starCookie(668, 520, 28, 14)}
    ${cookie(250, 604, 24)}${cookie(560, 604, 22)}
    ${strip('연말 시즌 박스', '12월 1일(화)–24일(목) 발송', '사전 주문 11월 16일(월)부터', '연말·송년회 선물용, 한 번만 주문', false)}`)
}

function keyVisual(): string {
  const [back, front] = openBox(0, 0, 260, 170, '트리나 박스', '플러스', 40)
  return svg(1200, 630, `
    <rect width="1200" height="630" fill="${C.cream}"/>
    <circle cx="900" cy="320" r="268" fill="${C.sage}"/>
    ${dots(26, 1200, 630, ['#FFFFFF', C.sageMid, '#E6C98F'], 5, (x, y) => x < 640 || Math.hypot(x - 900, y - 320) < 280)}
    <text x="72" y="92" font-size="26" font-weight="800" fill="${C.forest}" letter-spacing="-.5">트리나 박스</text>
    <rect x="72" y="140" width="250" height="44" rx="22" fill="${C.forest}"/>
    <text x="197" y="170" text-anchor="middle" font-size="20" font-weight="700" fill="${C.cream}">연말 사무실 간식 박스</text>
    <text font-size="54" font-weight="800" fill="${C.forest}" letter-spacing="-1.5">
      <tspan x="68" y="262">올해 마지막 한 달,</tspan>
      <tspan x="68" y="334">사무실 간식은</tspan>
      <tspan x="68" y="406">트리나 박스에 맡기세요</tspan>
    </text>
    <text x="72" y="462" font-size="24" font-weight="500" fill="${C.mute}">체험 박스 무료 · 연말 시즌 박스 사전 주문</text>
    <rect x="72" y="500" width="246" height="62" rx="31" fill="${C.tangerine}"/>
    <text x="195" y="540" text-anchor="middle" font-size="23" font-weight="800" fill="${C.priceInk}">체험 박스 신청하기</text>
    <text x="340" y="539" font-size="19" font-weight="500" fill="${C.mute}">11월 16일(월) – 12월 13일(일)</text>
    <ellipse cx="900" cy="552" rx="270" ry="16" fill="#000" opacity=".08"/>
    <g transform="translate(786 550)">
      ${back}
      ${dripBag(-78, -262, -9, C.sageMid, 1.15)}${chips(-6, -278, 4, C.forest, 84, 112)}${dripBag(70, -258, 8, '#E7C9A1', 1.15)}
      ${front}
    </g>
    ${giftBox(1052, 552, 160, 140, C.forest, C.forestDeep, C.red)}
    ${sprig(1146, 558, 12, 0.72)}
    ${starCookie(672, 534, 24, -10)}${cookie(948, 558, 18)}${cookie(728, 560, 14)}`)
}

async function images(): Promise<Map<string, string>> {
  const shots: [string, number, number, string][] = [
    [`${BRAND}/트리나-로고.png`, 600, 240, logo()],
    [`${BRAND}/제품-베이직.png`, 800, 800, basic()],
    [`${BRAND}/제품-플러스.png`, 800, 800, plus()],
    [`${BRAND}/제품-시즌박스.png`, 800, 800, season()],
    [`${BRAND}/캠페인-키비주얼.png`, 1200, 630, keyVisual()],
  ]
  const browser = await chromium.launch()
  const written = new Map<string, string>()
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 })
    for (const [rel, w, h, body] of shots) {
      await page.setViewportSize({ width: w, height: h })
      await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;overflow:hidden}svg{display:block}</style></head><body>${body}</body></html>`)
      await page.evaluate(() => document.fonts.ready)
      const png = new Uint8Array(await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: w, height: h } }))
      if (png.byteLength > PNG_MAX) throw new Error(`${rel} is ${png.byteLength} bytes, more than ${PNG_MAX}`)
      write(rel, png)
      written.set(rel, path.join(OUT, rel))
    }
  } finally { await browser.close() }
  return written
}

// ---------------------------------------------------------------- pandoc

// pandoc stamps the slides with this time (SOURCE_DATE_EPOCH), so running again gives the same files
const PANDOC_ENV = { ...process.env, SOURCE_DATE_EPOCH: String(Date.UTC(2026, 10, 4) / 1000) }

function run(cmd: string[], cwd: string): string {
  const p = Bun.spawnSync(cmd, { cwd, env: PANDOC_ENV })
  if (p.exitCode !== 0) throw new Error(`${cmd[0]} failed: ${p.stderr.toString()}`)
  return p.stdout.toString()
}

/**
 * The slides' reference deck: pandoc's own, with the brand's forest green as the theme accent (table headers) and an
 * East Asian theme font. pandoc's theme names 맑은 고딕 only for the Hangul script, which PowerPoint reads but other
 * viewers (LibreOffice, and so the previews made with it) do not: their Korean text came out blank.
 */
function referenceDeck(dir: string): string {
  run(['pandoc', '-o', 'reference.pptx', '--print-default-data-file', 'reference.pptx'], dir)
  run(['unzip', '-q', 'reference.pptx', '-d', 'ref'], dir)
  for (const name of fs.readdirSync(path.join(dir, 'ref', 'ppt', 'theme'))) {
    const p = path.join(dir, 'ref', 'ppt', 'theme', name)
    const xml = fs.readFileSync(p, 'utf8')
    const out = xml.replaceAll('<a:ea typeface=""/>', '<a:ea typeface="맑은 고딕"/>')
      .replace('<a:accent1><a:srgbClr val="4F81BD"/>', `<a:accent1><a:srgbClr val="${C.forest.slice(1)}"/>`)
      .replace('<a:dk2><a:srgbClr val="1F497D"/>', `<a:dk2><a:srgbClr val="${C.forestDeep.slice(1)}"/>`)
    if (name === 'theme1.xml' && (out === xml || out.includes('<a:ea typeface=""/>') || !out.includes(C.forest.slice(1)))) throw new Error('pandoc\'s reference deck changed: the theme patch no longer applies')
    fs.writeFileSync(p, out)
    // pandoc keeps the reference's file times: the edited files get the same fixed time as everything else
    const t = new Date(Number(PANDOC_ENV.SOURCE_DATE_EPOCH) * 1000)
    fs.utimesSync(p, t, t)
  }
  fs.rmSync(path.join(dir, 'reference.pptx'))
  run(['zip', '-q', '-X', '-r', '../reference.pptx', '.'], path.join(dir, 'ref'))
  return path.join(dir, 'reference.pptx')
}

/** `files` are copied next to the Markdown and referenced by their names: no path of this Mac ends up in a file */
function pandoc(args: string[], input: string, out: string, files: string[] = []): Uint8Array {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trina-assets-'))
  try {
    fs.writeFileSync(path.join(tmp, 'in.md'), input)
    for (const f of files) fs.copyFileSync(f, path.join(tmp, path.basename(f)))
    if (args.includes('pptx')) args = [...args, '--reference-doc', referenceDeck(tmp)]
    const p = Bun.spawnSync(['pandoc', 'in.md', ...args, '-o', out], { cwd: tmp, env: PANDOC_ENV })
    if (p.exitCode !== 0) throw new Error('pandoc failed: ' + p.stderr.toString())
    return new Uint8Array(fs.readFileSync(path.join(tmp, out)))
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
}

// pandoc's own Markdown, without ~sub~ and ^super^: "10~100명" stays text
const MD = 'markdown-subscript-superscript'
// slides: a picture without alt text, which pandoc would print under it as a caption
const SLIDES = ['-f', MD, '-t', 'pptx']

// ---------------------------------------------------------------- proposals (A사 가람소프트, the template)

/** A사's first-month quote, priced from groups/마케팅팀/제안서/트리나-박스-가격표.md: the slides and the spreadsheet both use it */
const A = {
  no: 'TR-Q-2026-1028-01', date: '2026-10-28', dateKo: '2026년 10월 28일(수)', valid: '2026년 11월 27일(금)',
  customer: '가람소프트', plan: 390_000, extra: 20_000, discountRate: 0.1,
  discountBy: '11월 18일(수)', start: '12월 1일(화)',
}
const aMonthly = A.plan + A.extra
const aDiscount = -Math.round(aMonthly * A.discountRate)
const aSupply = aMonthly + aDiscount
const aVat = Math.round(aSupply * 0.1)
if (aMonthly !== 410_000) throw new Error(`A사 monthly fee is ${aMonthly}, the proposal says 410,000`)
const won = (n: number) => `${n < 0 ? '−' : ''}${Math.abs(n).toLocaleString('en')}원`

/** a picture on a slide: [file, what it shows (for this script's reader; the slide has no caption)] */
type Pic = [string, string]
const pic = (img: Map<string, string>, rel: string, about: string): Pic => [img.get(rel)!, about]

function deck(o: {
  title: string; subtitle: string; date: string; author: string
  now: string[]; nowImage?: Pic; offer: string[]; offerImage?: Pic
  price: [string, string][]; priceNote: string[]; schedule: [string, string][]; contact: string[]; contactImage?: Pic
}): string {
  const cols = (left: string[], pic?: Pic) => pic
    ? `:::::: {.columns}\n::: {.column width="56%"}\n${left.join('\n')}\n:::\n::: {.column width="44%"}\n![](${path.basename(pic[0])}){width=3.4in}\n:::\n::::::`
    : left.join('\n')
  const table = (head: [string, string], rows: [string, string][]) =>
    [`| ${head[0]} | ${head[1]} |`, '|---|---|', ...rows.map(([a, b]) => `| ${a} | ${b} |`)].join('\n')
  return `---
title: "${o.title}"
subtitle: "${o.subtitle}"
date: "${o.date}"
author: "${o.author}"
---

# 고객사 현황과 요구

${cols(o.now, o.nowImage)}

# 제안 구성

${cols(o.offer, o.offerImage)}

# 가격과 견적 요약

${table(['항목', '월 금액 (부가세 별도)'], o.price)}

${o.priceNote.join('\n')}

# 도입 일정

${table(['날짜', '할 일'], o.schedule)}

# 담당자·문의

${cols(o.contact, o.contactImage)}
`
}

function templateDeck(): string {
  return deck({
    title: '트리나 박스 제안서', subtitle: '[고객사명] 귀중', date: '[제안 날짜, 예: 2026년 11월 20일(금)]', author: '트리나 [팀] [담당자]',
    now: [
      '- 업종·인원: [업종], 직원 [인원]명 ([사무실 수와 위치])',
      '- 지금: [이용 중인 플랜 또는 "이용 안 함"]',
      '- 요구 1: [미팅에서 들은 요구]',
      '- 요구 2: [미팅에서 들은 요구]',
      '- 예산·결정: 월 [금액] 이내, 결정권자 [직책]',
    ],
    offer: [
      '- 박스: [트리나 박스 베이직 / 트리나 박스 플러스 / 연말 시즌 박스]',
      '- 배송 주기: [주 1회 / 2주 1회 / 추가 배송], [요일]',
      '- 인원 기준: [인원]명, [사무실 수]곳',
      '- 구성: [커피, 간식, 과일, 테마 박스 등]',
      '- 이 구성을 고른 이유: [요구와 연결해서 한 줄]',
    ],
    price: [['[플랜] 월 구독 ([인원]명, [배송 주기])', '[금액]원'], ['[추가 항목]', '[금액]원'], ['[할인: ○월 ○일까지 신청하면 첫 달 ○% 할인]', '−[금액]원'], ['첫 달 청구', '[금액]원']],
    priceNote: ['- 부가세 포함 첫 달 [금액]원, 둘째 달부터 월 [금액]원', '- 자세한 내용: 견적서 [견적 번호] (유효기간 [날짜]까지)'],
    schedule: [['[날짜(요일)]', '제안 검토 미팅'], ['[날짜(요일)]', '계약'], ['[날짜(요일)]', '직원 취향 설문'], ['[날짜(요일)]', '첫 박스 구성 확정'], ['[날짜(요일)]', '첫 배송']],
    contact: ['- 영업 담당: 트리나 영업팀 [이름] · [이메일]', '- 제안서·구성 문의: 트리나 마케팅팀 [이름] · [이메일]', '- 견적 유효기간: [날짜]까지'],
  })
}

function aDeck(img: Map<string, string>): string {
  return deck({
    title: '트리나 박스 플러스 제안서', subtitle: `${A.customer} 귀중`, date: A.dateKo, author: '트리나 마케팅팀 서민재',
    now: [
      '- 업종·인원: IT 서비스, 직원 45명 (판교 사무실 1곳)',
      '- 지금: 트리나 박스 베이직, 주 1회 배송 (화)',
      '- 요구 1: 간식이 목요일쯤 떨어져요. 주 후반에도 채워 주세요',
      '- 요구 2: 과일 요청이 늘었어요',
      '- 예산·결정: 월 50만 원 이내 (부가세 포함), 결정권자 경영지원팀장',
    ],
    nowImage: pic(img, `${BRAND}/제품-베이직.png`, '트리나 박스 베이직: 커피와 기본 간식, 월 19만 원부터'),
    offer: [
      '- 박스: 트리나 박스 베이직 → **트리나 박스 플러스**',
      '- 배송 주기: 주 2회 (화·금). 기본 주 1회 + 추가 배송 주 1회',
      '- 인원 기준: 45명, 판교 사무실 1곳',
      '- 구성: 커피·차·과자에 과일·간편식, 월 1회 테마 박스',
      '- 이 구성을 고른 이유: 주 후반 간식 부족과 과일 요청을 한 번에 풀어요',
    ],
    offerImage: pic(img, `${BRAND}/제품-플러스.png`, '트리나 박스 플러스: 과일과 월 1회 테마 박스까지, 월 39만 원부터'),
    price: [
      ['트리나 박스 플러스 월 구독 (50명까지, 주 1회)', won(A.plan)],
      ['주 1회 추가 배송', won(A.extra)],
      ['월 구독료', won(aMonthly)],
      [`첫 달 할인: ${A.discountBy}까지 신청하면 첫 달 10% 할인`, won(aDiscount)],
      ['첫 달 청구', won(aSupply)],
    ],
    priceNote: [`- 부가세 포함 첫 달 ${won(aSupply + aVat)}, 둘째 달부터 월 ${won(Math.round(aMonthly * 1.1))}`, `- 자세한 내용: 견적서 ${A.no} (유효기간 ${A.valid}까지)`],
    schedule: [
      ['11월 6일(금)', '제안 검토 미팅 (화상)'],
      [A.discountBy, '계약 (첫 달 할인 신청 마감)'],
      ['11월 23일(월)–25일(수)', '직원 취향 설문'],
      ['11월 27일(금)', '첫 박스 구성 확정'],
      [A.start, '플러스 첫 배송, 이후 매주 화·금'],
    ],
    contact: ['- 영업 담당: 트리나 영업팀 배성민 · sungmin@trina-box.example', '- 제안서·구성 문의: 트리나 마케팅팀 서민재 · minjae@trina-box.example', `- 견적 유효기간: ${A.valid}까지`],
    contactImage: pic(img, `${BRAND}/트리나-로고.png`, '트리나 박스 로고'),
  })
}

/** A sheet from rows; numbers in the `money` columns get a thousands format. */
function sheet(rows: (string | number | null)[][], widths: number[], money: number[] = []): XLSX.WorkSheet {
  const ws = XLSX.utils.aoa_to_sheet(rows)
  for (let r = 1; r < rows.length; r++) {
    for (const c of money) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })]
      if (cell?.t === 'n') cell.z = '#,##0'
    }
  }
  ws['!cols'] = widths.map((wch) => ({ wch }))
  return ws
}

/** A formula with its value: viewers and the AI's xlsx reader do not recalculate. */
function formula(ws: XLSX.WorkSheet, addr: string, f: string, v: number, z = '#,##0') {
  ws[addr] = { t: 'n', f, v, z }
}

function book(...sheets: [string, XLSX.WorkSheet][]): Uint8Array {
  const wb = XLSX.utils.book_new()
  for (const [name, ws] of sheets) XLSX.utils.book_append_sheet(wb, ws, name)
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx', compression: true }))
}

function aQuote(): Uint8Array {
  const rows: (string | number | null)[][] = [
    ['견적서'],
    ['견적 번호', A.no],
    ['일자', A.date],
    ['고객사', `${A.customer} (IT 서비스, 직원 45명, 판교 사무실 1곳)`],
    ['공급자', '주식회사 트리나 · 영업팀 배성민, 마케팅팀 서민재'],
    [],
    ['품목', '수량', '단가', '금액', '비고'],
    ['트리나 박스 플러스 월 구독 (50명까지, 주 1회 배송)', 1, A.plan, null, '직원 45명. 과일·간편식, 월 1회 테마 박스 포함'],
    ['주 1회 추가 배송', 1, A.extra, null, '같은 주소, 주 2회 배송 (화·금)'],
    ['첫 달 할인 (10%)', 1, aDiscount, null, `${A.discountBy}까지 신청하면 첫 달만`],
    ['공급가액', null, null, null, '첫 달 기준'],
    ['부가세 (10%)', null, null, null, ''],
    ['합계', null, null, null, '첫 달 청구 금액 (부가세 포함)'],
    [],
    [`둘째 달부터는 월 ${aMonthly.toLocaleString('en')}원 (부가세 별도), 부가세 포함 ${Math.round(aMonthly * 1.1).toLocaleString('en')}원이에요.`],
  ]
  const ws = sheet(rows, [44, 8, 12, 12, 36], [1, 2, 3])
  formula(ws, 'D8', 'B8*C8', A.plan)
  formula(ws, 'D9', 'B9*C9', A.extra)
  formula(ws, 'C10', '-ROUND((D8+D9)*0.1,0)', aDiscount)
  formula(ws, 'D10', 'B10*C10', aDiscount)
  formula(ws, 'D11', 'SUM(D8:D10)', aSupply)
  formula(ws, 'D12', 'ROUND(D11*0.1,0)', aVat)
  formula(ws, 'D13', 'D11+D12', aSupply + aVat)
  const terms = sheet([
    ['항목', '내용'],
    ['유효기간', `${A.valid}까지 (견적일로부터 30일)`],
    ['할인 조건', `${A.discountBy}까지 신청하면 첫 달 10% 할인 (첫 달 1회)`],
    ['결제 조건', '매달 말일 기준 결제, 세금계산서는 말일에 발행'],
    ['배송 조건', '주 2회 (화·금) 오전, 판교 사무실 1곳. 배송비 포함. 공휴일이면 다음 영업일'],
    ['계약 기간', '최소 3개월, 이후 1개월 단위로 자동 연장'],
    ['도입', `${A.start} 첫 배송`],
    ['문의', '트리나 영업팀 배성민 · sungmin@trina-box.example'],
  ], [12, 70])
  return book(['견적', ws], ['조건', terms])
}

const B_MEMO = `# B사 미팅 메모 — 나래물류

- 일시: 2026-11-04(수) 14:00–14:40, 나래물류 본사
- 참석: 나래물류 총무팀 모상진 팀장, 구하린 대리 / 트리나 영업팀 임채원, 마케팅팀 서민재
- 작성: 임채원

## 회사
- 물류, 직원 80명: 본사 20명 + 물류센터 2곳 60명 (이천 35명, 평택 25명)
- 지금은 본사만 트리나 박스 베이직 이용 중
- 물류센터는 주야 2교대. 야간조(22:00–07:00)가 먹을 간식이 없다는 말이 많음

## 요구
- 세 곳 모두 받는 구성. 물류센터는 야간에 먹기 쉬운 간식 위주
- 월 예산 60만 원 이내 (부가세 별도)
- 연말 감사 선물로 시즌 박스에 관심: 80명에게 1인 1박스, 12월 셋째 주 수령 희망
- 결정권자: 모상진 총무팀장
- 11월 20일(금)까지 제안서를 받고 싶다고 함

## 참고
- 다른 업체 한 곳에서도 견적을 받는 중 (탕비로그)
- 시즌 박스 가격은 대표가 11/9(월)에 확정. 그 전까지 제안서에는 "가격 확정 후 안내"

## 할 일
| 담당 | 할 일 | 기한 |
|---|---|---|
| 임채원 | 물류센터 배송 가능 요일·시간 확인 | 11/10(화) |
| 서민재 | 제안서 초안 (가람소프트 제안서 형식) | 11/18(수) |
| 임채원 | 제안서 발송 (sangjin.mo@narae-logis.example) | 11/20(금) |
`

// ---------------------------------------------------------------- October performance

type Row = { week: string; span: string; ch: string; imp: number; clicks: number; trials: number; spend: number }
const WEEKS: [string, string][] = [['10월 1주', '10/1–10/4'], ['10월 2주', '10/5–10/11'], ['10월 3주', '10/12–10/18'], ['10월 4주', '10/19–10/25'], ['10월 5주', '10/26–10/31']]
const CHANNELS = ['인스타그램', '네이버 검색광고', '카카오 배너', '블로그']
// per channel, per week: [노출, 클릭, 체험 신청, 광고비]
const PERF: Record<string, [number, number, number, number][]> = {
  인스타그램: [[43_000, 790, 2, 280_000], [80_000, 1_480, 5, 520_000], [83_000, 1_600, 5, 540_000], [86_000, 1_700, 6, 560_000], [74_000, 1_450, 4, 500_000]],
  '네이버 검색광고': [[16_200, 470, 4, 440_000], [31_500, 940, 9, 860_000], [32_800, 975, 9, 880_000], [34_000, 1_015, 10, 920_000], [27_000, 800, 8, 720_000]],
  '카카오 배너': [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [52_000, 260, 1, 200_000]],
  블로그: [[2_100, 60, 2, 0], [3_400, 110, 4, 0], [3_600, 120, 4, 0], [3_900, 130, 4, 0], [3_200, 105, 3, 0]],
}
const TARGETS: [string, number, string][] = [
  ['인스타그램', 25, ''],
  ['네이버 검색광고', 38, ''],
  ['카카오 배너', 3, '11월 캠페인 전 테스트. 10/26(월)부터 집행'],
  ['블로그', 12, '광고비 없음 (글 제작은 콘텐츠 제작 항목)'],
]

function marketingBudgetOctober(): number {
  const rel = 'shared/경영/팀별/마케팅팀/2026-4분기-마케팅팀-예산.xlsx'
  const wb = XLSX.read(fs.readFileSync(path.join(OUT, rel)))
  const rows = XLSX.utils.sheet_to_json<(string | number)[]>(wb.Sheets[wb.SheetNames[0]!]!, { header: 1 })
  const head = rows[0]!
  const spentCol = head.indexOf('10월 집행')
  const line = rows.find((r) => r[0] === '광고비 (상시)')
  if (spentCol < 0 || !line || typeof line[spentCol] !== 'number') throw new Error(`${rel}: no 10월 집행 for 광고비 (상시)`)
  return line[spentCol] as number
}

function performance(): Uint8Array {
  const rows: Row[] = WEEKS.flatMap(([week, span], i) => CHANNELS.map((ch) => {
    const [imp, clicks, trials, spend] = PERF[ch]![i]!
    return { week, span, ch, imp, clicks, trials, spend }
  }))
  // the October ad spend is the 마케팅팀 budget sheet's "광고비 (상시)" 10월 집행
  const budget = marketingBudgetOctober()
  const spend = sum(rows.map((r) => r.spend))
  if (spend !== budget) throw new Error(`October ad spend is ${spend}, the 마케팅팀 budget sheet says ${budget}`)
  if (rows.some((r) => r.ch === '블로그' && r.spend !== 0)) throw new Error('the blog has no ad spend')
  // weeks 1-4 are what the 10/27 마케팅팀 meeting reported for 10/1-10/25
  const first4 = rows.filter((r) => r.week !== '10월 5주')
  const of = (ch: string, k: keyof Row) => sum(first4.filter((r) => r.ch === ch).map((r) => r[k] as number))
  const check = [of('인스타그램', 'spend') === 1_900_000, of('네이버 검색광고', 'spend') === 3_100_000, of('네이버 검색광고', 'clicks') === 3_400,
    sum(first4.map((r) => r.trials)) === 64, Math.abs(of('인스타그램', 'clicks') / of('인스타그램', 'imp') - 0.019) < 0.0005]
  if (check.includes(false)) throw new Error(`weeks 1-4 drift from the 10/27 meeting notes: ${check}`)
  const weekly = sheet([['주차', '기간', '채널', '노출', '클릭', '체험 신청', '광고비(원)'],
    ...rows.map((r) => [r.week, r.span, r.ch, r.imp, r.clicks, r.trials, r.spend])], [10, 12, 16, 10, 8, 10, 12], [3, 4, 5, 6])
  const goals = sheet([
    ['채널', '10월 목표 체험 신청', '메모'],
    ...TARGETS.map(([ch, n, memo]) => [ch, n, memo]),
    [],
    ['광고비는 10월 31일 마감 기준 광고 관리 화면 집계예요. 블로그 노출은 글 조회수, 클릭은 랜딩 페이지로 넘어간 수예요.'],
    ['체험 신청은 랜딩 페이지 신청서의 유입 채널 기준이에요. 10월에는 기존 고객 문자를 보내지 않았어요.'],
    ['10월 광고비 합계는 마케팅팀 4분기 예산 시트 "광고비 (상시)"의 10월 집행과 같아요.'],
    ['정리: 이하늘 (2026-11-02)'],
  ], [16, 18, 44])
  return book(['주간', weekly], ['목표', goals])
}

const COMPETITORS = `# 경쟁사 연말 동향 메모

- 정리: 이하늘 (2026-11-04). 영업팀 통화 메모와 광고 화면에서 모았어요.
- 내부 참고용이에요. 광고·SNS 문구에는 다른 회사 이름을 쓰지 않아요 (브랜드 가이드).

## 데스크곳간
- 가격대: 월 15만 원부터 (직원 20명 이하 사무실 위주)
- 연말 프로모션: 송년회 간식 세트 20% 할인, 11월 9일(월)–12월 20일(일)
- 강점: 시작 가격이 낮음, 주문 다음 날 배송
- 약점: 커피 없이 간식만, 정기 배송은 2주 1회만
- 출처: 영업팀 고객 통화 메모 11/2 (바른디자인랩)

## 모락오피스
- 가격대: 월 35만 원부터, 커피 머신 대여 포함
- 연말 프로모션: 12월까지 계약하면 3개월 15% 할인, 11월 1일(일)–12월 31일(목). 12개월 약정 조건
- 강점: 원두와 커피 머신 관리
- 약점: 최소 12개월 약정, 간식 종류가 적음
- 출처: 인스타그램 광고 화면 (10/30 캡처)

## 탕비로그
- 가격대: 월 25만 원부터. 시즌 선물 박스는 1인 1만 8천 원부터
- 연말 프로모션: 선물 박스 50개 이상 주문하면 메시지 카드 무료, 11월 16일(월)–12월 18일(금) 주문분
- 강점: 선물 포장, 대량 주문
- 약점: 정기 배송이 늦는다는 불만, 물류센터·야간 배송은 안 함
- 출처: 나래물류 미팅 메모 11/4, 영업팀 고객 통화 메모 10/29 (자람바이오)
`

// ---------------------------------------------------------------- the association's letter (.hwpx)

const NB = '  '
const LETTER = `# (사)사무공간복지협회

**수신** 주식회사 트리나 대표이사

**(경유)**

**제목** 연말 사무공간 복지 캠페인 참여 협조 요청

1\\. 관련: (사)사무공간복지협회 2026년 사업계획 "회원사 사무공간 복지 지원" (2026. 1. 15. 정기총회 의결)

2\\. 위 호와 관련하여 우리 협회는 회원사 직원의 연말 복지를 위해 아래와 같이 캠페인을 진행하고자 하오니, 사무실 간식 서비스를 운영하는 귀사의 참여를 요청드립니다.

${NB}가. 캠페인명: 2026 연말 사무공간 복지 캠페인

${NB}나. 기간: 2026. 11. 23.(월) \\~ 12. 18.(금)

${NB}다. 대상: 협회 회원사 312곳 (직원 10\\~100명 규모 사무실 중심)

${NB}라. 내용: 참여 기업이 회원사에 사무실 간식·음료 할인 또는 체험 혜택을 제공하고, 협회는 회원사 소식지(12월호)와 누리집에 참여 기업과 혜택을 안내

3\\. 요청 사항: 참여를 희망하시는 경우 붙임 신청서에 아래 사항을 적어 **2026. 11. 13.(금)까지** 전자우편으로 회신하여 주시기 바랍니다.

${NB}가. 캠페인 참여 여부

${NB}나. 회원사에 제공 가능한 할인율 및 혜택 (적용 기간과 조건 포함)

${NB}다. 담당자 성명, 부서, 연락처 (전화, 전자우편)

4\\. 문의: 협회 사업지원팀 대리 윤소담 (전화 02-000-0000, 전자우편 campaign@office-welfare.example)

붙임 2026 연말 사무공간 복지 캠페인 참여 신청서 양식 1부. 끝.

**(사)사무공간복지협회장** (직인 생략)

기안자 사업지원팀 대리 윤소담 / 검토자 사업지원팀장 백지호 / 전결 사무국장

시행 사복협-2026-118 (2026. 11. 4.) / 접수

우 04500 서울특별시 중구 예시로 12, 5층 / 누리집 office-welfare.example

전화 02-000-0000 / 전송 02-000-0001 / campaign@office-welfare.example / 공개

\\newpage

## [붙임] 2026 연말 사무공간 복지 캠페인 참여 신청서

| 항목 | 작성란 |
|---|---|
| 회사명 | |
| 대표자 | |
| 참여 여부 | 참여 / 불참 |
| 제공 혜택 (할인율·내용) | |
| 적용 기간과 조건 | |
| 담당자 (성명·부서) | |
| 연락처 (전화·전자우편) | |

신청일: 2026년 월 일

신청 기업: (인)

※ 2026. 11. 13.(금)까지 campaign@office-welfare.example 로 보내 주세요.
`

function letter(): Uint8Array {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trina-letter-'))
  try {
    fs.writeFileSync(path.join(tmp, 'in.md'), LETTER)
    const p = Bun.spawnSync(['pandoc', 'in.md', '-f', MD, '-t', 'json'], { cwd: tmp })
    if (p.exitCode !== 0) throw new Error('pandoc failed: ' + p.stderr.toString())
    const bytes = writeHwpx(JSON.parse(p.stdout.toString()))
    // read it back the way the product does
    const text = hwpxText(bytes)
    for (const want of ['연말 사무공간 복지 캠페인 참여 협조 요청', '주식회사 트리나 대표이사', '2026. 11. 13.(금)까지', '사복협-2026-118', '참여 신청서']) {
      if (!text.includes(want)) throw new Error(`the .hwpx does not read back "${want}"`)
    }
    return bytes
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
}

// ---------------------------------------------------------------- write

const img = await images()
write(`${MKT}/제안서/제안서-템플릿.pptx`, pandoc(SLIDES, templateDeck(), 'out.pptx'))
write(`${MKT}/제안서/A사-제안서-가람소프트.pptx`, pandoc(SLIDES, aDeck(img), 'out.pptx', [...img.values()]))
write(`${MKT}/제안서/A사-견적서-가람소프트.xlsx`, aQuote())
write(`${MKT}/제안서/B사-미팅메모-나래물류.md`, B_MEMO)
write(`${MKT}/성과/2026-10-채널별-성과.xlsx`, performance())
write(`${MKT}/경쟁사/경쟁사-동향-메모.md`, COMPETITORS)
write('shared/공문/2026-11-04-연말-복지-캠페인-협조-요청.hwpx', letter())
