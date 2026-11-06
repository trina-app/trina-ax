// Pictures of the intro deck's slides on the server (docs/DECISIONS.md "D2", round 2): typst, run exactly as for the
// PDF (files.ts: in its isolation, in a work folder of its own, with the bundled Pretendard and nothing outside the
// folder readable), writes PNG pages instead of a PDF. Used for the review (review.ts: every slide, and the same slide
// with its text removed — the ground under the type), the build's thumbnails, the AI accent as a picture for the
// PowerPoint file, and tiny decodes of the brand pictures (any format typst reads: JPEG, PNG, GIF, WebP) for the
// theme's choice (pictureStats: Ink when the chosen pictures are mostly dark) and the Paper accent (accentFromPictures:
// k-means when the brand colour has no hue; DESIGN §4).
// Where typst or the fonts are missing every function answers null and the caller goes on without pictures.
import fs from 'node:fs'
import path from 'node:path'
import { bundledFontDir, which } from '../config'
import type { Logger } from '../log'
import { typstJobs } from '../system/limits'
import { makeWorkDir, readOutput, runIsolated } from '../tools/isolate'
import { imageSize } from '../uploads/image'
import { pretendardDir } from './files'
import type { DeckLook } from './theme'
import { SLIDE_H, SLIDE_W, type DeckOut, type SlideOut } from './layout'
import { decodePng, type Rgba } from './png'
import { extOf } from './pptx'
import { buildTypst, type TypstOptions } from './typst'

/** the typst binary (as files.ts finds it: MYCEL_TYPST_BIN, else on the PATH) */
const typstBin = () => { const p = process.env.MYCEL_TYPST_BIN ?? which('typst'); return p && fs.existsSync(p) ? p : null }
/** Can this server draw slide pictures? (typst and the bundled Pretendard, as for the PDF) */
export const renderAvailable = () => !!typstBin() && !!pretendardDir()

/** One typst run to PNG pages: `source` and its files in a fresh work folder, `pages` pages read back in order (null:
 * no typst, no fonts, a failed compile or a page missing). */
async function typstPngs(source: string, files: [string, Uint8Array][], pages: number, o: { ppi: number; what: string; log?: Pick<Logger, 'warn'> }): Promise<Uint8Array[] | null> {
  const typst = typstBin(), fonts = pretendardDir()
  if (!typst || !fonts || pages < 1) return null
  const work = makeWorkDir()
  try {
    for (const [name, bytes] of files) fs.writeFileSync(path.join(work, name), bytes, { flag: 'wx', mode: 0o600 })
    fs.writeFileSync(path.join(work, 'main.typ'), source, { flag: 'wx', mode: 0o600 })
    const extra = bundledFontDir()
    const fontArgs = ['--font-path', fonts, ...(extra && extra !== fonts ? ['--font-path', extra] : [])]
    const jobs = typstJobs()
    const res = await runIsolated({
      cmd: typst,
      args: ['compile', ...(jobs ? ['--jobs', String(jobs)] : []), ...fontArgs, '--root', work, '--format', 'png', '--ppi', String(o.ppi), 'main.typ', 'out-{p}.png'],
      workDir: work, readPaths: [fonts, ...(extra && extra !== fonts ? [extra] : [])], timeoutMs: 60_000,
    })
    if (res.code !== 0) { o.log?.warn(`intro deck ${o.what} render failed`, { code: res.code, killed: res.killed, stderr: res.stderr.slice(-1500) }); return null }
    const out: Uint8Array[] = []
    for (let p = 1; p <= pages; p++) {
      const r = readOutput(work, `out-${p}.png`, 64 * 1024 * 1024)
      if (!r.ok) { o.log?.warn(`intro deck ${o.what} render: a page is missing`, { page: p, why: r.why }); return null }
      out.push(new Uint8Array(r.bytes))
    }
    return out
  } catch (err) {
    o.log?.warn(`intro deck ${o.what} render failed`, { err: String(err) })
    return null
  } finally { fs.rmSync(work, { recursive: true, force: true }) }
}

export interface RenderOptions extends TypstOptions {
  /** pixels per inch: 72 (the default) gives 960 × 540 per slide, 144 gives 1920 × 1080 */
  ppi?: number
  /** also every slide without its text items (the ground under the type, for the review) */
  ground?: boolean
  /** the deck's look, when the typst source needs it */
  look?: DeckLook
  log?: Pick<Logger, 'warn'>
}

/** The slides as PNG pictures from one typst run (the same source as the PDF), and with `ground` the same slides with
 * every text item left out. `ms`: the whole run. Null where typst or the fonts are missing, or the compile failed. */
export async function renderSlidePngs(slides: SlideOut[], o: RenderOptions): Promise<{ full: Uint8Array[]; ground: Uint8Array[] | null; ms: number } | null> {
  if (!slides.length || !renderAvailable()) return null
  const started = performance.now()
  const pages = o.ground ? [...slides, ...slides.map((s) => ({ ...s, items: s.items.filter((it) => it.t !== 'text') }))] : slides
  const { ppi, ground, look, log, ...typst } = o
  const deck: DeckOut = { look: look as DeckLook, slides: pages, problems: [], typeOnly: [] }
  let t: { source: string; files: [string, Uint8Array][] }
  try { t = buildTypst(deck, typst) } catch (err) { log?.warn('intro deck slide render: no typst source', { err: String(err) }); return null }
  const pngs = await typstPngs(t.source, t.files, pages.length, { ppi: ppi ?? 72, what: 'slide', log })
  if (!pngs) return null
  return { full: pngs.slice(0, slides.length), ground: ground ? pngs.slice(slides.length) : null, ms: Math.round(performance.now() - started) }
}

/** An SVG (the AI accent, already sanitized and coloured) as a `px` × `px` PNG with a transparent ground, kept square
 * and centred as in the slide (for the PowerPoint file). */
export async function rasterizeSvg(svg: string, px: number, o: { log?: Pick<Logger, 'warn'> } = {}): Promise<Uint8Array | null> {
  const n = Math.max(1, Math.min(4096, Math.round(px)))
  const source = `#set page(width: ${n}pt, height: ${n}pt, margin: 0pt, fill: none)\n#image("accent.svg", width: 100%, height: 100%, fit: "contain")\n`
  const out = await typstPngs(source, [['accent.svg', new TextEncoder().encode(svg)]], 1, { ppi: 72, what: 'accent', log: o.log })
  return out?.[0] ?? null
}

/** Tiny RGBA decodes of pictures (about n × n pixels, the aspect kept: every picture weighs the same in the stats) from
 * one typst run, one page per picture. A picture typst cannot read (or no typst) is null; when the batch fails the
 * pictures are tried one by one. */
export async function samplePictures(list: Uint8Array[], n = 48, o: { log?: Pick<Logger, 'warn'> } = {}): Promise<(Rgba | null)[]> {
  const out: (Rgba | null)[] = list.map(() => null)
  if (!renderAvailable()) return out
  const jobs = list.map((bytes, i) => {
    const ext = extOf(bytes)
    if (!ext) return null
    const size = imageSize(bytes)
    const r = size && size.width > 0 && size.height > 0 ? Math.min(8, Math.max(1 / 8, size.width / size.height)) : 1
    return { i, bytes, name: `p${i + 1}.${ext === 'jpeg' ? 'jpg' : ext}`, w: Math.max(4, Math.round(n * Math.sqrt(r))), h: Math.max(4, Math.round(n / Math.sqrt(r))) }
  }).filter((j): j is NonNullable<typeof j> => !!j)
  const run = async (js: typeof jobs) => {
    const source = '#set page(margin: 0pt, fill: none)\n' + js.map((j) => `#page(width: ${j.w}pt, height: ${j.h}pt)[#image("${j.name}", width: 100%, height: 100%, fit: "stretch")]`).join('\n') + '\n'
    return typstPngs(source, js.map((j) => [j.name, j.bytes]), js.length, { ppi: 72, what: 'picture sample', log: o.log })
  }
  if (!jobs.length) return out
  const all = await run(jobs)
  if (all) { all.forEach((png, k) => { out[jobs[k]!.i] = decodePng(png) }); return out }
  if (jobs.length > 1) for (const j of jobs) { const one = await run([j]); out[j.i] = one ? decodePng(one[0]!) : null }
  return out
}

/** One picture's tiny decode (samplePictures with one picture). */
export async function samplePicture(bytes: Uint8Array, n = 48, o: { log?: Pick<Logger, 'warn'> } = {}): Promise<Rgba | null> {
  return (await samplePictures([bytes], n, o))[0] ?? null
}

// ── picture statistics ─────────────────────────────────────────────────────────────────────────────────────────
const LIN = new Float64Array(256)
for (let i = 0; i < 256; i++) { const v = i / 255; LIN[i] = v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
const toLab = (r: number, g: number, b: number): [number, number, number] => {
  const R = LIN[r]!, G = LIN[g]!, B = LIN[b]!
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B)
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B)
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B)
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s]
}
const fromLab = (L: number, a: number, b: number): [number, number, number] => {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3, s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  const lin = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s]
  return lin.map((v) => { const c = Math.min(1, Math.max(0, v)); return Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)) }) as [number, number, number]
}
/** pixels that count (alpha ≥ 128: a cut-out's transparent surround is not part of the picture) */
const OPAQUE = 128

/** The ink theme takes deep brand colours when the chosen pictures are mostly dark: their mean luminance below this. */
export const DARK_PICTURES = 0.22

/** A picture's mean WCAG relative luminance (0 black – 1 white) over its opaque pixels (0 when none). */
export function pictureStats(img: Rgba): { luminance: number } {
  const d = img.data
  let sum = 0, n = 0
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3]! < OPAQUE) continue
    sum += 0.2126 * LIN[d[i]!]! + 0.7152 * LIN[d[i + 1]!]! + 0.0722 * LIN[d[i + 2]!]!
    n++
  }
  return { luminance: n ? sum / n : 0 }
}

/** The chroma accentFromPictures asks for: HSV/HSL chroma, max(r, g, b) − min(r, g, b) of the sRGB colour, 0 (grey) – 1.
 * 0.12 is about a 31/255 spread between the strongest and the weakest channel: beige, greige and blue-grey stay under. */
export const ACCENT_CHROMA = 0.12
export const chromaOf = (r: number, g: number, b: number) => (Math.max(r, g, b) - Math.min(r, g, b)) / 255

/** The Paper theme's accent when the brand colour has no hue (DESIGN §4): k-means (k = 5) over the opaque pixels of the
 * brand pictures in OKLab, seeded deterministically (the most common colour, then each next seed the common colour
 * farthest from the seeds so far: a colour holds a seed only when it covers ≥ 0.5 % of the pixels, so a stray pixel
 * never takes one); the cluster with the largest share × chroma (chromaOf) wins, as "#rrggbb" (the caller darkens it
 * to 4.5:1). Null when no cluster reaches ACCENT_CHROMA (the deck stays monochrome) or there are no pixels. */
export function accentFromPictures(list: Rgba[], k = 5): string | null {
  const px: number[] = []
  for (const img of list) {
    const d = img.data
    for (let i = 0; i < d.length; i += 4) if (d[i + 3]! >= OPAQUE) px.push(d[i]!, d[i + 1]!, d[i + 2]!)
  }
  const n = px.length / 3
  if (!n) return null
  const lab = new Float64Array(n * 3)
  for (let i = 0; i < n; i++) lab.set(toLab(px[i * 3]!, px[i * 3 + 1]!, px[i * 3 + 2]!), i * 3)
  // seeds: colours binned 4 bits per channel, the bins that cover ≥ 0.5 % of the pixels, by count
  const bins = new Map<number, { n: number; s: [number, number, number] }>()
  for (let i = 0; i < n; i++) {
    const key = ((px[i * 3]! >> 4) << 8) | ((px[i * 3 + 1]! >> 4) << 4) | (px[i * 3 + 2]! >> 4)
    const b = bins.get(key) ?? { n: 0, s: [0, 0, 0] }
    b.n++; b.s[0] += lab[i * 3]!; b.s[1] += lab[i * 3 + 1]!; b.s[2] += lab[i * 3 + 2]!
    bins.set(key, b)
  }
  const common = [...bins.entries()].filter(([, b]) => b.n >= Math.max(1, n * 0.005)).sort((a, b) => b[1].n - a[1].n || a[0] - b[0]).map(([, b]) => b.s.map((v) => v / b.n) as [number, number, number])
  const d2 = (c: ArrayLike<number>, j: number) => (c[0]! - lab[j * 3]!) ** 2 + (c[1]! - lab[j * 3 + 1]!) ** 2 + (c[2]! - lab[j * 3 + 2]!) ** 2
  const dist = (a: number[], b: number[]) => (a[0]! - b[0]!) ** 2 + (a[1]! - b[1]!) ** 2 + (a[2]! - b[2]!) ** 2
  const seeds: number[][] = [common[0] ?? [lab[0]!, lab[1]!, lab[2]!]]
  while (seeds.length < k && seeds.length < common.length) {
    let best = -1, far = 0
    common.forEach((c, j) => { const m = Math.min(...seeds.map((s) => dist(s, c))); if (m > far) { far = m; best = j } })
    if (best < 0 || far < 1e-6) break
    seeds.push([...common[best]!])
  }
  // Lloyd's iterations
  const K = seeds.length, assign = new Int32Array(n).fill(-1)
  const centres = seeds.map((s) => [...s])
  for (let it = 0; it < 40; it++) {
    let moved = 0
    for (let j = 0; j < n; j++) {
      let best = 0, bd = Infinity
      for (let c = 0; c < K; c++) { const v = d2(centres[c]!, j); if (v < bd) { bd = v; best = c } }
      if (assign[j] !== best) { assign[j] = best; moved++ }
    }
    const sum = centres.map(() => [0, 0, 0, 0])
    for (let j = 0; j < n; j++) { const s = sum[assign[j]!]!; s[0]! += lab[j * 3]!; s[1]! += lab[j * 3 + 1]!; s[2]! += lab[j * 3 + 2]!; s[3]!++ }
    sum.forEach((s, c) => { if (s[3]!) centres[c] = [s[0]! / s[3]!, s[1]! / s[3]!, s[2]! / s[3]!] })
    if (!moved) break
  }
  const count = new Array<number>(K).fill(0)
  for (let j = 0; j < n; j++) count[assign[j]!]!++
  let win: string | null = null, score = 0
  centres.forEach((c, i) => {
    const [r, g, b] = fromLab(c[0]!, c[1]!, c[2]!)
    const chroma = chromaOf(r, g, b)
    if (chroma < ACCENT_CHROMA || !count[i]) return
    const s = (count[i]! / n) * chroma
    if (s > score) { score = s; win = '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('') }
  })
  return win
}

/** The slide picture size at a ppi (the review and the thumbnails read 960 × 540 at 72). */
export const slidePx = (ppi = 72) => ({ width: Math.round((SLIDE_W / 2) * (ppi / 72)), height: Math.round((SLIDE_H / 2) * (ppi / 72)) })
