// Tokens in a plain text box: ranges of the text that stand out and act as one piece (an @mention in a room's message
// box; later a #room in the AI chat's box). Where an edit of the text happened, what it does to the ranges, where a caret
// may stand, and the text cut into plain parts and tokens. No React, no DOM: unit tested in test/unit/text-tokens.test.ts.
// The box that draws and guards them is components/TokenTextarea.tsx.

/** A range of the text, from `start` up to (not including) `end`. */
export interface TextRange {
  start: number
  end: number
}

/** One change of a text: `removed` characters from `from` gave way to `inserted` new ones. */
export interface TextEdit {
  from: number
  removed: number
  inserted: number
}

/** The selection just before a change (where typing, a paste or a deletion happens) and what the browser said it was
 * (InputEvent.inputType: 'deleteContentBackward', 'insertCompositionText', …), when known. */
export interface Before {
  start: number
  end: number
  inputType?: string
}

const commonPrefix = (a: string, b: string) => {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++
  return i
}
const commonSuffix = (a: string, b: string, max: number) => {
  let i = 0
  while (i < max && a.charCodeAt(a.length - 1 - i) === b.charCodeAt(b.length - 1 - i)) i++
  return i
}

/** Where `before` became `after`. A text with the same letter twice in a row can be explained more than one way ("aa"
 * → "a"); the selection before the change says which: what was selected gave way to what was typed or pasted; with no
 * selection, a deletion ends at the caret (Backspace) or starts there (Delete, or what inputType says). Anything else
 * (an IME changing the syllable it is writing, a spell fix) is the smallest change. */
export function findEdit(before: string, after: string, sel: Before | null): TextEdit {
  if (sel) {
    const s = Math.max(0, Math.min(sel.start, sel.end, before.length))
    const e = Math.min(Math.max(sel.start, sel.end), before.length)
    // what was selected (nothing, for a caret) gave way to what came
    const inserted = after.length - (before.length - (e - s))
    if (inserted >= 0 && after.startsWith(before.slice(0, s)) && after.endsWith(before.slice(e))) return { from: s, removed: e - s, inserted }
    const k = before.length - after.length
    if (s === e && k > 0) {
      const back = s - k >= 0 && after === before.slice(0, s - k) + before.slice(s)
      const fwd = s + k <= before.length && after === before.slice(0, s) + before.slice(s + k)
      const forward = /Forward$/.test(sel.inputType ?? '')
      if (back && !(forward && fwd)) return { from: s - k, removed: k, inserted: 0 }
      if (fwd) return { from: s, removed: k, inserted: 0 }
    }
  }
  const p = commonPrefix(before, after)
  const q = commonSuffix(before, after, Math.min(before.length, after.length) - p)
  return { from: p, removed: before.length - q - p, inserted: after.length - q - p }
}

/** The text after an edit, given what was inserted. */
export const applyEdit = (text: string, e: TextEdit, insert = '') => text.slice(0, e.from) + insert + text.slice(e.from + e.removed)

/** The ranges after an edit: those before it stay, those after it move with it, and those it touched are gone (typing
 * inside a token, or replacing a letter of it, makes it plain text). Typing right at a token's edge leaves it whole. */
export function shiftRanges<T extends TextRange>(ranges: readonly T[], e: TextEdit): T[] {
  const end = e.from + e.removed
  const d = e.inserted - e.removed
  const out: T[] = []
  for (const r of ranges) {
    if (r.end <= e.from) out.push(r)
    else if (r.start >= end) out.push(d ? { ...r, start: r.start + d, end: r.end + d } : r)
  }
  return out
}

/** A deletion with no selection that took only part of a token from one of its edges (a phone keyboard's Backspace,
 * which comes as an edit and not as a key) takes the whole token: the edit that does that, or null. */
export function wholeTokenEdit(tokens: readonly TextRange[], e: TextEdit, sel: Before | null): TextEdit | null {
  if (!sel || sel.start !== sel.end || e.inserted !== 0 || e.removed === 0) return null
  const caret = sel.start
  for (const t of tokens) {
    // backwards from its end
    if (t.end === caret && e.from + e.removed === caret && e.from > t.start && e.from < t.end) return { from: t.start, removed: caret - t.start, inserted: 0 }
    // forwards from its start
    if (t.start === caret && e.from === caret && caret + e.removed < t.end) return { from: caret, removed: t.end - caret, inserted: 0 }
  }
  return null
}

/** The token whose inside (not an edge) holds this caret position. */
export const tokenAround = <T extends TextRange>(tokens: readonly T[], pos: number) => tokens.find((t) => t.start < pos && pos < t.end)
/** The token that ends (Backspace takes it) or starts (Delete takes it) at this position. */
export const tokenEndingAt = <T extends TextRange>(tokens: readonly T[], pos: number) => tokens.find((t) => t.end === pos && t.end > t.start)
export const tokenStartingAt = <T extends TextRange>(tokens: readonly T[], pos: number) => tokens.find((t) => t.start === pos && t.end > t.start)

/** Where a caret that landed inside a token goes: the nearer edge (the end when it is in the middle). */
export function snapCaret(tokens: readonly TextRange[], pos: number): number {
  const t = tokenAround(tokens, pos)
  if (!t) return pos
  return pos - t.start < t.end - pos ? t.start : t.end
}

/** The text cut into plain parts and tokens, in order. Tokens are taken by start; one that overlaps an earlier one, or
 * reaches past the text, is left out. */
export function tokenParts<T extends TextRange>(text: string, tokens: readonly T[]): { text: string; token?: T }[] {
  const parts: { text: string; token?: T }[] = []
  let at = 0
  for (const t of [...tokens].sort((a, b) => a.start - b.start)) {
    if (t.start < at || t.end > text.length || t.end <= t.start) continue
    if (t.start > at) parts.push({ text: text.slice(at, t.start) })
    parts.push({ text: text.slice(t.start, t.end), token: t })
    at = t.end
  }
  if (at < text.length) parts.push({ text: text.slice(at) })
  return parts
}
