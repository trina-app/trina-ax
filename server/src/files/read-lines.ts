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
function cost(s: string, from: number, to: number) { let t = 0; for (let i = from; i < to; i++) t += tokenCost(s.charCodeAt(i)); return t }

const num = (n: number) => n.toLocaleString('en-US')

/** Text as numbered lines (cat -n), from `offset` (1-based line), `limit` lines (default 2000), from `char_offset` in
 * the first line. A line that does not fit what is left of one call comes back in pieces: "[characters a–b of n]". */
export function numberedLines(rel: string, text: string, a: ReadLinesArgs, view: ReadLinesView = {}, converted = false): ReadLinesOut {
  const lines = text.split(/\r?\n/)
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  const off = a.offset ?? 1, lim = a.limit ?? 2000
  const again = view.again ?? ''
  if (!lines.length) return { text: '(empty file)', summary: `read ${rel} -> empty`, shown: 0 }
  if (off > lines.length) throw new ToolError(`offset ${off} is past the end of the file (${lines.length} lines)`)
  let start = a.char_offset ?? 0
  const first = lines[off - 1]!
  if (start > 0 && start >= first.length) throw new ToolError(`char_offset ${start} is past the end of line ${off} (${num(first.length)} characters)`)
  const end = Math.min(lines.length, off - 1 + lim)
  const out: string[] = []
  let chars = READ_TEXT_CHARS, tokens = READ_TEXT_TOKENS
  /** where the next call starts when this one stopped before `end` */
  let next: { line: number; char: number } | null = null
  for (let i = off - 1; i < end; i++, start = 0) {
    const l = lines[i]!
    const n = i + 1
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

/**
 * The pretty-printed view of a .json file (or of each record of a .jsonl file), when it is asked for (`pretty: true`)
 * or, for .json, when no offset is given and the file is a long line (`pretty` not false). Null: the raw text.
 */
export function prettyJsonView(rel: string, text: string, a: ReadLinesArgs & { pretty?: boolean }): { text: string; view: ReadLinesView } | null {
  if (a.pretty === false || !prettyAllowed(rel) || text.length > PRETTY_JSON_MAX) return null
  const raw = text.split(/\r?\n/)
  if (raw.length && raw[raw.length - 1] === '') raw.pop()
  if (isJson(rel)) {
    const auto = a.pretty === undefined && a.offset === undefined && a.char_offset === undefined && raw.some((l) => l.length > PRETTY_JSON_LINE)
    if (!a.pretty && !auto) return null
    let v: unknown
    try { v = JSON.parse(text.replace(/^﻿/, '')) } catch {
      if (a.pretty) throw new ToolError(`'${rel}' is not valid JSON, so it cannot be pretty-printed; read it with pretty: false (long lines come back in pieces)`, 'bad_json')
      return null
    }
    const pretty = JSON.stringify(v, null, 2)
    const n = pretty.split('\n').length
    const head = `(${rel}: ${num(text.length)} characters of JSON on ${raw.length === 1 ? 'one line' : `${raw.length} lines`}, shown pretty-printed as ${num(n)} lines. ` +
      `Line numbers below are of this view: to go on, read with pretty=true and offset. pretty=false gives the raw text, where grep's line numbers and character positions apply.)`
    return { text: pretty, view: { head, again: ' pretty=true' } }
  }
  if (!a.pretty) return null
  const out: string[] = []
  raw.forEach((l, i) => {
    out.push(`// line ${i + 1} of the file`)
    if (!l.trim()) return
    try { out.push(JSON.stringify(JSON.parse(l), null, 2)) } catch { out.push(l) }
  })
  const head = `(${rel}: ${num(raw.length)} JSON lines, each shown pretty-printed under "// line N of the file". Line numbers below are of this view: to go on, read with pretty=true and offset. pretty=false gives the raw lines.)`
  return { text: out.join('\n'), view: { head, again: ' pretty=true' } }
}
