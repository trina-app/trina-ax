// Route module "system" — owner: component G (docs/WORKPLAN.md).
// Implements: SYSTEM (health, diagnostics, update, backups, restore, export, connection).
// Contract: shared/src/api/system.ts. Health is implemented by the foundation (the dev server, CI smoke test and
// the menubar app need it from day one); G implements the rest. The work itself is in server/src/system/*.
import { API, type Health, type Locale } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { SCHEMA_READER_LEVEL, schemaInfo } from '../db'
import { fail } from '../http/errors'
import type { JobService } from '../services'
import { BackupError } from '../system/backup'
import { ConnectionChangeError, connectionStatus, modeOf, saveConnectionMode } from '../system/connection'
import { runExport } from '../system/export'
import { LocalJobService } from '../system/job-runner'
import { tr } from '../system/messages'
import { OpsService, type OpsOptions } from '../system/ops'
import { UpdateError } from '../system/update'
import type { RouteModule } from './module'

const opsByCtx = new WeakMap<AppContext, OpsService>()
/** The ops service of a running server (tests, CLI). */
export const getOps = (ctx: AppContext) => opsByCtx.get(ctx) ?? null

/** Test hook: options for the next OpsService (layout, fake engines, restart). */
export const systemTestHooks: { opsOptions: OpsOptions | null; restart: (() => void) | null } = { opsOptions: null, restart: null }

/** Planned restart: main.ts shuts down gracefully on SIGTERM; root/bootstrap starts app/current again. */
function scheduleRestart(ctx: AppContext, why: string) {
  if (systemTestHooks.restart) { systemTestHooks.restart(); return }
  ctx.log.info('restarting for ' + why)
  setTimeout(() => process.kill(process.pid, 'SIGTERM'), 1500)
}

const T = {
  devOnly: { ko: '업데이트는 설치된 서버에서만 할 수 있습니다(개발 모드).', en: 'Updates are only possible on an installed server (development mode).', id: 'Pembaruan hanya bisa di server yang terpasang (mode pengembangan).' },
  noUpdate: { ko: '설치할 새 버전이 없습니다.', en: 'There is no new version to install.', id: 'Tidak ada versi baru untuk dipasang.' },
  noPrevious: { ko: '되돌릴 이전 버전이 없습니다.', en: 'There is no previous version to go back to.', id: 'Tidak ada versi sebelumnya.' },
  busy: { ko: '이미 진행 중인 작업이 있습니다.', en: 'Another operation is already running.', id: 'Operasi lain sedang berjalan.' },
  waitingTurns: (n: number) => ({ ko: `진행 중인 답변 ${n}개가 끝나기를 기다리는 중`, en: `Waiting for ${n} running answers to finish`, id: `Menunggu ${n} jawaban selesai` }),
  restartNeeded: { ko: '복원할 데이터를 준비했습니다. 서버를 다시 시작하면 적용됩니다.', en: 'The restore is prepared and applies when the server restarts.', id: 'Pemulihan disiapkan dan berlaku saat server dimulai ulang.' },
  restarting: { ko: '서버를 다시 시작합니다.', en: 'Restarting the server.', id: 'Memulai ulang server.' },
  afterRestart: { ko: '서버를 다시 시작한 뒤 적용됩니다.', en: 'Applies after the server restarts.', id: 'Berlaku setelah server dimulai ulang.' },
  unsupportedMode: { ko: '이 연결 방식은 이번 버전에서 아직 쓸 수 없습니다.', en: 'This connection mode is not available in this version yet.', id: 'Mode koneksi ini belum tersedia di versi ini.' },
  noConfigFile: { ko: '개발 모드 서버는 설정 파일 없이 실행 중이라 연결 방식을 바꿀 수 없습니다(.dev/server.json의 relay.url).', en: 'This development server runs without a config file, so the connection mode cannot be changed here (relay.url in .dev/server.json).', id: 'Server pengembangan ini berjalan tanpa berkas konfigurasi, jadi mode koneksi tidak bisa diubah di sini (relay.url di .dev/server.json).' },
  badRelayUrl: { ko: '자체 중계 서버 주소는 wss://로 시작하는 주소여야 합니다.', en: 'The self-hosted relay address must be a wss:// address.', id: 'Alamat relay sendiri harus berupa alamat wss://.' },
}

export const systemRoutes: RouteModule = {
  name: 'system',
  owner: 'G',
  init(ctx) {
    const ops = new OpsService(ctx, systemTestHooks.opsOptions ?? {})
    opsByCtx.set(ctx, ops)
    ops.start()
    ctx.onClose(() => ops.stop())
  },
  register(kit, ctx) {
    const ops = () => opsByCtx.get(ctx)!
    let fallbackJobs: LocalJobService | null = null
    let busy: string | null = null
    const jobs = (): JobService => ctx.services.jobs ?? (fallbackJobs ??= new LocalJobService(ctx))
    /** one maintenance operation (backup / restore / update / export) at a time */
    const exclusive = (name: string, locale: Locale, fn: () => string): string => {
      if (busy) fail('busy', tr(locale, T.busy))
      busy = name
      try { return fn() } catch (e) { busy = null; throw e }
    }
    const release = () => { busy = null }

    kit.handle(API.health, (): Health => {
      let dbOk = true
      let applied = 0
      try { applied = schemaInfo(ctx.db).maxVersion } catch { dbOk = false }
      return {
        ok: dbOk,
        version: ctx.version,
        schema: { applied, readerLevel: SCHEMA_READER_LEVEL },
        uptimeSec: Math.round((Date.now() - ctx.startedAt) / 1000),
        time: new Date().toISOString(),
      }
    })

    kit.handle(API.diagnostics, ({ c }) => ops().diagnostics(c.get('locale')))

    kit.handle(API.updateStatus, () => {
      const u = ops().updates
      const last = u.status().lastCheckedAt
      if (u.installed && ctx.config.update.feedUrl && (!last || Date.now() - Date.parse(last) > 24 * 3600_000)) void u.checkFeed()
      return u.status()
    })

    kit.handle(API.startUpdate, ({ c, body, auth }) => {
      const locale = c.get('locale')
      const u = ops().updates
      if (!u.installed) fail('conflict', tr(locale, T.devOnly))
      const st = u.status()
      const target = body.rollback ? st.previous : body.version ?? st.available?.version ?? null
      if (!target) fail('conflict', tr(locale, body.rollback ? T.noPrevious : T.noUpdate))
      const staged = u.stagedVersions().includes(target!)
      const jobId = exclusive('update', locale, () => jobs().start({
        kind: 'update', userId: auth.user.id,
        run: async (h) => {
          try {
            // 1) let running answers finish (tab 6: up to 10 minutes; what is still running then is interrupted)
            const deadline = Date.now() + 10 * 60_000
            for (let q = ops().queue(); q.running > 0 && Date.now() < deadline; q = ops().queue()) {
              h.progress(null, tr(locale, T.waitingTurns(q.running)))
              await Bun.sleep(2000)
            }
            // 2) DB backup (an update never rolls the DB back by itself)
            h.progress(0.2, 'backup')
            await ops().backups.run({ kind: 'pre-update', scope: 'db' })
            // 3) bring the version in
            if (!staged) {
              h.progress(0.3, 'download')
              const feed = await u.checkFeed()
              if (!feed || feed.version !== target) throw new UpdateError(`version ${target} is not available`)
              await u.download(feed, (f) => h.progress(0.3 + 0.5 * f, 'download'))
            }
            // 4) switch and restart; the bootstrap health-checks and rolls back on failure
            h.progress(0.9, 'switch')
            const r = await u.switchTo(target!)
            h.progress(1, tr(locale, T.restarting))
            scheduleRestart(ctx, `update to ${target}`)
            return { fromVersion: r.from, toVersion: r.to, rolledBack: !!body.rollback }
          } finally { release() }
        },
      }))
      return { jobId }
    })

    kit.handle(API.listBackups, () => ({ items: ops().backups.list() }))

    kit.handle(API.startBackup, ({ c, body, auth }) => {
      const jobId = exclusive('backup', c.get('locale'), () => jobs().start({
        kind: 'backup', userId: auth.user.id,
        run: async (h) => {
          try {
            const m = await ops().backups.run({ kind: 'manual', scope: body.scope, progress: (p, msg) => h.progress(p, msg) })
            return { backupId: m.id, size: m.db.size + (m.team?.archiveSize ?? 0), createdAt: m.createdAt }
          } finally { release() }
        },
      }))
      return { jobId }
    })

    kit.handle(API.startRestore, ({ c, body, auth }) => {
      const locale = c.get('locale')
      if (!ops().backups.dbFileOf(body.backupId)) fail('not_found')
      const jobId = exclusive('restore', locale, () => jobs().start({
        kind: 'restore', userId: auth.user.id,
        run: async (h) => {
          try {
            h.progress(0.1, 'check')
            const p = await ops().backups.stageDbRestore(body.backupId, auth.user.id)
            const lostSince = ops().backups.createdAtOf(body.backupId)
            ctx.log.info('restore staged', { backupId: p.backupId, by: auth.user.id })
            if (ops().layout.appDir) { h.progress(1, tr(locale, T.restarting)); scheduleRestart(ctx, 'restore') }
            else h.progress(1, tr(locale, T.restartNeeded))
            return { backupId: p.backupId, restoredAt: p.requestedAt, lostSince }
          } catch (e) {
            if (e instanceof BackupError) fail('conflict', e.message)
            throw e
          } finally { release() }
        },
      }))
      return { jobId }
    })

    kit.handle(API.startExport, ({ c, body, auth }) => {
      const jobId = exclusive('export', c.get('locale'), () => jobs().start({
        kind: 'export', userId: auth.user.id,
        run: async (h) => {
          try { return await runExport(ctx.db, ctx.config.teamRoot, { ownerId: auth.user.id, what: body.what, password: body.password }, (p, m) => h.progress(p, m)) } finally { release() }
        },
      }))
      return { jobId }
    })

    kit.handle(API.connection, () => connectionStatus(ctx))

    kit.handle(API.updateConnection, ({ c, body }) => {
      const locale = c.get('locale')
      try {
        const url = saveConnectionMode(ctx.config.configFile, body.mode, body.relayUrl)
        ctx.log.info('connection mode changed', { mode: body.mode })
        const now = connectionStatus(ctx)
        if (ops().layout.appDir) scheduleRestart(ctx, 'connection change')
        return { ...now, mode: modeOf(url), state: url ? ('connecting' as const) : ('disabled' as const), detail: tr(locale, T.afterRestart) }
      } catch (e) {
        if (e instanceof ConnectionChangeError) {
          if (e.code === 'unsupported') fail('conflict', tr(locale, T.unsupportedMode))
          fail(e.code === 'no_config' ? 'conflict' : 'validation', tr(locale, e.code === 'no_config' ? T.noConfigFile : T.badRelayUrl))
        }
        throw e
      }
    })
  },
}
