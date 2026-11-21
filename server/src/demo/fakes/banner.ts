// The demo's banner kit (the fake Higgsfield's make_banner, higgsfield.ts): a banner is two layers, a text-free product
// photo made in advance and its words (headline, the line under it, the offer badge, the button), so a visitor who asks
// to change the words gets a new banner back instead of "the text is baked into the picture" (owner, 11-21).
//
//   <content>/higgsfield/banner/kit.json      the language, the brand, the launch banner's words, the scenes
//   <content>/higgsfield/banner/bg-*.jpg      each scene's photo per size (scripts/demo/steepling/banner/)
//   <content>/higgsfield/banner/fonts/        the brand guide's type (SIL Open Font License 1.1)
//
// typst draws it (every install that makes PDFs has typst: tools/make-file.ts findConverters), in the converters'
// isolation (tools/isolate.ts), in an empty work folder holding only the photo and the document; the words go into the
// document as typst strings, never as markup or code. The layout follows the scripted story's campaign.html
// (scripts/demo/mina/source/banners/): the 1200×628 web banner, the 1080×1080 square and the 1080×1920 story.
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { which } from '../../config'
import { dirBytes, makeWorkDir, readOutput, runIsolated } from '../../tools/isolate'

export const BANNER_DIR = 'banner'
export const KIT_FILE = 'kit.json'
export const BANNER_SIZES = ['1200x628', '1080x1080', '1080x1920'] as const
export type BannerSize = (typeof BANNER_SIZES)[number]
const BANNER_TIMEOUT_MS = 20_000
const PNG_MAX = 32 * 1024 * 1024

const Words = z.object({
  eyebrow: z.string().max(200),
  /** lines split by "\n"; *a word* in stars is italic (Latin headlines) */
  headline: z.string().max(300),
  subline: z.string().max(400),
  badge: z.string().max(80),
  badgeNote: z.string().max(80),
  cta: z.string().max(80),
})
export type BannerWords = z.infer<typeof Words>
const Box = z.tuple([z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1)])
const Photo = z.object({ file: z.string().regex(/^[\w.-]+\.(jpg|jpeg|png)$/), label: Box.nullable() })
const Scene = z.object({ id: z.string().regex(/^[\w-]{1,40}$/), words: z.array(z.string().max(40)).max(60), photos: z.partialRecord(z.enum(BANNER_SIZES), Photo) })
export const BannerKitFile = z.object({
  lang: z.enum(['en', 'ko', 'ja', 'zh', 'es', 'id']),
  brand: z.string().max(60),
  pouchName: z.string().max(60),
  pouchKind: z.string().max(60),
  words: Words,
  scenes: z.array(Scene).min(1).max(20),
})
export type BannerKitFile = z.infer<typeof BannerKitFile>
export interface BannerKit extends BannerKitFile { dir: string }

/** the content folder's banner kit, or null (none, or one that does not read) */
export function loadBannerKit(content: string | null, warn: (m: string) => void = () => {}): BannerKit | null {
  if (!content) return null
  const dir = path.join(content, 'higgsfield', BANNER_DIR)
  let raw: string
  try { raw = fs.readFileSync(path.join(dir, KIT_FILE), 'utf8') } catch { return null }
  try { return { ...BannerKitFile.parse(JSON.parse(raw)), dir } } catch (e) { warn(`demo fakes: the banner kit could not be read (${String((e as Error).message).slice(0, 200)})`); return null }
}

const wordsOf = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)

/** the scene with a photo in this size whose words share the most with `text` (the first such scene on a tie) */
export function pickScene(kit: BannerKitFile, size: BannerSize, text: string): BannerKitFile['scenes'][number] | null {
  const want = new Set(wordsOf(text))
  // Korean writes "두 잔" and "두잔": both count
  const joined = wordsOf(text).map((w, i, a) => w + (a[i + 1] ?? ''))
  for (const j of joined) want.add(j)
  let best: BannerKitFile['scenes'][number] | null = null, score = -1
  for (const s of kit.scenes) {
    if (!s.photos[size]) continue
    const n = s.words.filter((w) => want.has(w.toLowerCase())).length
    if (n > score) { best = s; score = n }
  }
  return best
}

/** an AI's size words ("1:1", "square", "story", "1080x1920") → a banner size (default: the web banner) */
export function sizeOf(v: unknown): BannerSize {
  const s = String(v ?? '').toLowerCase().replace(/\s+/g, '').replace('×', 'x')
  if ((BANNER_SIZES as readonly string[]).includes(s)) return s as BannerSize
  if (/1:1|square|instagram-?post|feed/.test(s)) return '1080x1080'
  if (/9:16|story|stories|reel|vertical|portrait/.test(s)) return '1080x1920'
  return '1200x628'
}

// ---- the typst document ----
/** a typst string literal: the words stay words (no markup, no code) */
export function typstString(s: string): string {
  // eslint-disable-next-line no-control-regex
  return '"' + s.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"'
}

const SERIF: Record<BannerKitFile['lang'], string[]> = {
  en: ['Fraunces', 'Noto Serif KR'], es: ['Fraunces', 'Noto Serif KR'], id: ['Fraunces', 'Noto Serif KR'],
  ko: ['Noto Serif KR', 'AppleMyungjo', 'Noto Serif CJK KR'],
  ja: ['Hiragino Mincho ProN', 'Noto Serif CJK JP', 'Noto Serif JP', 'Noto Serif KR'],
  zh: ['Songti SC', 'Noto Serif CJK SC', 'Noto Serif SC', 'Noto Serif KR'],
}
const SANS: Record<BannerKitFile['lang'], string[]> = {
  en: ['Noto Sans KR', 'Helvetica Neue', 'Arial'], es: ['Noto Sans KR', 'Helvetica Neue', 'Arial'], id: ['Noto Sans KR', 'Helvetica Neue', 'Arial'],
  ko: ['Noto Sans KR', 'Apple SD Gothic Neo', 'Noto Sans CJK KR'],
  ja: ['Hiragino Sans', 'Noto Sans CJK JP', 'Noto Sans JP', 'Noto Sans KR'],
  zh: ['PingFang SC', 'Noto Sans CJK SC', 'Noto Sans SC', 'Noto Sans KR'],
}
const fontList = (l: string[]) => `(${l.map((f) => typstString(f)).join(', ')})`
const latin = (lang: string) => lang === 'en' || lang === 'es' || lang === 'id'

/** the headline as typst markup (inside [ ]): lines, *italic* words (Latin only; elsewhere they stay upright, as campaign.html) */
function headlineContent(text: string, lang: string): string {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 4)
  return lines.map((line) => {
    const parts: string[] = []
    const re = /\*([^*]+)\*/g
    let at = 0, m: RegExpExecArray | null
    while ((m = re.exec(line))) {
      if (m.index > at) parts.push(typstString(line.slice(at, m.index)))
      parts.push(latin(lang) ? `text(style: "italic", weight: 500, ${typstString(m[1]!)})` : typstString(m[1]!))
      at = m.index + m[0].length
    }
    if (at < line.length) parts.push(typstString(line.slice(at).replace(/\*/g, '')))
    return parts.map((p) => `#{${p}}`).join('')
  }).join('#linebreak()')
}

interface Layout {
  wash: { dir: 'ltr' | 'ttb'; stops: [number, number][] }
  logo: { x: number | 'center'; y: number; size: number }
  copy: { x: number; y: number; w: number; center?: boolean }
  eyebrow: number; h1: number; h1Ko: number; h1Gap: number; sub: number; subGap: number; subW: number
  row: { dir: 'ltr' | 'ttb'; gap: number; size: number; padY: number; padX: number; at: { top: number } | { bottom: number } | { after: number }; center?: boolean }
}
const LAYOUTS: Record<BannerSize, Layout> = {
  '1200x628': {
    wash: { dir: 'ltr', stops: [[0.78, 0], [0.55, 34], [0, 52]] }, logo: { x: 56, y: 44, size: 26 }, copy: { x: 56, y: 132, w: 520 },
    eyebrow: 13, h1: 68, h1Ko: 56, h1Gap: 16, sub: 19, subGap: 18, subW: 430,
    row: { dir: 'ltr', gap: 14, size: 16, padY: 12, padX: 19, at: { after: 34 } },
  },
  '1080x1080': {
    wash: { dir: 'ttb', stops: [[0.6, 0], [0.35, 40], [0, 58]] }, logo: { x: 72, y: 64, size: 34 }, copy: { x: 72, y: 178, w: 560 },
    eyebrow: 17, h1: 92, h1Ko: 78, h1Gap: 20, sub: 24, subGap: 22, subW: 470,
    row: { dir: 'ttb', gap: 16, size: 22, padY: 14, padX: 25, at: { top: 650 } },
  },
  '1080x1920': {
    wash: { dir: 'ttb', stops: [[0, 0], [0.5, 12], [0.45, 36], [0, 46]] }, logo: { x: 'center', y: 250, size: 40 }, copy: { x: 80, y: 360, w: 920, center: true },
    eyebrow: 20, h1: 118, h1Ko: 96, h1Gap: 22, sub: 30, subGap: 24, subW: 920,
    row: { dir: 'ltr', gap: 16, size: 28, padY: 16, padX: 31, at: { bottom: 236 }, center: true },
  },
}

/** The typst document of one banner: the photo (`bg` in the work folder) under the words. */
export function bannerTypst(kit: BannerKitFile, size: BannerSize, photo: { label: [number, number, number, number] | null }, words: BannerWords, bg: string): string {
  const [W, H] = size.split('x').map(Number) as [number, number]
  const L = LAYOUTS[size], lang = kit.lang, isLatin = latin(lang)
  const serif = fontList(SERIF[lang]), sans = fontList(SANS[lang])
  const out: string[] = [
    `#set page(width: ${W}pt, height: ${H}pt, margin: 0pt)`,
    `#set text(font: ${sans}, lang: ${typstString(lang === 'zh' ? 'zh' : lang)}, fill: rgb("#1B1F1C"))`,
    '#let green = rgb("#1F4D3A")', '#let deep = rgb("#163a2b")', '#let cream = rgb("#F6F1E7")', '#let yuzu = rgb("#F2B630")', '#let ink = rgb("#1B1F1C")',
    `#place(top + left, image(${typstString(bg)}, width: ${W}pt, height: ${H}pt, fit: "cover"))`,
    `#place(top + left, rect(width: ${W}pt, height: ${H}pt, stroke: none, fill: gradient.linear(${[...L.wash.stops, [0, 100] as [number, number]].map(([a, p]) => `(rgb(246, 241, 231, ${Math.round(a * 255)}), ${p}%)`).join(', ')}, dir: ${L.wash.dir})))`,
  ]
  // the pouch's label printing, on the photo's blank label
  if (photo.label) {
    const [l, t, r, b] = photo.label
    const lw = (r - l) * W, lh = (b - t) * H
    const pk = `text(fill: green.transparentize(8%), `
    out.push(`#place(top + left, dx: ${(l * W).toFixed(1)}pt, dy: ${(t * H).toFixed(1)}pt, box(width: ${lw.toFixed(1)}pt, height: ${lh.toFixed(1)}pt)[` +
      `#place(top + center, dy: ${(lh * 0.13).toFixed(1)}pt, ${pk}font: ("Fraunces", "Noto Serif KR"), weight: 600, size: ${(lw * 0.15).toFixed(1)}pt, tracking: -0.01em, ${typstString(kit.brand)}))` +
      `#place(top + center, dy: ${(lh * 0.3).toFixed(1)}pt, line(length: ${(lw * 0.4).toFixed(1)}pt, stroke: 0.6pt + green.transparentize(60%)))` +
      `#place(top + center, dy: ${(lh * 0.63).toFixed(1)}pt, ${pk}font: ${isLatin ? '("Fraunces", "Noto Serif KR")' : serif}, weight: 600, size: ${(lw * 0.12).toFixed(1)}pt, ${typstString(kit.pouchName)}))` +
      `#place(top + center, dy: ${(lh * 0.81).toFixed(1)}pt, ${pk}weight: 700, size: ${(lw * 0.045).toFixed(1)}pt, tracking: 0.16em, upper(${typstString(kit.pouchKind)})))` +
      '])')
  }
  // the wordmark: a leaf and the brand
  const ls = L.logo.size
  const k = (ls * 0.78).toFixed(1), c = (ls * 0.78 * 0.552).toFixed(1) // typst 0.13+: curve
  // the leaf: a square with two opposite corners fully rounded (campaign.html .logo i: border-radius 0 100% 0 100%)
  const leaf = `box(baseline: 0.08em, curve(fill: green, curve.move((0pt, 0pt)), curve.cubic((${c}pt, 0pt), (${k}pt, ${(ls * 0.78 - ls * 0.78 * 0.552).toFixed(1)}pt), (${k}pt, ${k}pt)), curve.cubic((${(ls * 0.78 - ls * 0.78 * 0.552).toFixed(1)}pt, ${k}pt), (0pt, ${c}pt), (0pt, 0pt)), curve.close()))`
  const logo = `${leaf}#h(${(ls * 0.32).toFixed(1)}pt)#text(font: ("Fraunces", "Noto Serif KR"), weight: 600, size: ${ls}pt, tracking: -0.015em, fill: green, ${typstString(kit.brand)})`
  out.push(L.logo.x === 'center'
    ? `#place(top + center, dy: ${L.logo.y}pt)[#${logo}]`
    : `#place(top + left, dx: ${L.logo.x}pt, dy: ${L.logo.y}pt)[#${logo}]`)
  // the copy: eyebrow, headline, the line under it
  const h1 = isLatin ? L.h1 : L.h1Ko
  const h1Font = isLatin ? `font: ${serif}, weight: 600, tracking: -0.018em` : `font: ${serif}, weight: 600, tracking: ${lang === 'ko' ? '-0.035em' : '0.01em'}`
  // CSS line boxes: .98 (Latin, Fraunces) and 1.2 (CJK) of the size, the glyphs inside them
  const edges = isLatin ? 'top-edge: 0.76em, bottom-edge: -0.2em' : 'top-edge: 0.9em, bottom-edge: -0.14em'
  const lead = isLatin ? 0.02 : 0.16
  const parts: string[] = []
  if (words.eyebrow.trim()) parts.push(`text(size: ${L.eyebrow}pt, weight: 700, tracking: ${isLatin ? '0.2em' : '0.12em'}, fill: green.transparentize(15%), upper(${typstString(words.eyebrow.trim())}))`, `v(${L.h1Gap}pt)`)
  if (words.headline.trim()) parts.push(`block(par(leading: ${lead}em, text(size: ${h1}pt, ${h1Font}, fill: deep, ${edges}, [${headlineContent(words.headline, lang)}])))`)
  if (words.subline.trim()) parts.push(`v(${L.subGap + 4}pt)`, `block(width: ${L.subW}pt, par(leading: 0.55em, text(size: ${L.sub}pt, weight: 500, fill: ink.transparentize(18%), ${typstString(words.subline.trim())})))`)
  // the badge and the button
  const r = L.row
  const pill = (fill: string, body: string) => `box(fill: ${fill}, radius: 999pt, inset: (x: ${r.padX}pt, y: ${r.padY}pt), ${body})`
  const pills: string[] = []
  if (words.badge.trim()) pills.push(pill('yuzu', `[#text(size: ${r.size}pt, weight: 700, fill: ink, ${typstString(words.badge.trim())})${words.badgeNote.trim() ? `#h(0.55em)#text(size: ${r.size}pt, weight: 500, fill: ink.transparentize(25%), ${typstString(words.badgeNote.trim())})` : ''}]`))
  if (words.cta.trim()) pills.push(pill('green', `text(size: ${r.size}pt, weight: 700, fill: cream, ${typstString(words.cta.trim())})`))
  const row = pills.length ? `stack(dir: ${r.dir}, spacing: ${r.gap}pt, ${pills.join(', ')})` : ''
  if (row && 'after' in r.at) parts.push(`v(${r.at.after}pt)`, row)
  const align = L.copy.center ? 'center' : 'left'
  out.push(`#place(top + left, dx: ${L.copy.x}pt, dy: ${L.copy.y}pt, block(width: ${L.copy.w}pt, align(${align}, stack(dir: ttb, ${parts.length ? parts.join(', ') : '[]'}))))`)
  if (row && 'top' in r.at) out.push(`#place(top + left, dx: ${L.copy.x}pt, dy: ${r.at.top}pt, ${row})`)
  if (row && 'bottom' in r.at) out.push(`#place(bottom + center, dy: -${r.at.bottom}pt, ${row})`)
  out.push('')
  return out.join('\n')
}

/** typst on this server (MYCEL_TYPST_BIN, the bundle's, Homebrew's, PATH), or null */
export const findTypst = (): string | null => process.env.MYCEL_TYPST_BIN ?? which('typst')

export class BannerError extends Error {}

/** One banner as a PNG: the scene's photo in this size under the words. */
export async function renderBanner(kit: BannerKit, size: BannerSize, scene: BannerKitFile['scenes'][number], words: BannerWords, typst: string | null = findTypst()): Promise<Buffer> {
  if (!typst) throw new BannerError('the banner maker is not set up on this demo server (no typst)')
  const photo = scene.photos[size]
  if (!photo) throw new BannerError(`no ${size} photo for ${scene.id}`)
  const work = makeWorkDir()
  try {
    const ext = path.extname(photo.file).toLowerCase()
    const bg = `bg${ext}`
    fs.copyFileSync(path.join(kit.dir, photo.file), path.join(work, bg))
    fs.writeFileSync(path.join(work, 'banner.typ'), bannerTypst(kit, size, photo, words, bg), { mode: 0o600 })
    const fonts = path.join(kit.dir, 'fonts')
    const hasFonts = fs.existsSync(fonts)
    const r = await runIsolated({
      cmd: typst,
      args: ['compile', ...(hasFonts ? ['--font-path', fonts] : []), '--root', work, '--format', 'png', '--ppi', '72', 'banner.typ', 'banner.png'],
      workDir: work, readPaths: hasFonts ? [fs.realpathSync(fonts)] : [], timeoutMs: BANNER_TIMEOUT_MS, maxRssMiB: 1024,
      maxWorkBytes: dirBytes(work) + PNG_MAX,
    })
    if (r.code !== 0) throw new BannerError(`the banner could not be drawn (${r.stderr.split(work).join('.').split('\n').filter((l) => /error/i.test(l)).slice(0, 2).join(' ').slice(0, 300) || r.killed || 'unknown error'})`)
    const got = readOutput(work, 'banner.png', PNG_MAX)
    if (!got.ok) throw new BannerError('the banner maker produced no picture')
    return Buffer.from(got.bytes)
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
}
