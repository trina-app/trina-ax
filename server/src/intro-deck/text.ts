// Setting the intro deck's type (docs/DECISIONS.md "D2"): the roles and their sizes, and lines broken once here, never
// by a viewer. A line breaks only at a space (keep-all) in Hangul and Latin, and between any two characters in
// Japanese and Chinese, which use no spaces (never before a closing mark or a small kana, never after an opening
// bracket: kinsoku). Lines are balanced (no orphan word), and every line is
// measured with the bundled Pretendard's widths (promo-video/metrics.ts) and must fit its box with 10 % to spare, so it
// still fits on one line when PowerPoint, Keynote or Google Slides set it in a substitute font (Noto Sans KR's Hangul
// is 6.5 % wider). A text too long steps down one size at most, then it is a problem for the AI.
import { textWidth } from '../promo-video/metrics'

export type Weight = 400 | 700 | 800
export interface Role { size: number; min: number; weight: Weight; tracking: number; lh: number }

/** The type scale at 1920 × 1080 (1 px = 0.5 pt in the PowerPoint file). */
export const ROLES = {
  display: { size: 112, min: 96, weight: 800, tracking: -0.035, lh: 1.12 },
  statement: { size: 72, min: 64, weight: 700, tracking: -0.03, lh: 1.3 },
  closing: { size: 88, min: 76, weight: 800, tracking: -0.035, lh: 1.16 },
  title: { size: 64, min: 56, weight: 700, tracking: -0.025, lh: 1.22 },
  quote: { size: 52, min: 46, weight: 700, tracking: -0.025, lh: 1.42 },
  head: { size: 40, min: 36, weight: 700, tracking: -0.02, lh: 1.3 },
  body: { size: 32, min: 28, weight: 400, tracking: -0.01, lh: 1.55 },
  label: { size: 24, min: 24, weight: 700, tracking: 0.12, lh: 1.3 },
  small: { size: 24, min: 24, weight: 400, tracking: 0, lh: 1.45 },
  footer: { size: 22, min: 22, weight: 700, tracking: 0.04, lh: 1.3 },
} satisfies Record<string, Role>
export type RoleName = keyof typeof ROLES

/** room kept in every line for a wider substitute font */
export const SLACK = 1.1

const hasLatinOnly = (s: string) => !/[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(s)
/** Labels and eyebrows in Latin script are set in capitals; Hangul has none. */
export const labelCase = (s: string) => (hasLatinOnly(s) ? s.toUpperCase() : s)

export const width = (s: string, size: number, weight: Weight, tracking: number) => textWidth(s, size, weight, tracking)

/** "*key phrase* rest" → the plain text and, per character, whether it is the accent; whitespace made single. */
export function marked(raw: string): { text: string; accent: boolean[] } {
  const src = raw.replace(/\r/g, '')
  let text = '', on = false
  const accent: boolean[] = []
  for (const ch of src) {
    if (ch === '*') { on = !on; continue }
    text += ch
    accent.push(on)
  }
  return { text, accent }
}

/** A unit a line may break before: a word (Hangul, Latin), or one Japanese or Chinese character with the marks that
 * cling to it. `glue`: no space before it (a break there adds nothing, and joining adds no space). */
interface Tok { s: string; glue: boolean }
/** Han, kana and the CJK marks: lines may break between any two of them. */
export const isCjk = (ch: string) => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u3000-\u303f\uff01-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65]/u.test(ch)
/** may not start a line (closing marks, small kana, the prolonged sound mark, iteration marks) */
const NO_START = new Set([...'、。，．・：；？！ー－～）」』】〕〉》〙〗’”ぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶ々ゝゞヽヾ,.!?:;)]}%'])
/** may not end a line (opening brackets) */
const NO_END = new Set([...'（「『【〔〈《〘〖‘“([{'])
const join = (ts: readonly Tok[]) => ts.map((t, i) => (i > 0 && !t.glue ? ' ' : '') + t.s).join('')

/** The fewest lines of `p` that keep every line within `max` (null: one word is wider than `max`, or the text needs
 * more than `limit` lines: it stops there, so a long Japanese or Chinese text costs no more than a short one). */
function greedy(ws: Tok[], max: number, w: (s: string) => number, limit = Infinity): Tok[][] | null {
  const out: Tok[][] = []
  let cur: Tok[] = []
  for (const word of ws) {
    if (w(word.s) > max) return null
    const next = [...cur, word]
    if (!cur.length || w(join(next)) <= max) cur = next
    else { out.push(cur); if (out.length >= limit) return null; cur = [word] }
  }
  if (cur.length) out.push(cur)
  return out
}

/** A break between two Japanese or Chinese units that likely falls inside a word: not after a mark, and not after
 * hiragana before something else (a particle ends a phrase: "オフィスの|植物"). */
function midWord(a: Tok, b: Tok): boolean {
  if (!b.glue) return false
  const x = [...a.s].at(-1)!, y = [...b.s][0]!
  if (/[\u3000-\u303f\uff01-\uff0f\uff1a-\uff20]/u.test(x)) return false
  return !(/\p{Script=Hiragana}/u.test(x) && !/\p{Script=Hiragana}/u.test(y))
}
const midBreaks = (lines: Tok[][]) => lines.slice(1).filter((l, k) => midWord(lines[k]!.at(-1)!, l[0]!)).length

/** The same number of lines, broken where the longest line is shortest (balanced, so no line ends with one short
 * word alone), each still within `max`. */
function balance(ws: Tok[], n: number, max: number, w: (s: string) => number): Tok[][] {
  const len = ws.length
  if (n <= 1 || len <= n) return n <= 1 ? [ws] : ws.map((x) => [x])
  // a break that leaves a one-character word at a line's start or end ("결정할 / 수 있게") reads badly: it counts as
  // a little longer, so another break of nearly the same length wins (Japanese and Chinese characters are units, not
  // words: no such cost)
  const lone = (t: Tok) => [...t.s].length === 1 && !isCjk(t.s)
  const unit = w(String.fromCharCode(0xac00))
  // Japanese and Chinese: a break inside a word ("植|物", "メンテナン|ス") costs a little, so a break after a mark or a
  // particle (after hiragana, before a character that is not) wins when one is nearly as balanced
  const inWord = (j: number) => j > 0 && j < len && midWord(ws[j - 1]!, ws[j]!)
  const lineW = (i: number, j: number) => w(join(ws.slice(i, j))) + ((j - i > 1 && (lone(ws[i]!) || lone(ws[j - 1]!))) ? unit * 2.5 : 0)
  // best[k][i]: the smallest widest line setting words i.. in k lines
  // the score of a way to break: the widest line, plus a cost for every break inside a Japanese or Chinese word
  const PEN = unit * 3
  const memo = new Map<string, { worst: number; pen: number; cut: number }>()
  const solve = (k: number, i: number): { worst: number; pen: number; cut: number } => {
    const key = `${k}:${i}`
    const hit = memo.get(key)
    if (hit) return hit
    let best = { worst: Infinity, pen: 0, cut: len }
    if (k === 1) best = { worst: lineW(i, len), pen: 0, cut: len }
    else {
      for (let j = i + 1; j <= len - (k - 1); j++) {
        if (w(join(ws.slice(i, j))) > max) break
        const first = lineW(i, j)
        const rest = solve(k - 1, j)
        const worst = Math.max(first, rest.worst), pen = rest.pen + (inWord(j) ? 1 : 0)
        const score = worst + pen * PEN, bestScore = best.worst + best.pen * PEN
        // ties: the earlier lines longer (a heavier top reads better)
        if (score < bestScore - 0.01 || (Math.abs(score - bestScore) <= 0.01 && j > best.cut)) best = { worst, pen, cut: j }
      }
    }
    memo.set(key, best)
    return best
  }
  const out: Tok[][] = []
  let i = 0
  for (let k = n; k >= 1; k--) {
    const cut = k === 1 ? len : solve(k, i).cut
    out.push(ws.slice(i, cut))
    i = cut
  }
  return out.filter((l) => l.length)
}

export interface Run { text: string; accent: boolean }
export interface Fitted { size: number; lines: Run[][]; widths: number[] }

/** Break `raw` (paragraphs by "\n", *stars* for the accent) into at most `maxLines` lines of `boxW` px at the role's
 * size, else one size down; null when it does not fit even then. `balanced` (default): lines of even length. */
export function fitText(raw: string, role: Role, boxW: number, maxLines: number, o: { balanced?: boolean; notch?: boolean; size?: number } = {}): Fitted | null {
  const { text, accent } = marked(raw)
  // words (or Japanese and Chinese characters) with their accent masks, per paragraph
  type W = { s: string; m: boolean[]; glue: boolean }
  const paras: W[][] = [[]]
  let cur: W | null = null
  let spaced = true
  ;[...text].forEach((ch, i) => {
    if (ch === '\n') { cur = null; spaced = true; paras.push([]); return }
    if (/\s/.test(ch)) { cur = null; spaced = true; return }
    const last = cur ? [...cur.s].at(-1)! : ''
    // a new unit: after a space, before a CJK character (unless it clings to the one before), or after a CJK
    // character (unless that one opens a bracket or this one may not start a line)
    const fresh = !cur || (!NO_START.has(ch) && !NO_END.has(last) && (isCjk(ch) || isCjk(last)))
    if (fresh) { cur = { s: '', m: [], glue: !spaced && !!cur }; paras[paras.length - 1]!.push(cur) }
    spaced = false
    cur!.s += ch
    cur!.m.push(accent[i] ?? false)
  })
  const ps = paras.filter((p) => p.length)
  if (!ps.length) return null
  const sizes = o.size ? [o.size] : o.notch === false ? [role.size] : [role.size, role.min].filter((v, i, a) => a.indexOf(v) === i)
  for (const size of sizes) {
    const w = (str: string) => width(str, size, role.weight, role.tracking)
    const max = boxW / SLACK
    const lines: W[][] = []
    let ok = true
    for (const [pi, p] of ps.entries()) {
      const ws: Tok[] = p.map((x) => ({ s: x.s, glue: x.glue }))
      const g = greedy(ws, max, w, Math.max(1, maxLines - lines.length - (ps.length - pi - 1)))
      if (!g) { ok = false; break }
      const bal = o.balanced !== false ? balance(ws, g.length, max, w) : g
      // balanced lines only when every one of them still fits (else the plain fill)
      let shaped = bal.length === g.length && bal.every((l) => w(join(l)) <= max) ? bal : g
      // Japanese and Chinese: one more line when the budget allows it and it breaks inside fewer words
      const room = maxLines - lines.length - (ps.length - pi - 1)
      if (midBreaks(shaped) > 0 && shaped.length < room) {
        const more = balance(ws, shaped.length + 1, max, w)
        if (more.length === shaped.length + 1 && more.every((l) => w(join(l)) <= max) && midBreaks(more) < midBreaks(shaped)) shaped = more
      }
      let k = 0
      for (const line of shaped) { lines.push(p.slice(k, k + line.length)); k += line.length }
    }
    if (!ok || lines.length > maxLines) continue
    const runs = lines.map((ws) => {
      const out: Run[] = []
      const push = (t: string, a: boolean) => {
        const last = out[out.length - 1]
        if (last && last.accent === a) last.text += t
        else out.push({ text: t, accent: a })
      }
      ws.forEach((word, wi) => {
        if (wi > 0 && !word.glue) push(' ', !!(ws[wi - 1]!.m.at(-1) && word.m[0]))
        ;[...word.s].forEach((ch, ci) => push(ch, word.m[ci]!))
      })
      return out
    })
    return { size, lines: runs, widths: lines.map((ws) => w(join(ws))) }
  }
  return null
}

/** About how many Korean characters a line of `boxW` holds at a role's smallest size (for the problems' wording). */
export function perLine(role: Role, boxW: number): number {
  return Math.max(1, Math.floor(boxW / SLACK / ((0.864 + role.tracking) * role.min)))
}

/** CSS half-leading: the baseline's distance from the top of a line box of height `lh` (Pretendard: ascent 0.952 em,
 * descent 0.241 em). */
export const baselineIn = (size: number, lh: number) => (lh - 1.193 * size) / 2 + 0.952 * size
