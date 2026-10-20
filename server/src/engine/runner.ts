// One chat turn end to end: token, launcher, stream parsing, pid binding, session stash/restore,
// resume fallback, refusal retry, audit and usage records.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { EngineEvent } from '@mycel/shared'
import type { Running } from '../server'
import { buildSystemPrompt } from './prompt'
import { buildClaudeLaunch, type ClaudeConf } from './claude'
import { buildCodexLaunch, prepareCodexHome, type CodexConf } from './codex'
import { ClaudeStreamParser } from './claude-parse'
import { CodexEventParser } from './codex-parse'
import type { LaunchRequest } from '@mycel/shared'
import { newId } from '../db'
import { issueProxyToken, revokeProxyTokens } from '../proxy/model-proxy'

export interface TurnRequest {
  userId: string; chatId: string; message: string
  engine: 'claude-code' | 'codex'
  model?: string; fallbackModel?: string
  maxTurns?: number; timeoutMs?: number
  onEvent?: (e: EngineEvent) => void
}
export interface TurnResult {
  turnId: string; text: string; events: EngineEvent[]; sessionId: string | null
  error: { code: string; message: string } | null
  retried: ('refused' | 'resume')[]
  init?: any; result?: any; codexItems?: Map<string, number>; exitCode: number | null; stderr: string
}

export class TurnRunner {
  private locks = new Map<string, Promise<unknown>>()
  constructor(private srv: Running, private engines: { claude?: ClaudeConf; codex?: CodexConf }) {}

  /** one turn per chat at a time */
  run(req: TurnRequest): Promise<TurnResult> {
    const prev = this.locks.get(req.chatId) ?? Promise.resolve()
    const next = prev.catch(() => {}).then(() => this.runLocked(req))
    this.locks.set(req.chatId, next)
    return next.finally(() => { if (this.locks.get(req.chatId) === next) this.locks.delete(req.chatId) })
  }

  private sessionStash(chatId: string, sid: string) { return path.join(this.srv.cfg.dataDir, 'sessions', chatId, `${sid}.jsonl`) }

  private history(chatId: string): string {
    const rows = this.srv.db.query("SELECT role, content FROM messages WHERE chat_id = ? AND status = 'done' ORDER BY created_at, rowid").all(chatId) as any[]
    if (!rows.length) return ''
    const body = rows.map((r) => `${r.role === 'user' ? 'User' : 'Assistant'}: ${r.content}`).join('\n\n')
    return `<earlier_conversation>\n${body.slice(-30000)}\n</earlier_conversation>\n\n`
  }

  private async runLocked(req: TurnRequest): Promise<TurnResult> {
    const { db, turns, files, cfg } = this.srv
    const user = files.principal(req.userId)
    db.query('INSERT OR IGNORE INTO chats (id, user_id, engine, model) VALUES (?,?,?,?)').run(req.chatId, req.userId, req.engine, req.model ?? null)
    const chat = db.query('SELECT * FROM chats WHERE id = ?').get(req.chatId) as any
    if (chat.user_id !== req.userId) throw new Error('chat belongs to another user')
    const historyText = this.history(req.chatId)
    db.query("INSERT INTO messages (id, chat_id, role, content, status) VALUES (?,?,?,?, 'done')").run(newId(), req.chatId, 'user', req.message)
    const { turn, token } = turns.create(req.userId, req.chatId, req.engine, req.model ?? null)
    const chatDir = path.join(cfg.agentRoot, req.chatId)
    const systemPrompt = buildSystemPrompt(files, user)
    const res: TurnResult = { turnId: turn.id, text: '', events: [], sessionId: null, error: null, retried: [], exitCode: null, stderr: '' }
    try {
      if (req.engine === 'claude-code') await this.claudeTurn(req, res, { turnId: turn.id, token, chatDir, systemPrompt, chat, historyText })
      else await this.codexTurn(req, res, { turnId: turn.id, token, chatDir, systemPrompt, historyText })
    } finally {
      const usage = res.events.filter((e) => e.type === 'usage') as any[]
      const sum = usage.reduce((a, u) => ({ i: a.i + u.inputTokens, o: a.o + u.outputTokens, c: a.c + (u.costUsd ?? 0) }), { i: 0, o: 0, c: 0 })
      turns.revoke(turn.id, res.error ? 'error' : 'done', res.error?.message)
      revokeProxyTokens(db, turn.id)
      // in proxy mode the proxy already counted usage itself (authoritative); engine-reported numbers only fill in otherwise
      db.query('UPDATE turns SET input_tokens = ?, output_tokens = ?, cost_usd = ? WHERE id = ? AND input_tokens = 0 AND output_tokens = 0').run(sum.i, sum.o, sum.c, turn.id)
      db.query('INSERT INTO messages (id, chat_id, role, content, status, error, steps) VALUES (?,?,?,?,?,?,?)').run(newId(), req.chatId, 'assistant', res.text,
        res.error ? 'error' : 'done', res.error?.message ?? null, JSON.stringify(res.events.filter((e) => e.type === 'tool_start').map((e: any) => e.name)))
      db.query('UPDATE chats SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), req.chatId)
    }
    return res
  }

  /** launch through the launcher; feed stdout lines to `onLine`; bind the engine's process group to the turn */
  private async launch(turnId: string, lr: LaunchRequest, onLine: (l: string) => void) {
    const h = this.srv.launcher!.launch(lr)
    let buf = '', stderr = '', exit: any = null
    for await (const e of h.events) {
      if (e.ev === 'started') this.srv.turns.bind(turnId, e.pgid)
      else if (e.ev === 'stdout') {
        buf += Buffer.from(e.b64, 'base64').toString('utf8')
        let i
        while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) onLine(l) }
      } else if (e.ev === 'stderr') { if (stderr.length < 20000) stderr += Buffer.from(e.b64, 'base64').toString('utf8') }
      else if (e.ev === 'exit' || e.ev === 'error') exit = e
    }
    if (buf.trim()) onLine(buf)
    return { exit, stderr }
  }

  private async claudeTurn(req: TurnRequest, res: TurnResult, t: { turnId: string; token: string; chatDir: string; systemPrompt: string; chat: any; historyText: string }) {
    const conf = this.engines.claude!
    let sid: string = t.chat.engine_session_id ?? ''
    let resume = !!sid && fs.existsSync(this.sessionStash(req.chatId, sid))
    if (!resume) sid = crypto.randomUUID()
    let stashFile: string
    let model = req.model
    const proxyToken = conf.authMode === 'proxy' ? issueProxyToken(this.srv.db, t.turnId, req.userId, { ttlMs: (req.timeoutMs ?? 20 * 60_000) + 60_000 }) : undefined
    for (let attempt = 0; attempt < 3; attempt++) {
      const parser = new ClaudeStreamParser()
      const events: EngineEvent[] = []
      const message = resume ? req.message : t.historyText + req.message
      const lr = buildClaudeLaunch({ turnId: t.turnId, chatDir: t.chatDir, token: t.token, systemPrompt: t.systemPrompt, message, sessionId: sid, resume,
        stash: resume ? fs.readFileSync(this.sessionStash(req.chatId, sid)) : null, model, maxTurns: req.maxTurns ?? 12, timeoutMs: req.timeoutMs ?? 20 * 60_000, proxyToken }, conf)
      const { exit, stderr } = await this.launch(t.turnId, lr, (l) => { for (const e of parser.push(l)) { events.push(e); req.onEvent?.(e) } })
      res.exitCode = exit?.code ?? null; res.stderr = stderr; res.init = parser.init; res.result = parser.result
      const noConv = /No conversation found/i.test(stderr + JSON.stringify(parser.result ?? ''))
      if (resume && noConv && !res.retried.includes('resume')) { // stash lost/unusable -> fresh session from DB history
        res.retried.push('resume'); resume = false; sid = crypto.randomUUID(); continue
      }
      if (parser.refused && !res.retried.includes('refused')) { // safety classifier declined a normal request -> one retry on another model
        res.retried.push('refused'); res.events.push({ type: 'error', code: 'refused', message: 'declined; retrying with another model' })
        model = req.fallbackModel ?? (model?.includes('sonnet') ? 'opus' : 'sonnet'); continue
      }
      res.events.push(...events)
      res.text = parser.text
      res.sessionId = parser.sessionId ?? sid
      const err = events.find((e) => e.type === 'error') as any
      if (err) res.error = { code: err.code, message: err.message }
      else if (exit?.ev === 'error') res.error = { code: 'crash', message: exit.message }
      else if (exit?.code && !parser.result) res.error = { code: exit.signal === 'timeout' ? 'timeout' : 'crash', message: stderr.slice(-500) || `engine exited ${exit.code}` }
      if (exit?.session?.b64) {
        stashFile = this.sessionStash(req.chatId, sid)
        fs.mkdirSync(path.dirname(stashFile), { recursive: true, mode: 0o700 })
        fs.writeFileSync(stashFile, Buffer.from(exit.session.b64, 'base64'), { mode: 0o600 })
        this.srv.db.query('UPDATE chats SET engine_session_id = ?, engine = ? WHERE id = ?').run(sid, 'claude-code', req.chatId)
        this.srv.db.query('UPDATE turns SET engine_session_blob = ? WHERE id = ?').run(stashFile, t.turnId)
      }
      res.events.push({ type: 'done' })
      return
    }
  }

  private async codexTurn(req: TurnRequest, res: TurnResult, t: { turnId: string; token: string; chatDir: string; systemPrompt: string; historyText: string }) {
    const conf = this.engines.codex!
    prepareCodexHome(conf.codexHome, conf.auth)
    const parser = new CodexEventParser()
    const lr = buildCodexLaunch({ turnId: t.turnId, chatDir: t.chatDir, token: t.token, systemPrompt: t.systemPrompt, message: t.historyText + req.message, timeoutMs: req.timeoutMs ?? 20 * 60_000 }, conf)
    const { exit, stderr } = await this.launch(t.turnId, lr, (l) => { for (const e of parser.push(l)) { res.events.push(e); req.onEvent?.(e) } })
    prepareCodexHome(conf.codexHome, conf.auth) // move a refreshed auth.json back to the real login
    res.exitCode = exit?.code ?? null; res.stderr = stderr; res.codexItems = parser.itemTypes
    res.text = parser.text; res.sessionId = parser.sessionId
    const err = res.events.find((e) => e.type === 'error') as any
    if (err) res.error = { code: err.code, message: err.message }
    else if (exit?.code) res.error = { code: 'crash', message: stderr.slice(-500) }
    res.events.push({ type: 'done' })
  }
}
