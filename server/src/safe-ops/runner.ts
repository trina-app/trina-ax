// Internal fixed-operation runner. No model-controlled executable, argv, environment or bind mounts.
// Unsupported hosts fail closed. The old converter runner is deliberately NOT a fallback.
import fs from 'node:fs'
import { checkWorkflowEnvelope, reserveJob } from './workflow'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { converterCgroup } from '../system/cgroups'
import { nativeBinDir, which } from '../config'
import { ToolError } from '../policy/errors'

export const SAFE_INPUT_MAX = 8 * 1024 ** 2
export const SAFE_OUTPUT_MAX = 1024 ** 2
const JOB_LIMITS = {
  'memory.max': '536870912',
  'memory.swap.max': '0',
  'pids.max': '64',
  'cpu.max': '100000 100000',
  'memory.oom.group': '1',
}
const env = {
  PATH: '/nonexistent',
  HOME: '/work',
  TMPDIR: '/work',
  XDG_CACHE_HOME: '/work',
  LANG: 'C.UTF-8',
  GOMAXPROCS: '2',
}
export const unavailable = () =>
  new ToolError('Qualified image/PowerPoint conversion is unavailable on this server.', 'safe_ops_unavailable')

/** Configuration is not readiness: every job reads back limits and joins them before bwrap.
 * The native exec stage applies required Landlock and seccomp, or never execs the parser.
 * Private PID/network namespaces provide the fixed helper's signal/socket scope on pre-ABI-6 hosts. */
export const safeOpsEnabled = () => process.env.MYCEL_SAFE_OPS_1A === '1'
export function safeOpsConfigured(): boolean {
  return process.platform === 'linux' && !!converterCgroup() && process.env.MYCEL_ISOLATION !== 'none'
}

function verifiedLimit(dir: string, file: string, value: string) {
  fs.writeFileSync(path.join(dir, file), value)
  if (fs.readFileSync(path.join(dir, file), 'utf8').trim() !== value) throw unavailable()
}

function jobCgroup(): { dir: string; helper: string } {
  const c = converterCgroup()
  if (!safeOpsConfigured() || !c) throw unavailable()
  const memory = Number(fs.readFileSync(path.join(c.dir, 'memory.max'), 'utf8').trim())
  const pids = Number(fs.readFileSync(path.join(c.dir, 'pids.max'), 'utf8').trim())
  const cpu = fs.readFileSync(path.join(c.dir, 'cpu.max'), 'utf8').trim().split(/\s+/).map(Number)
  if (
    !Number.isFinite(memory) ||
    memory <= 0 ||
    memory > c.memoryMiB * 1048576 ||
    !Number.isFinite(pids) ||
    pids > 128 ||
    !cpu[0] ||
    !cpu[1] ||
    cpu[0] / cpu[1] > 2 ||
    fs.readFileSync(path.join(c.dir, 'memory.swap.max'), 'utf8').trim() !== '0'
  )
    throw unavailable()
  const parent = path.join(c.dir, 'safe-ops-1a')
  fs.mkdirSync(parent, { recursive: true })
  for (const [f, v] of Object.entries(JOB_LIMITS)) verifiedLimit(parent, f, v)
  fs.writeFileSync(path.join(parent, 'cgroup.subtree_control'), '+memory +pids +cpu')
  const controllers = fs.readFileSync(path.join(parent, 'cgroup.subtree_control'), 'utf8').trim().split(/\s+/)
  if (!['memory', 'pids', 'cpu'].every((c) => controllers.includes(c))) throw unavailable()
  return { dir: parent, helper: c.helper }
}

// Exact dependency files, never /usr, /lib, executable directories, home, fonts or team roots.
const closureCache = new Map<string, string[]>()
function trustedFile(file: string) {
  const real = fs.realpathSync(file)
  const st = fs.statSync(real)
  if (!st.isFile() || st.uid !== 0 || st.mode & 0o022) throw unavailable()
  for (let p = path.dirname(real); ; p = path.dirname(p)) {
    const parent = fs.statSync(p)
    if (parent.uid !== 0 || parent.mode & 0o022) throw unavailable()
    if (p === '/') break
  }
  return real
}
function closure(bin: string): string[] {
  const real = trustedFile(bin)
  if (closureCache.has(real)) {
    const cached = closureCache.get(real)!
    cached.forEach(trustedFile)
    return cached
  }
  let text = ''
  try {
    text = execFileSync('/usr/bin/ldd', [real], {
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 64 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin', LANG: 'C' },
    })
  } catch (e: any) {
    if (
      !String(e.stdout).includes('not a dynamic executable') &&
      !String(e.stderr).includes('not a dynamic executable') &&
      !String(e.stdout).includes('statically linked')
    )
      throw unavailable()
  }
  const libs = [...text.matchAll(/(?:=>\s*)?(\/[^\s()]+)/g)].map((m) => m[1]!)
  if (text.includes('not found')) throw unavailable()
  const paths = [...new Set([real, ...libs])]
  paths.forEach(trustedFile)
  closureCache.set(real, paths)
  return paths
}

let active = false
let unhealthy = false
/** One admitted job, no unbounded queue or retained input buffers. Callers retry busy normally. */
async function run(
  bin: string,
  args: string[],
  input: Uint8Array,
  files: Record<string, Uint8Array>,
  maxOutput: number,
  signal?: AbortSignal,
  codec?: string,
): Promise<Buffer> {
  signal?.throwIfAborted()
  if (unhealthy) throw new ToolError('Safe converter cleanup is incomplete.', 'safe_ops_workflow')
  if (active) throw new ToolError('The safe converter is busy; try again.', 'safe_ops_busy')
  if (
    input.byteLength > 32 * 1024 ** 2 ||
    Object.keys(files).length > 24 ||
    Object.values(files).reduce((n, b) => n + b.byteLength, 0) > 32 * 1024 ** 2
  )
    throw new ToolError('Safe operation input limit exceeded.', 'safe_ops_limit')
  active = true
  let dir = '',
    stage = '',
    proc: ReturnType<typeof Bun.spawn> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let reservation: ReturnType<typeof reserveJob> | undefined
  let reason = ''
  const kill = () => {
    if (dir) {
      try {
        fs.writeFileSync(path.join(dir, 'cgroup.kill'), '1')
      } catch {}
    }
    try {
      proc?.kill('SIGKILL')
    } catch {}
  }
  const abort = () => {
    reason = 'aborted'
    kill()
  }
  try {
    // The parent provides a hard aggregate cap; the new leaf provides independent OOM/cleanup scope.
    const parent = jobCgroup()
    checkWorkflowEnvelope(parent.dir)
    const id=crypto.randomUUID()
    const jobDir=path.join(parent.dir,id)
    reservation=reserveJob(id,jobDir,path.join(os.tmpdir(),'ax-safe-'+id),input.byteLength+Object.values(files).reduce((n,b)=>n+b.byteLength,0)+maxOutput)
    dir=jobDir
    stage=reservation.stage
    fs.mkdirSync(dir)
    for (const [f, v] of Object.entries(JOB_LIMITS)) verifiedLimit(dir, f, v)
    if (!fs.existsSync(path.join(dir, 'cgroup.kill'))) throw unavailable()
    fs.mkdirSync(stage, {recursive:true,mode:0o700})
    fs.chmodSync(stage, 0o700)
    for (const [name, b] of Object.entries(files)) {
      if (!/^[a-zA-Z0-9.-]+$/.test(name)) throw unavailable()
      fs.writeFileSync(path.join(stage, name), b, { mode: 0o400, flag: 'wx' })
    }
    const helper = fs.realpathSync(parent.helper),
      cmd = fs.realpathSync(bin)
    const binaries = [helper, cmd, ...(codec ? [codec] : [])]
    let deps = [...new Set(binaries.flatMap(closure))]
    let heifPlugins: string | undefined
    if (codec) {
      const heif = deps.find((p) => path.basename(p).startsWith('libheif.so'))
      if (heif) {
        const plugin = path.join(path.dirname(fs.realpathSync(heif)), 'libheif/plugins/libheif-libde265.so')
        if (fs.existsSync(plugin)) {
          deps = [...new Set([...deps, ...closure(plugin)])]
          heifPlugins = path.dirname(plugin)
        }
      }
    }
    const bwrap = process.env.MYCEL_SAFE_OPS_BWRAP ?? which('bwrap')
    if (!bwrap) throw unavailable()
    trustedFile(bwrap)
    const mounts = deps.flatMap((p) => ['--ro-bind', fs.realpathSync(p), p])
    if (codec) mounts.push('--ro-bind', fs.realpathSync(codec), '/codec/heif-dec')
    const argv = [
      helper,
      'cgexec',
      '--verify-safe-ops',
      '--cgroup',
      dir,
      '--rlimit-cpu',
      '25',
      '--rlimit-fsize',
      '67108864',
      '--rlimit-nofile',
      '128',
      '--',
      bwrap,
      '--die-with-parent',
      '--unshare-all',
      '--unshare-user',
      '--disable-userns',
      '--new-session',
      '--cap-drop',
      'ALL',
      '--clearenv',
      ...mounts,
      '--ro-bind',
      stage,
      '/inputs',
      '--size',
      '67108864',
      '--tmpfs',
      '/work',
      '--proc',
      '/proc',
      '--dev-bind',
      '/dev/null',
      '/dev/null',
      '--dev-bind',
      '/dev/urandom',
      '/dev/urandom',
      '--chdir',
      '/work',
      '--remount-ro',
      '/',
      ...Object.entries({ ...env, ...(heifPlugins ? { LIBHEIF_PLUGIN_PATH: heifPlugins } : {}) }).flatMap(([k, v]) => [
        '--setenv',
        k,
        v,
      ]),
      helper,
      'exec',
      '--landlock',
      'required',
      ...deps.flatMap((p) => ['--exec-allow', p]),
      ...(codec ? ['--exec-allow', '/codec/heif-dec'] : []),
      '--',
      cmd,
      ...args,
    ]
    proc = Bun.spawn(argv, {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { PATH: '/usr/bin:/bin', LANG: 'C' },
      cwd: stage,
    })
    timer = setTimeout(() => {
      reason = 'timeout'
      kill()
    }, 20_000)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    const collect = async (stream: ReadableStream<Uint8Array>, cap: number) => {
      const chunks: Uint8Array[] = []
      let n = 0
      for await (const ch of stream) {
        n += ch.byteLength
        if (n > cap) {
          reason = 'output'
          kill()
          break
        }
        chunks.push(ch)
      }
      return Buffer.concat(chunks)
    }
    const out = collect(proc.stdout as ReadableStream<Uint8Array>, maxOutput)
    const err = collect(proc.stderr as ReadableStream<Uint8Array>, 16 * 1024)
    const sink = proc.stdin as import('bun').FileSink
    try {
      sink.write(input)
      await sink.end()
    } catch {}
    const [bytes, , code] = await Promise.all([out, err, proc.exited])
    signal?.throwIfAborted()
    if (reason || code !== 0)
      throw new ToolError('The file could not be converted within the safety limits.', 'safe_ops_failed')
    return bytes
  } catch (e) {
    if (e instanceof ToolError || signal?.aborted) throw e
    throw unavailable()
  } finally {
    if (timer) clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
    kill()
    if (proc) await proc.exited
    let clean = true
    try {
      if (dir && fs.existsSync(dir)) {
        for (let i=0;i<50;i++) {
          if (!fs.readFileSync(path.join(dir,'cgroup.events'),'utf8').includes('populated 1')) break
          await Bun.sleep(10)
        }
        if (fs.readFileSync(path.join(dir,'cgroup.events'),'utf8').includes('populated 1')) throw unavailable()
        fs.rmdirSync(dir)
      }
      if(stage) fs.rmSync(stage,{recursive:true,force:true})
    } catch { clean=false; unhealthy=true }
    reservation?.finish(clean)
    active=false
    if (!clean) throw new ToolError('Safe converter cleanup is incomplete.', 'safe_ops_workflow')
  }
}

export async function normalizeImage(format: string, bytes: Uint8Array, signal?: AbortSignal): Promise<Buffer> {
  const f = format === 'jpg' ? 'jpeg' : format === 'heif' ? 'heic' : format
  if (!['png', 'jpeg', 'webp', 'heic'].includes(f) || bytes.byteLength > SAFE_INPUT_MAX)
    throw new ToolError('Unsupported or oversized image.', 'safe_ops_image_limit')
  const codec = f === 'heic' ? (which('heif-dec') ?? which('heif-convert') ?? undefined) : undefined
  if (f === 'heic' && !codec) throw unavailable()
  return run(path.join(nativeBinDir(), 'mycel-safeops'), [f], bytes, {}, SAFE_OUTPUT_MAX, signal, codec)
}

export function validatePptx(bytes: Uint8Array, signal?: AbortSignal): Promise<Buffer> {
  return run(path.join(nativeBinDir(), 'mycel-safeops'), ['pptx'], bytes, {}, 32 * 1024, signal)
}

export function pptxAst(pandoc: string, text: string, signal?: AbortSignal): Promise<Buffer> {
  return run(pandoc, ['--sandbox', '-f', 'markdown', '-t', 'json'], Buffer.from(text), {}, 2 * 1024 ** 2, signal)
}

export function renderPptx(
  pandoc: string,
  ast: string,
  level: number,
  files: Record<string, Uint8Array>,
  signal?: AbortSignal,
): Promise<Buffer> {
  return run(
    pandoc,
    [
      '--fail-if-warnings',
      '--resource-path=/inputs',
      '-f',
      'json',
      '-t',
      'pptx',
      `--slide-level=${level}`,
      '--reference-doc=/inputs/reference.pptx',
    ],
    Buffer.from(ast),
    files,
    32 * 1024 ** 2,
    signal,
  )
}
