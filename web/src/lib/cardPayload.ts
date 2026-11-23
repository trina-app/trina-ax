// What a confirm card shows of a connected service's call before anyone opens 자세히 (docs/decisions/20261124-card-no-raw-
// payload.md). The owner: "코드를 보여주면 뭐 어케 하라는거냐". Only the JSON the server itself wrote for a call (`callJson`)
// folds, and only when it reads back into plain lines: every key and value, a long value by its start. A file's content,
// a scheduled task's instruction, a message or code that runs stay as sent.

/** a value longer than this shows its start (and any address found further on) */
const SHORT_VALUE = 120
const VALUE_START = 80
/** more lines than this is not a summary: the payload stays as it was */
const MAX_LINES = 60

const parsed = (t: string): unknown => {
  if (!/^[{[]/.test(t)) return undefined
  try { return JSON.parse(t) } catch { return undefined }
}
const isStringList = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === 'string')

/** Complete JSON that is not a plain list of names, written exactly as JSON.stringify writes it: the lines read from it
 * then say the same as the text (a number past double precision or a repeated key would not round-trip). */
export function isPayload(text: string): boolean {
  const t = text.trim()
  const v = parsed(t)
  return v !== undefined && !isStringList(v) && (t === JSON.stringify(v) || t === JSON.stringify(v, null, 2))
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
 * its parsed keys and values (so an escaped address counts): "path: value" for each, a long value by its start plus any
 * address further on. `known`: for text that is not JSON, destinations the card already shows on their own rows.
 */
export function payloadLines(text: string, known: readonly string[] = []): string[] | null {
  const have = new Set(known)
  const out = new Set<string>()
  const v = parsed(text.trim())
  if (v === undefined) { for (const d of destinations(text)) if (!have.has(d)) out.add(d) }
  else {
    const stack: [string, unknown][] = [['', v]]
    // (a key with a line break must not read as a line of its own)
    const line = (path: string, s: string) => out.add(path ? `${path.replace(/[\r\n\u2028\u2029]/g, ' ')}: ${s}` : s)
    while (stack.length) {
      const [path, x] = stack.pop()!
      if (typeof x === 'string') {
        if (!x.trim()) { line(path, JSON.stringify(x)); continue }
        if (x.length <= SHORT_VALUE && !x.includes('\n')) line(path, x)
        else {
          line(path, `${[...x.replace(/\s+/g, ' ').trim()].slice(0, VALUE_START).join('')}…`)
          for (const d of destinations(x)) line(path, d)
        }
      } else if (Array.isArray(x)) {
        if (!x.length) line(path, '[]')
        for (let i = x.length - 1; i >= 0; i--) stack.push([path ? `${path}.${i}` : String(i), x[i]])
      } else if (x && typeof x === 'object') {
        const e = Object.entries(x)
        if (!e.length) line(path, '{}')
        for (let i = e.length - 1; i >= 0; i--) stack.push([path ? `${path}.${e[i]![0]}` : e[i]![0], e[i]![1]])
      } else line(path, String(x))
      if (out.size > MAX_LINES) return null
    }
  }
  return out.size > MAX_LINES ? null : [...out]
}

/** Does a field's value fold? Long complete JSON that can be read back into lines. Anything else stays: it may say who gets it. */
export const foldsField = (f: { value: string; code?: true }) => !f.code && f.value.length > 200 && isPayload(f.value) && payloadLines(f.value) !== null
