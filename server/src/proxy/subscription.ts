// The model proxy as a server component (ModelProxyService), and the older single-token file. Managed mode
// (engine.authMode "managed", formerly "subscription"): the team's AI connections live in the database
// (credentials/*); the server runs the model proxy on 127.0.0.1:<engine.proxyPort>, the only address the firewall and
// the engine sandbox let the engine account reach, and every turn talks to it with a per-turn token (design tab 1
// "프록시 동작"). The owner's token file <install>/secrets/claude-oauth-token (root/set-claude-token, office
// --claude-token-file) is imported into an AI connection at start and when it changes (credentials/migrate.ts);
// TokenReader / TOKEN_RE / fingerprint below serve that import and the diagnostics.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { Database } from 'bun:sqlite'
import { startModelProxy, type ModelProxy, type ProxyOpts, type ProxyTurnEvent } from './model-proxy'
import type { CredentialBroker } from '../credentials/broker'

/** File in <install>/secrets that holds the owner's long-lived Claude subscription token (`claude setup-token`). The
 * proxy, the admin engine screen and the diagnostics all use this one name; root/set-claude-token writes it. */
export const CLAUDE_OAUTH_TOKEN_FILE = 'claude-oauth-token'
/** a setup-token is valid for one year; the file's modification time stands in for the day it was made */
export const SETUP_TOKEN_LIFETIME_MS = 365 * 24 * 3600_000
/** diagnostics warn this long before that */
export const SETUP_TOKEN_WARN_MS = 14 * 24 * 3600_000
export const TOKEN_RE = /^sk-ant-oat\d{2}-[A-Za-z0-9_-]{20,1000}$/
/** settings row: the upstream answered 401 for the token with this fingerprint */
export const REJECTED_KEY = 'subscription_token_rejected'

export const fingerprint = (t: string) => crypto.createHash('sha256').update(t).digest('hex').slice(0, 16)

export function tokenFile(secretsDir: string) { return path.join(secretsDir, CLAUDE_OAUTH_TOKEN_FILE) }

/** The token file's text, or null (missing, empty, not a regular file: a planted link is not followed). Cached by
 * inode / size / mtime, so the owner can replace the token while the server runs. */
export class TokenReader {
  private cache: { key: string; value: string | null } | null = null
  constructor(readonly file: string) {}
  read(): string | null {
    let st: fs.Stats
    try { st = fs.lstatSync(this.file) } catch { this.cache = null; return null }
    if (!st.isFile()) return null
    const key = `${st.ino}:${st.size}:${st.mtimeMs}`
    if (this.cache?.key === key) return this.cache.value
    let value: string | null = null
    try {
      const fd = fs.openSync(this.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
      try { value = fs.readFileSync(fd, 'utf8').trim() || null } finally { fs.closeSync(fd) }
    } catch { value = null }
    if (value && value.length > 4096) value = null
    this.cache = { key, value }
    return value
  }
}

export type TokenState = 'missing' | 'malformed' | 'ok' | 'expiring' | 'expired' | 'invalid'
export interface TokenStatus { state: TokenState; expiresAt: string | null }

/** Present? Plausible? Older than a year (expired) or close to it? Refused by the upstream (invalid)? Never returns the
 * token. `db` = the server's database (where the proxy keeps the fingerprint of a token the upstream refused). */
export function subscriptionTokenStatus(secretsDir: string, db: Database | null, now = Date.now()): TokenStatus {
  const file = tokenFile(secretsDir)
  let st: fs.Stats
  try { st = fs.lstatSync(file) } catch { return { state: 'missing', expiresAt: null } }
  const token = new TokenReader(file).read()
  if (!st.isFile() || !token) return { state: 'missing', expiresAt: null }
  const expiresAt = new Date(st.mtimeMs + SETUP_TOKEN_LIFETIME_MS)
  const at = expiresAt.toISOString()
  if (!TOKEN_RE.test(token)) return { state: 'malformed', expiresAt: null }
  if (db) {
    try {
      const r = db.query('SELECT value FROM settings WHERE key = ?').get(REJECTED_KEY) as { value: string } | null
      if (r && (JSON.parse(r.value) as { fp?: string }).fp === fingerprint(token)) return { state: 'invalid', expiresAt: at }
    } catch {}
  }
  if (expiresAt.getTime() <= now) return { state: 'expired', expiresAt: at }
  if (expiresAt.getTime() - now <= SETUP_TOKEN_WARN_MS) return { state: 'expiring', expiresAt: at }
  return { state: 'ok', expiresAt: at }
}

/** remember (DB) that the upstream refused this token; a new token file clears it by having another fingerprint */
export function markTokenRejected(db: Database, token: string) {
  db.query('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(REJECTED_KEY, JSON.stringify({ fp: fingerprint(token), at: new Date().toISOString() }))
}

export type ProxyState = 'starting' | 'listening' | 'port_in_use' | 'stopped'

export interface ProxyServiceOptions {
  db: Database
  port: number
  /** the team's AI connections; null = no model path on this proxy (503), CONNECT tunnels only (office local-login,
   * the ChatGPT sign-in) */
  broker: CredentialBroker | null
  /** the locked Codex catalog (models the Codex path forwards) */
  codexModels?: () => string[]
  secretsDir: string
  peerCheck?: ProxyOpts['peerCheck']
  /** CONNECT tunnels through the same port (office local-login Claude, the ChatGPT sign-in process) */
  connect?: ProxyOpts['connect']
  log?: { warn(msg: string, f?: Record<string, unknown>): void; info(msg: string, f?: Record<string, unknown>): void; debug?(msg: string, f?: Record<string, unknown>): void }
  /** why a turn was stopped (ProxyOpts.stopReason) */
  stopReason?: ProxyOpts['stopReason']
  /** bind retry (design tab 1 "리슨": every 10 s, no restart loop) */
  retryMs?: number
}

/**
 * The model proxy as a server component: binds 127.0.0.1:<port> without reusePort. When the port is taken, no engine
 * turn starts (fail closed, `ready` false, diagnostics say so) and the bind is tried again every 10 s. Turns subscribe
 * to what the proxy sees for their requests (a refused or limited connection, budget).
 */
export class ModelProxyService {
  state: ProxyState = 'starting'
  private proxy: ModelProxy | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private listeners = new Map<string, (ev: ProxyTurnEvent) => void>()

  constructor(private o: ProxyServiceOptions) {}

  /** the AI connections behind this proxy (null: none, see ProxyServiceOptions.broker) */
  get broker() { return this.o.broker }

  get ready() { return this.state === 'listening' }
  get baseUrl() { return `http://127.0.0.1:${this.port}` }
  /** the bound port (the configured one; with port 0, the one the OS gave once listening) */
  get port() { return this.proxy?.port ?? this.o.port }

  /** the first bind attempt (resolves either way; `ready` says whether it is listening) */
  started: Promise<void> = Promise.resolve()

  start(): this {
    if (this.state === 'stopped') return this
    this.started = startModelProxy({
      db: this.o.db, port: this.o.port, broker: this.o.broker,
      ...(this.o.codexModels ? { codexModels: this.o.codexModels } : {}),
      ...(this.o.log ? { log: this.o.log } : {}),
      peerCheck: this.o.peerCheck,
      ...(this.o.stopReason ? { stopReason: this.o.stopReason } : {}),
      ...(this.o.connect ? { connect: this.o.connect } : {}),
      onTurnEvent: (turnId, ev) => this.listeners.get(turnId)?.(ev),
    }).then((p) => {
      if (this.state === 'stopped') { void p.stop(); return }
      this.proxy = p
      if (this.state !== 'listening') this.o.log?.info('model proxy listening', { port: this.o.port })
      this.state = 'listening'
    }, (e) => {
      if (this.state === 'stopped') return
      if (this.state !== 'port_in_use') this.o.log?.warn('model proxy port in use; engine turns wait until it is free', { port: this.o.port, err: (e as Error).message })
      this.state = 'port_in_use'
      this.timer = setTimeout(() => { this.timer = null; this.start() }, this.o.retryMs ?? 10_000)
      ;(this.timer as { unref?: () => void }).unref?.()
    })
    return this
  }

  /** events for one turn's requests; returns the unsubscribe function */
  subscribe(turnId: string, fn: (ev: ProxyTurnEvent) => void): () => void {
    this.listeners.set(turnId, fn)
    return () => { if (this.listeners.get(turnId) === fn) this.listeners.delete(turnId) }
  }

  async stop() {
    this.state = 'stopped'
    if (this.timer) clearTimeout(this.timer)
    const p = this.proxy
    this.proxy = null
    await p?.stop()
  }
}
