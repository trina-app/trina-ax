// Office mode keeps the Mac user's ~/.claude.json free of MCP servers (security round 4, engine-local).
// Office engines run with the Mac user's own Claude login (authMode local-login), so the sandbox must let them write
// ~/.claude.json: the CLI keeps its login state there. The same file holds the user-scope MCP servers ("mcpServers")
// and per-project MCP approvals. A turn whose tool lockdown failed could plant a server there ({"command": "/bin/sh"}),
// and the next interactive `claude` the Mac user starts (for example /login when the login expires) would run it
// outside every sandbox, as that user: tunnel token, app.db, the team folder, the office CA key. Engine turns never
// load it (--strict-mcp-config, --setting-sources ''), so office mode removes whatever MCP configuration it finds there,
// at server start and after every Claude turn: the values are emptied, every other key stays as it was, and the
// removal is written to the log and the audit list. The office Mac is dedicated to Team AX (docs/OFFICE.md 8).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AppContext } from '../context'
import { audit } from '../admin/audit'

/** keys (top level and in projects[*]) that make an interactive `claude` start MCP servers */
const PROJECT_KEYS = ['mcpServers', 'enabledMcpjsonServers', 'enableAllProjectMcpServers'] as const

const nonEmpty = (k: string, v: unknown): boolean =>
  k === 'enableAllProjectMcpServers' ? v === true
    : Array.isArray(v) ? v.length > 0
      : !!v && typeof v === 'object' && Object.keys(v).length > 0

/** Empties the MCP keys of a parsed ~/.claude.json in place; returns the key paths that held something. */
export function stripMcp(j: Record<string, unknown>): string[] {
  const out: string[] = []
  const clear = (o: Record<string, unknown>, at: string) => {
    for (const k of PROJECT_KEYS) {
      if (!(k in o) || !nonEmpty(k, o[k])) continue
      out.push(`${at}${k}`)
      o[k] = k === 'enableAllProjectMcpServers' ? false : Array.isArray(o[k]) ? [] : {}
    }
  }
  clear(j, '')
  const projects = j.projects
  if (projects && typeof projects === 'object' && !Array.isArray(projects)) {
    for (const [p, v] of Object.entries(projects as Record<string, unknown>)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) clear(v as Record<string, unknown>, `projects[${JSON.stringify(p)}].`)
    }
  }
  return out
}

export interface GuardOptions {
  /** the account's home: a link at the file may keep the content it points to only when that is a regular file in it */
  home?: string
  /** folders whose files are never copied into the file through a link (Team AX's own data, team folder, config) */
  privateDirs?: string[]
}

const inside = (dir: string, p: string) => { const r = path.relative(dir, p); return r === '' || (!!r && !r.startsWith('..') && !path.isAbsolute(r)) }

/** a JSON object, or null */
function parseObject(text: string): Record<string, unknown> | null {
  try { const j = JSON.parse(text); return j && typeof j === 'object' && !Array.isArray(j) ? j as Record<string, unknown> : null } catch { return null }
}

/** same folder, then rename: the CLI never sees a half-written file, and a link at `file` is replaced, not followed */
function replaceWith(file: string, j: Record<string, unknown>, mode: number) {
  const tmp = `${file}.tmp.teamax-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, JSON.stringify(j, null, 2), { mode, flag: 'wx' })
  fs.renameSync(tmp, file)
}

/** What a link at the file may keep (security round 4b): the content it points to when that is a regular file inside
 * the account's home and outside Team AX's own folders, else nothing ({}): a link out of the home, to a folder, to the
 * server's config or to a file a turn controls must not become the Mac user's Claude config. */
function linkedContent(file: string, o: GuardOptions): Record<string, unknown> {
  const home = o.home ?? os.homedir()
  let target: string
  try { target = fs.realpathSync(file) } catch { return {} }
  let realHome = home
  try { realHome = fs.realpathSync(home) } catch {}
  if (!inside(realHome, target) || target === realHome) return {}
  for (const d of o.privateDirs ?? []) {
    let rd = d
    try { rd = fs.realpathSync(d) } catch {}
    if (inside(rd, target)) return {}
  }
  try {
    const st = fs.lstatSync(target)
    if (!st.isFile()) return {}
    return parseObject(fs.readFileSync(target, 'utf8')) ?? {}
  } catch { return {} }
}

/**
 * Removes MCP configuration from the file (default: the account's ~/.claude.json). Returns the removed key paths
 * (empty: nothing found, the file is not touched). A missing or unreadable file is left alone. A symbolic link at the
 * file is replaced by a regular file (round 4b: before, a link was skipped, so a server planted in the file it points to
 * survived until the next interactive `claude`): with the cleaned content it pointed to when that is a regular file in
 * the home (and not in `privateDirs`), else an empty config `{}`; the result then starts with "(link replaced)". A file
 * with other hard links is written as a new file too ("(hard link replaced)").
 */
export function guardClaudeJson(file = path.join(os.homedir(), '.claude.json'), o: GuardOptions = {}): string[] {
  let st: fs.Stats
  try { st = fs.lstatSync(file) } catch { return [] }
  if (st.isSymbolicLink()) {
    const j = linkedContent(file, o)
    const removed = stripMcp(j)
    replaceWith(file, j, 0o600)
    return ['(link replaced)', ...removed]
  }
  if (!st.isFile()) return [] // a folder or anything else: nothing the CLI reads as its config
  let text: string
  try { text = fs.readFileSync(file, 'utf8') } catch { return [] }
  const j = parseObject(text)
  if (!j) return []
  const removed = stripMcp(j)
  const linked = st.nlink > 1
  if (!removed.length && !linked) return []
  replaceWith(file, j, st.mode & 0o777)
  return linked ? ['(hard link replaced)', ...removed] : removed
}

/** The Claude config files of an account the CLI may load or restore from: ~/.claude.json, the older
 * ~/.claude.json.backup and every ~/.claude/backups/.claude.json.backup.<time> (it restores the newest when the config
 * is unreadable). A link in place of the backups folder is removed (the CLI would follow it). */
export function claudeJsonFiles(home = os.homedir()): string[] {
  const out = [path.join(home, '.claude.json'), path.join(home, '.claude.json.backup')]
  const dir = path.join(home, '.claude', 'backups')
  try {
    const st = fs.lstatSync(dir)
    if (st.isSymbolicLink()) fs.unlinkSync(dir)
    else if (st.isDirectory()) for (const n of fs.readdirSync(dir)) if (n.startsWith('.claude.json.backup')) out.push(path.join(dir, n))
  } catch {}
  return out
}

/** guardClaudeJson on every file of claudeJsonFiles; returns "<file name>: <key path>" for each finding */
export function guardClaudeJsonFamily(home = os.homedir(), o: Omit<GuardOptions, 'home'> = {}): string[] {
  const out: string[] = []
  for (const f of claudeJsonFiles(home)) {
    try { for (const k of guardClaudeJson(f, { ...o, home })) out.push(`${path.relative(home, f)}: ${k}`) } catch {}
  }
  return out
}

/** Office mode with the Mac user's own login only (other modes keep the CLI's config inside the chat folder). */
export function claudeJsonGuarded(ctx: Pick<AppContext, 'config'>): boolean {
  return !!ctx.config.office && ctx.config.engine.authMode === 'local-login'
}

/** At server start and after every Claude turn in office mode (~/.claude.json and its backups); never throws. `home`:
 * tests (a fake home). */
export function guardOfficeClaudeJson(ctx: Pick<AppContext, 'config' | 'db' | 'log'>, when: 'start' | 'turn', home?: string): string[] {
  if (!claudeJsonGuarded(ctx)) return []
  try {
    const privateDirs = [path.dirname(ctx.config.dataDir), ctx.config.dataDir, ctx.config.teamRoot]
    const removed = guardClaudeJsonFamily(home ?? os.homedir(), { privateDirs })
    if (removed.length) {
      ctx.log.warn('removed MCP servers or a link from ~/.claude.json (office mode: an interactive claude would run them unsandboxed)', { when, keys: removed })
      audit(ctx.db, { actor: null, action: 'engine.claude_json_mcp_removed', target: '~/.claude.json', detail: { when, keys: removed.slice(0, 20) } })
    }
    return removed
  } catch (e) {
    ctx.log.warn('could not check ~/.claude.json for MCP servers', { err: e })
    return []
  }
}
