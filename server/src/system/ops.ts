// Operations service of component G: diagnostics (tab 7 "진단 화면"), the menubar status file (tab 6 "상태 읽기"),
// the nightly backup schedule, and the managers for backups and updates. One instance per server (routes/system.ts).
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { CheckStatus, ConnectionStatus, DiagnosticCheck, Diagnostics, Locale } from '@mycel/shared/api'
import { FirewallStatus, PfStatus, type StatusFile } from '@mycel/shared/install'
import { PRODUCT, type LauncherStatus } from '@mycel/shared'
import { getTeamSettings, installId, teamDefaultLocale, teamTimeZone } from '../admin/settings'
import type { AppContext } from '../context'
import { allowedCredentialKinds, DEFAULT_PROXY_PORT, isManaged } from '../app-config'
import { teamCredentialSummary } from '../credentials/resolve'
import { Vault } from '../credentials/vault'
import { engineSandboxProfile, findCodexBin } from '../config'
import { safeOpsReadiness } from '../safe-ops/ready'
import { safeOpsEnabled } from '../safe-ops/runner'
import { REJECTED_KEY, tokenFile } from '../proxy/subscription'
import { BackupManager } from './backup'
import { checkEngines, type EngineLogin } from './engines'
import { codexLoginState, launcherStatus } from '../native'
import { connectionStatus } from './connection'
import { diskSpace, resolveLayout, type InstallLayout } from './layout'
import { M as MAC_M, tr, uptimeText } from './messages'
import { engineSockets, maxSocketPathBytes, probeSocket, tooLongSockets, underSandboxDeniedTmp } from './sockets'
import { UpdateManager } from './update'
import { configurePlan, currentPlan, effectiveConcurrency, planDiskBytes, planFileProblem } from './limits'
import { configureNotices, noticesFileProblem } from './managed'
import { feature, hostKind, isHosted } from './deployment'
import { pruneOld } from './retention'
import { activityFacts } from './activity'
import { configureStorageGuard, levelOf, snapshotOf, storageRoom, StorageMonitor } from './storage'
import { hostMessages, ML } from './messages-linux'
import { audit } from '../admin/audit'
import { autoUpdateDecision, runUpdate } from './update-job'
import { zonedParts } from './time-zone'
import { getChatRuntime } from '../chat/runtime'
import { egressSettled, egressStatus, EXIT_ADDRESS_URL, exitAddressCheckOff } from '../tools/egress'

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
  /** folder with cron.deny / at.deny (tests; macOS /var/at, Linux /etc) */
  atDir?: string
  /** which diagnostics an installed server shows (tests; default process.platform): darwin = pf, LaunchDaemons, Time
   * Machine; linux = nftables, systemd, the launcher's sandbox report */
  platform?: NodeJS.Platform
  /** the launcher's status report (tests) */
  launcherStatus?: (sock: string) => Promise<LauncherStatus | null>
  /** /proc/sys (tests): kernel.yama.ptrace_scope, user.max_user_namespaces */
  procSysDir?: string
  /** planned restart after an automatic update (tests; default: SIGTERM to this process, the bootstrap starts it again) */
  restart?: (why: string) => void
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
  readonly storage: StorageMonitor
  private engineCache: { at: number; v: EngineLogin[]; stamp: string } | null = null
  private timers: ReturnType<typeof setInterval>[] = []
  /** the one maintenance operation running now (backup / restore / update / export), routes/system.ts and autoUpdateTick */
  private busy: string | null = null

  constructor(private ctx: AppContext, private o: OpsOptions = {}) {
    this.layout = o.layout ?? resolveLayout(ctx.config)
    // the root-owned plan file of an installed server (system/limits.ts); $MYCEL_PLAN_FILE wins
    configurePlan({ file: this.layout.planFile, log: ctx.log.child({ c: 'plan' }) })
    // the operator's notices for the web banner (system/managed.ts); $MYCEL_NOTICES_FILE wins
    configureNotices({ file: this.layout.noticesFile, log: ctx.log.child({ c: 'notices' }) })
    this.backups = new BackupManager({ db: ctx.db, dbFile: path.join(ctx.config.dataDir, 'app.db'), layout: this.layout, log: ctx.log.child({ c: 'backup' }), version: ctx.version, now: o.now })
    this.updates = new UpdateManager({
      appDir: this.layout.appDir, dataDir: ctx.config.dataDir, version: ctx.version, channel: ctx.config.update.channel,
      feedUrl: ctx.config.update.feedUrl, log: ctx.log.child({ c: 'update' }), allowUnsigned: o.allowUnsignedUpdates,
    })
    // the team disk (system/storage.ts): writes are refused near full where the resource limits apply
    configureStorageGuard({ root: this.layout.teamRoot })
    this.storage = new StorageMonitor({
      db: ctx.db, teamRoot: this.layout.teamRoot, dataDir: this.layout.dataDir, appDir: this.layout.appDir, now: o.now ? () => this.now().getTime() : undefined,
      audit: (detail) => audit(ctx.db, { actor: null, action: 'storage.warn', target: null, detail }),
      notify: (m) => {
        try {
          const admins = ctx.db.query("SELECT id, locale FROM users WHERE role IN ('owner','admin') AND status = 'active' AND deleted_at IS NULL").all() as { id: string; locale: Locale | null }[]
          for (const u of admins) ctx.services.realtime.publish(u.id, { type: 'notice', data: { level: 'warn', code: 'storage_warn', message: m[u.locale ?? 'en'] ?? m.en } })
        } catch (e) { ctx.log.warn('could not tell the admins about the storage', { err: e }) }
      },
    })
  }

  private now() { return this.o.now?.() ?? new Date() }

  /** Take the maintenance lock (false: another operation runs). */
  tryLock(name: string): boolean { if (this.busy) return false; this.busy = name; return true }
  unlock() { this.busy = null }
  get busyWith() { return this.busy }

  /** This server applies app-only releases by itself (Linux self-host: server.json update.auto, never the hosted cloud). */
  get autoUpdates(): boolean { return !!this.ctx.config.update.auto && feature(this.ctx.config, 'selfUpdate') && this.updates.installed }

  private autoFile() { return path.join(this.ctx.config.dataDir, 'update-auto.json') }

  /** One automatic-update check (hourly): the feed, the roll-out, the team's update window, no running answer; then the
   * same run as "update now". Returns what it decided (tests, the log). */
  async autoUpdateTick(): Promise<string> {
    if (!this.autoUpdates) return 'off'
    if (!this.updates.feedUsable) return 'no_feed'
    const feed = await this.updates.checkFeed()
    let last: { version: string; at: string } | null = null
    try { last = JSON.parse(fs.readFileSync(this.autoFile(), 'utf8')) } catch {}
    const s = getTeamSettings(this.ctx.db)
    const d = autoUpdateDecision({ feed, current: this.ctx.version, installId: installId(this.ctx.db), now: this.now(), tz: teamTimeZone(this.ctx.db),
      window: s.updateWindow, running: this.queue().running, history: this.updates.history(), lastAttempt: last })
    if (!d.go) return d.why
    if (!this.tryLock('update')) return 'busy'
    const log = this.ctx.log.child({ c: 'update' })
    log.info('automatic update', { to: d.version })
    try {
      await runUpdate({ updates: this.updates, backups: this.backups, running: () => this.queue().running, locale: teamDefaultLocale(this.ctx.db),
        restart: (why) => {
          // remembered before the restart: when the bootstrap rolls it back, this version waits 7 days (update-job.ts)
          fs.writeFileSync(this.autoFile(), JSON.stringify({ version: d.version, at: this.now().toISOString() }), { mode: 0o600 })
          if (this.o.restart) this.o.restart(why)
          else setTimeout(() => process.kill(process.pid, 'SIGTERM'), 1500)
        } }, d.version, { staged: false, rollback: false })
      return 'updated'
    } catch (e) {
      log.warn('automatic update failed', { to: d.version, err: String(e).slice(0, 300) })
      return 'failed'
    } finally { this.unlock() }
  }

  /** role-account install: the engine runs as another account (launcher LaunchDaemon) */
  get roleAccount() { return this.ctx.config.mode === 'prod' && this.ctx.config.engine.agentUid !== undefined && this.ctx.config.engine.agentUid !== process.getuid?.() }

  async engines(): Promise<EngineLogin[]> {
    if (this.o.engines) return this.o.engines()
    // the subscription token's state changes without a restart (stored again, refused by the upstream): part of the key
    const stamp = this.tokenStamp()
    if (this.engineCache && Date.now() - this.engineCache.at < 5 * 60_000 && this.engineCache.stamp === stamp) return this.engineCache.v
    const cfg = this.ctx.config.engine
    const which = (n: string) => { for (const d of (process.env.PATH ?? '').split(':').concat(['/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local', 'bin')])) { const p = path.join(d, n); if (fs.existsSync(p)) return p } return null }
    const allowed = allowedCredentialKinds(this.ctx.config)
    const v = await checkEngines({
      authMode: cfg.authMode, roleAccount: this.roleAccount,
      ...(isManaged(this.ctx.config) ? { managed: { 'claude-code': teamCredentialSummary(this.ctx.db, 'anthropic', allowed), codex: teamCredentialSummary(this.ctx.db, 'openai', allowed) } } : {}),
      claudeBin: cfg.claudeBin ?? this.ctx.engineConfig.claudeBin ?? which('claude'),
      // Every production install uses only its configured executable; dev shares the runtime/admin resolver.
      codexBin: this.ctx.config.mode === 'prod' ? cfg.codexBin ?? null : findCodexBin(cfg.codexBin),
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
    // managed: any change of an AI connection (added, refused, limited, removed)
    let c = 'none'
    try { const x = this.ctx.db.query('SELECT COUNT(*) AS n, MAX(updated_at) AS u, MAX(COALESCE(limited_until, \'\')) AS l FROM engine_credentials').get() as { n: number; u: string | null; l: string }; c = `${x.n}:${x.u}:${x.l}` } catch {}
    return `${f}|${r}|${c}`
  }

  queue(): Diagnostics['queue'] {
    let running = 0, queued = 0, concurrency = 3
    try {
      for (const r of this.ctx.db.query("SELECT status, COUNT(*) AS n FROM turns WHERE status IN ('running','queued') GROUP BY status").all() as { status: string; n: number }[]) {
        if (r.status === 'running') running = r.n
        else queued = r.n
      }
      // the same number the queue uses: min(admin setting, plan), system/limits.ts
      concurrency = effectiveConcurrency(this.ctx.db)
    } catch {}
    try {
      const rt = getChatRuntime(this.ctx)
      return { running: rt.runningCount(), queued: rt.queuedCount(), concurrency, ...rt.queueDiagnostics() }
    } catch { return { running, queued, concurrency } }
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

  private platform(): NodeJS.Platform { return this.o.platform ?? process.platform }

  async diagnostics(locale: Locale): Promise<Diagnostics> {
    const L = this.layout
    // the Mac's wording as it always was; a Linux server and the hosted cloud get theirs (system/messages-linux.ts)
    const host = hostKind(this.ctx.config, this.platform())
    const M = hostMessages(host, { id: L.label ?? path.basename(L.base), base: L.base })
    const t = (x: Parameters<typeof tr>[1]) => tr(locale, x)
    const checks: DiagnosticCheck[] = []
    const add = (id: string, group: string, label: string, status: CheckStatus, detail: string | null) => checks.push({ id, group, label, status, detail })
    const prod = this.ctx.config.mode === 'prod'

    add('server', 'server', t(M.server), 'ok', t(M.serverDetail(this.ctx.version, uptimeText((Date.now() - this.ctx.startedAt) / 1000, locale))))
    // plan.json / notices.json that did not parse: the previous values stay in force (system/limits.ts, managed.ts)
    const managedBad = [['plan.json', planFileProblem()], ['notices.json', noticesFileProblem()]] as const
    for (const [file, p] of managedBad) if (p) add(`managed.${file.split('.')[0]}`, 'server', t(ML.managedFiles), 'warn', t(ML.managedFileBad(file, p.error.slice(0, 120), host === 'hosted')))

    // connection. Without the relay the line says what the server knows: a public address set up (tunnel.host, the
    // server's own domain; never the relay's team address) or the office network only (QA: a Linux server behind a
    // Cloudflare tunnel said "office only")
    const c = this.connection()
    const pub = c.publicAddress ?? null
    const relay = this.ctx.config.office ? { s: 'ok' as const, d: t(pub ? M.relayOfficePublic(pub) : M.relayOffice) }
      : c.mode === 'direct-only' || c.state === 'not_registered' || c.state === 'disabled'
      ? pub ? { s: 'ok' as const, d: t(M.relayPublic(pub)) } : { s: 'warn' as const, d: t(M.relayOff) }
      : c.state === 'connected' ? { s: 'ok' as const, d: c.address }
      : c.state === 'connecting' ? { s: 'warn' as const, d: t(M.relayConnecting) }
      : c.state === 'replaced' ? { s: 'fail' as const, d: t(M.relayReplaced) }
      : { s: 'fail' as const, d: t(M.relayOffline) }
    add('relay', 'relay', t(M.relay), relay.s, relay.d)

    // this server's public exit address (tools/egress.ts), where it is learned (installed servers, office Macs): known or
    // not and from where, never the address itself. Unknown: every web address the AI opens asks, and scheduled tasks
    // open none (QA 0.2.12 N5). Right after a start the first check gets its moment.
    if (prod || this.ctx.config.office) {
      await egressSettled(this.ctx)
      const ex = egressStatus(this.ctx)
      const families = [ex.ipv4 ? 'IPv4' : '', ex.ipv6 ? 'IPv6' : ''].filter(Boolean).join(', ')
      if (ex.known) add('exit_address', 'connection', t(M.exitAddress), 'ok', t(families ? M.exitAddressKnown(families) : M.exitAddressKnownRelay))
      else if (exitAddressCheckOff()) add('exit_address', 'connection', t(M.exitAddress), 'warn', t(M.exitAddressOff(`${PRODUCT.envPrefix}EXIT_ADDRESS_CHECK=off`)))
      else add('exit_address', 'connection', t(M.exitAddress), 'warn', t(M.exitAddressUnknown(EXIT_ADDRESS_URL)))
    }

    // disk (tab 7 "디스크 단계")
    const team = diskSpace(L.teamRoot), data = diskSpace(L.dataDir)
    const diskCheck = (id: string, label: string, d: { free: number; total: number }) => {
      const pct = d.total ? Math.round((d.free / d.total) * 100) : 0
      const ro = Math.max(10 * 1024 ** 3, d.total * 0.05)
      if (d.free < ro) add(id, 'disk', label, 'fail', t(M.diskReadOnly(d.free)))
      else if (pct < 15) add(id, 'disk', label, 'warn', t(M.diskLow(d.free, pct)))
      else add(id, 'disk', label, 'ok', t(M.diskOk(d.free, pct)))
    }
    if (this.platform() === 'linux' && prod) this.linuxStorage(add, t, team, data)
    else {
      diskCheck('disk.team', t(M.diskTeam), team)
      diskCheck('disk.data', t(M.diskData), data)
    }

    // engines
    for (const e of await this.engines()) {
      if (this.ctx.config.office && e.engine === 'codex') continue // office mode: Claude only (engine.codexBin '')
      const label = t(e.engine === 'claude-code' ? M.engineClaude : M.engineCodex)
      const id = `engine.${e.engine}`
      if (e.loggedIn && e.reason === 'setup_token_expiring' && e.expiresAt) add(id, 'engines', label, 'warn', t(M.engineSetupTokenExpiring(new Intl.DateTimeFormat(locale === 'en' ? 'en-US' : locale, { dateStyle: 'medium' }).format(new Date(e.expiresAt)))))
      else if (e.loggedIn && e.reason === 'credential_expiring') add(id, 'engines', label, 'warn', t(M.engineCredentialExpiring))
      else if (e.loggedIn && e.method?.startsWith('AI connections: ')) add(id, 'engines', label, 'ok', t(M.engineCredentials(Number(e.method.slice(16)))))
      else if (e.loggedIn) add(id, 'engines', label, 'ok', t(M.engineOk(e.method)))
      else if (e.reason === 'setup_token_expired') add(id, 'engines', label, 'fail', t(M.engineSetupTokenExpired))
      else if (e.reason === 'setup_token_invalid') add(id, 'engines', label, 'fail', t(M.engineSetupTokenInvalid))
      else if (e.reason === 'not_installed') add(id, 'engines', label, e.engine === 'codex' ? 'warn' : 'fail', t(M.engineNotInstalled))
      else if (e.reason === 'setup_token_missing') add(id, 'engines', label, 'fail', t(M.engineSetupToken))
      else if (e.reason === 'engine_login_missing') add(id, 'engines', label, 'warn', t(M.engineCodexLogin))
      else if (e.reason === 'credential_none') add(id, 'engines', label, e.engine === 'codex' ? 'warn' : 'fail', t(M.engineCredentialNone))
      else if (e.reason === 'credential_limited') add(id, 'engines', label, 'warn', t(M.engineCredentialLimited))
      else if (e.reason === 'credential_unusable') add(id, 'engines', label, 'fail', t(M.engineCredentialUnusable))
      else if (e.reason === 'check_failed') add(id, 'engines', label, 'unknown', t(M.engineCheckFailed))
      else add(id, 'engines', label, 'fail', t(M.engineNotLoggedIn))
    }

    // model proxy (subscription mode; production always runs it for Codex too): listening, or its port taken by
    // another program (design tab 1 "리슨")
    if (isManaged(this.ctx.config) || prod) {
      const port = this.ctx.config.engine.proxyPort ?? DEFAULT_PROXY_PORT
      const st = this.ctx.services.modelProxy?.state ?? null
      if (st === 'listening') add('model_proxy', 'engines', t(M.modelProxy), 'ok', t(M.modelProxyOk(port)))
      else if (st === 'port_in_use') add('model_proxy', 'engines', t(M.modelProxy), 'fail', t(M.modelProxyPortInUse(port)))
      else add('model_proxy', 'engines', t(M.modelProxy), 'unknown', t(M.modelProxyNotStarted))
    }

    // the key of the AI connections' secrets (managed): a regular 0600 file of the server account, or not made yet
    if (isManaged(this.ctx.config)) {
      const v = new Vault(this.layout.secretsDir).check()
      const n = (this.ctx.db.query('SELECT COUNT(*) AS n FROM engine_credentials').get() as { n: number }).n
      if (v.state === 'ok') add('credentials_key', 'engines', t(M.credentialsKey), 'ok', t(M.credentialsKeyOk))
      else if (v.state === 'missing') add('credentials_key', 'engines', t(M.credentialsKey), n ? 'fail' : 'ok', t(n ? M.credentialsKeyMissing : M.credentialsKeyNone))
      else add('credentials_key', 'engines', t(M.credentialsKey), 'fail', t(M.credentialsKeyUnsafe(v.detail ?? '')))
    }

    // engine sockets: a path that does not fit in a Unix socket address (long data folder) stops every engine turn
    const runDir = this.ctx.engineConfig.runDir
    const long = tooLongSockets(engineSockets(runDir, prod ? this.ctx.config.engine.launcherSock ?? path.join(runDir, 'launcher.sock') : null))
    if (long.length) add('sockets', 'engines', t(M.sockets), 'fail', t(M.socketsTooLong(long.map((x) => `${x.path} (${x.bytes})`).join(', '), long[0]!.max, !prod)))
    else if (process.platform === 'darwin' && !prod && underSandboxDeniedTmp(runDir)) add('sockets', 'engines', t(M.sockets), 'warn', t(M.socketsTmp(L.dataDir)))
    else if (host !== 'hosted') add('sockets', 'engines', t(M.sockets), 'ok', t(M.socketsOk(maxSocketPathBytes())))

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
    if (this.ctx.config.office) {
      // office mode runs every engine turn under engine.sb (context.ts devEngineSandbox refuses to start without it)
      const sb = fs.existsSync(engineSandboxProfile()) && fs.existsSync('/usr/bin/sandbox-exec')
      add('pf_anchor', 'pf_anchor', t(M.firewall), 'unknown', t(M.firewallOffice))
      add('sandbox', 'sandbox', t(M.sandbox), sb ? 'ok' : 'fail', t(sb ? M.sandboxOffice : M.sandboxMissingOffice))
    } else if (!prod || !L.rootDir) {
      add('pf_anchor', 'pf_anchor', t(M.firewall), 'unknown', t(M.firewallDev))
      add('sandbox', 'sandbox', t(M.sandbox), 'unknown', t(M.sandboxDev))
    } else if (this.platform() === 'linux') {
      await this.linuxChecks(add, t, M, host === 'hosted')
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
      add('backups', 'backups', t(M.backups), h > 48 ? 'warn' : 'ok', h > 48 ? t(M.backupOld(h)) : t(M.backupOk(new Intl.DateTimeFormat(locale === 'en' ? 'en-US' : locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(lastB.createdAt)), lastB.scope)))
    }
    try {
      const rr = JSON.parse(fs.readFileSync(path.join(L.dataDir, 'restore-result.json'), 'utf8')) as { ok: boolean; at: string; error?: string }
      if (!rr.ok && this.now().getTime() - Date.parse(rr.at) < 7 * 86400_000) add('restore', 'backups', t(M.backups), 'fail', t(M.restoreFailed(rr.error ?? '')))
    } catch {}

    // updates
    if (this.ctx.config.office) add('update', 'update', t(M.update), 'ok', t(M.updateOffice(this.ctx.version)))
    else if (host === 'hosted') add('update', 'update', t(M.update), 'ok', t(ML.updateManaged(this.ctx.version)))
    else if (!this.updates.installed) add('update', 'update', t(M.update), 'ok', t(M.updateDev))
    else {
      const h = this.updates.history().at(-1)
      if (h && h.result !== 'ok' && this.now().getTime() - Date.parse(h.at) < 7 * 86400_000) add('update', 'update', t(M.update), 'warn', t(M.updateRolledBack(h.to, h.detail ?? '')))
      else add('update', 'update', t(M.update), 'ok', t(M.updateOk(this.ctx.version)))
      const us = this.updates.status()
      if (us.needsRoot && us.available) add('update_root', 'update', t(M.update), 'warn', t(ML.updateNeedsRoot(us.available.version)))
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

  private firewallStatus(): FirewallStatus | null {
    try { return FirewallStatus.parse(JSON.parse(fs.readFileSync(this.layout.firewallStatusFile, 'utf8'))) } catch { return null }
  }

  private readProcSys(rel: string): string | null {
    try { return fs.readFileSync(path.join(this.o.procSysDir ?? '/proc/sys', rel), 'utf8').trim() } catch { return null }
  }

  /** Linux: the team disk by its levels (system/storage.ts) instead of the Mac's absolute 10 GB rule. */
  private linuxStorage(add: (id: string, group: string, label: string, status: CheckStatus, detail: string | null) => void, t: (x: Parameters<typeof tr>[1]) => string,
    team: { free: number; total: number }, data: { free: number; total: number }) {
    const one = (id: string, d: { free: number; total: number }) => {
      let s
      try { s = snapshotOf(fs.statfsSync(id === 'disk.team' ? this.layout.teamRoot : this.layout.dataDir)) } catch { s = { totalBytes: d.total, freeBytes: d.free, usedBytes: d.total - d.free, percent: d.total ? Math.round(((d.total - d.free) / d.total) * 1000) / 10 : 0 } }
      const lvl = levelOf(s.percent)
      const pct = Math.round(s.percent)
      const refused = id === 'disk.team' && storageRoom(0)?.ok === false
      if (lvl === 'full' || refused) add(id, 'disk', t(ML.storage), 'fail', t(ML.storageFull(s.freeBytes, pct)))
      else if (lvl === 'high') add(id, 'disk', t(ML.storage), 'warn', t(ML.storageHigh(s.freeBytes, pct)))
      else add(id, 'disk', t(ML.storage), 'ok', t(ML.storageOk(s.freeBytes, pct)))
      return s
    }
    const s = one('disk.team', team)
    // the data folder is on the same disk in every Linux install; a separate one gets its own line
    if (data.total !== team.total || data.free !== team.free) one('disk.data', data)
    const plan = planDiskBytes()
    if (plan && Math.abs(s.totalBytes - plan) / plan > 0.1) add('disk.plan', 'disk', t(ML.storage), 'warn', t(ML.storagePlanMismatch(s.totalBytes / 1024 ** 3, plan / 1024 ** 3)))
  }

  /** Linux install: nftables, the launcher (systemd) and its sandbox report, kernel isolation, cron/at. */
  private async linuxChecks(add: (id: string, group: string, label: string, status: CheckStatus, detail: string | null) => void, t: (x: Parameters<typeof tr>[1]) => string,
    M: typeof MAC_M, hosted: boolean) {
    const L = this.layout
    const fw = this.firewallStatus()
    if (!fs.existsSync(L.firewallStatusFile)) add('pf_anchor', 'pf_anchor', t(M.firewall), 'fail', t(M.firewallMissing))
    else if (!fw || this.now().getTime() - Date.parse(fw.at) > 15 * 60_000) add('pf_anchor', 'pf_anchor', t(M.firewall), 'fail', t(M.firewallStale))
    else if (!fw.loaded || fw.rules === 0) add('pf_anchor', 'pf_anchor', t(M.firewall), 'fail', t(M.firewallOff(fw.error ?? (fw.loaded ? 'no rules' : 'not loaded'))))
    else add('pf_anchor', 'pf_anchor', t(M.firewall), 'ok', t(ML.firewallOkLinux(fw.rules, fw.proxyPort)))

    let st: LauncherStatus | null = null
    const sock = this.ctx.config.engine.launcherSock
    if (sock) {
      const r = await probeSocket(sock).catch(() => 'error' as const)
      if (r === 'ok') add('launcher', 'launcher', t(M.launcher), 'ok', t(M.launcherOk))
      else if (r === 'missing' || r === 'refused') add('launcher', 'launcher', t(M.launcher), 'fail', t(M.launcherNotRunning(L.label, null, L.unitDir)))
      else if (r === 'denied') add('launcher', 'launcher', t(M.launcher), 'fail', t(M.launcherDenied))
      else if (r === 'timeout') add('launcher', 'launcher', t(M.launcher), 'warn', t(M.launcherTimeout))
      else if (r !== 'too_long') add('launcher', 'launcher', t(M.launcher), 'fail', t(M.launcherDown))
      if (r === 'ok') st = await (this.o.launcherStatus ?? launcherStatus)(sock).catch(() => null)
    }
    const bad: CheckStatus = hosted ? 'fail' : 'warn'
    if (!st) add('sandbox', 'sandbox', t(M.sandbox), 'unknown', t(ML.sandboxUnknown))
    else if (st.sandbox !== 'bwrap' || st.seccomp === false) add('sandbox', 'sandbox', t(M.sandbox), 'fail', t(ML.sandboxNone(hosted)))
    else if (!st.landlockAbi) add('sandbox', 'sandbox', t(M.sandbox), bad, t(ML.kernelMissing(['Landlock'], hosted)))
    else if (st.scoped === false) add('sandbox', 'sandbox', t(M.sandbox), bad, t(ML.sandboxNotScoped(hosted)))
    else add('sandbox', 'sandbox', t(M.sandbox), 'ok', t(ML.sandboxLinuxOk(st.bwrapVersion ?? null, st.landlockAbi ?? null, true)))

    // kernel: Yama ptrace_scope >= 1, cgroup delegation (the launcher's report), unprivileged user namespaces (bwrap)
    const missing: string[] = []
    const ptrace = Number(this.readProcSys('kernel/yama/ptrace_scope') ?? 'NaN')
    if (!(ptrace >= 1)) missing.push('kernel.yama.ptrace_scope >= 1')
    if (st && st.cgroup !== undefined && st.cgroup !== 'delegated') missing.push('cgroup v2 delegation')
    const userns = this.readProcSys('user/max_user_namespaces')
    if (userns !== null && Number(userns) === 0) missing.push('user namespaces')
    if (missing.length) add('kernel_isolation', 'sandbox', t(ML.kernel), bad, t(ML.kernelMissing(missing, hosted)))
    else add('kernel_isolation', 'sandbox', t(ML.kernel), 'ok', t(ML.kernelOk))

    // safe operations 1A (only when the flag is on): what is missing, in words the administrator can act on
    const so = safeOpsReadiness(safeOpsEnabled())
    if (so.state === 'ready') add('safe_ops', 'sandbox', t(ML.safeOps), 'ok', t(ML.safeOpsReady(so.memory, so.pids, so.cpus)))
    else if (so.state === 'not_ready') add('safe_ops', 'sandbox', t(ML.safeOps), 'warn', t(ML.safeOpsNotReady(so.reason, so.detail, hosted)))

    const agentUid = this.ctx.config.engine.agentUid
    if (agentUid !== undefined) {
      const dir = this.o.atDir ?? '/etc'
      const files = [path.join(dir, 'cron.deny'), path.join(dir, 'at.deny')].filter((f) => fs.existsSync(f))
      if (!files.length) add('cron_deny', 'sandbox', t(M.cronDeny), 'ok', t(ML.cronAbsent))
      else {
        const name = Bun.spawnSync(['id', '-nu', String(agentUid)], { stdout: 'pipe', stderr: 'ignore' }).stdout.toString().trim()
        const listed = (f: string) => { try { return fs.readFileSync(f, 'utf8').split('\n').map((l) => l.trim()).includes(name) } catch { return false } }
        const ok = !!name && files.every(listed)
        add('cron_deny', 'sandbox', t(M.cronDeny), ok ? 'ok' : 'warn', t(ok ? M.cronDenyOk : M.cronDenyMissing))
      }
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
      checks: d.checks.map((x) => ({ id: x.id.slice(0, 64), status: x.status })).slice(0, 100),
      activity: activityFacts({ db: this.ctx.db, connections: this.ctx.services.realtime.openSockets?.() ?? 0, busy: d.queue.running + d.queue.queued > 0 }),
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

  /** Minutes after midnight (team time) the nightly backup may start: 03:00 as before; on the hosted cloud (or any install
   * with a plan file: many teams per host) the window ax-hostd gave this tenant (MYCEL_BACKUP_WINDOW_START_MIN, which
   * mycel-enroll writes to /etc/default/mycel from enroll.json: the host spreads its tenants), else 02:00 plus 0–179
   * minutes from the install id, so the teams on one host do not all compress their folders at the same moment. */
  backupStartMinute(env: Record<string, string | undefined> = process.env): number {
    if (!isHosted(this.ctx.config) && !currentPlan()) return 180
    const w = env.MYCEL_BACKUP_WINDOW_START_MIN
    if (w !== undefined && /^\d{1,4}$/.test(w.trim()) && Number(w) <= 1439) return Number(w)
    return 120 + (crypto.createHash('sha256').update(installId(this.ctx.db)).digest().readUInt16BE(0) % 180)
  }

  /** Nightly backup: once a day after the start time in the team's time zone (or any time when the last one is over
   * 30 h old). */
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
    const p = zonedParts(now, teamTimeZone(this.ctx.db))
    return p.h * 60 + p.min >= this.backupStartMinute() || age > 30 * 3600_000
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
    // storage: what uses the space 5 minutes after start, then hourly; the 80% notice is checked every 10 minutes
    const measure = () => this.storage.measure().catch((e) => log.warn('storage measurement failed', { err: e }))
    const firstMeasure = setTimeout(measure, 5 * 60_000)
    ;(firstMeasure as unknown as { unref?: () => void }).unref?.()
    this.timers.push(firstMeasure as unknown as ReturnType<typeof setInterval>)
    this.timers.push(setInterval(measure, 60 * 60_000))
    this.timers.push(setInterval(() => { try { this.storage.checkAlert() } catch (e) { log.warn('storage check failed', { err: e }) } }, 10 * 60_000))
    // Linux self-host: app-only releases from the feed, inside the team's update window (system/update-job.ts)
    if (this.autoUpdates) this.timers.push(setInterval(() => { void this.autoUpdateTick().catch((e) => log.warn('automatic update check failed', { err: e })) }, 60 * 60_000))
    // retention: old audit / tool / turn / token / job rows (system/retention.ts), hourly
    this.timers.push(setInterval(() => {
      try { const r = pruneOld(this.ctx.db); if (Object.values(r).some((n) => n > 0)) log.info('retention sweep', { ...r }) } catch (e) { log.warn('retention sweep failed', { err: e }) }
    }, 60 * 60_000))
    for (const t of this.timers) (t as unknown as { unref?: () => void }).unref?.()
  }

  stop() { for (const t of this.timers.splice(0)) clearInterval(t) }
}
