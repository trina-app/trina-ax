// What a confirm card shows before anyone opens 자세히 (docs/decisions/20261124-card-no-raw-payload.md). The owner: "코드를
// 보여주면 뭐 어케 하라는거냐". Only what is surely machine text folds: JSON, markup, a script. It folds only when its short
// values and every destination in it can stay in view as plain lines; when they cannot, the card shows it as before.

/** prose longer than this shows its start, unless a destination in it would go out of view */
export const LONG_TEXT = 600
export const LONG_TEXT_SHOWN = 240
/** a value at most this long is shown as a line: who gets it, a channel, a repo, a title */
const SHORT_VALUE = 120
/** more lines than this is not a summary: the payload stays as it was */
const MAX_LINES = 60

const parsed = (t: string): unknown => {
  if (!/^[{[]/.test(t)) return undefined
  try { return JSON.parse(t) } catch { return undefined }
}
const isStringList = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === 'string')

/** JSON (not a plain list of names), markup or a script. `cut`: only the start of a longer text is here, so JSON that no
 * longer parses still counts by its opening. */
export function isPayload(text: string, cut = false): boolean {
  const t = text.trim()
  if (!t) return false
  const v = parsed(t)
  if (v !== undefined) return !isStringList(v)
  if (cut && /^(?:\{\s*"|\[\s*\{)/.test(t)) return true
  return /^(?:<!doctype\b|<html\b|<\?xml\b|<svg\b|#!)/i.test(t)
}

/** Every email, address of any scheme, IP address and phone number in a text. Bounded and anchored: linear on 100,000 characters. */
export function destinations(text: string): string[] {
  const found = new Set<string>()
  for (const m of text.matchAll(/(?<![\p{L}\p{N}._%+-])[\p{L}\p{N}._%+-]{1,64}@[\p{L}\p{N}-]{1,63}(?:\.[\p{L}\p{N}-]{1,63}){1,6}/gu)) found.add(m[0])
  for (const m of text.matchAll(/(?<![a-z0-9+.-])[a-z][a-z0-9+.-]{1,20}:\/\/([^\s/"'<>\\]{1,253})/gi)) found.add(m[1]!)
  for (const m of text.matchAll(/(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?(?![\d.])/g)) found.add(m[0])
  for (const m of text.matchAll(/(?<![\d+-])\+?\d[\d -]{7,18}\d(?![\d-])/g)) found.add(m[0])
  return [...found]
}

/**
 * The plain lines that stay in view of a folded payload, or null when there are too many to be a summary. JSON is read by
 * its values (so an escaped address counts): each short value as "path: value", and any destination inside a long one.
 * `known`: values the card already shows on their own rows.
 */
export function payloadLines(text: string, known: readonly string[] = []): string[] | null {
  const have = new Set(known)
  const out = new Set<string>()
  const v = parsed(text.trim())
  if (v === undefined) { for (const d of destinations(text)) if (!have.has(d)) out.add(d) }
  else {
    const stack: [string, unknown][] = [['', v]]
    while (stack.length) {
      const [path, x] = stack.pop()!
      if (typeof x === 'string' || typeof x === 'number') {
        const s = String(x)
        if (!s.trim() || have.has(s)) continue
        if (s.length <= SHORT_VALUE && !s.includes('\n')) out.add(path ? `${path}: ${s}` : s)
        else for (const d of destinations(s)) if (!have.has(d)) out.add(path ? `${path}: ${d}` : d)
      } else if (Array.isArray(x)) { for (let i = x.length - 1; i >= 0; i--) stack.push([path ? `${path}.${i}` : String(i), x[i]]) }
      else if (x && typeof x === 'object') { const e = Object.entries(x); for (let i = e.length - 1; i >= 0; i--) stack.push([path ? `${path}.${e[i]![0]}` : e[i]![0], e[i]![1]]) }
      if (out.size > MAX_LINES) return null
    }
  }
  return out.size > MAX_LINES ? null : [...out]
}

/** Does a field's value fold? JSON or a script, long, whose short values and destinations can stay in view. A plain list
 * of names or numbers, in any form, never does: it says who gets it. */
export const foldsField = (f: { value: string; code?: true }) => f.value.length > 200 && (!!f.code || isPayload(f.value)) && payloadLines(f.value) !== null
