// Office mode keeps the Mac user's ~/.claude.json free of MCP servers (security round 4, engine-local).
// Office engines run with the Mac user's own Claude login (authMode local-login), so the sandbox must let them write
// ~/.claude.json: the CLI keeps its login state there. The same file holds the user-scope MCP servers ("mcpServers")
// and per-project MCP approvals. A turn whose tool lockdown failed could plant a server there ({"command": "/bin/sh"}),
// and the next interactive `claude` the Mac user starts (for example /login when the login expires) would run it
// outside every sandbox, as that user: tunnel token, app.db, the team folder, the office CA key. Engine turns never
// load it (--strict-mcp-config, --setting-sources ''), so office mode removes whatever MCP configuration it finds there,
// at server start and after every Claude turn: the values are emptied, every other key stays as it was, and the
// removal is written to the log and the audit list. The office Mac is dedicated to this server (docs/OFFICE.md 8).
// Nothing is removed without a copy (0.2.19, office test O3: on a Mac its owner also used for Claude Code it silently
// deleted their MCP servers): what is emptied is first saved to <home>/config/claude-mcp-backups/ (700, files 600,
// where no engine turn can read or write), and office-install.sh lists what would go (findClaudeJsonMcp), stops a new
// install until the owner agrees (--remove-claude-mcp) or picks the setup-token mode, which never touches the file,
// and then saves the copy itself before the server first starts (office/claude-mcp.ts).
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AppContext } from '../context'
import { audit } from '../admin/audit'
import { resolveLayout } from '../system/layout'

/** keys (top level and in projects[*]) that make an interactive `claude` start MCP servers */
const PROJECT_KEYS = ['mcpServers', 'enabledMcpjsonServers', 'enableAllProjectMcpServers'] as const
export type McpKey = typeof PROJECT_KEYS[number]

/** one MCP setting taken out of a Claude config: its project (null: user scope), its key and what it held */
export interface McpEntry { project: string | null; key: McpKey; value: unknown }

const nonEmpty = (k: string, v: unknown): boolean =>
  k === 'enableAllProjectMcpServers' ? v === true
    : Array.isArray(v) ? v.length > 0
      : !!v && typeof v === 'object' && Object.keys(v).length > 0

/** "mcpServers" or "projects[\"/Users/x/app\"].mcpServers" */
export const mcpKeyPath = (e: Pick<McpEntry, 'project' | 'key'>) => e.project === null ? e.key : `projects[${JSON.stringify(e.project)}].${e.key}`

/** the server names an entry holds (mcpServers: its keys; enabledMcpjsonServers: its names; the switch: none) */
export function mcpNames(e: Pick<McpEntry, 'value'>): string[] {
  const v = e.value
  if (Array.isArray(v)) return v.map((x) => String(x))
  return v && typeof v === 'object' ? Object.keys(v) : []
}

/** Empties the MCP keys of a parsed ~/.claude.json in place; returns what they held. */
export function takeMcp(j: Record<string, unknown>): McpEntry[] {
  const out: McpEntry[] = []
  const clear = (o: Record<string, unknown>, project: string | null) => {
    for (const k of PROJECT_KEYS) {
      if (!(k in o) || !nonEmpty(k, o[k])) continue
      out.push({ project, key: k, value: o[k] })
      o[k] = k === 'enableAllProjectMcpServers' ? false : Array.isArray(o[k]) ? [] : {}
    }
  }
  clear(j, null)
  const projects = j.projects
  if (projects && typeof projects === 'object' && !Array.isArray(projects)) {
    for (const [p, v] of Object.entries(projects as Record<string, unknown>)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) clear(v as Record<string, unknown>, p)
    }
  }
  return out
}

/** Empties the MCP keys of a parsed ~/.claude.json in place; returns the key paths that held something. */
export function stripMcp(j: Record<string, unknown>): string[] {
  return takeMcp(j).map(mcpKeyPath)
}

export interface GuardOptions {
  /** the account's home: a link at the file may keep the content it points to only when that is a regular file in it */
  home?: string
  /** folders whose files are never copied into the file through a link (the server's own data, team folder, config) */
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
 * the account's home and outside the server's own folders, else nothing ({}): a link out of the home, to a folder, to the
 * server's config or to a file a turn controls must not become the Mac user's Claude config. */
function linkedContent(file: string, o: GuardOptions): { j: Record<string, unknown>; copied: boolean } {
  const none = { j: {}, copied: false }
  const home = o.home ?? os.homedir()
  let target: string
  try { target = fs.realpathSync(file) } catch { return none }
  let realHome = home
  try { realHome = fs.realpathSync(home) } catch {}
  if (!inside(realHome, target) || target === realHome) return none
  for (const d of o.privateDirs ?? []) {
    let rd = d
    try { rd = fs.realpathSync(d) } catch {}
    if (inside(rd, target)) return none
  }
  try {
    const st = fs.lstatSync(target)
    if (!st.isFile()) return none
    const j = parseObject(fs.readFileSync(target, 'utf8'))
    return j ? { j, copied: true } : none
  } catch { return none }
}

/** What the guard would write in place of a file: its cleaned content, the mode and what it takes out of it. */
interface Plan {
  file: string; j: Record<string, unknown>; mode: number; taken: McpEntry[]; note: '(link replaced)' | '(hard link replaced)' | null
  /** a link: false when what it points to is not copied (outside the home, the server's folders, not a JSON file) */
  linkCopied?: boolean
}

/** Reads the file and works out what the guard does with it; writes nothing. null: the file is left alone. */
function planGuard(file: string, o: GuardOptions): Plan | null {
  let st: fs.Stats
  try { st = fs.lstatSync(file) } catch { return null }
  if (st.isSymbolicLink()) {
    const { j, copied } = linkedContent(file, o)
    return { file, j, mode: 0o600, taken: takeMcp(j), note: '(link replaced)', linkCopied: copied }
  }
  if (!st.isFile()) return null // a folder or anything else: nothing the CLI reads as its config
  let text: string
  try { text = fs.readFileSync(file, 'utf8') } catch { return null }
  const j = parseObject(text)
  if (!j) return null
  const taken = takeMcp(j)
  const linked = st.nlink > 1
  if (!taken.length && !linked) return null
  return { file, j, mode: st.mode & 0o777, taken, note: linked ? '(hard link replaced)' : null }
}

const planKeys = (p: Plan) => [...(p.note ? [p.note] : []), ...p.taken.map(mcpKeyPath)]

/**
 * Removes MCP configuration from the file (default: the account's ~/.claude.json). Returns the removed key paths
 * (empty: nothing found, the file is not touched). A missing or unreadable file is left alone. A symbolic link at the
 * file is replaced by a regular file (round 4b: before, a link was skipped, so a server planted in the file it points to
 * survived until the next interactive `claude`): with the cleaned content it pointed to when that is a regular file in
 * the home (and not in `privateDirs`), else an empty config `{}`; the result then starts with "(link replaced)". A file
 * with other hard links is written as a new file too ("(hard link replaced)"). Keeps no copy: guardClaudeJsonFamily
 * with `backupDir` does.
 */
export function guardClaudeJson(file = path.join(os.homedir(), '.claude.json'), o: GuardOptions = {}): string[] {
  const p = planGuard(file, o)
  if (!p) return []
  replaceWith(p.file, p.j, p.mode)
  return planKeys(p)
}

/** The Claude config files of an account the CLI may load or restore from: ~/.claude.json, the older
 * ~/.claude.json.backup and every ~/.claude/backups/.claude.json.backup.<time> (it restores the newest when the config
 * is unreadable). A link in place of the backups folder is removed (the CLI would follow it), unless `readOnly`. */
export function claudeJsonFiles(home = os.homedir(), o: { readOnly?: boolean } = {}): string[] {
  const out = [path.join(home, '.claude.json'), path.join(home, '.claude.json.backup')]
  const dir = path.join(home, '.claude', 'backups')
  try {
    const st = fs.lstatSync(dir)
    if (st.isSymbolicLink()) { if (!o.readOnly) fs.unlinkSync(dir) }
    else if (st.isDirectory()) for (const n of fs.readdirSync(dir)) if (n.startsWith('.claude.json.backup')) out.push(path.join(dir, n))
  } catch {}
  return out
}

/** where office mode keeps what it removed, in the installation's secrets folder (<home>/config: 700, no engine turn
 * can read or write it, not in backups or archives) */
export const CLAUDE_MCP_BACKUPS = 'claude-mcp-backups'
const BACKUP_FILE = /^claude-mcp-.+\.json$/
/** copies made after a turn (a turn may plant servers again and again) are kept up to this many, the newest; copies
 * made by the installer or at a server start (what was there before the server, or added while it was stopped) are
 * never removed */
const KEEP_TURN_BACKUPS = 20
/** values beyond this many characters in one copy are left out (their names are kept) */
const BACKUP_MAX_CHARS = 4 * 1024 * 1024

export interface McpBackup {
  savedAt: string
  /** 'install': saved by office-install.sh before the server first removes them; 'start': found at a server start;
   * 'turn': found after an AI turn. Any of them may hold a server a turn planted (a start after a turn the server could
   * not clean up after), so restore lists every command and asks for --yes. */
  when: string
  /** the account's home the entries came from (files are relative to it) */
  home: string
  note: string
  files: Record<string, (McpEntry | { project: string | null; key: McpKey; names: string[]; omitted: string; sha256: string })[]>
}

/** Saves what the plans take out to a new file in `dir` (700, the file 600, never over another file); returns its path.
 * A link in place of `dir` is refused. When the newest copy there holds exactly the same settings, no new file is made
 * and that copy's path is returned (the installer's copy and the first start's, or one server planted again). */
export function saveMcpBackup(dir: string, home: string, plans: Pick<Plan, 'file' | 'taken'>[], when: string, now = new Date()): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (!fs.lstatSync(dir).isDirectory()) throw new Error(`${dir} is not a folder`)
  fs.chmodSync(dir, 0o700)
  let chars = 0
  const files: McpBackup['files'] = {}
  for (const p of plans) {
    if (!p.taken.length) continue
    files[path.relative(home, p.file)] = p.taken.map((e) => {
      const text = JSON.stringify(e.value) ?? ''
      chars += text.length
      return chars <= BACKUP_MAX_CHARS ? { project: e.project, key: e.key, value: e.value }
        : { project: e.project, key: e.key, names: mcpNames(e), omitted: `too large to keep (${text.length} characters)`, sha256: crypto.createHash('sha256').update(text).digest('hex') }
    })
  }
  const doc: McpBackup = {
    savedAt: now.toISOString(), when, home,
    note: `MCP settings the office server removed from this Mac account's Claude config (${when === 'turn' ? 'after an AI turn, which may have put them there' : when === 'install' ? 'saved by the installer' : 'at a server start'}). `
      + 'Check every command before you put one back: `teamax claude-mcp restore <this file>` lists them, once the server no longer removes them (the setup-token mode, or after `teamax uninstall-agent`).',
    files,
  }
  const newest = listMcpBackups(dir).at(-1)
  if (newest) {
    try { if (JSON.stringify((JSON.parse(fs.readFileSync(newest, 'utf8')) as McpBackup).files) === JSON.stringify(files)) return newest } catch {}
  }
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  const tmp = path.join(dir, `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  try {
    for (let i = 1; ; i++) {
      const f = path.join(dir, `claude-mcp-${stamp}-${when}${i > 1 ? `-${i}` : ''}.json`)
      try { fs.linkSync(tmp, f) } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || i >= 100) throw e
        continue
      }
      if (when === 'turn') try { pruneTurnBackups(dir) } catch {} // the copy is saved; pruning is housekeeping
      return f
    }
  } finally { fs.rmSync(tmp, { force: true }) }
}

/** oldest first: by time, then the -2, -3 ... of copies made in the same millisecond */
const byAge = (a: string, b: string) => {
  const key = (n: string) => n.replace(/-(\d+)\.json$/, (_, d: string) => `~${d.padStart(4, '0')}`).replace(/\.json$/, '~0001')
  return key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0
}

function pruneTurnBackups(dir: string) {
  const turn = fs.readdirSync(dir).filter((n) => BACKUP_FILE.test(n) && /-turn(-\d+)?\.json$/.test(n)).sort(byAge)
  for (const n of turn.slice(0, Math.max(0, turn.length - KEEP_TURN_BACKUPS))) fs.rmSync(path.join(dir, n), { force: true })
}

/** the copies in `dir`, oldest first */
export function listMcpBackups(dir: string): string[] {
  let names: string[] = []
  try { names = fs.readdirSync(dir) } catch {}
  return names.filter((n) => BACKUP_FILE.test(n)).sort(byAge).map((n) => path.join(dir, n))
}

export interface FamilyResult {
  /** "<file name>: <key path>" for each finding */
  removed: string[]
  /** the copy of what was removed (null: nothing to keep, or no backupDir) */
  backup: string | null
  /** why the copy could not be saved (the settings were removed anyway: the guard is a security boundary) */
  backupError: string | null
}

/** guardClaudeJson on every file of claudeJsonFiles. With `backupDir`, what is removed is saved there first (one file
 * for all of them); a copy that cannot be saved does not stop the removal (backupError says why). */
export function guardClaudeJsonFamilyKeep(home = os.homedir(), o: Omit<GuardOptions, 'home'> & { backupDir?: string; when?: string } = {}): FamilyResult {
  const plans: Plan[] = []
  for (const f of claudeJsonFiles(home)) {
    try { const p = planGuard(f, { ...o, home }); if (p) plans.push(p) } catch {}
  }
  let backup: string | null = null
  let backupError: string | null = null
  if (o.backupDir && plans.some((p) => p.taken.length)) {
    try { backup = saveMcpBackup(o.backupDir, home, plans, o.when ?? 'start') } catch (e) { backupError = (e as Error).message }
  }
  const removed: string[] = []
  for (const p of plans) {
    try { replaceWith(p.file, p.j, p.mode); for (const k of planKeys(p)) removed.push(`${path.relative(home, p.file)}: ${k}`) } catch {}
  }
  return { removed, backup, backupError }
}

/** guardClaudeJson on every file of claudeJsonFiles; returns "<file name>: <key path>" for each finding (no copy) */
export function guardClaudeJsonFamily(home = os.homedir(), o: Omit<GuardOptions, 'home'> = {}): string[] {
  return guardClaudeJsonFamilyKeep(home, o).removed
}

export interface McpFinding {
  /** relative to the home: .claude.json, .claude.json.backup, .claude/backups/.claude.json.backup.<time> */
  file: string
  /** the file is a link (it becomes a regular file; what it points to is not changed) or has other hard links */
  note: Plan['note']
  /** where a link points */
  target?: string
  /** a link whose target is not copied: the file becomes an empty config {} */
  emptied?: boolean
  entries: McpEntry[]
}

/** What the guard would do to the account's Claude config files, without changing anything (office-install.sh,
 * `teamax claude-mcp check`). `backupsLink`: a link in place of ~/.claude/backups, which it removes. */
export function findClaudeJsonMcp(home = os.homedir(), o: Omit<GuardOptions, 'home'> = {}): { findings: McpFinding[]; backupsLink: boolean } {
  const findings: McpFinding[] = []
  for (const f of claudeJsonFiles(home, { readOnly: true })) {
    let p: Plan | null = null
    try { p = planGuard(f, { ...o, home }) } catch {}
    if (!p) continue
    let target: string | undefined
    if (p.note === '(link replaced)') try { target = fs.readlinkSync(f) } catch {}
    findings.push({ file: path.relative(home, f), note: p.note, ...(target ? { target } : {}), ...(p.linkCopied === false ? { emptied: true } : {}), entries: p.taken })
  }
  let backupsLink = false
  try { backupsLink = fs.lstatSync(path.join(home, '.claude', 'backups')).isSymbolicLink() } catch {}
  return { findings, backupsLink }
}

/** Office mode with the Mac user's own login only (other modes keep the CLI's config inside the chat folder). */
export function claudeJsonGuarded(ctx: Pick<AppContext, 'config'>): boolean {
  return !!ctx.config.office && ctx.config.engine.authMode === 'local-login'
}

/** the installation's copies of removed MCP settings (<home>/config/claude-mcp-backups in office mode) */
export function claudeMcpBackupDir(ctx: Pick<AppContext, 'config'>): string {
  return path.join(resolveLayout(ctx.config).secretsDir, CLAUDE_MCP_BACKUPS)
}

/** At server start and after every Claude turn in office mode (~/.claude.json and its backups); never throws. What it
 * removes is saved to claudeMcpBackupDir first. `home`: tests (a fake home). */
export function guardOfficeClaudeJson(ctx: Pick<AppContext, 'config' | 'db' | 'log'>, when: 'start' | 'turn', home?: string): string[] {
  if (!claudeJsonGuarded(ctx)) return []
  try {
    const privateDirs = [path.dirname(ctx.config.dataDir), ctx.config.dataDir, ctx.config.teamRoot]
    const r = guardClaudeJsonFamilyKeep(home ?? os.homedir(), { privateDirs, backupDir: claudeMcpBackupDir(ctx), when })
    if (r.backupError) ctx.log.error('could not save a copy of the MCP settings before removing them from ~/.claude.json', { when, err: r.backupError })
    if (r.removed.length) {
      ctx.log.warn('removed MCP servers or a link from ~/.claude.json (office mode: an interactive claude would run them unsandboxed)', { when, keys: r.removed, backup: r.backup })
      audit(ctx.db, { actor: null, action: 'engine.claude_json_mcp_removed', target: '~/.claude.json', detail: { when, keys: r.removed.slice(0, 20), ...(r.backup ? { backup: path.basename(r.backup) } : {}) } })
    }
    return r.removed
  } catch (e) {
    ctx.log.warn('could not check ~/.claude.json for MCP servers', { err: e })
    return []
  }
}
