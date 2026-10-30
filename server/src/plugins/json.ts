// Strict JSON for signed plugin documents. JSON.parse keeps the last of two equal keys, so a manifest with
// {"id": "a", ..., "id": "b"} could be read differently by two tools: duplicate keys are refused here, as are
// documents nested deeper than a small bound. canonicalJson() is the byte form a signature covers: keys sorted by
// UTF-16 code units, no whitespace, JSON.stringify's escaping for strings and numbers.

export class JsonError extends Error { name = 'JsonError' }

const MAX_DEPTH = 32

/** JSON.parse with duplicate-key and depth checks (the input is at most a few hundred kilobytes). */
export function parseStrictJson(text: string): unknown {
  let i = 0
  const ws = () => { while (i < text.length && (text[i] === ' ' || text[i] === '\n' || text[i] === '\r' || text[i] === '\t')) i++ }
  const err = (m: string): never => { throw new JsonError(`${m} at ${i}`) }
  const str = (): string => {
    const start = i
    if (text[i] !== '"') err('string expected')
    i++
    while (i < text.length && text[i] !== '"') {
      if (text[i] === '\\') i++
      else if (text.charCodeAt(i) < 0x20) err('control character in string')
      i++
    }
    if (text[i] !== '"') err('unterminated string')
    i++
    try { return JSON.parse(text.slice(start, i)) as string } catch { return err('bad string') }
  }
  const value = (depth: number): unknown => {
    if (depth > MAX_DEPTH) err('nested too deeply')
    ws()
    const ch = text[i]
    if (ch === '{') {
      i++
      const out: Record<string, unknown> = Object.create(null)
      const seen = new Set<string>()
      ws()
      if (text[i] === '}') { i++; return { ...out } }
      for (;;) {
        ws()
        const k = str()
        if (seen.has(k)) err(`duplicate key '${k.slice(0, 40)}'`)
        seen.add(k)
        ws()
        if (text[i] !== ':') err("':' expected")
        i++
        out[k] = value(depth + 1)
        ws()
        if (text[i] === ',') { i++; continue }
        if (text[i] === '}') { i++; break }
        err("',' or '}' expected")
      }
      // a plain object (no null prototype) for zod; __proto__ cannot become a prototype through spreading
      return Object.fromEntries(Object.entries(out))
    }
    if (ch === '[') {
      i++
      const out: unknown[] = []
      ws()
      if (text[i] === ']') { i++; return out }
      for (;;) {
        out.push(value(depth + 1))
        ws()
        if (text[i] === ',') { i++; continue }
        if (text[i] === ']') { i++; break }
        err("',' or ']' expected")
      }
      return out
    }
    if (ch === '"') return str()
    const m = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i, i + 64))
    if (!m) return err('value expected')
    i += m[0].length
    return JSON.parse(m[0])
  }
  const v = value(0)
  ws()
  if (i !== text.length) err('trailing data')
  return v
}

/** The signed byte form of a JSON value. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v)
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new JsonError('non-finite number')
    return JSON.stringify(v)
  }
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']'
  if (typeof v === 'object') {
    const keys = Object.keys(v as object).filter((k) => (v as Record<string, unknown>)[k] !== undefined).sort()
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson((v as Record<string, unknown>)[k])).join(',') + '}'
  }
  throw new JsonError(`cannot encode ${typeof v}`)
}
