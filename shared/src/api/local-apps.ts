// Apps on the person's own computer as connectors (docs/decisions/20261118-local-app-connectors.md): a program the
// desktop app starts on that computer, either a local MCP server over stdio (adapter 'mcp', e.g. `aside mcp`) or a
// plain CLI wrapped as a few declared tools (adapter 'cli', e.g. ego lite's `ego-browser nodejs`). The server keeps
// only the command's shape (never a setting's value) and speaks MCP to the desktop app over the window's relay:
// local.call carries one JSON-RPC message to the window that sent the turn, local.result its answer. Owner: C
// (server/src/integrations/connections/local.ts, server/src/realtime/local-relay.ts, server/src/routes/local-apps.ts).
import { z } from 'zod'
import { endpoint, empty } from './endpoint'
import { Uuid7 } from '../ids'

/** the program: a name looked up on the computer (`aside`) or a full path; one line, no shell */
const Program = z.string().trim().min(1).max(1000).regex(/^[^\0\r\n]+$/, 'one line')
/** one argument, passed to the program as it is (never through a shell) */
const Arg = z.string().max(4000).regex(/^[^\0]*$/, 'no NUL')
/** a setting the program reads from its environment: only its name is kept here; the value stays on the computer */
export const LocalEnvName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/, 'a name such as API_KEY')
const SlotName = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, 'lower-case letters, digits and _')
const ToolName = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, 'lower-case letters, digits and _')

/** A value the AI fills in for a CLI tool: a typed slot, passed as one argument of its own or as stdin. */
export const LocalSlot = z.object({
  name: SlotName,
  description: z.string().max(500),
  type: z.enum(['string', 'number', 'boolean']),
  required: z.boolean(),
}).strict()
export type LocalSlot = z.infer<typeof LocalSlot>
/** one part of a CLI tool's argument list: a fixed argument, or a slot's value as one argument of its own */
export const LocalArgPart = z.union([Arg, z.object({ slot: SlotName }).strict()])
export type LocalArgPart = z.infer<typeof LocalArgPart>

export const LocalCliTool = z.object({
  name: ToolName,
  title: z.string().trim().max(100).optional(),
  description: z.string().max(2000),
  args: z.array(LocalArgPart).max(50),
  /** this slot's value is written to the program's stdin (a script); no other input reaches stdin */
  stdin: SlotName.optional(),
  slots: z.array(LocalSlot).max(20),
  /** it only reads (a guide, a list): the AI may run it without asking, like an MCP tool marked read-only */
  readOnly: z.boolean(),
}).strict().superRefine((t, c) => {
  const names = new Set(t.slots.map((s) => s.name))
  if (names.size !== t.slots.length) c.addIssue({ code: 'custom', message: 'two slots have the same name', path: ['slots'] })
  t.args.forEach((a, i) => { if (typeof a !== 'string' && !names.has(a.slot)) c.addIssue({ code: 'custom', message: `no slot named ${a.slot}`, path: ['args', i] }) })
  if (t.stdin) {
    const s = t.slots.find((x) => x.name === t.stdin)
    if (!s || s.type !== 'string') c.addIssue({ code: 'custom', message: 'stdin needs a text slot', path: ['stdin'] })
    else if (t.args.some((a) => typeof a !== 'string' && a.slot === t.stdin)) c.addIssue({ code: 'custom', message: 'a slot goes to stdin or to an argument, not both', path: ['stdin'] })
  }
})
export type LocalCliTool = z.infer<typeof LocalCliTool>

export const LocalMcpSpec = z.object({
  adapter: z.literal('mcp'),
  command: Program,
  args: z.array(Arg).max(100),
  env: z.array(LocalEnvName).max(20),
}).strict()
export const LocalCliSpec = z.object({
  adapter: z.literal('cli'),
  command: Program,
  env: z.array(LocalEnvName).max(20),
  tools: z.array(LocalCliTool).min(1).max(20),
}).strict().refine((s) => new Set(s.tools.map((t) => t.name)).size === s.tools.length, { message: 'two tools have the same name', path: ['tools'] })
/** What runs on the computer: never a setting's value, never a shell line. */
export const LocalAppSpec = z.discriminatedUnion('adapter', [LocalMcpSpec, LocalCliSpec])
export type LocalAppSpec = z.infer<typeof LocalAppSpec>

/** The part of a spec the computer's one-time confirm covers: the program, its arguments, and for a CLI each tool's
 * argument template and stdin. A change here asks again on the computer; a new description, title or setting name does
 * not. Stable JSON (the desktop app hashes it). */
export function localCommandKey(s: LocalAppSpec): string {
  return s.adapter === 'mcp'
    ? JSON.stringify(['mcp', s.command, s.args])
    : JSON.stringify(['cli', s.command, s.tools.map((t) => [t.name, t.args, t.stdin ?? null, t.slots.map((x) => [x.name, x.type])])])
}

/** How a command line is read and written: a POSIX shell's way, or Windows' (backslashes are part of a path there). */
export type CommandStyle = 'posix' | 'windows'
/** The style for a system (process.platform, DesktopBridge.platform): 'windows' on win32. */
export const commandStyleFor = (platform: string | null | undefined): CommandStyle => (platform === 'win32' ? 'windows' : 'posix')
/** A program that only Windows names this way (a drive, a network share, a backslash): its line is written Windows' way
 * even where the system is not known (the web page). */
const looksWindows = (program: string) => /^[A-Za-z]:[\\/]|^\\\\|\\/.test(program)

/** One argument as people read it (display only: the program never gets a shell line). Windows: "…" around what has a
 * space or a special character, a " in it written twice. */
export function quoteArg(a: string, style: CommandStyle = 'posix'): string {
  if (style === 'windows') return /^[A-Za-z0-9_@%+=:,./\\~()-]+$/.test(a) ? a : `"${a.replace(/"/g, '""')}"`
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`
}
/** The command line as the confirm and Settings show it: "aside mcp"; a CLI: one line per tool ("ego-browser nodejs <
 * script"). `style`: the computer's (the desktop app passes its own); left out, a Windows path is written Windows' way. */
export function localCommandLines(s: LocalAppSpec, style: CommandStyle = looksWindows(s.command) ? 'windows' : 'posix'): string[] {
  const q = (a: string) => quoteArg(a, style)
  if (s.adapter === 'mcp') return [[s.command, ...s.args].map(q).join(' ')]
  return s.tools.map((t) => [q(s.command), ...t.args.map((a) => (typeof a === 'string' ? q(a) : `<${a.slot}>`))].join(' ') + (t.stdin ? ` < ${t.stdin}` : ''))
}

/** A Windows program file's ending that starts it (an unquoted path with spaces ends at the first one) */
const WIN_RUNNABLE_END = /\.(exe|cmd|bat|com)(?=\s|$)/i

/** A command line a person typed (Settings › Connectors › An app on your computer › Another program) as the program and
 * its arguments. Nothing here is a shell: the program gets these arguments as they are. A line with what only a shell
 * would read is refused (null), so it never runs as something else than it reads.
 *
 * 'posix' (macOS, Linux): split on spaces, '…' and "…" keep spaces, \ escapes the next character outside '…'; refused:
 * | & ; < > ` $( ) and an unclosed quote.
 *
 * 'windows': a backslash is part of a path (`C:\Tools\x.exe` stays as it is); "…" keeps spaces ("" inside is one ");
 * ' is an ordinary character (C:\Users\O'Brien); an unquoted program path with spaces that starts with a drive or a
 * share and ends in .exe, .cmd, .bat or .com is one program (`C:\Program Files\X\x.exe --flag`); ( ) are ordinary
 * (`Program Files (x86)`). Refused outside "…": | & ; < > ^ and a %NAME% (cmd would read them), and an unclosed ". */
export function splitCommand(line: string, style: CommandStyle = 'posix'): string[] | null {
  return style === 'windows' ? splitWindows(line) : splitPosix(line)
}

function splitPosix(line: string): string[] | null {
  const out: string[] = []
  let cur = '', has = false, q: '"' | "'" | null = null
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    if (q === "'") { if (ch === "'") q = null; else cur += ch; continue }
    if (q === '"') {
      if (ch === '"') q = null
      else if (ch === '\\' && i + 1 < line.length) cur += line[++i]
      else if (ch === '$' || ch === '`') return null
      else cur += ch
      continue
    }
    if (ch === "'" || ch === '"') { q = ch; has = true; continue }
    if (ch === '\\' && i + 1 < line.length) { cur += line[++i]; has = true; continue }
    if (/\s/.test(ch)) { if (has) { out.push(cur); cur = ''; has = false } continue }
    if ('|&;<>`$()'.includes(ch)) return null
    cur += ch; has = true
  }
  if (q) return null
  if (has) out.push(cur)
  return out.length ? out : null
}

/** what cmd.exe would read outside "…" (never passed on as it reads) */
const WIN_SHELL_ONLY = /[|&;<>^]|%[^%\s]+%/

function splitWindows(line: string): string[] | null {
  const out: string[] = []
  let rest = line.replace(/^\s+/, '')
  // an unquoted path with spaces: the program runs to its first .exe/.cmd/.bat/.com
  if (/^([A-Za-z]:[\\/]|\\\\)/.test(rest)) {
    const first = rest.split(/\s/, 1)[0]!
    const m = WIN_RUNNABLE_END.exec(rest)
    const program = m ? rest.slice(0, m.index + m[0].length) : ''
    // not when what comes before it reads as arguments (a flag, another drive's path) or holds a quote
    if (m && program.length > first.length && !/"|\s[-/]|.:[\\/]/.test(program.slice(first.length))) {
      if (WIN_SHELL_ONLY.test(program)) return null
      out.push(program)
      rest = rest.slice(program.length)
    }
  }
  let cur = '', has = false, quoted = false
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i]!
    if (quoted) {
      if (ch === '"') {
        if (rest[i + 1] === '"') { cur += '"'; i++ } else quoted = false
      } else cur += ch
      continue
    }
    if (ch === '"') { quoted = true; has = true; continue }
    if (/\s/.test(ch)) { if (has) { out.push(cur); cur = ''; has = false } continue }
    if ('|&;<>^'.includes(ch)) return null
    cur += ch; has = true
  }
  if (quoted) return null
  if (has) out.push(cur)
  // a %NAME% outside quotes (cmd would put a value there; nothing here does): read only on the unquoted text
  if (WIN_SHELL_ONLY.test(rest.replace(/"(?:[^"]|"")*"/g, ''))) return null
  return out.length ? out : null
}

/** Known tools, picked in Settings › Connectors › Add › An app on your computer (or the person types a command).
 * `reads`: an MCP preset's tools that only read, Trina's own list for a program that marks none of its tools
 * (MCP readOnlyHint): Aside 1.26 gives no annotations, so without it listing profiles asked on the "send" card
 * (docs/decisions/20261118-local-app-connectors.md "Aside's reads"). Only for the exact listed command (presetReads). */
export const LOCAL_APP_PRESETS: readonly { id: string; name: string; spec: LocalAppSpec; reads?: readonly string[]; notOn?: readonly string[]; download?: string }[] = [
  // browser_profiles lists profile ids, labels and whether each is connected; memory_search searches the person's own
  // Aside notes. repl (JavaScript in the logged-in browser) and exec (Aside's browser agent) are not here: they ask.
  // download: the app's own download page (macOS and Windows), said when its program is not on the computer (the npx
  // presets below have none: their install line names Node.js)
  { id: 'aside', name: 'Aside', spec: { adapter: 'mcp', command: 'aside', args: ['mcp'], env: [] }, reads: ['browser_profiles', 'memory_search'], download: 'https://aside.com/download' },
  {
    id: 'ego-lite', name: 'ego lite', download: 'https://lite.ego.app/download', spec: {
      adapter: 'cli', command: 'ego-browser', env: [], tools: [
        { name: 'read_guide', title: 'Read the guide', description: 'How to write ego-browser scripts (its helpers, pages, waits and the rules for starting and ending a reply). Read it before the first run_script of a chat.', args: ['skill'], slots: [], readOnly: true },
        {
          name: 'run_script', title: 'Run a browser script', description: 'Runs one Node.js script (ES module, top-level await) with ego-browser\'s helpers in Ego Lite and returns what it printed. Read the guide first.',
          args: ['nodejs'], stdin: 'script', slots: [{ name: 'script', description: 'The whole script', type: 'string', required: true }], readOnly: false,
        },
      ],
    },
  },
  // The two most downloaded MCP servers people run on their own computer (npm, 2026-11-16..22): Microsoft's Playwright
  // MCP and Google's Chrome DevTools MCP (research 2026-11-24, recommendation #6). npx runs a pinned version: the
  // computer's one-time confirm covers the command, so a new version asks again (never @latest); -y so npx never stops
  // at its install prompt, which would read the JSON-RPC as the answer. Both mark their read tools (readOnlyHint, checked
  // 2026-11-24 with tools/list: 25 and 33 tools), so no `reads` here. `notOn` win32: npx is npx.cmd there, and a .cmd
  // does not start with shell: false (Node's EINVAL, QA 2026-11-24 on Windows 11 with Node 24).
  { id: 'playwright', name: 'Playwright', spec: { adapter: 'mcp', command: 'npx', args: ['-y', '@playwright/mcp@0.0.86'], env: [] }, notOn: ['win32'] },
  { id: 'chrome-devtools', name: 'Chrome DevTools', spec: { adapter: 'mcp', command: 'npx', args: ['-y', 'chrome-devtools-mcp@1.13.0'], env: [] }, notOn: ['win32'] },
]

/** The tools Trina takes as reads for this spec: a listed preset's `reads` when the spec is exactly that preset's
 * command (localCommandKey), never for a command the person typed, even one that starts the same program. */
export function presetReads(spec: LocalAppSpec | null): ReadonlySet<string> {
  if (!spec) return NO_READS
  const key = localCommandKey(spec)
  const p = LOCAL_APP_PRESETS.find((x) => x.reads && localCommandKey(x.spec) === key)
  return p?.reads ? new Set(p.reads) : NO_READS
}
const NO_READS: ReadonlySet<string> = new Set()

/** The listed app whose command this spec is exactly (localCommandKey), else null: a command the person typed. */
export function presetOf(spec: LocalAppSpec | null): (typeof LOCAL_APP_PRESETS)[number] | null {
  if (!spec) return null
  const key = localCommandKey(spec)
  return LOCAL_APP_PRESETS.find((x) => localCommandKey(x.spec) === key) ?? null
}

/** why a call did not reach the program (the server turns each into words for the person and the AI) */
export const LocalFailure = z.enum([
  /** this window is not the desktop app (the web, the phone app) */
  'not_desktop',
  /** the person chose Cancel on the computer's confirm */
  'declined',
  /** the program could not start (not found, not allowed, exited at once) */
  'start_failed',
  /** the desktop app runs as root (it never starts a program then) */
  'root',
  /** the program stopped or broke the protocol */
  'failed',
  /** the desktop app is too old for this kind of call */
  'too_old',
  /** the confirm on the computer is still open: the person has not pressed Connect yet (it stays open; a later Connect
   * makes the page check again) */
  'unconfirmed',
])
export type LocalFailure = z.infer<typeof LocalFailure>

/** A JSON-RPC message (one object), to or from the program, as MCP sends it. */
const RpcMessage = z.record(z.string(), z.unknown())

export const LocalCall = z.object({
  /** unique per call; the window must not run the same callId twice (dedupe after reconnects) */
  callId: z.string().min(1).max(100),
  /** the turn it belongs to; null for a check from Settings */
  turnId: Uuid7.nullable(),
  /** the connection (the desktop app keeps its confirm and setting values by team and connection) */
  connectionId: z.string().min(1).max(100),
  name: z.string().max(100),
  spec: LocalAppSpec,
  /** one JSON-RPC request or notification for the program */
  message: RpcMessage,
  /** epoch ms after which the server stops waiting */
  deadline: z.number().int(),
})
export type LocalCall = z.infer<typeof LocalCall>

export const LocalResult = z.object({
  callId: z.string().min(1).max(100),
  ok: z.boolean(),
  /** the program's JSON-RPC answer (null: the call was a notification) */
  message: RpcMessage.nullable().optional(),
  failure: LocalFailure.optional(),
  /** what went wrong, for the log and the AI (never a setting's value: the desktop app hides them) */
  error: z.string().max(4000).optional(),
  /** start_failed, more exactly: not_found, no program by that name on this computer (the person installs it);
   * unsupported, a kind of file this system does not start (a .ps1 on Windows); unsafe_arg, a value cmd.exe would read
   * (a batch file on Windows). Optional: older desktop apps do not send it, and an older server drops it. */
  cause: z.enum(['not_found', 'unsupported', 'unsafe_arg']).optional(),
})
export type LocalResult = z.infer<typeof LocalResult>

/** The newest kind of call this server sends (DesktopBridge.localApps.version): an older desktop app answers too_old. */
export const LOCAL_APPS_BRIDGE_VERSION = 1

const Name = z.string().trim().min(1).max(60)
/** A new app on my computer (only the person, in Settings on their own computer): never a team connection. */
export const LocalIntegrationInput = z.object({
  name: Name,
  slug: z.string().regex(/^[a-z0-9]{1,12}$/).optional(),
  spec: LocalAppSpec,
  writePolicy: z.enum(['ask', 'allow', 'deny']).default('ask'),
}).strict()
export type LocalIntegrationInput = z.infer<typeof LocalIntegrationInput>
export const LocalIntegrationPatch = z.object({ spec: LocalAppSpec }).strict()

const LocalPollQuery = z.object({ windowId: z.string().min(8).max(64), waitMs: z.coerce.number().int().min(0).max(25_000).optional() })

export const LOCAL_APPS = {
  pollLocalCalls: endpoint({ method: 'GET', path: '/api/local-apps/calls', auth: 'user', owner: 'C', query: LocalPollQuery, response: z.object({ calls: z.array(LocalCall) }), summary: 'Long-poll fallback: pending local.call for this window (waits up to waitMs).' }),
  postLocalResult: endpoint({ method: 'POST', path: '/api/local-apps/results', auth: 'user', owner: 'C', body: LocalResult, response: empty, status: 204, summary: 'Long-poll fallback: local.result.' }),
}
