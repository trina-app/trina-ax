// Restart from Admin › System › Health (docs/decisions/20261127-restart.md). Component G.
// - What: 'ai' restarts the engine launcher (native.ts launcherRestart: running answers end with the restart message and
//   Try again, queued ones wait for the next launcher, chat/runtime.ts launcherHold); 'server' stops this server, whose
//   supervisor starts it again (the bootstrap: MYCEL_SUPERVISOR_PID; office mode: office.js run). Each is offered only
//   where it comes back by itself.
// - When: 'idle' waits for the running answers, at most RESTART_WAIT_MS; meanwhile the update-wait mark (kind
//   'restart') holds scheduled runs back, the ops lock refuses other maintenance with its own words, and the restart can
//   go at once (the owner, with the password again) or be called off (the owner, or the admin who asked for it). 'now'
//   (the owner only) goes at once.
// - Refused: the ops lock is taken, an update waits or runs (this server's, root's, office's), a restore is prepared,
//   state.json pending / forward is this version (the update is still checked: an exit counts towards a roll-back),
//   app/current is another version, or the limit (accepted requests in the audit log, every kind together: 5 an hour,
//   2 minutes apart; refusals and the watchdog's restarts are not in it).
// - Audit: system.restart_requested {what, when}, system.restart_now {what} (the owner made a waiting one go at once),
//   system.restart_cancelled {what} (called off; {what, reason} when an update or restore came during the wait),
//   system.restarted {what} (a server restart: at the next start, from data/restart.json).
import fs from 'node:fs'
import path from 'node:path'
import type { Locale, RestartStatus, RestartWhat } from '@mycel/shared/api'
import { PRODUCT } from '@mycel/shared'
import type { AppContext } from '../context'
import { audit } from '../admin/audit'
import { launcherSockOf } from '../chat/forget'
import { launcherRestart, launcherStatus } from '../native'
import { readLiveness } from '../office/watchdog'
import { enPlural, tr } from './messages'
import type { OpsService } from './ops'
import { updateUnderway } from './update-underway'
import { beginUpdateWait, endUpdateWait, updateWaitEndsBy, updateWaitingFor } from './update-wait'

/** the longest a restart waits for running answers (the hosted reboot's idle wait, mycel-ctl idle-wait --max 600) */
export const RESTART_WAIT_MS = 10 * 60_000
/** accepted restart requests per hour, and the least time between two */
export const RESTART_PER_HOUR = 5
export const RESTART_GAP_MS = 2 * 60_000
/** the status shows the last restart this long */
const LAST_FOR_MS = 24 * 3600_000

type T6 = { ko: string; en: string; id: string; ja: string; es: string; zh: string }
const P = PRODUCT.displayName

export const RT = {
  notOffered: { ko: '이 서버에서는 이 방법으로 다시 시작할 수 없어요.', en: 'This server cannot restart this way.', id: 'Server ini tidak bisa dimulai ulang dengan cara ini.', ja: 'このサーバーはこの方法では再起動できません。', es: 'Este servidor no se puede reiniciar de esta forma.', zh: '这台服务器无法用这种方式重启。' },
  ownerOnlyNow: { ko: '지금 바로 다시 시작하는 건 소유자만 할 수 있어요. 답변이 끝난 뒤 다시 시작해 주세요.', en: 'Only the owner can restart right away. Choose to restart when answers finish.', id: 'Hanya pemilik yang bisa memulai ulang sekarang juga. Pilih mulai ulang setelah jawaban selesai.', ja: 'すぐに再起動できるのはオーナーだけです。回答が終わってから再起動を選んでください。', es: 'Solo el propietario puede reiniciar de inmediato. Elija reiniciar cuando terminen las respuestas.', zh: '只有所有者可以立即重启。请选择在回答结束后重启。' },
  busy: { ko: '다른 관리 작업(백업, 복원, 업데이트 등)이 진행 중이에요. 끝난 뒤 다시 해 주세요.', en: 'Another maintenance task (a backup, restore or update) is running. Try again when it is done.', id: 'Tugas pemeliharaan lain (cadangan, pemulihan, atau pembaruan) sedang berjalan. Coba lagi setelah selesai.', ja: '別のメンテナンス作業（バックアップ、復元、更新など）が実行中です。終わってからもう一度お試しください。', es: 'Hay otra tarea de mantenimiento en curso (una copia, una restauración o una actualización). Vuelva a intentarlo cuando termine.', zh: '另一项维护任务（备份、恢复或更新）正在进行。完成后再试。' },
  waitingAlready: { ko: '이미 다시 시작을 기다리고 있어요.', en: 'A restart is already waiting.', id: 'Mulai ulang sudah menunggu.', ja: '再起動はすでに待機中です。', es: 'Ya hay un reinicio en espera.', zh: '已有一个重启正在等待。' },
  updating: { ko: '업데이트가 진행 중이에요. 업데이트가 끝나면 서버가 알아서 다시 시작해요.', en: 'An update is under way. The server restarts by itself when it is done.', id: 'Pembaruan sedang berjalan. Server dimulai ulang sendiri setelah selesai.', ja: '更新中です。更新が終わるとサーバーは自動で再起動します。', es: 'Hay una actualización en curso. El servidor se reinicia solo cuando termina.', zh: '正在更新。更新完成后服务器会自动重启。' },
  checkingUpdate: { ko: '방금 설치한 업데이트를 확인하는 중이에요. 잠시 뒤에 다시 해 주세요.', en: 'The update just installed is still being checked. Try again in a moment.', id: 'Pembaruan yang baru dipasang masih diperiksa. Coba lagi sebentar lagi.', ja: 'インストールしたばかりの更新を確認中です。しばらくしてからもう一度お試しください。', es: 'La actualización recién instalada todavía se está comprobando. Vuelva a intentarlo en un momento.', zh: '刚安装的更新仍在检查中。请稍后再试。' },
  restorePrepared: { ko: '복원할 백업이 준비되어 있어요. 다시 시작하면 복원이 적용돼요. 복원하려면 백업 화면에서 진행해 주세요.', en: 'A restore is prepared and a restart would apply it. To restore, go on from Backups.', id: 'Pemulihan sudah disiapkan dan mulai ulang akan menerapkannya. Untuk memulihkan, lanjutkan dari Cadangan.', ja: '復元の準備ができており、再起動すると復元が適用されます。復元する場合はバックアップから進めてください。', es: 'Hay una restauración preparada y un reinicio la aplicaría. Para restaurar, continúe desde Copias de seguridad.', zh: '已有准备好的恢复，重启会应用它。如需恢复，请从“备份”继续。' },
  tooSoon: { ko: '방금 다시 시작했어요. 잠시 뒤에 다시 해 주세요.', en: 'It was just restarted. Try again in a little while.', id: 'Baru saja dimulai ulang. Coba lagi sebentar lagi.', ja: '再起動したばかりです。少し待ってからもう一度お試しください。', es: 'Se acaba de reiniciar. Vuelva a intentarlo dentro de un rato.', zh: '刚刚重启过。请稍后再试。' },
  tooMany: { ko: '지난 한 시간 동안 여러 번 다시 시작했어요. 조금 뒤에 다시 해 주세요.', en: 'It was restarted several times in the last hour. Try again a little later.', id: 'Sudah dimulai ulang beberapa kali dalam satu jam terakhir. Coba lagi nanti.', ja: 'この1時間で何度も再起動しています。少し時間をおいてからもう一度お試しください。', es: 'Se reinició varias veces en la última hora. Vuelva a intentarlo un poco más tarde.', zh: '过去一小时内已重启多次。请稍后再试。' },
  notYours: { ko: '다른 사람이 요청한 다시 시작은 소유자만 그만둘 수 있어요.', en: 'Only the owner can call off a restart someone else asked for.', id: 'Hanya pemilik yang bisa membatalkan mulai ulang yang diminta orang lain.', ja: '他の人が依頼した再起動を取りやめられるのはオーナーだけです。', es: 'Solo el propietario puede cancelar un reinicio que pidió otra persona.', zh: '只有所有者可以取消别人请求的重启。' },
  nothingWaits: { ko: '기다리는 다시 시작이 없어요.', en: 'No restart is waiting.', id: 'Tidak ada mulai ulang yang menunggu.', ja: '待機中の再起動はありません。', es: 'No hay ningún reinicio en espera.', zh: '没有正在等待的重启。' },
  /** the update-wait mark's line while a restart waits (Admin › System › Updates says it in its own words too) */
  waitingAnswers: (n: number): T6 => ({ ko: `진행 중인 답변 ${n}개가 끝나면 다시 시작해요`, en: `Restarting when ${enPlural(n, 'running answer finishes', 'running answers finish')}`, id: `Dimulai ulang setelah ${n} jawaban yang berjalan selesai`, ja: `実行中の回答${n}件が終わったら再起動します`, es: `Se reiniciará cuando ${n === 1 ? 'termine 1 respuesta en curso' : `terminen ${n} respuestas en curso`}`, zh: `${n}个进行中的回答结束后重启` }),
  /** the ops lock's words while a restart waits: a backup or update asked meanwhile */
  busyRestart: { ko: `${P}를 다시 시작하려고 답변이 끝나기를 기다리는 중이에요. 다시 시작한 뒤에 해 주세요.`, en: `${P} is waiting for answers to finish so it can restart. Try again after the restart.`, id: `${P} menunggu jawaban selesai untuk dimulai ulang. Coba lagi setelah dimulai ulang.`, ja: `${P}は再起動のため回答が終わるのを待っています。再起動の後でもう一度お試しください。`, es: `${P} espera a que terminen las respuestas para reiniciarse. Vuelva a intentarlo después del reinicio.`, zh: `${P}正在等待回答结束以便重启。请在重启后再试。` },
} satisfies Record<string, T6 | ((n: number) => T6)>

export class RestartRefused extends Error {
  constructor(readonly code: 'conflict' | 'forbidden' | 'busy' | 'rate_limited', readonly words: T6) { super(words.en); this.name = 'RestartRefused' }
}

export interface RestartDeps {
  ctx: AppContext
  ops: () => OpsService
  /** stops this server for its supervisor to start again (routes/system.ts scheduleRestart) */
  restartServer: (why: string) => void
  /** environment (tests): MYCEL_SUPERVISOR_PID */
  env?: Record<string, string | undefined>
  sleep?: (ms: number) => Promise<void>
  waitMs?: number
  /** the launcher (tests replace it) */
  launcher?: {
    status: (sock: string) => Promise<{ ops?: string[]; stopping?: string } | null>
    restart: (sock: string) => Promise<{ live: number } | null>
  }
}

interface Waiting { what: RestartWhat; by: string; since: number; until: number; skip: boolean; cancel: boolean; done: Promise<void>
  /** the wait is over and the restart goes: it can no longer be called off */
  going: boolean }

const iso = (ms: number) => new Date(ms).toISOString()
const MARK = 'restart.json'

export class RestartService {
  private waiting: Waiting | null = null
  private failedAt: { what: RestartWhat; at: number } | null = null
  constructor(private d: RestartDeps) {}

  private get ctx() { return this.d.ctx }
  private sleep(ms: number) { return (this.d.sleep ?? ((n: number) => Bun.sleep(n)))(ms) }
  private launcher() { return this.d.launcher ?? { status: (s: string) => launcherStatus(s, 1500), restart: (s: string) => launcherRestart(s) } }

  /** a supervisor starts this server again after it exits: the bootstrap says so in MYCEL_SUPERVISOR_PID; office mode's
   * office.js run starts it again too. A plain `bun run dev` has none: no server option there. */
  serverOffered(): boolean {
    const env = this.d.env ?? process.env
    return !!env.MYCEL_SUPERVISOR_PID || !!this.ctx.config.office
  }

  /** an installed launcher (not this server's child) whose status lists the restart request */
  async aiOffered(): Promise<boolean> {
    const sock = launcherSockOf(this.ctx)
    if (!sock) return false
    try {
      const st = await this.launcher().status(sock)
      return !!st?.ops?.includes('restart')
    } catch { return false }
  }

  /** the restart waits for answers: its words for the ops lock (routes/system.ts exclusive) */
  get isWaiting() { return !!this.waiting }

  /** why no restart may start now (null: one may) */
  refusal(): RestartRefused | null {
    if (this.waiting) return new RestartRefused('busy', RT.waitingAlready)
    if (this.d.ops().busyWith) return new RestartRefused('busy', RT.busy)
    return this.conflict() ?? this.limit()
  }

  /** An update or a restore that a restart must not cut: checked when it is asked for, and again when its wait ends
   *  (the ops lock holds this server's own maintenance back meanwhile, not root's mycel-ctl update or office's update
   *  agent, which wait for the same answers and then switch app/current). */
  private conflict(): RestartRefused | null {
    const w = updateWaitingFor(this.ctx.config)
    if (w && w.kind !== 'restart') return new RestartRefused('conflict', RT.updating)
    if (updateUnderway(this.ctx.config, this.ctx.version)) return new RestartRefused('conflict', RT.updating)
    // the bootstrap still checks the version it just started: an exit now counts towards a roll-back
    try {
      const st = this.d.ops().updates.readState()
      if (st.pending === this.ctx.version || st.forward === this.ctx.version) return new RestartRefused('conflict', RT.checkingUpdate)
    } catch {}
    if (fs.existsSync(path.join(this.ctx.config.dataDir, 'restore-pending.json'))) return new RestartRefused('conflict', RT.restorePrepared)
    return null
  }

  /** accepted requests of the last hour (the audit log, so a restart does not reset it) */
  private limit(now = Date.now()): RestartRefused | null {
    const rows = this.ctx.db.query("SELECT at FROM audit_log WHERE action = 'system.restart_requested' AND at > ? ORDER BY at DESC")
      .all(iso(now - 3600_000)) as { at: string }[]
    if (rows.length && now - Date.parse(rows[0]!.at) < RESTART_GAP_MS) return new RestartRefused('rate_limited', RT.tooSoon)
    if (rows.length >= RESTART_PER_HOUR) return new RestartRefused('rate_limited', RT.tooMany)
    return null
  }

  async status(o: { owner: boolean; locale: Locale; userId?: string }): Promise<RestartStatus> {
    const now = Date.now()
    const last = this.ctx.db.query("SELECT detail, at FROM audit_log WHERE action = 'system.restarted' AND at > ? ORDER BY at DESC LIMIT 1")
      .get(iso(now - LAST_FOR_MS)) as { detail: string | null; at: string } | null
    let lastWhat: RestartWhat = 'server'
    try { if (JSON.parse(last?.detail ?? '{}').what === 'ai') lastWhat = 'ai' } catch {}
    const failed = this.failedAt && now - this.failedAt.at < LAST_FOR_MS && (!last || Date.parse(last.at) < this.failedAt.at) ? this.failedAt : null
    let gave: RestartStatus['watchdogGaveUp'] = null
    try {
      // the bootstrap's (app/state.json), or office mode's supervisor (data/liveness.json)
      const l = this.d.ops().updates.readState().liveness ?? (this.ctx.config.office ? readLiveness(this.ctx.config.dataDir) : null)
      if (l?.gaveUp) gave = { since: Number.isFinite(Date.parse(l.since)) ? new Date(l.since).toISOString() : iso(now) }
    } catch {}
    const [ai, server] = [await this.aiOffered(), this.serverOffered()]
    const w = this.waiting
    const refused = w ? null : this.refusal()
    return {
      options: { server, ai },
      now: o.owner,
      running: this.d.ops().queue().running,
      waiting: w ? { what: w.what, since: iso(w.since), until: iso(w.until), ...(w.going ? { going: true } : {}), mayCancel: !w.going && (o.owner || w.by === o.userId) } : null,
      last: last ? { what: lastWhat, at: new Date(last.at).toISOString() } : null,
      failed: failed ? { what: failed.what, at: iso(failed.at) } : null,
      blocked: refused ? tr(o.locale, refused.words) : null,
      watchdogGaveUp: gave,
    }
  }

  /** Start a restart; refusals throw RestartRefused. */
  async start(o: { what: RestartWhat; when: 'idle' | 'now'; by: string; owner: boolean }): Promise<void> {
    if (o.when === 'now' && !o.owner) throw new RestartRefused('forbidden', RT.ownerOnlyNow)
    if (o.what === 'server' ? !this.serverOffered() : !(await this.aiOffered())) throw new RestartRefused('conflict', RT.notOffered)
    const no = this.refusal()
    if (no) throw no
    const ops = this.d.ops()
    if (!ops.tryLock('restart')) throw new RestartRefused('busy', RT.busy)
    // the audit row is the limit's count: no row, no restart (and the lock is not left held)
    try { audit(this.ctx.db, { actor: o.by, action: 'system.restart_requested', detail: { what: o.what, when: o.when } }) }
    catch (e) { ops.unlock(); throw e }
    this.ctx.log.info('restart requested', { what: o.what, when: o.when, by: o.by })
    const since = Date.now()
    const until = since + (o.when === 'now' ? 0 : this.d.waitMs ?? RESTART_WAIT_MS)
    // scheduled runs wait like for an update, and say so in the restart's words
    beginUpdateWait(new Date(since), new Date(until), 'restart')
    const w: Waiting = { what: o.what, by: o.by, since, until, skip: o.when === 'now', cancel: false, going: false, done: Promise.resolve() }
    this.waiting = w
    w.done = this.run(w).catch((e) => { this.ctx.log.error('restart failed', { err: e }) })
  }

  /** the waiting restart goes now (the owner): audited, as it ends the running answers someone else's request waited for */
  skip(by: string): boolean {
    if (!this.waiting || this.waiting.going || this.waiting.skip) return false
    audit(this.ctx.db, { actor: by, action: 'system.restart_now', detail: { what: this.waiting.what } })
    this.waiting.skip = true
    return true
  }

  /** the waiting restart is called off: by the owner, or by the admin who asked for it ('not-yours' otherwise) */
  cancel(by: string, owner: boolean): boolean | 'not-yours' {
    const w = this.waiting
    if (!w || w.cancel || w.going) return false
    if (!owner && w.by !== by) return 'not-yours'
    w.cancel = true
    audit(this.ctx.db, { actor: by, action: 'system.restart_cancelled', detail: { what: w.what } })
    return true
  }

  /** tests: a server restart that did not end the test's process (the lock and the marks it holds until the exit) */
  _afterServerRestart() { if (this.waiting?.what === 'server') this.release() }

  /** tests: the run of the restart that waits (or the last one) */
  settled(): Promise<void> { return this.waiting?.done ?? Promise.resolve() }

  private release() {
    this.waiting = null
    endUpdateWait()
    this.d.ops().unlock()
  }

  private async run(w: Waiting) {
    // the running answers finish (a count; never whose), at most until `until`, or until "now" / "don't restart"
    while (!w.cancel && !w.skip && Date.now() < w.until && this.d.ops().queue().running > 0) await this.sleep(2000)
    if (w.cancel) { this.ctx.log.info('restart called off', { what: w.what }); this.release(); return }
    // an update (root's or office's) or a restore came while it waited: it restarts the server itself, and a restart
    // in the middle of it would cut its switch (or count towards a roll-back)
    const late = this.conflict()
    if (late) {
      this.ctx.log.info('restart called off: an update or restore came meanwhile', { what: w.what, why: late.words.en })
      audit(this.ctx.db, { actor: null, action: 'system.restart_cancelled', detail: { what: w.what, reason: late.code === 'conflict' ? late.words.en : late.code } })
      this.release()
      return
    }
    w.going = true
    if (w.what === 'server') {
      // the next start says it restarted (audit), from this mark
      try { fs.writeFileSync(path.join(this.ctx.config.dataDir, MARK), JSON.stringify({ what: 'server', by: w.by, at: iso(Date.now()) }), { mode: 0o600 }) } catch {}
      // the mark holds until this server exits (a few seconds; it stops counting after 10 minutes if the exit never came)
      updateWaitEndsBy(new Date(Date.now() + 10 * 60_000))
      this.d.restartServer('restart from Admin')
      return
    }
    const sock = launcherSockOf(this.ctx)
    const r = sock ? await this.launcher().restart(sock).catch(() => null) : null
    if (r) {
      audit(this.ctx.db, { actor: w.by, action: 'system.restarted', detail: { what: 'ai', answers: r.live } })
      this.ctx.log.info('engine launcher restarted', { answers: r.live })
      this.failedAt = null
    } else {
      this.ctx.log.warn('engine launcher did not answer the restart request')
      this.failedAt = { what: 'ai', at: Date.now() }
    }
    this.release()
  }
}

/** At start: a server restart from Admin finished (data/restart.json): audit it and remove the mark. */
export function noteRestarted(ctx: AppContext) {
  const f = path.join(ctx.config.dataDir, MARK)
  let raw: string
  try { raw = fs.readFileSync(f, 'utf8') } catch { return }
  try { fs.rmSync(f, { force: true }) } catch {}
  let by: string | null = null
  try { const j = JSON.parse(raw) as { by?: unknown }; if (typeof j.by === 'string' && j.by.length <= 64) by = j.by } catch {}
  audit(ctx.db, { actor: by, action: 'system.restarted', detail: { what: 'server' } })
}
