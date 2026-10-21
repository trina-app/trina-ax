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

/**
 * Removes MCP configuration from the file (default: the account's ~/.claude.json). Returns the removed key paths
 * (empty: nothing found, the file is not touched). A missing or unreadable file is left alone.
 */
export function guardClaudeJson(file = path.join(os.homedir(), '.claude.json')): string[] {
  let text: string
  let st: fs.Stats
  try {
    st = fs.lstatSync(file)
    if (!st.isFile()) return [] // a link or anything else: never written through
    text = fs.readFileSync(file, 'utf8')
  } catch { return [] }
  let j: unknown
  try { j = JSON.parse(text) } catch { return [] }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return []
  const removed = stripMcp(j as Record<string, unknown>)
  if (!removed.length) return []
  // same folder, then rename: the CLI never sees a half-written file
  const tmp = `${file}.tmp.teamax-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, JSON.stringify(j, null, 2), { mode: st.mode & 0o777, flag: 'wx' })
  fs.renameSync(tmp, file)
  return removed
}

/** Office mode with the Mac user's own login only (other modes keep the CLI's config inside the chat folder). */
export function claudeJsonGuarded(ctx: Pick<AppContext, 'config'>): boolean {
  return !!ctx.config.office && ctx.config.engine.authMode === 'local-login'
}

/** At server start and after every Claude turn in office mode; never throws. */
export function guardOfficeClaudeJson(ctx: Pick<AppContext, 'config' | 'db' | 'log'>, when: 'start' | 'turn', file?: string): string[] {
  if (!claudeJsonGuarded(ctx)) return []
  try {
    const removed = guardClaudeJson(file)
    if (removed.length) {
      ctx.log.warn('removed MCP servers from ~/.claude.json (office mode: an interactive claude would run them unsandboxed)', { when, keys: removed })
      audit(ctx.db, { actor: null, action: 'engine.claude_json_mcp_removed', target: '~/.claude.json', detail: { when, keys: removed.slice(0, 20) } })
    }
    return removed
  } catch (e) {
    ctx.log.warn('could not check ~/.claude.json for MCP servers', { err: e })
    return []
  }
}
