// Connections in the database (server/migrations/313_c_integrations.sql) and their secrets. Keys and OAuth tokens are
// AES-256-GCM encrypted with the Vault primitive in a dedicated key directory (<secrets>/integrations/connections),
// the AAD binding each secret to its connection ("<scope>:<owner or team>:<id>") or sign-in flow; the directory is
// checked like Drive's (owned by the server account, 0700, no links). Who may use a connection is decided here.
import type { Database } from 'bun:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import type { Integration, IntegrationAccess, Locale, Role } from '@mycel/shared/api'
import { Vault, detectVersion } from '../../credentials/vault'
import { getTeamSettings } from '../../admin/settings'
import type { RemoteTool } from './mcp'
import { reasonText } from './text'

export interface Row {
  id: string; scope: 'personal' | 'team'; owner_user_id: string | null; created_by: string | null
  kind: 'mcp' | 'http'; name: string; slug: string; url: string; auth: 'none' | 'bearer' | 'header' | 'oauth'; auth_header: string | null
  secret_enc: string | null; key_version: number; account: string | null; notes: string | null; write_policy: 'ask' | 'allow' | 'deny'
  status: 'connected' | 'needs_auth' | 'error'; last_error: string | null; tools_json: string; tools_updated_at: string | null
  last_used_at: string | null; version: number; created_at: string; updated_at: string
}
export interface FlowRow {
  id: string; integration_id: string; integration_version: number; user_id: string; session_id: string; state_hash: string
  state: 'pending' | 'exchanging' | 'completed' | 'failed' | 'expired'; secret_enc: string | null; key_version: number; reason: string | null
  expires_at: string; created_at: string
}

export class StoreError extends Error { name = 'StoreError'; constructor(readonly code: 'key_unsafe' | 'unreadable') { super(code) } }

/** The person behind a request or a chat. */
export interface Viewer { id: string; role: Role }

export const isAdmin = (role: Role) => role === 'admin' || role === 'owner'

export function activeUser(db: Database, id: string): Viewer | null {
  return db.query("SELECT id, role FROM users WHERE id = ? AND status = 'active' AND deleted_at IS NULL AND must_change_password = 0").get(id) as Viewer | null
}

export function getRow(db: Database, id: string): Row | null { return db.query('SELECT * FROM integrations WHERE id = ?').get(id) as Row | null }

export function accessOf(db: Database, id: string): IntegrationAccess {
  const rows = db.query('SELECT subject_type, subject_id FROM integration_access WHERE integration_id = ? ORDER BY subject_type, subject_id').all(id) as { subject_type: string; subject_id: string }[]
  return { everyone: rows.some((r) => r.subject_type === 'everyone'), groups: rows.filter((r) => r.subject_type === 'group').map((r) => r.subject_id), users: rows.filter((r) => r.subject_type === 'user').map((r) => r.subject_id) }
}

export function setAccess(db: Database, id: string, a: IntegrationAccess): void {
  db.query('DELETE FROM integration_access WHERE integration_id = ?').run(id)
  const ins = db.query('INSERT OR IGNORE INTO integration_access (integration_id, subject_type, subject_id) VALUES (?,?,?)')
  if (a.everyone) ins.run(id, 'everyone', '')
  for (const g of new Set(a.groups)) ins.run(id, 'group', g)
  for (const u of new Set(a.users)) ins.run(id, 'user', u)
}

const personalOn = (db: Database) => getTeamSettings(db).personalIntegrations

/** May this (active) person use the connection in their chats now? Personal: only its owner, only while the team
 * allows personal connections. Team: an access rule must match; being an admin is not one. */
export function mayUse(db: Database, row: Row, userId: string): boolean {
  if (!activeUser(db, userId)) return false
  if (row.scope === 'personal') return row.owner_user_id === userId && personalOn(db)
  return !!db.query(`SELECT 1 FROM integration_access a WHERE a.integration_id = ? AND (a.subject_type = 'everyone'
    OR (a.subject_type = 'user' AND a.subject_id = ?)
    OR (a.subject_type = 'group' AND a.subject_id IN (SELECT group_id FROM group_members WHERE user_id = ?))) LIMIT 1`).get(row.id, userId, userId)
}

/** The active people a connection's results may reach today (read scope of a chat, chat/read-scope.ts). */
export function usersOf(db: Database, id: string): Set<string> {
  const row = getRow(db, id)
  if (!row) return new Set()
  const people = db.query("SELECT id FROM users WHERE status = 'active' AND deleted_at IS NULL").all() as { id: string }[]
  return new Set(people.map((p) => p.id).filter((u) => mayUse(db, row, u)))
}

/** Connections the person may use in a chat now, personal first. */
export function usable(db: Database, userId: string): Row[] {
  if (!activeUser(db, userId)) return []
  const personal = personalOn(db) ? db.query("SELECT * FROM integrations WHERE scope = 'personal' AND owner_user_id = ? ORDER BY name, id").all(userId) as Row[] : []
  const team = (db.query("SELECT * FROM integrations WHERE scope = 'team' ORDER BY name, id").all() as Row[]).filter((r) => mayUse(db, r, userId))
  return [...personal, ...team]
}

export function savedTools(row: Row): RemoteTool[] {
  try { const v = JSON.parse(row.tools_json); return Array.isArray(v) ? v : [] } catch { return [] }
}

/** The address without its query: what people who only use a connection (and the AI) see of it. */
export const bareUrl = (u: string) => { const x = new URL(u); return x.origin + x.pathname }

/** What the API shows: never a key or token (only hasSecret). */
export function view(db: Database, row: Row, viewer: Viewer, locale: Locale): Integration {
  const manage = row.scope === 'personal' ? row.owner_user_id === viewer.id : isAdmin(viewer.role)
  const creator = row.created_by ? db.query('SELECT id, name FROM users WHERE id = ?').get(row.created_by) as { id: string; name: string } | null : null
  return {
    id: row.id, scope: row.scope, kind: row.kind, name: row.name, slug: row.slug, url: manage ? row.url : bareUrl(row.url), auth: row.auth, authHeader: row.auth_header,
    hasSecret: !!row.secret_enc, account: row.account, notes: row.notes, writePolicy: row.write_policy, status: row.status,
    lastError: reasonText(row.last_error, locale),
    tools: savedTools(row).map((t) => ({ name: t.name, title: t.title, description: t.description, readOnly: t.readOnly })),
    toolsUpdatedAt: row.tools_updated_at, access: row.scope === 'team' && manage ? accessOf(db, row.id) : null,
    createdBy: creator, createdAt: row.created_at, updatedAt: row.updated_at, lastUsedAt: row.last_used_at, canManage: manage,
  }
}

/** The dedicated key directory and its Vault. */
export class SecretBox {
  vault: Vault
  constructor(readonly dir: string) { this.vault = new Vault(dir) }
  /** the dedicated subtree must never follow a planted link or be readable by other accounts */
  safeDirectory(create = false) {
    const root = path.dirname(path.dirname(this.dir))
    for (const d of [root, path.dirname(this.dir), this.dir]) {
      if (create && !fs.existsSync(d)) fs.mkdirSync(d, { mode: 0o700 })
      const st = fs.lstatSync(d)
      if (st.isSymbolicLink() || !st.isDirectory() || (st.mode & 0o077) !== 0 || (process.getuid && st.uid !== process.getuid())) throw new StoreError('key_unsafe')
    }
  }
  seal(aad: string, value: unknown): { enc: string; keyVersion: number } {
    try {
      this.safeDirectory(true)
      const v = detectVersion(this.dir)
      if (v !== this.vault.version) this.vault = new Vault(this.dir, v)
      return this.vault.encrypt(aad, 'integration', value)
    } catch { throw new StoreError('key_unsafe') }
  }
  open<T>(aad: string, enc: string | null, keyVersion: number): T {
    try { this.safeDirectory(); return this.vault.decrypt(aad, 'integration', enc ?? '', keyVersion) as T }
    catch { throw new StoreError('unreadable') }
  }
}

export const connectionAad = (r: Pick<Row, 'id' | 'scope' | 'owner_user_id'>) => `${r.scope}:${r.owner_user_id ?? 'team'}:${r.id}`
export const flowAad = (f: Pick<FlowRow, 'id' | 'user_id'>) => `flow:${f.user_id}:${f.id}`
