// Finding and starting a program the person connected (common/local-apps.ts), on each system. No Electron here, and
// every lookup goes through a `ProgramHost`, so the Windows rules are tested on any computer.
//
// Windows (docs/decisions/20261124-windows-local-apps.md):
// - A name without a path is looked for in PATH with PATHEXT's endings in order (`aside` → aside.exe, aside.cmd …),
//   never as a bare file without an ending (npm puts a sh script by that name beside its .cmd) and never in the current
//   folder.
// - .exe and .com start directly. Node refuses .cmd and .bat without a shell (CVE-2024-27980), so:
//   - an npm shim (`npx.cmd`, an npm-installed `aside.cmd`) is read, and the node.exe and script it would start are
//     started directly: no shell, so any argument reaches the program as it is;
//   - any other .cmd or .bat runs through `cmd.exe /d /s /v:off /c "…"`, and only when no argument holds what cmd
//     reads even inside quotes (" % ! ^, line breaks): such an argument is refused, never escaped (cmd's escaping is
//     not reliable: BatBadBut, 2024).
// - Anything else (.ps1, .js, .vbs …) is refused with words.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { BATCH_REFUSED, BATCH_REFUSED_RE, windowsShare } from '@mycel/shared/api'

export { windowsShare }

/** The computer a program is looked for on (tests: a fake one). */
export interface ProgramHost {
  platform: string
  env: NodeJS.ProcessEnv
  home: string
  /** a file (not a folder) is at this path */
  isFile(p: string): boolean
  /** POSIX: its mode lets it run (never asked on Windows) */
  isExecutable(p: string): boolean
  /** a small text file's content (an npm shim), null when it cannot be read or is larger than `max` bytes */
  readText(p: string, max: number): string | null
}

export function realProgramHost(): ProgramHost {
  return {
    platform: process.platform,
    env: process.env,
    home: os.homedir(),
    isFile: (p) => { try { return fs.statSync(p).isFile() } catch { return false } },
    isExecutable: (p) => { try { return (fs.statSync(p).mode & 0o111) !== 0 } catch { return false } },
    readText: (p, max) => { try { return fs.statSync(p).size > max ? null : fs.readFileSync(p, 'utf8') } catch { return null } },
  }
}

const hostOf = (h?: Partial<ProgramHost>): ProgramHost => ({ ...realProgramHost(), ...h })
const isWin = (h: ProgramHost) => h.platform === 'win32'

/** PATHEXT's endings, lower-case, in order (Windows' own when it is not set or holds nothing usable). */
export function pathExts(env: NodeJS.ProcessEnv): string[] {
  const own = (env.PATHEXT ?? env.PathExt ?? '').split(';').map((x) => x.trim().toLowerCase()).filter((x) => /^\.[a-z0-9]{1,10}$/.test(x))
  return own.length ? [...new Set(own)] : ['.com', '.exe', '.bat', '.cmd']
}

/** A full path as Windows writes one: a drive (C:\ or C:/) or a share (\\server\share). */
const winAbsolute = (p: string) => /^[A-Za-z]:[\\/]/.test(p)

// windowsShare (shared/src/api/local-apps.ts): a share or device path is never looked at, and refused with words
export const SHARE_REFUSED = (command: string) => `${command.slice(0, 200)} is on a network share or a device path (it starts with \\\\). Only programs on this computer can be connected: copy it to a folder on this computer and use that path.`

/** The program to start: a full path as it is (`~/`, on Windows also `~\`, is the home folder), a bare name found in
 * `dirs`. null: not found. */
export function resolveProgram(command: string, dirs: string[], h?: Partial<ProgramHost>): string | null {
  const host = hostOf(h)
  if (isWin(host)) return resolveWindows(command, dirs, host)
  const c = command.startsWith('~/') ? path.posix.join(host.home, command.slice(2)) : command
  const runnable = (p: string) => host.isFile(p) && host.isExecutable(p)
  if (c.includes('/')) return path.posix.isAbsolute(c) && runnable(c) ? c : null
  for (const d of dirs) {
    const p = path.posix.join(d, c)
    if (runnable(p)) return p
  }
  return null
}

function resolveWindows(command: string, dirs: string[], host: ProgramHost): string | null {
  // a share or device path: refused before any file check (windowsShare)
  if (windowsShare(command)) return null
  const w = path.win32
  const c = /^~[\\/]/.test(command) ? w.join(host.home, command.slice(2)) : command
  const exts = pathExts(host.env)
  const own = w.extname(c).toLowerCase()
  // a name with one of PATHEXT's endings is tried as it is; otherwise each ending is added, in PATHEXT's order, and a
  // file named with another ending (tool.ps1) last, so the person hears it is not a kind Windows starts (launchFor),
  // not that it is missing
  const names = (base: string) => (own && exts.includes(own) ? [base] : [...exts.map((e) => base + e), ...(own ? [base] : [])])
  if (c.includes('\\') || c.includes('/')) {
    if (!winAbsolute(c)) return null
    return names(w.normalize(c)).find((p) => host.isFile(p)) ?? null
  }
  for (const d of dirs) {
    if (!winAbsolute(d) || windowsShare(d)) continue
    for (const p of names(w.join(d, c))) if (host.isFile(p)) return p
  }
  return null
}

/** How to start a program found by resolveProgram with these arguments, or why it cannot be. `verbatim`: the arguments
 * are one command line for cmd.exe as they are (Node's windowsVerbatimArguments). */
export type Launch = { file: string; args: string[]; verbatim?: true; via?: 'npm' | 'cmd'; env?: Record<string, string> } | { refused: 'unsupported' | 'unsafe_arg'; error: string }

/** what cmd.exe reads even inside "…": never passed through it (BATCH_REFUSED, the list the words say) */
const CMD_UNSAFE = BATCH_REFUSED_RE
/** what cmd.exe passes on as it is without quotes */
const CMD_PLAIN = /^[A-Za-z0-9_\-.:/\\@+~]+$/

export function launchFor(program: string, args: string[], h?: Partial<ProgramHost>): Launch {
  const host = hostOf(h)
  if (!isWin(host)) return { file: program, args }
  const ext = path.win32.extname(program).toLowerCase()
  if (ext === '.exe' || ext === '.com') return { file: program, args }
  if (ext === '.cmd' || ext === '.bat') {
    const shim = readNpmShim(program, host)
    if (shim) return { file: shim.file, args: [...shim.args, ...args], via: 'npm' }
    return cmdLaunch(program, args, host)
  }
  return { refused: 'unsupported', error: `${path.win32.basename(program)} is a ${ext || 'file without an ending'}: only .exe, .com, .cmd and .bat programs can be started on Windows` }
}

/** cmd.exe for a .cmd or .bat that is not an npm shim: `/d` (no AutoRun commands), `/v:off` (no !…! values), `/s /c`
 * with the whole line in quotes, each argument as it is or in "…". Refused: an argument (or the path) with what cmd
 * would read in it, so nothing reaches cmd that runs as something else than it reads. */
export function cmdLaunch(program: string, args: string[], host: ProgramHost): Launch {
  const bad = [program, ...args].find((a) => CMD_UNSAFE.test(a))
  if (bad !== undefined) {
    return { refused: 'unsafe_arg', error: `${path.win32.basename(program)} is a batch file, which Windows runs through cmd.exe, and a value has a character cmd.exe would read (${BATCH_REFUSED.join(' ')} or a line break), so it was not run. Pass that value another way, or use the program's .exe.` }
  }
  const q = (a: string) => (CMD_PLAIN.test(a) ? a : `"${a}"`)
  const line = [`"${program}"`, ...args.map(q)].join(' ')
  const root = host.env.SystemRoot ?? host.env.SYSTEMROOT ?? host.env.windir ?? 'C:\\Windows'
  // NoDefaultCurrentDirectoryInExePath: a command the batch file runs is never looked for in its current folder first
  return { file: path.win32.join(root, 'System32', 'cmd.exe'), args: ['/d', '/s', '/v:off', '/c', `"${line}"`], verbatim: true, via: 'cmd', env: { NoDefaultCurrentDirectoryInExePath: '1' } }
}

/** the largest shim read (npm's are under 1 KB) */
const SHIM_MAX = 16 * 1024

/**
 * An npm shim's program and script, so they start without cmd.exe: cmd-shim's (`aside.cmd`: `"%_prog%" "%dp0%\…\cli.js"
 * %*`, _prog being `%dp0%\node.exe` or `node`) and npm's own (`npx.cmd`: `"%NODE_EXE%" "%NPX_CLI_JS%" %*`). Only a
 * last line made of: the program (a variable, or a path beside the shim), paths beside the shim that exist, plain flags,
 * and `%*` at the end. Its program must be node.exe (beside the shim, or in PATH) or an .exe beside the shim. null: not
 * such a shim (it then runs through cmd.exe).
 */
export function readNpmShim(file: string, h?: Partial<ProgramHost>): { file: string; args: string[] } | null {
  const host = hostOf(h)
  const w = path.win32
  const text = host.readText(file, SHIM_MAX)
  if (!text) return null
  const dir = w.dirname(file)
  const lines = text.split(/\r?\n/).map((l) => l.trim())
  // SET "NAME=value" lines, every value in order (the IF … ELSE branches give a variable two)
  const vars = new Map<string, string[]>()
  for (const l of lines) {
    const m = /^SET\s+"([A-Za-z_][A-Za-z0-9_]*)=([^"]*)"$/i.exec(l)
    if (m) vars.set(m[1]!.toUpperCase(), [...(vars.get(m[1]!.toUpperCase()) ?? []), m[2]!])
  }
  const last = [...lines].reverse().find((l) => /(^|\s)%\*$/.test(l))
  if (!last) return null
  // the command after cmd-shim's "endLocal & goto … & ": its last part
  const cmd = last.split(/\s&\s/).pop()!.trim()
  const tokens: string[] = []
  const re = /"([^"]*)"|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(cmd))) tokens.push(m[1] ?? m[2]!)
  if (tokens.length < 2 || tokens.pop() !== '%*') return null
  const besideShim = (v: string): string | null => {
    const r = /^%~?dp0%?\\?(.*)$/i.exec(v)
    if (!r) return null
    // relative to the shim's folder (npm's global layout uses ..\ too); it must be a file that is there
    const p = w.normalize(w.join(dir, r[1]!))
    return host.isFile(p) ? p : null
  }
  // a value: a path beside the shim, or a variable's first value that is one (depth 2), or `node` in PATH
  const value = (v: string, depth = 0): string | null => {
    const at = besideShim(v)
    if (at) return at
    const ref = /^%([A-Za-z_][A-Za-z0-9_]*)%$/.exec(v)
    if (ref && depth < 2) {
      for (const x of vars.get(ref[1]!.toUpperCase()) ?? []) { const r = value(x, depth + 1); if (r) return r }
      return null
    }
    if (/^node(\.exe)?$/i.test(v)) return resolveProgram('node.exe', (host.env.PATH ?? host.env.Path ?? '').split(';').filter(Boolean), host)
    return null
  }
  const prog = value(tokens[0]!)
  if (prog && windowsShare(prog)) return null
  if (!prog || w.extname(prog).toLowerCase() !== '.exe') return null
  // the program is node.exe, or an .exe the shim names beside itself
  if (w.basename(prog).toLowerCase() !== 'node.exe' && !besideShim(tokens[0]!)) return null
  const args: string[] = []
  for (const tok of tokens.slice(1)) {
    if (/^--?[A-Za-z0-9][A-Za-z0-9_.=-]*$/.test(tok)) { args.push(tok); continue }
    const p = /^%/.test(tok) ? value(tok) : null
    if (!p) return null
    args.push(p)
  }
  return { file: prog, args }
}
