// The promo video's beats, timing and sizes (docs/DECISIONS.md "V"): five beats on a 120 BPM grid (one beat 0.5 s,
// each scene ~3.5 s, the end card held), the checked document the template is built from, and the measuring that
// decides every type size from the bundled font's real advance widths (metrics.ts). A line that does not fit even at
// the smallest size is a problem the server sends back to the AI (spec.ts), never a clipped frame.
import { fitSize, textWidth, wrapLines, type Weight } from './metrics'
import type { Family } from './palette'

export const PROMO_W = 1080
export const PROMO_H = 1350
export const BEAT = 0.5
/** scene starts on the grid; each scene runs past the next start by its seam */
export const STARTS = [0, 3.5, 7.0, 10.5, 14.0] as const
export const DURATION = 18.5
export type Seam = 'zoom' | 'push' | 'blur'
export const SEAMS: Seam[] = ['zoom', 'push', 'blur', 'zoom']
export const SEAM_LEN: Record<Seam, number> = { zoom: 0.4, push: 0.5, blur: 0.6 }
/** The end card's last motion ends by then; it holds from there to the end (at least 2 s). */
export const END_SETTLED = STARTS[4] + 2.4
/** When each beat has settled (the reduced-motion stills show these moments). */
export const SETTLED = [3.2, 6.9, 10.3, 13.8, 18.4]

export interface Pic { src: string; width: number; height: number; focus: string }
export interface LogoPic extends Pic { treat: 'direct' | 'white' | 'chip' | 'tile' }
export interface Stat { number: string; label: string }
export interface VideoDoc {
  family: Family
  lang: string
  company: string
  website: string | null
  brand: string | null
  logo: LogoPic | null
  music: 'bright' | 'calm' | 'pulse'
  hook: { label: string; before: string; after: string; line: string; mode: 'strike' | 'swap' }
  promise: { headline: string[]; sub: string; picture: Pic | null }
  work: { kicker: string; headline: string[]; points: string[]; picture: Pic | null }
  proof: { stats: Stat[]; headline: string[]; sub: string; picture: Pic | null }
  cta: { line: string; offer: string }
}

// ── type ───────────────────────────────────────────────────────────────────────────────────────────────────────
export const X = 84
export const W = 912
export const hasHangul = (s: string) => /[ㄱ-ㆎ가-힣]/.test(s)
/** "*팀 전체*가 씁니다" → segments; the starred part is the accent (one per line at most) */
export function segments(line: string): { text: string; accent: boolean }[] {
  const out: { text: string; accent: boolean }[] = []
  const re = /\*([^*]+)\*/g
  let at = 0, m: RegExpExecArray | null
  while ((m = re.exec(line))) {
    if (m.index > at) out.push({ text: line.slice(at, m.index), accent: false })
    out.push({ text: m[1]!, accent: true })
    at = m.index + m[0].length
  }
  if (at < line.length) out.push({ text: line.slice(at), accent: false })
  return out.filter((s) => s.text)
}
export const plain = (line: string) => line.replace(/\*/g, '')

/** a stat as written: "+300%" → prefix "+", digits "300", unit "%" */
export function splitNumber(n: string): { pre: string; digits: string; unit: string } {
  const m = n.normalize('NFKC').match(/^(\D*?)(\d[\d.,]*\d|\d)(.*)$/)
  if (!m) return { pre: '', digits: '', unit: n }
  return { pre: m[1]!.trim(), digits: m[2]!, unit: m[3]!.trim() }
}
export const AFFIX = 0.6
function numberWidth(n: string, size: number): number {
  const p = splitNumber(n)
  return textWidth(p.digits, size, 900, -0.045) + textWidth(p.pre + p.unit, size * AFFIX, 800, -0.03) + (p.unit ? size * 0.04 : 0)
}
function fitNumber(n: string, width: number, max: number, min: number): number | null {
  const w1 = numberWidth(n, 1)
  const s = Math.min(max, Math.floor(width / Math.max(w1, 0.001)))
  return s >= min ? s : null
}

export interface Sizes {
  hook: { label: number; before: number; after: number; line: number; top: { label: number; before: number; after: number; line: number } }
  promise: { headline: number; sub: string[] }
  work: { headline: number; points: number }
  proof: { stats: number[]; label: number; headline: number; sub: string[] }
  cta: { name: number; line: number; offer: number }
}

/** Every size of the video, or the problems that keep a line from fitting (in the AI's own terms). */
export function fitDoc(doc: VideoDoc): { sizes: Sizes | null; problems: string[] } {
  const p: string[] = []
  const tooWide = (where: string, text: string, perLine: number) => p.push(`${where}: "${plain(text)}" is too wide; keep it to about ${perLine} Korean characters or ${Math.round(perLine * 1.7)} Latin letters`)
  const one = (where: string, text: string, w: Weight, tracking: number, max: number, min: number, width = W): number => {
    if (!text) return max
    const s = fitSize([plain(text)], width, w, tracking, max, min)
    if (s === null) { tooWide(where, text, Math.floor(width / (min * (0.864 + tracking)))); return min }
    return s
  }
  const lines = (where: string, ls: string[], w: Weight, tracking: number, max: number, min: number): number => {
    const s = fitSize(ls.map(plain), W, w, tracking, max, min)
    if (s === null) {
      const worst = [...ls].sort((a, b) => textWidth(plain(b), 1, w) - textWidth(plain(a), 1, w))[0]!
      tooWide(`${where} line`, worst, Math.floor(W / (min * (0.864 + tracking))))
      return min
    }
    return s
  }
  const sub = (where: string, text: string, size: number, maxLines = 2): string[] => {
    if (!text) return []
    const r = wrapLines(text, W, size, 500, -0.01)
    if (!r || r.length > maxLines) { p.push(`${where}: the sentence is too long; it must fit ${maxLines} line${maxLines > 1 ? 's' : ''} of about ${Math.floor(W / (size * 0.874))} Korean characters`); return [] }
    return r
  }
  const h = doc.hook
  const label = one('hook.label', h.label, 600, -0.02, 52, 40)
  let before = one('hook.before', h.before, 900, -0.045, 250, 110)
  let after = one('hook.after', h.after, 900, -0.045, h.mode === 'strike' ? 330 : 250, 110)
  if (h.mode === 'swap') before = after = Math.min(before, after)
  const lineSize = one('hook.line', h.line, 500, 0, 34, 28)
  // the block is centred a little above the middle (the after state decides its height)
  const height = h.mode === 'strike' ? 52 + 130 - 40 + before * 0.5 + 52 + after * 1.02 + 56 + 40 : 52 + 130 + before * 1.08 + 64 + 40
  const L = Math.round(Math.min(460, Math.max(260, 640 - height / 2 + 52)))
  const top = { label: L, before: L + 130, after: 0, line: 0 }
  if (h.mode === 'strike') {
    top.after = Math.round(top.before - 40 + before * 0.5 + 52)
    top.line = Math.round(top.after + after * 1.02 + 56)
  } else {
    top.after = top.before
    top.line = Math.round(top.before + before * 1.08 + 64)
  }
  if (top.line > 1060) p.push('hook: the swapped words are too big together; make hook.after shorter')

  const pr = doc.promise
  if (pr.headline.length < 1 || pr.headline.length > 2) p.push('promise.headline: one or two lines')
  const prSize = lines('promise.headline', pr.headline, 800, -0.04, pr.picture ? 104 : 116, 68)
  const prSub = sub('promise.sub', pr.sub, 36)

  const wk = doc.work
  const wkSize = lines('work.headline', wk.headline, 800, -0.04, wk.picture ? 76 : 100, 56)
  one('work.kicker', wk.kicker, 700, 0.12, 26, 22, 760)
  const ptSize = wk.picture ? 30 : 48
  for (const [i, pt] of wk.points.entries()) one(`work.points[${i}]`, pt, 700, -0.01, ptSize, ptSize - 4, wk.picture ? 400 : W - 80)

  const pf = doc.proof
  const statSizes = pf.stats.map((s, i) => {
    const n = fitNumber(s.number, W, pf.stats.length > 1 ? 300 : 320, 140)
    if (n === null) { p.push(`proof.stats[${i}].number "${s.number}" is too long to show large; give only the number and its unit`); return 140 }
    return n
  })
  const statLabel = Math.min(...pf.stats.map((s, i) => one(`proof.stats[${i}].label`, s.label, 600, -0.02, 46, 34)), 46)
  const pfHead = pf.headline.length ? lines('proof.headline', pf.headline, 900, -0.045, pf.stats.length ? 64 : 124, pf.stats.length ? 48 : 76) : 0
  const pfSub = sub('proof.sub', pf.sub, 36, pf.stats.length ? 1 : 2)

  const name = doc.logo && doc.logo.width / Math.max(1, doc.logo.height) > 2.2 ? 0 : one('company', doc.company, 800, -0.04, doc.logo ? 128 : 156, 56)
  const ctaLine = one('cta.line', doc.cta.line, 600, -0.02, 46, 34)
  const offer = doc.cta.offer ? one('cta.offer', doc.cta.offer, 700, -0.01, 40, 32, 700) : 0
  if (p.length) return { sizes: null, problems: [...new Set(p)] }
  return {
    sizes: {
      hook: { label, before, after, line: lineSize, top },
      promise: { headline: prSize, sub: prSub },
      work: { headline: wkSize, points: ptSize },
      proof: { stats: statSizes, label: statLabel, headline: pfHead, sub: pfSub },
      cta: { name, line: ctaLine, offer },
    },
    problems: [],
  }
}

