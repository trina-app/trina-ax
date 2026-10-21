// Operations service of component G: diagnostics (tab 7 "진단 화면"), the menubar status file (tab 6 "상태 읽기"),
// the nightly backup schedule, and the managers for backups and updates. One instance per server (routes/system.ts).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { CheckStatus, ConnectionStatus, DiagnosticCheck, Diagnostics, Locale } from '@mycel/shared/api'
import { PfStatus, type StatusFile } from '@mycel/shared/install'
import { teamDefaultLocale } from '../admin/settings'
import type { AppContext } from '../context'
import { DEFAULT_PROXY_PORT } from '../app-config'
import { REJECTED_KEY, tokenFile } from '../proxy/subscription'
import { BackupManager } from './backup'
import { checkEngines, type EngineLogin } from './engines'
import { codexLoginState } from '../native'
import { connectionStatus } from './connection'
import { diskSpace, resolveLayout, type InstallLayout } from './layout'
import { M, tr, uptimeText } from './messages'
import { engineSockets, maxSocketPathBytes, probeSocket, tooLongSockets, underSandboxDeniedTmp } from './sockets'
import { UpdateManager } from './update'

/** after a failed nightly backup, the next try waits this long */
export const DAILY_BACKUP_RETRY_MS = 60 * 60_000

const RANK: Record<CheckStatus, number> = { ok: 0, unknown: 1, warn: 2, fail: 3 }
export const worst = (xs: CheckStatus[]): CheckStatus => xs.reduce<CheckStatus>((a, b) => (RANK[b] > RANK[a] ? b : a), 'ok')

export interface OpsOptions {
  /** override for tests */
  layout?: InstallLayout
  engines?: () => Promise<EngineLogin[]>
  /** run `tmutil isexcluded` (prod only) */
  tmutil?: (p: string) => Promise<boolean | null>
  now?: () => Date
  allowUnsignedUpdates?: boolean
  /** folder with cron.deny / at.deny (tests) */
  atDir?: string
}

/** Reported failures of the desktop app's office-network direct connection (POST /api/connect-info/lan-failure). */
export type LanFailureCode = 'unreachable' | 'cert_mismatch' | 'timeout'
const LAN_FAILURE_WINDOW_MS = 24 * 3600_000
const LAN_FAILURE_PER_SESSION_MS = 3600_000

export class OpsService {
  readonly layout: InstallLayout
  /** sessionId -> last counted failure time; failures in the last 24 h (memory only: a restart starts over) */
  private lanBySession = new Map<string, number>()
  private lanFailures: { at: number; code: LanFailureCode }[] = []
  readonly backups: BackupManager
  readonly updates: UpdateManager
  private engineCache: { at: number; v: EngineLogin[]; stamp: string } | null = null
  private timers: ReturnType<typeof setInterval>[] = []

  constructor(private ctx: AppContext, private o: OpsOptions = {}) {
    this.layout = o.layout ?? resolveLayout(ctx.config)
    this.backups = new BackupManager({ db: ctx.db, dbFile: path.join(ctx.config.dataDir, 'app.db'), layout: this.layout, log: ctx.log.child({ c: 'backup' }), version: ctx.version, now: o.now })
    this.updates = new UpdateManager({
      appDir: this.layout.appDir, dataDir: ctx.config.dataDir, version: ctx.version, channel: ctx.config.update.channel,
      feedUrl: ctx.config.update.feedUrl, log: ctx.log.child({ c: 'update' }), allowUnsigned: o.allowUnsignedUpdates,
    })
  }

  private now() { return this.o.now?.() ?? new Date() }

  /** role-account install: the engine runs as another account (launcher LaunchDaemon) */
  get roleAccount() { return this.ctx.config.mode === 'prod' && this.ctx.config.engine.agentUid !== undefined && this.ctx.config.engine.agentUid !== process.getuid?.() }

  async engines(): Promise<EngineLogin[]> {
    if (this.o.engines) return this.o.engines()
    // the subscription token's state changes without a restart (stored again, refused by the upstream): part of the key
    const stamp = this.tokenStamp()
    if (this.engineCache && Date.now() - this.engineCache.at < 5 * 60_000 && this.engineCache.stamp === stamp) return this.engineCache.v
    const cfg = this.ctx.config.engine
    const which = (n: string) => { for (const d of (process.env.PATH ?? '').split(':').concat(['/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local', 'bin')])) { const p = path.join(d, n); if (fs.existsSync(p)) return p } return null }
    const v = await checkEngines({
      authMode: cfg.authMode, roleAccount: this.roleAccount,
      claudeBin: cfg.claudeBin ?? this.ctx.engineConfig.claudeBin ?? which('claude'),
      // role-account install: only the installer's Codex (the launcher allows nothing else), login asked of the launcher
      codexBin: this.roleAccount ? cfg.codexBin ?? null : cfg.codexBin ?? which('codex'),
      secretsDir: this.layout.secretsDir,
      db: this.ctx.db,
      ...(this.roleAccount ? { codexLogin: () => codexLoginState(cfg.launcherSock ?? path.join(this.ctx.engineConfig.runDir, 'launcher.sock')) } : {}),
    })
    this.engineCache = { at: Date.now(), v, stamp }
    return v
  }

  private tokenStamp(): string {
    let f = 'none', r = 'none'
    try { const st = fs.lstatSync(tokenFile(this.layout.secretsDir)); f = `${st.ino}:${st.size}:${st.mtimeMs}` } catch {}
    try { r = (this.ctx.db.query('SELECT value FROM settings WHERE key = ?').get(REJECTED_KEY) as { value: string } | null)?.value ?? 'none' } catch {}
    return `${f}|${r}`
  }

  queue(): { running: number; queued: number; concurrency: number } {
    let running = 0, queued = 0, concurrency = 3
    try {
      for (const r of this.ctx.db.query("SELECT status, COUNT(*) AS n FROM turns WHERE status IN ('running','queued') GROUP BY status").all() as { status: string; n: number }[]) {
        if (r.status === 'running') running = r.n
        else queued = r.n
      }
      const s = this.ctx.db.query("SELECT value FROM settings WHERE key = 'concurrency'").get() as { value: string } | null
      const n = s ? Number(JSON.parse(s.value)) : NaN
      if (Number.isInteger(n) && n >= 1 && n <= 16) concurrency = n
    } catch {}
    return { running, queued, concurrency }
  }

  connection(): ConnectionStatus { return connectionStatus(this.ctx) }

  private pfStatus(): PfStatus | null {
    try { return PfStatus.parse(JSON.parse(fs.readFileSync(this.layout.pfStatusFile, 'utf8'))) } catch { return null }
  }

  private launcherPlist(): string | null {
    if (!this.layout.label) return null
    try { return fs.readFileSync(path.join(this.layout.launchDaemonsDir, `${this.layout.label}.launcher.plist`), 'utf8') } catch { return null }
  }

  /**
   * A desktop app found the office address but could not use it (design tab 4 / 6 "응용 프로그램 방화벽"). Counted
   * once per session per hour, so one laptop retrying every minute is one failure. Returns whether it was counted.
   */
  recordLanFailure(sessionId: string, code: LanFailureCode): boolean {
    const now = this.now().getTime()
    const last = this.lanBySession.get(sessionId)
    if (last !== undefined && now - last < LAN_FAILURE_PER_SESSION_MS) return false
    this.lanBySession.set(sessionId, now)
    this.lanFailures.push({ at: now, code })
    this.pruneLan(now)
    return true
  }
  private pruneLan(now: number) {
    this.lanFailures = this.lanFailures.filter((f) => now - f.at < LAN_FAILURE_WINDOW_MS).slice(-1000)
    for (const [k, at] of this.lanBySession) if (now - at >= LAN_FAILURE_PER_SESSION_MS) this.lanBySession.delete(k)
  }
  lanFailureSummary(): { total: number; byCode: Record<LanFailureCode, number> } {
    this.pruneLan(this.now().getTime())
    const byCode: Record<LanFailureCode, number> = { unreachable: 0, cert_mismatch: 0, timeout: 0 }
    for (const f of this.lanFailures) byCode[f.code]++
    return { total: this.lanFailures.length, byCode }
  }

  private async tmExcluded(p: string): Promise<boolean | null> {
    if (this.o.tmutil) return this.o.tmutil(p)
    if (process.platform !== 'darwin' || !fs.existsSync('/usr/bin/tmutil')) return null
    try {
      const pr = Bun.spawn(['/usr/bin/tmutil', 'isexcluded', p], { stdout: 'pipe', stderr: 'ignore' })
      const out = await new Response(pr.stdout).text()
      await pr.exited
      return /\[Excluded\]/.test(out)
    } catch { return null }
  }

  async diagnostics(locale: Locale): Promise<Diagnostics> {
    const L = this.layout
    const t = (x: Parameters<typeof tr>[1]) => tr(locale, x)
    const checks: DiagnosticCheck[] = []
    const add = (id: string, group: string, label: string, status: CheckStatus, detail: string | null) => checks.push({ id, group, label, status, detail })
    const prod = this.ctx.config.mode === 'prod'

    add('server', 'server', t(M.server), 'ok', t(M.serverDetail(this.ctx.version, uptimeText((Date.now() - this.ctx.startedAt) / 1000, locale))))

    // connection
    const c = this.connection()
    const relay = c.mode === 'direct-only' || c.state === 'not_registered' || c.state === 'disabled'
      ? { s: 'warn' as const, d: t(M.relayOff) }
      : c.state === 'connected' ? { s: 'ok' as const, d: c.address }
      : c.state === 'connecting' ? { s: 'warn' as const, d: t(M.relayConnecting) }
      : c.state === 'replaced' ? { s: 'fail' as const, d: t(M.relayReplaced) }
      : { s: 'fail' as const, d: t(M.relayOffline) }
    add('relay', 'relay', t(M.relay), relay.s, relay.d)

    // disk (tab 7 "디스크 단계")
    const team = diskSpace(L.teamRoot), data = diskSpace(L.dataDir)
    const diskCheck = (id: string, label: string, d: { free: number; total: number }) => {
      const pct = d.total ? Math.round((d.free / d.total) * 100) : 0
      const ro = Math.max(10 * 1024 ** 3, d.total * 0.05)
      if (d.free < ro) add(id, 'disk', label, 'fail', t(M.diskReadOnly(d.free)))
      else if (pct < 15) add(id, 'disk', label, 'warn', t(M.diskLow(d.free, pct)))
      else add(id, 'disk', label, 'ok', t(M.diskOk(d.free, pct)))
    }
    diskCheck('disk.team', t(M.diskTeam), team)
    diskCheck('disk.data', t(M.diskData), data)

    // engines
    for (const e of await this.engines()) {
      const label = t(e.engine === 'claude-code' ? M.engineClaude : M.engineCodex)
      const id = `engine.${e.engine}`
      if (e.loggedIn && e.reason === 'setup_token_expiring' && e.expiresAt) add(id, 'engines', label, 'warn', t(M.engineSetupTokenExpiring(new Intl.DateTimeFormat(locale === 'ko' ? 'ko-KR' : locale === 'id' ? 'id-ID' : 'en-US', { dateStyle: 'medium' }).format(new Date(e.expiresAt)))))
      else if (e.loggedIn) add(id, 'engines', label, 'ok', t(M.engineOk(e.method)))
      else if (e.reason === 'setup_token_expired') add(id, 'engines', label, 'fail', t(M.engineSetupTokenExpired))
      else if (e.reason === 'setup_token_invalid') add(id, 'engines', label, 'fail', t(M.engineSetupTokenInvalid))
      else if (e.reason === 'not_installed') add(id, 'engines', label, e.engine === 'codex' ? 'warn' : 'fail', t(M.engineNotInstalled))
      else if (e.reason === 'setup_token_missing') add(id, 'engines', label, 'fail', t(M.engineSetupToken))
      else if (e.reason === 'engine_login_missing') add(id, 'engines', label, 'warn', t(M.engineCodexLogin))
      else if (e.reason === 'check_failed') add(id, 'engines', label, 'unknown', t(M.engineCheckFailed))
      else add(id, 'engines', label, 'fail', t(M.engineNotLoggedIn))
    }

    // model proxy (subscription mode; production always runs it for Codex too): listening, or its port taken by
    // another program (design tab 1 "리슨")
    if (this.ctx.config.engine.authMode === 'subscription' || prod) {
      const port = this.ctx.config.engine.proxyPort ?? DEFAULT_PROXY_PORT
      const st = this.ctx.services.modelProxy?.state ?? null
      if (st === 'listening') add('model_proxy', 'engines', t(M.modelProxy), 'ok', t(M.modelProxyOk(port)))
      else if (st === 'port_in_use') add('model_proxy', 'engines', t(M.modelProxy), 'fail', t(M.modelProxyPortInUse(port)))
      else add('model_proxy', 'engines', t(M.modelProxy), 'unknown', t(M.modelProxyNotStarted))
    }

    // engine sockets: a path that does not fit in a Unix socket address (long data folder) stops every engine turn
    const runDir = this.ctx.engineConfig.runDir
    const long = tooLongSockets(engineSockets(runDir, prod ? this.ctx.config.engine.launcherSock ?? path.join(runDir, 'launcher.sock') : null))
    if (long.length) add('sockets', 'engines', t(M.sockets), 'fail', t(M.socketsTooLong(long.map((x) => `${x.path} (${x.bytes})`).join(', '), long[0]!.max, !prod)))
    else if (process.platform === 'darwin' && !prod && underSandboxDeniedTmp(runDir)) add('sockets', 'engines', t(M.sockets), 'warn', t(M.socketsTmp(L.dataDir)))
    else add('sockets', 'engines', t(M.sockets), 'ok', t(M.socketsOk(maxSocketPathBytes())))

    // office-network direct connection (TLS): failures the desktop apps reported
    const tls = this.ctx.config.tls
    if (tls) {
      const lan = this.lanFailureSummary()
      if (lan.total) add('lan_direct', 'connection', t(M.lan), 'warn', t(M.lanFailed(lan.total, lan.byCode.cert_mismatch, tls.port)))
      else add('lan_direct', 'connection', t(M.lan), 'ok', t(M.lanOk(tls.port)))
    }

    // queue
    const q = this.queue()
    add('queue', 'queue', t(M.queue), q.queued > 3 * q.concurrency ? 'warn' : 'ok', q.queued > 3 * q.concurrency ? t(M.queueLong(q.queued)) : t(M.queueDetail(q.running, q.queued, q.concurrency)))

    // OS controls (tab 2 "기본 ① 방화벽 ② 샌드박스")
    if (!prod || !L.rootDir) {
      add('pf_anchor', 'pf_anchor', t(M.firewall), 'unknown', t(M.firewallDev))
      add('sandbox', 'sandbox', t(M.sandbox), 'unknown', t(M.sandboxDev))
    } else {
      const pf = this.pfStatus()
      if (!fs.existsSync(path.join(L.rootDir, 'pf.anchor'))) add('pf_anchor', 'pf_anchor', t(M.firewall), 'fail', t(M.firewallMissing))
      else if (!pf || this.now().getTime() - Date.parse(pf.at) > 15 * 60_000) add('pf_anchor', 'pf_anchor', t(M.firewall), 'fail', t(M.firewallStale))
      else if (!pf.enabled || !pf.referenced || pf.rules === 0) add('pf_anchor', 'pf_anchor', t(M.firewall), 'fail', t(M.firewallOff(!pf.enabled ? 'pf disabled' : !pf.referenced ? 'anchor not referenced' : 'no rules')))
      else add('pf_anchor', 'pf_anchor', t(M.firewall), 'ok', t(M.firewallOk(pf.rules)))
      const plist = this.launcherPlist()
      const sbOk = fs.existsSync(path.join(L.rootDir, 'engine.sb')) && !!plist && plist.includes('--sandbox-profile')
      add('sandbox', 'sandbox', t(M.sandbox), sbOk ? 'ok' : 'fail', t(sbOk ? M.sandboxOk : M.sandboxMissing))
      const sock = this.ctx.config.engine.launcherSock
      if (sock) {
        // never throws (a failed connect used to end the whole server here, see system/sockets.ts)
        const r = await probeSocket(sock).catch(() => 'error' as const)
        // the installer logs the server to /Library/Logs/<id>/server and launchd's launcher output to .../crash
        const logsRoot = L.logDir ? (path.basename(L.logDir) === 'server' ? path.dirname(L.logDir) : L.logDir) : null
        // one check per outcome: a running launcher used to get both "Connected" and "Cannot reach" (the else below)
        if (r === 'ok') add('launcher', 'launcher', t(M.launcher), 'ok', t(M.launcherOk))
        else if (r === 'missing' || r === 'refused') add('launcher', 'launcher', t(M.launcher), 'fail', t(M.launcherNotRunning(L.label, logsRoot, L.launchDaemonsDir)))
        else if (r === 'denied') add('launcher', 'launcher', t(M.launcher), 'fail', t(M.launcherDenied))
        else if (r === 'timeout') add('launcher', 'launcher', t(M.launcher), 'warn', t(M.launcherTimeout))
        else if (r !== 'too_long') add('launcher', 'launcher', t(M.launcher), 'fail', t(M.launcherDown)) // too_long: the sockets check says it
      }
      const agentUid = this.ctx.config.engine.agentUid
      if (agentUid !== undefined) {
        const name = Bun.spawnSync(['/usr/bin/id', '-nu', String(agentUid)], { stdout: 'pipe', stderr: 'ignore' }).stdout.toString().trim()
        const listed = (f: string) => { try { return fs.readFileSync(f, 'utf8').split('\n').map((l) => l.trim()).includes(name) } catch { return false } }
        const ok = !!name && [path.join(this.o.atDir ?? '/var/at', 'cron.deny'), path.join(this.o.atDir ?? '/var/at', 'at.deny')].every(listed)
        add('cron_deny', 'sandbox', t(M.cronDeny), ok ? 'ok' : 'warn', t(ok ? M.cronDenyOk : M.cronDenyMissing))
      }
      const tm = await Promise.all([L.secretsDir, path.join(L.base, 'agent')].filter((p) => fs.existsSync(p)).map((p) => this.tmExcluded(p)))
      if (tm.length && tm.every((x) => x !== null)) add('time_machine', 'backups', t(M.timeMachine), tm.every(Boolean) ? 'ok' : 'warn', t(tm.every(Boolean) ? M.timeMachineOk : M.timeMachineMissing))
    }

    // backups
    const lastB = this.backups.latest()
    const err = this.backups.lastError()
    if (err && (!lastB || err.at > lastB.createdAt)) add('backups', 'backups', t(M.backups), 'fail', t(M.backupFailed(err.message)))
    else if (!lastB) add('backups', 'backups', t(M.backups), 'warn', t(M.backupNone))
    else {
      const h = Math.floor((this.now().getTime() - Date.parse(lastB.createdAt)) / 3600_000)
      add('backups', 'backups', t(M.backups), h > 48 ? 'warn' : 'ok', h > 48 ? t(M.backupOld(h)) : t(M.backupOk(new Intl.DateTimeFormat(locale === 'ko' ? 'ko-KR' : locale === 'id' ? 'id-ID' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(lastB.createdAt)), lastB.scope)))
    }
    try {
      const rr = JSON.parse(fs.readFileSync(path.join(L.dataDir, 'restore-result.json'), 'utf8')) as { ok: boolean; at: string; error?: string }
      if (!rr.ok && this.now().getTime() - Date.parse(rr.at) < 7 * 86400_000) add('restore', 'backups', t(M.backups), 'fail', t(M.restoreFailed(rr.error ?? '')))
    } catch {}

    // updates
    if (!this.updates.installed) add('update', 'update', t(M.update), 'ok', t(M.updateDev))
    else {
      const h = this.updates.history().at(-1)
      if (h && h.result !== 'ok' && this.now().getTime() - Date.parse(h.at) < 7 * 86400_000) add('update', 'update', t(M.update), 'warn', t(M.updateRolledBack(h.to, h.detail ?? '')))
      else add('update', 'update', t(M.update), 'ok', t(M.updateOk(this.ctx.version)))
      const cur = this.updates.currentLinkTarget()
      const signed = !!cur && fs.existsSync(path.join(this.layout.appDir!, 'versions', cur, 'manifest.sig'))
      add('release_signature', 'update', t(M.releaseSig), signed ? 'ok' : 'warn', t(signed ? M.releaseSigned : M.releaseUnsigned))
    }

    return {
      version: this.ctx.version,
      host: { os: `${process.platform} ${os.release()}`, arch: process.arch, hostname: os.hostname() },
      disk: { teamFolderFreeBytes: Math.max(0, Math.floor(team.free)), dataFreeBytes: Math.max(0, Math.floor(data.free)) },
      queue: q,
      checks,
      generatedAt: this.now().toISOString(),
    }
  }

  /** Status for the menubar app: problems in the team's default language, which the menubar app's own words follow. */
  async statusFile(): Promise<StatusFile> {
    const locale = teamDefaultLocale(this.ctx.db)
    const d = await this.diagnostics(locale)
    const c = this.connection()
    const get = (id: string) => d.checks.find((x) => x.id === id)?.status ?? 'unknown'
    const port = this.ctx.config.listen.port
    return {
      format: 1,
      writtenAt: this.now().toISOString(),
      version: this.ctx.version,
      pid: process.pid,
      webUrl: c.address ?? `http://127.0.0.1:${port}`,
      localUrl: `http://127.0.0.1:${port}`,
      label: this.layout.label,
      logsDir: this.layout.logDir,
      connection: { mode: c.mode, state: c.state, address: c.address, detail: c.detail },
      queue: { running: d.queue.running, queued: d.queue.queued },
      firewall: get('pf_anchor'),
      sandbox: get('sandbox'),
      lastBackupAt: this.backups.latest()?.createdAt ?? null,
      overall: worst(d.checks.filter((x) => x.status !== 'unknown').map((x) => x.status)),
      problems: d.checks.filter((x) => x.status === 'fail' || x.status === 'warn').map((x) => `${x.label}: ${x.detail ?? x.status}`).slice(0, 20),
      locale,
    }
  }

  async writeStatusFile(): Promise<void> {
    const s = await this.statusFile()
    fs.mkdirSync(this.layout.statusDir, { recursive: true, mode: 0o750 })
    const f = path.join(this.layout.statusDir, 'status.json')
    const tmp = f + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(s, null, 1), { mode: 0o640 })
    fs.chmodSync(tmp, 0o640)
    fs.renameSync(tmp, f)
  }

  /** Nightly backup: once a day after 03:00 local time (or any time when the last one is over 30 h old). */
  shouldRunDailyBackup(): boolean {
    const now = this.now()
    const last = this.backups.metas().filter((m) => m.kind === 'daily').at(-1)
    const age = last ? now.getTime() - Date.parse(last.createdAt) : Infinity
    if (age < 20 * 3600_000) return false
    // a failed attempt waits an hour (this check runs every 10 minutes; without the wait a backup that keeps failing
    // read and compressed the whole team folder six times an hour)
    const err = this.backups.lastError()
    const errAt = err ? Date.parse(err.at) : NaN
    if (Number.isFinite(errAt) && now.getTime() - errAt < DAILY_BACKUP_RETRY_MS && (!last || errAt > Date.parse(last.createdAt))) return false
    return now.getHours() >= 3 || age > 30 * 3600_000
  }

  start() {
    const log = this.ctx.log.child({ c: 'ops' })
    const status = () => this.writeStatusFile().catch((e) => log.warn('status file not written', { err: e }))
    void status()
    this.timers.push(setInterval(status, 30_000))
    this.timers.push(setInterval(() => {
      if (!this.shouldRunDailyBackup()) return
      this.backups.run({ kind: 'daily', scope: 'full' }).catch((e) => log.error('daily backup failed', { err: e }))
    }, 10 * 60_000))
    for (const t of this.timers) (t as unknown as { unref?: () => void }).unref?.()
  }

  stop() { for (const t of this.timers.splice(0)) clearInterval(t) }
}
