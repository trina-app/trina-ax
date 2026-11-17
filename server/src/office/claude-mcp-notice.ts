// The office owner's one-time notice (QA TC-4470): in office mode with this Mac's own Claude sign-in, the server empties
// the Claude Code connections (MCP servers) of this Mac user's ~/.claude.json at start and after every AI answer
// (engine/claude-json-guard.ts). A new install lists them and stops until the owner chooses; an installation that
// auto-updated into this got no word. Admin › Home now tells the owner once, from what the server already recorded:
// the audit entries engine.claude_json_mcp_removed (their `names`, or for entries older than that, the names in the copy
// they name). Closed, it never shows again (prefs.officeMcpNotice). docs/decisions/20261117-office-mcp-removed-notice.md
import os from 'node:os'
import path from 'node:path'
import type { Database } from 'bun:sqlite'
import type { OfficeClaudeMcpNotice } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { backupNames, claudeJsonGuarded, claudeMcpBackupDir } from '../engine/claude-json-guard'
import { officeHomeOf } from '../routes/office-update'

/** names listed at most; the rest are counted */
export const NOTICE_NAMES = 20
/** audit entries read at most (one per removal; a turn that plants again and again makes many) */
const ENTRIES = 500

/** `p` with the home folder as ~ */
const tilde = (p: string, home = os.homedir()) => (p === home || p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p)

/** What the owner's notice says, or null: not office mode with the Mac's own sign-in, or nothing was ever removed. */
export function claudeMcpNotice(ctx: Pick<AppContext, 'config'> & { db: Database }, home = os.homedir()): OfficeClaudeMcpNotice | null {
  if (!claudeJsonGuarded(ctx)) return null
  const rows = ctx.db.query("SELECT at, detail FROM audit_log WHERE action = 'engine.claude_json_mcp_removed' ORDER BY id LIMIT ?").all(ENTRIES) as { at: string; detail: string | null }[]
  if (!rows.length) return null
  const dir = claudeMcpBackupDir(ctx)
  const names = new Set<string>()
  for (const r of rows) {
    let d: { names?: unknown; backup?: unknown } = {}
    try { d = JSON.parse(r.detail ?? '{}') } catch {}
    const listed = Array.isArray(d.names) ? d.names.map(String) : typeof d.backup === 'string' ? backupNames(dir, d.backup) ?? [] : []
    for (const n of listed) { const v = n.replace(/\s+/g, ' ').trim().slice(0, 80); if (v) names.add(v) }
  }
  const all = [...names]
  const inst = officeHomeOf(ctx.config)
  return {
    firstAt: rows[0]!.at,
    names: all.slice(0, NOTICE_NAMES),
    moreNames: Math.max(0, all.length - NOTICE_NAMES),
    backupFolder: tilde(dir, home),
    teamax: tilde(inst ? path.join(inst, 'teamax') : path.join(home, 'TeamAX', 'teamax'), home),
  }
}
