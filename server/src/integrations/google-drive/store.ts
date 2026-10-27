import type { Database } from 'bun:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import type { DriveConnection, DriveFlow } from '@mycel/shared/api'
import { Vault, detectVersion } from '../../credentials/vault'
import { ToolError } from '../../policy/errors'

export class DriveError extends ToolError {
  constructor(readonly reason: string, readonly status = 400) { super(`drive_${reason}`) }
}
export interface Account { subject: string; name: string | null; email: string | null }
export interface Tokens { accessToken: string; refreshToken: string; expiresAt: number }
export interface FlowSecret { verifier: string; tokens?: Tokens; account?: Account; scopes?: string[] }
export interface ConnectionRow { id: string; user_id: string; config_key: string; account: string; scopes: string; secret_enc: string; key_version: number; status: 'connected' | 'needs_reconnect'; version: number; expires_at: string; updated_at: string }
export interface FlowRow { id: string; user_id: string; session_id: string; state_hash: string; config_key: string; state: DriveFlow['state']; secret_enc: string | null; key_version: number; account: string | null; reason: string | null; expires_at: string }

export class DriveStore {
  vault: Vault
  constructor(readonly db: Database, readonly secretsDir: string, readonly now = Date.now) { this.vault = new Vault(secretsDir) }
  active(user: string) {
    if (!this.db.query("SELECT 1 FROM users WHERE id=? AND status='active' AND deleted_at IS NULL AND must_change_password=0").get(user)) throw new DriveError('access_denied', 403)
  }
  session(user: string, session: string) {
    this.active(user)
    if (!this.db.query('SELECT 1 FROM sessions WHERE id=? AND user_id=? AND expires_at>?').get(session, user, new Date(this.now()).toISOString())) throw new DriveError('session_ended', 401)
  }
  connection(user: string) { return this.db.query('SELECT * FROM drive_connections WHERE user_id=?').get(user) as ConnectionRow | null }
  flow(id: string) { return this.db.query('SELECT * FROM drive_oauth_flows WHERE id=?').get(id) as FlowRow | null }
  /** The dedicated secret subtree must never follow a planted directory symlink. */
  safeDirectory(create = false) {
    const root = path.dirname(path.dirname(this.secretsDir))
    for (const dir of [root, path.dirname(this.secretsDir), this.secretsDir]) {
      if (create && !fs.existsSync(dir)) fs.mkdirSync(dir, { mode: 0o700 })
      const st = fs.lstatSync(dir)
      if (st.isSymbolicLink() || !st.isDirectory() || (st.mode & 0o077) !== 0 || (process.getuid && st.uid !== process.getuid())) throw new DriveError('key_unsafe', 503)
    }
  }
  seal(user: string, id: string, value: unknown) {
    try {
      this.safeDirectory(true)
      const version = detectVersion(this.secretsDir)
      if (version !== this.vault.version) this.vault = new Vault(this.secretsDir, version)
      return this.vault.encrypt(`${user}:${id}`, 'google-drive', value)
    } catch { throw new DriveError('key_unsafe', 503) }
  }
  open<T>(row: { id: string; user_id: string; secret_enc: string | null; key_version: number }): T {
    try { this.safeDirectory(); return this.vault.decrypt(`${row.user_id}:${row.id}`, 'google-drive', row.secret_enc ?? '', row.key_version) as T }
    catch { throw new DriveError('needs_reconnect', 409) }
  }
  assertCurrent(row: ConnectionRow) {
    this.active(row.user_id)
    const current = this.connection(row.user_id)
    if (!current || current.id !== row.id || current.version !== row.version || current.status !== 'connected') throw new DriveError('disconnected', 409)
  }
  publicConnection(configured: boolean, user: string, key: string): DriveConnection {
    this.active(user)
    const row = this.connection(user)
    if (!configured) return { configured: false, status: 'disabled', account: null, scopes: [], expiresAt: null }
    if (!row) return { configured: true, status: 'disconnected', account: null, scopes: [], expiresAt: null }
    let status: DriveConnection['status'] = row.config_key === key ? row.status : 'needs_reconnect'
    try { this.open(row) } catch { status = 'needs_reconnect' }
    const a = JSON.parse(row.account) as Account
    return { configured: true, status, account: { name: a.name, email: a.email }, scopes: JSON.parse(row.scopes), expiresAt: row.expires_at }
  }
  ownFlow(user: string, session: string, id: string): FlowRow {
    this.session(user, session)
    this.sweep()
    const row = this.flow(id)
    if (!row || row.user_id !== user || row.session_id !== session) throw new DriveError('not_found', 404)
    return row
  }
  sweep() {
    const now = new Date(this.now()).toISOString()
    this.db.query("UPDATE drive_oauth_flows SET state='expired',secret_enc=NULL,account=NULL WHERE expires_at<=? AND state NOT IN ('completed','failed','expired')").run(now)
    this.db.query('DELETE FROM drive_oauth_flows WHERE expires_at<?').run(new Date(this.now() - 86_400_000).toISOString())
  }
}
