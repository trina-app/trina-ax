// The file list's reader on the team's own AI (docs/AGENTS/plan/20261111-0630-file-list.md "Scope" 4): the engine a
// chat turn runs, launched the same way (the launcher, its sandbox, the model proxy with the team's AI connection, the
// office tunnel) but with no tools and one answer (engine/claude.ts buildClaudeReaderLaunch, engine/codex.ts
// buildCodexReaderLaunch). Each call is a turn of the team's owner in the turns table (chat id READER_CHAT): the proxy
// needs one to check its token and caller and to count the usage, and Admin › Usage then shows it like any other use.
//
// Which engine: Claude Code when the team can use it (on in Admin, installed, and in managed mode a usable connection),
// on Haiku, the cheapest Claude model (Claude Code's alias; a gateway's own small model). Else Codex on its catalog's
// cheapest model when the names tell (nano, mini), else its default; Codex reads text only here. Which connection: a
// team-wide one first (not assigned to anyone), else the one the owner's own chats would use.
import path from 'node:path'
import type { CredentialKind, FileListSignIn } from '@mycel/shared/api'
import type { AppContext } from '../context'
import type { Running } from '../server'
import { enginesEnabled } from '../admin/settings'
import { candidates, type CredEngine } from '../credentials/resolve'
import { credentialsOf, getRow, metaOf, unusable } from '../credentials/store'
import { dummyAuthJson } from '../credentials/codex-home'
import { buildClaudeReaderLaunch, type ClaudeConf } from '../engine/claude'
import { buildCodexReaderLaunch, cheapestCodexModel, CODEX_VERSION, prepareCodexTurn, type CodexConf } from '../engine/codex'
import { ClaudeStreamParser } from '../engine/claude-parse'
import { CodexEventParser } from '../engine/codex-parse'
import { Utf8Lines, Utf8Text } from '../engine/lines'
import { LocalEngines, type EngineConfs } from '../chat/engines'
import { issueProxyToken, revokeProxyTokens, type ProxyTurnEvent } from '../proxy/model-proxy'
import { blocksAsText, ReaderLimit, ReaderUnavailable, SYSTEM_PROMPT, type Block, type Reader, type ReaderAnswer } from './reader'

/** turns.chat_id of the reader's calls (no chat has this id) */
export const READER_CHAT = 'file-list'
/** its engine folder under the agent root (the launcher runs engines only in a folder right below it) */
export const READER_DIR = 'file-list-reader'
/** Claude Code's alias for the current Haiku */
export const CLAUDE_READER_MODEL = 'haiku'
/** one call's time limit (a batch of 8 images took about 10 s in the prototype) */
export const READER_TIMEOUT_MS = 5 * 60_000

/** The team's owner: the reader's turns are theirs (the team's work, not a member's). */
export function ownerId(ctx: AppContext): string | null {
  const r = ctx.db.query("SELECT id FROM users WHERE role = 'owner' AND status = 'active' AND deleted_at IS NULL ORDER BY created_at LIMIT 1").get() as { id: string } | null
  return r?.id ?? null
}

const ENGINES = new WeakMap<AppContext, LocalEngines>()
/** The engines as chat turns find them (chat/engines.ts), one lookup per server (it caches and looks again later). */
function engineConfs(ctx: AppContext): EngineConfs {
  let e = ENGINES.get(ctx)
  if (!e) { e = new LocalEngines(ctx); ENGINES.set(ctx, e) }
  return e.get()
}

/** A connection for the reader: team-wide first, then what the owner's chats use. null: none usable now. */
export function readerCredential(ctx: AppContext, engine: CredEngine, exclude: ReadonlySet<string> = new Set()): { credentialId: string; kind: CredentialKind } | null {
  const owner = ownerId(ctx)
  if (!owner) return null
  const allowed = credentialsOf(ctx).allowedKinds
  const list = candidates(ctx.db, owner, engine, exclude)
  const now = new Date()
  for (const { row } of [...list.filter((c) => c.tier === 'team'), ...list.filter((c) => c.tier !== 'team')]) {
    if (!unusable(ctx.db, row, now, allowed)) return { credentialId: row.id, kind: row.kind }
  }
  return null
}

export type ReaderPick = { ok: true; reader: Reader } | { ok: false; problem: 'no_engine' }

/** The reader this team can use now, or why none. */
export function pickReader(ctx: AppContext): ReaderPick {
  const owner = ownerId(ctx)
  if (!owner) return { ok: false, problem: 'no_engine' }
  const confs = engineConfs(ctx)
  const on = enginesEnabled(ctx.db)
  const usable = (engine: CredEngine, managed: boolean) => !managed || !!readerCredential(ctx, engine)
  if (confs.claude && on['claude-code'] && usable('claude-code', confs.claude.authMode === 'managed')) return { ok: true, reader: new EngineReader(ctx, { engine: 'claude-code', conf: confs.claude }) }
  if (confs.codex && on.codex && usable('codex', confs.codex.auth === 'managed')) {
    return { ok: true, reader: new EngineReader(ctx, { engine: 'codex', conf: confs.codex, model: cheapestCodexModel(confs.codexModels) }) }
  }
  return { ok: false, problem: 'no_engine' }
}

type Pick = { engine: 'claude-code'; conf: ClaudeConf } | { engine: 'codex'; conf: CodexConf; model: string | null }

export class EngineReader implements Reader {
  readonly engine: 'claude-code' | 'codex'
  readonly model: string | null
  readonly images: boolean
  constructor(private ctx: AppContext, private pick: Pick) {
    this.engine = pick.engine
    this.model = pick.engine === 'claude-code' ? (pick.conf.authMode !== 'local-login' && pick.conf.gatewayModels ? pick.conf.gatewayModels.haiku ?? pick.conf.gatewayModels.default : CLAUDE_READER_MODEL) : pick.model ?? pick.conf.model
    this.images = pick.engine === 'claude-code'
  }

  /** Whose sign-in a call would use now: the AI account the proxy would put on it (managed), else the engine's own
   * sign-in on the server's computer. */
  signIn(): FileListSignIn {
    const base = { engine: this.engine, model: this.model }
    const managed = this.pick.engine === 'claude-code' ? this.pick.conf.authMode === 'managed' : this.pick.conf.auth === 'managed'
    if (!managed) return { ...base, kind: 'server', label: null, by: null }
    const c = readerCredential(this.ctx, this.engine)
    const row = c ? getRow(this.ctx.db, c.credentialId) : null
    if (!row) return { ...base, kind: 'team', label: null, by: null }
    const who = row.owner_user_id ?? row.created_by
    const by = who ? (this.ctx.db.query('SELECT name FROM users WHERE id = ?').get(who) as { name: string } | null)?.name ?? null : null
    return { ...base, kind: row.owner_user_id ? 'person' : 'team', label: row.label || null, by }
  }

  async read(blocks: Block[], signal: AbortSignal): Promise<ReaderAnswer> {
    const core = await this.ctx.core()
    if (!core.launcher) throw new ReaderUnavailable('engine launcher not running')
    const owner = ownerId(this.ctx)
    if (!owner) throw new ReaderUnavailable('no owner')
    const { turn, token } = core.turns.create(owner, READER_CHAT, this.engine, this.model)
    const chatDir = path.join(core.cfg.agentRoot, READER_DIR)
    let limited: string | null = null
    let refused: string | null = null
    let unsubscribe: (() => void) | null = null
    let status: 'done' | 'error' | 'stopped' = 'error'
    let kill: (() => void) | null = null
    const onProxy = (ev: ProxyTurnEvent) => {
      if (ev.type === 'rate_limit' || (ev.type === 'credential' && ev.reason === 'over_limit') || ev.type === 'budget') limited = ev.type
      else if (ev.type === 'credential' || ev.type === 'auth' || ev.type === 'lockdown') refused = ev.type
      else return
      kill?.()
    }
    try {
      let lr
      if (this.pick.engine === 'claude-code') {
        const conf = this.pick.conf
        const managed = !!(conf.modelProxy && core.proxy)
        if (conf.modelProxy && !core.proxy?.ready) throw new ReaderUnavailable('model proxy not ready')
        const tunnelPort = !conf.modelProxy && conf.connectProxy ? core.proxy?.port ?? null : null
        if (!conf.modelProxy && conf.connectProxy && !core.proxy?.ready) throw new ReaderUnavailable('model proxy not ready')
        let proxyToken: string | undefined
        let tokenKind: 'oauth' | 'api-key' = 'oauth'
        const tools = { agent: false, webSearch: false, team: [] as string[] }
        if (managed) {
          const c = readerCredential(this.ctx, 'claude-code')
          if (!c) throw new ReaderUnavailable('no usable AI connection')
          tokenKind = c.kind === 'anthropic-api-key' ? 'api-key' : 'oauth'
          proxyToken = issueProxyToken(this.ctx.db, turn.id, owner, { ttlMs: READER_TIMEOUT_MS + 60_000, credentialId: c.credentialId, family: 'anthropic', tools })
          unsubscribe = core.proxy!.subscribe(turn.id, onProxy)
        } else if (tunnelPort !== null) proxyToken = issueProxyToken(this.ctx.db, turn.id, owner, { ttlMs: READER_TIMEOUT_MS + 60_000, tools })
        const message = JSON.stringify({ type: 'user', message: { role: 'user', content: blocks } }) + '\n'
        lr = buildClaudeReaderLaunch({ turnId: turn.id, chatDir, token, systemPrompt: SYSTEM_PROMPT, message, model: this.model!, timeoutMs: READER_TIMEOUT_MS, proxyToken, tokenKind,
          ...(tunnelPort !== null && proxyToken ? { tunnel: { port: tunnelPort, token: proxyToken } } : {}) }, conf)
      } else {
        const conf = this.pick.conf
        let proxy: { port: number; token: string } | undefined
        let managed: Parameters<typeof buildCodexReaderLaunch>[0]['managed']
        if (conf.auth === 'agent-own') {
          if (!core.proxy?.ready) throw new ReaderUnavailable('model proxy not ready')
          proxy = { port: core.proxy.port, token: issueProxyToken(this.ctx.db, turn.id, owner, { ttlMs: READER_TIMEOUT_MS }) }
        }
        if (conf.auth === 'managed') {
          if (!core.proxy?.ready) throw new ReaderUnavailable('model proxy not ready')
          const c = readerCredential(this.ctx, 'codex')
          if (!c) throw new ReaderUnavailable('no usable AI connection')
          const t = issueProxyToken(this.ctx.db, turn.id, owner, { ttlMs: READER_TIMEOUT_MS + 60_000, credentialId: c.credentialId, family: 'openai', tools: { agent: false, webSearch: false } })
          const row = getRow(this.ctx.db, c.credentialId)
          const meta = row ? metaOf(row) : {}
          const kind = c.kind === 'chatgpt' ? 'chatgpt' as const : 'openai-api-key' as const
          managed = { port: core.proxy.port, mode: kind === 'chatgpt' ? 'chatgpt' : 'openai', codexVersion: CODEX_VERSION,
            authJson: dummyAuthJson({ credentialId: c.credentialId, kind, planType: meta.planType ?? null, fedramp: meta.fedramp === true }, t) }
          unsubscribe = core.proxy.subscribe(turn.id, onProxy)
        }
        prepareCodexTurn(conf, chatDir)
        lr = buildCodexReaderLaunch({ turnId: turn.id, chatDir, token, systemPrompt: SYSTEM_PROMPT, message: blocksAsText(blocks), timeoutMs: READER_TIMEOUT_MS, ...(this.pick.model ? { model: this.pick.model } : {}), ...(proxy ? { proxy } : {}), ...(managed ? { managed } : {}) }, conf)
      }
      const parser = this.engine === 'claude-code' ? new ClaudeStreamParser() : new CodexEventParser()
      const usage = { input: 0, output: 0, costUsd: 0 }
      const errors: { code: string; message: string }[] = []
      let toolUse = false
      const h = core.launcher.launch(lr)
      kill = () => h.kill()
      const onAbort = () => h.kill()
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) h.kill()
      const out = new Utf8Lines()
      const err = new Utf8Text(4000)
      let exit: unknown = null
      const take = (l: string) => {
        if (!l.trim()) return
        for (const e of parser.push(l)) {
          if (e.type === 'usage') { usage.input += e.inputTokens; usage.output += e.outputTokens; usage.costUsd += e.costUsd ?? 0 }
          else if (e.type === 'error') errors.push({ code: e.code, message: e.message })
          else if (e.type === 'tool_start') { toolUse = true; h.kill() }
        }
      }
      try {
        for await (const e of h.events) {
          if (e.ev === 'started') core.turns.bind(turn.id, e.pgid)
          else if (e.ev === 'stdout') for (const l of out.push(Buffer.from(e.b64, 'base64'))) take(l)
          else if (e.ev === 'stderr') err.push(Buffer.from(e.b64, 'base64'))
          else if (e.ev === 'exit' || e.ev === 'error') exit = e
        }
        for (const l of out.end()) take(l)
      } finally { signal.removeEventListener('abort', onAbort) }
      // the usage of this call on its turn row, unless the model proxy counted it already (authoritative)
      if (usage.input || usage.output) {
        this.ctx.db.query("UPDATE turns SET input_tokens = ?, output_tokens = ?, cost_usd = ?, usage_source = 'engine' WHERE id = ? AND input_tokens = 0 AND output_tokens = 0")
          .run(usage.input, usage.output, usage.costUsd, turn.id)
      }
      signal.throwIfAborted()
      if (toolUse) throw new ReaderUnavailable('the reader tried to use a tool')
      if (limited) throw new ReaderLimit(`the AI reported a limit (${limited})`)
      if (refused) throw new ReaderUnavailable(`the AI connection was refused (${refused})`)
      const e = errors[0]
      if (e?.code === 'rate_limit') throw new ReaderLimit(e.message.slice(0, 200))
      if (e?.code === 'auth') throw new ReaderUnavailable(e.message.slice(0, 200))
      const text = parser.text
      if (e || !text) {
        this.ctx.log.warn('file list: reader call failed', { engine: this.engine, exit, code: e?.code ?? 'no_answer', stderr: err.text.slice(-500) })
        throw new Error(e ? `reader error (${e.code})` : 'reader gave no answer')
      }
      status = 'done'
      return { text, usage }
    } catch (e) {
      if (signal.aborted) status = 'stopped'
      throw e
    } finally {
      unsubscribe?.()
      try { revokeProxyTokens(this.ctx.db, turn.id) } catch {}
      core.turns.revoke(turn.id, status)
    }
  }
}

