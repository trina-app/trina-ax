// Text as numbered lines for the AI's read: every line comes back whole or in pieces, never cut (QA TC-4901). One call
// stays under one output budget; a line longer than what is left comes back in pieces, and the result ends with the
// exact next call (offset + char_offset). A .json file that is one long line is shown pretty-printed.
import { ToolError } from '../policy/errors'

/** the most characters of file text one read gives (the API engine keeps 30,000 characters of a tool result,
 * engine/api-agent.ts; this leaves room for the line numbers and the notes) */
export const READ_TEXT_CHARS = 28_000
/** the most tokens of file text one read gives, by the estimate below: Claude Code cuts an MCP result over
 * MAX_MCP_OUTPUT_TOKENS (25,000 by default) */
export const READ_TEXT_TOKENS = 20_000
/** a piece of a long line is not started with less than this left: the next call starts at that line */
const MIN_PIECE = 1_000
/** a .json file whose longest line is over this is shown pretty-printed by default */
export const PRETTY_JSON_LINE = 2_000
/** a JSON text over this is not pretty-printed (pieces of the raw text instead) */
const PRETTY_JSON_MAX = 20 * 1024 * 1024

export interface ReadLinesArgs { offset?: number; limit?: number; char_offset?: number }
export interface ReadLinesView {
  /** said before the lines (e.g. the pretty-printed view) */
  head?: string
  /** added to every "read again with …" instruction (e.g. " pretty=true") */
  again?: string
  /** the lines are a reformatted view, not the file's text (an edit must copy from the raw text) */
  pretty?: boolean
}
export interface ReadLinesOut { text: string; summary: string; shown: number }

/** tokens of text as estimated here: 3 ASCII characters a token (JSON and code tokenize closer to 3 than 4), any other
 * character a token */
const tokenCost = (c: number) => (c > 0x7f ? 1 : 1 / 3)

/** The end (exclusive) of the longest part of `s` from `from` that fits `chars` and `tokens`; never splits a pair of
 * UTF-16 surrogates. */
function fitEnd(s: string, from: number, chars: number, tokens: number): number {
  const lastChar = Math.min(s.length, from + Math.max(0, Math.floor(chars)))
  let t = 0
  let i = from
  for (; i < lastChar; i++) {
    t += tokenCost(s.charCodeAt(i))
    if (t > tokens) break
  }
  if (i < s.length && i > from) {
    const c = s.charCodeAt(i - 1)
    if (c >= 0xd800 && c <= 0xdbff) i--
  }
  return i
}
const isHighSurrogate = (c: number) => c >= 0xd800 && c <= 0xdbff
const isLowSurrogate = (c: number) => c >= 0xdc00 && c <= 0xdfff
function cost(s: string, from: number, to: number) { let t = 0; for (let i = from; i < to; i++) t += tokenCost(s.charCodeAt(i)); return t }

const num = (n: number) => n.toLocaleString('en-US')

/** The lines of `text` (\n or \r\n), without the empty one after a last line break. Never changed by the readers
 * (ReadViews keeps them for the next read). */
export function splitLines(text: string): string[] {
  const lines = text.includes('\r') ? text.split(/\r?\n/) : text.split('\n')
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Text as numbered lines (cat -n), from `offset` (1-based line), `limit` lines (default 2000), from `char_offset` in
 * the first line. A line that does not fit what is left of one call comes back in pieces: "[characters a–b of n]". */
export function numberedLines(rel: string, text: string | readonly string[], a: ReadLinesArgs, view: ReadLinesView = {}, converted = false): ReadLinesOut {
  const lines = typeof text === 'string' ? splitLines(text) : text
  const off = a.offset ?? 1, lim = a.limit ?? 2000
  const again = view.again ?? ''
  if (!lines.length) return { text: '(empty file)', summary: `read ${rel} -> empty`, shown: 0 }
  if (off > lines.length) throw new ToolError(`offset ${off} is past the end of the file (${lines.length} lines)`)
  let start = a.char_offset ?? 0
  const first = lines[off - 1]!
  if (start > 0 && start >= first.length) throw new ToolError(`char_offset ${start} is past the end of line ${off} (${num(first.length)} characters)`)
  // a start inside a surrogate pair (an emoji) goes back to the pair's start
  if (start > 0 && start < first.length && isLowSurrogate(first.charCodeAt(start)) && isHighSurrogate(first.charCodeAt(start - 1))) start--
  const end = Math.min(lines.length, off - 1 + lim)
  const out: string[] = []
  let chars = READ_TEXT_CHARS, tokens = READ_TEXT_TOKENS
  /** where the next call starts when this one stopped before `end` */
  let next: { line: number; char: number } | null = null
  for (let i = off - 1; i < end; i++, start = 0) {
    const l = lines[i]!
    const n = i + 1
    // the budget is spent (also by many empty lines): the next call starts here
    if (out.length && (chars <= 8 || tokens <= 3)) { next = { line: n, char: start }; break }
    // the line number and the tab count too
    chars -= 8; tokens -= 3
    const stop = fitEnd(l, start, chars, tokens)
    if (stop < l.length) {
      // the line does not fit: a piece of it, unless only a little room is left after other lines
      if (out.length && stop - start < MIN_PIECE) { next = { line: n, char: start }; break }
      out.push(`${String(n).padStart(6)}\t[characters ${num(start)}–${num(stop)} of ${num(l.length)}] ${l.slice(start, stop)}`)
      next = { line: n, char: stop }
      break
    }
    out.push(start > 0 ? `${String(n).padStart(6)}\t[characters ${num(start)}–${num(l.length)} of ${num(l.length)}] ${l.slice(start)}` : `${String(n).padStart(6)}\t${l}`)
    chars -= l.length - start
    tokens -= cost(l, start, l.length)
  }
  let more = ''
  if (next && next.char > 0) {
    more = `\n… (line ${next.line} goes on: it has ${num(lines[next.line - 1]!.length)} characters and this read showed it up to character ${num(next.char)}. ` +
      `Nothing is cut: read again with offset=${next.line} char_offset=${next.char}${again} for the rest. The file has ${num(lines.length)} lines.)`
  } else if (next) {
    more = `\n… (one read shows about ${num(READ_TEXT_CHARS)} characters; ${num(lines.length)} lines in total. Read again with offset=${next.line}${again} for the rest.)`
  } else if (end < lines.length) {
    more = `\n… (${num(lines.length)} lines in total; read again with offset=${end + 1}${again} for the rest)`
  }
  return { text: (view.head ? view.head + '\n' : '') + out.join('\n') + more, summary: `read ${rel} -> ${out.length} lines${next ? ' (one read\'s limit)' : ''}${converted ? ' (converted)' : ''}`, shown: out.length }
}

const isJson = (rel: string) => /\.json$/i.test(rel)
const isJsonl = (rel: string) => /\.(jsonl|ndjson)$/i.test(rel)
export const prettyAllowed = (rel: string) => isJson(rel) || isJsonl(rel)

/** Is `text` the same as `s` but for white space between JSON tokens (the text inside strings compared exactly)? One
 * pass, no copy of the text (QA TC-4950: building the copy took a fifth of a pretty view of 18 MB). */
function sameButSpace(text: string, s: string): boolean {
  let j = 0
  let inStr = false
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (!inStr && (c === 32 || c === 9 || c === 10 || c === 13)) continue
    if (c !== s.charCodeAt(j++)) return false
    if (inStr) {
      if (c === 92) { i++; if (text.charCodeAt(i) !== s.charCodeAt(j++)) return false } else if (c === 34) inStr = false
    } else if (c === 34) inStr = true
  }
  return j === s.length
}
/** The value of a JSON text, re-serialised exactly as written, or null: a text whose re-serialisation would differ in
 * anything but white space (a number over 15 digits or written as 1.0 or 1e3, an escape such as \u00e9 or \/, a
 * duplicate key, invalid JSON) is never reformatted, so the view never shows a value other than the file's. */
export function exactJson(text: string): unknown | undefined {
  const t = text.replace(/^\uFEFF/, '')
  let v: unknown
  try { v = JSON.parse(t) } catch { return undefined }
  return sameButSpace(t, JSON.stringify(v)) ? v : undefined
}
const REFORMATTED = 'This is a reformatted view: values are as written, only spaces and line breaks are added. To edit the file, read it with pretty=false and copy old_string from the raw text.'

/** a view of a text that reads as other lines than the file's (pretty JSON) */
export interface Pretty { lines: readonly string[]; view: ReadLinesView }
/** What one text gives a read, worked out once: ReadViews keeps it for the next reads of the same bytes (QA TC-4950).
 * Every field is filled when first needed and never changed after. */
export interface TextMemo {
  /** the text's lines */
  raw?: readonly string[]
  /** has the text a line over PRETTY_JSON_LINE? */
  long?: boolean
  /** the .json view: null when the JSON does not re-serialise exactly (shown raw) */
  json?: Pretty | null
  /** the .jsonl view */
  jsonl?: Pretty
}
export const memoLines = (text: string, m: TextMemo) => (m.raw ??= splitLines(text))

/**
 * The pretty-printed view of a .json file (or of each record of a .jsonl file), when it is asked for (`pretty: true`)
 * or, for .json, when no offset is given and the file is a long line (`pretty` not false). Only JSON that re-serialises
 * exactly as written is reformatted (exactJson). Null: the raw text. `memo` keeps what is worked out for the next reads
 * of the same text.
 */
export function prettyJsonView(rel: string, text: string, a: ReadLinesArgs & { pretty?: boolean }, memo: TextMemo = {}): { text: string | readonly string[]; view: ReadLinesView } | null {
  if (a.pretty === false || !prettyAllowed(rel) || text.length > PRETTY_JSON_MAX) return null
  if (isJson(rel)) {
    const auto = a.pretty === undefined && a.offset === undefined && a.char_offset === undefined && (memo.long ??= hasLongLine(text))
    if (!a.pretty && !auto) return null
    if (memo.json === undefined) memo.json = jsonPretty(rel, text)
    if (memo.json === null) {
      if (!a.pretty) return null
      return { text: memoLines(text, memo), view: { head: `(${rel} is shown as raw text: it is not valid JSON, or reformatting it would change how some values are written (long numbers, escapes, repeated keys). Long lines come back in pieces.)` } }
    }
    return { text: memo.json.lines, view: memo.json.view }
  }
  if (!a.pretty) return null
  if (!memo.jsonl) {
    const raw = memoLines(text, memo)
    const out: string[] = []
    raw.forEach((l, i) => {
      if (!l.trim()) { out.push(`// line ${i + 1} of the file`); return }
      const v = exactJson(l)
      if (v === undefined) { out.push(`// line ${i + 1} of the file (raw: reformatting it would change it)`, l); return }
      out.push(`// line ${i + 1} of the file`, ...JSON.stringify(v, null, 2).split('\n'))
    })
    const head = `(${rel}: ${num(raw.length)} JSON lines, each shown pretty-printed under "// line N of the file". ${REFORMATTED} Line numbers below are of this view: to go on, read with pretty=true and offset.)`
    memo.jsonl = { lines: out, view: { head, again: ' pretty=true', pretty: true } }
  }
  return { text: memo.jsonl.lines, view: memo.jsonl.view }
}

/** has `text` a line over PRETTY_JSON_LINE? (no split) */
function hasLongLine(text: string): boolean {
  let from = 0
  for (;;) {
    const nl = text.indexOf('\n', from)
    const end = nl < 0 ? text.length : nl
    if (end - from - (text.charCodeAt(end - 1) === 13 ? 1 : 0) > PRETTY_JSON_LINE) return true
    if (nl < 0) return false
    from = nl + 1
  }
}

/** lines of a text, counted as splitLines counts them */
function lineCount(text: string): number {
  let n = 0
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) n++
  return text.length && !text.endsWith('\n') ? n + 1 : n
}

/** the pretty view of a .json text, or null when it does not re-serialise exactly */
function jsonPretty(rel: string, text: string): Pretty | null {
  const v = exactJson(text)
  if (v === undefined) return null
  // JSON.stringify writes a line break in a string as \n, so the view's lines are its \n
  const lines = JSON.stringify(v, null, 2).split('\n')
  const rawN = lineCount(text)
  const head = `(${rel}: ${num(text.length)} characters of JSON on ${rawN === 1 ? 'one line' : `${num(rawN)} lines`}, shown pretty-printed as ${num(lines.length)} lines. ${REFORMATTED} ` +
    `Line numbers below are of this view: to go on, read with pretty=true and offset. In the raw text (pretty=false) grep's line numbers and character positions apply.)`
  return { lines, view: { head, again: ' pretty=true', pretty: true } }
}

/** the most UTF-16 units of text (and of its views) ReadViews keeps in all */
export const READ_VIEWS_UNITS = 96 * 1024 * 1024
/** a kept text not read again for this long is let go */
export const READ_VIEWS_TTL_MS = 10 * 60_000

interface ViewEntry { text: string; memo: TextMemo; at: number; units: number; views: string }
/** units a memo holds (each view about its text's size) */
function units(e: ViewEntry): number {
  const sum = (l: readonly string[] | undefined) => { let n = 0; if (l) for (const x of l) n += x.length + 1; return n }
  return e.text.length + sum(e.memo.raw) + sum(e.memo.json?.lines) + sum(e.memo.jsonl?.lines)
}

/**
 * The text of files the AI reads in pieces and its views, kept by the file's path and content hash so the next piece
 * does not decode, parse and reformat the whole file again (QA TC-4950: 0.77 s a piece on an 18 MB one-line JSON). Only
 * a text over one read's size is kept (a smaller one is read in one call). A hit is the very text these bytes give:
 * the caller has read the bytes (after every access check) and hashed them, so nothing reaches a person who could not
 * read the file. Bounded: READ_VIEWS_UNITS in all, least recently read let go first, READ_VIEWS_TTL_MS idle.
 */
export class ReadViews {
  private readonly m = new Map<string, ViewEntry>()
  private sweep: ReturnType<typeof setTimeout> | null = null
  constructor(private readonly budget = READ_VIEWS_UNITS, private readonly ttlMs = READ_VIEWS_TTL_MS, private readonly now = () => Date.now()) {}

  /** the text of `rel` with content hash `hash` (made by `make` when not kept) and its memo; call `done` after the read,
   * so the views it worked out count against the budget */
  async get(rel: string, hash: string, make: () => Promise<string>): Promise<{ text: string; memo: TextMemo; done: () => void }> {
    this.expire()
    const key = `${hash}\0${rel}`
    const hit = this.m.get(key)
    if (hit) {
      this.m.delete(key); this.m.set(key, hit)
      hit.at = this.now()
      return { text: hit.text, memo: hit.memo, done: () => this.settle(key, hit) }
    }
    const text = await make()
    const e: ViewEntry = { text, memo: {}, at: this.now(), units: 0, views: '-' }
    if (text.length <= READ_TEXT_CHARS) return { text, memo: e.memo, done: () => {} }
    return { text, memo: e.memo, done: () => this.settle(key, e) }
  }

  /** how many texts are kept (tests) */
  get size() { return this.m.size }
  clear() { this.m.clear(); if (this.sweep) clearTimeout(this.sweep); this.sweep = null }

  private settle(key: string, e: ViewEntry) {
    // counted again only when a read added a view (a view is never changed after)
    const views = `${!!e.memo.raw}${e.memo.json === undefined ? 'u' : !!e.memo.json}${!!e.memo.jsonl}`
    if (views !== e.views) { e.views = views; e.units = units(e) }
    if (e.units > this.budget) { this.m.delete(key); return }
    this.m.delete(key); this.m.set(key, e)
    let total = 0
    for (const x of this.m.values()) total += x.units
    for (const [k, x] of this.m) { if (total <= this.budget) break; if (k === key) continue; this.m.delete(k); total -= x.units }
    this.later()
  }
  /** let idle texts go even when nothing is read any more */
  private later() {
    if (this.sweep || !this.m.size) return
    this.sweep = setTimeout(() => { this.sweep = null; this.expire(); this.later() }, this.ttlMs)
    this.sweep.unref?.()
  }
  private expire() { const t = this.now(); for (const [k, x] of this.m) if (t - x.at >= this.ttlMs) this.m.delete(k) }
}
