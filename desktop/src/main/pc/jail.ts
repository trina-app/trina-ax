// Running one program in the macOS jail of the PC runner (common/pc-sandbox.ts). Every program runs in its own process
// group, so ending it ends what it started. stdin is closed unless the tool sends something: a command cannot ask.
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { closeSync, existsSync, openSync, realpathSync } from 'node:fs'
import { userInfo } from 'node:os'
import { sandboxProfile, type PcGrants, type PcSandboxPaths } from '../../common/pc-sandbox'
import { debug } from '../debug'

const SANDBOX_EXEC = '/usr/bin/sandbox-exec'
/** a finished program gets this long for its output to arrive, in case something it started holds the pipe open */
const DRAIN_MS = 300
const TERM_MS = 2000
const FALLBACK_PATH = '/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'

export const jailAvailable = () => process.platform === 'darwin' && process.mas !== true && existsSync(SANDBOX_EXEC)

export interface JailSpec {
  paths: PcSandboxPaths
  grants: PcGrants
  env: Record<string, string>
  file: string
  args: string[]
  cwd: string
  /** bytes for the program's stdin */
  stdin?: string
  timeoutMs: number
  /** bytes kept of each of stdout and stderr; the program goes on and its later output is dropped */
  limit: number
  /** a stdout larger than `limit` ends the program (a file read) */
  stopAtLimit?: boolean
  /** a background program writes here instead of a pipe */
  logFile?: string
}

export interface JailResult {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: Buffer
  stderr: Buffer
  truncated: boolean
  timedOut: boolean
  /** stopped from outside: stop button, the turn ended, the app closed */
  stopped: boolean
  ms: number
}

const killGroup = (pid: number, signal: NodeJS.Signals) => {
  try {
    process.kill(-pid, signal)
  } catch {
    // the group is gone
  }
}

export class JailedProgram {
  readonly done: Promise<JailResult>
  private child: ChildProcess
  private stopped = false
  private termTimer?: NodeJS.Timeout

  constructor(s: JailSpec) {
    const started = Date.now()
    const log = s.logFile ? openSync(s.logFile, 'a', 0o600) : null
    this.child = spawn(SANDBOX_EXEC, ['-p', sandboxProfile(s.paths, s.grants), s.file, ...s.args], {
      cwd: s.cwd,
      env: s.env,
      detached: true,
      stdio: [s.stdin === undefined ? 'ignore' : 'pipe', log ?? 'pipe', log ?? 'pipe'],
    })
    if (log !== null) closeSync(log)
    this.done = new Promise((resolve) => {
      const out: Buffer[] = []
      const err: Buffer[] = []
      let outBytes = 0
      let errBytes = 0
      let truncated = false
      let timedOut = false
      let exit: { code: number | null; signal: NodeJS.Signals | null } | null = null
      let finished = false
      const finish = () => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        clearTimeout(this.termTimer)
        // nothing outlives the program unless it was started to: a stray `&` in a command ends here
        if (this.child.pid) killGroup(this.child.pid, 'SIGKILL')
        resolve({ code: exit?.code ?? null, signal: exit?.signal ?? null, stdout: Buffer.concat(out), stderr: Buffer.concat(err), truncated, timedOut, stopped: this.stopped, ms: Date.now() - started })
      }
      const keep = (list: Buffer[], used: number, b: Buffer) => {
        const room = s.limit - used
        if (room <= 0) truncated = true
        else if (b.length > room) {
          list.push(b.subarray(0, room))
          truncated = true
        } else list.push(b)
        return used + Math.min(b.length, Math.max(room, 0))
      }
      this.child.stdout?.on('data', (b: Buffer) => {
        outBytes = keep(out, outBytes, b)
        if (s.stopAtLimit && outBytes >= s.limit) this.stop()
      })
      this.child.stderr?.on('data', (b: Buffer) => (errBytes = keep(err, errBytes, b)))
      const timer = s.timeoutMs > 0 ? setTimeout(() => {
        timedOut = true
        this.stop()
      }, s.timeoutMs) : undefined
      this.child.on('error', (e) => {
        err.push(Buffer.from(e.message))
        exit ??= { code: null, signal: null }
        finish()
      })
      this.child.on('exit', (code, signal) => {
        exit = { code, signal }
        setTimeout(finish, DRAIN_MS)
      })
      this.child.on('close', finish)
    })
    if (s.stdin !== undefined) {
      this.child.stdin?.on('error', () => {}) // the program ended before it read everything
      this.child.stdin?.end(s.stdin)
    }
  }

  get pid() { return this.child.pid }

  /** Ask the group to end, then make it. */
  stop() {
    const pid = this.child.pid
    if (!pid) return
    this.stopped = true
    killGroup(pid, 'SIGTERM')
    this.termTimer ??= setTimeout(() => killGroup(pid, 'SIGKILL'), TERM_MS)
  }

  /** The app is closing: there is no later. */
  kill() {
    this.stopped = true
    if (this.child.pid) killGroup(this.child.pid, 'SIGKILL')
  }
}

let shellPath: Promise<string> | null = null

/**
 * The PATH of the person's own shell, asked for once and only that: an app started from the Finder has a bare PATH, and
 * version managers are set up in the interactive profile. The profile runs here as it does in any terminal of theirs,
 * outside the jail, and nothing else of its environment comes along (common/pc-run.ts commandEnv says why).
 */
export function loginPath(): Promise<string> {
  shellPath ??= new Promise((resolve) => {
    const shell = userInfo().shell || '/bin/zsh'
    execFile(shell, ['-ilc', 'printf "\\n__PC_PATH__%s__PC_END__\\n" "$PATH"'], { timeout: 5000, encoding: 'utf8', env: process.env, maxBuffer: 1 << 20 }, (_e, out) => {
      const m = /__PC_PATH__(.*)__PC_END__/.exec(String(out ?? ''))
      const dirs = (m?.[1] ?? '').split(':').filter((d) => d.startsWith('/'))
      debug('login path', dirs.length)
      resolve(dirs.length ? dirs.join(':') : FALLBACK_PATH)
    })
  })
  return shellPath
}

/** The folders of a PATH as the sandbox sees them; a folder that does not exist has no rule. */
export function realDirs(path: string): string[] {
  const out = new Set<string>()
  for (const d of path.split(':')) {
    try {
      out.add(realpathSync(d))
    } catch {
      // not there
    }
  }
  return [...out]
}

/** The ssh agent's socket as the sandbox sees it (it reports /private paths). */
export const agentSocket = (): string | undefined => process.env.SSH_AUTH_SOCK?.replace(/^\/(var|tmp)\//, '/private/$1/')
