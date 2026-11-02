// The pure parts of the PC runner (docs/DECISIONS.md "PC runner"): which folder may be a workspace, what a path means,
// what a call needs from the person, what a command gets as its environment, and what of the person's computer the
// answer may name. Unit-tested in tests/unit/e-pc-run.test.ts; main/pc/ does the rest.
import { isSecretPath, loginCommand, type ParsedPcCall } from '@mycel/shared'
import type { PcGrants } from './pc-sandbox'

export type { PcGrants } from './pc-sandbox'

/**
 * Why this folder cannot be a workspace, or null. A workspace is what the AI can read and change, so it has to be a
 * project's folder, not a place that holds a person's whole life or the system: their home or anything above it, the
 * standard folders of the home, Library, dot folders of the home (where logins live), system folders.
 */
export function workspaceProblem(folder: string, home: string): 'too-wide' | 'system' | null {
  const f = folder.replace(/\/+$/, '') || '/'
  if (f === '/' || f === home || home.startsWith(`${f}/`)) return 'too-wide'
  if (['/Users', '/Volumes', '/private', '/var', '/tmp'].includes(f)) return 'too-wide'
  if (['/System', '/Library', '/Applications', '/usr', '/bin', '/sbin', '/etc', '/opt', '/private/etc', '/private/var/db', '/private/var/root'].some((s) => f === s || f.startsWith(`${s}/`))) return 'system'
  if (f.startsWith(`${home}/`)) {
    const [top] = f.slice(home.length + 1).split('/')
    if (top === 'Library' || top!.startsWith('.')) return 'system'
    if (['Desktop', 'Documents', 'Downloads', 'Movies', 'Music', 'Pictures', 'Public'].includes(f.slice(home.length + 1))) return 'too-wide'
  }
  return null
}

/** A path inside the workspace as given by the AI: normalized and relative, or null when it leaves the folder. Links are
 * for the jail: it checks the resolved path. */
export function workPath(rel: string): string | null {
  const parts: string[] = []
  const p = rel.replace(/\\/g, '/')
  if (p.includes('\0') || p.startsWith('/') || p.startsWith('~')) return null
  for (const s of p.split('/')) {
    if (s === '' || s === '.') continue
    if (s === '..') return null
    parts.push(s)
  }
  return parts.join('/')
}

/** The working folder of a command; '' is the workspace. */
export const workCwd = (cwd: string | undefined): string | null => workPath(cwd ?? '')

/** Anything under .git: the files of pc_write and pc_edit stay out of it. */
export const inGitFolder = (rel: string): boolean => rel === '.git' || rel.startsWith('.git/') || rel.includes('/.git/')

export interface CallNeeds {
  grants: PcGrants
  /** asked every time, also in a chat the person allowed */
  always: boolean
}

/**
 * What a call needs from the person. A login command and a secret file are asked for every time. The patterns are not the
 * boundary: a command that gets past them runs without the grant, and the jail closes the login or the file.
 */
export function callNeeds(c: ParsedPcCall): CallNeeds {
  const none: PcGrants = { login: false, secretFiles: false }
  switch (c.tool) {
    case 'pc_shell': {
      const grants = { login: loginCommand(c.input.command), secretFiles: c.input.secret_files === true }
      return { grants, always: grants.login || grants.secretFiles }
    }
    case 'pc_read': case 'pc_write': case 'pc_edit': {
      const secret = isSecretPath(workPath(c.input.file_path) ?? c.input.file_path)
      return { grants: { ...none, secretFiles: secret }, always: secret }
    }
    case 'pc_search': return { grants: none, always: false }
  }
}

/** The chats the person allowed, until the app closes. Only ever in memory: a restart asks again. */
export class ChatAllowances {
  private allowed = new Set<string>()
  private key = (projectId: string, chatId: string) => `${projectId}\u0000${chatId}`
  has(projectId: string, chatId: string) { return this.allowed.has(this.key(projectId, chatId)) }
  add(projectId: string, chatId: string) { this.allowed.add(this.key(projectId, chatId)) }
  clear() { this.allowed.clear() }
  get size() { return this.allowed.size }
}

export type PcDecision = 'once' | 'chat' | 'deny'
export const asPcDecision = (d: unknown): PcDecision => (d === 'once' || d === 'chat' ? d : 'deny')

/** A card that cannot be allowed for the chat turns that answer into "once"; anything else from the view is a no. */
export const effectiveDecision = (d: unknown, always: boolean): PcDecision => {
  const v = asPcDecision(d)
  return v === 'chat' && always ? 'once' : v
}

/** What the answer may say about this computer: the AI sees relative paths, never the folder or the person's name. */
export interface ScrubPaths { work: string; sandboxHome: string; home: string; user: string }

const literal = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function scrubPaths(text: string, p: ScrubPaths): string {
  let out = text
  // the longest first: the work folder and the sandbox home are usually inside the home
  for (const [from, to] of [[p.work, '.'], [p.sandboxHome, '~'], [p.home, '~']] as const) {
    if (!from) continue
    // macOS shows /private/tmp and /tmp, /private/var and /var for the same folder
    for (const form of new Set([from, from.replace(/^\/private\//, '/')])) out = out.split(form).join(to)
  }
  if (p.user.length >= 2) out = out.replace(new RegExp(`/Users/${literal(p.user)}\\b`, 'g'), '/Users/<user>')
  return out
}

export interface EnvInput {
  path: string
  home: string
  sandboxHome: string
  user: string
  lang?: string
  sshAgentSocket?: string
}

/**
 * A command's whole environment; nothing comes from the app's own. Not a login shell: `bash -l` would read the person's
 * profile, and exports there are where tokens live. The PATH comes from their shell once (main/pc/jail.ts). HOME is the
 * sandbox home, so tools write their caches there. A command with the login grant gets the real HOME and the ssh agent,
 * and nothing that makes git or npm run a file of the workspace: any earlier plain command can write those, and they must
 * not run with a login that the person gave to one command they read. So no hooks, no npm scripts, no bare repository
 * found by looking around (a plain command can lay one out, with its own core.sshCommand, in any folder), and only real
 * transports (`git push ext::<program>` runs a program).
 */
export function commandEnv(i: EnvInput, g: PcGrants): Record<string, string> {
  const s = i.sandboxHome
  const env: Record<string, string> = {
    PATH: i.path,
    HOME: g.login ? i.home : s,
    USER: i.user,
    LOGNAME: i.user,
    SHELL: '/bin/bash',
    TMPDIR: `${s}/tmp`,
    LANG: i.lang || 'en_US.UTF-8',
    TERM: 'dumb',
    NO_COLOR: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_EDITOR: 'true',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
    npm_config_cache: `${s}/.npm`,
    npm_config_update_notifier: 'false',
    XDG_CACHE_HOME: `${s}/.cache`,
    PIP_CACHE_DIR: `${s}/.cache/pip`,
    YARN_CACHE_FOLDER: `${s}/.cache/yarn`,
    BUN_INSTALL_CACHE_DIR: `${s}/.bun-cache`,
    PNPM_HOME: `${s}/.pnpm`,
    npm_config_store_dir: `${s}/.pnpm-store`,
    CARGO_HOME: `${s}/.cargo`,
    GOCACHE: `${s}/.cache/go`,
    GOPATH: `${s}/go`,
    GOMODCACHE: `${s}/go/pkg/mod`,
    // version managers find their programs through HOME by default
    RUSTUP_HOME: `${i.home}/.rustup`,
    PYENV_ROOT: `${i.home}/.pyenv`,
    RBENV_ROOT: `${i.home}/.rbenv`,
    ASDF_DATA_DIR: `${i.home}/.asdf`,
    VOLTA_HOME: `${i.home}/.volta`,
  }
  if (g.login) {
    Object.assign(env, {
      GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null', GIT_CONFIG_KEY_1: 'safe.bareRepository', GIT_CONFIG_VALUE_1: 'explicit',
      GIT_CONFIG_KEY_2: 'core.fsmonitor', GIT_CONFIG_VALUE_2: 'false', GIT_ALLOW_PROTOCOL: 'https:http:ssh:git', npm_config_ignore_scripts: 'true',
    })
    if (i.sshAgentSocket) env.SSH_AUTH_SOCK = i.sshAgentSocket
  }
  return env
}

/** Folders a search does not walk (the same as what the dev environment's snapshot skips). */
export const SEARCH_SKIP = ['.git', 'node_modules', 'dist', 'build', '.next', '.venv', 'venv', '__pycache__', '.cache', '.turbo']

/** The system's grep or find for pc_search. Both run in the jail, so a pattern cannot hang the app and no secret file
 * is searched. */
export function searchCommand(i: { pattern?: string; glob?: string; path: string; ignoreCase?: boolean }): { file: string; args: string[] } {
  const target = i.path === '' ? '.' : `./${i.path}`
  if (i.pattern === undefined) {
    const prune = SEARCH_SKIP.flatMap((d, n) => [...(n ? ['-o'] : []), '-name', d])
    return { file: '/usr/bin/find', args: [target, '(', ...prune, ')', '-prune', '-o', '-type', 'f', '-name', i.glob ?? '*', '-print'] }
  }
  return {
    file: '/usr/bin/grep',
    args: ['-rInsE', ...(i.ignoreCase ? ['-i'] : []), ...SEARCH_SKIP.map((d) => `--exclude-dir=${d}`), ...(i.glob ? [`--include=${i.glob}`] : []), '-e', i.pattern, '--', target],
  }
}

/** cat -n style lines of a part of a text file. */
export function numberedLines(text: string, offset = 1, limit = 2000): { text: string; total: number; more: boolean } {
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  const part = lines.slice(offset - 1, offset - 1 + limit)
  const width = String(offset + part.length - 1).length
  return { text: part.map((l, i) => `${String(offset + i).padStart(Math.max(6, width))}\t${l}`).join('\n'), total: lines.length, more: offset - 1 + part.length < lines.length }
}

export function applyEdit(text: string, oldString: string, newString: string, all: boolean): { ok: true; text: string; count: number } | { ok: false; error: string } {
  const count = text.split(oldString).length - 1
  if (count === 0) return { ok: false, error: 'old_string was not found in the file. Read the file again and use its exact text.' }
  if (count > 1 && !all) return { ok: false, error: `old_string occurs ${count} times. Give more of the surrounding text, or set replace_all.` }
  return { ok: true, text: text.split(oldString).join(newString), count }
}

export const looksBinary = (b: Uint8Array): boolean => b.subarray(0, 8192).includes(0)

/**
 * What the card shows of the AI's text: what the person approves has to be what runs. Control and bidirectional characters
 * would reorder or hide part of it, and a run of blank lines would push the rest out of the box, so they show as what they
 * are.
 */
export function visibleText(s: string): string {
  return s
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, (c) => `\\u{${c.codePointAt(0)!.toString(16)}}`)
    .replace(/\n[ \t]*(\n[ \t]*){2,}/g, (m) => `\n[${m.split('\n').length - 1} blank lines]\n`)
    .replace(/[ \t]{40,}/g, (m) => `[${m.length} spaces]`)
}

/** One line for the run log and the card. */
export function callSummary(c: ParsedPcCall): string {
  switch (c.tool) {
    case 'pc_shell': return c.input.command
    case 'pc_search': return [c.input.pattern, c.input.glob, c.input.path].filter(Boolean).join('  ')
    default: return c.input.file_path
  }
}
