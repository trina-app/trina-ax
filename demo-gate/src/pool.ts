// The pool of per-visitor instances. Each one is a clone of the WHOLE snapshot base folder (data, secrets and team files
// of the dev layout move together), started on its own two loopback ports with a server.json and an environment the
// gate writes. Warm instances wait for a visitor; a live one belongs to one visitor until it expires.
//
// Snapshots: <snapshotsDir>/<locale>/<name>/manifest.json + base/. manifest.json:
//   { "codeVersion": "0.5.21", "locale": "en", "createdAt": "<ISO time>", "config": "config/server.json", "demoFile": "demo.json" }
// `config` (default config/server.json) and `demoFile` (optional, MYCEL_DEMO) are paths inside base/. The newest
// snapshot of a locale whose codeVersion is the configured one is used; another code version is refused.
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
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
  /** the path secret in the instance's model upstream address (/i/<id>.<secret>) */
  secret: string
  state: InstanceState
  proc: ChildProcess | null
  snapshot: string
  startedAt: number
  assignedAt?: number
  expiresAt?: number
  /** the visitor's address (memory only: the per-address live limit) */
  ip?: string
  /** weighted tokens this instance used */
  tokens: number
}

export interface Manifest { codeVersion: string; locale: Locale; createdAt: string; config: string; demoFile?: string }
interface Snapshot { name: string; dir: string; base: string; manifest: Manifest; createdMs: number }

export type TakeRefusal = 'paused' | 'full' | 'no_warm' | 'ip_live'

const PID_FILE = '.gate-pid'
const LOG_FILE = '.gate-instance.log'
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

export class Pool {
  readonly instances = new Map<string, Instance>()
  private usedPorts = new Set<number>()
  private refusedSnapshots = new Set<string>()
  private backoff = new Map<Locale, { until: number; ms: number }>()
  private timer: ReturnType<typeof setInterval> | null = null
  private stopped = false
  private cfg: GateConfig
  private log: GateLog
  private upstreamUrl: () => string
  private paused: () => boolean
  constructor(cfg: GateConfig, log: GateLog, upstreamUrl: () => string, paused: () => boolean) {
    this.cfg = cfg; this.log = log; this.upstreamUrl = upstreamUrl; this.paused = paused
  }

  start(): void {
    fs.mkdirSync(this.cfg.pool.instancesDir, { recursive: true, mode: 0o700 })
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

  /** A warm instance for this visitor, now live; or why not. */
  take(locale: Locale, ip: string): Instance | TakeRefusal {
    if (this.paused()) return 'paused'
    const all = [...this.instances.values()]
    if (all.filter((i) => i.state === 'live').length >= this.cfg.pool.maxLive) return 'full'
    if (all.filter((i) => i.state === 'live' && i.ip === ip).length >= this.cfg.limits.livePerIp) return 'ip_live'
    const inst = all.find((i) => i.state === 'warm' && i.locale === locale)
    if (!inst) return 'no_warm'
    const now = Date.now()
    inst.state = 'live'
    inst.assignedAt = now
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
        if (typeof m.codeVersion !== 'string' || m.locale !== locale || Number.isNaN(createdMs)) continue
        const base = path.join(dir, 'base')
        if (!fs.statSync(base).isDirectory()) continue
        out.push({ name, dir, base, createdMs, manifest: { codeVersion: m.codeVersion, locale, createdAt: String(m.createdAt), config: typeof m.config === 'string' ? m.config : 'config/server.json', ...(typeof m.demoFile === 'string' ? { demoFile: m.demoFile } : {}) } })
      } catch {}
    }
    return out.sort((a, b) => b.createdMs - a.createdMs)
  }
  /** the newest snapshot of the configured code version; others are refused (logged once each) */
  currentSnapshot(locale: Locale): Snapshot | null {
    for (const s of this.snapshots(locale)) {
      if (s.manifest.codeVersion === this.cfg.pool.codeVersion) return s
      if (!this.refusedSnapshots.has(s.dir)) {
        this.refusedSnapshots.add(s.dir)
        this.log.warn('snapshot refused: other code version', { snapshot: s.name, locale, snapshotVersion: s.manifest.codeVersion, codeVersion: this.cfg.pool.codeVersion })
      }
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

  private async allocPorts(): Promise<[number, number]> {
    const [from, to] = this.cfg.pool.portRange
    const got: number[] = []
    for (let p = from; p <= to && got.length < 2; p++) {
      if (this.usedPorts.has(p) || p === this.cfg.listen.port || p === this.cfg.upstreamListen.port) continue
      this.usedPorts.add(p)
      if (await portFree(p)) got.push(p)
      else this.usedPorts.delete(p)
    }
    if (got.length < 2) { for (const p of got) this.usedPorts.delete(p); throw new Error('no free ports in pool.portRange') }
    return [got[0]!, got[1]!]
  }

  /** the instance's server.json: the snapshot's file with the gate's settings on top */
  writeInstanceConfig(file: string, inst: Pick<Instance, 'id' | 'port' | 'proxyPort' | 'secret'>): void {
    const c = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, any>
    c.listen = { host: '127.0.0.1', port: inst.port }
    c.publicOrigins = [this.cfg.publicOrigin]
    const engine = (c.engine && typeof c.engine === 'object' ? c.engine : {}) as Record<string, unknown>
    delete engine.modelUpstream
    delete engine.anthropicGateway
    engine.proxyPort = inst.proxyPort
    engine.modelUpstreams = { anthropic: `${this.upstreamUrl()}/i/${inst.id}.${inst.secret}` }
    c.engine = engine
    c.relay = { url: null, teamName: null, officialAvailable: false }
    c.update = { channel: 'stable', feedUrl: null, auto: false }
    c.push = { gatewayUrl: null }
    c.tunnel = null
    c.tls = null
    c.tailnet = null
    c.appConnectors = false
    fs.writeFileSync(file, JSON.stringify(c, null, 2), { mode: 0o600 })
    fs.chmodSync(file, 0o600)
  }

  /** the instance's whole environment (nothing of the gate's own: no credential path, no HOME of the gate user) */
  instanceEnv(dir: string, configFile: string, demoFile: string | null): Record<string, string> {
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
      ...(demoFile ? { MYCEL_DEMO: demoFile } : {}),
    }
  }

  private async create(locale: Locale, snap: Snapshot): Promise<void> {
    const id = newId()
    const dir = path.join(this.cfg.pool.instancesDir, id)
    const inst: Instance = { id, locale, dir, port: 0, proxyPort: 0, secret: newSecret(), state: 'starting', proc: null, snapshot: snap.name, startedAt: Date.now(), tokens: 0 }
    this.instances.set(id, inst)
    try {
      ;[inst.port, inst.proxyPort] = await this.allocPorts()
      const [cmd, ...args] = this.cfg.pool.cloneCommand
      execFileSync(cmd!, [...args, snap.base, dir], { stdio: 'ignore', timeout: 120_000 })
      fs.chmodSync(dir, 0o700)
      fs.mkdirSync(path.join(dir, 'tmp'), { recursive: true })
      const configFile = inside(dir, snap.manifest.config)
      if (!configFile || !fs.existsSync(configFile)) throw new Error('snapshot has no server config at manifest.config')
      const demoFile = snap.manifest.demoFile ? inside(dir, snap.manifest.demoFile) : null
      if (snap.manifest.demoFile && !demoFile) throw new Error('manifest.demoFile is outside the snapshot')
      this.writeInstanceConfig(configFile, inst)
      const sub = (s: string) => s.replaceAll('{dir}', dir).replaceAll('{config}', configFile).replaceAll('{port}', String(inst.port)).replaceAll('{proxyPort}', String(inst.proxyPort))
      const [bin, ...argv] = this.cfg.pool.command.map(sub)
      const out = fs.openSync(path.join(dir, LOG_FILE), 'a', 0o600)
      // its own process group, so ending it ends what it started (the launcher, engines)
      const proc = spawn(bin!, argv, { cwd: dir, env: this.instanceEnv(dir, configFile, demoFile), stdio: ['ignore', out, out], detached: true })
      fs.closeSync(out)
      inst.proc = proc
      if (proc.pid) fs.writeFileSync(path.join(dir, PID_FILE), String(proc.pid), { mode: 0o600 })
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

  /** stop an instance and remove its folder */
  async end(inst: Instance, why: string): Promise<void> {
    if (inst.state === 'stopping' && !inst.proc) { this.forget(inst); return }
    const was = inst.state
    inst.state = 'stopping'
    const proc = inst.proc
    if (proc && proc.pid && proc.exitCode === null) {
      const exited = new Promise<void>((ok) => proc.once('exit', () => ok()))
      killGroup(proc.pid, 'SIGTERM')
      const t = setTimeout(() => killGroup(proc.pid!, 'SIGKILL'), 5000)
      await Promise.race([exited, new Promise((ok) => setTimeout(ok, 6000))])
      clearTimeout(t)
    }
    this.forget(inst)
    if (was !== 'starting' || why !== 'start_failed') this.log.info('instance ended', { instance: inst.id, why, was, tokens: inst.tokens })
    if (!this.stopped) setImmediate(() => this.fill())
  }
  private forget(inst: Instance) {
    fs.rmSync(inst.dir, { recursive: true, force: true })
    this.usedPorts.delete(inst.port)
    this.usedPorts.delete(inst.proxyPort)
    this.instances.delete(inst.id)
  }

  // ---------------- sweeper ----------------
  sweep(now = Date.now()): void {
    for (const i of this.instances.values()) if (i.state === 'live' && i.expiresAt! <= now) void this.end(i, 'expired')
    // orphans: folders no instance of this process owns (a gate that crashed or restarted)
    let names: string[] = []
    try { names = fs.readdirSync(this.cfg.pool.instancesDir) } catch {}
    for (const name of names) {
      if (this.instances.has(name) || !/^[0-9a-f]{8}$/.test(name)) continue
      const dir = path.join(this.cfg.pool.instancesDir, name)
      try {
        const pid = Number(fs.readFileSync(path.join(dir, PID_FILE), 'utf8'))
        if (Number.isInteger(pid) && pid > 1 && ownsDir(pid, dir)) killGroup(pid, 'SIGKILL')
      } catch {}
      fs.rmSync(dir, { recursive: true, force: true })
      this.log.info('orphan removed', { instance: name })
    }
    // snapshots older than the one in use (and at least an hour old: never one a builder is still writing)
    for (const locale of this.cfg.pool.locales) {
      const cur = this.currentSnapshot(locale)
      if (!cur) continue
      for (const s of this.snapshots(locale)) {
        if (s.createdMs >= cur.createdMs) continue
        let mtime = 0
        try { mtime = fs.statSync(s.dir).mtimeMs } catch {}
        if (now - mtime < OLD_SNAPSHOT_MIN_AGE_MS) continue
        fs.rmSync(s.dir, { recursive: true, force: true })
        this.refusedSnapshots.delete(s.dir)
        this.log.info('old snapshot removed', { snapshot: s.name, locale })
      }
    }
  }
}

function killGroup(pid: number, sig: NodeJS.Signals) {
  try { process.kill(-pid, sig) } catch { try { process.kill(pid, sig) } catch {} }
}
/** a pid from an orphan's pid file still names that instance (its command line holds the folder), not a reused pid */
function ownsDir(pid: number, dir: string): boolean {
  try { return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).includes(dir) } catch { return false }
}
