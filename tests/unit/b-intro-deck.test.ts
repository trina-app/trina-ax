// Onboarding D2 (docs/DECISIONS.md "D2 — The first result is the company's intro deck"): the AI fills the slots of 6–10
// slides with the intro_deck tool; the server checks them (the order of the kinds, lines measured with the bundled
// Pretendard and 10 % to spare, numbers and names written in the sources, pictures from a brand folder big enough for
// their frame, a theme that fits the brand colour), lays every slide out once (one display list) and emits the preview
// (HTML), a PowerPoint file (our own writer) and a typst source for the PDF from that one list. The downloads are built
// from the checked row in intro_decks, with the pictures the chat's owner can read at build time.
// Every company here is made up.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { API, DECK_ARTIFACT_KEY, DECK_THEMES, IntroDeckInput, PromoVideoInput, type DeckSlide, type DeckTheme, type Locale } from '@mycel/shared/api'
import { startHarness, type Harness } from '../lib/b-harness'
import { waitFor } from '../lib/wait'
import { WORK } from '../lib/env'
import { TurnFiles, type ToolCtx } from '../../server/src/files/service'
import { readZip } from '../../server/src/files/zip-write'
import { extractText } from '../../server/src/files/extract'
import { which } from '../../server/src/config'
import { contrast } from '../../server/src/promo-video/colors'
import { fitText, labelCase, ROLES, SLACK, width } from '../../server/src/intro-deck/text'
import { colourClass, fittingThemes, lookFor, themeFor } from '../../server/src/intro-deck/theme'
import { cropFor, layoutDeck, PIC_RULES, type DeckDoc, type DeckLogo, type DeckOut, type Focus, type PicInfo, type SlideOut } from '../../server/src/intro-deck/layout'
import { layoutDeck2 } from '../../server/src/intro-deck/layout2'
import { deckHtml, esc } from '../../server/src/intro-deck/html'
import { buildPptx } from '../../server/src/intro-deck/pptx'
import { decodePng, encodePng, isCutout } from '../../server/src/intro-deck/png'
import { buildTypst, lit } from '../../server/src/intro-deck/typst'
import { checkDeckInput, orderProblems, slideTexts, SUPERLATIVES } from '../../server/src/intro-deck/spec'
import { forgetIntroDecks, isOwnOutput, pdfAvailable, pretendardDir } from '../../server/src/intro-deck/files'
import { deckToPromoInput } from '../../server/src/intro-deck/promo'

setDefaultTimeout(60_000)

// ── pictures made in code (only their sizes matter for the layout; real pixels where a PDF decodes them) ──────────
/** a PNG header that says w × h (no pixels: enough for the size reader and the PowerPoint file) */
function pngHead(w: number, h: number): Buffer {
  const b = Buffer.alloc(33 + 64)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).copy(b, 0)
  b.write('IHDR', 12, 'latin1')
  b.writeUInt32BE(w, 16)
  b.writeUInt32BE(h, 20)
  b[24] = 8; b[25] = 6
  return b
}
/** a real PNG of one colour; `clearEdge` px of transparent border (a cut-out) */
function realPng(w: number, h: number, rgba: [number, number, number, number] = [40, 90, 70, 255], clearEdge = 0): Buffer {
  const data = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const inside = x >= clearEdge && y >= clearEdge && x < w - clearEdge && y < h - clearEdge
    if (inside) data.set(rgba, (y * w + x) * 4)
  }
  return Buffer.from(encodePng({ width: w, height: h, data }))
}
/** a JPEG's first segments (SOI, APP0, SOF0) that say w × h */
function jpegHead(w: number, h: number): Buffer {
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9])
}
const sha = (b: Uint8Array) => crypto.createHash('sha256').update(b).digest('hex')

// ── fixed sample decks (made-up companies) ───────────────────────────────────────────────────────────────────────
const IMG = 'shared/브랜드/이미지/'
const PICS: Record<string, PicInfo> = {
  [IMG + 'wide.png']: { width: 1920, height: 1080 },
  [IMG + 'square.jpg']: { width: 1200, height: 1200 },
  [IMG + 'portrait.jpg']: { width: 1000, height: 1500 },
  [IMG + 'p1.png']: { width: 800, height: 600 },
  [IMG + 'p2.png']: { width: 800, height: 600 },
  [IMG + 'p3.png']: { width: 600, height: 800 },
  [IMG + 'hall.png']: { width: 2400, height: 1200 },
}

/** Four decks that between them use every kind and variant: a (cover A, offer A, numbers, products A and B, process,
 * proof A, history A), b (cover B, needs, offer B, scene, numbers between two dark slides), c (cover C, proof B,
 * history B), d (cover C, two needs, proof C). */
function koDecks(): DeckSlide[][] {
  return [[
    { kind: 'cover', eyebrow: '회사 소개서', headline: '정밀 부품을\n*제때* 만드는 회사', sub: '반도체 장비와 의료기기 부품을 만듭니다', picture: IMG + 'wide.png', focus: 'bottom' },
    { kind: 'about', eyebrow: '회사 소개', statement: '반도체 장비와 의료기기에 들어가는 *정밀 가공 부품*을 설계하고 만듭니다', facts: [{ label: '설립', value: '2009년' }, { label: '위치', value: '경기도 안산' }, { label: '분야', value: '정밀 가공' }, { label: '직원', value: '48명' }] },
    { kind: 'offer', eyebrow: '하는 일', title: '설계부터 납품까지 *한 곳에서*', sub: '도면 한 장으로 시작해요', picture: IMG + 'square.jpg', focus: 'left',
      pillars: [{ head: '정밀 가공', body: '다섯 축 장비로 아주 작게 깎아요' }, { head: '품질 검사', body: '모든 부품을 측정기로 확인해요' }, { head: '제때 납품', body: '약속한 날짜에 맞춰 보내 드려요' }] },
    { kind: 'numbers', eyebrow: '숫자로 보는 회사', title: '고객이 다시 찾는 이유', stats: [{ number: '340곳', label: '거래 고객사' }, { number: '0.02%', label: '불량률' }, { number: '99.1%', label: '납기 준수율' }, { number: '+30%', label: '재주문 증가' }], note: '2025년 12월 기준' },
    { kind: 'products', eyebrow: '제품', title: '주요 부품', items: [{ name: '정밀 샤프트', body: '장비 구동부에 들어가는 축이에요', picture: IMG + 'p1.png' }, { name: '진공 블록', body: '반도체 공정 챔버용 블록이에요', picture: IMG + 'p2.png', focus: 'top' }, { name: '의료용 핀', body: '수술 기구에 쓰는 작은 핀이에요', picture: IMG + 'p3.png', focus: 'bottom' }] },
    { kind: 'products', eyebrow: '제품', title: '맞춤 가공도 해요', items: [{ name: '시제품 가공', body: '도면만 있으면 한 개부터 만들어요' }, { name: '소량 양산', body: '적은 수량의 주문도 받아요' }] },
    { kind: 'process', eyebrow: '진행 방식', title: '주문은 이렇게 진행돼요', steps: [{ head: '도면 상담', body: '도면을 보고 가공 방법을 정해요' }, { head: '견적', body: '사흘 안에 보내 드려요' }, { head: '가공', body: '전담 팀이 맡아요' }, { head: '검사와 납품' }] },
    { kind: 'proof', eyebrow: '고객사', title: '함께 일하는 고객사', names: ['아크메전자', '아크메메디칼', '아크메테크', '아크메로보틱스', '아크메기계', '아크메정공'] },
    { kind: 'history', eyebrow: '연혁', title: '한 걸음씩 걸어온 길', items: [{ when: '2009', what: '안산에서 창업' }, { when: '2014', what: '의료기기 부품 시작' }, { when: '2019', what: '두 번째 공장 준공' }, { when: '2025.03', what: '가공 라인 증설' }] },
    { kind: 'contact', eyebrow: '문의', line: '부품 견적이 필요하면\n*연락 주세요*', offer: '첫 견적 무료', person: '영업팀 박서준 이사', email: 'sales@acme-precision.example', phone: '031-555-0142', website: 'acme-precision.example', address: '경기도 안산시 단원구 예시로 12' },
  ], [
    { kind: 'cover', headline: '작은 공장의\n큰 정밀함', sub: '정밀 가공 부품 전문', picture: IMG + 'portrait.jpg', focus: 'top' },
    { kind: 'about', eyebrow: '회사 소개', statement: '도면 한 장으로 *정밀 부품*을 만들어 드려요' },
    { kind: 'needs', eyebrow: '이런 고민', title: '부품 때문에 *일정이 밀린다면*', points: [{ head: '납기 지연', body: '부품이 늦어 조립이 멈춰요' }, { head: '들쭉날쭉한 품질', body: '같은 도면인데 결과가 달라요' }, { head: '소량 주문 거절', body: '적은 수량은 받아 주지 않아요' }] },
    { kind: 'offer', eyebrow: '하는 일', title: '세 가지를 약속해요', pillars: [{ head: '빠른 견적', body: '도면을 받으면 바로 답해요' }, { head: '같은 품질', body: '몇 번을 만들어도 같아요' }, { head: '소량도 환영', body: '한 개부터 만들어요' }] },
    { kind: 'scene', eyebrow: '공장', line: '안산 공장의 아침', picture: IMG + 'hall.png', focus: 'right' },
    { kind: 'numbers', eyebrow: '숫자', stats: [{ number: '340곳', label: '고객사' }, { number: '15년', label: '업력' }] },
    { kind: 'contact', line: '견적 문의는 메일로', email: 'sales@acme-precision.example' },
  ], [
    { kind: 'cover', eyebrow: '회사 소개서', headline: '부품이 멈추지 않게', sub: '정밀 가공 파트너' },
    { kind: 'about', eyebrow: '회사 소개', statement: '반도체 장비 부품을 만드는 *작은 공장*입니다', facts: [{ label: '설립', value: '2009년' }, { label: '대표', value: '한지민' }] },
    { kind: 'offer', eyebrow: '하는 일', title: '가공과 검사를 함께 해요', pillars: [{ head: '가공', body: '도면대로 깎아요' }, { head: '검사', body: '하나씩 재요' }, { head: '포장', body: '흠 없이 보내요' }] },
    { kind: 'proof', eyebrow: '고객의 말', title: '고객이 *직접* 말해요', quote: { text: '아크메정밀 덕분에 장비 조립 일정이 두 주 빨라졌어요', who: '아크메메디칼 구매팀 김하늘 팀장' } },
    { kind: 'history', eyebrow: '인증', title: '품질을 인증받았어요', trust: ['ISO 9001', 'ISO 13485', '벤처기업 인증', '이노비즈 인증'] },
    { kind: 'contact', line: '언제든 연락 주세요', phone: '031-555-0142', address: '경기도 안산시 단원구 예시로 12' },
  ], [
    { kind: 'cover', headline: '도면 한 장이면 충분해요' },
    { kind: 'about', eyebrow: '회사 소개', statement: '정밀 가공 부품을 만듭니다' },
    { kind: 'needs', eyebrow: '이런 분께', title: '이런 분께 맞아요', points: [{ head: '장비 제조사', body: '부품을 제때 받아야 하는 곳' }, { head: '연구소', body: '시제품이 급한 곳' }] },
    { kind: 'offer', eyebrow: '하는 일', title: '필요한 만큼 만들어요', pillars: [{ head: '시제품', body: '한 개부터' }, { head: '양산', body: '필요한 만큼' }, { head: '재주문', body: '같은 품질로' }] },
    { kind: 'proof', eyebrow: '사례', title: '조립 일정을 앞당긴 사례', case: { before: { label: '이전', text: '부품이 늦어 조립이 자주 멈췄어요' }, action: { label: '한 일', text: '전담 팀이 가공 순서를 다시 짰어요' }, result: { label: '결과', text: '조립 일정이 두 주 빨라졌어요' } } },
    { kind: 'contact', line: '견적을 받아 보세요', offer: '첫 견적 무료', email: 'sales@acme-precision.example' },
  ]]
}

function enDecks(): DeckSlide[][] {
  return [[
    { kind: 'cover', eyebrow: 'Company profile', headline: 'Cloud backups\nthat *just work*', sub: 'Backups for small teams, set up in minutes', picture: IMG + 'wide.png' },
    { kind: 'about', eyebrow: 'About us', statement: 'We keep the files of small teams *safe and easy to restore*', facts: [{ label: 'Founded', value: '2018' }, { label: 'Based in', value: 'Seoul' }, { label: 'Team', value: '35 people' }] },
    { kind: 'offer', eyebrow: 'What we do', title: 'Backups you never think about', picture: IMG + 'square.jpg', focus: 'right',
      pillars: [{ head: 'Automatic', body: 'Every file is saved each hour' }, { head: 'Encrypted', body: 'Only your team holds the key' }, { head: 'Fast restore', body: 'Get a folder back in one click' }] },
    { kind: 'numbers', eyebrow: 'In numbers', stats: [{ number: '1,200', label: 'teams' }, { number: '99.9%', label: 'uptime' }, { number: '4.8', label: 'app rating' }] },
    { kind: 'products', eyebrow: 'Plans', title: 'Pick a plan', items: [{ name: 'Starter', body: 'For teams of up to ten', picture: IMG + 'p1.png' }, { name: 'Business', body: 'For growing teams', picture: IMG + 'p2.png' }, { name: 'Enterprise', body: 'For large companies', picture: IMG + 'p3.png' }] },
    { kind: 'products', eyebrow: 'Add-ons', title: 'Add what you need', items: [{ name: 'Archive', body: 'Keep old files for years' }, { name: 'Audit log', body: 'See who opened what' }, { name: 'Support', body: 'A person answers' }, { name: 'Training', body: 'One session for the team' }] },
    { kind: 'process', eyebrow: 'How it works', title: 'Three steps to start', steps: [{ head: 'Sign up', body: 'Make an account' }, { head: 'Connect', body: 'Pick your folders' }, { head: 'Relax', body: 'We do the rest' }] },
    { kind: 'proof', eyebrow: 'Customers', title: 'Teams that trust us', names: ['Acme Studio', 'Acme North', 'Acme Harbor', 'Acme Pine & Co', 'Acme Labs', 'Acme Foods', 'Acme Media', 'Acme Works', 'Acme Law'] },
    { kind: 'history', eyebrow: 'Milestones', title: 'How we grew', items: [{ when: '2018', what: 'Founded in Seoul' }, { when: '2020', what: 'First thousand teams' }, { when: '2023', what: 'Opened in Tokyo' }, { when: '2024', what: 'Encrypted archive' }, { when: '2025', what: 'New restore engine' }] },
    { kind: 'contact', eyebrow: 'Contact', line: 'Try it free\nfor a month', offer: 'First month free', person: 'Mina Seo, Sales', email: 'hello@acmecloud.example', website: 'acmecloud.example' },
  ], [
    { kind: 'cover', headline: 'Your files,\nalways back', picture: IMG + 'portrait.jpg' },
    { kind: 'about', eyebrow: 'About us', statement: 'Backups for teams *without an IT department*' },
    { kind: 'needs', eyebrow: 'Sounds familiar', title: 'Losing a day of work hurts', points: [{ head: 'Lost laptops', body: 'A stolen laptop takes the files' }, { head: 'Broken drives', body: 'Drives fail without warning' }, { head: 'Wrong edits', body: 'Someone saves over the plan' }] },
    { kind: 'offer', eyebrow: 'What we do', title: 'We keep a copy of everything', pillars: [{ head: 'Hourly', body: 'Saved every hour' }, { head: 'Private', body: 'Encrypted end to end' }, { head: 'Simple', body: 'No setup to learn' }] },
    { kind: 'scene', line: 'Built in Seoul', picture: IMG + 'hall.png' },
    { kind: 'numbers', eyebrow: 'In numbers', stats: [{ number: '1,200', label: 'teams' }, { number: '+300%', label: 'growth' }] },
    { kind: 'contact', line: 'Talk to us', email: 'hello@acmecloud.example' },
  ], [
    { kind: 'cover', eyebrow: 'Company profile', headline: 'Never lose a file again', sub: 'Cloud backups for small teams' },
    { kind: 'about', eyebrow: 'About us', statement: 'A small team that *backs up* other small teams', facts: [{ label: 'Founded', value: '2018' }, { label: 'CEO', value: 'Dana Park' }] },
    { kind: 'offer', eyebrow: 'What we do', title: 'Backups, restores, peace', pillars: [{ head: 'Backups', body: 'Every hour' }, { head: 'Restores', body: 'In one click' }, { head: 'Reports', body: 'Every week' }] },
    { kind: 'proof', eyebrow: 'In their words', title: 'What a customer said', quote: { text: 'We got a whole folder back in two minutes', who: 'Jae Kim, Northwind' } },
    { kind: 'history', eyebrow: 'Trust', title: 'Checked by others', trust: ['ISO 27001', 'SOC 2 Type II', 'Startup of the year'] },
    { kind: 'contact', line: 'Write to us', email: 'hello@acmecloud.example', address: '12 Example-ro, Seoul' },
  ], [
    { kind: 'cover', headline: 'Backups for small teams' },
    { kind: 'about', eyebrow: 'About us', statement: 'We keep files safe' },
    { kind: 'needs', eyebrow: 'For you', title: 'Made for small teams', points: [{ head: 'Studios', body: 'Big files, no IT' }, { head: 'Clinics', body: 'Records kept safe' }] },
    { kind: 'offer', eyebrow: 'What we do', title: 'Three things we do', pillars: [{ head: 'Save', body: 'Every hour' }, { head: 'Lock', body: 'With your key' }, { head: 'Restore', body: 'In one click' }] },
    { kind: 'proof', eyebrow: 'A case', title: 'A design studio', case: { before: { label: 'Before', text: 'A drive failed and a week of work was gone' }, action: { label: 'What we did', text: 'Hourly backups of every project folder' }, result: { label: 'Result', text: 'A lost file comes back in minutes' } } },
    { kind: 'contact', line: 'Start your free month', email: 'hello@acmecloud.example' },
  ]]
}

interface Sample { theme: DeckTheme; lang: Locale; company: string; website: string | null; brand: string; logo: DeckLogo | null; decks: DeckSlide[][] }
const SAMPLES: Sample[] = [
  { theme: 'paper', lang: 'ko', company: '아크메정밀', website: 'acme-precision.example', brand: '#1e4620', decks: koDecks(),
    logo: { src: IMG + 'logo-wide.png', width: 480, height: 120, light: 'direct', dark: 'mono' } },
  { theme: 'ink', lang: 'en', company: 'Acme Cloud', website: 'acmecloud.example', brand: '#ff5a1f', decks: enDecks(), logo: null },
  { theme: 'brand', lang: 'ko', company: '아크메 커피', website: null, brand: '#1f3a93', decks: koDecks(),
    logo: { src: IMG + 'logo-square.png', width: 300, height: 300, light: 'direct', dark: 'chip' } },
]
const NOTE = '출처: 회사 소개.md — "…340곳의 고객사에 납품합니다…"'
function sampleDoc(s: Sample, slides: DeckSlide[], over: Partial<DeckDoc> = {}): DeckDoc {
  const pics: Record<string, PicInfo> = { ...PICS }
  if (s.logo) pics[s.logo.src] = { width: s.logo.width, height: s.logo.height }
  return {
    theme: s.theme, lang: s.lang, title: `${s.company} 회사 소개서`, company: s.company, website: s.website, brand: s.brand, logo: s.logo,
    slides, pics, notes: slides.map((x) => (x.kind === 'numbers' ? [NOTE] : [])), ...over,
  }
}
/** the bytes behind the sample pictures (headers that say their sizes; the logos real, as one colour needs pixels) */
const sampleBytes = (src: string): Uint8Array | null => {
  if (src.endsWith('logo-wide.png')) return realPng(480, 120, [20, 20, 20, 255], 10)
  if (src.endsWith('logo-square.png')) return realPng(300, 300, [31, 58, 147, 255])
  const p = PICS[src]
  if (!p) return null
  return src.endsWith('.jpg') ? jpegHead(p.width, p.height) : pngHead(p.width, p.height)
}

/** one line per item: what a change to the layout changes */
const num = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(2))
function digest(s: SlideOut): string[] {
  return [`${s.kind} ${s.variant} on ${s.ground}${s.dark ? ' (dark)' : ''} "${s.label}"`, ...s.items.map((it) => {
    if (it.t === 'text') return `text ${it.role} ${num(it.x)},${num(it.y)} w${num(it.w)} ${it.size}/${it.weight} lh${it.lh} ${it.align}${it.tabular ? ' tabular' : ''}: `
      + it.lines.map((l) => l.map((r) => `[${r.color}${r.size ? ` ${r.size}/${r.weight}` : ''}]${r.text}`).join('')).join(' ⏎ ')
    if (it.t === 'image') return `image ${it.src.split('/').pop()} ${num(it.x)},${num(it.y)} ${num(it.w)}×${num(it.h)} crop ${it.crop.x},${it.crop.y},${it.crop.w},${it.crop.h} r${it.radius}${it.logo ? ' logo' : ''}${it.recolor ? ` in ${it.recolor}` : ''}`
    if (it.t === 'rect') return `rect ${num(it.x)},${num(it.y)} ${num(it.w)}×${num(it.h)} r${it.radius}${it.ellipse ? ' ellipse' : ''} ${JSON.stringify(it.fill)}`
    if (it.t === 'line') return `line ${num(it.x1)},${num(it.y1)} → ${num(it.x2)},${num(it.y2)} ${it.color} ${it.width}${it.dash ? ` dash ${it.dash.join(',')}` : ''}${it.cap ? ` ${it.cap}` : ''}`
    if (it.t === 'svg') return `svg ${it.role} ${num(it.x)},${num(it.y)} ${num(it.w)}×${num(it.h)}`
    return `${it.t} ${JSON.stringify(it)}`
  }), ...s.notes.map((n) => `note ${n}`)]
}

const k = (kind: DeckSlide['kind']) => ({ kind }) as DeckSlide

// ── the pure parts ───────────────────────────────────────────────────────────────────────────────────────────────
describe('schema and order', () => {
  const slides = koDecks()[0]!
  const input = (over: Record<string, unknown> = {}) => ({ title: '아크메정밀 회사 소개서', company: '아크메정밀', sources: ['shared/브랜드/회사 소개.md'], slides, ...over })

  test('a strict schema: 6–10 slides of the eleven kinds, no field of HTML or layout, products of 2–4 items', () => {
    expect(IntroDeckInput.safeParse(input()).success).toBe(true)
    expect(IntroDeckInput.safeParse(input({ slides: slides.slice(0, 5) })).success).toBe(false)
    expect(IntroDeckInput.safeParse(input({ slides: slides.slice(0, 6) })).success).toBe(true)
    expect(IntroDeckInput.safeParse(input({ slides: [...slides, slides[2]] })).success).toBe(false)
    expect(IntroDeckInput.safeParse(input({ html: '<p>x</p>' })).success).toBe(false)
    expect(IntroDeckInput.safeParse(input({ theme: 'neon' })).success).toBe(false)
    expect(IntroDeckInput.safeParse(input({ brand_color: 'green' })).success).toBe(false)
    expect(IntroDeckInput.safeParse(input({ sources: [] })).success).toBe(false)
    expect(IntroDeckInput.safeParse(input({ slides: slides.map((s) => (s.kind === 'about' ? { ...s, x: 120 } : s)) })).success).toBe(false)
    expect(IntroDeckInput.safeParse(input({ slides: [...slides.slice(0, 9), { kind: 'chart', title: 'x' }] })).success).toBe(false)
    const products = slides.find((s) => s.kind === 'products')! as Extract<DeckSlide, { kind: 'products' }>
    const withItems = (n: number) => input({ slides: slides.map((s) => (s === products ? { ...products, items: Array.from({ length: n }, (_, i) => ({ name: `부품 ${i}`, body: '설명' })) } : s)) })
    expect(IntroDeckInput.safeParse(withItems(1)).success).toBe(false)
    expect(IntroDeckInput.safeParse(withItems(4)).success).toBe(true)
    expect(IntroDeckInput.safeParse(withItems(5)).success).toBe(false)
  })

  test('the kinds\' order: cover first, about second, contact last; the rest in their order; the four required kinds', () => {
    expect(orderProblems(slides)).toEqual([])
    expect(orderProblems([k('about'), k('cover'), k('offer'), k('contact')])).toEqual(expect.arrayContaining(['slides[0] must be the cover', 'slides[1] must be the about slide']))
    expect(orderProblems([k('cover'), k('about'), k('contact'), k('offer')])).toContain('the last slide must be the contact slide')
    expect(orderProblems([k('cover'), k('about'), k('numbers'), k('contact')])).toContain('the deck needs a offer slide')
    expect(orderProblems([k('cover'), k('offer'), k('contact')])).toEqual(expect.arrayContaining(['slides[1] must be the about slide', 'the deck needs a about slide']))
    expect(orderProblems([k('cover'), k('about'), k('numbers'), k('offer'), k('contact')])).toContain('slide order: offer must come before numbers (cover, about, needs, offer, numbers, products, process, proof, history, contact)')
    expect(orderProblems([k('cover'), k('about'), k('offer'), k('history'), k('proof'), k('contact')]).join('\n')).toContain('slide order: proof must come before history')
    // needs, numbers, process, proof, history at most once
    expect(orderProblems([k('cover'), k('about'), k('needs'), k('needs'), k('offer'), k('contact')])).toContain('needs: at most one slide')
  })

  test('products may stand twice, not three times; one scene, from the third slide to the one before contact', () => {
    const base = [k('cover'), k('about'), k('offer'), k('products'), k('products'), k('contact')]
    expect(orderProblems(base)).toEqual([])
    expect(orderProblems([...base.slice(0, 5), k('products'), k('contact')])).toEqual(['products: at most two slides'])
    for (const at of [2, 3, 4, 5]) {
      const deck = [...base]
      deck.splice(at, 0, k('scene'))
      expect(orderProblems(deck), `scene at ${at}`).toEqual([])
    }
    expect(orderProblems([k('cover'), k('scene'), k('about'), k('offer'), k('contact')])).toContain('the scene must stand between the third slide and the contact slide')
    expect(orderProblems([k('cover'), k('about'), k('offer'), k('contact'), k('scene')])).toEqual(expect.arrayContaining(['the last slide must be the contact slide', 'the scene must stand between the third slide and the contact slide']))
    expect(orderProblems([k('cover'), k('about'), k('scene'), k('offer'), k('scene'), k('contact')])).toContain('scene: at most one slide')
  })
})

describe('fitting the type', () => {
  test('every line keeps 10 % for a wider substitute font: a line that fits only without the slack steps down one notch', () => {
    expect(SLACK).toBe(1.1)
    const t = '정밀 가공 파트너'
    const w64 = width(t, 64, 700, -0.025), w56 = width(t, 56, 700, -0.025)
    expect(w56 / w64).toBeCloseTo(56 / 64, 6)
    // room for the line and its slack: the title's own size
    expect(fitText(t, ROLES.title, w64 * SLACK + 0.01, 1)?.size).toBe(64)
    // room for the line but not its slack: one notch down (64 → 56), never further
    expect(fitText(t, ROLES.title, w64 * 1.05, 1)?.size).toBe(56)
    expect(fitText(t, ROLES.title, w64 * 1.05, 1, { notch: false })).toBeNull()
    expect(fitText(t, ROLES.title, w56 * SLACK - 0.5, 1)).toBeNull()
    // the step-down never goes under the role's minimum (§3: body ≥ 16 pt, titles ≥ 32 pt in the PowerPoint file)
    for (const r of Object.values(ROLES)) expect(r.min).toBeLessThanOrEqual(r.size)
    expect(ROLES.body.min).toBeGreaterThanOrEqual(28)
    expect(ROLES.title.min).toBeGreaterThanOrEqual(56)
    // lines break only at spaces (keep-all): one word wider than the box does not fit at all
    expect(fitText('반도체장비부품정밀가공전문기업입니다', ROLES.body, 300, 4)).toBeNull()
  })

  test('the balancer: lines of even length, no one-character word left at a line\'s end, no short last word alone', () => {
    const lines = (s: string, w: number, balanced = true) => fitText(s, ROLES.body, w, 6, { notch: false, balanced })!.lines.map((l) => l.map((r) => r.text).join(''))
    // the plain fill leaves "수" at a line's end and "줘요" alone on the last line; the balancer does not
    expect(lines('고객이 데이터를 보고 바로 결정할 수 있게 돕습니다', 500, false)).toEqual(['고객이 데이터를 보고 바로 결정할 수', '있게 돕습니다'])
    expect(lines('고객이 데이터를 보고 바로 결정할 수 있게 돕습니다', 500)).toEqual(['고객이 데이터를 보고 바로', '결정할 수 있게 돕습니다'])
    expect(lines('작은 매장도 큰 브랜드처럼 일할 수 있게 해 줘요', 620, false)).toEqual(['작은 매장도 큰 브랜드처럼 일할 수 있게 해', '줘요'])
    expect(lines('작은 매장도 큰 브랜드처럼 일할 수 있게 해 줘요', 620)).toEqual(['작은 매장도 큰 브랜드처럼', '일할 수 있게 해 줘요'])
    // at every width: as many lines as the plain fill, each within the box with its slack, never a short word alone
    for (const s of ['고객이 데이터를 보고 바로 결정할 수 있게 돕습니다', '공장 설비의 전력 사용을 실시간으로 보여 주고 새는 전기를 찾아 줘요', '작은 매장도 큰 브랜드처럼 일할 수 있게 해 줘요']) {
      for (let w = 300; w <= 1000; w += 10) {
        const f = fitText(s, ROLES.body, w, 6, { notch: false })
        if (!f) continue
        const out = f.lines.map((l) => l.map((r) => r.text).join(''))
        expect(out.length, `${s} @${w}`).toBe(fitText(s, ROLES.body, w, 6, { notch: false, balanced: false })!.lines.length)
        for (const x of f.widths) expect(x).toBeLessThanOrEqual(w / SLACK + 1e-9)
        if (out.length > 1) expect(out.filter((l) => !l.includes(' ') && [...l].length < 3), `${s} @${w}`).toEqual([])
      }
    }
  })

  test('the accent phrase keeps its runs through the breaks; Latin labels in capitals, Hangul as written', () => {
    const f = fitText('설계부터 납품까지 *한 곳에서*', ROLES.title, 2000, 2)!
    expect(f.lines).toEqual([[{ text: '설계부터 납품까지 ', accent: false }, { text: '한 곳에서', accent: true }]])
    expect(labelCase('What we do')).toBe('WHAT WE DO')
    expect(labelCase('회사 소개')).toBe('회사 소개')
  })

  test('a text too long for its box is a problem that names the slide and the slot (every problem at once)', () => {
    const s = SAMPLES[0]!
    const slides = koDecks()[0]!.map((x) => ({ ...x })) as DeckSlide[]
    ;(slides[0] as Extract<DeckSlide, { kind: 'cover' }>).headline = '반도체 장비와 의료기기에 들어가는 정밀 가공 부품을 설계하고 만드는 회사입니다 그리고 더 많은 일을 합니다'
    const products = slides[4] as Extract<DeckSlide, { kind: 'products' }>
    slides[4] = { ...products, items: products.items.map((it, i) => (i === 1 ? { ...it, name: '아주아주긴이름의진공블록제품군입니다' } : it)) }
    const out = layoutDeck(sampleDoc(s, slides))
    expect(out.problems.join('\n')).toMatch(/^slides\[0\] \(cover\) headline: "반도체 장비와 .*" is too long; it must fit 2 lines of about \d+ Korean characters \(or \d+ Latin letters\)$/m)
    expect(out.problems.join('\n')).toMatch(/^slides\[4\] \(products\) items\[1\]\.name: "아주아주긴이름의진공블록제품군입니다" is too long/m)
    expect(out.problems).toHaveLength(2)
  })
})

describe('pictures in the layout', () => {
  test('crops for every focus: inside the picture, with the frame\'s aspect, kept around the focus', () => {
    const cases: [PicInfo, number, number][] = [[{ width: 3000, height: 1000 }, 960, 1080], [{ width: 1000, height: 3000 }, 1920, 1080], [{ width: 1600, height: 1200 }, 400, 300], [{ width: 801, height: 1203 }, 768, 1080]]
    for (const focus of ['center', 'top', 'bottom', 'left', 'right'] as Focus[]) {
      for (const [p, fw, fh] of cases) {
        const c = cropFor(p, fw, fh, focus)
        expect(c.x).toBeGreaterThanOrEqual(0)
        expect(c.y).toBeGreaterThanOrEqual(0)
        expect(c.x + c.w).toBeLessThanOrEqual(p.width)
        expect(c.y + c.h).toBeLessThanOrEqual(p.height)
        // one side whole, the other cut to the frame's aspect (within a pixel's rounding)
        expect(c.w === p.width || c.h === p.height).toBe(true)
        expect(Math.abs(c.w / c.h - fw / fh)).toBeLessThan(2 / Math.min(c.w, c.h) + 1e-9)
      }
    }
    // a wide picture in a tall frame: cut at the sides, where the focus says
    const wide = { width: 3000, height: 1000 }
    expect(['left', 'center', 'right', 'top', 'bottom'].map((f) => cropFor(wide, 960, 1080, f as Focus).x)).toEqual([422, 1056, 1689, 1056, 1056])
    // a tall picture in a wide frame: cut at the top and the bottom
    const tall = { width: 1000, height: 3000 }
    expect(['top', 'center', 'bottom', 'left', 'right'].map((f) => cropFor(tall, 1920, 1080, f as Focus).y)).toEqual([487, 1219, 1950, 1219, 1219])
    // the same aspect: the whole picture
    expect(cropFor({ width: 1600, height: 900 }, 1920, 1080, 'left')).toEqual({ x: 0, y: 0, w: 1600, h: 900 })
  })

  test('sizes per frame: full bleed landscape ≥ 1,600 px, half ≥ 800 on the short side, a card ≥ 400', () => {
    expect(PIC_RULES.bleed({ width: 1600, height: 1000 })).toBe(true)
    expect(PIC_RULES.bleed({ width: 1599, height: 1000 })).toBe(false)
    expect(PIC_RULES.bleed({ width: 1600, height: 1600 })).toBe(false)
    expect(PIC_RULES.bleed({ width: 2500, height: 1000 })).toBe(false)
    expect(PIC_RULES.half({ width: 1600, height: 800 })).toBe(true)
    expect(PIC_RULES.half({ width: 1600, height: 799 })).toBe(false)
    expect(PIC_RULES.card({ width: 400, height: 900 })).toBe(true)
    expect(PIC_RULES.card({ width: 399, height: 900 })).toBe(false)
  })

  test('a picture that cannot be used makes the type-only variant, recorded for the answer (never an empty frame)', () => {
    const s = SAMPLES[0]!
    const slides = koDecks()[0]!
    const ok = layoutDeck(sampleDoc(s, slides))
    expect(ok.problems).toEqual([])
    expect(ok.typeOnly).toEqual([])
    expect(ok.slides.map((x) => `${x.kind} ${x.variant}`).slice(0, 6)).toEqual(['cover A', 'about A', 'offer A', 'numbers A', 'products A', 'products B'])
    // the pictures gone (no longer readable at build time): cover C, offer B, products B; the logo slots keep the logo
    const pics = { [s.logo!.src]: { width: 480, height: 120 } }
    const gone = layoutDeck(sampleDoc(s, slides, { pics }))
    expect(gone.problems).toEqual([])
    expect(gone.typeOnly).toEqual([0, 2, 4])
    expect(gone.slides.map((x) => `${x.kind} ${x.variant}`).slice(0, 6)).toEqual(['cover C', 'about A', 'offer B', 'numbers A', 'products B', 'products B'])
    for (const sl of gone.slides) for (const it of sl.items) if (it.t === 'image') expect(it.logo, `${sl.kind}: ${it.src}`).toBe(true)
    // the logo stands only in the logo slots: cover, about (footer), contact and the footers; never as a picture
    for (const sl of ok.slides) for (const it of sl.items) if (it.t === 'image' && it.src === s.logo!.src) expect(it.logo).toBe(true)
    // a cover picture good for half a slide only: the split cover; a cut-out (a product on transparency) is never full bleed
    const half = layoutDeck(sampleDoc(s, [{ ...slides[0]!, picture: IMG + 'square.jpg' } as DeckSlide, ...slides.slice(1)]))
    expect(half.slides[0]!.variant).toBe('B')
    const cut = layoutDeck(sampleDoc(s, slides, { pics: { ...sampleDoc(s, slides).pics, [IMG + 'wide.png']: { width: 1920, height: 1080, cutout: true } } }))
    expect(cut.slides[0]!.variant).toBe('B')
    const cutImg = cut.slides[0]!.items.find((it) => it.t === 'image' && !it.logo)!
    expect(cutImg.t === 'image' && cutImg.crop).toEqual({ x: 0, y: 0, w: 1920, h: 1080 })
  })
})

describe('themes and colour', () => {
  test('the colour class of a brand colour, and the themes that fit it (best first)', () => {
    expect(colourClass('#ff5a1f')).toBe('vivid')
    expect(colourClass('#1f3a93')).toBe('deep')
    expect(colourClass('#cad3fb')).toBe('light')
    expect(colourClass('#a8c5a0')).toBe('muted')
    expect(colourClass('#808080')).toBe('none')
    expect(colourClass(null)).toBe('none')
    expect(colourClass(undefined)).toBe('none')
    expect(fittingThemes('#ff5a1f')).toEqual(['ink', 'paper', 'brand'])
    expect(fittingThemes('#1f3a93')).toEqual(['brand', 'paper', 'ink'])
    expect(fittingThemes('#cad3fb')).toEqual(['paper', 'ink'])
    expect(fittingThemes('#a8c5a0')).toEqual(['paper', 'brand', 'ink'])
    expect(fittingThemes('#808080')).toEqual(['paper', 'ink'])
    expect(fittingThemes(null)).toEqual(['paper', 'ink'])
  })

  test('a theme that does not fit is replaced by the first that does, never refused', () => {
    expect(themeFor(undefined, '#ff5a1f')).toEqual({ theme: 'ink', replaced: false })
    expect(themeFor(undefined, '#1f3a93')).toEqual({ theme: 'brand', replaced: false })
    expect(themeFor(undefined, null)).toEqual({ theme: 'paper', replaced: false })
    expect(themeFor('paper', '#ff5a1f')).toEqual({ theme: 'paper', replaced: false })
    expect(themeFor('brand', null)).toEqual({ theme: 'paper', replaced: true })
    expect(themeFor('brand', '#cad3fb')).toEqual({ theme: 'paper', replaced: true })
    expect(themeFor('brand', '#808080')).toEqual({ theme: 'paper', replaced: true })
    expect(themeFor('ink', '#808080')).toEqual({ theme: 'ink', replaced: false })
    // without a usable colour the brand look cannot exist: it falls back to paper whoever asks
    expect(lookFor('brand', null).theme).toBe('paper')
  })

  test('text and the accent reach 4.5:1 on every ground of every theme, whatever the brand colour; grounds are solid', () => {
    const brands = ['#ff5a1f', '#7c3aed', '#16a34a', '#1f3a93', '#1e4620', '#e60012', '#0a1f6b', '#cad3fb', '#ffd400', '#808080', '#a8c5a0', '#3ddc97', '#000000', '#ffffff', null]
    for (const brand of brands) for (const theme of DECK_THEMES) {
      const look = lookFor(theme, brand)
      for (const g of [look.light, look.feature]) {
        const at = `${theme} ${brand} on ${g.bg}`
        expect(g.bg, at).toMatch(/^#[0-9a-f]{6}$/i)
        expect(contrast(g.text, g.bg), at).toBeGreaterThanOrEqual(4.5)
        expect(contrast(g.accent, g.bg), at).toBeGreaterThanOrEqual(4.5)
        for (const c of [g.text, g.dim, g.mute, g.line, g.accent, g.mark, g.panel]) expect(c, at).toMatch(/^#[0-9a-f]{6}$/i)
      }
      // only type over a photograph uses white with alpha
      expect(look.photo.text).toBe('#ffffff')
    }
  })

  test('colours with alpha only over photographs (cover A, scene); never three dark slides in a row (paper, brand)', () => {
    for (const s of SAMPLES) for (const slides of s.decks) {
      const out = layoutDeck(sampleDoc(s, slides))
      for (const sl of out.slides) {
        const overPhoto = (sl.kind === 'cover' && sl.variant === 'A') || sl.kind === 'scene'
        for (const it of sl.items) if (it.t === 'text') for (const l of it.lines) for (const r of l) if (!overPhoto) expect(r.color, `${s.theme} ${sl.kind}`).toMatch(/^#[0-9a-f]{6}$/i)
      }
      if (s.theme !== 'ink') for (let i = 2; i < out.slides.length; i++) expect([0, 1, 2].every((d) => out.slides[i - d]!.dark), `${s.theme} slides ${i - 1}–${i + 1}`).toBe(false)
    }
  })
})

describe('the display list', () => {
  test('a snapshot per kind × variant × theme (made-up companies)', () => {
    const seen = new Map<DeckTheme, Set<string>>()
    for (const s of SAMPLES) {
      const got = new Set<string>()
      seen.set(s.theme, got)
      for (const slides of s.decks) {
        const out = layoutDeck(sampleDoc(s, slides))
        expect(out.problems, `${s.theme}`).toEqual([])
        expect(out.typeOnly).toEqual([])
        expect(out.look.theme).toBe(s.theme)
        expect(out.slides).toHaveLength(slides.length)
        for (const sl of out.slides) {
          const key = `${s.theme} ${sl.kind} ${sl.variant}`
          if (got.has(`${sl.kind} ${sl.variant}`)) continue
          got.add(`${sl.kind} ${sl.variant}`)
          expect(digest(sl)).toMatchSnapshot(key)
        }
      }
    }
    const every = ['about A', 'contact A', 'cover A', 'cover B', 'cover C', 'history A', 'history B', 'needs A', 'numbers A', 'numbers B', 'offer A', 'offer B', 'process A', 'products A', 'products B', 'proof A', 'proof B', 'proof C', 'scene A']
    expect([...seen.get('paper')!].sort()).toEqual(every)
    expect([...seen.get('brand')!].sort()).toEqual(every)
    // ink: the numbers stay on the dark ground (every ink slide is dark)
    expect([...seen.get('ink')!].sort()).toEqual(every.filter((x) => x !== 'numbers B'))
  })

  test('the numbers between two dark slides go on the light ground (variant B); the eyebrow and the title stand in one place', () => {
    const s = SAMPLES[0]!
    const out = layoutDeck(sampleDoc(s, koDecks()[1]!))
    const numbers = out.slides[5]!
    expect([out.slides[4]!.kind, numbers.kind, out.slides[6]!.kind]).toEqual(['scene', 'numbers', 'contact'])
    expect(numbers.variant).toBe('B')
    expect(numbers.ground).toBe(out.look.light.bg)
    for (const slides of s.decks) for (const sl of layoutDeck(sampleDoc(s, slides)).slides) {
      for (const it of sl.items) if (it.t === 'text' && it.role === 'title') expect([sl.kind, it.x, it.y]).toEqual([sl.kind, 120, 160])
      for (const it of sl.items) if (it.t === 'text' && it.role === 'eyebrow' && !['cover', 'scene', 'contact'].includes(sl.kind)) expect([sl.kind, it.x, it.y]).toEqual([sl.kind, 120, 104])
    }
  })
})

// ── the preview ──────────────────────────────────────────────────────────────────────────────────────────────────
/** A fake DOM just big enough for the preview's pager script: the elements it finds, their classes and attributes,
 * the listeners it adds; events are fired by hand. */
function pagerPage(html: string, o: { width?: number; height?: number; barBottom?: number; reduced?: boolean } = {}) {
  type L = (e: Record<string, unknown>) => void
  type El = ReturnType<typeof el>
  const el = (cls: string[], over: Record<string, unknown> = {}) => {
    const classes = new Set(cls)
    const ls: Record<string, L[]> = {}
    const attrs: Record<string, string> = {}
    const kids: unknown[] = []
    return {
      classes, attrs, kids, textContent: '', disabled: false, offsetWidth: 1,
      appendChild: (k: unknown) => { kids.push(k) },
      classList: {
        contains: (n: string) => classes.has(n),
        add: (...n: string[]) => { for (const x of n) classes.add(x) },
        remove: (...n: string[]) => { for (const x of n) classes.delete(x) },
        toggle: (n: string, force?: boolean) => { const on = force ?? !classes.has(n); if (on) classes.add(n); else classes.delete(n); return on },
      },
      setAttribute: (k: string, v: unknown) => { attrs[k] = String(v) },
      addEventListener: (t: string, f: L) => { (ls[t] ??= []).push(f) },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 900, height: 506 }),
      fire: (t: string, e: Record<string, unknown> = {}) => { for (const f of ls[t] ?? []) f(e) },
      ...over,
    }
  }
  const n = (html.match(/<section class="s/g) ?? []).length
  const root = el([]), st = el(['st']), counter = el(['n']), pv = el(['pv']), nx = el(['nx'])
  const bar = el(['bar'], { getBoundingClientRect: () => ({ left: 0, top: (o.barBottom ?? 560) - 52, width: 900, bottom: o.barBottom ?? 560 }) })
  /** a slide's content as the strip copies it: an SVG layer whose pattern has a clip, a mask and a fill by id */
  const content = (i: number) => ({
    cloneNode: () => {
      const a: Record<string, string> = {}
      const svgEl = (id: string, at: Record<string, string>) => ({ id, attrs: { ...at }, getAttribute(k: string) { return this.attrs[k] ?? null }, setAttribute(k: string, v: string) { this.attrs[k] = v } })
      const inner = [svgEl(`s${i + 1}v0p0c`, {}), svgEl('', { 'clip-path': `url(#s${i + 1}v0p0c)`, mask: `url(#s${i + 1}v0p0m)` }), svgEl('', { fill: `url(#s${i + 1}v0p0p)` }), svgEl('', { fill: '#112233' })]
      return { slide: i, attrs: a, inner, setAttribute: (k: string, v: string) => { a[k] = v }, querySelectorAll: () => inner }
    },
  })
  const slides = Array.from({ length: n }, (_, i) => el(i === 0 ? ['s', 'on'] : ['s'], { querySelector: (q: string) => (q === '.c' ? content(i) : null) }))
  const thumbs: El[] = Array.from({ length: (html.match(/<button type="button" class="th"/g) ?? []).length }, () => el(['th']))
  // what the markup says before the script runs
  counter.textContent = /<span class="n"[^>]*>([^<]*)</.exec(html)![1]!
  pv.disabled = /<button[^>]*class="pv"[^>]*\sdisabled[\s>]/.test(html)
  nx.disabled = /<button[^>]*class="nx"[^>]*\sdisabled[\s>]/.test(html)
  const docLs: Record<string, L[]> = {}, winLs: Record<string, L[]> = {}
  const document = {
    documentElement: root,
    querySelector: (q: string) => ({ '.st': st, '.n': counter, '.pv': pv, '.nx': nx, '.bar': bar } as Record<string, unknown>)[q] ?? null,
    querySelectorAll: (q: string) => (q === '.s' ? slides : q === '.th' ? thumbs : []),
    addEventListener: (t: string, f: L) => { (docLs[t] ??= []).push(f) },
    fonts: { ready: Promise.resolve() },
  }
  const window = { innerWidth: o.width ?? 1200, innerHeight: o.height ?? 640, matchMedia: (q: string) => ({ matches: !!o.reduced && /prefers-reduced-motion: reduce/.test(q) }), addEventListener: (t: string, f: L) => { (winLs[t] ??= []).push(f) } }
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1]!
  new Function('window', 'document', 'setTimeout', script)(window, document, () => 0)
  const key = (k: string, mods: Record<string, boolean> = {}) => { const e = { key: k, altKey: false, ctrlKey: false, metaKey: false, ...mods, prevented: false, preventDefault() { e.prevented = true } }; for (const f of docLs.keydown ?? []) f(e); return e.prevented }
  const pointer = (x0: number, x1: number, dy = 0) => { st.fire('pointerdown', { clientX: x0, clientY: 200 }); st.fire('pointerup', { clientX: x1, clientY: 200 + dy }) }
  const resize = (w: number, h = window.innerHeight) => { window.innerWidth = w; window.innerHeight = h; for (const f of winLs.resize ?? []) f({}) }
  return { root, st, counter, pv, nx, slides, thumbs, key, pointer, resize, at: () => slides.findIndex((s) => s.classes.has('on')) }
}

describe('the preview (HTML)', () => {
  const ink = SAMPLES[1]!
  const hostile = '<script>alert(1)</script>'
  const slides = enDecks()[0]!.map((s) => (s.kind === 'offer' ? { ...s, title: 'We <b>"back up"</b> & \'restore\'' } : s)) as DeckSlide[]
  const out = layoutDeck(sampleDoc(ink, slides, { company: hostile, title: `${hostile} deck` }))
  const html = deckHtml(out, { fontCss: '/vendor/fonts/pretendard.css', lang: 'en', title: `${hostile} deck` })

  test('every text is escaped: a company named <script> is text; one script on the page, the pager\'s', () => {
    expect(html).not.toContain('<script>alert(1)')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html.match(/<script>/g)).toHaveLength(1)
    expect(html).toContain('<title>&lt;script&gt;alert(1)&lt;/script&gt; deck</title>')
    expect(html).toContain('We &lt;b&gt;&quot;back up&quot;&lt;/b&gt; &amp; &#39;restore&#39;')
    expect(html).not.toContain('<b>')
    expect(esc('a<b>&"\'')).toBe('a&lt;b&gt;&amp;&quot;&#39;')
    // pictures by team path, the font from this server; no address of the web
    expect(html).toContain(`src="/${IMG.split('/').map(encodeURIComponent).join('/')}wide.png"`)
    expect(html).toContain('<link rel="stylesheet" href="/vendor/fonts/pretendard.css">')
    expect(html).not.toMatch(/https?:\/\//)
  })

  test('no line can wrap: every line is its own white-space: pre element, as many as the display list has lines', () => {
    expect(html).toMatch(/\.c \.t\{[^}]*white-space:pre[;}]/)
    const lines = out.slides.reduce((n, s) => n + s.items.reduce((m, it) => m + (it.t === 'text' ? it.lines.length : 0), 0), 0)
    expect(html.match(/<p class="t"/g)).toHaveLength(lines)
    expect(html).not.toMatch(/<br/)
    for (const p of html.match(/<p class="t"[^>]*>.*?<\/p>/g)!) expect(p).not.toMatch(/\n/)
  })

  test('the pager (its script run against a small fake DOM): keys, swipes of 40 px, the thirds, the counter, buttons', () => {
    const N = out.slides.length
    expect(html).toContain(`<span class="n" aria-live="polite">1 / ${N}</span>`)
    const p = pagerPage(html)
    // as the page opens: the first slide, "previous" off
    expect([p.at(), p.counter.textContent, p.pv.disabled, p.nx.disabled]).toEqual([0, `1 / ${N}`, true, false])
    expect(p.key('ArrowRight')).toBe(true)
    expect([p.at(), p.counter.textContent, p.pv.disabled]).toEqual([1, `2 / ${N}`, false])
    expect(p.slides.map((s) => s.attrs['aria-hidden'])).toEqual(p.slides.map((_, i) => (i === 1 ? 'false' : 'true')))
    p.key('PageDown')
    expect(p.at()).toBe(2)
    p.key('ArrowLeft')
    p.key('PageUp')
    expect([p.at(), p.pv.disabled]).toEqual([0, true])
    p.key('PageUp')
    expect(p.at()).toBe(0)
    p.key('End')
    expect([p.at(), p.counter.textContent, p.nx.disabled]).toEqual([N - 1, `${N} / ${N}`, true])
    p.key('ArrowRight')
    expect(p.at()).toBe(N - 1)
    p.key('Home')
    expect(p.at()).toBe(0)
    // a key with a modifier is the browser's
    expect(p.key('ArrowRight', { metaKey: true })).toBe(false)
    expect(p.at()).toBe(0)
    // swipes: 40 px or more to the side; less, or more up than across, is nothing (and not a tap)
    p.pointer(600, 560)
    expect(p.at()).toBe(1)
    p.pointer(600, 561)
    expect(p.at()).toBe(1)
    p.pointer(600, 650, 80)
    expect(p.at()).toBe(1)
    p.pointer(560, 600)
    expect(p.at()).toBe(0)
    // a tap on the right third goes on, the left third back, the middle nothing (the stage is 900 px wide here)
    p.pointer(800, 803)
    expect(p.at()).toBe(1)
    p.pointer(450, 450)
    expect(p.at()).toBe(1)
    p.pointer(100, 100)
    expect(p.at()).toBe(0)
    // the buttons
    p.nx.fire('click')
    p.nx.fire('click')
    expect([p.at(), p.counter.textContent]).toEqual([2, `3 / ${N}`])
    p.pv.fire('click')
    expect(p.at()).toBe(1)
    expect(p.slides.map((s) => s.attrs['aria-hidden']).filter((x) => x === 'false')).toHaveLength(1)
  })

  test('a phone (under 560 px) pages the slides at the full width with the same keys, swipes and thirds; reduced motion moves nothing', () => {
    // no stacked column any more: the stage loses its side room and corners, the bar stays
    expect(html).not.toContain('narrow')
    expect(html).toContain('@media (max-width:559px){.dk{padding:0 0 8px}.st{border-radius:0;box-shadow:none}')
    expect(html).toContain('@media (prefers-reduced-motion:reduce){.s,.st{transition:none!important}}')
    const phone = pagerPage(html, { width: 390, height: 700, barBottom: 280 })
    expect(phone.root.classes.has('narrow')).toBe(false)
    phone.key('ArrowRight')
    expect(phone.at()).toBe(1)
    phone.pointer(600, 500)
    expect([phone.at(), phone.counter.textContent]).toEqual([2, `3 / ${out.slides.length}`])
    phone.pointer(100, 100)
    expect(phone.at()).toBe(1)
    phone.nx.fire('click')
    expect(phone.at()).toBe(2)
    // with motion the slide left behind slides away; with reduced motion no slide moves
    const moving = pagerPage(html)
    moving.key('ArrowRight')
    expect(moving.slides[0]!.classes.has('l')).toBe(true)
    const still = pagerPage(html, { reduced: true })
    still.key('ArrowRight')
    still.key('ArrowLeft')
    expect(still.at()).toBe(0)
    expect(still.slides.some((s) => s.classes.has('l') || s.classes.has('rt'))).toBe(false)
  })

  test('the strip of small slides: only with 120 px of room under the bar; each a copy of its slide (ids renamed, hidden from screen readers); a click shows it, the current one marked', () => {
    const N = out.slides.length
    expect(html.match(/<button type="button" class="th"/g)).toHaveLength(N)
    expect(html).toContain('<button type="button" class="th" aria-label="' + esc(`${out.slides[0]!.label} (1 / ${N})`) + '" aria-current="true"></button>')
    expect(html).toContain('.thumbs .tb{display:grid}')
    expect(html).toMatch(/\.tb\{display:none;grid-template-columns:repeat\(5,/)
    expect(html).toContain('.th[aria-current="true"]{box-shadow:0 0 0 2px #fff,0 0 0 3.5px #1c1917}')
    // 119 px under the bar: no strip, nothing copied
    const short = pagerPage(html, { height: 679, barBottom: 560 })
    expect(short.root.classes.has('thumbs')).toBe(false)
    expect(short.thumbs.every((t) => t.kids.length === 0)).toBe(true)
    // the panel grows: the strip comes, every slide copied once
    short.resize(1200, 680)
    expect(short.root.classes.has('thumbs')).toBe(true)
    expect(short.thumbs.map((t) => t.kids.length)).toEqual(short.thumbs.map(() => 1))
    short.resize(1200, 900)
    expect(short.thumbs.map((t) => t.kids.length)).toEqual(short.thumbs.map(() => 1))
    const copy = short.thumbs[2]!.kids[0] as { slide: number; attrs: Record<string, string>; inner: { id: string; attrs: Record<string, string> }[] }
    expect(copy.slide).toBe(2)
    expect(copy.attrs['aria-hidden']).toBe('true')
    expect(copy.inner.map((e) => e.id)).toEqual(['s3v0p0ct', '', '', ''])
    expect(copy.inner.map((e) => e.attrs)).toEqual([{}, { 'clip-path': 'url(#s3v0p0ct)', mask: 'url(#s3v0p0mt)' }, { fill: 'url(#s3v0p0pt)' }, { fill: '#112233' }])
    // a click on a small slide shows it; the current one is marked, also after the keys
    short.thumbs[3]!.fire('click')
    expect([short.at(), short.counter.textContent]).toEqual([3, `4 / ${N}`])
    expect(short.thumbs.map((t) => t.attrs['aria-current'])).toEqual(short.thumbs.map((_, i) => String(i === 3)))
    short.key('ArrowRight')
    expect(short.thumbs.map((t) => t.attrs['aria-current'])).toEqual(short.thumbs.map((_, i) => String(i === 4)))
    // a short panel again: the strip goes
    short.resize(1200, 600)
    expect(short.root.classes.has('thumbs')).toBe(false)
  })
})

// ── the PowerPoint file ──────────────────────────────────────────────────────────────────────────────────────────
interface XNode { name: string; attrs: Record<string, string>; kids: XNode[]; text: string }
// saxes is the server's dependency (server/package.json): loaded from there
interface Sax {
  on(e: 'error', f: (e: Error) => void): void
  on(e: 'opentag', f: (t: { name: string; attributes: Record<string, string | { value: string }> }) => void): void
  on(e: 'closetag' | 'text', f: (t: string) => void): void
  write(s: string): { close(): void }
}
const { SaxesParser } = createRequire(path.join(import.meta.dir, '../../server/package.json'))('saxes') as { SaxesParser: new (o: { xmlns: boolean }) => Sax }
function parseXml(xml: string, where: string): XNode {
  const p = new SaxesParser({ xmlns: true })
  const root: XNode = { name: '#doc', attrs: {}, kids: [], text: '' }
  const stack = [root]
  p.on('error', (e) => { throw new Error(`${where}: ${e.message}`) })
  p.on('opentag', (t) => {
    const n: XNode = { name: t.name, attrs: Object.fromEntries(Object.entries(t.attributes).map(([key, a]) => [key, typeof a === 'string' ? a : a.value])), kids: [], text: '' }
    stack.at(-1)!.kids.push(n)
    stack.push(n)
  })
  p.on('closetag', () => { stack.pop() })
  p.on('text', (t) => { stack.at(-1)!.text += t })
  p.write(xml).close()
  return root
}
const all = (n: XNode, name: string): XNode[] => [...(n.name === name ? [n] : []), ...n.kids.flatMap((c) => all(c, name))]

/** Everything a PowerPoint file needs to open, and what the layout said, read back from its parts. */
function checkPptx(bytes: Uint8Array, out: DeckOut, o: { lang: Locale; title: string; fonts: boolean }) {
  const zip = readZip(bytes)
  const names = new Set(zip.map((e) => e.name))
  expect(names.size).toBe(zip.length)
  const raw = (n: string) => Buffer.from(zip.find((e) => e.name === n)!.data)
  const xml = new Map<string, XNode>()
  // every XML part parses
  for (const e of zip) if (/\.(xml|rels)$/.test(e.name)) xml.set(e.name, parseXml(raw(e.name).toString('utf8'), e.name))
  // content types: an override for every XML part, a default for every other extension, nothing listed that is not there
  const ct = xml.get('[Content_Types].xml')!
  const overrides = new Set(all(ct, 'Override').map((n) => n.attrs.PartName!))
  const defaults = new Set(all(ct, 'Default').map((n) => n.attrs.Extension!))
  for (const n of names) {
    if (n === '[Content_Types].xml') continue
    if (n.endsWith('.xml')) expect(overrides.has('/' + n), `content type of ${n}`).toBe(true)
    else expect(defaults.has(n.split('.').pop()!), `content type of ${n}`).toBe(true)
  }
  for (const p of overrides) expect(names.has(p.slice(1)), `override ${p}`).toBe(true)
  // relationships: every target is in the file, every id a part uses is in its relationships
  const relsOf = new Map<string, Map<string, string>>()
  for (const [n, t] of xml) if (n.endsWith('.rels')) {
    const dir = path.posix.dirname(path.posix.dirname(n))
    const part = path.posix.join(dir, path.posix.basename(n).replace(/\.rels$/, ''))
    const ids = new Map<string, string>()
    for (const r of all(t, 'Relationship')) {
      if (r.attrs.TargetMode === 'External') continue
      const target = path.posix.normalize(path.posix.join(dir === '.' ? '' : dir, r.attrs.Target!))
      expect(names.has(target), `${n} → ${r.attrs.Target}`).toBe(true)
      expect(ids.has(r.attrs.Id!), `${n}: ${r.attrs.Id} twice`).toBe(false)
      ids.set(r.attrs.Id!, target)
    }
    relsOf.set(part, ids)
  }
  for (const [n, t] of xml) {
    if (n.endsWith('.rels') || n === '[Content_Types].xml') continue
    const used = [...all(t, 'a:blip').map((b) => b.attrs['r:embed']!), ...all(t, 'p:sldId').map((b) => b.attrs['r:id']!), ...all(t, 'p:regular').map((b) => b.attrs['r:id']!), ...all(t, 'p:bold').map((b) => b.attrs['r:id']!)]
    for (const id of used) expect(relsOf.get(n)?.has(id), `${n} uses ${id}`).toBe(true)
  }
  // the slides, their notes, in order
  const N = out.slides.length
  expect([...names].filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))).toHaveLength(N)
  expect([...names].filter((n) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n))).toHaveLength(N)
  const pres = xml.get('ppt/presentation.xml')!
  expect(all(pres, 'p:sldId').map((s) => relsOf.get('ppt/presentation.xml')!.get(s.attrs['r:id']!))).toEqual(out.slides.map((_, i) => `ppt/slides/slide${i + 1}.xml`))
  const LANG = { ko: 'ko-KR', en: 'en-US', id: 'id-ID', ja: 'ja-JP', es: 'es-ES' }[o.lang]
  const charset = { ko: '-127', ja: '-128', en: '0', id: '0', es: '0' }[o.lang]
  for (const [n, buf] of zip.map((e) => [e.name, raw(e.name)] as const)) if (/\.xml$/.test(n)) expect(buf.toString('utf8'), n).not.toContain('charset="-122"')
  out.slides.forEach((s, i) => {
    const sx = xml.get(`ppt/slides/slide${i + 1}.xml`)!
    // every run in the team's language with the right East Asian charset (Hangul −127, never the Chinese −122)
    const rprs = [...all(sx, 'a:rPr'), ...all(sx, 'a:endParaRPr')]
    expect(rprs.length).toBeGreaterThan(0)
    for (const r of rprs) {
      expect(r.attrs.lang, `slide ${i + 1}`).toBe(LANG)
      const ea = r.kids.find((x) => x.name === 'a:ea')
      expect(ea?.attrs.charset, `slide ${i + 1} ea`).toBe(charset)
      expect(ea?.attrs.typeface).toMatch(/^Pretendard( ExtraBold)?$/)
    }
    // every paragraph: no Hangul word split when someone edits it (eaLnBrk="0"), exact line spacing, our breaks
    const paras = all(sx, 'a:p')
    const texts = s.items.filter((it) => it.t === 'text')
    expect(paras).toHaveLength(texts.length)
    paras.forEach((p, j) => {
      const ppr = p.kids[0]!
      expect(ppr.name).toBe('a:pPr')
      expect(ppr.attrs.eaLnBrk).toBe('0')
      expect(all(ppr, 'a:spcPts')[0]!.attrs.val).toBe(String(Math.round((texts[j] as { lh: number }).lh * 50)))
      expect(all(p, 'a:br')).toHaveLength((texts[j] as { lines: unknown[] }).lines.length - 1)
    })
    // each picture's srcRect is the layout's crop (gradients are pictures of their own, "Shade", uncropped)
    const imgs = s.items.filter((it) => it.t === 'image')
    const pics = all(sx, 'p:pic').filter((p) => all(p, 'p:cNvPr')[0]!.attrs.name!.startsWith('Picture '))
    const shades = all(sx, 'p:pic').filter((p) => all(p, 'p:cNvPr')[0]!.attrs.name!.startsWith('Shade '))
    expect(shades).toHaveLength(s.items.filter((it) => it.t === 'rect' && !('solid' in it.fill)).length)
    for (const p of shades) expect(all(p, 'a:srcRect')).toEqual([])
    expect(pics).toHaveLength(imgs.length)
    pics.forEach((p, j) => {
      const it = imgs[j]!
      if (it.t !== 'image') return
      const pct = (v: number, of: number) => String(Math.round((v / of) * 100000))
      const n = it.natural, c = it.crop
      expect(all(p, 'a:srcRect')[0]!.attrs).toEqual({ l: pct(c.x, n.width), t: pct(c.y, n.height), r: pct(n.width - c.x - c.w, n.width), b: pct(n.height - c.y - c.h, n.height) })
    })
    // the notes carry the sources of the slide's numbers and names
    const notes = all(xml.get(`ppt/notesSlides/notesSlide${i + 1}.xml`)!, 'a:t').map((t) => t.text).filter(Boolean)
    expect(notes).toEqual(s.notes)
  })
  // the title, no author
  const core = xml.get('docProps/core.xml')!
  expect(all(core, 'dc:title')[0]!.text).toBe(o.title)
  expect(all(core, 'dc:creator')).toEqual([])
  // the fonts: Regular and Bold as "Pretendard", ExtraBold as its own family, each an EOT of the whole TTF
  const fonts = [...names].filter((n) => n.startsWith('ppt/fonts/')).sort()
  if (!o.fonts) { expect(fonts).toEqual([]); return }
  expect(fonts).toEqual(['ppt/fonts/font1.fntdata', 'ppt/fonts/font2.fntdata', 'ppt/fonts/font3.fntdata'])
  for (const f of fonts) {
    const b = raw(f)
    expect(b.readUInt32LE(0), f).toBe(b.length)
    expect(b.readUInt32LE(8), f).toBe(0x00020001)
    expect(b.readUInt16LE(34), f).toBe(0x504c)
    expect(b.readUInt32LE(4) + 100, f).toBeLessThan(b.length)
  }
  expect(all(pres, 'p:presentation')[0]!.attrs.embedTrueTypeFonts).toBe('1')
  const embedded = all(pres, 'p:embeddedFont').map((e) => ({ face: all(e, 'p:font')[0]!.attrs.typeface, faces: e.kids.filter((x) => x.name !== 'p:font').map((x) => x.name) }))
  expect(embedded).toEqual([{ face: 'Pretendard', faces: ['p:regular', 'p:bold'] }, { face: 'Pretendard ExtraBold', faces: ['p:regular'] }])
  return zip
}

/** The slots of each slide as plain text (no stars, no spaces), as the reader of PowerPoint files must find them. */
const tight = (s: string) => s.normalize('NFKC').replace(/[\s *]+/g, '').toLowerCase()
function slotsShown(s: DeckSlide): string[] {
  return slideTexts(s).map(([where, t]) => (/eyebrow|label/.test(where) ? labelCase(t) : t))
}
/** The text of each slide of a PowerPoint file, read back by our own extractor (pandoc's text with the slide marks,
 * then the speaker notes); pandoc's own "Slide N" heading of a slide without a title and its "[]" for a picture aside. */
async function readBack(bytes: Uint8Array, n: number): Promise<{ slides: string[]; notes: string }> {
  const text = await extractText('deck.pptx', bytes, { pandoc: which('pandoc'), pdftotext: null })
  const [body, notes = ''] = text.split(/\n=== PowerPoint speaker notes[^\n]*===\n/)
  const parts = body!.split(/^=== Slide (\d+) ===$/m)
  const slides: string[] = Array.from({ length: n }, () => '')
  for (let i = 1; i < parts.length; i += 2) slides[Number(parts[i]) - 1] += (parts[i + 1] ?? '').replace(new RegExp(`^\\s*Slide ${parts[i]}\\s*$`, 'm'), '').replace(/\[\]/g, '')
  return { slides, notes }
}

describe('the PowerPoint file (our own writer)', () => {
  test('every sample deck: every part parses, content types and relationships complete, runs, paragraphs, crops, notes', () => {
    for (const s of SAMPLES) for (const slides of s.decks) {
      const out = layoutDeck(sampleDoc(s, slides))
      const bytes = buildPptx(out, { title: `${s.company} 회사 소개서`, lang: s.lang, read: sampleBytes, fonts: null, created: '2026-11-06T09:00:00.000Z' })
      checkPptx(bytes, out, { lang: s.lang, title: `${s.company} 회사 소개서`, fonts: false })
      // the same deck gives the same bytes (its hash recognizes it when it is put back as a source)
      expect(sha(buildPptx(out, { title: `${s.company} 회사 소개서`, lang: s.lang, read: sampleBytes, fonts: null, created: '2026-11-06T09:00:00.000Z' }))).toBe(sha(bytes))
    }
  })

  test.if(!!pretendardDir())('Pretendard embedded: three EOT files, "Pretendard" Regular and Bold and "Pretendard ExtraBold" in the font list', () => {
    const s = SAMPLES[0]!
    const out = layoutDeck(sampleDoc(s, koDecks()[0]!))
    const bytes = buildPptx(out, { title: '아크메정밀 회사 소개서', lang: 'ko', read: sampleBytes, fonts: pretendardDir(), created: '2026-11-06T09:00:00.000Z' })
    checkPptx(bytes, out, { lang: 'ko', title: '아크메정밀 회사 소개서', fonts: true })
    // the whole TrueType font follows its header
    const font = readZip(bytes).find((e) => e.name === 'ppt/fonts/font1.fntdata')!.data
    const ttf = fs.readFileSync(path.join(pretendardDir()!, 'Pretendard-Regular.ttf'))
    expect(Buffer.from(font).subarray(font.length - ttf.length).equals(ttf)).toBe(true)
  })

  test.if(!!which('pandoc'))('the text read back by our own extractor is the slots, slide by slide (line breaks aside)', async () => {
    for (const s of [SAMPLES[0]!, SAMPLES[1]!]) {
      const slides = s.decks[0]!
      const out = layoutDeck(sampleDoc(s, slides))
      const bytes = buildPptx(out, { title: 'deck', lang: s.lang, read: sampleBytes, fonts: null })
      const back = await readBack(bytes, slides.length)
      for (const note of out.slides.flatMap((x) => x.notes)) expect(back.notes).toContain(note)
      slides.forEach((sl, i) => {
        let rest = tight(back.slides[i]!)
        for (const t of slotsShown(sl)) {
          expect(rest, `${s.theme} slide ${i + 1}: ${t}`).toContain(tight(t))
          rest = rest.replace(tight(t), '')
        }
        // what is left is the template's own: page and step numbers, arrows, the company and the website
        for (const extra of [s.website ?? '', s.company]) if (extra) rest = rest.split(tight(extra)).join('')
        expect(rest, `${s.theme} slide ${i + 1}`).toMatch(/^[\d→]*$/)
      })
    }
  })
})

// ── the PDF ──────────────────────────────────────────────────────────────────────────────────────────────────────
const typst = which('typst')
const pageCount = (pdf: Uint8Array, file: string): number => {
  const info = which('pdfinfo')
  if (info) return Number(/Pages:\s+(\d+)/.exec(Bun.spawnSync([info, file]).stdout.toString())![1])
  return (Buffer.from(pdf).toString('latin1').match(/\/Type\s*\/Page(?!s)/g) ?? []).length
}

describe('the PDF (typst)', () => {
  const hostile = '#{panic()}$x$[y]"q"\\ #set page(fill: red)'

  test('every text is a typst string literal: quotes and backslashes escaped; #, $ and [ stay text in code mode', () => {
    expect(lit('a"b')).toBe('"a\\"b"')
    expect(lit('a\\b')).toBe('"a\\\\b"')
    expect(lit('#set $x$ [y]')).toBe('"#set $x$ [y]"')
    expect(lit('줄\n바꿈\u0007')).toBe('"줄 바꿈 "')
    const s = SAMPLES[1]!
    const out = layoutDeck(sampleDoc(s, s.decks[3]!, { company: hostile.slice(0, 40), title: hostile }))
    const t = buildTypst(out, { title: hostile, lang: 'en', read: () => null })
    // the name only ever inside a literal
    expect(t.source).toContain(`#set document(title: ${lit(hostile)}, author: (), date: none)`)
    expect(t.source.split('\n').filter((l) => l.includes('panic()')).every((l) => l.includes(lit(hostile.slice(0, 40))) || l.includes(lit(hostile)))).toBe(true)
    expect(t.source.match(/^#page\(/gm)).toHaveLength(out.slides.length)
  })

  test.if(!!typst && !!pretendardDir())('typst compiles it: one page per slide, the hostile name printed as text, pictures in clipped boxes', () => {
    fs.mkdirSync(WORK, { recursive: true })
    const work = fs.mkdtempSync(path.join(WORK, 'intro-deck-typst-'))
    try {
      const s = SAMPLES[0]!
      const slides = s.decks[0]!
      const out = layoutDeck(sampleDoc(s, slides, { company: hostile.slice(0, 40), title: hostile, logo: null }))
      // real pixels (typst decodes them)
      const real = new Map<string, Buffer>()
      const read = (src: string) => { const p = PICS[src]; if (!p) return null; if (!real.has(src)) real.set(src, realPng(p.width, p.height)); return real.get(src)! }
      const t = buildTypst(out, { title: hostile, lang: 'ko', read })
      expect(t.files.length).toBe(new Set(slides.flatMap((x) => ('picture' in x && x.picture ? [x.picture] : x.kind === 'products' ? x.items.map((it) => it.picture).filter(Boolean) : []))).size)
      for (const [name, bytes] of t.files) fs.writeFileSync(path.join(work, name), bytes)
      fs.writeFileSync(path.join(work, 'deck.typ'), t.source)
      const r = Bun.spawnSync([typst!, 'compile', '--font-path', pretendardDir()!, '--root', work, path.join(work, 'deck.typ'), path.join(work, 'out.pdf')])
      expect(r.exitCode, r.stderr.toString()).toBe(0)
      const pdf = fs.readFileSync(path.join(work, 'out.pdf'))
      expect(pageCount(pdf, path.join(work, 'out.pdf'))).toBe(slides.length)
      const totext = which('pdftotext')
      if (totext) {
        const text = Bun.spawnSync([totext, '-enc', 'UTF-8', path.join(work, 'out.pdf'), '-']).stdout.toString()
        expect(text.replace(/\s+/g, '')).toContain(hostile.slice(0, 40).replace(/\s+/g, ''))
        expect(text).toContain('340')
      }
    } finally { fs.rmSync(work, { recursive: true, force: true }) }
  })
})

// ── with team files: the checks, the tool, the files, the routes ─────────────────────────────────────────────────
describe('the intro deck with real team files (a real app, the fake engine)', () => {
  let h: Harness
  const SRC = 'shared/브랜드/회사 소개.md'
  const MATERIAL = `# 아크메정밀 회사 소개

아크메정밀은 2009년 경기도 안산에서 시작한 정밀 가공 부품 회사입니다. 국내 최초로 의료용 티타늄 핀을 5축 장비로 가공했습니다.
반도체 장비와 의료기기에 들어가는 부품을 만들어 340곳의 고객사에 납품합니다 (2025년 12월 기준).
불량률 0.02%, 납기 준수율 99.1%, 직원 48명.

고객사: 아크메전자, 아크메메디칼, 아크메테크, 아크메로보틱스
인증: ISO 9001, ISO 13485

아크메메디칼 구매팀 김하늘 팀장: "아크메정밀 덕분에 장비 조립 일정이 두 주 빨라졌어요"

영업팀 박서준 이사
이메일 sales@acme-precision.example
전화 031-555-0142
주소 경기도 안산시 단원구 예시로 12
웹사이트 acme-precision.example
`
  const put = (rel: string, b: Buffer | string) => { const abs = path.join(h.team, rel); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, b) }
  const tc = (user: string): ToolCtx => ({ user: h.ctx.files.principal(user), turnId: null, files: new TurnFiles() })
  const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
  const send = async (user: string, chatId: string, content: string) => {
    const r = await h.api(user).call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [] } })
    await waitFor(() => (h.ctx.db.query('SELECT status FROM messages WHERE id = ?').get(r.assistantMessage.id) as { status: string }).status !== 'streaming', { timeoutMs: 30_000 })
    return (h.ctx.db.query('SELECT content FROM messages WHERE id = ?').get(r.assistantMessage.id) as { content: string }).content
  }

  type Slides = DeckSlide[]
  const slidesOf = (): Slides => [
    { kind: 'cover', eyebrow: '회사 소개서', headline: '정밀 부품을\n*제때* 만드는 회사', sub: '반도체 장비와 의료기기 부품', picture: IMG + 'factory.png' },
    { kind: 'about', eyebrow: '회사 소개', statement: '반도체 장비와 의료기기에 들어가는 *정밀 가공 부품*을 만듭니다', facts: [{ label: '설립', value: '2009년' }, { label: '위치', value: '경기도 안산' }, { label: '직원', value: '48명' }] },
    { kind: 'offer', eyebrow: '하는 일', title: '설계부터 납품까지 한 곳에서', picture: IMG + 'line.png', pillars: [{ head: '정밀 가공', body: '도면대로 정확하게 깎아요' }, { head: '품질 검사', body: '모든 부품을 하나씩 재요' }, { head: '제때 납품', body: '약속한 날짜에 보내요' }] },
    { kind: 'numbers', eyebrow: '숫자로 보는 회사', stats: [{ number: '340곳', label: '고객사' }, { number: '0.02%', label: '불량률' }, { number: '99.1%', label: '납기 준수율' }], note: '2025년 12월 기준' },
    { kind: 'products', eyebrow: '제품', title: '주요 부품', items: [{ name: '정밀 샤프트', body: '장비 구동부에 들어가는 축', picture: IMG + 'part1.png' }, { name: '진공 블록', body: '공정 챔버용 블록', picture: IMG + 'part2.png' }, { name: '의료용 핀', body: '수술 기구에 쓰는 핀', picture: IMG + 'part3.png' }] },
    { kind: 'proof', eyebrow: '고객사', title: '함께 일하는 고객사', names: ['아크메전자', '아크메메디칼', '아크메테크', '아크메로보틱스'] },
    { kind: 'history', eyebrow: '인증', title: '품질을 인증받았어요', trust: ['ISO 9001', 'ISO 13485'] },
    { kind: 'contact', line: '부품 견적이 필요하면\n연락 주세요', person: '영업팀 박서준 이사', email: 'sales@acme-precision.example', phone: '031-555-0142', address: '경기도 안산시 단원구 예시로 12' },
  ]
  const input = (over: Partial<IntroDeckInput> = {}, slides: Slides = slidesOf()): IntroDeckInput => IntroDeckInput.parse({
    title: '아크메정밀 회사 소개서', company: '아크메정밀', website: 'acme-precision.example', brand_color: '#1e4620', logo: IMG + 'logo.png', sources: [SRC], slides, ...over,
  })
  /** the deck with one slide changed */
  const withSlide = (i: number, change: (s: DeckSlide) => DeckSlide, over: Partial<IntroDeckInput> = {}) => { const s = slidesOf(); s[i] = change(s[i]!); return input(over, s) }
  const problems = async (a: IntroDeckInput, user = 'dana', own?: (sha: string) => boolean) => {
    const r = await checkDeckInput(h.ctx, tc(user), a, 'ko', own)
    return r.ok ? [] : r.problems
  }

  beforeAll(async () => {
    h = await startHarness({ name: 'b-intro-deck' })
    // a Korean team: the deck's language, the PowerPoint runs' (ko-KR, Hangul charset) and the theme names in the answer
    h.ctx.db.query("INSERT OR REPLACE INTO settings (key, value) VALUES ('defaultLocale', ?)").run(JSON.stringify('ko'))
    // the 3-minute budget (no read step, no searches): the default is 5 minutes (DEFAULT_DECK_TIER)
    h.ctx.db.query("INSERT OR REPLACE INTO settings (key, value) VALUES ('introDeckTier', ?)").run(JSON.stringify('quick'))
    put(SRC, MATERIAL)
    put(IMG + 'factory.png', realPng(1920, 1080))
    put(IMG + 'line.png', realPng(1600, 1000, [200, 200, 190, 255]))
    for (const n of [1, 2, 3]) put(IMG + `part${n}.png`, realPng(600, 600, [60 * n, 80, 100, 255]))
    put(IMG + 'hall.png', realPng(2400, 1200))
    put(IMG + 'logo.png', realPng(400, 120, [20, 20, 20, 255], 12))
    put(IMG + 'logo-big.png', realPng(1200, 900, [20, 20, 20, 255], 60))
    put(IMG + 'portrait.jpg', jpegHead(1000, 1500))
    put(IMG + 'small.png', pngHead(1000, 600))
    put(IMG + 'flat.png', pngHead(1600, 700))
    put(IMG + 'square.png', pngHead(1600, 1600))
    put(IMG + 'tiny.png', pngHead(399, 399))
    put(IMG + 'cutout.png', realPng(1800, 1000, [200, 40, 40, 255], 120))
    put(IMG + 'not-a-photo.jpg', 'just some text, not a JPEG')
    put('shared/Other/outside.png', pngHead(1920, 1080))
    // a brand folder of a group alice is not in
    put('groups/finance/브랜드/이미지/vault.png', pngHead(1920, 1080))
    await h.api('dana').call(API.saveCompanyProfile, { body: { website: 'www.hanbit-shop.example', oneLine: '정밀 가공 부품 · 대표번호 1588-0142', products: '', audience: '', tone: [], avoid: '', sources: [], colors: ['#1e4620'] } })
  })
  afterAll(async () => { await h?.close() })

  describe('the checks (every problem at once)', () => {
    test('a deck written from the material passes; its notes quote where each number and name stands', async () => {
      const r = await checkDeckInput(h.ctx, tc('dana'), input(), 'ko')
      if (!r.ok) throw new Error(r.problems.join('\n'))
      const { doc, out, pictures } = r.deck
      expect(doc).toMatchObject({ theme: 'brand', lang: 'ko', company: '아크메정밀', website: 'acme-precision.example', brand: '#1e4620' })
      expect(out.slides.map((s) => `${s.kind} ${s.variant}`)).toEqual(['cover A', 'about A', 'offer A', 'numbers A', 'products A', 'proof A', 'history B', 'contact A'])
      expect(pictures.sort()).toEqual([IMG + 'factory.png', IMG + 'line.png', IMG + 'logo.png', IMG + 'part1.png', IMG + 'part2.png', IMG + 'part3.png'].sort())
      expect(doc.logo).toMatchObject({ src: IMG + 'logo.png', width: 400, height: 120 })
      expect(['direct', 'mono', 'chip', 'tile']).toContain(doc.logo!.light)
      const numbers = doc.notes[3]!
      expect(numbers.some((n) => n.startsWith('출처: 회사 소개.md — "') && n.includes('340곳의 고객사'))).toBe(true)
      expect(numbers.some((n) => n.includes('0.02%'))).toBe(true)
      expect(doc.notes[5]!.some((n) => n.includes('아크메전자'))).toBe(true)
      expect(doc.notes[7]!.some((n) => n.includes('박서준 이사'))).toBe(true)
      // a slide without numbers or names has no notes
      expect(doc.notes[2]).toEqual([])
    })

    test('numbers: whole numbers as written, a stat exactly as written with its unit, a year from the material', async () => {
      const p = (await problems(withSlide(3, (s) => ({ ...s, stats: [{ number: '340개', label: '고객사' }, { number: '350곳', label: '고객사' }, { number: '0.2%', label: '불량률' }, { number: '99.1%', label: '납기' }] }) as DeckSlide))).join('\n')
      expect(p).toContain('slides[3] (numbers) stats[0].number "340개" is not written in the sources exactly like that; copy the number with its sign and unit as the material writes it')
      expect(p).toContain('slides[3] (numbers) stats[1].number: the number "350" is not in the sources')
      expect(p).toContain('slides[3] (numbers) stats[2].number: the number "0.2" is not in the sources')
      expect(p).not.toContain('stats[3]')
      // "34" is not a whole number of the material ("340" is); a year that is not written; one that is
      const q = (await problems(withSlide(1, (s) => ({ ...s, statement: '고객사 34곳에 부품을 만듭니다', facts: [{ label: '설립', value: '2010년' }, { label: '직원', value: '48명' }] }) as DeckSlide))).join('\n')
      expect(q).toContain('slides[1] (about) statement: the number "34" is not in the sources')
      expect(q).toContain('slides[1] (about) facts[0].value: the number "2010" is not in the sources')
      expect(q).not.toContain('"48"')
    })

    test('names as written (NFKC, spaces aside): customers, certifications, people; a quote word for word', async () => {
      const p = (await problems(withSlide(5, (s) => ({ ...s, names: ['아크메 전자', '아크메메디칼', '아크메물산'] }) as DeckSlide))).join('\n')
      expect(p).toContain('slides[5] (proof) names[2]: "아크메물산" is not written in the sources like that')
      expect(p).not.toContain('names[0]')
      const t = (await problems(withSlide(6, (s) => ({ ...s, trust: ['ＩＳＯ 9001', '혁신 대상'] }) as DeckSlide))).join('\n')
      expect(t).toContain('slides[6] (history) trust[1]: "혁신 대상" is not written in the sources like that')
      expect(t).not.toContain('trust[0]')
      const who = (await problems(withSlide(7, (s) => ({ ...s, person: '영업팀 김철수 과장' }) as DeckSlide))).join('\n')
      expect(who).toContain('slides[7] (contact) person: "영업팀 김철수 과장" is not written in the sources like that')
      const quote = (text: string, by = '아크메메디칼 구매팀 김하늘 팀장') => withSlide(5, (s) => ({ kind: 'proof', eyebrow: '고객의 말', title: '고객이 직접 말해요', quote: { text, who: by } }) as DeckSlide)
      expect(await problems(quote('아크메정밀 덕분에 장비 조립 일정이 두 주 빨라졌어요'))).toEqual([])
      expect((await problems(quote('아크메정밀 덕분에 장비 조립 일정이 한 달 빨라졌어요'))).join('\n')).toContain('slides[5] (proof) quote.text: a quote must stand in the sources word for word')
      expect((await problems(quote('아크메정밀 덕분에 장비 조립 일정이 두 주 빨라졌어요', '아크메메디칼 대표'))).join('\n')).toContain('slides[5] (proof) quote.who: "아크메메디칼 대표" is not written in the sources like that')
    })

    test('contact details: from the sources or the saved company profile, exact', async () => {
      const contact = (c: Record<string, string>) => withSlide(7, (s) => ({ ...s, ...c }) as DeckSlide)
      const p = (await problems(contact({ email: 'info@acme-precision.example', phone: '031-555-0143', address: '경기도 안산시 단원구 예시로 21', website: 'elsewhere.example' }))).join('\n')
      expect(p).toContain('slides[7] (contact) email: "info@acme-precision.example" is not written in the sources or the company profile exactly like that')
      expect(p).toContain('slides[7] (contact) phone: "031-555-0143" is not written')
      expect(p).toContain('slides[7] (contact) address: "경기도 안산시 단원구 예시로 21" is not written')
      expect(p).toContain('slides[7] (contact) website: "elsewhere.example" is not written in the sources or the company profile')
      // the profile's website and a number only the profile writes
      expect(await problems(contact({ phone: '1588-0142', website: 'https://hanbit-shop.example/' }))).toEqual([])
      expect((await problems(input({ website: 'elsewhere.example' }))).join('\n')).toContain('website "elsewhere.example" is not written in the sources or the company profile; leave it out')
      expect((await problems(input({ website: 'not a site' }))).join('\n')).toContain('website "not a site" is not a web address')
      // the brand colour from the profile when the AI gives none
      const r = await checkDeckInput(h.ctx, tc('dana'), input({ brand_color: undefined }), 'ko')
      expect(r.ok && r.deck.doc.brand).toBe('#1e4620')
    })

    test('a superlative only when the material says it; never a headline with a full stop', async () => {
      expect(SUPERLATIVES).toEqual(expect.arrayContaining(['최고', '1위', '유일', 'No.1']))
      const p = (await problems(withSlide(2, (s) => ({ ...s, title: '업계 1위 정밀 가공', sub: '최고의 품질과 best-in-class 납기' }) as DeckSlide))).join('\n')
      expect(p).toContain('slides[2] (offer) title: "1위" is not what the sources say; leave the claim out')
      expect(p).toContain('slides[2] (offer) sub: "최고" is not what the sources say')
      expect(p).toContain('slides[2] (offer) sub: "best-in-class" is not what the sources say')
      // written in the material: allowed
      expect(await problems(withSlide(2, (s) => ({ ...s, title: '국내 최초 의료용 핀 가공' }) as DeckSlide))).toEqual([])
      expect((await problems(withSlide(2, (s) => ({ ...s, title: '설계부터 납품까지 한 곳에서.' }) as DeckSlide))).join('\n')).toContain('slides[2] (offer) title: no full stop at the end of a headline')
      // one starred key phrase at most (counted on the text as written, before the stars are taken off)
      expect((await problems(withSlide(1, (s) => ({ ...s, statement: '*정밀한* 부품을 *한곳에서* 만드는 회사예요' }) as DeckSlide))).join('\n')).toContain('slides[1] (about) statement: mark at most one key phrase with a pair of *stars*')
      expect(await problems(withSlide(1, (s) => ({ ...s, statement: '*정밀한* 부품을 한곳에서 만드는 회사예요' }) as DeckSlide))).toEqual([])
    })

    test('a source that is one of the deck\'s own outputs is refused (by its hash)', async () => {
      const bytes = fs.readFileSync(path.join(h.team, SRC))
      const p = await problems(input(), 'dana', (s) => s === sha(bytes))
      expect(p).toEqual([`source "${SRC}" is an intro deck this tool made; name the material it was made from instead`])
      expect(await problems(input(), 'dana', () => false)).toEqual([])
    })

    test('pictures: a brand folder only, real pictures by their bytes, each once, the logo only in its slot', async () => {
      const at = (i: number, picture: string, over: Partial<IntroDeckInput> = {}) => withSlide(i, (s) => ({ ...s, picture }) as DeckSlide, over)
      expect((await problems(at(0, 'shared/Other/outside.png'))).join('\n')).toContain('slides[0] (cover) picture: "shared/Other/outside.png" is not in a brand folder')
      expect((await problems(at(0, IMG + 'not-a-photo.jpg'))).join('\n')).toContain(`slides[0] (cover) picture: "${IMG}not-a-photo.jpg" is not a PNG, JPEG or WebP picture`)
      expect((await problems(at(0, IMG + 'missing.png'))).join('\n')).toContain(`slides[0] (cover) picture: "${IMG}missing.png" is not a picture this person can open`)
      expect((await problems(at(2, IMG + 'factory.png'))).join('\n')).toContain(`slides[2] (offer) picture: "${IMG}factory.png" is already used on slide 1; use another picture or none`)
      // a logo big enough for any frame still goes only in `logo` (and the footers)
      expect((await problems(at(2, IMG + 'logo-big.png', { logo: IMG + 'logo-big.png' }))).join('\n')).toContain('slides[2] (offer) picture: the logo goes only in `logo`; choose a picture or leave it out')
      // a brand folder the person cannot read is no picture of theirs
      expect((await problems(at(0, 'groups/finance/브랜드/이미지/vault.png'), 'alice')).join('\n')).toContain('is not a picture this person can open')
      // products: every item with a picture or none
      const mixed = withSlide(4, (s) => ({ ...s, items: (s as Extract<DeckSlide, { kind: 'products' }>).items.map((it, i) => (i === 0 ? { name: it.name, body: it.body } : it)) }) as DeckSlide)
      expect((await problems(mixed)).join('\n')).toContain('slides[4] (products) items: either every item has a picture or none does')
      // a JPEG portrait: the split cover
      const r = await checkDeckInput(h.ctx, tc('dana'), at(0, IMG + 'portrait.jpg'), 'ko')
      expect(r.ok && r.deck.out.slides[0]!.variant).toBe('B')
    })

    test('size per frame: the full-bleed cover or half, the half slide ≥ 800, a card ≥ 400, the scene ≥ 1,600 landscape and not a cut-out', async () => {
      const at = (i: number, picture: string) => withSlide(i, (s) => ({ ...s, picture }) as DeckSlide)
      expect((await problems(at(0, IMG + 'small.png'))).join('\n')).toContain(`slides[0] (cover) picture: "${IMG}small.png" (1000×600) is too small for this place (it needs a landscape picture at least 1,600 px wide, or one at least 800 px on its short side); choose another or leave it out`)
      expect((await problems(at(2, IMG + 'flat.png'))).join('\n')).toContain(`slides[2] (offer) picture: "${IMG}flat.png" (1600×700) is too small for this place (it needs at least 800 px on its short side)`)
      const card = withSlide(4, (s) => ({ ...s, items: (s as Extract<DeckSlide, { kind: 'products' }>).items.map((it, i) => (i === 2 ? { ...it, picture: IMG + 'tiny.png' } : it)) }) as DeckSlide)
      expect((await problems(card)).join('\n')).toContain(`slides[4] (products) items[2].picture: "${IMG}tiny.png" is too small (399×399; at least 400 px on the short side)`)
      const scene = (picture: string) => { const s = slidesOf(); s.splice(4, 0, { kind: 'scene', line: '안산 공장의 아침', picture }); return input({}, s) }
      expect(await problems(scene(IMG + 'hall.png'))).toEqual([])
      expect((await problems(scene(IMG + 'square.png'))).join('\n')).toContain(`slides[4] (scene) picture: "${IMG}square.png" (1600×1600) is too small for this place (it needs a landscape photograph (not a cut-out) at least 1,600 px wide)`)
      expect(isCutout(fs.readFileSync(path.join(h.team, IMG + 'cutout.png')))).toBe(true)
      expect(decodePng(fs.readFileSync(path.join(h.team, IMG + 'cutout.png')))?.width).toBe(1800)
      expect((await problems(scene(IMG + 'cutout.png'))).join('\n')).toContain(`slides[4] (scene) picture: "${IMG}cutout.png" (1800×1000) is too small for this place (it needs a landscape photograph (not a cut-out)`)
    })
  })

  describe('the tool, the files, the routes (round 2: outline, one slide per call, finish)', () => {
    // the round-2 deck the stand-in AI writes from the same material: no relationship figures (the material states
    // no order or loop), so no basis is needed; typst off, so the last slide finishes the deck (no review round)
    const stubs = (over: { picture?: string } = {}) => [
      { kind: 'cover', section: '표지', headline: '정밀 부품을 제때', picture: over.picture ?? IMG + 'factory.png' },
      { kind: 'about', section: '회사 소개', headline: '정밀 가공 부품' },
      { kind: 'numbers', section: '숫자', headline: '고객이 다시 찾는 이유', figure: 'figures' },
      { kind: 'products', section: '제품', headline: '주요 부품', figure: 'cards' },
      { kind: 'proof', section: '고객사', headline: '함께 일하는 고객사' },
      { kind: 'contact', section: '마무리', headline: '연락 주세요' },
    ]
    const outline2 = (over: Record<string, unknown> = {}, picture?: string) => ({
      step: 'outline', title: '아크메정밀 회사 소개서', company: '아크메정밀', website: 'acme-precision.example', brand_color: '#1e4620', logo: IMG + 'logo.png', sources: [SRC], pattern: 'dots',
      pictures: [{ path: picture ?? IMG + 'factory.png', subject: '공장', lettering: false, calm: 'left', tone: 'dark' }, ...[1, 2, 3].map((n) => ({ path: IMG + `part${n}.png`, subject: '부품', lettering: false, calm: 'none', tone: 'mixed' }))],
      slides: stubs({ picture }), ...over,
    })
    const slides2 = (picture?: string): import('@mycel/shared/api').DeckSlide2[] => [
      { kind: 'cover', headline: '정밀 부품을\n*제때* 만드는 회사', sub: '반도체 장비와 의료기기 부품', picture: picture ?? IMG + 'factory.png' },
      { kind: 'about', statement: '반도체 장비와 의료기기에 들어가는 *정밀 가공 부품*을 만듭니다', facts: [{ label: '설립', value: '2009년' }, { label: '위치', value: '경기도 안산' }, { label: '직원', value: '48명' }] },
      { kind: 'numbers', title: '고객이 다시 찾는 이유', note: '2025년 12월 기준', figure: { kind: 'figures', items: [{ number: '340곳', label: '고객사' }, { number: '0.02%', label: '불량률' }, { number: '99.1%', label: '납기 준수율' }] } },
      { kind: 'products', title: '주요 부품', figure: { kind: 'cards', items: [{ name: '정밀 샤프트', body: '장비 구동부에 들어가는 축', picture: IMG + 'part1.png' }, { name: '진공 블록', body: '공정 챔버용 블록', picture: IMG + 'part2.png' }, { name: '의료용 핀', body: '수술 기구에 쓰는 핀', picture: IMG + 'part3.png' }] } },
      { kind: 'proof', title: '함께 일하는 고객사', names: ['아크메전자', '아크메메디칼', '아크메테크', '아크메로보틱스'] },
      { kind: 'contact', line: '부품 견적이 필요하면\n연락 주세요', person: '영업팀 박서준 이사', email: 'sales@acme-precision.example', phone: '031-555-0142', address: '경기도 안산시 단원구 예시로 12' },
    ]
    const script = (o: Record<string, unknown> = outline2(), list = slides2()) => fake({ tool: 'intro_deck', args: o, sayResult: true }, ...list.map((s, i) => ({ tool: 'intro_deck', args: { step: 'slide', index: i, slide: s }, sayResult: true })))
    const typstOff = async <T,>(fn: () => Promise<T>): Promise<T> => {
      const prev = process.env.MYCEL_TYPST_BIN
      process.env.MYCEL_TYPST_BIN = ''
      try { return await fn() } finally { if (prev === undefined) delete process.env.MYCEL_TYPST_BIN; else process.env.MYCEL_TYPST_BIN = prev }
    }
    /** a deck made through a chat turn: its chat and artifact ids */
    const make = async (content = script(), user = 'dana', chatId?: string) => {
      const chat = chatId ?? (await h.api(user).call(API.createChat, { body: {} })).id
      const answer = await typstOff(() => send(user, chat, content))
      const row = h.ctx.db.query('SELECT artifact_id FROM intro_decks WHERE chat_id = ? ORDER BY created_at DESC LIMIT 1').get(chat) as { artifact_id: string } | null
      return { chat, id: row?.artifact_id ?? '', answer }
    }

    test('every problem of an outline in one answer; three outlines at most, then stop', async () => {
      const chat = await h.api('dana').call(API.createChat, { body: {} })
      const bad = outline2({ slides: [stubs()[1], stubs()[0], ...stubs().slice(2)] })
      const once = await send('dana', chat.id, fake({ tool: 'intro_deck', args: bad, sayResult: true }))
      expect(once).toContain('The outline was not accepted. Fix every problem below and call intro_deck step "outline" once more')
      expect(once).toContain('slides[0] must be the cover')
      const four = await send('dana', chat.id, fake(...[1, 2, 3, 4].map(() => ({ tool: 'intro_deck', args: bad, sayResult: true }))))
      expect(four.match(/The outline was not accepted/g)).toHaveLength(3)
      expect(four).toContain('Do not call intro_deck again in this answer. Tell the person in one plain sentence that the deck could not be made this time and why (the problems you were given).')
      expect(h.ctx.db.query('SELECT count(*) AS n FROM artifacts WHERE chat_id = ?').get(chat.id)).toEqual({ n: 0 })
      expect(h.ctx.db.query('SELECT count(*) AS n FROM intro_decks WHERE chat_id = ?').get(chat.id)).toEqual({ n: 0 })
    })

    test('checked slides: the artifact "intro-deck" (HTML, a new version per deck) and a row in intro_decks; the answer in plain words', async () => {
      const { chat, id, answer } = await make()
      expect(answer).toContain('The intro deck "아크메정밀 회사 소개서" is finished (6 slides, the "어두운" look; slides that could have had a picture but were made without one: none)')
      const art = h.ctx.db.query('SELECT id, key, type, title, content, version FROM artifacts WHERE chat_id = ?').get(chat) as { id: string; key: string; type: string; title: string; content: string; version: number }
      expect(art).toMatchObject({ id, key: DECK_ARTIFACT_KEY, type: 'html', title: '아크메정밀 회사 소개서', version: 1 })
      expect(art.content.match(/<section class="s/g)).toHaveLength(6)
      expect(art.content).toContain('<link rel="stylesheet" href="/vendor/fonts/pretendard.css">')
      const row = h.ctx.db.query('SELECT chat_id, user_id, spec, pptx_sha256, pdf_sha256 FROM intro_decks WHERE artifact_id = ?').get(id) as { chat_id: string; user_id: string; spec: string; pptx_sha256: string | null; pdf_sha256: string | null }
      expect(row).toMatchObject({ chat_id: chat, user_id: 'dana', pptx_sha256: null, pdf_sha256: null })
      const spec = JSON.parse(row.spec)
      expect(spec.title).toBe('아크메정밀 회사 소개서')
      expect(spec.sources).toEqual([SRC])
      expect(spec.doc).toMatchObject({ v: 2, theme: 'ink' })
      expect(spec.doc.pics[IMG + 'factory.png']).toEqual({ width: 1920, height: 1080 })
      // a theme that does not fit the colour is replaced (and said); the next deck in the chat is the next version
      const light = await make(script(outline2({ brand_color: '#cad3fb', theme: 'brand' })), 'dana', chat)
      expect(light.answer).toContain('(the "브랜드색" look does not fit this brand colour, so the server used "밝은 종이")')
      expect(h.ctx.db.query('SELECT max(version) AS v FROM artifacts WHERE chat_id = ? AND key = ?').get(chat, DECK_ARTIFACT_KEY)).toEqual({ v: 2 })
      expect(h.ctx.db.query('SELECT count(*) AS n FROM intro_decks WHERE chat_id = ?').get(chat)).toEqual({ n: 2 })
    })

    test('the info and the downloads only for the chat\'s owner; the PDF hidden where typst is missing', async () => {
      const { chat, id } = await make()
      const info = await h.api('dana').call(API.getIntroDeck, { params: { id } })
      expect(info).toEqual({ artifactId: id, chatId: chat, title: '아크메정밀 회사 소개서', theme: 'ink', slides: 6, pptx: true, pdf: pdfAvailable() })
      for (const p of ['', '/pptx', '/pdf']) expect((await h.req('alice', `/api/intro-decks/${id}${p}`)).status, p).toBe(404)
      expect((await h.req('dana', '/api/intro-decks/nope')).status).toBe(404)
      const prev = process.env.MYCEL_TYPST_BIN
      process.env.MYCEL_TYPST_BIN = ''
      try {
        expect(pdfAvailable()).toBe(false)
        expect((await h.api('dana').call(API.getIntroDeck, { params: { id } })).pdf).toBe(false)
        expect((await h.req('dana', `/api/intro-decks/${id}/pdf`)).status).toBe(404)
      } finally { if (prev === undefined) delete process.env.MYCEL_TYPST_BIN; else process.env.MYCEL_TYPST_BIN = prev }
      // a trashed chat's deck is not found either
      await h.api('dana').call(API.deleteChat, { params: { id: chat } })
      expect((await h.req('dana', `/api/intro-decks/${id}`)).status).toBe(404)
    })

    test('the PowerPoint file: built from the row, kept, its hash recorded; put back as a source it is refused', async () => {
      const { id } = await make()
      const res = await h.req('dana', `/api/intro-decks/${id}/pptx`)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-disposition')).toContain(encodeURIComponent('아크메정밀 회사 소개서.pptx'))
      const bytes = new Uint8Array(await res.arrayBuffer())
      const spec = JSON.parse((h.ctx.db.query('SELECT spec FROM intro_decks WHERE artifact_id = ?').get(id) as { spec: string }).spec)
      const out = layoutDeck2(spec.doc)
      checkPptx(bytes, out, { lang: 'ko', title: '아크메정밀 회사 소개서', fonts: !!pretendardDir() })
      // the notes are the sources; the figures are native shapes
      expect(out.slides[2]!.notes.join('\n')).toContain('출처: 회사 소개.md — "')
      const zip = readZip(bytes)
      // the closing's drawn pattern is a picture; the cards slide's icons and shapes are native
      expect(Buffer.from(zip.find((e) => e.name === 'ppt/slides/slide6.xml')!.data).toString('utf8')).toContain('name="Pattern ')
      expect(Buffer.from(zip.find((e) => e.name === 'ppt/slides/slide1.xml')!.data).toString('utf8')).toContain('name="Shade ')
      const file = path.join(h.dataDir, 'intro-decks', `${id}.pptx`)
      expect(sha(fs.readFileSync(file))).toBe(sha(bytes))
      const row = h.ctx.db.query('SELECT pptx_sha256 FROM intro_decks WHERE artifact_id = ?').get(id) as { pptx_sha256: string }
      expect(row.pptx_sha256).toBe(sha(bytes))
      expect(isOwnOutput(h.ctx, sha(bytes))).toBe(true)
      // given again from the cache, the same bytes
      expect(sha(new Uint8Array(await (await h.req('dana', `/api/intro-decks/${id}/pptx`)).arrayBuffer()))).toBe(sha(bytes))
      // downloaded and put back into the brand folder: never a source of the next deck
      put('shared/브랜드/아크메정밀 회사 소개서.pptx', Buffer.from(bytes))
      const again = await make(script(outline2({ sources: [SRC, 'shared/브랜드/아크메정밀 회사 소개서.pptx'] })))
      expect(again.answer).toContain('source "shared/브랜드/아크메정밀 회사 소개서.pptx" is an intro deck this tool made; name the material it was made from instead')
      expect(again.id).toBe('')
      // our own extractor reads the words back
      if (which('pandoc')) {
        const back = await readBack(bytes, out.slides.length)
        expect(tight(back.slides[0]!)).toContain(tight('정밀 부품을 제때 만드는 회사'))
        expect(tight(back.slides[4]!)).toContain(tight('아크메로보틱스'))
        expect(back.notes).toContain('출처: 회사 소개.md — "')
      }
    })

    test.if(!!typst && !!pretendardDir())('the PDF through the route: typst in its isolation, one page per slide, kept with its hash', async () => {
      const { id } = await make()
      const res = await h.req('dana', `/api/intro-decks/${id}/pdf`)
      expect(res.status, await res.clone().text().then((t) => t.slice(0, 300))).toBe(200)
      expect(res.headers.get('content-disposition')).toContain(encodeURIComponent('아크메정밀 회사 소개서.pdf'))
      const pdf = new Uint8Array(await res.arrayBuffer())
      expect(Buffer.from(pdf.subarray(0, 5)).toString('latin1')).toBe('%PDF-')
      const file = path.join(h.dataDir, 'intro-decks', `${id}.pdf`)
      expect(pageCount(pdf, file)).toBe(6)
      expect((h.ctx.db.query('SELECT pdf_sha256 FROM intro_decks WHERE artifact_id = ?').get(id) as { pdf_sha256: string }).pdf_sha256).toBe(sha(pdf))
      expect(fs.readdirSync(path.join(h.dataDir, 'intro-decks')).filter((f) => f.endsWith('.part'))).toEqual([])
    })

    /** slide 1 of a PowerPoint file: its pictures other than the logo, and whether it is the drawn cover */
    const coverOf = (bytes: Uint8Array, logoSrc: string) => {
      const zip = readZip(bytes)
      const slide1 = parseXml(Buffer.from(zip.find((e) => e.name === 'ppt/slides/slide1.xml')!.data).toString('utf8'), 'slide1')
      const pics = all(slide1, 'p:pic').filter((p) => all(p, 'p:cNvPr')[0]!.attrs.name!.startsWith('Picture '))
      void logoSrc
      return { zip, slide1, pics, pattern: all(slide1, 'p:pic').some((p) => all(p, 'p:cNvPr')[0]!.attrs.name!.startsWith('Pattern ')) }
    }

    test('a WebP picture is left out of the PowerPoint file (its slide drawn instead); the preview keeps it', async () => {
      // RIFF … WEBP with a VP8X header: 2000 × 1100 (the server reads the size, never the pixels)
      const webp = Buffer.alloc(30)
      webp.write('RIFF', 0, 'ascii'); webp.writeUInt32LE(22, 4); webp.write('WEBPVP8X', 8, 'ascii'); webp.writeUInt32LE(10, 16)
      webp.writeUIntLE(2000 - 1, 24, 3); webp.writeUIntLE(1100 - 1, 27, 3)
      put(IMG + 'cover.webp', webp)
      const { id } = await make(script(outline2({}, IMG + 'cover.webp'), slides2(IMG + 'cover.webp')))
      expect(id).not.toBe('')
      const html = (h.ctx.db.query('SELECT content FROM artifacts WHERE id = ?').get(id) as { content: string }).content
      expect(html).toContain('cover.webp')
      const res = await h.req('dana', `/api/intro-decks/${id}/pptx`)
      expect(res.status).toBe(200)
      const c = coverOf(new Uint8Array(await res.arrayBuffer()), IMG + 'logo.png')
      expect(c.zip.filter((e) => e.name.startsWith('ppt/media/') && e.name.endsWith('.webp'))).toEqual([])
      // the drawn cover: its pattern, and no picture but the logo (shown whole)
      expect(c.pattern).toBe(true)
      for (const p of c.pics) expect(all(p, 'a:srcRect')[0]!.attrs).toEqual({ l: '0', t: '0', r: '0', b: '0' })
    })

    test('a picture no longer readable at build time turns its slide into the drawn version (never a broken file)', async () => {
      put(IMG + 'cover-once.png', realPng(2000, 1100))
      const { id } = await make(script(outline2({}, IMG + 'cover-once.png'), slides2(IMG + 'cover-once.png')))
      expect(id).not.toBe('')
      fs.rmSync(path.join(h.team, IMG + 'cover-once.png'))
      const res = await h.req('dana', `/api/intro-decks/${id}/pptx`)
      expect(res.status).toBe(200)
      const bytes = new Uint8Array(await res.arrayBuffer())
      const c = coverOf(bytes, IMG + 'logo.png')
      expect(c.pattern).toBe(true)
      for (const p of c.pics) expect(all(p, 'a:srcRect')[0]!.attrs).toEqual({ l: '0', t: '0', r: '0', b: '0' })
      // every part still parses and every relationship holds
      const spec = JSON.parse((h.ctx.db.query('SELECT spec FROM intro_decks WHERE artifact_id = ?').get(id) as { spec: string }).spec)
      const { [IMG + 'cover-once.png']: _, ...pics } = spec.doc.pics
      const out = layoutDeck2({ ...spec.doc, pics })
      expect(out.slides[0]!.variant).toBe('C')
      expect(out.typeOnly).toEqual([0])
      checkPptx(bytes, out, { lang: 'ko', title: '아크메정밀 회사 소개서', fonts: !!pretendardDir() })
    })

    test('the trash keeps the files; purging the chat removes them (and a cut-off part file), never another deck\'s', async () => {
      const gone = await make(), kept = await make()
      const dir = path.join(h.dataDir, 'intro-decks')
      fs.mkdirSync(dir, { recursive: true })
      const files = [`${gone.id}.pptx`, `${gone.id}.pdf`, `${gone.id}.pdf.part`, `${kept.id}.pptx`]
      for (const f of files) fs.writeFileSync(path.join(dir, f), 'DECK')
      await h.api('dana').call(API.deleteChat, { params: { id: gone.chat } })
      h.rt().purgeTrash()
      await h.rt().lastForget
      expect(files.filter((f) => fs.existsSync(path.join(dir, f)))).toEqual(files)
      h.ctx.db.query('UPDATE chats SET deleted_at = ? WHERE id = ?').run(new Date(Date.now() - 40 * 86400_000).toISOString(), gone.chat)
      expect(h.rt().purgeTrash()).toBeGreaterThanOrEqual(1)
      await h.rt().lastForget
      expect(h.ctx.db.query('SELECT count(*) AS n FROM intro_decks WHERE chat_id = ?').get(gone.chat)).toEqual({ n: 0 })
      expect(files.filter((f) => fs.existsSync(path.join(dir, f)))).toEqual([`${kept.id}.pptx`])
      // and forgetIntroDecks on its own leaves every file whose row is there
      forgetIntroDecks(h.ctx)
      expect(fs.existsSync(path.join(dir, `${kept.id}.pptx`))).toBe(true)
    })

    test('deckToPromoInput: a checked deck becomes promo video slots that pass the promo video\'s schema', async () => {
      const r = await checkDeckInput(h.ctx, tc('dana'), input(), 'ko')
      if (!r.ok) throw new Error(r.problems.join('\n'))
      const promo = deckToPromoInput(r.deck.doc, r.deck.sources)
      const parsed = PromoVideoInput.safeParse(promo)
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true)
      expect(promo).toMatchObject({ title: '아크메정밀 회사 소개서', company: '아크메정밀', website: 'acme-precision.example', brand_color: '#1e4620', logo: IMG + 'logo.png', sources: [SRC] })
      expect(promo.proof.stats?.map((s) => s.number)).toEqual(['340곳', '0.02%'])
      // the sample decks too (thin ones, English ones)
      for (const s of SAMPLES) for (const slides of s.decks) {
        const p = PromoVideoInput.safeParse(deckToPromoInput(sampleDoc(s, slides), ['shared/브랜드/회사 소개.md']))
        expect(p.success, `${s.theme}: ${JSON.stringify(p.error?.issues)}`).toBe(true)
      }
    })
  })
})
