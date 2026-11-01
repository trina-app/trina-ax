// Connection tools that are not offered as tools of their own in a turn (docs/DECISIONS.md "Connection tools: deferred,
// found and called"), like Claude Code's deferred MCP tools: the instructions list them by name with a short
// description within a budget, find_tools looks them up by words and returns their full input schemas, and call_tool
// runs one after its arguments were checked against the stored schema (tools.ts). This file has the parts that need no
// database: the words of a tool and the matching, the list for the instructions, and the schema check.
import type { RemoteTool } from './mcp'

/** the list of tools to look up in the instructions: its lines stay within this many characters (Claude Code's skill
 * list budget, 1% of a 200K context x 4 characters, as chat/skill-list.ts SKILL_LIST_BUDGET) */
export const DEFERRED_LIST_BUDGET = 8_000
/** the longest short description a listed tool gets (its first sentence, cut) */
export const DEFERRED_DESCRIPTION_MAX = 160
/** find_tools answers with at most this many tools (default FIND_TOOLS_DEFAULT) */
export const FIND_TOOLS_MAX = 10
export const FIND_TOOLS_DEFAULT = 5

const fold = (s: string) => s.normalize('NFC').toLowerCase()
/** one line: white space, control characters and line or paragraph separators become one space, so a service's words
 * cannot start a line of their own in the instructions */
export const oneLine = (s: string) => s.replace(/[\s\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim()

/** The first sentence of a description, cut to `max` characters (code points). */
export function firstSentence(d: string, max = DEFERRED_DESCRIPTION_MAX): string {
  const t = oneLine(d)
  const m = /^(.+?[.!?。])(?:\s|$)/u.exec(t)
  const s = m ? m[1]! : t
  return [...s].length > max ? [...s].slice(0, max - 1).join('').trimEnd() + '…' : s
}

// ---------------- words and matching ----------------

const STOP = new Set(['the', 'a', 'an', 'to', 'for', 'of', 'and', 'or', 'in', 'on', 'at', 'by', 'with', 'from', 'is', 'are', 'be', 'it', 'its',
  'this', 'that', 'my', 'me', 'our', 'we', 'you', 'your', 'i', 'please', 'can', 'could', 'would', 'will', 'do', 'tool', 'tools'])
const HANGUL = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/
const CJK = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af\u3040-\u30ff\u4e00-\u9fff]/

/** Words of a tool's name, title or description: snake_case, kebab-case, dotted and camelCase names split into their
 * words, other words in lower case (stop words left out), Korean, Japanese and Chinese runs as two-letter pieces (so
 * a Korean particle stuck to a word does not hide it). */
export function toolTokens(text: string): string[] {
  const split = text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
  const out: string[] = []
  for (const m of fold(split).matchAll(/[\p{L}\p{N}]+/gu)) {
    const w = m[0]
    if (!CJK.test(w)) { if ((w.length >= 2 || /\d/.test(w)) && !STOP.has(w)) out.push(w); continue }
    const chars = [...w]
    if (chars.length === 1) { out.push(w); continue }
    for (let i = 0; i + 1 < chars.length; i++) out.push(chars[i]! + chars[i + 1]!)
  }
  return out
}

/** the same word, or (Latin words of 4 letters or more) one a longer form of the other: "video" / "videos" */
const tokenMatch = (a: string, b: string) => a === b || (a.length >= 4 && b.length >= 4 && !HANGUL.test(a) && (a.startsWith(b) || b.startsWith(a)))

/** What find_tools searches: a tool of this turn with its full name and where it comes from. */
export interface FindEntry { name: string; short: string; connection: string; tool: RemoteTool }

const MAX_QUERY_WORDS = 32
/** the words of an entry, made once (find_tools may be called many times in one turn over thousands of tools) */
const entryWords = new WeakMap<FindEntry, { name: string[]; title: string[]; description: string[]; connection: string[] }>()
function wordsOf(e: FindEntry) {
  let w = entryWords.get(e)
  if (!w) entryWords.set(e, (w = { name: toolTokens(e.tool.name), title: toolTokens(e.tool.title ?? ''), description: toolTokens(e.tool.description), connection: toolTokens(e.connection) }))
  return w
}

/**
 * Tools that match `query`, best first. "select:<name>,<name>" picks tools by name (the full name, the name the list
 * shows, or the service's own name), in that order. Otherwise each word of the query found in the tool's name counts 3,
 * in its title 2, in its description 1, in its connection's name 1, and the whole query inside the name 3 more; only
 * tools with a word match, ties in list order.
 */
export function matchTools(entries: readonly FindEntry[], query: string, limit = FIND_TOOLS_DEFAULT): FindEntry[] {
  const q = query.trim()
  if (/^select:/i.test(q)) {
    const out: FindEntry[] = []
    for (const want of q.slice(7).split(',').map((s) => s.trim()).filter(Boolean)) {
      for (const e of byName(entries, want)) if (!out.includes(e)) out.push(e)
    }
    return out.slice(0, limit)
  }
  // a query is a few words; more only add work (every word is compared with every word of every tool)
  const words = [...new Set(toolTokens(q))].slice(0, MAX_QUERY_WORDS)
  if (!words.length) return []
  const whole = fold(oneLine(q)).replace(/[\s-]+/g, '_')
  const scored: { e: FindEntry; score: number; i: number }[] = []
  for (const [i, e] of entries.entries()) {
    const { name, title, description, connection } = wordsOf(e)
    let score = 0, hits = 0
    for (const w of words) {
      const n = name.some((x) => tokenMatch(x, w)), t = title.some((x) => tokenMatch(x, w)), d = description.some((x) => tokenMatch(x, w)), c = connection.some((x) => tokenMatch(x, w))
      if (n || t || d) hits++
      score += (n ? 3 : 0) + (t ? 2 : 0) + (d ? 1 : 0) + (c ? 1 : 0)
    }
    // a word that only names the connection ("higgsfield") finds nothing by itself unless it is all the query says
    if (!hits && !(words.length && words.every((w) => connection.some((x) => tokenMatch(x, w))))) continue
    if (whole.length >= 2 && fold(e.tool.name).includes(whole)) score += 3
    scored.push({ e, score, i })
  }
  return scored.sort((a, b) => b.score - a.score || a.i - b.i).slice(0, limit).map((s) => s.e)
}

/** The tools a name means: the full name; else the name the list shows or the service's own name, when it says one. */
export function byName(entries: readonly FindEntry[], name: string): FindEntry[] {
  const exact = entries.filter((e) => e.name === name)
  if (exact.length) return exact
  return entries.filter((e) => e.short === name || e.tool.name === name)
}

// ---------------- the list in the instructions ----------------

export interface DeferredGroup {
  /** "Higgsfield (team connection), names team_higgsfield__<name below>:" */
  header: string
  items: { short: string; description: string }[]
}

/**
 * The lines that list the tools to look up, within `budget` characters: every name with the first sentence of its
 * description when that fits (cut shorter step by step, the same for every tool, so the list does not favour the first
 * ones), else names only, else the names that fit in order and how many more each connection has. Stable for the
 * same tools, so the instructions stay the same from turn to turn.
 */
export function deferredLines(groups: readonly DeferredGroup[], budget = DEFERRED_LIST_BUDGET): { lines: string[]; listed: number; described: boolean } {
  const total = groups.reduce((n, g) => n + g.items.length, 0)
  const size = (lines: string[]) => lines.reduce((n, l) => n + l.length + 1, 0)
  for (const cap of [DEFERRED_DESCRIPTION_MAX, 100, 60, 40, 0]) {
    const lines = groups.flatMap((g) => [g.header, ...g.items.map((it) => `- ${it.short}${cap && it.description ? `: ${firstSentence(it.description, cap)}` : ''}`)])
    if (size(lines) <= budget) return { lines, listed: total, described: cap > 0 }
  }
  const lines: string[] = []
  let used = 0, listed = 0
  const more = (n: number, what: string) => `- … ${n} more ${what}: find them with find_tools`
  for (const [gi, g] of groups.entries()) {
    // room for the "more" line of this and every later connection
    const reserve = (groups.length - gi) * 80
    if (used + g.header.length + 1 + reserve > budget) {
      const left = groups.slice(gi).reduce((n, x) => n + x.items.length, 0)
      lines.push(more(left, `tools of ${groups.length - gi} more connection${groups.length - gi === 1 ? '' : 's'}`))
      break
    }
    lines.push(g.header); used += g.header.length + 1
    let n = 0
    for (const it of g.items) {
      const l = `- ${it.short}`
      if (used + l.length + 1 + reserve > budget) break
      lines.push(l); used += l.length + 1; n++
    }
    listed += n
    if (n < g.items.length) { const l = more(g.items.length - n, n ? 'of this connection' : 'tools of this connection'); lines.push(l); used += l.length + 1 }
  }
  return { lines, listed, described: false }
}

// ---------------- the arguments against the stored input schema ----------------

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)
const KNOWN_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])
function isType(v: unknown, t: string): boolean {
  switch (t) {
    case 'object': return isObj(v)
    case 'array': return Array.isArray(v)
    case 'string': return typeof v === 'string'
    case 'number': return typeof v === 'number' && Number.isFinite(v)
    case 'integer': return typeof v === 'number' && Number.isInteger(v)
    case 'boolean': return typeof v === 'boolean'
    case 'null': return v === null
    default: return true
  }
}
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b || !a || !b || typeof a !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) return a.length === (b as unknown[]).length && a.every((x, i) => same(x, (b as unknown[])[i]))
  const ka = Object.keys(a as Json), kb = Object.keys(b as Json)
  return ka.length === kb.length && ka.every((k) => same((a as Json)[k], (b as Json)[k]))
}
/** a local reference ("#/$defs/Image", "#/definitions/x", "#"); anything else is not followed */
function resolveRef(root: Json, ref: string): unknown {
  if (ref === '#') return root
  if (!ref.startsWith('#/')) return undefined
  let cur: unknown = root
  for (const raw of ref.slice(2).split('/')) {
    let part: string
    try { part = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~') } catch { return undefined }
    if (!isObj(cur) && !Array.isArray(cur)) return undefined
    if (!Object.hasOwn(cur as Json, part)) return undefined
    cur = (cur as Json)[part]
  }
  return cur
}
const show = (v: unknown) => { const s = JSON.stringify(v) ?? String(v); return s.length > 60 ? s.slice(0, 59) + '…' : s }
const MAX_DEPTH = 40
/** schema nodes one check visits at most: the schema is the service's, and allOf / anyOf branches that refer back to
 * themselves would otherwise grow the work with every level (three self-references per level: hours on the server's
 * one thread). Past this the check stops and what was not looked at passes (the service checks again). */
export const CHECK_STEPS = 20_000
/** characters of a string counted as one step when its length is measured */
const STEP_CHARS = 256

/**
 * What is wrong with `value` as input for a tool with this input schema (empty: nothing found), at most `max` problems.
 * A subset of JSON Schema that MCP servers use: type (also lists, and OpenAPI's nullable), enum, const, required,
 * properties, additionalProperties, items / prefixItems, allOf, anyOf / oneOf (one branch must fit), local $ref,
 * string lengths, number bounds, array lengths. Everything else (formats, if/then, not, unknown words) passes, so a
 * valid call is never refused for a keyword this check does not know; the service checks again. `pattern` and
 * `patternProperties` are not run: they are the service's regular expressions, and one that backtracks can hold the
 * server for a second or more per string (an object with patternProperties takes any other argument name). The work is
 * bounded (CHECK_STEPS: schema nodes, enum entries, required names, argument names, long strings), and a schema or
 * value the check cannot follow (nested too deep to compare) passes.
 */
export function checkArgs(schema: Json, value: unknown, max = 10): string[] {
  const out: string[] = []
  try { walk({ root: schema, steps: CHECK_STEPS }, schema, value, '', 0, out, max) } catch { return out.slice(0, max) }
  return out.slice(0, max)
}

interface Walk { root: Json; steps: number }

function walk(w: Walk, s: unknown, v: unknown, at: string, depth: number, out: string[], max: number): void {
  if (out.length >= max || depth > MAX_DEPTH || --w.steps < 0) return
  const root = w.root
  const where = at || '(arguments)'
  if (s === false) { out.push(`${where}: not allowed`); return }
  if (!isObj(s)) return
  if (typeof s.$ref === 'string') { const r = resolveRef(root, s.$ref); if (r !== undefined) walk(w, r, v, at, depth + 1, out, max) }
  const types = (Array.isArray(s.type) ? s.type : typeof s.type === 'string' ? [s.type] : null) as unknown[] | null
  if (types && types.every((t) => typeof t === 'string' && KNOWN_TYPES.has(t))) {
    const allowed = s.nullable === true ? [...types, 'null'] : types
    if (!allowed.some((t) => isType(v, t as string))) { out.push(`${where}: should be ${allowed.join(' or ')}, not ${v === null ? 'null' : Array.isArray(v) ? 'an array' : typeof v}`); return }
  }
  if (Array.isArray(s.enum) && (w.steps -= s.enum.length) >= 0 && !s.enum.some((e) => same(e, v))) { out.push(`${where}: should be one of ${s.enum.slice(0, 12).map(show).join(', ')}${s.enum.length > 12 ? ', …' : ''}`); return }
  if ('const' in s && !same(s.const, v)) { out.push(`${where}: should be ${show(s.const)}`); return }
  for (const sub of Array.isArray(s.allOf) ? s.allOf : []) walk(w, sub, v, at, depth + 1, out, max)
  for (const key of ['anyOf', 'oneOf'] as const) {
    const branches = s[key]
    if (!Array.isArray(branches) || !branches.length) continue
    const tries = branches.map((b) => { const o: string[] = []; walk(w, b, v, at, depth + 1, o, 3); return o })
    if (!tries.some((t) => !t.length)) out.push(`${where}: does not fit any of the allowed forms (${tries[0]![0] ?? 'first form'})`)
  }
  if (typeof v === 'string' && (typeof s.minLength === 'number' || typeof s.maxLength === 'number')) {
    if ((w.steps -= Math.floor(v.length / STEP_CHARS)) < 0) return
    let n = 0
    for (const _ of v) n++
    if (typeof s.minLength === 'number' && n < s.minLength) out.push(`${where}: at least ${s.minLength} characters`)
    if (typeof s.maxLength === 'number' && n > s.maxLength) out.push(`${where}: at most ${s.maxLength} characters`)
  }
  if (typeof v === 'number') {
    if (typeof s.minimum === 'number' && (s.exclusiveMinimum === true ? v <= s.minimum : v < s.minimum)) out.push(`${where}: at least ${s.minimum}${s.exclusiveMinimum === true ? ' (exclusive)' : ''}`)
    if (typeof s.maximum === 'number' && (s.exclusiveMaximum === true ? v >= s.maximum : v > s.maximum)) out.push(`${where}: at most ${s.maximum}${s.exclusiveMaximum === true ? ' (exclusive)' : ''}`)
    if (typeof s.exclusiveMinimum === 'number' && v <= s.exclusiveMinimum) out.push(`${where}: more than ${s.exclusiveMinimum}`)
    if (typeof s.exclusiveMaximum === 'number' && v >= s.exclusiveMaximum) out.push(`${where}: less than ${s.exclusiveMaximum}`)
  }
  if (Array.isArray(v)) {
    if (typeof s.minItems === 'number' && v.length < s.minItems) out.push(`${where}: at least ${s.minItems} items`)
    if (typeof s.maxItems === 'number' && v.length > s.maxItems) out.push(`${where}: at most ${s.maxItems} items`)
    const tuple = Array.isArray(s.prefixItems) ? s.prefixItems : Array.isArray(s.items) ? s.items : null
    if (tuple) tuple.forEach((sub, i) => { if (i < v.length) walk(w, sub, v[i], `${at}[${i}]`, depth + 1, out, max) })
    const rest = tuple ? (Array.isArray(s.prefixItems) ? s.items : s.additionalItems) : s.items
    if (rest !== undefined && !Array.isArray(rest)) for (let i = tuple?.length ?? 0; i < v.length && out.length < max && w.steps >= 0; i++) walk(w, rest, v[i], `${at}[${i}]`, depth + 1, out, max)
  }
  if (isObj(v)) {
    const props = isObj(s.properties) ? s.properties : {}
    for (const r of Array.isArray(s.required) ? s.required : []) {
      if (out.length >= max || --w.steps < 0) return
      if (typeof r === 'string' && !Object.hasOwn(v, r)) out.push(`${at ? at + '.' : ''}${r}: required`)
    }
    // names the service's patternProperties may allow are not tested against them (see checkArgs): any name passes
    const patterned = isObj(s.patternProperties) && Object.keys(s.patternProperties).length > 0
    for (const [k, x] of Object.entries(v)) {
      if (out.length >= max || --w.steps < 0) return
      const path = at ? `${at}.${k}` : k
      if (Object.hasOwn(props, k)) { walk(w, props[k], x, path, depth + 1, out, max); continue }
      if (patterned) continue
      if (s.additionalProperties === false) out.push(`${path}: not an argument of this tool${Object.keys(props).length ? ` (it takes ${Object.keys(props).slice(0, 20).join(', ')})` : ''}`)
      else if (isObj(s.additionalProperties)) walk(w, s.additionalProperties, x, path, depth + 1, out, max)
    }
  }
}
