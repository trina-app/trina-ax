// What a confirm card shows before anyone opens 자세히 (docs/decisions/20261124-card-no-raw-payload.md). The owner: "코드를
// 보여주면 뭐 어케 하라는거냐". A detail is judged by its shape, for every card kind: raw JSON, code or markup folds, long prose
// shows its start. What a person needs in order to decide stays in view: the addresses in it and its long random-looking
// parts (they can carry data out).

/** prose longer than this shows its start, the rest one click away */
export const LONG_TEXT = 600
export const LONG_TEXT_SHOWN = 240
/** a field's value at most this long stays in view whatever it looks like (a short id, a date, a small list) */
const SHORT_VALUE = 200
const SUMMARY_VALUE = 80
const SUMMARY_ITEMS = 5

const parsed = (t: string): unknown => {
  if (!/^[{[]/.test(t)) return undefined
  try { return JSON.parse(t) } catch { return undefined }
}

/** raw JSON, markup, a script, or text dense with code's symbols */
export function isPayload(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  if (parsed(t) !== undefined) return true
  if (/^(?:<!doctype\b|<html\b|<\?xml\b|<svg\b|#!)/i.test(t)) return true
  if (t.length < 120) return false
  const head = t.slice(0, 4000)
  const symbols = (head.match(/[{}[\]<>=;$\\|]/g) ?? []).length
  return symbols / head.length >= 0.05
}

/** a list of plain strings (several recipients): read as it is, never folded */
const stringList = (t: string) => { const v = parsed(t.trim()); return Array.isArray(v) && v.every((x) => typeof x === 'string') }

/** Does a field's value fold? Never a short one or a list of names or addresses: those say who gets it. */
export const foldsField = (f: { value: string; code?: true }) => f.value.length > SHORT_VALUE && (!!f.code || (isPayload(f.value) && !stringList(f.value)))

/** The email addresses and web hosts in a payload, so where it goes is never only behind 자세히. (Bounded and anchored at
 * a word's start: linear on a payload of 100,000 characters.) */
export function payloadAddresses(text: string, known = ''): string[] {
  const found = new Set<string>()
  for (const m of text.matchAll(/(?<![\p{L}\p{N}._%+-])[\p{L}\p{N}._%+-]{1,64}@[\p{L}\p{N}-]{1,63}(?:\.[\p{L}\p{N}-]{1,63}){1,6}/gu)) found.add(m[0])
  for (const m of text.matchAll(/\bhttps?:\/\/([^\s/"'<>\\]{1,253})/gi)) found.add(m[1]!)
  return [...found].filter((a) => !known.includes(a))
}

/** One plain line for a JSON payload: its short top-level values ("subject: Hello · status: open"), or '' */
export function payloadSummary(text: string): string {
  const v = parsed(text.trim())
  if (!v || typeof v !== 'object' || Array.isArray(v)) return ''
  const out: string[] = []
  for (const [k, x] of Object.entries(v)) {
    if (out.length >= SUMMARY_ITEMS) break
    const s = typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean' ? String(x) : Array.isArray(x) && x.every((y) => typeof y === 'string') ? x.join(', ') : ''
    if (s && s.length <= SUMMARY_VALUE && !s.includes('\n')) out.push(`${k}: ${s}`)
  }
  return out.join(' · ')
}
