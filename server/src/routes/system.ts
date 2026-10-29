// Route module "system" — owner: component G (docs/WORKPLAN.md).
// Implements: SYSTEM (health, diagnostics, update, backups, restore, export, connection, storage, plan, notices).
// Contract: shared/src/api/system.ts. Health is implemented by the foundation (the dev server, CI smoke test and
// the menubar app need it from day one); G implements the rest. The work itself is in server/src/system/*.
import { API, type Health, type Locale } from '@mycel/shared/api'
import { PRODUCT, sourceCodeOffer } from '@mycel/shared'
import type { AppContext } from '../context'
import { SCHEMA_READER_LEVEL, schemaInfo } from '../db'
import { fail } from '../http/errors'
import { JobFailure } from '../jobs/service'
import type { JobService } from '../services'
import { BackupError } from '../system/backup'
import { connectInfo } from '../system/connect-info'
import { ConnectionChangeError, connectionStatus, modeOf, saveClaimCodeFor, saveConnectionMode } from '../system/connection'
import { runExport } from '../system/export'
import { redactorFor } from '../integrations/connections/redact'
import { LocalJobService } from '../system/job-runner'
import { enPlural, M, stepText, tr } from '../system/messages'
import { OpsService, type OpsOptions } from '../system/ops'
import { runUpdate } from '../system/update-job'
import type { RouteModule } from './module'
import { feature, isHosted } from '../system/deployment'
import { noticesFor, planStatus } from '../system/managed'
import { setApiEnginePublicOnly } from '../system/egress'

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

export const T = {
  devOnly: { ko: '업데이트는 설치된 서버에서만 할 수 있습니다(개발 모드).', en: 'Updates are only possible on an installed server (development mode).', id: 'Pembaruan hanya bisa di server yang terpasang (mode pengembangan).', ja: "更新できるのはインストール済みサーバーのみです（現在は開発モード）。", es: "Solo se puede actualizar un servidor instalado (actualmente en modo de desarrollo)." },
  noUpdate: { ko: '설치할 새 버전이 없습니다.', en: 'There is no new version to install.', id: 'Tidak ada versi baru untuk dipasang.', ja: "インストールする新しいバージョンはありません。", es: "No hay ninguna versión nueva para instalar." },
  noPrevious: { ko: '되돌릴 이전 버전이 없습니다.', en: 'There is no previous version to go back to.', id: 'Tidak ada versi sebelumnya.', ja: "戻せる以前のバージョンはありません。", es: "No hay una versión anterior a la que volver." },
  busy: { ko: '이미 진행 중인 작업이 있습니다.', en: 'Another operation is already running.', id: 'Operasi lain sedang berjalan.', ja: "別の操作がすでに実行中です。", es: "Ya hay otra operación en curso." },
  waitingTurns: (n: number) => ({ ko: `진행 중인 답변 ${n}개가 끝나기를 기다리는 중`, en: `Waiting for ${enPlural(n, 'running answer', 'running answers')} to finish`, id: `Menunggu ${n} jawaban selesai`, ja: `${String(n) + "件の実行中の回答"}の完了を待機中`, es: `Esperando a que termine ${enPlural(n, "respuesta en curso", "respuestas en curso")}` }),
  restartNeeded: { ko: '복원할 데이터를 준비했습니다. 서버를 다시 시작하면 적용됩니다.', en: 'The restore is prepared and applies when the server restarts.', id: 'Pemulihan disiapkan dan berlaku saat server dimulai ulang.', ja: "復元の準備ができました。サーバーの再起動時に適用されます。", es: "La restauración está preparada y se aplicará al reiniciar el servidor." },
  restarting: { ko: '서버를 다시 시작합니다.', en: 'Restarting the server.', id: 'Memulai ulang server.', ja: "サーバーを再起動中です。", es: "Reiniciando el servidor." },
  afterRestart: { ko: '서버를 다시 시작한 뒤 적용됩니다.', en: 'Applies after the server restarts.', id: 'Berlaku setelah server dimulai ulang.', ja: "サーバーの再起動後に適用されます。", es: "Se aplica después de reiniciar el servidor." },
  officeMode: { ko: '사무실 모드는 사무실 네트워크로만 접속합니다. 연결 방식은 바꿀 수 없습니다(docs/OFFICE.md).', en: 'Office mode connects over the office network only; the connection mode cannot be changed (docs/OFFICE.md).', id: 'Mode kantor hanya terhubung lewat jaringan kantor; mode koneksi tidak bisa diubah (docs/OFFICE.md).', ja: "オフィスモードは社内ネットワークからのみ接続するため、接続モードは変更できません（docs/OFFICE.md）。", es: "El modo oficina solo se conecta por la red interna; no se puede cambiar el modo de conexión (docs/OFFICE.md)." },
  unsupportedMode: { ko: '이 연결 방식은 이번 버전에서 아직 쓸 수 없습니다.', en: 'This connection mode is not available in this version yet.', id: 'Mode koneksi ini belum tersedia di versi ini.', ja: "この接続モードは、このバージョンではまだ利用できません。", es: "Este modo de conexión aún no está disponible en esta versión." },
  noConfigFile: { ko: '개발 모드 서버는 설정 파일 없이 실행 중이라 연결 방식을 바꿀 수 없습니다(.dev/server.json의 relay.url).', en: 'This development server runs without a config file, so the connection mode cannot be changed here (relay.url in .dev/server.json).', id: 'Server pengembangan ini berjalan tanpa berkas konfigurasi, jadi mode koneksi tidak bisa diubah di sini (relay.url di .dev/server.json).', ja: "この開発サーバーは設定ファイルなしで動作しているため、ここでは接続モードを変更できません（.dev/server.jsonのrelay.url）。", es: "Este servidor de desarrollo funciona sin archivo de configuración, por lo que no se puede cambiar aquí el modo de conexión (relay.url en .dev/server.json)." },
  relayUnavailable: { ko: `${PRODUCT.displayName} 중계 서버는 아직 운영되지 않아 고를 수 없습니다. 자체 중계 서버나 사무실 안 연결을 쓰세요.`, en: `The ${PRODUCT.displayName} relay is not running yet, so it cannot be chosen. Use your own relay server or the office network only.`, id: `Relay ${PRODUCT.displayName} belum berjalan, jadi belum bisa dipilih. Gunakan server relay sendiri atau jaringan kantor saja.`, ja: `${PRODUCT.displayName}の中継サービスはまだ稼働していないため選択できません。独自の中継サーバーか、社内ネットワークのみを使用してください。`, es: `El servicio de retransmisión de ${PRODUCT.displayName} aún no está activo y no se puede elegir. Use su propio servidor de retransmisión o solo la red interna.` },
  teamNameMissing: { ko: '중계 서버에 등록할 팀 이름을 입력해 주세요(영문 소문자·숫자·하이픈).', en: 'Enter the team name to register at the relay (lowercase letters, digits and hyphens).', id: 'Masukkan nama tim untuk didaftarkan di relay (huruf kecil, angka, dan tanda hubung).', ja: "中継サーバーに登録するチーム名を入力してください（小文字の英字、数字、ハイフン）。", es: "Introduzca el nombre del equipo que registrará en el servidor de retransmisión (letras minúsculas, números y guiones)." },
  badRelayUrl: { ko: '자체 중계 서버 주소는 wss://로 시작하는 주소여야 합니다.', en: 'The self-hosted relay address must be a wss:// address.', id: 'Alamat relay sendiri harus berupa alamat wss://.', ja: "独自の中継サーバーのアドレスはwss://で始まる必要があります。", es: "La dirección del servidor de retransmisión propio debe empezar por wss://." },
  // the hosted cloud (server/src/system/deployment.ts): the operator owns server.json, the relay registration and the updates
  cloudConnection: { ko: `${PRODUCT.displayName} Cloud에서는 연결 방식을 바꿀 수 없습니다. 팀 주소는 호스팅 운영자가 관리합니다.`, en: `The connection cannot be changed on ${PRODUCT.displayName} Cloud. The hosting provider manages the team address.`, id: `Koneksi tidak bisa diubah di ${PRODUCT.displayName} Cloud. pengelola layanan mengelola alamat tim.`, ja: `${PRODUCT.displayName} Cloudでは接続を変更できません。チームアドレスはホスティング事業者が管理します。`, es: `No se puede cambiar la conexión en ${PRODUCT.displayName} Cloud. El proveedor de alojamiento administra la dirección del equipo.` },
  needsRoot: { ko: '이 업데이트는 서버의 관리자 권한이 필요합니다. 서버에서 `sudo mycel-ctl update`를 실행해 주세요(docs/INSTALL-LINUX.md).', en: 'This update needs administrator rights on the server. Run `sudo mycel-ctl update` there (docs/INSTALL-LINUX.md).', id: 'Pembaruan ini memerlukan hak administrator di server. Jalankan `sudo mycel-ctl update` di sana (docs/INSTALL-LINUX.md).', ja: "この更新にはサーバーの管理者権限が必要です。サーバーで`sudo mycel-ctl update`を実行してください（docs/INSTALL-LINUX.md）。", es: "Esta actualización requiere permisos de administrador en el servidor. Ejecute allí `sudo mycel-ctl update` (docs/INSTALL-LINUX.md)." },
  cloudUpdate: { ko: `${PRODUCT.displayName} Cloud의 업데이트와 되돌리기는 호스팅 운영자가 점검 시간에 합니다.`, en: `On ${PRODUCT.displayName} Cloud, the hosting provider installs updates (and rolls them back) during the maintenance window.`, id: `Di ${PRODUCT.displayName} Cloud, pengelola layanan memasang pembaruan (dan mengembalikannya) saat jendela pemeliharaan.`, ja: `${PRODUCT.displayName} Cloudでは、ホスティング事業者がメンテナンス時間帯に更新とロールバックを行います。`, es: `En ${PRODUCT.displayName} Cloud, el proveedor de alojamiento instala actualizaciones y revierte versiones durante el horario de mantenimiento.` },
}

export const systemRoutes: RouteModule = {
  name: 'system',
  owner: 'G',
  init(ctx) {
    // the team API engine's calls: public https only on the hosted cloud (system/egress.ts; one team per process)
    setApiEnginePublicOnly(!feature(ctx.config, 'apiEngineAnyUrl'))
    const ops = new OpsService(ctx, systemTestHooks.opsOptions ?? {})
    opsByCtx.set(ctx, ops)
    ops.start()
    ctx.onClose(() => ops.stop())
  },
  register(kit, ctx) {
    const ops = () => opsByCtx.get(ctx)!
    let fallbackJobs: LocalJobService | null = null
    const jobs = (): JobService => ctx.services.jobs ?? (fallbackJobs ??= new LocalJobService(ctx))
    /** one maintenance operation (backup / restore / update / export) at a time; the lock is the ops service's, which
     * the automatic update (Linux self-host) takes too */
    const exclusive = (name: string, locale: Locale, fn: () => string): string => {
      if (!ops().tryLock(name)) fail('busy', tr(locale, T.busy))
      try { return fn() } catch (e) { ops().unlock(); throw e }
    }
    const release = () => { ops().unlock() }

    kit.handle(API.health, ({ c, auth }): Health => {
      let dbOk = true
      let applied = 0
      try { applied = schemaInfo(ctx.db).maxVersion } catch { dbOk = false }
      // the office internet address, signed out: liveness only, no build fingerprint (attack review finding 1)
      if (c.get('info').tunnel && !auth) return { ok: dbOk, time: new Date().toISOString() }
      return {
        ok: dbOk,
        version: ctx.version,
        sourceCode: sourceCodeOffer(ctx.version, ctx.config.sourceCode),
        schema: { applied, readerLevel: SCHEMA_READER_LEVEL },
        uptimeSec: Math.round((Date.now() - ctx.startedAt) / 1000),
        time: new Date().toISOString(),
      }
    })

    kit.handle(API.diagnostics, ({ c }) => ops().diagnostics(c.get('locale')))

    kit.handle(API.storage, () => ops().storage.status())

    // the plan (plan.json) and the operator's notices (notices.json): system/limits.ts, system/managed.ts
    kit.handle(API.plan, ({ c }) => planStatus(ctx.db, c.get('locale')))
    kit.handle(API.managedNotices, ({ c, auth }) => ({ items: noticesFor(auth.user.role, c.get('locale')) }))

    kit.handle(API.updateStatus, () => {
      const u = ops().updates
      const last = u.status().lastCheckedAt
      if (u.installed && u.feedUsable && (!last || Date.now() - Date.parse(last) > 24 * 3600_000)) void u.checkFeed()
      return { ...u.status(), auto: ops().autoUpdates, managed: !feature(ctx.config, 'selfUpdate') }
    })

    kit.handle(API.startUpdate, ({ c, body, auth }) => {
      const locale = c.get('locale')
      if (!feature(ctx.config, 'selfUpdate')) fail('conflict', tr(locale, T.cloudUpdate))
      const u = ops().updates
      if (!u.installed) fail('conflict', tr(locale, T.devOnly))
      const st = u.status()
      const target = body.rollback ? st.previous : body.version ?? st.available?.version ?? null
      if (!target) fail('conflict', tr(locale, body.rollback ? T.noPrevious : T.noUpdate))
      const staged = u.stagedVersions().includes(target!)
      // a release that also changes root-owned parts is installed by `sudo mycel-ctl update` (Linux), not from here
      if (!staged && !body.rollback && u.status().needsRoot) fail('conflict', tr(locale, T.needsRoot))
      const jobId = exclusive('update', locale, () => jobs().start({
        kind: 'update', userId: auth.user.id,
        run: async (h) => {
          try {
            return await runUpdate({ updates: u, backups: ops().backups, running: () => ops().queue().running, restart: (why) => scheduleRestart(ctx, why), locale, progress: (p, m) => h.progress(p, m) },
              target!, { staged, rollback: !!body.rollback })
          } finally { release() }
        },
      }))
      return { jobId }
    })

    kit.handle(API.listBackups, () => ({ items: ops().backups.list() }))

    kit.handle(API.startBackup, ({ c, body, auth }) => {
      const locale = c.get('locale')
      const jobId = exclusive('backup', locale, () => jobs().start({
        kind: 'backup', userId: auth.user.id,
        run: async (h) => {
          try {
            const m = await ops().backups.run({ kind: 'manual', scope: body.scope, progress: (p, msg) => h.progress(p, stepText(locale, msg)) })
            return { backupId: m.id, size: m.db.size + (m.team?.archiveSize ?? 0), createdAt: m.createdAt }
          } catch (e) {
            // the owner can do something about a full disk; anything else is told as a failed backup, not "server error"
            if (e instanceof BackupError) throw new JobFailure('unavailable', e.reason === 'disk_space' ? M.backupNoSpace : M.backupFailed(e.message))
            throw e
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
            h.progress(0.1, stepText(locale, 'check'))
            const p = await ops().backups.stageDbRestore(body.backupId, auth.user.id)
            const lostSince = ops().backups.createdAtOf(body.backupId)
            ctx.log.info('restore staged', { backupId: p.backupId, by: auth.user.id })
            if (ops().layout.appDir) { h.progress(1, tr(locale, T.restarting)); scheduleRestart(ctx, 'restore') }
            else h.progress(1, tr(locale, T.restartNeeded))
            return { backupId: p.backupId, restoredAt: p.requestedAt, lostSince }
          } catch (e) {
            if (e instanceof BackupError) fail('conflict', tr(locale, M.restoreFailed(e.message)))
            throw e
          } finally { release() }
        },
      }))
      return { jobId }
    })

    kit.handle(API.startExport, ({ c, body, auth }) => {
      const locale = c.get('locale')
      const jobId = exclusive('export', locale, () => jobs().start({
        kind: 'export', userId: auth.user.id,
        run: async (h) => {
          try { return await runExport(ctx.db, ctx.config.teamRoot, { ownerId: auth.user.id, locale, what: body.what, password: body.password, hide: redactorFor(ctx, auth.user.id).hide }, (p, m) => h.progress(p, stepText(locale, m))) } finally { release() }
        },
      }))
      return { jobId }
    })

    kit.handle(API.connection, () => connectionStatus(ctx))

    kit.handle(API.connectInfo, () => connectInfo(ctx))

    kit.handle(API.lanFailure, ({ body, auth }) => {
      if (ops().recordLanFailure(auth.session.id, body.code)) ctx.log.warn('office direct connection failed (desktop app report)', { code: body.code, user: auth.user.id })
    })

    kit.handle(API.updateConnection, ({ c, body }) => {
      const locale = c.get('locale')
      if (isHosted(ctx.config)) fail('conflict', tr(locale, T.cloudConnection))
      // office mode: server.json is rewritten by its supervisor at every start, and no relay is part of it
      if (ctx.config.office) fail('conflict', tr(locale, T.officeMode))
      try {
        const url = saveConnectionMode(ctx.config.configFile, body.mode, { relayUrl: body.relayUrl, teamName: body.teamName, officialAvailable: !!ctx.config.relay.officialAvailable })
        // a claim code (official relay add-on) is kept next to the team key until the registration at the next start
        // uses it (never in server.json, never logged)
        if (url && body.claimCode) saveClaimCodeFor(ctx.config.dataDir, url, body.teamName ?? ctx.config.relay.teamName ?? '', body.claimCode)
        ctx.log.info('connection mode changed', { mode: body.mode, teamName: body.teamName ?? null, claimCode: !!body.claimCode })
        const now = connectionStatus(ctx)
        if (ops().layout.appDir) scheduleRestart(ctx, 'connection change')
        return { ...now, mode: modeOf(url), state: url ? ('connecting' as const) : ('disabled' as const), detail: tr(locale, T.afterRestart), teamName: body.teamName ?? now.teamName ?? null }
      } catch (e) {
        if (e instanceof ConnectionChangeError) {
          if (e.code === 'unsupported') fail('conflict', tr(locale, body.mode === 'relay' ? T.relayUnavailable : T.unsupportedMode))
          if (e.code === 'team_name_missing') fail('validation', tr(locale, T.teamNameMissing), { fields: { 'body.teamName': 'required' } })
          fail(e.code === 'no_config' ? 'conflict' : 'validation', tr(locale, e.code === 'no_config' ? T.noConfigFile : T.badRelayUrl))
        }
        throw e
      }
    })
  },
}
