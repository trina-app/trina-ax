// grep / glob on ripgrep (design tab 2 "grep 구현"). The permission function decides the allowed roots first;
// ripgrep only receives those roots as positional paths, and every hidden sub-folder inside them as
// `--glob '!<path>'`, so folders the user cannot see are never opened. Every result path is checked again
// (access, name rules, regular file, nlink == 1) before it is shown.
import fs from 'node:fs'
import path from 'node:path'
import { atLeast, type Principal, type RuleSet } from '../policy/access'
import { visiblePath, type FsCtx } from '../policy/authorize'
import { ToolError } from '../policy/errors'
import { walk } from '../policy/resolve'
import { extractText, isOffice, OFFICE_EXT, type Tools } from './extract'
import { readRegular } from './store'

export const RG_BASE = ['--no-config', '--no-ignore', '--hidden', '--no-follow', '--one-file-system', '--max-filesize', '50M',
  '--regex-size-limit', '20M', '--dfa-size-limit', '50M', '--max-columns', '2000', '--max-columns-preview', '--no-messages']
const OFFICE_GLOB = `*.{${OFFICE_EXT.join(',')}}`

const under = (anc: string[], p: string[]) => p.length > anc.length && anc.every((s, i) => s === p[i])
const join = (s: string[]) => (s.length ? s.join('/') : '.')

/** Allowed search roots under `base` for this user, plus the sub-folders inside them that must be skipped. */
export function allowedRoots(fx: FsCtx, rules: RuleSet, user: Principal, base: string[]): { roots: string[]; excludes: string[] } {
  const acc = (s: string[]) => atLeast(rules.access(user, s), 'read')
  // access can only change at a rule folder, at users/<x>, or at .system — collect those under base
  const pts = new Map<string, string[]>()
  const add = (s: string[]) => { if (under(base, s)) pts.set(s.join('/'), s) }
  for (const f of rules.ruleFolders()) if (f !== '') add(f.split('/'))
  add(['users', user.id])
  add(['.system'])
  try { for (const n of fs.readdirSync(path.join(fx.root, 'users'))) add(['users', n]) } catch {}
  const sorted = [...pts.values()].sort((a, b) => a.length - b.length)
  const nearest = (p: string[]) => { let best = base; for (const q of sorted) if (under(q, p) && q.length > best.length) best = q; return best }
  const exists = (s: string[]) => { const w = walk(fx.root, s, false); return !w.problem && w.missing.length === 0 && w.actual.every((n, i) => n === s[i]) }
  const roots: string[] = []
  const excludes: string[] = []
  if (acc(base) && exists(base)) roots.push(join(base))
  for (const p of sorted) {
    const ra = acc(nearest(p)), rp = acc(p)
    if (rp && !ra && exists(p)) roots.push(join(p))
    if (!rp && ra) excludes.push(p.join('/'))
  }
  return { roots, excludes }
}

/** escape glob metacharacters in a literal path (names never contain backslashes) */
export const globEscape = (s: string) => s.replace(/[*?[\]{}!]/g, (c) => '\\' + c)
/** slash-containing globs are anchored at ripgrep's working directory (the team root), checked in tests */
export const excludeArgs = (excludes: string[]) => excludes.flatMap((x) => ['--glob', '!' + globEscape(x), '--glob', '!' + globEscape(x) + '/**'])

interface RgResult { code: number | null; killed: null | 'cap' | 'timeout'; err: string }
/** Run rg; `onRecord` gets each NUL- or newline-terminated record; return false to stop (result cap). */
export async function runRg(rg: string, args: string[], cwd: string, sep: '\n' | '\0', onRecord: (r: string) => boolean | void, timeoutMs: number): Promise<RgResult> {
  const p = Bun.spawn([rg, ...args], { cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: { PATH: '/usr/bin:/bin' } })
  let killed: RgResult['killed'] = null
  const t = setTimeout(() => { killed = 'timeout'; p.kill('SIGKILL') }, timeoutMs)
  const errP = new Response(p.stderr).text()
  const dec = new TextDecoder()
  let buf = ''
  try {
    outer: for await (const chunk of p.stdout) {
      buf += dec.decode(chunk, { stream: true })
      let i
      while ((i = buf.indexOf(sep)) >= 0) {
        const rec = buf.slice(0, i); buf = buf.slice(i + 1)
        if (rec && onRecord(rec) === false) { killed = 'cap'; p.kill('SIGKILL'); break outer }
      }
    }
  } catch {}
  if (!killed && buf) onRecord(buf)
  const code = await p.exited
  clearTimeout(t)
  return { code, killed, err: (await errP).slice(0, 2000) }
}

const strip = (p: string) => p.replace(/^\.\//, '')

// ---------------- office text sidecar cache ----------------
/** Extracted text of .docx/.pptx/.xlsx/.pdf files, mirrored under <dataDir>/textcache/<path>.txt (server-only). */
export class OfficeCache {
  private inflight = new Map<string, Promise<void>>()
  constructor(readonly dir: string, private fx: FsCtx, private tools: Tools) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }) }
  cachePath(rel: string) { return path.join(this.dir, rel + '.txt') }
  fresh(rel: string, st: fs.Stats) {
    try { return Math.floor(fs.statSync(this.cachePath(rel)).mtimeMs) === Math.floor(st.mtimeMs) } catch { return false }
  }
  /** (re)extract one file; content is read through the checked fd */
  update(rel: string): Promise<void> {
    const running = this.inflight.get(rel); if (running) return running
    const job = (async () => {
      const abs = path.join(this.fx.root, ...rel.split('/'))
      const { bytes, st } = readRegular(abs, 50 * 1024 * 1024)
      let text: string
      try { text = await extractText(rel, bytes, this.tools) } catch { text = '' }
      const dst = this.cachePath(rel)
      fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 })
      fs.writeFileSync(dst, text, { mode: 0o600 })
      fs.utimesSync(dst, st.atime, st.mtime)
    })().finally(() => this.inflight.delete(rel))
    this.inflight.set(rel, job)
    return job
  }
  /** Make sure cached text exists for the office files under the roots. Extracts at most `budget` now, the rest in the background. */
  async refresh(rg: string, roots: string[], excludes: string[], filter: (rel: string) => fs.Stats | null, budget = 40): Promise<{ pending: number }> {
    if (!roots.length) return { pending: 0 }
    const stale: string[] = []
    await runRg(rg, ['--files', '--null', ...RG_BASE, '--glob-case-insensitive', '--glob', OFFICE_GLOB, ...excludeArgs(excludes), '--', ...roots], this.fx.root, '\0', (r) => {
      const rel = strip(r); if (!isOffice(rel)) return
      const st = filter(rel); if (st && !this.fresh(rel, st)) stale.push(rel)
    }, 60000)
    const now = stale.slice(0, budget), later = stale.slice(budget)
    for (let i = 0; i < now.length; i += 4) await Promise.all(now.slice(i, i + 4).map((r) => this.update(r).catch(() => {})))
    if (later.length) void (async () => { for (const r of later) await this.update(r).catch(() => {}) })()
    return { pending: later.length }
  }
}

export interface SearchDeps { fx: FsCtx; rules: RuleSet; user: Principal; rg: string; timeoutMs: number; office: OfficeCache }

function rootsFor(d: SearchDeps, baseSegs: string[], baseIsFile: boolean) {
  if (baseIsFile) return { roots: visiblePath(d.fx, d.rules, d.user, baseSegs.join('/')) ? [baseSegs.join('/')] : [], excludes: [] }
  return allowedRoots(d.fx, d.rules, d.user, baseSegs)
}

// ---------------- glob ----------------
export async function globFiles(d: SearchDeps, baseSegs: string[], baseIsFile: boolean, pattern: string, limit = 100) {
  const { roots, excludes } = rootsFor(d, baseSegs, baseIsFile)
  if (!roots.length) return { files: [] as string[], truncated: false, filtered: 0 }
  const fold = (s: string) => (d.fx.caseInsensitive ? s.toLowerCase() : s)
  const g = new Bun.Glob(fold(pattern))
  const prefix = baseSegs.length ? baseSegs.join('/') + '/' : ''
  const hits: { rel: string; mtime: number }[] = []
  let filtered = 0
  const r = await runRg(d.rg, ['--files', '--null', ...RG_BASE, ...excludeArgs(excludes), '--', ...roots], d.fx.root, '\0', (rec) => {
    const rel = strip(rec)
    const relToBase = rel.startsWith(prefix) ? rel.slice(prefix.length) : rel
    if (!g.match(fold(relToBase)) && !g.match(fold(rel))) return
    const st = visiblePath(d.fx, d.rules, d.user, rel)
    if (st) hits.push({ rel, mtime: st.mtimeMs }); else filtered++
    if (hits.length >= 20000) return false
  }, d.timeoutMs)
  hits.sort((a, b) => b.mtime - a.mtime || a.rel.localeCompare(b.rel))
  return { files: hits.slice(0, limit).map((h) => h.rel), truncated: hits.length > limit || r.killed !== null, filtered }
}

// ---------------- grep ----------------
export interface GrepOpts {
  pattern: string; glob?: string; type?: string; mode: 'content' | 'files_with_matches' | 'count'
  ignoreCase?: boolean; lineNumbers: boolean; before: number; after: number; limit: number; multiline?: boolean
}

export async function grepFiles(d: SearchDeps, baseSegs: string[], baseIsFile: boolean, o: GrepOpts) {
  const { roots, excludes } = rootsFor(d, baseSegs, baseIsFile)
  const stats = { roots: roots.length, excludes: excludes.length, filtered: 0, officePending: 0 }
  if (!roots.length) return { text: 'No matches', truncated: false, stats, files: new Set<string>() }
  // user glob: basename-only globs go to ripgrep; globs with "/" are matched here against the result path
  if (o.glob?.startsWith('!')) throw new ToolError('negated globs are not supported')
  const pathGlob = o.glob && o.glob.includes('/') ? new Bun.Glob(o.glob) : null
  const nameGlob = o.glob && !o.glob.includes('/') ? o.glob : null
  const common: string[] = [...RG_BASE]
  if (o.type) common.push('--type', o.type)
  common.push(o.ignoreCase ? '-i' : '-s')
  if (o.multiline) common.push('-U', '--multiline-dotall')
  if (o.mode === 'content') { common.push('--json'); if (o.before) common.push('-B', String(o.before)); if (o.after) common.push('-A', String(o.after)) }
  else if (o.mode === 'count') common.push('--count-matches', '--with-filename', '--null')
  else common.push('--files-with-matches', '--null')

  const out: string[] = []
  /** files whose content (or the fact that they match) went into the result */
  const files = new Set<string>()
  const seen = new Map<string, boolean>()
  const ok = (shown: string, real: string) => {
    if (!seen.has(real)) {
      let v = !!visiblePath(d.fx, d.rules, d.user, real)
      if (!v) stats.filtered++
      if (v && pathGlob && !pathGlob.match(shown)) v = false
      seen.set(real, v)
    }
    return seen.get(real)!
  }
  let truncated = false
  const push = (s: string) => { if (out.length >= o.limit) { truncated = true; return false } out.push(s); return true }
  let last: { file: string; line: number } | null = null
  const handler = (map: (p: string) => { shown: string; real: string } | null) => (rec: string) => {
    if (o.mode === 'content') {
      let j: any; try { j = JSON.parse(rec) } catch { return }
      if (j.type !== 'match' && j.type !== 'context') return
      const raw = j.data.path.text ?? Buffer.from(j.data.path.bytes, 'base64').toString('utf8')
      const m = map(raw); if (!m || !ok(m.shown, m.real)) return
      const ln: number = j.data.line_number
      const text = (j.data.lines.text ?? Buffer.from(j.data.lines.bytes ?? '', 'base64').toString('utf8')).replace(/\r?\n$/, '')
      if (last && (last.file !== m.shown || ln > last.line + 1) && (o.before || o.after)) if (!push('--')) return false
      last = { file: m.shown, line: ln }
      const sep = j.type === 'match' ? ':' : '-'
      const pushed = push(o.lineNumbers ? `${m.shown}${sep}${ln}${sep}${text}` : `${m.shown}${sep}${text}`)
      if (pushed) files.add(m.real)
      return pushed
    }
    const parts = rec.split('\0')
    const m = map(parts[0].replace(/^\n/, '')); if (!m || !ok(m.shown, m.real)) return
    const pushed = push(o.mode === 'count' ? `${m.shown}:${(parts[1] ?? '').trim()}` : m.shown)
    if (pushed) files.add(m.real)
    return pushed
  }
  const recSep: '\n' | '\0' = o.mode === 'files_with_matches' ? '\0' : '\n'
  // later globs win in ripgrep: user glob first, then the exclusions
  const mainArgs = [...common, '--glob-case-insensitive', ...(nameGlob ? ['--glob', nameGlob] : []), '--glob', '!' + OFFICE_GLOB, ...excludeArgs(excludes), '-e', o.pattern, '--', ...roots.filter((r) => !isOffice(r))]
  const id = (p: string) => { const r = strip(p); return { shown: r, real: r } }
  const r1 = await runRg(d.rg, mainArgs, d.fx.root, recSep, handler(id), d.timeoutMs)
  if (r1.code === 2 && !r1.killed && !out.length && /regex|parse|error/i.test(r1.err)) throw new ToolError('invalid pattern: ' + r1.err.trim().split('\n').filter((l) => !/pcre2/i.test(l)).slice(-3).join(' ') + (/look-?around|backreference/i.test(r1.err) ? ' (look-around and backreferences are not supported)' : ''))
  if (r1.killed === 'timeout') return { text: (out.join('\n') || 'No matches') + '\n... (search stopped after the time limit)', truncated: true, stats, files }

  // office documents: the same ripgrep over the extracted-text cache, paths mapped back to the originals
  if (!truncated && !o.type) {
    const { pending } = await d.office.refresh(d.rg, roots, excludes, (rel) => visiblePath(d.fx, d.rules, d.user, rel))
    stats.officePending = pending
    const croots = roots.map((r) => (isOffice(r) ? r + '.txt' : r)).filter((r) => fs.existsSync(path.join(d.office.dir, r)))
    if (croots.length) {
      const nameG = nameGlob ? new Bun.Glob(nameGlob) : null
      const map = (p: string) => {
        const real = strip(p).replace(/\.txt$/, '')
        if (!isOffice(real)) return null
        if (nameG && !nameG.match(real.split('/').pop()!)) return null
        return { shown: real, real }
      }
      await runRg(d.rg, [...common, '--glob', '*.txt', ...excludeArgs(excludes), '-e', o.pattern, '--', ...croots], d.office.dir, recSep, handler(map), d.timeoutMs)
    }
  }
  let text = out.join('\n') || 'No matches'
  if (truncated) text += `\n... (results cut at ${o.limit}; narrow the search)`
  if (stats.officePending) text += `\n(${stats.officePending} office documents are still being indexed; search again in a minute for complete results)`
  return { text, truncated, stats, files }
}
