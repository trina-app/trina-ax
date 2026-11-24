// The pool of per-visitor instances. Each one is a clone of the WHOLE snapshot base folder (data, secrets and team files
// of the dev layout move together), started on its own two loopback ports with a server.json and an environment the
// gate writes. Warm instances wait for a visitor; a live one belongs to one visitor until it expires.
//
// Snapshots: <snapshotsDir>/<locale>/<name>/manifest.json + base/. manifest.json:
//   { "codeVersion": "0.5.21", "locale": "en", "createdAt": "<ISO time>", "config": "config/server.json", "demoFile": "demo.json" }
// `config` (default config/server.json) and `demoFile` (required, MYCEL_DEMO) are paths inside base/. The newest
// snapshot of a locale whose codeVersion is the configured one is used; another code version is refused. Before an
// instance is warm its GET /api/demo must say a fenced free-roam demo (kind freeRoam, no builder); otherwise the
// snapshot is marked bad and never cloned again by this gate.
//
// Instances run as `pool.runAs`, never as the gate's own user (that user can read the credential file). When the gate is
// not root, every touch of an instance folder (clone, config, start, signals, du, removal) goes through
// `sudo -n -u #<uid> -g #<gid>`; as root the gate starts them with that uid and gid. Each instance's process groups
// are kept in <stateDir>/instances/<id>.json, so they are ended even when the group's leader is gone or the gate
// restarted.
import { spawn, execFile, execFileSync, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import type { GateConfig, Locale } from './config.ts'
import type { GateLog } from './log.ts'

export type InstanceState = 'starting' | 'warm' | 'live' | 'stopping'
export interface Instance {
  id: string
  locale: Locale
  dir: string
  port: number
  proxyPort: number
  /** the model proxy's internal port (engine.proxyInnerPort): fixed, so a host firewall can allow the instance user
   * pool.portRange on loopback and nothing else (demo-gate/linux/trina-demo.nft) */
  innerPort: number
  /** the key that signs a visitor in on this instance (POST /api/demo/persona). Only in the gate's memory: the instance's
   * demo file holds its SHA-256, so no code on any instance can sign in to another one */
  gateKey: string
  /** the path secret in the instance's model upstream address (/i/<id>.<secret>) */
  secret: string
  state: InstanceState
  proc: ChildProcess | null
  /** the process groups of the instance (its own, and any its children made): ended together */
  pgids: number[]
  snapshot: string
  startedAt: number
  assignedAt?: number
  expiresAt?: number
  /** the visitor's address (memory only: the per-address live limit) */
  ip?: string
  /** tokens this instance used as its demo limit counts them (model.ts visitorWeighted: cache writes at 0.1) */
  tokens: number
  /** the gate's own cap for this instance: its demo limit (GET /api/demo cap) × limits.instanceCapMargin */
  cap: number
  /** the visitor used up their demo limit (counted once in the day's stats) */
  hitLimit?: boolean
  /** the visitor's last request or WebSocket close: time active = lastSeenAt - assignedAt */
  lastSeenAt?: number
  /** the visitor's open WebSockets */
  sockets?: number
}

export interface Manifest { codeVersion: string; locale: Locale; createdAt: string; config: string; demoFile: string; git: string | null }
interface Snapshot { name: string; dir: string; base: string; manifest: Manifest; createdMs: number }

export type TakeRefusal = 'paused' | 'full' | 'no_warm' | 'ip_live'

const LOG_SUFFIX = '.log'
const OLD_SNAPSHOT_MIN_AGE_MS = 3600_000
export const newId = () => crypto.randomBytes(4).toString('hex')
export const newSecret = () => crypto.randomBytes(32).toString('base64url')

/** Is something listening on 127.0.0.1:port? (a free port can be bound) */
function portFree(port: number): Promise<boolean> {
  return new Promise((ok) => {
    const s = net.createServer()
    s.once('error', () => ok(false))
    s.listen({ port, host: '127.0.0.1', exclusive: true }, () => s.close(() => ok(true)))
  })
}

const inside = (root: string, rel: string) => {
  const p = path.resolve(root, rel)
  return p === root || p.startsWith(root + path.sep) ? p : null
}

/** How the gate runs something as the instance user: as itself (allowSameUser), as root with uid/gid, or through sudo. */
export interface AsUser { argv: string[]; uid?: number; gid?: number }
export type RunMode = 'same' | 'root' | 'sudo'
export function runMode(cfg: Pick<GateConfig, 'pool'>, gateUid: number): RunMode {
  const r = cfg.pool.runAs
  if (!r || r.uid === gateUid) return 'same'
  return gateUid === 0 ? 'root' : 'sudo'
}
export function asInstanceUser(cfg: Pick<GateConfig, 'pool'>, mode: RunMode, argv: string[]): AsUser {
  const r = cfg.pool.runAs
  if (mode === 'same' || !r) return { argv }
  if (mode === 'root') return { argv, uid: r.uid, gid: r.gid }
  return { argv: [cfg.pool.sudo, '-n', '-u', `#${r.uid}`, '-g', `#${r.gid}`, '--', ...argv] }
}
/** The instance's start argv through sudo: sudo drops the environment and cannot change folder for us, so env -i sets
 * exactly the instance's environment and sh changes into its folder before exec. */
export function sudoStartArgv(cfg: Pick<GateConfig, 'pool'>, dir: string, env: Record<string, string>, argv: string[]): string[] {
  const pairs = Object.entries(env).map(([k, v]) => `${k}=${v}`)
  return asInstanceUser(cfg, 'sudo', ['/usr/bin/env', '-i', ...pairs, '/bin/sh', '-c', 'cd -- "$0" && exec "$@"', dir, ...argv]).argv
}

/** Process groups alive now, with the command lines of their members (`ps`). */
function processTable(): Array<{ pid: number; ppid: number; pgid: number; command: string }> {
  try {
    return execFileSync('ps', ['-A', '-ww', '-o', 'pid=,ppid=,pgid=,command='], { encoding: 'utf8', timeout: 10_000 }).split('\n').flatMap((l) => {
      const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(l)
      return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), command: m[4]! }] : []
    })
  } catch { return [] }
}
/** the groups of `pid` and of everything below it */
export function groupsBelow(pid: number, table = processTable()): number[] {
  const out = new Set<number>()
  const seen = new Set<number>([pid])
  const queue = [pid]
  for (const p of table) if (p.pid === pid) out.add(p.pgid)
  while (queue.length) {
    const cur = queue.shift()!
    for (const p of table) if (p.ppid === cur && !seen.has(p.pid)) { seen.add(p.pid); queue.push(p.pid); out.add(p.pgid) }
  }
  return [...out].filter((g) => g > 1)
}
/** Is the group still ours? Some member's command line holds the instance folder (pool.command names {dir} or
 * {config}; the instance's helpers name paths inside it). A group whose number was reused is not. */
export function ownsGroup(pgid: number, dir: string, table = processTable()): boolean {
  return table.some((p) => p.pgid === pgid && p.command.includes(dir))
}

interface Record_ { dir: string; pgids: number[] }

export class Pool {
  readonly instances = new Map<string, Instance>()
  private usedPorts = new Set<number>()
  private refusedSnapshots = new Set<string>()
  /** snapshots whose instance was not a fenced free-roam demo: never cloned again */
  private badSnapshots = new Set<string>()
  private backoff = new Map<Locale, { until: number; ms: number }>()
  private timer: ReturnType<typeof setInterval> | null = null
  private stopped = false
  private diskBusy = false
  private cfg: GateConfig
  private log: GateLog
  private upstreamUrl: () => string
  private paused: () => boolean
  private mode: RunMode
  private recordsDir: string
  private logsDir: string
  /** called once when a live instance ends (the gate's daily stats; the pool does not know them) */
  onEnded: ((inst: Instance, why: string) => void) | null = null
  constructor(cfg: GateConfig, log: GateLog, upstreamUrl: () => string, paused: () => boolean) {
    this.cfg = cfg; this.log = log; this.upstreamUrl = upstreamUrl; this.paused = paused
    this.mode = runMode(cfg, process.getuid?.() ?? -1)
    this.recordsDir = path.join(cfg.stateDir, 'instances')
    this.logsDir = path.join(cfg.stateDir, 'logs')
  }

  start(): void {
    if (this.mode === 'same') fs.mkdirSync(this.cfg.pool.instancesDir, { recursive: true, mode: 0o700 })
    fs.mkdirSync(this.recordsDir, { recursive: true, mode: 0o700 })
    fs.mkdirSync(this.logsDir, { recursive: true, mode: 0o700 })
    this.sweep()
    this.fill()
    this.timer = setInterval(() => { this.sweep(); this.fill() }, this.cfg.pool.sweepMs)
    this.timer.unref?.()
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    await Promise.all([...this.instances.values()].map((i) => this.end(i, 'shutdown')))
  }

  counts() {
    const c = { starting: 0, warm: 0, live: 0, stopping: 0, warmByLocale: {} as Record<string, number> }
    for (const i of this.instances.values()) {
      c[i.state]++
      if (i.state === 'warm') c.warmByLocale[i.locale] = (c.warmByLocale[i.locale] ?? 0) + 1
    }
    return c
  }
  liveCount(): number { return this.counts().live }
  /** may a visitor start now (status page, the scripted demo's button)? */
  available(locale?: Locale): boolean {
    if (this.paused()) return false
    const c = this.counts()
    if (c.live >= this.cfg.pool.maxLive) return false
    return locale ? (c.warmByLocale[locale] ?? 0) > 0 : Object.values(c.warmByLocale).some((x) => x > 0)
  }

  /** A warm instance for this visitor, now live; or why not. `livePerIp`: this address's live copies at once (the
   * caller passes limits.exemptLivePerIp for a listed address) */
  take(locale: Locale, ip: string, livePerIp = this.cfg.limits.livePerIp): Instance | TakeRefusal {
    if (this.paused()) return 'paused'
    const all = [...this.instances.values()]
    if (all.filter((i) => i.state === 'live').length >= this.cfg.pool.maxLive) return 'full'
    if (all.filter((i) => i.state === 'live' && i.ip === ip).length >= livePerIp) return 'ip_live'
    const inst = all.find((i) => i.state === 'warm' && i.locale === locale)
    if (!inst) return 'no_warm'
    const now = Date.now()
    inst.state = 'live'
    inst.assignedAt = now
    inst.lastSeenAt = now
    inst.expiresAt = now + this.cfg.pool.ttlHours * 3600_000
    inst.ip = ip
    this.log.info('instance live', { instance: inst.id, locale })
    setImmediate(() => this.fill())
    return inst
  }

  /** the instance a model request names, only when its path secret is right (constant-time) */
  bySecret(id: string, secret: string): Instance | null {
    const i = this.instances.get(id)
    if (!i || (i.state !== 'warm' && i.state !== 'live')) return null
    const a = Buffer.from(i.secret), b = Buffer.from(secret)
    return a.length === b.length && crypto.timingSafeEqual(a, b) ? i : null
  }

  // ---------------- snapshots ----------------
  snapshots(locale: Locale): Snapshot[] {
    const root = path.join(this.cfg.pool.snapshotsDir, locale)
    let names: string[] = []
    try { names = fs.readdirSync(root) } catch { return [] }
    const out: Snapshot[] = []
    for (const name of names) {
      const dir = path.join(root, name)
      try {
        const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as Partial<Manifest>
        const createdMs = Date.parse(String(m.createdAt))
        // the demo file is required: without it the instance would be a plain development server
        if (typeof m.codeVersion !== 'string' || m.locale !== locale || Number.isNaN(createdMs) || typeof m.demoFile !== 'string' || !m.demoFile) continue
        const base = path.join(dir, 'base')
        if (!fs.statSync(base).isDirectory()) continue
        out.push({ name, dir, base, createdMs, manifest: { codeVersion: m.codeVersion, locale, createdAt: String(m.createdAt), config: typeof m.config === 'string' ? m.config : 'config/server.json', demoFile: m.demoFile, git: typeof m.git === 'string' ? m.git : null } })
      } catch {}
    }
    return out.sort((a, b) => b.createdMs - a.createdMs)
  }
  /** the newest good snapshot of the configured code version; others are refused (logged once each). One version can be
   * built from many commits: when the newest is bad, only an older one of the same commit may stand in for it */
  currentSnapshot(locale: Locale): Snapshot | null {
    let newest: Snapshot | null = null
    for (const s of this.snapshots(locale)) {
      if (s.manifest.codeVersion !== this.cfg.pool.codeVersion) {
        if (!this.badSnapshots.has(s.dir) && !this.refusedSnapshots.has(s.dir)) {
          this.refusedSnapshots.add(s.dir)
          this.log.warn('snapshot refused: other code version', { snapshot: s.name, locale, snapshotVersion: s.manifest.codeVersion, codeVersion: this.cfg.pool.codeVersion })
        }
        continue
      }
      newest ??= s
      if (s.manifest.git !== newest.manifest.git) {
        if (!this.refusedSnapshots.has(s.dir)) {
          this.refusedSnapshots.add(s.dir)
          this.log.error('snapshot refused: the newest is bad and this one is from another commit', { snapshot: s.name, locale })
        }
        return null
      }
      if (!this.badSnapshots.has(s.dir)) return s
    }
    return null
  }
  /** age of the snapshot in use, ms (health) */
  snapshotAgeMs(locale: Locale): number | null {
    const s = this.currentSnapshot(locale)
    return s ? Date.now() - s.createdMs : null
  }

  // ---------------- warm pool ----------------
  fill(): void {
    if (this.stopped || this.paused()) return
    const now = Date.now()
    for (const locale of this.cfg.pool.locales) {
      const b = this.backoff.get(locale)
      if (b && b.until > now) continue
      const all = [...this.instances.values()]
      const total = all.filter((i) => i.state !== 'stopping').length
      const cap = this.cfg.pool.maxLive + this.cfg.pool.warmPerLocale * this.cfg.pool.locales.length
      let have = all.filter((i) => i.locale === locale && (i.state === 'warm' || i.state === 'starting')).length
      for (let room = cap - total; have < this.cfg.pool.warmPerLocale && room > 0; have++, room--) {
        const snap = this.currentSnapshot(locale)
        if (!snap) break
        void this.create(locale, snap)
      }
    }
  }

  /** three free ports of pool.portRange: the instance's listener, its model proxy and the proxy's internal server */
  private async allocPorts(): Promise<[number, number, number]> {
    const [from, to] = this.cfg.pool.portRange
    const got: number[] = []
    for (let p = from; p <= to && got.length < 3; p++) {
      if (this.usedPorts.has(p) || p === this.cfg.listen.port || p === this.cfg.upstreamListen.port) continue
      this.usedPorts.add(p)
      if (await portFree(p)) got.push(p)
      else this.usedPorts.delete(p)
    }
    if (got.length < 3) { for (const p of got) this.usedPorts.delete(p); throw new Error('no free ports in pool.portRange') }
    return [got[0]!, got[1]!, got[2]!]
  }

  /** the instance's server.json: the snapshot's file with the gate's settings on top */
  instanceConfig(snapshotFile: string, inst: Pick<Instance, 'id' | 'port' | 'proxyPort' | 'innerPort' | 'secret'>): string {
    const c = JSON.parse(fs.readFileSync(snapshotFile, 'utf8')) as Record<string, any>
    c.listen = { host: '127.0.0.1', port: inst.port }
    c.publicOrigins = [this.cfg.publicOrigin]
    const engine = (c.engine && typeof c.engine === 'object' ? c.engine : {}) as Record<string, unknown>
    delete engine.modelUpstream
    delete engine.anthropicGateway
    engine.proxyPort = inst.proxyPort
    engine.proxyInnerPort = inst.innerPort
    engine.modelUpstreams = { anthropic: `${this.upstreamUrl()}/i/${inst.id}.${inst.secret}` }
    c.engine = engine
    c.relay = { url: null, teamName: null, officialAvailable: false }
    c.update = { channel: 'stable', feedUrl: null, auto: false }
    c.push = { gatewayUrl: null }
    c.tunnel = null
    c.tls = null
    c.tailnet = null
    c.appConnectors = false
    return JSON.stringify(c, null, 2)
  }

  /** the folders the instance's converter sandbox must never read (server/src/tools/isolate.ts, free-roam only): the
   * gate's state and the folders of its two secret files */
  gateDirs(): string[] {
    return [...new Set([this.cfg.stateDir, path.dirname(this.cfg.ai.credentialFile), path.dirname(this.cfg.turnstile.secretFile)])]
  }

  /** the instance's whole environment (nothing of the gate's own: no credential path, no HOME of the gate user) */
  instanceEnv(dir: string, configFile: string, demoFile: string): Record<string, string> {
    return {
      ...this.cfg.pool.env,
      PATH: this.cfg.pool.path,
      HOME: dir,
      TMPDIR: path.join(dir, 'tmp'),
      LANG: 'en_US.UTF-8',
      MYCEL_CONFIG: configFile,
      MYCEL_PUBLIC_ORIGINS: this.cfg.publicOrigin,
      MYCEL_SPEECH_PREFETCH: '0',
      MYCEL_RELAY_URL: '',
      MYCEL_PUSH_GATEWAY: 'off',
      MYCEL_DEMO: demoFile,
      MYCEL_DEMO_GATE_DIRS: this.gateDirs().join(':'),
    }
  }

  /** run a short command as the instance user (clone, config, removal); throws on failure */
  private runAs(argv: string[], o: { input?: string; timeout?: number } = {}): void {
    const a = asInstanceUser(this.cfg, this.mode, argv)
    execFileSync(a.argv[0]!, a.argv.slice(1), { stdio: [o.input === undefined ? 'ignore' : 'pipe', 'ignore', 'pipe'], input: o.input, timeout: o.timeout ?? 120_000, ...(a.uid !== undefined ? { uid: a.uid, gid: a.gid } : {}) })
  }
  private removeDir(dir: string): void {
    if (path.dirname(dir) !== this.cfg.pool.instancesDir || !/^[0-9a-f]{8}$/.test(path.basename(dir))) return
    try { this.runAs(['/bin/rm', '-rf', '--', dir]) } catch {}
    if (this.mode === 'same') fs.rmSync(dir, { recursive: true, force: true })
  }
  /** an instance folder's size in KB (du as the instance user, with a time limit); null when it could not tell */
  diskKB(dir: string): Promise<number | null> {
    const a = asInstanceUser(this.cfg, this.mode, ['/usr/bin/du', '-sk', '--', dir])
    return new Promise((ok) => {
      execFile(a.argv[0]!, a.argv.slice(1), { timeout: 20_000, encoding: 'utf8', ...(a.uid !== undefined ? { uid: a.uid, gid: a.gid } : {}) }, (e, out) => {
        const kb = Number(/^(\d+)/.exec(String(out ?? ''))?.[1])
        ok(Number.isFinite(kb) && kb >= 0 && (!e || kb > 0) ? kb : null)
      })
    })
  }

  /** signal every process group of an instance that is still ours */
  private signal(pgids: number[], dir: string, sig: NodeJS.Signals, leaderAlive: number | null): void {
    const table = processTable()
    let realDir = dir
    try { realDir = fs.realpathSync(dir) } catch {}
    for (const g of pgids) {
      if (g !== leaderAlive && !ownsGroup(g, dir, table) && !ownsGroup(g, realDir, table)) continue
      try { process.kill(-g, sig) } catch {}
      if (this.mode === 'sudo') {
        try { this.runAs(['/bin/kill', '-s', sig.replace(/^SIG/, ''), '--', `-${g}`], { timeout: 10_000 }) } catch {}
      }
    }
  }

  private recordFile(id: string) { return path.join(this.recordsDir, `${id}.json`) }
  private writeRecord(inst: Instance) {
    try { fs.writeFileSync(this.recordFile(inst.id), JSON.stringify({ dir: inst.dir, pgids: inst.pgids } satisfies Record_), { mode: 0o600 }) } catch {}
  }

  private async create(locale: Locale, snap: Snapshot): Promise<void> {
    const id = newId()
    const dir = path.join(this.cfg.pool.instancesDir, id)
    const inst: Instance = { id, locale, dir, port: 0, proxyPort: 0, innerPort: 0, gateKey: newSecret(), secret: newSecret(), state: 'starting', proc: null, pgids: [], snapshot: snap.name, startedAt: Date.now(), tokens: 0, cap: 0 }
    this.instances.set(id, inst)
    try {
      ;[inst.port, inst.proxyPort, inst.innerPort] = await this.allocPorts()
      // read from the snapshot (the gate may not read the clone), written into the clone as the instance user
      const snapConfig = inside(snap.base, snap.manifest.config)
      const configFile = inside(dir, snap.manifest.config)
      if (!snapConfig || !configFile || !fs.existsSync(snapConfig)) throw new Error('snapshot has no server config at manifest.config')
      const snapDemo = inside(snap.base, snap.manifest.demoFile)
      const demoFile = inside(dir, snap.manifest.demoFile)
      if (!snapDemo || !demoFile || !fs.existsSync(snapDemo)) throw new Error('manifest.demoFile is not in the snapshot')
      const config = this.instanceConfig(snapConfig, inst)
      // clone, private folder, its config: all as the instance user
      this.runAs([...this.cfg.pool.cloneCommand, snap.base, dir])
      // private to the instance user, every file: a snapshot is group-readable for the instance user to clone it, and
      // the server refuses a group-readable key file (credentials/vault.ts key_unsafe; Gmail then reads "sign in again")
      this.runAs(['/bin/sh', '-c', 'chmod -R go-rwx "$0" && mkdir -p "$0/tmp"', dir])
      this.runAs(['/bin/sh', '-c', 'umask 077 && cat > "$0" && chmod 600 "$0"', configFile], { input: config })
      const demoJson = { ...JSON.parse(fs.readFileSync(snapDemo, 'utf8')) as Record<string, unknown>, gateKeySha256: crypto.createHash('sha256').update(inst.gateKey).digest('hex') }
      this.runAs(['/bin/sh', '-c', 'umask 077 && cat > "$0" && chmod 600 "$0"', demoFile], { input: JSON.stringify(demoJson, null, 2) + '\n' })
      const sub = (s: string) => s.replaceAll('{dir}', dir).replaceAll('{config}', configFile).replaceAll('{port}', String(inst.port)).replaceAll('{proxyPort}', String(inst.proxyPort))
      const argv = this.cfg.pool.command.map(sub)
      const env = this.instanceEnv(dir, configFile, demoFile)
      const out = fs.openSync(path.join(this.logsDir, id + LOG_SUFFIX), 'a', 0o600)
      // its own process group, so ending it ends what it started (the launcher, engines)
      let proc: ChildProcess
      if (this.mode === 'sudo') {
        const a = sudoStartArgv(this.cfg, dir, env, argv)
        proc = spawn(a[0]!, a.slice(1), { cwd: '/', env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }, stdio: ['ignore', out, out], detached: true })
      } else {
        const r = this.cfg.pool.runAs
        proc = spawn(argv[0]!, argv.slice(1), { cwd: dir, env, stdio: ['ignore', out, out], detached: true, ...(this.mode === 'root' && r ? { uid: r.uid, gid: r.gid } : {}) })
      }
      fs.closeSync(out)
      inst.proc = proc
      if (proc.pid) { inst.pgids = [proc.pid]; this.writeRecord(inst) }
      proc.on('exit', (code, signal) => {
        inst.proc = null
        if (inst.state !== 'stopping') {
          this.log.warn('instance exited', { instance: id, state: inst.state, code: code ?? null, signal: signal ?? null })
          void this.end(inst, 'exited')
        }
      })
      proc.on('error', () => {})
      await this.waitHealthy(inst)
      if (inst.state !== 'starting') return
      // the groups its children made (sudo's command, a launcher that set up its own group)
      if (proc.pid) { inst.pgids = [...new Set([...inst.pgids, ...groupsBelow(proc.pid)])]; this.writeRecord(inst) }
      inst.cap = await this.checkFenced(inst, snap)
      if (inst.state !== 'starting') return
      inst.state = 'warm'
      this.backoff.delete(locale)
      this.log.info('instance warm', { instance: id, locale, ms: Date.now() - inst.startedAt })
    } catch (e) {
      const prev = this.backoff.get(locale)?.ms ?? 15_000
      const ms = Math.min(prev * 2, 300_000)
      this.backoff.set(locale, { until: Date.now() + ms, ms })
      this.log.error('instance start failed', { instance: id, locale, error: String((e as Error)?.message ?? e).slice(0, 200), retryInMs: ms })
      await this.end(inst, 'start_failed')
    }
  }

  /** The instance must say a fenced free-roam demo (GET /api/demo: kind freeRoam, no builder, a demo limit); else its
   * snapshot is bad. Returns the gate's cap for it. */
  private async checkFenced(inst: Instance, snap: Snapshot): Promise<number> {
    const r = await fetch(`http://127.0.0.1:${inst.port}/api/demo`, { signal: AbortSignal.timeout(10_000) })
    if (!r.ok) { await r.body?.cancel().catch(() => {}); throw new Error(`GET /api/demo answered ${r.status}`) }
    const info = await r.json().catch(() => null) as { kind?: unknown; builder?: unknown; cap?: unknown } | null
    const cap = typeof info?.cap === 'number' && Number.isFinite(info.cap) && info.cap > 0 ? info.cap : 0
    if (info?.kind !== 'freeRoam' || info.builder !== undefined && info.builder !== false || !cap) {
      this.badSnapshots.add(snap.dir)
      this.log.error('snapshot refused: not a fenced free-roam demo', { snapshot: snap.name, locale: inst.locale, kind: typeof info?.kind === 'string' ? info.kind.slice(0, 20) : null, builder: info?.builder === true, cap: !!cap })
      throw new Error('the instance is not a fenced free-roam demo')
    }
    // and it must refuse a sign-in without this instance's key (an older server would let any local process in)
    const open = await fetch(`http://127.0.0.1:${inst.port}/api/demo/persona`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: this.cfg.publicOrigin, 'x-mycel-csrf': '1', 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify({ key: this.cfg.pool.personaKey }), redirect: 'manual', signal: AbortSignal.timeout(10_000),
    })
    await open.body?.cancel().catch(() => {})
    if (open.ok) {
      this.badSnapshots.add(snap.dir)
      this.log.error('snapshot refused: the instance does not check the gate key', { snapshot: snap.name, locale: inst.locale, status: open.status })
      throw new Error('the instance does not check the gate key')
    }
    // any other answer says nothing about the snapshot: this start failed, and the pool tries again
    if (open.status !== 401) throw new Error(`the sign-in check answered ${open.status}`)
    return Math.round(cap * this.cfg.limits.instanceCapMargin)
  }

  private async waitHealthy(inst: Instance): Promise<void> {
    const until = Date.now() + this.cfg.pool.startTimeoutMs
    while (Date.now() < until) {
      if (!inst.proc || inst.state !== 'starting') throw new Error('the instance ended before it was healthy')
      try {
        const r = await fetch(`http://127.0.0.1:${inst.port}${this.cfg.pool.healthPath}`, { signal: AbortSignal.timeout(2000) })
        await r.body?.cancel().catch(() => {})
        if (r.ok) return
      } catch {}
      await new Promise((r) => setTimeout(r, 250))
    }
    throw new Error('health check timed out')
  }

  /** stop an instance (every process group of it, also when its leader is gone) and remove its folder */
  async end(inst: Instance, why: string): Promise<void> {
    if (inst.state === 'stopping' && !inst.proc) { this.forget(inst); return }
    const was = inst.state
    inst.state = 'stopping'
    if (was === 'live') try { this.onEnded?.(inst, why) } catch {}
    const proc = inst.proc
    const leader = proc && proc.pid && proc.exitCode === null && proc.signalCode === null ? proc.pid : null
    this.signal(inst.pgids, inst.dir, 'SIGTERM', leader)
    if (proc && leader) {
      const exited = new Promise<void>((ok) => proc.once('exit', () => ok()))
      await Promise.race([exited, new Promise((ok) => setTimeout(ok, 5000))])
    }
    // what is left of any group (children of a leader that exited) goes now
    this.signal(inst.pgids, inst.dir, 'SIGKILL', proc && proc.exitCode === null && proc.signalCode === null ? leader : null)
    this.forget(inst)
    if (was !== 'starting' || why !== 'start_failed') this.log.info('instance ended', { instance: inst.id, why, was, tokens: inst.tokens })
    if (!this.stopped) setImmediate(() => this.fill())
  }
  private forget(inst: Instance) {
    this.removeDir(inst.dir)
    try { fs.rmSync(this.recordFile(inst.id), { force: true }) } catch {}
    try { fs.rmSync(path.join(this.logsDir, inst.id + LOG_SUFFIX), { force: true }) } catch {}
    this.usedPorts.delete(inst.port)
    this.usedPorts.delete(inst.proxyPort)
    this.usedPorts.delete(inst.innerPort)
    this.instances.delete(inst.id)
  }

  // ---------------- sweeper ----------------
  sweep(now = Date.now()): void {
    for (const i of this.instances.values()) if (i.state === 'live' && i.expiresAt! <= now) void this.end(i, 'expired')
    void this.checkDisk()
    // orphans: instances no instance of this process owns (a gate that crashed or restarted): their groups, then folders
    let records: string[] = []
    try { records = fs.readdirSync(this.recordsDir) } catch {}
    for (const f of records) {
      const id = f.replace(/\.json$/, '')
      if (!/^[0-9a-f]{8}\.json$/.test(f) || this.instances.has(id)) continue
      try {
        const r = JSON.parse(fs.readFileSync(path.join(this.recordsDir, f), 'utf8')) as Partial<Record_>
        const dir = path.join(this.cfg.pool.instancesDir, id)
        const pgids = Array.isArray(r.pgids) ? r.pgids.filter((g): g is number => Number.isInteger(g) && g > 1) : []
        // the record says the folder; only that one (an id names exactly one folder) is believed
        if (r.dir === dir) this.signal(pgids, dir, 'SIGKILL', null)
        this.removeDir(dir)
      } catch {}
      try { fs.rmSync(path.join(this.recordsDir, f), { force: true }) } catch {}
      try { fs.rmSync(path.join(this.logsDir, id + LOG_SUFFIX), { force: true }) } catch {}
      this.log.info('orphan removed', { instance: id })
    }
    let names: string[] = []
    try { names = fs.readdirSync(this.cfg.pool.instancesDir) } catch {}
    for (const name of names) {
      if (this.instances.has(name) || !/^[0-9a-f]{8}$/.test(name)) continue
      this.removeDir(path.join(this.cfg.pool.instancesDir, name))
      this.log.info('orphan removed', { instance: name })
    }
    // snapshots older than the one in use (and at least an hour old: never one a builder is still writing)
    for (const locale of this.cfg.pool.locales) {
      const cur = this.currentSnapshot(locale)
      if (!cur) continue
      for (const s of this.snapshots(locale)) {
        if (s.createdMs >= cur.createdMs) continue
        // another version's snapshots are a rollback's (tddeploy prunes them at the next proved deploy)
        if (s.manifest.codeVersion !== cur.manifest.codeVersion) continue
        let mtime = 0
        try { mtime = fs.statSync(s.dir).mtimeMs } catch {}
        if (now - mtime < OLD_SNAPSHOT_MIN_AGE_MS) continue
        fs.rmSync(s.dir, { recursive: true, force: true })
        this.refusedSnapshots.delete(s.dir)
        this.log.info('old snapshot removed', { snapshot: s.name, locale })
      }
    }
  }

  /** an instance folder over pool.diskCapMB ends that instance (its visitor then sees "session ended") */
  async checkDisk(): Promise<void> {
    if (this.diskBusy || this.stopped) return
    this.diskBusy = true
    try {
      const capKB = this.cfg.pool.diskCapMB * 1024
      for (const inst of [...this.instances.values()]) {
        if (inst.state !== 'warm' && inst.state !== 'live') continue
        const kb = await this.diskKB(inst.dir)
        if (kb === null || kb <= capKB || (inst.state as InstanceState) === 'stopping') continue
        this.log.warn('instance over its disk cap', { instance: inst.id, kb, capKB: Math.round(capKB) })
        await this.end(inst, 'disk')
      }
    } finally { this.diskBusy = false }
  }
}
