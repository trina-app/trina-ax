// Connections in the database (server/migrations/313_c_integrations.sql) and their secrets. Keys and OAuth tokens are
// AES-256-GCM encrypted with the Vault primitive in a dedicated key directory (<secrets>/integrations/connections),
// the AAD binding each secret to its connection ("<scope>:<owner or team>:<id>") or sign-in flow; the directory is
// checked like Drive's (owned by the server account, 0700, no links). Who may use a connection is decided here.
import type { Database } from 'bun:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import type { Integration, IntegrationAccess, Locale, OAuthClientView, Role } from '@mycel/shared/api'
import { Vault, detectVersion } from '../../credentials/vault'
import { audit } from '../../admin/audit'
import { getTeamSettings } from '../../admin/settings'
import type { RemoteTool } from './mcp'
import { reasonText } from './text'

export interface Row {
  id: string; scope: 'personal' | 'team'; owner_user_id: string | null; created_by: string | null
  kind: 'mcp' | 'http'; name: string; slug: string; url: string; auth: 'none' | 'bearer' | 'header' | 'oauth'; auth_header: string | null
  secret_enc: string | null; key_version: number; account: string | null; notes: string | null; write_policy: 'ask' | 'allow' | 'deny'
  status: 'connected' | 'needs_auth' | 'error'; last_error: string | null; tools_updated_at: string | null
  /** moves on whenever the saved tool list (tools_json) changes (migration 330). tools_json itself is not part of a
   * row (it can be 4,000,000 characters): savedTools reads it, parsed once per tools_rev. */
  tools_rev: number
  /** how many tools the server offers when that is more than tools_json keeps (the hard ceiling, mcp.ts MAX_TOOLS);
   * null otherwise */
  tools_total?: number | null
  /** 1: the check stopped reading the server's list with pages left, so it offers more than tools_total */
  tools_total_more?: number
  last_used_at: string | null; version: number; created_at: string; updated_at: string
  /** JSON list of the service's tool names turned off (migration 328); every other tool is on */
  disabled_tools: string
  /** a member's own connection made from an admin's template (templates.ts, migration 333); null otherwise */
  template_id?: string | null
  /** sign-in through its own app (migration 338): ClientInfo as JSON, and the client secret sealed with clientAad */
  oauth_client?: string | null
  oauth_client_enc?: string | null
  oauth_client_key_version?: number
}

/** what is not secret about an own app (integrations.oauth_client, integration_templates.oauth_client) */
export interface ClientInfo { clientId: string; authorizationUrl: string | null; tokenUrl: string | null; scope: string | null }
/** The stored app, or null (none, or a value that is not one: the column is ours alone). */
export function clientInfo(json: string | null | undefined): ClientInfo | null {
  if (!json) return null
  try {
    const v = JSON.parse(json)
    if (!v || typeof v.clientId !== 'string' || !v.clientId) return null
    const str = (x: unknown) => (typeof x === 'string' && x ? x : null)
    return { clientId: v.clientId, authorizationUrl: str(v.authorizationUrl), tokenUrl: str(v.tokenUrl), scope: str(v.scope) }
  } catch { return null }
}
/** what whoever manages it sees of an own app: never the secret */
export function clientView(json: string | null | undefined, enc: string | null | undefined): OAuthClientView | null {
  const c = clientInfo(json)
  return c ? { ...c, hasSecret: !!enc } : null
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

/** at most this much saved tool JSON (characters, about its bytes) is kept parsed in memory per database, the list
 * used longest ago going first. Connections that hold more together (each up to 4,000,000 characters; 20 personal
 * and 50 team ones) have the lists that do not fit read and parsed again when used, as every turn did before. */
export const TOOL_LISTS_MAX = 64 * 1024 * 1024

/** Saved tool lists of connections, parsed, by connection and tools_rev: a turn (and a call) reads and parses only a
 * list that changed. Only the service's definitions are held, frozen, never a decision: who may use a connection and
 * which of its tools are turned off are read again with every turn and every call (usable, mayUse, disabledTools). */
export class ToolLists {
  private lists = new Map<string, { rev: number; tools: readonly RemoteTool[]; size: number }>()
  /** the characters of saved JSON held */
  size = 0
  constructor(readonly max = TOOL_LISTS_MAX) {}
  get(id: string, rev: number): readonly RemoteTool[] | undefined {
    const e = this.lists.get(id)
    if (!e || e.rev !== rev) return undefined
    // the most recently used last
    this.lists.delete(id)
    this.lists.set(id, e)
    return e.tools
  }
  set(id: string, rev: number, tools: readonly RemoteTool[], size: number): void {
    this.drop(id)
    if (size > this.max) return
    this.lists.set(id, { rev, tools, size })
    this.size += size
    for (const [k, e] of this.lists) {
      if (this.size <= this.max) break
      this.lists.delete(k)
      this.size -= e.size
    }
  }
  drop(id: string): void {
    const e = this.lists.get(id)
    if (e) { this.lists.delete(id); this.size -= e.size }
  }
  /** the connections whose lists are held, used longest ago first */
  ids(): string[] { return [...this.lists.keys()] }
}

/** A parsed list is shared by every turn that uses the connection: nothing may change it. */
function freeze<T>(value: T): T {
  const todo: unknown[] = [value]
  while (todo.length) {
    const v = todo.pop()
    if (!v || typeof v !== 'object' || Object.isFrozen(v)) continue
    Object.freeze(v)
    for (const x of Object.values(v)) todo.push(x)
  }
  return value
}

const perDb = new WeakMap<Database, { columns: string; lists: ToolLists }>()
function stateOf(db: Database) {
  let s = perDb.get(db)
  if (!s) {
    const columns = (db.query('PRAGMA table_info(integrations)').all() as { name: string }[]).map((c) => c.name).filter((n) => n !== 'tools_json')
    s = { columns: columns.join(', '), lists: new ToolLists() }
    if (columns.length) perDb.set(db, s)
  }
  return s
}

/** "SELECT <every column but tools_json> FROM integrations": what reads a connection as a Row. Reading tools_json
 * with the other columns copied every saved list out of the database with every turn. */
export const selectRows = (db: Database) => `SELECT ${stateOf(db).columns} FROM integrations`

/** this database's parsed tool lists (tests) */
export const toolListsOf = (db: Database) => stateOf(db).lists

export function getRow(db: Database, id: string): Row | null { return db.query(`${selectRows(db)} WHERE id = ?`).get(id) as Row | null }

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
  if (row.scope === 'personal') return row.owner_user_id === userId && (row.template_id ? templateCovers(db, row.template_id, userId) : personalOn(db))
  return !!db.query(`SELECT 1 FROM integration_access a WHERE a.integration_id = ? AND (a.subject_type = 'everyone'
    OR (a.subject_type = 'user' AND a.subject_id = ?)
    OR (a.subject_type = 'group' AND a.subject_id IN (SELECT group_id FROM group_members WHERE user_id = ?))) LIMIT 1`).get(row.id, userId, userId)
}

/** Is this person among the people an admin's template is for (templates.ts)? A template that is gone covers nobody.
 * A member's connection made from it is usable only while this holds (and the team's switch for members' own
 * connections does not apply: the admin registered the service). */
export function templateCovers(db: Database, templateId: string, userId: string): boolean {
  return !!db.query(`SELECT 1 FROM integration_template_access a WHERE a.template_id = ? AND (a.subject_type = 'everyone'
    OR (a.subject_type = 'user' AND a.subject_id = ?)
    OR (a.subject_type = 'group' AND a.subject_id IN (SELECT group_id FROM group_members WHERE user_id = ?))) LIMIT 1`).get(templateId, userId, userId)
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
  // a member's own connections while the team allows them; the ones made from an admin's template while it covers them
  const on = personalOn(db)
  const personal = (db.query(`${selectRows(db)} WHERE scope = 'personal' AND owner_user_id = ? ORDER BY name, id`).all(userId) as Row[])
    .filter((r) => (r.template_id ? templateCovers(db, r.template_id, userId) : on))
  const team = (db.query(`${selectRows(db)} WHERE scope = 'team' ORDER BY name, id`).all() as Row[]).filter((r) => mayUse(db, r, userId))
  return [...personal, ...team]
}

/** The connection's saved tool list (tools_json), parsed once per tools_rev (ToolLists): the same frozen list for every
 * turn and call until a check saves another one. A row read before the list changed gets the newer list. */
export function savedTools(db: Database, row: Pick<Row, 'id' | 'tools_rev'>): readonly RemoteTool[] {
  const lists = stateOf(db).lists
  const held = lists.get(row.id, row.tools_rev)
  if (held) return held
  const r = db.query('SELECT tools_json, tools_rev FROM integrations WHERE id = ?').get(row.id) as { tools_json: string; tools_rev: number } | null
  if (!r) return []
  let tools: RemoteTool[] = []
  try { const v = JSON.parse(r.tools_json); if (Array.isArray(v)) tools = v } catch {}
  lists.set(row.id, r.tools_rev, freeze(tools), r.tools_json.length)
  return tools
}

/** How many tools the connection's server offers when the server keeps fewer of them (over the hard ceiling, mcp.ts
 * MAX_TOOLS / MAX_SCHEMAS_CHARS, or a list an older server cut), else null. `more`: it offers more than `total` (the
 * check stopped reading its list with pages left, mcp.ts listTools). */
export function toolsOffered(db: Database, row: Row): { total: number; more: boolean } | null {
  const n = row.tools_total, more = row.tools_total_more === 1, kept = savedTools(db, row).length
  // none kept: a moved connection not checked again yet (its old count says nothing)
  return typeof n === 'number' && kept > 0 && (n > kept || (more && n >= kept)) ? { total: n, more } : null
}

const toolsTotalOf = (db: Database, row: Row): { toolsTotal?: number; toolsTotalMore?: true } => {
  const n = toolsOffered(db, row)
  return n === null ? {} : n.more ? { toolsTotal: n.total, toolsTotalMore: true } : { toolsTotal: n.total }
}

/** at most this many names are kept turned off per connection (twice the MAX_TOOLS a connection keeps, so every tool
 * can be off with room for names of tools the service no longer lists) */
export const MAX_DISABLED_TOOLS = 2000
/** The service's tool names turned off for this connection. A bad value turns nothing off (the column is ours alone). */
export function disabledTools(row: Pick<Row, 'disabled_tools'>): Set<string> {
  try { const v = JSON.parse(row.disabled_tools ?? '[]'); return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []) } catch { return new Set() }
}

/** The address without its query: what people who only use a connection (and the AI) see of it. */
export const bareUrl = (u: string) => { const x = new URL(u); return x.origin + x.pathname }

/** What the API shows: never a key or token (only hasSecret). */
export function view(db: Database, row: Row, viewer: Viewer, locale: Locale): Integration {
  const manage = row.scope === 'personal' ? row.owner_user_id === viewer.id : isAdmin(viewer.role)
  const creator = row.created_by ? db.query('SELECT id, name FROM users WHERE id = ?').get(row.created_by) as { id: string; name: string } | null : null
  return {
    // made from an admin's template: the bare address even to its member (a query there is the admin's, never theirs)
    id: row.id, scope: row.scope, kind: row.kind, name: row.name, slug: row.slug, url: manage && !row.template_id ? row.url : bareUrl(row.url), auth: row.auth, authHeader: row.auth_header,
    hasSecret: !!row.secret_enc, account: row.account, notes: row.notes, writePolicy: row.write_policy, status: row.status,
    lastError: reasonText(row.last_error, locale),
    tools: ((off) => savedTools(db, row).map((t) => ({ name: t.name, title: t.title, description: t.description, readOnly: t.readOnly, enabled: !off.has(t.name) })))(disabledTools(row)),
    ...toolsTotalOf(db, row),
    toolsUpdatedAt: row.tools_updated_at, access: row.scope === 'team' && manage ? accessOf(db, row.id) : null,
    createdBy: creator, createdAt: row.created_at, updatedAt: row.updated_at, lastUsedAt: row.last_used_at, canManage: manage,
    templateId: row.template_id ?? null,
    // the app's ID and addresses are for whoever manages the connection (a template's app is the admin's)
    oauthClient: manage && !row.template_id ? clientView(row.oauth_client, row.oauth_client_enc) : null,
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
/** an own app's client secret: bound to its connection, or to its template */
export const clientAad = (r: Pick<Row, 'id' | 'scope' | 'owner_user_id'>) => `${connectionAad(r)}:client`
export const templateClientAad = (id: string) => `template:${id}:client`

// ---------------- an admin's request to connect a service as one's own (requests.ts, migration 331) ----------------
export interface RequestRow {
  id: string; user_id: string; created_by: string | null
  kind: 'mcp' | 'http'; name: string; url: string; auth: 'bearer' | 'header' | 'oauth'; auth_header: string | null; notes: string | null
  /** a pending one past expires_at is expired */
  state: 'pending' | 'completed' | 'declined' | 'withdrawn'
  /** the member's connection made from it (with a sign-in: made before the sign-in finishes) */
  integration_id: string | null
  created_at: string; expires_at: string; ended_at: string | null
}
export const REQUEST_COLUMNS = 'id, user_id, created_by, kind, name, url, auth, auth_header, notes, state, integration_id, created_at, expires_at, ended_at'
export function getRequest(db: Database, id: string): RequestRow | null {
  return db.query(`SELECT ${REQUEST_COLUMNS} FROM integration_requests WHERE id = ?`).get(id) as RequestRow | null
}
/** What the admin audit says about a request: whom it asks and what the admin filled in (their own words; a request
 * never holds a key). */
export const requestAuditDetail = (r: RequestRow) => ({ user: r.user_id, kind: r.kind, name: r.name, host: new URL(r.url).host, auth: r.auth })

/** A sign-in finished at a member's own connection (service.ts callback): the request it was made from, if one still
 * waits for this member with the same address, is connected now. */
export function requestSignedIn(db: Database, row: Pick<Row, 'id' | 'scope' | 'owner_user_id' | 'url' | 'auth'>, userId: string, at: string): void {
  if (row.scope !== 'personal' || row.owner_user_id !== userId || row.auth !== 'oauth') return
  const r = db.query(`SELECT ${REQUEST_COLUMNS} FROM integration_requests WHERE integration_id = ? AND user_id = ? AND url = ? AND state = 'pending' AND expires_at > ?`)
    .get(row.id, userId, row.url, at) as RequestRow | null
  if (!r) return
  if (!db.query("UPDATE integration_requests SET state = 'completed', ended_at = ? WHERE id = ? AND state = 'pending'").run(at, r.id).changes) return
  audit(db, { actor: userId, action: 'integration_request.complete', target: r.id, detail: requestAuditDetail(r) })
}
