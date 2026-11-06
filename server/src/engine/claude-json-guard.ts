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
// It fails closed (0.2.19 review, S2): it reads the files as Claude Code does (a leading BOM is dropped: the guard used
// to skip such a file, which the CLI loads), and a file it cannot read, parse or write back (very deep nesting made the
// write throw, and the planted server stayed without a word) is moved whole into that copies folder and replaced by an
// empty config {}; that is logged and audited too. The top-level `env` goes too: the CLI puts it into its own environment.
// What can be neither cleaned nor moved (a file a turn locked before engine.sb refused that) is logged as an error and
// audited as engine.claude_json_mcp_failed.
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AppContext } from '../context'
import { audit } from '../admin/audit'
import { resolveLayout } from '../system/layout'

/** keys (top level and in projects[*]) that make an interactive `claude` start MCP servers */
const PROJECT_KEYS = ['mcpServers', 'enabledMcpjsonServers', 'enableAllProjectMcpServers'] as const
/** and at the top level `env`: Claude Code copies it into its own environment at every start, before any question
 * (2.1.312: applySafeConfigEnvironmentVariables), so every command it runs inherits it. A BASH_ENV, NODE_OPTIONS, proxy
 * or ANTHROPIC_BASE_URL a turn put there would act outside the sandbox (review of the S2 fix). */
const USER_KEYS = [...PROJECT_KEYS, 'env'] as const
export type McpKey = typeof USER_KEYS[number]

/** one MCP setting taken out of a Claude config: its project (null: user scope), its key and what it held */
export interface McpEntry { project: string | null; key: McpKey; value: unknown }

/** the approval switch counts when it is merely truthy: Claude Code tests `projectConfig.enableAllProjectMcpServers` so
 * (2.1.312), and a 1 or "yes" there approved every .mcp.json server past the guard (S2) */
const nonEmpty = (k: string, v: unknown): boolean =>
  k === 'enableAllProjectMcpServers' ? !!v
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
    for (const k of project === null ? USER_KEYS : PROJECT_KEYS) {
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

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** A Claude config file's text read as Claude Code reads its global config (2.1.312: one leading BOM dropped, then
 * JSON.parse); throws when it cannot. JSON.parse alone threw on the BOM, so the guard skipped a file the CLI loads (S2). */
export function parseClaudeJson(text: string): unknown {
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
}

/** a JSON object, or null */
function parseObject(text: string): Record<string, unknown> | null {
  try { const j = parseClaudeJson(text); return isObj(j) ? j : null } catch { return null }
}

/** Deeper than any Claude config. JSON.parse takes far deeper nesting, but JSON.stringify overflows the stack at some
 * ten thousand levels (S2: the write threw and the planted server stayed), and only after 1-2 s per file: a turn may
 * leave many backup files. */
const MAX_DEPTH = 1000
/** how deep `v` is nested, counted up to `cap` (no recursion) */
function depthOf(v: unknown, cap = MAX_DEPTH): number {
  let max = 0
  const stack: [unknown, number][] = [[v, 0]]
  while (stack.length) {
    const [x, d] = stack.pop()!
    if (!x || typeof x !== 'object') continue
    if (d >= cap) return cap
    if (d > max) max = d
    for (const y of Array.isArray(x) ? x : Object.values(x)) if (y && typeof y === 'object') stack.push([y, d + 1])
  }
  return max
}
const tooDeep = (v: unknown) => depthOf(v) >= MAX_DEPTH
/** Indented like the CLI writes it only when small and shallow, else compact: indentation multiplies a deeply nested
 * file (review of the S2 fix: a 400 KB one became a 399 MB ~/.claude.json, written by the server after each turn). */
const PRETTY_MAX = 1024 * 1024, PRETTY_DEPTH = 20

/** the JSON text the guard writes, or null when it cannot be made (nested too deeply, or too large for one string) */
function textOf(j: unknown): string | null {
  const depth = depthOf(j)
  if (depth >= MAX_DEPTH) return null
  let compact: string
  try { compact = JSON.stringify(j) } catch { return null }
  if (compact.length > PRETTY_MAX || depth > PRETTY_DEPTH) return compact
  try { return JSON.stringify(j, null, 2) } catch { return compact }
}

const errText = (e: unknown) => (e as NodeJS.ErrnoException)?.code ?? (e as Error)?.message ?? String(e)

/** same folder, then rename: the CLI never sees a half-written file, and a link at `file` is replaced, not followed */
function replaceWith(file: string, text: string, mode: number) {
  const tmp = `${file}.tmp.teamax-${process.pid}-${crypto.randomBytes(6).toString('hex')}`
  try {
    fs.writeFileSync(tmp, text, { mode, flag: 'wx' })
    fs.renameSync(tmp, file)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') fs.rmSync(tmp, { force: true })
    throw e
  }
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
  file: string; j: Record<string, unknown>; mode: number; taken: McpEntry[]; note: '(link replaced)' | '(hard link replaced)' | '(moved aside)' | null
  /** a link: false when what it points to is not copied (outside the home, the server's folders, not a JSON file) */
  linkCopied?: boolean
  /** the cleaned content; null when it cannot be written: the file is then moved aside whole (a link: removed) and an
   * empty config {} takes its place */
  text: string | null
  /** why a file is moved aside ("is not JSON") */
  why?: string
}

/** read errors that say nothing about the file (the guard runs again after the next turn); any other one moves it aside */
const FOR_NOW = new Set(['EMFILE', 'ENFILE', 'EAGAIN', 'EINTR', 'ENOMEM'])

/** Reads the file and works out what the guard does with it; writes nothing. null: the file is left alone. Throws only
 * when it could not be read for a moment (FOR_NOW). */
function planGuard(file: string, o: GuardOptions): Plan | null {
  let st: fs.Stats
  try { st = fs.lstatSync(file) } catch { return null }
  if (st.isSymbolicLink()) {
    const { j, copied } = linkedContent(file, o)
    const taken = takeMcp(j), text = textOf(j) // null: what it points to cannot be written back, the link becomes {}
    return { file, j, mode: 0o600, taken, note: '(link replaced)', linkCopied: copied && text !== null, text }
  }
  if (!st.isFile()) return null // a folder or anything else: nothing the CLI reads as its config
  const aside = (why: string): Plan => ({ file, j: {}, mode: 0o600, taken: [], note: '(moved aside)', text: null, why })
  let raw: string
  try { raw = fs.readFileSync(file, 'utf8') } catch (e) {
    if (errText(e) === 'ENOENT') return null // gone since the stat
    if (FOR_NOW.has(errText(e))) throw e
    return aside(`cannot be read (${errText(e)})`) // the CLI cannot either, but the owner might "fix" it (chmod) one day
  }
  let j: unknown
  try { j = parseClaudeJson(raw) } catch { return aside('is not JSON') } // a later, more lenient CLI might still read it
  if (!isObj(j)) return null // a list, a text, a number: the CLI finds no settings in it
  const taken = takeMcp(j)
  const linked = st.nlink > 1
  if (!taken.length && !linked) return null
  const text = textOf(j)
  if (text === null) return { file, j, mode: st.mode & 0o777, taken, note: '(moved aside)', text, why: 'cannot be written back as JSON (nested too deeply or too large)' }
  return { file, j, mode: st.mode & 0o777, taken, note: linked ? '(hard link replaced)' : null, text }
}

/** what the guard did with a file: `moved` where the whole file went, `why` when it had to move or empty it */
interface Applied { moved: string | null; why: string | null }

/** Writes the plan. When the cleaned content cannot be written, it fails closed (S2): a link is replaced by {} or
 * removed (what it points to is never changed), a file is moved whole into `keepDir` (or next to itself) and {} takes
 * its place (no file at all is safe too: the CLI starts from its defaults). A file a turn locked is unlocked and tried
 * once more. Throws only when the file stays as it was. */
function applyPlan(p: Plan, keepDir: string | undefined, when: string): Applied {
  try { return applyOnce(p, keepDir, when) } catch (e) {
    if (!unlock(p.file)) throw e
    return applyOnce(p, keepDir, when)
  }
}

/** A turn could lock the file before engine.sb refused it (review of the S2 fix: `chflags uchg`, or an ACL that denies
 * deleting it; the CLI still reads it): its owner may undo both. Only the file and the CLI's backups folder, never the
 * home (macOS gives it an ACL of its own). false: nothing to try (not macOS, or not locked that way). */
function unlock(file: string): boolean {
  if (process.platform !== 'darwin') return false
  const dir = path.dirname(file)
  const targets = [file, ...(path.basename(dir) === 'backups' && path.basename(path.dirname(dir)) === '.claude' ? [dir] : [])]
  let tried = false
  for (const t of targets) {
    for (const cmd of [['/usr/bin/chflags', '-h', 'nouchg,nouappnd', t], ['/bin/chmod', '-h', '-N', t]]) {
      try { if (Bun.spawnSync(cmd, { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0) tried = true } catch {}
    }
  }
  return tried
}

function applyOnce(p: Plan, keepDir: string | undefined, when: string): Applied {
  let why = p.why ?? null
  if (p.text !== null) {
    try { replaceWith(p.file, p.text, p.mode); return { moved: null, why: null } } catch (e) { why = `could not be written (${errText(e)})` }
  }
  if (p.note === '(link replaced)') {
    try { replaceWith(p.file, '{}', 0o600) } catch { fs.unlinkSync(p.file) }
    return { moved: null, why }
  }
  const moved = moveAside(p.file, keepDir, when)
  try { replaceWith(p.file, '{}', 0o600) } catch {}
  return { moved, why }
}

const planKeys = (p: Plan, a: Applied) => [
  ...(a.why && p.note !== '(link replaced)' ? [`(moved aside: ${a.why})`] : p.note ? [p.note] : []),
  ...p.taken.map(mcpKeyPath),
]

/** a whole config file the guard moved aside: moved-<time>-<start|turn>-<n><its name> (".claude.json",
 * ".claude.json.backup.<time>") */
const MOVED_FILE = /^moved-(.+Z)-([a-z]+)-(\d+)(\..+)$/
const movedAge = (n: string) => { const m = MOVED_FILE.exec(n); return m ? `${m[1]}~${m[3]!.padStart(4, '0')}` : n }

/** Moves a config file out of the CLI's reach, whole: into `dir` (the copies folder, 700, the file 600, never over
 * another file; after a turn the newest KEEP_TURN_BACKUPS are kept), else next to itself under a name neither the CLI
 * nor a turn's sandbox opens. Returns where it went; throws when it could not be moved. */
function moveAside(file: string, dir: string | undefined, when: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  if (dir) {
    try {
      ensureCopyDir(dir)
      for (let i = 1; i < 100; i++) {
        const to = path.join(dir, `moved-${stamp}-${when}-${i}${path.basename(file)}`)
        if (fs.existsSync(to)) continue
        try { fs.renameSync(file, to) } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e
          fs.copyFileSync(file, to, fs.constants.COPYFILE_EXCL) // another disk: a copy, then the file goes
          fs.unlinkSync(file)
        }
        try { fs.chmodSync(to, 0o600) } catch {}
        if (when === 'turn') try { pruneTurnCopies(dir) } catch {}
        return to
      }
    } catch {}
  }
  // not ".claude.json…": the CLI never reads it, our own list never takes it up again, engine.sb opens no other name here
  const to = path.join(path.dirname(file), `.teamax-moved-${stamp}-${crypto.randomBytes(4).toString('hex')}${path.basename(file)}`)
  fs.renameSync(file, to)
  return to
}

/** the whole config files the guard moved into `dir`, oldest first */
export function listMovedConfigs(dir: string): string[] {
  let names: string[] = []
  try { names = fs.readdirSync(dir) } catch {}
  return names.filter((n) => MOVED_FILE.test(n)).sort((a, b) => movedAge(a) < movedAge(b) ? -1 : movedAge(a) > movedAge(b) ? 1 : 0).map((n) => path.join(dir, n))
}

/**
 * Removes MCP configuration from the file (default: the account's ~/.claude.json). Returns the removed key paths
 * (empty: nothing found, the file is not touched). A missing file is left alone; one that cannot be read, parsed or
 * written back is moved aside next to itself and replaced by {} ("(moved aside: …)"). A symbolic link at the
 * file is replaced by a regular file (round 4b: before, a link was skipped, so a server planted in the file it points to
 * survived until the next interactive `claude`): with the cleaned content it pointed to when that is a regular file in
 * the home (and not in `privateDirs`), else an empty config `{}`; the result then starts with "(link replaced)". A file
 * with other hard links is written as a new file too ("(hard link replaced)"). Keeps no copy: guardClaudeJsonFamily
 * with `backupDir` does.
 */
export function guardClaudeJson(file = path.join(os.homedir(), '.claude.json'), o: GuardOptions = {}): string[] {
  const p = planGuard(file, o)
  if (!p) return []
  return planKeys(p, applyPlan(p, undefined, 'start'))
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

/** the copies folder: made 700 when missing; a link or anything but a folder in its place is refused */
function ensureCopyDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (!fs.lstatSync(dir).isDirectory()) throw new Error(`${dir} is not a folder`)
  fs.chmodSync(dir, 0o700)
}

/** Saves what the plans take out to a new file in `dir` (700, the file 600, never over another file); returns its path.
 * A link in place of `dir` is refused. When the newest copy there holds exactly the same settings, no new file is made
 * and that copy's path is returned (the installer's copy and the first start's, or one server planted again). A value
 * nested too deeply to write keeps only its names. */
export function saveMcpBackup(dir: string, home: string, plans: Pick<Plan, 'file' | 'taken'>[], when: string, now = new Date()): string {
  ensureCopyDir(dir)
  let chars = 0
  const files: McpBackup['files'] = {}
  for (const p of plans) {
    if (!p.taken.length) continue
    files[path.relative(home, p.file)] = p.taken.map((e) => {
      let text: string | null = null
      if (!tooDeep(e.value)) try { text = JSON.stringify(e.value) ?? '' } catch {} // else nested too deeply to write (S2)
      if (text === null) {
        const names = mcpNames(e)
        return { project: e.project, key: e.key, names, omitted: 'nested too deeply to keep', sha256: crypto.createHash('sha256').update(JSON.stringify(names)).digest('hex') }
      }
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
  fs.writeFileSync(tmp, (textOf(doc) ?? JSON.stringify(doc)) + '\n', { mode: 0o600, flag: 'wx' })
  try {
    for (let i = 1; ; i++) {
      const f = path.join(dir, `claude-mcp-${stamp}-${when}${i > 1 ? `-${i}` : ''}.json`)
      try { fs.linkSync(tmp, f) } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || i >= 100) throw e
        continue
      }
      if (when === 'turn') try { pruneTurnCopies(dir) } catch {} // the copy is saved; pruning is housekeeping
      return f
    }
  } finally { fs.rmSync(tmp, { force: true }) }
}

/** oldest first: by time, then the -2, -3 ... of copies made in the same millisecond */
const byAge = (a: string, b: string) => {
  const key = (n: string) => n.replace(/-(\d+)\.json$/, (_, d: string) => `~${d.padStart(4, '0')}`).replace(/\.json$/, '~0001')
  return key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0
}

/** copies and moved files made after a turn: each kind kept up to the newest KEEP_TURN_BACKUPS */
function pruneTurnCopies(dir: string) {
  const names = fs.readdirSync(dir)
  const turn = names.filter((n) => BACKUP_FILE.test(n) && /-turn(-\d+)?\.json$/.test(n)).sort(byAge)
  const moved = listMovedConfigs(dir).filter((f) => MOVED_FILE.exec(path.basename(f))?.[2] === 'turn')
  for (const n of turn.slice(0, Math.max(0, turn.length - KEEP_TURN_BACKUPS))) fs.rmSync(path.join(dir, n), { force: true })
  for (const f of moved.slice(0, Math.max(0, moved.length - KEEP_TURN_BACKUPS))) fs.rmSync(f, { force: true })
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
  /** whole files moved out of the CLI's reach (they could not be read, parsed or written back), into backupDir */
  moved: string[]
  /** "<file name>: <why>" for each file that may still hold MCP settings: it could not be checked, cleaned or moved */
  failed: string[]
}

/** guardClaudeJson on every file of claudeJsonFiles. With `backupDir`, what is removed is saved there first (one file
 * for all of them); a copy that cannot be saved does not stop the removal (backupError says why). A file that cannot
 * be read, parsed or written back is moved there whole and replaced by {} (moved); nothing fails silently (failed). */
export function guardClaudeJsonFamilyKeep(home = os.homedir(), o: Omit<GuardOptions, 'home'> & { backupDir?: string; when?: string } = {}): FamilyResult {
  const when = o.when ?? 'start'
  const rel = (f: string) => path.relative(home, f)
  const plans: Plan[] = []
  const failed: string[] = []
  for (const f of claudeJsonFiles(home)) {
    try { const p = planGuard(f, { ...o, home }); if (p) plans.push(p) } catch (e) { failed.push(`${rel(f)}: could not be read for now (${errText(e)})`) }
  }
  let backup: string | null = null
  let backupError: string | null = null
  if (o.backupDir && plans.some((p) => p.taken.length)) {
    try { backup = saveMcpBackup(o.backupDir, home, plans, when) } catch (e) { backupError = (e as Error).message }
  }
  const removed: string[] = []
  const moved: string[] = []
  for (const p of plans) {
    try {
      const a = applyPlan(p, o.backupDir, when)
      if (a.moved) moved.push(a.moved)
      for (const k of planKeys(p, a)) removed.push(`${rel(p.file)}: ${k}`)
    } catch (e) { failed.push(`${rel(p.file)}: could not be cleaned or moved aside (${errText(e)})`) }
  }
  return { removed, backup, backupError, moved, failed }
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
  /** note '(moved aside)': why ("is not JSON") */
  why?: string
  entries: McpEntry[]
}

/** What the guard would do to the account's Claude config files, without changing anything (office-install.sh,
 * `teamax claude-mcp check`). `backupsLink`: a link in place of ~/.claude/backups, which it removes. */
export function findClaudeJsonMcp(home = os.homedir(), o: Omit<GuardOptions, 'home'> = {}): { findings: McpFinding[]; backupsLink: boolean; unchecked: string[] } {
  const findings: McpFinding[] = []
  /** "<file name>: <code>": could not be read just now (EMFILE and the like); the check says so instead of "nothing" */
  const unchecked: string[] = []
  for (const f of claudeJsonFiles(home, { readOnly: true })) {
    let p: Plan | null = null
    try { p = planGuard(f, { ...o, home }) } catch (e) { unchecked.push(`${path.relative(home, f)}: ${errText(e)}`) }
    if (!p) continue
    let target: string | undefined
    if (p.note === '(link replaced)') try { target = fs.readlinkSync(f) } catch {}
    findings.push({ file: path.relative(home, f), note: p.note, ...(target ? { target } : {}), ...(p.linkCopied === false ? { emptied: true } : {}), ...(p.why ? { why: p.why } : {}), entries: p.taken })
  }
  let backupsLink = false
  try { backupsLink = fs.lstatSync(path.join(home, '.claude', 'backups')).isSymbolicLink() } catch {}
  return { findings, backupsLink, unchecked }
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
    const h = home ?? os.homedir(), backupDir = claudeMcpBackupDir(ctx)
    const r = guardClaudeJsonFamilyKeep(h, { privateDirs, backupDir, when })
    if (r.backupError) ctx.log.error('could not save a copy of the MCP settings before removing them from ~/.claude.json', { when, err: r.backupError })
    if (r.removed.length) {
      ctx.log.warn('removed MCP servers or a link from ~/.claude.json (office mode: an interactive claude would run them unsandboxed)', { when, keys: r.removed, backup: r.backup, moved: r.moved })
      // a moved file by its name in the copies folder, or where it is when it had to stay next to itself
      const moved = r.moved.map((f) => path.dirname(f) === backupDir ? path.basename(f) : `~/${path.relative(h, f)}`)
      audit(ctx.db, { actor: null, action: 'engine.claude_json_mcp_removed', target: '~/.claude.json', detail: {
        when, keys: r.removed.slice(0, 20), ...(r.backup ? { backup: path.basename(r.backup) } : {}), ...(moved.length ? { moved } : {}),
      } })
    }
    if (r.failed.length) {
      // its own entry: the settings are still there, and the activity log must not say they were removed
      ctx.log.error('could not remove MCP settings from ~/.claude.json: an interactive claude may still run them unsandboxed', { when, failed: r.failed })
      audit(ctx.db, { actor: null, action: 'engine.claude_json_mcp_failed', target: '~/.claude.json', detail: { when, failed: r.failed.slice(0, 20) } })
    }
    return r.removed
  } catch (e) {
    ctx.log.error('could not check ~/.claude.json for MCP servers', { err: e })
    return []
  }
}
