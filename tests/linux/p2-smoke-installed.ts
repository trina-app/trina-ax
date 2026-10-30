// Reviewed source API + ChatRuntime, installed native binaries and production launcher.
// No compiled-server-bundle, HTTP transport, or WebSocket-upgrade coverage is implied.
import fs from 'node:fs'
import path from 'node:path'
import type { Database } from 'bun:sqlite'
import { uuidv7, type LaunchRequest } from '@mycel/shared'
import { API, WS_BEARER_PREFIX, WS_PROTOCOL, type ServerEvent } from '@mycel/shared/api'
import { DEFAULT_PROXY_PORT, type AppConfig } from '../../server/src/app-config'
import { buildApp } from '../../server/src/app'
import { createContext, type AppContext } from '../../server/src/context'
import { configureChat, getChatRuntime, type ChatRuntime } from '../../server/src/chat/runtime'
import type { CredentialBroker, TokenBinding } from '../../server/src/credentials/broker'
import { brokerOf } from '../../server/src/credentials/maintenance'
import { launcherStatus, type Launcher, type LaunchHandle } from '../../server/src/native'
import { silentLogger } from '../../server/src/log'
import type { Running } from '../../server/src/server'
import type { RealtimeConn } from '../../server/src/services'
import { authRoutes } from '../../server/src/routes/auth'
import { chatsRoutes } from '../../server/src/routes/chats'
import { memoriesRoutes } from '../../server/src/routes/memories'
import { filesRoutes } from '../../server/src/routes/files'
import { artifactsRoutes } from '../../server/src/routes/artifacts'
import { jobsRoutes } from '../../server/src/routes/jobs'
import { P2_SMOKE_BASE } from './p2-smoke-preflight'
import { SmokeFailure, SmokeGate, runSmoke, boundedCleanup, safeFailure, type SmokeCleanup, type SmokeDriver, type SmokeInput, type SmokeReport, type SmokeTurn } from './p2-smoke-runner'

export interface InstalledSmokeInput extends SmokeInput {
  cfg: AppConfig; db: Database
  /** After the real core creates tools.sock, before any engine or provider admission. */
  assertToolsSocket(): void
}
const need = (ok: unknown, code: string): void => { if (!ok) throw new SmokeFailure(code) }

/** forRequest precedes each Anthropic messages/count_tokens fetch. Anthropic has no broker refresh retry;
 * the fresh fixture forbids ChatGPT/OpenAI connections, including their separate refresh transport. Counts
 * are conservative admissions: an unusable connection or failed transport can consume one without billing. */
export function guardBroker(broker: CredentialBroker, gate: SmokeGate, assertBinding: (b: TokenBinding) => void): void {
  const original = broker.forRequest.bind(broker)
  broker.forRequest = async (binding, family) => {
    gate.check()
    if (family !== 'anthropic') gate.reject('credential_mismatch')
    try { assertBinding(binding) } catch (e) { gate.reject(safeFailure(e)) }
    gate.admitProvider(binding)
    const result = await original(binding, family)
    gate.check() // Never hand out an injection when shutdown raced credential lookup.
    if (result.ok && (result.credentialId !== binding.credentialId || !['anthropic-oauth', 'anthropic-api-key'].includes(result.kind))) gate.reject('credential_mismatch')
    return result
  }
}

/** Preserve SocketLauncher.tcpPeer/path and the real event stream, changing admission and timeout only. */
export function guardLauncher(launcher: Launcher, gate: SmokeGate, check: (req: LaunchRequest) => void, handles: Set<LaunchHandle>): void {
  const original = launcher.launch.bind(launcher)
  launcher.launch = (req) => {
    gate.check(); try { check(req) } catch (e) { gate.reject(safeFailure(e)) }; gate.admitEngine()
    const h = original({ ...req, timeoutMs: Math.min(req.timeoutMs, gate.remaining()) })
    const tracked: LaunchHandle = {
      kill: () => h.kill(),
      events: { async *[Symbol.asyncIterator]() { try { yield* h.events } finally { handles.delete(tracked) } } },
    }
    handles.add(tracked); return tracked
  }
}

/** Bounded, in-memory transport into the real Hub. No frame contents are logged or returned in reports. */
class Capture implements RealtimeConn {
  frames: ServerEvent[] = []; hello = false; closed = false; bytes = 0; leaked = false
  private closedFns: (() => void)[] = []
  constructor(private canary: string, private gate: SmokeGate) {}
  send(data: string) {
    this.bytes += data.length
    if (data.includes(this.canary)) this.leaked = true
    if (this.bytes > 8 * 1024 * 1024) { this.gate.close('event_buffer_limit'); return }
    const frame = JSON.parse(data)
    if (frame.type === 'hello') this.hello = true
    else if ('seq' in frame) this.frames.push(frame as ServerEvent)
  }
  close() { if (this.closed) return; this.closed = true; for (const fn of this.closedFns.splice(0)) fn() }
  bufferedAmount() { return 0 }
  ping() {}
  onMessage(_fn: (data: string) => void) {}
  onClose(fn: () => void) { if (this.closed) fn(); else this.closedFns.push(fn) }
}

export function fileMutationEvidence(db: Database, turnId: string, frames: ServerEvent[]): { allWritePaths: string[]; changedPaths: string[] } {
  const changes = db.query('SELECT path FROM file_events WHERE turn_id = ? ORDER BY rowid').all(turnId) as { path: string }[]
  const paths = frames.flatMap(e => e.type === 'files.changed' ? e.data.changes.filter(c => c.turnId === turnId).map(c => c.path) : [])
  return { allWritePaths: changes.map(c => c.path), changedPaths: changes.filter(c => paths.includes(c.path)).map(c => c.path) }
}

interface TurnRow {
  id: string; chat_id: string; message_id: string; user_id: string; credential_id: string | null
  engine: string; model: string | null; client_kind: string | null; status: string
  started_at: string; input_tokens: number; output_tokens: number; usage_source: string | null; content: string; engine_session_blob: string | null
}

export async function runInstalledSmoke(i: InstalledSmokeInput): Promise<SmokeReport> {
  const gate = new SmokeGate(i), handles = new Set<LaunchHandle>(), channels = new Map<string, Capture>()
  const pending = new Set<Promise<unknown>>()
  let ownsFixture = false
  let ctx: AppContext | undefined, rt: ChatRuntime | undefined, core: Running | undefined, ready = false, coreStarted = false
  let corePending: Promise<Running> | undefined, cleanupPromise: Promise<SmokeCleanup> | undefined
  const count = (sql: string, ...args: (string | number)[]) => (i.db.query(sql).get(...args) as { n: number }).n
  const requireFreshCredential = () => {
    const row = i.db.query('SELECT id, owner_user_id, kind, disabled FROM engine_credentials').all() as { id: string; owner_user_id: string; kind: string; disabled: number }[]
    need(row.length === 1 && row[0].id === i.credentialId && row[0].owner_user_id === i.users.alice.id && !row[0].disabled && ['anthropic-oauth', 'anthropic-api-key'].includes(row[0].kind), 'credential_mismatch')
  }
  const bind = (b: TokenBinding) => {
    need(ready, 'not_ready'); requireFreshCredential()
    const row = i.db.query('SELECT user_id, credential_id, engine, model FROM turns WHERE id = ?').get(b.turnId) as Pick<TurnRow, 'user_id' | 'credential_id' | 'engine' | 'model'> | null
    need(row && row.user_id === i.users.alice.id && row.credential_id === i.credentialId && row.engine === 'claude-code' && row.model === i.model, 'credential_mismatch')
  }
  const bounded = async <T>(op: () => Promise<T>, ms = i.limits.turnTimeoutMs, join = true): Promise<T> => {
    gate.check(); let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined
    try {
      return await Promise.race([new Promise<never>((_, reject) => {
        abort = () => { gate.close('aborted'); reject(new SmokeFailure('aborted')) }
        i.signal?.addEventListener('abort', abort, { once: true }); if (i.signal?.aborted) abort()
        timer = setTimeout(() => { gate.close('operation_timeout'); reject(new SmokeFailure('operation_timeout')) }, Math.min(ms, gate.remaining()))
      }), (() => { const work = op(); if (join) { pending.add(work); void work.finally(() => pending.delete(work)).catch(() => {}) } return work })()])
    } finally { clearTimeout(timer); if (abort) i.signal?.removeEventListener('abort', abort) }
  }
  // Read only regular non-symlink files inside the reviewed fixture/server data roots, with bounded scanning.
  const read = (root: string, rel: string): string | null => {
    need(rel.length > 0 && !path.isAbsolute(rel) && !rel.split('/').some(p => p === '..' || p === '.' || !p), 'unsafe_evidence_path')
    let current = root
    for (const part of rel.split('/')) {
      current = path.join(current, part)
      let st: fs.Stats
      try { st = fs.lstatSync(current) } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e }
      need(!st.isSymbolicLink(), 'unsafe_evidence_path')
    }
    const st = fs.lstatSync(current); need(st.isFile() && st.size <= 16 * 1024 * 1024, 'evidence_size')
    const fd = fs.openSync(current, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    try { return fs.readFileSync(fd, 'utf8') } finally { fs.closeSync(fd) }
  }
  const canaryAbsent = (t: TurnRow) => {
    if (channels.get('alice')?.leaked || t.content.includes(i.files.bobCanary)) return false
    if (t.engine_session_blob) {
      const rel = path.relative(i.cfg.dataDir, t.engine_session_blob)
      if (read(i.cfg.dataDir, rel)?.includes(i.files.bobCanary)) return false
    }
    let entries = 0, bytes = 0
    const visit = (rel: string): boolean => {
      const absolute = path.join(i.cfg.teamRoot, rel), st = fs.lstatSync(absolute)
      need(++entries <= 2000 && !st.isSymbolicLink(), 'evidence_size')
      if (st.isDirectory()) return fs.readdirSync(absolute).every(name => visit(`${rel}/${name}`))
      bytes += st.size; need(bytes <= 32 * 1024 * 1024, 'evidence_size')
      return !read(i.cfg.teamRoot, rel)?.includes(i.files.bobCanary)
    }
    return ['shared', `users/${i.users.alice.id}`].every(visit)
  }
  const inspect = (id: string): SmokeTurn | null => {
    const t = i.db.query('SELECT t.*, m.content FROM turns t JOIN messages m ON m.id = t.message_id WHERE t.id = ?').get(id) as TurnRow | null
    if (!t) return null
    const frames = channels.get('alice')!.frames
    const done = frames.some(e => e.type === 'message.done' && e.data.messageId === t.message_id && e.data.chatId === t.chat_id && e.data.status === 'done')
    return {
      id: t.id, chatId: t.chat_id, messageId: t.message_id, userId: t.user_id, credentialId: t.credential_id, engine: t.engine, model: t.model,
      clientKind: t.client_kind, startedAt: Date.parse(t.started_at), status: t.status === 'done' && !done ? 'running' : t.status, inputTokens: t.input_tokens, outputTokens: t.output_tokens,
      usageSource: t.usage_source, text: t.content, streamed: done && frames.some(e => e.type === 'message.delta' && e.data.messageId === t.message_id && e.data.text.length > 0),
      audit: i.db.query('SELECT tool, summary, ok FROM tool_events WHERE turn_id = ?').all(id) as SmokeTurn['audit'],
      ...fileMutationEvidence(i.db, id, frames), canaryAbsent: canaryAbsent(t),
    }
  }
  const cleanup = (): Promise<SmokeCleanup> => cleanupPromise ??= (async () => {
    gate.close('cleanup'); ready = false
    if (!ownsFixture) return { schedulesRemaining: 0, queuedOrRunning: 0, liveHandles: 0, activeProxyTokens: 0, contextClosed: true, launcherIdle: true }
    // Freeze dispatch and revoke before awaiting anything. Join in-process API/startup work before the
    // final sweep: a timed-out send may have been between parsing and queue insertion when cleanup began.
    let cleanupError = false
    const attempt = (fn: () => unknown) => { try { fn() } catch { cleanupError = true } }
    const stop = () => {
      attempt(() => i.db.query('DELETE FROM schedules WHERE user_id = ?').run(i.users.alice.id))
      if (!rt && ctx) { try { rt = getChatRuntime(ctx) } catch {} }
      if (rt) { void rt.drain(0).catch(() => { cleanupError = true }); attempt(() => rt!.stopUserTurns(i.users.alice.id)) }
      attempt(() => i.db.query('UPDATE proxy_tokens SET revoked_at = ? WHERE revoked_at IS NULL').run(new Date().toISOString()))
      for (const h of handles) attempt(() => h.kill())
    }
    stop()
    await Promise.allSettled([...pending])
    if (!core && corePending) { try { core = await corePending; coreStarted = true } catch { cleanupError = true } }
    stop()
    if (rt) { try { await rt.shutdown() } catch { cleanupError = true } }
    // Cancel queued rows left without an in-memory exec; never mark a running row falsely complete.
    attempt(() => i.db.query("UPDATE messages SET status = 'stopped' WHERE id IN (SELECT message_id FROM turns WHERE user_id = ? AND status = 'queued')").run(i.users.alice.id))
    attempt(() => i.db.query("UPDATE turns SET status = 'stopped', ended_at = ? WHERE user_id = ? AND status = 'queued'").run(new Date().toISOString(), i.users.alice.id))
    for (const channel of channels.values()) channel.close()
    attempt(() => i.db.query('DELETE FROM sessions').run())
    let contextClosed = false
    if (ctx) { await ctx.close(); contextClosed = !corePending || coreStarted }
    else contextClosed = true
    const until = Date.now() + 8000
    let idle = false
    if (core) while (Date.now() < until) {
      const st = await launcherStatus(i.cfg.engine.launcherSock!, 1000)
      idle = st?.liveTurns === 0
      if (idle && handles.size === 0) break
      await Bun.sleep(100)
    }
    if (cleanupError) throw new SmokeFailure('cleanup_failed')
    return {
      schedulesRemaining: count('SELECT count(*) n FROM schedules WHERE user_id = ?', i.users.alice.id),
      queuedOrRunning: count("SELECT count(*) n FROM turns WHERE user_id = ? AND status IN ('queued','running')", i.users.alice.id),
      liveHandles: handles.size, activeProxyTokens: count('SELECT count(*) n FROM proxy_tokens WHERE revoked_at IS NULL'),
      contextClosed: contextClosed && (!core || core.proxy?.state === 'stopped'), launcherIdle: core ? idle : !corePending,
    }
  })()
  try {
    gate.check() // In particular, an already aborted invocation touches no HOME/fixture/core.
    need(process.platform === 'linux' && process.env.NODE_ENV === 'production', 'installed_linux_required')
    need(i.cfg.mode === 'prod' && i.cfg.engine.authMode === 'managed' && i.cfg.engine.launcherSock === `${P2_SMOKE_BASE}/run-launcher/launcher.sock`, 'installed_config_required')
    need(i.cfg.dataDir === `${P2_SMOKE_BASE}/data` && i.cfg.teamRoot === `${P2_SMOKE_BASE}/team`, 'installed_config_required')
    for (const table of ['chats', 'turns', 'schedules', 'proxy_tokens']) need(count(`SELECT count(*) n FROM ${table}`) === 0, 'fixture_not_fresh')
    requireFreshCredential(); ownsFixture = true
    ctx = createContext({ config: i.cfg, db: i.db, log: silentLogger })
    ctx.engineConfig.nativeBin = `${P2_SMOKE_BASE}/app/current/native`
    configureChat(ctx, { maxEngineTurns: i.limits.toolTurns, turnTimeoutMs: i.limits.turnTimeoutMs, askUserTimeoutMs: Math.min(5000, i.limits.turnTimeoutMs) })
    guardBroker(brokerOf(ctx), gate, bind)
    const app = await bounded(() => buildApp(ctx!, [authRoutes, chatsRoutes, memoriesRoutes, filesRoutes, artifactsRoutes, jobsRoutes]))
    rt = getChatRuntime(ctx)
    corePending = ctx.core(); core = await bounded(() => corePending!, 15_000); coreStarted = true
    need(core.launcher && core.proxy?.ready, 'core_unavailable')
    const status = await bounded(() => launcherStatus(i.cfg.engine.launcherSock!, 3000), 4000)
    need(status?.os === 'linux' && status.sandbox === 'bwrap' && status.dedicated === true && status.scoped === true && (status.landlockAbi ?? 0) >= 6 && status.seccomp === true && status.cgroup === 'delegated' && status.firewall?.loaded === true && status.liveTurns === 0, 'launcher_isolation_unverified')
    guardLauncher(core.launcher!, gate, (req) => {
      bind({ credentialId: i.credentialId, userId: i.users.alice.id, family: 'anthropic', turnId: req.turnId })
      need(req.cmd === i.cfg.engine.claudeBin && req.modelToken && !req.codexAuth && !req.codexHome, 'launcher_contract')
      need(req.args[req.args.indexOf('--model') + 1] === i.model && req.args[req.args.indexOf('--max-turns') + 1] === String(i.limits.toolTurns), 'launcher_contract')
      need(req.env.HOME === path.join(req.chatDir, '.home') && req.env.CLAUDE_CONFIG_DIR === path.join(req.chatDir, '.claude') && req.env.ANTHROPIC_BASE_URL === `http://127.0.0.1:${i.cfg.engine.proxyPort ?? DEFAULT_PROXY_PORT}`, 'launcher_contract')
      need(req.timeoutMs <= i.limits.turnTimeoutMs && !Object.keys(req.env).some(k => /(?:API_KEY|OAUTH_TOKEN|AUTH_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN)$/.test(k)), 'launcher_contract')
    }, handles)
    i.assertToolsSocket(); gate.check(); ready = true
    const tokens = new Map<string, string>(), base = `http://127.0.0.1:${i.cfg.listen.port}`
    const api = async (who: keyof SmokeInput['users'], method: string, route: string, body?: unknown) => {
      gate.check()
      const headers = new Headers({ 'content-type': 'application/json', 'x-mycel-csrf': '1', 'x-mycel-window': `p2-${who}-window` })
      const token = tokens.get(who); if (token) headers.set('authorization', `Bearer ${token}`)
      const response = await bounded(async () => await app.fetch(new Request(base + route, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), { ip: '127.0.0.1', via: 'local' }))
      need(response.ok, 'api_failed')
      return response.status === 204 ? null : await response.json()
    }
    for (const who of ['owner', 'alice', 'bob'] as const) {
      const user = i.users[who]
      const login = API.login.response.parse(await api(who, 'POST', '/api/auth/login', { username: user.username, password: user.password, client: 'web', tokenMode: 'bearer' }))
      need(login.token && login.me.user.id === user.id && !login.me.user.mustChangePassword, 'login_failed')
      tokens.set(who, login.token!)
      const channel = new Capture(i.files.bobCanary, gate); channels.set(who, channel)
      await bounded(() => rt!.hub.attach(channel, new Request(`${base}/api/ws?windowId=p2-${who}-window`, { headers: { 'sec-websocket-protocol': `${WS_PROTOCOL}, ${WS_BEARER_PREFIX}${login.token}` } }), { ip: '127.0.0.1', via: 'local' }))
      need(channel.hello && !channel.closed, 'hub_auth_failed')
    }
    const driver: SmokeDriver = {
      now: Date.now, sleep: ms => bounded(() => Bun.sleep(ms), ms + 1000, false),
      async createChat(title) { return API.createChat.response.parse(await api('alice', 'POST', '/api/chats', { title, engine: 'claude-code', model: i.model })).id },
      async send(chatId, content) {
        const sent = API.sendMessage.response.parse(await api('alice', 'POST', `/api/chats/${chatId}/messages`, { content, clientMessageId: uuidv7(), attachmentIds: [] }))
        return { turnId: sent.turnId, messageId: sent.assistantMessage.id }
      },
      turn: inspect,
      scheduledTurns() { return (i.db.query("SELECT id FROM turns WHERE user_id = ? AND client_kind = 'schedule'").all(i.users.alice.id) as { id: string }[]).map(r => inspect(r.id)!) },
      turnsForChat(chatId) { return (i.db.query('SELECT id FROM turns WHERE chat_id = ?').all(chatId) as { id: string }[]).map(r => inspect(r.id)!) },
      file(rel) { return { text: read(i.cfg.teamRoot, rel), versions: count('SELECT count(*) n FROM file_versions WHERE path = ?', rel) } },
      async schedules(who) { return API.listSchedules.response.parse(await api(who, 'GET', '/api/schedules')) },
      async approveScheduleCard(turnId) {
        // the server's card of schedule_create (origin server, a "create" answer), seen on alice's own socket
        for (;;) {
          gate.check()
          const f = channels.get('alice')!.frames.find((e) => e.type === 'turn.request' && e.data.turnId === turnId && e.data.request.kind === 'ask_user'
            && e.data.request.origin === 'server' && !!e.data.request.options?.some((o) => o.value === 'create'))
          if (f && f.type === 'turn.request') {
            await api('alice', 'POST', `/api/turns/${turnId}/answer`, { kind: 'ask_user', requestId: f.data.request.requestId, answer: 'create' })
            return true
          }
          const st = inspect(turnId)?.status
          if (st && st !== 'running' && st !== 'queued') return false
          await Bun.sleep(100)
        }
      },
      cleanup,
    }
    return await runSmoke(driver, i, gate)
  } catch (e) {
    const failure = safeFailure(e); gate.close(failure)
    let result: SmokeCleanup | null = null
    try { result = await boundedCleanup(cleanup) } catch {}
    return { ok: false, failure, counts: gate.counts, cases: (['L1', 'L2', 'L3', 'L4'] as const).map(id => ({ id, status: 'not_run', code: null })), cleanup: result }
  }
}
