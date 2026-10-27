// P2's bounded protocol runner. The installed adapter uses real API routes, ChatRuntime and the native launcher.
export interface SmokeUser { id: string; username: string; password: string }
import type { P2Limits } from './p2-smoke-preflight'
export type { P2Limits } from './p2-smoke-preflight'
export interface SmokeCounts { providerRequests: number; engineAttempts: number }
export interface SmokeFiles {
  sharedRead: string; sharedText: string; aliceWrite: string; aliceText: string
  bobPrivate: string; bobCanary: string; scheduleWrite: string; scheduleText: string
}
export interface SmokeInput {
  runId: string; users: { owner: SmokeUser; alice: SmokeUser; bob: SmokeUser }
  credentialId: string; model: string; files: SmokeFiles; limits: P2Limits; signal?: AbortSignal
  /** Synchronous durable receipt write. Throwing (or returning a Promise) must prevent admission. */
  persistAdmission(counts: Readonly<SmokeCounts>): void
}
export interface SmokeTurn {
  id: string; chatId: string; messageId: string; userId: string; credentialId: string | null
  engine: string; model: string | null; clientKind: string | null; status: string; startedAt: number
  inputTokens: number; outputTokens: number; usageSource: string | null
  text: string; streamed: boolean; audit: { tool: string; summary: string; ok: number }[]
  changedPaths: string[]; allWritePaths: string[]; canaryAbsent: boolean
}
export interface SmokeSchedule {
  id: string; title: string; repeat: string; date: string | null; time: string; nextRunAt: string | null; lastChatId: string | null
}
export interface SmokeCleanup {
  schedulesRemaining: number; queuedOrRunning: number; liveHandles: number; activeProxyTokens: number
  contextClosed: boolean; launcherIdle: boolean
}
export interface SmokeDriver {
  now(): number
  sleep(ms: number): Promise<void>
  createChat(title: string): Promise<string>
  send(chatId: string, content: string): Promise<{ turnId: string; messageId: string }>
  turn(turnId: string): SmokeTurn | null
  turnsForChat(chatId: string): SmokeTurn[]
  scheduledTurns(): SmokeTurn[]
  file(rel: string): { text: string | null; versions: number }
  schedules(who: 'alice' | 'bob'): Promise<{ items: SmokeSchedule[]; timeZone: string }>
  cleanup(): Promise<SmokeCleanup>
}
export type SmokeCaseId = 'L1' | 'L2' | 'L3' | 'L4'
export interface SmokeReport {
  ok: boolean; cases: { id: SmokeCaseId; status: 'passed' | 'failed' | 'not_run'; code: string | null }[]
  counts: SmokeCounts; cleanup: SmokeCleanup | null; failure: string | null
}

export class SmokeGate {
  private admitted: SmokeCounts = { providerRequests: 0, engineAttempts: 0 }
  closed = false
  reason = 'closed'
  readonly deadline: number
  constructor(private input: SmokeInput, private now: () => number = Date.now) {
    if (Object.values(input.limits).some((n) => !Number.isSafeInteger(n) || n <= 0)) throw new SmokeFailure('invalid_limits')
    this.deadline = now() + input.limits.totalTimeoutMs
  }
  get counts(): SmokeCounts { return { ...this.admitted } }
  close(reason = 'closed') { if (!this.closed) { this.closed = true; this.reason = reason } }
  reject(code: string): never { this.close(code); throw new SmokeFailure(this.reason) }
  check() {
    if (this.input.signal?.aborted) this.close('aborted')
    if (this.closed) throw new SmokeFailure(this.reason)
    if (this.now() >= this.deadline) this.reject('total_timeout')
  }
  remaining() { this.check(); return Math.max(1, this.deadline - this.now()) }
  private admit(key: keyof SmokeCounts, limit: number, code: string) {
    this.check()
    if (this.admitted[key] >= limit) this.reject(code)
    const next = { ...this.admitted, [key]: this.admitted[key] + 1 }
    try {
      const result: unknown = this.input.persistAdmission(Object.freeze({ ...next }))
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        void Promise.resolve(result).catch(() => {})
        this.reject('receipt_failed')
      }
    } catch { this.reject('receipt_failed') }
    this.admitted = next
  }
  admitProvider(binding: { credentialId: string | null; userId: string; family: string | null }) {
    this.check()
    if (binding.credentialId !== this.input.credentialId || binding.userId !== this.input.users.alice.id || binding.family !== 'anthropic') this.reject('credential_mismatch')
    this.admit('providerRequests', this.input.limits.providerRequests, 'provider_limit')
  }
  admitEngine() { this.admit('engineAttempts', this.input.limits.engineAttempts, 'engine_limit') }
}

export class SmokeFailure extends Error { constructor(readonly code: string) { super(code) } }
const need = (ok: unknown, code: string): void => { if (!ok) throw new SmokeFailure(code) }
const FAILURE_CODES = new Set(`invalid_limits closed aborted total_timeout receipt_failed credential_mismatch provider_limit engine_limit operation_timeout turn_timeout turn_failed engine_mismatch schedule_identity stream_missing usage_missing canary_leak event_mismatch write_audit_missing file_evidence_missing file_event_missing fixture_not_fresh fixture_invalid read_audit_missing denial_audit_missing private_file_changed schedule_audit_missing schedule_mismatch schedule_visibility schedule_timeout schedule_duplicate schedule_not_finished schedule_early unexpected_write cleanup_incomplete cleanup_failed cleanup_timeout runtime_error not_ready event_buffer_limit unsafe_evidence_path evidence_size installed_linux_required installed_config_required core_unavailable launcher_isolation_unverified launcher_contract api_failed login_failed hub_auth_failed`.split(' '))
export const safeFailure = (e: unknown): string => e instanceof SmokeFailure && FAILURE_CODES.has(e.code) ? e.code : 'runtime_error'

/** Cleanup gets its own finite grace period after admission has closed. A timed-out cleanup is never success;
 * the CLI supervisor must terminate the worker and must not close its DB under still-running callbacks. */
export async function boundedCleanup(cleanup: () => Promise<SmokeCleanup>, ms = 30_000): Promise<SmokeCleanup> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const c = await Promise.race([cleanup(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new SmokeFailure('cleanup_timeout')), ms) })])
    const nums = [c.schedulesRemaining, c.queuedOrRunning, c.liveHandles, c.activeProxyTokens]
    need(nums.every(n => Number.isSafeInteger(n) && n >= 0) && typeof c.contextClosed === 'boolean' && typeof c.launcherIdle === 'boolean', 'cleanup_failed')
    return { schedulesRemaining: c.schedulesRemaining, queuedOrRunning: c.queuedOrRunning, liveHandles: c.liveHandles, activeProxyTokens: c.activeProxyTokens, contextClosed: c.contextClosed, launcherIdle: c.launcherIdle }
  } finally { clearTimeout(timer) }
}

/** Only this allowlisted summary leaves the process; model text, prompts, sessions and credentials stay in memory. */
export async function runSmoke(d: SmokeDriver, i: SmokeInput, gate: SmokeGate): Promise<SmokeReport> {
  const cases: SmokeReport['cases'] = (['L1', 'L2', 'L3', 'L4'] as const).map((id) => ({ id, status: 'not_run', code: null }))
  let current = 0, failure: string | null = null, cleanup: SmokeCleanup | null = null
  const bounded = async <T>(op: () => Promise<T>): Promise<T> => {
    const ms = Math.min(gate.remaining(), i.limits.turnTimeoutMs)
    let timer: ReturnType<typeof setTimeout> | undefined, onAbort: (() => void) | undefined
    try { return await Promise.race([new Promise<never>((_, reject) => {
      onAbort = () => { gate.close('aborted'); reject(new SmokeFailure('aborted')) }
      i.signal?.addEventListener('abort', onAbort, { once: true })
      if (i.signal?.aborted) onAbort()
      timer = setTimeout(() => { gate.close('operation_timeout'); reject(new SmokeFailure('operation_timeout')) }, ms)
    }), op()]) }
    finally { clearTimeout(timer); if (onAbort) i.signal?.removeEventListener('abort', onAbort) }
  }
  const wait = async <T>(get: () => T | null, maxMs: number): Promise<T> => {
    const end = d.now() + Math.min(maxMs, gate.remaining())
    for (;;) {
      gate.check()
      const value = get(); if (value !== null) return value
      if (d.now() >= end) throw new SmokeFailure('turn_timeout')
      await bounded(() => d.sleep(Math.min(100, end - d.now())))
    }
  }
  const completed = (turnId: string): SmokeTurn | null => {
    const t = d.turn(turnId)
    if (!t || t.status === 'running' || t.status === 'queued') return null
    need(t.status === 'done', 'turn_failed'); return t
  }
  const verify = (t: SmokeTurn, scheduled = false) => {
    need(t.userId === i.users.alice.id && t.credentialId === i.credentialId, 'credential_mismatch')
    need(t.engine === 'claude-code' && t.model === i.model, 'engine_mismatch')
    need(!scheduled || t.clientKind === 'schedule', 'schedule_identity')
    need(t.streamed && t.text.trim().length > 0, 'stream_missing')
    need(t.usageSource === 'proxy' && t.inputTokens + t.outputTokens > 0, 'usage_missing')
    need(t.canaryAbsent && !t.text.includes(i.files.bobCanary), 'canary_leak')
  }
  const ask = async (id: SmokeCaseId, prompt: string) => {
    const chat = await bounded(() => d.createChat(`${i.runId}-${id}`))
    const sent = await bounded(() => d.send(chat, prompt))
    const t = await wait(() => completed(sent.turnId), i.limits.turnTimeoutMs)
    need(t.messageId === sent.messageId && t.chatId === chat, 'event_mismatch')
    verify(t); return t
  }
  const audited = (t: SmokeTurn, tools: string[], rel: string, ok: number) => t.audit.some((a) => tools.includes(a.tool) && a.ok === ok && a.summary.includes(rel))
  const writesOnly = (t: SmokeTurn, paths: string[]) => need(t.allWritePaths.every(p => paths.includes(p)), 'unexpected_write')
  const writeEvidence = (t: SmokeTurn, rel: string, text: string, before: number) => {
    writesOnly(t, [rel])
    need(audited(t, ['write', 'edit'], rel, 1), 'write_audit_missing')
    const file = d.file(rel)
    need(file.text?.trim() === text && file.versions > before, 'file_evidence_missing')
    need(t.changedPaths.includes(rel), 'file_event_missing')
  }
  try {
    const before = await bounded(() => d.schedules('alice'))
    need(before.items.length === 0, 'fixture_not_fresh')
    const privateBefore = d.file(i.files.bobPrivate).text
    need(privateBefore?.includes(i.files.bobCanary), 'fixture_invalid')
    const ready = await ask('L1', 'Reply with one short sentence confirming you are ready. Do not call any tools.')
    writesOnly(ready, [])
    cases[current++].status = 'passed'
    const fileVersion = d.file(i.files.aliceWrite).versions
    const fileTurn = await ask('L2', `Use the team read tool to read ${i.files.sharedRead}. Also read ${i.files.aliceWrite} before overwriting it. Then write exactly ${JSON.stringify(i.files.aliceText)} to ${i.files.aliceWrite}. Confirm briefly.`)
    need(audited(fileTurn, ['read'], i.files.sharedRead, 1) && d.file(i.files.sharedRead).text === i.files.sharedText, 'read_audit_missing')
    writeEvidence(fileTurn, i.files.aliceWrite, i.files.aliceText, fileVersion)
    cases[current++].status = 'passed'
    const denied = await ask('L3', `Use the team read tool to attempt reading ${i.files.bobPrivate}. Report whether access was denied. Do not guess its contents or change files.`)
    writesOnly(denied, [])
    need(denied.audit.some(a => a.tool === 'read' && a.ok === 0 && a.summary.startsWith(`read ${i.files.bobPrivate} -> denied:`)), 'denial_audit_missing')
    need(d.file(i.files.bobPrivate).text === privateBefore, 'private_file_changed')
    cases[current++].status = 'passed'
    // Allow the creation turn up to its full timeout before the requested minute arrives.
    const due = new Date(Math.ceil((d.now() + i.limits.turnTimeoutMs + 60_000) / 60_000) * 60_000)
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: before.timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(due).map((p) => [p.type, p.value]))
    const scheduleVersion = d.file(i.files.scheduleWrite).versions
    const scheduledPrompt = `First read ${i.files.scheduleWrite} with the team read tool. Then write exactly ${JSON.stringify(i.files.scheduleText)} to ${i.files.scheduleWrite} using the team write tool. Do not ask any questions.`
    const made = await ask('L4', `Call schedule_create exactly once: title ${JSON.stringify(i.runId)}, repeat "once", date "${parts.year}-${parts.month}-${parts.day}", time "${parts.hour}:${parts.minute}" in ${before.timeZone}, prompt ${JSON.stringify(scheduledPrompt)}. Do not execute it now.`)
    writesOnly(made, [])
    need(made.audit.some((a) => a.tool === 'schedule_create' && a.ok === 1), 'schedule_audit_missing')
    const mine = await bounded(() => d.schedules('alice'))
    need(mine.timeZone === before.timeZone && mine.items.length === 1 && mine.items[0].repeat === 'once' && mine.items[0].title === i.runId, 'schedule_mismatch')
    const schedule = mine.items[0]
    need(schedule.date === `${parts.year}-${parts.month}-${parts.day}` && schedule.time === `${parts.hour}:${parts.minute}` && schedule.nextRunAt !== null && Date.parse(schedule.nextRunAt) === due.getTime() && schedule.lastChatId === null, 'schedule_mismatch')
    need(!(await bounded(() => d.schedules('bob'))).items.some((s) => s.id === schedule.id), 'schedule_visibility')
    let row = schedule
    const end = Math.min(gate.deadline, due.getTime() + i.limits.turnTimeoutMs + 60_000)
    while (!row.lastChatId) {
      gate.check(); need(d.now() < end, 'schedule_timeout')
      await bounded(() => d.sleep(100))
      const list = await bounded(() => d.schedules('alice'))
      need(list.items.length === 1 && list.items[0].id === schedule.id, 'schedule_mismatch'); row = list.items[0]
    }
    const st = await wait(() => {
      const turns = d.turnsForChat(row.lastChatId!); need(turns.length <= 1, 'schedule_duplicate')
      return turns.length ? completed(turns[0].id) : null
    }, i.limits.turnTimeoutMs)
    need(st.startedAt >= due.getTime(), 'schedule_early')
    need(d.scheduledTurns().length === 1, 'schedule_duplicate')
    verify(st, true); writeEvidence(st, i.files.scheduleWrite, i.files.scheduleText, scheduleVersion)
    need(row.nextRunAt === null, 'schedule_not_finished')
    // A second scheduler tick must not create another turn.
    await bounded(() => d.sleep(30_100))
    const after = await bounded(() => d.schedules('alice'))
    need(after.items.length === 1 && after.items[0].id === schedule.id && after.items[0].lastChatId === row.lastChatId && after.items[0].nextRunAt === null && d.scheduledTurns().length === 1 && d.turnsForChat(row.lastChatId!).length === 1, 'schedule_duplicate')
    need(d.file(i.files.bobPrivate).text === privateBefore, 'private_file_changed')
    cases[current].status = 'passed'
  } catch (e) {
    failure = safeFailure(e); cases[Math.min(current, 3)].status = 'failed'; cases[Math.min(current, 3)].code = failure
  } finally {
    gate.close(failure ?? 'finished')
    try {
      cleanup = await boundedCleanup(() => d.cleanup())
      if (cleanup.schedulesRemaining || cleanup.queuedOrRunning || cleanup.liveHandles || cleanup.activeProxyTokens || !cleanup.contextClosed || !cleanup.launcherIdle) failure ??= 'cleanup_incomplete'
    } catch (e) { failure ??= safeFailure(e) }
  }
  return { ok: failure === null && cases.every((c) => c.status === 'passed'), cases, counts: gate.counts, cleanup, failure }
}
