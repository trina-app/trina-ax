// Running converters (pandoc, typst, pdftotext, whisper.cpp, ffmpeg, sips) on input that people or the AI chose.
// Design tab 3 "변환기 격리": converters parse untrusted files, so they never run with the server's full rights.
//
// What this does (dev / local-login and the server account alike):
// - macOS: sandbox-exec profile — no network, no fork/exec of anything but the converter itself, writes only into
//   an empty work folder, no reading of file contents under /Users, /Volumes, the temp folders, the team folder or
//   the server data (only the work folder and explicitly listed inputs are readable), no signals / process info
//   for other processes. File *metadata* stays readable: typst and pandoc stat parent folders of their cwd.
// - Linux: bubblewrap (bwrap) when installed: read-only system, private /tmp, no network, only the work folder
//   and listed inputs bound in. Without bwrap the converter runs directly (with its own safe flags, e.g.
//   pandoc --sandbox, typst --root) and isolation() reports it, so diagnostics can show it.
// - Always: minimal environment (PATH, LANG, HOME/TMPDIR = work folder), cwd = work folder, a time limit (SIGKILL),
//   and an output size limit.
// Production (role accounts): the launcher runs converters as _axagent with the same profile (component G / the
// launcher protocol); this module is the in-process fallback and the profile source.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PRODUCT } from '@mycel/shared'
import { which } from '../config'

export interface IsolatedRun {
  /** absolute path of the converter (resolved through symlinks before it is allowed to exec) */
  cmd: string
  args: string[]
  stdin?: Uint8Array
  /** work folder (must exist, empty or holding only the inputs). Default: a fresh temp folder, removed afterwards. */
  workDir?: string
  /** extra files/folders the converter may read (e.g. a whisper model) */
  readPaths?: string[]
  /** server-private folders whose contents must stay unreadable even if they are not under the default list */
  denyRead?: string[]
  /** Metal GPU (whisper.cpp): the per-user Metal shader cache must be readable / writable, otherwise every run
   * recompiles the shaders (15 s instead of 0.4 s, measured) */
  gpu?: boolean
  timeoutMs?: number
  /** stdout cap (bytes); the process is killed when it writes more */
  maxStdout?: number
  env?: Record<string, string>
  /** called with stderr text as it arrives (progress parsing) */
  onStderr?: (s: string) => void
  signal?: AbortSignal
}

export interface IsolatedResult {
  code: number | null
  stdout: Buffer
  stderr: string
  killed: null | 'timeout' | 'output' | 'aborted'
  workDir: string
}

export type IsolationKind = 'sandbox-exec' | 'bwrap' | 'none'

let detected: IsolationKind | null = null
/** Which isolation this machine offers. */
export function isolation(): IsolationKind {
  if (detected) return detected
  if (process.env.MYCEL_ISOLATION === 'none') return (detected = 'none')
  if (process.platform === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec')) detected = 'sandbox-exec'
  else if (process.platform === 'linux' && which('bwrap')) detected = 'bwrap'
  else detected = 'none'
  return detected
}

const real = (p: string) => { try { return fs.realpathSync(p) } catch { return path.resolve(p) } }
const sq = (s: string) => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'

/** The macOS sandbox profile for one run (exported for tests and the launcher). */
let metalCache: string[] | null = null
function metalCacheDirs(): string[] {
  if (metalCache) return metalCache
  metalCache = []
  try {
    const r = Bun.spawnSync(['/usr/bin/getconf', 'DARWIN_USER_CACHE_DIR'])
    const dir = r.stdout.toString().trim()
    if (r.exitCode === 0 && dir) metalCache = ['com.apple.metal', 'com.apple.metalfe'].map((d) => path.join(real(dir), d))
  } catch { /* not macOS */ }
  return metalCache
}

export function sandboxProfile(o: { cmd: string; workDir: string; readPaths: string[]; denyRead: string[]; gpu?: boolean }): string {
  const gpu = o.gpu ? metalCacheDirs() : []
  const deny = [...new Set([
    '/Users', '/Volumes', '/private/tmp', '/private/var/folders', '/private/var/root', '/Library/Keychains',
    `/Library/Application Support/${PRODUCT.id}`, os.homedir(), ...o.denyRead,
  ].map(real))]
  const allowRead = [o.workDir, ...o.readPaths].map(real).concat(gpu)
  return [
    '(version 1)',
    '(allow default)',
    '(deny network*)',
    '(deny process-fork)',
    '(deny process-exec)',
    `(allow process-exec (literal ${sq(real(o.cmd))}))`,
    '(deny signal (target others))',
    '(deny process-info* (target others))',
    '(deny file-write*)',
    `(allow file-write* (subpath ${sq(real(o.workDir))}) (literal "/dev/null")${gpu.map((d) => ` (subpath ${sq(d)})`).join('')})`,
    `(deny file-read-data ${deny.map((d) => `(subpath ${sq(d)})`).join(' ')})`,
    `(allow file-read-data ${allowRead.map((d) => `(subpath ${sq(d)})`).join(' ')})`,
  ].join('\n')
}

function bwrapArgs(o: { cmd: string; workDir: string; readPaths: string[] }): string[] {
  const a = ['--die-with-parent', '--unshare-all', '--new-session', '--clearenv']
  for (const d of ['/usr', '/bin', '/lib', '/lib64', '/lib32', '/etc/alternatives', '/etc/fonts', '/etc/ssl', '/usr/share'])
    if (fs.existsSync(d)) a.push('--ro-bind', d, d)
  a.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--bind', o.workDir, o.workDir)
  for (const p of o.readPaths) a.push('--ro-bind', p, p)
  const dir = path.dirname(o.cmd)
  if (!['/usr', '/bin'].some((d) => dir === d || dir.startsWith(d + '/'))) a.push('--ro-bind', dir, dir)
  a.push('--chdir', o.workDir)
  return a
}

/** Run a converter isolated. Never throws for a non-zero exit; check `code`. */
export async function runIsolated(o: IsolatedRun): Promise<IsolatedResult> {
  const ownDir = !o.workDir
  const workDir = real(o.workDir ?? fs.mkdtempSync(path.join(os.tmpdir(), `${PRODUCT.id}-conv-`)))
  const cmd = real(o.cmd)
  const env: Record<string, string> = { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', HOME: workDir, TMPDIR: workDir, ...o.env }
  const kind = isolation()
  let argv: string[]
  if (kind === 'sandbox-exec') {
    argv = ['/usr/bin/sandbox-exec', '-p', sandboxProfile({ cmd, workDir, readPaths: o.readPaths ?? [], denyRead: o.denyRead ?? [], gpu: o.gpu }), cmd, ...o.args]
  } else if (kind === 'bwrap') {
    argv = [which('bwrap')!, ...bwrapArgs({ cmd, workDir, readPaths: o.readPaths ?? [] }), ...Object.entries(env).flatMap(([k, v]) => ['--setenv', k, v]), cmd, ...o.args]
  } else {
    argv = [cmd, ...o.args]
  }
  const p = Bun.spawn(argv, { cwd: workDir, env, stdin: o.stdin ? 'pipe' : 'ignore', stdout: 'pipe', stderr: 'pipe' })
  let killed: IsolatedResult['killed'] = null
  const kill = (why: NonNullable<IsolatedResult['killed']>) => { if (!killed) { killed = why; try { p.kill('SIGKILL') } catch {} } }
  const timer = setTimeout(() => kill('timeout'), o.timeoutMs ?? 60_000)
  const onAbort = () => kill('aborted')
  if (o.signal) { if (o.signal.aborted) onAbort(); else o.signal.addEventListener('abort', onAbort, { once: true }) }
  if (o.stdin) {
    const w = p.stdin as import('bun').FileSink
    try { w.write(o.stdin); await w.end() } catch { /* converter closed stdin early */ }
  }
  const max = o.maxStdout ?? 64 * 1024 * 1024
  const outP = (async () => {
    const parts: Uint8Array[] = []
    let n = 0
    for await (const ch of p.stdout as ReadableStream<Uint8Array>) {
      n += ch.byteLength
      if (n > max) { kill('output'); break }
      parts.push(ch)
    }
    return Buffer.concat(parts)
  })()
  const errP = (async () => {
    const dec = new TextDecoder()
    let s = ''
    for await (const ch of p.stderr as ReadableStream<Uint8Array>) {
      const t = dec.decode(ch, { stream: true })
      o.onStderr?.(t)
      if (s.length < 64 * 1024) s += t
    }
    return s
  })()
  const [stdout, stderr, code] = await Promise.all([outP, errP, p.exited])
  clearTimeout(timer)
  o.signal?.removeEventListener('abort', onAbort)
  const res: IsolatedResult = { code: killed ? null : code, stdout, stderr, killed, workDir }
  if (ownDir) fs.rmSync(workDir, { recursive: true, force: true })
  return res
}

/** A fresh empty work folder for a multi-step conversion (caller removes it). */
export function makeWorkDir(base?: string): string {
  const parent = base ?? os.tmpdir()
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 })
  return real(fs.mkdtempSync(path.join(parent, `${PRODUCT.id}-conv-`)))
}
