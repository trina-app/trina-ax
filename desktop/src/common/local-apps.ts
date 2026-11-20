// Apps on the person's own computer as connectors (docs/decisions/20261118-local-app-connectors.md): the desktop app's
// side. The team server sends one JSON-RPC message at a time (local.call, shared/src/api/local-apps.ts) through the
// team page of the window that sent the turn; this manager runs it against the program on this computer and gives the
// program's answer back (local.result). No Electron here (main/local-apps.ts wires it to the app's dialog and its
// safeStorage), so tests run it with a fake program.
//
// Adapters:
//   'mcp'  the program is an MCP server over stdio (`aside mcp`): messages pass through as newline-delimited JSON. One
//          process per connection, started on the first call; the server's initialize is answered from the first one
//          (a stdio server takes one initialize per process).
//   'cli'  a plain CLI declared as tools (ego lite): this manager answers as an MCP server itself; each tools/call runs
//          the program once, with the AI's slot values as arguments of their own or as stdin (cliArgv).
//
// The rules kept (the owner's lean set, 2026-11-19): the program starts from an argument list, never through a shell;
// it never starts while this app runs as root; it runs only after the person's yes in the app's own window (once per
// command: `confirm`), asked again only when the command changes (localCommandKey); setting values come from this
// computer (`settings`) and are hidden in everything sent back; Stop and quitting end it.
import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { LOCAL_APP_PRESETS, localCommandKey, localCommandLines, type LocalAppSpec, type LocalCall, type LocalCliTool, type LocalFailure, type LocalResult } from '@mycel/shared/api'
import { insideAppDir, withoutAppImage } from './linux'
import { t, DEFAULT_UI_LOCALE, type UiKey, type UiLocale } from './i18n'

/** the most one answer may be, in bytes: it goes back as one WebSocket frame, and the server's frames end at 16 MB
 * (Bun's maxPayloadLength); a larger one would close the window's socket and leave the call waiting */
export const LOCAL_MAX_ANSWER = 15 * 1024 * 1024
/** what is kept of the program's error output for the reason a start failed */
const STDERR_KEEP = 4000
/** a CLI tool's output kept for the AI, stdout and stderr together, in characters (the server cuts again): even with
 * every character escaped in JSON it stays under LOCAL_MAX_ANSWER */
export const CLI_OUTPUT_MAX = 2 * 1024 * 1024
/** a program that does not stop on SIGTERM is killed after this long */
const KILL_AFTER_MS = 2000
/** a value shorter than this is not hidden (it would replace ordinary words) */
const HIDE_MIN = 4
export const HIDDEN_VALUE = '[hidden]'

/** Aside picks one of its accounts when `aside mcp` starts and keeps it until it is started again. When no open Aside
 * Browser profile uses that account, browser_profiles lists none and its tools answer "none of its profiles use account
 * u1 … rerun with --account u2" (seen 2026-11-19). For the listed Aside connector (isListedAside) this manager then
 * starts Aside again with an account that has profiles and tries the call once more (the person types nothing; the
 * program and the command they confirmed stay the same). When no account has any, the AI gets these words to pass on. */
export const ASIDE_SIGNED_OUT = 'Aside Browser isn\'t signed in, so Aside cannot reach any browser profile. Tell the person exactly this, in their language and nothing more technical: "Aside Browser isn\'t signed in. Open Aside and sign in, then ask again."'

/** Words for the AI to pass on when a listed app is not open (ego lite, Aside): the sentence for the person in the
 * app's language, and that it is to be said in theirs, nothing more technical. */
export const notOpenWords = (sentence: string) => `Nothing ran: the app is not reachable on the person's computer. Tell the person exactly this, in their language and nothing more technical: "${sentence}"`

/** How long the listed ego lite gets to come up after this app opened it, before its call is tried once more. */
export const EGO_START_WAIT_MS = 15_000
/** after its process is there, how long its browser service gets to start before the call is tried again */
const EGO_SETTLE_MS = 2000
/** ego lite's app on the Mac (its Info.plist CFBundleIdentifier) and its process name */
export const EGO_BUNDLE_ID = 'com.citrolabs.ego.lite'
const EGO_PROCESS = 'ego lite'
/** ego-browser's own words when it cannot reach the app (ego-browser 0.6.3, exit 5). It starts the app itself through
 * LaunchServices when no ego lite is found ("Failed to start ego lite" when that fails, "cannot find the app" when it is
 * not installed), and says "Failed to connect to ego_cli bootstrap" when an ego lite it found or started did not take
 * the call (seen from the packaged desktop app on 2026-11-20, at once, with its "agent sandbox" note). */
const EGO_DOWN = /Failed to connect to ego_cli bootstrap|Failed to start ego lite/i
const EGO_MISSING = /Failed to start ego lite: cannot find the app/i

/** The listed ego lite connector's command exactly (LOCAL_APP_PRESETS 'ego-lite'): never a command the person typed. */
export function isListedEgo(spec: LocalAppSpec): boolean {
  const preset = LOCAL_APP_PRESETS.find((p) => p.id === 'ego-lite')?.spec
  return !!preset && localCommandKey(spec) === localCommandKey(preset)
}

/** What a failed ego-browser run says of the app: not installed, not reachable, or nothing of the kind (null). */
export function egoDown(run: Pick<CliRun, 'stdout' | 'stderr' | 'code'>): 'missing' | 'down' | null {
  if (run.code === 0) return null
  const text = `${run.stdout}\n${run.stderr}`
  return EGO_MISSING.test(text) ? 'missing' : EGO_DOWN.test(text) ? 'down' : null
}

/** Aside's own words when its app is not running and it could not start it (Aside CLI: ASIDE_NOT_RUNNING_HINT, and
 * "Start Aside Browser to use the local host."). Aside starts the app itself otherwise, so only the words are given. */
const ASIDE_DOWN = /Aside isn't running on this machine|Start Aside Browser to use the local host/i
export const asideNotRunning = (answer: Record<string, unknown>) => answerTexts(answer).some((x) => ASIDE_DOWN.test(x))

/** The listed Aside connector's command exactly (`aside mcp`, LOCAL_APP_PRESETS): never a command the person typed. */
export function isListedAside(spec: LocalAppSpec): boolean {
  const preset = LOCAL_APP_PRESETS.find((p) => p.id === 'aside')?.spec
  return !!preset && localCommandKey(spec) === localCommandKey(preset)
}

/** The words of an MCP answer: its text parts and its error message. */
function answerTexts(answer: Record<string, unknown>): string[] {
  const result = answer.result as { content?: { type?: string; text?: unknown }[] } | undefined
  const error = answer.error as { message?: unknown } | undefined
  return [...(Array.isArray(result?.content) ? result.content.map((c) => (typeof c?.text === 'string' ? c.text : '')) : []), typeof error?.message === 'string' ? error.message : '']
}

/** An Aside tools/call answer that says its account has no browser profile: browser_profiles with an empty list, or
 * Aside's own "none of its profiles use account …" error. */
export function asideAccountMismatch(tool: unknown, answer: Record<string, unknown>): boolean {
  const texts = answerTexts(answer)
  if (texts.some((x) => /none of its profiles use account/i.test(x))) return true
  if (tool !== 'browser_profiles') return false
  return texts.some((x) => { try { const v = JSON.parse(x) as { profiles?: unknown }; return Array.isArray(v.profiles) && v.profiles.length === 0 } catch { return false } })
}

/** The account Aside's own message says to use ("rerun with --account u2"), else null. */
export function asideSuggestedAccount(answer: Record<string, unknown>): string | null {
  for (const x of answerTexts(answer)) { const m = /--account\s+(u\d+)\b/i.exec(x); if (m) return m[1]!.toLowerCase() }
  return null
}

/** The accounts `aside account list --json` shows with browser profiles, signed-in ones first ("u2"), without `not`. */
export function asideAccountsWithProfiles(json: string, not: string | null = null): string[] {
  try {
    const v = JSON.parse(json) as { accounts?: { id?: unknown; hasSession?: unknown; profileBindings?: unknown[] }[] }
    const list = (Array.isArray(v.accounts) ? v.accounts : []).filter((a) => typeof a.id === 'number' && Array.isArray(a.profileBindings) && a.profileBindings.length > 0)
    return list.sort((a, b) => Number(b.hasSession === true) - Number(a.hasSession === true)).map((a) => `u${a.id as number}`).filter((u) => u !== not)
  } catch { return [] }
}

/** Aside's profiles belong to its accounts (`aside account list`), and one `aside mcp` reaches only the profiles of the
 * account it started with: its browser_profiles lists those, and a profile_id of another account is refused ("Browser
 * profile … is not available for account u0", seen 2026-11-20 with Aside CLI 1.26). The Aside CLI itself reaches every
 * profile with `--account uN` (Claude Code moves between all of them that way). So for the listed Aside connector this
 * manager lists the profiles of every account (`aside host profiles --account uN --json`) and runs a call for a profile
 * of another account in an `aside mcp --account uN` of its own: the AI sees Aside's own tools and every profile, with
 * nothing added on top of Aside's own interface. */
export interface AsideProfile { profileId: string; label: string | null; connected: boolean | null; account: string }

/** The accounts `aside account list --json` shows ("u0" …), each with the profile ids bound to it, and the current one. */
export function asideAccountList(json: string): { current: string | null; accounts: { id: string; signedIn: boolean; profileIds: string[] }[] } {
  try {
    const v = JSON.parse(json) as { currentAccountId?: unknown; accounts?: { id?: unknown; hasSession?: unknown; profileBindings?: { profileId?: unknown }[] }[] }
    const accounts = (Array.isArray(v.accounts) ? v.accounts : []).filter((a) => typeof a.id === 'number').map((a) => ({
      id: `u${a.id as number}`, signedIn: a.hasSession === true,
      profileIds: (Array.isArray(a.profileBindings) ? a.profileBindings : []).map((b) => (typeof b?.profileId === 'string' ? b.profileId : '')).filter(Boolean),
    }))
    return { current: typeof v.currentAccountId === 'number' ? `u${v.currentAccountId}` : null, accounts }
  } catch { return { current: null, accounts: [] } }
}

/** The profiles in a browser_profiles answer or in `aside host profiles --json` ({"profiles":[{profileId,label,connected}]}),
 * null when it is not that. */
export function asideProfilesIn(text: string): { profileId: string; label: string | null; connected: boolean | null; [k: string]: unknown }[] | null {
  try {
    const v = JSON.parse(text) as { profiles?: unknown }
    if (!Array.isArray(v.profiles)) return null
    return v.profiles.filter((p): p is Record<string, unknown> => !!p && typeof p === 'object' && typeof (p as { profileId?: unknown }).profileId === 'string').map((p) => ({
      ...p, profileId: p.profileId as string, label: typeof p.label === 'string' ? p.label : null, connected: typeof p.connected === 'boolean' ? p.connected : null,
    }))
  } catch { return null }
}

/** browser_profiles' description for the AI: Aside's own words say "this MCP server's … account"; here it lists every account's. */
export const ASIDE_PROFILES_DESCRIPTION = 'List the browser profile IDs, labels, connection status and Aside account of every browser profile in Aside on this computer (all of its accounts). Pass a profileId as profile_id to repl or exec to work in that profile.'

/** tools/list from the listed Aside with browser_profiles described as listing every account's profiles. */
export function asideToolsList(answer: Record<string, unknown>): Record<string, unknown> {
  const result = answer.result as { tools?: unknown } | undefined
  if (!result || !Array.isArray(result.tools)) return answer
  const tools = result.tools.map((t) => (t && typeof t === 'object' && (t as { name?: unknown }).name === 'browser_profiles' ? { ...t, description: ASIDE_PROFILES_DESCRIPTION } : t))
  return { ...answer, result: { ...result, tools } }
}

/** The session id an Aside exec answer gives back ("session_id": "…"), else null. */
export function asideSessionId(answer: Record<string, unknown>): string | null {
  for (const x of answerTexts(answer)) { const m = /"?session_?id"?\s*[:=]\s*"?([A-Za-z0-9_.:-]{4,200})/i.exec(x); if (m) return m[1]! }
  return null
}

/** The answer with `note` (ASIDE_SIGNED_OUT by default) added as one more text part (a JSON-RPC error gets the words
 * in its message). */
export function withAsideSignedOut(answer: Record<string, unknown>, note = ASIDE_SIGNED_OUT): Record<string, unknown> {
  const result = answer.result as { content?: unknown[] } | undefined
  if (result && Array.isArray(result.content)) return { ...answer, result: { ...result, content: [...result.content, { type: 'text', text: note }] } }
  const error = answer.error as { message?: unknown } | undefined
  if (error && typeof error === 'object') return { ...answer, error: { ...error, message: `${typeof error.message === 'string' ? error.message : ''}\n\n${note}`.trim() } }
  return answer
}

export interface LocalAppsDeps {
  /** The app's own window: "Connect this program?" with the exact command. true only on the person's yes there. */
  confirm(o: { team: string; name: string; lines: string[]; program: string }): Promise<boolean>
  /** what the person confirmed for a connection (the hash of its command), and that they did */
  confirmed(team: string, id: string): string | null
  setConfirmed(team: string, id: string, hash: string): void
  /** the setting values typed on this computer, by name (never sent to the team server) */
  settings(team: string, id: string): Record<string, string>
  /** tests: another way to start programs (the same argument list, never a shell) */
  spawn?: typeof nodeSpawn
  /** tests: the app runs as root */
  isRoot?: () => boolean
  /** tests: where a program named without a path is looked for (default: PATH and the usual places) */
  searchPath?: () => string[]
  /** a program started or stopped (Settings shows "Running") */
  onChange?: (team: string, id: string, running: boolean) => void
  /** the person pressed Connect after the call that asked had stopped waiting (the page checks the connection again) */
  onConfirmed?: (team: string, id: string) => void
  /** the language of the words for the person (the app's: main/local-apps.ts) */
  locale?: () => UiLocale
  /** tests: whether the person's own copy of an app runs now (default: pgrep on the Mac, by process name and user) */
  appRunning?: (processName: string) => Promise<boolean>
  /** tests: open a known app by its bundle id, in the background (default: `open -g -b` on the Mac, never a shell).
   * false: it is not installed. Never called on other systems. */
  openApp?: (bundleId: string, args: string[]) => Promise<boolean>
  sleep?: (ms: number) => Promise<void>
  /** tests: the system (default process.platform) */
  platform?: string
  now?: () => number
}

/** A call's confirm stops waiting this long before the call's deadline, so the server hears why (unconfirmed). */
export const CONFIRM_EARLY_MS = 2000

export const commandHash = (spec: LocalAppSpec) => crypto.createHash('sha256').update(localCommandKey(spec)).digest('hex')

/** where a program named without a path is looked for: PATH, then the places tools install themselves to (an app
 * started from the Dock gets a short PATH on macOS) */
export function defaultSearchPath(env: NodeJS.ProcessEnv = process.env, home = os.homedir(), platform: string = process.platform): string[] {
  // Homebrew's own folder only on the Mac (Apple silicon); Linux also: Ubuntu's snap programs
  const extra = platform === 'win32' ? [] : [path.join(home, '.local', 'bin'), ...(platform === 'darwin' ? ['/opt/homebrew/bin'] : []), '/usr/local/bin', '/usr/bin', '/bin', ...(platform === 'linux' ? ['/snap/bin'] : [])]
  // never the AppImage's own mount (Linux): its programs are the app's, not the person's
  return [...new Set([...(env.PATH ?? '').split(path.delimiter).filter(Boolean), ...extra])].filter((d) => !insideAppDir(d, env.APPDIR))
}

/** Setting values may be sealed: the system keeps a key for this app. On Linux without a Secret Service (GNOME Keyring,
 * KWallet) Electron falls back to `basic_text`, a key built into every Chromium: that is not sealed, so it counts as
 * unavailable (so does any backend that is not a known keyring) (the page says the settings were not kept). */
/** the Secret Service backends Electron reports on Linux (never basic_text or unknown) */
const LINUX_KEYRINGS = new Set(['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'])
export function sealable(platform: string, available: () => boolean, backend: () => string): boolean {
  if (!available()) return false
  if (platform !== 'linux') return true
  try { return LINUX_KEYRINGS.has(backend()) } catch { return false }
}

/** The program to start: a full path as it is (`~/` is the home folder), a bare name found in `dirs`. null: not found. */
export function resolveProgram(command: string, dirs: string[], home = os.homedir()): string | null {
  const c = command.startsWith('~/') ? path.join(home, command.slice(2)) : command
  const runnable = (p: string) => { try { const st = fs.statSync(p); return st.isFile() && (process.platform === 'win32' || (st.mode & 0o111) !== 0) } catch { return false } }
  if (c.includes('/') || c.includes('\\')) return path.isAbsolute(c) && runnable(c) ? c : null
  for (const d of dirs) {
    for (const ext of process.platform === 'win32' ? ['.exe', '.cmd', ''] : ['']) {
      const p = path.join(d, c + ext)
      if (runnable(p)) return p
    }
  }
  return null
}

export class SlotError extends Error { name = 'SlotError' }

/** A CLI tool's argument list and stdin from the AI's values: each slot's value is one argument of its own (or stdin),
 * never joined into a command line and never read by a shell. A value that starts with "-" goes as it is: it is one
 * argument, and the person declared where it goes. Refused: a missing required slot, a value of the wrong type, a slot
 * the tool does not have, a NUL character. */
export function cliArgv(tool: LocalCliTool, input: unknown): { args: string[]; stdin: string | null } {
  const values = (input && typeof input === 'object' && !Array.isArray(input) ? input : {}) as Record<string, unknown>
  for (const k of Object.keys(values)) if (!tool.slots.some((s) => s.name === k)) throw new SlotError(`${tool.name} has no input named ${k}`)
  const text = (name: string): string | null => {
    const s = tool.slots.find((x) => x.name === name)!
    const v = values[name]
    if (v === undefined || v === null) { if (s.required) throw new SlotError(`${tool.name} needs ${name}`); return null }
    if (s.type === 'string' && typeof v !== 'string') throw new SlotError(`${name} must be text`)
    if (s.type === 'number' && (typeof v !== 'number' || !Number.isFinite(v))) throw new SlotError(`${name} must be a number`)
    if (s.type === 'boolean' && typeof v !== 'boolean') throw new SlotError(`${name} must be true or false`)
    const out = String(v)
    if (out.includes('\0')) throw new SlotError(`${name} has a NUL character`)
    return out
  }
  const args: string[] = []
  for (const a of tool.args) {
    if (typeof a === 'string') { args.push(a); continue }
    const v = text(a.slot)
    if (v !== null) args.push(v)
  }
  return { args, stdin: tool.stdin ? text(tool.stdin) : null }
}

/** A declared CLI tool's run: what was kept of each stream, how many characters each wrote in all, its exit code. */
export interface CliRun { stdout: string; stderr: string; outChars: number; errChars: number; code: number }

/**
 * What the AI gets from a CLI run: stdout, then stderr, also on success (some CLIs print their whole result on stderr:
 * ego lite's `ego-browser nodejs` writes the script's console.log there and exits 0). Both together are at most `max`
 * characters, so the answer stays one WebSocket frame (LOCAL_MAX_ANSWER): stdout first, stderr cut to what stdout
 * leaves. A cut stream ends with a note that says so and how much is missing.
 */
export function cliOutputText(r: Pick<CliRun, 'stdout' | 'stderr' | 'outChars' | 'errChars'>, max = CLI_OUTPUT_MAX): string {
  const out = r.stdout.slice(0, max)
  const outAll = Math.max(r.outChars, r.stdout.length)
  const parts: string[] = []
  if (out) parts.push(out)
  if (outAll > out.length) parts.push(`[output cut: the program wrote ${outAll} characters, only the first ${out.length} are shown]`)
  const err = r.stderr.slice(0, Math.max(0, max - out.length))
  const errAll = Math.max(r.errChars, r.stderr.length)
  if (err) parts.push(err)
  if (errAll > err.length) parts.push(`[error output (stderr) cut: the program wrote ${errAll} characters there, only the first ${err.length} are shown]`)
  return parts.join('\n').trim() || '(no output)'
}

/** The tools/list a CLI's declared tools make: one input property per slot. */
export function cliTools(tools: LocalCliTool[]) {
  return tools.map((t) => ({
    name: t.name, ...(t.title ? { title: t.title } : {}), description: t.description,
    inputSchema: {
      type: 'object',
      properties: Object.fromEntries(t.slots.map((s) => [s.name, { type: s.type, description: s.description }])),
      required: t.slots.filter((s) => s.required).map((s) => s.name),
      additionalProperties: false,
    },
    annotations: { readOnlyHint: t.readOnly },
  }))
}

/** Every setting value in `text` replaced (longest first), so none leaves the computer in an answer. */
export function hideValues(text: string, values: string[]): string {
  const vs = [...new Set(values.filter((v) => v.length >= HIDE_MIN))].sort((a, b) => b.length - a.length)
  let out = text
  for (const v of vs) {
    out = out.split(v).join(HIDDEN_VALUE)
    // the same value as JSON writes it inside a string (quotes, backslashes, line breaks escaped)
    const j = JSON.stringify(v).slice(1, -1)
    if (j !== v) out = out.split(j).join(HIDDEN_VALUE)
  }
  return out
}

/** The environment a program gets: this app's, without what belongs to Electron or to the AppImage the app runs from
 * (its variables, its mount in LD_LIBRARY_PATH and PATH: ./linux.ts), a PATH that finds the usual places, and the
 * person's setting values. */
export function envFor(values: Record<string, string>, dirs: string[], base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(withoutAppImage(base))) if (!/^(ELECTRON_|MYCEL_DESKTOP_)/.test(k)) env[k] = v
  env.PATH = dirs.filter((d) => !insideAppDir(d, base.APPDIR)).join(path.delimiter)
  return { ...env, ...values }
}

interface Running {
  key: string
  child: ChildProcessWithoutNullStreams
  waiting: Map<string, (m: Record<string, unknown>) => void>
  /** the first initialize's answer, given to every later one */
  init: Record<string, unknown> | null
  initializing: Promise<Record<string, unknown>> | null
  initialized: boolean
  stderr: string
  exited: boolean
  onExit: Set<(why: string) => void>
  /** the listed Aside started with `--account` this account (isListedAside) */
  account?: string
  /** start the program again before the next request (Aside had no signed-in account with a profile: once the person
   * signs in, a fresh `aside mcp` picks it) */
  restartNext?: boolean
}

const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } })
/** what a program answered (null: nothing to answer, a notification), or why there is no answer */
type Answer = { message: Record<string, unknown> | null } | { failure: LocalFailure; error: string }

export class LocalApps {
  private running = new Map<string, Running>()
  private asking = new Map<string, { p: Promise<boolean>; late: boolean }>()
  /** a Cancel in a turn: the same command is not asked again in a turn (a check from Settings asks again) */
  private declined = new Set<string>()
  private calls = new Map<string, AbortController>()
  /** a connection's last initialize params: a program started again (Stop, new settings) under a client that already
   * initialized it is initialized with them before that client's next request */
  private initParams = new Map<string, unknown>()
  /** the account the listed Aside runs with, per connection, once one with profiles was found (ASIDE_SIGNED_OUT) */
  private asideAccount = new Map<string, string>()
  /** the listed Aside, per connection: which account each profile id belongs to (from the last profile list) */
  private asideProfileAccount = new Map<string, Map<string, string>>()
  /** the listed Aside, per connection: the account each exec session was started in */
  private asideSessionAccount = new Map<string, Map<string, string>>()
  /** the listed Aside, per connection: the account of the last repl call (a repl without profile_id goes on there) */
  private asideReplAccount = new Map<string, string>()
  /** the listed Aside, per connection: Aside's current account (what a plain `aside mcp` uses) */
  private asideCurrent = new Map<string, string>()
  private spawn: typeof nodeSpawn
  constructor(private d: LocalAppsDeps) { this.spawn = d.spawn ?? nodeSpawn }

  private k(team: string, id: string) { return `${team}\u0000${id}` }

  /** Run one call. Never throws: a failure is a result the server puts into words. */
  async call(team: string, call: LocalCall): Promise<LocalResult> {
    const fail = (failure: LocalFailure, error: string): LocalResult => ({ callId: call.callId, ok: false, failure, error: this.hide(team, call.connectionId, error).slice(0, 4000) })
    const isRoot = this.d.isRoot ?? (() => typeof process.getuid === 'function' && process.getuid() === 0)
    if (isRoot()) return fail('root', 'the app runs as root')
    const ac = new AbortController()
    this.calls.set(call.callId, ac)
    try {
      const key = commandHash(call.spec)
      const ck = this.k(team, call.connectionId)
      if (this.d.confirmed(team, call.connectionId) !== key) {
        if (call.turnId && this.declined.has(`${ck}\u0000${key}`)) return fail('declined', 'Cancel was chosen on this computer')
        const yes = await this.askUntil(team, call, key)
        if (yes === 'late') return fail('unconfirmed', 'the person has not pressed Connect on this computer yet; the window that asks is still open')
        if (!yes) { this.declined.add(`${ck}\u0000${key}`); return fail('declined', 'Cancel was chosen on this computer') }
        this.declined.delete(`${ck}\u0000${key}`)
      }
      const answer = call.spec.adapter === 'mcp' ? await this.passMcp(team, call, key, ac.signal) : await this.answerCli(team, call, ac.signal)
      if ('failure' in answer) return fail(answer.failure, answer.error)
      if (answer.message === null) return { callId: call.callId, ok: true, message: null }
      const text = this.hide(team, call.connectionId, JSON.stringify(answer.message))
      if (Buffer.byteLength(text) > LOCAL_MAX_ANSWER) return fail('failed', 'the answer is too large')
      return { callId: call.callId, ok: true, message: JSON.parse(text) }
    } catch (e) {
      return fail('failed', e instanceof Error ? e.message : String(e))
    } finally { this.calls.delete(call.callId) }
  }

  /** local.cancel: the turn stopped. A running CLI tool is stopped; an MCP server is told (notifications/cancelled
   * comes from the server as its own message). */
  cancel(callId: string) { this.calls.get(callId)?.abort() }

  private hide(team: string, id: string, text: string) {
    try { return hideValues(text, Object.values(this.d.settings(team, id))) } catch { return text }
  }

  /** One confirm at a time per connection (a turn's calls wait for the same answer). The window stays open after the
   * call that asked stopped waiting (its deadline, less CONFIRM_EARLY_MS: 'late'); a Connect pressed then is kept and
   * told (onConfirmed), so the page checks again by itself. */
  private askUntil(team: string, call: LocalCall, key: string): Promise<boolean | 'late'> {
    const k = `${this.k(team, call.connectionId)}\u0000${key}`
    let entry = this.asking.get(k)
    if (!entry) {
      const dirs = (this.d.searchPath ?? defaultSearchPath)()
      const program = resolveProgram(call.spec.command, dirs) ?? call.spec.command
      const e: { p: Promise<boolean>; late: boolean } = { p: Promise.resolve(false), late: false }
      e.p = this.d.confirm({ team, name: call.name, lines: localCommandLines(call.spec), program }).then((yes) => {
        if (yes) {
          this.d.setConfirmed(team, call.connectionId, key)
          if (e.late) this.d.onConfirmed?.(team, call.connectionId)
        }
        return yes
      }, () => false).finally(() => this.asking.delete(k))
      this.asking.set(k, e)
      entry = e
    }
    const e = entry
    const wait = Math.max(0, call.deadline - CONFIRM_EARLY_MS - (this.d.now ?? Date.now)())
    return new Promise((resolve) => {
      const timer = setTimeout(() => { e.late = true; resolve('late') }, wait)
      e.p.then((yes) => { clearTimeout(timer); resolve(yes) })
    })
  }

  // ---------------- adapter 'mcp': an MCP server over stdio ----------------
  /** `pool`: the listed Aside for a profile of another account, `aside mcp --account <pool>` beside the main one */
  private start(team: string, call: LocalCall, key: string, pool?: string): Running | { failure: LocalFailure; error: string } {
    const ck = this.k(team, call.connectionId)
    const slot = pool ? `${ck}\u0000aside:${pool}` : ck
    const cur = this.running.get(slot)
    if (cur && !cur.exited && cur.key === key) return cur
    if (cur) this.kill(cur)
    const spec = call.spec as Extract<LocalAppSpec, { adapter: 'mcp' }>
    const dirs = (this.d.searchPath ?? defaultSearchPath)()
    const program = resolveProgram(spec.command, dirs)
    if (!program) return { failure: 'start_failed', error: `${spec.command} was not found on this computer` }
    // the listed Aside with the account found to have profiles: the same program and command, one account chosen
    const account = pool ?? (isListedAside(spec) ? this.asideAccount.get(ck) : undefined)
    let child: ChildProcessWithoutNullStreams
    try {
      child = this.spawn(program, account ? [...spec.args, '--account', account] : spec.args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: envFor(this.d.settings(team, call.connectionId), dirs), cwd: os.homedir(), detached: process.platform !== 'win32', windowsHide: true }) as ChildProcessWithoutNullStreams
    } catch (e) { return { failure: 'start_failed', error: e instanceof Error ? e.message : String(e) } }
    const r: Running = { key, child, waiting: new Map(), init: null, initializing: null, initialized: false, stderr: '', exited: false, onExit: new Set(), account }
    this.running.set(slot, r)
    let buf = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buf += chunk
      if (buf.length > LOCAL_MAX_ANSWER * 2) { this.kill(r); return }
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (line) this.fromProgram(r, line)
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { r.stderr = (r.stderr + chunk).slice(-STDERR_KEEP) })
    const gone = (why: string) => {
      if (r.exited) return
      r.exited = true
      if (this.running.get(slot) === r) this.running.delete(slot)
      for (const f of r.onExit) f(why)
      // started again meanwhile (restartNext), or another of its programs runs: it still runs
      if (![...this.running.keys()].some((k) => k === ck || k.startsWith(ck + '\u0000'))) this.d.onChange?.(team, call.connectionId, false)
    }
    child.on('error', (e) => gone(e.message))
    child.on('exit', (code, signal) => gone(`the program stopped (${signal ?? `exit ${code}`})${r.stderr.trim() ? `: ${r.stderr.trim().split('\n').slice(-3).join(' ')}` : ''}`))
    child.stdin.on('error', () => {})
    this.d.onChange?.(team, call.connectionId, true)
    return r
  }

  /** A line from the program: an answer to a waiting request, or the program's own request (answered here: ping, and
   * "not offered" for anything else, such as sampling), or a notification (ignored). */
  private fromProgram(r: Running, line: string) {
    let m: Record<string, unknown>
    try { m = JSON.parse(line) } catch { return }
    if (!m || typeof m !== 'object') return
    const id = m.id
    if (typeof m.method === 'string') {
      if (id === undefined || id === null) return
      const answer = m.method === 'ping' ? { jsonrpc: '2.0', id, result: {} } : m.method === 'roots/list' ? { jsonrpc: '2.0', id, result: { roots: [] } } : rpcError(id, -32601, 'not offered by this client')
      this.write(r, answer)
      return
    }
    if (typeof id === 'string' || typeof id === 'number') r.waiting.get(String(id))?.(m)
  }

  private write(r: Running, m: unknown) { if (!r.exited) r.child.stdin.write(JSON.stringify(m) + '\n') }

  private request(r: Running, m: Record<string, unknown>, deadline: number, signal: AbortSignal): Promise<Answer> {
    const id = String(m.id)
    return new Promise((resolve) => {
      const done = (v: Answer) => { clearTimeout(timer); r.waiting.delete(id); r.onExit.delete(onExit); signal.removeEventListener('abort', onAbort); resolve(v) }
      const onExit = (why: string) => done({ failure: 'failed', error: why })
      const onAbort = () => done({ failure: 'failed', error: 'stopped' })
      const timer = setTimeout(() => done({ failure: 'failed', error: 'the program did not answer in time' }), Math.max(1000, deadline - (this.d.now ?? Date.now)()))
      r.waiting.set(id, (answer) => done({ message: answer }))
      r.onExit.add(onExit)
      signal.addEventListener('abort', onAbort, { once: true })
      this.write(r, m)
    })
  }

  /** One initialize per process: a later client gets the first answer under its own id. null: initialized. */
  private async initOnce(r: Running, call: LocalCall, signal: AbortSignal, params: unknown): Promise<Answer | null> {
    if (r.init) return null
    r.initializing ??= this.request(r, { jsonrpc: '2.0', id: `init-${crypto.randomUUID()}`, method: 'initialize', params }, call.deadline, signal).then((a) => {
      if ('failure' in a) throw new Error(a.error)
      const result = a.message?.result
      if (result && typeof result === 'object') r.init = result as Record<string, unknown>
      else throw new Error(JSON.stringify(a.message?.error ?? 'no answer'))
      return r.init
    }).finally(() => { r.initializing = null })
    try { await r.initializing; return null } catch (e) { return { failure: 'failed', error: e instanceof Error ? e.message : String(e) } }
  }

  /** A process ready for a request: a program started again under a client that initialized the one before (Stop, new
   * settings, another Aside account) is initialized here first, as a stdio server takes no other request before it. */
  private async ready(r: Running, ck: string, call: LocalCall, signal: AbortSignal): Promise<Answer | null> {
    if (!r.init) {
      const failed = await this.initOnce(r, call, signal, this.initParams.get(ck) ?? { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'team-integrations', version: '1.0' } })
      if (failed) return failed
    }
    if (!r.initialized) { r.initialized = true; this.write(r, { jsonrpc: '2.0', method: 'notifications/initialized' }) }
    return null
  }

  private async passMcp(team: string, call: LocalCall, key: string, signal: AbortSignal, retried = false): Promise<Answer> {
    const m = call.message
    const ck = this.k(team, call.connectionId)
    // Aside had no signed-in account with a profile last time: a fresh process, so an account signed in since is used
    const stale = this.running.get(ck)
    if (stale?.restartNext && !stale.exited) { this.running.delete(ck); this.asideAccount.delete(ck); this.kill(stale) }
    const started = this.start(team, call, key)
    if ('failure' in started) return started
    const r = started
    const method = typeof m.method === 'string' ? m.method : ''
    const isRequest = m.id !== undefined && m.id !== null
    if (method === 'initialize' && isRequest) {
      this.initParams.set(ck, m.params ?? {})
      const failed = await this.initOnce(r, call, signal, m.params ?? {})
      return failed ?? { message: { jsonrpc: '2.0', id: m.id, result: r.init } }
    }
    if (method === 'notifications/initialized') {
      if (!r.initialized) { r.initialized = true; this.write(r, m) }
      return { message: null }
    }
    if (!isRequest) { this.write(r, m); return { message: null } }
    const notReady = await this.ready(r, ck, call, signal)
    if (notReady) return notReady
    const aside = isListedAside(call.spec)
    const params = (m.params ?? {}) as { name?: unknown; arguments?: unknown }
    const tool = method === 'tools/call' ? params.name : undefined
    const args = (params.arguments && typeof params.arguments === 'object' ? params.arguments : {}) as Record<string, unknown>
    // a profile (or an exec session, or the repl) of another Aside account: that account's own `aside mcp --account uN`
    if (aside && !retried && (tool === 'repl' || tool === 'exec')) {
      const target = await this.asideTarget(team, call, tool, args)
      const main = r.account ?? this.asideCurrent.get(ck) ?? null
      if (target && target !== main) return this.passAsidePool(team, call, key, signal, target, tool, args)
      // the repl goes on in the main process's profile
      if (tool === 'repl' && typeof args.profile_id === 'string') this.asideReplAccount.delete(ck)
    }
    const answer = await this.request(r, m, call.deadline, signal)
    if (method === 'tools/call' && aside && 'message' in answer && answer.message && asideAccountMismatch(tool, answer.message)) {
      // Aside's account has no open profile: start it again with one that has (its own message names one, else its
      // account list) and try once more; with none, say it plainly and start fresh next time
      const next = retried ? null : asideSuggestedAccount(answer.message) ?? (await this.asideAccounts(team, call, r.account ?? null))[0] ?? null
      if (next && next !== r.account) {
        this.asideAccount.set(ck, next)
        this.running.delete(ck)
        this.kill(r)
        return this.passMcp(team, call, key, signal, true)
      }
      r.restartNext = true
      return { message: withAsideSignedOut(answer.message) }
    }
    // Aside's app is not running and Aside could not start it: its words, plainly for the person
    if (method === 'tools/call' && aside && 'message' in answer && answer.message && asideNotRunning(answer.message)) {
      return { message: withAsideSignedOut(answer.message, notOpenWords(this.say('localApp.asideNotOpen'))) }
    }
    if (aside && 'message' in answer && answer.message) {
      if (method === 'tools/list') return { message: asideToolsList(answer.message) }
      if (tool === 'browser_profiles') return { message: await this.asideAllProfiles(team, call, r, answer.message) }
      if (tool === 'exec' && typeof args.session_id !== 'string') this.asideRemember(ck, answer.message, r.account ?? this.asideCurrent.get(ck) ?? null)
    }
    return answer
  }

  /** The Aside account a repl or exec call belongs to: its profile_id's, its exec session's, or the last repl's; null:
   * the main `aside mcp` (it answers a profile it does not know with Aside's own words). */
  private async asideTarget(team: string, call: LocalCall, tool: 'repl' | 'exec', args: Record<string, unknown>): Promise<string | null> {
    const ck = this.k(team, call.connectionId)
    if (typeof args.profile_id === 'string' && args.profile_id) {
      const pid = args.profile_id
      // a profile not seen yet (the AI took its id from elsewhere, or a profile was added): Aside's accounts read again
      if (!this.asideProfileAccount.get(ck)?.has(pid)) await this.asideList(team, call, null, [])
      return this.asideProfileAccount.get(ck)?.get(pid) ?? null
    }
    if (tool === 'exec') return typeof args.session_id === 'string' ? this.asideSessionAccount.get(ck)?.get(args.session_id) ?? null : null
    return this.asideReplAccount.get(ck) ?? null
  }

  /** A call for a profile of another Aside account, in `aside mcp --account <account>` (started once, kept beside the
   * main one; Stop and quitting end it too). */
  private async passAsidePool(team: string, call: LocalCall, key: string, signal: AbortSignal, account: string, tool: 'repl' | 'exec', args: Record<string, unknown>): Promise<Answer> {
    const ck = this.k(team, call.connectionId)
    const started = this.start(team, call, key, account)
    if ('failure' in started) return started
    const notReady = await this.ready(started, ck, call, signal)
    if (notReady) return notReady
    const answer = await this.request(started, call.message, call.deadline, signal)
    if (!('message' in answer) || !answer.message) return answer
    if (asideNotRunning(answer.message)) return { message: withAsideSignedOut(answer.message, notOpenWords(this.say('localApp.asideNotOpen'))) }
    if (tool === 'repl') this.asideReplAccount.set(ck, account)
    if (tool === 'exec' && typeof args.session_id !== 'string') this.asideRemember(ck, answer.message, account)
    return answer
  }

  /** An exec answer's session, kept with the account it runs in (a later exec with that session_id goes there). */
  private asideRemember(ck: string, answer: Record<string, unknown>, account: string | null) {
    const sid = asideSessionId(answer)
    if (!sid || !account) return
    const map = this.asideSessionAccount.get(ck) ?? new Map<string, string>()
    map.set(sid, account)
    if (map.size > 500) map.delete(map.keys().next().value!)
    this.asideSessionAccount.set(ck, map)
  }

  /** Every account's profiles, each with its account, kept for routing: `mine` are the main process's (its account:
   * `account`, else Aside's current one); the other accounts' come from `aside host profiles --account uN --json` (an
   * older Aside without it: the profile ids its account list binds to the account). */
  private async asideList(team: string, call: LocalCall, account: string | null, mine: NonNullable<ReturnType<typeof asideProfilesIn>>): Promise<{ main: string | null; all: AsideProfile[] }> {
    const ck = this.k(team, call.connectionId)
    const list = asideAccountList(await this.runAside(team, call, ['account', 'list', '--json']))
    if (list.current) this.asideCurrent.set(ck, list.current)
    const main = account ?? list.current ?? this.asideCurrent.get(ck) ?? null
    const mineIds = new Set(mine.map((p) => p.profileId))
    const others = await Promise.all(list.accounts.filter((a) => a.id !== main && a.profileIds.length > 0).map(async (a) => {
      const listed = asideProfilesIn(await this.runAside(team, call, ['host', 'profiles', '--account', a.id, '--json']))
      return (listed ?? a.profileIds.map((profileId) => ({ profileId, label: null, connected: null }))).map((p) => ({ ...p, account: a.id }))
    }))
    const all: AsideProfile[] = main ? mine.map((p) => ({ ...p, account: main })) : []
    for (const l of others) for (const p of l) if (!mineIds.has(p.profileId)) all.push(p)
    const map = new Map<string, string>()
    for (const p of all) if (!map.has(p.profileId)) map.set(p.profileId, p.account)
    // the main account's profiles not listed now (the AI's id came from elsewhere): from the account list's bindings
    for (const a of list.accounts) for (const id of a.profileIds) if (!map.has(id)) map.set(id, a.id)
    this.asideProfileAccount.set(ck, map)
    return { main, all }
  }

  /** browser_profiles from the main `aside mcp`, with the profiles of Aside's other accounts added (each one with its
   * account). Aside's answer as it is when it is not a profile list or no account is known. */
  private async asideAllProfiles(team: string, call: LocalCall, r: Running, answer: Record<string, unknown>): Promise<Record<string, unknown>> {
    const result = answer.result as { content?: { type?: string; text?: unknown }[]; isError?: unknown } | undefined
    if (!result || result.isError === true || !Array.isArray(result.content)) return answer
    const at = result.content.findIndex((c) => typeof c?.text === 'string' && asideProfilesIn(c.text) !== null)
    if (at < 0) return answer
    const { main, all } = await this.asideList(team, call, r.account ?? null, asideProfilesIn(result.content[at]!.text as string)!)
    if (!main) return answer
    const content = result.content.map((c, i) => (i === at ? { ...c, text: JSON.stringify({ profiles: all }) } : c))
    return { ...answer, result: { ...result, content } }
  }

  /** The listed Aside's accounts with browser profiles (`aside account list --json`, the same program, no shell). */
  private async asideAccounts(team: string, call: LocalCall, not: string | null): Promise<string[]> {
    return asideAccountsWithProfiles(await this.runAside(team, call, ['account', 'list', '--json']), not)
  }

  /** The listed Aside program once with these arguments (no shell, 10 s at most): what it printed ('' when it failed). */
  private runAside(team: string, call: LocalCall, args: string[]): Promise<string> {
    const dirs = (this.d.searchPath ?? defaultSearchPath)()
    const program = resolveProgram(call.spec.command, dirs)
    if (!program) return Promise.resolve('')
    return new Promise((resolve) => {
      let out = '', done = false
      const finish = (code: number | null) => { if (done) return; done = true; clearTimeout(timer); resolve(code === 0 ? out : '') }
      let child: ChildProcessWithoutNullStreams
      try {
        child = this.spawn(program, args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: envFor(this.d.settings(team, call.connectionId), dirs), cwd: os.homedir(), windowsHide: true }) as ChildProcessWithoutNullStreams
      } catch { resolve(''); return }
      const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch {} finish(null) }, 10_000)
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (c: string) => { if (out.length < 1024 * 1024) out += c })
      child.stderr.on('data', () => {})
      child.on('error', () => finish(null))
      child.on('exit', (code) => finish(code))
      child.stdin.on('error', () => {})
      child.stdin.end()
    })
  }

  // ---------------- adapter 'cli': declared tools, this manager is the MCP server ----------------
  private async answerCli(team: string, call: LocalCall, signal: AbortSignal): Promise<Answer> {
    const spec = call.spec as Extract<LocalAppSpec, { adapter: 'cli' }>
    const m = call.message
    const id = m.id
    if (id === undefined || id === null) return { message: null }
    const ok = (result: unknown) => ({ message: { jsonrpc: '2.0', id, result } as Record<string, unknown> })
    switch (m.method) {
      case 'initialize': return ok({ protocolVersion: typeof (m.params as { protocolVersion?: unknown })?.protocolVersion === 'string' ? (m.params as { protocolVersion: string }).protocolVersion : '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: spec.command, version: '1' } })
      case 'ping': return ok({})
      case 'tools/list': return ok({ tools: cliTools(spec.tools) })
      case 'tools/call': {
        const p = (m.params ?? {}) as { name?: unknown; arguments?: unknown }
        const tool = spec.tools.find((t) => t.name === p.name)
        if (!tool) return { message: rpcError(id, -32602, `no tool named ${String(p.name).slice(0, 100)}`) }
        let argv: { args: string[]; stdin: string | null }
        try { argv = cliArgv(tool, p.arguments) } catch (e) { return ok({ content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }], isError: true }) }
        let run = await this.runCli(team, call, spec, argv, signal)
        if ('failure' in run) return run
        // the listed ego lite whose app is not open: opened here once, then the call once more (nothing ran the first
        // time: ego-browser stops before the script); still not, plain words for the person
        let down: 'missing' | 'down' | 'no_answer' | null = isListedEgo(spec) ? egoDown(run) : null
        if (down === 'down' && !signal.aborted) {
          const up = await this.bringUpEgo(signal)
          if (up === 'missing') down = 'missing'
          else if (up === 'up') {
            run = await this.runCli(team, call, spec, argv, signal)
            if ('failure' in run) return run
            const again = egoDown(run)
            down = again === 'down' ? 'no_answer' : again
          }
        }
        if (down) {
          const words = this.say(down === 'missing' ? 'localApp.egoNotInstalled' : down === 'no_answer' ? 'localApp.egoNoAnswer' : 'localApp.egoNotOpen')
          return ok({ content: [{ type: 'text', text: cliOutputText(run) }, { type: 'text', text: notOpenWords(words) }], isError: true })
        }
        return ok({ content: [{ type: 'text', text: cliOutputText(run) }], isError: run.code !== 0 })
      }
      default: return { message: rpcError(id, -32601, 'not offered') }
    }
  }

  private say(key: UiKey) { return t(this.d.locale?.() ?? DEFAULT_UI_LOCALE, key) }

  /** The person's ego lite, up: opened in the background when it is not running (never a shell; its windows are not
   * touched when it runs), then waited for (EGO_START_WAIT_MS at most). 'up': try the call again; 'not_open': it did
   * not come up, or this system has no way here; 'missing': not installed. */
  private async bringUpEgo(signal: AbortSignal): Promise<'up' | 'not_open' | 'missing'> {
    if ((this.d.platform ?? process.platform) !== 'darwin') return 'not_open'
    const running = this.d.appRunning ?? ((name: string) => this.exitsZero('/usr/bin/pgrep', ['-x', '-U', String(process.getuid?.() ?? ''), name]))
    const open = this.d.openApp ?? ((id: string, args: string[]) => this.exitsZero('/usr/bin/open', ['-g', '-b', id, ...(args.length ? ['--args', ...args] : [])]))
    const sleep = this.d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
    const now = this.d.now ?? Date.now
    if (!(await running(EGO_PROCESS))) {
      // what ego-browser itself passes when it starts the app (seen on its running process)
      if (!(await open(EGO_BUNDLE_ID, ['--startup-ego-browser-service']))) return 'missing'
      const until = now() + EGO_START_WAIT_MS
      while (!(await running(EGO_PROCESS))) {
        if (signal.aborted || now() >= until) return 'not_open'
        await sleep(500)
      }
    }
    await sleep(EGO_SETTLE_MS)
    return signal.aborted ? 'not_open' : 'up'
  }

  /** A system program with a fixed argument list (no shell), and whether it ended with 0 (10 s at most). */
  private exitsZero(program: string, args: string[]): Promise<boolean> {
    return new Promise((resolve) => {
      let child: ChildProcessWithoutNullStreams
      try { child = this.spawn(program, args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }) as ChildProcessWithoutNullStreams } catch { resolve(false); return }
      let done = false
      const finish = (v: boolean) => { if (done) return; done = true; clearTimeout(timer); resolve(v) }
      const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch {} finish(false) }, 10_000)
      child.stdout.on('data', () => {})
      child.stderr.on('data', () => {})
      child.on('error', () => finish(false))
      child.on('exit', (code) => finish(code === 0))
      child.stdin.on('error', () => {})
      child.stdin.end()
    })
  }

  private runCli(team: string, call: LocalCall, spec: Extract<LocalAppSpec, { adapter: 'cli' }>, argv: { args: string[]; stdin: string | null }, signal: AbortSignal): Promise<CliRun | { failure: LocalFailure; error: string }> {
    const dirs = (this.d.searchPath ?? defaultSearchPath)()
    const program = resolveProgram(spec.command, dirs)
    if (!program) return Promise.resolve({ failure: 'start_failed', error: `${spec.command} was not found on this computer` })
    return new Promise((resolve) => {
      let child: ChildProcessWithoutNullStreams
      try {
        child = this.spawn(program, argv.args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: envFor(this.d.settings(team, call.connectionId), dirs), cwd: os.homedir(), detached: process.platform !== 'win32', windowsHide: true }) as ChildProcessWithoutNullStreams
      } catch (e) { resolve({ failure: 'start_failed', error: e instanceof Error ? e.message : String(e) }); return }
      const ck = this.k(team, call.connectionId)
      const r: Running = { key: 'cli', child, waiting: new Map(), init: null, initializing: null, initialized: true, stderr: '', exited: false, onExit: new Set() }
      // a CLI run counts as the connection running, so Stop ends it too
      const prev = this.running.get(ck)
      this.running.set(`${ck}\u0000${call.callId}`, r)
      this.d.onChange?.(team, call.connectionId, true)
      let stdout = '', stderr = '', outChars = 0, errChars = 0, settled = false
      const finish = (v: CliRun | { failure: LocalFailure; error: string }) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        r.exited = true
        this.running.delete(`${ck}\u0000${call.callId}`)
        if (!prev && ![...this.running.keys()].some((k) => k === ck || k.startsWith(ck + '\u0000'))) this.d.onChange?.(team, call.connectionId, false)
        resolve(v)
      }
      const onAbort = () => { this.kill(r); finish({ failure: 'failed', error: 'stopped' }) }
      const timer = setTimeout(() => { this.kill(r); finish({ failure: 'failed', error: 'the program did not finish in time' }) }, Math.max(1000, call.deadline - (this.d.now ?? Date.now)()))
      signal.addEventListener('abort', onAbort, { once: true })
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      // each stream kept up to the whole budget (cliOutputText shares it out), and counted past it for the note
      child.stdout.on('data', (c: string) => { outChars += c.length; if (stdout.length < CLI_OUTPUT_MAX) stdout += c })
      // kept like stdout (the AI reads it: a CLI may print its result there), not only a short tail for errors
      child.stderr.on('data', (c: string) => { errChars += c.length; if (stderr.length < CLI_OUTPUT_MAX) stderr += c })
      child.on('error', (e) => finish({ failure: 'start_failed', error: e.message }))
      child.on('exit', (code) => finish({ stdout, stderr, outChars, errChars, code: code ?? 1 }))
      child.stdin.on('error', () => {})
      if (argv.stdin !== null) child.stdin.write(argv.stdin)
      child.stdin.end()
    })
  }

  // ---------------- Stop ----------------
  /** `hard`: at once with SIGKILL (the app is quitting: no timer of its own runs after that) */
  private kill(r: Running, hard = false) {
    if (r.exited) return
    const pid = r.child.pid
    const sig = (s: NodeJS.Signals) => {
      // the program's own children too (it was started in a group of its own)
      try { if (pid && process.platform !== 'win32') process.kill(-pid, s); else r.child.kill(s) } catch { try { r.child.kill(s) } catch {} }
    }
    if (hard) return sig('SIGKILL')
    sig('SIGTERM')
    setTimeout(() => { if (!r.exited) sig('SIGKILL') }, KILL_AFTER_MS).unref?.()
  }

  /** Stop the connection's program (Settings' Stop, a removed connection). */
  stop(team: string, id: string) {
    const ck = this.k(team, id)
    for (const [k, r] of [...this.running]) if (k === ck || k.startsWith(ck + '\u0000')) this.kill(r)
  }

  /** Quitting, or another team opened in the window: every program of `team` (all teams when left out) stops. */
  stopAll(team?: string, hard = false) {
    for (const [k, r] of [...this.running]) if (!team || k.startsWith(team + '\u0000')) this.kill(r, hard)
  }

  /** The connections of `team` with a program running now. */
  runningIds(team: string): string[] {
    const ids = new Set<string>()
    for (const [k, r] of this.running) if (!r.exited && k.startsWith(team + '\u0000')) ids.add(k.split('\u0000')[1]!)
    return [...ids]
  }
}
