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
import { cgexecPrefix } from '../system/cgroups'

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
  /** HWP: deny host font directories; only explicitly staged fonts are available. */
  curatedFonts?: boolean
  timeoutMs?: number
  /** stdout cap (bytes); the process is killed when it writes more */
  maxStdout?: number
  /** resident memory cap (MiB) of the converter and its children, checked a few times a second; the process is
   * killed above it. Where the converter cgroup is set up (production Linux) its memory.max applies as well. */
  maxRssMiB?: number
  /** bytes the converter may write into its work folder (all files together, inputs included), checked a few times a
   * second; the process is killed above it ('disk') */
  maxWorkBytes?: number
  env?: Record<string, string>
  /** called with stderr text as it arrives (progress parsing) */
  onStderr?: (s: string) => void
  signal?: AbortSignal
}

export interface IsolatedResult {
  code: number | null
  stdout: Buffer
  stderr: string
  killed: null | 'timeout' | 'output' | 'aborted' | 'memory' | 'disk'
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

export function sandboxProfile(o: { cmd: string; workDir: string; readPaths: string[]; denyRead: string[]; gpu?: boolean; curatedFonts?: boolean }): string {
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
    ...(o.curatedFonts ? [
      // HWP must not inherit the general converters' deny-list: e.g. /var/tmp and
      // /opt can contain unrelated private files. Permit only OS runtime data,
      // the executable and the explicit per-job inputs below.
      '(deny file-read-data)',
      '(allow file-read-data (subpath "/System/Library/Frameworks") (subpath "/System/Library/PrivateFrameworks") (subpath "/usr/lib") (subpath "/usr/share/icu") (subpath "/private/var/db/dyld") (subpath "/private/var/db/timezone") (subpath "/System/Library/dyld") (literal "/") (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom"))',
      `(allow file-read-data (literal ${sq(real(o.cmd))}))`,
      '(deny mach-lookup (global-name "com.apple.FontObjectsServer"))',
    ] : []),
    '(deny process-fork)',
    '(deny process-exec)',
    `(allow process-exec (literal ${sq(real(o.cmd))}))`,
    '(deny signal (target others))',
    '(deny process-info* (target others))',
    '(deny file-write*)',
    `(allow file-write* (subpath ${sq(real(o.workDir))}) (literal "/dev/null")${gpu.map((d) => ` (subpath ${sq(d)})`).join('')})`,
    `(deny file-read-data ${deny.map((d) => `(subpath ${sq(d)})`).join(' ')})`,
    `(allow file-read-data ${allowRead.map((d) => `(subpath ${sq(d)})`).join(' ')})`,
    // the listing of the converter's own folder (not the files in it): Apple's frameworks look next to the executable
    // (mycel-ocr's Vision request fails without it when the helper sits under a denied folder such as the home)
    `(allow file-read-data (literal ${sq(path.dirname(real(o.cmd)))}))`,
  ].join('\n')
}

/** bwrap 0.8.0+ (Debian 12+, Ubuntu 24.04): --disable-userns. Older ones (dev machines) run without it. */
let bwrapModern: boolean | null = null
function bwrapIsModern(bin: string): boolean {
  if (bwrapModern === null) {
    const m = /(\d+)\.(\d+)\.(\d+)/.exec(Bun.spawnSync([bin, '--version']).stdout.toString())
    bwrapModern = !!m && (+m[1]! > 0 || +m[2]! >= 8)
  }
  return bwrapModern
}

function bwrapArgs(o: { cmd: string; workDir: string; readPaths: string[]; modern?: boolean; curatedFonts?: boolean }): string[] {
  const a = ['--die-with-parent', '--unshare-all', '--new-session', '--clearenv']
  // linux-runtime spec 3.8.2: no NESTED user namespaces, no capabilities. bwrap 0.12 wants --unshare-user spelled
  // out next to --disable-userns (--unshare-all alone is not enough for that check).
  if (o.modern) a.push('--unshare-user', '--disable-userns', '--cap-drop', 'ALL')
  for (const d of ['/usr', '/bin', '/lib', '/lib64', '/lib32', '/etc/alternatives', '/etc/fonts', '/etc/ssl', '/usr/share', '/etc/ld.so.cache'])
    if (fs.existsSync(d)) a.push('--ro-bind', d, d)
  a.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--bind', o.workDir, o.workDir)
  for (const p of o.readPaths) a.push('--ro-bind', p, p)
  const dir = path.dirname(o.cmd)
  if (!['/usr', '/bin'].some((d) => dir === d || dir.startsWith(d + '/'))) a.push('--ro-bind', dir, dir)
  if (o.curatedFonts) for (const d of ['/usr/share/fonts', '/usr/local/share/fonts', '/etc/fonts']) if (fs.existsSync(d)) a.push('--tmpfs', d)
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
    argv = ['/usr/bin/sandbox-exec', '-p', sandboxProfile({ cmd, workDir, readPaths: o.readPaths ?? [], denyRead: o.denyRead ?? [], gpu: o.gpu, curatedFonts: o.curatedFonts }), cmd, ...o.args]
  } else if (kind === 'bwrap') {
    const bwrap = which('bwrap')!
    // production Linux: the converter starts inside the server's converter cgroup with rlimits (system/cgroups.ts)
    argv = [...cgexecPrefix(o.timeoutMs ?? 60_000), bwrap, ...bwrapArgs({ cmd, workDir, readPaths: o.readPaths ?? [], modern: bwrapIsModern(bwrap), curatedFonts: o.curatedFonts }),
      ...Object.entries(env).flatMap(([k, v]) => ['--setenv', k, v]), cmd, ...o.args]
  } else {
    argv = [cmd, ...o.args]
  }
  const p = Bun.spawn(argv, { cwd: workDir, env, stdin: o.stdin ? 'pipe' : 'ignore', stdout: 'pipe', stderr: 'pipe' })
  let killed: IsolatedResult['killed'] = null
  const kill = (why: NonNullable<IsolatedResult['killed']>) => { if (!killed) { killed = why; try { p.kill('SIGKILL') } catch {} } }
  const timer = setTimeout(() => kill('timeout'), o.timeoutMs ?? 60_000)
  const watch = o.maxRssMiB || o.maxWorkBytes ? setInterval(() => {
    if (o.maxRssMiB) void treeRssKiB(p.pid).then((kib) => { if (kib > o.maxRssMiB! * 1024) kill('memory') })
    if (o.maxWorkBytes && dirBytes(workDir) > o.maxWorkBytes) kill('disk')
  }, RSS_POLL_MS) : null
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
  if (watch) clearInterval(watch)
  o.signal?.removeEventListener('abort', onAbort)
  const res: IsolatedResult = { code: killed ? null : code, stdout, stderr, killed, workDir }
  if (ownDir) fs.rmSync(workDir, { recursive: true, force: true })
  return res
}

const RSS_POLL_MS = 200

/** Bytes of the files in a folder and its subfolders (links are not followed). */
function dirBytes(dir: string): number {
  let n = 0
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) n += dirBytes(p)
      else if (e.isFile()) { try { n += fs.lstatSync(p).size } catch {} }
    }
  } catch {}
  return n
}

/** Resident memory (KiB) of a process and its descendants (Linux: /proc; macOS: ps). 0 when it is gone. */
export async function treeRssKiB(pid: number): Promise<number> {
  if (process.platform === 'linux') {
    let kib = 0
    const todo = [pid]
    for (let n = 0; todo.length && n < 64; n++) {
      const q = todo.pop()!
      try {
        const m = /^VmRSS:\s+(\d+)/m.exec(fs.readFileSync(`/proc/${q}/status`, 'utf8'))
        if (m) kib += Number(m[1])
        for (const t of fs.readdirSync(`/proc/${q}/task`)) {
          for (const c of fs.readFileSync(`/proc/${q}/task/${t}/children`, 'utf8').split(' ')) if (c.trim()) todo.push(Number(c))
        }
      } catch { /* gone */ }
    }
    return kib
  }
  try {
    // the converter and its children (sandbox-exec execs the converter in place, so pid is the converter)
    const r = Bun.spawn(['/bin/ps', '-A', '-o', 'pid=,ppid=,rss='], { stdout: 'pipe', stderr: 'ignore' })
    const rows = (await new Response(r.stdout).text()).trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number))
    const kids = new Map<number, number[]>()
    const rss = new Map<number, number>()
    for (const [p, pp, k] of rows) { if (p === undefined || pp === undefined) continue; rss.set(p, k ?? 0); kids.set(pp, [...(kids.get(pp) ?? []), p]) }
    let kib = 0
    const todo = [pid]
    for (let n = 0; todo.length && n < 64; n++) { const q = todo.pop()!; kib += rss.get(q) ?? 0; todo.push(...(kids.get(q) ?? [])) }
    return kib
  } catch { return 0 }
}

/** A fresh empty work folder for a multi-step conversion (caller removes it). */
export function makeWorkDir(base?: string): string {
  const parent = base ?? os.tmpdir()
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 })
  return real(fs.mkdtempSync(path.join(parent, `${PRODUCT.id}-conv-`)))
}
