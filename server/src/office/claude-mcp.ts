// `teamax claude-mcp check | backups | restore FILE [--yes] | save` (docs/OFFICE.md 8, office test O3). With this Mac's own
// Claude login (local-login, the default) the server empties the MCP settings of the Mac user's ~/.claude.json and its
// backups at every start and after every AI turn (engine/claude-json-guard.ts), saving a copy to
// <home>/config/claude-mcp-backups first. office-install.sh runs `check` before anything is installed: it says what
// would be removed and a new install stops until the owner agrees (--remove-claude-mcp) or uses the setup-token mode,
// in which the server never touches ~/.claude.json; then `save` keeps a copy before the server first starts (the
// install stops when it cannot). `restore` lists a copy's servers and, with --yes, merges it back once the server no
// longer removes them.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  CLAUDE_MCP_BACKUPS, findClaudeJsonMcp, listMcpBackups, mcpKeyPath, mcpNames, saveMcpBackup, type McpBackup, type McpEntry, type McpFinding,
} from '../engine/claude-json-guard'
import { loadSettings, officePaths } from './settings'

/** exit code of `check` when something would be removed or changed */
export const FOUND = 3

export const backupDirOf = (home: string) => path.join(officePaths(home).config, CLAUDE_MCP_BACKUPS)

const shown = (rel: string) => `~/${rel}`
const list = (names: string[]) => names.length > 6 ? `${names.slice(0, 6).join(', ')} and ${names.length - 6} more` : names.join(', ')

function entryLine(e: McpEntry): string {
  const where = e.project === null ? 'user scope' : `project ${e.project}`
  const n = mcpNames(e)
  if (e.key === 'mcpServers') return `${where}: ${n.length} MCP server${n.length === 1 ? '' : 's'} (${list(n)})`
  if (e.key === 'enabledMcpjsonServers') return `${where}: approved .mcp.json server${n.length === 1 ? '' : 's'} (${list(n)})`
  return `${where}: every .mcp.json server approved`
}

/** one line for the headline: "2 user MCP servers, MCP settings of 4 projects" */
export function countText(f: McpFinding | undefined): string {
  if (!f) return ''
  const user = f.entries.filter((e) => e.project === null && e.key === 'mcpServers').reduce((n, e) => n + mcpNames(e).length, 0)
  const userOther = f.entries.some((e) => e.project === null && e.key !== 'mcpServers')
  const projects = new Set(f.entries.filter((e) => e.project !== null).map((e) => e.project)).size
  const parts = [
    ...(user ? [`${user} user MCP server${user === 1 ? '' : 's'}`] : []),
    ...(userOther ? ['user-scope .mcp.json approvals'] : []),
    ...(projects ? [`MCP settings of ${projects} project${projects === 1 ? '' : 's'}`] : []),
  ]
  return parts.join(', ')
}

/** What the server would remove or change, as lines for a person (empty: nothing). */
export function findingLines(r: ReturnType<typeof findClaudeJsonMcp>): string[] {
  const out: string[] = []
  for (const f of r.findings) {
    const name = shown(f.file)
    if (f.note === '(link replaced)') out.push(`${name} is a link${f.target ? ` to ${f.target}` : ''}: it becomes ${f.emptied ? 'an empty Claude config {} (what it points to is outside your home or in the server\'s folders, or not a JSON file, and is not copied)' : 'a regular file with that content'}; the file it points to is not changed`)
    if (f.note === '(hard link replaced)') out.push(`${name} has other hard links: it is written as a new file`)
    if (f.file === '.claude.json') for (const e of f.entries) out.push(`${name}: ${entryLine(e)}`)
    else if (f.entries.length) out.push(`${name} (an older copy the Claude CLI keeps): ${f.entries.length} MCP setting${f.entries.length === 1 ? '' : 's'} (${list(f.entries.map(mcpKeyPath))})`)
  }
  if (r.backupsLink) out.push('~/.claude/backups is a link: it is removed (the folder it points to is not changed)')
  return out
}

export function headline(r: ReturnType<typeof findClaudeJsonMcp>): string {
  const main = countText(r.findings.find((f) => f.file === '.claude.json'))
  const copies = r.findings.filter((f) => f.file !== '.claude.json' && f.entries.length).length
  const what = [main, ...(copies ? [`the same kind of settings in ${copies} older cop${copies === 1 ? 'y' : 'ies'} the Claude CLI keeps`] : [])].filter(Boolean).join('; ')
  return what ? `this Mac account's Claude config (~/.claude.json) has MCP settings this server removes: ${what}`
    : 'this server would change this Mac account\'s Claude config files (~/.claude.json): a link or hard link it replaces'
}

/** the folders whose files are never copied into the config through a link (as the server's guard) */
const privateDirsOf = (home: string) => { const p = officePaths(home); return [p.home, p.data, p.team] }

function userHomeOf(args: string[], env: Record<string, string | undefined>): string {
  const i = args.indexOf('--user-home')
  return path.resolve(i >= 0 && args[i + 1] ? args[i + 1]! : env.HOME || os.homedir())
}

/** read-only: what the server would remove from this Mac account's Claude config (office-install.sh, configure) */
export function scanClaudeMcp(home: string, userHome: string) {
  return findClaudeJsonMcp(userHome, { privateDirs: privateDirsOf(home) })
}

/** The installation may remove (and its engine read) MCP settings now: its LaunchAgent is installed and either
 * office.env or the server.json the running server was started with says local-login (`teamax configure
 * --claude-token-file` without `teamax restart` leaves the running server on this Mac's login). */
export function guardActive(home: string, env: Record<string, string | undefined> = process.env): boolean {
  const s = loadSettings(home)
  const p = officePaths(home, env)
  if (!fs.existsSync(p.plist(s.label))) return false
  if (s.claudeAuth === 'local-login') return true
  try { return (JSON.parse(fs.readFileSync(p.serverJson, 'utf8')) as { engine?: { authMode?: string } }).engine?.authMode !== 'subscription' } catch { return true }
}

function readBackup(file: string): McpBackup {
  let j: McpBackup
  try { j = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) { throw new Error(`${file}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`) }
  if (!j || typeof j !== 'object' || !j.files || typeof j.files !== 'object') throw new Error(`${file} is not a copy of MCP settings`)
  return j
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
/** the one name whose assignment reaches Object.prototype (a copy may hold what a turn planted); with own-property
 * checks every other name ("constructor", "toString") is an ordinary key */
const UNSAFE = new Set(['__proto__'])
const own = (o: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(o, k)

/** what a server would run: its command line or address */
function serverWhat(v: unknown): string {
  if (!isObj(v)) return '?'
  if (typeof v.url === 'string') return v.url
  const args = Array.isArray(v.args) ? v.args.map((a) => String(a)) : []
  return [String(v.command ?? '?'), ...args].join(' ').slice(0, 200)
}

/** Merges the copy's ~/.claude.json entries into `cfg` without replacing anything there; returns what it added and
 * what it left out (names that are not plain keys). Only own properties are read or written. */
export function mergeBackup(cfg: Record<string, unknown>, entries: McpBackup['files'][string]): { added: string[]; skipped: string[] } {
  const added: string[] = []
  const skipped: string[] = []
  for (const e of entries) {
    if (!('value' in e)) continue // left out of the copy (too large)
    if (e.key !== 'mcpServers' && e.key !== 'enabledMcpjsonServers' && e.key !== 'enableAllProjectMcpServers') continue
    let o: Record<string, unknown> = cfg
    if (e.project !== null) {
      if (typeof e.project !== 'string' || UNSAFE.has(e.project)) { skipped.push(`project ${JSON.stringify(e.project)}`); continue }
      if (!own(cfg, 'projects') || !isObj(cfg.projects)) cfg.projects = {}
      const projects = cfg.projects as Record<string, unknown>
      if (!own(projects, e.project) || !isObj(projects[e.project])) projects[e.project] = {}
      o = projects[e.project] as Record<string, unknown>
    }
    const where = e.project === null ? 'user scope' : `project ${e.project}`
    const mine = (k: string) => own(o, k) ? o[k] : undefined
    if (e.key === 'mcpServers' && isObj(e.value)) {
      if (!isObj(mine('mcpServers'))) o.mcpServers = {}
      const cur = o.mcpServers as Record<string, unknown>
      for (const [n, v] of Object.entries(e.value)) {
        if (UNSAFE.has(n)) { skipped.push(`${where}: MCP server ${JSON.stringify(n)}`); continue }
        if (own(cur, n)) continue
        cur[n] = v
        added.push(`${where}: MCP server ${n} (${serverWhat(v)})`)
      }
    } else if (e.key === 'enabledMcpjsonServers' && Array.isArray(e.value)) {
      const had = mine('enabledMcpjsonServers')
      const cur = Array.isArray(had) ? had as unknown[] : []
      const want = e.value as unknown[]
      const more = want.filter((n, i) => !cur.includes(n) && want.indexOf(n) === i)
      o.enabledMcpjsonServers = [...cur, ...more]
      for (const n of more) added.push(`${where}: approved .mcp.json server ${String(n)}`)
    } else if (e.key === 'enableAllProjectMcpServers' && e.value === true && mine('enableAllProjectMcpServers') !== true) {
      o.enableAllProjectMcpServers = true
      added.push(`${where}: every .mcp.json server approved`)
    }
  }
  return { added, skipped }
}

function writeConfig(file: string, j: Record<string, unknown>) {
  let mode = 0o600
  try {
    const st = fs.lstatSync(file)
    if (!st.isFile()) throw new Error(`${file} is not a regular file; put the settings back by hand`)
    mode = st.mode & 0o777
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
  const tmp = `${file}.tmp.teamax-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, JSON.stringify(j, null, 2), { mode, flag: 'wx' })
  fs.renameSync(tmp, file)
}

const USAGE = 'usage: teamax claude-mcp check [--summary] | backups | restore <file> [--yes] | save'

export function claudeMcpCommand(home: string, args: string[], env: Record<string, string | undefined> = process.env, out: (s: string) => void = console.log): number {
  const [sub = 'check', ...rest] = args.filter((a, i) => !(a === '--home' || args[i - 1] === '--home'))
  const userHome = userHomeOf(rest, env)
  const dir = backupDirOf(home)
  if (sub === 'check') {
    const r = scanClaudeMcp(home, userHome)
    const lines = findingLines(r)
    if (!lines.length) { if (!rest.includes('--summary')) out('no MCP settings in this Mac account\'s Claude config (~/.claude.json): nothing to remove'); return 0 }
    out(headline(r))
    if (!rest.includes('--summary')) for (const l of lines) out(`  ${l}`)
    return FOUND
  }
  if (sub === 'save') {
    // office-install.sh, before the server first starts: a copy of what it will remove (it stops when this fails)
    const r = scanClaudeMcp(home, userHome)
    const plans = r.findings.filter((f) => f.entries.length).map((f) => ({ file: path.join(userHome, f.file), taken: f.entries }))
    if (!plans.length) { out('nothing to keep'); return 0 }
    out(saveMcpBackup(dir, userHome, plans, 'install'))
    return 0
  }
  if (sub === 'backups') {
    const files = listMcpBackups(dir)
    if (!files.length) { out(`no copies of removed MCP settings (${dir})`); return 0 }
    for (const f of files) {
      let what = ''
      try { const b = readBackup(f); what = `${b.when}, ${Object.values(b.files).reduce((n, e) => n + e.length, 0)} setting(s) from ${Object.keys(b.files).map(shown).join(', ')}` } catch (e) { what = (e as Error).message }
      out(`${f}  (${what})`)
    }
    return 0
  }
  if (sub === 'restore') {
    const file = rest.find((a) => !a.startsWith('--') && rest[rest.indexOf(a) - 1] !== '--user-home')
    if (!file) { console.error(USAGE); return 2 }
    if (guardActive(home, env)) {
      const t = path.join(home, 'teamax')
      throw new Error('nothing was put back: this installation uses this Mac\'s Claude login, so the server would remove them again at its next start or AI turn. '
        + `Switch it to the setup-token mode first (${t} configure --claude-token-file <file> && ${t} restart), or remove its agents first (${t} uninstall-agent, then office-uninstall.sh)`)
    }
    const b = readBackup(path.resolve(file))
    const entries = b.files['.claude.json'] ?? []
    if (!entries.length) throw new Error(`${file} holds nothing from ~/.claude.json${Object.keys(b.files).length ? ` (only older copies the Claude CLI keeps: ${Object.keys(b.files).map(shown).join(', ')}; they hold the same kind of settings, put them back by hand if you need them)` : ''}`)
    const target = path.join(userHome, '.claude.json')
    let cfg: Record<string, unknown> = {}
    try {
      const text = fs.readFileSync(target, 'utf8')
      const j = JSON.parse(text)
      if (!isObj(j)) throw new Error('not a JSON object')
      cfg = j
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`${target} cannot be read as a Claude config (${(e as Error).message}); nothing was changed`)
    }
    const { added, skipped } = mergeBackup(cfg, entries)
    for (const k of skipped) out(`left out (not a usable name): ${k}`)
    if (!added.length) { out(`nothing to put back: ${target} already has every setting in ${file}`); return 0 }
    if (!rest.includes('--yes')) {
      // every copy may hold a server an AI turn planted (after a turn, or at a start after a turn the server could not
      // clean up after): the owner checks each command first
      out(`${file} (${b.when === 'turn' ? 'saved after an AI turn, which may have put them there' : `saved ${b.when === 'install' ? 'by the installer' : 'at a server start'}`}) would put back:`)
      for (const a of added) out(`  ${a}`)
      out('Check that you know every command and address, then run this again with --yes. Nothing was changed.')
      return 1
    }
    writeConfig(target, cfg)
    out(`put back into ${target} (settings already there were kept):`)
    for (const a of added) out(`  ${a}`)
    return 0
  }
  console.error(USAGE)
  return 2
}
