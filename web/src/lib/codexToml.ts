// 내 스킬 가져오기 with Codex (docs/DECISIONS.md "W5"): the remote MCP servers of a picked .codex folder's config.toml
// (`[mcp_servers.<name>]`, https://learn.chatgpt.com/docs/extend/mcp), read in the browser as connection templates
// without a key: { name, url, auth, header? }. Nothing else of the file is kept, and no value that could be a secret
// ever leaves this reader: env values, header values, bearer token variable names, OAuth settings and every other table
// are read only to stay in step and then dropped.
//
// It is an ALLOWLISTED reader, not a TOML parser: it understands enough of TOML (table headers, dotted and quoted
// keys, basic and literal strings with escapes, multi-line strings, arrays, inline tables, bare numbers, dates and
// booleans, comments, CRLF, a BOM) to walk any file without getting out of step, and keeps only these paths:
//   mcp_servers.<name>.url                      a string: the address (streamable HTTP servers only)
//   mcp_servers.<name>.command                  any value: a local (stdio) server, which cannot be shared
//   mcp_servers.<name>.bearer_token_env_var     a string: auth "bearer" (the variable's name is not kept)
//   mcp_servers.<name>.http_headers.<header>    (also env_http_headers, and both as inline tables): the header NAME,
//                                               for auth "header"; its value is never kept
//   mcp_servers.<name>.http_headers_helper      any value: a helper makes the headers (auth "bearer")
//   mcp_servers.<name>.enabled                  false: left out
// Hostile input never hangs or throws: at most CODEX_TOML_MAX_BYTES are read, every loop step consumes input, nesting
// stops at MAX_DEPTH, strings and keys have a length cap, at most MAX_SERVERS servers are looked at and
// SKILL_SHARE_LIMITS.tools come out. A syntax error drops the server it was in (an unterminated multi-line string ends
// the reading: the rest of the file would be inside it), and the reading goes on at the next line.
import { findSecrets } from '@mycel/shared'
import { SKILL_SHARE_LIMITS, type ShareToolIn } from '@mycel/shared/api'

/** How much of config.toml is read (a real one is a few KB). */
export const CODEX_TOML_MAX_BYTES = 64 * 1024
/** Arrays and inline tables nested deeper than this are a syntax error. */
const MAX_DEPTH = 16
/** A string or a key longer than this is a syntax error (an address is at most 500). */
const MAX_STRING = 4096
/** Parts of one dotted key or table name. */
const MAX_KEY_PARTS = 8
/** Distinct servers looked at. */
const MAX_SERVERS = 200
/** The server's own rule for a header name (server/src/skills/share-check.ts cleanTools). */
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/

/** A syntax error; `fatal`: nothing after it can be read (an unterminated multi-line string). */
class TomlError { constructor(readonly fatal = false) {} }

/** A value as this reader keeps it: a one-line string, a boolean, or "something else" (numbers, dates, arrays,
 * multi-line strings: read past, never kept). Inline tables are flattened into their leaves. */
type Leaf = { t: 'str'; v: string } | { t: 'bool'; v: boolean } | { t: 'other' }

interface Server {
  url?: string
  stdio?: boolean
  bearer?: boolean
  helper?: boolean
  disabled?: boolean
  headers: string[]
  broken?: boolean
}

const BARE = /[A-Za-z0-9_-]/
const BARE_VALUE = /[A-Za-z0-9_+\-.:]/

class Reader {
  private i = 0
  private readonly n: number
  /** servers by name, in the order they first appear (a Map: a name like "__proto__" is only a key) */
  readonly servers = new Map<string, Server>()
  /** the table the keys below a header go to; null: one this reader does not keep */
  private table: string[] | null = []

  constructor(private readonly s: string) { this.n = s.length }

  read(): void {
    while (this.i < this.n) {
      this.skipBlank()
      if (this.i >= this.n) break
      const start = this.i
      try {
        if (this.s[this.i] === '[') this.header()
        else this.keyValue()
      } catch (e) {
        if (!(e instanceof TomlError)) throw e
        this.breakCurrent()
        if (e.fatal) return
        // on at the next line (every step consumes input: nothing can loop)
        const nl = this.s.indexOf('\n', start)
        this.i = nl === -1 ? this.n : nl + 1
      }
    }
  }

  // ---- what is kept

  private server(name: string): Server | null {
    const had = this.servers.get(name)
    if (had) return had
    if (this.servers.size >= MAX_SERVERS) return null
    const s: Server = { headers: [] }
    this.servers.set(name, s)
    return s
  }

  /** the server of the current table, when it is one: a syntax error there drops it */
  private breakCurrent(): void {
    const t = this.table
    if (t && t[0] === 'mcp_servers' && t.length >= 2) {
      const s = this.servers.get(t[1]!)
      if (s) s.broken = true
    }
  }

  private assign(path: readonly string[], leaf: Leaf): void {
    if (path[0] !== 'mcp_servers' || path.length < 3) return
    const s = this.server(path[1]!)
    if (!s) return
    const [key, ...rest] = path.slice(2)
    if (key === 'url' && !rest.length) {
      if (leaf.t !== 'str') s.broken = true
      else if (s.url === undefined) s.url = leaf.v
    } else if (key === 'command' && !rest.length) s.stdio = true
    else if (key === 'bearer_token_env_var' && !rest.length) { if (leaf.t === 'str' && leaf.v.trim()) s.bearer = true }
    else if (key === 'http_headers_helper' && !rest.length) s.helper = true
    else if (key === 'enabled' && !rest.length) { if (leaf.t === 'bool' && !leaf.v) s.disabled = true }
    else if ((key === 'http_headers' || key === 'env_http_headers') && rest.length === 1) {
      // the header's name only; its value (or the variable holding it) stays here
      if (leaf.t === 'str' && HEADER_NAME.test(rest[0]!) && !s.headers.includes(rest[0]!)) s.headers.push(rest[0]!)
    }
  }

  // ---- statements

  private header(): void {
    // [[array of tables]]: nothing of an MCP server is one; its keys are read past
    const array = this.s.startsWith('[[', this.i)
    this.i += array ? 2 : 1
    this.table = null
    this.spaces()
    const path = this.key()
    this.spaces()
    if (!this.s.startsWith(array ? ']]' : ']', this.i)) throw new TomlError()
    this.i += array ? 2 : 1
    this.lineEnd()
    if (array) return
    this.table = path
    // a server's table shows it in the order of the file, even before its keys
    if (path[0] === 'mcp_servers' && path.length >= 2) this.server(path[1]!)
  }

  private keyValue(): void {
    const key = this.key()
    this.spaces()
    if (this.s[this.i] !== '=') throw new TomlError()
    this.i++
    this.spaces()
    const base = this.table
    const leaves: [string[], Leaf][] = []
    this.value(key, leaves, 0)
    this.lineEnd()
    if (!base) return
    for (const [p, leaf] of leaves) this.assign([...base, ...p], leaf)
  }

  // ---- pieces

  /** A dotted key: bare or quoted parts, at most MAX_KEY_PARTS. */
  private key(): string[] {
    const parts: string[] = []
    for (;;) {
      if (parts.length >= MAX_KEY_PARTS) throw new TomlError()
      const c = this.s[this.i]
      if (c === '"') parts.push(this.basic())
      else if (c === "'") parts.push(this.literal())
      else {
        const from = this.i
        while (this.i < this.n && BARE.test(this.s[this.i]!) && this.i - from <= MAX_STRING) this.i++
        if (this.i === from || this.i - from > MAX_STRING) throw new TomlError()
        parts.push(this.s.slice(from, this.i))
      }
      this.spaces()
      if (this.s[this.i] !== '.') return parts
      this.i++
      this.spaces()
    }
  }

  /** A value; its kept leaves go into `out` under `at` (inline tables are flattened). */
  private value(at: string[], out: [string[], Leaf][], depth: number): void {
    if (depth > MAX_DEPTH) throw new TomlError()
    const c = this.s[this.i]
    if (c === '"' || c === "'") {
      if (this.s.startsWith(c.repeat(3), this.i)) { this.multiline(c); out.push([at, { t: 'other' }]); return }
      out.push([at, { t: 'str', v: c === '"' ? this.basic() : this.literal() }])
      return
    }
    if (c === '[') { this.array(depth); out.push([at, { t: 'other' }]); return }
    if (c === '{') { this.inlineTable(at, out, depth); return }
    const from = this.i
    while (this.i < this.n && BARE_VALUE.test(this.s[this.i]!) && this.i - from <= MAX_STRING) this.i++
    const word = this.s.slice(from, this.i)
    if (!word || word.length > MAX_STRING) throw new TomlError()
    out.push([at, word === 'true' || word === 'false' ? { t: 'bool', v: word === 'true' } : { t: 'other' }])
  }

  private array(depth: number): void {
    this.i++ // [
    const ignored: [string[], Leaf][] = []
    for (;;) {
      this.skipBlank()
      if (this.i >= this.n) throw new TomlError()
      if (this.s[this.i] === ']') { this.i++; return }
      this.value([], ignored, depth + 1)
      ignored.length = 0
      this.skipBlank()
      const c = this.s[this.i]
      if (c === ',') { this.i++; continue }
      if (c === ']') { this.i++; return }
      throw new TomlError()
    }
  }

  private inlineTable(at: string[], out: [string[], Leaf][], depth: number): void {
    this.i++ // {
    this.skipBlank()
    if (this.s[this.i] === '}') { this.i++; return }
    for (;;) {
      this.skipBlank()
      if (this.i >= this.n) throw new TomlError()
      const key = this.key()
      if (at.length + key.length > MAX_KEY_PARTS * 2) throw new TomlError()
      this.spaces()
      if (this.s[this.i] !== '=') throw new TomlError()
      this.i++
      this.spaces()
      this.value([...at, ...key], out, depth + 1)
      this.skipBlank()
      const c = this.s[this.i]
      if (c === ',') { this.i++; continue }
      if (c === '}') { this.i++; return }
      throw new TomlError()
    }
  }

  /** "…" on one line, with TOML's escapes. */
  private basic(): string {
    this.i++
    let out = ''
    for (;;) {
      if (this.i >= this.n || out.length > MAX_STRING) throw new TomlError()
      const c = this.s[this.i]!
      if (c === '\n' || c === '\r') throw new TomlError()
      this.i++
      if (c === '"') return out
      if (c !== '\\') { out += c; continue }
      const e = this.s[this.i++]
      const simple: Record<string, string> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', e: '\u001b', '"': '"', '\\': '\\' }
      if (e !== undefined && Object.hasOwn(simple, e)) { out += simple[e]; continue }
      const len = e === 'u' ? 4 : e === 'U' ? 8 : e === 'x' ? 2 : 0
      const hex = this.s.slice(this.i, this.i + len)
      if (!len || !/^[0-9A-Fa-f]+$/.test(hex) || hex.length !== len) throw new TomlError()
      const cp = parseInt(hex, 16)
      if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) throw new TomlError()
      out += String.fromCodePoint(cp)
      this.i += len
    }
  }

  /** '…' on one line, as written. */
  private literal(): string {
    const from = ++this.i
    for (;;) {
      if (this.i >= this.n || this.i - from > MAX_STRING) throw new TomlError()
      const c = this.s[this.i]!
      if (c === '\n' || c === '\r') throw new TomlError()
      if (c === "'") { const v = this.s.slice(from, this.i); this.i++; return v }
      this.i++
    }
  }

  /** """…""" or '''…''': read past (never kept). Unterminated: nothing after it can be read. */
  private multiline(q: string): void {
    this.i += 3
    for (;;) {
      if (this.i >= this.n) throw new TomlError(true)
      const c = this.s[this.i]!
      if (q === '"' && c === '\\') { this.i += 2; continue }
      if (this.s.startsWith(q.repeat(3), this.i)) {
        this.i += 3
        // up to two more quotes belong to the string ("""a"""" ends with one quote in it)
        for (let k = 0; k < 2 && this.s[this.i] === q; k++) this.i++
        return
      }
      this.i++
    }
  }

  private spaces(): void {
    while (this.i < this.n && (this.s[this.i] === ' ' || this.s[this.i] === '\t')) this.i++
  }

  /** spaces, line ends and comments */
  private skipBlank(): void {
    while (this.i < this.n) {
      const c = this.s[this.i]
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') this.i++
      else if (c === '#') { const nl = this.s.indexOf('\n', this.i); this.i = nl === -1 ? this.n : nl + 1 }
      else return
    }
  }

  /** the end of a statement: spaces, maybe a comment, then a line end or the end of the file */
  private lineEnd(): void {
    this.spaces()
    if (this.s[this.i] === '#') { const nl = this.s.indexOf('\n', this.i); this.i = nl === -1 ? this.n : nl + 1; return }
    if (this.i >= this.n) return
    if (this.s[this.i] === '\n') { this.i++; return }
    if (this.s.startsWith('\r\n', this.i)) { this.i += 2; return }
    throw new TomlError()
  }
}

/** One line of text people can read: no control or text-direction characters, at most `max` characters. */
const plainName = (v: string, max: number): string | null => {
  const t = v.trim()
  if (!t || [...t].length > max || /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(t)) return null
  return t
}

/** An https address without a user, password, query, fragment or anything findSecrets flags; null otherwise. */
export function shareableUrl(raw: string): string | null {
  const v = raw.trim()
  if (!v || v.length > 500 || v.includes('?') || v.includes('#') || /\s/.test(v) || findSecrets(v).length) return null
  let u: URL
  try { u = new URL(v) } catch { return null }
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || !u.hostname) return null
  return u.href.length <= 500 && !findSecrets(u.href).length ? u.href : null
}

/**
 * The remote MCP servers of a Codex config.toml as share tools (see the top of this file): https streamable HTTP
 * servers only, each name once, at most SKILL_SHARE_LIMITS.tools. Never throws.
 */
export function codexTools(text: string): ShareToolIn[] {
  const r = new Reader(text.slice(0, CODEX_TOML_MAX_BYTES).replace(/^﻿/, ''))
  try { r.read() } catch { /* a reader bug: what was read before stays, nothing else */ }
  const out: ShareToolIn[] = []
  const seen = new Set<string>()
  for (const [rawName, s] of r.servers) {
    if (out.length >= SKILL_SHARE_LIMITS.tools) break
    if (s.broken || s.stdio || s.disabled || s.url === undefined) continue
    const name = plainName(rawName, 80)
    const url = shareableUrl(s.url)
    if (!name || !url || findSecrets(name).length) continue
    const key = name.normalize('NFC').toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const first = s.headers[0]
    if (s.bearer || (first && first.toLowerCase() === 'authorization') || (!first && s.helper)) out.push({ name, url, auth: 'bearer' })
    else if (first) out.push({ name, url, auth: 'header', header: first })
    else out.push({ name, url, auth: 'oauth' })
  }
  return out
}
